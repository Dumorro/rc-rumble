/**
 * src/audio/MusicSystem.js — adaptive generative soundtrack.
 *
 * In the spirit of Re-Volt's upbeat electronic tracks: a driving 4-on-the-floor-ish
 * kit, a pumping bass, a 16th-note arpeggio through a dotted-eighth delay, warm
 * detuned pads and a reedy lead that only shows up when the race gets hot.
 *
 * Nothing is a loop of audio. There is a **lookahead step scheduler** (16th notes,
 * 0.25 s of lookahead, driven from `update(realDt)`) writing notes straight onto
 * `AudioContext.currentTime`, so:
 *   · it is sample-accurate regardless of frame rate or frame hitches,
 *   · there is no loop point at all — "seamless" is free,
 *   · it survives pause/slow-mo because it runs on real time, not sim time.
 *
 * Variation over three minutes comes from layered re-rolls, all from one seeded
 * RNG so a given seed always yields the same track:
 *   every 4 bars → new drum / bass / arp patterns
 *   every 8 bars → fill on the last bar, crash on the downbeat
 *   every 16 bars → new chord progression from the intent's pool
 *   every 32 bars → the progression may start on a different degree
 *
 * Intents ('menu' | 'race' | 'finalLap' | 'victory') pick the tempo, the chord
 * pool and the stem mix; `setIntensity(0..1)` (position battles, final lap) fades
 * stems in, thickens the kit and lifts the tempo a few bpm.
 */

import CONFIG from '../core/Config.js';
import { RNG, clamp, clamp01, lerp } from '../core/MathUtils.js';
import {
  fin, nyquistOf, noteHz, gain, filter, osc, delayNode, shaper,
  holdParam, setParam, rampTo, expTo, targetTo, perc, asr, sweep,
  loopSource, whiteFor, stopAt, chain, kill,
} from './DSP.js';

/* ─────────────────────────────────────────────────────────── music theory */

const CHORDS = {
  maj: [0, 4, 7], min: [0, 3, 7], maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
  sus4: [0, 5, 7], sus2: [0, 2, 7], dim: [0, 3, 6], maj6: [0, 4, 7, 9],
  min6: [0, 3, 7, 9], add9: [0, 4, 7, 14],
};

/** Progression pools. Entries are [semitones-above-tonic, quality]. */
const PROGS = {
  driving: [
    [[0, 'min'], [8, 'maj'], [3, 'maj'], [10, 'maj']],
    [[0, 'min'], [10, 'maj'], [8, 'maj'], [10, 'maj']],
    [[0, 'min'], [5, 'min'], [8, 'maj'], [7, 'min']],
    [[8, 'maj'], [10, 'maj'], [0, 'min'], [0, 'min']],
    [[0, 'min'], [3, 'maj'], [10, 'maj'], [5, 'min']],
    [[0, 'min7'], [5, 'min7'], [10, 'maj'], [8, 'maj']],
    [[0, 'min'], [7, 'min'], [8, 'maj'], [10, 'maj']],
  ],
  calm: [
    [[0, 'min7'], [8, 'maj7'], [5, 'min7'], [7, 'min7']],
    [[0, 'min'], [10, 'maj'], [5, 'min'], [7, 'min']],
    [[8, 'maj7'], [0, 'min7'], [3, 'maj'], [10, 'maj']],
    [[0, 'sus2'], [10, 'maj'], [8, 'maj'], [3, 'maj']],
  ],
  triumph: [
    [[0, 'maj'], [7, 'maj'], [9, 'min'], [5, 'maj']],
    [[0, 'maj'], [5, 'maj'], [7, 'maj'], [7, 'maj']],
    [[0, 'maj6'], [9, 'min7'], [5, 'maj'], [7, 'maj']],
    [[0, 'add9'], [5, 'maj'], [10, 'maj'], [7, 'maj']],
  ],
};

const PENT_MINOR = [0, 3, 5, 7, 10];
const PENT_MAJOR = [0, 2, 4, 7, 9];

/* ───────────────────────────────────────────────────────────── patterns */

