/**
 * FinishCamera — orbits the winner after the line, with a rack focus.
 *
 * The beat we are selling: the car crosses, the world goes quiet, the lens racks
 * from somewhere in front of the car onto the car itself while the camera swings
 * around it and the FOV creeps in. It has to keep working while the car is still
 * rolling at 8 m/s, so:
 *
 *  • the orbit centre chases the car with a soft spring and a velocity lead, so
 *    the car stays framed as it decelerates;
 *  • the orbit starts at whatever angle the camera is already at (no cut), then
 *    drifts around at ~0.4 rad/s and rises;
 *  • a sphere cast keeps the orbit out of walls — a finish line is usually in a
 *    corridor, and orbiting through a wall would be the one thing everyone sees;
 *  • the rack focus is explicit (PostFX auto-focus is disabled while we own it)
 *    so the pull is a deliberate 1.3 s move rather than a servo hunting.
 */

import * as THREE from 'three';
import { clamp, clamp01, lerp, smootherstep, smoothstep, TAU } from '../core/MathUtils.js';
import { createRayHit, Layer } from '../physics/index.js';
import { WORLD_UP, framingUp } from './CameraPose.js';
import { Spring, Vec3Spring, lagCoefficient, addLagCompensation } from './Spring.js';

const _v = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit = createRayHit();
const CAST_MASK = Layer.TRACK | Layer.PROP | Layer.DEFAULT;

export const FINISH_PRESETS = Object.freeze({
  finish: {
    radiusFrom: 1.15, radiusTo: 2.15,
    heightFrom: 0.30, heightTo: 0.86,
    orbitSpeed: 0.42,
    fovFrom: 52, fovTo: 33,
    rise: 2.6,               // seconds to reach the top of the arc
    rackTime: 1.35,          // seconds for the focus pull
    rackFrom: 0.42,          // × the subject distance where focus starts
    focusRange: 0.30, maxBlur: 0.030,
    lookLift: 0.055,
    lookLead: 0.10,
    posOmega: 4.6, lookOmega: 7.0,
    minRadius: 0.55,
    shakeScale: 0.30,
  },
  podium: {
    radiusFrom: 0.95, radiusTo: 1.45,
    heightFrom: 0.24, heightTo: 0.52,
    orbitSpeed: 0.24,
    fovFrom: 40, fovTo: 30,
    rise: 4.0,
    rackTime: 1.1,
    rackFrom: 0.55,
    focusRange: 0.26, maxBlur: 0.034,
    lookLift: 0.05,
    lookLead: 0.02,
    posOmega: 3.4, lookOmega: 5.5,
    minRadius: 0.45,
    shakeScale: 0.18,
  },
});

export class FinishCamera {
  /**
   * @param {import('./CameraDirector.js').CameraDirector} director
   * @param {keyof typeof FINISH_PRESETS} presetName
   */
  constructor(director, presetName = 'finish') {
    this.director = director;
    this.game = director?.game ?? null;
    this.name = presetName;
    this.preset = FINISH_PRESETS[presetName] ?? FINISH_PRESETS.finish;

    /** The car being celebrated. Falls back to the director's target. */
    this.subject = null;
    this.centre = new THREE.Vector3();
    this.angle = 0;
    this.t = 0;
    this.spin = 1;                       // orbit direction

    this.pos = new Vec3Spring(this.preset.posOmega, 1);
    this.look = new Vec3Spring(this.preset.lookOmega, 1);
    this.fov = new Spring(this.preset.fovFrom, 2.2, 1);
    this.focus = new Spring(2, 2.0, 1);
    this.radius = new Spring(this.preset.radiusFrom, 1.4, 1);
    this._occ = 1;
  }

  setPreset(name) {
    const p = FINISH_PRESETS[name];
    if (!p) return this;
    this.name = name;
    this.preset = p;
    return this;
  }

  /** Optional: celebrate someone other than the player. */
  setSubject(car) { this.subject = car ?? null; return this; }

  activate(ctx, fromPose = null) {
    const p = this.preset;
    const cs = ctx?.carState;
    this.t = 0;
    this._occ = 1;

    if (cs?.valid) this.centre.copy(cs.position);
    else if (ctx?.track?.checkpoints?.length) {
      const fin = ctx.track.checkpoints.find((c) => c?.isFinish) ?? ctx.track.checkpoints[0];
      if (fin?.position) this.centre.copy(fin.position);
    } else this.centre.set(0, 0.15, 0);

    // Continuity: start where the camera already is, orbiting away from it.
    if (fromPose) {
      _v.subVectors(fromPose.position, this.centre);
      const r = Math.hypot(_v.x, _v.z);
      this.angle = r > 1e-3 ? Math.atan2(_v.x, _v.z) : 0;
      this.radius.snap(clamp(r > 1e-3 ? r : p.radiusFrom, p.minRadius, p.radiusTo * 1.5));
      this.pos.snap(fromPose.position);
      this.fov.snap(fromPose.fov);
    } else {
      this.angle = cs?.valid ? Math.atan2(cs.forward.x, cs.forward.z) + Math.PI : 0;
      this.radius.snap(p.radiusFrom);
      this._place(p.radiusFrom, p.heightFrom);
      this.pos.snap(_eye);
      this.fov.snap(p.fovFrom);
    }

    // Orbit the way the car is turning, if it is turning.
    const steer = Number.isFinite(cs?.car?.steer) ? cs.car.steer : 0;
    this.spin = steer < -0.15 ? -1 : 1;

    _look.copy(this.centre); _look.y += p.lookLift;
    this.look.snap(_look);
    const d = Math.max(this.pos.value.distanceTo(_look), 0.3);
    this.focus.snap(d * p.rackFrom);
    return this;
  }

