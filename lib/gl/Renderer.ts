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
 *     clear is a guaranteed-redundant full-screen write.
 */

import {
  ACESFilmicToneMapping,
  SRGBColorSpace,
  WebGLRenderer,
} from "three";

import { FullscreenPass } from "./FullscreenPass";
import { OrbitCamera, type OrbitCameraOptions } from "./OrbitCamera";
import {
  QualityGovernor,
  detectQualityTier,
  effectivePixelRatio,
  type QualityProfile,
  type QualityTier,
} from "./quality";

/** Longest frame delta the camera will integrate, in ms. */
const MAX_FRAME_DELTA_MS = 100;
/** How often onStats fires, in ms. */
const STATS_INTERVAL_MS = 250;

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
}

export interface RendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly camera?: OrbitCameraOptions;
  /** Forces a starting quality tier, bypassing detection. For debugging. */
  readonly quality?: QualityTier;
  /**
   * Pins scene time to a fixed number of seconds instead of advancing it.
   *
   * The orbit then holds still, which is how a specific view gets inspected —
   * the star field over a cube-face centre, say — and how two revisions of the
   * shader get compared pixel for pixel.
   */
  readonly fixedTime?: number;
  /** Fires roughly four times a second while the loop is running. */
  readonly onStats?: (stats: RendererStats) => void;
}

export class SingularityRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly pass: FullscreenPass;
  private readonly camera: OrbitCamera;
  private readonly governor: QualityGovernor;
  private readonly onStats?: (stats: RendererStats) => void;
  private readonly fixedTime: number | null;

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
    this.pass = new FullscreenPass(this.governor.current.skyFbmOctaves);

    this.attachListeners();
    this.resize();
  }

  get quality(): QualityTier {
    return this.governor.current.tier;
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
    this.elapsed += Math.min(frameMs, MAX_FRAME_DELTA_MS) / 1000;

    this.draw();
    this.governor.sample(frameMs);
    this.reportStats(now, frameMs);
  };

  private draw(): void {
    this.camera.update(this.fixedTime ?? this.elapsed);
    this.pass.setCamera(this.camera);
    this.pass.setExposure(this.renderer.toneMappingExposure);
    this.pass.render(this.renderer);
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
    });

    this.statsWindowStart = now;
    this.statsFrames = 0;
    this.statsAccumMs = 0;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width || this.canvas.clientWidth);
    const cssHeight = Math.max(1, rect.height || this.canvas.clientHeight);

    const ratio = effectivePixelRatio(
      this.governor.current,
      cssWidth,
      cssHeight,
      typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    );

    this.renderer.setPixelRatio(ratio);
    // updateStyle = false: CSS owns the canvas's layout size. Letting three
    // write inline width/height styles would fight the stylesheet.
    this.renderer.setSize(cssWidth, cssHeight, false);

    // The driver is free to hand back a smaller buffer than asked for, so the
    // shader is told what was actually allocated, not what was requested.
    const gl = this.renderer.getContext();
    this.pass.setSize(gl.drawingBufferWidth, gl.drawingBufferHeight);

    // A resize reallocates the drawing buffer and costs a frame or two.
    this.governor.reset();
  }

  private readonly handleQualityChange = (profile: QualityProfile): void => {
    this.pass.setSkyFbmOctaves(profile.skyFbmOctaves);
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
    // re-establish our buffer size and get the loop going again.
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
