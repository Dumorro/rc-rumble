/**
 * RC RUMBLE — collider shapes.
 *
 * Everything the narrow phase needs is precomputed here, once, at build time:
 * face planes, per-face side planes (for reference-face clipping), unique edge
 * directions (for SAT edge-edge axes), bounding radius, local AABB, volume and
 * the exact inertia tensor (tetrahedron decomposition about the body origin).
 *
 * Colliders are IMMUTABLE and may be shared between bodies. Anything that
 * depends on a body transform lives on the RigidBody's world cache instead.
 *
 * Units: metres / kilograms. The body origin is the centre of mass; a collider
 * may be offset from it (a car chassis hull usually sits above its COM).
 *
 * Shape types — 'sphere' | 'capsule' | 'box' | 'hull'.
 * 'box' is just a hull that knows it is a box (identical narrow-phase path),
 * which keeps the ARCHITECTURE.md `collider.type` contract intact.
 */

import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

export const ShapeType = Object.freeze({
  SPHERE: 'sphere',
  CAPSULE: 'capsule',
  BOX: 'box',
  HULL: 'hull',
});

/** A hull face-normal pair is treated as duplicate above this |dot|. */
const AXIS_DEDUP = 0.9995;

// ───────────────────────────────────────────────────────── scratch
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m3 = new THREE.Matrix3();

// ═══════════════════════════════════════════════════════════════════════════
// Closed-form inertia helpers (diagonal, about the shape centre)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Solid box inertia from FULL extents.
 * @param {number} mass @param {number} w @param {number} h @param {number} d
 * @param {THREE.Vector3} [out]
 */
export function boxInertia(mass, w, h, d, out = new THREE.Vector3()) {
  const k = mass / 12;
  return out.set(k * (h * h + d * d), k * (w * w + d * d), k * (w * w + h * h));
}

/** Solid box inertia from HALF extents. */
export function boxInertiaHalf(mass, hx, hy, hz, out = new THREE.Vector3()) {
  return boxInertia(mass, hx * 2, hy * 2, hz * 2, out);
}

/** Solid sphere inertia. I = 2/5 m r². */
export function sphereInertia(mass, r, out = new THREE.Vector3()) {
  const i = 0.4 * mass * r * r;
  return out.set(i, i, i);
}

/** Hollow sphere inertia. I = 2/3 m r². */
export function shellInertia(mass, r, out = new THREE.Vector3()) {
  const i = (2 / 3) * mass * r * r;
  return out.set(i, i, i);
}

/**
 * Solid cylinder inertia. `height` is the FULL length along `axis`.
 * @param {number} mass @param {number} r @param {number} height
 * @param {'x'|'y'|'z'} [axis]
 */
export function cylinderInertia(mass, r, height, axis = 'y', out = new THREE.Vector3()) {
  const along = 0.5 * mass * r * r;
  const across = (1 / 12) * mass * (3 * r * r + height * height);
  if (axis === 'x') return out.set(along, across, across);
  if (axis === 'z') return out.set(across, across, along);
  return out.set(across, along, across);
}

/**
 * Solid capsule (cylinder + two hemispherical caps) inertia.
 * `halfHeight` is half the length of the CYLINDRICAL section.
 */
export function capsuleInertia(mass, r, halfHeight, axis = 'y', out = new THREE.Vector3()) {
  const h = halfHeight * 2;
  const rr = r * r;
  const cylVol = Math.PI * rr * h;
  const capVol = (4 / 3) * Math.PI * rr * r;
  const total = cylVol + capVol || 1;
  const mc = mass * (cylVol / total);
  const ms = mass * (capVol / total);

  const along = 0.5 * mc * rr + 0.4 * ms * rr;
  // Cylinder across + two hemispheres shifted by halfHeight (parallel axis).
  const across =
    mc * (rr * 0.25 + (h * h) / 12) +
    ms * (0.4 * rr + halfHeight * halfHeight + 0.375 * r * halfHeight * 2);

  if (axis === 'x') return out.set(along, across, across);
  if (axis === 'z') return out.set(across, across, along);
  return out.set(across, along, across);
}

