/**
 * Export compiler: turns a timeline Project into the FFmpeg argument list that
 * renders it to a single file. Pure (a function of the project + options), so
 * the generated graph is unit-tested without spawning anything.
 *
 * Model → FFmpeg:
 *  - Video (single video track): a CONCAT of segments covering [0, total) — each
 *    clip trimmed from its source, black filler for gaps — scaled/padded to one
 *    canvas so concat's inputs match. Handles arbitrary order and gaps.
 *  - Audio (all audio tracks): every clip is trimmed, gained (per-clip volume),
 *    delayed to its start, then AMIX-summed (normalize=0 preserves levels) and
 *    limited to prevent clipping.
 */
import {
  timelineDuration,
  clipEnd,
  clipDuration,
  clipGain,
  isGainAnimated,
  clipOpacity,
  clipFadeIn,
  clipFadeOut,
  clipSpeed,
  clipReversed,
  clipBlend,
  clipEnabled,
  clipTransform,
  isIdentityTransform,
  isTrackAudible,
  resolveVideoSegments,
  clipSubSource,
  animatedTransform,
  animatedOpacity,
  segSlideOffsetX,
  clipEffects,
  resolvedEffects,
  clipHasEffectKeyframes,
  type Project,
  type Clip,
  type VideoSeg,
  type BlendMode,
} from "./project.ts";
import { ffmpegChainFor } from "./effects.ts";

export interface ExportOptions {
  outputFile: string;
  /** Canvas dimensions and frame rate. */
  width: number;
  height: number;
  fps: number;
  videoCodec?: "h264" | "h265";
  crf?: number;
  /** Optional export sub-range (In/Out); omitted = whole sequence. */
  rangeStart?: number;
  rangeEnd?: number;
  /**
   * "mix" (default): all audio tracks summed to one stereo stream.
   * "separate": each timeline audio track becomes its own output audio stream.
   */
  audioMode?: "mix" | "separate";
}

const EPS = 1e-4;

/** Our blend-mode names → ffmpeg `blend` filter all_mode values. */
const FF_BLEND: Record<Exclude<BlendMode, "normal">, string> = {
  add: "addition",
  screen: "screen",
  multiply: "multiply",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
};

function f3(n: number): string {
  return n.toFixed(3);
}

/** `reverse` filter prefix (empty when not reversed). */
function revV(clip: Clip): string {
  return clipReversed(clip) ? "reverse," : "";
}
function revA(clip: Clip): string {
  return clipReversed(clip) ? "areverse," : "";
}

