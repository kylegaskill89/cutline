/**
 * The editor data model: Project → Tracks → Clips, over a pool of Media.
 *
 * This is the backbone of the NLE. Every other subsystem (timeline UI, export
 * compiler, playback engine) is a function of this model, so it is kept pure
 * and heavily unit-tested: editing operations take a Project and return a NEW
 * Project, never mutating in place.
 */

export type TrackKind = "video" | "audio";

export interface Media {
  id: string;
  path: string;
  name: string;
  /** Source duration in seconds. For images: the default placement length. */
  duration: number;
  hasVideo: boolean;
  /** Number of audio streams in the source. */
  audioStreamCount: number;
  /** A still image (PNG/JPG/…) or GIF: looped on export, no inherent duration. */
  isImage?: boolean;
  /** An animated source (GIF): loops its animation rather than holding a frame. */
  isAnimated?: boolean;
  /** A generated text/title clip; `text` holds its content + styling. */
  isText?: boolean;
  text?: TextSpec;
  /** Video/image dimensions / frame rate (optional; used to pick export canvas). */
  width?: number;
  height?: number;
  fps?: number;
}

/** Styling for a text/title clip. fontSize is in canvas pixels. */
export interface TextSpec {
  content: string;
  fontSize: number;
  color: string;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  /** Optional solid background behind the text (null = transparent). */
  background: string | null;
  /** Outline colour (null = no stroke) and its width in canvas px. */
  strokeColor?: string | null;
  strokeWidth?: number;
  /** Drop shadow behind the text. */
  shadow?: boolean;
}

export const DEFAULT_TEXT: TextSpec = {
  content: "Text",
  fontSize: 96,
  color: "#ffffff",
  fontFamily: "system-ui, sans-serif",
  bold: true,
  italic: false,
  align: "center",
  background: null,
};

/** Default on-timeline length (seconds) for a freshly placed still image. */
export const DEFAULT_IMAGE_DURATION = 5;

export interface Clip {
  id: string;
  mediaId: string;
  kind: TrackKind;
  /** For audio clips: which source audio stream (the N in 0:a:N). */
  audioStream?: number;
  /** In/out points within the source media, in seconds. */
  sourceIn: number;
  sourceOut: number;
  /** Position on the timeline, in seconds. */
  start: number;
  /** Clips sharing a groupId move and cut together (Premiere-style link). */
  groupId: string | null;
  /** Per-clip linear audio gain (1 = unity). Undefined is treated as 1. */
  gain?: number;
  /** Per-clip opacity 0..1 for visual clips (1 = opaque). */
  opacity?: number;
  /** Fade in / out durations in seconds (alpha for video, gain for audio). */
  fadeIn?: number;
  fadeOut?: number;
  /** Visual transform (position/scale/rotation) for video-track clips. */
  transform?: Transform;
  /** Playback speed multiplier (1 = normal, 2 = 2x fast, 0.5 = slow-mo). */
  speed?: number;
  /** Play the clip's source backwards. */
  reverse?: boolean;
  /** A transition at this clip's out-edge, into the next abutting clip. */
  transitionOut?: Transition;
  /** Compositing blend mode against the layers below (default "normal"). */
  blend?: BlendMode;
  /** Disabled clips keep their place on the timeline but are not rendered. */
  disabled?: boolean;
  /** Per-property animation keyframes (clip-local timeline seconds → value). */
  keyframes?: Partial<Record<AnimProp, Keyframe[]>>;
  /** Ordered stack of visual effects applied before the transform/composite stage. */
  effects?: ClipEffect[];
}

/** One entry in a clip's effect stack. `type` keys into the effect registry. */
export interface ClipEffect {
  type: string;
  /** Disabled entries stay in the stack but contribute nothing (default enabled). */
  enabled?: boolean;
  params: Record<string, number>;
  /** Colour parameters (hex), e.g. the chroma-key colour. Not keyframeable. */
  colors?: Record<string, string>;
  /** Per-parameter animation keyframes (param key → clip-local keyframes). An
   *  animated param's `params[key]` value is ignored in favour of the keyframes. */
  keyframes?: Record<string, Keyframe[]>;
}

/** Properties that can be animated with keyframes over a clip's duration. */
export type AnimProp = "x" | "y" | "scaleX" | "scaleY" | "rotation" | "opacity";
export const ANIM_PROPS: AnimProp[] = ["x", "y", "scaleX", "scaleY", "rotation", "opacity"];

/** A keyframe: value `v` at clip-local timeline time `t` (seconds from the clip start). */
export interface Keyframe {
  t: number;
  v: number;
}

/** Whether a clip animates a given property (has ≥1 keyframe for it). */
export function isAnimated(c: Clip, prop: AnimProp): boolean {
  const k = c.keyframes?.[prop];
  return !!k && k.length > 0;
}

/** Linear interpolation across a sorted keyframe list, clamped at the ends. */
export function evalKeyframes(kfs: Keyframe[], localT: number): number {
  if (kfs.length === 0) return 0;
  if (localT <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (localT >= last.t) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (localT >= a.t && localT <= b.t) {
      const span = b.t - a.t;
      const f = span > 1e-9 ? (localT - a.t) / span : 0;
      return a.v + (b.v - a.v) * f;
    }
  }
  return last.v;
}

/** The transform at clip-local time `localT`, honouring any keyframes. */
export function animatedTransform(c: Clip, localT: number): Transform {
  const base = clipTransform(c);
  const val = (prop: AnimProp, fallback: number) =>
    isAnimated(c, prop) ? evalKeyframes(c.keyframes![prop]!, localT) : fallback;
  return {
    x: val("x", base.x),
    y: val("y", base.y),
    scaleX: val("scaleX", base.scaleX),
    scaleY: val("scaleY", base.scaleY),
    rotation: val("rotation", base.rotation),
  };
}

/** The opacity at clip-local time `localT`, honouring any keyframes (clamped 0..1). */
export function animatedOpacity(c: Clip, localT: number): number {
  if (!isAnimated(c, "opacity")) return clipOpacity(c);
  return Math.max(0, Math.min(1, evalKeyframes(c.keyframes!.opacity!, localT)));
}

/** The current value of an animatable property (animated at `localT`, else static). */
export function animatedValue(c: Clip, prop: AnimProp, localT: number): number {
  if (prop === "opacity") return animatedOpacity(c, localT);
  const tr = animatedTransform(c, localT);
  return tr[prop];
}

/** Sets (or replaces) a keyframe for a property at clip-local time `localT`. */
export function setKeyframe(
  p: Project,
  clipId: string,
  prop: AnimProp,
  localT: number,
  v: number,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c) return p;
  if (!c.keyframes) c.keyframes = {};
  const arr = c.keyframes[prop] ?? (c.keyframes[prop] = []);
  const i = arr.findIndex((k) => Math.abs(k.t - localT) < 1e-4);
  if (i >= 0) arr[i] = { t: localT, v };
  else {
    arr.push({ t: localT, v });
    arr.sort((a, b) => a.t - b.t);
  }
  return next;
}

