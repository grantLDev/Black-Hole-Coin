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
 */

export type QualityTier = "low" | "medium" | "high";

export interface QualityProfile {
  readonly tier: QualityTier;
  /** Hard ceiling on `devicePixelRatio`, before `renderScale`. */
  readonly maxPixelRatio: number;
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
   * Frame time above which this tier is considered unsustainable, in ms.
   * `Infinity` on the bottom tier — there is nowhere left to fall.
   */
  readonly downgradeAboveMs: number;
}

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: {
    tier: "high",
    maxPixelRatio: 2,
    renderScale: 1,
    // Comfortably above 1080p (2.07M) and below 1440p at DPR 2. The pixel
    // budgets all came down when the marcher landed: the sky cost a few dozen
    // ALU ops per pixel, the geodesic integration costs a few thousand.
    maxPixels: 2_600_000,
    skyFbmOctaves: 5,
    marchSteps: 300,
    marchStepScale: 0.11,
    marchTurnLimit: 0.055,
    diskFbmOctaves: 3,
    // Sustained below 50fps on "high" means "high" is the wrong call.
    downgradeAboveMs: 1000 / 50,
  },
  medium: {
    tier: "medium",
    maxPixelRatio: 2,
    renderScale: 0.85,
    maxPixels: 1_700_000,
    skyFbmOctaves: 4,
    marchSteps: 180,
    marchStepScale: 0.16,
    marchTurnLimit: 0.085,
    diskFbmOctaves: 3,
    downgradeAboveMs: 1000 / 38,
  },
  low: {
    tier: "low",
    maxPixelRatio: 1.5,
    renderScale: 0.7,
    maxPixels: 1_000_000,
    skyFbmOctaves: 3,
    marchSteps: 90,
    marchStepScale: 0.26,
    marchTurnLimit: 0.15,
    diskFbmOctaves: 2,
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
 * Clamps `devicePixelRatio` to the profile ceiling, applies the render scale,
 * then shrinks further if the resulting buffer would blow the pixel budget.
 */
export function effectivePixelRatio(
  profile: QualityProfile,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): number {
  const clamped = Math.min(Math.max(devicePixelRatio, 1), profile.maxPixelRatio);
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
