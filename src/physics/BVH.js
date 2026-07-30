/**
 * RC RUMBLE — static triangle BVH.
 *
 * A bounding-volume hierarchy over a de-indexed triangle soup, built with a
 * binned SAH (surface-area heuristic) sweep over all three axes and stored
 * entirely in flat typed arrays:
 *
 *   nodeBounds : Float32Array  6 per node   [minx,miny,minz, maxx,maxy,maxz]
 *   nodeMeta   : Int32Array    2 per node   [leftFirst, triCount]
 *                              triCount === 0 ⇒ interior, leftFirst = left child
 *                              (right child is always left + 1)
 *   triIndices : Uint32Array   permutation of triangle ids
 *
 * Traversal is iterative over a preallocated stack, so every query runs with
 * zero allocations. This is the hot path for suspension raycasts (4 rays ×
 * 8 cars × 120 Hz) so it is written for cache behaviour, not elegance.
 */

const LEAF_SIZE = 4;
const SAH_BINS = 12;
const TRAVERSAL_COST = 1.0;
const INTERSECT_COST = 1.4;
const MAX_STACK = 96;

/** Shared traversal stacks — BVH queries are never re-entrant. */
const _stack = new Int32Array(MAX_STACK);
const _dstack = new Float32Array(MAX_STACK);

/** Build-time SAH binning scratch (reused across every node + axis). */
const _binCount = new Int32Array(SAH_BINS);
const _binMin = new Float32Array(SAH_BINS * 3);
const _binMax = new Float32Array(SAH_BINS * 3);
const _leftArea = new Float32Array(SAH_BINS - 1);
const _rightArea = new Float32Array(SAH_BINS - 1);
const _leftCount = new Int32Array(SAH_BINS - 1);
const _rightCount = new Int32Array(SAH_BINS - 1);

/** @typedef {{hit:boolean, t:number, u:number, v:number, triIndex:number,
 *             nx:number, ny:number, nz:number}} BVHRayResult */

/** Allocate a reusable raycast result record. */
export function createBVHRayResult() {
  return { hit: false, t: Infinity, u: 0, v: 0, triIndex: -1, nx: 0, ny: 0, nz: 0 };
}

export class BVH {
  constructor() {
    /** @type {Float32Array|null} 9 floats per triangle (3 verts, de-indexed) */
    this.tris = null;
    this.triCount = 0;

    this.nodeBounds = new Float32Array(0);
    this.nodeMeta = new Int32Array(0);
    this.nodeDepth = new Uint8Array(0);
    this.triIndices = new Uint32Array(0);
    this.nodeCount = 0;
    this.maxDepth = 0;

    this.min = new Float32Array([0, 0, 0]);
    this.max = new Float32Array([0, 0, 0]);
    this.built = false;
  }

  /**
   * @param {Float32Array} tris 9 floats per triangle (ax,ay,az, bx,by,bz, cx,cy,cz)
   * @param {number} [triCount]
   * @param {{leafSize?:number}} [opts]
   */
  build(tris, triCount = (tris.length / 9) | 0, opts = {}) {
    this.tris = tris;
    this.triCount = triCount;
    this.built = false;
    const leafSize = opts.leafSize ?? LEAF_SIZE;

    if (triCount === 0) {
      this.nodeBounds = new Float32Array(6);
      this.nodeMeta = new Int32Array(2);
      this.nodeDepth = new Uint8Array(1);
      this.triIndices = new Uint32Array(0);
      this.nodeCount = 1;
      this.nodeBounds.set([0, 0, 0, 0, 0, 0]);
      this.nodeMeta[0] = 0; this.nodeMeta[1] = 0;
      this.built = true;
      return this;
    }

    const maxNodes = Math.max(2 * triCount, 4);
    this.nodeBounds = new Float32Array(maxNodes * 6);
    this.nodeMeta = new Int32Array(maxNodes * 2);
    this.nodeDepth = new Uint8Array(maxNodes);
    this.triIndices = new Uint32Array(triCount);

    // ── per-triangle centroid + AABB (build-time scratch, released after) ──
    const cent = new Float32Array(triCount * 3);
    const tmin = new Float32Array(triCount * 3);
    const tmax = new Float32Array(triCount * 3);
    for (let i = 0; i < triCount; i++) {
      const b = i * 9;
      const ax = tris[b], ay = tris[b + 1], az = tris[b + 2];
      const bx = tris[b + 3], by = tris[b + 4], bz = tris[b + 5];
      const cx = tris[b + 6], cy = tris[b + 7], cz = tris[b + 8];
      const o = i * 3;
      cent[o] = (ax + bx + cx) / 3;
      cent[o + 1] = (ay + by + cy) / 3;
      cent[o + 2] = (az + bz + cz) / 3;
      tmin[o] = Math.min(ax, bx, cx); tmax[o] = Math.max(ax, bx, cx);
      tmin[o + 1] = Math.min(ay, by, cy); tmax[o + 1] = Math.max(ay, by, cy);
      tmin[o + 2] = Math.min(az, bz, cz); tmax[o + 2] = Math.max(az, bz, cz);
      this.triIndices[i] = i;
    }

    this.nodeCount = 1;
    this.nodeMeta[0] = 0;
    this.nodeMeta[1] = triCount;
    this._updateNodeBounds(0, tmin, tmax);
    this._subdivide(0, 0, cent, tmin, tmax, leafSize);

    this.min[0] = this.nodeBounds[0]; this.min[1] = this.nodeBounds[1]; this.min[2] = this.nodeBounds[2];
    this.max[0] = this.nodeBounds[3]; this.max[1] = this.nodeBounds[4]; this.max[2] = this.nodeBounds[5];

    // Shrink to the actual node count so traversal stays cache friendly.
    this.nodeBounds = this.nodeBounds.slice(0, this.nodeCount * 6);
    this.nodeMeta = this.nodeMeta.slice(0, this.nodeCount * 2);
    this.nodeDepth = this.nodeDepth.slice(0, this.nodeCount);
    this.built = true;
    return this;
  }

