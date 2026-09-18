/**
 * Unit checks for the parts of the data layer that are pure, and therefore the
 * parts worth pinning down before they are wired to a network that is hard to
 * fault-inject against.
 *
 *   npx tsx scripts/verify-stats.ts
 */

import { cached, peek, withDeadline } from "../lib/cache";
import {
  bondingProgress,
  decodeBondingCurve,
  marketCapUsd,
  priceInSol,
} from "../lib/bondingCurve";
import { demoSample } from "../lib/demoFeed";
import { EMPTY_PEAKS, applyPeakUpdate, forceTier, markGraduated, tierIndexFor } from "../lib/peaks";
import { TIERS } from "../config/tiers";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      expected ${String(expected)}\n      actual   ${String(actual)}`);
}

function near(name: string, actual: number, expected: number, tolerance: number): void {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      expected ~${expected}\n      actual    ${actual}`);
}

// ===========================================================================
// Bonding curve decoding and math
// ===========================================================================
console.log("\n-- bonding curve --");

/** Build a synthetic curve account. `extraBytes` emulates a newer layout. */
function buildCurve(options: {
  virtualToken: bigint;
  virtualSol: bigint;
  realToken: bigint;
  complete: boolean;
  quoteMint?: Uint8Array;
}): Uint8Array {
  const length = options.quoteMint ? 125 : 49;
  const buffer = Buffer.alloc(length);
  buffer.writeBigUInt64LE(options.virtualToken, 8);
  buffer.writeBigUInt64LE(options.virtualSol, 16);
  buffer.writeBigUInt64LE(options.realToken, 24);
  buffer.writeBigUInt64LE(0n, 32);
  buffer.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  buffer.writeUInt8(options.complete ? 1 : 0, 48);
  if (options.quoteMint) Buffer.from(options.quoteMint).copy(buffer, 83);
  return new Uint8Array(buffer);
}

// The documented Global defaults a brand-new pump.fun curve starts at.
const fresh = decodeBondingCurve(
  buildCurve({
    virtualToken: 1_073_000_000_000_000n,
    virtualSol: 30_000_000_000n,
    realToken: 793_100_000_000_000n,
    complete: false,
  }),
);
if (!fresh) throw new Error("fresh curve failed to decode");

// 30 SOL / 1.073e9 tokens = 2.7959e-8 SOL each. At $150/SOL that is the
// familiar ~$4.2K launch market cap, which is the real check on this math.
near("fresh curve price in SOL", priceInSol(fresh), 2.7959e-8, 1e-11);
near("fresh curve market cap at $150 SOL", marketCapUsd(fresh, 150), 4_193.8, 1);
near("fresh curve bonding progress", bondingProgress(fresh), 0, 1e-9);
check("fresh curve is not complete", fresh.complete, false);
check("49-byte account has no visible quote mint", fresh.quoteMint, null);
check("49-byte account is treated as SOL-quoted", fresh.quoteMintIsSol, true);

// Half the real reserves sold.
const half = decodeBondingCurve(
  buildCurve({
    virtualToken: 1_073_000_000_000_000n,
    virtualSol: 30_000_000_000n,
    realToken: 396_550_000_000_000n,
    complete: false,
  }),
);
near("half-sold bonding progress", bondingProgress(half!), 0.5, 1e-6);

// A newer, longer account whose quote mint is NOT wrapped SOL.
const wrongQuote = decodeBondingCurve(
  buildCurve({
    virtualToken: 1_073_000_000_000_000n,
    virtualSol: 30_000_000_000n,
    realToken: 793_100_000_000_000n,
    complete: false,
    quoteMint: new Uint8Array(32).fill(7),
  }),
);
check("non-SOL quote mint is detected", wrongQuote?.quoteMintIsSol, false);
check("125-byte account still decodes", wrongQuote !== null, true);

