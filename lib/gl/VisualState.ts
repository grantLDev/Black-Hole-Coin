/**
 * The bridge between the tier table and the shader's uniforms.
 *
 * `config/tiers.ts` holds STEP values — a tier is a discrete achievement, and
 * the table is deliberately a step function. The shader needs continuous ones,
 * because snapping the disk from 6.0 to 6.6 rs in a single frame looks like a
 * bug rather than a milestone. This class is the low-pass filter between them,
 * and it is the only place in the renderer that knows tiers exist.
 *
 * Three invariants, all one-directional, all load-bearing:
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
 *  2. THE POST RATCHET, which falls out of the first one. Bloom strength,
 *     chromatic aberration and grain are read off the same tier index as the
 *     disk, so the ratchet above covers them at no extra cost: there is no
 *     path by which the bloom can dim or the aberration narrow. That is the
 *     whole reason the post chain is fed from here rather than straight from
 *     the data feed.
 *
 *  3. THE JET LATCH. Jets fade in over JET_FADE_SECONDS the first time tier 9
 *     is reached, and `jetUnlocked` then stays true forever. There is no code
 *     path that lowers `jetStrength` once it has begun to rise, including
 *     `setTier(0)`.
 *
 * INTERPOLATION IS A FIXED-DURATION EASE, NOT EXPONENTIAL SMOOTHING, and that
 * is a change from how this file started. An exponential never actually
 * arrives: `1 - exp(-dt/tau)` has no completion time, only a half-life, which
 * is fine for a filter and wrong for a piece of choreography. The brief asks
 * for the tier uniforms to travel over 3-5 seconds with ease-in-out, and the
 * tier-up event in `TierEvent.ts` is a timeline with cues at 0.3s, 0.5s, 0.8s
 * and 1.5s — those cues only mean anything if the move underneath them has a
 * known length to be measured against. So: a snapshot of where the values were
 * when the promotion landed, a progress clock, and `3t^2 - 2t^3` between them.
 *
 * Progress advances by `dt / TIER_LERP_SECONDS`, which is exactly frame-rate
 * independent — a 30fps phone and a 120fps laptop pass through the same value
 * at the same wall-clock instant, rather than merely converging to the same
 * place eventually.
 */

import {
  JET_TIER_INDEX,
  MAX_TIER_INDEX,
  TIERS,
  hexToLinearRgb,
  type Tier,
  type TierIndex,
} from "@/config/tiers";

/**
 * How long a promotion takes to travel from the old tier's values to the new
 * ones, in seconds.
 *
 * The brief's window is 3-5s and this sits in the middle of it. It is also
 * deliberately shorter than the 6s tier-up slot and longer than the 1.5s at
 * which every transient in that event has finished — so the last 2.5 seconds
 * of an unlock are nothing but the disk quietly arriving at its new size,
 * which is the part that should feel inevitable rather than staged.
 */
export const TIER_LERP_SECONDS = 4;

/** Jet fade-in duration, per the brief. One-directional. */
const JET_FADE_SECONDS = 4.0;

/** Longest step the smoother will integrate, in seconds. */
const MAX_STEP_SECONDS = 0.25;

export type Rgb = readonly [number, number, number];

/** Everything the scene fragment shader needs that is not camera or quality. */
export interface VisualUniformValues {
  readonly diskOuterRadius: number;
  readonly diskBrightness: number;
  readonly diskTurbulence: number;
  readonly diskColorInner: Rgb;
  readonly diskColorOuter: Rgb;
  readonly jetStrength: number;
}

/**
 * Everything the post chain's composite pass needs.
 *
 * Separate from `VisualUniformValues` because the post chain is optional — on
 * the low-quality path it does not exist — and because the two are consumed by
 * different passes. They come from the same tier and the same smoother, so
 * they can never disagree about which tier is showing.
 *
 * Every one of these is lerped, for the same reason the disk radius is: a
 * bloom that steps from 0.65 to 0.76 in one frame is a flash, and a flash on
 * an unlock is indistinguishable from a bug.
 */
export interface PostUniformValues {
  /** Bloom intensity. 0.25 at Protostar to 1.5 at Gargantua. */
  readonly bloomStrength: number;
  /** Radial RGB split. 0 at Protostar to 0.8 at Gargantua. */
  readonly chromaticAberration: number;
  /** Film grain amount. 0.06 at Protostar to 0.27 at Gargantua. */
  readonly grainAmount: number;
}

