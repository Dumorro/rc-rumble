/**
 * src/audio/AudioSystem.js — `game.audio`.
 *
 * Owns the whole WebAudio graph and every sound-producing subsystem:
 *
 *   destination
 *     └── masterOut (masterVolume, mute)
 *           └── safety soft-clipper
 *                 └── limiter (DynamicsCompressor)
 *                       └── Listener muffle stage (tunnel / underwater lowpass)
 *                             └── masterIn
 *                                   ├── musicIn  → musicGain   (MusicSystem)
 *                                   ├── sfxIn    → sfxGain     (SFXSynth, tires)
 *                                   ├── engineIn → HP → peak → engineGain
 *                                   ├── uiIn     → uiGain
 *                                   └── reverbReturn ← Reverb (per-track IR)
 *
 * Design commitments
 * ──────────────────
 * · **Boots without audio.** No `AudioContext`, a blocked context, a failed node
 *   — every path degrades to a no-op. The game never notices.
 * · **Created suspended, unlocked on a gesture.** `unlock()` is exposed for the UI
 *   to call from a click handler; as a safety net we also listen for the first
 *   pointer/key event ourselves and unlock there.
 * · **Everything is wired to the EventBus.** A gameplay/FX agent gets collision,
 *   landing, pickup, weapon, lap and countdown audio for free; `play()` /
 *   `loop()` are there when they want explicit control.
 * · **No allocation in update().** Per-car engine/tire objects are created on race
 *   start; the per-frame path only writes AudioParams.
 * · CONFIG.audio volumes are re-read every frame, so tweaking them from the
 *   console (or a settings menu) takes effect immediately.
 */

import CONFIG from '../core/Config.js';
import { RNG, clamp, clamp01, damp, lerp } from '../core/MathUtils.js';
import {
  fin, createResources, gain, filter, osc, shaper,
  holdParam, rampTo, targetTo, kill,
} from './DSP.js';
import { VoicePool } from './VoicePool.js';
import { Listener } from './Listener.js';
import { Reverb, resolveReverbName } from './Reverb.js';
import { SFXSynth, RECIPES, AMBIENCE, resolveAmbience, landRecipe, weaponFamily } from './SFXSynth.js';
import { EngineSynth } from './EngineSynth.js';
import { TireAudio } from './TireAudio.js';
import { MusicSystem } from './MusicSystem.js';

/** Scratch position holder passed to `play()` — avoids allocating per event. */
const _p = { x: 0, y: 0, z: 0 };
const _v = { x: 0, y: 0, z: 0 };