/** Shift an inertia diagonal from the centre of mass to an offset point. */
export function parallelAxis(inertia, mass, offset, out = new THREE.Vector3()) {
  const { x, y, z } = offset;
  return out.set(
    inertia.x + mass * (y * y + z * z),
    inertia.y + mass * (x * x + z * z),
    inertia.z + mass * (x * x + y * y),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Hull construction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {object} HullCollider
 * @property {'hull'|'box'} type
 * @property {Float32Array} vertices        3*V local positions
 * @property {number} vertexCount
 * @property {Float32Array} faceNormals     3*F outward unit normals
 * @property {Float32Array} faceOffsets     F, plane is  dot(n, x) = offset
 * @property {Uint32Array}  faceStart       F+1 offsets into faceVerts
 * @property {Uint32Array}  faceVerts       CCW vertex indices, per face
 * @property {Float32Array} sideNormals     3*faceVerts.length outward side planes
 * @property {Float32Array} sideOffsets     faceVerts.length
 * @property {Uint32Array}  edgeVerts       2*E unique undirected edges
 * @property {Float32Array} edgeDirs        3*Eu deduplicated unit edge directions
 * @property {number} edgeDirCount
 * @property {Float32Array} localMin        3
 * @property {Float32Array} localMax        3
 * @property {Float64Array} centroid        3 (double — mass property)
 * @property {number} volume
 * @property {number} boundingRadius        about the LOCAL ORIGIN (= body COM)
 * @property {Float64Array} inertiaUnit     3, inertia diagonal for mass = 1 about origin (double)
 */

/**
 * Assemble the derived hull data from a vertex soup + CCW face loops.
 *
 * Precision: `vertices` is kept as Float32Array (that is what the narrow phase
 * reads, and 24 bits of mantissa is far more than a 30 cm collider needs), but
 * every *mass property* is computed from a full-double copy of the input and
 * stored as Float64Array. Volume and inertia are integrals of a cubic and a
 * quintic in the vertex coordinates, so float32 inputs would leak ~1e-7
 * relative error into a number the vehicle code divides by every step.
 *
 * Winding: the loops are re-oriented here, BEFORE anything derived from them is
 * computed. A single inward-facing face would flip the sign of its tetrahedra
 * and silently cancel part of the volume, so this has to happen first.
 *
 * @param {ArrayLike<number>} vertsFlat 3*V
 * @param {number[][]} loops CCW vertex index loops
 * @param {'hull'|'box'} type
 * @returns {HullCollider}
 */
export function buildHullData(vertsFlat, loops, type = ShapeType.HULL) {
  const V = (vertsFlat.length / 3) | 0;
  // Double-precision working copy — mass properties are computed from this.
  const dv = vertsFlat instanceof Float64Array ? vertsFlat : new Float64Array(vertsFlat);
  const vertices = new Float32Array(dv);
  const F = loops.length;

  let totalIdx = 0;
  for (let i = 0; i < F; i++) totalIdx += loops[i].length;

  const faceNormals = new Float32Array(F * 3);
  const faceOffsets = new Float32Array(F);
  const faceStart = new Uint32Array(F + 1);
  const faceVerts = new Uint32Array(totalIdx);
  const sideNormals = new Float32Array(totalIdx * 3);
  const sideOffsets = new Float32Array(totalIdx);

  // ── 1. flatten the loops ────────────────────────────────────────────
  let cursor = 0;
  for (let f = 0; f < F; f++) {
    const loop = loops[f];
    faceStart[f] = cursor;
    for (let i = 0; i < loop.length; i++) faceVerts[cursor++] = loop[i];
  }
  faceStart[F] = cursor;

  // ── 2. interior reference point ─────────────────────────────────────
  // The average of the vertices of a convex polyhedron is strictly inside it,
  // which is all the winding test needs (and unlike the mass centroid it does
  // not depend on the winding we are about to fix).
  let ix = 0, iy = 0, iz = 0;
  for (let i = 0; i < V; i++) { ix += dv[i * 3]; iy += dv[i * 3 + 1]; iz += dv[i * 3 + 2]; }
  if (V > 0) { ix /= V; iy /= V; iz /= V; }

  // ── 3. face normals (Newell) + winding fix ──────────────────────────
  for (let f = 0; f < F; f++) {
    const s = faceStart[f], e = faceStart[f + 1];
    const n = e - s;

    // Newell's method — robust for any planar n-gon.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const a = faceVerts[s + i] * 3;
      const b = faceVerts[s + ((i + 1) % n)] * 3;
      const ax = dv[a], ay = dv[a + 1], az = dv[a + 2];
      const bx = dv[b], by = dv[b + 1], bz = dv[b + 2];
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    let len = Math.hypot(nx, ny, nz);
    if (len < 1e-14) { nx = 0; ny = 1; nz = 0; len = 1; }
    nx /= len; ny /= len; nz /= len;

    // Inward-facing? Reverse the loop so every face is CCW seen from outside.
    const v0 = faceVerts[s] * 3;
    const d = nx * dv[v0] + ny * dv[v0 + 1] + nz * dv[v0 + 2];
    if (nx * ix + ny * iy + nz * iz > d) {
      for (let i = s + 1, j = e - 1; i < j; i++, j--) {
        const t = faceVerts[i]; faceVerts[i] = faceVerts[j]; faceVerts[j] = t;
      }
      nx = -nx; ny = -ny; nz = -nz;
    }

    faceNormals[f * 3] = nx; faceNormals[f * 3 + 1] = ny; faceNormals[f * 3 + 2] = nz;
    const w0 = faceVerts[s] * 3;
    faceOffsets[f] = nx * dv[w0] + ny * dv[w0 + 1] + nz * dv[w0 + 2];

    // ── 4. per-edge outward side planes (reference-face clipping) ─────
    for (let i = s; i < e; i++) {
      const a = faceVerts[i] * 3;
      const b = faceVerts[i + 1 === e ? s : i + 1] * 3;
      const ex = dv[b] - dv[a];
      const ey = dv[b + 1] - dv[a + 1];
      const ez = dv[b + 2] - dv[a + 2];
      // outward side plane normal = normalize(edge × faceNormal)
      let sx = ey * nz - ez * ny;
      let sy = ez * nx - ex * nz;
      let sz = ex * ny - ey * nx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl; sy /= sl; sz /= sl;
      sideNormals[i * 3] = sx;
      sideNormals[i * 3 + 1] = sy;
      sideNormals[i * 3 + 2] = sz;
      sideOffsets[i] = sx * dv[a] + sy * dv[a + 1] + sz * dv[a + 2];
    }
  }

  // ── unique undirected edges ─────────────────────────────────────────
  /** @type {Map<number, number>} */
  const edgeMap = new Map();
  const edgeList = [];
  for (let f = 0; f < F; f++) {
    const s = faceStart[f], e = faceStart[f + 1];
    for (let i = s; i < e; i++) {
      const a = faceVerts[i];
      const b = faceVerts[i + 1 === e ? s : i + 1];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const key = lo * V + hi;
      if (!edgeMap.has(key)) { edgeMap.set(key, edgeList.length >> 1); edgeList.push(lo, hi); }
    }
  }
  const edgeVerts = new Uint32Array(edgeList);

  // ── deduplicated edge directions (SAT edge axes) ────────────────────
  const dirs = [];
  for (let i = 0; i < edgeVerts.length; i += 2) {
    const a = edgeVerts[i] * 3, b = edgeVerts[i + 1] * 3;
    let dx = dv[b] - dv[a];
    let dy = dv[b + 1] - dv[a + 1];
    let dz = dv[b + 2] - dv[a + 2];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-9) continue;
    dx /= l; dy /= l; dz /= l;
    let dup = false;
    for (let k = 0; k < dirs.length; k += 3) {
      const d = Math.abs(dirs[k] * dx + dirs[k + 1] * dy + dirs[k + 2] * dz);
      if (d > AXIS_DEDUP) { dup = true; break; }
    }
    if (!dup) dirs.push(dx, dy, dz);
  }
  const edgeDirs = new Float32Array(dirs);

  // ── bounds / mass properties ────────────────────────────────────────
  const localMin = new Float32Array([Infinity, Infinity, Infinity]);
  const localMax = new Float32Array([-Infinity, -Infinity, -Infinity]);
  let boundingRadius = 0;
  for (let i = 0; i < V; i++) {
    const x = dv[i * 3], y = dv[i * 3 + 1], z = dv[i * 3 + 2];
    if (x < localMin[0]) localMin[0] = x; if (x > localMax[0]) localMax[0] = x;
    if (y < localMin[1]) localMin[1] = y; if (y > localMax[1]) localMax[1] = y;
    if (z < localMin[2]) localMin[2] = z; if (z > localMax[2]) localMax[2] = z;
    const r = x * x + y * y + z * z;
    if (r > boundingRadius) boundingRadius = r;
  }
  boundingRadius = Math.sqrt(boundingRadius);

  const mp = hullMassProperties(dv, faceStart, faceVerts, F);

  return {
    type,
    vertices,
    vertexCount: V,
    faceCount: F,
    faceNormals,
    faceOffsets,
    faceStart,
    faceVerts,
    sideNormals,
    sideOffsets,
    edgeVerts,
    edgeDirs,
    edgeDirCount: (edgeDirs.length / 3) | 0,
    localMin,
    localMax,
    centroid: mp.centroid,
    volume: mp.volume,
    boundingRadius,
    inertiaUnit: mp.inertiaUnit,
  };
}

/**
 * Exact hull volume / centroid / inertia by tetrahedron decomposition about
 * the local origin. `inertiaUnit` is the diagonal for mass = 1 measured about
 * the LOCAL ORIGIN (= the body's centre of mass).
 *
 * Derivation of the 1/60 constant, since it is easy to get wrong:
 * for a tetrahedron (v0..v3) barycentric integration gives
 *   ∫ λa·λb dV = V·(1 + δab)/20
 * so with v0 = origin and the face triangle p0,p1,p2,
 *   ∫ x² dV = (V/20)·[ (Σxi)² + Σxi² ] = (V/10)·(x0²+x1²+x2² + x0x1+x1x2+x2x0)
 * and V = det/6, hence ∫x² dV = det·fx/60 with fx the symmetric sum below.
 * Ixx = ∫(y²+z²)ρ dV, and ρ = 1/volume for unit mass.
 *
 * `vertices` MUST be double precision — see buildHullData.
 */
function hullMassProperties(vertices, faceStart, faceVerts, F) {
  let volume = 0;
  let cx = 0, cy = 0, cz = 0;
  let ia = 0, ib = 0, ic = 0; // xx-ish integrals

  for (let f = 0; f < F; f++) {
    const s = faceStart[f], e = faceStart[f + 1];
    const i0 = faceVerts[s] * 3;
    const x0 = vertices[i0], y0 = vertices[i0 + 1], z0 = vertices[i0 + 2];
    for (let i = s + 1; i < e - 1; i++) {
      const i1 = faceVerts[i] * 3, i2 = faceVerts[i + 1] * 3;
      const x1 = vertices[i1], y1 = vertices[i1 + 1], z1 = vertices[i1 + 2];
      const x2 = vertices[i2], y2 = vertices[i2 + 1], z2 = vertices[i2 + 2];

      // det = a · (b × c)  → 6 × signed tetra volume with the origin
      const det =
        x0 * (y1 * z2 - z1 * y2) -
        y0 * (x1 * z2 - z1 * x2) +
        z0 * (x1 * y2 - y1 * x2);

      volume += det;
      cx += det * (x0 + x1 + x2);
      cy += det * (y0 + y1 + y2);
      cz += det * (z0 + z1 + z2);

      // Second-order integrals over the tetrahedron (0, p0, p1, p2)
      const fx = x0 * x0 + x1 * x1 + x2 * x2 + x0 * x1 + x1 * x2 + x2 * x0;
      const fy = y0 * y0 + y1 * y1 + y2 * y2 + y0 * y1 + y1 * y2 + y2 * y0;
      const fz = z0 * z0 + z1 * z1 + z2 * z2 + z0 * z1 + z1 * z2 + z2 * z0;
      ia += det * (fy + fz);
      ib += det * (fx + fz);
      ic += det * (fx + fy);
    }
  }

  volume /= 6;
  const centroid = new Float64Array(3);
  if (Math.abs(volume) > 1e-12) {
    const k = 1 / (24 * volume);
    centroid[0] = cx * k; centroid[1] = cy * k; centroid[2] = cz * k;
  }

  // ∫ over tets of (y²+z²) dV = det * f / 60 ; unit density mass = volume
  const inertiaUnit = new Float64Array(3);
  if (Math.abs(volume) > 1e-12) {
    const k = 1 / (60 * volume);
    inertiaUnit[0] = Math.abs(ia * k);
    inertiaUnit[1] = Math.abs(ib * k);
    inertiaUnit[2] = Math.abs(ic * k);
  }
  return { volume: Math.abs(volume), centroid, inertiaUnit };
}

// ═══════════════════════════════════════════════════════════════════════════
// Factories
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Axis-aligned box hull.
 * @param {number} hx half extent X @param {number} hy @param {number} hz
 * @param {THREE.Vector3|{x,y,z}} [center] local offset from the body origin
 */
export function makeBox(hx, hy, hz, center = null) {
  const ox = center?.x ?? 0, oy = center?.y ?? 0, oz = center?.z ?? 0;
  // f64 so the tetra decomposition reproduces m/12·(h²+d²) exactly.
  const v = new Float64Array(24);
  let k = 0;
  for (let i = 0; i < 8; i++) {
    v[k++] = ox + ((i & 1) ? hx : -hx);
    v[k++] = oy + ((i & 2) ? hy : -hy);
    v[k++] = oz + ((i & 4) ? hz : -hz);
  }
  // vertex index bits: 1 = +x, 2 = +y, 4 = +z. Loops are CCW seen from outside.
  const loops = [
    [1, 3, 7, 5], // +x
    [0, 4, 6, 2], // -x
    [2, 6, 7, 3], // +y
    [0, 1, 5, 4], // -y
    [4, 5, 7, 6], // +z
    [0, 2, 3, 1], // -z
  ];
  return buildHullData(v, loops, ShapeType.BOX);
}

/** Convenience: box from full size. */
export function makeBoxSize(w, h, d, center = null) {
  return makeBox(w * 0.5, h * 0.5, d * 0.5, center);
}

/** Sphere collider. */
export function makeSphere(radius, center = null) {
  const c = new Float64Array([center?.x ?? 0, center?.y ?? 0, center?.z ?? 0]);
  const inertiaUnit = new Float64Array(3);
  const i = 0.4 * radius * radius;
  inertiaUnit[0] = i + (c[1] * c[1] + c[2] * c[2]);
  inertiaUnit[1] = i + (c[0] * c[0] + c[2] * c[2]);
  inertiaUnit[2] = i + (c[0] * c[0] + c[1] * c[1]);
  return {
    type: ShapeType.SPHERE,
    radius,
    centroid: c,
    volume: (4 / 3) * Math.PI * radius ** 3,
    boundingRadius: Math.hypot(c[0], c[1], c[2]) + radius,
    localMin: new Float32Array([c[0] - radius, c[1] - radius, c[2] - radius]),
    localMax: new Float32Array([c[0] + radius, c[1] + radius, c[2] + radius]),
    inertiaUnit,
  };
}

/**
 * Capsule collider — a segment with a radius. `halfHeight` is half the length
 * of the cylindrical section (so total length = 2*halfHeight + 2*radius).
 * @param {'x'|'y'|'z'} axis
 */
export function makeCapsule(radius, halfHeight, axis = 'y', center = null) {
  const c = new Float64Array([center?.x ?? 0, center?.y ?? 0, center?.z ?? 0]);
  const a = new Float64Array(3);
  a[axis === 'x' ? 0 : axis === 'z' ? 2 : 1] = 1;
  const p0 = new Float64Array([c[0] - a[0] * halfHeight, c[1] - a[1] * halfHeight, c[2] - a[2] * halfHeight]);
  const p1 = new Float64Array([c[0] + a[0] * halfHeight, c[1] + a[1] * halfHeight, c[2] + a[2] * halfHeight]);
  const inertia = capsuleInertia(1, radius, halfHeight, axis, _v0);
  const inertiaUnit = new Float64Array([
    inertia.x + (c[1] * c[1] + c[2] * c[2]),
    inertia.y + (c[0] * c[0] + c[2] * c[2]),
    inertia.z + (c[0] * c[0] + c[1] * c[1]),
  ]);
  const r3 = radius;
  return {
    type: ShapeType.CAPSULE,
    radius,
    halfHeight,
    axis: a,
    p0, p1,
    centroid: c,
    volume: Math.PI * radius * radius * (2 * halfHeight) + (4 / 3) * Math.PI * radius ** 3,
    boundingRadius: Math.hypot(c[0], c[1], c[2]) + halfHeight + radius,
    localMin: new Float32Array([
      Math.min(p0[0], p1[0]) - r3, Math.min(p0[1], p1[1]) - r3, Math.min(p0[2], p1[2]) - r3]),
    localMax: new Float32Array([
      Math.max(p0[0], p1[0]) + r3, Math.max(p0[1], p1[1]) + r3, Math.max(p0[2], p1[2]) + r3]),
    inertiaUnit,
  };
}

/**
 * N-gon prism approximating a cylinder — used for wheels, cans, barrels.
 * `halfHeight` is half the length along `axis`.
 */
export function makeCylinder(radius, halfHeight, segments = 12, axis = 'y', center = null) {
  const n = Math.max(3, segments | 0);
  const ox = center?.x ?? 0, oy = center?.y ?? 0, oz = center?.z ?? 0;
  // Inscribed radius correction so the prism has ~the same volume as the cylinder.
  const r = radius / Math.cos(Math.PI / n);
  const verts = new Float64Array(n * 6);
  const ai = axis === 'x' ? 0 : axis === 'z' ? 2 : 1;
  const u = (ai + 1) % 3, w = (ai + 2) % 3;
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    const cu = Math.cos(th) * r, cw = Math.sin(th) * r;
    for (let s = 0; s < 2; s++) {
      const base = (i * 2 + s) * 3;
      verts[base + ai] = (s ? halfHeight : -halfHeight);
      verts[base + u] = cu;
      verts[base + w] = cw;
      verts[base] += ox; verts[base + 1] += oy; verts[base + 2] += oz;
    }
  }
  const loops = [];
  const top = [], bottom = [];
  for (let i = 0; i < n; i++) { top.push(i * 2 + 1); bottom.push((n - 1 - i) * 2); }
  loops.push(top, bottom);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    loops.push([i * 2, j * 2, j * 2 + 1, i * 2 + 1]);
  }
  // buildHullData re-orients any inward loop itself (the top/bottom cap winding
  // flips with the axis handedness), so nothing else is needed here.
  return buildHullData(verts, loops, ShapeType.HULL);
}

