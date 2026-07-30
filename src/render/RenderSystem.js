import * as THREE from 'three';
import CONFIG, { q } from '../core/Config.js';
import { clamp, clamp01 } from '../core/MathUtils.js';

import { Sky, SKY_PRESETS } from './Sky.js';
import { Environment } from './Environment.js';
import { Lighting } from './Lighting.js';
import { PostFX, GRADE_PRESETS } from './PostFX.js';

/**
 * RenderSystem — owns the WebGL renderer, the lighting rig, the procedural sky,
 * the runtime IBL, the post stack and the adaptive-quality governor.
 *
 * Registered as `game.renderer`. `Game._render()` calls `render(dt, alpha)`.
 *
 * Other systems talk to it through:
 *   game.renderer.renderer          the THREE.WebGLRenderer
 *   game.renderer.composer          the EffectComposer
 *   game.renderer.postfx            speed/slow-mo/flash/DOF/grade hooks
 *   game.renderer.lighting          setFocus / addLight / apply
 *   game.renderer.sky               procedural sky parameters
 *   game.renderer.environment       IBL intensity + refresh
 *   game.renderer.applyEnvironment(desc)   one-shot from TrackData.environment
 *   game.renderer.registerResizeTarget(fn)
 *   game.renderer.setQuality(level) / getStats()
 */

/**
 * Adaptive-quality ladder. Step 0 is "everything the quality preset asked for";
 * each step trades a little fidelity for frame time. We only ever move one step
 * at a time, and we climb back up far more slowly than we fall.
 */
const ADAPTIVE_STEPS = [
  { pixelScale: 1.00, ao: null, motionBlur: null, bloom: null, dof: null, ibl: true, shadows: true, label: 'full' },
  { pixelScale: 0.88, ao: null, motionBlur: null, bloom: null, dof: null, ibl: true, shadows: true, label: 'ratio-88' },
  { pixelScale: 0.88, ao: false, motionBlur: null, bloom: null, dof: null, ibl: true, shadows: true, label: 'no-ao' },
  { pixelScale: 0.76, ao: false, motionBlur: false, bloom: null, dof: null, ibl: true, shadows: true, label: 'no-mblur' },
  { pixelScale: 0.68, ao: false, motionBlur: false, bloom: null, dof: false, ibl: false, shadows: true, label: 'no-dof' },
  { pixelScale: 0.60, ao: false, motionBlur: false, bloom: null, dof: false, ibl: false, shadows: false, label: 'no-shadows' },
  { pixelScale: 0.52, ao: false, motionBlur: false, bloom: false, dof: false, ibl: false, shadows: false, label: 'minimal' },
];

/** Rolling GPU timer using EXT_disjoint_timer_query_webgl2 when the browser exposes it. */
class GpuTimer {
  constructor(renderer) {
    this.available = false;
    this.ms = 0;
    this._gl = null;
    this._ext = null;
    this._pool = [];
    this._pending = [];
    this._active = null;
    try {
      const gl = renderer.getContext();
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (ext && typeof gl.createQuery === 'function') {
        this._gl = gl;
        this._ext = ext;
        this.available = true;
      }
    } catch (err) { /* timer queries are optional */ }
  }

  begin() {
    if (!this.available || this._active) return;
    const gl = this._gl;
    const query = this._pool.pop() || gl.createQuery();
    try {
      gl.beginQuery(this._ext.TIME_ELAPSED_EXT, query);
      this._active = query;
    } catch (err) {
      this.available = false;
    }
  }

  end() {
    if (!this.available || !this._active) return;
    const gl = this._gl;
    try {
      gl.endQuery(this._ext.TIME_ELAPSED_EXT);
      this._pending.push(this._active);
    } catch (err) {
      this.available = false;
    }
    this._active = null;
    this._poll();
  }

  _poll() {
    const gl = this._gl;
    while (this._pending.length) {
      const query = this._pending[0];
      const done = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(this._ext.GPU_DISJOINT_EXT);
      if (!done) break;
      this._pending.shift();
      if (!disjoint) {
        const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
        this.ms = this.ms * 0.85 + (ns / 1e6) * 0.15;
      }
      this._pool.push(query);
      if (this._pool.length > 8) gl.deleteQuery(this._pool.pop());
    }
    // never let the pending list grow unbounded
    while (this._pending.length > 6) this._pool.push(this._pending.shift());
  }

