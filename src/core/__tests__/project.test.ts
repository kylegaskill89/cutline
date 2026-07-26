import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetIds,
  emptyProject,
  addMedia,
  placeMedia,
  splitAt,
  setClipEdge,
  moveClips,
  moveClipsLayered,
  removeClips,
  rippleDelete,
  insertMediaAt,
  overwriteMediaAt,
  linkClips,
  unlinkGroup,
  unlinkClips,
  setClipGain,
  clipGain,
  gainAt,
  isGainAnimated,
  setGainKeyframe,
  moveGainKeyframe,
  clearGainKeyframes,
  setClipSpeed,
  clipSpeed,
  clipReversed,
  sourceTimeAt,
  setClipTransition,
  resolveVideoSegments,
  segSlideOffsetX,
  setClipBlend,
  clipBlend,
  addMarker,
  removeMarker,
  markerNear,
  nextMarker,
  prevMarker,
  projectMarkers,
  placedLength,
  rateStretchEdge,
  slipClip,
  slideClip,
  setClipsEnabled,
  clipEnabled,
  setKeyframe,
  clearKeyframes,
  isAnimated,
  animatedTransform,
  animatedOpacity,
  evalKeyframes,
  setClipTransform,
  clipTransform,
  isIdentityTransform,
  setMatteColor,
  setMatteGradient,
  clipEffects,
  addClipEffect,
  removeClipEffect,
  toggleClipEffect,
  moveClipEffect,
  appendClipEffects,
  clearClipEffects,
  setClipEffectParam,
  setClipEffectColor,
  setEffectKeyframe,
  clearEffectKeyframes,
  isEffectParamAnimated,
  effectParamAt,
  resolvedEffects,
  clipHasEffectKeyframes,
  addVideoTrack,
  addAudioTrack,
  groupMembers,
  clipAtTime,
  clipDuration,
  clipEnd,
  timelineDuration,
  findClip,
  trackOfClip,
  type Media,
  type Project,
} from "../project.ts";

const media: Media = {
  id: "m1",
  path: "a.mp4",
  name: "a.mp4",
  duration: 60,
  hasVideo: true,
  audioStreamCount: 2,
};

beforeEach(() => __resetIds());

function loaded(): Project {
  let p = emptyProject(1, 2); // V1, A1, A2
  p = addMedia(p, media);
  p = placeMedia(p, "m1", 0);
  return p;
}

test("setClipSpeed retimes the timeline length and applies to the linked group", () => {
  let p = loaded(); // 60s video on V1 + two audio streams, all linked
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 2); // 2x -> half as long
  const v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipSpeed(v2), 2);
  assert.equal(clipDuration(v2), 30);
  assert.equal(clipEnd(v2), 30);
  // Linked audio retimes too, so it stays in sync.
  for (const t of p.tracks) {
    if (t.kind !== "audio") continue;
    assert.equal(clipSpeed(t.clips[0]), 2);
    assert.equal(clipEnd(t.clips[0]), 30);
  }
});

test("slow-mo (0.5x) doubles the timeline length", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 0.5);
  assert.equal(clipEnd(p.tracks.find((t) => t.kind === "video")!.clips[0]), 120);
});

test("reverse maps timeline start to sourceOut and end to sourceIn", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 1, true);
  const rv = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipReversed(rv), true);
  assert.equal(sourceTimeAt(rv, 0), 60); // start plays the last source frame
  assert.equal(sourceTimeAt(rv, 60), 0); // end plays the first source frame
});

test("addClipEffect appends with params; clipEffects reads the stack", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.deepEqual(clipEffects(v), []);
  p = addClipEffect(p, v.id, "blur", { amount: 8 });
  const v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipEffects(v2).length, 1);
  assert.equal(clipEffects(v2)[0].type, "blur");
  assert.equal(clipEffects(v2)[0].params.amount, 8);
});

test("placeMedia sends overlapping audio to fresh lanes (no pile-up)", () => {
  let p = emptyProject(1, 2); // V1 + A1, A2
  p = addMedia(p, media);
  p = placeMedia(p, "m1", 0); // V1 clip + audio on A1/A2 over [0,60]
  p = addVideoTrack(p);
  p = addMedia(p, { ...media, id: "m2", path: "b.mp4" });
  const v2 = p.tracks.find((t) => t.kind === "video" && t.clips.length === 0)!;
  p = placeMedia(p, "m2", 0, v2.id); // overlaps in time, different video track
  const audio = p.tracks.filter((t) => t.kind === "audio");
  assert.equal(audio.length, 4); // A1/A2 kept, A3/A4 created
  for (const t of audio) assert.equal(t.clips.length, 1); // no lane holds two clips
});

test("colour matte places as a video clip with no audio and a stretchable edge", () => {
  const matte: Media = {
    id: "cm",
    path: "",
    name: "Color Matte",
    duration: 5,
    hasVideo: true,
    audioStreamCount: 0,
    isColor: true,
    color: "#123456",
    width: 1920,
    height: 1080,
  };
  let p = emptyProject(1, 2);
  p = addMedia(p, matte);
  p = placeMedia(p, "cm", 0);
  const v = p.tracks.find((t) => t.kind === "video")!;
  assert.equal(v.clips.length, 1);
  const audioClips = p.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);
  assert.equal(audioClips.length, 0); // mattes carry no audio
  // Infinite source handle: the out-edge can extend well past the 5s default.
  p = setClipEdge(p, v.clips[0].id, "out", 30);
  assert.equal(clipEnd(p.tracks.find((t) => t.kind === "video")!.clips[0]), 30);
});

