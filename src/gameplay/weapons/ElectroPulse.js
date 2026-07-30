/**
 * Electro-Pulse — instantly zaps the race leader and stalls their motor.
 *
 * No projectile, no dodge: it is the one guaranteed hit in the game, which is
 * exactly why it only rolls for cars well down the field. The motor dies for
 * ~1.5 s while the car keeps its momentum, so a leader who is *smart* about it
 * can still coast through a corner and lose very little.
 *
 * The VFX is a chain: source → leader, then short arcs from the leader to any
 * car close enough to catch a splash zap (0.6 s, a nuisance rather than a kill).
 */

import * as THREE from 'three';
import { clamp01 } from '../../core/MathUtils.js';
import {
  carPos, carUp, effectsOf, projectilesOf, targetLeader, standingsOf,
  hitCar, shake, emitSpawn, ramp,
} from './Common.js';

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3();

export const ElectroPulse = {
  id: 'electro',
  name: 'Electro-Pulse',
  icon: 'electro',
  slots: 1,
  uses: 1,
  aimMode: 'target',
  entityKind: 'electro',
  lifetime: 0.9,
  blurb: 'Stalls the leader. No escape.',

  // ── balance ───────────────────────────────────────────────────────────
  // Useless in the lead, devastating from the back. Strong curve so it is a
  // genuine backmarker equaliser rather than a mid-field staple.
  weight(place, carCount) {
    if (place <= 1) return 0.02;
    if (carCount <= 2) return 0.55;
    return ramp(place, carCount, 0.10, 1.00, 1.7);
  },
  usesFor() { return 1; },

  // ── tuning ────────────────────────────────────────────────────────────
  stallTime: 1.55,
  splashStallTime: 0.65,
  splashRadius: 2.6,
  /** Small forward jolt so the victim's line is disturbed, not just their motor. */
  jolt: 1.1,
  boltDuration: 0.46,
  color: 0x9fd8ff,

  /**
   * Instant weapon — no entity. Returns false when there is nothing to hit,
   * which makes PickupSystem keep the item rather than waste it.
   */
  fire(ctx) {
    const game = ctx.game;
    const car = ctx.car;
    const fx = effectsOf(game);
    const mgr = ctx.projectiles ?? projectilesOf(game);

    let target = ctx.target ?? targetLeader(game, car);
    if (target === car) target = null;
    if (!target) {
      // Fall back to the nearest other car so the item is never truly wasted.
      const cars = game?.cars ?? [];
      carPos(car, _from);
      let bestD = Infinity;
      for (let i = 0; i < cars.length; i++) {
        const o = cars[i];
        if (!o || o === car) continue;
        carPos(o, _p);
        const d = _p.distanceToSquared(_from);
        if (d < bestD) { bestD = d; target = o; }
      }
    }
    if (!target) return false;

    // ── main strike ──
    carPos(car, _from);
    carUp(car, _up);
    _from.addScaledVector(_up, 0.075);
    carPos(target, _to);
    _to.y += 0.06;

    mgr?.bolt(_from, _to, ElectroPulse.boltDuration, ElectroPulse.color);

    carPos(target, _p).sub(_from);
    if (_p.lengthSq() < 1e-8) _p.set(0, 0, -1);
    _p.normalize();

    const landed = hitCar(game, target, {
      deltaV: ElectroPulse.jolt,
      direction: _p,
      upBias: 0.15,
      spin: 1.4 * (target.id % 2 ? 1 : -1),
      effect: 'electro',
      effectTime: ElectroPulse.stallTime,
      sourceId: car?.id ?? -1,
      weaponId: 'electro',
      worldPoint: _to,
      shake: 0.85,
      shakeTime: 0.5,
    });

    // ── chain to nearby cars ──
    if (landed && fx) {
      const cars = game?.cars ?? [];
      const r2 = ElectroPulse.splashRadius * ElectroPulse.splashRadius;
      carPos(target, _from);
      for (let i = 0; i < cars.length; i++) {
        const o = cars[i];
        if (!o || o === target || o === car) continue;
        carPos(o, _p);
        if (_p.distanceToSquared(_from) > r2) continue;
        if (!fx.tryDamage(o, {
          sourceId: car?.id ?? -1, weaponId: 'electro', worldPoint: _p,
        })) continue;
        mgr?.bolt(_from, _p, ElectroPulse.boltDuration * 0.7, ElectroPulse.color);
        fx.electro(o, ElectroPulse.splashStallTime, {
          sourceId: car?.id ?? -1, weaponId: 'electro',
        });
        game?.bus?.emit('weapon:hit', {
          carId: o.id, sourceId: car?.id ?? -1, weaponId: 'electro',
          worldPoint: _p, impulse: 0.4,
        });
      }
    }

    emitSpawn(game, {
      weaponId: 'electro', carId: car?.id ?? -1, position: _to, kind: 'bolt',
    });
    shake(game, car?.isPlayer ? 0.3 : 0.1, 0.22);
    void standingsOf; void clamp01;
    return true;
  },
};

export default ElectroPulse;
