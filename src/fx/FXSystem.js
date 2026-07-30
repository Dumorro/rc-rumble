/**
 * RC RUMBLE — FX system. `game.fx`.
 *
 * Owns the particle engine and every effect subsystem, subscribes to the
 * canonical EventBus names, and exposes an imperative API for anything that
 * wants to trigger an effect directly.
 *
 * ```js
 * game.fx.burst('explosion', worldPoint, { strength: 1.2, normal });
 * const e = game.fx.emitter({ style: 'fx/smoke/tyre', follow: car.group, rate: 40 });
 * e.stop();                       // stop emitting, let the particles live out
 * e.release();                    // return the emitter to the pool
 * game.fx.clear();
 * ```
 *
 * Everything is surface-aware through `SurfaceFX.js`, which maps the canonical
 * surface ids (ARCHITECTURE.md, 0–15) onto colours, spray archetypes, mark styles
 * and material properties.
 *
 * Budget: 1.5 ms CPU. A load governor measures this system's own wall-clock cost
 * every frame and scales every emitter's rate, so a 20-car pile-up on gravel
 * degrades gracefully instead of dropping the frame.
 *
 * Everything degrades to a no-op if a collaborator is missing: no track, no cars,
 * no renderer, no physics — the system still boots and still runs.
 */

import * as THREE from 'three';
import CONFIG, { q } from '../core/Config.js';
import { clamp, clamp01, lerp, damp } from '../core/MathUtils.js';

import { ParticleSystem, LAYER, frand, frandRange, toLinearRGB } from './ParticleSystem.js';
import { particleAtlas, SPR } from './ParticleAtlas.js';
import { TireMarks } from './TireMarks.js';
import { Decals, DECAL } from './Decals.js';
import { Sparks, resetOpts } from './Sparks.js';
import { Dust } from './Dust.js';
import { Splash } from './Splash.js';
import { Smoke } from './Smoke.js';
import { Impacts } from './Impacts.js';
import { Nitro } from './Nitro.js';
import { Weather } from './Weather.js';
import { surfaceFX, isWater, SPRAY } from './SurfaceFX.js';

/** Slot count for every per-car array in the FX system. The `& (MAX_CARS-1)`
 *  masks below require a power of two, and 8 is the contract's maximum. */
const MAX_CARS = Math.max(8, 1 << Math.ceil(Math.log2(Math.max(CONFIG.race.maxCars, 8))));

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Weapon id → how its hit should look. */
const WEAPON_FX = Object.freeze({
  firework: { kind: 'explosion', strength: 0.85, color: 0xffb060, shake: 0.55 },
  rocket: { kind: 'explosion', strength: 1.05, color: 0xffa040, shake: 0.7 },
  bomb: { kind: 'explosion', strength: 1.35, color: 0xffd0a0, shake: 0.95 },
  mine: { kind: 'explosion', strength: 1.0, color: 0xffc080, shake: 0.75 },
  electro: { kind: 'electro', strength: 0.9, color: 0x9fd8ff, shake: 0.35 },
  lightning: { kind: 'electro', strength: 1.0, color: 0xbfe8ff, shake: 0.4 },
  freeze: { kind: 'freeze', strength: 0.9, color: 0xcfefff, shake: 0.2 },
  oil: { kind: 'oil', strength: 0.7, color: 0x30303a, shake: 0.1 },
  ball: { kind: 'impact', strength: 0.8, color: 0xffe0a0, shake: 0.5 },
  water: { kind: 'splash', strength: 0.9, color: 0xdff0f8, shake: 0.25 },
});

/**
 * A cheap, pooled emitter descriptor. Never allocate one directly — take it from
 * `game.fx.emitter(desc)` and give it back with `release()`.
 */
class Emitter {
  constructor(fx) {
    this.fx = fx;
    this.inUse = false;
    this.reset();
  }

  reset() {
    this.styleId = -1;
    this.rate = 20;
    this.speed = 1;
    this.spread = 0.5;
    this.count = 1;                 // particles per emission tick
    this.active = true;
    this.life = Infinity;           // emitter lifetime, seconds
    this.age = 0;
    this.acc = 0;
    this.position = this.position || new THREE.Vector3();
    this.direction = this.direction || new THREE.Vector3(0, 1, 0);
    this.offset = this.offset || new THREE.Vector3();
    this.position.set(0, 0, 0);
    this.direction.set(0, 1, 0);
    this.offset.set(0, 0, 0);
    /** @type {THREE.Object3D|null} follow this object's world transform */
    this.follow = null;
    /** Also rotate `direction` by the followed object. */
    this.followRotation = true;
    this.radius = 0;
    this.speedJitter = 0.45;
    this.sizeMul = 1;
    this.lifeMul = 1;
    this.alpha = 1;
    this.r = 1; this.g = 1; this.b = 1;
    this.groundY = -1e6;
    this.inheritScale = 0;
    this.inheritX = 0; this.inheritY = 0; this.inheritZ = 0;
    this.onDone = null;
    return this;
  }

  /** Stop emitting; live particles are untouched. */
  stop() { this.active = false; return this; }
  start() { this.active = true; return this; }

  /** Give the emitter back to the pool. */
  release() {
    this.follow = null;
    this.onDone = null;
    this.active = false;
    this.inUse = false;
    this.fx?._emitterPool.push(this);
    return this;
  }

  /** @param {number} dt */
  _update(dt, rateScale) {
    this.age += dt;
    if (this.age >= this.life) {
      this.active = false;
      const cb = this.onDone;
      this.onDone = null;
      if (cb) { try { cb(this); } catch (err) { /* never let a callback kill FX */ } }
      return false;
    }
    if (!this.active || this.styleId < 0) return true;

    const P = this.fx?.particles;
    if (!P) return true;

    // resolve the world origin
    let px = this.position.x, py = this.position.y, pz = this.position.z;
    let dx = this.direction.x, dy = this.direction.y, dz = this.direction.z;
    if (this.follow) {
      _v.copy(this.offset).applyMatrix4(this.follow.matrixWorld);
      px = _v.x; py = _v.y; pz = _v.z;
      if (this.followRotation) {
        _v2.copy(this.direction).transformDirection(this.follow.matrixWorld);
        dx = _v2.x; dy = _v2.y; dz = _v2.z;
      }
    }

    this.acc += this.rate * rateScale * dt;
    let n = this.acc | 0;
    this.acc -= n;
    if (n <= 0) return true;
    if (n > 32) n = 32;

    const o = resetOpts(_emitOpts);
    o.speedJitter = this.speedJitter;
    o.radius = this.radius;
    o.sizeMul = this.sizeMul;
    o.lifeMul = this.lifeMul;
    o.alpha = this.alpha;
    o.r = this.r; o.g = this.g; o.b = this.b;
    o.groundY = this.groundY;
    o.inheritX = this.inheritX;
    o.inheritY = this.inheritY;
    o.inheritZ = this.inheritZ;

    P.burstCone(this.styleId, px, py, pz, dx, dy, dz,
      this.speed, this.spread, n * this.count, o);
    return true;
  }
}

