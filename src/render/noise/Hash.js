/**
 * Fast integer hashing + gradient tables for the procedural texture toolkit.
 *
 * Everything here is allocation-free and deterministic: the same (coords, seed)
 * always produces the same value on every machine. All hashes take *already
 * wrapped* integer lattice coordinates — wrapping is the caller's job, and it is
 * how we get perfectly tileable noise.
 */

/** 32-bit integer avalanche (variant of murmur3's finalizer). */
export function mix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash of one integer. */
export function hash1i(x, seed = 0) {
  return mix32(Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x9e3779b9));
}

/** Hash of a 2D integer lattice point. */
export function hash2i(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d);
  h ^= Math.imul(y | 0, 0x165667b1);
  h ^= Math.imul(seed | 0, 0x9e3779b9);
  return mix32(h);
}

/** Hash of a 3D integer lattice point. */
export function hash3i(x, y, z, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d);
  h ^= Math.imul(y | 0, 0x165667b1);
  h ^= Math.imul(z | 0, 0x1b873593);
  h ^= Math.imul(seed | 0, 0x9e3779b9);
  return mix32(h);
}

/** Hash of a 4D integer lattice point. */
export function hash4i(x, y, z, w, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d);
  h ^= Math.imul(y | 0, 0x165667b1);
  h ^= Math.imul(z | 0, 0x1b873593);
  h ^= Math.imul(w | 0, 0x85ebca6b);
  h ^= Math.imul(seed | 0, 0x9e3779b9);
  return mix32(h);
}

const INV32 = 1 / 4294967296;

/** Deterministic pseudo-random float in [0,1) for a 1D key. */
export const rand1 = (x, seed = 0) => hash1i(x, seed) * INV32;
/** Deterministic pseudo-random float in [0,1) for a 2D key. */
export const rand2 = (x, y, seed = 0) => hash2i(x, y, seed) * INV32;
/** Deterministic pseudo-random float in [0,1) for a 3D key. */
export const rand3 = (x, y, z, seed = 0) => hash3i(x, y, z, seed) * INV32;

/** Split a single hash into two independent [0,1) floats (top/bottom 16 bits). */
export const hashLo = (h) => (h & 0xffff) / 65536;
export const hashHi = (h) => ((h >>> 16) & 0xffff) / 65536;

/**
 * Integer wrap that is correct for negative inputs and cheap for the common
 * positive case. `p <= 0` disables wrapping (non-tiling noise).
 */
export function wrapi(i, p) {
  if (p <= 0) return i | 0;
  const m = (i | 0) % p;
  return m < 0 ? m + p : m;
}

/** Float wrap into [0,p). */
export function wrapf(v, p) {
  if (p <= 0) return v;
  const m = v % p;
  return m < 0 ? m + p : m;
}

// ── Gradient tables ────────────────────────────────────────────────────────

/** 16 evenly spaced unit vectors — richer than the classic 8 and still cheap. */
export const GRAD2 = new Float32Array(32);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}

/** Ken Perlin's 12 cube-edge gradients (+4 repeats to make the table 16 long). */
export const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, -1, 1, 0, 0, -1, 1, 0, -1, -1,
]);

/** Dot of the hashed 2D gradient with (x,y). */
export function grad2(h, x, y) {
  const i = (h & 15) << 1;
  return GRAD2[i] * x + GRAD2[i + 1] * y;
}

/** Dot of the hashed 3D gradient with (x,y,z). */
export function grad3(h, x, y, z) {
  const i = (h & 15) * 3;
  return GRAD3[i] * x + GRAD3[i + 1] * y + GRAD3[i + 2] * z;
}

/** Quintic fade curve (C2 continuous) — Perlin's improved interpolant. */
export function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Cubic smoothstep, used where C1 is enough and speed matters. */
export function smooth3(t) {
  return t * t * (3 - 2 * t);
}
