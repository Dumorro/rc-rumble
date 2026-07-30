/**
 * src/audio/SFXSynth.js — the synthesized one-shot / loop library.
 *
 * Every sound in the game that is not the engine, the tires or the music lives
 * here, and every one of them is built from four ingredients:
 *
 *   · noise bursts through band filters (transients, air, grit, water),
 *   · resonator banks — a short noise excitation through several high-Q
 *     bandpasses at inharmonic frequencies. This is what makes metal *ring* and
 *     glass *tinkle* rather than just click,
 *   · FM pairs (bells, chimes, zaps, toy horns),
 *   · scheduled envelopes on everything, with impulse-scaled level *and* decay so
 *     a 0.4 N·s nudge and a 15 N·s pile-up are recognisably the same object.
 *
 * Recipes are declared in `RECIPES`. Each entry gets a pooled `Voice` (gain +
 * panner + reverb send) and builds its transient nodes into it; the pool tears
 * them down when the scheduled end time passes.
 *
 * Nothing here throws. Unknown names fall back to a soft generic blip and warn
 * once, so a gameplay agent can call `audio.play('weapon/anvil/fire')` before the
 * recipe exists and the game keeps running.
 */

import { RNG, clamp, clamp01 } from '../core/MathUtils.js';
import {
  fin, noteHz, gain, filter, osc, shaper, loopSource,
  whiteFor, pinkFor, setParam, rampTo, expTo, targetTo, perc, asr,
  sweep, stopAt, chain,
} from './DSP.js';
import { LoopHandle } from './VoicePool.js';

/* ────────────────────────────────────────────────────────── surface mapping */

const S = {
  DEFAULT: 0, WOOD: 1, CARPET: 2, TILE: 3, CONCRETE: 4, GRASS: 5, DIRT: 6,
  GRAVEL: 7, SAND: 8, WATER: 9, ICE: 10, METAL: 11, PLASTIC: 12, RUBBER: 13,
  GLASS: 14, OIL: 15,
};

/** Impact recipe for a (chassis, surface) pair. */
export function impactRecipe(chassis, surfaceId) {
  switch (surfaceId | 0) {
    case S.METAL: return 'impact/metal';
    case S.GLASS: return 'impact/glass';
    case S.WOOD: return 'impact/wood';
    case S.WATER: return 'splash';
    case S.RUBBER: return 'impact/rubber';
    case S.CARPET: return 'impact/soft';
    case S.GRASS: case S.DIRT: case S.SAND: return 'impact/thud';
    case S.GRAVEL: return 'impact/gravel';
    default: break;
  }
  if (chassis === 'metal') return 'impact/metal';
  if (chassis === 'glass') return 'impact/glass';
  return 'impact/plastic';
}

/** Surface → landing recipe. */
export function landRecipe(surfaceId) {
  switch (surfaceId | 0) {
    case S.WATER: return 'splash/big';
    case S.METAL: return 'land/metal';
    case S.CARPET: case S.GRASS: return 'land/soft';
    case S.GRAVEL: case S.DIRT: case S.SAND: return 'land/loose';
    default: return 'land';
  }
}

/** Weapon id → canonical family. Generous aliasing: gameplay can name it anything. */
const WEAPON_ALIAS = {
  firework: 'firework', rocket: 'firework', missile: 'firework', fireworks: 'firework',
  oil: 'oil', oil_slick: 'oil', oilslick: 'oil', slick: 'oil',
  water_balloon: 'balloon', waterballoon: 'balloon', balloon: 'balloon', bomb_water: 'balloon',
  electro: 'electro', electro_pulse: 'electro', electropulse: 'electro', zap: 'electro',
  lightning: 'electro', taser: 'electro',
  ball: 'ball', ball_bearing: 'ball', ballbearing: 'ball', global_ball: 'ball',
  pinball: 'ball', globe: 'ball',
  bomb: 'bomb', mine: 'bomb', timebomb: 'bomb', time_bomb: 'bomb',
  shockwave: 'shockwave', pulse: 'shockwave', wave: 'shockwave',
  turbo: 'turbo', nitro: 'turbo', boost: 'turbo', rocket_boost: 'turbo',
  battery: 'battery', batteries: 'battery',
  clone: 'clone', copy: 'clone', duplicate: 'clone',
};

export function weaponFamily(id) {
  if (!id) return 'default';
  const k = String(id).toLowerCase().replace(/[\s-]+/g, '_');
  return WEAPON_ALIAS[k] || 'default';
}

/* ───────────────────────────────────────────────────────────── the library */

export class SFXSynth {
  /** @param {import('./AudioSystem.js').AudioSystem} audio */
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.res = audio.res;
    this.pool = audio.pool;
    this.rng = new RNG(0xbadf00d);
    this._warned = new Set();
    this._srcSlot = 0;
    /** Rate-limit identical names so an event storm cannot machine-gun. */
    this._lastAt = new Map();
  }

  // ───────────────────────────────────────────────────── public interface

  /**
   * Play a one-shot.
   * @param {string} name
   * @param {{position?:object, velocity?:object, volume?:number, rate?:number,
   *          delay?:number, impulse?:number, surfaceId?:number, reverb?:number,
   *          priority?:number, minGap?:number, detune?:number, seed?:number}} [o]
   * @returns {import('./VoicePool.js').Voice|null}
   */
  play(name, o = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.pool) return null;
    let key = name;
    let r = RECIPES[key];
    if (!r) {
      key = this._resolveFallback(name);
      r = RECIPES[key];
      if (!r) return null;
    }
    // Follow alias chains (max 3 hops so a bad table cannot loop forever).
    for (let hop = 0; hop < 3 && r && r.alias; hop++) r = RECIPES[r.alias];
    if (!r || typeof r.build !== 'function') return null;

    // Anti-machine-gun.
    const now = ctx.currentTime;
    const gap = fin(o.minGap, r.minGap ?? 0);
    if (gap > 0) {
      const last = this._lastAt.get(key) ?? -1e9;
      if (now - last < gap) return null;
      this._lastAt.set(key, now);
    }

    const spatial = o.position != null && r.spatial !== false;
    const v = this.pool.acquire({
      name: key,
      bus: o.bus || r.bus || 'sfx',
      priority: fin(o.priority, r.prio ?? 0.5),
      spatial,
      duration: fin(o.duration, r.dur ?? 1.0) + 0.2,
      volume: clamp(fin(o.volume, 1) * (r.gain ?? 1), 0, 6),
      position: o.position,
      velocity: o.velocity,
      reverb: fin(o.reverb, r.reverb ?? 0.18),
      refDistance: o.refDistance ?? r.refDistance,
      maxDistance: o.maxDistance,
      rolloff: o.rolloff,
    });
    if (!v) return null;

    const t = now + Math.max(0, fin(o.delay, 0)) + 0.004;
    let dur = r.dur ?? 1.0;
    try {
      const got = r.build.call(this, v, t, o);
      if (typeof got === 'number' && Number.isFinite(got)) dur = got;
    } catch (err) {
      if (!this._warned.has(key)) {
        this._warned.add(key);
        console.warn(`[SFX] recipe "${key}" failed:`, err);
      }
    }
    v.endTime = t + Math.max(0.03, dur) + 0.12;
    return v;
  }

  /**
   * Start a sustained/looping sound.
   * @returns {LoopHandle|null}
   */
  loop(name, o = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.pool) return null;
    const r = LOOPS[name];
    if (!r) {
      if (!this._warned.has(`loop:${name}`)) {
        this._warned.add(`loop:${name}`);
        console.warn(`[SFX] no loop recipe "${name}"`);
      }
      return null;
    }
    const spatial = o.position != null && r.spatial !== false;
    const v = this.pool.acquire({
      name: `loop:${name}`,
      bus: o.bus || r.bus || 'sfx',
      priority: fin(o.priority, r.prio ?? 0.7),
      spatial,
      persistent: true,
      volume: clamp(fin(o.volume, 1) * (r.gain ?? 1), 0, 6),
      position: o.position,
      velocity: o.velocity,
      reverb: fin(o.reverb, r.reverb ?? 0.14),
      refDistance: o.refDistance ?? r.refDistance,
      maxDistance: o.maxDistance,
    });
    if (!v) return null;
    v.userData = { params: {} };
    const t = ctx.currentTime + 0.006;
    try { r.build.call(this, v, t, o); }
    catch (err) {
      console.warn(`[SFX] loop "${name}" failed:`, err);
      this.pool.release(v);
      return null;
    }
    return new LoopHandle(v);
  }

  /** Fire the right sound for a weapon. `phase` = 'fire' | 'hit' | 'loop'. */
  playWeapon(weaponId, phase = 'fire', o = {}) {
    const fam = weaponFamily(weaponId);
    if (phase === 'loop') return this.loop(`weapon/${fam}`, o) || this.loop('weapon/turbo', o);
    const name = `weapon/${fam}/${phase}`;
    if (RECIPES[name]) return this.play(name, o);
    return this.play(`weapon/default/${phase === 'hit' ? 'hit' : 'fire'}`, o);
  }

  /** Impulse-scaled collision. */
  impact(o = {}) {
    const imp = Math.abs(fin(o.impulse, 1));
    const name = o.name || impactRecipe(o.chassis, fin(o.surfaceId, 0));
    const amt = clamp01((imp - 0.25) / 9);
    return this.play(name, {
      ...o,
      impulse: imp,
      volume: fin(o.volume, 1) * (0.28 + 0.85 * Math.pow(amt, 0.7)),
      priority: 0.45 + 0.4 * amt,
      minGap: 0.035,
    });
  }

  _resolveFallback(name) {
    const n = String(name || '');
    if (RECIPES[n]) return n;
    // weapon/<something>/fire → weapon/default/fire
    const m = /^weapon\/([^/]+)\/(fire|hit)$/.exec(n);
    if (m) {
      const fam = weaponFamily(m[1]);
      const cand = `weapon/${fam}/${m[2]}`;
      if (RECIPES[cand]) return cand;
      return `weapon/default/${m[2]}`;
    }
    if (n.startsWith('impact/')) return 'impact/plastic';
    if (n.startsWith('ui/')) return 'ui/click';
    if (n.startsWith('race/')) return 'race/checkpoint';
    if (!this._warned.has(n)) {
      this._warned.add(n);
      console.warn(`[SFX] unknown sound "${n}" → generic blip`);
    }
    return 'generic';
  }

  // ─────────────────────────────────────────────────────── build helpers

  /** Deterministic-ish random per call. */
  _r() { return this.rng.next(); }
  _rr(a, b) { return a + (b - a) * this.rng.next(); }

  /**
   * A noise source. `kind` selects a shared buffer; everything loops so any
   * duration works and any offset is safe.
   */
  _noise(v, kind, t, dur, rate = 1) {
    const res = this.res;
    if (!res) return null;
    let buf = null;
    switch (kind) {
      case 'pink': buf = pinkFor(res, this._srcSlot++); break;
      case 'tick': buf = res.buffers.tick; break;
      case 'thump': buf = res.buffers.thump; break;
      case 'water': buf = res.buffers.water; break;
      case 'grit': buf = res.buffers.grit; break;
      case 'crackle': buf = res.buffers.crackle; break;
      case 'brown': buf = res.buffers.brown; break;
      default: buf = whiteFor(res, this._srcSlot++); break;
    }
    if (!buf) buf = whiteFor(res, 0);
    const s = loopSource(this.ctx, buf, { rate, when: t, offset: this._r() * (buf?.duration ?? 1) });
    if (!s) return null;
    v.attach(s);
    stopAt(s, t + dur + 0.05);
    return s;
  }

  /** An oscillator attached to the voice, stopped after `dur`. */
  _osc(v, t, dur, { wave = null, type = 'sine', freq = 440, detune = 0 } = {}) {
    const w = wave ? this.res?.waves?.[wave] : null;
    const o = osc(this.ctx, { wave: w, type, freq, detune, when: t });
    if (!o) return null;
    v.attach(o);
    stopAt(o, t + dur + 0.05);
    return o;
  }

  _gain(v, value = 0.0001) {
    const g = gain(this.ctx, value);
    if (g) v.attach(g);
    return g;
  }

  _filter(v, type, freq, Q, gainDb = 0) {
    const f = filter(this.ctx, type, freq, Q, gainDb);
    if (f) v.attach(f);
    return f;
  }

  /**
   * Band-limited noise burst with a percussive envelope.
   * @returns {number} end time
   */
  _burst(v, t, {
    kind = 'white', type = 'bandpass', freq = 1200, freq2 = 0, Q = 1.4,
    peak = 0.4, attack = 0.002, decay = 0.12, dur = 0, out = null, rate = 1,
  } = {}) {
    const total = Math.max(dur || 0, attack + decay + 0.02);
    const src = this._noise(v, kind, t, total, rate);
    if (!src) return t + total;
    const f = this._filter(v, type, freq, Q);
    const g = this._gain(v, 0.0001);
    if (!g) return t + total;
    chain(src, f, g);
    g.connect(out || v.input);
    perc(g.gain, t, peak, attack, decay);
    if (freq2 > 0 && f) sweep(f.frequency, t, freq, freq2, attack + decay);
    return t + total;
  }

  /**
   * A bank of high-Q bandpass resonators excited by a very short noise click.
   * The single most useful "material" primitive: metal, glass, wood, plastic.
   */
  _resonators(v, t, {
    freqs = [800, 1600], Q = 22, peak = 0.3, decay = 0.4, excite = 0.006,
    kind = 'tick', spread = 1, out = null, decaySpread = 0.55,
  } = {}) {
    const dest = out || v.input;
    const src = this._noise(v, kind, t, excite + 0.02);
    if (!src) return t + decay;
    const exG = this._gain(v, 0.0001);
    src.connect(exG);
    perc(exG.gain, t, 1.0, 0.0008, excite);
    let end = t;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i] * (1 + (this._r() - 0.5) * 0.02 * spread);
      const bp = this._filter(v, 'bandpass', f, Q * (0.7 + 0.6 * this._r()));
      const g = this._gain(v, 0.0001);
      exG.connect(bp); bp.connect(g); g.connect(dest);
      const dec = decay * (1 - decaySpread * (i / Math.max(1, freqs.length - 1)));
      const amp = peak / (1 + i * 0.55);
      const e = perc(g.gain, t, amp, 0.0015, Math.max(0.02, dec));
      if (e > end) end = e;
    }
    return end;
  }

  /** Classic 2-operator FM bell / chime / ping. */
  _fm(v, t, {
    freq = 440, ratio = 3.5, index = 6, peak = 0.3, attack = 0.003,
    decay = 0.7, modDecay = 0.25, out = null, type = 'sine',
  } = {}) {
    const dest = out || v.input;
    const car = this._osc(v, t, attack + decay, { type, freq });
    const mod = this._osc(v, t, attack + decay, { type: 'sine', freq: freq * ratio });
    if (!car || !mod) return t + decay;
    const mg = this._gain(v, 0.0001);
    mod.connect(mg);
    mg.connect(car.frequency);
    setParam(mg.gain, freq * index, t);
    expTo(mg.gain, freq * index * 0.01, t + Math.max(0.01, modDecay));
    const g = this._gain(v, 0.0001);
    car.connect(g); g.connect(dest);
    return perc(g.gain, t, peak, attack, decay);
  }

  /** A pitched sine/tri "body" with an exponential frequency sweep. */
  _body(v, t, {
    f0 = 160, f1 = 60, dur = 0.3, peak = 0.5, attack = 0.004,
    type = 'sine', out = null, wave = null,
  } = {}) {
    const dest = out || v.input;
    const o = this._osc(v, t, dur, { type, wave, freq: f0 });
    if (!o) return t + dur;
    const g = this._gain(v, 0.0001);
    o.connect(g); g.connect(dest);
    sweep(o.frequency, t, f0, f1, dur * 0.9);
    return perc(g.gain, t, peak, attack, dur);
  }

  /** A short saturated buzz — electro, error, deny. */
  _buzz(v, t, { freq = 140, dur = 0.2, peak = 0.3, out = null, fold = true } = {}) {
    const dest = out || v.input;
    const o = this._osc(v, t, dur, { wave: 'saw', type: 'sawtooth', freq });
    if (!o) return t + dur;
    const sh = fold ? shaper(this.ctx, this.res.curves.fold, 'none') : null;
    if (sh) v.attach(sh);
    const bp = this._filter(v, 'bandpass', freq * 6, 1.2);
    const g = this._gain(v, 0.0001);
    chain(o, sh, bp, g);
    g.connect(dest);
    return perc(g.gain, t, peak, 0.004, dur);
  }
}

