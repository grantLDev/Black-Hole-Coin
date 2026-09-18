/**
 * THE RATCHET.
 *
 * Everything permanent about the black hole lives here. Two peaks are tracked,
 * and they are tracked differently on purpose:
 *
 *   peakHolders       committed immediately. Holder count does not wick — a
 *                     wallet either opened a token account or it did not.
 *
 *   peakMarketCapUsd  gated by a SUSTAIN GUARD. Price does wick, and a single
 *                     block of thin-liquidity buying must not permanently
 *                     unlock a tier the token never actually held.
 *
 * The guard, run once per poll:
 *
 *     live > candidatePeak          -> candidatePeak = live, streak = 1
 *     live >= candidatePeak * 0.97  -> streak += 1
 *     otherwise                     -> streak = 0, candidatePeak = live
 *     streak >= 3 && candidate > peak -> commit
 *
 * At the route's 15s market-cap TTL that is ~45s of sustained price above the
 * old peak before it counts: long enough to reject a one-block spike, short
 * enough that a real breakout registers inside a minute.
 *
 * `tierIndex` is derived from the committed peak and additionally floored by
 * the last committed tier, so there is no code path — not a KV hiccup, not a
 * decode error, not a rounding change to the tier table — that can lower it.
 */

import { MAX_TIER_INDEX, tierForAthMarketCap } from "@/config/tiers";
import { kvDelete, kvGetJson, kvSetJson, type KvBackend } from "./kv";

/** Fraction of the candidate peak that still counts as "holding up there". */
const SUSTAIN_TOLERANCE = 0.97;
/** Consecutive sustained polls required before a new peak commits. */
const SUSTAIN_POLLS_REQUIRED = 3;

const KEY_PREFIX = "singularity:peaks:v2";

export interface PeakRecord {
  peakMarketCapUsd: number;
  peakHolders: number;
  peakTierIndex: number;
  /** The high-water mark currently being tested by the sustain guard. */
  candidatePeak: number;
  /** How many consecutive polls `candidatePeak` has held. */
  candidateStreak: number;
  /** Epoch ms at which `peakMarketCapUsd` last committed. */
  peakSetAt: number;
  /**
   * Epoch ms at which the bonding curve was first observed complete; 0 while it
   * has not been. Graduation is a one-way event on chain, so it is stored with
   * the other permanent milestones rather than recomputed per request — that
   * way a transient RPC failure cannot un-graduate the token.
   */
  graduatedAt: number;
}

export const EMPTY_PEAKS: PeakRecord = {
  peakMarketCapUsd: 0,
  peakHolders: 0,
  peakTierIndex: 0,
  candidatePeak: 0,
  candidateStreak: 0,
  peakSetAt: 0,
  graduatedAt: 0,
};

/**
 * KV key for a namespace. Demo runs are namespaced separately from the real
 * mint so that `?demoTier=` and `?resetPeak=1` can never touch production
 * peaks — that isolation is the whole reason the demo params are safe to leave
 * enabled in production.
 */
export function peaksKey(namespace: string): string {
  return `${KEY_PREFIX}:${namespace}`;
}

/** Coerce anything read out of KV into a usable record. */
function sanitise(raw: unknown): PeakRecord {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY_PEAKS };
  const record = raw as Partial<PeakRecord>;
  const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

  return {
    peakMarketCapUsd: number(record.peakMarketCapUsd),
    peakHolders: Math.floor(number(record.peakHolders)),
    peakTierIndex: Math.min(MAX_TIER_INDEX, Math.floor(number(record.peakTierIndex))),
    candidatePeak: number(record.candidatePeak),
    candidateStreak: Math.floor(number(record.candidateStreak)),
    peakSetAt: number(record.peakSetAt),
    graduatedAt: number(record.graduatedAt),
  };
}

export interface PeakReadResult {
  readonly record: PeakRecord;
  readonly backend: KvBackend;
}

export async function readPeaks(namespace: string): Promise<PeakReadResult> {
  const { value, backend } = await kvGetJson<PeakRecord>(peaksKey(namespace));
  return { record: sanitise(value), backend };
}

