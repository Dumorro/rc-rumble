/**
 * RC RUMBLE — smoke.
 *
 * Three jobs:
 *
 * 1. **Tyre smoke.** A long burnout or a sustained drift heats the rubber; smoke
 *    builds up over about a second of continuous slip and then keeps pouring
 *    until the slip stops, with a heat value that decays slowly so a flick-flick
 *    transition keeps its smoke instead of stuttering. Tinted by the surface —
 *    rubber on rubber is thick and grey, rubber on sand barely smokes at all.
 *
 * 2. **Exhaust puffs.** Optional, opt-in per car: set
 *    `car.def.exhausts = [[x,y,z], ...]` (chassis-local metres) and a nitro or
 *    petrol-engined toy gets little puffs modulated by throttle and engine load.
 *    Electric cars (no `exhausts`) get nothing, which is correct.
 *
 * 3. **Lingering explosion smoke.** Thick, slow, heavily turbulent, rising and
 *    cooling from near-black through grey to a thin haze. This is the one place
 *    the turbulence field is turned right up.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/MathUtils.js';
import { surfaceFX } from './SurfaceFX.js';
import { LAYER, frand, frandRange } from './ParticleSystem.js';
import { SPR } from './ParticleAtlas.js';
import { resetOpts } from './Sparks.js';

const GRAV = CONFIG.physics.gravity;

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _local = new THREE.Vector3();

/** Per-car smoke bookkeeping. */
class SmokeState {
  constructor() {
    /** 0..1 accumulated tyre heat — the reason smoke lags the slip. */
    this.heat = 0;
    this.acc = 0;
    this.exhaustAcc = 0;
    this.lastSurface = 0;
  }
  reset() { this.heat = 0; this.acc = 0; this.exhaustAcc = 0; }
}

export class Smoke {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {import('./ParticleSystem.js').ParticleSystem} particles
   */
  constructor(game, particles) {
    this.game = game;
    this.P = particles;
    this.enabled = true;
    this.rate = 1;

    /** Slip above which the tyres start to cook. */
    this.heatThreshold = 0.42;
    /** Seconds of full slip to reach maximum smoke. */
    this.heatUpTime = 0.85;
    /** Seconds for the heat to bleed away once the slip stops. */
    this.coolTime = 1.7;

    /** @type {SmokeState[]} */
    this.states = [];
    for (let i = 0; i < Math.max(8, CONFIG.race.maxCars); i++) this.states.push(new SmokeState());

    this.styles = {};
    this.stats = { spawned: 0, hottest: 0 };
  }

  init() {
    const P = this.P;
    if (!P) return this;
    const S = this.styles;

    // ── tyre smoke: the fat, fast-growing, slowly-drifting one ──
    S.tyre = P.defineStyle('fx/smoke/tyre', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [1.1, 2.2],
      size: [0.045, 0.095],
      sizeCurve: [0.35, 1.2, 2.1, 3.0],
      alpha: 0.40,
      alphaCurve: [0, 1, 0.55, 0],
      colorCurve: [0.92, 1.0, 1.02, 1.0],
      gravity: GRAV * 0.012,
      drag: 1.9,
      rise: 1.35,
      turbulence: 2.6, turbScale: 3.4, turbSpeed: 0.95,
      spin: [-0.85, 0.85],
      sizeJitter: 0.30,
    });

