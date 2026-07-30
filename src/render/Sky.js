import * as THREE from 'three';
import { SKY_VERT, SKY_FRAG } from './shaders/SkyShader.js';

/**
 * Procedural sky — 100% shader, zero textures.
 *
 * Two modes:
 *   'outdoor' — Preetham analytic daylight (turbidity / rayleigh / mie) with a
 *               sun disc, horizon haze and a ground-bounce hemisphere.
 *   'indoor'  — soft studio/room gradient with a grid of ceiling light panels
 *               (museum halls, supermarket aisles, a garage at night…).
 *
 * The same material feeds two consumers:
 *   • `mesh`   — a camera-locked sky box rendered at full screen resolution, so
 *                the gradient is analytic and never banded or blocky.
 *   • `cubeRT` — a small cube render target used as the PMREM source for IBL.
 *
 * Nothing here allocates per frame.
 */

const _color = new THREE.Color();

/** Named starting points. Tracks override any subset via `TrackData.environment.skybox`. */
export const SKY_PRESETS = {
  /** Bright mid-morning garden / rooftop. */
  day: {
    mode: 'outdoor',
    turbidity: 3.0,
    rayleigh: 3.0,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.76,
    sunElevation: 0.62,
    sunAzimuth: 0.7,
    sunIntensity: 1.0,
    exposure: 1.0,
    tint: 0xffffff,
    groundColor: 0x6d7a5a,
    groundBounce: 0.55,
    horizonColor: 0xbfd4e8,
    horizonHaze: 0.22,
  },
  /** Low warm sun, long shadows — the "golden hour" track dressing. */
  sunset: {
    mode: 'outdoor',
    turbidity: 5.5,
    rayleigh: 3.4,
    mieCoefficient: 0.014,
    mieDirectionalG: 0.86,
    sunElevation: 0.14,
    sunAzimuth: 2.1,
    sunIntensity: 1.05,
    exposure: 1.0,
    tint: 0xffe8d2,
    groundColor: 0x5a4a3a,
    groundBounce: 0.6,
    horizonColor: 0xffb27a,
    horizonHaze: 0.45,
  },
  /** Overcast: flat, high turbidity, weak sun — good for a wet supermarket car park. */
  overcast: {
    mode: 'outdoor',
    turbidity: 9.0,
    rayleigh: 1.2,
    mieCoefficient: 0.03,
    mieDirectionalG: 0.72,
    sunElevation: 0.5,
    sunAzimuth: 1.0,
    sunIntensity: 0.8,
    exposure: 1.0,
    tint: 0xdfe6ee,
    groundColor: 0x67707a,
    groundBounce: 0.5,
    horizonColor: 0xc8d2dc,
    horizonHaze: 0.55,
  },
  /** Warm wooden museum hall. */
  museum: {
    mode: 'indoor',
    sunElevation: 0.85,
    sunAzimuth: 0.45,
    sunIntensity: 1.0,
    exposure: 1.0,
    tint: 0xffffff,
    ceilingColor: 0x2b2a2f,
    wallColor: 0x5a4c3c,
    floorColor: 0x3a2c20,
    panelColor: 0xfff0d6,
    panelIntensity: 6.0,
    panelSpacing: 7.0,
    panelSize: 0.85,
    panelSoftness: 0.5,
    roomHeight: 7.0,
    cornerDarken: 0.32,
  },
  /** Cold fluorescent supermarket. */
  supermarket: {
    mode: 'indoor',
    sunElevation: 1.1,
    sunAzimuth: 0.0,
    sunIntensity: 1.0,
    exposure: 1.0,
    tint: 0xffffff,
    ceilingColor: 0x33383e,
    wallColor: 0x77808c,
    floorColor: 0x565d66,
    panelColor: 0xe8f2ff,
    panelIntensity: 9.0,
    panelSpacing: 5.0,
    panelSize: 0.5,
    panelSoftness: 0.35,
    roomHeight: 6.0,
    cornerDarken: 0.22,
  },
  /** Neutral product-shot studio — menus and the car-select turntable. */
  studio: {
    mode: 'indoor',
    sunElevation: 0.95,
    sunAzimuth: 0.6,
    sunIntensity: 1.0,
    exposure: 1.0,
    tint: 0xffffff,
    ceilingColor: 0x20242a,
    wallColor: 0x4a5058,
    floorColor: 0x2a2e34,
    panelColor: 0xffffff,
    panelIntensity: 8.0,
    panelSpacing: 9.0,
    panelSize: 1.6,
    panelSoftness: 0.75,
    roomHeight: 8.0,
    cornerDarken: 0.38,
  },
};

