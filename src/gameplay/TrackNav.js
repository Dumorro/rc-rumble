/**
 * TrackNav — arc-length centreline lookup table.
 *
 * Every gameplay rule that needs "where am I round the lap?" goes through here:
 * race progress, standings gaps, wrong-way detection, respawn placement, weapon
 * targeting and AI rubber-banding.
 *
 * The table is built once per race from whichever centreline source the track
 * offers, in order of preference:
 *
 *   1. `track.spline.sample(t)`  → { position, tangent, normal, width }
 *   2. `track.spline.getPointAt(t)` (a plain THREE.Curve)
 *   3. `track.aiPath.nodes[]`    → { position, width }
 *   4. `track.checkpoints[]`     → { position }
 *
 * Samples are **uniform in arc length**, so `u ∈ [0,1)` advances at a rate
 * proportional to speed — which is what makes `progress` a fair standings key
 * and makes the gap-in-seconds maths behave.
 *
 * Every query is allocation free: results land in `nav.hit`, a scratch record
 * owned by the instance. Copy anything you want to keep.
 */

import * as THREE from 'three';

const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _t = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Wrap a value into [0,1). */
export function wrap01(u) {
  u -= Math.floor(u);
  return u >= 1 ? 0 : u;
}

/** Shortest signed difference b - a on a unit loop → [-0.5, 0.5]. */
export function loopDelta(a, b) {
  let d = b - a;
  d -= Math.floor(d);
  if (d > 0.5) d -= 1;
  return d;
}

