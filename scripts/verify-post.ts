/**
 * Self-test for the post chain's parameters.
 *
 * The chain's LOOK is judged from a frame and its banding is measured by
 * `scripts/banding.ts`. What neither of those can check is the set of
 * properties that hold across tiers and across devices — that nothing the post
 * chain does ever walks backwards, that the grain stays under the amplitude
 * the brief fixed, that the aberration is a lens and not a glitch, and that a
 * machine which drops a pyramid level does not thereby get a dimmer bloom.
 * Each of those is a rule someone could break without any single screenshot
 * looking wrong.
 *
 *   npx tsx scripts/verify-post.ts
 */

import { MAX_TIER_INDEX, TIERS } from "../config/tiers";
import { UPSAMPLE_WEIGHT, bloomNormalize } from "../lib/gl/PostChain";
import { QUALITY_PROFILES } from "../lib/gl/quality";
import { VisualState } from "../lib/gl/VisualState";
import { POST_CONSTANTS } from "../lib/gl/shaders/post.glsl";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

function advance(state: VisualState, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) state.update(dt);
}

// --- the tier table is monotone in every post parameter ---------------------
// The ratchet in VisualState guarantees the tier INDEX never falls. That only
// guarantees the visuals never reverse if every parameter is non-decreasing in
// the index, which is a property of the table, not of the ratchet.
for (const key of ["bloomStrength", "chromaticAberration", "grainAmount"] as const) {
  let monotone = true;
  let where = "";
  for (let i = 1; i < TIERS.length; i += 1) {
    if (TIERS[i][key] < TIERS[i - 1][key]) {
      monotone = false;
      where = `tier ${i} (${TIERS[i][key]}) < tier ${i - 1} (${TIERS[i - 1][key]})`;
    }
  }
  check(`${key} never decreases with tier`, monotone, where);
}

// --- the post ratchet -------------------------------------------------------
const ratchet = new VisualState(7);
advance(ratchet, 10);
const atSeven = ratchet.readPost();

ratchet.setTier(1);
advance(ratchet, 10);
const afterCrash = ratchet.readPost();

check(
  "a market-cap crash does not dim the bloom",
  afterCrash.bloomStrength >= atSeven.bloomStrength - 1e-9,
  `${atSeven.bloomStrength.toFixed(4)} -> ${afterCrash.bloomStrength.toFixed(4)}`,
);
check(
  "a market-cap crash does not narrow the aberration",
  afterCrash.chromaticAberration >= atSeven.chromaticAberration - 1e-9,
  `${atSeven.chromaticAberration.toFixed(4)} -> ${afterCrash.chromaticAberration.toFixed(4)}`,
);
check(
  "a market-cap crash does not reduce the grain",
  afterCrash.grainAmount >= atSeven.grainAmount - 1e-9,
  `${atSeven.grainAmount.toFixed(4)} -> ${afterCrash.grainAmount.toFixed(4)}`,
);

// --- every post parameter is lerped, not stepped ----------------------------
// A single frame in which the bloom jumps from one tier's value to the next is
// a flash, and on a page whose whole point is milestones, a flash on an unlock
// is indistinguishable from a rendering bug.
const unlock = new VisualState(3);
const before = unlock.readPost();
unlock.update(1 / 60);
const oneFrameLater = unlock.readPost();
check(
  "a page load starts at its tier rather than animating up to it",
  Math.abs(before.bloomStrength - TIERS[3].bloomStrength) < 1e-9 &&
    Math.abs(oneFrameLater.bloomStrength - before.bloomStrength) < 1e-9,
  `${before.bloomStrength.toFixed(4)} at tier 3`,
);

unlock.setTier(11);
unlock.update(1 / 60);
const firstFrame = unlock.readPost();
const span = TIERS[11].bloomStrength - TIERS[3].bloomStrength;
check(
  "an unlock moves the bloom by a fraction of a frame, not the whole step",
  firstFrame.bloomStrength > TIERS[3].bloomStrength &&
    firstFrame.bloomStrength < TIERS[3].bloomStrength + span * 0.05,
  `${firstFrame.bloomStrength.toFixed(4)} after one frame of a ` +
    `${TIERS[3].bloomStrength} -> ${TIERS[11].bloomStrength} unlock`,
);

advance(unlock, 12);
const settled = unlock.readPost();
check(
  "and arrives at the new tier within a few seconds",
  Math.abs(settled.bloomStrength - TIERS[11].bloomStrength) < 0.01 &&
    Math.abs(settled.chromaticAberration - TIERS[11].chromaticAberration) < 0.01 &&
    Math.abs(settled.grainAmount - TIERS[11].grainAmount) < 0.01,
  `bloom ${settled.bloomStrength.toFixed(4)}, aberration ` +
    `${settled.chromaticAberration.toFixed(4)}, grain ${settled.grainAmount.toFixed(4)}`,
);

// A post parameter that dips even for one frame during a multi-tier unlock is
// a flicker. Exponential smoothing toward a fixed target cannot overshoot, but
// the property is cheap to assert and expensive to notice by eye.
const smooth = new VisualState(0);
smooth.setTier(11);
let previousBloom = -1;
let nonDecreasing = true;
for (let frame = 0; frame < 900; frame += 1) {
  smooth.update(1 / 60);
  const value = smooth.readPost().bloomStrength;
  if (value < previousBloom - 1e-12) nonDecreasing = false;
  previousBloom = value;
}
check("the bloom never dips during an unlock", nonDecreasing);

