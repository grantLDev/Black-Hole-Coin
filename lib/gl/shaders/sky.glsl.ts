/**
 * The procedural sky: `vec3 sampleSky(vec3 dir)`.
 *
 * Contract, because everything else in the renderer depends on it:
 *
 *  - It is a pure function of `dir`. No time, no camera, no screen position,
 *    no derivatives. That is what makes the field rock-solid under camera
 *    motion: a star does not "move" between frames, the camera moves and the
 *    star is simply wherever that direction says it is. Any time dependence at
 *    all — an animated twinkle, a time-seeded hash, a temporal dither — would
 *    reintroduce the crawling this is built to avoid.
 *
 *  - It returns LINEAR HDR radiance, not display colour. Bright stars come
 *    back at values well above 1.0 and are expected to be tone mapped. The
 *    numbers below are tuned against ACES specifically: ACES multiplies small
 *    inputs by roughly 0.1 and clips anything under ~0.0022 linear to black,
 *    so "dim" here still means a real number, not 0.001.
 *
 *  - It is evaluated ONCE per escaped ray, so it is written to be cheap: three
 *    star layers at one grid cell each, and an FBM that is skipped outright
 *    for the ~60% of the sky the galactic band does not reach.
 *
 * Star placement uses a cube-sphere grid rather than a lat/long grid. Lat/long
 * pinches at the poles and seams at the wrap; the cube-sphere has neither. A
 * tangent warp on each face makes cells carry near-equal solid angle, so stars
 * do not visibly clump toward the cube corners.
 */

