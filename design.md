# Cutline — Design Specification (for the C++ rewrite)

> **Audience:** the team/agent rebuilding Cutline as a native C++ application.
> **Purpose:** a complete, implementation-independent description of what Cutline
> is, how it behaves, the exact data model and algorithms, and the lessons that
> motivate the rewrite. You should be able to rebuild the product from this
> document without reading the TypeScript source. Where a behavior is subtle or
> only approximate, it is called out explicitly.
>
> Companion docs: `summary.md` (current status / handoff) and the effect/export
> source in `src/core/` (the authoritative, unit-tested reference for exact
> string outputs). This spec restates the important parts.

---

## 1. What Cutline is

Cutline is a **Premiere-style non-linear video editor (NLE)** for desktop. A user
imports video/audio/image media, arranges **clips** on a multi-track **timeline**,
applies **transforms, effects, transitions, keyframe animation, and audio
processing**, previews the result in real time in a **program monitor**, and
**exports** to an MP4 (H.264/H.265).

Primary real-world use so far: editing long gameplay screen-recordings (e.g. a
10-minute 4K `.mkv`) down into shorter clips/montages with effects and audio
cleanup. Design for **large 4K sources, long timelines, and MKV/long-GOP inputs.**

The current implementation is a Tauri app (Rust shell + web/TypeScript UI +
bundled ffmpeg). The rewrite targets **native C++** for performance (see §3).

### Product principles (keep these)
1. **The data model is the backbone.** Every subsystem (UI, preview, export) is a
   pure function of an immutable-ish project model. Editing ops take a project and
   return a new project; they never mutate in place. This made the TS version
   testable and predictable — preserve it.
2. **Preview and export must match by construction.** Each effect/behavior is
   defined once and rendered two ways (interactive preview + export encoder) from
   the same parameters. Never let them drift.
3. **Correctness and honesty over cleverness.** Where two renderers can't be
   pixel-identical (color math, chroma key, vignette), that's documented, not
   hidden.
4. **No emojis in UI.** Text / vector icons / Unicode geometric glyphs only.

---

## 2. Glossary

- **Project** — the whole editing session: canvas size/fps, media pool, tracks.
- **Media** — a source asset (video/audio file, image, or a *generated* source:
  text title, color matte, adjustment layer).
- **Track** — an ordered lane of clips; `video` or `audio`. Video tracks stack
  top-over-bottom for compositing; audio tracks are summed.
- **Clip** — a placement of a media on a track over a time span, with in/out
  points, transform, effects, etc.
- **Timeline time** — seconds along the sequence (the playhead lives here).
- **Source time** — seconds within a media's own footage.
- **Canvas** — the output raster (e.g. 1920×1080). Transforms are expressed in
  *canvas fractions*, so they're resolution-independent.
- **Segment** — a clip resolved for rendering (transitions expanded into overlaps;
  keyframes optionally baked into fixed slices). Derived, never stored.

---

## 3. Why the rewrite — constraints of the current stack

The current app is functional and pleasant to iterate on, but hit a hard wall:

- **Frame-accurate export is unusably slow.** Rendering exact frames requires
  seeking the source to each output time. In a browser `<video>` element this
  re-decodes from the nearest keyframe on *every* seek. For a 4K long-GOP **MKV**,
  that measured **~4.5 s per frame → ~18 minutes for an 8-second clip.** Browsers
  optimize for smooth playback, not deterministic random-access decode.
- **No direct frame access / GPU compositing.** Compositing is 2D canvas on the
  CPU; per-pixel work (chroma key, scopes) is JS. Fine for preview at reduced res,
  not for fast full-res rendering.
- **IPC + command-line limits.** Frames crossed a JS↔Rust bridge; the ffmpeg
  filter graph outgrew the OS command-line length limit (worked around with a
  filter-script file, but symptomatic).

**What the rewrite should buy you (design goals):**
- **Native decode** via libav*/FFmpeg libraries (or GPU decode) with **sequential
  decode** for export — no per-frame seeking. This alone fixes the headline
  problem.
- **GPU compositing** (e.g. a shader pipeline / a lib like Skia, or D3D/Vulkan/
  Metal) for real-time 4K preview and fast full-res export.
- **Frame-exact export == preview** with no browser in the loop, retiring the
  "approximate parity" caveats.
- Direct file I/O, threading, and no command-line marshalling limits.

**Two viable export architectures in C++ (pick per effect):**
1. **Own compositor → encoder.** Decode → composite on GPU/CPU → feed frames to
   the encoder (libavcodec, or NVENC/AMF/QSV). This is the "frame-accurate"
   path done right; it's fast when decode is sequential. Enables *any* effect.
