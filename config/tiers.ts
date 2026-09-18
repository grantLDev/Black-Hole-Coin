/**
 * TIER TABLE — the visual/audio state machine of the black hole.
 *
 * Tiers are driven by ALL-TIME-HIGH market cap in USD, never by live market
 * cap. Once a threshold is crossed the tier is permanent: a crash never
 * revokes a tier and never reverses a visual. Tiers are achievements, not a
 * thermometer.
 *
 * Every field below is fed to the renderer as a live uniform and is
 * interpolated between the current and previous tier during an unlock
 * transition. Nothing here may be duplicated as a constant inside a shader.
 */

/** Valid tier indices, 0..11. */
export type TierIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

/** `#rrggbb`. Converted to a vec3 for the shader by `hexToRgb`. */
export type HexColor = `#${string}`;

export interface Tier {
  /** Index into TIERS; also the tier number shown in the UI. */
  readonly index: TierIndex;
  /** All-time-high market cap in USD at or above which this tier unlocks. */
  readonly threshold: number;
  readonly name: string;

  // ---- Accretion disk -----------------------------------------------------
  /** Outer edge of the disk, in Schwarzschild radii. Inner edge is the ISCO. */
  readonly diskOuterRadius: number;
  /** Emissive multiplier on the disk before tone mapping. */
  readonly diskBrightness: number;
  /** Amplitude of the domain-warped noise that breaks up the disk bands. */
  readonly diskTurbulence: number;

  // ---- Post processing ----------------------------------------------------
  /** Bloom intensity applied to pixels above the bloom threshold. */
  readonly bloomStrength: number;
  /** Lateral RGB split at the frame edges, in fractions of the viewport. */
  readonly chromaticAberration: number;
  /** Film grain opacity, 0..1. */
  readonly grainAmount: number;

  // ---- Camera shake -------------------------------------------------------
  /**
   * Peak camera offset in world units. 0 for tiers 0-2.
   *
   * Paired with `shakeFrequency`, which doubles as the character of the shake:
   * below 1 Hz the envelope gates the shake into occasional, barely
   * perceptible tremors; at and above 1 Hz it is continuous.
   */
  readonly shakeAmplitude: number;
  /** Shake envelope frequency in Hz. 0 disables shake entirely. */
  readonly shakeFrequency: number;

  // ---- Milestones ---------------------------------------------------------
  /** Polar relativistic jets. One-directional: true from tier 9 up. */
  readonly hasJet: boolean;

  // ---- Audio drone (see Prompt 10) ---------------------------------------
  /** Fundamental of the drone in Hz. Falls as the hole gets more massive. */
  readonly droneRootHz: number;
  /** 0..1 — detune/beating between the drone's stacked partials. */
  readonly droneDissonance: number;
  /** 0..1 — amount of high, metallic upper partials riding the drone. */
  readonly droneShimmer: number;

  // ---- Disk color ---------------------------------------------------------
  /** Color at the ISCO, where the disk is hottest and most blueshifted. */
  readonly diskColorInner: HexColor;
  /** Color at the outer edge, coolest and most redshifted. */
  readonly diskColorOuter: HexColor;
}

