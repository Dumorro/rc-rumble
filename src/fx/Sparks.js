/**
 * RC RUMBLE — sparks.
 *
 * Two distinct events produce sparks, and they look different:
 *
 * 1. **Impact sparks** — a discrete hit. A tight cone of hot streaks fired along
 *    the reflection of the impact, brightest at the moment of contact, count and
 *    speed scaled by the normal impulse.
 *
 * 2. **Scrape sparks** — a chassis grinding along a wall. A continuous, thin
 *    fan of sparks that fires *along* the wall in the direction of travel, gated
 *    by the grazing angle: a head-on hit makes debris, a glancing hit makes a
 *    shower. Plus a short-lived point light so the wall actually lights up.
 *
 * Sparks are additive, gravity-bound, and bounce off the plane they were born on
 * (the particle engine records a ground plane per particle so this costs no
 * raycasts). A spark that has cooled shifts from white-hot through orange to a
 * dull red before dying — that colour ramp is what makes them read as *metal*.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp01, lerp } from '../core/MathUtils.js';
import { surfaceFX, chassisFX } from './SurfaceFX.js';
import { LAYER, frand } from './ParticleSystem.js';
import { SPR } from './ParticleAtlas.js';

const GRAV = CONFIG.physics.gravity;

const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _t = new THREE.Vector3();

/** A pooled scrape light. We only ever need a handful. */
class ScrapeLight {
  constructor() {
    /** @type {THREE.PointLight|null} */
    this.light = null;
    this.ttl = 0;
    this.peak = 0;
  }
}

export class Sparks {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {import('./ParticleSystem.js').ParticleSystem} particles
   */
  constructor(game, particles) {
    this.game = game;
    this.P = particles;
    this.enabled = CONFIG.fx.sparksEnabled !== false;
    this.rate = 1;

    /** Impulse (N·s) below which a hit makes no sparks at all. */
    this.minImpulse = 0.55;
    /** Impulse that saturates the burst size. */
    this.maxImpulse = 14;

    this.styles = {};

    /** @type {ScrapeLight[]} */
    this.lights = [];
    // Real point lights are created ONCE in init(), before any shader compiles,
    // and stay `visible` forever with intensity 0 when idle — toggling a light's
    // visibility changes the light count and would force every lit material in
    // the scene to recompile mid-race.
    this.maxLights = (CONFIG.quality === 'high' || CONFIG.quality === 'ultra')
      ? (CONFIG.quality === 'ultra' ? 3 : 2) : 0;
    this._lightRoot = null;

    /** Per-car continuous scrape state. */
    this.scrapes = [];
    for (let i = 0; i < Math.max(8, CONFIG.race.maxCars); i++) {
      this.scrapes.push({ acc: 0, heat: 0, cooldown: 0 });
    }

    this.stats = { bursts: 0, sparks: 0, lights: 0 };
  }

