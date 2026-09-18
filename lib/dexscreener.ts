/**
 * DexScreener — free, keyless, ~300 req/min. Two jobs:
 *
 *  1. SOL/USD, which the bonding curve path needs to turn a SOL price into a
 *     dollar market cap.
 *  2. Post-graduation market cap and price, and the fallback for any time the
 *     bonding curve path throws.
 *
 * Pair selection is always "highest USD liquidity", and always filtered to
 * pairs where the token we asked about is the BASE token. That filter is not
 * optional: `/latest/dex/tokens/{addr}` also returns pairs where the address is
 * the quote side, and those report the OTHER token's price in `priceUsd`. Take
 * the naive highest-liquidity pair and you will occasionally price SOL at
 * $0.000004.
 */

import { fetchWithTimeout } from "./cache";
import { WSOL_MINT } from "./bondingCurve";

const DEXSCREENER_TIMEOUT_MS = 4_000;
const BASE_URL = "https://api.dexscreener.com/latest/dex/tokens";

interface DexPair {
  readonly chainId?: string;
  readonly pairAddress?: string;
  readonly baseToken?: { address?: string; symbol?: string };
  readonly quoteToken?: { address?: string; symbol?: string };
  readonly priceUsd?: string;
  readonly liquidity?: { usd?: number };
  readonly marketCap?: number;
  readonly fdv?: number;
}

export interface DexQuote {
  readonly priceUsd: number;
  readonly marketCapUsd: number;
  readonly liquidityUsd: number;
  readonly pairAddress: string | null;
}

/**
 * Fetch and rank the pairs for a mint.
 *
 * @throws on network failure, non-200, or when no usable Solana pair exists.
 *         Callers are expected to catch and degrade — see `lib/cache.ts`.
 */
async function fetchPairs(mint: string): Promise<DexPair[]> {
  const response = await fetchWithTimeout(
    `${BASE_URL}/${mint}`,
    { headers: { accept: "application/json" } },
    DEXSCREENER_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`dexscreener: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { pairs?: DexPair[] | null };
  const pairs = body?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error("dexscreener: no pairs returned");
  }
  return pairs;
}

/** The Solana pair with the deepest USD liquidity in which `mint` is the base. */
function bestPair(pairs: DexPair[], mint: string): DexPair {
  const candidates = pairs.filter(
    (pair) =>
      (pair.chainId === undefined || pair.chainId === "solana") &&
      pair.baseToken?.address === mint &&
      Number(pair.priceUsd) > 0,
  );
  if (candidates.length === 0) {
    throw new Error("dexscreener: no pair with this mint as base token");
  }

  return candidates.reduce((best, pair) =>
    (pair.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? pair : best,
  );
}

/** Live price and market cap for a mint, from its deepest pool. */
export async function fetchDexQuote(mint: string): Promise<DexQuote> {
  const pair = bestPair(await fetchPairs(mint), mint);

  const priceUsd = Number(pair.priceUsd);
  // `marketCap` accounts for burnt/locked supply; `fdv` is the fallback because
  // DexScreener omits marketCap on some pools.
  const marketCapUsd = Number(pair.marketCap ?? pair.fdv ?? 0);

  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error("dexscreener: pair has no usable priceUsd");
  }

  return {
    priceUsd,
    marketCapUsd: Number.isFinite(marketCapUsd) && marketCapUsd > 0 ? marketCapUsd : 0,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    pairAddress: pair.pairAddress ?? null,
  };
}

/**
 * SOL in USD, taken from the deepest wrapped-SOL pool.
 *
 * @throws if DexScreener is unreachable or returns nothing sane. The caller
 *         caches this for 60s and keeps the last good value on failure.
 */
export async function fetchSolUsd(): Promise<number> {
  const pair = bestPair(await fetchPairs(WSOL_MINT), WSOL_MINT);
  const price = Number(pair.priceUsd);

  // A sanity band, not a guess: it rejects a decimal-shifted or
  // wrong-side-of-the-pair reading without ever inventing a price.
  if (!Number.isFinite(price) || price < 1 || price > 100_000) {
    throw new Error(`dexscreener: implausible SOL price ${price}`);
  }
  return price;
}
