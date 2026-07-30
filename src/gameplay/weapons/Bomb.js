/**
 * Bomb — the hot potato. The best item in Re-Volt, and the one that has to be
 * exactly right.
 *
 * Firing it *sticks* the bomb to the car ahead with a lit fuse. The fuse never
 * resets. The only way out is to ram somebody else hard enough to pass it on,
 * which turns the whole pack into a panicking scrum for eight seconds. If the
 * fuse runs out you are launched, flattened and briefly useless.
 *
 * Details that make it work:
 *   • the fuse is global to the bomb, not to the holder — passing it on buys
 *     you time, it does not clear the danger,
 *   • a short immunity after each transfer stops it ping-ponging in one contact,
 *   • the spark and beep accelerate as the fuse burns down, so everybody can
 *     read how desperate the holder is,
 *   • a shield refuses the hand-off (and pops), which is the single best use of
 *     a shield in the game,
 *   • the ramming test is proximity + closing speed rather than a contact
 *     event, so a light nudge at speed transfers and resting against someone
 *     in a pile-up does not.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../../core/MathUtils.js';
import { buildBombMesh } from '../VisualKit.js';
import {
  carPos, carForward, carUp, carVelocity, blast, hitCar,
  effectsOf, projectilesOf, targetAhead, targetBehind,
  shake, emitSpawn, emitExpire, emitHit, ramp, fieldT,
} from './Common.js';

const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Never more than this many bombs live at once. */
const MAX_BOMBS = 3;

