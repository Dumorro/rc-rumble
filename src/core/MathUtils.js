/** Shared math helpers + deterministic RNG + noise. No three.js dependency. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const sq = (v) => v * v;

/** Frame-rate independent exponential smoothing. `rate` = 1/e time constant. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** Move `a` toward `b` by at most `maxDelta`. */
export function moveToward(a, b, maxDelta) {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

/** Shortest signed angular difference b - a, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Apply a symmetric deadzone then rescale to full range. */
export function deadzone(v, dz) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/** Critically-damped spring toward target. Mutates and returns [value, velocity]. */
export function springDamp(value, velocity, target, stiffness, damping, dt) {
  const f = -stiffness * (value - target) - damping * velocity;
  velocity += f * dt;
  value += velocity * dt;
  return [value, velocity];
}

// ────────────────────────────────────────────────────────────── RNG

/** Deterministic 32-bit PRNG (mulberry32). Same seed → same sequence, always. */
export class RNG {
  constructor(seed = 1) { this.seed(seed); }

  seed(s) {
    this._s = (typeof s === 'string' ? hashString(s) : s | 0) >>> 0;
    if (this._s === 0) this._s = 0x9e3779b9;
    return this;
  }

  /** [0,1) */
  next() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }

  /** Box-Muller, mean 0 stddev 1. */
  gaussian() {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ────────────────────────────────────────────────────────────── Noise

/** Classic 3D simplex-ish value noise with analytic-free fBm. Fast, seedable. */
export class ValueNoise {
  constructor(seed = 1) {
    const rng = new RNG(seed);
    this.p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    rng.shuffle(perm);
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  _grad(hash, x, y, z) {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  /** Perlin-style gradient noise in [-1,1]. */
  noise3(x, y, z) {
    const p = this.p;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = smootherstep(x), v = smootherstep(y), w = smootherstep(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const g = this._grad;
    return lerp(
      lerp(
        lerp(g(p[AA], x, y, z), g(p[BA], x - 1, y, z), u),
        lerp(g(p[AB], x, y - 1, z), g(p[BB], x - 1, y - 1, z), u), v),
      lerp(
        lerp(g(p[AA + 1], x, y, z - 1), g(p[BA + 1], x - 1, y, z - 1), u),
        lerp(g(p[AB + 1], x, y - 1, z - 1), g(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w);
  }

  noise2(x, y) { return this.noise3(x, y, 0.371); }

  /** Fractional Brownian motion. Returns roughly [-1,1]. */
  fbm(x, y, z = 0, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Billowy ridged noise — good for cloth, plaster, bark. */
  ridged(x, y, z = 0, octaves = 4) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise3(x * freq, y * freq, z * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  }
}

/** Worley / cellular noise — returns { f1, f2, cellId }. Great for tiles, cracks, scales. */
export function worley2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = Infinity, f2 = Infinity, cell = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const h = hashString(`${cx},${cy},${seed}`);
      const px = cx + ((h & 0xffff) / 65536);
      const py = cy + (((h >>> 16) & 0xffff) / 65536);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; cell = h; }
      else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2, cellId: cell };
}

// ────────────────────────────────────────────────────────────── Curves

/** Catmull-Rom interpolation of scalars. */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Piecewise-linear lookup table with clamped ends. `pts` = [[x,y], ...] ascending x. */
export function curveLookup(pts, x) {
  if (x <= pts[0][0]) return pts[0][1];
  const last = pts[pts.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return last[1];
}

/** Exponential-decay running average for telemetry/UI smoothing. */
export class Smoothed {
  constructor(value = 0, rate = 8) { this.value = value; this.rate = rate; }
  update(target, dt) { this.value = damp(this.value, target, this.rate, dt); return this.value; }
  set(v) { this.value = v; return v; }
}
