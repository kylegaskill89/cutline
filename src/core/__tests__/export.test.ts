import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  __resetIds,
  emptyProject,
  addMedia,
  placeMedia,
  splitAt,
  moveClips,
  setClipGain,
  setGainKeyframe,
  setClipEdge,
  setClipFade,
  setClipOpacity,
  setClipSpeed,
  setClipTransition,
  setClipBlend,
  setClipsEnabled,
  setKeyframe,
  setClipTransform,
  addClipEffect,
  setEffectKeyframe,
  addVideoTrack,
  updateTrack,
  groupMembers,
  clipEnd,
  type Media,
  type Project,
} from "../project.ts";
import { compileExport } from "../export.ts";

const media: Media = {
  id: "m1",
  path: "a.mp4",
  name: "a.mp4",
  duration: 60,
  hasVideo: true,
  audioStreamCount: 2,
  width: 1920,
  height: 1080,
  fps: 30,
};

const opts = { outputFile: "out.mp4", width: 1920, height: 1080, fps: 30 };

beforeEach(() => __resetIds());

function loaded(): Project {
  let p = emptyProject(1, 2);
  p = addMedia(p, media);
  p = placeMedia(p, "m1", 0);
  return p;
}

/** The filter_complex string is the token right after -filter_complex. */
function graphOf(args: string[]): string {
  return args[args.indexOf("-filter_complex") + 1];
}

test("one input per used media; maps both video and audio", () => {
  const args = compileExport(loaded(), opts);
  assert.equal(args.filter((a) => a === "-i").length, 1);
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-map"),
    ["[vout]", "[aout]"],
  );
  assert.equal(args[args.length - 1], "out.mp4");
});

test("video concat covers the whole timeline with a black gap filler", () => {
  // One clip at 0..60, then a second copy moved to start at 90 -> gap 60..90.
  let p = loaded();
  p = addMedia(p, { ...media, id: "m2", path: "b.mp4" });
  p = placeMedia(p, "m2", 90);
  const g = graphOf(compileExport(p, opts));
  // Expect: clip, black gap, clip -> concat n=3.
  assert.match(g, /concat=n=3:v=1:a=0\[vout\]/);
  assert.match(g, /color=c=black:s=1920x1080:r=30:d=30\.000/); // the 60->90 gap
});

test("a leading gap (clip not at 0) is filled with black", () => {
  let p = loaded();
  // move the whole group to start at 10
  p = moveClips(p, groupMembers(p, p.tracks[0].clips[0].id), 10);
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /color=c=black:s=1920x1080:r=30:d=10\.000/);
});

test("clip effects splice into the concat video chain", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = addClipEffect(p, v.id, "brightness", { amount: 30 });
  p = addClipEffect(p, v.id, "blur", { amount: 6 });
  const g = graphOf(compileExport(p, opts));
  // Single plain track stays on the concat path, with the effect chain injected.
  assert.match(g, /eq=brightness=0\.300,gblur=sigma=6\.00/);
  assert.match(g, /concat=n=1:v=1:a=0\[vout\]/);
});

test("clip effects splice into the overlay video chain", () => {
  // Force the overlay compositor with a non-identity transform, then add effects.
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipTransform(p, v.id, { scaleX: 1.5, scaleY: 1.5 });
  p = addClipEffect(p, v.id, "saturation", { amount: 200 });
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /format=yuva420p,eq=saturation=2\.000/);
});

test("chroma key emits an ffmpeg chromakey filter with the hex colour", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = addClipEffect(p, v.id, "chromakey", { similarity: 40, blend: 5 }, { color: "#00ff00" });
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /chromakey=0x00ff00:0\.400:0\.050/);
});

test("animated effect params force the overlay path and bake per-slice values", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  // Animate brightness 0 -> 100 over the first 2s.
  p = addClipEffect(p, v.id, "brightness", { amount: 0 });
  p = setEffectKeyframe(p, v.id, 0, "amount", 0, 0);
  p = setEffectKeyframe(p, v.id, 0, "amount", 2, 100);
  const g = graphOf(compileExport(p, { ...opts, rangeStart: 0, rangeEnd: 2 }));
  // Overlay path (not concat) + at least one non-zero baked brightness slice.
  assert.doesNotMatch(g, /concat=/);
  assert.match(g, /eq=brightness=0\.\d+/);
});

test("adjustment layer gates its effect chain onto the composite below", () => {
  let p = loaded();
  p = addVideoTrack(p);
  const adj: Media = {
    id: "adj",
    path: "",
    name: "Adjustment Layer",
    duration: 5,
    hasVideo: true,
    audioStreamCount: 0,
    isAdjustment: true,
    width: 1920,
    height: 1080,
  };
  p = addMedia(p, adj);
  const top = p.tracks.find((t) => t.kind === "video" && t.clips.length === 0)!;
  p = placeMedia(p, "adj", 0, top.id);
  const adjClip = p.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === "adj")!;
  p = addClipEffect(p, adjClip.id, "brightness", { amount: 30 });
  const g = graphOf(compileExport(p, opts));
  assert.doesNotMatch(g, /concat=/); // forced onto the overlay compositor
  assert.match(g, /eq=brightness=0\.300:enable='between\(t,/);
});

