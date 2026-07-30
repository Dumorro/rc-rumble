/**
 * RC RUMBLE — surface-driven wheel spray.
 *
 * Every one of the sixteen canonical surfaces throws up something different
 * when a tyre works it, and getting that right is most of what sells the RC
 * scale: a 33 mm wheel scrabbling in gravel should fling stones that *bounce*,
 * grass should shed blades and clippings, sand should peel off in low broad
 * sheets, dirt should billow into a plume you lose the car in.
 *
 * Emission rate comes from slip × load × speed, exactly like the marks, plus a
 * baseline "rolling dust" term so a car cruising over dry dirt still leaves a
 * faint trail behind it.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/MathUtils.js';
import { surfaceFX, SPRAY } from './SurfaceFX.js';
import { LAYER, frand, frandRange } from './ParticleSystem.js';
import { SPR } from './ParticleAtlas.js';

const GRAV = CONFIG.physics.gravity;      // −19.6

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

/** Per-wheel emission accumulators. Fractional rates must not be truncated. */
class SprayEmitter {
  constructor() {
    this.acc = 0;
    this.accChip = 0;
    this.accSheet = 0;
    this.wetTimer = 0;
    this.lastSurface = -1;
  }
  reset() { this.acc = 0; this.accChip = 0; this.accSheet = 0; }
}

export class Dust {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {import('./ParticleSystem.js').ParticleSystem} particles
   */
  constructor(game, particles) {
    this.game = game;
    this.P = particles;
    this.enabled = true;

    /** Global multiplier the load governor drives. */
    this.rate = 1;

    /** @type {SprayEmitter[]} carId*4 + wheel */
    this.emitters = [];
    for (let i = 0; i < Math.max(8, CONFIG.race.maxCars) * 4; i++) this.emitters.push(new SprayEmitter());

    this.styles = {};
    this.stats = { spawned: 0 };
  }

  // ─────────────────────────────────────────────────────────── styles

