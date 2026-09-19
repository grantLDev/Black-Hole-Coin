/**
 * Self-test for `lib/gl/VisualState.ts`.
 *
 * This is the one piece of the render layer that a screenshot cannot check.
 * Everything else is verified by looking at a frame; the ratchet, the jet
 * latch and the frame-rate independence of the smoothing are all properties of
 * a SEQUENCE of frames, and each of them protects a rule the whole project is
 * built on — nothing that has unlocked ever un-unlocks.
 *
 * The colour check is here because the failure it guards against is silent: an
 * sRGB hex used directly as linear radiance still renders, just muddy.
 *
 *   npx tsx scripts/verify-visual-state.ts
 */

import { TIERS, hexToLinearRgb, hexToRgb } from "../config/tiers";
import { VisualState } from "../lib/gl/VisualState";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

/**
 * Run `seconds` of wall time through the smoother at a fixed frame rate.
 *
 * Counted in FRAMES rather than by accumulating `t += dt`, so that two frame
 * rates simulate exactly the same amount of wall time. Accumulating floats
 * lands one loop short or long depending on the step, which shows up in the
 * comparison below as drift the smoother is not actually responsible for.
 */
function advance(state: VisualState, seconds: number, dt = 1 / 60): void {
  const frames = Math.round(seconds / dt);
  for (let frame = 0; frame < frames; frame += 1) state.update(dt);
}

// --- the tier ratchet -------------------------------------------------------
const ratchet = new VisualState(5);
ratchet.setTier(2);
check("a lower tier is refused", ratchet.tier.index === 5, `index ${ratchet.tier.index}`);
ratchet.setTier(7);
check("a higher tier is accepted", ratchet.tier.index === 7, `index ${ratchet.tier.index}`);
ratchet.setTier(0);
check("tier 0 cannot undo an unlock", ratchet.tier.index === 7, `index ${ratchet.tier.index}`);

// --- the jet latch ----------------------------------------------------------
const jet = new VisualState(8);
check("tier 8 has no jet", !jet.hasJet && jet.read().jetStrength === 0);

jet.setTier(9);
check("tier 9 latches the jet on the same frame", jet.hasJet);

advance(jet, 2);
const midFade = jet.read().jetStrength;
check("the jet is mid-fade at 2s", midFade > 0.2 && midFade < 0.95, `strength ${midFade.toFixed(3)}`);

advance(jet, 2.2);
check("the jet is fully on just past 4s", jet.read().jetStrength > 0.999);

jet.setTier(0);
advance(jet, 5);
check(
  "a crash to tier 0 does not retract the jet",
  jet.hasJet && jet.read().jetStrength > 0.999,
  `strength ${jet.read().jetStrength.toFixed(3)}`,
);

// A single frame where the jet dims is a visible flicker, and it is exactly
// what a naive lerp-toward-target would do if the tier were ever lowered.
const monotone = new VisualState(8);
monotone.setTier(11);
let previous = -1;
let nonDecreasing = true;
for (let frame = 0; frame < 600; frame += 1) {
  monotone.update(1 / 60);
  const strength = monotone.read().jetStrength;
  if (strength < previous - 1e-9) nonDecreasing = false;
  previous = strength;
}
check("jet strength never decreases on any frame", nonDecreasing);

// --- smoothing --------------------------------------------------------------
// Progress advances by `dt / TIER_LERP_SECONDS`, so the same wall time buys
// the same progress at any frame rate. The naive `x += (target - x) * k` form
// converges at a speed that depends on frame rate instead, and an unlock tuned
// on a desktop would take twice as long on a phone.
const slow = new VisualState(0);
const fast = new VisualState(0);
slow.setTier(11);
fast.setTier(11);
advance(slow, 3, 1 / 30);
advance(fast, 3, 1 / 120);
const drift = Math.abs(slow.read().diskOuterRadius - fast.read().diskOuterRadius);
// Equality to float noise, not mere convergence: a fixed-duration ease passes
// through the same value at the same instant however finely it is sampled.
check("30fps and 120fps agree after 3s", drift < 1e-9, `drift ${drift.toExponential(2)} rs`);

const settled = new VisualState(0);
settled.setTier(11);
advance(settled, 30);
const top = TIERS[11];
check(
  "the smoother reaches the tier table's values",
  Math.abs(settled.read().diskOuterRadius - top.diskOuterRadius) < 1e-3 &&
    Math.abs(settled.read().diskBrightness - top.diskBrightness) < 1e-3,
  `radius ${settled.read().diskOuterRadius.toFixed(4)}, brightness ${settled
    .read()
    .diskBrightness.toFixed(4)}`,
);

// A hidden tab hands back a delta spanning however long it was hidden.
// Unclamped, that snaps every value to its target — the exact discontinuity
// the smoother exists to prevent.
const resumed = new VisualState(0);
resumed.setTier(11);
resumed.update(60);
check(
  "a 60s frame delta is clamped, not applied whole",
  resumed.read().diskOuterRadius < 6,
  `radius ${resumed.read().diskOuterRadius.toFixed(3)} rs after one 60s step`,
);

// --- colour space -----------------------------------------------------------
// The shader works in linear radiance and applies the sRGB transfer function
// itself at the very end, so the tier hexes must be decoded on the way in.
const sample = TIERS[4].diskColorInner;
const linear = hexToLinearRgb(sample);
const srgb = hexToRgb(sample);
check(
  "tier colours reach the shader as linear light",
  Math.abs(new VisualState(4).read().diskColorInner[1] - linear[1]) < 1e-9,
  `${sample} green: ${linear[1].toFixed(4)} linear vs ${srgb[1].toFixed(4)} sRGB`,
);
check(
  "the decode actually changes the value",
  Math.abs(linear[1] - srgb[1]) > 0.05,
  `delta ${Math.abs(linear[1] - srgb[1]).toFixed(4)}`,
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
