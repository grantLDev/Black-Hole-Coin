/**
 * Where the feed meets the renderer.
 *
 * `useStats` reports what the server said. `VisualState` eases tier values.
 * `HolderDistance` springs the camera. `TierEventQueue` runs the choreography.
 * This class is the only thing that knows about all four, and it exists so
 * that the frame loop in `Renderer` never has to.
 *
 * THE TWO CHANNELS ARE NOT SYMMETRIC, and keeping them apart is most of the
 * job here.
 *
 *   MARKET CAP -> TIER. Discrete, ratcheted, permanent. The index arrives
 *   already peak-derived from the server and is never recomputed from live
 *   market cap on this side. `TierEventQueue` walks it upward one promotion at
 *   a time; `VisualState` eases the uniforms; neither will accept a lower
 *   index than it has already seen. There is no demotion path in this file,
 *   this directory, or this project.
 *
 *   HOLDERS -> DISTANCE. Continuous, live, asymmetrically damped, and floored
 *   at the all-time peak. This is the only input that moves in both
 *   directions, and even it cannot walk all the way back — see `holders.ts`.
 *
 * HOW THE CHANNELS COMBINE ON THE DISK. The tier sets the disk's outer radius
 * and holders fill it: `tierRadius * lerp(0.70, 1.00, growth)`. Tier is the
 * ceiling, holders are how much of it is claimed. That makes both channels
 * push the same way — more holders is a bigger disk AND a closer camera — so
 * a rally reads as one motion rather than two effects that happen to coincide.
 *
 * THE CLEARANCE CLAMP is the one place the two tables genuinely conflict, and
 * it is worth being explicit about because it is the only rule here that
 * overrides a number the brief gives directly. The holder mapping bottoms out
 * at 5.5 rs; the tier-11 disk runs out to 11.5 rs. At the top of both tables
 * the camera would be inside its own accretion disk, which the marcher renders
 * perfectly correctly as a useless picture — a tunnel, with the shadow it
 * exists to frame somewhere behind the viewer. So the composed distance is
 * floored at `diskOuterRadius * CAMERA_DISK_CLEARANCE`. At tier 0 that floor
 * is 5.4 rs, below the mapping's own minimum, so it never engages and the
 * brief's 22 -> 5.5 runs end to end; it tightens as the disk grows, which is
 * the direction that makes physical sense.
 *
 * DEGRADED MEANS FROZEN. When `stats.degraded` is true every target in here
 * keeps its last known value: no new holder target, no promotion queued, no
 * event fired. The springs and eases already in flight continue to their
 * existing targets rather than being stopped dead, because halting an
 * integrator mid-move is itself a visible discontinuity — the point of
 * freezing is that bad data changes nothing, not that it causes a stop.
 *
 * The single exception is a session whose FIRST payload is already degraded.
 * There is no last known value to hold in that case, and refusing to render
 * anything would be worse than rendering the flagged numbers, so it seeds the
 * session and the HUD says so. That is not fabricating data; it is using the
 * only data there is and admitting it.
 */

import type { Tier } from "@/config/tiers";
import type { Stats } from "@/lib/statsTypes";
import {
  CAMERA_DISK_CLEARANCE,
  DISTANCE_AT_ZERO_HOLDERS,
  HolderDistance,
  diskScaleForGrowth,
} from "./holders";
import { TierEventQueue, type TierEventFrame } from "./TierEvent";
import {
  VisualState,
  type DroneValues,
  type PostUniformValues,
  type VisualUniformValues,
} from "./VisualState";

/** What the camera needs each frame. */
export interface CameraFrame {
  /** Composed, clamped orbit radius in Schwarzschild radii. */
  readonly distance: number;
  readonly shakeAmplitude: number;
  readonly shakeFrequency: number;
}

/** What the scene shader's ripple needs each frame. */
export interface RippleFrame {
  /** 0 on every frame outside a tier-up event's first 0.4 seconds. */
  readonly amount: number;
  /** 0..1 as the wavefront travels inward. */
  readonly phase: number;
}

/** Feed state for the debug overlay and the HUD. */
export interface FeedSummary {
  readonly tierIndex: number;
  /** Promotions earned and waiting for a six-second slot. */
  readonly queued: number;
  readonly liveHolders: number;
  readonly peakHolders: number;
  readonly cameraDistance: number;
  /** True while the payload driving the frame is flagged by the server. */
  readonly degraded: boolean;
  /** True once any payload has been accepted. */
  readonly hasData: boolean;
}

export interface SceneDirectorOptions {
  /** Starting tier index. Ratcheted from here up and never below. */
  readonly tier?: number;
  /** Fires at the instant a promotion's choreography starts. */
  readonly onPromote?: (tier: Tier) => void;
}

export class SceneDirector {
  private readonly visuals: VisualState;
  private readonly holders = new HolderDistance();
  private readonly queue: TierEventQueue;
  private readonly onPromote?: (tier: Tier) => void;

  /** True once any payload — degraded or not — has seeded the session. */
  private seeded = false;
  private degradedFlag = false;
  private liveHolders = 0;
  private peakHolders = 0;

  /** Composed per frame in `update`, read by several callers afterwards. */
  private composedDiskRadius = 0;
  private composedDistance = DISTANCE_AT_ZERO_HOLDERS;
  private event: TierEventFrame = { rippleAmount: 0, ripplePhase: 0, brightness: 1, push: 0 };

  constructor(options: SceneDirectorOptions = {}) {
    this.visuals = new VisualState(options.tier ?? 0);
    this.onPromote = options.onPromote;
    this.queue = new TierEventQueue(this.visuals.tier.index, this.handlePromotion);
    this.compose();
  }

