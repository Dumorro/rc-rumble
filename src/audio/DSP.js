/**
 * src/audio/DSP.js — low-level WebAudio synthesis primitives.
 *
 * Everything in RC RUMBLE's soundtrack and sound effects is generated here: noise
 * buffers, wavetables (PeriodicWave), offline biquad filtering of Float32Arrays,
 * distortion curves and AudioParam envelope helpers.
 *
 * ZERO assets. No files, no data URIs. Pure maths.
 *
 * Design notes
 * ────────────
 * · Every scheduling helper sanitizes its inputs and swallows exceptions. A NaN
 *   leaking out of the vehicle model must never silence the game or throw inside
 *   an update loop.
 * · Buffers are generated once and shared. `createResources()` builds the whole
 *   shared pool for a context; a car's engine/tire chain only ever *reads* from it.
 * · Noise loops are made seamless with a proper head/tail crossfade (generate
 *   L+fade samples, blend the tail into the head) so a 1.6 s loop is inaudible.
 */

import { RNG, clamp, clamp01, lerp } from '../core/MathUtils.js';

export const TWO_PI = Math.PI * 2;

// ───────────────────────────────────────────────────────────── scalar helpers

/** Guarantee a finite number. Audio APIs throw on NaN/Infinity. */
export function fin(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const _warnedOnce = new Set();

/**
 * console.warn at most once per session for a given `key`.
 *
 * Audio degrades quietly by design — an unknown car class or a missing recipe
 * falls back to something plausible rather than throwing. That is the right
 * runtime behaviour and the wrong debugging behaviour, so every fallback that
 * could mask a typo says so exactly once instead of once per frame.
 *
 * The key is deliberately separate from the message: a field of eight cars
 * sharing one typo'd def should warn once about the typo, not once per car,
 * so the key names the *mistake* while the message can name a car.
 */
export function warnOnce(key, msg = key) {
  if (_warnedOnce.has(key)) return;
  _warnedOnce.add(key);
  console.warn(msg);
}

/**
 * Highest frequency we are allowed to write into a filter/oscillator param.
 * Some devices (and headless Chrome) run at 16 kHz; writing 20 kHz there makes
 * WebAudio clamp *and* log a warning every frame.
 */
export function nyquistOf(ctx, margin = 0.47) {
  return Math.max(2000, (ctx?.sampleRate ?? 48000) * margin);
}

export function dbToGain(db) { return Math.pow(10, fin(db) / 20); }
export function gainToDb(g) { return 20 * Math.log10(Math.max(1e-6, fin(g))); }

/** MIDI note number → Hz (69 = A4 = 440). */
export function noteHz(midi) { return 440 * Math.pow(2, (fin(midi, 69) - 69) / 12); }

/** Cents offset → frequency ratio. */
export function centsRatio(cents) { return Math.pow(2, fin(cents) / 1200); }

/** Musical-feeling exponential mapping, t in [0,1]. */
export function expMap(t, a, b) {
  t = clamp01(fin(t));
  const lo = Math.max(1e-4, a), hi = Math.max(1e-4, b);
  return lo * Math.pow(hi / lo, t);
}

// ─────────────────────────────────────────────────── AudioParam scheduling

/** Cancel pending automation and pin the param at its current value. */
export function holdParam(param, t) {
  if (!param) return 0;
  try {
    const v = fin(param.value);
    param.cancelScheduledValues(fin(t));
    param.setValueAtTime(v, fin(t));
    return v;
  } catch { return 0; }
}

export function setParam(param, v, t) {
  if (!param) return;
  try { param.setValueAtTime(fin(v), Math.max(0, fin(t))); } catch { /* ignore */ }
}

export function rampTo(param, v, t) {
  if (!param) return;
  try { param.linearRampToValueAtTime(fin(v), Math.max(0, fin(t))); } catch { /* ignore */ }
}

/** Exponential ramp; clamps away from zero so it never throws. */
export function expTo(param, v, t, floor = 1e-4) {
  if (!param) return;
  try { param.exponentialRampToValueAtTime(Math.max(floor, Math.abs(fin(v, floor))), Math.max(0, fin(t))); }
  catch { /* ignore */ }
}

/** One-pole approach; the workhorse for continuous (engine / tire) params. */
export function targetTo(param, v, t, tau) {
  if (!param) return;
  try { param.setTargetAtTime(fin(v), Math.max(0, fin(t)), Math.max(0.0008, fin(tau, 0.02))); }
  catch { /* ignore */ }
}

/**
 * Percussive AD envelope. Returns the time the envelope finishes.
 * Uses an exponential tail (sounds natural) with a hard zero afterwards.
 */
export function perc(param, t0, peak, attack = 0.002, decay = 0.12, floor = 0.0006) {
  if (!param) return fin(t0) + attack + decay;
  const t = Math.max(0, fin(t0));
  const p = Math.max(floor * 2, Math.abs(fin(peak, 1)));
  const a = Math.max(0.0005, fin(attack, 0.002));
  const d = Math.max(0.004, fin(decay, 0.12));
  try {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(p, t + a);
    param.exponentialRampToValueAtTime(floor, t + a + d);
    param.setValueAtTime(0, t + a + d + 0.001);
  } catch { /* ignore */ }
  return t + a + d + 0.002;
}

/** Classic ASR with linear attack + exponential release. Returns end time. */
export function asr(param, t0, peak, attack, hold, release, floor = 0.0006) {
  if (!param) return fin(t0) + attack + hold + release;
  const t = Math.max(0, fin(t0));
  const p = Math.max(floor * 2, Math.abs(fin(peak, 1)));
  const a = Math.max(0.0005, fin(attack, 0.01));
  const h = Math.max(0, fin(hold, 0.05));
  const r = Math.max(0.005, fin(release, 0.1));
  try {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(p, t + a);
    param.setValueAtTime(p, t + a + h);
    param.exponentialRampToValueAtTime(floor, t + a + h + r);
    param.setValueAtTime(0, t + a + h + r + 0.001);
  } catch { /* ignore */ }
  return t + a + h + r + 0.002;
}

/** Frequency sweep helper (exponential, musical). */
export function sweep(param, t0, from, to, seconds) {
  if (!param) return;
  const t = Math.max(0, fin(t0));
  try {
    param.cancelScheduledValues(t);
    param.setValueAtTime(Math.max(1, fin(from, 100)), t);
    param.exponentialRampToValueAtTime(Math.max(1, fin(to, 100)), t + Math.max(0.005, fin(seconds, 0.1)));
  } catch { /* ignore */ }
}

// ────────────────────────────────────────────────────────────── wavetables

/**
 * Build a PeriodicWave from a partial-magnitude list.
 * `partials[i]` is the magnitude of harmonic (i+1). Phases are randomized a
 * little (via `phaseJitter`) which softens the "buzzy digital" edge.
 */
export function periodicWave(ctx, partials, { phaseJitter = 0, rng = null, normalize = true } = {}) {
  const n = partials.length + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < partials.length; i++) {
    const m = fin(partials[i]);
    if (m === 0) continue;
    if (phaseJitter > 0 && rng) {
      const ph = (rng.next() * 2 - 1) * phaseJitter * Math.PI;
      real[i + 1] = m * Math.sin(ph);
      imag[i + 1] = m * Math.cos(ph);
    } else {
      imag[i + 1] = m;
    }
  }
  try {
    return ctx.createPeriodicWave(real, imag, { disableNormalization: !normalize });
  } catch {
    return null;
  }
}

