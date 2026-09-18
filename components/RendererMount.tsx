"use client";

/**
 * Attaches the renderer to the canvas that `app/page.tsx` server-renders.
 *
 * This component renders no canvas of its own on purpose. The canvas is in the
 * server-rendered markup so the black frame is painted on first byte with no
 * white flash before hydration; this component's only job is to find it and
 * hand it to the renderer.
 *
 * It renders a debug overlay when the URL carries `?debug`, and a legible
 * message if WebGL2 is unavailable — an unexplained black rectangle is the
 * worst possible failure mode for a site that is nothing but a canvas.
 *
 * The tier here comes from the URL, not from on-chain data. Binding the live
 * feed is a later prompt; what exists today is the whole path from a tier index
 * through the smoothing in VisualState to the shader's uniforms, which is the
 * part that has to be right before real data is pointed at it.
 */

import { useEffect, useState } from "react";
import { SINGULARITY_CANVAS_ID } from "@/lib/gl/canvas";
import { createRenderer, type RendererStats, type SingularityRenderer } from "@/lib/gl/Renderer";
import type { QualityTier } from "@/lib/gl/quality";
import { MAX_TIER_INDEX } from "@/config/tiers";

const QUALITY_TIERS: readonly string[] = ["low", "medium", "high"];

/** Buffer size the `?bench` harness pins, in device pixels. */
const BENCH_WIDTH = 1920;
const BENCH_HEIGHT = 1080;
/**
 * Frames discarded before measuring: shader compile, first draw into a fresh
 * buffer, and the driver's own warm-up.
 *
 * Counted in FRAMES, not milliseconds. A fixed millisecond warm-up is a
 * hardware assumption in disguise: two seconds is 120 frames on a GPU and less
 * than one on a software rasteriser, so the same constant either wastes most
 * of the run or fails to skip the compile hitch.
 */
const BENCH_WARMUP_FRAMES = 12;
/** Frames measured. At 60fps this is two seconds. */
const BENCH_SAMPLE_FRAMES = 120;
/** Wall-clock ceiling, so a very slow renderer still reports something. */
const BENCH_MAX_MS = 45_000;
/** Fewest samples worth reporting at all. */
const BENCH_MIN_FRAMES = 4;
/**
 * Outlier rejection, as a multiple of the running median.
 *
 * Relative rather than absolute for the same reason the warm-up is in frames.
 * An absolute "discard frames over 250ms" correctly rejects a GC pause at
 * 60fps and silently discards EVERY frame on a software rasteriser, which
 * reports no result rather than a slow one.
 */
const BENCH_OUTLIER_FACTOR = 4;

/** What `?bench` publishes on `window` for an external harness to read. */
export interface BenchResult {
  readonly width: number;
  readonly height: number;
  readonly quality: QualityTier;
  readonly marchSteps: number;
  readonly frames: number;
  /** Frames rejected as stalls, against the run's own median. */
  readonly discarded: number;
  readonly meanFrameMs: number;
  readonly medianFrameMs: number;
  readonly p95FrameMs: number;
  readonly fps: number;
  readonly renderer: string;
  /** Whether the post chain was running during the measured frames. */
  readonly post: boolean;
}

/** One composited frame, read back as tightly packed top-down RGBA rows. */
export interface CapturedFrame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

declare global {
  interface Window {
    __singularityBench?: BenchResult;
    /**
     * Present on `?debug` and `?bench` pages only. Null when post is off.
     *
     * `noiseScale` of 0 renders the frame without grain or dither, which is
     * what the banding check measures against.
     */
    __singularityCapture?: (noiseScale?: number) => CapturedFrame | null;
  }
}

function readQuality(params: URLSearchParams): QualityTier | undefined {
  const value = params.get("quality");
  return value !== null && QUALITY_TIERS.includes(value) ? (value as QualityTier) : undefined;
}

function readNumber(params: URLSearchParams, key: string): number | undefined {
  const value = Number(params.get(key));
  return params.has(key) && Number.isFinite(value) ? value : undefined;
}

/**
 * `?post=0` / `?post=1`, the brief's single kill switch exposed on the URL.
 *
 * A bare `?post` reads as on, which is what anyone typing it by hand means.
 * Anything else is left undefined so the quality profile decides.
 */
