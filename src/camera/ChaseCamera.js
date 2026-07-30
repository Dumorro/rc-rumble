/**
 * ChaseCamera — the money shot.
 *
 * Re-Volt's chase camera is a big part of why a 1.6 kg toy car feels good: it sits
 * LOW and CLOSE behind a tiny car, lags a beat behind it, and swings wide in
 * corners so you see the car's flank. Reproducing that is a stack of specific
 * behaviours, each of which is individually subtle and collectively the whole feel:
 *
 *  • **Critically-damped spring follow.** The anchor is a target, never a hard
 *    parent. Horizontal and vertical use different frequencies (see Vec3Spring.
 *    updateSplit) so a jump doesn't whip the camera skywards.
 *
 *  • **Velocity-heading yaw.** The camera yaw follows where the car is *going*,
 *    blended toward where it *points* by the drift factor. A car sideways at 30°
 *    of slip therefore stays in frame at an angle — this is what makes drifts
 *    read as drifts instead of as the camera losing the car.
 *
 *  • **Velocity lead on the aim point.** The look target is pushed along the
 *    velocity vector, so the camera looks into the corner before the car gets
 *    there.
 *
 *  • **Jump response.** Airborne, the rig backs off and lifts, and the aim point
 *    tracks vertical velocity, so the arc reads and the landing is visible.
 *
 *  • **Collision avoidance.** A sphere-cast from the car to the desired camera
 *    position pulls the camera in fast when a wall is behind it, and lets it back
 *    out slowly. A short downward ray keeps it out of the floor on steep climbs.
 *
 *  • **Speed FOV + corner roll.** fovBase + fovSpeedGain·speedFrac, a kick on
 *    boost, and up to ~4° of bank into corners.
 *
 * Presets reuse the same solver for chaseFar / bumper / cockpit / lookBack, so
 * every mode inherits the same lag, avoidance and FOV behaviour.
 *
 * Allocation free per frame.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, angleDelta, lerp } from '../core/MathUtils.js';
import { createRayHit, Layer } from '../physics/index.js';
import { CameraPose, WORLD_UP, dirFromYaw, framingUp, yawOf } from './CameraPose.js';
import {
  AngleSpring, Spring, Vec3Spring, approach, lagCoefficient, addLagCompensation,
} from './Spring.js';

const C = CONFIG.camera?.chase ?? {};

/**
 * Tuning. Distances in metres at 1:10 RC scale — `distance: 1.05` means the
 * camera sits ~3.5 car-lengths back, which is Re-Volt-close.
 */