/** Ideal sawtooth partials: 1/n, alternating sign. */
export function sawPartials(n = 32) {
  const p = new Float32Array(n);
  for (let i = 1; i <= n; i++) p[i - 1] = (i % 2 === 1 ? 1 : -1) / i;
  return p;
}

/** Band-limited pulse of a given duty cycle. */
export function pulsePartials(duty = 0.25, n = 32) {
  const p = new Float32Array(n);
  for (let i = 1; i <= n; i++) p[i - 1] = Math.sin(Math.PI * i * duty) / i;
  return p;
}

/** Square = 50% pulse (odd harmonics only). */
export function squarePartials(n = 24) {
  const p = new Float32Array(n);
  for (let i = 1; i <= n; i++) p[i - 1] = i % 2 === 1 ? 1 / i : 0;
  return p;
}

export function trianglePartials(n = 16) {
  const p = new Float32Array(n);
  for (let i = 1; i <= n; i++) p[i - 1] = i % 2 === 1 ? ((i % 4 === 1) ? 1 : -1) / (i * i) : 0;
  return p;
}

/**
 * A small brushed-DC-motor "body": strong fundamental, dominant 2nd/3rd from the
 * commutator, a hollow dip around the 4th and a long 1/n tail for grit.
 */
export function motorPartials(n = 26) {
  const shape = [1.0, 0.82, 0.62, 0.24, 0.40, 0.18, 0.26, 0.12, 0.17, 0.09];
  const p = new Float32Array(n);
  for (let i = 1; i <= n; i++) {
    p[i - 1] = i <= shape.length ? shape[i - 1] : 0.9 / (i * 1.15);
    if (i % 2 === 0) p[i - 1] *= 0.86;      // slight odd-harmonic bias → "growl"
  }
  return p;
}