2. **Describe-to-FFmpeg** for effects FFmpeg can do natively (color ops, crop,
   vignette, chroma key, blur). Cheapest to implement; already proven here.
   Keep this for the effects that map cleanly.

The current TS app already leans on (2) for speed. The rewrite should make (1)
first-class so canvas-only effects (masks, arbitrary compositing) are also fast.

**Keep from the current design:** the pure model, the two-emitter effect registry
concept, the segment-resolution algorithm, the export graph structure (as a
reference for the describe-to-FFmpeg path), and the exact effect parameter
semantics below.

---

## 4. Coordinate systems, time, and units

- **Canvas fractions.** A clip's position `x,y` are fractions of canvas width/
  height; **`(0.5, 0.5)` is centered.** Scale `scaleX,scaleY` are multipliers
  where **1.0 = "fit media to canvas, aspect-preserved"** (a clip at scale 1 fills
  the canvas as much as it can without distortion). Rotation is **degrees**,
  clockwise. This keeps transforms independent of export resolution.
- **Natural size.** A media's natural draw size at scale 1 is
  `min(canvasW/mediaW, canvasH/mediaH)` applied to `mediaW×mediaH` (aspect-fit).
  Text uses its laid-out pixel size.
- **Timeline vs source time.** For a clip with `start`, `sourceIn`, `sourceOut`,
  `speed` (>0), `reverse`:
  - `sourceSpan = sourceOut - sourceIn`
  - `clipDuration = sourceSpan / speed` (timeline seconds)
  - `clipEnd = start + clipDuration`
  - `sourceTimeAt(t)` (t in timeline secs, within clip):
    `lt = (t - start) * speed`; `reverse ? sourceOut - lt : sourceIn + lt`.
  - Sub-ranges (for splitting/trimming a retimed/reversed clip) map linearly with
    the same formulas; keep them reverse-aware.
- **Frame snapping.** The playhead snaps to frame boundaries at the project fps.
- **Time formatting.** Timecode `HH:MM:SS.CS` (centiseconds) at project fps.

---

## 5. Data model (authoritative)

All fields optional-with-defaults unless noted. Treat the model as
value types; editing returns a new project (structural sharing is an
optimization, not required).

### Project
```
Project {
  canvasW: int = 1920
  canvasH: int = 1080
  fps: number = 30                 // project/sequence frame rate
  media: Media[]
  tracks: Track[]                  // video tracks first (top), then audio
  markers?: number[]               // timeline seconds
}
```

### Media
```
Media {
  id: string
  path: string                     // absolute file path (empty for generated)
  name: string
  duration: number                 // source seconds (image: default placement len)
  hasVideo: bool
  audioStreamCount: int            // number of audio streams in the source
  width?, height?, fps?            // for picking export canvas / natural size
  // Stills / generated sources:
  isImage?: bool                   // PNG/JPG/GIF (looped on export)
  isAnimated?: bool                // GIF: animates instead of holding a frame
  isText?: bool;  text?: TextSpec  // generated title
  isColor?: bool; color?: string;  gradient?: { color2: string, angle: number }
  isAdjustment?: bool              // adjustment layer (no pixels of its own)
}
```
- **Generated media** (text/color/adjustment) have no file, no audio, infinite
  handles (behave like stills).
- **Still-like** = image | text | color | adjustment.

### TextSpec
```
TextSpec {
  content: string
  fontSize: number                 // canvas px
  color: string; fontFamily: string
  bold: bool; italic: bool
  align: "left"|"center"|"right"
  background: string | null        // solid box behind text, or none
  strokeColor?: string | null; strokeWidth?: number   // outline (canvas px)
  shadow?: bool                    // drop shadow
}
```

### Track
```
Track {
  id: string
  kind: "video" | "audio"
  label?: string
  clips: Clip[]
  hidden?: bool                    // video: excluded from render (the "eye")
  muted?: bool; solo?: bool        // audio: audibility (see rule below)
  locked?: bool                    // UI: not editable
}
```
- **Audibility:** a track is audible if not `muted` AND (no track is `solo` OR
  this track is `solo`).

