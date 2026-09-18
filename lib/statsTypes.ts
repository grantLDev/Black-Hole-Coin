/**
 * The wire contract between `/api/stats` and the renderer.
 *
 * Imported by both the route handler and the client hook, so it must stay free
 * of server-only imports and of anything secret.
 */

/**
 * Where the live numbers in this payload came from.
 *
 *  - `curve`       pump.fun bonding curve account, read directly from chain.
 *  - `dexscreener` a live AMM pool — post-graduation, or the curve path failed.
 *  - `demo`        the simulator. No chain was contacted.
 *  - `stale`       every upstream failed; these are the last known good values.
 */
export type StatsSource = "curve" | "dexscreener" | "demo" | "stale";

export interface Stats {
  /** Live market cap in USD. Drives nothing ratcheted — display only. */
  liveMarketCapUsd: number;
  /** Live holder count. Drives camera distance, asymmetrically damped client-side. */
  liveHolders: number;
  /** All-time-high market cap, sustain-guarded. Only ever increases. */
  peakMarketCapUsd: number;
  /** All-time-high holder count. Only ever increases. */
  peakHolders: number;
  /** Derived from `peakMarketCapUsd`. Monotonic by construction. */
  tierIndex: number;
  /** Live price of one token in USD. */
  priceUsd: number;
  /** Live SOL/USD, used to dollarise the bonding curve price. */
  solUsd: number;
  /** True once the bonding curve completed and liquidity migrated to an AMM. */
  graduated: boolean;
  /** 0..1 along the bonding curve. Only meaningful while `graduated` is false. */
  bondingProgress: number;
  source: StatsSource;
  /** Epoch ms at which the live values were produced. */
  updatedAt: number;
  /**
   * True when something upstream is unavailable and the payload is running on
   * last-known-good values, an in-memory peak store, or both. The numbers are
   * still safe to render — this flags reduced confidence, not garbage.
   */
  degraded: boolean;
}

/** Everything the UI needs, with nothing ever null or NaN. */
export function isStats(value: unknown): value is Stats {
  if (typeof value !== "object" || value === null) return false;
  const stats = value as Record<string, unknown>;
  const numbers = [
    "liveMarketCapUsd",
    "liveHolders",
    "peakMarketCapUsd",
    "peakHolders",
    "tierIndex",
    "priceUsd",
    "solUsd",
    "bondingProgress",
    "updatedAt",
  ];
  return (
    numbers.every((key) => typeof stats[key] === "number" && Number.isFinite(stats[key] as number)) &&
    typeof stats.graduated === "boolean" &&
    typeof stats.degraded === "boolean" &&
    typeof stats.source === "string"
  );
}
