/**
 * Helius RPC + DAS access. Server-only — reads HELIUS_API_KEY and builds the
 * RPC URL here so the key never appears in a client bundle.
 *
 * CREDIT COSTS (Helius billing, verified 2026-09-18): standard RPC methods are
 * 1 credit; `getProgramAccounts`, archival calls and every DAS method are 10.
 * That pricing is what drives the poll intervals in the route — see the credit
 * arithmetic in README.md.
 */

import { fetchWithTimeout } from "./cache";
import { decodeBase58 } from "./base58";
import { findProgramAddressFromParts } from "./pda";
import { SPL_TOKEN_PROGRAM_ID, deriveBondingCurve } from "./bondingCurve";

// Deliberately tight. These are upper bounds on ONE call, and the route races
// the whole gather against its own deadline on top of them — see
// `withDeadline` in lib/cache.ts.
const RPC_TIMEOUT_MS = 5_000;
const HOLDER_TIMEOUT_MS = 9_000;

const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** SPL token account layout: mint(32) | owner(32) | amount(u64) | … */
const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

/** DAS `getTokenAccounts` caps a page at 1000. */
const DAS_PAGE_SIZE = 1_000;
/** Hard stop on DAS pagination: 20 pages is 20k holders and 200 credits. */
const DAS_MAX_PAGES = 20;

export function isHeliusConfigured(): boolean {
  return typeof process.env.HELIUS_API_KEY === "string" && process.env.HELIUS_API_KEY.length > 0;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error("helius: HELIUS_API_KEY is not set");
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
}

