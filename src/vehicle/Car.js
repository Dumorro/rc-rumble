/**
 * RC RUMBLE — Car.
 *
 * Implements the `Car` contract in ARCHITECTURE.md exactly. Every telemetry
 * field is live at the end of every `fixedUpdate`, because the camera, FX,
 * audio, UI, race and pickup systems are all written against them.
 *
 * Composition
 * -----------
 *   body          RigidBody          — the ONLY authoritative state
 *   wheels[4]     Wheel              — FL, FR, RL, RR
 *   suspension    Suspension         — casts, springs, dampers, ARBs
 *   drivetrain    Drivetrain         — engine, gearbox, diff, brakes
 *   aero          AeroBody           — drag, downforce, airborne authority
 *   wheels[i].tire  Tire             — Pacejka-style contact patch
 *   group         THREE.Group        — interpolated visual root (never read for logic)
 *
 * Step order inside `fixedUpdate` (this order matters):
 *
 *   1. tick gameplay effect timers
 *   2. steering rack (speed-sensitive limit + Ackermann + rate limit)
 *   3. suspension: cast, spring/damper/ARB, apply normal loads
 *   4. drivetrain: engine → gearbox → diff → per-wheel drive & brake torque
 *   5. per wheel: tyre forces from the *current* load, implicit spin integration,
 *      apply Fx at the patch and Fy slightly raised toward the COM
 *   6. aero + airborne attitude control + counter-steer assist
 *   7. telemetry
 *
 * Nothing in here allocates.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp, damp, moveToward, sign } from '../core/MathUtils.js';
import { RigidBody, Layer, makeHull, createRayHit, SURFACE_FRICTION } from '../physics/index.js';

import { Suspension } from './Suspension.js';
import { Drivetrain } from './Drivetrain.js';
import { AeroBody } from './AeroBody.js';
import { Tire } from './Tire.js';
import { DISPLAY_SPEED_SCALE } from './CarDefs.js';

// ═══════════════════════════════════════════════════════════════════════════
// Scratch
// ═══════════════════════════════════════════════════════════════════════════

const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _patch = new THREE.Vector3();
const _f = new THREE.Vector3();
const _p = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _vLocal = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * Handling multipliers when the gameplay layer is absent (a car spawned outside
 * a race, or gameplay disabled). Same shape as `car.effectMods`, all neutral.
 */
const NEUTRAL_MODS = Object.freeze({
  grip: 1, torque: 1, steer: 1, brake: 1, maxSpeed: 1, downforce: 1, antiRoll: 1,
});

/** Wheels must be off the ground this long before we call it "airborne". */
const AIR_GRACE = 0.075;
/** Free-spinning wheel bearing drag (N·m per rad/s) while off the ground. */
const AIR_SPIN_DRAG = 3.0e-5;
/** Visual exaggeration caps (rad / m). */
const VIS_ROLL_MAX = 0.155;
const VIS_PITCH_MAX = 0.130;

/** Per-surface rolling-resistance multipliers (canonical ids 0..15). */
export const SURFACE_ROLL = new Float32Array([
  1.00, // 0  default
  1.00, // 1  wood
  3.00, // 2  carpet
  0.92, // 3  tile
  1.20, // 4  concrete
  3.40, // 5  grass
  3.00, // 6  dirt
  3.80, // 7  gravel
  5.20, // 8  sand
  4.50, // 9  water_shallow
  0.55, // 10 ice
  0.95, // 11 metal
  1.00, // 12 plastic
  1.45, // 13 rubber
  0.90, // 14 glass
  0.40, // 15 oil_slick
]);

let _nextCarId = 0;

// ═══════════════════════════════════════════════════════════════════════════
// Wheel
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One corner. Field names follow the `Wheel` contract in ARCHITECTURE.md; the
 * extras below it are the vehicle system's own working state.
 */
export class Wheel {
  /** @param {Car} car @param {number} index 0=FL 1=FR 2=RL 3=RR */
  constructor(car, index) {
    const def = car.def;
    this.car = car;
    this.index = index;
    this.isFront = index < 2;
    this.isLeft = (index & 1) === 0;
    /** −1 for the left-hand wheels, +1 for the right. */
    this.side = this.isLeft ? -1 : 1;
    this.isDriven = !!def.driven[index];
    this.isSteered = this.isFront;

    const a = def.wheelAnchors[index];
    /** Chassis-local suspension anchor (strut top). */
    this.restPosition = new THREE.Vector3(a[0], a[1], a[2]);
    this.radius = def.tyre.radius;
    this.width = def.tyre.width;

    // ── contract state ────────────────────────────────────────────────
    this.compression = 0;
    this.prevCompression = 0;
    this.suspensionForce = 0;
    this.contact = false;
    this.contactPoint = new THREE.Vector3();
    this.contactNormal = new THREE.Vector3(0, 1, 0);
    this.surfaceId = 0;
    this.angularVelocity = 0;
    this.rotation = 0;
    this.steerAngle = 0;
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.load = 0;
    this.lateralForce = 0;
    this.longitudinalForce = 0;
    this.isSpinning = false;
    this.isLocked = false;
    this.skidIntensity = 0;
    /** @type {THREE.Object3D|null} set by CarBodies via CarSystem */
    this.mesh = null;

    // ── working state ─────────────────────────────────────────────────
    this.tire = new Tire(def, this.isFront);
    /** Reused ray/sphere hit — never allocate in the cast loop. */
    this.hit = createRayHit();
    this.anchorWorld = new THREE.Vector3();
    /** Chassis-local hub position, seeded at the static ride height. */
    this.hubLocal = new THREE.Vector3().copy(this.restPosition);
    this.hubLocal.y -= def.susp.restLength
      - (this.isFront ? def.susp.staticCompFront : def.susp.staticCompRear);
    this.hubWorld = new THREE.Vector3();
    this.groundForward = new THREE.Vector3(0, 0, -1);
    this.groundRight = new THREE.Vector3(1, 0, 0);
    this.compressionLength = 0;
    this.prevCompressionLength = 0;
    this.compressionVel = 0;
    this.contactDepth = 0;
    this.contactBody = null;
    this.camber = 0;
    this.driveTorque = 0;
    this.brakeTorque = 0;
    this.surfaceGrip = 1;
    this.surfaceRoll = 1;
    /** Patch velocities in the wheel's ground frame (m/s). */
    this.patchLong = 0;
    this.patchLat = 0;
    /** Edge flags consumed once per step by CarSystem for EventBus emission. */
    this.contactBegan = false;
    this.contactEnded = false;
    this.surfaceChanged = false;
    this.wasContact = false;
    this._lastSurface = -1;
  }

