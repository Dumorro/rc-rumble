/**
 * RC RUMBLE — persisted player settings.
 *
 * A flat, versioned bag of primitives in `localStorage`. Nothing here throws:
 * a corrupt / absent / disabled store just means defaults. `apply()` pushes the
 * values into the live systems through their *documented* APIs only, and every
 * hop is optional-chained so the UI still works before (or without) a system.
 */

import CONFIG from '../core/Config.js';
import { clamp, clamp01 } from './Dom.js';

const KEY = 'rcrumble.settings.v1';
const RECORDS_KEY = 'rcrumble.records.v1';

export const QUALITY_LEVELS = ['low', 'medium', 'high', 'ultra'];
export const CAMERA_MODES = ['chase', 'chaseFar', 'bumper', 'cockpit'];
export const CAMERA_LABELS = {
  chase: 'Chase', chaseFar: 'Chase Far', bumper: 'Bumper', cockpit: 'Cockpit',
};

/** The FOV the camera presets were authored around. */
const FOV_REF = CONFIG.render?.fovBase ?? 62;

export const DEFAULTS = Object.freeze({
  quality: CONFIG.quality ?? 'high',
  masterVolume: CONFIG.audio?.masterVolume ?? 0.85,
  musicVolume: CONFIG.audio?.musicVolume ?? 0.45,
  sfxVolume: CONFIG.audio?.sfxVolume ?? 0.9,
  engineVolume: CONFIG.audio?.engineVolume ?? 0.7,
  cameraMode: CONFIG.camera?.mode ?? 'chase',
  fov: FOV_REF,
  invertLook: false,
  motionBlur: true,
  bloom: true,
  screenShake: 1.0,
  cameraCuts: true,
  showTelemetry: false,
  showMinimap: true,
  showLadder: true,
  touch: 'auto',            // 'auto' | 'on' | 'off'
  rumble: true,

  // Last-used race setup, so the menus remember where you were.
  lastCar: CONFIG.startup?.car ?? 'toyeca',
  lastTrack: '',
  laps: CONFIG.startup?.laps ?? 3,
  opponents: CONFIG.startup?.opponents ?? 7,
  mirrored: false,
  reversed: false,
  carColor: -1,             // index into the livery palette, -1 = stock
});

function readStore(key) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

