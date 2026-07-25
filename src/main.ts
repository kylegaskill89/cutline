import { open } from "@tauri-apps/plugin-dialog";
import { dirname, basename, join } from "@tauri-apps/api/path";
import { buildFfmpegArgs, type Mode, type Compression } from "./core/ffmpeg.ts";
import { secondsToTimestamp, timeToSeconds, readableFileSize } from "./core/format.ts";
import type { AudioTrack } from "./core/probe.ts";
import { probeFile, extractThumbnails, assetUrl, runFfmpeg } from "./tauri/sidecar.ts";
import { Timeline, MIN_TRIM_GAP } from "./ui/timeline.ts";

const THUMB_COUNT = 10;
const THUMB_W = 96;
const THUMB_H = 54;

// ------------------------------------------------------------------ els --
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const filePathEl = $<HTMLInputElement>("filePath");
const browseBtn = $<HTMLButtonElement>("browseBtn");
const metaEl = $<HTMLDivElement>("meta");
const video = $<HTMLVideoElement>("video");
const placeholder = $<HTMLDivElement>("videoPlaceholder");
const playBtn = $<HTMLButtonElement>("playBtn");
const currentTimeEl = $<HTMLSpanElement>("currentTime");
const volumeEl = $<HTMLInputElement>("volume");
const timelineCanvas = $<HTMLCanvasElement>("timeline");
const startInput = $<HTMLInputElement>("startInput");
const endInput = $<HTMLInputElement>("endInput");
const previewBtn = $<HTMLButtonElement>("previewBtn");
const modeSeg = $<HTMLDivElement>("modeSeg");
const compressionEl = $<HTMLSelectElement>("compression");
const mixdownEl = $<HTMLInputElement>("mixdown");
const tracksEl = $<HTMLDivElement>("tracks");
const outputNameEl = $<HTMLInputElement>("outputName");
const processBtn = $<HTMLButtonElement>("processBtn");
const progressFill = $<HTMLDivElement>("progressFill");
const progressLabel = $<HTMLSpanElement>("progressLabel");
const statusEl = $<HTMLDivElement>("status");

// ---------------------------------------------------------------- state --
interface State {
  inputFile: string | null;
  duration: number;
  tracks: AudioTrack[];
  trimStart: number;
  trimEnd: number;
  mode: Mode;
  compression: Compression;
  mixdown: boolean;
  keep: boolean[]; // per source-track keep flag
  offsets: number[]; // per source-track dB offset
}

const state: State = {
  inputFile: null,
  duration: 0,
  tracks: [],
  trimStart: 0,
  trimEnd: 0,
  mode: "trim",
  compression: "high",
  mixdown: false,
  keep: [],
  offsets: [],
};

let previewStopAt: number | null = null;

const trimEnabled = () => state.mode === "trim" || state.mode === "trim+reduce";

// --------------------------------------------------------------- helpers --
function setStatus(msg: string) {
  statusEl.textContent = msg;
}

function setProgress(pct: number) {
  const clamped = Math.min(100, Math.max(0, pct));
  progressFill.style.width = `${clamped}%`;
  progressLabel.textContent = `${clamped.toFixed(1)}%`;
}

function syncTrimInputs() {
  startInput.value = secondsToTimestamp(state.trimStart);
  endInput.value = secondsToTimestamp(state.trimEnd);
}

// -------------------------------------------------------------- timeline --
const timeline = new Timeline(timelineCanvas, {
  onScrub: (t) => {
    previewStopAt = null;
    video.currentTime = Math.min(Math.max(0, t), state.duration);
    if (!video.paused) video.pause();
    drawTimeline(t);
  },
  onTrimStart: (t) => {
    state.trimStart = t;
    syncTrimInputs();
    video.currentTime = t;
    drawTimeline(t);
  },
  onTrimEnd: (t) => {
    state.trimEnd = t;
    syncTrimInputs();
    video.currentTime = t;
    drawTimeline(t);
  },
  onScrubEnd: () => {},
});

