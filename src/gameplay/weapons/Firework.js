/**
 * Firework — the signature Re-Volt rocket.
 *
 * Homing-*ish* on purpose: it locks onto the car directly ahead but only turns
 * at a limited rate and drops the lock if the target gets outside a cone, so a
 * hard swerve or a corner genuinely dodges it. Leaves a smoke trail and goes
 * off with a knock-back explosion that also throws scenery around.
 *
 * Simulated with a custom sweep rather than a rigid body — a rocket wants a
 * straight, fast, deterministic flight path and exact contact points.
 */

import * as THREE from 'three';
import { Layer, createRayHit } from '../../physics/index.js';
import { clamp, clamp01 } from '../../core/MathUtils.js';
import { TrailRibbon, buildRocketMesh } from '../VisualKit.js';
import {
  carPos, carForward, carUp, carVelocity, muzzle, blast, hitCar,
  projectilesOf, shake, emitSpawn, emitExpire, fieldT, ramp,
} from './Common.js';

// ── scratch ────────────────────────────────────────────────────────────────
const _t = new THREE.Vector3();
const _seek = new THREE.Vector3();
const _step = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _n = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _bodies = [];
const _q = new THREE.Quaternion();
const _ZF = new THREE.Vector3(0, 0, -1);
/** One shared RayHit — the physics API requires the caller to own it. */
const RAY_HIT = createRayHit();

/** Effective collision radius of a car body, metres. */
const CAR_RADIUS = 0.125;