  /** The smoothed tier state. Exposed for tests and the debug overlay. */
  get visualState(): VisualState {
    return this.visuals;
  }

  /** The tier whose choreography is playing, or null between events. */
  get activeEvent(): Tier | null {
    return this.queue.current;
  }

  /** Seconds into the active choreography. */
  get eventElapsed(): number {
    return this.queue.elapsed;
  }

  get degraded(): boolean {
    return this.degradedFlag;
  }

  summary(): FeedSummary {
    return {
      tierIndex: this.visuals.tier.index,
      queued: this.queue.queued,
      liveHolders: this.liveHolders,
      peakHolders: this.peakHolders,
      cameraDistance: this.composedDistance,
      degraded: this.degradedFlag,
      hasData: this.seeded,
    };
  }

  /**
   * Accept one payload from `/api/stats`.
   *
   * Safe to call at any rate, including with the same payload twice — every
   * path in here is idempotent on an unchanged payload, which matters because
   * the poller re-delivers on a visibility change.
   */
  applyStats(stats: Stats): void {
    // Frozen. Not an error, not a reset, and deliberately not even a partial
    // update: a payload the server has flagged is not evidence about anything,
    // and taking the holder count from it while ignoring the tier would be a
    // half-trusted payload, which is the worst of both.
    if (stats.degraded && this.seeded) {
      this.degradedFlag = true;
      return;
    }

    this.degradedFlag = stats.degraded;
    this.liveHolders = Math.max(0, stats.liveHolders);
    // The server ratchets this; `max` here is the same belt-and-braces as the
    // tier ratchet in VisualState, against a stale or reordered payload.
    this.peakHolders = Math.max(this.peakHolders, this.liveHolders, stats.peakHolders);
    this.holders.setHolders(this.liveHolders, this.peakHolders);

    if (this.seeded) {
      this.queue.promoteTo(stats.tierIndex);
    } else {
      // A page load is not an unlock. See `TierEventQueue.adopt`.
      this.seeded = true;
      this.queue.adopt(stats.tierIndex);
      this.visuals.setTier(stats.tierIndex, true);
    }
  }

  /**
   * Force a promotion with its full choreography.
   *
   * The `?promote=` debug path and `Renderer.setTier`. Ratcheted like every
   * other route to a tier: this cannot lower anything.
   */
  promoteTo(index: number): void {
    this.queue.promoteTo(index);
  }

  /**
   * Pin the active event's clock for a reproducible still, or null to resume.
   * Debug only — see `TierEventQueue.pinClock`.
   */
  pinEventClock(seconds: number | null): void {
    this.queue.pinClock(seconds);
  }

  /** Seed the holder channel directly, bypassing the feed. Debug only. */
  setHolders(live: number, peak: number): void {
    this.liveHolders = Math.max(0, live);
    this.peakHolders = Math.max(this.liveHolders, peak);
    this.holders.setHolders(this.liveHolders, this.peakHolders);
  }

  /**
   * Advance every clock by one frame.
   *
   * Order matters. The queue goes first so a promotion starting this frame
   * reaches `VisualState` before its ease is advanced — otherwise the ripple
   * would lead the tier lerp by exactly one frame, forever.
   */
  update(deltaSeconds: number): void {
    this.queue.update(deltaSeconds);
    this.visuals.update(deltaSeconds);
    this.holders.update(deltaSeconds);
    this.event = this.queue.read();
    this.compose();
  }

  /** Scene uniforms: tier values with the holder scale and the overshoot on. */
  readScene(): VisualUniformValues {
    const base = this.visuals.read();
    return {
      diskOuterRadius: this.composedDiskRadius,
      // The overshoot multiplies the tier's brightness rather than replacing
      // it, so a promotion at tier 2 flashes as hard, relatively, as one at
      // tier 10 — which is the point. An absolute overshoot would be a blaze
      // early on and imperceptible later.
      diskBrightness: base.diskBrightness * this.event.brightness,
      diskTurbulence: base.diskTurbulence,
      diskColorInner: base.diskColorInner,
      diskColorOuter: base.diskColorOuter,
      jetStrength: base.jetStrength,
    };
  }

  readPost(): PostUniformValues {
    return this.visuals.readPost();
  }

  readDrone(): DroneValues {
    return this.visuals.readDrone();
  }

  readCamera(): CameraFrame {
    const shake = this.visuals.readShake();
    return {
      distance: this.composedDistance,
      shakeAmplitude: shake.amplitude,
      shakeFrequency: shake.frequency,
    };
  }

  readRipple(): RippleFrame {
    return { amount: this.event.rippleAmount, phase: this.event.ripplePhase };
  }

  /** HUD announcement opacity for the active event, 0..1. */
  readAnnounceOpacity(): number {
    return this.queue.readAnnounceOpacity();
  }

  private readonly handlePromotion = (tier: Tier): void => {
    this.visuals.setTier(tier.index);
    this.onPromote?.(tier);
  };

  /** Fold both channels into the two numbers the frame actually needs. */
  private compose(): void {
    this.composedDiskRadius =
      this.visuals.read().diskOuterRadius * diskScaleForGrowth(this.holders.growth);

    const clearance = this.composedDiskRadius * CAMERA_DISK_CLEARANCE;
    // The push is applied AFTER the clearance clamp on purpose. It is a 6%
    // nudge lasting a second, not a sustained framing decision, and letting
    // the clamp veto it would silently delete the push at exactly the top
    // tiers where an unlock matters most. 6% of the clearance distance is far
    // too little to reach the disk.
    this.composedDistance = Math.max(this.holders.distance, clearance) * (1 - this.event.push);
  }
}
