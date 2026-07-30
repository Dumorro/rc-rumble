/**
 * RC RUMBLE — narrow phase.
 *
 * Produces contact manifolds. Every routine is allocation free and writes into
 * a caller-owned `Manifold`.
 *
 * Normal convention
 * -----------------
 * The manifold normal always points **from A towards B**: applying +n·j to B
 * and −n·j to A separates them. For body-vs-track contacts A is the (static)
 * triangle, so the normal points out of the surface.
 *
 * Ghost / internal-edge contacts
 * ------------------------------
 * A car must never catch on the seam between two coplanar floor triangles.
 * Two mechanisms handle this:
 *
 *  1. `CollisionMesh.edgeConvex` marks which triangle edges are genuine convex
 *     features. Contacts whose closest feature is an *internal* edge or vertex
 *     get their normal snapped to the triangle's face normal and their depth
 *     recomputed along it (dropping the contact if that leaves no penetration).
 *  2. Triangles are treated as ONE-SIDED. SAT axes that would push a body into
 *     the back of a face (`dot(n, faceNormal) < 0`) are never selected, and the
 *     face normal wins every tie. Track meshes must therefore be authored with
 *     outward-facing normals — the CollisionMeshBuilder preserves winding.
 */

import { closestPointOnTriangleRaw, CP, regionIsInternal } from './CollisionMesh.js';

/** Max points a single manifold can hold before reduction. */
export const MANIFOLD_CAPACITY = 16;
/** Max points kept after reduction — 4 is plenty for a stable resting box. */
export const MANIFOLD_KEEP = 4;

/** Ties within this many metres prefer the earlier (triangle-normal) axis. */
const AXIS_EPS = 1e-4;
/** Clipped points shallower than this are discarded. */
const KEEP_SLOP = 0.004;
/** Edge-cross axes below this length are degenerate (parallel edges). */
const CROSS_EPS = 1e-7;
/** Inclusive tolerance when classifying a point against a clip plane (metres). */
const CLIP_EPS = 3e-5;
/** Clipped points closer than this are the same point. */
const WELD_EPS = 2e-4;
const WELD_EPS2 = WELD_EPS * WELD_EPS;

// ───────────────────────────────────────────────────────── scratch
const _polyA = new Float32Array(3 * 34);
const _polyB = new Float32Array(3 * 34);
const _triSideN = new Float32Array(9);
const _triSideD = new Float32Array(3);
const _keep = new Int32Array(MANIFOLD_CAPACITY);
const _redP = new Float32Array(MANIFOLD_CAPACITY * 3);
const _redD = new Float32Array(MANIFOLD_CAPACITY);
const _redF = new Uint32Array(MANIFOLD_CAPACITY);

// SAT result (module level, read immediately)
const SAT = { nx: 0, ny: 0, nz: 0, depth: 0, kind: 0, face: -1 };
// kind: 0 = triangle/reference-A face, 1 = hull face (B), 2 = edge-edge

/**
 * A contact manifold between two shapes.
 * Points are world-space; depth is positive when penetrating.
 */
export class Manifold {
  constructor(capacity = MANIFOLD_CAPACITY) {
    this.capacity = capacity;
    this.count = 0;
    this.nx = 0; this.ny = 1; this.nz = 0;
    this.points = new Float32Array(capacity * 3);
    this.depths = new Float32Array(capacity);
    this.features = new Uint32Array(capacity);
    /** Surface id of the triangle involved (0 for body-vs-body). */
    this.surfaceId = 0;
    this.triIndex = -1;
  }

  clear() { this.count = 0; this.triIndex = -1; this.surfaceId = 0; return this; }

  setNormal(x, y, z) { this.nx = x; this.ny = y; this.nz = z; return this; }

  add(x, y, z, depth, feature) {
    if (this.count >= this.capacity) return false;
    const i = this.count * 3;
    this.points[i] = x; this.points[i + 1] = y; this.points[i + 2] = z;
    this.depths[this.count] = depth;
    this.features[this.count] = feature >>> 0;
    this.count++;
    return true;
  }

  /** Flip the normal — used when a dispatch swapped A and B. */
  flip() { this.nx = -this.nx; this.ny = -this.ny; this.nz = -this.nz; return this; }

