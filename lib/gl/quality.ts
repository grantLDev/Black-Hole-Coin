/**
 * Quality tiers.
 *
 * The performance contract for this project is 60fps on a 2020 MacBook Air and
 * 30fps on a mid-range Android phone. A raymarched fragment shader is almost
 * purely fill-rate bound, so the two levers that actually matter are (a) how
 * many pixels we shade and (b) how much work each pixel does. Both are
 * expressed here, and both are wired up before there is anything expensive to
 * draw — retrofitting a quality system onto a finished shader means rewriting
 * the shader.
 *
 * Tier changes are ONE-DIRECTIONAL: the governor only ever steps down. A
 * bidirectional governor oscillates — it drops a tier, the frame budget
 * recovers *because* it dropped, it steps back up, and the cycle repeats,
 * which reads as periodic stuttering. Downgrade-only is stable, and matches
 * the ratcheting philosophy of the rest of the site.
 *
 * SUPERSAMPLING is a deliberate part of (a): `minPixelRatio` puts a FLOOR
 * under the pixel ratio, so the drawing buffer is larger than the screen area
 * it is shown in and the browser downsamples it. That is the same thing a
 * viewer gets by zooming the page out, and it is the largest single quality
 * win available here — the photon ring is a one-pixel feature and a 2x buffer
 * is what resolves it. It is also, exactly, a 4x fill-rate cost, which is why
 * the pixel ceilings and the governor's thresholds both moved with it.
 *
 * A THIRD LEVER arrived with the post chain: whether there is one. `post` is
 * false on the bottom tier, and that single flag takes out the full-resolution
 * half-float scene target, the bloom pyramid and the composite pass together.
 * It is the largest single step in this file after the march budget, and it is
 * deliberately all-or-nothing — see the field's own comment.
 */

export type QualityTier = "low" | "medium" | "high";

