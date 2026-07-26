/**
 * Scope renderer — draws the histogram / waveform / RGB parade / vectorscope
 * onto an overlay canvas from the live preview output.
 *
 * Purely an analysis view: it samples a downsampled copy of the preview's output
 * region each frame and never touches the model or export, so it cannot affect
 * rendered video. The binning maths lives in `src/core/scopes.ts` (pure + tested);
 * this file only colourises those grids and paints graticules.
 */
import {
  computeHistogram,
  computeWaveform,
  computeVectorscope,
  type ScopeMode,
  type WaveChannel,
} from "../core/scopes.ts";

const SAMPLE_W = 320; // downsample width for reading the preview (aspect-kept)
const GRAPH_W = 256; // internal graph resolution for the image-data scopes
const GRAPH_H = 220;
const VEC_SIZE = 256;

/** Channel trace colours (also used for parade columns). */
const RGB: Record<"r" | "g" | "b", [number, number, number]> = {
  r: [255, 77, 77],
  g: [77, 255, 136],
  b: [77, 155, 255],
};

export class ScopeView {
  private ctx: CanvasRenderingContext2D;
  private sample: HTMLCanvasElement; // downsample buffer for reading the preview
  private sctx: CanvasRenderingContext2D;
  private graph: HTMLCanvasElement; // offscreen for the image-data scopes
  private gctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;

