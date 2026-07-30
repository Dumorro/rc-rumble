/**
 * RC RUMBLE — AI drivers.
 *
 * The goal is an opponent that is *fun to race*, not a lap-time robot: it takes
 * a real racing line, brakes at real braking points, occasionally gets it
 * wrong, fights you for space, and recovers from its own mistakes.
 *
 * How it drives
 * -------------
 * • **Speed profile, solved once per track.** `buildAIPath()` measures the
 *   signed curvature of every node, converts it to a cornering speed, then runs
 *   a *backward pass* around the loop —  v[i] = min(vCorner[i], √(v[i+1]² +
 *   2·a·ds)) — twice, so every node knows the fastest speed from which it can
 *   still make the next corner. That single array *is* the braking points, and
 *   it is shared by all eight drivers (each scales it by its own grip and skill).
 *
 * • **Look-ahead + racing line.** The steering target sits `base + k·speed`
 *   metres down the path, laterally offset to run wide on entry and clip the
 *   apex, using the curvature *ahead* of the car so it sets up early.
 *
 * • **PD steering with slip compensation.** Heading error (P), its smoothed
 *   derivative (D), yaw-rate damping, and — the part that makes them look like
 *   drivers — an explicit counter-steer term proportional to the chassis slip
 *   angle. They catch their own slides.
 *
 * • **Throttle modulation.** Off the pedal into the corner, feathered on exit
 *   while the rear tyres are still saturated, full when the line is straight.
 *   Handbrake only for genuine hairpins, and only if the driver is good enough.
 *
 * • **Air control.** While airborne it uses the throttle/brake pitch authority
 *   to land flat and the air-yaw to point back down the track.
 *
 * • **Opponent awareness.** A cheap lateral test against the other cars plus a
 *   throttled forward sphere-cast for walls, both folded into the same lateral
 *   offset the racing line uses, and clamped to the path width.
 *
 * • **Skill.** From `CONFIG.ai.skillSpread`: reaction delay (a real delay line
 *   on the outputs), lateral error injection, cornering-speed multiplier,
 *   mistake chance, and how willing the driver is to take a risky shortcut.
 *
 * • **Rubber-banding.** Gentle, capped by `CONFIG.ai.rubberBand`, and driven by
 *   the *path* progress so it works even before the race system is wired in.
 *
 * • **Recovery.** Reverse-and-retry when beached, then a respawn request if
 *   that fails. Upside down is handed straight to the respawn manager.
 *
 * Zero allocation per step.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp, damp, RNG, TAU } from '../core/MathUtils.js';
import { createRayHit, Layer } from '../physics/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Scratch
// ═══════════════════════════════════════════════════════════════════════════

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _target = new THREE.Vector3();
const _local = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _d = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _hit = createRayHit();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Reference lateral acceleration the shared speed profile is solved for. */
const REF_LAT_ACCEL = 20.5;   // m/s² (≈ μ 1.05 at 2 g)
/**
 * Reference braking deceleration for the backward pass, on a grip-1.00 surface.
 *
 * Measured, not guessed: a toyeca at full pedal stops from 8.7 m/s in 0.54 s on
 * wood, which is 16.1 m/s². 14.9 is that with a little margin for a car that is
 * not perfectly settled. It used to be 8.2, which made every AI start braking
 * 1.8x further out than it needed to and read as "the CPU is just slow".
 *
 * This is the WOOD figure. It must be scaled by the surface the car is actually
 * on before it is used — see `_brakeAccelFor`.
 */
const REF_BRAKE_ACCEL = 14.9;  // m/s² on grip 1.00
/** Curvature (1/m) that counts as "a proper corner" for line/offset purposes. */
const CORNER_K = 0.55;

// ═══════════════════════════════════════════════════════════════════════════
// AIPath — the shared, pre-solved racing line
// ═══════════════════════════════════════════════════════════════════════════

export class AIPath {
  /**
   * @param {Array<{position:any, width?:number, targetSpeed?:number,
   *                jump?:boolean, shortcutId?:any}>} nodes
   * @param {{closed?:boolean, defaultWidth?:number}} [opts]
   */
  constructor(nodes, opts = {}) {
    const n = nodes.length;
    this.count = n;
    this.closed = opts.closed !== false;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.ty = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.s = new Float32Array(n + 1);
    this.seg = new Float32Array(n);
    this.k = new Float32Array(n);
    this.width = new Float32Array(n);
    this.limit = new Float32Array(n);
    this.jump = new Uint8Array(n);
    this.shortcut = new Array(n).fill(null);

    for (let i = 0; i < n; i++) {
      const nd = nodes[i];
      const p = nd.position ?? nd;
      this.px[i] = p.x ?? p[0] ?? 0;
      this.py[i] = p.y ?? p[1] ?? 0;
      this.pz[i] = p.z ?? p[2] ?? 0;
      this.width[i] = nd.width ?? opts.defaultWidth ?? 1.2;
      this.jump[i] = nd.jump ? 1 : 0;
      this.shortcut[i] = nd.shortcutId ?? null;
      this.limit[i] = nd.targetSpeed ?? Infinity;
    }
    /** Reused projection results — `projectNear` runs in the hot path. */
    this._proj = { s: 0, index: 0, distance: 0 };
    this._projGlobal = { s: 0, index: 0, distance: 0 };

    this._buildGeometry();
    this._solveSpeeds();
  }

  _next(i) { return this.closed ? (i + 1) % this.count : Math.min(this.count - 1, i + 1); }
  _prev(i) { return this.closed ? (i - 1 + this.count) % this.count : Math.max(0, i - 1); }

