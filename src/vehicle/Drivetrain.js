/**
 * RC RUMBLE — drivetrain.
 *
 * Engine → gearbox → final drive → differential → wheels, plus brakes.
 *
 * Model
 * -----
 * • **Torque curve** — a real curve with a fat mid-range and a soft top end,
 *   sampled from a table (`ENGINE_TORQUE_CURVE`). Peak torque is *derived* from
 *   the car's `accel` intent in CarDefs, so the curve here is pure shape.
 * • **Rev limiter** — hard cut above `limiterRpm` with hysteresis, and a
 *   sputter phase the audio system can read.
 * • **4-speed automatic** — shift points at 95.5 % of the redline, downshifts
 *   with a wide enough hysteresis that it can never hunt, kickdown at full
 *   throttle, a 0.11 s shift during which torque drops to 16 % (the "dip" you
 *   feel and hear), and a cooldown so it cannot machine-gun gears.
 * • **Reverse** — engages when you hold the brake at a standstill; after that
 *   the pedals swap roles, exactly like every arcade racer since Out Run.
 * • **Differential** — `open`, `lsd` or `locked`. Locking is a torque that
 *   pulls each driven wheel toward the axle (or, when locked, the whole
 *   driven-set) average. Its gain is scaled by the reflected inertia and the
 *   timestep so it is *unconditionally stable* however stiff you make it.
 * • **4WD / RWD / FWD** with an adjustable front torque split.
 * • **Engine braking** proportional to rpm when you lift off.
 * • **Brakes** with a front/rear bias, plus a "regenerative" component that
 *   only acts on the driven axle at light pedal — it gives the cars a
 *   distinctly electric, toy-like deceleration.
 * • **Handbrake** locks the rears *and* decouples them from the drive, so a
 *   handbrake turn actually rotates the car.
 *
 * Everything is expressed as torques on `wheel.driveTorque` / `wheel.brakeTorque`.
 * Car.js integrates the wheel spin implicitly using the tyre stiffness, which is
 * what keeps a 1.9e-5 kg·m² wheel stable at 120 Hz.
 */

import { clamp, clamp01, lerp } from '../core/MathUtils.js';

// ═══════════════════════════════════════════════════════════════════════════
// Engine torque curve — normalised torque vs. fraction of the redline.
// ═══════════════════════════════════════════════════════════════════════════

const CURVE_X = new Float32Array([0.00, 0.06, 0.14, 0.24, 0.36, 0.48, 0.60, 0.70, 0.80, 0.88, 0.94, 1.00, 1.06, 1.14]);
const CURVE_Y = new Float32Array([0.30, 0.52, 0.70, 0.84, 0.94, 0.99, 1.00, 0.995, 0.955, 0.905, 0.845, 0.780, 0.660, 0.470]);

/**
 * Normalised engine torque at a fraction of the redline. Allocation free.
 * @param {number} frac rpm / redlineRpm
 */
export function engineTorqueFactor(frac) {
  if (frac <= CURVE_X[0]) return CURVE_Y[0];
  const n = CURVE_X.length;
  if (frac >= CURVE_X[n - 1]) return CURVE_Y[n - 1];
  for (let i = 1; i < n; i++) {
    if (frac <= CURVE_X[i]) {
      const t = (frac - CURVE_X[i - 1]) / (CURVE_X[i] - CURVE_X[i - 1]);
      return CURVE_Y[i - 1] + (CURVE_Y[i] - CURVE_Y[i - 1]) * t;
    }
  }
  return CURVE_Y[n - 1];
}

const RAD_TO_RPM = 60 / (2 * Math.PI);