/**
 * The commutator whine: nearly no fundamental, a screaming 2nd/4th/6th. This is
 * what makes an RC car read as a *toy* rather than a V8.
 */
export function whinePartials(n = 20) {
  const shape = [0.10, 1.00, 0.20, 0.62, 0.11, 0.34, 0.08, 0.20, 0.05, 0.12];
  const p = new Float32Array(n);
  for (let i = 1; i <= n; i++) p[i - 1] = i <= shape.length ? shape[i - 1] : 0.35 / i;
  return p;
}

/** Warm organ/pad partials for the music system. */
export function padPartials(n = 14) {
  const p = new Float32Array(n);
  for (let i = 1; i <= n; i++) {
    p[i - 1] = (1 / Math.pow(i, 1.45)) * (i % 2 === 1 ? 1 : 0.55);
  }
  p[0] = 1; p[1] = 0.42; p[2] = 0.34;
  return p;
}

/** Reedy chip-tune lead: odd harmonics with a formant bump around the 5th. */
export function leadPartials(n = 22) {
  const p = new Float32Array(n);
  for (let i = 1; i <= n; i++) {
    let m = i % 2 === 1 ? 1 / i : 0.22 / i;
    if (i >= 4 && i <= 7) m *= 1.9;
    p[i - 1] = m;
  }
  return p;
}

// ──────────────────────────────────────────────────────── offline filtering

/**
 * RBJ biquad coefficients.
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}}
 */
export function biquadCoefficients(type, freq, Q, sr, gainDb = 0) {
  const f0 = clamp(fin(freq, 1000), 1, sr * 0.49);
  const q = Math.max(0.0001, fin(Q, 0.707));
  const w0 = TWO_PI * f0 / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  switch (type) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass':      // 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpassQ':     // constant skirt, peak gain = Q
      b0 = q * alpha; b1 = 0; b2 = -q * alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking': {
      const A = Math.pow(10, fin(gainDb) / 40);
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    }
    case 'lowshelf': {
      const A = Math.pow(10, fin(gainDb) / 40), sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + sa);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sa);
      a0 = (A + 1) + (A - 1) * cw + sa;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - sa; break;
    }
    case 'highshelf': {
      const A = Math.pow(10, fin(gainDb) / 40), sa = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + sa);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - sa);
      a0 = (A + 1) - (A - 1) * cw + sa;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - sa; break;
    }
    default: break;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Run a biquad over a Float32Array in place.
 * `passes` > 1 steepens the slope; `bidirectional` gives zero phase (good for
 * shaping noise where pre-ringing does not matter).
 */
export function applyBiquad(data, type, freq, Q, sr, gainDb = 0, passes = 1, bidirectional = false) {
  const c = biquadCoefficients(type, freq, Q, sr, gainDb);
  const n = data.length;
  for (let p = 0; p < passes; p++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const x = data[i];
      const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      data[i] = y;
    }
    if (bidirectional) {
      x1 = 0; x2 = 0; y1 = 0; y2 = 0;
      for (let i = n - 1; i >= 0; i--) {
        const x = data[i];
        const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        data[i] = y;
      }
    }
  }
  return data;
}

/** One-pole lowpass with a *time-varying* coefficient (0..1). Used for IR darkening. */
export function onePoleSweep(data, aStart, aEnd) {
  let y = 0;
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const a = clamp01(lerp(aStart, aEnd, i / n));
    y += a * (data[i] - y);
    data[i] = y;
  }
  return data;
}

/** Peak-normalize in place. */
export function normalize(data, peak = 1) {
  let m = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > m) m = a; }
  if (m < 1e-9) return data;
  const g = peak / m;
  for (let i = 0; i < data.length; i++) data[i] *= g;
  return data;
}

/** RMS of a Float32Array. */
export function rms(data) {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / Math.max(1, data.length));
}

