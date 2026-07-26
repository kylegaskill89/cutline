/**
 * Per-clip audio effects — a registry mirroring the visual effect registry
 * (`effects.ts`), but for the audio graph.
 *
 * Each effect defines its params once plus an `ffmpeg(params)` emitter (a filter
 * fragment spliced into the export's per-clip audio chain). The preview builds
 * the matching Web Audio node graph in `src/editor/audioNodes.ts` from the SAME
 * param values, and the filter types were chosen so the two agree closely:
 * high/low-pass, bass/treble shelves and a compressor all have near-identical
 * semantics in the Web Audio API and ffmpeg. Pure + unit-tested
 * (`audioEffects.test.ts`); the browser node construction is the only non-pure
 * part and lives in the editor layer.
 */
import type { AudioClipEffect } from "./project.ts";

export interface AudioEffectParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  unit?: string;
}

export interface AudioEffectDef {
  id: string;
  name: string;
  params: AudioEffectParam[];
  /** ffmpeg audio-filter fragment for the given params ("" when it is neutral). */
  ffmpeg: (p: Record<string, number>) => string;
}

/** dB → linear amplitude (used for ffmpeg acompressor, which takes 0..1). */
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export const AUDIO_EFFECTS: AudioEffectDef[] = [
  {
    id: "highpass",
    name: "High-Pass",
    params: [{ key: "freq", label: "Cutoff", min: 20, max: 2000, step: 10, def: 100, unit: "Hz" }],
    ffmpeg: (p) => `highpass=f=${Math.round(p.freq)}`,
  },
  {
    id: "lowpass",
    name: "Low-Pass",
    params: [
      { key: "freq", label: "Cutoff", min: 500, max: 20000, step: 100, def: 8000, unit: "Hz" },
    ],
    ffmpeg: (p) => `lowpass=f=${Math.round(p.freq)}`,
  },
  {
    id: "bass",
    name: "Bass",
    params: [{ key: "gain", label: "Gain", min: -24, max: 24, step: 1, def: 0, unit: "dB" }],
    ffmpeg: (p) => (p.gain === 0 ? "" : `bass=g=${p.gain.toFixed(1)}`),
  },
  {
    id: "treble",
    name: "Treble",
    params: [{ key: "gain", label: "Gain", min: -24, max: 24, step: 1, def: 0, unit: "dB" }],
    ffmpeg: (p) => (p.gain === 0 ? "" : `treble=g=${p.gain.toFixed(1)}`),
  },
  {
    id: "compressor",
    name: "Compressor",
    params: [
      { key: "threshold", label: "Threshold", min: -60, max: 0, step: 1, def: -18, unit: "dB" },
      { key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.5, def: 4, unit: ":1" },
    ],
    ffmpeg: (p) => {
      if (p.ratio <= 1) return ""; // 1:1 is a no-op
      // acompressor threshold is a linear amplitude (0.00097563..1).
      const thr = Math.min(1, Math.max(0.00097563, dbToLinear(p.threshold)));
      return `acompressor=threshold=${thr.toFixed(5)}:ratio=${p.ratio.toFixed(1)}`;
    },
  },
];

export function audioEffectDef(id: string): AudioEffectDef | undefined {
  return AUDIO_EFFECTS.find((e) => e.id === id);
}

/** Default param map for an effect id (empty if unknown). */
export function audioDefaultParams(id: string): Record<string, number> {
  const def = audioEffectDef(id);
  if (!def) return {};
  const p: Record<string, number> = {};
  for (const param of def.params) p[param.key] = param.def;
  return p;
}

/** An effect's params merged over its defaults (fills any missing keys). */
export function resolveAudioParams(e: AudioClipEffect): Record<string, number> {
  return { ...audioDefaultParams(e.type), ...e.params };
}

/**
 * The comma-joined ffmpeg audio-filter chain for a stack (enabled, non-neutral
 * effects only). Empty string when nothing contributes.
 */
export function ffmpegAudioChainFor(effects: AudioClipEffect[] | undefined): string {
  if (!effects || effects.length === 0) return "";
  const frags: string[] = [];
  for (const e of effects) {
    if (e.enabled === false) continue;
    const def = audioEffectDef(e.type);
    if (!def) continue;
    const frag = def.ffmpeg(resolveAudioParams(e));
    if (frag) frags.push(frag);
  }
  return frags.join(",");
}
