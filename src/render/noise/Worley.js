/**
 * Seamlessly tileable Worley / cellular noise.
 *
 * The feature-point grid is wrapped to `period` before hashing, so sampling
 * over [0,period) tiles exactly. Returns F1, F2, the winning cell id, the
 * winning cell's integer coordinates and the offset to its feature point —
 * enough to build tiles, pebbles, cracked ice, scales and mosaic.
 *
 * All functions write into module-level scratch objects. Read what you need
 * *immediately*; never keep a reference.
 */

import { hash2i, hashLo, hashHi, wrapi } from './Hash.js';

/** @typedef {{f1:number,f2:number,cellId:number,cx:number,cy:number,px:number,py:number,f1x:number,f1y:number}} WorleyResult */

/** @type {WorleyResult} */
const _w = { f1: 0, f2: 0, cellId: 0, cx: 0, cy: 0, px: 0, py: 0, f1x: 0, f1y: 0 };

/**
 * Euclidean Worley. `x,y` are in *cell* units (multiply your uv by `period`).
 *
 * @param {number} x @param {number} y
 * @param {number} period cells across the tile (wrapping period)
 * @param {number} [seed]
 * @param {number} [jitter] 0 = perfect grid, 1 = fully random points
 * @returns {WorleyResult} shared scratch
 */
export function worley2(x, y, period, seed = 0, jitter = 1) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9;
  let cellId = 0, cx = 0, cy = 0, fpx = 0, fpy = 0;

  for (let dy = -1; dy <= 1; dy++) {
    const gy = yi + dy;
    const wy = wrapi(gy, period);
    for (let dx = -1; dx <= 1; dx++) {
      const gx = xi + dx;
      const wx = wrapi(gx, period);
      const h = hash2i(wx, wy, seed);
      const ox = 0.5 + (hashLo(h) - 0.5) * jitter;
      const oy = 0.5 + (hashHi(h) - 0.5) * jitter;
      const pxp = gx + ox, pyp = gy + oy;
      const ddx = pxp - x, ddy = pyp - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1; f1 = d;
        cellId = h; cx = wx; cy = wy; fpx = pxp; fpy = pyp;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  _w.f1 = f1; _w.f2 = f2; _w.cellId = cellId;
  _w.cx = cx; _w.cy = cy; _w.px = fpx; _w.py = fpy;
  _w.f1x = x - fpx; _w.f1y = y - fpy;
  return _w;
}

/**
 * Chebyshev / Manhattan variants — squarer cells, good for mosaic and
 * "cracked mud" looks. `metric`: 0 = euclidean, 1 = manhattan, 2 = chebyshev.
 */
export function worley2Metric(x, y, period, seed = 0, jitter = 1, metric = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 1e9, f2 = 1e9;
  let cellId = 0, cx = 0, cy = 0, fpx = 0, fpy = 0;

  for (let dy = -1; dy <= 1; dy++) {
    const gy = yi + dy;
    const wy = wrapi(gy, period);
    for (let dx = -1; dx <= 1; dx++) {
      const gx = xi + dx;
      const wx = wrapi(gx, period);
      const h = hash2i(wx, wy, seed);
      const pxp = gx + 0.5 + (hashLo(h) - 0.5) * jitter;
      const pyp = gy + 0.5 + (hashHi(h) - 0.5) * jitter;
      const ddx = Math.abs(pxp - x), ddy = Math.abs(pyp - y);
      let d;
      if (metric === 1) d = ddx + ddy;
      else if (metric === 2) d = Math.max(ddx, ddy);
      else d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < f1) {
        f2 = f1; f1 = d;
        cellId = h; cx = wx; cy = wy; fpx = pxp; fpy = pyp;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  _w.f1 = f1; _w.f2 = f2; _w.cellId = cellId;
  _w.cx = cx; _w.cy = cy; _w.px = fpx; _w.py = fpy;
  _w.f1x = x - fpx; _w.f1y = y - fpy;
  return _w;
}

/** F1 only, clamped to [0,1]-ish. Fast path for pebble/gravel height. */
export function worleyF1(x, y, period, seed = 0, jitter = 1) {
  return worley2(x, y, period, seed, jitter).f1;
}

/**
 * Voronoi cell *border* field: 1 exactly on a border, falling off over `w`
 * cell units. This is the exact-ish edge distance (F2-F1 is a good cheap
 * approximation for isotropic point sets).
 */
export function worleyEdges(x, y, period, seed = 0, jitter = 1, w = 0.06) {
  const r = worley2(x, y, period, seed, jitter);
  const d = r.f2 - r.f1;
  if (d >= w) return 0;
  const t = d / w;
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Multi-octave crack network. Layers several Voronoi border fields at
 * increasing frequency with decreasing intensity — ice, dried mud, glass.
 *
 * @returns {number} [0,1], 1 = deep crack
 */
export function cracks2(u, v, period, octaves = 3, seed = 0, width = 0.05, gain = 0.55) {
  let sum = 0, amp = 1, norm = 0, p = period;
  for (let i = 0; i < octaves; i++) {
    const pi = Math.max(2, Math.round(p));
    const e = worleyEdges(u * pi, v * pi, pi, seed + i * 7919, 1, width);
    sum += amp * e;
    norm += amp;
    amp *= gain;
    p *= 1.9;
  }
  return Math.min(1, sum / (norm * 0.85));
}

/**
 * Per-cell random value in [0,1) for the cell that owns (x,y). Handy for
 * flat-shaded mosaic/tile colour variation.
 */
export function cellValue(x, y, period, seed = 0, jitter = 1, channel = 0) {
  const r = worley2(x, y, period, seed, jitter);
  return (hash2i(r.cx, r.cy, seed + 4096 + channel * 131) >>> 8) / 16777216;
}

/**
 * Smooth-minimum Worley — rounded, blobby cells (soap bubbles, pebbles).
 * `k` controls the blend radius.
 */
export function worleySmooth(x, y, period, seed = 0, jitter = 1, k = 0.35) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let acc = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const gy = yi + dy;
    const wy = wrapi(gy, period);
    for (let dx = -1; dx <= 1; dx++) {
      const gx = xi + dx;
      const wx = wrapi(gx, period);
      const h = hash2i(wx, wy, seed);
      const pxp = gx + 0.5 + (hashLo(h) - 0.5) * jitter;
      const pyp = gy + 0.5 + (hashHi(h) - 0.5) * jitter;
      const ddx = pxp - x, ddy = pyp - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      acc += Math.exp(-d / k);
    }
  }
  return -k * Math.log(Math.max(1e-6, acc));
}