export const CHASE_PRESETS = Object.freeze({
  chase: {
    label: 'Chase',
    distance: num(C.distance, 1.05),
    height: num(C.height, 0.42),
    lookAhead: num(C.lookAhead, 0.55),
    lookHeight: num(C.lookHeight, 0.10),
    side: 0,

    posOmega: num(C.posStiffness, 11.0),
    posOmegaV: 6.6,
    posZeta: num(C.posDamping, 1.0),
    posZetaV: 1.0,
    lookOmega: 15.0,
    yawOmega: num(C.rotStiffness, 8.0),
    yawZeta: 1.0,

    velocityLead: num(C.velocityLead, 0.16),
    /** How much of the spring's velocity lag to cancel (see Spring.lagCoefficient). */
    ff: 0.88,
    ffV: 0.55,
    ffLook: 0.92,
    baseVelYaw: 0.26,
    driftVelYaw: 0.62,
    maxYawOffset: 0.60,

    speedDistance: 0.30,
    speedHeight: 0.05,
    airDistance: 0.26,
    airHeight: 0.14,
    airLookLead: 0.10,
    pitchFromAir: num(C.pitchFromAir, 0.18),

    rollGain: 0.020,
    rollMax: 0.070,
    rollOmega: 5.0,

    fovBase: CONFIG.render.fovBase,
    fovGain: CONFIG.render.fovSpeedGain,
    fovBoost: 5.5,
    fovDrift: 2.0,
    fovRate: 4.2,

    upBlend: 0.30,
    collide: true,
    collideRadius: 0.10,
    minDistance: 0.30,
    floorClearance: 0.09,

    rigid: false,
    flip: false,
    shakeScale: 1.0,
    speedFx: 1.0,
  },

  chaseFar: {
    label: 'Chase (far)',
    distance: 1.78, height: 0.66, lookAhead: 0.80, lookHeight: 0.12, side: 0,
    posOmega: 8.5, posOmegaV: 5.4, posZeta: 1.0, posZetaV: 1.0,
    lookOmega: 12.0, yawOmega: 6.4, yawZeta: 1.0,
    velocityLead: 0.22, ff: 0.84, ffV: 0.50, ffLook: 0.90, baseVelYaw: 0.34, driftVelYaw: 0.66, maxYawOffset: 0.66,
    speedDistance: 0.46, speedHeight: 0.10, airDistance: 0.34, airHeight: 0.22,
    airLookLead: 0.12, pitchFromAir: 0.16,
    rollGain: 0.016, rollMax: 0.055, rollOmega: 4.4,
    fovBase: CONFIG.render.fovBase - 4, fovGain: CONFIG.render.fovSpeedGain * 0.85,
    fovBoost: 4.5, fovDrift: 1.6, fovRate: 3.8,
    upBlend: 0.22, collide: true, collideRadius: 0.12, minDistance: 0.45,
    floorClearance: 0.10,
    rigid: false, flip: false, shakeScale: 0.85, speedFx: 0.9,
  },

  /** Low nose cam. Bolted to the chassis — the road rush comes from the ride height. */
  bumper: {
    label: 'Bumper',
    distance: -0.150,      // negative ⇒ in FRONT of the car origin
    height: 0.040,
    lookAhead: 2.60, lookHeight: 0.070, side: 0,
    posOmega: 40, posOmegaV: 34, posZeta: 1.0, posZetaV: 1.0,
    lookOmega: 20.0, yawOmega: 26.0, yawZeta: 1.0,
    velocityLead: 0.10, ff: 1.0, ffV: 1.0, ffLook: 1.0, baseVelYaw: 0.10, driftVelYaw: 0.20, maxYawOffset: 0.24,
    speedDistance: 0.0, speedHeight: 0.0, airDistance: 0.0, airHeight: 0.0,
    airLookLead: 0.05, pitchFromAir: 0.05,
    rollGain: 0.034, rollMax: 0.105, rollOmega: 8.0,
    fovBase: CONFIG.render.fovBase + 10, fovGain: CONFIG.render.fovSpeedGain * 1.15,
    fovBoost: 6.5, fovDrift: 2.5, fovRate: 5.0,
    upBlend: 0.85, collide: false, collideRadius: 0.06, minDistance: 0,
    floorClearance: 0.025,
    rigid: true, flip: false, shakeScale: 1.5, speedFx: 1.25,
  },

  /** Driver's-eye view: higher than bumper, a hair behind the front axle. */
  cockpit: {
    label: 'Cockpit',
    distance: -0.010, height: 0.098, lookAhead: 2.20, lookHeight: 0.105, side: 0,
    posOmega: 44, posOmegaV: 38, posZeta: 1.0, posZetaV: 1.0,
    lookOmega: 22.0, yawOmega: 22.0, yawZeta: 1.0,
    velocityLead: 0.12, ff: 1.0, ffV: 1.0, ffLook: 1.0, baseVelYaw: 0.16, driftVelYaw: 0.34, maxYawOffset: 0.34,
    speedDistance: 0.0, speedHeight: 0.0, airDistance: 0.0, airHeight: 0.0,
    airLookLead: 0.06, pitchFromAir: 0.08,
    rollGain: 0.040, rollMax: 0.120, rollOmega: 7.0,
    fovBase: CONFIG.render.fovBase + 4, fovGain: CONFIG.render.fovSpeedGain,
    fovBoost: 6.0, fovDrift: 2.2, fovRate: 4.6,
    upBlend: 0.95, collide: false, collideRadius: 0.06, minDistance: 0,
    floorClearance: 0.03,
    rigid: true, flip: false, shakeScale: 1.35, speedFx: 1.15,
  },

  /** Hold-to-look-back: sits over the nose, aimed back down the track. */
  lookBack: {
    label: 'Look back',
    distance: 0.62, height: 0.30, lookAhead: 1.10, lookHeight: 0.10, side: 0,
    posOmega: 20, posOmegaV: 13, posZeta: 1.0, posZetaV: 1.0,
    lookOmega: 18.0, yawOmega: 16.0, yawZeta: 1.0,
    velocityLead: 0.0, ff: 0.94, ffV: 0.72, ffLook: 0.95, baseVelYaw: 0.0, driftVelYaw: 0.0, maxYawOffset: 0.0,
    speedDistance: 0.16, speedHeight: 0.02, airDistance: 0.10, airHeight: 0.08,
    airLookLead: 0.04, pitchFromAir: 0.06,
    rollGain: 0.010, rollMax: 0.030, rollOmega: 5.0,
    fovBase: CONFIG.render.fovBase + 6, fovGain: CONFIG.render.fovSpeedGain * 0.5,
    fovBoost: 2.0, fovDrift: 0, fovRate: 5.0,
    upBlend: 0.20, collide: true, collideRadius: 0.09, minDistance: 0.18,
    floorClearance: 0.07,
    rigid: false, flip: true, shakeScale: 0.9, speedFx: 0.8,
  },
});

