/**
 * CinematicCamera — the three moments where the camera stops being a periscope
 * and starts being a film crew.
 *
 * Instantiated once per behaviour (`new CinematicCamera(director, 'intro')`), so
 * two of them can cross-fade against each other without sharing state.
 *
 *  • **'intro'** — the pre-race flyby. Three shots, hard-cut between each (a cut
 *    reads as broadcast; one endless swoop reads as a screensaver):
 *      A. high crane arc over the start grid, descending, slow FOV push in;
 *      B. low dolly along the centreline through the first corners, camera
 *         skimming the track and aiming down it;
 *      C. a swoop that lands *exactly* on the chase camera's settled pose, so the
 *         hand-off at "GO" is invisible.
 *    Splines are built once on activate from whatever the track offers
 *    (centreline spline → checkpoints → AI path → start grid), never per frame.
 *    `compressTo(seconds)` retimes a running intro so it can still land on the
 *    countdown if the race system starts one early.
 *
 *  • **'bigair'** — a brief low, wide, side-on angle when the player launches. It
 *    picks whichever side of the flight path has a clear line of sight (two sphere
 *    casts, once) and holds the car high in frame so the arc reads.
 *
 *  • **'replay'** — the slow-mo crash cut: a low orbit of the impact point with a
 *    long lens and DOF. Gated hard by the director so it can never nag.
 *
 * The only per-frame allocations are inside three's CatmullRomCurve3.getPoint,
 * which writes into a Vector3 we own; the curves themselves are built on activate.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp, smootherstep, smoothstep, TAU } from '../core/MathUtils.js';
import { createRayHit, Layer } from '../physics/index.js';
import { CameraPose, WORLD_UP, framingUp } from './CameraPose.js';
import { Spring, Vec3Spring, lagCoefficient, addLagCompensation } from './Spring.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _look = new THREE.Vector3();
const _up = new THREE.Vector3();
const _side = new THREE.Vector3();
const _hit = createRayHit();
const _ideal = new CameraPose();
const CAST_MASK = Layer.TRACK | Layer.PROP | Layer.DEFAULT;

/** Default shot timings, seconds. Sum = intro duration. */
export const INTRO_SHOTS = Object.freeze([
  { key: 'crane', duration: 3.1, fovFrom: 30, fovTo: 40 },
  { key: 'dolly', duration: 2.7, fovFrom: 48, fovTo: 38 },
  { key: 'settle', duration: 2.4, fovFrom: 34, fovTo: CONFIG.render.fovBase },
]);

export class CinematicCamera {
  /**
   * @param {import('./CameraDirector.js').CameraDirector} director
   * @param {'intro'|'bigair'|'replay'|'cinematic'} kind
   */
  constructor(director, kind = 'intro') {
    this.director = director;
    this.game = director?.game ?? null;
    this.name = kind;
    this.kind = kind;

    /** Elapsed seconds inside the current behaviour. */
    this.t = 0;
    /** Total planned length, seconds. */
    this.duration = kind === 'intro' ? introDuration() : (kind === 'replay' ? 1.25 : 2.4);
    this._done = false;
    this._cutFrame = false;

    // intro state
    /** @type {THREE.CatmullRomCurve3[]} */
    this._eyeCurves = [];
    /** @type {THREE.CatmullRomCurve3[]} */
    this._lookCurves = [];
    this._shots = INTRO_SHOTS.map((s) => ({ ...s }));
    this._shotIndex = -1;
    this._built = false;
    this._timeScale = 1;

    // bigair / replay state
    this.anchor = new THREE.Vector3();
    this.orbitAngle = 0;
    this.orbitRadius = 1.1;
    this._sideSign = 1;

    this.pos = new Vec3Spring(6.5, 1);
    this.look = new Vec3Spring(7.5, 1);
    this.fov = new Spring(CONFIG.render.fovBase, 3.2, 1);
    this._focus = new Spring(3, 2.4, 1);
  }

  // ───────────────────────────────────────────────────────────── lifecycle

  /**
   * @param {object} ctx director frame context
   * @param {CameraPose|null} fromPose
   */
  activate(ctx, fromPose = null) {
    this.t = 0;
    this._done = false;
    this._cutFrame = true;
    this._timeScale = 1;
    this._shotIndex = -1;

    if (this.kind === 'intro') this._buildIntro(ctx);
    else if (this.kind === 'bigair') this._setupBigAir(ctx, fromPose);
    else if (this.kind === 'replay') this._setupReplay(ctx, fromPose);
    else this._setupShowcase(ctx, fromPose);

    return this;
  }

