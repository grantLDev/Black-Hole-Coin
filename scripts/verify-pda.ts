/**
 * Self-test for the hand-rolled base58 + ed25519 + PDA code in `lib/`.
 *
 * These modules replace `@solana/web3.js`, so they get checked against known
 * pump.fun PDAs rather than taken on trust. A wrong on-curve check would pick a
 * different bump and derive a plausible-looking but completely wrong address.
 *
 *   npx tsx scripts/verify-pda.ts      (or: node --experimental-strip-types)
 */

import { decodeBase58, encodeBase58, isValidAddress } from "../lib/base58";
import { findProgramAddressFromParts, isOnCurve } from "../lib/pda";
import { PUMP_PROGRAM_ID, deriveBondingCurve } from "../lib/bondingCurve";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`      expected ${String(expected)}\n      actual   ${String(actual)}`);
}

// --- base58 round trips -----------------------------------------------------
const ADDRESSES = [
  PUMP_PROGRAM_ID,
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "So11111111111111111111111111111111111111112",
  "11111111111111111111111111111111",
];
for (const address of ADDRESSES) {
  check(`base58 round trip ${address.slice(0, 12)}…`, encodeBase58(decodeBase58(address)), address);
  check(`base58 length ${address.slice(0, 12)}…`, decodeBase58(address).length, 32);
}
check("isValidAddress rejects junk", isValidAddress("not-an-address-0OIl"), false);

// --- on-curve check ---------------------------------------------------------
// The System Program address is all zero bytes, which decompresses to a valid
// curve point; a PDA by construction does not.
check("system program is on curve", isOnCurve(decodeBase58("11111111111111111111111111111111")), true);
check("wSOL mint is on curve", isOnCurve(decodeBase58("So11111111111111111111111111111111111111112")), true);

// --- known pump.fun PDAs ----------------------------------------------------
// Published constants from the pump program. If the derivation below is wrong,
// none of these will match.
check(
  "pump global PDA",
  findProgramAddressFromParts(["global"], PUMP_PROGRAM_ID).address,
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
);
check(
  "pump mint-authority PDA",
  findProgramAddressFromParts(["mint-authority"], PUMP_PROGRAM_ID).address,
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
);
check(
  "pump event-authority PDA",
  findProgramAddressFromParts(["__event_authority"], PUMP_PROGRAM_ID).address,
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
);

// --- bonding curve derivation is deterministic and off-curve ----------------
const curve = deriveBondingCurve("So11111111111111111111111111111111111111112");
check("bonding curve PDA is off curve", isOnCurve(curve.bytes), false);
check("bonding curve PDA is stable", deriveBondingCurve("So11111111111111111111111111111111111111112").address, curve.address);
console.log(`      (wSOL-as-mint bonding curve PDA: ${curve.address}, bump ${curve.bump})`);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
