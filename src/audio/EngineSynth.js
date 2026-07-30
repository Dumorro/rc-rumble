/**
 * src/audio/EngineSynth.js — per-car RC motor / drivetrain synthesiser.
 *
 * The goal is a **high-revving electric toy**, not a V8. What sells that:
 *
 *   · A modest fundamental ("growl") with a *dominant* commutator whine one and
 *     two octaves above it. Real brushed 540-can motors scream; the low end is
 *     mostly gearbox and body resonance.
 *   · Frequency that tracks rpm over a wide range (≈ 6:1) with no gear ratios
 *     audible in the pitch — gears only produce a momentary dip + blip.
 *   · A resonant lowpass that *opens with throttle*, so lifting off instantly
 *     darkens the tone even though the pitch has barely moved. This is the single
 *     biggest cue that the player is on or off the power.
 *   · Load (engineLoad) drives level, saturation and the gearbox rattle. A car
 *     climbing a ramp sounds like it is working; the same rpm coasting does not.
 *   · An intake/air layer from bandpassed noise whose band rides rpm.
 *   · Off-throttle overrun crackle, a rev-limiter bounce (amplitude + pitch), and
 *     a short shift dip so the drivetrain feels mechanical.
 *
 * Cost control
 *   Eight of these run at once. Three detail tiers prune the node graph by
 *   *disconnecting* branches (an unconnected branch is not pulled by the audio
 *   graph, so it costs nothing), and the far tier is a single oscillator plus one
 *   filter. Wavetables and noise buffers are shared across all cars via
 *   `AudioSystem.res`; each car gets a small random DelayNode on the shared noise
 *   so eight cars do not comb-filter into one another.
 *
 * Robustness
 *   `update(dt, car)` accepts anything Car-shaped and works from `speed` alone if
 *   the vehicle model never fills in `rpm`. Nothing here throws.
 */

import CONFIG from '../core/Config.js';
import { RNG, clamp, clamp01, lerp, damp } from '../core/MathUtils.js';
import {
  fin, nyquistOf, gain, filter, osc, delayNode, shaper, loopSource, whiteFor,
  holdParam, setParam, rampTo, targetTo, expTo, kill, chain,
} from './DSP.js';

/** Per-class voicing. Faster classes scream higher and growl less. */
const CLASS_TUNE = {
  rookie:     { idleHz: 37, maxHz: 226, whine: 0.62, growl: 1.05, rattle: 1.15 },
  amateur:    { idleHz: 39, maxHz: 244, whine: 0.74, growl: 1.00, rattle: 1.05 },
  advanced:   { idleHz: 42, maxHz: 264, whine: 0.92, growl: 0.94, rattle: 0.95 },
  'semi-pro': { idleHz: 44, maxHz: 282, whine: 1.05, growl: 0.88, rattle: 0.88 },
  pro:        { idleHz: 46, maxHz: 300, whine: 1.20, growl: 0.82, rattle: 0.80 },
  super:      { idleHz: 49, maxHz: 326, whine: 1.42, growl: 0.74, rattle: 0.72 },
};

const DRIVE_TUNE = {
  '4wd': { harm: 1.15, rattle: 1.20 },
  rwd:   { harm: 1.00, rattle: 1.00 },
  fwd:   { harm: 0.92, rattle: 1.06 },
};

/** Detail tiers by distance to the listener (metres). */
export const TIER_NEAR = 9.0;
export const TIER_MID = 24.0;
export const TIER_CULL = 42.0;

export class EngineSynth {
  /**
   * @param {import('./AudioSystem.js').AudioSystem} audio
   * @param {object} car  a Car (ARCHITECTURE.md → Car). Only read, never written.
   * @param {number} index stable 0..7, used for noise decorrelation
   */
  constructor(audio, car, index = 0) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.res = audio.res;
    this.car = car;
    this.index = index | 0;
    this.carId = car?.id ?? index;
    this.isPlayer = !!car?.isPlayer;

