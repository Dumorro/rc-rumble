import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

import CONFIG, { q } from '../core/Config.js';
import { clamp, clamp01, damp } from '../core/MathUtils.js';

import { FULLSCREEN_VERT } from './shaders/Common.js';
import {
  BLOOM_PREFILTER_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG,
} from './shaders/BloomShaders.js';
import { DEPTH_RESOLVE_FRAG } from './shaders/DepthResolveShader.js';
import { AO_FRAG, AO_APPLY_FRAG } from './shaders/AOShader.js';
import { MOTION_BLUR_FRAG } from './shaders/MotionBlurShader.js';
import { DOF_FRAG } from './shaders/DofShader.js';
import { COMPOSITE_FRAG } from './shaders/CompositeShader.js';
import { FXAA_FRAG } from './shaders/FXAAShader.js';

/**
 * The post stack.
 *
 *   RenderPass (HDR + depth texture)
 *     → AO           (half-res depth-only occlusion, high/ultra)
 *     → MotionBlur   (camera reprojection + speed-driven radial rush)
 *     → DOF          (cinematic camera moments only)
 *     → Bloom        (soft-knee threshold pyramid, written to its own target)
 *     → Composite    (distortion + CA + bloom + flash + ACES + LUT grade +
 *                     vignette + grain + dither → sRGB)
 *     → FXAA         (→ screen)
 *
 * Buffer plumbing note: the composer's two ping-pong targets are ours, and the
 * FIRST one carries a DepthTexture. We reset read/write at the top of every
 * frame so the scene always lands in that target, and we run the whole chain
 * with `renderer.autoClear = false` so no later pass can wipe the depth we still
 * need. Every full-screen material is depthTest:false / depthWrite:false.
 */

const _mat4a = new THREE.Matrix4();
const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();

/** Small base class: a full-screen shader pass we fully control. */
class ShaderQuadPass extends Pass {
  constructor(fragmentShader, uniforms, defines = {}) {
    super();
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.uniforms = this.material.uniforms;
    this._quad = new FullScreenQuad(this.material);
  }

  setDefine(name, on) {
    const has = name in this.material.defines;
    if (on && !has) { this.material.defines[name] = ''; this.material.needsUpdate = true; }
    else if (!on && has) { delete this.material.defines[name]; this.material.needsUpdate = true; }
  }

  renderTo(renderer, target) {
    renderer.setRenderTarget(target);
    this._quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.uniforms.tDiffuse) this.uniforms.tDiffuse.value = readBuffer.texture;
    this.renderTo(renderer, this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    this.material.dispose();
    // NOTE: never call FullScreenQuad#dispose — the geometry is shared module-wide.
  }
}

// ──────────────────────────────────────────────────── depth resolve pass

/**
 * Turns the depth attachment into a linear view-distance buffer that is safe for
 * every later pass to sample, no matter which ping-pong target they are writing
 * into. See DepthResolveShader.js for why this is not optional.
 */
class DepthResolvePass extends Pass {
  constructor(width, height) {
    super();
    this.needsSwap = false;

    this.target = newTarget(width, height, {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      depthBuffer: false,
    });
    this.target.texture.name = 'rc/linearDepth';

    this.material = quadMaterial(DEPTH_RESOLVE_FRAG, {
      tDepth: { value: null },
      uNear: { value: 0.02 },
      uFar: { value: 400 },
    });
    this._quad = new FullScreenQuad(this.material);
  }

  get texture() { return this.target.texture; }

  setSize(width, height) {
    this.target.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
  }

  setDepth(tex) { this.material.uniforms.tDepth.value = tex; }

  updateCamera(camera) {
    this.material.uniforms.uNear.value = camera.near;
    this.material.uniforms.uFar.value = camera.far;
  }

