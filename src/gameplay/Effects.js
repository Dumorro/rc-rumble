/**
 * Effects — the car status-effect layer.
 *
 * Weapons never touch a car's handling directly; they call into here. This is
 * the single place that owns:
 *
 *   • the timers in `car.effects` (the ARCHITECTURE.md contract),
 *   • the handling multipliers in `car.effectMods` (read by the vehicle sim),
 *   • the 0..1 visual weights in `car.effectVisual` (read by FX / renderers),
 *   • the physics-level fallbacks that make every effect *felt* even before the
 *     vehicle sim opts into the multipliers.
 *
 * ── car.effects (seconds remaining, 0 = inactive) ──────────────────────────
 *   boost     nitro / turbo thrust
 *   frozen    encased in ice: almost no grip, sluggish steering
 *   shielded  bubble up; absorbs one hit (see `car.shieldCharges`)
 *   squashed  flattened: weak motor, low top speed, squashed mesh
 *   electro   motor stalled by an electro-pulse
 *   oiled     spinning out on an oil slick
 *   blinded   water in the lens (extra key — UI/post-FX read it)
 *   soaked    wet tyres, slightly greasy (extra key)
 *
 * ── car.effectMods (multipliers, 1 = normal) ───────────────────────────────
 *   grip torque steer brake maxSpeed downforce antiRoll
 *
 * ── car.effectVisual (0..1 weights for renderers) ──────────────────────────
 *   boost frost shield squash spark soak blind
 *
 * Timers are counted down in `fixedUpdate` so slow-mo and pause work for free.
 * Nothing in the per-car loop allocates.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils.js';

// ── scratch ────────────────────────────────────────────────────────────────
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();

/** Canonical timer keys owned (and ticked down) by this layer. */
export const EFFECT_KEYS = Object.freeze([
  'boost', 'frozen', 'shielded', 'squashed', 'electro', 'oiled', 'blinded', 'soaked',
]);

/**
 * Per-effect definition.
 *   cap      hard ceiling on the timer (seconds) so stacking cannot run away
 *   mods     handling multipliers while active
 *   fade     seconds over which the visual weight eases in/out
 */
const DEF = {
  boost: {
    cap: 8.0, fade: 0.12,
    mods: { maxSpeed: 1.42, grip: 1.10, downforce: 1.30, antiRoll: 1.10 },
  },
  frozen: {
    cap: 6.0, fade: 0.18,
    mods: { grip: 0.20, steer: 0.26, torque: 0.50, brake: 0.22, antiRoll: 0.6 },
  },
  shielded: {
    cap: 24.0, fade: 0.20,
    mods: {},
  },
  squashed: {
    cap: 8.0, fade: 0.25,
    mods: { torque: 0.60, maxSpeed: 0.70, steer: 0.85, downforce: 1.15 },
  },
  electro: {
    cap: 5.0, fade: 0.08,
    mods: { torque: 0.0, brake: 0.55, steer: 0.55 },
  },
  oiled: {
    cap: 5.0, fade: 0.15,
    mods: { grip: 0.32, steer: 0.70, torque: 0.88, antiRoll: 0.75 },
  },
  blinded: {
    cap: 6.0, fade: 0.22,
    mods: {},
  },
  soaked: {
    cap: 8.0, fade: 0.40,
    mods: { grip: 0.84, torque: 0.92 },
  },
};

/** Neutral multiplier set — copied, never handed out. */
const NEUTRAL_MODS = Object.freeze({
  grip: 1, torque: 1, steer: 1, brake: 1, maxSpeed: 1, downforce: 1, antiRoll: 1,
});

export class EffectsLayer {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {import('../vehicle/Car.js').Car[]} */
    this.cars = [];

    // ── tuning ──────────────────────────────────────────────────────────
    /** Extra forward acceleration while boosting, m/s². */
    this.boostAccel = 16.0;
    /** One-shot kick when a boost starts, m/s. */
    this.boostKick = 2.1;
    /** Fraction of boost thrust that still applies with no wheels down. */
    this.boostAirFactor = 0.30;
    /** Deceleration applied per unit of throttle while the motor is stalled. */
    this.stallDecel = 12.0;
    /** Yaw wobble injected while grip is destroyed (rad/s²). */
    this.slipWobble = 2.6;
    /** How hard a spin-out kick rotates the car (rad/s). */
    this.spinOutRate = 5.6;
    /** Apply physics fallbacks so effects read even if the vehicle sim ignores mods. */
    this.physicsFallback = true;