/* ══════════════════════════════════════════════════════════════ recipes ══ */

/**
 * Recipe metadata:
 *   dur      nominal length (seconds) — used for voice budgeting
 *   prio     0..1 stealing priority
 *   gain     baked level trim
 *   reverb   send amount
 *   minGap   minimum seconds between two plays of this exact recipe
 *   bus      'sfx' (default) | 'ui' | 'engine' | 'music'
 *   spatial  false to force a 2D sound (UI)
 *   build(v, t, o) → duration
 */
export const RECIPES = {

  // ───────────────────────────────────────────────── collisions & impacts

  'impact/plastic': {
    dur: 0.30, prio: 0.55, gain: 0.95, reverb: 0.22, minGap: 0.02,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 2)) - 0.2) / 9);
      const p = 0.35 + 0.5 * amt;
      // Hard plastic clack: two short resonances + a bright click.
      const end = this._resonators(v, t, {
        freqs: [1180 * this._rr(0.94, 1.07), 1960, 3120],
        Q: 13, peak: p, decay: 0.10 + 0.09 * amt, excite: 0.0045, kind: 'tick',
      });
      this._burst(v, t, { kind: 'tick', type: 'bandpass', freq: 4200, Q: 0.9, peak: 0.22 * p, attack: 0.0008, decay: 0.025 });
      // A little body so it has mass.
      this._body(v, t, { f0: 150 - 30 * amt, f1: 74, dur: 0.075 + 0.06 * amt, peak: 0.30 * p, type: 'sine' });
      return Math.max(end, t + 0.2) - t;
    },
  },

  'impact/metal': {
    dur: 1.10, prio: 0.65, gain: 0.9, reverb: 0.38, minGap: 0.03,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 2)) - 0.2) / 9);
      const p = 0.28 + 0.42 * amt;
      const dec = 0.32 + 0.85 * amt;
      const base = this._rr(0.93, 1.08);
      const end = this._resonators(v, t, {
        // Inharmonic ratios — a real plate/can, not a tuned bell.
        freqs: [612 * base, 1178 * base, 1495 * base, 2371 * base, 3910 * base, 5620 * base],
        Q: 30, peak: p, decay: dec, excite: 0.0035, kind: 'tick', decaySpread: 0.62,
      });
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 3000, Q: 0.7, peak: 0.30 * p, attack: 0.0006, decay: 0.03 });
      this._body(v, t, { f0: 210 - 55 * amt, f1: 92, dur: 0.1 + 0.07 * amt, peak: 0.24 * p });
      // A dirty scrape-flavoured tail on the big ones.
      if (amt > 0.4) {
        this._burst(v, t + 0.01, { kind: 'grit', type: 'bandpass', freq: 1800, freq2: 700, Q: 1.1, peak: 0.10 * p, attack: 0.01, decay: 0.28 * amt });
      }
      return Math.max(end, t + 0.3) - t;
    },
  },

  'impact/glass': {
    dur: 0.70, prio: 0.62, gain: 0.85, reverb: 0.34, minGap: 0.03,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 2)) - 0.2) / 9);
      const p = 0.24 + 0.34 * amt;
      const b = this._rr(0.95, 1.06);
      const end = this._resonators(v, t, {
        freqs: [2480 * b, 3310 * b, 4620 * b, 5870 * b, 7240 * b],
        Q: 34, peak: p, decay: 0.22 + 0.30 * amt, excite: 0.0026, kind: 'tick', decaySpread: 0.5,
      });
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 5000, Q: 0.7, peak: 0.24 * p, attack: 0.0005, decay: 0.02 });
      // Little shards on hard hits.
      if (amt > 0.35) {
        for (let i = 0; i < 3; i++) {
          const dt = 0.03 + this._r() * 0.14;
          this._resonators(v, t + dt, {
            freqs: [this._rr(3200, 7600)], Q: 30, peak: 0.10 * p, decay: 0.10, excite: 0.002, kind: 'tick',
          });
        }
      }
      return Math.max(end, t + 0.3) - t;
    },
  },

  'impact/wood': {
    dur: 0.35, prio: 0.55, gain: 0.95, reverb: 0.24, minGap: 0.02,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 2)) - 0.2) / 9);
      const p = 0.34 + 0.5 * amt;
      const b = this._rr(0.9, 1.1);
      const end = this._resonators(v, t, {
        freqs: [372 * b, 748 * b, 1216 * b, 2040 * b],
        Q: 15, peak: p, decay: 0.11 + 0.10 * amt, excite: 0.005, kind: 'tick',
      });
      this._body(v, t, { f0: 128 - 24 * amt, f1: 62, dur: 0.1 + 0.08 * amt, peak: 0.38 * p });
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 900, Q: 0.8, peak: 0.20 * p, attack: 0.001, decay: 0.05 });
      return Math.max(end, t + 0.22) - t;
    },
  },

  'impact/thud': {
    dur: 0.34, prio: 0.5, gain: 1.0, reverb: 0.16, minGap: 0.02,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 2)) - 0.2) / 9);
      const p = 0.45 + 0.55 * amt;
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 320 + 180 * amt, Q: 1.0, peak: 0.5 * p, attack: 0.002, decay: 0.10 + 0.09 * amt });
      const e = this._body(v, t, { f0: 138 - 34 * amt, f1: 52, dur: 0.15 + 0.12 * amt, peak: 0.55 * p });
      this._burst(v, t, { kind: 'white', type: 'bandpass', freq: 1500, Q: 0.8, peak: 0.09 * p, attack: 0.001, decay: 0.03 });
      return Math.max(e, t + 0.2) - t;
    },
  },

  'impact/soft': {
    dur: 0.26, prio: 0.42, gain: 0.9, reverb: 0.10, minGap: 0.02,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 2)) - 0.2) / 9);
      const p = 0.4 + 0.4 * amt;
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 230, Q: 0.8, peak: 0.55 * p, attack: 0.004, decay: 0.09 });
      this._burst(v, t, { kind: 'pink', type: 'bandpass', freq: 700, Q: 0.7, peak: 0.16 * p, attack: 0.003, decay: 0.07 });
      return 0.2;
    },
  },

  'impact/rubber': {
    dur: 0.34, prio: 0.5, gain: 0.95, reverb: 0.14, minGap: 0.02,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 2)) - 0.2) / 9);
      const p = 0.42 + 0.45 * amt;
      // Rubber = a fat, slightly pitched boing with almost no high end.
      const e = this._body(v, t, { f0: 196 - 40 * amt, f1: 108, dur: 0.16 + 0.1 * amt, peak: 0.55 * p, type: 'triangle' });
      this._resonators(v, t, { freqs: [318, 512], Q: 9, peak: 0.24 * p, decay: 0.12, excite: 0.006, kind: 'thump' });
      return Math.max(e, t + 0.22) - t;
    },
  },

  'impact/gravel': {
    dur: 0.40, prio: 0.48, gain: 0.95, reverb: 0.14, minGap: 0.02,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 2)) - 0.2) / 9);
      const p = 0.4 + 0.45 * amt;
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 300, Q: 0.9, peak: 0.42 * p, attack: 0.003, decay: 0.09 });
      this._burst(v, t, { kind: 'grit', type: 'bandpass', freq: 1400, Q: 0.6, peak: 0.24 * p, attack: 0.002, decay: 0.18 + 0.1 * amt });
      // Scattered stones.
      for (let i = 0; i < 4; i++) {
        this._resonators(v, t + 0.01 + this._r() * 0.13, {
          freqs: [this._rr(900, 2600)], Q: 12, peak: 0.07 * p, decay: 0.04, excite: 0.002, kind: 'tick',
        });
      }
      return 0.34;
    },
  },

  'impact/prop': {
    dur: 0.45, prio: 0.42, gain: 0.85, reverb: 0.22, minGap: 0.02,
    build(v, t, o) {
      const amt = clamp01((Math.abs(fin(o.impulse, 1.5)) - 0.2) / 6);
      const p = 0.3 + 0.5 * amt;
      const n = 2 + Math.floor(this._r() * 3);
      for (let i = 0; i < n; i++) {
        const dt = i * (0.012 + this._r() * 0.05);
        this._resonators(v, t + dt, {
          freqs: [this._rr(700, 1700), this._rr(1900, 3400)],
          Q: 12, peak: p * (1 - i * 0.22), decay: 0.07, excite: 0.004, kind: 'tick',
        });
      }
      this._body(v, t, { f0: 170, f1: 88, dur: 0.08, peak: 0.22 * p });
      return 0.34;
    },
  },

  'impact/wall': { alias: 'impact/plastic' },

  // ───────────────────────────────────────────────────────────── landings

  land: {
    dur: 0.42, prio: 0.6, gain: 1.0, reverb: 0.2, minGap: 0.04,
    build(v, t, o) {
      const amt = clamp01(fin(o.impactSpeed, 4) / 11);
      const p = 0.32 + 0.6 * amt;
      // Chassis thud
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 340 + 160 * amt, Q: 1.1, peak: 0.5 * p, attack: 0.002, decay: 0.09 + 0.06 * amt });
      this._body(v, t, { f0: 150 - 30 * amt, f1: 58, dur: 0.14 + 0.1 * amt, peak: 0.48 * p });
      // Suspension rebound — a damped boing that follows the thud.
      this._body(v, t + 0.028, { f0: 250, f1: 172, dur: 0.16 + 0.12 * amt, peak: 0.22 * p, type: 'triangle' });
      // Tire chirp
      this._burst(v, t + 0.006, { kind: 'white', type: 'bandpass', freq: 1650, freq2: 1050, Q: 5.5, peak: 0.2 * p * amt, attack: 0.004, decay: 0.10 });
      // Plastic body rattle on hard landings
      if (amt > 0.45) {
        this._resonators(v, t + 0.02, { freqs: [980, 1720, 2540], Q: 12, peak: 0.16 * p, decay: 0.09, excite: 0.004, kind: 'tick' });
      }
      return 0.4;
    },
  },

  'land/soft': {
    dur: 0.3, prio: 0.5, gain: 0.9, reverb: 0.1,
    build(v, t, o) {
      const amt = clamp01(fin(o.impactSpeed, 4) / 11);
      const p = 0.3 + 0.5 * amt;
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 220, Q: 0.9, peak: 0.55 * p, attack: 0.004, decay: 0.10 });
      this._burst(v, t, { kind: 'pink', type: 'bandpass', freq: 620, Q: 0.6, peak: 0.18 * p, attack: 0.004, decay: 0.11 });
      this._body(v, t + 0.02, { f0: 205, f1: 150, dur: 0.13, peak: 0.16 * p, type: 'triangle' });
      return 0.28;
    },
  },

  'land/loose': {
    dur: 0.42, prio: 0.5, gain: 0.95, reverb: 0.12,
    build(v, t, o) {
      const amt = clamp01(fin(o.impactSpeed, 4) / 11);
      const p = 0.3 + 0.55 * amt;
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 280, Q: 1.0, peak: 0.5 * p, attack: 0.003, decay: 0.09 });
      this._burst(v, t, { kind: 'grit', type: 'bandpass', freq: 1250, Q: 0.55, peak: 0.28 * p, attack: 0.003, decay: 0.22 });
      for (let i = 0; i < 5; i++) {
        this._resonators(v, t + 0.02 + this._r() * 0.16, {
          freqs: [this._rr(1000, 2900)], Q: 11, peak: 0.06 * p, decay: 0.035, excite: 0.002, kind: 'tick',
        });
      }
      return 0.4;
    },
  },

  'land/metal': {
    dur: 0.9, prio: 0.58, gain: 0.9, reverb: 0.36,
    build(v, t, o) {
      const amt = clamp01(fin(o.impactSpeed, 4) / 11);
      const p = 0.26 + 0.4 * amt;
      const e = this._resonators(v, t, {
        freqs: [428, 903, 1327, 2180, 3540], Q: 26, peak: p, decay: 0.4 + 0.4 * amt, excite: 0.004, kind: 'tick',
      });
      this._body(v, t, { f0: 160, f1: 62, dur: 0.14, peak: 0.4 * p });
      return Math.max(e, t + 0.4) - t;
    },
  },

  'jump/launch': {
    dur: 0.4, prio: 0.45, gain: 0.8, reverb: 0.15,
    build(v, t) {
      this._body(v, t, { f0: 180, f1: 320, dur: 0.13, peak: 0.2, type: 'triangle' });
      this._burst(v, t, { kind: 'white', type: 'bandpass', freq: 700, freq2: 2400, Q: 0.8, peak: 0.14, attack: 0.02, decay: 0.22 });
      return 0.35;
    },
  },

  // ──────────────────────────────────────────────────────────────── water

  splash: {
    dur: 0.75, prio: 0.55, gain: 1.0, reverb: 0.2, minGap: 0.05,
    build(v, t, o) {
      const amt = clamp01(fin(o.impulse, fin(o.impactSpeed, 3)) / 8);
      const p = 0.3 + 0.4 * amt;
      // Sharp entry
      this._burst(v, t, { kind: 'water', type: 'bandpass', freq: 1200, freq2: 4200, Q: 0.7, peak: 0.55 * p, attack: 0.003, decay: 0.14 });
      // Gloop
      this._body(v, t + 0.005, { f0: 420, f1: 150, dur: 0.11, peak: 0.24 * p, type: 'sine' });
      // Spray tail
      this._burst(v, t + 0.02, { kind: 'water', type: 'highpass', freq: 2600, Q: 0.7, peak: 0.20 * p, attack: 0.03, decay: 0.38 });
      // A couple of droplet plinks
      for (let i = 0; i < 3; i++) {
        this._fm(v, t + 0.08 + this._r() * 0.28, {
          freq: this._rr(900, 2200), ratio: 1.4, index: 2, peak: 0.05 * p, decay: 0.09, modDecay: 0.04,
        });
      }
      return 0.7;
    },
  },

  'splash/big': {
    dur: 1.2, prio: 0.65, gain: 1.0, reverb: 0.3,
    build(v, t, o) {
      const amt = clamp01(fin(o.impactSpeed, 6) / 10);
      const p = 0.45 + 0.45 * amt;
      this._burst(v, t, { kind: 'water', type: 'bandpass', freq: 800, freq2: 3600, Q: 0.6, peak: 0.7 * p, attack: 0.004, decay: 0.22 });
      this._body(v, t, { f0: 300, f1: 90, dur: 0.2, peak: 0.34 * p });
      this._burst(v, t + 0.03, { kind: 'water', type: 'highpass', freq: 1800, Q: 0.6, peak: 0.3 * p, attack: 0.05, decay: 0.7 });
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 200, Q: 0.9, peak: 0.3 * p, attack: 0.005, decay: 0.16 });
      for (let i = 0; i < 6; i++) {
        this._fm(v, t + 0.1 + this._r() * 0.6, {
          freq: this._rr(700, 2400), ratio: 1.5, index: 2.5, peak: 0.05 * p, decay: 0.11, modDecay: 0.05,
        });
      }
      return 1.1;
    },
  },

  'water/enter': { alias: 'splash' },

  'water/exit': {
    dur: 0.6, prio: 0.45, gain: 0.85, reverb: 0.18,
    build(v, t) {
      this._burst(v, t, { kind: 'water', type: 'bandpass', freq: 3200, freq2: 900, Q: 0.7, peak: 0.3, attack: 0.02, decay: 0.34 });
      this._body(v, t, { f0: 180, f1: 380, dur: 0.14, peak: 0.12 });
      return 0.55;
    },
  },

  // ───────────────────────────────────────────────────────────── pickups

  'pickup/collect': {
    dur: 0.75, prio: 0.75, gain: 0.9, reverb: 0.24, spatial: true,
    build(v, t) {
      // Bright ascending triad — the Re-Volt "got it" feeling.
      const root = 76;                       // E5
      const steps = [0, 4, 7, 12];
      for (let i = 0; i < steps.length; i++) {
        this._fm(v, t + i * 0.055, {
          freq: noteHz(root + steps[i]), ratio: 2.01, index: 3.2,
          peak: 0.22 - i * 0.02, attack: 0.002, decay: 0.34 - i * 0.04, modDecay: 0.07,
        });
      }
      // Sparkle
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 5200, Q: 0.7, peak: 0.10, attack: 0.004, decay: 0.3 });
      return 0.7;
    },
  },

  'pickup/assign': {
    dur: 0.5, prio: 0.75, gain: 0.9, reverb: 0.2,
    build(v, t) {
      this._fm(v, t, { freq: noteHz(72), ratio: 3.0, index: 4, peak: 0.24, decay: 0.2, modDecay: 0.06 });
      this._fm(v, t + 0.07, { freq: noteHz(79), ratio: 3.0, index: 4, peak: 0.26, decay: 0.34, modDecay: 0.08 });
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 4200, Q: 0.8, peak: 0.07, attack: 0.002, decay: 0.1 });
      return 0.45;
    },
  },

  'pickup/deny': {
    dur: 0.35, prio: 0.6, gain: 0.8,
    build(v, t) {
      this._buzz(v, t, { freq: 150, dur: 0.1, peak: 0.2 });
      this._buzz(v, t + 0.1, { freq: 112, dur: 0.16, peak: 0.18 });
      return 0.32;
    },
  },

  // ─────────────────────────────────────────────────────────────── weapons

  'weapon/firework/fire': {
    dur: 1.5, prio: 0.85, gain: 1.0, reverb: 0.28,
    build(v, t) {
      // Launch thunk
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 420, Q: 1.0, peak: 0.45, attack: 0.001, decay: 0.07 });
      // Motor ignite: noise rising through a bandpass
      const src = this._noise(v, 'white', t, 1.3);
      const bp = this._filter(v, 'bandpass', 380, 1.3);
      const g = this._gain(v, 0.0001);
      chain(src, bp, g); g.connect(v.input);
      asr(g.gain, t, 0.34, 0.03, 0.35, 0.8);
      sweep(bp.frequency, t, 380, 2700, 0.85);
      targetTo(bp.Q, 2.4, t, 0.4);
      // Screaming pitched core (this is the bit that reads as "firework")
      const o1 = this._osc(v, t, 1.25, { wave: 'saw', type: 'sawtooth', freq: 240 });
      const lp = this._filter(v, 'lowpass', 1800, 3.2);
      const g2 = this._gain(v, 0.0001);
      chain(o1, lp, g2); g2.connect(v.input);
      sweep(o1.frequency, t, 210, 640, 0.9);
      sweep(lp.frequency, t, 900, 4200, 0.9);
      asr(g2.gain, t, 0.14, 0.05, 0.3, 0.75);
      // Crackle sparkle
      this._burst(v, t + 0.05, { kind: 'crackle', type: 'bandpass', freq: 3400, Q: 1.0, peak: 0.12, attack: 0.05, decay: 0.9 });
      return 1.45;
    },
  },

  'weapon/firework/hit': { alias: 'explosion' },

  'weapon/oil/fire': {
    dur: 0.8, prio: 0.6, gain: 0.9, reverb: 0.16,
    build(v, t) {
      // Glug-glug-splat.
      for (let i = 0; i < 3; i++) {
        this._body(v, t + i * 0.085, { f0: 380 - i * 70, f1: 130 - i * 25, dur: 0.11, peak: 0.22 - i * 0.03, type: 'sine' });
      }
      this._burst(v, t + 0.2, { kind: 'water', type: 'lowpass', freq: 1100, Q: 0.9, peak: 0.3, attack: 0.02, decay: 0.34 });
      this._burst(v, t + 0.22, { kind: 'pink', type: 'bandpass', freq: 500, Q: 0.6, peak: 0.16, attack: 0.03, decay: 0.4 });
      return 0.75;
    },
  },

  'weapon/oil/hit': {
    dur: 0.6, prio: 0.5, gain: 0.85, reverb: 0.14,
    build(v, t) {
      this._burst(v, t, { kind: 'water', type: 'lowpass', freq: 900, Q: 0.9, peak: 0.34, attack: 0.008, decay: 0.3 });
      this._body(v, t, { f0: 260, f1: 96, dur: 0.16, peak: 0.2 });
      return 0.55;
    },
  },

  'weapon/balloon/fire': {
    dur: 0.7, prio: 0.7, gain: 0.9, reverb: 0.18,
    build(v, t) {
      // Wobbling water mass being thrown.
      const o1 = this._osc(v, t, 0.5, { type: 'sine', freq: 620 });
      const g = this._gain(v, 0.0001);
      o1.connect(g); g.connect(v.input);
      sweep(o1.frequency, t, 620, 260, 0.42);
      // Vibrato to sell the wobble.
      const lfo = this._osc(v, t, 0.5, { type: 'sine', freq: 11 });
      const ld = this._gain(v, 55);
      lfo.connect(ld); ld.connect(o1.frequency);
      perc(g.gain, t, 0.22, 0.008, 0.4);
      this._burst(v, t, { kind: 'water', type: 'bandpass', freq: 1400, Q: 0.7, peak: 0.18, attack: 0.006, decay: 0.2 });
      return 0.65;
    },
  },

  'weapon/balloon/hit': { alias: 'splash/big' },

  'weapon/electro/fire': {
    dur: 1.0, prio: 0.85, gain: 0.9, reverb: 0.22,
    build(v, t) {
      // Capacitor charge-up then release.
      const o1 = this._osc(v, t, 0.6, { wave: 'saw', type: 'sawtooth', freq: 180 });
      const sh = shaper(this.ctx, this.res.curves.fold, 'none'); v.attach(sh);
      const bp = this._filter(v, 'bandpass', 900, 2.0);
      const g = this._gain(v, 0.0001);
      chain(o1, sh, bp, g); g.connect(v.input);
      sweep(o1.frequency, t, 170, 1500, 0.34);
      sweep(bp.frequency, t, 700, 4200, 0.34);
      asr(g.gain, t, 0.20, 0.20, 0.06, 0.24);
      this._burst(v, t + 0.30, { kind: 'crackle', type: 'bandpass', freq: 2800, Q: 1.2, peak: 0.26, attack: 0.004, decay: 0.4 });
      return 0.95;
    },
  },

  'weapon/electro/hit': { alias: 'electro' },

  electro: {
    dur: 1.05, prio: 0.9, gain: 0.95, reverb: 0.3,
    build(v, t, o) {
      const amt = clamp01(fin(o.impulse, 5) / 8);
      const p = 0.22 + 0.2 * amt;
      // Arc: a folded saw whose frequency jumps randomly — that discontinuity is
      // the whole character of an electric zap.
      const o1 = this._osc(v, t, 0.85, { wave: 'saw', type: 'sawtooth', freq: 900 });
      const sh = shaper(this.ctx, this.res.curves.fold, '2x'); v.attach(sh);
      const bp = this._filter(v, 'bandpass', 2200, 2.6);
      const g = this._gain(v, 0.0001);
      chain(o1, sh, bp, g); g.connect(v.input);
      const steps = 14;
      for (let i = 0; i < steps; i++) {
        const tt = t + (i / steps) * 0.5;
        setParam(o1.frequency, this._rr(320, 2600), tt);
        setParam(bp.frequency, this._rr(1200, 6200), tt);
      }
      asr(g.gain, t, p * 1.6, 0.002, 0.20, 0.45);
      // Sizzle
      this._burst(v, t, { kind: 'crackle', type: 'highpass', freq: 2200, Q: 0.8, peak: p * 1.5, attack: 0.002, decay: 0.55 });
      // Sub thump so it lands with weight
      this._body(v, t, { f0: 120, f1: 42, dur: 0.18, peak: p * 1.1 });
      // Ring-mod shimmer tail: a sine gated by a square = classic "electric".
      const carrier = this._osc(v, t, 0.75, { type: 'sine', freq: 1870 });
      const ring = this._gain(v, 0);              // intrinsic 0 — the LFO opens it
      const modu = this._osc(v, t, 0.75, { type: 'square', freq: 63 });
      const modG = this._gain(v, 0.5);
      modu.connect(modG); modG.connect(ring.gain);
      carrier.connect(ring);
      const tail = this._gain(v, 0.0001);
      ring.connect(tail); tail.connect(v.input);
      perc(tail.gain, t + 0.015, p * 0.55, 0.012, 0.62);
      return 1.0;
    },
  },

  'weapon/ball/fire': {
    dur: 0.9, prio: 0.8, gain: 0.95, reverb: 0.3,
    build(v, t) {
      // Heavy steel ball launched: clang + low whoosh.
      this._resonators(v, t, { freqs: [318, 705, 1180, 2260], Q: 24, peak: 0.3, decay: 0.5, excite: 0.004, kind: 'tick' });
      this._body(v, t, { f0: 150, f1: 58, dur: 0.2, peak: 0.4 });
      this._burst(v, t + 0.01, { kind: 'white', type: 'bandpass', freq: 500, freq2: 1500, Q: 0.7, peak: 0.16, attack: 0.02, decay: 0.35 });
      return 0.85;
    },
  },

  'weapon/ball/hit': {
    dur: 1.2, prio: 0.85, gain: 1.0, reverb: 0.4,
    build(v, t, o) {
      return RECIPES['impact/metal'].build.call(this, v, t, { ...o, impulse: Math.max(6, fin(o.impulse, 8)) });
    },
  },

  'weapon/bomb/fire': {
    dur: 0.45, prio: 0.7, gain: 0.9, reverb: 0.2,
    build(v, t) {
      // Plant / arm: a mechanical clunk plus a rising "armed" beep.
      this._resonators(v, t, { freqs: [640, 1180, 1930], Q: 16, peak: 0.26, decay: 0.12, excite: 0.004, kind: 'tick' });
      this._body(v, t, { f0: 130, f1: 70, dur: 0.1, peak: 0.28 });
      this._fm(v, t + 0.1, { freq: noteHz(84), ratio: 2, index: 2, peak: 0.14, decay: 0.12, modDecay: 0.04 });
      return 0.4;
    },
  },

  'weapon/bomb/hit': { alias: 'explosion' },

  'weapon/shockwave/fire': { alias: 'shockwave' },
  'weapon/shockwave/hit': { alias: 'shockwave' },

  shockwave: {
    dur: 1.35, prio: 0.9, gain: 1.0, reverb: 0.34,
    build(v, t, o) {
      const amt = clamp01(fin(o.impulse, 6) / 10);
      const p = 0.5 + 0.4 * amt;
      // A rising pre-whoosh, then the whump.
      this._burst(v, t, { kind: 'white', type: 'bandpass', freq: 300, freq2: 1400, Q: 0.8, peak: 0.14 * p, attack: 0.08, decay: 0.12 });
      // The whump itself: a big sine falling out of hearing.
      const o1 = this._osc(v, t + 0.05, 0.85, { type: 'sine', freq: 190 });
      const g = this._gain(v, 0.0001);
      o1.connect(g); g.connect(v.input);
      sweep(o1.frequency, t + 0.05, 190, 26, 0.55);
      perc(g.gain, t + 0.05, 0.85 * p, 0.008, 0.7);
      // Body: lowpassed noise puff
      this._burst(v, t + 0.05, { kind: 'thump', type: 'lowpass', freq: 700, freq2: 130, Q: 1.1, peak: 0.5 * p, attack: 0.006, decay: 0.42 });
      // Air rush tail
      this._burst(v, t + 0.06, { kind: 'brown', type: 'bandpass', freq: 420, Q: 0.5, peak: 0.2 * p, attack: 0.05, decay: 0.85 });
      return 1.3;
    },
  },

  'weapon/turbo/fire': {
    dur: 0.5, prio: 0.7, gain: 0.9, reverb: 0.14,
    build(v, t) {
      // Ignition pop, then the loop handles the sustain.
      this._burst(v, t, { kind: 'tick', type: 'bandpass', freq: 1800, Q: 0.8, peak: 0.3, attack: 0.001, decay: 0.05 });
      this._burst(v, t, { kind: 'white', type: 'bandpass', freq: 600, freq2: 2600, Q: 0.9, peak: 0.3, attack: 0.01, decay: 0.4 });
      this._body(v, t, { f0: 90, f1: 200, dur: 0.2, peak: 0.24 });
      return 0.45;
    },
  },

  'weapon/turbo/hit': { alias: 'weapon/turbo/fire' },

  'weapon/battery/fire': {
    dur: 0.8, prio: 0.7, gain: 0.85, reverb: 0.16,
    build(v, t) {
      // Electric charge with a tremolo — "power up".
      const o1 = this._osc(v, t, 0.7, { wave: 'pulse25', type: 'square', freq: 220 });
      const bp = this._filter(v, 'bandpass', 1100, 2.2);
      const g = this._gain(v, 0.0001);
      chain(o1, bp, g); g.connect(v.input);
      sweep(o1.frequency, t, 200, 900, 0.55);
      sweep(bp.frequency, t, 800, 3600, 0.55);
      asr(g.gain, t, 0.18, 0.12, 0.28, 0.25);
      const lfo = this._osc(v, t, 0.7, { type: 'sine', freq: 17 });
      const ld = this._gain(v, 0.07);
      lfo.connect(ld); ld.connect(g.gain);
      this._burst(v, t + 0.45, { kind: 'tick', type: 'highpass', freq: 4200, Q: 0.7, peak: 0.10, attack: 0.003, decay: 0.2 });
      return 0.75;
    },
  },

  'weapon/clone/fire': {
    dur: 1.1, prio: 0.75, gain: 0.85, reverb: 0.3,
    build(v, t) {
      // Two sines converging + a shimmer sweep: "something duplicated".
      const a = this._osc(v, t, 0.9, { type: 'sine', freq: 520 });
      const b = this._osc(v, t, 0.9, { type: 'sine', freq: 660 });
      const g = this._gain(v, 0.0001);
      a.connect(g); b.connect(g); g.connect(v.input);
      sweep(a.frequency, t, 520, 880, 0.7);
      sweep(b.frequency, t, 660, 880, 0.7);
      asr(g.gain, t, 0.14, 0.06, 0.4, 0.35);
      this._burst(v, t, { kind: 'white', type: 'bandpass', freq: 1200, freq2: 6000, Q: 1.4, peak: 0.14, attack: 0.05, decay: 0.6 });
      this._fm(v, t + 0.55, { freq: noteHz(88), ratio: 2.01, index: 3, peak: 0.14, decay: 0.45, modDecay: 0.1 });
      return 1.05;
    },
  },

  'weapon/default/fire': {
    dur: 0.5, prio: 0.7, gain: 0.85, reverb: 0.18,
    build(v, t) {
      const o1 = this._osc(v, t, 0.35, { wave: 'saw', type: 'sawtooth', freq: 900 });
      const bp = this._filter(v, 'bandpass', 1400, 2.6);
      const g = this._gain(v, 0.0001);
      chain(o1, bp, g); g.connect(v.input);
      sweep(o1.frequency, t, 900, 190, 0.28);
      sweep(bp.frequency, t, 2600, 700, 0.28);
      perc(g.gain, t, 0.24, 0.003, 0.3);
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 3000, Q: 0.8, peak: 0.12, attack: 0.001, decay: 0.05 });
      return 0.45;
    },
  },

  'weapon/default/hit': {
    dur: 0.7, prio: 0.75, gain: 0.9, reverb: 0.24,
    build(v, t, o) {
      const amt = clamp01(fin(o.impulse, 5) / 9);
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 500, Q: 1.0, peak: 0.5 * (0.4 + 0.6 * amt), attack: 0.002, decay: 0.16 });
      this._body(v, t, { f0: 170, f1: 55, dur: 0.22, peak: 0.4 });
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 2600, Q: 0.7, peak: 0.2, attack: 0.001, decay: 0.07 });
      return 0.65;
    },
  },

  // ────────────────────────────────────────────────────────── explosions

  explosion: {
    dur: 2.0, prio: 0.95, gain: 1.0, reverb: 0.5,
    build(v, t, o) {
      const amt = clamp01(fin(o.impulse, 8) / 12);
      const p = 0.55 + 0.45 * amt;
      // 1. transient — a sharp, very short bright click
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 3800, Q: 0.7, peak: 0.6 * p, attack: 0.0006, decay: 0.03 });
      // 2. body — lowpass noise falling from bright to dark
      this._burst(v, t, { kind: 'white', type: 'lowpass', freq: 2600, freq2: 180, Q: 1.4, peak: 0.85 * p, attack: 0.004, decay: 0.42 + 0.2 * amt });
      // 3. sub — the punch you feel
      const o1 = this._osc(v, t, 0.8, { type: 'sine', freq: 110 });
      const g = this._gain(v, 0.0001);
      o1.connect(g); g.connect(v.input);
      sweep(o1.frequency, t, 110, 32, 0.5);
      perc(g.gain, t, 0.9 * p, 0.005, 0.62);
      // 4. debris — scattered clacks
      const n = 5 + Math.floor(this._r() * 5);
      for (let i = 0; i < n; i++) {
        this._resonators(v, t + 0.04 + this._r() * 0.5, {
          freqs: [this._rr(600, 2800)], Q: 14, peak: 0.09 * p, decay: 0.06, excite: 0.0025, kind: 'tick',
        });
      }
      // 5. tail — long dark rumble that the reverb can chew on
      this._burst(v, t + 0.02, { kind: 'brown', type: 'lowpass', freq: 900, freq2: 200, Q: 0.7, peak: 0.34 * p, attack: 0.04, decay: 1.35 });
      return 1.9;
    },
  },

  'explosion/small': {
    dur: 1.0, prio: 0.8, gain: 0.9, reverb: 0.4,
    build(v, t, o) {
      const amt = clamp01(fin(o.impulse, 4) / 8);
      const p = 0.4 + 0.4 * amt;
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 4200, Q: 0.7, peak: 0.4 * p, attack: 0.0006, decay: 0.02 });
      this._burst(v, t, { kind: 'white', type: 'lowpass', freq: 2200, freq2: 300, Q: 1.3, peak: 0.6 * p, attack: 0.003, decay: 0.22 });
      this._body(v, t, { f0: 140, f1: 46, dur: 0.32, peak: 0.55 * p });
      this._burst(v, t + 0.02, { kind: 'brown', type: 'lowpass', freq: 700, Q: 0.7, peak: 0.16 * p, attack: 0.03, decay: 0.6 });
      return 0.95;
    },
  },

  // ─────────────────────────────────────────────────────── race / events

  'race/beep': {
    dur: 0.35, prio: 0.95, gain: 1.0, reverb: 0.22, spatial: false,
    build(v, t, o) {
      const f = fin(o.freq, 700);
      // Click + tone: reads as a PA beep rather than a test tone.
      this._burst(v, t, { kind: 'tick', type: 'bandpass', freq: f * 4, Q: 0.9, peak: 0.14, attack: 0.0008, decay: 0.02 });
      const o1 = this._osc(v, t, 0.28, { type: 'square', freq: f });
      const o2 = this._osc(v, t, 0.28, { type: 'sine', freq: f * 2.002 });
      const lp = this._filter(v, 'lowpass', f * 5, 1.2);
      const g = this._gain(v, 0.0001);
      o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(v.input);
      asr(g.gain, t, 0.26, 0.004, 0.10, 0.12);
      return 0.3;
    },
  },

  'race/go': {
    dur: 1.1, prio: 1.0, gain: 1.0, reverb: 0.3, spatial: false,
    build(v, t) {
      // A toy air-horn stab: three saws (root, fifth, octave) through a bandpass.
      const root = 392;                       // G4
      const mult = [1, 1.5, 2, 2.505];
      const lp = this._filter(v, 'lowpass', 4200, 1.6);
      const g = this._gain(v, 0.0001);
      lp.connect(g); g.connect(v.input);
      for (let i = 0; i < mult.length; i++) {
        const o1 = this._osc(v, t, 0.85, {
          wave: 'saw', type: 'sawtooth', freq: root * mult[i], detune: (i - 1.5) * 9,
        });
        const og = this._gain(v, 0.42 / (1 + i * 0.5));
        o1.connect(og); og.connect(lp);
        // A tiny pitch rise at the start = the horn "catching".
        sweep(o1.frequency, t, root * mult[i] * 0.96, root * mult[i], 0.05);
      }
      asr(g.gain, t, 0.34, 0.008, 0.42, 0.3);
      sweep(lp.frequency, t, 2600, 5200, 0.12);
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 3000, Q: 0.7, peak: 0.16, attack: 0.001, decay: 0.04 });
      return 1.05;
    },
  },

  'race/lap': {
    dur: 1.3, prio: 0.9, gain: 0.95, reverb: 0.34, spatial: false,
    build(v, t) {
      const notes = [76, 81, 88];              // E5 A5 E6
      for (let i = 0; i < notes.length; i++) {
        this._fm(v, t + i * 0.085, {
          freq: noteHz(notes[i]), ratio: 3.01, index: 5,
          peak: 0.20 - i * 0.02, attack: 0.002, decay: 0.75 - i * 0.1, modDecay: 0.14,
        });
      }
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 6000, Q: 0.7, peak: 0.07, attack: 0.004, decay: 0.35 });
      return 1.25;
    },
  },

  'race/best': {
    dur: 1.5, prio: 0.9, gain: 0.95, reverb: 0.36, spatial: false,
    build(v, t) {
      const notes = [72, 76, 79, 84, 88];
      for (let i = 0; i < notes.length; i++) {
        this._fm(v, t + i * 0.07, {
          freq: noteHz(notes[i]), ratio: 2.01, index: 4.5,
          peak: 0.18, attack: 0.002, decay: 0.8 - i * 0.08, modDecay: 0.12,
        });
      }
      return 1.4;
    },
  },

  'race/checkpoint': {
    dur: 0.3, prio: 0.7, gain: 0.8, reverb: 0.16, spatial: false, minGap: 0.05,
    build(v, t) {
      this._fm(v, t, { freq: noteHz(84), ratio: 2, index: 1.6, peak: 0.14, decay: 0.09, modDecay: 0.03 });
      this._fm(v, t + 0.055, { freq: noteHz(91), ratio: 2, index: 1.6, peak: 0.15, decay: 0.14, modDecay: 0.04 });
      return 0.26;
    },
  },

  'race/finish': {
    dur: 1.9, prio: 1.0, gain: 1.0, reverb: 0.4, spatial: false,
    build(v, t) {
      // Short major fanfare.
      const seq = [[72, 0], [76, 0.10], [79, 0.20], [84, 0.30], [84, 0.52], [86, 0.62], [88, 0.72]];
      for (const [n, dt] of seq) {
        this._fm(v, t + dt, {
          freq: noteHz(n), ratio: 2.01, index: 4, peak: 0.17, attack: 0.003,
          decay: dt > 0.4 ? 0.9 : 0.35, modDecay: 0.1,
        });
        const o1 = this._osc(v, t + dt, 0.4, { wave: 'pulse25', type: 'square', freq: noteHz(n - 12) });
        const g = this._gain(v, 0.0001);
        const lp = this._filter(v, 'lowpass', 2200, 1.2);
        chain(o1, lp, g); g.connect(v.input);
        perc(g.gain, t + dt, 0.10, 0.005, 0.3);
      }
      return 1.85;
    },
  },

  'race/wrongway': {
    dur: 0.7, prio: 0.65, gain: 0.85, spatial: false, minGap: 1.2,
    build(v, t) {
      for (let i = 0; i < 3; i++) {
        this._buzz(v, t + i * 0.19, { freq: i % 2 ? 190 : 150, dur: 0.13, peak: 0.16 });
      }
      return 0.65;
    },
  },

  'race/position': {
    dur: 0.4, prio: 0.55, gain: 0.7, spatial: false, minGap: 0.25,
    build(v, t, o) {
      const up = o.up !== false;
      const a = up ? 74 : 79, b = up ? 81 : 72;
      this._fm(v, t, { freq: noteHz(a), ratio: 1.5, index: 2, peak: 0.11, decay: 0.13, modDecay: 0.04 });
      this._fm(v, t + 0.07, { freq: noteHz(b), ratio: 1.5, index: 2, peak: 0.12, decay: 0.2, modDecay: 0.05 });
      return 0.36;
    },
  },

  // ─────────────────────────────────────────────────────────────────── UI

  'ui/click': {
    dur: 0.12, prio: 0.4, gain: 0.7, reverb: 0.0, bus: 'ui', spatial: false, minGap: 0.02,
    build(v, t) {
      this._burst(v, t, { kind: 'tick', type: 'bandpass', freq: 2600, Q: 1.4, peak: 0.26, attack: 0.0008, decay: 0.022 });
      this._body(v, t, { f0: 1400, f1: 1050, dur: 0.03, peak: 0.14, type: 'triangle' });
      return 0.1;
    },
  },

  'ui/hover': {
    dur: 0.1, prio: 0.3, gain: 0.45, reverb: 0.0, bus: 'ui', spatial: false, minGap: 0.03,
    build(v, t) {
      this._burst(v, t, { kind: 'tick', type: 'bandpass', freq: 4200, Q: 2.0, peak: 0.11, attack: 0.001, decay: 0.02 });
      this._body(v, t, { f0: 2400, f1: 2200, dur: 0.022, peak: 0.05, type: 'sine' });
      return 0.08;
    },
  },

  'ui/confirm': {
    dur: 0.4, prio: 0.55, gain: 0.75, reverb: 0.05, bus: 'ui', spatial: false,
    build(v, t) {
      this._fm(v, t, { freq: noteHz(79), ratio: 2, index: 2.2, peak: 0.16, decay: 0.12, modDecay: 0.04 });
      this._fm(v, t + 0.065, { freq: noteHz(86), ratio: 2, index: 2.2, peak: 0.17, decay: 0.26, modDecay: 0.06 });
      return 0.36;
    },
  },

  'ui/back': {
    dur: 0.32, prio: 0.5, gain: 0.7, reverb: 0.05, bus: 'ui', spatial: false,
    build(v, t) {
      this._fm(v, t, { freq: noteHz(74), ratio: 2, index: 2, peak: 0.14, decay: 0.1, modDecay: 0.035 });
      this._fm(v, t + 0.06, { freq: noteHz(67), ratio: 2, index: 2, peak: 0.14, decay: 0.2, modDecay: 0.05 });
      return 0.3;
    },
  },

  'ui/error': {
    dur: 0.4, prio: 0.6, gain: 0.7, bus: 'ui', spatial: false,
    build(v, t) {
      this._buzz(v, t, { freq: 165, dur: 0.11, peak: 0.18 });
      this._buzz(v, t + 0.12, { freq: 124, dur: 0.2, peak: 0.17 });
      return 0.36;
    },
  },

  'ui/select': {
    dur: 0.25, prio: 0.5, gain: 0.7, bus: 'ui', spatial: false,
    build(v, t) {
      this._fm(v, t, { freq: noteHz(88), ratio: 3, index: 3, peak: 0.14, decay: 0.2, modDecay: 0.05 });
      this._burst(v, t, { kind: 'tick', type: 'highpass', freq: 6000, Q: 0.8, peak: 0.06, attack: 0.001, decay: 0.06 });
      return 0.22;
    },
  },

  'ui/whoosh': {
    dur: 0.5, prio: 0.45, gain: 0.6, bus: 'ui', spatial: false,
    build(v, t) {
      this._burst(v, t, { kind: 'white', type: 'bandpass', freq: 500, freq2: 3200, Q: 1.1, peak: 0.16, attack: 0.05, decay: 0.35 });
      return 0.45;
    },
  },

  // ───────────────────────────────────────────────────────────── misc SFX

  horn: {
    dur: 0.55, prio: 0.7, gain: 0.85, reverb: 0.2, minGap: 0.18,
    build(v, t, o) {
      const dur = clamp(fin(o.duration, 0.34), 0.1, 1.4);
      const f = fin(o.freq, 466);              // toy horn, slightly sharp
      const lp = this._filter(v, 'lowpass', 3200, 1.4);
      const g = this._gain(v, 0.0001);
      lp.connect(g); g.connect(v.input);
      for (const m of [1, 1.26, 2.01]) {
        const o1 = this._osc(v, t, dur + 0.15, { wave: 'pulse25', type: 'square', freq: f * m });
        const og = this._gain(v, 0.4 / m);
        o1.connect(og); og.connect(lp);
        const lfo = this._osc(v, t, dur + 0.15, { type: 'sine', freq: 6.2 });
        const ld = this._gain(v, f * m * 0.006);
        lfo.connect(ld); ld.connect(o1.frequency);
      }
      asr(g.gain, t, 0.26, 0.012, dur, 0.09);
      return dur + 0.16;
    },
  },

  bell: {
    dur: 1.4, prio: 0.6, gain: 0.8, reverb: 0.4,
    build(v, t, o) {
      const n = fin(o.note, 79);
      this._fm(v, t, { freq: noteHz(n), ratio: 3.51, index: 6, peak: 0.2, decay: 1.2, modDecay: 0.24 });
      return 1.35;
    },
  },

  whoosh: {
    dur: 0.6, prio: 0.45, gain: 0.7, reverb: 0.2,
    build(v, t, o) {
      const up = o.up !== false;
      this._burst(v, t, {
        kind: 'white', type: 'bandpass',
        freq: up ? 380 : 3000, freq2: up ? 3200 : 380, Q: 1.2,
        peak: 0.22, attack: 0.06, decay: 0.42,
      });
      return 0.55;
    },
  },

  respawn: {
    dur: 0.9, prio: 0.8, gain: 0.85, reverb: 0.3,
    build(v, t) {
      this._burst(v, t, { kind: 'white', type: 'bandpass', freq: 3000, freq2: 500, Q: 1.4, peak: 0.2, attack: 0.05, decay: 0.3 });
      this._fm(v, t + 0.24, { freq: noteHz(72), ratio: 2.01, index: 3, peak: 0.16, decay: 0.5, modDecay: 0.1 });
      this._fm(v, t + 0.31, { freq: noteHz(79), ratio: 2.01, index: 3, peak: 0.16, decay: 0.55, modDecay: 0.1 });
      return 0.85;
    },
  },

  spark: {
    dur: 0.18, prio: 0.35, gain: 0.6, reverb: 0.16, minGap: 0.025,
    build(v, t) {
      this._burst(v, t, { kind: 'crackle', type: 'highpass', freq: 4200, Q: 0.9, peak: 0.16, attack: 0.001, decay: 0.09 });
      this._resonators(v, t, { freqs: [this._rr(3200, 6800)], Q: 24, peak: 0.08, decay: 0.06, excite: 0.0015, kind: 'tick' });
      return 0.15;
    },
  },

  squash: {
    dur: 0.6, prio: 0.7, gain: 0.85, reverb: 0.16,
    build(v, t) {
      // Comedy squish: descending filtered noise + a rubbery body.
      this._burst(v, t, { kind: 'pink', type: 'lowpass', freq: 2600, freq2: 320, Q: 1.6, peak: 0.3, attack: 0.006, decay: 0.28 });
      this._body(v, t, { f0: 320, f1: 90, dur: 0.3, peak: 0.28, type: 'triangle' });
      this._burst(v, t + 0.24, { kind: 'water', type: 'bandpass', freq: 900, Q: 0.8, peak: 0.12, attack: 0.01, decay: 0.2 });
      return 0.55;
    },
  },

  unsquash: {
    dur: 0.5, prio: 0.6, gain: 0.8, reverb: 0.16,
    build(v, t) {
      this._body(v, t, { f0: 110, f1: 420, dur: 0.26, peak: 0.24, type: 'triangle' });
      this._burst(v, t, { kind: 'pink', type: 'lowpass', freq: 400, freq2: 3000, Q: 1.4, peak: 0.2, attack: 0.02, decay: 0.24 });
      return 0.45;
    },
  },

  freeze: {
    dur: 1.2, prio: 0.75, gain: 0.85, reverb: 0.4,
    build(v, t) {
      this._burst(v, t, { kind: 'white', type: 'highpass', freq: 4000, Q: 0.8, peak: 0.22, attack: 0.01, decay: 0.5 });
      for (let i = 0; i < 6; i++) {
        this._fm(v, t + this._r() * 0.4, {
          freq: this._rr(2200, 6200), ratio: 1.41, index: 2.4, peak: 0.07, decay: 0.5, modDecay: 0.12,
        });
      }
      this._body(v, t, { f0: 260, f1: 90, dur: 0.3, peak: 0.16 });
      return 1.1;
    },
  },

  shield: {
    dur: 1.0, prio: 0.7, gain: 0.8, reverb: 0.3,
    build(v, t) {
      const o1 = this._osc(v, t, 0.9, { wave: 'pad', type: 'sine', freq: 220 });
      const bp = this._filter(v, 'bandpass', 900, 1.4);
      const g = this._gain(v, 0.0001);
      chain(o1, bp, g); g.connect(v.input);
      sweep(o1.frequency, t, 180, 440, 0.6);
      sweep(bp.frequency, t, 600, 3200, 0.6);
      asr(g.gain, t, 0.16, 0.1, 0.4, 0.4);
      this._fm(v, t + 0.5, { freq: noteHz(84), ratio: 2.01, index: 3, peak: 0.1, decay: 0.4, modDecay: 0.1 });
      return 0.95;
    },
  },

  'crowd/cheer': {
    dur: 2.6, prio: 0.55, gain: 0.7, reverb: 0.4, spatial: false,
    build(v, t, o) {
      const amt = clamp01(fin(o.intensity, 0.8));
      // Crowd = broadband noise through vowel-ish formants + scattered claps.
      const src = this._noise(v, 'pink', t, 2.5);
      const g = this._gain(v, 0.0001);
      const f1 = this._filter(v, 'bandpass', 620, 1.1);
      const f2 = this._filter(v, 'bandpass', 1480, 1.4);
      const f3 = this._filter(v, 'bandpass', 2900, 1.8);
      const mix = this._gain(v, 1);
      src.connect(f1); src.connect(f2); src.connect(f3);
      f1.connect(mix); f2.connect(mix); f3.connect(mix);
      mix.connect(g); g.connect(v.input);
      asr(g.gain, t, 0.28 * (0.5 + 0.5 * amt), 0.35, 0.7, 1.3);
      sweep(f2.frequency, t, 1200, 1700, 0.9);
      // Claps
      const n = 10 + Math.floor(this._r() * 14 * amt);
      for (let i = 0; i < n; i++) {
        this._burst(v, t + 0.1 + this._r() * 2.0, {
          kind: 'tick', type: 'bandpass', freq: this._rr(1400, 3200), Q: 1.1,
          peak: 0.05 + 0.05 * this._r(), attack: 0.001, decay: 0.03,
        });
      }
      return 2.5;
    },
  },

  'crowd/gasp': {
    dur: 1.4, prio: 0.5, gain: 0.6, reverb: 0.35, spatial: false,
    build(v, t) {
      const src = this._noise(v, 'pink', t, 1.3);
      const bp = this._filter(v, 'bandpass', 900, 1.0);
      const g = this._gain(v, 0.0001);
      chain(src, bp, g); g.connect(v.input);
      asr(g.gain, t, 0.2, 0.12, 0.2, 0.85);
      sweep(bp.frequency, t, 1300, 520, 0.9);
      return 1.3;
    },
  },

  // ───────────────────────────────────────────── ambience one-shot events

  'amb/bird': {
    dur: 0.8, prio: 0.25, gain: 0.5, reverb: 0.3,
    build(v, t) {
      // Chirp: fast FM with an upward glide, 2-4 syllables.
      const n = 2 + Math.floor(this._r() * 3);
      const base = this._rr(2400, 4200);
      for (let i = 0; i < n; i++) {
        const tt = t + i * (0.055 + this._r() * 0.06);
        const o1 = this._osc(v, tt, 0.09, { type: 'sine', freq: base });
        const mo = this._osc(v, tt, 0.09, { type: 'sine', freq: base * 1.7 });
        const mg = this._gain(v, base * 1.2);
        const g = this._gain(v, 0.0001);
        mo.connect(mg); mg.connect(o1.frequency);
        o1.connect(g); g.connect(v.input);
        sweep(o1.frequency, tt, base * 0.86, base * (1.05 + this._r() * 0.2), 0.05);
        perc(g.gain, tt, 0.10, 0.004, 0.055);
      }
      return 0.7;
    },
  },

  'amb/pa': {
    dur: 1.6, prio: 0.25, gain: 0.4, reverb: 0.45, spatial: false,
    build(v, t) {
      // Supermarket PA: two-tone chime then a muffled "voice" babble.
      this._fm(v, t, { freq: noteHz(76), ratio: 2, index: 2, peak: 0.1, decay: 0.4, modDecay: 0.1 });
      this._fm(v, t + 0.22, { freq: noteHz(71), ratio: 2, index: 2, peak: 0.1, decay: 0.5, modDecay: 0.12 });
      const src = this._noise(v, 'pink', t + 0.6, 0.9);
      const bp = this._filter(v, 'bandpass', 1100, 2.4);
      const g = this._gain(v, 0.0001);
      chain(src, bp, g); g.connect(v.input);
      // Syllabic amplitude — reads as speech without being speech.
      let tt = t + 0.6;
      setParam(g.gain, 0.0001, tt);
      while (tt < t + 1.45) {
        const d = 0.06 + this._r() * 0.1;
        rampTo(g.gain, 0.05 + this._r() * 0.06, tt + d * 0.35);
        rampTo(g.gain, 0.008, tt + d);
        tt += d;
      }
      rampTo(g.gain, 0.0001, t + 1.5);
      return 1.55;
    },
  },

  'amb/footstep': {
    dur: 0.3, prio: 0.2, gain: 0.35, reverb: 0.5,
    build(v, t) {
      this._burst(v, t, { kind: 'thump', type: 'lowpass', freq: 400, Q: 1.0, peak: 0.2, attack: 0.002, decay: 0.07 });
      this._burst(v, t, { kind: 'tick', type: 'bandpass', freq: 2600, Q: 1.4, peak: 0.06, attack: 0.001, decay: 0.03 });
      return 0.25;
    },
  },

  'amb/clock': {
    dur: 0.2, prio: 0.2, gain: 0.3, reverb: 0.4,
    build(v, t) {
      this._resonators(v, t, { freqs: [2100, 3400], Q: 20, peak: 0.10, decay: 0.05, excite: 0.0015, kind: 'tick' });
      return 0.16;
    },
  },

  'amb/rattle': {
    dur: 0.6, prio: 0.2, gain: 0.35, reverb: 0.4,
    build(v, t) {
      const n = 3 + Math.floor(this._r() * 4);
      for (let i = 0; i < n; i++) {
        this._resonators(v, t + this._r() * 0.35, {
          freqs: [this._rr(700, 2400)], Q: 13, peak: 0.06, decay: 0.05, excite: 0.002, kind: 'tick',
        });
      }
      return 0.5;
    },
  },

  'amb/gust': {
    dur: 3.2, prio: 0.25, gain: 0.5, reverb: 0.25, spatial: false,
    build(v, t) {
      const src = this._noise(v, 'pink', t, 3.1);
      const lp = this._filter(v, 'lowpass', 600, 1.0);
      const hp = this._filter(v, 'highpass', 160, 0.7);
      const g = this._gain(v, 0.0001);
      chain(src, hp, lp, g); g.connect(v.input);
      asr(g.gain, t, 0.20, 0.9, 0.5, 1.6);
      sweep(lp.frequency, t, 420, 1500, 1.4);
      sweep(lp.frequency, t + 1.4, 1500, 380, 1.6);
      return 3.1;
    },
  },

  generic: {
    dur: 0.25, prio: 0.3, gain: 0.6,
    build(v, t) {
      this._fm(v, t, { freq: 660, ratio: 2, index: 2, peak: 0.12, decay: 0.16, modDecay: 0.05 });
      return 0.22;
    },
  },
};

