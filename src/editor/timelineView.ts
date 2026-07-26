/**
 * The stacked, Premiere-style timeline: a time ruler, one lane per track
 * (video on top, audio below), clips drawn as blocks with waveforms, a
 * playhead, and horizontal zoom/scroll. This turn it renders the model and
 * handles seek/select/zoom/scroll; the razor and drag tools land next.
 */
import {
  type Project,
  type Clip,
  type Track,
  type TrackKind,
  clipDuration,
  clipEnd,
  clipGain,
  clipFadeIn,
  clipFadeOut,
  clipSpeed,
  clipReversed,
  isGainAnimated,
  ANIM_PROPS,
  effectKeyframeTimes,
  MAX_GAIN,
  timelineDuration,
  groupMembers,
} from "../core/project.ts";
import { sampleEnvelope, type PeakEnvelope } from "../core/waveform.ts";
import { secondsToTimestamp } from "../core/format.ts";

const HEADER_W = 128; // track-header gutter
const RULER_H = 26;
const V_TRACK_H = 72;
const A_TRACK_H = 56;
const TRACK_GAP = 2;

export type WaveformCache = Map<string, PeakEnvelope>; // key: `${mediaId}:${stream}`
/** Filmstrip thumbnails per media id, each tagged with its source timestamp. */
export type ThumbCache = Map<string, { img: HTMLImageElement; t: number }[]>;

export interface TimelineCallbacks {
  onSeek: (t: number) => void;
  onSelectClip: (clipId: string | null, additive: boolean) => void;
  onSelectionChanged: () => void; // after a marquee changes `selected` directly
  onSetTarget?: (trackId: string) => void; // header click sets the edit-target track
  onRazor: (time: number, clipId: string) => void;
  onMoveClips: (
    clipIds: string[],
    deltaTime: number,
    deltaTrack: number,
    kind: TrackKind,
  ) => void;
  onTrimEdge: (clipId: string, edge: "in" | "out", time: number) => void;
  onTrimBegin: () => void;
  onTrimEnd: () => void;
  onRateStretch?: (clipId: string, edge: "in" | "out", time: number) => void;
  onSlip?: (clipId: string, dSourceSeconds: number) => void;
  onSlide?: (clipId: string, dTimeSeconds: number) => void;
  onGainBegin: () => void;
  onGainDrag: (clipId: string, gain: number) => void;
  onGainEnd: () => void;
  onGainKeyframe: (clipId: string, localT: number, gain: number) => void;
  onGainKeyframeMove: (clipId: string, fromT: number, toT: number, gain: number) => void;
  onGainKeyframeRemove: (clipId: string, localT: number) => void;
  onFadeBegin: () => void;
  onFadeDrag: (clipId: string, edge: "in" | "out", dur: number) => void;
  onFadeEnd: () => void;
  onToggleTrack: (trackId: string, prop: "muted" | "solo" | "locked" | "hidden") => void;
  onTrackResizeBegin: () => void;
  onTrackResize: (trackId: string, height: number) => void;
  onTrackResizeEnd: () => void;
}

export type Tool = "select" | "razor" | "rate" | "slip" | "slide";

const SNAP_PX = 8;
const DRAG_START_PX = 3;
const EDGE_PX = 6;
const HDR_BTN = 16; // track-header toggle button size
const RESIZE_GRAB = 5; // px hotspot at a lane's bottom edge for height resizing
const MIN_TRACK_H = 34;
const MAX_TRACK_H = 400;

interface HeaderButton {
  prop: "muted" | "solo" | "locked" | "hidden";
  label: string;
  on: boolean;
  x: number;
  y: number;
}
const GAIN_PAD = 9; // vertical inset of the volume rubber-band within a clip
const GAIN_GRAB_PX = 5;
const FADE_BAND = 22; // top band of a clip where fade handles live
const FADE_GRAB = 16; // horizontal grab tolerance around a fade knob
const FADE_KNOB_R = 5; // fade knob radius

interface DragState {
  set: Set<string>;
  kind: TrackKind;
  startX: number;
  startY: number;
  deltaTime: number;
  deltaTrack: number;
  moved: boolean;
}

export interface Viewport {
  pxPerSec: number;
  scrollSec: number; // leftmost visible second
}

const COLORS = {
  bg: "#14171c",
  lane: "#181c22",
  laneAlt: "#1b1f26",
  header: "#1d2129",
  ruler: "#1d2129",
  rulerText: "#9aa4b0",
  gridline: "#2b313a",
  videoClip: "#2f5d8a",
  videoClipSel: "#4a86c5",
  imageClip: "#6a4a8a",
  imageClipSel: "#9066c5",
  textClip: "#8a6a2f",
  textClipSel: "#c59a4a",
  audioClip: "#2e6b4f",
  audioClipSel: "#3f9b70",
  clipBorder: "#0b0d10",
  wave: "rgba(255,255,255,0.55)",
  playhead: "#e74c3c",
  text: "#d8dee9",
};

