/**
 * The post chain: bloom, chromatic aberration, vignette, tone map, grain, dither.
 *
 * Four fragment shaders and one vertex shader, all driven from the same
 * fullscreen triangle as the scene pass. The graph that wires them together
 * lives in `lib/gl/PostChain.ts`; this file is only the GLSL.
 *
 *   prefilter   scene HDR      -> bloom[0]        threshold, emissive only
 *   downsample  bloom[i]       -> bloom[i + 1]    dual Kawase, x4 fewer pixels
 *   upsample    bloom[i]       -> bloom[i - 1]    dual Kawase, ADDITIVELY
 *   composite   scene + bloom  -> the screen      everything else
 *
 * WHY DUAL KAWASE AND NOT A GAUSSIAN. A separable Gaussian wide enough to be a
 * convincing bloom needs a large radius, and a large radius costs taps in
 * proportion — a 33-tap separable blur is 66 samples per pixel per level, and
 * it has to run at something close to full resolution to avoid a boxy result.
 * Dual Kawase gets a wider, smoother kernel out of 5 taps down and 8 taps up by
 * letting the hardware's bilinear units do the averaging and letting the
 * pyramid do the widening. The whole chain below costs less than one level of
 * the Gaussian would, and the repeated tent filters converge on a smoother
 * profile than a truncated Gaussian does. On the phones this project has to
 * hold 30fps on, that difference is the whole budget.
 *
 * WHY THE BLOOM IS MASKED AND NOT JUST THRESHOLDED. See the TraceResult comment
 * in `blackhole.glsl.ts`. The scene pass writes the disk-and-jets luminance
 * into alpha, so the prefilter never sees a star at all — the brief's "never
 * the stars" is enforced by where the photons came from, not by how bright they
 * happen to be.
 *
 * EVERY VISIBLE PARAMETER IS A UNIFORM, and every one of them arrives from the
 * permanent tier through `VisualState`'s smoothing. None of the numbers in the
 * tier table appear here; the constants that do are unit conversions and
 * shaping, fixed for the life of the project.
 */

import { HASH_GLSL, TONEMAP_GLSL } from "./common.glsl";

/**
 * Shared vertex shader for every post pass.
 *
 * The same oversized clip-space triangle as the scene, with a UV that is
 * exactly [0,1] across the viewport after clipping — `position.xy * 0.5 + 0.5`
 * runs 0..2 over the unclipped triangle, and interpolation is linear, so the
 * visible span is exact.
 */