test("push transition bakes sliding overlay slices (no concat)", () => {
  let p = loaded();
  const vt = p.tracks.find((t) => t.kind === "video")!;
  p = splitAt(p, 10, [vt.clips[0].id]); // A[0..10], B[10..60] on one track
  const a = p.tracks.find((t) => t.kind === "video")!.clips.find((c) => c.start === 0)!;
  p = setClipTransition(p, a.id, { kind: "push", duration: 2 });
  const g = graphOf(compileExport(p, opts));
  assert.doesNotMatch(g, /concat=/); // forced onto the overlay compositor
  assert.match(g, /overlay=/); // baked slices overlaid
});

test("gain keyframes emit a per-frame volume automation expression", () => {
  let p = loaded();
  const a = p.tracks.find((t) => t.kind === "audio")!.clips[0];
  p = setGainKeyframe(p, a.id, 0, 0);
  p = setGainKeyframe(p, a.id, 2, 1);
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /volume=eval=frame:volume='if\(lt\(t,/);
});

test("per-clip gain appears in the audio chain", () => {
  let p = loaded();
  const a = p.tracks.find((t) => t.kind === "audio")!.clips[0];
  p = setClipGain(p, a.id, 0.5);
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /volume=0\.5,/);
});

test("each audio clip is delayed to its start and mixed", () => {
  const args = compileExport(loaded(), opts);
  const g = graphOf(args);
  // Two audio streams at start 0 -> adelay=0, amix inputs=2.
  assert.match(g, /adelay=0:all=1/);
  assert.match(g, /amix=inputs=2:duration=longest:normalize=0/);
});

test("audio clip delayed by its timeline start", () => {
  let p = loaded();
  // split at 20, move the right group to start at 50
  const rightIds = splitAt(p, 20, groupMembers(p, p.tracks[0].clips[0].id));
  p = rightIds;
  // find a right-hand audio clip (start 20) and move it +30 -> start 50
  const audioTrack = p.tracks.find((t) => t.kind === "audio")!;
  const rightClip = audioTrack.clips.find((c) => c.start === 20)!;
  p = moveClips(p, groupMembers(p, rightClip.id), 30);
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /adelay=50000:all=1/); // 50s -> 50000ms
});

test("video-only project (no audio clips) omits the audio map", () => {
  let p = emptyProject(1, 0); // no audio tracks
  p = addMedia(p, { ...media, audioStreamCount: 0 });
  p = placeMedia(p, "m1", 0);
  const args = compileExport(p, opts);
  assert.equal(args.includes("[aout]"), false);
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-map"),
    ["[vout]"],
  );
});

test("multiple video tracks composite via overlay, not concat", () => {
  // Base clip on V1 (0..60), plus a second video track with an overlay clip.
  let p = loaded();
  p = addVideoTrack(p); // new top video track
  p = addMedia(p, { ...media, id: "m2", path: "b.mp4" });
  // place m2 on the timeline; its video goes to the first (top) video track
  p = placeMedia(p, "m2", 10);
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /\[base\]/); // black base canvas
  assert.match(g, /overlay=eof_action=pass:x='.+':y='.+':enable='between\(t,/);
  assert.doesNotMatch(g, /concat=n=/); // not the single-track path
});

test("a non-identity transform forces the overlay path with scale + position", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipTransform(p, v.id, { scaleX: 0.5, scaleY: 0.5, x: 0.25, y: 0.75 });
  const g = graphOf(compileExport(p, opts));
  assert.doesNotMatch(g, /concat=n=/); // single track but transformed -> overlay
  assert.match(g, /scale=960:540/); // 0.5 * (media fit to 1920x1080)
  assert.match(g, /overlay=eof_action=pass:x='\(W\*0\.250\)-\(w\/2\)':y='\(H\*0\.750\)-\(h\/2\)'/);
});

test("non-proportional scale stretches each axis independently on export", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipTransform(p, v.id, { scaleX: 0.5, scaleY: 1 });
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /scale=960:1080/); // half width, full height
});

