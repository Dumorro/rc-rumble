/**
 * CameraDirector — owns `game.camera` and decides what it is looking at.
 *
 * ## Model
 *
 * A **stack of modes**, each backed by a rig that fills a {@link CameraPose}. The
 * bottom of the stack is the player's chosen view (chase / chaseFar / bumper /
 * cockpit / free); transient views (lookBack while held, a big-air cut, a crash
 * replay) are *pushed* on top and popped when they are done, revealing whatever
 * the player had chosen. Nothing is ever "restored from a variable" — the stack is
 * the state, which is why holding look-back through a jump, a hit and a respawn
 * all at once still lands you back in your own camera.
 *
 * Transitions cross-fade: the outgoing rig keeps running for the duration of the
 * blend and the two poses are interpolated (smootherstep on position, slerp on
 * rotation). A blend of 0 is a hard cut and resets temporal post FX.
 *
 * ## Per frame
 *
 *   sample the car → run director logic (fallbacks, big air, finish) → read input
 *   → activate any pending mode → update rig(s) → blend → shake → commit to the
 *   camera → publish speed intensity + DOF to the render system.
 *
 * ## Guarantees
 *
 *  • **It always boots.** No track, no car, no physics, no renderer: the director
 *    falls back to a slow orbit of the scene origin, so the menu has a live
 *    backdrop and nothing throws.
 *  • **No allocations per frame.** All rigs use module-level scratch vectors.
 *  • **Nothing outside `src/camera/**` is written to** except `game.camera` (which
 *    the director owns by contract) and documented render-system entry points.
 *
 * ## Public API
 *
 * ```js
 * game.cameraDirector.setMode('bumper', 0.35);
 * game.cameraDirector.pushMode('lookBack', 0.15);
 * game.cameraDirector.popMode(0.2);
 * game.cameraDirector.cycleMode();
 * game.cameraDirector.shake(0.6, 0.4);
 * game.cameraDirector.impulse(dirVec3, 2.5);
 * game.cameraDirector.focusOn(car);
 * await game.cameraDirector.playIntro(track, car);
 * game.cameraDirector.getSpeedIntensity();   // 0..1, read by PostFX
 * ```
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { GameState } from '../core/Game.js';
import { clamp, clamp01, damp } from '../core/MathUtils.js';
import { CameraPose, blendPose } from './CameraPose.js';
import { CarState } from './CarState.js';
import { CameraShake } from './CameraShake.js';
import { ChaseCamera, CHASE_PRESETS } from './ChaseCamera.js';
import { OrbitCamera } from './OrbitCamera.js';
import { CinematicCamera } from './CinematicCamera.js';
import { FinishCamera } from './FinishCamera.js';
import { FreeCamera } from './FreeCamera.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Every mode the director understands. */
export const CAMERA_MODES = Object.freeze([
  'chase', 'chaseFar', 'bumper', 'cockpit', 'lookBack',
  'free', 'orbit', 'cinematic', 'intro', 'bigair', 'replay', 'finish', 'podium',
]);

/** The modes the camera key cycles through, in order. */
export const CYCLE_MODES = Object.freeze(['chase', 'chaseFar', 'bumper', 'cockpit']);

/** Modes that need a car to point at. */
const CAR_MODES = new Set(['chase', 'chaseFar', 'bumper', 'cockpit', 'lookBack',
  'bigair', 'replay', 'finish', 'podium', 'intro', 'cinematic']);

/** Modes the render system treats as cinematic (DOF on). Kept in sync with RenderSystem. */
const CINEMATIC_MODES = new Set(['cinematic', 'intro', 'replay', 'finish', 'podium', 'orbit']);

/** Modes that may be interrupted by an automatic cut (big air, crash replay). */
const INTERRUPTIBLE = new Set(['chase', 'chaseFar', 'bumper', 'cockpit']);

const qs = new URLSearchParams(globalThis.location?.search ?? '');
const introEnabledByQuery = !(qs.get('intro') === '0' || qs.get('nointro') === '1');

export class CameraDirector {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;

    /** The mode whose rig is actually activated right now. */
    this._activeMode = 'orbit';
    /** The mode the camera key cycles — i.e. the player's chosen view. */
    this.baseMode = CYCLE_MODES.includes(CONFIG.camera?.mode) ? CONFIG.camera.mode : 'chase';

    /** @type {{mode:string, opts:object}[]} bottom → top */
    this._stack = [{ mode: 'orbit', opts: {} }];
    /** @type {{blend:number}|null} */
    this._pending = { blend: 0 };
    this._dirty = true;

    // ── rigs: one instance per mode so two of them can cross-fade ──
    /** @type {Record<string, object>} */
    this.rigs = {
      chase: new ChaseCamera(this, 'chase'),
      chaseFar: new ChaseCamera(this, 'chaseFar'),
      bumper: new ChaseCamera(this, 'bumper'),
      cockpit: new ChaseCamera(this, 'cockpit'),
      lookBack: new ChaseCamera(this, 'lookBack'),
      orbit: new OrbitCamera(this, 'orbit'),
      cinematic: new OrbitCamera(this, 'cinematic'),
      podium: new FinishCamera(this, 'podium'),
      finish: new FinishCamera(this, 'finish'),
      intro: new CinematicCamera(this, 'intro'),
      bigair: new CinematicCamera(this, 'bigair'),
      replay: new CinematicCamera(this, 'replay'),
      free: new FreeCamera(this),
    };

    /** Perlin shake + trauma model. `shake()` is the method; this is the machine. */
    this.shaker = new CameraShake(CONFIG.seed ^ 0x1f2e3d);

