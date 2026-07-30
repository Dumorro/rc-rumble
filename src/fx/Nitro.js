/**
 * RC RUMBLE — nitro / boost.
 *
 * A boost has to sell "more power than the car can handle" in about a tenth of a
 * second, so it is built from four layers that read at different distances:
 *
 * 1. **Flame jets.** Animated flame sprites fired straight out of each nozzle,
 *    stretched by the car's own speed, going white-hot at the root and cooling to
 *    a deep orange at the tip.
 * 2. **Sparks and embers.** Tiny streaks that break off the jet and get left
 *    behind, which is what makes the flame look like it is *moving* rather than
 *    parented to the car.
 * 3. **Heat haze.** A shimmer patch trailing the exhaust (see the HAZE layer in
 *    ParticleSystem.js for why this is a fake refraction and how it fakes it).
 * 4. **Speed lines.** Screen-space-ish streaks that stream past the camera,
 *    spawned in a shell around the player so they always read as motion.
 *
 * Nozzle positions come from `car.def.nozzles = [[x,y,z], ...]` (chassis-local
 * metres). If a car does not declare any, we synthesize two at the rear corners
 * from its wheelbase, so every car boosts correctly whether or not the vehicle
 * agent opted in.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp, damp } from '../core/MathUtils.js';
import { LAYER, frand, frandRange } from './ParticleSystem.js';
import { SPR } from './ParticleAtlas.js';
import { resetOpts } from './Sparks.js';

const _local = new THREE.Vector3();
const _back = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camPos = new THREE.Vector3();

class BoostState {
  constructor() {
    /** 0..1, smoothed: the flame has inertia, it does not blink on. */
    this.level = 0;
    this.acc = 0;
    this.sparkAcc = 0;
    this.hazeAcc = 0;
    this.ignited = false;
  }
  reset() { this.level = 0; this.acc = 0; this.sparkAcc = 0; this.hazeAcc = 0; this.ignited = false; }
}

export class Nitro {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {import('./ParticleSystem.js').ParticleSystem} particles
   */
  constructor(game, particles) {
    this.game = game;
    this.P = particles;
    this.enabled = true;
    this.rate = 1;

    /** Speed lines only appear above this fraction of top speed. */
    this.speedLineThreshold = 0.62;
    this.speedLinesEnabled = CONFIG.quality !== 'low';

    /** @type {BoostState[]} */
    this.states = [];
    for (let i = 0; i < Math.max(8, CONFIG.race.maxCars); i++) this.states.push(new BoostState());

    this._lineAcc = 0;
    this.styles = {};
    this.stats = { boosting: 0, spawned: 0, lines: 0 };
  }

