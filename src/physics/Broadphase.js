/**
 * RC RUMBLE — broad phase.
 *
 * Uniform spatial hash over the dynamic bodies (cars, props, projectiles).
 * Everything lives in typed arrays that are grown on demand and then reused
 * forever, so a steady-state frame allocates nothing.
 *
 * The grid is rebuilt every step (bodies move a lot in a racing game, and with
 * ~100 bodies a rebuild is cheaper than incremental updates). Buckets are
 * cleared lazily with a frame stamp instead of a memset.
 *
 * Hash collisions between distinct cells are resolved by storing the integer
 * cell coordinate on every entry and comparing before emitting a pair, so the
 * narrow phase never sees a bogus candidate from a colliding bucket.
 */

/** A body overlapping more cells than this is checked against everything. */
const MAX_CELLS_PER_BODY = 27;

export class Broadphase {
  /**
   * @param {number} cellSize metres — should be ≈ the size of a typical body
   * @param {number} tableBits log2 of the bucket count
   */
  constructor(cellSize = 0.55, tableBits = 13) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;

    const tableSize = 1 << tableBits;
    this.tableMask = tableSize - 1;
    this.cellHead = new Int32Array(tableSize).fill(-1);
    this.cellStamp = new Int32Array(tableSize);
    this.usedSlots = new Int32Array(tableSize);
    this.usedCount = 0;

    this._entryCap = 4096;
    this.entryNext = new Int32Array(this._entryCap);
    this.entryBody = new Int32Array(this._entryCap);
    this.entryCX = new Int32Array(this._entryCap);
    this.entryCY = new Int32Array(this._entryCap);
    this.entryCZ = new Int32Array(this._entryCap);
    this.entryCount = 0;

    this._bigCap = 64;
    this.bigList = new Int32Array(this._bigCap);
    this.bigCount = 0;

    this._pairCap = 4096;
    /** Flat [aIndex, bIndex, …] into the caller's body array. */
    this.pairs = new Int32Array(this._pairCap * 2);
    this.pairCount = 0;

    const pairBits = 14;
    this._pairMask = (1 << pairBits) - 1;
    this.pairKeys = new Int32Array(1 << pairBits);
    this.pairStamp = new Int32Array(1 << pairBits);

