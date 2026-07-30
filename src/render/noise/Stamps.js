/**
 * Wrap-around "stamps": procedural wear passes that are *drawn* into a
 * {@link Field} rather than evaluated per-pixel.
 *
 * Drawing is far cheaper than evaluating a scratch field analytically, and
 * because every write wraps modulo the field size the results tile perfectly —
 * a scratch that runs off the right edge continues on the left.
 *
 * All of these take an `RNG` from core/MathUtils so the same seed always
 * produces the same wear pattern.
 */

import { Field } from './Field.js';
import { fbm2p } from './Perlin.js';

const TAU = Math.PI * 2;

/** Blend modes for stamping. */
export const ADD = 0, MAX = 1, SET = 2, MUL = 3, MIN = 4;

function blend(field, x, y, v, mode) {
  const n = field.size;
  let xi = x % n; if (xi < 0) xi += n;
  let yi = y % n; if (yi < 0) yi += n;
  const i = yi * n + xi;
  const d = field.data;
  switch (mode) {
    case MAX: if (v > d[i]) d[i] = v; break;
    case MIN: if (v < d[i]) d[i] = v; break;
    case SET: d[i] = v; break;
    case MUL: d[i] *= v; break;
    default: d[i] += v;
  }
}

/**
 * Soft round dab with a smooth falloff. `radius` in texels.
 * `hardness` 0 = pure gaussian-ish, 1 = hard disc.
 */
export function stampDisc(field, cx, cy, radius, value, hardness = 0.35, mode = ADD) {
  const r = Math.max(0.5, radius);
  const r2 = r * r;
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  const inner = hardness;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = Math.sqrt(d2) / r;
      let a = 1 - t;
      if (inner < 1) {
        const k = (1 - t) / Math.max(1e-4, 1 - inner);
        a = k < 1 ? k * k * (3 - 2 * k) : 1;
      }
      if (mode === MUL) blend(field, x, y, 1 - (1 - value) * a, mode);
      else blend(field, x, y, value * a, mode);
    }
  }
}

/**
 * Anti-aliased wrapped line with a soft, optionally tapering profile.
 * @param {number} width half-width in texels
 * @param {number} taper 0 = constant width, 1 = comes to a point at both ends
 */
export function stampLine(field, x0, y0, x1, y1, width, value, mode = ADD, taper = 0, jitter = 0, rng = null) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) { stampDisc(field, x0, y0, width, value, 0.4, mode); return; }
  const steps = Math.ceil(len * 1.35);
  const inv = 1 / steps;
  for (let s = 0; s <= steps; s++) {
    const t = s * inv;
    let px = x0 + dx * t, py = y0 + dy * t;
    if (jitter && rng) {
      const nx = -dy / len, ny = dx / len;
      const j = (rng.next() - 0.5) * jitter;
      px += nx * j; py += ny * j;
    }
    const env = taper > 0
      ? Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), taper)
      : 1;
    stampDisc(field, px, py, width * (0.4 + 0.6 * env), value * env, 0.15, mode);
  }
}

/**
 * Fine scratches: short, mostly-parallel scored lines. The bread and butter of
 * worn plastic, brushed metal, scuffed varnish and old glass.
 *
 * @param {Field} field
 * @param {import('../../core/MathUtils.js').RNG} rng
 * @param {object} o
 * @param {number} [o.count]
 * @param {number} [o.minLen] fraction of the tile
 * @param {number} [o.maxLen]
 * @param {number} [o.width] half-width in texels
 * @param {number} [o.depth] value written (negative to carve)
 * @param {number} [o.angle] mean direction in radians
 * @param {number} [o.spread] angular spread in radians
 * @param {number} [o.curve] how much each scratch bends
 * @param {number} [o.mode]
 */
export function stampScratches(field, rng, o = {}) {
  const n = field.size;
  const count = o.count ?? 60;
  const minLen = (o.minLen ?? 0.05) * n;
  const maxLen = (o.maxLen ?? 0.35) * n;
  const width = o.width ?? 0.6;
  const depth = o.depth ?? -0.06;
  const angle = o.angle ?? 0;
  const spread = o.spread ?? 0.5;
  const curve = o.curve ?? 0.15;
  const mode = o.mode ?? ADD;
  const segs = 6;

  for (let i = 0; i < count; i++) {
    let x = rng.next() * n, y = rng.next() * n;
    let a = angle + (rng.next() - 0.5) * 2 * spread;
    const len = minLen + rng.next() * (maxLen - minLen);
    const w = width * (0.4 + rng.next() * 1.2);
    const d = depth * (0.35 + rng.next() * 0.9);
    const segLen = len / segs;
    for (let s = 0; s < segs; s++) {
      const nx = x + Math.cos(a) * segLen;
      const ny = y + Math.sin(a) * segLen;
      const env = Math.sin(Math.PI * ((s + 0.5) / segs));
      stampLine(field, x, y, nx, ny, w, d * (0.35 + 0.65 * env), mode, 0);
      x = nx; y = ny;
      a += (rng.next() - 0.5) * curve;
    }
  }
  return field;
}

