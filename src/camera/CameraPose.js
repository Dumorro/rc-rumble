/**
 * The one currency every camera rig in this directory speaks: a pose.
 *
 * A rig never touches `game.camera`. It fills a CameraPose, and the director
 * blends poses, applies shake, and commits the winner to the real camera exactly
 * once per frame. That is what makes cross-fading between a chase cam and a
 * cinematic flyby a two-line operation instead of a pile of special cases.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, smootherstep, smoothstep } from '../core/MathUtils.js';

const _m4 = new THREE.Matrix4();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _qRoll = new THREE.Quaternion();
const _zAxis = new THREE.Vector3(0, 0, 1);

export const WORLD_UP = Object.freeze(new THREE.Vector3(0, 1, 0));

export class CameraPose {
  constructor() {
    this.position = new THREE.Vector3(0, 1.2, 2.4);
    this.quaternion = new THREE.Quaternion();

    /** Vertical field of view in degrees. */
    this.fov = CONFIG.render.fovBase;
    /** Informational: the roll already baked into `quaternion`, radians. */
    this.roll = 0;

    /** 0..1 multiplier a rig can use to tame shake (cinematics want less). */
    this.shakeScale = 1;

    /** 0 = leave DOF alone, >0 = the rig wants depth of field at this strength. */
    this.dofIntensity = 0;
    /** Metres. 0 = let PostFX auto-focus on the player. */
    this.focusDistance = 0;
    this.focusRange = 0.5;
    this.maxBlur = 0.024;

    /** 0..1 the rig's own idea of how fast things feel (drives post FX). */
    this.speedIntensity = 0;

    /** Set true for one frame when the rig has hard-cut and temporal FX must reset. */
    this.cut = false;
  }

  copy(o) {
    this.position.copy(o.position);
    this.quaternion.copy(o.quaternion);
    this.fov = o.fov;
    this.roll = o.roll;
    this.shakeScale = o.shakeScale;
    this.dofIntensity = o.dofIntensity;
    this.focusDistance = o.focusDistance;
    this.focusRange = o.focusRange;
    this.maxBlur = o.maxBlur;
    this.speedIntensity = o.speedIntensity;
    this.cut = o.cut;
    return this;
  }

  /** Read the current state of a THREE camera into this pose. */
  fromCamera(cam) {
    if (!cam) return this;
    this.position.copy(cam.position);
    this.quaternion.copy(cam.quaternion);
    if (cam.isPerspectiveCamera) this.fov = cam.fov;
    return this;
  }

  /** Unit forward (-Z) of this pose. */
  getForward(out) { return out.set(0, 0, -1).applyQuaternion(this.quaternion); }
  getRight(out) { return out.set(1, 0, 0).applyQuaternion(this.quaternion); }
  getUp(out) { return out.set(0, 1, 0).applyQuaternion(this.quaternion); }

  /**
   * Aim the pose. `up` is a reference up (usually world up, optionally tilted
   * toward the car's up on banked track), `roll` is an extra bank in radians
   * applied about the view axis.
   */
  lookAt(eye, target, up = WORLD_UP, roll = 0) {
    this.position.copy(eye);

    _fwd.subVectors(target, eye);
    const len = _fwd.length();
    if (len < 1e-5) {
      // Degenerate: keep the previous orientation rather than snapping to identity.
      this.roll = roll;
      return this;
    }
    _fwd.multiplyScalar(1 / len);

    // Build a stable basis. If forward is (nearly) parallel to up, substitute any
    // vector perpendicular to forward — (-fy, fx, 0) always is.
    _up.copy(up);
    if (Math.abs(_up.dot(_fwd)) > 0.9995) {
      _up.set(-_fwd.y, _fwd.x, 0);
      if (_up.lengthSq() < 1e-8) _up.set(0, 0, 1);
      _up.normalize();
    }
    // right = forward × up, up = right × forward  (three cameras look down -Z)
    _right.crossVectors(_fwd, _up);
    if (_right.lengthSq() < 1e-10) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _fwd).normalize();

    // Columns (right, up, -forward) → a right-handed camera basis aimed at target.
    _m4.makeBasis(_right, _up, _fwd.negate());
    this.quaternion.setFromRotationMatrix(_m4);

    if (roll !== 0) {
      _qRoll.setFromAxisAngle(_zAxis, roll);
      this.quaternion.multiply(_qRoll);
    }
    this.roll = roll;
    return this;
  }

  /** Bank an already-oriented pose. */
  addRoll(roll) {
    if (!roll) return this;
    _qRoll.setFromAxisAngle(_zAxis, roll);
    this.quaternion.multiply(_qRoll);
    this.roll += roll;
    return this;
  }
}

