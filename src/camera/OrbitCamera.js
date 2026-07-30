/**
 * OrbitCamera — the "there is always something on screen" rig.
 *
 * Two jobs:
 *   1. **Menu / boot fallback.** No track, no car, nothing loaded: slowly orbit the
 *      scene origin so the main menu has a live 3D backdrop instead of a black void.
 *      This is the guard the whole director leans on — every failure path lands here.
 *   2. **Showcase orbit.** With a car or a track loaded, frame it: radius derived
 *      from the track bounds (or the car), a slow drift in azimuth, a gentle
 *      vertical breathe, and a long-lens FOV with DOF for that turntable look.
 *
 * Deliberately cheap and unconditionally safe: no raycasts, no dependencies on
 * anything but a Box3 that may or may not exist.
 */

import * as THREE from 'three';
import { clamp, TAU } from '../core/MathUtils.js';
import { WORLD_UP } from './CameraPose.js';
import { Spring, Vec3Spring, lagCoefficient, addLagCompensation } from './Spring.js';

const _focus = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _look = new THREE.Vector3();
const _size = new THREE.Vector3();

export const ORBIT_PRESETS = Object.freeze({
  /** Menu backdrop: wide, patient, cinematic. */
  orbit: {
    radiusScale: 0.62, minRadius: 2.2, maxRadius: 26,
    heightScale: 0.30, minHeight: 0.9,
    speed: 0.085,             // rad/s
    bob: 0.10, bobRate: 0.19,
    // NOT derived from FOV_BASE, deliberately. `_radiusTarget` is
    // `extent * radiusScale` with no lens compensation, so narrowing this from
    // the 50° it shipped at would crop the menu backdrop by ~50% on a 40 m
    // track: at 26 m out, 50° vertical is 78° horizontal and only just contains
    // it. Retune `radiusScale` in the same change if you ever move this.
    fov: 50,
    fovBreathe: 2.4, fovRate: 0.11,
    dof: 0.85, focusRange: 0.55, maxBlur: 0.026,
    lookLift: 0.06,
    posOmega: 2.6, lookOmega: 3.4,
    shakeScale: 0.25,
  },
  /** Car showcase / garage / generic 'cinematic' mode: close, tighter lens. */
  cinematic: {
    radiusScale: 0.32, minRadius: 0.95, maxRadius: 4.0,
    heightScale: 0.16, minHeight: 0.30,
    speed: 0.20,
    bob: 0.05, bobRate: 0.33,
    fov: 38,
    fovBreathe: 3.0, fovRate: 0.16,
    dof: 1.0, focusRange: 0.34, maxBlur: 0.030,
    lookLift: 0.045,
    posOmega: 4.2, lookOmega: 6.0,
    shakeScale: 0.4,
  },
  /** Post-race podium: near-static, slow rise, long lens. */
  podium: {
    radiusScale: 0.28, minRadius: 0.85, maxRadius: 3.0,
    heightScale: 0.18, minHeight: 0.36,
    speed: 0.13,
    bob: 0.03, bobRate: 0.22,
    fov: 34,
    fovBreathe: 1.6, fovRate: 0.10,
    dof: 1.0, focusRange: 0.30, maxBlur: 0.032,
    lookLift: 0.05,
    posOmega: 3.4, lookOmega: 5.0,
    shakeScale: 0.2,
  },
});

export class OrbitCamera {
  /**
   * @param {import('./CameraDirector.js').CameraDirector} director
   * @param {keyof typeof ORBIT_PRESETS} presetName
   */
  constructor(director, presetName = 'orbit') {
    this.director = director;
    this.game = director?.game ?? null;
    this.name = presetName;
    this.preset = ORBIT_PRESETS[presetName] ?? ORBIT_PRESETS.orbit;

    this.angle = 0.7;
    this.t = 0;
    this.radius = new Spring(4, this.preset.posOmega, 1);
    this.height = new Spring(1.5, this.preset.posOmega, 1);
    this.pos = new Vec3Spring(this.preset.posOmega, 1);
    this.look = new Vec3Spring(this.preset.lookOmega, 1);
    this.fov = new Spring(this.preset.fov, 1.6, 1);
    this._radiusTarget = 4;
    this._heightTarget = 1.5;
    this._first = true;
  }

  setPreset(name) {
    const p = ORBIT_PRESETS[name];
    if (!p) return this;
    this.name = name;
    this.preset = p;
    return this;
  }

