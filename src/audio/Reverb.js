/**
 * src/audio/Reverb.js — procedurally rendered convolution reverb.
 *
 * Impulse responses are synthesised, never loaded:
 *   1. a pre-delay gap,
 *   2. a cluster of discrete early reflections (different per channel, with
 *      polarity flips so the room reads as *wide* rather than as a chorus),
 *   3. an exponentially decaying noise tail whose HF content is progressively
 *      damped by a one-pole filter with a sweeping coefficient (air + soft
 *      furnishings absorb treble faster than bass — this is what separates a
 *      "hall" from a "hiss"),
 *   4. optional room modes (decaying sinusoids) for boxy spaces, and a flutter
 *      tap train for corridors/aisles,
 *   5. a highpass to keep the low end tight, then RMS normalisation so every
 *      preset sits at the same send level.
 *
 * Two ConvolverNodes are kept alive so switching tracks crossfades instead of
 * clicking. Everything is guarded: a failed render leaves the previous IR in
 * place and the send simply keeps working.
 */

import CONFIG from '../core/Config.js';
import { RNG, clamp, clamp01, lerp } from '../core/MathUtils.js';
import {
  fin, applyBiquad, onePoleSweep, normalize, rms, toBuffer,
  holdParam, rampTo, gain, filter, kill,
} from './DSP.js';

/**
 * @typedef {object} ReverbDesc
 * @property {number} rt60        decay to −60 dB, seconds
 * @property {number} preDelay    seconds of silence before the first reflection
 * @property {number} damping     0 = bright/marble, 1 = dead/carpeted
 * @property {number} diffusion   0 = discrete slap-back, 1 = smooth wash
 * @property {number} erGain      early-reflection level relative to the tail
 * @property {number} erCount     number of discrete taps
 * @property {number} erSpread    seconds the tap cluster occupies
 * @property {number} width       stereo decorrelation, 0 = mono, 1 = fully wide
 * @property {number} lowCut      Hz
 * @property {number} highCut     Hz
 * @property {number} modes       amplitude of room modes (boxiness)
 * @property {number[]} modeHz    room mode frequencies
 * @property {number} flutter     amplitude of a periodic tap train
 * @property {number} flutterHz   tap train rate
 * @property {number} wet         default send return level
 */

/** @type {Record<string, ReverbDesc>} */
export const REVERB_PRESETS = {
  /** Marble floors, glass cases, 12 m ceiling. Long, bright, very audible. */
  museum: {
    rt60: 2.75, preDelay: 0.024, damping: 0.28, diffusion: 0.82,
    erGain: 0.55, erCount: 22, erSpread: 0.085, width: 0.85,
    lowCut: 130, highCut: 8200, modes: 0.05, modeHz: [43, 61, 88],
    flutter: 0.0, flutterHz: 0, wet: 0.34,
  },
  /** Outdoors: almost no tail, just a soft slap off the fence and the house wall. */
  garden: {
    rt60: 0.95, preDelay: 0.011, damping: 0.68, diffusion: 0.35,
    erGain: 0.85, erCount: 9, erSpread: 0.12, width: 0.95,
    lowCut: 190, highCut: 5200, modes: 0.0, modeHz: [],
    flutter: 0.0, flutterHz: 0, wet: 0.16,
  },
  /** Long parallel aisles → mid-heavy, boxy, with a distinct flutter echo. */
  supermarket: {
    rt60: 1.70, preDelay: 0.014, damping: 0.42, diffusion: 0.62,
    erGain: 0.72, erCount: 16, erSpread: 0.055, width: 0.7,
    lowCut: 160, highCut: 6600, modes: 0.10, modeHz: [57, 74, 112, 149],
    flutter: 0.18, flutterHz: 34, wet: 0.26,
  },
  /** Small room: bedroom / toy box. Dense early energy, almost no tail. */
  room: {
    rt60: 0.38, preDelay: 0.004, damping: 0.58, diffusion: 0.55,
    erGain: 1.0, erCount: 20, erSpread: 0.028, width: 0.6,
    lowCut: 200, highCut: 6000, modes: 0.14, modeHz: [92, 128, 176, 231],
    flutter: 0.06, flutterHz: 78, wet: 0.20,
  },
  /** Concrete garage — tight, hard, metallic ring. */
  garage: {
    rt60: 0.85, preDelay: 0.008, damping: 0.24, diffusion: 0.45,
    erGain: 0.9, erCount: 14, erSpread: 0.04, width: 0.55,
    lowCut: 150, highCut: 8800, modes: 0.16, modeHz: [68, 97, 143, 201],
    flutter: 0.12, flutterHz: 55, wet: 0.24,
  },
  /** Cathedral-ish, for the intro flyby / menus. */
  cavern: {
    rt60: 4.2, preDelay: 0.038, damping: 0.35, diffusion: 0.92,
    erGain: 0.4, erCount: 26, erSpread: 0.16, width: 0.95,
    lowCut: 110, highCut: 6400, modes: 0.04, modeHz: [31, 47, 66],
    flutter: 0, flutterHz: 0, wet: 0.30,
  },
  /** Essentially dry — a placeholder so `setPreset('none')` is well defined. */
  none: {
    rt60: 0.10, preDelay: 0.002, damping: 0.9, diffusion: 0.2,
    erGain: 0.4, erCount: 4, erSpread: 0.01, width: 0.3,
    lowCut: 300, highCut: 5000, modes: 0, modeHz: [],
    flutter: 0, flutterHz: 0, wet: 0.05,
  },
};

