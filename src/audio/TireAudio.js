/**
 * src/audio/TireAudio.js — per-car tire, rolling and surface noise.
 *
 * Four parallel bands off the shared noise buffer, all morphing by surface id:
 *
 *   squeal  high-Q bandpass. Centre frequency and level track slip and load.
 *           Tile/glass/metal shriek high and thin; rubber mats squeal fat and low;
 *           dirt/grass/gravel barely squeal at all. A slow warble on the centre
 *           frequency is what makes it read as rubber rather than as a sine.
 *   roll    lowpass + resonant peak. This is the *bed*: brightness rides speed and
 *           the surface's roughness, so a car crossing from carpet onto tile
 *           audibly changes texture without any one-shot.
 *   grit    low bandpass. The gravel/dirt rumble — amplitude-modulated by a
 *           per-car random walk so it rattles instead of hissing.
 *   hiss    high bandpass. Grass swish, sand drag and the water spray layer.
 *
 * Plus a wind layer for the player car only (speed², heavily lowpassed) which is
 * a big part of why fast feels fast.
 *
 * All four bands are driven from ONE shared noise buffer source (owned by
 * AudioSystem) through a per-car DelayNode, so eight cars stay decorrelated for
 * the cost of one buffer source.
 */

import CONFIG from '../core/Config.js';
import { RNG, clamp, clamp01, lerp, damp, smoothstep } from '../core/MathUtils.js';
import {
  fin, nyquistOf, gain, filter, delayNode, loopSource, whiteFor, pinkFor,
  holdParam, rampTo, targetTo, kill, chain,
} from './DSP.js';

/**
 * @typedef {object} SurfaceVoice
 * @property {number} sqF   squeal centre Hz
 * @property {number} sqQ   squeal resonance
 * @property {number} sqG   squeal level
 * @property {number} rlF0  rolling cutoff at rest
 * @property {number} rlF1  rolling cutoff at top speed
 * @property {number} rlG   rolling level
 * @property {number} rlQ   rolling resonance (metal/glass ring)
 * @property {number} grF   grit band Hz
 * @property {number} grG   grit level
 * @property {number} hsF   hiss band Hz
 * @property {number} hsG   hiss level
 * @property {number} rough 0 = polished, 1 = loose stones
 */

