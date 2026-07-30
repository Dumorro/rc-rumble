import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { CSMFrustum } from 'three/examples/jsm/csm/CSMFrustum.js';
import CONFIG, { q } from '../core/Config.js';
import { clamp, clamp01, damp } from '../core/MathUtils.js';
import { BLOB_VERT, BLOB_FRAG } from './shaders/BlobShadowShader.js';

/**
 * Scene lighting rig.
 *
 * At 1:10 RC scale the single biggest visual win is shadow resolution *near the
 * car*: the car is 30 cm long, so a naive 2048² map fitted to a 60 m track gives
 * ~3 cm texels and the car casts a grey smudge. So:
 *
 *  • medium/high/ultra → real cascaded shadow maps (three's CSM addon) with
 *    near-biased custom splits. Cascade 0 covers ~1.5 m of frustum, which is
 *    ~1.7 mm per texel at 2048 — about 180 texels across the car. Cascades blend
 *    through a fade band so you never see the switch.
 *  • low → one tight directional shadow that FOLLOWS THE FOCUS (the player car),
 *    texel-snapped in light space so it does not shimmer when the camera moves.
 *
 *  • every car also gets a procedural contact blob underneath, which is what
 *    actually sells "the wheels are touching the floor". Strong on low (where it
 *    is the main grounding cue), subtle everywhere else.
 *
 * All of it is driven by `TrackData.environment`.
 */

// ── module scratch — nothing in update() allocates ────────────────────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _center = new THREE.Vector3();
const _bbox = new THREE.Box3();
const _quat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _matInv = new THREE.Matrix4();
const _camToLight = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3();
const _color = new THREE.Color();
const _lightSpaceFrustum = new CSMFrustum({ webGL: true });

/** Near-biased cascade splits (fractions of maxFar). Tuned for RC scale. */
const CASCADE_BREAKS = {
  2: [0.09, 1.0],
  3: [0.05, 0.17, 1.0],
  4: [0.035, 0.10, 0.30, 1.0],
};

const MAX_FAR = { low: 18, medium: 22, high: 28, ultra: 34 };

const MAX_BLOBS = 8;

export class Lighting {
  /**
   * @param {object} game
   * @param {THREE.Scene} scene
   * @param {import('./Sky.js').Sky} [sky]
   */
  constructor(game, scene, sky = null) {
    this.game = game;
    this.scene = scene;
    this.sky = sky;

    this.quality = CONFIG.quality;
    this.enabled = true;

    /** @type {THREE.Object3D|null} what the shadows follow (usually the player car). */
    this.focus = null;
    this._focusPos = new THREE.Vector3();
    this._focusPrev = new THREE.Vector3();
    this._focusVel = new THREE.Vector3();
    this._hasFocus = false;

    /** Direction the sunlight TRAVELS (from the sky into the scene). */
    this.lightDirection = new THREE.Vector3(-0.45, -0.82, -0.35).normalize();
    this.sunColor = new THREE.Color(0xfff4e2);
    this.sunIntensity = 3.0;
    this.shadowsEnabled = true;

    // ── key light (focus mode) ──
    this.sun = new THREE.DirectionalLight(0xfff4e2, 3.0);
    this.sun.name = 'rc/sun';
    this.sun.castShadow = true;
    this.sun.shadow.camera.near = 0.05;
    this.sun.shadow.camera.far = 60;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.012;
    this.sun.matrixAutoUpdate = true;
    this.sunTarget = new THREE.Object3D();
    this.sunTarget.name = 'rc/sunTarget';
    this.sun.target = this.sunTarget;

    /** Radius (metres) of the low-quality follow shadow box. */
    this.focusRadius = 5.0;
    /** How far ahead of the focus the shadow box is pushed, as a fraction of radius. */
    this.focusLead = 0.32;
    /** Extra depth behind the follow-shadow box (raised from the track bounds). */
    this._shadowExtraFar = 20;

    // ── fill ──
    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x3a3226, 0.35);
    this.hemi.name = 'rc/hemi';

    // A whisper of flat ambient so pure-black crevices still read on low quality
    // where there is no AO and no IBL.
    this.ambient = new THREE.AmbientLight(0xffffff, 0.0);
    this.ambient.name = 'rc/ambient';

