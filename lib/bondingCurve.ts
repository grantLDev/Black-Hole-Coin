/**
 * pump.fun bonding curve: PDA derivation, account decoding, and the price /
 * market-cap / progress math derived from it.
 *
 * LAYOUT VERIFIED against pump-fun/pump-public-docs (PUMP_PROGRAM_README.md)
 * on 2026-09-18. The first six fields are unchanged from the original program,
 * but the account has grown twice since launch:
 *
 *   off  size  field
 *     0     8  anchor discriminator
 *     8     8  virtual_token_reserves   u64   (6 decimals)
 *    16     8  virtual_sol_reserves     u64   (lamports, 9 decimals)
 *    24     8  real_token_reserves      u64   (6 decimals)
 *    32     8  real_sol_reserves        u64   (lamports)
 *    40     8  token_total_supply       u64   (6 decimals)
 *    48     1  complete                 bool
 *    49    32  creator                  pubkey   <- appended by a later upgrade
 *    81     1  is_mayhem_mode           bool     <- appended later still
 *    82     1  is_cashback_coin         bool
 *    83    32  quote_mint               pubkey
 *   115     8  creator_fee_bps          u64
 *   123     1  can_edit_creator_fee     bool
 *   124     1  is_holder_reward         bool
 *
 * Two consequences the decoder has to respect:
 *
 *  1. NEVER assert an exact account length. Curves created before the upgrades
 *     are 49 bytes; current ones are 125. A strict length check would reject
 *     perfectly good accounts, and pump may append more fields tomorrow.
 *
 *  2. `quote_mint` means a curve is no longer necessarily denominated in SOL.
 *     `virtual_sol_reserves` is really "virtual quote reserves". If the quote
 *     mint is not wrapped SOL, `price_in_sol * solUsd` is silently wrong by
 *     whatever the quote asset is worth, so the caller must fall back to
 *     DexScreener instead. `quoteMintIsSol` below reports that.
 */

import { decodeBase58, encodeBase58 } from "./base58";
import { findProgramAddressFromParts, type DerivedAddress } from "./pda";
import { TOKEN_DECIMALS, TOTAL_SUPPLY } from "@/config/token";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const LAMPORTS_PER_SOL = 1_000_000_000;
const TOKEN_UNITS = 10 ** TOKEN_DECIMALS;

/** Smallest account that still contains everything through `complete`. */
const MIN_ACCOUNT_LENGTH = 49;
/** Smallest account that also contains `quote_mint`. */
const QUOTE_MINT_ACCOUNT_LENGTH = 115;

const OFFSET_VIRTUAL_TOKEN_RESERVES = 8;
const OFFSET_VIRTUAL_SOL_RESERVES = 16;
const OFFSET_REAL_TOKEN_RESERVES = 24;
const OFFSET_REAL_SOL_RESERVES = 32;
const OFFSET_TOKEN_TOTAL_SUPPLY = 40;
const OFFSET_COMPLETE = 48;
const OFFSET_QUOTE_MINT = 83;

/**
 * Global defaults a new curve is initialised with, in base units. Used only as
 * a fallback when the account's own `token_total_supply` is unusable.
 */
const DEFAULT_TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n;
/**
 * A fresh curve holds 79.31% of supply as real (sellable) reserves; the rest is
 * the virtual offset. Expressed as a fraction so the progress math still works
 * if pump ever ships a different supply.
 */
const INITIAL_REAL_TOKEN_FRACTION = 0.7931;

/** Raw, still-integral contents of a bonding curve account. */
export interface BondingCurveState {
  readonly virtualTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly tokenTotalSupply: bigint;
  /** True once `real_token_reserves` hit zero and the curve is ready to migrate. */
  readonly complete: boolean;
  /**
   * Base58 quote mint, or null on pre-upgrade accounts that predate the field
   * (those are always SOL-quoted).
   */
  readonly quoteMint: string | null;
  /** False only when we can see a quote mint and it is not wrapped SOL. */
  readonly quoteMintIsSol: boolean;
  /** Length of the account data we decoded, for diagnostics. */
  readonly byteLength: number;
}