export const Firework = {
  id: 'firework',
  name: 'Firework',
  icon: 'firework',
  slots: 1,
  uses: 1,
  aimMode: 'forward',
  /** Player may fire it backwards by holding brake / look-back. */
  dual: true,
  entityKind: 'firework',
  lifetime: 6.5,
  /** Roll-table blurb for the UI. */
  blurb: 'Homes in on the car ahead.',

  // ── balance ───────────────────────────────────────────────────────────
  /** Mid-field to back-marker item: the classic comeback tool. */
  weight(place, carCount) { return ramp(place, carCount, 0.34, 1.00, 0.85); },
  usesFor(place, carCount) {
    const t = fieldT(place, carCount);
    return t > 0.7 ? 3 : t > 0.34 ? 2 : 1;
  },

  // ── tuning ────────────────────────────────────────────────────────────
  launchSpeed: 5.4,
  maxSpeed: 13.5,
  accel: 17.0,
  turnRate: 2.55,          // rad/s
  lockCone: 0.32,          // cos of the half-angle before the lock drops
  lockRange: 46,
  droop: 0.34,             // downward drift per second when unguided
  armTime: 0.10,           // seconds before it can hit anything
  selfImmune: 0.85,        // seconds the firer cannot be caught in its own blast
  blastRadius: 1.45,
  blastDeltaV: 5.1,
  directDeltaV: 7.4,

  // ── lifecycle ─────────────────────────────────────────────────────────

  fire(ctx) {
    const mgr = ctx.projectiles ?? projectilesOf(ctx.game);
    if (!mgr) return false;
    const e = mgr.spawn(Firework, ctx);
    if (!e) return false;
    emitSpawn(ctx.game, {
      weaponId: 'firework', carId: ctx.car?.id ?? -1, position: e.pos, kind: 'rocket',
    });
    shake(ctx.game, ctx.car?.isPlayer ? 0.22 : 0.06, 0.16);
    return true;
  },

  createEntity(mgr) {
    const game = mgr.game;
    const mesh = buildRocketMesh(game, { length: 0.115, radius: 0.019 });
    const ribbon = new TrailRibbon(game, {
      points: 30, width: 0.030, color: 0xffb070, headWidth: 0.28, taper: 1.5,
      name: 'fireworkTrail',
    });
    return {
      mesh,
      aux: [ribbon.mesh],
      data: {
        ribbon,
        dir: new THREE.Vector3(0, 0, -1),
        speed: 0,
        lock: false,
        dead: false,
        fade: 0,
        trailTimer: 0,
        ribbonFade: 1,
        spin: 0,
      },
    };
  },

  resetEntity(e, ctx, mgr) {
    const d = e.data;
    const car = ctx.car;
    const back = !!ctx.backwards;
    muzzle(car, back ? -0.20 : 0.20, 0.045, e.pos);
    carForward(car, _fwd);
    if (back) _fwd.negate();
    if (ctx.direction && ctx.direction.lengthSq() > 1e-6) _fwd.copy(ctx.direction).normalize();
    d.dir.copy(_fwd);
    // Inherit a little of the car's speed so a fast launch feels connected.
    carVelocity(car, _t);
    d.speed = Firework.launchSpeed + Math.max(0, _t.dot(_fwd)) * 0.55;
    d.lock = !!e.target && !back;
    d.dead = false;
    d.fade = 0;
    d.trailTimer = 0;
    d.ribbonFade = 1;
    d.spin = 0;
    e.life = Firework.lifetime;
    d.ribbon.color.setHex(0xffb070);
    d.ribbon.reset(e.pos);
    if (e.mesh) {
      e.mesh.position.copy(e.pos);
      e.mesh.visible = true;
      _q.setFromUnitVectors(_ZF, d.dir);
      e.mesh.quaternion.copy(_q);
      const flame = e.mesh.userData.parts?.flame;
      if (flame) flame.scale.set(1, 1, 1);
    }
    void mgr;
  },

  update(dt, e, game) {
    const d = e.data;

    // ── post-detonation: let the smoke hang for a beat ──
    if (d.dead) {
      d.fade -= dt;
      d.ribbonFade = clamp01(d.fade / 0.42);
      if (e.mesh) e.mesh.visible = false;
      return d.fade > 0;
    }

    const phys = game?.physics;
    d.speed = Math.min(Firework.maxSpeed, d.speed + Firework.accel * dt);

    // ── guidance ──
    const target = e.target;
    if (d.lock && target && !target.finished) {
      carPos(target, _t);
      _t.y += 0.035;
      _seek.copy(_t).sub(e.pos);
      const dist = _seek.length();
      if (dist > 0.01) {
        _seek.multiplyScalar(1 / dist);
        const dot = _seek.dot(d.dir);
        if (dot < Firework.lockCone || dist > Firework.lockRange) {
          d.lock = false;
        } else {
          // Tighter turns when close, so the endgame reads as a real strike.
          const gain = 1 + 0.9 * (1 - clamp01(dist / 9));
          rotateToward(d.dir, _seek, Firework.turnRate * gain * dt);
        }
      }
    } else {
      d.dir.y -= Firework.droop * dt;
      if (d.dir.lengthSq() < 1e-8) d.dir.set(0, 0, -1);
      d.dir.normalize();
    }

    // ── sweep ──
    const step = d.speed * dt;
    const reach = step + 0.04;

    // Track / static geometry.
    if (e.age > Firework.armTime && phys?.raycastTrack) {
      if (phys.raycastTrack(e.pos, d.dir, reach, RAY_HIT)) {
        _hitPoint.copy(RAY_HIT.point);
        _n.copy(RAY_HIT.normal);
        detonate(e, game, _hitPoint, _n, null);
        return true;
      }
    }

    // Cars (segment-vs-sphere so nothing is tunnelled through at 13 m/s).
    if (e.age > Firework.armTime) {
      const cars = game?.cars ?? [];
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i];
        if (!car) continue;
        if (car.id === e.ownerId && e.age < 0.5) continue;
        carPos(car, _t);
        const dist = distanceToSegment(_t, e.pos, d.dir, step + 0.03, _cp);
        if (dist < CAR_RADIUS + 0.028) {
          _n.copy(_cp).sub(_t);
          if (_n.lengthSq() < 1e-8) _n.copy(d.dir).negate();
          _n.normalize();
          detonate(e, game, _cp, _n, car);
          return true;
        }
      }
    }

    // Props.
    if (e.age > Firework.armTime && phys?.overlapSphere) {
      const n = phys.overlapSphere(e.pos, 0.085, _bodies, Layer.PROP | Layer.DEBRIS);
      if (n > 0) {
        _n.copy(d.dir).negate();
        detonate(e, game, e.pos, _n, null);
        return true;
      }
    }

    e.pos.addScaledVector(d.dir, step);

    // ── trail ──
    d.trailTimer -= dt;
    if (d.trailTimer <= 0) {
      d.trailTimer = 0.018;
      d.ribbon.push(e.pos);
    } else {
      d.ribbon.moveHead(e.pos);
    }
    d.spin += dt * 9;
    return true;
  },

  sync(e, alpha, mgr) {
    const d = e.data;
    if (!e.mesh) return;
    if (d.dead) return;
    // Interpolate between the previous and current sim position.
    e.mesh.position.lerpVectors(e.prevPos, e.pos, alpha);
    _q.setFromUnitVectors(_ZF, d.dir);
    e.mesh.quaternion.copy(_q);
    e.mesh.rotateZ(d.spin);
    const flame = e.mesh.userData.parts?.flame;
    if (flame) {
      const f = 0.75 + Math.sin(d.spin * 3.1) * 0.25;
      flame.scale.set(f, f, 0.8 + f * 0.5);
    }
    e.data.ribbonFade = d.dead ? clamp01(d.fade / 0.42) : 1;
    void mgr;
  },

  onDespawn(e, mgr) {
    e.data.ribbon.hide();
    e.data.ribbon.reset();
    if (e.mesh) e.mesh.visible = false;
    emitExpire(mgr.game, {
      weaponId: 'firework', carId: e.ownerId, position: e.pos, kind: 'rocket',
    });
  },

  disposeEntity(e) {
    e.data.ribbon.dispose();
  },
};