/** Camera shake, lerped with everything else and applied by `OrbitCamera`. */
export interface ShakeUniformValues {
  /** Peak offset in world units. 0 below tier 3. */
  readonly amplitude: number;
  /** Envelope frequency in Hz. Below 1 the shake is gated into tremors. */
  readonly frequency: number;
}

/**
 * The drone's parameters, lerped on the same clock as everything visible.
 *
 * Nothing in this renderer consumes these — the audio layer is Prompt 10 — but
 * they are interpolated here rather than later because the brief lists the
 * drone among the uniforms a promotion lerps, and because an audio engine that
 * re-derives its own tier transition from the raw feed would slide between
 * tiers on a different curve from the picture. One smoother, one timeline.
 */
export interface DroneValues {
  readonly rootHz: number;
  readonly dissonance: number;
  readonly shimmer: number;
}

/** Every scalar a promotion interpolates, in one bag. */
interface TierScalars {
  diskOuterRadius: number;
  diskBrightness: number;
  diskTurbulence: number;
  bloomStrength: number;
  chromaticAberration: number;
  grainAmount: number;
  shakeAmplitude: number;
  shakeFrequency: number;
  droneRootHz: number;
  droneDissonance: number;
  droneShimmer: number;
}

const SCALAR_KEYS = [
  "diskOuterRadius",
  "diskBrightness",
  "diskTurbulence",
  "bloomStrength",
  "chromaticAberration",
  "grainAmount",
  "shakeAmplitude",
  "shakeFrequency",
  "droneRootHz",
  "droneDissonance",
  "droneShimmer",
] as const satisfies readonly (keyof TierScalars)[];

function scalarsFor(tier: Tier): TierScalars {
  return {
    diskOuterRadius: tier.diskOuterRadius,
    diskBrightness: tier.diskBrightness,
    diskTurbulence: tier.diskTurbulence,
    bloomStrength: tier.bloomStrength,
    chromaticAberration: tier.chromaticAberration,
    grainAmount: tier.grainAmount,
    shakeAmplitude: tier.shakeAmplitude,
    shakeFrequency: tier.shakeFrequency,
    droneRootHz: tier.droneRootHz,
    droneDissonance: tier.droneDissonance,
    droneShimmer: tier.droneShimmer,
  };
}

function clampTierIndex(index: number): TierIndex {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.round(index), 0), MAX_TIER_INDEX) as TierIndex;
}

