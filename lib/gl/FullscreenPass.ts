/**
 * The one and only draw call.
 *
 * A three-vertex triangle that overhangs the viewport, a `RawShaderMaterial`,
 * and a `Scene` containing nothing else. Everything visible is produced by the
 * fragment shader from a per-pixel ray.
 *
 * `RawShaderMaterial` rather than `ShaderMaterial` is a deliberate choice.
 * three.js injects a prelude of matrices, attributes, and colour-management
 * chunks into a `ShaderMaterial`, and none of it applies here: there are no
 * model, view, or projection matrices in a raymarcher, and the tone mapping
 * and sRGB chunks are written for GLSL 1 and do not compile under GLSL 3
 * (three declares neither `pc_fragColor` nor `gl_FragColor` in that path). The
 * pass therefore performs the ACES and sRGB transforms itself, matching the
 * renderer's configured values exactly — see TONEMAP_GLSL.
 *
 * COMPILE-TIME vs RUNTIME. Three quality knobs are `#define`s (`SKY_FBM_OCTAVES`,
 * `DISK_FBM_OCTAVES`, `MARCH_STEPS`) because each is a loop bound, and a
 * constant bound is what lets a driver unroll and allocate registers sanely.
 * Changing one costs a program rebuild, which is why the governor only ever
 * steps down: at most two rebuilds in a session. Everything else — including
 * the march budget `uQualitySteps`, which rides under the `MARCH_STEPS`
 * ceiling — is a uniform and is free to change every frame.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  GLSL3,
  Matrix3,
  Mesh,
  RawShaderMaterial,
  Scene,
  Vector2,
  Vector3,
  type IUniform,
  type WebGLRenderer,
} from "three";

import type { OrbitCamera } from "./OrbitCamera";
import type { QualityProfile } from "./quality";
import type { VisualUniformValues } from "./VisualState";
import { SCENE_FRAG, SCENE_VERT } from "./shaders/scene.glsl";

/**
 * Smallest escape radius the marcher may use, in Schwarzschild radii.
 *
 * The brief's terminate-on-escape test is `length(pos) > 40`. It is expressed
 * as a floor rather than a constant because the camera radius becomes
 * holder-driven in a later prompt: if the camera ever sat beyond the escape
 * radius, every ray would "escape" on its first step and the hole would vanish.
 */
const MIN_ESCAPE_RADIUS = 40;

interface SceneUniforms {
  readonly uCameraPosition: IUniform<Vector3>;
  readonly uCameraBasis: IUniform<Matrix3>;
  readonly uTanHalfFov: IUniform<number>;
  readonly uResolution: IUniform<Vector2>;
  readonly uPixelAngle: IUniform<number>;
  readonly uExposure: IUniform<number>;
  readonly uTime: IUniform<number>;
  readonly uDiskOuterRadius: IUniform<number>;
  readonly uDiskBrightness: IUniform<number>;
  readonly uDiskTurbulence: IUniform<number>;
  readonly uDiskColorInner: IUniform<Vector3>;
  readonly uDiskColorOuter: IUniform<Vector3>;
  readonly uJetStrength: IUniform<number>;
  readonly uQualitySteps: IUniform<number>;
  readonly uStepScale: IUniform<number>;
  readonly uTurnLimit: IUniform<number>;
  readonly uEscapeRadius: IUniform<number>;
  [key: string]: IUniform;
}

export class FullscreenPass {
  private readonly uniforms: SceneUniforms;
  private readonly geometry: BufferGeometry;
  private readonly material: RawShaderMaterial;
  private readonly scene: Scene;
  /**
   * three.js requires a camera argument, and immediately ignores it: the
   * vertices are already in clip space and a raw material receives no
   * projection uniforms. The base class is all that is needed.
   */
  private readonly camera = new Camera();

  private bufferHeight = 1;
  /** The active `MARCH_STEPS` define; `uQualitySteps` is clamped to it. */
  private marchStepCeiling: number;

  constructor(profile: QualityProfile) {
    this.geometry = new BufferGeometry();
    // Clip-space coordinates directly. Vertices at 3 rather than 1 make one
    // triangle that covers the whole viewport after clipping; the attribute is
    // named `position` because that is where three.js reads the draw count.
    this.geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );

    this.marchStepCeiling = profile.marchSteps;

    this.uniforms = {
      uCameraPosition: { value: new Vector3() },
      uCameraBasis: { value: new Matrix3() },
      uTanHalfFov: { value: 0.466 },
      uResolution: { value: new Vector2(1, 1) },
      uPixelAngle: { value: 0.001 },
      uExposure: { value: 1 },
      uTime: { value: 0 },
      uDiskOuterRadius: { value: 4 },
      uDiskBrightness: { value: 1 },
      uDiskTurbulence: { value: 0.2 },
      uDiskColorInner: { value: new Vector3(1, 0.79, 0.54) },
      uDiskColorOuter: { value: new Vector3(0.64, 0.24, 0.04) },
      uJetStrength: { value: 0 },
      uQualitySteps: { value: profile.marchSteps },
      uStepScale: { value: profile.marchStepScale },
      uTurnLimit: { value: profile.marchTurnLimit },
      uEscapeRadius: { value: MIN_ESCAPE_RADIUS },
    };

