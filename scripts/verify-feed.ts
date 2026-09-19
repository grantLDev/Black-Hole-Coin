/**
 * Self-test for the feed binding: `lib/gl/holders.ts`, `lib/gl/TierEvent.ts`
 * and `lib/gl/SceneDirector.ts`.
 *
 * Everything checked here is a property of a SEQUENCE of frames, which is
 * exactly the class of bug a screenshot cannot catch. The two channels this
 * project is built on behave differently on purpose, and almost every way of
 * getting them wrong produces a frame that looks perfectly fine on its own:
 *
 *   - a symmetric spring renders identically to an asymmetric one in any
 *     single frame, and turns a sell-off into a collapse over ten seconds;
 *   - a missing peak floor is invisible until the holder count halves;
 *   - a promotion queue that overlaps looks like one slightly odd unlock
 *     rather than two milestones destroying each other;
 *   - and a tier that can be lowered by a stale payload is undetectable until
 *     the day it happens, live, in front of everyone.
 *
 *   npx tsx scripts/verify-feed.ts
 */

import { TIERS } from "../config/tiers";
import {
  CAMERA_DISK_CLEARANCE,
  DISTANCE_AT_FULL_SCALE,
  DISTANCE_AT_ZERO_HOLDERS,
  HOLDERS_AT_FULL_SCALE,
  HolderDistance,
  PEAK_DISTANCE_SLACK,
  distanceForHolders,
  targetDistance,
} from "../lib/gl/holders";
import { SceneDirector } from "../lib/gl/SceneDirector";
import {
  ANNOUNCE_AT,
  ANNOUNCE_END,
  EVENT_SECONDS,
  OVERSHOOT_PEAK,
  PUSH_FRACTION,
  RIPPLE_SECONDS,
  SETTLED_AT,
  announceOpacity,
  evaluateEvent,
} from "../lib/gl/TierEvent";
import { TIER_LERP_SECONDS, VisualState } from "../lib/gl/VisualState";
import type { Stats } from "../lib/statsTypes";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

/** A payload with everything the renderer does not read held at a sane value. */
function stats(partial: Partial<Stats> = {}): Stats {
  return {
    liveMarketCapUsd: 0,
    liveHolders: 0,
    peakMarketCapUsd: 0,
    peakHolders: 0,
    tierIndex: 0,
    priceUsd: 0,
    solUsd: 150,
    graduated: false,
    bondingProgress: 0,
    source: "curve",
    updatedAt: Date.now(),
    degraded: false,
    ...partial,
  };
}

function advance(step: (dt: number) => void, seconds: number, dt = 1 / 60): void {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i += 1) step(dt);
}

console.log("--- the holder mapping ---");

check(
  "zero holders is the far end of the orbit",
  distanceForHolders(0) === DISTANCE_AT_ZERO_HOLDERS,
  `${distanceForHolders(0)} rs`,
);
check(
  "100k holders is the near end",
  Math.abs(distanceForHolders(HOLDERS_AT_FULL_SCALE) - DISTANCE_AT_FULL_SCALE) < 1e-9,
  `${distanceForHolders(HOLDERS_AT_FULL_SCALE).toFixed(4)} rs`,
);
check(
  "beyond 100k holders the mapping is clamped, not extrapolated",
  distanceForHolders(50_000_000) === DISTANCE_AT_FULL_SCALE,
);

// The whole reason for a log scale: the first thousand holders have to matter.
// On a linear map they would move the camera by 0.165 rs out of 16.5.
const atThousand = distanceForHolders(1_000);
const linearAtThousand = DISTANCE_AT_ZERO_HOLDERS - (16.5 * 1_000) / HOLDERS_AT_FULL_SCALE;
check(
  "the first 1000 holders move the camera most of the way in",
  atThousand < 13 && linearAtThousand > 21,
  `log ${atThousand.toFixed(2)} rs vs linear ${linearAtThousand.toFixed(2)} rs`,
);

let monotone = true;
let previous = Number.POSITIVE_INFINITY;
for (let holders = 0; holders <= 200_000; holders += 137) {
  const d = distanceForHolders(holders);
  if (d > previous + 1e-12) monotone = false;
  previous = d;
}
check("the mapping never increases as holders rise", monotone);