// ─────────────────────────────────────────────────────────── noise sources

/** Fill with uniform white noise using a deterministic RNG. */
export function fillWhite(data, rng) {
  for (let i = 0; i < data.length; i++) data[i] = rng.next() * 2 - 1;
  return data;
}

/** Paul Kellet's pink-noise approximation (-3 dB/oct). */
export function fillPink(data, rng) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return data;
}

/** Brown / red noise (-6 dB/oct). Great for room tone and rumble. */
export function fillBrown(data, rng) {
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = rng.next() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    data[i] = last * 3.5;
  }
  return normalize(data, 0.85);
}

/**
 * Sparse impulse "crackle": a Poisson-ish scatter of decaying clicks. Used for
 * gravel rattle, electric arcing and overrun pops.
 */
export function fillCrackle(data, rng, density = 0.004, decaySamples = 60) {
  data.fill(0);
  const n = data.length;
  const inv = 1 / Math.max(1, decaySamples);
  for (let i = 0; i < n; i++) {
    if (rng.next() < density) {
      const amp = (rng.next() * 2 - 1) * (0.4 + rng.next() * 0.6);
      const len = Math.floor(decaySamples * (0.3 + rng.next()));
      for (let k = 0; k < len && i + k < n; k++) {
        data[i + k] += amp * Math.exp(-k * inv * 2.5) * Math.cos(k * 0.6);
      }
    }
  }
  return normalize(data, 0.9);
}

/**
 * Generate a *seamless* looping noise Float32Array of `length` samples.
 * Generates `length + fade` samples then blends the tail region over the head,
 * so sample L-1 → sample 0 is continuous in the source stream.
 */
export function seamlessNoise(length, fade, kind, rng) {
  const f = Math.min(Math.floor(Math.max(0, fade)), Math.floor(length / 3));
  const tmp = new Float32Array(length + f);
  if (kind === 'pink') fillPink(tmp, rng);
  else if (kind === 'brown') fillBrown(tmp, rng);
  else if (kind === 'crackle') fillCrackle(tmp, rng);
  else fillWhite(tmp, rng);

  const out = new Float32Array(length);
  out.set(tmp.subarray(0, length));
  for (let i = 0; i < f; i++) {
    const w = i / f;
    out[i] = tmp[i] * w + tmp[length + i] * (1 - w);
  }
  return out;
}

/** Wrap a Float32Array (or several, one per channel) into an AudioBuffer. */
export function toBuffer(ctx, channels, sr = null) {
  const chans = Array.isArray(channels) ? channels : [channels];
  const len = chans[0].length;
  try {
    const buf = ctx.createBuffer(chans.length, len, sr || ctx.sampleRate);
    for (let c = 0; c < chans.length; c++) buf.copyToChannel(chans[c], c);
    return buf;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────── shaper curves

/** Soft saturation curve for a WaveShaperNode. `drive` ≈ 1..8. */
export function softClipCurve(n = 2048, drive = 2) {
  const c = new Float32Array(n);
  const d = Math.max(0.1, drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * d) / Math.tanh(d);
  }
  return c;
}

/** Asymmetric tube-ish curve — adds even harmonics (good on the engine bus). */
export function tubeCurve(n = 2048, drive = 1.6, bias = 0.12) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1 + bias;
    const y = Math.tanh(x * drive);
    c[i] = clamp(y - Math.tanh(bias * drive), -1, 1);
  }
  return c;
}

/** Wavefolder — used for the electro-zap and the rev limiter buzz. */
export function foldCurve(n = 2048, folds = 2.4) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.sin(x * folds * Math.PI * 0.5);
  }
  return c;
}

/** Bit-crush-ish quantizer curve for retro UI blips. */
export function crushCurve(n = 2048, steps = 9) {
  const c = new Float32Array(n);
  const s = Math.max(2, Math.round(steps));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * s) / s;
  }
  return c;
}

// ───────────────────────────────────────────────────── shared resource pool

/**
 * Everything a synth needs that is worth building exactly once per AudioContext.
 * Cheap to build (~8 ms), ~4 MB of buffers.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} seed
 */
