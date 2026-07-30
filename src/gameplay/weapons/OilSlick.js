/**
 * Oil Slick — drop a persistent slippery patch behind you.
 *
 * The decal is tagged with the canonical **surface id 15 (oil_slick, grip 0.10)**
 * and published through `game.pickups.hazardSurfaceAt(point)` /
 * `car.hazardSurfaceId`, so the vehicle sim can treat the ground under a wheel
 * as oil without the collision mesh having to be rebuilt (the physics static
 * API is append-only, and a slick has to be able to expire). On top of that the
 * slick applies the `oiled` status effect, which is what actually spins the
 * victim out — grip collapses and the car snaps sideways.
 *
 * Deliberately a *leader's* weapon: dropping it behind you is the best defence
 * in the game, and the AI will happily use it that way.
 */

import * as THREE from 'three';
import { clamp01 } from '../../core/MathUtils.js';
import { buildOilGeometry, oilMaterial } from '../VisualKit.js';
import {
  carPos, carForward, carUp, muzzle, groundBelow, effectsOf, projectilesOf,
  emitHit, emitSpawn, emitExpire, ramp, fieldT,
} from './Common.js';

const _p = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _YP = new THREE.Vector3(0, 1, 0);

/** Max concurrent slicks in the world (oldest is recycled). */
const MAX_SLICKS = 9;

export const OilSlick = {
  id: 'oil',
  name: 'Oil Slick',
  icon: 'oil',
  slots: 1,
  uses: 1,
  aimMode: 'drop',
  entityKind: 'oil',
  lifetime: 26.0,
  blurb: 'Drops a slippery patch behind you.',

  // ── balance: strongly leader-weighted (the best defensive item) ────────
  weight(place, carCount) { return ramp(place, carCount, 0.92, 0.42); },
  usesFor(place, carCount) { return fieldT(place, carCount) < 0.25 ? 2 : 1; },

  // ── tuning ────────────────────────────────────────────────────────────
  radius: 0.40,
  /** Vertical tolerance of the hazard zone, metres. */
  height: 0.26,
  /** Seconds of `oiled` applied on contact. */
  effectTime: 2.3,
  /** Per-car re-trigger cooldown so one slick is not a machine gun. */
  retrigger: 1.7,
  /** Owner is immune while driving off it. */
  ownerGrace: 0.9,
  /** Below this speed the slick just makes you greasy, it does not spin you. */
  spinSpeed: 1.6,
  fadeIn: 0.28,
  fadeOut: 2.6,
  /** Canonical surface id published to the vehicle sim. */
  surfaceId: 15,

  fire(ctx) {
    const mgr = ctx.projectiles ?? projectilesOf(ctx.game);
    if (!mgr) return false;
    // Recycle the oldest slick rather than flooding the track.
    if (mgr.countOfKind('oil') >= MAX_SLICKS) {
      const old = mgr.oldestOfKind('oil');
      if (old) mgr.despawn(old);
    }
    const e = mgr.spawn(OilSlick, ctx);
    if (!e) return false;
    emitSpawn(ctx.game, {
      weaponId: 'oil', carId: ctx.car?.id ?? -1, position: e.pos, kind: 'slick',
    });
    return true;
  },

  createEntity(mgr) {
    const game = mgr.game;
    const seed = 1 + Math.floor(Math.random() * 9999);
    const geo = buildOilGeometry(seed, OilSlick.radius, 24);
    const mat = oilMaterial(game).clone();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -4;
    mat.polygonOffsetUnits = -4;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'oilSlick';
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    return {
      mesh,
      data: {
        material: mat,
        geometry: geo,
        seed,
        /** Published to the hazard query. */
        hazardSurfaceId: OilSlick.surfaceId,
        hazardRadius: OilSlick.radius,
        hazardHeight: OilSlick.height,
        planeY: 0,
        cool: new Float32Array(16),
        opacity: mat.opacity,
      },
    };
  },

  resetEntity(e, ctx, mgr) {
    const car = ctx.car;
    const d = e.data;
    // Drop it just behind the rear axle, on the ground.
    muzzle(car, -0.19, 0.02, _p);
    const hit = groundBelow(mgr.game, _p, 0.9);
    if (hit) {
      e.pos.copy(hit.point);
      _up.copy(hit.normal);
    } else {
      e.pos.copy(_p);
      carUp(car, _up);
    }
    e.pos.addScaledVector(_up, 0.006);
    d.planeY = e.pos.y;
    d.cool.fill(0);
    d.hazardRadius = OilSlick.radius;
    e.life = OilSlick.lifetime;

    if (e.mesh) {
      e.mesh.position.copy(e.pos);
      _q.setFromUnitVectors(_YP, _up);
      e.mesh.quaternion.copy(_q);
      // Random yaw so repeated slicks do not look stamped.
      e.mesh.rotateY(Math.random() * Math.PI * 2);
      e.mesh.scale.setScalar(0.05);
      e.mesh.visible = true;
      d.material.opacity = 0;
    }
  },

  update(dt, e, game) {
    const d = e.data;
    const age = e.age;
    const remain = e.life - age;

    // ── grow / fade ──
    const grow = clamp01(age / OilSlick.fadeIn);
    const out = clamp01(remain / OilSlick.fadeOut);
    const s = 0.35 + 0.65 * (1 - Math.pow(1 - grow, 3));
    d.hazardRadius = OilSlick.radius * s;
    if (e.mesh) {
      e.mesh.scale.setScalar(s);
      d.material.opacity = d.opacity * grow * out;
    }

    // ── contact ──
    const fx = effectsOf(game);
    const cars = game?.cars ?? [];
    const r2 = d.hazardRadius * d.hazardRadius;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) continue;
      const slot = car.id & 15;
      if (d.cool[slot] > 0) continue;          // ticked down once, below
      if (car.id === e.ownerId && age < OilSlick.ownerGrace) continue;
      carPos(car, _p);
      const dy = _p.y - d.planeY;
      if (dy < -0.10 || dy > d.hazardHeight) continue;
      const dx = _p.x - e.pos.x, dz = _p.z - e.pos.z;
      if (dx * dx + dz * dz > r2) continue;

      d.cool[slot] = OilSlick.retrigger;
      const speed = Math.abs(car.speed ?? 0);
      const strength = speed > OilSlick.spinSpeed ? clamp01(speed / 6) : 0;
      if (fx) {
        fx.oil(car, OilSlick.effectTime, {
          sourceId: e.ownerId, weaponId: 'oil', spin: strength,
        });
      }
      emitHit(game, {
        carId: car.id, sourceId: e.ownerId, weaponId: 'oil',
        worldPoint: e.pos, impulse: 0.4 + strength,
      });
      if (car.isPlayer) {
        game?.bus?.emit('camera:shake', { amount: 0.28 * (0.4 + strength), duration: 0.35 });
      }
    }

    // Tick down any remaining cooldowns for cars that left the patch.
    for (let i = 0; i < d.cool.length; i++) if (d.cool[i] > 0) d.cool[i] -= dt;

    return true;
  },

  sync(e) {
    // Static decal — placed once in resetEntity, nothing to interpolate.
    void e;
  },

  onDespawn(e, mgr) {
    if (e.mesh) e.mesh.visible = false;
    emitExpire(mgr.game, {
      weaponId: 'oil', carId: e.ownerId, position: e.pos, kind: 'slick',
    });
  },

  disposeEntity(e) {
    e.data.material?.dispose?.();
    e.data.geometry?.dispose?.();
  },
};

export default OilSlick;