  _buildGeometry() {
    const n = this.count;
    this.s[0] = 0;
    for (let i = 0; i < n; i++) {
      const j = this._next(i);
      const dx = this.px[j] - this.px[i];
      const dy = this.py[j] - this.py[i];
      const dz = this.pz[j] - this.pz[i];
      const len = Math.hypot(dx, dy, dz) || 1e-4;
      this.seg[i] = len;
      this.tx[i] = dx / len;
      this.ty[i] = dy / len;
      this.tz[i] = dz / len;
      this.s[i + 1] = this.s[i] + len;
    }
    this.total = this.s[n];

    // Signed curvature about world up, from the turn between adjacent tangents.
    for (let i = 0; i < n; i++) {
      const a = this._prev(i);
      const ax = this.tx[a], az = this.tz[a];
      const bx = this.tx[i], bz = this.tz[i];
      // 2-D cross product (about +Y) → positive when turning left.
      const cross = ax * bz - az * bx;
      const dot = clamp(ax * bx + az * bz, -1, 1);
      const dTheta = Math.atan2(cross, dot);
      const ds = (this.seg[a] + this.seg[i]) * 0.5;
      // NOTE: cross(tangentA, tangentB)·Y is negative for a left turn in a
      // Y-up / −Z-forward frame, so flip the sign to keep "+ = left".
      this.k[i] = ds > 1e-5 ? -dTheta / ds : 0;
    }
    // Light smoothing so a lumpy authored path does not produce spiky targets.
    const raw = Float32Array.from(this.k);
    for (let i = 0; i < n; i++) {
      const a = this._prev(i), b = this._next(i);
      this.k[i] = raw[a] * 0.25 + raw[i] * 0.5 + raw[b] * 0.25;
    }
  }

  _solveSpeeds() {
    const n = this.count;
    // Cornering speed from curvature, capped by any authored targetSpeed.
    for (let i = 0; i < n; i++) {
      const kk = Math.abs(this.k[i]);
      const vCorner = kk > 1e-4 ? Math.sqrt(REF_LAT_ACCEL / kk) : 999;
      this.limit[i] = Math.min(this.limit[i], vCorner);
    }
    // Backward pass — twice around, so the loop converges.
    for (let pass = 0; pass < 2; pass++) {
      for (let step = 0; step < n; step++) {
        const i = (n - 1 - step + n) % n;
        const j = this._next(i);
        const reach = Math.sqrt(this.limit[j] * this.limit[j] + 2 * REF_BRAKE_ACCEL * this.seg[i]);
        if (reach < this.limit[i]) this.limit[i] = reach;
      }
      if (!this.closed) break;
    }
  }

  /** Wrap an arclength into [0, total). */
  wrap(s) {
    if (!this.closed) return clamp(s, 0, this.total);
    let v = s % this.total;
    if (v < 0) v += this.total;
    return v;
  }

  /** Node index whose segment contains `s`. `hint` makes this O(1). */
  indexAt(s, hint = 0) {
    const n = this.count;
    let i = clamp(hint | 0, 0, n - 1);
    const target = this.wrap(s);
    // Walk forward or backward from the hint (paths are locally coherent).
    for (let guard = 0; guard < n; guard++) {
      const a = this.s[i];
      const b = this.s[i + 1];
      if (target >= a && target < b) return i;
      if (target < a) i = this._prev(i);
      else i = this._next(i);
      if (i === 0 && target >= this.s[n]) return n - 1;
    }
    return i;
  }

  /** Position at arclength `s`. */
  sampleAt(s, out, hint = 0) {
    const i = this.indexAt(s, hint);
    const j = this._next(i);
    const t = clamp01((this.wrap(s) - this.s[i]) / Math.max(1e-5, this.seg[i]));
    return out.set(
      lerp(this.px[i], this.px[j], t),
      lerp(this.py[i], this.py[j], t),
      lerp(this.pz[i], this.pz[j], t),
    );
  }

  tangentAt(s, out, hint = 0) {
    const i = this.indexAt(s, hint);
    return out.set(this.tx[i], this.ty[i], this.tz[i]);
  }

  curvatureAt(s, hint = 0) {
    const i = this.indexAt(s, hint);
    const j = this._next(i);
    const t = clamp01((this.wrap(s) - this.s[i]) / Math.max(1e-5, this.seg[i]));
    return lerp(this.k[i], this.k[j], t);
  }

  widthAt(s, hint = 0) { return this.width[this.indexAt(s, hint)]; }
  limitAt(s, hint = 0) { return this.limit[this.indexAt(s, hint)]; }

  /** Minimum speed limit over the next `dist` metres. */
  minLimitAhead(s, dist, hint = 0) {
    let i = this.indexAt(s, hint);
    let travelled = -(this.wrap(s) - this.s[i]);
    let best = this.limit[i];
    for (let guard = 0; guard < this.count && travelled < dist; guard++) {
      travelled += this.seg[i];
      i = this._next(i);
      if (this.limit[i] < best) best = this.limit[i];
    }
    return best;
  }

  /** Peak |curvature| over the next `dist` metres, signed by the dominant turn. */
  peakCurvatureAhead(s, dist, hint = 0) {
    let i = this.indexAt(s, hint);
    let travelled = 0;
    let best = 0;
    for (let guard = 0; guard < this.count && travelled < dist; guard++) {
      if (Math.abs(this.k[i]) > Math.abs(best)) best = this.k[i];
      travelled += this.seg[i];
      i = this._next(i);
    }
    return best;
  }

  /** Signed shortest arc distance from `a` to `b`, wrapped to ±total/2. */
  arcDelta(a, b) {
    if (!this.closed) return b - a;
    let d = (b - a) % this.total;
    if (d > this.total * 0.5) d -= this.total;
    if (d < -this.total * 0.5) d += this.total;
    return d;
  }

