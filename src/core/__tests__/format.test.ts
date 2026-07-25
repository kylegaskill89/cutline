import { test } from "node:test";
import assert from "node:assert/strict";
import {
  timeToSeconds,
  secondsToTimestamp,
  secondsToTimecode,
  snapToFrame,
  readableFileSize,
} from "../format.ts";

test("timeToSeconds parses HH:MM:SS, MM:SS, and raw seconds", () => {
  assert.equal(timeToSeconds("01:02:03"), 3723);
  assert.equal(timeToSeconds("02:03"), 123);
  assert.equal(timeToSeconds("45.5"), 45.5);
  assert.equal(timeToSeconds("00:00:05.20"), 5.2);
});

test("timeToSeconds returns 0 for empty or invalid input", () => {
  assert.equal(timeToSeconds(""), 0);
  assert.equal(timeToSeconds("  "), 0);
  assert.equal(timeToSeconds("abc"), 0);
});

test("secondsToTimestamp matches the Python HH:MM:SS.ss format", () => {
  assert.equal(secondsToTimestamp(0), "00:00:00.00");
  assert.equal(secondsToTimestamp(5.2), "00:00:05.20");
  assert.equal(secondsToTimestamp(3723.45), "01:02:03.45");
  assert.equal(secondsToTimestamp(-10), "00:00:00.00");
});

test("secondsToTimecode formats HH:MM:SS:FF at a frame rate", () => {
  assert.equal(secondsToTimecode(0, 30), "00:00:00:00");
  assert.equal(secondsToTimecode(1, 30), "00:00:01:00");
  assert.equal(secondsToTimecode(1.5, 30), "00:00:01:15"); // 15 frames into second
  assert.equal(secondsToTimecode(3661.0, 24), "01:01:01:00");
  // A frame that rounds up into the next second wraps correctly.
  assert.equal(secondsToTimecode(0.999, 30), "00:00:01:00");
});

test("snapToFrame quantises to the frame grid", () => {
  assert.equal(snapToFrame(0.51, 30), 15 / 30);
  assert.equal(snapToFrame(1.0, 24), 1.0);
});

test("secondsToTimestamp round-trips with timeToSeconds", () => {
  for (const t of [0, 5.2, 61.5, 3723.45]) {
    assert.equal(timeToSeconds(secondsToTimestamp(t)), t);
  }
});

test("readableFileSize scales units like the Python helper", () => {
  assert.equal(readableFileSize(512), "512.00 B");
  assert.equal(readableFileSize(1536), "1.50 KB");
  assert.equal(readableFileSize(5 * 1024 * 1024), "5.00 MB");
  assert.equal(readableFileSize(-1), "Unknown Size");
});