check("truncated account is rejected", decodeBondingCurve(new Uint8Array(20)), null);
check(
  "zeroed reserves are rejected",
  decodeBondingCurve(
    buildCurve({ virtualToken: 0n, virtualSol: 0n, realToken: 0n, complete: false }),
  ),
  null,
);
check(
  "completed curve reports full progress",
  bondingProgress(
    decodeBondingCurve(
      buildCurve({
        virtualToken: 1_073_000_000_000_000n,
        virtualSol: 115_000_000_000n,
        realToken: 0n,
        complete: true,
      }),
    )!,
  ),
  1,
);

// ===========================================================================
// The ratchet
// ===========================================================================
console.log("\n-- sustain guard --");

function poll(record = EMPTY_PEAKS, marketCap: number, holders = 0, fresh = true) {
  return applyPeakUpdate(record, {
    liveMarketCapUsd: marketCap,
    liveHolders: holders,
    fresh,
    now: 1_000,
  }).record;
}

// A new high needs three consecutive sustained polls before it commits.
let state = poll(EMPTY_PEAKS, 30_000);
check("poll 1 does not commit", state.peakMarketCapUsd, 0);
state = poll(state, 30_000);
check("poll 2 does not commit", state.peakMarketCapUsd, 0);
state = poll(state, 30_000);
check("poll 3 commits", state.peakMarketCapUsd, 30_000);
check("committed peak sets the tier", tierIndexFor(state), 2);

// A single wick well above the peak must NOT commit.
const wicked = poll(poll(state, 5_000_000), 30_000);
check("single wick does not commit", wicked.peakMarketCapUsd, 30_000);
check("single wick does not raise the tier", tierIndexFor(wicked), 2);

// A 3% dip still counts as sustained; a deeper one resets the streak.
let held = poll(EMPTY_PEAKS, 100_000);
held = poll(held, 97_500); // within tolerance
held = poll(held, 98_000);
check("a shallow dip still sustains", held.peakMarketCapUsd, 100_000);

let broken = poll(EMPTY_PEAKS, 100_000);
broken = poll(broken, 50_000); // breaks the streak
broken = poll(broken, 50_000);
check("a deep dip breaks the streak", broken.peakMarketCapUsd, 0);

// Holders commit immediately; a crash never takes them back.
const withHolders = poll(EMPTY_PEAKS, 1_000, 420);
check("holders commit on the first poll", withHolders.peakHolders, 420);
check("holders never fall", poll(withHolders, 1_000, 5).peakHolders, 420);

// A stale sample must advance nothing at all.
const stalePolled = poll(poll(poll(EMPTY_PEAKS, 9_000_000, 9_999, false), 9_000_000, 9_999, false), 9_000_000, 9_999, false);
check("a stale poll never commits a peak", stalePolled.peakMarketCapUsd, 0);
check("a stale poll never commits holders", stalePolled.peakHolders, 0);

console.log("\n-- monotonicity --");
const atTop = forceTier(EMPTY_PEAKS, 11, TIERS[11].threshold, 1_000);
check("forceTier reaches the top tier", tierIndexFor(atTop), 11);
check("forceTier cannot demote", tierIndexFor(forceTier(atTop, 3, TIERS[3].threshold, 2_000)), 11);
check("a crash to zero cannot demote", tierIndexFor(poll(poll(poll(atTop, 1), 1), 1)), 11);
check("graduation is one-way", markGraduated(markGraduated(EMPTY_PEAKS, 500), 900).graduatedAt, 500);

// Every threshold in the table is reachable and lands on its own tier.
for (const tier of TIERS) {
  const forced = forceTier(EMPTY_PEAKS, tier.index, tier.threshold, 1_000);
  if (tierIndexFor(forced) !== tier.index) {
    failures += 1;
    console.log(`FAIL  tier ${tier.index} (${tier.name}) not reachable`);
  }
}
console.log(`PASS  all ${TIERS.length} tiers reachable from their thresholds`);