  init() {
    const P = this.P;
    if (!P) return this;
    const S = this.styles;

    // ── the main hot streak ──
    S.spark = P.defineStyle('fx/spark', {
      layer: LAYER.STREAK,
      sprite: SPR.STREAK,
      life: [0.16, 0.46],
      size: [0.0022, 0.0048],       // width; length comes from `stretch`
      aspect: 2.4,
      alpha: 1,
      alphaCurve: [1, 1, 0.75, 0],
      // white-hot → orange → dull red: the whole reason sparks read as metal
      color: 0xfff6e0,
      colorEnd: 0xd03806,
      colorCurve: [3.4, 2.4, 1.1, 0.35],
      intensity: 1,
      stretch: 0.020,
      gravity: GRAV * 0.85,
      drag: 0.55,
      bounce: 0.42,
      groundFriction: 0.30,
    });

    // ── a slower, fatter ember that survives the bounce ──
    S.ember = P.defineStyle('fx/spark/ember', {
      layer: LAYER.ADD,
      sprite: SPR.GLOW,
      life: [0.35, 0.9],
      size: [0.0035, 0.0075],
      sizeCurve: [1, 0.9, 0.7, 0.35],
      alpha: 1,
      alphaCurve: [1, 0.95, 0.6, 0],
      color: 0xffd28a,
      colorEnd: 0x8c1a02,
      colorCurve: [2.6, 1.7, 0.8, 0.25],
      gravity: GRAV * 0.95,
      drag: 0.7,
      bounce: 0.45,
      groundFriction: 0.35,
    });

    // ── the flash at the contact point itself ──
    S.flash = P.defineStyle('fx/spark/flash', {
      layer: LAYER.ADD,
      sprite: SPR.FLARE,
      life: [0.06, 0.13],
      size: [0.018, 0.045],
      sizeCurve: [0.5, 1.25, 1.0, 0.4],
      alpha: 1,
      alphaCurve: [1, 0.85, 0.35, 0],
      color: 0xfff2d0,
      colorCurve: [5.5, 3.0, 1.2, 0],
      gravity: 0,
      drag: 6,
    });

    // ── ground scorch/heat glow left for a beat under a heavy scrape ──
    S.groundGlow = P.defineStyle('fx/spark/groundGlow', {
      layer: LAYER.GROUND,
      sprite: SPR.RING_SOFT,
      life: [0.18, 0.34],
      size: [0.012, 0.030],
      sizeCurve: [0.5, 1.0, 1.5, 1.9],
      alpha: 0.8,
      alphaCurve: [1, 0.7, 0.3, 0],
      color: 0xff9c40,
      colorCurve: [2.2, 1.4, 0.6, 0],
    });

    // ── grinding dust: even a metal-on-metal scrape throws grey powder ──
    S.grindDust = P.defineStyle('fx/spark/grindDust', {
      layer: LAYER.LIT,
      sprite: SPR.DUST, frames: 4, frameMode: 'random',
      life: [0.3, 0.7],
      size: [0.010, 0.026],
      sizeCurve: [0.6, 1.0, 1.4, 1.7],
      alpha: 0.30,
      alphaCurve: [0, 1, 0.6, 0],
      color: 0xb8bcc0,
      gravity: GRAV * 0.05,
      drag: 3.2,
      rise: 0.5,
      turbulence: 1.2, turbScale: 8,
    });

    // ── plastic/glass chassis: shards instead of sparks ──
    S.shard = P.defineStyle('fx/spark/shard', {
      layer: LAYER.ALPHA,
      sprite: SPR.SHARD,
      life: [0.5, 1.1],
      size: [0.004, 0.011],
      alpha: 0.9,
      alphaCurve: [1, 1, 0.8, 0],
      gravity: GRAV,
      drag: 0.3,
      bounce: 0.3,
      groundFriction: 0.5,
      spin: [-22, 22],
    });

    // Scrape lights live under the FX root so they are torn down with it.
    this._lightRoot = new THREE.Group();
    this._lightRoot.name = 'fx/scrapeLights';
    for (let i = 0; i < this.maxLights; i++) {
      const sl = new ScrapeLight();
      const light = new THREE.PointLight(0xffb060, 0, 0.85, 2.0);
      light.name = `fx/scrapeLight${i}`;
      light.visible = true;      // see the note in the constructor
      light.castShadow = false;
      sl.light = light;
      this._lightRoot.add(light);
      this.lights.push(sl);
    }
    return this;
  }

  attach(parent) { parent?.add(this._lightRoot); return this; }

  // ────────────────────────────────────────────────────────── impacts

