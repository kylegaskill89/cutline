import { open, save, message, confirm } from "@tauri-apps/plugin-dialog";
import { tempDir, join } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  emptyProject,
  addMedia,
  placeMedia,
  splitAt,
  setClipEdge,
  setClipGain,
  setGainKeyframe,
  moveGainKeyframe,
  removeGainKeyframeAt,
  setClipFade,
  setClipOpacity,
  setClipSpeed,
  clipSpeed,
  clipReversed,
  rateStretchEdge,
  slipClip,
  slideClip,
  setKeyframe,
  clearKeyframes,
  isAnimated,
  animatedTransform,
  animatedOpacity,
  animatedValue,
  type AnimProp,
  setClipTransition,
  setClipBlend,
  clipBlend,
  setClipsEnabled,
  clipEnabled,
  clipDuration,
  addMarker,
  removeMarker,
  clearMarkers,
  markerNear,
  nextMarker,
  prevMarker,
  projectMarkers,
  moveClipsLayered,
  removeClips,
  rippleDelete,
  insertMediaAt,
  overwriteMediaAt,
  type SourceRange,
  linkClips,
  unlinkClips,
  addVideoTrack,
  addAudioTrack,
  setTrackLabel,
  updateTrack,
  removeTrack,
  setClipTransform,
  clipTransform,
  clipEffects,
  addClipEffect,
  removeClipEffect,
  toggleClipEffect,
  moveClipEffect,
  appendClipEffects,
  clearClipEffects,
  setClipEffectParam,
  setClipEffectColor,
  isEffectParamAnimated,
  effectParamAt,
  setEffectKeyframe,
  clearEffectKeyframes,
  setTextSpec,
  groupMembers,
  timelineDuration,
  clipEnd,
  DEFAULT_IMAGE_DURATION,
  DEFAULT_TEXT,
  DEFAULT_MATTE_COLOR,
  setMatteColor,
  setMatteGradient,
  newId,
  type Project,
  type Media,
  type Clip,
  type Track,
  type Transform,
  type TextSpec,
  type TransitionKind,
  type BlendMode,
} from "../core/project.ts";
import { invoke } from "@tauri-apps/api/core";
import { layoutText, drawTextCentred } from "./textRender.ts";
import { secondsToTimestamp, secondsToTimecode, snapToFrame, frameDuration } from "../core/format.ts";
import {
  probeFile,
  extractWaveform,
  extractThumbnails,
  runFfmpeg,
  assetUrl,
} from "../tauri/sidecar.ts";
import { compileExport } from "../core/export.ts";
import {
  EFFECTS,
  effectDef,
  defaultParams,
  defaultColors,
  ADJUSTMENT_EFFECT_IDS,
} from "../core/effects.ts";
import { runUpdateCheck } from "../tauri/updater.ts";
import { matteFill } from "./matteRender.ts";
import { TimelineView, type Tool } from "./timelineView.ts";
import { AudioEngine } from "./audioEngine.ts";
import { Preview } from "./preview.ts";
import { ScopeView } from "./scopes.ts";
import type { ScopeMode } from "../core/scopes.ts";

const audio = new AudioEngine();

// ------------------------------------------------------------------ els --
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const importBtn = $<HTMLButtonElement>("importBtn");
const exportBtn = $<HTMLButtonElement>("exportBtn");
const maximizeBtn = $<HTMLButtonElement>("maximizeBtn");
const projInfo = $<HTMLSpanElement>("projInfo");
const mediaListEl = $<HTMLDivElement>("mediaList");
const previewCanvas = $<HTMLCanvasElement>("previewCanvas");
const videoSources = $<HTMLDivElement>("videoSources");
const playBtn = $<HTMLButtonElement>("playBtn");
const tcEl = $<HTMLSpanElement>("tc");
const volEl = $<HTMLInputElement>("vol");
const zoomFitBtn = $<HTMLButtonElement>("zoomFit");
const canvas = $<HTMLCanvasElement>("timelineCanvas");
const editorEl = $<HTMLDivElement>("editor");

// ---------------------------------------------------------------- state --
let project: Project = emptyProject(1, 2);
let playhead = 0;
let trimSnapshot: Project | null = null; // history snapshot for a trim gesture

// Output canvas (the composition/aspect the preview and export use). Adopts the
// first imported clip's resolution until the user picks one explicitly.
let canvasW = 1920;
let canvasH = 1080;
let canvasAutoAdopt = true;
// Sequence frame rate: drives the HH:MM:SS:FF timecode and frame stepping.
let projectFps = 30;
// The media-pool item selected as the source for Insert (,) / Overwrite (.).
let selectedMediaId: string | null = null;

// -------------------------------------------------------------- history --
const undoStack: Project[] = [];
const redoStack: Project[] = [];
const HISTORY_MAX = 200;

/** Snapshot the current project before a mutating edit. */
function pushHistory() {
  undoStack.push(structuredClone(project));
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(structuredClone(project));
  project = undoStack.pop()!;
  afterHistory();
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(structuredClone(project));
  project = redoStack.pop()!;
  afterHistory();
}

/** Commits a per-gesture snapshot to the undo stack if the project changed. */
function commitSnapshotIfChanged() {
  if (trimSnapshot && JSON.stringify(trimSnapshot) !== JSON.stringify(project)) {
    undoStack.push(trimSnapshot);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  trimSnapshot = null;
}

function afterHistory() {
  tl.project = project;
  preview.project = project;
  const liveIds = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  for (const id of [...tl.selected]) if (!liveIds.has(id)) tl.selected.delete(id);
  refreshMediaList();
  updateProjInfo();
  refreshSelectionUI();
  syncPreviewSelection();
  seek(playhead);
  tl.draw();
}

const tl = new TimelineView(canvas, {
  onSeek: (t) => seek(t),
  onSelectClip: (id, additive) => {
    if (id === null) tl.selected.clear();
    else {
      if (!additive) tl.selected.clear();
      tl.selected.add(id);
    }
    tl.draw();
    refreshSelectionUI();
    syncPreviewSelection();
  },
  onSelectionChanged: () => {
    refreshSelectionUI();
    syncPreviewSelection();
  },
  onSetTarget: (trackId) => setTargetTrack(trackId),
  onRazor: (time, clipId) => {
    // Cut the whole linked group at this time so video + its audio split together.
    pushHistory();
    project = splitAt(project, time, groupMembers(project, clipId));
    tl.project = project;
    tl.draw();
    updateProjInfo();
  },
  onMoveClips: (ids, dTime, dTrack, kind) => {
    pushHistory();
    project = moveClipsLayered(project, ids, dTime, dTrack, kind);
    tl.project = project;
    tl.resize(wrap.clientWidth, wrap.clientHeight); // may have added audio tracks
    tl.draw();
    updateProjInfo();
    seek(playhead);
  },
  onTrimBegin: () => {
    // Snapshot once per trim gesture (onTrimEdge fires continuously).
    trimSnapshot = structuredClone(project);
  },
  onTrimEdge: (clipId, edge, time) => {
    project = setClipEdge(project, clipId, edge, time);
    tl.project = project;
    tl.draw();
    updateProjInfo();
  },
  onTrimEnd: () => commitSnapshotIfChanged(),
  onRateStretch: (clipId, edge, time) => {
    project = rateStretchEdge(project, clipId, edge, time);
    tl.project = project;
    preview.project = project;
    tl.draw();
    updateProjInfo();
  },
  onSlip: (clipId, dSource) => {
    // Apply from the gesture-start snapshot so the drag is absolute, not cumulative.
    if (!trimSnapshot) return;
    project = slipClip(trimSnapshot, clipId, dSource);
    tl.project = project;
    preview.project = project;
    tl.draw();
    preview.render();
  },
  onSlide: (clipId, dTime) => {
    if (!trimSnapshot) return;
    project = slideClip(trimSnapshot, clipId, dTime);
    tl.project = project;
    preview.project = project;
    tl.draw();
    updateProjInfo();
  },
  onGainBegin: () => {
    trimSnapshot = structuredClone(project); // reuse the per-gesture snapshot slot
  },
  onGainDrag: (clipId, gain) => {
    project = setClipGain(project, clipId, gain);
    tl.project = project;
    tl.draw();
    audio.setClipGainLive(clipId, gain); // hear it immediately while playing
  },
  onGainEnd: () => {
    commitSnapshotIfChanged();
    if (playing) audio.start(project, playhead); // pick up automation edits
  },
  onGainKeyframe: (clipId, localT, gain) => {
    project = setGainKeyframe(project, clipId, localT, gain);
    tl.project = project;
    tl.draw();
  },
  onGainKeyframeMove: (clipId, fromT, toT, gain) => {
    project = moveGainKeyframe(project, clipId, fromT, toT, gain);
    tl.project = project;
    tl.draw();
  },
  onGainKeyframeRemove: (clipId, localT) => {
    project = removeGainKeyframeAt(project, clipId, localT);
    tl.project = project;
    tl.draw();
  },
  onFadeBegin: () => {
    trimSnapshot = structuredClone(project);
  },
  onFadeDrag: (clipId, edge, dur) => {
    project = setClipFade(project, clipId, edge, dur);
    tl.project = project;
    tl.draw();
  },
  onFadeEnd: () => commitSnapshotIfChanged(),
  onToggleTrack: (trackId, prop) => {
    pushHistory();
    const track = project.tracks.find((t) => t.id === trackId);
    const cur = track ? !!track[prop] : false;
    project = updateTrack(project, trackId, { [prop]: !cur });
    tl.project = project;
    preview.project = project;
    tl.draw();
    preview.render();
    if (playing && (prop === "muted" || prop === "solo")) audio.start(project, playhead);
  },
  onTrackResizeBegin: () => {
    trimSnapshot = structuredClone(project);
  },
  onTrackResize: (trackId, height) => {
    project = updateTrack(project, trackId, { height });
    tl.project = project;
    tl.resize(wrap.clientWidth, wrap.clientHeight);
  },
  onTrackResizeEnd: () => commitSnapshotIfChanged(),
});
tl.project = project;

// --------------------------------------------------------------- import --
function ensureAudioTracks(count: number) {
  const have = project.tracks.filter((t) => t.kind === "audio").length;
  for (let i = have; i < count; i++) {
    project.tracks.push({ id: newId("track"), kind: "audio", clips: [] });
  }
}

/** Guarantees at least one video track exists (placement no-ops without one). */
function ensureVideoTrack() {
  if (!project.tracks.some((t) => t.kind === "video")) project = addVideoTrack(project);
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif"]);
const VIDEO_EXTS = new Set(["mp4", "mkv", "avi", "mov", "webm", "m4v"]);
function isImagePath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase();
  return ext ? IMAGE_EXTS.has(ext) : false;
}
function isGifPath(p: string): boolean {
  return p.split(".").pop()?.toLowerCase() === "gif";
}
/** A path we can import (video or image) — used to filter OS drag-and-drop. */
function isSupportedMediaPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase();
  return !!ext && (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext));
}

/** Extracts waveforms + decodes audio for a media's streams (background). */
function hydrateMediaAudio(m: Media) {
  if (m.isText || m.isColor) return;
  for (let s = 0; s < m.audioStreamCount; s++) {
    extractWaveform(m.path, s)
      .then((env) => {
        tl.waveforms.set(`${m.id}:${s}`, env);
        tl.draw();
      })
      .catch(() => {});
    void audio.loadTrack(m.id, m.path, s);
  }
}

/** Extracts filmstrip thumbnails for a video media (background) and caches them. */
function hydrateMediaThumbnails(m: Media) {
  if (!m.hasVideo || m.isImage || m.isText || m.isColor) return;
  const count = 12;
  extractThumbnails(m.path, count, m.duration, 128, 72)
    .then((urls) => {
      const thumbs: { img: HTMLImageElement; t: number }[] = [];
      urls.forEach((url, i) => {
        if (!url) return;
        const img = new Image();
        img.onload = () => tl.draw();
        img.src = url;
        thumbs.push({ img, t: ((i + 0.5) / count) * Math.max(m.duration, 0.001) });
      });
      thumbs.sort((a, b) => a.t - b.t);
      tl.thumbnails.set(m.id, thumbs);
      tl.draw();
    })
    .catch(() => {});
}

/** Reads a still image's natural dimensions via a throwaway <img>. */
function probeImage(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 1920, height: 1080 });
    img.src = assetUrl(path);
  });
}