### Clip
```
Clip {
  id: string
  mediaId: string
  kind: "video" | "audio"
  audioStream?: int                // which source audio stream (N in 0:a:N)
  sourceIn: number; sourceOut: number   // source seconds
  start: number                    // timeline seconds
  groupId: string | null           // linked clips move/cut together (A/V link)
  gain?: number = 1                // linear audio gain
  gainKeyframes?: Keyframe[]       // volume automation (overrides gain)
  opacity?: number = 1
  fadeIn?, fadeOut?: number         // seconds (alpha for video, gain for audio)
  transform?: Transform            // video only
  speed?: number = 1               // playback rate (pitch-preserved audio)
  reverse?: bool = false
  transitionOut?: { kind: TransitionKind, duration: number }  // at out-edge
  blend?: BlendMode = "normal"
  disabled?: bool                  // kept in place but not rendered
  keyframes?: { [AnimProp]: Keyframe[] }     // transform + opacity animation
  effects?: ClipEffect[]           // ordered visual effect stack
  audioEffects?: AudioClipEffect[] // ordered audio filter stack
}

Transform { x=0.5, y=0.5, scaleX=1, scaleY=1, rotation=0 }
AnimProp  = "x"|"y"|"scaleX"|"scaleY"|"rotation"|"opacity"
BlendMode = "normal"|"add"|"screen"|"multiply"|"overlay"|"darken"|"lighten"|"difference"
TransitionKind = "dissolve"|"dip-black"|"push"|"slide"
```

### Keyframe & interpolation
```
Keyframe { t: number, v: number, e?: "linear"|"hold"|"ease" }
```
- `t` = clip-local seconds; `v` = value. `e` is the **outgoing** interpolation
  toward the next keyframe (default linear).
- **Evaluation** `evalKeyframes(kfs, localT)`: clamp to first/last outside the
  range; within `[a,b]` compute `f = (localT-a.t)/(b.t-a.t)` then apply the
  *from-keyframe's* mode:
  - `linear`: value = `a.v + (b.v-a.v)*f`
  - `hold`: value = `a.v` (step; jumps at `b.t`)
  - `ease`: smoothstep `f' = f*f*(3-2f)`, value = `a.v + (b.v-a.v)*f'`
- Editing a keyframe preserves its `e`; a newly added keyframe inherits the
  property's current mode (first keyframe's `e`).
- Keyframes apply to: transform props, opacity, **effect params**, and
  **gain** (audio). (Gain easing is modeled but the current audio scheduler
  ramps linearly between breakpoints — see §10.)

### ClipEffect / AudioClipEffect
```
ClipEffect      { type: string, enabled?: bool=true, params: {k:number},
                  colors?: {k:string}, keyframes?: {paramKey: Keyframe[]} }
AudioClipEffect { type: string, enabled?: bool=true, params: {k:number} }
```
`type` keys into the effect registries (§9, §10).

---

## 6. Editing operations (model layer)

All are pure `(project, args) -> project`. The C++ version should expose the same
capabilities (names are indicative). Undo/redo is a stack of project snapshots.

- **Placement:** `placeMedia` (auto-creates audio lanes per stream, avoiding
  overlap — see note), `insertMediaAt` (ripple), `overwriteMediaAt`.
- **Move/trim:** move clips (with layer/track change), trim edges, `rateStretchEdge`
  (drag edge changes speed), `slipClip` (shift source under a fixed window),
  `slideClip` (move between neighbors).
- **Cut:** `splitAt` (razor; splits linked group together, reverse/speed-aware
  source mapping), `rippleDelete`, `removeClips`.
- **Grouping/linking:** `linkClips`/`unlinkClips` (shared `groupId`);
  `groupMembers`.
- **Properties:** set transform/opacity/fades/gain/speed(+reverse)/blend/
  transition/enabled.
- **Effects:** add/remove/toggle/move/clear, set param, copy/paste stack; colour
  params; effect keyframes (set/remove/clear + interp mode). Same set for audio
  effects.
- **Keyframes:** set/remove/clear per prop; set interp mode per prop; gain
  keyframes (rubber-band) with add/move/remove.
- **Tracks:** add video/audio track, set label, mute/solo/hidden/lock, remove.
- **Markers:** add/remove/clear/nearest/next/prev.

**Audio-lane placement rule (important, was a bug):** when a video with N audio
streams is dropped, each stream goes to a **distinct audio lane with no time
overlap**; if no existing lane is free at that time, create a new lane at the
bottom. Do not pile multiple streams/instances onto the same lane region.

---

## 7. Segment resolution (transitions → renderable segments)

Both preview and export derive **segments** from a track's clips. Pure function
`resolveVideoSegments(track, mediaDurationOf) -> VideoSeg[]`:

```
VideoSeg {
  clip; start; end; sourceIn; sourceOut
  xIn; xOut          // dissolve/dip alpha ramps (seconds)
  toBlack            // dip-to-black uses opaque fades (no cross-fade partner)
  slideKind?; slideRole?("in"|"out"); slideWin?{start,end}  // push/slide geometry
  // export keyframe baking (see §12):
  fixedTransform?; fixedOpacity?; fixedEffects?
}
```

