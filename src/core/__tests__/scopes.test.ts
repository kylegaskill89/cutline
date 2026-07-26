import { test } from "node:test";
import assert from "node:assert/strict";
import {
  luma601,
  computeHistogram,
  computeWaveform,
  computeVectorscope,
} from "../scopes.ts";

/** Build RGBA pixel data from [r,g,b] triples (alpha forced opaque). */
function rgba(pixels: [number, number, number][]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  });
  return out;
}

test("luma601 is 0 for black, 255 for white, weights green most", () => {
  assert.equal(luma601(0, 0, 0), 0);
  assert.equal(Math.round(luma601(255, 255, 255)), 255);
  assert.ok(luma601(0, 255, 0) > luma601(255, 0, 0));
  assert.ok(luma601(255, 0, 0) > luma601(0, 0, 255));
});

test("histogram counts each channel into the right bin", () => {
  const h = computeHistogram(rgba([
    [0, 0, 0],
    [255, 255, 255],
    [255, 255, 255],
  ]));
  assert.equal(h.r[0], 1);
  assert.equal(h.r[255], 2);
  assert.equal(h.luma[0], 1);
  assert.equal(h.luma[255], 2);
  assert.equal(h.max, 2); // the peak bin has two pixels
  // Every pixel is accounted for exactly once per channel.
  const sum = h.r.reduce((a, b) => a + b, 0);
  assert.equal(sum, 3);
});

test("histogram ignores alpha and only reads whole pixels", () => {
  const h = computeHistogram(rgba([[10, 20, 30]]));
  assert.equal(h.r[10], 1);
  assert.equal(h.g[20], 1);
  assert.equal(h.b[30], 1);
});

test("waveform places a bright column at the top level, dark at the bottom", () => {
  // 2x1 image: left = black, right = white. Luma channel, 2 wide x 4 tall.
  const wf = computeWaveform(rgba([[0, 0, 0], [255, 255, 255]]), 2, 1, 2, 4, "luma");
  assert.equal(wf.w, 2);
  assert.equal(wf.h, 4);
  // Black → level 0 (bottom row), column 0.
  assert.equal(wf.data[0 + 0 * 2], 1);
  // White → top level (h-1), column 1.
  assert.equal(wf.data[1 + 3 * 2], 1);
  assert.equal(wf.max, 1);
});

test("waveform channel selection reads the requested component", () => {
  // One red pixel. Red waveform peaks at the top; blue waveform at the bottom.
  const red = rgba([[255, 0, 0]]);
  const r = computeWaveform(red, 1, 1, 1, 4, "r");
  assert.equal(r.data[0 + 3 * 1], 1); // top level
  const b = computeWaveform(red, 1, 1, 1, 4, "b");
  assert.equal(b.data[0 + 0 * 1], 1); // bottom level
});

test("vectorscope puts grey at the centre and primaries off-centre", () => {
  const size = 9;
  const centre = (size - 1) / 2;
  const grey = computeVectorscope(rgba([[128, 128, 128]]), size);
  // A neutral grey has zero chroma → dead centre.
  assert.equal(grey.data[centre + centre * size], 1);

  const red = computeVectorscope(rgba([[255, 0, 0]]), size);
  // Red is well off-centre (non-zero chroma) — the centre stays empty.
  assert.equal(red.data[centre + centre * size], 0);
  let total = 0;
  for (const v of red.data) total += v;
  assert.equal(total, 1); // the single pixel landed somewhere in-bounds
});
