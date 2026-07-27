/**
 * Effect registry: the single source of truth for per-clip visual effects.
 *
 * Each effect defines its parameters once plus TWO pure emitters:
 *  - css(params)    → a CSS `filter` fragment the canvas preview applies via
 *                     `ctx.filter` (so the Program monitor shows the effect live).
 *  - ffmpeg(params) → an FFmpeg filter fragment the export compiler splices into
 *                     the clip's chain (so the rendered file matches the preview).
 *
 * One definition, two renderers keeps preview↔export in parity by construction.
 * Colour maths differ slightly between the browser and FFmpeg, so results are
 * close but not guaranteed pixel-identical (documented for the user).
 *
 * Pure and dependency-free (just data + string builders) so it is unit-tested
 * without a browser or ffmpeg.
 */
import type { ClipEffect } from "./project.ts";

export interface EffectParam {
  key: string;
  label: string;
  min: number;
  max: number;
  /** Neutral/default value — the value at which the effect is a no-op. */
  def: number;
  step: number;
  unit?: string;
  /** "slider" (default) shows a range+number; "toggle" shows a checkbox (0/1)
   *  and is not keyframeable. */
  kind?: "slider" | "toggle";
}

/** A colour (hex) parameter — not keyframeable, edited with a colour picker. */
export interface EffectColorParam {
  key: string;
  label: string;
  def: string; // "#rrggbb"
}

export interface EffectDef {
  id: string;
  label: string;
  params: EffectParam[];
  /** Colour parameters (e.g. the key colour for chroma key). */
  colors?: EffectColorParam[];
  /** CSS `filter` fragment, or "" when neutral / not CSS-expressible. */
  css: (p: Record<string, number>, colors: Record<string, string>) => string;
  /** FFmpeg filter fragment, or "" when neutral. */
  ffmpeg: (p: Record<string, number>, colors: Record<string, string>) => string;
}

/** Reads a param with an explicit fallback (used inside emitters). */
function getP(p: Record<string, number>, key: string, def: number): number {
  const raw = p[key];
  return raw === undefined || Number.isNaN(raw) ? def : raw;
}