  /** Rolling speed at the contact patch implied by the wheel's spin (m/s). */
  get rollSpeed() { return this.angularVelocity * this.radius; }

  reset() {
    this.compression = 0; this.prevCompression = 0;
    this.compressionLength = 0; this.prevCompressionLength = 0;
    this.compressionVel = 0; this.contactDepth = 0;
    this.suspensionForce = 0; this.load = 0;
    this.contact = false; this.wasContact = false;
    this.contactBegan = false; this.contactEnded = false; this.surfaceChanged = false;
    this.angularVelocity = 0; this.rotation = 0; this.steerAngle = 0;
    this.slipRatio = 0; this.slipAngle = 0;
    this.lateralForce = 0; this.longitudinalForce = 0;
    this.isSpinning = false; this.isLocked = false; this.skidIntensity = 0;
    this.driveTorque = 0; this.brakeTorque = 0;
    this.camber = 0; this.patchLong = 0; this.patchLat = 0;
    this._lastSurface = -1;
    this.tire.reset();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Car
// ═══════════════════════════════════════════════════════════════════════════

export class Car {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {object} def CarDef from CarDefs.js
   * @param {{ id?:number, isPlayer?:boolean, position?:THREE.Vector3,
   *           quaternion?:THREE.Quaternion, name?:string,
   *           colorPrimary?:number, colorSecondary?:number }} [opts]
   */
  constructor(game, def, opts = {}) {
    this.game = game;
    this.def = def;
    this.id = opts.id ?? _nextCarId++;
    this.isPlayer = !!opts.isPlayer;
    this.name = opts.name ?? def.name;
    /** Livery overrides (the field re-colours duplicates of the same car). */
    this.colorPrimary = opts.colorPrimary ?? def.colorPrimary;
    this.colorSecondary = opts.colorSecondary ?? def.colorSecondary;

    // ── rigid body ────────────────────────────────────────────────────
    this.body = new RigidBody({
      collider: makeHull(chassisHullPoints(def)),
      mass: def.mass,
      position: opts.position ?? new THREE.Vector3(0, def.comHeight + 0.02, 0),
      quaternion: opts.quaternion ?? undefined,
      layer: Layer.CAR,
      mask: Layer.ALL,
      friction: def.chassis === 'metal' ? 0.34 : def.chassis === 'glass' ? 0.26 : 0.42,
      restitution: def.chassis === 'glass' ? 0.22 : def.chassis === 'metal' ? 0.14 : 0.10,
      linearDamping: 0.008,
      angularDamping: 0.10,
      allowSleep: false,
      /**
       * Continuous collision. This was OFF for a while, for a good reason that
       * has since been fixed at source — read both halves before touching it.
       *
       * WHY IT WAS OFF: `PhysicsWorld._applyCCD` used to sweep a sphere of
       * `0.6 × boundingRadius` (0.10 m for these hulls) from the body's
       * previous position. A car's COM sits 21-72 mm above the road, so that
       * sphere was already inside the floor before the sweep began — it
       * reported a hit at distance 0, the body was snapped back to
       * `prevPosition`, and the car froze solid at speed with its velocity
       * intact. Measured: needle and phantom locked up for 758 of 1200 steps.
       *
       * WHY IT IS BACK ON: that was a real invariant violation in the engine
       * (CCD placing a body BEHIND where the step started), not a reason to
       * skip CCD. `_applyCCD` now sizes its sweep from the collider's smallest
       * half-extent so the sphere fits inside the shape, treats a hit at
       * distance ≈ 0 as "the discrete solver already owns this contact", and
       * refuses to move a body backwards past its step start.
       *
       * WHY IT IS NEEDED: the suspension's `MAX_PREDICT_LIFT` caps at 0.10 m
       * while the per-step fall keeps growing, so it stops covering the gap at
       * ~12 m/s. Measured with a real car, suspension running, ccd off: holds a
       * thin platform at 8 and 12 m/s, falls clean through at 16, 20, 24, 32
       * and 48, ending 58 m below the world. At 2g, 16 m/s is a 6.5 m fall —
       * a museum shelf. With ccd on it holds every one of those.
       *
       * Known limit, accepted: a horizontal wall charge at exactly 20 m/s still
       * passes through. That is twice the fastest car's top speed and only
       * reachable via a weapon impulse, and ccd-on is never worse than ccd-off
       * at any speed tested. Strict improvement, not a guarantee.
       */
      ccd: true,
      userData: this,
      name: `car:${def.id}:${this.id}`,
    });
    this.body.setInertiaLocal(def.inertia[0], def.inertia[1], def.inertia[2]);
    // Safety nets, not gameplay limits. A car in a bad contact sandwich can be
    // launched by the solver; these keep such a moment merely funny instead of
    // sending the camera to orbit. Both sit far above anything driving or a big
    // jump can reach (terminal velocity off a 5 m drop at 2 g is ~14 m/s).
    this.body.maxAngularSpeed = 18;
    this.body.maxLinearSpeed = clamp(def.topSpeed * 2.8, 18, 34);

    // ── visual root ───────────────────────────────────────────────────
    this.group = new THREE.Group();
    this.group.name = `car:${def.id}:${this.id}`;
    this.group.matrixAutoUpdate = true;
    /** Set by CarSystem after CarBodies builds the model. */
    this.model = null;
    /** Child of `group`; carries the visual roll/pitch/squat exaggeration. */
    this.shell = null;

    // ── subsystems ────────────────────────────────────────────────────
    /** @type {Wheel[]} FL, FR, RL, RR */
    this.wheels = [new Wheel(this, 0), new Wheel(this, 1), new Wheel(this, 2), new Wheel(this, 3)];
    this.suspension = new Suspension(this);
    this.drivetrain = new Drivetrain(this);
    this.aero = new AeroBody(this);

    // ── control ───────────────────────────────────────────────────────
    /** What the player / AI wants. Write via `applyControl`. */
    this.control = {
      throttle: 0, brake: 0, steer: 0, handbrake: 0,
      fire: false, lookBack: false, reset: false,
    };
    /** Edge-triggered fire request. `consumeFire()` reads and clears it. */
    this._fireRequest = false;
    /** True while the countdown holds the field. */
    this.launchLocked = false;
    /** Master control gate — respawn / finish sequences use it. */
    this.controlEnabled = true;
    /** Steering rack angle before Ackermann (rad). */
    this.rackAngle = 0;

    // ── contract telemetry ────────────────────────────────────────────
    this.speed = 0;
    this.speedKmh = 0;
    this.rpm = def.idleRpm;
    this.gear = 1;
    this.engineLoad = 0;
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = 0;
    this.slipAngle = 0;
    this.driftFactor = 0;
    this.lateralG = 0;
    this.longitudinalG = 0;
    this.wheelsOnGround = 0;
    this.airborne = false;
    this.airTime = 0;
    this.lastLandImpact = 0;
    this.upsideDown = false;
    this.stuckTime = 0;
    this.dominantSurfaceId = 0;

    // ── race state (owned by RaceSystem, initialised here) ────────────
    this.lap = 0;
    this.checkpoint = 0;
    this.place = this.id + 1;
    this.progress = 0;
    this.lapTime = 0;
    this.bestLap = Infinity;
    this.totalTime = 0;
    this.finished = false;
    this.wrongWay = false;

    // ── gameplay (owned by PickupSystem; Car ticks the timers) ────────
    this.weapon = null;
    this.effects = { boost: 0, frozen: 0, shielded: 0, squashed: 0, electro: 0, oiled: 0 };
    /** Seconds of post-respawn invulnerability left. */
    this.invulnerable = 0;

    // ── extra telemetry other systems find useful ────────────────────
    /** Signed lateral velocity in the chassis frame (m/s). */
    this.lateralSpeed = 0;
    /** Max skid intensity across the four tyres, 0..1. */
    this.skid = 0;
    /** Max skid intensity of the rear pair — the drift signal. */
    this.rearSkid = 0;
    /** Yaw rate (rad/s, + = turning left). */
    this.yawRate = 0;
    /** Chassis pitch / roll relative to the horizon (rad). */
    this.pitchAngle = 0;
    this.rollAngle = 0;
    /** Sum of tyre longitudinal forces (N) — thrust telemetry. */
    this.tractionForce = 0;
    /** 0..1 how close the tyres are to letting go (max saturation). */
    this.gripUsage = 0;
    /** Set for one step on landing / take-off — CarSystem turns them into events. */
    this.landedThisStep = false;
    this.tookOffThisStep = false;
    /** Peak downward speed reached during the current air phase (m/s). */
    this.airFallSpeed = 0;
    /** Height gained above the take-off point during the current air phase (m). */
    this.airHeight = 0;
    /** Time since the car was last considered "in a normal driving state". */
    this.offTrackTime = 0;
    /** Total distance travelled (m) — used by AI stuck detection and stats. */
    this.odometer = 0;

    // ── grip tables (CarSystem swaps these in from TrackData.surfaces) ─
    this.gripTable = SURFACE_FRICTION;
    this.rollTable = SURFACE_ROLL;

    // ── internals ─────────────────────────────────────────────────────
    this._prevVel = new THREE.Vector3();
    this._accelSmoothed = new THREE.Vector3();
    this._airTimer = 0;
    this._airStartY = 0;
    this._alive = true;
    this._driftEmitTimer = 0;

    this.body.setTransform(this.body.position, this.body.quaternion);
  }

  // ═════════════════════════════════════════════════════════ control

  /**
   * Write desired controls. Accepts an `InputState` or any subset of
   * `{ throttle, brake, steer, handbrake, fire, lookBack, reset }`.
   * @param {object} input
   */
  applyControl(input) {
    if (!input) return;
    const c = this.control;
    if (input.throttle !== undefined) c.throttle = clamp01(input.throttle);
    if (input.brake !== undefined) c.brake = clamp01(input.brake);
    if (input.steer !== undefined) c.steer = clamp(input.steer, -1, 1);
    if (input.handbrake !== undefined) c.handbrake = clamp01(input.handbrake);
    if (input.lookBack !== undefined) c.lookBack = !!input.lookBack;
    if (input.reset !== undefined) c.reset = !!input.reset;
    if (input.fire !== undefined) {
      if (input.fire && !c.fire) this._fireRequest = true;
      c.fire = !!input.fire;
    }
  }

  /** Zero the controls (countdown, respawn, finish). */
  clearControl() {
    const c = this.control;
    c.throttle = 0; c.brake = 0; c.steer = 0; c.handbrake = 0;
    c.fire = false; c.lookBack = false; c.reset = false;
    this._fireRequest = false;
  }

  /**
   * Edge-triggered "wants to fire" flag. PickupSystem should poll this once per
   * step; it is set by both the player input and the AI.
   * @returns {boolean}
   */
  consumeFire() {
    const f = this._fireRequest;
    this._fireRequest = false;
    return f;
  }

  /** Request a fire on behalf of the AI. */
  requestFire() { this._fireRequest = true; }

  // ═════════════════════════════════════════════════════════ simulation

  /** @param {number} dt always CONFIG.physics.fixedDt */
  fixedUpdate(dt) {
    const body = this.body;
    if (!body || !this._alive) return;

    // ── 1. effect timers ───────────────────────────────────────────────
    const e = this.effects;
    if (e.boost > 0) e.boost = Math.max(0, e.boost - dt);
    if (e.frozen > 0) e.frozen = Math.max(0, e.frozen - dt);
    if (e.shielded > 0) e.shielded = Math.max(0, e.shielded - dt);
    if (e.squashed > 0) e.squashed = Math.max(0, e.squashed - dt);
    if (e.electro > 0) e.electro = Math.max(0, e.electro - dt);
    if (e.oiled > 0) e.oiled = Math.max(0, e.oiled - dt);
    if (this.invulnerable > 0) this.invulnerable = Math.max(0, this.invulnerable - dt);

    // Effective inputs after gameplay effects.
    const c = this.control;
    const live = this.controlEnabled;
    const electro = e.electro > 0;
    // `car.effectMods` is the SINGLE channel through which gameplay modulates
    // handling: grip, torque, steer, brake, maxSpeed, downforce, antiRoll, all
    // 1 = normal. Nothing in here reads `car.effects.*` for handling any more —
    // that was a second, parallel mechanism that covered two of the seven
    // channels and left the other five inert. Missing (no gameplay layer) is
    // treated as all-neutral.
    const mods = this.effectMods ?? NEUTRAL_MODS;
    let throttle = live ? c.throttle : 0;
    const brake = live ? c.brake : 0;
    let steer = live ? c.steer : 0;
    const handbrake = live ? c.handbrake : 0;
    if (electro) {
      // Shocked: the steering fights you. Not a multiplier, so it cannot live
      // in effectMods — the torque kill itself comes from mods.torque = 0.
      throttle = 0;
      this._electroPhase = (this._electroPhase ?? 0) + dt * 37;
      steer = -steer * 0.85 + Math.sin(this._electroPhase) * 0.35;
    }
    steer *= mods.steer;
    // Telemetry reports the PEDAL, not the modulated demand — the HUD and the
    // audio engine want to know what the driver asked for.
    this.throttle = throttle;
    this.brake = brake;
    this.steer = steer;
    this.handbrake = handbrake;

    // ── 2. steering rack ───────────────────────────────────────────────
    this._updateSteering(dt, steer);

    // ── 3. surface lookup + suspension ─────────────────────────────────
    this.suspension.update(dt, mods.antiRoll);
    this._resolveSurfaces();

    // ── 4. drivetrain ──────────────────────────────────────────────────
    // Speed governor. A DEBUFF must genuinely cap you (you cannot out-drag a
    // squash downhill); a buff does not need a governor because the extra speed
    // already falls out of mods.torque against aero drag — v scales as
    // sqrt(thrust), so boost's 1.85x torque lands at 1.36x speed on its own,
    // near enough its 1.42x maxSpeed intent. Governing upward too would just
    // fight the drag balance.
    let torqueScale = mods.torque;
    if (mods.maxSpeed < 1) {
      const cap = this.def.topSpeed * mods.maxSpeed;
      const over = (Math.abs(this.speed) - cap) / Math.max(0.25, cap * 0.08);
      if (over > 0) torqueScale *= 1 - clamp01(over);
    }
    this.drivetrain.update(dt, throttle, brake * mods.brake, handbrake,
      this.launchLocked, torqueScale, Math.max(1, mods.maxSpeed));
    this.rpm = this.drivetrain.rpm;
    this.gear = this.drivetrain.gear;
    this.engineLoad = this.drivetrain.engineLoad;

    // ── 5. tyres + wheel spin ──────────────────────────────────────────
    body.getUp(_up);
    let onGround = 0;
    let maxSkid = 0;
    let rearSkid = 0;
    let maxSat = 0;
    let traction = 0;
    let bestLoad = -1;
    let bestSurface = this.dominantSurfaceId;
    const gripMul = mods.grip;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const tire = w.tire;

      // Contact-patch velocity in the wheel's ground frame.
      body.pointVelocity(w.contactPoint, _patch);
      const vx = _patch.dot(w.groundForward);
      const vy = _patch.dot(w.groundRight);
      w.patchLong = vx;
      w.patchLat = vy;

      tire.solve(dt, vx, vy, w.angularVelocity, w.load, w.surfaceGrip, w.camber, gripMul);

      // ── implicit wheel-spin integration ──
      // I·dω/dt = T − r·Fx, linearised around the current slip so a 1.9e-5
      // kg·m² wheel is unconditionally stable at 120 Hz.
      const I = this.drivetrain.wheelInertia(i);
      const r = w.radius;
      const denom = Math.max(1e-9, I / dt + r * tire.dFxDomega);
      let T = w.driveTorque - r * tire.fx;
      if (w.contact && w.load > 0) {
        const rr = tire.rollingTorque(w.load, w.surfaceRoll);
        T -= sign(w.angularVelocity) * rr;
      } else {
        T -= w.angularVelocity * AIR_SPIN_DRAG;
      }
      let omega = w.angularVelocity + T / denom;

      // Brakes as a clamp, so they can lock the wheel but never reverse it.
      if (w.brakeTorque > 0) {
        const dOmega = w.brakeTorque / denom;
        if (omega > 0) omega = Math.max(0, omega - dOmega);
        else if (omega < 0) omega = Math.min(0, omega + dOmega);
      }
      if (omega > 4000) omega = 4000;
      else if (omega < -4000) omega = -4000;
      w.angularVelocity = omega;
      w.rotation += omega * dt;
      if (w.rotation > 1e6 || w.rotation < -1e6) w.rotation = 0;

      // ── apply the tyre forces ──
      if (w.contact && w.load > 0) {
        onGround++;
        // Longitudinal at the patch (full moment arm ⇒ real squat / dive).
        if (tire.fx !== 0) {
          _f.copy(w.groundForward).multiplyScalar(tire.fx);
          body.applyForce(_f, w.contactPoint);
        }
        // Lateral slightly raised toward the COM — tames roll-over without
        // hiding the weight transfer.
        if (tire.fy !== 0) {
          _f.copy(w.groundRight).multiplyScalar(tire.fy);
          _tmp.subVectors(body.position, w.contactPoint);
          const h = _tmp.dot(_up);
          _p.copy(w.contactPoint).addScaledVector(_up, h * this.suspension.forceLift);
          body.applyForce(_f, _p);
        }
        traction += tire.fx;
        if (w.load > bestLoad) { bestLoad = w.load; bestSurface = w.surfaceId; }
      }

      // ── mirror into the contract fields ──
      w.slipRatio = tire.slipRatio;
      w.slipAngle = tire.slipAngle;
      w.longitudinalForce = tire.fx;
      w.lateralForce = tire.fy;
      w.skidIntensity = tire.skid;
      w.isLocked = w.brakeTorque > 0.004 && Math.abs(omega) < 0.9 && Math.abs(vx) > 0.45;
      w.isSpinning = w.isDriven
        && ((w.contact && tire.slipRatio > 0.20 && w.driveTorque > 0)
          || (!w.contact && Math.abs(omega * r) > Math.abs(this.speed) + 1.6));

      if (tire.skid > maxSkid) maxSkid = tire.skid;
      if (!w.isFront && tire.skid > rearSkid) rearSkid = tire.skid;
      if (tire.saturation > maxSat) maxSat = tire.saturation;

      // Edge flags for the EventBus.
      w.contactBegan = w.contact && !w.wasContact;
      w.contactEnded = !w.contact && w.wasContact;
      w.surfaceChanged = w.contact && w.surfaceId !== w._lastSurface;
      if (w.contact) w._lastSurface = w.surfaceId;
    }

    this.wheelsOnGround = onGround;
    this.skid = maxSkid;
    this.rearSkid = rearSkid;
    this.gripUsage = clamp01(maxSat);
    this.tractionForce = traction;
    this.dominantSurfaceId = bestSurface;

    // ── 6. aero + assists ──────────────────────────────────────────────
    this._updateAirState(dt);
    this.aero.update(dt, steer, throttle, brake, mods.downforce);
    this.aero.applyCounterSteerAssist(steer, this.slipAngle);

    // ── 7. telemetry ───────────────────────────────────────────────────
    this._updateTelemetry(dt);
  }

  /** Speed-sensitive steering limit, rate-limited rack, Ackermann spread. */
  _updateSteering(dt, steer) {
    const d = this.def;
    const spd = Math.abs(this.speed);
    const t = clamp01(spd / Math.max(0.5, d.topSpeed));
    // A little extra lock while sliding, so counter-steer can actually catch it.
    const slideBonus = 1 + clamp01((Math.abs(this.slipAngle) - 0.12) / 0.5) * 0.22;
    const limit = lerp(d.steerMax, d.steerMaxFast, t * t * 0.85 + t * 0.15) * slideBonus;
    const target = steer * limit;
    this.rackAngle = moveToward(this.rackAngle, target, d.steerRate * dt);

    const base = this.rackAngle;
    const ack = d.ackermann;
    for (let i = 0; i < 2; i++) {
      const w = this.wheels[i];
      // The inside wheel of the turn needs more lock than the outside one.
      const inner = base !== 0 && Math.sign(base) === w.side;
      const k = base === 0 ? 1 : (inner ? 1 + ack * 0.28 : 1 - ack * 0.20);
      w.steerAngle = base * k;
    }
    this.wheels[2].steerAngle = 0;
    this.wheels[3].steerAngle = 0;
  }

  /** Fill per-wheel grip / rolling multipliers from the surface tables. */
  /**
   * Resolve each wheel's grip / rolling multiplier from its surface id.
   *
   * Hazard surfaces (an oil slick, surface id 15, grip 0.10) are published
   * OUT OF BAND by the pickup system rather than through the collision mesh,
   * because `physics.addStaticGeometry` is append-only and a slick has to
   * expire. So they have to be folded in here — otherwise driving over oil only
   * spins you out through the `oiled` status effect and the tyres themselves
   * never lose grip, which is the whole "oh no, oil" moment.
   *
   * Resolved PER WHEEL at the actual contact point, not per car: clipping the
   * edge of a slick with two wheels should not feel like hitting it square, and
   * the asymmetry is what makes it read as a slick rather than a debuff. Costs
   * four point tests per car per step and only when a hazard is live.
   */
  _resolveSurfaces() {
    const grip = this.gripTable;
    const roll = this.rollTable;
    const pickups = this.game?.pickups;
    const probe = pickups?.hazardSurfaceAt ? pickups : null;
    // Per-car mirror, maintained by the pickup system. Zero when no slick is
    // anywhere near this car, which lets us skip the per-wheel probe entirely.
    const carHazard = this.hazardSurfaceId | 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      let sid = w.surfaceId & 0x0f;
      if (carHazard) {
        const p = w.contactPoint;
        const h = (probe && w.contact)
          ? probe.hazardSurfaceAt(p.x, p.y, p.z)
          : carHazard;
        if (h) sid = h & 0x0f;
      }
      w.surfaceId = sid;
      w.surfaceGrip = grip[sid] ?? 1;
      w.surfaceRoll = roll[sid] ?? 1;
    }
  }