test("setMatteColor updates the fill colour", () => {
  const matte: Media = {
    id: "cm",
    path: "",
    name: "Color Matte",
    duration: 5,
    hasVideo: true,
    audioStreamCount: 0,
    isColor: true,
    color: "#123456",
  };
  let p = emptyProject(1, 0);
  p = addMedia(p, matte);
  p = setMatteColor(p, "cm", "#abcdef");
  assert.equal(p.media.find((m) => m.id === "cm")!.color, "#abcdef");
});

test("setMatteGradient sets and clears the gradient", () => {
  const matte: Media = {
    id: "cm",
    path: "",
    name: "Color Matte",
    duration: 5,
    hasVideo: true,
    audioStreamCount: 0,
    isColor: true,
    color: "#123456",
  };
  let p = emptyProject(1, 0);
  p = addMedia(p, matte);
  p = setMatteGradient(p, "cm", { color2: "#ffffff", angle: 45 });
  assert.deepEqual(p.media.find((m) => m.id === "cm")!.gradient, { color2: "#ffffff", angle: 45 });
  p = setMatteGradient(p, "cm", null);
  assert.equal(p.media.find((m) => m.id === "cm")!.gradient, undefined);
});

test("placeMedia reuses audio lanes when there's no time overlap", () => {
  let p = emptyProject(1, 2);
  p = addMedia(p, media);
  p = placeMedia(p, "m1", 0); // [0,60] on A1/A2
  p = addMedia(p, { ...media, id: "m2", path: "b.mp4" });
  p = placeMedia(p, "m2", 60); // [60,120] — no overlap, reuse A1/A2
  const audio = p.tracks.filter((t) => t.kind === "audio");
  assert.equal(audio.length, 2);
  for (const t of audio) assert.equal(t.clips.length, 2);
});

test("moveClipEffect reorders the stack (order affects render)", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = addClipEffect(p, v.id, "brightness", { amount: 10 });
  p = addClipEffect(p, v.id, "blur", { amount: 5 });
  p = moveClipEffect(p, v.id, 1, -1); // blur up to index 0
  let v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.deepEqual(
    clipEffects(v2).map((e) => e.type),
    ["blur", "brightness"],
  );
  // Out-of-range moves are no-ops.
  const before = p;
  p = moveClipEffect(p, v.id, 0, -1);
  assert.equal(p, before);
});

test("appendClipEffects deep-copies a stack; clearClipEffects empties it", () => {
  let p = loaded();
  const [v, w] = (() => {
    let q = addVideoTrack(p);
    q = addMedia(q, { ...media, id: "m2", path: "b.mp4" });
    const v = q.tracks.find((t) => t.kind === "video" && t.clips.length > 0)!.clips[0];
    const emptyV = q.tracks.find((t) => t.kind === "video" && t.clips.length === 0)!;
    q = placeMedia(q, "m2", 0, emptyV.id);
    p = q;
    const w = q.tracks.find((t) => t.kind === "video" && t.clips.some((c) => c.mediaId === "m2"))!
      .clips[0];
    return [v, w];
  })();
  p = addClipEffect(p, v.id, "hue", { angle: 30 });
  const src = clipEffects(findClip(p, v.id)!);
  p = appendClipEffects(p, w.id, src);
  const wEff = clipEffects(findClip(p, w.id)!);
  assert.equal(wEff.length, 1);
  assert.equal(wEff[0].type, "hue");
  assert.notEqual(wEff[0], src[0]); // deep copy, not the same object
  p = clearClipEffects(p, w.id);
  assert.equal(findClip(p, w.id)!.effects, undefined);
});

test("setClipEffectParam / toggle / remove mutate immutably", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = addClipEffect(p, v.id, "brightness", { amount: 0 });
  const before = p;
  p = setClipEffectParam(p, v.id, 0, "amount", 40);
  assert.notEqual(p, before); // new project object
  let v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipEffects(v2)[0].params.amount, 40);

  p = toggleClipEffect(p, v.id, 0);
  v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipEffects(v2)[0].enabled, false);

  p = removeClipEffect(p, v.id, 0);
  v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.deepEqual(clipEffects(v2), []);
  assert.equal(v2.effects, undefined); // stack fully cleared
});

test("effect params animate: setEffectKeyframe interpolates, resolvedEffects folds", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = addClipEffect(p, v.id, "brightness", { amount: 0 });
  // Keyframe 0 -> 0 at t=0, 0 -> 100 at t=10.
  p = setEffectKeyframe(p, v.id, 0, "amount", 0, 0);
  p = setEffectKeyframe(p, v.id, 0, "amount", 10, 100);
  const v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(isEffectParamAnimated(v2.effects![0], "amount"), true);
  assert.equal(clipHasEffectKeyframes(v2), true);
  assert.equal(effectParamAt(v2.effects![0], "amount", 5), 50); // midpoint
  // resolvedEffects at t=2.5 gives amount 25.
  const r = resolvedEffects(v2, 2.5);
  assert.equal(r[0].params.amount, 25);
});

test("clearEffectKeyframes turns animation off and drops the keyframes map", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = addClipEffect(p, v.id, "blur", { amount: 5 });
  p = setEffectKeyframe(p, v.id, 0, "amount", 0, 5);
  p = clearEffectKeyframes(p, v.id, 0, "amount");
  const v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipHasEffectKeyframes(v2), false);
  assert.equal(v2.effects![0].keyframes, undefined);
});

test("setClipEffectColor stores a hex colour on the effect", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = addClipEffect(p, v.id, "chromakey", { similarity: 30, blend: 10 }, { color: "#00d000" });
  p = setClipEffectColor(p, v.id, 0, "color", "#123456");
  const v2 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(v2.effects![0].colors!.color, "#123456");
});