/** Canonical surface ids — see ARCHITECTURE.md. Index = surface id. */
export const SURFACE_VOICES = [
  /* 0  default  */ { sqF: 1350, sqQ: 7.0, sqG: 0.85, rlF0: 300, rlF1: 3400, rlG: 0.80, rlQ: 0.9, grF: 260, grG: 0.24, hsF: 3200, hsG: 0.20, rough: 0.40 },
  /* 1  wood     */ { sqF: 1520, sqQ: 9.0, sqG: 1.00, rlF0: 320, rlF1: 3800, rlG: 0.82, rlQ: 1.4, grF: 300, grG: 0.16, hsF: 3400, hsG: 0.16, rough: 0.26 },
  /* 2  carpet   */ { sqF: 900, sqQ: 4.0, sqG: 0.12, rlF0: 180, rlF1: 1500, rlG: 0.92, rlQ: 0.7, grF: 220, grG: 0.20, hsF: 2400, hsG: 0.46, rough: 0.52 },
  /* 3  tile     */ { sqF: 2150, sqQ: 12.5, sqG: 1.28, rlF0: 380, rlF1: 4600, rlG: 0.72, rlQ: 1.8, grF: 340, grG: 0.10, hsF: 4200, hsG: 0.14, rough: 0.12 },
  /* 4  concrete */ { sqF: 1180, sqQ: 6.0, sqG: 0.78, rlF0: 280, rlF1: 3200, rlG: 0.95, rlQ: 0.8, grF: 240, grG: 0.40, hsF: 3000, hsG: 0.24, rough: 0.48 },
  /* 5  grass    */ { sqF: 1000, sqQ: 3.0, sqG: 0.08, rlF0: 200, rlF1: 1800, rlG: 0.68, rlQ: 0.6, grF: 210, grG: 0.22, hsF: 4400, hsG: 1.00, rough: 0.62 },
  /* 6  dirt     */ { sqF: 1050, sqQ: 3.5, sqG: 0.14, rlF0: 210, rlF1: 2100, rlG: 0.90, rlQ: 0.7, grF: 250, grG: 0.90, hsF: 2700, hsG: 0.52, rough: 0.76 },
  /* 7  gravel   */ { sqF: 980, sqQ: 3.0, sqG: 0.08, rlF0: 190, rlF1: 2300, rlG: 0.86, rlQ: 0.7, grF: 165, grG: 1.45, hsF: 3100, hsG: 0.62, rough: 1.00 },
  /* 8  sand     */ { sqF: 950, sqQ: 3.0, sqG: 0.05, rlF0: 170, rlF1: 1600, rlG: 0.80, rlQ: 0.6, grF: 195, grG: 0.50, hsF: 2250, hsG: 0.94, rough: 0.82 },
  /* 9  water    */ { sqF: 1400, sqQ: 3.5, sqG: 0.05, rlF0: 240, rlF1: 2400, rlG: 0.66, rlQ: 0.7, grF: 300, grG: 0.20, hsF: 5200, hsG: 1.45, rough: 0.56 },
  /* 10 ice      */ { sqF: 2650, sqQ: 14.0, sqG: 0.52, rlF0: 420, rlF1: 5200, rlG: 0.44, rlQ: 2.1, grF: 380, grG: 0.08, hsF: 5000, hsG: 0.20, rough: 0.08 },
  /* 11 metal    */ { sqF: 2820, sqQ: 16.0, sqG: 1.15, rlF0: 420, rlF1: 5400, rlG: 0.78, rlQ: 3.0, grF: 360, grG: 0.18, hsF: 4600, hsG: 0.22, rough: 0.20 },
  /* 12 plastic  */ { sqF: 1780, sqQ: 10.0, sqG: 1.00, rlF0: 340, rlF1: 4000, rlG: 0.76, rlQ: 1.5, grF: 300, grG: 0.13, hsF: 3600, hsG: 0.18, rough: 0.18 },
  /* 13 rubber   */ { sqF: 880, sqQ: 7.0, sqG: 1.30, rlF0: 220, rlF1: 2200, rlG: 0.88, rlQ: 0.9, grF: 240, grG: 0.16, hsF: 2600, hsG: 0.22, rough: 0.32 },
  /* 14 glass    */ { sqF: 3200, sqQ: 18.0, sqG: 1.08, rlF0: 460, rlF1: 5600, rlG: 0.66, rlQ: 2.6, grF: 400, grG: 0.07, hsF: 5200, hsG: 0.16, rough: 0.06 },
  /* 15 oil      */ { sqF: 700, sqQ: 4.0, sqG: 0.34, rlF0: 240, rlF1: 2600, rlG: 0.58, rlQ: 0.8, grF: 260, grG: 0.10, hsF: 3400, hsG: 0.34, rough: 0.16 },
];

export function surfaceVoice(id) {
  const i = (id | 0);
  return SURFACE_VOICES[i >= 0 && i < SURFACE_VOICES.length ? i : 0];
}

/** Distance tiers. */
const TIER_FULL = 10.0;
const TIER_MID = 22.0;
const TIER_CULL = 40.0;

export class TireAudio {
  /**
   * @param {import('./AudioSystem.js').AudioSystem} audio
   * @param {object} car
   * @param {number} index
   */
  constructor(audio, car, index = 0) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.res = audio.res;
    this.car = car;
    this.index = index | 0;
    this.carId = car?.id ?? index;
    this.isPlayer = !!car?.isPlayer;
    this.topSpeed = Math.max(2, fin(car?.def?.topSpeed, 9));

    this.nyq = nyquistOf(audio.ctx);
    const rng = new RNG((CONFIG.seed ?? 1) ^ (0x71ee + this.carId * 6151));
    this._rng = rng;
    this.noiseSlot = (this.carId + 1) % 3;
    this.delaySec = 0.003 + rng.next() * 0.03;
    this.warblePhase = rng.next() * 6.283;
    this.warbleRate = 5.5 + rng.next() * 4.0;
    this.gritPhase = rng.next() * 6.283;

