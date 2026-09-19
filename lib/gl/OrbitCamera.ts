/**
 * The camera.
 *
 * There is no `THREE.PerspectiveCamera` anywhere in this project. Nothing is
 * rasterised through a projection matrix — the image is raymarched — so the
 * camera's entire job is to produce three numbers the fragment shader needs:
 * a world-space ray origin, an orthonormal basis to build ray directions in,
 * and a field of view.
 *
 * THE RADIUS IS HOLDER-DRIVEN and arrives from outside. `SceneDirector` owns
 * the asymmetric spring, the all-time-peak floor and the clearance clamp that
 * keeps the camera out of its own accretion disk; this class receives the
 * finished number through `setRadius` and does nothing to it. The constructor
 * value is only the framing used before the first payload lands.
 *
 * THE SHAKE is likewise handed in, eased, from the tier table. It is applied
 * as a translation of the ray ORIGIN after the basis has been built, so the
 * camera keeps looking exactly at the origin while it trembles. Rotating the
 * basis instead would swing the star field across the frame, which at these
 * amplitudes reads as the whole universe wobbling rather than as the camera
 * being shaken — and the star field is the one thing in this scene that must
 * stay nailed down.
 *
 * THE INCLINATION IS NOT ARBITRARY, AND IT IS NEVER ZERO. The camera is pinned
 * a few degrees above the disk's equatorial plane, because that framing is the
 * entire Gargantua look. Seen from near the plane, the far side of the disk is
 * lensed both OVER and UNDER the shadow, giving the vertical wrap in the
 * references; seen from 40 degrees up, the same disk reads as an ordinary
 * tilted ring with a dark hole in it and the lensing stops being legible.
 * Doppler beaming needs it too — the approaching limb is only dramatically
 * brighter when the orbital velocity points along the line of sight, which it
 * does near the plane and does not from above.
 *
 * Exactly zero is a DEGENERATE case, not merely an unflattering one, and it is
 * why the sweep has a bias rather than swinging through the plane. The shader
 * finds the disk by looking for a sign change in `pos.y` between march steps.
 * A camera at y = 0 casts equatorial rays whose y stays identically 0 along the
 * whole geodesic, so those rays never register a crossing and the near side of
 * the disk — the band that should cut across the front of the shadow — silently
 * vanishes. The bias keeps every ray off that measure-zero set.
 */

import { Matrix3, Vector3 } from "three";

const WORLD_UP = new Vector3(0, 1, 0);
/** Fallback axis for the degenerate case of looking straight up or down. */
const FALLBACK_UP = new Vector3(0, 0, 1);
const DEG2RAD = Math.PI / 180;

export interface OrbitCameraOptions {
  /** Distance from the origin, in world units. */
  readonly radius?: number;
  /** Vertical field of view, in degrees. Settable at runtime via `setFov`. */
  readonly fovDegrees?: number;
  /** Azimuth rate in rad/s. One revolution takes 2*PI / this. */
  readonly azimuthRate?: number;
/**
   * Elevation the sweep is centred on, in radians above the disk plane.
   *
   * Must stay clear of zero — see the class comment. Combined with the
   * amplitude below, the default keeps the camera between about 6 and 12
   * degrees above the plane.
   */
  readonly elevationBias?: number;
  /**
   * Peak elevation EXCURSION about the bias, in radians.
   *
   * Small on purpose: the whole range has to stay inside the band where the
   * over-and-under lensing and the Doppler asymmetry read. Kept under PI/2 so
   * the basis never degenerates.
   */
  readonly elevationAmplitude?: number;
  /** Angular frequency of the elevation sweep, in rad/s. */
  readonly elevationRate?: number;
  /**
   * Peak roll in radians. Small, and there for one reason: if the sky had any
   * dependence on the camera's up vector, rolling would smear it.
   */
  readonly rollAmplitude?: number;
  readonly rollRate?: number;
}