console.log("\n--- the peak floor ---");

const floored = targetDistance(0, HOLDERS_AT_FULL_SCALE);
check(
  "a total holder wipeout still cannot pass the peak slack",
  Math.abs(floored - DISTANCE_AT_FULL_SCALE * PEAK_DISTANCE_SLACK) < 1e-9,
  `${floored.toFixed(4)} rs vs ceiling ${(DISTANCE_AT_FULL_SCALE * PEAK_DISTANCE_SLACK).toFixed(4)}`,
);
check(
  "the hole stays at least ~87% of its peak apparent size",
  DISTANCE_AT_FULL_SCALE / floored > 0.86,
  `${((DISTANCE_AT_FULL_SCALE / floored) * 100).toFixed(1)}% of peak size`,
);
check(
  "the floor does not hold the camera closer than the live count asks",
  targetDistance(10, 10) === distanceForHolders(10),
);

console.log("\n--- the asymmetric spring ---");

// Rising: holders up, camera in, 2.5s time constant. A critically damped step
// response covers 1 - 4e^-3 = 80.1% of its distance in three time constants.
const rising = new HolderDistance();
rising.setHolders(0, 0);
const riseSpan = DISTANCE_AT_ZERO_HOLDERS - DISTANCE_AT_FULL_SCALE;
rising.setHolders(HOLDERS_AT_FULL_SCALE, HOLDERS_AT_FULL_SCALE);
advance((dt) => rising.update(dt), 7.5);
const risen = (DISTANCE_AT_ZERO_HOLDERS - rising.distance) / riseSpan;
check(
  "a rally covers ~80% of the move in three time constants (7.5s)",
  risen > 0.75 && risen < 0.86,
  `${(risen * 100).toFixed(1)}% after 7.5s`,
);

// Falling: the same move in the other direction, twenty-four times slower.
const falling = new HolderDistance();
falling.setHolders(HOLDERS_AT_FULL_SCALE, HOLDERS_AT_FULL_SCALE);
falling.setHolders(0, 0);
advance((dt) => falling.update(dt), 7.5);
const fallen = (falling.distance - DISTANCE_AT_FULL_SCALE) / riseSpan;
check(
  "a sell-off has barely started after the same 7.5s",
  fallen < 0.03,
  `${(fallen * 100).toFixed(2)}% after 7.5s`,
);
check(
  "the two directions differ by more than an order of magnitude",
  risen / Math.max(fallen, 1e-9) > 20,
  `rise/fall ratio ${(risen / Math.max(fallen, 1e-9)).toFixed(0)}x`,
);

// Critically damped means exactly this: it arrives and stops. A hole that
// sailed past its target and came back would read as a glitch, not as physics.
const noOvershoot = new HolderDistance();
noOvershoot.setHolders(0, 0);
noOvershoot.setHolders(HOLDERS_AT_FULL_SCALE, HOLDERS_AT_FULL_SCALE);
let overshot = false;
for (let frame = 0; frame < 60 * 40; frame += 1) {
  noOvershoot.update(1 / 60);
  if (noOvershoot.distance < DISTANCE_AT_FULL_SCALE - 1e-9) overshot = true;
}
check("the spring never overshoots its target", !overshot);
check(
  "and it does arrive",
  Math.abs(noOvershoot.distance - DISTANCE_AT_FULL_SCALE) < 0.01,
  `${noOvershoot.distance.toFixed(4)} rs after 40s`,
);

// The analytic step is exact for any dt, so this is equality to float noise
// rather than mere convergence — a numerically integrated spring would not
// manage this.
const slow = new HolderDistance();
const fast = new HolderDistance();
slow.setHolders(0, 0);
fast.setHolders(0, 0);
slow.setHolders(80_000, 80_000);
fast.setHolders(80_000, 80_000);
advance((dt) => slow.update(dt), 5, 1 / 30);
advance((dt) => fast.update(dt), 5, 1 / 240);
check(
  "30fps and 240fps agree on where the camera is after 5s",
  Math.abs(slow.distance - fast.distance) < 1e-6,
  `drift ${Math.abs(slow.distance - fast.distance).toExponential(2)} rs`,
);