  render(renderer) {
    renderer.setRenderTarget(this.target);
    this._quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}

// ─────────────────────────────────────────────────────────────── AO pass

class AOPass extends Pass {
  constructor(width, height) {
    super();
    this.needsSwap = true;
    this.scale = 0.5;

    this.aoTarget = newTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.aoTarget.texture.name = 'rc/ao';

    this.aoMaterial = quadMaterial(AO_FRAG, {
      tDepth: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uProjParams: { value: new THREE.Vector2(1, 1) },
      uProj11: { value: 1 },
      uFar: { value: 400 },
      uRadius: { value: 0.28 },
      uMaxScreenRadius: { value: 0.06 },
      uBias: { value: 0.045 },
      uPower: { value: 1.5 },
      uFrame: { value: 0 },
    });

    this.applyMaterial = quadMaterial(AO_APPLY_FRAG, {
      tDiffuse: { value: null },
      tAO: { value: this.aoTarget.texture },
      tDepth: { value: null },
      uAoTexel: { value: new THREE.Vector2(1, 1) },
      uIntensity: { value: 0.65 },
      uColor: { value: new THREE.Color(0x1b2028) },
      uFar: { value: 400 },
    });

    this._aoQuad = new FullScreenQuad(this.aoMaterial);
    this._applyQuad = new FullScreenQuad(this.applyMaterial);
    this._frame = 0;
    this.setSize(width, height);
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width * this.scale));
    const h = Math.max(1, Math.floor(height * this.scale));
    this.aoTarget.setSize(w, h);
    this.aoMaterial.uniforms.uResolution.value.set(w, h);
    this.applyMaterial.uniforms.uAoTexel.value.set(1 / w, 1 / h);
  }

  updateCamera(camera) {
    const u = this.aoMaterial.uniforms;
    const p = camera.projectionMatrix.elements;
    const p00 = p[0] !== 0 ? p[0] : 1;
    const p11 = p[5] !== 0 ? p[5] : 1;
    u.uProjParams.value.set(1 / p00, 1 / p11);
    u.uProj11.value = p11;
    u.uFar.value = camera.far;
    this.applyMaterial.uniforms.uFar.value = camera.far;
  }

  render(renderer, writeBuffer, readBuffer) {
    this._frame = (this._frame + 1) % 64;
    this.aoMaterial.uniforms.uFrame.value = this._frame;

    renderer.setRenderTarget(this.aoTarget);
    this._aoQuad.render(renderer);

    this.applyMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._applyQuad.render(renderer);
  }

  setDepth(tex) {
    this.aoMaterial.uniforms.tDepth.value = tex;
    this.applyMaterial.uniforms.tDepth.value = tex;
  }

  dispose() {
    this.aoTarget.dispose();
    this.aoMaterial.dispose();
    this.applyMaterial.dispose();
  }
}

// ───────────────────────────────────────────────────────────── bloom pass

class BloomPass extends Pass {
  constructor(width, height, levels = 5) {
    super();
    // Bloom does not participate in the ping-pong: it reads the chain and writes
    // to its own pyramid, and the composite pass adds it back in.
    this.needsSwap = false;
    this.levels = levels;
    /** @type {THREE.WebGLRenderTarget[]} */
    this.mips = [];

    this.prefilterMaterial = quadMaterial(BLOOM_PREFILTER_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uFilter: { value: new THREE.Vector4() },
      uClamp: { value: 12.0 },
    });
    this.downMaterial = quadMaterial(BLOOM_DOWN_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.upMaterial = quadMaterial(BLOOM_UP_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 0.9 },
    });
    this.upMaterial.blending = THREE.AdditiveBlending;
    this.upMaterial.transparent = true;

    this._prefilterQuad = new FullScreenQuad(this.prefilterMaterial);
    this._downQuad = new FullScreenQuad(this.downMaterial);
    this._upQuad = new FullScreenQuad(this.upMaterial);

    this.threshold = 1.05;
    this.knee = 0.62;
    this.setSize(width, height);
    this.setThreshold(this.threshold, this.knee);
  }

  get texture() { return this.mips.length ? this.mips[0].texture : null; }

  setThreshold(threshold, knee) {
    this.threshold = threshold;
    this.knee = Math.max(knee, 0.0001);
    const k = this.threshold * this.knee;
    this.prefilterMaterial.uniforms.uFilter.value.set(
      this.threshold, this.threshold - k, 2 * k, 0.25 / k,
    );
  }

  setLevels(levels) {
    if (levels === this.levels) return;
    this.levels = levels;
    this._rebuild(this._width, this._height);
  }

  setSize(width, height) {
    this._width = Math.max(2, Math.floor(width));
    this._height = Math.max(2, Math.floor(height));
    this._rebuild(this._width, this._height);
  }

  _rebuild(width, height) {
    for (const m of this.mips) m.dispose();
    this.mips.length = 0;
    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    const maxLevels = Math.max(1, Math.min(this.levels, Math.floor(Math.log2(Math.min(w, h)))));
    for (let i = 0; i < maxLevels; i++) {
      const rt = newTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
      rt.texture.name = `rc/bloom${i}`;
      this.mips.push(rt);
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
  }

  render(renderer, writeBuffer, readBuffer) {
    const mips = this.mips;
    if (mips.length === 0) return;

    // 1. threshold into mip0 (half res)
    this.prefilterMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.prefilterMaterial.uniforms.uTexel.value.set(
      1 / Math.max(readBuffer.width, 1), 1 / Math.max(readBuffer.height, 1));
    renderer.setRenderTarget(mips[0]);
    this._prefilterQuad.render(renderer);

    // 2. downsample chain
    for (let i = 1; i < mips.length; i++) {
      const src = mips[i - 1];
      this.downMaterial.uniforms.tDiffuse.value = src.texture;
      this.downMaterial.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(mips[i]);
      this._downQuad.render(renderer);
    }

    // 3. tent upsample, additively accumulating back down the pyramid
    for (let i = mips.length - 1; i > 0; i--) {
      const src = mips[i];
      this.upMaterial.uniforms.tDiffuse.value = src.texture;
      this.upMaterial.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(mips[i - 1]);
      this._upQuad.render(renderer);
    }
  }

  dispose() {
    for (const m of this.mips) m.dispose();
    this.mips.length = 0;
    this.prefilterMaterial.dispose();
    this.downMaterial.dispose();
    this.upMaterial.dispose();
  }
}