/** Removes the keyframe near `localT` for a property (clears the prop if empty). */
export function removeKeyframeAt(
  p: Project,
  clipId: string,
  prop: AnimProp,
  localT: number,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c || !c.keyframes?.[prop]) return p;
  c.keyframes[prop] = c.keyframes[prop]!.filter((k) => Math.abs(k.t - localT) >= 1e-3);
  if (c.keyframes[prop]!.length === 0) delete c.keyframes[prop];
  return next;
}

/** Removes all keyframes for a property (turns animation off). */
export function clearKeyframes(p: Project, clipId: string, prop: AnimProp): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c || !c.keyframes) return p;
  delete c.keyframes[prop];
  return next;
}

/** A clip's effect stack (never undefined). */
export function clipEffects(c: Clip): ClipEffect[] {
  return c.effects ?? [];
}

/** Appends an effect (with its default params/colours) to a clip's stack. */
export function addClipEffect(
  p: Project,
  clipId: string,
  type: string,
  params: Record<string, number>,
  colors?: Record<string, string>,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c) return p;
  if (!c.effects) c.effects = [];
  const inst: ClipEffect = { type, params: { ...params } };
  if (colors && Object.keys(colors).length > 0) inst.colors = { ...colors };
  c.effects.push(inst);
  return next;
}

/** Sets a colour parameter of a clip's effect at `index`. */
export function setClipEffectColor(
  p: Project,
  clipId: string,
  index: number,
  key: string,
  value: string,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c || !c.effects || !c.effects[index]) return p;
  const e = c.effects[index];
  e.colors = { ...(e.colors ?? {}), [key]: value };
  return next;
}

/** Removes the effect at `index` from a clip's stack. */
export function removeClipEffect(p: Project, clipId: string, index: number): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c || !c.effects || index < 0 || index >= c.effects.length) return p;
  c.effects.splice(index, 1);
  if (c.effects.length === 0) delete c.effects;
  return next;
}

/** Toggles an effect's enabled flag (disabled = kept but inert). */
export function toggleClipEffect(p: Project, clipId: string, index: number): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c || !c.effects || !c.effects[index]) return p;
  const e = c.effects[index];
  e.enabled = e.enabled === false; // false -> true (enable), else -> false
  return next;
}

/** Sets one parameter of a clip's effect at `index`. */
export function setClipEffectParam(
  p: Project,
  clipId: string,
  index: number,
  key: string,
  value: number,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c || !c.effects || !c.effects[index]) return p;
  const e = c.effects[index];
  // If the param is animated, retarget its keyframe at `localT`? No — callers
  // route animated edits through setEffectKeyframe; this sets the static value.
  e.params = { ...e.params, [key]: value };
  return next;
}

/** Whether an effect parameter is animated (has ≥1 keyframe). */
export function isEffectParamAnimated(inst: ClipEffect, key: string): boolean {
  const k = inst.keyframes?.[key];
  return !!k && k.length > 0;
}

/** A single effect param's value at clip-local time `localT` (animated or static). */
export function effectParamAt(inst: ClipEffect, key: string, localT: number): number {
  if (isEffectParamAnimated(inst, key)) return evalKeyframes(inst.keyframes![key]!, localT);
  return inst.params[key] ?? 0;
}

/** Resolves all of an effect's params at `localT` (folds keyframes into values). */
function resolveEffectParams(inst: ClipEffect, localT: number): Record<string, number> {
  if (!inst.keyframes) return inst.params;
  const out = { ...inst.params };
  for (const key of Object.keys(inst.keyframes)) {
    const kfs = inst.keyframes[key];
    if (kfs && kfs.length > 0) out[key] = evalKeyframes(kfs, localT);
  }
  return out;
}

/**
 * A clip's effect stack with every animated parameter resolved to its value at
 * clip-local `localT`. The emitters (css/ffmpeg) read `params` only, so feeding
 * them the resolved stack renders the animation — in the preview and per export
 * slice alike.
 */
export function resolvedEffects(c: Clip, localT: number): ClipEffect[] {
  const eff = c.effects;
  if (!eff || eff.length === 0) return [];
  return eff.map((inst) =>
    inst.keyframes
      ? {
          type: inst.type,
          enabled: inst.enabled,
          colors: inst.colors,
          params: resolveEffectParams(inst, localT),
        }
      : inst,
  );
}

/** Whether any effect on the clip has animated parameters. */
export function clipHasEffectKeyframes(c: Clip): boolean {
  return !!c.effects?.some(
    (e) => e.keyframes && Object.values(e.keyframes).some((k) => k && k.length > 0),
  );
}

/** Sets (or replaces) a keyframe for an effect param at clip-local `localT`. */
export function setEffectKeyframe(
  p: Project,
  clipId: string,
  index: number,
  key: string,
  localT: number,
  v: number,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c || !c.effects || !c.effects[index]) return p;
  const e = c.effects[index];
  if (!e.keyframes) e.keyframes = {};
  const arr = e.keyframes[key] ?? (e.keyframes[key] = []);
  const i = arr.findIndex((k) => Math.abs(k.t - localT) < 1e-4);
  if (i >= 0) arr[i] = { t: localT, v };
  else {
    arr.push({ t: localT, v });
    arr.sort((a, b) => a.t - b.t);
  }
  return next;
}

/** Removes the effect-param keyframe near `localT` (clears the param if empty). */
export function removeEffectKeyframeAt(
  p: Project,
  clipId: string,
  index: number,
  key: string,
  localT: number,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  const e = c?.effects?.[index];
  if (!e || !e.keyframes?.[key]) return p;
  e.keyframes[key] = e.keyframes[key]!.filter((k) => Math.abs(k.t - localT) >= 1e-3);
  if (e.keyframes[key]!.length === 0) delete e.keyframes[key];
  if (Object.keys(e.keyframes).length === 0) delete e.keyframes;
  return next;
}

/** Removes all keyframes for an effect param (turns its animation off). */
export function clearEffectKeyframes(
  p: Project,
  clipId: string,
  index: number,
  key: string,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  const e = c?.effects?.[index];
  if (!e || !e.keyframes) return p;
  delete e.keyframes[key];
  if (Object.keys(e.keyframes).length === 0) delete e.keyframes;
  return next;
}

/** Clip-local times of every effect keyframe on the clip (for timeline markers). */
export function effectKeyframeTimes(c: Clip): number[] {
  const out: number[] = [];
  for (const e of c.effects ?? []) {
    for (const arr of Object.values(e.keyframes ?? {})) {
      for (const k of arr ?? []) out.push(k.t);
    }
  }
  return out;
}

/** Whether a clip contributes to the render (default true). */
export function clipEnabled(c: Clip): boolean {
  return !c.disabled;
}

/** A transition between this clip and the next abutting clip on its track. */
export type TransitionKind = "dissolve" | "dip-black";
export interface Transition {
  kind: TransitionKind;
  /** Total transition duration in seconds, centred on the cut. */
  duration: number;
}