  /** Airborne / landing detection with a grace period so bumps do not flicker. */
  _updateAirState(dt) {
    const body = this.body;
    const off = this.wheelsOnGround === 0;
    this.landedThisStep = false;
    this.tookOffThisStep = false;

    if (off) {
      this._airTimer += dt;
      if (!this.airborne && this._airTimer >= AIR_GRACE) {
        this.airborne = true;
        this.airTime = this._airTimer;
        this._airStartY = body.position.y;
        this.airFallSpeed = 0;
        this.airHeight = 0;
        this.tookOffThisStep = true;
      } else if (this.airborne) {
        this.airTime += dt;
      }
      if (this.airborne) {
        const fall = -body.velocity.y;
        if (fall > this.airFallSpeed) this.airFallSpeed = fall;
        const h = body.position.y - this._airStartY;
        if (h > this.airHeight) this.airHeight = h;
      }
    } else {
      if (this.airborne) {
        this.airborne = false;
        this.lastLandImpact = Math.max(this.airFallSpeed, 0);
        this.landedThisStep = true;
      }
      this._airTimer = 0;
      this.airTime = 0;
    }
  }

  _updateTelemetry(dt) {
    const body = this.body;
    body.getForward(_fwd);
    body.getRight(_right);
    body.getUp(_up);

    // Speed along the heading (signed) and the display value.
    this.speed = body.velocity.dot(_fwd);
    this.speedKmh = Math.abs(this.speed) * DISPLAY_SPEED_SCALE;
    this.odometer += Math.abs(this.speed) * dt;

    // Chassis slip angle: velocity direction vs heading, in the chassis frame.
    body.worldToLocalDir(body.velocity, _vLocal);
    this.lateralSpeed = _vLocal.x;
    const along = -_vLocal.z;
    const planar = Math.hypot(_vLocal.x, along);
    this.slipAngle = planar > 0.25
      ? Math.atan2(_vLocal.x, Math.abs(along) + 0.22) * (along < 0 ? -1 : 1)
      : damp(this.slipAngle, 0, 10, dt);

    // Accelerations → G readouts (relative to real g so the HUD reads normally).
    _accel.subVectors(body.velocity, this._prevVel).multiplyScalar(1 / Math.max(1e-5, dt));
    this._prevVel.copy(body.velocity);
    this._accelSmoothed.lerp(_accel, clamp01(dt * 16));
    const ax = this._accelSmoothed.dot(_right);
    const az = this._accelSmoothed.dot(_fwd);
    this.lateralG = ax / 9.81;
    this.longitudinalG = az / 9.81;

    this.yawRate = body.angularVelocity.dot(_up);
    this.pitchAngle = this.aero.pitchAngle;
    this.rollAngle = this.aero.rollAngle;

    // Drift: chassis slip angle, reinforced by rear-tyre skid and the handbrake.
    const bySlip = clamp01((Math.abs(this.slipAngle) - 0.075) / 0.42) * clamp01(Math.abs(this.speed) / 1.9);
    const bySkid = this.rearSkid * 0.9;
    // A four-wheel slide barely shows up as a chassis slip angle, but it is
    // very much a drift as far as the tyre marks and the audio are concerned.
    const byScrub = this.skid * 0.55;
    const grounded = this.wheelsOnGround > 0 ? 1 : 0;
    const target = Math.max(bySlip, Math.max(bySkid, byScrub) * grounded);
    this.driftFactor = damp(this.driftFactor, clamp01(target), 14, dt);

    // Attitude / stuck / off-track bookkeeping (the respawn manager reads these).
    this.upsideDown = _up.y < -0.05;
    const wantsToMove = this.throttle > 0.22 || this.brake > 0.22;
    if (!this.airborne && wantsToMove && Math.abs(this.speed) < 0.34) {
      this.stuckTime += dt;
    } else if (Math.abs(this.speed) > 0.7 || this.airborne) {
      this.stuckTime = Math.max(0, this.stuckTime - dt * 2.4);
    }
    if (this.upsideDown || (this.airborne && this.airTime > 2.4)) this.offTrackTime += dt;
    else this.offTrackTime = Math.max(0, this.offTrackTime - dt * 3);
  }