const KICKS = [
  [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
  [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0],
  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0],
  [1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
];

const SNARES = [
  [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
  [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1],
];

/** -1 = rest, 0 = root, 1 = fifth, 2 = octave, 3 = minor seventh below */
const BASSES = [
  [0, -1, 0, -1, 0, -1, 0, -1, 0, -1, 0, -1, 0, -1, 2, -1],
  [0, -1, -1, 0, -1, -1, 0, -1, 2, -1, -1, 0, -1, 0, -1, -1],
  [0, 0, -1, 0, -1, 0, -1, 0, 1, -1, 0, -1, 0, -1, 2, 0],
  [0, -1, -1, -1, 0, -1, -1, -1, 0, -1, -1, -1, 0, -1, 3, -1],
  [0, -1, 2, -1, 0, -1, 1, -1, 0, -1, 2, -1, 1, -1, 0, -1],
  [0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, -1, 2, -1, 1, -1],
];

/** Indices into the extended chord-tone table; -1 = rest. */
const ARPS = [
  [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 4, 3],
  [0, 2, 4, 2, 1, 3, 5, 3, 0, 2, 4, 2, 1, 3, 5, 6],
  [0, -1, 2, 4, -1, 3, 1, -1, 0, -1, 2, 4, 5, -1, 3, 1],
  [4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1],
  [0, 4, 1, 5, 2, 6, 3, 5, 0, 4, 1, 5, 2, 4, 3, 2],
  [0, 0, 3, 0, 2, 0, 4, 0, 1, 1, 4, 1, 3, 1, 5, 2],
];

/** Lead motifs: scale-degree indices (into the pentatonic), -1 = rest. */
const LEADS = [
  [0, -1, 2, -1, 3, -1, -1, 2, 1, -1, -1, 0, -1, -1, -1, -1],
  [4, 3, -1, 2, -1, 3, 4, -1, -1, 2, 1, -1, 0, -1, -1, -1],
  [0, 2, 3, 4, -1, -1, 3, -1, 2, -1, 3, -1, -1, -1, -1, -1],
  [-1, -1, 2, 3, 4, -1, 5, -1, 4, 3, -1, 2, -1, -1, 0, -1],
];

/* ────────────────────────────────────────────────────────────── intents */

const INTENTS = {
  none: { bpm: 120, pool: 'calm', mix: { pad: 0, bass: 0, arp: 0, lead: 0, drum: 0, perc: 0 } },
  menu: {
    bpm: 104, pool: 'calm', swing: 0,
    mix: { pad: 1.0, bass: 0.55, arp: 0.60, lead: 0.0, drum: 0.30, perc: 0.10 },
    hatDensity: 0.35, kickIdx: 3,
  },
  race: {
    bpm: 128, pool: 'driving', swing: 0,
    mix: { pad: 0.58, bass: 0.95, arp: 0.85, lead: 0.30, drum: 1.0, perc: 0.55 },
    hatDensity: 0.72,
  },
  finalLap: {
    bpm: 137, pool: 'driving', swing: 0,
    mix: { pad: 0.50, bass: 1.0, arp: 0.95, lead: 0.85, drum: 1.12, perc: 0.9 },
    hatDensity: 0.9,
  },
  victory: {
    bpm: 132, pool: 'triumph', swing: 0,
    mix: { pad: 0.85, bass: 0.75, arp: 0.75, lead: 0.95, drum: 0.85, perc: 0.5 },
    hatDensity: 0.6,
  },
};

const LOOKAHEAD = 0.28;
const STEPS_PER_BAR = 16;

export class MusicSystem {
  /** @param {import('./AudioSystem.js').AudioSystem} audio */
  constructor(audio) {
    this.audio = audio;
    this.ctx = audio.ctx;
    this.res = audio.res;

    this.rng = new RNG((CONFIG.seed ?? 1) ^ 0x4d5531);
    this.ready = false;
    this.playing = false;
    this.intent = 'none';
    this.intensity = 0;
    this._intensitySmooth = 0;

    // Key: pick once per session so a seed always sounds the same.
    const roots = [45, 47, 48, 50, 52, 53, 55];      // A2..G3
    this.tonic = roots[Math.floor(this.rng.next() * roots.length)];

    this.bpm = 128;
    this.targetBpm = 128;
    this.step = 60 / this.bpm / 4;
    this.stepIndex = 0;
    this.nextStepTime = 0;

    this.prog = PROGS.driving[0];
    this.progRotate = 0;
    this.kick = KICKS[0];
    this.snare = SNARES[0];
    this.bass = BASSES[0];
    this.arp = ARPS[0];
    this.lead = LEADS[0];
    this.hatDensity = 0.7;
    this.pentatonic = PENT_MINOR;

    /** Cleanup slots (avoids a closure per note). */
    this._gcFree = [];
    this._gcBusy = [];

    this.layers = {};
    this._notes = 0;
    this.nyq = nyquistOf(audio.ctx);

    this._build();
  }

  // ────────────────────────────────────────────────────────────── graph

  _build() {
    const ctx = this.ctx;
    if (!ctx) return;
    const bus = this.audio.buses?.music;
    if (!bus) return;
    try {
      this.out = gain(ctx, 1);
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16;
      this.comp.knee.value = 22;
      this.comp.ratio.value = 3.2;
      this.comp.attack.value = 0.006;
      this.comp.release.value = 0.16;
      this.master = gain(ctx, 1);
      this.tone = filter(ctx, 'lowpass', Math.min(18000, this.nyq), 0.7);
      this.hp = filter(ctx, 'highpass', 32, 0.7);

      chain(this.master, this.hp, this.tone, this.comp, this.out);
      this.out.connect(bus);

      // Dotted-8th delay for arp/lead — the classic dance-music glue.
      this.delay = delayNode(ctx, 0.28, 1.2);
      this.delayFb = gain(ctx, 0.34);
      this.delayLP = filter(ctx, 'lowpass', 3200, 0.8);
      this.delaySend = gain(ctx, 0);
      if (this.delay) {
        this.delaySend.connect(this.delay);
        this.delay.connect(this.delayLP);
        this.delayLP.connect(this.delayFb);
        this.delayFb.connect(this.delay);
        this.delayLP.connect(this.master);
      }

      // Stem buses.
      for (const name of ['pad', 'bass', 'arp', 'lead', 'drum', 'perc']) {
        const g = gain(ctx, 0);
        g.connect(this.master);
        this.layers[name] = g;
      }
      // Arp + lead feed the delay.
      this.layers.arp.connect(this.delaySend);
      this.layers.lead.connect(this.delaySend);

      // Pad gets a slow filter sweep so the bed breathes.
      this.padLP = filter(ctx, 'lowpass', 1400, 0.9);
      this.padLP.connect(this.layers.pad);
      this.padLfo = osc(ctx, { type: 'sine', freq: 0.055 });
      this.padLfoG = gain(ctx, 520);
      if (this.padLfo) { this.padLfo.connect(this.padLfoG); this.padLfoG.connect(this.padLP.frequency); }

      // A touch of saturation glues the kit.
      this.drumSat = shaper(ctx, this.res?.curves?.soft, 'none');
      if (this.drumSat) {
        this.layers.drum.disconnect();
        this.layers.drum.connect(this.drumSat);
        this.drumSat.connect(this.master);
      }

      this.ready = true;
    } catch (err) {
      console.warn('[Music] setup failed:', err);
      this.ready = false;
    }
  }

  // ──────────────────────────────────────────────────────────── control

  /**
   * @param {'menu'|'race'|'finalLap'|'victory'|'none'} intent
   * @param {{fade?:number, restart?:boolean}} [o]
   */
  setIntent(intent, o = {}) {
    if (!this.ready) return;
    const key = INTENTS[intent] ? intent : 'none';
    const changed = key !== this.intent;
    this.intent = key;
    const I = INTENTS[key];

    if (key === 'none') {
      this.stop(fin(o.fade, 1.2));
      return;
    }

    this.hatDensity = I.hatDensity ?? 0.7;
    this.pentatonic = I.pool === 'triumph' ? PENT_MAJOR : PENT_MINOR;
    this.targetBpm = I.bpm;

    if (changed || o.restart) {
      this._rollProgression(true);
      this._rollPatterns();
      // Realign to the next bar so the transition lands musically. If we are not
      // playing yet, start immediately.
      if (!this.playing) {
        this.bpm = this.targetBpm;
        this.step = 60 / this.bpm / 4;
        this.stepIndex = 0;
        this.nextStepTime = this.ctx.currentTime + 0.08;
        this.playing = true;
      }
    }
    this._applyMix(fin(o.fade, changed ? 2.0 : 0.8));
  }

  /** 0..1 — race heat. Fades stems in, thickens the kit, lifts the tempo. */
  setIntensity(v) {
    this.intensity = clamp01(fin(v, 0));
  }

  /** Master level for the whole music submix (on top of CONFIG.audio.musicVolume). */
  setLevel(v, seconds = 0.5) {
    if (!this.out) return;
    const now = this.ctx.currentTime;
    holdParam(this.out.gain, now);
    rampTo(this.out.gain, clamp(fin(v, 1), 0, 2), now + Math.max(0.01, seconds));
  }

  /** Duck (e.g. during a cutscene or the results voice-over). */
  duck(amount = 0.4, seconds = 0.3) {
    this.setLevel(1 - clamp01(amount), seconds);
  }

  stop(fade = 1.0) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    for (const k in this.layers) {
      const g = this.layers[k];
      holdParam(g.gain, now);
      rampTo(g.gain, 0.0001, now + Math.max(0.05, fade));
    }
    if (this.delaySend) { holdParam(this.delaySend.gain, now); rampTo(this.delaySend.gain, 0, now + fade); }
    // Keep scheduling for the length of the fade so tails ring out naturally.
    this._stopAt = now + fade + 0.1;
  }

  _applyMix(fade = 1.5) {
    const I = INTENTS[this.intent];
    if (!I || !this.ready) return;
    const now = this.ctx.currentTime;
    const it = this._intensitySmooth;
    const f = Math.max(0.05, fade);
    const scale = {
      pad: 1 - 0.25 * it,
      bass: 0.8 + 0.25 * it,
      arp: 0.75 + 0.3 * it,
      lead: 0.25 + 0.9 * it,
      drum: 0.82 + 0.22 * it,
      perc: 0.25 + 0.85 * it,
    };
    const base = { pad: 0.32, bass: 0.34, arp: 0.24, lead: 0.20, drum: 0.40, perc: 0.16 };
    for (const k in this.layers) {
      const g = this.layers[k];
      const target = (I.mix[k] ?? 0) * (scale[k] ?? 1) * (base[k] ?? 0.25);
      holdParam(g.gain, now);
      rampTo(g.gain, Math.max(0.0001, target), now + f);
    }
    if (this.delaySend) {
      holdParam(this.delaySend.gain, now);
      rampTo(this.delaySend.gain, 0.16 + 0.20 * it, now + f);
    }
    if (this.delayFb) targetTo(this.delayFb.gain, 0.28 + 0.16 * it, now, f * 0.4);
    if (this.tone) targetTo(this.tone.frequency, Math.min(lerp(9000, 18000, 0.35 + 0.65 * it), this.nyq), now, f * 0.5);
    this._stopAt = 0;
  }

  // ─────────────────────────────────────────────────────────── scheduler

  /**
   * @param {number} dt REAL seconds (rawDt) — music must keep time while paused.
   */
  update(dt) {
    if (!this.ready) return;
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;

    const d = clamp(fin(dt, 0.016), 0, 0.25);
    // Intensity smoothing feeds both the mix and the tempo lift.
    const prev = this._intensitySmooth;
    this._intensitySmooth += (this.intensity - this._intensitySmooth) * (1 - Math.exp(-1.2 * d));
    if (Math.abs(this._intensitySmooth - prev) > 0.02) this._applyMix(2.4);

    this._sweepGC(ctx.currentTime);
    if (!this.playing) return;

    if (this._stopAt && ctx.currentTime > this._stopAt) {
      this.playing = false;
      return;
    }

    const now = ctx.currentTime;
    // Recover from a long suspension / tab switch.
    if (this.nextStepTime < now - 0.25) this.nextStepTime = now + 0.03;

    let guard = 0;
    while (this.nextStepTime < now + LOOKAHEAD && guard++ < 96) {
      this._scheduleStep(this.stepIndex, this.nextStepTime);
      this.nextStepTime += this.step;
      this.stepIndex++;
    }
  }

  _rollProgression(force = false) {
    const I = INTENTS[this.intent] ?? INTENTS.race;
    const pool = PROGS[I.pool] ?? PROGS.driving;
    const next = pool[Math.floor(this.rng.next() * pool.length)];
    if (!force && next === this.prog && pool.length > 1) {
      this.prog = pool[(pool.indexOf(next) + 1) % pool.length];
    } else {
      this.prog = next;
    }
  }

  _rollPatterns() {
    const I = INTENTS[this.intent] ?? INTENTS.race;
    const it = this._intensitySmooth;
    if (I.kickIdx != null && this.rng.next() < 0.6) this.kick = KICKS[I.kickIdx];
    else this.kick = KICKS[Math.floor(this.rng.next() * KICKS.length)];
    this.snare = SNARES[Math.floor(this.rng.next() * SNARES.length)];
    this.bass = BASSES[Math.floor(this.rng.next() * BASSES.length)];
    this.arp = ARPS[Math.floor(this.rng.next() * ARPS.length)];
    this.lead = LEADS[Math.floor(this.rng.next() * LEADS.length)];
    // Denser bass patterns as the race heats up.
    if (it > 0.6 && this.rng.next() < 0.5) this.bass = BASSES[Math.min(BASSES.length - 1, 4 + Math.floor(this.rng.next() * 2))];
  }

  /** Chord tones for a bar, as absolute MIDI numbers around `octave`. */
  _chordTones(barIndex, out) {
    const idx = (barIndex + this.progRotate) % this.prog.length;
    const [off, qual] = this.prog[idx];
    const iv = CHORDS[qual] || CHORDS.min;
    out.length = 0;
    for (let i = 0; i < iv.length; i++) out.push(this.tonic + off + iv[i]);
    return out;
  }

  _scheduleStep(step, t) {
    const bar = Math.floor(step / STEPS_PER_BAR);
    const s = step % STEPS_PER_BAR;
    const it = this._intensitySmooth;
    const I = INTENTS[this.intent] ?? INTENTS.race;

    // ── bar / phrase boundaries ──
    if (s === 0) {
      // Tempo (+ intensity lift) applied at bar lines only.
      const want = this.targetBpm + 5 * it;
      if (Math.abs(want - this.bpm) > 0.05) {
        this.bpm = lerp(this.bpm, want, 0.5);
        this.step = 60 / this.bpm / 4;
        if (this.delay) targetTo(this.delay.delayTime, (60 / this.bpm) * 0.75, t, 0.4);
      }
      if (bar % 4 === 0) this._rollPatterns();
      if (bar > 0 && bar % 16 === 0) this._rollProgression();
      if (bar > 0 && bar % 32 === 0) this.progRotate = (this.progRotate + (this.rng.next() < 0.5 ? 1 : 3)) % 4;
      this._pad(bar, t);
      if (bar % 8 === 0 && it > 0.35) this._crash(t, 0.5 + 0.5 * it);
    }

    const tones = _toneScratch;
    this._chordTones(bar, tones);

    // ── drums ──
    const fillBar = (bar % 8) === 7;
    if (this.kick[s]) this._kick(t, 0.9 + 0.1 * it);
    if (this.snare[s]) this._snare(t, 0.7 + 0.25 * it);
    // Hats: 8ths always, 16ths as intensity rises.
    const isEighth = s % 2 === 0;
    const hatChance = isEighth ? 0.98 : this.hatDensity * (0.35 + 0.65 * it);
    if (this.rng.next() < hatChance) {
      const open = (s % 8) === 4 && this.rng.next() < 0.5;
      this._hat(t, open ? 0.5 : 0.34 * (isEighth ? 1 : 0.7), open);
    }
    if (it > 0.45 && (s % 4) === 2 && this.rng.next() < 0.5 * it) this._shaker(t, 0.22 * it);
    if (it > 0.6 && this.rng.next() < 0.04 * it) this._clap(t, 0.3 * it);

    // Fill: tom run on the last beat of an 8-bar block.
    if (fillBar && s >= 12) {
      if (this.rng.next() < 0.75) this._tom(t, 300 - (s - 12) * 45, 0.5 + 0.3 * it);
      if (s === 15) this._snare(t + this.step * 0.5, 0.5);
    }

    // ── bass ──
    const bn = this.bass[s];
    if (bn >= 0) {
      const root = tones[0] - 24;
      const semis = bn === 0 ? 0 : bn === 1 ? 7 : bn === 2 ? 12 : -2;
      const accent = (s === 0 || this.kick[s]) ? 1 : 0.78;
      this._bass(t, root + semis, 0.85 * accent, this.step * (bn === 0 ? 1.7 : 1.1));
    }

    // ── arpeggio ──
    const ai = this.arp[s];
    if (ai >= 0) {
      const ext = _extScratch;
      _extendChord(tones, ext);
      const n = ext[ai % ext.length];
      this._arp(t, n + 12, 0.55 + 0.25 * it);
    }

    // ── lead ──
    if ((I.mix.lead ?? 0) > 0.05 && (it > 0.30 || this.intent === 'victory' || this.intent === 'finalLap')) {
      // Lead plays the second half of each 8-bar block, so it feels like a chorus.
      const inChorus = (bar % 8) >= 4;
      if (inChorus) {
        const li = this.lead[s];
        if (li >= 0) {
          const deg = this.pentatonic[li % this.pentatonic.length];
          const oct = 12 * Math.floor(li / this.pentatonic.length);
          this._lead(t, this.tonic + 24 + deg + oct, 0.6, this.step * 2.2);
        }
      }
    }

    this._notes++;
  }

  // ────────────────────────────────────────────────────── instruments

  /** Sustained pad chord for one bar. */
  _pad(bar, t) {
    const ctx = this.ctx;
    const tones = _padScratch;
    this._chordTones(bar, tones);
    const barLen = this.step * STEPS_PER_BAR;
    const g = gain(ctx, 0.0001);
    if (!g) return;
    g.connect(this.padLP || this.layers.pad);
    const nodes = [g];
    for (let i = 0; i < tones.length; i++) {
      const f = noteHz(tones[i] + 12);
      for (let k = 0; k < 2; k++) {
        const o = osc(ctx, {
          wave: this.res?.waves?.pad, type: 'sawtooth', freq: f,
          detune: (k === 0 ? -7 : 7) + (i - 1) * 2, when: t,
        });
        if (!o) continue;
        const og = gain(ctx, 0.20 / tones.length);
        o.connect(og); og.connect(g);
        stopAt(o, t + barLen + 1.0);
        nodes.push(o, og);
      }
    }
    // Long attack, long release — the bed should never poke.
    setParam(g.gain, 0.0001, t);
    rampTo(g.gain, 0.55, t + barLen * 0.35);
    setParam(g.gain, 0.55, t + barLen * 0.8);
    expTo(g.gain, 0.0006, t + barLen + 0.7);
    this._gc(t + barLen + 1.1, nodes);
  }

  _kick(t, vel = 1) {
    const ctx = this.ctx;
    const o = osc(ctx, { type: 'sine', freq: 140, when: t });
    const g = gain(ctx, 0.0001);
    if (!o || !g) return;
    o.connect(g); g.connect(this.layers.drum);
    sweep(o.frequency, t, 148, 44, 0.075);
    perc(g.gain, t, 0.95 * vel, 0.002, 0.26);
    stopAt(o, t + 0.35);
    // Click transient for definition on small speakers.
    const src = loopSource(ctx, this.res?.buffers?.tick, { when: t, rate: 1 });
    const cg = gain(ctx, 0.0001);
    const cf = filter(ctx, 'bandpass', 2400, 1.2);
    if (src && cg && cf) {
      chain(src, cf, cg); cg.connect(this.layers.drum);
      perc(cg.gain, t, 0.16 * vel, 0.0006, 0.014);
      stopAt(src, t + 0.06);
    }
    this._gc(t + 0.4, [o, g, src, cf, cg]);
  }

  _snare(t, vel = 1) {
    const ctx = this.ctx;
    const src = loopSource(ctx, whiteFor(this.res, 1), { when: t, rate: 1 });
    const bp = filter(ctx, 'bandpass', 1850, 0.9);
    const hp = filter(ctx, 'highpass', 400, 0.7);
    const g = gain(ctx, 0.0001);
    const nodes = [];
    if (src && bp && hp && g) {
      chain(src, hp, bp, g); g.connect(this.layers.drum);
      perc(g.gain, t, 0.55 * vel, 0.001, 0.115);
      stopAt(src, t + 0.2);
      nodes.push(src, bp, hp, g);
    }
    // Two tuned bodies = a real drum, not just noise.
    for (const [f, a] of [[186, 0.24], [331, 0.14]]) {
      const o = osc(ctx, { type: 'triangle', freq: f, when: t });
      const og = gain(ctx, 0.0001);
      if (!o || !og) continue;
      o.connect(og); og.connect(this.layers.drum);
      sweep(o.frequency, t, f, f * 0.86, 0.07);
      perc(og.gain, t, a * vel, 0.001, 0.075);
      stopAt(o, t + 0.15);
      nodes.push(o, og);
    }
    this._gc(t + 0.3, nodes);
  }

  _hat(t, vel = 0.35, open = false) {
    const ctx = this.ctx;
    const src = loopSource(ctx, this.res?.buffers?.tick, { when: t, rate: 1.0 });
    const hp = filter(ctx, 'highpass', open ? 6200 : 7600, 0.8);
    const bp = filter(ctx, 'bandpass', open ? 9000 : 11000, 0.9);
    const g = gain(ctx, 0.0001);
    if (!src || !hp || !bp || !g) return;
    chain(src, hp, bp, g); g.connect(this.layers.drum);
    const dec = open ? 0.19 : 0.032;
    perc(g.gain, t, vel, 0.0006, dec);
    stopAt(src, t + dec + 0.08);
    this._gc(t + dec + 0.15, [src, hp, bp, g]);
  }

  _clap(t, vel = 0.3) {
    const ctx = this.ctx;
    const nodes = [];
    for (let i = 0; i < 4; i++) {
      const tt = t + i * 0.009;
      const src = loopSource(ctx, whiteFor(this.res, 2), { when: tt, rate: 1 });
      const bp = filter(ctx, 'bandpass', 1500, 1.1);
      const g = gain(ctx, 0.0001);
      if (!src || !bp || !g) continue;
      chain(src, bp, g); g.connect(this.layers.perc);
      perc(g.gain, tt, vel * (i === 3 ? 1 : 0.6), 0.0008, i === 3 ? 0.11 : 0.014);
      stopAt(src, tt + 0.2);
      nodes.push(src, bp, g);
    }
    this._gc(t + 0.35, nodes);
  }

  _shaker(t, vel = 0.2) {
    const ctx = this.ctx;
    const src = loopSource(ctx, whiteFor(this.res, 0), { when: t, rate: 1 });
    const bp = filter(ctx, 'bandpass', 6400, 1.6);
    const g = gain(ctx, 0.0001);
    if (!src || !bp || !g) return;
    chain(src, bp, g); g.connect(this.layers.perc);
    perc(g.gain, t, vel, 0.004, 0.05);
    stopAt(src, t + 0.12);
    this._gc(t + 0.2, [src, bp, g]);
  }

  _tom(t, freq, vel = 0.5) {
    const ctx = this.ctx;
    const o = osc(ctx, { type: 'sine', freq, when: t });
    const g = gain(ctx, 0.0001);
    if (!o || !g) return;
    o.connect(g); g.connect(this.layers.perc);
    sweep(o.frequency, t, freq, freq * 0.6, 0.12);
    perc(g.gain, t, vel, 0.002, 0.14);
    stopAt(o, t + 0.25);
    this._gc(t + 0.3, [o, g]);
  }

  _crash(t, vel = 0.5) {
    const ctx = this.ctx;
    const src = loopSource(ctx, whiteFor(this.res, 1), { when: t, rate: 1 });
    const hp = filter(ctx, 'highpass', 3600, 0.7);
    const g = gain(ctx, 0.0001);
    if (!src || !hp || !g) return;
    chain(src, hp, g); g.connect(this.layers.perc);
    perc(g.gain, t, 0.28 * vel, 0.003, 1.15);
    stopAt(src, t + 1.4);
    this._gc(t + 1.5, [src, hp, g]);
  }

  _bass(t, midi, vel = 0.8, dur = 0.14) {
    const ctx = this.ctx;
    const f = noteHz(midi);
    const o = osc(ctx, { wave: this.res?.waves?.saw, type: 'sawtooth', freq: f, when: t });
    const o2 = osc(ctx, { type: 'sine', freq: f, when: t });
    const lp = filter(ctx, 'lowpass', 300, 4.2);
    const g = gain(ctx, 0.0001);
    if (!o || !lp || !g) return;
    o.connect(lp);
    if (o2) { const sg = gain(ctx, 0.6); o2.connect(sg); sg.connect(g); stopAt(o2, t + dur + 0.2); }
    lp.connect(g); g.connect(this.layers.bass);
    // Filter envelope = the "pluck".
    setParam(lp.frequency, 220, t);
    rampTo(lp.frequency, Math.min(1500 + 900 * this._intensitySmooth, this.nyq), t + 0.012);
    expTo(lp.frequency, 190, t + dur * 0.9);
    perc(g.gain, t, 0.55 * vel, 0.004, dur);
    stopAt(o, t + dur + 0.2);
    this._gc(t + dur + 0.35, [o, o2, lp, g]);
  }

  _arp(t, midi, vel = 0.6) {
    const ctx = this.ctx;
    const f = noteHz(midi);
    const o = osc(ctx, { wave: this.res?.waves?.pulse25, type: 'square', freq: f, when: t });
    const lp = filter(ctx, 'lowpass', 2600, 2.6);
    const g = gain(ctx, 0.0001);
    if (!o || !lp || !g) return;
    chain(o, lp, g); g.connect(this.layers.arp);
    const dur = Math.min(0.16, this.step * 1.4);
    setParam(lp.frequency, 1400, t);
    rampTo(lp.frequency, Math.min(4200 + 2000 * this._intensitySmooth, this.nyq), t + 0.008);
    expTo(lp.frequency, 1100, t + dur);
    perc(g.gain, t, 0.30 * vel, 0.003, dur);
    stopAt(o, t + dur + 0.15);
    this._gc(t + dur + 0.3, [o, lp, g]);
  }

  _lead(t, midi, vel = 0.6, dur = 0.25) {
    const ctx = this.ctx;
    const f = noteHz(midi);
    const o = osc(ctx, { wave: this.res?.waves?.lead, type: 'sawtooth', freq: f, when: t });
    const o2 = osc(ctx, { wave: this.res?.waves?.lead, type: 'sawtooth', freq: f, detune: 9, when: t });
    const lp = filter(ctx, 'lowpass', 3400, 2.0);
    const g = gain(ctx, 0.0001);
    if (!o || !lp || !g) return;
    o.connect(lp);
    if (o2) { o2.connect(lp); stopAt(o2, t + dur + 0.3); }
    chain(lp, g); g.connect(this.layers.lead);
    // Small pitch slide into the note — instantly more expressive.
    setParam(o.frequency, f * 0.985, t);
    rampTo(o.frequency, f, t + 0.03);
    asr(g.gain, t, 0.24 * vel, 0.012, dur * 0.55, dur * 0.7);
    sweep(lp.frequency, t, Math.min(2200, this.nyq), Math.min(5200, this.nyq), 0.06);
    stopAt(o, t + dur + 0.3);
    this._gc(t + dur + 0.5, [o, o2, lp, g]);
  }

  // ─────────────────────────────────────────────────────────────── GC

  _gc(at, nodes) {
    let slot = this._gcFree.pop();
    if (!slot) slot = { at: 0, nodes: [] };
    slot.at = at;
    slot.nodes.length = 0;
    for (let i = 0; i < nodes.length; i++) if (nodes[i]) slot.nodes.push(nodes[i]);
    this._gcBusy.push(slot);
  }

  _sweepGC(now) {
    for (let i = this._gcBusy.length - 1; i >= 0; i--) {
      const s = this._gcBusy[i];
      if (now < s.at) continue;
      for (let k = 0; k < s.nodes.length; k++) {
        try { s.nodes[k].disconnect(); } catch { /* ignore */ }
      }
      s.nodes.length = 0;
      this._gcBusy.splice(i, 1);
      if (this._gcFree.length < 256) this._gcFree.push(s);
    }
  }

  stats() {
    return {
      intent: this.intent, playing: this.playing,
      bpm: +this.bpm.toFixed(1), bar: Math.floor(this.stepIndex / 16),
      intensity: +this._intensitySmooth.toFixed(2),
      key: this.tonic, live: this._gcBusy.length, notes: this._notes,
    };
  }

  dispose() {
    this.playing = false;
    this._sweepGC(Infinity);
    for (const k in this.layers) kill(this.layers[k]);
    kill(this.padLfo); kill(this.padLfoG); kill(this.padLP);
    kill(this.delay); kill(this.delayFb); kill(this.delayLP); kill(this.delaySend);
    kill(this.drumSat); kill(this.master); kill(this.hp); kill(this.tone);
    try { this.comp?.disconnect(); } catch { /* ignore */ }
    kill(this.out);
    this.ready = false;
  }
}

/* Module scratch — the scheduler runs many times a second. */
const _toneScratch = [];
const _padScratch = [];
const _extScratch = [];

/** Extend a chord into a 7-entry arpeggio table spanning two octaves. */
function _extendChord(tones, out) {
  out.length = 0;
  const n = tones.length;
  out.push(tones[0]);
  out.push(tones[1 % n]);
  out.push(tones[2 % n]);
  out.push(tones[0] + 12);
  out.push(tones[1 % n] + 12);
  out.push(tones[2 % n] + 12);
  out.push(tones[0] + 24);
  return out;
}

export default MusicSystem;