export const Bomb = {
  id: 'bomb',
  name: 'Bomb',
  icon: 'bomb',
  slots: 1,
  uses: 1,
  aimMode: 'target',
  entityKind: 'bomb',
  lifetime: 12.0,
  blurb: 'Sticks to the car ahead. Pass it on!',

  // ── balance: a back-half item. Needs somebody ahead to be worth anything. ──
  weight(place, carCount) {
    if (place <= 1 && carCount > 2) return 0.10;   // leader can still bomb backwards
    return ramp(place, carCount, 0.22, 0.98, 1.25);
  },
  usesFor() { return 1; },

  // ── tuning ────────────────────────────────────────────────────────────
  fuseTime: 8.0,
  /** Distance at which a ram counts as a hand-off. */
  transferRadius: 0.38,
  /** Closing speed required to pass it on, m/s. */
  transferSpeed: 1.05,
  /** Blackout after a transfer so one contact cannot bounce it twice. */
  transferImmunity: 0.75,
  /** How far ahead we will look for a victim. */
  stickRange: 40,
  blastRadius: 1.8,
  blastDeltaV: 7.0,
  holderDeltaV: 8.6,
  squashTime: 3.4,
  /** Height above the chassis origin the bomb rides at. */
  rideHeight: 0.105,

  fire(ctx) {
    const game = ctx.game;
    const car = ctx.car;
    const mgr = ctx.projectiles ?? projectilesOf(game);
    if (!mgr) return false;

    if (mgr.countOfKind('bomb') >= MAX_BOMBS) {
      const old = mgr.oldestOfKind('bomb');
      if (old) mgr.despawn(old);
    }

    // Pick a victim: ahead → behind → yourself (comedy, but never a dud item).
    let victim = ctx.target ?? targetAhead(game, car, Bomb.stickRange);
    if (victim && (victim.hasBomb || victim === car)) victim = null;
    if (!victim) {
      const b = targetBehind(game, car, Bomb.stickRange);
      if (b && !b.hasBomb) victim = b;
    }
    if (!victim) {
      const cars = game?.cars ?? [];
      for (let i = 0; i < cars.length; i++) {
        const o = cars[i];
        if (o && o !== car && !o.hasBomb) { victim = o; break; }
      }
    }
    if (!victim) victim = car;

    const e = mgr.spawn(Bomb, { ...ctx, target: victim });
    if (!e) return false;
    emitSpawn(game, {
      weaponId: 'bomb', carId: car?.id ?? -1, position: e.pos, kind: 'bomb',
    });
    game?.bus?.emit('bomb:attach', {
      carId: victim.id, sourceId: car?.id ?? -1, fuse: Bomb.fuseTime,
    });
    shake(game, victim.isPlayer ? 0.4 : 0.1, 0.3);
    return true;
  },

  createEntity(mgr) {
    const mesh = buildBombMesh(mgr.game, 0.042);
    // Per-entity materials: we animate the halo opacity and the casing glow,
    // and the library hands out shared instances.
    const parts = mesh.userData.parts;
    if (parts) {
      parts.halo.material = parts.halo.material.clone();
      parts.ball.material = parts.ball.material.clone();
    }
    return {
      mesh,
      data: {
        holder: null,
        fuse: Bomb.fuseTime,
        immunity: 0,
        beepPhase: 0,
        spin: 0,
        exploded: false,
      },
    };
  },

  resetEntity(e, ctx, mgr) {
    const d = e.data;
    d.holder = ctx.target ?? ctx.car ?? null;
    d.fuse = Bomb.fuseTime;
    d.immunity = Bomb.transferImmunity;
    d.beepPhase = 0;
    d.spin = 0;
    d.exploded = false;
    e.life = Bomb.fuseTime + 1.5;
    if (d.holder) {
      markHolder(d.holder, d.fuse);
      carPos(d.holder, e.pos);
      carUp(d.holder, _up);
      e.pos.addScaledVector(_up, Bomb.rideHeight);
    }
    if (e.mesh) { e.mesh.visible = true; e.mesh.position.copy(e.pos); }
    void mgr;
  },

  update(dt, e, game) {
    const d = e.data;
    if (d.exploded) return false;
    const holder = d.holder;
    if (!holder) return false;

    d.fuse -= dt;
    if (d.immunity > 0) d.immunity -= dt;
    d.spin += dt * 1.6;
    holder.bombFuse = d.fuse;
    if (holder.effects) holder.effects.bomb = d.fuse;

    // Track the holder in sim space (visual placement happens in sync).
    carPos(holder, e.pos);
    carUp(holder, _up);
    e.pos.addScaledVector(_up, Bomb.rideHeight);

    // ── fuse expired ──
    if (d.fuse <= 0) {
      explode(e, game);
      return false;
    }

    // ── hand-off ──
    if (d.immunity <= 0) {
      const cars = game?.cars ?? [];
      carPos(holder, _p);
      carVelocity(holder, _v);
      const r2 = Bomb.transferRadius * Bomb.transferRadius;
      for (let i = 0; i < cars.length; i++) {
        const o = cars[i];
        if (!o || o === holder || o.hasBomb) continue;
        carPos(o, _p2);
        _d.copy(_p2).sub(_p);
        const dist2 = _d.lengthSq();
        if (dist2 > r2) continue;
        // Closing speed along the line between the two cars.
        carVelocity(o, _v2);
        const dist = Math.sqrt(Math.max(1e-8, dist2));
        _d.multiplyScalar(1 / dist);
        const closing = _v.dot(_d) - _v2.dot(_d);
        if (closing < Bomb.transferSpeed) continue;
        transfer(e, game, o, _p2, closing);
        break;
      }
    }

    // ── beeping / sparking cadence ──
    const urgency = 1 - clamp01(d.fuse / Bomb.fuseTime);
    const rate = 1.4 + urgency * 9.5;
    const prev = d.beepPhase;
    d.beepPhase += dt * rate;
    if (Math.floor(d.beepPhase) !== Math.floor(prev)) {
      game?.bus?.emit('bomb:tick', {
        carId: holder.id, fuse: d.fuse, urgency,
      });
    }
    return true;
  },

  sync(e, alpha, mgr) {
    const d = e.data;
    if (!e.mesh || !d.holder) return;
    const holder = d.holder;
    // Ride on the interpolated visual transform so it never judders.
    const g = holder.group;
    if (g) {
      _up.set(0, 1, 0).applyQuaternion(g.quaternion);
      e.mesh.position.copy(g.position).addScaledVector(_up, Bomb.rideHeight);
      e.mesh.quaternion.copy(g.quaternion);
    } else {
      e.mesh.position.copy(e.pos);
    }
    e.mesh.rotateY(d.spin);

    const urgency = 1 - clamp01(d.fuse / Bomb.fuseTime);
    const parts = e.mesh.userData.parts;
    if (parts) {
      // Spark flickers faster and brighter as the fuse burns down.
      const flick = 0.65 + 0.35 * Math.sin(d.beepPhase * Math.PI * 2);
      const s = (0.7 + urgency * 1.5) * flick;
      parts.spark.scale.setScalar(s);
      parts.halo.scale.setScalar(s * (1.6 + urgency));
      if (parts.halo.material?.opacity !== undefined) {
        parts.halo.material.opacity = 0.18 + urgency * 0.35;
      }
      // The casing itself starts to glow red hot near the end.
      const m = parts.ball.material;
      if (m?.emissive) {
        m.emissive.setRGB(urgency * urgency * 0.9, urgency * urgency * 0.12, 0);
        m.emissiveIntensity = 1;
      }
    }
    void alpha; void mgr;
  },

  onDespawn(e, mgr) {
    const d = e.data;
    if (d.holder) clearHolder(d.holder);
    d.holder = null;
    if (e.mesh) e.mesh.visible = false;
    emitExpire(mgr.game, {
      weaponId: 'bomb', carId: e.ownerId, position: e.pos, kind: 'bomb',
    });
  },

  disposeEntity(e) {
    const parts = e.mesh?.userData?.parts;
    parts?.halo?.material?.dispose?.();
    parts?.ball?.material?.dispose?.();
  },
};