function num(v, d) { return Number.isFinite(v) ? v : d; }

// ── module scratch ─────────────────────────────────────────────────────────
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _mount = new THREE.Vector3();
const _castDir = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _hit = createRayHit();
const _hit2 = createRayHit();
/** Statics + props, never cars — a rival car must not shove the camera about. */
const CAST_MASK = Layer.TRACK | Layer.PROP | Layer.DEFAULT;

export class ChaseCamera {
  /**
   * @param {import('./CameraDirector.js').CameraDirector} director
   * @param {keyof typeof CHASE_PRESETS} presetName
   */
  constructor(director, presetName = 'chase') {
    this.director = director;
    this.game = director?.game ?? null;
    this.name = presetName;
    this.preset = CHASE_PRESETS[presetName] ?? CHASE_PRESETS.chase;

    this.pos = new Vec3Spring(this.preset.posOmega, this.preset.posZeta);
    this.look = new Vec3Spring(this.preset.lookOmega, 1.0);
    this.yaw = new AngleSpring(0, this.preset.yawOmega, this.preset.yawZeta);
    this.fov = new Spring(this.preset.fovBase, this.preset.fovRate, 1);
    this.roll = new Spring(0, this.preset.rollOmega, 1.0);

    /** 0..1 airborne blend, rises with air time and falls after landing. */
    this.airFrac = 0;
    /** 0..1 occlusion pull-in. 1 = free, 0 = camera jammed against the car. */
    this.occ = 1;
    /** Extra lift applied to stay above the floor. */
    this.floorLift = 0;
    this._seeded = false;
    this._lastDist = this.preset.distance;
  }

  setPreset(name) {
    const p = CHASE_PRESETS[name];
    if (!p) return this;
    this.name = name;
    this.preset = p;
    this.pos.omega = p.posOmega; this.pos.zeta = p.posZeta;
    this.look.omega = p.lookOmega;
    this.yaw.omega = p.yawOmega; this.yaw.zeta = p.yawZeta;
    this.roll.omega = p.rollOmega;
    return this;
  }

  // ───────────────────────────────────────────────────────────── lifecycle

  /**
   * @param {object} ctx director frame context
   * @param {CameraPose} [fromPose] the pose we are blending out of, for continuity
   */
  activate(ctx, fromPose = null) {
    const cs = ctx?.carState;
    const p = this.preset;
    this.airFrac = 0;
    this.occ = 1;
    this.floorLift = 0;

    if (cs?.valid) {
      // Snap straight to the settled pose. The director cross-fades from the
      // outgoing rig's *live* pose, so seeding this rig with lag as well would
      // double up the smoothing and make every camera change feel mushy.
      this.snap(ctx);
    } else if (fromPose) {
      // No car (menu, between races): inherit the current framing and hold it.
      this.pos.snap(fromPose.position);
      this.fov.snap(fromPose.fov);
      this.roll.snap(fromPose.roll || 0);
      _tmp.set(0, 0, -1).applyQuaternion(fromPose.quaternion)
        .multiplyScalar(Math.max(p.lookAhead + p.distance, 0.5)).add(fromPose.position);
      this.look.snap(_tmp);
    } else {
      this.snap(ctx);
    }
    this._seeded = true;
    return this;
  }