/** Per-clip compositing modes (a subset shared by canvas + ffmpeg). */
export type BlendMode =
  | "normal"
  | "add"
  | "screen"
  | "multiply"
  | "overlay"
  | "darken"
  | "lighten"
  | "difference";

export const BLEND_MODES: BlendMode[] = [
  "normal",
  "add",
  "screen",
  "multiply",
  "overlay",
  "darken",
  "lighten",
  "difference",
];

export function clipBlend(c: Clip): BlendMode {
  return c.blend ?? "normal";
}

/** A clip's effective opacity (defaults to fully opaque). */
export function clipOpacity(c: Clip): number {
  return c.opacity ?? 1;
}

export function clipFadeIn(c: Clip): number {
  return c.fadeIn ?? 0;
}
export function clipFadeOut(c: Clip): number {
  return c.fadeOut ?? 0;
}

/** Allowed per-clip gain range (linear): 0 (silent) to 2 (~+6 dB). */
export const MAX_GAIN = 2;

/** A clip's effective linear gain (defaults to unity). */
export function clipGain(c: Clip): number {
  return c.gain ?? 1;
}

/**
 * Visual transform for a clip on a video track. Position is the clip centre as
 * a fraction of the output canvas (0.5,0.5 = centred); scaleX/scaleY are each
 * relative to the fit-to-canvas size (1 = fills that axis) and can differ for
 * non-proportional (stretched) scaling; rotation in degrees.
 */
export interface Transform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
}

export const DEFAULT_TRANSFORM: Transform = {
  x: 0.5,
  y: 0.5,
  scaleX: 1,
  scaleY: 1,
  rotation: 0,
};

export function clipTransform(c: Clip): Transform {
  return c.transform ?? DEFAULT_TRANSFORM;
}

export function isIdentityTransform(t: Transform): boolean {
  return t.x === 0.5 && t.y === 0.5 && t.scaleX === 1 && t.scaleY === 1 && t.rotation === 0;
}

export interface Track {
  id: string;
  kind: TrackKind;
  /** Optional user label shown in the track header (falls back to V1/A1…). */
  label?: string;
  /** Audio track muted (silent). */
  muted?: boolean;
  /** Audio track soloed (if any track is soloed, only soloed tracks are heard). */
  solo?: boolean;
  /** Locked: clips on it can't be selected/moved/trimmed. */
  locked?: boolean;
  /** Video track output hidden (the "eye" toggle). */
  hidden?: boolean;
  /** Custom lane height in px (overrides the default for its kind). */
  height?: number;
  /** Display order is the array order; clips within are kept sorted by start. */
  clips: Clip[];
}

/** A track's mutable header props. */
export type TrackProps = Pick<Track, "muted" | "solo" | "locked" | "hidden" | "height" | "label">;

/**
 * Whether an audio track is heard: not muted, and if any audio track is soloed,
 * only soloed tracks play.
 */
export function isTrackAudible(p: Project, track: Track): boolean {
  if (track.muted) return false;
  const anySolo = p.tracks.some((t) => t.kind === "audio" && t.solo);
  return !anySolo || !!track.solo;
}

/** A named point on the timeline ruler (Premiere-style sequence marker). */
export interface Marker {
  id: string;
  time: number;
  label?: string;
  color?: string;
}

export interface Project {
  media: Media[];
  tracks: Track[];
  markers?: Marker[];
}

// ------------------------------------------------------------------ ids --
let idCounter = 0;
/** Monotonic id generator. Reset between tests via `__resetIds`. */
export function newId(prefix = "id"): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}
export function __resetIds(): void {
  idCounter = 0;
}

// -------------------------------------------------------------- queries --
/** Playback speed (defaults to 1). Always > 0. */
export function clipSpeed(c: Clip): number {
  const s = c.speed ?? 1;
  return s > 0 ? s : 1;
}

/** Whether the clip plays its source backwards. */
export function clipReversed(c: Clip): boolean {
  return c.reverse ?? false;
}

/** Length of source consumed, in source seconds (before retiming). */
export function sourceSpan(c: Clip): number {
  return c.sourceOut - c.sourceIn;
}

/** Timeline duration = source span retimed by speed. */
export function clipDuration(c: Clip): number {
  return sourceSpan(c) / clipSpeed(c);
}

export function clipEnd(c: Clip): number {
  return c.start + clipDuration(c);
}

/**
 * The source-media time played at timeline time `t` (must be within the clip),
 * accounting for speed and reverse. Used by the preview and audio scheduler.
 */
export function sourceTimeAt(c: Clip, t: number): number {
  const lt = (t - c.start) * clipSpeed(c);
  return clipReversed(c) ? c.sourceOut - lt : c.sourceIn + lt;
}

/**
 * The source [in, out] range that plays during the timeline sub-window [a, b]
 * of the clip. Reverse-aware, so splitting/carving a retimed or reversed clip
 * keeps each piece's frames correct.
 */
function subSource(c: Clip, a: number, b: number): { sourceIn: number; sourceOut: number } {
  const spd = clipSpeed(c);
  const la = (a - c.start) * spd;
  const lb = (b - c.start) * spd;
  if (clipReversed(c)) {
    return { sourceIn: c.sourceOut - lb, sourceOut: c.sourceOut - la };
  }
  return { sourceIn: c.sourceIn + la, sourceOut: c.sourceIn + lb };
}

/** Total timeline length: the furthest clip end across all tracks. */
export function timelineDuration(p: Project): number {
  let max = 0;
  for (const t of p.tracks) {
    for (const c of t.clips) max = Math.max(max, clipEnd(c));
  }
  return max;
}

const TRANSITION_EPS = 1e-3;

/** How much unused source lies past each end of the clip (its trim "handles"). */
function sourceHandles(
  c: Clip,
  mediaDur: number,
): { head: number; tail: number } {
  const spd = clipSpeed(c);
  // Timeline seconds of source available before sourceIn / after sourceOut.
  const beforeIn = c.sourceIn / spd;
  const afterOut = (mediaDur - c.sourceOut) / spd;
  // Reverse swaps which physical handle feeds the head vs the tail edge.
  return clipReversed(c)
    ? { head: afterOut, tail: beforeIn }
    : { head: beforeIn, tail: afterOut };
}

/**
 * A video clip resolved for rendering, with any centred cross-dissolve expanded
 * into an actual timeline overlap by borrowing each clip's source handles. The
 * stored model keeps clips non-overlapping; this derives what the compositor and
 * preview draw. `xIn`/`xOut` are extra dissolve ramps (alpha), on top of manual
 * fades; the incoming clip is drawn OVER the outgoing one so `xIn` cross-fades.
 */
export interface VideoSeg {
  clip: Clip;
  start: number;
  end: number;
  sourceIn: number;
  sourceOut: number;
  xIn: number; // dissolve/dip in-ramp (seconds)
  xOut: number; // dip out-ramp (seconds)
  toBlack: boolean; // dip-to-black uses opaque fades (no cross-fade partner)
  /** Export keyframe baking: a fixed transform/opacity for this sampled slice. */
  fixedTransform?: Transform;
  fixedOpacity?: number; // when set, fades are already folded in (skip fade filter)
  /** Export keyframe baking: the effect stack with animated params resolved. */
  fixedEffects?: ClipEffect[];
}

