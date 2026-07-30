/**
 * src/audio/VoicePool.js — polyphony management.
 *
 * A `Voice` is a pooled output stage: a gain node, an optional PannerNode and an
 * optional reverb-send gain. Synths build their transient nodes (oscillators,
 * filters, buffer sources), connect them into `voice.input` and register them
 * with `voice.attach(node)` so the pool can tear them down.
 *
 * Why pool at all?
 *   · Hard cap on simultaneous voices (CONFIG.audio.maxVoices) with sensible
 *     stealing, so a 12-car pile-up cannot melt the audio thread.
 *   · The *output* stage (gain + panner + send) is created once and reused, which
 *     is where most of the per-node allocation cost lives.
 *   · Deterministic cleanup: a sweep in update() disconnects everything whose
 *     scheduled end time has passed, so we never rely on `onended` firing.
 *
 * Doppler is done by hand: the Web Audio doppler parameters were removed from the
 * spec years ago, so spatial voices register the AudioParams that should track
 * pitch (`addRateTarget`) and the pool re-writes them each frame from the
 * listener/source relative radial velocity.
 */

import CONFIG from '../core/Config.js';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { fin, holdParam, rampTo, targetTo, kill } from './DSP.js';

const MAX_RATE_TARGETS = 6;

/** Scratch (module level — no allocations in update()). */
const _dir = new Float32Array(3);

export class Voice {
  /** @param {VoicePool} pool */
  constructor(pool, index) {
    this.pool = pool;
    this.index = index;
    this.ctx = pool.ctx;

    /** Output stage — created once, reused forever. */
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    /** @type {PannerNode|null} */
    this.panner = null;
    /** @type {GainNode|null} */
    this.send = null;

    /** Transient nodes owned by whatever synthesised into this voice. */
    this.nodes = [];
    /** AudioParams that follow doppler: [param, baseValue] pairs, flattened. */
    this._rateParams = new Array(MAX_RATE_TARGETS).fill(null);
    this._rateBase = new Float32Array(MAX_RATE_TARGETS);
    this._rateMode = new Uint8Array(MAX_RATE_TARGETS); // 0 = multiply, 1 = cents offset
    this._rateCount = 0;

    this.active = false;
    this.persistent = false;
    this.name = '';
    this.priority = 0;
    this.token = 0;
    this.startTime = 0;
    this.endTime = 0;
    this.volume = 1;
    this.spatial = false;
    this.px = 0; this.py = 0; this.pz = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.doppler = 1;
    this.distance = 0;
    /** Optional per-voice callback invoked right before release. */
    this.onRelease = null;
    /** Optional per-frame callback (rare — loops that need custom modulation). */
    this.onTick = null;
    this.userData = null;
  }

  /** The node a synth should connect its output into. */
  get input() { return this.gain; }

  /** Register a transient node for teardown. */
  attach(node) {
    if (node) this.nodes.push(node);
    return node;
  }

  /**
   * Register an AudioParam that should be pitch-shifted by doppler.
   * @param {AudioParam} param
   * @param {number} base the un-shifted value
   * @param {'ratio'|'cents'} mode `ratio` multiplies base; `cents` writes an offset
   */
  addRateTarget(param, base, mode = 'ratio') {
    if (!param || this._rateCount >= MAX_RATE_TARGETS) return;
    const i = this._rateCount++;
    this._rateParams[i] = param;
    this._rateBase[i] = fin(base, 1);
    this._rateMode[i] = mode === 'cents' ? 1 : 0;
  }

  setVolume(v, seconds = 0.02) {
    this.volume = clamp(fin(v, 1), 0, 8);
    if (!this.active) return;
    const now = this.ctx.currentTime;
    const g = this.gain.gain;
    if (seconds <= 0.001) { holdParam(g, now); return; }
    holdParam(g, now);
    rampTo(g, this.volume, now + seconds);
  }

  setPosition(x, y, z) {
    this.px = fin(x); this.py = fin(y); this.pz = fin(z);
    if (!this.spatial || !this.panner) return;
    const p = this.panner;
    const now = this.ctx.currentTime;
    if (p.positionX) {
      targetTo(p.positionX, this.px, now, 0.012);
      targetTo(p.positionY, this.py, now, 0.012);
      targetTo(p.positionZ, this.pz, now, 0.012);
    } else if (p.setPosition) {
      try { p.setPosition(this.px, this.py, this.pz); } catch { /* ignore */ }
    }
  }