  deactivate() { return this; }

  /** Hard reset behind the car (race start, respawn, teleport). */
  snap(ctx) {
    const cs = ctx?.carState;
    const p = this.preset;
    if (!cs?.valid) {
      this.pos.snap(_tmp.set(0, p.height + 0.6, p.distance + 1.4));
      this.look.snapZero();
      this.fov.snap(p.fovBase);
      this.roll.snap(0);
      return this;
    }
    const base = yawOf(cs.forward.x, cs.forward.z);
    this.yaw.snap(p.flip ? base + Math.PI : base);
    framingUp(_up, cs.up, p.upBlend);
    dirFromYaw(this.yaw.value, _dir);

    if (p.rigid) {
      this._rigidMount(cs, _anchor);
    } else {
      _anchor.copy(cs.position).addScaledVector(_up, p.height).addScaledVector(_dir, -p.distance);
    }
    this.pos.snap(_anchor);

    _look.copy(cs.position).addScaledVector(_up, p.lookHeight).addScaledVector(_dir, p.lookAhead);
    this.look.snap(_look);
    this.fov.snap(p.fovBase);
    this.roll.snap(0);
    this.airFrac = 0;
    this.occ = 1;
    this.floorLift = 0;
    return this;
  }

  isDone() { return false; }

  // ───────────────────────────────────────────────────────────── per frame

