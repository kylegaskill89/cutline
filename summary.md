# Cutline — Project Summary & Handoff

_Last updated: 2026-07-26. This document orients a new AI agent (or developer) to the
project. Keep it current when you ship major features or make architectural decisions._

---

## 1. What this project is

**Cutline** is a Premiere-style, non-linear video editor (NLE) for the desktop.

- **Shell:** Tauri 2 (Rust) — `src-tauri/`. Bundles `ffmpeg` and `ffprobe` as
  sidecar binaries (in `src-tauri/binaries/`, per-platform) for all media work.
- **Frontend:** Vite + **vanilla TypeScript** (no framework). Entry is
  `index.html` → `src/editor/main.ts`.
- **Repo:** `github.com/kylegaskill89/cutline` (public).
- **Distribution:** NSIS installer with an **in-app auto-updater** (Tauri updater
  plugin + GitHub Releases). A friend runs the app and gets new features via
  auto-update without reinstalling — so **shipping broken code to `main` can reach
  a real user.** Treat export/render correctness with care.
- **Current version:** `0.1.2` (in `package.json` + `src-tauri/tauri.conf.json`).
  Several major features have landed on `main` since the v0.1.2 tag and are
  **not yet released** (see Release cadence below).

The app was migrated from an earlier Python/tkinter tool; this is a ground-up
Tauri rewrite.

---

## 2. Architecture & where things live

The cardinal rule: **`src/core/` is pure and unit-tested; the editor/UI layer is
thin.** Every subsystem is a function of the data model.

### `src/core/` — pure, tested, no DOM
- **`project.ts`** — THE data model: `Project → Track → Clip` over a pool of
  `Media`. All edit operations are **pure** (take a Project, return a *new*
  Project; never mutate). Contains: clips, transforms, keyframes, effects stacks
  (visual + audio), transitions, gain automation, speed/reverse, markers,
  grouping/linking, ripple/insert/overwrite, `resolveVideoSegments` (expands
  transitions into draw segments), etc.
- **`effects.ts`** — visual effect **registry**. Each effect defines its params
  once plus two emitters: `css(params, colors)` (CSS `filter` fragment for the
  canvas preview) and `ffmpeg(params, colors)` (FFmpeg filter fragment for
  export). This two-emitter pattern keeps **preview and export in parity by
  construction.** Both return `""` at neutral.
- **`audioEffects.ts`** — audio effect registry (same pattern): params +
  `ffmpeg(params)` emitter. The matching Web Audio nodes are built in
  `src/editor/audioNodes.ts`.
- **`export.ts`** — the export compiler: turns a Project + options into an
  **FFmpeg argument list** (a `filter_complex` graph). Pure, so the graph is
  unit-tested without spawning anything. Two video paths: **concat** (single
  plain track) vs **overlay compositor** (multi-track / transforms / effects).
- **`scopes.ts`** — pure pixel-statistics for the scopes panel (histogram,
  waveform, parade, vectorscope binning). Rendering is in `src/editor/scopes.ts`.
- **`probe.ts`, `ffmpeg.ts`, `format.ts`, `waveform.ts`** — ffprobe parsing,
  ffmpeg arg helpers, timecode/format helpers, waveform decoding.
- **`__tests__/`** — Node test runner (`node --test` via `tsx`). **156 tests.**

### `src/editor/` — the app (DOM, canvas, Web Audio)
- **`main.ts`** — orchestration: DOM wiring, event handlers, panels, transport,
  export flow, undo/redo history, all the glue. (Large; ~3k lines.)
- **`preview.ts`** — `Preview` class: the **compositing preview**. A `<canvas>`
  composites every visual clip active at the playhead (transform, opacity, blend,
  effects, chroma key, transitions). Video frames come from a pool of hidden muted
  `<video>` elements; audio is separate (AudioEngine).
- **`timelineView.ts`** — `TimelineView`: the timeline canvas (tracks, clips,
  thumbnails, waveforms, keyframes, gain rubber-band, playhead, tools).
