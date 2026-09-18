/**
 * Shared GLSL ES 3.00 chunks: hashing, noise, and the display transform.
 *
 * GLSL lives in `.ts` files as template literals rather than in `.glsl` files
 * on purpose. A `.glsl` import needs a bundler loader, and the loader has to be
 * configured identically for Turbopack (`next dev`) and webpack (`next build`)
 * or the production build breaks in a way development never shows. Template
 * literals need no loader, work identically in both, and still compose.
 *
 * The `/* glsl *\/` tag before each literal is what editors and Prettier use to
 * syntax-highlight and format the contents.
 */

/**
 * Hashing.
 *
 * These are the "hash without sine" functions (Dave Hoskins, MIT). The obvious
 * `fract(sin(dot(p, k)) * 43758.5453)` is avoided deliberately: `sin` is
 * implemented at wildly different precisions across GPUs, so a sine hash
 * produces a visibly DIFFERENT star field on different devices, and on some
 * mobile drivers it degenerates into stripes at large coordinates. These are
 * pure float arithmetic and are stable everywhere.
 */
export const HASH_GLSL = /* glsl */ `
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash23(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
`;

/**
 * Trilinear value noise and FBM over a 3D domain.
 *
 * Deliberately 3D rather than 2D-on-a-sphere-parameterisation: sampling noise
 * with the ray direction itself means there is no seam and no pole, because
 * there is no parameterisation to be discontinuous.
 *
 * `SKY_FBM_OCTAVES` is supplied as a `#define` by the quality tier, so the loop
 * bound stays a compile-time constant and the loop can be unrolled by the
 * driver. A `uniform int` bound would cost more than the octaves it saves.
 */
export const NOISE_GLSL = /* glsl */ `
float valueNoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  // Quintic fade: C2 continuous, so FBM sums have no visible grid creases.
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z
  );
}

float fbm(vec3 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  float total = 0.0;
  for (int i = 0; i < SKY_FBM_OCTAVES; i++) {
    sum += amplitude * valueNoise(p);
    total += amplitude;
    // The lacunarity is off-integer and each octave is offset so the octaves
    // never line up and reinforce into a visible lattice.
    p = p * 2.03 + vec3(17.13, 9.37, 31.71);
    amplitude *= 0.5;
  }
  return sum / total;
}
`;

/**
 * Display transform: ACES filmic tone map, then the sRGB OETF.
 *
 * This pass uses a `RawShaderMaterial`, which three.js gives NO injected
 * chunks — `#include <tonemapping_fragment>` and `#include <colorspace_fragment>`
 * simply do not exist here, and `renderer.toneMapping` / `renderer.outputColorSpace`
 * therefore have no effect on this shader. So the transform is written out
 * explicitly below.
 *
 * It is a character-for-character port of three's own `ACESFilmicToneMapping`
 * and `sRGBTransferOETF`, and the renderer is configured to the matching
 * values. That is not redundancy: it means the moment a later pass IS a
 * `ShaderMaterial` (or an `EffectComposer` `OutputPass` lands with the bloom
 * chain), it produces identical pixels to this one.
 *
 * Exposure is driven from `renderer.toneMappingExposure` through a uniform, so
 * there is still exactly one place to change it.
 */
export const TONEMAP_GLSL = /* glsl */ `
const mat3 ACES_INPUT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);

const mat3 ACES_OUTPUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602
);

vec3 rrtAndOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color, float exposure) {
  color *= exposure / 0.6;
  color = ACES_INPUT * color;
  color = rrtAndOdtFit(color);
  color = ACES_OUTPUT * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  return mix(
    pow(c, vec3(0.41666)) * 1.055 - vec3(0.055),
    c * 12.92,
    vec3(lessThanEqual(c, vec3(0.0031308)))
  );
}

/**
 * Interleaved gradient noise, used as an ordered dither before quantisation to
 * 8 bits. The Milky Way is a wide, very dark gradient and would band badly
 * without it.
 *
 * It is a function of gl_FragCoord ONLY, never of time. An animated dither
 * would show up as exactly the crawling shimmer the star field is built to
 * avoid; fixed to the screen it is invisible.
 */
float interleavedGradientNoise(vec2 fragCoord) {
  return fract(52.9829189 * fract(0.06711056 * fragCoord.x + 0.00583715 * fragCoord.y));
}
`;