const seeded = new HolderDistance();
seeded.setHolders(50_000, 50_000);
check(
  "the first payload snaps rather than animating in from 22 rs",
  Math.abs(seeded.distance - distanceForHolders(50_000)) < 1e-9,
  `${seeded.distance.toFixed(4)} rs before any update()`,
);

console.log("\n--- the tier-up timeline ---");

const atZero = evaluateEvent(0);
check("the ripple starts at t=0", atZero.rippleAmount === 1 && atZero.ripplePhase === 0);
check(
  "and is gone by 0.4s",
  evaluateEvent(RIPPLE_SECONDS).rippleAmount === 0 &&
    evaluateEvent(RIPPLE_SECONDS - 0.01).rippleAmount === 1,
);

let phaseMonotone = true;
let lastPhase = -1;
for (let t = 0; t < RIPPLE_SECONDS; t += 0.005) {
  const phase = evaluateEvent(t).ripplePhase;
  if (phase < lastPhase - 1e-9) phaseMonotone = false;
  lastPhase = phase;
}
check("the wavefront travels inward and never back out", phaseMonotone);

let peakBrightness = 0;
let peakBrightnessAt = 0;
let peakPush = 0;
for (let t = 0; t < EVENT_SECONDS; t += 0.005) {
  const frame = evaluateEvent(t);
  if (frame.brightness > peakBrightness) {
    peakBrightness = frame.brightness;
    peakBrightnessAt = t;
  }
  peakPush = Math.max(peakPush, frame.push);
}
check(
  "the disk overshoots to ~1.6x",
  Math.abs(peakBrightness - OVERSHOOT_PEAK) < 0.01,
  `${peakBrightness.toFixed(3)}x at ${peakBrightnessAt.toFixed(2)}s`,
);
check(
  "the overshoot peaks after the ripple has passed",
  peakBrightnessAt > RIPPLE_SECONDS,
  `peak at ${peakBrightnessAt.toFixed(2)}s`,
);
check(
  "the camera pushes in ~6%",
  Math.abs(peakPush - PUSH_FRACTION) < 0.001,
  `${(peakPush * 100).toFixed(2)}%`,
);

const settled = evaluateEvent(SETTLED_AT);
check(
  "everything transient has finished by 1.5s",
  settled.rippleAmount === 0 &&
    Math.abs(settled.brightness - 1) < 1e-6 &&
    Math.abs(settled.push) < 1e-6,
  `ripple ${settled.rippleAmount}, brightness ${settled.brightness.toFixed(6)}, push ${settled.push.toFixed(6)}`,
);

check("the HUD card is still hidden at 0.8s", announceOpacity(ANNOUNCE_AT) === 0);
check("the HUD card is fully up at 2.0s", announceOpacity(2) === 1);
check(
  "the HUD card holds for 3s before fading",
  announceOpacity(4.3) === 1 && announceOpacity(ANNOUNCE_END - 0.01) < 0.05,
  `4.3s ${announceOpacity(4.3).toFixed(3)}, ${(ANNOUNCE_END - 0.01).toFixed(2)}s ${announceOpacity(ANNOUNCE_END - 0.01).toFixed(3)}`,
);
check(
  "the card is gone before the six-second slot ends",
  ANNOUNCE_END < EVENT_SECONDS && announceOpacity(ANNOUNCE_END) === 0,
  `card ends at ${ANNOUNCE_END.toFixed(1)}s, slot at ${EVENT_SECONDS}s`,
);

console.log("\n--- the tier lerp ---");

const lerp = new VisualState(0);
lerp.setTier(1);
advance((dt) => lerp.update(dt), TIER_LERP_SECONDS + 0.1);
check(
  "a promotion settles within the brief's 3-5s window",
  TIER_LERP_SECONDS >= 3 &&
    TIER_LERP_SECONDS <= 5 &&
    Math.abs(lerp.read().diskOuterRadius - TIERS[1].diskOuterRadius) < 1e-6,
  `${TIER_LERP_SECONDS}s, radius ${lerp.read().diskOuterRadius.toFixed(4)} rs`,
);

