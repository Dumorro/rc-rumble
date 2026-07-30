/**
 * Shared weapon plumbing: muzzle placement, radial blasts, single-car hits,
 * target selection and the event emission every weapon must do.
 *
 * Everything is allocation free — module scratch vectors, reused hit records.
 * Damage always routes through the Effects layer so shields work universally
 * and every effect lands identically on the player and on the AI.
 */

import * as THREE from 'three';
import { createRayHit, Layer } from '../../physics/index.js';
import { clamp, clamp01 } from '../../core/MathUtils.js';

// ── scratch ────────────────────────────────────────────────────────────────
const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _j = new THREE.Vector3();
const _tq = new THREE.Vector3();
const _hit = createRayHit();
const _hit2 = createRayHit();
const _down = new THREE.Vector3(0, -1, 0);
const _bodies = [];

export { clamp, clamp01, Layer };

// ═══════════════════════════════════════════════════════════════ car reads

/** Exact simulation position of a car (never the interpolated visual one). */
export function carPos(car, out) {
  if (car?.body?.position) return out.copy(car.body.position);
  if (typeof car?.simPosition === 'function') return car.simPosition(out);
  if (car?.group?.position) return out.copy(car.group.position);
  return out.set(0, 0, 0);
}

export function carForward(car, out) {
  if (car?.body?.getForward) return car.body.getForward(out);
  if (typeof car?.getForward === 'function') return car.getForward(out);
  if (car?.group) return out.set(0, 0, -1).applyQuaternion(car.group.quaternion);
  return out.set(0, 0, -1);
}

export function carUp(car, out) {
  if (car?.body?.getUp) return car.body.getUp(out);
  if (typeof car?.getUp === 'function') return car.getUp(out);
  if (car?.group) return out.set(0, 1, 0).applyQuaternion(car.group.quaternion);
  return out.set(0, 1, 0);
}

export function carRight(car, out) {
  if (car?.body?.getRight) return car.body.getRight(out);
  if (typeof car?.getRight === 'function') return car.getRight(out);
  if (car?.group) return out.set(1, 0, 0).applyQuaternion(car.group.quaternion);
  return out.set(1, 0, 0);
}

export function carVelocity(car, out) {
  if (car?.body?.velocity) return out.copy(car.body.velocity);
  return out.set(0, 0, 0);
}

/** Approximate half-length of a car body, for muzzle offsets. */
export function carHalfLength(car) {
  const c = car?.body?.collider;
  if (c?.halfExtents?.z) return c.halfExtents.z;
  return 0.15;
}

/**
 * A muzzle point in front of (or behind) a car, lifted clear of the chassis.
 * @param {object} car
 * @param {number} distance metres forward (negative = behind)
 * @param {number} lift metres above the chassis origin
 */
export function muzzle(car, distance, lift, out) {
  carPos(car, out);
  carForward(car, _fwd);
  carUp(car, _up);
  out.addScaledVector(_fwd, distance);
  out.addScaledVector(_up, lift);
  return out;
}

// ═══════════════════════════════════════════════════════════════ world reads

/**
 * Ground under a point. `out` is a RayHit you own, or the shared scratch.
 * @returns {object|null} the hit record, or null when nothing is below.
 */
export function groundBelow(game, position, maxDist = 1.2, out = _hit) {
  const phys = game?.physics;
  if (!phys?.raycastTrack) return null;
  _p2.copy(position);
  _p2.y += 0.08;
  return phys.raycastTrack(_p2, _down, maxDist + 0.08, out) ? out : null;
}

/**
 * First thing a ray hits, statics + bodies. Returns the shared scratch record.
 * @returns {object|null}
 */
export function rayHitWorld(game, origin, dir, maxDist, mask = Layer.ALL, out = _hit2) {
  const phys = game?.physics;
  if (!phys?.raycast) return null;
  return phys.raycast(origin, dir, maxDist, out, mask) ? out : null;
}

// ═══════════════════════════════════════════════════════════════ targeting

