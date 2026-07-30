/**
 * src/audio/Listener.js — the ear.
 *
 * Responsibilities
 *   · Drive the WebAudio `AudioListener` from `game.camera` every frame
 *     (position + forward/up orientation), with a camera-cut guard.
 *   · Maintain a smoothed listener velocity, which `VoicePool` uses for doppler.
 *     The Web Audio doppler parameters were removed from the spec, so this is the
 *     only source of truth for relative motion.
 *   · Own the "muffle" stage that sits on the master bus: a lowpass + shelving
 *     pair that closes down when the camera is inside a tunnel / enclosed space,
 *     and much harder when the player car is in water. Menus/pause can add their
 *     own muffle on top via `setExtraMuffle()`.
 *
 * The enclosure probe fires 5 track raycasts at 12 Hz using a single reused
 * RayHit — no allocations, negligible cost.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../core/MathUtils.js';
import { createRayHit } from '../physics/index.js';
import { fin, nyquistOf, gain, filter, osc, targetTo, kill } from './DSP.js';

/** Module scratch — never allocate in update(). */
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hit = createRayHit();

/** Probe directions: up gets double weight, the four diagonals detect a tunnel. */
const PROBES = [
  { d: new THREE.Vector3(0, 1, 0), max: 4.0, w: 2.0 },
  { d: new THREE.Vector3(0.62, 0.78, 0).normalize(), max: 3.0, w: 1.0 },
  { d: new THREE.Vector3(-0.62, 0.78, 0).normalize(), max: 3.0, w: 1.0 },
  { d: new THREE.Vector3(0, 0.78, 0.62).normalize(), max: 3.0, w: 1.0 },
  { d: new THREE.Vector3(0, 0.78, -0.62).normalize(), max: 3.0, w: 1.0 },
];
const PROBE_WEIGHT_TOTAL = PROBES.reduce((s, p) => s + p.w, 0);

export const WATER_SURFACE_ID = 9;

export class Listener {
  /**
   * @param {BaseAudioContext} ctx
   * @param {import('../core/Game.js').Game} game
   */
  constructor(ctx, game) {
    this.ctx = ctx;
    this.game = game;
    this.ready = false;

    /** Public listener state, read by VoicePool (allocation-free contract). */
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.speed = 0;

    /** 0..1, how enclosed the camera is (tunnel / under a table / indoor nook). */
    this.enclosure = 0;
    /** 0..1, how submerged the player car is. */
    this.submerged = 0;
    /** 0..1 externally requested muffle (pause, menus, cinematics). */
    this.extraMuffle = 0;
    /** The resolved amount actually applied to the filters. */
    this.muffle = 0;

    this._probeTimer = 0;
    this._probeRate = 1 / 12;
    this._enclosureRaw = 0;
    this._hasPrev = false;
    this._lastMuffleApplied = -1;

    // Muffle chain nodes (created in _build).
    this.input = null;
    this.output = null;
    this.lp = null;
    this.highShelf = null;
    this.lowShelf = null;
    this.wobbleLfo = null;
    this.wobbleDepth = null;

    this.nyq = nyquistOf(ctx);
    this.openHz = Math.min(20000, this.nyq);
    this.closedHz = Math.min(620, this.nyq * 0.5);

    this._build();
  }