// Ease-in-out: the midpoint of the CLOCK is the midpoint of the VALUE, and the
// first tenth of the clock covers far less than a tenth of the distance.
const eased = new VisualState(0);
eased.setTier(11);
advance((dt) => eased.update(dt), TIER_LERP_SECONDS * 0.1);
const early =
  (eased.read().diskOuterRadius - TIERS[0].diskOuterRadius) /
  (TIERS[11].diskOuterRadius - TIERS[0].diskOuterRadius);
advance((dt) => eased.update(dt), TIER_LERP_SECONDS * 0.4);
const half =
  (eased.read().diskOuterRadius - TIERS[0].diskOuterRadius) /
  (TIERS[11].diskOuterRadius - TIERS[0].diskOuterRadius);
check(
  "the ease starts slowly",
  early < 0.05,
  `${(early * 100).toFixed(1)}% of the way after 10% of the clock`,
);
check(
  "and is halfway at the halfway mark",
  Math.abs(half - 0.5) < 0.02,
  `${(half * 100).toFixed(1)}% at 50% of the clock`,
);

console.log("\n--- the director: tiers ratchet, holders breathe ---");

const promotions: number[] = [];
const director = new SceneDirector({ onPromote: (tier) => promotions.push(tier.index) });

director.applyStats(stats({ tierIndex: 4, liveHolders: 3_000, peakHolders: 3_000 }));
check(
  "the first payload adopts its tier silently — a page load is not an unlock",
  promotions.length === 0 && director.visualState.tier.index === 4,
  `tier ${director.visualState.tier.index}, ${promotions.length} events`,
);
check(
  "and lands at the tier table's values immediately, with no opening animation",
  Math.abs(director.readScene().diskBrightness - TIERS[4].diskBrightness) < 1e-9,
);

director.applyStats(stats({ tierIndex: 1, liveHolders: 3_000, peakHolders: 3_000 }));
director.update(1 / 60);
check(
  "a payload with a LOWER tier cannot demote anything",
  director.visualState.tier.index === 4 && promotions.length === 0,
  `tier ${director.visualState.tier.index}`,
);

// A rally across several thresholds between two five-second polls.
director.applyStats(stats({ tierIndex: 7, liveHolders: 3_000, peakHolders: 3_000 }));
director.update(1 / 60);
check(
  "three thresholds crossed at once queue three separate events",
  promotions.length === 1 && promotions[0] === 5 && director.summary().queued === 2,
  `played ${promotions.join(",")}, ${director.summary().queued} queued`,
);

// Six seconds later, and not a moment before.
advance((dt) => director.update(dt), EVENT_SECONDS - 0.2);
check(
  "the second event has not started early",
  promotions.length === 1,
  `played ${promotions.join(",")}`,
);
advance((dt) => director.update(dt), 0.4);
check("the second event starts when the slot frees", promotions.length === 2 && promotions[1] === 6);

advance((dt) => director.update(dt), EVENT_SECONDS);
check(
  "all three play, in order, and the tier arrives at 7",
  promotions.join(",") === "5,6,7" && director.visualState.tier.index === 7,
  `played ${promotions.join(",")}, tier ${director.visualState.tier.index}`,
);

// Never two at once: the ripple is the tell, because it is the only cue short
// enough that an overlap would show as two of them inside one event.
const overlapCheck = new SceneDirector();
overlapCheck.applyStats(stats({ tierIndex: 0 }));
overlapCheck.applyStats(stats({ tierIndex: 11 }));
let rippleRuns = 0;
let wasRippling = false;
for (let frame = 0; frame < 60 * 75; frame += 1) {
  overlapCheck.update(1 / 60);
  const rippling = overlapCheck.readRipple().amount > 0;
  if (rippling && !wasRippling) rippleRuns += 1;
  wasRippling = rippling;
}
check(
  "eleven queued promotions produce exactly eleven separate ripples",
  rippleRuns === 11 && overlapCheck.visualState.tier.index === 11,
  `${rippleRuns} ripples, tier ${overlapCheck.visualState.tier.index}`,
);

console.log("\n--- the director: degraded means frozen ---");

let frozenEvents = 0;
const frozenDirector = new SceneDirector({ onPromote: () => (frozenEvents += 1) });

