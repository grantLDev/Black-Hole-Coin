/**
 * The black hole: `TraceResult traceBlackHole(vec3 origin, vec3 rayDir)`.
 *
 * Everything in the frame that is not background sky is produced here, by
 * integrating null geodesics through a Schwarzschild metric in units where the
 * Schwarzschild radius rs = 1. Nothing is a textured sphere, a billboard, or a
 * particle system: the shadow, the photon ring, the over-and-under wrap of the
 * far side of the disk, and the Einstein ring of lensed background stars are
 * all consequences of the same integration.
 *
 * THE INTEGRATOR
 *
 * A photon's orbit in Schwarzschild obeys
 *
 *     d^2u/dphi^2 + u = (3/2) rs u^2,        u = 1/r
 *
 * which in Cartesian form, with h = r x v conserved, is
 *
 *     d^2r/dlambda^2 = -(3/2) h^2 r / |r|^5
 *
 * That is the acceleration used below, and it is not an approximation of the
 * trajectory SHAPE — substituting r = 1/u and lambda -> phi recovers the orbit
 * equation exactly. What it does give up is the parameterisation: |v| drifts
 * slowly along the path because the acceleration is not perpendicular to the
 * velocity. That costs nothing here, because every consumer of the integration
 * wants a direction (`normalize(vel)`) or a position, never a speed.
 *
 * Two properties fall out of this and are worth stating, because they are the
 * things that would be wrong if this were faked:
 *
 *  - The photon sphere sits at r = 1.5 and the apparent shadow radius at
 *    3*sqrt(3)/2 ~= 2.598 rs. Neither number appears anywhere in this file.
 *    They emerge from the integration, which is the whole point: a hand-drawn
 *    disc of radius 2.6 would not also produce the photon ring, and a
 *    hand-drawn ring would not also bend the starfield around it.
 *
 *  - h is conserved EXACTLY by the update below (dh/dlambda = r x a + v x v,
 *    and a is parallel to r, so both terms vanish), which is why the ring
 *    stays sharp instead of drifting into a smear over a few hundred steps.
 *
 * STEP SIZING
 *
 * Fixed steps are the reason most raymarched black holes have a mushy photon
 * ring: the step that resolves r = 1.5 is ~100x smaller than the step that is
 * adequate at r = 40, so a fixed step is either ruinously slow or badly
 * under-sampled where it matters. Two criteria run here, and the smaller wins:
 *
 *   1. dt <= uStepScale * r      — geometric, keeps the step a fixed fraction
 *                                  of the distance to the hole.
 *   2. dt <= uTurnLimit / |a|    — angular, bounds how far the ray may TURN in
 *                                  one step, since |v| ~ 1.
 *
 * Criterion 2 is what resolves the photon ring, and it is self-tuning: |a| is
 * largest exactly where the trajectory curves hardest. Criterion 1 is what
 * makes the other 90% of the screen nearly free — a ray with impact parameter
 * 20 has |a| ~ 0.004 at closest approach, so criterion 2 never binds and the
 * ray escapes in about a dozen steps.
 */

