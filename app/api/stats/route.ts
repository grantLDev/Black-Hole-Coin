/**
 * GET /api/stats — the single data source for the renderer.
 *
 * Node runtime, because the bonding curve PDA derivation needs `node:crypto`
 * and because every secret in this project (HELIUS_API_KEY, KV_REST_API_TOKEN)
 * is read here and nowhere else.
 *
 * THE CONTRACT THIS ROUTE MAKES
 *
 *  - It never throws a 500. Every upstream call is wrapped; failure degrades to
 *    the last known good values with `source: "stale"` and `degraded: true`.
 *  - It never invents a number. A degraded payload repeats real values that
 *    were read earlier; it does not synthesise plausible ones.
 *  - Peaks only ever go up. `peakMarketCapUsd`, `peakHolders`, `tierIndex` and
 *    `graduated` are ratcheted in KV and are untouched by a degraded poll.
 *  - Visitor count does not drive API cost. Three layers stand between a page
 *    view and a paid call: the CDN (`s-maxage=15`), a module-scope TTL cache
 *    with in-flight de-duplication, and a KV snapshot that warms a cold
 *    instance so it never starts by firing an uncached `getProgramAccounts`.
 *
 * POLL BUDGET
 *
 *   market cap  15s TTL   1 credit  (getAccountInfo on the bonding curve PDA)
 *   holders     45s TTL  10 credits (getProgramAccounts, one call, any size)
 *   SOL/USD     60s TTL   0 credits (DexScreener, keyless)
 *
 * See README.md for the resulting monthly credit arithmetic.
 *
 * DEMO PARAMS (see the demo section below)
 *   ?demoTier=N   force at least tier N
 *   ?demoMcap=X   force the live market cap
 *   ?resetPeak=1  wipe the demo peaks
 */

import { NextResponse } from "next/server";

import { DEMO_MODE, MINT_ADDRESS, TOTAL_SUPPLY } from "@/config/token";
import { MAX_TIER_INDEX, TIERS } from "@/config/tiers";
import { cached, invalidate, peek, seedCache, withDeadline, type CacheEntry } from "@/lib/cache";
import {
  bondingProgress,
  decodeBondingCurve,
  marketCapUsd as curveMarketCapUsd,
  priceInSol,
  type BondingCurveState,
} from "@/lib/bondingCurve";
import { demoCurveState, demoSample } from "@/lib/demoFeed";
import { fetchDexQuote, fetchSolUsd } from "@/lib/dexscreener";
import { countHolders, fetchBondingCurveAccount, isHeliusConfigured } from "@/lib/helius";
import { kvGetJson, kvSetJson } from "@/lib/kv";
import {
  applyPeakUpdate,
  forceTier,
  markGraduated,
  readPeaks,
  resetPeaks,
  tierIndexFor,
  writePeaks,
  type PeakRecord,
} from "@/lib/peaks";
import type { Stats, StatsSource } from "@/lib/statsTypes";

export const runtime = "nodejs";
/**
 * The route reads query params, so it is dynamic regardless. Declaring it keeps
 * Next from trying to prerender it — the explicit Cache-Control below is what
 * actually does the caching, and an explicit header overrides the `no-store`
 * Next would otherwise attach to a dynamic route.
 */
export const dynamic = "force-dynamic";

const MARKET_CAP_TTL_MS = 15_000;
const HOLDERS_TTL_MS = 45_000;
const SOL_USD_TTL_MS = 60_000;

const CACHE_CONTROL = "s-maxage=15, stale-while-revalidate=60";

/**
 * Hard ceiling on the upstream gather, well inside Vercel's function limit.
 *
 * Individual timeouts compose: a curve read plus a DexScreener fallback plus a
 * holder count plus ITS fallback can serialise past any platform limit. Rather
 * than hand-tune that sum, the whole gather races this deadline and whatever
 * has not arrived is served from cache as stale.
 */
const UPSTREAM_DEADLINE_MS = 7_000;

const CACHE_KEY_MARKET = "live:market";
const CACHE_KEY_HOLDERS = "live:holders";
const CACHE_KEY_SOL_USD = "live:solUsd";

const SNAPSHOT_KEY_PREFIX = "singularity:live:v2";

// ---------------------------------------------------------------------------
// Live market data
// ---------------------------------------------------------------------------