  /**
   * @param {number} dt simulated seconds (0 while paused)
   * @param {object} ctx { game, car, carState, track, physics, time }
   * @param {CameraPose} out
   */
  update(dt, ctx, out) {
    const p = this.preset;
    const cs = ctx.carState;
    dt = clamp(dt, 0, 0.25);

    if (!cs || !cs.valid) {
      // No car: hold position, keep aiming at whatever we were aiming at. The
      // director normally swaps to the orbit rig long before this matters.
      out.position.copy(this.pos.value);
      out.lookAt(this.pos.value, this.look.value, WORLD_UP, this.roll.value);
      out.fov = this.fov.update(p.fovBase, dt, p.fovRate, 1);
      out.shakeScale = p.shakeScale;
      out.speedIntensity = 0;
      return out;
    }

    // ── 1. airborne blend ───────────────────────────────────────────────────
    // Ramps in over ~0.35 s of air and bleeds out over ~0.5 s after landing, so
    // clipping a kerb does not move the camera at all but a real jump does.
    const airTarget = cs.airborne ? clamp01(cs.airTime / 0.35) : 0;
    this.airFrac = approach(this.airFrac, airTarget, cs.airborne ? 7.0 : 3.2, dt);
    const air = this.airFrac;

    // ── 2. yaw: velocity heading blended with facing by drift ───────────────
    const facingYaw = yawOf(cs.forward.x, cs.forward.z);
    let targetYaw = facingYaw;
    if (!p.flip && p.maxYawOffset > 0 && cs.horizontalSpeed > 0.55 && !cs.reversing) {
      const travelYaw = yawOf(cs.travel.x, cs.travel.z);
      const w = clamp01((cs.horizontalSpeed - 0.4) / 2.2)
        * (p.baseVelYaw + p.driftVelYaw * cs.driftFactor)
        * (1 - air * 0.55);
      const d = clamp(angleDelta(facingYaw, travelYaw) * w, -p.maxYawOffset, p.maxYawOffset);
      targetYaw = facingYaw + d;
    }
    if (p.flip) targetYaw = facingYaw + Math.PI;

    // Airborne, the car's own yaw is meaningless (it spins freely) — freeze onto
    // the flight direction so the camera does not pirouette mid-jump.
    const yawOmega = p.yawOmega * (1 - air * 0.55) * (cs.upsideDown ? 0.5 : 1);
    this.yaw.update(targetYaw, dt, Math.max(yawOmega, 0.8), p.yawZeta);
    dirFromYaw(this.yaw.value, _dir);

    // ── 3. framing basis ────────────────────────────────────────────────────
    framingUp(_up, cs.up, p.upBlend * (1 - air * 0.6));

    // ── 4. desired anchor ───────────────────────────────────────────────────
    let dist = p.distance + p.speedDistance * cs.speedFrac + p.airDistance * air;
    const height = p.height + p.speedHeight * cs.speedFrac + p.airHeight * air;

    if (p.rigid) {
      this._rigidMount(cs, _anchor);
    } else {
      // Trail the car along the chase direction, lifted along the framing up.
      _anchor.copy(cs.position)
        .addScaledVector(_up, height)
        .addScaledVector(_dir, -dist);

      // A touch of lateral offset in a drift shows the car's flank. Tiny, but it
      // is the difference between "watching a car" and "riding behind one".
      if (p.side !== 0 || cs.driftFactor > 0.02) {
        const side = p.side + Math.sin(clamp(cs.slipAngle, -1.2, 1.2)) * cs.driftFactor * 0.10;
        _tmp.set(-_dir.z, 0, _dir.x);            // right of the chase direction
        _anchor.addScaledVector(_tmp, side);
      }

      // ── 5. collision avoidance ────────────────────────────────────────────
      if (p.collide) dist = this._avoid(ctx, cs, _anchor, dist, dt);
    }

    // ── 6. spring the position ──────────────────────────────────────────────
    // In the air, loosen everything: the camera should feel like it is being
    // dragged along on a bungee, not bolted to the car.
    const oh = p.rigid ? p.posOmega : p.posOmega * (1 - air * 0.28);
    const ov = p.rigid ? p.posOmegaV : p.posOmegaV * (1 - air * 0.42);

    // Velocity feed-forward. Without this the spring sits 2ζv/ω behind its
    // anchor — 1.45 m at 8 m/s, which would silently double the chase distance
    // and defeat the collision pull-in. `ff` < 1 leaves a deliberate trail.
    _tmp.copy(_anchor);
    // The cap is a sanity rail against a physics blow-up, NOT a tuning knob: it
    // must not scale with the pulled-in distance, or the compensation gets
    // truncated exactly when the camera is hugging a wall and needs it most.
    addLagCompensation(_tmp, cs.velocity,
      lagCoefficient(oh, p.posZeta, p.ff),
      lagCoefficient(ov, p.posZetaV, p.ffV),
      Math.max(Math.abs(p.distance) + p.speedDistance, 0.55) * 2.5);
    this.pos.updateSplit(_tmp, dt, oh, ov, p.posZeta, p.posZetaV);

    // ── 7. keep out of the floor ────────────────────────────────────────────
    this._floor(ctx, dt);
    _tmp2.copy(this.pos.value);
    _tmp2.y += this.floorLift;

    // ── 8. aim point ────────────────────────────────────────────────────────
    _look.copy(cs.position).addScaledVector(_up, p.lookHeight);
    // Look where the car is *going*.
    if (p.velocityLead > 0) {
      _tmp.copy(cs.velocity);
      _tmp.y *= 0.35;
      const l = _tmp.length();
      const maxLead = p.lookAhead * 1.6;
      const lead = Math.min(l * p.velocityLead, maxLead);
      if (l > 1e-4) _look.addScaledVector(_tmp, lead / l);
    }
    _look.addScaledVector(_dir, p.lookAhead * (p.flip ? 1 : (0.55 + 0.45 * cs.speedFrac)));
    // Jump framing: follow the arc so the car never leaves the top or bottom of
    // the frame, and tip down as it falls so the landing is visible.
    if (air > 0.001) {
      const vy = clamp(cs.velocity.y, -9, 9);
      _look.y += vy * p.airLookLead * air;
      _look.lerp(cs.position, p.pitchFromAir * air * clamp01(-vy / 4 + 0.35));
    }
    const ol = p.lookOmega * (1 - air * 0.25);
    const kl = lagCoefficient(ol, 1, p.ffLook);
    addLagCompensation(_look, cs.velocity, kl, kl * 0.7, p.lookAhead * 2.0 + 0.8);
    this.look.update(_look, dt, ol, 1.0);

    // ── 9. roll into the corner ─────────────────────────────────────────────
    let rollTarget = 0;
    if (p.rollGain > 0) {
      const lat = clamp(cs.lateralG, -3.5, 3.5);
      const steer = Number.isFinite(cs.car?.steer) ? cs.car.steer : 0;
      rollTarget = clamp(
        -(lat * p.rollGain + steer * cs.speedFrac * p.rollGain * 0.55) * (1 - air * 0.8),
        -p.rollMax, p.rollMax);
    }
    this.roll.update(rollTarget, dt, p.rollOmega, 1.0);

    // ── 10. FOV ─────────────────────────────────────────────────────────────
    // The contract is literally CONFIG.render.fovBase + fovSpeedGain·speedFrac;
    // boost/drift/air ride on top, and the sum is capped so the lens cannot go
    // full fish-eye when they all land at once.
    const fovTarget = Math.min(
      p.fovBase
        + p.fovGain * cs.speedFrac
        + p.fovBoost * clamp01(cs.boost * 3)
        + p.fovDrift * cs.driftFactor
        + air * 1.5,
      p.fovBase + p.fovGain + 8);
    this.fov.update(fovTarget, dt, p.fovRate, 1.0);

    // ── 11. commit ──────────────────────────────────────────────────────────
    out.lookAt(_tmp2, this.look.value, _up, this.roll.value);
    out.fov = clamp(this.fov.value, 20, 120);
    out.shakeScale = p.shakeScale;
    out.dofIntensity = 0;
    out.focusDistance = 0;
    out.speedIntensity = clamp01(
      (cs.speedFrac * 0.82 + cs.driftFactor * 0.18 + cs.boost * 0.25) * p.speedFx);
    return out;
  }

