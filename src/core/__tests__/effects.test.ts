import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFFECTS,
  effectDef,
  defaultParams,
  defaultColors,
  cssFilterFor,
  ffmpegChainFor,
} from "../effects.ts";
import type { ClipEffect } from "../project.ts";

// Each effect's identity (no-op) input. Note "grayscale" defaults to 100 (added
// as full black & white) but is a no-op at 0.
const NEUTRAL: Record<string, Record<string, number>> = {
  brightness: { amount: 0 },
  contrast: { amount: 100 },
  saturation: { amount: 100 },
  hue: { angle: 0 },
  blur: { amount: 0 },
  grayscale: { amount: 0 },
};

test("every colour/blur effect emits nothing at its neutral params", () => {
  for (const def of EFFECTS) {
    if (def.id === "chromakey") continue; // keying always emits (no neutral)
    const p = NEUTRAL[def.id];
    assert.ok(p, `missing neutral for ${def.id}`);
    assert.equal(def.css(p, {}), "", `${def.id} css should be neutral`);
    assert.equal(def.ffmpeg(p, {}), "", `${def.id} ffmpeg should be neutral`);
  }
});

test("chroma key: no CSS fragment, ffmpeg chromakey with hex colour", () => {
  const def = effectDef("chromakey")!;
  assert.equal(def.css({ similarity: 30, blend: 10 }, { color: "#00d000" }), "");
  assert.equal(
    def.ffmpeg({ similarity: 30, blend: 10 }, { color: "#00d000" }),
    "chromakey=0x00d000:0.300:0.100",
  );
  assert.deepEqual(defaultColors("chromakey"), { color: "#00d000" });
});

test("Black & White is active at its default (adds full desaturation)", () => {
  const p = defaultParams("grayscale");
  assert.equal(effectDef("grayscale")!.css(p, {}), "grayscale(1.000)");
  assert.equal(effectDef("grayscale")!.ffmpeg(p, {}), "hue=s=0.000");
});

test("brightness emits matching css and ffmpeg fragments", () => {
  const def = effectDef("brightness")!;
  assert.equal(def.css({ amount: 50 }, {}), "brightness(1.500)");
  assert.equal(def.ffmpeg({ amount: 50 }, {}), "eq=brightness=0.500");
});

test("blur maps px to css blur and ffmpeg gblur sigma", () => {
  const def = effectDef("blur")!;
  assert.equal(def.css({ amount: 10 }, {}), "blur(10.0px)");
  assert.equal(def.ffmpeg({ amount: 10 }, {}), "gblur=sigma=10.00");
});

test("cssFilterFor / ffmpegChainFor join enabled, non-neutral effects", () => {
  const effects: ClipEffect[] = [
    { type: "brightness", params: { amount: 20 } },
    { type: "saturation", params: { amount: 100 } }, // neutral -> skipped
    { type: "blur", params: { amount: 4 } },
  ];
  assert.equal(cssFilterFor(effects), "brightness(1.200) blur(4.0px)");
  assert.equal(ffmpegChainFor(effects), "eq=brightness=0.200,gblur=sigma=4.00");
});

test("disabled effects contribute nothing", () => {
  const effects: ClipEffect[] = [
    { type: "blur", enabled: false, params: { amount: 20 } },
    { type: "contrast", params: { amount: 150 } },
  ];
  assert.equal(cssFilterFor(effects), "contrast(1.500)");
  assert.equal(ffmpegChainFor(effects), "eq=contrast=1.500");
});

test("empty / undefined stacks yield empty strings", () => {
  assert.equal(cssFilterFor(undefined), "");
  assert.equal(cssFilterFor([]), "");
  assert.equal(ffmpegChainFor(undefined), "");
});
