/**
 * The bridge between the tier table and the shader's uniforms.
 *
 * `config/tiers.ts` holds STEP values — a tier is a discrete achievement, and
 * the table is deliberately a step function. The shader needs continuous ones,
 * because snapping the disk from 6.0 to 6.6 rs in a single frame looks like a
 * bug rather than a milestone. This class is the low-pass filter between them,
 * and it is the only place in the renderer that knows tiers exist.
 *
 * Two invariants, both one-directional, both load-bearing:
 *
 *  1. THE TIER RATCHET. `setTier` never accepts a lower index than it has
 *     already seen. The authoritative ratchet lives in the data layer, against
 *     the all-time-high market cap persisted in KV — this is a second, local
 *     one. That is not redundancy for its own sake: a stale poll, a failed
 *     request that degrades to a smaller last-known-good value, or a browser
 *     tab restored from bfcache with an old payload could each hand the
 *     renderer a lower tier than it is currently showing, and a visual that
 *     walks backwards is the one thing the whole design forbids. The cheapest
 *     place to make that impossible is here, at the last gate before the GPU.
 *
 *  2. THE JET LATCH. Jets fade in over JET_FADE_SECONDS the first time tier 9
 *     is reached, and `jetUnlocked` then stays true forever. There is no code
 *     path that lowers `jetStrength` once it has begun to rise, including
 *     `setTier(0)`.
 *
 * Interpolation is exponential smoothing with a frame-rate-independent
 * coefficient, `1 - exp(-dt / tau)`. The naive `x += (target - x) * k` form
 * converges at a speed that depends on frame rate, so the same unlock would
 * take twice as long at 30fps as at 60 — which is exactly the sort of thing
 * that gets tuned on a desktop and then feels broken on a phone.
 */

import {
  JET_TIER_INDEX,
  MAX_TIER_INDEX,
  TIERS,
  hexToLinearRgb,
  type Tier,
  type TierIndex,
} from "@/config/tiers";

/** Seconds for a tier change to travel roughly 63% of the way to its target. */
const TIER_LERP_TAU = 1.6;

/** Jet fade-in duration, per the brief. One-directional. */
const JET_FADE_SECONDS = 4.0;

/** Longest step the smoother will integrate, in seconds. */
const MAX_STEP_SECONDS = 0.25;

export type Rgb = readonly [number, number, number];

/** Everything the fragment shader needs that is not camera or quality. */
export interface VisualUniformValues {
  readonly diskOuterRadius: number;
  readonly diskBrightness: number;
  readonly diskTurbulence: number;
  readonly diskColorInner: Rgb;
  readonly diskColorOuter: Rgb;
  readonly jetStrength: number;
}

function clampTierIndex(index: number): TierIndex {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.round(index), 0), MAX_TIER_INDEX) as TierIndex;
}

export class VisualState {
  private tierIndex: TierIndex;

  private diskOuterRadius: number;
  private diskBrightness: number;
  private diskTurbulence: number;
  /** Linear-light, not sRGB. See `hexToLinearRgb`. */
  private readonly diskColorInner: [number, number, number];
  private readonly diskColorOuter: [number, number, number];

  /** Latched the first instant the jet tier is reached. Never cleared. */
  private jetUnlocked: boolean;
  /** 0..1 fade progress. Monotonically non-decreasing by construction. */
  private jetProgress: number;

  constructor(initialTier: number = 0) {
    this.tierIndex = clampTierIndex(initialTier);
    const tier = TIERS[this.tierIndex];

    // The first frame starts AT the target rather than smoothing up from zero.
    // A page load is not an unlock, and animating the disk open on every
    // refresh would turn a milestone into set dressing.
    this.diskOuterRadius = tier.diskOuterRadius;
    this.diskBrightness = tier.diskBrightness;
    this.diskTurbulence = tier.diskTurbulence;
    this.diskColorInner = hexToLinearRgb(tier.diskColorInner);
    this.diskColorOuter = hexToLinearRgb(tier.diskColorOuter);

    this.jetUnlocked = tier.hasJet;
    this.jetProgress = tier.hasJet ? 1 : 0;
  }

  get tier(): Tier {
    return TIERS[this.tierIndex];
  }

  /** True once the jet fade has started. Never returns to false. */
  get hasJet(): boolean {
    return this.jetUnlocked;
  }

  /**
   * Aim at a tier.
   *
   * Ratcheted: a lower index than the current one is ignored outright. See the
   * class comment for why the renderer keeps its own ratchet rather than
   * trusting the one in the data layer.
   */
  setTier(index: number): void {
    const next = clampTierIndex(index);
    if (next <= this.tierIndex) return;
    this.tierIndex = next;
    if (TIERS[next].hasJet) this.jetUnlocked = true;
  }

  /** Advance the smoothing by one frame. `deltaSeconds` is wall time. */
  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    // A tab that was hidden for a minute hands back a one-minute delta. Left
    // unclamped that would snap every value to its target, which is the
    // discontinuity this class exists to prevent.
    const dt = Math.min(deltaSeconds, MAX_STEP_SECONDS);

    const target = TIERS[this.tierIndex];
    const k = 1 - Math.exp(-dt / TIER_LERP_TAU);

    this.diskOuterRadius += (target.diskOuterRadius - this.diskOuterRadius) * k;
    this.diskBrightness += (target.diskBrightness - this.diskBrightness) * k;
    this.diskTurbulence += (target.diskTurbulence - this.diskTurbulence) * k;

    lerpInto(this.diskColorInner, hexToLinearRgb(target.diskColorInner), k);
    lerpInto(this.diskColorOuter, hexToLinearRgb(target.diskColorOuter), k);

    // Linear ramp rather than exponential smoothing: "fades in over ~4
    // seconds" is a duration, and an exponential never actually arrives.
    if (this.jetUnlocked && this.jetProgress < 1) {
      this.jetProgress = Math.min(1, this.jetProgress + dt / JET_FADE_SECONDS);
    }
  }

  /** Current smoothed values. Colours are borrowed, not copied — read only. */
  read(): VisualUniformValues {
    return {
      diskOuterRadius: this.diskOuterRadius,
      diskBrightness: this.diskBrightness,
      diskTurbulence: this.diskTurbulence,
      diskColorInner: this.diskColorInner,
      diskColorOuter: this.diskColorOuter,
      // Smoothstep on the linear ramp: the fade eases in and out of its four
      // seconds instead of switching on and off at constant rate.
      jetStrength: smoothstep(this.jetProgress),
    };
  }
}

/** In-place component lerp, so the per-frame path allocates nothing. */
function lerpInto(current: [number, number, number], target: Rgb, k: number): void {
  current[0] += (target[0] - current[0]) * k;
  current[1] += (target[1] - current[1]) * k;
  current[2] += (target[2] - current[2]) * k;
}

/** The standard 3t^2 - 2t^3 ease. Input is assumed already in 0..1. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export { JET_FADE_SECONDS, JET_TIER_INDEX };