test("an image clip becomes a looped input composited via overlay", () => {
  let p = emptyProject(1, 0); // one video track, no audio
  const image: Media = {
    id: "img1",
    path: "logo.png",
    name: "logo.png",
    duration: 5,
    hasVideo: true,
    audioStreamCount: 0,
    isImage: true,
    width: 400,
    height: 200,
  };
  p = addMedia(p, image);
  p = placeMedia(p, "img1", 2); // sits at 2s..7s
  const args = compileExport(p, opts);
  const g = graphOf(args);
  // Looped, time-bounded input for the still.
  assert.ok(args.includes("-loop"));
  assert.equal(args[args.indexOf("-loop") + 1], "1");
  // Composited (overlay), not concatenated, and gated to its placement window.
  assert.doesNotMatch(g, /concat=n=/);
  assert.match(g, /overlay=eof_action=pass:.*enable='between\(t,2\.000,7\.000\)'/);
  // No audio in the graph or mapping.
  assert.equal(args.includes("[aout]"), false);
});

test("a still can be trimmed longer than its default duration", () => {
  let p = emptyProject(1, 0);
  p = addMedia(p, {
    id: "img1",
    path: "logo.png",
    name: "logo.png",
    duration: 5,
    hasVideo: true,
    audioStreamCount: 0,
    isImage: true,
    width: 400,
    height: 200,
  });
  p = placeMedia(p, "img1", 0);
  const clip = p.tracks[0].clips[0];
  p = setClipEdge(p, clip.id, "out", 30); // extend well past the 5s default
  assert.equal(clipEnd(p.tracks[0].clips[0]), 30);
});

test("an In/Out range trims the composed output and remaps", () => {
  const args = compileExport(loaded(), { ...opts, rangeStart: 10, rangeEnd: 25 });
  const g = graphOf(args);
  assert.match(g, /\[vout\]trim=start=10\.000:end=25\.000,setpts=PTS-STARTPTS\[voutR\]/);
  assert.match(g, /\[aout\]atrim=start=10\.000:end=25\.000/);
  assert.deepEqual(
    args.filter((_, i) => args[i - 1] === "-map"),
    ["[voutR]", "[aoutR]"],
  );
});

test("a muted audio track is excluded from the export", () => {
  let p = loaded(); // 2 audio tracks -> amix inputs=2
  const a0 = p.tracks.find((t) => t.kind === "audio")!;
  p = updateTrack(p, a0.id, { muted: true });
  const g = graphOf(compileExport(p, opts));
  assert.doesNotMatch(g, /amix=inputs=2/); // one track dropped
  assert.match(g, /alimiter/); // the remaining track still maps
});

test("soloing one audio track excludes the others", () => {
  let p = loaded();
  const audio = p.tracks.filter((t) => t.kind === "audio");
  p = updateTrack(p, audio[0].id, { solo: true });
  const g = graphOf(compileExport(p, opts));
  // Only the soloed track remains -> single-input limiter, no amix.
  assert.doesNotMatch(g, /amix=/);
});

test("a hidden video track is excluded from the composite", () => {
  let p = loaded();
  p = addVideoTrack(p); // top track
  p = addMedia(p, { ...media, id: "m2", path: "b.mp4" });
  p = placeMedia(p, "m2", 5); // goes on the top video track
  const top = p.tracks.filter((t) => t.kind === "video")[0];
  p = updateTrack(p, top.id, { hidden: true });
  const g = graphOf(compileExport(p, opts));
  // With the overlay track hidden, only the base track remains -> concat path.
  assert.match(g, /concat=n=/);
});

test("clip opacity forces the overlay path and scales alpha", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipOpacity(p, v.id, 0.5);
  const g = graphOf(compileExport(p, opts));
  assert.doesNotMatch(g, /concat=n=/); // single track but semi-transparent -> overlay
  assert.match(g, /colorchannelmixer=aa=0\.500/);
});

test("fades add video alpha fades and audio afades", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipFade(p, v.id, "in", 1);
  p = setClipFade(p, v.id, "out", 2);
  const a = p.tracks.find((t) => t.kind === "audio")!.clips[0];
  p = setClipFade(p, a.id, "in", 1.5);
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /fade=t=in:st=0\.000:d=1\.000:alpha=1/);
  assert.match(g, /fade=t=out:st=58\.000:d=2\.000:alpha=1/); // 60 - 2
  assert.match(g, /afade=t=in:st=0:d=1\.500/);
});

test("clip speed retimes video (setpts) and audio (atempo)", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 2); // whole group -> 2x
  const g = graphOf(compileExport(p, opts));
  // Single video track stays on the concat path but retimes its PTS.
  assert.match(g, /setpts=\(PTS-STARTPTS\)\/2\.000/);
  // Audio speed is applied with an atempo stage.
  assert.match(g, /atempo=2/);
});

test("a >2x speed decomposes into chained atempo stages", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 4); // 4x -> atempo=2,atempo=2
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /atempo=2\.0000,atempo=2\.0000/);
});

test("reverse adds reverse (video) and areverse (audio) filters", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipSpeed(p, v.id, 1, true);
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /trim=start=0\.000:end=60\.000,reverse,/);
  assert.match(g, /atrim=start=0\.000:end=60\.000,areverse,/);
});

