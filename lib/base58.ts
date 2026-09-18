/**
 * Base58 (Bitcoin alphabet) — the encoding Solana uses for every address.
 *
 * Hand-rolled rather than pulled from a dependency: the serverless route needs
 * exactly two functions out of it, and `@solana/web3.js` is a ~200KB import for
 * a bundle that otherwise has no Solana dependency at all. Both directions are
 * covered by the self-test in `scripts/verify-pda.ts`.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) INDEX[ALPHABET[i]] = i;

/**
 * Decode a base58 string to bytes.
 *
 * @throws if the string contains a character outside the base58 alphabet.
 */
export function decodeBase58(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);

  // Accumulate little-endian, then reverse — the usual big-number-in-base-256
  // long multiplication. Starts EMPTY, not [0]: an all-'1' input is the number
  // zero, and a seeded leading digit would emit a 33rd byte for it.
  const bytes: number[] = [];
  for (const char of input) {
    const value = INDEX[char];
    if (value === undefined) {
      throw new Error(`decodeBase58: invalid character ${JSON.stringify(char)}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Every leading '1' is a literal leading zero byte, not a numeric digit.
  for (let k = 0; k < input.length && input[k] === "1"; k += 1) bytes.push(0);

  return Uint8Array.from(bytes.reverse());
}

/** Encode bytes as a base58 string. */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Empty for the same reason as in `decodeBase58` — see the note there.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "";
  for (let k = 0; k < bytes.length && bytes[k] === 0; k += 1) out += "1";
  for (let j = digits.length - 1; j >= 0; j -= 1) out += ALPHABET[digits[j]];
  return out;
}

/**
 * True if `value` is a syntactically valid base58-encoded 32-byte Solana
 * address. Does NOT check that the account exists or is on the ed25519 curve.
 */
export function isValidAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  try {
    return decodeBase58(value).length === 32;
  } catch {
    return false;
  }
}