  /**
   * A discrete impact. Called from FXSystem on 'car:collision' / 'prop:hit'.
   *
   * @param {THREE.Vector3|{x,y,z}} point world contact point
   * @param {THREE.Vector3|{x,y,z}|null} normal contact normal (faces away from the surface)
   * @param {number} impulse N·s
   * @param {number} relSpeed closing speed, m/s
   * @param {number} surfaceId what was hit
   * @param {string} chassis 'metal'|'glass'|'plastic'
   * @param {THREE.Vector3|{x,y,z}|null} [velocity] the car's velocity, for the fan direction
   */
  impact(point, normal, impulse, relSpeed, surfaceId, chassis, velocity) {
    const P = this.P;
    if (!this.enabled || !P) return;
    if (impulse < this.minImpulse) return;

    const surf = surfaceFX(surfaceId);
    const chas = chassisFX(chassis);
    // Sparks need something hard on at least one side of the contact.
    const sparkiness = Math.max(surf.sparky, chas.spark * 0.75);

    _n.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    const strength = clamp01((impulse - this.minImpulse) / (this.maxImpulse - this.minImpulse));

    // Grazing angle: 0 = head-on, 1 = perfectly tangential.
    let graze = 0.4;
    let vlen = 0;
    if (velocity) {
      _d.set(velocity.x, velocity.y, velocity.z);
      vlen = _d.length();
      if (vlen > 0.05) {
        _d.multiplyScalar(1 / vlen);
        graze = clamp01(1 - Math.abs(_d.dot(_n)));
      }
    }

    // A head-on smash makes debris and a dull thud; a graze makes the shower.
    const sparkGate = sparkiness * lerp(0.25, 1.0, graze);
    const o = _opts;
    resetOpts(o);
    o.groundY = point.y - 0.004;

    if (sparkGate > 0.06) {
      const count = Math.round(lerp(3, 40, strength) * sparkGate * this.rate);
      if (count > 0) {
        // Fire along the reflection of the travel direction about the normal,
        // biased away from the wall so nothing is born inside geometry.
        this._reflect(vlen > 0.05 ? _d : _n, _n, _r);
        _r.addScaledVector(_n, 0.55).normalize();

        const speed = lerp(0.8, 4.6, strength) * lerp(0.6, 1.35, graze)
          + Math.min(relSpeed, 12) * 0.22;

        o.speedJitter = 0.62;
        o.radius = 0.008;
        o.sizeMul = lerp(0.8, 1.5, strength);
        P.burstCone(this.styles.spark, point.x + _n.x * 0.006, point.y + _n.y * 0.006,
          point.z + _n.z * 0.006, _r.x, _r.y, _r.z, speed, lerp(0.35, 0.95, graze), count, o);

        const embers = Math.max(1, Math.round(count * 0.28));
        o.sizeMul = lerp(0.9, 1.6, strength);
        P.burstCone(this.styles.ember, point.x + _n.x * 0.006, point.y + _n.y * 0.006,
          point.z + _n.z * 0.006, _r.x, _r.y, _r.z, speed * 0.7, 0.85, embers, o);

        // contact flash
        o.sizeMul = lerp(0.7, 1.9, strength);
        o.speedJitter = 0.2;
        P.spawn(this.styles.flash, point.x + _n.x * 0.010, point.y + _n.y * 0.010,
          point.z + _n.z * 0.010, 0, 0, 0, o);

        this._pulseLight(point, lerp(0.35, 1.6, strength) * sparkGate, 0.10);
        this.stats.sparks += count;
      }
    }

    // Glass and plastic shed shards rather than sparks.
    if (chas.spark < 0.6 && strength > 0.18) {
      resetOpts(o);
      o.groundY = point.y - 0.004;
      o.speedJitter = 0.55;
      o.radius = 0.010;
      const shards = Math.round(lerp(2, 14, strength) * (1 - chas.spark));
      const tint = chas.hot;
      o.r = 0.65 + tint[0] * 0.35; o.g = 0.65 + tint[1] * 0.35; o.b = 0.65 + tint[2] * 0.35;
      this._reflect(vlen > 0.05 ? _d : _n, _n, _r);
      _r.addScaledVector(_n, 0.7).normalize();
      P.burstCone(this.styles.shard, point.x + _n.x * 0.006, point.y + _n.y * 0.006,
        point.z + _n.z * 0.006, _r.x, _r.y, _r.z, lerp(0.6, 3.2, strength), 0.9, shards, o);
    }

    // Grinding powder from whatever the wall is made of.
    if (strength > 0.12 && surf.dustiness > 0.05) {
      resetOpts(o);
      const c = surf.sprayColor;
      o.r = c[0]; o.g = c[1]; o.b = c[2];
      o.speedJitter = 0.5;
      o.radius = 0.012;
      o.sizeMul = lerp(0.8, 1.6, strength);
      const puff = Math.round(lerp(1, 10, strength) * surf.dustiness);
      P.burstCone(this.styles.grindDust, point.x + _n.x * 0.008, point.y + _n.y * 0.008,
        point.z + _n.z * 0.008, _n.x, _n.y + 0.4, _n.z, lerp(0.3, 1.4, strength), 0.85, puff, o);
    }

    this.stats.bursts++;
  }