export class Drivetrain {
  /** @param {import('./Car.js').Car} car */
  constructor(car) {
    this.car = car;
    const d = car.def;
    this.def = d;

    this.gearRatios = d.gearRatios;
    this.gearCount = d.gearCount;
    this.reverseRatio = d.reverseGearRatio;
    this.peakTorque = d.enginePeakTorque;
    this.redlineOmega = d.redlineOmega;
    this.limiterOmega = d.limiterOmega;
    this.idleOmega = d.idleOmega;
    this.engineInertia = d.engineInertia;

    // ── state ─────────────────────────────────────────────────────────
    /** 1..gearCount, 0 = neutral, −1 = reverse. */
    this.gear = 1;
    this.rpm = d.idleRpm;
    this.engineOmega = d.idleOmega;
    this.engineTorque = 0;
    this.engineLoad = 0;
    this.shiftTimer = 0;
    this.shiftCooldown = 0;
    this.shifting = false;
    this.lastShiftDir = 0;
    this.limiterActive = false;
    this.limiterPhase = 0;
    this.reverseArmTimer = 0;
    /** Effective pedal inputs after the reverse-gear swap. */
    this.driveInput = 0;
    this.brakeInput = 0;
    this.handbrakeInput = 0;
    /** Total drive torque delivered to the wheels this step (N·m). */
    this.wheelTorque = 0;
    /** Total brake torque commanded this step (N·m). */
    this.brakeTorqueTotal = 0;
    /** Reflected inertia per wheel, refreshed every step. */
    this.reflected = new Float64Array(4);
    /** Fires for one step when a gear change starts (audio hook). */
    this.shiftEvent = 0;
    /** Fires for one step on a launch chirp (audio/FX hook). */
    this.launchBoost = 0;
    this._launchTimer = 0;
  }

  reset() {
    this.gear = 1;
    this.rpm = this.def.idleRpm;
    this.engineOmega = this.idleOmega;
    this.engineTorque = 0;
    this.engineLoad = 0;
    this.shiftTimer = 0;
    this.shiftCooldown = 0;
    this.shifting = false;
    this.limiterActive = false;
    this.limiterPhase = 0;
    this.reverseArmTimer = 0;
    this.driveInput = 0;
    this.brakeInput = 0;
    this.wheelTorque = 0;
    this.brakeTorqueTotal = 0;
    this.shiftEvent = 0;
    this.launchBoost = 0;
    this._launchTimer = 0;
  }

  /** Total ratio (engine → wheel) for the current gear. 0 in neutral. */
  get ratio() {
    if (this.gear === -1) return this.reverseRatio;
    if (this.gear <= 0) return 0;
    return this.gearRatios[Math.min(this.gearCount, this.gear) - 1];
  }

  /**
   * @param {number} dt
   * @param {number} throttle 0..1
   * @param {number} brake 0..1
   * @param {number} handbrake 0..1
   * @param {boolean} launchLocked true during the countdown — rev but do not move
   * @param {number} [torqueScale] gameplay multiplier (boost, electro-shock…)
   */
  update(dt, throttle, brake, handbrake, launchLocked = false, torqueScale = 1) {
    const car = this.car;
    const d = this.def;
    const wheels = car.wheels;

    this.shiftEvent = 0;
    this.launchBoost = 0;
    if (this.shiftCooldown > 0) this.shiftCooldown -= dt;

    // ── 1. reverse arming / pedal mapping ──────────────────────────────
    const fwdSpeed = car.speed;
    if (this.gear === -1) {
      this.driveInput = brake;
      this.brakeInput = throttle;
      // Leave reverse once we are basically stopped and the player asks to go.
      if (throttle > 0.45 && fwdSpeed > -0.42) {
        this.gear = 1;
        this.shiftCooldown = 0.18;
      }
    } else {
      this.driveInput = throttle;
      this.brakeInput = brake;
      if (brake > 0.45 && throttle < 0.12 && fwdSpeed < 0.42) {
        this.reverseArmTimer += dt;
        if (this.reverseArmTimer > 0.22 && !launchLocked) {
          this.gear = -1;
          this.shiftCooldown = 0.18;
          this.reverseArmTimer = 0;
        }
      } else {
        this.reverseArmTimer = 0;
      }
    }
    this.handbrakeInput = clamp01(handbrake);

    // ── 2. driven-wheel speeds & reflected inertia ─────────────────────
    let drivenOmegaSum = 0;
    let drivenWeight = 0;
    let frontSum = 0, frontN = 0, rearSum = 0, rearN = 0;
    const ratio = this.ratio;
    const ratio2 = ratio * ratio;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      // The driveline's inertia, reflected to the wheel side, is SHARED by the
      // driven wheels — so it divides by their count, it does not multiply.
      this.reflected[i] = w.tire.inertia
        + (w.isDriven ? (this.engineInertia * ratio2) / Math.max(1, d.drivenCount) : 0);
      if (!w.isDriven) continue;
      drivenOmegaSum += w.angularVelocity;
      drivenWeight++;
      if (w.isFront) { frontSum += w.angularVelocity; frontN++; }
      else { rearSum += w.angularVelocity; rearN++; }
    }
    const drivenAvg = drivenWeight > 0 ? drivenOmegaSum / drivenWeight : 0;
    const frontAvg = frontN > 0 ? frontSum / frontN : drivenAvg;
    const rearAvg = rearN > 0 ? rearSum / rearN : drivenAvg;