/**
 * Convex hull of an arbitrary point cloud. Coplanar triangles emitted by
 * quickhull are merged back into n-gons so reference-face clipping produces
 * clean 4-point manifolds on boxy shapes.
 * @param {Array<THREE.Vector3|number[]>|Float32Array} points
 */
export function makeHull(points) {
  const pts = [];
  if (points instanceof Float32Array || (Array.isArray(points) && typeof points[0] === 'number')) {
    for (let i = 0; i + 2 < points.length; i += 3) pts.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));
  } else {
    for (const p of points) pts.push(p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2]));
  }
  if (pts.length < 4) {
    // Degenerate — fall back to the AABB of whatever we were given.
    const box = new THREE.Box3().setFromPoints(pts.length ? pts : [new THREE.Vector3()]);
    box.expandByScalar(1e-3);
    const c = box.getCenter(_v0).clone();
    const s = box.getSize(_v1);
    return makeBox(s.x * 0.5, s.y * 0.5, s.z * 0.5, c);
  }

  let ch;
  try { ch = new ConvexHull().setFromPoints(pts); }
  catch { ch = null; }
  if (!ch || !ch.faces || ch.faces.length < 4) {
    const box = new THREE.Box3().setFromPoints(pts);
    const c = box.getCenter(_v0).clone();
    const s = box.getSize(_v1);
    return makeBox(Math.max(s.x * 0.5, 1e-3), Math.max(s.y * 0.5, 1e-3), Math.max(s.z * 0.5, 1e-3), c);
  }

  // Collect unique vertices (welded) and per-face index loops.
  const vertIndex = new Map();
  const verts = [];
  const keyOf = (p) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)},${Math.round(p.z * 1e5)}`;
  const idOf = (p) => {
    const k = keyOf(p);
    let id = vertIndex.get(k);
    if (id === undefined) { id = verts.length / 3; verts.push(p.x, p.y, p.z); vertIndex.set(k, id); }
    return id;
  };

  const rawFaces = [];
  for (const face of ch.faces) {
    const loop = [];
    let e = face.edge;
    let guard = 0;
    do {
      loop.push(idOf(e.head().point));
      e = e.next;
    } while (e !== face.edge && ++guard < 64);
    if (loop.length >= 3) {
      rawFaces.push({ loop, nx: face.normal.x, ny: face.normal.y, nz: face.normal.z });
    }
  }

  const merged = mergeCoplanarFaces(verts, rawFaces);
  // `verts` is a plain (double) array — hand it over as-is so the mass
  // properties keep full precision.
  return buildHullData(verts, merged, ShapeType.HULL);
}

/** Build a hull from a THREE.BufferGeometry's positions. */
export function makeHullFromGeometry(geometry, matrix = null) {
  const pos = geometry.getAttribute?.('position');
  if (!pos) return makeBox(0.05, 0.05, 0.05);
  const pts = [];
  for (let i = 0; i < pos.count; i++) {
    _v0.fromBufferAttribute(pos, i);
    if (matrix) _v0.applyMatrix4(matrix);
    pts.push(_v0.clone());
  }
  return makeHull(pts);
}

/**
 * Merge triangles that share a plane into a single convex n-gon face.
 * Returns an array of CCW index loops.
 */
function mergeCoplanarFaces(verts, faces) {
  const used = new Uint8Array(faces.length);
  const out = [];
  const NRM_EPS = 0.999;
  const D_EPS = 1e-4;

  const planeD = (f) => {
    const i = f.loop[0] * 3;
    return f.nx * verts[i] + f.ny * verts[i + 1] + f.nz * verts[i + 2];
  };

  for (let i = 0; i < faces.length; i++) {
    if (used[i]) continue;
    const group = [faces[i]];
    used[i] = 1;
    const nx = faces[i].nx, ny = faces[i].ny, nz = faces[i].nz;
    const d = planeD(faces[i]);
    for (let j = i + 1; j < faces.length; j++) {
      if (used[j]) continue;
      const f = faces[j];
      if (f.nx * nx + f.ny * ny + f.nz * nz < NRM_EPS) continue;
      if (Math.abs(planeD(f) - d) > D_EPS) continue;
      used[j] = 1;
      group.push(f);
    }
    if (group.length === 1) { out.push(group[0].loop); continue; }

    // Boundary = directed edges appearing exactly once within the group.
    const edges = new Map();
    for (const f of group) {
      const L = f.loop;
      for (let k = 0; k < L.length; k++) {
        const a = L[k], b = L[(k + 1) % L.length];
        const rev = b * 1e6 + a;
        if (edges.has(rev)) edges.delete(rev);
        else edges.set(a * 1e6 + b, b);
      }
    }
    if (edges.size < 3) { for (const f of group) out.push(f.loop); continue; }

    const next = new Map();
    for (const [k, b] of edges) next.set(Math.floor(k / 1e6), b);
    const startV = next.keys().next().value;
    const loop = [startV];
    let cur = next.get(startV);
    let guard = 0;
    while (cur !== undefined && cur !== startV && ++guard < 256) {
      loop.push(cur);
      cur = next.get(cur);
    }
    if (loop.length >= 3 && cur === startV) {
      out.push(removeCollinear(verts, loop));
    } else {
      for (const f of group) out.push(f.loop);
    }
  }
  return out;
}

/** Drop vertices that sit on the straight line between their neighbours. */
function removeCollinear(verts, loop) {
  if (loop.length <= 3) return loop;
  const keep = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n] * 3, b = loop[i] * 3, c = loop[(i + 1) % n] * 3;
    const ax = verts[b] - verts[a], ay = verts[b + 1] - verts[a + 1], az = verts[b + 2] - verts[a + 2];
    const bx = verts[c] - verts[b], by = verts[c + 1] - verts[b + 1], bz = verts[c + 2] - verts[b + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const area = Math.hypot(cx, cy, cz);
    const scale = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
    if (area > scale * 1e-4) keep.push(loop[i]);
  }
  return keep.length >= 3 ? keep : loop;
}

/**
 * Is this hull a closed, consistently wound, convex polyhedron?
 *
 * Mass properties are only meaningful for a closed surface: an unclosed hull
 * (quickhull dropped a coplanar point) or an inconsistently wound one silently
 * cancels part of the tetrahedron sum and reports a plausible-looking but wrong
 * volume/inertia. Cheap enough to assert on in tests and asset pipelines.
 *
 * @param {HullCollider} hull
 * @returns {{ok:boolean, closed:boolean, wound:boolean, convex:boolean,
 *            openEdges:number, doubledEdges:number, inwardFaces:number,
 *            nonConvexFaces:number}}
 */
export function validateHull(hull) {
  const r = {
    ok: false, closed: false, wound: false, convex: false,
    openEdges: 0, doubledEdges: 0, inwardFaces: 0, nonConvexFaces: 0,
  };
  if (!hull || !hull.faceStart || hull.faceCount < 4) return r;

  const { faceStart, faceVerts, faceCount, faceNormals, faceOffsets, vertices, vertexCount } = hull;

  // Every directed edge (a→b) must appear exactly once, and its opposite
  // (b→a) exactly once — i.e. each undirected edge is shared by exactly two
  // faces that traverse it in opposite directions.
  const dir = new Map();
  for (let f = 0; f < faceCount; f++) {
    const s = faceStart[f], e = faceStart[f + 1];
    for (let i = s; i < e; i++) {
      const a = faceVerts[i], b = faceVerts[i + 1 === e ? s : i + 1];
      const key = a * vertexCount + b;
      dir.set(key, (dir.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of dir) {
    const a = Math.floor(key / vertexCount), b = key % vertexCount;
    if (n !== 1) r.doubledEdges++;
    if ((dir.get(b * vertexCount + a) ?? 0) !== 1) r.openEdges++;
  }
  r.closed = r.openEdges === 0 && r.doubledEdges === 0;

  // Every vertex must be on or behind every face plane, and every face normal
  // must point away from the interior.
  let ix = 0, iy = 0, iz = 0;
  for (let i = 0; i < vertexCount; i++) {
    ix += vertices[i * 3]; iy += vertices[i * 3 + 1]; iz += vertices[i * 3 + 2];
  }
  ix /= vertexCount; iy /= vertexCount; iz /= vertexCount;

  const tol = Math.max(1e-5, hull.boundingRadius * 1e-4);
  for (let f = 0; f < faceCount; f++) {
    const nx = faceNormals[f * 3], ny = faceNormals[f * 3 + 1], nz = faceNormals[f * 3 + 2];
    const d = faceOffsets[f];
    if (nx * ix + ny * iy + nz * iz - d > -tol) r.inwardFaces++;
    for (let i = 0; i < vertexCount; i++) {
      if (nx * vertices[i * 3] + ny * vertices[i * 3 + 1] + nz * vertices[i * 3 + 2] - d > tol) {
        r.nonConvexFaces++;
        break;
      }
    }
  }
  r.wound = r.inwardFaces === 0;
  r.convex = r.nonConvexFaces === 0;
  r.ok = r.closed && r.wound && r.convex;
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
// Queries
// ═══════════════════════════════════════════════════════════════════════════

/** Furthest vertex index along a LOCAL direction. */
export function hullSupport(hull, dx, dy, dz) {
  const v = hull.vertices;
  let best = 0, bestD = -Infinity;
  for (let i = 0, n = hull.vertexCount; i < n; i++) {
    const d = v[i * 3] * dx + v[i * 3 + 1] * dy + v[i * 3 + 2] * dz;
    if (d > bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Inertia diagonal for a collider at a given mass, about the body origin. */
export function colliderInertia(collider, mass, out = new THREE.Vector3()) {
  if (!collider || !collider.inertiaUnit) {
    const i = mass * 0.01;
    return out.set(i, i, i);
  }
  const u = collider.inertiaUnit;
  return out.set(mass * u[0], mass * u[1], mass * u[2]);
}

/**
 * World AABB of a collider under a rigid transform, via the abs-matrix trick.
 * Allocation free.
 */
export function colliderAABB(collider, position, quaternion, outMin, outMax, margin = 0) {
  if (!collider) {
    outMin.set(position.x - margin, position.y - margin, position.z - margin);
    outMax.set(position.x + margin, position.y + margin, position.z + margin);
    return;
  }
  const lmin = collider.localMin, lmax = collider.localMax;
  const cx = (lmin[0] + lmax[0]) * 0.5, cy = (lmin[1] + lmax[1]) * 0.5, cz = (lmin[2] + lmax[2]) * 0.5;
  const ex = (lmax[0] - lmin[0]) * 0.5, ey = (lmax[1] - lmin[1]) * 0.5, ez = (lmax[2] - lmin[2]) * 0.5;

  const e = quatToMatrix3(quaternion, _m3).elements;
  // column-major: e[0..2] = col0, e[3..5] = col1, e[6..8] = col2
  const wx = position.x + e[0] * cx + e[3] * cy + e[6] * cz;
  const wy = position.y + e[1] * cx + e[4] * cy + e[7] * cz;
  const wz = position.z + e[2] * cx + e[5] * cy + e[8] * cz;

  const rx = Math.abs(e[0]) * ex + Math.abs(e[3]) * ey + Math.abs(e[6]) * ez + margin;
  const ry = Math.abs(e[1]) * ex + Math.abs(e[4]) * ey + Math.abs(e[7]) * ez + margin;
  const rz = Math.abs(e[2]) * ex + Math.abs(e[5]) * ey + Math.abs(e[8]) * ez + margin;

  outMin.set(wx - rx, wy - ry, wz - rz);
  outMax.set(wx + rx, wy + ry, wz + rz);
}

/** Quaternion → Matrix3 without going through Matrix4. Allocation free. */
export function quatToMatrix3(q, out) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const e = out.elements;
  e[0] = 1 - (yy + zz); e[1] = xy + wz;       e[2] = xz - wy;
  e[3] = xy - wz;       e[4] = 1 - (xx + zz); e[5] = yz + wx;
  e[6] = xz + wy;       e[7] = yz - wx;       e[8] = 1 - (xx + yy);
  return out;
}

export default {
  ShapeType, makeBox, makeBoxSize, makeSphere, makeCapsule, makeCylinder,
  makeHull, makeHullFromGeometry, buildHullData, hullSupport, validateHull,
  boxInertia, boxInertiaHalf, sphereInertia, shellInertia,
  cylinderInertia, capsuleInertia, parallelAxis, colliderInertia,
  colliderAABB, quatToMatrix3,
};