/** Public: the source [in,out] a clip shows during timeline sub-window [a,b]. */
export function clipSubSource(c: Clip, a: number, b: number): { sourceIn: number; sourceOut: number } {
  return subSource(c, a, b);
}

/**
 * Resolves one video track's clips into draw segments, expanding dissolves into
 * overlaps. Pure and unit-tested. `mediaDurOf` returns a clip's source length
 * (Infinity for stills/text, which have unlimited handles).
 */
export function resolveVideoSegments(
  track: Track,
  mediaDurOf: (mediaId: string) => number,
): VideoSeg[] {
  const clips = [...track.clips].filter(clipEnabled).sort((a, b) => a.start - b.start);
  const segs: VideoSeg[] = clips.map((clip) => ({
    clip,
    start: clip.start,
    end: clipEnd(clip),
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    xIn: 0,
    xOut: 0,
    toBlack: false,
  }));
  const byId = new Map(segs.map((s) => [s.clip.id, s]));
  for (let i = 0; i < clips.length; i++) {
    const a = clips[i];
    const t = a.transitionOut;
    if (!t || t.duration <= 0) continue;
    const b = clips[i + 1];
    if (!b || Math.abs(b.start - clipEnd(a)) > TRANSITION_EPS) continue; // must abut
    const segA = byId.get(a.id)!;
    const segB = byId.get(b.id)!;
    const half = t.duration / 2;
    if (t.kind === "dip-black") {
      // Sequential opaque fades at the cut: A→black over [T-half,T], black→B
      // over [T,T+half]. No overlap, no handles needed.
      segA.xOut = Math.max(segA.xOut, half);
      segA.toBlack = true;
      segB.xIn = Math.max(segB.xIn, half);
      segB.toBlack = true;
      continue;
    }
    // Cross-dissolve: borrow up to `half` of handle from each side to overlap.
    const aTail = sourceHandles(a, mediaDurOf(a.mediaId)).tail;
    const bHead = sourceHandles(b, mediaDurOf(b.mediaId)).head;
    const aExt = Math.min(half, aTail);
    const bExt = Math.min(half, bHead);
    const overlap = aExt + bExt;
    if (overlap <= TRANSITION_EPS) continue; // no handles: nothing to dissolve
    const spdA = clipSpeed(a);
    const spdB = clipSpeed(b);
    // Extend A's tail forward and B's head backward, then cross-fade B in over
    // the whole overlap so A reaches 0 exactly as B reaches full.
    segA.end += aExt;
    if (clipReversed(a)) segA.sourceIn -= aExt * spdA;
    else segA.sourceOut += aExt * spdA;
    segB.start -= bExt;
    if (clipReversed(b)) segB.sourceOut += bExt * spdB;
    else segB.sourceIn -= bExt * spdB;
    segB.xIn = Math.max(segB.xIn, overlap);
  }
  return segs;
}

/** Enables or disables a set of clips (disabled = not rendered, keeps its slot). */
export function setClipsEnabled(p: Project, clipIds: string[], enabled: boolean): Project {
  const next = clone(p);
  const idSet = new Set(clipIds);
  for (const t of next.tracks) {
    for (const c of t.clips) {
      if (!idSet.has(c.id)) continue;
      if (enabled) delete c.disabled;
      else c.disabled = true;
    }
  }
  return next;
}

/** Sets a clip's compositing blend mode (or clears it back to normal). */
export function setClipBlend(p: Project, clipId: string, mode: BlendMode): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c) return p;
  if (mode === "normal") delete c.blend;
  else c.blend = mode;
  return next;
}

/** Sets or clears a cross-dissolve/dip transition on a clip's out-edge. */
export function setClipTransition(
  p: Project,
  clipId: string,
  transition: Transition | null,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c) return p;
  if (transition && transition.duration > 0) c.transitionOut = transition;
  else delete c.transitionOut;
  return next;
}

export function findClip(p: Project, clipId: string): Clip | undefined {
  for (const t of p.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return c;
  }
  return undefined;
}

export function trackOfClip(p: Project, clipId: string): Track | undefined {
  return p.tracks.find((t) => t.clips.some((c) => c.id === clipId));
}

/** Ids of every clip linked to `clipId` (including itself). */
export function groupMembers(p: Project, clipId: string): string[] {
  const clip = findClip(p, clipId);
  if (!clip) return [];
  if (clip.groupId === null) return [clip.id];
  const ids: string[] = [];
  for (const t of p.tracks) {
    for (const c of t.clips) {
      if (c.groupId === clip.groupId) ids.push(c.id);
    }
  }
  return ids;
}

/** The clip covering time `t` on a track, if any (start ≤ t < end). */
export function clipAtTime(track: Track, t: number): Clip | undefined {
  return track.clips.find((c) => t >= c.start && t < clipEnd(c));
}

// --------------------------------------------------------------- mutate --
function clone(p: Project): Project {
  return structuredClone(p);
}

function sortTrack(track: Track): void {
  track.clips.sort((a, b) => a.start - b.start);
}

export function addMedia(p: Project, media: Media): Project {
  const next = clone(p);
  next.media.push(media);
  return next;
}

/**
 * Places a media on the timeline at `start` seconds: one video clip (if the
 * media has video) plus one audio clip per source audio stream, all sharing a
 * fresh groupId so they stay linked. Requires a video track and enough audio
 * tracks to exist; audio clips fill audio tracks in order.
 */
/** A trimmed source sub-range (seconds) for placing part of a media. */
export interface SourceRange {
  in: number;
  out: number;
}

export function placeMedia(
  p: Project,
  mediaId: string,
  start: number,
  videoTrackId?: string,
  range?: SourceRange,
): Project {
  const media = p.media.find((m) => m.id === mediaId);
  if (!media) return p;
  const next = clone(p);
  const groupId = newId("grp");
  const videoTracks = next.tracks.filter((t) => t.kind === "video");
  const audioTracks = next.tracks.filter((t) => t.kind === "audio");
  // Drop onto a chosen video track (drag-and-drop), else the top one.
  const targetVideo =
    (videoTrackId && videoTracks.find((t) => t.id === videoTrackId)) || videoTracks[0];

  // Stills/text ignore source ranges (no inherent time); footage honours [in,out].
  const sIn = range && !media.isImage && !media.isText ? Math.max(0, range.in) : 0;
  const sOut =
    range && !media.isImage && !media.isText
      ? Math.min(media.duration, range.out)
      : media.duration;
  if (media.hasVideo && targetVideo) {
    const clip: Clip = {
      id: newId("clip"),
      mediaId,
      kind: "video",
      sourceIn: sIn,
      sourceOut: sOut,
      start,
      groupId,
    };
    targetVideo.clips.push(clip);
    sortTrack(targetVideo);
  }

  // Place each audio stream on an audio lane that's FREE over the clip's span,
  // using a distinct lane per stream and creating fresh lanes at the bottom when
  // none are free — so a clip dropped onto a second video track doesn't pile its
  // audio on top of another layer's audio.
  const audioEnd = start + (sOut - sIn);
  const laneFree = (t: Track) =>
    !t.clips.some((c) => start < clipEnd(c) && c.start < audioEnd);
  const usedLanes = new Set<string>();
  for (let s = 0; s < media.audioStreamCount; s++) {
    let track = audioTracks.find((t) => !usedLanes.has(t.id) && laneFree(t));
    if (!track) {
      track = { id: newId("track"), kind: "audio", clips: [] };
      next.tracks.push(track);
      audioTracks.push(track);
    }
    usedLanes.add(track.id);
    track.clips.push({
      id: newId("clip"),
      mediaId,
      kind: "audio",
      audioStream: s,
      sourceIn: sIn,
      sourceOut: sOut,
      start,
      groupId,
    });
    sortTrack(track);
  }
  return next;
}

