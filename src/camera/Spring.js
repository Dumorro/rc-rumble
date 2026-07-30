/**
 * Exact damped-spring integrators for the camera rig.
 *
 * Why analytic and not Euler: a chase camera has to stay glued to the car through
 * a 250 ms hitch (tab switch, shader compile, a huge GC pause) without exploding.
 * Explicit integration of a stiff spring (ω = 11 rad/s, dt = 0.25 s) diverges;
 * the closed-form solution of
 *
 *     x'' = -ω²(x - target) - 2ζω x'
 *
 * is unconditionally stable and *exact* whenever the target is constant over the
 * step, which it is (we resample the target once per frame). All three damping
 * regimes are implemented so rigs can ask for a touch of overshoot (ζ < 1) where
 * it sells weight, and none at all (ζ = 1) where overshoot would read as sloppy.
 *
 * Everything here is allocation free: the scalar solver returns a module-level
 * result object that the caller reads immediately.
 */

import * as THREE from 'three';
import { angleDelta, clamp, TAU } from '../core/MathUtils.js';

/** Scratch result for {@link springStep}. Read it immediately, never retain. */
const _sr = { x: 0, v: 0 };

/**
 * Advance a damped spring by `dt` seconds, exactly.
 *
 * @param {number} x current value
 * @param {number} v current velocity
 * @param {number} target rest position over this step
 * @param {number} omega natural frequency in rad/s (bigger = snappier)
 * @param {number} zeta damping ratio (1 = critical, <1 overshoots, >1 sluggish)
 * @param {number} dt seconds
 * @returns {{x:number, v:number}} shared scratch — copy what you need
 */
export function springStep(x, v, target, omega, zeta, dt) {
  if (!(dt > 0)) { _sr.x = x; _sr.v = v; return _sr; }
  if (!(omega > 0)) { _sr.x = target; _sr.v = 0; return _sr; }
  // Guard against NaN creeping in from a bad car state.
  if (!Number.isFinite(x) || !Number.isFinite(v) || !Number.isFinite(target)) {
    _sr.x = Number.isFinite(target) ? target : 0;
    _sr.v = 0;
    return _sr;
  }

  const d0 = x - target;

  if (zeta > 1.0001) {
    // ── overdamped: two real roots ──
    const s = Math.sqrt(zeta * zeta - 1);
    const r1 = -omega * (zeta - s);
    const r2 = -omega * (zeta + s);
    const c2 = (v - r1 * d0) / (r2 - r1);
    const c1 = d0 - c2;
    const e1 = Math.exp(r1 * dt);
    const e2 = Math.exp(r2 * dt);
    _sr.x = target + c1 * e1 + c2 * e2;
    _sr.v = c1 * r1 * e1 + c2 * r2 * e2;
  } else if (zeta < 0.9999) {
    // ── underdamped: decaying sinusoid ──
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * omega * dt);
    const A = d0;
    const B = (v + zeta * omega * d0) / wd;
    const c = Math.cos(wd * dt);
    const s = Math.sin(wd * dt);
    _sr.x = target + e * (A * c + B * s);
    _sr.v = e * ((B * wd - zeta * omega * A) * c - (A * wd + zeta * omega * B) * s);
  } else {
    // ── critically damped: the workhorse ──
    const e = Math.exp(-omega * dt);
    const B = v + omega * d0;
    _sr.x = target + (d0 + B * dt) * e;
    _sr.v = (v - omega * B * dt) * e;
  }
  return _sr;
}

/** Frame-rate independent exponential approach (no velocity state). */
export function approach(current, target, rate, dt) {
  if (!(dt > 0) || !(rate > 0)) return current;
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Same, on an angle, taking the short way round. */
export function approachAngle(current, target, rate, dt) {
  return wrapPi(current + angleDelta(current, target) * (1 - Math.exp(-rate * dt)));
}

/** Wrap an angle to (-PI, PI]. */
export function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}

/** Scalar spring with persistent velocity. */
export class Spring {
  /**
   * @param {number} value
   * @param {number} omega natural frequency, rad/s
   * @param {number} zeta damping ratio
   */
  constructor(value = 0, omega = 10, zeta = 1) {
    this.value = value;
    this.velocity = 0;
    this.omega = omega;
    this.zeta = zeta;
  }

  /** @returns {number} the new value */
  update(target, dt, omega = this.omega, zeta = this.zeta) {
    const r = springStep(this.value, this.velocity, target, omega, zeta, dt);
    this.value = r.x;
    this.velocity = r.v;
    return this.value;
  }

  /** Teleport: kill velocity too. */
  snap(value) { this.value = value; this.velocity = 0; return value; }
}

/** Angular spring that always travels the short way round. */
export class AngleSpring {
  constructor(value = 0, omega = 8, zeta = 1) {
    this.value = wrapPi(value);
    this.velocity = 0;
    this.omega = omega;
    this.zeta = zeta;
  }

