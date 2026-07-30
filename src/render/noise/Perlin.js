/**
 * Seamlessly tileable gradient (Perlin) noise + fBm family.
 *
 * Tiling works by wrapping the *integer lattice* to a period before hashing.
 * If you sample x,y over [0,period) the result is exactly periodic — no seams,
 * no cross-fading hacks. fBm doubles the period each octave so every octave
 * stays in phase with the tile.
 *
 * Convention used everywhere in this toolkit:
 *   - `u,v` are normalised texture coordinates in [0,1).
 *   - `period` is the number of noise cells across the whole tile.
 *   - So a painter does:  perlin2(u * period, v * period, period, period, seed)
 *
 * All functions are allocation-free.
 */

import { grad2, grad3, hash2i, hash3i, hash4i, fade, wrapi } from './Hash.js';

// Perlin's theoretical maximum for unit gradients is 1/sqrt(N/4); normalise so
// the practical range sits close to [-1,1].
const NORM2 = 1.4142135623730951;
const NORM3 = 1.1547005383792517;

/**
 * Periodic 2D gradient noise. Returns roughly [-1,1].
 * @param {number} x @param {number} y
 * @param {number} px lattice period in x (<=0 disables wrapping)
 * @param {number} py lattice period in y
 * @param {number} [seed]
 */
export function perlin2(x, y, px, py, seed = 0) {
  const X = Math.floor(x), Y = Math.floor(y);
  const fx = x - X, fy = y - Y;
  const u = fade(fx), v = fade(fy);

  const x0 = wrapi(X, px), x1 = wrapi(X + 1, px);
  const y0 = wrapi(Y, py), y1 = wrapi(Y + 1, py);

  const n00 = grad2(hash2i(x0, y0, seed), fx, fy);
  const n10 = grad2(hash2i(x1, y0, seed), fx - 1, fy);
  const n01 = grad2(hash2i(x0, y1, seed), fx, fy - 1);
  const n11 = grad2(hash2i(x1, y1, seed), fx - 1, fy - 1);

  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return (a + v * (b - a)) * NORM2;
}

/**
 * Periodic 3D gradient noise. Use the third axis for animation (pass a large
 * `pz` for "never repeats", or a small one for a perfectly looping animation).
 */
export function perlin3(x, y, z, px, py, pz, seed = 0) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const u = fade(fx), v = fade(fy), w = fade(fz);

  const x0 = wrapi(X, px), x1 = wrapi(X + 1, px);
  const y0 = wrapi(Y, py), y1 = wrapi(Y + 1, py);
  const z0 = wrapi(Z, pz), z1 = wrapi(Z + 1, pz);

  const n000 = grad3(hash3i(x0, y0, z0, seed), fx, fy, fz);
  const n100 = grad3(hash3i(x1, y0, z0, seed), fx - 1, fy, fz);
  const n010 = grad3(hash3i(x0, y1, z0, seed), fx, fy - 1, fz);
  const n110 = grad3(hash3i(x1, y1, z0, seed), fx - 1, fy - 1, fz);
  const n001 = grad3(hash3i(x0, y0, z1, seed), fx, fy, fz - 1);
  const n101 = grad3(hash3i(x1, y0, z1, seed), fx - 1, fy, fz - 1);
  const n011 = grad3(hash3i(x0, y1, z1, seed), fx, fy - 1, fz - 1);
  const n111 = grad3(hash3i(x1, y1, z1, seed), fx - 1, fy - 1, fz - 1);

  const a0 = n000 + u * (n100 - n000);
  const b0 = n010 + u * (n110 - n010);
  const c0 = a0 + v * (b0 - a0);

  const a1 = n001 + u * (n101 - n001);
  const b1 = n011 + u * (n111 - n011);
  const c1 = a1 + v * (b1 - a1);

  return (c0 + w * (c1 - c0)) * NORM3;
}

/**
 * 4D gradient noise. Only used by the torus mapping below, so it favours
 * clarity over raw speed (16 lattice corners).
 */