// ═══════════════════════════════════════════════════════════════ internals

function markHolder(car, fuse) {
  car.hasBomb = true;
  car.bombFuse = fuse;
  if (car.effects) car.effects.bomb = fuse;
}

function clearHolder(car) {
  car.hasBomb = false;
  car.bombFuse = 0;
  if (car.effects) car.effects.bomb = 0;
}

function transfer(e, game, to, point, closing) {
  const d = e.data;
  const fx = effectsOf(game);
  const from = d.holder;

  // A shield refuses the hand-off — and pops doing it.
  if (fx && !fx.tryDamage(to, {
    sourceId: from?.id ?? -1, weaponId: 'bomb', worldPoint: point,
  })) {
    d.immunity = Bomb.transferImmunity;
    game?.bus?.emit('bomb:refused', { carId: to.id, fromId: from?.id ?? -1 });
    return;
  }

  clearHolder(from);
  d.holder = to;
  d.immunity = Bomb.transferImmunity;
  markHolder(to, d.fuse);

  const mgr = projectilesOf(game);
  carPos(to, _p2);
  _p2.y += 0.05;
  mgr?.bolt(point, _p2, 0.22, 0xffb060);
  mgr?.tick(point, null, 0xffc070);

  game?.bus?.emit('bomb:transfer', {
    fromId: from?.id ?? -1, toId: to.id, fuse: d.fuse, closing,
    position: point.clone(),
  });
  emitHit(game, {
    carId: to.id, sourceId: from?.id ?? -1, weaponId: 'bomb',
    worldPoint: point, impulse: 0.6,
  });
  if (to.isPlayer || from?.isPlayer) shake(game, 0.45, 0.25);
}

function explode(e, game) {
  const d = e.data;
  if (d.exploded) return;
  d.exploded = true;
  const holder = d.holder;
  const mgr = projectilesOf(game);

  carPos(holder, _p);
  const skip = [];

  mgr?.burst(_p, 1.75, 0.65, null, 0xffd090);

  // The holder takes the full force — straight up and spinning.
  if (holder) {
    _d.set((Math.random() - 0.5) * 0.5, 1, (Math.random() - 0.5) * 0.5).normalize();
    const landed = hitCar(game, holder, {
      deltaV: Bomb.holderDeltaV,
      direction: _d,
      upBias: 0.9,
      spin: 12 * (holder.id % 2 ? 1 : -1),
      roll: 9,
      effect: 'squashed',
      effectTime: Bomb.squashTime,
      sourceId: e.ownerId,
      weaponId: 'bomb',
      worldPoint: _p,
      shake: 1.6,
      shakeTime: 0.7,
    });
    if (landed) {
      effectsOf(game)?.apply(holder, 'electro', 0.8, {
        sourceId: e.ownerId, weaponId: 'bomb',
      });
    }
    skip.push(holder.id);
    clearHolder(holder);
  }

  blast(game, {
    position: _p,
    radius: Bomb.blastRadius,
    deltaV: Bomb.blastDeltaV,
    upBias: 0.95,
    spin: 8.5,
    roll: 6.5,
    sourceId: e.ownerId,
    weaponId: 'bomb',
    skipIds: skip,
    propDeltaV: 9,
    shake: 0.9,
  });

  game?.bus?.emit('bomb:explode', { carId: holder?.id ?? -1, position: _p.clone() });
  shake(game, 0.85, 0.45);
  void clamp; void fieldT;
}

export default Bomb;