  setVelocity(x, y, z) {
    this.vx = fin(x); this.vy = fin(y); this.vz = fin(z);
  }

  /** Set the reverb send amount (0..1+). */
  setReverb(amount) {
    if (!this.send) return;
    const now = this.ctx.currentTime;
    holdParam(this.send.gain, now);
    rampTo(this.send.gain, clamp(fin(amount), 0, 4), now + 0.03);
  }

  /** Fade out and schedule release. Safe to call multiple times. */
  stop(fade = 0.04, token = -1) {
    if (!this.active) return;
    if (token >= 0 && token !== this.token) return;   // stale handle
    const now = this.ctx.currentTime;
    const f = Math.max(0.004, fin(fade, 0.04));
    holdParam(this.gain.gain, now);
    rampTo(this.gain.gain, 0.0001, now + f);
    this.endTime = Math.min(this.endTime || Infinity, now + f + 0.01);
    this.persistent = false;
  }

  /** Immediate teardown. Called by the pool. */
  _release() {
    if (this.onRelease) { try { this.onRelease(this); } catch { /* ignore */ } }
    this.onRelease = null;
    this.onTick = null;
    this.userData = null;

    for (let i = 0; i < this.nodes.length; i++) kill(this.nodes[i]);
    this.nodes.length = 0;

    for (let i = 0; i < this._rateCount; i++) this._rateParams[i] = null;
    this._rateCount = 0;

    const now = this.ctx.currentTime;
    try { this.gain.gain.cancelScheduledValues(now); } catch { /* ignore */ }
    this.gain.gain.value = 0;
    try { this.gain.disconnect(); } catch { /* ignore */ }
    if (this.panner) { try { this.panner.disconnect(); } catch { /* ignore */ } }
    if (this.send) {
      try { this.send.gain.cancelScheduledValues(now); } catch { /* ignore */ }
      this.send.gain.value = 0;
      try { this.send.disconnect(); } catch { /* ignore */ }
    }

    this.active = false;
    this.persistent = false;
    this.spatial = false;
    this.doppler = 1;
    this.distance = 0;
    this.name = '';
    this.priority = 0;
  }
}

/**
 * A stable handle for sustained voices (engine layers, scrapes, ambience …).
 * Survives the voice being stolen: every method is a no-op afterwards.
 */
export class LoopHandle {
  constructor(voice) {
    this.voice = voice;
    this.token = voice ? voice.token : -1;
  }
  get alive() { return !!this.voice && this.voice.active && this.voice.token === this.token; }
  setVolume(v, s) { if (this.alive) this.voice.setVolume(v, s); return this; }
  setPosition(x, y, z) { if (this.alive) this.voice.setPosition(x, y, z); return this; }
  setVelocity(x, y, z) { if (this.alive) this.voice.setVelocity(x, y, z); return this; }
  setReverb(a) { if (this.alive) this.voice.setReverb(a); return this; }
  /** Set an arbitrary AudioParam on this voice's synth (see `voice.userData`). */
  param(name, value, tau = 0.05) {
    if (!this.alive) return this;
    const map = this.voice.userData;
    const p = map && map.params ? map.params[name] : null;
    if (p) targetTo(p, value, this.voice.ctx.currentTime, tau);
    return this;
  }
  stop(fade = 0.08) { if (this.alive) this.voice.stop(fade, this.token); this.voice = null; return this; }
}

export class VoicePool {
  /**
   * @param {BaseAudioContext} ctx
   * @param {{max?:number, panningModel?:string}} [opts]
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.max = Math.max(4, opts.max ?? CONFIG.audio.maxVoices ?? 48);
    this.panningModel = opts.panningModel ?? 'equalpower';

    /** @type {Voice[]} */
    this.voices = [];
    /** @type {Voice[]} */
    this.free = [];
    /** @type {Voice[]} */
    this.busy = [];

    // Buses — assigned by AudioSystem.
    this.buses = { sfx: null, engine: null, music: null, ui: null };
    this.reverbIn = null;

    this._tokenSeq = 1;
    this._stolen = 0;
    this._started = 0;

    /** Doppler shaping. Real doppler at 1:10 scale is inaudible, so the effective
     *  speed of sound is scaled down; `CONFIG.audio.dopplerFactor` then scales
     *  the resulting shift. 6 ≈ "reads as a fast RC car going past". */
    this.dopplerScale = 6;
    this.dopplerMin = 0.72;
    this.dopplerMax = 1.42;