export const POST_VERT = /* glsl */ `
precision highp float;

in vec3 position;
out vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Bloom threshold, in linear radiance.
 *
 * HIGH on purpose, per the brief. The disk's source function at tier 0 peaks
 * near 4.0 on the approaching inner limb and falls below 0.05 on the receding
 * one, so a threshold of 1.0 takes the beamed inner edge and the photon ring
 * and leaves the body of the disk alone. At tier 11 the same threshold catches
 * a good deal more of the disk, which is exactly the intended progression: the
 * hole does not get a bigger bloom filter as it grows, it gets brighter, and
 * more of it crosses the same line.
 *
 * Low enough and bloom stops being light and starts being a glow filter laid
 * over the whole frame — the single most common way this effect is overdone.
 */
const BLOOM_THRESHOLD = 1.0;

/**
 * Soft-knee width around the threshold, in the same linear units.
 *
 * A hard threshold makes the bloom's own edge visible: a filament drifting
 * across the cut pops into a halo between one frame and the next. The knee is
 * the standard quadratic ramp over [threshold - knee, threshold + knee].
 */
const BLOOM_KNEE = 0.6;

export const BLOOM_PREFILTER_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
out vec4 fragColor;

/** Full-resolution scene: rgb linear radiance, a emissive luminance. */
uniform sampler2D uScene;
/**
 * Half a SOURCE texel, in UV — note the difference from the Kawase passes
 * below, which take half a DESTINATION texel.
 *
 * A destination texel centre sits exactly on the corner where four source
 * texels meet, so offsetting by half a source texel puts each of the four taps
 * precisely on a source texel centre. That makes the four taps an exact 2x2
 * box: every source pixel counted once, with no bilinear weight leaking in
 * from the neighbouring block.
 */
uniform vec2 uHalfPixel;

${TONEMAP_GLSL}

const float BLOOM_THRESHOLD = ${BLOOM_THRESHOLD.toFixed(4)};
const float BLOOM_KNEE = ${BLOOM_KNEE.toFixed(4)};

/**
 * One thresholded tap.
 *
 * The emissive COLOUR is reconstructed from the mask as
 * \`rgb * (a / luminance(rgb))\` — the fraction of the pixel's luminance that the
 * disk and jets contributed, applied to the pixel's own hue. Where the disk is
 * bright enough to bloom it is also what the pixel is made of, so the
 * reconstruction is exact there; where a star shows through thin gas the ratio
 * correctly collapses toward zero and the star is dropped.
 *
 * The clamp on the ratio is not decorative. Alpha is stored in a half float,
 * and a value that rounds a hair above the luminance of rgb would otherwise
 * amplify the tap rather than attenuate it.
 */
vec3 thresholdTap(vec2 uv) {
  vec4 scene = texture(uScene, uv);

  float total = max(luminance(scene.rgb), 1.0e-5);
  float emissiveLuma = min(scene.a, total);
  vec3 emissive = scene.rgb * (emissiveLuma / total);

  // Quadratic soft knee. Below (threshold - knee) this is 0, above
  // (threshold + knee) it is the plain (l - threshold) hard knee, and between
  // the two it is a smooth quadratic that meets both with a matching slope.
  float knee = max(BLOOM_KNEE, 1.0e-4);
  float soft = clamp(emissiveLuma - (BLOOM_THRESHOLD - knee), 0.0, 2.0 * knee);
  soft = soft * soft * (0.25 / knee);

  float above = max(soft, emissiveLuma - BLOOM_THRESHOLD);

  return emissive * (above / max(emissiveLuma, 1.0e-5));
}

void main() {
  // An exact 2x2 box — see uHalfPixel — so nothing in the full-resolution
  // frame is counted twice or missed on the way down to half resolution.
  // Thresholding happens per tap rather than on the averaged value: a single
  // brilliant texel averaged with three dark ones would otherwise fall under
  // the threshold and disappear, which reads as the bloom flickering along the
  // inner limb as the disk turns.
  vec3 sum = thresholdTap(vUv + vec2(-uHalfPixel.x, -uHalfPixel.y));
  sum += thresholdTap(vUv + vec2(uHalfPixel.x, -uHalfPixel.y));
  sum += thresholdTap(vUv + vec2(-uHalfPixel.x, uHalfPixel.y));
  sum += thresholdTap(vUv + vec2(uHalfPixel.x, uHalfPixel.y));

  fragColor = vec4(sum * 0.25, 1.0);
}
`;

/**
 * Dual Kawase downsample (Marius Bjorke, ARM, SIGGRAPH 2015).
 *
 * Five bilinear taps: one at the centre weighted 4, and four on the diagonals
 * one SOURCE texel out, weighted 1. Because `uHalfPixel` is half a destination
 * texel and the destination is half the size, those diagonals land exactly on
 * the centres of the neighbouring 2x2 source blocks, so each tap is itself a
 * free 2x2 average and the five taps cover a 4x4 neighbourhood.
 */
export const BLOOM_DOWNSAMPLE_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
/** Half a DESTINATION texel, in UV. Equals one source texel on a 2:1 step. */
uniform vec2 uHalfPixel;