  /** Keep at most `max` well-spread points (deepest first). */
  reduce(max = MANIFOLD_KEEP) {
    const n = this.count;
    if (n <= max) return this;
    const P = this.points, D = this.depths, F = this.features;

    // 1. deepest
    let i0 = 0;
    for (let i = 1; i < n; i++) if (D[i] > D[i0]) i0 = i;
    _keep[0] = i0;
    let kept = 1;

    // 2..max: greedily take the point furthest from everything kept so far
    while (kept < max) {
      let best = -1, bestD = -1;
      for (let i = 0; i < n; i++) {
        let dup = false;
        for (let k = 0; k < kept; k++) if (_keep[k] === i) { dup = true; break; }
        if (dup) continue;
        let minD = Infinity;
        for (let k = 0; k < kept; k++) {
          const j = _keep[k];
          const dx = P[i * 3] - P[j * 3];
          const dy = P[i * 3 + 1] - P[j * 3 + 1];
          const dz = P[i * 3 + 2] - P[j * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < minD) minD = d;
        }
        // bias slightly toward deeper points so resting manifolds stay put
        const score = minD + D[i] * 1e-3;
        if (score > bestD) { bestD = score; best = i; }
      }
      if (best < 0) break;
      _keep[kept++] = best;
    }

    // Gather into scratch first so overwriting the source is safe.
    for (let k = 0; k < kept; k++) {
      const s = _keep[k];
      _redP[k * 3] = P[s * 3]; _redP[k * 3 + 1] = P[s * 3 + 1]; _redP[k * 3 + 2] = P[s * 3 + 2];
      _redD[k] = D[s]; _redF[k] = F[s];
    }
    for (let k = 0; k < kept; k++) {
      P[k * 3] = _redP[k * 3]; P[k * 3 + 1] = _redP[k * 3 + 1]; P[k * 3 + 2] = _redP[k * 3 + 2];
      D[k] = _redD[k]; F[k] = _redF[k];
    }
    this.count = kept;
    return this;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Sphere / capsule vs triangle
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sphere against one triangle of a CollisionMesh.
 * @param {number} cx sphere centre @param {number} cy @param {number} cz
 * @param {number} radius
 * @param {import('./CollisionMesh.js').CollisionMesh} mesh
 * @param {number} tri triangle index
 * @param {Manifold} m appended to (normal is overwritten)
 * @returns {boolean} true when a contact was produced
 */
export function sphereVsTriangle(cx, cy, cz, radius, mesh, tri, m) {
  const base = tri * 9;
  closestPointOnTriangleRaw(mesh.tris, base, cx, cy, cz);
  let dx = cx - CP.x, dy = cy - CP.y, dz = cz - CP.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  // SPECULATIVE: keep contacts up to KEEP_SLOP *separated*, exactly like the
  // hull path. Rejecting them was a real dropout bug — a sphere resting on a
  // plane sits at depth ≈ 0, so `depth <= 0` threw its contact away, it fell
  // free for one step (g·cosθ·dt = 1.3 mm at 2g), got caught, and repeated.
  // The solver's separated-contact branch limits the approach speed to exactly
  // what closes the gap, so a speculative contact costs nothing until it lands.
  const reach = radius + KEEP_SLOP;
  if (d2 > reach * reach) return false;

  const po = tri * 4, P = mesh.planes;
  const tnx = P[po], tny = P[po + 1], tnz = P[po + 2], tnd = P[po + 3];
  const sd = tnx * cx + tny * cy + tnz * cz - tnd;

  let nx, ny, nz, depth;
  // Contact point. Whenever the normal is snapped to the face normal the point
  // has to be re-projected onto the face plane along that same normal, i.e. the
  // point of the sphere that is actually deepest along n.
  //
  // Keeping CP (which sits ON the seam) while reporting the FACE normal is a
  // silent, nasty bug: it hands the solver a lever arm the sphere does not
  // physically have. A ball straddling a seam then gets one contact per
  // triangle, a few millimetres apart, with DIFFERENT lever arms — and the
  // solver can satisfy "point not separating" by spinning the ball while its
  // centre flies upward. Measured: a 33 mm ball rolling at 5 m/s launched
  // itself ~1 mm off a flat floor every time it crossed a quad boundary.
  // Projecting the point makes every coplanar contact land on the SAME spot, so
  // they merge into the one contact a sphere-vs-plane actually has.
  let px, py, pz;
  const internal = regionIsInternal(CP.region, mesh.edgeConvex[tri]);
  // Face region, or a seam we must not catch on: push straight out the front.
  let faceNormal = internal || CP.region === 0 || d2 < 1e-14;

  if (!faceNormal) {
    const dist = Math.sqrt(d2);
    const inv = 1 / dist;
    nx = dx * inv; ny = dy * inv; nz = dz * inv;
    depth = radius - dist;
    px = CP.x; py = CP.y; pz = CP.z;
    // A genuine edge can still not push into the back of a one-sided face.
    if (nx * tnx + ny * tny + nz * tnz < 0) faceNormal = true;
  }
  if (faceNormal) {
    nx = tnx; ny = tny; nz = tnz;
    depth = radius - sd;
    px = cx - tnx * sd; py = cy - tny * sd; pz = cz - tnz * sd;
  }
  if (depth <= -KEEP_SLOP) return false;

  m.setNormal(nx, ny, nz);
  m.surfaceId = mesh.surfaceIds[tri];
  m.triIndex = tri;
  m.add(px, py, pz, depth, 0);
  return true;
}

/**
 * Capsule (segment + radius) against one triangle. Generates up to two
 * contacts when the capsule lies along the face, which is what keeps a
 * capsule prop from rocking.
 */
export function capsuleVsTriangle(ax, ay, az, bx, by, bz, radius, mesh, tri, m) {
  const po = tri * 4, P = mesh.planes;
  const tnx = P[po], tny = P[po + 1], tnz = P[po + 2];

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const axisDot = Math.abs(tnx * abx + tny * aby + tnz * abz) /
    (Math.hypot(abx, aby, abz) || 1);

  // Nearly parallel to the face → two contacts, one per end of the overlap.
  if (axisDot < 0.35) {
    const before = m.count;
    let n0x = 0, n0y = 0, n0z = 0, hits = 0;
    for (let s = 0; s < 2; s++) {
      const t = s === 0 ? 0.05 : 0.95;
      const px = ax + abx * t, py = ay + aby * t, pz = az + abz * t;
      const sub = _tmpManifold;
      sub.clear();
      if (sphereVsTriangle(px, py, pz, radius, mesh, tri, sub) && sub.count > 0) {
        n0x += sub.nx; n0y += sub.ny; n0z += sub.nz;
        m.add(sub.points[0], sub.points[1], sub.points[2], sub.depths[0], s);
        hits++;
      }
    }
    if (hits > 0) {
      const l = Math.hypot(n0x, n0y, n0z) || 1;
      m.setNormal(n0x / l, n0y / l, n0z / l);
      m.surfaceId = mesh.surfaceIds[tri];
      m.triIndex = tri;
      return true;
    }
    m.count = before;
  }

  // Otherwise: single closest point between the segment and the triangle.
  const t = segmentTriangleParam(ax, ay, az, bx, by, bz, mesh.tris, tri * 9);
  const px = ax + abx * t, py = ay + aby * t, pz = az + abz * t;
  return sphereVsTriangle(px, py, pz, radius, mesh, tri, m);
}

const _tmpManifold = new Manifold(4);

/**
 * Parameter along segment AB that is closest to the triangle. Samples the
 * segment against the three triangle edges plus both endpoints, which is
 * exact for all the configurations a capsule can be in.
 */
export function segmentTriangleParam(ax, ay, az, bx, by, bz, tris, base) {
  let bestT = 0, bestD = Infinity;

  // endpoints
  closestPointOnTriangleRaw(tris, base, ax, ay, az);
  let dx = ax - CP.x, dy = ay - CP.y, dz = az - CP.z;
  let d = dx * dx + dy * dy + dz * dz;
  if (d < bestD) { bestD = d; bestT = 0; }

  closestPointOnTriangleRaw(tris, base, bx, by, bz);
  dx = bx - CP.x; dy = by - CP.y; dz = bz - CP.z;
  d = dx * dx + dy * dy + dz * dz;
  if (d < bestD) { bestD = d; bestT = 1; }

  // segment vs each triangle edge
  for (let e = 0; e < 3; e++) {
    const i0 = base + e * 3;
    const i1 = base + ((e + 1) % 3) * 3;
    const t = segmentSegmentParam(
      ax, ay, az, bx, by, bz,
      tris[i0], tris[i0 + 1], tris[i0 + 2],
      tris[i1], tris[i1 + 1], tris[i1 + 2],
    );
    const px = ax + (bx - ax) * t, py = ay + (by - ay) * t, pz = az + (bz - az) * t;
    closestPointOnTriangleRaw(tris, base, px, py, pz);
    dx = px - CP.x; dy = py - CP.y; dz = pz - CP.z;
    d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; bestT = t; }
  }
  return bestT;
}

/** Parameter on segment P for the closest pair between segments P and Q. */
export function segmentSegmentParam(px, py, pz, qx, qy, qz, rx, ry, rz, sx, sy, sz) {
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  const ex = sx - rx, ey = sy - ry, ez = sz - rz;
  const fx = px - rx, fy = py - ry, fz = pz - rz;
  const a = dx * dx + dy * dy + dz * dz;
  const e2 = ex * ex + ey * ey + ez * ez;
  const f = ex * fx + ey * fy + ez * fz;
  if (a < 1e-12) return 0;
  const c = dx * fx + dy * fy + dz * fz;
  if (e2 < 1e-12) return clamp01(-c / a);
  const b = dx * ex + dy * ey + dz * ez;
  const denom = a * e2 - b * b;
  let s = denom > 1e-12 ? clamp01((b * f - c * e2) / denom) : 0;
  let t = (b * s + f) / e2;
  if (t < 0) { t = 0; s = clamp01(-c / a); }
  else if (t > 1) { s = clamp01((b - c) / a); }
  return s;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ═══════════════════════════════════════════════════════════════════════════
// Convex hull vs triangle (SAT + reference-face clipping)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} cache RigidBody world-space shape cache
 * @param {object} col   hull collider (topology)
 * @param {import('./CollisionMesh.js').CollisionMesh} mesh
 * @param {number} tri
 * @param {Manifold} m
 */
export function hullVsTriangle(cache, col, mesh, tri, m) {
  const T = mesh.tris, base = tri * 9;
  const t0x = T[base], t0y = T[base + 1], t0z = T[base + 2];
  const t1x = T[base + 3], t1y = T[base + 4], t1z = T[base + 5];
  const t2x = T[base + 6], t2y = T[base + 7], t2z = T[base + 8];

  const po = tri * 4, P = mesh.planes;
  const tnx = P[po], tny = P[po + 1], tnz = P[po + 2], tnd = P[po + 3];
  const convexMask = mesh.edgeConvex[tri];

  const wv = cache.verts;
  const VN = col.vertexCount;

  // ── axis 0: the triangle plane (one-sided: normal = +tn) ────────────
  let hullMin = Infinity, hullMax = -Infinity;
  for (let i = 0; i < VN; i++) {
    const d = wv[i * 3] * tnx + wv[i * 3 + 1] * tny + wv[i * 3 + 2] * tnz;
    if (d < hullMin) hullMin = d;
    if (d > hullMax) hullMax = d;
  }
  if (hullMin - tnd > 0) return false;          // entirely in front — no touch
  void hullMax;

  SAT.nx = tnx; SAT.ny = tny; SAT.nz = tnz;
  SAT.depth = tnd - hullMin;
  SAT.kind = 0; SAT.face = -1;
  let bestDepth = SAT.depth;

  // ── hull face axes ──────────────────────────────────────────────────
  const fN = cache.faceN, fD = cache.faceD;
  for (let f = 0, F = col.faceCount; f < F; f++) {
    const nx = fN[f * 3], ny = fN[f * 3 + 1], nz = fN[f * 3 + 2];
    const d0 = t0x * nx + t0y * ny + t0z * nz;
    const d1 = t1x * nx + t1y * ny + t1z * nz;
    const d2 = t2x * nx + t2y * ny + t2z * nz;
    const triMin = Math.min(d0, d1, d2);
    const sep = triMin - fD[f];
    if (sep > 0) return false;                  // separating axis found
    // normal from triangle → hull is -n for a hull face
    if (-nx * tnx - ny * tny - nz * tnz < 0) continue;   // would push into the face
    const depth = -sep;
    if (depth < bestDepth - AXIS_EPS) {
      bestDepth = depth;
      SAT.nx = -nx; SAT.ny = -ny; SAT.nz = -nz;
      SAT.depth = depth; SAT.kind = 1; SAT.face = f;
    }
  }

  // ── edge × edge axes ────────────────────────────────────────────────
  const eD = cache.edgeDir, EN = col.edgeDirCount;
  for (let te = 0; te < 3; te++) {
    let ex, ey, ez;
    if (te === 0) { ex = t1x - t0x; ey = t1y - t0y; ez = t1z - t0z; }
    else if (te === 1) { ex = t2x - t1x; ey = t2y - t1y; ez = t2z - t1z; }
    else { ex = t0x - t2x; ey = t0y - t2y; ez = t0z - t2z; }
    const internalEdge = (convexMask & (1 << te)) === 0;

    for (let j = 0; j < EN; j++) {
      const hx = eD[j * 3], hy = eD[j * 3 + 1], hz = eD[j * 3 + 2];
      let nx = ey * hz - ez * hy;
      let ny = ez * hx - ex * hz;
      let nz = ex * hy - ey * hx;
      const l2 = nx * nx + ny * ny + nz * nz;
      if (l2 < CROSS_EPS) continue;
      const inv = 1 / Math.sqrt(l2);
      nx *= inv; ny *= inv; nz *= inv;

      const d0 = t0x * nx + t0y * ny + t0z * nz;
      const d1 = t1x * nx + t1y * ny + t1z * nz;
      const d2 = t2x * nx + t2y * ny + t2z * nz;
      const triMin = Math.min(d0, d1, d2), triMax = Math.max(d0, d1, d2);
      let hMin = Infinity, hMax = -Infinity;
      for (let i = 0; i < VN; i++) {
        const d = wv[i * 3] * nx + wv[i * 3 + 1] * ny + wv[i * 3 + 2] * nz;
        if (d < hMin) hMin = d;
        if (d > hMax) hMax = d;
      }
      const sepPlus = hMin - triMax;    // hull on the +n side
      const sepMinus = triMin - hMax;   // hull on the -n side
      const sep = sepPlus > sepMinus ? sepPlus : sepMinus;
      if (sep > 0) return false;
      if (internalEdge) continue;       // never pick a seam-derived normal
      let ox = nx, oy = ny, oz = nz;
      if (sepPlus <= sepMinus) { ox = -nx; oy = -ny; oz = -nz; }
      if (ox * tnx + oy * tny + oz * tnz < 0) continue;  // one-sided guard
      const depth = -sep;
      if (depth < bestDepth - AXIS_EPS) {
        bestDepth = depth;
        SAT.nx = ox; SAT.ny = oy; SAT.nz = oz;
        SAT.depth = depth; SAT.kind = 2; SAT.face = -1;
      }
    }
  }

  // ── manifold ────────────────────────────────────────────────────────
  m.surfaceId = mesh.surfaceIds[tri];
  m.triIndex = tri;

  if (SAT.kind === 0) {
    return triangleReferenceManifold(
      cache, col, tri,
      t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z,
      tnx, tny, tnz, tnd, m,
    );
  }
  if (SAT.kind === 1) {
    return hullReferenceManifold(
      cache, col, SAT.face,
      t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z, m,
    );
  }
  // Edge-edge: one point at the hull's deepest vertex, snapped to the triangle.
  return supportPointManifold(cache, col, SAT.nx, SAT.ny, SAT.nz, SAT.depth,
    mesh, tri, convexMask, m);
}

/** Reference face = the triangle. Clip the hull's incident face against it. */
function triangleReferenceManifold(
  cache, col, tri,
  t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z,
  tnx, tny, tnz, tnd, m,
) {
  m.setNormal(tnx, tny, tnz);

  // Incident hull face = most anti-parallel to the reference normal.
  const fN = cache.faceN;
  let inc = 0, incDot = Infinity;
  for (let f = 0, F = col.faceCount; f < F; f++) {
    const d = fN[f * 3] * tnx + fN[f * 3 + 1] * tny + fN[f * 3 + 2] * tnz;
    if (d < incDot) { incDot = d; inc = f; }
  }

  const s = col.faceStart[inc], e = col.faceStart[inc + 1];
  let n = 0;
  for (let i = s; i < e && n < 32; i++) {
    const v = col.faceVerts[i] * 3;
    _polyA[n * 3] = cache.verts[v];
    _polyA[n * 3 + 1] = cache.verts[v + 1];
    _polyA[n * 3 + 2] = cache.verts[v + 2];
    n++;
  }

  // Triangle side planes.
  triSidePlanes(t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z, tnx, tny, tnz);

  let src = _polyA, dst = _polyB, count = n;
  for (let k = 0; k < 3; k++) {
    count = clipToPlane(src, count, dst,
      _triSideN[k * 3], _triSideN[k * 3 + 1], _triSideN[k * 3 + 2], _triSideD[k]);
    const t = src; src = dst; dst = t;
    if (count === 0) break;
  }
  count = dedupePoly(src, count);

  let added = 0;
  for (let i = 0; i < count; i++) {
    const px = src[i * 3], py = src[i * 3 + 1], pz = src[i * 3 + 2];
    const depth = tnd - (tnx * px + tny * py + tnz * pz);
    if (depth < -KEEP_SLOP) continue;
    const half = depth * 0.5;
    if (m.add(px + tnx * half, py + tny * half, pz + tnz * half,
      depth, ((inc & 0xffff) << 3) | (i & 7))) added++;
  }

  if (added === 0) {
    // Degenerate clip (tiny triangle under a big face) — fall back to the
    // deepest hull vertex so the body still gets support.
    const wv = cache.verts;
    let bi = 0, bd = Infinity;
    for (let i = 0, VN = col.vertexCount; i < VN; i++) {
      const d = wv[i * 3] * tnx + wv[i * 3 + 1] * tny + wv[i * 3 + 2] * tnz;
      if (d < bd) { bd = d; bi = i; }
    }
    const depth = tnd - bd;
    if (depth <= 0) return false;
    m.add(wv[bi * 3], wv[bi * 3 + 1], wv[bi * 3 + 2], depth, 0xfff);
    added = 1;
  }
  m.reduce();
  return m.count > 0;
}

/** Reference face = a hull face. Clip the triangle against it. */
function hullReferenceManifold(
  cache, col, face,
  t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z, m,
) {
  const nx = cache.faceN[face * 3], ny = cache.faceN[face * 3 + 1], nz = cache.faceN[face * 3 + 2];
  const d = cache.faceD[face];
  m.setNormal(-nx, -ny, -nz);

  _polyA[0] = t0x; _polyA[1] = t0y; _polyA[2] = t0z;
  _polyA[3] = t1x; _polyA[4] = t1y; _polyA[5] = t1z;
  _polyA[6] = t2x; _polyA[7] = t2y; _polyA[8] = t2z;

  let src = _polyA, dst = _polyB, count = 3;
  const s = col.faceStart[face], e = col.faceStart[face + 1];
  for (let i = s; i < e; i++) {
    count = clipToPlane(src, count, dst,
      cache.sideN[i * 3], cache.sideN[i * 3 + 1], cache.sideN[i * 3 + 2], cache.sideD[i]);
    const t = src; src = dst; dst = t;
    if (count === 0) break;
  }
  count = dedupePoly(src, count);

  let added = 0;
  for (let i = 0; i < count; i++) {
    const px = src[i * 3], py = src[i * 3 + 1], pz = src[i * 3 + 2];
    const depth = d - (nx * px + ny * py + nz * pz);
    if (depth < -KEEP_SLOP) continue;
    if (m.add(px, py, pz, depth, ((face & 0xffff) << 3) | (i & 7))) added++;
  }
  if (added === 0) return false;
  m.reduce();
  return m.count > 0;
}

/** Single-point manifold at the hull's deepest vertex along -n. */
function supportPointManifold(cache, col, nx, ny, nz, depth, mesh, tri, convexMask, m) {
  const wv = cache.verts;
  let bi = 0, bd = Infinity;
  for (let i = 0, VN = col.vertexCount; i < VN; i++) {
    const d = wv[i * 3] * nx + wv[i * 3 + 1] * ny + wv[i * 3 + 2] * nz;
    if (d < bd) { bd = d; bi = i; }
  }
  const px = wv[bi * 3], py = wv[bi * 3 + 1], pz = wv[bi * 3 + 2];
  closestPointOnTriangleRaw(mesh.tris, tri * 9, px, py, pz);
  // Final safety net: if the closest feature is an internal seam, use the face.
  if (regionIsInternal(CP.region, convexMask)) {
    const po = tri * 4, P = mesh.planes;
    const tnx = P[po], tny = P[po + 1], tnz = P[po + 2], tnd = P[po + 3];
    const dep = tnd - (tnx * px + tny * py + tnz * pz);
    if (dep <= 0) return false;
    m.setNormal(tnx, tny, tnz);
    m.add(px, py, pz, dep, 0xffe);
    return true;
  }
  m.setNormal(nx, ny, nz);
  m.add((px + CP.x) * 0.5, (py + CP.y) * 0.5, (pz + CP.z) * 0.5, depth, 0xffd);
  return true;
}

function triSidePlanes(t0x, t0y, t0z, t1x, t1y, t1z, t2x, t2y, t2z, nx, ny, nz) {
  setSide(0, t0x, t0y, t0z, t1x - t0x, t1y - t0y, t1z - t0z, nx, ny, nz);
  setSide(1, t1x, t1y, t1z, t2x - t1x, t2y - t1y, t2z - t1z, nx, ny, nz);
  setSide(2, t2x, t2y, t2z, t0x - t2x, t0y - t2y, t0z - t2z, nx, ny, nz);
}

function setSide(k, ox, oy, oz, ex, ey, ez, nx, ny, nz) {
  let sx = ey * nz - ez * ny;
  let sy = ez * nx - ex * nz;
  let sz = ex * ny - ey * nx;
  const l = Math.hypot(sx, sy, sz) || 1;
  sx /= l; sy /= l; sz /= l;
  _triSideN[k * 3] = sx; _triSideN[k * 3 + 1] = sy; _triSideN[k * 3 + 2] = sz;
  _triSideD[k] = sx * ox + sy * oy + sz * oz;
}

/**
 * Sutherland–Hodgman: keep the half-space  n·p ≤ d.
 *
 * CLIP_EPS matters enormously. Two identically sized boxes stacked exactly on
 * top of each other put the incident face's corners *exactly* on the reference
 * face's side planes, where float noise flips their sign frame to frame. That
 * makes the manifold jump between 4 and 6 points, breaks warm starting and
 * feeds a phantom torque into the stack. Classifying with a small inclusive
 * epsilon — and using the SAME classification for the crossing test so no
 * duplicate point is ever emitted — makes the manifold rock steady.
 */
function clipToPlane(src, count, dst, nx, ny, nz, d) {
  let out = 0;
  const de = d + CLIP_EPS;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = src[i * 3], ay = src[i * 3 + 1], az = src[i * 3 + 2];
    const bx = src[j * 3], by = src[j * 3 + 1], bz = src[j * 3 + 2];
    const da = nx * ax + ny * ay + nz * az - de;
    const db = nx * bx + ny * by + nz * bz - de;
    const inA = da <= 0, inB = db <= 0;
    if (inA) {
      dst[out * 3] = ax; dst[out * 3 + 1] = ay; dst[out * 3 + 2] = az; out++;
      if (out >= 32) break;
    }
    if (inA !== inB) {
      const t = da / (da - db);
      dst[out * 3] = ax + (bx - ax) * t;
      dst[out * 3 + 1] = ay + (by - ay) * t;
      dst[out * 3 + 2] = az + (bz - az) * t;
      out++;
      if (out >= 32) break;
    }
  }
  return out;
}

/** Drop clipped points that landed on top of each other. */
function dedupePoly(poly, count) {
  let out = 0;
  for (let i = 0; i < count; i++) {
    const x = poly[i * 3], y = poly[i * 3 + 1], z = poly[i * 3 + 2];
    let dup = false;
    for (let j = 0; j < out; j++) {
      const dx = poly[j * 3] - x, dy = poly[j * 3 + 1] - y, dz = poly[j * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz < WELD_EPS2) { dup = true; break; }
    }
    if (!dup) {
      if (out !== i) {
        poly[out * 3] = x; poly[out * 3 + 1] = y; poly[out * 3 + 2] = z;
      }
      out++;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Body vs body
// ═══════════════════════════════════════════════════════════════════════════

/** Sphere vs sphere. Normal points from A to B. */
export function sphereVsSphere(ax, ay, az, ra, bx, by, bz, rb, m) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const d2 = dx * dx + dy * dy + dz * dz;
  const r = ra + rb;
  if (d2 >= r * r) return false;
  const dist = Math.sqrt(d2);
  let nx, ny, nz;
  if (dist < 1e-9) { nx = 0; ny = 1; nz = 0; }
  else { const inv = 1 / dist; nx = dx * inv; ny = dy * inv; nz = dz * inv; }
  m.setNormal(nx, ny, nz);
  const depth = r - dist;
  m.add(ax + nx * (ra - depth * 0.5), ay + ny * (ra - depth * 0.5), az + nz * (ra - depth * 0.5),
    depth, 0);
  return true;
}

/**
 * Sphere vs convex hull. Normal points from the SPHERE (A) to the HULL (B),
 * i.e. `-outwardHullNormal`.
 */
export function sphereVsHull(cx, cy, cz, radius, cacheB, colB, m) {
  const F = colB.faceCount;
  const fN = cacheB.faceN, fD = cacheB.faceD;

  // Inside test + deepest face.
  let maxDist = -Infinity, maxFace = 0, outside = false;
  for (let f = 0; f < F; f++) {
    const dist = fN[f * 3] * cx + fN[f * 3 + 1] * cy + fN[f * 3 + 2] * cz - fD[f];
    if (dist > radius) return false;               // trivially separated
    if (dist > 0) outside = true;
    if (dist > maxDist) { maxDist = dist; maxFace = f; }
  }

  if (!outside) {
    // Centre inside the hull: push out through the nearest face.
    const nx = fN[maxFace * 3], ny = fN[maxFace * 3 + 1], nz = fN[maxFace * 3 + 2];
    m.setNormal(-nx, -ny, -nz);
    m.add(cx - nx * maxDist, cy - ny * maxDist, cz - nz * maxDist, radius - maxDist, maxFace);
    return true;
  }

  // Outside: closest point on the hull surface.
  let bestD2 = Infinity, bx = 0, by = 0, bz = 0;
  for (let f = 0; f < F; f++) {
    const nx = fN[f * 3], ny = fN[f * 3 + 1], nz = fN[f * 3 + 2];
    const dist = nx * cx + ny * cy + nz * cz - fD[f];
    if (dist <= 0) continue;
    // Project onto the face plane then clamp inside the polygon.
    let px = cx - nx * dist, py = cy - ny * dist, pz = cz - nz * dist;
    const s = colB.faceStart[f], e = colB.faceStart[f + 1];
    let insideAll = true;
    for (let i = s; i < e; i++) {
      const sd = cacheB.sideN[i * 3] * px + cacheB.sideN[i * 3 + 1] * py +
        cacheB.sideN[i * 3 + 2] * pz - cacheB.sideD[i];
      if (sd > 0) { insideAll = false; break; }
    }
    if (!insideAll) {
      // Clamp to the closest polygon edge.
      let eBest = Infinity, ex = 0, ey = 0, ez = 0;
      for (let i = s; i < e; i++) {
        const v0 = colB.faceVerts[i] * 3;
        const v1 = colB.faceVerts[i + 1 === e ? s : i + 1] * 3;
        const t = closestOnSegment(
          cacheB.verts[v0], cacheB.verts[v0 + 1], cacheB.verts[v0 + 2],
          cacheB.verts[v1], cacheB.verts[v1 + 1], cacheB.verts[v1 + 2],
          cx, cy, cz,
        );
        const qx = cacheB.verts[v0] + (cacheB.verts[v1] - cacheB.verts[v0]) * t;
        const qy = cacheB.verts[v0 + 1] + (cacheB.verts[v1 + 1] - cacheB.verts[v0 + 1]) * t;
        const qz = cacheB.verts[v0 + 2] + (cacheB.verts[v1 + 2] - cacheB.verts[v0 + 2]) * t;
        const d2 = (qx - cx) ** 2 + (qy - cy) ** 2 + (qz - cz) ** 2;
        if (d2 < eBest) { eBest = d2; ex = qx; ey = qy; ez = qz; }
      }
      px = ex; py = ey; pz = ez;
    }
    const d2 = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
    if (d2 < bestD2) { bestD2 = d2; bx = px; by = py; bz = pz; }
  }

  if (bestD2 > radius * radius || bestD2 === Infinity) return false;
  const dist = Math.sqrt(bestD2);
  let nx, ny, nz;
  if (dist < 1e-9) { nx = 0; ny = -1; nz = 0; }
  else { const inv = 1 / dist; nx = (bx - cx) * inv; ny = (by - cy) * inv; nz = (bz - cz) * inv; }
  m.setNormal(nx, ny, nz);
  m.add(bx, by, bz, radius - dist, 0);
  return true;
}

function closestOnSegment(ax, ay, az, bx, by, bz, px, py, pz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 < 1e-12) return 0;
  return clamp01(((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2);
}

/**
 * Convex hull vs convex hull. Normal points from A to B.
 * SAT over A's faces, B's faces and the edge-cross axes, then reference-face
 * clipping.
 */
export function hullVsHull(cacheA, colA, cacheB, colB, m) {
  let bestDepth = Infinity;
  let kind = -1, face = -1;
  let bnx = 0, bny = 1, bnz = 0;

  // ── A's faces (normal A→B = +nf) ─────────────────────────────────────
  for (let f = 0, F = colA.faceCount; f < F; f++) {
    const nx = cacheA.faceN[f * 3], ny = cacheA.faceN[f * 3 + 1], nz = cacheA.faceN[f * 3 + 2];
    let bMin = Infinity;
    for (let i = 0, VN = colB.vertexCount; i < VN; i++) {
      const d = cacheB.verts[i * 3] * nx + cacheB.verts[i * 3 + 1] * ny + cacheB.verts[i * 3 + 2] * nz;
      if (d < bMin) bMin = d;
    }
    const sep = bMin - cacheA.faceD[f];
    if (sep > 0) return false;
    if (-sep < bestDepth) { bestDepth = -sep; kind = 0; face = f; bnx = nx; bny = ny; bnz = nz; }
  }

  // ── B's faces (normal A→B = -nf) — small bias so A wins ties ─────────
  for (let f = 0, F = colB.faceCount; f < F; f++) {
    const nx = cacheB.faceN[f * 3], ny = cacheB.faceN[f * 3 + 1], nz = cacheB.faceN[f * 3 + 2];
    let aMin = Infinity;
    for (let i = 0, VN = colA.vertexCount; i < VN; i++) {
      const d = cacheA.verts[i * 3] * nx + cacheA.verts[i * 3 + 1] * ny + cacheA.verts[i * 3 + 2] * nz;
      if (d < aMin) aMin = d;
    }
    const sep = aMin - cacheB.faceD[f];
    if (sep > 0) return false;
    if (-sep < bestDepth - AXIS_EPS) {
      bestDepth = -sep; kind = 1; face = f; bnx = -nx; bny = -ny; bnz = -nz;
    }
  }

  // ── edge × edge ──────────────────────────────────────────────────────
  const ea = cacheA.edgeDir, eb = cacheB.edgeDir;
  for (let i = 0, EA = colA.edgeDirCount; i < EA; i++) {
    const ax = ea[i * 3], ay = ea[i * 3 + 1], az = ea[i * 3 + 2];
    for (let j = 0, EB = colB.edgeDirCount; j < EB; j++) {
      const bx = eb[j * 3], by = eb[j * 3 + 1], bz = eb[j * 3 + 2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const l2 = nx * nx + ny * ny + nz * nz;
      if (l2 < CROSS_EPS) continue;
      const inv = 1 / Math.sqrt(l2);
      nx *= inv; ny *= inv; nz *= inv;

      let aMin = Infinity, aMax = -Infinity;
      for (let k = 0, VN = colA.vertexCount; k < VN; k++) {
        const d = cacheA.verts[k * 3] * nx + cacheA.verts[k * 3 + 1] * ny + cacheA.verts[k * 3 + 2] * nz;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      let bMin = Infinity, bMax = -Infinity;
      for (let k = 0, VN = colB.vertexCount; k < VN; k++) {
        const d = cacheB.verts[k * 3] * nx + cacheB.verts[k * 3 + 1] * ny + cacheB.verts[k * 3 + 2] * nz;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      const sepPlus = bMin - aMax;      // B on the +n side of A
      const sepMinus = aMin - bMax;
      const sep = sepPlus > sepMinus ? sepPlus : sepMinus;
      if (sep > 0) return false;
      // Edge axes need a bigger margin or boxes jitter between face and edge.
      if (-sep < bestDepth - 8 * AXIS_EPS) {
        bestDepth = -sep; kind = 2; face = -1;
        if (sepPlus >= sepMinus) { bnx = nx; bny = ny; bnz = nz; }
        else { bnx = -nx; bny = -ny; bnz = -nz; }
      }
    }
  }

  if (kind < 0) return false;
  m.setNormal(bnx, bny, bnz);
  m.surfaceId = 0;
  m.triIndex = -1;

  if (kind === 2) {
    // Deepest points of each hull toward the other, averaged.
    const pa = supportVertex(cacheA, colA, bnx, bny, bnz);
    const pb = supportVertex(cacheB, colB, -bnx, -bny, -bnz);
    m.add(
      (cacheA.verts[pa * 3] + cacheB.verts[pb * 3]) * 0.5,
      (cacheA.verts[pa * 3 + 1] + cacheB.verts[pb * 3 + 1]) * 0.5,
      (cacheA.verts[pa * 3 + 2] + cacheB.verts[pb * 3 + 2]) * 0.5,
      bestDepth, 0x7fff,
    );
    return true;
  }

  // Reference / incident faces.
  const refCache = kind === 0 ? cacheA : cacheB;
  const refCol = kind === 0 ? colA : colB;
  const incCache = kind === 0 ? cacheB : cacheA;
  const incCol = kind === 0 ? colB : colA;
  const rnx = refCache.faceN[face * 3];
  const rny = refCache.faceN[face * 3 + 1];
  const rnz = refCache.faceN[face * 3 + 2];
  const rd = refCache.faceD[face];

  let inc = 0, incDot = Infinity;
  for (let f = 0, F = incCol.faceCount; f < F; f++) {
    const d = incCache.faceN[f * 3] * rnx + incCache.faceN[f * 3 + 1] * rny + incCache.faceN[f * 3 + 2] * rnz;
    if (d < incDot) { incDot = d; inc = f; }
  }

  const s = incCol.faceStart[inc], e = incCol.faceStart[inc + 1];
  let count = 0;
  for (let i = s; i < e && count < 32; i++) {
    const v = incCol.faceVerts[i] * 3;
    _polyA[count * 3] = incCache.verts[v];
    _polyA[count * 3 + 1] = incCache.verts[v + 1];
    _polyA[count * 3 + 2] = incCache.verts[v + 2];
    count++;
  }

  let src = _polyA, dst = _polyB;
  const rs = refCol.faceStart[face], re = refCol.faceStart[face + 1];
  for (let i = rs; i < re; i++) {
    count = clipToPlane(src, count, dst,
      refCache.sideN[i * 3], refCache.sideN[i * 3 + 1], refCache.sideN[i * 3 + 2], refCache.sideD[i]);
    const t = src; src = dst; dst = t;
    if (count === 0) break;
  }
  count = dedupePoly(src, count);

  let added = 0;
  for (let i = 0; i < count; i++) {
    const px = src[i * 3], py = src[i * 3 + 1], pz = src[i * 3 + 2];
    const depth = rd - (rnx * px + rny * py + rnz * pz);
    if (depth < -KEEP_SLOP) continue;
    if (m.add(px, py, pz, depth, ((face & 0x1fff) << 3) | (i & 7))) added++;
  }
  if (added === 0) {
    const pa = supportVertex(cacheA, colA, bnx, bny, bnz);
    m.add(cacheA.verts[pa * 3], cacheA.verts[pa * 3 + 1], cacheA.verts[pa * 3 + 2],
      bestDepth, 0x7ffe);
  }
  m.reduce();
  return m.count > 0;
}

function supportVertex(cache, col, nx, ny, nz) {
  let bi = 0, bd = -Infinity;
  for (let i = 0, VN = col.vertexCount; i < VN; i++) {
    const d = cache.verts[i * 3] * nx + cache.verts[i * 3 + 1] * ny + cache.verts[i * 3 + 2] * nz;
    if (d > bd) { bd = d; bi = i; }
  }
  return bi;
}

// ═══════════════════════════════════════════════════════════════════════════
// Swept sphere vs triangle (used by PhysicsWorld.sphereCast and CCD)
// ═══════════════════════════════════════════════════════════════════════════

/** Result of the last sweepSphereTriangle call. */
export const SWEEP = { t: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0 };

/**
 * Exact swept-sphere vs triangle. `dir` must be normalized.
 * @returns {boolean} true if it hits before `maxDist`, filling `SWEEP`.
 */
export function sweepSphereTriangle(ox, oy, oz, dx, dy, dz, radius, maxDist, tris, base, plane, po) {
  const nx = plane[po], ny = plane[po + 1], nz = plane[po + 2], nd = plane[po + 3];
  const denom = nx * dx + ny * dy + nz * dz;
  const dist = nx * ox + ny * oy + nz * oz - nd;

  let tPlane;
  if (Math.abs(denom) < 1e-9) {
    if (Math.abs(dist) > radius) return false;
    tPlane = 0;
  } else {
    // Sphere touches the plane when |dist + t*denom| == radius
    const side = dist >= 0 ? radius : -radius;
    tPlane = (side - dist) / denom;
    if (tPlane < 0) tPlane = 0;
  }

  if (tPlane <= maxDist) {
    const cx = ox + dx * tPlane, cy = oy + dy * tPlane, cz = oz + dz * tPlane;
    // Project the centre onto the plane and test containment.
    const d2 = nx * cx + ny * cy + nz * cz - nd;
    const px = cx - nx * d2, py = cy - ny * d2, pz = cz - nz * d2;
    if (pointInTriangle(tris, base, px, py, pz, nx, ny, nz)) {
      SWEEP.t = tPlane; SWEEP.px = px; SWEEP.py = py; SWEEP.pz = pz;
      SWEEP.nx = d2 >= 0 ? nx : -nx;
      SWEEP.ny = d2 >= 0 ? ny : -ny;
      SWEEP.nz = d2 >= 0 ? nz : -nz;
      return true;
    }
  }

  // Edges (capsules) and vertices (spheres).
  let best = maxDist, found = false;
  for (let e = 0; e < 3; e++) {
    const i0 = base + e * 3, i1 = base + ((e + 1) % 3) * 3;
    const t = rayCapsule(ox, oy, oz, dx, dy, dz, radius,
      tris[i0], tris[i0 + 1], tris[i0 + 2], tris[i1], tris[i1 + 1], tris[i1 + 2], best);
    if (t >= 0 && t < best) {
      best = t; found = true;
      const cx = ox + dx * t, cy = oy + dy * t, cz = oz + dz * t;
      const s = closestOnSegment(tris[i0], tris[i0 + 1], tris[i0 + 2],
        tris[i1], tris[i1 + 1], tris[i1 + 2], cx, cy, cz);
      const qx = tris[i0] + (tris[i1] - tris[i0]) * s;
      const qy = tris[i0 + 1] + (tris[i1 + 1] - tris[i0 + 1]) * s;
      const qz = tris[i0 + 2] + (tris[i1 + 2] - tris[i0 + 2]) * s;
      SWEEP.t = t; SWEEP.px = qx; SWEEP.py = qy; SWEEP.pz = qz;
      let ax = cx - qx, ay = cy - qy, az = cz - qz;
      const l = Math.hypot(ax, ay, az) || 1;
      SWEEP.nx = ax / l; SWEEP.ny = ay / l; SWEEP.nz = az / l;
    }
  }
  return found;
}

function pointInTriangle(tris, base, px, py, pz, nx, ny, nz) {
  for (let e = 0; e < 3; e++) {
    const i0 = base + e * 3, i1 = base + ((e + 1) % 3) * 3;
    const ex = tris[i1] - tris[i0], ey = tris[i1 + 1] - tris[i0 + 1], ez = tris[i1 + 2] - tris[i0 + 2];
    const vx = px - tris[i0], vy = py - tris[i0 + 1], vz = pz - tris[i0 + 2];
    const cx = ey * vz - ez * vy, cy = ez * vx - ex * vz, cz = ex * vy - ey * vx;
    if (cx * nx + cy * ny + cz * nz < -1e-7) return false;
  }
  return true;
}

/** Ray vs capsule (segment + radius). Returns t or -1. */
function rayCapsule(ox, oy, oz, dx, dy, dz, r, ax, ay, az, bx, by, bz, maxT) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const aox = ox - ax, aoy = oy - ay, aoz = oz - az;
  const abab = abx * abx + aby * aby + abz * abz;
  const abd = abx * dx + aby * dy + abz * dz;
  const abao = abx * aox + aby * aoy + abz * aoz;

  const A = abab - abd * abd;
  const B = abab * (aox * dx + aoy * dy + aoz * dz) - abao * abd;
  const C = abab * (aox * aox + aoy * aoy + aoz * aoz - r * r) - abao * abao;

  let t = -1;
  if (Math.abs(A) > 1e-12) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const tt = (-B - Math.sqrt(disc)) / A;
      if (tt >= 0 && tt <= maxT) {
        const y = abao + tt * abd;
        if (y >= 0 && y <= abab) t = tt;
      }
    }
  }
  // Endpoint spheres
  for (let s = 0; s < 2; s++) {
    const sx = s ? bx : ax, sy = s ? by : ay, sz = s ? bz : az;
    const ex = ox - sx, ey = oy - sy, ez = oz - sz;
    const b = ex * dx + ey * dy + ez * dz;
    const c = ex * ex + ey * ey + ez * ez - r * r;
    const disc = b * b - c;
    if (disc < 0) continue;
    const tt = -b - Math.sqrt(disc);
    if (tt >= 0 && tt <= maxT && (t < 0 || tt < t)) t = tt;
  }
  return t;
}

/** Ray vs convex hull (plane clipping). Returns entry t or -1. */
export function rayHull(ox, oy, oz, dx, dy, dz, maxT, cache, col, outNormal) {
  let tEnter = 0, tExit = maxT;
  let enterFace = -1;
  for (let f = 0, F = col.faceCount; f < F; f++) {
    const nx = cache.faceN[f * 3], ny = cache.faceN[f * 3 + 1], nz = cache.faceN[f * 3 + 2];
    const d = cache.faceD[f];
    const num = d - (nx * ox + ny * oy + nz * oz);
    const den = nx * dx + ny * dy + nz * dz;
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return -1;                 // parallel and outside
      continue;
    }
    const t = num / den;
    if (den < 0) {                            // entering
      if (t > tEnter) { tEnter = t; enterFace = f; }
    } else if (t < tExit) {
      tExit = t;
    }
    if (tEnter > tExit) return -1;
  }
  if (enterFace < 0) {
    // Origin already inside.
    if (outNormal) { outNormal[0] = -dx; outNormal[1] = -dy; outNormal[2] = -dz; }
    return 0;
  }
  if (outNormal) {
    outNormal[0] = cache.faceN[enterFace * 3];
    outNormal[1] = cache.faceN[enterFace * 3 + 1];
    outNormal[2] = cache.faceN[enterFace * 3 + 2];
  }
  return tEnter;
}

/** Ray vs sphere. Returns t or -1. */
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const ex = ox - cx, ey = oy - cy, ez = oz - cz;
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= maxT ? t : -1;
}

export default {
  Manifold, sphereVsTriangle, capsuleVsTriangle, hullVsTriangle,
  sphereVsSphere, sphereVsHull, hullVsHull,
  sweepSphereTriangle, rayHull, raySphere, SWEEP,
};