  dispose() {
    if (!this._gl) return;
    for (const qy of this._pool) this._gl.deleteQuery(qy);
    for (const qy of this._pending) this._gl.deleteQuery(qy);
    this._pool.length = 0;
    this._pending.length = 0;
  }
}

export class RenderSystem {
  constructor(game) {
    this.game = game;

    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = null;
    /** @type {Sky|null} */
    this.sky = null;
    /** @type {Environment|null} */
    this.environment = null;
    /** @type {Lighting|null} */
    this.lighting = null;
    /** @type {PostFX|null} */
    this.postfx = null;

    this.quality = CONFIG.quality;
    this.usePost = true;

    this._resizeTargets = new Set();
    this._onResize = null;
    this._onVisibility = null;
    this._unsub = [];

    // adaptive quality
    this.adaptive = {
      enabled: true,
      step: 0,
      basePixelRatio: 1,
      pixelRatio: 1,
      overBudget: 0,
      underBudget: 0,
      upgrades: 0,
      cooldown: 2.0,
      /** frames we ignore right after any change (shader compiles, RT rebuilds) */
      settle: 0,
    };
    this._frameSamples = new Float32Array(45);
    this._sampleIndex = 0;
    this._sampleCount = 0;

    this._stats = {
      fps: 0, frameMs: 0, cpuRenderMs: 0, gpuMs: 0,
      drawCalls: 0, triangles: 0, programs: 0, quality: this.quality,
      pixelRatio: 1, adaptive: 'full', post: null, lighting: null,
    };

    this._gpuTimer = null;
    this._time = 0;
    this._lastFrameTime = 0;
    this._slowMoPulse = null;
    this._cinematic = false;
  }

  // ─────────────────────────────────────────────────────────────── init

  async init() {
    const renderer = new THREE.WebGLRenderer({
      // FXAA runs at the end of the post chain; MSAA on the default framebuffer
      // would just cost bandwidth we would never see.
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
      // logarithmic depth is OFF by design: it breaks the depth-buffer reads the
      // AO / motion blur / DOF passes rely on, and 0.02→400 m fits fine in 24 bits.
      logarithmicDepthBuffer: false,
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });

    this.adaptive.basePixelRatio = clamp(
      Math.min(globalThis.devicePixelRatio || 1, q(CONFIG.render.maxPixelRatio, this.quality)),
      0.5, 4,
    );
    this.adaptive.pixelRatio = this.adaptive.basePixelRatio;

    renderer.setPixelRatio(this.adaptive.pixelRatio);
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CONFIG.render.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = this.quality === 'low' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;
    renderer.setClearColor(0x05070c, 1);
    renderer.info.autoReset = false;
    renderer.debug.checkShaderErrors = !!CONFIG.debug;

    const canvas = renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    this.game.container.appendChild(canvas);
    this.renderer = renderer;

    this.game.assets.maxAnisotropy = Math.min(
      renderer.capabilities.getMaxAnisotropy(), q(CONFIG.render.anisotropy, this.quality));
    this.game.assets.anisotropy = this.game.assets.maxAnisotropy;

    this._gpuTimer = new GpuTimer(renderer);

    // ── sky + IBL ──
    this.sky = new Sky({ cubeSize: this.quality === 'low' ? 128 : 256 });
    this.sky.applyPreset('studio');
    this.game.scene.add(this.sky.mesh);
    this.game.scene.background = null;   // the sky mesh IS the background

    this.environment = new Environment(renderer, this.game.scene, this.sky);
    this.environment.init();

    // ── lights ──
    this.lighting = new Lighting(this.game, this.game.scene, this.sky);
    this.lighting.init();

    // ── post ──
    this.postfx = new PostFX(this.game, renderer);
    this.postfx.init(innerWidth, innerHeight, this.adaptive.pixelRatio);
    this.postfx.setGrade(GRADE_PRESETS.neutral);

    // A sensible default look so the menu / car preview is already lit and graded
    // before any track exists.
    this.applyEnvironment(null);

    this._installEvents();
    this.resize();

    // First IBL bake. Do it now, while the loading screen is still up.
    this.environment.refresh();
    return this;
  }

