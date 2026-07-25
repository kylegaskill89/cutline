"""Quick Video Modifier — modern edition.

Trim videos on a visual timeline with an embedded video player (audio
included), reduce file size (H.264/H.265), and optionally mix all audio
tracks into one loudness-normalized track with per-track volume offsets.

Requirements:
    pip install customtkinter pillow python-vlc
    ffmpeg on PATH
    VLC media player installed (64-bit VLC for 64-bit Python) — powers the
    embedded player. Without it the app still works, falling back to
    frame-by-frame scrubbing plus an ffplay preview window.
"""

import io
import os
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox


# ---------------------------------------------------------------------------
# Bundled-tool resolution (lets a packaged copy run with zero installs)
# ---------------------------------------------------------------------------
def get_app_dir():
    """Folder containing the app: the exe's folder when frozen by PyInstaller,
    otherwise the folder containing this script."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


APP_DIR = get_app_dir()


def resolve_tool(name):
    """Prefers a bundled copy in APP_DIR/bin, falling back to system PATH."""
    exe = f"{name}.exe" if os.name == "nt" else name
    bundled = os.path.join(APP_DIR, "bin", exe)
    return bundled if os.path.exists(bundled) else name


FFMPEG = resolve_tool("ffmpeg")
FFPLAY = resolve_tool("ffplay")

# Point python-vlc at a bundled VLC runtime if one sits next to the app
# (a "vlc" folder containing libvlc.dll, libvlccore.dll, and plugins/).
# Must happen BEFORE `import vlc` below.
_bundled_vlc = os.path.join(APP_DIR, "vlc")
if os.name == "nt" and os.path.isdir(_bundled_vlc):
    os.environ.setdefault(
        "PYTHON_VLC_LIB_PATH", os.path.join(_bundled_vlc, "libvlc.dll")
    )
    os.environ.setdefault(
        "VLC_PLUGIN_PATH", os.path.join(_bundled_vlc, "plugins")
    )
    try:
        os.add_dll_directory(_bundled_vlc)
    except Exception:
        pass

try:
    import customtkinter as ctk
    from PIL import Image, ImageTk
except ImportError:
    _r = tk.Tk()
    _r.withdraw()
    messagebox.showerror(
        "Missing Dependencies",
        "This app needs customtkinter and pillow.\n\n"
        "Install them with:\n    pip install customtkinter pillow",
    )
    raise SystemExit(1)

# Embedded playback is optional: if python-vlc or the VLC app itself is
# missing, the app falls back to frame scrubbing + ffplay previews.
VLC_AVAILABLE = False
try:
    import vlc  # noqa: F401

    _probe_instance = vlc.Instance("--quiet")
    if _probe_instance is not None:
        _probe_instance.release()
        VLC_AVAILABLE = True
except Exception:
    pass


# ---------------------------------------------------------------------------
# Layout constants
# ---------------------------------------------------------------------------
PREVIEW_W, PREVIEW_H = 512, 288          # preview pane (16:9)
TIMELINE_W, TIMELINE_H = 512, 64         # filmstrip canvas
THUMB_COUNT = 8
THUMB_W = TIMELINE_W // THUMB_COUNT      # 64
THUMB_H = TIMELINE_H - 16                # leave room for handle grips
HANDLE_GRAB_PX = 8                       # pixel tolerance for grabbing a handle
MIN_TRIM_GAP = 0.05                      # seconds


# ---------------------------------------------------------------------------
# Standalone helpers
# ---------------------------------------------------------------------------
def get_readable_file_size(filepath):
    """Converts a raw file byte count into a human-readable string."""
    try:
        bytes_size = os.path.getsize(filepath)
        for unit in ["B", "KB", "MB", "GB"]:
            if bytes_size < 1024.0:
                return f"{bytes_size:.2f} {unit}"
            bytes_size /= 1024.0
        return f"{bytes_size:.2f} TB"
    except Exception:
        return "Unknown Size"


def time_to_seconds(time_str):
    """Converts HH:MM:SS.xx, MM:SS.xx or raw seconds strings into float seconds."""
    try:
        time_str = str(time_str).strip()
        if not time_str:
            return 0.0
        parts = time_str.split(":")
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        return float(time_str)
    except ValueError:
        return 0.0


def seconds_to_timestamp(seconds):
    """Formats float seconds as HH:MM:SS.ss."""
    seconds = max(0.0, float(seconds))
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:05.2f}"


def probe_video(input_file, creation_flags):
    """Probes a file with FFmpeg: duration (sec + string) and audio track count."""
    duration_sec, duration_str, audio_count = 0.0, "Unknown", 0
    try:
        process = subprocess.Popen(
            [FFMPEG, "-i", input_file],
            creationflags=creation_flags,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        _, stderr = process.communicate()
        for line in stderr.split("\n"):
            if "Duration:" in line:
                duration_str = line.split("Duration:")[1].split(",")[0].strip()
                duration_sec = time_to_seconds(duration_str)
            if "Stream #" in line and "Audio:" in line:
                audio_count += 1
    except Exception:
        pass
    return duration_sec, duration_str, audio_count


def extract_frame(input_file, seconds, box_w, box_h, creation_flags, fill=False):
    """Grabs one frame at `seconds` as a PIL image, scaled to fit (or fill) a box."""
    if fill:
        vf = (
            f"scale={box_w}:{box_h}:force_original_aspect_ratio=increase,"
            f"crop={box_w}:{box_h}"
        )
    else:
        vf = f"scale={box_w}:{box_h}:force_original_aspect_ratio=decrease"
    cmd = [
        FFMPEG, "-loglevel", "error",
        "-ss", f"{max(0.0, seconds):.3f}", "-i", input_file,
        "-frames:v", "1", "-vf", vf,
        "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-",
    ]
    try:
        result = subprocess.run(
            cmd, capture_output=True, creationflags=creation_flags, timeout=15
        )
        if result.returncode == 0 and result.stdout:
            return Image.open(io.BytesIO(result.stdout))
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Main application
# ---------------------------------------------------------------------------
class VideoTrimmerApp(ctk.CTk):

    def __init__(self):
        super().__init__()
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")

        self.title("Quick Video Modifier")
        self.geometry("960x660")
        self.resizable(False, False)

        # OS specific Windows flag lookup
        self.creation_flags = 0
        if os.name == "nt":
            self.creation_flags = subprocess.CREATE_NO_WINDOW

        # --- State ---
        self.input_file = None
        self.duration = 0.0
        self.audio_streams = 0
        self.trim_start = 0.0
        self.trim_end = 0.0
        self.playhead = 0.0
        self.trim_enabled = True
        self.thumbnails = []           # ImageTk refs (must be kept alive)
        self.preview_photo = None
        self._drag_target = None
        self._pending_preview = None
        self._preview_busy = False
        self._load_generation = 0      # invalidates stale thumbnail threads
        self._syncing_entries = False
        self.track_offset_entries = []

        # Embedded player state
        self.video_placeholder = None
        self.vlc_instance = None
        self.player = None
        self._preview_stop_at = None   # auto-pause point for trim previews

        self._build_ui()
        self.after(100, self._tick)

    # ------------------------------------------------------------------ UI --
    def _build_ui(self):
        pad = {"padx": 16, "pady": 8}

        # --- Top bar: file selection ---
        top = ctk.CTkFrame(self, fg_color="transparent")
        top.pack(fill="x", **pad)

        self.file_var = tk.StringVar()
        self.file_entry = ctk.CTkEntry(
            top, textvariable=self.file_var, state="disabled",
            placeholder_text="No video loaded",
        )
        self.file_entry.pack(side="left", fill="x", expand=True, padx=(0, 10))

        ctk.CTkButton(top, text="Browse…", width=110, command=self.browse_file).pack(
            side="right"
        )

        self.meta_var = tk.StringVar(value="Duration: --  |  Size: --  |  Audio Tracks: --")
        ctk.CTkLabel(
            self, textvariable=self.meta_var, text_color="#9aa4b0",
            font=ctk.CTkFont(size=12),
        ).pack(anchor="w", padx=18)

        # --- Main content: video column + settings column ---
        content = ctk.CTkFrame(self, fg_color="transparent")
        content.pack(fill="both", expand=True, padx=16, pady=(4, 12))

        self._build_video_column(content)
        self._build_settings_column(content)

    def _build_video_column(self, parent):
        col = ctk.CTkFrame(parent, corner_radius=12)
        col.pack(side="left", fill="y", padx=(0, 12))

        # Video surface: an embedded VLC player when available, otherwise a
        # canvas that shows extracted frames while scrubbing.
        if VLC_AVAILABLE:
            self.video_frame = tk.Frame(
                col, width=PREVIEW_W, height=PREVIEW_H,
                bg="#0b0d10", highlightthickness=0,
            )
            self.video_frame.pack(padx=14, pady=(14, 8))
            self.video_frame.pack_propagate(False)
            self.video_placeholder = tk.Label(
                self.video_frame, text="Open a video to begin",
                bg="#0b0d10", fg="#4a5568", font=("Arial", 14),
            )
            self.video_placeholder.place(relx=0.5, rely=0.5, anchor="center")
        else:
            self.preview_canvas = tk.Canvas(
                col, width=PREVIEW_W, height=PREVIEW_H,
                bg="#0b0d10", highlightthickness=0,
            )
            self.preview_canvas.pack(padx=14, pady=(14, 8))
            self.preview_canvas.create_text(
                PREVIEW_W / 2, PREVIEW_H / 2,
                text="Open a video to begin\n(install VLC + python-vlc for in-app playback)",
                fill="#4a5568", font=("Arial", 12), justify="center",
                tags="placeholder",
            )

        # Transport row: play/pause + current time + volume
        controls = ctk.CTkFrame(col, fg_color="transparent")
        controls.pack(fill="x", padx=14)

        self.playhead_var = tk.StringVar(value="00:00:00.00")
        if VLC_AVAILABLE:
            self.play_btn = ctk.CTkButton(
                controls, text="▶", width=44,
                fg_color="#3b4252", hover_color="#4c566a",
                command=self.toggle_play,
            )
            self.play_btn.pack(side="left")
        ctk.CTkLabel(
            controls, textvariable=self.playhead_var,
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(side="left", expand=True)
        if VLC_AVAILABLE:
            ctk.CTkLabel(controls, text="🔊").pack(side="left", padx=(0, 4))
            self.volume_slider = ctk.CTkSlider(
                controls, from_=0, to=100, width=110, command=self._on_volume
            )
            self.volume_slider.set(80)
            self.volume_slider.pack(side="right")

        # Filmstrip timeline
        self.timeline = tk.Canvas(
            col, width=TIMELINE_W, height=TIMELINE_H,
            bg="#14171c", highlightthickness=0, cursor="hand2",
        )
        self.timeline.pack(padx=14, pady=(4, 8))
        self.timeline.bind("<ButtonPress-1>", self._on_timeline_press)
        self.timeline.bind("<B1-Motion>", self._on_timeline_drag)
        self.timeline.bind("<ButtonRelease-1>", self._on_timeline_release)

        # Trim time entries + audio preview
        row = ctk.CTkFrame(col, fg_color="transparent")
        row.pack(fill="x", padx=14, pady=(0, 14))

        ctk.CTkLabel(row, text="Start", text_color="#2ecc71").pack(side="left")
        self.start_var = tk.StringVar(value="00:00:00.00")
        self.start_entry = ctk.CTkEntry(row, textvariable=self.start_var, width=100)
        self.start_entry.pack(side="left", padx=(6, 14))

        ctk.CTkLabel(row, text="End", text_color="#e74c3c").pack(side="left")
        self.end_var = tk.StringVar(value="00:00:00.00")
        self.end_entry = ctk.CTkEntry(row, textvariable=self.end_var, width=100)
        self.end_entry.pack(side="left", padx=(6, 14))

        for entry in (self.start_entry, self.end_entry):
            entry.bind("<Return>", self._on_entry_commit)
            entry.bind("<FocusOut>", self._on_entry_commit)

        self.preview_btn = ctk.CTkButton(
            row, text="▶ Preview Trim", width=120,
            fg_color="#3b4252", hover_color="#4c566a",
            command=self.preview_trim,
        )
        self.preview_btn.pack(side="right")

    def _build_settings_column(self, parent):
        col = ctk.CTkFrame(parent, corner_radius=12, width=380)
        col.pack(side="left", fill="both", expand=True)
        col.pack_propagate(False)

        inner = {"padx": 16, "anchor": "w"}

        ctk.CTkLabel(
            col, text="Operation", font=ctk.CTkFont(size=13, weight="bold")
        ).pack(pady=(14, 4), **inner)

        self.mode_seg = ctk.CTkSegmentedButton(
            col, values=["Trim", "Reduce", "Trim + Reduce"],
            command=self._on_mode_change,
        )
        self.mode_seg.set("Trim")
        self.mode_seg.pack(fill="x", padx=16)

        ctk.CTkLabel(
            col, text="Compression Level", font=ctk.CTkFont(size=13, weight="bold")
        ).pack(pady=(14, 4), **inner)

        self.compression_menu = ctk.CTkOptionMenu(
            col,
            values=[
                "Standard - H.264, CRF 22 (most compatible)",
                "High - H.265, CRF 26 (smaller files)",
                "Maximum - H.265, CRF 28 (smallest files)",
            ],
        )
        self.compression_menu.set("High - H.265, CRF 26 (smaller files)")
        self.compression_menu.configure(state="disabled")  # default mode is Trim
        self.compression_menu.pack(fill="x", padx=16)

        self.mixdown_var = tk.BooleanVar(value=False)
        ctk.CTkSwitch(
            col, text="Mix all audio tracks into one (loudness normalized)",
            variable=self.mixdown_var,
        ).pack(pady=(16, 4), **inner)

        # Per-track dB offsets (populated on file load)
        self.offsets_frame = ctk.CTkFrame(col, fg_color="#20242b", corner_radius=8)
        self.offsets_frame.pack(fill="x", padx=16, pady=(4, 0))
        self._offsets_placeholder()

        ctk.CTkLabel(
            col, text="Custom Output Name (Optional)",
            font=ctk.CTkFont(size=13, weight="bold"),
        ).pack(pady=(14, 4), **inner)

        self.output_var = tk.StringVar()
        ctk.CTkEntry(
            col, textvariable=self.output_var, placeholder_text="MyVideo.Modified"
        ).pack(fill="x", padx=16)

        self.process_btn = ctk.CTkButton(
            col, text="Process Video", height=40,
            font=ctk.CTkFont(size=14, weight="bold"),
            fg_color="#2ecc71", hover_color="#27ae60", text_color="#0b0d10",
            command=self.start_processing_thread,
        )
        self.process_btn.pack(fill="x", padx=16, pady=(18, 8))

        prog_row = ctk.CTkFrame(col, fg_color="transparent")
        prog_row.pack(fill="x", padx=16)
        self.progress_bar = ctk.CTkProgressBar(prog_row)
        self.progress_bar.set(0)
        self.progress_bar.pack(side="left", fill="x", expand=True, padx=(0, 10))
        self.progress_label_var = tk.StringVar(value="0.0%")
        ctk.CTkLabel(prog_row, textvariable=self.progress_label_var, width=52).pack(
            side="right"
        )

        self.status_var = tk.StringVar(value="Ready.")
        ctk.CTkLabel(
            col, textvariable=self.status_var, text_color="#9aa4b0",
            font=ctk.CTkFont(size=12, slant="italic"), wraplength=340,
            justify="left",
        ).pack(pady=(8, 12), **inner)

    def _offsets_placeholder(self, text="Load a video to see its audio tracks."):
        for w in self.offsets_frame.winfo_children():
            w.destroy()
        self.track_offset_entries = []
        ctk.CTkLabel(
            self.offsets_frame, text=text, text_color="#9aa4b0",
            font=ctk.CTkFont(size=12),
        ).pack(padx=10, pady=8, anchor="w")

    def rebuild_track_offsets(self):
        """Rebuilds the per-track dB offset entries to match the loaded file."""
        for w in self.offsets_frame.winfo_children():
            w.destroy()
        self.track_offset_entries = []

        if self.audio_streams == 0:
            self._offsets_placeholder("No audio tracks detected.")
            return

        ctk.CTkLabel(
            self.offsets_frame,
            text="Track volume offsets in dB (mixdown only, 0 = full volume)",
            text_color="#9aa4b0", font=ctk.CTkFont(size=12),
        ).pack(padx=10, pady=(8, 2), anchor="w")

        row = ctk.CTkFrame(self.offsets_frame, fg_color="transparent")
        row.pack(padx=10, pady=(0, 8), anchor="w")
        for i in range(self.audio_streams):
            ctk.CTkLabel(row, text=f"T{i + 1}:").pack(side="left", padx=(0 if i == 0 else 12, 4))
            entry = ctk.CTkEntry(row, width=48)
            entry.insert(0, "0")
            entry.pack(side="left")
            self.track_offset_entries.append(entry)

    def get_track_offset(self, index):
        """Safely reads a track's dB offset, defaulting to 0 on bad input."""
        try:
            return float(self.track_offset_entries[index].get())
        except Exception:
            return 0.0

    # -------------------------------------------------------- file loading --
    def browse_file(self):
        file_selected = filedialog.askopenfilename(
            filetypes=[("Video Files", "*.mp4 *.mkv *.avi *.mov"), ("All Files", "*.*")]
        )
        if file_selected:
            self.load_file(file_selected)

    def load_file(self, path):
        self.input_file = path
        self.file_var.set(path)
        self.status_var.set("Analyzing video file properties…")
        self.update_progress(0.0)

        self.duration, duration_string, self.audio_streams = probe_video(
            path, self.creation_flags
        )
        readable_size = get_readable_file_size(path)
        self.meta_var.set(
            f"Duration: {duration_string}  |  Size: {readable_size}"
            f"  |  Audio Tracks: {self.audio_streams}"
        )

        self.trim_start = 0.0
        self.trim_end = self.duration
        self.playhead = 0.0
        self._sync_entries_from_state()
        self.rebuild_track_offsets()

        # Kick off thumbnail extraction in the background
        self.thumbnails = [None] * THUMB_COUNT
        self._load_generation += 1
        threading.Thread(
            target=self._thumbnail_worker, args=(self._load_generation,), daemon=True
        ).start()

        if VLC_AVAILABLE:
            self._ensure_player()
            self._preview_stop_at = None
            if self.video_placeholder is not None:
                self.video_placeholder.destroy()
                self.video_placeholder = None
            self.player.stop()
            self.player.set_media(self.vlc_instance.media_new(path))
            # Play briefly so the first frame renders, then hold paused at 0.
            self.player.play()
            self.after(300, self._pause_at_start)
        else:
            self.request_preview(0.0)
        self._draw_timeline()
        self.status_var.set("File properties loaded.")

    # ------------------------------------------------------ embedded player --
    def _ensure_player(self):
        """Creates the libVLC player and binds it to the video surface once."""
        if not VLC_AVAILABLE or self.player is not None:
            return
        self.vlc_instance = vlc.Instance("--quiet")
        self.player = self.vlc_instance.media_player_new()
        self.update_idletasks()
        wid = self.video_frame.winfo_id()
        if os.name == "nt":
            self.player.set_hwnd(wid)
        elif sys.platform == "darwin":
            self.player.set_nsobject(wid)
        else:
            self.player.set_xwindow(wid)
        self.player.audio_set_volume(int(self.volume_slider.get()))

    def _pause_at_start(self):
        if self.player is not None:
            self.player.set_pause(1)
            self.player.set_time(0)
            self.playhead = 0.0
            self.playhead_var.set(seconds_to_timestamp(0.0))

    def toggle_play(self):
        if not self.input_file or self.player is None:
            return
        if self.player.is_playing():
            self.player.set_pause(1)
        else:
            self._preview_stop_at = None  # manual play cancels trim auto-stop
            if self.player.get_state() == vlc.State.Ended:
                self.player.stop()
            self.player.play()

    def _on_volume(self, value):
        if self.player is not None:
            self.player.audio_set_volume(int(value))

    def _tick(self):
        """10 Hz UI heartbeat: follows playback on the timeline and handles
        the auto-pause point for trim previews."""
        if VLC_AVAILABLE and self.player is not None and self.input_file:
            playing = bool(self.player.is_playing())
            if playing:
                t = max(0.0, self.player.get_time() / 1000.0)
                self.playhead = t
                self.playhead_var.set(seconds_to_timestamp(t))
                self._draw_timeline()
                if self._preview_stop_at is not None and t >= self._preview_stop_at:
                    self.player.set_pause(1)
                    self._preview_stop_at = None
                    self.status_var.set("Trim preview finished.")
            self.play_btn.configure(text="⏸" if playing else "▶")
        self.after(100, self._tick)

    def _show_time(self, t):
        """Displays the frame at time t: seeks the embedded player, or falls
        back to ffmpeg frame extraction when VLC isn't available."""
        if VLC_AVAILABLE and self.player is not None:
            self.player.set_time(int(t * 1000))
        else:
            self.request_preview(t)

    def _thumbnail_worker(self, generation):
        for i in range(THUMB_COUNT):
            if generation != self._load_generation:
                return  # a newer file was loaded; abandon this batch
            t = (i + 0.5) / THUMB_COUNT * max(self.duration, 0.001)
            img = extract_frame(
                self.input_file, t, THUMB_W, THUMB_H, self.creation_flags, fill=True
            )
            if img is not None and generation == self._load_generation:
                self.after(0, self._apply_thumbnail, i, img, generation)

    def _apply_thumbnail(self, index, img, generation):
        if generation != self._load_generation:
            return
        self.thumbnails[index] = ImageTk.PhotoImage(img)
        self._draw_timeline()

    # ------------------------------------------------------ preview frames --
    def request_preview(self, t):
        """Debounced frame extraction: only one worker runs; it always renders
        the most recently requested time and drops intermediate ones."""
        if not self.input_file:
            return
        self._pending_preview = t
        if not self._preview_busy:
            self._preview_busy = True
            threading.Thread(target=self._preview_worker, daemon=True).start()

    def _preview_worker(self):
        try:
            while True:
                t = self._pending_preview
                img = extract_frame(
                    self.input_file, t, PREVIEW_W, PREVIEW_H, self.creation_flags
                )
                if img is not None:
                    self.after(0, self._apply_preview, img)
                if self._pending_preview == t:
                    break  # nothing newer was requested while we worked
        finally:
            self._preview_busy = False

    def _apply_preview(self, img):
        self.preview_photo = ImageTk.PhotoImage(img)
        self.preview_canvas.delete("all")
        self.preview_canvas.create_image(
            PREVIEW_W / 2, PREVIEW_H / 2, image=self.preview_photo
        )

    # ------------------------------------------------------------ timeline --
    def _x_to_time(self, x):
        x = min(max(x, 0), TIMELINE_W)
        return (x / TIMELINE_W) * self.duration

    def _time_to_x(self, t):
        if self.duration <= 0:
            return 0
        return (t / self.duration) * TIMELINE_W

    def _draw_timeline(self):
        c = self.timeline
        c.delete("all")
        if not self.input_file:
            c.create_text(
                TIMELINE_W / 2, TIMELINE_H / 2, text="Timeline",
                fill="#4a5568", font=("Arial", 11),
            )
            return

        strip_y = (TIMELINE_H - THUMB_H) / 2
        for i, photo in enumerate(self.thumbnails):
            x = i * THUMB_W
            if photo is not None:
                c.create_image(x, strip_y, image=photo, anchor="nw")
            else:
                c.create_rectangle(
                    x, strip_y, x + THUMB_W, strip_y + THUMB_H,
                    fill="#1d2129", outline="#14171c",
                )

        sx = self._time_to_x(self.trim_start)
        ex = self._time_to_x(self.trim_end)

        # Dim the regions outside the trim selection
        dim = {"fill": "#000000", "stipple": "gray50", "outline": ""}
        if sx > 0:
            c.create_rectangle(0, 0, sx, TIMELINE_H, **dim)
        if ex < TIMELINE_W:
            c.create_rectangle(ex, 0, TIMELINE_W, TIMELINE_H, **dim)

        # Selection border + handles
        handle_colors = ("#2ecc71", "#e74c3c") if self.trim_enabled else ("#4a5568", "#4a5568")
        c.create_rectangle(sx, 0, ex, TIMELINE_H, outline="#d8dee9", width=1)
        for x, color in ((sx, handle_colors[0]), (ex, handle_colors[1])):
            c.create_rectangle(x - 3, 0, x + 3, TIMELINE_H, fill=color, outline="")
            c.create_rectangle(x - 5, TIMELINE_H / 2 - 7, x + 5, TIMELINE_H / 2 + 7,
                               fill=color, outline="")

        # Playhead
        px = self._time_to_x(self.playhead)
        c.create_line(px, 0, px, TIMELINE_H, fill="#ffffff", width=1)
        c.create_polygon(px - 5, 0, px + 5, 0, px, 7, fill="#ffffff", outline="")

    def _on_timeline_press(self, event):
        if not self.input_file:
            return
        sx = self._time_to_x(self.trim_start)
        ex = self._time_to_x(self.trim_end)
        if self.trim_enabled and abs(event.x - sx) <= HANDLE_GRAB_PX:
            self._drag_target = "start"
        elif self.trim_enabled and abs(event.x - ex) <= HANDLE_GRAB_PX:
            self._drag_target = "end"
        else:
            self._drag_target = "playhead"
        # Scrubbing/trimming takes over the transport: pause playback first
        if VLC_AVAILABLE and self.player is not None and self.player.is_playing():
            self.player.set_pause(1)
        self._preview_stop_at = None
        self._on_timeline_drag(event)

    def _on_timeline_drag(self, event):
        if not self.input_file or self._drag_target is None:
            return
        t = self._x_to_time(event.x)

        if self._drag_target == "start":
            self.trim_start = min(t, self.trim_end - MIN_TRIM_GAP)
            self.trim_start = max(0.0, self.trim_start)
            shown = self.trim_start
        elif self._drag_target == "end":
            self.trim_end = max(t, self.trim_start + MIN_TRIM_GAP)
            self.trim_end = min(self.duration, self.trim_end)
            shown = self.trim_end
        else:
            self.playhead = t
            shown = t

        self.playhead_var.set(seconds_to_timestamp(shown))
        self._sync_entries_from_state()
        self._draw_timeline()
        self._show_time(shown)

    def _on_timeline_release(self, _event):
        self._drag_target = None

    # --------------------------------------------------------- entry sync --
    def _sync_entries_from_state(self):
        self._syncing_entries = True
        self.start_var.set(seconds_to_timestamp(self.trim_start))
        self.end_var.set(seconds_to_timestamp(self.trim_end))
        self._syncing_entries = False

    def _on_entry_commit(self, _event=None):
        if self._syncing_entries or not self.input_file:
            return
        start = time_to_seconds(self.start_var.get())
        end = time_to_seconds(self.end_var.get())
        if end <= 0 or end > self.duration:
            end = self.duration
        start = min(max(0.0, start), max(0.0, end - MIN_TRIM_GAP))
        self.trim_start, self.trim_end = start, max(end, start + MIN_TRIM_GAP)
        self._sync_entries_from_state()
        self._draw_timeline()

    # ------------------------------------------------------- ffplay preview --
    def preview_trim(self):
        if not self.input_file:
            messagebox.showerror("Error", "Load a video first.")
            return
        if VLC_AVAILABLE and self.player is not None:
            # Play the selected range in the embedded player, audio included.
            if self.player.get_state() == vlc.State.Ended:
                self.player.stop()
            self.player.play()
            # Seek slightly after play so it lands regardless of prior state;
            # only then arm the auto-pause point (arming first could trigger
            # an instant pause if the old position was past the end handle).
            self.after(150, self._begin_trim_preview)
            self.status_var.set("Previewing trimmed range…")
            return
        duration = max(MIN_TRIM_GAP, self.trim_end - self.trim_start)
        cmd = [
            FFPLAY, "-hide_banner", "-loglevel", "error",
            "-window_title", "Trim Preview (close window to return)",
            "-ss", f"{self.trim_start:.3f}", "-t", f"{duration:.3f}",
            "-autoexit", self.input_file,
        ]
        try:
            subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            self.status_var.set("Playing trim preview in a separate window…")
        except FileNotFoundError:
            messagebox.showerror(
                "ffplay Not Found",
                "The audio/video preview uses ffplay, which ships with full "
                "FFmpeg builds. Install it or add it to PATH to use previews.",
            )

    def _begin_trim_preview(self):
        if self.player is not None:
            self.player.set_time(int(self.trim_start * 1000))
            self._preview_stop_at = self.trim_end

    # ------------------------------------------------------------ modes ----
    def _mode_choice(self):
        return {"Trim": "1", "Reduce": "2", "Trim + Reduce": "3"}[self.mode_seg.get()]

    def _on_mode_change(self, _value=None):
        choice = self._mode_choice()
        self.trim_enabled = choice in ("1", "3")
        entry_state = "normal" if self.trim_enabled else "disabled"
        self.start_entry.configure(state=entry_state)
        self.end_entry.configure(state=entry_state)
        self.compression_menu.configure(
            state="disabled" if choice == "1" else "normal"
        )
        if choice == "2":
            self.status_var.set("Trim disabled for size-reduction mode; full video is used.")
        else:
            self.status_var.set("Ready.")
        self._draw_timeline()

    # -------------------------------------------------------- processing ---
    def update_progress(self, pct):
        self.progress_bar.set(pct / 100.0)
        self.progress_label_var.set(f"{pct:.1f}%")

    def start_processing_thread(self):
        if not self.input_file or not os.path.exists(self.input_file):
            messagebox.showerror("Error", "Please select a valid input video file first.")
            return

        if VLC_AVAILABLE and self.player is not None:
            self.player.set_pause(1)
        self.process_btn.configure(state="disabled", text="Processing…")
        self.update_progress(0.0)
        threading.Thread(target=self.process_video, daemon=True).start()

    def process_video(self):
        input_file = self.input_file
        input_path, input_name = os.path.split(input_file)
        file_name, _ = os.path.splitext(input_name)

        out_base = self.output_var.get().strip()
        if not out_base:
            out_base = f"{file_name}.Modified"
        output_file = os.path.join(input_path, f"{out_base}.mp4")

        if os.path.exists(output_file):
            if not messagebox.askyesno(
                "Warning", f"'{out_base}.mp4' already exists. Overwrite?"
            ):
                self.reset_ui_button()
                return

        choice = self._mode_choice()
        trimming = choice in ("1", "3")

        start_sec = self.trim_start if trimming else 0.0
        end_sec = self.trim_end if trimming else self.duration
        output_duration = end_sec - start_sec
        if output_duration <= 0:
            output_duration = self.duration

        # Build FFmpeg command
        cmd = [FFMPEG]
        if trimming:
            if start_sec > MIN_TRIM_GAP:
                cmd.extend(["-ss", f"{start_sec:.3f}"])
            if end_sec < self.duration - MIN_TRIM_GAP:
                cmd.extend(["-to", f"{end_sec:.3f}"])

        cmd.extend(["-i", input_file])

        # --- Audio routing ---
        # Mixdown combines every audio track into one loudness-normalized track.
        # Filtered audio can't be stream-copied, so mixdown forces an audio
        # re-encode even in trim-only mode (video is still stream-copied there).
        n_audio = self.audio_streams
        mixdown = self.mixdown_var.get() and n_audio >= 1

        if mixdown and n_audio > 1:
            # Each track is individually loudness-normalized to -16 LUFS FIRST,
            # so a quiet mic and loud gameplay arrive at equal loudness. The
            # per-track dB offsets are applied on top of that equal footing,
            # so "-6" reliably means "6 dB under the tracks left at 0" no
            # matter how the tracks were originally recorded. The mix is then
            # capped with a plain limiter rather than another loudnorm — a
            # dynamic normalizer on the final mix would push quiet passages
            # (e.g., gameplay-only stretches) back up, defeating the offsets.
            chains = []
            pads = []
            for i in range(n_audio):
                offset = self.get_track_offset(i)
                chains.append(
                    f"[0:a:{i}]aresample=48000,aformat=channel_layouts=stereo,"
                    f"loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,"
                    f"volume={offset}dB[m{i}]"
                )
                pads.append(f"[m{i}]")
            audio_graph = (
                ";".join(chains)
                + ";"
                + "".join(pads)
                + f"amix=inputs={n_audio}:duration=longest:normalize=0,"
                + "alimiter=limit=0.891:level=false[aout]"
            )
            cmd.extend(
                ["-filter_complex", audio_graph, "-map", "0:v:0", "-map", "[aout]"]
            )
        elif mixdown:
            # Only one audio track exists: nothing to mix, just normalize it
            # (its offset still applies, with a limiter guarding positive gain).
            offset = self.get_track_offset(0)
            cmd.extend(
                ["-map", "0:v:0", "-map", "0:a:0",
                 "-af",
                 f"loudnorm=I=-16:TP=-1.5:LRA=11,volume={offset}dB,"
                 f"alimiter=limit=0.891:level=false"]
            )
        else:
            # Keep the primary video stream and EVERY audio track separately.
            # The '?' makes the audio map optional so silent files don't error.
            cmd.extend(["-map", "0:v:0", "-map", "0:a?"])

        # --- Video codec ---
        if choice == "1":
            cmd.extend(["-c:v", "copy"])
        else:
            level = self.compression_menu.get()
            if level.startswith("Standard"):
                cmd.extend(["-c:v", "libx264", "-preset", "faster", "-crf", "22"])
            elif level.startswith("Maximum"):
                cmd.extend(
                    ["-c:v", "libx265", "-preset", "medium", "-crf", "28",
                     "-tag:v", "hvc1"]
                )
            else:  # High (default)
                cmd.extend(
                    ["-c:v", "libx265", "-preset", "medium", "-crf", "26",
                     "-tag:v", "hvc1"]
                )

        # --- Audio codec ---
        if mixdown:
            # loudnorm internally upsamples to 192kHz; pin output back to 48kHz.
            cmd.extend(["-c:a", "aac", "-b:a", "192k", "-ar", "48000"])
        elif choice == "1":
            cmd.extend(["-c:a", "copy"])
        else:
            # Re-encode every audio track to AAC. This guarantees all tracks fit
            # in the .mp4 container regardless of source codec. Change "aac" to
            # "copy" (and drop -b:a) to keep original audio untouched instead.
            cmd.extend(["-c:a", "aac", "-b:a", "160k"])

        # -y must come BEFORE the output file; trailing options are ignored by
        # FFmpeg, which would cause a hidden overwrite prompt to hang forever.
        cmd.extend(["-y", output_file])
        self.after(0, self.status_var.set, "FFmpeg is executing… processing frames…")

        try:
            process = subprocess.Popen(
                cmd,
                creationflags=self.creation_flags,
                stderr=subprocess.PIPE,
                text=True,
            )

            for line in process.stderr:
                if "time=" in line:
                    try:
                        time_part = line.split("time=")[1].split()[0].strip()
                        current_sec = time_to_seconds(time_part)
                        if output_duration > 0:
                            pct = (current_sec / output_duration) * 100
                            pct = min(100.0, max(0.0, pct))
                            self.after(0, self.update_progress, pct)
                    except Exception:
                        pass

            returncode = process.wait()

            if returncode == 0:
                self.after(0, self.update_progress, 100.0)

                original_size_str = get_readable_file_size(input_file)
                final_size_str = get_readable_file_size(output_file)

                if choice in ("2", "3"):
                    success_msg = (
                        f"Task completed successfully!\n\n"
                        f"Original Size: {original_size_str}\n"
                        f"Reduced Size: {final_size_str}\n\n"
                        f"Saved to: {output_file}"
                    )
                else:
                    success_msg = (
                        f"Task completed successfully!\n\n"
                        f"Output Size: {final_size_str}\n\n"
                        f"Saved to: {output_file}"
                    )

                messagebox.showinfo("Success", success_msg)
                self.after(0, self.status_var.set, "Last operation completed successfully.")
            else:
                messagebox.showerror(
                    "FFmpeg Error",
                    "An encoding issue occurred. Please check your trim points.",
                )
                self.after(0, self.status_var.set, "FFmpeg execution failed.")

        except Exception as e:
            messagebox.showerror("Error", f"Failed to execute FFmpeg: {e}")
            self.after(0, self.status_var.set, "An exception occurred.")

        self.reset_ui_button()

    def reset_ui_button(self):
        self.after(
            0, lambda: self.process_btn.configure(state="normal", text="Process Video")
        )


if __name__ == "__main__":
    app = VideoTrimmerApp()
    app.mainloop()