/** Timeline length a media occupies when placed with an optional source range. */
export function placedLength(media: Media, range?: SourceRange): number {
  if (range && !media.isImage && !media.isText) {
    return Math.max(0, Math.min(media.duration, range.out) - Math.max(0, range.in));
  }
  return media.duration;
}

/**
 * Razor cut: splits every clip in `clipIds` that strictly spans `time` into two
 * abutting clips. To cut linked clips together, expand the selection with
 * `groupMembers` before calling.
 *
 * The right-hand pieces are placed in ONE fresh group (shared among them), so
 * the segment after the cut stays internally linked (its video + audio move
 * together) but is independent of the segment before the cut — you can drag the
 * two halves separately. Right pieces of an already-ungrouped clip stay
 * ungrouped.
 */
export function splitAt(p: Project, time: number, clipIds: string[]): Project {
  const next = clone(p);
  const idSet = new Set(clipIds);
  const rightGroupId = newId("grp");
  for (const track of next.tracks) {
    const added: Clip[] = [];
    for (const c of track.clips) {
      if (!idSet.has(c.id)) continue;
      if (time <= c.start || time >= clipEnd(c)) continue; // doesn't span
      const leftSrc = subSource(c, c.start, time);
      const rightSrc = subSource(c, time, clipEnd(c));
      const right: Clip = {
        ...c,
        id: newId("clip"),
        sourceIn: rightSrc.sourceIn,
        sourceOut: rightSrc.sourceOut,
        start: time,
        groupId: c.groupId === null ? null : rightGroupId,
      };
      c.sourceIn = leftSrc.sourceIn; // left clip shrinks to the cut
      c.sourceOut = leftSrc.sourceOut;
      added.push(right);
    }
    if (added.length) {
      track.clips.push(...added);
      sortTrack(track);
    }
  }
  return next;
}

/**
 * Moves a set of clips by `deltaTime` seconds and `deltaTrackIndex` tracks
 * (within the same kind). Clips are clamped so start ≥ 0. Pass a full group
 * (via `groupMembers`) to move linked clips together.
 */
export function moveClips(
  p: Project,
  clipIds: string[],
  deltaTime: number,
  deltaTrackIndex = 0,
  restrictKind?: TrackKind,
): Project {
  const next = clone(p);
  const idSet = new Set(clipIds);

  // Smallest start among moved clips, to clamp the whole set against 0.
  let minStart = Infinity;
  for (const t of next.tracks) {
    for (const c of t.clips) if (idSet.has(c.id)) minStart = Math.min(minStart, c.start);
  }
  if (minStart === Infinity) return next;
  const clampedDelta = Math.max(deltaTime, -minStart);

  // Collect moves first (clip, fromTrackIndex) so track reassignment is clean.
  interface Move {
    clip: Clip;
    fromTrack: Track;
  }
  const moves: Move[] = [];
  for (const track of next.tracks) {
    for (const c of track.clips) {
      if (idSet.has(c.id)) moves.push({ clip: c, fromTrack: track });
    }
  }

  const tracksByKind: Record<TrackKind, Track[]> = {
    video: next.tracks.filter((t) => t.kind === "video"),
    audio: next.tracks.filter((t) => t.kind === "audio"),
  };

  for (const { clip, fromTrack } of moves) {
    clip.start += clampedDelta;
    // Vertical track moves apply only to the dragged kind, so a linked group's
    // audio clips don't jump audio tracks when its video clip is dragged up.
    if (deltaTrackIndex !== 0 && (restrictKind === undefined || clip.kind === restrictKind)) {
      const kindTracks = tracksByKind[clip.kind];
      const curIdx = kindTracks.indexOf(fromTrack);
      const destIdx = curIdx + deltaTrackIndex;
      if (curIdx >= 0 && destIdx >= 0 && destIdx < kindTracks.length && destIdx !== curIdx) {
        const dest = kindTracks[destIdx];
        fromTrack.clips = fromTrack.clips.filter((x) => x.id !== clip.id);
        dest.clips.push(clip);
      }
    }
  }
  for (const t of next.tracks) sortTrack(t);
  return next;
}

/**
 * Moves clips like {@link moveClips}, but when a video clip is dragged onto a
 * DIFFERENT video track (setting up an overlay layer), its linked audio clips
 * are relocated onto audio lanes DEDICATED to that group — reusing audio tracks
 * that already hold only this group's clips (or are empty), and creating fresh
 * audio tracks at the bottom when none are free. This keeps the audio of
 * overlapping video layers from colliding on shared audio tracks.
 */
export function moveClipsLayered(
  p: Project,
  clipIds: string[],
  deltaTime: number,
  deltaTrackIndex = 0,
  kind: TrackKind = "video",
): Project {
  // First do the ordinary move (video changes track; audio keeps its lanes).
  const next = moveClips(p, clipIds, deltaTime, deltaTrackIndex, kind);
  if (kind !== "video" || deltaTrackIndex === 0) return next;

  const idSet = new Set(clipIds);
  const videoTrackIndex = (proj: Project, clipId: string) =>
    proj.tracks.filter((t) => t.kind === "video").findIndex((t) =>
      t.clips.some((c) => c.id === clipId),
    );
  const movedVideoIds = [...idSet].filter((id) => findClip(next, id)?.kind === "video");
  const changedTrack = movedVideoIds.some(
    (id) => videoTrackIndex(p, id) !== videoTrackIndex(next, id),
  );
  if (!changedTrack) return next;

  // The group's audio clips that came along with the move.
  const movedAudio = next.tracks
    .filter((t) => t.kind === "audio")
    .flatMap((t) => t.clips)
    .filter((c) => idSet.has(c.id));
  if (movedAudio.length === 0) return next;

  const movedAudioIds = new Set(movedAudio.map((c) => c.id));
  const groupId = movedAudio[0].groupId;
  // A lane is dedicated-eligible if every clip on it is this group's (or is one
  // of the clips we're relocating) — i.e. no other layer's audio lives there.
  const eligible = (t: Track) =>
    t.clips.every((c) => movedAudioIds.has(c.id) || (groupId !== null && c.groupId === groupId));

  const audioTracks = next.tracks.filter((t) => t.kind === "audio");
  const used = new Set<string>(); // tracks already assigned in this reflow
  for (const ac of movedAudio) {
    const curTrack = audioTracks.find((t) => t.clips.some((c) => c.id === ac.id));
    let dest: Track | undefined;
    if (curTrack && !used.has(curTrack.id) && eligible(curTrack)) {
      dest = curTrack; // already on a dedicated lane — leave it
    } else {
      dest = audioTracks.find((t) => !used.has(t.id) && eligible(t));
    }
    if (!dest) {
      dest = { id: newId("track"), kind: "audio", clips: [] };
      next.tracks.push(dest);
      audioTracks.push(dest);
    }
    if (curTrack && curTrack !== dest) {
      curTrack.clips = curTrack.clips.filter((c) => c.id !== ac.id);
      dest.clips.push(ac);
    }
    used.add(dest.id);
  }
  for (const t of next.tracks) sortTrack(t);
  return next;
}