// --- the brief's grain ceiling ----------------------------------------------
// "under 0.03" is a number, so it is checked as one. The shader multiplies the
// tier's grainAmount by GRAIN_SCALE, and the midtone weight only ever reduces
// that, so the tier-11 product is the largest amplitude this project can show.
const peakGrain = TIERS[MAX_TIER_INDEX].grainAmount * POST_CONSTANTS.grainScale;
check(
  "peak film grain amplitude stays under the brief's 0.03",
  peakGrain < 0.03,
  `${peakGrain.toFixed(5)} at tier ${MAX_TIER_INDEX} ` +
    `(${TIERS[MAX_TIER_INDEX].grainAmount} x ${POST_CONSTANTS.grainScale}) ` +
    `= ${(peakGrain * 255).toFixed(1)} levels of 255`,
);
const floorGrain = TIERS[0].grainAmount * POST_CONSTANTS.grainScale;
check(
  "and is still non-zero at tier 0 — grain is never fully off",
  floorGrain > 0,
  `${floorGrain.toFixed(5)} = ${(floorGrain * 255).toFixed(1)} levels of 255`,
);

// --- chromatic aberration reads as a lens, not as a glitch ------------------
// The shader's split at the corner is `uAberration * ABERRATION_UNIT` of the
// viewport width, and it falls to zero at the centre.
const cornerSplitPx = (tier: number, width: number): number =>
  TIERS[tier].chromaticAberration * POST_CONSTANTS.aberrationUnit * width;

check(
  "aberration is exactly zero at tier 0",
  TIERS[0].chromaticAberration === 0,
  `${cornerSplitPx(0, 1920).toFixed(2)} px at 1920 wide`,
);
check(
  "aberration is sub-pixel through the early tiers",
  cornerSplitPx(1, 1920) < 1 && cornerSplitPx(2, 1920) < 1,
  `tier 1 ${cornerSplitPx(1, 1920).toFixed(2)} px, tier 2 ${cornerSplitPx(2, 1920).toFixed(2)} px`,
);
check(
  "aberration is perceptible but not a glitch effect at tier 11",
  cornerSplitPx(MAX_TIER_INDEX, 1920) > 2 && cornerSplitPx(MAX_TIER_INDEX, 1920) < 12,
  `${cornerSplitPx(MAX_TIER_INDEX, 1920).toFixed(2)} px at the corner of a 1920-wide frame`,
);

// --- the vignette is always on ----------------------------------------------
check(
  "the vignette is on at every tier and is not tier-driven",
  POST_CONSTANTS.vignetteStrength > 0 && POST_CONSTANTS.vignetteFalloff >= 2,
  `${(POST_CONSTANTS.vignetteStrength * 100).toFixed(0)}% at the corners, ` +
    `falloff exponent ${POST_CONSTANTS.vignetteFalloff}`,
);

// --- the bloom threshold is high --------------------------------------------
// The brief asks for a threshold high enough that the body of the disk does not
// bloom. The disk's source function at tier 0 peaks near 4 on the beamed inner
// limb and sits well under 1 across most of its area, so a threshold of 1 in
// linear radiance is the right order of magnitude; a threshold near 0.1 would
// be a glow filter over the whole frame.
check(
  "the bloom threshold is high, in linear radiance",
  POST_CONSTANTS.bloomThreshold >= 1 && POST_CONSTANTS.bloomKnee < POST_CONSTANTS.bloomThreshold,
  `threshold ${POST_CONSTANTS.bloomThreshold}, soft knee +/-${POST_CONSTANTS.bloomKnee}`,
);

// --- the single disable flag ------------------------------------------------
check(
  "the low quality profile runs no post chain at all",
  QUALITY_PROFILES.low.post === false && QUALITY_PROFILES.low.bloomLevels === 0,
);
check(
  "medium and high run it",
  QUALITY_PROFILES.medium.post && QUALITY_PROFILES.high.post,
  `high ${QUALITY_PROFILES.high.bloomLevels} levels, ` +
    `medium ${QUALITY_PROFILES.medium.bloomLevels} levels`,
);

// --- bloom energy does not depend on how deep the pyramid got ---------------
// A short window, or a governor step down, can leave fewer levels than the
// profile asked for. Without the normalisation below, resizing the browser
// would visibly change the bloom, which would read as the effect being tied to
// the window rather than to the tier.
let energyStable = true;
let detail = "";
for (let levels = 1; levels <= QUALITY_PROFILES.high.bloomLevels; levels += 1) {
  let total = 0;
  for (let k = 0; k < levels; k += 1) total += UPSAMPLE_WEIGHT ** k;
  const normalised = total * bloomNormalize(levels);
  if (Math.abs(normalised - 1) > 1e-9) {
    energyStable = false;
    detail = `${levels} level(s) normalise to ${normalised.toFixed(6)}`;
  }
}
check("bloom energy is independent of pyramid depth", energyStable, detail);
check(
  "the pyramid tapers, so the coarsest level is not the loudest",
  UPSAMPLE_WEIGHT > 0 && UPSAMPLE_WEIGHT < 1,
  `weight ${UPSAMPLE_WEIGHT} per level; the 5th level carries ` +
    `${(UPSAMPLE_WEIGHT ** 4 * 100).toFixed(0)}% of the base level's`,
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