  // ═════════════════════════════════════════════════════════ visuals

  /**
   * Interpolate the visual root and drive every animated part.
   * @param {number} dt wall-ish frame delta (already time-scaled)
   * @param {number} alpha physics interpolation factor 0..1
   */
  updateVisual(dt, alpha) {
    const body = this.body;
    if (!body) return;
    body.applyToObject3D(this.group, alpha);

    const model = this.model;
    if (!model) return;
    const d = this.def;
    const susp = this.suspension;

    // ── shell attitude exaggeration ────────────────────────────────────
    if (this.shell) {
      const rollBias = susp.rollBias();
      const pitchBias = susp.pitchBias();
      const squat = susp.squat();
      const staticSquat = (d.susp.staticCompFront + d.susp.staticCompRear) * 0.5 / Math.max(1e-4, d.susp.travel);
      const targetRoll = clamp(-rollBias * d.visualRollGain * 0.95, -VIS_ROLL_MAX, VIS_ROLL_MAX);
      const targetPitch = clamp(-pitchBias * d.visualPitchGain * 0.85, -VIS_PITCH_MAX, VIS_PITCH_MAX);
      const targetY = -(squat - staticSquat) * d.susp.travel * d.visualSquatGain;
      const k = clamp01(dt * 18);
      this.shell.rotation.z += (targetRoll - this.shell.rotation.z) * k;
      this.shell.rotation.x += (targetPitch - this.shell.rotation.x) * k;
      this.shell.position.y += (targetY - this.shell.position.y) * k;

      // Squash pickup effect.
      const sq = this.effects.squashed > 0 ? clamp01(this.effects.squashed / 0.6) : 0;
      if (sq > 0 || this.shell.scale.y !== 1) {
        const sy = lerp(1, 0.42, sq);
        const sxz = lerp(1, 1.30, sq);
        this.shell.scale.set(
          lerp(this.shell.scale.x, sxz, k),
          lerp(this.shell.scale.y, sy, k),
          lerp(this.shell.scale.z, sxz, k),
        );
      }
    }

    // ── wheels ─────────────────────────────────────────────────────────
    const groups = model.wheelGroups;
    const spins = model.wheelSpins;
    if (groups) {
      for (let i = 0; i < 4; i++) {
        const w = this.wheels[i];
        const g = groups[i];
        if (!g) continue;
        g.position.copy(w.hubLocal);
        g.rotation.y = w.steerAngle;
        // Camber is a small visual lean of the whole hub.
        g.rotation.z = clamp(-w.camber, -0.22, 0.22);
        const s = spins?.[i];
        if (s) s.rotation.x = -w.rotation;
      }
    }

    // ── lights ─────────────────────────────────────────────────────────
    if (model.brakeMaterial) {
      const braking = this.brake > 0.05 || this.handbrake > 0.05;
      const want = braking ? 3.4 : 0.55;
      model.brakeMaterial.emissiveIntensity = lerp(
        model.brakeMaterial.emissiveIntensity, want, clamp01(dt * 22));
    }
    if (model.reverseMaterial) {
      const want = this.gear === -1 ? 2.6 : 0.0;
      model.reverseMaterial.emissiveIntensity = lerp(
        model.reverseMaterial.emissiveIntensity, want, clamp01(dt * 20));
    }
    if (model.headMaterial) {
      const want = 1.5 + this.engineLoad * 0.9;
      model.headMaterial.emissiveIntensity = lerp(
        model.headMaterial.emissiveIntensity, want, clamp01(dt * 6));
    }

    // ── antenna (verlet chain driven by chassis acceleration) ──────────
    if (model.updateAntenna) {
      model.updateAntenna(dt, this._accelSmoothed, body.quaternion);
    }
  }