export const SKY_GLSL = /* glsl */ `
/** Angular size of one drawing-buffer pixel, in radians. */
uniform float uPixelAngle;

/**
 * Pole of the galactic plane. Pre-normalised — a normalize() here would run on
 * every band lookup, several times per pixel, to produce a constant.
 */
const vec3 GALACTIC_POLE = vec3(0.30999, 0.87996, -0.35998);

/** Faint cold floor so empty sky is deep blue-black rather than dead black. */
const vec3 SKY_FLOOR = vec3(0.0010, 0.0014, 0.0026);

/**
 * Below this the galactic band's contribution tone maps to literally zero, so
 * the FBM behind it is pure waste. Skipping it removes the single most
 * expensive part of the sky for most of the sphere.
 */
const float SKY_BAND_CUTOFF = 0.02;

/**
 * Direction -> (cube face, face coordinate in [-1,1]^2).
 *
 * The atan() is a tangent warp: on a raw cube map, equal steps in face
 * coordinates span very unequal angles, and a uniform grid on the face ends up
 * ~5x denser in solid angle at the cube corners than at the face centre, which
 * reads as eight star clumps. atan(t) * 4/PI maps [-1,1] onto itself with
 * near-uniform angular spacing, taking that ratio down to ~1.4x.
 */
void skyFace(vec3 d, out vec2 uv, out float face) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) {
    face = d.x > 0.0 ? 0.0 : 1.0;
    uv = vec2(d.z, d.y) / a.x;
  } else if (a.y >= a.z) {
    face = d.y > 0.0 ? 2.0 : 3.0;
    uv = vec2(d.x, d.z) / a.y;
  } else {
    face = d.z > 0.0 ? 4.0 : 5.0;
    uv = vec2(d.x, d.y) / a.z;
  }
  uv = atan(uv) * (4.0 / 3.14159265);
}

/** Exact inverse of skyFace(): (face coordinate, face) -> unit direction. */
vec3 skyDir(vec2 uv, float face) {
  vec2 t = tan(uv * (3.14159265 / 4.0));
  if (face < 1.5) return normalize(vec3(face < 0.5 ? 1.0 : -1.0, t.y, t.x));
  if (face < 3.5) return normalize(vec3(t.x, face < 2.5 ? 1.0 : -1.0, t.y));
  return normalize(vec3(t.x, t.y, face < 4.5 ? 1.0 : -1.0));
}

/** 1 on the galactic equator, falling to ~0 about 25 degrees off it. */
float galacticBand(vec3 dir) {
  float b = dot(dir, GALACTIC_POLE);
  return exp(-b * b * 21.0);
}

/**
 * A coarse blackbody ramp: hot blue-white -> white -> pale yellow -> faint red.
 * Callers bias t toward the middle, so most stars are white to pale yellow and
 * both the blue and the red ends stay rare — which is what a real field looks
 * like, and what stops the sky reading as confetti.
 */
vec3 starColor(float t) {
  vec3 c = mix(vec3(0.66, 0.78, 1.00), vec3(1.00, 0.99, 0.97), smoothstep(0.00, 0.35, t));
  c = mix(c, vec3(1.00, 0.93, 0.76), smoothstep(0.35, 0.72, t));
  c = mix(c, vec3(1.00, 0.70, 0.49), smoothstep(0.72, 1.00, t));
  return c;
}

/**
 * One density octave of stars.
 *
 * Two things here are load-bearing.
 *
 * The 3x3 neighbourhood. Testing only the ray's own cell forces every star to
 * be inset away from its cell edges, so its falloff cannot be clipped — and
 * that dead margin around every cell is instantly legible as a lattice of
 * rows and columns. Full-cell jitter plus neighbours is the difference between
 * a field that looks scattered and one that looks stamped. The neighbourhood
 * is 3x3 rather than 2x2 because the point spread is sized in PIXELS, so in
 * cell units it grows as resolution falls, and 2x2 stops being exact on small
 * buffers.
 *
 * Measuring distance in face coordinates rather than reconstructing each
 * star's direction. The tangent warp in skyFace() is very nearly an isometry:
 * the scale from face coordinates to radians is exactly PI/4 at a face centre
 * AND at every edge midpoint, dipping only to 0.943 * PI/4 at the cube
 * corners. A sub-6% error on a point spread radius is invisible, and it keeps
 * two tan() calls and a normalize() out of a loop that runs nine times per
 * layer.
 *
 * freq must be a whole number: face coordinates run [-1,1], so an integer
 * frequency tiles each face exactly and cell boundaries line up across face
 * edges.
 */
vec3 starLayer(
  vec2 uv, float face,
  float freq, float seed,
  float density,
  float sizePx, float haloWeight,
  float magLow, float magHigh
) {
  // Angular size of one cell, and the point spread radius expressed in cells.
  float cellRadians = (3.14159265 / 4.0) / freq;
  float sigma = (uPixelAngle * sizePx) / cellRadians;
  // (6 sigma) squared, with headroom for the per-star size jitter below.
  float cutoff = 36.0 * 1.7 * sigma * sigma;

  vec2 grid = uv * freq;
  vec2 base = floor(grid);
  vec3 total = vec3(0.0);

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 cell = base + vec2(float(x), float(y));

      vec3 h = hash33(vec3(cell, face * 13.0 + seed));
      if (h.z >= density) continue;

      // Jitter spans the whole cell. Anything less leaves a visible margin.
      vec2 delta = cell + h.xy - grid;
      float d2 = dot(delta, delta);
      if (d2 > cutoff) continue;

      vec3 r = hash33(vec3(cell, face * 13.0 + seed + 101.7));

      // Cubed, so most stars sit near the dim end and bright ones are rare.
      float brightness = r.x * r.x * r.x;
      float magnitude = mix(magLow, magHigh, brightness);

      // Size is partly coupled to magnitude, because a brighter star really
      // does spread further. The floor keeps every star above ~0.8 buffer
      // pixels: a sub-pixel star falls between sample points as the camera
      // turns and blinks in and out, and that — not the hashing — is what
      // makes cheap star fields twinkle.
      float s = sigma * (0.88 + 0.30 * r.z + 0.26 * brightness);
      float x2 = d2 / (s * s);

      // Gaussian core plus a tight, dim halo. The halo is deliberately narrow:
      // real glare around bright stars is the job of the bloom pass, not of a
      // fattened point spread function.
      float intensity = (exp(-x2) + haloWeight * exp(-x2 * 0.3)) * magnitude;

      float t = 2.0 * r.y - 1.0;
      total += starColor(0.5 + 0.5 * t * t * t) * intensity;
    }
  }

  return total;
}

/**
 * The Milky Way: a dusty, desaturated band of unresolved light along a tilted
 * great circle, broken up by dark foreground dust lanes.
 */
vec3 milkyWay(vec3 dir, float band) {
  float clouds = fbm(dir * 2.7);
  float fine = fbm(dir * 6.5 + vec3(41.0, 17.0, 63.0));

  float glow = band * (0.25 + 1.05 * clouds * clouds) * (0.72 + 0.56 * fine);

  // Dust lanes are opaque foreground material, so they multiply the light
  // down rather than adding darkness, and they hug the equator far more
  // tightly than the glow does.
  float b = dot(dir, GALACTIC_POLE);
  float lane = smoothstep(0.42, 0.78, fine) * exp(-b * b * 120.0);
  glow *= 1.0 - 0.85 * lane;

  // Cool where the cloud is thick and hot, dusty ochre where it is thin and
  // reddened. Both far off saturated: this is atmosphere, not a feature.
  vec3 tint = mix(vec3(0.96, 0.84, 0.69), vec3(0.70, 0.78, 0.96), smoothstep(0.30, 0.80, clouds));

  return tint * glow * 0.036;
}

vec3 sampleSky(vec3 dir) {
  vec2 uv;
  float face;
  skyFace(dir, uv, face);

  vec3 color = SKY_FLOOR;

  float band = galacticBand(dir);
  if (band > SKY_BAND_CUTOFF) color += milkyWay(dir, band);

  // Three octaves. Frequency falls while size and brightness rise, so the
  // layers read as distance: a haze of faint pinpricks, a middle population,
  // and a sparse scatter of large bright stars in front of them.
  //
  // Density is raised inside the galactic band, which is what actually sells a
  // Milky Way — the band is mostly unresolved starlight, not a painted smear.
  // The boost is evaluated at the RAY's direction rather than each star's,
  // which is safe because band() varies over tens of degrees while a star
  // spans a thousandth of one.
  color += starLayer(uv, face, 64.0,  0.0, 0.130 * (1.0 + 2.20 * band), 0.80, 0.00, 0.05,  0.45);
  color += starLayer(uv, face, 27.0, 37.0, 0.150 * (1.0 + 1.10 * band), 0.95, 0.05, 0.15,  2.60);
  color += starLayer(uv, face, 11.0, 91.0, 0.130 * (1.0 + 0.40 * band), 1.20, 0.16, 0.80, 14.00);

  return color;
}
`;
