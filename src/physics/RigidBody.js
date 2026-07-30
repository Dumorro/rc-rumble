/**
 * RC RUMBLE — rigid body.
 *
 * Shape contract: see ARCHITECTURE.md → `RigidBody`.
 *
 *   position, quaternion, velocity, angularVelocity
 *   mass, invMass, inertiaTensorLocal (Vector3 diagonal), invInertiaWorld (Matrix3)
 *   force, torque
 *   prevPosition, prevQuaternion            ← render interpolation snapshots
 *   collider { type:'hull'|'box'|'sphere'|'capsule', ... }
 *   applyForce(f, worldPoint), applyImpulse(j, worldPoint), applyTorque(t)
 *   pointVelocity(worldPoint, out)
 *
 * Conventions
 * -----------
 * • The body origin IS the centre of mass. Colliders may be offset from it.
 * • `inertiaTensorLocal` is a diagonal in body space; `invInertiaWorld` is the
 *   full world-space Matrix3, recomputed once per step from the diagonal.
 * • Y-up, metres, kilograms, radians, seconds.
 * • Nothing here allocates after construction. All maths uses module scratch.
 */

import * as THREE from 'three';
import {
  ShapeType, colliderAABB, colliderInertia, quatToMatrix3,
  makeBox, makeSphere, makeCapsule,
} from './Shapes.js';

// ───────────────────────────────────────────────────────── scratch
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _rot = new THREE.Matrix3();

let _nextId = 1;

/** Collision layers. A pair collides when (a.layer & b.mask) && (b.layer & a.mask). */
export const Layer = Object.freeze({
  NONE: 0,
  DEFAULT: 1 << 0,
  TRACK: 1 << 1,
  CAR: 1 << 2,
  PROP: 1 << 3,
  PROJECTILE: 1 << 4,
  PICKUP: 1 << 5,
  TRIGGER: 1 << 6,
  DEBRIS: 1 << 7,
  ALL: 0x7fffffff,
});

/** Body kinds. */
export const BodyType = Object.freeze({
  DYNAMIC: 'dynamic',
  KINEMATIC: 'kinematic',
  STATIC: 'static',
});