export function standingsOf(game) { return game?.race?.standings ?? null; }
export function effectsOf(game) { return game?.pickups?.effects ?? game?.effects ?? null; }
export function projectilesOf(game) { return game?.pickups?.projectiles ?? null; }

/** The car directly ahead on the road — the natural target for most weapons. */
export function targetAhead(game, car, maxMetres = 80) {
  const s = standingsOf(game);
  if (s) {
    const t = s.nearestAheadOnRoad(car, maxMetres);
    if (t && t !== car) return t;
  }
  return nearestCarInCone(game, car, maxMetres, 0.35, +1);
}

/** The car directly behind — for rear-fired weapons. */
export function targetBehind(game, car, maxMetres = 80) {
  const s = standingsOf(game);
  if (s) {
    const t = s.nearestBehindOnRoad(car, maxMetres);
    if (t && t !== car) return t;
  }
  return nearestCarInCone(game, car, maxMetres, 0.35, -1);
}

/** The race leader (or the car ahead if we are already leading). */
export function targetLeader(game, car) {
  const s = standingsOf(game);
  const leader = s?.leaderCar ?? null;
  if (leader && leader !== car) return leader;
  return targetAhead(game, car) ?? null;
}

/**
 * Geometric fallback when there are no standings: nearest car within a cone
 * around the forward (`sign` +1) or backward (`sign` -1) axis.
 */