    // ── a denser core so the plume has a readable silhouette ──
    S.tyreCore = P.defineStyle('fx/smoke/tyreCore', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE_PUFF,
      life: [0.7, 1.35],
      size: [0.030, 0.062],
      sizeCurve: [0.4, 1.1, 1.7, 2.2],
      alpha: 0.50,
      alphaCurve: [0, 1, 0.5, 0],
      gravity: 0,
      drag: 2.6,
      rise: 1.05,
      turbulence: 1.8, turbScale: 4.5,
      spin: [-1.4, 1.4],
      sizeJitter: 0.25,
    });

    // ── exhaust puff: small, quick, translucent ──
    S.exhaust = P.defineStyle('fx/smoke/exhaust', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.42, 0.85],
      size: [0.010, 0.024],
      sizeCurve: [0.35, 1.1, 1.9, 2.6],
      alpha: 0.26,
      alphaCurve: [0, 1, 0.55, 0],
      color: 0xb0aaa2,
      colorEnd: 0x8e8880,
      gravity: 0,
      drag: 3.4,
      rise: 0.95,
      turbulence: 1.6, turbScale: 7, turbSpeed: 1.4,
      spin: [-2.2, 2.2],
    });

    // ── a dark diesel-ish bark under hard throttle ──
    S.exhaustSoot = P.defineStyle('fx/smoke/exhaustSoot', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.55, 1.05],
      size: [0.012, 0.028],
      sizeCurve: [0.4, 1.2, 2.0, 2.7],
      alpha: 0.34,
      alphaCurve: [0, 1, 0.5, 0],
      color: 0x35302c,
      colorEnd: 0x6a645c,
      gravity: 0,
      drag: 3.0,
      rise: 1.15,
      turbulence: 2.0, turbScale: 6,
      spin: [-2.5, 2.5],
    });

    // ── explosion smoke: thick, slow, very turbulent, cools to haze ──
    S.blast = P.defineStyle('fx/smoke/blast', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [1.6, 3.4],
      size: [0.075, 0.17],
      sizeCurve: [0.35, 1.3, 2.3, 3.4],
      alpha: 0.62,
      alphaCurve: [0, 1, 0.55, 0],
      color: 0x2a2622,
      colorEnd: 0x8e8a84,
      colorCurve: [1.1, 1.0, 0.92, 0.8],
      gravity: 0,
      drag: 1.35,
      rise: 1.9,
      turbulence: 4.2, turbScale: 2.6, turbSpeed: 0.7,
      spin: [-0.7, 0.7],
      sizeJitter: 0.35,
    });

    // ── the hot inner ball of an explosion, before the smoke takes over ──
    S.blastCore = P.defineStyle('fx/smoke/blastCore', {
      layer: LAYER.ADD,
      sprite: SPR.FLAME, frames: 8, frameMode: 'life',
      life: [0.20, 0.44],
      size: [0.06, 0.14],
      sizeCurve: [0.45, 1.25, 1.6, 1.2],
      alpha: 1,
      alphaCurve: [1, 0.95, 0.5, 0],
      color: 0xffd9a0,
      colorEnd: 0xd04a08,
      colorCurve: [4.2, 2.8, 1.2, 0],
      gravity: 0,
      drag: 4.0,
      rise: 2.4,
      spin: [-1.5, 1.5],
    });

    // ── steam: water on something hot, or a frozen car thawing ──
    S.steam = P.defineStyle('fx/smoke/steam', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.8, 1.6],
      size: [0.020, 0.048],
      sizeCurve: [0.35, 1.2, 2.0, 2.7],
      alpha: 0.28,
      alphaCurve: [0, 1, 0.6, 0],
      color: 0xf2f6f8,
      gravity: 0,
      drag: 2.4,
      rise: 1.6,
      turbulence: 2.0, turbScale: 5, turbSpeed: 1.2,
      spin: [-1.2, 1.2],
    });

    return this;
  }

  // ─────────────────────────────────────────────────────── tyre smoke

  /**
   * @param {number} dt
   * @param {import('../vehicle/Car.js').Car[]} cars
   */
  update(dt, cars) {
    if (!this.enabled || !this.P || dt <= 0) return;
    const pressure = this.P.pressure(LAYER.LIT);
    const throttle = this.rate * (pressure > 0.9 ? 0.25 : (pressure > 0.75 ? 0.6 : 1));

    let hottest = 0;
    for (let c = 0; cars && c < cars.length; c++) {
      const car = cars[c];
      const st = this.states[(car?.id | 0) & 7];
      if (!car || !st) continue;
      this._tyres(car, st, dt, throttle);
      this._exhaust(car, st, dt, throttle);
      if (st.heat > hottest) hottest = st.heat;
    }
    this.stats.hottest = hottest;
  }

  _tyres(car, st, dt, throttle) {
    const wheels = car?.wheels;
    if (!wheels) { st.reset(); return; }

    // How hard are the driven/loaded tyres slipping right now?
    let slip = 0;
    let contacts = 0;
    let sid = car.dominantSurfaceId | 0;
    let hotWheel = null;
    for (let w = 0; w < wheels.length && w < 4; w++) {
      const wheel = wheels[w];
      if (!wheel || !wheel.contact) continue;
      contacts++;
      let t = clamp01(wheel.skidIntensity ?? 0);
      if (t === 0) {
        const sa = Math.abs(wheel.slipAngle ?? 0);
        const sr = Math.abs(wheel.slipRatio ?? 0);
        t = clamp01(Math.max(sa / 0.40, (sr - 0.12) / 0.5));
      }
      if (wheel.isSpinning) t = Math.max(t, 0.7);
      if (wheel.isLocked) t = Math.max(t, 0.55);
      if (t > slip) { slip = t; hotWheel = wheel; sid = wheel.surfaceId | 0; }
    }

    const surf = surfaceFX(sid);
    // Loose ground cannot cook rubber — the tyre just digs instead.
    const smokeAbility = surf.smokeRate * (1 - surf.loose * 0.85) * (1 - surf.wet * 0.9);

    const speed = Math.abs(car.speed ?? 0);
    // Rubber needs both slip and speed (or wheelspin from a standstill).
    const spinning = hotWheel?.isSpinning ? 1 : 0;
    const work = contacts > 0
      ? clamp01((slip - this.heatThreshold) / (1 - this.heatThreshold))
      * clamp01(Math.max(speed / 2.2, spinning * 0.9))
      : 0;

    if (work > 0) {
      st.heat = clamp01(st.heat + (work / this.heatUpTime) * dt);
    } else {
      st.heat = Math.max(0, st.heat - dt / this.coolTime);
    }

    const emit = st.heat * smokeAbility * throttle;
    if (emit < 0.03 || contacts === 0) return;

    const rate = lerp(0, 95, emit);
    st.acc += rate * dt;
    let n = st.acc | 0;
    st.acc -= n;
    if (n <= 0) return;
    if (n > 12) n = 12;                      // one frame cannot dump the pool

    const vel = car.body?.velocity;
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;

    const tint = surf.smokeColor;
    const o = resetOpts(_opts);
    o.r = tint[0]; o.g = tint[1]; o.b = tint[2];
    o.speedJitter = 0.55;
    o.inheritX = vx * 0.42;
    o.inheritY = Math.max(vy * 0.2, 0);
    o.inheritZ = vz * 0.42;
    o.sizeMul = lerp(0.7, 1.45, st.heat);
    o.lifeMul = lerp(0.75, 1.3, st.heat);

    // Emit from every slipping wheel, weighted by that wheel's own slip. The
    // running budget matters: without it four wheels could each take the full
    // frame allowance and quadruple the intended rate.
    let budget = n;
    for (let w = 0; w < wheels.length && w < 4 && budget > 0; w++) {
      const wheel = wheels[w];
      if (!wheel || !wheel.contact || !wheel.contactPoint) continue;
      let t = clamp01(wheel.skidIntensity ?? 0);
      if (t === 0) {
        const sa = Math.abs(wheel.slipAngle ?? 0);
        const sr = Math.abs(wheel.slipRatio ?? 0);
        t = clamp01(Math.max(sa / 0.40, (sr - 0.12) / 0.5));
      }
      if (wheel.isSpinning) t = Math.max(t, 0.7);
      if (t < this.heatThreshold * 0.7) continue;

      const share = Math.min(budget, Math.max(1, Math.round(n * t / Math.max(slip * 2.4, 0.6))));
      budget -= share;
      const cp = wheel.contactPoint;
      _n.copy(wheel.contactNormal ?? _n.set(0, 1, 0));
      if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
      else _n.normalize();

      const r = (wheel.radius ?? 0.033);
      o.radius = r * 0.55;
      // Smoke leaves the *back* of the contact patch and rolls up over the tyre.
      const px = cp.x + _n.x * r * 0.35;
      const py = cp.y + _n.y * r * 0.35;
      const pz = cp.z + _n.z * r * 0.35;

      this.P.burstCone(this.styles.tyre, px, py, pz,
        _n.x * 0.55 - vx * 0.06, _n.y * 0.55 + 0.5, _n.z * 0.55 - vz * 0.06,
        0.35 + st.heat * 0.75, 0.85, share, o);

      if (st.heat > 0.45 && frand() < st.heat * 0.7) {
        o.sizeMul = lerp(0.7, 1.3, st.heat);
        this.P.spawn(this.styles.tyreCore, px, py + r * 0.2, pz,
          _n.x * 0.3 + frandRange(-0.25, 0.25),
          0.55 + st.heat * 0.55,
          _n.z * 0.3 + frandRange(-0.25, 0.25), o);
        o.sizeMul = lerp(0.7, 1.45, st.heat);
      }
      this.stats.spawned += share;
    }
  }

  // ─────────────────────────────────────────────────────── exhaust

  _exhaust(car, st, dt, throttle) {
    const pipes = car?.def?.exhausts;
    if (!pipes || pipes.length === 0) return;
    const grp = car.group;
    if (!grp) return;

    const thr = clamp01(car.throttle ?? 0);
    const load = clamp01(car.engineLoad ?? thr);
    // Idle burble, plus a real belch when the throttle is planted under load.
    const intensity = 0.16 + thr * 0.55 + load * 0.4;
    const rate = intensity * 26 * throttle;
    st.exhaustAcc += rate * dt;
    let n = st.exhaustAcc | 0;
    st.exhaustAcc -= n;
    if (n <= 0) return;
    if (n > 6) n = 6;

    const vel = car.body?.velocity;
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;

    const o = resetOpts(_opts);
    o.speedJitter = 0.5;
    o.radius = 0.006;
    o.inheritX = vx * 0.75;
    o.inheritY = vy * 0.5;
    o.inheritZ = vz * 0.75;
    o.sizeMul = lerp(0.8, 1.5, intensity);

    // Backwards in world space, from the car's local -Z.
    // +Z is rearward. Normalize: a scaled car group would otherwise scale the
    // exhaust velocity too.
    _v.setFromMatrixColumn(grp.matrixWorld, 2).normalize();
    const bx = _v.x, by = _v.y, bz = _v.z;

    const soot = load > 0.62;
    for (let k = 0; k < n; k++) {
      const pipe = pipes[k % pipes.length];
      _local.set(pipe[0] ?? 0, pipe[1] ?? 0.02, pipe[2] ?? 0.13);
      _local.applyMatrix4(grp.matrixWorld);
      this.P.burstCone(soot && frand() < 0.35 ? this.styles.exhaustSoot : this.styles.exhaust,
        _local.x, _local.y, _local.z,
        bx * 0.8 + 0.0, by * 0.8 + 0.45, bz * 0.8,
        0.35 + intensity * 1.1, 0.55, 1, o);
    }
    this.stats.spawned += n;
  }

  // ─────────────────────────────────────────────────────── one-shots

  /**
   * Lingering smoke from an explosion.
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {number} strength 0..1+
   * @param {number} [radius] metres the initial ball fills
   */
  explosion(point, strength = 1, radius = 0.18) {
    const P = this.P;
    if (!P || !this.enabled) return;
    const s = clamp(strength, 0, 2);

    const o = resetOpts(_opts);
    o.speedJitter = 0.55;
    o.radius = radius * 0.4;
    o.sizeMul = lerp(0.75, 1.9, s * 0.5);
    o.lifeMul = lerp(0.85, 1.5, s * 0.5);

    // hot core first
    const coreN = Math.round(lerp(4, 18, s * 0.5) * this.rate);
    P.burstDisc(this.styles.blastCore, point.x, point.y, point.z,
      radius * 0.35, 1.4 + s * 2.2, 1.1, coreN, o);

    // then the smoke ball, thrown outward in all directions
    const n = Math.round(lerp(8, 34, s * 0.5) * this.rate);
    for (let k = 0; k < n; k++) {
      const a = frand() * Math.PI * 2;
      const el = frandRange(-0.35, 1.0);
      const cl = Math.cos(el);
      P.burstCone(this.styles.blast, point.x, point.y + radius * 0.2, point.z,
        Math.cos(a) * cl, Math.sin(el) + 0.35, Math.sin(a) * cl,
        0.9 + s * 1.9, 0.35, 1, o);
    }
    this.stats.spawned += n + coreN;
  }

  /**
   * A puff of steam — water hitting something hot, a thawing car.
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {number} amount 0..1
   */
  steam(point, amount = 1) {
    const P = this.P;
    if (!P || !this.enabled) return;
    const o = resetOpts(_opts);
    o.speedJitter = 0.5;
    o.radius = 0.02;
    o.sizeMul = lerp(0.8, 1.6, amount);
    const n = Math.round(lerp(3, 14, clamp01(amount)) * this.rate);
    P.burstCone(this.styles.steam, point.x, point.y, point.z, 0, 1, 0,
      0.4 + amount * 0.9, 0.8, n, o);
  }

  /**
   * A generic puff, used by `FXSystem.burst('smoke', …)`.
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {object} [o] `{ strength, color, size, count, up }`
   */
  puff(point, o = {}) {
    const P = this.P;
    if (!P || !this.enabled) return;
    const strength = clamp01(o.strength ?? 0.5);
    const op = resetOpts(_opts);
    op.speedJitter = 0.5;
    op.radius = o.radius ?? 0.015;
    op.sizeMul = (o.sizeMul ?? 1) * lerp(0.7, 1.5, strength);
    if (o.color) {
      const c = o.color;
      if (Array.isArray(c)) { op.r = c[0]; op.g = c[1]; op.b = c[2]; }
    }
    const n = Math.round(o.count ?? lerp(2, 12, strength));
    P.burstCone(this.styles.tyre, point.x, point.y, point.z,
      0, o.up ?? 1, 0, 0.3 + strength * 1.2, 0.8, n, op);
  }

  reset() { for (const s of this.states) s.reset(); }
  dispose() { this.states.length = 0; }
}

const _opts = {
  speedJitter: 0.5, radius: 0, groundY: -1e6,
  inheritX: 0, inheritY: 0, inheritZ: 0,
  r: 1, g: 1, b: 1, alpha: 1, sizeMul: 1, lifeMul: 1,
  size: undefined, life: undefined, aspect: undefined,
  rot: undefined, spin: undefined, frame: undefined,
};

export default Smoke;
