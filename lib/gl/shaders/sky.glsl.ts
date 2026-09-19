/**
 * The procedural sky: `vec3 sampleSky(vec3 dir, float spread)`.
 *
 * Contract, because everything else in the renderer depends on it:
 *
 *  - It is a pure function of its arguments. No time, no camera, no screen
 *    position, no derivatives. That is what makes the field rock-solid under
 *    camera motion: a star does not "move" between frames, the camera moves
 *    and the star is simply wherever that direction says it is. Any time
 *    dependence at all — an animated twinkle, a time-seeded hash, a temporal
 *    dither — would reintroduce the crawling this is built to avoid.
 *
 *  - `spread` is how much the ray's geodesic squeezed the sky into one pixel,
 *    and it is the ONLY thing here that is not a function of direction alone.
 *    It is not a look: near the shadow a single pixel genuinely covers a huge
 *    patch of sky, and drawing point stars into it produces fine sparkle that
 *    no amount of resolution fixes, because the star field there is below the
 *    sampling limit by construction. Stars are dimmed by 1/spread^2 and gone
 *    by spread 2.6; the Milky Way, being smooth, is left alone.
 *
 *  - NOTHING in this sky is smaller than one screen pixel. That is the rule
 *    the tiny-pinprick layer was deleted for, and the reason `uPixelAngle` is
 *    the angle of a SCREEN pixel rather than a drawing-buffer pixel.
 *
 *  - It returns LINEAR HDR radiance, not display colour. Bright stars come
 *    back at values well above 1.0 and are expected to be tone mapped. The
 *    numbers below are tuned against ACES specifically: ACES multiplies small
 *    inputs by roughly 0.1 and clips anything under ~0.0022 linear to black,
 *    so "dim" here still means a real number, not 0.001.
 *
 *  - It is evaluated ONCE per escaped ray, so it is written to be cheap: two
 *    star layers over a 3x3 cell neighbourhood each, an FBM that is skipped
 *    outright for the ~60% of the sky the galactic band does not reach, and
 *    both star layers skipped for the strongly lensed rays that were the most
 *    expensive to trace in the first place.
 *
 * Star placement uses a cube-sphere grid rather than a lat/long grid. Lat/long
 * pinches at the poles and seams at the wrap; the cube-sphere has neither. A
 * tangent warp on each face makes cells carry near-equal solid angle, so stars
 * do not visibly clump toward the cube corners.
 */