  /**
   * Arclength of the point on the path closest to `pos`.
   *
   * Searched in a window around a hint, biased FORWARD, with a continuity
   * penalty against the previous arclength. Both matter on a real track: a
   * hairpin brings two parts of the centreline within a car's width of each
   * other, and a plain nearest-point search will happily snap across the gap,
   * teleporting the driver's progress and (worse) its steering target to the
   * other side of the corner.
   *
   * @param {THREE.Vector3} pos
   * @param {number} hintIndex
   * @param {number} [span] nodes to search ahead of the hint
   * @param {number} [prevS] last known arclength, for the continuity penalty
   */
  projectNear(pos, hintIndex, span = 14, prevS = null) {
    const n = this.count;
    const back = Math.max(2, Math.round(span * 0.35));
    let bestS = this.s[hintIndex];
    let bestScore = Infinity;
    let bestD = Infinity;
    let bestI = hintIndex;
    for (let o = -back; o <= span; o++) {
      let i = hintIndex + o;
      if (this.closed) i = ((i % n) + n) % n;
      else if (i < 0 || i >= n) continue;
      const j = this._next(i);
      const ax = this.px[i], ay = this.py[i], az = this.pz[i];
      const bx = this.px[j], by = this.py[j], bz = this.pz[j];
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const l2 = ex * ex + ey * ey + ez * ez;
      let t = l2 > 1e-9 ? ((pos.x - ax) * ex + (pos.y - ay) * ey + (pos.z - az) * ez) / l2 : 0;
      t = clamp01(t);
      const cx = ax + ex * t - pos.x;
      const cy = ay + ey * t - pos.y;
      const cz = az + ez * t - pos.z;
      const d = cx * cx + cy * cy + cz * cz;
      const sHere = this.s[i] + this.seg[i] * t;
      let score = d;
      if (prevS !== null) {
        const jump = this.arcDelta(prevS, sHere);
        score += jump * jump * 0.05;
      }
      if (score < bestScore) { bestScore = score; bestD = d; bestS = sHere; bestI = i; }
    }
    // Reuse the result object — this runs once per AI per fixed step.
    const out = this._proj;
    out.s = bestS; out.index = bestI; out.distance = Math.sqrt(bestD);
    return out;
  }

  /** Full search — used once, when a car is first placed or after a respawn. */
  projectGlobal(pos) {
    let bestD = Infinity;
    let bestS = 0;
    let bestI = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = this.px[i] - pos.x, dy = this.py[i] - pos.y, dz = this.pz[i] - pos.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; bestI = i; bestS = this.s[i]; }
    }
    const out = this._projGlobal;
    out.s = bestS; out.index = bestI; out.distance = Math.sqrt(bestD);
    return out;
  }
}

/**
 * Build the shared AI path from TrackData, falling back through every source
 * the track might have. Returns null only if the track has no usable geometry
 * at all — in which case the AI drives gently and never throws.
 * @param {object|null} track TrackData
 * @returns {AIPath|null}
 */
