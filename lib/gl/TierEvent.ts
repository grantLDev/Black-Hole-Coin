/**
 * THE TIER-UP EVENT — six seconds of deliberate choreography, fired once per
 * promotion and never overlapping another.
 *
 * A tier is the only thing on this site that is genuinely an achievement, and
 * the one visual language the design has for saying so is this event. It is
 * written as a timeline of pure functions of one clock rather than as a set of
 * tweens with their own state, for two reasons: a timeline can be evaluated at
 * an arbitrary instant (which is what makes it screenshot-testable and what
 * `?event=` pins), and it cannot drift out of phase with itself.
 *
 *   0.0s  RIPPLE       a radial displacement pulse sweeps inward, 0.4s.
 *   0.3s  OVERSHOOT    disk brightness rises to ~1.6x and settles back.
 *   0.5s  PUSH         the camera pushes in 6% and eases back out.
 *   0.8s  ANNOUNCE     tier name and threshold fade up, hold 3s, fade down.
 *   1.5s  SETTLED      every transient above is finished. What is left is the
 *                      4s ease-in-out of the tier values themselves, which
 *                      started at 0.0 and runs underneath the whole event.
 *   6.0s  END          the slot is free and the next queued promotion starts.
 *
 * The six-second slot is longer than anything in it because it is the
 * NON-OVERLAP guarantee, not a duration: the HUD card is still fading down at
 * 5.0s, and a second ripple landing on top of it would read as one confused
 * event rather than two milestones.
 *
 * WHY PROMOTIONS ARE QUEUED AND WALKED ONE AT A TIME. A token that goes from
 * $9k to $260k between two five-second polls has crossed seven thresholds, and
 * the data layer will hand over `tierIndex: 7` in a single payload. Playing one
 * event and jumping seven tiers throws away six milestones the holder earned;
 * playing seven at once is a strobe. The queue plays them in order, six seconds
 * apart, and the tier values lerp one step at a time underneath — so a
 * seven-tier rally is a 42-second climb, which is the correct amount of drama
 * for having multiplied the market cap by twenty-six.
 *
 * THERE IS NO DEMOTION EVENT IN THIS FILE and there is no code path that would
 * call one. Promotion is the only direction that exists.
 */

import { TIERS, type Tier } from "@/config/tiers";

/** Total slot length. Nothing else starts until this expires. */
export const EVENT_SECONDS = 6;

// ---- 0.0s: the gravitational-wave ripple ------------------------------------
export const RIPPLE_AT = 0;
export const RIPPLE_SECONDS = 0.4;

// ---- 0.3s: the disk brightness overshoot ------------------------------------
export const OVERSHOOT_AT = 0.3;
/** Peak multiplier on the tier's disk brightness. */
export const OVERSHOOT_PEAK = 1.6;
/** Time from `OVERSHOOT_AT` to the peak. Sharp: this is the flash. */
export const OVERSHOOT_RISE_SECONDS = 0.25;
/** Time from the peak back to 1.0. Slow: this is the settle. */
export const OVERSHOOT_FALL_SECONDS = 0.95;

// ---- 0.5s: the camera push --------------------------------------------------
export const PUSH_AT = 0.5;
/** Fraction of the camera distance the push removes at its deepest. */
export const PUSH_FRACTION = 0.06;
export const PUSH_IN_SECONDS = 0.35;
export const PUSH_OUT_SECONDS = 0.65;

// ---- 0.8s: the HUD announcement ---------------------------------------------
export const ANNOUNCE_AT = 0.8;
export const ANNOUNCE_FADE_SECONDS = 0.6;
export const ANNOUNCE_HOLD_SECONDS = 3;
/** When the card is gone. 0.8 + 0.6 + 3.0 + 0.6 = 5.0s. */
export const ANNOUNCE_END =
  ANNOUNCE_AT + ANNOUNCE_FADE_SECONDS + ANNOUNCE_HOLD_SECONDS + ANNOUNCE_FADE_SECONDS;

/** The moment every transient above has finished. Asserted in verify-feed. */
export const SETTLED_AT = 1.5;

