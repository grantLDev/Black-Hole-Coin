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
 */

import { useEffect, useState } from "react";
import { SINGULARITY_CANVAS_ID } from "@/lib/gl/canvas";
import { createRenderer, type RendererStats, type SingularityRenderer } from "@/lib/gl/Renderer";
import type { QualityTier } from "@/lib/gl/quality";

const QUALITY_TIERS: readonly string[] = ["low", "medium", "high"];

function readQuality(params: URLSearchParams): QualityTier | undefined {
  const value = params.get("quality");
  return value !== null && QUALITY_TIERS.includes(value) ? (value as QualityTier) : undefined;
}

function readFixedTime(params: URLSearchParams): number | undefined {
  const value = Number(params.get("t"));
  return params.has("t") && Number.isFinite(value) ? value : undefined;
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
    //   ?quality=low     pin a tier instead of detecting one
    //   ?t=33.4          freeze scene time, for inspecting one fixed view
    const params = new URLSearchParams(window.location.search);
    const wantDebug = params.has("debug");
    setDebug(wantDebug);

    let renderer: SingularityRenderer;
    try {
      renderer = createRenderer({
        canvas,
        quality: readQuality(params),
        fixedTime: readFixedTime(params),
        onStats: wantDebug ? setStats : undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The renderer failed to start.");
      return;
    }

    return () => {
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
      {stats.quality} · dpr {stats.pixelRatio.toFixed(2)}
      {"\n"}
      {stats.bufferWidth}×{stats.bufferHeight}
    </pre>
  );
}