/** Minimum clip length in seconds, enforced when trimming edges. */
export const MIN_CLIP = 0.05;

/**
 * Trims a clip's left ("in") or right ("out") edge to a new timeline time,
 * moving the whole LINKED GROUP together so video + its audio stay in sync.
 * Dragging "in" shifts start and sourceIn (head); "out" changes sourceOut
 * (tail). The drag delta is clamped to the tightest limit across every group
 * member — its source bounds, a minimum length, and neighbouring clips.
 */
export function setClipEdge(
  p: Project,
  clipId: string,
  edge: "in" | "out",
  timelineTime: number,
): Project {
  const next = clone(p);
  const target = findClip(next, clipId);
  if (!target) return p;

  const memberIds = new Set(groupMembers(next, clipId));
  const members: { clip: Clip; track: Track }[] = [];
  for (const t of next.tracks) {
    for (const c of t.clips) if (memberIds.has(c.id)) members.push({ clip: c, track: t });
  }

  // Desired delta comes from the clip actually being dragged.
  const desired =
    edge === "in" ? timelineTime - target.start : timelineTime - clipEnd(target);

  // Intersect each member's allowable delta range.
  let lo = -Infinity;
  let hi = Infinity;
  for (const { clip, track } of members) {
    const m = next.media.find((mm) => mm.id === clip.mediaId);
    // Stills / text have no source limit, so their out-edge can extend freely.
    const mediaDur = m ? (m.isImage || m.isText ? Infinity : m.duration) : Infinity;
    const spd = clipSpeed(clip);
    const rev = clipReversed(clip);
    const dur = clipDuration(clip);
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    const idx = sorted.indexOf(clip);
    const prev = sorted[idx - 1];
    const nxt = sorted[idx + 1];
    // Source deltas are the timeline delta scaled by speed; reverse swaps which
    // source edge (in vs out) the timeline edge is anchored to.
    if (edge === "in") {
      let memberLo = Math.max(
        -clip.start, // start >= 0
        prev ? clipEnd(prev) - clip.start : -Infinity, // no overlap with prev
      );
      // Extending the head (delta<0) is bounded by available source on that side.
      memberLo = Math.max(
        memberLo,
        rev ? -(mediaDur - clip.sourceOut) / spd : -clip.sourceIn / spd,
      );
      const memberHi = dur - MIN_CLIP; // keep min length
      lo = Math.max(lo, memberLo);
      hi = Math.min(hi, memberHi);
    } else {
      const memberLo = MIN_CLIP - dur; // keep min length
      let memberHi = nxt ? nxt.start - clipEnd(clip) : Infinity; // no overlap with next
      // Extending the tail (delta>0) is bounded by available source on that side.
      memberHi = Math.min(
        memberHi,
        rev ? clip.sourceIn / spd : (mediaDur - clip.sourceOut) / spd,
      );
      lo = Math.max(lo, memberLo);
      hi = Math.min(hi, memberHi);
    }
  }
  if (lo > hi) return next; // over-constrained: no room to trim
  const delta = Math.max(lo, Math.min(desired, hi));

  for (const { clip } of members) {
    const spd = clipSpeed(clip);
    const rev = clipReversed(clip);
    if (edge === "in") {
      clip.start += delta;
      if (rev) clip.sourceOut -= delta * spd;
      else clip.sourceIn += delta * spd;
    } else {
      if (rev) clip.sourceIn -= delta * spd;
      else clip.sourceOut += delta * spd;
    }
  }
  for (const t of next.tracks) sortTrack(t);
  return next;
}

/**
 * Ripple-delete: removes the given clips (and their linked groups) and closes
 * the gap, pulling every later clip on ALL tracks left by the removed span so
 * the sequence stays in sync (Shift+Delete in Premiere).
 */
export function rippleDelete(p: Project, clipIds: string[]): Project {
  const ids = new Set<string>();
  for (const id of clipIds) for (const m of groupMembers(p, id)) ids.add(m);
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const t of p.tracks) {
    for (const c of t.clips) {
      if (!ids.has(c.id)) continue;
      minStart = Math.min(minStart, c.start);
      maxEnd = Math.max(maxEnd, clipEnd(c));
    }
  }
  if (!Number.isFinite(minStart)) return p;
  const ripple = maxEnd - minStart;
  const next = clone(p);
  for (const t of next.tracks) {
    t.clips = t.clips.filter((c) => !ids.has(c.id));
    for (const c of t.clips) if (c.start >= maxEnd - 1e-6) c.start -= ripple;
    sortTrack(t);
  }
  return next;
}

/** Splits any clip spanning `atTime`, then opens a gap of `amount` seconds by
 *  shifting everything at/after `atTime` right (used by Insert editing). */
export function rippleInsert(p: Project, atTime: number, amount: number): Project {
  const spanning: string[] = [];
  for (const t of p.tracks) {
    for (const c of t.clips) if (atTime > c.start && atTime < clipEnd(c)) spanning.push(c.id);
  }
  const next = clone(splitAt(p, atTime, spanning));
  for (const t of next.tracks) {
    for (const c of t.clips) if (c.start >= atTime - 1e-6) c.start += amount;
    sortTrack(t);
  }
  return next;
}

/** Carves clips out of [start, end) on one track (splitting/trimming as needed). */
function clearRange(track: Track, start: number, end: number): void {
  const kept: Clip[] = [];
  for (const c of track.clips) {
    const cs = c.start;
    const ce = clipEnd(c);
    if (ce <= start || cs >= end) {
      kept.push(c);
    } else if (cs >= start && ce <= end) {
      // fully covered: drop it
    } else if (cs < start && ce > end) {
      // spans the region: keep a left part and a right part
      const leftSrc = subSource(c, cs, start);
      const rightSrc = subSource(c, end, ce);
      const right: Clip = {
        ...c,
        id: newId("clip"),
        sourceIn: rightSrc.sourceIn,
        sourceOut: rightSrc.sourceOut,
        start: end,
      };
      c.sourceIn = leftSrc.sourceIn;
      c.sourceOut = leftSrc.sourceOut; // trim tail to start
      kept.push(c, right);
    } else if (cs < start) {
      const leftSrc = subSource(c, cs, start); // trim tail to start
      c.sourceIn = leftSrc.sourceIn;
      c.sourceOut = leftSrc.sourceOut;
      kept.push(c);
    } else {
      const rightSrc = subSource(c, end, ce); // trim head to end
      c.sourceIn = rightSrc.sourceIn;
      c.sourceOut = rightSrc.sourceOut;
      c.start = end;
      kept.push(c);
    }
  }
  track.clips = kept;
  sortTrack(track);
}