/** Closed Catmull-Rom on a flat Float32Array of xyz control points. */
function catmullClosed(ctrl, n, s, out) {
  const f = s * n;
  let i1 = Math.floor(f);
  const t = f - i1;
  i1 = ((i1 % n) + n) % n;
  const i0 = (i1 - 1 + n) % n;
  const i2 = (i1 + 1) % n;
  const i3 = (i1 + 2) % n;
  const t2 = t * t, t3 = t2 * t;
  for (let c = 0; c < 3; c++) {
    const p0 = ctrl[i0 * 3 + c], p1 = ctrl[i1 * 3 + c];
    const p2 = ctrl[i2 * 3 + c], p3 = ctrl[i3 * 3 + c];
    const v = 0.5 * ((2 * p1) + (-p0 + p2) * t
      + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
      + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    if (c === 0) out.x = v; else if (c === 1) out.y = v; else out.z = v;
  }
  return out;
}

export class TrackNav {
  /**
   * @param {object|null} track TrackData (or null — the nav then reports !ready)
   * @param {{samples?:number, dense?:number, searchWindow?:number}} [opts]
   */
  constructor(track = null, opts = {}) {
    /** True when a usable centreline was found. */
    this.ready = false;
    /** Where the centreline came from: 'spline' | 'curve' | 'aiPath' | 'checkpoints' | 'none'. */
    this.source = 'none';
    /** Number of arc-length-uniform samples. */
    this.count = 0;
    /** Total centreline length, metres. */
    this.length = 0;
    /** Metres between consecutive samples. */
    this.spacing = 0;

    /** @type {Float32Array|null} 3N sample positions */
    this.pos = null;
    /** @type {Float32Array|null} 3N unit tangents (direction of travel) */
    this.tan = null;
    /** @type {Float32Array|null} N half-widths, metres */
    this.halfWidth = null;

    /** Scratch result record — reused by every query. */
    this.hit = {
      u: 0,
      index: 0,
      distance: 0,
      distanceSq: 0,
      /** Signed offset from the centreline; +right of travel. */
      lateral: 0,
      /** Vertical offset from the centreline. */
      height: 0,
      halfWidth: 1.5,
      point: new THREE.Vector3(),
      tangent: new THREE.Vector3(0, 0, -1),
    };

    /** Samples scanned either side of a hint before falling back to a full scan. */
    this.searchWindow = opts.searchWindow ?? 44;

    // Coarse XZ grid over the samples so a cold (hintless) query stays cheap.
    this._grid = null;
    this._gridCell = 1;
    this._gridMinX = 0;
    this._gridMinZ = 0;
    this._gridW = 0;
    this._gridH = 0;

    this.bounds = new THREE.Box3();

    try { this._build(track, opts); }
    catch (err) {
      console.warn('[TrackNav] build failed — progress tracking disabled:', err);
      this.ready = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════ build

  _build(track, opts) {
    if (!track) return;

    const dense = Math.max(256, opts.dense ?? 2048);
    let densePos = null;
    let denseWidth = null;
    let denseCount = 0;

    const spline = track.spline;

    if (spline && typeof spline.sample === 'function') {
      densePos = new Float32Array(dense * 3);
      denseWidth = new Float32Array(dense);
      for (let i = 0; i < dense; i++) {
        const s = spline.sample(i / dense);
        const p = s?.position ?? s?.point ?? s;
        if (!p || typeof p.x !== 'number') { densePos = null; break; }
        densePos[i * 3] = p.x; densePos[i * 3 + 1] = p.y; densePos[i * 3 + 2] = p.z;
        denseWidth[i] = Math.max(0.4, (s?.width ?? 3.0)) * 0.5;
      }
      if (densePos) { denseCount = dense; this.source = 'spline'; }
    }

    if (!densePos && spline && typeof spline.getPointAt === 'function') {
      densePos = new Float32Array(dense * 3);
      denseWidth = new Float32Array(dense);
      for (let i = 0; i < dense; i++) {
        const p = spline.getPointAt(i / dense, _p);
        densePos[i * 3] = p.x; densePos[i * 3 + 1] = p.y; densePos[i * 3 + 2] = p.z;
        denseWidth[i] = 1.5;
      }
      denseCount = dense;
      this.source = 'curve';
    }

    if (!densePos) {
      // Control-point sources: resample a closed Catmull-Rom through them.
      let ctrlPts = null;
      let ctrlWidth = null;
      const nodes = track.aiPath?.nodes;
      if (Array.isArray(nodes) && nodes.length >= 3) {
        ctrlPts = nodes;
        ctrlWidth = nodes.map(n => Math.max(0.4, n?.width ?? 3.0) * 0.5);
        this.source = 'aiPath';
      } else if (Array.isArray(track.checkpoints) && track.checkpoints.length >= 3) {
        ctrlPts = track.checkpoints;
        ctrlWidth = track.checkpoints.map(c => Math.max(0.4, (c?.halfExtents?.x ?? 1.5) * 2) * 0.5);
        this.source = 'checkpoints';
      }
      if (!ctrlPts) return;

      const k = ctrlPts.length;
      const ctrl = new Float32Array(k * 3);
      for (let i = 0; i < k; i++) {
        const p = ctrlPts[i]?.position ?? ctrlPts[i];
        if (!p || typeof p.x !== 'number') return;
        ctrl[i * 3] = p.x; ctrl[i * 3 + 1] = p.y; ctrl[i * 3 + 2] = p.z;
      }
      denseCount = Math.max(dense, k * 48);
      densePos = new Float32Array(denseCount * 3);
      denseWidth = new Float32Array(denseCount);
      for (let i = 0; i < denseCount; i++) {
        const s = i / denseCount;
        catmullClosed(ctrl, k, s, _p);
        densePos[i * 3] = _p.x; densePos[i * 3 + 1] = _p.y; densePos[i * 3 + 2] = _p.z;
        const w = ctrlWidth[Math.min(ctrlWidth.length - 1, Math.floor(s * k))] ?? 1.5;
        denseWidth[i] = w;
      }
    }

    // ── cumulative arc length over the dense samples (closed loop) ──
    const cum = new Float64Array(denseCount + 1);
    for (let i = 0; i < denseCount; i++) {
      const j = (i + 1) % denseCount;
      const dx = densePos[j * 3] - densePos[i * 3];
      const dy = densePos[j * 3 + 1] - densePos[i * 3 + 1];
      const dz = densePos[j * 3 + 2] - densePos[i * 3 + 2];
      cum[i + 1] = cum[i] + Math.hypot(dx, dy, dz);
    }
    const total = cum[denseCount];
    if (!(total > 0.5)) return;   // degenerate centreline — bail, stay !ready

    // ── resample uniformly in arc length ──
    const target = Math.max(128, Math.min(4096, opts.samples ?? Math.round(total * 2.2)));
    const n = target;
    this.count = n;
    this.length = total;
    this.spacing = total / n;
    this.pos = new Float32Array(n * 3);
    this.tan = new Float32Array(n * 3);
    this.halfWidth = new Float32Array(n);

    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const s = (i / n) * total;
      while (cursor < denseCount - 1 && cum[cursor + 1] < s) cursor++;
      const seg = cum[cursor + 1] - cum[cursor];
      const f = seg > 1e-9 ? (s - cum[cursor]) / seg : 0;
      const a = cursor, b = (cursor + 1) % denseCount;
      this.pos[i * 3] = densePos[a * 3] + (densePos[b * 3] - densePos[a * 3]) * f;
      this.pos[i * 3 + 1] = densePos[a * 3 + 1] + (densePos[b * 3 + 1] - densePos[a * 3 + 1]) * f;
      this.pos[i * 3 + 2] = densePos[a * 3 + 2] + (densePos[b * 3 + 2] - densePos[a * 3 + 2]) * f;
      this.halfWidth[i] = denseWidth[a] + (denseWidth[b] - denseWidth[a]) * f;
    }

    // ── tangents from central differences of the uniform samples ──
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      let dx = this.pos[b * 3] - this.pos[a * 3];
      let dy = this.pos[b * 3 + 1] - this.pos[a * 3 + 1];
      let dz = this.pos[b * 3 + 2] - this.pos[a * 3 + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      this.tan[i * 3] = dx / l; this.tan[i * 3 + 1] = dy / l; this.tan[i * 3 + 2] = dz / l;
    }

    this.bounds.makeEmpty();
    for (let i = 0; i < n; i++) {
      _p.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.bounds.expandByPoint(_p);
    }

    this._buildGrid();
    this.ready = true;
  }

  /** Uniform XZ bucket grid: each cell stores the index of one nearby sample. */
  _buildGrid() {
    const n = this.count;
    const b = this.bounds;
    const spanX = Math.max(1, b.max.x - b.min.x);
    const spanZ = Math.max(1, b.max.z - b.min.z);
    const cell = Math.max(0.5, Math.max(spanX, spanZ) / 48);
    const w = Math.max(1, Math.ceil(spanX / cell) + 1);
    const h = Math.max(1, Math.ceil(spanZ / cell) + 1);
    const grid = new Int32Array(w * h).fill(-1);
    for (let i = 0; i < n; i++) {
      const gx = Math.min(w - 1, Math.max(0, Math.floor((this.pos[i * 3] - b.min.x) / cell)));
      const gz = Math.min(h - 1, Math.max(0, Math.floor((this.pos[i * 3 + 2] - b.min.z) / cell)));
      grid[gz * w + gx] = i;
    }
    this._grid = grid;
    this._gridCell = cell;
    this._gridMinX = b.min.x;
    this._gridMinZ = b.min.z;
    this._gridW = w;
    this._gridH = h;
  }

  // ═══════════════════════════════════════════════════════════════ queries

  /**
   * Closest point on the centreline. Allocation free — reads into `nav.hit`.
   *
   * @param {THREE.Vector3} point
   * @param {number} [hintU] previous `u` for this actor; a local scan around it
   *        is ~20× cheaper than a full scan. Pass < 0 to force a full search.
   * @returns {object|null} `nav.hit`, or null when the nav is not ready.
   */
  closest(point, hintU = -1) {
    if (!this.ready) return null;
    return this.closestRaw(point.x, point.y, point.z, hintU);
  }

  closestRaw(x, y, z, hintU = -1) {
    if (!this.ready) return null;
    const n = this.count;
    const pos = this.pos;
    let bestI = 0, bestSq = Infinity;

    if (hintU >= 0) {
      const w = this.searchWindow;
      let i = Math.round(hintU * n) - w;
      i = ((i % n) + n) % n;
      const span = w * 2 + 1;
      for (let k = 0; k < span; k++) {
        const o = i * 3;
        const dx = pos[o] - x, dy = pos[o + 1] - y, dz = pos[o + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestSq) { bestSq = d; bestI = i; }
        if (++i >= n) i = 0;
      }
      // Local scan drifted too far from the line? Fall back to a global search.
      const localRadius = this.spacing * w;
      if (bestSq > localRadius * localRadius) bestSq = Infinity;
    }

    if (bestSq === Infinity) {
      // Grid probe seeds a good candidate, then a coarse stride scan confirms.
      const seed = this._gridSeed(x, z);
      if (seed >= 0) {
        const o = seed * 3;
        const dx = pos[o] - x, dy = pos[o + 1] - y, dz = pos[o + 2] - z;
        bestSq = dx * dx + dy * dy + dz * dz;
        bestI = seed;
      }
      const stride = Math.max(1, Math.floor(n / 256));
      for (let i = 0; i < n; i += stride) {
        const o = i * 3;
        const dx = pos[o] - x, dy = pos[o + 1] - y, dz = pos[o + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestSq) { bestSq = d; bestI = i; }
      }
      // Refine inside the winning stride window.
      let i = ((bestI - stride) % n + n) % n;
      const span = stride * 2 + 1;
      for (let k = 0; k < span; k++) {
        const o = i * 3;
        const dx = pos[o] - x, dy = pos[o + 1] - y, dz = pos[o + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestSq) { bestSq = d; bestI = i; }
        if (++i >= n) i = 0;
      }
    }

    return this._refine(bestI, x, y, z);
  }

  _gridSeed(x, z) {
    const g = this._grid;
    if (!g) return -1;
    const cell = this._gridCell;
    const gx = Math.min(this._gridW - 1, Math.max(0, Math.floor((x - this._gridMinX) / cell)));
    const gz = Math.min(this._gridH - 1, Math.max(0, Math.floor((z - this._gridMinZ) / cell)));
    for (let r = 0; r <= 2; r++) {
      for (let dz = -r; dz <= r; dz++) {
        const zz = gz + dz;
        if (zz < 0 || zz >= this._gridH) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const xx = gx + dx;
          if (xx < 0 || xx >= this._gridW) continue;
          const v = g[zz * this._gridW + xx];
          if (v >= 0) return v;
        }
      }
    }
    return -1;
  }

  /** Sub-sample projection onto the two segments adjacent to sample `i`. */
  _refine(i, x, y, z) {
    const n = this.count, pos = this.pos;
    const prev = (i - 1 + n) % n, next = (i + 1) % n;
    let bestF = 0, bestBase = i, bestSq = Infinity;

    for (let s = 0; s < 2; s++) {
      const a = s === 0 ? prev : i;
      const b = s === 0 ? i : next;
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const len2 = ex * ex + ey * ey + ez * ez;
      let f = len2 > 1e-12 ? ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / len2 : 0;
      if (f < 0) f = 0; else if (f > 1) f = 1;
      const cx = ax + ex * f, cy = ay + ey * f, cz = az + ez * f;
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestSq) { bestSq = d; bestF = f; bestBase = a; }
    }

    const a = bestBase, b = (bestBase + 1) % n;
    const hit = this.hit;
    hit.index = bestBase;
    hit.distanceSq = bestSq;
    hit.distance = Math.sqrt(bestSq);
    hit.u = wrap01((a + bestF) / n);
    hit.point.set(
      pos[a * 3] + (pos[b * 3] - pos[a * 3]) * bestF,
      pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * bestF,
      pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * bestF,
    );
    hit.tangent.set(
      this.tan[a * 3] + (this.tan[b * 3] - this.tan[a * 3]) * bestF,
      this.tan[a * 3 + 1] + (this.tan[b * 3 + 1] - this.tan[a * 3 + 1]) * bestF,
      this.tan[a * 3 + 2] + (this.tan[b * 3 + 2] - this.tan[a * 3 + 2]) * bestF,
    );
    if (hit.tangent.lengthSq() < 1e-8) hit.tangent.set(0, 0, -1); else hit.tangent.normalize();
    hit.halfWidth = this.halfWidth[a] + (this.halfWidth[b] - this.halfWidth[a]) * bestF;

    // Signed lateral offset: +right of travel, using world up as the reference.
    const dx = x - hit.point.x, dy = y - hit.point.y, dz = z - hit.point.z;
    // right = tangent × up  (Y-up, right-handed)
    const rx = hit.tangent.z * _up.y - hit.tangent.y * _up.z;
    const ry = hit.tangent.x * _up.z - hit.tangent.z * _up.x;
    const rz = hit.tangent.y * _up.x - hit.tangent.x * _up.y;
    const rl = Math.hypot(rx, ry, rz) || 1;
    hit.lateral = (dx * rx + dy * ry + dz * rz) / rl;
    hit.height = dy;
    return hit;
  }

  /** Centreline position at `u`. */
  positionAt(u, out) {
    if (!this.ready) return out.set(0, 0, 0);
    const n = this.count;
    const f = wrap01(u) * n;
    const a = Math.floor(f) % n, b = (a + 1) % n, t = f - Math.floor(f);
    return out.set(
      this.pos[a * 3] + (this.pos[b * 3] - this.pos[a * 3]) * t,
      this.pos[a * 3 + 1] + (this.pos[b * 3 + 1] - this.pos[a * 3 + 1]) * t,
      this.pos[a * 3 + 2] + (this.pos[b * 3 + 2] - this.pos[a * 3 + 2]) * t,
    );
  }

  /** Unit tangent (direction of travel) at `u`. */
  tangentAt(u, out) {
    if (!this.ready) return out.set(0, 0, -1);
    const n = this.count;
    const f = wrap01(u) * n;
    const a = Math.floor(f) % n, b = (a + 1) % n, t = f - Math.floor(f);
    out.set(
      this.tan[a * 3] + (this.tan[b * 3] - this.tan[a * 3]) * t,
      this.tan[a * 3 + 1] + (this.tan[b * 3 + 1] - this.tan[a * 3 + 1]) * t,
      this.tan[a * 3 + 2] + (this.tan[b * 3 + 2] - this.tan[a * 3 + 2]) * t,
    );
    return out.lengthSq() < 1e-8 ? out.set(0, 0, -1) : out.normalize();
  }

  /** Half-width of the racing surface at `u`, metres. */
  halfWidthAt(u) {
    if (!this.ready) return 1.5;
    const n = this.count;
    const a = Math.floor(wrap01(u) * n) % n;
    return this.halfWidth[a];
  }

  /** Advance a parameter by a distance in metres (signed). */
  advance(u, metres) {
    if (!this.ready || this.length <= 0) return u;
    return wrap01(u + metres / this.length);
  }

  /** Signed distance in metres from `a` to `b` the short way round. */
  metresBetween(a, b) {
    return loopDelta(a, b) * this.length;
  }

  /**
   * Frame at `u`: writes position + a quaternion facing along the tangent.
   * Handy for respawns and projectile aiming.
   */
  frameAt(u, outPos, outQuat) {
    this.positionAt(u, outPos);
    this.tangentAt(u, _t);
    if (outQuat) {
      // Build a look-along-tangent orientation with -Z forward.
      _p2.set(0, 0, -1);
      outQuat.setFromUnitVectors(_p2, _t);
    }
    return outPos;
  }

  dispose() {
    this.pos = this.tan = this.halfWidth = null;
    this._grid = null;
    this.ready = false;
    this.count = 0;
  }
}

export default TrackNav;