  // ═════════════════════════════════════════════════════════ contract API

  getForward(out) { return this.body.getForward(out); }
  getRight(out) { return this.body.getRight(out); }
  getUp(out) { return this.body.getUp(out); }

  /** Interpolated visual position — what the camera and FX should follow. */
  worldPosition(out) { return out.copy(this.group.position); }
  /** Exact physics position — what gameplay logic should use. */
  simPosition(out) { return out.copy(this.body.position); }
  /** Current velocity (m/s). */
  getVelocity(out) { return out.copy(this.body.velocity); }
  /** Interpolated visual orientation. */
  worldQuaternion(out) { return out.copy(this.group.quaternion); }

  /**
   * @param {THREE.Vector3} worldImpulse N·s
   * @param {THREE.Vector3} [worldPoint]
   */
  addImpulse(worldImpulse, worldPoint) {
    this.body.applyImpulse(worldImpulse, worldPoint);
    return this;
  }

  /**
   * Re-place the car at a checkpoint. Delegates to the CarSystem's respawn
   * manager when there is one (fade, invulnerability, event) and falls back to
   * an immediate teleport so a bare Car still works.
   * @param {number} [atCheckpointIndex]
   */
  respawn(atCheckpointIndex) {
    const mgr = this.game?.carSystem?.respawn;
    if (mgr?.request) return mgr.request(this, atCheckpointIndex, 'manual');
    this.hardReset(this.body.position, this.body.quaternion);
    return this;
  }