/** Insert-edit a media at `atTime`: ripples the sequence open, then places it. */
export function insertMediaAt(
  p: Project,
  mediaId: string,
  atTime: number,
  videoTrackId?: string,
  range?: SourceRange,
): Project {
  const media = p.media.find((m) => m.id === mediaId);
  if (!media) return p;
  const rippled = rippleInsert(p, atTime, placedLength(media, range));
  return placeMedia(rippled, mediaId, atTime, videoTrackId, range);
}

/** Overwrite-edit a media at `atTime`: carves out what's under it, then places it. */
export function overwriteMediaAt(
  p: Project,
  mediaId: string,
  atTime: number,
  videoTrackId?: string,
  range?: SourceRange,
): Project {
  const media = p.media.find((m) => m.id === mediaId);
  if (!media) return p;
  const next = clone(p);
  const end = atTime + placedLength(media, range);
  const videoTracks = next.tracks.filter((t) => t.kind === "video");
  const audioTracks = next.tracks.filter((t) => t.kind === "audio");
  const targetVideo =
    (videoTrackId && videoTracks.find((t) => t.id === videoTrackId)) || videoTracks[0];
  if (media.hasVideo && targetVideo) clearRange(targetVideo, atTime, end);
  for (let s = 0; s < media.audioStreamCount; s++) {
    if (audioTracks[s]) clearRange(audioTracks[s], atTime, end);
  }
  return placeMedia(next, mediaId, atTime, targetVideo?.id, range);
}

/** Sets a clip's linear audio gain, clamped to [0, MAX_GAIN]. */
export function setClipGain(p: Project, clipId: string, gain: number): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c) return p;
  c.gain = Math.min(MAX_GAIN, Math.max(0, gain));
  return next;
}

/**
 * Sets a clip's fade-in or fade-out duration (seconds), clamped so the two
 * fades never exceed the clip's length.
 */
export function setClipFade(
  p: Project,
  clipId: string,
  edge: "in" | "out",
  dur: number,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c) return p;
  const len = clipDuration(c);
  const other = edge === "in" ? clipFadeOut(c) : clipFadeIn(c);
  const v = Math.max(0, Math.min(dur, len - other));
  if (edge === "in") c.fadeIn = v;
  else c.fadeOut = v;
  return next;
}

export const MIN_SPEED = 0.05;
export const MAX_SPEED = 100;

/**
 * Sets a clip's playback speed (and optional reverse), applied to the whole
 * linked group so video and its audio retime together. The clip keeps its
 * source in/out; its timeline length changes with speed. Fades are re-clamped
 * to the new (possibly shorter) duration.
 */
export function setClipSpeed(
  p: Project,
  clipId: string,
  speed: number,
  reverse?: boolean,
): Project {
  const next = clone(p);
  const spd = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  const ids = new Set(groupMembers(next, clipId));
  for (const t of next.tracks) {
    for (const c of t.clips) {
      if (!ids.has(c.id)) continue;
      c.speed = spd;
      if (reverse !== undefined) c.reverse = reverse;
      const len = clipDuration(c);
      const fi = Math.min(clipFadeIn(c), len);
      const fo = Math.min(clipFadeOut(c), len - fi);
      if (c.fadeIn !== undefined) c.fadeIn = fi;
      if (c.fadeOut !== undefined) c.fadeOut = fo;
    }
    sortTrack(t);
  }
  return next;
}

/**
 * Rate-stretch: drag a clip edge to change its SPEED (and duration) instead of
 * trimming source. The source in/out stay fixed; speed = sourceSpan / newLength.
 * Applied to the whole linked group so A/V stay together.
 */
export function rateStretchEdge(
  p: Project,
  clipId: string,
  edge: "in" | "out",
  newTime: number,
): Project {
  const next = clone(p);
  const target = findClip(next, clipId);
  if (!target) return p;
  const newDur = Math.max(
    MIN_CLIP,
    edge === "out" ? newTime - target.start : clipEnd(target) - newTime,
  );
  const ids = new Set(groupMembers(next, clipId));
  for (const t of next.tracks) {
    for (const c of t.clips) {
      if (!ids.has(c.id)) continue;
      const oldEnd = clipEnd(c);
      const spd = Math.min(MAX_SPEED, Math.max(MIN_SPEED, sourceSpan(c) / newDur));
      c.speed = spd;
      if (edge === "in") c.start = oldEnd - clipDuration(c); // keep the tail anchored
    }
    sortTrack(t);
  }
  return next;
}

/**
 * Slip: shift what part of the source a clip shows (sourceIn/out by `dSource`
 * source-seconds) WITHOUT moving the clip or changing its length. Applied to the
 * linked group so A/V slip together, clamped to every member's media bounds.
 */
export function slipClip(p: Project, clipId: string, dSource: number): Project {
  const next = clone(p);
  const ids = new Set(groupMembers(next, clipId));
  const members: Clip[] = [];
  for (const t of next.tracks) for (const c of t.clips) if (ids.has(c.id)) members.push(c);
  // Intersect the allowable shift across members (skip stills/text — no source).
  let lo = -Infinity;
  let hi = Infinity;
  for (const c of members) {
    const m = next.media.find((mm) => mm.id === c.mediaId);
    if (!m || m.isImage || m.isText) continue;
    lo = Math.max(lo, -c.sourceIn); // sourceIn + d >= 0
    hi = Math.min(hi, m.duration - c.sourceOut); // sourceOut + d <= mediaDur
  }
  if (!Number.isFinite(lo)) lo = 0;
  if (!Number.isFinite(hi)) hi = 0;
  const d = Math.max(lo, Math.min(dSource, hi));
  for (const c of members) {
    const m = next.media.find((mm) => mm.id === c.mediaId);
    if (!m || m.isImage || m.isText) continue;
    c.sourceIn += d;
    c.sourceOut += d;
  }
  return next;
}

/**
 * Slide: move a clip in time by `dTime`, growing the abutting previous clip and
 * shrinking the next (their positions stay put) so the sequence length is
 * unchanged. The slid clip's source is untouched. Single-clip (its own track).
 */