Algorithm:
1. One segment per enabled clip, `start=clip.start`, `end=clipEnd`.
2. For each clip with `transitionOut` (duration d>0) that **abuts** the next clip
   (`|next.start - clipEnd| < 1e-3`):
   - `half = d/2`.
   - **dip-black:** A fades to black over `[T-half,T]` (`xOut=half`,`toBlack`),
     B fades in from black over `[T,T+half]` (`xIn=half`,`toBlack`). No overlap.
   - **dissolve/push/slide:** borrow up to `half` of each side's *source handles*
     (unused source beyond in/out) to create a real overlap. Extend A's tail and
     B's head (reverse/speed-aware source adjustment). Then:
     - **dissolve:** B cross-fades in over the overlap (`xIn = overlap`).
     - **push:** B slides in from the right AND A slides out to the left over the
       window. **slide:** only B slides in over A.
3. Geometric offset for push/slide at time `t`: fraction of canvas width,
   `segSlideOffsetX`: role "in" → `(1-p)*+1` (off-right→centered); role "out" →
   `p*-1` (centered→off-left), where `p = clamp((t-win.start)/(win.end-win.start))`.

Handles come from `mediaDuration - sourceOut` (tail) and `sourceIn` (head),
divided by speed, swapped under reverse.

**Rationale / decision:** transitions are done **geometrically + via handle
borrowing, NOT via ffmpeg `xfade`.** `xfade` was fragile against the compositor/
overlap model. Push/slide bake to per-slice transforms on export (§12). Keep this
approach; it's robust.

---

## 8. The compositor (preview render model)

The program monitor composites every visual clip active at the playhead. Render a
clean frame at canvas resolution as follows (this is also the model your C++
compositor should implement for the "own compositor" export path):

**Per frame, at timeline time `t`:**
1. Fill canvas black.
2. Gather active segments across **video tracks bottom-to-top** (tracks are stored
   top-first; render reversed so the top track draws last / on top). Within a
   track, draw earlier-`start` segments first (so a dissolve's incoming clip lands
   over the outgoing).
3. For each segment, dispatch by media type:
   - **video:** get the source frame at `sourceTimeAt(clip,t)`.
   - **image/GIF:** still or animated frame (GIF timed off the playhead).
   - **text / color matte / adjustment:** generated (see §14).
4. **Per-clip draw pipeline (order matters):**
   a. Resolve effect params at local time (fold in effect keyframes).
   b. **Chroma key** (if present): key the source to alpha on an offscreen buffer.
   c. **CSS-filter effects** (brightness/contrast/etc.): apply at device
      resolution (see gotcha below).
   d. Compute geometry: center = `(x + slideDx) * canvas`, size = natural×scale,
      rotation.
   e. Set **globalAlpha** = opacity × fade × transition ramp; set **blend mode**.
   f. **Flip** via axis scale (±1); **Crop** by drawing only the kept
      sub-rectangle; else draw full.
   g. **Vignette** overlay (radial gradient darkening) if present.
5. Selection handles/guides are UI overlays drawn only when not exporting.

**Opacity/fade/transition alpha** (`visualAlpha`): `opacity(t)` ×
fade-in/out multiplier (over `max(fadeIn, xIn)` / `max(fadeOut, xOut)`),
combined with dissolve/dip ramps.

**HiDPI gotcha (important):** applying a filter while the canvas has a
device-pixel-ratio scale rasterizes the filter at CSS resolution then upscales →
soft. The TS fix renders filtered content on an identity-transform offscreen at
**device resolution**, then blits unfiltered. In C++ with a proper render target
this is a non-issue if you render effects at full target resolution.

**Playback resolution (perf).** During playback the preview may render at ½ or ¼
resolution (Premiere-style "playback resolution: Full/½/¼"), full when paused. In
C++ this is optional but nice for very heavy timelines.

---

## 9. Visual effects registry (exact semantics)

**Design:** one registry, each effect defines parameters once plus two emitters —
a **preview renderer** and an **FFmpeg fragment** — from the same params, so
preview and export agree. Params are keyframeable (numeric). "Neutral" params emit
nothing. Effects are an ordered stack (order = apply order).

For the C++ rewrite: keep this two-emitter concept, but the "preview renderer"
becomes your GPU/CPU compositor op, and the "FFmpeg fragment" is for the
describe-to-FFmpeg export path (and as an exact spec of intended math).

Below, `p.x` are param values; ranges are `[min,max] default`. **FFmpeg fragment**
is the authoritative intended behavior.