test("gain automation: keyframes interpolate; clear reverts to constant", () => {
  let p = loaded();
  const a = p.tracks.find((t) => t.kind === "audio")!.clips[0];
  p = setGainKeyframe(p, a.id, 0, 0);
  p = setGainKeyframe(p, a.id, 10, 1);
  const a2 = findClip(p, a.id)!;
  assert.equal(isGainAnimated(a2), true);
  assert.equal(gainAt(a2, 5), 0.5); // midpoint ramp
  assert.equal(gainAt(a2, 0), 0);
  p = clearGainKeyframes(p, a.id);
  assert.equal(isGainAnimated(findClip(p, a.id)!), false);
});

test("moveGainKeyframe relocates a point (time + value)", () => {
  let p = loaded();
  const a = p.tracks.find((t) => t.kind === "audio")!.clips[0];
  p = setGainKeyframe(p, a.id, 2, 0.5);
  p = moveGainKeyframe(p, a.id, 2, 5, 0.8);
  const kfs = findClip(p, a.id)!.gainKeyframes!;
  assert.equal(kfs.length, 1);
  assert.equal(kfs[0].t, 5);
  assert.equal(kfs[0].v, 0.8);
});

test("splitting a 2x clip divides the source at the retimed point", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 2); // 60s source -> 30s on the timeline
  const ids = groupMembers(p, p.tracks.find((t) => t.kind === "video")!.clips[0].id);
  p = splitAt(p, 10, ids); // cut 10s into the 30s clip
  const clips = p.tracks
    .find((t) => t.kind === "video")!
    .clips.sort((a, b) => a.start - b.start);
  // Left is 0..10 timeline = 0..20 source; right is 10..30 = 20..60 source.
  assert.equal(clips[0].sourceIn, 0);
  assert.equal(clips[0].sourceOut, 20);
  assert.equal(clips[1].sourceIn, 20);
  assert.equal(clips[1].sourceOut, 60);
});

test("splitting a reversed clip keeps each half's frames", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 1, true); // reversed 60s
  const ids = groupMembers(p, p.tracks.find((t) => t.kind === "video")!.clips[0].id);
  p = splitAt(p, 20, ids);
  const clips = p.tracks
    .find((t) => t.kind === "video")!
    .clips.sort((a, b) => a.start - b.start);
  // Left (0..20) plays source 60->40; right (20..60) plays 40->0.
  assert.equal(clips[0].sourceIn, 40);
  assert.equal(clips[0].sourceOut, 60);
  assert.equal(clips[1].sourceIn, 0);
  assert.equal(clips[1].sourceOut, 40);
});

test("trimming the out-edge of a 2x clip consumes source at 2x", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 2); // 30s on the timeline
  const id = p.tracks.find((t) => t.kind === "video")!.clips[0].id;
  p = setClipEdge(p, id, "out", 20); // shorten to 20s on the timeline
  const c = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipEnd(c), 20);
  assert.equal(c.sourceOut, 40); // 20 timeline * 2x = 40s of source
});

test("cross-dissolve resolves into an overlap by borrowing source handles", () => {
  let p = loaded(); // 60s on V1 + audio
  const vtrack = p.tracks.find((t) => t.kind === "video")!;
  p = splitAt(p, 10, groupMembers(p, vtrack.clips[0].id)); // A[0..10], B[10..60]
  const A = p.tracks.find((t) => t.kind === "video")!.clips.find((c) => c.start === 0)!;
  p = setClipTransition(p, A.id, { kind: "dissolve", duration: 2 });
  const vt = p.tracks.find((t) => t.kind === "video")!;
  const segs = resolveVideoSegments(vt, (id) => (id === "m1" ? 60 : Infinity)).sort(
    (a, b) => a.start - b.start,
  );
  // Half (1s) borrowed from each side: A's tail extends, B's head pulls back, and
  // B cross-fades in over the full 2s overlap while A stays opaque.
  assert.equal(segs[0].end, 11);
  assert.equal(segs[0].sourceOut, 11);
  assert.equal(segs[0].xIn, 0);
  assert.equal(segs[1].start, 9);
  assert.equal(segs[1].sourceIn, 9);
  assert.equal(segs[1].xIn, 2);
});

test("push transition slides both clips (in from right, out to left)", () => {
  let p = loaded();
  const vtrack = p.tracks.find((t) => t.kind === "video")!;
  p = splitAt(p, 10, groupMembers(p, vtrack.clips[0].id));
  const A = p.tracks.find((t) => t.kind === "video")!.clips.find((c) => c.start === 0)!;
  p = setClipTransition(p, A.id, { kind: "push", duration: 2 });
  const vt = p.tracks.find((t) => t.kind === "video")!;
  const segs = resolveVideoSegments(vt, (id) => (id === "m1" ? 60 : Infinity)).sort(
    (a, b) => a.start - b.start,
  );
  assert.equal(segs[1].xIn, 0); // geometric, not alpha
  assert.equal(segs[1].slideRole, "in");
  assert.equal(segSlideOffsetX(segs[1], 9), 1); // off right at window start
  assert.equal(segSlideOffsetX(segs[1], 11), 0); // centred at end
  assert.equal(segs[0].slideRole, "out"); // A pushes left
  assert.equal(segSlideOffsetX(segs[0], 11), -1);
});

test("slide transition moves only the incoming clip", () => {
  let p = loaded();
  const vtrack = p.tracks.find((t) => t.kind === "video")!;
  p = splitAt(p, 10, groupMembers(p, vtrack.clips[0].id));
  const A = p.tracks.find((t) => t.kind === "video")!.clips.find((c) => c.start === 0)!;
  p = setClipTransition(p, A.id, { kind: "slide", duration: 2 });
  const vt = p.tracks.find((t) => t.kind === "video")!;
  const segs = resolveVideoSegments(vt, (id) => (id === "m1" ? 60 : Infinity)).sort(
    (a, b) => a.start - b.start,
  );
  assert.equal(segs[1].slideRole, "in");
  assert.equal(segs[0].slideKind, undefined); // A stays put under B
});