  /**
   * Teleport and clear all transient state. Used by respawn and by the grid
   * placement at race start.
   * @param {THREE.Vector3} position
   * @param {THREE.Quaternion} quaternion
   */
  hardReset(position, quaternion) {
    const body = this.body;
    body.setTransform(position, quaternion ?? body.quaternion, false);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.clearForces();
    this._prevVel.set(0, 0, 0);
    this._accelSmoothed.set(0, 0, 0);
    this.rackAngle = 0;
    for (const w of this.wheels) w.reset();
    this.suspension.reset();
    this.drivetrain.reset();
    this.aero.reset();
    this.speed = 0; this.speedKmh = 0;
    this.slipAngle = 0; this.driftFactor = 0;
    this.lateralG = 0; this.longitudinalG = 0;
    this.airborne = false; this.airTime = 0; this._airTimer = 0;
    this.airFallSpeed = 0; this.airHeight = 0; this.lastLandImpact = 0;
    this.upsideDown = false; this.stuckTime = 0; this.offTrackTime = 0;
    this.wheelsOnGround = 0; this.skid = 0; this.rearSkid = 0;
    this.gear = 1; this.rpm = this.def.idleRpm;
    this.group.position.copy(position);
    if (quaternion) this.group.quaternion.copy(quaternion);
    if (this.model?.resetAntenna) this.model.resetAntenna();
    return this;
  }