    // ── 3. engine speed (locked clutch above idle) ─────────────────────
    const dirSign = this.gear === -1 ? -1 : 1;
    const shaftOmega = Math.max(0, drivenAvg * dirSign) * ratio;
    let targetOmega = Math.max(this.idleOmega, shaftOmega);
    if (launchLocked) {
      // Countdown: the wheels are held, so the engine tracks the pedal.
      targetOmega = lerp(this.idleOmega, this.redlineOmega * 0.74, clamp01(throttle));
    }
    // A little inertia so the needle does not teleport (audio cares).
    const follow = clamp01(dt * (targetOmega > this.engineOmega ? 48 : 18));
    this.engineOmega += (targetOmega - this.engineOmega) * follow;
    this.engineOmega = clamp(this.engineOmega, this.idleOmega * 0.85, this.limiterOmega * 1.12);
    this.rpm = this.engineOmega * RAD_TO_RPM;
    const rpmFrac = this.engineOmega / this.redlineOmega;

    // ── 4. automatic gearbox ───────────────────────────────────────────
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) { this.shifting = false; this.shiftTimer = 0; }
    }
    if (!launchLocked && this.gear > 0 && this.shiftTimer <= 0 && this.shiftCooldown <= 0) {
      if (rpmFrac > d.shiftUpFrac && this.gear < this.gearCount && this.driveInput > 0.10) {
        this._beginShift(this.gear + 1);
      } else if (this.gear > 1) {
        const kickdown = this.driveInput > 0.86 && rpmFrac < 0.62;
        if (rpmFrac < d.shiftDownFrac || kickdown) this._beginShift(this.gear - 1);
      }
    }

    // ── 5. rev limiter ─────────────────────────────────────────────────
    if (this.engineOmega >= this.limiterOmega) this.limiterActive = true;
    else if (this.engineOmega < this.limiterOmega * 0.994) this.limiterActive = false;
    this.limiterPhase = this.limiterActive ? (this.limiterPhase + dt * 42) % 1 : 0;

    // ── 6. engine torque ───────────────────────────────────────────────
    const curve = engineTorqueFactor(rpmFrac);
    let eng = this.peakTorque * curve * this.driveInput;

    // Launch punch: a brief torque multiplier off the line in 1st. This is what
    // makes the cars chirp their tyres and feel like wound-up toys.
    if (this.gear === 1 && !launchLocked && this.driveInput > 0.5 && Math.abs(fwdSpeed) < 1.6) {
      this._launchTimer = Math.min(0.30, this._launchTimer + dt);
      const punch = 1 + 0.55 * (1 - this._launchTimer / 0.30) * clamp01(1 - Math.abs(fwdSpeed) / 1.6);
      eng *= punch;
      this.launchBoost = punch - 1;
    } else if (Math.abs(fwdSpeed) > 2.2 || this.driveInput < 0.2) {
      this._launchTimer = Math.max(0, this._launchTimer - dt * 0.8);
    }

    if (this.limiterActive) eng = 0;
    if (this.shifting) eng *= d.shiftTorqueDip;

    // Engine braking when off the pedal.
    if (this.driveInput < 0.14 && this.gear !== 0) {
      const eb = d.engineBraking * this.peakTorque * clamp01(rpmFrac) * (1 - this.driveInput / 0.14);
      eng -= eb;
    }
    eng *= torqueScale;
    this.engineTorque = eng;
    this.engineLoad = clamp01(0.22 * this.driveInput + 0.78 * Math.abs(eng) / Math.max(1e-6, this.peakTorque));

    // ── 7. distribute to the wheels ────────────────────────────────────
    let axleTorque = eng * ratio * dirSign;
    if (launchLocked) axleTorque = 0;
    this.wheelTorque = 0;

    const diff = d.diff;
    const lockStrength = diff === 'locked' ? 0.85 : diff === 'lsd' ? d.diffLock * 0.42 : 0;
    const lockedSet = diff === 'locked';

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      if (!w.isDriven) { w.driveTorque = 0; continue; }
      // `driveSplit` already sums to 1 across the driven wheels.
      let t = axleTorque * d.driveSplit[i];

      // Handbrake decouples the rear axle so the car can be flicked around.
      if (!w.isFront && this.handbrakeInput > 0.05) t *= 1 - this.handbrakeInput * 0.92;

      // Differential locking — pull toward the reference speed.
      if (lockStrength > 0) {
        const ref = lockedSet ? drivenAvg : (w.isFront ? frontAvg : rearAvg);
        // Gain scaled by inertia/dt so |Δω| response ≤ lockStrength per step.
        const gain = (this.reflected[i] / dt) * lockStrength;
        const cap = Math.abs(axleTorque) * 1.8 + this.peakTorque * ratio * 0.22;
        t += clamp(gain * (ref - w.angularVelocity), -cap, cap);
      }

      w.driveTorque = t;
      this.wheelTorque += t;
    }

    // ── 8. brakes ──────────────────────────────────────────────────────
    const pedal = clamp01(this.brakeInput);
    const speedFade = clamp01(Math.abs(car.speed) / 0.35);
    const regenBlend = clamp01(pedal * 2.6) * (1 - this.handbrakeInput) * speedFade;
    this.brakeTorqueTotal = 0;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      let b = d.brakeSplit[i] * pedal;
      // "Regen": extra drag on the driven axle at light pedal.
      if (w.isDriven) b += (d.regenTorque / Math.max(1, d.drivenCount)) * regenBlend;
      // Handbrake locks the rears.
      if (!w.isFront) b += d.handbrakeTorque * 0.5 * this.handbrakeInput;
      w.brakeTorque = b;
      this.brakeTorqueTotal += b;
    }

    // Parking hold: below a crawl with no pedal input at all, add a whisker of
    // brake so a car left alone on a slope does not creep away.
    if (this.driveInput < 0.02 && pedal < 0.02 && this.handbrakeInput < 0.02
      && Math.abs(car.speed) < 0.10) {
      const hold = d.brakeTorque * 0.05;
      for (let i = 0; i < 4; i++) wheels[i].brakeTorque += hold * 0.25;
    }
  }

  _beginShift(next) {
    const n = clamp(next, 1, this.gearCount);
    if (n === this.gear) return;
    this.lastShiftDir = n > this.gear ? 1 : -1;
    this.gear = n;
    this.shifting = true;
    this.shiftTimer = this.def.shiftTime;
    this.shiftCooldown = this.def.shiftTime + 0.22;
    this.shiftEvent = this.lastShiftDir;
  }

  /** Reflected inertia at a wheel (kg·m²) — used by the spin integrator. */
  wheelInertia(index) { return this.reflected[index]; }

  /** Display helpers for the HUD. */
  get gearLabel() {
    if (this.gear === -1) return 'R';
    if (this.gear === 0) return 'N';
    return String(this.gear);
  }

  get rpmFraction() { return clamp01(this.engineOmega / this.redlineOmega); }
}

export default Drivetrain;
