/**
 * Shared colour-matte fill logic, used by BOTH the preview compositor and the
 * export PNG baker so a solid/gradient matte looks identical in both. Keeping it
 * in one place is what guarantees preview↔export parity for mattes.
 */
import { DEFAULT_MATTE_COLOR, type Media } from "../core/project.ts";

/**
 * Endpoints for a linear gradient at `angleDeg` spanning the rect (x, y, w, h),
 * so the gradient runs edge-to-edge through the rect centre at that angle.
 * 0° = left→right, 90° = top→bottom.
 */
export function linearGradientEnds(
  x: number,
  y: number,
  w: number,
  h: number,
  angleDeg: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const cx = x + w / 2;
  const cy = y + h / 2;
  // Half-extent of the rect projected onto the gradient direction.
  const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
  return {
    x0: cx - dx * half,
    y0: cy - dy * half,
    x1: cx + dx * half,
    y1: cy + dy * half,
  };
}

/**
 * The fill style for a matte over the rect (x, y, w, h) in the given context's
 * current space — a solid colour, or a linear gradient when `media.gradient` is
 * set. Callers just do `ctx.fillStyle = matteFill(...); ctx.fillRect(x,y,w,h)`.
 */
export function matteFill(
  ctx: CanvasRenderingContext2D,
  media: Media,
  x: number,
  y: number,
  w: number,
  h: number,
): string | CanvasGradient {
  const c1 = media.color ?? DEFAULT_MATTE_COLOR;
  if (!media.gradient) return c1;
  const { x0, y0, x1, y1 } = linearGradientEnds(x, y, w, h, media.gradient.angle);
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, c1);
  g.addColorStop(1, media.gradient.color2);
  return g;
}
