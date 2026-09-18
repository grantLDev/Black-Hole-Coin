"use client";

/**
 * Client-side poller for `/api/stats`.
 *
 * Deliberately a self-scheduling `setTimeout` chain rather than `setInterval`:
 * the interval is not constant. It changes with tab visibility and with the
 * error backoff, and a timeout chain also guarantees the next poll is scheduled
 * from the END of the previous one, so a slow response can never stack requests.
 *
 *   visible tab   5s
 *   hidden tab   15s   — nothing is being rendered, so nothing needs updating
 *   on error     exponential from 5s, doubling to a 60s ceiling
 *
 * Note that this hook intentionally carries no smoothing or damping. It reports
 * what the server said. The asymmetric damping of the holder-driven camera
 * distance belongs in the render loop, where it can be frame-rate independent —
 * putting it here would tie the easing to the poll interval.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isStats, type Stats } from "./statsTypes";

const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 15_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
/** A poll that has not answered in this long is treated as failed. */
const REQUEST_TIMEOUT_MS = 12_000;

export interface UseStatsResult {
  /** Most recent successful payload, or null before the first one lands. */
  stats: Stats | null;
  /** True while the most recent poll succeeded. */
  connected: boolean;
  /** Message from the most recent failure, cleared by the next success. */
  lastError: string | null;
}

export function useStats(endpoint = "/api/stats"): UseStatsResult {
  const [stats, setStats] = useState<Stats | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  // Refs, not state: changing these must not re-render, and the polling loop
  // has to read the current value rather than one closed over at mount.
  const failuresRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  const nextDelay = useCallback((): number => {
    const failures = failuresRef.current;
    if (failures > 0) {
      return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    }
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    return hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS;
  }, []);

  const poll = useCallback(async (): Promise<void> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        signal: controller.signal,
        // The CDN, not the browser, is where this response is meant to be
        // cached — a browser cache would hide the 15s server-side refresh.
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`stats: HTTP ${response.status}`);

      const payload: unknown = await response.json();
      if (!isStats(payload)) throw new Error("stats: malformed payload");

      if (!mountedRef.current) return;
      failuresRef.current = 0;
      setStats(payload);
      setConnected(true);
      setLastError(null);
    } catch (error) {
      // An abort from unmount or from the next poll is not a failure.
      if (controller.signal.aborted && !mountedRef.current) return;
      if (!mountedRef.current) return;

      failuresRef.current += 1;
      setConnected(false);
      setLastError(error instanceof Error ? error.message : "stats: unknown error");
    } finally {
      clearTimeout(timeout);
    }
  }, [endpoint]);

  useEffect(() => {
    mountedRef.current = true;

    const schedule = (delay: number) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(run, delay);
    };

    async function run(): Promise<void> {
      await poll();
      if (!mountedRef.current) return;
      schedule(nextDelay());
    }

    void run();

    // Coming back to the tab should show live data immediately, not after up to
    // 15 more seconds. Poll at once — unless we are in error backoff, where
    // that would defeat the backoff.
    const onVisibilityChange = () => {
      if (!mountedRef.current) return;
      if (document.visibilityState === "visible" && failuresRef.current === 0) {
        schedule(0);
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [poll, nextDelay]);

  return { stats, connected, lastError };
}