  mode: ScopeMode = "histogram";
  enabled = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.sample = document.createElement("canvas");
    this.sctx = this.sample.getContext("2d", { willReadFrequently: true })!;
    this.graph = document.createElement("canvas");
    this.gctx = this.graph.getContext("2d", { willReadFrequently: true })!;
  }

  /** Match the backing store to the element's CSS size at device resolution. */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth || 260;
    const cssH = this.canvas.clientHeight || 180;
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Sample `[sx,sy,sw,sh]` of `src` (device px) and repaint the active scope. */
  update(src: HTMLCanvasElement, sx: number, sy: number, sw: number, sh: number) {
    if (!this.enabled || sw < 1 || sh < 1) return;
    if (this.cssW <= 0) this.resize();
    const w = SAMPLE_W;
    const h = Math.max(1, Math.round(w * (sh / sw)));
    if (this.sample.width !== w || this.sample.height !== h) {
      this.sample.width = w;
      this.sample.height = h;
    }
    this.sctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    let data: Uint8ClampedArray;
    try {
      data = this.sctx.getImageData(0, 0, w, h).data;
    } catch {
      this.drawMessage("Scope unavailable");
      return;
    }
    switch (this.mode) {
      case "histogram":
        this.drawHistogram(data);
        break;
      case "waveform":
        this.drawWaveform(data, w, h, "luma");
        break;
      case "parade":
        this.drawParade(data, w, h);
        break;
      case "vectorscope":
        this.drawVectorscope(data);
        break;
    }
  }

  // ------------------------------------------------------------- helpers --
  private clearBg() {
    const c = this.ctx;
    c.fillStyle = "#07090c";
    c.fillRect(0, 0, this.cssW, this.cssH);
  }

  private label(text: string) {
    const c = this.ctx;
    c.fillStyle = "rgba(210,220,230,0.75)";
    c.font = "10px system-ui, sans-serif";
    c.textBaseline = "top";
    c.textAlign = "left";
    c.fillText(text, 6, 5);
  }

  private drawMessage(text: string) {
    this.clearBg();
    const c = this.ctx;
    c.fillStyle = "rgba(210,220,230,0.6)";
    c.font = "11px system-ui, sans-serif";
    c.textBaseline = "middle";
    c.textAlign = "center";
    c.fillText(text, this.cssW / 2, this.cssH / 2);
    c.textAlign = "left";
  }

  /** Compress a normalised count with a gentle gamma so faint traces show. */
  private static gain(n: number): number {
    return Math.min(1, Math.pow(n, 0.4) * 1.35);
  }

  // ---------------------------------------------------------- histogram --
  private drawHistogram(data: Uint8ClampedArray) {
    this.clearBg();
    const c = this.ctx;
    const W = this.cssW;
    const H = this.cssH;
    // Value gridlines (0, 64, 128, 192, 255).
    c.strokeStyle = "rgba(255,255,255,0.08)";
    c.lineWidth = 1;
    for (const v of [64, 128, 192]) {
      const x = Math.round((v / 255) * W) + 0.5;
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, H);
      c.stroke();
    }
    const h = computeHistogram(data);
    const plotH = H - 4;
    const scaleY = (v: number) => (h.max > 0 ? ScopeView.gain(v / h.max) : 0);
    c.globalCompositeOperation = "lighter";
    for (const key of ["r", "g", "b"] as const) {
      const bins = h[key];
      const [r, g, b] = RGB[key];
      c.beginPath();
      c.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * W;
        const y = H - scaleY(bins[i]) * plotH;
        c.lineTo(x, y);
      }
      c.lineTo(W, H);
      c.closePath();
      c.fillStyle = `rgba(${r},${g},${b},0.5)`;
      c.fill();
    }
    c.globalCompositeOperation = "source-over";
    // Luma outline over the top.
    c.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * W;
      const y = H - scaleY(h.luma[i]) * plotH;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.strokeStyle = "rgba(235,240,245,0.65)";
    c.lineWidth = 1;
    c.stroke();
    this.label("Histogram");
  }

  // ------------------------------------------------- image-data scopes --
  /** Blit a Uint32 count grid (level 0 = value 0) as a coloured trace. */
  private blitGrid(
    grid: Uint32Array,
    gw: number,
    gh: number,
    max: number,
    colOf: (col: number) => [number, number, number],
    ox: number,
    plotX: number,
    plotW: number,
  ) {
    if (this.graph.width !== gw || this.graph.height !== gh) {
      this.graph.width = gw;
      this.graph.height = gh;
    }
    const img = this.gctx.createImageData(gw, gh);
    const d = img.data;
    for (let ry = 0; ry < gh; ry++) {
      const level = gh - 1 - ry; // top row = highest value
      for (let cx = 0; cx < gw; cx++) {
        const count = grid[cx + level * gw];
        const o = (ry * gw + cx) * 4;
        if (count === 0) {
          d[o + 3] = 0;
          continue;
        }
        const a = max > 0 ? ScopeView.gain(count / max) : 0;
        const [r, g, b] = colOf(cx);
        d[o] = r * a;
        d[o + 1] = g * a;
        d[o + 2] = b * a;
        d[o + 3] = 255;
      }
    }
    this.gctx.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.graph, ox, 0, gw, gh, plotX, 0, plotW, this.cssH);
  }

  private drawWaveform(data: Uint8ClampedArray, w: number, h: number, channel: WaveChannel) {
    this.clearBg();
    this.wfGrid();
    const wf = computeWaveform(data, w, h, GRAPH_W, GRAPH_H, channel);
    const col: [number, number, number] =
      channel === "luma" ? [220, 235, 220] : RGB[channel];
    this.blitGrid(wf.data, GRAPH_W, GRAPH_H, wf.max, () => col, 0, 0, this.cssW);
    this.label("Waveform (luma)");
  }

  private drawParade(data: Uint8ClampedArray, w: number, h: number) {
    this.clearBg();
    this.wfGrid();
    const pw = Math.floor(GRAPH_W / 3);
    const combined = new Uint32Array(GRAPH_W * GRAPH_H);
    let max = 0;
    const chans: ("r" | "g" | "b")[] = ["r", "g", "b"];
    chans.forEach((ch, band) => {
      const wf = computeWaveform(data, w, h, pw, GRAPH_H, ch);
      if (wf.max > max) max = wf.max;
      for (let level = 0; level < GRAPH_H; level++) {
        for (let cx = 0; cx < pw; cx++) {
          combined[band * pw + cx + level * GRAPH_W] = wf.data[cx + level * pw];
        }
      }
    });
    const colOf = (cx: number): [number, number, number] =>
      RGB[chans[Math.min(2, Math.floor(cx / pw))]];
    this.blitGrid(combined, GRAPH_W, GRAPH_H, max, colOf, 0, 0, this.cssW);
    this.label("RGB Parade");
  }

  /** Faint horizontal IRE-ish gridlines for the waveform/parade plots. */
  private wfGrid() {
    const c = this.ctx;
    c.strokeStyle = "rgba(255,255,255,0.07)";
    c.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(f * this.cssH) + 0.5;
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(this.cssW, y);
      c.stroke();
    }
  }

  // -------------------------------------------------------- vectorscope --
  private drawVectorscope(data: Uint8ClampedArray) {
    this.clearBg();
    const vs = computeVectorscope(data, VEC_SIZE);
    // Square plot centred in the panel.
    const side = Math.min(this.cssW, this.cssH);
    const px = (this.cssW - side) / 2;
    const py = (this.cssH - side) / 2;
    // Graticule: bounding circle + crosshair.
    const c = this.ctx;
    c.save();
    c.strokeStyle = "rgba(255,255,255,0.12)";
    c.lineWidth = 1;
    c.beginPath();
    c.arc(px + side / 2, py + side / 2, side / 2 - 1, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(px + side / 2, py);
    c.lineTo(px + side / 2, py + side);
    c.moveTo(px, py + side / 2);
    c.lineTo(px + side, py + side / 2);
    c.stroke();
    c.restore();
    // Build the scatter as an image-data trace (greenish, like a CRT scope).
    if (this.graph.width !== VEC_SIZE || this.graph.height !== VEC_SIZE) {
      this.graph.width = VEC_SIZE;
      this.graph.height = VEC_SIZE;
    }
    const img = this.gctx.createImageData(VEC_SIZE, VEC_SIZE);
    const d = img.data;
    for (let i = 0; i < vs.data.length; i++) {
      const count = vs.data[i];
      if (count === 0) {
        d[i * 4 + 3] = 0;
        continue;
      }
      const a = vs.max > 0 ? ScopeView.gain(count / vs.max) : 0;
      d[i * 4] = 120 * a;
      d[i * 4 + 1] = 240 * a;
      d[i * 4 + 2] = 140 * a;
      d[i * 4 + 3] = 255;
    }
    this.gctx.putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.graph, 0, 0, VEC_SIZE, VEC_SIZE, px, py, side, side);
    this.label("Vectorscope");
  }
}
