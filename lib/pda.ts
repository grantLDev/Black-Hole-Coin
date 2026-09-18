/**
 * Program-derived address derivation, without `@solana/web3.js`.
 *
 * A PDA is sha256(seeds || bump || programId || "ProgramDerivedAddress")
 * repeated with bump counting down from 255 until the digest is NOT a valid
 * ed25519 curve point. That last condition is the only hard part, and it is
 * implemented below with plain BigInt field arithmetic.
 *
 * Server-only: imports `node:crypto`. Never import this from a client
 * component.
 */

import { createHash } from "node:crypto";
import { decodeBase58, encodeBase58 } from "./base58";

const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");
const MAX_SEED_LENGTH = 32;

// ---------------------------------------------------------------------------
// ed25519 field arithmetic
// ---------------------------------------------------------------------------

/** Field prime for curve25519: 2^255 - 19. */
const P = (1n << 255n) - 19n;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/** Modular inverse via Fermat's little theorem — valid because P is prime. */
function modInverse(value: bigint, modulus: bigint): bigint {
  return modPow(value, modulus - 2n, modulus);
}

/** The Edwards curve constant d = -121665 / 121666 (mod P). */
const D = (P - 121665n) * modInverse(121666n, P) % P;

/** Euler's criterion: is `value` a quadratic residue mod P? */
function isSquare(value: bigint): boolean {
  if (value === 0n) return true;
  return modPow(value, (P - 1n) / 2n, P) === 1n;
}

/**
 * True if the 32 bytes decompress to a point on the ed25519 curve — i.e. the
 * bytes could be somebody's public key, which disqualifies them as a PDA.
 *
 * Mirrors the decompression in curve25519-dalek (and tweetnacl's `unpackneg`,
 * which `@solana/web3.js` ports): the top bit is the sign of x and is masked
 * off, and the remaining y is reduced mod P rather than rejected when it is
 * non-canonical. Getting that reduction wrong would silently disagree with the
 * runtime on rare candidates and derive the wrong address, so it matters.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;

  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i]);
  y &= (1n << 255n) - 1n; // drop the x-sign bit
  y %= P; // match dalek/tweetnacl: reduce, do not reject

  // Curve: -x^2 + y^2 = 1 + d*x^2*y^2  =>  x^2 = (y^2 - 1) / (d*y^2 + 1)
  const y2 = (y * y) % P;
  const numerator = (y2 - 1n + P) % P;
  const denominator = (D * y2 + 1n) % P;

  // A zero denominator has no solution for x, so the bytes are not a point.
  if (denominator === 0n) return false;

  return isSquare((numerator * modInverse(denominator, P)) % P);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface DerivedAddress {
  /** Base58 address. */
  readonly address: string;
  /** Raw 32 bytes, handy for memcmp filters. */
  readonly bytes: Uint8Array;
  /** The bump seed that produced an off-curve digest. */
  readonly bump: number;
}

/**
 * Canonical `findProgramAddress`: the highest bump (counting down from 255)
 * whose digest is off-curve.
 *
 * @throws if no bump yields a valid PDA (probability ~2^-256) or a seed is
 *         longer than 32 bytes.
 */
export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: string,
): DerivedAddress {
  for (const seed of seeds) {
    if (seed.length > MAX_SEED_LENGTH) {
      throw new Error(`findProgramAddress: seed longer than ${MAX_SEED_LENGTH} bytes`);
    }
  }

  const programBytes = decodeBase58(programId);
  if (programBytes.length !== 32) {
    throw new Error(`findProgramAddress: programId is not a 32-byte address`);
  }

  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    hash.update(Buffer.from([bump]));
    hash.update(programBytes);
    hash.update(PDA_MARKER);

    const digest = new Uint8Array(hash.digest());
    if (!isOnCurve(digest)) {
      return { address: encodeBase58(digest), bytes: digest, bump };
    }
  }

  throw new Error("findProgramAddress: exhausted all bumps");
}

/** Convenience wrapper for the common `[utf8 literal, pubkey]` seed shape. */
export function findProgramAddressFromParts(
  parts: readonly (string | Uint8Array)[],
  programId: string,
): DerivedAddress {
  const seeds = parts.map((part) =>
    typeof part === "string" ? new Uint8Array(Buffer.from(part, "utf8")) : part,
  );
  return findProgramAddress(seeds, programId);
}