test("a cross-dissolve forces the overlay path and cross-fades the incoming clip", () => {
  // One 60s clip split at 30 -> A[0..30], B[30..60], both with handles.
  let p = loaded();
  const vt0 = p.tracks.find((t) => t.kind === "video")!;
  p = splitAt(p, 30, groupMembers(p, vt0.clips[0].id));
  const A = p.tracks.find((t) => t.kind === "video")!.clips.find((c) => c.start === 0)!;
  p = setClipTransition(p, A.id, { kind: "dissolve", duration: 2 });
  const g = graphOf(compileExport(p, opts));
  // Not the concat path; the incoming clip fades in over the 2s overlap, and its
  // enable window starts 1s before the cut (borrowed head handle).
  assert.doesNotMatch(g, /concat=n=/);
  assert.match(g, /fade=t=in:st=29\.000:d=2\.000:alpha=1/);
  assert.match(g, /enable='between\(t,29\.000,/);
});

test("a blend mode forces the overlay path and masks the blend to the clip", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipBlend(p, v.id, "screen");
  const g = graphOf(compileExport(p, opts));
  assert.doesNotMatch(g, /concat=n=/); // single track but blended -> overlay
  assert.match(g, /blend=all_mode=screen/); // "add" maps to ffmpeg "addition"
  assert.match(g, /alphaextract/); // layer alpha extracted...
  assert.match(g, /alphamerge/); // ...and re-applied so only the clip region blends
});

test("the add blend maps to ffmpeg's addition mode", () => {
  let p = loaded();
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  p = setClipBlend(p, v.id, "add");
  const g = graphOf(compileExport(p, opts));
  assert.match(g, /blend=all_mode=addition/);
});

test("separate audio mode maps one output stream per track", () => {
  // loaded() has two audio tracks (A1, A2), each with a clip.
  const args = compileExport(loaded(), { ...opts, audioMode: "separate" });
  const g = graphOf(args);
  assert.doesNotMatch(g, /amix=/); // tracks kept apart, not summed
  // Two independent audio outputs, each mapped.
  const maps = args.filter((_, i) => args[i - 1] === "-map");
  assert.deepEqual(maps, ["[vout]", "[aout0]", "[aout1]"]);
});

test("mix audio mode (default) still sums to a single stream", () => {
  const args = compileExport(loaded(), opts);
  const maps = args.filter((_, i) => args[i - 1] === "-map");
  assert.deepEqual(maps, ["[vout]", "[aout]"]);
  assert.match(graphOf(args), /amix=inputs=2:duration=longest:normalize=0/);
});

test("a disabled clip is excluded from video and audio", () => {
  let p = loaded(); // video clip + 2 audio clips, all linked
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  const a0 = p.tracks.find((t) => t.kind === "audio")!.clips[0];
  // Disable the video clip and one audio clip.
  p = setClipsEnabled(p, [v.id, a0.id], false);
  const args = compileExport(p, opts);
  const g = graphOf(args);
  // No video clip -> the whole sequence is a black filler on the concat path.
  assert.doesNotMatch(g, /\[0:v\]trim/);
  // One audio clip dropped -> single stream (no amix).
  assert.doesNotMatch(g, /amix=/);
});

test("keyframed scale bakes into many fixed-transform overlay slices", () => {
  let p = loaded(); // 60s clip
  const v = p.tracks.find((t) => t.kind === "video")!.clips[0];
  // Trim to a short 2s clip so the sampling count is bounded and checkable.
  p = setClipEdge(p, v.id, "out", 2);
  const id = p.tracks.find((t) => t.kind === "video")!.clips[0].id;
  p = setKeyframe(p, id, "scaleX", 0, 1);
  p = setKeyframe(p, id, "scaleX", 2, 2); // grow to 2x over 2s
  p = setKeyframe(p, id, "scaleY", 0, 1);
  p = setKeyframe(p, id, "scaleY", 2, 2);
  const g = graphOf(compileExport(p, opts));
  assert.doesNotMatch(g, /concat=n=/); // animated -> overlay path
  // Many overlay slices (30fps × 2s ≈ 60), each an enable window, with varying scale.
  const overlays = g.match(/overlay=eof_action=pass/g) ?? [];
  assert.ok(overlays.length > 30, `expected many slices, got ${overlays.length}`);
  // A mid-animation slice should be scaled between 1x and 2x (e.g. ~1.5x → 2880×1620).
  assert.match(g, /scale=\d{4}:\d{4}/);
});

test("H.265 option switches the video codec", () => {
  const args = compileExport(loaded(), { ...opts, videoCodec: "h265", crf: 24 });
  assert.ok(args.includes("libx265"));
  assert.equal(args[args.indexOf("-crf") + 1], "24");
});