  _installEvents() {
    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize, { passive: true });
    addEventListener('orientationchange', this._onResize, { passive: true });

    this._onVisibility = () => {
      // a tab switch produces one giant frame; do not let it trip the governor
      this._sampleCount = 0;
      this.adaptive.settle = 30;
      this.postfx?.resetHistory();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    const bus = this.game.bus;
    if (!bus) return;

    // Weapon hits and heavy impacts drive the screen flash + slow-mo look.
    this._unsub.push(bus.on('weapon:hit', (e) => {
      const player = this.game.playerCar;
      const isPlayer = player && (e?.carId === player.id);
      const near = isPlayer ? 1 : 0.35;
      this.postfx?.flash(weaponFlashColor(e?.weaponId), 0.85 * near, 0.22);
      if (isPlayer) this.pulseSlowMo(0.6, 0.35);
    }));

    this._unsub.push(bus.on('car:land', (e) => {
      const player = this.game.playerCar;
      if (!player || e?.carId !== player.id) return;
      const impact = Math.abs(e?.impactSpeed ?? 0);
      if (impact > 6) this.postfx?.flash(0xffffff, clamp01((impact - 6) / 14) * 0.22, 0.14);
    }));

    this._unsub.push(bus.on('car:collision', (e) => {
      const player = this.game.playerCar;
      if (!player || e?.carId !== player.id) return;
      const j = Math.abs(e?.impulse ?? 0);
      if (j > 6) this.postfx?.flash(0xfff0d0, clamp01((j - 6) / 30) * 0.3, 0.12);
    }));

    this._unsub.push(bus.on('car:respawn', () => this.postfx?.resetHistory()));

    this._unsub.push(bus.on('camera:mode', (e) => {
      const mode = e?.mode;
      const cinematic = mode === 'cinematic' || mode === 'intro' || mode === 'replay'
        || mode === 'finish' || mode === 'podium' || mode === 'orbit';
      this.setCinematic(cinematic);
      this.postfx?.resetHistory();
    }));

    this._unsub.push(bus.on('race:countdown', (e) => {
      if (e?.n === 0) this.postfx?.flash(0xd8ffe0, 0.35, 0.30);
    }));
  }

  // ───────────────────────────────────────────────────────── environment

  /**
   * Apply `TrackData.environment` to the whole render stack. Safe to call with
   * null/undefined (menus fall back to a neutral studio look).
   *
   * Recognised shape (everything optional):
   * ```js
   * {
   *   skybox: 'day'|'sunset'|'overcast'|'museum'|'supermarket'|'studio'
   *         | { preset?, mode:'outdoor'|'indoor', turbidity, sunElevation, ... },
   *   sun:    { color, intensity, elevation, azimuth, direction, castShadow, animate },
   *   ambient:{ sky, ground, intensity, flat },
   *   fog:    { color, near, far } | { color, density } | false,
   *   ibl:    { intensity, tint, rotation, enabled },
   *   grade:  'museum'|'garden'|... | { lift, gamma, gain, saturation, contrast, ... },
   *   exposure: 1.05,
   *   bloom:  { strength, threshold, knee, radius },
   *   vignette: 0.30,
   *   lights: [ { type:'point'|'spot', ... } ],
   *   bounds: THREE.Box3,
   * }
   * ```
   * @param {object|null} env
   */
  applyEnvironment(env) {
    const desc = env || {};

    // ── sky ──
    if (this.sky) {
      const sb = desc.skybox;
      if (typeof sb === 'string') this.sky.applyPreset(sb);
      else if (sb && typeof sb === 'object') this.sky.applyPreset(sb.preset ?? sb.mode ?? 'day', sb);
      else if (!env) this.sky.applyPreset('studio');
      else this.sky.applyPreset('day');

      if (desc.sun) {
        const patch = {};
        if (typeof desc.sun.elevation === 'number') patch.sunElevation = desc.sun.elevation;
        if (typeof desc.sun.azimuth === 'number') patch.sunAzimuth = desc.sun.azimuth;
        if (Object.keys(patch).length) this.sky.set(patch);
      }
    }

    // ── lights ──
    this.lighting?.apply(desc);

    // ── IBL ──
    if (this.environment) {
      this.environment.apply(desc.ibl || {});
      this.environment.markDirty();
    }

    // ── post look ──
    if (this.postfx) {
      if (desc.grade !== undefined) this.postfx.setGrade(desc.grade);
      this.postfx.setExposure(typeof desc.exposure === 'number' ? desc.exposure : CONFIG.render.exposure);
      if (desc.bloom) {
        this.postfx.setBloom(desc.bloom.strength, desc.bloom.threshold, desc.bloom.knee, desc.bloom.radius);
      } else {
        this.postfx.setBloom(0.34, 1.05, 0.62, this.quality === 'low' ? 1.1 : 0.9);
      }
      if (typeof desc.vignette === 'number') this.postfx.setVignette(desc.vignette);
      this.postfx.resetHistory();
    }

    if (this.renderer) {
      this.renderer.toneMappingExposure = typeof desc.exposure === 'number'
        ? desc.exposure : CONFIG.render.exposure;
    }
    return this;
  }