- **`audioEngine.ts`** — `AudioEngine`: multi-track Web Audio playback. Decodes
  each (media, stream) to an AudioBuffer; on play, schedules every clip from the
  playhead as `source → gain → [effect chain] → master`. The audio clock is the
  master timeline clock while playing (better A/V sync). Handles reverse,
  pitch-preserving time-stretch for speed, fades, gain automation.
- **`audioNodes.ts`** — builds the Web Audio filter chain for a clip's audio
  effects (mirrors `core/audioEffects.ts`).
- **`chromaKey.ts`** — `ChromaKeyer`: per-pixel BT.601 U/V chroma-distance keyer
  on an offscreen canvas. Approximates ffmpeg `chromakey` (not pixel-identical).
- **`scopes.ts`** — `ScopeView`: colourises the pure scope grids onto a canvas.
- **`matteRender.ts`** — shared solid/gradient matte fill (preview + export bake).
- **`textRender.ts`** — text/title layout + drawing (preview + export bake).
- **`editor.css`** — all styles.

### `src/tauri/`
- **`sidecar.ts`** — invoke wrappers: `probeFile`, `extractWaveform`,
  `extractThumbnails`, `runFfmpeg`, `extractAudioBuffer`, `assetUrl`
  (`convertFileSrc` — serves local files cross-origin with CORS headers).
- **`updater.ts`** — `runUpdateCheck({silent})` using the updater + process plugins.

### `src-tauri/`
- **`src/lib.rs`** — Rust commands (e.g. `write_binary_file` for snapshot/save),
  plugin init (shell, dialog, updater, process).
- **`tauri.conf.json`** — product config, updater pubkey + endpoint, bundle targets.
- **`.github/workflows/release.yml`** — on `v*` tags: downloads ffmpeg, runs
  `npm test`, builds/signs/publishes via `tauri-action` with updater JSON.

---

## 3. Features the program has (shipped)

**Editing & timeline**
- Multi-track video + audio; drag/move/trim/split (razor); ripple delete; insert
  / overwrite; snapping; markers; clip grouping/linking (A/V move together).
- Tools: Select, Razor, Rate Stretch, Slip, Slide.
- Undo/redo history.

**Clip properties**
- Transform (position, scale per-axis, rotation), opacity, blend modes.
- Fades (in/out) for video (alpha) and audio (gain).
- **Constant speed** (0.05×–100×, pitch-preserving audio) + **reverse**.
- **Keyframes** on transform + opacity, with on-canvas + timeline editing and a
  stopwatch UI. **Interpolation modes** per property — Linear / Hold / Ease
  (smoothstep) — via a cycle chip beside each stopwatch (also on effect params).
  Honoured by preview and the sampled export bake automatically. (Gain/volume
  keyframes are still linear-only — UI follow-up.)

**Visual effects** (registry; preview↔export parity by construction)
- Brightness, Contrast, Saturation, Hue, Gaussian Blur, Black & White, Invert,
  Flip (H/V), **Chroma Key**.
- Effect params are **keyframeable**. Effects stack with **reorder / enable-disable
  / copy-paste between clips / clear**.
- **Adjustment layers** — a clip whose effect stack filters everything on the
  tracks below it, within its span.

**Audio**
- Per-clip volume; **volume automation** (rubber-band gain keyframes on the
  timeline); master volume; VU meter.
- **Audio effects** (registry): High-Pass, Low-Pass, Bass, Treble, Compressor.
  Web Audio in preview ↔ ffmpeg filters on export (close parity; compressor
  approximate).
- Track mute/solo; export audio as mixed or separate-per-track streams.

**Generators**
- Text/title clips (font, size, colour, align, background, outline, shadow).
- **Colour Matte** (solid + linear gradient).

**Transitions** (out-edge, into an abutting clip)
- Cross-dissolve, Dip-to-black, **Push**, **Slide** (geometric, baked through the
  keyframe-slice path — deliberately NOT `xfade`).

