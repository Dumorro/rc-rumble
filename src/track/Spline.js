/**
 * RC RUMBLE — track centreline spline.
 *
 * A cardinal (Catmull-Rom at tension 0.5) spline through control nodes that also
 * carries per-node **road width**, **banking** and **camber**, arc-length
 * reparameterised so `t` is a *fraction of lap distance* rather than a fraction
 * of parameter space. Everything downstream (lap progress, AI look-ahead,
 * checkpoints, the start grid, lofted geometry) speaks in that `t`.
 *
 * Design notes
 * ------------
 * * The frame is **rotation-minimising with a world-up bias**: where the tangent
 *   is not close to vertical the normal is the world up projected into the
 *   tangent's normal plane (so banking is predictable and a flat road is exactly
 *   flat), and where it *is* close to vertical (a loop-the-loop) the frame is
 *   parallel-transported from the previous sample. That gives correct behaviour
 *   on both a flat circuit and a vertical loop with no author input.
 * * Positions and tangents are always evaluated **exactly** from the spline;
 *   only the frame's normal is interpolated from the look-up table. That keeps
 *   lofted geometry watertight against `sample()` at any `t`.
 * * `sample()` / `closestPoint()` write into a caller-owned output object and
 *   allocate nothing, so they are safe in `fixedUpdate`.
 *
 * Units: metres, radians. Y-up, `-Z` forward at identity.
 */

import * as THREE from 'three';

// ───────────────────────────────────────────────────────────────── scratch
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Below this the tangent is treated as "vertical" and the frame is transported. */
const VERTICAL_EPS = 0.16;

// ───────────────────────────────────────────────────────────── sample type

/**
 * The output object of {@link CenterlineSpline#sample}. Reuse one per call site.
 */
export class SplineSample {
  constructor() {
    /** World position on the centreline. */
    this.position = new THREE.Vector3();
    /** Unit direction of travel. */
    this.tangent = new THREE.Vector3(0, 0, -1);
    /** Unit road "up" — already banked. */
    this.normal = new THREE.Vector3(0, 1, 0);
    /** Unit road "right" — already banked. `cross(tangent, normal)`. */
    this.binormal = new THREE.Vector3(1, 0, 0);
    /** Full road width in metres. */
    this.width = 3;
    /** Banking angle in radians (positive = right side lower). */
    this.banking = 0;
    /** Extra crown across the road, metres of drop at the edges. */
    this.camber = 0;
    /** Signed curvature 1/m — positive turns right (toward +binormal). */
    this.curvature = 0;
    /** Normalised lap position [0,1). */
    this.t = 0;
    /** Raw spline parameter (segment index + fraction). */
    this.u = 0;
    /** Arc length from t=0, metres. */
    this.distance = 0;
  }

  /** Point at a lateral/vertical offset from the centreline. */
  offset(lateral, vertical, out) {
    out.copy(this.position);
    out.addScaledVector(this.binormal, lateral);
    out.addScaledVector(this.normal, vertical);
    return out;
  }

  /** Orientation with `-Z` along travel and `+Y` along the road normal. */
  orientation(out) {
    _a.copy(this.tangent).multiplyScalar(-1);           // +Z of the basis
    _b.copy(this.binormal);                             // +X
    _c.copy(this.normal);                               // +Y
    _m1.makeBasis(_b, _c, _a);
    return out.setFromRotationMatrix(_m1);
  }

  copy(o) {
    this.position.copy(o.position); this.tangent.copy(o.tangent);
    this.normal.copy(o.normal); this.binormal.copy(o.binormal);
    this.width = o.width; this.banking = o.banking; this.camber = o.camber;
    this.curvature = o.curvature; this.t = o.t; this.u = o.u; this.distance = o.distance;
    return this;
  }
}

/** Output of {@link CenterlineSpline#closestPoint}. */
export class ClosestResult {
  constructor() {
    this.t = 0;
    this.u = 0;
    this.distance = 0;      // arc length along the spline
    this.position = new THREE.Vector3();
    this.tangent = new THREE.Vector3(0, 0, -1);
    this.normal = new THREE.Vector3(0, 1, 0);
    this.binormal = new THREE.Vector3(1, 0, 0);
    this.width = 3;
    this.dist = 0;          // 3D distance from the query point
    this.lateral = 0;       // signed offset along binormal (+right)
    this.vertical = 0;      // signed offset along normal (+up)
    this.forward = 0;       // signed offset along tangent (residual, ~0)
  }
}

const _scratchSample = new SplineSample();

// ─────────────────────────────────────────────────────────────── the spline

