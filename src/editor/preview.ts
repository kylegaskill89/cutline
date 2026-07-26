/**
 * Compositing preview.
 *
 * Replaces the raw <video> display with a <canvas> that composites every
 * visual clip active at the playhead — each drawn with its transform
 * (position / scale / rotation). Video frames come from a small pool of hidden
 * <video> source elements (muted; audio is handled by the AudioEngine). The
 * selected clip gets on-canvas handles: drag body to move, corners to scale, a
 * top handle to rotate. Image/text clips will slot into the same draw loop.
 */
import { assetUrl } from "../tauri/sidecar.ts";
import {
  clipEnd,
  clipFadeIn,
  clipFadeOut,
  clipSpeed,
  clipReversed,
  clipBlend,
  animatedTransform,
  animatedOpacity,
  resolvedEffects,
  isStillLike,
  sourceTimeAt,
  resolveVideoSegments,
  type Project,
  type Clip,
  type Media,
  type Transform,
  type VideoSeg,
  type BlendMode,
} from "../core/project.ts";
import { cssFilterFor, flipFactorsFor } from "../core/effects.ts";
import { ChromaKeyer, sourceDims } from "./chromaKey.ts";
import { matteFill } from "./matteRender.ts";
import { layoutText, drawTextCentred } from "./textRender.ts";

/** Blend mode → canvas globalCompositeOperation. */
const BLEND_OP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  add: "lighter",
  screen: "screen",
  multiply: "multiply",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
};

const HANDLE_R = 7;
const ROTATE_OFFSET = 26; // css px above the box for the rotate handle
const MAX_SOURCES = 8;
const SNAP_PX = 9; // pull distance (css px) for canvas-edge/centre snapping

export interface PreviewCallbacks {
  onTransformBegin: () => void;
  onTransform: (clipId: string, patch: Partial<Transform>) => void;
  onTransformEnd: () => void;
}

interface Src {
  el: HTMLVideoElement;
  mediaId: string | null;
  ready: boolean;
  lastUsed: number;
  /** Last good decoded frame, blitted whenever the element momentarily has no
   *  current data (e.g. mid-seek during reverse, or just after a cut) so the
   *  preview never flashes black. */
  frame?: HTMLCanvasElement;
  /** True once we've retried this load without CORS (self-heal, see loadInto). */
  corsRetried?: boolean;
}

/** Decoded animated-GIF frames, timed off the timeline playhead (so it scrubs). */
interface GifFrame {
  frame: CanvasImageSource;
  dur: number; // seconds
}
interface GifState {
  ready: boolean;
  loading: boolean;
  frames: GifFrame[];
  total: number; // total animation duration (seconds)
}

type DragKind = "move" | "scale" | "rotate";
interface TransformDrag {
  kind: DragKind;
  clipId: string;
  center: { x: number; y: number };
  grabOffset: { x: number; y: number };
  rad: number; // rotation, to map the pointer into the clip's local frame
  initialScaleX: number;
  initialScaleY: number;
  initialHalfW: number; // css half-extents at drag start (for per-axis scaling)
  initialHalfH: number;
  halfWFrac: number; // half box size as a fraction of the canvas (for snapping)
  halfHFrac: number;
  cornerSX: number; // sign (-1|1) of the grabbed corner in the clip's local frame
  cornerSY: number;
  anchorX: number; // css position of the opposite (fixed) corner while scaling
  anchorY: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
const clampScale = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

export class Preview {
  private ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  private sources: Src[] = [];
  private byClip = new Map<string, Src>();
  private images = new Map<string, HTMLImageElement>(); // still-image sources by media id
  private gifs = new Map<string, GifState>(); // decoded animated GIFs by media id
  private keyer = new ChromaKeyer(); // shared offscreen chroma-key pass
  private tdrag: TransformDrag | null = null;
  private snapX: number | null = null; // css x of an active vertical snap guide
  private snapY: number | null = null; // css y of an active horizontal snap guide

  project: Project | null = null;
  playhead = 0;
  playing = false;
  rate = 1; // playback rate for the video sources (used by J/K/L shuttle)
  selectedClipId: string | null = null;
  /** When true, corner-scaling is proportional by default (Shift inverts). */
  lockAspect = true;
  canvasW = 1920; // project canvas dimensions
  canvasH = 1080;

