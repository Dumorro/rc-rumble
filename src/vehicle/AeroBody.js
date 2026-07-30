/**
 * RC RUMBLE — aerodynamics and airborne behaviour.
 *
 * Two jobs.
 *
 * 1. **On the ground:** anisotropic drag (much higher sideways than forwards, so
 *    a big slide actually scrubs speed) and speed-squared downforce applied
 *    behind the centre of mass, with a ground-effect bonus that scales with how
 *    squatted the suspension is. The drag coefficient is *derived* in CarDefs so
 *    that wide-open throttle in top gear settles exactly on the car's stated
 *    `topSpeed`.
 *
 * 2. **In the air — the single most Re-Volt thing in the game.** While all four
 *    wheels are off the ground the player keeps *limited* attitude authority:
 *
 *      steer    → yaw (mostly) + roll (a little)
 *      throttle → nose down
 *      brake    → nose up
 *
 *    On top of that the car:
 *      • self-levels slowly toward world up (spring + damper, and the damper
 *        deliberately does NOT damp yaw, so the player keeps their air-steer),
 *      • weathervanes its nose toward the velocity vector, and
 *      • carries a small constant nose-down bias.
 *
 *    Together those three make a jump arc *readable*: you leave a ramp, the nose
 *    rises with the trajectory, tips over the apex, and comes down front-wheels
 *    first — while still letting the player fight it. Authority ramps in over
 *    the first ~0.18 s of air time so the launch itself is never smothered.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils.js';

// ═══════════════════════════════════════════════════════════════════════════
// Scratch
// ═══════════════════════════════════════════════════════════════════════════

const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _v = new THREE.Vector3();
const _vLocal = new THREE.Vector3();
const _force = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _wLocal = new THREE.Vector3();
const _point = new THREE.Vector3();
const _velDir = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Air-control authority ramps from 0 → 1 over this many seconds of air time. */
const AUTHORITY_RAMP = 0.18;

export class AeroBody {
  /** @param {import('./Car.js').Car} car */
  constructor(car) {
    this.car = car;
    this.def = car.def;
    const a = this.def.aero;

    this.dragK = a.dragK;
    this.lateralDragK = a.lateralDragK;
    this.verticalDragK = a.dragK * 0.62;
    this.downforceK = a.downforceK;
    this.downforceZ = a.downforceZ;
    this.groundEffect = a.groundEffect;

    this.airPitch = a.airPitch;
    this.airRoll = a.airRoll;
    this.airYaw = a.airYaw;
    this.selfLevel = a.selfLevel;
    this.selfLevelDamp = a.selfLevelDamp;
    this.weathervane = a.weathervane;
    this.airAngularDamp = a.airAngularDamp;
    this.noseDown = a.noseDown;

    // ── telemetry ─────────────────────────────────────────────────────
    /** Downforce applied last step (N). */
    this.downforce = 0;
    /** Drag magnitude applied last step (N). */
    this.drag = 0;
    /** 0..1 how much air-control authority the player currently has. */
    this.authority = 0;
    /** Signed pitch of the chassis relative to the horizon (rad). */
    this.pitchAngle = 0;
    /** Signed roll of the chassis relative to the horizon (rad). */
    this.rollAngle = 0;
  }

  reset() {
    this.downforce = 0;
    this.drag = 0;
    this.authority = 0;
    this.pitchAngle = 0;
    this.rollAngle = 0;
  }