**Monitoring**
- Compositing program monitor with letterboxing + on-canvas transform handles.
- **Video scopes**: Histogram, Waveform (luma), RGB Parade, Vectorscope
  (analysis-only overlay; never touches model/export).
- **Playback resolution** dropdown (Full / ½ / ¼) — reduces render res while
  playing for higher frame rate, full res when paused.
- **Snapshot** current frame to PNG.

**Export**
- H.264 / H.265, CRF, canvas presets (1080p/1440p/4K/ultrawide/vertical/square/
  custom), fps; optional In/Out range; progress overlay with cancel.

**Platform**
- Auto-updater; branded (name "Cutline", scissors icon); "Check for Updates".

---

## 4. Roadmap (planned / not yet done)

Ordered roughly by value/priority. **The big ones need real-build validation**
(the human tester runs `npm run tauri dev` / real exports — the agent cannot pixel-
or audio-validate ffmpeg output in the dev environment).

1. **Frame-accurate export renderer (Phase 3 — the strategic unlock).** Pipe the
   preview canvas frames → ffmpeg stdin. Enables crop, shape masks, vignette, and
   the Wipe transition with *perfect* preview↔export parity, and retires the
   "ffmpeg parity is approximate" caveat hanging over effects. Requires Rust
   stdin-streaming / muxing that must be validated against real builds — do it
   incrementally with the tester, not blind.
2. **Speed ramping** — keyframed (variable) speed, as opposed to the shipped
   constant speed. Large: nonlinear duration, audio, timeline layout, keyframe
   time remapping.
3. **Wipe transition** — needs a growing reveal **mask/crop** the current
   keyframe-bake path can't carry (it only bakes position/scale/rotation).
   Cleanly doable once the frame-accurate renderer exists.
4. **Audio effects, phase 2** — parametric EQ, de-esser, noise reduction; tighten
   compressor parity.
5. **Nested sequences / compound clips** — very large; a sequence usable as a clip.
6. **More scopes / false-colour, zebra**; scope options (parade RGB/YUV, etc.).
7. **Keyframe easing UI for gain/volume** — the core `evalKeyframes` already
   supports per-keyframe interp on any keyframe list; only the gain rubber-band
   lacks a UI to set it (transform/opacity/effect params have the cycle chip).
8. **Polish backlog:** text/color-matte clips still use `c.filter` directly (minor
   softening on HiDPI for those specific generators — video is already fixed);
   Gaussian blur radius is now in device px (slightly resolution-dependent).

---

## 5. Key decisions & rationale

- **Pure, tested `src/core/`; prove logic with `npm test` before touching UI.**
  The model and export compiler are the backbone; keeping them pure makes the
  whole app testable without a browser/ffmpeg. _Always run `npx tsc --noEmit` and
  `npm test` after changes._
- **Effect registry with two emitters (css + ffmpeg).** Preview and export can't
  drift because each effect defines both from one source of truth. Same pattern
  reused for audio effects (ffmpeg emitter + Web Audio builder).
- **Transitions baked through the keyframe-slice path, NOT ffmpeg `xfade`.**
  `xfade` is fragile with our compositor/overlap model; baking geometric
  transitions (push/slide) as fixed per-slice transforms reuses the proven
  keyframe machinery. (This is also why Wipe waits for the frame renderer.)
- **Scopes are analysis-only.** Chosen deliberately as a **zero-export-risk**
  feature to ship to a live auto-updating user: reads the preview canvas, never
  the model/export. Pure binning math is still unit-tested.
- **Audio effect filter choices picked for close preview↔export parity.**
  highpass/lowpass/bass/treble map near-identically between Web Audio biquads and
  ffmpeg; compressor is the one approximate match (documented to the user).
