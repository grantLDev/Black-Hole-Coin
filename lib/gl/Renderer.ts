/**
 * Renderer bootstrap.
 *
 * Owns the WebGL2 context, the frame loop, resizing, the quality governor, and
 * teardown. It knows nothing about what is being drawn — that is FullscreenPass.
 *
 * Three decisions worth stating up front, because they are easy to "fix" back
 * into bugs:
 *
 *  1. Antialiasing is OFF. MSAA antialiases geometry edges, and this scene has
 *     exactly one triangle whose edges are off-screen, so MSAA would cost
 *     bandwidth on every pixel and improve nothing. Everything that needs
 *     smoothing — star point spread, the photon ring later — is smoothed
 *     analytically in the shader.
 *
 *  2. The context has no depth or stencil buffer. One primitive, no occlusion.
 *     Allocating them would cost memory bandwidth on every frame for nothing.
 *
 *  3. autoClear is off. The triangle writes every pixel of the viewport, so a
 *     clear is a guaranteed-redundant full-screen write. The post chain relies
 *     on this too: its upsample passes blend ADDITIVELY into surfaces the
 *     downsample already wrote, and an automatic clear would erase exactly the
 *     half of the pyramid they are meant to be adding to.
 *
 * THE POST CHAIN sits between the raymarch and the screen when the active
 * quality profile asks for it. When it does, the scene renders into a
 * half-float target instead of the framebuffer and `PostChain` owns the
 * display transform; when it does not — the low tier, a context without
 * renderable half float, or `?post=0` — the scene shader tone maps inline and
 * draws straight to the screen, and no post surface is ever allocated. The
 * renderer holds `null` in that case, and `postEnabled` is the single flag.
 */

import {
  ACESFilmicToneMapping,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";

import { FullscreenPass } from "./FullscreenPass";
import { OrbitCamera, type OrbitCameraOptions } from "./OrbitCamera";
import { PostChain, isPostSupported } from "./PostChain";
import { VisualState } from "./VisualState";
import {
  QualityGovernor,
  bufferPixelsPerScreenPixel,
  detectQualityTier,
  effectivePixelRatio,
  type QualityProfile,
  type QualityTier,
} from "./quality";

/** Longest frame delta the camera will integrate, in ms. */
const MAX_FRAME_DELTA_MS = 100;
/** How often onStats fires, in ms. */
const STATS_INTERVAL_MS = 250;

/**
 * Period at which the shader's time uniform wraps, in seconds.
 *
 * The disk's noise is advected by `phi - omega(r) * t`, and that angle goes
 * through sin/cos. A float32 argument of ~5000 rad still resolves to about
 * 3e-4 rad, which is invisible; at ~1e6 it is not. Six hours puts the largest
 * argument (the inner edge, at omega ~ 0.22 rad/s x 2) near 9500 rad and keeps
 * a comfortable margin.
 *
 * The wrap is not seamless — omega varies continuously with radius, so no
 * single period is a whole number of revolutions at every radius — so it costs
 * one re-phase of the disk texture after six hours of uninterrupted playback.
 * The camera, which uses unwrapped time, does not jump.
 */
const SHADER_TIME_WRAP_SECONDS = 6 * 60 * 60;

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
};

export interface RendererStats {
  readonly fps: number;
  readonly frameMs: number;
  readonly quality: QualityTier;
  readonly pixelRatio: number;
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** March budget the shader is currently running, for the debug overlay. */
  readonly marchSteps: number;
  /** Whether the post chain ran this frame. */
  readonly post: boolean;
  /** Bloom pyramid levels actually allocated. 0 when post is off. */
  readonly bloomLevels: number;
}

export interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly camera?: OrbitCameraOptions;
  /** Forces a starting quality tier, bypassing detection. For debugging. */
  readonly quality?: QualityTier;
  /**
   * Stop the governor from ever stepping down.
   *
   * `quality` alone only picks the STARTING tier — the governor still enforces
   * the frame budget from there, which is the right behaviour on a real page
   * and wrong in a measurement: a run that downgrades halfway through reports
   * the average of two different shaders under one label.
   */
  readonly lockQuality?: boolean;
  /**
   * Pins scene time to a fixed number of seconds instead of advancing it.
   *
   * The orbit then holds still, which is how a specific view gets inspected —
   * the star field over a cube-face centre, say — and how two revisions of the
   * shader get compared pixel for pixel.
   */
  readonly fixedTime?: number;
  /**
   * Starting tier index, 0..11. Ratcheted from here up by `setTier`; see
   * VisualState for why the renderer keeps its own ratchet.
   */
  readonly tier?: number;
  /**
   * Force an exact drawing-buffer size in device pixels, ignoring CSS size and
   * devicePixelRatio.
   *
   * This exists for benchmarking. "Frame time at 1080p" is only a meaningful
   * number if the buffer really is 1920x1080, and every other path here sizes
   * the buffer from the viewport and the quality profile, which is exactly the
   * right behaviour for a real page and exactly the wrong one for a measurement.
   */
  readonly bufferSize?: { readonly width: number; readonly height: number };
  /**
   * Force the post chain on or off, overriding the quality profile.
   *
   * `false` is the brief's single kill switch exercised by hand — everything
   * from the bloom to the grain vanishes and the scene shader goes back to
   * drawing straight to the screen. `true` forces it on for a profile that
   * would not normally run it, which is how the low tier's post-off path gets
   * compared against the same frame with post on.
   *
   * Neither value can conjure a chain on a context that cannot render to half
   * float; that check is not overridable.
   */
  readonly post?: boolean;
  /** Fires roughly four times a second while the loop is running. */
  readonly onStats?: (stats: RendererStats) => void;
}