export function createResources(ctx, seed = 0x5c1a2b) {
  const rng = new RNG(seed);
  const sr = ctx.sampleRate || 48000;
  const res = {
    ctx, sr,
    waves: {},
    buffers: {},
    curves: {},
    /** independent noise buffers, fanned out to decorrelate cars */
    noiseWhite: [],
    noisePink: [],
    disposed: false,
  };

  // ── wavetables ──
  res.waves.saw = periodicWave(ctx, sawPartials(34));
  res.waves.softSaw = periodicWave(ctx, sawPartials(14));
  res.waves.square = periodicWave(ctx, squarePartials(22));
  res.waves.triangle = periodicWave(ctx, trianglePartials(18));
  res.waves.pulse12 = periodicWave(ctx, pulsePartials(0.12, 30));
  res.waves.pulse25 = periodicWave(ctx, pulsePartials(0.25, 30));
  res.waves.pulse40 = periodicWave(ctx, pulsePartials(0.40, 26));
  res.waves.motor = periodicWave(ctx, motorPartials(26), { phaseJitter: 0.35, rng });
  res.waves.whine = periodicWave(ctx, whinePartials(20), { phaseJitter: 0.2, rng });
  res.waves.pad = periodicWave(ctx, padPartials(14));
  res.waves.lead = periodicWave(ctx, leadPartials(22));

  // ── shaping curves ──
  res.curves.soft = softClipCurve(2048, 1.8);
  res.curves.hot = softClipCurve(2048, 5.0);
  res.curves.tube = tubeCurve(2048, 2.2, 0.1);
  res.curves.fold = foldCurve(2048, 2.6);
  res.curves.crush = crushCurve(1024, 11);

  // ── noise buffers (seamless loops) ──
  const loopLen = Math.floor(sr * 1.7);
  const fade = Math.floor(sr * 0.05);
  for (let i = 0; i < 3; i++) {
    const b = toBuffer(ctx, seamlessNoise(loopLen, fade, 'white', rng));
    if (b) res.noiseWhite.push(b);
  }
  for (let i = 0; i < 2; i++) {
    const b = toBuffer(ctx, seamlessNoise(loopLen, fade, 'pink', rng));
    if (b) res.noisePink.push(b);
  }
  res.buffers.brown = toBuffer(ctx, seamlessNoise(Math.floor(sr * 2.4), fade, 'brown', rng));
  res.buffers.crackle = toBuffer(ctx, seamlessNoise(Math.floor(sr * 2.0), fade, 'crackle', rng));

  // ── one-shot noise bursts (short, non-looping; used by impacts) ──
  {
    const n = Math.floor(sr * 0.5);
    const d = new Float32Array(n);
    fillWhite(d, rng);
    res.buffers.burst = toBuffer(ctx, d);
  }
  {
    // "bright" burst: highpassed white → tick / glass transients
    const n = Math.floor(sr * 0.25);
    const d = new Float32Array(n);
    fillWhite(d, rng);
    applyBiquad(d, 'highpass', 2600, 0.7, sr, 0, 2);
    normalize(d, 1);
    res.buffers.tick = toBuffer(ctx, d);
  }
  {
    // "dark" burst: lowpassed → thuds
    const n = Math.floor(sr * 0.6);
    const d = new Float32Array(n);
    fillWhite(d, rng);
    applyBiquad(d, 'lowpass', 420, 0.9, sr, 0, 2);
    normalize(d, 1);
    res.buffers.thump = toBuffer(ctx, d);
  }
  {
    // water: band-limited noise with a bubbly amplitude texture
    const n = Math.floor(sr * 1.2);
    const d = new Float32Array(n);
    fillWhite(d, rng);
    applyBiquad(d, 'bandpass', 2400, 0.55, sr, 0, 1);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      d[i] *= 0.6 + 0.4 * Math.sin(t * 61) * Math.sin(t * 23.5);
    }
    normalize(d, 1);
    res.buffers.water = toBuffer(ctx, d);
  }
  {
    // grit: mid-band crackly noise for gravel / scrape
    const n = Math.floor(sr * 1.7);
    const d = seamlessNoise(n, fade, 'crackle', rng);
    applyBiquad(d, 'bandpass', 900, 0.5, sr, 0, 1);
    normalize(d, 0.95);
    res.buffers.grit = toBuffer(ctx, d);
  }

  res.noise = () => res.noiseWhite[0] || null;
  return res;
}

/** Pick one of N decorrelated white-noise buffers by index. */
export function whiteFor(res, i = 0) {
  if (!res || !res.noiseWhite.length) return null;
  return res.noiseWhite[Math.abs(i | 0) % res.noiseWhite.length];
}
export function pinkFor(res, i = 0) {
  if (!res || !res.noisePink.length) return null;
  return res.noisePink[Math.abs(i | 0) % res.noisePink.length];
}