    const def = car?.def ?? {};
    const cls = CLASS_TUNE[def.class] ?? CLASS_TUNE.advanced;
    const drv = DRIVE_TUNE[def.drive] ?? DRIVE_TUNE.rwd;
    const rng = new RNG((CONFIG.seed ?? 1) ^ (0x9e37 + this.carId * 7919));

    // Per-car voicing jitter so a pack of eight sounds like eight toys.
    const jitter = 1 + (rng.next() - 0.5) * 0.085;
    this.idleHz = cls.idleHz * jitter;
    this.maxHz = cls.maxHz * jitter;
    this.whineMix = cls.whine * (0.9 + rng.next() * 0.2);
    this.growlMix = cls.growl * (0.9 + rng.next() * 0.2);
    this.rattleMix = cls.rattle * drv.rattle * (0.85 + rng.next() * 0.3);
    this.harmMix = drv.harm * (0.9 + rng.next() * 0.2);
    this.baseDetune = (rng.next() - 0.5) * 26;               // cents
    this.whineRatio = 4 * (1 + (rng.next() - 0.5) * 0.03);
    this.harmRatio = 2 * (1 + (rng.next() - 0.5) * 0.02);
    this.nyq = nyquistOf(audio.ctx);
    this.noiseSlot = this.carId % 3;
    this.noiseDelay = 0.004 + rng.next() * 0.028;
    this._rng = rng;

    // rpm range: prefer the vehicle model's numbers when it publishes them.
    this.idleRpm = fin(def.idleRpm, 1100);
    this.maxRpm = Math.max(this.idleRpm + 500, fin(def.maxRpm ?? def.redline, 13500));
    this.gearCount = clamp(Math.round(fin(def.gears, 4)), 1, 8);
    this.topSpeed = Math.max(1.5, fin(def.topSpeed, 9));

    // ── live smoothed state ──
    this.rpmN = 0;
    this.load = 0;
    this.throttle = 0;
    this.brake = 0;
    this.gear = 1;
    this.f0 = this.idleHz;
    this.distance = 0;
    this.tier = 2;
    this.level = 0;
    this.limiting = 0;
    this._prevGear = 1;
    this._prevRpmN = 0;
    this._crackleTimer = 0;
    this._rattlePhase = rng.next() * 6.28;
    this._shiftCooldown = 0;
    this._airFlare = 0;
    this._started = false;
    this.alive = false;
    this.muted = false;

    /** @type {Array<{g:GainNode, on:boolean, off:number, tier:number}>} */
    this._layers = [];