| Effect | Params | Neutral | FFmpeg fragment | Preview |
|---|---|---|---|---|
| **Brightness** | amount [-100,100] 0 | 0 | `eq=brightness=${amount/100}` (3dp) | CSS `brightness(1+amount/100)` |
| **Contrast** | amount [0,300] 100 (%) | 100 | `eq=contrast=${amount/100}` | `contrast(amount/100)` |
| **Saturation** | amount [0,300] 100 | 100 | `eq=saturation=${amount/100}` | `saturate(amount/100)` |
| **Hue** | angle [-180,180] 0 | 0 | `hue=h=${angle}` (1dp) | `hue-rotate(${angle}deg)` |
| **Gaussian Blur** | amount [0,50] 0 px | 0 | `gblur=sigma=${amount}` (2dp) | `blur(${amount}px)` |
| **Black & White** | amount [0,100] 100 | 0 | `hue=s=${1-amount/100}` | `grayscale(amount/100)` |
| **Invert** (toggle) | on {0,1} 1 | 0 | `negate` | `invert(1)` (ctx filter) |
| **Flip** (toggles) | horizontal 1, vertical 0 | both 0 | `hflip` and/or `vflip` (comma) | axis scale ±1 |
| **Chroma Key** | similarity [1,100] 30 %, blend [0,100] 10 %; color `#00d000` | always on | `chromakey=0xRRGGBB:${sim/100}:${blend/100}` (3dp) | per-pixel keyer (below) |
| **Vignette** | amount [0,100] 40 % | 0 | `vignette=a=${(amount/100)*(π/2)}` (4dp) | radial-gradient darken |
| **Crop** | left/top/right/bottom [0,45] 0 % | all 0 | crop+pad (below) | kept sub-rectangle |

**Crop FFmpeg fragment** (l,t,r,b are fractions; RW=1−l−r, RH=1−t−b):
```
crop=iw*RW:ih*RH:iw*l:ih*t,pad=iw/RW:ih/RH:iw*l/RW:ih*t/RH:color=black@0.0
```
Cuts edges, keeps frame size, cropped area transparent (needs an alpha-carrying
format; on a single non-alpha track it becomes black bars). Preview draws the
source sub-rect `[l·w, t·h, RW·w, RH·h]` into the box sub-region
`[l·boxW, t·boxH, RW·boxW, RH·boxH]`.

**Chroma keyer (preview approximation of ffmpeg chromakey):** per-pixel, on an
offscreen buffer sized to the on-screen box (capped ~2560px wide for CPU JS; a
GPU shader has no such cap). BT.601 U/V distance:
```
U = -0.169R -0.331G +0.5B ;  V = 0.5R -0.419G -0.081B
d = hypot(U-Uk, V-Vk) / 255
alpha = 0 if d<=similarity ; 1 if d>=similarity+blend ; else (d-similarity)/blend
```
Not pixel-identical to ffmpeg; acceptable and documented.

**Adjustment-layer effects:** a subset can be **time-gated** onto the composite
below (color/blur only — brightness, contrast, saturation, hue, blur, grayscale).
Export emits each as `${fragment}:enable='between(t,start,end)'`.

**Composite chains:** preview CSS filters are space-joined into one `ctx.filter`;
ffmpeg fragments are comma-joined into the clip's filter chain. Neutral → omitted.

**Parity caveats to preserve/communicate:** color math (eq/hue vs CSS), chroma,
and vignette are close but not pixel-identical between preview and export. Gaussian
blur radius is resolution-dependent.

---

## 10. Audio system

**Playback model (real-time):** all video plays muted; audio is decoded per
(media, stream) and, on play, **every clip from the playhead onward** is scheduled
as `source → gain → [effect chain] → master`, summed. The audio clock is the
master timeline clock while playing (better A/V sync than a wall clock). Provide:
per-clip gain, fade in/out, volume automation (gain keyframes), master volume, a
peak/VU meter, track mute/solo.

**Reverse & speed:** baked into the played buffer. Speed uses a **pitch-preserving
time-stretch** (WSOLA-style overlap-add) so slow/fast clips keep pitch, matching
the export's `atempo`. Reverse plays a reversed buffer.

**Gain envelope scheduling:** combine automation × fade, sampled at breakpoints
(keyframes + fade edges) with linear ramps between. NOTE: this ramps **linearly**
between breakpoints even if a gain keyframe is marked `ease`/`hold` — to honor
easing on audio you must sub-sample eased segments (a known follow-up).

### Audio effects registry (exact)
Same two-emitter idea: a **Web Audio node** (preview) and an **FFmpeg fragment**
(export). The biquad-based ones are near-exact parity; the compressor is
approximate.