async function importMedia() {
  const selected = await open({
    multiple: true,
    filters: [
      {
        name: "Media",
        extensions: ["mp4", "mkv", "avi", "mov", "webm", "png", "jpg", "jpeg", "webp", "bmp", "gif"],
      },
      { name: "Video", extensions: ["mp4", "mkv", "avi", "mov", "webm"] },
      { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  await importPaths(paths);
}

/**
 * Imports files into the Project bin (shared by the dialog and OS drag-drop).
 * Media is NOT auto-placed on the timeline — drag it from the bin, use the
 * Source monitor, or drop directly onto the timeline. Returns the added media.
 */
async function importPaths(paths: string[]): Promise<Media[]> {
  if (paths.length === 0) return [];
  pushHistory();
  const added: Media[] = [];

  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() ?? path;

    if (isImagePath(path)) {
      const { width, height } = await probeImage(path);
      const media: Media = {
        id: newId("media"),
        path,
        name,
        duration: DEFAULT_IMAGE_DURATION,
        hasVideo: true,
        audioStreamCount: 0,
        isImage: true,
        isAnimated: isGifPath(path),
        width,
        height,
      };
      project = addMedia(project, media);
      added.push(media);
      continue;
    }

    const probe = await probeFile(path);
    const media: Media = {
      id: newId("media"),
      path,
      name,
      duration: probe.durationSec,
      hasVideo: true,
      audioStreamCount: probe.audioTracks.length,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
    };
    project = addMedia(project, media);
    added.push(media);
    hydrateMediaAudio(media); // waveforms + decoded audio (background)
    hydrateMediaThumbnails(media); // filmstrip thumbnails (background)
  }

  refreshMediaList();
  tl.project = project;
  preview.project = project;
  // Adopt the first imported video's resolution/frame rate for the canvas.
  if (canvasAutoAdopt) {
    const vm = added.find((m) => !m.isImage && m.width) ?? added.find((m) => m.width);
    if (vm?.width && vm.height) {
      projectFps = vm.fps && vm.fps > 0 ? vm.fps : projectFps;
      tl.fps = projectFps;
      applyCanvasSize(vm.width, vm.height);
    }
  }
  updateProjInfo();
  return added;
}

/** Places freshly-imported media on the timeline at an OS-drop location. */
function placeAddedOnTimeline(list: Media[], clientX: number, clientY: number) {
  const info = tl.dropInfoAt(clientX, clientY);
  let at = info ? info.time : timelineDuration(project);
  const targetVideoId = info && info.kind === "video" ? info.trackId : undefined;
  for (const m of list) {
    ensureVideoTrack();
    ensureAudioTracks(m.audioStreamCount);
    project = placeMedia(project, m.id, at, targetVideoId);
    at += m.duration; // sequence multiple dropped files back-to-back
  }
  exportBtn.disabled = timelineDuration(project) <= 0;
  playBtn.disabled = timelineDuration(project) <= 0;
  tl.resize(wrap.clientWidth, wrap.clientHeight);
  syncAll();
}

function refreshMediaList() {
  if (project.media.length === 0) {
    mediaListEl.innerHTML = `<p class="empty-hint">Import videos to build your timeline.</p>`;
    const recent = getRecent();
    if (recent.length) {
      const wrap2 = document.createElement("div");
      wrap2.className = "recent-list";
      const title = document.createElement("div");
      title.className = "recent-title";
      title.textContent = "Recent projects";
      wrap2.appendChild(title);
      for (const p of recent) {
        const b = document.createElement("button");
        b.className = "recent-item";
        b.textContent = p.split(/[\\/]/).pop() ?? p;
        b.title = p;
        b.addEventListener("click", () => void openProjectPath(p));
        wrap2.appendChild(b);
      }
      mediaListEl.appendChild(wrap2);
    }
    return;
  }
  mediaListEl.innerHTML = "";
  for (const m of project.media) {
    const item = document.createElement("div");
    item.className = "media-item";
    if (m.id === selectedMediaId) item.classList.add("selected");
    item.dataset.mediaId = m.id;
    item.title = "Click to select as Insert/Overwrite source; drag onto the timeline to place";
    const name = document.createElement("div");
    name.className = "m-name";
    name.textContent = m.isText ? m.text?.content.split("\n")[0] || "Text" : m.name;
    const meta = document.createElement("div");
    meta.className = "m-meta";
    meta.textContent = m.isText
      ? "text"
      : m.isAdjustment
        ? "adjustment"
        : m.isColor
          ? `matte · ${m.color}`
          : m.isImage
            ? `${m.isAnimated ? "gif" : "image"} · ${m.width}×${m.height}`
            : `${secondsToTimestamp(m.duration)} · ${m.audioStreamCount} audio`;
    item.append(name, meta);
    mediaListEl.appendChild(item);
  }
}

function updateProjInfo() {
  const dur = timelineDuration(project);
  const clips = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  projInfo.textContent =
    project.media.length === 0
      ? "No media"
      : `${project.media.length} media · ${clips} clips · ${secondsToTimestamp(dur)}`;
}

// -------------------------------------------------------------- preview --
// The compositing Preview draws every active visual clip with its transform.
const preview = new Preview(previewCanvas, videoSources, {
  onTransformBegin: () => {
    trimSnapshot = structuredClone(project);
  },
  onTransform: (clipId, patch) => {
    applyAnimPatch(clipId, patch); // keyframe-aware (writes a keyframe if animated)
    tl.project = project;
    preview.project = project;
    updatePropsPanel();
  },
  onTransformEnd: () => {
    commitSnapshotIfChanged();
  },
});
preview.project = project;

// -------------------------------------------------------------- scopes --
// Analysis-only overlay: samples the program monitor each frame. Never touches
// the model or export, so it can't affect rendered video.
const scopePanel = $<HTMLDivElement>("scopePanel");
const scopeCanvas = $<HTMLCanvasElement>("scopeCanvas");
const scopeBtn = $<HTMLButtonElement>("scopeBtn");
const scope = new ScopeView(scopeCanvas);
scopeBtn.addEventListener("click", () => {
  scope.enabled = !scope.enabled;
  scopeBtn.classList.toggle("active", scope.enabled);
  scopePanel.classList.toggle("hidden", !scope.enabled);
  if (scope.enabled) scope.resize();
});
for (const tab of Array.from(document.querySelectorAll<HTMLButtonElement>(".scope-tab"))) {
  tab.addEventListener("click", () => {
    scope.mode = tab.dataset.scope as ScopeMode;
    for (const t of Array.from(document.querySelectorAll(".scope-tab"))) {
      t.classList.toggle("active", t === tab);
    }
  });
}
/** Feed the current program frame into the active scope (call after render). */
function updateScope() {
  if (!scope.enabled) return;
  const r = preview.outputDeviceRect();
  if (r) scope.update(previewCanvas, r.sx, r.sy, r.sw, r.sh);
}

function seek(t: number) {
  shuttleRate = 0; // any manual seek cancels J/K/L shuttling
  playhead = snapToFrame(Math.max(0, t), projectFps); // playhead always on a frame
  tl.playhead = playhead;
  tl.draw();
  tcEl.textContent = secondsToTimecode(playhead, projectFps);
  preview.project = project;
  preview.playhead = playhead;
  if (playing) audio.start(project, playhead); // re-anchor + reschedule audio
  preview.render();
  updatePropsPanel(); // reflect keyframed values at the new time
}

/** Steps the playhead by `n` frames (negative = back), pausing playback. */
function stepFrames(n: number) {
  if (playing) void togglePlay();
  seek(playhead + n * frameDuration(projectFps));
}

/** All edit points (clip starts/ends) across the sequence, plus 0. */
function allEditPoints(): number[] {
  const set = new Set<number>([0]);
  for (const t of project.tracks) {
    for (const c of t.clips) {
      set.add(c.start);
      set.add(clipEnd(c));
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** Jumps to the previous/next edit point (Up/Down in Premiere). */
function gotoEdit(dir: 1 | -1) {
  const pts = allEditPoints();
  if (dir > 0) {
    const next = pts.find((p) => p > playhead + 1e-4);
    seek(next ?? timelineDuration(project));
  } else {
    const prev = [...pts].reverse().find((p) => p < playhead - 1e-4);
    seek(prev ?? 0);
  }
}

// -------------------------------------------------------------- playback --
// The audio engine's clock is the master while playing: it drives the playhead
// across the whole timeline; the Preview composites the picture; all audio
// tracks are mixed by the engine with per-clip gain.
let playing = false;
let shuttleRate = 0; // J/K/L shuttle speed (0 = off; signed multiplier)
let lastTickTs = performance.now();

/**
 * Sets the J/K/L shuttle speed (muted variable-speed scrub). Forward plays the
 * video sources at that rate for smooth frames; reverse steps via seeks.
 */
function setShuttle(rate: number) {
  shuttleRate = rate;
  if (rate === 0) {
    preview.playing = false;
    preview.rate = 1;
    return;
  }
  if (playing) {
    playing = false; // leave normal (audio) playback
    playBtn.textContent = "Play";
  }
  audio.stop(); // shuttle is muted
  preview.rate = rate > 0 ? rate : 1;
  preview.playing = rate > 0; // forward: play at speed; reverse: seek-based stepping
}

/** L/J apply a target rate; 1x forward means normal playback (with audio). */
function applyShuttleRate(r: number) {
  if (r === 1) {
    setShuttle(0);
    if (!playing) void togglePlay(); // 1x = play with audio + video
  } else {
    setShuttle(r);
  }
}
function shuttleForwardKey() {
  let target: number;
  if (playing && shuttleRate === 0) target = 2; // normal 1x -> 2x shuttle
  else if (shuttleRate > 0) target = Math.min(8, shuttleRate * 2);
  else target = 1; // stopped or reverse -> forward 1x (audio)
  applyShuttleRate(target);
}
function shuttleReverseKey() {
  applyShuttleRate(shuttleRate < 0 ? Math.max(-8, shuttleRate * 2) : -1);
}

let loopEnabled = false;
const loopBtn = $<HTMLButtonElement>("loopBtn");
loopBtn.addEventListener("click", () => {
  loopEnabled = !loopEnabled;
  loopBtn.classList.toggle("active", loopEnabled);
});

async function togglePlay() {
  shuttleRate = 0;
  if (timelineDuration(project) <= 0) return;
  if (playing) {
    playing = false;
    preview.playing = false;
    audio.stop();
    playBtn.textContent = "Play";
    return;
  }
  const end = timelineDuration(project);
  if (loopEnabled) {
    const ls = tl.inPoint ?? 0;
    const le = Math.min(tl.outPoint ?? end, end);
    if (playhead >= le - 0.01 || playhead < ls) playhead = ls; // start inside the loop
  } else if (playhead >= end - 0.01) {
    playhead = 0;
  }
  playing = true;
  preview.playing = true;
  playBtn.textContent = "Pause";
  await audio.resume();
  audio.setMasterVolume(Number(volEl.value) / 100);
  audio.start(project, playhead);
}

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTickTs) / 1000);
  lastTickTs = now;

  if (shuttleRate !== 0) {
    const end = timelineDuration(project);
    let np = playhead + shuttleRate * dt;
    if (np <= 0) {
      np = 0;
      setShuttle(0); // reached the start
    } else if (np >= end) {
      np = end;
      setShuttle(0); // reached the end
    }
    playhead = np;
    tl.playhead = playhead;
    tcEl.textContent = secondsToTimecode(playhead, projectFps);
    tl.followPlayhead(playhead);
    tl.draw();
  } else if (playing) {
    const t = audio.playing ? audio.timeNow() : playhead;
    const end = timelineDuration(project);
    const loopStart = tl.inPoint ?? 0;
    const loopEnd = loopEnabled ? Math.min(tl.outPoint ?? end, end) : end;
    if (t >= loopEnd) {
      if (loopEnabled) {
        playhead = loopStart; // wrap back and keep playing
        audio.start(project, loopStart);
      } else {
        playhead = end;
        playing = false;
        preview.playing = false;
        audio.stop();
        playBtn.textContent = "Play";
      }
    } else {
      playhead = t;
    }
    tl.playhead = playhead;
    tcEl.textContent = secondsToTimecode(playhead, projectFps);
    tl.followPlayhead(playhead); // keep the playhead visible while playing
    tl.draw();
  }
  preview.project = project; // keep the preview on the latest project each frame
  preview.playhead = playhead;
  preview.render(); // composite every frame (shows seeked frames while paused too)
  updateScope();
  updateMeter();
  requestAnimationFrame(tick);
}

// Output level (VU) meter: rises to the peak, then decays smoothly.
const meterFill = $<HTMLDivElement>("meterFill");
let meterLevel = 0;
function updateMeter() {
  const target = playing && audio.playing ? audio.getLevel() : 0;
  meterLevel = target > meterLevel ? target : meterLevel * 0.85 + target * 0.15;
  meterFill.style.width = `${Math.round(Math.min(1, meterLevel) * 100)}%`;
}

// -------------------------------------------------------------- resize --
const wrap = $<HTMLDivElement>("tlCanvasWrap");
const ro = new ResizeObserver(() => {
  tl.resize(wrap.clientWidth, wrap.clientHeight);
});
ro.observe(wrap);

// Preview canvas follows its container's size.
const videoWrap = previewCanvas.parentElement as HTMLDivElement;
const previewRo = new ResizeObserver(() => {
  preview.resize(videoWrap.clientWidth, videoWrap.clientHeight);
  preview.render();
});
previewRo.observe(videoWrap);

// Splitters. `sign` maps drag direction to size change (+1: size grows as the
// pointer moves in the axis-positive direction; -1: it shrinks). The start size
// is captured once per drag, and the ABSOLUTE delta is applied from it — never
// re-baselined mid-drag, which was the bug that made panels jump to min/max.
function dragSplit(
  splitId: string,
  axis: "x" | "y",
  sign: 1 | -1,
  getSize: () => number,
  setSize: (px: number) => void,
) {
  const el = $<HTMLDivElement>(splitId);
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const startPos = axis === "x" ? e.clientX : e.clientY;
    const startSize = getSize();
    const move = (ev: PointerEvent) => {
      const cur = axis === "x" ? ev.clientX : ev.clientY;
      setSize(startSize + sign * (cur - startPos));
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

const mediaPool = $<HTMLElement>("mediaPool");
const timelinePanel = $<HTMLElement>("timelinePanel");

// Media pool: wider as the pointer moves right.
dragSplit(
  "splitTopH",
  "x",
  1,
  () => mediaPool.getBoundingClientRect().width,
  (w) => {
    const c = Math.min(600, Math.max(150, w));
    mediaPool.style.flexBasis = `${c}px`;
    mediaPool.style.width = `${c}px`;
  },
);

// Timeline: the divider sits above it, so dragging DOWN shrinks it (sign -1).
dragSplit(
  "splitMid",
  "y",
  -1,
  () => timelinePanel.getBoundingClientRect().height,
  (h) => {
    const c = Math.min(window.innerHeight - 160, Math.max(120, h));
    timelinePanel.style.flexBasis = `${c}px`;
    timelinePanel.style.height = `${c}px`;
  },
);

// Drag media files from the OS (Explorer/Finder) straight onto the window.
void getCurrentWebview().onDragDropEvent((event) => {
  const p = event.payload;
  if (p.type === "over" || p.type === "enter") {
    document.body.classList.add("drag-over");
  } else if (p.type === "leave") {
    document.body.classList.remove("drag-over");
  } else if (p.type === "drop") {
    document.body.classList.remove("drag-over");
    const files = (p.paths ?? []).filter(isSupportedMediaPath);
    if (!files.length) return;
    // Tauri reports a physical-pixel position; convert to CSS/client coords.
    const dpr = window.devicePixelRatio || 1;
    const cx = (p.position?.x ?? 0) / dpr;
    const cy = (p.position?.y ?? 0) / dpr;
    void importPaths(files).then((added) => {
      const r = canvas.getBoundingClientRect();
      const overTimeline = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      if (overTimeline && added.length) placeAddedOnTimeline(added, cx, cy);
    });
  }
});

// -------------------------------------------------------------- wiring --
importBtn.addEventListener("click", () => void importMedia());
playBtn.addEventListener("click", () => void togglePlay());
zoomFitBtn.addEventListener("click", () => tl.zoomToFit());
// --- Export options modal ---
const exportModal = $<HTMLDivElement>("exportModal");
const expResolution = $<HTMLSelectElement>("expResolution");
const expFps = $<HTMLSelectElement>("expFps");
const expCodec = $<HTMLSelectElement>("expCodec");
const expQuality = $<HTMLSelectElement>("expQuality");
const expAudio = $<HTMLSelectElement>("expAudio");
const expSummary = $<HTMLDivElement>("expSummary");
const expCancel = $<HTMLButtonElement>("expCancel");
const expConfirm = $<HTMLButtonElement>("expConfirm");

// --- Export progress overlay ---
const exportProgress = $<HTMLDivElement>("exportProgress");
const expProgStatus = $<HTMLDivElement>("expProgStatus");
const expProgFill = $<HTMLDivElement>("expProgFill");
const expProgPct = $<HTMLDivElement>("expProgPct");
const expProgCancel = $<HTMLButtonElement>("expProgCancel");

// Per-codec CRF for each quality preset (lower = higher quality).
const CRF: Record<"h264" | "h265", Record<"high" | "balanced" | "small", number>> = {
  h264: { high: 18, balanced: 21, small: 26 },
  h265: { high: 22, balanced: 25, small: 30 },
};

/** Canvas taken from the first video clip's media (fallback 1080p30). */
function sourceCanvas(): { width: number; height: number; fps: number } {
  const firstVideo = project.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips)
    .sort((a, b) => a.start - b.start)[0];
  const vm = firstVideo ? project.media.find((m) => m.id === firstVideo.mediaId) : undefined;
  return {
    width: vm?.width || 1920,
    height: vm?.height || 1080,
    fps: vm?.fps && vm.fps > 0 ? vm.fps : 30,
  };
}

exportBtn.addEventListener("click", () => {
  if (timelineDuration(project) <= 0) return;
  const s = sourceCanvas();
  expSummary.textContent = `Canvas: ${canvasW}×${canvasH} · source ${s.width}×${s.height} @ ${s.fps.toFixed(2)} fps`;
  exportModal.classList.remove("hidden");
});
expCancel.addEventListener("click", () => exportModal.classList.add("hidden"));
exportModal.addEventListener("click", (e) => {
  if (e.target === exportModal) exportModal.classList.add("hidden"); // click backdrop to close
});

expConfirm.addEventListener("click", () => {
  const s = sourceCanvas();
  let width = canvasW;
  let height = canvasH;
  if (expResolution.value !== "canvas") {
    const [w, h] = expResolution.value.split("x").map(Number);
    width = w;
    height = h;
  }
  const fps = expFps.value === "source" ? s.fps : Number(expFps.value);
  const codec = expCodec.value as "h264" | "h265";
  const quality = expQuality.value as "high" | "balanced" | "small";
  const audioMode = expAudio.value as "mix" | "separate";
  exportModal.classList.add("hidden");
  void doExport({ width, height, fps: fps > 0 ? fps : 30, codec, crf: CRF[codec][quality], audioMode });
});

/** Renders a text clip to a full-frame (W×H) transparent PNG with its transform
 *  baked in — same drawing code as the preview, so the export matches. */
async function renderTextPng(
  spec: TextSpec,
  tr: Transform,
  W: number,
  H: number,
): Promise<Uint8Array> {
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  const layout = layoutText(ctx, spec);
  ctx.save();
  ctx.translate(tr.x * W, tr.y * H);
  ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale((W / canvasW) * tr.scaleX, (H / canvasH) * tr.scaleY);
  drawTextCentred(ctx, spec, layout);
  ctx.restore();
  const blob: Blob = await new Promise((res) => cv.toBlob((b) => res(b!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** A matte PNG. Solid mattes are a tiny swatch (scaled up by the compiler);
 *  gradients render at the export resolution so the ramp stays smooth. Uses the
 *  same `matteFill` as the preview, so the two match. */
async function renderMattePng(media: Media, W: number, H: number): Promise<Uint8Array> {
  const gradient = !!media.gradient;
  const w = gradient ? W : 16;
  const h = gradient ? H : 16;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = matteFill(ctx, media, 0, 0, w, h);
  ctx.fillRect(0, 0, w, h);
  const blob: Blob = await new Promise((res) => cv.toBlob((b) => res(b!), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Produces a project where generated clips (text, colour matte) are replaced by
 *  baked image clips, so the pure export compiler needs no text/matte logic.
 *  Text bakes its transform into a full-frame PNG (identity clip); a matte bakes a
 *  plain solid PNG and KEEPS its transform, so matte scale/position/keyframes
 *  still animate. */
async function buildExportProject(W: number, H: number): Promise<Project> {
  const genClips: Clip[] = [];
  for (const t of project.tracks) {
    if (t.kind !== "video") continue;
    for (const c of t.clips) {
      const m = project.media.find((mm) => mm.id === c.mediaId);
      if (m?.isText || m?.isColor) genClips.push(c);
    }
  }
  if (genClips.length === 0) return project;

  const out: Project = structuredClone(project);
  for (const clip of genClips) {
    const media = project.media.find((m) => m.id === clip.mediaId)!;
    const isText = !!media.isText;
    const bytes = isText
      ? await renderTextPng(media.text!, clipTransform(clip), W, H)
      : await renderMattePng(media, W, H);
    const path = await invoke<string>("write_temp_file", {
      name: `${isText ? "text" : "matte"}_${clip.id}_${Date.now()}.png`,
      data: Array.from(bytes),
    });
    const imgId = newId("media");
    out.media.push({
      id: imgId,
      path,
      name: isText ? "text" : "matte",
      duration: media.duration,
      hasVideo: true,
      audioStreamCount: 0,
      isImage: true,
      width: W,
      height: H,
    });
    for (const t of out.tracks) {
      for (const c of t.clips) {
        if (c.id !== clip.id) continue;
        c.mediaId = imgId;
        if (isText) delete c.transform; // text baked its transform into the PNG
        // matte keeps its transform so scale/position/keyframes still apply
      }
    }
  }
  return out;
}

async function doExport(o: {
  width: number;
  height: number;
  fps: number;
  codec: "h264" | "h265";
  crf: number;
  audioMode: "mix" | "separate";
}) {
  // Export the In/Out range if set, else the whole sequence.
  const seqDur = timelineDuration(project);
  const hasRange = tl.inPoint !== null || tl.outPoint !== null;
  const rangeStart = hasRange ? (tl.inPoint ?? 0) : undefined;
  const rangeEnd = hasRange ? (tl.outPoint ?? seqDur) : undefined;
  const total = hasRange ? (rangeEnd! - rangeStart!) : seqDur;
  const outPath = await save({
    defaultPath: "export.mp4",
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });
  if (!outPath) return;

  if (playing) {
    playing = false;
    preview.playing = false;
    audio.stop();
    playBtn.textContent = "Play";
  }

  // Show the progress overlay immediately so there's feedback while we build
  // the filter graph and wait for ffmpeg's first `time=` line (which can lag
  // by several seconds on complex compositions).
  showExportProgress("Preparing composition…");
  exportBtn.disabled = true;
  importBtn.disabled = true;
  let cancelled = false;

  try {
    const exportProject = await buildExportProject(o.width, o.height);
    const args = compileExport(exportProject, {
      outputFile: outPath,
      width: o.width,
      height: o.height,
      fps: o.fps,
      videoCodec: o.codec,
      crf: o.crf,
      rangeStart,
      rangeEnd,
      audioMode: o.audioMode,
    });

    setExportStatus("Starting ffmpeg…");
    let started = false;
    const run = runFfmpeg(args, (sec) => {
      if (!started) {
        started = true;
        setExportStatus("Encoding…");
      }
      const pct = Math.min(100, (sec / total) * 100);
      setExportProgress(pct);
    });

    expProgCancel.onclick = () => {
      cancelled = true;
      setExportStatus("Cancelling…");
      run.cancel();
    };

    const code = await run.done;
    hideExportProgress();
    if (cancelled) {
      // ffmpeg was killed — leave the (partial) file, just report it.
      await message("Export cancelled.", { title: "Export cancelled" });
    } else if (code === 0) {
      await message(`Saved to:\n${outPath}`, { title: "Export complete" });
    } else {
      await message(`FFmpeg exited with code ${code}.`, { title: "Export failed", kind: "error" });
    }
  } catch (e) {
    hideExportProgress();
    if (!cancelled) await message(`Export error: ${e}`, { title: "Export failed", kind: "error" });
  } finally {
    exportBtn.disabled = false;
    importBtn.disabled = false;
    exportBtn.textContent = "Export";
    expProgCancel.onclick = null;
  }
}

/** Reveals the export overlay in its indeterminate "preparing" state. */
function showExportProgress(status: string) {
  expProgStatus.textContent = status;
  expProgPct.textContent = "";
  expProgFill.classList.add("indeterminate");
  expProgFill.style.width = "";
  exportProgress.classList.remove("hidden");
}
function setExportStatus(status: string) {
  expProgStatus.textContent = status;
}
/** Switches the bar to determinate mode and sets it to `pct` (0–100). */
function setExportProgress(pct: number) {
  expProgFill.classList.remove("indeterminate");
  expProgFill.style.width = `${pct}%`;
  expProgPct.textContent = `${pct.toFixed(0)}%`;
  exportBtn.textContent = `Exporting ${pct.toFixed(0)}%`;
}
function hideExportProgress() {
  exportProgress.classList.add("hidden");
}

function doAddVideoTrack() {
  pushHistory();
  project = addVideoTrack(project);
  tl.project = project;
  tl.resize(wrap.clientWidth, wrap.clientHeight); // more rows -> recompute canvas
  tl.draw();
}
function doAddAudioTrack() {
  pushHistory();
  project = addAudioTrack(project);
  tl.project = project;
  tl.resize(wrap.clientWidth, wrap.clientHeight);
  tl.draw();
}
$<HTMLButtonElement>("addVideoTrackBtn").addEventListener("click", doAddVideoTrack);
$<HTMLButtonElement>("addAudioTrackBtn").addEventListener("click", doAddAudioTrack);

const linkBtn = $<HTMLButtonElement>("linkBtn");
const unlinkBtn = $<HTMLButtonElement>("unlinkBtn");
function doLink() {
  if (tl.selected.size < 2) return;
  pushHistory();
  project = linkClips(project, [...tl.selected]);
  tl.project = project;
  tl.draw();
  refreshSelectionUI();
}
function doUnlink() {
  if (tl.selected.size === 0) return;
  pushHistory();
  // Unlink exactly the selected (shift-clicked) clips.
  project = unlinkClips(project, [...tl.selected]);
  tl.project = project;
  tl.draw();
  refreshSelectionUI();
}
linkBtn.addEventListener("click", doLink);
unlinkBtn.addEventListener("click", doUnlink);

function refreshSelectionUI() {
  linkBtn.disabled = tl.selected.size < 2;
  // Enable Unlink if any selected clip currently belongs to a group.
  const anyGrouped = [...tl.selected].some((id) => groupMembers(project, id).length > 1);
  unlinkBtn.disabled = !anyGrouped;
}

// --- Transform properties panel ---
const propsPanel = $<HTMLDivElement>("propsPanel");
const prX = $<HTMLInputElement>("prX");
const prY = $<HTMLInputElement>("prY");
const prScaleX = $<HTMLInputElement>("prScaleX");
const prScaleY = $<HTMLInputElement>("prScaleY");
const prLinkScale = $<HTMLButtonElement>("prLinkScale");
const prRot = $<HTMLInputElement>("prRot");
const prOpacity = $<HTMLInputElement>("prOpacity");
const prSpeed = $<HTMLInputElement>("prSpeed");
const prReverse = $<HTMLButtonElement>("prReverse");
const prBlend = $<HTMLSelectElement>("prBlend");
const prReset = $<HTMLButtonElement>("prReset");
const fxAdd = $<HTMLSelectElement>("fxAdd");
const fxList = $<HTMLDivElement>("fxList");
const fxCopy = $<HTMLButtonElement>("fxCopy");
const fxPaste = $<HTMLButtonElement>("fxPaste");
const fxClear = $<HTMLButtonElement>("fxClear");
let effectsClipboard: import("../core/project.ts").ClipEffect[] | null = null;

/** (Re)populates the "Add effect" dropdown — limited to gate-able colour/blur
 *  effects when the selected clip is an adjustment layer. */
function refreshFxAdd(isAdjustment: boolean) {
  fxAdd.replaceChildren();
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "+ Add effect…";
  fxAdd.appendChild(ph);
  for (const def of EFFECTS) {
    if (isAdjustment && !ADJUSTMENT_EFFECT_IDS.has(def.id)) continue;
    const opt = document.createElement("option");
    opt.value = def.id;
    opt.textContent = def.label;
    fxAdd.appendChild(opt);
  }
}
refreshFxAdd(false);
fxAdd.addEventListener("change", () => {
  const type = fxAdd.value;
  fxAdd.value = ""; // reset to placeholder
  const id = selectedTransformClip();
  if (!id || !type) return;
  pushHistory();
  project = addClipEffect(project, id, type, defaultParams(type), defaultColors(type));
  tl.project = project;
  preview.project = project;
  renderEffectList(id);
  preview.render();
});

fxCopy.addEventListener("click", () => {
  const id = selectedTransformClip();
  const clip = id ? findClipById(id) : undefined;
  if (!clip) return;
  effectsClipboard = clipEffects(clip).map((e) => structuredClone(e));
  fxPaste.disabled = effectsClipboard.length === 0;
});
fxPaste.addEventListener("click", () => {
  const id = selectedTransformClip();
  if (!id || !effectsClipboard || effectsClipboard.length === 0) return;
  pushHistory();
  project = appendClipEffects(project, id, effectsClipboard);
  syncEffects(id);
});
fxClear.addEventListener("click", () => {
  const id = selectedTransformClip();
  if (!id) return;
  pushHistory();
  project = clearClipEffects(project, id);
  syncEffects(id);
});

/** Rebuilds the per-clip effect cards in the Effects section. */
function renderEffectList(clipId: string) {
  const clip = findClipById(clipId);
  fxList.replaceChildren();
  fxParamSyncers = [];
  fxRenderedClip = clipId;
  fxRenderedEffects = clip?.effects;
  if (!clip) return;
  refreshFxAdd(!!project.media.find((m) => m.id === clip.mediaId)?.isAdjustment);
  const effects = clipEffects(clip);
  effects.forEach((inst, index) => {
    const def = effectDef(inst.type);
    if (!def) return;
    const card = document.createElement("div");
    card.className = "fx-item" + (inst.enabled === false ? " disabled" : "");

    const head = document.createElement("div");
    head.className = "fx-item-head";
    const up = document.createElement("button");
    up.className = "fx-item-move";
    up.textContent = "▲";
    up.title = "Move effect up";
    up.disabled = index === 0;
    up.addEventListener("click", () => {
      pushHistory();
      project = moveClipEffect(project, clipId, index, -1);
      syncEffects(clipId);
    });
    const down = document.createElement("button");
    down.className = "fx-item-move";
    down.textContent = "▼";
    down.title = "Move effect down";
    down.disabled = index === effects.length - 1;
    down.addEventListener("click", () => {
      pushHistory();
      project = moveClipEffect(project, clipId, index, 1);
      syncEffects(clipId);
    });
    const name = document.createElement("span");
    name.className = "fx-item-name";
    name.textContent = def.label;
    const toggle = document.createElement("button");
    toggle.className = "fx-item-toggle" + (inst.enabled === false ? "" : " active");
    toggle.textContent = inst.enabled === false ? "Off" : "On";
    toggle.title = "Enable/disable this effect";
    toggle.addEventListener("click", () => {
      pushHistory();
      project = toggleClipEffect(project, clipId, index);
      syncEffects(clipId);
    });
    const remove = document.createElement("button");
    remove.className = "fx-item-remove";
    remove.textContent = "✕";
    remove.title = "Remove effect";
    remove.addEventListener("click", () => {
      pushHistory();
      project = removeClipEffect(project, clipId, index);
      tl.project = project;
      preview.project = project;
      renderEffectList(clipId);
      preview.render();
    });
    head.append(up, down, name, toggle, remove);
    card.appendChild(head);

    // Colour parameters (e.g. chroma-key colour) — a picker, no keyframing.
    for (const cp of def.colors ?? []) {
      const row = document.createElement("label");
      row.className = "fx-param";
      const label = document.createElement("span");
      label.className = "pf-label";
      label.textContent = cp.label;
      const color = document.createElement("input");
      color.type = "color";
      color.value = inst.colors?.[cp.key] ?? cp.def;
      // One history entry per pick: snapshot before the first `input`, reset on `change`.
      let dirty = false;
      color.addEventListener("input", () => {
        if (!dirty) {
          pushHistory();
          dirty = true;
        }
        project = setClipEffectColor(project, clipId, index, cp.key, color.value);
        preview.project = project;
        preview.render();
      });
      color.addEventListener("change", () => (dirty = false));
      row.append(label, color);
      card.appendChild(row);
    }

    for (const p of def.params) {
      // Toggle params render as a checkbox (no stopwatch, no slider).
      if (p.kind === "toggle") {
        const row = document.createElement("label");
        row.className = "fx-param fx-toggle";
        const label = document.createElement("span");
        label.className = "pf-label";
        label.textContent = p.label;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = (inst.params[p.key] ?? p.def) >= 0.5;
        box.addEventListener("change", () => {
          pushHistory();
          project = setClipEffectParam(project, clipId, index, p.key, box.checked ? 1 : 0);
          preview.project = project;
          preview.render();
        });
        row.append(label, box);
        card.appendChild(row);
        continue;
      }

      const row = document.createElement("label");
      row.className = "fx-param";
      // Per-param stopwatch (animate this parameter over time).
      const kf = document.createElement("button");
      kf.className = "kf" + (isEffectParamAnimated(inst, p.key) ? " active" : "");
      kf.textContent = "◆";
      kf.title = `Animate ${p.label}`;
      const label = document.createElement("span");
      label.className = "pf-label";
      label.textContent = p.label;
      const range = document.createElement("input");
      range.type = "range";
      range.min = String(p.min);
      range.max = String(p.max);
      range.step = String(p.step);
      const num = document.createElement("input");
      num.type = "number";
      num.step = String(p.step);
      const localT = () => playhead - (findClipById(clipId)?.start ?? 0);
      const cur = effectParamAt(inst, p.key, localT());
      range.value = String(cur);
      num.value = String(cur);

      // A keyframe-aware write: animated params write a keyframe at the playhead,
      // static params set the base value.
      const write = (v: number) => {
        const c = findClipById(clipId);
        const i = c?.effects?.[index];
        if (i && isEffectParamAnimated(i, p.key)) {
          project = setEffectKeyframe(project, clipId, index, p.key, localT(), v);
          tl.project = project;
          tl.draw(); // a new keyframe may appear on the clip
        } else {
          project = setClipEffectParam(project, clipId, index, p.key, v);
        }
        preview.project = project;
        preview.render();
      };
      // Slider drag: one history entry per gesture (on pointerdown).
      range.addEventListener("pointerdown", () => pushHistory());
      range.addEventListener("input", () => {
        num.value = range.value;
        write(Number(range.value));
      });
      num.addEventListener("change", () => {
        pushHistory();
        range.value = num.value;
        write(Number(num.value));
      });
      // Stopwatch: on seeds a keyframe at the value; off bakes it and clears.
      kf.addEventListener("click", (e) => {
        e.preventDefault();
        const c = findClipById(clipId);
        const i = c?.effects?.[index];
        if (!i) return;
        pushHistory();
        const lt = localT();
        if (isEffectParamAnimated(i, p.key)) {
          const v = effectParamAt(i, p.key, lt);
          project = setClipEffectParam(project, clipId, index, p.key, v);
          project = clearEffectKeyframes(project, clipId, index, p.key);
        } else {
          project = setEffectKeyframe(project, clipId, index, p.key, lt, i.params[p.key] ?? p.def);
        }
        syncEffects(clipId);
      });
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = p.unit ?? "";
      row.append(kf, label, range, num, unit);
      card.appendChild(row);

      // Scrub-sync: keep an animated param's inputs showing the value at the
      // playhead (skipped while the field is focused / being dragged).
      fxParamSyncers.push(() => {
        const c = findClipById(clipId);
        const i = c?.effects?.[index];
        if (!i || !isEffectParamAnimated(i, p.key)) return;
        if (document.activeElement === range || document.activeElement === num) return;
        const v = effectParamAt(i, p.key, playhead - c.start);
        const s = fmtParam(v);
        range.value = s;
        num.value = s;
      });
    }
    fxList.appendChild(card);
  });
}

/** Formats an effect param value for display (trims float noise). */
function fmtParam(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** Scrub-sync closures for animated effect params, rebuilt with the list. */
let fxParamSyncers: Array<() => void> = [];

/** Re-sync everything after an effect toggle (keeps card state + preview current). */
function syncEffects(clipId: string) {
  tl.project = project;
  preview.project = project;
  renderEffectList(clipId);
  preview.render();
}

// When locked, editing one scale axis mirrors the other (proportional), and
// on-canvas corner drags scale proportionally too.
let lockAspect = true;
preview.lockAspect = lockAspect;
prLinkScale.addEventListener("click", () => {
  lockAspect = !lockAspect;
  preview.lockAspect = lockAspect;
  prLinkScale.classList.toggle("active", lockAspect);
  prLinkScale.textContent = lockAspect ? "Lock ratio" : "Free ratio";
});

/** The single selected clip if it's a transformable (video) clip, else null. */
function selectedTransformClip(): string | null {
  if (tl.selected.size !== 1) return null;
  const id = [...tl.selected][0];
  for (const t of project.tracks) {
    if (t.kind !== "video") continue;
    if (t.clips.some((c) => c.id === id)) return id;
  }
  return null;
}

function syncPreviewSelection() {
  preview.selectedClipId = selectedTransformClip();
  updatePropsPanel();
  syncTextPanel();
  syncMattePanel();
}

function updatePropsPanel() {
  const id = selectedTransformClip();
  if (!id) {
    propsPanel.classList.add("hidden");
    return;
  }
  const clip = findClipById(id);
  if (!clip) {
    propsPanel.classList.add("hidden");
    return;
  }
  // Show the value at the playhead (honours keyframes), so scrubbing reflects the animation.
  const localT = playhead - clip.start;
  const tr = animatedTransform(clip, localT);
  propsPanel.classList.remove("hidden");
  if (document.activeElement !== prX) prX.value = Math.round(tr.x * 100).toString();
  if (document.activeElement !== prY) prY.value = Math.round(tr.y * 100).toString();
  if (document.activeElement !== prScaleX) prScaleX.value = Math.round(tr.scaleX * 100).toString();
  if (document.activeElement !== prScaleY) prScaleY.value = Math.round(tr.scaleY * 100).toString();
  if (document.activeElement !== prRot) prRot.value = Math.round(tr.rotation).toString();
  if (document.activeElement !== prOpacity)
    prOpacity.value = Math.round(animatedOpacity(clip, localT) * 100).toString();
  if (document.activeElement !== prSpeed)
    prSpeed.value = Math.round(clipSpeed(clip) * 100).toString();
  prReverse.classList.toggle("active", clipReversed(clip));
  prBlend.value = clipBlend(clip);
  // Reflect which properties are animated (stopwatch highlighted).
  for (const b of document.querySelectorAll<HTMLButtonElement>(".kf[data-prop]")) {
    b.classList.toggle("active", isAnimated(clip, b.dataset.prop as AnimProp));
  }
  // Rebuild effect cards only when the clip or its (immutable) effects array
  // changes — never on plain scrubs, so an in-progress slider drag isn't torn out.
  if (id !== fxRenderedClip || clip.effects !== fxRenderedEffects) {
    renderEffectList(id);
  } else {
    // Same cards: just refresh animated params to the value at the playhead.
    for (const sync of fxParamSyncers) sync();
  }
}
let fxRenderedClip: string | null = null;
let fxRenderedEffects: Clip["effects"] = undefined;

function findClipById(id: string): Clip | undefined {
  for (const t of project.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

/**
 * Applies transform/opacity values to a clip — keyframe-aware: an animated
 * property writes a keyframe at the playhead; a static one writes the base value.
 * Does NOT push history (callers wrap it) so it works during a drag gesture.
 */
function applyAnimPatch(clipId: string, patch: Partial<Record<AnimProp, number>>) {
  const clip = findClipById(clipId);
  if (!clip) return;
  const localT = playhead - clip.start;
  for (const key of Object.keys(patch) as AnimProp[]) {
    const v = patch[key]!;
    if (isAnimated(clip, key)) project = setKeyframe(project, clipId, key, localT, v);
    else if (key === "opacity") project = setClipOpacity(project, clipId, v);
    else project = setClipTransform(project, clipId, { [key]: v });
  }
}

function commitTransform(patch: Partial<Record<AnimProp, number>>) {
  const id = selectedTransformClip();
  if (!id) return;
  pushHistory();
  applyAnimPatch(id, patch);
  tl.project = project;
  preview.project = project;
  tl.draw();
  updatePropsPanel();
  preview.render();
}

/** Toggles animation for a property (stopwatch): on seeds a keyframe, off bakes
 *  the current value as static and clears keyframes. */
function toggleAnimateProp(prop: AnimProp) {
  const id = selectedTransformClip();
  if (!id) return;
  const clip = findClipById(id)!;
  const localT = playhead - clip.start;
  pushHistory();
  if (isAnimated(clip, prop)) {
    const v = animatedValue(clip, prop, localT);
    if (prop === "opacity") project = setClipOpacity(project, id, v);
    else project = setClipTransform(project, id, { [prop]: v });
    project = clearKeyframes(project, id, prop);
  } else {
    project = setKeyframe(project, id, prop, localT, animatedValue(clip, prop, localT));
  }
  tl.project = project;
  preview.project = project;
  tl.draw();
  updatePropsPanel();
  preview.render();
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".kf[data-prop]")) {
  b.addEventListener("click", () => toggleAnimateProp(b.dataset.prop as AnimProp));
}

prX.addEventListener("change", () => commitTransform({ x: Number(prX.value) / 100 }));
prY.addEventListener("change", () => commitTransform({ y: Number(prY.value) / 100 }));
prRot.addEventListener("change", () => commitTransform({ rotation: Number(prRot.value) }));
prScaleX.addEventListener("change", () => {
  const sx = Number(prScaleX.value) / 100;
  commitTransform(lockAspect ? { scaleX: sx, scaleY: sx } : { scaleX: sx });
});
prScaleY.addEventListener("change", () => {
  const sy = Number(prScaleY.value) / 100;
  commitTransform(lockAspect ? { scaleX: sy, scaleY: sy } : { scaleY: sy });
});
prOpacity.addEventListener("change", () => commitTransform({ opacity: Number(prOpacity.value) / 100 }));
/** Applies a speed change (and optional reverse) to the selected clip's group. */
function commitSpeed(speedPct: number, reverse?: boolean) {
  const id = selectedTransformClip();
  if (!id) return;
  pushHistory();
  project = setClipSpeed(project, id, speedPct / 100, reverse);
  tl.project = project;
  preview.project = project;
  tl.draw();
  updatePropsPanel();
  exportBtn.disabled = timelineDuration(project) <= 0;
  preview.render();
}
prSpeed.addEventListener("change", () => commitSpeed(Number(prSpeed.value)));
prReverse.addEventListener("click", () => {
  const id = selectedTransformClip();
  if (!id) return;
  const clip = findClipById(id);
  commitSpeed(clipSpeed(clip!) * 100, !clipReversed(clip!));
});
prBlend.addEventListener("change", () => {
  const id = selectedTransformClip();
  if (!id) return;
  pushHistory();
  project = setClipBlend(project, id, prBlend.value as BlendMode);
  tl.project = project;
  preview.project = project;
  preview.render();
});

prReset.addEventListener("click", () =>
  commitTransform({ x: 0.5, y: 0.5, scaleX: 1, scaleY: 1, rotation: 0 }),
);

// --- Canvas size control ---
const canvasPreset = $<HTMLSelectElement>("canvasPreset");
const canvasWInput = $<HTMLInputElement>("canvasW");
const canvasHInput = $<HTMLInputElement>("canvasH");

function syncCanvasPreset() {
  const val = `${canvasW}x${canvasH}`;
  const known = [...canvasPreset.options].some((o) => o.value === val);
  canvasPreset.value = known ? val : "custom";
}

/** Sets the output canvas size, updating the preview and the control fields. */
function applyCanvasSize(w: number, h: number, fromUser = false) {
  canvasW = Math.max(16, Math.round(w));
  canvasH = Math.max(16, Math.round(h));
  if (fromUser) canvasAutoAdopt = false; // stop auto-adopting once the user chooses
  preview.canvasW = canvasW;
  preview.canvasH = canvasH;
  preview.resize(videoWrap.clientWidth, videoWrap.clientHeight);
  preview.render();
  canvasWInput.value = String(canvasW);
  canvasHInput.value = String(canvasH);
  syncCanvasPreset();
}

canvasPreset.addEventListener("change", () => {
  if (canvasPreset.value === "custom") return;
  const [w, h] = canvasPreset.value.split("x").map(Number);
  applyCanvasSize(w, h, true);
});
for (const inp of [canvasWInput, canvasHInput]) {
  inp.addEventListener("change", () =>
    applyCanvasSize(Number(canvasWInput.value), Number(canvasHInput.value), true),
  );
}
applyCanvasSize(canvasW, canvasH); // initialise the fields

// --- Text / title clips ---
const addTextBtn = $<HTMLButtonElement>("addTextBtn");
const textPanel = $<HTMLDivElement>("textPanel");
const txtContent = $<HTMLInputElement>("txtContent");
const txtSize = $<HTMLInputElement>("txtSize");
const txtColor = $<HTMLInputElement>("txtColor");
const txtFont = $<HTMLSelectElement>("txtFont");
const txtBold = $<HTMLButtonElement>("txtBold");
const txtItalic = $<HTMLButtonElement>("txtItalic");
const txtAlign = $<HTMLSelectElement>("txtAlign");
const txtBg = $<HTMLInputElement>("txtBg");
const txtBgClear = $<HTMLButtonElement>("txtBgClear");
const txtStroke = $<HTMLInputElement>("txtStroke");
const txtStrokeW = $<HTMLInputElement>("txtStrokeW");
const txtStrokeClear = $<HTMLButtonElement>("txtStrokeClear");
const txtShadow = $<HTMLButtonElement>("txtShadow");

/** The media id if the single selected clip is a text clip, else null. */
function selectedTextMedia(): string | null {
  if (tl.selected.size !== 1) return null;
  const clip = findClipById([...tl.selected][0]);
  const m = clip && project.media.find((mm) => mm.id === clip.mediaId);
  return m && m.isText ? m.id : null;
}

function syncTextPanel() {
  const mid = selectedTextMedia();
  if (!mid) {
    textPanel.classList.add("hidden");
    return;
  }
  const t = project.media.find((m) => m.id === mid)!.text!;
  textPanel.classList.remove("hidden");
  if (document.activeElement !== txtContent) txtContent.value = t.content;
  if (document.activeElement !== txtSize) txtSize.value = String(Math.round(t.fontSize));
  txtColor.value = t.color;
  txtFont.value = t.fontFamily;
  txtAlign.value = t.align;
  txtBold.classList.toggle("active", t.bold);
  txtItalic.classList.toggle("active", t.italic);
  txtBg.value = t.background ?? "#000000";
  txtStroke.value = t.strokeColor ?? "#000000";
  if (document.activeElement !== txtStrokeW) txtStrokeW.value = String(t.strokeWidth ?? 0);
  txtShadow.classList.toggle("active", !!t.shadow);
}

/** Applies a text-spec change as one undoable step. */
function commitText(patch: Partial<TextSpec>) {
  const mid = selectedTextMedia();
  if (!mid) return;
  pushHistory();
  project = setTextSpec(project, mid, patch);
  tl.project = project;
  preview.project = project;
  tl.draw();
  syncTextPanel();
}

// Content + size update live while typing (one undo entry per edit session).
txtContent.addEventListener("focus", () => (trimSnapshot = structuredClone(project)));
txtSize.addEventListener("focus", () => (trimSnapshot = structuredClone(project)));
function liveText(patch: Partial<TextSpec>) {
  const mid = selectedTextMedia();
  if (!mid) return;
  project = setTextSpec(project, mid, patch);
  tl.project = project;
  preview.project = project;
  tl.draw();
}
txtContent.addEventListener("input", () => liveText({ content: txtContent.value }));
txtContent.addEventListener("blur", () => commitSnapshotIfChanged());
txtSize.addEventListener("input", () => {
  const v = Number(txtSize.value);
  if (v >= 4) liveText({ fontSize: v });
});
txtSize.addEventListener("blur", () => commitSnapshotIfChanged());

txtColor.addEventListener("change", () => commitText({ color: txtColor.value }));
txtFont.addEventListener("change", () => commitText({ fontFamily: txtFont.value }));
txtAlign.addEventListener("change", () =>
  commitText({ align: txtAlign.value as TextSpec["align"] }),
);
txtBold.addEventListener("click", () => {
  const mid = selectedTextMedia();
  if (mid) commitText({ bold: !project.media.find((m) => m.id === mid)!.text!.bold });
});
txtItalic.addEventListener("click", () => {
  const mid = selectedTextMedia();
  if (mid) commitText({ italic: !project.media.find((m) => m.id === mid)!.text!.italic });
});
txtBg.addEventListener("change", () => commitText({ background: txtBg.value }));
txtBgClear.addEventListener("click", () => commitText({ background: null }));
txtStroke.addEventListener("change", () => {
  const w = Number(txtStrokeW.value) || 0;
  commitText({ strokeColor: txtStroke.value, strokeWidth: w > 0 ? w : 4 });
});
txtStrokeW.addEventListener("change", () =>
  commitText({ strokeWidth: Math.max(0, Number(txtStrokeW.value) || 0) }),
);
txtStrokeClear.addEventListener("click", () => commitText({ strokeColor: null, strokeWidth: 0 }));
txtShadow.addEventListener("click", () => {
  const mid = selectedTextMedia();
  if (mid) commitText({ shadow: !project.media.find((m) => m.id === mid)!.text!.shadow });
});

function addText() {
  pushHistory();
  const id = newId("media");
  const media: Media = {
    id,
    path: "",
    name: "Text",
    duration: DEFAULT_IMAGE_DURATION,
    hasVideo: true,
    audioStreamCount: 0,
    isText: true,
    text: { ...DEFAULT_TEXT },
    width: canvasW,
    height: canvasH,
  };
  ensureVideoTrack();
  project = addMedia(project, media);
  project = placeMedia(project, id, playhead); // on the top video track at the playhead
  const clip = project.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips)
    .find((c) => c.mediaId === id);
  tl.selected.clear();
  if (clip) tl.selected.add(clip.id);
  exportBtn.disabled = timelineDuration(project) <= 0;
  playBtn.disabled = false;
  syncAll();
  txtContent.focus();
  txtContent.select();
}
addTextBtn.addEventListener("click", addText);

// --- Color matte ---
const addMatteBtn = $<HTMLButtonElement>("addMatteBtn");
const mattePanel = $<HTMLDivElement>("mattePanel");
const matteType = $<HTMLSelectElement>("matteType");
const matteColor = $<HTMLInputElement>("matteColor");
const matteColor2 = $<HTMLInputElement>("matteColor2");
const matteAngle = $<HTMLInputElement>("matteAngle");

/** The media id if the single selected clip is a colour matte, else null. */
function selectedMatteMedia(): string | null {
  if (tl.selected.size !== 1) return null;
  const clip = findClipById([...tl.selected][0]);
  const m = clip && project.media.find((mm) => mm.id === clip.mediaId);
  return m && m.isColor ? m.id : null;
}

function syncMattePanel() {
  const mid = selectedMatteMedia();
  if (!mid) {
    mattePanel.classList.add("hidden");
    return;
  }
  const m = project.media.find((mm) => mm.id === mid)!;
  mattePanel.classList.remove("hidden");
  const isGrad = !!m.gradient;
  matteType.value = isGrad ? "linear" : "solid";
  matteColor.value = m.color ?? DEFAULT_MATTE_COLOR;
  matteColor2.value = m.gradient?.color2 ?? "#ffffff";
  if (document.activeElement !== matteAngle) matteAngle.value = String(m.gradient?.angle ?? 90);
  for (const el of mattePanel.querySelectorAll<HTMLElement>(".matte-grad")) el.hidden = !isGrad;
}

/** Current gradient settings from the panel (for building/updating a gradient). */
function panelGradient() {
  return { color2: matteColor2.value, angle: Number(matteAngle.value) || 0 };
}

matteType.addEventListener("change", () => {
  const mid = selectedMatteMedia();
  if (!mid) return;
  pushHistory();
  project = setMatteGradient(project, mid, matteType.value === "linear" ? panelGradient() : null);
  syncAll();
});

let matteColorDirty = false;
matteColor.addEventListener("input", () => {
  const mid = selectedMatteMedia();
  if (!mid) return;
  if (!matteColorDirty) {
    pushHistory();
    matteColorDirty = true;
  }
  project = setMatteColor(project, mid, matteColor.value);
  tl.project = project;
  preview.project = project;
  preview.render();
});
matteColor.addEventListener("change", () => (matteColorDirty = false));

let matteGradDirty = false;
const commitGradientLive = () => {
  const mid = selectedMatteMedia();
  if (!mid) return;
  if (!matteGradDirty) {
    pushHistory();
    matteGradDirty = true;
  }
  project = setMatteGradient(project, mid, panelGradient());
  tl.project = project;
  preview.project = project;
  preview.render();
};
matteColor2.addEventListener("input", commitGradientLive);
matteColor2.addEventListener("change", () => (matteGradDirty = false));
matteAngle.addEventListener("input", commitGradientLive);
matteAngle.addEventListener("change", () => (matteGradDirty = false));

function addColorMatte() {
  pushHistory();
  const id = newId("media");
  const media: Media = {
    id,
    path: "",
    name: "Color Matte",
    duration: DEFAULT_IMAGE_DURATION,
    hasVideo: true,
    audioStreamCount: 0,
    isColor: true,
    color: DEFAULT_MATTE_COLOR,
    width: canvasW,
    height: canvasH,
  };
  ensureVideoTrack();
  project = addMedia(project, media);
  project = placeMedia(project, id, playhead);
  const clip = project.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips)
    .find((c) => c.mediaId === id);
  tl.selected.clear();
  if (clip) tl.selected.add(clip.id);
  exportBtn.disabled = timelineDuration(project) <= 0;
  playBtn.disabled = false;
  syncAll();
}
addMatteBtn.addEventListener("click", addColorMatte);

const addAdjBtn = $<HTMLButtonElement>("addAdjBtn");
function addAdjustmentLayer() {
  pushHistory();
  const id = newId("media");
  const media: Media = {
    id,
    path: "",
    name: "Adjustment Layer",
    duration: DEFAULT_IMAGE_DURATION,
    hasVideo: true,
    audioStreamCount: 0,
    isAdjustment: true,
    width: canvasW,
    height: canvasH,
  };
  ensureVideoTrack();
  project = addMedia(project, media);
  project = placeMedia(project, id, playhead);
  const clip = project.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips)
    .find((c) => c.mediaId === id);
  tl.selected.clear();
  if (clip) tl.selected.add(clip.id);
  exportBtn.disabled = timelineDuration(project) <= 0;
  playBtn.disabled = false;
  syncAll();
}
addAdjBtn.addEventListener("click", addAdjustmentLayer);

volEl.addEventListener("input", () => audio.setMasterVolume(Number(volEl.value) / 100));
maximizeBtn.addEventListener("click", () => {
  const on = editorEl.classList.toggle("maximized");
  maximizeBtn.textContent = on ? "Restore Layout" : "Maximize Video";
});

const updateBtn = $<HTMLButtonElement>("updateBtn");
updateBtn.addEventListener("click", () => void runUpdateCheck({ silent: false }));

const snapshotBtn = $<HTMLButtonElement>("snapshotBtn");
snapshotBtn.addEventListener("click", () => void saveSnapshot());
async function saveSnapshot() {
  const cv = preview.snapshotCanvas();
  if (!cv) return;
  const blob: Blob | null = await new Promise((res) => cv.toBlob((b) => res(b), "image/png"));
  if (!blob) return;
  const path = await save({
    defaultPath: "frame.png",
    filters: [{ name: "PNG Image", extensions: ["png"] }],
  });
  if (!path) return;
  try {
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    await invoke("write_binary_file", { path, data: bytes });
  } catch (e) {
    await message(`Could not save snapshot: ${e}`, { title: "Snapshot failed", kind: "error" });
  }
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".tool[data-tool]")) {
  btn.addEventListener("click", () => selectTool((btn.dataset.tool as Tool) ?? "select"));
}

window.addEventListener("keydown", (e) => {
  // While the export modal is open, only Escape (to close) is handled.
  if (!exportModal.classList.contains("hidden")) {
    if (e.key === "Escape") exportModal.classList.add("hidden");
    return;
  }
  // Source monitor: I/O mark in/out on the source, Escape closes.
  if (!sourceModal.classList.contains("hidden")) {
    if (e.key === "Escape") closeSource();
    else if (e.key === "i" || e.key === "I") $<HTMLButtonElement>("srcMarkIn").click();
    else if (e.key === "o" || e.key === "O") $<HTMLButtonElement>("srcMarkOut").click();
    return;
  }
  // Ignore shortcuts while typing in / focused on a form control.
  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
  )
    return;

  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    void saveProject(e.shiftKey); // Ctrl+Shift+S = Save As
    return;
  }
  if (ctrl && (e.key === "o" || e.key === "O")) {
    e.preventDefault();
    void openProjectDialog();
    return;
  }
  if (ctrl && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (ctrl && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    redo();
    return;
  }
  if (ctrl && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    selectAll();
    return;
  }
  if (ctrl && (e.key === "c" || e.key === "C")) {
    e.preventDefault();
    copySelection();
    return;
  }
  if (ctrl && (e.key === "x" || e.key === "X")) {
    e.preventDefault();
    cutSelection();
    return;
  }
  if (ctrl && (e.key === "v" || e.key === "V")) {
    e.preventDefault();
    pasteClipboard();
    return;
  }
  if (ctrl && (e.key === "d" || e.key === "D")) {
    e.preventDefault();
    duplicateSelection();
    return;
  }
  if (ctrl && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    addEditAtPlayhead(); // add edit at playhead
    return;
  }
  if (e.code === "Space") {
    e.preventDefault(); // don't scroll or click a focused button
    togglePlay();
    return;
  }
  // J / K / L shuttle transport.
  if (e.key === "l" || e.key === "L") {
    shuttleForwardKey();
    return;
  }
  if (e.key === "j" || e.key === "J") {
    shuttleReverseKey();
    return;
  }
  if (e.key === "k" || e.key === "K") {
    setShuttle(0);
    if (playing) void togglePlay();
    return;
  }
  if (e.key === "i" || e.key === "I") {
    setInPoint();
    return;
  }
  if (e.key === "o" || e.key === "O") {
    setOutPoint();
    return;
  }
  if (e.key === "s" || e.key === "S") {
    toggleSnap();
    return;
  }
  if (e.key === "=" || e.key === "+") {
    tl.zoomBy(1.25);
    return;
  }
  if (e.key === "-" || e.key === "_") {
    tl.zoomBy(1 / 1.25);
    return;
  }
  if (e.key === "\\") {
    tl.zoomToFit();
    return;
  }
  // Alt + arrows nudge the selected clips (time by frames, or across tracks).
  if (e.altKey && tl.selected.size > 0) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const frames = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 5 : 1);
      nudgeSelection(frames * frameDuration(projectFps), 0);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      nudgeSelection(0, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
  }
  // Frame / edit-point navigation.
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepFrames(e.shiftKey ? -5 : -1);
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepFrames(e.shiftKey ? 5 : 1);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (e.shiftKey) gotoPrevMarker(); // Shift+Up: previous marker
    else gotoEdit(-1);
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (e.shiftKey) gotoNextMarker(); // Shift+Down: next marker
    else gotoEdit(1);
    return;
  }
  if (e.key === "m" || e.key === "M") {
    toggleMarkerAtPlayhead(); // add/remove a marker at the playhead
    return;
  }
  if (e.key === "Home") {
    e.preventDefault();
    seek(0);
    return;
  }
  if (e.key === "End") {
    e.preventDefault();
    seek(timelineDuration(project));
    return;
  }
  if (e.key === "," ) {
    insertAtPlayhead();
    return;
  }
  if (e.key === ".") {
    overwriteAtPlayhead();
    return;
  }
  if ((e.key === "e" || e.key === "E") && e.shiftKey && tl.selected.size > 0) {
    toggleSelectionEnabledSmart(); // Shift+E: enable/disable selected clips
    return;
  }
  if (e.key === "q" || e.key === "Q") {
    rippleTrimToPlayhead("in"); // ripple-trim previous edit to playhead
    return;
  }
  if (e.key === "w" || e.key === "W") {
    rippleTrimToPlayhead("out"); // ripple-trim next edit to playhead
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && tl.selected.size > 0) {
    e.preventDefault();
    if (e.shiftKey) rippleDeleteSelection(); // Shift+Delete = ripple delete
    else deleteSelection();
  } else if (e.key === "c" || e.key === "C") {
    selectTool("razor"); // C = Razor (Premiere)
  } else if (e.key === "r" || e.key === "R") {
    selectTool("rate"); // R = Rate Stretch (Premiere)
  } else if (e.key === "y" || e.key === "Y") {
    selectTool("slip"); // Y = Slip (Premiere)
  } else if (e.key === "u" || e.key === "U") {
    selectTool("slide"); // U = Slide (Premiere)
  } else if (e.key === "v" || e.key === "V") {
    selectTool("select");
  }
});

// ------------------------------------------------------------- markers --
function toggleMarkerAtPlayhead() {
  const tol = Math.max(frameDuration(projectFps), 0.08);
  const existing = markerNear(project, playhead, tol);
  pushHistory();
  project = existing ? removeMarker(project, existing.id) : addMarker(project, playhead);
  tl.project = project;
  tl.draw();
}
function gotoNextMarker() {
  const m = nextMarker(project, playhead);
  if (m) seek(m.time);
}
function gotoPrevMarker() {
  const m = prevMarker(project, playhead);
  if (m) seek(m.time);
}
function clearAllMarkers() {
  if (projectMarkers(project).length === 0) return;
  pushHistory();
  project = clearMarkers(project);
  tl.project = project;
  tl.draw();
}

function selectTool(tool: Tool) {
  tl.tool = tool;
  canvas.style.cursor = tool === "razor" ? "crosshair" : "default";
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tool[data-tool]")) {
    b.classList.toggle("active", b.dataset.tool === tool);
  }
}

// --------------------------------------------------- shared edit helpers --
/** Pushes model changes into the timeline, preview, and derived UI. */
function syncAll() {
  tl.project = project;
  preview.project = project;
  tl.draw();
  updateProjInfo();
  refreshSelectionUI();
  syncPreviewSelection();
  seek(playhead);
}

/** Alt+arrow nudge: shift the selected clips (and their groups) in time/tracks. */
function nudgeSelection(dTime: number, dTrack: number) {
  const ids = new Set<string>();
  for (const id of tl.selected) for (const m of groupMembers(project, id)) ids.add(m);
  if (ids.size === 0) return;
  const hasVideo = [...tl.selected].some((id) => findClipById(id)?.kind === "video");
  const kind = hasVideo ? "video" : "audio";
  pushHistory();
  project = moveClipsLayered(project, [...ids], dTime, dTrack, kind);
  tl.project = project;
  tl.resize(wrap.clientWidth, wrap.clientHeight); // may have added audio tracks
  syncAll();
}

/** Enable/disable every selected clip (and its linked group). */
function toggleSelectionEnabled(enabled: boolean) {
  if (tl.selected.size === 0) return;
  const ids = new Set<string>();
  for (const id of tl.selected) for (const m of groupMembers(project, id)) ids.add(m);
  pushHistory();
  project = setClipsEnabled(project, [...ids], enabled);
  tl.project = project;
  preview.project = project;
  tl.draw();
  preview.render();
}

/** Shift+E toggles enable on the selection based on the first clip's state. */
function toggleSelectionEnabledSmart() {
  const first = [...tl.selected][0];
  if (!first) return;
  const clip = findClipById(first);
  if (clip) toggleSelectionEnabled(!clipEnabled(clip));
}

/** Link-aware delete of the current selection (each clip's whole group). */
function deleteSelection() {
  if (tl.selected.size === 0) return;
  pushHistory();
  const ids = new Set<string>();
  for (const id of tl.selected) for (const m of groupMembers(project, id)) ids.add(m);
  project = removeClips(project, [...ids]);
  tl.selected.clear();
  syncAll();
}

function splitGroupAt(clip: Clip, time: number) {
  pushHistory();
  project = splitAt(project, time, groupMembers(project, clip.id));
  syncAll();
}

/** Uniform scale so the clip's media covers the whole canvas (no letterbox). */
function fillCanvas(clip: Clip) {
  const media = project.media.find((m) => m.id === clip.mediaId);
  const mw = media?.width || canvasW;
  const mh = media?.height || canvasH;
  const baseFit = Math.min(canvasW / mw, canvasH / mh);
  const f = Math.max(canvasW / (mw * baseFit), canvasH / (mh * baseFit));
  commitTransform({ scaleX: f, scaleY: f });
}

function doRemoveTrack(track: Track) {
  pushHistory();
  project = removeTrack(project, track.id);
  tl.project = project;
  tl.resize(wrap.clientWidth, wrap.clientHeight);
  syncAll();
}

// ------------------------------------------------------- context menu --
const ctxMenu = $<HTMLDivElement>("ctxMenu");
let ctxAt = { x: 0, y: 0, time: 0 };

interface CtxItem {
  label?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

function hideContextMenu() {
  ctxMenu.classList.add("hidden");
  ctxMenu.innerHTML = "";
}

function positionMenu(clientX: number, clientY: number) {
  const w = ctxMenu.offsetWidth;
  const h = ctxMenu.offsetHeight;
  const x = Math.min(clientX, window.innerWidth - w - 4);
  const y = Math.min(clientY, window.innerHeight - h - 4);
  ctxMenu.style.left = `${Math.max(4, x)}px`;
  ctxMenu.style.top = `${Math.max(4, y)}px`;
}

function showContextMenu(clientX: number, clientY: number, items: CtxItem[]) {
  if (items.length === 0) return;
  ctxMenu.innerHTML = "";
  for (const it of items) {
    if (it.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-sep";
      ctxMenu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.className = "ctx-item";
    btn.textContent = it.label ?? "";
    if (it.disabled) btn.disabled = true;
    else
      btn.addEventListener("click", (e) => {
        // Stop the global window-click handler from also firing: an action may
        // reopen the popover (e.g. the rename inline prompt), and the bubbled
        // click would otherwise immediately hide it.
        e.stopPropagation();
        hideContextMenu();
        it.action?.();
      });
    ctxMenu.appendChild(btn);
  }
  ctxMenu.classList.remove("hidden");
  positionMenu(clientX, clientY);
}

/** Inline single-field prompt reusing the context-menu popover (Tauri-safe; no window.prompt). */
function showInlinePrompt(
  clientX: number,
  clientY: number,
  initial: string,
  placeholder: string,
  onSubmit: (value: string) => void,
) {
  ctxMenu.innerHTML = "";
  const inp = document.createElement("input");
  inp.className = "ctx-input";
  inp.value = initial;
  inp.placeholder = placeholder;
  ctxMenu.appendChild(inp);
  ctxMenu.classList.remove("hidden");
  positionMenu(clientX, clientY);
  inp.focus();
  inp.select();
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const v = inp.value;
      hideContextMenu();
      onSubmit(v);
    } else if (e.key === "Escape") {
      hideContextMenu();
    }
  });
}

window.addEventListener("click", (e) => {
  if (ctxMenu.contains(e.target as Node)) return; // keep it open while interacting
  hideContextMenu();
});
window.addEventListener("blur", () => hideContextMenu());

function selectClipForMenu(clip: Clip) {
  if (!tl.selected.has(clip.id)) {
    tl.selected.clear();
    tl.selected.add(clip.id);
    tl.draw();
    refreshSelectionUI();
    syncPreviewSelection();
  }
}

const RESET_TRANSFORM: Partial<Transform> = { x: 0.5, y: 0.5, scaleX: 1, scaleY: 1, rotation: 0 };

function transformMenuItems(clip: Clip): CtxItem[] {
  return [
    { label: "Reset transform", action: () => commitTransform(RESET_TRANSFORM) },
    { label: "Center", action: () => commitTransform({ x: 0.5, y: 0.5 }) },
    { label: "Fit to canvas", action: () => commitTransform({ scaleX: 1, scaleY: 1 }) },
    { label: "Fill canvas", action: () => fillCanvas(clip) },
  ];
}

function clipMenu(clip: Clip): CtxItem[] {
  selectClipForMenu(clip);
  const grouped = groupMembers(project, clip.id).length > 1;
  const onClip = playhead > clip.start && playhead < clipEnd(clip);
  const items: CtxItem[] = [
    { label: "Split at playhead", disabled: !onClip, action: () => splitGroupAt(clip, playhead) },
    { label: "Split here", action: () => splitGroupAt(clip, ctxAt.time) },
    { separator: true },
    { label: tl.selected.size > 1 ? "Delete clips" : "Delete clip", action: deleteSelection },
  ];
  if (tl.selected.size >= 2) items.push({ label: "Link selected", action: doLink });
  if (grouped) items.push({ label: "Unlink", action: doUnlink });
  // Enable/Disable reflects the clicked clip; applies to the whole selection.
  items.push({
    label: clipEnabled(clip) ? "Disable" : "Enable",
    action: () => toggleSelectionEnabled(!clipEnabled(clip)),
  });
  if (clip.kind === "video") {
    const tItems = transitionMenuItems(clip, ctxAt.time);
    if (tItems.length) items.push({ separator: true }, ...tItems);
    items.push({ separator: true }, ...transformMenuItems(clip));
  }
  return items;
}

const DEFAULT_TRANSITION_DUR = 1.0; // seconds

/** The clip on the same track that abuts `clip` at the given edge, if any. */
function abutting(clip: Clip, edge: "in" | "out"): Clip | undefined {
  const track = project.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  if (!track) return undefined;
  const eps = 1e-3;
  if (edge === "out") {
    const t = clipEnd(clip);
    return track.clips.find((c) => c.id !== clip.id && Math.abs(c.start - t) < eps);
  }
  return track.clips.find((c) => c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < eps);
}

/**
 * Context-menu items for the cut nearest the click: a cross-dissolve or dip lives
 * on the LEFT clip's out-edge, so we resolve which clip owns the boundary.
 */
function transitionMenuItems(clip: Clip, atTime: number): CtxItem[] {
  // Decide which cut of this clip the click is nearest, and find its partner.
  const mid = (clip.start + clipEnd(clip)) / 2;
  const preferOut = atTime >= mid;
  let leftClip: Clip | undefined;
  let rightClip: Clip | undefined;
  if (preferOut && abutting(clip, "out")) {
    leftClip = clip;
    rightClip = abutting(clip, "out");
  } else if (abutting(clip, "in")) {
    leftClip = abutting(clip, "in");
    rightClip = clip;
  } else if (abutting(clip, "out")) {
    leftClip = clip;
    rightClip = abutting(clip, "out");
  }
  if (!leftClip || !rightClip) return []; // no adjacent clip to transition with
  const owner = leftClip; // transition is stored on the left clip's out-edge
  const has = !!owner.transitionOut;
  const dur = Math.min(
    DEFAULT_TRANSITION_DUR,
    0.9 * clipDuration(leftClip),
    0.9 * clipDuration(rightClip),
  );
  const items: CtxItem[] = [
    { label: "Cross dissolve", action: () => applyTransition(owner.id, "dissolve", dur) },
    { label: "Dip to black", action: () => applyTransition(owner.id, "dip-black", dur) },
    { label: "Push", action: () => applyTransition(owner.id, "push", dur) },
    { label: "Slide", action: () => applyTransition(owner.id, "slide", dur) },
  ];
  if (has) items.push({ label: "Remove transition", action: () => applyTransition(owner.id, null, 0) });
  return items;
}

function applyTransition(clipId: string, kind: TransitionKind | null, dur: number) {
  pushHistory();
  project = setClipTransition(project, clipId, kind ? { kind, duration: dur } : null);
  tl.project = project;
  preview.project = project;
  tl.draw();
  preview.render();
}

function trackHeaderMenu(track: Track): CtxItem[] {
  const videoCount = project.tracks.filter((t) => t.kind === "video").length;
  const canDelete = track.kind === "video" ? videoCount > 1 : true;
  return [
    {
      label: "Rename track…",
      action: () =>
        showInlinePrompt(ctxAt.x, ctxAt.y, track.label ?? "", "Track name", (name) => {
          pushHistory();
          project = setTrackLabel(project, track.id, name);
          tl.project = project;
          tl.draw();
        }),
    },
    { separator: true },
    { label: "Add video track", action: doAddVideoTrack },
    { label: "Add audio track", action: doAddAudioTrack },
    { separator: true },
    { label: "Delete track", disabled: !canDelete, action: () => doRemoveTrack(track) },
  ];
}

function emptyTimelineMenu(): CtxItem[] {
  const items: CtxItem[] = [
    { label: "Add marker at playhead", action: toggleMarkerAtPlayhead },
  ];
  if (projectMarkers(project).length) {
    items.push({ label: "Clear all markers", action: clearAllMarkers });
  }
  items.push(
    { separator: true },
    { label: "Add video track", action: doAddVideoTrack },
    { label: "Add audio track", action: doAddAudioTrack },
    { separator: true },
    { label: "Fit to window", action: () => tl.zoomToFit() },
  );
  return items;
}

function previewMenu(): CtxItem[] {
  const id = selectedTransformClip();
  if (!id) return [{ label: "Select a video clip to transform", disabled: true }];
  const clip = findClipById(id)!;
  return transformMenuItems(clip);
}

document.addEventListener("contextmenu", (e) => {
  e.preventDefault(); // replace the browser menu everywhere in the app
  ctxAt = { x: e.clientX, y: e.clientY, time: tl.timeAtClient(e.clientX) };
  const target = e.target as HTMLElement;
  let items: CtxItem[] = [];
  if (target === canvas) {
    const header = tl.trackHeaderAt(e.clientX, e.clientY);
    const clip = tl.clipAtClient(e.clientX, e.clientY);
    if (header) items = trackHeaderMenu(header);
    else if (clip) items = clipMenu(clip);
    else items = emptyTimelineMenu();
  } else if (target === previewCanvas) {
    items = previewMenu();
  }
  showContextMenu(e.clientX, e.clientY, items);
});

// ------------------------------------------ drag media -> timeline (Premiere) --
function mediaLabel(id: string): string {
  const m = project.media.find((mm) => mm.id === id);
  if (!m) return "clip";
  return m.isText ? m.text?.content.split("\n")[0] || "Text" : m.name;
}

function overTimeline(e: PointerEvent): boolean {
  const r = canvas.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

function onMediaDrop(mediaId: string, clientX: number, clientY: number) {
  const info = tl.dropInfoAt(clientX, clientY);
  const media = project.media.find((m) => m.id === mediaId);
  if (!info || !media) return;
  pushHistory();
  ensureVideoTrack();
  ensureAudioTracks(media.audioStreamCount);
  // Dropping on a video row targets that layer; audio media fill audio tracks.
  const targetVideoId = info.kind === "video" ? info.trackId : undefined;
  project = placeMedia(project, mediaId, info.time, targetVideoId);
  exportBtn.disabled = timelineDuration(project) <= 0;
  playBtn.disabled = false;
  tl.resize(wrap.clientWidth, wrap.clientHeight);
  syncAll();
}

let mediaDrag: { id: string; ghost: HTMLElement } | null = null;
let lastMediaClick: { id: string; t: number } | null = null;
mediaListEl.addEventListener("pointerdown", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>(".media-item");
  const id = item?.dataset.mediaId;
  if (!id) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const move = (ev: PointerEvent) => {
    if (!mediaDrag) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = mediaLabel(id);
      document.body.appendChild(ghost);
      mediaDrag = { id, ghost };
    }
    mediaDrag.ghost.style.left = `${ev.clientX + 12}px`;
    mediaDrag.ghost.style.top = `${ev.clientY + 12}px`;
    if (overTimeline(ev)) tl.setDropTarget(ev.clientX, ev.clientY);
    else tl.clearDropTarget();
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!mediaDrag) {
      // Detect a double-click manually: refreshMediaList() rebuilds the DOM on
      // each selection, so a native `dblclick` never fires (its two clicks land
      // on different elements). Two clicks on the same media open the Source.
      const now = performance.now();
      if (lastMediaClick && lastMediaClick.id === id && now - lastMediaClick.t < 400) {
        lastMediaClick = null;
        openSource(id);
        return;
      }
      lastMediaClick = { id, t: now };
      selectedMediaId = id; // a click (no drag) selects the source media
      refreshMediaList();
      return;
    }
    mediaDrag.ghost.remove();
    const over = overTimeline(ev);
    const dropId = mediaDrag.id;
    mediaDrag = null;
    tl.clearDropTarget();
    if (over) onMediaDrop(dropId, ev.clientX, ev.clientY);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

// -------------------------------------------------- transport / editing --
const snapBtn = $<HTMLButtonElement>("snapBtn");
function toggleSnap() {
  tl.snapEnabled = !tl.snapEnabled;
  snapBtn.classList.toggle("active", tl.snapEnabled);
}
snapBtn.addEventListener("click", toggleSnap);

function setInPoint() {
  tl.inPoint = playhead;
  if (tl.outPoint !== null && tl.outPoint <= playhead) tl.outPoint = null;
  tl.draw();
}
function setOutPoint() {
  tl.outPoint = playhead;
  if (tl.inPoint !== null && tl.inPoint >= playhead) tl.inPoint = null;
  tl.draw();
}
function clearInOut() {
  tl.inPoint = null;
  tl.outPoint = null;
  tl.draw();
}
$<HTMLButtonElement>("markInBtn").addEventListener("click", setInPoint);
$<HTMLButtonElement>("markOutBtn").addEventListener("click", setOutPoint);
$<HTMLButtonElement>("clearInOutBtn").addEventListener("click", clearInOut);
$<HTMLButtonElement>("markerBtn").addEventListener("click", toggleMarkerAtPlayhead);

function selectAll() {
  tl.selected = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  tl.draw();
  refreshSelectionUI();
  syncPreviewSelection();
}

/** Adds an edit (razor) at the playhead across every clip it spans. */
function addEditAtPlayhead() {
  const spanning: string[] = [];
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (playhead > c.start && playhead < clipEnd(c)) spanning.push(c.id);
    }
  }
  if (spanning.length === 0) return;
  pushHistory();
  project = splitAt(project, playhead, spanning);
  syncAll();
}

// Clip clipboard (deep copies + originating track ids), pasted at the playhead.
let clipboard: { clips: Clip[]; trackIds: string[]; minStart: number } | null = null;
function copySelection() {
  if (tl.selected.size === 0) return;
  const ids = new Set<string>();
  for (const id of tl.selected) for (const m of groupMembers(project, id)) ids.add(m);
  const clips: Clip[] = [];
  const trackIds: string[] = [];
  let minStart = Infinity;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (!ids.has(c.id)) continue;
      clips.push(structuredClone(c));
      trackIds.push(t.id);
      minStart = Math.min(minStart, c.start);
    }
  }
  if (clips.length) clipboard = { clips, trackIds, minStart };
}
function pasteClipboard() {
  if (!clipboard) return;
  pushHistory();
  const offset = playhead - clipboard.minStart;
  const groupMap = new Map<string, string>();
  const next = structuredClone(project);
  const byId = new Map(next.tracks.map((t) => [t.id, t] as const));
  const pasted = new Set<string>();
  clipboard.clips.forEach((c, i) => {
    const track = byId.get(clipboard!.trackIds[i]) ?? next.tracks.find((t) => t.kind === c.kind);
    if (!track) return;
    let gid = c.groupId;
    if (gid !== null) {
      if (!groupMap.has(gid)) groupMap.set(gid, newId("grp"));
      gid = groupMap.get(gid)!;
    }
    const id = newId("clip");
    track.clips.push({
      ...structuredClone(c),
      id,
      start: Math.max(0, c.start + offset),
      groupId: gid,
    });
    pasted.add(id);
  });
  for (const t of next.tracks) t.clips.sort((a, b) => a.start - b.start);
  project = next;
  tl.selected = pasted; // select the pasted clips
  syncAll();
}
function cutSelection() {
  copySelection();
  deleteSelection();
}

/** Ctrl+D: duplicate the selected clips, placing copies right after them. */
function duplicateSelection() {
  if (tl.selected.size === 0) return;
  const ids = new Set<string>();
  for (const id of tl.selected) for (const m of groupMembers(project, id)) ids.add(m);
  const sel: { clip: Clip; trackId: string }[] = [];
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (!ids.has(c.id)) continue;
      sel.push({ clip: c, trackId: t.id });
      minStart = Math.min(minStart, c.start);
      maxEnd = Math.max(maxEnd, clipEnd(c));
    }
  }
  if (sel.length === 0) return;
  const offset = maxEnd - minStart; // copies land immediately after the selection
  pushHistory();
  const next = structuredClone(project);
  const byId = new Map(next.tracks.map((t) => [t.id, t] as const));
  const groupMap = new Map<string, string>();
  const dup = new Set<string>();
  for (const { clip, trackId } of sel) {
    const track = byId.get(trackId);
    if (!track) continue;
    let gid = clip.groupId;
    if (gid !== null) {
      if (!groupMap.has(gid)) groupMap.set(gid, newId("grp"));
      gid = groupMap.get(gid)!;
    }
    const id = newId("clip");
    track.clips.push({ ...structuredClone(clip), id, start: clip.start + offset, groupId: gid });
    dup.add(id);
  }
  for (const t of next.tracks) t.clips.sort((a, b) => a.start - b.start);
  project = next;
  tl.selected = dup;
  syncAll();
}