  init() {
    const P = this.P;
    if (!P) return this;
    const S = this.styles;

    // ── fine airborne dust: hard floors, concrete, generic ──
    S.dust = P.defineStyle('fx/dust', {
      layer: LAYER.LIT,
      sprite: SPR.DUST, frames: 4, frameMode: 'random',
      life: [0.55, 1.05],
      size: [0.030, 0.062],
      sizeCurve: [0.45, 1.0, 1.5, 1.85],
      alpha: 0.36,
      alphaCurve: [0, 1, 0.62, 0],
      gravity: GRAV * 0.045,
      drag: 2.6,
      rise: 0.55,
      turbulence: 1.5, turbScale: 5.5, turbSpeed: 1.5,
      spin: [-1.5, 1.5],
      sizeJitter: 0.25,
    });

    // ── the big dirt plume: the signature Re-Volt off-road look ──
    S.plume = P.defineStyle('fx/plume', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.95, 1.9],
      size: [0.055, 0.115],
      sizeCurve: [0.4, 1.15, 1.85, 2.5],
      alpha: 0.52,
      alphaCurve: [0, 1, 0.55, 0],
      colorCurve: [1.05, 1.0, 0.9, 0.78],
      gravity: GRAV * 0.03,
      drag: 2.1,
      rise: 1.15,
      turbulence: 2.4, turbScale: 4.0, turbSpeed: 1.15,
      spin: [-1.1, 1.1],
      sizeJitter: 0.30,
    });

    // ── broad low sand sheets ──
    S.sheet = P.defineStyle('fx/sandSheet', {
      layer: LAYER.LIT,
      sprite: SPR.DUST, frames: 4, frameMode: 'random',
      life: [0.7, 1.35],
      size: [0.055, 0.11],
      aspect: 0.55,
      sizeCurve: [0.5, 1.1, 1.55, 1.9],
      alpha: 0.50,
      alphaCurve: [0, 1, 0.6, 0],
      gravity: GRAV * 0.09,
      drag: 3.4,
      rise: 0.30,
      turbulence: 1.0, turbScale: 4.5,
      spin: [-0.6, 0.6],
      sizeJitter: 0.25,
    });

    // ── grains: the heavy fraction of sand/dirt that arcs and lands ──
    S.grain = P.defineStyle('fx/grain', {
      layer: LAYER.ALPHA,
      sprite: SPR.SOFT,
      life: [0.35, 0.7],
      size: [0.004, 0.010],
      sizeCurve: [1, 1, 1, 0.85],
      alpha: 0.85,
      alphaCurve: [1, 1, 1, 0],
      gravity: GRAV,
      drag: 0.35,
      bounce: 0.18,
      groundFriction: 0.55,
      spin: [-8, 8],
    });

    // ── gravel chips: solid, bouncy, catch the light ──
    S.chip = P.defineStyle('fx/chip', {
      layer: LAYER.ALPHA,
      sprite: SPR.CHIP, frames: 4, frameMode: 'random',
      life: [0.75, 1.6],
      size: [0.006, 0.014],
      alpha: 1,
      alphaCurve: [1, 1, 1, 0],
      gravity: GRAV,
      drag: 0.22,
      bounce: 0.36,
      groundFriction: 0.42,
      spin: [-16, 16],
      sizeJitter: 0.3,
    });

    // ── grass blades + clippings ──
    S.blade = P.defineStyle('fx/blade', {
      layer: LAYER.ALPHA,
      sprite: SPR.BLADE, frames: 4, frameMode: 'random',
      life: [0.7, 1.5],
      size: [0.008, 0.020],
      aspect: 2.2,
      alpha: 1,
      alphaCurve: [1, 1, 0.95, 0],
      gravity: GRAV * 0.55,
      drag: 2.2,
      bounce: 0.10,
      groundFriction: 0.7,
      spin: [-14, 14],
      sizeJitter: 0.35,
    });

    S.clipping = P.defineStyle('fx/clipping', {
      layer: LAYER.LIT,
      sprite: SPR.DUST, frames: 4, frameMode: 'random',
      life: [0.5, 1.0],
      size: [0.018, 0.040],
      sizeCurve: [0.6, 1.0, 1.25, 1.4],
      alpha: 0.34,
      alphaCurve: [0, 1, 0.6, 0],
      gravity: GRAV * 0.10,
      drag: 3.0,
      turbulence: 1.2, turbScale: 6,
      spin: [-2, 2],
    });

    // ── carpet lint ──
    S.lint = P.defineStyle('fx/lint', {
      layer: LAYER.ALPHA,
      sprite: SPR.POLLEN,
      life: [0.9, 1.9],
      size: [0.004, 0.011],
      alpha: 0.65,
      alphaCurve: [0, 1, 0.8, 0],
      gravity: GRAV * 0.035,
      drag: 3.6,
      turbulence: 1.8, turbScale: 7, turbSpeed: 1.7,
      spin: [-6, 6],
    });

    // ── ice shavings: sparkle rather than dust ──
    S.crystal = P.defineStyle('fx/iceCrystal', {
      layer: LAYER.ADD,
      sprite: SPR.SPARK,
      life: [0.28, 0.62],
      size: [0.005, 0.013],
      alpha: 0.85,
      alphaCurve: [1, 0.9, 0.5, 0],
      color: 0xdff2ff,
      colorEnd: 0x8fc8e8,
      intensity: 2.2,
      gravity: GRAV * 0.75,
      drag: 1.2,
      bounce: 0.2,
      spin: [-10, 10],
    });

    S.iceMist = P.defineStyle('fx/iceMist', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.5, 1.0],
      size: [0.025, 0.055],
      sizeCurve: [0.5, 1.0, 1.5, 1.8],
      alpha: 0.26,
      alphaCurve: [0, 1, 0.6, 0],
      color: 0xeaf7ff,
      gravity: GRAV * 0.02,
      drag: 2.8,
      rise: 0.4,
      turbulence: 1.4, turbScale: 5,
    });

    // ── oil droplets flicked off a slick ──
    S.slick = P.defineStyle('fx/oilFleck', {
      layer: LAYER.ALPHA,
      sprite: SPR.DROPLET,
      life: [0.4, 0.85],
      size: [0.005, 0.012],
      aspect: 1.5,
      alpha: 0.9,
      alphaCurve: [1, 1, 0.9, 0],
      color: 0x1a1725,
      gravity: GRAV,
      drag: 0.6,
      bounce: 0.05,
      stick: true,
      fadeOnStop: true,
      spin: [-4, 4],
    });

    // ── the flat "skirt" of dust that hugs the ground under a sliding car ──
    S.skirt = P.defineStyle('fx/dustSkirt', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.6, 1.2],
      size: [0.05, 0.10],
      aspect: 0.42,
      sizeCurve: [0.5, 1.2, 1.9, 2.4],
      alpha: 0.30,
      alphaCurve: [0, 1, 0.55, 0],
      gravity: 0,
      drag: 3.2,
      rise: 0.15,
      turbulence: 1.1, turbScale: 3.6,
      spin: [-0.8, 0.8],
    });

    return this;
  }

  // ─────────────────────────────────────────────────────────── update

  /**
   * @param {number} dt simulated seconds
   * @param {import('../vehicle/Car.js').Car[]} cars
   */
  update(dt, cars) {
    if (!this.enabled || !this.P || !cars || dt <= 0) return;
    // If the LIT layer is nearly full, back off rather than thrash the recycler.
    const pressure = this.P.pressure(LAYER.LIT);
    const throttle = this.rate * (pressure > 0.88 ? 0.35 : (pressure > 0.7 ? 0.7 : 1));
    if (throttle < 0.04) return;

    for (let c = 0; c < cars.length; c++) this._car(cars[c], dt, throttle);
  }

  _car(car, dt, throttle) {
    const wheels = car?.wheels;
    if (!wheels) return;
    const carId = (car.id | 0) & 7;

    const vel = car.body?.velocity;
    const vx = vel ? vel.x : 0, vy = vel ? vel.y : 0, vz = vel ? vel.z : 0;
    const speed = Math.hypot(vx, vy, vz);

    for (let w = 0; w < wheels.length && w < 4; w++) {
      const wheel = wheels[w];
      const em = this.emitters[carId * 4 + w];
      if (!wheel || !wheel.contact) { if (em) em.reset(); continue; }

      const sid = wheel.surfaceId | 0;
      const fx = surfaceFX(sid);
      if (fx.spray === SPRAY.NONE || fx.spray === SPRAY.SPRAY) continue;   // water → Splash.js

      const cp = wheel.contactPoint;
      if (!cp) continue;
      _n.copy(wheel.contactNormal ?? _n.set(0, 1, 0));
      if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
      else _n.normalize();

      const slip = this._slip(wheel, car, speed);
      const load = this._loadFactor(wheel, car);

      // Rolling contribution: dry loose ground trails dust even at zero slip.
      const roll = fx.rollDust * clamp01((speed - 0.6) / 5.0) * load;
      const work = clamp01(slip * load + roll);
      if (work < 0.015) continue;

      const rate = fx.sprayRate * work * throttle;
      em.acc += rate * dt;
      const n = em.acc | 0;
      em.acc -= n;
      if (n <= 0) continue;

      this._emit(car, wheel, fx, sid, cp, n, work, slip, speed, vx, vy, vz, throttle);
    }
  }

  /** 0..1 how hard this tyre is working the surface laterally/longitudinally. */
  _slip(wheel, car, speed) {
    let t = clamp01(wheel.skidIntensity ?? 0);
    if (t === 0) {
      const slipA = Math.abs(wheel.slipAngle ?? 0);
      const slipR = Math.abs(wheel.slipRatio ?? 0);
      t = clamp01(Math.max(slipA / 0.40, (slipR - 0.10) / 0.5));
    }
    // wheelspin from a standstill throws material even with no forward speed
    const spin = wheel.isSpinning ? 0.55 : 0;
    t = Math.max(t, spin);
    return clamp01(t * clamp01((speed + 0.4) / 1.6) + spin * 0.35);
  }

  _loadFactor(wheel, car) {
    const load = wheel.load;
    if (typeof load !== 'number' || load <= 0) return 1;
    const nominal = (car.body?.mass ?? 1.6) * 19.6 * 0.25;
    return clamp(load / Math.max(nominal, 0.05), 0.2, 1.8);
  }

  /**
   * Emit `n` particles for one wheel this frame. Direction: mostly *backwards*
   * along the contact velocity, lifted along the surface normal, with the
   * surface's `sprayLift` deciding how much goes up.
   */
  _emit(car, wheel, fx, sid, cp, n, work, slip, speed, vx, vy, vz, throttle) {
    const P = this.P;
    const S = this.styles;

    // Contact-patch velocity: the material is thrown opposite to it.
    let cvx = vx, cvy = vy, cvz = vz;
    if (car.body?.pointVelocity) {
      try {
        car.body.pointVelocity(cp, _v);
        cvx = _v.x; cvy = _v.y; cvz = _v.z;
      } catch (err) { /* fall back to the chassis velocity */ }
    }
    const cvl = Math.hypot(cvx, cvy, cvz) || 1;

    const lift = fx.sprayLift;
    // eject direction: back along travel, blended toward the surface normal
    const dx = -cvx / cvl * (1 - lift) + _n.x * lift;
    const dy = -cvy / cvl * (1 - lift) + _n.y * lift + 0.25;
    const dz = -cvz / cvl * (1 - lift) + _n.z * lift;

    const groundY = cp.y + 0.002;
    const ox = cp.x + _n.x * 0.006;
    const oy = cp.y + _n.y * 0.006;
    const oz = cp.z + _n.z * 0.006;

    const speedScale = 0.45 + 0.85 * clamp01(speed / 7);
    const eject = fx.spraySpeed * speedScale * (0.55 + 0.75 * work);
    const radius = (wheel.width ?? 0.028) * 0.55;

    // A fraction of the chassis velocity is inherited so the spray trails the
    // car instead of hanging in the air like a smoke ring.
    const inh = 0.30;

    const c1 = fx.sprayColor, c2 = fx.sprayColor2;
    const sizeMul = lerp(0.75, 1.35, work) * (fx.spraySize / 0.09);

    const common = _opts;
    common.speedJitter = 0.5;
    common.radius = radius;
    common.inheritX = cvx * inh;
    common.inheritY = Math.max(cvy * inh, 0);
    common.inheritZ = cvz * inh;
    common.groundY = groundY;
    common.sizeMul = sizeMul;
    common.lifeMul = lerp(0.8, 1.25, work);
    common.alpha = 1;
    common.aspect = undefined;
    common.frame = undefined;
    common.size = undefined;
    common.life = undefined;
    common.spin = undefined;
    common.rot = undefined;

    // Colour: lerp between the surface's two tints per particle so a plume has
    // internal variation instead of reading as one flat wash. `tint()` is a
    // module function, not a closure, because this runs per wheel per frame.
    const setTint = (t) => tint(common, c1, c2, t);

    switch (fx.spray) {
      case SPRAY.PLUME: {
        for (let k = 0; k < n; k++) {
          setTint(frand() * 0.9);
          P.burstCone(S.plume, ox, oy, oz, dx, dy, dz, eject * 0.45, 0.55, 1, common);
        }
        // heavy fraction: grains that arc out and land
        const grains = Math.round(n * 0.7 * fx.chips + n * 0.35);
        for (let k = 0; k < grains; k++) {
          setTint(0.4 + frand() * 0.6);
          P.burstCone(S.grain, ox, oy, oz, dx, dy * 1.35, dz, eject * 1.5, 0.42, 1, common);
        }
        break;
      }
      case SPRAY.GRIT: {
        for (let k = 0; k < n; k++) {
          setTint(frand());
          P.burstCone(S.dust, ox, oy, oz, dx, dy, dz, eject * 0.4, 0.6, 1, common);
        }
        const chips = Math.round(n * fx.chips * 0.9);
        for (let k = 0; k < chips; k++) {
          setTint(0.25 + frand() * 0.75);
          P.burstCone(S.chip, ox, oy, oz, dx, dy * 1.5, dz, eject * 1.9, 0.5, 1, common);
        }
        break;
      }
      case SPRAY.SHEET: {
        for (let k = 0; k < n; k++) {
          setTint(frand() * 0.85);
          // sheets are wide and shallow: flatten the cone and align the quads
          common.aspect = frandRange(0.35, 0.62);
          common.rot = frandRange(-0.5, 0.5);
          P.burstCone(S.sheet, ox, oy, oz, dx, dy * 0.55, dz, eject * 0.55, 0.4, 1, common);
        }
        common.aspect = undefined;
        common.rot = undefined;
        const grains = Math.round(n * 0.9);
        for (let k = 0; k < grains; k++) {
          setTint(0.35 + frand() * 0.65);
          P.burstCone(S.grain, ox, oy, oz, dx, dy * 1.2, dz, eject * 1.35, 0.45, 1, common);
        }
        break;
      }
      case SPRAY.BLADES: {
        const blades = Math.round(n * fx.chips * 1.1);
        for (let k = 0; k < blades; k++) {
          setTint(frand() * 0.9);
          P.burstCone(S.blade, ox, oy, oz, dx, dy * 1.4, dz, eject * 1.3, 0.6, 1, common);
        }
        for (let k = 0; k < n; k++) {
          setTint(0.3 + frand() * 0.7);
          P.burstCone(S.clipping, ox, oy, oz, dx, dy, dz, eject * 0.4, 0.65, 1, common);
        }
        break;
      }
      case SPRAY.LINT: {
        for (let k = 0; k < n; k++) {
          setTint(frand());
          P.burstCone(S.lint, ox, oy, oz, dx, dy, dz, eject * 0.5, 0.8, 1, common);
        }
        break;
      }
      case SPRAY.CRYSTAL: {
        for (let k = 0; k < n; k++) {
          common.r = 1; common.g = 1; common.b = 1;
          P.burstCone(S.crystal, ox, oy, oz, dx, dy * 1.3, dz, eject * 1.4, 0.5, 1, common);
        }
        if (work > 0.35) {
          const mist = Math.max(1, Math.round(n * 0.35));
          for (let k = 0; k < mist; k++) {
            P.burstCone(S.iceMist, ox, oy, oz, dx, dy, dz, eject * 0.35, 0.7, 1, common);
          }
        }
        break;
      }
      case SPRAY.SLICK: {
        for (let k = 0; k < n; k++) {
          setTint(frand() * 0.7);
          P.burstCone(S.slick, ox, oy, oz, dx, dy * 1.2, dz, eject * 1.1, 0.55, 1, common);
        }
        break;
      }
      case SPRAY.DUST:
      default: {
        for (let k = 0; k < n; k++) {
          setTint(frand());
          P.burstCone(S.dust, ox, oy, oz, dx, dy, dz, eject * 0.5, 0.6, 1, common);
        }
        break;
      }
    }

    // A low ground-hugging skirt under a big slide reads the drift from behind.
    if (slip > 0.55 && fx.loose > 0.25 && speed > 2.2) {
      setTint(0.5);
      common.aspect = frandRange(0.35, 0.5);
      const skirtN = Math.max(1, Math.round(n * 0.3));
      for (let k = 0; k < skirtN; k++) {
        P.burstCone(S.skirt, ox, oy + 0.004, oz, dx, 0.15, dz, eject * 0.3, 0.5, 1, common);
      }
      common.aspect = undefined;
    }

    this.stats.spawned += n;
  }

  /**
   * A landing / heavy impact throws a one-shot puff of whatever the surface is
   * made of. Called by FXSystem on 'car:land'.
   *
   * @param {number} surfaceId
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {THREE.Vector3|{x,y,z}|null} normal
   * @param {number} impact impact speed, m/s
   */
  landingPuff(surfaceId, point, normal, impact) {
    const P = this.P;
    if (!P || !this.enabled) return;
    const fx = surfaceFX(surfaceId);
    if (fx.splashy <= 0.02) return;

    const strength = clamp01(impact / 9) * fx.splashy * this.rate;
    if (strength < 0.05) return;

    _n.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    _n.normalize();

    const S = this.styles;
    const style = fx.spray === SPRAY.PLUME ? S.plume
      : fx.spray === SPRAY.SHEET ? S.sheet
        : fx.spray === SPRAY.CRYSTAL ? S.iceMist
          : fx.spray === SPRAY.LINT ? S.lint : S.dust;

    const c1 = fx.sprayColor, c2 = fx.sprayColor2;
    const o = _opts;
    o.speedJitter = 0.45;
    o.radius = 0.02;
    o.groundY = point.y + 0.002;
    o.inheritX = 0; o.inheritY = 0; o.inheritZ = 0;
    o.sizeMul = lerp(0.9, 1.8, strength);
    o.lifeMul = lerp(0.85, 1.3, strength);
    o.alpha = 1;
    o.aspect = 0.5;
    o.frame = undefined; o.size = undefined; o.life = undefined;
    o.spin = undefined; o.rot = undefined;

    // A flat ring bursting outward from the touchdown point — this is what makes
    // a landing read as an impact rather than a spawn.
    const n = Math.round(lerp(5, 26, strength));
    const px = point.x + _n.x * 0.008;
    const py = point.y + _n.y * 0.008;
    const pz = point.z + _n.z * 0.008;
    for (let k = 0; k < n; k++) {
      o.r = lerp(c1[0], c2[0], frand());
      o.g = lerp(c1[1], c2[1], frand());
      o.b = lerp(c1[2], c2[2], frand());
      const a = frand() * Math.PI * 2;
      const dirx = Math.cos(a), dirz = Math.sin(a);
      P.spawn(style, px, py, pz,
        dirx * (0.6 + strength * 2.6), 0.35 + strength * 1.2, dirz * (0.6 + strength * 2.6), o);
    }
    o.aspect = undefined;

    // heavy fraction
    if (fx.chips > 0.1 || fx.loose > 0.3) {
      const chips = Math.round(lerp(2, 16, strength) * Math.max(fx.chips, fx.loose * 0.5));
      const style2 = fx.chips > 0.4 ? S.chip : S.grain;
      for (let k = 0; k < chips; k++) {
        o.r = lerp(c1[0], c2[0], 0.4 + frand() * 0.6);
        o.g = lerp(c1[1], c2[1], 0.4 + frand() * 0.6);
        o.b = lerp(c1[2], c2[2], 0.4 + frand() * 0.6);
        P.burstCone(style2, px, py, pz, _n.x, _n.y, _n.z,
          1.2 + strength * 4.5, 0.85, 1, o);
      }
    }
  }

  reset() { for (const e of this.emitters) e.reset(); }
  dispose() { this.emitters.length = 0; }
}

/** Blend an emitter's two surface tints into a spawn-options record. */
function tint(o, c1, c2, t) {
  o.r = c1[0] + (c2[0] - c1[0]) * t;
  o.g = c1[1] + (c2[1] - c1[1]) * t;
  o.b = c1[2] + (c2[2] - c1[2]) * t;
  return o;
}

/** One shared options record — spawn() reads it synchronously and never keeps it. */
const _opts = {
  speedJitter: 0.5, radius: 0, groundY: -1e6,
  inheritX: 0, inheritY: 0, inheritZ: 0,
  r: 1, g: 1, b: 1, alpha: 1,
  sizeMul: 1, lifeMul: 1,
  size: undefined, life: undefined, aspect: undefined,
  rot: undefined, spin: undefined, frame: undefined,
};

export default Dust;