  /** Place the car on a grid slot, settled at its static ride height. */
  placeOnGrid(position, quaternion) {
    _tmp.copy(position);
    // Lift by the ride height so the suspension does not start bottomed out.
    _q.copy(quaternion ?? this.body.quaternion);
    _tmp.y += this.def.comHeight;
    this.hardReset(_tmp, _q);
    return this;
  }

  // ═════════════════════════════════════════════════════════ misc

  /**
   * How much of an axle's grip is being used, 0..1+.
   *
   * LOAD-WEIGHTED, deliberately. Taking the max across the pair looks simpler
   * but is useless as a signal: the unloaded inside wheel in a corner has
   * D → 0, so its `|F| / D` ratio blows past 1 while contributing no force at
   * all, and anything reading this (the AI's understeer guard, throttle
   * feathering) fires permanently on a car that is merely leaning.
   */
  axleSaturation(front) {
    const a = front ? 0 : 2;
    const w0 = this.wheels[a];
    const w1 = this.wheels[a + 1];
    const total = w0.load + w1.load;
    if (total < 1e-3) return 0;
    return (w0.tire.saturation * w0.load + w1.tire.saturation * w1.load) / total;
  }

  /** True while the car is drifting hard enough to matter for FX / scoring. */
  get isDrifting() { return this.driftFactor > 0.22 && this.wheelsOnGround >= 2; }