  deactivate() { this._done = true; return this; }
  isDone() { return this._done; }
  snap() { return this; }

  /** Retime a running intro so it finishes in `seconds`. */
  compressTo(seconds) {
    const remaining = Math.max(this.duration - this.t, 0.001);
    const want = Math.max(seconds, 0.35);
    this._timeScale = clamp(remaining / want, 1, 12);
    return this;
  }

  /** Jump to the end (skip). */
  finish() { this.t = this.duration; this._done = true; return this; }

  // ───────────────────────────────────────────────────────────── per frame

  update(dt, ctx, out) {
    dt = clamp(dt, 0, 0.25) * this._timeScale;
    this.t += dt;

    switch (this.kind) {
      case 'intro': this._updateIntro(dt, ctx, out); break;
      case 'bigair': this._updateBigAir(dt, ctx, out); break;
      case 'replay': this._updateReplay(dt, ctx, out); break;
      default: this._updateShowcase(dt, ctx, out); break;
    }

    out.cut = this._cutFrame;
    this._cutFrame = false;
    if (this.t >= this.duration) this._done = true;
    return out;
  }

  // ─────────────────────────────────────────────────────────────── intro

  /** 0..1 progress through the whole intro. */
  get progress() { return clamp01(this.duration > 0 ? this.t / this.duration : 1); }

  _buildIntro(ctx) {
    this._eyeCurves.length = 0;
    this._lookCurves.length = 0;
    this._built = false;
    this._shots = INTRO_SHOTS.map((s) => ({ ...s }));
    this.duration = introDuration(this._shots);

    const track = ctx?.track ?? this.game?.track ?? null;
    const cs = ctx?.carState;

    // ── gather a handful of points along the opening of the lap ──
    const path = samplePath(track, 9);
    const gridCentre = _v.set(0, 0, 0);
    if (cs?.valid) gridCentre.copy(cs.position);
    else if (path.length) gridCentre.copy(path[0]);
    else if (track?.startGrid?.[0]?.position) gridCentre.copy(track.startGrid[0].position);

    // Scale: how big is this level? Everything below is expressed in these units
    // so the flyby works on a 6 m kitchen table and a 60 m garden alike.
    const bounds = track?.environment?.bounds;
    let scale = 1;
    if (bounds?.isBox3 && !bounds.isEmpty()) {
      bounds.getSize(_v2);
      scale = clamp(Math.max(_v2.x, _v2.z) / 40, 0.45, 3.0);
    }

    // Forward direction out of the grid.
    const fwd = new THREE.Vector3(0, 0, -1);
    if (path.length > 1) fwd.subVectors(path[1], path[0]);
    else if (cs?.valid) fwd.copy(cs.forward);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);

    const gc = gridCentre.clone();

    // ── shot A: high crane arc over the grid, descending ──
    const craneEye = [];
    const craneLook = [];
    const hi = 4.2 * scale;
    const lo = 1.5 * scale;
    const rad = 4.6 * scale;
    for (let i = 0; i <= 4; i++) {
      const u = i / 4;
      const a = -1.15 + u * 1.5;                       // sweep ~86°
      const r = lerp(rad, rad * 0.62, u);
      craneEye.push(new THREE.Vector3(
        gc.x + (Math.cos(a) * right.x + Math.sin(a) * -fwd.x) * r,
        gc.y + lerp(hi, lo, smoothstep(u)),
        gc.z + (Math.cos(a) * right.z + Math.sin(a) * -fwd.z) * r));
      craneLook.push(new THREE.Vector3(
        gc.x + fwd.x * u * 1.4 * scale,
        gc.y + 0.10 + 0.25 * (1 - u) * scale,
        gc.z + fwd.z * u * 1.4 * scale));
    }
    this._eyeCurves.push(curve(craneEye));
    this._lookCurves.push(curve(craneLook));