export const TIERS: readonly Tier[] = [
  {
    index: 0,
    threshold: 0,
    name: "Protostar",
    diskOuterRadius: 4.0,
    diskBrightness: 0.55,
    diskTurbulence: 0.15,
    bloomStrength: 0.25,
    chromaticAberration: 0.0,
    grainAmount: 0.06,
    shakeAmplitude: 0.0,
    shakeFrequency: 0.0,
    hasJet: false,
    droneRootHz: 55.0,
    droneDissonance: 0.0,
    droneShimmer: 0.0,
    diskColorInner: "#ffca8a",
    diskColorOuter: "#a33d0a",
  },
  {
    index: 1,
    threshold: 10_000,
    name: "Collapse",
    diskOuterRadius: 4.4,
    diskBrightness: 0.72,
    diskTurbulence: 0.22,
    bloomStrength: 0.34,
    chromaticAberration: 0.03,
    grainAmount: 0.07,
    shakeAmplitude: 0.0,
    shakeFrequency: 0.0,
    hasJet: false,
    droneRootHz: 51.91,
    droneDissonance: 0.05,
    droneShimmer: 0.04,
    diskColorInner: "#ffd08c",
    diskColorOuter: "#b8440c",
  },
  {
    index: 2,
    threshold: 25_000,
    name: "Event Horizon",
    diskOuterRadius: 4.9,
    diskBrightness: 0.92,
    diskTurbulence: 0.3,
    bloomStrength: 0.44,
    chromaticAberration: 0.06,
    grainAmount: 0.085,
    shakeAmplitude: 0.0,
    shakeFrequency: 0.0,
    hasJet: false,
    droneRootHz: 49.0,
    droneDissonance: 0.1,
    droneShimmer: 0.09,
    diskColorInner: "#ffd89a",
    diskColorOuter: "#c74a0e",
  },
  {
    index: 3,
    threshold: 50_000,
    name: "Accretion",
    diskOuterRadius: 5.4,
    diskBrightness: 1.12,
    diskTurbulence: 0.4,
    bloomStrength: 0.54,
    chromaticAberration: 0.1,
    grainAmount: 0.1,
    shakeAmplitude: 0.0012,
    shakeFrequency: 0.11,
    hasJet: false,
    droneRootHz: 46.25,
    droneDissonance: 0.17,
    droneShimmer: 0.15,
    diskColorInner: "#ffe0a8",
    diskColorOuter: "#d25311",
  },
  {
    index: 4,
    threshold: 100_000,
    name: "Photon Ring",
    diskOuterRadius: 6.0,
    diskBrightness: 1.34,
    diskTurbulence: 0.5,
    bloomStrength: 0.65,
    chromaticAberration: 0.14,
    grainAmount: 0.115,
    shakeAmplitude: 0.0018,
    shakeFrequency: 0.15,
    hasJet: false,
    droneRootHz: 43.65,
    droneDissonance: 0.24,
    droneShimmer: 0.22,
    diskColorInner: "#ffe8ba",
    diskColorOuter: "#dd6116",
  },
  {
    index: 5,
    threshold: 150_000,
    name: "Relativistic",
    diskOuterRadius: 6.6,
    diskBrightness: 1.58,
    diskTurbulence: 0.6,
    bloomStrength: 0.76,
    chromaticAberration: 0.19,
    grainAmount: 0.13,
    shakeAmplitude: 0.0026,
    shakeFrequency: 0.2,
    hasJet: false,
    droneRootHz: 41.2,
    droneDissonance: 0.32,
    droneShimmer: 0.3,
    diskColorInner: "#fff0cc",
    diskColorOuter: "#e6701d",
  },
  {
    index: 6,
    threshold: 200_000,
    name: "Frame Drag",
    diskOuterRadius: 7.2,
    diskBrightness: 1.82,
    diskTurbulence: 0.7,
    bloomStrength: 0.86,
    chromaticAberration: 0.24,
    grainAmount: 0.145,
    shakeAmplitude: 0.0035,
    shakeFrequency: 0.28,
    hasJet: false,
    droneRootHz: 38.89,
    droneDissonance: 0.4,
    droneShimmer: 0.38,
    diskColorInner: "#fff5d8",
    diskColorOuter: "#ec7f27",
  },
  {
    index: 7,
    threshold: 250_000,
    name: "Supermassive",
    diskOuterRadius: 7.9,
    diskBrightness: 2.08,
    diskTurbulence: 0.8,
    bloomStrength: 0.97,
    chromaticAberration: 0.3,
    grainAmount: 0.16,
    shakeAmplitude: 0.006,
    shakeFrequency: 1.4,
    hasJet: false,
    droneRootHz: 36.71,
    droneDissonance: 0.5,
    droneShimmer: 0.47,
    diskColorInner: "#fffaea",
    diskColorOuter: "#f08f36",
  },
  {
    index: 8,
    threshold: 500_000,
    name: "Quasar",
    diskOuterRadius: 8.6,
    diskBrightness: 2.4,
    diskTurbulence: 0.92,
    bloomStrength: 1.1,
    chromaticAberration: 0.38,
    grainAmount: 0.18,
    shakeAmplitude: 0.0075,
    shakeFrequency: 1.7,
    hasJet: false,
    droneRootHz: 34.65,
    droneDissonance: 0.6,
    droneShimmer: 0.57,
    diskColorInner: "#fffdf6",
    diskColorOuter: "#f5a248",
  },
  {
    index: 9,
    threshold: 1_000_000,
    name: "Singularity",
    diskOuterRadius: 9.4,
    diskBrightness: 2.72,
    diskTurbulence: 1.05,
    bloomStrength: 1.22,
    chromaticAberration: 0.48,
    grainAmount: 0.2,
    shakeAmplitude: 0.0092,
    shakeFrequency: 2.0,
    hasJet: true,
    droneRootHz: 32.7,
    droneDissonance: 0.7,
    droneShimmer: 0.68,
    diskColorInner: "#ffffff",
    diskColorOuter: "#f8b45f",
  },
  {
    index: 10,
    threshold: 5_000_000,
    name: "Galactic Core",
    diskOuterRadius: 10.4,
    diskBrightness: 3.05,
    diskTurbulence: 1.2,
    bloomStrength: 1.36,
    chromaticAberration: 0.62,
    grainAmount: 0.235,
    shakeAmplitude: 0.0122,
    shakeFrequency: 2.35,
    hasJet: true,
    droneRootHz: 27.5,
    droneDissonance: 0.85,
    droneShimmer: 0.82,
    diskColorInner: "#f4f8ff",
    diskColorOuter: "#fbc87e",
  },
  {
    index: 11,
    threshold: 10_000_000,
    name: "Gargantua",
    diskOuterRadius: 11.5,
    diskBrightness: 3.4,
    diskTurbulence: 1.35,
    bloomStrength: 1.5,
    chromaticAberration: 0.8,
    grainAmount: 0.27,
    shakeAmplitude: 0.016,
    shakeFrequency: 2.8,
    hasJet: true,
    droneRootHz: 24.5,
    droneDissonance: 1.0,
    droneShimmer: 1.0,
    diskColorInner: "#e8f2ff",
    diskColorOuter: "#ffd9a0",
  },
] as const;