/**
 * Aliases so tracks can name their environment however they like — including
 * with the *render* system's skybox preset names, which is what a TrackData
 * usually has lying around (`environment.skybox`).
 */
const ALIASES = {
  toy_museum: 'museum', museum_hall: 'museum', hall: 'museum', indoor: 'museum',
  outdoor: 'garden', park: 'garden', lawn: 'garden', backyard: 'garden',
  store: 'supermarket', shop: 'supermarket', aisle: 'supermarket', market: 'supermarket',
  small: 'room', bedroom: 'room', toybox: 'room', toy_box: 'room', small_room: 'room',
  workshop: 'garage', basement: 'garage', concrete: 'garage',
  big: 'cavern', cathedral: 'cavern',
  dry: 'none', off: 'none',
  // Sky.js / RenderSystem skybox presets.
  studio: 'room', day: 'garden', sunset: 'garden', overcast: 'garden', night: 'garden',
};

/** Substring probes, tried in order when nothing matches exactly. */
const FUZZY = [
  ['museum', 'museum'], ['gallery', 'museum'], ['hall', 'museum'], ['atrium', 'museum'],
  ['garden', 'garden'], ['lawn', 'garden'], ['yard', 'garden'], ['park', 'garden'],
  ['patio', 'garden'], ['outdoor', 'garden'], ['beach', 'garden'], ['pond', 'garden'],
  ['market', 'supermarket'], ['store', 'supermarket'], ['shop', 'supermarket'],
  ['aisle', 'supermarket'], ['mall', 'supermarket'],
  ['garage', 'garage'], ['workshop', 'garage'], ['basement', 'garage'], ['cellar', 'garage'],
  ['cave', 'cavern'], ['cathedral', 'cavern'],
  ['room', 'room'], ['box', 'room'], ['bed', 'room'], ['kitchen', 'room'],
  ['attic', 'room'], ['desk', 'room'], ['table', 'room'], ['toy', 'room'],
];

/**
 * Resolve any track-supplied name to a preset key.
 * Accepts a string, or an object with `.preset` / `.name` / `.id`
 * (which is the shape `TrackData.environment.skybox` usually takes).
 */
export function resolveReverbName(name) {
  if (!name) return 'room';
  let k = name;
  if (typeof k === 'object') k = k.preset ?? k.name ?? k.id ?? '';
  k = String(k).toLowerCase().trim();
  if (!k) return 'room';
  if (REVERB_PRESETS[k]) return k;
  if (ALIASES[k]) return ALIASES[k];
  for (let i = 0; i < FUZZY.length; i++) if (k.includes(FUZZY[i][0])) return FUZZY[i][1];
  return 'room';
}

/**
 * Build a ReverbDesc from the **parametric** descriptor a TrackData carries:
 * `TrackData.audio.reverb = { roomSize, damping, wet, preDelay }` (all 0..1
 * except preDelay, which is seconds). This is the shape TrackBuilder emits.
 *
 * The hand-tuned preset chosen by `hint` (or by roomSize when there is no hint)
 * supplies the *character* — early-reflection pattern, room modes, flutter,
 * stereo width — and the track's numbers override the measurable quantities.
 * That way a track only has to say "big and bright" to get a real hall.
 *
 * @param {{roomSize?:number, damping?:number, wet?:number, preDelay?:number,
 *          rt60?:number, decay?:number, diffusion?:number, width?:number}} p
 * @param {string} [hint] preset name / skybox / track id
 * @returns {ReverbDesc & {name:string}}
 */
