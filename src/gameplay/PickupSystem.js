/**
 * PickupSystem — pads, the single weapon slot, the roll table, firing and aim.
 * Registered as `game.pickups`.
 *
 * Owns three collaborators (all reachable from here so other systems only need
 * one handle):
 *
 *   game.pickups.pads         PickupPads      floating pads + collection
 *   game.pickups.effects      EffectsLayer    car status effects  (also game.effects)
 *   game.pickups.projectiles  Projectiles     pooled projectile/FX simulation
 *
 * ── The slot ───────────────────────────────────────────────────────────────
 * `car.weapon` follows the ARCHITECTURE.md contract `{ id, ammo, chargeT }`,
 * extended with the bits a HUD needs:
 *
 * ```js
 * car.weapon = {
 *   id,          // during the roll this is the FLICKERING display id
 *   name, icon,  // display strings
 *   ammo,        // uses left (0 while rolling)
 *   chargeT,     // 0..1 roll progress — 1 = settled and ready
 *   ready,       // false while rolling
 *   rolling,     // true while rolling
 *   uses,        // uses it was granted with
 *   aimMode,     // 'forward'|'back'|'self'|'target'|'drop'
 *   dual,        // true when the player can flip it backwards
 * }
 * ```
 *
 * ── Firing ─────────────────────────────────────────────────────────────────
 * The player fires on the rising edge of `InputState.fire`, with an auto-repeat
 * for multi-use items. Holding brake or look-back flips a `dual` weapon to fire
 * backwards. The AI fires itself through the same `tryFire()` path, so every
 * weapon, effect and event behaves identically for a CPU car — call
 * `setAutoFire(car, false)` from an AI driver that wants to make its own
 * decisions.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { EffectsLayer } from './Effects.js';
import { Projectiles } from './Projectiles.js';
import { PickupPads } from './PickupPads.js';
import {
  WEAPONS, WEAPON_LIST, WEAPON_IDS, getWeapon, rollWeapon, rollCandidates, usesFor,
} from './weapons/index.js';
import {
  carPos, carForward, targetAhead, targetBehind, targetLeader,
} from './weapons/Common.js';

const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Internal per-car slot state. */
class Slot {
  constructor(car) {
    this.car = car;
    /** @type {object|null} the settled weapon module */
    this.weapon = null;
    this.ammo = 0;
    this.uses = 0;
    this.ready = false;
    this.rolling = false;
    this.rollT = 0;
    this.rollDuration = 0;
    this.flickerT = 0;
    this.flickerIndex = 0;
    /** @type {string[]} */
    this.candidates = [];
    /** @type {object|null} decided up front so the reveal is deterministic */
    this.pending = null;
    this.pendingUses = 1;
    this.lastId = null;
    this.prevId = null;
    this.cooldown = 0;
    /** AI thinking timer; -1 = nothing pending. */
    this.aiTimer = -1;
    this.aiHold = 0;
    this.autoFire = true;
    this.firedCount = 0;
    this.collectedCount = 0;
    this.source = 'pad';
    this.padId = -1;
  }

  reset() {
    this.weapon = null;
    this.ammo = 0;
    this.uses = 0;
    this.ready = false;
    this.rolling = false;
    this.rollT = 0;
    this.rollDuration = 0;
    this.flickerT = 0;
    this.candidates.length = 0;
    this.pending = null;
    this.pendingUses = 1;
    this.cooldown = 0;
    this.aiTimer = -1;
    this.aiHold = 0;
  }
}