  init() {
    const P = this.P;
    if (!P) return this;
    const S = this.styles;

    // ── the jet itself ──
    S.flame = P.defineStyle('fx/nitro/flame', {
      layer: LAYER.ADD,
      sprite: SPR.FLAME, frames: 8, frameMode: 'life',
      life: [0.09, 0.19],
      size: [0.014, 0.030],
      aspect: 1.9,
      sizeCurve: [0.55, 1.1, 1.0, 0.55],
      alpha: 1,
      alphaCurve: [1, 1, 0.6, 0],
      color: 0xd8f0ff,          // white-blue root
      colorEnd: 0xff7418,       // orange tip
      colorCurve: [5.5, 3.6, 1.8, 0.4],
      gravity: 0,
      drag: 5.5,
      rise: 0.35,
      spin: [-0.4, 0.4],
      sizeJitter: 0.3,
    });

    // ── the blue-white core right at the nozzle ──
    S.core = P.defineStyle('fx/nitro/core', {
      layer: LAYER.ADD,
      sprite: SPR.GLOW,
      life: [0.05, 0.10],
      size: [0.010, 0.020],
      sizeCurve: [1.0, 1.15, 0.8, 0.3],
      alpha: 1,
      alphaCurve: [1, 0.9, 0.45, 0],
      color: 0xc8e8ff,
      colorEnd: 0x6fa8ff,
      colorCurve: [6.5, 4.0, 1.6, 0],
      gravity: 0,
      drag: 7,
    });

    // ── sparks torn off the jet ──
    S.spark = P.defineStyle('fx/nitro/spark', {
      layer: LAYER.STREAK,
      sprite: SPR.STREAK,
      life: [0.13, 0.34],
      size: [0.0016, 0.0034],
      aspect: 2.2,
      alpha: 1,
      alphaCurve: [1, 1, 0.6, 0],
      color: 0xfff0d0,
      colorEnd: 0xff4a08,
      colorCurve: [3.8, 2.4, 1.0, 0.2],
      stretch: 0.018,
      gravity: CONFIG.physics.gravity * 0.25,
      drag: 1.4,
    });

    // ── embers that hang in the air behind the car ──
    S.ember = P.defineStyle('fx/nitro/ember', {
      layer: LAYER.ADD,
      sprite: SPR.GLOW,
      life: [0.28, 0.62],
      size: [0.0022, 0.0055],
      sizeCurve: [1, 0.85, 0.6, 0.25],
      alpha: 1,
      alphaCurve: [1, 0.85, 0.45, 0],
      color: 0xffca88,
      colorEnd: 0x8a2200,
      colorCurve: [2.6, 1.6, 0.7, 0.15],
      gravity: CONFIG.physics.gravity * 0.10,
      drag: 2.2,
      rise: 0.5,
    });

    // ── heat shimmer trailing the exhaust ──
    S.haze = P.defineStyle('fx/nitro/haze', {
      layer: LAYER.HAZE,
      sprite: SPR.SOFT,
      life: [0.22, 0.48],
      size: [0.028, 0.062],
      sizeCurve: [0.6, 1.2, 1.7, 2.0],
      alpha: 0.85,
      alphaCurve: [0.4, 1, 0.7, 0],
      color: 0xffd8b0,
      gravity: 0,
      drag: 3.2,
      rise: 0.9,
      turbulence: 2.6, turbScale: 7, turbSpeed: 2.2,
      spin: [-1.5, 1.5],
    });

    // ── ignition pop: one bright flash when the boost fires ──
    S.ignite = P.defineStyle('fx/nitro/ignite', {
      layer: LAYER.ADD,
      sprite: SPR.FLARE,
      life: [0.10, 0.18],
      size: [0.035, 0.070],
      sizeCurve: [0.4, 1.4, 1.1, 0.4],
      alpha: 1,
      alphaCurve: [1, 0.85, 0.35, 0],
      color: 0xdff0ff,
      colorEnd: 0xffb060,
      colorCurve: [6.0, 3.2, 1.2, 0],
      gravity: 0,
      drag: 6,
    });

    // ── speed lines ──
    S.speedLine = P.defineStyle('fx/nitro/speedLine', {
      layer: LAYER.STREAK,
      sprite: SPR.STREAK,
      life: [0.14, 0.26],
      size: [0.0012, 0.0030],
      aspect: 3.5,
      alpha: 0.55,
      alphaCurve: [0, 1, 0.8, 0],
      color: 0xdfeaff,
      intensity: 1.1,
      stretch: 0.030,
      gravity: 0,
      drag: 0.15,
    });

    return this;
  }

  // ─────────────────────────────────────────────────────────── update

  /**
   * @param {number} dt
   * @param {import('../vehicle/Car.js').Car[]} cars
   * @param {THREE.Camera} camera
   */
  update(dt, cars, camera) {
    if (!this.enabled || !this.P || dt <= 0) return;
    let boosting = 0;

    for (let c = 0; cars && c < cars.length; c++) {
      const car = cars[c];
      const st = this.states[(car?.id | 0) & 7];
      if (!car || !st) continue;
      const active = this._car(car, st, dt);
      if (active) boosting++;
    }
    this.stats.boosting = boosting;

    // Speed lines follow the *player*, because they are a camera effect.
    this._speedLines(dt, camera);
  }