    // Smoothed surface parameter set (crossfades when the surface changes).
    this.cur = { ...SURFACE_VOICES[0] };
    this.surfaceId = 0;

    this.slip = 0;
    this.speedN = 0;
    this.grounded = 0;
    this.distance = 0;
    this.tier = 2;
    this.muted = false;
    this.alive = false;
    this.squealLevel = 0;

    this._layers = [];
    this._build();
  }

  _build() {
    const ctx = this.ctx, res = this.res;
    if (!ctx || !res) return;
    const bus = this.audio.buses?.sfx;
    if (!bus) return;

    try {
      this.out = gain(ctx, 0.0001);
      this.panner = ctx.createPanner();
      this.panner.panningModel = this.audio.panningModel;
      this.panner.distanceModel = 'inverse';
      this.panner.refDistance = Math.max(0.2, fin(CONFIG.audio.refDistance, 1.2));
      this.panner.maxDistance = Math.max(2, fin(CONFIG.audio.maxDistance, 45));
      this.panner.rolloffFactor = Math.max(0, fin(CONFIG.audio.rolloff, 1.4));
      this.panner.coneInnerAngle = 360;
      this.panner.coneOuterAngle = 360;

      this.mix = gain(ctx, 1);
      // A gentle top-end tame so the noise bed never gets fizzy.
      this.tame = filter(ctx, 'lowpass', Math.min(9000, this.nyq), 0.7);
      chain(this.mix, this.tame, this.out);
      this.out.connect(this.panner);
      this.panner.connect(bus);

      if (this.audio.reverb?.input) {
        this.send = gain(ctx, 0.10);
        this.out.connect(this.send);
        this.send.connect(this.audio.reverb.input);
      }

      // shared noise → per-car delay (decorrelation)
      this.noiseSrc = loopSource(ctx, whiteFor(res, this.noiseSlot), { rate: 1 });
      this.nDelay = delayNode(ctx, this.delaySec, 0.06);
      if (this.noiseSrc && this.nDelay) this.noiseSrc.connect(this.nDelay);
      const src = this.nDelay || this.noiseSrc;

      // squeal
      this.sqBP = filter(ctx, 'bandpass', 1500, 8);
      this.sqBP2 = filter(ctx, 'peaking', 3000, 3, 6);
      this.sqG = gain(ctx, 0.0001);
      if (src) { chain(src, this.sqBP, this.sqBP2, this.sqG); this._layer(this.sqG, 0); }

      // rolling bed
      this.rlLP = filter(ctx, 'lowpass', 1200, 0.9);
      this.rlPeak = filter(ctx, 'peaking', 520, 1.2, 3);
      this.rlG = gain(ctx, 0.0001);
      if (src) { chain(src, this.rlLP, this.rlPeak, this.rlG); this._layer(this.rlG, 0); }

      // grit / rumble (pink noise reads heavier than white here)
      this.gritSrc = loopSource(ctx, pinkFor(res, this.carId % 2), { rate: 1 });
      this.grBP = filter(ctx, 'bandpass', 220, 1.1);
      this.grG = gain(ctx, 0.0001);
      if (this.gritSrc) { chain(this.gritSrc, this.grBP, this.grG); this._layer(this.grG, 2); }

      // hiss / spray
      this.hsBP = filter(ctx, 'bandpass', 4000, 0.7);
      this.hsG = gain(ctx, 0.0001);
      if (src) { chain(src, this.hsBP, this.hsG); this._layer(this.hsG, 2); }

      // wind — player only (the chase cam is the ear, so only the player earns it)
      if (this.isPlayer && src) {
        this.wdLP = filter(ctx, 'lowpass', 700, 0.8);
        this.wdHP = filter(ctx, 'highpass', 130, 0.7);
        this.wdG = gain(ctx, 0.0001);
        chain(src, this.wdHP, this.wdLP, this.wdG);
        this._layer(this.wdG, 2);
      }

      this.alive = true;
    } catch (err) {
      console.warn('[TireAudio] build failed:', err);
      this.dispose();
    }
  }

  _layer(g, tier) {
    if (!g) return;
    try { g.connect(this.mix); } catch { /* ignore */ }
    this._layers.push({ g, on: true, off: 0, tier });
  }

  setTier(tier) {
    tier = clamp(tier | 0, 0, 2);
    if (tier === this.tier) return;
    this.tier = tier;
    const now = this.ctx.currentTime;
    for (let i = 0; i < this._layers.length; i++) {
      const L = this._layers[i];
      const want = L.tier <= tier;
      if (want === L.on) continue;
      if (want) { L.on = true; L.off = 0; try { L.g.connect(this.mix); } catch { /* ignore */ } }
      else {
        L.on = false; L.off = now + 0.2;
        holdParam(L.g.gain, now); rampTo(L.g.gain, 0.0001, now + 0.16);
      }
    }
  }

  _prune(now) {
    for (let i = 0; i < this._layers.length; i++) {
      const L = this._layers[i];
      if (!L.on && L.off > 0 && now >= L.off) {
        L.off = 0;
        try { L.g.disconnect(this.mix); } catch { /* ignore */ }
      }
    }
  }

  /**
   * @param {number} dt
   * @param {object} [car]
   */
  update(dt, car = null) {
    if (!this.alive) return;
    const c = car || this.car;
    if (!c) return;
    const now = this.ctx.currentTime;
    const d = clamp(fin(dt, 0.016), 0.0001, 0.1);

    // ── position ──────────────────────────────────────────────────────────
    const p = c.group?.position ?? c.body?.position ?? null;
    const px = p ? fin(p.x) : 0, py = p ? fin(p.y) : 0, pz = p ? fin(p.z) : 0;
    if (this.panner) {
      if (this.panner.positionX) {
        targetTo(this.panner.positionX, px, now, 0.012);
        targetTo(this.panner.positionY, py, now, 0.012);
        targetTo(this.panner.positionZ, pz, now, 0.012);
      } else if (this.panner.setPosition) {
        try { this.panner.setPosition(px, py, pz); } catch { /* ignore */ }
      }
    }
    const L = this.audio.listener;
    const dx = px - (L?.x ?? 0), dy = py - (L?.y ?? 0), dz = pz - (L?.z ?? 0);
    this.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (this.isPlayer) this.setTier(2);
    else if (this.distance < TIER_FULL) this.setTier(2);
    else if (this.distance < TIER_MID) this.setTier(1);
    else this.setTier(0);
    this._prune(now);

    const audible = !this.muted && this.distance < TIER_CULL;
    if (!audible) {
      targetTo(this.out.gain, 0.0001, now, 0.12);
      return;
    }

    // ── read car state ────────────────────────────────────────────────────
    const speed = Math.abs(fin(c.speed, 0));
    const wheels = Array.isArray(c.wheels) ? c.wheels : null;
    let onGround = fin(c.wheelsOnGround, -1);
    let skid = 0;
    let sid = (fin(c.dominantSurfaceId, 0) | 0);
    let loadSum = 0;

    if (wheels && wheels.length) {
      let contacts = 0, bestLoad = -1;
      for (let i = 0; i < wheels.length; i++) {
        const w = wheels[i];
        if (!w) continue;
        if (w.contact) {
          contacts++;
          const ld = Math.max(0, fin(w.load, 0));
          loadSum += ld;
          if (ld > bestLoad) { bestLoad = ld; sid = (fin(w.surfaceId, sid) | 0); }
        }
        const s = fin(w.skidIntensity, -1);
        if (s >= 0) skid = Math.max(skid, clamp01(s));
        else {
          const sr = Math.abs(fin(w.slipRatio, 0));
          const sa = Math.abs(fin(w.slipAngle, 0));
          skid = Math.max(skid, clamp01(sr * 1.6), clamp01(sa / 0.42));
        }
      }
      if (onGround < 0) onGround = contacts;
    }
    if (onGround < 0) onGround = 4;

    // Fall back to chassis-level telemetry when wheels are not populated yet.
    if (skid <= 0.001) {
      const drift = clamp01(fin(c.driftFactor, 0));
      const sa = Math.abs(fin(c.slipAngle, 0));
      skid = Math.max(drift, clamp01(sa / 0.45));
    }
    skid = Math.max(skid, clamp01(fin(c.handbrake, 0)) * clamp01(speed / 2.2) * 0.85);

    this.grounded = damp(this.grounded, clamp01(onGround / 4), 12, d);
    this.speedN = damp(this.speedN, clamp01(speed / this.topSpeed), 10, d);
    // Squeal needs speed: a stationary spinning wheel chirps, it does not sing.
    const speedGate = smoothstep((speed - 0.45) / 1.9);
    this.slip = damp(this.slip, clamp01(skid) * speedGate * this.grounded, 13, d);

    // ── surface crossfade ─────────────────────────────────────────────────
    this.surfaceId = sid;
    const t = surfaceVoice(sid);
    const cur = this.cur;
    const r = 7.5;      // ≈ 0.13 s crossfade — fast enough to read the seam
    cur.sqF = damp(cur.sqF, t.sqF, r, d);
    cur.sqQ = damp(cur.sqQ, t.sqQ, r, d);
    cur.sqG = damp(cur.sqG, t.sqG, r, d);
    cur.rlF0 = damp(cur.rlF0, t.rlF0, r, d);
    cur.rlF1 = damp(cur.rlF1, t.rlF1, r, d);
    cur.rlG = damp(cur.rlG, t.rlG, r, d);
    cur.rlQ = damp(cur.rlQ, t.rlQ, r, d);
    cur.grF = damp(cur.grF, t.grF, r, d);
    cur.grG = damp(cur.grG, t.grG, r, d);
    cur.hsF = damp(cur.hsF, t.hsF, r, d);
    cur.hsG = damp(cur.hsG, t.hsG, r, d);
    cur.rough = damp(cur.rough, t.rough, r, d);

    // ── doppler (applied to band centres, since the noise buffer is shared) ─
    const v = c.body?.velocity ?? null;
    const dop = this.audio.dopplerRatio(px, py, pz,
      v ? fin(v.x) : 0, v ? fin(v.y) : 0, v ? fin(v.z) : 0);

    // ── squeal ────────────────────────────────────────────────────────────
    this.warblePhase += d * this.warbleRate * (0.6 + 0.8 * this.slip);
    const warble = 1 + 0.075 * Math.sin(this.warblePhase) + 0.035 * Math.sin(this.warblePhase * 2.31);
    const loadBoost = wheels && loadSum > 0 ? clamp(0.65 + loadSum / (16 * 4), 0.65, 1.5) : 1;
    const sqAmount = Math.pow(this.slip, 1.25);
    this.squealLevel = sqAmount * cur.sqG;
    if (this.sqBP) {
      const f = cur.sqF * (0.82 + 0.36 * this.slip) * (0.92 + 0.16 * this.speedN) * warble * dop;
      targetTo(this.sqBP.frequency, clamp(f, 120, Math.min(9000, this.nyq)), now, 0.02);
      targetTo(this.sqBP.Q, cur.sqQ * (0.7 + 0.5 * this.slip), now, 0.05);
      targetTo(this.sqBP2.frequency, clamp(f * 2.02, 200, this.nyq), now, 0.03);
      targetTo(this.sqBP2.gain, 3 + 5 * this.slip, now, 0.05);
      targetTo(this.sqG.gain, this.squealLevel * loadBoost * 0.42, now, 0.03);
    }

    // ── rolling bed ───────────────────────────────────────────────────────
    if (this.rlLP) {
      const bright = lerp(cur.rlF0, cur.rlF1, Math.pow(this.speedN, 0.75));
      targetTo(this.rlLP.frequency, clamp(bright * dop, 90, this.nyq), now, 0.04);
      targetTo(this.rlLP.Q, cur.rlQ, now, 0.08);
      targetTo(this.rlPeak.frequency, clamp(bright * 0.55, 90, Math.min(9000, this.nyq)), now, 0.06);
      targetTo(this.rlPeak.gain, 2 + 5 * cur.rough, now, 0.08);
      const rollLvl = cur.rlG * Math.pow(this.speedN, 0.68) * this.grounded
        * (0.55 + 0.45 * cur.rough) * 0.30;
      targetTo(this.rlG.gain, rollLvl, now, 0.04);
    }

    // ── grit (loose surfaces) ─────────────────────────────────────────────
    if (this.tier >= 2 && this.grG) {
      this.gritPhase += d * (9 + 34 * this.speedN);
      const rattle = 0.55 + 0.45 * Math.sin(this.gritPhase * 1.7) * (0.35 + 0.65 * this._rng.next());
      const lvl = cur.grG * Math.pow(this.speedN, 0.6) * this.grounded * rattle * 0.26
        * (1 + 0.5 * this.slip);
      targetTo(this.grG.gain, lvl, now, 0.02);
      targetTo(this.grBP.frequency, clamp(cur.grF * (0.85 + 0.4 * this.speedN), 60, Math.min(2000, this.nyq)), now, 0.06);
      targetTo(this.grBP.Q, 1.1 + 1.2 * cur.rough, now, 0.08);
    }

    // ── hiss / spray ──────────────────────────────────────────────────────
    if (this.tier >= 2 && this.hsG) {
      const water = this.surfaceId === 9 ? 1 : 0;
      const lvl = cur.hsG * (0.22 + 0.78 * Math.pow(this.speedN, 0.85)) * this.grounded
        * (1 + 0.9 * this.slip * (1 - water)) * 0.20;
      targetTo(this.hsG.gain, lvl, now, 0.04);
      targetTo(this.hsBP.frequency, clamp(cur.hsF * (0.8 + 0.35 * this.speedN) * dop, 400, this.nyq), now, 0.05);
      targetTo(this.hsBP.Q, water ? 0.45 : 0.8, now, 0.08);
    }

    // ── wind (player) ─────────────────────────────────────────────────────
    if (this.wdG) {
      const s2 = this.speedN * this.speedN;
      targetTo(this.wdG.gain, s2 * 0.24, now, 0.06);
      targetTo(this.wdLP.frequency, clamp(lerp(380, 1500, this.speedN), 200, Math.min(4000, this.nyq)), now, 0.08);
    }

    // ── overall ───────────────────────────────────────────────────────────
    const activity = clamp01(0.12 + 0.9 * this.speedN + 0.7 * this.slip) * this.grounded;
    const near = this.isPlayer ? 1.0 : 0.85;
    targetTo(this.out.gain, clamp01(activity) * near * 0.9, now, 0.05);
    targetTo(this.tame.frequency, clamp(Math.min(9000, this.nyq) / (1 + this.distance * 0.08), 1200, this.nyq), now, 0.15);
    if (this.send) targetTo(this.send.gain, 0.07 + 0.08 * clamp01(this.distance / 20), now, 0.2);
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.muted && this.out && this.ctx) {
      const now = this.ctx.currentTime;
      holdParam(this.out.gain, now);
      rampTo(this.out.gain, 0.0001, now + 0.08);
    }
  }

  stop(fade = 0.15) {
    if (!this.out || !this.ctx) return;
    const now = this.ctx.currentTime;
    holdParam(this.out.gain, now);
    rampTo(this.out.gain, 0.0001, now + Math.max(0.02, fade));
  }

  stats() {
    return {
      id: this.carId, tier: this.tier, surface: this.surfaceId,
      slip: +this.slip.toFixed(2), speedN: +this.speedN.toFixed(2),
      dist: +this.distance.toFixed(1),
    };
  }

  dispose() {
    this.alive = false;
    const nodes = [
      this.noiseSrc, this.nDelay, this.gritSrc,
      this.sqBP, this.sqBP2, this.sqG,
      this.rlLP, this.rlPeak, this.rlG,
      this.grBP, this.grG, this.hsBP, this.hsG,
      this.wdHP, this.wdLP, this.wdG,
      this.mix, this.tame, this.out, this.panner, this.send,
    ];
    for (const n of nodes) kill(n);
    this._layers.length = 0;
  }
}

export default TireAudio;
