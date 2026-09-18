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
 * `SKY_FBM_OCTAVES` arrives as a `#define` from the active quality profile.
 */
export const SCENE_FRAG = /* glsl */ `
precision highp float;
precision highp int;

in vec2 vClip;
out vec4 fragColor;

/**
 * Ray origin in world space.
 *
 * Unused by the sky, which is infinitely far away and therefore a function of
 * direction alone — it is the raymarched black hole that needs an origin. It
 * is uploaded from today so the camera contract is fixed before anything
 * depends on it.
 */
uniform vec3 uCameraPosition;

/** Columns are (right, up, forward). Orthonormal, so no inverse is needed. */
uniform mat3 uCameraBasis;

/** tan(verticalFov / 2). */
uniform float uTanHalfFov;

/** Drawing-buffer size in device pixels. */
uniform vec2 uResolution;

/** Mirrors renderer.toneMappingExposure. */
uniform float uExposure;

${HASH_GLSL}
${NOISE_GLSL}
${SKY_GLSL}
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

  // No black hole yet: every ray escapes.
  vec3 radiance = sampleSky(rayDir);

  vec3 color = linearToSrgb(acesFilmic(radiance, uExposure));

  // Dither in display space, immediately before the 8-bit framebuffer
  // quantises it. The galactic band is a very dark, very wide gradient and
  // bands visibly without this.
  color += (interleavedGradientNoise(gl_FragCoord.xy) - 0.5) / 255.0;

  fragColor = vec4(color, 1.0);
}
`;
