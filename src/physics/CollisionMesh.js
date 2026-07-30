/**
 * RC RUMBLE — static collision mesh.
 *
 * A BVH-indexed triangle soup plus everything the narrow phase needs
 * precomputed per triangle:
 *
 *   tris         Float32Array 9T   de-indexed vertices (a, b, c)
 *   planes       Float32Array 4T   unit normal + plane offset d  (n·x = d)
 *   surfaceIds   Uint8Array   T    canonical surface id (ARCHITECTURE.md table)
 *   edgeConvex   Uint8Array   T    bit i = edge (i → i+1) is a GENUINE convex
 *                                  feature. Coplanar / concave / welded seams
 *                                  are 0 and their contact normals get snapped
 *                                  to the face normal — this is what stops cars
 *                                  catching on the seam between two floor tris.
 *   neighbours   Int32Array   3T   adjacent triangle per edge, -1 = boundary
 *
 * Tracks are assembled by merging many geometries with different surface ids
 * into one mesh:
 *
 *   const b = new CollisionMeshBuilder();
 *   b.addGeometry(floorGeo, SURFACE.wood, floorMatrix);
 *   b.addObject3D(propsGroup);            // reads mesh.userData.surfaceId
 *   const collision = b.build();
 */

import * as THREE from 'three';
import { BVH, createBVHRayResult } from './BVH.js';

/** Below this |sin(dihedral)| an edge counts as internal (normal gets snapped). */
const DEFAULT_CONVEX_SIN = 0.10;   // ≈ 5.7°
/** Vertex welding grid, in metres. 0.1 mm is far below RC-scale detail. */
const WELD = 1e-4;

const _v0 = new THREE.Vector3();
const _bvhHit = createBVHRayResult();

/** @typedef {{hit:boolean, point:THREE.Vector3, normal:THREE.Vector3,
 *             distance:number, surfaceId:number, triIndex:number,
 *             body:import('./RigidBody.js').RigidBody|null}} RayHit */

/** Allocate a reusable raycast result. Callers should keep one per call site. */
export function createRayHit() {
  return {
    hit: false,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    distance: Infinity,
    surfaceId: 0,
    triIndex: -1,
    body: null,
  };
}

export class CollisionMesh {
  /**
   * @param {Float32Array} tris 9 floats per triangle
   * @param {Uint8Array} surfaceIds one per triangle
   * @param {{convexSin?:number, buildAdjacency?:boolean, name?:string}} [opts]
   */
  constructor(tris, surfaceIds, opts = {}) {
    this.name = opts.name ?? 'collision';
    this.tris = tris;
    this.triangleCount = (tris.length / 9) | 0;
    this.surfaceIds = surfaceIds && surfaceIds.length >= this.triangleCount
      ? surfaceIds
      : new Uint8Array(this.triangleCount);

    this.planes = new Float32Array(this.triangleCount * 4);
    this.edgeConvex = new Uint8Array(this.triangleCount);
    this.neighbours = new Int32Array(this.triangleCount * 3).fill(-1);

    this.bvh = new BVH();
    this.bounds = new THREE.Box3();

    this._computePlanes();
    if (opts.buildAdjacency !== false) {
      this._computeAdjacency(opts.convexSin ?? DEFAULT_CONVEX_SIN);
    } else {
      this.edgeConvex.fill(0b111);
    }
    this.bvh.build(this.tris, this.triangleCount);
    this.bounds.min.set(this.bvh.min[0], this.bvh.min[1], this.bvh.min[2]);
    this.bounds.max.set(this.bvh.max[0], this.bvh.max[1], this.bvh.max[2]);
    if (this.triangleCount === 0) this.bounds.makeEmpty();
  }

  // ───────────────────────────────────────────────────────── construction

  /** Build from a single THREE.BufferGeometry. */
  static fromGeometry(geometry, surfaceId = 0, matrix = null, opts = {}) {
    const b = new CollisionMeshBuilder();
    b.addGeometry(geometry, surfaceId, matrix);
    return b.build(opts);
  }