/** Ripple-delete: remove the selection and close the gap (Shift+Delete). */
function rippleDeleteSelection() {
  if (tl.selected.size === 0) return;
  pushHistory();
  project = rippleDelete(project, [...tl.selected]);
  tl.selected.clear();
  syncAll();
}

/** The clip to ripple-trim: a selected span, else topmost video, else any. */
function clipForTrim(): Clip | undefined {
  const spans = (c: Clip) => playhead > c.start + 1e-4 && playhead < clipEnd(c) - 1e-4;
  for (const id of tl.selected) {
    const c = findClipById(id);
    if (c && spans(c)) return c;
  }
  for (const kind of ["video", "audio"] as const) {
    for (const t of project.tracks) {
      if (t.kind !== kind) continue;
      const c = t.clips.find(spans);
      if (c) return c;
    }
  }
  return undefined;
}

/**
 * Ripple-trim to the playhead (Premiere Q/W): "out" trims the clip's tail to the
 * playhead and pulls the rest left; "in" trims its head and closes the gap. Runs
 * on the clip's linked group so A/V stay in sync.
 */
function rippleTrimToPlayhead(side: "in" | "out") {
  const clip = clipForTrim();
  if (!clip) return;
  const spanning = groupMembers(project, clip.id).filter((id) => {
    const c = findClipById(id)!;
    return playhead > c.start + 1e-4 && playhead < clipEnd(c) - 1e-4;
  });
  if (spanning.length === 0) return;
  pushHistory();
  const before = new Set<string>();
  for (const t of project.tracks) for (const c of t.clips) before.add(c.id);
  project = splitAt(project, playhead, spanning);
  if (side === "out") {
    // Remove the freshly-created right-hand pieces (everything after the playhead).
    const rightIds: string[] = [];
    for (const t of project.tracks) for (const c of t.clips) if (!before.has(c.id)) rightIds.push(c.id);
    project = rippleDelete(project, rightIds);
  } else {
    // Remove the left pieces (the originals, now ending at the playhead).
    project = rippleDelete(project, spanning);
  }
  tl.selected.clear();
  syncAll();
}