- **Preview filter/keying at device resolution.** `ctx.filter` on the dpr-scaled
  main canvas rasterises in CSS px then upscales → soft on HiDPI. Fix: filter/key
  on an identity-transform offscreen at device resolution, blit unfiltered. Chroma
  keying was also capped at 960px (blocky on 4K) → now keys at the clip's on-screen
  device size, capped 2560px for per-frame JS budget.
- **Playback resolution reduces the canvas *backing store* while playing** (CSS
  size unchanged, browser upscales), full res when paused. Self-correcting from
  `render()` each frame — no play/pause coupling code.
- **No emojis in UI.** Text / SVG / Unicode geometric shapes (◆ ▲ ▼ ✕ ●) only.
- **Honesty about validation.** Export graphs are string-tested only; the agent
  flags what it could NOT validate (pixel/audio output, Rust it couldn't build).
  Don't claim verified what wasn't run.

---

## 6. Decisions we made AGAINST (and why)

- **No `xfade` for transitions** — fragile with our overlap/compositor model (see
  above). Bake geometric transitions instead.
- **Deferred crop / shape masks / vignette / Wipe** — their ffmpeg parity is hard
  and can't be validated blind; they're the signal for building the frame-accurate
  renderer, not one-off filter hacks.
- **No frontend framework** — vanilla TS keeps the bundle lean and the canvas/Web
  Audio code direct; a framework buys little for a canvas-heavy single view.
- **Chroma keying capped (2560px preview)** rather than full 4K per frame — full
  per-pixel JS keying every frame at 4K is too slow; export keys at full res via
  ffmpeg anyway, so the final render is unaffected.
- **Updater password secret dropped** — the signing key has no password; GitHub
  rejects empty secrets, so only `TAURI_SIGNING_PRIVATE_KEY` is required in CI.
- **Don't release on every commit** — see cadence below.

---

## 7. Dev workflow, testing, conventions

- **Run the desktop app (real functionality):** `npm run tauri dev`. A plain
  browser at `http://localhost:1420/` shows the frontend but nothing works (no
  Tauri APIs). Frontend edits **hot-reload** into the running app; Rust changes
  need a restart. If port 1420 is stuck, kill the stray node process holding it.
- **Before/after changes:** `npx tsc --noEmit` (typecheck) and `npm test` (unit
  tests). Keep the dev server returning 200. Maintain preview↔export parity.
- **Register new test files** in the `test` script in `package.json` (it lists
  files explicitly).
- **Commit style:** end commit messages with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Work on `main`
  (that's the working branch here). Commit + push after each major set.
- **Line endings:** repo is LF; git warns about CRLF on Windows — harmless.

---

## 8. Release cadence

Only **tag/push a release after major features are done**, not on every commit.
Bump `version` in BOTH `package.json` and `src-tauri/tauri.conf.json`, commit, tag
`vX.Y.Z`, push the tag → the release workflow builds/signs/publishes and updates
the auto-update manifest.

**Currently unreleased on `main` (since the v0.1.2 tag):** video scopes, audio
effects, HiDPI effect-sharpness fix, chroma-key resolution fix, playback-resolution
dropdown. Consider cutting the next release once the current round of preview-quality
/ effects work feels complete.

---

## 9. Quick pointers for common tasks

- **Add a visual effect:** add a def to `EFFECTS` in `core/effects.ts` (css +
  ffmpeg emitters, both neutral-safe); it auto-appears in the Effects dropdown.
  Add a test in `__tests__/effects.test.ts`.
- **Add an audio effect:** add a def to `AUDIO_EFFECTS` in `core/audioEffects.ts`
  (ffmpeg emitter) + a matching node case in `editor/audioNodes.ts`; test in
  `__tests__/audioEffects.test.ts`.
- **Change export behaviour:** edit `core/export.ts`; assert the resulting
  `filter_complex` string in `__tests__/export.test.ts` (that's how export is
  validated without running ffmpeg).
- **Preview drawing:** `editor/preview.ts` `render()` → per-clip draw dispatch
  (`drawTransformed` / `drawTextClip` / `drawColorClip` / `applyAdjustment` /
  `drawGif`).
