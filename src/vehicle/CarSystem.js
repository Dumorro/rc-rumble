/**
 * RC RUMBLE — CarSystem.
 *
 * Registered as `game.carSystem`. Owns the field of cars: spawning them on the
 * grid, driving the player from `game.input`, driving everyone else with an
 * `AIDriver`, stepping the vehicle simulation, updating the visuals, running
 * the respawn manager, and turning per-wheel state changes into the canonical
 * EventBus messages that FX, audio and the camera listen for.
 *
 * Event payloads are pooled (32-entry rings). Read them synchronously or copy
 * what you need — never retain one.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { Layer, createRayHit, SURFACE_FRICTION } from '../physics/index.js';

import { Car, SURFACE_ROLL } from './Car.js';
import { CAR_DEFS, getCarDef, pickOpponents, DISPLAY_SPEED_SCALE } from './CarDefs.js';
import { buildCarModel } from './CarBodies.js';
import { AIDriver, buildAIPath } from './AIDriver.js';
import { Respawn } from './Respawn.js';

// ═══════════════════════════════════════════════════════════════════════════
// Scratch
// ═══════════════════════════════════════════════════════════════════════════

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _hit = createRayHit();

const EVENT_RING = 32;
/** Minimum seconds between repeated 'car:drift' emissions per car. */
const DRIFT_PERIOD = 1 / 20;
/** Minimum seconds between repeated 'car:airborne' emissions per car. */
const AIR_PERIOD = 1 / 4;
/** A wheel must be loaded at least this much to raise a contact event. */
const CONTACT_LOAD_EPS = 0.05;