// ─────────────────────────────────────────────────────────────── helpers

function newTarget(w, h, opts = {}) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: opts.type ?? THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: opts.depthBuffer ?? false,
    stencilBuffer: false,
    generateMipmaps: false,
    samples: 0,
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return rt;
}

function quadMaterial(fragmentShader, uniforms, defines = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    defines,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
  });
}

/** Builds the procedural colour-grade LUT as a 2D slice strip (no LUT images). */
function buildGradeLUT(size, grade) {
  const g = {
    lift: [0, 0, 0],
    gamma: [1, 1, 1],
    gain: [1, 1, 1],
    saturation: 1.06,
    contrast: 1.06,
    pivot: 0.42,
    temperature: 0,
    tint: 0,
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    ...(grade || {}),
  };

  const n = size;
  const w = n * n;
  const h = n;
  const data = new Uint8Array(w * h * 4);

  // Temperature: positive = warmer. Applied as a simple channel gain.
  const tK = g.temperature;
  const tG = g.tint;
  const tempGain = [
    1 + tK * 0.22 - tG * 0.03,
    1 + tG * 0.14,
    1 - tK * 0.24 - tG * 0.03,
  ];

  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  const out = [0, 0, 0];
  for (let b = 0; b < n; b++) {
    for (let gI = 0; gI < n; gI++) {
      for (let r = 0; r < n; r++) {
        out[0] = r / (n - 1);
        out[1] = gI / (n - 1);
        out[2] = b / (n - 1);

        // work in linear light for lift/gamma/gain and temperature
        for (let c = 0; c < 3; c++) {
          let v = srgbToLinear(out[c]);
          v = v * g.gain[c] + g.lift[c] * (1 - v);
          v = Math.max(v, 0);
          if (g.gamma[c] !== 1) v = Math.pow(v, 1 / g.gamma[c]);
          v *= tempGain[c];
          out[c] = Math.max(v, 0);
        }

        // shadow / highlight split toning
        const lum = out[0] * 0.2126 + out[1] * 0.7152 + out[2] * 0.0722;
        const sw = 1 - Math.min(lum / 0.28, 1);
        const hw = Math.min(Math.max((lum - 0.45) / 0.55, 0), 1);
        for (let c = 0; c < 3; c++) {
          out[c] *= (1 - sw) + sw * g.shadowTint[c];
          out[c] *= (1 - hw) + hw * g.highlightTint[c];
        }

        // back to display space for saturation + the filmic S curve
        for (let c = 0; c < 3; c++) out[c] = linearToSrgb(Math.min(out[c], 8));

        const l2 = out[0] * 0.2126 + out[1] * 0.7152 + out[2] * 0.0722;
        for (let c = 0; c < 3; c++) out[c] = l2 + (out[c] - l2) * g.saturation;

        // Filmic S-curve around the pivot, normalised PER SIDE so that 0 maps to
        // exactly 0 and 1 to exactly 1 — otherwise the curve lifts blacks and
        // crushes whites and the whole game looks like it is behind fog.
        const k = g.contrast * 1.35;
        const kT = Math.tanh(k);
        for (let c = 0; c < 3; c++) {
          const x = out[c] - g.pivot;
          const range = x >= 0 ? (1 - g.pivot) : g.pivot;
          const t = range > 1e-6 ? x / range : 0;
          out[c] = g.pivot + (Math.tanh(t * k) / kT) * range;
        }

        const idx = ((gI * w) + (b * n + r)) * 4;
        data[idx + 0] = Math.round(clamp01(out[0]) * 255);
        data[idx + 1] = Math.round(clamp01(out[1]) * 255);
        data[idx + 2] = Math.round(clamp01(out[2]) * 255);
        data[idx + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'rc/gradeLUT';
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** Per-track colour grade presets. Tracks pass `environment.grade`. */
export const GRADE_PRESETS = {
  neutral: {},
  museum: {
    lift: [0.010, 0.007, 0.000],
    gain: [1.05, 1.00, 0.94],
    gamma: [1.0, 1.0, 1.02],
    saturation: 1.10, contrast: 1.10, temperature: 0.10,
    shadowTint: [0.94, 0.97, 1.08], highlightTint: [1.05, 1.01, 0.94],
  },
  garden: {
    gain: [1.00, 1.05, 0.99],
    saturation: 1.18, contrast: 1.12, temperature: 0.03,
    shadowTint: [0.92, 1.00, 1.06], highlightTint: [1.03, 1.02, 0.97],
  },
  supermarket: {
    lift: [0.000, 0.004, 0.010],
    gain: [0.98, 1.00, 1.06],
    saturation: 1.04, contrast: 1.14, temperature: -0.10,
    shadowTint: [0.95, 0.99, 1.08], highlightTint: [0.99, 1.01, 1.04],
  },
  sunset: {
    lift: [0.014, 0.006, 0.002],
    gain: [1.10, 0.99, 0.88],
    saturation: 1.16, contrast: 1.08, temperature: 0.22,
    shadowTint: [0.90, 0.94, 1.12], highlightTint: [1.08, 1.00, 0.88],
  },
  night: {
    lift: [0.004, 0.008, 0.020],
    gain: [0.90, 0.96, 1.12],
    saturation: 0.92, contrast: 1.18, temperature: -0.18,
    shadowTint: [0.86, 0.92, 1.18], highlightTint: [0.96, 1.00, 1.08],
  },
};

// ───────────────────────────────────────────────────────────────── PostFX

export class PostFX {
  /**
   * @param {object} game
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(game, renderer) {
    this.game = game;
    this.renderer = renderer;
    this.scene = game.scene;

    this.quality = CONFIG.quality;
    this.enabled = true;

    /** @type {EffectComposer|null} */
    this.composer = null;

    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;

    // driven state
    this.speedIntensity = 0;
    this._speedSmoothed = 0;
    this._speedExternal = false;
    this.slowMo = 0;
    this._slowMoSmoothed = 0;
    this.exposure = CONFIG.render.exposure;
    /** Resting vignette amount; speed/slow-mo stack on top of it. */
    this._vignetteBase = 0.26;

    this._flash = { color: new THREE.Color(1, 1, 1), strength: 0, decay: 1 };
    this._fade = { color: new THREE.Color(0, 0, 0), amount: 0, target: 0, rate: 2 };

    this.dof = {
      enabled: false,
      intensity: 0,
      target: 0,
      focusDistance: 3,
      focusRange: 0.35,
      nearFalloff: 1.2,
      farFalloff: 5.0,
      maxBlur: 0.022,
      bokehBias: 0.55,
      autoFocus: true,
    };

    this._prevViewProj = new THREE.Matrix4();
    this._hasPrev = false;
    this._time = 0;

    this._lutSize = 32;
    this._lut = null;
    this._grade = null;

    /** Which passes the user/config wants. Adaptive quality overrides live in `_force`. */
    this.want = { ao: true, motionBlur: true, bloom: true, dof: true, lut: true, ca: true, vignette: true, grain: true, fxaa: true, distortion: true };
    this._force = { ao: null, motionBlur: null, bloom: null, dof: null, fxaa: null };

    this.passes = {};
  }

  // ───────────────────────────────────────────────────────────── setup

  init(width, height, pixelRatio) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = pixelRatio;

    const w = Math.max(1, Math.floor(this.width * pixelRatio));
    const h = Math.max(1, Math.floor(this.height * pixelRatio));

    // rt1 carries the depth texture and always receives the scene render
    const depth = new THREE.DepthTexture(w, h, THREE.FloatType);
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    depth.name = 'rc/sceneDepth';

    const rt1 = newTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true });
    rt1.texture.name = 'rc/scene';
    rt1.depthTexture = depth;

    const rt2 = newTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    rt2.texture.name = 'rc/pong';

    const composer = new EffectComposer(this.renderer, rt1);
    composer.renderTarget2.dispose();
    composer.renderTarget2 = rt2;
    composer.readBuffer = rt1;
    composer.writeBuffer = rt2;
    composer.setPixelRatio(pixelRatio);
    this.composer = composer;
    this.sceneTarget = rt1;
    this.depthTexture = depth;

    // ── passes ──
    const camera = this.game.camera;

    this.passes.render = new RenderPass(this.scene, camera);
    this.passes.render.clear = true;

    this.passes.depthResolve = new DepthResolvePass(w, h);
    this.passes.depthResolve.setDepth(depth);
    const linearDepth = this.passes.depthResolve.texture;

    this.passes.ao = new AOPass(w, h);
    this.passes.ao.setDepth(linearDepth);

    this.passes.motionBlur = new ShaderQuadPass(MOTION_BLUR_FRAG, {
      tDiffuse: { value: null },
      tDepth: { value: linearDepth },
      uCamWorld: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uProjParams: { value: new THREE.Vector2(1, 1) },
      uResolution: { value: new THREE.Vector2(w, h) },
      uFar: { value: camera.far },
      uStrength: { value: 0.7 },
      uMaxVelocity: { value: 0.045 },
      uRadial: { value: 0 },
      uJitter: { value: 1.0 },
    });

    this.passes.dof = new ShaderQuadPass(DOF_FRAG, {
      tDiffuse: { value: null },
      tDepth: { value: linearDepth },
      uResolution: { value: new THREE.Vector2(w, h) },
      uFocusDistance: { value: 3 },
      uFocusRange: { value: 0.35 },
      uNearFalloff: { value: 1.2 },
      uFarFalloff: { value: 5.0 },
      uMaxBlur: { value: 0.022 },
      uBokehBias: { value: 0.55 },
      uIntensity: { value: 0 },
    });

    this.passes.bloom = new BloomPass(w, h, 5);

    this._lut = buildGradeLUT(this._lutSize, this._grade);

    this.passes.composite = new ShaderQuadPass(COMPOSITE_FRAG, {
      tDiffuse: { value: null },
      tBloom: { value: this.passes.bloom.texture },
      tLut: { value: this._lut },
      uResolution: { value: new THREE.Vector2(w, h) },
      uAspect: { value: w / h },
      uExposure: { value: this.exposure },
      uBloomStrength: { value: 0.34 },
      uLutSize: { value: this._lutSize },
      uLutIntensity: { value: 1.0 },
      uCA: { value: 0.0 },
      uDistortion: { value: 0.0 },
      uVignette: { value: 0.34 },
      uVignetteSoft: { value: 0.42 },
      uGrain: { value: 0.028 },
      uTime: { value: 0 },
      uFlashColor: { value: new THREE.Color(1, 1, 1) },
      uFlashStrength: { value: 0 },
      uSlowMo: { value: 0 },
      uSaturation: { value: 1 },
      uFade: { value: 0 },
      uFadeColor: { value: new THREE.Color(0, 0, 0) },
    }, { USE_BLOOM: '', USE_LUT: '', USE_VIGNETTE: '', USE_GRAIN: '', USE_CA: '' });

    this.passes.fxaa = new ShaderQuadPass(FXAA_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uSubpix: { value: 0.6 },
      uEdgeThreshold: { value: 0.166 },
      uEdgeThresholdMin: { value: 0.0625 },
    });

    composer.addPass(this.passes.render);
    composer.addPass(this.passes.depthResolve);
    composer.addPass(this.passes.ao);
    composer.addPass(this.passes.motionBlur);
    composer.addPass(this.passes.dof);
    composer.addPass(this.passes.bloom);
    composer.addPass(this.passes.composite);
    composer.addPass(this.passes.fxaa);

    this.applyQuality(this.quality);
    this.setSize(this.width, this.height, this.pixelRatio);
    return this;
  }

  // ───────────────────────────────────────────────────────── configuration

  /** Read CONFIG.render.postfx for a quality level and enable/disable passes. */
  applyQuality(level) {
    this.quality = level || CONFIG.quality;
    const cfg = CONFIG.render.postfx || {};

    this.want.bloom = !!q(cfg.bloom, this.quality);
    this.want.motionBlur = !!q(cfg.motionBlur, this.quality);
    this.want.ao = !!q(cfg.ssao, this.quality);
    this.want.vignette = !!q(cfg.vignette, this.quality);
    this.want.grain = !!q(cfg.grain, this.quality);
    this.want.ca = !!q(cfg.chromaticAberration, this.quality);
    this.want.distortion = this.want.ca;
    this.want.lut = !!q(cfg.colorGrade, this.quality);
    this.want.dof = this.quality !== 'low';
    this.want.fxaa = true;

    // quality-dependent tuning
    const bloom = this.passes.bloom;
    if (bloom) {
      bloom.setLevels(this.quality === 'low' ? 3 : this.quality === 'medium' ? 4 : 5);
      bloom.upMaterial.uniforms.uRadius.value = this.quality === 'low' ? 1.1 : 0.9;
    }
    if (this.passes.ao) {
      this.passes.ao.scale = this.quality === 'ultra' ? 0.75 : 0.5;
      this.passes.ao.aoMaterial.uniforms.uPower.value = this.quality === 'ultra' ? 1.65 : 1.45;
    }
    if (this.passes.fxaa) {
      this.passes.fxaa.uniforms.uSubpix.value = this.quality === 'low' ? 0.75 : 0.6;
    }

    this._syncEnabled();
    if (this.width > 1) this.setSize(this.width, this.height, this.pixelRatio);
    return this;
  }

  /**
   * Force a pass on/off regardless of config (adaptive quality uses this).
   * @param {'ao'|'motionBlur'|'bloom'|'dof'|'fxaa'} name
   * @param {boolean|null} value null = follow config
   */
  force(name, value) {
    if (!(name in this._force)) return this;
    this._force[name] = value;
    this._syncEnabled();
    return this;
  }

  /** Explicit user toggle. */
  setEnabled(name, value) {
    if (name in this.want) this.want[name] = !!value;
    this._syncEnabled();
    return this;
  }

  _syncEnabled() {
    const p = this.passes;
    if (!p.composite) return;
    const on = (name) => (this._force[name] === null || this._force[name] === undefined
      ? this.want[name] : this._force[name]);

    if (p.ao) p.ao.enabled = on('ao');
    if (p.motionBlur) p.motionBlur.enabled = on('motionBlur');
    if (p.bloom) p.bloom.enabled = on('bloom');
    if (p.dof) p.dof.enabled = on('dof') && (this.dof.enabled || this.dof.intensity > 0.001);
    if (p.fxaa) p.fxaa.enabled = on('fxaa');
    if (p.depthResolve) {
      p.depthResolve.enabled = !!(p.ao?.enabled || p.motionBlur?.enabled || p.dof?.enabled);
    }

    p.composite.setDefine('USE_BLOOM', !!(p.bloom && p.bloom.enabled));
    p.composite.setDefine('USE_LUT', this.want.lut);
    p.composite.setDefine('USE_VIGNETTE', this.want.vignette);
    p.composite.setDefine('USE_GRAIN', this.want.grain);
    p.composite.setDefine('USE_CA', this.want.ca);
    p.composite.setDefine('USE_DISTORTION', this.want.distortion);
  }

  setSize(width, height, pixelRatio = this.pixelRatio) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = pixelRatio;
    if (!this.composer) return this;

    const w = Math.max(1, Math.floor(this.width * pixelRatio));
    const h = Math.max(1, Math.floor(this.height * pixelRatio));

    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(this.width, this.height);

    // EffectComposer.setSize resizes the colour targets; nudge the depth texture
    // in step (it is rebuilt lazily by the renderer, but keep the CPU record right)
    if (this.depthTexture && this.depthTexture.image) {
      this.depthTexture.image.width = w;
      this.depthTexture.image.height = h;
      this.depthTexture.needsUpdate = true;
    }

    const p = this.passes;
    p.motionBlur?.uniforms.uResolution.value.set(w, h);
    p.dof?.uniforms.uResolution.value.set(w, h);
    if (p.composite) {
      p.composite.uniforms.uResolution.value.set(w, h);
      p.composite.uniforms.uAspect.value = w / h;
    }
    p.fxaa?.uniforms.uTexel.value.set(1 / w, 1 / h);
    if (p.composite && p.bloom) p.composite.uniforms.tBloom.value = p.bloom.texture;
    return this;
  }

  // ───────────────────────────────────────────────────────── artistic knobs

  setExposure(v) {
    this.exposure = v;
    if (this.passes.composite) this.passes.composite.uniforms.uExposure.value = v;
    return this;
  }

  /**
   * Per-track colour grade. Accepts a preset name or a descriptor:
   * `{ lift:[r,g,b], gamma:[r,g,b], gain:[r,g,b], saturation, contrast,
   *    temperature:-1..1, tint:-1..1, shadowTint:[r,g,b], highlightTint:[r,g,b] }`
   * Rebuilds the 32³ LUT (~1 ms) — call on track load, not per frame.
   */
  setGrade(grade) {
    const desc = typeof grade === 'string' ? (GRADE_PRESETS[grade] || GRADE_PRESETS.neutral) : grade;
    this._grade = desc || null;
    const next = buildGradeLUT(this._lutSize, this._grade);
    this._lut?.dispose();
    this._lut = next;
    if (this.passes.composite) this.passes.composite.uniforms.tLut.value = next;
    return this;
  }

  /** Blend between the ungraded and graded image (0..1). */
  setGradeIntensity(v) {
    if (this.passes.composite) this.passes.composite.uniforms.uLutIntensity.value = clamp01(v);
    return this;
  }

  /** Bloom tuning. Threshold is in linear HDR units (1.0 = white). */
  setBloom(strength, threshold, knee, radius) {
    if (this.passes.composite && typeof strength === 'number') {
      this.passes.composite.uniforms.uBloomStrength.value = strength;
    }
    if (this.passes.bloom) {
      if (typeof threshold === 'number' || typeof knee === 'number') {
        this.passes.bloom.setThreshold(
          typeof threshold === 'number' ? threshold : this.passes.bloom.threshold,
          typeof knee === 'number' ? knee : this.passes.bloom.knee,
        );
      }
      if (typeof radius === 'number') this.passes.bloom.upMaterial.uniforms.uRadius.value = radius;
    }
    return this;
  }

  /**
   * Base vignette. `update()` adds the speed and slow-mo response on top of
   * this every frame, so set the *resting* amount here.
   */
  setVignette(amount, softness) {
    if (typeof amount === 'number') this._vignetteBase = clamp(amount, 0, 0.9);
    const u = this.passes.composite?.uniforms;
    if (u && typeof softness === 'number') u.uVignetteSoft.value = softness;
    return this;
  }

  setGrain(amount) {
    const u = this.passes.composite?.uniforms;
    if (u && typeof amount === 'number') u.uGrain.value = amount;
    return this;
  }

  /**
   * 0..1 speed-driven intensity. Pushes chromatic aberration, lens distortion,
   * radial motion blur and vignette. Camera/vehicle systems call this every
   * frame; if nobody does, RenderSystem derives it from the player's speed.
   */
  setSpeedIntensity(t) {
    this.speedIntensity = clamp01(t);
    this._speedExternal = true;
    return this;
  }

  /** Internal fallback path (does not mark the value as externally driven). */
  suggestSpeedIntensity(t) {
    if (!this._speedExternal) this.speedIntensity = clamp01(t);
    return this;
  }

  /** 0 = normal, 1 = full slow-mo look (desaturated, heavier vignette + CA). */
  setSlowMo(t) {
    this.slowMo = clamp01(t);
    return this;
  }

  /**
   * Screen flash for weapon hits and big impacts. Additive and pre-tonemap, so a
   * strong flash genuinely blows the frame out instead of washing it grey.
   * @param {number|string|THREE.Color} color
   * @param {number} strength 0..~4
   * @param {number} seconds decay time
   */
  flash(color = 0xffffff, strength = 1, seconds = 0.25) {
    if (color !== undefined && color !== null) {
      if (color.isColor) this._flash.color.copy(color);
      else this._flash.color.set(color);
    }
    this._flash.strength = Math.max(this._flash.strength, strength);
    this._flash.decay = 1 / Math.max(seconds, 0.016);
    return this;
  }

  /** Fade the whole screen toward a colour (menus, respawns, race transitions). */
  fadeTo(amount, seconds = 0.4, color = 0x000000) {
    this._fade.target = clamp01(amount);
    this._fade.rate = 1 / Math.max(seconds, 0.016);
    if (color !== undefined && color !== null) {
      if (color.isColor) this._fade.color.copy(color);
      else this._fade.color.set(color);
    }
    return this;
  }

  /**
   * Depth of field. Cinematic cameras call this; racing leaves it off.
   * @param {{enabled?:boolean, focusDistance?:number, focusRange?:number,
   *          nearFalloff?:number, farFalloff?:number, maxBlur?:number,
   *          bokehBias?:number, autoFocus?:boolean, intensity?:number}} opts
   */
  setDof(opts = {}) {
    const d = this.dof;
    if (opts.enabled !== undefined) d.enabled = !!opts.enabled;
    if (typeof opts.focusDistance === 'number') { d.focusDistance = opts.focusDistance; d.autoFocus = false; }
    if (typeof opts.focusRange === 'number') d.focusRange = opts.focusRange;
    if (typeof opts.nearFalloff === 'number') d.nearFalloff = opts.nearFalloff;
    if (typeof opts.farFalloff === 'number') d.farFalloff = opts.farFalloff;
    if (typeof opts.maxBlur === 'number') d.maxBlur = opts.maxBlur;
    if (typeof opts.bokehBias === 'number') d.bokehBias = opts.bokehBias;
    if (opts.autoFocus !== undefined) d.autoFocus = !!opts.autoFocus;
    d.target = d.enabled ? (typeof opts.intensity === 'number' ? clamp01(opts.intensity) : 1) : 0;
    this._syncEnabled();
    return this;
  }

  // ───────────────────────────────────────────────────────────── per frame

  /**
   * @param {number} dt real (unscaled) seconds
   * @param {THREE.Camera} camera
   */
  update(dt, camera) {
    if (!this.composer) return;
    const step = Math.min(Math.max(dt, 0), 0.1);
    this._time += step;

    const p = this.passes;

    // camera can be swapped by the CameraDirector at any time
    if (p.render.camera !== camera) p.render.camera = camera;
    if (p.render.scene !== this.scene) p.render.scene = this.scene;

    // ── smoothed drivers ──
    this._speedSmoothed = damp(this._speedSmoothed, this.speedIntensity, 7, step);
    this._slowMoSmoothed = damp(this._slowMoSmoothed, this.slowMo, 9, step);

    if (this._flash.strength > 0) {
      const k = this._flash.decay * step;
      // exponential body + a linear tail so it always reaches exactly zero
      this._flash.strength = this._flash.strength * Math.exp(-k * 2.6) - k * 0.10;
      if (this._flash.strength < 0.002) this._flash.strength = 0;
    }
    this._fade.amount = damp(this._fade.amount, this._fade.target, this._fade.rate * 2.5, step);

    const speed = this._speedSmoothed;
    const slow = this._slowMoSmoothed;
    // when motion blur is off the speed cue has to come from the lens instead
    const lensBoost = (p.motionBlur && p.motionBlur.enabled) ? 1.0 : 1.55;

    // ── composite uniforms ──
    const cu = p.composite.uniforms;
    cu.uTime.value = this._time;
    cu.uExposure.value = this.exposure;
    cu.uSlowMo.value = slow;
    // These are in UV units and get multiplied by up to ~1.75 toward the corners,
    // so keep them tiny: ~1 px at rest, ~4 px flat out on a 1600 px frame.
    cu.uCA.value = (0.00015 + speed * 0.00090 * lensBoost + slow * 0.00045);
    cu.uDistortion.value = speed * 0.016 * lensBoost;
    cu.uVignette.value = clamp(this._baseVignette() + speed * 0.13 + slow * 0.10, 0, 0.92);
    cu.uFlashColor.value.copy(this._flash.color);
    cu.uFlashStrength.value = this._flash.strength;
    cu.uFade.value = this._fade.amount;
    cu.uFadeColor.value.copy(this._fade.color);
    if (p.bloom && p.bloom.enabled) cu.tBloom.value = p.bloom.texture;

    // ── depth resolve (only worth it if something downstream reads depth) ──
    p.depthResolve.updateCamera(camera);

    // ── AO ──
    if (p.ao.enabled) p.ao.updateCamera(camera);

    // ── motion blur ──
    const pe = camera.projectionMatrix.elements;
    const p00 = pe[0] !== 0 ? pe[0] : 1;
    const p11 = pe[5] !== 0 ? pe[5] : 1;

    const mbu = p.motionBlur.uniforms;
    mbu.uFar.value = camera.far;
    mbu.uProjParams.value.set(1 / p00, 1 / p11);
    mbu.uCamWorld.value.copy(camera.matrixWorld);
    _mat4a.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (this._hasPrev) mbu.uPrevViewProj.value.copy(this._prevViewProj);
    else mbu.uPrevViewProj.value.copy(_mat4a);
    mbu.uStrength.value = 0.55 + speed * 0.35 + slow * 0.5;
    mbu.uRadial.value = speed * speed * 0.030;
    mbu.uMaxVelocity.value = 0.05;

    // ── depth of field ──
    const d = this.dof;
    d.intensity = damp(d.intensity, d.target, 4.0, step);
    if (d.autoFocus && this.game.playerCar) {
      const car = this.game.playerCar;
      const g = car.group;
      if (g) {
        g.getWorldPosition(_v3a);
        camera.getWorldPosition(_v3b);
        const dist = _v3a.distanceTo(_v3b);
        d.focusDistance = damp(d.focusDistance, clamp(dist, 0.2, 60), 5, step);
      }
    }
    const du = p.dof.uniforms;
    du.uFocusDistance.value = d.focusDistance;
    du.uFocusRange.value = d.focusRange;
    du.uNearFalloff.value = d.nearFalloff;
    du.uFarFalloff.value = d.farFalloff;
    du.uMaxBlur.value = d.maxBlur;
    du.uBokehBias.value = d.bokehBias;
    du.uIntensity.value = d.intensity;
    const dofWanted = (this._force.dof === null || this._force.dof === undefined ? this.want.dof : this._force.dof);
    p.dof.enabled = dofWanted && d.intensity > 0.002;

    // Re-wire the depth chain every frame: a resize rebuilds the underlying GPU
    // textures, and nothing downstream should ever hold a stale handle.
    if (this.depthTexture) p.depthResolve.setDepth(this.depthTexture);
    const linear = p.depthResolve.texture;
    p.ao.setDepth(linear);
    mbu.tDepth.value = linear;
    du.tDepth.value = linear;

    // The resolve pass is pure overhead if nothing consumes it.
    p.depthResolve.enabled = p.ao.enabled || p.motionBlur.enabled || p.dof.enabled;
  }

  _baseVignette() {
    return this.want.vignette ? this._vignetteBase : 0;
  }

  /** Render the whole chain. */
  render(dt) {
    const composer = this.composer;
    if (!composer) return;

    // Deterministic buffer parity: the scene must always land in rt1, the one
    // that owns the depth texture.
    composer.readBuffer = composer.renderTarget1;
    composer.writeBuffer = composer.renderTarget2;

    const oldAutoClear = this.renderer.autoClear;
    this.renderer.autoClear = false;
    composer.render(dt);
    this.renderer.autoClear = oldAutoClear;

    // stash this frame's view-projection for next frame's reprojection
    const camera = this.passes.render.camera;
    if (camera) {
      this._prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this._hasPrev = true;
    }
  }

  /** Reset temporal state — call when the camera teleports (cuts, respawn). */
  resetHistory() {
    this._hasPrev = false;
    return this;
  }

  getStats() {
    const p = this.passes;
    return {
      ao: !!p.ao?.enabled,
      motionBlur: !!p.motionBlur?.enabled,
      bloom: !!p.bloom?.enabled,
      dof: !!p.dof?.enabled,
      fxaa: !!p.fxaa?.enabled,
      lut: this.want.lut,
      bloomLevels: p.bloom ? p.bloom.mips.length : 0,
      speed: +this._speedSmoothed.toFixed(2),
      slowMo: +this._slowMoSmoothed.toFixed(2),
    };
  }

  dispose() {
    for (const key in this.passes) this.passes[key]?.dispose?.();
    this.passes = {};
    this._lut?.dispose();
    this._lut = null;
    this.composer?.dispose();
    this.composer = null;
  }
}

export default PostFX;