    /** The blended rig pose for this frame, BEFORE shake. */
    this.pose = new CameraPose();
    /** The pose actually committed to the camera (pose + shake). */
    this.finalPose = new CameraPose();
    this._poseA = new CameraPose();
    this._poseB = new CameraPose();
    this._blend = { t: 0, dur: 0, rig: null, frozen: false };
    this._hasPose = false;

    /** Live car telemetry, sampled once per frame. */
    this.carState = new CarState();
    /** Override target; null = the player car. */
    this.targetCar = null;

    /** Frame context handed to every rig. Reused — never retain it. */
    this.ctx = {
      game, director: this, car: null, carState: this.carState,
      track: null, physics: null, dt: 0, rawDt: 0, alpha: 0, time: 0,
    };

    /** 0..1 — PostFX reads this through getSpeedIntensity(). */
    this._speedIntensity = 0;

    this.enabled = true;
    /** Push speed intensity into PostFX every frame. */
    this.driveSpeedFx = true;
    /** Drive PostFX depth of field from the active rig. */
    this.driveDof = true;
    /** Play the flyby automatically when a race loads. */
    this.autoIntro = introEnabledByQuery;

    /** Automatic cut gating. Tweak live from the console. */
    this.tuning = {
      bigAirMinTime: 0.85,        // s of air before the cut is allowed
      bigAirMinSpeed: 0.28,       // speedFrac
      bigAirCooldown: 7.0,        // s between cuts
      bigAirMaxDuration: 2.6,
      crashMinImpulse: 9.0,       // N·s
      crashMinSpeed: 4.5,         // m/s closing speed
      crashCooldown: 15.0,        // s between crash replays
      crashSlowMo: CONFIG.camera?.slowMoScale ?? 0.35,
      crashSlowMoTime: 0.55,
      collisionShake: 1 / 16,     // trauma per N·s
      landShake: 1 / 26,          // trauma per m/s of impact
      weaponShake: 0.55,
      blendCycle: 0.34,
      blendLookBack: 0.14,
      blendIntroOut: 0.55,
      blendFinish: 1.15,
      rumbleGain: 1.0,
      shakeMax: 1.0,
    };