export class PickupSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.bus = game?.bus ?? null;

    this.effects = new EffectsLayer(game);
    this.projectiles = new Projectiles(game, this);
    this.pads = new PickupPads(game, this);

    /** @type {Map<number, Slot>} carId → slot */
    this.slots = new Map();

    // ── tuning ──────────────────────────────────────────────────────────
    /** Seconds the slot machine spins before it settles. */
    this.rollDuration = 1.05;
    /** Faster roll for a Clone Pickup re-roll. */
    this.fastRollDuration = 0.55;
    /** Flicker interval at the start / end of the roll. */
    this.flickerFast = 0.045;
    this.flickerSlow = 0.19;
    /** Auto-repeat delay when the player holds fire on a multi-use item. */
    this.repeatDelay = 0.42;
    /** Minimum gap between two shots of the same multi-use item. */
    this.fireCooldown = 0.26;
    /** Let the AI fire for itself. */
    this.autoFireEnabled = true;
    /** AI think time bounds before it uses what it has. */
    this.aiThinkMin = 0.45;
    this.aiThinkMax = 1.9;
    /** After this long an AI car fires regardless of the situation. */
    this.aiMaxHold = 6.5;

    this._prevFire = false;
    this._repeatT = 0;
    this._rng = game?.rng ?? null;
    this._candScratch = [];
    this._ctx = {
      car: null, game, target: null, direction: new THREE.Vector3(),
      backwards: false, pickups: this, projectiles: this.projectiles,
      effects: this.effects, race: null, standings: null, rng: null,
      fieldT: 0, place: 1, carCount: 1,
    };
    this._rollCtx = {
      finalLap: false, lapsRemaining: 0, gapAhead: null, gapBehind: null,
      hasCarAhead: false, hasCarBehind: false, soloRace: false,
    };
  }

  async init() {
    // Expose the effect layer globally — FX/UI/AI all want it and it is a
    // read-mostly service. Never clobbers an existing registration.
    if (this.game && !this.game.effects) this.game.effects = this.effects;
  }

  // ═══════════════════════════════════════════════════════════════ lifecycle

  onRaceStart(ctx) {
    this.effects.onRaceStart(ctx);
    this.projectiles.onRaceStart(ctx);
    this.pads.onRaceStart(ctx);

    this.slots.clear();
    const cars = ctx?.cars ?? this.game?.cars ?? [];
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const s = new Slot(car);
      this.slots.set(car.id, s);
      car.weapon = null;
      car.hasBomb = false;
      car.bombFuse = 0;
      car.hazardSurfaceId = 0;
    }
    this._prevFire = false;
    this._repeatT = 0;
    this._ctx.race = this.game?.race ?? null;
    this._ctx.standings = this.game?.race?.standings ?? null;
  }

  onRaceEnd() {
    for (const s of this.slots.values()) {
      s.reset();
      if (s.car) {
        s.car.weapon = null;
        s.car.hasBomb = false;
        s.car.bombFuse = 0;
        s.car.hazardSurfaceId = 0;
      }
    }
    this.slots.clear();
    this.pads.onRaceEnd();
    this.projectiles.onRaceEnd();
    this.effects.onRaceEnd();
  }

  dispose() {
    this.onRaceEnd();
    this.pads.dispose();
    this.projectiles.dispose();
    this.effects.dispose();
  }

  // ═══════════════════════════════════════════════════════════════ step

  /** @param {number} dt always CONFIG.physics.fixedDt */
  fixedUpdate(dt) {
    // 1. Status effects (writes effectMods + physics fallbacks).
    this.effects.fixedUpdate(dt);

    // 2. Pads: collection + respawn cooldowns.
    this.pads.fixedUpdate(dt);

    // 3. Slots: rolls, player firing, AI firing.
    const live = this.game?.controlsLive ?? false;
    this._stepPlayer(dt, live);
    for (const s of this.slots.values()) {
      this._stepSlot(s, dt, live);
    }

    // 4. Publish hazard surfaces (oil slicks) onto the cars.
    this._publishHazards();

    // 5. Projectiles.
    this.projectiles.fixedUpdate(dt);
  }

  /** @param {number} dt sim-scaled @param {number} alpha interpolation */
  update(dt, alpha) {
    this.pads.update(dt, alpha);
    this.projectiles.update(dt, alpha);
  }

  // ── rolling ────────────────────────────────────────────────────────────

  _stepSlot(s, dt, live) {
    if (s.cooldown > 0) s.cooldown -= dt;

    if (s.rolling) {
      s.rollT += dt;
      const t = clamp01(s.rollT / s.rollDuration);
      // Slot-machine deceleration: fast at first, crawling at the end.
      const interval = this.flickerFast + (this.flickerSlow - this.flickerFast) * Math.pow(t, 2.2);
      s.flickerT -= dt;
      if (s.flickerT <= 0 && s.candidates.length) {
        s.flickerT = interval;
        s.flickerIndex = (s.flickerIndex + 1) % s.candidates.length;
        this._writeSlot(s, s.candidates[s.flickerIndex], 0, t, false, true);
      } else {
        // Keep chargeT live even between flickers so a HUD bar is smooth.
        if (s.car.weapon) s.car.weapon.chargeT = t;
      }
      if (s.rollT >= s.rollDuration) this._settle(s);
      return;
    }

    if (!s.weapon || !live) return;
    if (this.autoFireEnabled && s.autoFire && !s.car?.isPlayer) this._stepAI(s, dt);
  }

  _settle(s) {
    s.rolling = false;
    s.rollT = 0;
    const weapon = s.pending ?? WEAPONS.turbo;
    const uses = Math.max(1, s.pendingUses | 0);
    s.weapon = weapon;
    s.uses = uses;
    s.ammo = uses;
    s.ready = true;
    s.pending = null;
    s.prevId = s.lastId;
    s.lastId = weapon.id;
    this._writeSlot(s, weapon.id, uses, 1, true, false);

    // Give the AI a beat before it uses it.
    const skill = clamp(s.car?.aiSkill ?? 0.8, 0.2, 1.2);
    const r = this._rand();
    s.aiTimer = this.aiThinkMin + (this.aiThinkMax - this.aiThinkMin) * r * (1.4 - skill * 0.5);
    s.aiHold = 0;

    this.bus?.emit('pickup:assigned', { carId: s.car.id, weaponId: weapon.id, uses });
  }

  _writeSlot(s, id, ammo, chargeT, ready, rolling) {
    const car = s.car;
    if (!car) return;
    const w = getWeapon(id);
    let slot = car.weapon;
    if (!slot) {
      slot = car.weapon = {
        id, name: '', icon: '', ammo: 0, chargeT: 0,
        ready: false, rolling: false, uses: 0, aimMode: 'self', dual: false,
      };
    }
    slot.id = id;
    slot.name = w?.name ?? '';
    slot.icon = w?.icon ?? id;
    slot.ammo = ammo;
    slot.chargeT = chargeT;
    slot.ready = ready;
    slot.rolling = rolling;
    slot.uses = ready ? ammo : 0;
    slot.aimMode = w?.aimMode ?? 'self';
    slot.dual = !!w?.dual;
  }

  // ═══════════════════════════════════════════════════════════════ public API

  /** Can this car pick something up right now? (Pads consult this.) */
  canCollect(car) {
    const s = this.slots.get(car?.id);
    if (!s) return false;
    if (car.finished) return false;
    return !s.weapon && !s.rolling;
  }

  /**
   * Roll a new weapon into a car's slot, with the visible roll animation.
   *
   * @param {object} car
   * @param {object} [opts]
   * @param {number} [opts.padId]
   * @param {string} [opts.source] 'pad' | 'clone' | 'debug'
   * @param {boolean} [opts.fast] use the short roll (clone pickup)
   * @param {string|string[]} [opts.exclude] ids that may not be rolled
   * @param {string} [opts.forceId] skip the roll table entirely
   * @returns {boolean}
   */
  grant(car, opts = {}) {
    const s = this.slots.get(car?.id);
    if (!s) return false;
    if (s.rolling) return false;

    const race = this.game?.race ?? null;
    const st = race?.standings ?? null;
    const carCount = Math.max(1, race?.carCount ?? this.game?.cars?.length ?? 1);
    const place = clamp(race?.placeOf?.(car) || 1, 1, carCount);

    let weapon = opts.forceId ? getWeapon(opts.forceId) : null;
    if (!weapon) {
      const ctx = this._buildRollContext(car, race, st, carCount, place);
      weapon = rollWeapon(this._rand, {
        place, carCount,
        exclude: opts.exclude ?? null,
        lastId: s.lastId, prevId: s.prevId,
        context: ctx,
      });
    }
    if (!weapon) return false;

    s.pending = weapon;
    s.pendingUses = usesFor(weapon, place, carCount);
    s.rolling = true;
    s.ready = false;
    s.ammo = 0;
    s.weapon = null;
    s.rollT = 0;
    s.rollDuration = opts.fast ? this.fastRollDuration : this.rollDuration;
    s.flickerT = 0;
    s.flickerIndex = 0;
    s.source = opts.source ?? 'pad';
    s.padId = opts.padId ?? -1;
    s.collectedCount++;
    rollCandidates(s.candidates, {
      place, carCount, exclude: opts.exclude ?? null, context: this._rollCtx,
    });
    // Start the flicker somewhere random so consecutive rolls do not look alike.
    s.flickerIndex = Math.floor(this._rand() * s.candidates.length) % Math.max(1, s.candidates.length);
    this._writeSlot(s, s.candidates[s.flickerIndex] ?? weapon.id, 0, 0, false, true);

    this.bus?.emit('pickup:roll', {
      carId: car.id, duration: s.rollDuration, padId: s.padId, source: s.source,
    });
    return true;
  }

  /** Force a specific weapon into a slot with no roll (debug / scripted). */
  give(car, weaponId, uses = null) {
    const s = this.slots.get(car?.id);
    const w = getWeapon(weaponId);
    if (!s || !w) return false;
    const carCount = Math.max(1, this.game?.race?.carCount ?? this.game?.cars?.length ?? 1);
    const place = clamp(this.game?.race?.placeOf?.(car) || 1, 1, carCount);
    s.rolling = false;
    s.pending = w;
    s.pendingUses = uses ?? usesFor(w, place, carCount);
    this._settle(s);
    return true;
  }

  /** Empty a car's slot. */
  clearSlot(car) {
    const s = this.slots.get(car?.id);
    if (!s) return;
    s.weapon = null;
    s.ammo = 0;
    s.uses = 0;
    s.ready = false;
    s.rolling = false;
    s.pending = null;
    s.aiTimer = -1;
    if (s.car) s.car.weapon = null;
  }

  /** @returns {object|null} the live slot descriptor on the car */
  slotOf(car) { return car?.weapon ?? null; }

  /** @returns {object|null} the weapon module a car is holding */
  weaponOf(car) {
    const s = this.slots.get(car?.id);
    return s?.ready ? s.weapon : null;
  }

  hasWeapon(car) {
    const s = this.slots.get(car?.id);
    return !!(s?.weapon && s.ready && s.ammo > 0);
  }

  /** Opt an AI car out of automatic firing (its driver will call tryFire). */
  setAutoFire(car, enabled) {
    const s = this.slots.get(car?.id);
    if (s) s.autoFire = !!enabled;
  }

  /**
   * Fire whatever is in the slot.
   * @param {object} car
   * @param {{backwards?:boolean, target?:object, direction?:THREE.Vector3}} [opts]
   * @returns {boolean} true when a shot went out
   */
  tryFire(car, opts = null) {
    const s = this.slots.get(car?.id);
    if (!s || !s.weapon || !s.ready || s.ammo <= 0) return false;
    if (s.cooldown > 0) return false;
    if (car.finished && !(this.game?.controlsLive)) return false;

    const weapon = s.weapon;
    const ctx = this._buildFireContext(car, weapon, opts);
    let ok = false;
    try {
      ok = weapon.fire ? weapon.fire(ctx) !== false : false;
    } catch (err) {
      console.warn(`[PickupSystem] ${weapon.id}.fire threw:`, err);
      ok = false;
    }
    if (!ok) {
      // Nothing valid to shoot at — keep the item and try again shortly.
      s.cooldown = 0.35;
      return false;
    }

    s.ammo--;
    s.firedCount++;
    s.cooldown = this.fireCooldown;
    this.bus?.emit('pickup:used', {
      carId: car.id, weaponId: weapon.id, targetId: ctx.target?.id ?? -1,
    });

    if (s.ammo <= 0) {
      this.clearSlot(car);
    } else if (car.weapon) {
      car.weapon.ammo = s.ammo;
    }
    return true;
  }

  /**
   * Surface id of any gameplay hazard (currently oil slicks, id 15) covering a
   * world point. `0` when there is none — callers should fall back to the real
   * track surface.
   */
  hazardSurfaceAt(x, y, z) {
    const a = this.projectiles.active;
    for (let i = 0; i < a.length; i++) {
      const e = a[i];
      const d = e.data;
      if (!d || !d.hazardSurfaceId) continue;
      const dy = y - d.planeY;
      if (dy < -0.12 || dy > d.hazardHeight) continue;
      const dx = x - e.pos.x, dz = z - e.pos.z;
      const r = d.hazardRadius;
      if (dx * dx + dz * dz > r * r) continue;
      return d.hazardSurfaceId;
    }
    return 0;
  }

  /** Vector3 overload of `hazardSurfaceAt`. */
  hazardSurfaceAtPoint(p) { return this.hazardSurfaceAt(p.x, p.y, p.z); }

  /** Debug/UI: every weapon id in the table. */
  get weaponIds() { return WEAPON_IDS; }
  get weaponList() { return WEAPON_LIST; }

  /** Live counts for the debug overlay. */
  stats() {
    return {
      pads: this.pads.count,
      padsActive: this.pads.activeCount,
      projectiles: this.projectiles.count,
      spawned: this.projectiles.spawnCount,
      armed: this._armedCount(),
    };
  }

  _armedCount() {
    let n = 0;
    for (const s of this.slots.values()) if (s.weapon && s.ready) n++;
    return n;
  }

  // ═══════════════════════════════════════════════════════════════ internals

  _rand = () => (this._rng ? this._rng.next() : Math.random());

  _buildRollContext(car, race, st, carCount, place) {
    const c = this._rollCtx;
    const laps = race?.laps ?? 3;
    const lap = race?.lapOf?.(car) ?? 0;
    c.lapsRemaining = Math.max(0, laps - lap);
    c.finalLap = c.lapsRemaining <= 1;
    c.soloRace = carCount <= 1;
    if (st) {
      const ahead = st.entryAhead(car);
      const behind = st.entryBehind(car);
      c.hasCarAhead = !!ahead;
      c.hasCarBehind = !!behind;
      c.gapAhead = ahead ? Math.abs(st.intervalAhead(car)) : null;
      c.gapBehind = behind ? Math.abs(st.intervalBehind(car)) : null;
    } else {
      c.hasCarAhead = place > 1;
      c.hasCarBehind = place < carCount;
      c.gapAhead = null;
      c.gapBehind = null;
    }
    return c;
  }

  _buildFireContext(car, weapon, opts) {
    const game = this.game;
    const race = game?.race ?? null;
    const st = race?.standings ?? null;
    const carCount = Math.max(1, race?.carCount ?? game?.cars?.length ?? 1);
    const place = clamp(race?.placeOf?.(car) || 1, 1, carCount);

    const ctx = this._ctx;
    ctx.car = car;
    ctx.game = game;
    ctx.pickups = this;
    ctx.projectiles = this.projectiles;
    ctx.effects = this.effects;
    ctx.race = race;
    ctx.standings = st;
    ctx.rng = this._rand;
    ctx.place = place;
    ctx.carCount = carCount;
    ctx.fieldT = carCount > 1 ? (place - 1) / (carCount - 1) : 0;

    // ── aim ──
    let backwards = !!opts?.backwards;
    const mode = weapon.aimMode ?? 'self';
    if (mode === 'back' || mode === 'drop') backwards = true;
    if (!weapon.dual && mode !== 'back' && mode !== 'drop') backwards = false;
    ctx.backwards = backwards;

    carForward(car, _fwd);
    if (backwards) _fwd.negate();
    ctx.direction.copy(opts?.direction ?? _fwd);

    let target = opts?.target ?? null;
    if (!target) {
      switch (mode) {
        case 'target':
          target = weapon.id === 'electro'
            ? targetLeader(game, car)
            : targetAhead(game, car, weapon.stickRange ?? 45);
          break;
        case 'forward':
          target = backwards ? targetBehind(game, car, 55) : targetAhead(game, car, 55);
          break;
        case 'back':
        case 'drop':
          target = targetBehind(game, car, 45);
          break;
        default:
          target = null;
      }
    }
    ctx.target = target && target !== car ? target : null;
    return ctx;
  }

  // ── player input ───────────────────────────────────────────────────────

  _stepPlayer(dt, live) {
    const car = this.game?.playerCar;
    if (!car || !live) { this._prevFire = false; return; }
    const input = this.game?.input?.state;
    if (!input) return;

    const fire = !!input.fire;
    const rising = fire && !this._prevFire;
    this._prevFire = fire;

    if (rising) {
      this._repeatT = this.repeatDelay;
      this._firePlayer(car, input);
    } else if (fire) {
      this._repeatT -= dt;
      if (this._repeatT <= 0) {
        this._repeatT = this.repeatDelay;
        this._firePlayer(car, input);
      }
    } else {
      this._repeatT = 0;
    }
  }

  _firePlayer(car, input) {
    const s = this.slots.get(car.id);
    if (!s || !s.ready || !s.weapon) return;
    // Brake or look-back flips a dual-mode weapon to fire backwards.
    const backwards = !!(input.lookBack || input.brake > 0.55);
    this.tryFire(car, { backwards });
  }

  // ── AI firing ──────────────────────────────────────────────────────────

  _stepAI(s, dt) {
    const car = s.car;
    if (!car || car.finished) return;
    if (s.aiTimer > 0) { s.aiTimer -= dt; return; }
    s.aiHold += dt;

    const weapon = s.weapon;
    const game = this.game;
    const mode = weapon.aimMode ?? 'self';
    const forced = s.aiHold > this.aiMaxHold;
    let go = forced;
    let backwards = false;

    if (!go) {
      switch (mode) {
        case 'self': {
          if (weapon.id === 'turbo') {
            // Boost on a straight, on the ground, and not while spinning out.
            const straight = Math.abs(car.steer ?? 0) < 0.35;
            const grounded = (car.wheelsOnGround ?? 4) >= 3;
            const ok = straight && grounded && !this.effects.isImpaired(car)
              && Math.abs(car.speed ?? 0) > 1.2;
            go = ok;
          } else if (weapon.id === 'shield') {
            // Shield up when threatened: someone close behind, or already hurt.
            const st = game?.race?.standings;
            const gapBehind = st ? Math.abs(st.intervalBehind(car)) : 99;
            go = gapBehind < 2.2 || this.effects.isImpaired(car) || s.aiHold > 2.6;
          } else if (weapon.id === 'shockwave') {
            go = this._carsWithin(car, 2.4) >= 1;
          } else {
            go = true;   // clone: no reason to wait
          }
          break;
        }
        case 'forward': {
          const t = targetAhead(game, car, 26);
          if (t) {
            carPos(car, _p);
            carForward(car, _fwd);
            carPos(t, _dir).sub(_p);
            const dist = _dir.length();
            if (dist > 0.01) {
              _dir.multiplyScalar(1 / dist);
              go = _dir.dot(_fwd) > 0.55 && dist < 26;
            }
          }
          if (!go) {
            // Nothing ahead: consider a rearward shot at a close chaser.
            const b = targetBehind(game, car, 14);
            if (b && weapon.dual) { go = true; backwards = true; }
          }
          break;
        }
        case 'drop':
        case 'back': {
          const b = targetBehind(game, car, 18);
          go = !!b;
          backwards = true;
          break;
        }
        case 'target': {
          if (weapon.id === 'electro') {
            const leader = targetLeader(game, car);
            go = !!leader && leader !== car;
          } else {
            const t = targetAhead(game, car, weapon.stickRange ?? 40);
            go = !!t;
          }
          break;
        }
        default:
          go = true;
      }
    }

    if (!go) { s.aiTimer = 0.35; return; }
    if (mode === 'drop' || mode === 'back') backwards = true;
    const fired = this.tryFire(car, { backwards });
    if (!fired) s.aiTimer = 0.5;
  }

  _carsWithin(car, radius) {
    const cars = this.game?.cars ?? [];
    carPos(car, _p);
    const r2 = radius * radius;
    let n = 0;
    for (let i = 0; i < cars.length; i++) {
      const o = cars[i];
      if (!o || o === car) continue;
      carPos(o, _dir);
      if (_dir.distanceToSquared(_p) <= r2) n++;
    }
    return n;
  }

  // ── hazards ────────────────────────────────────────────────────────────

  _publishHazards() {
    const cars = this.game?.cars ?? [];
    if (cars.length === 0) return;
    // Skip the whole pass when there is nothing on the ground.
    let any = false;
    const a = this.projectiles.active;
    for (let i = 0; i < a.length; i++) if (a[i].data?.hazardSurfaceId) { any = true; break; }
    if (!any) {
      for (let i = 0; i < cars.length; i++) if (cars[i]) cars[i].hazardSurfaceId = 0;
      return;
    }
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) continue;
      carPos(car, _p);
      car.hazardSurfaceId = this.hazardSurfaceAt(_p.x, _p.y, _p.z);
    }
  }
}

export { WEAPONS, WEAPON_IDS, CONFIG };
export default PickupSystem;