export interface QualityProfile {
  readonly tier: QualityTier;
  /** Hard ceiling on `devicePixelRatio`, before `renderScale`. */
  readonly maxPixelRatio: number;
  /**
   * FLOOR on the pixel ratio, before `renderScale`. This is the supersampling
   * knob, and it is the reason the image is sharp on an ordinary 1x display.
   *
   * A browser at 80% zoom reports `devicePixelRatio` 0.8 while the canvas's
   * CSS size grows by 1/0.8, so the drawing buffer ends up larger than the
   * screen area it is shown in — the frame is supersampled, and every edge in
   * it (the photon ring above all) resolves visibly better. That is a real
   * quality difference, not a trick of the zoom, and there is no reason to
   * make a viewer zoom out to get it.
   *
   * Raising the floor above the reported ratio reproduces it deliberately: at
   * 2.0 on a 1x display the buffer is 2x2 device pixels per screen pixel and
   * the browser's own filter does the downsample for free. The cost is exact
   * and brutal — a raymarcher is fill-rate bound, so 2x here is 4x the frame
   * time — which is what `maxPixels` and the governor are for.
   */
  readonly minPixelRatio: number;
  /** Multiplier on the clamped pixel ratio. Below 1 renders under-native. */
  readonly renderScale: number;
  /**
   * Ceiling on total drawing-buffer pixels. A 5K display at DPR 2 asks for
   * ~14.7M pixels; no integrated GPU raymarches that at 60fps. When the
   * requested buffer exceeds this, the pixel ratio is scaled down to fit.
   */
  readonly maxPixels: number;
  /** Octaves in the Milky Way FBM. The single most expensive knob in the sky. */
  readonly skyFbmOctaves: number;
  /**
   * Compile-time ceiling on geodesic march steps, and the runtime budget the
   * shader is actually given. They are equal here — the ceiling exists so the
   * loop bound stays a constant for the driver, and the uniform exists so the
   * budget can be changed without a recompile.
   *
   * This is the dominant cost in the whole renderer. Every other knob in this
   * file is a rounding error next to it.
   */
  readonly marchSteps: number;
  /**
   * Geometric step criterion: `dt <= stepScale * r`. Larger is coarser. Raised
   * on lower tiers so a smaller step budget still reaches the escape radius.
   */
  readonly marchStepScale: number;
  /**
   * Angular step criterion: `dt <= turnLimit / |accel|`, in radians of
   * trajectory turn per step. This is the knob that resolves the photon ring —
   * at 0.055 rad a ray needs ~114 steps to orbit the photon sphere once, which
   * is what keeps the ring a sharp line instead of a smear. Raising it is the
   * first thing that shows on a low tier, and the last thing worth raising.
   */
  readonly marchTurnLimit: number;
  /** Octaves in the accretion disk's filament FBM. Below 3, the domain warp
   * is compiled out entirely. */
  readonly diskFbmOctaves: number;
  /**
   * Whether the post chain runs at all.
   *
   * THIS IS THE SINGLE FLAG the brief asks for. False means the scene shader
   * tone maps and writes straight to the default framebuffer, and `PostChain`
   * is never constructed — no half-float scene target, no pyramid, no
   * composite pass, and none of their bandwidth. It is not a quality setting
   * with a cheap mode; the chain is either there or it is not.
   *
   * False on `low` because the post chain's cost is almost entirely memory
   * bandwidth, and bandwidth is exactly what a phone that has already been
   * stepped down to `low` has run out of. A device in that state needs the
   * frame, not the grade.
   */
  readonly post: boolean;
  /**
   * Levels in the bloom pyramid, including the half-resolution base.
   *
   * Each level costs one downsample and one upsample pass over a quarter of
   * the previous level's pixels, so the whole chain beyond the base costs
   * about a third of the base again — cheap, but the WIDTH of the bloom is
   * what this buys and a wide bloom on a small screen is just a haze. Ignored
   * when `post` is false, and capped at runtime by how far the drawing buffer
   * can actually be halved.
   */
  readonly bloomLevels: number;
  /**
   * Frame time above which this tier is considered unsustainable, in ms.
   * `Infinity` on the bottom tier — there is nowhere left to fall.
   */
  readonly downgradeAboveMs: number;
}

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: {
    tier: "high",
    // 2.5 rather than 2 so a 1x display supersamples 2x AND a DPR-1.5 laptop
    // still gets some. Above 2.5 the returns are gone: the browser's
    // downsample filter is a box, and a box filter past 2x is just blur.
    maxPixelRatio: 2.5,
    // 2x supersampling on any display that reports less. This is the single
    // change that makes the default view look like the zoomed-out one.
    minPixelRatio: 2,
    renderScale: 1,
    // 4x the old 2.6M ceiling, which is what a 2x supersample of a 1080p
    // viewport actually costs (1920*1080*4 = 8.29M, so a 1080p page lands
    // just under this and renders at a true 2x). Deliberately chosen over
    // frame rate: the governor drops the tier when a device cannot hold it,
    // and a sharp image that occasionally steps down beats a soft one that
    // never does.
    maxPixels: 8_300_000,
    skyFbmOctaves: 5,
    marchSteps: 300,
    marchStepScale: 0.11,
    marchTurnLimit: 0.055,
    diskFbmOctaves: 3,
    post: true,
    // The coarsest of five levels is 1/32 of the frame, so its texels are 32
    // device pixels across and the tent on top of them reaches roughly 64
    // pixels out from a bright source. Wider than that stops reading as a lens
    // and starts reading as fog.
    bloomLevels: 5,
    // 40fps, not 50. The supersampled buffer costs roughly 4x what the old
    // one did, so a 50fps trigger would step almost every laptop straight
    // back down to a softer image within seconds — which is the opposite of
    // the point. 40fps still reads as smooth on a slow orbit.
    downgradeAboveMs: 1000 / 40,
  },
  medium: {
    tier: "medium",
    maxPixelRatio: 2,
    // 1.4x, so this tier is still supersampled on a 1x display — the step
    // down from "high" should cost sharpness, not surrender it.
    minPixelRatio: 1.4,
    renderScale: 1,
    maxPixels: 4_200_000,
    skyFbmOctaves: 4,
    marchSteps: 180,
    marchStepScale: 0.16,
    marchTurnLimit: 0.085,
    diskFbmOctaves: 3,
    post: true,
    // One level fewer, which is also one level narrower — appropriate, since
    // this tier is already rendering under-native and the widest level was
    // being upscaled to the screen anyway.
    bloomLevels: 4,
    downgradeAboveMs: 1000 / 30,
  },
  low: {
    tier: "low",
    maxPixelRatio: 1.5,
    // No supersampling here, and no under-sampling below native either: the
    // floor is exactly the display. This tier is the safety net a struggling
    // phone falls into, and there is nothing below it to fall to further, so
    // it is the one place in this file where the resolution push stops.
    minPixelRatio: 1,
    // 0.85 rather than the old 0.7. A visible sharpening on the bottom tier,
    // and still under native, which is what keeps this the cheap option.
    renderScale: 0.85,
    maxPixels: 1_600_000,
    skyFbmOctaves: 3,
    marchSteps: 90,
    marchStepScale: 0.26,
    marchTurnLimit: 0.15,
    diskFbmOctaves: 2,
    // The whole stack off. See `post` above.
    post: false,
    bloomLevels: 0,
    downgradeAboveMs: Number.POSITIVE_INFINITY,
  },
} as const;

