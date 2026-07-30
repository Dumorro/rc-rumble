/**
 * Structured, tileable pattern generators: brick/tile layouts, weaves, wood
 * rings, fibres, stripes, checkers, hex grids and studs.
 *
 * Everything is evaluated per-pixel from normalised (u,v) in [0,1) and wraps
 * exactly at the tile edge as long as the row/column counts are integers.
 *
 * Results are returned through module-level scratch objects — read them
 * immediately.
 */

import { hash2i, hashLo, hashHi, rand2 } from './Hash.js';
import { fbm2p, fbm2ap, perlin2, sstep } from './Perlin.js';

const TAU = Math.PI * 2;
const frac = (x) => x - Math.floor(x);

// ── Brick / tile layout ────────────────────────────────────────────────────

/**
 * @typedef {object} CellResult
 * @property {number} u  local u inside the cell, [0,1)
 * @property {number} v  local v inside the cell, [0,1)
 * @property {number} col wrapped column index
 * @property {number} row wrapped row index
 * @property {number} id  hash of the cell
 * @property {number} r0  per-cell random [0,1)
 * @property {number} r1  a second independent per-cell random [0,1)
 * @property {number} edge distance to the nearest cell edge, in cell units [0,0.5]
 * @property {number} mortar 1 inside the grout line, 0 well inside the cell
 * @property {number} aspect cell width / height in tile units
 */
const _cell = { u: 0, v: 0, col: 0, row: 0, id: 0, r0: 0, r1: 0, edge: 0, mortar: 0, aspect: 1 };

/**
 * Running-bond brick / stack-bond tile layout with per-row offset, per-cell
 * jitter and a grout band.
 *
 * @param {number} u @param {number} v
 * @param {object} o
 * @param {number} o.cols columns across the tile (integer)
 * @param {number} o.rows rows down the tile (integer)
 * @param {number} [o.rowOffset] fraction of a cell each successive row shifts (0.5 = running bond)
 * @param {number} [o.mortar] grout half-width as a fraction of the cell (0..0.3)
 * @param {number} [o.jitter] per-cell positional wobble in cell units
 * @param {number} [o.seed]
 * @param {number} [o.stagger] 0 = every row offset by rowOffset*row, 1 = random per row
 * @returns {CellResult} shared scratch
 */
export function brickLayout(u, v, o) {
  const cols = o.cols | 0, rows = o.rows | 0;
  const rowOffset = o.rowOffset ?? 0.5;
  const mortar = o.mortar ?? 0.03;
  const jitter = o.jitter ?? 0;
  const seed = o.seed ?? 0;
  const stagger = o.stagger ?? 0;

  const vy = v * rows;
  let row = Math.floor(vy);
  const lv = vy - row;
  row = ((row % rows) + rows) % rows;

  // Row shift. Random staggering must still be periodic → hash the wrapped row.
  let shift = rowOffset * row;
  if (stagger > 0) shift += stagger * rand2(row, 917, seed);

  const ux = u * cols + shift;
  let col = Math.floor(ux);
  const lu = ux - col;
  col = ((col % cols) + cols) % cols;

  const h = hash2i(col, row, seed);
  const r0 = hashLo(h), r1 = hashHi(h);

  // Jitter shifts the *apparent* cell borders slightly — enough to break the
  // machine-perfect grid without breaking tiling (it only moves local coords).
  const ju = jitter ? (r0 - 0.5) * jitter : 0;
  const jv = jitter ? (r1 - 0.5) * jitter : 0;
  const cu = Math.min(1, Math.max(0, lu + ju));
  const cv = Math.min(1, Math.max(0, lv + jv));

  const eu = cu < 0.5 ? cu : 1 - cu;
  const ev = cv < 0.5 ? cv : 1 - cv;
  // Cells are usually wider than tall — normalise the edge distance so the
  // grout band has a constant *physical* width on both axes.
  const aspect = (1 / cols) / (1 / rows);
  const edge = Math.min(eu * (aspect >= 1 ? 1 : aspect), ev * (aspect >= 1 ? 1 / aspect : 1));

  _cell.u = cu; _cell.v = cv; _cell.col = col; _cell.row = row;
  _cell.id = h; _cell.r0 = r0; _cell.r1 = r1;
  _cell.edge = edge;
  _cell.mortar = mortar > 0 ? 1 - sstep(mortar * 0.35, mortar, edge) : 0;
  _cell.aspect = aspect;
  return _cell;
}