  _build() {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      this.input = gain(ctx, 1);
      this.lp = filter(ctx, 'lowpass', this.openHz, 0.9);
      this.highShelf = filter(ctx, 'highshelf', 3200, 0.7, 0);
      this.lowShelf = filter(ctx, 'lowshelf', 180, 0.7, 0);
      this.output = gain(ctx, 1);

      this.input.connect(this.lp);
      this.lp.connect(this.highShelf);
      this.highShelf.connect(this.lowShelf);
      this.lowShelf.connect(this.output);

      // Underwater wobble: a slow LFO on the lowpass cutoff. Depth is 0 unless
      // we are actually submerged, so the LFO is inaudible the rest of the time.
      this.wobbleLfo = osc(ctx, { type: 'sine', freq: 0.7 });
      this.wobbleDepth = gain(ctx, 0);
      if (this.wobbleLfo && this.wobbleDepth) {
        this.wobbleLfo.connect(this.wobbleDepth);
        this.wobbleDepth.connect(this.lp.frequency);
      }

      this._applyListener(0, 0, 0, 0, 0, -1, 0, 1, 0, true);
      this.ready = true;
    } catch (err) {
      console.warn('[Listener] setup failed:', err);
      this.ready = false;
    }
  }

  /** Externally requested muffle (menus, pause, cinematic ducking). */
  setExtraMuffle(amount) {
    this.extraMuffle = clamp01(fin(amount));
  }

  /**
   * Per-frame update. Use *real* dt (rawDt) so the muffle keeps animating during
   * pause and slow-mo.
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this.ready) return;
    const d = clamp(fin(dt, 0.016), 0, 0.1);
    const cam = this.game?.camera;

    if (cam) {
      cam.updateMatrixWorld?.(false);
      _pos.setFromMatrixPosition(cam.matrixWorld);
      // Forward = -Z of the camera basis; up = +Y.
      _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
      _up.set(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
    } else {
      _pos.set(0, 1, 0); _fwd.set(0, 0, -1); _up.set(0, 1, 0);
    }

    // ── velocity, with camera-cut rejection ──
    if (!this._hasPrev) {
      _prev.copy(_pos);
      this._hasPrev = true;
      _vel.set(0, 0, 0);
    } else if (d > 1e-5) {
      _vel.copy(_pos).sub(_prev).divideScalar(d);
      const jump = _vel.length() * d;
      if (jump > 2.5) _vel.set(0, 0, 0);        // hard cut → no doppler screech
      _prev.copy(_pos);
    }
    const maxV = 80;
    if (_vel.length() > maxV) _vel.setLength(maxV);

    const k = 1 - Math.exp(-14 * d);
    this.vx += (_vel.x - this.vx) * k;
    this.vy += (_vel.y - this.vy) * k;
    this.vz += (_vel.z - this.vz) * k;
    this.speed = Math.hypot(this.vx, this.vy, this.vz);

    this.x = _pos.x; this.y = _pos.y; this.z = _pos.z;
    this._applyListener(_pos.x, _pos.y, _pos.z, _fwd.x, _fwd.y, _fwd.z, _up.x, _up.y, _up.z, false);

    // ── enclosure probe (12 Hz) ──
    this._probeTimer += d;
    if (this._probeTimer >= this._probeRate) {
      this._probeTimer = 0;
      this._enclosureRaw = this._probeEnclosure(_pos);
    }
    this.enclosure = damp(this.enclosure, this._enclosureRaw, 3.2, d);

    // ── water ──
    const car = this.game?.playerCar;
    let wet = 0;
    if (car) {
      if (car.dominantSurfaceId === WATER_SURFACE_ID) wet = 1;
      // Some tracks flag water via the effects table instead.
      else if (car.effects && car.effects.submerged > 0) wet = clamp01(car.effects.submerged);
      // Only muffle when the camera is actually low & close to the car.
      if (wet > 0) {
        const dyc = this.y - (car.group?.position?.y ?? this.y);
        if (dyc > 1.6) wet *= 0.35;
      }
    }
    this.submerged = damp(this.submerged, wet, 5.0, d);

    // ── resolve + apply ──
    const target = clamp01(Math.max(this.enclosure * 0.55, this.submerged, this.extraMuffle));
    this.muffle = damp(this.muffle, target, 6.0, d);
    this._applyMuffle();
  }

  _probeEnclosure(origin) {
    const phys = this.game?.physics;
    if (!phys || typeof phys.raycastTrack !== 'function') return 0;
    if (!phys.trackMesh && !(phys.staticMeshes && phys.staticMeshes.length)) return 0;
    let score = 0;
    for (let i = 0; i < PROBES.length; i++) {
      const p = PROBES[i];
      _dir.copy(p.d);
      if (phys.raycastTrack(origin, _dir, p.max, _hit)) {
        // Closer ceilings feel more enclosed.
        const near = 1 - clamp01(_hit.distance / p.max);
        score += p.w * (0.45 + 0.55 * near);
      }
    }
    return clamp01(score / PROBE_WEIGHT_TOTAL);
  }

  _applyMuffle() {
    const m = this.muffle;
    if (Math.abs(m - this._lastMuffleApplied) < 0.002) return;
    this._lastMuffleApplied = m;
    const now = this.ctx.currentTime;
    const sub = this.submerged;

    // Cutoff falls exponentially — linear Hz sounds wrong.
    const hz = this.openHz * Math.pow(this.closedHz / this.openHz, m);
    targetTo(this.lp.frequency, hz, now, 0.05);
    targetTo(this.lp.Q, lerp(0.9, 2.2, m * (0.4 + 0.6 * sub)), now, 0.08);
    // Treble cut and a low bump: the classic "head under water" curve.
    targetTo(this.highShelf.gain, -18 * m, now, 0.06);
    targetTo(this.lowShelf.gain, 4.5 * sub + 1.5 * m, now, 0.06);
    // Wobble only underwater.
    if (this.wobbleDepth) targetTo(this.wobbleDepth.gain, hz * 0.22 * sub, now, 0.1);
  }

  _applyListener(px, py, pz, fx, fy, fz, ux, uy, uz, snap) {
    const L = this.ctx?.listener;
    if (!L) return;
    const now = this.ctx.currentTime;
    const tau = snap ? 0.0008 : 0.010;
    if (L.positionX) {
      targetTo(L.positionX, px, now, tau);
      targetTo(L.positionY, py, now, tau);
      targetTo(L.positionZ, pz, now, tau);
      targetTo(L.forwardX, fx, now, tau);
      targetTo(L.forwardY, fy, now, tau);
      targetTo(L.forwardZ, fz, now, tau);
      targetTo(L.upX, ux, now, tau);
      targetTo(L.upY, uy, now, tau);
      targetTo(L.upZ, uz, now, tau);
    } else {
      // Legacy Safari path.
      try { L.setPosition(px, py, pz); } catch { /* ignore */ }
      try { L.setOrientation(fx, fy, fz, ux, uy, uz); } catch { /* ignore */ }
    }
  }

  /** Reset velocity history — call on camera cuts / respawn / race load. */
  resetMotion() {
    this._hasPrev = false;
    this.vx = this.vy = this.vz = 0;
    this.speed = 0;
  }

  stats() {
    return {
      pos: [+this.x.toFixed(2), +this.y.toFixed(2), +this.z.toFixed(2)],
      speed: +this.speed.toFixed(2),
      enclosure: +this.enclosure.toFixed(2),
      submerged: +this.submerged.toFixed(2),
      muffle: +this.muffle.toFixed(2),
    };
  }

  dispose() {
    kill(this.wobbleLfo); kill(this.wobbleDepth);
    kill(this.input); kill(this.lp); kill(this.highShelf); kill(this.lowShelf); kill(this.output);
    this.ready = false;
  }
}

export default Listener;