  /** @returns {boolean} is this car visibly boosting */
  _car(car, st, dt) {
    // `effects.boost` is the canonical flag (ARCHITECTURE.md → Car.effects).
    // `car.boosting` / `car.nitro` are honoured as fallbacks so this works
    // whatever the gameplay system settles on.
    let target = 0;
    const eff = car.effects;
    if (eff && typeof eff.boost === 'number') target = eff.boost > 0 ? 1 : 0;
    if (car.boosting) target = 1;
    if (typeof car.nitro === 'number') target = Math.max(target, clamp01(car.nitro));

    const wasIgnited = st.ignited;
    st.ignited = target > 0.5;
    // asymmetric: lights instantly, dies over ~0.25 s
    st.level = target > st.level
      ? damp(st.level, target, 26, dt)
      : damp(st.level, target, 7, dt);

    if (st.level < 0.02) { st.acc = 0; st.sparkAcc = 0; st.hazeAcc = 0; return false; }

    const grp = car.group;
    if (!grp) return false;

    const vel = car.body?.velocity;
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;
    const speed = Math.hypot(vx, vy, vz);

    // chassis axes from the visual transform
    _back.setFromMatrixColumn(grp.matrixWorld, 2);        // +Z is rearward
    _up.setFromMatrixColumn(grp.matrixWorld, 1);
    _right.setFromMatrixColumn(grp.matrixWorld, 0);
    _back.normalize(); _up.normalize(); _right.normalize();

    const nozzles = this._nozzles(car);
    const level = st.level;
    const P = this.P;
    const S = this.styles;

    // ── ignition pop ──
    if (st.ignited && !wasIgnited) {
      const o = resetOpts(_opts);
      o.sizeMul = 1.1;
      for (let i = 0; i < nozzles.length; i++) {
        this._nozzleWorld(grp, nozzles[i]);
        P.spawn(S.ignite, _local.x, _local.y, _local.z, 0, 0, 0, o);
      }
      this.game?.renderer?.postfx?.flash?.(0xbfe4ff, 0.14 * level, 0.10);
    }

    // ── flame jets ──
    const rate = lerp(0, 210, level) * this.rate / Math.max(nozzles.length, 1);
    st.acc += rate * dt;
    let n = st.acc | 0;
    st.acc -= n;
    if (n > 10) n = 10;

    const o = resetOpts(_opts);
    o.speedJitter = 0.35;
    o.radius = 0.004;
    // The jet inherits nearly all the car's velocity so it stays glued to the
    // nozzle, with a small deficit that reads as thrust.
    o.inheritX = vx * 0.82; o.inheritY = vy * 0.82; o.inheritZ = vz * 0.82;
    o.sizeMul = lerp(0.7, 1.25, level) * (1 + clamp01(speed / 9) * 0.3);
    o.lifeMul = lerp(0.8, 1.15, level);

    const eject = lerp(1.2, 3.4, level) + speed * 0.10;

    for (let i = 0; i < nozzles.length && n > 0; i++) {
      this._nozzleWorld(grp, nozzles[i]);
      const px = _local.x, py = _local.y, pz = _local.z;
      const share = Math.max(1, Math.round(n / nozzles.length));

      // slight downward/outward flare so the jets do not look like laser beams
      const side = (i % 2 === 0 ? -1 : 1) * 0.10;
      const dx = _back.x + _right.x * side - _up.x * 0.06;
      const dy = _back.y + _right.y * side - _up.y * 0.06;
      const dz = _back.z + _right.z * side - _up.z * 0.06;

      P.burstCone(S.flame, px, py, pz, dx, dy, dz, eject, 0.20, share, o);

      // white-hot core, fewer and tighter
      if (frand() < level * 0.85) {
        o.sizeMul *= 0.8;
        P.burstCone(S.core, px, py, pz, dx, dy, dz, eject * 0.6, 0.10,
          Math.max(1, share >> 1), o);
        o.sizeMul /= 0.8;
      }
    }
    this.stats.spawned += n;

    // ── sparks + embers ──
    st.sparkAcc += lerp(0, 95, level) * this.rate * dt;
    let sp = st.sparkAcc | 0;
    st.sparkAcc -= sp;
    if (sp > 8) sp = 8;
    if (sp > 0) {
      const so = resetOpts(_opts2);
      so.speedJitter = 0.6;
      so.radius = 0.006;
      so.inheritX = vx * 0.55; so.inheritY = vy * 0.55; so.inheritZ = vz * 0.55;
      so.sizeMul = lerp(0.8, 1.3, level);
      for (let i = 0; i < nozzles.length; i++) {
        this._nozzleWorld(grp, nozzles[i]);
        const share = Math.max(1, Math.round(sp / nozzles.length));
        P.burstCone(S.spark, _local.x, _local.y, _local.z,
          _back.x, _back.y + 0.12, _back.z, eject * 1.5, 0.42, share, so);
        if (frand() < level * 0.6) {
          P.burstCone(S.ember, _local.x, _local.y, _local.z,
            _back.x, _back.y + 0.25, _back.z, eject * 0.55, 0.7, 1, so);
        }
      }
    }

    // ── heat haze, trailing well behind the nozzles ──
    st.hazeAcc += lerp(0, 26, level) * this.rate * dt;
    let hz = st.hazeAcc | 0;
    st.hazeAcc -= hz;
    if (hz > 3) hz = 3;
    if (hz > 0) {
      const ho = resetOpts(_opts2);
      ho.speedJitter = 0.4;
      ho.radius = 0.010;
      ho.inheritX = vx * 0.60; ho.inheritY = vy * 0.60; ho.inheritZ = vz * 0.60;
      ho.sizeMul = lerp(0.8, 1.5, level) * (1 + clamp01(speed / 9) * 0.35);
      ho.alpha = lerp(0.5, 1, level);
      for (let k = 0; k < hz; k++) {
        const nz = nozzles[k % nozzles.length];
        this._nozzleWorld(grp, nz);
        // push the shimmer back behind the flame so it reads as exhaust wash
        const bx = _local.x + _back.x * 0.055;
        const by = _local.y + _back.y * 0.055;
        const bz = _local.z + _back.z * 0.055;
        P.burstCone(S.haze, bx, by, bz, _back.x, _back.y + 0.3, _back.z,
          0.5 + level * 0.9, 0.5, 1, ho);
      }
    }

    return true;
  }