/** Square-tile convenience wrapper (no row offset). */
export function tileLayout(u, v, n, mortar = 0.02, seed = 0, jitter = 0) {
  return brickLayout(u, v, { cols: n, rows: n, rowOffset: 0, mortar, seed, jitter });
}

/**
 * Plank layout: long strips running along +u, each split into planks of
 * randomised length with staggered end joints. Perfect for oak floors and
 * parquet strips.
 *
 * @param {number} u @param {number} v
 * @param {object} o
 * @param {number} o.rows number of plank rows down the tile
 * @param {number} o.perRow planks per row (integer, ≥1)
 * @param {number} [o.gap] joint half-width in cell units
 * @param {number} [o.seed]
 * @returns {CellResult}
 */
export function plankLayout(u, v, o) {
  const rows = o.rows | 0;
  const perRow = Math.max(1, o.perRow | 0);
  const gap = o.gap ?? 0.004;
  const seed = o.seed ?? 0;

  const vy = v * rows;
  let row = Math.floor(vy);
  const lv = vy - row;
  row = ((row % rows) + rows) % rows;

  // Each row gets its own phase so end joints never line up.
  const phase = rand2(row, 4211, seed);
  const ux = u * perRow + phase * perRow;
  let col = Math.floor(ux);
  const lu = ux - col;
  col = ((col % perRow) + perRow) % perRow;

  const h = hash2i(col, row, seed + 55);
  const r0 = hashLo(h), r1 = hashHi(h);

  const eu = (lu < 0.5 ? lu : 1 - lu) / perRow;   // in tile units
  const ev = (lv < 0.5 ? lv : 1 - lv) / rows;
  const edge = Math.min(eu, ev);

  _cell.u = lu; _cell.v = lv; _cell.col = col; _cell.row = row;
  _cell.id = h; _cell.r0 = r0; _cell.r1 = r1;
  _cell.edge = edge;
  _cell.mortar = gap > 0 ? 1 - sstep(gap * 0.3, gap, edge) : 0;
  _cell.aspect = (1 / perRow) / (1 / rows);
  return _cell;
}

/**
 * Parquet block layout with 2×1 strips.
 *
 * `mode`:
 *   'herringbone' — true herringbone. A cell is the left/right half of a
 *                   horizontal strip when (i+j) mod 4 is 0/1, and the
 *                   bottom/top half of a vertical strip when it is 2/3.
 *                   Exactly tileable when `n` is a multiple of 4.
 *   'basket'      — basket weave: 2×2 blocks of two parallel strips,
 *                   orientation alternating like a checkerboard.
 *                   Tileable when `n` is a multiple of 4.
 *   'brick'       — running-bond strips all running along +u.
 *
 * Returned scratch: `u` runs *along* the strip [0,1), `v` runs *across* it,
 * `aspect` is +1 for strips along +u and -1 for strips along +v, `edge` is the
 * distance to the nearest strip border in cell units.
 *
 * @param {number} u @param {number} v
 * @param {number} n cells across the tile (a strip is 2 cells long, 1 wide)
 * @returns {CellResult}
 */
