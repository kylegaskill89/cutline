/**
 * Thin wrappers around the bundled ffmpeg/ffprobe sidecars via the Tauri
 * shell plugin. All process spawning lives here so the rest of the app stays
 * pure and testable.
 */
import { Command } from "@tauri-apps/plugin-shell";
import { convertFileSrc } from "@tauri-apps/api/core";
import { tempDir, join } from "@tauri-apps/api/path";
import { parseProbe, type ProbeResult } from "../core/probe.ts";
import { timeToSeconds } from "../core/format.ts";
import {
  computeEnvelope,
  int16ToFloat,
  type PeakEnvelope,
} from "../core/waveform.ts";

/** Resolution of cached waveform envelopes (peaks per second of source). */
export const WAVEFORM_PEAKS_PER_SEC = 200;
const WAVEFORM_PCM_RATE = 8000;

/** Runs `ffprobe -version` and returns its first line (a cheap health check). */
export async function ffprobeVersion(): Promise<string> {
  const out = await Command.sidecar("binaries/ffprobe", ["-version"]).execute();
  return out.stdout.split("\n")[0]?.trim() ?? "unknown";
}

/** Probes a file for duration and audio tracks. */
export async function probeFile(path: string): Promise<ProbeResult> {
  const out = await Command.sidecar("binaries/ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ]).execute();
  return parseProbe(out.stdout);
}

/**
 * Extracts `count` filmstrip thumbnails at even intervals, cover-cropped to
 * w x h, writing JPEGs to the temp dir. Returns asset URLs (via convertFileSrc)
 * the WebView can render in <img>/canvas. Failed frames resolve to "".
 */
export async function extractThumbnails(
  path: string,
  count: number,
  duration: number,
  w: number,
  h: number,
): Promise<string[]> {
  const dir = await tempDir();
  const stamp = Date.now();
  const vf =
    `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;

  const jobs = Array.from({ length: count }, async (_, i) => {
    const t = ((i + 0.5) / count) * Math.max(duration, 0.001);
    const out = await join(dir, `qvm_thumb_${stamp}_${i}.jpg`);
    try {
      await Command.sidecar("binaries/ffmpeg", [
        "-loglevel", "error",
        "-ss", t.toFixed(3),
        "-i", path,
        "-frames:v", "1",
        "-vf", vf,
        "-q:v", "4",
        "-y", out,
      ]).execute();
      return convertFileSrc(out);
    } catch {
      return "";
    }
  });

  return Promise.all(jobs);
}

/** Builds an asset URL the WebView can load into a <video> element. */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

/**
 * Extracts one audio stream to a compact, browser-decodable file (Opus/Ogg)
 * and returns bytes ready for Web Audio `decodeAudioData`. Used to build the
 * per-track AudioBuffers the playback mixer schedules.
 */
export async function extractAudioBuffer(
  path: string,
  audioStream: number,
): Promise<ArrayBuffer> {
  const dir = await tempDir();
  const out = await join(dir, `qvm_audio_${Date.now()}_${audioStream}.ogg`);
  await Command.sidecar("binaries/ffmpeg", [
    "-loglevel", "error",
    "-i", path,
    "-map", `0:a:${audioStream}`,
    "-ac", "2",
    "-c:a", "libopus",
    "-b:a", "128k",
    "-y", out,
  ]).execute();
  return fetch(assetUrl(out)).then((r) => r.arrayBuffer());
}

/**
 * Builds a waveform peak envelope for one audio stream of a media file.
 * Decodes it to low-rate mono PCM in the temp dir, fetches that back as binary
 * through the asset protocol, and reduces it to a compact min/max envelope.
 */
export async function extractWaveform(
  path: string,
  audioStream: number,
): Promise<PeakEnvelope> {
  const dir = await tempDir();
  const out = await join(dir, `qvm_pcm_${Date.now()}_${audioStream}.pcm`);
  await Command.sidecar("binaries/ffmpeg", [
    "-loglevel", "error",
    "-i", path,
    "-map", `0:a:${audioStream}`,
    "-ac", "1",
    "-ar", String(WAVEFORM_PCM_RATE),
    "-f", "s16le",
    "-y", out,
  ]).execute();

  const buf = await fetch(assetUrl(out)).then((r) => r.arrayBuffer());
  const samples = int16ToFloat(new Int16Array(buf));
  return computeEnvelope(samples, WAVEFORM_PCM_RATE, WAVEFORM_PEAKS_PER_SEC);
}

export interface FfmpegRun {
  /** Resolves with the process exit code. */
  done: Promise<number>;
  /** Kills the running ffmpeg process. */
  cancel: () => void;
}

/**
 * Runs an ffmpeg job, streaming progress. `onProgress` receives seconds
 * processed, parsed from ffmpeg's `time=` stderr output; divide by the output
 * duration for a percentage (as the Python app did).
 */
export function runFfmpeg(
  args: string[],
  onProgress: (processedSec: number) => void,
  onLog?: (line: string) => void,
): FfmpegRun {
  const cmd = Command.sidecar("binaries/ffmpeg", args);

  cmd.stderr.on("data", (line: string) => {
    onLog?.(line);
    const m = line.match(/time=(\S+)/);
    if (m) {
      const sec = timeToSeconds(m[1]);
      if (sec > 0) onProgress(sec);
    }
  });

  let child: { kill: () => Promise<void> } | null = null;
  const done = new Promise<number>((resolve, reject) => {
    cmd.on("close", (data: { code: number | null }) => resolve(data.code ?? -1));
    cmd.on("error", (err: string) => reject(new Error(err)));
    cmd.spawn().then((c) => (child = c)).catch(reject);
  });

  return {
    done,
    cancel: () => {
      void child?.kill();
    },
  };
}