const TIER_ORDER: readonly QualityTier[] = ["high", "medium", "low"];

/** The tier one step down, or null at the bottom. */
export function lowerTier(tier: QualityTier): QualityTier | null {
  const next = TIER_ORDER.indexOf(tier) + 1;
  return next < TIER_ORDER.length ? TIER_ORDER[next] : null;
}

/**
 * The effective device pixel ratio for a profile at a given CSS size.
 *
 * Clamps `devicePixelRatio` into the profile's [`minPixelRatio`,
 * `maxPixelRatio`] band, applies the render scale, then shrinks further if the
 * resulting buffer would blow the pixel budget. The FLOOR is the supersampling
 * knob — see its comment on the interface.
 */
export function effectivePixelRatio(
  profile: QualityProfile,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  // The floor is what supersamples: on a 1x display `devicePixelRatio` is 1
  // and `minPixelRatio` is what the buffer is actually sized by. On a 2x
  // display the reported ratio already exceeds it and nothing changes.
  const clamped = Math.min(
    Math.max(devicePixelRatio, profile.minPixelRatio),
    profile.maxPixelRatio,
  );
  let ratio = clamped * profile.renderScale;

  const pixels = cssWidth * cssHeight * ratio * ratio;
  if (pixels > profile.maxPixels) {
    ratio *= Math.sqrt(profile.maxPixels / pixels);
  }

  // Never go below half-native: past that the aliasing costs more than the
  // frame rate buys.
  return Math.max(0.5, ratio);
}

/**
 * How many drawing-buffer pixels there are per PHYSICAL screen pixel, along
 * one axis. 1 when the buffer matches the display, 2 when it is supersampled
 * 2x, and never below 1.
 *
 * The star field needs this and nothing else does. Its point spread function
 * is sized in pixels precisely so that no star can be smaller than the thing
 * that samples it — but once the buffer is supersampled, "a buffer pixel" is
 * no longer what the viewer sees. A 1.0-buffer-pixel star on a 2x buffer is
 * half a screen pixel, which is exactly the sub-pixel star the sizing rule
 * exists to prevent. Multiplying the pixel angle by this factor keeps the
 * point spread function anchored to the SCREEN, so raising the resolution
 * makes stars better resolved rather than smaller.
 */
export function bufferPixelsPerScreenPixel(ratio: number, devicePixelRatio: number): number {
  return Math.max(1, ratio / Math.max(1, devicePixelRatio));
}

/**
 * Best guess at a starting tier, from whatever the platform is willing to say.
 *
 * Every one of these signals is optional or lies on some browser, so this is a
 * starting point, not a verdict — the runtime governor is what actually
 * enforces the frame budget.
 */