export class AudioSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.ready = false;
    this.available = false;
    this.unlocked = false;
    this.muted = false;
    this.panningModel = 'equalpower';

    /** @type {AudioContext|null} */
    this.ctx = null;
    this.res = null;
    /** @type {VoicePool|null} */
    this.pool = null;
    /** @type {Listener|null} */
    this.listener = null;
    /** @type {Reverb|null} */
    this.reverb = null;
    /** @type {SFXSynth|null} */
    this.sfx = null;
    /** @type {MusicSystem|null} */
    this.music = null;

    this.buses = { music: null, sfx: null, engine: null, ui: null };

    /** @type {Map<number, EngineSynth>} */
    this.engines = new Map();
    /** @type {Map<number, TireAudio>} */
    this.tires = new Map();
    /** @type {Map<number, {handle:object, level:number, surfaceId:number}>} */
    this._scrapes = new Map();
    /** @type {Map<string, object>} */
    this._loops = new Map();

    this.rng = new RNG((CONFIG.seed ?? 1) ^ 0xa0d10);
    this.pitchScale = 1;                 // slow-mo pitch (engines + music tone)
    this.ambienceId = null;
    this._ambience = null;
    this._ambEvents = [];
    this._reverbName = 'room';

    this._carsRef = null;
    this._carCount = -1;
    this._syncTimer = 0;
    this._applied = { master: -1, music: -1, sfx: -1, engine: -1 };
    this._volSfx = clamp(fin(CONFIG.audio.sfxVolume, 0.9), 0, 2);
    this._volEngine = clamp(fin(CONFIG.audio.engineVolume, 0.7), 0, 2);
    this._duck = 1;
    this._duckTarget = 1;
    this._unsub = [];
    this._gestureHandler = null;
    this._keyHandler = null;
    this._visibilityHandler = null;
    this._pendingIntent = null;
    this._musicIntensity = 0;
    this._lastLapAnnounced = -1;
    this._warmed = false;
    this.stats_ = {
      voices: 0, engines: 0, ms: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════ lifecycle

  async init() {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) {
      console.warn('[Audio] WebAudio unavailable — running silent.');
      return;
    }
    try {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      console.warn('[Audio] could not create AudioContext:', err);
      return;
    }
    this.available = true;

    // High-quality HRTF is lovely but costs ~4× per panner; only at ultra.
    this.panningModel = CONFIG.quality === 'ultra' ? 'HRTF' : 'equalpower';

    try {
      this.res = createResources(this.ctx, (CONFIG.seed ?? 1) ^ 0x5c1a2b);
      this._buildGraph();
      this.pool = new VoicePool(this.ctx, {
        max: CONFIG.audio.maxVoices ?? 48,
        panningModel: this.panningModel,
      });
      this.pool.setBuses(this.buses, this.reverb?.input ?? null);
      this.sfx = new SFXSynth(this);
      this.music = new MusicSystem(this);
      this.ready = true;
    } catch (err) {
      console.warn('[Audio] init failed — running silent:', err);
      this.ready = false;
      return;
    }

    this.applyConfigVolumes(true);
    this._installGestureUnlock();
    this._installKeyBindings();
    this._installVisibility();
    this._wireEvents();

    // A short IR is cheap; the long ones are rendered after the first unlock.
    this.reverb?.warm(['room']);
    this.reverb?.setPreset('room', 0.01);

    if (this.ctx.state === 'running') { this.unlocked = true; this._onUnlocked(); }
    if (CONFIG.debug) console.info(`[Audio] ready (${this.ctx.sampleRate} Hz, state=${this.ctx.state})`);
  }

  /**
   * Resume the AudioContext. MUST be called from a user gesture on most browsers.
   * Safe to call repeatedly. The UI should call this from its first click handler.
   * @returns {Promise<boolean>} whether audio is now running
   */
  async unlock() {
    if (!this.available || !this.ctx) return false;
    if (this.ctx.state === 'running') {
      if (!this.unlocked) { this.unlocked = true; this._onUnlocked(); }
      return true;
    }
    try { await this.ctx.resume(); } catch { /* ignore */ }
    // Safari sometimes needs a silent tick to actually start.
    if (this.ctx.state !== 'running') {
      try {
        const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        const s = this.ctx.createBufferSource();
        s.buffer = b; s.connect(this.ctx.destination); s.start(0);
      } catch { /* ignore */ }
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
    const ok = this.ctx.state === 'running';
    if (ok && !this.unlocked) { this.unlocked = true; this._onUnlocked(); }
    return ok;
  }

  _onUnlocked() {
    this._removeGestureUnlock();
    if (!this._warmed) {
      this._warmed = true;
      // Render the long IRs off the critical path.
      const warm = () => { try { this.reverb?.warm(['museum', 'garden', 'supermarket', 'garage']); } catch { /* ignore */ } };
      if (globalThis.requestIdleCallback) globalThis.requestIdleCallback(warm, { timeout: 1500 });
      else setTimeout(warm, 60);
    }
    // Anything requested while we were locked now happens for real.
    if (this._pendingIntent) {
      this.music?.setIntent(this._pendingIntent.intent, this._pendingIntent.opts);
      this._pendingIntent = null;
    }
    if (this.ambienceId && !this._ambience) {
      this.setAmbience(this.ambienceId, 1.2, { applyReverb: this._ambApplyReverb !== false });
    }
    if (CONFIG.debug) console.info('[Audio] unlocked');
  }

  _buildGraph() {
    const ctx = this.ctx;

    this.masterOut = gain(ctx, 0.0001);
    this.clip = shaper(ctx, this.res.curves.soft, '2x');
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -7;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.0035;
    this.limiter.release.value = 0.13;

    this.listener = new Listener(ctx, this.game);
    this.masterIn = gain(ctx, 1);

    // masterIn → muffle → limiter → clipper → masterOut → destination
    if (this.listener.ready) {
      this.masterIn.connect(this.listener.input);
      this.listener.output.connect(this.limiter);
    } else {
      this.masterIn.connect(this.limiter);
    }
    this.limiter.connect(this.clip || this.masterOut);
    if (this.clip) this.clip.connect(this.masterOut);
    this.masterOut.connect(ctx.destination);

    // ── reverb ──
    this.reverb = new Reverb(ctx, { quality: CONFIG.quality, seed: CONFIG.seed });
    this.reverbReturn = gain(ctx, 1);
    if (this.reverb.ready) {
      this.reverb.output.connect(this.reverbReturn);
      this.reverbReturn.connect(this.masterIn);
    }

    // ── buses ──
    this.musicIn = gain(ctx, 1);
    this.musicGain = gain(ctx, 0.5);
    this.musicIn.connect(this.musicGain);
    this.musicGain.connect(this.masterIn);

    this.sfxIn = gain(ctx, 1);
    this.sfxGain = gain(ctx, 0.9);
    this.sfxIn.connect(this.sfxGain);
    this.sfxGain.connect(this.masterIn);

    // Engine bus gets shared EQ + saturation so eight cars glue into one pack
    // instead of eight separate buzzes.
    this.engineIn = gain(ctx, 1);
    this.engineHP = filter(ctx, 'highpass', 62, 0.7);
    this.enginePeak = filter(ctx, 'peaking', 2400, 1.1, 2.5);
    this.engineLowShelf = filter(ctx, 'lowshelf', 150, 0.7, 1.5);
    this.engineGain = gain(ctx, 0.7);
    this.engineIn.connect(this.engineHP);
    this.engineHP.connect(this.enginePeak);
    this.enginePeak.connect(this.engineLowShelf);
    this.engineLowShelf.connect(this.engineGain);
    this.engineGain.connect(this.masterIn);

    this.uiIn = gain(ctx, 1);
    this.uiGain = gain(ctx, 0.8);
    this.uiIn.connect(this.uiGain);
    this.uiGain.connect(this.masterIn);

    this.buses.music = this.musicIn;
    this.buses.sfx = this.sfxIn;
    this.buses.engine = this.engineIn;
    this.buses.ui = this.uiIn;

    // Shared 17 Hz LFO used by every engine's rev limiter (one node, 8 users).
    this.limiterLfo = osc(ctx, { type: 'square', freq: 17 });
  }

  // ═══════════════════════════════════════════════════════ race lifecycle

  onRaceStart(ctx) {
    if (!this.ready) return;
    const track = ctx?.track ?? this.game.track;
    this.listener?.resetMotion();

    // ── room + ambience from TrackData.audio / environment / id ──
    const ta = track?.audio ?? {};
    const revName = ta.reverb?.preset ?? ta.reverb?.name ?? ta.reverbId
      ?? (typeof ta.reverb === 'string' ? ta.reverb : null)
      ?? track?.environment?.skybox ?? track?.id;
    const hasExplicitRoom = !!revName;
    this.setReverb(revName, 0.6, ta.reverb && typeof ta.reverb === 'object' ? ta.reverb.wet : undefined);

    const ambId = ta.ambienceId ?? ta.ambience ?? track?.id ?? 'default';
    this.setAmbience(ambId, 1.6, { applyReverb: !hasExplicitRoom });

    this._syncCars(true);
    this._lastLapAnnounced = -1;
    this._musicIntensity = 0.25;
    this.setMusicIntent('race');
    this.setDuck(1, 0.4);
  }

  onRaceEnd() {
    if (!this.ready) return;
    for (const e of this.engines.values()) e.dispose();
    for (const t of this.tires.values()) t.dispose();
    this.engines.clear();
    this.tires.clear();
    for (const s of this._scrapes.values()) s.handle?.stop?.(0.1);
    this._scrapes.clear();
    this.stopLoop('boost');
    this.stopLoop('pickupRoll');
    this._carsRef = null;
    this._carCount = -1;
    this.pool?.stopAll(0.15, false);
  }

  /** Create/destroy per-car voices to match `game.cars`. */
  _syncCars(force = false) {
    const cars = this.game?.cars;
    if (!Array.isArray(cars)) return;
    if (!force && cars === this._carsRef && cars.length === this._carCount) return;
    this._carsRef = cars;
    this._carCount = cars.length;

    const seen = new Set();
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car) continue;
      const id = car.id ?? i;
      seen.add(id);
      let e = this.engines.get(id);
      if (!e || e.car !== car) {
        e?.dispose();
        e = new EngineSynth(this, car, i);
        this.engines.set(id, e);
      }
      let t = this.tires.get(id);
      if (!t || t.car !== car) {
        t?.dispose();
        t = new TireAudio(this, car, i);
        this.tires.set(id, t);
      }
    }
    for (const [id, e] of this.engines) if (!seen.has(id)) { e.dispose(); this.engines.delete(id); }
    for (const [id, t] of this.tires) if (!seen.has(id)) { t.dispose(); this.tires.delete(id); }
  }

  // ═══════════════════════════════════════════════════════════════ frame

  /**
   * @param {number} dt simulated seconds (0 when paused)
   * @param {number} alpha
   * @param {number} rawDt wall-clock seconds
   */
  update(dt, alpha, rawDt) {
    if (!this.ready || !this.ctx) return;
    const t0 = CONFIG.debug ? (globalThis.performance?.now?.() ?? 0) : 0;
    const rd = clamp(fin(rawDt, fin(dt, 0.016)), 0.0001, 0.1);

    this.applyConfigVolumes(false);

    // Slow-mo → global pitch scale (engines) and a darker music tone.
    const ts = clamp(fin(this.game?.loop?.timeScale, 1), 0.15, 2);
    this.pitchScale = damp(this.pitchScale, lerp(0.72, 1, clamp01(ts)), 8, rd);

    // Duck (pause / menus / cinematics).
    this._duck = damp(this._duck, this._duckTarget, 5, rd);
    if (this.sfxGain) targetTo(this.sfxGain.gain, this._volSfx * this._duck, this.ctx.currentTime, 0.08);
    if (this.engineGain) targetTo(this.engineGain.gain, this._volEngine * this._duck, this.ctx.currentTime, 0.08);

    this.listener?.update(rd);
    this._syncCars(false);

    // ── per-car voices ──
    const cars = this.game?.cars;
    if (Array.isArray(cars)) {
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i];
        if (!car) continue;
        const id = car.id ?? i;
        this.engines.get(id)?.update(rd, car);
        this.tires.get(id)?.update(rd, car);
      }
    }

    this._updateScrapes(rd);
    this._updateAmbience(rd);
    this._updateMusicIntensity(rd);
    this.music?.update(rd);
    this.pool?.update(this.listener);

    if (CONFIG.debug) {
      this.stats_.ms = (globalThis.performance?.now?.() ?? 0) - t0;
      this.stats_.voices = this.pool?.busy.length ?? 0;
      this.stats_.engines = this.engines.size;
    }
  }

  // ═══════════════════════════════════════════════════════════ volumes

  /** Re-read CONFIG.audio and apply. Called automatically every frame. */
  applyConfigVolumes(immediate = false) {
    if (!this.ready) return;
    const a = CONFIG.audio;
    const now = this.ctx.currentTime;
    const seconds = immediate ? 0.005 : 0.08;

    const master = this.muted ? 0 : clamp(fin(a.masterVolume, 0.85), 0, 2);
    this._volSfx = clamp(fin(a.sfxVolume, 0.9), 0, 2);
    this._volEngine = clamp(fin(a.engineVolume, 0.7), 0, 2);
    const musicV = clamp(fin(a.musicVolume, 0.45), 0, 2);

    if (master !== this._applied.master) {
      this._applied.master = master;
      holdParam(this.masterOut.gain, now);
      rampTo(this.masterOut.gain, Math.max(0.0001, master), now + seconds);
    }
    if (musicV !== this._applied.music) {
      this._applied.music = musicV;
      holdParam(this.musicGain.gain, now);
      rampTo(this.musicGain.gain, Math.max(0.0001, musicV), now + seconds * 3);
    }
    if (this._volSfx !== this._applied.sfx) {
      this._applied.sfx = this._volSfx;
      holdParam(this.uiGain.gain, now);
      rampTo(this.uiGain.gain, Math.max(0.0001, this._volSfx * 0.85), now + seconds);
      if (this.reverbReturn) {
        holdParam(this.reverbReturn.gain, now);
        rampTo(this.reverbReturn.gain, Math.max(0.0001, 0.5 + 0.5 * this._volSfx), now + seconds);
      }
    }
    if (this._volEngine !== this._applied.engine) this._applied.engine = this._volEngine;

    if (this.pool) this.pool.max = Math.max(4, fin(a.maxVoices, 48));
  }

  setMasterVolume(v) { CONFIG.audio.masterVolume = clamp(fin(v, 0.85), 0, 2); this.applyConfigVolumes(true); }
  setMusicVolume(v) { CONFIG.audio.musicVolume = clamp(fin(v, 0.45), 0, 2); this.applyConfigVolumes(true); }
  setSfxVolume(v) { CONFIG.audio.sfxVolume = clamp(fin(v, 0.9), 0, 2); this.applyConfigVolumes(true); }
  setEngineVolume(v) { CONFIG.audio.engineVolume = clamp(fin(v, 0.7), 0, 2); this.applyConfigVolumes(true); }

  setMuted(m) {
    const next = !!m;
    if (next === this.muted) return this.muted;
    this.muted = next;
    this.applyConfigVolumes(false);
    this.game?.bus?.emit('audio:mute', { muted: this.muted });
    return this.muted;
  }

  toggleMute() { return this.setMuted(!this.muted); }

  /** 1 = normal, < 1 ducks SFX + engines (music has its own duck). */
  setDuck(amount, seconds = 0.25) {
    this._duckTarget = clamp(fin(amount, 1), 0, 1);
    if (seconds <= 0.01) this._duck = this._duckTarget;
  }

  // ═══════════════════════════════════════════════════════════ playback

  /**
   * Play a synthesized one-shot.
   * @param {string} name see SFXSynth.RECIPES
   * @param {object} [opts] { position, velocity, volume, delay, impulse, surfaceId, ... }
   */
  play(name, opts) {
    if (!this.ready || !this.sfx) return null;
    return this.sfx.play(name, opts);
  }

  /** Convenience: `playAt('impact/metal', worldPointVector3, { impulse })`. */
  playAt(name, position, opts = {}) {
    if (!this.ready || !this.sfx) return null;
    if (position) {
      _p.x = fin(position.x); _p.y = fin(position.y); _p.z = fin(position.z);
      opts.position = _p;
    }
    return this.sfx.play(name, opts);
  }

  /** Start a sustained sound. Returns a LoopHandle (or null). */
  loop(name, opts) {
    if (!this.ready || !this.sfx) return null;
    return this.sfx.loop(name, opts);
  }

  /**
   * Named singleton loop — calling it twice with the same key reuses the voice.
   * Used for boost, bomb fuses, the pickup roulette…
   */
  startLoop(key, name, opts) {
    if (!this.ready) return null;
    const existing = this._loops.get(key);
    if (existing && existing.alive) return existing;
    const h = this.loop(name, opts);
    if (h) this._loops.set(key, h);
    return h;
  }

  stopLoop(key, fade = 0.12) {
    const h = this._loops.get(key);
    if (h) { h.stop(fade); this._loops.delete(key); }
  }

  getLoop(key) {
    const h = this._loops.get(key);
    return h && h.alive ? h : null;
  }

  /** Fire a weapon sound by id. `phase` = 'fire' | 'hit'. */
  playWeapon(weaponId, phase = 'fire', opts) {
    if (!this.ready || !this.sfx) return null;
    return this.sfx.playWeapon(weaponId, phase, opts);
  }

  /** Impulse-scaled collision sound. */
  impact(opts) {
    if (!this.ready || !this.sfx) return null;
    return this.sfx.impact(opts);
  }

  stopAll(fade = 0.15) {
    this.pool?.stopAll(fade, true);
    for (const [k] of this._loops) this.stopLoop(k, fade);
  }

  // ═══════════════════════════════════════════════════════════ music API

  /** @param {'menu'|'race'|'finalLap'|'victory'|'none'} intent */
  setMusicIntent(intent, opts) {
    if (!this.ready || !this.music) return;
    if (!this.unlocked) { this._pendingIntent = { intent, opts }; return; }
    this.music.setIntent(intent, opts);
  }

  setMusicIntensity(v) { this.music?.setIntensity(v); }

  _updateMusicIntensity(dt) {
    if (!this.music) return;
    const game = this.game;
    const car = game?.playerCar;
    let target = this._musicIntensity;

    if (game?.state === 'menu' || game?.state === 'boot' || game?.state === 'loading') {
      target = 0.25;
    } else if (car) {
      const laps = fin(game.raceConfig?.laps, 3);
      const finalLap = fin(car.lap, 0) >= laps - 1;
      const speedN = clamp01(Math.abs(fin(car.speed, 0)) / Math.max(2, fin(car.def?.topSpeed, 9)));

      // How close is the nearest rival, by race progress?
      let closest = 99;
      const cars = game.cars;
      if (Array.isArray(cars)) {
        const mine = fin(car.progress, 0);
        for (let i = 0; i < cars.length; i++) {
          const o = cars[i];
          if (!o || o === car) continue;
          const d = Math.abs(fin(o.progress, 0) - mine);
          if (d < closest) closest = d;
        }
      }
      const battle = closest < 0.05 ? 1 - closest / 0.05 : 0;

      target = clamp01(0.30
        + 0.26 * battle
        + 0.22 * speedN
        + (finalLap ? 0.22 : 0)
        + (fin(car.place, 1) <= 2 ? 0.08 : 0));
    }
    this._musicIntensity = damp(this._musicIntensity, target, 0.8, dt);
    this.music.setIntensity(this._musicIntensity);
  }

  // ═══════════════════════════════════════════════════════ reverb + ambience

  /**
   * Switch the convolution room.
   * @param {string|object} nameOrDesc 'museum'|'garden'|'supermarket'|'room'|'garage'|'cavern'|'none'
   */
  setReverb(nameOrDesc, fade = 0.7, wet = undefined) {
    if (!this.reverb) return;
    const name = typeof nameOrDesc === 'string' || !nameOrDesc
      ? resolveReverbName(nameOrDesc) : nameOrDesc;
    this._reverbName = typeof name === 'string' ? name : 'custom';
    this.reverb.setPreset(name, fade, wet);
  }

  /**
   * Switch the ambience bed (and its scheduled one-shot events).
   * @param {string} id track id / environment name — aliased generously
   */
  setAmbience(id, fade = 1.2, o = {}) {
    const key = resolveAmbience(id);
    this.ambienceId = key;
    this._ambApplyReverb = o.applyReverb !== false;
    if (!this.ready) return;
    if (!this.unlocked) return;             // will be started by _onUnlocked
    const def = AMBIENCE[key] ?? AMBIENCE.default;

    if (this._ambience) { this._ambience.stop(fade); this._ambience = null; }
    const h = this.loop(def.bed, { volume: 0.0001, priority: 0.98 });
    if (h) {
      h.setVolume(1, fade);
      this._ambience = h;
    }
    // Reset the event timers with a randomised first fire so nothing lands at t=0.
    this._ambEvents.length = 0;
    const evs = def.events ?? [];
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      this._ambEvents.push({
        name: e.name, per: Math.max(0.4, fin(e.per, 8)), spread: fin(e.spread, 0),
        volume: fin(e.volume, 1),
        timer: fin(e.per, 8) * (0.25 + this.rng.next() * 0.9),
      });
    }
    if (this._ambApplyReverb && def.reverb) this.setReverb(def.reverb, fade);
  }

  _updateAmbience(dt) {
    if (!this._ambEvents.length) return;
    const L = this.listener;
    for (let i = 0; i < this._ambEvents.length; i++) {
      const e = this._ambEvents[i];
      e.timer -= dt;
      if (e.timer > 0) continue;
      e.timer = e.per * (0.55 + this.rng.next() * 1.1);
      if (e.spread > 0 && L) {
        const a = this.rng.next() * Math.PI * 2;
        const r = e.spread * (0.35 + this.rng.next() * 0.65);
        _p.x = L.x + Math.cos(a) * r;
        _p.y = L.y + (this.rng.next() - 0.3) * 2.5;
        _p.z = L.z + Math.sin(a) * r;
        this.play(e.name, { position: _p, volume: e.volume, priority: 0.2 });
      } else {
        this.play(e.name, { volume: e.volume, priority: 0.2 });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════ scrapes

  /**
   * Sustained grinding. Bumped by low-relative-speed collisions and decayed
   * every frame, so a car sliding along a wall keeps a continuous scrape while a
   * single bump only produces its impact one-shot.
   */
  bumpScrape(carId, amount, surfaceId = 0) {
    let s = this._scrapes.get(carId);
    if (!s) { s = { handle: null, level: 0, surfaceId: 0 }; this._scrapes.set(carId, s); }
    s.level = clamp01(s.level + clamp01(amount));
    s.surfaceId = surfaceId | 0;
  }

  _updateScrapes(dt) {
    if (!this._scrapes.size) return;
    let active = 0;
    for (const [id, s] of this._scrapes) {
      s.level = Math.max(0, s.level - dt * 3.2);
      const car = this._carById(id);
      const wantSound = s.level > 0.06 && car && active < 3;
      if (!wantSound) {
        if (s.handle) { s.handle.stop(0.12); s.handle = null; }
        if (s.level <= 0.001) this._scrapes.delete(id);
        continue;
      }
      active++;
      const p = car.group?.position ?? car.body?.position;
      if (!s.handle || !s.handle.alive) {
        s.handle = this.loop('scrape', {
          position: p, volume: 0.0001, priority: car.isPlayer ? 0.72 : 0.5, intensity: 0,
        });
        if (!s.handle) continue;
      }
      if (p) s.handle.setPosition(fin(p.x), fin(p.y), fin(p.z));
      s.handle.setVolume(clamp01(s.level) * (car.isPlayer ? 1.0 : 0.7), 0.06);
      // Faster + rougher surface = brighter, more resonant scrape.
      const sp = Math.abs(fin(car.speed, 0));
      s.handle.param('freq', clamp(700 + sp * 220 + s.surfaceId * 14, 250, 6000), 0.06);
      s.handle.param('Q', 2.0 + 2.5 * clamp01(sp / 6), 0.08);
      s.handle.param('level', clamp01(s.level) * 0.32, 0.05);
    }
  }

  // ═══════════════════════════════════════════════════════ doppler helpers

  /**
   * Doppler ratio for a moving source, from the current listener velocity.
   * Allocation free. Use for band/frequency shifting of shared-buffer sources.
   */
  dopplerRatio(px, py, pz, vx, vy, vz) {
    const L = this.listener;
    if (!L) return 1;
    const a = CONFIG.audio;
    const df = clamp(fin(a.dopplerFactor, 0.6), 0, 4);
    if (df <= 0) return 1;
    const c = Math.max(1, fin(a.speedOfSound, 343) / (this.pool?.dopplerScale ?? 6));
    let dx = px - L.x, dy = py - L.y, dz = pz - L.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-4) return 1;
    dx = -dx / dist; dy = -dy / dist; dz = -dz / dist;   // source → listener
    const cap = (c / df) * 0.9;
    const lp = Math.min(L.vx * dx + L.vy * dy + L.vz * dz, cap);
    const sp = Math.min(vx * dx + vy * dy + vz * dz, cap);
    const shift = (c - df * lp) / Math.max(0.01, c - df * sp);
    return clamp(shift, 0.72, 1.42);
  }

  /** Same thing, in cents (for `oscillator.detune`). */
  dopplerCents(px, py, pz, vx, vy, vz) {
    const r = this.dopplerRatio(px, py, pz, vx, vy, vz);
    return 1200 * Math.log2(r);
  }

  // ═══════════════════════════════════════════════════════ car accessors

  engineFor(carId) { return this.engines.get(carId) ?? null; }
  tireFor(carId) { return this.tires.get(carId) ?? null; }

  /** Explicitly attach a car (normally handled automatically). */
  attachCar(car) {
    if (!this.ready || !car) return;
    const id = car.id ?? this.engines.size;
    if (!this.engines.has(id)) this.engines.set(id, new EngineSynth(this, car, id));
    if (!this.tires.has(id)) this.tires.set(id, new TireAudio(this, car, id));
  }

  detachCar(carId) {
    this.engines.get(carId)?.dispose();
    this.engines.delete(carId);
    this.tires.get(carId)?.dispose();
    this.tires.delete(carId);
    const s = this._scrapes.get(carId);
    if (s?.handle) s.handle.stop(0.1);
    this._scrapes.delete(carId);
  }

  // ═════════════════════════════════════════════════════ gameplay helpers

  /** Countdown beep. `n` = 3,2,1 (0 triggers the GO horn instead). */
  beep(n) {
    if (n > 0) this.play('race/beep', { freq: 620 + (3 - clamp(n, 1, 3)) * 60, volume: 0.9 });
    else this.go();
  }

  go() {
    this.play('race/go', { volume: 1.0 });
    this.play('crowd/cheer', { volume: 0.55, intensity: 0.7, delay: 0.05 });
  }

  horn(carOrPos = null) {
    const p = carOrPos?.group?.position ?? carOrPos?.position ?? carOrPos;
    return p ? this.playAt('horn', p) : this.play('horn');
  }

  /** Weapon roulette while the pickup decides. */
  startPickupRoll(opts = {}) {
    return this.startLoop('pickupRoll', 'pickup/roll', { rate: 9, pitch: 760, ...opts });
  }

  stopPickupRoll(assign = true) {
    this.stopLoop('pickupRoll', 0.05);
    if (assign) this.play('pickup/assign');
  }

  /** Nitro / turbo thrust for a car. */
  startBoost(car) {
    const p = car?.group?.position ?? car?.position ?? null;
    const key = `boost:${car?.id ?? 0}`;
    const h = this.startLoop(key, 'weapon/turbo', { position: p, level: 1 });
    this.play('weapon/turbo/fire', p ? { position: p } : undefined);
    return h;
  }

  updateBoost(car, level = 1) {
    const h = this.getLoop(`boost:${car?.id ?? 0}`);
    if (!h) return;
    const p = car?.group?.position ?? car?.position ?? null;
    if (p) h.setPosition(fin(p.x), fin(p.y), fin(p.z));
    h.param('level', clamp01(level) * 0.26, 0.06);
  }

  stopBoost(car) { this.stopLoop(`boost:${car?.id ?? 0}`, 0.2); }

  /** Bomb fuse. `rate` = ticks per second; raise it as the timer runs out. */
  startBombTick(id, position, rate = 2) {
    return this.startLoop(`bomb:${id}`, 'bomb/tick', { position, rate });
  }

  updateBombTick(id, position, rate = 2) {
    const h = this.getLoop(`bomb:${id}`);
    if (!h) return;
    if (position) h.setPosition(fin(position.x), fin(position.y), fin(position.z));
    h.param('rate', clamp(rate, 0.5, 24), 0.05);
  }

  stopBombTick(id) { this.stopLoop(`bomb:${id}`, 0.05); }

  /** Held electro stun buzz. */
  startElectro(car) {
    const p = car?.group?.position ?? null;
    return this.startLoop(`electro:${car?.id ?? 0}`, 'electro/hold', { position: p, level: 1 });
  }

  stopElectro(car) { this.stopLoop(`electro:${car?.id ?? 0}`, 0.12); }

  // ═══════════════════════════════════════════════════════ event wiring

  _wireEvents() {
    const bus = this.game?.bus;
    if (!bus) return;
    const on = (name, fn) => this._unsub.push(bus.on(name, fn));

    // ── impacts ────────────────────────────────────────────────────────────
    on('car:collision', (e) => {
      if (!e || !this.ready) return;
      const imp = Math.abs(fin(e.impulse, 0));
      if (imp < 0.3) return;
      const car = this._carById(e.carId);
      const chassis = car?.def?.chassis ?? 'plastic';
      const rel = Math.abs(fin(e.relSpeed, 0));
      const wp = e.worldPoint;
      if (wp) { _p.x = fin(wp.x); _p.y = fin(wp.y); _p.z = fin(wp.z); }

      // A grinding contact (lots of impulse, little closing speed) is a scrape,
      // not a hit — feed the sustained layer instead of machine-gunning clacks.
      if (rel < 1.6 && imp > 0.5) {
        this.bumpScrape(e.carId, 0.10 + imp * 0.05, fin(e.surfaceId, 0));
        if (imp < 2.2) return;
      }
      this.impact({
        chassis, surfaceId: fin(e.surfaceId, 0), impulse: imp,
        position: wp ? _p : null,
        volume: car?.isPlayer ? 1.05 : 0.85,
      });
      if (fin(e.surfaceId, 0) === 11 && rel > 2.5) {
        this.play('spark', { position: wp ? _p : null, volume: 0.6 });
      }
      if (car?.isPlayer && imp > 2.0) {
        this.game?.input?.rumble?.(clamp01(imp / 9), clamp01(imp / 14), 60 + imp * 8);
      }
    });

    on('prop:hit', (e) => {
      if (!e || !this.ready) return;
      const imp = Math.abs(fin(e.impulse, 0));
      if (imp < 0.3) return;
      const wp = e.worldPoint;
      if (wp) { _p.x = fin(wp.x); _p.y = fin(wp.y); _p.z = fin(wp.z); }
      this.impact({
        name: e.other?.material === 'metal' ? 'impact/metal'
          : e.other?.material === 'glass' ? 'impact/glass' : 'impact/prop',
        surfaceId: fin(e.surfaceId, 0), impulse: imp,
        position: wp ? _p : null, volume: 0.85,
      });
    });

    // ── flight ────────────────────────────────────────────────────────────
    on('car:land', (e) => {
      if (!e || !this.ready) return;
      const car = this._carById(e.carId);
      const speed = Math.abs(fin(e.impactSpeed, 3));
      if (speed < 0.6) return;
      const sid = fin(car?.dominantSurfaceId, 0);
      const wp = e.worldPoint ?? car?.group?.position;
      if (wp) { _p.x = fin(wp.x); _p.y = fin(wp.y); _p.z = fin(wp.z); }
      this.play(landRecipe(sid), {
        position: wp ? _p : null, impactSpeed: speed,
        volume: (car?.isPlayer ? 1.0 : 0.8) * clamp(0.35 + speed / 10, 0.3, 1.3),
        priority: 0.6,
      });
      if (car?.isPlayer && speed > 6) this.game?.input?.rumble?.(0.5, 0.3, 90);
    });

    on('car:airborne', (e) => {
      if (!e || !this.ready) return;
      const car = this._carById(e.carId);
      if (!car?.isPlayer) return;
      if (fin(e.height, 0) < 0.25) return;
      this.play('jump/launch', { volume: 0.55, priority: 0.4 });
    });

    on('car:respawn', (e) => {
      if (!this.ready) return;
      const car = this._carById(e?.carId);
      const p = e?.position ?? car?.group?.position;
      if (p) { _p.x = fin(p.x); _p.y = fin(p.y); _p.z = fin(p.z); }
      this.play('respawn', { position: p ? _p : null, volume: car?.isPlayer ? 1 : 0.6 });
      if (car?.isPlayer) this.listener?.resetMotion();
      this.detachScrape(e?.carId);
    });

    // ── race flow ─────────────────────────────────────────────────────────
    on('race:countdown', (e) => {
      if (!this.ready) return;
      const n = fin(e?.n, 0);
      if (n > 0) this.beep(n); else this.go();
    });

    on('race:start', () => this.setMusicIntent('race'));

    on('race:lap', (e) => {
      if (!this.ready || !e) return;
      const car = this._carById(e.carId);
      if (!car?.isPlayer) return;
      const laps = fin(this.game?.raceConfig?.laps, 3);
      const lap = fin(e.lap, 0);
      const improved = e.best != null && fin(e.lapTime, 1e9) <= fin(e.best, 1e9) + 1e-4 && lap > 1;
      this.play(improved ? 'race/best' : 'race/lap', { volume: 1.0 });
      if (lap >= laps && lap !== this._lastLapAnnounced) {
        this._lastLapAnnounced = lap;
        this.setMusicIntent('finalLap');
        this.play('crowd/cheer', { volume: 0.35, intensity: 0.5, delay: 0.2 });
      }
    });

    on('race:checkpoint', (e) => {
      const car = this._carById(e?.carId);
      if (car?.isPlayer) this.play('race/checkpoint', { volume: 0.6 });
    });

    on('race:position', (e) => {
      if (!e) return;
      const car = this._carById(e.carId);
      if (!car?.isPlayer) return;
      const place = fin(e.place, 1), prev = fin(e.prevPlace, place);
      if (place === prev) return;
      this.play('race/position', { up: place < prev, volume: 0.7 });
    });

    on('race:finish', (e) => {
      if (!this.ready || !e) return;
      const car = this._carById(e.carId);
      if (!car?.isPlayer) return;
      this.play('race/finish', { volume: 1.0 });
      this.play('crowd/cheer', { volume: 0.7, intensity: 1, delay: 0.15 });
      this.setMusicIntent(fin(e.place, 9) <= 3 ? 'victory' : 'race');
    });

    on('race:end', () => {
      this.setMusicIntent('victory');
      this.setDuck(0.75, 0.6);
    });

    // ── pickups & weapons ─────────────────────────────────────────────────
    on('pickup:collected', (e) => {
      if (!this.ready) return;
      const car = this._carById(e?.carId);
      const p = car?.group?.position;
      if (p) { _p.x = fin(p.x); _p.y = fin(p.y); _p.z = fin(p.z); }
      this.play('pickup/collect', { position: p ? _p : null, volume: car?.isPlayer ? 1 : 0.55 });
      if (car?.isPlayer) this.startPickupRoll();
    });

    on('pickup:assigned', (e) => {
      if (!this.ready) return;
      const car = this._carById(e?.carId);
      if (car?.isPlayer) this.stopPickupRoll(true);
    });

    on('pickup:used', (e) => {
      if (!this.ready || !e) return;
      const car = this._carById(e.carId);
      const p = car?.group?.position;
      if (p) { _p.x = fin(p.x); _p.y = fin(p.y); _p.z = fin(p.z); }
      const vel = car?.body?.velocity;
      if (vel) { _v.x = fin(vel.x); _v.y = fin(vel.y); _v.z = fin(vel.z); }
      this.playWeapon(e.weaponId, 'fire', {
        position: p ? _p : null, velocity: vel ? _v : null,
        volume: car?.isPlayer ? 1 : 0.75,
      });
      const fam = weaponFamily(e.weaponId);
      if (fam === 'turbo' || fam === 'battery') this.startBoost(car);
    });

    on('weapon:hit', (e) => {
      if (!this.ready || !e) return;
      const wp = e.worldPoint;
      if (wp) { _p.x = fin(wp.x); _p.y = fin(wp.y); _p.z = fin(wp.z); }
      this.playWeapon(e.weaponId, 'hit', {
        position: wp ? _p : null, impulse: fin(e.impulse, 6), volume: 1.0,
      });
      const target = this._carById(e.carId);
      if (target?.isPlayer) this.game?.input?.rumble?.(0.8, 0.6, 200);
    });

    // ── state / UI ────────────────────────────────────────────────────────
    on('game:state', (e) => {
      if (!this.ready) return;
      const st = e?.state;
      if (st === 'paused') {
        this.setDuck(0.22, 0.15);
        this.listener?.setExtraMuffle(0.55);
        this.music?.duck(0.45, 0.2);
      } else if (st === 'menu' || st === 'results') {
        this.setDuck(0.55, 0.4);
        this.listener?.setExtraMuffle(0);
        this.music?.duck(0, 0.6);
        if (st === 'menu') this.setMusicIntent('menu');
      } else {
        this.setDuck(1, 0.3);
        this.listener?.setExtraMuffle(0);
        this.music?.duck(0, 0.5);
      }
    });

    on('audio:music', (e) => {
      const intent = typeof e === 'string' ? e : e?.intent;
      if (intent) this.setMusicIntent(intent);
    });

    on('camera:mode', () => { this.listener?.resetMotion(); });

    on('ui:screen', () => { this.play('ui/whoosh', { volume: 0.5 }); });
  }

  detachScrape(carId) {
    const s = this._scrapes.get(carId);
    if (s?.handle) s.handle.stop(0.08);
    this._scrapes.delete(carId);
  }

  _carById(id) {
    const cars = this.game?.cars;
    if (!Array.isArray(cars)) return null;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (c && (c.id ?? i) === id) return c;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════ input plumbing

  _installGestureUnlock() {
    if (this._gestureHandler) return;
    const handler = () => { this.unlock(); };
    this._gestureHandler = handler;
    const opts = { passive: true };
    for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
      globalThis.addEventListener?.(ev, handler, opts);
    }
  }

  _removeGestureUnlock() {
    if (!this._gestureHandler) return;
    for (const ev of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
      globalThis.removeEventListener?.(ev, this._gestureHandler);
    }
    this._gestureHandler = null;
  }

  /** Global mute key (M). Ignores typing and browser shortcuts. */
  _installKeyBindings() {
    if (this._keyHandler) return;
    this._keyHandler = (ev) => {
      if (!ev || ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t = ev.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (ev.code === 'KeyM') {
        this.toggleMute();
        if (CONFIG.debug) console.info(`[Audio] ${this.muted ? 'muted' : 'unmuted'}`);
      }
    };
    globalThis.addEventListener?.('keydown', this._keyHandler);
  }

  /** Pause the context when the tab is hidden — saves battery, avoids drift. */
  _installVisibility() {
    if (this._visibilityHandler || typeof document === 'undefined') return;
    this._visibilityHandler = () => {
      if (!this.ctx) return;
      if (document.hidden) {
        this._wasRunning = this.ctx.state === 'running';
        if (this._wasRunning) this.ctx.suspend?.().catch?.(() => {});
      } else if (this._wasRunning) {
        this.ctx.resume?.().catch?.(() => {});
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  // ═══════════════════════════════════════════════════════════════ debug

  stats() {
    return {
      available: this.available,
      ready: this.ready,
      unlocked: this.unlocked,
      muted: this.muted,
      state: this.ctx?.state ?? 'none',
      sampleRate: this.ctx?.sampleRate ?? 0,
      baseLatency: +((this.ctx?.baseLatency ?? 0) * 1000).toFixed(1),
      ms: +this.stats_.ms.toFixed(2),
      voices: this.pool?.stats() ?? null,
      engines: this.engines.size,
      tires: this.tires.size,
      scrapes: this._scrapes.size,
      loops: this._loops.size,
      reverb: this.reverb?.stats() ?? null,
      listener: this.listener?.stats() ?? null,
      music: this.music?.stats() ?? null,
      ambience: this.ambienceId,
      volumes: {
        master: CONFIG.audio.masterVolume, music: CONFIG.audio.musicVolume,
        sfx: CONFIG.audio.sfxVolume, engine: CONFIG.audio.engineVolume,
      },
    };
  }

  /**
   * Play one of everything, spaced out — for auditioning from the console:
   *   `GAME.audio.audition()`
   * @param {number} delayStep seconds between sounds
   * @param {RegExp|string} [match] only names matching this
   * @returns {number} how many were scheduled
   */
  audition(delayStep = 0.7, match = null) {
    if (!this.ready || !this.sfx) return 0;
    const re = match instanceof RegExp ? match : (match ? new RegExp(match) : null);
    let i = 0;
    for (const name of Object.keys(RECIPES)) {
      if (RECIPES[name].alias) continue;
      if (re && !re.test(name)) continue;
      this.play(name, { delay: i * delayStep, volume: 0.8, impulse: 6, impactSpeed: 6, minGap: 0 });
      if (CONFIG.debug) console.info(`[Audio] audition +${(i * delayStep).toFixed(1)}s  ${name}`);
      i++;
    }
    return i;
  }

  /** Names of every playable one-shot recipe. */
  listSounds() { return Object.keys(RECIPES).filter((k) => !RECIPES[k].alias).sort(); }

  dispose() {
    for (const u of this._unsub) { try { u(); } catch { /* ignore */ } }
    this._unsub.length = 0;
    this._removeGestureUnlock();
    if (this._keyHandler) globalThis.removeEventListener?.('keydown', this._keyHandler);
    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
    }
    this.onRaceEnd();
    this.music?.dispose();
    this.pool?.dispose();
    this.reverb?.dispose();
    this.listener?.dispose();
    kill(this.limiterLfo);
    for (const n of [this.musicIn, this.musicGain, this.sfxIn, this.sfxGain,
      this.engineIn, this.engineHP, this.enginePeak, this.engineLowShelf, this.engineGain,
      this.uiIn, this.uiGain, this.masterIn, this.clip, this.masterOut, this.reverbReturn]) kill(n);
    try { this.limiter?.disconnect(); } catch { /* ignore */ }
    try { this.ctx?.close?.(); } catch { /* ignore */ }
    this.ready = false;
    this.available = false;
  }
}

export default AudioSystem;
