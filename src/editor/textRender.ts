/**
 * Shared text/title rendering. Both the live preview and the export PNG baker
 * use these helpers so what you see on the canvas is exactly what gets rendered
 * into the exported file. All measurements are in "canvas pixels" (the units of
 * TextSpec.fontSize); callers apply the transform (translate/rotate/scale) that
 * maps canvas pixels onto their target surface before drawing.
 */
import type { TextSpec } from "../core/project.ts";

export interface TextLayout {
  lines: string[];
  lineHeight: number;
  width: number; // full box width incl. padding (canvas px)
  height: number; // full box height incl. padding (canvas px)
  padX: number;
}

const LINE_SPACING = 1.25;
const PAD_X_FRAC = 0.3; // horizontal padding as a fraction of fontSize
const PAD_Y_FRAC = 0.18;

export function fontString(spec: TextSpec): string {
  const style = spec.italic ? "italic " : "";
  const weight = spec.bold ? "700 " : "400 ";
  return `${style}${weight}${spec.fontSize}px ${spec.fontFamily}`;
}

export function layoutText(ctx: CanvasRenderingContext2D, spec: TextSpec): TextLayout {
  ctx.font = fontString(spec);
  const lines = spec.content.length ? spec.content.split("\n") : [" "];
  let textW = 0;
  for (const ln of lines) textW = Math.max(textW, ctx.measureText(ln || " ").width);
  const lineHeight = spec.fontSize * LINE_SPACING;
  const padX = spec.fontSize * PAD_X_FRAC;
  const padY = spec.fontSize * PAD_Y_FRAC;
  return {
    lines,
    lineHeight,
    width: textW + padX * 2,
    height: lineHeight * lines.length + padY * 2,
    padX,
  };
}

/** Draws the text centred on the current origin (1 unit = 1 canvas px). */
export function drawTextCentred(
  ctx: CanvasRenderingContext2D,
  spec: TextSpec,
  layout: TextLayout,
) {
  const { lines, lineHeight, width, height, padX } = layout;
  if (spec.background) {
    ctx.fillStyle = spec.background;
    ctx.fillRect(-width / 2, -height / 2, width, height);
  }
  ctx.font = fontString(spec);
  ctx.textBaseline = "middle";
  ctx.textAlign = spec.align;

  let x = 0;
  if (spec.align === "left") x = -width / 2 + padX;
  else if (spec.align === "right") x = width / 2 - padX;

  const total = lineHeight * lines.length;
  let y = -total / 2 + lineHeight / 2;
  const stroke = spec.strokeColor && (spec.strokeWidth ?? 0) > 0;
  for (const ln of lines) {
    ctx.save();
    // Drop shadow (scaled to the font so it holds up at any size).
    if (spec.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = spec.fontSize * 0.12;
      ctx.shadowOffsetX = spec.fontSize * 0.06;
      ctx.shadowOffsetY = spec.fontSize * 0.06;
    }
    if (stroke) {
      ctx.lineJoin = "round";
      ctx.strokeStyle = spec.strokeColor!;
      ctx.lineWidth = spec.strokeWidth!;
      ctx.strokeText(ln, x, y);
      ctx.shadowColor = "transparent"; // don't shadow the fill twice
    }
    ctx.fillStyle = spec.color;
    ctx.fillText(ln, x, y);
    ctx.restore();
    y += lineHeight;
  }
}