const DEFAULTS = {
  mode: 'outdoor',
  turbidity: 3.0,
  rayleigh: 3.0,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.76,
  sunElevation: 0.62,
  sunAzimuth: 0.7,
  sunIntensity: 1.0,
  exposure: 1.0,
  tint: 0xffffff,
  /** Maps raw Preetham luminance into our ACES exposure range. See SkyShader. */
  skyScale: 0.012,
  /** Ceiling on the sun disc's linear radiance — high enough to bloom hard, low
   *  enough that the PMREM specular highlight does not turn everything white. */
  sunDiscClamp: 40.0,
  sunAngularDiameter: 0.0095,   // ~0.55°, a touch fatter than reality so it blooms
  groundColor: 0x6d7a5a,
  groundBounce: 0.55,
  horizonColor: 0xbfd4e8,
  horizonHaze: 0.22,
  ceilingColor: 0x24272c,
  wallColor: 0x555c66,
  floorColor: 0x30343a,
  panelColor: 0xffffff,
  panelIntensity: 7.0,
  panelSpacing: 7.0,
  panelSize: 0.9,
  panelSoftness: 0.5,
  roomHeight: 7.0,
  cornerDarken: 0.3,
};

export class Sky {
  /**
   * @param {{cubeSize?:number}} [opts]
   */
  constructor(opts = {}) {
    this.params = { ...DEFAULTS };
    this.cubeSize = opts.cubeSize ?? 256;

    /** World-space direction *toward* the sun. Lighting reads this. */
    this.sunDirection = new THREE.Vector3(0, 1, 0);
    /** Approximate linear radiance of the sun disc, used to scale the key light. */
    this.sunColor = new THREE.Color(1, 1, 1);

    this.material = new THREE.ShaderMaterial({
      name: 'rc/sky',
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
      uniforms: {
        uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
        uSunIntensity: { value: 1 },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uExposure: { value: 1 },

        uTurbidity: { value: DEFAULTS.turbidity },
        uRayleigh: { value: DEFAULTS.rayleigh },
        uMieCoefficient: { value: DEFAULTS.mieCoefficient },
        uMieDirectionalG: { value: DEFAULTS.mieDirectionalG },
        uSkyScale: { value: DEFAULTS.skyScale },
        uSunDiscClamp: { value: DEFAULTS.sunDiscClamp },
        uSunAngularDiameterCos: { value: Math.cos(DEFAULTS.sunAngularDiameter) },
        uGroundColor: { value: new THREE.Color(DEFAULTS.groundColor) },
        uGroundBounce: { value: DEFAULTS.groundBounce },
        uHorizonColor: { value: new THREE.Color(DEFAULTS.horizonColor) },
        uHorizonHaze: { value: DEFAULTS.horizonHaze },

        uCeilingColor: { value: new THREE.Color(DEFAULTS.ceilingColor) },
        uWallColor: { value: new THREE.Color(DEFAULTS.wallColor) },
        uFloorColor: { value: new THREE.Color(DEFAULTS.floorColor) },
        uPanelColor: { value: new THREE.Color(DEFAULTS.panelColor) },
        uPanelIntensity: { value: DEFAULTS.panelIntensity },
        uPanelSpacing: { value: DEFAULTS.panelSpacing },
        uPanelSize: { value: DEFAULTS.panelSize },
        uPanelSoftness: { value: DEFAULTS.panelSoftness },
        uRoomHeight: { value: DEFAULTS.roomHeight },
        uCornerDarken: { value: DEFAULTS.cornerDarken },
      },
    });

    this.geometry = new THREE.BoxGeometry(2, 2, 2);

    /** Camera-locked sky box for the main scene. Add it to the scene once. */
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'rc/skybox';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
    this.mesh.renderOrder = -1000;
    this.mesh.onBeforeRender = function (renderer, scene, camera) {
      // lock to the camera without touching the transform hierarchy
      this.matrixWorld.copyPosition(camera.matrixWorld);
    };

    // Separate origin-centred copy used for the cube capture (PMREM source).
    this._cubeScene = new THREE.Scene();
    this._cubeMesh = new THREE.Mesh(this.geometry, this.material);
    this._cubeMesh.frustumCulled = false;
    this._cubeScene.add(this._cubeMesh);

    this.cubeRT = new THREE.WebGLCubeRenderTarget(this.cubeSize, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.cubeRT.texture.name = 'rc/skyCube';

    this.cubeCamera = new THREE.CubeCamera(0.05, 8, this.cubeRT);

    this._dirty = true;
    this._captured = false;

    this.set(this.params);
  }

  /** The cube texture produced by the last capture (PMREM / background source). */
  get texture() { return this.cubeRT.texture; }

  /** True if a parameter changed since the last capture. */
  get needsCapture() { return this._dirty || !this._captured; }

  /** @param {'outdoor'|'indoor'} mode */
  setMode(mode) {
    if (mode !== 'indoor' && mode !== 'outdoor') mode = 'outdoor';
    this.params.mode = mode;
    const wants = mode === 'indoor';
    const has = this.material.defines && 'SKY_INDOOR' in this.material.defines;
    if (wants && !has) {
      this.material.defines = { ...(this.material.defines || {}), SKY_INDOOR: '' };
      this.material.needsUpdate = true;
    } else if (!wants && has) {
      const d = { ...this.material.defines };
      delete d.SKY_INDOOR;
      this.material.defines = d;
      this.material.needsUpdate = true;
    }
    this._dirty = true;
    return this;
  }

  /**
   * Apply a preset by name and/or a parameter patch. Unknown keys are ignored.
   * @param {string|object} preset
   * @param {object} [patch]
   */
  applyPreset(preset, patch) {
    const base = typeof preset === 'string' ? SKY_PRESETS[preset] : preset;
    this.params = { ...DEFAULTS, ...(base || {}), ...(patch || {}) };
    return this.set(this.params);
  }

  /**
   * Patch sky parameters. See DEFAULTS for the accepted keys.
   * @param {object} p
   */
  set(p = {}) {
    const params = this.params;
    for (const k in p) if (p[k] !== undefined) params[k] = p[k];

    if (p.mode !== undefined) this.setMode(params.mode);

    const u = this.material.uniforms;

    // sun direction from elevation/azimuth (azimuth 0 = -Z, the track "forward")
    const el = params.sunElevation;
    const az = params.sunAzimuth;
    const ch = Math.cos(el);
    this.sunDirection.set(ch * Math.sin(az), Math.sin(el), -ch * Math.cos(az));
    if (this.sunDirection.lengthSq() < 1e-8) this.sunDirection.set(0, 1, 0);
    this.sunDirection.normalize();
    u.uSunDirection.value.copy(this.sunDirection);

    u.uSunIntensity.value = params.sunIntensity;
    u.uExposure.value = params.exposure;
    setColor(u.uTint.value, params.tint);

    u.uTurbidity.value = params.turbidity;
    u.uRayleigh.value = params.rayleigh;
    u.uMieCoefficient.value = params.mieCoefficient;
    u.uMieDirectionalG.value = params.mieDirectionalG;
    u.uSkyScale.value = params.skyScale;
    u.uSunDiscClamp.value = params.sunDiscClamp;
    u.uSunAngularDiameterCos.value = Math.cos(params.sunAngularDiameter);
    setColor(u.uGroundColor.value, params.groundColor);
    u.uGroundBounce.value = params.groundBounce;
    setColor(u.uHorizonColor.value, params.horizonColor);
    u.uHorizonHaze.value = params.horizonHaze;

    setColor(u.uCeilingColor.value, params.ceilingColor);
    setColor(u.uWallColor.value, params.wallColor);
    setColor(u.uFloorColor.value, params.floorColor);
    setColor(u.uPanelColor.value, params.panelColor);
    u.uPanelIntensity.value = params.panelIntensity;
    u.uPanelSpacing.value = params.panelSpacing;
    u.uPanelSize.value = params.panelSize;
    u.uPanelSoftness.value = params.panelSoftness;
    u.uRoomHeight.value = params.roomHeight;
    u.uCornerDarken.value = params.cornerDarken;

    this._updateSunColor();
    this._dirty = true;
    return this;
  }

  /** Convenience for a moving sun. Angles in radians. */
  setSunAngles(elevation, azimuth) {
    return this.set({ sunElevation: elevation, sunAzimuth: azimuth });
  }

  /**
   * Cheap CPU approximation of the sun's colour at the current elevation, so the
   * directional key light matches the sky without reading back the GPU.
   */
  _updateSunColor() {
    const p = this.params;
    if (p.mode === 'indoor') {
      _color.set(p.panelColor);
      this.sunColor.copy(_color);
      return;
    }
    // Rayleigh extinction through an air mass that grows as the sun drops.
    const h = Math.max(this.sunDirection.y, 0.0);
    const airMass = 1.0 / Math.max(h + 0.05, 0.05);
    const t = Math.min(p.turbidity, 12) * 0.06;
    const r = Math.exp(-0.0090 * airMass * (1.0 + t));
    const g = Math.exp(-0.0250 * airMass * (1.0 + t));
    const b = Math.exp(-0.0520 * airMass * (1.0 + t));
    const m = Math.max(r, Math.max(g, b)) || 1;
    this.sunColor.setRGB(r / m, g / m, b / m);
    _color.set(p.tint);
    this.sunColor.multiply(_color);
  }

  /**
   * Re-capture the cube render target if anything changed.
   * @param {THREE.WebGLRenderer} renderer
   * @param {boolean} [force]
   * @returns {boolean} true if a capture happened this call
   */
  render(renderer, force = false) {
    if (!renderer) return false;
    if (!force && !this.needsCapture) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    this.cubeCamera.update(renderer, this._cubeScene);
    renderer.xr.enabled = prevXr;
    renderer.setRenderTarget(prevTarget);

    this._dirty = false;
    this._captured = true;
    return true;
  }

  dispose() {
    this.material.dispose();
    this.geometry.dispose();
    this.cubeRT.dispose();
    this.mesh.onBeforeRender = () => {};
    this._cubeScene.remove(this._cubeMesh);
  }
}

/** Accepts a THREE.Color, hex number, css string or [r,g,b]. */
function setColor(target, value) {
  if (value === undefined || value === null) return target;
  if (value.isColor) return target.copy(value);
  if (Array.isArray(value)) return target.setRGB(value[0], value[1], value[2]);
  return target.set(value);
}

export default Sky;