export const SKY_GLSL = /* glsl */ `
/**
 * Angular size of one SCREEN pixel, in radians — not one drawing-buffer pixel.
 * The host divides out any supersampling before sending it, so a sharper
 * buffer resolves the stars better instead of shrinking them below the size
 * at which they stop being stable. See FullscreenPass.refreshPixelAngle.
 */
uniform float uPixelAngle;

/**
 * Pole of the galactic plane. Pre-normalised — a normalize() here would run on
 * every band lookup, several times per pixel, to produce a constant.
 */
const vec3 GALACTIC_POLE = vec3(0.30999, 0.87996, -0.35998);

/** Faint cold floor so empty sky is deep blue-black rather than dead black. */
const vec3 SKY_FLOOR = vec3(0.0007, 0.0010, 0.0020);

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
  float pixelAngle, float sizePx, float haloWeight,
  float magLow, float magHigh
) {
  // Angular size of one cell, and the point spread radius expressed in cells.
  float cellRadians = (3.14159265 / 4.0) / freq;
  float sigma = (pixelAngle * sizePx) / cellRadians;
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
      // does spread further. The floor keeps every star above ONE SCREEN
      // pixel — see the sizes at the call sites, none of which is below 1.2.
      // A sub-pixel star falls between sample points as the camera turns and
      // blinks in and out, and that — not the hashing — is what makes cheap
      // star fields twinkle. Nothing in this sky is allowed to be that small
      // any more; the layer that used to be is gone entirely.
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

  return tint * glow * 0.030;
}

/**
 * Below this lensing compression the star field is drawn unattenuated, above
 * it there are no stars at all. See sampleSky's 'spread' argument.
 *
 * 2.6 is where a star's own contribution has already fallen to 1/2.6^2 = 15%
 * of nominal, so the cutoff removes almost nothing that was still visible —
 * it exists to stop the point spread function from being stretched so far
 * that the 3x3 cell neighbourhood no longer contains it.
 */
const float LENS_STARS_FULL = 1.35;
const float LENS_STARS_NONE = 2.60;

vec3 sampleSky(vec3 dir, float spread) {
  vec2 uv;
  float face;
  skyFace(dir, uv, face);

  vec3 color = SKY_FLOOR;

  float band = galacticBand(dir);
  if (band > SKY_BAND_CUTOFF) color += milkyWay(dir, band);

  // How much sky one screen pixel covers, in units of the unlensed pixel.
  // Exactly 1 over the great majority of the frame, and large only for the
  // rays that came close enough to wind around the hole — see LENS_FREE.
  float compression = max(spread, 1.0);

  // Surface brightness is what a pixel measures, so a star whose FIELD has
  // been squeezed by 'compression' in each direction contributes 1/compression^2
  // of the light it would unlensed — the same number of photons spread over
  // that many more stars per pixel. Without this the region just outside the
  // shadow shows a whole sky's worth of stars crammed into a few pixels, and
  // since the camera is always turning, each of those pixels lands on a
  // different star every frame. That is the fine sparkle around the middle of
  // the frame, and it is the one place in this scene where the star field
  // cannot be sampled honestly at any resolution.
  float lensFade =
    (1.0 - smoothstep(LENS_STARS_FULL, LENS_STARS_NONE, compression)) / (compression * compression);

  // Below this the layers would tone map to black anyway, and skipping them
  // makes the most expensive rays in the frame — the ones that wrapped the
  // photon sphere — the cheapest to finish.
  if (lensFade < 0.004) return color;

  // The point spread function is widened by the same factor it is dimmed by,
  // which is what keeps a lensed star the size it looks on SCREEN rather than
  // collapsing to a sub-pixel spike. Capped by LENS_STARS_NONE, above which
  // there is nothing left to draw.
  float pixelAngle = uPixelAngle * compression;

  // TWO octaves, not three. The old first layer was a haze of pinpricks at
  // 0.8 pixels across, and a point spread function narrower than the thing
  // sampling it is a star that blinks in and out as the camera turns — the
  // "sparkle" this sky is now explicitly free of. It was removed rather than
  // enlarged: three thousand stars per steradian at a size you can actually
  // resolve is a busy sky, and the Milky Way FBM is already the right tool
  // for unresolved starlight.
  //
  // What is left reads as distance: a middle population, and a sparse scatter
  // of larger bright stars in front of them. Both are about a third less dense
  // than they were, and neither is allowed below 1.2 screen pixels.
  //
  // Density is raised inside the galactic band, which is what actually sells a
  // Milky Way — the band is mostly unresolved starlight, not a painted smear.
  // The boost is evaluated at the RAY's direction rather than each star's,
  // which is safe because band() varies over tens of degrees while a star
  // spans a thousandth of one.
  // The bright end came down with the density. A magnitude-14 star saturates
  // to white across several pixels and keeps a visible halo for several more,
  // which reads as a lens flare rather than a star — and with the pinprick
  // layer gone there is nothing left to hide behind it. At 8 the core is
  // still unmistakably a bright star and the halo has stopped announcing
  // itself.
  color += lensFade *
    starLayer(uv, face, 27.0, 37.0, 0.105 * (1.0 + 1.10 * band), pixelAngle, 1.20, 0.05, 0.15, 2.10);
  color += lensFade *
    starLayer(uv, face, 11.0, 91.0, 0.091 * (1.0 + 0.40 * band), pixelAngle, 1.45, 0.08, 0.80, 8.00);

  return color;
}
`;