export class CarSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {Car[]} */
    this.cars = [];
    /** @type {Car|null} */
    this.playerCar = null;
    /** @type {import('./AIDriver.js').AIPath|null} shared racing line */
    this.aiPath = null;
    this.respawn = new Respawn(game, this);

    /** Per-surface grip / rolling multipliers, rebuilt from TrackData. */
    this.gripTable = new Float32Array(SURFACE_FRICTION);
    this.rollTable = new Float32Array(SURFACE_ROLL);

    /** Multiply |speed| by this for HUD "km/h". */
    this.displaySpeedScale = DISPLAY_SPEED_SCALE;

    /** Set while the countdown holds the field. */
    this.launchLocked = false;
    /** Global AI on/off (debug). */
    this.aiEnabled = true;
    /** Global sim on/off (debug). */
    this.enabled = true;

    this._track = null;
    this._buildEventPools();
    this._driftTimers = [];
    this._airTimers = [];

    /** Perf counters. */
    this.stats = { cars: 0, ai: 0, wheelContacts: 0, ms: 0 };
  }

  async init() {
    // Nothing to preload — every asset is generated on demand and memoised on
    // `game.assets`, so the first spawn pays for the geometry once.
  }

  // ═════════════════════════════════════════════════════════ catalogue

  /** The full car catalogue, for the car-select UI. Do not mutate. */
  listCars() { return CAR_DEFS; }

  /** @param {string} id @returns {object} CarDef (never null) */
  getDef(id) { return getCarDef(id); }

  /** @param {number} id @returns {Car|undefined} */
  getCar(id) { return this.cars.find((c) => c.id === id); }

  // ═════════════════════════════════════════════════════════ spawning

  /**
   * Build the field and place it on the grid.
   *
   * @param {object} track TrackData (may be a bare scaffold — this never throws)
   * @param {{carId?:string, opponents?:number, laps?:number,
   *          playerGridSlot?:number, mode?:string}} [raceConfig]
   * @returns {Promise<Car[]>} exactly one car has `isPlayer === true`
   */
  async spawnField(track, raceConfig = {}) {
    this.despawnAll();
    this._track = track ?? null;

    this._buildSurfaceTables(track);
    this.aiPath = buildAIPath(track);
    this.respawn.onRaceStart(track);

    const maxCars = CONFIG.race.maxCars ?? 8;
    const wanted = clamp(1 + (raceConfig.opponents ?? CONFIG.startup.opponents ?? 7), 1, maxCars);

    const playerDef = getCarDef(raceConfig.carId ?? CONFIG.startup.car);
    const rng = this.game?.rng;
    const oppIds = pickOpponents(playerDef.id, wanted - 1, rng);

    // Classic Re-Volt: the player starts at the back of the grid.
    const playerSlot = clamp(
      raceConfig.playerGridSlot ?? (wanted - 1), 0, wanted - 1,
    );

    const slots = this._gridSlots(track, wanted);
    const scene = this.game?.scene;
    const physics = this.game?.physics;

    let oppCursor = 0;
    for (let i = 0; i < wanted; i++) {
      const isPlayer = i === playerSlot;
      const def = isPlayer ? playerDef : getCarDef(oppIds[oppCursor++]);
      const car = new Car(this.game, def, {
        id: i,
        isPlayer,
        name: def.name,
        ...this._liveryFor(def, i, isPlayer),
      });
      car.raceNumber = i + 1;
      car.gridSlot = i;
      car.gripTable = this.gripTable;
      car.rollTable = this.rollTable;
      car.suspension.fallbackGroundY = slots[i].position.y;

      // Visuals.
      try {
        car.model = buildCarModel(this.game, car);
        car.shell = car.model.shell;
      } catch (err) {
        console.error('[CarSystem] failed to build a car model:', err);
        car.model = null;
        car.shell = null;
      }
      car.group.name = `car:${def.id}:${i}`;
      scene?.add(car.group);

      // Physics.
      physics?.addBody?.(car.body);

      // Place it.
      this._placeOnSlot(car, slots[i]);

      // Brain.
      if (!isPlayer) {
        const ai = new AIDriver(car, { seed: (CONFIG.seed ?? 1) + i * 7919 });
        ai.setPath(this.aiPath);
        ai.setShortcuts(track?.shortcuts ?? null);
        car.aiDriver = ai;
      } else {
        car.aiDriver = null;
        this.playerCar = car;
      }

      this.cars.push(car);
      this._driftTimers.push(0);
      this._airTimers.push(0);
    }

    if (!this.playerCar && this.cars.length) {
      this.cars[0].isPlayer = true;
      this.cars[0].aiDriver = null;
      this.playerCar = this.cars[0];
    }

    this.stats.cars = this.cars.length;
    this.stats.ai = this.cars.reduce((n, c) => n + (c.aiDriver ? 1 : 0), 0);
    return this.cars;
  }

  /** Remove every car from the scene and the physics world. */
  despawnAll() {
    const scene = this.game?.scene;
    const physics = this.game?.physics;
    for (const car of this.cars) {
      physics?.removeBody?.(car.body);
      scene?.remove(car.group);
      car.dispose();
    }
    this.cars.length = 0;
    this._driftTimers.length = 0;
    this._airTimers.length = 0;
    this.playerCar = null;
  }

  onRaceStart(ctx) {
    // The Game sets `game.playerCar` after spawnField; mirror it here so the
    // respawn manager and the AI rubber-band see the same car.
    if (ctx?.game?.playerCar) this.playerCar = ctx.game.playerCar;
    this.launchLocked = true;
    for (const car of this.cars) car.launchLocked = true;
  }

  onRaceEnd() {
    this.respawn.onRaceEnd();
    this.launchLocked = false;
  }

  // ═════════════════════════════════════════════════════════ grid

  /** Resolve `wanted` grid slots, synthesising extras if the track is short. */
  _gridSlots(track, wanted) {
    const src = Array.isArray(track?.startGrid) ? track.startGrid : [];
    const out = new Array(wanted);
    const base = src[0] ?? { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() };

    for (let i = 0; i < wanted; i++) {
      const s = src[i];
      if (s?.position) {
        out[i] = {
          position: new THREE.Vector3().copy(s.position),
          quaternion: s.quaternion ? new THREE.Quaternion().copy(s.quaternion) : new THREE.Quaternion(),
        };
        continue;
      }
      // Synthesise a staggered 2-wide grid behind the last real slot.
      const q = base.quaternion ? new THREE.Quaternion().copy(base.quaternion) : new THREE.Quaternion();
      _fwd.set(0, 0, -1).applyQuaternion(q);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const row = Math.floor(i / 2);
      const col = (i % 2) === 0 ? -1 : 1;
      const p = new THREE.Vector3().copy(base.position)
        .addScaledVector(_fwd, -row * 0.55 - 0.28)
        .addScaledVector(right, col * 0.22);
      out[i] = { position: p, quaternion: q };
    }
    return out;
  }

  /** Drop a car onto its slot, snapped to the real floor. */
  _placeOnSlot(car, slot) {
    _pos.copy(slot.position);
    _quat.copy(slot.quaternion);

    const physics = this.game?.physics;
    if (physics?.raycastTrack && physics.staticMeshes?.length) {
      _origin.copy(_pos);
      _origin.y += 0.50;
      if (physics.raycastTrack(_origin, _down, 2.5, _hit) && _hit.normal.y > 0.4) {
        _pos.copy(_hit.point);
      }
    }
    _pos.y += car.def.comHeight + 0.006;
    car.hardReset(_pos, _quat);
    car.suspension.fallbackGroundY = _pos.y - car.def.comHeight;
  }

  /**
   * Give duplicate cars a distinguishable livery so a grid of eight Toyecas is
   * still readable. The player always keeps the catalogue colours.
   */
  _liveryFor(def, index, isPlayer) {
    if (isPlayer) return { colorPrimary: def.colorPrimary, colorSecondary: def.colorSecondary };
    const palette = LIVERIES[index % LIVERIES.length];
    return { colorPrimary: palette[0], colorSecondary: palette[1] };
  }

  // ═════════════════════════════════════════════════════════ surfaces

  /**
   * Merge the track's SurfaceTable over the canonical defaults so a track can
   * make its own ice slippier or its own carpet draggier.
   */
  _buildSurfaceTables(track) {
    this.gripTable.set(SURFACE_FRICTION);
    this.rollTable.set(SURFACE_ROLL);
    const t = track?.surfaces;
    if (!t) return;
    for (let i = 0; i < 16; i++) {
      let s = null;
      if (Array.isArray(t)) s = t[i];
      else if (typeof t.get === 'function') s = t.get(i);
      else s = t[i];
      if (!s) continue;
      if (typeof s.grip === 'number' && s.grip > 0) this.gripTable[i] = clamp(s.grip, 0.02, 3);
      if (typeof s.rollingResistance === 'number' && s.rollingResistance >= 0) {
        // Authors may give either an absolute coefficient or a multiplier.
        const rr = s.rollingResistance;
        this.rollTable[i] = clamp(rr > 0.2 ? rr : rr / 0.018, 0.05, 8);
      }
    }
  }

  // ═════════════════════════════════════════════════════════ step

  /** @param {number} dt always CONFIG.physics.fixedDt */
  fixedUpdate(dt) {
    if (!this.enabled) return;
    const t0 = CONFIG.debug ? performance.now() : 0;
    const game = this.game;
    const controlsLive = game?.controlsLive !== false;
    this.launchLocked = !controlsLive;

    const input = game?.input?.state;

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.launchLocked = this.launchLocked;

      if (car.isPlayer) {
        if (input && !car.finished) {
          car.applyControl(input);
        } else if (car.finished) {
          // Post-finish: coast to a stop rather than freeze mid-corner.
          car.applyControl(COAST);
        }
      } else if (this.aiEnabled && car.aiDriver) {
        car.aiDriver.update(dt);
      }

      car.fixedUpdate(dt);
    }

    this.respawn.fixedUpdate(dt);
    this._emitEvents(dt);

    if (t0) this.stats.ms = performance.now() - t0;
  }

  /** @param {number} dt @param {number} alpha */
  update(dt, alpha) {
    if (!this.enabled) return;
    for (let i = 0; i < this.cars.length; i++) {
      this.cars[i].updateVisual(dt, alpha);
    }
  }

  // ═════════════════════════════════════════════════════════ events

  _buildEventPools() {
    const mk = (extra) => {
      const ring = new Array(EVENT_RING);
      for (let i = 0; i < EVENT_RING; i++) ring[i] = extra();
      return { ring, i: 0 };
    };
    this._contactPool = mk(() => ({
      carId: 0, wheelIndex: 0, surfaceId: 0, slip: 0, load: 0,
      worldPoint: new THREE.Vector3(), normal: new THREE.Vector3(),
    }));
    this._airPool = mk(() => ({ carId: 0, duration: 0, height: 0 }));
    this._landPool = mk(() => ({ carId: 0, impactSpeed: 0, worldPoint: new THREE.Vector3() }));
    this._driftPool = mk(() => ({ carId: 0, angle: 0, intensity: 0 }));
  }

  _next(pool) {
    const e = pool.ring[pool.i];
    pool.i = (pool.i + 1) % EVENT_RING;
    return e;
  }

  _emitEvents(dt) {
    const bus = this.game?.bus;
    if (!bus) return;
    let contacts = 0;

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];

      // ── wheel contacts (begin, or a change of surface) ──
      for (let w = 0; w < 4; w++) {
        const wheel = car.wheels[w];
        if (!(wheel.contactBegan || wheel.surfaceChanged)) continue;
        if (wheel.load < CONTACT_LOAD_EPS && !wheel.contactBegan) continue;
        const e = this._next(this._contactPool);
        e.carId = car.id;
        e.wheelIndex = w;
        e.surfaceId = wheel.surfaceId;
        e.slip = wheel.skidIntensity;
        e.load = wheel.load;
        e.worldPoint.copy(wheel.contactPoint);
        e.normal.copy(wheel.contactNormal);
        bus.emit('car:wheelContact', e);
        contacts++;
      }

      // ── airborne / landing ──
      if (car.tookOffThisStep) {
        this._airTimers[i] = 0;
        const e = this._next(this._airPool);
        e.carId = car.id;
        e.duration = 0;
        e.height = 0;
        bus.emit('car:airborne', e);
      } else if (car.airborne) {
        this._airTimers[i] += dt;
        if (this._airTimers[i] >= AIR_PERIOD) {
          this._airTimers[i] = 0;
          const e = this._next(this._airPool);
          e.carId = car.id;
          e.duration = car.airTime;
          e.height = car.airHeight;
          bus.emit('car:airborne', e);
        }
      }
      if (car.landedThisStep) {
        this._airTimers[i] = 0;
        const e = this._next(this._landPool);
        e.carId = car.id;
        e.impactSpeed = car.lastLandImpact;
        e.worldPoint.copy(car.body.position);
        bus.emit('car:land', e);
      }

      // ── drifting (continuous, throttled to 20 Hz) ──
      if (car.driftFactor > 0.15 && car.wheelsOnGround >= 2) {
        this._driftTimers[i] += dt;
        if (this._driftTimers[i] >= DRIFT_PERIOD) {
          this._driftTimers[i] = 0;
          const e = this._next(this._driftPool);
          e.carId = car.id;
          e.angle = car.slipAngle;
          e.intensity = car.driftFactor;
          bus.emit('car:drift', e);
        }
      } else {
        this._driftTimers[i] = DRIFT_PERIOD;   // fire immediately next time
      }
    }
    this.stats.wheelContacts = contacts;
  }

  // ═════════════════════════════════════════════════════════ helpers

  /**
   * Runtime AI difficulty override, 0 (hopeless) .. 1 (sharp).
   * @param {number} skill
   */
  setAISkill(skill) {
    const s = clamp01(skill);
    for (const car of this.cars) {
      const ai = car.aiDriver;
      if (!ai) continue;
      ai.skill = s;
      ai.reactionDelay = 0.185 + (0.028 - 0.185) * s;
      ai.delaySteps = clamp(Math.round(ai.reactionDelay / CONFIG.physics.fixedDt), 0, 31);
      ai.cornerMult = 0.795 + (1.030 - 0.795) * s;
      ai.brakeMult = 0.86 + (1.06 - 0.86) * s;
      ai.errorAmp = 0.30 + (0.045 - 0.30) * s;
      ai.slipComp = 0.30 + (0.72 - 0.30) * s;
      ai.yawDamp = 0.020 + (0.052 - 0.020) * s;
    }
  }

  /** Hand control of a car to the AI (used by the attract-mode camera). */
  setAutopilot(car, on) {
    if (!car) return;
    if (on && !car.aiDriver) {
      const ai = new AIDriver(car, { seed: car.id * 104729 + 7 });
      ai.setPath(this.aiPath);
      ai.setShortcuts(this._track?.shortcuts ?? null);
      car.aiDriver = ai;
    } else if (!on && car.aiDriver && car.isPlayer) {
      car.aiDriver = null;
    }
  }

  /** Total lateral grip currently available to a car — handy for the HUD. */
  gripUsage(car) { return car ? car.gripUsage : 0; }

  dispose() {
    this.despawnAll();
    this.aiPath = null;
    this._track = null;
  }
}

/** Zeroed control used after the player finishes. */
const COAST = Object.freeze({ throttle: 0, brake: 0.18, steer: 0, handbrake: 0, fire: false });

/**
 * Opponent liveries. Bright, saturated and clearly distinct at RC scale — you
 * have to be able to tell who just punted you.
 */
const LIVERIES = [
  [0xe23b2c, 0x22262e],
  [0x2f8fdd, 0xf2f4f7],
  [0x3fbf6a, 0x1c2a20],
  [0xf5a51b, 0x2a2118],
  [0x9b4ddb, 0xf0e6ff],
  [0xff5fa2, 0x33121f],
  [0x18c8c0, 0x0f2b2a],
  [0xf2f4f7, 0xd42d2d],
];

export { Car, AIDriver, Respawn, CAR_DEFS, getCarDef, Layer };
export default CarSystem;