  /** @returns {number[][]} chassis-local nozzle positions */
  _nozzles(car) {
    const declared = car.def?.nozzles;
    if (Array.isArray(declared) && declared.length) return declared;

    // Synthesize from the wheelbase so an opt-out car still looks right.
    let cached = car._fxNozzles;
    if (cached) return cached;
    const wheels = car.wheels;
    let halfWidth = 0.045;
    let rear = 0.125;
    let height = 0.030;
    if (wheels && wheels.length >= 4) {
      let maxZ = 0, maxX = 0, sumY = 0, cnt = 0;
      for (const w of wheels) {
        const rp = w?.restPosition;
        if (!rp) continue;
        if (rp.z > maxZ) maxZ = rp.z;
        if (Math.abs(rp.x) > maxX) maxX = Math.abs(rp.x);
        sumY += rp.y; cnt++;
      }
      if (maxZ > 0) rear = maxZ * 0.92;
      if (maxX > 0) halfWidth = maxX * 0.55;
      if (cnt > 0) height = sumY / cnt + 0.022;
    }
    cached = [[-halfWidth, height, rear], [halfWidth, height, rear]];
    car._fxNozzles = cached;
    return cached;
  }

  /** Chassis-local nozzle → world, into `_local`. */
  _nozzleWorld(group, nozzle) {
    _local.set(nozzle[0] ?? 0, nozzle[1] ?? 0.03, nozzle[2] ?? 0.12);
    _local.applyMatrix4(group.matrixWorld);
    return _local;
  }

  // ─────────────────────────────────────────────────────── speed lines

  /**
   * Streaks that stream past the camera. Spawned in a hollow cylinder around the
   * view axis, ahead of the camera, moving backwards past it — so they always
   * cross the frame regardless of where the car is pointing.
   */
  _speedLines(dt, camera) {
    if (!this.speedLinesEnabled || !camera) return;
    const player = this.game?.playerCar;
    if (!player) return;

    const top = player.def?.topSpeed || 9;
    const speed = Math.abs(player.speed ?? 0);
    let t = clamp01((speed / top - this.speedLineThreshold) / (1 - this.speedLineThreshold));
    // a boost pushes the lines well past what raw speed would give
    const boost = this.states[(player.id | 0) & 7]?.level ?? 0;
    t = clamp01(t + boost * 0.55);
    if (t < 0.02) { this._lineAcc = 0; return; }

    _camPos.setFromMatrixPosition(camera.matrixWorld);
    _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

    const rate = lerp(0, 130, t) * this.rate;
    this._lineAcc += rate * dt;
    let n = this._lineAcc | 0;
    this._lineAcc -= n;
    if (n > 14) n = 14;
    if (n <= 0) return;

    // basis around the view axis
    _up.set(0, 1, 0);
    _right.crossVectors(_camFwd, _up);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _camFwd).normalize();