test("dip to black adds opaque fades at the cut with no overlap", () => {
  let p = loaded();
  const vtrack = p.tracks.find((t) => t.kind === "video")!;
  p = splitAt(p, 10, groupMembers(p, vtrack.clips[0].id));
  const A = p.tracks.find((t) => t.kind === "video")!.clips.find((c) => c.start === 0)!;
  p = setClipTransition(p, A.id, { kind: "dip-black", duration: 2 });
  const vt = p.tracks.find((t) => t.kind === "video")!;
  const segs = resolveVideoSegments(vt, () => 60).sort((a, b) => a.start - b.start);
  assert.equal(segs[0].end, 10); // no extension
  assert.equal(segs[0].xOut, 1); // A fades to black over half
  assert.equal(segs[0].toBlack, true);
  assert.equal(segs[1].start, 10);
  assert.equal(segs[1].xIn, 1); // B fades up from black over half
});

test("a dissolve with no adjacent clip is a no-op on resolve", () => {
  let p = loaded();
  const A = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipTransition(p, A.id, { kind: "dissolve", duration: 2 });
  const vt = p.tracks.find((t) => t.kind === "video")!;
  const segs = resolveVideoSegments(vt, () => 60);
  assert.equal(segs[0].end, clipEnd(A)); // unchanged; nothing to dissolve into
  assert.equal(segs[0].xIn, 0);
});

test("setClipBlend sets a mode and clearing back to normal drops the field", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipBlend(v), "normal");
  p = setClipBlend(p, v.id, "screen");
  assert.equal(clipBlend(p.tracks.find((t) => t.kind === "video")!.clips[0]), "screen");
  p = setClipBlend(p, v.id, "normal");
  assert.equal(p.tracks.find((t) => t.kind === "video")!.clips[0].blend, undefined);
});

test("placeMedia with a source range creates a trimmed sub-clip", () => {
  let p = emptyProject(1, 2);
  p = addMedia(p, media); // 60s, 2 audio streams
  p = placeMedia(p, "m1", 0, undefined, { in: 10, out: 25 });
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(v.sourceIn, 10);
  assert.equal(v.sourceOut, 25);
  assert.equal(clipEnd(v), 15); // 15s on the timeline
  // Linked audio uses the same range.
  const a = p.tracks.find((t) => t.kind === "audio")!.clips[0];
  assert.equal(a.sourceIn, 10);
  assert.equal(a.sourceOut, 25);
  assert.equal(placedLength(media, { in: 10, out: 25 }), 15);
});

test("insertMediaAt honours a source range when rippling", () => {
  let p = emptyProject(1, 0);
  p = addMedia(p, { ...media, audioStreamCount: 0 });
  p = placeMedia(p, "m1", 0); // 0..60 full
  p = addMedia(p, { ...media, id: "m2", audioStreamCount: 0 });
  p = insertMediaAt(p, "m2", 20, undefined, { in: 5, out: 15 }); // 10s insert
  const clips = p.tracks[0].clips.sort((a, b) => a.start - b.start);
  assert.equal(clips[1].mediaId, "m2");
  assert.equal(clipEnd(clips[1]) - clips[1].start, 10); // trimmed length
  assert.equal(clips[2].start, 30); // tail pushed by exactly 10s
});

test("rate-stretch changes a clip's speed to fit a new out-edge length", () => {
  let p = loaded(); // 60s clip at 0
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = rateStretchEdge(p, v.id, "out", 30); // squeeze 60s of source into 30s
  const c = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipSpeed(c), 2); // 60/30
  assert.equal(c.sourceIn, 0); // source unchanged
  assert.equal(c.sourceOut, 60);
  assert.equal(clipEnd(c), 30);
});

test("rate-stretch on the in-edge keeps the tail anchored", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  const end = clipEnd(v); // 60
  p = rateStretchEdge(p, v.id, "in", 40); // new length 20 -> 3x
  const c = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(clipSpeed(c), 3);
  assert.equal(Math.round(clipEnd(c)), end); // tail stays at 60
  assert.equal(c.start, 40);
});

test("slip shifts a clip's source without moving it (clamped to media)", () => {
  let p = loaded();
  const v0 = p.tracks.find((t) => t.kind === "video")!.clips[0];
  // Trim to a 20s window in the middle so there's handle on both sides.
  p = setClipEdge(p, v0.id, "in", 20); // sourceIn 20, start 20
  p = setClipEdge(p, v0.id, "out", 40); // sourceOut 40
  const before = p.tracks.find((t) => t.kind === "video")!.clips[0];
  const start = before.start;
  p = slipClip(p, before.id, 5); // show 5s later source
  const c = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(c.sourceIn, 25);
  assert.equal(c.sourceOut, 45);
  assert.equal(c.start, start); // position unchanged
  // Clamps: can't slip past the media end (sourceOut <= 60).
  let p2 = slipClip(p, c.id, 999);
  const c2 = p2.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(c2.sourceOut, 60);
});

test("slide moves a clip and grows/shrinks its neighbours", () => {
  let p = emptyProject(1, 0);
  p = addMedia(p, { ...media, audioStreamCount: 0 });
  p = placeMedia(p, "m1", 0); // 0..60
  p = splitAt(p, 20, p.tracks[0].clips.map((c) => c.id)); // A[0..20], B[20..60]
  p = splitAt(p, 40, p.tracks[0].clips.map((c) => c.id)); // B[20..40], C[40..60]
  const mid = p.tracks[0].clips.sort((a, b) => a.start - b.start)[1]; // B at 20..40
  p = slideClip(p, mid.id, 5); // slide B right by 5
  const clips = p.tracks[0].clips.sort((a, b) => a.start - b.start);
  assert.equal(clips[1].start, 25); // B moved
  assert.equal(clipEnd(clips[0]), 25); // A (prev) grew to meet it
  assert.equal(clips[2].start, 45); // C (next) start pushed right
  assert.equal(clipEnd(clips[2]), 60); // C tail stayed put
});

