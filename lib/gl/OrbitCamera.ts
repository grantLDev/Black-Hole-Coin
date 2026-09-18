/**
 * The camera.
 *
 * There is no `THREE.PerspectiveCamera` anywhere in this project. Nothing is
 * rasterised through a projection matrix — the image is raymarched — so the
 * camera's entire job is to produce three numbers the fragment shader needs:
 * a world-space ray origin, an orthonormal basis to build ray directions in,
 * and a field of view.
 *
 * The orbit here is temporary scaffolding in the sense that its RADIUS becomes
 * holder-driven later (grows fast, eases back slowly, never below the all-time
 * peak). The basis maths does not change; only where `radius` comes from does.
 */

import { Matrix3, Vector3 } from "three";

const WORLD_UP = new Vector3(0, 1, 0);
/** Fallback axis for the degenerate case of looking straight up or down. */
const FALLBACK_UP = new Vector3(0, 0, 1);
const DEG2RAD = Math.PI / 180;

export interface OrbitCameraOptions {
  /** Distance from the origin, in world units. */
  readonly radius?: number;
  /** Vertical field of view, in degrees. */
  readonly fovDegrees?: number;
  /** Azimuth rate in rad/s. One revolution takes 2*PI / this. */
  readonly azimuthRate?: number;
  /**
   * Peak elevation in radians. Sweeping past ~1.2 rad is what actually proves
   * the sky has no pole: a lat/long star field pinches visibly up there, and a
   * cube-mapped one shows its face centre. Kept under PI/2 so the basis never
   * degenerates.
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
  readonly tanHalfFov: number;

  private readonly radius: number;
  private readonly azimuthRate: number;
  private readonly elevationAmplitude: number;
  private readonly elevationRate: number;
  private readonly rollAmplitude: number;
  private readonly rollRate: number;

  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();

  constructor(options: OrbitCameraOptions = {}) {
    this.radius = options.radius ?? 12;
    this.tanHalfFov = Math.tan(((options.fovDegrees ?? 50) * DEG2RAD) / 2);
    // ~180s per revolution. Slow enough that any crawl or twinkle in the star
    // field would be obvious rather than lost in the motion.
    this.azimuthRate = options.azimuthRate ?? 0.035;
    this.elevationAmplitude = Math.min(options.elevationAmplitude ?? 1.25, 1.45);
    this.elevationRate = options.elevationRate ?? 0.047;
    this.rollAmplitude = options.rollAmplitude ?? 0.12;
    this.rollRate = options.rollRate ?? 0.019;

    this.update(0);
  }

  /** Recompute for a wall-clock time in seconds. */
  update(seconds: number): void {
    const azimuth = seconds * this.azimuthRate;
    const elevation = Math.sin(seconds * this.elevationRate) * this.elevationAmplitude;
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
}