/* ══════════════════════════════════════════════════════════════ loops ══ */

export const LOOPS = {

  /**
   * Sustained body/wall scrape. Params: `intensity` (0..1), `freq`.
   * Driven by AudioSystem from the collision event stream.
   */
  scrape: {
    prio: 0.6, gain: 1.0, reverb: 0.2,
    build(v, t, o) {
      const src = this._noise(v, 'grit', t, 1e6, 0.9 + this._r() * 0.25);
      const bp = this._filter(v, 'bandpass', 1500, 2.6);
      const pk = this._filter(v, 'peaking', 3000, 2.0, 6);
      const g = this._gain(v, 0.0001);
      chain(src, bp, pk, g); g.connect(v.input);
      setParam(g.gain, 0.0001, t);
      rampTo(g.gain, clamp01(fin(o.intensity, 0.4)) * 0.3, t + 0.05);
      v.userData.params = { level: g.gain, freq: bp.frequency, Q: bp.Q, ring: pk.gain };
      return 0;
    },
  },

  /** Nitro / turbo jet. Params: `level`, `freq`. */
  'weapon/turbo': {
    prio: 0.75, gain: 1.0, reverb: 0.16,
    build(v, t, o) {
      const src = this._noise(v, 'white', t, 1e6);
      const bp = this._filter(v, 'bandpass', 900, 1.3);
      const hp = this._filter(v, 'highpass', 260, 0.7);
      const g = this._gain(v, 0.0001);
      chain(src, hp, bp, g); g.connect(v.input);
      // A whistle on top makes it read as thrust, not as wind.
      const w = this._osc(v, t, 1e6, { type: 'sine', freq: 2400 });
      const wg = this._gain(v, 0.02);
      const wlfo = this._osc(v, t, 1e6, { type: 'sine', freq: 5.5 });
      const wld = this._gain(v, 60);
      wlfo.connect(wld); wld.connect(w.frequency);
      w.connect(wg); wg.connect(v.input);
      setParam(g.gain, 0.0001, t);
      rampTo(g.gain, clamp01(fin(o.level, 1)) * 0.26, t + 0.08);
      v.userData.params = { level: g.gain, freq: bp.frequency, whistle: wg.gain };
      return 0;
    },
  },

  /** Bomb fuse. Params: `rate` (ticks/second). */
  'bomb/tick': {
    prio: 0.7, gain: 0.9, reverb: 0.2,
    build(v, t, o) {
      const src = this._noise(v, 'tick', t, 1e6);
      const bp = this._filter(v, 'bandpass', 2400, 3.0);
      const gate = this._gain(v, 0.0001);
      const out = this._gain(v, 0.5);
      chain(src, bp, gate, out); out.connect(v.input);
      // A square LFO through a shaper makes a short gate pulse per cycle.
      const lfo = this._osc(v, t, 1e6, { wave: 'pulse12', type: 'square', freq: fin(o.rate, 2) });
      const ld = this._gain(v, 0.5);
      lfo.connect(ld); ld.connect(gate.gain);
      setParam(gate.gain, -0.30, t);           // bias so only the pulse peaks open it
      v.userData.params = { rate: lfo.frequency, level: out.gain, bias: gate.gain };
      return 0;
    },
  },

  /** Weapon pickup roulette. Params: `rate`, `pitch`. */
  'pickup/roll': {
    prio: 0.8, gain: 0.9, reverb: 0.12, spatial: false,
    build(v, t, o) {
      const o1 = this._osc(v, t, 1e6, { wave: 'pulse25', type: 'square', freq: fin(o.pitch, 880) });
      const bp = this._filter(v, 'bandpass', 1600, 2.0);
      const gate = this._gain(v, 0.0001);
      const out = this._gain(v, 0.16);
      chain(o1, bp, gate, out); out.connect(v.input);
      const lfo = this._osc(v, t, 1e6, { wave: 'pulse12', type: 'square', freq: fin(o.rate, 11) });
      const ld = this._gain(v, 0.6);
      lfo.connect(ld); ld.connect(gate.gain);
      setParam(gate.gain, -0.36, t);
      v.userData.params = { rate: lfo.frequency, pitch: o1.frequency, level: out.gain };
      return 0;
    },
  },

  /** Electro "held" buzz (while a car is stunned). Params: `level`. */
  'electro/hold': {
    prio: 0.7, gain: 0.9, reverb: 0.2,
    build(v, t, o) {
      const o1 = this._osc(v, t, 1e6, { wave: 'saw', type: 'sawtooth', freq: 78 });
      const sh = shaper(this.ctx, this.res.curves.fold, 'none'); v.attach(sh);
      const bp = this._filter(v, 'bandpass', 1800, 2.2);
      const g = this._gain(v, 0.0001);
      chain(o1, sh, bp, g); g.connect(v.input);
      const src = this._noise(v, 'crackle', t, 1e6);
      const chp = this._filter(v, 'highpass', 2600, 0.8);
      const cg = this._gain(v, 0.12);
      chain(src, chp, cg); cg.connect(v.input);
      setParam(g.gain, 0.0001, t);
      rampTo(g.gain, clamp01(fin(o.level, 1)) * 0.16, t + 0.05);
      v.userData.params = { level: g.gain, freq: bp.frequency, crackle: cg.gain };
      return 0;
    },
  },

  // ───────────────────────────────────────────────────── ambience beds

  /** Marble hall: deep room tone + HVAC + distant murmur. */
  'amb/museum': {
    prio: 0.95, gain: 1.0, reverb: 0.22, spatial: false,
    build(v, t) {
      const out = this._gain(v, 1);
      out.connect(v.input);
      // Room tone
      const b = this._noise(v, 'brown', t, 1e6, 0.85);
      const blp = this._filter(v, 'lowpass', 320, 0.8);
      const bg = this._gain(v, 0.055);
      chain(b, blp, bg); bg.connect(out);
      // HVAC hum: two beating sines
      for (const f of [57.5, 116.2]) {
        const o1 = this._osc(v, t, 1e6, { type: 'sine', freq: f });
        const og = this._gain(v, f < 100 ? 0.012 : 0.006);
        o1.connect(og); og.connect(out);
      }
      // Distant murmur: pink noise through slowly swept formants
      const p = this._noise(v, 'pink', t, 1e6);
      const f1 = this._filter(v, 'bandpass', 480, 1.6);
      const f2 = this._filter(v, 'bandpass', 1250, 2.2);
      const mg = this._gain(v, 0.020);
      p.connect(f1); p.connect(f2); f1.connect(mg); f2.connect(mg); mg.connect(out);
      const lfo = this._osc(v, t, 1e6, { type: 'sine', freq: 0.07 });
      const ld = this._gain(v, 140);
      lfo.connect(ld); ld.connect(f2.frequency);
      const lfo2 = this._osc(v, t, 1e6, { type: 'sine', freq: 0.031 });
      const ld2 = this._gain(v, 0.012);
      lfo2.connect(ld2); ld2.connect(mg.gain);
      v.userData.params = { level: out.gain, murmur: mg.gain, tone: bg.gain };
      return 0;
    },
  },

  /** Garden: wind through a slowly swept lowpass + leaf rustle. */
  'amb/garden': {
    prio: 0.95, gain: 1.0, reverb: 0.12, spatial: false,
    build(v, t) {
      const out = this._gain(v, 1);
      out.connect(v.input);
      const w = this._noise(v, 'pink', t, 1e6);
      const hp = this._filter(v, 'highpass', 150, 0.7);
      const lp = this._filter(v, 'lowpass', 700, 1.0);
      const wg = this._gain(v, 0.055);
      chain(w, hp, lp, wg); wg.connect(out);
      // Two LFOs at incommensurate rates → wind that never repeats.
      const l1 = this._osc(v, t, 1e6, { type: 'sine', freq: 0.043 });
      const d1 = this._gain(v, 380);
      l1.connect(d1); d1.connect(lp.frequency);
      const l2 = this._osc(v, t, 1e6, { type: 'sine', freq: 0.113 });
      const d2 = this._gain(v, 0.028);
      l2.connect(d2); d2.connect(wg.gain);
      // Leaves
      const lv = this._noise(v, 'white', t, 1e6, 1.1);
      const lbp = this._filter(v, 'bandpass', 4200, 0.8);
      const lg = this._gain(v, 0.016);
      chain(lv, lbp, lg); lg.connect(out);
      const l3 = this._osc(v, t, 1e6, { type: 'sine', freq: 0.19 });
      const d3 = this._gain(v, 0.012);
      l3.connect(d3); d3.connect(lg.gain);
      // Very low ground rumble (distant traffic)
      const br = this._noise(v, 'brown', t, 1e6, 0.7);
      const blp = this._filter(v, 'lowpass', 140, 0.8);
      const bg = this._gain(v, 0.030);
      chain(br, blp, bg); bg.connect(out);
      v.userData.params = { level: out.gain, wind: wg.gain, leaves: lg.gain };
      return 0;
    },
  },

  /** Supermarket: fridge hum, fluorescent buzz, trolley rumble. */
  'amb/supermarket': {
    prio: 0.95, gain: 1.0, reverb: 0.18, spatial: false,
    build(v, t) {
      const out = this._gain(v, 1);
      out.connect(v.input);
      // Compressor hum with beating partials
      for (const [f, g] of [[99.6, 0.016], [100.4, 0.013], [200.7, 0.008], [301.2, 0.004]]) {
        const o1 = this._osc(v, t, 1e6, { type: 'sine', freq: f });
        const og = this._gain(v, g);
        o1.connect(og); og.connect(out);
      }
      // Fluorescent buzz — thin, 120 Hz-ish with odd harmonics
      const fo = this._osc(v, t, 1e6, { wave: 'pulse12', type: 'square', freq: 120.3 });
      const fbp = this._filter(v, 'bandpass', 2400, 2.4);
      const fg = this._gain(v, 0.007);
      chain(fo, fbp, fg); fg.connect(out);
      // Air handling
      const w = this._noise(v, 'pink', t, 1e6);
      const wlp = this._filter(v, 'lowpass', 900, 0.8);
      const wg = this._gain(v, 0.040);
      chain(w, wlp, wg); wg.connect(out);
      const l1 = this._osc(v, t, 1e6, { type: 'sine', freq: 0.061 });
      const d1 = this._gain(v, 0.010);
      l1.connect(d1); d1.connect(wg.gain);
      // Distant trolley rumble
      const br = this._noise(v, 'brown', t, 1e6, 0.9);
      const blp = this._filter(v, 'lowpass', 210, 0.9);
      const bg = this._gain(v, 0.026);
      chain(br, blp, bg); bg.connect(out);
      v.userData.params = { level: out.gain, hum: fg.gain, air: wg.gain };
      return 0;
    },
  },

  /** Small room / toy box: near-silence with a soft tone. */
  'amb/room': {
    prio: 0.95, gain: 1.0, reverb: 0.14, spatial: false,
    build(v, t) {
      const out = this._gain(v, 1);
      out.connect(v.input);
      const b = this._noise(v, 'brown', t, 1e6, 0.8);
      const lp = this._filter(v, 'lowpass', 260, 0.8);
      const g = this._gain(v, 0.038);
      chain(b, lp, g); g.connect(out);
      const o1 = this._osc(v, t, 1e6, { type: 'sine', freq: 62.4 });
      const og = this._gain(v, 0.007);
      o1.connect(og); og.connect(out);
      v.userData.params = { level: out.gain, tone: g.gain };
      return 0;
    },
  },

  /** Fallback bed. */
  'amb/default': {
    prio: 0.95, gain: 1.0, reverb: 0.12, spatial: false,
    build(v, t) {
      const out = this._gain(v, 1);
      out.connect(v.input);
      const b = this._noise(v, 'brown', t, 1e6, 0.85);
      const lp = this._filter(v, 'lowpass', 300, 0.8);
      const g = this._gain(v, 0.035);
      chain(b, lp, g); g.connect(out);
      v.userData.params = { level: out.gain, tone: g.gain };
      return 0;
    },
  },
};

