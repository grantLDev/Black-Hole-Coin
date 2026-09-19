/**
 * The HOLDER channel: continuous, live, asymmetric, and floored at the peak.
 *
 * This is the only genuinely live input in the whole renderer. Tiers are
 * achievements and ratchet forward; holders are a thermometer — except that
 * even the thermometer is not allowed to fall all the way back, which is the
 * same "nothing un-unlocks" principle applied to a continuous quantity instead
 * of a discrete one.
 *
 * THREE RULES, and every one of them is load-bearing:
 *
 *  1. THE MAPPING IS LOGARITHMIC. 0 holders puts the camera at 22 rs, 100k
 *     puts it at 5.5. Linear would be useless: the interesting range of a
 *     token launch is the first few thousand holders, and on a linear scale
 *     every one of those sits within 3% of the far end. On a log scale the
 *     first thousand holders move the camera two thirds of the way in, which
 *     is where the drama actually is.
 *
 *  2. THE SPRING IS ASYMMETRIC. Holders rising pulls the camera in on a 2.5s
 *     time constant — fast enough to feel like the hole is breathing in.
 *     Holders falling eases it back out on 60s, which is twenty-four times
 *     slower. A sell-off is supposed to read as the hole relaxing, not as it
 *     collapsing, and the only thing separating those two readings is how
 *     long the move takes.
 *
 *  3. THE TARGET IS FLOORED AT THE PEAK. `distanceAtPeak * 1.15` is a hard
 *     ceiling on the distance, so the hole can never look smaller than about
 *     87% of its all-time-peak size however far the holder count falls. The
 *     ceiling is computed from `stats.peakHolders`, which the data layer
 *     ratchets, so it only ever tightens.
 *
 * WHY A SECOND-ORDER SPRING AND NOT EXPONENTIAL SMOOTHING. `VisualState` uses
 * plain exponential smoothing on the tier values and that is right there: a
 * tier is a step and the smoother is a low-pass filter on a step. Holder count
 * is not a step — it moves continuously and in both directions — and a
 * first-order filter tracking a moving target lags it permanently and by an
 * amount proportional to the rate. A critically damped second-order spring
 * carries velocity, so it catches up rather than trailing, and critically
 * damped is precisely the "no overshoot, no oscillation" case. A hole that
 * bounces past its target and back would read as a glitch.
 *
 * The step below is the ANALYTIC solution of that spring, not a numerical
 * integration of it. `x(t) = target + (A + Bt)e^(-wt)` is exact for any step
 * size, so a 30fps phone and a 120fps laptop reach the same distance at the
 * same wall-clock moment — and, unlike semi-implicit Euler, it cannot go
 * unstable when a frame runs long.
 */

/** Camera distance in Schwarzschild radii at zero holders. */
export const DISTANCE_AT_ZERO_HOLDERS = 22;
/** Camera distance at `HOLDERS_AT_FULL_SCALE` holders and beyond. */
export const DISTANCE_AT_FULL_SCALE = 5.5;
/** Holder count at which the mapping bottoms out. */
export const HOLDERS_AT_FULL_SCALE = 100_000;

/**
 * How far past the all-time-peak distance the camera may ease back out.
 *
 * 1.15 on the DISTANCE is roughly 0.87 on apparent size, which is the brief's
 * "never smaller than ~87% of its peak". Expressed on distance rather than on
 * size because distance is what the spring integrates.
 */
export const PEAK_DISTANCE_SLACK = 1.15;

/** Time constant while holders are RISING and the camera is coming in. */
export const RISE_TAU_SECONDS = 2.5;
/** Time constant while holders are FALLING and the camera is easing out. */
export const FALL_TAU_SECONDS = 60;

/**
 * Disk outer radius at zero holders, as a fraction of the active tier's value.
 *
 * The tier table sets the CEILING on the disk and the holder count fills it —
 * see the header of `SceneDirector`. 0.70 is deep enough that the growth reads
 * as growth and shallow enough that a tier-0 disk at zero holders (4.0 * 0.70
 * = 2.8 rs) still clears the ISCO with room for the photon ring to sit inside
 * it.
 */
export const DISK_SCALE_AT_ZERO_HOLDERS = 0.7;

/**
 * Smallest ratio of camera distance to disk outer radius the director allows.
 *
 * THE ONE PLACE THE TWO CHANNELS HAVE TO BE RECONCILED. The brief's holder
 * mapping bottoms out at 5.5 rs and the tier-11 disk runs out to 11.5 rs, so
 * at the top of both tables the camera would sit well inside its own accretion
 * disk. The marcher handles that perfectly correctly and the picture is
 * useless: the disk wraps around the viewer and reads as a tunnel, and the
 * shadow it is meant to frame is behind it.
 *
 * 1.35 is the existing framing constant in disguise — the fixed camera this
 * replaced sat at 17 rs against a tier-11 disk of 11.5, a ratio of 1.48 — 
 * pulled in slightly so the live channel keeps as much travel as possible.
 * At tier 0 the clearance is 4.0 * 1.35 = 5.4 rs, which is BELOW the mapping's
 * closest approach of 5.5, so at the bottom of the tier table this clamp never
 * engages at all and the brief's mapping runs untouched end to end. It tightens
 * as the disk grows, which is the physically sensible direction: a bigger hole
 * cannot be approached as closely without swallowing the frame.
 */