  /**
   * Build from raw arrays.
   * @param {ArrayLike<number>} positions xyz triples
   * @param {ArrayLike<number>|null} indices
   */
  static fromArrays(positions, indices = null, surfaceId = 0, matrix = null, opts = {}) {
    const b = new CollisionMeshBuilder();
    b.addTriangles(positions, indices, surfaceId, matrix);
    return b.build(opts);
  }

  /** Merge several {geometry, surfaceId, matrix} entries into one mesh. */
  static merge(entries, opts = {}) {
    const b = new CollisionMeshBuilder();
    for (const e of entries) b.addGeometry(e.geometry, e.surfaceId ?? 0, e.matrix ?? null);
    return b.build(opts);
  }

  _computePlanes() {
    const t = this.tris, p = this.planes;
    for (let i = 0; i < this.triangleCount; i++) {
      const b = i * 9;
      const ax = t[b], ay = t[b + 1], az = t[b + 2];
      const e1x = t[b + 3] - ax, e1y = t[b + 4] - ay, e1z = t[b + 5] - az;
      const e2x = t[b + 6] - ax, e2y = t[b + 7] - ay, e2z = t[b + 8] - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-14) { nx = 0; ny = 1; nz = 0; }
      else { nx /= l; ny /= l; nz /= l; }
      const o = i * 4;
      p[o] = nx; p[o + 1] = ny; p[o + 2] = nz;
      p[o + 3] = nx * ax + ny * ay + nz * az;
    }
  }

  /**
   * Weld vertices, link shared edges and classify each edge as convex or
   * internal. O(T) with a hash map, build time only.
   */
  _computeAdjacency(convexSin) {
    const T = this.triangleCount;
    if (T === 0) return;
    const t = this.tris;

    // ── weld ───────────────────────────────────────────────────────────
    /** @type {Map<string, number>} */
    const vmap = new Map();
    const vid = new Int32Array(T * 3);
    const inv = 1 / WELD;
    for (let i = 0; i < T * 3; i++) {
      const b = i * 3;
      const key = `${Math.round(t[b] * inv)},${Math.round(t[b + 1] * inv)},${Math.round(t[b + 2] * inv)}`;
      let id = vmap.get(key);
      if (id === undefined) { id = vmap.size; vmap.set(key, id); }
      vid[i] = id;
    }
    const V = vmap.size;

    // ── link edges ─────────────────────────────────────────────────────
    /** @type {Map<number, number>} first (tri*3 + edge) seen for this edge */
    const emap = new Map();
    for (let i = 0; i < T; i++) {
      for (let e = 0; e < 3; e++) {
        const a = vid[i * 3 + e], b = vid[i * 3 + ((e + 1) % 3)];
        const lo = a < b ? a : b, hi = a < b ? b : a;
        const key = lo * V + hi;
        const prev = emap.get(key);
        if (prev === undefined) { emap.set(key, i * 3 + e); continue; }
        const pt = (prev / 3) | 0, pe = prev % 3;
        // Only link the first two triangles sharing an edge (non-manifold soup).
        if (this.neighbours[pt * 3 + pe] === -1 && this.neighbours[i * 3 + e] === -1) {
          this.neighbours[pt * 3 + pe] = i;
          this.neighbours[i * 3 + e] = pt;
        }
      }
    }

    // ── classify ───────────────────────────────────────────────────────
    const p = this.planes;
    for (let i = 0; i < T; i++) {
      let mask = 0;
      const nx = p[i * 4], ny = p[i * 4 + 1], nz = p[i * 4 + 2], nd = p[i * 4 + 3];
      for (let e = 0; e < 3; e++) {
        const nb = this.neighbours[i * 3 + e];
        if (nb < 0) { mask |= 1 << e; continue; }   // boundary edge — a real lip
        // Opposite vertex of the neighbour: the one not welded to our edge.
        const a = vid[i * 3 + e], b = vid[i * 3 + ((e + 1) % 3)];
        let opp = -1;
        for (let k = 0; k < 3; k++) {
          const w = vid[nb * 3 + k];
          if (w !== a && w !== b) { opp = nb * 9 + k * 3; break; }
        }
        if (opp < 0) continue;                       // degenerate — treat as internal
        const dist = nx * t[opp] + ny * t[opp + 1] + nz * t[opp + 2] - nd;
        // Distance from our plane, normalised by the neighbour's size.
        const ex = t[nb * 9 + 3] - t[nb * 9];
        const ey = t[nb * 9 + 4] - t[nb * 9 + 1];
        const ez = t[nb * 9 + 5] - t[nb * 9 + 2];
        const scale = Math.hypot(ex, ey, ez) || 1;
        if (dist / scale < -convexSin) mask |= 1 << e;  // neighbour bends away ⇒ convex
      }
      this.edgeConvex[i] = mask;
    }
  }

  // ───────────────────────────────────────────────────────── accessors

  /** @returns {number} canonical surface id */
  surfaceAt(triIndex) {
    return triIndex >= 0 && triIndex < this.triangleCount ? this.surfaceIds[triIndex] : 0;
  }

  /** Face normal of a triangle. */
  triNormal(triIndex, out) {
    const o = triIndex * 4;
    return out.set(this.planes[o], this.planes[o + 1], this.planes[o + 2]);
  }

  /** Vertices of a triangle. */
  getTriangle(triIndex, a, b, c) {
    const o = triIndex * 9, t = this.tris;
    a.set(t[o], t[o + 1], t[o + 2]);
    b.set(t[o + 3], t[o + 4], t[o + 5]);
    c.set(t[o + 6], t[o + 7], t[o + 8]);
  }

  // ───────────────────────────────────────────────────────── queries

  /**
   * Closest hit against the mesh. THE suspension hot path — allocation free.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir must be normalized
   * @param {number} maxDist
   * @param {RayHit} out
   * @returns {boolean}
   */
  raycast(origin, dir, maxDist, out) {
    return this.raycastRaw(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist, out);
  }

  /** Scalar-argument raycast — avoids building a Vector3 at the call site. */
  raycastRaw(ox, oy, oz, dx, dy, dz, maxDist, out, cullBackFaces = false) {
    out.hit = false;
    out.distance = Infinity;
    out.triIndex = -1;
    out.body = null;
    if (this.triangleCount === 0) return false;
    if (!this.bvh.raycast(ox, oy, oz, dx, dy, dz, maxDist, _bvhHit, cullBackFaces)) return false;

    const tri = _bvhHit.triIndex;
    const o = tri * 4;
    out.hit = true;
    out.distance = _bvhHit.t;
    out.triIndex = tri;
    out.surfaceId = this.surfaceIds[tri];
    out.point.set(ox + dx * _bvhHit.t, oy + dy * _bvhHit.t, oz + dz * _bvhHit.t);
    // Use the precomputed plane; flip so the normal always faces the ray origin.
    let nx = this.planes[o], ny = this.planes[o + 1], nz = this.planes[o + 2];
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    out.normal.set(nx, ny, nz);
    return true;
  }

  /** Boolean occlusion test. */
  raycastAny(origin, dir, maxDist) {
    if (this.triangleCount === 0) return false;
    return this.bvh.raycastAny(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist);
  }

  /**
   * Candidate triangles overlapping a sphere.
   * @param {THREE.Vector3} center @param {number} radius
   * @param {Uint32Array} outTriIndices reusable scratch
   * @returns {number} count
   */
  querySphere(center, radius, outTriIndices) {
    return this.bvh.querySphere(center.x, center.y, center.z, radius, outTriIndices);
  }

  /** Candidate triangles overlapping an AABB. */
  queryAABB(min, max, outTriIndices) {
    return this.bvh.queryAABB(min.x, min.y, min.z, max.x, max.y, max.z, outTriIndices);
  }

  /** Scalar-argument AABB query. */
  queryAABBRaw(minx, miny, minz, maxx, maxy, maxz, outTriIndices) {
    return this.bvh.queryAABB(minx, miny, minz, maxx, maxy, maxz, outTriIndices);
  }

  /**
   * Closest point on the mesh within `maxRadius`. Handy for respawn snapping
   * and AI "am I off the track" checks.
   * @param {THREE.Vector3} point
   * @param {number} maxRadius
   * @param {RayHit} out
   * @param {Uint32Array} scratch
   */
  closestPoint(point, maxRadius, out, scratch) {
    out.hit = false;
    out.distance = Infinity;
    out.triIndex = -1;
    const n = this.bvh.querySphere(point.x, point.y, point.z, maxRadius, scratch);
    let best = maxRadius * maxRadius;
    for (let i = 0; i < n; i++) {
      const tri = scratch[i];
      closestPointOnTriangleRaw(this.tris, tri * 9, point.x, point.y, point.z);
      const dx = CP.x - point.x, dy = CP.y - point.y, dz = CP.z - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        out.hit = true;
        out.triIndex = tri;
        out.point.set(CP.x, CP.y, CP.z);
        out.distance = Math.sqrt(d2);
        out.surfaceId = this.surfaceIds[tri];
        this.triNormal(tri, out.normal);
      }
    }
    return out.hit;
  }

  stats() {
    return { name: this.name, triangles: this.triangleCount, ...this.bvh.stats() };
  }

  dispose() {
    this.tris = new Float32Array(0);
    this.triangleCount = 0;
    this.bvh = new BVH();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Builder
// ═══════════════════════════════════════════════════════════════════════════

export class CollisionMeshBuilder {
  constructor() {
    /** @type {number[]} */
    this._verts = [];
    /** @type {number[]} */
    this._surf = [];
    this.triangleCount = 0;
  }

  get isEmpty() { return this.triangleCount === 0; }

  /**
   * Append a BufferGeometry (indexed or not).
   * @param {THREE.BufferGeometry} geometry
   * @param {number} surfaceId
   * @param {THREE.Matrix4|null} matrix world transform
   */
  addGeometry(geometry, surfaceId = 0, matrix = null) {
    const pos = geometry?.getAttribute?.('position');
    if (!pos) return this;
    const index = geometry.getIndex?.();
    return this.addTriangles(pos, index ? index.array : null, surfaceId, matrix, pos.count);
  }

  /**
   * Append raw triangles.
   * @param {ArrayLike<number>|THREE.BufferAttribute} positions
   * @param {ArrayLike<number>|null} indices
   */
  addTriangles(positions, indices = null, surfaceId = 0, matrix = null, vertexCount = -1) {
    const isAttr = typeof positions?.getX === 'function';
    const count = vertexCount >= 0
      ? vertexCount
      : (isAttr ? positions.count : (positions.length / 3) | 0);
    const getX = isAttr ? (i) => positions.getX(i) : (i) => positions[i * 3];
    const getY = isAttr ? (i) => positions.getY(i) : (i) => positions[i * 3 + 1];
    const getZ = isAttr ? (i) => positions.getZ(i) : (i) => positions[i * 3 + 2];

    const triCount = indices ? (indices.length / 3) | 0 : (count / 3) | 0;
    const V = this._verts;
    const sid = surfaceId & 0xff;

    for (let t = 0; t < triCount; t++) {
      let degenerate = false;
      const base = V.length;
      for (let k = 0; k < 3; k++) {
        const vi = indices ? indices[t * 3 + k] : t * 3 + k;
        _v0.set(getX(vi), getY(vi), getZ(vi));
        if (matrix) _v0.applyMatrix4(matrix);
        V.push(_v0.x, _v0.y, _v0.z);
      }
      // Drop zero-area triangles: they poison plane normals and adjacency.
      const ax = V[base], ay = V[base + 1], az = V[base + 2];
      const e1x = V[base + 3] - ax, e1y = V[base + 4] - ay, e1z = V[base + 5] - az;
      const e2x = V[base + 6] - ax, e2y = V[base + 7] - ay, e2z = V[base + 8] - az;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      if (cx * cx + cy * cy + cz * cz < 1e-18) degenerate = true;
      if (degenerate) { V.length = base; continue; }
      this._surf.push(sid);
      this.triangleCount++;
    }
    return this;
  }

  /**
   * Traverse an Object3D and append every visible mesh.
   * Surface id comes from `mesh.userData.surfaceId`, falling back to
   * `defaultSurfaceId`. Meshes flagged `userData.noCollision` are skipped.
   * @param {THREE.Object3D} root
   * @param {number} [defaultSurfaceId]
   * @param {(mesh:THREE.Mesh)=>number|null} [resolver] optional override
   */
  addObject3D(root, defaultSurfaceId = 0, resolver = null) {
    if (!root) return this;
    root.updateWorldMatrix?.(true, true);
    root.traverse?.((obj) => {
      if (!obj.isMesh || obj.userData?.noCollision) return;
      const sid = resolver ? resolver(obj) : (obj.userData?.surfaceId ?? defaultSurfaceId);
      if (sid === null || sid === undefined) return;
      this.addGeometry(obj.geometry, sid, obj.matrixWorld);
    });
    return this;
  }

  /** Append an axis-aligned box (12 triangles) — cheap static blockers. */
  addBox(center, halfExtents, surfaceId = 0, quaternion = null) {
    const geo = new THREE.BoxGeometry(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2);
    const m = new THREE.Matrix4().compose(
      center,
      quaternion ?? new THREE.Quaternion(),
      new THREE.Vector3(1, 1, 1),
    );
    this.addGeometry(geo, surfaceId, m);
    geo.dispose();
    return this;
  }

  /** @returns {CollisionMesh} */
  build(opts = {}) {
    const tris = new Float32Array(this._verts);
    const surf = new Uint8Array(this._surf);
    return new CollisionMesh(tris, surf, opts);
  }

  clear() {
    this._verts.length = 0;
    this._surf.length = 0;
    this.triangleCount = 0;
    return this;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared triangle helpers (used by Collision.js too)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Output of the last `closestPointOnTriangleRaw` call. Module-level and
 * reused — read it immediately, never store it.
 * `region`: 0 = face, 1..3 = edge (a→b, b→c, c→a), 4..6 = vertex a/b/c.
 */
export const CP = { x: 0, y: 0, z: 0, region: 0 };

/**
 * Closest point on triangle `tris[base..base+8]` to (px,py,pz) → `CP`.
 * Ericson, Real-Time Collision Detection §5.1.5.
 */
export function closestPointOnTriangleRaw(tris, base, px, py, pz) {
  const ax = tris[base], ay = tris[base + 1], az = tris[base + 2];
  const bx = tris[base + 3], by = tris[base + 4], bz = tris[base + 5];
  const cx = tris[base + 6], cy = tris[base + 7], cz = tris[base + 8];

  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { CP.x = ax; CP.y = ay; CP.z = az; CP.region = 4; return; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { CP.x = bx; CP.y = by; CP.z = bz; CP.region = 5; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    CP.x = ax + abx * v; CP.y = ay + aby * v; CP.z = az + abz * v; CP.region = 1; return;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { CP.x = cx; CP.y = cy; CP.z = cz; CP.region = 6; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    CP.x = ax + acx * w; CP.y = ay + acy * w; CP.z = az + acz * w; CP.region = 3; return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    CP.x = bx + (cx - bx) * w; CP.y = by + (cy - by) * w; CP.z = bz + (cz - bz) * w;
    CP.region = 2; return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  CP.x = ax + abx * v + acx * w;
  CP.y = ay + aby * v + acy * w;
  CP.z = az + abz * v + acz * w;
  CP.region = 0;
}

/**
 * Should the contact normal for this voronoi region be snapped to the face
 * normal? True for coplanar / concave seams and welded vertices.
 * @param {number} region from `_cpRegion`
 * @param {number} convexMask `edgeConvex[tri]`
 */
export function regionIsInternal(region, convexMask) {
  if (region === 0) return false;                       // face — always genuine
  if (region <= 3) return (convexMask & (1 << (region - 1))) === 0;
  // Vertex region: genuine only if BOTH incident edges are convex features.
  const v = region - 4;                                 // 0=a, 1=b, 2=c
  const e0 = v;                                         // edge leaving the vertex
  const e1 = (v + 2) % 3;                               // edge arriving at it
  return !((convexMask & (1 << e0)) && (convexMask & (1 << e1)));
}

export default CollisionMesh;
