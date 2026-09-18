/**
 * DEMO MODE — a deterministic simulated feed.
 *
 * Deterministic in the strict sense: a pure function of wall-clock time, with
 * no stored state and no RNG seed carried between calls. Two browsers hitting
 * the route in the same second see the same numbers, a redeploy does not jump
 * the simulation, and a bug is reproducible by passing the timestamp back in.
 *
 * The feed runs on a 45-minute cycle that climbs the whole tier table, from
 * ~$2K to ~$12M on a log ramp, so every one of the twelve tier-up transitions
 * is exercised once per cycle. Within that ramp the market cap moves in bursts
 * with pullbacks, and holders perform a random walk with occasional bursts and
 * gentler pullbacks.
 *
 * The pullbacks are the point: they must never lower a tier. They do not,
 * because tiers come from the sustain-guarded peak in `lib/peaks.ts` and never
 * from the live value below — the simulator does not need to be careful, the
 * ratchet does.
 *
 * At the end of a cycle the LIVE values wrap back to the bottom of the ramp
 * while the peaks stay where they got to. That is the intended behaviour and
 * the reason `?resetPeak=1` exists.
 */

import { TOTAL_SUPPLY } from "@/config/token";

const CYCLE_MS = 45 * 60 * 1_000;

const RAMP_START_USD = 2_000;
const RAMP_END_USD = 12_000_000;

/** Live market cap at which the simulated bonding curve completes. */
const DEMO_GRADUATION_MCAP = 69_000;

// ---------------------------------------------------------------------------
// Deterministic value noise
// ---------------------------------------------------------------------------

/** Integer hash -> [0, 1). A mulberry32 round; cheap and well distributed. */
function hash01(input: number): number {
  let x = (input | 0) + 0x6d2b79f5;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

/** Smooth 1-D value noise in [0, 1). */
function noise(x: number): number {
  const cell = Math.floor(x);
  const t = x - cell;
  // Smoothstep, so the curve has no velocity discontinuity at lattice points.
  const eased = t * t * (3 - 2 * t);
  return hash01(cell) * (1 - eased) + hash01(cell + 1) * eased;
}

/** Layered noise, for the small-scale jitter of a live feed. */
function fbm(x: number): number {
  return noise(x) * 0.6 + noise(x * 2.7 + 11.3) * 0.3 + noise(x * 6.1 + 41.9) * 0.1;
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

export interface DemoSample {
  readonly marketCapUsd: number;
  readonly holders: number;
  readonly priceUsd: number;
  readonly solUsd: number;
  /** Position within the current cycle, 0..1. Useful when debugging. */
  readonly cycleProgress: number;
}

/** The simulated feed at an instant. Pure. */
export function demoSample(now: number): DemoSample {
  const cycleProgress = ((now % CYCLE_MS) + CYCLE_MS) % CYCLE_MS / CYCLE_MS;
  const seconds = now / 1_000;

  // --- market cap: log ramp, bursts up, pullbacks down ----------------------
  const lo = Math.log10(RAMP_START_USD);
  const hi = Math.log10(RAMP_END_USD);
  const ramp = 10 ** (lo + cycleProgress * (hi - lo));

  // High powers make these rare rather than constant — most of the time both
  // multipliers sit near 1 and the ramp shows through.
  const burst = 1 + 1.1 * noise(cycleProgress * 13 + 3.1) ** 6;
  const pullback = 1 - 0.4 * noise(cycleProgress * 8 + 17.7) ** 3;
  const jitter = 1 + 0.07 * (fbm(seconds / 45) - 0.5) * 2;

  const marketCapUsd = Math.max(500, ramp * burst * pullback * jitter);

  // --- holders: random walk, bursty up, gentle down -------------------------
  const holderBase = 25 + 5_200 * cycleProgress ** 1.35;
  const holderBurst = 1 + 1.6 * noise(cycleProgress * 9 + 5.5) ** 7;
  // Shallower and shallower-powered than the market cap pullback: holders leave
  // slowly and in smaller proportions than price falls.
  const holderPullback = 1 - 0.14 * noise(cycleProgress * 6 + 29.3) ** 2;
  const holderWalk = 1 + 0.06 * (fbm(seconds / 90 + 7.7) - 0.5) * 2;

  const holders = Math.max(1, Math.round(holderBase * holderBurst * holderPullback * holderWalk));

  // A plausible, slowly drifting SOL price. Labelled `demo` in the payload —
  // nothing downstream mistakes it for a quote.
  const solUsd = 150 + 40 * (fbm(seconds / 600 + 3.3) - 0.5) * 2;

  return {
    marketCapUsd,
    holders,
    priceUsd: marketCapUsd / TOTAL_SUPPLY,
    solUsd,
    cycleProgress,
  };
}

/**
 * Simulated bonding curve state, derived from the PEAK market cap rather than
 * the live one.
 *
 * Graduation is a one-way event on chain, so it has to be one-way here too —
 * driving it from the live value would let a demo pullback un-graduate the
 * token, which is exactly the class of reversal this project forbids.
 */
export function demoCurveState(peakMarketCapUsd: number): {
  graduated: boolean;
  bondingProgress: number;
} {
  const progress = Math.min(1, Math.max(0, peakMarketCapUsd / DEMO_GRADUATION_MCAP));
  return { graduated: progress >= 1, bondingProgress: progress };
}