export class RigidBody {
  /**
   * @param {object} [opts]
   * @param {object} [opts.collider]   from Shapes.js — defaults to a 10 cm box
   * @param {number} [opts.mass]       kg (0 or `static:true` ⇒ immovable)
   * @param {THREE.Vector3|number[]} [opts.position]
   * @param {THREE.Quaternion} [opts.quaternion]
   * @param {boolean} [opts.static]
   * @param {boolean} [opts.kinematic]
   * @param {number}  [opts.layer]
   * @param {number}  [opts.mask]
   * @param {number}  [opts.friction]
   * @param {number}  [opts.restitution]
   * @param {number}  [opts.linearDamping]
   * @param {number}  [opts.angularDamping]
   * @param {number}  [opts.gravityScale]
   * @param {boolean} [opts.allowSleep]
   * @param {boolean} [opts.ccd]
   * @param {*}       [opts.userData]   back-reference (Car, Prop, Projectile…)
   */
  constructor(opts = {}) {
    this.id = _nextId++;
    /** Free-form back-reference so a Car/Prop can find itself from a contact. */
    this.userData = opts.userData ?? null;
    /** Optional human-readable tag, handy in the debug overlay. */
    this.name = opts.name ?? '';

    // ── transform ─────────────────────────────────────────────────────
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    if (opts.position) {
      if (Array.isArray(opts.position)) this.position.fromArray(opts.position);
      else this.position.copy(opts.position);
    }
    if (opts.quaternion) this.quaternion.copy(opts.quaternion);

    /** Snapshots taken at the top of every fixedUpdate — for render lerp. */
    this.prevPosition = this.position.clone();
    this.prevQuaternion = this.quaternion.clone();

    // ── motion ────────────────────────────────────────────────────────
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    /** Split-impulse pseudo velocities (position solver only). */
    this.pseudoVelocity = new THREE.Vector3();
    this.pseudoAngularVelocity = new THREE.Vector3();

    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();

    /** Per-axis multipliers — lock an axis by zeroing it. */
    this.linearFactor = new THREE.Vector3(1, 1, 1);
    this.angularFactor = new THREE.Vector3(1, 1, 1);

    // ── mass ──────────────────────────────────────────────────────────
    this.mass = 0;
    this.invMass = 0;
    this.inertiaTensorLocal = new THREE.Vector3(1, 1, 1);
    this.invInertiaLocal = new THREE.Vector3();
    this.invInertiaWorld = new THREE.Matrix3();

    // ── flags ─────────────────────────────────────────────────────────
    this.static = !!opts.static;
    this.kinematic = !!opts.kinematic;
    this.enabled = opts.enabled !== false;
    /** When false the body still integrates but generates no contacts. */
    this.collisionEnabled = opts.collisionEnabled !== false;
    /** Report contacts to the bus / callbacks but do not solve them. */
    this.isTrigger = !!opts.isTrigger;
    /** Continuous collision (sphere-cast the motion against static geometry). */
    this.ccd = !!opts.ccd;

    this.layer = opts.layer ?? Layer.DEFAULT;
    this.mask = opts.mask ?? Layer.ALL;

    // ── material ──────────────────────────────────────────────────────
    this.friction = opts.friction ?? 0.8;
    this.restitution = opts.restitution ?? 0.15;
    this.rollingFriction = opts.rollingFriction ?? 0.0;
    this.linearDamping = opts.linearDamping ?? 0.02;
    this.angularDamping = opts.angularDamping ?? 0.08;
    this.gravityScale = opts.gravityScale ?? 1;
    this.maxLinearSpeed = opts.maxLinearSpeed ?? 200;
    /**
     * Runaway-spin safety net, in rad/s — NOT a gameplay limit.
     *
     * It has to be set for 1:10 RC scale. Anything that rolls does so at
     * ω = v/r, and r here is tiny: a 33 mm wheel or ball at the 9 m/s top speed
     * needs 273 rad/s. A metre-scale default of 60 rad/s silently clamps that
     * to 2 m/s — and because rolling contact locks v to ω·r, the clamp drags the
     * LINEAR speed down with it. A ball rolling down a ramp just stops
     * accelerating partway, which reads as invisible treacle rather than as a
     * clamp. 400 rad/s leaves headroom for wheelspin and impact-flung debris
     * while still catching a genuine numerical explosion.
     */
    this.maxAngularSpeed = opts.maxAngularSpeed ?? 400;

    // ── sleeping ──────────────────────────────────────────────────────
    this.allowSleep = opts.allowSleep !== false;
    this.sleeping = false;
    this.sleepTimer = 0;
    /** Set by PhysicsWorld when a lively neighbour touches this body. */
    this._keepAwake = false;
    /**
     * Was this body below the sleep thresholds at the END of the last step?
     * Measured post-solve, so it is not polluted by the gravity Δv that the
     * contact solver is about to cancel. Drives both the sleep timer and the
     * "should I wake my sleeping neighbour" decision.
     */
    this._sleepy = false;
    /** Set in integrateForces — true when force/torque was accumulated. */
    this._wasForced = false;

    // ── broadphase / bookkeeping ──────────────────────────────────────
    this.aabbMin = new THREE.Vector3();
    this.aabbMax = new THREE.Vector3();
    this.boundingRadius = 0.05;
    this.world = null;
    this.index = -1;                  // slot in PhysicsWorld.bodies
    this.contactCount = 0;            // contacts touching this body this step
    /** Largest normal impulse this body received last step (for FX/audio). */
    this.lastImpulse = 0;
    this.islandAwake = false;

    // ── shape ─────────────────────────────────────────────────────────
    this.collider = null;
    /** World-space cache of the collider, rebuilt once per step. */
    this.cache = null;
    this._cacheStamp = -1;

    this.setCollider(opts.collider ?? makeBox(0.05, 0.05, 0.05));
    this.setMass(opts.mass ?? (this.static ? 0 : 1));
    this.updateInertiaWorld();
    this.updateAABB();
  }