    this._bus = game?.bus ?? null;
  }

  // ═══════════════════════════════════════════════════════════════ lifecycle

  onRaceStart(ctx) {
    this.cars = ctx?.cars ?? this.game?.cars ?? [];
    for (let i = 0; i < this.cars.length; i++) this.reset(this.cars[i]);
  }

  onRaceEnd() {
    for (let i = 0; i < this.cars.length; i++) this.reset(this.cars[i]);
    this.cars = [];
  }

  /** Make sure a car carries the full contract surface. Idempotent. */
  ensure(car) {
    if (!car) return null;
    if (!car.effects) {
      car.effects = {
        boost: 0, frozen: 0, shielded: 0, squashed: 0, electro: 0, oiled: 0,
        blinded: 0, soaked: 0,
      };
    } else {
      for (let i = 0; i < EFFECT_KEYS.length; i++) {
        const k = EFFECT_KEYS[i];
        if (typeof car.effects[k] !== 'number') car.effects[k] = 0;
      }
    }
    car.effectMods ??= { ...NEUTRAL_MODS };
    car.effectVisual ??= { boost: 0, frost: 0, shield: 0, squash: 0, spark: 0, soak: 0, blind: 0 };
    if (car.shieldCharges == null) car.shieldCharges = 0;
    if (!car._fxBase && car.body) {
      car._fxBase = {
        friction: car.body.friction,
        restitution: car.body.restitution,
        angularDamping: car.body.angularDamping,
        linearDamping: car.body.linearDamping,
      };
    }
    return car;
  }

  /** Wipe every effect from a car (respawn, race reset). */
  reset(car) {
    if (!car) return;
    this.ensure(car);
    const e = car.effects;
    for (let i = 0; i < EFFECT_KEYS.length; i++) {
      const k = EFFECT_KEYS[i];
      if (e[k] > 0) this._emitEnd(car, k);
      e[k] = 0;
    }
    car.shieldCharges = 0;
    const v = car.effectVisual;
    v.boost = v.frost = v.shield = v.squash = v.spark = v.soak = v.blind = 0;
    Object.assign(car.effectMods, NEUTRAL_MODS);
    this._restoreMaterial(car);
  }

  // ═══════════════════════════════════════════════════════════════ apply

  /**
   * Start (or extend) an effect.
   *
   * @param {object} car
   * @param {string} key one of EFFECT_KEYS
   * @param {number} seconds
   * @param {object} [opts]
   * @param {'max'|'add'|'set'} [opts.mode] how to combine with an existing
   *        timer. Default 'max' — re-applying never shortens an effect.
   * @param {number} [opts.sourceId] who caused it (for events)
   * @param {string} [opts.weaponId]
   * @param {boolean} [opts.silent] skip the effect:start event
   * @returns {boolean} true when the effect is now (or still) active
   */
  apply(car, key, seconds, opts = null) {
    if (!car || seconds <= 0) return false;
    const def = DEF[key];
    if (!def) return false;
    this.ensure(car);
    const e = car.effects;
    const was = e[key];
    const mode = opts?.mode ?? 'max';
    let next = mode === 'add' ? was + seconds : mode === 'set' ? seconds : Math.max(was, seconds);
    next = Math.min(def.cap, next);
    e[key] = next;

    if (was <= 0 && next > 0) {
      this._onStart(car, key, next, opts);
      if (!opts?.silent) {
        this._bus?.emit('effect:start', {
          carId: car.id, effect: key, seconds: next,
          sourceId: opts?.sourceId ?? -1, weaponId: opts?.weaponId ?? null,
        });
      }
    }
    return next > 0;
  }

  /** Force an effect to end right now. */
  clear(car, key) {
    if (!car?.effects) return;
    if (car.effects[key] > 0) {
      car.effects[key] = 0;
      this._emitEnd(car, key);
      if (key === 'shielded') car.shieldCharges = 0;
    }
  }

  has(car, key) { return (car?.effects?.[key] ?? 0) > 0; }
  remaining(car, key) { return car?.effects?.[key] ?? 0; }
  mods(car) { return car?.effectMods ?? NEUTRAL_MODS; }

  /** Any effect at all — cheap "is this car in trouble?" test for the AI. */
  isImpaired(car) {
    const e = car?.effects;
    if (!e) return false;
    return e.frozen > 0 || e.electro > 0 || e.oiled > 0 || e.squashed > 0 || e.blinded > 0;
  }

  // ── convenience wrappers used by the weapons ──────────────────────────

  boost(car, seconds = 2.4, opts = null) {
    const started = !this.has(car, 'boost');
    const ok = this.apply(car, 'boost', seconds, opts);
    if (ok && started && this.physicsFallback && car.body) {
      // A hard, immediate shove — the bit that makes turbo feel like turbo.
      car.body.getForward(_fwd);
      car.body.wake();
      car.body.applyImpulse(_tmp.copy(_fwd).multiplyScalar(this.boostKick * car.body.mass));
    }
    return ok;
  }

  freeze(car, seconds = 2.2, opts = null) { return this.apply(car, 'frozen', seconds, opts); }
  squash(car, seconds = 3.6, opts = null) { return this.apply(car, 'squashed', seconds, opts); }
  blind(car, seconds = 2.2, opts = null) {
    this.apply(car, 'soaked', Math.max(seconds * 1.6, 2.0), opts);
    return this.apply(car, 'blinded', seconds, opts);
  }

  /** Electro-pulse: motor dead, steering vague, sparks everywhere. */
  electro(car, seconds = 1.5, opts = null) {
    const ok = this.apply(car, 'electro', seconds, opts);
    if (ok && this.physicsFallback && car.body) {
      car.body.wake();
      // A short, sharp jolt so the hit registers physically.
      car.body.applyTorqueImpulse(_tmp.set(
        (Math.random() - 0.5) * 0.06,
        (Math.random() - 0.5) * 0.10,
        (Math.random() - 0.5) * 0.06,
      ));
    }
    return ok;
  }

  /** Oil slick: greasy for a while, plus one big destabilising kick. */
  oil(car, seconds = 2.4, opts = null) {
    const first = !this.has(car, 'oiled');
    const ok = this.apply(car, 'oiled', seconds, opts);
    if (ok && first) this.spinOut(car, opts?.spin ?? 1);
    return ok;
  }

  /** Raise a shield bubble that absorbs `charges` hits. */
  shield(car, seconds = 14, charges = 1, opts = null) {
    const ok = this.apply(car, 'shielded', seconds, opts);
    if (ok) car.shieldCharges = Math.max(car.shieldCharges ?? 0, charges);
    return ok;
  }

  /**
   * Spin the car out — the "whoops" moment. Preserves speed, wrecks heading.
   * @param {number} strength 0..2
   */
  spinOut(car, strength = 1) {
    if (!car?.body || !this.physicsFallback) return;
    const body = car.body;
    body.wake();
    const speed = Math.abs(car.speed ?? body.velocity.length());
    const bias = speed > 0.6 ? 1 : 0.35;
    const dir = (car._fxSpinSign ??= Math.random() < 0.5 ? -1 : 1);
    car._fxSpinSign = -dir;   // alternate so repeated hits do not resonate
    body.getUp(_up);
    const amount = this.spinOutRate * strength * bias * Math.min(1, 0.35 + speed / 7);
    body.angularVelocity.addScaledVector(_up, dir * amount);
    // A touch of body roll so it reads even at low speed.
    body.getForward(_fwd);
    body.angularVelocity.addScaledVector(_fwd, -dir * amount * 0.18);
  }

  /**
   * A weapon wants to hurt `car`. Returns false when a shield ate the hit.
   * Every weapon should route damage through this so shields work universally.
   *
   * @returns {boolean} true = go ahead and apply the effect
   */
  tryDamage(car, { sourceId = -1, weaponId = null, worldPoint = null, pierce = false } = {}) {
    if (!car) return false;
    this.ensure(car);
    if (!pierce && car.effects.shielded > 0 && (car.shieldCharges ?? 0) > 0) {
      car.shieldCharges--;
      if (car.shieldCharges <= 0) {
        car.effects.shielded = 0;
        this._emitEnd(car, 'shielded');
      }
      car.effectVisual.shield = 1;   // flare the bubble as it pops
      this._bus?.emit('weapon:blocked', {
        carId: car.id, sourceId, weaponId,
        worldPoint: worldPoint ?? car.body?.position ?? null,
      });
      this._bus?.emit('camera:shake', { amount: 0.18, duration: 0.18 });
      return false;
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════ step

  /** @param {number} dt always CONFIG.physics.fixedDt */
  fixedUpdate(dt) {
    const cars = this.cars.length ? this.cars : (this.game?.cars ?? []);
    for (let i = 0; i < cars.length; i++) this._stepCar(cars[i], dt);
  }

  _stepCar(car, dt) {
    if (!car) return;
    const e = car.effects;
    if (!e) { this.ensure(car); return; }
    const mods = car.effectMods;
    const vis = car.effectVisual;

    let anyActive = false;

    // ── tick timers, accumulate multipliers ──
    let grip = 1, torque = 1, steer = 1, brake = 1, maxSpeed = 1, downforce = 1, antiRoll = 1;
    for (let i = 0; i < EFFECT_KEYS.length; i++) {
      const k = EFFECT_KEYS[i];
      let t = e[k];
      if (t <= 0) continue;
      t -= dt;
      if (t <= 0) {
        e[k] = 0;
        if (k === 'shielded') car.shieldCharges = 0;
        this._emitEnd(car, k);
        continue;
      }
      e[k] = t;
      anyActive = true;
      const m = DEF[k].mods;
      if (m.grip !== undefined) grip *= m.grip;
      if (m.torque !== undefined) torque *= m.torque;
      if (m.steer !== undefined) steer *= m.steer;
      if (m.brake !== undefined) brake *= m.brake;
      if (m.maxSpeed !== undefined) maxSpeed *= m.maxSpeed;
      if (m.downforce !== undefined) downforce *= m.downforce;
      if (m.antiRoll !== undefined) antiRoll *= m.antiRoll;
    }

    mods.grip = grip; mods.torque = torque; mods.steer = steer; mods.brake = brake;
    mods.maxSpeed = maxSpeed; mods.downforce = downforce; mods.antiRoll = antiRoll;

    // ── visual weights (eased so nothing pops) ──
    const rate = 9 * dt;
    vis.boost = approach(vis.boost, weightFor(e.boost, DEF.boost.fade), rate);
    vis.frost = approach(vis.frost, weightFor(e.frozen, DEF.frozen.fade), rate);
    vis.shield = approach(vis.shield, weightFor(e.shielded, DEF.shielded.fade), rate * 0.8);
    vis.squash = approach(vis.squash, weightFor(e.squashed, DEF.squashed.fade), rate);
    vis.spark = approach(vis.spark, weightFor(e.electro, DEF.electro.fade), rate * 2.2);
    vis.soak = approach(vis.soak, weightFor(e.soaked, DEF.soaked.fade), rate * 0.5);
    vis.blind = approach(vis.blind, weightFor(e.blinded, DEF.blinded.fade), rate * 0.7);
    // Legacy/simple mirrors some renderers prefer.
    car.squash = vis.squash;
    car.blind = vis.blind;

    if (!this.physicsFallback || !car.body) return;

    // ── physics-level fallbacks ──
    const body = car.body;

    if (e.boost > 0) {
      const ground = clamp01((car.wheelsOnGround ?? 4) / 4);
      const air = this.boostAirFactor;
      const authority = air + (1 - air) * ground;
      // Ease the last 25% out so the drop-off is not a cliff.
      const taper = clamp01(e.boost / 0.55);
      body.getForward(_fwd);
      body.wake();
      body.applyForce(_tmp.copy(_fwd).multiplyScalar(this.boostAccel * authority * taper * body.mass));
      // Push the nose down a hair so boosting over a crest does not launch you.
      if (ground > 0.5) {
        body.getUp(_up);
        body.applyForce(_tmp2.copy(_up).multiplyScalar(-2.4 * body.mass * taper));
      }
    }

    if (e.electro > 0) {
      // Kill the drivetrain: cancel whatever the throttle is trying to do.
      const thr = clamp01(car.throttle ?? 0);
      if (thr > 0.01) {
        body.getForward(_fwd);
        body.applyForce(_tmp.copy(_fwd).multiplyScalar(-this.stallDecel * thr * body.mass));
      }
      // Buzzing jitter — small, high frequency, unmistakable.
      const j = 0.55;
      body.applyTorque(_tmp.set(
        (Math.random() - 0.5) * j, (Math.random() - 0.5) * j * 1.6, (Math.random() - 0.5) * j,
      ));
    }

    if (torque < 0.999) {
      // Generic torque haircut for squashed/frozen, in case the vehicle sim
      // has not adopted effectMods yet.
      const thr = clamp01(car.throttle ?? 0);
      if (thr > 0.01 && e.electro <= 0) {
        body.getForward(_fwd);
        body.applyForce(_tmp.copy(_fwd)
          .multiplyScalar(-this.stallDecel * 0.55 * (1 - torque) * thr * body.mass));
      }
    }

    if (grip < 0.7) {
      // Destroyed grip: let the back end wander instead of tracking straight.
      const speed = Math.abs(car.speed ?? 0);
      if (speed > 0.5) {
        body.getUp(_up);
        const w = this.slipWobble * (1 - grip) * Math.min(1, speed / 6);
        car._fxWobblePhase = (car._fxWobblePhase ?? Math.random() * 6.28) + dt * 7.3;
        body.applyTorque(_tmp.copy(_up).multiplyScalar(Math.sin(car._fxWobblePhase) * w * 0.02));
      }
    }

    // ── contact material override ──
    if (anyActive) this._applyMaterial(car, e);
    else if (car._fxMaterialDirty) this._restoreMaterial(car);
  }

  _applyMaterial(car, e) {
    const base = car._fxBase;
    if (!base) return;
    const body = car.body;
    let fric = base.friction;
    let rest = base.restitution;
    let aDamp = base.angularDamping;
    let lDamp = base.linearDamping;

    if (e.frozen > 0) { fric *= 0.22; rest = Math.max(rest, 0.40); aDamp *= 0.35; lDamp *= 0.4; }
    if (e.oiled > 0) { fric *= 0.35; aDamp *= 0.55; }
    if (e.soaked > 0) { fric *= 0.86; }
    if (e.squashed > 0) { fric *= 1.10; rest *= 0.6; }

    body.friction = fric;
    body.restitution = rest;
    body.angularDamping = aDamp;
    body.linearDamping = lDamp;
    car._fxMaterialDirty = true;
  }

  _restoreMaterial(car) {
    const base = car._fxBase;
    if (!base || !car.body) { car._fxMaterialDirty = false; return; }
    car.body.friction = base.friction;
    car.body.restitution = base.restitution;
    car.body.angularDamping = base.angularDamping;
    car.body.linearDamping = base.linearDamping;
    car._fxMaterialDirty = false;
  }

  _onStart(car, key, seconds, opts) {
    if (key === 'frozen' || key === 'squashed') {
      // Being frozen or flattened should visibly slap the car down.
      if (this.physicsFallback && car.body) {
        car.body.wake();
        car.body.getUp(_up);
        car.body.applyImpulse(_tmp.copy(_up).multiplyScalar(-0.9 * car.body.mass));
      }
    }
    void seconds; void opts;
  }

  _emitEnd(car, key) {
    this._bus?.emit('effect:end', { carId: car.id, effect: key });
  }

  dispose() {
    this.onRaceEnd();
  }
}

function weightFor(remaining, fade) {
  if (remaining <= 0) return 0;
  return clamp01(remaining / Math.max(0.01, fade));
}

function approach(v, target, rate) {
  const d = target - v;
  if (d > rate) return v + rate;
  if (d < -rate) return v - rate;
  return target;
}

export { clamp, clamp01 };
export default EffectsLayer;