// ───────────────────────────────────────────────────────────── node helpers

/** Create + start a looping buffer source. Returns null if anything is missing. */
export function loopSource(ctx, buffer, { rate = 1, offset = -1, detune = 0, when = 0 } = {}) {
  if (!ctx || !buffer) return null;
  try {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = clamp(fin(rate, 1), 0.05, 16);
    if (s.detune) s.detune.value = fin(detune);
    const off = offset >= 0 ? offset : Math.random() * buffer.duration;
    s.start(Math.max(0, fin(when)), off % buffer.duration);
    return s;
  } catch { return null; }
}

/** One-shot buffer source. */
export function oneShot(ctx, buffer, { rate = 1, when = 0, offset = 0, duration = 0 } = {}) {
  if (!ctx || !buffer) return null;
  try {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.playbackRate.value = clamp(fin(rate, 1), 0.05, 16);
    const t = Math.max(0, fin(when));
    if (duration > 0) s.start(t, fin(offset), duration);
    else s.start(t, fin(offset));
    return s;
  } catch { return null; }
}

/** Oscillator with an optional PeriodicWave. */
export function osc(ctx, { wave = null, type = 'sine', freq = 440, detune = 0, when = 0 } = {}) {
  if (!ctx) return null;
  try {
    const o = ctx.createOscillator();
    if (wave) o.setPeriodicWave(wave); else o.type = type;
    o.frequency.value = clamp(fin(freq, 440), 0.01, ctx.sampleRate * 0.48);
    o.detune.value = fin(detune);
    o.start(Math.max(0, fin(when)));
    return o;
  } catch { return null; }
}

export function gain(ctx, v = 1) {
  try { const g = ctx.createGain(); g.gain.value = fin(v, 1); return g; } catch { return null; }
}

export function filter(ctx, type = 'lowpass', freq = 1000, Q = 1, gainDb = 0) {
  try {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = clamp(fin(freq, 1000), 10, ctx.sampleRate * 0.48);
    f.Q.value = Math.max(0.0001, fin(Q, 1));
    if (gainDb) f.gain.value = fin(gainDb);
    return f;
  } catch { return null; }
}

export function shaper(ctx, curve, oversample = '2x') {
  try {
    const w = ctx.createWaveShaper();
    w.curve = curve;
    w.oversample = oversample;
    return w;
  } catch { return null; }
}

export function delayNode(ctx, seconds = 0.1, max = 1.0) {
  try {
    const d = ctx.createDelay(Math.max(0.001, max));
    d.delayTime.value = clamp(fin(seconds, 0.1), 0, max);
    return d;
  } catch { return null; }
}

/** Connect a chain of nodes, skipping nulls. Returns the last non-null node. */
export function chain(...nodes) {
  let prev = null;
  for (const n of nodes) {
    if (!n) continue;
    if (prev) { try { prev.connect(n); } catch { /* ignore */ } }
    prev = n;
  }
  return prev;
}

/** Safe disconnect. */
export function kill(node) {
  if (!node) return;
  try { node.disconnect(); } catch { /* ignore */ }
  try { if (typeof node.stop === 'function') node.stop(); } catch { /* ignore */ }
  try { node.onended = null; } catch { /* ignore */ }
}

/** Stop a source at a time, then disconnect. */
export function stopAt(node, t) {
  if (!node) return;
  try { if (typeof node.stop === 'function') node.stop(Math.max(0, fin(t))); } catch { /* ignore */ }
}

export default {
  fin, nyquistOf, dbToGain, gainToDb, noteHz, centsRatio, expMap,
  holdParam, setParam, rampTo, expTo, targetTo, perc, asr, sweep,
  periodicWave, sawPartials, pulsePartials, squarePartials, trianglePartials,
  motorPartials, whinePartials, padPartials, leadPartials,
  biquadCoefficients, applyBiquad, onePoleSweep, normalize, rms,
  fillWhite, fillPink, fillBrown, fillCrackle, seamlessNoise, toBuffer,
  softClipCurve, tubeCurve, foldCurve, crushCurve,
  createResources, whiteFor, pinkFor,
  loopSource, oneShot, osc, gain, filter, shaper, delayNode, chain, kill, stopAt,
};