void main() {
  vec3 sum = texture(uSource, vUv).rgb * 4.0;
  sum += texture(uSource, vUv - uHalfPixel).rgb;
  sum += texture(uSource, vUv + uHalfPixel).rgb;
  sum += texture(uSource, vUv + vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;
  sum += texture(uSource, vUv - vec2(uHalfPixel.x, -uHalfPixel.y)).rgb;

  fragColor = vec4(sum * 0.125, 1.0);
}
`;

/**
 * Dual Kawase upsample: an eight-tap tent, additively blended.
 *
 * The blend is the reason this chain needs no second set of render targets. The
 * upsample reads level i and adds into level i-1, which already holds that
 * level's own downsampled result — two different surfaces, so there is no
 * read-write hazard, and the pyramid accumulates in place. The host runs it
 * with additive blending and no clear; see PostChain.
 *
 * `uWeight` lets the host taper the contribution of the coarsest levels. A
 * uniform pyramid gives a bloom whose energy is dominated by the widest, least
 * defined level, which is the soft grey wash that makes a bloom look cheap.
 */
export const BLOOM_UPSAMPLE_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
/** Half a DESTINATION texel, in UV. The destination is the LARGER surface. */
uniform vec2 uHalfPixel;
uniform float uWeight;

void main() {
  vec3 sum = texture(uSource, vUv + vec2(-uHalfPixel.x * 2.0, 0.0)).rgb;
  sum += texture(uSource, vUv + vec2(-uHalfPixel.x, uHalfPixel.y)).rgb * 2.0;
  sum += texture(uSource, vUv + vec2(0.0, uHalfPixel.y * 2.0)).rgb;
  sum += texture(uSource, vUv + vec2(uHalfPixel.x, uHalfPixel.y)).rgb * 2.0;
  sum += texture(uSource, vUv + vec2(uHalfPixel.x * 2.0, 0.0)).rgb;
  sum += texture(uSource, vUv + vec2(uHalfPixel.x, -uHalfPixel.y)).rgb * 2.0;
  sum += texture(uSource, vUv + vec2(0.0, -uHalfPixel.y * 2.0)).rgb;
  sum += texture(uSource, vUv + vec2(-uHalfPixel.x, -uHalfPixel.y)).rgb * 2.0;

  fragColor = vec4(sum * (uWeight / 12.0), 1.0);
}
`;

/**
 * Chromatic aberration at the frame corner, as a fraction of the viewport
 * width, when the tier's `chromaticAberration` is 1.0.
 *
 * The tier table runs 0.0 at Protostar to 0.8 at Gargantua, so the widest
 * split this project ever shows is 0.8 * 0.0032 = 0.0026 of the width — about
 * five pixels across a 1920-wide frame, at the extreme corner, falling to zero
 * at the centre. That is roughly what a fast wide-angle lens does wide open.
 * An order of magnitude more is the RGB-split "glitch" look, and it is
 * unmistakable; this is meant to be noticed only if you go looking.
 */
const ABERRATION_UNIT = 0.0032;

/**
 * Peak vignette darkening at the corners, as a fraction of linear radiance.
 *
 * Always on and not tier-driven: a vignette is a property of the lens, and the
 * lens does not change when the market cap does.
 */
const VIGNETTE_STRENGTH = 0.32;
/** Radial exponent. Above 2 the falloff stays clear of the middle third. */
const VIGNETTE_FALLOFF = 2.2;

/**
 * Grain amplitude, in display-space units, at tier 11.
 *
 * The tier table's `grainAmount` peaks at 0.27, so this scale puts the
 * strongest grain in the project at 0.27 * 0.105 = 0.0284 — under the brief's
 * 0.03 ceiling, and about 7 levels out of 255 peak to peak. Tier 0 lands at
 * 0.0063, which is two levels: present, never legible as noise.
 */
const GRAIN_SCALE = 0.105;
/**
 * How much of the grain is coloured rather than monochrome.
 *
 * Colour film has three emulsion layers with independent grain, so real grain
 * is not grey; but at full chroma it reads as sensor noise rather than film.
 */
const GRAIN_CHROMA = 0.35;
/**
 * Grain floor in the deepest shadows and brightest highlights.
 *
 * Film grain is strongest in the midtones and falls away at both ends, so the
 * weight below follows 4l(1-l). It does not fall to zero, because the darkest
 * part of this frame is a wide, smooth gradient and a little noise there is
 * doing the same job as the dither.
 */
const GRAIN_SHADOW_FLOOR = 0.45;

/** Master gain on the tier's bloom strength. See PostChain for the reasoning. */
const BLOOM_GAIN = 0.85;

export const COMPOSITE_FRAG = /* glsl */ `
precision highp float;

in vec2 vUv;
out vec4 fragColor;

/** Full-resolution linear HDR scene. Alpha is the bloom mask and unused here. */
uniform sampler2D uScene;
/** Half-resolution accumulated bloom pyramid. */
uniform sampler2D uBloom;
/** Drawing-buffer size in device pixels. */
uniform vec2 uResolution;
/** Mirrors renderer.toneMappingExposure. */
uniform float uExposure;
/** Tier bloom strength, smoothed. 0.25 at Protostar to 1.5 at Gargantua. */
uniform float uBloomStrength;
/** 1 / upsampled level count, so bloom energy does not depend on pyramid depth. */
uniform float uBloomNormalize;
/** Tier chromatic aberration, smoothed. 0.0 to 0.8. */
uniform float uAberration;
/** Tier grain amount, smoothed. 0.06 to 0.27. */
uniform float uGrain;
/** Per-frame grain seed. Derived from scene time, so a pinned time is stable. */
uniform float uGrainSeed;
/**
 * Master scale on grain AND dither. 1 in every normal frame.
 *
 * It exists so the banding check in \`scripts/banding.ts\` can be an experiment
 * rather than an assertion: capture a frame with the noise on, capture the same
 * frame with it off, and compare. Without the second capture the check can only
 * report that the dithered frame has short run lengths, which a frame with no
 * gradients in it would also do. With it, the harness first PROVES the
 * undithered frame bands and then proves the dither removes it.
 */
uniform float uNoiseScale;

${HASH_GLSL}
${TONEMAP_GLSL}

const float ABERRATION_UNIT = ${ABERRATION_UNIT.toFixed(6)};
const float VIGNETTE_STRENGTH = ${VIGNETTE_STRENGTH.toFixed(4)};
const float VIGNETTE_FALLOFF = ${VIGNETTE_FALLOFF.toFixed(4)};
const float GRAIN_SCALE = ${GRAIN_SCALE.toFixed(4)};
const float GRAIN_CHROMA = ${GRAIN_CHROMA.toFixed(4)};
const float GRAIN_SHADOW_FLOOR = ${GRAIN_SHADOW_FLOOR.toFixed(4)};
const float BLOOM_GAIN = ${BLOOM_GAIN.toFixed(4)};

void main() {
  // ---- Radial frame geometry ---------------------------------------------
  // Aspect-corrected, so "radial" means radial on the SCREEN. Without the
  // correction the aberration and the vignette would both be ellipses squashed
  // along the short axis, which on a 21:9 monitor is obvious.
  vec2 centred = vUv - 0.5;
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 radial = centred * aspect;
  // 0 at the centre, 1 at the corners.
  float edge = length(radial) / length(0.5 * aspect);

  // ---- Chromatic aberration ----------------------------------------------
  // Lateral (transverse) aberration: the three wavelengths focus at different
  // IMAGE HEIGHTS, so the split is along the radius and grows toward the
  // corner. Multiplying the already-radial \`centred\` by \`edge\` puts the growth
  // at r^2, which is the shape a real lens shows; a linear split looks
  // uniform, and a constant one looks like a broken video codec.
  //
  // Red is displaced outward and blue inward. That is the sign an
  // uncorrected crown-glass element gives, blue being the shorter wavelength
  // and the more strongly refracted.
  vec2 split = centred * (edge * uAberration * ABERRATION_UNIT);

  vec3 scene = vec3(
    texture(uScene, vUv + split).r,
    texture(uScene, vUv).g,
    texture(uScene, vUv - split).b
  );

  // The bloom is aberrated with the same offsets. It is where the effect is
  // most visible — a bright halo fringes far more legibly than a dark
  // background — and on a half-resolution texture three taps are nearly free.
  vec3 bloom = vec3(
    texture(uBloom, vUv + split).r,
    texture(uBloom, vUv).g,
    texture(uBloom, vUv - split).b
  );

  // ---- Bloom -------------------------------------------------------------
  // Added in linear radiance, before the tone map, because that is what
  // scattered light in a lens does: it arrives as light and is then exposed
  // along with everything else. Added after the tone map it would sit on top
  // of the image as a wash, unable to blow anything out.
  vec3 color = scene + bloom * (uBloomStrength * uBloomNormalize * BLOOM_GAIN);

  // ---- Vignette ----------------------------------------------------------
  // Also linear and also pre-tone-map, for the same reason: a lens vignette is
  // lost illumination, not a darkened print. Corners that lose a third of a
  // stop roll off through the tone map's toe instead of being crushed by it.
  color *= 1.0 - VIGNETTE_STRENGTH * pow(edge, VIGNETTE_FALLOFF);

  // ---- Display transform -------------------------------------------------
  vec3 encoded = filmicSCurve(linearToSrgb(acesFilmic(color, uExposure)));

  // ---- Film grain --------------------------------------------------------
  // Animated, per-device-pixel, and weighted toward the midtones. This is the
  // cheapest thing in the whole file and it does more to stop the image
  // reading as CG than anything above it: a rendered frame is noiseless in a
  // way no photograph has ever been, and the eye knows it without being told.
  vec3 noise = hash33(vec3(gl_FragCoord.xy, uGrainSeed)) - 0.5;
  float mono = (noise.r + noise.g + noise.b) * (1.0 / 3.0);
  vec3 grain = mix(vec3(mono), noise, GRAIN_CHROMA);

  // Weighted on the ENCODED value, not on linear radiance. "Midtone" is a
  // statement about where a value sits on the print, and on this image's
  // dynamic range the linear midpoint is already deep in the highlights.
  float l = luminance(encoded);
  float weight = mix(GRAIN_SHADOW_FLOOR, 1.0, clamp(4.0 * l * (1.0 - l), 0.0, 1.0));

  encoded += grain * (uGrain * GRAIN_SCALE * weight * uNoiseScale);

  // ---- Dither ------------------------------------------------------------
  // Triangular PDF, +/-1 LSB, built from two decorrelated interleaved-gradient
  // samples. TPDF rather than a single uniform sample because uniform dither
  // leaves the residual noise MODULATED by where the signal sits between two
  // levels — which is itself a faint banding pattern, just a subtler one.
  // Triangular dither removes both the bands and that modulation, at the cost
  // of about half a level more noise than nobody will ever see.
  //
  // Both samples are functions of gl_FragCoord alone and never of time, so the
  // pattern is locked to the screen. An animated dither on top of animated
  // grain would beat against it and crawl.
  float d1 = interleavedGradientNoise(gl_FragCoord.xy);
  float d2 = interleavedGradientNoise(gl_FragCoord.xy + vec2(113.0, 71.0));
  encoded += (d1 + d2 - 1.0) * (uNoiseScale / 255.0);

  fragColor = vec4(encoded, 1.0);
}
`;

/** Exported for the verification scripts, which assert the brief's ceilings. */
export const POST_CONSTANTS = {
  bloomThreshold: BLOOM_THRESHOLD,
  bloomKnee: BLOOM_KNEE,
  bloomGain: BLOOM_GAIN,
  aberrationUnit: ABERRATION_UNIT,
  vignetteStrength: VIGNETTE_STRENGTH,
  vignetteFalloff: VIGNETTE_FALLOFF,
  grainScale: GRAIN_SCALE,
  grainChroma: GRAIN_CHROMA,
  grainShadowFloor: GRAIN_SHADOW_FLOOR,
} as const;