export const EFFECTS: EffectDef[] = [
  {
    id: "brightness",
    label: "Brightness",
    params: [{ key: "amount", label: "Amount", min: -100, max: 100, def: 0, step: 1 }],
    css: (p) => {
      const a = getP(p, "amount", 0);
      return a === 0 ? "" : `brightness(${(1 + a / 100).toFixed(3)})`;
    },
    ffmpeg: (p) => {
      const a = getP(p, "amount", 0);
      return a === 0 ? "" : `eq=brightness=${(a / 100).toFixed(3)}`;
    },
  },
  {
    id: "contrast",
    label: "Contrast",
    params: [{ key: "amount", label: "Amount", min: 0, max: 300, def: 100, step: 1, unit: "%" }],
    css: (p) => {
      const a = getP(p, "amount", 100);
      return a === 100 ? "" : `contrast(${(a / 100).toFixed(3)})`;
    },
    ffmpeg: (p) => {
      const a = getP(p, "amount", 100);
      return a === 100 ? "" : `eq=contrast=${(a / 100).toFixed(3)}`;
    },
  },
  {
    id: "saturation",
    label: "Saturation",
    params: [{ key: "amount", label: "Amount", min: 0, max: 300, def: 100, step: 1, unit: "%" }],
    css: (p) => {
      const a = getP(p, "amount", 100);
      return a === 100 ? "" : `saturate(${(a / 100).toFixed(3)})`;
    },
    ffmpeg: (p) => {
      const a = getP(p, "amount", 100);
      return a === 100 ? "" : `eq=saturation=${(a / 100).toFixed(3)}`;
    },
  },
  {
    id: "hue",
    label: "Hue",
    params: [{ key: "angle", label: "Angle", min: -180, max: 180, def: 0, step: 1, unit: "°" }],
    css: (p) => {
      const a = getP(p, "angle", 0);
      return a === 0 ? "" : `hue-rotate(${a.toFixed(0)}deg)`;
    },
    ffmpeg: (p) => {
      const a = getP(p, "angle", 0);
      return a === 0 ? "" : `hue=h=${a.toFixed(1)}`;
    },
  },
  {
    id: "blur",
    label: "Gaussian Blur",
    params: [{ key: "amount", label: "Blur", min: 0, max: 50, def: 0, step: 0.5, unit: "px" }],
    css: (p) => {
      const a = getP(p, "amount", 0);
      return a <= 0 ? "" : `blur(${a.toFixed(1)}px)`;
    },
    ffmpeg: (p) => {
      const a = getP(p, "amount", 0);
      return a <= 0 ? "" : `gblur=sigma=${a.toFixed(2)}`;
    },
  },
  {
    id: "grayscale",
    label: "Black & White",
    params: [{ key: "amount", label: "Amount", min: 0, max: 100, def: 100, step: 1, unit: "%" }],
    css: (p) => {
      const a = getP(p, "amount", 100);
      return a <= 0 ? "" : `grayscale(${(a / 100).toFixed(3)})`;
    },
    ffmpeg: (p) => {
      const a = getP(p, "amount", 100);
      return a <= 0 ? "" : `hue=s=${(1 - a / 100).toFixed(3)}`;
    },
  },
  {
    id: "invert",
    label: "Invert",
    params: [{ key: "on", label: "Invert colors", min: 0, max: 1, def: 1, step: 1, kind: "toggle" }],
    css: (p) => (getP(p, "on", 1) >= 0.5 ? "invert(1)" : ""),
    ffmpeg: (p) => (getP(p, "on", 1) >= 0.5 ? "negate" : ""),
  },
  {
    // Flip is not a CSS filter — the preview mirrors via ctx.scale (see
    // flipFactorsFor); export uses ffmpeg hflip/vflip. Exact in both.
    id: "flip",
    label: "Flip",
    params: [
      { key: "horizontal", label: "Horizontal", min: 0, max: 1, def: 1, step: 1, kind: "toggle" },
      { key: "vertical", label: "Vertical", min: 0, max: 1, def: 0, step: 1, kind: "toggle" },
    ],
    css: () => "",
    ffmpeg: (p) => {
      const parts: string[] = [];
      if (getP(p, "horizontal", 0) >= 0.5) parts.push("hflip");
      if (getP(p, "vertical", 0) >= 0.5) parts.push("vflip");
      return parts.join(",");
    },
  },
  {
    // Chroma key (green screen): not a CSS filter — the preview keys it on an
    // offscreen canvas, and export uses ffmpeg's `chromakey`. `css` returns ""
    // so it never contributes to the ctx.filter string.
    id: "chromakey",
    label: "Chroma Key",
    params: [
      { key: "similarity", label: "Similarity", min: 1, max: 100, def: 30, step: 1, unit: "%" },
      { key: "blend", label: "Edge Blend", min: 0, max: 100, def: 10, step: 1, unit: "%" },
    ],
    colors: [{ key: "color", label: "Key Color", def: "#00d000" }],
    css: () => "",
    ffmpeg: (p, colors) => {
      const sim = getP(p, "similarity", 30) / 100;
      const bl = getP(p, "blend", 10) / 100;
      const hex = (colors.color ?? "#00d000").replace("#", "0x");
      return `chromakey=${hex}:${sim.toFixed(3)}:${bl.toFixed(3)}`;
    },
  },
  {
    // Vignette: darkens toward the edges. Export uses ffmpeg's `vignette`; the
    // preview approximates it with a radial-gradient overlay (see
    // vignetteAmountFor) — close but not pixel-identical.
    id: "vignette",
    label: "Vignette",
    params: [{ key: "amount", label: "Amount", min: 0, max: 100, def: 40, step: 1, unit: "%" }],
    css: () => "",
    ffmpeg: (p) => {
      const a = getP(p, "amount", 0);
      if (a <= 0) return "";
      const angle = Math.min(Math.PI / 2, (a / 100) * (Math.PI / 2));
      return `vignette=a=${angle.toFixed(4)}`;
    },
  },
  {
    // Crop: cuts a fraction off each edge, keeping the frame size (cropped edges
    // become transparent, revealing lower tracks / black on a plain track). Not a
    // CSS filter — the preview draws the kept sub-rectangle (see cropFractionsFor);
    // export crops then pads back to the original size at the same offset.
    id: "crop",
    label: "Crop",
    params: [
      { key: "left", label: "Left", min: 0, max: 45, def: 0, step: 1, unit: "%" },
      { key: "top", label: "Top", min: 0, max: 45, def: 0, step: 1, unit: "%" },
      { key: "right", label: "Right", min: 0, max: 45, def: 0, step: 1, unit: "%" },
      { key: "bottom", label: "Bottom", min: 0, max: 45, def: 0, step: 1, unit: "%" },
    ],
    css: () => "",
    ffmpeg: (p) => {
      const l = getP(p, "left", 0) / 100;
      const t = getP(p, "top", 0) / 100;
      const r = getP(p, "right", 0) / 100;
      const b = getP(p, "bottom", 0) / 100;
      if (l <= 0 && t <= 0 && r <= 0 && b <= 0) return "";
      const rw = Math.max(0.01, 1 - l - r);
      const rh = Math.max(0.01, 1 - t - b);
      const f = (n: number) => n.toFixed(4);
      // Keep the frame size: crop to the kept region, then pad back to the
      // original dimensions (iw/rw × ih/rh) at the original edge offset.
      return (
        `crop=iw*${f(rw)}:ih*${f(rh)}:iw*${f(l)}:ih*${f(t)},` +
        `pad=iw/${f(rw)}:ih/${f(rh)}:iw*${f(l)}/${f(rw)}:ih*${f(t)}/${f(rh)}:color=black@0.0`
      );
    },
  },
];

const BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));

export function effectDef(id: string): EffectDef | undefined {
  return BY_ID.get(id);
}