frozenDirector.applyStats(stats({ tierIndex: 3, liveHolders: 5_000, peakHolders: 5_000 }));
advance((dt) => frozenDirector.update(dt), 1);
const beforeBadData = frozenDirector.summary();

frozenDirector.applyStats(
  stats({ tierIndex: 9, liveHolders: 90_000, peakHolders: 90_000, degraded: true }),
);
advance((dt) => frozenDirector.update(dt), 8);
const afterBadData = frozenDirector.summary();

check(
  "a degraded payload promotes nothing, however high its tier",
  frozenEvents === 0 && afterBadData.tierIndex === 3,
  `tier ${afterBadData.tierIndex}, ${frozenEvents} events`,
);
check(
  "a degraded payload moves no holder target",
  afterBadData.liveHolders === beforeBadData.liveHolders &&
    Math.abs(afterBadData.cameraDistance - beforeBadData.cameraDistance) < 1e-6,
  `${afterBadData.liveHolders} holders, ${afterBadData.cameraDistance.toFixed(4)} rs`,
);
check("and it is flagged for the HUD", afterBadData.degraded);

frozenDirector.applyStats(stats({ tierIndex: 4, liveHolders: 6_000, peakHolders: 6_000 }));
frozenDirector.update(1 / 60);
check(
  "a good payload resumes normal service",
  !frozenDirector.summary().degraded && frozenEvents === 1,
  `${frozenEvents} events`,
);

const bornDegraded = new SceneDirector();
bornDegraded.applyStats(stats({ tierIndex: 6, liveHolders: 2_000, degraded: true }));
check(
  "a session whose FIRST payload is degraded still renders it, flagged",
  bornDegraded.summary().hasData &&
    bornDegraded.summary().degraded &&
    bornDegraded.visualState.tier.index === 6,
  `tier ${bornDegraded.visualState.tier.index}`,
);

console.log("\n--- the director: the camera never enters its own disk ---");

let insideDisk = 0;
let closest = Number.POSITIVE_INFINITY;
for (let tier = 0; tier <= 11; tier += 1) {
  for (const holders of [0, 100, 2_500, 25_000, 100_000]) {
    const probe = new SceneDirector();
    probe.applyStats(stats({ tierIndex: tier, liveHolders: holders, peakHolders: holders }));
    advance((dt) => probe.update(dt), 30);
    const distance = probe.readCamera().distance;
    const radius = probe.readScene().diskOuterRadius;
    closest = Math.min(closest, distance / radius);
    if (distance <= radius) insideDisk += 1;
  }
}
check(
  "no tier and holder combination puts the camera inside the disk",
  insideDisk === 0 && closest >= CAMERA_DISK_CLEARANCE - 1e-6,
  `closest approach ${closest.toFixed(3)}x the disk radius (clearance ${CAMERA_DISK_CLEARANCE})`,
);

// At the bottom of the tier table the clamp is slack enough that the brief's
// mapping runs untouched — which is the whole justification for it.
const tierZero = new SceneDirector();
tierZero.applyStats(
  stats({ tierIndex: 0, liveHolders: HOLDERS_AT_FULL_SCALE, peakHolders: HOLDERS_AT_FULL_SCALE }),
);
tierZero.update(1 / 60);
check(
  "at tier 0 the clearance clamp never engages",
  Math.abs(tierZero.readCamera().distance - DISTANCE_AT_FULL_SCALE) < 1e-6,
  `${tierZero.readCamera().distance.toFixed(4)} rs at 100k holders`,
);

// Both channels have to push the same way, or a rally reads as two unrelated
// effects that happened to coincide.
const growth = new SceneDirector();
growth.applyStats(stats({ tierIndex: 5, liveHolders: 50, peakHolders: 50 }));
growth.update(1 / 60);
const small = growth.readScene().diskOuterRadius / growth.readCamera().distance;
growth.applyStats(stats({ tierIndex: 5, liveHolders: 60_000, peakHolders: 60_000 }));
advance((dt) => growth.update(dt), 60);
const large = growth.readScene().diskOuterRadius / growth.readCamera().distance;
check(
  "holders make the hole visibly larger in frame",
  large > small * 1.8,
  `apparent size ${small.toFixed(3)} -> ${large.toFixed(3)} (${(large / small).toFixed(2)}x)`,
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