export function detectQualityTier(gl: WebGL2RenderingContext): QualityTier {
  // A software rasteriser (SwiftShader, llvmpipe, Mesa's softpipe) will never
  // hold 30fps on a raymarcher, whatever the CPU says.
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (debugInfo) {
    const renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? "");
    if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) return "low";
  }

  // Small texture limits are a reliable tell for old mobile GPUs.
  const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (typeof maxTexture === "number" && maxTexture > 0 && maxTexture < 8192) return "low";

  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const cores = nav?.hardwareConcurrency ?? 4;
  // Chromium-only, and quantised to 0.25/0.5/1/2/4/8. Absent on Safari and
  // Firefox, where `undefined` must not be read as "low memory".
  const memory = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory;

  const coarsePointer =
    typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;
  const touch = (nav?.maxTouchPoints ?? 0) > 0;
  const mobile = coarsePointer && touch;

  if (memory !== undefined && memory <= 2) return "low";

  if (mobile) {
    // Phones lose their thermal headroom within a minute regardless of specs,
    // so the ceiling here is "medium" and the governor takes it from there.
    return cores >= 6 && (memory === undefined || memory >= 4) ? "medium" : "low";
  }

  if (cores >= 8 && (memory === undefined || memory >= 8)) return "high";
  if (cores >= 4) return "medium";
  return "low";
}

export interface QualityGovernorOptions {
  readonly initialTier: QualityTier;
  /**
   * Frames to ignore after a start, resume, or tier change. Shader
   * compilation, the first draw into a fresh buffer, and the hitch from a
   * program rebuild all land here and none of them represent steady state.
   */
  readonly warmupFrames?: number;
  /** How long the budget must stay blown before stepping down, in ms. */
  readonly sustainMs?: number;
  readonly onChange: (profile: QualityProfile) => void;
}

/**
 * Watches frame times and steps the quality tier down when the current one
 * cannot hold its budget. Never steps back up.
 */
export class QualityGovernor {
  private profile: QualityProfile;
  private readonly warmupFrames: number;
  private readonly sustainMs: number;
  private readonly onChange: (profile: QualityProfile) => void;

  /** Exponential moving average of frame time, in ms. */
  private averageMs = 0;
  private framesSeen = 0;
  /** Milliseconds accumulated while over budget; reset by any good frame. */
  private overBudgetMs = 0;

  constructor(options: QualityGovernorOptions) {
    this.profile = QUALITY_PROFILES[options.initialTier];
    this.warmupFrames = options.warmupFrames ?? 60;
    this.sustainMs = options.sustainMs ?? 1500;
    this.onChange = options.onChange;
  }

  get current(): QualityProfile {
    return this.profile;
  }

  /** Discard accumulated evidence. Call after a resume, resize, or recompile. */
  reset(): void {
    this.framesSeen = 0;
    this.averageMs = 0;
    this.overBudgetMs = 0;
  }

  /** Feed one frame's wall time, in ms. */
  sample(frameMs: number): void {
    // A frame long enough to be a stall (an alt-tab, a GC pause, a devtools
    // breakpoint) is not evidence about sustainable frame rate.
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 500) return;

    this.framesSeen += 1;
    if (this.framesSeen <= this.warmupFrames) {
      this.averageMs = frameMs;
      return;
    }

    // ~0.5s time constant at 60fps: slow enough to ignore single bad frames,
    // fast enough to react inside the sustain window.
    this.averageMs += (frameMs - this.averageMs) * 0.03;

    if (this.averageMs > this.profile.downgradeAboveMs) {
      this.overBudgetMs += frameMs;
      if (this.overBudgetMs >= this.sustainMs) this.stepDown();
    } else {
      this.overBudgetMs = 0;
    }
  }

  private stepDown(): void {
    const next = lowerTier(this.profile.tier);
    this.reset();
    if (next === null) return;
    this.profile = QUALITY_PROFILES[next];
    this.onChange(this.profile);
  }
}
