/**
 * ffprobe JSON parsing.
 *
 * The original app parsed `ffmpeg -i` stderr with string splitting. The Tauri
 * version calls `ffprobe -show_format -show_streams -of json`, which is far
 * more robust and, crucially, exposes per-track titles / languages so the
 * keep-drop UI can label tracks meaningfully ("Track 2 — Microphone").
 *
 * This module is the pure parser over that JSON; the actual process spawn
 * lives in the Tauri sidecar layer.
 */

export interface AudioTrack {
  /** Index among audio streams only (the N in `0:a:N`). */
  index: number;
  codec: string;
  channels: number;
  /** Best human label: stream title, else language, else "Track N". */
  label: string;
}

export interface ProbeResult {
  durationSec: number;
  sizeBytes: number;
  /** First video stream dimensions (0 if none). */
  width: number;
  height: number;
  /** First video stream frame rate (0 if none). */
  fps: number;
  audioTracks: AudioTrack[];
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  tags?: Record<string, string>;
}

/** Parses ffprobe's "num/den" frame-rate string into fps. */
function parseFps(r?: string): number {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  if (!n || !d) return Number(n) || 0;
  return n / d;
}

interface RawProbe {
  format?: { duration?: string; size?: string };
  streams?: RawStream[];
}

/** Parses the JSON string emitted by `ffprobe ... -of json`. */
export function parseProbe(json: string): ProbeResult {
  let data: RawProbe;
  try {
    data = JSON.parse(json);
  } catch {
    return { durationSec: 0, sizeBytes: 0, width: 0, height: 0, fps: 0, audioTracks: [] };
  }

  const durationSec = Number(data.format?.duration ?? 0) || 0;
  const sizeBytes = Number(data.format?.size ?? 0) || 0;

  let width = 0;
  let height = 0;
  let fps = 0;
  const audioTracks: AudioTrack[] = [];
  for (const stream of data.streams ?? []) {
    if (stream.codec_type === "video" && width === 0) {
      width = stream.width ?? 0;
      height = stream.height ?? 0;
      fps = parseFps(stream.r_frame_rate);
      continue;
    }
    if (stream.codec_type !== "audio") continue;
    const index = audioTracks.length;
    const tags = stream.tags ?? {};
    const title = tags.title ?? tags.TITLE;
    const lang = tags.language ?? tags.LANGUAGE;
    const label = title
      ? `Track ${index + 1} — ${title}`
      : lang
        ? `Track ${index + 1} — ${lang}`
        : `Track ${index + 1}`;
    audioTracks.push({
      index,
      codec: stream.codec_name ?? "unknown",
      channels: stream.channels ?? 0,
      label,
    });
  }

  return { durationSec, sizeBytes, width, height, fps, audioTracks };
}
