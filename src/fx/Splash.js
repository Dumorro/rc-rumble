/**
 * RC RUMBLE — water.
 *
 * Four separate effects that together make a puddle feel wet:
 *
 * 1. **Entry crown.** The moment a wheel (or a whole car) breaks the surface, a
 *    sheet of water flares up in a ring. Uses the 8-frame animated splash sprite
 *    so a single particle *is* a crown collapsing.
 *
 * 2. **Rooster tail.** While driving through shallow water, each wheel throws a
 *    continuous fan of droplets backwards and up — dense, fast, short-lived, with
 *    a fine mist behind it that catches the light.
 *
 * 3. **Ripples.** Expanding rings drawn flat on the water surface, laid down at a
 *    fixed spatial interval so they read as a wake rather than a strobe.
 *
 * 4. **Wet trails.** Leaving water, the tyres carry it out: for a few seconds the
 *    car lays down darkening wet marks and flings a thinning spray, both drying
 *    out on a per-wheel timer. This is the detail people notice without being
 *    able to say why the puddle felt real.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/MathUtils.js';
import { surfaceFX, isWater } from './SurfaceFX.js';
import { LAYER, frand, frandRange } from './ParticleSystem.js';
import { SPR } from './ParticleAtlas.js';
import { resetOpts } from './Sparks.js';

const GRAV = CONFIG.physics.gravity;

const _n = new THREE.Vector3();
const _rn = new THREE.Vector3();

/** Seconds a tyre stays visibly wet after leaving the water. */
const WET_TIME = 3.4;

class WheelWater {
  constructor() {
    /** 0..1 how wet this tyre is; decays over WET_TIME. */
    this.wet = 0;
    /** Was this wheel in water last frame? Used for the entry crown. */
    this.submerged = false;
    this.acc = 0;
    this.mistAcc = 0;
    this.rippleDist = 0;
    this.trailAcc = 0;
    this.lastX = 0; this.lastZ = 0;
    this.hasLast = false;
    this.entryCooldown = 0;
  }
  reset() {
    this.wet = 0; this.submerged = false; this.acc = 0; this.mistAcc = 0;
    this.rippleDist = 0; this.trailAcc = 0; this.hasLast = false; this.entryCooldown = 0;
  }
}

export class Splash {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {import('./ParticleSystem.js').ParticleSystem} particles
   * @param {import('./Decals.js').Decals|null} decals
   */
  constructor(game, particles, decals) {
    this.game = game;
    this.P = particles;
    this.decals = decals;
    this.enabled = true;
    this.rate = 1;

    /** Metres of travel between wake ripples. */
    this.rippleSpacing = 0.075;

    /** @type {WheelWater[]} carId*4 + wheel */
    this.wheels = [];
    for (let i = 0; i < CONFIG.race.maxCars * 4; i++) this.wheels.push(new WheelWater());

    /** Per-car body-splash debounce. */
    this._bodyCooldown = new Float32Array(CONFIG.race.maxCars);

    this.styles = {};
    this.stats = { spawned: 0, ripples: 0, wetWheels: 0 };
  }