/**
 * Long soft streaks — rain runs on glass, grime dripping down a wall, the
 * directional smear of a mop on lino. Streaks travel along `angle` and fade.
 */
export function stampStreaks(field, rng, o = {}) {
  const n = field.size;
  const count = o.count ?? 24;
  const minLen = (o.minLen ?? 0.2) * n;
  const maxLen = (o.maxLen ?? 0.8) * n;
  const width = o.width ?? 3;
  const value = o.value ?? 0.08;
  const angle = o.angle ?? Math.PI / 2;
  const spread = o.spread ?? 0.08;
  const wobble = o.wobble ?? 2.0;
  const mode = o.mode ?? ADD;

  for (let i = 0; i < count; i++) {
    let x = rng.next() * n, y = rng.next() * n;
    const a = angle + (rng.next() - 0.5) * 2 * spread;
    const len = minLen + rng.next() * (maxLen - minLen);
    const w = width * (0.35 + rng.next() * 1.4);
    const v = value * (0.3 + rng.next());
    const steps = Math.max(8, Math.ceil(len / 2));
    const ca = Math.cos(a), sa = Math.sin(a);
    const phase = rng.next() * TAU;
    for (let s = 0; s < steps; s++) {
      const t = s / (steps - 1);
      const fall = Math.pow(1 - t, 0.7) * Math.min(1, t * 8);
      const off = Math.sin(phase + t * 6) * wobble;
      const px = x + ca * len * t - sa * off;
      const py = y + sa * len * t + ca * off;
      stampDisc(field, px, py, w * (0.6 + 0.4 * fall), v * fall, 0.0, mode);
    }
  }
  return field;
}

/**
 * Dust / dirt overlay: a lot of tiny soft blobs clustered by a low-frequency
 * mask, so grime pools in patches instead of spreading evenly.
 *
 * @returns {Field} the same field, for chaining
 */
export function stampDust(field, rng, o = {}) {
  const n = field.size;
  const count = o.count ?? 900;
  const minR = o.minRadius ?? 0.8;
  const maxR = o.maxRadius ?? 5;
  const value = o.value ?? 0.05;
  const clumpFreq = Math.max(1, Math.round(o.clumpFreq ?? 4));
  const clumpBias = o.clumpBias ?? 0.75;
  const seed = o.seed ?? 1;
  const mode = o.mode ?? ADD;

  let placed = 0, guard = 0;
  while (placed < count && guard < count * 12) {
    guard++;
    const x = rng.next() * n, y = rng.next() * n;
    const m = fbm2p(x / n, y / n, clumpFreq, 3, 2, 0.5, seed) * 0.5 + 0.5;
    if (rng.next() > (1 - clumpBias) + clumpBias * m) continue;
    const r = minR + Math.pow(rng.next(), 2.2) * (maxR - minR);
    stampDisc(field, x, y, r, value * (0.3 + rng.next() * 1.1), 0.0, mode);
    placed++;
  }
  return field;
}

/** Hard tiny specks — grit in concrete, pigment in plastic, sugar, sand. */
export function stampSpeckle(field, rng, o = {}) {
  const n = field.size;
  const count = o.count ?? 3000;
  const minR = o.minRadius ?? 0.5;
  const maxR = o.maxRadius ?? 1.6;
  const value = o.value ?? 0.12;
  const bipolar = o.bipolar ?? false;
  const mode = o.mode ?? ADD;
  for (let i = 0; i < count; i++) {
    const x = rng.next() * n, y = rng.next() * n;
    const r = minR + rng.next() * (maxR - minR);
    const v = bipolar ? (rng.next() < 0.5 ? -value : value) : value;
    stampDisc(field, x, y, r, v * (0.4 + rng.next()), 0.75, mode);
  }
  return field;
}

/** Scattered soft blobs of a given size range — pebbles, stains, patches. */
export function stampBlobs(field, rng, o = {}) {
  const n = field.size;
  const count = o.count ?? 120;
  const minR = (o.minRadius ?? 0.01) * n;
  const maxR = (o.maxRadius ?? 0.06) * n;
  const value = o.value ?? 0.2;
  const hardness = o.hardness ?? 0.1;
  const mode = o.mode ?? ADD;
  for (let i = 0; i < count; i++) {
    const x = rng.next() * n, y = rng.next() * n;
    const r = minR + Math.pow(rng.next(), 1.6) * (maxR - minR);
    stampDisc(field, x, y, r, value * (0.4 + rng.next() * 1.2), hardness, mode);
  }
  return field;
}