// The edit-target video track for Insert/Overwrite/paste (null = topmost).
let targetVideoTrackId: string | null = null;
function setTargetTrack(trackId: string) {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.kind !== "video") return; // only video tracks are targetable
  targetVideoTrackId = targetVideoTrackId === trackId ? null : trackId;
  tl.targetTracks.clear();
  if (targetVideoTrackId) tl.targetTracks.add(targetVideoTrackId);
  tl.draw();
}
/** The target video track id if it still exists, else undefined (topmost). */
function targetVideoId(): string | undefined {
  if (targetVideoTrackId && project.tracks.some((t) => t.id === targetVideoTrackId)) {
    return targetVideoTrackId;
  }
  return undefined;
}

/** Insert (,) the selected media at the playhead, rippling the sequence open. */
function insertAtPlayhead() {
  const media = selectedMediaId && project.media.find((m) => m.id === selectedMediaId);
  if (!media) return;
  pushHistory();
  ensureVideoTrack();
  ensureAudioTracks(media.audioStreamCount);
  project = insertMediaAt(project, media.id, playhead, targetVideoId());
  syncAll();
}

/** Overwrite (.) the selected media at the playhead, carving out what's under it. */
function overwriteAtPlayhead() {
  const media = selectedMediaId && project.media.find((m) => m.id === selectedMediaId);
  if (!media) return;
  pushHistory();
  ensureVideoTrack();
  ensureAudioTracks(media.audioStreamCount);
  project = overwriteMediaAt(project, media.id, playhead, targetVideoId());
  syncAll();
}