  // ═════════════════════════════════════════════════════════ type flags

  get isStatic() { return this.static || (this.invMass === 0 && !this.kinematic); }
  get isDynamic() { return !this.static && !this.kinematic; }
  get type() {
    return this.static ? BodyType.STATIC : this.kinematic ? BodyType.KINEMATIC : BodyType.DYNAMIC;
  }

  /** Has finite mass and is not static/kinematic — i.e. gravity applies. */
  get isDynamicMass() { return !this.static && !this.kinematic && this.invMass > 0; }

  /**
   * True when the solver may move this body THIS STEP. A sleeping body is an
   * immovable anchor: impulses aimed at it are not silently swallowed, they are
   * simply not applied (and `applyImpulse` wakes it first, so gameplay code
   * still works).
   */
  get isMovable() { return this.isDynamicMass && !this.sleeping; }

  // ═════════════════════════════════════════════════════════ mass / shape

  /** @param {object} collider from Shapes.js */
  setCollider(collider) {
    this.collider = collider;
    this.boundingRadius = collider?.boundingRadius ?? 0.05;
    this.cache = makeShapeCache(collider);
    this._cacheStamp = -1;
    if (this.mass > 0) this.setMass(this.mass);
    return this;
  }

  /** Recompute mass + inertia from the collider. */
  setMass(mass) {
    if (this.static || mass <= 0) {
      this.mass = 0;
      this.invMass = 0;
      this.inertiaTensorLocal.set(0, 0, 0);
      this.invInertiaLocal.set(0, 0, 0);
      this.invInertiaWorld.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
      return this;
    }
    this.mass = mass;
    this.invMass = 1 / mass;
    colliderInertia(this.collider, mass, this.inertiaTensorLocal);
    this._refreshInvInertiaLocal();
    return this;
  }

  /** Override the local inertia diagonal (e.g. a car wants a fatter yaw axis). */
  setInertiaLocal(x, y, z) {
    if (x?.isVector3) this.inertiaTensorLocal.copy(x);
    else this.inertiaTensorLocal.set(x, y, z);
    this._refreshInvInertiaLocal();
    return this;
  }

  /** Scale the inertia diagonal — the cheapest handling knob there is. */
  scaleInertia(sx, sy = sx, sz = sx) {
    this.inertiaTensorLocal.x *= sx;
    this.inertiaTensorLocal.y *= sy;
    this.inertiaTensorLocal.z *= sz;
    this._refreshInvInertiaLocal();
    return this;
  }

  _refreshInvInertiaLocal() {
    const i = this.inertiaTensorLocal;
    if (this.kinematic || this.static) { this.invInertiaLocal.set(0, 0, 0); return; }
    this.invInertiaLocal.set(
      i.x > 1e-12 ? 1 / i.x : 0,
      i.y > 1e-12 ? 1 / i.y : 0,
      i.z > 1e-12 ? 1 / i.z : 0,
    );
  }

  /** Freeze rotation entirely (projectiles, some pickups). */
  lockRotation(v = true) {
    this.angularFactor.set(v ? 0 : 1, v ? 0 : 1, v ? 0 : 1);
    return this;
  }

  // ═════════════════════════════════════════════════════════ inertia (world)

