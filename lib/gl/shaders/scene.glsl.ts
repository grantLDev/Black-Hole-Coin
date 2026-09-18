/**
 * The single pass. One fullscreen triangle, one fragment shader, no scene
 * graph geometry — everything visible is computed per pixel from a ray.
 *
 * A triangle rather than a quad: a quad is two triangles that meet along the
 * screen diagonal, and every GPU shades in 2x2 quads, so the pixels straddling
 * that diagonal get shaded twice. One oversized triangle clipped to the
 * viewport covers the same pixels with none of that waste, and needs three
 * vertices instead of six.
 */

import { BLACKHOLE_GLSL } from "./blackhole.glsl";
import { HASH_GLSL, NOISE_GLSL, TONEMAP_GLSL } from "./common.glsl";
import { SKY_GLSL } from "./sky.glsl";

/**
 * Clip-space passthrough.
 *
 * The attribute is named `position` because three.js reads the draw count from
 * `geometry.attributes.position`, and the vertices are already in clip space,
 * so there is no model, view, or projection matrix anywhere in this project.
 */
export const SCENE_VERT = /* glsl */ `
precision highp float;

in vec3 position;
out vec2 vClip;

void main() {
  vClip = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Ray generation and composite.
 *
 * `SKY_FBM_OCTAVES`, `DISK_FBM_OCTAVES`, and `MARCH_STEPS` arrive as `#define`s
 * from the active quality profile. `MARCH_STEPS` is the compile-time CEILING on
 * the march loop; the runtime budget is the `uQualitySteps` uniform, which the
 * host clamps to it. Both exist on purpose: a constant loop bound is what lets
 * the driver schedule registers sanely, and a uniform is what lets the step
 * count be changed without a recompile.
 *
 * TWO OUTPUT MODES, selected by the `SCENE_TO_HDR_TARGET` define.
 *
 *   0 — direct to the default framebuffer. The shader tone maps, encodes to
 *       sRGB and dithers itself, and alpha is meaningless. This is the
 *       low-quality path with the post chain switched off, and it is the exact
 *       image this project rendered before the post chain existed.
 *
 *   1 — to a half-float render target for the post chain. RGB is untouched
 *       linear radiance and ALPHA carries the emissive luminance, which is the
 *       bloom mask. No tone map, no sRGB, no dither: doing any of those here
 *       would mean blooming, aberrating and grading display-encoded values,
 *       which is the difference between light behaving like light and a filter
 *       stack smeared over a finished picture.
 *
 * The switch is a define rather than a uniform because it changes what the
 * shader WRITES, and a branch on a uniform would leave the dead tone map in
 * the instruction stream on the path that costs the most.
 */
export const SCENE_FRAG = /* glsl */ `
precision highp float;
precision highp int;

in vec2 vClip;
out vec4 fragColor;

/** Ray origin in world space, in Schwarzschild radii. */
uniform vec3 uCameraPosition;

/** Columns are (right, up, forward). Orthonormal, so no inverse is needed. */
uniform mat3 uCameraBasis;

/** tan(verticalFov / 2). */
uniform float uTanHalfFov;

/** Drawing-buffer size in device pixels. */
uniform vec2 uResolution;

/**
 * Mirrors renderer.toneMappingExposure.
 *
 * Only read when SCENE_TO_HDR_TARGET is 0. In the post path the composite pass
 * owns the display transform and receives the same value, so there is still
 * one exposure control for the whole renderer.
 */
uniform float uExposure;

${HASH_GLSL}
${NOISE_GLSL}
${SKY_GLSL}
${BLACKHOLE_GLSL}
${TONEMAP_GLSL}

void main() {
  // vClip is exactly [-1,1] across the viewport: the triangle overhangs the
  // screen but interpolation is linear, so the clipped span is exact.
  vec2 ndc = vClip;
  ndc.x *= uResolution.x / uResolution.y;

  // The basis columns are (right, up, forward), so this is
  // right * x + up * y + forward * 1 with no matrix inverse and no sign
  // conventions to get wrong.
  vec3 rayDir = normalize(uCameraBasis * vec3(ndc * uTanHalfFov, 1.0));

  // The one call that produces the entire image. Disk, photon ring, shadow,
  // jets, and the lensed sky behind all of it come back in linear HDR, split
  // into everything and disk-plus-jets-only.
  TraceResult trace = traceBlackHole(uCameraPosition, rayDir);

#if SCENE_TO_HDR_TARGET
  // Alpha is the bloom mask: the luminance the disk and the jets contributed,
  // in the same linear units as RGB. The composite recovers the emissive
  // COLOUR from it as rgb * (a / luminance(rgb)) — exact whenever one source
  // dominates the pixel, which is the case everywhere bright enough to bloom,
  // and gracefully wrong only where a faint star shows through faint gas.
  //
  // One channel instead of a second render target on purpose: the alpha of the
  // scene target is otherwise dead weight (nothing here is transparent), so
  // the mask is free, where MRT would cost another full-resolution surface and
  // its bandwidth on every frame.
  fragColor = vec4(trace.radiance, luminance(trace.emissive));
#else
  vec3 color = filmicSCurve(linearToSrgb(acesFilmic(trace.radiance, uExposure)));

  // Dither in display space, immediately before the 8-bit framebuffer
  // quantises it. The galactic band and the outer disk are both very dark,
  // very wide gradients and band visibly without this.
  color += (interleavedGradientNoise(gl_FragCoord.xy) - 0.5) / 255.0;

  fragColor = vec4(color, 1.0);
#endif
}
`;