    const o = resetOpts(_opts);
    o.speedJitter = 0.30;
    o.alpha = lerp(0.35, 1, t);
    o.sizeMul = lerp(0.8, 1.5, t);

    const lineSpeed = lerp(9, 26, t);
    for (let k = 0; k < n; k++) {
      const a = frand() * Math.PI * 2;
      // hollow: nothing spawns in the middle of the screen
      const r = lerp(0.30, 1.05, Math.sqrt(frandRange(0.30, 1)));
      const ahead = frandRange(0.5, 2.4);
      const px = _camPos.x + _camFwd.x * ahead + (_right.x * Math.cos(a) + _up.x * Math.sin(a)) * r;
      const py = _camPos.y + _camFwd.y * ahead + (_right.y * Math.cos(a) + _up.y * Math.sin(a)) * r;
      const pz = _camPos.z + _camFwd.z * ahead + (_right.z * Math.cos(a) + _up.z * Math.sin(a)) * r;
      this.P.spawn(this.styles.speedLine, px, py, pz,
        -_camFwd.x * lineSpeed, -_camFwd.y * lineSpeed, -_camFwd.z * lineSpeed, o);
    }
    this.stats.lines += n;
  }

  // ─────────────────────────────────────────────────────── one-shots

  /**
   * A standalone boost puff, for `burst('nitro', …)` or a pickup pad.
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {THREE.Vector3|{x,y,z}|null} direction
   * @param {number} strength
   */
  puff(point, direction, strength = 1) {
    const P = this.P;
    if (!P || !this.enabled) return;
    const s = clamp(strength, 0, 2);
    const dx = direction?.x ?? 0, dy = direction?.y ?? 1, dz = direction?.z ?? 0;

    const o = resetOpts(_opts);
    o.speedJitter = 0.45;
    o.radius = 0.008;
    o.sizeMul = lerp(0.9, 1.8, s * 0.5);
    P.spawn(this.styles.ignite, point.x, point.y, point.z, 0, 0, 0, o);
    P.burstCone(this.styles.flame, point.x, point.y, point.z, dx, dy, dz,
      1.6 + s * 2.4, 0.45, Math.round(lerp(4, 16, s * 0.5)), o);
    P.burstCone(this.styles.spark, point.x, point.y, point.z, dx, dy, dz,
      2.4 + s * 4.0, 0.6, Math.round(lerp(4, 18, s * 0.5)), o);
    P.burstCone(this.styles.haze, point.x, point.y, point.z, dx, dy, dz,
      0.7 + s * 0.8, 0.7, Math.round(lerp(1, 4, s * 0.5)), o);
  }

  /** 0..1 boost level for a car — audio/camera can read this. */
  level(carId) { return this.states[(carId | 0) & 7]?.level ?? 0; }

  reset() { for (const s of this.states) s.reset(); this._lineAcc = 0; }
  dispose() { this.states.length = 0; }
}

const _opts = {
  speedJitter: 0.5, radius: 0, groundY: -1e6,
  inheritX: 0, inheritY: 0, inheritZ: 0,
  r: 1, g: 1, b: 1, alpha: 1, sizeMul: 1, lifeMul: 1,
  size: undefined, life: undefined, aspect: undefined,
  rot: undefined, spin: undefined, frame: undefined,
};
const _opts2 = {
  speedJitter: 0.5, radius: 0, groundY: -1e6,
  inheritX: 0, inheritY: 0, inheritZ: 0,
  r: 1, g: 1, b: 1, alpha: 1, sizeMul: 1, lifeMul: 1,
  size: undefined, life: undefined, aspect: undefined,
  rot: undefined, spin: undefined, frame: undefined,
};

export default Nitro;