| Effect | Params | FFmpeg | Preview node |
|---|---|---|---|
| **High-Pass** | freq [20,2000] 100 Hz | `highpass=f=${freq}` | biquad highpass |
| **Low-Pass** | freq [500,20000] 8000 Hz | `lowpass=f=${freq}` | biquad lowpass |
| **Bass** | gain [-24,24] 0 dB (neutral 0) | `bass=g=${gain}` | lowshelf f=100 |
| **Treble** | gain [-24,24] 0 dB (neutral 0) | `treble=g=${gain}` | highshelf f=3000 |
| **Compressor** | threshold [-60,0] -18 dB, ratio [1,20] 4 (neutral ratio≤1) | `acompressor=threshold=${10^(dB/20)}:ratio=${ratio}` | DynamicsCompressor (knee 6, atk .01, rel .15) |
| **EQ Band** | freq [20,20000] 1000, gain [-24,24] 0 dB (neutral 0), q [0.1,10] 1 | `equalizer=f=${freq}:t=q:w=${q}:g=${gain}` | biquad peaking |
| **Notch** | freq [20,20000] 1000, q [0.1,20] 4 | `bandreject=f=${freq}:t=q:w=${q}` | biquad notch |
| **Gain** | gain [-24,24] 0 dB (neutral 0) | `volume=${gain}dB` | GainNode 10^(dB/20) |

Chain: enabled, non-neutral effects comma-joined; inserted after volume/fade,
before resample.

---

## 11. Export pipeline (FFmpeg graph — reference for describe-to-FFmpeg)

The current exporter is a **pure compiler**: `(project, options) -> ffmpeg args`.
It is heavily unit-tested by asserting the resulting `-filter_complex` string.
Keep this pure-compiler approach for the FFmpeg export path in C++ — it's the most
testable part of the system.

**Options:** output path; width/height (canvas or preset); fps (source/24/30/60);
codec h264|h265; CRF (quality high/balanced/small map); optional In/Out range;
audio mode `mix` (sum to one stereo stream) | `separate` (one stream per track);
frame-accurate flag (the slow canvas path — deprioritized, see §13).

**Inputs:** one `-i` per used non-image media (provides both video and audio
streams). Each **image clip** gets its own looped input (`-loop 1 -t <total>
-framerate fps`, or `-ignore_loop 0 -t <total>` for animated GIF). Adjustment
layers have no input file.

**Video graph — two paths:**
- **CONCAT (fast path)** — used only when there's a single plain video track and
  *none* of: transforms, images, sub-1 opacity, fades, transitions, blends,
  keyframes, effect keyframes, adjustment layers. Build `[clip | black-gap]*` each
  as `trim → (reverse) → setpts(speed) → scale+pad to WxH → effects → fps →
  yuv420p → setsar=1`, then `concat=n=…:v=1:a=0[vout]`. Black gaps fill time
  between clips.
- **OVERLAY compositor (general path)** — `color=black[base]`, then for each track
  bottom-to-top, for each segment: overlay it (time-shifted, scaled, positioned,
  rotated, faded, `format=yuva420p` for alpha, effects after the format).
  Adjustment layers apply their **time-gated** effect chain to the accumulator
  instead of drawing. Ends `[…]null[vout]`.

**Audio graph:** per clip →
`atrim=start:end → (areverse) → asetpts=PTS-STARTPTS → atempo(speed) →
volume(const or eval=frame automation) → afade(in/out) → [audio effects] →
aresample=48000 → aformat=stereo → adelay=<startMs>:all=1[aN]`. Mix clips within a
track (`amix …:normalize=0`), then either sum all tracks (`amix` +
`alimiter=limit=0.95`) or emit each track separately, each limited.

**Volume automation expr:** piecewise-linear ffmpeg expression in `t` from the
gain keyframes, used as `volume=eval=frame:volume='<expr>'`.

**Range export:** trims the composed `[vout]`/audio to `[rangeStart,rangeEnd]` and
resets PTS. (In the frame-accurate path the frames are already the range, so only
audio is trimmed.)

**Encoding:** h264 (`libx264 -preset medium -crf N -pix_fmt yuv420p`) or h265
(`libx265 … -tag:v hvc1`); audio `aac -b:a 192k -ar 48000`; `-r fps -y out`.

**Command-line length:** a big graph exceeds the OS command-line limit → write the
graph to a temp file and use **`-filter_complex_script <file>`** (already done).
In C++ prefer the libav* API directly and avoid the CLI entirely.

**Keyframe baking (§12)** and **generated-media baking (§14)** feed this graph.

---

## 12. Keyframe baking for export

FFmpeg filtergraphs can't easily animate transforms per frame, so an animated (or
push/slide) segment is **expanded into short fixed-transform slices** and each
slice overlaid via the static path:
- Sample rate = `min(fps, 30)`, up to 600 slices per segment.
- Each slice `[a,b]` carries `fixedTransform = animatedTransform(mid)`,
  `fixedOpacity = animatedOpacity(mid)*fade`, `fixedEffects = resolvedEffects(mid)`
  (effect params baked), and any push/slide x-offset folded into `fixedTransform.x`.