  // ───────────────────────────────────────────────────────── build internals

  _updateNodeBounds(node, tmin, tmax) {
    const meta = this.nodeMeta, b = this.nodeBounds, idx = this.triIndices;
    const first = meta[node * 2], count = meta[node * 2 + 1];
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < count; i++) {
      const t = idx[first + i] * 3;
      if (tmin[t] < x0) x0 = tmin[t];
      if (tmin[t + 1] < y0) y0 = tmin[t + 1];
      if (tmin[t + 2] < z0) z0 = tmin[t + 2];
      if (tmax[t] > x1) x1 = tmax[t];
      if (tmax[t + 1] > y1) y1 = tmax[t + 1];
      if (tmax[t + 2] > z1) z1 = tmax[t + 2];
    }
    const o = node * 6;
    b[o] = x0; b[o + 1] = y0; b[o + 2] = z0;
    b[o + 3] = x1; b[o + 4] = y1; b[o + 5] = z1;
  }

  _subdivide(node, depth, cent, tmin, tmax, leafSize) {
    if (depth > this.maxDepth) this.maxDepth = depth;
    this.nodeDepth[node] = Math.min(255, depth);
    const meta = this.nodeMeta;
    const first = meta[node * 2], count = meta[node * 2 + 1];
    if (count <= leafSize || depth >= 64) return;

    const b = this.nodeBounds, o = node * 6;
    const ex = b[o + 3] - b[o], ey = b[o + 4] - b[o + 1], ez = b[o + 5] - b[o + 2];
    const parentArea = 2 * (ex * ey + ey * ez + ez * ex);
    const leafCost = count * INTERSECT_COST;

    let bestAxis = -1, bestPos = 0, bestCost = Infinity;

    for (let axis = 0; axis < 3; axis++) {
      // Centroid range on this axis.
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < count; i++) {
        const c = cent[this.triIndices[first + i] * 3 + axis];
        if (c < lo) lo = c;
        if (c > hi) hi = c;
      }
      if (hi - lo < 1e-9) continue;

      // Bin (module scratch — no allocation during the build).
      const binCount = _binCount, binMin = _binMin, binMax = _binMax;
      binCount.fill(0); binMin.fill(Infinity); binMax.fill(-Infinity);
      const scale = SAH_BINS / (hi - lo);
      for (let i = 0; i < count; i++) {
        const tri = this.triIndices[first + i];
        let bi = ((cent[tri * 3 + axis] - lo) * scale) | 0;
        if (bi >= SAH_BINS) bi = SAH_BINS - 1;
        if (bi < 0) bi = 0;
        binCount[bi]++;
        const t = tri * 3, m = bi * 3;
        if (tmin[t] < binMin[m]) binMin[m] = tmin[t];
        if (tmin[t + 1] < binMin[m + 1]) binMin[m + 1] = tmin[t + 1];
        if (tmin[t + 2] < binMin[m + 2]) binMin[m + 2] = tmin[t + 2];
        if (tmax[t] > binMax[m]) binMax[m] = tmax[t];
        if (tmax[t + 1] > binMax[m + 1]) binMax[m + 1] = tmax[t + 1];
        if (tmax[t + 2] > binMax[m + 2]) binMax[m + 2] = tmax[t + 2];
      }

      // Sweep left→right and right→left accumulating areas.
      const leftArea = _leftArea, rightArea = _rightArea;
      const leftCount = _leftCount, rightCount = _rightCount;

      let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity;
      let lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, lsum = 0;
      for (let i = 0; i < SAH_BINS - 1; i++) {
        lsum += binCount[i];
        leftCount[i] = lsum;
        const m = i * 3;
        if (binCount[i] > 0) {
          if (binMin[m] < lx0) lx0 = binMin[m];
          if (binMin[m + 1] < ly0) ly0 = binMin[m + 1];
          if (binMin[m + 2] < lz0) lz0 = binMin[m + 2];
          if (binMax[m] > lx1) lx1 = binMax[m];
          if (binMax[m + 1] > ly1) ly1 = binMax[m + 1];
          if (binMax[m + 2] > lz1) lz1 = binMax[m + 2];
        }
        leftArea[i] = lsum > 0 ? surfaceArea(lx1 - lx0, ly1 - ly0, lz1 - lz0) : 0;
      }
      let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity;
      let rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rsum = 0;
      for (let i = SAH_BINS - 1; i >= 1; i--) {
        rsum += binCount[i];
        rightCount[i - 1] = rsum;
        const m = i * 3;
        if (binCount[i] > 0) {
          if (binMin[m] < rx0) rx0 = binMin[m];
          if (binMin[m + 1] < ry0) ry0 = binMin[m + 1];
          if (binMin[m + 2] < rz0) rz0 = binMin[m + 2];
          if (binMax[m] > rx1) rx1 = binMax[m];
          if (binMax[m + 1] > ry1) ry1 = binMax[m + 1];
          if (binMax[m + 2] > rz1) rz1 = binMax[m + 2];
        }
        rightArea[i - 1] = rsum > 0 ? surfaceArea(rx1 - rx0, ry1 - ry0, rz1 - rz0) : 0;
      }

      const invParent = parentArea > 1e-12 ? 1 / parentArea : 0;
      for (let i = 0; i < SAH_BINS - 1; i++) {
        if (leftCount[i] === 0 || rightCount[i] === 0) continue;
        const cost = TRAVERSAL_COST + INTERSECT_COST * invParent *
          (leftArea[i] * leftCount[i] + rightArea[i] * rightCount[i]);
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestPos = lo + (hi - lo) * ((i + 1) / SAH_BINS);
        }
      }
    }

    // Fall back to a median split on the widest axis if SAH found nothing.
    if (bestAxis < 0) {
      bestAxis = ex > ey ? (ex > ez ? 0 : 2) : (ey > ez ? 1 : 2);
      let sum = 0;
      for (let i = 0; i < count; i++) sum += cent[this.triIndices[first + i] * 3 + bestAxis];
      bestPos = sum / count;
      bestCost = leafCost - 1; // force the split
    }
    if (bestCost >= leafCost && count <= leafSize * 4) return;

    // ── partition in place ────────────────────────────────────────────
    let i = first, j = first + count - 1;
    while (i <= j) {
      if (cent[this.triIndices[i] * 3 + bestAxis] < bestPos) i++;
      else { const t = this.triIndices[i]; this.triIndices[i] = this.triIndices[j]; this.triIndices[j] = t; j--; }
    }
    const leftCountFinal = i - first;
    if (leftCountFinal === 0 || leftCountFinal === count) {
      // Degenerate (all centroids identical) — split down the middle.
      const half = count >> 1;
      if (half === 0) return;
      const left = this.nodeCount++;
      const right = this.nodeCount++;
      meta[left * 2] = first; meta[left * 2 + 1] = half;
      meta[right * 2] = first + half; meta[right * 2 + 1] = count - half;
      meta[node * 2] = left; meta[node * 2 + 1] = 0;
      this._updateNodeBounds(left, tmin, tmax);
      this._updateNodeBounds(right, tmin, tmax);
      this._subdivide(left, depth + 1, cent, tmin, tmax, leafSize);
      this._subdivide(right, depth + 1, cent, tmin, tmax, leafSize);
      return;
    }

    const left = this.nodeCount++;
    const right = this.nodeCount++;
    meta[left * 2] = first; meta[left * 2 + 1] = leftCountFinal;
    meta[right * 2] = i; meta[right * 2 + 1] = count - leftCountFinal;
    meta[node * 2] = left; meta[node * 2 + 1] = 0;
    this._updateNodeBounds(left, tmin, tmax);
    this._updateNodeBounds(right, tmin, tmax);
    this._subdivide(left, depth + 1, cent, tmin, tmax, leafSize);
    this._subdivide(right, depth + 1, cent, tmin, tmax, leafSize);
  }

  // ───────────────────────────────────────────────────────── raycast

  /**
   * Closest hit. Allocation free.
   * @param {number} ox @param {number} oy @param {number} oz
   * @param {number} dx normalized direction
   * @param {number} dy @param {number} dz
   * @param {number} maxDist
   * @param {BVHRayResult} out
   * @param {boolean} [cullBackFaces]
   * @returns {boolean}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, out, cullBackFaces = false) {
    out.hit = false; out.t = maxDist; out.triIndex = -1;
    if (!this.built || this.triCount === 0) return false;

    // 0 means "parallel to this axis" — see slabT.
    const invx = dx !== 0 ? 1 / dx : 0;
    const invy = dy !== 0 ? 1 / dy : 0;
    const invz = dz !== 0 ? 1 / dz : 0;

    const bounds = this.nodeBounds, meta = this.nodeMeta;
    const idx = this.triIndices, tris = this.tris;

    let sp = 0;
    let node = 0;
    let best = maxDist;

    // Reject immediately if the root is missed.
    if (slabT(bounds, 0, ox, oy, oz, invx, invy, invz, best) === Infinity) return false;

    for (;;) {
      const count = meta[node * 2 + 1];
      if (count > 0) {
        const first = meta[node * 2];
        for (let i = 0; i < count; i++) {
          const tri = idx[first + i];
          const b = tri * 9;
          const t = rayTriangle(
            ox, oy, oz, dx, dy, dz,
            tris[b], tris[b + 1], tris[b + 2],
            tris[b + 3], tris[b + 4], tris[b + 5],
            tris[b + 6], tris[b + 7], tris[b + 8],
            best, cullBackFaces,
          );
          if (t >= 0 && t < best) {
            best = t;
            out.hit = true;
            out.t = t;
            out.triIndex = tri;
            out.u = _rtU; out.v = _rtV;
          }
        }
      } else {
        const left = meta[node * 2];
        const right = left + 1;
        let tl = slabT(bounds, left, ox, oy, oz, invx, invy, invz, best);
        let tr = slabT(bounds, right, ox, oy, oz, invx, invy, invz, best);
        let nl = left, nr = right;
        if (tl > tr) { const t = tl; tl = tr; tr = t; const n = nl; nl = nr; nr = n; }
        if (tl !== Infinity) {
          if (tr !== Infinity && sp < MAX_STACK) { _stack[sp] = nr; _dstack[sp] = tr; sp++; }
          node = nl;
          continue;
        }
      }
      // pop
      let popped = -1;
      while (sp > 0) {
        sp--;
        if (_dstack[sp] < best) { popped = _stack[sp]; break; }
      }
      if (popped < 0) break;
      node = popped;
    }

    if (out.hit) {
      const b = out.triIndex * 9;
      const ax = tris[b], ay = tris[b + 1], az = tris[b + 2];
      const e1x = tris[b + 3] - ax, e1y = tris[b + 4] - ay, e1z = tris[b + 5] - az;
      const e2x = tris[b + 6] - ax, e2y = tris[b + 7] - ay, e2z = tris[b + 8] - az;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const l = Math.hypot(nx, ny, nz) || 1;
      out.nx = nx / l; out.ny = ny / l; out.nz = nz / l;
    }
    return out.hit;
  }

  /** Any-hit (shadow style) test — returns as soon as something is in the way. */
  raycastAny(ox, oy, oz, dx, dy, dz, maxDist, cullBackFaces = false) {
    if (!this.built || this.triCount === 0) return false;
    const invx = dx !== 0 ? 1 / dx : 0;
    const invy = dy !== 0 ? 1 / dy : 0;
    const invz = dz !== 0 ? 1 / dz : 0;
    const bounds = this.nodeBounds, meta = this.nodeMeta;
    const idx = this.triIndices, tris = this.tris;

    let sp = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
      const node = _stack[--sp];
      if (slabT(bounds, node, ox, oy, oz, invx, invy, invz, maxDist) === Infinity) continue;
      const count = meta[node * 2 + 1];
      if (count > 0) {
        const first = meta[node * 2];
        for (let i = 0; i < count; i++) {
          const b = idx[first + i] * 9;
          const t = rayTriangle(
            ox, oy, oz, dx, dy, dz,
            tris[b], tris[b + 1], tris[b + 2],
            tris[b + 3], tris[b + 4], tris[b + 5],
            tris[b + 6], tris[b + 7], tris[b + 8],
            maxDist, cullBackFaces,
          );
          if (t >= 0 && t < maxDist) return true;
        }
      } else if (sp + 2 <= MAX_STACK) {
        const left = meta[node * 2];
        _stack[sp++] = left;
        _stack[sp++] = left + 1;
      }
    }
    return false;
  }

  // ───────────────────────────────────────────────────────── overlap queries

  /**
   * Triangles whose AABB overlaps the query box.
   * @param {Uint32Array} out reusable scratch buffer
   * @returns {number} candidate count (never exceeds out.length)
   */
  queryAABB(minx, miny, minz, maxx, maxy, maxz, out) {
    if (!this.built || this.triCount === 0) return 0;
    const bounds = this.nodeBounds, meta = this.nodeMeta;
    const idx = this.triIndices, tris = this.tris;
    const cap = out.length;
    let n = 0, sp = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
      const node = _stack[--sp];
      const o = node * 6;
      if (bounds[o] > maxx || bounds[o + 3] < minx ||
          bounds[o + 1] > maxy || bounds[o + 4] < miny ||
          bounds[o + 2] > maxz || bounds[o + 5] < minz) continue;
      const count = meta[node * 2 + 1];
      if (count > 0) {
        const first = meta[node * 2];
        for (let i = 0; i < count && n < cap; i++) {
          const tri = idx[first + i];
          const b = tri * 9;
          const ax = tris[b], bx = tris[b + 3], cx = tris[b + 6];
          if (Math.min(ax, bx, cx) > maxx || Math.max(ax, bx, cx) < minx) continue;
          const ay = tris[b + 1], by = tris[b + 4], cy = tris[b + 7];
          if (Math.min(ay, by, cy) > maxy || Math.max(ay, by, cy) < miny) continue;
          const az = tris[b + 2], bz = tris[b + 5], cz = tris[b + 8];
          if (Math.min(az, bz, cz) > maxz || Math.max(az, bz, cz) < minz) continue;
          out[n++] = tri;
        }
        if (n >= cap) break;
      } else if (sp + 2 <= MAX_STACK) {
        const left = meta[node * 2];
        _stack[sp++] = left;
        _stack[sp++] = left + 1;
      }
    }
    return n;
  }

  /**
   * Triangles potentially overlapping a sphere. Uses an exact sphere-vs-AABB
   * distance test at nodes and a cheap AABB test at leaves.
   */
  querySphere(cx, cy, cz, radius, out) {
    if (!this.built || this.triCount === 0) return 0;
    const r2 = radius * radius;
    const bounds = this.nodeBounds, meta = this.nodeMeta;
    const idx = this.triIndices, tris = this.tris;
    const cap = out.length;
    let n = 0, sp = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
      const node = _stack[--sp];
      const o = node * 6;
      let dx = cx < bounds[o] ? bounds[o] - cx : (cx > bounds[o + 3] ? cx - bounds[o + 3] : 0);
      let dy = cy < bounds[o + 1] ? bounds[o + 1] - cy : (cy > bounds[o + 4] ? cy - bounds[o + 4] : 0);
      let dz = cz < bounds[o + 2] ? bounds[o + 2] - cz : (cz > bounds[o + 5] ? cz - bounds[o + 5] : 0);
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const count = meta[node * 2 + 1];
      if (count > 0) {
        const first = meta[node * 2];
        for (let i = 0; i < count && n < cap; i++) {
          const tri = idx[first + i];
          const b = tri * 9;
          const lox = Math.min(tris[b], tris[b + 3], tris[b + 6]);
          const hix = Math.max(tris[b], tris[b + 3], tris[b + 6]);
          const loy = Math.min(tris[b + 1], tris[b + 4], tris[b + 7]);
          const hiy = Math.max(tris[b + 1], tris[b + 4], tris[b + 7]);
          const loz = Math.min(tris[b + 2], tris[b + 5], tris[b + 8]);
          const hiz = Math.max(tris[b + 2], tris[b + 5], tris[b + 8]);
          dx = cx < lox ? lox - cx : (cx > hix ? cx - hix : 0);
          dy = cy < loy ? loy - cy : (cy > hiy ? cy - hiy : 0);
          dz = cz < loz ? loz - cz : (cz > hiz ? cz - hiz : 0);
          if (dx * dx + dy * dy + dz * dz <= r2) out[n++] = tri;
        }
        if (n >= cap) break;
      } else if (sp + 2 <= MAX_STACK) {
        const left = meta[node * 2];
        _stack[sp++] = left;
        _stack[sp++] = left + 1;
      }
    }
    return n;
  }

  /** Debug helper — read a node's bounds into a 6-element array. */
  getNodeBounds(node, out) {
    const o = node * 6;
    out[0] = this.nodeBounds[o]; out[1] = this.nodeBounds[o + 1]; out[2] = this.nodeBounds[o + 2];
    out[3] = this.nodeBounds[o + 3]; out[4] = this.nodeBounds[o + 4]; out[5] = this.nodeBounds[o + 5];
    return out;
  }

  isLeaf(node) { return this.nodeMeta[node * 2 + 1] > 0; }

  stats() {
    let leaves = 0, maxLeaf = 0, triSum = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      const c = this.nodeMeta[i * 2 + 1];
      if (c > 0) { leaves++; triSum += c; if (c > maxLeaf) maxLeaf = c; }
    }
    return {
      nodes: this.nodeCount, leaves, triangles: this.triCount,
      avgLeaf: leaves ? triSum / leaves : 0, maxLeaf, depth: this.maxDepth,
      bytes: this.nodeBounds.byteLength + this.nodeMeta.byteLength + this.triIndices.byteLength,
    };
  }
}