export function parquetLayout(u, v, n, mode = 'herringbone', seed = 0) {
  const N = Math.max(2, n | 0);
  const fx = u * N, fy = v * N;
  const gx = Math.floor(fx), gy = Math.floor(fy);
  const lu = fx - gx, lv = fy - gy;
  const i = ((gx % N) + N) % N;
  const j = ((gy % N) + N) % N;

  let vertical, along, across, ax, ay;   // ax/ay = strip anchor cell

  if (mode === 'basket') {
    const bi = i >> 1, bj = j >> 1;
    vertical = ((bi + bj) & 1) === 1;
    if (vertical) {
      // Two vertical strips side by side inside the 2×2 block.
      along = ((j & 1) + lv) * 0.5;
      across = lu;
      ax = i; ay = bj * 2;
    } else {
      along = ((i & 1) + lu) * 0.5;
      across = lv;
      ax = bi * 2; ay = j;
    }
  } else if (mode === 'brick') {
    vertical = false;
    const shift = (j & 1) ? 1 : 0;
    const k = (i + shift) & 1;
    along = (k + lu) * 0.5;
    across = lv;
    ax = i - k; ay = j;
  } else {
    const r = (i + j) & 3;
    if (r < 2) {
      vertical = false;
      along = (r + lu) * 0.5;
      across = lv;
      ax = i - r; ay = j;
    } else {
      vertical = true;
      const k = r - 2;
      along = (k + lv) * 0.5;
      across = lu;
      ax = i; ay = j - k;
    }
  }

  const h = hash2i(((ax % N) + N) % N, ((ay % N) + N) % N, seed);
  const ea = Math.min(along, 1 - along) * 2;   // in cell units along the strip
  const ec = Math.min(across, 1 - across);
  _cell.u = along;
  _cell.v = across;
  _cell.col = ax; _cell.row = ay;
  _cell.id = h;
  _cell.r0 = hashLo(h); _cell.r1 = hashHi(h);
  _cell.edge = Math.min(ea, ec) / N;
  _cell.mortar = 0;
  _cell.aspect = vertical ? -1 : 1;
  return _cell;
}

// ── Weave ──────────────────────────────────────────────────────────────────

/**
 * @typedef {object} WeaveResult
 * @property {number} h    height of the thread surface, [0,1]
 * @property {boolean} warp true if the visible thread is a warp (vertical) thread
 * @property {number} along position along the visible thread, [0,1)
 * @property {number} across signed position across the thread, [-1,1]
 * @property {number} id   per-thread hash
 * @property {number} gap  1 in the gap between threads, 0 on a thread
 */
const _weave = { h: 0, warp: false, along: 0, across: 0, id: 0, gap: 0 };

/**
 * Woven cloth — plain weave or twill.
 *
 * Warp (vertical) and weft (horizontal) threads are modelled as cylinders whose
 * *elevation* rises and falls smoothly as they pass over and under each other.
 * The visible surface is whichever thread is higher, so there is no hard step
 * at a thread crossing (the naive over/under flag produces one, and it looks
 * like a bug).
 *
 * Tiling: `threads` must be even for a plain weave, and a multiple of
 * `2 * (twill + 2)` for a twill (e.g. 108 or 120 for a 2/1 twill).
 *
 * @param {number} u @param {number} v
 * @param {number} threads thread pitches across the tile
 * @param {number} [ratio] thread width vs pitch (1 = touching, <1 leaves a gap)
 * @param {number} [seed]
 * @param {number} [twill] 0 = plain weave, ≥1 = diagonal twill
 * @returns {WeaveResult} shared scratch
 */