function drawTimeline(playhead?: number) {
  timeline.duration = state.duration;
  timeline.trimStart = state.trimStart;
  timeline.trimEnd = state.trimEnd;
  timeline.trimEnabled = trimEnabled();
  timeline.loaded = !!state.inputFile;
  if (playhead !== undefined) timeline.playhead = playhead;
  timeline.draw();
}

// --------------------------------------------------------------- loading --
async function browse() {
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Video Files", extensions: ["mp4", "mkv", "avi", "mov"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (typeof selected === "string") await loadFile(selected);
}

async function loadFile(path: string) {
  state.inputFile = path;
  filePathEl.value = path;
  setStatus("Analyzing video file properties…");
  setProgress(0);

  const probe = await probeFile(path);
  state.duration = probe.durationSec;
  state.tracks = probe.audioTracks;
  state.keep = probe.audioTracks.map(() => true);
  state.offsets = probe.audioTracks.map(() => 0);
  state.trimStart = 0;
  state.trimEnd = probe.durationSec;

  const size = readableFileSize(probe.sizeBytes);
  metaEl.textContent =
    `Duration: ${secondsToTimestamp(probe.durationSec)}   ·   Size: ${size}` +
    `   ·   Audio Tracks: ${probe.audioTracks.length}`;

  syncTrimInputs();
  renderTracks();

  // Load into the player
  placeholder.style.display = "none";
  video.src = assetUrl(path);
  video.volume = Number(volumeEl.value) / 100;
  video.load();

  playBtn.disabled = false;
  previewBtn.disabled = false;
  processBtn.disabled = false;

  drawTimeline(0);
  setStatus("File properties loaded.");

  // Thumbnails in the background
  extractThumbnails(path, THUMB_COUNT, probe.durationSec, THUMB_W, THUMB_H)
    .then((urls) => {
      timeline.thumbs = urls.map((u) => {
        if (!u) return null;
        const img = new Image();
        img.onload = () => drawTimeline();
        img.src = u;
        return img;
      });
      drawTimeline();
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- tracks --
function renderTracks() {
  tracksEl.innerHTML = "";
  if (state.tracks.length === 0) {
    tracksEl.innerHTML = `<p class="tracks-hint">No audio tracks detected.</p>`;
    return;
  }

  const hint = document.createElement("p");
  hint.className = "tracks-hint";
  hint.textContent =
    "Check tracks to keep. dB offset applies in mixdown (0 = full volume).";
  tracksEl.appendChild(hint);

  state.tracks.forEach((track, i) => {
    const row = document.createElement("div");
    row.className = "track-row";

    const keep = document.createElement("input");
    keep.type = "checkbox";
    keep.checked = state.keep[i];
    keep.addEventListener("change", () => {
      state.keep[i] = keep.checked;
      row.classList.toggle("dropped", !keep.checked);
    });

    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = `${track.label} (${track.codec}, ${track.channels}ch)`;

    const offset = document.createElement("input");
    offset.className = "track-offset";
    offset.value = "0";
    offset.addEventListener("change", () => {
      const v = Number(offset.value);
      state.offsets[i] = Number.isFinite(v) ? v : 0;
      offset.value = String(state.offsets[i]);
    });

    const db = document.createElement("span");
    db.className = "db";
    db.textContent = "dB";

    row.append(keep, name, offset, db);
    tracksEl.appendChild(row);
  });
}

// ------------------------------------------------------------- transport --
function togglePlay() {
  if (!state.inputFile) return;
  if (video.paused) {
    previewStopAt = null;
    void video.play();
  } else {
    video.pause();
  }
}

function tick() {
  if (state.inputFile && !video.paused) {
    const t = video.currentTime;
    currentTimeEl.textContent = secondsToTimestamp(t);
    drawTimeline(t);
    if (previewStopAt !== null && t >= previewStopAt) {
      video.pause();
      previewStopAt = null;
      setStatus("Trim preview finished.");
    }
  }
  playBtn.textContent = video.paused ? "Play" : "Pause";
  requestAnimationFrame(tick);
}

function previewTrim() {
  if (!state.inputFile) return;
  previewStopAt = state.trimEnd;
  video.currentTime = state.trimStart;
  void video.play();
  setStatus("Previewing trimmed range…");
}

// ----------------------------------------------------------------- modes --
function setMode(mode: Mode) {
  state.mode = mode;
  for (const btn of modeSeg.querySelectorAll<HTMLButtonElement>(".seg")) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
  startInput.disabled = !trimEnabled();
  endInput.disabled = !trimEnabled();
  compressionEl.disabled = mode === "trim";
  setStatus(
    mode === "reduce"
      ? "Trim disabled for size-reduction mode; full video is used."
      : "Ready.",
  );
  drawTimeline();
}

// ------------------------------------------------------------ processing --
async function process() {
  if (!state.inputFile) return;

  const kept: number[] = [];
  state.keep.forEach((k, i) => {
    if (k) kept.push(i);
  });

  const dir = await dirname(state.inputFile);
  const nameWithExt = await basename(state.inputFile);
  const stem = nameWithExt.replace(/\.[^.]+$/, "");
  const custom = outputNameEl.value.trim();
  const outBase = custom || `${stem}.Modified`;
  const outputFile = await join(dir, `${outBase}.mp4`);

  const args = buildFfmpegArgs({
    inputFile: state.inputFile,
    outputFile,
    mode: state.mode,
    trimStart: state.trimStart,
    trimEnd: state.trimEnd,
    duration: state.duration,
    audioStreams: state.tracks.length,
    mixdown: state.mixdown,
    trackOffsets: state.offsets,
    compression: state.compression,
    keptTracks: kept,
  });

  const trimming = trimEnabled();
  const outputDuration = trimming
    ? Math.max(MIN_TRIM_GAP, state.trimEnd - state.trimStart)
    : state.duration;

  video.pause();
  processBtn.disabled = true;
  processBtn.textContent = "Processing…";
  setProgress(0);
  setStatus("FFmpeg is executing… processing frames…");

  const run = runFfmpeg(args, (sec) => {
    if (outputDuration > 0) setProgress((sec / outputDuration) * 100);
  });

  try {
    const code = await run.done;
    if (code === 0) {
      setProgress(100);
      setStatus(`Done. Saved to: ${outputFile}`);
    } else {
      setStatus(`FFmpeg failed (exit ${code}). Check the trim points and try again.`);
    }
  } catch (e) {
    setStatus(`Failed to run FFmpeg: ${e}`);
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = "Process Video";
  }
}

// --------------------------------------------------------------- wiring --
browseBtn.addEventListener("click", () => void browse());
playBtn.addEventListener("click", togglePlay);
previewBtn.addEventListener("click", previewTrim);
processBtn.addEventListener("click", () => void process());

volumeEl.addEventListener("input", () => {
  video.volume = Number(volumeEl.value) / 100;
});

compressionEl.addEventListener("change", () => {
  state.compression = compressionEl.value as Compression;
});

mixdownEl.addEventListener("change", () => {
  state.mixdown = mixdownEl.checked;
});

for (const btn of modeSeg.querySelectorAll<HTMLButtonElement>(".seg")) {
  btn.addEventListener("click", () => setMode(btn.dataset.mode as Mode));
}

function commitTrimInputs() {
  if (!state.inputFile) return;
  let start = timeToSeconds(startInput.value);
  let end = timeToSeconds(endInput.value);
  if (end <= 0 || end > state.duration) end = state.duration;
  start = Math.min(Math.max(0, start), Math.max(0, end - MIN_TRIM_GAP));
  state.trimStart = start;
  state.trimEnd = Math.max(end, start + MIN_TRIM_GAP);
  syncTrimInputs();
  drawTimeline();
}
startInput.addEventListener("change", commitTrimInputs);
endInput.addEventListener("change", commitTrimInputs);

video.addEventListener("loadedmetadata", () => {
  if (!state.duration || !Number.isFinite(state.duration)) {
    state.duration = video.duration;
    state.trimEnd = video.duration;
    syncTrimInputs();
  }
  drawTimeline(0);
});

drawTimeline();
requestAnimationFrame(tick);