// ------------------------------------------------------- source monitor --
const sourceModal = $<HTMLDivElement>("sourceModal");
const srcVideo = $<HTMLVideoElement>("srcVideo");
const srcImage = $<HTMLImageElement>("srcImage");
const srcName = $<HTMLSpanElement>("srcName");
const srcRangeEl = $<HTMLDivElement>("srcRange");
let srcMediaId: string | null = null;
let srcIn = 0;
let srcOut = 0;

/** Opens a media in the Source monitor to preview and mark In/Out before editing. */
function openSource(mediaId: string) {
  const media = project.media.find((m) => m.id === mediaId);
  if (!media) return;
  srcMediaId = mediaId;
  srcName.textContent = media.name;
  const url = assetUrl(media.path);
  const isImg = !!media.isImage;
  srcVideo.hidden = isImg;
  srcImage.hidden = !isImg;
  if (isImg) {
    srcImage.src = url;
  } else {
    srcVideo.src = url;
    srcVideo.currentTime = 0;
  }
  srcIn = 0;
  srcOut = media.duration;
  updateSrcRange();
  sourceModal.classList.remove("hidden");
}

function closeSource() {
  sourceModal.classList.add("hidden");
  srcVideo.pause();
  srcVideo.removeAttribute("src");
  srcVideo.load();
  srcImage.removeAttribute("src");
  srcMediaId = null;
}