export const TIER_COUNT = TIERS.length;
export const MAX_TIER_INDEX = (TIER_COUNT - 1) as TierIndex;

/** The first tier at which jets appear. One-directional from here up. */
export const JET_TIER_INDEX: TierIndex = 9;

/**
 * The tier for a given ALL-TIME-HIGH market cap.
 *
 * Callers must pass the ratcheted ATH value, never a live market cap — this
 * function is pure and will happily walk backwards if fed a falling number.
 * The ratchet lives in the data layer, not here.
 */
export function tierForAthMarketCap(athUsd: number): Tier {
  if (!Number.isFinite(athUsd) || athUsd <= 0) return TIERS[0];
  let result = TIERS[0];
  for (const tier of TIERS) {
    if (athUsd >= tier.threshold) result = tier;
    else break;
  }
  return result;
}

/** The next tier up, or null at the top of the table. */
export function nextTier(index: TierIndex): Tier | null {
  return index >= MAX_TIER_INDEX ? null : TIERS[index + 1];
}

/**
 * Progress 0..1 from the current tier's threshold toward the next one,
 * on a log scale so the early tiers do not look instantly complete.
 * Returns 1 at the top of the table.
 */
export function progressToNextTier(athUsd: number): number {
  const current = tierForAthMarketCap(athUsd);
  const next = nextTier(current.index);
  if (!next) return 1;
  const lo = Math.log10(Math.max(current.threshold, 1_000));
  const hi = Math.log10(next.threshold);
  const at = Math.log10(Math.max(athUsd, 1));
  return Math.min(1, Math.max(0, (at - lo) / (hi - lo)));
}

/** `#rrggbb` -> linear-ish [r, g, b] in 0..1, ready for a vec3 uniform. */
export function hexToRgb(hex: HexColor): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Compact USD label for the HUD: $10K, $1M, $10M. */
export function formatUsdCompact(usd: number): string {
  if (!Number.isFinite(usd)) return "$0";
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(usd % 1_000 === 0 ? 0 : 1)}K`;
  return `$${Math.round(usd)}`;
}