function readPost(params: URLSearchParams): boolean | undefined {
  if (!params.has("post")) return undefined;
  const value = params.get("post");
  if (value === null || value === "" || value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function readTier(params: URLSearchParams): number | undefined {
  const value = readNumber(params, "tier");
  return value === undefined ? undefined : Math.min(Math.max(Math.round(value), 0), MAX_TIER_INDEX);
}

/** Unmasked GPU string, for labelling a benchmark honestly. */
function describeRenderer(canvas: HTMLCanvasElement): string {
  const gl = canvas.getContext("webgl2");
  if (!gl) return "unknown";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  if (!info) return "unknown (WEBGL_debug_renderer_info unavailable)";
  return String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "unknown");
}

export default function RendererMount() {
  const [stats, setStats] = useState<RendererStats | null>(null);
  const [debug, setDebug] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = document.getElementById(SINGULARITY_CANVAS_ID);
    if (!(canvas instanceof HTMLCanvasElement)) {
      setError("Could not find the drawing surface.");
      return;
    }

    // Read from the URL rather than NODE_ENV: the quality governor's behaviour
    // on a real device is exactly what needs inspecting in production.
    //
    //   ?debug           frame time, tier, and buffer size overlay
    //   ?quality=low     pin a quality tier instead of detecting one
    //   ?t=33.4          freeze scene time, for inspecting one fixed view
    //   ?tier=9          pin a market-cap tier, 0..11 (jets unlock at 9)
    //   ?fov=38          vertical field of view in degrees
    //   ?steps=140       override the march budget, under the compiled ceiling
    //   ?post=0          force the post chain off (?post=1 forces it on)
    //   ?bench           pin a 1920x1080 buffer and measure frame time
    const params = new URLSearchParams(window.location.search);
    const wantDebug = params.has("debug");
    const wantBench = params.has("bench");
    setDebug(wantDebug || wantBench);

    let renderer: SingularityRenderer;
    try {
      renderer = createRenderer({
        canvas,
        quality: readQuality(params),
        fixedTime: readFixedTime(params),
        tier: readTier(params),
        post: readPost(params),
        bufferSize: wantBench ? { width: BENCH_WIDTH, height: BENCH_HEIGHT } : undefined,
        // A benchmark that lets the governor step down mid-run is measuring two
        // different shaders and averaging them. Only `?bench` locks the tier;
        // `?quality=` still picks a starting point and lets the governor work,
        // because watching it degrade on a real device is the point of pinning.
        lockQuality: wantBench,
        onStats: wantDebug || wantBench ? setStats : undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The renderer failed to start.");
      return;
    }

    const fov = readNumber(params, "fov");
    if (fov !== undefined) renderer.setFov(fov);

    const steps = readNumber(params, "steps");
    if (steps !== undefined) renderer.setQualitySteps(steps);

    const stopBench = wantBench ? startBenchmark(renderer, canvas) : undefined;

    // The banding harness in scripts/banding.ts drives this. Exposed only when
    // the page was asked for a debug or bench run, so a production page has no
    // handle on the renderer at all.
    if (wantDebug || wantBench) {
      window.__singularityCapture = (noiseScale = 1) => renderer.captureFrame(noiseScale);
    }

    return () => {
      delete window.__singularityCapture;
      stopBench?.();
      renderer.dispose();
    };
  }, []);

  if (error) {
    return (
      <div className="pointer-events-none absolute inset-0 grid place-items-center p-8">
        <p className="max-w-sm text-center text-sm leading-relaxed text-white/50">{error}</p>
      </div>
    );
  }

  if (!debug || !stats) return null;

  return (
    <pre className="pointer-events-none absolute bottom-3 left-3 m-0 font-mono text-[11px] leading-[1.45] text-white/35 tabular-nums">
      {stats.fps.toFixed(1)} fps · {stats.frameMs.toFixed(1)} ms{"\n"}
      {stats.quality} · dpr {stats.pixelRatio.toFixed(2)} · {stats.marchSteps} steps
      {"\n"}
      {stats.bufferWidth}×{stats.bufferHeight}
      {"\n"}
      post {stats.post ? `on · ${stats.bloomLevels} bloom levels` : "off"}
    </pre>
  );
}

function readFixedTime(params: URLSearchParams): number | undefined {
  return readNumber(params, "t");
}

/**
 * Measure frame time at a pinned buffer size and publish the result.
 *
 * It times `requestAnimationFrame` deltas rather than wrapping the draw call,
 * which measures the whole frame — CPU submission, GPU execution, and present —
 * the way a viewer experiences it. A `gl.finish()` around the draw would give a
 * tighter GPU number and a worse answer, since it serialises a pipeline that
 * normally overlaps.
 *
 * Outliers are rejected against the median of the run rather than a fixed
 * millisecond threshold, so the same harness reports honestly on a GPU at
 * 60fps and on a software rasteriser at 0.4fps.
 */
function startBenchmark(renderer: SingularityRenderer, canvas: HTMLCanvasElement): () => void {
  const deltas: number[] = [];
  const start = performance.now();
  let previous = start;
  let frames = 0;
  let rafId = 0;
  let done = false;

  const finish = (): void => {
    done = true;
    if (deltas.length < BENCH_MIN_FRAMES) {
      console.warn("[singularity] bench: too few frames to report", deltas.length);
      return;
    }

    const sorted = [...deltas].sort((a, b) => a - b);
    const rawMedian = sorted[Math.floor(sorted.length / 2)];
    // Now that the run's own scale is known, drop the stalls.
    const kept = deltas.filter((value) => value <= rawMedian * BENCH_OUTLIER_FACTOR);
    const keptSorted = [...kept].sort((a, b) => a - b);

    const mean = kept.reduce((sum, value) => sum + value, 0) / kept.length;
    const median = keptSorted[Math.floor(keptSorted.length / 2)];
    const p95 = keptSorted[Math.min(keptSorted.length - 1, Math.floor(keptSorted.length * 0.95))];

    const result: BenchResult = {
      width: BENCH_WIDTH,
      height: BENCH_HEIGHT,
      quality: renderer.quality,
      marchSteps: renderer.marchSteps,
      frames: kept.length,
      discarded: deltas.length - kept.length,
      meanFrameMs: mean,
      medianFrameMs: median,
      p95FrameMs: p95,
      fps: 1000 / median,
      renderer: describeRenderer(canvas),
      post: renderer.postEnabled,
    };

    window.__singularityBench = result;
    console.info("[singularity] bench", result);
  };

  const tick = (now: number): void => {
    const delta = now - previous;
    previous = now;
    frames += 1;

    if (frames > BENCH_WARMUP_FRAMES && delta > 0) deltas.push(delta);

    const enough = deltas.length >= BENCH_SAMPLE_FRAMES;
    const expired = now - start > BENCH_MAX_MS && deltas.length >= BENCH_MIN_FRAMES;
    if (enough || expired) {
      finish();
      return;
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return () => {
    if (!done) cancelAnimationFrame(rafId);
  };
}