/** One JSON-RPC call. Throws on transport failure or a JSON-RPC error object. */
async function rpc<T>(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  const response = await fetchWithTimeout(
    rpcUrl(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "singularity", method, params }),
    },
    timeoutMs,
  );

  if (!response.ok) {
    throw new Error(`helius: ${method} returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error) {
    throw new Error(`helius: ${method} failed — ${body.error.message ?? "unknown error"}`);
  }
  if (body.result === undefined) {
    throw new Error(`helius: ${method} returned no result`);
  }
  return body.result;
}

// ---------------------------------------------------------------------------
// Bonding curve account — 1 credit
// ---------------------------------------------------------------------------

interface AccountInfoResponse {
  value: { data: [string, string]; owner: string; lamports: number } | null;
}

/**
 * Raw bonding curve account bytes for a mint, or null when the curve account
 * does not exist (an unlaunched mint, or one that already migrated and had its
 * curve closed).
 */
export async function fetchBondingCurveAccount(mint: string): Promise<Uint8Array | null> {
  const { address } = deriveBondingCurve(mint);

  const result = await rpc<AccountInfoResponse>("getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);

  const value = result?.value;
  if (!value) return null;

  const [encoded, encoding] = value.data;
  if (encoding !== "base64" || typeof encoded !== "string") {
    throw new Error("helius: getAccountInfo returned an unexpected encoding");
  }
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

// ---------------------------------------------------------------------------
// Holder count
// ---------------------------------------------------------------------------

export type HolderMethod = "getProgramAccounts" | "das";

export interface HolderCount {
  readonly holders: number;
  readonly method: HolderMethod;
  /** True when a paging cap was hit, so `holders` is a floor, not exact. */
  readonly truncated: boolean;
}

/**
 * The bonding curve's own associated token account holds every unsold token.
 * It is a vault, not a holder, and counting it would put the holder count at 1
 * the moment the token launches with nobody in it.
 */
function curveVaultAddress(mint: string): string | null {
  try {
    const curve = deriveBondingCurve(mint);
    return findProgramAddressFromParts(
      [curve.bytes, decodeBase58(SPL_TOKEN_PROGRAM_ID), decodeBase58(mint)],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ).address;
  } catch {
    return null;
  }
}

/**
 * Holder count via `getProgramAccounts` — 10 credits, ONE call, regardless of
 * how many holders there are. This is the default; see `countHolders`.
 *
 * `dataSlice` trims each account to its 8-byte amount, so a 5,000-holder token
 * comes back as roughly 60KB rather than 1.2MB.
 */
async function countHoldersViaProgramAccounts(mint: string): Promise<HolderCount> {
  const resolveOwners = process.env.HOLDER_COUNT_RESOLVE_OWNERS === "1";

  // Default slice is the amount alone. The opt-in slice also pulls the owner so
  // that a wallet holding the same mint in several token accounts is counted
  // once — more accurate, ~5x the payload, identical credit cost.
  const dataSlice = resolveOwners
    ? { offset: TOKEN_ACCOUNT_OWNER_OFFSET, length: 40 }
    : { offset: TOKEN_ACCOUNT_AMOUNT_OFFSET, length: 8 };

  const accounts = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>(
    "getProgramAccounts",
    [
      SPL_TOKEN_PROGRAM_ID,
      {
        encoding: "base64",
        commitment: "confirmed",
        dataSlice,
        filters: [{ dataSize: TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint } }],
      },
    ],
    HOLDER_TIMEOUT_MS,
  );

  const vault = curveVaultAddress(mint);
  const owners = resolveOwners ? new Set<string>() : null;
  let holders = 0;

  for (const entry of accounts) {
    if (vault !== null && entry.pubkey === vault) continue;

    const bytes = Buffer.from(entry.account.data[0], "base64");
    const amountOffset = resolveOwners ? 32 : 0;
    if (bytes.length < amountOffset + 8) continue;
    if (bytes.readBigUInt64LE(amountOffset) === 0n) continue;

    if (owners) owners.add(bytes.subarray(0, 32).toString("base64"));
    else holders += 1;
  }

  return {
    holders: owners ? owners.size : holders,
    method: "getProgramAccounts",
    truncated: false,
  };
}

/**
 * Holder count via the DAS `getTokenAccounts` method — 10 credits PER PAGE of
 * 1000. Used as the fallback when `getProgramAccounts` errors or times out,
 * which it can do on very large token populations.
 */
async function countHoldersViaDas(mint: string): Promise<HolderCount> {
  const vault = curveVaultAddress(mint);
  let holders = 0;
  let cursor: string | undefined;

  for (let page = 0; page < DAS_MAX_PAGES; page += 1) {
    const result = await rpc<{
      total?: number;
      cursor?: string;
      token_accounts?: { address?: string; amount?: number | string }[];
    }>(
      "getTokenAccounts",
      {
        mint,
        limit: DAS_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
        options: { showZeroBalance: false },
      },
      HOLDER_TIMEOUT_MS,
    );

    const pageAccounts = result.token_accounts ?? [];
    for (const account of pageAccounts) {
      if (vault !== null && account.address === vault) continue;
      // `showZeroBalance: false` should already exclude these, but the filter is
      // cheap and the option has been inconsistent across DAS versions.
      if (!(Number(account.amount ?? 0) > 0)) continue;
      holders += 1;
    }

    cursor = result.cursor;
    // Ran out of pages before the cap: this is a complete, exact count.
    if (!cursor || pageAccounts.length === 0) return { holders, method: "das", truncated: false };
  }

  // Hit the page cap with a cursor still outstanding — the count is a floor.
  return { holders, method: "das", truncated: true };
}

/**
 * Count holders.
 *
 * DEFAULT IS `getProgramAccounts`. Both methods cost 10 credits per call, but
 * gPA answers in exactly one call at any holder count while DAS costs 10
 * credits per 1000 holders — so gPA is equal at launch and strictly cheaper
 * from the first 1001st holder onward, for a payload that stays tiny because of
 * `dataSlice`. DAS is kept as an automatic fallback because gPA is the call
 * more likely to time out under load.
 *
 * Set HOLDER_COUNT_METHOD=das to invert the preference without a redeploy.
 */
export async function countHolders(mint: string): Promise<HolderCount> {
  const preferDas = process.env.HOLDER_COUNT_METHOD === "das";
  const primary = preferDas ? countHoldersViaDas : countHoldersViaProgramAccounts;
  const fallback = preferDas ? countHoldersViaProgramAccounts : countHoldersViaDas;

  try {
    return await primary(mint);
  } catch {
    return await fallback(mint);
  }
}