/** Per-car contact bookkeeping, used to tell an impact from a scrape. */
class ContactState {
  constructor() {
    this.px = 0; this.py = 0; this.pz = 0;
    this.nx = 0; this.ny = 1; this.nz = 0;
    this.impulse = 0;
    this.peak = 0;
    this.surfaceId = 0;
    this.lastTime = -1e6;
    this.streak = 0;              // seconds of continuous contact
    this.fresh = false;
  }
  reset() {
    this.impulse = 0; this.peak = 0; this.lastTime = -1e6;
    this.streak = 0; this.fresh = false;
  }
}

export class FXSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.enabled = true;
    this.time = 0;

    /** Root of everything this system adds to the scene. */
    this.root = new THREE.Group();
    this.root.name = 'fx';
    this.root.matrixAutoUpdate = false;
    this.root.frustumCulled = false;

    /** @type {ParticleSystem|null} */
    this.particles = null;
    /** @type {TireMarks|null} */
    this.tireMarks = null;
    /** @type {Decals|null} */
    this.decals = null;
    /** @type {Sparks|null} */
    this.sparks = null;
    /** @type {Dust|null} */
    this.dust = null;
    /** @type {Splash|null} */
    this.splash = null;
    /** @type {Smoke|null} */
    this.smoke = null;
    /** @type {Impacts|null} */
    this.impacts = null;
    /** @type {Nitro|null} */
    this.nitro = null;
    /** @type {Weather|null} */
    this.weather = null;

    this.atlas = null;

    /** @type {Emitter[]} */
    this._emitters = [];
    /** @type {Emitter[]} */
    this._emitterPool = [];

    /** @type {ContactState[]} */
    this._contacts = [];
    for (let i = 0; i < MAX_CARS; i++) this._contacts.push(new ContactState());

    /** Drift intensity reported by 'car:drift', as a fallback for car.driftFactor. */
    this._driftHint = new Float32Array(MAX_CARS);
    /** Airborne time per car, so a landing can be told from a scrape. */
    this._airTime = new Float32Array(MAX_CARS);

    /**
     * One-shot budget for the current frame. Eight cars can land, collide and
     * be hit by a rocket in the same 8 ms, and the difference between three
     * simultaneous debris showers and eight is invisible — but it is the
     * difference between a smooth frame and a dropped one. Credits are spent by
     * discrete impact events and refilled once per `update()`.
     */
    this._credits = 0;
    this.creditsPerFrame = 3;

    /** Load governor. */
    this.load = 1;
    this.budgetMs = 1.5;
    this._ms = 0.4;
    this._msPeak = 0.4;
    /**
     * Frames to ignore before the governor is allowed an opinion. The first
     * frames of a race pay for JIT warm-up, the first texture uploads and the
     * first GC, and none of that is a reason to spend the whole race at a
     * quarter of the particle budget.
     */
    this._warmup = 45;

    this._unsub = [];
    this._genericStyles = {};

    this.stats = {
      ms: 0, load: 1, particles: 0, capacity: 0,
      emitters: 0, marks: 0, decals: 0, debris: 0, dropped: 0,
    };
  }

  // ══════════════════════════════════════════════════════════ lifecycle

  async init() {
    const assets = this.game?.assets;
    const tileSize = CONFIG.quality === 'low' ? 64 : (CONFIG.quality === 'ultra' ? 192 : 128);
    this.atlas = particleAtlas(assets, { tileSize });

    // ── particle engine ──
    this.particles = new ParticleSystem(this.game, { max: q(CONFIG.fx.maxParticles) });
    this.particles.init();
    this.particles.attach(this.root);

    // ── persistent surface effects ──
    this.tireMarks = new TireMarks(this.game, { atlas: this.atlas });
    this.tireMarks.init();
    this.tireMarks.attach(this.root);

    this.decals = new Decals(this.game, { atlas: this.atlas, limit: CONFIG.fx.decalLimit });
    this.decals.init();
    this.decals.attach(this.root);

    // ── effect subsystems ──
    this.sparks = new Sparks(this.game, this.particles);
    this.sparks.init();
    this.sparks.attach(this.root);

    this.dust = new Dust(this.game, this.particles);
    this.dust.init();

    this.splash = new Splash(this.game, this.particles, this.decals);
    this.splash.init();

    this.smoke = new Smoke(this.game, this.particles);
    this.smoke.init();

    this.impacts = new Impacts(this.game, this.particles, this.decals);
    this.impacts.init();
    this.impacts.attach(this.root);

    this.nitro = new Nitro(this.game, this.particles);
    this.nitro.init();

    this.weather = new Weather(this.game, this.particles);
    this.weather.init(this.atlas);
    this.weather.attach(this.root);

    this._defineGenericStyles();

    this.game.scene.add(this.root);
    this._subscribe();

    if (CONFIG.debug) console.log('[FX] ready:', this.particles.stats.capacity, 'particles');
    return this;
  }

  /** Styles the imperative API needs that no subsystem owns. */
  _defineGenericStyles() {
    const P = this.particles;
    if (!P) return;
    const S = this._genericStyles;
    const GRAV = CONFIG.physics.gravity;

    // pickup sparkle
    S.sparkle = P.defineStyle('fx/pickup/sparkle', {
      layer: LAYER.ADD,
      sprite: SPR.FLARE,
      life: [0.32, 0.68],
      size: [0.006, 0.016],
      sizeCurve: [0.4, 1.2, 0.9, 0.2],
      alpha: 1,
      alphaCurve: [1, 0.95, 0.5, 0],
      color: 0xfff4c8,
      colorEnd: 0xffb840,
      colorCurve: [3.4, 2.2, 1.0, 0],
      gravity: GRAV * 0.10,
      drag: 1.8,
      rise: 0.9,
      spin: [-6, 6],
    });

    S.ring = P.defineStyle('fx/pickup/ring', {
      layer: LAYER.ADD,
      sprite: SPR.RING_SOFT,
      life: [0.26, 0.42],
      size: [0.05, 0.09],
      sizeCurve: [0.25, 1.4, 2.4, 3.2],
      alpha: 0.85,
      alphaCurve: [1, 0.7, 0.3, 0],
      color: 0xfff0c0,
      colorCurve: [2.6, 1.6, 0.6, 0],
      drag: 5,
    });

    // electro arcs
    S.arc = P.defineStyle('fx/weapon/arc', {
      layer: LAYER.ADD,
      sprite: SPR.ELECTRIC, frames: 3, frameMode: 'loop', fps: 22,
      life: [0.10, 0.26],
      size: [0.012, 0.038],
      aspect: 2.1,
      alpha: 1,
      alphaCurve: [1, 0.85, 0.5, 0],
      color: 0xdff4ff,
      colorEnd: 0x5fa8ff,
      colorCurve: [4.5, 3.0, 1.4, 0],
      gravity: 0,
      drag: 3.5,
      spin: [-4, 4],
    });

    S.arcGlow = P.defineStyle('fx/weapon/arcGlow', {
      layer: LAYER.ADD,
      sprite: SPR.GLOW,
      life: [0.14, 0.30],
      size: [0.02, 0.055],
      sizeCurve: [0.5, 1.3, 1.0, 0.3],
      alpha: 1,
      alphaCurve: [1, 0.8, 0.35, 0],
      color: 0xa8dcff,
      colorCurve: [3.5, 2.2, 0.9, 0],
      drag: 4,
    });

    // freeze crystals
    S.frost = P.defineStyle('fx/weapon/frost', {
      layer: LAYER.ALPHA,
      sprite: SPR.SHARD,
      life: [0.5, 1.1],
      size: [0.005, 0.014],
      alpha: 0.85,
      alphaCurve: [1, 1, 0.7, 0],
      color: 0xe8f8ff,
      colorEnd: 0x9fd0ea,
      gravity: GRAV * 0.5,
      drag: 1.2,
      bounce: 0.25,
      spin: [-14, 14],
    });

    S.frostMist = P.defineStyle('fx/weapon/frostMist', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.7, 1.5],
      size: [0.03, 0.07],
      sizeCurve: [0.35, 1.2, 2.0, 2.7],
      alpha: 0.34,
      alphaCurve: [0, 1, 0.6, 0],
      color: 0xdaf2ff,
      gravity: GRAV * 0.02,
      drag: 2.6,
      rise: 0.35,
      turbulence: 1.8, turbScale: 4.5,
    });

    // confetti (finish line, podium)
    S.confetti = P.defineStyle('fx/confetti', {
      layer: LAYER.ALPHA,
      sprite: SPR.CHIP, frames: 4, frameMode: 'random',
      life: [2.2, 4.6],
      size: [0.006, 0.014],
      aspect: 1.6,
      alpha: 1,
      alphaCurve: [1, 1, 1, 0],
      gravity: GRAV * 0.055,
      drag: 1.5,
      turbulence: 1.6, turbScale: 2.2, turbSpeed: 0.8,
      spin: [-12, 12],
      bounce: 0.05,
      stick: true,
      fadeOnStop: true,
      sizeJitter: 0.4,
    });

    // generic bright pop, used by burst('flash')
    S.pop = P.defineStyle('fx/pop', {
      layer: LAYER.ADD,
      sprite: SPR.GLOW,
      life: [0.09, 0.20],
      size: [0.03, 0.08],
      sizeCurve: [0.4, 1.3, 1.0, 0.3],
      alpha: 1,
      alphaCurve: [1, 0.85, 0.35, 0],
      color: 0xffffff,
      colorCurve: [4.0, 2.4, 1.0, 0],
      drag: 6,
    });

    // generic ground ripple, used by burst('ripple')
    S.ripple = P.defineStyle('fx/ripple', {
      layer: LAYER.GROUND,
      sprite: SPR.RIPPLE,
      life: [0.8, 1.5],
      size: [0.03, 0.06],
      sizeCurve: [0.25, 1.5, 2.8, 4.0],
      alpha: 0.40,
      alphaCurve: [0.9, 0.7, 0.35, 0],
      color: 0xcfe8f4,
      colorCurve: [1.1, 0.9, 0.6, 0.3],
    });
  }

  // ══════════════════════════════════════════════════════════ events

  _subscribe() {
    const bus = this.game?.bus;
    if (!bus) return;
    const on = (name, fn) => this._unsub.push(bus.on(name, fn));

    on('car:collision', (e) => this._onCarCollision(e));
    on('prop:hit', (e) => this._onPropHit(e));
    on('car:land', (e) => this._onLand(e));
    on('car:airborne', (e) => this._onAirborne(e));
    on('car:respawn', (e) => this._onRespawn(e));
    on('car:drift', (e) => this._onDrift(e));
    on('car:wheelContact', (e) => this._onWheelContact(e));
    on('weapon:hit', (e) => this._onWeaponHit(e));
    on('pickup:collected', (e) => this._onPickup(e));
    on('pickup:used', (e) => this._onPickupUsed(e));
    on('race:finish', (e) => this._onFinish(e));
    on('physics:trigger', () => { /* reserved: trigger volumes have no FX yet */ });
  }

  /**
   * Physics fires this once per body pair per step for the loudest contact, so a
   * sustained wall-grind arrives as a stream of small-impulse events at 120 Hz
   * and a real crash as one big one. Telling them apart is what makes a scrape
   * shower sparks instead of exploding.
   *
   * NOTE: the payload is pooled — read it here, never retain it.
   */
  _onCarCollision(e) {
    if (!this.enabled || !e) return;
    const id = (e.carId | 0) & (MAX_CARS - 1);
    const st = this._contacts[id];
    if (!st) return;

    const p = e.worldPoint;
    const n = e.normal;
    const impulse = Math.abs(e.impulse ?? 0);
    const relSpeed = Math.abs(e.relSpeed ?? 0);

    const gap = this.time - st.lastTime;
    st.lastTime = this.time;
    if (p) { st.px = p.x; st.py = p.y; st.pz = p.z; }
    if (n) { st.nx = n.x; st.ny = n.y; st.nz = n.z; }
    st.surfaceId = e.surfaceId | 0;
    st.impulse = impulse;
    if (impulse > st.peak) st.peak = impulse;
    st.fresh = true;
    st.streak = gap < 0.06 ? st.streak + gap : 0;

    // A discrete impact: either the first contact after a gap, or a genuinely
    // hard hit in the middle of a scrape.
    const discrete = gap > 0.13 || impulse > 3.2;
    if (!discrete || !p) return;

    if (this._impactScale(p) <= 0) return;

    const car = this._car(e.carId);
    const chassis = car?.def?.chassis ?? 'plastic';
    const vel = car?.body?.velocity ?? null;
    const surfaceId = st.surfaceId;

    this.impacts?.collision(p, n, impulse, relSpeed, surfaceId, chassis,
      car?.def?.colorPrimary);
    this.sparks?.impact(p, n, impulse, relSpeed, surfaceId, chassis, vel);

    // Landing in water from a side-swipe still needs a splash.
    if (isWater(surfaceId) && relSpeed > 1.4) {
      this.splash?.bigSplash(p, clamp01(relSpeed / 7), vel, e.carId | 0);
    }

    // Camera shake for the player only — the camera owns the actual response.
    if (impulse > 2.2 && car && car.isPlayer) {
      this.impacts?.shake(clamp01((impulse - 2.2) / 16) * 0.9, 0.28);
    }
  }

  /** Props get the same treatment, minus the car-specific bits. */
  _onPropHit(e) {
    if (!this.enabled || !e) return;
    const p = e.worldPoint;
    if (!p) return;
    const impulse = Math.abs(e.impulse ?? 0);
    if (impulse < 0.5) return;
    const relSpeed = Math.abs(e.relSpeed ?? 0);
    const surfaceId = e.surfaceId | 0;
    if (this._impactScale(p) <= 0) return;

    // Props are toys: plastic unless the prop says otherwise.
    const chassis = e.body?.userData?.chassis ?? e.other?.chassis ?? 'plastic';
    this.impacts?.collision(p, e.normal, impulse * 0.8, relSpeed, surfaceId, chassis,
      e.body?.userData?.color);
    if (impulse > 1.2) {
      this.sparks?.impact(p, e.normal, impulse * 0.7, relSpeed, surfaceId, chassis, null);
    }
    // Knocking a prop over disturbs whatever is in the air around it.
    if (impulse > 2.0) this.weather?.disturb(p, Math.round(clamp(impulse, 3, 10)));
  }

  _onLand(e) {
    if (!this.enabled || !e) return;
    const p = e.worldPoint;
    const impact = Math.abs(e.impactSpeed ?? 0);
    const id = (e.carId | 0) & (MAX_CARS - 1);
    this._airTime[id] = 0;
    if (!p || impact < 1.2) return;
    if (this._impactScale(p) <= 0) return;

    // What did we land on? The event does not say, so ask physics.
    let surfaceId = 0;
    const physics = this.game?.physics;
    if (physics?.surfaceBelow) {
      _v.set(p.x, p.y + 0.05, p.z);
      surfaceId = physics.surfaceBelow(_v, 0.35) | 0;
    }

    _n.set(0, 1, 0);
    if (physics?.raycastTrack) {
      _v.set(p.x, p.y + 0.08, p.z);
      _v2.set(0, -1, 0);
      if (physics.raycastTrack(_v, _v2, 0.5, _landHit)) {
        _n.copy(_landHit.normal);
        surfaceId = _landHit.surfaceId | 0;
      }
    }

    this.impacts?.landing(p, _n, impact, surfaceId);
    this.dust?.landingPuff(surfaceId, p, _n, impact);

    if (isWater(surfaceId)) {
      const car = this._car(e.carId);
      this.splash?.bigSplash(p, clamp01(impact / 8), car?.body?.velocity ?? null, e.carId | 0);
    }

    const car = this._car(e.carId);
    if (car?.isPlayer && impact > 4.5) {
      this.impacts?.shake(clamp01((impact - 4.5) / 12) * 0.75, 0.3);
    }
  }

  _onAirborne(e) {
    if (!e) return;
    const id = (e.carId | 0) & (MAX_CARS - 1);
    this._airTime[id] = e.duration ?? 0;
    // Leaving the ground breaks every ribbon this car was laying.
    this.tireMarks?.resetCar(e.carId | 0);
  }

  _onRespawn(e) {
    if (!e) return;
    const id = e.carId | 0;
    this.tireMarks?.resetCar(id);
    this.splash?.resetCar(id);
    const st = this._contacts[id & (MAX_CARS - 1)];
    st?.reset();
    this._driftHint[id & (MAX_CARS - 1)] = 0;

    // A little pop so a respawn does not look like a teleport glitch.
    const p = e.position;
    if (p && this.particles) {
      const o = resetOpts(_emitOpts);
      o.sizeMul = 1.2;
      this.particles.spawn(this._genericStyles.pop, p.x, p.y + 0.04, p.z, 0, 0, 0, o);
      o.speedJitter = 0.6;
      this.particles.burstCone(this._genericStyles.sparkle, p.x, p.y + 0.04, p.z,
        0, 1, 0, 0.9, 1.0, 12, o);
    }
  }

  _onDrift(e) {
    if (!e) return;
    const id = (e.carId | 0) & (MAX_CARS - 1);
    this._driftHint[id] = clamp01(e.intensity ?? 0);
  }

  /**
   * The vehicle system fires this per wheel. We poll wheels every frame for the
   * continuous effects, so this is only used for the *transition* cases: a wheel
   * slamming down hard enough to punch material out of the surface.
   */
  _onWheelContact(e) {
    if (!this.enabled || !e) return;
    const load = e.load ?? 0;
    const p = e.worldPoint;
    if (!p || load < 6) return;                 // N — a hard touchdown, not a roll
    const surfaceId = e.surfaceId | 0;
    const fx = surfaceFX(surfaceId);
    if (fx.splashy < 0.1) return;
    // Reuse the landing puff at a fraction of the strength.
    this.dust?.landingPuff(surfaceId, p, e.normal ?? null, clamp(load / 6, 1, 6));
  }

  _onWeaponHit(e) {
    if (!this.enabled || !e) return;
    const p = e.worldPoint;
    if (!p) return;
    const desc = WEAPON_FX[e.weaponId] ?? WEAPON_FX.firework;
    const strength = desc.strength * clamp(1 + (e.impulse ?? 0) / 20, 0.7, 2.0);

    // Ground normal under the hit, for scorch decals and rings.
    _n.set(0, 1, 0);
    const physics = this.game?.physics;
    if (physics?.raycastTrack) {
      _v.set(p.x, p.y + 0.05, p.z);
      _v2.set(0, -1, 0);
      if (physics.raycastTrack(_v, _v2, 0.6, _landHit)) _n.copy(_landHit.normal);
    }

    switch (desc.kind) {
      case 'explosion':
        this.impacts?.explosion(p, strength, _n);
        this.smoke?.explosion(p, strength, 0.14 + strength * 0.10);
        break;
      case 'electro':
        this._electro(p, strength);
        break;
      case 'freeze':
        this._freeze(p, strength, _n);
        break;
      case 'oil':
        this._oil(p, _n, strength);
        break;
      case 'splash':
        this.splash?.bigSplash(p, clamp01(strength), null, -1);
        break;
      case 'impact':
      default:
        this.impacts?.collision(p, _n, 6 + strength * 8, 4, 0, 'metal', desc.color);
        this.sparks?.impact(p, _n, 6 + strength * 8, 4, 11, 'metal', null);
        break;
    }

    const car = this._car(e.carId);
    if (car?.isPlayer) this.impacts?.shake(desc.shake, 0.35);
    else this.impacts?.shake(desc.shake * 0.30, 0.25);
  }

  _onPickup(e) {
    if (!this.enabled || !this.particles || !e) return;
    const car = this._car(e.carId);
    const grp = car?.group;
    if (!grp) return;
    _v.setFromMatrixPosition(grp.matrixWorld);

    const o = resetOpts(_emitOpts);
    o.sizeMul = 1.0;
    this.particles.spawn(this._genericStyles.ring, _v.x, _v.y + 0.05, _v.z, 0, 0, 0, o);
    o.speedJitter = 0.55;
    o.radius = 0.02;
    this.particles.burstCone(this._genericStyles.sparkle, _v.x, _v.y + 0.05, _v.z,
      0, 1, 0, 1.1, 1.0, 18, o);
  }

  _onPickupUsed(e) {
    if (!this.enabled || !e) return;
    const car = this._car(e.carId);
    const grp = car?.group;
    if (!grp || !this.particles) return;
    _v.setFromMatrixPosition(grp.matrixWorld);
    const o = resetOpts(_emitOpts);
    o.sizeMul = 0.8;
    this.particles.spawn(this._genericStyles.pop, _v.x, _v.y + 0.05, _v.z, 0, 0, 0, o);
  }

  _onFinish(e) {
    if (!this.enabled || !e) return;
    const car = this._car(e.carId);
    if (!car?.group || !this.particles) return;
    // Confetti only for the podium — eight cars finishing would bury the pool.
    if ((e.place | 0) > 3) return;
    _v.setFromMatrixPosition(car.group.matrixWorld);
    this.confetti(_v, 1 - (e.place - 1) * 0.25);
  }

  // ══════════════════════════════════════════════════════════ weapon looks

  _electro(point, strength) {
    const P = this.particles;
    if (!P) return;
    const s = clamp(strength, 0, 2);
    const o = resetOpts(_emitOpts);
    o.sizeMul = lerp(0.9, 1.8, s * 0.5);
    P.spawn(this._genericStyles.arcGlow, point.x, point.y, point.z, 0, 0, 0, o);

    o.speedJitter = 0.5;
    o.radius = 0.02;
    const arcs = Math.round(lerp(5, 16, s * 0.5) * this.load);
    for (let k = 0; k < arcs; k++) {
      const a = frand() * Math.PI * 2;
      const el = frandRange(-0.4, 1.0);
      const cl = Math.cos(el);
      o.rot = frand() * Math.PI * 2;
      P.burstCone(this._genericStyles.arc, point.x, point.y, point.z,
        Math.cos(a) * cl, Math.sin(el) + 0.3, Math.sin(a) * cl, 0.8 + s * 1.6, 0.3, 1, o);
    }
    o.rot = undefined;
    const glows = Math.round(lerp(2, 7, s * 0.5));
    P.burstCone(this._genericStyles.arcGlow, point.x, point.y, point.z, 0, 1, 0,
      1.2 + s * 1.8, 1.0, glows, o);
    this.impacts?.screenFlash(0x9fd8ff, clamp01(0.18 * s), 0.14);
  }

  _freeze(point, strength, normal = _defaultUp) {
    const P = this.particles;
    if (!P) return;
    const s = clamp(strength, 0, 2);
    const o = resetOpts(_emitOpts);
    o.speedJitter = 0.55;
    o.radius = 0.015;
    o.groundY = point.y - 0.02;
    o.sizeMul = lerp(0.9, 1.6, s * 0.5);
    P.burstCone(this._genericStyles.frost, point.x, point.y, point.z, 0, 1, 0,
      1.1 + s * 2.4, 1.0, Math.round(lerp(8, 26, s * 0.5) * this.load), o);
    P.burstCone(this._genericStyles.frostMist, point.x, point.y, point.z, 0, 1, 0,
      0.5 + s * 0.9, 1.0, Math.round(lerp(4, 14, s * 0.5) * this.load), o);
    this.decals?.project('frost', point, normal, 0.08 + s * 0.10, { alpha: 0.45, life: 8 });
  }

  _oil(point, normal, strength) {
    const s = clamp01(strength);
    this.decals?.project('oil', point, normal, 0.10 + s * 0.16, {
      alpha: 0.85, life: 999,
    });
    const P = this.particles;
    if (!P) return;
    const o = resetOpts(_emitOpts);
    o.speedJitter = 0.6;
    o.radius = 0.02;
    o.groundY = point.y;
    o.r = 0.06; o.g = 0.055; o.b = 0.08;
    P.burstCone(this.dust?.styles?.slick ?? this._genericStyles.frost,
      point.x, point.y + 0.01, point.z, 0, 1, 0, 0.9 + s * 1.4, 1.0,
      Math.round(lerp(6, 18, s) * this.load), o);
  }

  // ══════════════════════════════════════════════════════════ race hooks

  onRaceStart(ctx) {
    this.time = 0;
    this.clear();
    this.weather?.apply(ctx?.track?.environment ?? null);
    this.load = 1;
    this._ms = 0.4;
    this._msPeak = 0.4;
    for (const st of this._contacts) st.reset();
    this._driftHint.fill(0);
    this._airTime.fill(0);
    this._warmup = 45;
    return this;
  }

  onRaceEnd() {
    this.clear();
    this.weather?.onRaceEnd();
    return this;
  }

  // ══════════════════════════════════════════════════════════ frame

  /**
   * @param {number} dt simulated seconds (0 while paused, scaled in slow-mo)
   * @param {number} alpha physics interpolation factor
   * @param {number} [rawDt] wall-clock seconds
   */
  update(dt, alpha, rawDt) {
    if (!this.enabled) return;
    const t0 = performance.now();

    const wall = rawDt ?? dt;
    this.time += dt;

    const cars = this.game?.cars;
    const camera = this.game?.camera;

    // Refill the one-shot budget. Physics events for the *next* frame arrive
    // during its fixedUpdate pass, which runs before that frame's update(), so
    // one refill per update() covers exactly one frame of events.
    this._credits = this.creditsPerFrame;

    // ── propagate the load scalar ──
    const load = this.load;
    if (this.dust) this.dust.rate = load;
    if (this.smoke) this.smoke.rate = load;
    if (this.splash) this.splash.rate = load;
    if (this.sparks) this.sparks.rate = load;
    if (this.impacts) this.impacts.rate = load;
    if (this.nitro) this.nitro.rate = load;
    if (this.weather) this.weather.rate = load;

    // ── continuous, car-driven effects ──
    if (cars && cars.length) {
      this.dust?.update(dt, cars);
      this.smoke?.update(dt, cars);
      this.splash?.update(dt, cars);
      this.nitro?.update(dt, cars, camera);
      this._updateScrapes(dt, cars);
      this._updateDriftBoost(dt, cars);
    }

    // ── persistent surface marks ──
    this.tireMarks?.update(dt, cars, load);
    this.decals?.update(dt);

    // ── pooled emitters ──
    this._updateEmitters(dt, load);

    // ── one-shot owners ──
    this.sparks?.update(dt);
    this.impacts?.update(dt, camera);

    // Ambience runs on wall-clock time: a paused frame should not look dead, and
    // motes drifting in slow motion looks wrong rather than stylish.
    this.weather?.update(wall, camera);

    // ── particles last: everything above has already spawned into them ──
    this.particles?.update(dt, camera);

    // ── governor ──
    const ms = performance.now() - t0;
    this._governor(ms, wall);
    this._collectStats(ms);
  }

  /**
   * Turn the collision event stream into a continuous scrape for any car that has
   * been in contact for more than a couple of steps.
   */
  _updateScrapes(dt, cars) {
    if (!this.sparks) return;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const id = (car?.id | 0) & (MAX_CARS - 1);
      const st = this._contacts[id];
      if (!st) continue;

      const age = this.time - st.lastTime;
      if (age > 0.06) {
        // contact has ended
        st.streak = 0;
        st.peak = Math.max(0, st.peak - dt * 8);
        continue;
      }
      // Need a sustained contact before we call it a scrape; a single-step tap is
      // an impact and has already been handled.
      if (st.streak < 0.04) continue;

      const vel = car.body?.velocity;
      if (!vel) continue;

      _v.set(st.px, st.py, st.pz);
      _n.set(st.nx, st.ny, st.nz);
      // Contact pressure from the running peak impulse, normalized against what a
      // car's weight alone would produce in one step.
      const weightImpulse = (car.body?.mass ?? 1.6) * 19.6 * CONFIG.physics.fixedDt;
      const pressure = clamp01(st.peak / Math.max(weightImpulse * 2.5, 0.05));

      this.sparks.scrape(id, _v, _n, vel, pressure, st.surfaceId,
        car.def?.chassis ?? 'plastic', dt);

      st.peak *= Math.exp(-dt * 6);
    }
  }

  /**
   * The 'car:drift' event is a nicety, not a requirement: we already poll wheel
   * slip. Where it *is* provided, use it to push a bit more smoke and dust so the
   * gameplay-authored drift moment reads harder than raw physics would.
   */
  _updateDriftBoost(dt, cars) {
    const smokeStates = this.smoke?.states;
    for (let i = 0; i < cars.length; i++) {
      const id = (cars[i]?.id | 0) & (MAX_CARS - 1);
      const hint = this._driftHint[id];
      if (hint <= 0) continue;
      // Push the tyre-heat integrator so an authored drift beat smokes harder
      // than the raw slip numbers alone would produce.
      const st = smokeStates && smokeStates[id];
      if (st && st.heat < hint) st.heat = damp(st.heat, hint, 5, dt);
      this._driftHint[id] = Math.max(0, hint - dt * 2.5);
    }
  }

  _updateEmitters(dt, load) {
    const list = this._emitters;
    for (let i = list.length - 1; i >= 0; i--) {
      const em = list[i];
      let keep = true;
      try { keep = em._update(dt, load); }
      catch (err) {
        // A broken emitter must retire, not throw once per frame forever.
        keep = false;
        em.active = false;
        if (CONFIG.debug) console.error('[FX] emitter threw:', err);
      }
      if (!keep && !em.active) {
        list.splice(i, 1);
        if (em.inUse) em.release();
      }
    }
    this.stats.emitters = list.length;
  }

  /**
   * Keep this system inside its 1.5 ms slice.
   *
   * Two signals, because they mean different things. The rolling **mean** is what
   * actually decides whether we hold vsync, so it drives the normal response. The
   * decayed **peak** is a safety net for the case the mean hides — eight cars
   * landing in the same frame — but it is given a lot of headroom, because a
   * single expensive frame when a rocket goes off is *correct*, and an
   * explosion should not permanently throttle the dust behind the car.
   */
  _governor(ms, wall) {
    if (this._warmup > 0) {
      this._warmup--;
      // seed the averages from the first clean frame rather than from a stale
      // constant, so the governor starts calibrated
      if (this._warmup === 0) { this._ms = ms; this._msPeak = ms; }
      return;
    }

    this._ms = this._ms * 0.90 + ms * 0.10;
    // Exponential decay, not linear: a linear 3 ms/s bleed means one 20 ms GC
    // pause pins the peak above budget for six seconds, which is long enough to
    // catch the next pause and never recover.
    this._msPeak = Math.max(ms, this._msPeak * Math.exp(-wall * 2.6));

    const over = this._ms > this.budgetMs || this._msPeak > this.budgetMs * 3.0;
    const clear = this._ms < this.budgetMs * 0.6 && this._msPeak < this.budgetMs * 1.8;

    if (over) this.load = Math.max(0.18, this.load - wall * 1.4);
    else if (clear) this.load = Math.min(1, this.load + wall * 0.35);

    // Follow the renderer's adaptive governor too: if it is shedding quality,
    // there is no point spending our budget on particles nobody can see.
    const step = this.game?.renderer?.adaptive?.step ?? 0;
    if (step >= 2) {
      const cap = step >= 5 ? 0.30 : step >= 4 ? 0.45 : step >= 3 ? 0.62 : 0.80;
      if (this.load > cap) this.load = cap;
    }

    // Particle size shrinks a touch under load: fewer, smaller puffs read better
    // than fewer, huge ones.
    if (this.particles) {
      this.particles.sizeScale = damp(this.particles.sizeScale,
        lerp(0.82, 1, clamp01(this.load)), 4, wall);
    }
  }

  _collectStats(ms) {
    const s = this.stats;
    s.ms = this._ms;
    s.load = this.load;
    const p = this.particles?.stats;
    if (p) {
      s.particles = p.alive;
      s.capacity = p.capacity;
      s.dropped = p.dropped;
    }
    s.marks = this.tireMarks?.stats.live ?? 0;
    s.decals = this.decals?.stats.used ?? 0;
    s.debris = this.impacts?.debris.count ?? 0;
    void ms;
  }

  // ══════════════════════════════════════════════════════════ public API

  /**
   * Fire a one-shot effect.
   *
   * @param {string} type one of:
   *   `'dust' | 'plume' | 'surface' | 'sparks' | 'impact' | 'explosion' |
   *    'smoke' | 'steam' | 'splash' | 'ripple' | 'nitro' | 'debris' |
   *    'electro' | 'freeze' | 'oil' | 'confetti' | 'sparkle' | 'flash' |
   *    'shockwave' | 'scorch' | 'leaves'`
   * @param {THREE.Vector3|{x:number,y:number,z:number}} position
   * @param {object} [o] type-specific options. Common keys:
   *   `strength` (0..2), `normal`, `direction`, `count`, `surfaceId`, `color`,
   *   `radius`, `velocity`, `sizeMul`
   * @returns {boolean} whether anything was emitted
   */
  burst(type, position, o = {}) {
    if (!this.enabled || !this.particles || !position) return false;
    const P = this.particles;
    const strength = clamp(o.strength ?? 1, 0, 2);
    const surfaceId = o.surfaceId ?? 0;
    const normal = o.normal ?? _defaultUp;

    switch (type) {
      case 'dust':
      case 'plume':
      case 'surface': {
        const sid = type === 'plume' ? 6 : surfaceId;
        this.dust?.landingPuff(sid, position, normal, 2 + strength * 7);
        return true;
      }
      case 'sparks': {
        this.sparks?.impact(position, normal, 2 + strength * 10, 3 + strength * 6,
          surfaceId || 11, o.chassis ?? 'metal', o.velocity ?? null);
        return true;
      }
      case 'impact': {
        this.impacts?.collision(position, normal, 2 + strength * 12,
          strength * 6, surfaceId, o.chassis ?? 'plastic', o.color);
        this.sparks?.impact(position, normal, 2 + strength * 10, strength * 6,
          surfaceId, o.chassis ?? 'plastic', o.velocity ?? null);
        return true;
      }
      case 'explosion': {
        this.impacts?.explosion(position, strength, normal);
        this.smoke?.explosion(position, strength, o.radius ?? (0.14 + strength * 0.10));
        if (o.shake !== false) this.impacts?.shake(0.6 * strength, 0.35);
        return true;
      }
      case 'smoke': {
        this.smoke?.puff(position, {
          strength, count: o.count, color: o.color ? toLinearRGB(o.color) : undefined,
          sizeMul: o.sizeMul, radius: o.radius, up: o.up,
        });
        return true;
      }
      case 'steam': {
        this.smoke?.steam(position, strength);
        return true;
      }
      case 'splash': {
        this.splash?.bigSplash(position, clamp01(strength), o.velocity ?? null, -1);
        return true;
      }
      case 'ripple': {
        const op = resetOpts(_emitOpts);
        op.sizeMul = (o.sizeMul ?? 1) * lerp(0.7, 2.2, strength * 0.5);
        if (o.color) { const c = toLinearRGB(o.color); op.r = c[0]; op.g = c[1]; op.b = c[2]; }
        P.spawn(this._genericStyles.ripple, position.x, position.y + 0.003, position.z,
          normal.x, normal.y, normal.z, op);
        return true;
      }
      case 'nitro': {
        this.nitro?.puff(position, o.direction ?? null, strength);
        return true;
      }
      case 'debris': {
        const d = o.direction ?? _defaultUp;
        const col = o.color !== undefined ? toLinearRGB(o.color) : surfaceFX(surfaceId).sprayColor;
        this.impacts?.spawnDebris(position.x, position.y, position.z, d.x, d.y, d.z,
          1.2 + strength * 3.5, Math.round(o.count ?? lerp(4, 18, strength * 0.5)), {
            r: col[0], g: col[1], b: col[2],
            size: o.size ?? lerp(0.004, 0.012, strength * 0.5),
            groundY: o.groundY ?? position.y,
            life: o.life ?? 2.2,
          });
        return true;
      }
      case 'electro': { this._electro(position, strength); return true; }
      case 'freeze': { this._freeze(position, strength, normal); return true; }
      case 'oil': { this._oil(position, normal, strength); return true; }
      case 'confetti': { this.confetti(position, strength); return true; }
      case 'sparkle': {
        const op = resetOpts(_emitOpts);
        op.speedJitter = 0.55;
        op.radius = o.radius ?? 0.02;
        if (o.color) { const c = toLinearRGB(o.color); op.r = c[0]; op.g = c[1]; op.b = c[2]; }
        P.burstCone(this._genericStyles.sparkle, position.x, position.y, position.z,
          0, 1, 0, 0.8 + strength * 1.2, 1.0,
          Math.round(o.count ?? lerp(6, 24, strength * 0.5)), op);
        return true;
      }
      case 'flash': {
        const op = resetOpts(_emitOpts);
        op.sizeMul = (o.sizeMul ?? 1) * lerp(0.7, 2.0, strength * 0.5);
        if (o.color) { const c = toLinearRGB(o.color); op.r = c[0]; op.g = c[1]; op.b = c[2]; }
        P.spawn(this._genericStyles.pop, position.x, position.y, position.z, 0, 0, 0, op);
        if (o.screen) this.impacts?.screenFlash(o.color ?? 0xffffff, 0.2 * strength, 0.15);
        return true;
      }
      case 'shockwave': {
        const op = resetOpts(_emitOpts);
        op.sizeMul = (o.sizeMul ?? 1) * lerp(0.8, 2.4, strength * 0.5);
        P.spawn(this.impacts?.styles?.ring ?? this._genericStyles.ripple,
          position.x, position.y + 0.004, position.z, normal.x, normal.y, normal.z, op);
        return true;
      }
      case 'scorch': {
        this.decals?.project('scorch', position, normal, o.radius ?? 0.12,
          { alpha: o.alpha ?? 0.8, life: o.life ?? 20 });
        return true;
      }
      case 'leaves': {
        const op = resetOpts(_emitOpts);
        op.speedJitter = 0.5;
        op.radius = o.radius ?? 0.05;
        op.groundY = o.groundY ?? (position.y - 0.5);
        const colors = o.colors ?? this.weather?.settings.leafColors ?? [0x7f9a2f];
        const n = Math.round(o.count ?? lerp(4, 16, strength * 0.5));
        for (let k = 0; k < n; k++) {
          const c = toLinearRGB(colors[(frand() * colors.length) | 0]);
          op.r = c[0]; op.g = c[1]; op.b = c[2];
          P.burstCone(this.weather?.styles?.leaf ?? this._genericStyles.confetti,
            position.x, position.y, position.z, 0, 1, 0, 0.6 + strength, 1.0, 1, op);
        }
        return true;
      }
      default:
        if (CONFIG.debug) console.warn(`[FX] unknown burst type "${type}"`);
        return false;
    }
  }

  /** Podium confetti. */
  confetti(point, strength = 1) {
    const P = this.particles;
    if (!P) return;
    const s = clamp01(strength);
    const o = resetOpts(_emitOpts);
    o.speedJitter = 0.55;
    o.radius = 0.05;
    o.groundY = point.y - 0.04;
    const palette = _confettiPalette;
    const n = Math.round(lerp(20, 90, s) * this.load);
    for (let k = 0; k < n; k++) {
      const c = palette[(frand() * palette.length) | 0];
      o.r = c[0]; o.g = c[1]; o.b = c[2];
      o.rot = frand() * Math.PI * 2;
      P.burstCone(this._genericStyles.confetti, point.x, point.y + 0.15, point.z,
        frandRange(-0.35, 0.35), 1, frandRange(-0.35, 0.35),
        1.6 + s * 2.4, 0.55, 1, o);
    }
    o.rot = undefined;
  }

  /**
   * Take a pooled emitter. Call `release()` when you are done with it.
   *
   * @param {object} desc
   *   `style`  — a style name (`'fx/smoke/tyre'`) or numeric id. Required.
   *   `position` / `x,y,z` — world origin.
   *   `follow` — an Object3D whose world transform the emitter tracks.
   *   `offset` — local offset applied inside `follow`.
   *   `direction` — cone axis (rotated by `follow` unless `followRotation:false`).
   *   `rate` — particles/second. `count` — particles per tick.
   *   `speed`, `spread`, `speedJitter`, `radius`.
   *   `sizeMul`, `lifeMul`, `alpha`, `color`, `groundY`.
   *   `life` — emitter lifetime in seconds (default Infinity).
   *   `onDone` — called once when `life` expires.
   * @returns {Emitter|null}
   */
  emitter(desc = {}) {
    if (!this.particles) return null;
    const styleId = typeof desc.style === 'number'
      ? desc.style
      : this.particles.styleId(desc.style);
    if (styleId === undefined || styleId < 0) {
      if (CONFIG.debug) console.warn(`[FX] emitter: unknown style "${desc.style}"`);
      return null;
    }

    const em = this._emitterPool.pop() || new Emitter(this);
    em.reset();
    em.inUse = true;
    em.styleId = styleId;

    if (desc.position) em.position.copy(desc.position);
    else if (desc.x !== undefined) em.position.set(desc.x, desc.y ?? 0, desc.z ?? 0);
    if (desc.direction) em.direction.copy(desc.direction).normalize();
    if (desc.offset) em.offset.copy(desc.offset);
    if (desc.follow) em.follow = desc.follow;
    if (desc.followRotation === false) em.followRotation = false;

    if (desc.rate !== undefined) em.rate = desc.rate;
    if (desc.count !== undefined) em.count = Math.max(1, desc.count | 0);
    if (desc.speed !== undefined) em.speed = desc.speed;
    if (desc.spread !== undefined) em.spread = desc.spread;
    if (desc.speedJitter !== undefined) em.speedJitter = desc.speedJitter;
    if (desc.radius !== undefined) em.radius = desc.radius;
    if (desc.sizeMul !== undefined) em.sizeMul = desc.sizeMul;
    if (desc.lifeMul !== undefined) em.lifeMul = desc.lifeMul;
    if (desc.alpha !== undefined) em.alpha = desc.alpha;
    if (desc.groundY !== undefined) em.groundY = desc.groundY;
    if (desc.life !== undefined) em.life = desc.life;
    if (desc.onDone) em.onDone = desc.onDone;
    if (desc.color !== undefined) {
      const c = toLinearRGB(desc.color);
      em.r = c[0]; em.g = c[1]; em.b = c[2];
    }
    if (desc.active === false) em.active = false;

    this._emitters.push(em);
    return em;
  }

  /** Kill every live particle, mark, decal and emitter. */
  clear() {
    this.particles?.clear();
    this.tireMarks?.clear();
    this.decals?.clear();
    this.impacts?.clear();
    this.sparks?.reset();
    this.dust?.reset();
    this.smoke?.reset();
    this.splash?.reset();
    this.nitro?.reset();
    this.weather?.clear();
    for (const em of this._emitters) { em.active = false; em.inUse = false; this._emitterPool.push(em); }
    this._emitters.length = 0;
    return this;
  }

  /** Master switch. Turning FX off hides everything and stops all work. */
  setEnabled(on) {
    this.enabled = !!on;
    this.root.visible = this.enabled;
    if (!this.enabled) this.clear();
    return this;
  }

  /** Quality knob, mostly for the debug overlay. 0..1 */
  setLoad(v) { this.load = clamp(v, 0.05, 1); return this; }

  getStats() { return this.stats; }

  // ══════════════════════════════════════════════════════════ helpers

  /**
   * How much fidelity should this one-shot get? Combines a per-frame credit
   * budget with distance from the camera, then pushes the result into the
   * subsystems' `rate` fields (which they already use as an emission
   * multiplier). `update()`'s prologue restores them from `this.load`.
   *
   * @param {{x:number,y:number,z:number}} point
   * @returns {number} 0 = skip the event entirely
   */
  _impactScale(point) {
    const used = this.creditsPerFrame - this._credits;
    this._credits--;
    // hard stop once the frame is thoroughly saturated
    if (used > this.creditsPerFrame + 8) return 0;

    let s = used <= 0 ? 1 : 1 / (1 + used * 0.85);

    const cam = this.game?.camera;
    if (cam && point) {
      const m = cam.matrixWorld.elements;
      const dx = point.x - m[12], dy = point.y - m[13], dz = point.z - m[14];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 400) s *= 0.22;           // > 20 m
      else if (d2 > 144) s *= 0.45;      // > 12 m
      else if (d2 > 36) s *= 0.75;       // > 6 m
    }

    const r = this.load * s;
    if (this.impacts) this.impacts.rate = r;
    if (this.sparks) this.sparks.rate = r;
    if (this.dust) this.dust.rate = r;
    if (this.splash) this.splash.rate = r;
    if (this.smoke) this.smoke.rate = r;
    return s;
  }

  /** @returns {import('../vehicle/Car.js').Car|null} */
  _car(carId) {
    const cars = this.game?.cars;
    if (!cars || cars.length === 0) return null;
    // Ids are dense 0..7 in practice, so try the direct index first.
    const direct = cars[carId];
    if (direct && direct.id === carId) return direct;
    for (let i = 0; i < cars.length; i++) if (cars[i]?.id === carId) return cars[i];
    return null;
  }

  dispose() {
    for (const off of this._unsub) { try { off(); } catch (err) { /* ignore */ } }
    this._unsub.length = 0;

    this._emitters.length = 0;
    this._emitterPool.length = 0;

    this.weather?.dispose();
    this.nitro?.dispose();
    this.impacts?.dispose();
    this.smoke?.dispose();
    this.splash?.dispose();
    this.dust?.dispose();
    this.sparks?.dispose();
    this.decals?.dispose();
    this.tireMarks?.dispose();
    this.particles?.dispose();

    this.root.removeFromParent();
  }
}

// ─────────────────────────────────────────────────────────── module state

const _defaultUp = Object.freeze({ x: 0, y: 1, z: 0 });

const _emitOpts = {
  speedJitter: 0.5, radius: 0, groundY: -1e6,
  inheritX: 0, inheritY: 0, inheritZ: 0,
  r: 1, g: 1, b: 1, alpha: 1, sizeMul: 1, lifeMul: 1,
  size: undefined, life: undefined, aspect: undefined,
  rot: undefined, spin: undefined, frame: undefined,
};

/** Party colours, pre-converted to linear. */
const _confettiPalette = [
  0xff4d5a, 0xffd23f, 0x3fd2ff, 0x6cff8a, 0xff8ae0, 0xffffff, 0xffa03f,
].map(toLinearRGB);

/** Reusable ray hit for the ground probes. Allocated once, at module scope. */
const _landHit = {
  hit: false,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: Infinity,
  surfaceId: 0,
  triIndex: -1,
  body: null,
};

export { Emitter, WEAPON_FX, SPRAY, DECAL, LAYER };
export default FXSystem;