/** The marked sub-range, or undefined when it's the whole (untrimmed) clip. */
function currentSourceRange(): SourceRange | undefined {
  const media = srcMediaId ? project.media.find((m) => m.id === srcMediaId) : undefined;
  if (!media || media.isImage) return undefined;
  if (srcIn <= 1e-3 && srcOut >= media.duration - 1e-3) return undefined;
  return { in: srcIn, out: srcOut };
}

function updateSrcRange() {
  const media = srcMediaId ? project.media.find((m) => m.id === srcMediaId) : undefined;
  if (!media) return;
  if (media.isImage) {
    srcRangeEl.textContent = `Image${media.width ? ` · ${media.width}×${media.height}` : ""}`;
    return;
  }
  const len = Math.max(0, srcOut - srcIn);
  srcRangeEl.textContent =
    `In ${secondsToTimecode(srcIn, projectFps)}   ` +
    `Out ${secondsToTimecode(srcOut, projectFps)}   ·   ` +
    `Duration ${secondsToTimecode(len, projectFps)}`;
}

function placeFromSource(mode: "insert" | "overwrite" | "append") {
  const media = srcMediaId ? project.media.find((m) => m.id === srcMediaId) : undefined;
  if (!media) return;
  const range = currentSourceRange();
  pushHistory();
  ensureVideoTrack();
  ensureAudioTracks(media.audioStreamCount);
  const vid = targetVideoId();
  if (mode === "append") {
    project = placeMedia(project, media.id, timelineDuration(project), vid, range);
  } else if (mode === "insert") {
    project = insertMediaAt(project, media.id, playhead, vid, range);
  } else {
    project = overwriteMediaAt(project, media.id, playhead, vid, range);
  }
  exportBtn.disabled = timelineDuration(project) <= 0;
  playBtn.disabled = timelineDuration(project) <= 0;
  closeSource();
  syncAll();
}