/** Longest step the clock will integrate. Mirrors VisualState and the spring. */
const MAX_STEP_SECONDS = 0.25;

/** The standard 3t^2 - 2t^3 ease, clamped. */
function easeInOut(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * (3 - 2 * x);
}

/** What the event contributes to the frame at one instant. */
export interface TierEventFrame {
  /**
   * Ripple intensity, 0..1. Zero outside the 0.4s window, which is what lets
   * the shader skip the displacement entirely on every other frame.
   */
  readonly rippleAmount: number;
  /** 0..1 as the wavefront travels from outside the frame to the centre. */
  readonly ripplePhase: number;
  /** Multiplier on the tier's disk brightness. 1.0 when nothing is playing. */
  readonly brightness: number;
  /** Fraction of the camera distance the push is currently removing, 0..0.06. */
  readonly push: number;
}

/** A frame with nothing playing. Shared, immutable, allocated once. */
const IDLE: TierEventFrame = { rippleAmount: 0, ripplePhase: 0, brightness: 1, push: 0 };

/**
 * Evaluate the whole timeline at `t` seconds from the start of the event.
 *
 * Pure. Every channel is written as `elapsed since its own start`, so moving
 * one cue does not require re-deriving the others.
 */
export function evaluateEvent(t: number): TierEventFrame {
  if (!Number.isFinite(t) || t < 0 || t >= EVENT_SECONDS) return IDLE;

  // ---- ripple -------------------------------------------------------------
  const rippleT = (t - RIPPLE_AT) / RIPPLE_SECONDS;
  const inRipple = rippleT >= 0 && rippleT < 1;
  // Full amplitude throughout: the wave packet in the shader enters from
  // beyond the frame corner and leaves through the centre, so it ramps itself
  // in and out geometrically. An amplitude envelope on top of that would
  // squash the wavefront just as it reached the middle, which is where it is
  // supposed to be sharpest.
  const rippleAmount = inRipple ? 1 : 0;
  const ripplePhase = inRipple ? rippleT : 0;

  // ---- brightness overshoot ----------------------------------------------
  const overshootT = t - OVERSHOOT_AT;
  let brightness = 1;
  if (overshootT >= 0 && overshootT < OVERSHOOT_RISE_SECONDS + OVERSHOOT_FALL_SECONDS) {
    const shape =
      overshootT < OVERSHOOT_RISE_SECONDS
        ? easeInOut(overshootT / OVERSHOOT_RISE_SECONDS)
        : 1 - easeInOut((overshootT - OVERSHOOT_RISE_SECONDS) / OVERSHOOT_FALL_SECONDS);
    brightness = 1 + (OVERSHOOT_PEAK - 1) * shape;
  }

  // ---- camera push --------------------------------------------------------
  const pushT = t - PUSH_AT;
  let push = 0;
  if (pushT >= 0 && pushT < PUSH_IN_SECONDS + PUSH_OUT_SECONDS) {
    const shape =
      pushT < PUSH_IN_SECONDS
        ? easeInOut(pushT / PUSH_IN_SECONDS)
        : 1 - easeInOut((pushT - PUSH_IN_SECONDS) / PUSH_OUT_SECONDS);
    push = PUSH_FRACTION * shape;
  }

  return { rippleAmount, ripplePhase, brightness, push };
}

/**
 * HUD card opacity at `t` seconds into the event, 0..1.
 *
 * Kept here rather than in CSS so the card and the shader read the same clock.
 * A CSS animation would run on its own timeline and would drift from the
 * renderer's the moment a frame ran long or the tab was backgrounded mid-event.
 */
export function announceOpacity(t: number): number {
  if (!Number.isFinite(t) || t < ANNOUNCE_AT || t >= ANNOUNCE_END) return 0;
  const since = t - ANNOUNCE_AT;
  if (since < ANNOUNCE_FADE_SECONDS) return easeInOut(since / ANNOUNCE_FADE_SECONDS);
  if (since < ANNOUNCE_FADE_SECONDS + ANNOUNCE_HOLD_SECONDS) return 1;
  const out = since - ANNOUNCE_FADE_SECONDS - ANNOUNCE_HOLD_SECONDS;
  return 1 - easeInOut(out / ANNOUNCE_FADE_SECONDS);
}