export const CAMERA_DISK_CLEARANCE = 1.35;

/** Longest step the spring will integrate, in seconds. Mirrors VisualState. */
const MAX_STEP_SECONDS = 0.25;

/** Precomputed denominator of the log mapping. */
const LOG_SPAN = Math.log10(1 + HOLDERS_AT_FULL_SCALE);

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Camera distance in Schwarzschild radii for a holder count.
 *
 * Pure, monotonic and decreasing. Feed it the LIVE count for the target and
 * the PEAK count for the floor; it does not know or care which it was given.
 */
export function distanceForHolders(holders: number): number {
  if (!Number.isFinite(holders) || holders <= 0) return DISTANCE_AT_ZERO_HOLDERS;
  const t = clamp(Math.log10(1 + holders) / LOG_SPAN, 0, 1);
  return DISTANCE_AT_ZERO_HOLDERS + (DISTANCE_AT_FULL_SCALE - DISTANCE_AT_ZERO_HOLDERS) * t;
}

/**
 * The target distance for a live count, floored by the peak.
 *
 * This is the whole of rule 3 in one line, and it is deliberately applied to
 * the TARGET rather than to the spring's output. Clamping the output would
 * leave the spring integrating toward a value it is not allowed to reach,
 * which parks a permanent non-zero velocity against the clamp and makes the
 * hole twitch every time the holder count wobbles.
 */
export function targetDistance(liveHolders: number, peakHolders: number): number {
  const live = distanceForHolders(liveHolders);
  const ceiling = distanceForHolders(Math.max(peakHolders, 0)) * PEAK_DISTANCE_SLACK;
  return clamp(Math.min(live, ceiling), DISTANCE_AT_FULL_SCALE, DISTANCE_AT_ZERO_HOLDERS);
}

/**
 * 0 at the far end of the mapping, 1 at the near end.
 *
 * Derived from the SPRUNG distance rather than from the holder count, so
 * everything else the holder channel drives — the disk's outer radius above
 * all — inherits the asymmetric damping and the peak floor for free rather
 * than re-deriving them and drifting out of step.
 */
export function growthForDistance(distance: number): number {
  const span = DISTANCE_AT_ZERO_HOLDERS - DISTANCE_AT_FULL_SCALE;
  return clamp((DISTANCE_AT_ZERO_HOLDERS - distance) / span, 0, 1);
}

/** Disk outer radius multiplier for a growth value. See DISK_SCALE_AT_ZERO. */
export function diskScaleForGrowth(growth: number): number {
  return DISK_SCALE_AT_ZERO_HOLDERS + (1 - DISK_SCALE_AT_ZERO_HOLDERS) * clamp(growth, 0, 1);
}

/**
 * The asymmetric, floored, critically damped camera distance.
 *
 * Holds position and velocity; `setHolders` moves the target and `update`
 * integrates toward it. Nothing here can be driven backwards by a bad payload
 * — the caller simply stops calling `setHolders` — so there is no separate
 * freeze flag to get out of sync with the one in the director.
 */
export class HolderDistance {
  private current = DISTANCE_AT_ZERO_HOLDERS;
  private velocity = 0;
  private targetValue = DISTANCE_AT_ZERO_HOLDERS;
  private seeded = false;

  /** Current, smoothed distance in Schwarzschild radii. */
  get distance(): number {
    return this.current;
  }

  /** Where the spring is heading. Exposed for the debug overlay and tests. */
  get target(): number {
    return this.targetValue;
  }

  /** 0..1 along the mapping, derived from the smoothed distance. */
  get growth(): number {
    return growthForDistance(this.current);
  }

  /**
   * Aim at a live holder count, floored by the peak.
   *
   * The FIRST call snaps rather than springing. A page load is not a rally:
   * animating in from 22 rs on every refresh would turn the site's resting
   * state into a permanent opening titles sequence, and would also mean the
   * first few seconds after load showed a hole smaller than the data says.
   */
  setHolders(liveHolders: number, peakHolders: number): void {
    this.targetValue = targetDistance(liveHolders, peakHolders);
    if (this.seeded) return;
    this.seeded = true;
    this.current = this.targetValue;
    this.velocity = 0;
  }

  /** Whether a holder count has ever been supplied. */
  get hasData(): boolean {
    return this.seeded;
  }

  /**
   * Integrate one frame.
   *
   * The time constant is chosen from the DIRECTION of travel, which is the
   * asymmetry: a target below the current distance means holders rose and the
   * camera is coming in, and that gets 2.5s. Anything else gets 60s. Switching
   * tau mid-flight is safe precisely because the spring carries velocity — the
   * state is continuous across the switch, only the stiffness changes.
   */
  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const dt = Math.min(deltaSeconds, MAX_STEP_SECONDS);

    const tau = this.targetValue < this.current ? RISE_TAU_SECONDS : FALL_TAU_SECONDS;
    const omega = 1 / tau;

    // x(t) = target + (A + B t) e^(-w t), critically damped, solved exactly.
    const offset = this.current - this.targetValue;
    const b = this.velocity + omega * offset;
    const decay = Math.exp(-omega * dt);
    const shaped = offset + b * dt;

    this.current = this.targetValue + shaped * decay;
    this.velocity = (b - omega * shaped) * decay;
  }
}
