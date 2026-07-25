import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFfmpegArgs, type BuildState } from "../ffmpeg.ts";

/**
 * Each expected array is the exact FFmpeg argument list the original
 * TrimVideoGUI.py process_video would assemble (minus the leading binary),
 * derived by hand from the Python source. These lock in byte-for-byte parity.
 */

function base(overrides: Partial<BuildState>): BuildState {
  return {
    inputFile: "in.mp4",
    outputFile: "out.mp4",
    mode: "trim",
    trimStart: 0,
    trimEnd: 60,
    duration: 60,
    audioStreams: 2,
    mixdown: false,
    trackOffsets: [0, 0],
    compression: "high",
    ...overrides,
  };
}

test("trim only, keep all tracks, stream-copy", () => {
  const args = buildFfmpegArgs(base({ mode: "trim", trimStart: 5, trimEnd: 20 }));
  assert.deepEqual(args, [
    "-ss", "5.000", "-to", "20.000",
    "-i", "in.mp4",
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", "copy",
    "-c:a", "copy",
    "-y", "out.mp4",
  ]);
});

test("reduce only (no trim window), High H.265", () => {
  const args = buildFfmpegArgs(base({ mode: "reduce", audioStreams: 1, compression: "high" }));
  assert.deepEqual(args, [
    "-i", "in.mp4",
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", "libx265", "-preset", "medium", "-crf", "26", "-tag:v", "hvc1",
    "-c:a", "aac", "-b:a", "160k",
    "-y", "out.mp4",
  ]);
});

test("Standard H.264 preset", () => {
  const args = buildFfmpegArgs(base({ mode: "reduce", compression: "standard" }));
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:a")), [
    "-c:v", "libx264", "-preset", "faster", "-crf", "22",
  ]);
});

test("Maximum H.265 preset", () => {
  const args = buildFfmpegArgs(base({ mode: "reduce", compression: "maximum" }));
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:a")), [
    "-c:v", "libx265", "-preset", "medium", "-crf", "28", "-tag:v", "hvc1",
  ]);
});

test("trim guards: start below gap and end within gap of duration emit no -ss/-to", () => {
  const args = buildFfmpegArgs(base({ mode: "trim", trimStart: 0.02, trimEnd: 59.98 }));
  assert.equal(args.includes("-ss"), false);
  assert.equal(args.includes("-to"), false);
  assert.deepEqual(args.slice(0, 2), ["-i", "in.mp4"]);
});

test("mixdown of two tracks builds the loudnorm/amix filter_complex", () => {
  const args = buildFfmpegArgs(
    base({ mode: "trim+reduce", compression: "standard", mixdown: true, trackOffsets: [0, -6] }),
  );
  const expectedGraph =
    "[0:a:0]aresample=48000,aformat=channel_layouts=stereo," +
    "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,volume=0.0dB[m0];" +
    "[0:a:1]aresample=48000,aformat=channel_layouts=stereo," +
    "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,volume=-6.0dB[m1];" +
    "[m0][m1]amix=inputs=2:duration=longest:normalize=0," +
    "alimiter=limit=0.891:level=false[aout]";
  assert.deepEqual(args, [
    "-i", "in.mp4",
    "-filter_complex", expectedGraph,
    "-map", "0:v:0", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "faster", "-crf", "22",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-y", "out.mp4",
  ]);
});

test("mixdown of a single track uses -af, not filter_complex", () => {
  const args = buildFfmpegArgs(
    base({ mode: "reduce", audioStreams: 1, mixdown: true, trackOffsets: [3], compression: "high" }),
  );
  assert.deepEqual(args, [
    "-i", "in.mp4",
    "-map", "0:v:0", "-map", "0:a:0",
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11,volume=3.0dB,alimiter=limit=0.891:level=false",
    "-c:v", "libx265", "-preset", "medium", "-crf", "26", "-tag:v", "hvc1",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-y", "out.mp4",
  ]);
});

// --- New feature: per-track keep/drop selection ---

test("keeping a subset of tracks (no mixdown) maps each explicitly", () => {
  const args = buildFfmpegArgs(
    base({ mode: "trim", audioStreams: 3, trackOffsets: [0, 0, 0], keptTracks: [0, 2] }),
  );
  assert.deepEqual(args, [
    "-i", "in.mp4",
    "-map", "0:v:0", "-map", "0:a:0", "-map", "0:a:2",
    "-c:v", "copy",
    "-c:a", "copy",
    "-y", "out.mp4",
  ]);
});

test("keeping all tracks explicitly still matches the parity 0:a? form", () => {
  const withList = buildFfmpegArgs(base({ mode: "trim", audioStreams: 2, keptTracks: [0, 1] }));
  const parity = buildFfmpegArgs(base({ mode: "trim", audioStreams: 2 }));
  assert.deepEqual(withList, parity);
});

test("mixdown of a selected subset only mixes kept tracks with their offsets", () => {
  const args = buildFfmpegArgs(
    base({
      mode: "trim+reduce",
      compression: "high",
      audioStreams: 3,
      mixdown: true,
      trackOffsets: [0, -3, -6],
      keptTracks: [1, 2],
    }),
  );
  const expectedGraph =
    "[0:a:1]aresample=48000,aformat=channel_layouts=stereo," +
    "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,volume=-3.0dB[m0];" +
    "[0:a:2]aresample=48000,aformat=channel_layouts=stereo," +
    "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,volume=-6.0dB[m1];" +
    "[m0][m1]amix=inputs=2:duration=longest:normalize=0," +
    "alimiter=limit=0.891:level=false[aout]";
  assert.equal(args[args.indexOf("-filter_complex") + 1], expectedGraph);
  // Video is mapped, the mixed track is mapped, and no raw 0:a:* survives.
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-map"),
    ["0:v:0", "[aout]"],
  );
  assert.deepEqual(args.slice(-2), ["-y", "out.mp4"]);
});