export function perlin4(x, y, z, w, seed = 0) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), W = Math.floor(w);
  const fx = x - X, fy = y - Y, fz = z - Z, fw = w - W;
  const ux = fade(fx), uy = fade(fy), uz = fade(fz), uw = fade(fw);

  let acc = 0;
  for (let i = 0; i < 16; i++) {
    const ox = i & 1, oy = (i >> 1) & 1, oz = (i >> 2) & 1, ow = (i >> 3) & 1;
    const h = hash4i(X + ox, Y + oy, Z + oz, W + ow, seed);
    const dx = fx - ox, dy = fy - oy, dz = fz - oz, dw = fw - ow;
    // Cheap 4D gradient: pick signs + a dropped axis from the hash.
    const g =
      ((h & 1) ? dx : -dx) +
      ((h & 2) ? dy : -dy) +
      ((h & 4) ? dz : -dz) +
      ((h & 8) ? dw : -dw);
    const wx = ox ? ux : 1 - ux;
    const wy = oy ? uy : 1 - uy;
    const wz = oz ? uz : 1 - uz;
    const ww = ow ? uw : 1 - uw;
    acc += g * wx * wy * wz * ww;
  }
  return acc * 0.62;
}

/**
 * Isotropic seamless noise via a 4D torus mapping.
 *
 * The unit square is wrapped onto the surface of a 4D torus
 * (cos u, sin u, cos v, sin v) so periodicity is exact *and* there is no
 * mirroring — this kills the faint axis-aligned grid you can see in plain
 * Perlin at low frequencies. ~2× the cost of {@link perlin2}.
 *
 * @param {number} u [0,1) @param {number} v [0,1)
 * @param {number} freq cells across the tile
 */
export function torusNoise(u, v, freq, seed = 0) {
  const TAU = Math.PI * 2;
  const r = Math.max(0.5, freq / TAU);
  const a = u * TAU, b = v * TAU;
  return perlin4(Math.cos(a) * r, Math.sin(a) * r, Math.cos(b) * r, Math.sin(b) * r, seed);
}

/** fBm built on {@link torusNoise}. Perfectly seamless and isotropic. */
export function torusFbm(u, v, freq, octaves = 4, gain = 0.5, seed = 0) {
  let amp = 1, sum = 0, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * torusNoise(u, v, f, seed + i * 1013);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

// ── fBm and friends ────────────────────────────────────────────────────────

/**
 * Fractional Brownian motion over periodic 2D Perlin. Result ≈ [-1,1].
 * Positional (fast) form — no options object, safe in per-pixel loops.
 *
 * @param {number} u normalised x
 * @param {number} v normalised y
 * @param {number} period base cells across the tile
 * @param {number} octaves
 * @param {number} lacunarity
 * @param {number} gain
 * @param {number} seed
 */
export function fbm2p(u, v, period, octaves, lacunarity, gain, seed) {
  let amp = 1, sum = 0, norm = 0;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    // Round the period so every octave stays exactly periodic.
    const pi = Math.max(1, Math.round(p));
    sum += amp * perlin2(u * pi, v * pi, pi, pi, seed + i * 1013);
    norm += amp;
    amp *= gain;
    p *= lacunarity;
  }
  return sum / norm;
}

/**
 * **Anisotropic** periodic fBm — different base frequency per axis.
 *
 * Use this instead of pre-multiplying the coordinates (`fbm2p(u*0.5, v*9, …)`
 * silently breaks tiling, because the seam jump no longer lands on a lattice
 * period). Pass normalised u,v and let the function scale.
 *
 * @param {number} u normalised x in [0,1)
 * @param {number} v normalised y in [0,1)
 * @param {number} px base cells across the tile in x (integer ≥ 1)
 * @param {number} py base cells across the tile in y (integer ≥ 1)
 */
export function fbm2ap(u, v, px, py, octaves, lacunarity, gain, seed) {
  let amp = 1, sum = 0, norm = 0;
  let a = px, b = py;
  for (let i = 0; i < octaves; i++) {
    const ai = Math.max(1, Math.round(a));
    const bi = Math.max(1, Math.round(b));
    sum += amp * perlin2(u * ai, v * bi, ai, bi, seed + i * 1013);
    norm += amp;
    amp *= gain;
    a *= lacunarity; b *= lacunarity;
  }
  return sum / norm;
}

/** Object-options wrapper around {@link fbm2p}. */
export function fbm2(u, v, o = {}) {
  return fbm2p(u, v, o.period ?? 8, o.octaves ?? 4, o.lacunarity ?? 2, o.gain ?? 0.5, o.seed ?? 0);
}

