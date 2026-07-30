/**
 * Camera shake with a trauma model.
 *
 * Three independent channels, summed:
 *
 *  1. **Trauma** — a single 0..1 scalar that decays linearly. The applied
 *     amplitude is `trauma²`, which is the whole trick: adding trauma from many
 *     small events barely moves the camera, while one big hit dominates, and the
 *     tail-off feels like an impact instead of a fade. Perlin noise (not random)
 *     drives the displacement so the motion is continuous and can be sampled at
 *     any frame rate without buzzing.
 *
 *  2. **Impulse** — a directional shove. Getting rocketed from the left throws the
 *     camera to the right and it wobbles back on an underdamped spring, with a
 *     matching yaw/pitch twist. This is what makes a hit feel *aimed*.
 *
 *  3. **Rumble** — a continuous low-amplitude, high-frequency channel for surface
 *     texture (gravel, dirt) and engine buzz at high revs. Always subtle.
 *
 * Amplitudes are metres/radians at 1:10 RC scale, so they look tiny in absolute
 * terms: 4 cm of camera travel at 1 m from a 30 cm car is a lot of shake.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, ValueNoise } from '../core/MathUtils.js';
import { Vec3Spring, Spring, approach } from './Spring.js';

const _off = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class CameraShake {
  constructor(seed = 0x5eed) {
    this.noise = new ValueNoise(seed);

    /** 0..1. Amplitude is trauma². */
    this.trauma = 0;
    /** trauma units per second */
    this.traumaDecay = CONFIG.camera?.shakeDecay ?? 5.5;
    this._decay = this.traumaDecay;

    /** Continuous background shake, 0..1 (surface roughness / revs). */
    this.rumble = 0;
    this._rumble = 0;

    /** Global multiplier — the director dials this down for cinematics. */
    this.scale = 1;
    this.enabled = true;

    // Peak amplitudes at trauma = 1.
    this.maxOffset = 0.052;      // metres
    this.maxAngle = 0.038;       // radians (~2.2°)
    this.maxRoll = 0.026;
    this.frequency = 21;         // Hz of the primary noise octave

    /** Directional shove, world space, springs back to zero. */
    this.impulse = new Vec3Spring(24, 0.42);
    this.impulseMax = 0.14;      // metres
    /** Angular kick that rides along with the shove. */
    this.kickYaw = new Spring(0, 26, 0.40);
    this.kickPitch = new Spring(0, 26, 0.40);
    this.kickMax = 0.09;         // radians

    this._t = 0;
    /** Read-only: the amplitude actually applied last frame, 0..1. */
    this.amplitude = 0;
  }

  /** Everything back to rest (mode cut, respawn, race load). */
  reset() {
    this.trauma = 0;
    this._rumble = 0;
    this.rumble = 0;
    this.impulse.snapZero();
    this.kickYaw.snap(0);
    this.kickPitch.snap(0);
    this.amplitude = 0;
    return this;
  }

  /**
   * Add trauma. Adds in "energy" space so two 0.5 hits ≈ one 0.7 hit rather than
   * saturating instantly.
   * @param {number} amount 0..1
   * @param {number} [seconds] time for this trauma to bleed off
   */
  add(amount, seconds) {
    if (!(amount > 0)) return this;
    const a = clamp01(amount);
    this.trauma = clamp01(Math.sqrt(this.trauma * this.trauma + a * a));
    if (Number.isFinite(seconds) && seconds > 0.02) {
      // Blend toward the requested decay rate, weighted by how much of the
      // current trauma this event owns.
      const rate = 1 / seconds;
      const w = clamp01(a / Math.max(this.trauma, 1e-3));
      this._decay = this._decay * (1 - w) + rate * w;
    } else {
      this._decay = this.traumaDecay;
    }
    return this;
  }

  /**
   * Directional shove.
   * @param {THREE.Vector3} worldDir direction the camera should be pushed
   * @param {number} strength metres/second of initial offset velocity
   * @param {number} [twist] extra angular kick 0..1
   */
  addImpulse(worldDir, strength, twist = 1) {
    if (!worldDir || !(strength > 0)) return this;
    _dir.copy(worldDir);
    const l = _dir.length();
    if (l < 1e-6) return this;
    _dir.multiplyScalar(1 / l);
    const s = clamp(strength, 0, 6);
    this.impulse.kick(_dir.x * s, _dir.y * s * 0.7, _dir.z * s);
    this._pendingTwist = clamp(twist, 0, 2);
    this._pendingTwistDir.copy(_dir);
    this._pendingTwistStrength = s;
    return this;
  }

  _pendingTwist = 0;
  _pendingTwistStrength = 0;
  _pendingTwistDir = new THREE.Vector3();

  /** Continuous background shake, 0..1. Set every frame; it smooths itself. */
  setRumble(v) { this.rumble = clamp01(v); return this; }

  /**
   * @param {number} dt seconds
   * @param {THREE.Quaternion} [camQuat] current camera orientation, used to turn
   *   the world-space impulse into a camera-space twist
   */
  update(dt, camQuat = null) {
    dt = clamp(dt, 0, 0.1);
    this._t += dt;

    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - this._decay * dt);
      if (this.trauma === 0) this._decay = this.traumaDecay;
    }

    this._rumble = approach(this._rumble, this.rumble, 6, dt);

    // Convert a pending world-space shove into yaw/pitch kicks in view space.
    if (this._pendingTwistStrength > 0) {
      if (camQuat) {
        _right.set(1, 0, 0).applyQuaternion(camQuat);
        _up.set(0, 1, 0).applyQuaternion(camQuat);
        const lat = this._pendingTwistDir.dot(_right);
        const vert = this._pendingTwistDir.dot(_up);
        const s = this._pendingTwistStrength * this._pendingTwist * 0.35;
        this.kickYaw.velocity += -lat * s * 26;
        this.kickPitch.velocity += vert * s * 20;
      }
      this._pendingTwistStrength = 0;
      this._pendingTwist = 0;
    }

    this.impulse.update(ZERO, dt);
    this.impulse.clampLength(this.impulseMax);
    this.kickYaw.update(0, dt);
    this.kickPitch.update(0, dt);
    this.kickYaw.value = clamp(this.kickYaw.value, -this.kickMax, this.kickMax);
    this.kickPitch.value = clamp(this.kickPitch.value, -this.kickMax, this.kickMax);

    this.amplitude = this.trauma * this.trauma;
    return this;
  }

  /** Two-octave Perlin sample in [-1,1]; `lane` separates the axes. */
  _n(lane, freq) {
    const t = this._t;
    return this.noise.noise2(t * freq, lane) * 0.78
      + this.noise.noise2(t * freq * 2.63, lane + 37.5) * 0.22;
  }

  /**
   * Displace a pose in place. Positional shake is applied in the pose's own
   * basis so it always reads as camera movement rather than world movement.
   * @param {import('./CameraPose.js').CameraPose} pose
   * @param {number} [scale] extra multiplier (mode blend, pose.shakeScale)
   */
  apply(pose, scale = 1) {
    if (!this.enabled || !pose) return pose;
    const s = clamp01(this.scale) * clamp01(scale);
    if (s <= 0.0005) return pose;

    const a = this.amplitude;
    const r = this._rumble;
    const hasShake = a > 0.0004 || r > 0.0015;
    const hasImpulse = this.impulse.value.lengthSq() > 1e-8
      || Math.abs(this.kickYaw.value) > 1e-5 || Math.abs(this.kickPitch.value) > 1e-5;
    if (!hasShake && !hasImpulse) return pose;

    _right.set(1, 0, 0).applyQuaternion(pose.quaternion);
    _up.set(0, 1, 0).applyQuaternion(pose.quaternion);
    _fwd.set(0, 0, -1).applyQuaternion(pose.quaternion);

    _off.set(0, 0, 0);

    if (hasShake) {
      // Trauma: broad, punchy.
      const f = this.frequency;
      const ampP = this.maxOffset * a * s;
      const ox = this._n(0.0, f) * ampP;
      const oy = this._n(11.3, f * 1.13) * ampP * 0.85;
      const oz = this._n(23.7, f * 0.87) * ampP * 0.45;

      // Rumble: tight, fast, mostly vertical — it should feel like the chassis.
      const rf = this.frequency * 2.35;
      const ra = this.maxOffset * 0.26 * r * s;
      const rx = this._n(41.1, rf) * ra * 0.55;
      const ry = this._n(53.9, rf * 1.21) * ra;

      _off.addScaledVector(_right, ox + rx);
      _off.addScaledVector(_up, oy + ry);
      _off.addScaledVector(_fwd, oz);

      const ampA = this.maxAngle * a * s;
      const rollA = this.maxRoll * a * s;
      const ampAr = this.maxAngle * 0.22 * r * s;
      _euler.set(
        this._n(71.5, f * 1.07) * ampA + this._n(83.2, rf * 1.31) * ampAr,
        this._n(97.4, f * 0.93) * ampA + this._n(103.1, rf * 0.89) * ampAr,
        this._n(113.6, f * 1.19) * rollA,
        'YXZ');
    } else {
      _euler.set(0, 0, 0, 'YXZ');
    }

    if (hasImpulse) {
      _off.add(this.impulse.value);
      _euler.x += this.kickPitch.value;
      _euler.y += this.kickYaw.value;
      _euler.z += this.kickYaw.value * 0.45;
    }

    pose.position.add(_off);
    _q.setFromEuler(_euler);
    pose.quaternion.multiply(_q);
    return pose;
  }

  /** Debug/HUD. */
  getStats() {
    return {
      trauma: this.trauma,
      amplitude: this.amplitude,
      rumble: this._rumble,
      impulse: this.impulse.value.length(),
    };
  }
}

const ZERO = Object.freeze(new THREE.Vector3());

export default CameraShake;
