import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEnvelope, sampleEnvelope, int16ToFloat } from "../waveform.ts";

const approx = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

// sampleRate 10, peaksPerSecond 5 -> bucketSize 2, 10 samples -> 5 buckets.
const samples = new Float32Array([0.2, -0.4, 0.5, 0.1, -0.9, 0.3, 1, -1, 0, 0]);

test("computeEnvelope reduces to correct min/max buckets", () => {
  const env = computeEnvelope(samples, 10, 5);
  assert.equal(env.min.length, 5);
  assert.equal(env.max.length, 5);
  approx(env.min[0], -0.4);
  approx(env.max[0], 0.2);
  approx(env.min[1], 0.1);
  approx(env.max[1], 0.5);
  approx(env.min[2], -0.9);
  approx(env.max[2], 0.3);
  approx(env.min[3], -1);
  approx(env.max[3], 1);
  approx(env.min[4], 0);
  approx(env.max[4], 0);
});

test("sampleEnvelope over the full range preserves the envelope", () => {
  const env = computeEnvelope(samples, 10, 5);
  const s = sampleEnvelope(env, 0, 1, 5); // full 1s (10 samples @ 10Hz) -> 5 buckets, 1:1
  for (let i = 0; i < 5; i++) {
    approx(s.min[i], env.min[i]);
    approx(s.max[i], env.max[i]);
  }
});

test("sampleEnvelope over a sub-range selects the right portion", () => {
  const env = computeEnvelope(samples, 10, 5); // 5 peaks/sec
  // source 0.4s..0.8s -> envelope indices 2..4 (buckets 2 and 3)
  const s = sampleEnvelope(env, 0.4, 0.8, 2);
  approx(s.min[0], -0.9);
  approx(s.max[0], 0.3);
  approx(s.min[1], -1);
  approx(s.max[1], 1);
});

test("computeEnvelope handles empty input", () => {
  const env = computeEnvelope(new Float32Array(0), 8000, 200);
  assert.equal(env.min.length, 0);
  assert.equal(env.max.length, 0);
});

test("int16ToFloat scales to -1..1", () => {
  const f = int16ToFloat(new Int16Array([0, 16384, -32768, 32767]));
  approx(f[0], 0);
  approx(f[1], 0.5);
  approx(f[2], -1);
  approx(f[3], 32767 / 32768);
});
