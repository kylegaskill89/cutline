import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EFFECTS,
  effectDef,
  defaultParams,
  defaultColors,
  cssFilterFor,
  ffmpegChainFor,
  ffmpegAdjustChain,
  flipFactorsFor,
  cropFractionsFor,
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
  invert: { on: 0 },
  flip: { horizontal: 0, vertical: 0 },
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
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

test("invert toggles between negate/invert and nothing", () => {
  const def = effectDef("invert")!;
  assert.equal(def.css({ on: 1 }, {}), "invert(1)");
  assert.equal(def.ffmpeg({ on: 1 }, {}), "negate");
  assert.equal(def.css({ on: 0 }, {}), "");
  assert.equal(def.ffmpeg({ on: 0 }, {}), "");
});

test("flip emits hflip/vflip per axis, no CSS (preview handles it)", () => {
  const def = effectDef("flip")!;
  assert.equal(def.css({ horizontal: 1, vertical: 1 }, {}), "");
  assert.equal(def.ffmpeg({ horizontal: 1, vertical: 0 }, {}), "hflip");
  assert.equal(def.ffmpeg({ horizontal: 0, vertical: 1 }, {}), "vflip");
  assert.equal(def.ffmpeg({ horizontal: 1, vertical: 1 }, {}), "hflip,vflip");
  assert.equal(def.ffmpeg({ horizontal: 0, vertical: 0 }, {}), "");
});

test("flipFactorsFor mirrors the enabled axes", () => {
  assert.deepEqual(flipFactorsFor([{ type: "flip", params: { horizontal: 1, vertical: 0 } }]), {
    sx: -1,
    sy: 1,
  });
  assert.deepEqual(flipFactorsFor([{ type: "flip", params: { horizontal: 0, vertical: 1 } }]), {
    sx: 1,
    sy: -1,
  });
  // Disabled flip contributes nothing.
  assert.deepEqual(
    flipFactorsFor([{ type: "flip", enabled: false, params: { horizontal: 1, vertical: 1 } }]),
    { sx: 1, sy: 1 },
  );
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

test("crop: neutral at 0, else crops the kept region and pads back to size", () => {
  const def = effectDef("crop")!;
  assert.equal(def.css({ left: 0, top: 0, right: 0, bottom: 0 }, {}), "");
  assert.equal(def.ffmpeg({ left: 0, top: 0, right: 0, bottom: 0 }, {}), "");
  // Cut 10% left + 20% right → keep 70% width; 10% top → keep 90% height.
  const s = def.ffmpeg({ left: 10, top: 10, right: 20, bottom: 0 }, {});
  assert.equal(
    s,
    "crop=iw*0.7000:ih*0.9000:iw*0.1000:ih*0.1000," +
      "pad=iw/0.7000:ih/0.9000:iw*0.1000/0.7000:ih*0.1000/0.9000:color=black@0.0",
  );
});

test("cropFractionsFor reads the enabled crop effect's kept fractions", () => {
  assert.deepEqual(cropFractionsFor([{ type: "crop", params: { left: 25, top: 0, right: 25, bottom: 10 } }]), {
    l: 0.25,
    t: 0,
    r: 0.25,
    b: 0.1,
  });
  assert.deepEqual(cropFractionsFor([{ type: "crop", enabled: false, params: { left: 25 } }]), {
    l: 0,
    t: 0,
    r: 0,
    b: 0,
  });
  assert.deepEqual(cropFractionsFor(undefined), { l: 0, t: 0, r: 0, b: 0 });
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

test("ffmpegAdjustChain time-gates supported effects and drops the rest", () => {
  const eff: ClipEffect[] = [
    { type: "brightness", params: { amount: 20 } },
    { type: "flip", params: { horizontal: 1 } }, // not timeline-gateable → dropped
  ];
  const s = ffmpegAdjustChain(eff, 1, 3);
  assert.equal(s, "eq=brightness=0.200:enable='between(t,1.000,3.000)'");
});
