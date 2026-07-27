import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_EFFECTS,
  audioEffectDef,
  audioDefaultParams,
  ffmpegAudioChainFor,
} from "../audioEffects.ts";
import type { AudioClipEffect } from "../project.ts";

test("every audio effect has params with sane defaults inside range", () => {
  for (const def of AUDIO_EFFECTS) {
    assert.ok(def.params.length > 0, `${def.id} has params`);
    for (const p of def.params) {
      assert.ok(p.def >= p.min && p.def <= p.max, `${def.id}.${p.key} default in range`);
    }
  }
});

test("high/low-pass emit their cutoff (rounded)", () => {
  assert.equal(audioEffectDef("highpass")!.ffmpeg({ freq: 120 }), "highpass=f=120");
  assert.equal(audioEffectDef("lowpass")!.ffmpeg({ freq: 7999.6 }), "lowpass=f=8000");
});

test("bass/treble are neutral at 0 dB and emit a shelf otherwise", () => {
  assert.equal(audioEffectDef("bass")!.ffmpeg({ gain: 0 }), "");
  assert.equal(audioEffectDef("bass")!.ffmpeg({ gain: 6 }), "bass=g=6.0");
  assert.equal(audioEffectDef("treble")!.ffmpeg({ gain: 0 }), "");
  assert.equal(audioEffectDef("treble")!.ffmpeg({ gain: -4 }), "treble=g=-4.0");
});

test("compressor is a no-op at ratio 1 and converts threshold dB to linear", () => {
  assert.equal(audioEffectDef("compressor")!.ffmpeg({ threshold: -18, ratio: 1 }), "");
  const s = audioEffectDef("compressor")!.ffmpeg({ threshold: -20, ratio: 4 });
  // -20 dB → 0.1 linear amplitude.
  assert.equal(s, "acompressor=threshold=0.10000:ratio=4.0");
});

test("EQ band is neutral at 0 dB and emits a peaking equalizer otherwise", () => {
  const def = audioEffectDef("eqband")!;
  assert.equal(def.ffmpeg({ freq: 1000, gain: 0, q: 1 }), "");
  assert.equal(def.ffmpeg({ freq: 2500, gain: 6, q: 1.5 }), "equalizer=f=2500:t=q:w=1.50:g=6.0");
});

test("notch always emits a band-reject at its frequency/Q", () => {
  assert.equal(audioEffectDef("notch")!.ffmpeg({ freq: 60, q: 8 }), "bandreject=f=60:t=q:w=8.00");
});

test("gain is neutral at 0 dB and emits a dB volume otherwise", () => {
  const def = audioEffectDef("gain")!;
  assert.equal(def.ffmpeg({ gain: 0 }), "");
  assert.equal(def.ffmpeg({ gain: -3 }), "volume=-3.0dB");
});

test("audioDefaultParams fills every param key", () => {
  assert.deepEqual(audioDefaultParams("compressor"), { threshold: -18, ratio: 4 });
  assert.deepEqual(audioDefaultParams("nope"), {});
});

test("ffmpegAudioChainFor joins enabled, non-neutral effects with commas", () => {
  const fx: AudioClipEffect[] = [
    { type: "highpass", params: { freq: 80 } },
    { type: "bass", params: { gain: 0 } }, // neutral -> skipped
    { type: "compressor", params: { threshold: -18, ratio: 3 } },
  ];
  assert.equal(
    ffmpegAudioChainFor(fx),
    "highpass=f=80,acompressor=threshold=0.12589:ratio=3.0",
  );
});

test("disabled audio effects and empty stacks contribute nothing", () => {
  const fx: AudioClipEffect[] = [
    { type: "lowpass", enabled: false, params: { freq: 5000 } },
    { type: "treble", params: { gain: 3 } },
  ];
  assert.equal(ffmpegAudioChainFor(fx), "treble=g=3.0");
  assert.equal(ffmpegAudioChainFor([]), "");
  assert.equal(ffmpegAudioChainFor(undefined), "");
});