export function reverbDescFromParams(p, hint = null) {
  const size = clamp01(fin(p?.roomSize, 0.5));
  let baseKey = hint ? resolveReverbName(hint) : null;
  // `resolveReverbName` falls back to 'room' for anything unknown; if the hint
  // told us nothing useful, size is a better guide than a bad guess.
  if (!baseKey || (baseKey === 'room' && !hintIsRoomy(hint))) {
    baseKey = size >= 0.78 ? 'museum' : size >= 0.60 ? 'supermarket'
      : size >= 0.40 ? 'garage' : 'room';
  }
  const base = REVERB_PRESETS[baseKey] ?? REVERB_PRESETS.room;

  // rt60 from room size: 0.3 → 0.52 s, 0.55 → 1.3 s, 0.86 → 2.9 s, 1.0 → 3.8 s.
  const rt60 = fin(p?.rt60, fin(p?.decay, 0.20 + 3.6 * size * size));
  const desc = {
    ...base,
    rt60: clamp(rt60, 0.08, 5.0),
    damping: clamp01(fin(p?.damping, base.damping)),
    preDelay: clamp(fin(p?.preDelay, base.preDelay), 0, 0.12),
    wet: clamp(fin(p?.wet, base.wet), 0, 1.5),
    diffusion: clamp01(fin(p?.diffusion, base.diffusion)),
    width: clamp01(fin(p?.width, base.width)),
    // Bigger rooms have more, later reflections.
    erCount: Math.round(base.erCount * lerp(0.7, 1.35, size)),
    erSpread: base.erSpread * lerp(0.6, 1.5, size),
  };
  // Cache key: distinct per (character, size, damping) triple.
  desc.name = `p:${baseKey}:${desc.rt60.toFixed(2)}:${desc.damping.toFixed(2)}`;
  return desc;
}

/** Did the caller actually ask for a small room, or did we just default to one? */
function hintIsRoomy(hint) {
  if (!hint) return false;
  let k = hint;
  if (typeof k === 'object') k = k.preset ?? k.name ?? k.id ?? '';
  k = String(k).toLowerCase();
  return k === 'room' || k === 'small' || k === 'small_room' || k === 'studio'
    || k.includes('room') || k.includes('box') || k.includes('bed');
}

const LENGTH_SCALE = { low: 0.40, medium: 0.68, high: 1.0, ultra: 1.12 };

/**
 * Render a stereo impulse response into an AudioBuffer.
 * @param {BaseAudioContext} ctx
 * @param {ReverbDesc} d
 * @param {number} seed
 * @param {number} lengthScale
 * @returns {AudioBuffer|null}
 */