export async function writePeaks(namespace: string, record: PeakRecord): Promise<KvBackend> {
  return kvSetJson(peaksKey(namespace), record);
}

/** Wipe a namespace's peaks. Only ever called for a demo namespace. */
export async function resetPeaks(namespace: string): Promise<KvBackend> {
  return kvDelete(peaksKey(namespace));
}

/** The tier a record implies — the derived tier, floored by the committed one. */
export function tierIndexFor(record: PeakRecord): number {
  const derived = tierForAthMarketCap(record.peakMarketCapUsd).index;
  return Math.min(MAX_TIER_INDEX, Math.max(derived, record.peakTierIndex));
}

export interface PeakUpdate {
  readonly liveMarketCapUsd: number;
  readonly liveHolders: number;
  /**
   * False when the live values are last-known-good rather than a fresh read.
   *
   * A stale sample repeats the previous value, which trivially satisfies the
   * "still within 3% of the candidate" branch and would let an outage launder a
   * wick into a committed peak. So a stale poll advances nothing.
   */
  readonly fresh: boolean;
  readonly now: number;
}

/**
 * Apply one poll to a peak record.
 *
 * Pure: returns a new record and whether anything changed, so the caller can
 * skip the KV write when nothing moved. Never returns a record whose peaks or
 * tier are lower than the input's.
 */
export function applyPeakUpdate(
  previous: PeakRecord,
  update: PeakUpdate,
): { record: PeakRecord; changed: boolean } {
  const { liveMarketCapUsd, liveHolders, fresh, now } = update;
  const next: PeakRecord = { ...previous };
  let changed = false;

  // --- holders: immediate, no guard ----------------------------------------
  if (fresh && Number.isFinite(liveHolders) && liveHolders > next.peakHolders) {
    next.peakHolders = Math.floor(liveHolders);
    changed = true;
  }

  // --- market cap: sustain-guarded -----------------------------------------
  if (fresh && Number.isFinite(liveMarketCapUsd) && liveMarketCapUsd > 0) {
    if (liveMarketCapUsd > next.candidatePeak) {
      next.candidatePeak = liveMarketCapUsd;
      next.candidateStreak = 1;
    } else if (liveMarketCapUsd >= next.candidatePeak * SUSTAIN_TOLERANCE) {
      next.candidateStreak += 1;
    } else {
      next.candidateStreak = 0;
      next.candidatePeak = liveMarketCapUsd;
    }
    changed = true;

    if (
      next.candidateStreak >= SUSTAIN_POLLS_REQUIRED &&
      next.candidatePeak > next.peakMarketCapUsd
    ) {
      next.peakMarketCapUsd = next.candidatePeak;
      next.peakSetAt = now;
    }
  }

  // --- tier: monotonic, always ---------------------------------------------
  const tier = tierIndexFor(next);
  if (tier !== next.peakTierIndex) {
    next.peakTierIndex = tier;
    changed = true;
  }

  return { record: next, changed };
}

/**
 * Record graduation. One-directional: once set, later calls are no-ops.
 */
export function markGraduated(previous: PeakRecord, now: number): PeakRecord {
  return previous.graduatedAt > 0 ? previous : { ...previous, graduatedAt: now };
}

/**
 * Force a record to at least a given tier, bypassing the sustain guard.
 *
 * Demo only — this is what `?demoTier=N` calls. It raises the peak to the
 * tier's threshold; it never lowers anything, so forcing a lower tier than the
 * namespace has already reached is a no-op by design. Use `?resetPeak=1` to
 * actually go back down.
 */
export function forceTier(
  previous: PeakRecord,
  tierIndex: number,
  threshold: number,
  now: number,
): PeakRecord {
  const clamped = Math.min(MAX_TIER_INDEX, Math.max(0, Math.floor(tierIndex)));
  const target = Math.max(previous.peakMarketCapUsd, threshold);

  return {
    ...previous,
    peakMarketCapUsd: target,
    candidatePeak: Math.max(previous.candidatePeak, target),
    candidateStreak: SUSTAIN_POLLS_REQUIRED,
    peakTierIndex: Math.max(previous.peakTierIndex, clamped),
    peakSetAt: target > previous.peakMarketCapUsd ? now : previous.peakSetAt,
  };
}