  init() {
    const P = this.P;
    if (!P) return this;
    const S = this.styles;

    // ── the animated crown: one particle = one collapsing sheet of water ──
    S.crown = P.defineStyle('fx/splash/crown', {
      layer: LAYER.ALPHA,
      sprite: SPR.SPLASH, frames: 8, frameMode: 'life',
      life: [0.30, 0.52],
      size: [0.030, 0.075],
      sizeCurve: [0.55, 1.05, 1.35, 1.55],
      alpha: 0.80,
      alphaCurve: [1, 1, 0.7, 0],
      color: 0xeaf6fb,
      colorEnd: 0xbcd8e6,
      gravity: GRAV * 0.10,
      drag: 3.6,
      spin: [-0.35, 0.35],
      sizeJitter: 0.25,
    });

    // ── droplets: the fast heavy fraction ──
    S.drop = P.defineStyle('fx/splash/drop', {
      layer: LAYER.ALPHA,
      sprite: SPR.DROPLET,
      life: [0.28, 0.62],
      size: [0.0035, 0.010],
      aspect: 1.7,
      alpha: 0.9,
      alphaCurve: [1, 1, 0.85, 0],
      color: 0xdff0f8,
      colorEnd: 0xa8cddd,
      gravity: GRAV,
      drag: 0.55,
      spin: [-3, 3],
      sizeJitter: 0.3,
    });

    // ── streaked droplets for the fast rooster tail ──
    S.jet = P.defineStyle('fx/splash/jet', {
      layer: LAYER.STREAK,
      sprite: SPR.STREAK,
      life: [0.16, 0.34],
      size: [0.0028, 0.0060],
      aspect: 1.6,
      alpha: 0.55,
      alphaCurve: [1, 0.9, 0.6, 0],
      color: 0xeaf7ff,
      intensity: 1.35,
      stretch: 0.012,
      gravity: GRAV * 0.9,
      drag: 0.7,
    });

    // ── mist: the halo that makes the tail glow in sunlight ──
    S.mist = P.defineStyle('fx/splash/mist', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.35, 0.85],
      size: [0.018, 0.048],
      sizeCurve: [0.4, 1.15, 1.8, 2.3],
      alpha: 0.24,
      alphaCurve: [0, 1, 0.55, 0],
      color: 0xf0fbff,
      gravity: 0,
      drag: 3.4,
      rise: 0.55,
      turbulence: 1.6, turbScale: 6, turbSpeed: 1.4,
      spin: [-1, 1],
    });

    // ── foam that sits on the surface where the wheel churns ──
    S.foam = P.defineStyle('fx/splash/foam', {
      layer: LAYER.GROUND,
      sprite: SPR.SOFT,
      life: [0.45, 0.95],
      size: [0.014, 0.034],
      sizeCurve: [0.6, 1.15, 1.5, 1.75],
      alpha: 0.34,
      alphaCurve: [0.6, 1, 0.5, 0],
      color: 0xd8f0fa,
      colorCurve: [1.0, 0.9, 0.75, 0.6],
    });

    // ── expanding wake ripple, drawn flat on the water ──
    S.ripple = P.defineStyle('fx/splash/ripple', {
      layer: LAYER.GROUND,
      sprite: SPR.RIPPLE,
      life: [0.75, 1.4],
      size: [0.020, 0.036],
      sizeCurve: [0.3, 1.4, 2.6, 3.8],
      alpha: 0.32,
      alphaCurve: [0.85, 0.7, 0.35, 0],
      color: 0xbfe4f2,
      colorCurve: [1.1, 0.95, 0.7, 0.4],
    });

    // ── a big ring for a whole-car entry ──
    S.bigRipple = P.defineStyle('fx/splash/bigRipple', {
      layer: LAYER.GROUND,
      sprite: SPR.RIPPLE,
      life: [1.1, 1.8],
      size: [0.05, 0.085],
      sizeCurve: [0.25, 1.5, 3.0, 4.6],
      alpha: 0.42,
      alphaCurve: [1, 0.75, 0.35, 0],
      color: 0xcdeaf6,
      colorCurve: [1.1, 0.95, 0.65, 0.3],
    });

    // ── the residual spray a wet tyre flings on dry land ──
    S.wetFling = P.defineStyle('fx/splash/wetFling', {
      layer: LAYER.ALPHA,
      sprite: SPR.DROPLET,
      life: [0.25, 0.55],
      size: [0.0025, 0.0065],
      aspect: 1.5,
      alpha: 0.6,
      alphaCurve: [1, 1, 0.7, 0],
      color: 0xd6ebf5,
      gravity: GRAV,
      drag: 0.8,
      bounce: 0.05,
      stick: true,
      fadeOnStop: true,
    });

    return this;
  }

  // ─────────────────────────────────────────────────────────── update

  /**
   * @param {number} dt
   * @param {import('../vehicle/Car.js').Car[]} cars
   */
  update(dt, cars) {
    if (!this.enabled || !this.P || dt <= 0) return;
    let wet = 0;
    for (let i = 0; i < this._bodyCooldown.length; i++) {
      if (this._bodyCooldown[i] > 0) this._bodyCooldown[i] -= dt;
    }
    for (let c = 0; cars && c < cars.length; c++) {
      wet += this._car(cars[c], dt);
    }
    this.stats.wetWheels = wet;
  }

  _car(car, dt) {
    const wheels = car?.wheels;
    if (!wheels) return 0;
    const carId = (car.id | 0) & 7;
    let wetCount = 0;

    const vel = car.body?.velocity;
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;
    const speed = Math.hypot(vx, vy, vz);

    for (let w = 0; w < wheels.length && w < 4; w++) {
      const wheel = wheels[w];
      const st = this.wheels[carId * 4 + w];
      if (!wheel || !st) continue;

      if (st.entryCooldown > 0) st.entryCooldown -= dt;

      const inWater = !!(wheel.contact && isWater(wheel.surfaceId));

      if (inWater) {
        const cp = wheel.contactPoint;
        _n.copy(wheel.contactNormal ?? _n.set(0, 1, 0));
        if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
        else _n.normalize();

        // ── entry crown, once per submersion ──
        if (!st.submerged && st.entryCooldown <= 0 && cp) {
          const impact = Math.max(speed, Math.abs(vy) * 1.4);
          this._crown(cp, _n, clamp01(impact / 7) * 0.8 + 0.2, vx, vy, vz);
          st.entryCooldown = 0.12;
        }
        st.submerged = true;
        st.wet = 1;

        if (cp) {
          this._roosterTail(car, wheel, st, cp, dt, speed, vx, vy, vz);
          this._wake(st, cp, dt, speed);
        }
      } else {
        if (st.submerged) {
          // leaving the water: one last flick of spray off the tread
          const cp = wheel.contactPoint;
          if (cp && speed > 1.2) {
            this._exitFlick(cp, speed, vx, vy, vz);
          }
        }
        st.submerged = false;
        if (st.wet > 0) {
          st.wet = Math.max(0, st.wet - dt / WET_TIME);
          if (wheel.contact && wheel.contactPoint) {
            this._wetTrail(car, wheel, st, dt, speed, vx, vy, vz);
          }
        }
      }
      if (st.wet > 0.02) wetCount++;
    }
    return wetCount;
  }

  // ───────────────────────────────────────────────────── sub-effects

  /** The flared sheet + droplets of an entry. */
  _crown(point, normal, strength, vx, vy, vz) {
    const P = this.P;
    const S = this.styles;
    const s = clamp01(strength);

    const o = resetOpts(_opts);
    o.speedJitter = 0.4;
    o.radius = 0.010;
    o.sizeMul = lerp(0.7, 1.6, s);
    o.inheritX = vx * 0.30;
    o.inheritY = 0;
    o.inheritZ = vz * 0.30;

    const px = point.x, py = point.y + 0.004, pz = point.z;

    // A ring of crowns rather than one: reads as a sheet, not a sprite.
    const crowns = Math.round(lerp(2, 7, s) * this.rate);
    for (let k = 0; k < crowns; k++) {
      const a = frand() * Math.PI * 2;
      const r = frandRange(0, 0.016 + s * 0.022);
      P.spawn(S.crown, px + Math.cos(a) * r, py, pz + Math.sin(a) * r,
        Math.cos(a) * (0.25 + s * 0.9), 0.5 + s * 1.6, Math.sin(a) * (0.25 + s * 0.9), o);
    }

    // droplets fired up and out
    const drops = Math.round(lerp(6, 34, s) * this.rate);
    o.speedJitter = 0.6;
    o.sizeMul = lerp(0.8, 1.5, s);
    P.burstCone(S.drop, px, py, pz, normal.x, normal.y + 0.5, normal.z,
      1.4 + s * 4.2, 0.85, drops, o);

    // mist halo
    const mist = Math.round(lerp(2, 10, s) * this.rate);
    o.sizeMul = lerp(0.9, 1.8, s);
    P.burstCone(S.mist, px, py + 0.008, pz, normal.x, normal.y + 0.6, normal.z,
      0.4 + s * 1.1, 0.9, mist, o);

    // one big surface ring
    const ro = resetOpts(_opts2);
    ro.sizeMul = lerp(0.8, 2.0, s);
    P.spawn(S.bigRipple, px, py + 0.002, pz, normal.x, normal.y, normal.z, ro);

    if (this.decals && s > 0.45) {
      this.decals.project('waterRing', point, normal, 0.07 + s * 0.10,
        { alpha: 0.28 * s, life: 2.2 });
    }
    this.stats.spawned += crowns + drops + mist;
  }

  /** The continuous fan a wheel throws while ploughing through water. */
  _roosterTail(car, wheel, st, cp, dt, speed, vx, vy, vz) {
    const P = this.P;
    const S = this.styles;
    if (speed < 0.4) return;

    _rn.copy(wheel.contactNormal ?? _rn.set(0, 1, 0));
    if (_rn.lengthSq() < 1e-6) _rn.set(0, 1, 0);
    else _rn.normalize();

    const surf = surfaceFX(9);
    const load = this._loadFactor(wheel, car);
    let slip = clamp01(wheel.skidIntensity ?? 0);
    if (slip === 0) {
      const sa = Math.abs(wheel.slipAngle ?? 0);
      const sr = Math.abs(wheel.slipRatio ?? 0);
      slip = clamp01(Math.max(sa / 0.42, (sr - 0.08) / 0.45));
    }
    // Water sprays from displacement, so *speed* matters far more than slip.
    const work = clamp01(clamp01(speed / 5.5) * (0.55 + slip * 0.65) * load);
    if (work < 0.03) return;

    const acc = st || _fallbackAcc;

    const rate = surf.sprayRate * work * this.rate;
    acc.acc += rate * dt;
    let n = acc.acc | 0;
    acc.acc -= n;
    if (n > 16) n = 16;

    const inh = 0.35;
    const o = resetOpts(_opts);
    o.speedJitter = 0.55;
    o.radius = (wheel.width ?? 0.028) * 0.5;
    o.inheritX = vx * inh;
    o.inheritY = Math.max(vy * inh, 0);
    o.inheritZ = vz * inh;
    o.sizeMul = lerp(0.7, 1.4, work);

    // Backwards along travel, lifted hard: the tail rises behind the wheel.
    const vl = Math.hypot(vx, vy, vz) || 1;
    const dx = -vx / vl * 0.55 + _rn.x * 0.45;
    const dy = -vy / vl * 0.25 + _rn.y * 0.75 + 0.45;
    const dz = -vz / vl * 0.55 + _rn.z * 0.45;

    const px = cp.x + _rn.x * 0.005, py = cp.y + _rn.y * 0.005, pz = cp.z + _rn.z * 0.005;
    const eject = surf.spraySpeed * (0.35 + 0.9 * clamp01(speed / 6)) * (0.6 + work * 0.7);

    if (n > 0) {
      // fast streaks read the speed, round droplets read the mass
      const jets = Math.round(n * 0.55);
      P.burstCone(S.jet, px, py, pz, dx, dy, dz, eject * 1.25, 0.42, jets, o);
      P.burstCone(S.drop, px, py, pz, dx, dy, dz, eject * 0.95, 0.6, n - jets, o);
      this.stats.spawned += n;
    }

    // mist and surface foam at a lower rate
    acc.mistAcc += rate * 0.22 * dt;
    let m = acc.mistAcc | 0;
    acc.mistAcc -= m;
    if (m > 5) m = 5;
    if (m > 0) {
      o.sizeMul = lerp(0.9, 1.7, work);
      P.burstCone(S.mist, px, py + 0.01, pz, dx, dy * 0.8, dz, eject * 0.35, 0.8, m, o);

      const fo = resetOpts(_opts2);
      fo.sizeMul = lerp(0.8, 1.6, work);
      for (let k = 0; k < m; k++) {
        P.spawn(S.foam, cp.x + frandRange(-0.02, 0.02), cp.y + 0.003,
          cp.z + frandRange(-0.02, 0.02), _rn.x, _rn.y, _rn.z, fo);
      }
    }
  }

  /** Lay a wake ripple every `rippleSpacing` metres of travel. */
  _wake(st, cp, dt, speed) {
    st.rippleDist += speed * dt;
    if (st.rippleDist < this.rippleSpacing) return;
    st.rippleDist = 0;
    if (speed < 0.5) return;

    const o = resetOpts(_opts2);
    o.sizeMul = lerp(0.7, 1.6, clamp01(speed / 6));
    o.alpha = lerp(0.5, 1, clamp01(speed / 4));
    this.P.spawn(this.styles.ripple, cp.x, cp.y + 0.0025, cp.z, 0, 1, 0, o);
    this.stats.ripples++;
  }

  /** One flick of water off the tread as the wheel leaves the puddle. */
  _exitFlick(cp, speed, vx, vy, vz) {
    const o = resetOpts(_opts);
    o.speedJitter = 0.55;
    o.radius = 0.008;
    o.inheritX = vx * 0.4; o.inheritY = 0; o.inheritZ = vz * 0.4;
    const n = Math.round(clamp(speed * 2.2, 3, 16) * this.rate);
    const vl = Math.hypot(vx, vy, vz) || 1;
    this.P.burstCone(this.styles.drop, cp.x, cp.y + 0.01, cp.z,
      -vx / vl * 0.4, 0.9, -vz / vl * 0.4, 1.2 + speed * 0.35, 0.8, n, o);
  }

  /**
   * A wet tyre on dry land: thinning spray plus a darkening wet mark that dries
   * out. The mark goes through the decal projector so it wraps the geometry.
   */
  _wetTrail(car, wheel, st, dt, speed, vx, vy, vz) {
    if (st.wet < 0.05 || speed < 0.5) return;
    const cp = wheel.contactPoint;
    const surf = surfaceFX(wheel.surfaceId | 0);

    // ── spray ──
    const rate = 26 * st.wet * clamp01(speed / 4) * this.rate;
    st.trailAcc += rate * dt;
    let n = st.trailAcc | 0;
    st.trailAcc -= n;
    if (n > 4) n = 4;
    if (n > 0) {
      const o = resetOpts(_opts);
      o.speedJitter = 0.6;
      o.radius = (wheel.width ?? 0.028) * 0.45;
      o.groundY = cp.y + 0.002;
      o.inheritX = vx * 0.35; o.inheritY = 0; o.inheritZ = vz * 0.35;
      o.sizeMul = lerp(0.7, 1.15, st.wet);
      o.alpha = st.wet;
      const vl = Math.hypot(vx, vy, vz) || 1;
      this.P.burstCone(this.styles.wetFling, cp.x, cp.y + 0.006, cp.z,
        -vx / vl * 0.5, 0.85, -vz / vl * 0.5, 0.7 + speed * 0.28, 0.75, n, o);
      this.stats.spawned += n;
    }

    // ── wet patch decal, spaced out along the trail ──
    if (!this.decals || surf.decal < 0.3) return;
    if (!st.hasLast) { st.lastX = cp.x; st.lastZ = cp.z; st.hasLast = true; return; }
    const dx = cp.x - st.lastX, dz = cp.z - st.lastZ;
    if (dx * dx + dz * dz < 0.055 * 0.055) return;
    st.lastX = cp.x; st.lastZ = cp.z;

    _n.copy(wheel.contactNormal ?? _n.set(0, 1, 0));
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    else _n.normalize();
    this.decals.project('wet', cp, _n, (wheel.width ?? 0.028) * 1.2, {
      alpha: 0.30 * st.wet * surf.decal,
      life: lerp(2.0, 5.5, st.wet),
      fadeIn: 0.04,
    });
  }

  // ─────────────────────────────────────────────────────── one-shots

  /**
   * A whole-car entry — much bigger than a wheel splash. Called by FXSystem when
   * a car lands in water, or imperatively via `burst('splash', …)`.
   *
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {number} strength 0..1
   * @param {THREE.Vector3|{x,y,z}|null} [velocity]
   * @param {number} [carId] for debounce; omit for imperative bursts
   */
  bigSplash(point, strength = 1, velocity = null, carId = -1) {
    const P = this.P;
    if (!P || !this.enabled) return;
    if (carId >= 0) {
      const i = carId & 7;
      if (this._bodyCooldown[i] > 0) return;
      this._bodyCooldown[i] = 0.35;
    }
    const s = clamp01(strength);
    _n.set(0, 1, 0);
    const vx = velocity?.x ?? 0, vy = velocity?.y ?? 0, vz = velocity?.z ?? 0;

    const o = resetOpts(_opts);
    o.speedJitter = 0.45;
    o.radius = 0.02 + s * 0.04;
    o.sizeMul = lerp(1.1, 2.6, s);
    o.inheritX = vx * 0.22; o.inheritY = 0; o.inheritZ = vz * 0.22;

    const px = point.x, py = point.y + 0.006, pz = point.z;

    // ring of crowns
    const crowns = Math.round(lerp(5, 16, s) * this.rate);
    for (let k = 0; k < crowns; k++) {
      const a = (k / crowns) * Math.PI * 2 + frandRange(-0.3, 0.3);
      const r = 0.03 + s * 0.07;
      P.spawn(this.styles.crown, px + Math.cos(a) * r, py, pz + Math.sin(a) * r,
        Math.cos(a) * (0.7 + s * 1.9), 1.1 + s * 2.6, Math.sin(a) * (0.7 + s * 1.9), o);
    }

    // droplet dome
    o.sizeMul = lerp(1.0, 1.9, s);
    const drops = Math.round(lerp(20, 90, s) * this.rate);
    P.burstCone(this.styles.drop, px, py, pz, 0, 1, 0, 2.2 + s * 5.5, 1.0, drops, o);

    // mist cloud
    o.sizeMul = lerp(1.2, 2.6, s);
    const mist = Math.round(lerp(6, 22, s) * this.rate);
    P.burstCone(this.styles.mist, px, py + 0.01, pz, 0, 1, 0, 0.6 + s * 1.4, 1.0, mist, o);

    // two nested rings so the wake reads as expanding, not popping
    const ro = resetOpts(_opts2);
    ro.sizeMul = lerp(1.2, 3.2, s);
    P.spawn(this.styles.bigRipple, px, py, pz, 0, 1, 0, ro);
    ro.sizeMul *= 0.6;
    ro.lifeMul = 0.75;
    P.spawn(this.styles.bigRipple, px, py, pz, 0, 1, 0, ro);

    if (this.decals) {
      this.decals.project('waterRing', point, _n, 0.14 + s * 0.22, {
        alpha: 0.34 * s, life: 2.8,
      });
    }
    void vy;
    this.stats.spawned += crowns + drops + mist;
  }

  _loadFactor(wheel, car) {
    const load = wheel.load;
    if (typeof load !== 'number' || load <= 0) return 1;
    const nominal = (car.body?.mass ?? 1.6) * 19.6 * 0.25;
    return clamp(load / Math.max(nominal, 0.05), 0.25, 1.6);
  }

  /** How wet a car's tyres are, 0..1 — audio and handling can read this. */
  wetness(carId) {
    const base = ((carId | 0) & 7) * 4;
    let m = 0;
    for (let w = 0; w < 4; w++) {
      const v = this.wheels[base + w]?.wet ?? 0;
      if (v > m) m = v;
    }
    return m;
  }

  resetCar(carId) {
    const base = ((carId | 0) & 7) * 4;
    for (let w = 0; w < 4; w++) this.wheels[base + w]?.reset();
    this._bodyCooldown[(carId | 0) & 7] = 0;
  }

  reset() {
    for (const w of this.wheels) w.reset();
    this._bodyCooldown.fill(0);
  }

  dispose() { this.wheels.length = 0; }
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

/** Used when a rooster tail cannot find its per-wheel accumulator. */
const _fallbackAcc = { acc: 0, mistAcc: 0 };

export default Splash;
