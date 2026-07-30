import * as THREE from 'three';

/**
 * Runtime IBL.
 *
 * Renders the procedural {@link Sky} into a cube target and pre-filters it with
 * three's PMREMGenerator, then hands the result to `scene.environment`. That is
 * what makes a shiny plastic toy car read as *plastic* rather than as flat
 * shaded geometry — every glossy surface picks up the room / sky around it.
 *
 * Regeneration is explicit and throttled: PMREM costs a couple of milliseconds,
 * so we only pay it when the track changes, when the sun has moved far enough to
 * matter, or when someone calls {@link Environment#refresh}.
 */
export class Environment {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {import('./Sky.js').Sky} sky
   */
  constructor(renderer, scene, sky) {
    this.renderer = renderer;
    this.scene = scene;
    this.sky = sky;

    /** @type {THREE.PMREMGenerator|null} */
    this._pmrem = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._target = null;

    this.intensity = 1.0;
    this.rotation = 0.0;
    /** Extra ambient colour multiplier applied through the sky tint. */
    this.tint = new THREE.Color(1, 1, 1);

    this._dirty = true;
    this._sunTracked = new THREE.Vector3(0, 1, 0);
    this._cooldown = 0;
    /** Minimum seconds between automatic regenerations. */
    this.minInterval = 0.35;
    /** Regenerate automatically if the sun moved more than this (radians). */
    this.sunThreshold = 0.012;
    /** Set false to freeze the IBL entirely (adaptive quality can do this). */
    this.autoUpdate = true;

    this.enabled = true;
  }

  init() {
    if (this._pmrem) return;
    this._pmrem = new THREE.PMREMGenerator(this.renderer);
    // Pre-compile so the very first generation does not hitch mid-race.
    try { this._pmrem.compileCubemapShader(); } catch (e) { /* non-fatal */ }
  }

  /**
   * Apply the `ibl` block of `TrackData.environment`.
   * @param {{intensity?:number, tint?:*, rotation?:number, enabled?:boolean}} [desc]
   */
  apply(desc) {
    const d = desc || {};
    if (typeof d.intensity === 'number') this.intensity = d.intensity;
    if (typeof d.rotation === 'number') this.rotation = d.rotation;
    if (d.enabled !== undefined) this.enabled = !!d.enabled;
    if (d.tint !== undefined) {
      if (d.tint.isColor) this.tint.copy(d.tint);
      else if (Array.isArray(d.tint)) this.tint.setRGB(d.tint[0], d.tint[1], d.tint[2]);
      else this.tint.set(d.tint);
    }
    this._applyIntensity();
    this._dirty = true;
    return this;
  }

  /** 0 = no image-based lighting, 1 = full. */
  setIntensity(v) {
    this.intensity = Math.max(0, v);
    this._applyIntensity();
    return this;
  }

  _applyIntensity() {
    const s = this.scene;
    if (!s) return;
    if ('environmentIntensity' in s) s.environmentIntensity = this.enabled ? this.intensity : 0;
    if (s.environmentRotation) s.environmentRotation.set(0, this.rotation, 0);
  }

  /** Force a regeneration on the next update(). */
  markDirty() { this._dirty = true; return this; }

  /** Regenerate right now (blocking). Safe to call at any time. */
  refresh() {
    if (!this.renderer || !this.sky || !this.enabled) return false;
    this.init();
    if (!this._pmrem) return false;

    // 1. capture the analytic sky into its cube target
    this.sky.render(this.renderer, true);

    // 2. pre-filter it into a roughness pyramid
    let next = null;
    try {
      next = this._pmrem.fromCubemap(this.sky.texture, this._target);
    } catch (err) {
      console.warn('[Environment] PMREM generation failed:', err);
      return false;
    }

    if (next !== this._target && this._target) this._target.dispose();
    this._target = next;

    if (this.scene) {
      this.scene.environment = this._target ? this._target.texture : null;
      this._applyIntensity();
    }

    this._sunTracked.copy(this.sky.sunDirection);
    this._dirty = false;
    this._cooldown = this.minInterval;
    return true;
  }

  /**
   * Cheap per-frame check. Regenerates at most every `minInterval` seconds, and
   * only when something actually changed.
   * @param {number} dt seconds (real time)
   */
  update(dt) {
    if (!this.enabled || !this.autoUpdate) return;
    if (this._cooldown > 0) { this._cooldown -= dt; return; }

    let need = this._dirty || !this._target;
    if (!need && this.sky) {
      // sun drift (moving-sun tracks) — only rebuild when it is visible
      if (this._sunTracked.dot(this.sky.sunDirection) < Math.cos(this.sunThreshold)) need = true;
      else if (this.sky.needsCapture) need = true;
    }
    if (need) this.refresh();
  }

  /** Drop the environment map (menus with a solid background, or an emergency downgrade). */
  clear() {
    if (this.scene) this.scene.environment = null;
  }

  dispose() {
    if (this.scene && this._target && this.scene.environment === this._target.texture) {
      this.scene.environment = null;
    }
    this._target?.dispose();
    this._target = null;
    this._pmrem?.dispose();
    this._pmrem = null;
  }
}

export default Environment;