  activate(ctx, fromPose = null) {
    this._first = true;
    this._resolve(ctx);
    // Enter from wherever the camera already is, so the menu never cuts.
    if (fromPose) {
      _eye.subVectors(fromPose.position, _focus);
      const r = Math.hypot(_eye.x, _eye.z);
      if (r > 1e-3) this.angle = Math.atan2(_eye.x, _eye.z);
      this.pos.snap(fromPose.position);
      this.fov.snap(fromPose.fov);
      this.look.snap(_focus);
    } else {
      this._place(0);
      this.pos.snap(_eye);
      this.look.snap(_look);
      this.fov.snap(this.preset.fov);
    }
    return this;
  }

  deactivate() { return this; }
  isDone() { return false; }
  snap() { this._first = true; return this; }

  /** Work out what we are orbiting and how big it is. */
  _resolve(ctx) {
    const p = this.preset;
    const cs = ctx?.carState;
    const track = ctx?.track ?? this.game?.track ?? null;
    const bounds = track?.environment?.bounds;

    if (cs?.valid) {
      _focus.copy(cs.position);
      _focus.y += 0.06;
      this._radiusTarget = clamp(1.25 * p.radiusScale * 3.2, p.minRadius, p.maxRadius);
      this._heightTarget = Math.max(p.minHeight, 0.42 * (1 + p.heightScale));
      if (this.name === 'orbit') {
        // Menu with a car present: pull back a bit so the track reads too.
        this._radiusTarget = clamp(3.4, p.minRadius, p.maxRadius);
        this._heightTarget = Math.max(p.minHeight, 1.1);
      }
      return;
    }

    if (bounds && bounds.isBox3 && !bounds.isEmpty()) {
      bounds.getCenter(_focus);
      bounds.getSize(_size);
      const extent = Math.max(_size.x, _size.z, 1);
      this._radiusTarget = clamp(extent * p.radiusScale, p.minRadius, p.maxRadius);
      this._heightTarget = clamp(
        Math.max(_size.y * 0.5, extent * p.heightScale), p.minHeight, p.maxRadius);
      _focus.y = bounds.min.y + Math.min(_size.y * 0.35, 3.0);
      return;
    }

    // Truly nothing loaded.
    _focus.set(0, 0.25, 0);
    this._radiusTarget = clamp(4.2, p.minRadius, p.maxRadius);
    this._heightTarget = Math.max(p.minHeight, 1.6);
  }

  /** Ideal eye/look for the current angle. Fills `_eye` and `_look`. */
  _place(dt) {
    const p = this.preset;
    const r = this.radius.value;
    const h = this.height.value;
    const bob = Math.sin(this.t * TAU * p.bobRate) * p.bob * (0.4 + h * 0.25);
    _eye.set(
      _focus.x + Math.sin(this.angle) * r,
      _focus.y + h + bob,
      _focus.z + Math.cos(this.angle) * r);
    _look.copy(_focus);
    _look.y += p.lookLift * (1 + h * 0.2);
    return _eye;
  }

  update(dt, ctx, out) {
    const p = this.preset;
    dt = clamp(dt, 0, 0.25);
    this.t += dt;
    this.angle += p.speed * dt;
    if (this.angle > Math.PI) this.angle -= TAU;

    this._resolve(ctx);

    if (this._first) {
      this.radius.snap(this._radiusTarget);
      this.height.snap(this._heightTarget);
      this._first = false;
    } else {
      this.radius.update(this._radiusTarget, dt, p.posOmega, 1);
      this.height.update(this._heightTarget, dt, p.posOmega, 1);
    }

    this._place(dt);
    // If we are orbiting a car that is actually moving, cancel the spring lag.
    const cs = ctx?.carState;
    if (cs?.valid && cs.horizontalSpeed > 0.4) {
      const cap = this.radius.value * 0.8;
      const ffE = lagCoefficient(p.posOmega * 2.2, 1, 0.9);
      const ffL = lagCoefficient(p.lookOmega, 1, 0.9);
      addLagCompensation(_eye, cs.velocity, ffE, ffE * 0.5, cap);
      addLagCompensation(_look, cs.velocity, ffL, ffL * 0.5, cap * 0.8);
    }
    this.pos.update(_eye, dt, p.posOmega * 2.2, 1);
    this.look.update(_look, dt, p.lookOmega, 1);

    const fovTarget = p.fov + Math.sin(this.t * TAU * p.fovRate) * p.fovBreathe;
    this.fov.update(fovTarget, dt, 1.6, 1);

    out.lookAt(this.pos.value, this.look.value, WORLD_UP, 0);
    out.fov = clamp(this.fov.value, 18, 100);
    out.shakeScale = p.shakeScale;
    out.dofIntensity = p.dof;
    out.focusDistance = Math.max(this.pos.value.distanceTo(this.look.value), 0.2);
    out.focusRange = p.focusRange;
    out.maxBlur = p.maxBlur;
    out.speedIntensity = 0;
    return out;
  }

  dispose() {}
}

export default OrbitCamera;