// ===========================================================================
// Cache and deadline
// ===========================================================================
async function cacheChecks(): Promise<void> {
  console.log("\n-- cache --");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls;
  };

  const first = await cached("test:ttl", 10_000, fetcher, 1_000);
  const second = await cached("test:ttl", 10_000, fetcher, 2_000);
  check("TTL serves the cached value", second?.value, first?.value);
  check("TTL made exactly one upstream call", calls, 1);

  // Concurrent cold requests must collapse into one call.
  let concurrentCalls = 0;
  const slow = async () => {
    concurrentCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return "value";
  };
  await Promise.all([
    cached("test:dedupe", 10_000, slow, 1_000),
    cached("test:dedupe", 10_000, slow, 1_000),
    cached("test:dedupe", 10_000, slow, 1_000),
  ]);
  check("concurrent requests de-duplicate", concurrentCalls, 1);

  // A failed refresh serves last-known-good rather than propagating.
  await cached("test:lkg", 1, async () => "good", 1_000);
  const degraded = await cached(
    "test:lkg",
    1,
    async () => {
      throw new Error("upstream down");
    },
    99_000,
  );
  check("a failed refresh keeps the value", degraded?.value, "good");
  check("a failed refresh is flagged stale", degraded?.stale, true);

  // Nothing cached and the fetch fails -> null, never a fabricated number.
  const nothing = await cached(
    "test:empty",
    1_000,
    async () => {
      throw new Error("upstream down");
    },
    1_000,
  );
  check("no value and a failure returns null", nothing, null);

  check("peek marks values stale", peek<number>("test:ttl")?.stale, true);
  check("peek on an unknown key is null", peek("test:missing"), null);
}

async function deadlineChecks(): Promise<void> {
  console.log("\n-- deadline --");
  const start = Date.now();
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 3_000));
  const result = await withDeadline(slow, 200, "fallback");
  const elapsed = Date.now() - start;

  check("deadline returns the fallback", result, "fallback");
  check("deadline actually bounds the wait", elapsed < 1_000, true);
  check("fast work beats the deadline", await withDeadline(Promise.resolve("fast"), 1_000, "x"), "fast");
}

// ===========================================================================
// Demo feed
// ===========================================================================
function demoChecks(): void {
  console.log("\n-- demo feed --");
  const t = 1_700_000_000_000;
  check("demo feed is deterministic", demoSample(t).marketCapUsd, demoSample(t).marketCapUsd);
  check("demo holders are deterministic", demoSample(t).holders, demoSample(t).holders);
  check("demo feed advances over time", demoSample(t).marketCapUsd !== demoSample(t + 600_000).marketCapUsd, true);

  // Sweep a full cycle: values must stay finite, positive and in range, and the
  // ramp must actually cross the whole tier table.
  let minMcap = Infinity;
  let maxMcap = 0;
  let sane = true;
  for (let step = 0; step < 2_700; step += 1) {
    const sample = demoSample(t + step * 1_000);
    if (!Number.isFinite(sample.marketCapUsd) || sample.marketCapUsd <= 0) sane = false;
    if (!Number.isFinite(sample.holders) || sample.holders < 1) sane = false;
    if (!Number.isFinite(sample.solUsd) || sample.solUsd <= 0) sane = false;
    minMcap = Math.min(minMcap, sample.marketCapUsd);
    maxMcap = Math.max(maxMcap, sample.marketCapUsd);
  }
  check("every demo sample across a cycle is sane", sane, true);
  check("the demo ramp starts below tier 1", minMcap < TIERS[1].threshold, true);
  check("the demo ramp reaches tier 11", maxMcap >= TIERS[11].threshold, true);
  console.log(`      (cycle range: $${Math.round(minMcap).toLocaleString()} → $${Math.round(maxMcap).toLocaleString()})`);
}

// Wrapped rather than run at the top level: this file is transpiled to CJS,
// which has no top-level await.
async function main(): Promise<void> {
  await cacheChecks();
  await deadlineChecks();
  demoChecks();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