test("setClipsEnabled toggles the disabled flag", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipsEnabled(p, [v.id], false);
  assert.equal(clipEnabled(p.tracks.find((t) => t.kind === "video")!.clips[0]), false);
  p = setClipsEnabled(p, [v.id], true);
  assert.equal(p.tracks.find((t) => t.kind === "video")!.clips[0].disabled, undefined);
});

test("keyframes interpolate linearly and clamp at the ends", () => {
  const kfs = [
    { t: 0, v: 0 },
    { t: 2, v: 10 },
  ];
  assert.equal(evalKeyframes(kfs, -1), 0); // clamp before
  assert.equal(evalKeyframes(kfs, 0), 0);
  assert.equal(evalKeyframes(kfs, 1), 5); // halfway
  assert.equal(evalKeyframes(kfs, 2), 10);
  assert.equal(evalKeyframes(kfs, 5), 10); // clamp after
});

test("setKeyframe animates a property; animatedTransform reads it at a time", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(isAnimated(v, "x"), false);
  p = setKeyframe(p, v.id, "x", 0, 0.0); // x=0 at clip start
  p = setKeyframe(p, v.id, "x", 10, 1.0); // x=1 at +10s
  const c = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(isAnimated(c, "x"), true);
  assert.equal(animatedTransform(c, 0).x, 0);
  assert.equal(animatedTransform(c, 5).x, 0.5); // midway
  assert.equal(animatedTransform(c, 10).x, 1);
  // Non-animated props fall back to the static transform.
  assert.equal(animatedTransform(c, 5).scaleX, 1);
});

test("opacity keyframes clamp to 0..1 and clearing reverts to static", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setKeyframe(p, v.id, "opacity", 0, 0);
  p = setKeyframe(p, v.id, "opacity", 4, 1);
  let c = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(animatedOpacity(c, 2), 0.5);
  p = clearKeyframes(p, v.id, "opacity");
  c = p.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(isAnimated(c, "opacity"), false);
  assert.equal(animatedOpacity(c, 2), 1); // back to static default
});

test("markers add sorted, find-near, navigate, and remove", () => {
  let p = emptyProject(1, 0);
  p = addMarker(p, 20);
  p = addMarker(p, 5); // added out of order
  const ms = projectMarkers(p);
  assert.deepEqual(ms.map((m) => m.time), [5, 20]); // kept sorted
  assert.equal(markerNear(p, 5.05, 0.1)?.time, 5);
  assert.equal(markerNear(p, 12, 0.1), undefined);
  assert.equal(nextMarker(p, 5)?.time, 20);
  assert.equal(prevMarker(p, 20)?.time, 5);
  p = removeMarker(p, ms[0].id);
  assert.deepEqual(projectMarkers(p).map((m) => m.time), [20]);
});

test("rippleDelete removes a clip and closes the gap on all tracks", () => {
  // Two clips back-to-back on one video track: 0..60 and 60..120.
  let p = emptyProject(1, 0);
  p = addMedia(p, { ...media, audioStreamCount: 0 });
  p = addMedia(p, { ...media, id: "m2", audioStreamCount: 0 });
  p = placeMedia(p, "m1", 0);
  p = placeMedia(p, "m2", 60);
  const first = p.tracks[0].clips.find((c) => c.mediaId === "m1")!;
  p = rippleDelete(p, [first.id]);
  const clips = p.tracks[0].clips;
  assert.equal(clips.length, 1);
  assert.equal(clips[0].mediaId, "m2");
  assert.equal(clips[0].start, 0); // pulled left to close the gap
});

test("insertMediaAt ripples the sequence open and drops the clip in", () => {
  let p = emptyProject(1, 0);
  p = addMedia(p, { ...media, audioStreamCount: 0, duration: 60 });
  p = addMedia(p, { ...media, id: "m2", audioStreamCount: 0, duration: 10 });
  p = placeMedia(p, "m1", 0); // 0..60
  p = insertMediaAt(p, "m2", 20); // insert 10s at t=20
  const clips = p.tracks[0].clips.sort((a, b) => a.start - b.start);
  // m1 split at 20 -> [0..20], inserted m2 [20..30], m1 tail pushed to [30..70].
  assert.equal(clips.length, 3);
  assert.equal(clips[1].mediaId, "m2");
  assert.equal(clips[1].start, 20);
  assert.equal(clips[2].start, 30);
});

test("overwriteMediaAt carves out what's underneath", () => {
  let p = emptyProject(1, 0);
  p = addMedia(p, { ...media, audioStreamCount: 0, duration: 60 });
  p = addMedia(p, { ...media, id: "m2", audioStreamCount: 0, duration: 10 });
  p = placeMedia(p, "m1", 0); // 0..60
  p = overwriteMediaAt(p, "m2", 20); // overwrite 20..30
  const clips = p.tracks[0].clips.sort((a, b) => a.start - b.start);
  // m1 becomes [0..20] and [30..60] with m2 [20..30] between; nothing shifts.
  assert.equal(clips.length, 3);
  assert.equal(clips[0].start, 0);
  assert.equal(clipEnd(clips[0]), 20);
  assert.equal(clips[1].mediaId, "m2");
  assert.equal(clips[2].start, 30);
  assert.equal(clipEnd(clips[2]), 60);
});