export class CenterlineSpline {
  /**
   * @param {Array<object|number[]|THREE.Vector3>} nodes control nodes. Each may be
   *   `[x,y,z]`, a `Vector3`, or `{ p|position:[x,y,z]|Vector3, w|width, bank|banking,
   *   camber, tag }`.
   * @param {object} [opts]
   * @param {boolean} [opts.closed=true]
   * @param {number}  [opts.tension=0.5] 0.5 = Catmull-Rom, higher = looser
   * @param {number}  [opts.samplesPerSegment=28] arc-length LUT density
   * @param {number}  [opts.width=3] default width when a node omits it
   * @param {'world'|'transport'} [opts.upMode='world']
   */
  constructor(nodes, opts = {}) {
    const closed = opts.closed !== false;
    const list = normaliseNodes(nodes, opts.width ?? 3);
    if (list.length < 2) {
      // Degenerate: synthesise a 4 m straight so nothing downstream explodes.
      list.length = 0;
      list.push({ x: 0, y: 0, z: 2, w: opts.width ?? 3, bank: 0, camber: 0, tag: null });
      list.push({ x: 0, y: 0, z: -2, w: opts.width ?? 3, bank: 0, camber: 0, tag: null });
    }

    const n = list.length;
    this.closed = closed && n >= 3;
    this.tension = opts.tension ?? 0.5;
    this.upMode = opts.upMode ?? 'world';
    this.nodeCount = n;
    this.segmentCount = this.closed ? n : n - 1;

    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.nw = new Float64Array(n);
    this.nb = new Float64Array(n);
    this.nc = new Float64Array(n);
    /** @type {(string|null)[]} author tags, handy for debugging. */
    this.tags = new Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = list[i].x; this.py[i] = list[i].y; this.pz[i] = list[i].z;
      this.nw[i] = list[i].w; this.nb[i] = list[i].bank; this.nc[i] = list[i].camber;
      this.tags[i] = list[i].tag ?? null;
    }

