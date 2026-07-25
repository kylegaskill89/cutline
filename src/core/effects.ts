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