  /**
   * invInertiaWorld = R · diag(invI) · Rᵀ.
   * Rebuilt every step from the local diagonal so it never drifts.
   */
  updateInertiaWorld() {
    const e = this.invInertiaWorld.elements;
    if (!this.isDynamicMass) {
      e[0] = e[1] = e[2] = e[3] = e[4] = e[5] = e[6] = e[7] = e[8] = 0;
      return this;
    }
    const r = quatToMatrix3(this.quaternion, _rot).elements;
    const a = this.invInertiaLocal.x * this.angularFactor.x;
    const b = this.invInertiaLocal.y * this.angularFactor.y;
    const c = this.invInertiaLocal.z * this.angularFactor.z;

    // columns of R
    const c0x = r[0], c0y = r[1], c0z = r[2];
    const c1x = r[3], c1y = r[4], c1z = r[5];
    const c2x = r[6], c2y = r[7], c2z = r[8];

    const m00 = a * c0x * c0x + b * c1x * c1x + c * c2x * c2x;
    const m01 = a * c0x * c0y + b * c1x * c1y + c * c2x * c2y;
    const m02 = a * c0x * c0z + b * c1x * c1z + c * c2x * c2z;
    const m11 = a * c0y * c0y + b * c1y * c1y + c * c2y * c2y;
    const m12 = a * c0y * c0z + b * c1y * c1z + c * c2y * c2z;
    const m22 = a * c0z * c0z + b * c1z * c1z + c * c2z * c2z;

    // symmetric, column-major
    e[0] = m00; e[1] = m01; e[2] = m02;
    e[3] = m01; e[4] = m11; e[5] = m12;
    e[6] = m02; e[7] = m12; e[8] = m22;
    return this;
  }

  /** out = invInertiaWorld · v (allocation free). */
  applyInvInertia(vx, vy, vz, out) {
    const e = this.invInertiaWorld.elements;
    return out.set(
      e[0] * vx + e[3] * vy + e[6] * vz,
      e[1] * vx + e[4] * vy + e[7] * vz,
      e[2] * vx + e[5] * vy + e[8] * vz,
    );
  }

  // ═════════════════════════════════════════════════════════ forces

  /**
   * Accumulate a world-space force. If `worldPoint` is given the resulting
   * torque about the centre of mass is accumulated too.
   * @param {THREE.Vector3} f
   * @param {THREE.Vector3} [worldPoint]
   */
  applyForce(f, worldPoint) {
    if (!this.isDynamicMass) return this;
    this.wake();
    this.force.x += f.x; this.force.y += f.y; this.force.z += f.z;
    if (worldPoint) {
      const rx = worldPoint.x - this.position.x;
      const ry = worldPoint.y - this.position.y;
      const rz = worldPoint.z - this.position.z;
      this.torque.x += ry * f.z - rz * f.y;
      this.torque.y += rz * f.x - rx * f.z;
      this.torque.z += rx * f.y - ry * f.x;
    }
    return this;
  }

  /** Force expressed in body space, applied at a body-space point. */
  applyForceLocal(fLocal, localPoint) {
    _v.copy(fLocal).applyQuaternion(this.quaternion);
    if (localPoint) {
      _v2.copy(localPoint).applyQuaternion(this.quaternion).add(this.position);
      return this.applyForce(_v, _v2);
    }
    return this.applyForce(_v);
  }

  /** Pure world-space torque (N·m). */
  applyTorque(t) {
    if (!this.isDynamicMass) return this;
    this.wake();
    this.torque.x += t.x; this.torque.y += t.y; this.torque.z += t.z;
    return this;
  }

  /**
   * Instantaneous world-space impulse (N·s). `worldPoint` optional.
   * @param {THREE.Vector3} j
   * @param {THREE.Vector3} [worldPoint]
   */
  applyImpulse(j, worldPoint) {
    if (!this.isDynamicMass) return this;
    this.wake();
    const im = this.invMass;
    this.velocity.x += j.x * im * this.linearFactor.x;
    this.velocity.y += j.y * im * this.linearFactor.y;
    this.velocity.z += j.z * im * this.linearFactor.z;
    if (worldPoint) {
      const rx = worldPoint.x - this.position.x;
      const ry = worldPoint.y - this.position.y;
      const rz = worldPoint.z - this.position.z;
      const tx = ry * j.z - rz * j.y;
      const ty = rz * j.x - rx * j.z;
      const tz = rx * j.y - ry * j.x;
      this.applyInvInertia(tx, ty, tz, _v);
      this.angularVelocity.add(_v);
    }
    return this;
  }

