/**
 * Defensive read of the `Car` contract (ARCHITECTURE.md → Car).
 *
 * The camera is written before the vehicle code exists and has to survive every
 * partially-implemented version of it: a car with only a RigidBody, a car with
 * only a visual group, a car whose telemetry fields are still zero. So we sample
 * once per frame into a flat struct, deriving whatever the vehicle system has not
 * filled in yet (speed from velocity, drift from slip angle, lateral G from yaw
 * rate × speed). Every rig then reads the same struct and never null-checks again.
 *
 * Zero allocations after construction.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils.js';

const _v = new THREE.Vector3();

export class CarState {
  constructor() {
    /** false when there is no usable car this frame — rigs must fall back. */
    this.valid = false;
    /** @type {object|null} */
    this.car = null;
    this.id = -1;

    this.position = new THREE.Vector3();      // interpolated visual position
    this.simPosition = new THREE.Vector3();   // exact physics position
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();

    this.forward = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);

    /** Horizontal travel direction; falls back to `forward` when nearly stopped. */
    this.travel = new THREE.Vector3(0, 0, -1);
    this.horizontalSpeed = 0;

    this.speed = 0;            // signed, m/s along forward
    this.topSpeed = 9;
    this.speedFrac = 0;        // |speed| / topSpeed, 0..1
    this.reversing = false;

    this.slipAngle = 0;
    this.driftFactor = 0;
    this.lateralG = 0;
    this.longitudinalG = 0;

    this.wheelsOnGround = 4;
    this.airborne = false;
    this.airTime = 0;
    this.upsideDown = false;
    this.surfaceId = 0;
    this.boost = 0;
    this.finished = false;

    // finite-difference fallbacks
    this._hasPrev = false;
    this._prevPos = new THREE.Vector3();
    this._prevSpeed = 0;
    this._prevLat = 0;
    this._prevId = -2;
  }

  /** Forget history (car swap, respawn, teleport). */
  reset() {
    this._hasPrev = false;
    this._prevSpeed = 0;
    this._prevLat = 0;
  }

  /**
   * @param {object|null} car
   * @param {number} dt seconds since the previous sample (may be 0)
   */
  sample(car, dt) {
    if (!car) {
      this.valid = false;
      this.car = null;
      this.id = -1;
      this._hasPrev = false;
      return this;
    }

    if (car.id !== this._prevId) { this.reset(); this._prevId = car.id ?? -1; }
    this.car = car;
    this.id = car.id ?? 0;

    const body = car.body ?? null;
    const group = car.group ?? null;

    // ── transform ──────────────────────────────────────────────────────────
    let got = false;
    if (typeof car.worldPosition === 'function') {
      try { car.worldPosition(this.position); got = Number.isFinite(this.position.x); }
      catch (err) { got = false; }
    }
    if (!got && group) {
      try { group.getWorldPosition(this.position); got = true; } catch (err) { got = false; }
    }
    if (!got && body?.position) { this.position.copy(body.position); got = true; }
    if (!got) { this.valid = false; return this; }

    if (body?.position) this.simPosition.copy(body.position);
    else this.simPosition.copy(this.position);

    if (group?.quaternion) {
      if (group.parent && group.parent.parent) {
        // Nested under something transformed — go the safe route.
        group.getWorldQuaternion(this.quaternion);
      } else {
        this.quaternion.copy(group.quaternion);
      }
    } else if (body?.quaternion) {
      this.quaternion.copy(body.quaternion);
    }

    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);

    // ── velocity ───────────────────────────────────────────────────────────
    if (body?.velocity) {
      this.velocity.copy(body.velocity);
    } else if (this._hasPrev && dt > 1e-4) {
      _v.subVectors(this.position, this._prevPos).multiplyScalar(1 / dt);
      // A visual-only car can jitter; smooth the derivative hard.
      this.velocity.lerp(_v, 0.35);
    } else {
      this.velocity.set(0, 0, 0);
    }
    // A 1:10 car tops out around 9 m/s. Anything past 30 is a physics blow-up or a
    // teleport, and the camera must not act on it.
    if (!Number.isFinite(this.velocity.x) || !Number.isFinite(this.velocity.y)
      || !Number.isFinite(this.velocity.z)) {
      this.velocity.set(0, 0, 0);
    } else {
      const vl = this.velocity.length();
      if (vl > 30) this.velocity.multiplyScalar(30 / vl);
    }

    if (body?.angularVelocity) this.angularVelocity.copy(body.angularVelocity);
    else this.angularVelocity.set(0, 0, 0);

    this._prevPos.copy(this.position);
    this._hasPrev = true;

    // ── scalars ────────────────────────────────────────────────────────────
    this.topSpeed = numOr(car.def?.topSpeed, 9);
    if (this.topSpeed < 1) this.topSpeed = 9;

    this.speed = Number.isFinite(car.speed) && car.speed !== 0
      ? car.speed
      : this.velocity.dot(this.forward);
    if (!Number.isFinite(this.speed)) this.speed = 0;
    this.speedFrac = clamp01(Math.abs(this.speed) / this.topSpeed);
    this.reversing = this.speed < -0.25;

    this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.horizontalSpeed > 0.35) {
      const inv = 1 / this.horizontalSpeed;
      this.travel.set(this.velocity.x * inv, 0, this.velocity.z * inv);
      // Travelling backwards? The camera still wants the *facing* heading.
      if (this.travel.x * this.forward.x + this.travel.z * this.forward.z < 0) {
        this.travel.set(this.forward.x, 0, this.forward.z);
        const l = Math.hypot(this.travel.x, this.travel.z) || 1;
        this.travel.multiplyScalar(1 / l);
      }
    } else {
      this.travel.set(this.forward.x, 0, this.forward.z);
      const l = Math.hypot(this.travel.x, this.travel.z) || 1;
      this.travel.multiplyScalar(1 / l);
    }

    // slip angle: chassis velocity vs heading, horizontal only
    if (Number.isFinite(car.slipAngle) && car.slipAngle !== 0) {
      this.slipAngle = car.slipAngle;
    } else if (this.horizontalSpeed > 0.6) {
      const fx = this.forward.x, fz = this.forward.z;
      const fl = Math.hypot(fx, fz) || 1;
      const lat = (this.velocity.x * (fz / fl) - this.velocity.z * (fx / fl));
      const lon = (this.velocity.x * (fx / fl) + this.velocity.z * (fz / fl));
      this.slipAngle = Math.atan2(lat, Math.abs(lon) + 0.05);
    } else {
      this.slipAngle = 0;
    }

    if (Number.isFinite(car.driftFactor) && car.driftFactor > 0) {
      this.driftFactor = clamp01(car.driftFactor);
    } else {
      // ~9° of slip starts to read as a drift; 40° is fully sideways.
      this.driftFactor = clamp01((Math.abs(this.slipAngle) - 0.16) / 0.55)
        * clamp01(this.horizontalSpeed / 2.0);
    }

    if (Number.isFinite(car.lateralG) && car.lateralG !== 0) {
      this.lateralG = car.lateralG;
    } else {
      // a_lat = ω_yaw × v  → in g
      this.lateralG = clamp((this.angularVelocity.y * this.speed) / 9.81, -4, 4);
    }
    if (Number.isFinite(car.longitudinalG) && car.longitudinalG !== 0) {
      this.longitudinalG = car.longitudinalG;
    } else if (dt > 1e-4) {
      this.longitudinalG = clamp(((this.speed - this._prevSpeed) / dt) / 9.81, -6, 6);
    }
    this._prevSpeed = this.speed;

    this.wheelsOnGround = Number.isFinite(car.wheelsOnGround) ? car.wheelsOnGround : 4;
    this.airborne = !!car.airborne || (Number.isFinite(car.wheelsOnGround) && car.wheelsOnGround === 0);
    this.airTime = numOr(car.airTime, 0);
    this.upsideDown = !!car.upsideDown || this.up.y < -0.15;
    this.surfaceId = numOr(car.dominantSurfaceId, 0);
    this.boost = clamp01(numOr(car.effects?.boost, 0));
    this.finished = !!car.finished;

    this.valid = true;
    return this;
  }
}

function numOr(v, d) { return Number.isFinite(v) ? v : d; }

export default CarState;