    this.material = new RawShaderMaterial({
      name: "SingularityScene",
      glslVersion: GLSL3,
      vertexShader: SCENE_VERT,
      fragmentShader: SCENE_FRAG,
      uniforms: this.uniforms,
      defines: definesFor(profile),
      // Nothing occludes anything: there is one primitive and it covers every
      // pixel. The context is created without a depth buffer to match.
      depthTest: false,
      depthWrite: false,
    });

    const mesh = new Mesh(this.geometry, this.material);
    // The triangle is in clip space already, so a bounding sphere computed
    // from it would be meaningless and culling it would be wrong.
    mesh.frustumCulled = false;

    this.scene = new Scene();
    this.scene.add(mesh);
  }

  /**
   * Apply a quality profile: swap the compile-time defines and the march
   * uniforms together.
   *
   * The define change forces three.js to rebuild the program, which costs a
   * frame. It is driven by the quality governor, which only ever steps down
   * and therefore fires at most twice in a session.
   */
  setQuality(profile: QualityProfile): void {
    const defines = this.material.defines as Record<string, string>;
    const next = definesFor(profile);

    let changed = false;
    for (const key of Object.keys(next)) {
      if (defines[key] !== next[key]) {
        defines[key] = next[key];
        changed = true;
      }
    }
    if (changed) this.material.needsUpdate = true;

    this.marchStepCeiling = profile.marchSteps;
    this.uniforms.uQualitySteps.value = profile.marchSteps;
    this.uniforms.uStepScale.value = profile.marchStepScale;
    this.uniforms.uTurnLimit.value = profile.marchTurnLimit;
  }

  /**
   * Override the march budget without a recompile.
   *
   * Clamped to the compiled ceiling: asking for more steps than `MARCH_STEPS`
   * would silently do nothing, because the loop bound is the define.
   */
  setQualitySteps(steps: number): void {
    const value = Math.round(steps);
    this.uniforms.uQualitySteps.value = Math.min(Math.max(value, 1), this.marchStepCeiling);
  }

  setCamera(camera: OrbitCamera): void {
    this.uniforms.uCameraPosition.value.copy(camera.position);
    this.uniforms.uCameraBasis.value.copy(camera.basis);
    this.uniforms.uTanHalfFov.value = camera.tanHalfFov;
    // Keep the camera strictly inside the escape radius. Without this a ray
    // cast from beyond it terminates on its first step and the scene is empty.
    this.uniforms.uEscapeRadius.value = Math.max(
      MIN_ESCAPE_RADIUS,
      camera.position.length() * 1.5,
    );
    this.refreshPixelAngle();
  }

  /** Scene time in seconds. The host wraps it — see Renderer.SHADER_TIME_WRAP. */
  setTime(seconds: number): void {
    this.uniforms.uTime.value = seconds;
  }

  /** Push one frame of smoothed tier values. */
  setVisuals(values: VisualUniformValues): void {
    this.uniforms.uDiskOuterRadius.value = values.diskOuterRadius;
    this.uniforms.uDiskBrightness.value = values.diskBrightness;
    this.uniforms.uDiskTurbulence.value = values.diskTurbulence;
    this.uniforms.uDiskColorInner.value.set(...values.diskColorInner);
    this.uniforms.uDiskColorOuter.value.set(...values.diskColorOuter);
    this.uniforms.uJetStrength.value = values.jetStrength;
  }

  /** Drawing-buffer size, in device pixels. */
  setSize(width: number, height: number): void {
    this.uniforms.uResolution.value.set(width, height);
    this.bufferHeight = Math.max(1, height);
    this.refreshPixelAngle();
  }

  setExposure(exposure: number): void {
    this.uniforms.uExposure.value = exposure;
  }

  render(renderer: WebGLRenderer): void {
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  /**
   * Angular size of one drawing-buffer pixel, in radians.
   *
   * The star field sizes its point spread function in PIXELS, not in radians,
   * so stars stay the same apparent size at every resolution and pixel ratio —
   * and, critically, never shrink below a pixel, which is what makes cheap
   * star fields twinkle.
   */
  private refreshPixelAngle(): void {
    this.uniforms.uPixelAngle.value = (2 * this.uniforms.uTanHalfFov.value) / this.bufferHeight;
  }
}

function definesFor(profile: QualityProfile): Record<string, string> {
  return {
    SKY_FBM_OCTAVES: String(profile.skyFbmOctaves),
    DISK_FBM_OCTAVES: String(profile.diskFbmOctaves),
    MARCH_STEPS: String(profile.marchSteps),
  };
}