export function buildAIPath(track) {
  if (!track) return null;
  const nodes = track.aiPath?.nodes;
  if (Array.isArray(nodes) && nodes.length >= 3) {
    return new AIPath(nodes, { closed: true });
  }
  // Fall back to the centreline spline.
  const spline = track.spline;
  if (spline?.sample) {
    const out = [];
    const N = 160;
    for (let i = 0; i < N; i++) {
      try {
        const sm = spline.sample(i / N);
        if (!sm?.position) break;
        out.push({ position: sm.position, width: sm.width ?? 1.4 });
      } catch { break; }
    }
    if (out.length >= 3) return new AIPath(out, { closed: true });
  }
  // Fall back to the checkpoints.
  const cps = track.checkpoints;
  if (Array.isArray(cps) && cps.length >= 3) {
    return new AIPath(cps.map((c) => ({ position: c.position, width: 1.6 })), { closed: true });
  }
  // Fall back to the start grid (better than nothing: a small loop).
  const grid = track.startGrid;
  if (Array.isArray(grid) && grid.length >= 3) {
    return new AIPath(grid.map((g) => ({ position: g.position, width: 1.4 })), { closed: true });
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// AIDriver
// ═══════════════════════════════════════════════════════════════════════════

/** Delay-line length (fixed steps). 32 @ 120 Hz = 0.266 s of reaction budget. */
const DELAY_LEN = 32;

export class AIDriver {
  /**
   * @param {import('./Car.js').Car} car
   * @param {{ skill?:number, seed?:number, aggression?:number }} [opts]
   */
  constructor(car, opts = {}) {
    this.car = car;
    this.game = car.game;
    this.enabled = true;
    /** @type {AIPath|null} */
    this.path = null;

    const cfg = CONFIG.ai;
    this.rng = new RNG(opts.seed ?? (car.id * 7919 + 13));
    const spread = cfg.skillSpread ?? [0.8, 1.0];
    this.skill = clamp01(opts.skill ?? lerp(spread[0], spread[1], this.rng.next()));
    this.aggression = clamp01(opts.aggression ?? lerp(0.35, 1.0, this.rng.next() * 0.6 + this.skill * 0.4));

    // ── skill-derived personality ─────────────────────────────────────
    this.reactionDelay = lerp(0.185, 0.028, this.skill);
    this.delaySteps = clamp(Math.round(this.reactionDelay / CONFIG.physics.fixedDt), 0, DELAY_LEN - 1);
    this.cornerMult = lerp(0.795, 1.030, this.skill);
    this.brakeMult = lerp(0.86, 1.06, this.skill);
    this.errorAmp = lerp(0.30, 0.045, this.skill);
    this.mistakeChance = (cfg.mistakeChance ?? 0.05) * lerp(2.1, 0.35, this.skill);
    this.shortcutNerve = lerp(0.15, 1.0, this.skill) * lerp(0.6, 1.2, this.aggression);
    this.lookAheadBase = (cfg.lookAheadBase ?? 0.9) * lerp(1.18, 0.94, this.skill);
    this.lookAheadSpeed = (cfg.lookAheadSpeed ?? 0.22) * lerp(1.15, 0.95, this.skill);
    this.rubberBand = cfg.rubberBand ?? 0.10;

    // ── controller gains ──────────────────────────────────────────────
    this.kp = 1.28;
    this.kd = 0.115;
    this.slipComp = lerp(0.30, 0.72, this.skill);
    this.yawDamp = lerp(0.020, 0.052, this.skill);

    // ── state ─────────────────────────────────────────────────────────
    this.pathIndex = 0;
    this.pathS = 0;
    this._hasS = false;
    this.lapsSeen = 0;
    this.lateralOffset = 0;
    this.headingError = 0;
    this._prevHeadingError = 0;
    this._errRate = 0;
    this.targetSpeed = 0;
    this.throttleOut = 0;
    this.brakeOut = 0;
    this.steerOut = 0;
    this.handbrakeOut = 0;
    this.noisePhase = this.rng.next() * TAU;
    this.noisePhase2 = this.rng.next() * TAU;
    this.mistakeTimer = 0;
    this.mistakeSteer = 0;
    this.reverseTimer = 0;
    this.recoverTimer = 0;
    this.stuckAttempts = 0;
    this.handbrakeTimer = 0;
    this.fireCooldown = this.rng.range(0.4, 1.6);
    this.castPhase = car.id % 3;
    this.avoidBias = 0;
    this.wallBias = 0;
    /** @type {Map<any, {id:any, risk:number, points:THREE.Vector3[]}>|null} */
    this.shortcuts = null;
    this.activeShortcut = null;
    this.shortcutStep = 0;
    this.shortcutTimer = 0;
    this.shortcutCooldown = 0;
    this._releaseFire = false;
    /** Distance from the racing line (m) — nice for debug overlays. */
    this.lineError = 0;
    /** Progress along the path in metres, monotonic across laps. */
    this.pathProgress = 0;

    // Delay lines.
    this._dSteer = new Float32Array(DELAY_LEN);
    this._dThrottle = new Float32Array(DELAY_LEN);
    this._dBrake = new Float32Array(DELAY_LEN);
    this._dHand = new Float32Array(DELAY_LEN);
    this._dHead = 0;

    /** Reused array for overlapSphere queries (kept out of the hot path). */
    this._bodies = [];
  }

  /** @param {AIPath|null} path */
  setPath(path) {
    this.path = path;
    if (path && this.car.body) {
      const pr = path.projectGlobal(this.car.body.position);
      this.pathIndex = pr.index;
      this.pathS = pr.s;
      this.pathProgress = pr.s;
      this._hasS = true;
    }
  }

  reset() {
    this.lateralOffset = 0;
    this.headingError = 0;
    this._prevHeadingError = 0;
    this._errRate = 0;
    this.throttleOut = 0; this.brakeOut = 0; this.steerOut = 0; this.handbrakeOut = 0;
    this.reverseTimer = 0; this.recoverTimer = 0; this.stuckAttempts = 0;
    this.mistakeTimer = 0; this.mistakeSteer = 0; this.handbrakeTimer = 0;
    this.avoidBias = 0; this.wallBias = 0;
    this.activeShortcut = null; this.shortcutStep = 0;
    this.shortcutTimer = 0; this.shortcutCooldown = 1.5;
    this._dSteer.fill(0); this._dThrottle.fill(0); this._dBrake.fill(0); this._dHand.fill(0);
    if (this.path && this.car.body) {
      const pr = this.path.projectGlobal(this.car.body.position);
      this.pathIndex = pr.index;
      this.pathS = pr.s;
      this.pathProgress = pr.s;
      this._hasS = true;
    }
  }

  /**
   * Compute and apply controls for one fixed step.
   * @param {number} dt
   */
  update(dt) {
    const car = this.car;
    if (!this.enabled || !car.body) return;

    if (car.finished) {
      // Cool-down lap: keep driving, but calmly.
      this._driveNormal(dt, 0.55);
      return;
    }
    if (!this.path) {
      this._driveBlind(dt);
      return;
    }
    this._driveNormal(dt, 1);
  }

  // ───────────────────────────────────────────────────── no-path fallback

  /** No AI path on this track: creep forward and steer away from walls. */
  _driveBlind(dt) {
    const car = this.car;
    this.noisePhase += dt * 0.7;
    const wander = Math.sin(this.noisePhase) * 0.25;
    this._probeWalls(dt);
    const steer = clamp(wander + this.wallBias * 1.6, -1, 1);
    car.applyControl({
      throttle: car.upsideDown ? 0 : 0.42,
      brake: 0,
      steer,
      handbrake: 0,
    });
  }

  // ───────────────────────────────────────────────────── main loop

  _driveNormal(dt, effort) {
    const car = this.car;
    const body = car.body;
    const path = this.path;

    body.getForward(_fwd);
    body.getRight(_right);
    body.getUp(_up);

    // ── 1. where am I on the path? ─────────────────────────────────────
    const pr = path.projectNear(body.position, this.pathIndex, 16, this._hasS ? this.pathS : null);
    this._hasS = true;
    // Track progress monotonically (used for rubber-banding).
    const dS = pr.s - this.pathS;
    // Seam crossings. Do NOT clamp the lap count at zero: a car spun backwards
    // over the start line has genuinely negative progress, and clamping makes
    // the accumulator drift permanently out of step with reality.
    if (dS < -path.total * 0.5) this.lapsSeen++;
    else if (dS > path.total * 0.5) this.lapsSeen--;
    this.pathS = pr.s;
    this.pathIndex = pr.index;
    this.pathProgress = this.lapsSeen * path.total + pr.s;
    this.lineError = pr.distance;

    const width = path.widthAt(pr.s, pr.index);
    const speed = car.speed;
    const absSpeed = Math.abs(speed);

    // ── 2. recovery states take priority ──────────────────────────────
    if (this._handleRecovery(dt, pr)) return;

    // ── 3. look-ahead target ──────────────────────────────────────────
    const look = this.lookAheadBase + absSpeed * this.lookAheadSpeed
      + clamp01(pr.distance / Math.max(0.4, width)) * 0.35;
    const sAim = pr.s + look;
    path.sampleAt(sAim, _target, pr.index);

    // Shortcuts: brave drivers peel off toward the entry, run the branch, and
    // rejoin at the exit. Risk is compared against this driver's nerve.
    this._updateShortcut(dt, pr);
    if (this.activeShortcut) {
      const wp = this._shortcutWaypoint();
      if (wp) {
        _target.copy(wp);
        // Aim a touch beyond the waypoint so the car does not stall on it.
        _d.subVectors(_target, body.position);
        const len = _d.length();
        if (len > 1e-4) _target.addScaledVector(_d, Math.min(0.5, look / len));
      }
    }

    // Racing line: run wide on entry, tuck to the apex.
    const kAhead = path.peakCurvatureAhead(pr.s, Math.max(0.8, absSpeed * 0.85), pr.index);
    const kNow = path.curvatureAt(sAim, pr.index);
    const cornerness = clamp01(Math.abs(kAhead) / CORNER_K);
    const apexBlend = clamp01(Math.abs(kNow) / CORNER_K);
    // Negative = toward the inside of the turn (see the sign note in _buildGeometry).
    const lineOffset = -Math.sign(kAhead || kNow) * width * 0.30
      * lerp(0.35, 1.0, this.skill)
      * lerp(cornerness * 0.55, apexBlend, 0.65);

    // Error injection: a slow lateral wander, biggest for the worst drivers.
    this.noisePhase += dt * 0.63;
    this.noisePhase2 += dt * 0.29;
    const noise = (Math.sin(this.noisePhase) * 0.65 + Math.sin(this.noisePhase2 * 2.13) * 0.35)
      * this.errorAmp;

    // Avoidance.
    this._probeCars(dt, width);
    if (((this.castPhase++) % 3) === 0) this._probeWalls(dt);

    const wantOffset = clamp(
      lineOffset + noise + this.avoidBias * width * 0.42 + this.wallBias * width * 0.40,
      -width * 0.46, width * 0.46,
    );
    this.lateralOffset = damp(this.lateralOffset, wantOffset, 5.5, dt);

    // Apply the lateral offset in the path frame.
    path.tangentAt(sAim, _t, pr.index);
    _tmp.crossVectors(_t, WORLD_UP);
    if (_tmp.lengthSq() < 1e-8) _tmp.copy(_right);
    else _tmp.normalize();
    _target.addScaledVector(_tmp, this.lateralOffset);

    // ── 4. steering ───────────────────────────────────────────────────
    body.worldToLocal(_target, _local);
    const e = Math.atan2(_local.x, Math.max(0.05, -_local.z));
    this._errRate = damp(this._errRate, (e - this._prevHeadingError) / dt, 22, dt);
    this._prevHeadingError = e;
    this.headingError = e;

    const def = car.def;
    const st = clamp01(absSpeed / Math.max(0.5, def.topSpeed));
    const lock = lerp(def.steerMax, def.steerMaxFast, st * st * 0.85 + st * 0.15);

    let angleCmd = e * this.kp + this._errRate * this.kd;
    // Counter-steer: catch the slide instead of spinning with it. Faded in with
    // speed — below walking pace the chassis slip angle is mostly noise, and
    // reacting to it just piles on lock and scrubs the car to a standstill.
    const slipAuth = clamp01((absSpeed - 1.4) / 3.0);
    angleCmd += clamp(car.slipAngle, -0.7, 0.7) * this.slipComp * slipAuth;
    angleCmd -= car.yawRate * this.yawDamp * slipAuth;
    // Cap the command at the largest steering angle that still does something.
    // Past α_peak the front tyres give LESS force, so extra lock only scrubs
    // speed and pushes the car wider — which grows the line error, which asks
    // for more lock. Heavy cars fall into that loop and crawl round at half
    // pace. The useful ceiling is the kinematic demand plus one peak slip angle.
    const aFront = Math.abs(car.def.axleZFront);
    const kinematic = Math.abs(car.slipAngle)
      + (aFront * Math.abs(car.yawRate)) / Math.max(1.2, absSpeed);
    // A front-driven car has to keep something in reserve: the SAME tyres make
    // the thrust, so once they are at their lateral peak the friction ellipse
    // leaves no longitudinal force at all and the car simply stops accelerating
    // mid-corner. Hold the fronts just under the peak instead of just over it.
    const peakMargin = car.def.drive === 'fwd' ? 0.80 : 1.35;
    const maxUseful = kinematic + car.def.tyre.peakSlipAngle * peakMargin;
    angleCmd = clamp(angleCmd, -maxUseful, maxUseful);

    let steer = clamp(angleCmd / Math.max(0.05, lock), -1, 1);

    // ── 5. speed target ───────────────────────────────────────────────
    // Scale the shared profile by this car's actual grip and this driver's nerve.
    const gripScale = Math.sqrt(clamp(car.lateralGripLimit() / REF_LAT_ACCEL, 0.25, 2.2));
    // The braking HORIZON has to use the same surface grip the corner target
    // does. It used to be a fixed wood-grip figure while the target was already
    // grip-scaled, so on ice the AI correctly dropped its corner speed to 42%
    // and then planned a braking distance it could not achieve — it needed 2.2x
    // what it allowed itself and sailed straight through the corner. Broken on
    // grass, dirt, gravel, ice and oil; five of our sixteen surfaces.
    const brakeAccel = this._brakeAccelFor(car);
    const horizon = 0.35 + absSpeed * absSpeed / (2 * brakeAccel * this.brakeMult);
    const limit = path.minLimitAhead(pr.s, horizon, pr.index);
    let target = limit * gripScale * this.cornerMult * this._rubberBand();
    target = Math.min(target, def.topSpeed * 1.06) * effort;
    // Off-line? Slow down a bit so we can get back on.
    if (pr.distance > width * 0.75) target *= lerp(1, 0.72, clamp01((pr.distance - width * 0.75) / width));
    this.targetSpeed = target;

    let throttle = 0;
    let brake = 0;
    const vErr = target - speed;
    if (vErr > 0.12) {
      throttle = clamp01(vErr * 1.7);
    } else if (vErr < -0.22) {
      brake = clamp01(-vErr * 0.72 * this.brakeMult);
      // Trail off the brake as we approach the target so it does not lock up.
      if (car.axleSaturation(true) > 1.02) brake *= 0.72;
    } else {
      throttle = clamp01(0.30 + vErr * 0.8);
    }

    // Throttle modulation on exit: feather while the rears are still gone.
    if (throttle > 0 && car.wheelsOnGround >= 2) {
      const rear = car.axleSaturation(false);
      if (rear > 0.98) throttle *= lerp(1, 0.55, clamp01((rear - 0.98) / 0.30));
      // And do not add power while the car is still pointing the wrong way. A
      // big slip angle is a spin in progress: keeping the throttle in holds the
      // car sideways, and on a heavy car that turns one slide into a full stop.
      const slip = Math.abs(car.slipAngle);
      if (slip > 0.28) throttle *= lerp(1, 0.42, clamp01((slip - 0.28) / 0.40));
      if (slip > 0.60) throttle *= lerp(1, 0.35, clamp01((slip - 0.60) / 0.45));
    }

    // ── understeer guard ───────────────────────────────────────────────
    // Once the front tyres are past their peak, MORE lock buys nothing and
    // costs everything: it scrubs speed and holds the fronts in the sliding
    // part of the curve. Unwind the steering and (on a front-driven car) lift,
    // which is exactly what a real driver does to get the nose back.
    if (car.wheelsOnGround >= 2) {
      const front = car.axleSaturation(true);
      if (front > 1.0) {
        const over = clamp01((front - 1.0) / 0.45);
        steer *= lerp(1, 0.62, over);
        if (car.def.drive === 'fwd' || car.def.drive === '4wd') {
          throttle *= lerp(1, 0.72, over);
        }
      }
    }

    // ── 6. handbrake for genuine hairpins ─────────────────────────────
    if (this.handbrakeTimer > 0) {
      this.handbrakeTimer -= dt;
      this.handbrakeOut = 1;
      throttle *= 0.25;
    } else {
      this.handbrakeOut = 0;
      const tight = Math.abs(kAhead) > CORNER_K * 2.4;
      if (tight && absSpeed > target * 1.35 && absSpeed > 2.2
        && this.skill > 0.55 && this.aggression > 0.45 && car.wheelsOnGround >= 3) {
        this.handbrakeTimer = lerp(0.16, 0.30, this.rng.next());
      }
    }

    // ── 7. airborne: land flat and straight ───────────────────────────
    if (car.airborne && car.airTime > 0.10) {
      const pitch = car.pitchAngle;      // + = nose up
      if (pitch > 0.10) { throttle = clamp01(0.6 + pitch); brake = 0; }
      else if (pitch < -0.34) { brake = clamp01((-pitch - 0.34) * 2.4); throttle = 0; }
      else { throttle *= 0.5; brake = 0; }
      // Use the air yaw to point back down the track, gently.
      steer = clamp(steer * 0.6 + e * 0.5, -1, 1);
      this.handbrakeOut = 0;
    }

    // ── 8. mistakes ───────────────────────────────────────────────────
    if (this.mistakeTimer > 0) {
      this.mistakeTimer -= dt;
      steer = clamp(steer + this.mistakeSteer, -1, 1);
      throttle *= 0.55;
    } else if (cornerness > 0.4 && this.rng.next() < this.mistakeChance * dt) {
      this.mistakeTimer = this.rng.range(0.18, 0.55);
      this.mistakeSteer = this.rng.sign() * this.rng.range(0.18, 0.45);
    }

    // ── 9. weapons ────────────────────────────────────────────────────
    this._useWeapon(dt);

    // ── 10. reaction delay, then commit ───────────────────────────────
    this._commit(steer, throttle, brake, this.handbrakeOut);
  }

  /** Push the raw command through the delay line and apply the delayed one. */
  _commit(steer, throttle, brake, handbrake) {
    const h = this._dHead;
    this._dSteer[h] = steer;
    this._dThrottle[h] = throttle;
    this._dBrake[h] = brake;
    this._dHand[h] = handbrake;
    this._dHead = (h + 1) % DELAY_LEN;
    const r = (h - this.delaySteps + DELAY_LEN) % DELAY_LEN;
    this.steerOut = this._dSteer[r];
    this.throttleOut = this._dThrottle[r];
    this.brakeOut = this._dBrake[r];
    this.handbrakeOut = this._dHand[r];
    this.car.applyControl({
      steer: this.steerOut,
      throttle: this.throttleOut,
      brake: this.brakeOut,
      handbrake: this.handbrakeOut,
    });
  }

  /** Bypass the delay line — recovery needs to be decisive. */
  _commitDirect(steer, throttle, brake, handbrake) {
    this.steerOut = steer;
    this.throttleOut = throttle;
    this.brakeOut = brake;
    this.handbrakeOut = handbrake;
    this._dSteer.fill(steer);
    this._dThrottle.fill(throttle);
    this._dBrake.fill(brake);
    this._dHand.fill(handbrake);
    this.car.applyControl({ steer, throttle, brake, handbrake });
  }

  // ───────────────────────────────────────────────────── rubber band

  _rubberBand() {
    const rb = this.rubberBand;
    if (rb <= 0) return 1;
    const game = this.game;
    const player = game?.playerCar;
    if (!player || player === this.car) return 1;
    let delta = 0;
    if (player.progress > 0 || this.car.progress > 0) {
      delta = (player.progress - this.car.progress) * 6;
    } else {
      const pd = player.aiDriver?.pathProgress;
      if (pd !== undefined && this.path) {
        delta = (pd - this.pathProgress) / Math.max(1, this.path.total * 0.35);
      }
    }
    return 1 + rb * clamp(delta, -1, 1);
  }

  // ───────────────────────────────────────────────────── recovery

  /**
   * @returns {boolean} true when recovery took over and normal driving should
   *          be skipped this step.
   */
  _handleRecovery(dt, pr) {
    const car = this.car;

    // Upside down: hand it to the respawn manager and coast.
    if (car.upsideDown) {
      this.recoverTimer += dt;
      if (this.recoverTimer > 1.5) {
        car.respawn(car.checkpoint);
        this.recoverTimer = 0;
        this.stuckAttempts = 0;
      }
      this._commitDirect(0, 0, 0, 0);
      return true;
    }

    // Reversing out of trouble.
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      // While reversing, `brake` is the reverse pedal (see Drivetrain).
      const away = -Math.sign(this.headingError || 0.4);
      this._commitDirect(clamp(away, -1, 1), 0, 1, 0);
      if (this.reverseTimer <= 0) this.recoverTimer = 0;
      return true;
    }

    // Beached? Try reversing, then give up and respawn.
    if (car.stuckTime > 1.05) {
      car.stuckTime = 0;
      this.stuckAttempts++;
      if (this.stuckAttempts >= 3) {
        car.respawn(car.checkpoint);
        this.stuckAttempts = 0;
      } else {
        this.reverseTimer = 0.85;
      }
      this._commitDirect(0, 0, 1, 0);
      return true;
    }

    // Miles off the racing line and not moving much — walk it back or respawn.
    if (pr && this.path) {
      const w = this.path.widthAt(pr.s, pr.index);
      if (pr.distance > Math.max(3.0, w * 3.2)) {
        this.recoverTimer += dt;
        if (this.recoverTimer > 4.5) {
          car.respawn(car.checkpoint);
          this.recoverTimer = 0;
        }
      } else if (Math.abs(car.speed) > 0.6) {
        this.recoverTimer = Math.max(0, this.recoverTimer - dt * 2);
      }
    }
    if (this.stuckAttempts > 0 && Math.abs(car.speed) > 1.4) this.stuckAttempts = 0;
    return false;
  }

  // ───────────────────────────────────────────────────── shortcuts

  /**
   * Register the track's shortcut table.
   * Each entry is `{ id, entry, exit, risk, nodes? }`; `entry`/`exit` may be a
   * Vector3-ish position and `nodes` an optional list of way-points through the
   * branch. Anything missing simply disables that shortcut.
   * @param {Array<object>|null} shortcuts
   */
  setShortcuts(shortcuts) {
    this.shortcuts = new Map();
    if (!Array.isArray(shortcuts)) return;
    for (const sc of shortcuts) {
      if (!sc || sc.id === undefined || sc.id === null) continue;
      const pts = [];
      const push = (p) => {
        if (!p) return;
        const x = p.x ?? p[0]; const y = p.y ?? p[1]; const z = p.z ?? p[2];
        if (x === undefined || y === undefined || z === undefined) return;
        pts.push(new THREE.Vector3(x, y, z));
      };
      push(sc.entry);
      if (Array.isArray(sc.nodes)) for (const nd of sc.nodes) push(nd.position ?? nd);
      push(sc.exit);
      if (pts.length === 0) continue;
      this.shortcuts.set(sc.id, { id: sc.id, risk: clamp01(sc.risk ?? 0.5), points: pts });
    }
  }

  _updateShortcut(dt, pr) {
    const car = this.car;
    if (this.shortcutCooldown > 0) this.shortcutCooldown -= dt;

    if (this.activeShortcut) {
      const wp = this._shortcutWaypoint();
      if (!wp) { this._endShortcut(); return; }
      _d.subVectors(wp, car.body.position);
      const reach = 0.35 + Math.abs(car.speed) * 0.12;
      if (_d.lengthSq() < reach * reach) {
        this.shortcutStep++;
        if (this.shortcutStep >= this.activeShortcut.points.length) this._endShortcut();
      }
      this.shortcutTimer += dt;
      // Bail out if it is clearly not working (blocked, flipped, lost).
      if (this.shortcutTimer > 8 || car.upsideDown) this._endShortcut();
      return;
    }

    if (!this.shortcuts || this.shortcuts.size === 0 || this.shortcutCooldown > 0) return;
    const id = this.path?.shortcut?.[pr.index];
    if (id === null || id === undefined) return;
    const sc = this.shortcuts.get(id);
    if (!sc) return;
    if (this.shortcutNerve < sc.risk) return;
    // Not while already in trouble.
    if (car.upsideDown || car.airborne || Math.abs(car.speed) < 0.8) return;
    this.activeShortcut = sc;
    this.shortcutStep = 0;
    this.shortcutTimer = 0;
  }

  _shortcutWaypoint() {
    const sc = this.activeShortcut;
    if (!sc) return null;
    return sc.points[this.shortcutStep] ?? null;
  }

  _endShortcut() {
    this.activeShortcut = null;
    this.shortcutStep = 0;
    this.shortcutTimer = 0;
    this.shortcutCooldown = 3.0;
    // Re-acquire the main line after leaving the branch.
    if (this.path && this.car.body) {
      const pr = this.path.projectGlobal(this.car.body.position);
      this.pathIndex = pr.index;
      this.pathS = pr.s;
    }
  }

  // ───────────────────────────────────────────────────── perception

  /** Lateral avoidance against the other cars. Cheap, no queries. */
  _probeCars(dt, width) {
    const cars = this.game?.cars;
    const car = this.car;
    let bias = 0;
    if (cars && cars.length > 1) {
      const range = 0.30 + Math.abs(car.speed) * 0.14;
      const half = Math.max(0.10, width * 0.30);
      for (let i = 0; i < cars.length; i++) {
        const other = cars[i];
        if (other === car || !other.body) continue;
        _d.subVectors(other.body.position, car.body.position);
        const ahead = _d.dot(_fwd);
        if (ahead < -0.08 || ahead > range) continue;
        const lat = _d.dot(_right);
        const vert = Math.abs(_d.dot(_up));
        if (Math.abs(lat) > half + 0.09 || vert > 0.12) continue;
        // Closing speed matters — only dodge things we are actually catching.
        const closing = (car.speed - other.speed);
        const urgency = clamp01(1 - ahead / range) * clamp01(0.35 + closing * 0.55);
        // Steer around the side we are already on; break ties by aggression.
        const dir = Math.abs(lat) > 0.012 ? -Math.sign(lat) : (this.aggression > 0.5 ? 1 : -1);
        bias += dir * urgency * lerp(0.55, 1.05, this.aggression);
      }
    }
    this.avoidBias = damp(this.avoidBias, clamp(bias, -1.1, 1.1), 7, dt);
  }

  /**
   * Braking deceleration this car can actually achieve right now, m/s².
   *
   * `REF_BRAKE_ACCEL` is the grip-1.00 figure; braking is friction-limited, so
   * it scales with the surface under the wheels exactly as the cornering limit
   * does. `lateralGripLimit()` already averages mu over the loaded wheels and
   * multiplies by gravity, so the ratio against REF_LAT_ACCEL is the surface
   * grip factor. Floored so a car briefly airborne or on oil still plans a
   * finite stopping distance instead of a horizon that runs away to infinity.
   */
  _brakeAccelFor(car) {
    const g = clamp(car.lateralGripLimit() / REF_LAT_ACCEL, 0.12, 1.6);
    return REF_BRAKE_ACCEL * g;
  }

  /**
   * Short forward sphere-cast for walls. Throttled to every third step so eight
   * drivers cost 320 casts/s, not 960.
   */
  _probeWalls(dt) {
    const physics = this.game?.physics;
    const car = this.car;
    if (!physics?.sphereCast || !physics.staticMeshes?.length) {
      this.wallBias = damp(this.wallBias, 0, 6, dt || 1 / 120);
      return;
    }
    const body = car.body;
    body.getForward(_fwd);
    body.getRight(_right);
    const dist = 0.28 + Math.abs(car.speed) * 0.16;
    _p.copy(body.position).addScaledVector(_fwd, car.def.hullHalf[2] * 0.6);
    _p.y += 0.012;
    let bias = 0;
    // Two angled probes: cheaper and more informative than one straight one.
    for (let s = -1; s <= 1; s += 2) {
      _t.copy(_fwd).addScaledVector(_right, s * 0.42).normalize();
      // Statics only: sphereCast approximates dynamic bodies by their bounding
      // sphere (up to sqrt(3) oversized on a box), so including PROP would make
      // the AI swerve around a phantom wall next to every cone.
      if (physics.sphereCast(_p, _t, car.def.tyre.radius * 0.8, dist, _hit, Layer.NONE)) {
        // Ignore drivable slopes — only react to something wall-like.
        if (_hit.normal.y < 0.55) {
          bias -= s * (1 - _hit.distance / dist) * 1.05;
        }
      }
    }
    this.wallBias = damp(this.wallBias, clamp(bias, -1.2, 1.2), 9, dt || 1 / 120);
  }

  // ───────────────────────────────────────────────────── weapons

  /**
   * Use the current pickup sensibly:
   *   forward / target → fire when someone is ahead and roughly lined up
   *   back / drop      → fire when someone is close behind
   *   self             → fire on a straight, on the ground
   */
  _useWeapon(dt) {
    if (this.fireCooldown > 0) { this.fireCooldown -= dt; return; }
    const car = this.car;
    const w = car.weapon;
    if (!w) return;
    const mode = w.aimMode ?? 'forward';
    const cars = this.game?.cars;
    let fire = false;

    if (mode === 'forward' || mode === 'target') {
      if (cars) {
        const range = 6.5;
        for (let i = 0; i < cars.length; i++) {
          const o = cars[i];
          if (o === car || !o.body || o.finished) continue;
          _d.subVectors(o.body.position, car.body.position);
          const ahead = _d.dot(_fwd);
          if (ahead < 0.25 || ahead > range) continue;
          const lat = Math.abs(_d.dot(_right));
          // ~22° cone, widening with distance.
          if (lat > 0.14 + ahead * 0.22) continue;
          fire = true;
          break;
        }
      }
    } else if (mode === 'back' || mode === 'drop') {
      if (cars) {
        for (let i = 0; i < cars.length; i++) {
          const o = cars[i];
          if (o === car || !o.body || o.finished) continue;
          _d.subVectors(o.body.position, car.body.position);
          const behind = -_d.dot(_fwd);
          if (behind < 0.2 || behind > 3.6) continue;
          if (Math.abs(_d.dot(_right)) > 0.55) continue;
          fire = true;
          break;
        }
      }
      // Mines and oil are also worth dropping on a corner exit even if nobody
      // is right behind, if the driver is feeling mean.
      if (!fire && mode === 'drop' && this.aggression > 0.7 && this.rng.next() < 0.25 * dt) {
        fire = true;
      }
    } else if (mode === 'self') {
      const straight = this.path
        ? Math.abs(this.path.peakCurvatureAhead(this.pathS, 2.5, this.pathIndex)) < CORNER_K * 0.55
        : true;
      fire = straight && !car.airborne && car.wheelsOnGround >= 3 && Math.abs(car.speed) > 1.2;
    } else {
      fire = this.rng.next() < 0.6 * dt;
    }

    if (fire) {
      car.requestFire();
      car.applyControl({ fire: true });
      this.fireCooldown = lerp(0.75, 0.28, this.skill);
      // Release the button next step so edge detection works for the next shot.
      this._releaseFire = true;
    } else if (this._releaseFire) {
      car.applyControl({ fire: false });
      this._releaseFire = false;
    }
  }

  /** Debug label. */
  describe() {
    return `AI#${this.car.id} ${this.car.def.name} skill=${this.skill.toFixed(2)} `
      + `agg=${this.aggression.toFixed(2)} v=${this.car.speed.toFixed(2)}/${this.targetSpeed.toFixed(2)}`;
  }
}

export default AIDriver;
