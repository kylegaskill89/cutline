/**
 * Offscreen chroma-key pass for the preview compositor. CSS filters can't key a
 * colour to transparency, so a clip carrying a `chromakey` effect is first run
 * through this keyer (which returns an RGBA canvas with the key colour punched
 * out) and the result is drawn by the 2D compositor.
 *
 * This is a per-pixel approximation of ffmpeg's `chromakey` (chroma-distance in
 * BT.601 U/V), so the preview closely matches — but is not pixel-identical to —
 * the exported result. Keying is done at a capped resolution for performance.
 */
export class ChromaKeyer {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  private readonly MAX = 960; // cap the keyed buffer width (preview is downscaled)

  /**
   * @param similarity 0..1 — chroma distance under which a pixel is fully keyed.
   * @param blend 0..1 — soft edge band above `similarity`.
   * Returns a canvas with the key colour made transparent, or `null` if keying
   * isn't possible (context/size unavailable) so the caller can fall back.
   */
  key(
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
    colorHex: string,
    similarity: number,
    blend: number,
  ): HTMLCanvasElement | null {
    const ctx = this.ctx;
    if (!ctx || srcW <= 0 || srcH <= 0) return null;
    let w = srcW;
    let h = srcH;
    if (w > this.MAX) {
      h = Math.max(1, Math.round((h * this.MAX) / w));
      w = this.MAX;
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    try {
      ctx.drawImage(source, 0, 0, w, h);
    } catch {
      return null; // frame not decodable yet
    }
    let img: ImageData;
    try {
      img = ctx.getImageData(0, 0, w, h);
    } catch {
      return null;
    }
    const d = img.data;
    const [kr, kg, kb] = hexToRgb(colorHex);
    const uk = -0.169 * kr - 0.331 * kg + 0.5 * kb;
    const vk = 0.5 * kr - 0.419 * kg - 0.081 * kb;
    const sim = Math.max(0, similarity);
    const band = Math.max(1e-4, blend);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const u = -0.169 * r - 0.331 * g + 0.5 * b;
      const v = 0.5 * r - 0.419 * g - 0.081 * b;
      const du = u - uk;
      const dv = v - vk;
      const dist = Math.sqrt(du * du + dv * dv) / 255;
      let a: number;
      if (dist <= sim) a = 0;
      else if (dist >= sim + band) a = 1;
      else a = (dist - sim) / band;
      d[i + 3] = Math.round(d[i + 3] * a);
    }
    ctx.putImageData(img, 0, 0);
    return this.canvas;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0, 208, 0]; // default green
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/** Natural pixel dimensions of any CanvasImageSource, or null if not ready. */
export function sourceDims(s: CanvasImageSource): { w: number; h: number } | null {
  if (s instanceof HTMLVideoElement) {
    return s.videoWidth > 0 ? { w: s.videoWidth, h: s.videoHeight } : null;
  }
  if (s instanceof HTMLImageElement) {
    return s.naturalWidth > 0 ? { w: s.naturalWidth, h: s.naturalHeight } : null;
  }
  if (s instanceof HTMLCanvasElement) {
    return s.width > 0 ? { w: s.width, h: s.height } : null;
  }
  if (typeof ImageBitmap !== "undefined" && s instanceof ImageBitmap) {
    return { w: s.width, h: s.height };
  }
  return null;
}