    // ── shot B: low dolly along the first corners ──
    const dollyEye = [];
    const dollyLook = [];
    const n = path.length;
    if (n >= 3) {
      const count = Math.min(n - 1, 6);
      for (let i = 0; i <= count; i++) {
        const idx = clamp(Math.round((i / count) * (n - 2)), 0, n - 2);
        const a = path[idx];
        const b = path[Math.min(idx + 1, n - 1)];
        _v2.subVectors(b, a); _v2.y = 0;
        if (_v2.lengthSq() < 1e-8) _v2.copy(fwd);
        _v2.normalize();
        _side.set(-_v2.z, 0, _v2.x);
        const swing = Math.sin((i / count) * Math.PI * 1.4) * 1.05 * scale;
        dollyEye.push(new THREE.Vector3(
          a.x + _side.x * swing - _v2.x * 0.5 * scale,
          a.y + (0.42 + 0.30 * Math.sin((i / count) * Math.PI)) * scale,
          a.z + _side.z * swing - _v2.z * 0.5 * scale));
        const la = path[Math.min(idx + 2, n - 1)];
        dollyLook.push(new THREE.Vector3(la.x, la.y + 0.12 * scale, la.z));
      }
    } else {
      // No usable path: a straight push down the grid's forward axis.
      for (let i = 0; i <= 3; i++) {
        const u = i / 3;
        dollyEye.push(new THREE.Vector3(
          gc.x + fwd.x * u * 5 * scale + right.x * (1 - u) * 1.1 * scale,
          gc.y + 0.55 * scale,
          gc.z + fwd.z * u * 5 * scale + right.z * (1 - u) * 1.1 * scale));
        dollyLook.push(new THREE.Vector3(
          gc.x + fwd.x * (u * 5 + 2.4) * scale,
          gc.y + 0.12 * scale,
          gc.z + fwd.z * (u * 5 + 2.4) * scale));
      }
    }
    this._eyeCurves.push(curve(dollyEye));
    this._lookCurves.push(curve(dollyLook));

    // ── shot C is generated per frame (it has to land on a live chase pose) ──
    this._eyeCurves.push(null);
    this._lookCurves.push(null);

    // A wide low three-quarter start point for the swoop.
    this._swoopStart = this._swoopStart ?? new THREE.Vector3();
    this._swoopStart.set(
      gc.x - fwd.x * 3.1 * scale + right.x * 2.5 * scale,
      gc.y + 1.35 * scale,
      gc.z - fwd.z * 3.1 * scale + right.z * 2.5 * scale);
    this._swoopLook = this._swoopLook ?? new THREE.Vector3();
    this._swoopLook.copy(gc);
    this._swoopLook.y += 0.09;

