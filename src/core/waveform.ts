/**
 * Waveform peak envelopes for the timeline.
 *
 * We extract a low-rate mono PCM stream once per (media, audio stream) and
 * reduce it to a compact min/max peak envelope at a fixed resolution. The
 * timeline then resamples any source sub-range of that envelope to whatever
 * pixel width the current zoom demands — so zooming never re-decodes audio.
 *
 * This module is the pure math; the PCM extraction lives in the sidecar layer.
 */

export interface PeakEnvelope {
  /** Envelope resolution: peaks per second of source audio. */
  peaksPerSecond: number;
  /** Per-bucket minimum sample value (bipolar, roughly -1..1). */
  min: Float32Array;
  /** Per-bucket maximum sample value. */
  max: Float32Array;
}

/**
 * Reduces raw mono samples to a min/max envelope at `peaksPerSecond`.
 */
export function computeEnvelope(
  samples: Float32Array,
  sampleRate: number,
  peaksPerSecond: number,
): PeakEnvelope {
  const bucketSize = Math.max(1, Math.round(sampleRate / peaksPerSecond));
  const n = Math.ceil(samples.length / bucketSize) || 0;
  const min = new Float32Array(n);
  const max = new Float32Array(n);

  for (let b = 0; b < n; b++) {
    const start = b * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 0;
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { peaksPerSecond, min, max };
}

/**
 * Resamples the envelope over the source range [sourceInSec, sourceOutSec) to
 * exactly `outBuckets` min/max pairs, for drawing a clip at the current zoom.
 */
export function sampleEnvelope(
  env: PeakEnvelope,
  sourceInSec: number,
  sourceOutSec: number,
  outBuckets: number,
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(outBuckets);
  const max = new Float32Array(outBuckets);
  const startIdx = sourceInSec * env.peaksPerSecond;
  const span = (sourceOutSec - sourceInSec) * env.peaksPerSecond;

  for (let o = 0; o < outBuckets; o++) {
    const a = Math.floor(startIdx + (o / outBuckets) * span);
    const bRaw = Math.floor(startIdx + ((o + 1) / outBuckets) * span);
    const b = Math.max(a + 1, bRaw);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.max(0, a); i < Math.min(env.min.length, b); i++) {
      if (env.min[i] < lo) lo = env.min[i];
      if (env.max[i] > hi) hi = env.max[i];
    }
    if (!Number.isFinite(lo)) {
      lo = 0;
      hi = 0;
    }
    min[o] = lo;
    max[o] = hi;
  }
  return { min, max };
}

/** Converts interleaved/mono Int16 PCM (s16le) to Float32 in -1..1. */
export function int16ToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}