    // Pre-create the pool so the first race does not allocate 48 nodes at once.
    for (let i = 0; i < this.max; i++) {
      const v = new Voice(this, i);
      this.voices.push(v);
      this.free.push(v);
    }
  }

  setBuses(buses, reverbIn) {
    Object.assign(this.buses, buses);
    this.reverbIn = reverbIn ?? null;
  }

  /** Resolve a bus name to a node, defaulting to sfx. */
  _bus(name) {
    return this.buses[name] || this.buses.sfx || null;
  }

  /**
   * Acquire a voice.
   * @param {{name?:string, bus?:string, priority?:number, spatial?:boolean,
   *          duration?:number, persistent?:boolean, volume?:number,
   *          position?:{x:number,y:number,z:number}|number[],
   *          velocity?:{x:number,y:number,z:number}|number[],
   *          reverb?:number, refDistance?:number, maxDistance?:number,
   *          rolloff?:number, panningModel?:string}} o
   * @returns {Voice|null}
   */
  acquire(o = {}) {
    const bus = this._bus(o.bus);
    if (!bus) return null;

    let v = this.free.pop();
    if (!v) v = this._steal(o.priority ?? 0.5);
    if (!v) return null;

    const now = this.ctx.currentTime;
    v.active = true;
    v.token = this._tokenSeq++;
    v.name = o.name || '';
    v.priority = fin(o.priority, 0.5);
    v.startTime = now;
    v.persistent = !!o.persistent;
    v.endTime = o.persistent ? Infinity : now + Math.max(0.02, fin(o.duration, 1.0));
    v.volume = clamp(fin(o.volume, 1), 0, 8);
    v.spatial = !!o.spatial;
    v.doppler = 1;
    v.distance = 0;
    v.onRelease = null;
    v.onTick = null;
    v.userData = null;

    // Reset the gain stage. Synths ramp it up themselves; loops get it set here.
    try { v.gain.gain.cancelScheduledValues(now); } catch { /* ignore */ }
    v.gain.gain.value = v.volume;

    // Routing
    if (v.spatial) {
      if (!v.panner) v.panner = this._makePanner(o);
      else this._configurePanner(v.panner, o);
      if (v.panner) {
        try { v.gain.connect(v.panner); v.panner.connect(bus); } catch { /* ignore */ }
      } else {
        v.spatial = false;
        try { v.gain.connect(bus); } catch { /* ignore */ }
      }
    } else {
      try { v.gain.connect(bus); } catch { /* ignore */ }
    }

    const rev = fin(o.reverb, 0);
    if (rev > 0 && this.reverbIn) {
      if (!v.send) { try { v.send = this.ctx.createGain(); } catch { v.send = null; } }
      if (v.send) {
        v.send.gain.value = clamp(rev, 0, 4);
        try { v.gain.connect(v.send); v.send.connect(this.reverbIn); } catch { /* ignore */ }
      }
    }

    if (o.position) {
      const p = o.position;
      v.setPosition(p.x ?? p[0] ?? 0, p.y ?? p[1] ?? 0, p.z ?? p[2] ?? 0);
      // Snap (no glide) on acquire so the sound starts in the right place.
      if (v.panner && v.panner.positionX) {
        try {
          v.panner.positionX.cancelScheduledValues(now);
          v.panner.positionY.cancelScheduledValues(now);
          v.panner.positionZ.cancelScheduledValues(now);
          v.panner.positionX.value = v.px;
          v.panner.positionY.value = v.py;
          v.panner.positionZ.value = v.pz;
        } catch { /* ignore */ }
      }
    }
    if (o.velocity) {
      const q = o.velocity;
      v.setVelocity(q.x ?? q[0] ?? 0, q.y ?? q[1] ?? 0, q.z ?? q[2] ?? 0);
    }

    this.busy.push(v);
    this._started++;
    return v;
  }

  _makePanner(o) {
    try {
      const p = this.ctx.createPanner();
      this._configurePanner(p, o);
      return p;
    } catch { return null; }
  }

  _configurePanner(p, o) {
    const a = CONFIG.audio;
    try {
      p.panningModel = o.panningModel || this.panningModel;
      p.distanceModel = 'inverse';
      p.refDistance = Math.max(0.05, fin(o.refDistance, a.refDistance ?? 1.2));
      p.maxDistance = Math.max(p.refDistance + 0.1, fin(o.maxDistance, a.maxDistance ?? 45));
      p.rolloffFactor = Math.max(0, fin(o.rolloff, a.rolloff ?? 1.4));
      p.coneInnerAngle = 360;
      p.coneOuterAngle = 360;
      p.coneOuterGain = 1;
    } catch { /* ignore */ }
  }

  /**
   * Steal the least valuable busy voice.
   * Ranking: non-persistent before persistent, then lowest priority, then oldest.
   */
  _steal(incomingPriority) {
    let best = -1, bestScore = Infinity;
    const now = this.ctx.currentTime;
    for (let i = 0; i < this.busy.length; i++) {
      const v = this.busy[i];
      // score: lower = better candidate for stealing
      let score = v.priority * 100;
      if (v.persistent) score += 400;
      score -= Math.min(60, (now - v.startTime) * 8);   // older = cheaper to kill
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return null;
    const victim = this.busy[best];
    // Never steal something notably more important than the incoming sound.
    if (victim.priority > incomingPriority + 0.35 && victim.persistent) return null;
    this.busy.splice(best, 1);
    victim._release();
    this._stolen++;
    return victim;
  }

  /** Force-release a voice now. */
  release(v) {
    if (!v || !v.active) return;
    const i = this.busy.indexOf(v);
    if (i >= 0) this.busy.splice(i, 1);
    v._release();
    this.free.push(v);
  }

  /**
   * Per-frame maintenance: expire finished voices, refresh spatial position and
   * recompute doppler. Allocation free.
   * @param {{x:number,y:number,z:number,vx:number,vy:number,vz:number}} listener
   */
  update(listener) {
    const now = this.ctx.currentTime;
    const a = CONFIG.audio;
    const c = Math.max(1, (a.speedOfSound ?? 343) / Math.max(0.001, this.dopplerScale));
    const df = clamp(fin(a.dopplerFactor, 0.6), 0, 4);

    for (let i = this.busy.length - 1; i >= 0; i--) {
      const v = this.busy[i];

      if (!v.active || now >= v.endTime) {
        this.busy.splice(i, 1);
        v._release();
        this.free.push(v);
        continue;
      }

      if (v.onTick) { try { v.onTick(v, now); } catch { /* ignore */ } }

      if (!v.spatial || !listener) continue;

      // Distance (for tiering / air absorption consumers).
      const dx = v.px - listener.x, dy = v.py - listener.y, dz = v.pz - listener.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      v.distance = dist;

      if (v._rateCount === 0 || df <= 0) continue;

      // Unit vector source → listener.
      if (dist > 1e-4) { _dir[0] = -dx / dist; _dir[1] = -dy / dist; _dir[2] = -dz / dist; }
      else { _dir[0] = 0; _dir[1] = 0; _dir[2] = 0; }

      const lp = listener.vx * _dir[0] + listener.vy * _dir[1] + listener.vz * _dir[2];
      const sp = v.vx * _dir[0] + v.vy * _dir[1] + v.vz * _dir[2];
      const cap = c / Math.max(0.0001, df);
      const lpc = Math.min(lp, cap * 0.9);
      const spc = Math.min(sp, cap * 0.9);
      let shift = (c - df * lpc) / Math.max(0.01, c - df * spc);
      shift = clamp(shift, this.dopplerMin, this.dopplerMax);
      v.doppler = shift;

      for (let k = 0; k < v._rateCount; k++) {
        const p = v._rateParams[k];
        if (!p) continue;
        if (v._rateMode[k] === 1) targetTo(p, 1200 * Math.log2(shift), now, 0.05);
        else targetTo(p, v._rateBase[k] * shift, now, 0.05);
      }
    }
  }

  /** Fade and release everything (except optionally persistent voices). */
  stopAll(fade = 0.08, includePersistent = true) {
    for (let i = this.busy.length - 1; i >= 0; i--) {
      const v = this.busy[i];
      if (!includePersistent && v.persistent) continue;
      v.stop(fade);
    }
  }

  /** Hard teardown — used on dispose(). */
  killAll() {
    for (let i = this.busy.length - 1; i >= 0; i--) {
      const v = this.busy[i];
      v._release();
      this.free.push(v);
    }
    this.busy.length = 0;
  }

  stats() {
    return {
      active: this.busy.length,
      free: this.free.length,
      max: this.max,
      started: this._started,
      stolen: this._stolen,
    };
  }

  dispose() {
    this.killAll();
    for (const v of this.voices) {
      kill(v.gain); kill(v.panner); kill(v.send);
    }
    this.voices.length = 0;
    this.free.length = 0;
  }
}

export default VoicePool;
