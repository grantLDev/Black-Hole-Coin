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
 * Half-width of the gravitational-wave packet, in aspect-corrected screen
 * units where the frame is 2 units tall.
 *
 * 0.16 makes the packet about a sixth of the frame height across. Much
 * narrower and it aliases into a hard ring as it crosses the photon ring;
 * much wider and the whole frame moves together, which reads as a camera bump
 * rather than as something passing through.
 */
const RIPPLE_WIDTH = 0.16;

/**
 * Peak radial displacement at full amplitude, in the same units.
 *
 * 0.055 is about 3% of the frame height — enough that the shadow's edge
 * visibly bows as the front crosses it, and small enough that nothing leaves
 * the frame and comes back. This is the largest number in the whole tier-up
 * event and the easiest one to overdo: past roughly 0.1 the photon ring tears
 * into two arcs and the effect stops being a wave and starts being a glitch.
 */
const RIPPLE_GAIN = 0.055;

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

/**
 * Gravitational-wave ripple: x is amplitude (0 disables), y is 0..1 phase.
 *
 * THE FIRST CUE OF A TIER-UP, and the only one that touches the shader. A
 * wave packet enters from beyond the frame corner and sweeps to the centre
 * over 0.4 seconds, displacing each ray radially as it passes.
 *
 * It is applied to the RAY DIRECTION rather than as a screen-space UV warp in
 * the post chain, for three reasons. The post chain does not exist on the low
 * quality tier, and a milestone that is invisible on a phone is not a
 * milestone. Warping the finished frame stretches the bloom and the grain
 * along with the image, which reads as the monitor flexing rather than as
 * spacetime doing it. And bending the rays is what a passing wave actually
 * does — the lensed sky, the photon ring and the disk all distort together,
 * consistently, because they are all downstream of the same bent geodesic.
 *
 * The cost is a handful of ALU against a 300-step march, behind a uniform
 * branch that is false on every frame outside those 0.4 seconds.
 */
uniform vec2 uRipple;

const float RIPPLE_WIDTH = ${RIPPLE_WIDTH.toFixed(4)};
const float RIPPLE_GAIN = ${RIPPLE_GAIN.toFixed(4)};

${HASH_GLSL}
${NOISE_GLSL}
${SKY_GLSL}
${BLACKHOLE_GLSL}
${TONEMAP_GLSL}

/**
 * Radial displacement of one aspect-corrected screen coordinate.
 *
 * The packet is a Gaussian envelope on one sine cycle, so it is a single
 * compression followed by a single rarefaction with no ringing on either side
 * — a pulse, not a ripple pattern. Its centre travels from the reach (just
 * outside the frame corner, computed from the actual aspect so a 21:9 monitor
 * is not clipped into the wave a frame late) to just inside zero, which means
 * it enters and leaves the frame under its own geometry. That is why no
 * amplitude envelope is needed: a fade would blunt the wavefront exactly as it
 * crossed the shadow, which is where it is supposed to bite hardest.
 */
vec2 rippleOffset(vec2 frame) {
  float r = length(frame);
  // At the exact centre there is no radial direction. One pixel, and the
  // packet is a hair away from leaving anyway.
  if (r < 1.0e-5) return vec2(0.0);

  float reach = length(vec2(uResolution.x / uResolution.y, 1.0)) + 3.0 * RIPPLE_WIDTH;
  float front = mix(reach, -3.0 * RIPPLE_WIDTH, uRipple.y);
  float d = (r - front) / RIPPLE_WIDTH;

  float packet = exp(-0.5 * d * d) * sin(d * 1.9);
  return (frame / r) * (packet * RIPPLE_GAIN * uRipple.x);
}

void main() {
  // vClip is exactly [-1,1] across the viewport: the triangle overhangs the
  // screen but interpolation is linear, so the clipped span is exact.
  vec2 ndc = vClip;
  ndc.x *= uResolution.x / uResolution.y;

  // Aspect-corrected already, so "radial" is radial on the SCREEN. Skipped
  // entirely outside a tier-up event's first 0.4 seconds.
  if (uRipple.x > 0.0) ndc += rippleOffset(ndc);

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