// ═════════════════════════════════════════════════════════ free functions

function surfaceArea(ex, ey, ez) {
  if (ex < 0 || ey < 0 || ez < 0) return 0;
  return 2 * (ex * ey + ey * ez + ez * ex);
}

/**
 * Ray/AABB slab test. Returns the entry distance, or Infinity when missed.
 *
 * `invx/invy/invz` use **0 as the sentinel for a zero direction component**,
 * never ±Infinity. The naive `1/0 = Infinity` form computes `(bound - origin) *
 * Infinity`, which is `0 * Infinity = NaN` whenever a node bound lands exactly
 * on the ray's axis — and then every `Math.min/max` poisons and the node is
 * silently rejected. That case is not exotic: suspension rays point straight
 * down, and track geometry is grid aligned, so a wheel ray sitting exactly on a
 * quad boundary would simply not find the floor. The parallel axis is therefore
 * handled as a pure containment test instead.
 */
function slabT(b, node, ox, oy, oz, invx, invy, invz, maxT) {
  const o = node * 6;
  let tmin = 0, tmax = maxT;

  if (invx === 0) {
    if (ox < b[o] || ox > b[o + 3]) return Infinity;
  } else {
    let t1 = (b[o] - ox) * invx, t2 = (b[o + 3] - ox) * invx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }

  if (invy === 0) {
    if (oy < b[o + 1] || oy > b[o + 4]) return Infinity;
  } else {
    let t1 = (b[o + 1] - oy) * invy, t2 = (b[o + 4] - oy) * invy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }

  if (invz === 0) {
    if (oz < b[o + 2] || oz > b[o + 5]) return Infinity;
  } else {
    let t1 = (b[o + 2] - oz) * invz, t2 = (b[o + 5] - oz) * invz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  }

  return tmin;
}

let _rtU = 0, _rtV = 0;

/** Möller–Trumbore. Returns t or -1. Fills the module-level _rtU/_rtV. */
export function rayTriangle(
  ox, oy, oz, dx, dy, dz,
  ax, ay, az, bx, by, bz, cx, cy, cz,
  maxT, cullBackFaces,
) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;

  if (cullBackFaces) { if (det < 1e-12) return -1; }
  else if (det > -1e-12 && det < 1e-12) return -1;

  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return -1;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return -1;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 0 || t > maxT) return -1;
  _rtU = u; _rtV = v;
  return t;
}

export default BVH;