  /** Angular impulse (N·m·s). */
  applyTorqueImpulse(t) {
    if (!this.isDynamicMass) return this;
    this.wake();
    this.applyInvInertia(t.x, t.y, t.z, _v);
    this.angularVelocity.add(_v);
    return this;
  }

  clearForces() {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    return this;
  }

  // ═════════════════════════════════════════════════════════ kinematics

  /**
   * World velocity of a point rigidly attached to this body.
   * @param {THREE.Vector3} worldPoint
   * @param {THREE.Vector3} out
   */
  pointVelocity(worldPoint, out) {
    const rx = worldPoint.x - this.position.x;
    const ry = worldPoint.y - this.position.y;
    const rz = worldPoint.z - this.position.z;
    const w = this.angularVelocity;
    return out.set(
      this.velocity.x + w.y * rz - w.z * ry,
      this.velocity.y + w.z * rx - w.x * rz,
      this.velocity.z + w.x * ry - w.y * rx,
    );
  }

  /** Same, but the point is given in body space. */
  pointVelocityLocal(localPoint, out) {
    this.localToWorld(localPoint, _v2);
    return this.pointVelocity(_v2, out);
  }

  localToWorld(v, out) { return out.copy(v).applyQuaternion(this.quaternion).add(this.position); }
  worldToLocal(v, out) { return out.copy(v).sub(this.position).applyQuaternion(_q.copy(this.quaternion).invert()); }
  localToWorldDir(v, out) { return out.copy(v).applyQuaternion(this.quaternion); }
  worldToLocalDir(v, out) { return out.copy(v).applyQuaternion(_q.copy(this.quaternion).invert()); }

  /** Body forward (-Z), right (+X), up (+Y) in world space. */
  getForward(out) { return out.set(0, 0, -1).applyQuaternion(this.quaternion); }
  getRight(out) { return out.set(1, 0, 0).applyQuaternion(this.quaternion); }
  getUp(out) { return out.set(0, 1, 0).applyQuaternion(this.quaternion); }

  /** Kinetic energy — used by sleeping heuristics and impact scaling. */
  kineticEnergy() {
    const v = this.velocity, w = this.angularVelocity, i = this.inertiaTensorLocal;
    // rotational part approximated with the local diagonal (good enough)
    return 0.5 * this.mass * v.lengthSq()
      + 0.5 * (i.x * w.x * w.x + i.y * w.y * w.y + i.z * w.z * w.z);
  }

  // ═════════════════════════════════════════════════════════ transform

  /**
   * Teleport. Clears the interpolation history so the mesh does not smear
   * across the map, and wakes the body.
   */
  setTransform(position, quaternion, keepVelocity = false) {
    if (position) this.position.copy(position);
    if (quaternion) this.quaternion.copy(quaternion).normalize();
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
    if (!keepVelocity) { this.velocity.set(0, 0, 0); this.angularVelocity.set(0, 0, 0); }
    this.pseudoVelocity.set(0, 0, 0);
    this.pseudoAngularVelocity.set(0, 0, 0);
    this._cacheStamp = -1;
    this.updateInertiaWorld();
    this.updateAABB();
    this.wake();
    this.world?.wakeArea?.(this.aabbMin, this.aabbMax);
    return this;
  }

  /** Store the render-interpolation snapshot. Called by PhysicsWorld. */
  snapshot() {
    this.prevPosition.copy(this.position);
    this.prevQuaternion.copy(this.quaternion);
    return this;
  }