/** Ambience id → { bed, events:[{name, chance, spread}] } */
export const AMBIENCE = {
  museum: {
    bed: 'amb/museum',
    reverb: 'museum',
    events: [
      { name: 'amb/footstep', per: 7.0, spread: 14 },
      { name: 'crowd/gasp', per: 26.0, spread: 0, volume: 0.35 },
      { name: 'amb/rattle', per: 18.0, spread: 10 },
      { name: 'amb/clock', per: 4.0, spread: 8, volume: 0.5 },
    ],
  },
  garden: {
    bed: 'amb/garden',
    reverb: 'garden',
    events: [
      { name: 'amb/bird', per: 5.5, spread: 18 },
      { name: 'amb/gust', per: 14.0, spread: 0 },
    ],
  },
  supermarket: {
    bed: 'amb/supermarket',
    reverb: 'supermarket',
    events: [
      { name: 'amb/pa', per: 34.0, spread: 0 },
      { name: 'amb/rattle', per: 12.0, spread: 12 },
      { name: 'amb/footstep', per: 9.0, spread: 12 },
    ],
  },
  room: {
    bed: 'amb/room',
    reverb: 'room',
    events: [
      { name: 'amb/clock', per: 2.0, spread: 4, volume: 0.45 },
      { name: 'amb/rattle', per: 22.0, spread: 6 },
    ],
  },
  default: { bed: 'amb/default', reverb: 'room', events: [] },
};