  // ────────────────────────────────────────────────────────── scrapes

  /**
   * Continuous scrape. Call every frame while a car body is in sustained contact
   * with a wall. `FXSystem` derives this from the collision event stream.
   *
   * @param {number} carId
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {THREE.Vector3|{x,y,z}} normal
   * @param {THREE.Vector3|{x,y,z}} velocity
   * @param {number} pressure 0..1 how hard it is being pushed into the wall
   * @param {number} surfaceId
   * @param {string} chassis
   * @param {number} dt
   */
  scrape(carId, point, normal, velocity, pressure, surfaceId, chassis, dt) {
    const P = this.P;
    if (!this.enabled || !P || dt <= 0) return;
    const st = this.scrapes[(carId | 0) & 7];
    if (!st) return;

    const surf = surfaceFX(surfaceId);
    const chas = chassisFX(chassis);
    const sparkiness = Math.max(surf.sparky, chas.spark * 0.8);
    if (sparkiness < 0.05) { st.heat = Math.max(0, st.heat - dt * 3); return; }

    _n.set(normal.x, normal.y, normal.z);
    if (_n.lengthSq() < 1e-8) return;
    _n.normalize();

    _d.set(velocity.x, velocity.y, velocity.z);
    const vlen = _d.length();
    if (vlen < 0.6) { st.heat = Math.max(0, st.heat - dt * 3); return; }
    _d.multiplyScalar(1 / vlen);

    // Tangential component of the motion — that is what grinds.
    _t.copy(_d).addScaledVector(_n, -_d.dot(_n));
    const tan = _t.length();
    if (tan < 0.12) { st.heat = Math.max(0, st.heat - dt * 3); return; }
    _t.multiplyScalar(1 / tan);

    const grind = clamp01(tan * clamp01(vlen / 5.5) * clamp01(pressure * 1.4)) * sparkiness;
    st.heat = clamp01(st.heat + (grind - st.heat * 0.6) * dt * 6);
    if (grind < 0.04) return;

    const o = _opts;
    resetOpts(o);
    o.groundY = point.y - 0.5;              // walls: let them fall past the point
    o.speedJitter = 0.6;
    o.radius = 0.010;
    o.sizeMul = 0.85 + st.heat * 0.6;
    o.inheritX = velocity.x * 0.35;
    o.inheritY = velocity.y * 0.20;
    o.inheritZ = velocity.z * 0.35;

    const rate = lerp(20, 190, grind) * this.rate;
    st.acc += rate * dt;
    const n = st.acc | 0;
    st.acc -= n;

    if (n > 0) {
      // Fan direction: backwards along the tangent, flared off the wall.
      _r.copy(_t).multiplyScalar(-1).addScaledVector(_n, 0.42).normalize();
      const px = point.x + _n.x * 0.006, py = point.y + _n.y * 0.006, pz = point.z + _n.z * 0.006;
      const speed = lerp(1.0, 4.2, grind) + vlen * 0.20;
      P.burstCone(this.styles.spark, px, py, pz, _r.x, _r.y, _r.z, speed, 0.75, n, o);

      if (grind > 0.30) {
        const embers = Math.max(1, Math.round(n * 0.2));
        P.burstCone(this.styles.ember, px, py, pz, _r.x, _r.y, _r.z, speed * 0.55, 0.9, embers, o);
      }
      // occasional flash so the scrape flickers rather than streaming evenly
      if (frand() < grind * 0.55) {
        resetOpts(o);
        o.sizeMul = 0.7 + st.heat * 1.1;
        P.spawn(this.styles.flash, px + _n.x * 0.004, py + _n.y * 0.004, pz + _n.z * 0.004,
          0, 0, 0, o);
      }
      this.stats.sparks += n;
    }

    // Ground glow only when the scrape is near-horizontal (wheels/underside).
    if (_n.y > 0.55 && grind > 0.25 && frand() < 0.35) {
      resetOpts(o);
      o.sizeMul = 0.8 + grind * 1.2;
      P.spawn(this.styles.groundGlow, point.x, point.y + 0.004, point.z,
        _n.x, _n.y, _n.z, o);
    }

    this._pulseLight(point, st.heat * chas.scrapeLight * 1.5, 0.09);
  }