/** Default param set for a freshly-added effect. */
export function defaultParams(id: string): Record<string, number> {
  const def = BY_ID.get(id);
  if (!def) return {};
  const out: Record<string, number> = {};
  for (const pp of def.params) out[pp.key] = pp.def;
  return out;
}

/** Default colour set for a freshly-added effect (empty if it has no colours). */
export function defaultColors(id: string): Record<string, string> {
  const def = BY_ID.get(id);
  if (!def?.colors) return {};
  const out: Record<string, string> = {};
  for (const cp of def.colors) out[cp.key] = cp.def;
  return out;
}

/** Enabled effects only (an effect is enabled unless `enabled === false`). */
function enabled(effects: ClipEffect[]): ClipEffect[] {
  return effects.filter((e) => e.enabled !== false && BY_ID.has(e.type));
}

/**
 * Composite CSS `filter` string for a clip's effect stack (space-joined),
 * or "" when nothing contributes. Feed straight into `ctx.filter`.
 */
export function cssFilterFor(effects: ClipEffect[] | undefined): string {
  if (!effects || effects.length === 0) return "";
  const parts: string[] = [];
  for (const e of enabled(effects)) {
    const frag = BY_ID.get(e.type)!.css(e.params, e.colors ?? {});
    if (frag) parts.push(frag);
  }
  return parts.join(" ");
}

/**
 * Composite FFmpeg filter chain for a clip's effect stack (comma-joined),
 * or "" when nothing contributes. Splice into the clip's filtergraph.
 */
export function ffmpegChainFor(effects: ClipEffect[] | undefined): string {
  if (!effects || effects.length === 0) return "";
  const parts: string[] = [];
  for (const e of enabled(effects)) {
    const frag = BY_ID.get(e.type)!.ffmpeg(e.params, e.colors ?? {});
    if (frag) parts.push(frag);
  }
  return parts.join(",");
}

/** Effects usable on an adjustment layer: colour/blur filters that ffmpeg can
 *  gate with `enable=` (timeline editing). Keeps the gated export chain valid. */
export const ADJUSTMENT_EFFECT_IDS = new Set([
  "brightness",
  "contrast",
  "saturation",
  "hue",
  "blur",
  "grayscale",
]);

/**
 * FFmpeg chain for an adjustment layer's effects, each filter time-gated to
 * [start,end] via `enable=` so it only affects the composite during the layer's
 * span. Only ADJUSTMENT_EFFECT_IDS are emitted (they support timeline editing).
 */
export function ffmpegAdjustChain(
  effects: ClipEffect[] | undefined,
  start: number,
  end: number,
): string {
  if (!effects || effects.length === 0) return "";
  const gate = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
  const parts: string[] = [];
  for (const e of enabled(effects)) {
    if (!ADJUSTMENT_EFFECT_IDS.has(e.type)) continue;
    const frag = BY_ID.get(e.type)!.ffmpeg(e.params, e.colors ?? {});
    if (frag) parts.push(`${frag}:${gate}`);
  }
  return parts.join(",");
}

/** Vignette strength (0..1) from an enabled Vignette effect (0 when none). The
 *  preview darkens the clip's edges by this much. */
export function vignetteAmountFor(effects: ClipEffect[] | undefined): number {
  if (!effects) return 0;
  for (const e of enabled(effects)) {
    if (e.type !== "vignette") continue;
    return Math.max(0, Math.min(1, (e.params.amount ?? 0) / 100));
  }
  return 0;
}

/**
 * Kept-region fractions (0..1) from an enabled Crop effect: how much to keep
 * after cutting `l`/`t`/`r`/`b` off each edge. The preview draws the source's
 * kept sub-rectangle into the matching sub-region of the clip box. All zero
 * (no crop) when there's no crop effect.
 */
export function cropFractionsFor(effects: ClipEffect[] | undefined): {
  l: number;
  t: number;
  r: number;
  b: number;
} {
  const zero = { l: 0, t: 0, r: 0, b: 0 };
  if (!effects) return zero;
  for (const e of enabled(effects)) {
    if (e.type !== "crop") continue;
    return {
      l: Math.max(0, (e.params.left ?? 0) / 100),
      t: Math.max(0, (e.params.top ?? 0) / 100),
      r: Math.max(0, (e.params.right ?? 0) / 100),
      b: Math.max(0, (e.params.bottom ?? 0) / 100),
    };
  }
  return zero;
}

/**
 * Horizontal/vertical mirror factors (±1) contributed by enabled Flip effects.
 * The preview compositor applies these with ctx.scale (ffmpeg uses hflip/vflip),
 * keeping flips exact in both.
 */
export function flipFactorsFor(effects: ClipEffect[] | undefined): { sx: number; sy: number } {
  let sx = 1;
  let sy = 1;
  if (!effects) return { sx, sy };
  for (const e of enabled(effects)) {
    if (e.type !== "flip") continue;
    if ((e.params.horizontal ?? 0) >= 0.5) sx = -sx;
    if ((e.params.vertical ?? 0) >= 0.5) sy = -sy;
  }
  return { sx, sy };
}