    this._scale = scale;
    this._built = true;
  }

  _updateIntro(dt, ctx, out) {
    if (!this._built) this._buildIntro(ctx);

    // Which shot are we in?
    let acc = 0;
    let idx = this._shots.length - 1;
    let local = 1;
    for (let i = 0; i < this._shots.length; i++) {
      const d = this._shots[i].duration;
      if (this.t < acc + d || i === this._shots.length - 1) {
        idx = i;
        local = d > 0 ? clamp01((this.t - acc) / d) : 1;
        break;
      }
      acc += d;
    }
    if (idx !== this._shotIndex) {
      this._shotIndex = idx;
      this._cutFrame = true;              // hard cut → kill motion-blur history
      this._hardCut = true;
    }
    const shot = this._shots[idx];

    if (idx < 2 && this._eyeCurves[idx] && this._lookCurves[idx]) {
      const u = smoothstep(local) * 0.15 + local * 0.85;   // ease in, mostly linear
      this._eyeCurves[idx].getPoint(clamp01(u), _eye);
      this._lookCurves[idx].getPoint(clamp01(u), _look);
    } else {
      // ── shot C: swoop into the settled chase pose ──
      const chase = this.director?.rigs?.chase;
      if (chase && ctx?.carState?.valid) chase.sampleIdeal(ctx, _ideal);
      else {
        _ideal.position.copy(this._swoopStart ?? _eye);
        _ideal.fov = CONFIG.render.fovBase;
      }
      const e = smootherstep(local);
      _eye.lerpVectors(this._swoopStart ?? _ideal.position, _ideal.position, e);
      // Arc the swoop up over the middle so it does not cut a straight line
      // through the scenery.
      _eye.y += Math.sin(local * Math.PI) * 0.55 * (this._scale ?? 1) * (1 - e * 0.4);

      if (ctx?.carState?.valid) {
        _look.copy(ctx.carState.position);
        _look.y += 0.09;
      } else {
        _look.copy(this._swoopLook ?? _eye);
      }
    }

    if (this._hardCut) {
      this.pos.snap(_eye);
      this.look.snap(_look);
      this.fov.snap(shot.fovFrom);
      this._focus.snap(Math.max(_eye.distanceTo(_look), 0.3));
      this._hardCut = false;
    } else {
      // Very light spring: the curve is already smooth, this just takes the
      // edge off the shot boundaries and any track-data weirdness.
      this.pos.update(_eye, dt, 14, 1);
      this.look.update(_look, dt, 10, 1);
    }

    // Slow FOV push inside each shot.
    const fovTarget = lerp(shot.fovFrom, shot.fovTo, smoothstep(local));
    this.fov.update(fovTarget, dt, 2.6, 1);

    const dist = Math.max(this.pos.value.distanceTo(this.look.value), 0.25);
    this._focus.update(dist, dt, 3.0, 1);

    out.lookAt(this.pos.value, this.look.value, WORLD_UP, 0);
    out.fov = clamp(this.fov.value, 18, 100);
    out.shakeScale = 0.15;
    out.dofIntensity = 0.9;
    out.focusDistance = this._focus.value;
    out.focusRange = 0.45;
    out.maxBlur = 0.028;
    out.speedIntensity = 0.05;
    return out;
  }

  // ────────────────────────────────────────────────────────────── big air

  _setupBigAir(ctx, fromPose) {
    const cs = ctx?.carState;
    this.duration = 2.6;
    if (!cs?.valid) { this._done = true; return; }

    this.anchor.copy(cs.position);
    _v.copy(cs.travel);
    _side.set(-_v.z, 0, _v.x);

    // Pick the side with a clear line of sight. Two casts, once.
    const physics = ctx.physics;
    const dist = 1.7;
    let bestSign = 1;
    let bestClear = -1;
    for (let s = -1; s <= 1; s += 2) {
      _v2.copy(cs.position)
        .addScaledVector(_side, s * dist)
        .addScaledVector(_v, 0.9);
      _v2.y -= 0.15;
      let clear = dist;
      if (physics?.trackMesh) {
        _eye.subVectors(_v2, cs.position);
        const len = _eye.length();
        if (len > 1e-3) {
          _eye.multiplyScalar(1 / len);
          try {
            if (physics.sphereCast(cs.position, _eye, 0.12, len, _hit, CAST_MASK)) clear = _hit.distance;
            else clear = len;
          } catch (err) { clear = len; }
        }
      }
      if (clear > bestClear) { bestClear = clear; bestSign = s; }
    }
    this._sideSign = bestSign;
    this._airDist = clamp(bestClear * 0.85, 0.55, dist);
    this.orbitAngle = 0;

    _v2.copy(cs.position)
      .addScaledVector(_side, bestSign * this._airDist)
      .addScaledVector(_v, 0.8);
    _v2.y -= 0.10;
    this.pos.snap(_v2);
    this.look.snap(cs.position);
    this.fov.snap(fromPose ? fromPose.fov : CONFIG.render.fovBase);
    this._focus.snap(Math.max(_v2.distanceTo(cs.position), 0.3));
  }

  _updateBigAir(dt, ctx, out) {
    const cs = ctx?.carState;
    if (!cs?.valid) { this._done = true; return this._hold(out); }

    // The rig drifts gently along the flight path — a locked-off camera would
    // lose the car in half a second at 9 m/s.
    _v.copy(cs.travel);
    _side.set(-_v.z, 0, _v.x);
    const settle = smoothstep(clamp01(this.t / 0.35));
    _v2.copy(cs.position)
      .addScaledVector(_side, this._sideSign * (this._airDist ?? 1.4))
      .addScaledVector(_v, lerp(0.4, 1.6, settle));
    // Low: below the car if it is high enough, otherwise just above the deck.
    _v2.y = lerp(_v2.y - 0.18, cs.position.y - 0.55, clamp01(this.t / 0.8));

    // Cancel the spring's velocity lag — at 8 m/s a ω=5.5 spring would trail the
    // car by nearly 3 m and the "cinematic" angle would just be a rear view.
    const ka = lagCoefficient(5.5, 1, 0.92);
    addLagCompensation(_v2, cs.velocity, ka, ka * 0.8, 3.2);
    this.pos.update(_v2, dt, 5.5, 1);
    _look.copy(cs.position);
    const kl = 0.06 + lagCoefficient(9, 1, 0.95);
    addLagCompensation(_look, cs.velocity, kl, kl * 0.8, 2.4);
    this.look.update(_look, dt, 9, 1);

    this.fov.update(CONFIG.render.fovBase + 14, dt, 3.4, 1);
    const dist = Math.max(this.pos.value.distanceTo(this.look.value), 0.25);
    this._focus.update(dist, dt, 4, 1);

    framingUp(_up, cs.up, 0.12);
    out.lookAt(this.pos.value, this.look.value, _up, 0);
    out.fov = clamp(this.fov.value, 20, 110);
    out.shakeScale = 0.65;
    out.dofIntensity = 0;
    out.focusDistance = 0;
    out.speedIntensity = clamp01(0.45 + cs.speedFrac * 0.55);
    return out;
  }

  // ───────────────────────────────────────────────────────── crash replay

  _setupReplay(ctx, fromPose) {
    const cs = ctx?.carState;
    this.duration = 1.25;
    const hint = this.director?._crashPoint;
    if (hint) this.anchor.copy(hint);
    else if (cs?.valid) this.anchor.copy(cs.position);
    else { this._done = true; return; }

    // Start on the far side of the impact from the current camera so the cut
    // reads as a new angle, not a nudge.
    let a = 0;
    if (fromPose) {
      _v.subVectors(fromPose.position, this.anchor);
      a = Math.atan2(_v.x, _v.z) + Math.PI * 0.62;
    } else if (cs?.valid) {
      a = Math.atan2(cs.forward.x, cs.forward.z) + Math.PI * 0.5;
    }
    this.orbitAngle = a;
    this.orbitRadius = 0.95;

    const physics = ctx?.physics;
    if (physics?.trackMesh) {
      // Do not start inside geometry.
      _v.set(Math.sin(a), 0, Math.cos(a));
      try {
        if (physics.sphereCast(this.anchor, _v, 0.12, this.orbitRadius, _hit, CAST_MASK)) {
          this.orbitRadius = clamp(_hit.distance * 0.8, 0.35, this.orbitRadius);
        }
      } catch (err) { /* keep default */ }
    }

    _v2.set(
      this.anchor.x + Math.sin(a) * this.orbitRadius,
      this.anchor.y + 0.16,
      this.anchor.z + Math.cos(a) * this.orbitRadius);
    this.pos.snap(_v2);
    this.look.snap(this.anchor);
    this.fov.snap(46);
    this._focus.snap(Math.max(_v2.distanceTo(this.anchor), 0.25));
  }

  _updateReplay(dt, ctx, out) {
    const cs = ctx?.carState;
    const u = clamp01(this.duration > 0 ? this.t / this.duration : 1);

    // Track the wreck as it slides, but lazily — the impact point is the subject.
    if (cs?.valid) this.anchor.lerp(cs.position, clamp01(dt * 2.2));

    this.orbitAngle += dt * 0.85;
    const r = this.orbitRadius * lerp(1, 1.45, smoothstep(u));
    _v2.set(
      this.anchor.x + Math.sin(this.orbitAngle) * r,
      this.anchor.y + lerp(0.12, 0.34, smootherstep(u)),
      this.anchor.z + Math.cos(this.orbitAngle) * r);
    this.pos.update(_v2, dt, 7, 1);
    _look.copy(this.anchor); _look.y += 0.04;
    this.look.update(_look, dt, 9, 1);

    this.fov.update(lerp(46, 34, smoothstep(u)), dt, 2.6, 1);
    const dist = Math.max(this.pos.value.distanceTo(this.look.value), 0.2);
    this._focus.update(dist, dt, 5, 1);

    out.lookAt(this.pos.value, this.look.value, WORLD_UP, Math.sin(u * Math.PI) * 0.035);
    out.fov = clamp(this.fov.value, 20, 100);
    out.shakeScale = 0.35;
    out.dofIntensity = 1;
    out.focusDistance = this._focus.value;
    out.focusRange = 0.30;
    out.maxBlur = 0.032;
    out.speedIntensity = 0.15;
    return out;
  }

  // ───────────────────────────────────────────────────── generic showcase

  _setupShowcase(ctx, fromPose) {
    const cs = ctx?.carState;
    this.duration = Infinity;
    if (cs?.valid) this.anchor.copy(cs.position);
    else this.anchor.set(0, 0.2, 0);
    let a = 0.8;
    if (fromPose) {
      _v.subVectors(fromPose.position, this.anchor);
      if (_v.lengthSq() > 1e-6) a = Math.atan2(_v.x, _v.z);
      this.pos.snap(fromPose.position);
      this.fov.snap(fromPose.fov);
    }
    this.orbitAngle = a;
    this.orbitRadius = 1.35;
    this.look.snap(this.anchor);
  }

  _updateShowcase(dt, ctx, out) {
    const cs = ctx?.carState;
    if (cs?.valid) this.anchor.lerp(cs.position, clamp01(dt * 3));
    this.orbitAngle += dt * 0.28;
    const bob = Math.sin(this.t * TAU * 0.14) * 0.10;
    _v2.set(
      this.anchor.x + Math.sin(this.orbitAngle) * this.orbitRadius,
      this.anchor.y + 0.42 + bob,
      this.anchor.z + Math.cos(this.orbitAngle) * this.orbitRadius);
    this.pos.update(_v2, dt, 4.5, 1);
    _look.copy(this.anchor); _look.y += 0.05;
    this.look.update(_look, dt, 6, 1);
    this.fov.update(40 + Math.sin(this.t * 0.5) * 2, dt, 2, 1);
    const dist = Math.max(this.pos.value.distanceTo(this.look.value), 0.2);
    this._focus.update(dist, dt, 4, 1);

    out.lookAt(this.pos.value, this.look.value, WORLD_UP, 0);
    out.fov = clamp(this.fov.value, 20, 100);
    out.shakeScale = 0.3;
    out.dofIntensity = 1;
    out.focusDistance = this._focus.value;
    out.focusRange = 0.34;
    out.maxBlur = 0.030;
    out.speedIntensity = 0;
    return out;
  }

  _hold(out) {
    out.lookAt(this.pos.value, this.look.value, WORLD_UP, 0);
    out.fov = clamp(this.fov.value, 20, 110);
    out.speedIntensity = 0;
    return out;
  }

  dispose() {
    this._eyeCurves.length = 0;
    this._lookCurves.length = 0;
  }
}