  // ─────────────────────────────────────────────────────── race lifecycle

  onRaceStart(ctx) {
    const track = ctx?.track;
    if (track?.environment) this.applyEnvironment(track.environment);
    else this.applyEnvironment(null);

    // Follow the player car with the shadow rig.
    const player = ctx?.game?.playerCar ?? this.game.playerCar;
    this.lighting?.setFocus(player?.group ?? null);

    // Patch anything the track/cars just added so CSM lights it correctly.
    this.lighting?.scanMaterials(true);
    this.environment?.refresh();
    this.postfx?.resetHistory();
    this.setCinematic(false);
    return this;
  }

  onRaceEnd() {
    this.lighting?.setFocus(null);
    this.lighting?.clearLocalLights();
    this.postfx?.resetHistory();
    return this;
  }

  // ─────────────────────────────────────────────────────────────── resize

  resize() {
    if (!this.renderer) return;
    const w = Math.max(1, innerWidth);
    const h = Math.max(1, innerHeight);

    this.renderer.setPixelRatio(this.adaptive.pixelRatio);
    this.renderer.setSize(w, h, false);

    const cam = this.game.camera;
    if (cam && cam.isPerspectiveCamera) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }

    this.postfx?.setSize(w, h, this.adaptive.pixelRatio);

    for (const fn of this._resizeTargets) {
      try { fn(w, h, this.adaptive.pixelRatio); }
      catch (err) { console.error('[RenderSystem] resize target threw:', err); }
    }

