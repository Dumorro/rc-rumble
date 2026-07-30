/**
 * Water Balloon — a lobbed, fully simulated arcing projectile.
 *
 * Fired as a real rigid body so it bounces once off a table edge, tumbles down
 * a ramp and generally does chaotic things you could not script. Bursts on the
 * first meaningful contact (or when it stops moving) with a splash that soaks
 * and briefly blinds everyone nearby — a soft, forgiving weapon, which is what
 * makes it the safest thing to hand a mid-field car.
 */

import * as THREE from 'three';
import { createSphereBody, makeSphere, Layer } from '../../physics/index.js';
import { clamp01 } from '../../core/MathUtils.js';
import { buildBalloonMesh } from '../VisualKit.js';
import {
  carPos, carForward, carUp, carVelocity, muzzle, blast, hitCar,
  effectsOf, projectilesOf, shake, emitSpawn, emitExpire, ramp, fieldT,
} from './Common.js';

const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export const WaterBalloon = {
  id: 'balloon',
  name: 'Water Balloon',
  icon: 'balloon',
  slots: 1,
  uses: 2,
  aimMode: 'forward',
  dual: true,
  entityKind: 'balloon',
  lifetime: 5.5,
  blurb: 'Lobbed splash — soaks and blinds.',

  // ── balance: broad mid-field item, slightly back-weighted ──────────────
  weight(place, carCount) { return ramp(place, carCount, 0.46, 0.86); },
  usesFor(place, carCount) { return fieldT(place, carCount) > 0.45 ? 3 : 2; },

  // ── tuning ────────────────────────────────────────────────────────────
  radius: 0.048,
  mass: 0.095,
  launchSpeed: 7.2,
  launchLift: 4.3,
  backSpeed: 4.2,
  backLift: 3.0,
  /** Contact impulse that pops it (N·s). Low: it is a balloon. */
  popImpulse: 0.055,
  /** Cannot pop for this long — it must clear the firer. */
  armTime: 0.09,
  splashRadius: 1.0,
  blindTime: 2.3,
  directBlindTime: 3.1,
  soakTime: 4.5,
  pushDeltaV: 1.5,

  fire(ctx) {
    const mgr = ctx.projectiles ?? projectilesOf(ctx.game);
    if (!mgr) return false;
    const e = mgr.spawn(WaterBalloon, ctx);
    if (!e) return false;
    emitSpawn(ctx.game, {
      weaponId: 'balloon', carId: ctx.car?.id ?? -1, position: e.pos, kind: 'balloon',
    });
    return true;
  },

  createEntity(mgr) {
    const game = mgr.game;
    const mesh = buildBalloonMesh(game, WaterBalloon.radius);
    const body = createSphereBody(WaterBalloon.radius, WaterBalloon.mass, {
      layer: Layer.PROJECTILE,
      friction: 0.55,
      restitution: 0.32,
      linearDamping: 0.06,
      angularDamping: 0.16,
      ccd: true,
      allowSleep: false,
      name: 'waterBalloon',
    });
    return { mesh, body, data: { popped: false, wobble: 0 } };
  },

  resetEntity(e, ctx, mgr) {
    const car = ctx.car;
    const d = e.data;
    const back = !!ctx.backwards;
    d.popped = false;
    d.wobble = Math.random() * 6.28;
    e.life = WaterBalloon.lifetime;

    muzzle(car, back ? -0.20 : 0.20, 0.075, e.pos);
    carForward(car, _fwd);
    if (back) _fwd.negate();
    if (ctx.direction && ctx.direction.lengthSq() > 1e-6) _fwd.copy(ctx.direction).normalize();
    carUp(car, _up);

    carVelocity(car, _v);
    const speed = back ? WaterBalloon.backSpeed : WaterBalloon.launchSpeed;
    const lift = back ? WaterBalloon.backLift : WaterBalloon.launchLift;
    _v.addScaledVector(_fwd, speed);
    _v.addScaledVector(_up, lift);

    const body = e.body;
    body.setTransform(e.pos, body.quaternion, false);
    body.velocity.copy(_v);
    body.angularVelocity.set(
      (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    body.lastImpulse = 0;
    body.contactCount = 0;                   // pooled body: clear stale contacts
    body.mask = Layer.ALL & ~Layer.CAR;      // do not clip the firer on the way out
    if (e.mesh) { e.mesh.visible = true; e.mesh.scale.setScalar(1); }
    void mgr;
  },

  update(dt, e, game) {
    const d = e.data;
    const body = e.body;
    if (!body) return false;
    e.pos.copy(body.position);

    // Arm: start colliding with cars once it has left the muzzle.
    if (e.age >= WaterBalloon.armTime && body.mask !== Layer.ALL) body.mask = Layer.ALL;

    if (d.popped) return false;
    if (e.age < WaterBalloon.armTime) { body.lastImpulse = 0; body.contactCount = 0; return true; }

    // Pop on any real contact.
    if (body.lastImpulse > WaterBalloon.popImpulse || body.contactCount > 0) {
      _n.set(0, 1, 0);
      burst(e, game, e.pos, _n, null);
      return false;
    }

    // Or when it simply runs out of energy.
    if (e.age > 0.7 && body.velocity.lengthSq() < 0.09) {
      _n.set(0, 1, 0);
      burst(e, game, e.pos, _n, null);
      return false;
    }

    // Fell out of the world.
    const bounds = game?.track?.environment?.bounds;
    if (bounds && !bounds.isEmpty() && body.position.y < bounds.min.y - 3) return false;

    d.wobble += dt * 13;
    return true;
  },

  sync(e, alpha) {
    if (!e.mesh || !e.body) return;
    e.body.applyToObject3D(e.mesh, alpha);
    // Squishy in flight.
    const w = e.data.wobble;
    e.mesh.scale.set(
      1 + Math.sin(w) * 0.10,
      1 + Math.sin(w + 2.1) * 0.10,
      1 + Math.sin(w + 4.2) * 0.10,
    );
  },

  onCarHit(e, car, payload, mgr) {
    if (e.data.popped || e.age < WaterBalloon.armTime) return;
    if (car.id === e.ownerId && e.age < 0.35) return;
    _n.copy(payload?.normal ?? _up);
    burst(e, mgr.game, payload?.worldPoint ?? e.pos, _n, car);
  },

  onDespawn(e, mgr) {
    if (e.mesh) e.mesh.visible = false;
    if (e.body) { e.body.velocity.set(0, 0, 0); e.body.angularVelocity.set(0, 0, 0); }
    emitExpire(mgr.game, {
      weaponId: 'balloon', carId: e.ownerId, position: e.pos, kind: 'balloon',
    });
  },
};

function burst(e, game, point, normal, directCar) {
  const d = e.data;
  if (d.popped) return;
  d.popped = true;
  e.alive = true;    // let the manager despawn us cleanly on the next tick
  if (e.mesh) e.mesh.visible = false;

  const mgr = projectilesOf(game);
  mgr?.splash(point, WaterBalloon.splashRadius * 0.62, 0.6, normal);

  const fx = effectsOf(game);
  const skip = [];
  if (directCar) {
    carPos(directCar, _p).sub(point);
    if (_p.lengthSq() < 1e-8) _p.set(0, 1, 0);
    _p.normalize();
    hitCar(game, directCar, {
      deltaV: WaterBalloon.pushDeltaV * 1.6,
      direction: _p,
      upBias: 0.3,
      spin: 2.2 * (directCar.id % 2 ? 1 : -1),
      effect: 'blinded',
      effectTime: WaterBalloon.directBlindTime,
      sourceId: e.ownerId,
      weaponId: 'balloon',
      worldPoint: point,
      shake: 0.55,
    });
    fx?.apply(directCar, 'soaked', WaterBalloon.soakTime, {
      sourceId: e.ownerId, weaponId: 'balloon',
    });
    skip.push(directCar.id);
  }

  blast(game, {
    position: point,
    radius: WaterBalloon.splashRadius,
    deltaV: WaterBalloon.pushDeltaV,
    upBias: 0.25,
    spin: 1.6,
    effect: 'blinded',
    effectTime: WaterBalloon.blindTime,
    sourceId: e.ownerId,
    weaponId: 'balloon',
    skipCarId: e.age < 0.6 ? e.ownerId : -1,
    skipIds: skip,
    propDeltaV: 1.6,
    falloffPower: 1.2,
    minFalloff: 0.35,
    shake: 0.3,
  });

  // Soak everyone the splash reached, on top of the blinding.
  if (fx) {
    const cars = game?.cars ?? [];
    const r2 = WaterBalloon.splashRadius * WaterBalloon.splashRadius;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c || skip.indexOf(c.id) >= 0) continue;
      if (c.id === e.ownerId && e.age < 0.6) continue;
      carPos(c, _p);
      if (_p.distanceToSquared(point) > r2) continue;
      fx.apply(c, 'soaked', WaterBalloon.soakTime * 0.7, {
        sourceId: e.ownerId, weaponId: 'balloon',
      });
    }
  }

  shake(game, 0.22, 0.2);
  void clamp01;
}

export default WaterBalloon;