test("placeMedia can target a specific video track (drag-and-drop)", () => {
  let p = emptyProject(1, 2);
  p = addVideoTrack(p); // now two video tracks; [0] is the new top
  p = addMedia(p, media);
  const bottomVideoId = p.tracks.filter((t) => t.kind === "video")[1].id;
  p = placeMedia(p, "m1", 3, bottomVideoId);
  const videoTracks = p.tracks.filter((t) => t.kind === "video");
  assert.equal(videoTracks[0].clips.length, 0); // not the top track
  assert.equal(videoTracks[1].clips.length, 1); // placed on the chosen track
  assert.equal(videoTracks[1].clips[0].start, 3);
});

test("placeMedia falls back to the top video track for an unknown track id", () => {
  let p = loaded();
  const before = p.tracks.filter((t) => t.kind === "video")[0].clips.length;
  p = placeMedia(p, "m1", 0, "does-not-exist");
  assert.equal(p.tracks.filter((t) => t.kind === "video")[0].clips.length, before + 1);
});

test("moveClipsLayered relocates audio to dedicated lanes on cross-video-track move", () => {
  // Two clips on V1, both audio sharing A1/A2. Add a top video track, then move
  // the second clip's group up to it (an overlay layer).
  let p = emptyProject(1, 2);
  p = addMedia(p, media);
  p = addMedia(p, { ...media, id: "m2", path: "b.mp4" });
  p = placeMedia(p, "m1", 0);
  p = placeMedia(p, "m2", 60);
  p = addVideoTrack(p); // new top video track (index 0)

  const m2video = p.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips)
    .find((c) => c.mediaId === "m2")!;
  const group = groupMembers(p, m2video.id);

  const before = p.tracks.filter((t) => t.kind === "audio").length;
  p = moveClipsLayered(p, group, 0, -1, "video"); // up one video track

  const audioTracks = p.tracks.filter((t) => t.kind === "audio");
  assert.equal(audioTracks.length, before + 2); // two fresh dedicated lanes

  // m2's audio must no longer share a track with m1's audio.
  for (const t of audioTracks) {
    const groups = new Set(t.clips.map((c) => c.groupId));
    assert.ok(groups.size <= 1, "each lane holds a single group's audio");
  }
  // The moved video really is on the top track now.
  assert.ok(p.tracks.filter((t) => t.kind === "video")[0].clips.some((c) => c.mediaId === "m2"));
});

test("moveClipsLayered leaves audio in place when the sole group stays dedicated", () => {
  let p = loaded();
  p = addVideoTrack(p);
  const v = p.tracks.filter((t) => t.kind === "video")[1].clips[0];
  const before = p.tracks.filter((t) => t.kind === "audio").length;
  p = moveClipsLayered(p, groupMembers(p, v.id), 0, -1, "video");
  // Only one group exists, so its audio lanes are already dedicated: no new tracks.
  assert.equal(p.tracks.filter((t) => t.kind === "audio").length, before);
});

test("placeMedia creates one video + N audio clips, all linked", () => {
  const p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!;
  const audios = p.tracks.filter((t) => t.kind === "audio");
  assert.equal(v.clips.length, 1);
  assert.equal(audios[0].clips.length, 1);
  assert.equal(audios[1].clips.length, 1);

  const vClip = v.clips[0];
  assert.equal(vClip.kind, "video");
  assert.equal(clipDuration(vClip), 60);
  assert.equal(audios[1].clips[0].audioStream, 1);

  // All three share one group.
  const group = groupMembers(p, vClip.id);
  assert.equal(group.length, 3);
});

test("timelineDuration reflects the furthest clip end", () => {
  const p = loaded();
  assert.equal(timelineDuration(p), 60);
});

test("splitAt razors a clip into two abutting halves with correct source math", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!;
  const clip = v.clips[0];

  const p1 = splitAt(p0, 20, [clip.id]);
  const v1 = p1.tracks.find((t) => t.kind === "video")!;
  assert.equal(v1.clips.length, 2);

  const [left, right] = v1.clips;
  // Left: 0..20 timeline, source 0..20
  assert.equal(left.start, 0);
  assert.equal(clipEnd(left), 20);
  assert.equal(left.sourceIn, 0);
  assert.equal(left.sourceOut, 20);
  // Right: 20..60 timeline, source 20..60 (abuts, no gap/overlap)
  assert.equal(right.start, 20);
  assert.equal(clipEnd(right), 60);
  assert.equal(right.sourceIn, 20);
  assert.equal(right.sourceOut, 60);
});

test("splitAt ignores clips that do not span the time", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!;
  const clip = v.clips[0];
  const before = splitAt(p0, 0, [clip.id]); // at the very start: no split
  assert.equal(before.tracks.find((t) => t.kind === "video")!.clips.length, 1);
  const after = splitAt(p0, 60, [clip.id]); // at the very end: no split
  assert.equal(after.tracks.find((t) => t.kind === "video")!.clips.length, 1);
});

test("cutting the whole group at a time splits video + both audio together", () => {
  const p0 = loaded();
  const anyClip = p0.tracks[0].clips[0];
  const ids = groupMembers(p0, anyClip.id);
  const p1 = splitAt(p0, 30, ids);
  for (const t of p1.tracks) assert.equal(t.clips.length, 2, `track ${t.kind}`);
});

test("after a cut the two segments are independent groups, each internally linked", () => {
  const p0 = loaded();
  const anyClip = p0.tracks[0].clips[0];
  const p1 = splitAt(p0, 30, groupMembers(p0, anyClip.id));

  const v = p1.tracks.find((t) => t.kind === "video")!;
  const [leftV, rightV] = v.clips; // sorted by start: left then right

  // Left segment: video + its audio still linked (3 members), same group.
  const leftGroup = groupMembers(p1, leftV.id);
  assert.equal(leftGroup.length, 3);
  // Right segment: also 3 members, but a DIFFERENT group than the left.
  const rightGroup = groupMembers(p1, rightV.id);
  assert.equal(rightGroup.length, 3);
  assert.notEqual(leftV.groupId, rightV.groupId);

  // So dragging the right segment must NOT drag the left one.
  assert.equal(leftGroup.includes(rightV.id), false);
});