- Because slices sample `evalKeyframes` at ~30fps, **easing/hold render correctly**
  on export automatically.

In the C++ own-compositor path this whole mechanism disappears — you just render
each real output frame with live-evaluated keyframes. Baking is only needed for the
describe-to-FFmpeg path.

---

## 13. Frame-accurate export (current beta — deprioritized)

An opt-in mode renders every output frame through the compositor at full res
(seeking each source, awaiting decode), stages a PNG sequence, and muxes with the
normal audio graph via a `videoFromFrames` compiler branch. It gives perfect
parity but is **very slow** for the reasons in §3 — this is exactly what the C++
rewrite fixes with native sequential decode + GPU compositing. Treat this TS
implementation as a *proof of the concept*, not a design to port literally.

---

## 14. Generated media

- **Text/title:** laid out and drawn with the same routine in preview and export.
  On export the text clip is **rendered to a transparent full-canvas PNG with its
  transform baked in** (then the transform is cleared, since it's in the pixels).
  Support: font family/size/color, bold/italic, alignment, optional background
  box, outline (color+width), drop shadow.
- **Color matte:** solid color or **linear gradient** (`color → color2` along
  `angle`°; 0=left→right, 90=top→bottom). Shared fill routine for preview and the
  export PNG. Keeps its transform (scale/position/keyframes apply).
- **Adjustment layer:** draws nothing; its effect stack filters everything on the
  tracks **below** it within its time span (preview re-filters the composite;
  export uses `enable=`-gated filters). Only the gate-able color/blur effects
  apply.

In C++ these are just compositor primitives (text rasterizer, gradient fill, and a
"filter the layers below" pass) — no PNG round-trip needed.

---

## 15. Video scopes (analysis, no export effect)

Overlay on the program monitor, sampling a downscaled copy of the output each
frame. Pure math, unit-tested; renders never affect the model/export.
- **Histogram** (R/G/B + luma, 256 bins).
- **Waveform** (luma distribution per column).
- **RGB Parade** (three waveforms side by side).
- **Vectorscope** (BT.601 Cb/Cr scatter; grey center, primaries toward the rim).
- Luma = BT.601 `0.299R + 0.587G + 0.114B`.

---

## 16. Project persistence

- Save/Open a project as **JSON** (the whole `Project`), written/read via native
  file I/O. Choose a versioned schema (add a `version` field) so the C++ format
  can evolve. The current TS model *is* the schema (§5).
- **Autosave** periodically to a temp location.
- Media are referenced by absolute `path`; on load, missing files should be
  flagged (offer relink) rather than silently dropping clips.

---

## 17. Platform integration (what the shell must provide)

Current Rust commands (replicate equivalents natively):
- `probeFile(path)` → duration, streams, width/height/fps (ffprobe).
- `extractWaveform(path, stream)` → downsampled peaks for the timeline.
- `extractThumbnails(path, …)` → filmstrip thumbnails for clips.
- `extractAudioBuffer(path, stream)` → decoded PCM for playback.
- `runFfmpeg(args, onProgress, onLog)` → spawn + parse `time=` for progress +
  cancel. (In C++, prefer linking libav* over spawning a binary.)
- File I/O: read/write text (projects), write binary (snapshots/frames), make/
  remove temp dirs.
- Frame **snapshot** of the current program frame to PNG.
- **Auto-updater** (current app self-updates from GitHub Releases; optional for the
  rewrite but the friend relies on painless updates).

Bundle FFmpeg/ffprobe (or link libav*) so the app is self-contained.

---

## 18. UI / UX specification

Three-region layout (resizable splitters):

- **Project panel (left):** media pool (import, thumbnails, durations), buttons:
  Open, Save, Import Media, Export, Add Text, Color Matte, Adjustment Layer,
  Snapshot; Check for Updates; Maximize Video.
- **Program monitor (center):** letterboxed canvas with on-canvas transform
  handles (drag body=move, corners=scale (aspect-lock toggle), top handle=rotate),
  edge/center **snap guides**. Left of it, a context **Effect Controls / Text /
  Color Matte / Audio** panel for the selected clip:
  - **Effect Controls (video clip):** Motion (Position X/Y, Scale X/Y + aspect
    lock, Rotation, Opacity — each with a ◆ stopwatch to animate and a
    **Lin/Hold/Ease** interpolation chip when animated), Time Remapping (Speed %,
    Reverse), Composite (Blend), Effects (add-dropdown, per-effect card:
    ▲▼ reorder, On/Off, ✕ remove, param sliders with ◆ + interp chip, color
    pickers, toggles), Copy/Paste/Clear.
    - **Audio panel (audio clip):** Audio Effects (add-dropdown + cards).
  - Transport row: Play, Loop, **Scopes** toggle (+ tabs), **Preview** resolution
    (Full/½/¼), Canvas preset + custom W×H, timecode, VU meter, master volume.
- **Timeline (bottom):** ruler + tracks. Tools: **Select, Razor, Rate (stretch),
  Slip, Slide**; Snap toggle; In/Out; Marker; Link/Unlink; +Video/+Audio Track;
  Fit. Per clip: thumbnails (video), waveform (audio), fade handles, keyframe
  diamonds, gain rubber-band (Alt-click add point, drag). Per track: enable/lock
  (video), mute/solo (audio). Drag to move; drag edges to trim; playhead scrub.
- **Export dialog:** Resolution, Frame rate, Codec, Quality, Audio (mix/separate),
  **Frame-accurate (beta)** checkbox; progress overlay with % and Cancel.

Keyboard: standard transport/tool shortcuts (Play/space, V/C/R/Y/U tools, I/O
in/out, J/K/L shuttle, S snap, marker keys, undo/redo). Reproduce a Premiere-like
feel.

**Canvas presets:** 1920×1080, 2560×1440, 3840×2160, 3440×1440 (UW), 2560×1080
(UW), 1080×1920 (vertical), 1080×1080 (square), custom.

---

## 19. Testing philosophy (carry over)

The TS project keeps a large suite of **pure unit tests** over the model, the
effect registries, and the **export compiler** (asserting exact ffmpeg fragment
strings). This caught real bugs and enabled confident refactors. In C++:
- Keep the model and export-graph builders pure and table-test them.
- Snapshot-test effect fragment strings.
- Add golden-image tests for the compositor once GPU rendering exists.

---

## 20. Known gotchas & non-obvious decisions (read before coding)

1. **Transforms are canvas fractions; scale 1 = aspect-fit-to-canvas**, not
   1:1 pixels. Get this right or everything is mispositioned.
2. **Video tracks are stored top-first but composited bottom-first.**
3. **Transitions use handle-borrowing + geometry, not `xfade`.** Deliberate.
4. **Effects do not force the overlay export path** (except adjustment layers /
   things needing alpha); a plain single track with only color effects stays on
   the fast concat path.
5. **Filter parity is approximate** for color/chroma/vignette; exact for
   crop/flip/invert and the biquad audio filters.
6. **HiDPI filter softening** (canvas-specific) — moot in a native render target.
7. **Command-line length** — moot if you link libav* instead of spawning ffmpeg.
8. **MKV/long-GOP seeking is the core perf villain** — design export around
   sequential native decode, never per-frame seeks.
9. **Audio gain easing** is modeled but not yet honored by the scheduler/export
   (linear ramps between breakpoints).
10. **Generated media** currently round-trip through PNGs on export — unnecessary
    in a native compositor.

---

## 21. Feature checklist (parity target for the rewrite)

Multi-track timeline; drag/trim/split/ripple/insert/overwrite; snapping; markers;
grouping/linking; tools (Select/Razor/Rate/Slip/Slide); undo/redo. Per-clip
transform (pos/scale/rotation), opacity, blend modes, fades, constant speed +
reverse (pitch-preserved audio), keyframes (transform/opacity/effect params/gain)
with Linear/Hold/Ease. Visual effects: brightness, contrast, saturation, hue,
blur, B&W, invert, flip, chroma key, crop, vignette (stackable, reorderable,
copy/paste, keyframeable). Adjustment layers. Generators: text titles, color
mattes (solid/gradient). Transitions: dissolve, dip-to-black, push, slide. Audio:
per-clip volume + automation, fades, master volume, VU meter, mute/solo, audio
effects (high/low-pass, bass, treble, compressor, EQ band, notch, gain). Scopes:
histogram/waveform/parade/vectorscope. Program monitor with transform handles +
snapping + playback-resolution. Export: H.264/H.265, CRF, resolution/fps presets,
In/Out range, mix/separate audio, progress + cancel; snapshot to PNG. Project
save/load + autosave. Auto-update (optional).

**New capability the rewrite unlocks (the whole point):** fast, frame-exact export
via native decode + GPU compositing, making canvas-only effects (arbitrary masks,
shape masks, wipe transitions, real motion blur, etc.) cheap and exact.

---

*End of spec. The `src/core/` TypeScript (model, `effects.ts`, `audioEffects.ts`,
`export.ts`, `scopes.ts`) is the authoritative reference for exact numeric output
and edge cases; this document is the map.*