function writeStore(key, value) {
  try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

export class Settings {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.values = { ...DEFAULTS };
    this.records = readStore(RECORDS_KEY) ?? {};
    this._saveTimer = 0;
    this._pendingSave = false;
    this.load();
  }

  // ─────────────────────────────────────────────────────────── persistence

  load() {
    const stored = readStore(KEY);
    if (stored) {
      for (const k in DEFAULTS) {
        if (stored[k] === undefined) continue;
        const d = DEFAULTS[k];
        const v = stored[k];
        if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) this.values[k] = v;
        else if (typeof d === 'boolean' && typeof v === 'boolean') this.values[k] = v;
        else if (typeof d === 'string' && typeof v === 'string') this.values[k] = v;
      }
    }
    // Query string always wins over the stored preference for this session.
    const qs = new URLSearchParams(globalThis.location?.search ?? '');
    if (qs.has('quality')) this.values.quality = qs.get('quality');
    if (!QUALITY_LEVELS.includes(this.values.quality)) this.values.quality = DEFAULTS.quality;
    if (!CAMERA_MODES.includes(this.values.cameraMode)) this.values.cameraMode = 'chase';
    this.values.fov = clamp(this.values.fov, 45, 95);
    for (const k of ['masterVolume', 'musicVolume', 'sfxVolume', 'engineVolume', 'screenShake']) {
      this.values[k] = clamp01(this.values[k]);
    }
    this.values.laps = clamp(Math.round(this.values.laps), 1, 20);
    this.values.opponents = clamp(Math.round(this.values.opponents), 0, (CONFIG.race?.maxCars ?? 8) - 1);
    return this;
  }

  /** Debounced write — menus can spam `set()` on a slider without hammering IO. */
  save() {
    this._pendingSave = true;
    this._saveTimer = 0.4;
    return this;
  }

  saveNow() {
    this._pendingSave = false;
    this._saveTimer = 0;
    writeStore(KEY, this.values);
    return this;
  }

  /** Driven from UISystem.update with real (unscaled) dt. */
  tick(rawDt) {
    if (!this._pendingSave) return;
    this._saveTimer -= rawDt;
    if (this._saveTimer <= 0) this.saveNow();
  }

  reset() {
    this.values = { ...DEFAULTS };
    this.saveNow();
    this.apply();
    return this;
  }

  // ─────────────────────────────────────────────────────────────── accessors

  get(k) { return this.values[k]; }

  /** Set + persist + push into the live systems. */
  set(k, v) {
    if (this.values[k] === v) return v;
    this.values[k] = v;
    this.save();
    this.applyOne(k);
    return v;
  }

  toggle(k) { return this.set(k, !this.values[k]); }

  /** Step a numeric setting, clamped. */
  nudge(k, delta, min, max, round = false) {
    let v = (this.values[k] ?? 0) + delta;
    if (round) v = Math.round(v);
    else v = Math.round(v * 1000) / 1000;
    return this.set(k, clamp(v, min, max));
  }

  /** Cycle through a list of string options. */
  cycle(k, list, dir = 1) {
    const i = list.indexOf(this.values[k]);
    const n = list.length;
    return this.set(k, list[(((i < 0 ? 0 : i) + dir) % n + n) % n]);
  }

  // ────────────────────────────────────────────────────────────────── apply

  /** Push everything into the live systems. Safe at any point in the boot. */
  apply() {
    for (const k in this.values) this.applyOne(k);
    return this;
  }

  applyOne(key) {
    const g = this.game;
    const v = this.values[key];
    try {
      switch (key) {
        case 'quality':
          CONFIG.quality = v;
          g?.renderer?.setQuality?.(v);
          break;
        case 'masterVolume': g?.audio?.setMasterVolume?.(v); CONFIG.audio.masterVolume = v; break;
        case 'musicVolume':  g?.audio?.setMusicVolume?.(v);  CONFIG.audio.musicVolume = v; break;
        case 'sfxVolume':    g?.audio?.setSfxVolume?.(v);    CONFIG.audio.sfxVolume = v; break;
        case 'engineVolume': g?.audio?.setEngineVolume?.(v); CONFIG.audio.engineVolume = v; break;
        case 'cameraMode':
          CONFIG.camera.mode = v;
          if (g?.cameraDirector) {
            g.cameraDirector.baseMode = v;
            const m = g.cameraDirector.getMode?.();
            if (m && CAMERA_MODES.includes(m)) g.cameraDirector.setMode?.(v, 0.3);
          }
          break;
        case 'fov': this._applyFov(v); break;
        case 'invertLook': CONFIG.camera.invertLook = !!v; break;
        case 'motionBlur':
          g?.renderer?.postfx?.setEnabled?.('motionBlur', !!v);
          break;
        case 'bloom':
          g?.renderer?.postfx?.setEnabled?.('bloom', !!v);
          break;
        case 'screenShake':
          if (g?.cameraDirector?.tuning) g.cameraDirector.tuning.shakeMax = clamp01(v);
          break;
        case 'cameraCuts':
          if (g?.cameraDirector) {
            // Push the cut cooldowns out of reach rather than reaching into privates.
            g.cameraDirector.tuning.bigAirCooldown = v ? 7.0 : 1e9;
            g.cameraDirector.tuning.crashCooldown = v ? 15.0 : 1e9;
          }
          break;
        default: break;
      }
    } catch (err) {
      console.warn(`[UI] failed to apply setting "${key}"`, err);
    }
  }

  _applyFov(fov) {
    CONFIG.render.fovBase = fov;
    const rigs = this.game?.cameraDirector?.rigs;
    if (!rigs) return;
    const delta = fov - FOV_REF;
    for (const name in rigs) {
      const rig = rigs[name];
      const p = rig?.preset;
      if (!p || typeof p.fovBase !== 'number') continue;
      // Remember the authored value once, then always re-derive from it so
      // repeated applications never accumulate.
      rig.__uiFovRef ??= p.fovBase;
      // Fork the shared preset object once, so tweaking one rig cannot leak
      // into the module-level preset table other rigs read from.
      const forked = rig.__uiPreset === rig.preset ? rig.preset : { ...p };
      rig.preset = forked;
      rig.__uiPreset = forked;
      forked.fovBase = rig.__uiFovRef + delta;
      if (rig.fov && typeof rig.fov.target === 'number') rig.fov.target = forked.fovBase;
    }
  }

  // ────────────────────────────────────────────────────────────── records

  /** @returns {{bestLap:number, bestRace:number, wins:number, races:number}} */
  recordFor(trackId) {
    if (!trackId) return { bestLap: Infinity, bestRace: Infinity, wins: 0, races: 0 };
    const r = this.records[trackId];
    return {
      bestLap: Number.isFinite(r?.bestLap) ? r.bestLap : Infinity,
      bestRace: Number.isFinite(r?.bestRace) ? r.bestRace : Infinity,
      wins: r?.wins ?? 0,
      races: r?.races ?? 0,
    };
  }

  /**
   * Fold a finished race into the record book.
   * @returns {{lapRecord:boolean, raceRecord:boolean, prevLap:number, prevRace:number}}
   */
  submitResult(trackId, { bestLap = Infinity, totalTime = Infinity, won = false } = {}) {
    const out = { lapRecord: false, raceRecord: false, prevLap: Infinity, prevRace: Infinity };
    if (!trackId) return out;
    const cur = this.recordFor(trackId);
    out.prevLap = cur.bestLap;
    out.prevRace = cur.bestRace;
    const next = {
      bestLap: cur.bestLap, bestRace: cur.bestRace,
      wins: cur.wins + (won ? 1 : 0), races: cur.races + 1,
    };
    if (Number.isFinite(bestLap) && bestLap > 0 && bestLap < cur.bestLap) {
      next.bestLap = bestLap; out.lapRecord = true;
    }
    if (Number.isFinite(totalTime) && totalTime > 0 && totalTime < cur.bestRace) {
      next.bestRace = totalTime; out.raceRecord = true;
    }
    if (!Number.isFinite(next.bestLap)) delete next.bestLap;
    if (!Number.isFinite(next.bestRace)) delete next.bestRace;
    this.records[trackId] = next;
    writeStore(RECORDS_KEY, this.records);
    return out;
  }

  clearRecords() {
    this.records = {};
    writeStore(RECORDS_KEY, this.records);
  }
}

export default Settings;