  // ───────────────────────────────────────────────────────────── internals

  /**
   * Rigid mount point (bumper/cockpit) in world space, from the car's own basis.
   * The mount is chassis-local with -Z forward, so `z = +distance` is behind the
   * origin and the negative `distance` of the bumper preset puts it on the nose.
   * A vehicle can override the offsets via `car.def.cameraMounts[modeName]`.
   */
  _rigidMount(cs, out) {
    const p = this.preset;
    const m = cs.car?.def?.cameraMounts?.[this.name];
    if (m) {
      _mount.set(num(m.x, p.side), num(m.y, p.height), num(m.z, p.distance));
    } else {
      _mount.set(p.side, p.height, p.distance);
    }
    out.copy(cs.position)
      .addScaledVector(cs.right, _mount.x)
      .addScaledVector(cs.up, _mount.y)
      .addScaledVector(cs.forward, -_mount.z);
    return out;
  }

  /**
   * Sphere-cast from the car to the desired camera position; if a wall is in the
   * way, pull the camera in. Attack is fast (you must never see through a wall),
   * release is slow (so a passing pillar does not yo-yo the camera).
   * @returns {number} the (possibly shortened) chase distance
   */
  _avoid(ctx, cs, anchor, dist, dt) {
    const p = this.preset;
    const physics = ctx.physics;
    let allowed = 1;

    if (physics && physics.trackMesh && dist > 0.02) {
      // Start the cast HALF WAY up to the camera height, not at the car's centre:
      // a 10 cm sweep sphere launched 5 cm above an RC car's origin is already
      // intersecting the floor, and an initial-overlap hit would report t≈0 and
      // slam the camera into the car's boot.
      _tmp.copy(cs.position)
        .addScaledVector(WORLD_UP, clamp(p.height * 0.5, 0.05, 0.30));
      _castDir.subVectors(anchor, _tmp);
      const len = _castDir.length();
      if (len > 1e-4) {
        _castDir.multiplyScalar(1 / len);
        let blocked = len;
        try {
          if (physics.sphereCast(_tmp, _castDir, p.collideRadius, len, _hit, CAST_MASK)) {
            // A t≈0 hit means we started inside geometry: not actionable, ignore it
            // rather than yanking the camera onto the car.
            if (_hit.distance > 0.02) blocked = _hit.distance;
          }
        } catch (err) { blocked = len; }
        if (blocked < len - 1e-4) {
          const minD = Math.max(p.minDistance, 0.05);
          allowed = clamp01((Math.max(blocked, minD)) / len);
        }
      }
    }

    // Fast in, slow out.
    this.occ = approach(this.occ, allowed, allowed < this.occ ? 26 : 3.4, dt);
    const occ = clamp(this.occ, 0.001, 1);
    if (occ < 0.999) {
      // Re-derive the anchor at the shortened distance instead of lerping toward
      // the car, so the height/side offsets survive the pull-in.
      const newDist = Math.max(dist * occ, p.minDistance * 0.5);
      _tmp2.subVectors(anchor, cs.position);
      const shrink = dist > 1e-4 ? clamp01(newDist / dist) : 1;
      // Horizontal shrinks; vertical *grows* a little. Pinned against a wall the
      // camera should climb and look down over the car, not sink into the floor.
      const lift = lerp(1, 1.30, 1 - shrink);
      anchor.set(
        cs.position.x + _tmp2.x * shrink,
        cs.position.y + _tmp2.y * lift,
        cs.position.z + _tmp2.z * shrink);
      this._lastDist = newDist;
      return newDist;
    }
    this._lastDist = dist;
    return dist;
  }