/** The standard 3t^2 - 2t^3 ease. Input is assumed already in 0..1. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export class VisualState {
  private tierIndex: TierIndex;

  /** Where every scalar stood when the current promotion landed. */
  private readonly from: TierScalars;
  /** The live, eased values pushed to the GPU. */
  private readonly now: TierScalars;

  /** Linear-light, not sRGB. See `hexToLinearRgb`. */
  private readonly fromColorInner: [number, number, number];
  private readonly fromColorOuter: [number, number, number];
  private readonly colorInner: [number, number, number];
  private readonly colorOuter: [number, number, number];

  /** 0..1 through the current promotion's ease. 1 when settled. */
  private progress = 1;

  /** Latched the first instant the jet tier is reached. Never cleared. */
  private jetUnlocked: boolean;
  /** 0..1 fade progress. Monotonically non-decreasing by construction. */
  private jetProgress: number;

  constructor(initialTier: number = 0) {
    this.tierIndex = clampTierIndex(initialTier);
    const tier = TIERS[this.tierIndex];

    // The first frame starts AT the target rather than easing up from zero.
    // A page load is not an unlock, and animating the disk open on every
    // refresh would turn a milestone into set dressing.
    this.from = scalarsFor(tier);
    this.now = scalarsFor(tier);
    this.fromColorInner = hexToLinearRgb(tier.diskColorInner);
    this.fromColorOuter = hexToLinearRgb(tier.diskColorOuter);
    this.colorInner = hexToLinearRgb(tier.diskColorInner);
    this.colorOuter = hexToLinearRgb(tier.diskColorOuter);

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

  /** True while a promotion's ease is still running. */
  get transitioning(): boolean {
    return this.progress < 1;
  }

  /**
   * Aim at a tier.
   *
   * Ratcheted: a lower index than the current one is ignored outright. See the
   * class comment for why the renderer keeps its own ratchet rather than
   * trusting the one in the data layer.
   *
   * `immediate` jumps rather than easing, for the first payload of a session —
   * the same reasoning as the constructor. It is NOT a way to skip an unlock:
   * the ratchet still applies and the jet still latches.
   */
  setTier(index: number, immediate = false): void {
    const next = clampTierIndex(index);
    if (next <= this.tierIndex) return;
    this.tierIndex = next;
    if (TIERS[next].hasJet) this.jetUnlocked = true;

    if (immediate) {
      Object.assign(this.now, scalarsFor(TIERS[next]));
      copyInto(this.colorInner, hexToLinearRgb(TIERS[next].diskColorInner));
      copyInto(this.colorOuter, hexToLinearRgb(TIERS[next].diskColorOuter));
      if (this.jetUnlocked) this.jetProgress = 1;
      this.progress = 1;
    }

    // The ease always starts from wherever the values actually are, not from
    // the previous tier's table row. A promotion landing mid-transition — the
    // queue makes that rare, not impossible — therefore stays continuous.
    Object.assign(this.from, this.now);
    copyInto(this.fromColorInner, this.colorInner);
    copyInto(this.fromColorOuter, this.colorOuter);
    this.progress = immediate ? 1 : 0;
  }

  /** Advance the ease by one frame. `deltaSeconds` is wall time. */
  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    // A tab that was hidden for a minute hands back a one-minute delta. Left
    // unclamped that would snap every value to its target, which is the
    // discontinuity this class exists to prevent.
    const dt = Math.min(deltaSeconds, MAX_STEP_SECONDS);

    // Linear ramp rather than exponential smoothing: "fades in over ~4
    // seconds" is a duration, and an exponential never actually arrives.
    if (this.jetUnlocked && this.jetProgress < 1) {
      this.jetProgress = Math.min(1, this.jetProgress + dt / JET_FADE_SECONDS);
    }

    if (this.progress >= 1) return;
    this.progress = Math.min(1, this.progress + dt / TIER_LERP_SECONDS);

    const target = TIERS[this.tierIndex];
    const k = smoothstep(this.progress);

    // Every scalar rides the same `k`, so an unlock is ONE event: the disk
    // widens and the bloom, aberration, grain, shake and drone all arrive with
    // it, rather than five effects on five schedules.
    const to = scalarsFor(target);
    for (const key of SCALAR_KEYS) {
      this.now[key] = this.from[key] + (to[key] - this.from[key]) * k;
    }

    lerpInto(this.colorInner, this.fromColorInner, hexToLinearRgb(target.diskColorInner), k);
    lerpInto(this.colorOuter, this.fromColorOuter, hexToLinearRgb(target.diskColorOuter), k);
  }

  /** Current eased values. Colours are borrowed, not copied — read only. */
  read(): VisualUniformValues {
    return {
      diskOuterRadius: this.now.diskOuterRadius,
      diskBrightness: this.now.diskBrightness,
      diskTurbulence: this.now.diskTurbulence,
      diskColorInner: this.colorInner,
      diskColorOuter: this.colorOuter,
      // Smoothstep on the linear ramp: the fade eases in and out of its four
      // seconds instead of switching on and off at constant rate.
      jetStrength: smoothstep(this.jetProgress),
    };
  }

  /** Current eased post-chain values. */
  readPost(): PostUniformValues {
    return {
      bloomStrength: this.now.bloomStrength,
      chromaticAberration: this.now.chromaticAberration,
      grainAmount: this.now.grainAmount,
    };
  }

  /** Current eased camera shake. Applied by `OrbitCamera`. */
  readShake(): ShakeUniformValues {
    return { amplitude: this.now.shakeAmplitude, frequency: this.now.shakeFrequency };
  }

  /** Current eased drone parameters. See `DroneValues`. */
  readDrone(): DroneValues {
    return {
      rootHz: this.now.droneRootHz,
      dissonance: this.now.droneDissonance,
      shimmer: this.now.droneShimmer,
    };
  }
}

/** In-place component lerp, so the per-frame path allocates nothing. */
function lerpInto(out: [number, number, number], from: Rgb, to: Rgb, k: number): void {
  out[0] = from[0] + (to[0] - from[0]) * k;
  out[1] = from[1] + (to[1] - from[1]) * k;
  out[2] = from[2] + (to[2] - from[2]) * k;
}

function copyInto(out: [number, number, number], source: Rgb): void {
  out[0] = source[0];
  out[1] = source[1];
  out[2] = source[2];
}

export { JET_FADE_SECONDS, JET_TIER_INDEX };