export function slideClip(p: Project, clipId: string, dTime: number): Project {
  const next = clone(p);
  const track = next.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  if (!track) return p;
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((c) => c.id === clipId);
  const c = sorted[i];
  const prev = sorted[i - 1];
  const next2 = sorted[i + 1];
  const eps = 1e-3;
  const hasPrev = prev && Math.abs(clipEnd(prev) - c.start) < eps;
  const hasNext = next2 && Math.abs(clipEnd(c) - next2.start) < eps;
  if (!hasPrev && !hasNext) return p; // nothing to slide against
  // Clamp the slide by neighbours' handles and minimum lengths.
  let lo = -Infinity;
  let hi = Infinity;
  lo = Math.max(lo, -c.start); // start >= 0
  if (hasPrev) {
    const pm = next.media.find((mm) => mm.id === prev.mediaId);
    const pDur = pm && !pm.isImage && !pm.isText ? pm.duration : Infinity;
    hi = Math.min(hi, (pDur - prev.sourceOut) / clipSpeed(prev)); // prev tail handle
    lo = Math.max(lo, MIN_CLIP - clipDuration(prev)); // prev keeps min length
  }
  if (hasNext) {
    lo = Math.max(lo, -next2.sourceIn / clipSpeed(next2)); // next head handle
    hi = Math.min(hi, clipDuration(next2) - MIN_CLIP); // next keeps min length
  }
  if (lo > hi) return p;
  const d = Math.max(lo, Math.min(dTime, hi));
  if (Math.abs(d) < 1e-6) return next;
  c.start += d;
  if (hasPrev) prev.sourceOut += d * clipSpeed(prev);
  if (hasNext) {
    next2.start += d;
    next2.sourceIn += d * clipSpeed(next2);
  }
  sortTrack(track);
  return next;
}

/** Sets a clip's opacity, clamped to [0, 1]. */
export function setClipOpacity(p: Project, clipId: string, opacity: number): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c) return p;
  c.opacity = Math.min(1, Math.max(0, opacity));
  return next;
}

/** Merges a partial transform into a clip's transform. */
export function setClipTransform(
  p: Project,
  clipId: string,
  patch: Partial<Transform>,
): Project {
  const next = clone(p);
  const c = findClip(next, clipId);
  if (!c) return p;
  c.transform = { ...clipTransform(c), ...patch };
  return next;
}

/** Merges a partial text spec into a text media. */
export function setTextSpec(p: Project, mediaId: string, patch: Partial<TextSpec>): Project {
  const next = clone(p);
  const m = next.media.find((mm) => mm.id === mediaId);
  if (!m || !m.text) return p;
  m.text = { ...m.text, ...patch };
  return next;
}

/** Removes the given clips from whatever group they belong to (makes them independent). */
export function unlinkClips(p: Project, clipIds: string[]): Project {
  const next = clone(p);
  const idSet = new Set(clipIds);
  for (const t of next.tracks) {
    for (const c of t.clips) if (idSet.has(c.id)) c.groupId = null;
  }
  return next;
}

/** Removes the given clips from wherever they live. */
export function removeClips(p: Project, clipIds: string[]): Project {
  const next = clone(p);
  const idSet = new Set(clipIds);
  for (const t of next.tracks) t.clips = t.clips.filter((c) => !idSet.has(c.id));
  return next;
}

/** Links clips into one group so they move/cut together. */
export function linkClips(p: Project, clipIds: string[]): Project {
  if (clipIds.length < 2) return p;
  const next = clone(p);
  const groupId = newId("grp");
  const idSet = new Set(clipIds);
  for (const t of next.tracks) {
    for (const c of t.clips) if (idSet.has(c.id)) c.groupId = groupId;
  }
  return next;
}

/** Unlinks a clip's group (all members become independent). */
export function unlinkGroup(p: Project, clipId: string): Project {
  const clip = findClip(p, clipId);
  if (!clip || clip.groupId === null) return p;
  const next = clone(p);
  const gid = clip.groupId;
  for (const t of next.tracks) {
    for (const c of t.clips) if (c.groupId === gid) c.groupId = null;
  }
  return next;
}

/**
 * Adds an empty video track at the top of the stack (array front), so it is
 * the topmost compositing layer — new overlay footage goes on top.
 */
export function addVideoTrack(p: Project): Project {
  const next = clone(p);
  next.tracks.unshift({ id: newId("track"), kind: "video", clips: [] });
  return next;
}

/** Adds an empty audio track at the bottom of the stack. */
export function addAudioTrack(p: Project): Project {
  const next = clone(p);
  next.tracks.push({ id: newId("track"), kind: "audio", clips: [] });
  return next;
}

/** Sets (or clears, with an empty string) a track's display label. */
export function setTrackLabel(p: Project, trackId: string, label: string): Project {
  const next = clone(p);
  const track = next.tracks.find((t) => t.id === trackId);
  if (!track) return p;
  const trimmed = label.trim();
  if (trimmed) track.label = trimmed;
  else delete track.label;
  return next;
}

/** Merges header props into a track (mute/solo/lock/hide/height/label). */
export function updateTrack(p: Project, trackId: string, patch: Partial<TrackProps>): Project {
  const next = clone(p);
  const track = next.tracks.find((t) => t.id === trackId);
  if (!track) return p;
  Object.assign(track, patch);
  return next;
}

// -------------------------------------------------------------- markers --
export function projectMarkers(p: Project): Marker[] {
  return p.markers ?? [];
}

/** Marker within `tol` seconds of `time`, if any (nearest first). */
export function markerNear(p: Project, time: number, tol: number): Marker | undefined {
  let best: Marker | undefined;
  let bd = tol;
  for (const m of projectMarkers(p)) {
    const d = Math.abs(m.time - time);
    if (d <= bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}

/** Adds a marker at `time` (kept sorted). */
export function addMarker(p: Project, time: number, label?: string, color?: string): Project {
  const next = clone(p);
  const markers = next.markers ?? (next.markers = []);
  markers.push({ id: newId("mark"), time, label, color });
  markers.sort((a, b) => a.time - b.time);
  return next;
}

export function removeMarker(p: Project, id: string): Project {
  const next = clone(p);
  next.markers = projectMarkers(next).filter((m) => m.id !== id);
  return next;
}

export function clearMarkers(p: Project): Project {
  const next = clone(p);
  next.markers = [];
  return next;
}

/** Nearest marker strictly after / before `time` (for jump-to-marker nav). */
export function nextMarker(p: Project, time: number): Marker | undefined {
  return projectMarkers(p).find((m) => m.time > time + 1e-4);
}
export function prevMarker(p: Project, time: number): Marker | undefined {
  const before = projectMarkers(p).filter((m) => m.time < time - 1e-4);
  return before.length ? before[before.length - 1] : undefined;
}

/** Removes a track and all clips on it. */
export function removeTrack(p: Project, trackId: string): Project {
  const next = clone(p);
  next.tracks = next.tracks.filter((t) => t.id !== trackId);
  return next;
}

// ------------------------------------------------------------ factories --
export function emptyProject(videoTracks = 1, audioTracks = 2): Project {
  const tracks: Track[] = [];
  for (let i = 0; i < videoTracks; i++)
    tracks.push({ id: newId("track"), kind: "video", clips: [] });
  for (let i = 0; i < audioTracks; i++)
    tracks.push({ id: newId("track"), kind: "audio", clips: [] });
  return { media: [], tracks };
}
