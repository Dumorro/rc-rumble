/**
 * Ball Bearing — a heavy chromed sphere, fired forward or dropped behind.
 *
 * Entirely physical: a 0.85 kg bearing against a 1.6 kg car is a proper shunt,
 * and the sphere then keeps rolling, bouncing off walls and ruining somebody
 * else's corner thirty seconds later. Comes in packs of up to three, and the
 * player can dump one behind by holding brake / look-back while firing.
 */

import * as THREE from 'three';
import { createSphereBody, Layer } from '../../physics/index.js';
import { clamp01 } from '../../core/MathUtils.js';
import { buildBearingMesh } from '../VisualKit.js';
import {
  carPos, carForward, carUp, carVelocity, muzzle, hitCar,
  projectilesOf, shake, emitSpawn, emitExpire, ramp, fieldT,
} from './Common.js';

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Max bearings rolling around at once before the oldest is retired. */
const MAX_BEARINGS = 12;

export const BallBearing = {
  id: 'bearing',
  name: 'Ball Bearing',
  icon: 'bearing',
  slots: 1,
  uses: 2,
  aimMode: 'forward',
  dual: true,
  entityKind: 'bearing',
  lifetime: 16.0,
  blurb: 'Heavy sphere. Fire it or drop it.',

  // ── balance: an all-rounder, very slightly leader-weighted ─────────────
  weight(place, carCount) { return ramp(place, carCount, 0.80, 0.62); },
  usesFor(place, carCount) {
    const t = fieldT(place, carCount);
    return t > 0.62 ? 3 : t > 0.28 ? 2 : 1;
  },

  // ── tuning ────────────────────────────────────────────────────────────
  radius: 0.042,
  mass: 0.85,
  launchSpeed: 9.4,
  backSpeed: 1.2,
  /** Impulse above which we add a scripted kick on top of the real collision. */
  hitImpulse: 0.10,
  armTime: 0.08,
  /** Extra knock on a car hit, m/s (the physics does most of the work). */
  bonusDeltaV: 1.9,
  bonusSpin: 3.4,
  /** Per-car cooldown so a bearing resting against a car does not machine-gun. */
  hitCooldown: 0.55,

  fire(ctx) {
    const mgr = ctx.projectiles ?? projectilesOf(ctx.game);
    if (!mgr) return false;
    if (mgr.countOfKind('bearing') >= MAX_BEARINGS) {
      const old = mgr.oldestOfKind('bearing');
      if (old) mgr.despawn(old);
    }
    const e = mgr.spawn(BallBearing, ctx);
    if (!e) return false;
    emitSpawn(ctx.game, {
      weaponId: 'bearing', carId: ctx.car?.id ?? -1, position: e.pos, kind: 'bearing',
    });
    shake(ctx.game, ctx.car?.isPlayer ? 0.12 : 0.04, 0.12);
    return true;
  },

  createEntity(mgr) {
    const mesh = buildBearingMesh(mgr.game, BallBearing.radius);
    const body = createSphereBody(BallBearing.radius, BallBearing.mass, {
      layer: Layer.PROJECTILE,
      friction: 0.30,
      restitution: 0.44,
      rollingFriction: 0.004,
      linearDamping: 0.012,
      angularDamping: 0.03,
      ccd: true,
      allowSleep: true,
      name: 'ballBearing',
    });
    return { mesh, body, data: { cool: new Float32Array(16), fired: false } };
  },

  resetEntity(e, ctx, mgr) {
    const car = ctx.car;
    const d = e.data;
    const back = !!ctx.backwards;
    d.cool.fill(0);
    d.fired = !back;
    e.life = BallBearing.lifetime;

    muzzle(car, back ? -0.21 : 0.21, back ? 0.035 : 0.030, e.pos);
    carForward(car, _fwd);
    if (back) _fwd.negate();
    if (ctx.direction && ctx.direction.lengthSq() > 1e-6) _fwd.copy(ctx.direction).normalize();
    carUp(car, _up);

    carVelocity(car, _v);
    if (back) {
      // Dropped: keep a fraction of the car's speed so it settles behind you.
      _v.multiplyScalar(0.35);
      _v.addScaledVector(_fwd, BallBearing.backSpeed);
      _v.addScaledVector(_up, 0.4);
    } else {
      _v.addScaledVector(_fwd, BallBearing.launchSpeed);
      _v.addScaledVector(_up, 0.55);
    }

    const body = e.body;
    body.setTransform(e.pos, body.quaternion, false);
    body.velocity.copy(_v);
    body.angularVelocity.set(
      (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    body.lastImpulse = 0;
    body.contactCount = 0;
    body.mask = Layer.ALL & ~Layer.CAR;
    body.wake();
    if (e.mesh) e.mesh.visible = true;
    void mgr;
  },

  update(dt, e, game) {
    const d = e.data;
    const body = e.body;
    if (!body) return false;
    e.pos.copy(body.position);

    if (e.age >= BallBearing.armTime && body.mask !== Layer.ALL) body.mask = Layer.ALL;
    for (let i = 0; i < d.cool.length; i++) if (d.cool[i] > 0) d.cool[i] -= dt;

    // Fell out of the world.
    const bounds = game?.track?.environment?.bounds;
    if (bounds && !bounds.isEmpty() && body.position.y < bounds.min.y - 3) return false;

    // Sparks when it clatters into something hard.
    if (body.lastImpulse > 0.9) {
      const mgr = projectilesOf(game);
      mgr?.tick(body.position, null, 0xfff4d0);
      body.lastImpulse = 0;
    }
    return true;
  },

  onCarHit(e, car, payload, mgr) {
    const d = e.data;
    if (e.age < BallBearing.armTime) return;
    if (car.id === e.ownerId && e.age < 0.5) return;
    const slot = car.id & 15;
    if (d.cool[slot] > 0) return;
    const j = payload?.impulse ?? 0;
    if (j < BallBearing.hitImpulse) return;
    d.cool[slot] = BallBearing.hitCooldown;

    const game = mgr.game;
    // Direction: from the bearing into the car, so it shunts the way it flew.
    carPos(car, _p).sub(e.pos);
    if (_p.lengthSq() < 1e-8) _p.copy(payload?.normal ?? _up).negate();
    _p.normalize();

    // Scale the bonus with how hard the real collision was, capped so a slow
    // roll into a stationary car does almost nothing.
    const scale = clamp01(j / 1.6);
    hitCar(game, car, {
      deltaV: BallBearing.bonusDeltaV * (0.35 + 0.65 * scale),
      direction: _p,
      upBias: 0.28,
      spin: BallBearing.bonusSpin * scale * (car.id % 2 ? 1 : -1),
      roll: 1.6 * scale,
      sourceId: e.ownerId,
      weaponId: 'bearing',
      worldPoint: payload?.worldPoint ?? e.pos,
      shake: 0.6 * scale + 0.2,
    });
    mgr.tick(payload?.worldPoint ?? e.pos, payload?.normal ?? null, 0xffe8b0);
  },

  onDespawn(e, mgr) {
    if (e.mesh) e.mesh.visible = false;
    if (e.body) { e.body.velocity.set(0, 0, 0); e.body.angularVelocity.set(0, 0, 0); }
    emitExpire(mgr.game, {
      weaponId: 'bearing', carId: e.ownerId, position: e.pos, kind: 'bearing',
    });
  },
};

export default BallBearing;