  /**
   * @param {number} dt
   * @param {number} steer -1..1
   * @param {number} throttle 0..1
   * @param {number} brake 0..1
   */
  update(dt, steer, throttle, brake) {
    const car = this.car;
    const body = car.body;
    if (!body) return;

    body.getUp(_up);
    body.getRight(_right);
    body.getForward(_fwd);
    _v.copy(body.velocity);
    const speed = _v.length();

    // Attitude relative to the horizon — used for telemetry and by the camera.
    this.pitchAngle = Math.asin(clamp(-_fwd.y, -1, 1));
    this.rollAngle = Math.asin(clamp(_right.y, -1, 1)) * -1;

    // ── drag (anisotropic, chassis frame) ──────────────────────────────
    if (speed > 0.02) {
      body.worldToLocalDir(_v, _vLocal);
      const fx = -this.lateralDragK * Math.abs(_vLocal.x) * _vLocal.x;
      const fy = -this.verticalDragK * Math.abs(_vLocal.y) * _vLocal.y;
      const fz = -this.dragK * Math.abs(_vLocal.z) * _vLocal.z;
      _force.set(fx, fy, fz).applyQuaternion(body.quaternion);
      this.drag = _force.length();
      body.applyForce(_force);
    } else {
      this.drag = 0;
    }

    // ── downforce ──────────────────────────────────────────────────────
    const onGround = car.wheelsOnGround > 0;
    if (speed > 0.45 && this.downforceK > 0) {
      let df = this.downforceK * speed * speed;
      if (onGround) {
        df *= 1 + this.groundEffect * clamp01(car.suspension.squat() * 1.25);
      } else {
        df *= 0.45;
      }
      this.downforce = df;
      _force.copy(_up).multiplyScalar(-df);
      _point.set(0, 0, this.downforceZ).applyQuaternion(body.quaternion).add(body.position);
      body.applyForce(_force, _point);
    } else {
      this.downforce = 0;
    }

    // ── airborne attitude control ──────────────────────────────────────
    if (car.airborne) {
      this.authority = clamp01((car.airTime - 0.03) / AUTHORITY_RAMP);
      const auth = this.authority;
      if (auth > 0) {
        _torque.set(0, 0, 0);

        // Player input.
        const pitchCmd = brake - throttle;             // + = nose up
        _torque.addScaledVector(_right, this.airPitch * pitchCmd * auth);
        _torque.addScaledVector(_fwd, this.airRoll * steer * auth);
        _torque.addScaledVector(_up, -this.airYaw * steer * auth);

        // Constant nose-down bias so long jumps tip over readably.
        const tip = clamp01(car.airTime * 1.8) * auth;
        _torque.addScaledVector(_right, -this.noseDown * tip);

        // Self-levelling spring: cross(up, worldUp) is the axis scaled by sinθ.
        _axis.crossVectors(_up, WORLD_UP);
        _torque.addScaledVector(_axis, this.selfLevel * auth);

        // Weathervane the nose onto the velocity vector.
        if (speed > 1.2 && this.weathervane > 0) {
          _velDir.copy(_v).multiplyScalar(1 / speed);
          _axis.crossVectors(_fwd, _velDir);
          _torque.addScaledVector(_axis, this.weathervane * auth * clamp01(speed / 6));
        }

        body.applyTorque(_torque);

        // Damping. Roll and pitch are damped hard; yaw is left almost free so
        // the player keeps their air-steer authority.
        const I = body.inertiaTensorLocal;
        body.worldToLocalDir(body.angularVelocity, _wLocal);
        const k = this.airAngularDamp * auth;
        const kLevel = this.selfLevelDamp * auth;
        _torque.set(
          -(_wLocal.x * I.x) * k - _wLocal.x * kLevel,
          -(_wLocal.y * I.y) * k * 0.22,
          -(_wLocal.z * I.z) * k - _wLocal.z * kLevel,
        ).applyQuaternion(body.quaternion);
        body.applyTorque(_torque);
      }
    } else {
      this.authority = 0;
    }
  }

  /**
   * Extra yaw damping that only engages while the driver is counter-steering.
   * This is the assist that makes a slide catchable without making the car feel
   * like it is on rails: it does nothing at all unless the steering opposes the
   * direction the tail is going.
   * @param {number} steer -1..1
   * @param {number} slipAngle chassis slip angle (rad)
   */
  applyCounterSteerAssist(steer, slipAngle) {
    const gain = this.def.counterSteerAssist;
    if (gain <= 0) return;
    const car = this.car;
    const body = car.body;
    if (!body || car.airborne || car.wheelsOnGround < 2) return;
    const slip = Math.abs(slipAngle);
    if (slip < 0.10) return;
    // Counter-steering means the steering sign opposes the slip sign.
    const opposing = -Math.sign(steer) === Math.sign(slipAngle) && Math.abs(steer) > 0.12;
    if (!opposing) return;
    const strength = clamp01((slip - 0.10) / 0.35) * Math.abs(steer);
    body.getUp(_axis);
    const yaw = body.angularVelocity.dot(_axis);
    _torque.copy(_axis).multiplyScalar(-yaw * gain * strength);
    body.applyTorque(_torque);
  }
}

export default AeroBody;