export function renderImpulseResponse(ctx, d, seed = 1, lengthScale = 1) {
  if (!ctx) return null;
  const sr = ctx.sampleRate || 48000;
  const rt60 = clamp(fin(d.rt60, 1) * lengthScale, 0.05, 5.0);
  const pre = clamp(fin(d.preDelay, 0.01), 0, 0.12);
  const len = Math.max(64, Math.floor((rt60 + pre + 0.05) * sr));
  const rng = new RNG(seed);

  const chans = [];
  for (let c = 0; c < 2; c++) {
    const a = new Float32Array(len);

    // ── 1. decaying noise tail ─────────────────────────────────────────────
    const preS = Math.floor(pre * sr);
    const k = 6.9078 / (rt60 * sr);                    // −60 dB over rt60
    const diff = clamp01(fin(d.diffusion, 0.6));
    // Low diffusion = grainy/gated tail: modulate the noise density.
    for (let i = preS; i < len; i++) {
      const t = i - preS;
      const env = Math.exp(-k * t);
      let n = rng.next() * 2 - 1;
      if (diff < 0.95) {
        // Sparse grains at low diffusion → discrete-sounding reflections.
        const density = lerp(0.10, 1.0, diff * diff);
        if (rng.next() > density) n *= 0.12;
      }
      a[i] = n * env;
    }

    // ── 2. progressive HF damping ─────────────────────────────────────────
    const damp = clamp01(fin(d.damping, 0.4));
    const aStart = lerp(0.92, 0.55, damp);
    const aEnd = lerp(0.34, 0.045, damp);
    onePoleSweep(a, aStart, aEnd);

    // ── 3. discrete early reflections ─────────────────────────────────────
    const erCount = Math.max(0, Math.round(fin(d.erCount, 12)));
    const erSpread = Math.max(0.001, fin(d.erSpread, 0.05));
    const erGain = Math.max(0, fin(d.erGain, 0.7));
    for (let e = 0; e < erCount; e++) {
      // Non-uniform tap times (sqrt distribution) → dense then thinning.
      const u = (e + rng.next() * 0.6) / erCount;
      const tt = pre + Math.pow(u, 0.72) * erSpread + (c === 1 ? 0.0009 * rng.next() : 0);
      const idx = Math.floor(tt * sr);
      if (idx <= 1 || idx >= len - 8) continue;
      const decay = Math.exp(-3.1 * u);
      const amp = erGain * decay * (0.55 + rng.next() * 0.45) * (rng.next() < 0.42 ? -1 : 1);
      // Smear each tap over a few samples so it is not a raw click.
      const w = 2 + Math.floor(rng.next() * 5);
      for (let s = 0; s < w; s++) {
        a[idx + s] += amp * Math.exp(-s / w) * (1 - s / (w + 1));
      }
    }

    // ── 4. room modes (boxiness) ──────────────────────────────────────────
    const modeAmp = Math.max(0, fin(d.modes, 0));
    const modes = Array.isArray(d.modeHz) ? d.modeHz : [];
    if (modeAmp > 0 && modes.length) {
      for (let m = 0; m < modes.length; m++) {
        const f = fin(modes[m], 60) * (1 + (rng.next() - 0.5) * 0.03);
        const mk = 6.9078 / (rt60 * 0.75 * sr);
        const ph = rng.next() * Math.PI * 2;
        const amp = modeAmp / (1 + m * 0.55);
        for (let i = preS; i < len; i++) {
          const t = i - preS;
          a[i] += amp * Math.exp(-mk * t) * Math.sin((t / sr) * Math.PI * 2 * f + ph);
        }
      }
    }

    // ── 5. flutter echo train (corridors, aisles) ─────────────────────────
    const flut = Math.max(0, fin(d.flutter, 0));
    const fhz = Math.max(1, fin(d.flutterHz, 40));
    if (flut > 0) {
      const step = Math.floor(sr / fhz);
      let idx = preS + step + (c === 1 ? Math.floor(step * 0.37) : 0);
      let amp = flut;
      let n = 0;
      while (idx < len - 4 && amp > 0.002 && n < 90) {
        const s = rng.next() < 0.5 ? -1 : 1;
        a[idx] += amp * s;
        a[idx + 1] += amp * 0.5 * s;
        amp *= 0.80;
        idx += step + Math.floor((rng.next() - 0.5) * step * 0.14);
        n++;
      }
    }

    // ── 6. band limiting ──────────────────────────────────────────────────
    applyBiquad(a, 'highpass', fin(d.lowCut, 160), 0.72, sr, 0, 2);
    applyBiquad(a, 'lowpass', fin(d.highCut, 7000), 0.72, sr, 0, 1);

    // Tiny fade-in guard so the very first sample can never click.
    const fi = Math.min(24, len);
    for (let i = 0; i < fi; i++) a[i] *= i / fi;
    // Fade-out so the IR truly ends at zero.
    const fo = Math.min(Math.floor(sr * 0.02), Math.floor(len / 8));
    for (let i = 0; i < fo; i++) a[len - 1 - i] *= i / fo;

    chans.push(a);
  }

  // ── 7. stereo width: partially correlate the two channels ───────────────
  const width = clamp01(fin(d.width, 0.8));
  if (width < 0.999) {
    const mix = (1 - width) * 0.5;
    const L = chans[0], R = chans[1];
    for (let i = 0; i < len; i++) {
      const l = L[i], r = R[i];
      L[i] = l * (1 - mix) + r * mix;
      R[i] = r * (1 - mix) + l * mix;
    }
  }

  // ── 8. equal-loudness normalisation across presets ──────────────────────
  // Normalising on RMS (not peak) means switching rooms does not jump in level.
  const target = 0.055;
  const cur = Math.max(1e-6, (rms(chans[0]) + rms(chans[1])) * 0.5);
  const g = clamp(target / cur, 0, 12);
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const a = chans[c];
    for (let i = 0; i < len; i++) { a[i] *= g; const v = Math.abs(a[i]); if (v > peak) peak = v; }
  }
  // Guard against clipping the convolver input.
  if (peak > 1) {
    const s = 0.98 / peak;
    for (let c = 0; c < 2; c++) { const a = chans[c]; for (let i = 0; i < len; i++) a[i] *= s; }
  }

  return toBuffer(ctx, chans);
}