  update(target, dt, omega = this.omega, zeta = this.zeta) {
    // Re-express the target as "nearest equivalent angle" so the spring never
    // takes the long way around ±PI.
    const rel = this.value + angleDelta(this.value, target);
    const r = springStep(this.value, this.velocity, rel, omega, zeta, dt);
    this.value = wrapPi(r.x);
    this.velocity = r.v;
    return this.value;
  }

  snap(value) { this.value = wrapPi(value); this.velocity = 0; return this.value; }
}

/** Vector3 spring. Positions, look targets, shake offsets. */
export class Vec3Spring {
  constructor(omega = 10, zeta = 1) {
    this.value = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.omega = omega;
    this.zeta = zeta;
  }

  /** @param {THREE.Vector3} target */
  update(target, dt, omega = this.omega, zeta = this.zeta) {
    const v = this.value, vel = this.velocity;
    let r = springStep(v.x, vel.x, target.x, omega, zeta, dt); v.x = r.x; vel.x = r.v;
    r = springStep(v.y, vel.y, target.y, omega, zeta, dt); v.y = r.x; vel.y = r.v;
    r = springStep(v.z, vel.z, target.z, omega, zeta, dt); v.z = r.x; vel.z = r.v;
    return v;
  }

  /**
   * Horizontal and vertical get different frequencies. This is the single most
   * important trick in the whole chase camera: the car can leap 1.5 m into the
   * air and the camera rises lazily instead of whipping, while lateral tracking
   * stays tight enough to hold a drift in frame.
   */
  updateSplit(target, dt, omegaH, omegaV, zeta = this.zeta, zetaV = zeta) {
    const v = this.value, vel = this.velocity;
    let r = springStep(v.x, vel.x, target.x, omegaH, zeta, dt); v.x = r.x; vel.x = r.v;
    r = springStep(v.z, vel.z, target.z, omegaH, zeta, dt); v.z = r.x; vel.z = r.v;
    r = springStep(v.y, vel.y, target.y, omegaV, zetaV, dt); v.y = r.x; vel.y = r.v;
    return v;
  }

  /** Add to velocity — an impulse kick. */
  kick(x, y, z) {
    this.velocity.x += x; this.velocity.y += y; this.velocity.z += z;
    return this;
  }

  snap(v) { this.value.copy(v); this.velocity.set(0, 0, 0); return this.value; }
  snapZero() { this.value.set(0, 0, 0); this.velocity.set(0, 0, 0); return this.value; }

  /** Clamp |value| so a violent kick can never fling the camera out of the level. */
  clampLength(max) {
    const l = this.value.length();
    if (l > max && l > 1e-6) this.value.multiplyScalar(max / l);
    return this;
  }
}

/** Critical omega for a given "time to settle" (~4 time constants). */
export const omegaForSettle = (seconds) => (seconds > 0 ? 4 / seconds : 1e3);

/**
 * Steady-state lag of a spring whose target is moving at constant speed `v`:
 *
 *     x'' = -ω²(x - T) - 2ζω x' ,  T = T₀ + v·t   ⇒   lag = 2ζv/ω
 *
 * At 8 m/s with ω = 11 that is **1.45 m** — enough to double the chase distance
 * of an RC car. Every rig that springs a world position toward a moving car adds
 * `v · lagCoefficient(...)` to the target to cancel it, with a gain slightly
 * below 1 so a deliberate sliver of trail survives.
 *
 * @param {number} omega
 * @param {number} [zeta]
 * @param {number} [gain] 0 = keep all the lag, 1 = cancel it exactly
 * @returns {number} seconds — multiply by velocity to get metres
 */
export function lagCoefficient(omega, zeta = 1, gain = 1) {
  return (2 * zeta * gain) / Math.max(omega, 1e-3);
}

/**
 * Add lag compensation to a spring target, with separate horizontal/vertical
 * coefficients and a hard cap on the displacement so one bogus velocity sample
 * (a physics blow-up, a car teleport) can never fling the camera across the level.
 *
 * Allocation free — no scratch vector needed.
 *
 * @param {{x:number,y:number,z:number}} out mutated in place
 * @param {{x:number,y:number,z:number}} vel
 * @param {number} coeffH seconds (from lagCoefficient)
 * @param {number} coeffV seconds
 * @param {number} maxMetres
 */
export function addLagCompensation(out, vel, coeffH, coeffV, maxMetres) {
  let x = vel.x * coeffH;
  let z = vel.z * coeffH;
  let y = vel.y * coeffV;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return out;
  const l = Math.sqrt(x * x + y * y + z * z);
  if (l > maxMetres && l > 1e-9) {
    const s = maxMetres / l;
    x *= s; y *= s; z *= s;
  }
  out.x += x; out.y += y; out.z += z;
  return out;
}

export { clamp };
export default Spring;