/** Absolute-value ("turbulence") fBm — creases and puffy cloud shapes. [0,1] */
export function turbulence2p(u, v, period, octaves, lacunarity, gain, seed) {
  let amp = 1, sum = 0, norm = 0;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    const pi = Math.max(1, Math.round(p));
    sum += amp * Math.abs(perlin2(u * pi, v * pi, pi, pi, seed + i * 1013));
    norm += amp;
    amp *= gain;
    p *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp crests, great for plaster, bark, rock, ice. [0,1] */
export function ridged2p(u, v, period, octaves, lacunarity, gain, seed, sharpness = 2) {
  let amp = 1, sum = 0, norm = 0, prev = 1;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    const pi = Math.max(1, Math.round(p));
    let n = 1 - Math.abs(perlin2(u * pi, v * pi, pi, pi, seed + i * 1013));
    n = Math.pow(n, sharpness);
    sum += amp * n * prev;
    prev = 0.6 + 0.4 * n;          // feedback: crests reinforce
    norm += amp;
    amp *= gain;
    p *= lacunarity;
  }
  return sum / norm;
}

/** Billowy noise (|n| with a soft floor) — pebbles, clouds, foam. [0,1] */
export function billow2p(u, v, period, octaves, lacunarity, gain, seed) {
  return turbulence2p(u, v, period, octaves, lacunarity, gain, seed);
}

/** Animated periodic fBm: identical tiling in u/v, evolving in `t`. */
export function fbm3p(u, v, t, period, tPeriod, octaves, lacunarity, gain, seed) {
  let amp = 1, sum = 0, norm = 0;
  let p = period, tp = tPeriod;
  for (let i = 0; i < octaves; i++) {
    const pi = Math.max(1, Math.round(p));
    const tpi = Math.max(1, Math.round(tp));
    sum += amp * perlin3(u * pi, v * pi, t * tpi, pi, pi, tpi, seed + i * 1013);
    norm += amp;
    amp *= gain;
    p *= lacunarity;
    tp *= lacunarity;
  }
  return sum / norm;
}

// ── Domain warping ─────────────────────────────────────────────────────────

/** Shared scratch — consume the result immediately, never store it. */
const _warp = { u: 0, v: 0 };

/**
 * Seamless domain warp. Offsets (u,v) by a low-frequency noise vector, then
 * (optionally) again by a second pass for that gooey Inigo Quilez look.
 * The warp offsets are themselves periodic so the tile survives.
 *
 * @returns {{u:number, v:number}} shared scratch object
 */
export function warp2(u, v, amount = 0.12, period = 3, seed = 0, passes = 1, octaves = 3) {
  let wu = u, wv = v;
  let amp = amount, p = period;
  for (let i = 0; i < passes; i++) {
    const dx = fbm2p(wu, wv, p, octaves, 2, 0.5, seed + i * 3301);
    const dy = fbm2p(wu, wv, p, octaves, 2, 0.5, seed + 7717 + i * 3301);
    wu += dx * amp;
    wv += dy * amp;
    amp *= 0.5;
    p *= 2;
  }
  _warp.u = wu;
  _warp.v = wv;
  return _warp;
}

/** Just the x component of a warp (when you only need one axis). */
export function warpX(u, v, amount, period, seed) {
  return u + fbm2p(u, v, period, 3, 2, 0.5, seed) * amount;
}

/** Just the y component of a warp. */
export function warpY(u, v, amount, period, seed) {
  return v + fbm2p(u, v, period, 3, 2, 0.5, seed + 7717) * amount;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Remap a [-1,1] noise value to [0,1]. */
export const unorm = (n) => n * 0.5 + 0.5;

/** Contrast around 0.5. `k` > 1 hardens, < 1 softens. */
export function contrast(v, k) {
  return Math.max(0, Math.min(1, (v - 0.5) * k + 0.5));
}

/** Smooth threshold: 0 below `a`, 1 above `b`. */
export function sstep(a, b, x) {
  if (b === a) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Distance to the nearest of the two tile edges along one axis, in [0,0.5]. */
export function edgeDist01(t) {
  const w = t - Math.floor(t);
  return w < 0.5 ? w : 1 - w;
}