    // ── local lights added by tracks ──
    /** @type {THREE.Light[]} */
    this.localLights = [];
    this._localGroup = new THREE.Group();
    this._localGroup.name = 'rc/localLights';

    /** @type {CSM|null} */
    this.csm = null;
    this._csmMaterials = new WeakSet();
    /** @type {THREE.Material[]} materials we patched, so we can un-patch cleanly */
    this._patched = [];
    this._csmScanTimer = 0;
    this._lastFov = 0;
    this._lastAspect = 0;
    this._refitTimer = 0;

    // ── blob shadows ──
    this.blobStrength = 0.5;
    this.blobs = null;
    this._blobData = [];

    // sun animation (tracks can ask for a slowly moving sun)
    this.sunAnimation = null;
    this._sunTime = 0;

    this._installed = false;
  }

  // ───────────────────────────────────────────────────────────── lifecycle

  init() {
    if (this._installed) return this;
    this.scene.add(this.sun);
    this.scene.add(this.sunTarget);
    this.scene.add(this.hemi);
    this.scene.add(this.ambient);
    this.scene.add(this._localGroup);
    this._buildBlobs();
    this._installed = true;
    this.setQuality(this.quality);
    return this;
  }

  /**
   * @param {'low'|'medium'|'high'|'ultra'} level
   */
  setQuality(level) {
    this.quality = level || CONFIG.quality;
    const cascades = Math.max(1, Math.min(4, q(CONFIG.render.shadowCascades, this.quality) | 0));
    let mapSize = q(CONFIG.render.shadowMapSize, this.quality) || 1024;
    // Cap the total shadow footprint: 4 × 4096² depth maps is ~200 MB and no
    // iGPU is surviving that. Cascade 0 is already ~1.7 mm/texel at 2048.
    if (cascades >= 3 && mapSize > 2048) mapSize = 2048;

    this._teardownCsm();

    if (!this.shadowsEnabled) {
      this.sun.castShadow = false;
      this.blobStrength = 0.6;
    } else if (cascades > 1) {
      this._buildCsm(cascades, mapSize);
      this.sun.castShadow = false;
      this.sun.visible = false;
      this.blobStrength = 0.28;
    } else {
      this.sun.visible = true;
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      this.blobStrength = 0.55;
    }

    this._applySunToLights();
    return this;
  }

  /** Turn all shadow casting off (adaptive-quality emergency brake). */
  setShadowsEnabled(on) {
    if (this.shadowsEnabled === !!on) return this;
    this.shadowsEnabled = !!on;
    this.setQuality(this.quality);
    return this;
  }

  // ───────────────────────────────────────────────────────────── environment

  /**
   * Apply `TrackData.environment`. Every field is optional; unknown fields are
   * ignored so tracks can evolve without breaking the renderer.
   *
   * ```js
   * environment: {
   *   sun: { color, intensity, elevation, azimuth, direction:[x,y,z],
   *          castShadow, animate:{ speed, elevationAmplitude } },
   *   ambient: { sky, ground, intensity, flat },
   *   fog: { color, near, far }  |  { color, density }  |  false,
   *   lights: [ { type:'point'|'spot', color, intensity, position, distance,
   *               decay, angle, penumbra, target, castShadow } ],
   *   bounds: THREE.Box3,   // used to size the low-quality follow shadow
   *   scale: 10,
   * }
   * ```
   * @param {object} [env]
   */
  apply(env) {
    const desc = env || {};

    // ── sun ──
    const sun = desc.sun || {};
    if (this.sky) {
      // keep the analytic sky and the key light in lockstep
      const patch = {};
      if (typeof sun.elevation === 'number') patch.sunElevation = sun.elevation;
      if (typeof sun.azimuth === 'number') patch.sunAzimuth = sun.azimuth;
      if (Object.keys(patch).length) this.sky.set(patch);
      this.lightDirection.copy(this.sky.sunDirection).negate();
      _color.copy(this.sky.sunColor);
    } else {
      _color.set(0xfff4e2);
    }

    if (Array.isArray(sun.direction) && sun.direction.length === 3) {
      this.lightDirection.set(sun.direction[0], sun.direction[1], sun.direction[2]);
    } else if (sun.direction && sun.direction.isVector3) {
      this.lightDirection.copy(sun.direction);
    } else if (typeof sun.elevation === 'number' && !this.sky) {
      const az = sun.azimuth ?? 0.7;
      const ch = Math.cos(sun.elevation);
      this.lightDirection.set(ch * Math.sin(az), Math.sin(sun.elevation), -ch * Math.cos(az)).negate();
    }
    if (this.lightDirection.lengthSq() < 1e-8) this.lightDirection.set(-0.45, -0.82, -0.35);
    this.lightDirection.normalize();

    if (sun.color !== undefined) setColor(_color, sun.color);
    this.sunColor.copy(_color);
    // With a full PMREM sky feeding indirect light, the key has to be strong or
    // the whole frame turns into flat ambient mush. ~4.5 puts direct light about
    // 3:1 over indirect, which is where the Re-Volt "toy in real sunlight" pop is.
    this.sunIntensity = typeof sun.intensity === 'number' ? sun.intensity : 4.5;
    if (sun.castShadow !== undefined) this.shadowsEnabled = !!sun.castShadow;

    this.sunAnimation = sun.animate ? {
      speed: sun.animate.speed ?? 0.01,
      elevationAmplitude: sun.animate.elevationAmplitude ?? 0.0,
      baseElevation: this.sky ? this.sky.params.sunElevation : 0.6,
      baseAzimuth: this.sky ? this.sky.params.sunAzimuth : 0.7,
    } : null;
    this._sunTime = 0;

    // ── fill ──
    const amb = desc.ambient || {};
    if (amb.sky !== undefined) setColor(this.hemi.color, amb.sky);
    else if (desc.ambient && desc.ambient.isColor) this.hemi.color.copy(desc.ambient);
    if (amb.ground !== undefined) setColor(this.hemi.groundColor, amb.ground);
    this.hemi.intensity = typeof amb.intensity === 'number' ? amb.intensity : 0.22;
    this.ambient.intensity = typeof amb.flat === 'number' ? amb.flat : 0.0;

    // ── fog ──
    this._applyFog(desc.fog);

    // ── follow-shadow sizing from the track bounds ──
    if (desc.bounds && desc.bounds.isBox3 && !desc.bounds.isEmpty()) {
      desc.bounds.getSize(_v1);
      const span = Math.max(_v1.x, _v1.z);
      this.focusRadius = clamp(span * 0.08, 3.0, 12.0);
      this._shadowExtraFar = clamp(Math.max(_v1.y, 2) * 2 + 12, 12, 90);
    }

    // ── local lights ──
    this.clearLocalLights();
    if (Array.isArray(desc.lights)) {
      for (let i = 0; i < desc.lights.length; i++) this.addLight(desc.lights[i]);
    }

    this._applySunToLights();
    return this;
  }

  _applyFog(fog) {
    if (fog === false || fog === null) { this.scene.fog = null; return; }
    if (fog === undefined) return;
    if (fog.isFog || fog.isFogExp2) { this.scene.fog = fog; return; }

    const col = setColor(_color, fog.color ?? 0xc8d6e6).getHex();
    if (typeof fog.density === 'number') {
      if (this.scene.fog && this.scene.fog.isFogExp2) {
        this.scene.fog.color.setHex(col);
        this.scene.fog.density = fog.density;
      } else {
        this.scene.fog = new THREE.FogExp2(col, fog.density);
      }
    } else {
      const near = fog.near ?? 12;
      const far = fog.far ?? 90;
      if (this.scene.fog && this.scene.fog.isFog) {
        this.scene.fog.color.setHex(col);
        this.scene.fog.near = near;
        this.scene.fog.far = far;
      } else {
        this.scene.fog = new THREE.Fog(col, near, far);
      }
    }
  }

  /**
   * Add a local point/spot light. Tracks call this (or list them in
   * `environment.lights`) for lamps, fridge glow, headlights on scenery, etc.
   * @param {object} desc
   * @returns {THREE.Light|null}
   */
  addLight(desc) {
    if (!desc) return null;
    if (desc.isLight) {
      this._localGroup.add(desc);
      this.localLights.push(desc);
      return desc;
    }

    const type = desc.type === 'spot' ? 'spot' : 'point';
    const color = setColor(_color, desc.color ?? 0xffffff).getHex();
    const intensity = desc.intensity ?? 1;
    const distance = desc.distance ?? 6;
    const decay = desc.decay ?? 2;

    let light;
    if (type === 'spot') {
      light = new THREE.SpotLight(color, intensity, distance, desc.angle ?? 0.6, desc.penumbra ?? 0.4, decay);
      if (desc.target) {
        light.target.position.fromArray(toArray(desc.target));
        this._localGroup.add(light.target);
      }
    } else {
      light = new THREE.PointLight(color, intensity, distance, decay);
    }

    if (desc.position) light.position.fromArray(toArray(desc.position));

    // shadow-casting local lights are expensive (a cube render for points);
    // allow at most two, high quality only.
    const shadowBudget = (this.quality === 'high' || this.quality === 'ultra') ? 2 : 0;
    const casting = this.localLights.reduce((n, l) => n + (l.castShadow ? 1 : 0), 0);
    if (desc.castShadow && casting < shadowBudget && this.shadowsEnabled) {
      light.castShadow = true;
      const s = desc.shadowMapSize ?? 512;
      light.shadow.mapSize.set(s, s);
      light.shadow.bias = -0.002;
      light.shadow.normalBias = 0.02;
      light.shadow.camera.near = 0.05;
      light.shadow.camera.far = Math.max(distance, 1);
    }

    this._localGroup.add(light);
    this.localLights.push(light);
    return light;
  }

  removeLight(light) {
    const i = this.localLights.indexOf(light);
    if (i >= 0) this.localLights.splice(i, 1);
    if (light.target && light.target.parent === this._localGroup) this._localGroup.remove(light.target);
    this._localGroup.remove(light);
    light.dispose?.();
  }

  clearLocalLights() {
    for (let i = this.localLights.length - 1; i >= 0; i--) {
      const l = this.localLights[i];
      if (l.target && l.target.parent === this._localGroup) this._localGroup.remove(l.target);
      this._localGroup.remove(l);
      l.dispose?.();
    }
    this.localLights.length = 0;
  }

  /** @param {THREE.Object3D|null} object3D */
  setFocus(object3D) {
    this.focus = object3D || null;
    this._hasFocus = false;
    return this;
  }

  // ───────────────────────────────────────────────────────────── per frame

  /**
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this.enabled || !this._installed) return;

    if (this.sunAnimation) this._animateSun(dt);
    this._trackFocus(dt);

    const camera = this.game?.camera;

    if (this.csm) {
      this._updateCsm(camera, dt);
    } else if (this.sun.castShadow) {
      this._updateFocusShadow();
    } else {
      // no shadows: still point the light correctly
      this.sun.position.copy(this._focusPos).addScaledVector(this.lightDirection, -20);
      this.sunTarget.position.copy(this._focusPos);
    }

    this._updateBlobs(dt);
  }

  _animateSun(dt) {
    const a = this.sunAnimation;
    this._sunTime += dt;
    const az = a.baseAzimuth + this._sunTime * a.speed;
    const el = a.baseElevation + Math.sin(this._sunTime * a.speed * 0.5) * a.elevationAmplitude;
    if (this.sky) {
      this.sky.setSunAngles(clamp(el, 0.03, 1.55), az);
      this.lightDirection.copy(this.sky.sunDirection).negate();
      this.sunColor.copy(this.sky.sunColor);
      this._applySunToLights();
    }
  }

  _trackFocus(dt) {
    if (!this.focus) {
      // fall back to the camera so shadows still land somewhere sensible
      const cam = this.game?.camera;
      if (cam) {
        cam.getWorldPosition(_v1);
        cam.getWorldDirection(_v2);
        _v1.addScaledVector(_v2, 3.0);
        this._focusPos.copy(_v1);
      }
      this._focusVel.set(0, 0, 0);
      this._hasFocus = false;
      return;
    }

    this.focus.getWorldPosition(_v1);
    if (!this._hasFocus) {
      this._focusPos.copy(_v1);
      this._focusPrev.copy(_v1);
      this._focusVel.set(0, 0, 0);
      this._hasFocus = true;
      return;
    }

    if (dt > 1e-5) {
      _v2.subVectors(_v1, this._focusPrev).divideScalar(dt);
      const k = 1 - Math.exp(-6 * dt);
      this._focusVel.lerp(_v2, k);
    }
    this._focusPrev.copy(_v1);
    this._focusPos.copy(_v1);
  }

  // ───────────────────────────────────────────────── single follow shadow

  /**
   * Fit one tight ortho box around the focus and snap it to the shadow-map texel
   * grid in light space. Without the snap the shadow edges crawl and shimmer
   * every time the chase camera moves — very visible on a 30 cm car.
   */
  _updateFocusShadow() {
    const R = this.focusRadius;
    const shadow = this.sun.shadow;
    const cam = shadow.camera;

    // lead the box in the direction of travel so the road ahead is shadowed
    _v1.copy(this._focusPos);
    const speed = this._focusVel.length();
    if (speed > 0.2) {
      _v2.copy(this._focusVel).multiplyScalar(1 / speed);
      _v1.addScaledVector(_v2, R * this.focusLead);
    }

    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
    const back = R * 2.5 + 12;
    cam.near = 0.05;
    cam.far = back + R * 2 + (this._shadowExtraFar ?? 20);

    // light-space basis: +Z points toward the sun
    _mat.lookAt(_zero, this.lightDirection, _up);
    _matInv.copy(_mat).invert();

    const mapSize = shadow.mapSize.x || 1024;
    const texel = (2 * R) / mapSize;

    _v1.applyMatrix4(_matInv);
    _v1.x = Math.round(_v1.x / texel) * texel;
    _v1.y = Math.round(_v1.y / texel) * texel;
    _v1.z += back;
    _v1.applyMatrix4(_mat);

    this.sun.position.copy(_v1);
    this.sunTarget.position.copy(_v1).add(this.lightDirection);
    this.sunTarget.updateMatrixWorld();

    shadow.normalBias = clamp(texel * 1.4, 0.004, 0.06);
    shadow.bias = -clamp(texel * 0.08, 0.00015, 0.002);
    cam.updateProjectionMatrix();
  }

  // ───────────────────────────────────────────────── cascaded shadow maps

  _buildCsm(cascades, mapSize) {
    const maxFar = MAX_FAR[this.quality] ?? 28;
    const breaks = CASCADE_BREAKS[cascades] || CASCADE_BREAKS[3];

    this.csm = new CSM({
      camera: this.game?.camera ?? new THREE.PerspectiveCamera(),
      parent: this.scene,
      cascades,
      maxFar,
      mode: 'custom',
      customSplitsCallback: (amount, near, far, target) => {
        target.length = 0;
        for (let i = 0; i < amount; i++) target.push(breaks[i] ?? (i + 1) / amount);
      },
      shadowMapSize: mapSize,
      shadowBias: -0.0004,
      lightDirection: this.lightDirection.clone(),
      lightIntensity: this.sunIntensity,
      lightNear: 0.05,
      lightFar: 160,
      lightMargin: 30,
    });
    this.csm.fade = true;
    this.csm.updateFrustums();

    for (const l of this.csm.lights) {
      l.name = 'rc/csmCascade';
      l.shadow.camera.near = 0.05;
      l.shadow.camera.far = 160;
    }

    this._csmMaterials = new WeakSet();
    this._patched = [];
    this._csmScanTimer = 0;
    this.scanMaterials(true);
  }

  _teardownCsm() {
    if (!this.csm) return;
    try {
      this.csm.remove();
      this.csm.dispose();
    } catch (err) {
      console.warn('[Lighting] CSM teardown failed:', err);
    }
    // CSM.dispose() deletes onBeforeCompile outright, which would throw away a
    // hook the Materials system installed. Put anything we displaced back.
    for (let i = 0; i < this._patched.length; i++) {
      const mat = this._patched[i];
      const prev = mat.userData ? mat.userData.__rcPrevOBC : null;
      if (prev) mat.onBeforeCompile = prev;
      if (mat.userData) delete mat.userData.__rcPrevOBC;
      mat.needsUpdate = true;
    }
    this._patched.length = 0;
    this._csmMaterials = new WeakSet();
    this.csm = null;
  }

  /**
   * CSM only affects materials it has been told about. Tracks, cars, props and
   * FX are all built by other systems, so we sweep the graph and patch anything
   * lit that we have not seen before. Cheap (a WeakSet lookup per material) and
   * throttled — but call it directly after you add a big batch of geometry.
   *
   * @param {boolean} [force] ignore the throttle
   */
  scanMaterials(force = false) {
    const csm = this.csm;
    if (!csm || !this.scene) return 0;
    let patched = 0;

    // NOTE: every lit material must be patched, not just shadow receivers —
    // CSM runs N full-intensity directional lights and the shader picks one per
    // cascade. An unpatched lit material would be lit N times over.
    this.scene.traverse((obj) => {
      const mat = obj.material;
      if (!mat) return;
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i++) patched += this._patchMaterial(mat[i]) ? 1 : 0;
      } else {
        patched += this._patchMaterial(mat) ? 1 : 0;
      }
    });

    if (force && patched > 0 && CONFIG.debug) {
      console.log(`[Lighting] CSM patched ${patched} material(s)`);
    }
    return patched;
  }

  _patchMaterial(mat) {
    if (!mat || this._csmMaterials.has(mat)) return false;
    // only the lit materials go through lights_fragment_begin
    const lit = mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial
      || mat.isMeshPhongMaterial || mat.isMeshLambertMaterial || mat.isMeshToonMaterial;
    if (!lit) { this._csmMaterials.add(mat); return false; }

    this._csmMaterials.add(mat);

    // Compose with any onBeforeCompile the material already had — Materials.js
    // is owned by another system and we must not clobber its hooks.
    const prev = (typeof mat.onBeforeCompile === 'function'
      && mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile)
      ? mat.onBeforeCompile : null;

    try {
      this.csm.setupMaterial(mat);
    } catch (err) {
      console.warn('[Lighting] CSM setupMaterial failed:', err);
      return false;
    }

    const csmHook = mat.onBeforeCompile;
    if (prev && prev !== csmHook) {
      mat.userData = mat.userData || {};
      mat.userData.__rcPrevOBC = prev;
      mat.onBeforeCompile = function (shader, renderer) {
        csmHook.call(this, shader, renderer);
        prev.call(this, shader, renderer);
      };
    }

    this._patched.push(mat);
    mat.needsUpdate = true;
    return true;
  }

  /**
   * Allocation-free replacement for CSM.update(): fits every cascade to its
   * frustum slice in light space and texel-snaps it.
   */
  _updateCsm(camera, dt) {
    const csm = this.csm;
    if (!csm || !camera) return;

    if (csm.camera !== camera) {
      csm.camera = camera;
      csm.updateFrustums();
      this._lastFov = camera.fov ?? 0;
      this._lastAspect = camera.aspect ?? 0;
    }

    // The chase cam animates FOV with speed; re-fit the cascade shapes when the
    // projection has drifted enough to matter (throttled — it is not free).
    this._refitTimer -= dt;
    if (this._refitTimer <= 0) {
      const fov = camera.fov ?? 0;
      const aspect = camera.aspect ?? 0;
      if (Math.abs(fov - this._lastFov) > 0.6 || Math.abs(aspect - this._lastAspect) > 0.01) {
        this._lastFov = fov;
        this._lastAspect = aspect;
        csm.updateFrustums();
      }
      this._refitTimer = 0.12;
    }

    // periodic sweep so late-spawned meshes (weapons, debris) get CSM too
    this._csmScanTimer -= dt;
    if (this._csmScanTimer <= 0) {
      this._csmScanTimer = 0.75;
      this.scanMaterials(false);
    }

    _mat.lookAt(_zero, csm.lightDirection, _up);
    _matInv.copy(_mat).invert();

    const frustums = csm.frustums;
    for (let i = 0; i < frustums.length; i++) {
      const light = csm.lights[i];
      const shadowCam = light.shadow.camera;
      const texelWidth = (shadowCam.right - shadowCam.left) / csm.shadowMapSize;
      const texelHeight = (shadowCam.top - shadowCam.bottom) / csm.shadowMapSize;

      _camToLight.multiplyMatrices(_matInv, camera.matrixWorld);
      frustums[i].toSpace(_camToLight, _lightSpaceFrustum);

      const nearVerts = _lightSpaceFrustum.vertices.near;
      const farVerts = _lightSpaceFrustum.vertices.far;
      _bbox.makeEmpty();
      for (let j = 0; j < 4; j++) {
        _bbox.expandByPoint(nearVerts[j]);
        _bbox.expandByPoint(farVerts[j]);
      }
      _bbox.getCenter(_center);
      _center.z = _bbox.max.z + csm.lightMargin;
      _center.x = Math.floor(_center.x / texelWidth) * texelWidth;
      _center.y = Math.floor(_center.y / texelHeight) * texelHeight;
      _center.applyMatrix4(_mat);

      light.position.copy(_center);
      light.target.position.copy(_center).add(csm.lightDirection);

      // bias scaled to this cascade's texel size — cascade 0 is ~1.7 mm/texel,
      // the last one is centimetres, so one global bias cannot work
      light.shadow.normalBias = clamp(texelWidth * 1.3, 0.0025, 0.08);
      light.shadow.bias = -clamp(texelWidth * 0.06, 0.0001, 0.0025);
    }
  }

  // ───────────────────────────────────────────────────────── blob shadows

  _buildBlobs() {
    // A plain XY quad spanning [-1,1]: the shader reads position.xy directly as
    // its footprint coordinate, and the instance matrix rotates it flat onto the
    // contact plane (local +Z becomes the ground normal).
    const geo = new THREE.PlaneGeometry(2, 2, 1, 1);

    const opacity = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BLOBS), 1);
    const squash = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BLOBS).fill(1), 1);
    opacity.setUsage(THREE.DynamicDrawUsage);
    squash.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aOpacity', opacity);
    geo.setAttribute('aSquash', squash);

    const mat = new THREE.ShaderMaterial({
      name: 'rc/blobShadow',
      vertexShader: BLOB_VERT,
      fragmentShader: BLOB_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(0x0b0d12) },
        uHardness: { value: 1.15 },
      },
      transparent: true,
      blending: THREE.MultiplyBlending,
      // three's MultiplyBlending path is (DST_COLOR, ONE_MINUS_SRC_ALPHA), which
      // only reduces to a plain multiply when premultipliedAlpha is set and the
      // shader writes alpha = 1. It hard-errors otherwise.
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.blobs = new THREE.InstancedMesh(geo, mat, MAX_BLOBS);
    this.blobs.name = 'rc/blobShadows';
    this.blobs.frustumCulled = false;
    this.blobs.castShadow = false;
    this.blobs.receiveShadow = false;
    this.blobs.renderOrder = 5;
    this.blobs.count = 0;
    this.blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.blobs);

    for (let i = 0; i < MAX_BLOBS; i++) {
      this._blobData.push({ groundY: 0, normal: new THREE.Vector3(0, 1, 0), valid: false, fade: 0 });
    }
  }

  _updateBlobs(dt) {
    const blobs = this.blobs;
    if (!blobs) return;
    const cars = this.game?.cars;
    if (!cars || cars.length === 0 || this.blobStrength <= 0.001) {
      blobs.count = 0;
      blobs.visible = false;
      return;
    }

    const opacityAttr = blobs.geometry.getAttribute('aOpacity');
    const squashAttr = blobs.geometry.getAttribute('aSquash');
    let n = 0;

    const count = Math.min(cars.length, MAX_BLOBS);
    for (let i = 0; i < count; i++) {
      const car = cars[i];
      if (!car) continue;
      const data = this._blobData[i];

      // ── find the ground plane under this car ──
      let contacts = 0;
      _v1.set(0, 0, 0);
      _v2.set(0, 0, 0);
      const wheels = car.wheels;
      if (wheels) {
        for (let w = 0; w < wheels.length; w++) {
          const wheel = wheels[w];
          if (!wheel || !wheel.contact || !wheel.contactPoint) continue;
          _v1.add(wheel.contactPoint);
          if (wheel.contactNormal) _v2.add(wheel.contactNormal);
          contacts++;
        }
      }

      if (contacts > 0) {
        _v1.divideScalar(contacts);
        data.groundY = _v1.y;
        if (_v2.lengthSq() > 1e-6) data.normal.copy(_v2).normalize();
        else data.normal.set(0, 1, 0);
        data.valid = true;
      }
      if (!data.valid) continue;

      // ── car transform (visual, interpolated) ──
      const group = car.group;
      if (!group) continue;
      group.getWorldPosition(_v3);
      group.getWorldQuaternion(_quat);

      const height = Math.max(_v3.y - data.groundY, 0);
      const fadeTarget = clamp01(1 - height / 1.1);
      data.fade = dt > 0 ? damp(data.fade, fadeTarget, 12, dt) : fadeTarget;
      if (data.fade < 0.02) continue;

      // ── orient: local +Z = ground normal, local +Y = car forward in-plane ──
      _v4.set(0, 0, -1).applyQuaternion(_quat);
      _v4.addScaledVector(data.normal, -_v4.dot(data.normal));
      if (_v4.lengthSq() < 1e-6) _v4.set(0, 0, -1);
      _v4.normalize();
      _v2.crossVectors(_v4, data.normal).normalize();   // right ( f × n )

      _mat.makeBasis(_v2, _v4, data.normal);
      _quat.setFromRotationMatrix(_mat);

      // spread as the car lifts off, like a real penumbra
      const spread = 1 + height * 1.35;
      _scale.set(0.30 * spread, 0.44 * spread, 1);

      _v1.set(_v3.x, data.groundY, _v3.z).addScaledVector(data.normal, 0.005);
      _mat.compose(_v1, _quat, _scale);
      blobs.setMatrixAt(n, _mat);

      opacityAttr.setX(n, this.blobStrength * data.fade);
      squashAttr.setX(n, clamp01(1.15 - height * 0.45));
      n++;
    }

    blobs.count = n;
    blobs.visible = n > 0;
    if (n > 0) {
      blobs.instanceMatrix.needsUpdate = true;
      opacityAttr.needsUpdate = true;
      squashAttr.needsUpdate = true;
    }
  }

  // ───────────────────────────────────────────────────────────── helpers

  _applySunToLights() {
    this.sun.color.copy(this.sunColor);
    this.sun.intensity = this.sunIntensity;
    if (this.csm) {
      this.csm.lightDirection.copy(this.lightDirection);
      this.csm.lightIntensity = this.sunIntensity;
      for (const l of this.csm.lights) {
        l.color.copy(this.sunColor);
        l.intensity = this.sunIntensity;
      }
    }
  }

  /** Nudge the key light without rebuilding anything. */
  setSun(color, intensity, direction) {
    if (color !== undefined) setColor(this.sunColor, color);
    if (typeof intensity === 'number') this.sunIntensity = intensity;
    if (direction) {
      if (direction.isVector3) this.lightDirection.copy(direction);
      else this.lightDirection.fromArray(toArray(direction));
      this.lightDirection.normalize();
    }
    this._applySunToLights();
    return this;
  }

  getStats() {
    return {
      mode: this.csm ? `csm:${this.csm.cascades}` : (this.sun.castShadow ? 'focus' : 'none'),
      shadowMapSize: this.csm ? this.csm.shadowMapSize : this.sun.shadow.mapSize.x,
      localLights: this.localLights.length,
      blobs: this.blobs ? this.blobs.count : 0,
    };
  }

  dispose() {
    this._teardownCsm();
    this.clearLocalLights();
    if (this.blobs) {
      this.scene.remove(this.blobs);
      this.blobs.geometry.dispose();
      this.blobs.material.dispose();
      this.blobs.dispose();
      this.blobs = null;
    }
    this.scene.remove(this.sun);
    this.scene.remove(this.sunTarget);
    this.scene.remove(this.hemi);
    this.scene.remove(this.ambient);
    this.scene.remove(this._localGroup);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.sun.dispose?.();
    this.hemi.dispose?.();
    this.ambient.dispose?.();
    this._installed = false;
  }
}

function setColor(target, value) {
  if (value === undefined || value === null) return target;
  if (value.isColor) return target.copy(value);
  if (Array.isArray(value)) return target.setRGB(value[0], value[1], value[2]);
  return target.set(value);
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v && v.isVector3) return [v.x, v.y, v.z];
  return [0, 0, 0];
}

export default Lighting;