    const S = Math.max(4, Math.min(96, opts.samplesPerSegment ?? 28));
    this.samplesPerSegment = S;
    this._buildLUT();
  }

  // ───────────────────────────────────────────────────────── construction

  _buildLUT() {
    const segs = this.segmentCount;
    const S = this.samplesPerSegment;
    const M = segs * S + 1;
    this.lutCount = M;

    const lx = new Float64Array(M), ly = new Float64Array(M), lz = new Float64Array(M);
    const tx = new Float64Array(M), ty = new Float64Array(M), tz = new Float64Array(M);
    const nx = new Float64Array(M), ny = new Float64Array(M), nz = new Float64Array(M);
    const lu = new Float64Array(M);
    const ls = new Float64Array(M);

    // Positions + tangents.
    for (let i = 0; i < M; i++) {
      const u = Math.min(segs, (i / S));
      lu[i] = u;
      this._point(u, _a);
      lx[i] = _a.x; ly[i] = _a.y; lz[i] = _a.z;
      this._deriv(u, _b);
      const L = _b.length() || 1;
      tx[i] = _b.x / L; ty[i] = _b.y / L; tz[i] = _b.z / L;
    }

    // Cumulative arc length (chord sum over a dense LUT — error < 0.05 %).
    ls[0] = 0;
    for (let i = 1; i < M; i++) {
      const dx = lx[i] - lx[i - 1], dy = ly[i] - ly[i - 1], dz = lz[i] - lz[i - 1];
      ls[i] = ls[i - 1] + Math.hypot(dx, dy, dz);
    }
    this.length = ls[M - 1] || 1;

    // Frames: world-up biased, parallel transported where the tangent goes vertical.
    let px = 0, py = 1, pz = 0;         // running normal
    for (let i = 0; i < M; i++) {
      const ttx = tx[i], tty = ty[i], ttz = tz[i];
      // world up projected into the plane ⟂ tangent
      const d = tty;                     // dot(tangent, worldUp)
      let wx = -ttx * d, wy = 1 - tty * d, wz = -ttz * d;
      const wl = Math.hypot(wx, wy, wz);

      if (this.upMode === 'world' && wl > VERTICAL_EPS) {
        wx /= wl; wy /= wl; wz /= wl;
        px = wx; py = wy; pz = wz;
      } else {
        // Parallel transport the previous normal onto the new tangent plane.
        const dot = px * ttx + py * tty + pz * ttz;
        let ax = px - ttx * dot, ay = py - tty * dot, az = pz - ttz * dot;
        let al = Math.hypot(ax, ay, az);
        if (al < 1e-6) {
          // Degenerate — pick any perpendicular.
          if (Math.abs(ttx) < 0.9) { ax = 1; ay = 0; az = 0; } else { ax = 0; ay = 1; az = 0; }
          const dd = ax * ttx + ay * tty + az * ttz;
          ax -= ttx * dd; ay -= tty * dd; az -= ttz * dd;
          al = Math.hypot(ax, ay, az) || 1;
        }
        px = ax / al; py = ay / al; pz = az / al;
      }
      nx[i] = px; ny[i] = py; nz[i] = pz;
    }

    // For a closed spline in transport mode, distribute the closure twist so the
    // ribbon meets itself. (World mode closes by construction.)
    if (this.closed && this.upMode !== 'world') {
      const dot = nx[0] * nx[M - 1] + ny[0] * ny[M - 1] + nz[0] * nz[M - 1];
      const crossDot =
        (ny[M - 1] * nz[0] - nz[M - 1] * ny[0]) * tx[M - 1] +
        (nz[M - 1] * nx[0] - nx[M - 1] * nz[0]) * ty[M - 1] +
        (nx[M - 1] * ny[0] - ny[M - 1] * nx[0]) * tz[M - 1];
      const twist = Math.atan2(crossDot, dot);
      if (Math.abs(twist) > 1e-4) {
        for (let i = 1; i < M; i++) {
          const f = (twist * i) / (M - 1);
          _n1.set(nx[i], ny[i], nz[i]);
          _t1.set(tx[i], ty[i], tz[i]);
          _q1.setFromAxisAngle(_t1, f);
          _n1.applyQuaternion(_q1).normalize();
          nx[i] = _n1.x; ny[i] = _n1.y; nz[i] = _n1.z;
        }
      }
    }

    this._lx = lx; this._ly = ly; this._lz = lz;
    this._tx = tx; this._ty = ty; this._tz = tz;
    this._nx = nx; this._ny = ny; this._nz = nz;
    this._lu = lu; this._ls = ls;
  }

  // ───────────────────────────────────────────────── raw spline evaluation

  /** Control index with wrap/clamp. */
  _idx(i) {
    const n = this.nodeCount;
    if (this.closed) return ((i % n) + n) % n;
    return i < 0 ? 0 : i >= n ? n - 1 : i;
  }

  /**
   * Split a raw parameter into (segment, fraction). Closed splines **wrap**, so
   * `u = -0.2` and `u = segs + 0.3` are legal and land on the right segment —
   * that is what lets the closest-point refinement search across the seam.
   * Writes into `_segS` / `_segF` to stay allocation-free.
   */
  _seg(u) {
    const segs = this.segmentCount;
    let s, f;
    if (this.closed) {
      let uu = u % segs;
      if (uu < 0) uu += segs;
      s = Math.floor(uu);
      f = uu - s;
      if (s >= segs) { s = segs - 1; f = 1; }
    } else {
      s = Math.floor(u);
      f = u - s;
      if (s >= segs) { s = segs - 1; f = 1; }
      if (s < 0) { s = 0; f = 0; }
    }
    this._segS = s;
    this._segF = f;
  }

  /**
   * Cardinal spline position at raw parameter `u` (segment index + fraction).
   * @param {number} u @param {THREE.Vector3} out
   */
  _point(u, out) {
    this._seg(u);
    const s = this._segS, f = this._segF;
    const i0 = this._idx(s - 1), i1 = this._idx(s), i2 = this._idx(s + 1), i3 = this._idx(s + 2);
    const k = this.tension;
    const f2 = f * f, f3 = f2 * f;
    const h00 = 2 * f3 - 3 * f2 + 1;
    const h10 = f3 - 2 * f2 + f;
    const h01 = -2 * f3 + 3 * f2;
    const h11 = f3 - f2;
    out.set(
      hermite(this.px[i0], this.px[i1], this.px[i2], this.px[i3], k, h00, h10, h01, h11),
      hermite(this.py[i0], this.py[i1], this.py[i2], this.py[i3], k, h00, h10, h01, h11),
      hermite(this.pz[i0], this.pz[i1], this.pz[i2], this.pz[i3], k, h00, h10, h01, h11),
    );
    return out;
  }

  /** First derivative d/du (not normalised). */
  _deriv(u, out) {
    this._seg(u);
    const s = this._segS, f = this._segF;
    const i0 = this._idx(s - 1), i1 = this._idx(s), i2 = this._idx(s + 1), i3 = this._idx(s + 2);
    const k = this.tension;
    const f2 = f * f;
    const g00 = 6 * f2 - 6 * f;
    const g10 = 3 * f2 - 4 * f + 1;
    const g01 = -6 * f2 + 6 * f;
    const g11 = 3 * f2 - 2 * f;
    out.set(
      hermite(this.px[i0], this.px[i1], this.px[i2], this.px[i3], k, g00, g10, g01, g11),
      hermite(this.py[i0], this.py[i1], this.py[i2], this.py[i3], k, g00, g10, g01, g11),
      hermite(this.pz[i0], this.pz[i1], this.pz[i2], this.pz[i3], k, g00, g10, g01, g11),
    );
    return out;
  }

  /** Second derivative d²/du². */
  _deriv2(u, out) {
    this._seg(u);
    const s = this._segS, f = this._segF;
    const i0 = this._idx(s - 1), i1 = this._idx(s), i2 = this._idx(s + 1), i3 = this._idx(s + 2);
    const k = this.tension;
    const a00 = 12 * f - 6;
    const a10 = 6 * f - 4;
    const a01 = -12 * f + 6;
    const a11 = 6 * f - 2;
    out.set(
      hermite(this.px[i0], this.px[i1], this.px[i2], this.px[i3], k, a00, a10, a01, a11),
      hermite(this.py[i0], this.py[i1], this.py[i2], this.py[i3], k, a00, a10, a01, a11),
      hermite(this.pz[i0], this.pz[i1], this.pz[i2], this.pz[i3], k, a00, a10, a01, a11),
    );
    return out;
  }

  /** Interpolate a per-node scalar array at raw parameter `u`. */
  _scalar(arr, u) {
    this._seg(u);
    const s = this._segS, f = this._segF;
    const i0 = this._idx(s - 1), i1 = this._idx(s), i2 = this._idx(s + 1), i3 = this._idx(s + 2);
    const f2 = f * f, f3 = f2 * f;
    return hermite(arr[i0], arr[i1], arr[i2], arr[i3], this.tension,
      2 * f3 - 3 * f2 + 1, f3 - 2 * f2 + f, -2 * f3 + 3 * f2, f3 - f2);
  }

  // ───────────────────────────────────────────────── parameter conversions

  /** Wrap/clamp a lap fraction into range. */
  wrapT(t) {
    if (!this.closed) return t < 0 ? 0 : t > 1 ? 1 : t;
    t %= 1;
    return t < 0 ? t + 1 : t;
  }

  /** Arc length in metres for a lap fraction. */
  distanceAt(t) { return this.wrapT(t) * this.length; }

  /** Lap fraction for an arc length in metres. */
  tAtDistance(d) { return this.wrapT(this.length > 0 ? d / this.length : 0); }

  /** Raw spline parameter for a lap fraction (inverse arc length). */
  uAtT(t) {
    const s = this.wrapT(t) * this.length;
    const i = this._lutIndexForLength(s);
    const s0 = this._ls[i], s1 = this._ls[i + 1];
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    return this._lu[i] + (this._lu[i + 1] - this._lu[i]) * f;
  }

  /** Lap fraction for a raw parameter. Wraps for closed splines. */
  tAtU(u) {
    const segs = this.segmentCount;
    let uu = u;
    if (this.closed) { uu %= segs; if (uu < 0) uu += segs; }
    else uu = Math.max(0, Math.min(segs, uu));
    const S = this.samplesPerSegment;
    const fi = uu * S;
    let i = Math.floor(fi);
    if (i >= this.lutCount - 1) i = this.lutCount - 2;
    if (i < 0) i = 0;
    const f = fi - i;
    const s = this._ls[i] + (this._ls[i + 1] - this._ls[i]) * f;
    return this.wrapT(s / this.length);
  }

  /** Binary search: largest LUT index whose cumulative length ≤ s. */
  _lutIndexForLength(s) {
    const ls = this._ls;
    let lo = 0, hi = this.lutCount - 1;
    if (s <= 0) return 0;
    if (s >= ls[hi]) return hi - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (ls[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  // ─────────────────────────────────────────────────────────────── sampling

  /**
   * Full, exact sample at a lap fraction. Allocation-free.
   * @param {number} t @param {SplineSample} [out]
   * @returns {SplineSample}
   */
  sample(t, out = _scratchSample) {
    const tt = this.wrapT(t);
    const s = tt * this.length;
    const i = this._lutIndexForLength(s);
    const s0 = this._ls[i], s1 = this._ls[i + 1];
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const u = this._lu[i] + (this._lu[i + 1] - this._lu[i]) * f;

    out.t = tt;
    out.u = u;
    out.distance = s;

    // Exact position + tangent.
    this._point(u, out.position);
    this._deriv(u, _t1);
    const dl = _t1.length() || 1;
    out.tangent.copy(_t1).multiplyScalar(1 / dl);

    // Frame normal: interpolate the LUT then re-orthogonalise.
    const nx = this._nx[i] + (this._nx[i + 1] - this._nx[i]) * f;
    const ny = this._ny[i] + (this._ny[i + 1] - this._ny[i]) * f;
    const nz = this._nz[i] + (this._nz[i + 1] - this._nz[i]) * f;
    out.normal.set(nx, ny, nz);
    const dot = out.normal.dot(out.tangent);
    out.normal.addScaledVector(out.tangent, -dot);
    if (out.normal.lengthSq() < 1e-10) out.normal.set(0, 1, 0);
    out.normal.normalize();

    // Scalars.
    out.width = Math.max(0.2, this._scalar(this.nw, u));
    out.banking = this._scalar(this.nb, u);
    out.camber = this._scalar(this.nc, u);

    // Signed curvature — positive turns toward the road's right.
    // c = r' × r''; for a right-hand turn c points along −normal.
    this._deriv2(u, _d);
    _c.copy(_t1).cross(_d);
    const kMag = _c.length() / Math.max(1e-9, dl * dl * dl);
    out.curvature = _c.dot(out.normal) >= 0 ? -kMag : kMag;

    // Right vector, then apply banking about the tangent.
    out.binormal.copy(out.tangent).cross(out.normal).normalize();
    if (out.banking !== 0) {
      _q1.setFromAxisAngle(out.tangent, out.banking);
      out.normal.applyQuaternion(_q1).normalize();
      out.binormal.applyQuaternion(_q1).normalize();
    }
    return out;
  }

  /**
   * Cheap sample — LUT interpolation only, no spline evaluation. Good enough for
   * AI look-ahead and camera hints; ~4× faster than {@link sample}.
   * @param {number} t @param {SplineSample} out
   */
  sampleFast(t, out) {
    const tt = this.wrapT(t);
    const s = tt * this.length;
    const i = this._lutIndexForLength(s);
    const s0 = this._ls[i], s1 = this._ls[i + 1];
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const j = i + 1;
    out.t = tt;
    out.distance = s;
    out.u = this._lu[i] + (this._lu[j] - this._lu[i]) * f;
    out.position.set(
      this._lx[i] + (this._lx[j] - this._lx[i]) * f,
      this._ly[i] + (this._ly[j] - this._ly[i]) * f,
      this._lz[i] + (this._lz[j] - this._lz[i]) * f,
    );
    out.tangent.set(
      this._tx[i] + (this._tx[j] - this._tx[i]) * f,
      this._ty[i] + (this._ty[j] - this._ty[i]) * f,
      this._tz[i] + (this._tz[j] - this._tz[i]) * f,
    ).normalize();
    out.normal.set(
      this._nx[i] + (this._nx[j] - this._nx[i]) * f,
      this._ny[i] + (this._ny[j] - this._ny[i]) * f,
      this._nz[i] + (this._nz[j] - this._nz[i]) * f,
    );
    out.normal.addScaledVector(out.tangent, -out.normal.dot(out.tangent));
    if (out.normal.lengthSq() < 1e-10) out.normal.set(0, 1, 0);
    out.normal.normalize();
    out.width = Math.max(0.2, this._scalar(this.nw, out.u));
    out.banking = this._scalar(this.nb, out.u);
    out.camber = this._scalar(this.nc, out.u);
    out.binormal.copy(out.tangent).cross(out.normal).normalize();
    if (out.banking !== 0) {
      _q1.setFromAxisAngle(out.tangent, out.banking);
      out.normal.applyQuaternion(_q1).normalize();
      out.binormal.applyQuaternion(_q1).normalize();
    }
    out.curvature = this.curvatureAt(tt);
    return out;
  }

  /** Position only. */
  positionAt(t, out) {
    return this._point(this.uAtT(t), out);
  }

  /** Unit tangent only. */
  tangentAt(t, out) {
    this._deriv(this.uAtT(t), out);
    const l = out.length() || 1;
    return out.multiplyScalar(1 / l);
  }

  /** Full road width at a lap fraction. */
  widthAt(t) { return Math.max(0.2, this._scalar(this.nw, this.uAtT(t))); }

  /** Banking angle in radians at a lap fraction. */
  bankingAt(t) { return this._scalar(this.nb, this.uAtT(t)); }

  /**
   * Signed curvature (1/m) at a lap fraction. Positive = turning right.
   * Cheap: two derivative evaluations, no allocation.
   */
  curvatureAt(t) {
    const u = this.uAtT(t);
    this._deriv(u, _t1);
    this._deriv2(u, _d);
    const dl = _t1.length();
    if (dl < 1e-9) return 0;
    _c.copy(_t1).cross(_d);
    const k = _c.length() / (dl * dl * dl);
    // Project the binormal of the osculating plane onto world up to get a sign.
    return _c.y >= 0 ? -k : k;
  }

  /**
   * Curvature smoothed over ±`window` metres — what the AI actually wants,
   * because raw curvature spikes on a Catmull-Rom kink.
   */
  smoothCurvature(t, window = 3.0, taps = 5) {
    let sum = 0, wsum = 0;
    const dt = window / this.length;
    for (let i = 0; i < taps; i++) {
      const f = taps === 1 ? 0 : (i / (taps - 1)) * 2 - 1;
      const w = 1 - Math.abs(f) * 0.5;
      sum += this.curvatureAt(t + f * dt) * w;
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : 0;
  }

  /** Radius of curvature in metres (clamped to 1e4 on straights). */
  radiusAt(t) {
    const k = Math.abs(this.smoothCurvature(t));
    return k > 1e-4 ? 1 / k : 1e4;
  }

  // ───────────────────────────────────────────────────── closest point search

  /**
   * Closest point on the centreline to a world position.
   *
   * Allocation-free. Pass `hintT` (e.g. the car's progress last frame) and a
   * `window` in metres to restrict the coarse scan — that turns an O(LUT) search
   * into a handful of samples, which is what makes this affordable per car per
   * frame.
   *
   * @param {THREE.Vector3} point
   * @param {ClosestResult} out
   * @param {{hintT?:number, window?:number, refine?:number}} [opts]
   * @returns {ClosestResult}
   */
  closestPoint(point, out, opts = null) {
    const M = this.lutCount;
    const lx = this._lx, ly = this._ly, lz = this._lz;

    let bestI = 0, best = Infinity;
    const hint = opts?.hintT;
    const win = opts?.window ?? 0;

    if (hint != null && win > 0) {
      // Windowed scan around the hint (indices, wrapped for closed splines).
      const centre = Math.round(this.wrapT(hint) * (M - 1));
      const half = Math.max(2, Math.ceil((win / this.length) * (M - 1)));
      for (let k = -half; k <= half; k++) {
        let i = centre + k;
        if (this.closed) { i = ((i % (M - 1)) + (M - 1)) % (M - 1); }
        else if (i < 0 || i >= M) continue;
        const dx = point.x - lx[i], dy = point.y - ly[i], dz = point.z - lz[i];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) { best = d2; bestI = i; }
      }
    } else {
      for (let i = 0; i < M; i++) {
        const dx = point.x - lx[i], dy = point.y - ly[i], dz = point.z - lz[i];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) { best = d2; bestI = i; }
      }
    }

    // Refine on the raw parameter between the two neighbouring LUT samples.
    // Closed splines let `u` run negative / past the end — `_seg()` wraps — so the
    // search works across the start/finish seam without a special case.
    const segs = this.segmentCount;
    const S = this.samplesPerSegment;
    let uLo = (bestI - 1) / S, uHi = (bestI + 1) / S;
    if (!this.closed) { uLo = Math.max(0, uLo); uHi = Math.min(segs, uHi); }

    const iters = opts?.refine ?? 14;
    for (let k = 0; k < iters; k++) {
      const m1 = uLo + (uHi - uLo) / 3;
      const m2 = uHi - (uHi - uLo) / 3;
      this._point(m1, _a);
      this._point(m2, _b);
      const d1 = _a.distanceToSquared(point);
      const d2 = _b.distanceToSquared(point);
      if (d1 < d2) uHi = m2; else uLo = m1;
    }
    const u = (uLo + uHi) * 0.5;

    out.u = u;
    out.t = this.tAtU(u);
    out.distance = out.t * this.length;
    this._point(u, out.position);
    this._deriv(u, _t1);
    const dl = _t1.length() || 1;
    out.tangent.copy(_t1).multiplyScalar(1 / dl);

    // Frame at this u (LUT interpolation is plenty for the lateral basis).
    let uw = u;
    if (this.closed) { uw %= segs; if (uw < 0) uw += segs; }
    const fi = Math.max(0, Math.min(M - 1.0001, uw * S));
    const i0 = Math.floor(fi);
    const ff = fi - i0;
    const i1 = Math.min(M - 1, i0 + 1);
    out.normal.set(
      this._nx[i0] + (this._nx[i1] - this._nx[i0]) * ff,
      this._ny[i0] + (this._ny[i1] - this._ny[i0]) * ff,
      this._nz[i0] + (this._nz[i1] - this._nz[i0]) * ff,
    );
    out.normal.addScaledVector(out.tangent, -out.normal.dot(out.tangent));
    if (out.normal.lengthSq() < 1e-10) out.normal.set(0, 1, 0);
    out.normal.normalize();
    out.width = Math.max(0.2, this._scalar(this.nw, u));
    const bank = this._scalar(this.nb, u);
    out.binormal.copy(out.tangent).cross(out.normal).normalize();
    if (bank !== 0) {
      _q1.setFromAxisAngle(out.tangent, bank);
      out.normal.applyQuaternion(_q1).normalize();
      out.binormal.applyQuaternion(_q1).normalize();
    }

    _d.copy(point).sub(out.position);
    out.dist = _d.length();
    out.lateral = _d.dot(out.binormal);
    out.vertical = _d.dot(out.normal);
    out.forward = _d.dot(out.tangent);
    return out;
  }

  // ────────────────────────────────────────────────────────────── lofting

  /**
   * Sweep a cross-section profile along the spline and emit one geometry **per
   * band** (the strip between two consecutive profile points), so every band can
   * carry its own surface id and material.
   *
   * A profile point is `{ w?, x?, y?, sid?, mat?, uv?, hide?, smooth? }`:
   *   * `w`   lateral position as a fraction of the **half width** (±1 = the road
   *           edge, so the road follows the spline's per-node width)
   *   * `x`   extra lateral offset in metres, added to `w`
   *   * `y`   offset along the road normal in metres
   *   * `sid` surface id of the band **starting** at this point
   *   * `mat` material key of that band (the caller resolves it)
   *   * `hide` skip the band starting at this point (used for the shoulders of a
   *           bridge deck, or for a gap)
   *   * `smooth` average this vertex's normal with the previous band's (curved
   *           profiles such as a half-pipe)
   *
   * UVs are emitted **in metres**: `u` = distance across the profile, `v` =
   * distance along the spline. Combined with a material requested at
   * `sizeMeters: 1` that gives globally constant texel density.
   *
   * @param {Array<object>} profile ordered left → right
   * @param {object} [opts]
   * @param {number} [opts.from=0] start lap fraction
   * @param {number} [opts.to=1] end lap fraction (may wrap past 1 when closed)
   * @param {number} [opts.stepMeters=0.9] target station spacing
   * @param {number} [opts.widthScale=1]
   * @param {number} [opts.uOffset=0] shifts the cross-profile UV origin
   * @param {boolean} [opts.flip=false] flip triangle winding (inward-facing shells)
   * @param {(sample:SplineSample, i:number, count:number)=>void} [opts.onStation]
   *        hook to mutate the sample (e.g. add a bump) before it is used
   * @returns {Array<{geometry:THREE.BufferGeometry, surfaceId:number, mat:string|undefined, index:number}>}
   */
  loft(profile, opts = {}) {
    const from = opts.from ?? 0;
    let to = opts.to ?? 1;
    if (to <= from) to += 1;                    // wrapped range
    const span = (to - from) * this.length;
    const step = Math.max(0.12, opts.stepMeters ?? 0.9);
    const stations = Math.max(2, Math.ceil(span / step) + 1);
    const widthScale = opts.widthScale ?? 1;
    const flip = !!opts.flip;

    const P = profile.length;
    if (P < 2) return [];

    // Sample the spline once and cache the per-station frames.
    const sx = new Float64Array(stations), sy = new Float64Array(stations), sz = new Float64Array(stations);
    const rx = new Float64Array(stations), ry = new Float64Array(stations), rz = new Float64Array(stations);
    const ux = new Float64Array(stations), uy = new Float64Array(stations), uz = new Float64Array(stations);
    const ttx = new Float64Array(stations), tty = new Float64Array(stations), ttz = new Float64Array(stations);
    const half = new Float64Array(stations);
    const camber = new Float64Array(stations);
    const vDist = new Float64Array(stations);

    const smp = _scratchSample;
    let prevX = 0, prevY = 0, prevZ = 0;
    for (let i = 0; i < stations; i++) {
      const t = from + ((to - from) * i) / (stations - 1);
      this.sample(t, smp);
      if (opts.onStation) opts.onStation(smp, i, stations);
      sx[i] = smp.position.x; sy[i] = smp.position.y; sz[i] = smp.position.z;
      rx[i] = smp.binormal.x; ry[i] = smp.binormal.y; rz[i] = smp.binormal.z;
      ux[i] = smp.normal.x; uy[i] = smp.normal.y; uz[i] = smp.normal.z;
      ttx[i] = smp.tangent.x; tty[i] = smp.tangent.y; ttz[i] = smp.tangent.z;
      half[i] = smp.width * 0.5 * widthScale;
      camber[i] = smp.camber;
      if (i === 0) vDist[i] = 0;
      else vDist[i] = vDist[i - 1] + Math.hypot(sx[i] - prevX, sy[i] - prevY, sz[i] - prevZ);
      prevX = sx[i]; prevY = sy[i]; prevZ = sz[i];
    }

    // Resolve profile lateral/vertical per station (width varies!).
    const lat = new Float64Array(stations * P);
    const vert = new Float64Array(stations * P);
    for (let i = 0; i < stations; i++) {
      for (let p = 0; p < P; p++) {
        const pp = profile[p];
        const w = pp.w ?? 0;
        const l = w * half[i] + (pp.x ?? 0);
        // Camber: parabolic crown across the road, only for |w| ≤ 1 points.
        const crown = camber[i] !== 0 ? -camber[i] * Math.min(1, w * w) : 0;
        lat[i * P + p] = l;
        vert[i * P + p] = (pp.y ?? 0) + crown;
      }
    }

    // Per-station cross-profile arc length → the u coordinate, in metres.
    const uCoord = new Float64Array(stations * P);
    for (let i = 0; i < stations; i++) {
      let acc = opts.uOffset ?? 0;
      uCoord[i * P] = acc;
      for (let p = 1; p < P; p++) {
        const dl = lat[i * P + p] - lat[i * P + p - 1];
        const dv = vert[i * P + p] - vert[i * P + p - 1];
        acc += Math.hypot(dl, dv);
        uCoord[i * P + p] = acc;
      }
    }

    // Band normals per station: n = cross(d, tangent) with d the in-plane
    // left→right direction of the band.
    const bandN = new Float64Array(stations * (P - 1) * 3);
    for (let i = 0; i < stations; i++) {
      for (let p = 0; p < P - 1; p++) {
        const dl = lat[i * P + p + 1] - lat[i * P + p];
        const dv = vert[i * P + p + 1] - vert[i * P + p];
        // world-space band direction
        const dx = rx[i] * dl + ux[i] * dv;
        const dy = ry[i] * dl + uy[i] * dv;
        const dz = rz[i] * dl + uz[i] * dv;
        let nx = dy * ttz[i] - dz * tty[i];
        let ny = dz * ttx[i] - dx * ttz[i];
        let nz = dx * tty[i] - dy * ttx[i];
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-9) { nx = ux[i]; ny = uy[i]; nz = uz[i]; }
        else { nx /= l; ny /= l; nz /= l; }
        const o = (i * (P - 1) + p) * 3;
        bandN[o] = nx; bandN[o + 1] = ny; bandN[o + 2] = nz;
      }
    }

    const out = [];
    const _pos = new THREE.Vector3();
    for (let p = 0; p < P - 1; p++) {
      const pp = profile[p];
      if (pp.hide) continue;

      const verts = stations * 2;
      const positions = new Float32Array(verts * 3);
      const normals = new Float32Array(verts * 3);
      const uvs = new Float32Array(verts * 2);
      const indices = new Uint32Array((stations - 1) * 6);

      for (let i = 0; i < stations; i++) {
        for (let side = 0; side < 2; side++) {
          const pi = p + side;
          const l = lat[i * P + pi], v = vert[i * P + pi];
          _pos.set(
            sx[i] + rx[i] * l + ux[i] * v,
            sy[i] + ry[i] * l + uy[i] * v,
            sz[i] + rz[i] * l + uz[i] * v,
          );
          const vi = (i * 2 + side) * 3;
          positions[vi] = _pos.x; positions[vi + 1] = _pos.y; positions[vi + 2] = _pos.z;

          // Normal: this band's, optionally averaged with the neighbour's.
          const o = (i * (P - 1) + p) * 3;
          let nx = bandN[o], ny = bandN[o + 1], nz = bandN[o + 2];
          const wantSmooth = side === 0 ? profile[p].smooth : profile[p + 1].smooth;
          if (wantSmooth) {
            const nb = side === 0 ? p - 1 : p + 1;
            if (nb >= 0 && nb < P - 1 && !profile[Math.min(nb, P - 2)].hide) {
              const o2 = (i * (P - 1) + nb) * 3;
              nx += bandN[o2]; ny += bandN[o2 + 1]; nz += bandN[o2 + 2];
              const l2 = Math.hypot(nx, ny, nz) || 1;
              nx /= l2; ny /= l2; nz /= l2;
            }
          }
          if (flip) { nx = -nx; ny = -ny; nz = -nz; }
          normals[vi] = nx; normals[vi + 1] = ny; normals[vi + 2] = nz;

          const ti = (i * 2 + side) * 2;
          uvs[ti] = uCoord[i * P + pi];
          uvs[ti + 1] = vDist[i];
        }
      }

      let k = 0;
      for (let i = 0; i < stations - 1; i++) {
        const a0 = i * 2, b0 = i * 2 + 1, a1 = (i + 1) * 2, b1 = (i + 1) * 2 + 1;
        if (flip) {
          indices[k++] = a0; indices[k++] = a1; indices[k++] = b0;
          indices[k++] = b0; indices[k++] = a1; indices[k++] = b1;
        } else {
          indices[k++] = a0; indices[k++] = b0; indices[k++] = a1;
          indices[k++] = b0; indices[k++] = b1; indices[k++] = a1;
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      geo.computeBoundingSphere();
      out.push({ geometry: geo, surfaceId: pp.sid ?? 0, mat: pp.mat, index: p });
    }
    return out;
  }

  /**
   * Polyline of the centreline (or of an offset line) — for minimaps, debug
   * draws and AI path seeding.
   * @param {number} count
   * @param {number} [lateral] metres to the right
   * @param {number} [vertical]
   * @returns {THREE.Vector3[]}
   */
  toPoints(count = 128, lateral = 0, vertical = 0) {
    const pts = [];
    const smp = new SplineSample();
    for (let i = 0; i < count; i++) {
      this.sample(i / count, smp);
      const v = new THREE.Vector3();
      smp.offset(lateral, vertical, v);
      pts.push(v);
    }
    return pts;
  }

  /** Axis-aligned bounds of the road surface (centreline ± half width). */
  computeBounds(out = new THREE.Box3(), pad = 0) {
    out.makeEmpty();
    const smp = new SplineSample();
    const n = Math.max(64, this.lutCount >> 1);
    for (let i = 0; i < n; i++) {
      this.sample(i / n, smp);
      const h = smp.width * 0.5 + pad;
      smp.offset(-h, 0, _a); out.expandByPoint(_a);
      smp.offset(h, 0, _a); out.expandByPoint(_a);
    }
    return out;
  }

  /**
   * A three.js curve view of the centreline — lets `TubeGeometry`,
   * `ExtrudeGeometry` and friends consume it directly.
   * @returns {THREE.Curve<THREE.Vector3>}
   */
  toCurve() {
    const self = this;
    const curve = new THREE.Curve();
    curve.getPoint = function (s, optionalTarget = new THREE.Vector3()) {
      return self.positionAt(s, optionalTarget);
    };
    curve.getLength = () => self.length;
    return curve;
  }
}

// ────────────────────────────────────────────────────────────────── helpers

function hermite(p0, p1, p2, p3, k, h00, h10, h01, h11) {
  const m1 = k * (p2 - p0);
  const m2 = k * (p3 - p1);
  return h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2;
}

function normaliseNodes(nodes, defaultWidth) {
  const out = [];
  if (!nodes) return out;
  for (const raw of nodes) {
    if (!raw) continue;
    let x = 0, y = 0, z = 0;
    let w = defaultWidth, bank = 0, camber = 0, tag = null;
    if (Array.isArray(raw)) {
      x = raw[0] ?? 0; y = raw[1] ?? 0; z = raw[2] ?? 0;
      if (raw.length > 3) w = raw[3];
      if (raw.length > 4) bank = raw[4];
      if (raw.length > 5) camber = raw[5];
    } else if (raw.isVector3) {
      x = raw.x; y = raw.y; z = raw.z;
    } else {
      const p = raw.p ?? raw.position ?? raw.pos;
      if (Array.isArray(p)) { x = p[0] ?? 0; y = p[1] ?? 0; z = p[2] ?? 0; }
      else if (p && p.isVector3) { x = p.x; y = p.y; z = p.z; }
      else { x = raw.x ?? 0; y = raw.y ?? 0; z = raw.z ?? 0; }
      w = raw.w ?? raw.width ?? defaultWidth;
      bank = raw.bank ?? raw.banking ?? 0;
      camber = raw.camber ?? 0;
      tag = raw.tag ?? null;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    out.push({
      x, y, z,
      w: Number.isFinite(w) ? Math.max(0.2, w) : defaultWidth,
      bank: Number.isFinite(bank) ? bank : 0,
      camber: Number.isFinite(camber) ? camber : 0,
      tag,
    });
  }
  return out;
}

/**
 * A straight-line helper spline (bridges, planks, corridors) with the same API.
 * @param {THREE.Vector3|number[]} a @param {THREE.Vector3|number[]} b
 * @param {number} width
 */
export function straightSpline(a, b, width = 2) {
  const A = Array.isArray(a) ? a : [a.x, a.y, a.z];
  const B = Array.isArray(b) ? b : [b.x, b.y, b.z];
  const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
  return new CenterlineSpline(
    [
      { p: A, w: width }, { p: mid, w: width }, { p: B, w: width },
    ],
    { closed: false, samplesPerSegment: 24 },
  );
}

export default CenterlineSpline;