  deactivate() { return this; }
  isDone() { return false; }
  snap() { return this; }

  _place(r, h) {
    _eye.set(
      this.centre.x + Math.sin(this.angle) * r,
      this.centre.y + h,
      this.centre.z + Math.cos(this.angle) * r);
    return _eye;
  }

  update(dt, ctx, out) {
    const p = this.preset;
    dt = clamp(dt, 0, 0.25);
    this.t += dt;

    const cs = ctx?.carState;
    if (cs?.valid) {
      // Lead the car a touch so a rolling finish stays centred.
      _v.copy(cs.position);
      addLagCompensation(_v, cs.velocity, p.lookLead, p.lookLead * 0.4, 0.8);
      this.centre.lerp(_v, clamp01(dt * 3.0));
    }

    this.angle += p.orbitSpeed * this.spin * dt;
    if (this.angle > Math.PI) this.angle -= TAU;
    else if (this.angle < -Math.PI) this.angle += TAU;

    const rise = clamp01(this.t / Math.max(p.rise, 0.01));
    const eased = smootherstep(rise);
    let radius = lerp(p.radiusFrom, p.radiusTo, eased);
    const height = lerp(p.heightFrom, p.heightTo, eased);

    // Keep the orbit out of the scenery.
    const physics = ctx?.physics;
    let allowed = 1;
    if (physics?.trackMesh) {
      _v.copy(this.centre); _v.y += 0.05;
      _dir.set(Math.sin(this.angle), 0, Math.cos(this.angle));
      _dir.y = height / Math.max(radius, 1e-3);
      _dir.normalize();
      const len = Math.hypot(radius, height);
      try {
        if (physics.sphereCast(_v, _dir, 0.11, len, _hit, CAST_MASK)) {
          allowed = clamp01(Math.max(_hit.distance, p.minRadius) / Math.max(len, 1e-3));
        }
      } catch (err) { allowed = 1; }
    }
    this._occ = this._occ + (allowed - this._occ) * (1 - Math.exp(-(allowed < this._occ ? 18 : 3) * dt));
    radius = Math.max(radius * this._occ, p.minRadius);

    this.radius.update(radius, dt, 6, 1);
    this._place(this.radius.value, height * lerp(1, 1.15, 1 - this._occ));
    // The winner may still be doing 8 m/s: cancel the spring lag or the orbit
    // falls behind and we celebrate an empty stretch of track.
    if (cs?.valid) {
      const k = lagCoefficient(p.posOmega, 1, 0.85);
      addLagCompensation(_eye, cs.velocity, k, k * 0.5, this.radius.value * 0.9);
    }
    this.pos.update(_eye, dt, p.posOmega, 1);

    _look.copy(this.centre);
    _look.y += p.lookLift;
    if (cs?.valid) {
      const kl = lagCoefficient(p.lookOmega, 1, 0.9);
      addLagCompensation(_look, cs.velocity, kl, kl * 0.6, this.radius.value * 0.7);
    }
    this.look.update(_look, dt, p.lookOmega, 1);

    this.fov.update(lerp(p.fovFrom, p.fovTo, smoothstep(clamp01(this.t / Math.max(p.rise, 0.01)))), dt, 1.8, 1);

    // ── rack focus ──
    const subjectDist = Math.max(this.pos.value.distanceTo(this.look.value), 0.25);
    const rack = clamp01(this.t / Math.max(p.rackTime, 0.05));
    const focusTarget = lerp(subjectDist * p.rackFrom, subjectDist, smootherstep(rack));
    this.focus.update(focusTarget, dt, 4.0, 1);

    framingUp(_up, cs?.valid ? cs.up : WORLD_UP, 0.10);
    out.lookAt(this.pos.value, this.look.value, _up, 0);
    out.fov = clamp(this.fov.value, 18, 100);
    out.shakeScale = p.shakeScale;
    out.dofIntensity = 1;
    out.focusDistance = this.focus.value;
    out.focusRange = p.focusRange;
    out.maxBlur = p.maxBlur;
    out.speedIntensity = 0;
    return out;
  }

  dispose() {}
}

export default FinishCamera;