export function weave(u, v, threads, ratio = 0.86, seed = 0, twill = 0) {
  const n = Math.max(2, threads | 0);
  const fx = u * n, fy = v * n;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const lx = fx - ix, ly = fy - iy;
  const cx = ((ix % n) + n) % n, cy = ((iy % n) + n) % n;

  // Distance from each thread's centre line, in [-1,1].
  const ax = (lx - 0.5) * 2;
  const ay = (ly - 0.5) * 2;
  const inWarp = Math.abs(ax) <= ratio;
  const inWeft = Math.abs(ay) <= ratio;
  const rWarp = inWarp ? Math.sqrt(Math.max(0, 1 - (ax / ratio) * (ax / ratio))) : 0;
  const rWeft = inWeft ? Math.sqrt(Math.max(0, 1 - (ay / ratio) * (ay / ratio))) : 0;

  // Smooth over/under elevation. Plain weave = checkerboard phase; a twill
  // shifts the phase along the warp direction so the ribs run diagonally.
  const tp = twill > 0 ? (twill | 0) + 2 : 2;
  const eWarp = 0.5 + 0.5 * Math.cos(TAU * (fy / 2 + fx / tp));
  const eWeft = 1 - eWarp;

  const zWarp = inWarp ? eWarp * 0.55 + rWarp * 0.45 : -1;
  const zWeft = inWeft ? eWeft * 0.55 + rWeft * 0.45 : -1;

  const isWarp = zWarp >= zWeft;
  const gap = (!inWarp && !inWeft) ? 1 : 0;

  _weave.h = gap ? 0 : Math.max(0, isWarp ? zWarp : zWeft);
  _weave.warp = isWarp;
  _weave.along = isWarp ? ly : lx;
  _weave.across = isWarp ? ax / ratio : ay / ratio;
  _weave.gap = gap;
  _weave.id = hash2i(isWarp ? cx : cy, isWarp ? 1 : 2, seed);
  return _weave;
}

/**
 * Fine directional fibre noise — the fuzz on felt, the nap of denim, carpet
 * pile, brushed metal. Noise is stretched *along* the fibre direction.
 *
 * Direction is given as an **integer** lattice vector (dirU, dirV) so the
 * rotated coordinates remain integer combinations of u and v and the result
 * still tiles exactly: (1,0) = fibres run along +u, (0,1) = along +v,
 * (1,1) = 45°, (2,1) ≈ 26.6°, and so on.
 *
 * @param {number} u @param {number} v
 * @param {number} across frequency across the fibres (integer, high)
 * @param {number} along frequency along the fibres (integer, low)
 * @param {number} [dirU] integer direction component
 * @param {number} [dirV] integer direction component
 * @param {number} [seed]
 * @param {number} [octaves]
 * @returns {number} roughly [-1,1]
 */