    this.adaptive.settle = Math.max(this.adaptive.settle, 12);
    this._sampleCount = 0;
  }

  /**
   * Register a callback invoked on every resize (and whenever adaptive quality
   * changes the pixel ratio) with `(cssWidth, cssHeight, pixelRatio)`.
   * @param {(w:number,h:number,pr:number)=>void} fn
   * @returns {() => void} unsubscribe
   */
  registerResizeTarget(fn) {
    if (typeof fn !== 'function') return () => {};
    this._resizeTargets.add(fn);
    if (this.renderer) {
      try { fn(innerWidth, innerHeight, this.adaptive.pixelRatio); } catch (err) { /* ignore */ }
    }
    return () => this._resizeTargets.delete(fn);
  }

  // ────────────────────────────────────────────────────────────── quality

  /**
   * @param {'low'|'medium'|'high'|'ultra'} level
   */
  setQuality(level) {
    if (!level) return this;
    // NOTE: deliberately no `level === this.quality` early-out. Re-selecting the
    // level you are already on is exactly how a player recovers after the adaptive
    // governor has degraded them to `minimal`, and the documented contract for this
    // method is "rebuilds shadows + post + pixel ratio, resets adaptive". Bailing
    // out early made that a silent no-op. Only Settings.applyOne() calls this, on an
    // explicit user change, so a redundant rebuild is cheap and rare.
    this.quality = level;
    CONFIG.quality = level;

    this.adaptive.overBudget = 0;
    this.adaptive.underBudget = 0;
    this.adaptive.upgrades = 0;
    this.adaptive.cooldown = 0;
    this.adaptive.basePixelRatio = clamp(
      Math.min(globalThis.devicePixelRatio || 1, q(CONFIG.render.maxPixelRatio, level)), 0.5, 4);
    this.adaptive.pixelRatio = this.adaptive.basePixelRatio;

    if (this.renderer) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = level === 'low' ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
      this.game.assets.maxAnisotropy = Math.min(
        this.renderer.capabilities.getMaxAnisotropy(), q(CONFIG.render.anisotropy, level));
      this.game.assets.anisotropy = this.game.assets.maxAnisotropy;
    }

    this.lighting?.setQuality(level);
    this.postfx?.applyQuality(level);
    for (const k in this.postfx?._force ?? {}) this.postfx.force(k, null);
    if (this.environment) this.environment.autoUpdate = true;

    // Rewind the adaptive ladder THROUGH the setter, not by assigning `.step`.
    // `_setAdaptiveStep` is what republishes the `getStats().adaptive` label, the
    // postfx force-overrides and the shadow toggle — assigning the field directly
    // left getStats() reporting a stale "minimal" long after post was back on.
    this._setAdaptiveStep(0);

    this.resize();
    this.environment?.refresh();
    return this;
  }

  /** Cinematic mode: enables DOF and softens the speed cues. */
  setCinematic(on, opts = {}) {
    this._cinematic = !!on;
    if (!this.postfx) return this;
    if (on) {
      this.postfx.setDof({
        enabled: true,
        autoFocus: opts.autoFocus !== false,
        focusRange: opts.focusRange ?? 0.5,
        nearFalloff: opts.nearFalloff ?? 1.0,
        farFalloff: opts.farFalloff ?? 6.0,
        maxBlur: opts.maxBlur ?? 0.024,
        intensity: opts.intensity ?? 1,
        ...(typeof opts.focusDistance === 'number' ? { focusDistance: opts.focusDistance } : {}),
      });
    } else {
      this.postfx.setDof({ enabled: false });
    }
    return this;
  }

  /** Convenience: a short slow-mo look that decays on its own. */
  pulseSlowMo(strength = 0.7, seconds = 0.4) {
    this._slowMoPulse = { value: clamp01(strength), rate: 1 / Math.max(seconds, 0.05) };
    return this;
  }

  // ────────────────────────────────────────────────────────────── frame

  /**
   * Called by Game every frame, after all lateUpdate()s.
   * @param {number} dt simulated seconds (already time-scaled; 0 while paused)
   * @param {number} alpha physics interpolation factor
   */
  render(dt, alpha) {
    const renderer = this.renderer;
    if (!renderer) return;

    // Wall-clock frame interval: `dt` here is simulated time (zero when paused,
    // scaled in slow-mo), which is useless for a performance governor.
    const now = performance.now();
    let rawDt = this._lastFrameTime ? (now - this._lastFrameTime) / 1000 : 1 / 60;
    this._lastFrameTime = now;
    rawDt = clamp(rawDt, 0.0002, 0.25);
    const loop = this.game.loop;
    this._time += rawDt;

    const camera = this.game.camera;
    if (!camera) return;

    // keep a swapped-in camera correctly shaped
    if (camera.isPerspectiveCamera) {
      const aspect = innerWidth / Math.max(innerHeight, 1);
      if (Math.abs(camera.aspect - aspect) > 1e-4) {
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
      }
    }

    // ── slow-mo pulse decay ──
    if (this._slowMoPulse) {
      const p = this._slowMoPulse;
      p.value -= p.rate * rawDt;
      if (p.value <= 0) this._slowMoPulse = null;
      this.postfx?.setSlowMo(Math.max(p.value, 0));
    } else if (loop && loop.timeScale < 0.999) {
      // the Game is genuinely in slow motion — match it
      this.postfx?.setSlowMo(clamp01(1 - loop.timeScale));
    }

    // ── speed-driven lens response (only if nobody else is driving it) ──
    const player = this.game.playerCar;
    if (player && this.postfx) {
      const top = player.def?.topSpeed || 9;
      this.postfx.suggestSpeedIntensity(clamp01(Math.abs(player.speed || 0) / Math.max(top, 1)));
    } else {
      this.postfx?.suggestSpeedIntensity(0);
    }

    // ── sub-systems ──
    this.lighting?.update(rawDt);
    this.environment?.update(rawDt);
    this.postfx?.update(rawDt, camera);

    // ── draw ──
    renderer.info.reset();
    const t0 = performance.now();
    this._gpuTimer?.begin();

    if (this.usePost && this.postfx?.composer) {
      this.postfx.render(rawDt);
    } else {
      renderer.setRenderTarget(null);
      renderer.render(this.game.scene, camera);
    }

    this._gpuTimer?.end();
    const cpuMs = performance.now() - t0;

    this._sample(rawDt, cpuMs);
  }

  // ───────────────────────────────────────────────── adaptive quality

  _sample(rawDt, cpuMs) {
    const s = this._stats;
    s.cpuRenderMs = s.cpuRenderMs * 0.9 + cpuMs * 0.1;
    s.gpuMs = this._gpuTimer?.available ? this._gpuTimer.ms : 0;

    const info = this.renderer.info;
    s.drawCalls = info.render.calls;
    s.triangles = info.render.triangles;
    s.programs = info.programs ? info.programs.length : 0;

    const frameMs = rawDt * 1000;
    s.frameMs = s.frameMs * 0.9 + frameMs * 0.1;
    s.fps = this.game.loop ? this.game.loop.stats.fps : 1000 / Math.max(s.frameMs, 0.001);
    s.pixelRatio = this.adaptive.pixelRatio;
    s.quality = this.quality;

    const a = this.adaptive;
    if (a.settle > 0) { a.settle--; return; }
    if (!a.enabled) return;

    // rolling window of raw frame times (~0.75 s at 60 Hz)
    this._frameSamples[this._sampleIndex] = frameMs;
    this._sampleIndex = (this._sampleIndex + 1) % this._frameSamples.length;
    if (this._sampleCount < this._frameSamples.length) this._sampleCount++;
    if (this._sampleCount < this._frameSamples.length) return;

    // A median is immune to the odd GC spike; a mean is not.
    const median = medianOf(this._frameSamples, this._sampleCount);

    a.cooldown -= rawDt;

    const BUDGET_MS = 16.9;        // 60 fps with a hair of slack
    const COMFORT_MS = 13.2;       // clearly-headroom threshold for climbing back

    if (median > BUDGET_MS) {
      a.overBudget += rawDt;
      a.underBudget = 0;
    } else if (median < COMFORT_MS) {
      a.underBudget += rawDt;
      a.overBudget = 0;
    } else {
      a.overBudget = Math.max(0, a.overBudget - rawDt * 0.5);
      a.underBudget = Math.max(0, a.underBudget - rawDt * 0.5);
    }

    if (a.overBudget >= 1.5 && a.step < ADAPTIVE_STEPS.length - 1 && a.cooldown <= 0) {
      this._setAdaptiveStep(a.step + 1);
      a.overBudget = 0;
      a.underBudget = 0;
      a.cooldown = 2.5;
      a.upgrades = 0;
    } else if (a.underBudget >= 6.0 && a.step > 0 && a.cooldown <= 0 && a.upgrades < 3) {
      // climb back cautiously: one step, then a long cooldown, max three times
      this._setAdaptiveStep(a.step - 1);
      a.overBudget = 0;
      a.underBudget = 0;
      a.cooldown = 8.0;
      a.upgrades++;
    }
  }

  _setAdaptiveStep(index) {
    const a = this.adaptive;
    const step = ADAPTIVE_STEPS[clamp(index, 0, ADAPTIVE_STEPS.length - 1)];
    a.step = clamp(index, 0, ADAPTIVE_STEPS.length - 1);
    this._stats.adaptive = step.label;

    const pr = clamp(a.basePixelRatio * step.pixelScale, 0.45, 4);
    const prChanged = Math.abs(pr - a.pixelRatio) > 0.005;
    a.pixelRatio = pr;

    if (this.postfx) {
      this.postfx.force('ao', step.ao);
      this.postfx.force('motionBlur', step.motionBlur);
      this.postfx.force('bloom', step.bloom);
      this.postfx.force('dof', step.dof);
    }
    if (this.environment) this.environment.autoUpdate = step.ibl;

    // Toggling renderer.shadowMap.enabled is far cheaper than rebuilding the CSM
    // rig, and the CSM shader has a correct no-shadowmap branch. Blobs take over
    // as the grounding cue when the real shadows go away.
    if (this.renderer && this.renderer.shadowMap.enabled !== step.shadows) {
      this.renderer.shadowMap.enabled = step.shadows;
    }
    if (this.lighting) {
      this.lighting.blobStrength = step.shadows
        ? (this.lighting.csm ? 0.28 : 0.55)
        : 0.62;
    }

    if (prChanged) this.resize();

    a.settle = 20;
    this._sampleCount = 0;

    if (CONFIG.debug) console.log(`[RenderSystem] adaptive → ${step.label} (pr ${pr.toFixed(2)})`);
  }

  // ─────────────────────────────────────────────────────────────── misc

  /** The EffectComposer, or null while post is disabled. */
  get composer() { return this.postfx?.composer ?? null; }

  /** Toggle the whole post stack (debug / emergency). */
  setPostEnabled(on) {
    this.usePost = !!on;
    return this;
  }

  getStats() {
    const s = this._stats;
    s.post = this.postfx?.getStats() ?? null;
    s.lighting = this.lighting?.getStats() ?? null;
    s.gpuTimer = !!this._gpuTimer?.available;
    s.adaptiveStep = this.adaptive.step;
    s.cinematic = this._cinematic;
    return s;
  }

  dispose() {
    if (this._onResize) {
      removeEventListener('resize', this._onResize);
      removeEventListener('orientationchange', this._onResize);
    }
    if (this._onVisibility) document.removeEventListener('visibilitychange', this._onVisibility);
    for (const off of this._unsub) { try { off(); } catch (err) { /* ignore */ } }
    this._unsub.length = 0;
    this._resizeTargets.clear();

    this.postfx?.dispose();
    this.environment?.dispose();
    this.lighting?.dispose();
    if (this.sky) {
      this.game.scene.remove(this.sky.mesh);
      this.sky.dispose();
    }
    this._gpuTimer?.dispose();

    this.renderer?.dispose();
    this.renderer?.domElement?.remove();
    this.renderer = null;
  }
}

/** Median of the first `count` entries without allocating a new array each call. */
const _sortScratch = new Float32Array(64);
function medianOf(buffer, count) {
  const n = Math.min(count, buffer.length, _sortScratch.length);
  for (let i = 0; i < n; i++) _sortScratch[i] = buffer[i];
  // insertion sort — n is ~45 and nearly sorted in practice
  for (let i = 1; i < n; i++) {
    const v = _sortScratch[i];
    let j = i - 1;
    while (j >= 0 && _sortScratch[j] > v) { _sortScratch[j + 1] = _sortScratch[j]; j--; }
    _sortScratch[j + 1] = v;
  }
  return n === 0 ? 0 : _sortScratch[(n / 2) | 0];
}

function weaponFlashColor(weaponId) {
  switch (weaponId) {
    case 'firework':
    case 'rocket': return 0xffb060;
    case 'electro':
    case 'lightning': return 0x9fd8ff;
    case 'bomb': return 0xffd0a0;
    case 'freeze': return 0xcfefff;
    case 'oil': return 0x606070;
    default: return 0xffffff;
  }
}

export { SKY_PRESETS, GRADE_PRESETS };
export default RenderSystem;