interface LiveMarket {
  readonly marketCapUsd: number;
  readonly priceUsd: number;
  readonly graduated: boolean;
  readonly bondingProgress: number;
  readonly source: Extract<StatsSource, "curve" | "dexscreener">;
}

/**
 * Path A (primary, pre-graduation): read the bonding curve account and derive
 * the price from its virtual reserves. One `getAccountInfo`, 1 credit.
 *
 * Path B (fallback, and post-graduation): DexScreener's deepest pool.
 *
 * @throws only when BOTH paths fail. The caller's TTL cache turns that into a
 *         stale response rather than an error.
 */
async function fetchLiveMarket(mint: string, solUsd: number | null): Promise<LiveMarket> {
  let curve: BondingCurveState | null = null;
  // Distinguishing "the account is not there" from "we could not read it" is
  // load-bearing: absence implies graduation, failure implies nothing at all.
  let curveReadFailed = false;

  if (isHeliusConfigured()) {
    try {
      const raw = await fetchBondingCurveAccount(mint);
      curve = raw === null ? null : decodeBondingCurve(raw);
      // A non-null account that will not decode is a read failure, not an
      // absence — we must not conclude the token graduated from it.
      if (raw !== null && curve === null) curveReadFailed = true;
    } catch {
      curveReadFailed = true;
    }
  } else {
    curveReadFailed = true;
  }

  // Path A applies only to a live, SOL-quoted curve. `quote_mint` is a recent
  // addition to the account; on a non-SOL-quoted curve the reserve ratio is not
  // a SOL price and dollarising it would be silently wrong by whatever the
  // quote asset is worth.
  const curveIsUsable = curve !== null && !curve.complete && curve.quoteMintIsSol && solUsd !== null;

  if (curveIsUsable && curve !== null && solUsd !== null) {
    return {
      marketCapUsd: curveMarketCapUsd(curve, solUsd),
      priceUsd: priceInSol(curve) * solUsd,
      graduated: false,
      bondingProgress: bondingProgress(curve),
      source: "curve",
    };
  }

  try {
    const quote = await fetchDexQuote(mint);
    return {
      // DexScreener omits marketCap on some pools; fall back to price * supply
      // rather than reporting a zero the UI would have to special-case.
      marketCapUsd: quote.marketCapUsd > 0 ? quote.marketCapUsd : quote.priceUsd * TOTAL_SUPPLY,
      priceUsd: quote.priceUsd,
      graduated: curve !== null ? curve.complete : !curveReadFailed,
      bondingProgress: curve !== null ? bondingProgress(curve) : 1,
      source: "dexscreener",
    };
  } catch (dexError) {
    // DexScreener is down but we did read the curve. Its virtual reserves are
    // real on-chain data even on a completed curve (frozen at the graduation
    // price), so they beat nothing — as long as we can dollarise them.
    if (curve !== null && curve.quoteMintIsSol && solUsd !== null) {
      return {
        marketCapUsd: curveMarketCapUsd(curve, solUsd),
        priceUsd: priceInSol(curve) * solUsd,
        graduated: curve.complete,
        bondingProgress: bondingProgress(curve),
        source: "curve",
      };
    }
    throw dexError;
  }
}

// ---------------------------------------------------------------------------
// Cold-start snapshot
// ---------------------------------------------------------------------------

/**
 * Last known good live values, shared across instances through KV.
 *
 * Without this, every cold lambda would start with an empty module cache and
 * the first request would fire an uncached `getProgramAccounts` — the exact
 * thing the caching rules forbid. It also means a degraded response on a cold
 * instance still carries real numbers instead of zeroes.
 */
interface LiveSnapshot {
  market: LiveMarket;
  holders: number;
  solUsd: number;
  at: number;
}

let snapshotLoaded = false;

async function warmFromSnapshot(namespace: string): Promise<void> {
  if (snapshotLoaded) return;
  snapshotLoaded = true;

  const { value } = await kvGetJson<LiveSnapshot>(`${SNAPSHOT_KEY_PREFIX}:${namespace}`);
  if (!value || typeof value.at !== "number") return;

  // Seeded with the snapshot's own timestamp, so an old snapshot is immediately
  // treated as expired and refreshed rather than served as if it were fresh.
  if (value.market) seedCache(CACHE_KEY_MARKET, value.market, value.at);
  if (Number.isFinite(value.holders)) seedCache(CACHE_KEY_HOLDERS, value.holders, value.at);
  if (Number.isFinite(value.solUsd) && value.solUsd > 0) {
    seedCache(CACHE_KEY_SOL_USD, value.solUsd, value.at);
  }
}