/** Video setpts that both resets timestamps and applies a speed factor. */
function vsetpts(clip: Clip, extra = ""): string {
  const spd = clipSpeed(clip);
  const base = spd === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${f3(spd)}`;
  return `setpts=${base}${extra}`;
}

/**
 * atempo chain for an arbitrary speed factor. atempo only accepts 0.5–2.0 per
 * stage, so larger/smaller factors are decomposed into a product of in-range
 * steps. Returns "" for speed 1.
 */
function atempoChain(spd: number): string {
  if (spd === 1) return "";
  const steps: number[] = [];
  let r = spd;
  while (r > 2) {
    steps.push(2);
    r /= 2;
  }
  while (r < 0.5) {
    steps.push(0.5);
    r /= 0.5;
  }
  steps.push(r);
  return "," + steps.map((s) => `atempo=${s.toFixed(4)}`).join(",");
}

/** Piecewise-linear ffmpeg expression (in `t`, clip-local seconds) for a gain
 *  keyframe list: flat before the first / after the last, linear between. */
function gainExpr(kfs: { t: number; v: number }[]): string {
  const k = [...kfs].sort((a, b) => a.t - b.t);
  const n = (x: number) => x.toFixed(4);
  if (k.length === 1) return n(k[0].v);
  const seg = (i: number): string => {
    if (i >= k.length - 1) return n(k[k.length - 1].v);
    const a = k[i];
    const b = k[i + 1];
    const piece = `(${n(a.v)}+(${n(b.v)}-${n(a.v)})*(t-${n(a.t)})/${n(b.t - a.t)})`;
    return `if(lt(t,${n(b.t)}),${piece},${seg(i + 1)})`;
  };
  return `if(lt(t,${n(k[0].t)}),${n(k[0].v)},${seg(0)})`;
}

/** The `volume` filter for a clip — constant, or a per-frame automation expr. */
function volumeFilter(clip: Clip): string {
  if (!isGainAnimated(clip)) return `volume=${clipGain(clip)}`;
  return `volume=eval=frame:volume='${gainExpr(clip.gainKeyframes!)}'`;
}

export function compileExport(project: Project, opts: ExportOptions): string[] {
  const W = opts.width;
  const H = opts.height;
  const FPS = opts.fps;

  // Inputs: one -i per used non-image media, plus one looped -i per image CLIP
  // (so a still can appear more than once, each with its own placement/length).
  interface Input {
    path: string;
    pre: string[];
  }
  const inputs: Input[] = [];
  const inputIndex = new Map<string, number>(); // media id -> input index (non-image)
  const imageClipInput = new Map<string, number>(); // image clip id -> input index
  const isImageMedia = (id: string) => !!project.media.find((m) => m.id === id)?.isImage;

  const used = new Set<string>();
  for (const t of project.tracks) for (const c of t.clips) used.add(c.mediaId);
  for (const m of project.media) {
    if (!used.has(m.id) || m.isImage) continue; // images handled per-clip below
    inputIndex.set(m.id, inputs.length);
    inputs.push({ path: m.path, pre: [] });
  }

  const total = timelineDuration(project);
  // Hidden video tracks and muted/un-soloed audio tracks are excluded from render.
  const videoTracks = project.tracks.filter((t) => t.kind === "video" && !t.hidden);
  const audioTracks = project.tracks.filter(
    (t) => t.kind === "audio" && isTrackAudible(project, t),
  );

  // A looped image input spans the timeline; the overlay's `enable` gates when
  // it's visible and `trim` bounds the frames produced.
  for (const track of videoTracks) {
    for (const clip of track.clips) {
      if (!clipEnabled(clip) || !isImageMedia(clip.mediaId)) continue;
      const m = project.media.find((mm) => mm.id === clip.mediaId)!;
      imageClipInput.set(clip.id, inputs.length);
      // A still loops via -loop 1; an animated GIF loops its frames via
      // -ignore_loop 0 (keeping its own frame timing).
      const pre = m.isAnimated
        ? ["-ignore_loop", "0", "-t", f3(Math.max(total, EPS))]
        : ["-loop", "1", "-t", f3(Math.max(total, EPS)), "-framerate", String(FPS)];
      inputs.push({ path: m.path, pre });
    }
  }

  const chains: string[] = [];
  let segCount = 0;

  const blackSeg = (dur: number): string => {
    const label = `bv${segCount++}`;
    chains.push(
      `color=c=black:s=${W}x${H}:r=${FPS}:d=${f3(dur)},format=yuv420p,setsar=1[${label}]`,
    );
    return label;
  };
  const clipSeg = (clip: Clip): string => {
    const idx = inputIndex.get(clip.mediaId)!;
    const label = `cv${segCount++}`;
    const fx = ffmpegChainFor(clipEffects(clip));
    chains.push(
      `[${idx}:v]trim=start=${f3(clip.sourceIn)}:end=${f3(clip.sourceOut)},` +
        `${revV(clip)}${vsetpts(clip)},` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` +
        `${fx ? fx + "," : ""}` +
        `fps=${FPS},format=yuv420p,setsar=1[${label}]`,
    );
    return label;
  };

  // Overlay one resolved segment (time-shifted, scaled, positioned, rotated,
  // faded) onto an acc. The segment carries transition-expanded bounds/ramps.
  const overlaySeg = (acc: string, seg: VideoSeg): string => {
    const clip = seg.clip;
    const media = project.media.find((m) => m.id === clip.mediaId);
    const isImg = !!media?.isImage;
    const idx = isImg ? imageClipInput.get(clip.id)! : inputIndex.get(clip.mediaId)!;
    const tr = seg.fixedTransform ?? clipTransform(clip); // baked keyframe pose, else static
    const shifted = `cv${segCount++}`;
    const start = seg.start;
    const end = seg.end;
    // Fit the media to the canvas (aspect-preserved) at scale 1, then stretch
    // each axis by its scale factor. This matches the preview's geometry, so an
    // exact scale=sw:sh (no force_original_aspect_ratio) reproduces what's shown.
    const mw = media?.width || W;
    const mh = media?.height || H;
    const baseFit = Math.min(W / mw, H / mh);
    const sw = Math.max(2, Math.round(mw * baseFit * tr.scaleX));
    const sh = Math.max(2, Math.round(mh * baseFit * tr.scaleY));
    // Stills read from a looped input, so trim from 0 for the segment's length.
    const trimStart = isImg ? 0 : seg.sourceIn;
    const trimEnd = isImg ? end - start : seg.sourceOut;

    // Stills read from a looped input (no retime/reverse); real footage retimes.
    const parts = [
      `[${idx}:v]trim=start=${f3(trimStart)}:end=${f3(trimEnd)}`,
      isImg
        ? `setpts=PTS-STARTPTS+${f3(start)}/TB`
        : `${revV(clip)}${vsetpts(clip, `+${f3(start)}/TB`)}`,
      `scale=${sw}:${sh}`,
      `format=yuva420p`,
    ];
    // Colour/blur effects apply to the scaled RGBA before rotation & compositing.
    // A baked slice carries its effect params resolved at the slice's mid-time.
    const fx = ffmpegChainFor(seg.fixedEffects ?? clipEffects(clip));
    if (fx) parts.push(fx);
    if (Math.abs(tr.rotation) > 1e-6) {
      const a = ((tr.rotation * Math.PI) / 180).toFixed(6);
      parts.push(`rotate=${a}:c=none:ow=rotw(${a}):oh=roth(${a})`);
    }
    // Opacity: a baked keyframe slice carries a fixed alpha (fades folded in);
    // otherwise the static opacity plus animated fade filters below.
    const op = seg.fixedOpacity ?? clipOpacity(clip);
    if (op < 1) parts.push(`colorchannelmixer=aa=${op.toFixed(3)}`); // scale alpha
    if (seg.fixedOpacity === undefined) {
      // Manual fades combined with any transition ramp (dissolve/dip).
      const fi = Math.max(clipFadeIn(clip), seg.xIn);
      const fo = Math.max(clipFadeOut(clip), seg.xOut);
      if (fi > 0) parts.push(`fade=t=in:st=${f3(start)}:d=${f3(fi)}:alpha=1`);
      if (fo > 0) parts.push(`fade=t=out:st=${f3(end - fo)}:d=${f3(fo)}:alpha=1`);
    }
    parts.push(`fps=${FPS}`, `setsar=1`);
    chains.push(`${parts.join(",")}[${shifted}]`);

    // Place the clip's centre at (x*W, y*H).
    const xExpr = `(W*${f3(tr.x)})-(w/2)`;
    const yExpr = `(H*${f3(tr.y)})-(h/2)`;
    const enable = `enable='between(t,${f3(start)},${f3(end)})'`;
    const blend = clipBlend(clip);
    if (blend === "normal") {
      const out = `ov${segCount++}`;
      chains.push(
        `[${acc}][${shifted}]overlay=eof_action=pass:x='${xExpr}':y='${yExpr}':${enable}[${out}]`,
      );
      return out;
    }
    // Blended clip: position it on a full transparent canvas, blend that layer
    // with the accumulator full-frame, then re-apply the layer's alpha so the
    // blend only affects the clip's region and time window (correct for every
    // mode, including multiply/darken where black is not identity).
    const ff = FF_BLEND[blend];
    const cbase = `bb${segCount++}`;
    const layer = `bl${segCount++}`;
    const layerA = `blA${segCount++}`;
    const layerB = `blB${segCount++}`;
    const mask = `bm${segCount++}`;
    const lrgb = `br${segCount++}`;
    const accA = `ba${segCount++}`;
    const accB = `bc${segCount++}`;
    const mixed = `bx${segCount++}`;
    const masked = `bk${segCount++}`;
    const out = `ov${segCount++}`;
    chains.push(
      `color=c=black@0:s=${W}x${H}:r=${FPS}:d=${f3(total)},format=yuva420p,setsar=1[${cbase}]`,
    );
    chains.push(
      `[${cbase}][${shifted}]overlay=eof_action=pass:x='${xExpr}':y='${yExpr}':${enable}[${layer}]`,
    );
    chains.push(`[${layer}]split[${layerA}][${layerB}]`);
    chains.push(`[${layerA}]alphaextract[${mask}]`);
    chains.push(`[${layerB}]format=yuv420p[${lrgb}]`);
    chains.push(`[${acc}]split[${accA}][${accB}]`);
    chains.push(`[${accB}][${lrgb}]blend=all_mode=${ff}[${mixed}]`);
    chains.push(`[${mixed}][${mask}]alphamerge[${masked}]`);
    chains.push(`[${accA}][${masked}]overlay=eof_action=pass[${out}]`);
    return out;
  };

  // Keyframe baking: expand an animated clip's segment into short fixed-transform
  // slices, reusing the proven static-overlay path (each slice = one overlay).
  const MAX_SAMPLES = 600;
  const expandKeyframes = (seg: VideoSeg): VideoSeg[] => {
    const clip = seg.clip;
    const animated =
      (clip.keyframes && Object.keys(clip.keyframes).length > 0) ||
      clipHasEffectKeyframes(clip) ||
      !!seg.slideKind; // push/slide bake their x-offset per slice
    if (!animated) return [seg];
    const dur = seg.end - seg.start;
    if (dur <= 0) return [seg];
    const rate = Math.min(FPS, 30);
    const n = Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(dur * rate)));
    const step = dur / n;
    const isImg = !!project.media.find((m) => m.id === clip.mediaId)?.isImage;
    const out: VideoSeg[] = [];
    for (let i = 0; i < n; i++) {
      const a = seg.start + i * step;
      const b = i === n - 1 ? seg.end : a + step;
      const mid = (a + b) / 2;
      const localT = mid - clip.start;
      // Fold the segment's fade/transition ramp into a fixed per-slice opacity.
      const fi = Math.max(clipFadeIn(clip), seg.xIn);
      const fo = Math.max(clipFadeOut(clip), seg.xOut);
      let fade = 1;
      const local = mid - seg.start;
      if (fi > 0 && local < fi) fade *= Math.max(0, local / fi);
      const tail = dur - local;
      if (fo > 0 && tail < fo) fade *= Math.max(0, tail / fo);
      const src = isImg ? { sourceIn: 0, sourceOut: 0 } : clipSubSource(clip, a, b);
      const tr = animatedTransform(clip, localT);
      const slide = segSlideOffsetX(seg, mid);
      out.push({
        ...seg,
        start: a,
        end: b,
        sourceIn: src.sourceIn,
        sourceOut: src.sourceOut,
        xIn: 0,
        xOut: 0,
        slideKind: undefined, // offset already baked into fixedTransform below
        fixedTransform: slide === 0 ? tr : { ...tr, x: tr.x + slide },
        fixedOpacity: animatedOpacity(clip, localT) * fade,
        fixedEffects: clipHasEffectKeyframes(clip) ? resolvedEffects(clip, localT) : undefined,
      });
    }
    return out;
  };

  const tracksWithClips = videoTracks.filter((t) => t.clips.length > 0);
  const anyTransform = videoTracks.some((t) =>
    t.clips.some((c) => !isIdentityTransform(clipTransform(c))),
  );
  const anyImage = videoTracks.some((t) => t.clips.some((c) => isImageMedia(c.mediaId)));
  const anyOpacity = videoTracks.some((t) => t.clips.some((c) => clipOpacity(c) < 1));
  const anyFade = videoTracks.some((t) =>
    t.clips.some((c) => clipFadeIn(c) > 0 || clipFadeOut(c) > 0),
  );
  const anyTransition = videoTracks.some((t) =>
    t.clips.some((c) => c.transitionOut && c.transitionOut.duration > 0),
  );
  const anyBlend = videoTracks.some((t) => t.clips.some((c) => clipBlend(c) !== "normal"));
  const anyKeyframe = videoTracks.some((t) =>
    t.clips.some((c) => c.keyframes && Object.keys(c.keyframes).length > 0),
  );
  const anyEffectKeyframe = videoTracks.some((t) => t.clips.some((c) => clipHasEffectKeyframes(c)));
  const mediaDurOf = (mediaId: string): number => {
    const m = project.media.find((mm) => mm.id === mediaId);
    return m ? (m.isImage || m.isText ? Infinity : m.duration) : Infinity;
  };
  if (
    tracksWithClips.length <= 1 &&
    !anyTransform &&
    !anyImage &&
    !anyOpacity &&
    !anyFade &&
    !anyTransition &&
    !anyBlend &&
    !anyKeyframe &&
    !anyEffectKeyframe
  ) {
    // Single video track: CONCAT clips + black gaps (simple and exact).
    const clips = [...(tracksWithClips[0]?.clips ?? [])]
      .filter(clipEnabled)
      .sort((a, b) => a.start - b.start);
    const vsegs: string[] = [];
    let cursor = 0;
    for (const clip of clips) {
      if (clip.start > cursor + EPS) vsegs.push(blackSeg(clip.start - cursor));
      vsegs.push(clipSeg(clip));
      cursor = clipEnd(clip);
    }
    if (vsegs.length === 0) {
      vsegs.push(blackSeg(Math.max(total, EPS)));
    } else if (total - cursor > EPS) {
      vsegs.push(blackSeg(total - cursor));
    }
    chains.push(
      `${vsegs.map((l) => `[${l}]`).join("")}concat=n=${vsegs.length}:v=1:a=0[vout]`,
    );
  } else {
    // Multiple video tracks: COMPOSITE with overlay, base layer first.
    // Video tracks are stored top-first, so render them in reverse (bottom/base
    // first) and overlay upward, leaving the top track drawn last (on top).
    chains.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${f3(total)},format=yuv420p,setsar=1[base]`);
    let acc = "base";
    for (const track of [...videoTracks].reverse()) {
      const segs = resolveVideoSegments(track, mediaDurOf).sort((a, b) => a.start - b.start);
      for (const seg of segs) for (const sub of expandKeyframes(seg)) acc = overlaySeg(acc, sub);
    }
    chains.push(`[${acc}]null[vout]`);
  }

  // Audio: trim + gain + fade + delay each clip, mix the clips WITHIN each track,
  // then either sum all tracks to one stream ("mix") or keep one stream per track.
  const clipChain = (clip: Clip, label: string): void => {
    const idx = inputIndex.get(clip.mediaId)!;
    const stream = clip.audioStream ?? 0;
    const delayMs = Math.round(clip.start * 1000);
    const dur = clipDuration(clip);
    const fi = clipFadeIn(clip);
    const fo = clipFadeOut(clip);
    // afade times are in the post-retime (timeline) domain, matching `dur`.
    const afade =
      (fi > 0 ? `,afade=t=in:st=0:d=${f3(fi)}` : "") +
      (fo > 0 ? `,afade=t=out:st=${f3(dur - fo)}:d=${f3(fo)}` : "");
    chains.push(
      `[${idx}:a:${stream}]atrim=start=${f3(clip.sourceIn)}:end=${f3(clip.sourceOut)},` +
        `${revA(clip)}asetpts=PTS-STARTPTS${atempoChain(clipSpeed(clip))},` +
        `${volumeFilter(clip)}${afade},` +
        `aresample=48000,aformat=channel_layouts=stereo,` +
        `adelay=${delayMs}:all=1[${label}]`,
    );
  };

  let aClipCount = 0;
  const trackLabels: string[] = []; // one mixed label per audible track with clips
  for (const track of audioTracks) {
    const clipLabels: string[] = [];
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      if (clip.audioStream === undefined || !clipEnabled(clip)) continue;
      if (inputIndex.get(clip.mediaId) === undefined) continue;
      const label = `a${aClipCount++}`;
      clipChain(clip, label);
      clipLabels.push(label);
    }
    if (clipLabels.length === 0) continue;
    if (clipLabels.length === 1) {
      trackLabels.push(clipLabels[0]);
    } else {
      const tl = `atk${trackLabels.length}`;
      chains.push(
        `${clipLabels.map((l) => `[${l}]`).join("")}` +
          `amix=inputs=${clipLabels.length}:duration=longest:normalize=0[${tl}]`,
      );
      trackLabels.push(tl);
    }
  }

  const hasAudio = trackLabels.length > 0;
  const separate = opts.audioMode === "separate" && trackLabels.length > 1;
  const aOuts: string[] = [];
  if (separate) {
    // Each track limited independently and mapped as its own output stream.
    trackLabels.forEach((tl, i) => {
      chains.push(`[${tl}]alimiter=limit=0.95[aout${i}]`);
      aOuts.push(`aout${i}`);
    });
  } else if (trackLabels.length === 1) {
    chains.push(`[${trackLabels[0]}]alimiter=limit=0.95[aout]`);
    aOuts.push("aout");
  } else if (trackLabels.length > 1) {
    chains.push(
      `${trackLabels.map((l) => `[${l}]`).join("")}` +
        `amix=inputs=${trackLabels.length}:duration=longest:normalize=0,` +
        `alimiter=limit=0.95[aout]`,
    );
    aOuts.push("aout");
  }

  // Optional In/Out export range: trim the composed output(s) and reset timestamps.
  let vLabel = "vout";
  let aLabelsOut = [...aOuts];
  if (
    opts.rangeStart !== undefined &&
    opts.rangeEnd !== undefined &&
    opts.rangeEnd > opts.rangeStart
  ) {
    const rs = f3(opts.rangeStart);
    const re = f3(opts.rangeEnd);
    chains.push(`[vout]trim=start=${rs}:end=${re},setpts=PTS-STARTPTS[voutR]`);
    vLabel = "voutR";
    aLabelsOut = aOuts.map((a) => {
      const r = `${a}R`;
      chains.push(`[${a}]atrim=start=${rs}:end=${re},asetpts=PTS-STARTPTS[${r}]`);
      return r;
    });
  }

  const args: string[] = [];
  for (const inp of inputs) args.push(...inp.pre, "-i", inp.path);
  args.push("-filter_complex", chains.join(";"));
  args.push("-map", `[${vLabel}]`);
  for (const a of aLabelsOut) args.push("-map", `[${a}]`);

  const crf = String(opts.crf ?? 20);
  if (opts.videoCodec === "h265") {
    args.push("-c:v", "libx265", "-preset", "medium", "-crf", crf, "-tag:v", "hvc1");
  } else {
    args.push("-c:v", "libx264", "-preset", "medium", "-crf", crf, "-pix_fmt", "yuv420p");
  }
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000");
  args.push("-r", String(FPS), "-y", opts.outputFile);
  return args;
}
