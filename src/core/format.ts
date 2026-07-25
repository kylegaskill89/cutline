/**
 * Time and size formatting helpers, ported from TrimVideoGUI.py.
 * All pure and unit-tested.
 */

/**
 * Parses "HH:MM:SS.xx", "MM:SS.xx", or a raw seconds string into float seconds.
 * Mirrors Python time_to_seconds: bad input yields 0.
 */
export function timeToSeconds(timeStr: string | number): number {
  const s = String(timeStr).trim();
  if (!s) return 0;
  const parts = s.split(":");
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n))) return 0;
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return nums[0];
}

/** Formats float seconds as "HH:MM:SS.ss" (Python seconds_to_timestamp). */
export function secondsToTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  // Seconds field is zero-padded to width 5 with 2 decimals (e.g. "05.20").
  const secStr = sec.toFixed(2).padStart(5, "0");
  return `${p2(h)}:${p2(m)}:${secStr}`;
}

/**
 * Formats seconds as a Premiere-style timecode "HH:MM:SS:FF" at `fps`.
 * The frame field counts whole frames within the current second.
 */
export function secondsToTimecode(seconds: number, fps: number): string {
  const f = Math.max(1, Math.round(fps));
  // Round to the nearest whole frame first, then decompose.
  const totalFrames = Math.max(0, Math.round(seconds * f));
  const frames = totalFrames % f;
  const totalSec = Math.floor(totalFrames / f);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(frames)}`;
}

/** Duration of a single frame in seconds. */
export function frameDuration(fps: number): number {
  return 1 / Math.max(1, fps);
}

/** Snaps a time to the nearest frame boundary at `fps`. */
export function snapToFrame(seconds: number, fps: number): number {
  const f = Math.max(1, fps);
  return Math.round(seconds * f) / f;
}

/** Human-readable file size from a byte count (Python get_readable_file_size). */
export function readableFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown Size";
  let size = bytes;
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (size < 1024) return `${size.toFixed(2)} ${unit}`;
    size /= 1024;
  }
  return `${size.toFixed(2)} TB`;
}
