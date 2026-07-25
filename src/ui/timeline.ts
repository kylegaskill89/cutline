/**
 * Canvas filmstrip timeline with draggable trim handles and a playhead.
 * Ported from the tk.Canvas logic in TrimVideoGUI.py (_draw_timeline and the
 * timeline mouse handlers), rebuilt for HTML canvas + pointer events.
 */

const HANDLE_GRAB_PX = 8;
export const MIN_TRIM_GAP = 0.05;

export interface TimelineCallbacks {
  onScrub: (t: number) => void; // playhead moved (drag or click)
  onTrimStart: (t: number) => void; // start handle moved
  onTrimEnd: (t: number) => void; // end handle moved
  onScrubEnd: () => void; // pointer released
}

type DragTarget = "start" | "end" | "playhead" | null;

export class Timeline {
  private ctx: CanvasRenderingContext2D;
  private w: number;
  private h: number;
  private drag: DragTarget = null;

  // View state (set by the app before each draw)
  duration = 0;
  trimStart = 0;
  trimEnd = 0;
  playhead = 0;
  trimEnabled = true;
  loaded = false;
  thumbs: (HTMLImageElement | null)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: TimelineCallbacks,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.w = canvas.width;
    this.h = canvas.height;
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", () => this.onUp());
  }

  private xToTime(x: number): number {
    const cx = Math.min(Math.max(x, 0), this.w);
    return (cx / this.w) * this.duration;
  }

  private timeToX(t: number): number {
    if (this.duration <= 0) return 0;
    return (t / this.duration) * this.w;
  }

  private localX(e: PointerEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * this.w;
  }

  private onDown(e: PointerEvent) {
    if (!this.loaded) return;
    const x = this.localX(e);
    const sx = this.timeToX(this.trimStart);
    const ex = this.timeToX(this.trimEnd);
    if (this.trimEnabled && Math.abs(x - sx) <= HANDLE_GRAB_PX) this.drag = "start";
    else if (this.trimEnabled && Math.abs(x - ex) <= HANDLE_GRAB_PX) this.drag = "end";
    else this.drag = "playhead";
    this.canvas.setPointerCapture(e.pointerId);
    this.onMove(e);
  }

  private onMove(e: PointerEvent) {
    if (!this.loaded || this.drag === null) return;
    const t = this.xToTime(this.localX(e));
    if (this.drag === "start") {
      const clamped = Math.max(0, Math.min(t, this.trimEnd - MIN_TRIM_GAP));
      this.cb.onTrimStart(clamped);
    } else if (this.drag === "end") {
      const clamped = Math.min(this.duration, Math.max(t, this.trimStart + MIN_TRIM_GAP));
      this.cb.onTrimEnd(clamped);
    } else {
      this.cb.onScrub(t);
    }
  }

  private onUp() {
    if (this.drag !== null) {
      this.drag = null;
      this.cb.onScrubEnd();
    }
  }

  draw() {
    const c = this.ctx;
    c.clearRect(0, 0, this.w, this.h);

    if (!this.loaded) {
      c.fillStyle = "#4a5568";
      c.font = "11px system-ui";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText("Timeline", this.w / 2, this.h / 2);
      return;
    }

    const thumbCount = this.thumbs.length || 1;
    const thumbW = this.w / thumbCount;
    const thumbH = this.h - 16;
    const stripY = (this.h - thumbH) / 2;

    for (let i = 0; i < thumbCount; i++) {
      const x = i * thumbW;
      const img = this.thumbs[i];
      if (img && img.complete && img.naturalWidth > 0) {
        // cover-fit each cell
        const scale = Math.max(thumbW / img.naturalWidth, thumbH / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        c.save();
        c.beginPath();
        c.rect(x, stripY, thumbW, thumbH);
        c.clip();
        c.drawImage(img, x + (thumbW - dw) / 2, stripY + (thumbH - dh) / 2, dw, dh);
        c.restore();
      } else {
        c.fillStyle = "#1d2129";
        c.fillRect(x, stripY, thumbW, thumbH);
      }
    }

    const sx = this.timeToX(this.trimStart);
    const ex = this.timeToX(this.trimEnd);

    // Dim outside the selection
    c.fillStyle = "rgba(0,0,0,0.55)";
    if (sx > 0) c.fillRect(0, 0, sx, this.h);
    if (ex < this.w) c.fillRect(ex, 0, this.w - ex, this.h);

    // Selection border
    c.strokeStyle = "#d8dee9";
    c.lineWidth = 1;
    c.strokeRect(sx + 0.5, 0.5, ex - sx - 1, this.h - 1);

    // Handles
    const startColor = this.trimEnabled ? "#2ecc71" : "#4a5568";
    const endColor = this.trimEnabled ? "#e74c3c" : "#4a5568";
    for (const [x, color] of [
      [sx, startColor],
      [ex, endColor],
    ] as const) {
      c.fillStyle = color;
      c.fillRect(x - 3, 0, 6, this.h);
      c.fillRect(x - 5, this.h / 2 - 7, 10, 14);
    }

    // Playhead
    const px = this.timeToX(this.playhead);
    c.strokeStyle = "#ffffff";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(px + 0.5, 0);
    c.lineTo(px + 0.5, this.h);
    c.stroke();
    c.fillStyle = "#ffffff";
    c.beginPath();
    c.moveTo(px - 5, 0);
    c.lineTo(px + 5, 0);
    c.lineTo(px, 7);
    c.closePath();
    c.fill();
  }
}