    this._time = 0;
    this._lastBigAir = -100;
    this._lastCrash = -100;
    this._raceTime = 0;
    this._landGrace = 0;
    this._autoOrbit = true;
    this._introResolve = null;
    this._introPromise = null;
    this._crashPoint = new THREE.Vector3();
    this._hasCrashPoint = false;
    this._prevLookBack = false;
    this._wasAirborne = false;
    this._fallVy = 0;
    this._lastLandEvent = -100;
    this._dofOwned = false;
    this._timers = [];
    this._unsub = [];
    this._warned = false;
  }

  /**
   * Top-of-stack mode name. Updates the instant a mode is requested (the rig is
   * activated on the next frame), so callers and the HUD always agree with intent.
   * @type {string}
   */
  get mode() {
    const top = this._stack[this._stack.length - 1];
    return top ? top.mode : this._activeMode;
  }

  // ─────────────────────────────────────────────────────────────── lifecycle

  async init() {
    this._installEvents();
    this._refreshContext(0, 0, 1 / 60);
    this._applyPending(0);
    // Give the camera a sane pose before the very first render.
    this._updateRigs(0);
    this._applyShake(0);
    this._commit();
    return this;
  }

  _installEvents() {
    const bus = this.game?.bus;
    if (!bus) return;
    const on = (name, fn) => this._unsub.push(bus.on(name, fn));

    on('camera:mode', (e) => {
      if (!e || e.source === 'director') return;
      const mode = e.mode;
      if (typeof mode !== 'string' || !this.rigs[mode]) return;
      this.setMode(mode, Number.isFinite(e.blend) ? e.blend : 0.4);
    });

    on('camera:shake', (e) => {
      if (!e) return;
      this.shake(Number.isFinite(e.amount) ? e.amount : 0.3,
        Number.isFinite(e.duration) ? e.duration : 0.35);
      if (e.direction) this.impulse(e.direction, Number.isFinite(e.strength) ? e.strength : 1);
    });

    on('car:collision', (e) => this._onCollision(e));
    on('prop:hit', (e) => this._onPropHit(e));
    on('car:land', (e) => this._onLand(e));
    on('car:airborne', (e) => this._onAirborne(e));
    on('weapon:hit', (e) => this._onWeaponHit(e));
    on('car:respawn', (e) => this._onRespawn(e));

    on('race:countdown', (e) => {
      // The countdown has started — make sure the flyby lands on "GO".
      if (this.mode !== 'intro') return;
      const n = Number.isFinite(e?.n) ? e.n : 0;
      if (n > 0) this.rigs.intro.compressTo?.(Math.max(n, 0.4));
    });

    on('race:start', () => {
      this._raceTime = 0;
      if (this.mode === 'intro' || this._stackHas('intro')) {
        this._finishIntro(this.tuning.blendIntroOut);
      }
    });

    on('race:finish', (e) => {
      const player = this._resolveCar();
      if (!player) return;
      const id = e?.carId;
      if (id !== undefined && id !== null && id !== player.id) return;
      const rig = this.rigs.finish;
      rig.setSubject?.(player);
      this._after(0.45, () => {
        if (this.game.state === GameState.MENU || this.game.state === GameState.LOADING) return;
        this.setMode('finish', this.tuning.blendFinish);
      });
    });

    on('race:end', () => {
      this._after(0.6, () => {
        if (this.game.state === GameState.MENU || this.game.state === GameState.LOADING) return;
        this.setMode('podium', 1.4);
      });
    });

    on('game:state', (e) => {
      const s = e?.state;
      if (s === GameState.MENU) {
        this._timers.length = 0;
        this._cancelIntro();
        this._autoOrbit = true;
        this.setMode('orbit', 0.9);
      }
    });
  }

  /** @param {{track:object, cars:object[], config:object, game:object}} ctx */
  onRaceStart(ctx) {
    this._timers.length = 0;
    this._raceTime = 0;
    this._lastBigAir = -100;
    this._lastCrash = -100;
    this._landGrace = 0;
    this._hasCrashPoint = false;
    this._wasAirborne = false;
    this._fallVy = 0;
    this._autoOrbit = false;
    this.targetCar = null;
    this.carState.reset();
    this.shaker.reset();
    this._refreshContext(0, 0, 0);

    const car = this._resolveCar();
    const track = ctx?.track ?? this.game?.track ?? null;

    // Game.loadRace() calls onRaceStart while the state is still LOADING and only
    // flips to COUNTDOWN afterwards, so accept both.
    const st = this.game?.state;
    const preRace = st === GameState.COUNTDOWN || st === GameState.LOADING;

    if (car && this.autoIntro && preRace) {
      this.playIntro(track, car);
    } else {
      this.setMode(car ? this.baseMode : 'orbit', 0);
      this._snapAll();
    }
    return this;
  }

  onRaceEnd() {
    this._timers.length = 0;
    this._cancelIntro();
    this.shaker.reset();
    this.targetCar = null;
    this.carState.reset();
    this._autoOrbit = true;
    this.setMode('orbit', 0.6);
    this._releaseDof();
    return this;
  }

  dispose() {
    for (const off of this._unsub) { try { off(); } catch (err) { /* ignore */ } }
    this._unsub.length = 0;
    this._timers.length = 0;
    this._deactivateRig(this.rigs[this._activeMode]);
    this._deactivateRig(this._blend.rig);
    this._blend.rig = null;
    for (const k in this.rigs) this.rigs[k]?.dispose?.();
    this._cancelIntro();
    this._releaseDof();
    return this;
  }

  // ────────────────────────────────────────────────────────────── public API

  /**
   * Replace the whole stack with `mode`.
   * @param {string} mode one of CAMERA_MODES
   * @param {number} [blendSeconds] 0 = hard cut
   * @param {object} [opts] passed through to the rig on activate
   */
  setMode(mode, blendSeconds = 0.4, opts = null) {
    if (typeof mode !== 'string' || !this.rigs[mode]) return this;
    if (CYCLE_MODES.includes(mode)) this.baseMode = mode;
    this._stack.length = 0;
    this._stack.push({ mode, opts: opts ?? {} });
    this._request(blendSeconds);
    return this;
  }

  /** Push a transient mode on top of the player's view. */
  pushMode(mode, blendSeconds = 0.25, opts = null) {
    if (typeof mode !== 'string' || !this.rigs[mode]) return this;
    if (this.mode === mode) return this;
    this._stack.push({ mode, opts: opts ?? {} });
    this._request(blendSeconds);
    return this;
  }

  /** Pop the top transient mode, revealing what is underneath. */
  popMode(blendSeconds = 0.25) {
    if (this._stack.length <= 1) return this;
    this._stack.pop();
    this._request(blendSeconds);
    return this;
  }

  /** Remove a specific mode from anywhere in the stack. */
  removeMode(mode, blendSeconds = 0.25) {
    const before = this._stack.length;
    for (let i = this._stack.length - 1; i >= 0; i--) {
      if (this._stack[i].mode === mode && this._stack.length > 1) this._stack.splice(i, 1);
    }
    if (this._stack.length !== before) this._request(blendSeconds);
    return this;
  }

  /** Cycle the player's chosen view (the camera key). */
  cycleMode(dir = 1) {
    const list = this._cycleList();
    const cur = list.indexOf(this.baseMode);
    const next = list[((cur < 0 ? 0 : cur) + dir + list.length * 2) % list.length];
    this.baseMode = next;
    // Swap the bottom of the stack; if something transient is on top it stays on
    // top and the new base appears when it pops.
    if (this._stack.length) this._stack[0] = { mode: next, opts: {} };
    else this._stack.push({ mode: next, opts: {} });
    if (this._stack.length === 1) this._request(this.tuning.blendCycle);
    return next;
  }

  _cycleList() {
    if (!CONFIG.debug) return CYCLE_MODES;
    // Debug builds get the free camera in the rotation.
    return DEBUG_CYCLE;
  }

  /**
   * Add trauma. Amplitude is trauma², so small knocks stay small and a big hit
   * dominates.
   * @param {number} amount 0..1
   * @param {number} [seconds] bleed-off time
   */
  shake(amount, seconds = 0.4) {
    this.shaker.add(clamp01(amount) * clamp01(this.tuning.shakeMax), seconds);
    return this;
  }

  /**
   * Directional shove — a hit from the left throws the camera right.
   * @param {THREE.Vector3|{x:number,y:number,z:number}} worldDir
   * @param {number} strength
   */
  impulse(worldDir, strength = 1) {
    if (!worldDir) return this;
    _v.set(worldDir.x ?? 0, worldDir.y ?? 0, worldDir.z ?? 0);
    this.shaker.addImpulse(_v, strength);
    return this;
  }

  /** Follow a different car (replays, spectating). Pass null to go back to the player. */
  focusOn(car) {
    if (this.targetCar === car) return this;
    this.targetCar = car ?? null;
    this.carState.reset();
    this._refreshContext(0, 0, 0);
    this.rigs.finish?.setSubject?.(car ?? null);
    this._snapAll();
    return this;
  }

  /**
   * Play the pre-race flyby.
   * @param {object} [track] defaults to game.track
   * @param {object} [car] defaults to the player car
   * @returns {Promise<void>} resolves when the intro finishes, is skipped, or is cancelled
   */
  playIntro(track = null, car = null) {
    if (car) this.targetCar = car === this.game?.playerCar ? null : car;
    if (this._introPromise) return this._introPromise;

    const intro = this.rigs.intro;
    if (!intro) return Promise.resolve();

    this._refreshContext(0, 0, 0);
    if (track && this.ctx) this.ctx.track = track;

    this._introPromise = new Promise((resolve) => { this._introResolve = resolve; });
    this.setMode('intro', 0);
    return this._introPromise;
  }

  /** Cut the flyby short and hand over to the chase camera. */
  skipIntro() {
    if (this.mode !== 'intro' && !this._stackHas('intro')) return this;
    this.rigs.intro?.finish?.();
    this._finishIntro(0.28);
    return this;
  }

  /** 0..1 — how fast everything feels. The render system drives post FX from this. */
  getSpeedIntensity() { return this._speedIntensity; }

  getMode() { return this.mode; }
  isCinematic() { return CINEMATIC_MODES.has(this.mode); }
  /** Human-readable label for the HUD. */
  getModeLabel() {
    return CHASE_PRESETS[this.mode]?.label ?? this.mode;
  }

  /**
   * Hand the camera to somebody else (garage preview, screenshot tool). While
   * disabled the director writes nothing — and it lets go of the post-FX hooks it
   * owns, so the borrower is not left with a frozen speed blur.
   */
  setEnabled(v) {
    const next = !!v;
    if (next === this.enabled) return this;
    this.enabled = next;
    if (!next) {
      this._speedIntensity = 0;
      const postfx = this.game?.renderer?.postfx;
      try { postfx?.setSpeedIntensity?.(0); } catch (err) { /* ignore */ }
      this._releaseDof();
    }
    return this;
  }

  /** Hard reset every rig onto the current car. Cheap; safe to spam. */
  snap() { this._snapAll(); return this; }

  getStats() {
    return {
      mode: this.mode,
      base: this.baseMode,
      stack: this._stack.map((e) => e.mode).join('>'),
      blend: this._blend.dur > 0 ? clamp01(this._blend.t / this._blend.dur) : 1,
      speedIntensity: this._speedIntensity,
      fov: this.pose.fov,
      trauma: this.shaker.trauma,
      car: this.carState.valid ? this.carState.id : -1,
    };
  }

  // ───────────────────────────────────────────────────────────── frame

  /**
   * @param {number} dt simulated seconds (time-scaled, 0 while paused)
   * @param {number} alpha physics interpolation factor
   * @param {number} rawDt wall-clock seconds
   */
  lateUpdate(dt, alpha = 0, rawDt = dt) {
    if (!this.enabled) return;
    const cam = this.game?.camera;
    if (!cam) return;

    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.25) : 0;
    rawDt = Number.isFinite(rawDt) ? clamp(rawDt, 0, 0.25) : dt;
    this._time += rawDt;
    if (this.game.state === GameState.RACING) this._raceTime += dt;

    this._refreshContext(dt, alpha, rawDt);
    this._runTimers(rawDt);
    this._detectLanding(dt);
    this._direct(dt);
    this._readInput();
    this._applyPending(dt);
    this._updateRigs(dt);
    this._applyShake(dt);
    this._commit();
    this._publish(dt, rawDt);
  }

  _refreshContext(dt, alpha, rawDt) {
    const game = this.game;
    const car = this._resolveCar();
    const c = this.ctx;
    c.car = car;
    c.track = game?.track ?? null;
    c.physics = game?.physics ?? null;
    c.dt = dt;
    c.rawDt = rawDt;
    c.alpha = alpha;
    c.time = this._time;
    // Never hand the sampler dt = 0: its finite-difference fallbacks would zero
    // the velocity of a car that has no rigid body yet.
    const sdt = dt > 1e-5 ? dt : (rawDt > 1e-5 ? rawDt : 1 / 60);
    this.carState.sample(car, sdt);
    return c;
  }

  _resolveCar() {
    const car = this.targetCar ?? this.game?.playerCar ?? null;
    if (car) return car;
    // Spectate whoever exists so a car-less player still has something to watch.
    const cars = this.game?.cars;
    if (Array.isArray(cars) && cars.length) return cars[0];
    return null;
  }

  // ─────────────────────────────────────────────────── director decisions

  /** Everything that decides *which* camera we should be in. */
  _direct(dt) {
    const cs = this.carState;
    const top = this.mode;
    const s = this.game.state;

    // ── 0. menus own the orbit camera ────────────────────────────────────
    // 'free' and 'cinematic' are left alone so the UI can drive a car-select
    // turntable or a debug fly-through without the director fighting it.
    if (s === GameState.MENU || s === GameState.LOADING || s === GameState.BOOT) {
      if (top !== 'orbit' && top !== 'free' && top !== 'cinematic') {
        this._autoOrbit = true;
        this._cancelIntro();
        this.setMode('orbit', 0.5);
      }
      return;
    }

    // ── 1. hard fallback: no car ⇒ orbit ─────────────────────────────────
    if (!cs.valid) {
      if (CAR_MODES.has(top)) {
        this._autoOrbit = true;
        this._cancelIntro();
        this.setMode('orbit', 0.5);
      }
      return;
    }
    if (this._autoOrbit && top === 'orbit') {
      this._autoOrbit = false;
      this.setMode(this.baseMode, 0.7);
      return;
    }

    // ── 2. transient rigs that have run their course ──────────────────────
    // Only ever poll isDone() on a rig that is genuinely LIVE. A mode requested
    // this frame has not been activated yet, so its `done` flag is still whatever
    // its previous run left behind — polling it would end the shot instantly.
    const live = !this._pending && this._activeMode === top;
    if (live) {
      if (top === 'intro') {
        if (this.rigs.intro?.isDone?.()) {
          this._finishIntro(this.tuning.blendIntroOut);
          return;
        }
      } else if (top === 'bigair') {
        const rig = this.rigs.bigair;
        if (cs.airborne) this._landGrace = 0; else this._landGrace += dt;
        if (rig?.isDone?.() || this._landGrace > 0.22) {
          this._landGrace = 0;
          this.popMode(0.30);
          return;
        }
      } else if (top === 'replay') {
        if (this.rigs.replay?.isDone?.()) {
          this._hasCrashPoint = false;   // do not let a stale impact anchor a later cut
          this.popMode(0.34);
          return;
        }
      }
    }

    // ── 3. automatic cuts ─────────────────────────────────────────────────
    if (!INTERRUPTIBLE.has(this.mode)) return;
    if (s !== GameState.RACING && s !== GameState.FINISHED) return;

    // Big air: only for a genuine launch, and never twice in a row.
    if (cs.airborne && cs.airTime >= this.tuning.bigAirMinTime
      && cs.speedFrac >= this.tuning.bigAirMinSpeed
      && this._time - this._lastBigAir > this.tuning.bigAirCooldown) {
      this._lastBigAir = this._time;
      this._landGrace = 0;
      this.pushMode('bigair', 0.26);
    }
  }

  _readInput() {
    const st = this.game?.input?.state;
    if (!st) return;
    // Only steal the camera key when there is actually a car to look at, and not
    // while a menu owns the input.
    const s = this.game.state;
    const live = s === GameState.COUNTDOWN || s === GameState.RACING
      || s === GameState.FINISHED || s === GameState.RESULTS;
    if (!live) { this._prevLookBack = false; return; }

    // Any input skips the flyby.
    if (this.mode === 'intro'
      && (st.camera || st.pause || st.fire || st.throttle > 0.5 || st.brake > 0.5)) {
      this.skipIntro();
      return;
    }

    if (st.camera) this.cycleMode(1);

    // Hold to look back.
    const want = !!st.lookBack && this.carState.valid;
    if (want !== this._prevLookBack) {
      this._prevLookBack = want;
      if (want) {
        if (INTERRUPTIBLE.has(this.mode)) this.pushMode('lookBack', this.tuning.blendLookBack);
      } else {
        this.removeMode('lookBack', this.tuning.blendLookBack);
      }
    }
  }

  // ───────────────────────────────────────────────────────── mode plumbing

  _stackHas(mode) {
    for (let i = 0; i < this._stack.length; i++) if (this._stack[i].mode === mode) return true;
    return false;
  }

  _request(blendSeconds) {
    const top = this._stack[this._stack.length - 1];
    const blend = Number.isFinite(blendSeconds) ? Math.max(blendSeconds, 0) : 0.3;
    if (top && top.mode === this._activeMode && !this._dirty) {
      // Already there — nothing to do (e.g. popping back to the same rig).
      return;
    }
    this._pending = { blend };
    this._dirty = true;
  }

  _applyPending(dt) {
    if (!this._pending) return;
    const req = this._pending;
    this._pending = null;
    this._dirty = false;

    const entry = this._stack[this._stack.length - 1];
    if (!entry) return;
    const rig = this.rigs[entry.mode];
    if (!rig) return;

    // Push-then-pop inside a single frame (tapping look-back) resolves back to the
    // rig that is already live and settled. Re-activating it would snap it to its
    // ideal pose for no reason, so just drop the request.
    if (entry.mode === this._activeMode && this._blend.dur <= 0 && this._hasPose) return;

    const prevMode = this._activeMode;
    const prevRig = this.rigs[prevMode] ?? null;
    const blend = this._hasPose ? req.blend : 0;

    // Retire whatever was already fading out — it is about to be replaced, and a
    // rig that never gets deactivate() leaks its DOM listeners (free cam).
    const stale = this._blend.rig;
    if (stale && stale !== rig && stale !== prevRig) this._deactivateRig(stale);
    this._blend.rig = null;
    this._blend.frozen = false;

    if (blend > 0.001 && prevRig && prevRig !== rig) {
      // Cross-fade against the live outgoing rig.
      this._blend.rig = prevRig;
      this._blend.t = 0;
      this._blend.dur = blend;
    } else if (blend > 0.001) {
      // Same rig on both sides, or nothing live to fade from: freeze the last
      // pre-shake pose and cross-fade against that.
      this._blend.frozen = true;
      this._poseB.copy(this.pose);
      this._blend.t = 0;
      this._blend.dur = blend;
    } else {
      this._blend.dur = 0;
      this._blend.t = 0;
      if (prevRig && prevRig !== rig) this._deactivateRig(prevRig);
      this._cut();
    }

    this._activeMode = entry.mode;
    try { rig.activate(this.ctx, this._hasPose ? this.pose : null, entry.opts); }
    catch (err) { this._rigError(entry.mode, 'activate', err); }

    if (prevMode !== this._activeMode) {
      this.game?.bus?.emit('camera:mode', {
        mode: this._activeMode, prev: prevMode, blend, source: 'director',
      });
    }
  }

  _deactivateRig(rig) {
    if (!rig) return;
    try { rig.deactivate?.(); } catch (err) { /* ignore */ }
  }

  _updateRigs(dt) {
    const entry = this._stack[this._stack.length - 1];
    const rig = entry ? this.rigs[entry.mode] : null;

    if (!rig) {
      // Should be impossible; keep the last good pose rather than exploding.
      if (!this._hasPose) this.pose.fromCamera(this.game?.camera);
      return;
    }

    try { rig.update(dt, this.ctx, this._poseA); }
    catch (err) {
      this._rigError(entry.mode, 'update', err);
      if (this._hasPose) this._poseA.copy(this.pose);
    }

    if (this._blend.dur > 0) {
      this._blend.t += dt;
      const t = clamp01(this._blend.t / this._blend.dur);
      if (this._blend.rig) {
        try { this._blend.rig.update(dt, this.ctx, this._poseB); }
        catch (err) { this._blend.rig = null; this._blend.frozen = true; }
      }
      blendPose(this.pose, this._poseB, this._poseA, t);
      if (t >= 1) {
        this._blend.dur = 0;
        this._blend.t = 0;
        this._deactivateRig(this._blend.rig);
        this._blend.rig = null;
        this._blend.frozen = false;
      }
    } else {
      this.pose.copy(this._poseA);
    }

    this._hasPose = true;
  }

  _applyShake(dt) {
    const cs = this.carState;

    // Continuous rumble from speed + surface roughness. Cheap, and it is what
    // makes gravel feel different from a museum floor without any FX at all.
    let rumble = 0;
    if (cs.valid && !cs.airborne) {
      const surf = this.ctx.track?.surfaces;
      let bump = 0.18;
      if (surf) {
        const def = Array.isArray(surf) ? surf[cs.surfaceId] : surf[cs.surfaceId];
        if (def && Number.isFinite(def.bumpiness)) bump = clamp01(def.bumpiness);
      }
      rumble = clamp01(cs.speedFrac * (0.12 + bump * 0.9) * this.tuning.rumbleGain);
      // Wheelspin / skidding buzzes too.
      rumble = clamp01(rumble + cs.driftFactor * 0.10 * cs.speedFrac);
    }
    this.shaker.setRumble(rumble);

    // `pose` stays clean (it is what a cut freezes and blends against); the shake
    // only ever lands on the copy we hand to the camera.
    this.shaker.update(dt, this.pose.quaternion);
    this.finalPose.copy(this.pose);
    this.shaker.apply(this.finalPose, this.pose.shakeScale);
  }

  _commit() {
    const cam = this.game?.camera;
    if (!cam) return;
    const p = this.finalPose;

    // NaN firewall: one bad frame of car data must not brick the camera forever.
    if (!poseFinite(p)) {
      if (!this._warned) {
        console.warn('[CameraDirector] non-finite pose — resetting rigs');
        this._warned = true;
      }
      this.shaker.reset();
      this._snapAll();          // rewrites this.pose AND this.finalPose (=== p)
      if (!poseFinite(p)) {
        p.position.set(0, 1.2, 2.4);
        p.quaternion.identity();
        p.fov = CONFIG.render.fovBase;
        this.pose.copy(p);
      }
    }

    cam.position.copy(p.position);
    cam.quaternion.copy(p.quaternion);
    if (cam.isPerspectiveCamera) {
      const fov = clamp(p.fov, 12, 130);
      if (Math.abs(cam.fov - fov) > 0.008) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    }
    // The camera is not in the scene graph, so nothing else will do this before
    // PostFX reads matrixWorld/matrixWorldInverse for motion blur and AO.
    cam.updateMatrixWorld(true);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  }

  /** Hand the render system everything it needs from us. */
  _publish(dt, rawDt) {
    const target = clamp01(this.pose.speedIntensity);
    this._speedIntensity = damp(this._speedIntensity, target, 7, Math.max(rawDt, 1e-4));

    const renderer = this.game?.renderer;
    const postfx = renderer?.postfx;
    if (!postfx) return;

    if (this.driveSpeedFx) {
      try { postfx.setSpeedIntensity(this._speedIntensity); } catch (err) { /* ignore */ }
    }

    if (this.pose.cut) {
      this.pose.cut = false;
      try { postfx.resetHistory(); } catch (err) { /* ignore */ }
    }

    if (this.driveDof) {
      const want = clamp01(this.pose.dofIntensity);
      if (want > 0.002) {
        this._dofOwned = true;
        try {
          if (this.pose.focusDistance > 0) {
            postfx.setDof({
              enabled: true, intensity: want,
              focusDistance: this.pose.focusDistance,
              focusRange: this.pose.focusRange,
              nearFalloff: this.pose.nearFalloff,
              farFalloff: this.pose.farFalloff,
              maxBlur: this.pose.maxBlur,
            });
          } else {
            postfx.setDof({
              enabled: true, intensity: want, autoFocus: true,
              focusRange: this.pose.focusRange,
              nearFalloff: this.pose.nearFalloff,
              farFalloff: this.pose.farFalloff,
              maxBlur: this.pose.maxBlur,
            });
          }
        } catch (err) { /* ignore */ }
      } else if (this._dofOwned) {
        this._releaseDof();
      }
    }
  }

  _releaseDof() {
    this._dofOwned = false;
    const postfx = this.game?.renderer?.postfx;
    if (!postfx) return;
    try { postfx.setDof({ enabled: false }); } catch (err) { /* ignore */ }
  }

  _cut() {
    const postfx = this.game?.renderer?.postfx;
    try { postfx?.resetHistory?.(); } catch (err) { /* ignore */ }
  }

  /**
   * Hard reset: every rig re-seeded onto the current car, the requested mode
   * activated immediately (no blend), the pose committed. Used at race start, on
   * respawn, when the follow target changes, and as the NaN recovery path.
   */
  _snapAll() {
    for (const k in this.rigs) {
      const rig = this.rigs[k];
      try { rig?.snap?.(this.ctx); } catch (err) { /* ignore */ }
    }
    const mode = this.mode;
    const rig = this.rigs[mode];
    const prevRig = this.rigs[this._activeMode] ?? null;
    if (prevRig && prevRig !== rig) this._deactivateRig(prevRig);
    if (rig) {
      try { rig.activate(this.ctx, null); } catch (err) { this._rigError(mode, 'activate', err); }
      try { rig.update(0, this.ctx, this._poseA); } catch (err) { this._rigError(mode, 'update', err); }
      this.pose.copy(this._poseA);
      this.finalPose.copy(this._poseA);
      this._hasPose = true;
      this._activeMode = mode;
      // The snap IS the transition — drop any queued blend.
      this._pending = null;
      this._dirty = false;
    }
    this._blend.dur = 0;
    this._blend.t = 0;
    if (this._blend.rig && this._blend.rig !== rig) this._deactivateRig(this._blend.rig);
    this._blend.rig = null;
    this._blend.frozen = false;
    this._cut();
  }

  _rigError(mode, phase, err) {
    this._errored ??= new Set();
    const key = `${mode}.${phase}`;
    if (this._errored.has(key)) return;
    this._errored.add(key);
    console.error(`[CameraDirector] rig "${mode}".${phase} threw (suppressed after this):`, err);
  }

  // ───────────────────────────────────────────────────────────── intro glue

  _finishIntro(blend) {
    // If the intro was pushed on top of a real view, popping it reveals that view;
    // if the intro IS the whole stack (the normal path), fall back to the base mode.
    this.removeMode('intro', blend);
    if (this.mode === 'intro' || this._stack.length === 0) {
      this.setMode(this.carState.valid ? this.baseMode : 'orbit', blend);
    }
    this._resolveIntro();
  }

  _cancelIntro() {
    if (this._stackHas('intro')) this.removeMode('intro', 0);
    this._resolveIntro();
  }

  _resolveIntro() {
    const r = this._introResolve;
    this._introResolve = null;
    this._introPromise = null;
    if (r) { try { r(); } catch (err) { /* ignore */ } }
  }

  // ────────────────────────────────────────────────────────── event handlers

  /** How loud should an event about `carId` be from where the camera is? */
  _proximity(carId, worldPoint) {
    const cs = this.carState;
    if (cs.valid && carId !== undefined && carId !== null && carId === cs.id) return 1;
    if (!worldPoint) return 0;
    _v2.set(worldPoint.x ?? 0, worldPoint.y ?? 0, worldPoint.z ?? 0);
    const d = _v2.distanceTo(this.pose.position);
    return clamp01(1 - d / 7) * 0.55;
  }

  _onCollision(e) {
    if (!e) return;
    const near = this._proximity(e.carId, e.worldPoint);
    if (near <= 0.01) return;
    const j = Math.abs(Number.isFinite(e.impulse) ? e.impulse : 0);
    if (j < 0.4) return;

    const trauma = clamp01((j - 0.4) * this.tuning.collisionShake) * near;
    if (trauma > 0.004) this.shake(trauma, 0.30 + trauma * 0.35);

    // Directional shove: away from the contact point, so a hit on the left flank
    // throws the camera to the right.
    if (e.worldPoint && this.carState.valid && near > 0.5) {
      _v.subVectors(this.carState.position, e.worldPoint);
      if (_v.lengthSq() > 1e-8) {
        this.shaker.addImpulse(_v, clamp(j * 0.09, 0, 3.2) * near);
      }
    }

    // Spectacular crash ⇒ slow-mo replay cut, heavily gated.
    const rel = Math.abs(Number.isFinite(e.relSpeed) ? e.relSpeed : 0);
    if (near > 0.9
      && j >= this.tuning.crashMinImpulse
      && rel >= this.tuning.crashMinSpeed
      && INTERRUPTIBLE.has(this.mode)
      && this._raceTime > 2.0
      && this.game.state === GameState.RACING
      && this._time - this._lastCrash > this.tuning.crashCooldown) {
      this._lastCrash = this._time;
      if (e.worldPoint) {
        this._crashPoint.set(e.worldPoint.x, e.worldPoint.y, e.worldPoint.z);
      } else {
        this._crashPoint.copy(this.carState.position);
      }
      this._hasCrashPoint = true;
      this.pushMode('replay', 0.10);
      try { this.game.slowMo?.(this.tuning.crashSlowMo, this.tuning.crashSlowMoTime); }
      catch (err) { /* ignore */ }
      try { this.game.renderer?.pulseSlowMo?.(0.8, 0.5); } catch (err) { /* ignore */ }
      try { this.game.input?.rumble?.(0.9, 0.6, 220); } catch (err) { /* ignore */ }
    }
  }

  _onPropHit(e) {
    if (!e) return;
    const near = this._proximity(e.carId, e.worldPoint);
    if (near <= 0.02) return;
    const j = Math.abs(Number.isFinite(e.impulse) ? e.impulse : 0);
    const trauma = clamp01((j - 0.3) * 0.03) * near;
    if (trauma > 0.004) this.shake(trauma, 0.22);
  }

  _onLand(e) {
    if (!e) return;
    const near = this._proximity(e.carId, e.worldPoint);
    if (near <= 0.02) return;
    this._lastLandEvent = this._time;
    this._applyLanding(Math.abs(Number.isFinite(e.impactSpeed) ? e.impactSpeed : 0), near);
  }

  /**
   * Landing kick. Reached either from the 'car:land' event or from our own
   * airborne→grounded edge detection (below), because a vehicle build that does
   * not emit the event should still land with a thump.
   */
  _applyLanding(v, near) {
    if (v < 1.6) return;
    const trauma = clamp01((v - 1.6) * this.tuning.landShake) * near;
    if (trauma > 0.004) {
      this.shake(trauma, 0.26 + trauma * 0.3);
      // A landing shoves the camera down, then it springs back up.
      this.shaker.addImpulse(DOWN, clamp(v * 0.055, 0, 2.2) * near, 0.35);
    }
    if (near > 0.9) {
      this._landGrace = 0.25;
      if (this.mode === 'bigair') this.popMode(0.26);
      try { this.game.input?.rumble?.(clamp01(v / 12), clamp01(v / 18), 90); }
      catch (err) { /* ignore */ }
    }
  }

  /**
   * Derive the landing impact ourselves from the airborne flag and the fall speed.
   * Skipped if a 'car:land' event arrived recently, so we never double-thump.
   */
  _detectLanding(dt) {
    const cs = this.carState;
    if (!cs.valid) { this._wasAirborne = false; this._fallVy = 0; return; }
    if (cs.airborne) {
      if (!this._wasAirborne) this._fallVy = 0;
      this._wasAirborne = true;
      if (cs.velocity.y < this._fallVy) this._fallVy = cs.velocity.y;
      return;
    }
    if (!this._wasAirborne) return;
    this._wasAirborne = false;
    const impact = Math.abs(this._fallVy);
    this._fallVy = 0;
    if (this._time - this._lastLandEvent < 0.3) return;   // the vehicle told us already
    this._applyLanding(impact, 1);
  }

  _onAirborne(e) {
    if (!e) return;
    // Some vehicle implementations emit this at takeoff with a predicted duration;
    // honour it as an early trigger for the big-air cut.
    const cs = this.carState;
    if (!cs.valid || e.carId !== cs.id) return;
    const dur = Number.isFinite(e.duration) ? e.duration : 0;
    const height = Number.isFinite(e.height) ? e.height : 0;
    if (dur < this.tuning.bigAirMinTime && height < 0.9) return;
    if (!INTERRUPTIBLE.has(this.mode)) return;
    if (this.game.state !== GameState.RACING && this.game.state !== GameState.FINISHED) return;
    if (this._time - this._lastBigAir <= this.tuning.bigAirCooldown) return;
    if (cs.speedFrac < this.tuning.bigAirMinSpeed) return;
    this._lastBigAir = this._time;
    this._landGrace = 0;
    this.pushMode('bigair', 0.26);
  }

  _onWeaponHit(e) {
    if (!e) return;
    const near = this._proximity(e.carId, e.worldPoint);
    if (near <= 0.02) return;
    const j = Math.abs(Number.isFinite(e.impulse) ? e.impulse : 1);
    const trauma = clamp01(this.tuning.weaponShake * (0.5 + clamp01(j / 12) * 0.9)) * near;
    this.shake(trauma, 0.42);
    if (e.worldPoint && this.carState.valid) {
      _v.subVectors(this.carState.position, e.worldPoint);
      if (_v.lengthSq() > 1e-8) this.shaker.addImpulse(_v, clamp(1.2 + j * 0.12, 0, 4) * near, 1.4);
    }
    if (near > 0.9) {
      try { this.game.input?.rumble?.(0.85, 0.5, 200); } catch (err) { /* ignore */ }
    }
  }

  _onRespawn(e) {
    const cs = this.carState;
    if (e && cs.valid && e.carId !== undefined && e.carId !== cs.id) return;
    this.carState.reset();
    this.shaker.reset();
    this._hasCrashPoint = false;
    this._wasAirborne = false;
    this._fallVy = 0;
    this._refreshContext(0, 0, 0);
    // Drop any transient cut and snap the chosen view behind the car.
    if (this._stack.length > 1) {
      this._stack.length = 1;
      this._request(0);
    }
    this._snapAll();
  }

  // ───────────────────────────────────────────────────────────── tiny timers

  /** Run `fn` after `seconds` of wall-clock time (survives pause/slow-mo). */
  _after(seconds, fn) {
    this._timers.push({ at: this._time + Math.max(seconds, 0), fn });
  }

  _runTimers() {
    for (let i = this._timers.length - 1; i >= 0; i--) {
      if (this._time >= this._timers[i].at) {
        const t = this._timers[i];
        this._timers.splice(i, 1);
        try { t.fn(); } catch (err) { console.error('[CameraDirector] timer threw:', err); }
      }
    }
  }
}

function poseFinite(p) {
  return Number.isFinite(p.position.x) && Number.isFinite(p.position.y)
    && Number.isFinite(p.position.z) && Number.isFinite(p.quaternion.x)
    && Number.isFinite(p.quaternion.w) && Number.isFinite(p.fov);
}

const DOWN = Object.freeze(new THREE.Vector3(0, -1, 0));
const DEBUG_CYCLE = Object.freeze([...CYCLE_MODES, 'free']);

export default CameraDirector;