export class TimelineView {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  project: Project | null = null;
  waveforms: WaveformCache = new Map();
  thumbnails: ThumbCache = new Map();
  selected = new Set<string>();
  targetTracks = new Set<string>(); // edit-target tracks (Insert/Overwrite destination)
  playhead = 0;
  view: Viewport = { pxPerSec: 40, scrollSec: 0 };
  tool: Tool = "select";
  fps = 30; // sequence frame rate, for frame-accurate edits
  snapEnabled = true; // persistent snap toggle (S); Alt still overrides per-drag
  inPoint: number | null = null; // sequence In/Out range (I / O), for export
  outPoint: number | null = null;
  private drag: DragState | null = null;
  private scrubbing = false;
  private trimming: { clipId: string; edge: "in" | "out"; rate?: boolean } | null = null;
  private slipping: { clipId: string; kind: "slip" | "slide"; startX: number } | null = null;
  private gaining: { clipId: string } | null = null;
  private gainPt: { clipId: string; curT: number } | null = null; // dragging a gain keyframe
  private fading: { clipId: string; edge: "in" | "out" } | null = null;
  private trackResize: { trackId: string; startY: number; startH: number } | null = null;
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private marqueeState: { startX: number; startY: number; additive: boolean; base: Set<string>; moved: boolean } | null = null;
  private scrollY = 0; // vertical scroll of the track stack
  private linkedHighlight = new Set<string>(); // group-mates of the selection
  private snapGuide: number | null = null; // timeline time of an active snap guide
  private dropPreview: { trackId: string; time: number } | null = null; // media drag-in

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: TimelineCallbacks,
  ) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onHover(e));
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
  }

  resize(cssW: number, cssH: number) {
    const dpr = window.devicePixelRatio || 1;
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clampScrollY();
    this.draw();
  }

  // ---- coordinate helpers ----
  private timeToX(t: number): number {
    return HEADER_W + (t - this.view.scrollSec) * this.view.pxPerSec;
  }
  private xToTime(x: number): number {
    return this.view.scrollSec + (x - HEADER_W) / this.view.pxPerSec;
  }
  private trackLayout(): { track: Project["tracks"][number]; y: number; h: number }[] {
    const rows: { track: Project["tracks"][number]; y: number; h: number }[] = [];
    if (!this.project) return rows;
    // Video tracks top-down, then audio tracks, offset by the vertical scroll.
    let y = RULER_H - this.scrollY;
    const ordered = [
      ...this.project.tracks.filter((t) => t.kind === "video"),
      ...this.project.tracks.filter((t) => t.kind === "audio"),
    ];
    for (const track of ordered) {
      const h = track.height ?? (track.kind === "video" ? V_TRACK_H : A_TRACK_H);
      rows.push({ track, y, h });
      y += h + TRACK_GAP;
    }
    return rows;
  }

  // ---- interaction ----
  /** Toggle buttons + resize handle laid out for a track's header cell. */
  private headerButtons(track: Track, rowY: number, rowH: number): HeaderButton[] {
    const btns: HeaderButton[] = [];
    const y = rowY + rowH - HDR_BTN - 5;
    let x = 12;
    const add = (prop: HeaderButton["prop"], label: string, on: boolean) => {
      btns.push({ prop, label, on, x, y });
      x += HDR_BTN + 4;
    };
    if (track.kind === "video") add("hidden", "E", !track.hidden);
    else {
      add("muted", "M", !!track.muted);
      add("solo", "S", !!track.solo);
    }
    add("locked", "L", !!track.locked);
    return btns;
  }

  private onHeaderPointerDown(e: PointerEvent, x: number, y: number) {
    if (y < RULER_H) return;
    const row = this.trackLayout().find((r) => y >= r.y && y < r.y + r.h);
    if (!row) return;
    // Resize handle at the lane's bottom edge.
    if (Math.abs(y - (row.y + row.h)) <= RESIZE_GRAB) {
      this.trackResize = { trackId: row.track.id, startY: y, startH: row.h };
      this.cb.onTrackResizeBegin();
      this.canvas.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", this.onTrackResizeMove);
      window.addEventListener("pointerup", this.onTrackResizeUp);
      return;
    }
    // Toggle buttons.
    for (const b of this.headerButtons(row.track, row.y, row.h)) {
      if (x >= b.x && x <= b.x + HDR_BTN && y >= b.y && y <= b.y + HDR_BTN) {
        this.cb.onToggleTrack(row.track.id, b.prop);
        return;
      }
    }
    // Otherwise a header click sets this track as the edit target.
    this.cb.onSetTarget?.(row.track.id);
  }

  private onTrackResizeMove = (e: PointerEvent) => {
    if (!this.trackResize) return;
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = Math.min(MAX_TRACK_H, Math.max(MIN_TRACK_H, this.trackResize.startH + (y - this.trackResize.startY)));
    this.cb.onTrackResize(this.trackResize.trackId, Math.round(h));
  };

  private onTrackResizeUp = () => {
    this.trackResize = null;
    window.removeEventListener("pointermove", this.onTrackResizeMove);
    window.removeEventListener("pointerup", this.onTrackResizeUp);
    this.cb.onTrackResizeEnd();
  };

  private onPointerDown(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < HEADER_W) {
      this.onHeaderPointerDown(e, x, y);
      return;
    }

    if (y < RULER_H) {
      // Clicking a marker pennant jumps the playhead to it.
      const mId = this.markerAtClient(e.clientX, e.clientY);
      const marker = mId && this.project?.markers?.find((m) => m.id === mId);
      if (marker) {
        this.cb.onSeek(marker.time);
        return;
      }
      this.beginScrub(e); // drag along the ruler to scrub
      return;
    }

    // All clips under the cursor (a track row can hold time-overlapping clips).
    const hits = this.clipsAt(x, y);

    if (this.tool === "razor") {
      if (hits.length) this.cb.onRazor(Math.max(0, this.xToTime(x)), hits[0].id);
      return;
    }

    // Select tool
    if (hits.length === 0) {
      this.beginMarquee(e, x, y); // drag = box-select; click = deselect + seek
      return;
    }
    // Repeated clicks cycle through overlapping clips (unless shift-adding).
    let hit = hits[0];
    if (!e.shiftKey && hits.length > 1) {
      const selIdx = hits.findIndex((c) => this.selected.has(c.id));
      hit = hits[(selIdx + 1) % hits.length];
    }
    // Fade knobs are only visible on a selected clip (or one that already has a
    // fade), so only those can start a fade drag — otherwise the first click on a
    // clip just selects it.
    const fadeVisible =
      this.selected.has(hit.id) || clipFadeIn(hit) > 0 || clipFadeOut(hit) > 0;
    this.cb.onSelectClip(hit.id, e.shiftKey);

    // Fade handle in the clip's top band? Begin a fade drag.
    const fade = fadeVisible ? this.fadeHitFor(hit, x, y) : null;
    if (fade) {
      this.fading = { clipId: hit.id, edge: fade };
      this.cb.onFadeBegin();
      this.canvas.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", this.onFadeMove);
      window.addEventListener("pointerup", this.onFadeUp);
      return;
    }

    // Audio clip volume rubber-band: Alt+click adds/removes a keyframe, dragging
    // a keyframe dot moves it, and dragging the flat line sets the constant gain.
    if (hit.kind === "audio") {
      const grow = this.rowForClip(hit);
      const kfT = this.gainKfHit(hit, x, y);
      if (e.altKey && grow) {
        this.cb.onGainBegin();
        if (kfT !== null) this.cb.onGainKeyframeRemove(hit.id, kfT);
        else this.cb.onGainKeyframe(hit.id, this.localTimeAt(hit, x), this.gainFromY(grow.y, grow.h, y));
        this.cb.onGainEnd();
        return;
      }
      if (kfT !== null) {
        this.gainPt = { clipId: hit.id, curT: kfT };
        this.cb.onGainBegin();
        this.canvas.setPointerCapture(e.pointerId);
        window.addEventListener("pointermove", this.onGainPtMove);
        window.addEventListener("pointerup", this.onGainPtUp);
        return;
      }
      if (!isGainAnimated(hit) && this.gainLineHit(hit, x, y)) {
        this.gaining = { clipId: hit.id };
        this.cb.onGainBegin();
        this.canvas.setPointerCapture(e.pointerId);
        window.addEventListener("pointermove", this.onGainMove);
        window.addEventListener("pointerup", this.onGainUp);
        return;
      }
    }

    // Slip / Slide tools: drag the clip body to slip its source or slide it.
    if (this.tool === "slip" || this.tool === "slide") {
      this.slipping = { clipId: hit.id, kind: this.tool, startX: x };
      this.cb.onTrimBegin(); // reuse the per-gesture snapshot
      this.canvas.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", this.onSlipMove);
      window.addEventListener("pointerup", this.onSlipUp);
      return;
    }

    // Near an edge? Begin an edge-trim (or a rate-stretch with the rate tool).
    const edge = this.edgeHitFor(hit, x);
    if (edge) {
      this.trimming = { clipId: hit.id, edge, rate: this.tool === "rate" };
      this.cb.onTrimBegin();
      this.canvas.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", this.onTrimMove);
      window.addEventListener("pointerup", this.onTrimUp);
      return;
    }
    // Rate tool over a clip body: just select (no move).
    if (this.tool === "rate") return;

    // Begin a group-aware move drag.
    this.drag = {
      set: new Set(groupMembers(this.project!, hit.id)),
      kind: hit.kind,
      startX: x,
      startY: y,
      deltaTime: 0,
      deltaTrack: 0,
      moved: false,
    };
    this.canvas.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragUp);
  }

  /** Returns which edge of `clip` pixel-x is grabbing, if the clip is wide enough. */
  private edgeHitFor(clip: Clip, x: number): "in" | "out" | null {
    const x0 = this.timeToX(clip.start);
    const x1 = this.timeToX(clipEnd(clip));
    if (x1 - x0 < 2 * EDGE_PX + 6) return null; // too narrow to grab an edge
    if (Math.abs(x - x0) <= EDGE_PX) return "in";
    if (Math.abs(x - x1) <= EDGE_PX) return "out";
    return null;
  }

  private onTrimMove = (e: PointerEvent) => {
    if (!this.trimming) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Snap the moving edge to nearby edges/playhead (Alt / toggle disables it).
    let t = Math.max(0, this.xToTime(x));
    if (e.altKey || !this.snapEnabled) {
      this.snapGuide = null;
      t = this.snapFrame(t);
    } else {
      t = this.snapTime(t, new Set(groupMembers(this.project!, this.trimming.clipId)));
      if (this.snapGuide === null) t = this.snapFrame(t); // land on a frame
    }
    if (this.trimming.rate) this.cb.onRateStretch?.(this.trimming.clipId, this.trimming.edge, t);
    else this.cb.onTrimEdge(this.trimming.clipId, this.trimming.edge, t);
  };

  private onTrimUp = () => {
    this.trimming = null;
    this.snapGuide = null;
    window.removeEventListener("pointermove", this.onTrimMove);
    window.removeEventListener("pointerup", this.onTrimUp);
    this.cb.onTrimEnd();
  };

  private onSlipMove = (e: PointerEvent) => {
    if (!this.slipping) return;
    const rect = this.canvas.getBoundingClientRect();
    const dt = (e.clientX - rect.left - this.slipping.startX) / this.view.pxPerSec;
    if (this.slipping.kind === "slip") {
      // Drag right reveals EARLIER source, so the source shift is negative.
      this.cb.onSlip?.(this.slipping.clipId, -dt);
    } else {
      this.cb.onSlide?.(this.slipping.clipId, dt);
    }
  };

  private onSlipUp = () => {
    this.slipping = null;
    window.removeEventListener("pointermove", this.onSlipMove);
    window.removeEventListener("pointerup", this.onSlipUp);
    this.cb.onTrimEnd();
  };

  /** Updates the cursor while hovering (select tool): resize on edges, grab on clips. */
  private onHover(e: PointerEvent) {
    if (this.drag || this.trimming || this.slipping || this.scrubbing || this.gaining || this.trackResize)
      return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Header: show a resize cursor on lane bottom edges.
    if (x < HEADER_W && y >= RULER_H) {
      const row = this.trackLayout().find((r) => Math.abs(y - (r.y + r.h)) <= RESIZE_GRAB);
      this.canvas.style.cursor = row ? "row-resize" : "default";
      return;
    }
    if (this.tool === "razor") return;
    let cursor = "default";
    if (x >= HEADER_W && y >= RULER_H) {
      const hit = this.clipAt(x, y);
      if (hit && this.tool === "rate") {
        cursor = this.edgeHitFor(hit, x) ? "ew-resize" : "default";
      } else if (hit && (this.tool === "slip" || this.tool === "slide")) {
        cursor = "ew-resize";
      } else if (hit) {
        const fadeable = this.selected.has(hit.id) || clipFadeIn(hit) > 0 || clipFadeOut(hit) > 0;
        if (fadeable && this.fadeHitFor(hit, x, y)) cursor = "pointer";
        else if (hit.kind === "audio" && this.gainLineHit(hit, x, y)) cursor = "ns-resize";
        else if (this.edgeHitFor(hit, x)) cursor = "ew-resize";
        else cursor = "grab";
      }
    }
    this.canvas.style.cursor = cursor;
  }

  /** Screen row (lane) geometry for a clip's track. */
  private rowForClip(clip: Clip): { y: number; h: number } | null {
    for (const row of this.trackLayout()) {
      if (row.track.clips.some((c) => c.id === clip.id)) return { y: row.y, h: row.h };
    }
    return null;
  }

  /** Y pixel of the volume line for a given gain within a clip lane. */
  private gainLineY(rowY: number, rowH: number, gain: number): number {
    const top = rowY + GAIN_PAD;
    const usable = rowH - 2 * GAIN_PAD;
    return top + (1 - gain / MAX_GAIN) * usable; // gain MAX at top, 0 at bottom
  }

  private gainFromY(rowY: number, rowH: number, y: number): number {
    const top = rowY + GAIN_PAD;
    const usable = rowH - 2 * GAIN_PAD;
    const frac = 1 - (y - top) / usable;
    return Math.min(MAX_GAIN, Math.max(0, frac * MAX_GAIN));
  }

  private gainLineHit(clip: Clip, x: number, y: number): boolean {
    const row = this.rowForClip(clip);
    if (!row) return false;
    const x0 = this.timeToX(clip.start);
    const x1 = this.timeToX(clipEnd(clip));
    if (x < Math.max(x0, HEADER_W) || x > x1) return false;
    const lineY = this.gainLineY(row.y, row.h, clipGain(clip));
    return Math.abs(y - lineY) <= GAIN_GRAB_PX;
  }

  private onGainMove = (e: PointerEvent) => {
    if (!this.gaining) return;
    const clip = this.findClip(this.gaining.clipId);
    if (!clip) return;
    const row = this.rowForClip(clip);
    if (!row) return;
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    this.cb.onGainDrag(this.gaining.clipId, this.gainFromY(row.y, row.h, y));
  };

  private onGainUp = () => {
    this.gaining = null;
    window.removeEventListener("pointermove", this.onGainMove);
    window.removeEventListener("pointerup", this.onGainUp);
    this.cb.onGainEnd();
  };

  /** Clip-local time under `x`, clamped to the clip's span. */
  private localTimeAt(clip: Clip, x: number): number {
    const t = this.xToTime(x) - clip.start;
    return Math.min(clipDuration(clip), Math.max(0, t));
  }

  /** The clip-local time of a gain keyframe whose dot is near (x,y), or null. */
  private gainKfHit(clip: Clip, x: number, y: number): number | null {
    if (!isGainAnimated(clip)) return null;
    const row = this.rowForClip(clip);
    if (!row) return null;
    for (const k of clip.gainKeyframes ?? []) {
      const kx = this.timeToX(clip.start + k.t);
      const ky = this.gainLineY(row.y, row.h, k.v);
      if (Math.abs(x - kx) <= GAIN_GRAB_PX + 2 && Math.abs(y - ky) <= GAIN_GRAB_PX + 2) return k.t;
    }
    return null;
  }

  private onGainPtMove = (e: PointerEvent) => {
    if (!this.gainPt) return;
    const clip = this.findClip(this.gainPt.clipId);
    if (!clip) return;
    const row = this.rowForClip(clip);
    if (!row) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const toT = this.localTimeAt(clip, x);
    const gain = this.gainFromY(row.y, row.h, y);
    this.cb.onGainKeyframeMove(this.gainPt.clipId, this.gainPt.curT, toT, gain);
    this.gainPt.curT = toT;
  };

  private onGainPtUp = () => {
    this.gainPt = null;
    window.removeEventListener("pointermove", this.onGainPtMove);
    window.removeEventListener("pointerup", this.onGainPtUp);
    this.cb.onGainEnd();
  };

  /** Which fade handle (top-corner knob) is under the cursor, if any. */
  private fadeHitFor(clip: Clip, x: number, y: number): "in" | "out" | null {
    const row = this.rowForClip(clip);
    if (!row) return null;
    if (y < row.y + 3 || y > row.y + 3 + FADE_BAND) return null;
    const inX = this.timeToX(clip.start + clipFadeIn(clip));
    const outX = this.timeToX(clipEnd(clip) - clipFadeOut(clip));
    const dIn = Math.abs(x - inX);
    const dOut = Math.abs(x - outX);
    // Pick the nearer knob when both are within reach (short clips / big fades).
    if (dIn <= FADE_GRAB && dIn <= dOut) return "in";
    if (dOut <= FADE_GRAB) return "out";
    return null;
  }

  private onFadeMove = (e: PointerEvent) => {
    if (!this.fading) return;
    const clip = this.findClip(this.fading.clipId);
    if (!clip) return;
    const rect = this.canvas.getBoundingClientRect();
    const t = this.xToTime(e.clientX - rect.left);
    const dur =
      this.fading.edge === "in"
        ? t - clip.start
        : clipEnd(clip) - t;
    this.cb.onFadeDrag(this.fading.clipId, this.fading.edge, Math.max(0, this.snapFrame(dur)));
  };

  private onFadeUp = () => {
    this.fading = null;
    window.removeEventListener("pointermove", this.onFadeMove);
    window.removeEventListener("pointerup", this.onFadeUp);
    this.cb.onFadeEnd();
  };

  private findClip(id: string): Clip | undefined {
    if (!this.project) return undefined;
    for (const t of this.project.tracks) {
      const c = t.clips.find((x) => x.id === id);
      if (c) return c;
    }
    return undefined;
  }

  private beginMarquee(e: PointerEvent, x: number, y: number) {
    this.marqueeState = {
      startX: x,
      startY: y,
      additive: e.shiftKey,
      base: new Set(this.selected),
      moved: false,
    };
    this.canvas.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", this.onMarqueeMove);
    window.addEventListener("pointerup", this.onMarqueeUp);
  }

  private onMarqueeMove = (e: PointerEvent) => {
    if (!this.marqueeState) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const s = this.marqueeState;
    if (!s.moved && Math.hypot(x - s.startX, y - s.startY) > DRAG_START_PX) s.moved = true;
    if (!s.moved) return;
    this.marquee = { x0: s.startX, y0: s.startY, x1: x, y1: y };
    this.applyMarqueeSelection();
    this.draw();
  };

  private applyMarqueeSelection() {
    if (!this.marquee || !this.marqueeState || !this.project) return;
    const t0 = this.xToTime(Math.min(this.marquee.x0, this.marquee.x1));
    const t1 = this.xToTime(Math.max(this.marquee.x0, this.marquee.x1));
    const ya = Math.min(this.marquee.y0, this.marquee.y1);
    const yb = Math.max(this.marquee.y0, this.marquee.y1);
    const sel = new Set(this.marqueeState.additive ? this.marqueeState.base : []);
    for (const row of this.trackLayout()) {
      if (row.track.locked) continue;
      if (row.y + row.h < ya || row.y > yb) continue;
      for (const c of row.track.clips) if (clipEnd(c) > t0 && c.start < t1) sel.add(c.id);
    }
    this.selected = sel;
    this.cb.onSelectionChanged();
  }

  private onMarqueeUp = (e: PointerEvent) => {
    window.removeEventListener("pointermove", this.onMarqueeMove);
    window.removeEventListener("pointerup", this.onMarqueeUp);
    const s = this.marqueeState;
    this.marqueeState = null;
    this.marquee = null;
    if (s && !s.moved) {
      // Click on empty space: deselect and move the playhead there.
      const rect = this.canvas.getBoundingClientRect();
      this.cb.onSelectClip(null, false);
      this.cb.onSeek(Math.max(0, this.xToTime(e.clientX - rect.left)));
    }
    this.draw();
  };

  private beginScrub(e: PointerEvent) {
    this.scrubbing = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.scrubTo(e);
    window.addEventListener("pointermove", this.onScrubMove);
    window.addEventListener("pointerup", this.onScrubUp);
  }

  private scrubTo(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    this.cb.onSeek(Math.max(0, this.xToTime(x)));
  }

  private onScrubMove = (e: PointerEvent) => {
    if (this.scrubbing) this.scrubTo(e);
  };

  private onScrubUp = () => {
    this.scrubbing = false;
    window.removeEventListener("pointermove", this.onScrubMove);
    window.removeEventListener("pointerup", this.onScrubUp);
  };

  private onDragMove = (e: PointerEvent) => {
    if (!this.drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let dTime = (x - this.drag.startX) / this.view.pxPerSec;
    // Snapping off (toggle) or held Alt disables it for this move.
    if (e.altKey || !this.snapEnabled) {
      this.snapGuide = null;
      dTime = this.snapFrame(dTime); // still land on a whole frame
    } else {
      dTime = this.applySnap(this.drag.set, dTime);
      if (this.snapGuide === null) dTime = this.snapFrame(dTime); // land on a frame
    }

    const startRow = this.rowIndexWithinKind(this.drag.startY, this.drag.kind);
    const curRow = this.rowIndexWithinKind(y, this.drag.kind);
    const dTrack = startRow !== null && curRow !== null ? curRow - startRow : 0;

    this.drag.deltaTime = dTime;
    this.drag.deltaTrack = dTrack;
    if (Math.abs(x - this.drag.startX) > DRAG_START_PX || dTrack !== 0) {
      this.drag.moved = true;
    }
    this.draw();
  };

  private onDragUp = (_e: PointerEvent) => {
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragUp);
    const d = this.drag;
    this.drag = null;
    this.snapGuide = null; // clear before redraw so no guide lingers after the drop
    if (d && d.moved) {
      this.cb.onMoveClips([...d.set], d.deltaTime, d.deltaTrack, d.kind);
    } else {
      this.draw();
    }
  };

  private kindRows(kind: TrackKind): { track: Track; y: number; h: number }[] {
    return this.trackLayout().filter((r) => r.track.kind === kind);
  }

  /** Index (within a kind's rows) of the lane at pixel y, clamped to range. */
  private rowIndexWithinKind(y: number, kind: TrackKind): number | null {
    const rows = this.kindRows(kind);
    if (rows.length === 0) return null;
    if (y < rows[0].y) return 0;
    for (let i = 0; i < rows.length; i++) {
      if (y >= rows[i].y && y < rows[i].y + rows[i].h) return i;
    }
    return rows.length - 1;
  }

  /** Quantises a time to the sequence frame grid. */
  private snapFrame(t: number): number {
    const f = Math.max(1, this.fps);
    return Math.round(t * f) / f;
  }

  /** Snap targets: 0, the playhead, and every non-excluded clip's start/end. */
  private snapCandidates(exclude: Set<string>): number[] {
    const cands = [0, this.playhead];
    for (const m of this.project!.markers ?? []) cands.push(m.time); // snap to markers
    for (const track of this.project!.tracks) {
      for (const c of track.clips) {
        if (exclude.has(c.id)) continue;
        cands.push(c.start, clipEnd(c));
      }
    }
    return cands;
  }

  /** Snaps the drag delta so a moved edge lands on a nearby candidate time. */
  private applySnap(set: Set<string>, dTime: number): number {
    const thr = SNAP_PX / this.view.pxPerSec;
    const candidates = this.snapCandidates(set);
    const movingEdges: number[] = [];
    for (const track of this.project!.tracks) {
      for (const c of track.clips) {
        if (set.has(c.id)) movingEdges.push(c.start + dTime, clipEnd(c) + dTime);
      }
    }
    let best = 0;
    let bestDist = thr;
    let guide: number | null = null;
    for (const me of movingEdges) {
      for (const cand of candidates) {
        const d = cand - me;
        if (Math.abs(d) < bestDist) {
          bestDist = Math.abs(d);
          best = d;
          guide = cand;
        }
      }
    }
    this.snapGuide = guide;
    return dTime + best;
  }

  /** Snaps a single dragged time (e.g. a trim edge) to a nearby candidate. */
  private snapTime(time: number, exclude: Set<string>): number {
    const thr = SNAP_PX / this.view.pxPerSec;
    let best = time;
    let bestDist = thr;
    let guide: number | null = null;
    for (const cand of this.snapCandidates(exclude)) {
      const d = Math.abs(cand - time);
      if (d < bestDist) {
        bestDist = d;
        best = cand;
        guide = cand;
      }
    }
    this.snapGuide = guide;
    return best;
  }

  private clipAt(x: number, y: number): Clip | null {
    return this.clipsAt(x, y)[0] ?? null;
  }

  /** Every clip under the cursor in its track row (multiple if they overlap in time). */
  private clipsAt(x: number, y: number): Clip[] {
    for (const { track, y: ty, h } of this.trackLayout()) {
      if (y < ty || y >= ty + h) continue;
      if (track.locked) return []; // locked tracks: no clip interaction
      const t = this.xToTime(x);
      return track.clips.filter((c) => t >= c.start && t < clipEnd(c));
    }
    return [];
  }

  private contentHeight(): number {
    if (!this.project) return 0;
    let h = 0;
    for (const t of this.project.tracks) {
      h += (t.height ?? (t.kind === "video" ? V_TRACK_H : A_TRACK_H)) + TRACK_GAP;
    }
    return h;
  }

  private maxScrollY(): number {
    return Math.max(0, this.contentHeight() - (this.cssH - RULER_H));
  }

  private clampScrollY() {
    this.scrollY = Math.min(this.maxScrollY(), Math.max(0, this.scrollY));
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey) {
      // Zoom time around the cursor.
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const anchorT = this.xToTime(x);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.view.pxPerSec = Math.min(400, Math.max(4, this.view.pxPerSec * factor));
      this.view.scrollSec = anchorT - (x - HEADER_W) / this.view.pxPerSec;
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // Horizontal time scroll (shift-wheel or trackpad deltaX).
      this.view.scrollSec += (e.deltaX || e.deltaY) / this.view.pxPerSec;
    } else if (this.maxScrollY() > 0) {
      // Vertical track scroll when the stack overflows.
      this.scrollY += e.deltaY;
      this.clampScrollY();
    } else {
      // Nothing to scroll vertically: fall back to horizontal.
      this.view.scrollSec += e.deltaY / this.view.pxPerSec;
    }
    if (this.view.scrollSec < 0) this.view.scrollSec = 0;
    this.draw();
  }

  // ---- drawing ----
  draw() {
    const c = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    c.clearRect(0, 0, w, h);
    c.fillStyle = COLORS.bg;
    c.fillRect(0, 0, w, h);
    if (!this.project) return;

    // Group-mates of the current selection, for the linked highlight.
    this.linkedHighlight = new Set<string>();
    for (const id of this.selected) {
      for (const m of groupMembers(this.project, id)) {
        if (!this.selected.has(m)) this.linkedHighlight.add(m);
      }
    }

    // Scrolled track content is clipped to below the ruler.
    c.save();
    c.beginPath();
    c.rect(0, RULER_H, w, h - RULER_H);
    c.clip();
    this.drawLanes(w);
    this.drawGridlines(w);
    this.drawClips();
    this.drawDropTarget();
    this.drawHeaders();
    c.restore();

    this.drawRuler(w);
    this.drawInOut(h);
    this.drawSnapGuide(h);
    this.drawScrollbar();
    this.drawPlayhead(h);
    this.drawMarquee();
  }

  private drawMarquee() {
    if (!this.marquee) return;
    const c = this.ctx;
    const x = Math.min(this.marquee.x0, this.marquee.x1);
    const y = Math.min(this.marquee.y0, this.marquee.y1);
    const w = Math.abs(this.marquee.x1 - this.marquee.x0);
    const h = Math.abs(this.marquee.y1 - this.marquee.y0);
    c.save();
    c.fillStyle = "rgba(90,160,255,0.12)";
    c.strokeStyle = "#5aa0ff";
    c.lineWidth = 1;
    c.fillRect(x, y, w, h);
    c.strokeRect(x + 0.5, y + 0.5, w, h);
    c.restore();
  }

  /** Shaded In/Out range with brackets on the ruler (export/work area). */
  private drawInOut(h: number) {
    if (this.inPoint === null && this.outPoint === null) return;
    const c = this.ctx;
    const a = this.inPoint ?? 0;
    const b = this.outPoint ?? (this.project ? timelineDuration(this.project) : a);
    const xa = Math.max(HEADER_W, this.timeToX(a));
    const xb = Math.min(this.cssW, this.timeToX(b));
    if (xb <= xa) return;
    c.save();
    c.fillStyle = "rgba(46,204,113,0.10)";
    c.fillRect(xa, RULER_H, xb - xa, h - RULER_H);
    c.fillStyle = "#2ecc71";
    c.fillRect(xa, 0, 2, RULER_H); // in bracket
    c.fillRect(xb - 2, 0, 2, RULER_H); // out bracket
    c.restore();
  }

  /** Green row highlight + insertion line while dragging a media clip in. */
  private drawDropTarget() {
    if (!this.dropPreview) return;
    const row = this.trackLayout().find((r) => r.track.id === this.dropPreview!.trackId);
    if (!row) return;
    const c = this.ctx;
    c.save();
    c.strokeStyle = "#2ecc71";
    c.lineWidth = 2;
    c.strokeRect(HEADER_W + 1, row.y + 1, this.cssW - HEADER_W - 2, row.h - 2);
    const x = this.timeToX(this.dropPreview.time);
    if (x >= HEADER_W && x <= this.cssW) {
      c.beginPath();
      c.moveTo(x + 0.5, row.y);
      c.lineTo(x + 0.5, row.y + row.h);
      c.stroke();
      c.fillStyle = "#2ecc71";
      c.beginPath();
      c.moveTo(x - 4, row.y);
      c.lineTo(x + 4, row.y);
      c.lineTo(x, row.y + 7);
      c.closePath();
      c.fill();
    }
    c.restore();
  }

  /** Cyan dashed line marking the time a dragged edge is snapping to. */
  private drawSnapGuide(h: number) {
    if (this.snapGuide === null) return;
    const x = this.timeToX(this.snapGuide);
    if (x < HEADER_W || x > this.cssW) return;
    const c = this.ctx;
    c.save();
    c.strokeStyle = "#3fd0ff";
    c.lineWidth = 1;
    c.setLineDash([5, 4]);
    c.beginPath();
    c.moveTo(x + 0.5, RULER_H);
    c.lineTo(x + 0.5, h);
    c.stroke();
    c.restore();
  }

  private drawScrollbar() {
    const maxSY = this.maxScrollY();
    if (maxSY <= 0) return;
    const c = this.ctx;
    const areaH = this.cssH - RULER_H;
    const contentH = this.contentHeight();
    const barH = Math.max(24, (areaH * areaH) / contentH);
    const barY = RULER_H + (this.scrollY / contentH) * areaH;
    c.fillStyle = "rgba(255,255,255,0.22)";
    c.beginPath();
    c.roundRect(this.cssW - 6, barY, 4, barH, 2);
    c.fill();
  }

  private drawLanes(w: number) {
    const c = this.ctx;
    let alt = false;
    for (const { track, y, h } of this.trackLayout()) {
      c.fillStyle = alt ? COLORS.laneAlt : COLORS.lane;
      c.fillRect(HEADER_W, y, w - HEADER_W, h);
      if (track.muted || track.hidden) {
        c.fillStyle = "rgba(0,0,0,0.28)"; // dim disabled lanes
        c.fillRect(HEADER_W, y, w - HEADER_W, h);
      }
      alt = !alt;
    }
  }

  private niceStep(): number {
    // Choose a ruler step (seconds) giving ~80px spacing.
    const target = 80 / this.view.pxPerSec;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const s of steps) if (s >= target) return s;
    return 600;
  }

  /** Vertical time gridlines, drawn behind clips within the clipped content area. */
  private drawGridlines(w: number) {
    const c = this.ctx;
    const step = this.niceStep();
    const first = Math.ceil(this.view.scrollSec / step) * step;
    c.strokeStyle = COLORS.gridline;
    c.lineWidth = 1;
    for (let t = first; ; t += step) {
      const x = this.timeToX(t);
      if (x > w) break;
      if (x < HEADER_W) continue;
      c.beginPath();
      c.moveTo(x + 0.5, RULER_H);
      c.lineTo(x + 0.5, this.cssH);
      c.stroke();
    }
  }

  private drawRuler(w: number) {
    const c = this.ctx;
    c.fillStyle = COLORS.ruler;
    c.fillRect(HEADER_W, 0, w - HEADER_W, RULER_H);
    c.fillStyle = COLORS.header;
    c.fillRect(0, 0, HEADER_W, RULER_H); // corner above the track headers
    const step = this.niceStep();
    const first = Math.ceil(this.view.scrollSec / step) * step;
    c.fillStyle = COLORS.rulerText;
    c.font = "10px system-ui";
    c.textBaseline = "middle";
    c.textAlign = "left";
    for (let t = first; ; t += step) {
      const x = this.timeToX(t);
      if (x > w) break;
      if (x < HEADER_W) continue;
      c.fillText(secondsToTimestamp(t).replace(/^00:/, ""), x + 4, RULER_H / 2);
    }
    this.drawMarkers(w);
  }

  /** Draws sequence markers as little pennants on the ruler. */
  private drawMarkers(w: number) {
    if (!this.project) return;
    const c = this.ctx;
    for (const m of this.project.markers ?? []) {
      const x = this.timeToX(m.time);
      if (x < HEADER_W - 6 || x > w + 6) continue;
      c.fillStyle = m.color ?? "#39c06a";
      c.strokeStyle = "rgba(0,0,0,0.6)";
      c.lineWidth = 1;
      c.beginPath(); // pennant: flag on the top half of the ruler
      c.moveTo(x, RULER_H - 3);
      c.lineTo(x, 3);
      c.lineTo(x + 9, 3);
      c.lineTo(x + 9, 9);
      c.lineTo(x, 12);
      c.closePath();
      c.fill();
      c.stroke();
    }
  }

  /** The marker whose pennant is under a ruler click, if any. */
  markerAtClient(clientX: number, clientY: number): string | null {
    if (!this.project) return null;
    const rect = this.canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    if (y < 0 || y > RULER_H) return null;
    const x = clientX - rect.left;
    for (const m of this.project.markers ?? []) {
      const mx = this.timeToX(m.time);
      if (x >= mx - 2 && x <= mx + 11) return m.id;
    }
    return null;
  }

  private drawClips() {
    const c = this.ctx;
    for (const { track, y: rowY, h: rowH } of this.trackLayout()) {
      for (const clip of track.clips) {
        // Apply the live drag offset (time + lane) to clips being moved.
        let drawStart = clip.start;
        let y = rowY;
        let h = rowH;
        if (this.drag && this.drag.set.has(clip.id)) {
          drawStart = clip.start + this.drag.deltaTime;
          const rows = this.kindRows(clip.kind);
          const curIdx = rows.findIndex((r) => r.track === track);
          const destIdx = Math.min(
            rows.length - 1,
            Math.max(0, curIdx + this.drag.deltaTrack),
          );
          y = rows[destIdx].y;
          h = rows[destIdx].h;
        }

        const x0 = this.timeToX(drawStart);
        const x1 = this.timeToX(drawStart + clipDuration(clip));
        if (x1 < HEADER_W || x0 > this.cssW) continue;
        const cx0 = Math.max(x0, HEADER_W);
        const cw = x1 - cx0;
        const sel = this.selected.has(clip.id);
        const isVideo = clip.kind === "video";
        const cm = this.project!.media.find((m) => m.id === clip.mediaId);
        c.fillStyle = cm?.isColor
          ? (cm.color ?? "#39c06a")
          : cm?.isText
            ? sel
              ? COLORS.textClipSel
              : COLORS.textClip
            : cm?.isImage
              ? sel
                ? COLORS.imageClipSel
                : COLORS.imageClip
              : isVideo
                ? sel
                  ? COLORS.videoClipSel
                  : COLORS.videoClip
                : sel
                  ? COLORS.audioClipSel
                  : COLORS.audioClip;
        roundRect(c, cx0, y + 3, cw, h - 6, 5);
        c.fill();
        if (sel) {
          // Selected: bright solid border.
          c.strokeStyle = "#ffffff";
          c.lineWidth = 2;
          c.stroke();
        } else if (this.linkedHighlight.has(clip.id)) {
          // Linked to the selection: dashed accent border (moves/deletes together).
          c.strokeStyle = "#5aa0ff";
          c.lineWidth = 1.5;
          c.setLineDash([4, 3]);
          c.stroke();
          c.setLineDash([]);
        } else {
          c.strokeStyle = COLORS.clipBorder;
          c.lineWidth = 1;
          c.stroke();
        }

        // Filmstrip thumbnails for real footage (not images/text/mattes).
        if (isVideo && !cm?.isImage && !cm?.isText && !cm?.isColor) {
          this.drawThumbnails(clip, x0, x1, cx0, y + 3, cw, h - 6);
        }

        // Waveform: map only the VISIBLE source sub-range to the visible pixels,
        // so it stays correct when the clip is partly scrolled off or zoomed in.
        if (clip.kind === "audio" && clip.audioStream !== undefined) {
          const x1c = Math.min(x1, this.cssW);
          const wv = x1c - cx0;
          const fullW = x1 - x0;
          const fracL = fullW > 0 ? (cx0 - x0) / fullW : 0;
          const fracR = fullW > 0 ? (x1c - x0) / fullW : 1;
          const srcLen = clip.sourceOut - clip.sourceIn;
          const sIn = clip.sourceIn + fracL * srcLen;
          const sOut = clip.sourceIn + fracR * srcLen;
          this.drawWaveform(clip, sIn, sOut, cx0, y, wv, h);
          this.drawGainLine(clip, cx0, y, cw, h);
        }

        // Fade in/out ramps + handles (audio and video).
        if (clipFadeIn(clip) > 0 || clipFadeOut(clip) > 0 || sel) {
          this.drawFades(clip, drawStart, x0, x1, cx0, y + 3, h - 6, cw, sel);
        }

        // Label (with a dark band so it stays legible over a filmstrip).
        if (cw > 40) {
          c.save();
          c.beginPath();
          c.rect(cx0, y, cw, h);
          c.clip();
          const hasStrip =
            isVideo && !cm?.isImage && !cm?.isText && !cm?.isColor && this.thumbnails.has(clip.mediaId);
          if (hasStrip) {
            c.fillStyle = "rgba(0,0,0,0.45)";
            c.fillRect(cx0, y + 3, cw, 16);
          }
          c.fillStyle = COLORS.text;
          c.font = "11px system-ui";
          c.textBaseline = "top";
          c.textAlign = "left";
          let label = cm?.isText
            ? cm.text?.content.split("\n")[0] || "Text"
            : (cm?.name ?? "clip");
          // Retime badge, Premiere-style: e.g. "clip.mp4  200% ←"
          const spd = clipSpeed(clip);
          if (spd !== 1) label += `  ${Math.round(spd * 100)}%`;
          if (clipReversed(clip)) label += " ←"; // leftwards arrow
          c.fillText(label, cx0 + 6, y + 6);
          c.restore();
        }

        // Transition marker on this clip's out-edge cut (video only).
        if (clip.transitionOut && clip.transitionOut.duration > 0) {
          this.drawTransition(clip, y + 3, h - 6);
        }

        // Keyframe diamonds along a strip near the clip bottom.
        if (clip.keyframes || clip.effects) this.drawKeyframes(clip, drawStart, cx0, x1, y + h - 9);

        // Disabled clips: dim + hatch so it's clear they won't render.
        if (clip.disabled) {
          c.save();
          roundRect(c, cx0, y + 3, cw, h - 6, 5);
          c.clip();
          c.fillStyle = "rgba(20,22,28,0.62)";
          c.fillRect(cx0, y + 3, cw, h - 6);
          c.strokeStyle = "rgba(255,255,255,0.14)";
          c.lineWidth = 1;
          c.beginPath();
          for (let hx = cx0 - h; hx < cx0 + cw; hx += 9) {
            c.moveTo(hx, y + h - 3);
            c.lineTo(hx + h, y + 3);
          }
          c.stroke();
          c.restore();
        }
      }
    }
  }

  /** Small diamonds at each keyframe time (union across animated properties). */
  private drawKeyframes(clip: Clip, drawStart: number, visX: number, x1: number, y: number) {
    const times = new Set<number>();
    for (const prop of ANIM_PROPS) {
      for (const k of clip.keyframes?.[prop] ?? []) times.add(Math.round(k.t * 1000) / 1000);
    }
    for (const t of effectKeyframeTimes(clip)) times.add(Math.round(t * 1000) / 1000);
    if (times.size === 0) return;
    const r = 5; // diamond radius
    const c = this.ctx;
    c.save();
    c.fillStyle = "#5aa0ff";
    c.strokeStyle = "rgba(0,0,0,0.7)";
    c.lineWidth = 1.5;
    for (const t of times) {
      const x = this.timeToX(drawStart + t);
      if (x < visX - r - 1 || x > x1 + r + 1 || x > this.cssW) continue;
      c.beginPath();
      c.moveTo(x, y - r);
      c.lineTo(x + r, y);
      c.lineTo(x, y + r);
      c.lineTo(x - r, y);
      c.closePath();
      c.fill();
      c.stroke();
    }
    c.restore();
  }

  /** Draws a Premiere-style transition badge centred on a clip's out-edge cut. */
  private drawTransition(clip: Clip, ty: number, hh: number) {
    const dur = clip.transitionOut!.duration;
    const cut = clipEnd(clip);
    const xl = this.timeToX(cut - dur / 2);
    const xr = this.timeToX(cut + dur / 2);
    if (xr < HEADER_W || xl > this.cssW) return;
    const c = this.ctx;
    const bottom = ty + hh;
    c.save();
    c.beginPath();
    c.rect(HEADER_W, ty, this.cssW - HEADER_W, hh);
    c.clip();
    c.fillStyle = "rgba(140,110,210,0.45)"; // dissolve = violet; dip = darker
    if (clip.transitionOut!.kind === "dip-black") c.fillStyle = "rgba(30,30,40,0.6)";
    c.fillRect(xl, ty, xr - xl, hh);
    // Bowtie: two triangles meeting at the cut, the classic dissolve glyph.
    c.strokeStyle = "rgba(255,255,255,0.7)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(xl, ty);
    c.lineTo(xr, bottom);
    c.moveTo(xl, bottom);
    c.lineTo(xr, ty);
    c.stroke();
    c.restore();
  }

  /** Tiles source thumbnails across a video clip (a Premiere-style filmstrip). */
  private drawThumbnails(
    clip: Clip,
    x0: number,
    x1: number,
    visX: number,
    y: number,
    visW: number,
    h: number,
  ) {
    const thumbs = this.thumbnails.get(clip.mediaId);
    if (!thumbs || thumbs.length === 0 || h < 12) return;
    const fullW = x1 - x0;
    if (fullW < 6) return;
    const srcLen = clip.sourceOut - clip.sourceIn;
    const ref = thumbs[0].img;
    const aspect = ref.naturalWidth && ref.naturalHeight ? ref.naturalWidth / ref.naturalHeight : 16 / 9;
    const slotW = Math.max(10, h * aspect);
    const c = this.ctx;
    c.save();
    roundRect(c, visX, y, visW, h, 4);
    c.clip();
    for (let sx = x0; sx < x1; sx += slotW) {
      const centerX = sx + slotW / 2;
      if (centerX < visX - slotW || centerX > visX + visW + slotW) continue;
      const frac = fullW > 0 ? (centerX - x0) / fullW : 0;
      const srcT = clip.sourceIn + frac * srcLen;
      let best = thumbs[0];
      let bd = Infinity;
      for (const th of thumbs) {
        const d = Math.abs(th.t - srcT);
        if (d < bd) {
          bd = d;
          best = th;
        }
      }
      if (best.img.complete && best.img.naturalWidth > 0) {
        try {
          c.drawImage(best.img, sx, y, slotW, h);
        } catch {
          /* not ready */
        }
      }
    }
    c.restore();
  }

  /** Fade-in/out ramp triangles + grab knobs at a clip's top corners. */
  private drawFades(
    clip: Clip,
    drawStart: number,
    x0: number,
    x1: number,
    visX: number,
    ty: number,
    hh: number,
    _visW: number, // (kept for symmetry with other draw helpers)
    sel: boolean,
  ) {
    const c = this.ctx;
    const bottom = ty + hh;
    const fi = clipFadeIn(clip);
    const fo = clipFadeOut(clip);
    const inX = this.timeToX(drawStart + fi);
    const outX = this.timeToX(drawStart + clipDuration(clip) - fo);
    c.save();
    roundRect(c, Math.max(visX, x0), ty, Math.min(x1, this.cssW) - Math.max(visX, x0), hh, 4);
    c.clip();
    c.fillStyle = "rgba(0,0,0,0.4)";
    c.strokeStyle = "rgba(255,255,255,0.85)";
    c.lineWidth = 1;
    if (fi > 0) {
      c.beginPath();
      c.moveTo(x0, ty);
      c.lineTo(inX, ty);
      c.lineTo(x0, bottom);
      c.closePath();
      c.fill();
      c.beginPath();
      c.moveTo(x0, bottom);
      c.lineTo(inX, ty);
      c.stroke();
    }
    if (fo > 0) {
      c.beginPath();
      c.moveTo(outX, ty);
      c.lineTo(x1, ty);
      c.lineTo(x1, bottom);
      c.closePath();
      c.fill();
      c.beginPath();
      c.moveTo(outX, ty);
      c.lineTo(x1, bottom);
      c.stroke();
    }
    // Knobs (shown when selected so they can be grabbed even at 0 fade).
    if (sel || fi > 0 || fo > 0) {
      for (const [kx, active] of [[inX, fi > 0], [outX, fo > 0]] as const) {
        if (kx < visX - 6 || kx > this.cssW + 6) continue;
        const ky = ty + FADE_KNOB_R + 1;
        c.beginPath();
        c.arc(kx, ky, FADE_KNOB_R, 0, Math.PI * 2);
        c.fillStyle = active ? "#ffd166" : "#ffffff";
        c.fill();
        c.lineWidth = 1.5;
        c.strokeStyle = "rgba(0,0,0,0.75)";
        c.stroke();
      }
    }
    c.restore();
  }

  private drawWaveform(
    clip: Clip,
    sIn: number,
    sOut: number,
    x: number,
    y: number,
    w: number,
    h: number,
  ) {
    const env = this.waveforms.get(`${clip.mediaId}:${clip.audioStream}`);
    if (!env || w < 2) return;
    const buckets = Math.min(4000, Math.max(1, Math.floor(w)));
    const { min, max } = sampleEnvelope(env, sIn, sOut, buckets);
    const c = this.ctx;
    const midY = y + h / 2 + 6;
    const amp = (h - 22) / 2;
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.strokeStyle = COLORS.wave;
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 0; i < buckets; i++) {
      const px = x + i + 0.5;
      c.moveTo(px, midY - max[i] * amp);
      c.lineTo(px, midY - min[i] * amp);
    }
    c.stroke();
    c.restore();
  }

  /** Premiere-style volume rubber-band across an audio clip. */
  private drawGainLine(clip: Clip, x: number, y: number, w: number, h: number) {
    const c = this.ctx;
    const unityY = this.gainLineY(y, h, 1);

    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();

    // Faint unity reference.
    c.strokeStyle = "rgba(255,255,255,0.18)";
    c.setLineDash([3, 3]);
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x, unityY + 0.5);
    c.lineTo(x + w, unityY + 0.5);
    c.stroke();
    c.setLineDash([]);

    c.strokeStyle = "#f1c40f";
    c.lineWidth = 1.5;

    if (isGainAnimated(clip)) {
      // Automation: piecewise line through the keyframes, flat past the ends.
      const kfs = [...clip.gainKeyframes!].sort((a, b) => a.t - b.t);
      const x0 = this.timeToX(clip.start);
      const xEnd = this.timeToX(clipEnd(clip));
      c.beginPath();
      c.moveTo(x0, this.gainLineY(y, h, kfs[0].v));
      for (const k of kfs) c.lineTo(this.timeToX(clip.start + k.t), this.gainLineY(y, h, k.v));
      c.lineTo(xEnd, this.gainLineY(y, h, kfs[kfs.length - 1].v));
      c.stroke();
      c.fillStyle = "#f1c40f";
      for (const k of kfs) {
        c.beginPath();
        c.arc(this.timeToX(clip.start + k.t), this.gainLineY(y, h, k.v), 3, 0, Math.PI * 2);
        c.fill();
      }
    } else {
      // Flat constant-gain line with a centre grab handle.
      const lineY = this.gainLineY(y, h, clipGain(clip));
      c.beginPath();
      c.moveTo(x, lineY + 0.5);
      c.lineTo(x + w, lineY + 0.5);
      c.stroke();
      c.fillStyle = "#f1c40f";
      c.beginPath();
      c.arc(x + w / 2, lineY, 2.5, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  private drawHeaders() {
    const c = this.ctx;
    c.fillStyle = COLORS.header;
    c.fillRect(0, 0, HEADER_W, this.cssH);
    c.strokeStyle = COLORS.gridline;
    c.beginPath();
    c.moveTo(HEADER_W + 0.5, 0);
    c.lineTo(HEADER_W + 0.5, this.cssH);
    c.stroke();

    c.textBaseline = "alphabetic";
    let vi = 1;
    let ai = 1;
    for (const { track, y, h } of this.trackLayout()) {
      const auto = track.kind === "video" ? `V${vi++}` : `A${ai++}`;
      // Edit-target track: a bright left bar + tinted cell.
      const targeted = this.targetTracks.has(track.id);
      if (targeted) {
        c.fillStyle = "rgba(90,160,255,0.14)";
        c.fillRect(0, y, HEADER_W, h);
        c.fillStyle = "#5aa0ff";
        c.fillRect(0, y, 3, h);
      }
      // Track name near the top of the cell.
      c.textAlign = "left";
      c.fillStyle = targeted ? "#cfe0ff" : COLORS.text;
      c.font = targeted ? "600 12px system-ui" : "12px system-ui";
      const name = track.label ? `${auto}  ${fitText(c, track.label, HEADER_W - 46)}` : auto;
      c.fillText(name, 12, y + 16);

      // Toggle buttons along the bottom of the cell.
      for (const b of this.headerButtons(track, y, h)) {
        let bg = "#2b313a";
        let fg = COLORS.rulerText;
        if (b.prop === "muted" && b.on) {
          bg = "#e74c3c";
          fg = "#fff";
        } else if (b.prop === "solo" && b.on) {
          bg = "#f1c40f";
          fg = "#14171c";
        } else if (b.prop === "locked" && b.on) {
          bg = "#e67e22";
          fg = "#fff";
        } else if (b.prop === "hidden") {
          // Eye: filled when visible (on), dim when hidden.
          bg = b.on ? "#3b4252" : "#20242b";
          fg = b.on ? COLORS.text : "#5a6472";
        }
        c.fillStyle = bg;
        roundRect(c, b.x, b.y, HDR_BTN, HDR_BTN, 3);
        c.fill();
        c.fillStyle = fg;
        c.font = "10px system-ui";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(b.label, b.x + HDR_BTN / 2, b.y + HDR_BTN / 2 + 0.5);
        c.textBaseline = "alphabetic";
      }
    }
  }

  /** The track whose header (left gutter) is under the given client coords. */
  trackHeaderAt(clientX: number, clientY: number): Track | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x >= HEADER_W || y < RULER_H) return null;
    for (const row of this.trackLayout()) {
      if (y >= row.y && y < row.y + row.h) return row.track;
    }
    return null;
  }

  /** The topmost clip under the given client coords, or null. */
  clipAtClient(clientX: number, clientY: number): Clip | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < HEADER_W || y < RULER_H) return null;
    return this.clipAt(x, y);
  }

  /** Timeline time (seconds) at a client X, clamped to ≥ 0. */
  timeAtClient(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return Math.max(0, this.xToTime(clientX - rect.left));
  }

  /** Which track + (snapped) time a media drag is over, for drop placement. */
  dropInfoAt(
    clientX: number,
    clientY: number,
  ): { trackId: string; kind: TrackKind; time: number } | null {
    if (!this.project) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || x > this.cssW || y < 0 || y > this.cssH) return null;
    const time = this.snapTime(Math.max(0, this.xToTime(Math.max(x, HEADER_W))), new Set());
    for (const row of this.trackLayout()) {
      if (y >= row.y && y < row.y + row.h)
        return { trackId: row.track.id, kind: row.track.kind, time };
    }
    // Over the canvas but below the last row: fall back to the first video track.
    const firstVideo = this.trackLayout().find((r) => r.track.kind === "video");
    return firstVideo ? { trackId: firstVideo.track.id, kind: "video", time } : null;
  }

  setDropTarget(clientX: number, clientY: number) {
    const info = this.dropInfoAt(clientX, clientY);
    this.dropPreview = info ? { trackId: info.trackId, time: info.time } : null;
    this.draw();
  }

  clearDropTarget() {
    if (this.dropPreview || this.snapGuide !== null) {
      this.dropPreview = null;
      this.snapGuide = null;
      this.draw();
    }
  }

  private drawPlayhead(h: number) {
    const x = this.timeToX(this.playhead);
    if (x < HEADER_W) return;
    const c = this.ctx;
    c.strokeStyle = COLORS.playhead;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x + 0.5, 0);
    c.lineTo(x + 0.5, h);
    c.stroke();
    c.fillStyle = COLORS.playhead;
    c.beginPath();
    c.moveTo(x - 5, 0);
    c.lineTo(x + 5, 0);
    c.lineTo(x, 8);
    c.closePath();
    c.fill();
  }

  /** Zooms the time axis by `factor` around a time anchor (default: playhead). */
  zoomBy(factor: number, anchorSec = this.playhead) {
    const before = this.timeToX(anchorSec);
    this.view.pxPerSec = Math.min(400, Math.max(4, this.view.pxPerSec * factor));
    this.view.scrollSec = anchorSec - (before - HEADER_W) / this.view.pxPerSec;
    if (this.view.scrollSec < 0) this.view.scrollSec = 0;
    this.draw();
  }

  /** Page-scrolls so the playhead stays visible during playback. */
  followPlayhead(t: number) {
    if (!this.project) return;
    const x = this.timeToX(t);
    if (x > this.cssW - 8 || x < HEADER_W) {
      // Jump so the playhead sits near the left edge (Premiere-style paging).
      this.view.scrollSec = Math.max(0, t - 8 / this.view.pxPerSec);
    }
  }

  /** Fit the whole project into view. */
  zoomToFit() {
    if (!this.project) return;
    const dur = timelineDuration(this.project) || 10;
    const avail = Math.max(200, this.cssW - HEADER_W);
    this.view.pxPerSec = Math.min(400, Math.max(4, avail / dur));
    this.view.scrollSec = 0;
    this.draw();
  }
}

/** Truncates text with an ellipsis to fit within maxW pixels. */
function fitText(c: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (c.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && c.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// Re-export for the app.
export { clipDuration, clipEnd };