/**
 * Blend two poses. Position uses smootherstep (C² — no visible velocity kink at
 * either end), rotation uses smoothstep + slerp, and scalars ride along linearly
 * on the eased parameter so FOV never pops.
 *
 * @param {CameraPose} out
 * @param {CameraPose} a t = 0
 * @param {CameraPose} b t = 1
 * @param {number} t 0..1 raw
 */
export function blendPose(out, a, b, t) {
  t = clamp01(t);
  if (t <= 0) return out.copy(a);
  if (t >= 1) return out.copy(b);

  const ep = smootherstep(t);
  const er = smoothstep(t);

  out.position.lerpVectors(a.position, b.position, ep);
  // slerpQuaternions is allocation free in three r180.
  out.quaternion.slerpQuaternions(a.quaternion, b.quaternion, er);

  out.fov = a.fov + (b.fov - a.fov) * ep;
  out.roll = a.roll + (b.roll - a.roll) * ep;
  out.shakeScale = a.shakeScale + (b.shakeScale - a.shakeScale) * ep;
  out.dofIntensity = a.dofIntensity + (b.dofIntensity - a.dofIntensity) * ep;
  out.focusRange = a.focusRange + (b.focusRange - a.focusRange) * ep;
  out.maxBlur = a.maxBlur + (b.maxBlur - a.maxBlur) * ep;
  out.speedIntensity = a.speedIntensity + (b.speedIntensity - a.speedIntensity) * ep;

  // Auto-focus (0) must not be averaged into a real distance — pick the dominant side.
  if (a.focusDistance > 0 && b.focusDistance > 0) {
    out.focusDistance = a.focusDistance + (b.focusDistance - a.focusDistance) * ep;
  } else {
    out.focusDistance = ep < 0.5 ? a.focusDistance : b.focusDistance;
  }

  out.cut = a.cut || b.cut;
  return out;
}

// ───────────────────────────────────────────────────────────── yaw helpers

/**
 * Our yaw convention, chosen so it needs no sign gymnastics:
 *   dir = (sin(yaw), 0, cos(yaw))
 * A car at identity rotation faces (0,0,-1) ⇒ yaw = PI. Round trips exactly.
 */
export const yawOf = (x, z) => Math.atan2(x, z);

/** @param {THREE.Vector3} out */
export function dirFromYaw(yaw, out) {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

/**
 * Reference "up" for framing: mostly world up (so the horizon stays level and
 * nobody gets motion sick), tilted a little toward the car's own up so banked
 * walls and loops read. Collapses to pure world up when the car is inverted.
 *
 * @param {THREE.Vector3} out
 * @param {THREE.Vector3} carUp
 * @param {number} k 0..1 how much car-up to admit
 */
export function framingUp(out, carUp, k) {
  const d = carUp.dot(WORLD_UP);
  // Fade the car's contribution out as it tips past ~60° and kill it when inverted.
  const w = clamp01(k) * clamp01((d - 0.15) * 1.6);
  if (w <= 0.001) return out.copy(WORLD_UP);
  out.copy(WORLD_UP).lerp(carUp, w);
  const l = out.length();
  if (l < 1e-5) return out.copy(WORLD_UP);
  return out.multiplyScalar(1 / l);
}

export { clamp, clamp01 };
export default CameraPose;