export class SingularityRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly pass: FullscreenPass;
  private readonly camera: OrbitCamera;
  private readonly governor: QualityGovernor;
  private readonly visuals: VisualState;
  private readonly onStats?: (stats: RendererStats) => void;
  private readonly fixedTime: number | null;
  private readonly bufferSize: { readonly width: number; readonly height: number } | null;
  private readonly lockQuality: boolean;
  /** Explicit `?post=` override, or null to follow the quality profile. */
  private readonly postOverride: boolean | null;
  /** False when the context cannot render to a half-float colour attachment. */
  private readonly postCapable: boolean;
  /** Null whenever the post chain is off. Never a half-constructed chain. */
  private post: PostChain | null = null;

  private rafId: number | null = null;
  /** Timestamp of the previous frame, or null after a start or resume. */
  private lastFrameTime: number | null = null;
  /** Accumulated, stall-clamped scene time in seconds. */
  private elapsed = 0;
  private disposed = false;

  private resizeObserver: ResizeObserver | null = null;
  private pixelRatioMedia: MediaQueryList | null = null;

  private statsWindowStart = 0;
  private statsFrames = 0;
  private statsAccumMs = 0;

  constructor(options: RendererOptions) {
    this.canvas = options.canvas;
    this.onStats = options.onStats;
    this.fixedTime = Number.isFinite(options.fixedTime) ? (options.fixedTime as number) : null;
    this.bufferSize = options.bufferSize ?? null;
    this.lockQuality = options.lockQuality ?? false;
    this.postOverride = options.post ?? null;

    // A canvas can only ever hold one context, and a second getContext() call
    // returns the first one. That is exactly the behaviour we want: React
    // StrictMode mounts effects twice in development, and a disposed renderer
    // deliberately leaves the context alive so the remount can reuse it.
    const gl = this.canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
    if (!gl) {
      throw new Error("WebGL2 is required and is not available in this browser.");
    }

    this.renderer = new WebGLRenderer({
      ...CONTEXT_ATTRIBUTES,
      canvas: this.canvas,
      context: gl,
    });

    // These govern any future ShaderMaterial or post-processing pass. The raw
    // shader in FullscreenPass reproduces both transforms itself, because
    // three.js injects no colour-management chunks into a RawShaderMaterial.
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.debug.checkShaderErrors = process.env.NODE_ENV !== "production";

    const initialTier = options.quality ?? detectQualityTier(gl);
    this.governor = new QualityGovernor({
      initialTier,
      onChange: this.handleQualityChange,
    });

    this.camera = new OrbitCamera(options.camera);
    this.visuals = new VisualState(options.tier ?? 0);

    // Probed once, from the same context the renderer will use. A driver that
    // cannot render to RGBA16F cannot run this chain at all, and no flag
    // overrides that.
    this.postCapable = isPostSupported(gl);
    this.pass = new FullscreenPass(this.governor.current, this.wantsPost());
    this.syncPostChain();

    this.attachListeners();
    this.resize();
  }

  get quality(): QualityTier {
    return this.governor.current.tier;
  }

  /** March budget of the active quality profile. */
  get marchSteps(): number {
    return this.governor.current.marchSteps;
  }

  /** The smoothed tier state driving the shader. */
  get visualState(): VisualState {
    return this.visuals;
  }

  /** Whether the post chain is currently running. */
  get postEnabled(): boolean {
    return this.post !== null;
  }

  /**
   * Draw one frame into an offscreen 8-bit surface and read it back.
   *
   * For the banding check in `scripts/banding.ts`. Returns null when the post
   * chain is off, because the direct path writes to the default framebuffer
   * and this context is created with `preserveDrawingBuffer: false` — there is
   * no valid moment to read that buffer from outside the draw's own task.
   *
   * `noiseScale` of 0 suppresses grain and dither for this one frame, which is
   * the control the banding check compares against. The uniform is restored
   * before returning, so a debug capture cannot leave the live page undithered.
   */
  captureFrame(noiseScale = 1): { width: number; height: number; data: Uint8Array } | null {
    if (!this.post) return null;
    this.post.setNoiseScale(noiseScale);
    this.draw();
    const pixels = this.post.readPixels(this.renderer);
    this.post.setNoiseScale(1);
    this.renderer.setRenderTarget(null);
    return pixels;
  }

  /**
   * Aim the visuals at a tier index, 0..11.
   *
   * Ratcheted, and deliberately so — see VisualState. The transition is
   * smoothed over a couple of seconds; jets fade in over four and never out.
   */
  setTier(index: number): void {
    this.visuals.setTier(index);
  }

  /** Vertical field of view in degrees. Applied on the next frame. */
  setFov(degrees: number): void {
    this.camera.setFov(degrees);
  }

  /**
   * Override the geodesic march budget without a recompile.
   *
   * Clamped to the compiled `MARCH_STEPS` ceiling of the active quality
   * profile; a later `setQuality` from the governor resets it to that profile's
   * own value.
   */
  setQualitySteps(steps: number): void {
    this.pass.setQualitySteps(steps);
  }

  /** Begin (or resume) the frame loop. No-op if hidden, disposed, or running. */
  start(): void {
    if (this.disposed || this.rafId !== null) return;
    if (typeof document !== "undefined" && document.hidden) return;

    this.lastFrameTime = null;
    this.governor.reset();
    this.statsWindowStart = 0;
    this.statsFrames = 0;
    this.statsAccumMs = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  /**
   * Cancel the frame loop outright.
   *
   * Browsers throttle rAF in a hidden tab rather than stopping it, which still
   * burns a phone's battery rendering a shader nobody can see. Cancelling is
   * the only way to actually stop.
   */
  stop(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.lastFrameTime = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.stop();
    this.detachListeners();
    this.pass.dispose();
    this.post?.dispose();
    this.post = null;

    // Frees three's GPU resources and its own listeners. The WebGL context is
    // intentionally NOT force-lost: a lost context cannot be recreated on the
    // same canvas element, and this canvas is server-rendered by page.tsx and
    // outlives the renderer.
    this.renderer.dispose();
  }

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);

    const previous = this.lastFrameTime;
    this.lastFrameTime = now;

    if (previous === null) {
      // First frame of a start or resume. The delta spans however long the tab
      // was hidden, so it is evidence of nothing and is not integrated.
      this.draw();
      this.statsWindowStart = now;
      return;
    }

    const frameMs = now - previous;

    // Clamped so a GC pause or a device sleep cannot teleport the camera.
    const deltaSeconds = Math.min(frameMs, MAX_FRAME_DELTA_MS) / 1000;
    this.elapsed += deltaSeconds;
    this.visuals.update(deltaSeconds);

    this.draw();
    if (!this.lockQuality) this.governor.sample(frameMs);
    this.reportStats(now, frameMs);
  };

  private draw(): void {
    const sceneTime = this.fixedTime ?? this.elapsed;
    this.camera.update(sceneTime);
    this.pass.setCamera(this.camera);
    // Wrapped only for the shader: see SHADER_TIME_WRAP_SECONDS. `%` on a
    // non-negative left operand is a plain modulo here.
    const shaderTime = sceneTime % SHADER_TIME_WRAP_SECONDS;
    this.pass.setTime(shaderTime);
    this.pass.setVisuals(this.visuals.read());
    this.pass.setExposure(this.renderer.toneMappingExposure);

    if (!this.post) {
      this.pass.render(this.renderer, null);
      return;
    }

    this.post.setVisuals(this.visuals.readPost());
    this.post.setExposure(this.renderer.toneMappingExposure);
    this.post.setTime(shaderTime);

    this.pass.render(this.renderer, this.post.sceneTarget);
    this.post.render(this.renderer, null);
  }

  private reportStats(now: number, frameMs: number): void {
    if (!this.onStats) return;

    this.statsFrames += 1;
    this.statsAccumMs += frameMs;

    const windowMs = now - this.statsWindowStart;
    if (windowMs < STATS_INTERVAL_MS) return;

    const gl = this.renderer.getContext();
    this.onStats({
      fps: (this.statsFrames * 1000) / windowMs,
      frameMs: this.statsAccumMs / this.statsFrames,
      quality: this.governor.current.tier,
      pixelRatio: this.renderer.getPixelRatio(),
      bufferWidth: gl.drawingBufferWidth,
      bufferHeight: gl.drawingBufferHeight,
      marchSteps: this.governor.current.marchSteps,
      post: this.post !== null,
      bloomLevels: this.post?.levelCount ?? 0,
    });

    this.statsWindowStart = now;
    this.statsFrames = 0;
    this.statsAccumMs = 0;
  }

  private resize(): void {
    // Benchmark path: the buffer is pinned, so neither the viewport nor the
    // quality profile's pixel budget gets a say in how many pixels are shaded.
    if (this.bufferSize) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(this.bufferSize.width, this.bufferSize.height, false);
      const buffer = this.renderer.getContext();
      // A pinned buffer is a measurement, not a view: it is shown at whatever
      // size the page gives it, so there is no supersample factor to speak of
      // and the star field is sized against the buffer itself.
      this.pass.setPixelScale(1);
      this.pass.setSize(buffer.drawingBufferWidth, buffer.drawingBufferHeight);
      this.post?.setSize(buffer.drawingBufferWidth, buffer.drawingBufferHeight);
      this.governor.reset();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width || this.canvas.clientWidth);
    const cssHeight = Math.max(1, rect.height || this.canvas.clientHeight);

    const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const ratio = effectivePixelRatio(this.governor.current, cssWidth, cssHeight, devicePixelRatio);

    // Tell the star field how much of the buffer the display actually
    // resolves, before anything is sized against it.
    this.pass.setPixelScale(bufferPixelsPerScreenPixel(ratio, devicePixelRatio));

    this.renderer.setPixelRatio(ratio);
    // updateStyle = false: CSS owns the canvas's layout size. Letting three
    // write inline width/height styles would fight the stylesheet.
    this.renderer.setSize(cssWidth, cssHeight, false);

    // The driver is free to hand back a smaller buffer than asked for, so the
    // shader is told what was actually allocated, not what was requested.
    const gl = this.renderer.getContext();
    this.pass.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.post?.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);

    // A resize reallocates the drawing buffer and costs a frame or two.
    this.governor.reset();
  }

  /** Whether the post chain should be running, for the current profile. */
  private wantsPost(): boolean {
    if (!this.postCapable) return false;
    return this.postOverride ?? this.governor.current.post;
  }

  /**
   * Construct or tear down the post chain to match `wantsPost()`.
   *
   * Called at startup and on every quality change. Crossing the boundary in
   * either direction also flips the scene shader's output mode, which costs a
   * program rebuild — acceptable, because the governor only ever steps down and
   * so can cross it at most once in a session.
   */
  private syncPostChain(): void {
    const wanted = this.wantsPost();

    if (!wanted) {
      this.post?.dispose();
      this.post = null;
      return;
    }

    if (!this.post) this.post = new PostChain(this.governor.current);
    else this.post.setQuality(this.governor.current);
  }

  private readonly handleQualityChange = (profile: QualityProfile): void => {
    this.syncPostChain();
    this.pass.setQuality(profile, this.wantsPost());
    // resize() sizes the post surfaces too, and syncPostChain may have just
    // built them at 1x1.
    this.resize();
  };

  private readonly handleResize = (): void => {
    if (this.disposed) return;
    this.resize();
  };

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed) return;
    if (document.hidden) this.stop();
    else this.start();
  };

  private readonly handleContextLost = (event: Event): void => {
    // Without preventDefault the context is never restored. three.js also
    // calls this on its own listener; calling it twice is harmless.
    event.preventDefault();
    this.stop();
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    // three.js rebuilds its own GL state on this event. All that is left is to
    // re-establish our buffer size and get the loop going again. The post
    // chain's textures went with the context, so it is rebuilt outright rather
    // than resized — `setSize` would early-out on an unchanged size and leave
    // the renderer sampling dead texture handles.
    if (this.post) {
      this.post.dispose();
      this.post = null;
      this.syncPostChain();
    }
    this.resize();
    this.start();
  };

  /**
   * Re-arm the devicePixelRatio watcher.
   *
   * There is no `devicePixelRatio` change event. The standard trick is a media
   * query that matches only the CURRENT ratio: it stops matching the moment
   * the ratio changes, which fires `change`, and the watcher is then re-armed
   * against the new value. Dragging a window between a laptop screen and an
   * external monitor is the everyday case.
   */
  private readonly handlePixelRatioChange = (): void => {
    if (this.disposed) return;
    this.resize();
    this.watchPixelRatio();
  };

  private watchPixelRatio(): void {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    this.pixelRatioMedia?.removeEventListener("change", this.handlePixelRatioChange);
    this.pixelRatioMedia = null;

    try {
      const ratio = window.devicePixelRatio || 1;
      const media = window.matchMedia(`(resolution: ${ratio}dppx)`);
      media.addEventListener("change", this.handlePixelRatioChange);
      this.pixelRatioMedia = media;
    } catch {
      // Older Safari rejects the `resolution` feature. The window resize
      // listener below still catches the common monitor-swap case.
    }
  }

  private attachListeners(): void {
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.canvas);
    }
    window.addEventListener("resize", this.handleResize, { passive: true });
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.watchPixelRatio();
  }

  private detachListeners(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.pixelRatioMedia?.removeEventListener("change", this.handlePixelRatioChange);
    this.pixelRatioMedia = null;
  }
}

/** Construct a renderer and start its loop. */
export function createRenderer(options: RendererOptions): SingularityRenderer {
  const renderer = new SingularityRenderer(options);
  renderer.start();
  return renderer;
}