export class OrbitCamera {
  /** World-space ray origin. */
  readonly position = new Vector3();
  /** Column-major, columns (right, up, forward). Orthonormal. */
  readonly basis = new Matrix3();
  /** tan(verticalFov / 2). Mutable: see `setFov`. */
  tanHalfFov: number;

  private radius: number;
  private shakeAmplitude = 0;
  private shakeFrequency = 0;
  private readonly azimuthRate: number;
  private readonly elevationBias: number;
  private readonly elevationAmplitude: number;
  private readonly elevationRate: number;
  private readonly rollAmplitude: number;
  private readonly rollRate: number;

  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();

  constructor(options: OrbitCameraOptions = {}) {
    // 17 rs. Two constraints fix this, and the first is hard: the camera must
    // sit OUTSIDE the disk at every tier, and tier 11 puts the outer edge at
    // 11.5 rs. Inside it, the marcher is perfectly correct and the picture is
    // useless — the disk wraps around the viewer and reads as a tunnel.
    // The second is framing: at a 50-degree fov this puts the ~2.6 rs shadow
    // at about a third of the frame height and runs the tier-11 disk off both
    // sides, which is the reference composition. Holder-driven from the first
    // payload onward; this is only what shows until one arrives.
    this.radius = options.radius ?? 17;
    this.tanHalfFov = Math.tan(((options.fovDegrees ?? 50) * DEG2RAD) / 2);
    // ~180s per revolution. Slow enough that any crawl or twinkle in the star
    // field would be obvious rather than lost in the motion.
    this.azimuthRate = options.azimuthRate ?? 0.035;
    // ~9 degrees, drifting +-2.6. See the class comment: this is the framing,
    // not a default, and the bias must never let the sweep reach zero.
    this.elevationBias = options.elevationBias ?? 0.16;
    this.elevationAmplitude = Math.min(options.elevationAmplitude ?? 0.045, 1.45);
    this.elevationRate = options.elevationRate ?? 0.047;
    this.rollAmplitude = options.rollAmplitude ?? 0.12;
    this.rollRate = options.rollRate ?? 0.019;

    this.update(0);
  }

  /**
   * Set the orbit radius in Schwarzschild radii.
   *
   * No smoothing here, and none wanted: the value arriving from
   * `SceneDirector` is the output of a critically damped spring that has
   * already been integrated on this frame's delta. Filtering it again would
   * add a second lag the asymmetric time constants were chosen without.
   *
   * The floor is the disk's own inner edge with room to spare. It is a
   * last-ditch guard against a caller passing something absurd, not the real
   * clearance rule — that one lives in the director, where the disk's current
   * outer radius is known.
   */
  setRadius(radius: number): void {
    if (!Number.isFinite(radius)) return;
    this.radius = Math.max(radius, 3);
  }

  /**
   * Set the eased camera shake, per the tier table.
   *
   * `frequency` doubles as the character of the shake, exactly as the tier
   * table's comment describes: below 1 Hz an envelope gates it into
   * occasional tremors, at and above 1 Hz it runs continuously. Tiers 3-6 sit
   * in the gated band and tiers 7-11 in the continuous one, so the shake does
   * not merely get stronger with the tier — it changes from something that
   * happens to something that is always happening.
   */
  setShake(amplitude: number, frequency: number): void {
    this.shakeAmplitude = Number.isFinite(amplitude) ? Math.max(0, amplitude) : 0;
    this.shakeFrequency = Number.isFinite(frequency) ? Math.max(0, frequency) : 0;
  }

  /**
   * Change the vertical field of view at runtime, in degrees.
   *
   * Clamped well away from both ends: at a few degrees the ray directions
   * across a pixel become so nearly parallel that the photon ring aliases into
   * single-pixel noise, and past ~150 the projection stretches the corners
   * past any useful framing.
   */
  setFov(degrees: number): void {
    if (!Number.isFinite(degrees)) return;
    const clamped = Math.min(Math.max(degrees, 10), 150);
    this.tanHalfFov = Math.tan((clamped * DEG2RAD) / 2);
  }

