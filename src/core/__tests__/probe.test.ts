import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProbe } from "../probe.ts";

const sample = JSON.stringify({
  format: { duration: "125.400000", size: "10485760" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30000/1001" },
    { codec_type: "audio", codec_name: "aac", channels: 2, tags: { title: "Gameplay" } },
    { codec_type: "audio", codec_name: "opus", channels: 1, tags: { language: "eng" } },
    { codec_type: "audio", codec_name: "aac", channels: 2 },
  ],
});

test("parseProbe extracts duration and audio tracks with labels", () => {
  const r = parseProbe(sample);
  assert.equal(r.durationSec, 125.4);
  assert.equal(r.sizeBytes, 10485760);
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.ok(Math.abs(r.fps - 29.97) < 0.01);
  assert.equal(r.audioTracks.length, 3);
  assert.deepEqual(
    r.audioTracks.map((t) => t.index),
    [0, 1, 2],
  );
  assert.equal(r.audioTracks[0].label, "Track 1 — Gameplay");
  assert.equal(r.audioTracks[1].label, "Track 2 — eng");
  assert.equal(r.audioTracks[2].label, "Track 3");
  assert.equal(r.audioTracks[0].channels, 2);
});

test("parseProbe survives malformed JSON", () => {
  const r = parseProbe("not json");
  assert.equal(r.durationSec, 0);
  assert.deepEqual(r.audioTracks, []);
});

test("parseProbe handles a video with no audio", () => {
  const r = parseProbe(JSON.stringify({ format: { duration: "10" }, streams: [{ codec_type: "video" }] }));
  assert.equal(r.durationSec, 10);
  assert.deepEqual(r.audioTracks, []);
});
