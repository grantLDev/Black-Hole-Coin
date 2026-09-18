/**
 * The post chain's render graph.
 *
 * Owns every surface and every material between the raymarch and the screen:
 * the full-resolution HDR scene target, the bloom pyramid, and the composite.
 * The GLSL is in `shaders/post.glsl.ts`; this file is the plumbing.
 *
 * ONE FLAG TURNS IT ALL OFF. `QualityProfile.post` is false on the low tier, so
 * a device that cannot hold its frame budget loses the entire chain — surfaces,
 * materials and all — rather than running a cheaper version of it. The scene
 * shader then renders straight to the default framebuffer with its own inline
 * tone map (`SCENE_TO_HDR_TARGET 0`), which is the path this project shipped
 * before any of this existed. Nothing here is conditionally half-alive; the
 * chain is either constructed or it is not, and `Renderer` holds `null` when it
 * is not. That matters because "disabled" post that still allocates a
 * full-screen half-float target has already spent most of what turning it off
 * was meant to save.
 *
 * WHAT RUNS, IN ORDER
 *
 *   1. prefilter   scene           -> level 0   (half res, threshold + 2x2 box)
 *   2. downsample  level i         -> level i+1 (dual Kawase, 5 taps)
 *   3. upsample    level i         -> level i-1 (dual Kawase, 8 taps, ADDITIVE)
 *   4. composite   scene + level 0 -> screen    (aberration, vignette, tone
 *                                                map, grain, dither)
 *
 * Step 3 blends additively into the surface the DOWNSAMPLE already wrote, which
 * is why the pyramid needs one set of targets rather than two. Source and
 * destination are always different surfaces, so there is no feedback, and no
 * target is ever read before something has fully written it.
 *
 * WHY HALF FLOAT. The scene is linear HDR: the beamed inner limb of the disk
 * runs two orders of magnitude above the outer disk, and the bloom threshold is
 * a value in that space. An 8-bit intermediate would clip every one of those
 * highlights to 1.0 before the threshold ever saw them, which would leave the
 * bloom keyed off a flat white blob. If half float is not renderable — the
 * extension is near-universal on WebGL2, but not guaranteed — the chain refuses
 * to construct and the renderer falls back to the direct path.
 */

import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  CustomBlending,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NoBlending,
  OneFactor,
  RGBAFormat,
  RawShaderMaterial,
  Scene,
  UnsignedByteType,
  Vector2,
  WebGLRenderTarget,
  type IUniform,
  type Texture,
  type WebGLRenderer,
} from "three";

import type { QualityProfile } from "./quality";
import type { PostUniformValues } from "./VisualState";
import {
  BLOOM_DOWNSAMPLE_FRAG,
  BLOOM_PREFILTER_FRAG,
  BLOOM_UPSAMPLE_FRAG,
  COMPOSITE_FRAG,
  POST_VERT,
} from "./shaders/post.glsl";

/**
 * Per-step weight on the upsample, applied once per level the energy travels
 * through.
 *
 * Below 1 on purpose. With a flat pyramid the coarsest level — a blur tens of
 * pixels wide — contributes as much energy as the tightest one, and the result
 * is a grey wash over the whole frame that reads instantly as a cheap bloom. At
 * 0.82 the fifth level carries 45% of the base level's weight, so the bloom has
 * a bright, defined core and a faint wide skirt, which is what a real lens does.
 */
export const UPSAMPLE_WEIGHT = 0.82;

/**
 * Smallest dimension a pyramid level may have, in pixels.
 *
 * Below about this the bilinear taps of the next downsample fall outside the
 * surface and clamp, so the level stops being a blur of the image and starts
 * being a blur of its own edge pixels.
 */
const MIN_LEVEL_SIZE = 8;

/**
 * Number of scene pixels that map to one level-0 texel, per axis.
 *
 * The pyramid starts at half resolution. Starting at full resolution would cost
 * a full-screen half-float surface and one more pass for detail that the very
 * first blur throws away.
 */