/**
 * Branching crack network grown by random walk. Unlike Voronoi cracks these
 * look *impact* driven — a chip in varnish, a star crack in a windscreen.
 *
 * @param {object} o
 * @param {number} [o.origins] number of independent crack systems
 * @param {number} [o.branches] branches per origin
 * @param {number} [o.length] mean branch length as a fraction of the tile
 * @param {number} [o.width] half-width in texels
 * @param {number} [o.depth]
 * @param {number} [o.split] probability a branch spawns a child
 */
export function stampCracks(field, rng, o = {}) {
  const n = field.size;
  const origins = o.origins ?? 3;
  const branches = o.branches ?? 5;
  const meanLen = (o.length ?? 0.25) * n;
  const width = o.width ?? 0.8;
  const depth = o.depth ?? -0.12;
  const split = o.split ?? 0.35;
  const mode = o.mode ?? MIN;
  const maxDepthLevel = o.levels ?? 3;

  const grow = (x, y, a, len, w, level) => {
    const segs = Math.max(3, Math.round(len / 4));
    const segLen = len / segs;
    for (let s = 0; s < segs; s++) {
      const t = s / segs;
      const nx = x + Math.cos(a) * segLen;
      const ny = y + Math.sin(a) * segLen;
      const taperW = w * (1 - t * 0.75);
      const v = depth * (1 - t * 0.6);
      if (mode === MIN) stampLine(field, x, y, nx, ny, taperW, v, ADD, 0);
      else stampLine(field, x, y, nx, ny, taperW, v, mode, 0);
      x = nx; y = ny;
      a += (rng.next() - 0.5) * 0.55;
      if (level < maxDepthLevel && rng.next() < split / segs * 3) {
        grow(x, y, a + (rng.next() < 0.5 ? -1 : 1) * (0.5 + rng.next() * 0.7),
          len * (0.35 + rng.next() * 0.3), w * 0.65, level + 1);
      }
    }
  };

  for (let i = 0; i < origins; i++) {
    const ox = rng.next() * n, oy = rng.next() * n;
    const base = rng.next() * TAU;
    const bn = Math.max(2, Math.round(branches * (0.6 + rng.next() * 0.8)));
    for (let b = 0; b < bn; b++) {
      const a = base + (b / bn) * TAU + (rng.next() - 0.5) * 0.6;
      grow(ox, oy, a, meanLen * (0.5 + rng.next()), width * (0.7 + rng.next() * 0.8), 0);
    }
  }
  return field;
}

/**
 * Chipped-edge / paint-loss mask: soft bites taken out along high-curvature
 * areas of a guide field.
 */
export function stampChips(field, rng, o = {}) {
  const n = field.size;
  const count = o.count ?? 40;
  const minR = (o.minRadius ?? 0.004) * n;
  const maxR = (o.maxRadius ?? 0.02) * n;
  const value = o.value ?? 1;
  const guide = o.guide ?? null;
  const threshold = o.threshold ?? 0.5;
  const mode = o.mode ?? MAX;

  let placed = 0, guard = 0;
  while (placed < count && guard < count * 20) {
    guard++;
    const x = rng.next() * n, y = rng.next() * n;
    if (guide) {
      const g = guide.get(Math.floor(x), Math.floor(y));
      if (g < threshold * rng.next() + threshold * 0.4) continue;
    }
    const r = minR + Math.pow(rng.next(), 1.8) * (maxR - minR);
    // Irregular chip: 3 overlapping discs.
    for (let k = 0; k < 3; k++) {
      stampDisc(field,
        x + (rng.next() - 0.5) * r * 1.2,
        y + (rng.next() - 0.5) * r * 1.2,
        r * (0.5 + rng.next() * 0.7), value, 0.6, mode);
    }
    placed++;
  }
  return field;
}

/** Wrapped filled rectangle (axis-aligned) — panel insets, labels, stickers. */
export function stampRect(field, x0, y0, w, h, value, soft = 1, mode = SET) {
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
      let a = 1;
      if (soft > 0) {
        const ex = Math.min(x - x0, x0 + w - x);
        const ey = Math.min(y - y0, y0 + h - y);
        const e = Math.min(ex, ey);
        a = Math.max(0, Math.min(1, e / soft));
        a = a * a * (3 - 2 * a);
      }
      if (a <= 0) continue;
      if (mode === SET) {
        const n = field.size;
        let xi = x % n; if (xi < 0) xi += n;
        let yi = y % n; if (yi < 0) yi += n;
        const i = yi * n + xi;
        field.data[i] += (value - field.data[i]) * a;
      } else {
        blend(field, x, y, value * a, mode);
      }
    }
  }
  return field;
}

/** Convenience: brand-new empty field of the same size. */
export function likeField(field, fill = 0) {
  const f = new Field(field.size);
  if (fill !== 0) f.data.fill(fill);
  return f;
}