  /**
   * Interpolated transform for rendering.
   * @param {number} alpha 0 = prev, 1 = current
   */
  getInterpolatedPosition(alpha, out) {
    return out.copy(this.prevPosition).lerp(this.position, alpha);
  }
  getInterpolatedQuaternion(alpha, out) {
    return out.copy(this.prevQuaternion).slerp(this.quaternion, alpha);
  }
  /** Write the interpolated transform straight into an Object3D. */
  applyToObject3D(obj, alpha) {
    obj.position.copy(this.prevPosition).lerp(this.position, alpha);
    obj.quaternion.copy(this.prevQuaternion).slerp(this.quaternion, alpha);
    return obj;
  }

  // ═════════════════════════════════════════════════════════ integration

  /** v += (F/m + g) dt ; ω += I⁻¹ τ dt ; then damping. */
  integrateForces(dt, gravityY) {
    /** Did gameplay push this body this step? Gates resting stabilisation. */
    this._wasForced = this.force.lengthSq() > 1e-14 || this.torque.lengthSq() > 1e-14;
    if (!this.isMovable) { this.clearForces(); return; }
    const im = this.invMass;
    const lf = this.linearFactor;
    this.velocity.x += (this.force.x * im) * lf.x * dt;
    this.velocity.y += (this.force.y * im + gravityY * this.gravityScale) * lf.y * dt;
    this.velocity.z += (this.force.z * im) * lf.z * dt;
    // gravity on locked axes should still be suppressed; X/Z gravity is zero.

    this.applyInvInertia(this.torque.x, this.torque.y, this.torque.z, _v);
    this.angularVelocity.x += _v.x * dt;
    this.angularVelocity.y += _v.y * dt;
    this.angularVelocity.z += _v.z * dt;

    // Implicit (unconditionally stable) damping.
    const ld = 1 / (1 + this.linearDamping * dt);
    const ad = 1 / (1 + this.angularDamping * dt);
    this.velocity.multiplyScalar(ld);
    this.angularVelocity.multiplyScalar(ad);

    this.clampVelocities();
    this.clearForces();
  }

  clampVelocities() {
    const vl = this.velocity.lengthSq();
    const maxV = this.maxLinearSpeed;
    if (vl > maxV * maxV) this.velocity.multiplyScalar(maxV / Math.sqrt(vl));
    const wl = this.angularVelocity.lengthSq();
    const maxW = this.maxAngularSpeed;
    if (wl > maxW * maxW) this.angularVelocity.multiplyScalar(maxW / Math.sqrt(wl));
  }

  /** x += (v + pseudoV) dt ; q += ½ (ω + pseudoω) q dt. */
  integrateVelocity(dt) {
    if (this.static) return;
    if (this.sleeping) { this.pseudoVelocity.set(0, 0, 0); this.pseudoAngularVelocity.set(0, 0, 0); return; }

    this.position.x += (this.velocity.x + this.pseudoVelocity.x) * dt;
    this.position.y += (this.velocity.y + this.pseudoVelocity.y) * dt;
    this.position.z += (this.velocity.z + this.pseudoVelocity.z) * dt;

    const wx = this.angularVelocity.x + this.pseudoAngularVelocity.x;
    const wy = this.angularVelocity.y + this.pseudoAngularVelocity.y;
    const wz = this.angularVelocity.z + this.pseudoAngularVelocity.z;
    if (wx !== 0 || wy !== 0 || wz !== 0) {
      const q = this.quaternion;
      const hx = wx * dt * 0.5, hy = wy * dt * 0.5, hz = wz * dt * 0.5;
      const nx = hx * q.w + hy * q.z - hz * q.y;
      const ny = hy * q.w + hz * q.x - hx * q.z;
      const nz = hz * q.w + hx * q.y - hy * q.x;
      const nw = -(hx * q.x + hy * q.y + hz * q.z);
      q.set(q.x + nx, q.y + ny, q.z + nz, q.w + nw).normalize();
    }

    this.pseudoVelocity.set(0, 0, 0);
    this.pseudoAngularVelocity.set(0, 0, 0);
    this._cacheStamp = -1;
  }