  /** Recompute for a wall-clock time in seconds. */
  update(seconds: number): void {
    const azimuth = seconds * this.azimuthRate;
    const elevation =
      this.elevationBias + Math.sin(seconds * this.elevationRate) * this.elevationAmplitude;
    const roll = Math.sin(seconds * this.rollRate) * this.rollAmplitude;

    const cosElevation = Math.cos(elevation);
    this.position.set(
      this.radius * cosElevation * Math.sin(azimuth),
      this.radius * Math.sin(elevation),
      this.radius * cosElevation * Math.cos(azimuth),
    );

    // Always looking at the origin, which is where the black hole goes.
    this.forward.copy(this.position).normalize().negate();

    this.right.crossVectors(this.forward, WORLD_UP);
    if (this.right.lengthSq() < 1e-8) this.right.crossVectors(this.forward, FALLBACK_UP);
    this.right.normalize();

    // forward and right are unit and perpendicular, so this is already unit.
    this.up.crossVectors(this.right, this.forward);

    if (roll !== 0) {
      const c = Math.cos(roll);
      const s = Math.sin(roll);
      const rx = this.right.x * c + this.up.x * s;
      const ry = this.right.y * c + this.up.y * s;
      const rz = this.right.z * c + this.up.z * s;
      this.up.set(
        this.up.x * c - this.right.x * s,
        this.up.y * c - this.right.y * s,
        this.up.z * c - this.right.z * s,
      );
      this.right.set(rx, ry, rz);
    }

    this.applyShake(seconds);

    // Matrix3.elements is column-major, and a GLSL mat3 is too, so these go
    // straight across: uCameraBasis * vec3(x, y, 1) is right*x + up*y + forward.
    const e = this.basis.elements;
    e[0] = this.right.x;
    e[1] = this.right.y;
    e[2] = this.right.z;
    e[3] = this.up.x;
    e[4] = this.up.y;
    e[5] = this.up.z;
    e[6] = this.forward.x;
    e[7] = this.forward.y;
    e[8] = this.forward.z;
  }

  /**
   * Translate the ray origin by the eased shake, in the camera's own plane.
   *
   * Two incommensurate carriers per axis rather than one, because a single
   * sine is a pendulum and reads as a camera on a spring rather than a camera
   * being rattled. The ratios (2.37, 1.63, 3.11) are irrational enough that
   * the pattern does not repeat inside any shot.
   *
   * At tier 11 the amplitude is 0.016 rs against an orbit radius of ~15, which
   * is about a milliradian — roughly one pixel of a 1080-tall frame at a
   * 50-degree fov. That is the intended order of magnitude. This effect is
   * meant to be felt at the edge of perception; anything a viewer can point at
   * and name is a camera operator's mistake, not a supermassive object.
   */
  private applyShake(seconds: number): void {
    if (this.shakeAmplitude <= 0 || this.shakeFrequency <= 0) return;

    // Below 1 Hz the frequency is an ENVELOPE rate, not a carrier rate: the
    // quartic on a half-rectified sine leaves the shake silent for most of
    // each cycle and gives a brief tremor at the crest.
    const envelope =
      this.shakeFrequency < 1
        ? Math.max(0, Math.sin(seconds * this.shakeFrequency * Math.PI * 2)) ** 4
        : 1;
    if (envelope <= 0) return;

    const carrier = Math.max(this.shakeFrequency, 1) * Math.PI * 2 * seconds;
    const offsetX =
      Math.sin(carrier) * 0.6 + Math.sin(carrier * 2.37 + 1.7) * 0.4;
    const offsetY =
      Math.sin(carrier * 1.63 + 0.9) * 0.6 + Math.sin(carrier * 3.11 + 2.4) * 0.4;

    const scale = this.shakeAmplitude * envelope;
    this.position.addScaledVector(this.right, offsetX * scale);
    this.position.addScaledVector(this.up, offsetY * scale);
  }
}