test("setClipEdge in shifts start and sourceIn together", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!;
  const p1 = setClipEdge(p0, v.clips[0].id, "in", 10);
  const c = p1.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(c.start, 10);
  assert.equal(c.sourceIn, 10);
  assert.equal(c.sourceOut, 60);
  assert.equal(clipDuration(c), 50);
});

test("setClipEdge out changes the tail, clamped to media duration", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!;
  const p1 = setClipEdge(p0, v.clips[0].id, "out", 40);
  assert.equal(p1.tracks.find((t) => t.kind === "video")!.clips[0].sourceOut, 40);
  // Beyond the 60s source: clamps to 60.
  const p2 = setClipEdge(p0, v.clips[0].id, "out", 999);
  assert.equal(p2.tracks.find((t) => t.kind === "video")!.clips[0].sourceOut, 60);
});

test("setClipEdge in is clamped so sourceIn never goes negative", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!;
  const p1 = setClipEdge(p0, v.clips[0].id, "in", -30);
  const c = p1.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.equal(c.start, 0);
  assert.equal(c.sourceIn, 0);
});

test("setClipEdge in will not overlap the previous clip", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!;
  // Cut at 30 so there are two clips; trimming the right one's in-edge left
  // must stop at the left clip's end (30).
  const p1 = splitAt(p0, 30, [v.clips[0].id]);
  const right = p1.tracks.find((t) => t.kind === "video")!.clips[1];
  const p2 = setClipEdge(p1, right.id, "in", 5);
  const r = p2.tracks.find((t) => t.kind === "video")!.clips[1];
  assert.equal(r.start, 30);
});

test("setClipEdge trims the whole linked group together", () => {
  const p0 = loaded(); // video + 2 audio, all linked, 0..60
  const v = p0.tracks.find((t) => t.kind === "video")!;
  const p1 = setClipEdge(p0, v.clips[0].id, "in", 10);
  // Every linked member moved its in-edge to 10 in lockstep.
  for (const t of p1.tracks) {
    assert.equal(t.clips[0].start, 10, `${t.kind} start`);
    assert.equal(t.clips[0].sourceIn, 10, `${t.kind} sourceIn`);
  }
});

test("setClipEdge group trim is clamped by the tightest member bound", () => {
  // Give one audio track a shorter source so it limits the whole group's tail.
  let p = emptyProject(1, 2);
  p = addMedia(p, { ...media, id: "m1", duration: 60, audioStreamCount: 2 });
  p = placeMedia(p, "m1", 0);
  // Manually shorten audio stream 1's source media isn't possible per-clip, so
  // instead trim that one clip's tail first, then group-trim should respect it.
  const a2 = p.tracks.filter((t) => t.kind === "audio")[1];
  // Unlink so we can set up an independent shorter clip, then relink.
  p = unlinkClips(p, [a2.clips[0].id]);
  p = setClipEdge(p, a2.clips[0].id, "out", 30); // this audio now 0..30
  // Relink everything.
  const allIds = p.tracks.flatMap((t) => t.clips.map((c) => c.id));
  p = linkClips(p, allIds);
  // Now extend the group tail as far as possible; the 30s clip caps growth.
  const v = p.tracks.find((t) => t.kind === "video")!;
  const before = p.tracks.filter((t) => t.kind === "audio")[1].clips[0].sourceOut;
  p = setClipEdge(p, v.clips[0].id, "out", 999);
  const after = p.tracks.filter((t) => t.kind === "audio")[1].clips[0].sourceOut;
  // The short clip can't exceed its 30s media, so the group tail can't grow it.
  assert.ok(after <= 30 + 1e-9, `short clip capped at 30, got ${after}`);
  assert.equal(before, after); // it was already at its max
});

test("setClipGain clamps to [0, 2] and defaults to unity", () => {
  const p0 = loaded();
  const a = p0.tracks.find((t) => t.kind === "audio")!.clips[0];
  assert.equal(clipGain(a), 1); // default unity
  const p1 = setClipGain(p0, a.id, 0.5);
  assert.equal(clipGain(findClip(p1, a.id)!), 0.5);
  const p2 = setClipGain(p0, a.id, 99);
  assert.equal(clipGain(findClip(p2, a.id)!), 2); // clamped high
  const p3 = setClipGain(p0, a.id, -1);
  assert.equal(clipGain(findClip(p3, a.id)!), 0); // clamped low
});

test("setClipTransform merges a partial transform; default is identity", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!.clips[0];
  assert.ok(isIdentityTransform(clipTransform(v)));
  let p = setClipTransform(p0, v.id, { scaleX: 0.5, scaleY: 0.5 });
  let t = clipTransform(findClip(p, v.id)!);
  assert.equal(t.scaleX, 0.5);
  assert.equal(t.x, 0.5); // untouched
  p = setClipTransform(p, v.id, { x: 0.25, y: 0.75 });
  t = clipTransform(findClip(p, v.id)!);
  assert.equal(t.x, 0.25);
  assert.equal(t.y, 0.75);
  assert.equal(t.scaleX, 0.5); // preserved across merges
  assert.equal(t.scaleY, 0.5);
  assert.equal(isIdentityTransform(t), false);
});

test("non-proportional scale keeps each axis independent", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!.clips[0];
  const p = setClipTransform(p0, v.id, { scaleX: 1.5 });
  const t = clipTransform(findClip(p, v.id)!);
  assert.equal(t.scaleX, 1.5);
  assert.equal(t.scaleY, 1); // untouched — stretched, not uniform
  assert.equal(isIdentityTransform(t), false);
});