/**
 * The promotion queue.
 *
 * Holds the tiers that have been earned but not yet announced, runs one event
 * at a time, and fires `onPromote` at the instant each event starts — which is
 * the moment the rest of the renderer is told to move to that tier, so the
 * ripple and the tier lerp begin on the same frame.
 */
export class TierEventQueue {
  /** Highest tier this queue has STARTED an event for. Only ever rises. */
  private announced: number;
  /** Tier indices waiting for a slot, ascending, no gaps. */
  private readonly pending: number[] = [];

  private activeTier: number | null = null;
  private clock = 0;
  /** Set by `pinClock`; freezes the timeline for reproducible captures. */
  private pinned: number | null = null;

  private readonly onPromote: (tier: Tier) => void;

  constructor(startTier: number, onPromote: (tier: Tier) => void) {
    this.announced = clampTier(startTier);
    this.onPromote = onPromote;
  }

  /** The tier whose event is currently playing, or null between events. */
  get current(): Tier | null {
    return this.activeTier === null ? null : TIERS[this.activeTier];
  }

  /** Seconds into the active event, or 0 when nothing is playing. */
  get elapsed(): number {
    return this.activeTier === null ? 0 : this.clock;
  }

  /** Promotions earned but not yet started. */
  get queued(): number {
    return this.pending.length;
  }

  /** The highest tier an event has been started for. Never decreases. */
  get announcedTier(): number {
    return this.announced;
  }

  /**
   * Record that the feed has reached `index`, queueing one event per step.
   *
   * Ratcheted twice over: `index` below `announced` is ignored outright, and
   * the loop only ever counts upward. There is no argument to this method that
   * can lower anything.
   */
  promoteTo(index: number): void {
    const target = clampTier(index);
    const highest = this.announced + this.pending.length;
    for (let step = highest + 1; step <= target; step += 1) this.pending.push(step);
  }

  /**
   * Skip the choreography and adopt `index` silently.
   *
   * For the first payload of a session. A page load is not an unlock: someone
   * arriving at a site that is already at tier 7 has not just earned tier 7,
   * and playing seven events at them would be a lie told in a very expensive
   * way. Also drains anything queued, so this cannot leave a stale event to
   * fire later.
   */
  adopt(index: number): void {
    const target = clampTier(index);
    if (target > this.announced) this.announced = target;
    this.pending.length = 0;
    this.activeTier = null;
    this.clock = 0;
  }

  /**
   * Pin the active event's clock, or pass null to resume.
   *
   * Debug only, for `?event=`. A still of a 0.4s ripple is otherwise a matter
   * of luck, and the ripple is the one part of this file a screenshot can
   * actually check.
   */
  pinClock(seconds: number | null): void {
    this.pinned = seconds;
  }

  /** Advance the timeline. Starts the next queued event when a slot opens. */
  update(deltaSeconds: number): void {
    if (this.pinned !== null) {
      if (this.activeTier === null) this.startNext();
      this.clock = this.pinned;
      return;
    }

    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      if (this.activeTier === null) this.startNext();
      return;
    }

    if (this.activeTier !== null) {
      // Clamped like every other integrator here: a tab hidden for a minute
      // must not silently consume ten queued promotions in one frame.
      this.clock += Math.min(deltaSeconds, MAX_STEP_SECONDS);
      if (this.clock < EVENT_SECONDS) return;
      this.activeTier = null;
      this.clock = 0;
    }

    this.startNext();
  }

  /** Everything the frame needs from the active event. */
  read(): TierEventFrame {
    return this.activeTier === null ? IDLE : evaluateEvent(this.clock);
  }

  /** HUD card opacity for the active event, 0..1. */
  readAnnounceOpacity(): number {
    return this.activeTier === null ? 0 : announceOpacity(this.clock);
  }

  private startNext(): void {
    const next = this.pending.shift();
    if (next === undefined) return;
    this.activeTier = next;
    this.announced = next;
    this.clock = 0;
    this.onPromote(TIERS[next]);
  }
}

function clampTier(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.round(index), 0), TIERS.length - 1);
}