    this._build();
  }

  // ───────────────────────────────────────────────────────────── graph

  _build() {
    const ctx = this.ctx, res = this.res;
    if (!ctx || !res) return;
    const bus = this.audio.buses?.engine;
    if (!bus) return;

    try {
      // ── output stage ──────────────────────────────────────────────────────
      this.out = gain(ctx, 0.0001);
      this.panner = ctx.createPanner();
      this.panner.panningModel = this.audio.panningModel;
      this.panner.distanceModel = 'inverse';
      this.panner.refDistance = Math.max(0.2, fin(CONFIG.audio.refDistance, 1.2));
      this.panner.maxDistance = Math.max(2, fin(CONFIG.audio.maxDistance, 45));
      this.panner.rolloffFactor = Math.max(0, fin(CONFIG.audio.rolloff, 1.4)) * 0.85;
      this.panner.coneInnerAngle = 360;
      this.panner.coneOuterAngle = 360;

      // ── tone shaping ──────────────────────────────────────────────────────
      this.formant = filter(ctx, 'peaking', 340, 1.1, 4.5);      // body resonance
      this.lpf = filter(ctx, 'lowpass', 900, 1.0);               // throttle-driven
      this.driveG = gain(ctx, 1);
      this.sat = shaper(ctx, this.isPlayer ? res.curves.tube : res.curves.soft,
        this.isPlayer ? '2x' : 'none');
      this.env = gain(ctx, 1);                                   // transient envelope
      this.mix = gain(ctx, 1);

      chain(this.mix, this.env, this.driveG, this.sat, this.lpf, this.formant, this.out);
      this.out.connect(this.panner);
      this.panner.connect(bus);

      // Reverb send — engines in a marble museum need it.
      if (this.audio.reverb?.input) {
        this.send = gain(ctx, 0.16);
        this.out.connect(this.send);
        this.send.connect(this.audio.reverb.input);
      }

      // ── rev-limiter bounce: shared LFO, per-car depth ─────────────────────
      this.limitAmp = gain(ctx, 0);
      this.limitPitch = gain(ctx, 0);
      const lfo = this.audio.limiterLfo;
      if (lfo) {
        lfo.connect(this.limitAmp);
        lfo.connect(this.limitPitch);
        this.limitAmp.connect(this.env.gain);
      }

      // ── oscillator stack ──────────────────────────────────────────────────
      const w = res.waves;
      this.oscBody = osc(ctx, { wave: w.motor, type: 'sawtooth', freq: this.idleHz, detune: this.baseDetune });
      this.bodyG = gain(ctx, 0.0001);
      this.oscBody?.connect(this.bodyG); this.bodyG.connect(this.mix);

      this.oscHarm = osc(ctx, { wave: w.pulse25, type: 'square', freq: this.idleHz * this.harmRatio, detune: this.baseDetune + 7 });
      this.harmG = gain(ctx, 0.0001);
      this.oscHarm?.connect(this.harmG);
      this._layer(this.harmG, 1);

      this.oscWhine = osc(ctx, { wave: w.whine, type: 'sawtooth', freq: this.idleHz * this.whineRatio, detune: this.baseDetune - 11 });
      this.whineG = gain(ctx, 0.0001);
      this.oscWhine?.connect(this.whineG);
      this._layer(this.whineG, 2);

      this.oscSub = osc(ctx, { wave: w.triangle, type: 'triangle', freq: this.idleHz * 0.5, detune: this.baseDetune });
      this.subG = gain(ctx, 0.0001);
      this.oscSub?.connect(this.subG);
      this._layer(this.subG, 2);

      if (this.limitPitch) {
        if (this.oscBody) this.limitPitch.connect(this.oscBody.detune);
        if (this.oscHarm) this.limitPitch.connect(this.oscHarm.detune);
        if (this.oscWhine) this.limitPitch.connect(this.oscWhine.detune);
      }

      // ── intake / air layer (shared noise) ─────────────────────────────────
      const white = whiteFor(res, this.noiseSlot);
      this.noiseSrc = loopSource(ctx, white, { rate: 1, detune: this.index * 13 });
      this.nDelay = delayNode(ctx, this.noiseDelay, 0.06);
      this.intakeBP = filter(ctx, 'bandpass', 900, 1.4);
      this.intakeG = gain(ctx, 0.0001);
      if (this.noiseSrc) {
        chain(this.noiseSrc, this.nDelay, this.intakeBP, this.intakeG);
        this._layer(this.intakeG, 1);
      }

      // ── gearbox / exhaust rattle (shared grit buffer) ─────────────────────
      this.gritSrc = loopSource(ctx, res.buffers.grit, { rate: 0.85 + this._rng.next() * 0.3 });
      this.rattleLP = filter(ctx, 'lowpass', 1400, 1.6);
      this.rattleG = gain(ctx, 0.0001);
      if (this.gritSrc) {
        chain(this.gritSrc, this.rattleLP, this.rattleG);
        this._layer(this.rattleG, 2);
      }

      // ── overrun crackle ───────────────────────────────────────────────────
      this.crackSrc = loopSource(ctx, res.buffers.crackle, { rate: 0.9 + this._rng.next() * 0.35 });
      this.crackBP = filter(ctx, 'bandpass', 1750, 2.2);
      this.crackG = gain(ctx, 0.0001);
      if (this.crackSrc) {
        chain(this.crackSrc, this.crackBP, this.crackG);
        this._layer(this.crackG, 2);
      }

      this.alive = true;
      this._started = true;
    } catch (err) {
      console.warn('[EngineSynth] build failed:', err);
      this.dispose();
    }
  }

  /** Register a prunable layer. `tier` = minimum detail tier it belongs to. */
  _layer(g, tier) {
    if (!g) return;
    try { g.connect(this.mix); } catch { /* ignore */ }
    this._layers.push({ g, on: true, off: 0, tier });
  }

  // ───────────────────────────────────────────────────────────── detail

  /** 0 = far (single osc), 1 = mid, 2 = full. */
  setTier(tier) {
    tier = clamp(tier | 0, 0, 2);
    if (tier === this.tier) return;
    this.tier = tier;
    const now = this.ctx.currentTime;
    for (let i = 0; i < this._layers.length; i++) {
      const L = this._layers[i];
      const want = L.tier <= tier;
      if (want === L.on) continue;
      if (want) {
        L.on = true; L.off = 0;
        try { L.g.connect(this.mix); } catch { /* ignore */ }
      } else {
        L.on = false;
        L.off = now + 0.18;
        holdParam(L.g.gain, now);
        rampTo(L.g.gain, 0.0001, now + 0.15);
      }
    }
    // The far tier gets a darker filter so it blends into the mix.
    if (this.sat) {
      try { this.sat.oversample = (tier === 2 && this.isPlayer) ? '2x' : 'none'; } catch { /* ignore */ }
    }
  }

  _pruneLayers(now) {
    for (let i = 0; i < this._layers.length; i++) {
      const L = this._layers[i];
      if (!L.on && L.off > 0 && now >= L.off) {
        L.off = 0;
        try { L.g.disconnect(this.mix); } catch { /* ignore */ }
      }
    }
  }

  // ───────────────────────────────────────────────────────────── update

  /**
   * @param {number} dt seconds (real or sim — both fine, it is all smoothing)
   * @param {object} [car] override the car object (defaults to the one bound at construction)
   */
  update(dt, car = null) {
    if (!this.alive || !this.ctx) return;
    const c = car || this.car;
    if (!c) return;
    const now = this.ctx.currentTime;
    const d = clamp(fin(dt, 0.016), 0.0001, 0.1);

    // ── position / velocity ───────────────────────────────────────────────
    const p = c.group?.position ?? c.body?.position ?? null;
    const v = c.body?.velocity ?? null;
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

    // ── detail tiering ────────────────────────────────────────────────────
    if (this.isPlayer) this.setTier(2);
    else if (this.distance < TIER_NEAR) this.setTier(2);
    else if (this.distance < TIER_MID) this.setTier(1);
    else this.setTier(0);
    this._pruneLayers(now);

    const audible = !this.muted && this.distance < TIER_CULL;

    // ── resolve rpm ───────────────────────────────────────────────────────
    const speed = Math.abs(fin(c.speed, 0));
    let throttle = clamp01(fin(c.throttle, 0));
    const brake = clamp01(fin(c.brake, 0));
    const gear = clamp(Math.round(fin(c.gear, 1)), 1, this.gearCount);
    const airborne = !!c.airborne || fin(c.wheelsOnGround, 4) === 0;
    const boost = clamp01(fin(c.effects?.boost, 0));

    let rpm = fin(c.rpm, 0);
    if (!(rpm > this.idleRpm * 0.2)) rpm = this._pseudoRpm(speed, gear, throttle, airborne);
    let rpmN = clamp01((rpm - this.idleRpm) / (this.maxRpm - this.idleRpm));

    // Free-revving in the air: the wheels unload, so the motor flares.
    const flareTarget = airborne && throttle > 0.15 ? 0.30 * throttle : 0;
    this._airFlare = damp(this._airFlare, flareTarget, 3.5, d);
    rpmN = clamp01(rpmN + this._airFlare + boost * 0.06);

    // Smooth (the vehicle model runs at 120 Hz; audio wants continuity).
    this.rpmN = damp(this.rpmN, rpmN, 22, d);
    this.throttle = damp(this.throttle, throttle, 16, d);
    this.brake = damp(this.brake, brake, 12, d);

    let load = fin(c.engineLoad, -1);
    if (load < 0) {
      // Derive: full throttle at low rpm = maximum load.
      load = clamp01(throttle * (0.42 + 0.58 * (1 - this.rpmN)) + (airborne ? 0 : 0.12 * throttle));
    }
    this.load = damp(this.load, clamp01(load), 9, d);

    // ── frequency ─────────────────────────────────────────────────────────
    // Exponential (musical) rpm→Hz with a slightly compressed top end.
    const curve = Math.pow(this.rpmN, 0.90);
    // Slow-mo pitches the whole motor down — a cheap, very satisfying effect.
    const f0 = this.idleHz * Math.pow(this.maxHz / this.idleHz, curve)
      * clamp(fin(this.audio.pitchScale, 1), 0.35, 1.6);
    this.f0 = f0;

    const dopplerCents = this.audio.dopplerCents(px, py, pz,
      v ? fin(v.x) : 0, v ? fin(v.y) : 0, v ? fin(v.z) : 0);
    const det = this.baseDetune + dopplerCents;

    // Fast glide: the motor must feel connected to the throttle, so the pitch
    // tracks with ~12 ms of smoothing only.
    const tau = 0.012;
    if (this.oscBody) {
      targetTo(this.oscBody.frequency, f0, now, tau);
      targetTo(this.oscBody.detune, det, now, 0.03);
    }
    if (this.tier >= 1 && this.oscHarm) {
      targetTo(this.oscHarm.frequency, f0 * this.harmRatio, now, tau);
      targetTo(this.oscHarm.detune, det + 7, now, 0.03);
    }
    if (this.tier >= 2) {
      if (this.oscWhine) {
        targetTo(this.oscWhine.frequency, f0 * this.whineRatio, now, tau);
        targetTo(this.oscWhine.detune, det - 11, now, 0.03);
      }
      if (this.oscSub) targetTo(this.oscSub.frequency, f0 * 0.5, now, tau);
    }

    // ── layer levels ──────────────────────────────────────────────────────
    const rev = this.rpmN;
    const th = this.throttle;
    const ld = this.load;

    // Body: always there, swells with load, thins at the very top.
    const bodyLvl = this.growlMix * (0.16 + 0.52 * ld + 0.20 * rev) * (1 - 0.18 * rev);
    // Octave-up gearbox/motor honk: mostly throttle.
    const harmLvl = this.harmMix * (0.05 + 0.40 * th + 0.28 * rev * ld);
    // The scream: strongly rpm dependent, present even off throttle (coast whine).
    const whineLvl = this.whineMix * (0.02 + 0.30 * Math.pow(rev, 1.5) + 0.20 * rev * th);
    // Sub: weight under acceleration only, gone at high rpm.
    const subLvl = 0.30 * ld * (1 - rev) * (1 - rev) + 0.05;
    // Intake: air being sucked past the chassis; rises with rpm & throttle.
    const intakeLvl = 0.055 + 0.15 * rev * (0.35 + 0.65 * th);
    // Rattle: only under load, and much louder on rough going.
    const rattleBase = this.rattleMix * (0.03 + 0.16 * ld * (0.4 + 0.6 * (1 - rev)));

    const tauL = 0.035;
    if (this.bodyG) targetTo(this.bodyG.gain, bodyLvl, now, tauL);
    if (this.tier >= 1) {
      if (this.harmG) targetTo(this.harmG.gain, harmLvl, now, tauL);
      if (this.intakeG) targetTo(this.intakeG.gain, intakeLvl, now, tauL);
      if (this.intakeBP) {
        targetTo(this.intakeBP.frequency, Math.min(lerp(420, 3400, rev), this.nyq), now, 0.05);
        targetTo(this.intakeBP.Q, lerp(0.9, 2.4, th), now, 0.08);
      }
    }
    if (this.tier >= 2) {
      if (this.whineG) targetTo(this.whineG.gain, whineLvl, now, tauL);
      if (this.subG) targetTo(this.subG.gain, subLvl, now, tauL);
      // Irregular mechanical rattle: a random walk at frame rate reads as metal
      // parts knocking, which a periodic LFO never does.
      this._rattlePhase += d * (6 + 26 * rev);
      const wobble = 0.55 + 0.45 * Math.sin(this._rattlePhase * 2.7)
        * (0.4 + 0.6 * this._rng.next());
      if (this.rattleG) targetTo(this.rattleG.gain, rattleBase * wobble, now, 0.02);
      if (this.rattleLP) targetTo(this.rattleLP.frequency, Math.min(lerp(700, 2600, rev), this.nyq), now, 0.08);
    }

    // ── resonant lowpass driven by throttle (the big "on power" cue) ───────
    const openness = 0.30 * rev + 0.70 * th;
    const cut = clamp(lerp(560, 6200, openness) * (0.62 + 0.38 * ld), 260, Math.min(9000, this.nyq));
    // Distance also darkens the tone (air absorption).
    const distDark = 1 / (1 + this.distance * 0.055);
    targetTo(this.lpf.frequency, cut * lerp(0.55, 1, distDark), now, 0.03);
    targetTo(this.lpf.Q, lerp(0.85, 4.6, th) * (this.tier === 0 ? 0.5 : 1), now, 0.06);
    targetTo(this.formant.frequency, lerp(230, 520, rev), now, 0.06);
    targetTo(this.formant.gain, 2.5 + 4.0 * ld, now, 0.06);

    // Saturation rises with load — the motor "straining" sound.
    if (this.driveG) targetTo(this.driveG.gain, lerp(0.75, 2.15, ld * (0.4 + 0.6 * th)), now, 0.05);

    // ── gear shift dip + blip ─────────────────────────────────────────────
    this._shiftCooldown = Math.max(0, this._shiftCooldown - d);
    if (gear !== this._prevGear && this._shiftCooldown <= 0 && this.rpmN > 0.1) {
      const up = gear > this._prevGear;
      this._shift(now, up);
      this._shiftCooldown = 0.12;
    }
    this._prevGear = gear;
    this.gear = gear;

    // ── overrun crackle ───────────────────────────────────────────────────
    if (this.tier >= 2 && this.crackG) {
      const decel = this._prevRpmN - this.rpmN;
      const overrun = (th < 0.07 && this.rpmN > 0.30 && decel > 0.0005 && !airborne)
        ? clamp01(this.rpmN * 1.1) : 0;
      this._crackleTimer -= d;
      if (overrun > 0.05 && this._crackleTimer <= 0) {
        const amp = 0.05 + 0.16 * overrun * this._rng.next();
        holdParam(this.crackG.gain, now);
        setParam(this.crackG.gain, amp, now);
        expTo(this.crackG.gain, 0.0002, now + 0.03 + this._rng.next() * 0.05);
        this._crackleTimer = 0.025 + this._rng.next() * 0.09 * (1.4 - overrun);
        targetTo(this.crackBP.frequency, Math.min(1100 + this._rng.next() * 2200, this.nyq), now, 0.005);
      } else if (overrun <= 0.05) {
        targetTo(this.crackG.gain, 0.0001, now, 0.03);
      }
    }

    // ── rev limiter ───────────────────────────────────────────────────────
    const limitingTarget = (this.rpmN > 0.975 && th > 0.5) ? 1 : 0;
    this.limiting = damp(this.limiting, limitingTarget, 14, d);
    if (this.limitAmp) targetTo(this.limitAmp.gain, 0.30 * this.limiting, now, 0.02);
    if (this.limitPitch) targetTo(this.limitPitch.gain, 34 * this.limiting, now, 0.02);
    // Pull the base level down while limiting so the bounce reads as a cut.
    const limCut = 1 - 0.18 * this.limiting;

    // ── overall level ─────────────────────────────────────────────────────
    // Idle is quiet; the motor should come alive with revs, not just exist.
    const activity = 0.22 + 0.78 * clamp01(0.35 * rev + 0.75 * th + 0.35 * ld);
    const tierScale = this.tier === 0 ? 0.72 : this.tier === 1 ? 0.9 : 1;
    const playerBias = this.isPlayer ? 1.18 : 1.0;
    const target = audible ? activity * tierScale * playerBias * limCut * 0.55 : 0.0001;
    this.level = target;
    targetTo(this.out.gain, target, now, 0.05);

    if (this.send) {
      const revAmt = 0.10 + 0.14 * clamp01(this.distance / 18);
      targetTo(this.send.gain, audible ? revAmt : 0, now, 0.2);
    }

    this._prevRpmN = this.rpmN;
  }

  /** Momentary drivetrain interruption + a pitch blip. */
  _shift(now, up) {
    if (!this.env) return;
    const g = this.env.gain;
    holdParam(g, now);
    if (up) {
      // Cut, then come back with a small overshoot: "clack-brrap".
      rampTo(g, 0.34, now + 0.022);
      setParam(g, 0.34, now + 0.048);
      rampTo(g, 1.07, now + 0.10);
      rampTo(g, 1.0, now + 0.17);
    } else {
      // Downshift: a throttle blip.
      rampTo(g, 1.16, now + 0.03);
      rampTo(g, 0.88, now + 0.07);
      rampTo(g, 1.0, now + 0.14);
    }
    // Mechanical clack from the shared rattle band.
    if (this.rattleG && this.tier >= 1) {
      const rg = this.rattleG.gain;
      holdParam(rg, now);
      setParam(rg, 0.20, now + 0.004);
      expTo(rg, 0.004, now + 0.075);
    }
    // A brief pitch dip on the way up (the motor unloads then re-catches).
    if (up && this.oscBody) {
      const f = this.oscBody.frequency;
      const cur = fin(f.value, this.f0);
      holdParam(f, now);
      rampTo(f, cur * 0.90, now + 0.05);
      rampTo(f, cur, now + 0.14);
    }
  }

  /** Fallback rpm when the vehicle model does not publish one. */
  _pseudoRpm(speed, gear, throttle, airborne) {
    const n = this.gearCount;
    const g = clamp(gear, 1, n);
    const sn = clamp01(speed / this.topSpeed);
    const lo = (g - 1) / n, hi = g / n;
    const inGear = clamp01((sn - lo) / Math.max(0.0001, hi - lo));
    let rpm = lerp(this.idleRpm + 0.22 * (this.maxRpm - this.idleRpm), this.maxRpm * 0.97, inGear);
    // Standing still with the throttle down = wheelspin scream.
    if (sn < 0.03) rpm = lerp(this.idleRpm, this.maxRpm * 0.85, throttle);
    if (airborne) rpm = Math.max(rpm, lerp(rpm, this.maxRpm * 0.92, throttle));
    return rpm;
  }

  /** Mute without tearing down (used while paused / in menus). */
  setMuted(m) {
    this.muted = !!m;
    if (!this.out || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.muted) { holdParam(this.out.gain, now); rampTo(this.out.gain, 0.0001, now + 0.08); }
  }

  stop(fade = 0.2) {
    if (!this.out || !this.ctx) return;
    const now = this.ctx.currentTime;
    holdParam(this.out.gain, now);
    rampTo(this.out.gain, 0.0001, now + Math.max(0.02, fade));
  }

  stats() {
    return {
      id: this.carId, tier: this.tier,
      f0: +this.f0.toFixed(1), rpmN: +this.rpmN.toFixed(2),
      load: +this.load.toFixed(2), level: +this.level.toFixed(3),
      dist: +this.distance.toFixed(1),
    };
  }

  dispose() {
    this.alive = false;
    const nodes = [
      this.oscBody, this.oscHarm, this.oscWhine, this.oscSub,
      this.bodyG, this.harmG, this.whineG, this.subG,
      this.noiseSrc, this.nDelay, this.intakeBP, this.intakeG,
      this.gritSrc, this.rattleLP, this.rattleG,
      this.crackSrc, this.crackBP, this.crackG,
      this.limitAmp, this.limitPitch,
      this.mix, this.env, this.driveG, this.sat, this.lpf, this.formant,
      this.out, this.panner, this.send,
    ];
    for (const n of nodes) kill(n);
    this._layers.length = 0;
  }
}

export default EngineSynth;