  // ────────────────────────────────────────────────────────── lights

  /**
   * Light up the wall for a moment. Pooled: the brightest request wins a slot,
   * and the slot self-extinguishes.
   */
  _pulseLight(point, strength, seconds) {
    if (this.maxLights === 0 || strength <= 0.02) return;
    // Prefer a free slot; otherwise steal the dimmest one if we are brighter.
    let slot = null;
    let dimmest = null;
    for (const sl of this.lights) {
      if (sl.ttl <= 0) { slot = sl; break; }
      if (!dimmest || sl.peak < dimmest.peak) dimmest = sl;
    }
    if (!slot) {
      if (!dimmest || dimmest.peak > strength) return;
      slot = dimmest;
    }
    slot.ttl = seconds;
    slot.peak = strength;
    const light = slot.light;
    light.position.set(point.x, point.y, point.z);
    light.intensity = strength * 2.2;
    light.distance = 0.55 + strength * 0.9;
  }

  /** @param {number} dt */
  update(dt) {
    if (dt <= 0) return;
    let active = 0;
    // Indexed loops on purpose: `for...of` allocates an iterator, and this runs
    // every frame for the whole race.
    for (let i = 0; i < this.lights.length; i++) {
      const sl = this.lights[i];
      if (sl.ttl <= 0) continue;
      sl.ttl -= dt;
      if (sl.ttl <= 0) {
        sl.light.intensity = 0;
        sl.peak = 0;
      } else {
        // flicker: a real scrape does not glow smoothly
        const flick = 0.72 + 0.28 * frand();
        sl.light.intensity = sl.peak * 2.2 * clamp01(sl.ttl / 0.09) * flick;
        active++;
      }
    }
    for (let i = 0; i < this.scrapes.length; i++) {
      const st = this.scrapes[i];
      if (st.heat > 0) st.heat = Math.max(0, st.heat - dt * 1.6);
    }
    this.stats.lights = active;
  }

  /** Reflect `v` about the plane with normal `n` into `out`. */
  _reflect(v, n, out) {
    const d = v.dot(n);
    out.set(v.x - 2 * d * n.x, v.y - 2 * d * n.y, v.z - 2 * d * n.z);
    if (out.lengthSq() < 1e-8) out.copy(n);
    else out.normalize();
    return out;
  }

  reset() {
    for (const st of this.scrapes) { st.acc = 0; st.heat = 0; st.cooldown = 0; }
    for (const sl of this.lights) {
      sl.ttl = 0; sl.peak = 0;
      if (sl.light) sl.light.intensity = 0;
    }
  }

  dispose() {
    for (const sl of this.lights) sl.light?.dispose?.();
    this.lights.length = 0;
    this._lightRoot?.removeFromParent();
  }
}

/** One shared spawn-options record. */
const _opts = {
  speedJitter: 0.5, radius: 0, groundY: -1e6,
  inheritX: 0, inheritY: 0, inheritZ: 0,
  r: 1, g: 1, b: 1, alpha: 1, sizeMul: 1, lifeMul: 1,
  size: undefined, life: undefined, aspect: undefined,
  rot: undefined, spin: undefined, frame: undefined,
};

function resetOpts(o) {
  o.speedJitter = 0.5; o.radius = 0; o.groundY = -1e6;
  o.inheritX = 0; o.inheritY = 0; o.inheritZ = 0;
  o.r = 1; o.g = 1; o.b = 1; o.alpha = 1; o.sizeMul = 1; o.lifeMul = 1;
  o.size = undefined; o.life = undefined; o.aspect = undefined;
  o.rot = undefined; o.spin = undefined; o.frame = undefined;
  return o;
}

export { resetOpts };
export default Sparks;