const BLOOM_BASE_DIVISOR = 2;

interface PrefilterUniforms {
  readonly uScene: IUniform<Texture | null>;
  readonly uHalfPixel: IUniform<Vector2>;
  [key: string]: IUniform;
}

interface DownsampleUniforms {
  readonly uSource: IUniform<Texture | null>;
  readonly uHalfPixel: IUniform<Vector2>;
  [key: string]: IUniform;
}

interface UpsampleUniforms extends DownsampleUniforms {
  readonly uWeight: IUniform<number>;
}

interface CompositeUniforms {
  readonly uScene: IUniform<Texture | null>;
  readonly uBloom: IUniform<Texture | null>;
  readonly uResolution: IUniform<Vector2>;
  readonly uExposure: IUniform<number>;
  readonly uBloomStrength: IUniform<number>;
  readonly uBloomNormalize: IUniform<number>;
  readonly uAberration: IUniform<number>;
  readonly uGrain: IUniform<number>;
  readonly uGrainSeed: IUniform<number>;
  readonly uNoiseScale: IUniform<number>;
  [key: string]: IUniform;
}

/**
 * Can this context render to a half-float colour attachment?
 *
 * Either extension is enough: `EXT_color_buffer_float` makes RGBA16F and
 * RGBA32F renderable, `EXT_color_buffer_half_float` makes RGBA16F renderable on
 * its own and is the one mobile drivers are most likely to expose. Asking for
 * both and taking either is the honest test — the alternative, allocating a
 * target and checking framebuffer completeness, costs an allocation to learn
 * the same thing.
 */
export function isPostSupported(gl: WebGL2RenderingContext): boolean {
  return (
    gl.getExtension("EXT_color_buffer_float") !== null ||
    gl.getExtension("EXT_color_buffer_half_float") !== null
  );
}

export class PostChain {
  /** Full-resolution linear HDR. rgb radiance, a emissive luminance. */
  private sceneTargetRt: WebGLRenderTarget;
  /** The bloom pyramid, largest first. Length follows the quality profile. */
  private levels: WebGLRenderTarget[] = [];

  private readonly geometry: BufferGeometry;
  private readonly mesh: Mesh;
  private readonly scene: Scene;
  /** Ignored by the shader — the triangle is already in clip space. */
  private readonly camera = new Camera();

  private readonly prefilter: RawShaderMaterial;
  private readonly downsample: RawShaderMaterial;
  private readonly upsample: RawShaderMaterial;
  private readonly composite: RawShaderMaterial;

  private readonly prefilterUniforms: PrefilterUniforms;
  private readonly downsampleUniforms: DownsampleUniforms;
  private readonly upsampleUniforms: UpsampleUniforms;
  private readonly compositeUniforms: CompositeUniforms;

  private width = 1;
  private height = 1;
  private requestedLevels: number;

  /**
   * Offscreen RGBA8 copy of the final frame, allocated only when something
   * asks to read pixels back. See `readPixels`.
   */
  private readbackTarget: WebGLRenderTarget | null = null;

  constructor(profile: QualityProfile) {
    this.requestedLevels = profile.bloomLevels;

    this.geometry = new BufferGeometry();
    // The same oversized clip-space triangle as the scene pass, for the same
    // reason: a quad would shade the pixels along its diagonal twice, and this
    // geometry is drawn once per pyramid level per frame.
    this.geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );

    this.prefilterUniforms = {
      uScene: { value: null },
      uHalfPixel: { value: new Vector2() },
    };
    this.downsampleUniforms = {
      uSource: { value: null },
      uHalfPixel: { value: new Vector2() },
    };
    this.upsampleUniforms = {
      uSource: { value: null },
      uHalfPixel: { value: new Vector2() },
      uWeight: { value: UPSAMPLE_WEIGHT },
    };
    this.compositeUniforms = {
      uScene: { value: null },
      uBloom: { value: null },
      uResolution: { value: new Vector2(1, 1) },
      uExposure: { value: 1 },
      uBloomStrength: { value: 0 },
      uBloomNormalize: { value: 1 },
      uAberration: { value: 0 },
      uGrain: { value: 0 },
      uGrainSeed: { value: 0 },
      uNoiseScale: { value: 1 },
    };