    this.frame = 0;
    /** Per-body dedup scratch for queryAABB. */
    this._seen = null;
    this._qstamp = 0;
    /** Bodies considered this step (indices into the caller's array). */
    this._activeCap = 1024;
    this.active = new Int32Array(this._activeCap);
    this.activeCount = 0;
  }

  setCellSize(size) {
    this.cellSize = Math.max(0.02, size);
    this.invCell = 1 / this.cellSize;
  }

  // ───────────────────────────────────────────────────────── build

  /**
   * Rebuild the grid and the candidate pair list.
   * @param {import('./RigidBody.js').RigidBody[]} bodies
   * @param {(a:import('./RigidBody.js').RigidBody,
   *          b:import('./RigidBody.js').RigidBody)=>boolean} [filter]
   */
  update(bodies, filter = defaultFilter) {
    this.frame++;
    this.usedCount = 0;
    this.entryCount = 0;
    this.bigCount = 0;
    this.pairCount = 0;
    this.activeCount = 0;

    const n = bodies.length;
    if (n === 0) return 0;
    if (n > this._activeCap) {
      this._activeCap = nextPow2(n);
      this.active = new Int32Array(this._activeCap);
    }

    // ── insert ────────────────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (!b.enabled || !b.collisionEnabled) continue;
      // Static RigidBodies ARE inserted: most static geometry lives in the
      // track CollisionMesh, but gameplay sometimes wants a static/kinematic
      // body (a closed gate, a moving platform) and those must still collide.
      // `defaultFilter` throws away static-vs-static pairs.
      this.active[this.activeCount++] = i;

      const x0 = Math.floor(b.aabbMin.x * this.invCell);
      const y0 = Math.floor(b.aabbMin.y * this.invCell);
      const z0 = Math.floor(b.aabbMin.z * this.invCell);
      const x1 = Math.floor(b.aabbMax.x * this.invCell);
      const y1 = Math.floor(b.aabbMax.y * this.invCell);
      const z1 = Math.floor(b.aabbMax.z * this.invCell);

      const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
      if (cells > MAX_CELLS_PER_BODY || cells <= 0) {
        if (this.bigCount >= this._bigCap) {
          this._bigCap *= 2;
          const nb = new Int32Array(this._bigCap);
          nb.set(this.bigList);
          this.bigList = nb;
        }
        this.bigList[this.bigCount++] = i;
        continue;
      }

      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) this._insert(i, x, y, z);
        }
      }
    }

    // ── pair ──────────────────────────────────────────────────────────
    for (let s = 0; s < this.usedCount; s++) {
      const slot = this.usedSlots[s];
      for (let e = this.cellHead[slot]; e !== -1; e = this.entryNext[e]) {
        const cx = this.entryCX[e], cy = this.entryCY[e], cz = this.entryCZ[e];
        const bi = this.entryBody[e];
        for (let f = this.entryNext[e]; f !== -1; f = this.entryNext[f]) {
          if (this.entryCX[f] !== cx || this.entryCY[f] !== cy || this.entryCZ[f] !== cz) continue;
          const bj = this.entryBody[f];
          this._tryPair(bodies, bi, bj, filter);
        }
      }
    }

    // Oversized bodies vs everyone.
    for (let k = 0; k < this.bigCount; k++) {
      const bi = this.bigList[k];
      for (let a = 0; a < this.activeCount; a++) {
        const bj = this.active[a];
        if (bj === bi) continue;
        this._tryPair(bodies, bi, bj, filter);
      }
    }

    // Gauss-Seidel converges far faster on a stack when contacts are solved
    // from the ground up, so keep the pair list ordered by body index (bodies
    // are typically added bottom-first). Near-sorted already → insertion sort.
    this._sortPairs();
    return this.pairCount;
  }

  _sortPairs() {
    const p = this.pairs;
    for (let i = 1; i < this.pairCount; i++) {
      const a = p[i * 2], b = p[i * 2 + 1];
      const key = (a << 15) | b;
      let j = i - 1;
      while (j >= 0 && ((p[j * 2] << 15) | p[j * 2 + 1]) > key) {
        p[(j + 1) * 2] = p[j * 2];
        p[(j + 1) * 2 + 1] = p[j * 2 + 1];
        j--;
      }
      p[(j + 1) * 2] = a;
      p[(j + 1) * 2 + 1] = b;
    }
  }

  _insert(bodyIndex, x, y, z) {
    if (this.entryCount >= this._entryCap) {
      this._entryCap *= 2;
      this.entryNext = growI32(this.entryNext, this._entryCap);
      this.entryBody = growI32(this.entryBody, this._entryCap);
      this.entryCX = growI32(this.entryCX, this._entryCap);
      this.entryCY = growI32(this.entryCY, this._entryCap);
      this.entryCZ = growI32(this.entryCZ, this._entryCap);
    }
    const slot = hashCell(x, y, z) & this.tableMask;
    if (this.cellStamp[slot] !== this.frame) {
      this.cellStamp[slot] = this.frame;
      this.cellHead[slot] = -1;
      this.usedSlots[this.usedCount++] = slot;
    }
    const e = this.entryCount++;
    this.entryBody[e] = bodyIndex;
    this.entryCX[e] = x; this.entryCY[e] = y; this.entryCZ[e] = z;
    this.entryNext[e] = this.cellHead[slot];
    this.cellHead[slot] = e;
  }

  _tryPair(bodies, i, j, filter) {
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    // Kept below 2³¹ so it stays a V8 Smi — a 53-bit double here would be boxed
    // into a HeapNumber on every pair test. Supports 32 768 bodies.
    const key = ((a & 0x7fff) << 15) | (b & 0x7fff);

    // dedup
    let slot = (Math.imul(key, 2654435761) >>> 8) & this._pairMask;
    for (let probe = 0; probe < 16; probe++) {
      const s = (slot + probe) & this._pairMask;
      if (this.pairStamp[s] !== this.frame) {
        this.pairStamp[s] = this.frame;
        this.pairKeys[s] = key;
        slot = -1;
        break;
      }
      if (this.pairKeys[s] === key) return;      // already emitted
    }
    if (slot !== -1) { /* table full for this probe run — accept the duplicate */ }

    const ba = bodies[a], bb = bodies[b];
    if (!aabbOverlap(ba, bb)) return;
    if (!filter(ba, bb)) return;

    if (this.pairCount >= this._pairCap) {
      this._pairCap *= 2;
      const np = new Int32Array(this._pairCap * 2);
      np.set(this.pairs);
      this.pairs = np;
    }
    this.pairs[this.pairCount * 2] = a;
    this.pairs[this.pairCount * 2 + 1] = b;
    this.pairCount++;
  }

  // ───────────────────────────────────────────────────────── queries

  /**
   * Bodies whose AABB overlaps the query box. Only valid immediately after
   * `update()` — the grid is rebuilt every step.
   * @param {Int32Array} out
   * @returns {number} count
   */
  queryAABB(minx, miny, minz, maxx, maxy, maxz, bodies, out) {
    let count = 0;
    const cap = out.length;
    const x0 = Math.floor(minx * this.invCell), x1 = Math.floor(maxx * this.invCell);
    const y0 = Math.floor(miny * this.invCell), y1 = Math.floor(maxy * this.invCell);
    const z0 = Math.floor(minz * this.invCell), z1 = Math.floor(maxz * this.invCell);
    const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);

    // Big query, or one that would touch too many cells → linear scan.
    if (cells > 512 || cells <= 0) {
      for (let a = 0; a < this.activeCount && count < cap; a++) {
        const i = this.active[a];
        const b = bodies[i];
        if (b.aabbMin.x > maxx || b.aabbMax.x < minx) continue;
        if (b.aabbMin.y > maxy || b.aabbMax.y < miny) continue;
        if (b.aabbMin.z > maxz || b.aabbMax.z < minz) continue;
        out[count++] = i;
      }
      return count;
    }

    // Per-body dedup stamp (grown once, reused forever).
    if (!this._seen || this._seen.length < bodies.length) {
      this._seen = new Int32Array(nextPow2(Math.max(64, bodies.length)));
      this._qstamp = 0;
    }
    const seen = this._seen;
    const stamp = ++this._qstamp;

    for (let z = z0; z <= z1 && count < cap; z++) {
      for (let y = y0; y <= y1 && count < cap; y++) {
        for (let x = x0; x <= x1 && count < cap; x++) {
          const slot = hashCell(x, y, z) & this.tableMask;
          if (this.cellStamp[slot] !== this.frame) continue;
          for (let e = this.cellHead[slot]; e !== -1 && count < cap; e = this.entryNext[e]) {
            if (this.entryCX[e] !== x || this.entryCY[e] !== y || this.entryCZ[e] !== z) continue;
            const i = this.entryBody[e];
            if (seen[i] === stamp) continue;
            seen[i] = stamp;
            const b = bodies[i];
            if (b.aabbMin.x > maxx || b.aabbMax.x < minx) continue;
            if (b.aabbMin.y > maxy || b.aabbMax.y < miny) continue;
            if (b.aabbMin.z > maxz || b.aabbMax.z < minz) continue;
            out[count++] = i;
          }
        }
      }
    }
    // Oversized bodies are not in the grid.
    for (let k = 0; k < this.bigCount && count < cap; k++) {
      const i = this.bigList[k];
      if (seen[i] === stamp) continue;
      seen[i] = stamp;
      const b = bodies[i];
      if (b.aabbMin.x > maxx || b.aabbMax.x < minx) continue;
      if (b.aabbMin.y > maxy || b.aabbMax.y < miny) continue;
      if (b.aabbMin.z > maxz || b.aabbMax.z < minz) continue;
      out[count++] = i;
    }
    return count;
  }

  clear() {
    this.usedCount = 0;
    this.entryCount = 0;
    this.bigCount = 0;
    this.pairCount = 0;
    this.activeCount = 0;
    this.frame++;
  }

  stats() {
    return {
      cellSize: this.cellSize,
      entries: this.entryCount,
      cells: this.usedCount,
      pairs: this.pairCount,
      oversized: this.bigCount,
    };
  }
}

// ═════════════════════════════════════════════════════════ helpers

function defaultFilter(a, b) {
  if (a.sleeping && b.sleeping) return false;
  if (!a.isMovable && !b.isMovable) return false;
  return ((a.layer & b.mask) !== 0) && ((b.layer & a.mask) !== 0);
}

function aabbOverlap(a, b) {
  return !(a.aabbMin.x > b.aabbMax.x || a.aabbMax.x < b.aabbMin.x ||
           a.aabbMin.y > b.aabbMax.y || a.aabbMax.y < b.aabbMin.y ||
           a.aabbMin.z > b.aabbMax.z || a.aabbMax.z < b.aabbMin.z);
}

function hashCell(x, y, z) {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0;
}

function growI32(src, cap) {
  const out = new Int32Array(cap);
  out.set(src);
  return out;
}

function nextPow2(v) {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

export default Broadphase;