export function nearestCarInCone(game, car, maxMetres, minDot, sign = 1) {
  const cars = game?.cars;
  if (!cars || cars.length < 2) return null;
  carPos(car, _p);
  carForward(car, _fwd);
  if (sign < 0) _fwd.negate();
  let best = null, bestD = Infinity;
  for (let i = 0; i < cars.length; i++) {
    const o = cars[i];
    if (!o || o === car) continue;
    carPos(o, _p2).sub(_p);
    const d = _p2.length();
    if (d < 1e-4 || d > maxMetres) continue;
    _p2.multiplyScalar(1 / d);
    if (_p2.dot(_fwd) < minDot) continue;
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════ damage

/**
 * Hit one car: routed through the shield check, applies an impulse plus an
 * optional status effect, and emits `weapon:hit`.
 *
 * @param {object} game
 * @param {object} car victim
 * @param {object} o
 * @param {number} [o.deltaV] speed change in m/s (mass independent)
 * @param {THREE.Vector3} [o.direction] push direction (normalized-ish)
 * @param {number} [o.upBias] extra upward fraction added to the push
 * @param {number} [o.spin] yaw impulse in rad/s
 * @param {number} [o.roll] roll impulse in rad/s (flips cars)
 * @param {string} [o.effect] effect key to apply
 * @param {number} [o.effectTime] seconds
 * @param {number} [o.sourceId]
 * @param {string} [o.weaponId]
 * @param {THREE.Vector3} [o.worldPoint]
 * @param {boolean} [o.pierce] ignore shields
 * @param {number} [o.shake] camera shake amount
 * @returns {boolean} true when the hit landed (false = shielded)
 */
export function hitCar(game, car, o = {}) {
  if (!car) return false;
  const fx = effectsOf(game);
  const point = o.worldPoint ?? carPos(car, _p2);
  if (fx && !fx.tryDamage(car, {
    sourceId: o.sourceId ?? -1, weaponId: o.weaponId ?? null,
    worldPoint: point, pierce: !!o.pierce,
  })) return false;

  const body = car.body;
  const dv = o.deltaV ?? 0;
  if (body && dv !== 0) {
    body.wake();
    if (o.direction) _dir.copy(o.direction);
    else carForward(car, _dir);
    if (o.upBias) _dir.y += o.upBias;
    if (_dir.lengthSq() < 1e-9) _dir.set(0, 1, 0);
    _dir.normalize();
    _j.copy(_dir).multiplyScalar(dv * body.mass);
    body.applyImpulse(_j);
  }
  if (body && (o.spin || o.roll) && body.isDynamicMass) {
    // Written straight into angularVelocity so the numbers stay in rad/s
    // regardless of the car's mass distribution — an angular *impulse* would
    // be divided by the inertia tensor and become unpredictable per car class.
    carUp(car, _up);
    carForward(car, _fwd);
    body.wake();
    if (o.spin) body.angularVelocity.addScaledVector(_up, o.spin);
    if (o.roll) body.angularVelocity.addScaledVector(_fwd, o.roll);
    const maxW = body.maxAngularSpeed ?? 60;
    if (body.angularVelocity.lengthSq() > maxW * maxW) body.angularVelocity.setLength(maxW);
  }

  if (o.effect && fx) {
    fx.apply(car, o.effect, o.effectTime ?? 1.5, {
      sourceId: o.sourceId ?? -1, weaponId: o.weaponId ?? null,
    });
  }

  emitHit(game, {
    carId: car.id, sourceId: o.sourceId ?? -1, weaponId: o.weaponId ?? null,
    worldPoint: point, impulse: dv * (body?.mass ?? 1),
  });

  if (o.shake && car.isPlayer) {
    game?.bus?.emit('camera:shake', { amount: o.shake, duration: o.shakeTime ?? 0.35 });
  }
  return true;
}

/**
 * Radial blast: pushes cars, props and debris away from a point, applies an
 * effect scaled by falloff and fires the FX.
 *
 * @param {object} game
 * @param {object} o
 * @param {THREE.Vector3} o.position
 * @param {number} [o.radius] metres
 * @param {number} [o.deltaV] push at the epicentre, m/s
 * @param {number} [o.upBias] 0..1.5 upward component (flips cars)
 * @param {number} [o.spin] yaw kick at the epicentre, rad/s
 * @param {number} [o.roll] roll kick at the epicentre, rad/s
 * @param {string} [o.effect]
 * @param {number} [o.effectTime]
 * @param {number} [o.sourceId]
 * @param {string} [o.weaponId]
 * @param {number} [o.skipCarId] the firer, usually immune
 * @param {number[]} [o.skipIds] additional car ids to skip (already hit directly)
 * @param {number} [o.propDeltaV] separate push for scenery props
 * @param {number} [o.falloffPower] 1 = linear, 2 = quadratic (default 1.6)
 * @param {number} [o.minFalloff] floor on the falloff inside the radius
 * @returns {number} how many cars were affected
 */
export function blast(game, o) {
  const pos = o.position;
  const radius = o.radius ?? 1.4;
  const r2 = radius * radius;
  const power = o.falloffPower ?? 1.6;
  const minF = o.minFalloff ?? 0;
  let hits = 0;

  const cars = game?.cars ?? [];
  const skipIds = o.skipIds ?? null;
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    if (!car || car.id === o.skipCarId) continue;
    if (skipIds && skipIds.indexOf(car.id) >= 0) continue;
    carPos(car, _p2);
    const d2 = _p2.distanceToSquared(pos);
    if (d2 > r2) continue;
    const d = Math.sqrt(d2);
    const f = Math.max(minF, Math.pow(1 - clamp01(d / radius), power));

    _dir.copy(_p2).sub(pos);
    if (_dir.lengthSq() < 1e-8) carForward(car, _dir);
    _dir.normalize();

    const landed = hitCar(game, car, {
      deltaV: (o.deltaV ?? 3.5) * f,
      direction: _dir,
      upBias: o.upBias ?? 0.55,
      spin: (o.spin ?? 0) * f * (i % 2 ? 1 : -1),
      roll: (o.roll ?? 0) * f * (i % 2 ? -1 : 1),
      effect: o.effect,
      effectTime: (o.effectTime ?? 0) * Math.max(0.45, f),
      sourceId: o.sourceId,
      weaponId: o.weaponId,
      worldPoint: pos,
      pierce: o.pierce,
      shake: (o.shake ?? 0.5) * f,
      shakeTime: o.shakeTime,
    });
    if (landed) hits++;
  }

  // Scenery: let the blast throw props and debris around too.
  const phys = game?.physics;
  if (phys?.overlapSphere) {
    const n = phys.overlapSphere(pos, radius, _bodies, Layer.PROP | Layer.DEBRIS);
    const pdv = o.propDeltaV ?? (o.deltaV ?? 3.5) * 1.3;
    for (let i = 0; i < n; i++) {
      const b = _bodies[i];
      if (!b || b.static || b.invMass === 0) continue;
      _dir.copy(b.position).sub(pos);
      const d = _dir.length();
      if (d < 1e-6) _dir.set(0, 1, 0); else _dir.multiplyScalar(1 / d);
      const f = Math.max(minF, Math.pow(1 - clamp01(d / radius), power));
      _dir.y += 0.5;
      _dir.normalize();
      b.wake();
      b.applyImpulse(_j.copy(_dir).multiplyScalar(pdv * f * b.mass));
      b.applyTorqueImpulse(_tq.set(
        (Math.random() - 0.5) * 0.02 * f,
        (Math.random() - 0.5) * 0.02 * f,
        (Math.random() - 0.5) * 0.02 * f,
      ));
    }
  }
  return hits;
}

// ═══════════════════════════════════════════════════════════════ events

/** `pickup:used` — fired by PickupSystem, exposed here for weapons that chain. */
export function emitUsed(game, { carId, weaponId, targetId = -1 }) {
  game?.bus?.emit('pickup:used', { carId, weaponId, targetId });
}

/**
 * `weapon:hit` — the canonical "a weapon connected" event.
 *
 * The payload is freshly built and its `worldPoint` is a private copy, so a
 * listener may safely retain it (unlike the pooled physics collision events).
 * Weapon hits happen a handful of times per car per race, so the allocation is
 * nowhere near a hot path and it removes an entire class of aliasing bug for
 * the FX / audio / UI systems.
 */
export function emitHit(game, payload) {
  const bus = game?.bus;
  if (!bus) return;
  bus.emit('weapon:hit', {
    carId: payload.carId,
    sourceId: payload.sourceId ?? -1,
    weaponId: payload.weaponId ?? null,
    worldPoint: payload.worldPoint ? payload.worldPoint.clone() : null,
    impulse: payload.impulse ?? 0,
  });
}

/** Extra, documented: a projectile appeared / vanished (FX + audio hooks). */
export function emitSpawn(game, { weaponId, carId, position, kind }) {
  game?.bus?.emit('weapon:spawn', {
    weaponId, carId, kind, position: position ? position.clone() : null,
  });
}

export function emitExpire(game, { weaponId, carId, position, kind }) {
  game?.bus?.emit('weapon:expire', {
    weaponId, carId, kind, position: position ? position.clone() : null,
  });
}

export function shake(game, amount, duration = 0.3) {
  game?.bus?.emit('camera:shake', { amount, duration });
}

// ═══════════════════════════════════════════════════════════════ weighting

/**
 * Linear ramp helper for `weight(place, carCount)` functions.
 * `t` = 0 for the leader, 1 for last place.
 */
export function fieldT(place, carCount) {
  if (!(carCount > 1)) return 0;
  return clamp01((place - 1) / (carCount - 1));
}

/** Ramp from `atFront` (leader) to `atBack` (last), with an optional curve. */
export function ramp(place, carCount, atFront, atBack, curve = 1) {
  const t = Math.pow(fieldT(place, carCount), curve);
  return atFront + (atBack - atFront) * t;
}

export default {
  carPos, carForward, carUp, carRight, carVelocity, carHalfLength, muzzle,
  groundBelow, rayHitWorld, standingsOf, effectsOf, projectilesOf,
  targetAhead, targetBehind, targetLeader, nearestCarInCone,
  hitCar, blast, emitUsed, emitHit, emitSpawn, emitExpire, shake,
  fieldT, ramp,
};