  // ═════════════════════════════════════════════════════════ sleeping

  wake(resetTimer = true) {
    if (this.sleeping) {
      this.sleeping = false;
      this.sleepTimer = 0;
      this._sleepy = false;
      this.updateInertiaWorld();
      this._cacheStamp = -1;
    } else if (resetTimer) {
      this.sleepTimer = 0;
    }
    return this;
  }

  sleep() {
    if (!this.allowSleep || this.sleeping) return this;
    this.sleeping = true;
    this.sleepTimer = 0;
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.pseudoVelocity.set(0, 0, 0);
    this.pseudoAngularVelocity.set(0, 0, 0);
    this.clearForces();
    return this;
  }

  /**
   * Advance the sleep timer.
   * @param {number} dt
   * @param {{sleepLinear:number, sleepAngular:number, sleepTime:number}} cfg
   */
  updateSleep(dt, cfg) {
    if (!this.allowSleep || !this.isDynamicMass || this.sleeping) { return; }
    if (this._keepAwake) { this._keepAwake = false; this.sleepTimer = 0; return; }
    const lin = cfg.sleepLinear, ang = cfg.sleepAngular;
    if (this.velocity.lengthSq() > lin * lin || this.angularVelocity.lengthSq() > ang * ang) {
      this.sleepTimer = 0;
      return;
    }
    this.sleepTimer += dt;
    if (this.sleepTimer >= cfg.sleepTime) this.sleep();
  }

  // ═════════════════════════════════════════════════════════ bounds / cache

  /** Recompute the world AABB from the collider + transform. */
  updateAABB(margin = 0) {
    colliderAABB(this.collider, this.position, this.quaternion, this.aabbMin, this.aabbMax, margin);
    return this;
  }

  /**
   * Refresh the world-space shape cache the narrow phase reads.
   * `stamp` is the PhysicsWorld step counter — repeated calls in the same step
   * are free.
   */
  updateWorldCache(stamp) {
    if (this._cacheStamp === stamp && stamp >= 0) return this.cache;
    // A static body never moves — transform it once and keep it forever.
    if (this.static && this._cacheStamp >= 0) return this.cache;
    this._cacheStamp = stamp;
    const c = this.cache;
    const col = this.collider;
    if (!c || !col) return c;

    const p = this.position;
    const r = quatToMatrix3(this.quaternion, _rot).elements;
    const r0 = r[0], r1 = r[1], r2 = r[2];
    const r3 = r[3], r4 = r[4], r5 = r[5];
    const r6 = r[6], r7 = r[7], r8 = r[8];

    if (col.type === ShapeType.SPHERE) {
      const o = col.centroid;
      c.cx = p.x + r0 * o[0] + r3 * o[1] + r6 * o[2];
      c.cy = p.y + r1 * o[0] + r4 * o[1] + r7 * o[2];
      c.cz = p.z + r2 * o[0] + r5 * o[1] + r8 * o[2];
      return c;
    }

    if (col.type === ShapeType.CAPSULE) {
      const a = col.p0, b = col.p1;
      c.ax = p.x + r0 * a[0] + r3 * a[1] + r6 * a[2];
      c.ay = p.y + r1 * a[0] + r4 * a[1] + r7 * a[2];
      c.az = p.z + r2 * a[0] + r5 * a[1] + r8 * a[2];
      c.bx = p.x + r0 * b[0] + r3 * b[1] + r6 * b[2];
      c.by = p.y + r1 * b[0] + r4 * b[1] + r7 * b[2];
      c.bz = p.z + r2 * b[0] + r5 * b[1] + r8 * b[2];
      return c;
    }

    // Hull / box
    const lv = col.vertices, wv = c.verts;
    for (let i = 0, n = col.vertexCount * 3; i < n; i += 3) {
      const x = lv[i], y = lv[i + 1], z = lv[i + 2];
      wv[i] = p.x + r0 * x + r3 * y + r6 * z;
      wv[i + 1] = p.y + r1 * x + r4 * y + r7 * z;
      wv[i + 2] = p.z + r2 * x + r5 * y + r8 * z;
    }
    const ln = col.faceNormals, wn = c.faceN, wd = c.faceD;
    for (let f = 0, n = col.faceCount; f < n; f++) {
      const i = f * 3;
      const x = ln[i], y = ln[i + 1], z = ln[i + 2];
      const nx = r0 * x + r3 * y + r6 * z;
      const ny = r1 * x + r4 * y + r7 * z;
      const nz = r2 * x + r5 * y + r8 * z;
      wn[i] = nx; wn[i + 1] = ny; wn[i + 2] = nz;
      const v0 = col.faceVerts[col.faceStart[f]] * 3;
      wd[f] = nx * wv[v0] + ny * wv[v0 + 1] + nz * wv[v0 + 2];
    }
    const ls = col.sideNormals, ws = c.sideN, wsd = c.sideD;
    for (let f = 0, nf = col.faceCount; f < nf; f++) {
      const s = col.faceStart[f], e = col.faceStart[f + 1];
      for (let i = s; i < e; i++) {
        const k = i * 3;
        const x = ls[k], y = ls[k + 1], z = ls[k + 2];
        const nx = r0 * x + r3 * y + r6 * z;
        const ny = r1 * x + r4 * y + r7 * z;
        const nz = r2 * x + r5 * y + r8 * z;
        ws[k] = nx; ws[k + 1] = ny; ws[k + 2] = nz;
        const v = col.faceVerts[i] * 3;
        wsd[i] = nx * wv[v] + ny * wv[v + 1] + nz * wv[v + 2];
      }
    }
    const le = col.edgeDirs, we = c.edgeDir;
    for (let i = 0, n = col.edgeDirCount * 3; i < n; i += 3) {
      const x = le[i], y = le[i + 1], z = le[i + 2];
      we[i] = r0 * x + r3 * y + r6 * z;
      we[i + 1] = r1 * x + r4 * y + r7 * z;
      we[i + 2] = r2 * x + r5 * y + r8 * z;
    }
    return c;
  }

