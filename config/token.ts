/**
 * SINGLE SOURCE OF TRUTH for token identity.
 *
 * Nothing in this file is a secret. It is imported by both client bundles and
 * serverless route handlers, so it must never contain an API key, an RPC URL
 * with an embedded key, or any credential. Those live in Vercel environment
 * variables and are read only inside `app/api/**` handlers.
 */

/**
 * The SPL mint address of the token, base58.
 *
 * Empty until launch. While empty the app runs entirely on the simulator
 * (see `DEMO_MODE`) rather than pretending to have on-chain data.
 */
export const MINT_ADDRESS = "";

export const TOKEN_SYMBOL = "SINGULARITY";
export const TOKEN_NAME = "Singularity";

/** pump.fun mints a fixed 1B supply with 6 decimals. */
export const TOTAL_SUPPLY = 1_000_000_000;
export const TOKEN_DECIMALS = 6;

/**
 * Public links. Empty string means "not announced yet" — the UI hides any
 * social whose URL is empty rather than rendering a dead link.
 */
export const SOCIALS = {
  x: "",
  telegram: "",
  pumpfun: "",
  dexscreener: "",
} as const;

export type SocialKey = keyof typeof SOCIALS;

/** The socials that actually have a URL, in display order. */
export function activeSocials(): { key: SocialKey; url: string }[] {
  return (Object.keys(SOCIALS) as SocialKey[])
    .map((key) => ({ key, url: SOCIALS[key] }))
    .filter((s) => s.url.length > 0);
}

/**
 * When true the entire app is driven by the simulator instead of live chain
 * data: no Helius calls, no KV reads, no fabricated "real" numbers.
 *
 * True when the token has not launched yet (no mint address) or when the
 * operator forces it with NEXT_PUBLIC_DEMO_MODE=1. The `NEXT_PUBLIC_` prefix
 * is required so the value is inlined into the client bundle at build time and
 * the client and server agree on which mode they are in.
 */
export const DEMO_MODE =
  MINT_ADDRESS.length === 0 || process.env.NEXT_PUBLIC_DEMO_MODE === "1";

/** Guard for code paths that must never run without a real mint. */
export function requireMintAddress(): string {
  if (MINT_ADDRESS.length === 0) {
    throw new Error(
      "MINT_ADDRESS is empty. This code path requires a launched token; " +
        "callers must check DEMO_MODE first.",
    );
  }
  return MINT_ADDRESS;
}
