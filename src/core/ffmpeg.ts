/**
 * FFmpeg command construction — ported from TrimVideoGUI.py (process_video).
 *
 * This is the crown-jewel logic of the app: trim points, the three
 * compression presets, and the per-track loudnorm -> offset -> amix -> limiter
 * mixdown chain. It is a *pure* function of its input state and returns the
 * FFmpeg argument list (everything after the ffmpeg binary itself), so it can
 * be unit-tested for exact parity against the original Python without touching
 * any UI, files, or subprocess.
 *
 * Parity note: the original had no per-track keep/drop selection (it kept every
 * track, or mixed every track). That behaviour is preserved exactly when
 * `keptTracks` is omitted. Passing an explicit subset activates the new
 * selection feature and only then diverges from the Python output.
 */

/** Minimum gap between trim handles, in seconds (Python: MIN_TRIM_GAP). */
export const MIN_TRIM_GAP = 0.05;

export type Mode = "trim" | "reduce" | "trim+reduce";
export type Compression = "standard" | "high" | "maximum";

export interface BuildState {
  /** Absolute path to the source video. */
  inputFile: string;
  /** Absolute path to the destination .mp4. */
  outputFile: string;
  mode: Mode;
  /** Trim selection, seconds. Ignored when mode is "reduce". */
  trimStart: number;
  trimEnd: number;
  /** Full source duration, seconds (from ffprobe). */
  duration: number;
  /** Total number of audio tracks in the source. */
  audioStreams: number;
  /** Mix all *kept* audio tracks into one loudness-normalized track. */
  mixdown: boolean;
  /** Per-track dB offsets, indexed by source track. Missing -> 0 dB. */
  trackOffsets: number[];
  compression: Compression;
  /**
   * Source track indices to keep, in output order. Omit to keep every track
   * (original Python behaviour). An explicit list drives -map / amix inputs.
   */
  keptTracks?: number[];
}

/** Formats seconds like Python's `f"{x:.3f}"`. */
function sec3(x: number): string {
  return x.toFixed(3);
}

/**
 * Formats a dB offset the way Python's f-string renders a float, so that an
 * integer value keeps its trailing ".0" (e.g. 0 -> "0.0", -6 -> "-6.0",
 * 3.5 -> "3.5"). This keeps the generated filtergraph byte-identical to the
 * original for the realistic input domain (integers or short decimals).
 */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

function offsetOf(state: BuildState, index: number): number {
  const v = state.trackOffsets[index];
  return typeof v === "number" && Number.isFinite(v) ? v : 0.0;
}

/**
 * Builds the FFmpeg argument list (excluding the leading ffmpeg binary).
 * Mirrors TrimVideoGUI.py process_video exactly when `keptTracks` is omitted.
 */
export function buildFfmpegArgs(state: BuildState): string[] {
  const trimming = state.mode === "trim" || state.mode === "trim+reduce";
  const startSec = trimming ? state.trimStart : 0.0;
  const endSec = trimming ? state.trimEnd : state.duration;

  const cmd: string[] = [];

  // --- Trim window ---
  if (trimming) {
    if (startSec > MIN_TRIM_GAP) cmd.push("-ss", sec3(startSec));
    if (endSec < state.duration - MIN_TRIM_GAP) cmd.push("-to", sec3(endSec));
  }

  cmd.push("-i", state.inputFile);

  // --- Which tracks survive to the output ---
  // Omitted keptTracks => every track (parity). Explicit list => that subset.
  const allTracks = Array.from({ length: state.audioStreams }, (_, i) => i);
  const kept =
    state.keptTracks === undefined ? allTracks : state.keptTracks.slice();
  const keepingAll =
    state.keptTracks === undefined || kept.length === state.audioStreams;

  const nKept = kept.length;
  const mixdown = state.mixdown && nKept >= 1;

  // --- Audio routing ---
  if (mixdown && nKept > 1) {
    // Each kept track is loudness-normalized to -16 LUFS first (so a quiet mic
    // and loud gameplay arrive equal), then its dB offset is applied on that
    // equal footing, then all are mixed and capped with a plain limiter.
    const chains: string[] = [];
    const pads: string[] = [];
    kept.forEach((track, slot) => {
      const offset = offsetOf(state, track);
      chains.push(
        `[0:a:${track}]aresample=48000,aformat=channel_layouts=stereo,` +
          `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,` +
          `volume=${pyFloat(offset)}dB[m${slot}]`,
      );
      pads.push(`[m${slot}]`);
    });
    const audioGraph =
      chains.join(";") +
      ";" +
      pads.join("") +
      `amix=inputs=${nKept}:duration=longest:normalize=0,` +
      `alimiter=limit=0.891:level=false[aout]`;
    cmd.push("-filter_complex", audioGraph, "-map", "0:v:0", "-map", "[aout]");
  } else if (mixdown) {
    // A single kept track: nothing to mix, just normalize it (offset applies,
    // limiter guards positive gain).
    const offset = offsetOf(state, kept[0]);
    cmd.push(
      "-map",
      "0:v:0",
      "-map",
      `0:a:${kept[0]}`,
      "-af",
      `loudnorm=I=-16:TP=-1.5:LRA=11,volume=${pyFloat(offset)}dB,` +
        `alimiter=limit=0.891:level=false`,
    );
  } else if (keepingAll) {
    // Keep the primary video and EVERY audio track. '?' makes audio optional
    // so silent files don't error. (Byte-parity with the original.)
    cmd.push("-map", "0:v:0", "-map", "0:a?");
  } else {
    // New: keep an explicit subset of tracks, each mapped individually.
    cmd.push("-map", "0:v:0");
    for (const track of kept) cmd.push("-map", `0:a:${track}`);
  }

  // --- Video codec ---
  if (state.mode === "trim") {
    cmd.push("-c:v", "copy");
  } else if (state.compression === "standard") {
    cmd.push("-c:v", "libx264", "-preset", "faster", "-crf", "22");
  } else if (state.compression === "maximum") {
    cmd.push("-c:v", "libx265", "-preset", "medium", "-crf", "28", "-tag:v", "hvc1");
  } else {
    // high (default)
    cmd.push("-c:v", "libx265", "-preset", "medium", "-crf", "26", "-tag:v", "hvc1");
  }

  // --- Audio codec ---
  if (mixdown) {
    // loudnorm internally upsamples to 192kHz; pin output back to 48kHz.
    cmd.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
  } else if (state.mode === "trim") {
    cmd.push("-c:a", "copy");
  } else {
    cmd.push("-c:a", "aac", "-b:a", "160k");
  }

  cmd.push("-y", state.outputFile);
  return cmd;
}