  constructor(
    private canvas: HTMLCanvasElement,
    private sourceHost: HTMLElement,
    private cb: PreviewCallbacks,
  ) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onHover(e));
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
  }

  // ---- projection (project px <-> css px, letterboxed) ----
  private displayScale(): number {
    return Math.min(this.cssW / this.canvasW, this.cssH / this.canvasH);
  }
  private offset(): { ox: number; oy: number } {
    const s = this.displayScale();
    return {
      ox: (this.cssW - this.canvasW * s) / 2,
      oy: (this.cssH - this.canvasH * s) / 2,
    };
  }
  private projToCss(px: number, py: number): { x: number; y: number } {
    const s = this.displayScale();
    const { ox, oy } = this.offset();
    return { x: ox + px * s, y: oy + py * s };
  }

  // ---- video source pool ----
  private acquire(clip: Clip): Src {
    const existing = this.byClip.get(clip.id);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing;
    }
    let src = this.sources.find((s) => s.mediaId === null);
    if (!src && this.sources.length < MAX_SOURCES) {
      const el = document.createElement("video");
      el.muted = true;
      el.playsInline = true;
      el.preload = "auto";
      this.sourceHost.appendChild(el);
      src = { el, mediaId: null, ready: false, lastUsed: 0 };
      this.sources.push(src);
    }
    if (!src) {
      // Evict the least-recently-used source not needed this frame.
      src = [...this.sources].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      for (const [id, s] of this.byClip) if (s === src) this.byClip.delete(id);
    }
    this.loadInto(src, clip);
    this.byClip.set(clip.id, src);
    return src;
  }

  /** Copies the element's current frame into the source's cache canvas, so it
   *  can be re-blitted on frames where the element has no fresh data. */
  private captureFrame(src: Src) {
    const el = src.el;
    if (el.readyState < 2 || el.videoWidth === 0) return;
    if (!src.frame) src.frame = document.createElement("canvas");
    if (src.frame.width !== el.videoWidth || src.frame.height !== el.videoHeight) {
      src.frame.width = el.videoWidth;
      src.frame.height = el.videoHeight;
    }
    const fc = src.frame.getContext("2d");
    if (fc) fc.drawImage(el, 0, 0);
  }

  private loadInto(src: Src, clip: Clip) {
    const media = this.project!.media.find((m) => m.id === clip.mediaId)!;
    src.mediaId = clip.mediaId;
    src.ready = false;
    src.frame = undefined; // stale frame from a previously-loaded media
    src.corsRetried = false;
    src.lastUsed = performance.now();
    // Request the frames CORS-readable so the chroma keyer can sample pixels
    // (the Tauri asset protocol serves cross-origin). If that makes the load
    // fail, self-heal by retrying once without CORS — normal playback is then
    // fine and only pixel-reading effects (chroma key) are unavailable.
    src.el.crossOrigin = "anonymous";
    src.el.src = assetUrl(media.path);
    const onReady = () => {
      src.ready = true;
      try {
        src.el.currentTime = clip.sourceIn;
      } catch {
        /* ignore */
      }
      cleanup();
    };
    const onError = () => {
      if (!src.corsRetried && src.el.crossOrigin) {
        src.corsRetried = true;
        src.el.removeAttribute("crossorigin");
        src.el.load(); // retry the same src without CORS
        return;
      }
      cleanup();
    };
    const cleanup = () => {
      src.el.removeEventListener("loadeddata", onReady);
      src.el.removeEventListener("error", onError);
    };
    src.el.addEventListener("loadeddata", onReady);
    src.el.addEventListener("error", onError);
    src.el.load();
  }

  private mediaDurOf = (mediaId: string): number => {
    const m = this.project?.media.find((mm) => mm.id === mediaId);
    return m ? (isStillLike(m) ? Infinity : m.duration) : Infinity;
  };

  /**
   * Video segments active at time `t`, transition-expanded so a cross-dissolve's
   * borrowed handles and cross-fade are drawn. Base track first, top last.
   */
  private activeVideoSegments(t: number): { seg: VideoSeg; layer: number }[] {
    if (!this.project) return [];
    const out: { seg: VideoSeg; layer: number }[] = [];
    // Video tracks are stored top-first; reverse so base draws first.
    const videoTracks = this.project.tracks.filter((tr) => tr.kind === "video");
    [...videoTracks].reverse().forEach((track, layer) => {
      if (track.hidden) return; // video output toggled off (the "eye")
      for (const seg of resolveVideoSegments(track, this.mediaDurOf)) {
        if (t >= seg.start && t < seg.end) out.push({ seg, layer });
      }
    });
    // Within a frame, draw earlier-starting segments first so a dissolve's
    // incoming clip lands on top of the outgoing one.
    out.sort((a, b) => a.layer - b.layer || a.seg.start - b.seg.start);
    return out;
  }

  /** Natural size of a clip's content in canvas pixels at scale 1. */
  private naturalSize(media: Media | undefined): { w: number; h: number } {
    if (media?.isText && media.text) {
      const l = layoutText(this.ctx, media.text);
      return { w: l.width, h: l.height };
    }
    const mw = media?.width || this.canvasW;
    const mh = media?.height || this.canvasH;
    // Fit media to canvas (aspect-preserved) so scale 1 fills the canvas.
    const baseFit = Math.min(this.canvasW / mw, this.canvasH / mh);
    return { w: mw * baseFit, h: mh * baseFit };
  }

  /** The clip's transform evaluated at the current playhead (honours keyframes). */
  private effTransform(clip: Clip): Transform {
    return animatedTransform(clip, this.playhead - clip.start);
  }

  // ---- per-clip draw geometry (css) ----
  private clipGeometry(clip: Clip) {
    const media = this.mediaOf(clip);
    const nat = this.naturalSize(media);
    const tr = this.effTransform(clip);
    const fitW = nat.w * tr.scaleX; // canvas px
    const fitH = nat.h * tr.scaleY;
    const s = this.displayScale();
    const center = this.projToCss(tr.x * this.canvasW, tr.y * this.canvasH);
    return { center, wCss: fitW * s, hCss: fitH * s, rad: (tr.rotation * Math.PI) / 180 };
  }

  // ---- main frame ----
  render() {
    const c = this.ctx;
    c.clearRect(0, 0, this.cssW, this.cssH);
    // Pasteboard behind the canvas, so the canvas bounds are visible.
    c.fillStyle = "#0b0d10";
    c.fillRect(0, 0, this.cssW, this.cssH);
    if (!this.project) return;

    // The canvas (output) rect, letterboxed into the css area.
    const s = this.displayScale();
    const { ox, oy } = this.offset();
    const cw = this.canvasW * s;
    const ch = this.canvasH * s;
    c.fillStyle = "#000000";
    c.fillRect(ox, oy, cw, ch);

    const now = performance.now();
    const active = this.activeVideoSegments(this.playhead);
    const activeIds = new Set(active.map((a) => a.seg.clip.id));

    // Clip all clip drawing to the canvas bounds: anything dragged off the
    // canvas is cut off in the preview, exactly as it will be on export.
    c.save();
    c.beginPath();
    c.rect(ox, oy, cw, ch);
    c.clip();
    for (const { seg } of active) {
      const clip = seg.clip;
      const media = this.mediaOf(clip);
      if (media?.isText) {
        this.drawTextClip(seg, media);
        continue;
      }
      if (media?.isColor) {
        this.drawColorClip(seg, media);
        continue;
      }
      if (media?.isImage) {
        if (media.isAnimated) {
          this.drawGif(seg, media);
          continue;
        }
        const img = this.acquireImage(media);
        if (img.complete && img.naturalWidth > 0) this.drawTransformed(seg, img);
        continue;
      }
      const src = this.acquire(clip);
      src.lastUsed = now;
      const expected = Math.min(
        Math.max(seg.sourceIn, sourceTimeAt(clip, this.playhead)),
        seg.sourceOut - 0.001,
      );
      // A reversed clip can't be played backwards by a <video> element, so it is
      // driven frame-by-frame via seeking (like the paused path), even while
      // playing. Forward clips play at shuttle-rate × clip-speed for smoothness.
      const seekDriven = !this.playing || clipReversed(clip);
      if (src.ready) {
        if (!seekDriven) {
          const pr = this.rate * clipSpeed(clip);
          if (src.el.playbackRate !== pr) src.el.playbackRate = pr;
          if (src.el.paused) void src.el.play();
          if (Math.abs(src.el.currentTime - expected) > 0.3) src.el.currentTime = expected;
        } else {
          if (!src.el.paused) src.el.pause();
          // Only issue a new seek when the previous one has finished, so rapid
          // scrubbing/reverse keeps showing frames instead of going black.
          if (!src.el.seeking && Math.abs(src.el.currentTime - expected) > 0.05) {
            src.el.currentTime = expected;
          }
        }
        this.captureFrame(src); // refresh the cached frame when data is present
      }
      // Prefer the live element; fall back to the cached frame when the element
      // momentarily has no current data (reverse seek / just after a cut) so the
      // clip region never flashes to black.
      if (src.ready && src.el.readyState >= 2 && src.el.videoWidth > 0) {
        this.drawTransformed(seg, src.el);
      } else if (src.frame) {
        this.drawTransformed(seg, src.frame);
      }
    }
    c.restore();

    // Canvas outline (drawn over the pasteboard, outside the clip region).
    c.strokeStyle = "#2b313a";
    c.lineWidth = 1;
    c.strokeRect(ox + 0.5, oy + 0.5, cw - 1, ch - 1);

    // Preload clips starting soon so cuts stay gapless (like the old buffer).
    const LOOKAHEAD = 3;
    for (const track of this.project.tracks) {
      if (track.kind !== "video") continue;
      const next = track.clips
        .filter((c) => c.start > this.playhead && c.start <= this.playhead + LOOKAHEAD)
        .sort((a, b) => a.start - b.start)[0];
      if (!next) continue;
      const media = this.mediaOf(next);
      if (media?.isImage) {
        if (media.isAnimated) this.ensureGif(media);
        else this.acquireImage(media);
      } else {
        const nsrc = this.acquire(next);
        // Park the source on the incoming clip's first frame and cache it, so the
        // cut shows that frame immediately instead of a black gap while decoding.
        if (nsrc.ready && !nsrc.el.seeking) {
          const first = clipReversed(next) ? next.sourceOut - 0.001 : next.sourceIn;
          if (Math.abs(nsrc.el.currentTime - first) > 0.05) {
            nsrc.el.currentTime = first; // captured on a later pass once settled
          } else {
            this.captureFrame(nsrc);
          }
        }
      }
    }

    // Pause any source not active this frame.
    for (const s of this.sources) {
      const stillActive = [...this.byClip].some(
        ([id, src]) => src === s && activeIds.has(id),
      );
      if (!stillActive && !s.el.paused) s.el.pause();
    }

    if (!this.overlaysHidden) {
      this.drawHandles();
      this.drawSnapGuides();
    }
  }

  private overlaysHidden = false;

  /**
   * Renders one clean frame (no selection handles/guides) and returns just the
   * canvas (output) region as an offscreen canvas at device resolution — used to
   * save a snapshot of the current frame.
   */
  snapshotCanvas(): HTMLCanvasElement | null {
    this.overlaysHidden = true;
    try {
      this.render();
    } finally {
      this.overlaysHidden = false;
    }
    const dpr = this.canvas.width / Math.max(1, this.cssW);
    const s = this.displayScale();
    const { ox, oy } = this.offset();
    const sx = Math.round(ox * dpr);
    const sy = Math.round(oy * dpr);
    const sw = Math.round(this.canvasW * s * dpr);
    const sh = Math.round(this.canvasH * s * dpr);
    if (sw <= 0 || sh <= 0) return null;
    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.drawImage(this.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    this.render(); // restore normal frame (with overlays)
    return out;
  }

  /** Cyan guide lines shown while a clip snaps to a canvas edge/centre. */
  private drawSnapGuides() {
    if (this.snapX === null && this.snapY === null) return;
    const c = this.ctx;
    c.save();
    c.strokeStyle = "#3fd0ff";
    c.lineWidth = 1;
    c.setLineDash([5, 4]);
    if (this.snapX !== null) {
      c.beginPath();
      c.moveTo(this.snapX + 0.5, 0);
      c.lineTo(this.snapX + 0.5, this.cssH);
      c.stroke();
    }
    if (this.snapY !== null) {
      c.beginPath();
      c.moveTo(0, this.snapY + 0.5);
      c.lineTo(this.cssW, this.snapY + 0.5);
      c.stroke();
    }
    c.restore();
  }

  private mediaOf(clip: Clip): Media | undefined {
    return this.project?.media.find((m) => m.id === clip.mediaId);
  }

  private acquireImage(media: Media): HTMLImageElement {
    let img = this.images.get(media.id);
    if (!img) {
      img = new Image();
      // CORS-readable so the chroma keyer can sample pixels; self-heal to a
      // plain load if the asset protocol rejects the CORS request.
      img.crossOrigin = "anonymous";
      let retried = false;
      const el = img;
      el.addEventListener("error", () => {
        if (!retried && el.crossOrigin) {
          retried = true;
          el.removeAttribute("crossorigin");
          el.src = assetUrl(media.path);
        }
      });
      img.src = assetUrl(media.path);
      this.images.set(media.id, img);
    }
    return img;
  }

  /** Ensures an animated GIF's frames are being (or have been) decoded. */
  private ensureGif(media: Media): GifState {
    let st = this.gifs.get(media.id);
    if (!st) {
      st = { ready: false, loading: false, frames: [], total: 0 };
      this.gifs.set(media.id, st);
    }
    if (!st.ready && !st.loading) void this.loadGif(media, st);
    return st;
  }

  private async loadGif(media: Media, st: GifState) {
    st.loading = true;
    const Decoder = (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder as
      | (new (init: { data: ArrayBuffer; type: string }) => {
          tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
          decode: (o: { frameIndex: number }) => Promise<{ image: CanvasImageSource & { duration?: number } }>;
        })
      | undefined;
    try {
      if (!Decoder) return; // no WebCodecs: fall back to the static first frame
      const buf = await (await fetch(assetUrl(media.path))).arrayBuffer();
      const dec = new Decoder({ data: buf, type: "image/gif" });
      await dec.tracks.ready;
      const count = dec.tracks.selectedTrack?.frameCount ?? 1;
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        const dur = (image.duration ?? 100000) / 1e6; // µs -> s
        st.frames.push({ frame: image, dur: dur > 0 ? dur : 0.1 });
        st.total += st.frames[st.frames.length - 1].dur;
      }
    } catch {
      /* leave frames empty -> static fallback */
    } finally {
      st.ready = true;
      st.loading = false;
    }
  }

  /** Draws the GIF frame matching the playhead position within the clip. */
  private drawGif(seg: VideoSeg, media: Media) {
    const st = this.ensureGif(media);
    if (st.frames.length === 0) {
      // Not decoded yet (or unsupported): show the static first frame.
      const img = this.acquireImage(media);
      if (img.complete && img.naturalWidth > 0) this.drawTransformed(seg, img);
      return;
    }
    let t = (this.playhead - seg.clip.start) % st.total;
    if (t < 0) t += st.total;
    let acc = 0;
    let idx = st.frames.length - 1;
    for (let i = 0; i < st.frames.length; i++) {
      acc += st.frames[i].dur;
      if (t < acc) {
        idx = i;
        break;
      }
    }
    this.drawTransformed(seg, st.frames[idx].frame);
  }

  /** Renders a text/title clip directly with its transform (matches export). */
  private drawTextClip(seg: VideoSeg, media: Media) {
    if (!media.text) return;
    const tr = this.effTransform(seg.clip);
    const s = this.displayScale();
    const center = this.projToCss(tr.x * this.canvasW, tr.y * this.canvasH);
    const layout = layoutText(this.ctx, media.text);
    const c = this.ctx;
    c.save();
    c.globalAlpha = this.visualAlpha(seg);
    c.globalCompositeOperation = BLEND_OP[clipBlend(seg.clip)];
    const rEffects = resolvedEffects(seg.clip, this.playhead - seg.clip.start);
    const filter = cssFilterFor(rEffects);
    if (filter) c.filter = filter;
    const flip = flipFactorsFor(rEffects);
    c.translate(center.x, center.y);
    c.rotate((tr.rotation * Math.PI) / 180);
    c.scale(s * tr.scaleX * flip.sx, s * tr.scaleY * flip.sy); // px->css, per-axis scale, flip
    drawTextCentred(c, media.text, layout);
    c.restore();
  }

  /** Renders a colour-matte clip: fills its transformed rect with the matte colour. */
  private drawColorClip(seg: VideoSeg, media: Media) {
    const g = this.clipGeometry(seg.clip);
    const c = this.ctx;
    c.save();
    c.globalAlpha = this.visualAlpha(seg);
    c.globalCompositeOperation = BLEND_OP[clipBlend(seg.clip)];
    const filter = cssFilterFor(resolvedEffects(seg.clip, this.playhead - seg.clip.start));
    if (filter) c.filter = filter;
    c.translate(g.center.x, g.center.y);
    c.rotate(g.rad);
    c.fillStyle = matteFill(c, media, -g.wCss / 2, -g.hCss / 2, g.wCss, g.hCss);
    c.fillRect(-g.wCss / 2, -g.hCss / 2, g.wCss, g.hCss);
    c.restore();
  }

  /**
   * Combined opacity × fade alpha at the playhead, over the segment's (possibly
   * transition-expanded) bounds. Dissolve/dip ramps are folded into the fades.
   */
  private visualAlpha(seg: VideoSeg): number {
    const clip = seg.clip;
    let a = animatedOpacity(clip, this.playhead - clip.start);
    const local = this.playhead - seg.start;
    const len = seg.end - seg.start;
    const fi = Math.max(clipFadeIn(clip), seg.xIn);
    const fo = Math.max(clipFadeOut(clip), seg.xOut);
    if (fi > 0 && local < fi) a *= Math.max(0, local / fi);
    const tail = len - local;
    if (fo > 0 && tail < fo) a *= Math.max(0, tail / fo);
    return a;
  }

  /** Draws any image source (video frame or still) with the clip's transform. */
  private drawTransformed(seg: VideoSeg, source: CanvasImageSource) {
    const g = this.clipGeometry(seg.clip);
    const c = this.ctx;
    const rEffects = resolvedEffects(seg.clip, this.playhead - seg.clip.start);
    // Chroma key (if present) punches out the key colour on an offscreen buffer;
    // remaining CSS-filter effects then apply to that keyed frame.
    const draw = this.chromaKeyed(rEffects, source) ?? source;
    c.save();
    c.globalAlpha = this.visualAlpha(seg);
    c.globalCompositeOperation = BLEND_OP[clipBlend(seg.clip)];
    const filter = cssFilterFor(rEffects);
    if (filter) c.filter = filter;
    c.translate(g.center.x, g.center.y);
    c.rotate(g.rad);
    const flip = flipFactorsFor(rEffects);
    if (flip.sx !== 1 || flip.sy !== 1) c.scale(flip.sx, flip.sy);
    try {
      c.drawImage(draw, -g.wCss / 2, -g.hCss / 2, g.wCss, g.hCss);
    } catch {
      /* frame not decodable yet */
    }
    c.restore();
  }

  /** Runs the source through the chroma keyer if the stack has an enabled
   *  chroma-key effect; returns the keyed canvas, or null to draw as-is. */
  private chromaKeyed(
    rEffects: ReturnType<typeof resolvedEffects>,
    source: CanvasImageSource,
  ): CanvasImageSource | null {
    const key = rEffects.find((e) => e.type === "chromakey" && e.enabled !== false);
    if (!key) return null;
    const dim = sourceDims(source);
    if (!dim) return null;
    return this.keyer.key(
      source,
      dim.w,
      dim.h,
      key.colors?.color ?? "#00d000",
      (key.params.similarity ?? 30) / 100,
      (key.params.blend ?? 10) / 100,
    );
  }

  private selectedVisualClip(): Clip | null {
    if (!this.project || !this.selectedClipId) return null;
    for (const t of this.project.tracks) {
      if (t.kind !== "video") continue;
      const c = t.clips.find((x) => x.id === this.selectedClipId);
      if (c && this.playhead >= c.start && this.playhead < clipEnd(c)) return c;
    }
    return null;
  }

  private drawHandles() {
    const clip = this.selectedVisualClip();
    if (!clip) return;
    const g = this.clipGeometry(clip);
    const c = this.ctx;
    c.save();
    c.translate(g.center.x, g.center.y);
    c.rotate(g.rad);

    // Bounding box.
    c.strokeStyle = "#2ecc71";
    c.lineWidth = 1.5;
    c.strokeRect(-g.wCss / 2, -g.hCss / 2, g.wCss, g.hCss);

    // Corner scale handles.
    c.fillStyle = "#2ecc71";
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      c.beginPath();
      c.arc((sx * g.wCss) / 2, (sy * g.hCss) / 2, HANDLE_R, 0, Math.PI * 2);
      c.fill();
    }

    // Rotate handle.
    const ry = -g.hCss / 2 - ROTATE_OFFSET;
    c.beginPath();
    c.moveTo(0, -g.hCss / 2);
    c.lineTo(0, ry);
    c.stroke();
    c.beginPath();
    c.arc(0, ry, HANDLE_R, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  // ---- interaction ----
  private localPoint(clip: Clip, cssX: number, cssY: number) {
    const g = this.clipGeometry(clip);
    const dx = cssX - g.center.x;
    const dy = cssY - g.center.y;
    const cos = Math.cos(-g.rad);
    const sin = Math.sin(-g.rad);
    return { lx: dx * cos - dy * sin, ly: dx * sin + dy * cos, g };
  }

  private hitTest(clip: Clip, cssX: number, cssY: number): DragKind | null {
    const { lx, ly, g } = this.localPoint(clip, cssX, cssY);
    const corners = [
      [-g.wCss / 2, -g.hCss / 2],
      [g.wCss / 2, -g.hCss / 2],
      [g.wCss / 2, g.hCss / 2],
      [-g.wCss / 2, g.hCss / 2],
    ];
    for (const [hx, hy] of corners) {
      if (Math.hypot(lx - hx, ly - hy) <= HANDLE_R + 2) return "scale";
    }
    if (Math.hypot(lx - 0, ly - (-g.hCss / 2 - ROTATE_OFFSET)) <= HANDLE_R + 2) return "rotate";
    if (Math.abs(lx) <= g.wCss / 2 && Math.abs(ly) <= g.hCss / 2) return "move";
    return null;
  }

  private onHover(e: PointerEvent) {
    if (this.tdrag) return;
    const clip = this.selectedVisualClip();
    if (!clip) {
      this.canvas.style.cursor = "default";
      return;
    }
    const { x, y } = this.canvasPoint(e);
    const hit = this.hitTest(clip, x, y);
    this.canvas.style.cursor =
      hit === "move" ? "move" : hit === "scale" ? "nwse-resize" : hit === "rotate" ? "grab" : "default";
  }

  private canvasPoint(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown(e: PointerEvent) {
    const clip = this.selectedVisualClip();
    if (!clip) return;
    const { x, y } = this.canvasPoint(e);
    const kind = this.hitTest(clip, x, y);
    if (!kind) return;
    const tr = this.effTransform(clip);
    const g = this.clipGeometry(clip);
    const sNow = this.displayScale();
    const center = this.projToCss(tr.x * this.canvasW, tr.y * this.canvasH);
    const iHalfW = Math.max(1, g.wCss / 2);
    const iHalfH = Math.max(1, g.hCss / 2);

    // Which corner is grabbed (sign in the clip's local frame), and the opposite
    // corner's world position — that stays fixed while scaling.
    const { lx, ly } = this.localPoint(clip, x, y);
    const cornerSX = lx >= 0 ? 1 : -1;
    const cornerSY = ly >= 0 ? 1 : -1;
    const cosr = Math.cos(g.rad);
    const sinr = Math.sin(g.rad);
    const laX = -cornerSX * iHalfW;
    const laY = -cornerSY * iHalfH;
    const anchorX = center.x + laX * cosr - laY * sinr;
    const anchorY = center.y + laX * sinr + laY * cosr;

    this.tdrag = {
      kind,
      clipId: clip.id,
      center,
      grabOffset: { x: x - center.x, y: y - center.y },
      rad: g.rad,
      initialScaleX: tr.scaleX,
      initialScaleY: tr.scaleY,
      initialHalfW: iHalfW,
      initialHalfH: iHalfH,
      halfWFrac: g.wCss / 2 / sNow / this.canvasW,
      halfHFrac: g.hCss / 2 / sNow / this.canvasH,
      cornerSX,
      cornerSY,
      anchorX,
      anchorY,
    };
    this.canvas.setPointerCapture(e.pointerId);
    this.cb.onTransformBegin();
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragUp);
  }

  private onDragMove = (e: PointerEvent) => {
    if (!this.tdrag) return;
    const { x, y } = this.canvasPoint(e);
    const d = this.tdrag;
    const s = this.displayScale();
    const { ox, oy } = this.offset();

    if (d.kind === "move") {
      const cx = x - d.grabOffset.x;
      const cy = y - d.grabOffset.y;
      let px = (cx - ox) / s / this.canvasW;
      let py = (cy - oy) / s / this.canvasH;

      // Snap the clip's centre and edges to the canvas centre and edges
      // (hold Alt to disable snapping).
      this.snapX = null;
      this.snapY = null;
      if (!e.altKey) {
        const cw = this.canvasW * s;
        const ch = this.canvasH * s;
        const thrX = SNAP_PX / cw;
        const thrY = SNAP_PX / ch;
        const xt = [
          { v: 0.5, guide: ox + cw / 2 },
          { v: d.halfWFrac, guide: ox },
          { v: 1 - d.halfWFrac, guide: ox + cw },
        ];
        for (const t of xt) {
          if (Math.abs(px - t.v) < thrX) {
            px = t.v;
            this.snapX = t.guide;
            break;
          }
        }
        const yt = [
          { v: 0.5, guide: oy + ch / 2 },
          { v: d.halfHFrac, guide: oy },
          { v: 1 - d.halfHFrac, guide: oy + ch },
        ];
        for (const t of yt) {
          if (Math.abs(py - t.v) < thrY) {
            py = t.v;
            this.snapY = t.guide;
            break;
          }
        }
      }

      this.cb.onTransform(d.clipId, {
        x: Math.min(1.5, Math.max(-0.5, px)),
        y: Math.min(1.5, Math.max(-0.5, py)),
      });
    } else if (d.kind === "scale") {
      // Scale about the OPPOSITE corner (it stays fixed); work in the clip's
      // rotated local frame relative to that anchor.
      const cosr = Math.cos(d.rad);
      const sinr = Math.sin(d.rad);
      const rx = x - d.anchorX;
      const ry = y - d.anchorY;
      const vx = rx * cosr + ry * sinr; // R(-rad) · (pointer - anchor)
      const vy = -rx * sinr + ry * cosr;
      let newHalfW: number;
      let newHalfH: number;
      // Locked ratio scales proportionally; Shift inverts (so you can always
      // get the other behaviour on the fly), matching the panel's Lock toggle.
      if (this.lockAspect !== e.shiftKey) {
        // Proportional: uniform ratio from the dominant axis.
        const r = Math.max(
          Math.abs(vx) / (2 * d.initialHalfW),
          Math.abs(vy) / (2 * d.initialHalfH),
        );
        newHalfW = d.initialHalfW * r;
        newHalfH = d.initialHalfH * r;
      } else {
        newHalfW = Math.abs(vx) / 2;
        newHalfH = Math.abs(vy) / 2;
      }
      // New centre sits half a box from the anchor, back along the grabbed corner.
      const lcx = d.cornerSX * newHalfW;
      const lcy = d.cornerSY * newHalfH;
      const centerX = d.anchorX + lcx * cosr - lcy * sinr;
      const centerY = d.anchorY + lcx * sinr + lcy * cosr;
      this.cb.onTransform(d.clipId, {
        scaleX: clampScale((d.initialScaleX * newHalfW) / d.initialHalfW),
        scaleY: clampScale((d.initialScaleY * newHalfH) / d.initialHalfH),
        x: (centerX - ox) / s / this.canvasW,
        y: (centerY - oy) / s / this.canvasH,
      });
    } else {
      const deg = (Math.atan2(y - d.center.y, x - d.center.x) * 180) / Math.PI + 90;
      this.cb.onTransform(d.clipId, { rotation: deg });
    }
  };

  private onDragUp = () => {
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragUp);
    if (this.tdrag) this.cb.onTransformEnd();
    this.tdrag = null;
    this.snapX = null;
    this.snapY = null;
  };
}
