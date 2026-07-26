/**
 * Video scopes — pure pixel statistics for the on-screen analysis panel.
 *
 * These functions take raw RGBA pixels (a `Uint8ClampedArray`, as returned by
 * `CanvasRenderingContext2D.getImageData`) from a downsampled copy of the
 * preview's output region and return plain count buffers. They do no drawing:
 * the canvas rendering lives in `src/editor/scopes.ts`. Kept here in core so the
 * binning maths is pure and unit-tested (`scopes.test.ts`).
 *
 * Alpha is ignored throughout (the preview output is opaque). All value axes are
 * 8-bit (0..255); orientation of any 2-D grid is documented per function and the
 * renderer decides which way is "up".
 */

export type ScopeMode = "histogram" | "waveform" | "parade" | "vectorscope";
export type WaveChannel = "r" | "g" | "b" | "luma";

/** BT.601 luma (0..255) from 8-bit RGB. */
export function luma601(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export interface Histogram {
  /** 256-bin counts per channel (index = 8-bit value). */
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  /** Peak bin count across all four channels, for vertical scaling. */
  max: number;
}

/** Per-channel 256-bin histogram over RGBA pixels (alpha ignored). */
export function computeHistogram(data: Uint8ClampedArray): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const R = data[i];
    const G = data[i + 1];
    const B = data[i + 2];
    r[R]++;
    g[G]++;
    b[B]++;
    luma[Math.round(luma601(R, G, B))]++;
  }
  let max = 0;
  for (let i = 0; i < 256; i++) {
    if (r[i] > max) max = r[i];
    if (g[i] > max) max = g[i];
    if (b[i] > max) max = b[i];
    if (luma[i] > max) max = luma[i];
  }
  return { r, g, b, luma, max };
}

export interface Waveform {
  w: number;
  h: number;
  /** length w*h. Index `col + level*w`; `level` 0 = value 0, `h-1` = value 255. */
  data: Uint32Array;
  max: number;
}

/**
 * A waveform monitor grid: for every source column, a vertical distribution of
 * the chosen channel's value. `srcW`/`srcH` describe the input pixel grid;
 * `outW`/`outH` the output resolution. Source columns are mapped linearly onto
 * output columns, values onto levels (0 = black at the bottom).
 */
export function computeWaveform(
  pixels: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  channel: WaveChannel,
): Waveform {
  const data = new Uint32Array(outW * outH);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = (y * srcW + x) * 4;
      const R = pixels[i];
      const G = pixels[i + 1];
      const B = pixels[i + 2];
      const v =
        channel === "r" ? R : channel === "g" ? G : channel === "b" ? B : luma601(R, G, B);
      const col = outW === srcW ? x : Math.min(outW - 1, Math.floor((x / srcW) * outW));
      const level = Math.min(outH - 1, Math.floor((v / 255) * outH));
      data[col + level * outW]++;
    }
  }
  let max = 0;
  for (let k = 0; k < data.length; k++) if (data[k] > max) max = data[k];
  return { w: outW, h: outH, data, max };
}

export interface Vectorscope {
  size: number;
  /** length size*size, indexed `x + y*size`. Origin (grey) is the centre; +Cr is
   *  up, +Cb is right. Radius = full-scale chroma. */
  data: Uint32Array;
  max: number;
}

/**
 * A vectorscope: scatters each pixel's chroma (BT.601 Cb/Cr) onto a square grid,
 * centred on neutral grey. Fully saturated primaries land near the rim; greys
 * pile up in the middle.
 */
export function computeVectorscope(pixels: Uint8ClampedArray, size: number): Vectorscope {
  const data = new Uint32Array(size * size);
  const c = (size - 1) / 2;
  const scale = size; // full-scale chroma (±0.5) spans ±size/2 → the radius
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const R = pixels[i] / 255;
    const G = pixels[i + 1] / 255;
    const B = pixels[i + 2] / 255;
    const cb = -0.168736 * R - 0.331264 * G + 0.5 * B;
    const cr = 0.5 * R - 0.418688 * G - 0.081312 * B;
    let x = Math.round(c + cb * scale);
    let y = Math.round(c - cr * scale); // screen y grows downward; Cr points up
    if (x < 0) x = 0;
    else if (x >= size) x = size - 1;
    if (y < 0) y = 0;
    else if (y >= size) y = size - 1;
    data[x + y * size]++;
  }
  let max = 0;
  for (let k = 0; k < data.length; k++) if (data[k] > max) max = data[k];
  return { size, data, max };
}