test("transform survives a split", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!.clips[0];
  const p1 = setClipTransform(p0, v.id, { scaleX: 0.4, scaleY: 0.4, x: 0.2 });
  const p2 = splitAt(p1, 30, [v.id]);
  const halves = p2.tracks.find((t) => t.kind === "video")!.clips;
  assert.equal(clipTransform(halves[0]).scaleX, 0.4);
  assert.equal(clipTransform(halves[1]).x, 0.2);
});

test("gain survives a split (both halves keep it)", () => {
  const p0 = loaded();
  const a = p0.tracks.find((t) => t.kind === "audio")!.clips[0];
  const p1 = setClipGain(p0, a.id, 0.7);
  const p2 = splitAt(p1, 30, [a.id]);
  const halves = p2.tracks.find((t) => t.kind === "audio")!.clips;
  assert.equal(halves.length, 2);
  assert.equal(clipGain(halves[0]), 0.7);
  assert.equal(clipGain(halves[1]), 0.7);
});

test("unlinkClips removes only the given clips from their group", () => {
  const p0 = loaded();
  const anyId = p0.tracks[0].clips[0].id;
  assert.equal(groupMembers(p0, anyId).length, 3);
  // Unlink just the video clip; the two audio clips remain linked to each other.
  const p1 = unlinkClips(p0, [anyId]);
  assert.equal(findClip(p1, anyId)!.groupId, null);
  const audio0 = p1.tracks.find((t) => t.kind === "audio")!.clips[0];
  assert.equal(groupMembers(p1, audio0.id).length, 2);
});

test("moveClips shifts a grouped set together and clamps start at 0", () => {
  const p0 = loaded();
  const vClip = p0.tracks[0].clips[0];
  const ids = groupMembers(p0, vClip.id);

  const p1 = moveClips(p0, ids, 10);
  for (const t of p1.tracks) assert.equal(t.clips[0].start, 10);

  // Try to move far negative: clamped so the earliest start lands on 0.
  const p2 = moveClips(p1, ids, -999);
  for (const t of p2.tracks) assert.equal(t.clips[0].start, 0);
});

test("dragging a linked video clip across video tracks does NOT move its audio", () => {
  let p = loaded(); // 1 video track (V), 2 audio (A1,A2), linked group
  p = addVideoTrack(p); // adds a new video track on top -> 2 video tracks now
  const vClip = p.tracks.find((t) => t.kind === "video" && t.clips.length > 0)!.clips[0];
  const ids = groupMembers(p, vClip.id);
  // Drag the video clip up one video track; restrictKind = "video".
  p = moveClips(p, ids, 0, -1, "video");
  // Audio clips must stay on their original audio tracks (A1 keeps its clip).
  const audios = p.tracks.filter((t) => t.kind === "audio");
  assert.equal(audios[0].clips.length, 1, "A1 keeps its clip");
  assert.equal(audios[1].clips.length, 1, "A2 keeps its clip");
});

test("moveClips can move an audio clip across audio tracks", () => {
  const p0 = loaded();
  const a1 = p0.tracks.find((t) => t.kind === "audio")!;
  const clip = a1.clips[0];
  const p1 = moveClips(p0, [clip.id], 0, 1); // down one audio track
  const audios = p1.tracks.filter((t) => t.kind === "audio");
  assert.equal(audios[0].clips.length, 0);
  assert.equal(audios[1].clips.length, 2); // its own + the moved one
  assert.equal(trackOfClip(p1, clip.id)!.kind, "audio");
});

test("clipAtTime finds the clip under the playhead", () => {
  const p0 = loaded();
  const v = p0.tracks.find((t) => t.kind === "video")!;
  const p1 = splitAt(p0, 25, [v.clips[0].id]);
  const v1 = p1.tracks.find((t) => t.kind === "video")!;
  assert.equal(clipAtTime(v1, 10)!.id, v1.clips[0].id);
  assert.equal(clipAtTime(v1, 40)!.id, v1.clips[1].id);
  assert.equal(clipAtTime(v1, 999), undefined);
});

test("link then unlink toggles grouping", () => {
  // Two independent single-audio medias, then link their clips.
  let p = emptyProject(1, 1);
  p = addMedia(p, { ...media, id: "m1", audioStreamCount: 0 });
  p = addMedia(p, { ...media, id: "m2", audioStreamCount: 0 });
  p = placeMedia(p, "m1", 0);
  p = placeMedia(p, "m2", 60);
  const v = p.tracks.find((t) => t.kind === "video")!;
  const [c1, c2] = v.clips;
  assert.notEqual(c1.groupId, c2.groupId); // different groups initially

  p = linkClips(p, [c1.id, c2.id]);
  assert.equal(groupMembers(p, c1.id).length, 2);

  p = unlinkGroup(p, c1.id);
  assert.equal(findClip(p, c1.id)!.groupId, null);
  assert.equal(groupMembers(p, c1.id).length, 1);
});

test("addVideoTrack adds a video track at the top; addAudioTrack at the bottom", () => {
  let p = emptyProject(1, 2); // V, A, A
  p = addVideoTrack(p);
  const videos = p.tracks.filter((t) => t.kind === "video");
  const audios = p.tracks.filter((t) => t.kind === "audio");
  assert.equal(videos.length, 2);
  assert.equal(p.tracks[0].kind, "video"); // new one is first (top)
  p = addAudioTrack(p);
  assert.equal(p.tracks.filter((t) => t.kind === "audio").length, audios.length + 1);
  assert.equal(p.tracks[p.tracks.length - 1].kind, "audio"); // appended at bottom
});

test("removeClips deletes clips from the project", () => {
  const p0 = loaded();
  const vClip = p0.tracks[0].clips[0];
  const p1 = removeClips(p0, [vClip.id]);
  assert.equal(findClip(p1, vClip.id), undefined);
});