export class Reverb {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{quality?:string, seed?:number, enabled?:boolean}} [opts]
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.quality = opts.quality ?? CONFIG.quality ?? 'high';
    this.seed = opts.seed ?? (CONFIG.seed ?? 1) ^ 0x5eed;
    this.enabled = opts.enabled !== false;
    this.lengthScale = LENGTH_SCALE[this.quality] ?? 1;

    this.ready = false;
    this.current = null;          // preset name
    this.pending = null;
    this._slot = 0;               // which convolver is live
    this._fadeEnd = 0;
    /** @type {Map<string, AudioBuffer>} */
    this._cache = new Map();

    this.input = null;
    this.output = null;
    this.conv = [null, null];
    this.convGain = [null, null];
    this.wet = 0.25;

    this._build();
  }

  _build() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      this.input = gain(ctx, 1);
      // Keep the tail out of the mud and away from the tweeters.
      this.preHP = filter(ctx, 'highpass', 170, 0.7);
      this.preLP = filter(ctx, 'lowpass', 7600, 0.7);
      this.output = gain(ctx, this.wet);

      for (let i = 0; i < 2; i++) {
        this.conv[i] = ctx.createConvolver();
        this.conv[i].normalize = false;      // our IRs are already normalised
        this.convGain[i] = gain(ctx, i === 0 ? 1 : 0);
        this.conv[i].connect(this.convGain[i]);
        this.convGain[i].connect(this.output);
      }
      this.input.connect(this.preHP);
      this.preHP.connect(this.preLP);
      this.preLP.connect(this.conv[0]);
      this.preLP.connect(this.conv[1]);
      this.ready = true;
    } catch (err) {
      console.warn('[Reverb] unavailable:', err);
      this.ready = false;
    }
  }

  /** Master wet level for the reverb return. */
  setWet(v, seconds = 0.3) {
    this.wet = clamp(fin(v, 0.25), 0, 2);
    if (!this.output) return;
    const now = this.ctx.currentTime;
    holdParam(this.output.gain, now);
    rampTo(this.output.gain, this.enabled ? this.wet : 0, now + Math.max(0.01, seconds));
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.setWet(this.wet, 0.2);
  }

  /** Get (rendering + caching if needed) the IR buffer for a preset. */
  _buffer(name, desc) {
    const key = `${name}|${this.lengthScale.toFixed(2)}`;
    let buf = this._cache.get(key);
    if (buf) return buf;
    const t0 = (globalThis.performance?.now?.() ?? 0);
    buf = renderImpulseResponse(this.ctx, desc, this.seed ^ hash(name), this.lengthScale);
    if (buf) {
      this._cache.set(key, buf);
      if (CONFIG.debug) {
        const ms = (globalThis.performance?.now?.() ?? 0) - t0;
        console.info(`[Reverb] rendered "${name}" ${buf.duration.toFixed(2)}s in ${ms.toFixed(1)}ms`);
      }
    }
    return buf;
  }

  /**
   * Switch room. Crossfades over `fade` seconds.
   * @param {string|ReverbDesc} nameOrDesc
   * @param {number} fade
   * @param {number} [wet] override the preset's default return level
   */
  setPreset(nameOrDesc, fade = 0.8, wet = undefined) {
    if (!this.ready) return false;
    let name, desc;
    if (nameOrDesc && typeof nameOrDesc === 'object') {
      name = nameOrDesc.name || 'custom';
      desc = { ...REVERB_PRESETS.room, ...nameOrDesc };
    } else {
      name = resolveReverbName(nameOrDesc);
      desc = REVERB_PRESETS[name];
    }
    if (!desc) return false;
    if (name === this.current && wet === undefined) return true;

    const buf = this._buffer(name, desc);
    if (!buf) return false;

    const next = this._slot ^ 1;
    try { this.conv[next].buffer = buf; } catch { return false; }

    const now = this.ctx.currentTime;
    const f = Math.max(0.02, fin(fade, 0.8));
    holdParam(this.convGain[next].gain, now);
    rampTo(this.convGain[next].gain, 1, now + f);
    holdParam(this.convGain[this._slot].gain, now);
    rampTo(this.convGain[this._slot].gain, 0, now + f);

    this._slot = next;
    this.current = name;
    this._fadeEnd = now + f;
    this.setWet(wet !== undefined ? wet : desc.wet, f);
    return true;
  }

  /** Pre-render presets so the first track load does not hitch. */
  warm(names = ['museum', 'garden', 'supermarket', 'room']) {
    if (!this.ready) return;
    for (const n of names) {
      const k = resolveReverbName(n);
      const d = REVERB_PRESETS[k];
      if (d) this._buffer(k, d);
    }
  }

  stats() {
    return {
      ready: this.ready, current: this.current, wet: this.wet,
      cached: this._cache.size, lengthScale: this.lengthScale,
    };
  }

  dispose() {
    kill(this.input); kill(this.preHP); kill(this.preLP); kill(this.output);
    for (let i = 0; i < 2; i++) { kill(this.conv[i]); kill(this.convGain[i]); }
    this._cache.clear();
    this.ready = false;
  }
}

function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export default Reverb;