/**
 * Track / environment id → ambience key.
 * Tracks name their ambience freely (`'museum_hall'`, `'backyard_garden'`), and
 * sometimes all we have is `environment.skybox`, so this resolves exact names,
 * known aliases, the render system's skybox presets, and finally substrings.
 */
const AMB_ALIAS = {
  toy_museum: 'museum', museum: 'museum', museum_hall: 'museum', hall: 'museum',
  gallery: 'museum', indoor: 'museum',
  garden: 'garden', backyard: 'garden', lawn: 'garden', park: 'garden', outdoor: 'garden',
  supermarket: 'supermarket', store: 'supermarket', shop: 'supermarket', market: 'supermarket',
  toy_box: 'room', toybox: 'room', bedroom: 'room', room: 'room', small: 'room',
  // Sky.js / RenderSystem skybox presets.
  studio: 'room', day: 'garden', sunset: 'garden', overcast: 'garden', night: 'garden',
};

const AMB_FUZZY = [
  ['museum', 'museum'], ['gallery', 'museum'], ['hall', 'museum'], ['atrium', 'museum'],
  ['garden', 'garden'], ['lawn', 'garden'], ['yard', 'garden'], ['park', 'garden'],
  ['patio', 'garden'], ['outdoor', 'garden'], ['beach', 'garden'], ['pond', 'garden'],
  ['market', 'supermarket'], ['store', 'supermarket'], ['shop', 'supermarket'],
  ['aisle', 'supermarket'], ['mall', 'supermarket'], ['checkout', 'supermarket'],
  ['room', 'room'], ['box', 'room'], ['bed', 'room'], ['kitchen', 'room'],
  ['attic', 'room'], ['desk', 'room'], ['table', 'room'], ['toy', 'room'],
];

/** @param {string|{preset?:string,name?:string,id?:string}} id */
export function resolveAmbience(id) {
  if (!id) return 'default';
  let k = id;
  if (typeof k === 'object') k = k.preset ?? k.name ?? k.id ?? '';
  k = String(k).toLowerCase().trim();
  if (!k) return 'default';
  if (AMBIENCE[k]) return k;
  if (AMB_ALIAS[k]) return AMB_ALIAS[k];
  for (let i = 0; i < AMB_FUZZY.length; i++) if (k.includes(AMB_FUZZY[i][0])) return AMB_FUZZY[i][1];
  return 'default';
}

export default SFXSynth;