export const BLACKHOLE_GLSL = /* glsl */ `
/**
 * What one ray came back with, split by SOURCE rather than by brightness.
 *
 * \`radiance\` is the finished pixel. \`emissive\` is the part of it that the disk
 * and the jets put there — everything accumulated along the geodesic, with the
 * lensed background sky left out.
 *
 * The split exists for the bloom pass and it is the reason the brief's "only
 * the disk and the photon ring bloom, never the stars" is a structural
 * guarantee here instead of a threshold that happens to work. A star is a
 * near-delta spike of radiance: any luminance threshold high enough to reject
 * the bright ones also rejects most of the disk, and any threshold low enough
 * to keep the disk turns every star into a soft blob. Neither compromise is
 * necessary once the shader simply says which photons came from where.
 *
 * The photon ring lands on the correct side of the split for free. It is not a
 * drawn feature — it is the disk, seen through rays that wound around the hole
 * and struck the same annulus several times — so it is already in
 * \`emissive\`. The Einstein ring of lensed BACKGROUND stars sits a fraction of
 * a degree away from it in the same image and is correctly excluded, which no
 * screen-space threshold could ever manage.
 */
struct TraceResult {
  /** The full pixel in linear HDR: disk, jets, and lensed sky. */
  vec3 radiance;
  /** Disk and jets only. Always <= radiance componentwise. */
  vec3 emissive;
};

/** Scene time in seconds, wrapped by the host — see Renderer.SHADER_TIME_WRAP. */
uniform float uTime;

/** Outer edge of the accretion disk, in rs. Tier-driven, lerped by VisualState. */
uniform float uDiskOuterRadius;
/** Emissive multiplier on the disk source function. Tier-driven. */
uniform float uDiskBrightness;
/** Contrast of the filamentary noise, and the domain-warp amplitude. */
uniform float uDiskTurbulence;
/** Disk colour at the hottest, most blueshifted point. */
uniform vec3 uDiskColorInner;
/** Disk colour at the coolest, most redshifted point. */
uniform vec3 uDiskColorOuter;

/** 0..1 polar jets. Ratcheted: rises once, never falls. See VisualState. */
uniform float uJetStrength;

/** Runtime march budget. Clamped by the host to the MARCH_STEPS ceiling. */
uniform int uQualitySteps;
/** Geometric step criterion: dt <= uStepScale * r. */
uniform float uStepScale;
/** Angular step criterion: dt <= uTurnLimit / |accel|, in radians per step. */
uniform float uTurnLimit;
/** Radius past which an outbound ray is background. Host keeps it > camera r. */
uniform float uEscapeRadius;

// ---------------------------------------------------------------------------
// Geometry constants. All in Schwarzschild radii.
// ---------------------------------------------------------------------------

/**
 * Inner edge of the disk.
 *
 * The Schwarzschild ISCO is at 3 rs, not 2.2. This is a deliberate departure:
 * Gargantua is a near-extremal Kerr hole whose prograde ISCO sits just outside
 * the horizon, and pulling the inner edge in to 2.2 is what makes the disk hug
 * the photon ring the way the references do. Stopping at 3 rs leaves a visible
 * gap between the disk and the shadow that reads immediately as wrong.
 *
 * It is a hard floor, not a soft one: 2.2 is still outside the photon sphere
 * at 1.5, so the disk never intersects the region where the ray count would
 * explode.
 */
const float DISK_INNER_RADIUS = 2.2;

/** Longest step allowed anywhere. Pure insurance against a runaway dt. */
const float MARCH_MAX_STEP = 6.0;
/** Shortest step allowed. Keeps a ray from stalling just outside the horizon. */
const float MARCH_MIN_STEP = 0.003;
/** Below this, everything behind is occluded and the march can stop. */
const float TRANSMITTANCE_EPSILON = 0.004;

// ---------------------------------------------------------------------------
// Disk constants.
// ---------------------------------------------------------------------------

/**
 * Radial emissivity falloff exponent.
 *
 * A Shakura-Sunyaev disk has T ~ r^-0.75, so surface brightness ~ T^4 ~ r^-3.
 * Across the tier-11 disk (2.2 to 11.5 rs) that is a 143x falloff, which tone
 * maps the outer disk to black — not what the references show. At 1.6 the
 * falloff is 14x, which keeps the outer disk legible as deep orange while the
 * inner edge still dominates: once Doppler beaming is included the approaching
 * inner limb outshines the outer disk by roughly 45x.
 * The TEMPERATURE profile below is left at the physical -0.75 — this softening
 * is applied to brightness only, so the colours stay honest.
 */
const float DISK_EMISSIVITY_FALLOFF = 1.6;

/** Vertical half-thickness at the inner edge and far outside it. */
const float DISK_H_INNER = 0.34;
const float DISK_H_OUTER = 0.05;
/** e-folding scale over which the puffy inner region thins out. */
const float DISK_H_DECAY = 0.50;
/** Optical depth per unit path length through the slab at unit density. */
const float DISK_OPACITY = 1.55;
/** Floor on |dir.y| so an exactly-in-plane ray gets finite optical depth. */
const float DISK_GRAZE_FLOOR = 0.055;

/** Radial width of the soft inner and outer edges. */
const float DISK_INNER_FEATHER = 0.20;
const float DISK_OUTER_FEATHER = 1.30;

/**
 * Pattern advection rate, as a multiple of the physical orbital frequency.
 *
 * The Doppler maths below uses the true orbital velocity; this scales only how
 * fast the NOISE is carried around, so the disk reads as moving on a human
 * timescale. At 1.0 the inner edge takes 29s per revolution, which is close
 * enough to static to look like a still image on a landing page.
 */
const float DISK_SPIN_SCALE = 2.0;

/** Base frequency of the filament noise: around the disk, and across it. */
const float DISK_NOISE_ANGULAR = 1.7;
const float DISK_NOISE_RADIAL = 2.9;

/** Ends of the colour ramp beyond the tier's own two stops. */
const vec3 DISK_EMBER = vec3(0.34, 0.048, 0.010);
const vec3 DISK_BLUE = vec3(0.70, 0.83, 1.00);

/** Ceiling on beta. Only reachable if DISK_INNER_RADIUS is pushed near 1. */
const float DISK_MAX_BETA = 0.94;

// ---------------------------------------------------------------------------
// Jet constants. Gated entirely behind uJetStrength > 0.
// ---------------------------------------------------------------------------

/** Jets start above the disk's puffy inner region and die out by here. */
const float JET_BASE = 0.9;
const float JET_REACH = 30.0;
/** Cone: radius = JET_RADIUS0 + JET_OPENING * (|y| - JET_BASE). */
const float JET_RADIUS0 = 0.20;
const float JET_OPENING = 0.075;
/** Step ceiling inside the jet bound, so the volume is not aliased. */
const float JET_STEP_CAP = 0.6;
/** Radians of helical twist per rs of height. */
const float JET_TWIST = 0.55;
/** Rotation of the helix, and outward travel of the knots, per second. */
const float JET_SPIN = 0.30;
const float JET_KNOT_SPEED = 2.6;
/** e-folding height over which the jet fades out. */
const float JET_DECAY = 0.105;
/** Emission per unit path length at full strength. */
const float JET_GAIN = 0.55;

const vec3 JET_COOL = vec3(0.26, 0.48, 1.00);
const vec3 JET_HOT = vec3(0.86, 0.95, 1.00);

// ---------------------------------------------------------------------------
// Disk noise.
// ---------------------------------------------------------------------------

/**
 * Filamentary FBM over the disk, seamless in phi and strongly anisotropic.
 *
 * The angular coordinate arrives as a UNIT VECTOR (cos a, sin a) rather than
 * as the angle itself. That is what makes it seamless: sampling 3D noise on a
 * circle has no wrap to be discontinuous at, unlike feeding phi in directly,
 * which tears along phi = +-pi. Scaling the circle's radius scales arc length
 * per radian, so multiplying 'unit' by 'ka' IS the angular frequency — no
 * second sin/cos is needed for the higher octaves.
 *
 * Anisotropy is the whole point. At r = 4 one noise cell spans ~2.4 rs of arc
 * but only ~0.34 rs of radius, so features come out 7x longer than they are
 * wide: streaked gas, not blobs. The radial lacunarity (2.7) is deliberately
 * larger than the angular one (2.1), so the streaks get thinner faster than
 * they get shorter as the octaves stack.
 */
float diskFbm(vec2 unit, float radial, float seed) {
  float ka = DISK_NOISE_ANGULAR;
  float kr = DISK_NOISE_RADIAL;
  float amplitude = 0.5;
  float sum = 0.0;
  float total = 0.0;

  for (int i = 0; i < DISK_FBM_OCTAVES; i++) {
    sum += amplitude * valueNoise(vec3(unit * ka, radial * kr + seed));
    total += amplitude;
    ka *= 2.1;
    kr *= 2.7;
    seed += 23.4;
    amplitude *= 0.5;
  }

  return sum / total;
}

/**
 * The tier's two colour stops, extended at both ends.
 *
 * t is an OBSERVED temperature: the local blackbody temperature after Doppler
 * and gravitational shift. Extending the ramp past both tier colours is what
 * lets the shift do something visible — the approaching inner edge runs past
 * white into blue, the receding outer edge falls past the tier's orange into
 * ember. Clamping to the two tier colours instead would leave the disk looking
 * uniformly lit no matter how hard it is beamed.
 */
vec3 diskRamp(float t) {
  vec3 c = mix(DISK_EMBER, uDiskColorOuter, smoothstep(0.00, 0.40, t));
  c = mix(c, uDiskColorInner, smoothstep(0.40, 0.90, t));
  return mix(c, DISK_BLUE, smoothstep(0.90, 1.55, t));
}

/**
 * Accumulate one equatorial disk crossing.
 *
 * 'hit' is the interpolated crossing point (hit.y ~ 0) and 'dir' is the ray's
 * LOCAL direction there, which after lensing is nothing like the direction it
 * left the camera with — using the camera ray here would beam the lensed far
 * side of the disk as if it were the near side, and the over-and-under wrap
 * would come out symmetric and dead.
 */
void accumulateDisk(vec3 hit, vec3 dir, inout vec3 radiance, inout float transmittance) {
  float r = length(hit);
  if (r < DISK_INNER_RADIUS || r > uDiskOuterRadius) return;

  // ---- Kinematics --------------------------------------------------------
  // rs = 1 means M = 0.5. Angular velocity at infinity is sqrt(M/r^3); the
  // orbital speed a LOCAL static observer measures is sqrt(M/(r - 2M)), which
  // is the one the Doppler factor wants. It gives exactly 0.5c at the ISCO,
  // which is the standard check that this is the right expression.
  float omega = sqrt(0.5) * inversesqrt(r * r * r);
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.05)), DISK_MAX_BETA);
  float gamma = inversesqrt(max(1.0 - beta * beta, 1.0e-4));

  // Prograde about +Y. Normalising cross(up, hit) rather than dividing by r
  // costs one rsqrt and stays exact if hit.y has drifted off the plane.
  vec3 tangent = normalize(cross(vec3(0.0, 1.0, 0.0), hit));

  // SIGN CONVENTION, and it is the easy thing to get backwards: 'dir' runs
  // camera -> emitter, so the emitter -> observer direction is -dir, and
  //   delta = 1 / (gamma (1 - beta . n_toObserver)) = 1 / (gamma (1 + beta . dir)).
  // Getting this wrong flips which limb is bright and the image still looks
  // plausible, which is why it is spelled out.
  float doppler = 1.0 / (gamma * (1.0 + dot(tangent * beta, dir)));

  // Light climbing out of the well loses energy on top of the Doppler shift.
  float gravity = sqrt(max(1.0 - 1.0 / r, 0.0));
  float shift = doppler * gravity;

  // ---- Structure ---------------------------------------------------------
  // Keplerian shear: the pattern is advected by omega(r), so the inner bands
  // visibly outrun the outer ones and the filaments wind into spirals on their
  // own. Nothing draws a spiral; the shear is the spiral.
  float phase = atan(hit.z, hit.x) - omega * DISK_SPIN_SCALE * uTime;
  vec2 unit = vec2(cos(phase), sin(phase));

#if DISK_FBM_OCTAVES >= 3
  // Domain warp, applied as a first-order rotation of the unit vector. For the
  // small angles involved this is a rotation to within a few percent of
  // length, and that residual only dithers the local frequency — which is
  // exactly the effect wanted — for two multiply-adds instead of a sin/cos.
  float warp = (valueNoise(vec3(unit * 0.55, r * 0.9 + 7.0)) - 0.5) * uDiskTurbulence * 0.55;
  unit += vec2(-unit.y, unit.x) * warp;
#endif

  float noise = diskFbm(unit, r, 0.0);

  // Turbulence is a CONTRAST control, not an amplitude: it stretches the noise
  // about its midpoint, so low tiers get gentle banding and high tiers get
  // hard-clipped bright filaments separated by near-empty lanes.
  float contrast = 0.9 + 2.2 * clamp(uDiskTurbulence, 0.0, 1.5);
  float density = clamp(0.5 + (noise - 0.5) * contrast, 0.02, 1.6);

  // Soft edges. Without the inner feather the disk terminates on a hard circle
  // that the lensing then wraps into an obviously artificial hard arc.
  density *= smoothstep(0.0, DISK_INNER_FEATHER, r - DISK_INNER_RADIUS);
  density *= 1.0 - smoothstep(uDiskOuterRadius - DISK_OUTER_FEATHER, uDiskOuterRadius, r);
  if (density <= 0.0) return;

  // ---- Optical depth -----------------------------------------------------
  // The disk is a slab of half-thickness H(r), not a plane. The path length
  // through it is 2H / |dir.y|, which is what gives the disk real thickness
  // from a zero-height crossing test: a grazing ray accumulates many times the
  // optical depth of a steep one, so the disk turns opaque edge-on and
  // translucent from above. That anisotropy is most of why the near limb reads
  // as solid while the far side glows through it.
  float halfThickness = DISK_H_OUTER
    + (DISK_H_INNER - DISK_H_OUTER) * exp(-(r - DISK_INNER_RADIUS) * DISK_H_DECAY);
  float pathLength = 2.0 * halfThickness / max(abs(dir.y), DISK_GRAZE_FLOOR);
  float tau = density * DISK_OPACITY * pathLength;
  float alpha = 1.0 - exp(-tau);

  // ---- Source function ---------------------------------------------------
  // Physical temperature profile, shifted into the observer's frame, then read
  // through the tier ramp. T is normalised to 1 at the inner edge.
  float temperature = pow(DISK_INNER_RADIUS / r, 0.75);
  vec3 color = diskRamp(temperature * shift);

  // delta^3 beaming. (delta^4 is the bolometric value for an isotropic
  // blackbody; delta^3 is the photon-number convention and is what the brief
  // specifies. The difference is a further ~2x on the approaching limb, which
  // at these betas clips rather than adds.) Even at delta^3 the inner edge
  // runs ~100:1 between its approaching and receding limbs.
  float beaming = doppler * doppler * doppler;

  float emissivity = pow(DISK_INNER_RADIUS / r, DISK_EMISSIVITY_FALLOFF);

  // A mild density coupling on top of the optical-depth coupling. Optical
  // depth alone saturates: once a filament is opaque it stops getting
  // brighter, so the streaks would only be visible where something shows
  // through behind them. Denser gas being hotter gas is the physical excuse
  // and it puts the texture back into the bright inner region.
  vec3 source = color * (uDiskBrightness * emissivity * beaming * gravity * (0.55 + 0.45 * density));

  radiance += transmittance * alpha * source;
  transmittance *= 1.0 - alpha;
}

// ---------------------------------------------------------------------------
// Jets.
// ---------------------------------------------------------------------------

/**
 * Emission per unit path length inside the bipolar jet cone.
 *
 * Returns black outside the cone, which is the common case — the caller
 * rejects most steps with a bounding-cylinder test before getting here.
 */
vec3 jetEmission(vec3 p) {
  float height = abs(p.y);
  if (height < JET_BASE || height > JET_REACH) return vec3(0.0);

  float coneRadius = JET_RADIUS0 + JET_OPENING * (height - JET_BASE);
  float rho2 = dot(p.xz, p.xz);
  if (rho2 > coneRadius * coneRadius) return vec3(0.0);

  // 1 on the axis, 0 at the cone wall. Squared, so the jet has a hot spine
  // with a soft sheath rather than a uniform-brightness tube.
  float axial = 1.0 - sqrt(rho2) / coneRadius;
  axial *= axial;

  // Helical structure: the twist term winds the pattern with height, the spin
  // term rotates the whole helix. Same seamless (cos, sin) trick as the disk.
  //
  // atan(0, 0) is undefined in GLSL and returns NaN on some drivers, and the
  // jet's own axis is exactly that point — the one place in this scene where
  // both arguments can vanish. A NaN there would propagate through the noise
  // and paint a garbage pixel straight up the middle of the frame. On the axis
  // the helix phase is degenerate anyway, so any constant will do.
  vec2 around = rho2 > 0.0 ? vec2(p.z, p.x) : vec2(0.0, 1.0);
  float helix = atan(around.x, around.y) - height * JET_TWIST + uTime * JET_SPIN;
  vec2 unit = vec2(cos(helix), sin(helix));

  // Knots travel OUTWARD, so the pattern coordinate moves with -t along the
  // axis. Both jets use |y|, so both propagate away from the hole.
  float travel = height - uTime * JET_KNOT_SPEED;

  float noise = valueNoise(vec3(unit * 1.4, travel * 1.05));
  noise += 0.5 * valueNoise(vec3(unit * 2.9, travel * 2.4 + 11.0));
  noise /= 1.5;

  // Discrete knots riding the noise, the way a real jet shows internal shocks.
  float knots = 0.55 + 0.45 * sin(travel * 1.9 + noise * 5.0);

  float falloff = exp(-(height - JET_BASE) * JET_DECAY);
  float density = axial * falloff * (0.35 + 0.9 * noise) * knots;

  return mix(JET_COOL, JET_HOT, axial * axial) * density;
}

// ---------------------------------------------------------------------------
// The march.
// ---------------------------------------------------------------------------

TraceResult traceBlackHole(vec3 origin, vec3 rayDir) {
  vec3 pos = origin;
  vec3 vel = rayDir;

  // Specific angular momentum. Conserved exactly by the update below, so it is
  // computed once. |h| is also the impact parameter, since |vel| starts at 1.
  vec3 angularMomentum = cross(pos, vel);
  float h2 = dot(angularMomentum, angularMomentum);

  vec3 radiance = vec3(0.0);
  float transmittance = 1.0;

  float escape2 = uEscapeRadius * uEscapeRadius;
  bool captured = false;
  bool escaped = false;
  bool jets = uJetStrength > 0.0;

  for (int i = 0; i < MARCH_STEPS; i++) {
    if (i >= uQualitySteps) break;

    float r2 = dot(pos, pos);
    if (r2 < 1.0) { captured = true; break; }
    if (r2 > escape2) { escaped = true; break; }

    float r = sqrt(r2);
    float invR2 = 1.0 / r2;

    // |accel| = 1.5 h^2 / r^4, and its direction is -pos/r. Splitting the
    // magnitude out costs nothing and hands the step criterion the number it
    // needs without a second length().
    float accelMagnitude = 1.5 * h2 * invR2 * invR2;
    vec3 accel = -(accelMagnitude / r) * pos;

    float dt = min(uStepScale * r, uTurnLimit / max(accelMagnitude, 1.0e-6));

    // Inside the jet the ray is integrating a volume, not just a trajectory, so
    // the step has to stay short enough to sample it. Gated on jets being
    // unlocked: at tiers 0-8 this costs one compare.
    //
    // The bound is the CONE, not a cylinder around it, and it starts at
    // JET_BASE. Both matter, and a fat cylinder through the origin is a
    // 5.7x regression rather than a small one: it swallows the entire region
    // around the hole, so every ray with a small impact parameter — which is
    // most of the interesting screen — gets its step capped for its whole
    // approach, for a volume that contains no jet at all.
    //
    // The margin is 'uStepScale * height', which is the largest step the
    // geometric criterion can take at that height. That makes entry detection
    // exact rather than hopeful: a ray one step away from the cone is already
    // inside the bound, so it cannot jump the cone in a single step.
    float jetHeight = abs(pos.y);
    bool inJetBounds = false;
    if (jets && jetHeight > JET_BASE && jetHeight < JET_REACH) {
      float bound =
        JET_RADIUS0 + JET_OPENING * (jetHeight - JET_BASE) + uStepScale * jetHeight;
      inJetBounds = dot(pos.xz, pos.xz) < bound * bound;
    }
    if (inJetBounds) dt = min(dt, JET_STEP_CAP);

    dt = clamp(dt, MARCH_MIN_STEP, MARCH_MAX_STEP);

    vec3 previous = pos;
    vel += accel * dt;
    pos += vel * dt;

    // Equatorial crossing by sign change in y, interpolated to the exact
    // plane. This does NOT stop at the first hit: a strongly lensed ray dives
    // through the disk, wraps behind the hole and comes back through it, and
    // every one of those crossings is accumulated. That is the whole mechanism
    // behind the far side of the disk appearing both above and below the
    // shadow — there is no second disk and no mirrored geometry, just a ray
    // that hit the same annulus more than once.
    if (previous.y * pos.y < 0.0) {
      float f = previous.y / (previous.y - pos.y);
      accumulateDisk(previous + (pos - previous) * f, normalize(vel), radiance, transmittance);
      if (transmittance < TRANSMITTANCE_EPSILON) break;
    }

    if (inJetBounds) {
      // Midpoint of the segment, and scaled by dt so the integral is
      // independent of the step size — which varies by three orders of
      // magnitude along a single ray. jetEmission re-tests against the exact
      // cone, so the margin above changes the stepping and never the picture.
      vec3 emission = jetEmission(previous + (pos - previous) * 0.5);
      radiance += transmittance * emission * (uJetStrength * JET_GAIN * dt);
    }
  }

  // Every early exit below leaves the sky out, so emissive and radiance start
  // equal and only the escaping branch separates them.
  TraceResult result;
  result.emissive = radiance;
  result.radiance = radiance;

  if (captured) return result;

  // Running out of steps means the ray is trapped near the photon sphere in
  // all but pathological cases, so step exhaustion reads as capture. The
  // outbound test is the escape hatch: a ray that is far out and still moving
  // away is background however it got there, and without it a raised camera
  // radius would punch a black disc in the sky.
  if (!escaped && !(dot(pos, pos) > 64.0 && dot(pos, vel) > 0.0)) return result;

  // Gravitational lensing conserves surface brightness, so the escaped
  // direction is sampled with no extra factor: the sky is simply bent.
  //
  // This is the ONLY line that adds background to the pixel, which is exactly
  // why the bloom mask can be trusted: whatever the sky contributes never
  // touches result.emissive.
  result.radiance = radiance + transmittance * sampleSky(normalize(vel));
  return result;
}
`;