/** The bonding curve PDA for a mint: seeds `["bonding-curve", mint]`. */
export function deriveBondingCurve(mintAddress: string): DerivedAddress {
  const mintBytes = decodeBase58(mintAddress);
  if (mintBytes.length !== 32) {
    throw new Error("deriveBondingCurve: mint is not a 32-byte address");
  }
  return findProgramAddressFromParts(["bonding-curve", mintBytes], PUMP_PROGRAM_ID);
}

/**
 * Decode a bonding curve account.
 *
 * Returns null rather than throwing when the data is too short or obviously
 * nonsense — the caller's job is to fall back to DexScreener, not to crash.
 */
export function decodeBondingCurve(data: Uint8Array): BondingCurveState | null {
  if (data.length < MIN_ACCOUNT_LENGTH) return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (offset: number) => view.getBigUint64(offset, true);

  const virtualTokenReserves = u64(OFFSET_VIRTUAL_TOKEN_RESERVES);
  const virtualSolReserves = u64(OFFSET_VIRTUAL_SOL_RESERVES);
  const realTokenReserves = u64(OFFSET_REAL_TOKEN_RESERVES);
  const realSolReserves = u64(OFFSET_REAL_SOL_RESERVES);
  const tokenTotalSupply = u64(OFFSET_TOKEN_TOTAL_SUPPLY);
  const completeByte = data[OFFSET_COMPLETE];

  // A live curve always has both virtual reserves non-zero — the constant
  // product invariant requires it. Zeroes mean we are looking at an
  // uninitialised or misidentified account.
  if (virtualTokenReserves === 0n || virtualSolReserves === 0n) return null;
  if (completeByte > 1) return null;

  let quoteMint: string | null = null;
  if (data.length >= QUOTE_MINT_ACCOUNT_LENGTH) {
    quoteMint = encodeBase58(data.slice(OFFSET_QUOTE_MINT, OFFSET_QUOTE_MINT + 32));
  }

  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete: completeByte === 1,
    quoteMint,
    quoteMintIsSol: quoteMint === null || quoteMint === WSOL_MINT,
    byteLength: data.length,
  };
}

/**
 * Spot price of one token in SOL.
 *
 * price = (virtualSolReserves / 1e9) / (virtualTokenReserves / 1e6)
 *
 * Only meaningful when the curve is SOL-quoted; check `quoteMintIsSol` first.
 */
export function priceInSol(state: BondingCurveState): number {
  const sol = Number(state.virtualSolReserves) / LAMPORTS_PER_SOL;
  const tokens = Number(state.virtualTokenReserves) / TOKEN_UNITS;
  if (!(tokens > 0)) return 0;
  return sol / tokens;
}

/** Circulating supply in whole tokens, preferring the curve's own figure. */
export function totalSupplyTokens(state: BondingCurveState): number {
  const raw = state.tokenTotalSupply > 0n ? state.tokenTotalSupply : DEFAULT_TOKEN_TOTAL_SUPPLY;
  const tokens = Number(raw) / TOKEN_UNITS;
  return Number.isFinite(tokens) && tokens > 0 ? tokens : TOTAL_SUPPLY;
}

/** Fully diluted market cap in USD. */
export function marketCapUsd(state: BondingCurveState, solUsd: number): number {
  if (!(solUsd > 0)) return 0;
  return priceInSol(state) * solUsd * totalSupplyTokens(state);
}

/**
 * Progress along the curve, 0..1, from how much of the initial real token
 * reserve has been bought out. Reads 1 once `complete` is set.
 */
export function bondingProgress(state: BondingCurveState): number {
  if (state.complete) return 1;

  const supply = state.tokenTotalSupply > 0n ? state.tokenTotalSupply : DEFAULT_TOKEN_TOTAL_SUPPLY;
  const initialReal = Number(supply) * INITIAL_REAL_TOKEN_FRACTION;
  if (!(initialReal > 0)) return 0;

  const remaining = Number(state.realTokenReserves);
  const progress = 1 - remaining / initialReal;
  return Math.min(1, Math.max(0, progress));
}