async function saveSnapshot(namespace: string, snapshot: LiveSnapshot): Promise<void> {
  await kvSetJson(`${SNAPSHOT_KEY_PREFIX}:${namespace}`, snapshot);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse<Stats>> {
  const now = Date.now();
  const params = new URL(request.url).searchParams;

  const demoTier = parseOptionalInt(params.get("demoTier"));
  const demoMcap = parseOptionalNumber(params.get("demoMcap"));
  const resetPeak = params.get("resetPeak") === "1";

  // Any demo param puts the request on the demo namespace, so the overrides can
  // never reach the real mint's peaks — which is what makes them safe to leave
  // enabled in production.
  const demo = DEMO_MODE || demoTier !== null || demoMcap !== null || resetPeak;

  const stats = demo
    ? await demoStats({ now, demoTier, demoMcap, resetPeak })
    : await liveStats({ now });

  return NextResponse.json(stats, {
    headers: {
      "Cache-Control": CACHE_CONTROL,
      "Content-Type": "application/json",
    },
  });
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

async function liveStats({ now }: { now: number }): Promise<Stats> {
  const mint = MINT_ADDRESS;
  await warmFromSnapshot(mint);

  // SOL/USD first — the curve path cannot produce a dollar figure without it.
  // Holders do not depend on it, so that call starts now and is joined below.
  const holdersPromise = cached(
    CACHE_KEY_HOLDERS,
    HOLDERS_TTL_MS,
    async () => (await countHolders(mint)).holders,
    now,
  );

  const solEntry = await withDeadline(
    cached(CACHE_KEY_SOL_USD, SOL_USD_TTL_MS, fetchSolUsd, now),
    UPSTREAM_DEADLINE_MS,
    peek<number>(CACHE_KEY_SOL_USD),
  );
  const solUsd = solEntry?.value ?? null;

  // Whatever time the SOL lookup used comes out of the remaining budget, so a
  // slow first leg cannot push the total past the ceiling.
  const remaining = Math.max(500, UPSTREAM_DEADLINE_MS - (Date.now() - now));

  const [marketEntry, holdersEntry] = await Promise.all([
    withDeadline(
      cached(CACHE_KEY_MARKET, MARKET_CAP_TTL_MS, () => fetchLiveMarket(mint, solUsd), now),
      remaining,
      peek<LiveMarket>(CACHE_KEY_MARKET),
    ),
    withDeadline(holdersPromise, remaining, peek<number>(CACHE_KEY_HOLDERS)),
  ]);

  const marketFresh = marketEntry !== null && !marketEntry.stale;
  const holdersFresh = holdersEntry !== null && !holdersEntry.stale;

  const { record, backend } = await readPeaks(mint);
  let next = record;

  if (marketEntry !== null && marketEntry.value.graduated) {
    next = markGraduated(next, now);
  }

  // A stale sample repeats the previous value, which would satisfy the sustain
  // guard's "still within 3%" branch for free. Only a fresh reading advances
  // anything permanent.
  const update = applyPeakUpdate(next, {
    liveMarketCapUsd: marketEntry?.value.marketCapUsd ?? 0,
    liveHolders: holdersEntry?.value ?? 0,
    fresh: marketFresh && holdersFresh,
    now,
  });
  next = update.record;

  const peaksChanged = update.changed || next.graduatedAt !== record.graduatedAt;
  if (peaksChanged) await writePeaks(mint, next);

  if (marketFresh && holdersFresh && marketEntry !== null && holdersEntry !== null) {
    await saveSnapshot(mint, {
      market: marketEntry.value,
      holders: holdersEntry.value,
      solUsd: solUsd ?? 0,
      at: now,
    });
  }

  return assemble({
    now,
    peaks: next,
    market: marketEntry,
    holders: holdersEntry,
    solUsd: solUsd ?? 0,
    degraded: !marketFresh || !holdersFresh || backend === "memory",
  });
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

interface DemoOptions {
  now: number;
  demoTier: number | null;
  demoMcap: number | null;
  resetPeak: boolean;
}

/**
 * The simulated feed, running against a `demo` peak namespace that is entirely
 * separate from the real mint's.
 *
 * The overrides compose, and they compose one way:
 *
 *   ?demoTier=N              raise to at least tier N. Like every other tier
 *                            movement in this project it cannot demote, so
 *                            asking for a lower tier than the namespace has
 *                            already reached does nothing.
 *   ?resetPeak=1&demoTier=N  reset first, then force — this is how you drop a
 *                            tier, and how you replay a specific transition.
 *   ?demoMcap=X              pin the live market cap. Still goes through the
 *                            sustain guard, so holding X above the peak for
 *                            three polls is what actually unlocks the tier —
 *                            which is the behaviour worth testing.
 */
async function demoStats({ now, demoTier, demoMcap, resetPeak }: DemoOptions): Promise<Stats> {
  const namespace = "demo";
  const sample = demoSample(now);

  if (resetPeak) {
    await resetPeaks(namespace);
    invalidate(CACHE_KEY_MARKET);
    invalidate(CACHE_KEY_HOLDERS);
  }

  const { record, backend } = await readPeaks(namespace);

  let next = record;
  if (demoTier !== null) {
    const clamped = Math.min(MAX_TIER_INDEX, Math.max(0, demoTier));
    next = forceTier(next, clamped, TIERS[clamped].threshold, now);
  }

  // With a forced tier, drag the live market cap up to match so the HUD is not
  // showing tier 11 next to a $3K market cap.
  const forcedFloor =
    demoTier !== null ? TIERS[Math.min(MAX_TIER_INDEX, Math.max(0, demoTier))].threshold * 1.02 : 0;
  const liveMarketCapUsd = demoMcap ?? Math.max(sample.marketCapUsd, forcedFloor);

  const update = applyPeakUpdate(next, {
    liveMarketCapUsd,
    liveHolders: sample.holders,
    fresh: true,
    now,
  });
  next = update.record;

  const curve = demoCurveState(next.peakMarketCapUsd);
  if (curve.graduated) next = markGraduated(next, now);

  await writePeaks(namespace, next);

  return {
    liveMarketCapUsd,
    liveHolders: sample.holders,
    peakMarketCapUsd: next.peakMarketCapUsd,
    peakHolders: next.peakHolders,
    tierIndex: tierIndexFor(next),
    priceUsd: liveMarketCapUsd / TOTAL_SUPPLY,
    solUsd: sample.solUsd,
    graduated: next.graduatedAt > 0,
    bondingProgress: curve.bondingProgress,
    source: "demo",
    updatedAt: now,
    // The demo feed cannot fail, so the only thing that can degrade it is KV
    // being unreachable — in which case the peaks are per-instance and a
    // tier-up you just tested may not survive the next request.
    degraded: backend === "memory",
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface AssembleInput {
  now: number;
  peaks: PeakRecord;
  market: CacheEntry<LiveMarket> | null;
  holders: CacheEntry<number> | null;
  solUsd: number;
  degraded: boolean;
}

/**
 * Build the payload, guaranteeing every numeric field is finite.
 *
 * When a live value is missing entirely — a cold instance whose every upstream
 * failed and which had no KV snapshot to warm from — it falls back to the
 * corresponding ratcheted peak. That is still a real number this token actually
 * reached, not a fabricated one. Zero appears only when nothing has ever been
 * read successfully, which for an unlaunched token is simply the truth.
 */
function assemble({ now, peaks, market, holders, solUsd, degraded }: AssembleInput): Stats {
  const stale = market === null || market.stale || holders === null || holders.stale;

  const liveMarketCapUsd = finite(market?.value.marketCapUsd, peaks.peakMarketCapUsd);
  const liveHolders = Math.max(0, Math.floor(finite(holders?.value, peaks.peakHolders)));

  const source: StatsSource = stale ? "stale" : (market?.value.source ?? "stale");

  return {
    liveMarketCapUsd,
    liveHolders,
    peakMarketCapUsd: peaks.peakMarketCapUsd,
    peakHolders: peaks.peakHolders,
    tierIndex: tierIndexFor(peaks),
    priceUsd: finite(market?.value.priceUsd, 0),
    solUsd: finite(solUsd, 0),
    graduated: peaks.graduatedAt > 0 || (market?.value.graduated ?? false),
    bondingProgress: clamp01(finite(market?.value.bondingProgress, 0)),
    source,
    // The age of the data, not the age of the request — a stale payload says so.
    updatedAt: market?.fetchedAt ?? now,
    degraded: degraded || stale,
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseOptionalInt(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