// ═══════════════════════════════════════════════════════════════ internals

/** Rotate `dir` toward `target` by at most `maxAngle` radians. In place. */
function rotateToward(dir, target, maxAngle) {
  const dot = clamp(dir.dot(target), -1, 1);
  const ang = Math.acos(dot);
  if (ang <= maxAngle || ang < 1e-5) { dir.copy(target); return dir; }
  const t = maxAngle / ang;
  dir.lerp(target, t);
  if (dir.lengthSq() < 1e-10) dir.copy(target);
  return dir.normalize();
}

/**
 * Distance from `point` to the segment origin→origin+dir*len.
 * Writes the closest point on the segment into `outCp`.
 */
function distanceToSegment(point, origin, dir, len, outCp) {
  _step.copy(point).sub(origin);
  let t = _step.dot(dir);
  if (t < 0) t = 0; else if (t > len) t = len;
  outCp.copy(origin).addScaledVector(dir, t);
  return outCp.distanceTo(point);
}

function detonate(e, game, point, normal, directCar) {
  const d = e.data;
  const mgr = projectilesOf(game);
  d.dead = true;
  d.fade = 0.42;
  d.ribbonFade = 1;
  if (e.mesh) e.mesh.visible = false;

  mgr?.burst(point, 1.25, 0.52, normal, 0xffb060);

  const skip = [];
  if (directCar) {
    carPos(directCar, _t);
    _n.copy(_t).sub(point);
    if (_n.lengthSq() < 1e-8) carForward(directCar, _n);
    _n.normalize();
    hitCar(game, directCar, {
      deltaV: Firework.directDeltaV,
      direction: _n,
      upBias: 0.85,
      spin: 7.5 * (directCar.id % 2 ? 1 : -1),
      roll: 4.5,
      sourceId: e.ownerId,
      weaponId: 'firework',
      worldPoint: point,
      shake: 0.9,
      shakeTime: 0.4,
    });
    skip.push(directCar.id);
  }

  blast(game, {
    position: point,
    radius: Firework.blastRadius,
    deltaV: Firework.blastDeltaV,
    upBias: 0.72,
    spin: 6.0,
    roll: 4.2,
    sourceId: e.ownerId,
    weaponId: 'firework',
    skipCarId: e.age < Firework.selfImmune ? e.ownerId : -1,
    skipIds: skip,
    propDeltaV: 6.5,
    shake: 0.55,
  });

  shake(game, 0.5, 0.28);
}

export default Firework;