$<HTMLButtonElement>("srcMarkIn").addEventListener("click", () => {
  srcIn = Math.min(srcVideo.currentTime, srcOut - frameDuration(projectFps));
  srcIn = Math.max(0, srcIn);
  updateSrcRange();
});
$<HTMLButtonElement>("srcMarkOut").addEventListener("click", () => {
  srcOut = Math.max(srcVideo.currentTime, srcIn + frameDuration(projectFps));
  updateSrcRange();
});
$<HTMLButtonElement>("srcClearRange").addEventListener("click", () => {
  const media = srcMediaId ? project.media.find((m) => m.id === srcMediaId) : undefined;
  srcIn = 0;
  srcOut = media?.duration ?? 0;
  updateSrcRange();
});
$<HTMLButtonElement>("srcInsert").addEventListener("click", () => placeFromSource("insert"));
$<HTMLButtonElement>("srcOverwrite").addEventListener("click", () => placeFromSource("overwrite"));
$<HTMLButtonElement>("srcAppend").addEventListener("click", () => placeFromSource("append"));
$<HTMLButtonElement>("srcClose").addEventListener("click", closeSource);
sourceModal.addEventListener("click", (e) => {
  if (e.target === sourceModal) closeSource();
});

// -------------------------------------------------------- project files --
const PROJECT_EXT = "cutline";
const LEGACY_PROJECT_EXT = "qve"; // still openable so older projects aren't orphaned
const RECENT_KEY = "cutline.recentProjects";
const AUTOSAVE_NAME = "autosave.cutline.json";
let currentProjectPath: string | null = null;