  /** Estimated lateral acceleration limit right now (m/s²) — used by the AI. */
  lateralGripLimit() {
    const d = this.def;
    let mu = 0;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.contact) continue;
      mu += w.tire.mu * w.surfaceGrip;
      n++;
    }
    if (n === 0) mu = d.tyre.grip;
    else mu /= n;
    const g = Math.abs(CONFIG.physics.gravity);
    const down = this.aero.downforce / Math.max(1e-3, d.mass);
    return mu * (g + down) * (n >= 3 ? 1 : 0.7);
  }

  dispose() {
    this._alive = false;
    this.model?.dispose?.();
    this.model = null;
    this.group.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Chassis collider
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A corner-chamfered, bottom-tapered box. The chamfer stops the shell catching
 * on track edges, and the taper lets the car ride up over lips instead of
 * stubbing its floor on them.
 * @param {object} def
 * @returns {number[][]} points for `makeHull`
 */
export function chassisHullPoints(def) {
  const [hx, hy, hz] = def.hullHalf;
  const cy = def.hullCenterY;
  const cz = def.hullCenterZ ?? 0;
  const b = Math.min(hx, hy, hz) * 0.55;
  const pts = [];
  for (let sx = -1; sx <= 1; sx += 2) {
    for (let sy = -1; sy <= 1; sy += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        // The bottom face is pulled in, so the floor is a shallow wedge rather
        // than a flat slab — that is what lets the car climb a lip.
        const X = hx * (sy < 0 ? 0.84 : 1.0);
        const Z = hz * (sy < 0 ? 0.94 : 1.0);
        const x = sx * X;
        const y = cy + sy * hy;
        const z = cz + sz * Z;
        pts.push([x - sx * b, y, z]);          // chamfer along X
        pts.push([x, y - sy * b, z]);          // chamfer along Y
        pts.push([x, y, z - sz * b]);          // chamfer along Z
      }
    }
  }
  return pts;
}

export default Car;