  toString() {
    return `RigidBody#${this.id}${this.name ? `(${this.name})` : ''} ${this.type}`;
  }
}

/** Allocate the world-space shape cache for a collider (once, at setup). */
function makeShapeCache(collider) {
  if (!collider) return null;
  if (collider.type === ShapeType.SPHERE) return { kind: 'sphere', cx: 0, cy: 0, cz: 0 };
  if (collider.type === ShapeType.CAPSULE) {
    return { kind: 'capsule', ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0 };
  }
  return {
    kind: 'hull',
    verts: new Float32Array(collider.vertexCount * 3),
    faceN: new Float32Array(collider.faceCount * 3),
    faceD: new Float32Array(collider.faceCount),
    sideN: new Float32Array(collider.faceVerts.length * 3),
    sideD: new Float32Array(collider.faceVerts.length),
    edgeDir: new Float32Array(collider.edgeDirCount * 3),
  };
}

// ═════════════════════════════════════════════════════════ convenience

/** A dynamic box body. `size` is the FULL extents. */
export function createBoxBody(sizeX, sizeY, sizeZ, mass, opts = {}) {
  return new RigidBody({
    ...opts,
    collider: makeBox(sizeX * 0.5, sizeY * 0.5, sizeZ * 0.5, opts.center),
    mass,
  });
}

/** A dynamic sphere body. */
export function createSphereBody(radius, mass, opts = {}) {
  return new RigidBody({ ...opts, collider: makeSphere(radius, opts.center), mass });
}

/** A dynamic capsule body. */
export function createCapsuleBody(radius, halfHeight, mass, opts = {}) {
  return new RigidBody({
    ...opts,
    collider: makeCapsule(radius, halfHeight, opts.axis ?? 'y', opts.center),
    mass,
  });
}

export default RigidBody;
