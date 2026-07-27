/**
 * Builds the Web Audio node chain for a clip's audio-effect stack, matching the
 * ffmpeg filters emitted by `src/core/audioEffects.ts` on export.
 *
 * This is the only non-pure half of the audio-effect feature: the param values
 * and neutrality rules come from the shared registry, so preview and export stay
 * in step. Filter choices map closely between the two engines (biquad high/low
 * pass ↔ ffmpeg highpass/lowpass; low/high shelf ↔ bass/treble; DynamicsCompressor
 * ↔ acompressor — the compressor match is approximate).
 */
import { resolveAudioParams } from "../core/audioEffects.ts";
import { clipAudioEffects, type Clip } from "../core/project.ts";

function makeNode(ctx: AudioContext, type: string, p: Record<string, number>): AudioNode | null {
  switch (type) {
    case "highpass": {
      const n = ctx.createBiquadFilter();
      n.type = "highpass";
      n.frequency.value = p.freq;
      return n;
    }
    case "lowpass": {
      const n = ctx.createBiquadFilter();
      n.type = "lowpass";
      n.frequency.value = p.freq;
      return n;
    }
    case "bass": {
      if (p.gain === 0) return null;
      const n = ctx.createBiquadFilter();
      n.type = "lowshelf";
      n.frequency.value = 100; // matches ffmpeg bass default centre
      n.gain.value = p.gain;
      return n;
    }
    case "treble": {
      if (p.gain === 0) return null;
      const n = ctx.createBiquadFilter();
      n.type = "highshelf";
      n.frequency.value = 3000; // matches ffmpeg treble default centre
      n.gain.value = p.gain;
      return n;
    }
    case "compressor": {
      if (p.ratio <= 1) return null;
      const n = ctx.createDynamicsCompressor();
      n.threshold.value = p.threshold; // dB
      n.ratio.value = p.ratio;
      n.knee.value = 6;
      n.attack.value = 0.01;
      n.release.value = 0.15;
      return n;
    }
    case "eqband": {
      if (p.gain === 0) return null;
      const n = ctx.createBiquadFilter();
      n.type = "peaking";
      n.frequency.value = p.freq;
      n.Q.value = p.q;
      n.gain.value = p.gain;
      return n;
    }
    case "notch": {
      const n = ctx.createBiquadFilter();
      n.type = "notch";
      n.frequency.value = p.freq;
      n.Q.value = p.q;
      return n;
    }
    case "gain": {
      if (p.gain === 0) return null;
      const n = ctx.createGain();
      n.gain.value = Math.pow(10, p.gain / 20); // dB → linear
      return n;
    }
    default:
      return null;
  }
}

/**
 * Returns the head and tail of a series-connected effect chain for `clip`, or
 * null when the clip has no active audio effects. Caller connects its signal
 * into `head` and `tail` onward to the destination, and disconnects `nodes` when
 * the source stops.
 */
export function buildAudioChain(
  ctx: AudioContext,
  clip: Clip,
): { head: AudioNode; tail: AudioNode; nodes: AudioNode[] } | null {
  const nodes: AudioNode[] = [];
  for (const e of clipAudioEffects(clip)) {
    if (e.enabled === false) continue;
    const node = makeNode(ctx, e.type, resolveAudioParams(e));
    if (node) nodes.push(node);
  }
  if (nodes.length === 0) return null;
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return { head: nodes[0], tail: nodes[nodes.length - 1], nodes };
}