    this.prefilter = makeMaterial("BloomPrefilter", BLOOM_PREFILTER_FRAG, this.prefilterUniforms);
    this.downsample = makeMaterial("BloomDownsample", BLOOM_DOWNSAMPLE_FRAG, this.downsampleUniforms);
    this.upsample = makeMaterial("BloomUpsample", BLOOM_UPSAMPLE_FRAG, this.upsampleUniforms);
    this.composite = makeMaterial("PostComposite", COMPOSITE_FRAG, this.compositeUniforms);

    // The one place in the project where blending is on. Explicit One/One
    // rather than three's AdditiveBlending preset, which is SrcAlpha/One and
    // would silently make the pyramid depend on the alpha the blur happens to
    // write.
    this.upsample.blending = CustomBlending;
    this.upsample.blendEquation = AddEquation;
    this.upsample.blendSrc = OneFactor;
    this.upsample.blendDst = OneFactor;
    this.upsample.transparent = true;

    this.sceneTargetRt = makeHdrTarget(1, 1);

    this.mesh = new Mesh(this.geometry, this.composite);
    this.mesh.frustumCulled = false;
    this.scene = new Scene();
    this.scene.add(this.mesh);
  }

  /** The surface the scene pass must render into. */
  get sceneTarget(): WebGLRenderTarget {
    return this.sceneTargetRt;
  }

  /** Levels actually allocated, which the buffer size may cap below the profile. */
  get levelCount(): number {
    return this.levels.length;
  }

  /**
   * Resize every surface to a new drawing-buffer size.
   *
   * The pyramid is rebuilt from scratch rather than resized in place: level
   * count depends on the size (a short buffer runs out of levels before a tall
   * one does), and three's `setSize` on a render target reallocates the texture
   * anyway, so there is nothing to save by keeping them.
   */
  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height && this.levels.length > 0) return;

    this.width = w;
    this.height = h;

    this.sceneTargetRt.setSize(w, h);
    this.compositeUniforms.uResolution.value.set(w, h);

    this.rebuildPyramid();

    if (this.readbackTarget) this.readbackTarget.setSize(w, h);
  }

  /** Apply a quality profile. Only the pyramid depth is profile-driven. */
  setQuality(profile: QualityProfile): void {
    if (profile.bloomLevels === this.requestedLevels) return;
    this.requestedLevels = profile.bloomLevels;
    this.rebuildPyramid();
  }

  /** Push one frame of smoothed, tier-driven post parameters. */
  setVisuals(values: PostUniformValues): void {
    this.compositeUniforms.uBloomStrength.value = values.bloomStrength;
    this.compositeUniforms.uAberration.value = values.chromaticAberration;
    this.compositeUniforms.uGrain.value = values.grainAmount;
  }

  setExposure(exposure: number): void {
    this.compositeUniforms.uExposure.value = exposure;
  }

  /**
   * Scale grain and dither together. 1 is normal; 0 is the undithered control
   * the banding harness measures against. Debug only — see the uniform's
   * comment in the composite shader.
   */
  setNoiseScale(scale: number): void {
    this.compositeUniforms.uNoiseScale.value = Number.isFinite(scale) ? scale : 1;
  }

  /**
   * Advance the grain.
   *
   * Seeded from SCENE time, not from a frame counter, so `?t=` freezes the
   * grain along with everything else and a screenshot is reproducible. The
   * multiplier turns a 16ms frame step into a full unit of seed, which is all
   * `hash33` needs to decorrelate one frame from the next; the modulo keeps the
   * argument small enough that a float32 still resolves those unit steps after
   * hours of playback.
   */
  setTime(seconds: number): void {
    this.compositeUniforms.uGrainSeed.value = (seconds * 60) % 4096;
  }

  /**
   * Run the whole chain. The scene must already be in `sceneTarget`.
   *
   * `output` is null for the default framebuffer.
   */
  render(renderer: WebGLRenderer, output: WebGLRenderTarget | null = null): void {
    const levels = this.levels;

    if (levels.length === 0) {
      // No room for even one pyramid level, which means a buffer a few pixels
      // across. Composite with a black bloom rather than skipping the pass:
      // the tone map, grain and dither still have to happen.
      this.compositeUniforms.uBloom.value = this.sceneTargetRt.texture;
      this.compositeUniforms.uBloomNormalize.value = 0;
      this.drawTo(renderer, this.composite, output);
      return;
    }

    // ---- 1. Threshold into the base level ---------------------------------
    // Half a SOURCE texel here, unlike every other pass — see the prefilter's
    // own uniform comment for why that is what makes its box exact.
    this.prefilterUniforms.uScene.value = this.sceneTargetRt.texture;
    setHalfPixel(this.prefilterUniforms.uHalfPixel.value, this.sceneTargetRt);
    this.drawTo(renderer, this.prefilter, levels[0]);

    // ---- 2. Down the pyramid ----------------------------------------------
    for (let i = 1; i < levels.length; i += 1) {
      this.downsampleUniforms.uSource.value = levels[i - 1].texture;
      setHalfPixel(this.downsampleUniforms.uHalfPixel.value, levels[i]);
      this.drawTo(renderer, this.downsample, levels[i]);
    }

    // ---- 3. Back up, adding into what the downsample left there ------------
    for (let i = levels.length - 1; i >= 1; i -= 1) {
      this.upsampleUniforms.uSource.value = levels[i].texture;
      setHalfPixel(this.upsampleUniforms.uHalfPixel.value, levels[i - 1]);
      this.drawTo(renderer, this.upsample, levels[i - 1]);
    }

    // ---- 4. Composite ------------------------------------------------------
    this.compositeUniforms.uScene.value = this.sceneTargetRt.texture;
    this.compositeUniforms.uBloom.value = levels[0].texture;
    this.compositeUniforms.uBloomNormalize.value = bloomNormalize(levels.length);
    this.drawTo(renderer, this.composite, output);
  }

  /**
   * Composite into an offscreen 8-bit surface and read it back.
   *
   * This exists for the banding check in `scripts/banding.ts`, and it is
   * deliberately not a `readPixels` against the default framebuffer: the
   * context is created with `preserveDrawingBuffer: false`, so the only
   * guaranteed-valid moment to read the real back buffer is inside the same
   * task that drew it, which a test harness cannot arrange from the outside.
   * An offscreen RGBA8 target quantises identically — the same 8 bits per
   * channel, after the same dither — and can be read whenever.
   *
   * Returns tightly packed RGBA rows, top row first. (`readRenderTargetPixels`
   * hands back GL's bottom-up order, which is flipped here so the caller can
   * reason in screen coordinates.)
   */
  readPixels(renderer: WebGLRenderer): { width: number; height: number; data: Uint8Array } {
    // A readback is one frame's worth of GPU work behind a synchronous stall,
    // so the surface is allocated on the first request and kept, rather than
    // being part of every session's memory budget.

    if (!this.readbackTarget) {
      this.readbackTarget = new WebGLRenderTarget(this.width, this.height, {
        type: UnsignedByteType,
        format: RGBAFormat,
        // No filtering and no colour-space conversion: this surface must hold
        // exactly the bytes the composite wrote, or it is measuring itself.
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        colorSpace: LinearSRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
      });
    }

    this.render(renderer, this.readbackTarget);

    const data = new Uint8Array(this.width * this.height * 4);
    renderer.readRenderTargetPixels(this.readbackTarget, 0, 0, this.width, this.height, data);
    renderer.setRenderTarget(null);

    const stride = this.width * 4;
    const flipped = new Uint8Array(data.length);
    for (let row = 0; row < this.height; row += 1) {
      const source = (this.height - 1 - row) * stride;
      flipped.set(data.subarray(source, source + stride), row * stride);
    }

    return { width: this.width, height: this.height, data: flipped };
  }

  dispose(): void {
    this.geometry.dispose();
    this.prefilter.dispose();
    this.downsample.dispose();
    this.upsample.dispose();
    this.composite.dispose();
    this.sceneTargetRt.dispose();
    for (const level of this.levels) level.dispose();
    this.levels = [];
    this.readbackTarget?.dispose();
    this.readbackTarget = null;
  }

  /** Bind a target, swap the material onto the triangle, draw once. */
  private drawTo(
    renderer: WebGLRenderer,
    material: RawShaderMaterial,
    target: WebGLRenderTarget | null,
  ): void {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    // No clear anywhere in this chain. Every surface is either fully
    // overwritten by the pass that writes it or is being added into on
    // purpose, and a clear on a target that is about to be overwritten is a
    // full-surface write for nothing.
    renderer.render(this.scene, this.camera);
  }

  private rebuildPyramid(): void {
    for (const level of this.levels) level.dispose();
    this.levels = [];

    let w = Math.floor(this.width / BLOOM_BASE_DIVISOR);
    let h = Math.floor(this.height / BLOOM_BASE_DIVISOR);

    for (let i = 0; i < this.requestedLevels; i += 1) {
      if (w < MIN_LEVEL_SIZE || h < MIN_LEVEL_SIZE) break;
      this.levels.push(makeHdrTarget(w, h));
      w = Math.floor(w / 2);
      h = Math.floor(h / 2);
    }
  }
}

