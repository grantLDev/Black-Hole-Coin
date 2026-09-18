/**
 * Module-scope caching for the stats route.
 *
 * Three jobs, all of which exist so that visitor count never drives API cost:
 *
 *  1. TTL memoisation, so a burst of requests inside one TTL window costs one
 *     upstream call.
 *  2. In-flight de-duplication, so N concurrent cold requests also cost one
 *     upstream call rather than N.
 *  3. Last-known-good retention. When the fetcher throws, the previous value is
 *     handed back marked `stale` instead of the error propagating. This is what
 *     lets the route promise it never returns 0 or null for a number the UI
 *     reads.
 *
 * Lives for the lifetime of a warm serverless instance. It is a cost optimiser,
 * not a source of truth — anything that must survive a cold start belongs in KV.
 */

export interface CacheEntry<T> {
  readonly value: T;
  /** Epoch ms at which `value` was fetched from upstream. */
  readonly fetchedAt: number;
  /** True when the TTL has expired and a refresh failed, so this is old data. */
  readonly stale: boolean;
}

interface Slot<T> {
  value: T | undefined;
  fetchedAt: number;
  inFlight: Promise<T> | null;
  inFlightStartedAt: number;
}

/**
 * How long an in-flight fetch may be joined before it is presumed dead.
 *
 * A serverless instance can freeze mid-request and thaw much later. Without
 * this, one frozen fetch would leave `inFlight` set forever and every
 * subsequent request would await a promise that never settles.
 */
const INFLIGHT_ABANDON_MS = 30_000;

const slots = new Map<string, Slot<unknown>>();

function slotFor<T>(key: string): Slot<T> {
  let slot = slots.get(key) as Slot<T> | undefined;
  if (!slot) {
    slot = { value: undefined, fetchedAt: 0, inFlight: null, inFlightStartedAt: 0 };
    slots.set(key, slot as Slot<unknown>);
  }
  return slot;
}

/**
 * Return a cached value, refreshing it through `fetcher` when the TTL has
 * lapsed.
 *
 * Returns null only when there is no cached value AND the fetch failed — i.e.
 * we genuinely have nothing, and the caller must degrade rather than invent a
 * number.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  now: number = Date.now(),
): Promise<CacheEntry<T> | null> {
  const slot = slotFor<T>(key);

  if (slot.value !== undefined && now - slot.fetchedAt < ttlMs) {
    return { value: slot.value, fetchedAt: slot.fetchedAt, stale: false };
  }

  // Someone else is already refreshing this key — wait on their call instead of
  // firing a second one, unless it has been outstanding long enough to be
  // presumed dead.
  if (slot.inFlight && now - slot.inFlightStartedAt < INFLIGHT_ABANDON_MS) {
    try {
      const value = await slot.inFlight;
      return { value, fetchedAt: slot.fetchedAt, stale: false };
    } catch {
      return slot.value === undefined
        ? null
        : { value: slot.value, fetchedAt: slot.fetchedAt, stale: true };
    }
  }

  const request = fetcher();
  slot.inFlight = request;
  slot.inFlightStartedAt = now;
  try {
    const value = await request;
    slot.value = value;
    // Stamped with the caller's clock, not `Date.now()`. Mixing the two means
    // an injected `now` is compared against a real epoch, and the entry reads
    // as fresh forever. Using the request's start time also errs on the side of
    // refreshing slightly early, which is the safe direction.
    slot.fetchedAt = now;
    return { value, fetchedAt: slot.fetchedAt, stale: false };
  } catch {
    // Last known good, explicitly flagged. Never fabricated.
    return slot.value === undefined
      ? null
      : { value: slot.value, fetchedAt: slot.fetchedAt, stale: true };
  } finally {
    slot.inFlight = null;
  }
}

/**
 * The current cached value without triggering a fetch, always marked stale.
 *
 * This is the fallback a deadline hands back: giving up on a slow upstream
 * should still serve the last known good value, not discard it and fall all the
 * way through to the peak figures.
 */
export function peek<T>(key: string): CacheEntry<T> | null {
  const slot = slots.get(key) as Slot<T> | undefined;
  if (!slot || slot.value === undefined) return null;
  return { value: slot.value, fetchedAt: slot.fetchedAt, stale: true };
}

/** Seed the cache from an external source (e.g. a KV last-known-good read). */
export function seedCache<T>(key: string, value: T, fetchedAt: number): void {
  const slot = slotFor<T>(key);
  if (slot.value === undefined || fetchedAt > slot.fetchedAt) {
    slot.value = value;
    slot.fetchedAt = fetchedAt;
  }
}

/** Drop a key. Used by `?resetPeak=1` so a reset is visible immediately. */
export function invalidate(key: string): void {
  slots.delete(key);
}

/**
 * Resolve `work`, or give up after `ms` and return `fallback`.
 *
 * Used to bound the whole route, not one upstream call. Individual timeouts
 * compose badly — a curve timeout plus a DexScreener timeout plus a holder
 * timeout can add up past the platform's function limit, and a function that
 * gets killed returns the 500 this route promises never to return.
 *
 * Abandoning the wait does NOT cancel the work. It stays in flight and
 * populates the TTL cache, so the request that gave up answers fast from stale
 * data and the NEXT one gets the fresh value. That is the desired trade.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** `fetch` with a hard timeout — no upstream may hang a request indefinitely. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}