interface ProjectFile {
  version: number;
  project: Project;
  canvasW: number;
  canvasH: number;
  fps: number;
}

function serializeProject(): string {
  const data: ProjectFile = { version: 1, project, canvasW, canvasH, fps: projectFps };
  return JSON.stringify(data);
}

function updateTitle() {
  const name = currentProjectPath
    ? (currentProjectPath.split(/[\\/]/).pop() ?? "Untitled")
    : "Untitled";
  document.title = `Cutline — ${name}`;
}

function getRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}
function addRecent(path: string) {
  const list = [path, ...getRecent().filter((p) => p !== path)].slice(0, 10);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  if (project.media.length === 0) refreshMediaList();
}

async function saveProject(saveAs = false) {
  let path = !saveAs && currentProjectPath ? currentProjectPath : null;
  if (!path) {
    path = await save({
      defaultPath: currentProjectPath ?? `project.${PROJECT_EXT}`,
      filters: [{ name: "Cutline Project", extensions: [PROJECT_EXT] }],
    });
  }
  if (!path) return;
  try {
    await invoke("write_text_file", { path, contents: serializeProject() });
    currentProjectPath = path;
    addRecent(path);
    updateTitle();
  } catch (e) {
    await message(`Could not save: ${e}`, { title: "Save failed", kind: "error" });
  }
}

async function openProjectDialog() {
  const path = await open({
    multiple: false,
    filters: [{ name: "Cutline Project", extensions: [PROJECT_EXT, LEGACY_PROJECT_EXT] }],
  });
  if (typeof path === "string") await openProjectPath(path);
}

async function openProjectPath(path: string) {
  try {
    const contents = await invoke<string>("read_text_file", { path });
    loadProjectData(JSON.parse(contents) as ProjectFile);
    currentProjectPath = path;
    addRecent(path);
    updateTitle();
  } catch (e) {
    await message(`Could not open project: ${e}`, { title: "Open failed", kind: "error" });
  }
}

function loadProjectData(data: ProjectFile) {
  if (playing) void togglePlay();
  project = data.project;
  canvasAutoAdopt = false;
  canvasW = data.canvasW || 1920;
  canvasH = data.canvasH || 1080;
  projectFps = data.fps || 30;
  tl.fps = projectFps;
  undoStack.length = 0;
  redoStack.length = 0;
  tl.selected.clear();
  tl.project = project;
  preview.project = project;
  tl.waveforms.clear();
  tl.thumbnails.clear();
  for (const m of project.media) {
    hydrateMediaAudio(m); // re-extract waveforms/audio
    hydrateMediaThumbnails(m);
  }
  refreshMediaList();
  updateProjInfo();
  applyCanvasSize(canvasW, canvasH);
  tl.resize(wrap.clientWidth, wrap.clientHeight);
  tl.zoomToFit();
  refreshSelectionUI();
  syncPreviewSelection();
  exportBtn.disabled = timelineDuration(project) <= 0;
  playBtn.disabled = timelineDuration(project) <= 0;
  seek(0);
}

$<HTMLButtonElement>("openBtn").addEventListener("click", () => void openProjectDialog());
$<HTMLButtonElement>("saveBtn").addEventListener("click", () => void saveProject());

// Autosave to a temp file every 20s; recovered on next launch if the app closed
// without saving.
async function autosave() {
  try {
    const bytes = new TextEncoder().encode(serializeProject());
    await invoke("write_temp_file", { name: AUTOSAVE_NAME, data: Array.from(bytes) });
  } catch {
    /* best-effort */
  }
}
setInterval(() => {
  if (project.media.length) void autosave();
}, 20000);

async function checkAutosaveRecovery() {
  // Only offer recovery once per app launch. sessionStorage survives page
  // reloads (and dev HMR updates) but resets when the window closes, so we
  // don't re-prompt on every code change during development.
  if (sessionStorage.getItem("autosavePrompted")) return;
  sessionStorage.setItem("autosavePrompted", "1");
  try {
    const p = await join(await tempDir(), "cutline", AUTOSAVE_NAME);
    const contents = await invoke<string>("read_text_file", { path: p });
    const data = JSON.parse(contents) as ProjectFile;
    if (!data.project?.media?.length) return;
    const ok = await confirm("Recover the autosaved project from your last session?", {
      title: "Recover project",
    });
    if (ok) loadProjectData(data);
  } catch {
    /* no autosave present */
  }
}
void checkAutosaveRecovery();

refreshMediaList();
updateProjInfo();
updateTitle();
requestAnimationFrame(tick);

// Quietly check for a new release on launch (no-op in dev / when unreachable).
setTimeout(() => void runUpdateCheck({ silent: true }), 3000);