/**
 * Energy normalisation for a pyramid of `levels` levels.
 *
 * Level k's contribution passes through k upsample steps and so carries
 * `UPSAMPLE_WEIGHT^k`; the sum of that geometric series is what the composite
 * divides by. Without it a device that drops a pyramid level — because the
 * governor stepped down, or because the window is short — would show a
 * measurably dimmer bloom, and the effect would appear to depend on the window
 * size rather than on the tier.
 *
 * Exported for `scripts/verify-post.ts`, which asserts exactly that
 * independence across every pyramid depth the quality profiles can produce.
 */
export function bloomNormalize(levels: number): number {
  let total = 0;
  for (let k = 0; k < levels; k += 1) total += UPSAMPLE_WEIGHT ** k;
  return total > 0 ? 1 / total : 0;
}

/** Half a texel of `target`, in that target's UV space. */
function setHalfPixel(out: Vector2, target: WebGLRenderTarget): void {
  out.set(0.5 / target.width, 0.5 / target.height);
}

function makeHdrTarget(width: number, height: number): WebGLRenderTarget {
  return new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    format: RGBAFormat,
    // Bilinear is not optional: the entire dual Kawase kernel is built out of
    // taps placed BETWEEN texels, and each one is meant to be a free average of
    // the four around it. With nearest filtering the five-tap downsample
    // becomes five point samples and the blur turns into a cross-shaped smear.
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    // Clamp, not repeat: a tap that runs off the top of the frame must read the
    // edge, not wrap around to the bottom and drag the disk's glow into the
    // opposite corner.
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    // Linear light all the way through. Any sRGB conversion here would blur
    // display-encoded values, which is not what light does.
    colorSpace: LinearSRGBColorSpace,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

function makeMaterial(
  name: string,
  fragmentShader: string,
  uniforms: Record<string, IUniform>,
): RawShaderMaterial {
  return new RawShaderMaterial({
    name,
    glslVersion: GLSL3,
    vertexShader: POST_VERT,
    fragmentShader,
    uniforms,
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
  });
}