export function fibre(u, v, across, along, dirU = 1, dirV = 0, seed = 0, octaves = 3) {
  const du = dirU | 0, dv = dirV | 0;
  // Along-fibre axis and its perpendicular; both integer combinations of u,v.
  const pa = u * du + v * dv;
  const pc = -u * dv + v * du;
  let sum = 0, amp = 1, norm = 0;
  for (let k = 0; k < octaves; k++) {
    const m = 1 << k;
    const A = Math.max(1, Math.round(across) * m);
    const B = Math.max(1, Math.round(along) * m);
    sum += amp * perlin2(pc * A, pa * B, A, B, seed + k * 613);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

// ── Wood ───────────────────────────────────────────────────────────────────

const _wood = { ring: 0, grain: 0, pore: 0, ray: 0, r: 0 };

/**
 * Wood growth rings + grain + pores, seamless along the plank axis.
 *
 * The "pith" (tree centre) sits off the tile so we see near-parallel rings —
 * which is what a flat-sawn board looks like. The ring coordinate is built
 * from `v` (across the board) plus a periodic wobble driven by `u`, so the
 * pattern tiles perfectly along the plank.
 *
 * @param {number} u along the plank [0,1)
 * @param {number} v across the plank [0,1)
 * @param {object} o
 * @param {number} [o.rings] rings across the board
 * @param {number} [o.wobble] how much the rings meander along the plank
 * @param {number} [o.wobbleFreq]
 * @param {number} [o.curve] cathedral arch strength (flat-sawn look)
 * @param {number} [o.seed]
 * @returns {{ring:number, grain:number, pore:number, ray:number, r:number}}
 */
export function woodRings(u, v, o = {}) {
  // Must be an integer: the ring phase is `frac(r * rings)` and `r` jumps by
  // exactly 1 across the v seam, so only integer ring counts tile.
  const rings = Math.max(1, Math.round(o.rings ?? 9));
  const wobble = o.wobble ?? 0.10;
  const wobbleFreq = Math.max(1, Math.round(o.wobbleFreq ?? 2));
  const curve = o.curve ?? 0.35;
  const seed = o.seed ?? 0;

  // Cathedral arches: a smooth periodic bulge along the plank.
  const arch = Math.sin(u * TAU * wobbleFreq) * curve
    + Math.sin(u * TAU * (wobbleFreq * 2) + 1.7) * curve * 0.35;
  const meander = fbm2ap(u, v, wobbleFreq * 2, 1, 3, 2, 0.5, seed) * wobble;

  const r = v + arch * 0.10 + meander;
  const ringPhase = r * rings;
  // Latewood is a thin dark band → skew the sine.
  const s = frac(ringPhase);
  const ring = Math.pow(0.5 - 0.5 * Math.cos(s * TAU), 1.6);

  // Fine grain: very stretched noise along the plank.
  const grain = fbm2ap(u, r, 1, 26, 4, 2.1, 0.55, seed + 991) * 0.5 + 0.5;

  // Open pores (oak/ash): tiny elongated dashes following the grain.
  const poreN = perlin2(u * 220, r * 34, 220, 34, seed + 1777);
  const pore = Math.max(0, poreN - 0.42) / 0.58;

  // Medullary rays: sparse light streaks across the grain.
  const rayN = perlin2(u * 7, r * 90, 7, 90, seed + 3313);
  const ray = Math.max(0, Math.abs(rayN) - 0.62) / 0.38;

  _wood.ring = ring;
  _wood.grain = grain;
  _wood.pore = pore;
  _wood.ray = ray;
  _wood.r = r;
  return _wood;
}

/** Concentric end-grain rings (for the end of a block / a wooden dowel). */
export function woodEndGrain(u, v, rings = 14, seed = 0, wobble = 0.06) {
  const dx = u - 0.5, dy = v - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy);
  const a = Math.atan2(dy, dx);
  const wob = Math.sin(a * 5 + 1.3) * wobble + Math.sin(a * 11 - 0.4) * wobble * 0.5;
  const s = frac((d + wob) * rings);
  return Math.pow(0.5 - 0.5 * Math.cos(s * TAU), 1.5);
}

// ── Simple periodic shapes ─────────────────────────────────────────────────

/** Hard checkerboard, `n` squares across (n must be even to tile). */
export function checker(u, v, n) {
  const x = Math.floor(u * n), y = Math.floor(v * n);
  return ((x + y) & 1) ? 1 : 0;
}

/** Anti-aliased checkerboard with a soft edge of `soft` tile units. */
export function checkerSoft(u, v, n, soft = 0.004) {
  const s = soft * n;
  const fx = frac(u * n), fy = frac(v * n);
  const ex = Math.min(fx, 1 - fx), ey = Math.min(fy, 1 - fy);
  const hard = checker(u, v, n);
  const e = Math.min(ex, ey);
  const k = sstep(0, s, e);
  return hard * k + 0.5 * (1 - k);
}

/** Stripes along v. `n` stripes, `duty` = fraction that is "on". */
export function stripes(u, v, n, duty = 0.5, soft = 0.002, axis = 0) {
  const t = frac((axis ? v : u) * n);
  const s = soft * n;
  return sstep(0, s, t) * (1 - sstep(duty - s, duty, t));
}

/** Diagonal stripes; `n` must divide evenly to tile (use integer n). */
export function diagonalStripes(u, v, n, duty = 0.5, soft = 0.004) {
  const t = frac((u + v) * n);
  const s = soft * n;
  return sstep(0, s, t) * (1 - sstep(duty - s, duty, t));
}

const _hex = { u: 0, v: 0, col: 0, row: 0, id: 0, r0: 0, edge: 0 };

/**
 * Flat-top hex-ish grid (offset brick rows with a hex edge falloff).
 * `n` columns across; the row count is forced even so the half-row offset
 * still tiles.
 */
export function hexGrid(u, v, n, seed = 0) {
  const N = Math.max(2, n | 0);
  const rowsTotal = Math.max(2, Math.round(N / 0.75 / 2) * 2);
  const fy = v * rowsTotal;
  const row = Math.floor(fy);
  const ly = fy - row;
  const wrow = ((row % rowsTotal) + rowsTotal) % rowsTotal;
  const off = (wrow & 1) ? 0.5 : 0;
  const fx = u * N + off;
  const col = Math.floor(fx);
  const lx = fx - col;
  const wcol = ((col % N) + N) % N;

  const dx = Math.abs(lx - 0.5) * 2, dy = Math.abs(ly - 0.5) * 2;
  // Clipped by the cell on both axes so the field reaches 0 at every border.
  const edge = Math.max(0, 1 - Math.max(dx, dy, dx * 0.5 + dy * 0.866));

  const h = hash2i(wcol, wrow, seed);
  _hex.u = lx; _hex.v = ly; _hex.col = wcol; _hex.row = wrow;
  _hex.id = h; _hex.r0 = hashLo(h); _hex.edge = edge;
  return _hex;
}

/**
 * Circular stud/dot grid (LEGO studs, dice pips, rubber mat nubs).
 * Returns the stud height profile in [0,1] and its local coords.
 */
const _stud = { h: 0, du: 0, dv: 0, col: 0, row: 0, id: 0, d: 0 };
export function studGrid(u, v, n, radius = 0.32, bevel = 0.08, seed = 0) {
  const N = n | 0;
  const fx = u * N, fy = v * N;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const lx = fx - ix - 0.5, ly = fy - iy - 0.5;
  const d = Math.sqrt(lx * lx + ly * ly);
  const h = 1 - sstep(radius - bevel, radius, d);
  const cx = ((ix % N) + N) % N, cy = ((iy % N) + N) % N;
  _stud.h = h; _stud.du = lx; _stud.dv = ly; _stud.d = d;
  _stud.col = cx; _stud.row = cy; _stud.id = hash2i(cx, cy, seed);
  return _stud;
}

/**
 * Corrugation profile (cardboard flutes, corrugated iron). Perfectly periodic
 * triangle/sine hybrid along one axis.
 */
export function corrugation(t, n, sharpness = 0.35) {
  const s = frac(t * n);
  const tri = s < 0.5 ? s * 2 : 2 - s * 2;
  const sine = 0.5 - 0.5 * Math.cos(s * TAU);
  return tri * sharpness + sine * (1 - sharpness);
}

/**
 * Diamond-plate / tread-plate lozenges.
 *
 * Rows of elongated diamonds, tilted the opposite way on alternate rows and
 * offset half a cell — the classic checker-plate look. The lozenge shape falls
 * to zero before the cell border, so the field is continuous everywhere and
 * tiles exactly (`n` is forced even).
 *
 * @returns {number} raised height in [0,1]
 */
export function diamondPlate(u, v, n, seed = 0) {
  const rows = Math.max(2, Math.round(n / 2) * 2);
  const cols = rows;
  const fy = v * rows;
  const row = Math.floor(fy);
  const lv = fy - row;
  const odd = (((row % rows) + rows) % rows) & 1;
  const dir = odd ? 1 : -1;
  const fx = u * cols + odd * 0.5;
  const lu = fx - Math.floor(fx);

  const p = (lu - 0.5) * 2, qv = (lv - 0.5) * 2;
  const ang = dir * 0.62;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const s = p * ca + qv * sa;
  const t = -p * sa + qv * ca;
  const d = Math.abs(s) / 0.98 + Math.abs(t) / 0.46;
  const inside = 1 - sstep(0.5, 1.0, d);
  return inside <= 0 ? 0 : Math.pow(inside, 0.55);
}