  /** Short downward ray under the camera; lift it out of the floor if needed. */
  _floor(ctx, dt) {
    const p = this.preset;
    const physics = ctx.physics;
    let want = 0;
    if (physics && physics.trackMesh && p.floorClearance > 0) {
      _tmp.copy(this.pos.value);
      _tmp.y += 0.55;
      let hitOk = false;
      try { hitOk = physics.raycastTrack(_tmp, _down, 0.55 + p.floorClearance + 0.35, _hit2); }
      catch (err) { hitOk = false; }
      if (hitOk) {
        const groundY = _hit2.point.y;
        const need = groundY + p.floorClearance - this.pos.value.y;
        if (need > 0) want = Math.min(need, 1.2);
      }
    }
    this.floorLift = approach(this.floorLift, want, want > this.floorLift ? 22 : 5, dt);
    if (this.floorLift < 1e-4) this.floorLift = 0;
    return this.floorLift;
  }

  /**
   * The un-sprung "ideal" pose for this preset — where the camera *would* be if
   * it had settled. The intro flyby uses this to land exactly on the chase pose,
   * and the finish cam uses it for continuity.
   * @param {object} ctx
   * @param {CameraPose} out
   */
  sampleIdeal(ctx, out) {
    const p = this.preset;
    const cs = ctx?.carState;
    if (!cs?.valid) {
      out.position.set(0, p.height + 0.8, p.distance + 1.6);
      out.lookAt(out.position, ZERO_V, WORLD_UP, 0);
      out.fov = p.fovBase;
      return out;
    }
    const base = yawOf(cs.forward.x, cs.forward.z);
    dirFromYaw(p.flip ? base + Math.PI : base, _dir);
    framingUp(_up, cs.up, p.upBlend);
    const dist = p.distance + p.speedDistance * cs.speedFrac;
    const height = p.height + p.speedHeight * cs.speedFrac;
    _anchor.copy(cs.position).addScaledVector(_up, height).addScaledVector(_dir, -dist);
    _look.copy(cs.position).addScaledVector(_up, p.lookHeight)
      .addScaledVector(_dir, p.lookAhead * 0.7);
    out.lookAt(_anchor, _look, _up, 0);
    out.fov = p.fovBase + p.fovGain * cs.speedFrac;
    out.shakeScale = p.shakeScale;
    out.dofIntensity = 0;
    out.focusDistance = 0;
    out.speedIntensity = cs.speedFrac;
    return out;
  }

  dispose() {}
}

const ZERO_V = Object.freeze(new THREE.Vector3());

export default ChaseCamera;
