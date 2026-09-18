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
import { SCENE_FRAG, SCENE_VERT } from "./shaders/scene.glsl";

interface SceneUniforms {
  readonly uCameraPosition: IUniform<Vector3>;
  readonly uCameraBasis: IUniform<Matrix3>;
  readonly uTanHalfFov: IUniform<number>;
  readonly uResolution: IUniform<Vector2>;
  readonly uPixelAngle: IUniform<number>;
  readonly uExposure: IUniform<number>;
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

  constructor(skyFbmOctaves: number) {
    this.geometry = new BufferGeometry();
    // Clip-space coordinates directly. Vertices at 3 rather than 1 make one
    // triangle that covers the whole viewport after clipping; the attribute is
    // named `position` because that is where three.js reads the draw count.
    this.geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );

    this.uniforms = {
      uCameraPosition: { value: new Vector3() },
      uCameraBasis: { value: new Matrix3() },
      uTanHalfFov: { value: 0.466 },
      uResolution: { value: new Vector2(1, 1) },
      uPixelAngle: { value: 0.001 },
      uExposure: { value: 1 },
    };

    this.material = new RawShaderMaterial({
      name: "SingularityScene",
      glslVersion: GLSL3,
      vertexShader: SCENE_VERT,
      fragmentShader: SCENE_FRAG,
      uniforms: this.uniforms,
      defines: { SKY_FBM_OCTAVES: String(skyFbmOctaves) },
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
   * Swap the compile-time quality defines.
   *
   * This forces three.js to rebuild the program, which costs a frame. It is
   * driven by the quality governor, which only ever steps down and therefore
   * fires at most twice in a session.
   */
  setSkyFbmOctaves(octaves: number): void {
    const value = String(octaves);
    const defines = this.material.defines as Record<string, string>;
    if (defines.SKY_FBM_OCTAVES === value) return;
    defines.SKY_FBM_OCTAVES = value;
    this.material.needsUpdate = true;
  }

  setCamera(camera: OrbitCamera): void {
    this.uniforms.uCameraPosition.value.copy(camera.position);
    this.uniforms.uCameraBasis.value.copy(camera.basis);
    this.uniforms.uTanHalfFov.value = camera.tanHalfFov;
    this.refreshPixelAngle();
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