// ───────────────────────────────────────────────────────────────── helpers

function introDuration(shots = INTRO_SHOTS) {
  let d = 0;
  for (const s of shots) d += s.duration;
  return d;
}

/** @param {THREE.Vector3[]} pts */
function curve(pts) {
  if (!pts || pts.length < 2) return null;
  if (pts.length === 2) pts = [pts[0], pts[0].clone().lerp(pts[1], 0.5), pts[1]];
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
}

/**
 * Pull `count` points along the opening of the lap out of whatever the track
 * offers, in order of preference: centreline spline → checkpoints → AI path →
 * start grid. Returns a fresh array of fresh Vector3s (activate-time only).
 * @returns {THREE.Vector3[]}
 */
function samplePath(track, count) {
  const out = [];
  if (!track) return out;

  const spline = track.spline;
  if (spline && typeof spline.sample === 'function') {
    for (let i = 0; i < count; i++) {
      // Only the first ~30% of the lap — this is an intro, not a track tour.
      const t = (i / (count - 1)) * 0.3;
      try {
        const s = spline.sample(t);
        const p = s?.position ?? s;
        if (p && Number.isFinite(p.x)) out.push(new THREE.Vector3(p.x, p.y, p.z));
      } catch (err) { break; }
    }
    if (out.length >= 3) return out;
    out.length = 0;
  }

  if (spline && typeof spline.getPoint === 'function') {
    for (let i = 0; i < count; i++) {
      try {
        const p = spline.getPoint((i / (count - 1)) * 0.3);
        if (p && Number.isFinite(p.x)) out.push(new THREE.Vector3(p.x, p.y, p.z));
      } catch (err) { break; }
    }
    if (out.length >= 3) return out;
    out.length = 0;
  }

  const cps = track.checkpoints;
  if (Array.isArray(cps) && cps.length >= 2) {
    const n = Math.min(cps.length, Math.max(3, Math.ceil(cps.length * 0.4)));
    for (let i = 0; i < n; i++) {
      const p = cps[i]?.position;
      if (p && Number.isFinite(p.x)) out.push(new THREE.Vector3(p.x, p.y, p.z));
    }
    if (out.length >= 3) return out;
    out.length = 0;
  }

  const nodes = track.aiPath?.nodes;
  if (Array.isArray(nodes) && nodes.length >= 3) {
    const n = Math.min(nodes.length, count);
    const stride = Math.max(1, Math.floor((nodes.length * 0.35) / n));
    for (let i = 0; i < n; i++) {
      const p = nodes[i * stride]?.position;
      if (p && Number.isFinite(p.x)) out.push(new THREE.Vector3(p.x, p.y, p.z));
    }
    if (out.length >= 3) return out;
    out.length = 0;
  }

  const grid = track.startGrid;
  if (Array.isArray(grid) && grid.length) {
    for (const g of grid) {
      const p = g?.position;
      if (p && Number.isFinite(p.x)) out.push(new THREE.Vector3(p.x, p.y, p.z));
      if (out.length >= 3) break;
    }
  }
  return out;
}

export { samplePath };
export default CinematicCamera;
