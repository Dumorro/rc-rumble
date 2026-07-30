/**
 * RC RUMBLE — procedural PBR texture factory.
 *
 * Zero assets. Every material family below is generated from noise, patterns
 * and canvas 2D drawing, then packed into a standard PBR set:
 *
 *   { map, normalMap, roughnessMap, metalnessMap, aoMap, ormMap,
 *     emissiveMap?, height (Float32Array), size, def }
 *
 * Roughness / metalness / AO share ONE packed **ORM** texture (R = ambient
 * occlusion, G = roughness, B = metalness) — exactly the glTF convention, and
 * exactly the channels three.js reads. One upload, three slots.
 *
 * Pipeline per family:
 *   1. `paint`   — per-texel base pass (albedo, height, roughness, metalness)
 *   2. `overlay` — optional canvas 2D pass drawn on top (printed graphics,
 *                  lane paint, signage). Its alpha becomes an "ink" mask that
 *                  also modulates roughness/height.
 *   3. `post`    — optional stamp/filter wear pass (scratches, dust, cracks)
 *   4. derive    — Sobel normal map + multi-tap AO from the height field
 *
 * Everything tiles seamlessly. Everything is cached in `game.assets`.
 */

import * as THREE from 'three';
import { q } from '../core/Config.js';
import { RNG, clamp01, lerp } from '../core/MathUtils.js';
import * as N from './noise/index.js';

const TAU = Math.PI * 2;
const frac = (x) => x - Math.floor(x);
const sat = clamp01;

// ─────────────────────────────────────────────────────────── resolution

/** Base texture edge length per quality tier. */
export const RES_BY_QUALITY = { low: 256, medium: 512, high: 1024, ultra: 2048 };

/**
 * Quality-scaled texture size, snapped to a multiple of 64.
 * @param {number} [scale] per-family multiplier (0.25 … 1)
 */
export function texSize(scale = 1) {
  const base = q(RES_BY_QUALITY) ?? 512;
  const s = Math.round((base * scale) / 64) * 64;
  return Math.max(64, Math.min(2048, s));
}

// ─────────────────────────────────────────────────────────── colour utils

/** Unpack 0xRRGGBB into an [r,g,b] float triple (sRGB display values). */
export function hexRGB(h, out = [0, 0, 0]) {
  out[0] = ((h >> 16) & 255) / 255;
  out[1] = ((h >> 8) & 255) / 255;
  out[2] = (h & 255) / 255;
  return out;
}

export function mixRGB(a, b, t, out = [0, 0, 0]) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function scaleRGB(a, k, out = [0, 0, 0]) {
  out[0] = a[0] * k; out[1] = a[1] * k; out[2] = a[2] * k;
  return out;
}

/** HSL → RGB, all inputs in [0,1]. */
export function hslRGB(h, s, l, out = [0, 0, 0]) {
  h = frac(h);
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  const seg = Math.floor(h * 6);
  if (seg === 0) { r = c; g = x; }
  else if (seg === 1) { r = x; g = c; }
  else if (seg === 2) { g = c; b = x; }
  else if (seg === 3) { g = x; b = c; }
  else if (seg === 4) { r = x; b = c; }
  else { r = c; b = x; }
  out[0] = r + m; out[1] = g + m; out[2] = b + m;
  return out;
}

/** Perceptual luminance of an sRGB triple. */
export const lum = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

/** CSS colour string from a float triple. */
export const css = (c, a = 1) =>
  `rgba(${Math.round(sat(c[0]) * 255)},${Math.round(sat(c[1]) * 255)},${Math.round(sat(c[2]) * 255)},${a})`;

// Scratch colour registers — painters reuse these, never allocate per texel.
const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0], _d = [0, 0, 0], _e = [0, 0, 0];
const _t = [0, 0, 0], _t2 = [0, 0, 0];

/** Fill a scratch triple. */
function rgb3(r, g, b, out = _t) { out[0] = r; out[1] = g; out[2] = b; return out; }
/** Fill a scratch triple with one grey level. */
function grey3(v, out = _t) { out[0] = v; out[1] = v; out[2] = v; return out; }

// ─────────────────────────────────────────────────────────── the bake buffer

/**
 * Working set for one material build. Holds the albedo plus every scalar
 * channel we need, all at the same resolution.
 */
export class Bake {
  constructor(size) {
    this.size = size | 0;
    this.n2 = this.size * this.size;
    /** Height field, [0,1]. Drives the normal map, AO and displacement. */
    this.height = new N.Field(this.size);
    /** Interleaved RGB, sRGB display values in [0,1]. */
    this.rgb = new Float32Array(this.n2 * 3);
    /** Roughness field, [0,1]. */
    this.rough = new N.Field(this.size);
    this.rough.data.fill(0.6);
    this._metal = null;
    this._alpha = null;
    this._emis = null;
    this._ao = null;
    /** Physical relief of the height field relative to the tile — tunes AO. */
    this.heightScale = 0.25;
    /** Normal map strength multiplier. */
    this.normalStrength = 1;
  }

  /** Lazily allocated metalness field (defaults to 0 = dielectric). */
  get metal() {
    if (!this._metal) this._metal = new N.Field(this.size);
    return this._metal;
  }
  hasMetal() { return this._metal !== null; }

  /** Lazily allocated alpha field (defaults to 1 = opaque). */
  get alpha() {
    if (!this._alpha) { this._alpha = new N.Field(this.size); this._alpha.data.fill(1); }
    return this._alpha;
  }
  hasAlpha() { return this._alpha !== null; }

  /** Lazily allocated emissive RGB. */
  get emissive() {
    if (!this._emis) this._emis = new Float32Array(this.n2 * 3);
    return this._emis;
  }
  hasEmissive() { return this._emis !== null; }

  /** Override the derived AO with your own field. */
  setAO(field) { this._ao = field; return field; }
  getAO() { return this._ao; }

  /** Walk every texel: `fn(u, v, i, x, y)`. */
  each(fn) {
    const n = this.size, inv = 1 / n;
    let i = 0;
    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < n; x++, i++) fn((x + 0.5) * inv, v, i, x, y);
    }
    return this;
  }

  /** Write albedo at linear index `i`. */
  set(i, r, g, b) {
    const j = i * 3;
    this.rgb[j] = r; this.rgb[j + 1] = g; this.rgb[j + 2] = b;
    return this;
  }

  /** Write albedo at `i` from a float triple. */
  setC(i, c) {
    const j = i * 3;
    this.rgb[j] = c[0]; this.rgb[j + 1] = c[1]; this.rgb[j + 2] = c[2];
    return this;
  }

  /** Multiply the albedo at `i`. */
  mulAt(i, k) {
    const j = i * 3;
    this.rgb[j] *= k; this.rgb[j + 1] *= k; this.rgb[j + 2] *= k;
    return this;
  }

  /** Read albedo into `out`. */
  getC(i, out = _e) {
    const j = i * 3;
    out[0] = this.rgb[j]; out[1] = this.rgb[j + 1]; out[2] = this.rgb[j + 2];
    return out;
  }

  /** Multiply the whole albedo by a tint colour. */
  tint(colorHex) {
    if (colorHex == null) return this;
    const t = hexRGB(colorHex, _a);
    const d = this.rgb;
    for (let i = 0; i < d.length; i += 3) {
      d[i] *= t[0]; d[i + 1] *= t[1]; d[i + 2] *= t[2];
    }
    return this;
  }

  /**
   * Replace hue/saturation while keeping the generated luminance detail.
   * Much better than a flat multiply when recolouring toys and car parts.
   */
  recolor(colorHex, keep = 0.35) {
    if (colorHex == null) return this;
    const t = hexRGB(colorHex, _a);
    const tl = Math.max(0.02, lum(t));
    const d = this.rgb;
    for (let i = 0; i < d.length; i += 3) {
      const l = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
      const k = l / tl;
      d[i] = lerp(t[0] * k, d[i], keep);
      d[i + 1] = lerp(t[1] * k, d[i + 1], keep);
      d[i + 2] = lerp(t[2] * k, d[i + 2], keep);
    }
    return this;
  }
}

// ─────────────────────────────────────────────────────────── canvas helpers

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

/**
 * Run `fn(ctx)` nine times with ±size translations so anything drawn near an
 * edge reappears on the opposite side. The cheap, bulletproof way to keep
 * canvas-drawn motifs seamless.
 */
export function tileDraw(ctx, size, fn) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      ctx.save();
      ctx.translate(dx * size, dy * size);
      fn(ctx);
      ctx.restore();
    }
  }
}

/** Rounded rectangle path. */
export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  return ctx;
}

/** Regular polygon / star path. */
export function starPath(ctx, cx, cy, points, rOuter, rInner, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i & 1 ? rInner : rOuter;
    const a = rot + (i / (points * 2)) * TAU;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  return ctx;
}

/** Petal / teardrop path used by the floral wallpaper. */
function petalPath(ctx, cx, cy, len, wide, angle) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wide, -len * 0.35, wide * 0.7, -len * 0.9, 0, -len);
  ctx.bezierCurveTo(-wide * 0.7, -len * 0.9, -wide, -len * 0.35, 0, 0);
  ctx.closePath();
  ctx.restore();
  return ctx;
}

// ─────────────────────────────────────────────────────────── vector font

/**
 * A single-stroke geometric font drawn entirely from polylines — no font
 * files, no reliance on whatever the OS happens to have installed.
 *
 * Glyphs live on a 6 × 10 grid, y down. Polylines are separated by `|`,
 * points by a space, coordinates by a comma.
 */
const GLYPHS = {
  A: '0,10 3,0 6,10|1.1,6.6 4.9,6.6',
  B: '0,0 0,10|0,0 4,0 5.2,1.1 5.2,3.7 4,5 0,5|0,5 4.4,5 5.7,6.2 5.7,8.7 4.4,10 0,10',
  C: '6,2 5,0.7 3.4,0 1.9,0.5 0.6,2.2 0,5 0.6,7.8 1.9,9.5 3.4,10 5,9.3 6,8',
  D: '0,0 0,10|0,0 3.4,0 5.3,1.7 6,5 5.3,8.3 3.4,10 0,10',
  E: '6,0 0,0 0,10 6,10|0,5 4.6,5',
  F: '6,0 0,0 0,10|0,5 4.6,5',
  G: '6,2 4.6,0.5 3,0 1.4,0.7 0.4,2.5 0,5 0.4,7.6 1.6,9.4 3.4,10 5,9.3 6,7.9 6,5.6 3.4,5.6',
  H: '0,0 0,10|6,0 6,10|0,5 6,5',
  I: '1,0 5,0|3,0 3,10|1,10 5,10',
  J: '5,0 5,7.5 4.2,9.4 2.6,10 1,9.4 0.2,7.8',
  K: '0,0 0,10|6,0 0.6,5.6|2.2,4.2 6,10',
  L: '0,0 0,10 5.6,10',
  M: '0,10 0,0 3,5.6 6,0 6,10',
  N: '0,10 0,0 6,10 6,0',
  O: '3,0 1.3,0.8 0.2,3 0.2,7 1.3,9.2 3,10 4.7,9.2 5.8,7 5.8,3 4.7,0.8 3,0',
  P: '0,10 0,0 4.2,0 5.8,1.4 5.8,4 4.2,5.4 0,5.4',
  Q: '3,0 1.3,0.8 0.2,3 0.2,7 1.3,9.2 3,10 4.7,9.2 5.8,7 5.8,3 4.7,0.8 3,0|3.6,7.4 6.2,10.6',
  R: '0,10 0,0 4.2,0 5.8,1.4 5.8,4 4.2,5.4 0,5.4|2.6,5.4 6,10',
  S: '6,1.6 4.6,0.2 2.4,0 0.8,0.9 0.2,2.6 1,4.2 3,5 4.8,5.7 5.9,7.1 5.5,9 3.7,10 1.6,9.8 0,8.4',
  T: '0,0 6,0|3,0 3,10',
  U: '0,0 0,7 1,9.2 3,10 5,9.2 6,7 6,0',
  V: '0,0 3,10 6,0',
  W: '0,0 1.4,10 3,3.6 4.6,10 6,0',
  X: '0,0 6,10|6,0 0,10',
  Y: '0,0 3,5 6,0|3,5 3,10',
  Z: '0,0 6,0 0,10 6,10',
  0: '3,0 1.3,0.8 0.2,3 0.2,7 1.3,9.2 3,10 4.7,9.2 5.8,7 5.8,3 4.7,0.8 3,0|4.8,2.2 1.2,7.8',
  1: '1,2 3,0 3,10|1,10 5,10',
  2: '0.2,2 1.4,0.4 3.4,0 5.2,0.9 5.8,2.7 5,4.7 0.2,10 6,10',
  3: '0.4,1 2.4,0 4.6,0.4 5.6,2 4.6,4.4 2.6,5|2.6,5 4.8,5.6 5.8,7.4 5,9.2 2.8,10 0.6,9.2 0,8',
  4: '4.4,10 4.4,0 0,7.2 6,7.2',
  5: '5.6,0 1,0 0.4,4.4 2.6,3.8 4.8,4.4 5.8,6.4 5.2,8.8 3,10 0.8,9.4 0,8.2',
  6: '5.4,0.6 3.4,0 1.4,1 0.3,4 0.2,7 1.2,9.2 3.2,10 5,9.2 5.8,7.2 5,5.4 3,4.8 1,5.4 0.3,6.6',
  7: '0,0 6,0 2.4,10',
  8: '3,5 1.2,4.2 0.4,2.6 1.2,0.8 3,0 4.8,0.8 5.6,2.6 4.8,4.2 3,5 1,5.8 0.2,7.6 1.2,9.4 3,10 4.8,9.4 5.8,7.6 5,5.8 3,5',
  9: '0.6,9.4 2.6,10 4.6,9 5.7,6 5.8,3 4.8,0.8 2.8,0 1,0.8 0.2,2.8 1,4.6 3,5.2 5,4.6 5.7,3.4',
  '-': '1,5 5,5',
  '+': '1,5 5,5|3,3 3,7',
  '.': '2.7,9.4 3.3,9.4 3.3,10 2.7,10 2.7,9.4',
  ',': '3.3,9.2 3.3,10 2.4,11',
  ':': '2.7,3.2 3.3,3.2|2.7,8.2 3.3,8.2',
  '!': '3,0 3,7|2.9,9.4 3.1,9.4',
  '?': '0.4,2 1.6,0.4 3.4,0 5.2,0.8 5.8,2.6 5,4.4 3,5.6 3,7|2.9,9.4 3.1,9.4',
  '/': '5.4,0 0.6,10',
  '&': '6,10 1.6,4.6 0.9,2.6 1.9,0.5 3.7,0.6 4.2,2.4 3,4.2 0.6,6.4 0.6,8.6 2.2,10 4,9.6 5.4,7.8',
  '*': '3,2 3,8|0.7,3.5 5.3,6.5|5.3,3.5 0.7,6.5',
  '%': '5.4,0 0.6,10|1,0.4 2,0.4 2,2.4 1,2.4 1,0.4|4,7.6 5,7.6 5,9.6 4,9.6 4,7.6',
  '#': '1.6,1 0.8,9|4.4,1 3.6,9|0.4,3.6 5.4,3.6|0.2,6.6 5.2,6.6',
  '(': '4.2,0 2,2.6 1.6,5 2,7.4 4.2,10',
  ')': '1.8,0 4,2.6 4.4,5 4,7.4 1.8,10',
  '"': '2,0.4 1.7,2.6|4,0.4 3.7,2.6',
  "'": '3,0.4 2.7,2.6',
  ' ': '',
};

let _parsedGlyphs = null;
function glyphPolys(ch) {
  if (!_parsedGlyphs) {
    _parsedGlyphs = new Map();
    for (const k in GLYPHS) {
      const src = GLYPHS[k];
      const polys = src
        ? src.split('|').map((p) => p.trim().split(/\s+/).map((pt) => {
          const [x, y] = pt.split(',');
          return [parseFloat(x), parseFloat(y)];
        }))
        : [];
      _parsedGlyphs.set(k, polys);
    }
  }
  return _parsedGlyphs.get(ch) ?? _parsedGlyphs.get('?');
}

/**
 * Draw stroke-font text. Returns the drawn width in pixels.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x left edge (or centre/right depending on `align`)
 * @param {number} y baseline-ish top of the cap height
 * @param {object} [o]
 * @param {number} [o.size] cap height in pixels
 * @param {number} [o.weight] stroke width as a fraction of the cap height
 * @param {number} [o.tracking] extra letter spacing in grid units
 * @param {string} [o.align] 'left' | 'center' | 'right'
 * @param {string} [o.color]
 * @param {number} [o.slant] italic shear
 */
export function drawVectorText(ctx, text, x, y, o = {}) {
  const size = o.size ?? 64;
  const weight = o.weight ?? 0.13;
  const tracking = o.tracking ?? 1.2;
  const align = o.align ?? 'left';
  const s = size / 10;
  const slant = o.slant ?? 0;

  const str = String(text).toUpperCase();
  let advance = 0;
  const widths = [];
  for (const ch of str) {
    const w = ch === ' ' ? 3.2 : 6;
    widths.push(w);
    advance += w + tracking;
  }
  advance -= tracking;
  const totalW = advance * s;

  let ox = x;
  if (align === 'center') ox = x - totalW * 0.5;
  else if (align === 'right') ox = x - totalW;

  ctx.save();
  ctx.strokeStyle = o.color ?? '#000';
  ctx.lineWidth = Math.max(1, size * weight);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (o.shadow) {
    ctx.shadowColor = o.shadow;
    ctx.shadowBlur = size * 0.12;
    ctx.shadowOffsetY = size * 0.04;
  }

  let cursor = 0;
  for (let i = 0; i < str.length; i++) {
    const polys = glyphPolys(str[i]);
    for (const poly of polys) {
      if (poly.length < 2) {
        if (poly.length === 1) {
          ctx.beginPath();
          const px = ox + (cursor + poly[0][0]) * s - poly[0][1] * s * slant;
          ctx.arc(px, y + poly[0][1] * s, ctx.lineWidth * 0.5, 0, TAU);
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fill();
        }
        continue;
      }
      ctx.beginPath();
      for (let k = 0; k < poly.length; k++) {
        const px = ox + (cursor + poly[k][0]) * s - poly[k][1] * s * slant;
        const py = y + poly[k][1] * s;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    cursor += widths[i] + tracking;
  }
  ctx.restore();
  return totalW;
}

/** Measured width of {@link drawVectorText} without drawing. */
export function measureVectorText(text, o = {}) {
  const size = o.size ?? 64;
  const tracking = o.tracking ?? 1.2;
  const s = size / 10;
  const str = String(text).toUpperCase();
  let advance = 0;
  for (const ch of str) advance += (ch === ' ' ? 3.2 : 6) + tracking;
  return Math.max(0, advance - tracking) * s;
}

/** Card-suit glyph path: 'heart' | 'diamond' | 'club' | 'spade'. */
export function drawSuit(ctx, suit, cx, cy, r, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  if (suit === 'diamond') {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.72, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r * 0.72, cy);
  } else if (suit === 'heart') {
    ctx.moveTo(cx, cy + r * 0.95);
    ctx.bezierCurveTo(cx - r * 1.35, cy - r * 0.15, cx - r * 0.6, cy - r * 1.15, cx, cy - r * 0.35);
    ctx.bezierCurveTo(cx + r * 0.6, cy - r * 1.15, cx + r * 1.35, cy - r * 0.15, cx, cy + r * 0.95);
  } else if (suit === 'club') {
    ctx.arc(cx, cy - r * 0.38, r * 0.42, 0, TAU);
    ctx.closePath();
    ctx.moveTo(cx - r * 0.36, cy + r * 0.24);
    ctx.arc(cx - r * 0.44, cy + r * 0.16, r * 0.42, 0, TAU);
    ctx.closePath();
    ctx.moveTo(cx + r * 0.52, cy + r * 0.16);
    ctx.arc(cx + r * 0.44, cy + r * 0.16, r * 0.42, 0, TAU);
    ctx.closePath();
    ctx.moveTo(cx - r * 0.16, cy + r * 1.0);
    ctx.lineTo(cx + r * 0.16, cy + r * 1.0);
    ctx.lineTo(cx + r * 0.08, cy + r * 0.28);
    ctx.lineTo(cx - r * 0.08, cy + r * 0.28);
  } else { // spade
    ctx.moveTo(cx, cy - r);
    ctx.bezierCurveTo(cx + r * 0.28, cy - r * 0.42, cx + r * 1.05, cy - r * 0.1, cx + r * 0.62, cy + r * 0.38);
    ctx.bezierCurveTo(cx + r * 0.32, cy + r * 0.62, cx + r * 0.1, cy + r * 0.42, cx + r * 0.12, cy + r * 0.3);
    ctx.lineTo(cx + r * 0.2, cy + r);
    ctx.lineTo(cx - r * 0.2, cy + r);
    ctx.lineTo(cx - r * 0.12, cy + r * 0.3);
    ctx.bezierCurveTo(cx - r * 0.1, cy + r * 0.42, cx - r * 0.32, cy + r * 0.62, cx - r * 0.62, cy + r * 0.38);
    ctx.bezierCurveTo(cx - r * 1.05, cy - r * 0.1, cx - r * 0.28, cy - r * 0.42, cx, cy - r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ══════════════════════════════════════════════════════════ FAMILY PAINTERS
//
// Each painter fills a Bake. They are pure functions of (bake, rng, params) so
// the same seed always reproduces the same texture.

/** Reused options object for woodRings — avoids per-texel allocation. */
const _wo = { rings: 9, wobble: 0.1, wobbleFreq: 2, curve: 0.35, seed: 0 };

/**
 * Shared wood substance: given strip-local coords and a palette, returns the
 * albedo in `out` and the surface height/roughness through the scratch
 * `_woodOut`.
 */
const _woodOut = { h: 0, rough: 0 };
function woodSubstance(u, v, pal, p, seed, out) {
  _wo.rings = p.rings;
  _wo.wobble = p.wobble;
  _wo.wobbleFreq = p.wobbleFreq;
  _wo.curve = p.curve;
  _wo.seed = seed;
  const w = N.woodRings(u, v, _wo);

  // Early wood (light) → late wood (dark), plus overall grain modulation.
  let t = w.ring * p.ringContrast + (w.grain - 0.5) * p.grainContrast;
  t = sat(t);
  mixRGB(pal.light, pal.dark, t, out);

  // Medullary ray flecks lighten across the grain.
  if (w.ray > 0) mixRGB(out, pal.fleck, w.ray * p.rayStrength, out);
  // Open pores darken.
  if (w.pore > 0) mixRGB(out, pal.pore, w.pore * p.poreStrength, out);

  _woodOut.h = 1 - w.ring * 0.55 - w.pore * 0.9 * p.poreStrength;
  _woodOut.rough = lerp(p.roughEarly, p.roughLate, t) + w.pore * 0.25;
  return out;
}

const WOOD_PALETTES = {
  oak: { light: hexRGB(0xc39a63), dark: hexRGB(0x7c5230), fleck: hexRGB(0xdcc194), pore: hexRGB(0x4a2f18) },
  walnut: { light: hexRGB(0x8a6142), dark: hexRGB(0x412618), fleck: hexRGB(0xa87f57), pore: hexRGB(0x24140b) },
  maple: { light: hexRGB(0xe3caa2), dark: hexRGB(0xb08f61), fleck: hexRGB(0xf1e0c0), pore: hexRGB(0x8a6a44) },
  pine: { light: hexRGB(0xdcc08c), dark: hexRGB(0xa87a45), fleck: hexRGB(0xeeddb4), pore: hexRGB(0x7a5528) },
  beech: { light: hexRGB(0xd7b98d), dark: hexRGB(0xa87f56), fleck: hexRGB(0xe8d4b2), pore: hexRGB(0x81603c) },
  mahogany: { light: hexRGB(0x96482c), dark: hexRGB(0x4f2113), fleck: hexRGB(0xb2643f), pore: hexRGB(0x30130a) },
};

const WOOD_DEFAULTS = {
  rings: 9, wobble: 0.09, wobbleFreq: 2, curve: 0.3,
  ringContrast: 0.85, grainContrast: 0.35,
  rayStrength: 0.30, poreStrength: 0.55,
  roughEarly: 0.42, roughLate: 0.55,
};

// ── wood/parquet — herringbone strips, varnished ───────────────────────────

function paintParquet(b, rng, p) {
  const blocks = p.blocks ?? 8;
  const pal = WOOD_PALETTES[p.palette ?? 'oak'];
  const pal2 = WOOD_PALETTES[p.palette2 ?? 'walnut'];
  const wp = { ...WOOD_DEFAULTS, ...p.wood };
  const seedBase = p.seed ?? 17;
  const gapDark = hexRGB(0x2a1a0e, _d);

  b.each((u, v, i) => {
    const cell = N.parquetLayout(u, v, blocks, p.mode ?? 'herringbone', seedBase);
    const along = cell.u, across = cell.v;
    const strip = cell.id;
    const r0 = cell.r0, r1 = cell.r1;

    // Alternate species subtly so the pattern reads.
    const usePal = r1 < (p.mix ?? 0.25) ? pal2 : pal;
    // Rings run along the strip.
    woodSubstance(along * (p.stretch ?? 1.0), across, usePal, wp, seedBase + (strip & 4095), _a);

    // Per-strip tonal variation — the single most important cue for parquet.
    const tone = 0.86 + r0 * 0.30;
    _a[0] *= tone; _a[1] *= tone; _a[2] *= tone;

    // Bevelled joint between strips.
    const eIn = cell.edge * blocks;               // in cell units
    const bev = 1 - N.sstep(0, p.bevel ?? 0.06, eIn);
    mixRGB(_a, gapDark, bev * 0.85, _a);

    b.setC(i, _a);
    b.height.data[i] = _woodOut.h * (1 - bev) - bev * 0.55;
    // Varnish: dark joints stay matte, faces are satin.
    b.rough.data[i] = lerp(_woodOut.rough * 0.55 + 0.12, 0.72, bev);
  });

  b.height.normalize(0.1, 1);
  b.heightScale = 0.10;
}

function postParquet(b, rng, p) {
  // Traffic wear: scuffs along the room's long axis + settled dust in joints.
  const wear = new N.Field(b.size);
  N.stampScratches(wear, rng, {
    count: Math.round(b.size * 0.35), minLen: 0.03, maxLen: 0.22,
    width: 0.55, depth: 0.10, angle: 0.15, spread: 0.35, mode: N.MAX,
  });
  wear.blur(0.6);
  const dust = N.dustMask(b.height, 2.5);
  const wd = wear.data, dd = dust.data, rd = b.rough.data;
  for (let i = 0; i < wd.length; i++) {
    rd[i] = sat(rd[i] + wd[i] * 0.35 + dd[i] * 0.18);
    b.mulAt(i, 1 - dd[i] * 0.10);
  }
}

// ── wood/oak_planks — long flooring boards ─────────────────────────────────

function paintPlanks(b, rng, p) {
  const rows = p.rows ?? 4;
  const perRow = p.perRow ?? 2;
  const pal = WOOD_PALETTES[p.palette ?? 'oak'];
  const wp = { ...WOOD_DEFAULTS, ...p.wood };
  const seedBase = p.seed ?? 41;
  const gapDark = hexRGB(p.gapColor ?? 0x241608, _d);

  b.each((u, v, i) => {
    const c = N.plankLayout(u, v, { rows, perRow, gap: p.gap ?? 0.006, seed: seedBase });
    const boardSeed = seedBase + (c.id & 8191);
    woodSubstance(c.u * (p.stretch ?? 1.6), c.v, pal, wp, boardSeed, _a);

    const tone = 0.82 + c.r0 * 0.36;
    const warm = 0.96 + c.r1 * 0.08;
    _a[0] *= tone * warm; _a[1] *= tone; _a[2] *= tone / warm;

    // Chamfer + shadow in the board joint.
    const g = c.mortar;
    mixRGB(_a, gapDark, g * 0.9, _a);

    b.setC(i, _a);
    b.height.data[i] = _woodOut.h - g * 0.8;
    b.rough.data[i] = lerp(_woodOut.rough * (p.satin ?? 0.8), 0.8, g);
  });
  b.height.normalize(0.05, 1);
  b.heightScale = 0.14;
}

// ── wood/plywood_varnish ───────────────────────────────────────────────────

function paintPlywood(b, rng, p) {
  const pal = WOOD_PALETTES.pine;
  const seed = p.seed ?? 77;
  b.each((u, v, i) => {
    // Rotary-cut veneer: very long, wavy, low-contrast figure.
    const w = N.warp2(u, v, 0.06, 3, seed, 1, 3);
    const fig = N.fbm2ap(w.u, w.v, 2, 20, 4, 2.1, 0.55, seed);
    const band = N.fbm2ap(u, v, 1, 4, 3, 2, 0.5, seed + 31);
    let t = sat(0.5 + fig * 0.42 + band * 0.18);
    mixRGB(pal.light, pal.dark, t * 0.75, _a);

    // Occasional dark knots / patches.
    const kn = N.worley2(u * 4, v * 4, 4, seed + 9, 1).f1;
    const knot = 1 - N.sstep(0.05, 0.16, kn);
    if (knot > 0) mixRGB(_a, pal.pore, knot * 0.7, _a);

    const grit = N.perlin2(u * 256, v * 256, 256, 256, seed + 5) * 0.02;
    _a[0] += grit; _a[1] += grit; _a[2] += grit;

    b.setC(i, _a);
    b.height.data[i] = 0.6 + fig * 0.12 - knot * 0.35;
    b.rough.data[i] = 0.22 + t * 0.08 + knot * 0.2;
  });
  b.heightScale = 0.05;
}

function postPlywood(b, rng) {
  const sc = new N.Field(b.size);
  N.stampScratches(sc, rng, { count: 90, minLen: 0.02, maxLen: 0.3, width: 0.5, depth: 0.5, spread: Math.PI, mode: N.MAX });
  sc.blur(0.5);
  const d = sc.data, r = b.rough.data;
  for (let i = 0; i < d.length; i++) r[i] = sat(r[i] + d[i] * 0.30);
}

// ── wood/mdf ───────────────────────────────────────────────────────────────

function paintMDF(b, rng, p) {
  const seed = p.seed ?? 133;
  const base = hexRGB(0xbf9a6e, _b);
  const dark = hexRGB(0x8d6a45, _c);
  b.each((u, v, i) => {
    const f = N.fbm2p(u, v, 40, 4, 2.2, 0.55, seed) * 0.5 + 0.5;
    const fine = N.perlin2(u * 300, v * 300, 300, 300, seed + 4) * 0.5 + 0.5;
    const t = sat(f * 0.55 + fine * 0.45);
    mixRGB(base, dark, t * 0.5, _a);
    b.setC(i, _a);
    b.height.data[i] = 0.5 + (fine - 0.5) * 0.35 + (f - 0.5) * 0.25;
    b.rough.data[i] = 0.78 + (1 - t) * 0.12;
  });
  b.heightScale = 0.03;
}

// ── carpet ─────────────────────────────────────────────────────────────────

function paintCarpetLoop(b, rng, p) {
  const seed = p.seed ?? 211;
  const base = hexRGB(p.color ?? 0x8c3b3b, _b);
  const dark = scaleRGB(base, 0.45, [0, 0, 0]);
  const light = mixRGB(base, [1, 1, 1], 0.30, [0, 0, 0]);
  const loops = p.loops ?? 56;

  b.each((u, v, i) => {
    // Loop pile: a dense grid of little arches.
    const w = N.worley2(u * loops, v * loops, loops, seed, 0.85);
    const loop = 1 - N.sstep(0.05, 0.5, w.f1);
    // Yarn fibres running through each loop.
    const fib = N.fibre(u, v, 220, 40, 1, 0, seed + 3, 2) * 0.5 + 0.5;
    // Patchy dye lots + shading between tufts.
    const patch = N.fbm2p(u, v, 5, 4, 2, 0.55, seed + 17) * 0.5 + 0.5;

    let t = loop * 0.8 + fib * 0.25 + patch * 0.2 - 0.2;
    t = sat(t);
    mixRGB(dark, light, t, _a);
    // Slight hue drift per patch so it isn't a flat field of one colour.
    const hueDrift = (patch - 0.5) * 0.08;
    _a[0] = sat(_a[0] * (1 + hueDrift));
    _a[2] = sat(_a[2] * (1 - hueDrift));

    b.setC(i, _a);
    b.height.data[i] = sat(loop * 0.75 + fib * 0.3 + patch * 0.15);
    b.rough.data[i] = 0.93 - loop * 0.05;
  });
  b.heightScale = 0.16;
  b.normalStrength = 1.35;
}

function paintCarpetCut(b, rng, p) {
  const seed = p.seed ?? 233;
  const base = hexRGB(p.color ?? 0x6a6f5c, _b);
  const dark = scaleRGB(base, 0.4, [0, 0, 0]);
  const light = mixRGB(base, [1, 1, 1], 0.42, [0, 0, 0]);

  b.each((u, v, i) => {
    // Cut pile is a sea of fibre tips: very high-frequency, slightly directional.
    const f1 = N.fibre(u, v, 300, 90, 1, 2, seed, 2) * 0.5 + 0.5;
    const f2 = N.fibre(u, v, 260, 70, -1, 3, seed + 5, 2) * 0.5 + 0.5;
    const speck = N.perlin2(u * 420, v * 420, 420, 420, seed + 11) * 0.5 + 0.5;
    const shade = N.fbm2p(u, v, 6, 4, 2, 0.5, seed + 23) * 0.5 + 0.5;
    let t = sat(f1 * 0.45 + f2 * 0.3 + speck * 0.25);
    t = sat(t * 0.75 + shade * 0.35);
    mixRGB(dark, light, t, _a);
    b.setC(i, _a);
    b.height.data[i] = sat(t * 0.8 + shade * 0.2);
    b.rough.data[i] = 0.95 - t * 0.06;
  });
  // The nap: comb the whole thing in one direction.
  b.height.directionalBlur(0.42, b.size * 0.006, 5, 0.6);
  b.heightScale = 0.12;
  b.normalStrength = 1.2;
}

function paintRug(b, rng, p) {
  const seed = p.seed ?? 251;
  const threads = p.threads ?? 96;
  const cream = hexRGB(0xd9c8a4);
  const red = hexRGB(0x8e2f2a);
  const blue = hexRGB(0x25415e);
  const gold = hexRGB(0xb28b3c);

  b.each((u, v, i) => {
    // Motif: concentric diamonds with a border — a classic kilim look.
    const bu = Math.abs(u - 0.5) * 2, bv = Math.abs(v - 0.5) * 2;
    const border = Math.max(bu, bv);
    const dia = Math.abs(u - 0.5) + Math.abs(v - 0.5);
    const ring = frac(dia * 6);

    let col;
    if (border > 0.92) col = red;
    else if (border > 0.86) col = gold;
    else if (border > 0.80) col = blue;
    else if (ring < 0.18) col = red;
    else if (ring < 0.30) col = gold;
    else if (ring < 0.52) col = blue;
    else col = cream;

    // Little stepped diamonds inside the field.
    const gx = frac(u * 8) - 0.5, gy = frac(v * 8) - 0.5;
    if (border < 0.78 && Math.abs(gx) + Math.abs(gy) < 0.18) col = ring < 0.4 ? cream : red;

    const wv = N.weave(u, v, threads, 0.9, seed, 0);
    const shade = 0.62 + wv.h * 0.5;
    _a[0] = col[0] * shade; _a[1] = col[1] * shade; _a[2] = col[2] * shade;

    // Yarn fuzz + age.
    const fuzz = N.perlin2(u * 500, v * 500, 500, 500, seed + 3) * 0.05;
    const age = N.fbm2p(u, v, 4, 3, 2, 0.5, seed + 61) * 0.10;
    _a[0] = sat(_a[0] + fuzz + age); _a[1] = sat(_a[1] + fuzz + age * 0.9); _a[2] = sat(_a[2] + fuzz + age * 0.7);

    b.setC(i, _a);
    b.height.data[i] = wv.h * 0.8 + (wv.gap ? 0 : 0.1) + fuzz;
    // Thread crowns are slightly burnished by wear; the gaps between them and
    // the aged patches stay dead matte.
    b.rough.data[i] = sat(0.97 - wv.h * 0.16 + (wv.gap ? 0.03 : 0) - age * 0.4 + fuzz * 0.6);
  });
  b.heightScale = 0.10;
  b.normalStrength = 1.1;
}

// ── tile ───────────────────────────────────────────────────────────────────

function paintCeramicTile(b, rng, p) {
  const seed = p.seed ?? 307;
  const n = p.tiles ?? 4;
  const tileCol = hexRGB(p.color ?? 0xe8e4dc, _b);
  const tileAlt = hexRGB(p.color2 ?? 0xd8d2c6, _c);
  const grout = hexRGB(p.grout ?? 0x9c968a, _d);

  b.each((u, v, i) => {
    const cell = N.brickLayout(u, v, {
      cols: n, rows: n, rowOffset: p.offset ?? 0,
      mortar: p.mortar ?? 0.035, seed, jitter: 0.012,
    });
    const m = cell.mortar;
    const shadeT = cell.r0;
    mixRGB(tileCol, tileAlt, shadeT * 0.9, _a);

    // Glaze: slow, soft mottling + a faint ripple from the firing.
    const glaze = N.fbm2p(u, v, 7, 4, 2.1, 0.5, seed + cell.col * 7 + cell.row * 31) * 0.5 + 0.5;
    const k = 0.92 + glaze * 0.16;
    _a[0] *= k; _a[1] *= k; _a[2] *= k;

    // Grout is porous, dirty, and sits lower.
    const gdirt = N.fbm2p(u, v, 28, 3, 2, 0.5, seed + 9) * 0.5 + 0.5;
    mixRGB(_a, grout, m * (0.85 + gdirt * 0.15), _a);
    if (m > 0.2) { const gk = 0.8 + gdirt * 0.35; _a[0] *= gk; _a[1] *= gk; _a[2] *= gk; }

    b.setC(i, _a);
    // Tiles bow very slightly in the middle; grout is a channel.
    const bow = (1 - Math.abs(cell.u - 0.5) * 2) * (1 - Math.abs(cell.v - 0.5) * 2);
    b.height.data[i] = (1 - m) * (0.72 + bow * 0.16 + glaze * 0.05) + m * 0.12;
    b.rough.data[i] = lerp(0.09 + glaze * 0.05, 0.88, m);
  });
  b.heightScale = 0.09;
}

function postCeramicTile(b, rng) {
  const sc = new N.Field(b.size);
  N.stampScratches(sc, rng, { count: 70, minLen: 0.01, maxLen: 0.14, width: 0.45, depth: 0.4, spread: Math.PI, mode: N.MAX });
  const d = sc.data, r = b.rough.data;
  for (let i = 0; i < d.length; i++) r[i] = sat(r[i] + d[i] * 0.35);
}

function paintLinoCheck(b, rng, p) {
  const seed = p.seed ?? 331;
  const n = p.checks ?? 8;
  const dark = hexRGB(p.color ?? 0x2b2b31, _b);
  const light = hexRGB(p.color2 ?? 0xe6e2d6, _c);

  b.each((u, v, i) => {
    const k = N.checkerSoft(u, v, n, 0.0016);
    mixRGB(dark, light, k, _a);
    // Lino is speckled with contrasting flecks.
    const fl = N.perlin2(u * 380, v * 380, 380, 380, seed) * 0.5 + 0.5;
    const fleck = Math.max(0, fl - 0.62) / 0.38;
    const target = k > 0.5 ? 0.35 : 0.85;
    mixRGB(_a, grey3(target), fleck * 0.5, _a);
    // Slow tonal drift = old, sun-faded flooring.
    const drift = N.fbm2p(u, v, 3, 3, 2, 0.5, seed + 5) * 0.06;
    _a[0] = sat(_a[0] + drift); _a[1] = sat(_a[1] + drift); _a[2] = sat(_a[2] + drift * 0.8);

    b.setC(i, _a);
    b.height.data[i] = 0.5 + fleck * 0.12 + (N.perlin2(u * 90, v * 90, 90, 90, seed + 2)) * 0.06;
    b.rough.data[i] = 0.24 + fleck * 0.12;
  });
  b.heightScale = 0.02;
}

function postLino(b, rng) {
  // Buffed swirl marks from a floor polisher.
  const sw = new N.Field(b.size);
  const n = b.size;
  for (let k = 0; k < 26; k++) {
    const cx = rng.next() * n, cy = rng.next() * n;
    const rad = n * (0.04 + rng.next() * 0.16);
    const steps = 90;
    let px = cx + rad, py = cy;
    for (let s = 1; s <= steps; s++) {
      const a = (s / steps) * TAU;
      const rr = rad * (1 + Math.sin(a * 3) * 0.06);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * 0.75;
      N.stampLine(sw, px, py, x, y, 0.55, 0.5, N.MAX);
      px = x; py = y;
    }
  }
  sw.blur(0.7);
  const d = sw.data, r = b.rough.data;
  for (let i = 0; i < d.length; i++) r[i] = sat(r[i] + d[i] * 0.22);
}

function paintMosaic(b, rng, p) {
  const seed = p.seed ?? 353;
  const n = p.tiles ?? 16;
  const grout = hexRGB(p.grout ?? 0xb9b2a4, _d);
  const palette = (p.palette ?? [0x2b6f8f, 0x3f95ad, 0x8fc4cf, 0xe7ddc6, 0x1d4c66]).map((h) => hexRGB(h));

  b.each((u, v, i) => {
    const cell = N.brickLayout(u, v, { cols: n, rows: n, rowOffset: 0, mortar: 0.10, seed, jitter: 0.05 });
    const idx = Math.floor(cell.r0 * palette.length) % palette.length;
    // A soft radial gradient across the whole tile makes the mosaic read as art.
    const g = sat(0.5 + (N.fbm2p(u, v, 3, 3, 2, 0.5, seed + 71)) * 0.9);
    const idx2 = Math.floor(g * palette.length) % palette.length;
    mixRGB(palette[idx], palette[idx2], 0.55, _a);

    const shade = 0.86 + cell.r1 * 0.26;
    _a[0] *= shade; _a[1] *= shade; _a[2] *= shade;

    const glaze = N.fbm2p(u, v, 40, 3, 2, 0.5, seed + 3) * 0.5 + 0.5;
    const m = cell.mortar;
    mixRGB(_a, grout, m, _a);

    b.setC(i, _a);
    const bow = (1 - Math.abs(cell.u - 0.5) * 2) * (1 - Math.abs(cell.v - 0.5) * 2);
    b.height.data[i] = (1 - m) * (0.7 + bow * 0.22) + m * 0.1;
    b.rough.data[i] = lerp(0.12 + glaze * 0.08, 0.9, m);
  });
  b.heightScale = 0.14;
}

// ── concrete ───────────────────────────────────────────────────────────────

function concreteBase(b, rng, p, opts) {
  const seed = p.seed ?? 401;
  const base = hexRGB(opts.base, _b);
  const dark = hexRGB(opts.dark, _c);

  b.each((u, v, i) => {
    const w = N.warp2(u, v, opts.warp, 3, seed, 1, 3);
    const mottle = N.fbm2p(w.u, w.v, 6, 5, 2.1, 0.55, seed) * 0.5 + 0.5;
    const fine = N.fbm2p(u, v, 60, 4, 2.2, 0.5, seed + 13) * 0.5 + 0.5;
    // Stretch the mottling so poured concrete isn't a flat grey field: real
    // slabs have visible pour patches and damp/dry blotches.
    const t = sat((mottle * 0.72 + fine * 0.34 - 0.06 - 0.5) * 1.5 + 0.5);
    mixRGB(dark, base, t, _a);

    // Aggregate showing through.
    const agg = N.worley2(u * opts.aggFreq, v * opts.aggFreq, opts.aggFreq, seed + 21, 1).f1;
    const stone = 1 - N.sstep(opts.aggSize * 0.4, opts.aggSize, agg);
    if (stone > 0) {
      const sv = 0.62 + ((agg * 977) % 1) * 0.35;
      mixRGB(_a, rgb3(sv, sv * 0.98, sv * 0.94), stone * opts.aggShow, _a);
    }

    b.setC(i, _a);
    b.height.data[i] = sat(0.55 + (mottle - 0.5) * 0.5 + (fine - 0.5) * opts.grain + stone * opts.aggRelief);
    b.rough.data[i] = sat(opts.rough + (1 - t) * 0.10 - stone * 0.06);
  });
  b.heightScale = opts.heightScale;
}

function paintConcretePoured(b, rng, p) {
  concreteBase(b, rng, p, {
    base: 0xa9a49b, dark: 0x716d66, warp: 0.10, aggFreq: 26, aggSize: 0.28,
    aggShow: 0.18, aggRelief: 0.05, grain: 0.30, rough: 0.72, heightScale: 0.05,
  });
}

function postConcretePoured(b, rng) {
  // Hairline shrinkage cracks + a couple of form-board lines + settled dust.
  const cr = new N.Field(b.size);
  N.stampCracks(cr, rng, { origins: 2, branches: 3, length: 0.45, width: 0.55, depth: -0.5, split: 0.4, levels: 3 });
  cr.blur(0.5);
  const dust = new N.Field(b.size);
  N.stampDust(dust, rng, { count: Math.round(b.size * 1.2), minRadius: 1, maxRadius: 7, value: 0.05, clumpFreq: 4 });
  dust.clamp(0, 0.5);
  const c = cr.data, du = dust.data, h = b.height.data, r = b.rough.data;
  for (let i = 0; i < c.length; i++) {
    h[i] = sat(h[i] + c[i] * 0.5);
    r[i] = sat(r[i] + du[i] * 0.4 - c[i] * 0.1);
    b.mulAt(i, 1 + c[i] * 0.5 + du[i] * 0.25);
  }
}

function paintConcreteScreed(b, rng, p) {
  concreteBase(b, rng, p, {
    base: 0xbdb9b1, dark: 0x8e8a83, warp: 0.06, aggFreq: 40, aggSize: 0.18,
    aggShow: 0.07, aggRelief: 0.02, grain: 0.18, rough: 0.62, heightScale: 0.025,
  });
  // Trowel sweep: smear the height in long arcs.
  b.height.directionalBlur(0.35, b.size * 0.02, 7, 0.3);
}

function paintConcreteRough(b, rng, p) {
  concreteBase(b, rng, p, {
    base: 0x9a958c, dark: 0x5f5b55, warp: 0.16, aggFreq: 16, aggSize: 0.42,
    aggShow: 0.42, aggRelief: 0.22, grain: 0.45, rough: 0.85, heightScale: 0.10,
  });
}

function postConcreteRough(b, rng) {
  const pits = new N.Field(b.size);
  N.stampBlobs(pits, rng, { count: 260, minRadius: 0.002, maxRadius: 0.012, value: -0.35, hardness: 0.5 });
  pits.blur(0.6);
  const d = pits.data, h = b.height.data, r = b.rough.data;
  for (let i = 0; i < d.length; i++) {
    h[i] = sat(h[i] + d[i]);
    r[i] = sat(r[i] - d[i] * 0.3);
    b.mulAt(i, 1 + d[i] * 0.5);
  }
}

// ── grass ──────────────────────────────────────────────────────────────────

function paintGrass(b, rng, p) {
  const seed = p.seed ?? 503;
  const n = b.size;

  // Two stamped fields: blade height and per-blade colour tone.
  const bladeH = new N.Field(n);
  const bladeT = new N.Field(n);
  const count = Math.round(n * n * (p.density ?? 0.055));
  const len = n * (p.bladeLen ?? 0.036);

  for (let k = 0; k < count; k++) {
    const x = rng.next() * n, y = rng.next() * n;
    // Patchiness: thinner where the lawn is worn, bald in the worst spots.
    const patch = N.fbm2p(x / n, y / n, 4, 3, 2, 0.5, seed + 3) * 0.5 + 0.5;
    if (rng.next() > 0.42 + patch * 0.80) continue;
    const a = rng.next() * TAU;
    const l = len * (0.5 + rng.next() * 1.0) * (0.65 + patch * 0.55);
    const bend = (rng.next() - 0.5) * 0.9;
    const w = 0.75 + rng.next() * 0.85;
    const tone = rng.next();
    const hv = 0.52 + rng.next() * 0.48;

    let px = x, py = y, ang = a;
    const segs = 4;
    for (let sg = 0; sg < segs; sg++) {
      const nx = px + Math.cos(ang) * (l / segs);
      const ny = py + Math.sin(ang) * (l / segs);
      const taper = 1 - (sg / segs) * 0.55;
      const hh = hv * (0.55 + 0.45 * (sg / segs));
      N.stampLine(bladeH, px, py, nx, ny, w * taper, hh, N.MAX);
      N.stampLine(bladeT, px, py, nx, ny, w * taper, tone, N.MAX);
      px = nx; py = ny; ang += bend / segs;
    }
  }
  // Deliberately NOT blurred: stampDisc already gives the blades a soft edge,
  // and any box blur wide enough to matter erases them.

  const soil = hexRGB(0x4a3722, _b);
  const thatch = hexRGB(0x36471f, _c);
  const dry = hexRGB(0xb0a659, _d);
  const mid = hexRGB(0x69a03b, [0, 0, 0]);
  const bright = hexRGB(0x9ccb5c, [0, 0, 0]);
  const bh = bladeH.data, bt = bladeT.data;

  b.each((u, v, i) => {
    const patch = N.fbm2p(u, v, 4, 3, 2, 0.5, seed + 3) * 0.5 + 0.5;
    const cover = sat(bh[i] * 1.5);

    // Blade colour: fresh green, drying out where the lawn is thin.
    mixRGB(mid, bright, sat(bt[i] * 0.95), _a);
    mixRGB(_a, dry, sat((1 - patch) * 0.55 - 0.08), _a);

    // Under-layer: dark thatch between the blades, bare soil in the bald spots.
    const soilN = N.fbm2p(u, v, 30, 3, 2, 0.5, seed + 9) * 0.5 + 0.5;
    mixRGB(thatch, soil, sat(1.25 - patch * 1.55), _t);
    scaleRGB(_t, 0.72 + soilN * 0.5, _t);
    mixRGB(_t, _a, cover, _a);

    // Occlusion between the blades.
    const k = 0.80 + cover * 0.26 + bh[i] * 0.14;
    _a[0] = sat(_a[0] * k); _a[1] = sat(_a[1] * k); _a[2] = sat(_a[2] * k);

    b.setC(i, _a);
    b.height.data[i] = sat(bh[i] * 0.85 + soilN * 0.12);
    b.rough.data[i] = 0.84 - cover * 0.14;
  });
  b.heightScale = 0.20;
  b.normalStrength = 1.5;
}

// ── dirt ───────────────────────────────────────────────────────────────────

function paintDirt(b, rng, p) {
  const seed = p.seed ?? 541;
  const light = hexRGB(0x8a6b48, _b);
  const dark = hexRGB(0x3c2a1a, _c);

  b.each((u, v, i) => {
    const w = N.warp2(u, v, 0.14, 3, seed, 2, 3);
    const clump = N.fbm2p(w.u, w.v, 7, 5, 2.15, 0.55, seed) * 0.5 + 0.5;
    const fine = N.fbm2p(u, v, 70, 4, 2.2, 0.5, seed + 7) * 0.5 + 0.5;
    // Dry cracked crust.
    const crack = N.cracks2(u, v, 9, 2, seed + 31, 0.055, 0.5);
    let t = sat(clump * 0.75 + fine * 0.35 - 0.08);
    mixRGB(dark, light, t, _a);
    mixRGB(_a, scaleRGB(dark, 0.7, _d), crack * 0.8, _a);

    // Small stones.
    const st = N.worley2(u * 30, v * 30, 30, seed + 55, 1).f1;
    const stone = 1 - N.sstep(0.08, 0.16, st);
    if (stone > 0) mixRGB(_a, rgb3(0.52, 0.50, 0.47), stone * 0.55, _a);

    b.setC(i, _a);
    b.height.data[i] = sat(0.5 + (clump - 0.5) * 0.7 + (fine - 0.5) * 0.35 - crack * 0.45 + stone * 0.18);
    b.rough.data[i] = sat(0.88 + (1 - t) * 0.08 - stone * 0.12);
  });
  b.heightScale = 0.13;
  b.normalStrength = 1.25;
}

function postDirt(b, rng) {
  const tread = new N.Field(b.size);
  N.stampScratches(tread, rng, { count: 120, minLen: 0.05, maxLen: 0.4, width: 1.4, depth: -0.12, angle: 0.3, spread: 0.6, mode: N.ADD });
  tread.blur(1.0);
  const d = tread.data, h = b.height.data;
  for (let i = 0; i < d.length; i++) { h[i] = sat(h[i] + d[i]); b.mulAt(i, 1 + d[i] * 0.6); }
}

// ── gravel ─────────────────────────────────────────────────────────────────

function paintGravel(b, rng, p) {
  const seed = p.seed ?? 577;
  const f1 = p.stones ?? 22;
  const f2 = f1 * 2;

  b.each((u, v, i) => {
    // Two layers of pebbles: big ones with small ones packed between.
    const w1 = N.worley2(u * f1, v * f1, f1, seed, 1);
    const d1 = w1.f1, id1 = w1.cellId;
    const w2 = N.worley2(u * f2, v * f2, f2, seed + 101, 1);
    const d2 = w2.f1, id2 = w2.cellId;

    const big = 1 - N.sstep(0.10, 0.42, d1);
    const small = 1 - N.sstep(0.08, 0.34, d2);
    const useBig = big > small * 0.85;
    const id = useBig ? id1 : id2;
    const dome = useBig
      ? Math.sqrt(Math.max(0, 1 - (d1 / 0.42) * (d1 / 0.42)))
      : Math.sqrt(Math.max(0, 1 - (d2 / 0.34) * (d2 / 0.34))) * 0.7;

    // Per-stone colour: greys with the odd warm flint.
    const r0 = ((id >>> 8) & 255) / 255;
    const r1 = ((id >>> 16) & 255) / 255;
    const g = 0.34 + r0 * 0.42;
    hslRGB(0.08 + r1 * 0.04, 0.05 + r1 * 0.16, g, _a);

    // Micro texture on each stone.
    const micro = N.perlin2(u * 300, v * 300, 300, 300, seed + 5) * 0.06;
    _a[0] = sat(_a[0] + micro); _a[1] = sat(_a[1] + micro); _a[2] = sat(_a[2] + micro);

    // Dark, dusty gaps.
    const gap = 1 - Math.max(big, small);
    const k = 0.35 + (1 - gap) * 0.75;
    _a[0] *= k; _a[1] *= k; _a[2] *= k;

    b.setC(i, _a);
    b.height.data[i] = sat(dome * 0.9 + micro + (1 - gap) * 0.1);
    b.rough.data[i] = 0.80 + gap * 0.12 - r0 * 0.06;
  });
  b.heightScale = 0.24;
  b.normalStrength = 1.4;
}

// ── sand ───────────────────────────────────────────────────────────────────

function paintSand(b, rng, p) {
  const seed = p.seed ?? 601;
  const light = hexRGB(0xdcc79b, _b);
  const dark = hexRGB(0xa8895c, _c);

  b.each((u, v, i) => {
    // Wind ripples: a warped periodic wave.
    const w = N.warp2(u, v, 0.09, 2, seed, 1, 3);
    const ripple = 0.5 - 0.5 * Math.cos((w.v * 14 + w.u * 3) * TAU);
    const ripple2 = 0.5 - 0.5 * Math.cos((w.v * 33 - w.u * 6) * TAU);
    const drift = N.fbm2p(u, v, 5, 4, 2, 0.55, seed + 11) * 0.5 + 0.5;
    const grain = N.perlin2(u * 460, v * 460, 460, 460, seed + 3) * 0.5 + 0.5;

    const h = sat(ripple * 0.55 + ripple2 * 0.2 + drift * 0.3 + grain * 0.12);
    mixRGB(dark, light, sat(h * 0.85 + grain * 0.3), _a);
    // Sparkle: a few quartz grains catch the light.
    const sp = Math.max(0, N.perlin2(u * 700, v * 700, 700, 700, seed + 17) - 0.68) / 0.32;
    _a[0] = sat(_a[0] + sp * 0.35); _a[1] = sat(_a[1] + sp * 0.34); _a[2] = sat(_a[2] + sp * 0.30);

    b.setC(i, _a);
    b.height.data[i] = h;
    b.rough.data[i] = 0.86 - sp * 0.35;
  });
  b.heightScale = 0.11;
  b.normalStrength = 1.15;
}

// ── water ──────────────────────────────────────────────────────────────────

/**
 * One layer of the animated water surface. Directional Gerstner-ish swell plus
 * capillary chop; the second layer uses a different seed/scale and scrolls the
 * other way (see `WATER_LAYER_B`).
 */
function paintWaterLayer(b, rng, p) {
  const seed = p.seed ?? 811;
  // Wave vectors MUST be integers or the tile seams — the phase has to advance
  // by a whole number of cycles across the tile.
  const waves = p.waves ?? [[6, 2, 1.0], [-4, 7, 0.7], [2, -9, 0.45]];
  let wnorm = 0;
  for (let k = 0; k < waves.length; k++) wnorm += waves[k][2] ?? 1;
  b.each((u, v, i) => {
    let h = 0;
    for (let k = 0; k < waves.length; k++) {
      const kx = Math.round(waves[k][0]), ky = Math.round(waves[k][1]);
      const amp = waves[k][2] ?? 1;
      // Sharpened crest profile (Gerstner-like) keeps the surface from looking
      // like a plain sine field.
      const s = 0.5 - 0.5 * Math.cos((u * kx + v * ky) * TAU);
      h += Math.pow(s, 1.6) * amp / wnorm;
    }
    const chop = N.fbm2p(u, v, p.chopFreq ?? 22, 4, 2.15, 0.55, seed) * 0.5 + 0.5;
    const micro = N.fbm2p(u, v, p.microFreq ?? 90, 3, 2.2, 0.5, seed + 7) * 0.5 + 0.5;
    const total = sat(h * (p.swell ?? 0.55) + chop * (p.chop ?? 0.32) + micro * (p.micro ?? 0.16));

    b.height.data[i] = total;
    // Albedo is nearly irrelevant (transmission material) but a faint depth
    // tint sells shallow water over a floor.
    const tint = 0.55 + total * 0.4;
    b.set(i, 0.16 * tint, 0.34 * tint, 0.36 * tint);
    b.rough.data[i] = 0.02 + (1 - total) * 0.05;
  });
  b.heightScale = 0.05;
  b.normalStrength = p.normalStrength ?? 1.0;
}

// ── ice ────────────────────────────────────────────────────────────────────

function paintIceCracked(b, rng, p) {
  const seed = p.seed ?? 857;
  const pale = hexRGB(0xd6ecf5, _b);
  const deep = hexRGB(0x7fb2c9, _c);

  b.each((u, v, i) => {
    const w = N.warp2(u, v, 0.05, 3, seed, 1, 3);
    const body = N.fbm2p(w.u, w.v, 5, 4, 2.1, 0.55, seed) * 0.5 + 0.5;
    const cr = N.cracks2(u, v, 7, 3, seed + 41, 0.035, 0.55);
    const bub = N.worley2(u * 34, v * 34, 34, seed + 3, 1).f1;
    const bubble = 1 - N.sstep(0.02, 0.09, bub);

    mixRGB(deep, pale, sat(body * 0.7 + 0.25), _a);
    mixRGB(_a, rgb3(0.96, 0.99, 1.0), cr * 0.85, _a);
    mixRGB(_a, rgb3(0.90, 0.96, 0.99, _t2), bubble * 0.6, _a);

    b.setC(i, _a);
    b.height.data[i] = sat(0.72 + (body - 0.5) * 0.25 - cr * 0.55 + bubble * 0.08);
    b.rough.data[i] = sat(0.05 + cr * 0.35 + bubble * 0.2 + (1 - body) * 0.05);
  });
  b.heightScale = 0.05;
}

function paintIceFrosted(b, rng, p) {
  const seed = p.seed ?? 863;
  b.each((u, v, i) => {
    // Frost ferns: ridged noise radiating from cell centres.
    const w = N.worley2(u * 9, v * 9, 9, seed, 1);
    const rad = Math.atan2(w.f1y, w.f1x);
    const fern = N.ridged2p(u + Math.cos(rad) * 0.02, v + Math.sin(rad) * 0.02, 40, 4, 2.1, 0.5, seed + 5, 2.2);
    const grain = N.fbm2p(u, v, 120, 3, 2.2, 0.5, seed + 9) * 0.5 + 0.5;
    const t = sat(fern * 0.85 + grain * 0.3);
    const c = 0.80 + t * 0.20;
    b.set(i, c * 0.96, c * 0.99, c);
    b.height.data[i] = t;
    b.rough.data[i] = 0.32 + t * 0.42;
  });
  b.heightScale = 0.06;
  b.normalStrength = 1.2;
}

// ── metal ──────────────────────────────────────────────────────────────────

function paintBrushedAlu(b, rng, p) {
  const seed = p.seed ?? 907;
  const dirU = p.dirU ?? 1, dirV = p.dirV ?? 0;
  b.each((u, v, i) => {
    const f = N.fibre(u, v, 420, 12, dirU, dirV, seed, 3) * 0.5 + 0.5;
    const f2 = N.fibre(u, v, 130, 6, dirU, dirV, seed + 3, 2) * 0.5 + 0.5;
    const t = sat(f * 0.6 + f2 * 0.5 - 0.05);
    const c = 0.62 + t * 0.22;
    b.set(i, c, c * 1.005, c * 1.02);
    b.height.data[i] = t;
    b.rough.data[i] = sat(0.20 + (1 - t) * 0.20);
    b.metal.data[i] = 1;
  });
  b.heightScale = 0.012;
  b.normalStrength = 0.55;
}

function postBrushedAlu(b, rng) {
  const sc = new N.Field(b.size);
  N.stampScratches(sc, rng, { count: 40, minLen: 0.05, maxLen: 0.5, width: 0.5, depth: 0.6, angle: 0, spread: 0.06, mode: N.MAX });
  const d = sc.data, r = b.rough.data;
  for (let i = 0; i < d.length; i++) r[i] = sat(r[i] + d[i] * 0.18);
}

function paintGalvanised(b, rng, p) {
  const seed = p.seed ?? 911;
  b.each((u, v, i) => {
    // Spangle: big crystalline grains with hard boundaries.
    const w = N.worley2Metric(u * 7, v * 7, 7, seed, 1, 0);
    const inner = N.worley2Metric(u * 26, v * 26, 26, seed + w.cx * 13 + w.cy * 7, 1, 2);
    const gid = ((w.cellId >>> 9) & 255) / 255;
    const grain = 0.55 + gid * 0.42;
    const facet = 0.85 + (1 - N.sstep(0.02, 0.35, inner.f2 - inner.f1)) * 0.3;
    const edge = 1 - N.sstep(0.0, 0.05, w.f2 - w.f1);
    const t = sat(grain * facet - edge * 0.25);
    const c = 0.48 + t * 0.40;
    b.set(i, c * 0.98, c * 0.99, c);
    b.height.data[i] = sat(t * 0.7 + (1 - edge) * 0.2);
    b.rough.data[i] = sat(0.30 + (1 - t) * 0.28 + edge * 0.15);
    b.metal.data[i] = 1;
  });
  b.heightScale = 0.02;
  b.normalStrength = 0.7;
}

function paintPaintedMetal(b, rng, p) {
  const seed = p.seed ?? 919;
  const paint = hexRGB(p.color ?? 0xc23b2e, _b);
  const prime = hexRGB(0x6f6a63, _c);
  const rust = hexRGB(0x7a3d1c, _d);

  b.each((u, v, i) => {
    // Orange peel from spray painting.
    const peel = N.fbm2p(u, v, 55, 3, 2.2, 0.5, seed) * 0.5 + 0.5;
    // Chipping mask, biased to a large-scale wear pattern.
    const wearN = N.fbm2p(u, v, 6, 4, 2.1, 0.55, seed + 13) * 0.5 + 0.5;
    const chipN = N.worley2(u * 30, v * 30, 30, seed + 27, 1).f1;
    const chip = sat((1 - N.sstep(0.10, 0.34, chipN)) * N.sstep(0.34, 0.74, wearN) * 1.6 * (p.wear ?? 1));
    const rustN = N.fbm2p(u, v, 40, 4, 2.2, 0.55, seed + 31) * 0.5 + 0.5;
    const rusty = sat(chip * rustN * 1.4);

    mixRGB(paint, prime, chip * 0.8, _a);
    mixRGB(_a, rust, rusty * 0.85, _a);
    const shade = 0.94 + peel * 0.12;
    _a[0] *= shade; _a[1] *= shade; _a[2] *= shade;

    b.setC(i, _a);
    b.height.data[i] = sat(0.62 + (peel - 0.5) * 0.35 - chip * 0.35);
    b.rough.data[i] = sat(lerp(0.30 + peel * 0.10, 0.85, chip) + rusty * 0.1);
    b.metal.data[i] = sat(chip * 0.7 - rusty * 0.5);
  });
  b.heightScale = 0.03;
}

function paintChrome(b, rng, p) {
  const seed = p.seed ?? 929;
  b.each((u, v, i) => {
    const smudge = N.fbm2p(u, v, 8, 4, 2.1, 0.5, seed) * 0.5 + 0.5;
    const micro = N.fbm2p(u, v, 180, 3, 2.2, 0.5, seed + 5) * 0.5 + 0.5;
    const c = 0.88 + micro * 0.08;
    b.set(i, c, c, c * 1.01);
    b.height.data[i] = 0.5 + (micro - 0.5) * 0.2;
    b.rough.data[i] = sat(0.025 + smudge * 0.07 + micro * 0.02);
    b.metal.data[i] = 1;
  });
  b.heightScale = 0.006;
  b.normalStrength = 0.35;
}

function postChrome(b, rng) {
  const sc = new N.Field(b.size);
  N.stampScratches(sc, rng, { count: 26, minLen: 0.02, maxLen: 0.25, width: 0.4, depth: 0.5, spread: Math.PI, mode: N.MAX });
  const fp = new N.Field(b.size);
  N.stampDust(fp, rng, { count: 200, minRadius: 2, maxRadius: 12, value: 0.05, clumpFreq: 3 });
  const d = sc.data, f = fp.data, r = b.rough.data;
  for (let i = 0; i < d.length; i++) r[i] = sat(r[i] + d[i] * 0.25 + Math.min(0.25, f[i]));
}

function paintRust(b, rng, p) {
  const seed = p.seed ?? 937;
  const bright = hexRGB(0xb1591f, _b);
  const mid = hexRGB(0x7a3a17, _c);
  const dark = hexRGB(0x38200f, _d);
  const steel = hexRGB(0x6d6a66, [0, 0, 0]);

  b.each((u, v, i) => {
    const w = N.warp2(u, v, 0.12, 3, seed, 2, 3);
    const patch = N.fbm2p(w.u, w.v, 5, 5, 2.15, 0.55, seed) * 0.5 + 0.5;
    const scab = N.fbm2p(u, v, 24, 4, 2.2, 0.55, seed + 17) * 0.5 + 0.5;
    const flake = N.worley2(u * 18, v * 18, 18, seed + 23, 1);
    const flakeEdge = 1 - N.sstep(0.0, 0.06, flake.f2 - flake.f1);

    const t = sat(patch * 0.75 + scab * 0.4 - 0.1);
    mixRGB(dark, mid, t, _a);
    mixRGB(_a, bright, sat(scab * 1.2 - 0.35), _a);
    // Bare metal peeking through where the scale has fallen off.
    const bare = sat(N.sstep(0.72, 0.92, patch));
    mixRGB(_a, steel, bare * 0.75, _a);
    mixRGB(_a, dark, flakeEdge * 0.5, _a);

    b.setC(i, _a);
    b.height.data[i] = sat(0.45 + (scab - 0.5) * 0.7 + (patch - 0.5) * 0.4 - flakeEdge * 0.3 + bare * 0.1);
    b.rough.data[i] = sat(0.92 - bare * 0.42);
    b.metal.data[i] = sat(bare * 0.85);
  });
  b.heightScale = 0.09;
  b.normalStrength = 1.2;
}

function paintDiamondPlate(b, rng, p) {
  const seed = p.seed ?? 941;
  const n = p.cells ?? 6;
  b.each((u, v, i) => {
    const dp = N.diamondPlate(u, v, n, seed);
    const grain = N.fibre(u, v, 300, 20, 1, 0, seed + 3, 2) * 0.5 + 0.5;
    const dirt = N.fbm2p(u, v, 12, 3, 2, 0.5, seed + 9) * 0.5 + 0.5;
    const t = sat(0.55 + dp * 0.4 + grain * 0.12 - dirt * 0.12);
    const c = 0.45 + t * 0.34;
    b.set(i, c, c * 1.0, c * 1.01);
    b.height.data[i] = sat(dp * 0.85 + grain * 0.10 + 0.08);
    b.rough.data[i] = sat(0.34 + dirt * 0.28 - dp * 0.10);
    b.metal.data[i] = 1;
  });
  b.heightScale = 0.16;
  b.normalStrength = 1.3;
}

// ── plastic ────────────────────────────────────────────────────────────────

function paintABSMatte(b, rng, p) {
  const seed = p.seed ?? 1009;
  const base = hexRGB(p.color ?? 0xd8443c, _b);
  b.each((u, v, i) => {
    // Fine sparked/EDM mould texture — thousands of tiny craters.
    const spark = N.worley2(u * 150, v * 150, 150, seed, 1).f1;
    const crater = 1 - N.sstep(0.10, 0.40, spark);
    const micro = N.fbm2p(u, v, 200, 3, 2.2, 0.5, seed + 5) * 0.5 + 0.5;
    const flow = N.fbm2ap(u, v, 1, 6, 3, 2, 0.5, seed + 11) * 0.5 + 0.5;

    const k = 0.94 + micro * 0.10 + flow * 0.04;
    _a[0] = sat(base[0] * k); _a[1] = sat(base[1] * k); _a[2] = sat(base[2] * k);
    // Pigment specks.
    const sp = Math.max(0, N.perlin2(u * 520, v * 520, 520, 520, seed + 3) - 0.62) / 0.38;
    mixRGB(_a, rgb3(_a[0] * 1.5, _a[1] * 1.5, _a[2] * 1.5), sp * 0.25, _a);

    b.setC(i, _a);
    b.height.data[i] = sat(0.6 - crater * 0.3 + micro * 0.2);
    b.rough.data[i] = sat(0.48 + crater * 0.16 + micro * 0.06);
  });
  b.heightScale = 0.02;
  b.normalStrength = 0.8;
}

function paintABSGloss(b, rng, p) {
  const seed = p.seed ?? 1013;
  const base = hexRGB(p.color ?? 0x2f6fd0, _b);
  b.each((u, v, i) => {
    // Flow lines radiating from the (virtual) gate + faint sink marks.
    const flow = N.fbm2ap(u, v, 1, 8, 3, 2, 0.5, seed) * 0.5 + 0.5;
    const sink = N.fbm2p(u, v, 6, 3, 2, 0.5, seed + 7) * 0.5 + 0.5;
    const micro = N.fbm2p(u, v, 260, 2, 2.2, 0.5, seed + 3) * 0.5 + 0.5;
    // Pigment is never perfectly dispersed: faint swirl banding from the screw
    // plus a hint of the tool's polish direction.
    const swirl = N.fbm2ap(u, v, 3, 14, 3, 2, 0.5, seed + 19) * 0.5 + 0.5;
    const k = 0.90 + flow * 0.09 + sink * 0.07 + swirl * 0.06;
    _a[0] = sat(base[0] * k); _a[1] = sat(base[1] * k); _a[2] = sat(base[2] * k);
    b.setC(i, _a);
    b.height.data[i] = sat(0.55 + (sink - 0.5) * 0.3 + (micro - 0.5) * 0.08);
    b.rough.data[i] = sat(0.07 + micro * 0.06 + sink * 0.04 + swirl * 0.03);
  });
  b.heightScale = 0.012;
  b.normalStrength = 0.5;
}

function paintTranslucentPlastic(b, rng, p) {
  const seed = p.seed ?? 1019;
  const base = hexRGB(p.color ?? 0x54d6c0, _b);
  b.each((u, v, i) => {
    const swirl = N.fbm2p(u, v, 8, 4, 2.1, 0.55, seed) * 0.5 + 0.5;
    const micro = N.fbm2p(u, v, 180, 2, 2.2, 0.5, seed + 5) * 0.5 + 0.5;
    const k = 0.88 + swirl * 0.24;
    _a[0] = sat(base[0] * k); _a[1] = sat(base[1] * k); _a[2] = sat(base[2] * k);
    b.setC(i, _a);
    b.height.data[i] = 0.5 + (micro - 0.5) * 0.2;
    b.rough.data[i] = sat(0.10 + swirl * 0.10);
    b.alpha.data[i] = 0.62 + swirl * 0.16;
  });
  b.heightScale = 0.01;
  b.normalStrength = 0.4;
}

// ── rubber ─────────────────────────────────────────────────────────────────

function paintTyreTread(b, rng, p) {
  const seed = p.seed ?? 1103;
  const cols = p.cols ?? 4, rows = p.rows ?? 8;
  const rubber = hexRGB(0x22242a, _b);
  const worn = hexRGB(0x3b3d44, _c);

  b.each((u, v, i) => {
    // Tread blocks with a wide circumferential groove.
    const cell = N.brickLayout(u, v, { cols, rows, rowOffset: 0.5, mortar: 0.16, seed, jitter: 0 });
    const groove = Math.min(1, cell.mortar * 1.15);
    // Sipes: thin slits across each block.
    const sipe = 1 - N.sstep(0.0, 0.05, Math.abs(frac(cell.v * 3 + 0.5) - 0.5) * 2);
    const block = (1 - groove) * (1 - sipe * 0.8);

    const grain = N.fbm2p(u, v, 180, 3, 2.2, 0.5, seed + 5) * 0.5 + 0.5;
    mixRGB(rubber, worn, sat(block * 0.55 + grain * 0.35), _a);
    const k = 0.88 + grain * 0.2;
    _a[0] *= k; _a[1] *= k; _a[2] *= k;

    b.setC(i, _a);
    b.height.data[i] = sat(block * 0.85 + grain * 0.12);
    b.rough.data[i] = sat(0.86 - block * 0.10 + grain * 0.06);
  });
  b.heightScale = 0.30;
  b.normalStrength = 1.6;
}

function paintRubberMat(b, rng, p) {
  const seed = p.seed ?? 1109;
  const n = p.nubs ?? 18;
  const base = hexRGB(p.color ?? 0x2c2f33, _b);
  b.each((u, v, i) => {
    const s = N.studGrid(u, v, n, 0.30, 0.10, seed);
    const grain = N.fbm2p(u, v, 220, 3, 2.2, 0.5, seed + 3) * 0.5 + 0.5;
    const k = 0.82 + s.h * 0.28 + grain * 0.14;
    _a[0] = sat(base[0] * k); _a[1] = sat(base[1] * k); _a[2] = sat(base[2] * k);
    b.setC(i, _a);
    b.height.data[i] = sat(0.25 + s.h * 0.7 + grain * 0.08);
    b.rough.data[i] = sat(0.88 + grain * 0.08 - s.h * 0.08);
  });
  b.heightScale = 0.22;
  b.normalStrength = 1.4;
}

// ── glass ──────────────────────────────────────────────────────────────────

function paintGlassClear(b, rng, p) {
  const seed = p.seed ?? 1201;
  b.each((u, v, i) => {
    const wave = N.fbm2p(u, v, 4, 3, 2, 0.5, seed) * 0.5 + 0.5;
    b.set(i, 0.94, 0.97, 0.96);
    b.height.data[i] = 0.5 + (wave - 0.5) * 0.4;
    b.rough.data[i] = 0.02 + wave * 0.02;
  });
  b.heightScale = 0.004;
  b.normalStrength = 0.35;
}

function postGlassClear(b, rng) {
  const sm = new N.Field(b.size);
  N.stampDust(sm, rng, { count: 320, minRadius: 1, maxRadius: 9, value: 0.05, clumpFreq: 3 });
  N.stampStreaks(sm, rng, { count: 10, minLen: 0.15, maxLen: 0.6, width: 5, value: 0.04, angle: Math.PI / 2, spread: 0.06 });
  const d = sm.data, r = b.rough.data;
  for (let i = 0; i < d.length; i++) r[i] = sat(r[i] + Math.min(0.3, d[i]));
}

function paintGlassFrosted(b, rng, p) {
  const seed = p.seed ?? 1213;
  b.each((u, v, i) => {
    const etch = N.fbm2p(u, v, 200, 4, 2.2, 0.5, seed) * 0.5 + 0.5;
    const soft = N.fbm2p(u, v, 12, 3, 2, 0.5, seed + 5) * 0.5 + 0.5;
    const c = 0.90 + etch * 0.08;
    b.set(i, c * 0.98, c, c * 0.99);
    b.height.data[i] = etch;
    b.rough.data[i] = sat(0.42 + etch * 0.22 + soft * 0.08);
  });
  b.heightScale = 0.012;
  b.normalStrength = 0.9;
}

// ── cardboard ──────────────────────────────────────────────────────────────

function paintKraft(b, rng, p) {
  const seed = p.seed ?? 1301;
  const base = hexRGB(p.color ?? 0xc09763, _b);
  const dark = hexRGB(0x8d6a3f, _c);
  b.each((u, v, i) => {
    // Recycled pulp: matted fibres in every direction plus dark specks.
    const f1 = N.fibre(u, v, 180, 26, 1, 0, seed, 3) * 0.5 + 0.5;
    const f2 = N.fibre(u, v, 190, 24, 0, 1, seed + 5, 3) * 0.5 + 0.5;
    const f3 = N.fibre(u, v, 170, 22, 1, 1, seed + 9, 2) * 0.5 + 0.5;
    const pulp = sat((f1 + f2 + f3) / 3 * 1.25 - 0.12);
    const speck = Math.max(0, N.perlin2(u * 340, v * 340, 340, 340, seed + 3) - 0.55) / 0.45;
    // Faint flute shadow telegraphing through the liner.
    const flute = N.corrugation(u, p.flutes ?? 26, 0.5);
    mixRGB(dark, base, pulp, _a);
    mixRGB(_a, rgb3(0.30, 0.22, 0.14), speck * 0.5, _a);
    const k = 0.95 + flute * 0.08;
    _a[0] *= k; _a[1] *= k; _a[2] *= k;

    b.setC(i, _a);
    b.height.data[i] = sat(pulp * 0.55 + flute * 0.30 - speck * 0.2);
    b.rough.data[i] = sat(0.88 - pulp * 0.08);
  });
  b.heightScale = 0.05;
  b.normalStrength = 1.05;
}

function paintCorrugated(b, rng, p) {
  const seed = p.seed ?? 1303;
  const liner = hexRGB(0xbe9560, _b);
  const inner = hexRGB(0x7d5c35, _c);
  const flutes = p.flutes ?? 20;
  b.each((u, v, i) => {
    // The exposed cut edge: liner / flute / liner sandwich across v.
    const band = frac(v * (p.bands ?? 1));
    const isLiner = band < 0.14 || band > 0.86;
    const wave = N.corrugation(u, flutes, 0.25);
    const pulp = N.fibre(u, v, 200, 20, 1, 0, seed, 2) * 0.5 + 0.5;

    if (isLiner) {
      mixRGB(liner, inner, pulp * 0.4, _a);
      b.height.data[i] = 0.78 + pulp * 0.12;
      b.rough.data[i] = 0.88;
    } else {
      // Corrugation, shaded by the flute normal.
      const shade = 0.42 + wave * 0.62;
      _a[0] = inner[0] * shade; _a[1] = inner[1] * shade; _a[2] = inner[2] * shade;
      b.height.data[i] = wave * 0.72;
      b.rough.data[i] = 0.92;
    }
    const speck = Math.max(0, N.perlin2(u * 300, v * 300, 300, 300, seed + 3) - 0.6) / 0.4;
    mixRGB(_a, rgb3(0.28, 0.20, 0.12), speck * 0.4, _a);
    b.setC(i, _a);
  });
  b.heightScale = 0.20;
  b.normalStrength = 1.5;
}

// ── fabric ─────────────────────────────────────────────────────────────────

function paintDenim(b, rng, p) {
  const seed = p.seed ?? 1409;
  const threads = p.threads ?? 108;
  const indigo = hexRGB(p.color ?? 0x2d4a72, _b);
  const weft = hexRGB(0xd8d3c4, _c);
  b.each((u, v, i) => {
    const w = N.weave(u, v, threads, 0.92, seed, 2); // twill = diagonal
    const yarn = N.perlin2(u * 900, v * 200, 900, 200, seed + 3) * 0.5 + 0.5;
    // Warp threads are dyed indigo, weft threads stay white → the denim look.
    const col = w.warp ? indigo : weft;
    const shade = 0.55 + w.h * 0.62;
    _a[0] = col[0] * shade; _a[1] = col[1] * shade; _a[2] = col[2] * shade;
    // Ring-dyed yarn: colour varies along the thread.
    const dye = 0.86 + yarn * 0.28;
    if (w.warp) { _a[0] *= dye; _a[1] *= dye; _a[2] *= dye; }
    // Abrasion whiskers.
    const fade = N.fbm2p(u, v, 5, 3, 2, 0.5, seed + 21) * 0.5 + 0.5;
    mixRGB(_a, rgb3(0.72, 0.74, 0.76), sat(fade - 0.62) * 0.7, _a);

    b.setC(i, _a);
    b.height.data[i] = sat(w.h * 0.8 + yarn * 0.15);
    b.rough.data[i] = 0.88 - w.h * 0.05;
  });
  b.heightScale = 0.06;
  b.normalStrength = 1.15;
}

function paintFelt(b, rng, p) {
  const seed = p.seed ?? 1423;
  const base = hexRGB(p.color ?? 0x2f6b4a, _b);
  b.each((u, v, i) => {
    // Matted fibres: several stretched noises in different directions.
    const f1 = N.fibre(u, v, 300, 40, 1, 0, seed, 2) * 0.5 + 0.5;
    const f2 = N.fibre(u, v, 300, 40, 0, 1, seed + 3, 2) * 0.5 + 0.5;
    const f3 = N.fibre(u, v, 280, 36, 1, 1, seed + 7, 2) * 0.5 + 0.5;
    const f4 = N.fibre(u, v, 280, 36, 1, -1, seed + 11, 2) * 0.5 + 0.5;
    const fuzz = sat(Math.max(Math.max(f1, f2), Math.max(f3, f4)) * 1.1 - 0.15);
    const shade = 0.70 + fuzz * 0.48;
    _a[0] = sat(base[0] * shade); _a[1] = sat(base[1] * shade); _a[2] = sat(base[2] * shade);
    b.setC(i, _a);
    b.height.data[i] = fuzz;
    b.rough.data[i] = 0.96 - fuzz * 0.04;
  });
  b.heightScale = 0.05;
  b.normalStrength = 0.9;
}

function paintTablecloth(b, rng, p) {
  const seed = p.seed ?? 1427;
  const threads = p.threads ?? 120;
  const checks = p.checks ?? 8;
  const colA = hexRGB(p.color ?? 0xc0392b, _b);
  const white = hexRGB(0xf3ede0, _c);
  b.each((u, v, i) => {
    // Gingham = translucent stripes crossing.
    const su = N.stripes(u, v, checks, 0.5, 0.0015, 0);
    const sv = N.stripes(u, v, checks, 0.5, 0.0015, 1);
    const both = su * sv;
    const one = sat(su + sv - both * 2);
    mixRGB(white, colA, one * 0.55 + both * 1.0, _a);

    const w = N.weave(u, v, threads, 0.9, seed, 0);
    const shade = 0.60 + w.h * 0.55;
    _a[0] *= shade; _a[1] *= shade; _a[2] *= shade;

    b.setC(i, _a);
    b.height.data[i] = w.h * 0.85;
    b.rough.data[i] = 0.82 - w.h * 0.06;
  });
  b.heightScale = 0.05;
  b.normalStrength = 1.0;
}

// ── paper / wallpaper ──────────────────────────────────────────────────────

function paperBase(b, u, v, i, seed, tone) {
  const f1 = N.fibre(u, v, 260, 30, 1, 0, seed, 2) * 0.5 + 0.5;
  const f2 = N.fibre(u, v, 260, 30, 0, 1, seed + 5, 2) * 0.5 + 0.5;
  const grain = sat((f1 + f2) * 0.5 * 1.1 - 0.05);
  const k = 0.94 + grain * 0.10;
  _a[0] = sat(tone[0] * k); _a[1] = sat(tone[1] * k); _a[2] = sat(tone[2] * k);
  b.height.data[i] = 0.45 + grain * 0.25;
  b.rough.data[i] = 0.80 + grain * 0.08;
  return grain;
}

function paintGraphPaper(b, rng, p) {
  const seed = p.seed ?? 1511;
  const tone = hexRGB(p.color ?? 0xf4f2e6, _b);
  const ink = hexRGB(p.ink ?? 0x6f93b8, _c);
  const inkBold = hexRGB(0x4a6f96, _d);
  const minor = p.minor ?? 40;
  b.each((u, v, i) => {
    paperBase(b, u, v, i, seed, tone);
    const gu = 1 - N.stripes(u, v, minor, 0.965, 0.0006, 0);
    const gv = 1 - N.stripes(u, v, minor, 0.965, 0.0006, 1);
    const bu = 1 - N.stripes(u, v, minor / 5, 0.985, 0.0006, 0);
    const bv = 1 - N.stripes(u, v, minor / 5, 0.985, 0.0006, 1);
    const fine = Math.max(gu, gv), bold = Math.max(bu, bv);
    mixRGB(_a, ink, fine * 0.55, _a);
    mixRGB(_a, inkBold, bold * 0.8, _a);
    b.setC(i, _a);
    b.rough.data[i] = sat(b.rough.data[i] - Math.max(fine, bold) * 0.12);
  });
  b.heightScale = 0.012;
  b.normalStrength = 0.6;
}

function paintWallpaperStripe(b, rng, p) {
  const seed = p.seed ?? 1523;
  const tone = hexRGB(p.color ?? 0xe9e0cd, _b);
  const stripe = hexRGB(p.color2 ?? 0xc0ad8b, _c);
  const n = p.stripes ?? 6;
  b.each((u, v, i) => {
    paperBase(b, u, v, i, seed, tone);
    const wide = N.stripes(u, v, n, 0.42, 0.004, 0);
    const thin = N.stripes(u + 0.5 / n, v, n * 2, 0.06, 0.002, 0);
    // Damask sheen inside the wide stripe.
    const damask = N.fbm2p(u, v, 8, 3, 2, 0.5, seed + 7) * 0.5 + 0.5;
    mixRGB(_a, stripe, wide * (0.75 + damask * 0.25), _a);
    mixRGB(_a, scaleRGB(stripe, 0.7, _d), thin * 0.9, _a);
    b.setC(i, _a);
    b.height.data[i] += wide * 0.06 + thin * 0.05;
    b.rough.data[i] = sat(b.rough.data[i] - wide * 0.14);
  });
  b.heightScale = 0.015;
  b.normalStrength = 0.7;
}

function paintWallpaperFloralBase(b, rng, p) {
  const seed = p.seed ?? 1531;
  const tone = hexRGB(p.color ?? 0xefe6d6, _b);
  b.each((u, v, i) => { paperBase(b, u, v, i, seed, tone); b.setC(i, _a); });
  b.heightScale = 0.014;
  b.normalStrength = 0.6;
}

function overlayFloral(ctx, size, rng, p) {
  const cells = p.cells ?? 3;
  const step = size / cells;
  const petalCol = p.petal ?? '#c2607a';
  const petalCol2 = p.petal2 ?? '#e0a2b2';
  const leafCol = p.leaf ?? '#6f8b52';

  ctx.globalAlpha = 0.92;
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const cx = (gx + 0.5 + (gy & 1) * 0.5) * step;
      const cy = (gy + 0.5) * step;
      const r = step * (0.20 + rng.next() * 0.06);
      const rot = rng.next() * TAU;
      tileDraw(ctx, size, (c) => {
        // Leaves first.
        c.fillStyle = leafCol;
        for (let k = 0; k < 4; k++) {
          petalPath(c, cx, cy, r * 1.5, r * 0.34, rot + (k / 4) * TAU + 0.4);
          c.fill();
        }
        // Petals.
        c.fillStyle = petalCol;
        for (let k = 0; k < 6; k++) {
          petalPath(c, cx, cy, r * 1.15, r * 0.46, rot + (k / 6) * TAU);
          c.fill();
        }
        c.fillStyle = petalCol2;
        for (let k = 0; k < 6; k++) {
          petalPath(c, cx, cy, r * 0.7, r * 0.3, rot + (k / 6) * TAU + 0.5);
          c.fill();
        }
        c.fillStyle = '#e8c86a';
        c.beginPath(); c.arc(cx, cy, r * 0.2, 0, TAU); c.fill();
      });
    }
  }
  ctx.globalAlpha = 1;
}

// ── brick & drywall ────────────────────────────────────────────────────────

function paintBrick(b, rng, p) {
  const seed = p.seed ?? 1601;
  const cols = p.cols ?? 4, rows = p.rows ?? 10;
  const mortarCol = hexRGB(p.mortarColor ?? 0xbdb6a6, _d);
  const palette = (p.palette ?? [0x8f4032, 0xa1553f, 0x74362c, 0x9c6248, 0x633029]).map((h) => hexRGB(h));

  b.each((u, v, i) => {
    const cell = N.brickLayout(u, v, {
      cols, rows, rowOffset: 0.5, mortar: p.mortar ?? 0.07, jitter: 0.03, seed,
    });
    const col = palette[Math.floor(cell.r0 * palette.length) % palette.length];
    const grain = N.fbm2p(u, v, 90, 4, 2.2, 0.55, seed + cell.col * 5 + cell.row * 17) * 0.5 + 0.5;
    const shade = 0.80 + cell.r1 * 0.34 + grain * 0.16;
    _a[0] = sat(col[0] * shade); _a[1] = sat(col[1] * shade); _a[2] = sat(col[2] * shade);

    // Pitting and sand-faced texture.
    const pit = N.worley2(u * 90, v * 90, 90, seed + 3, 1).f1;
    const pits = 1 - N.sstep(0.10, 0.30, pit);
    mixRGB(_a, scaleRGB(_a, 0.6, _c), pits * 0.5, _a);

    const m = cell.mortar;
    const mg = N.fbm2p(u, v, 55, 3, 2, 0.5, seed + 11) * 0.5 + 0.5;
    mixRGB(_a, scaleRGB(mortarCol, 0.85 + mg * 0.3, _c), m, _a);

    b.setC(i, _a);
    b.height.data[i] = (1 - m) * sat(0.72 + grain * 0.16 - pits * 0.30) + m * (0.16 + mg * 0.12);
    b.rough.data[i] = sat(lerp(0.78 + pits * 0.12, 0.94, m));
  });
  b.heightScale = 0.13;
  b.normalStrength = 1.2;
}

function postBrick(b, rng) {
  const eff = new N.Field(b.size);
  N.stampDust(eff, rng, { count: 420, minRadius: 2, maxRadius: 14, value: 0.05, clumpFreq: 3 });
  const d = eff.data;
  for (let i = 0; i < d.length; i++) {
    const k = Math.min(0.35, d[i]);
    const j = i * 3;
    b.rgb[j] = sat(b.rgb[j] + k * 0.55);
    b.rgb[j + 1] = sat(b.rgb[j + 1] + k * 0.55);
    b.rgb[j + 2] = sat(b.rgb[j + 2] + k * 0.52);
  }
}

function paintDrywall(b, rng, p) {
  const seed = p.seed ?? 1607;
  const base = hexRGB(p.color ?? 0xe6e2da, _b);
  b.each((u, v, i) => {
    // Roller stipple: overlapping blobs at two scales.
    const s1 = N.worley2(u * 60, v * 60, 60, seed, 1).f1;
    const s2 = N.worley2(u * 130, v * 130, 130, seed + 7, 1).f1;
    const stip = sat((1 - N.sstep(0.05, 0.35, s1)) * 0.6 + (1 - N.sstep(0.05, 0.30, s2)) * 0.4);
    const drift = N.fbm2p(u, v, 4, 3, 2, 0.5, seed + 3) * 0.5 + 0.5;
    const k = 0.93 + stip * 0.10 + drift * 0.05;
    _a[0] = sat(base[0] * k); _a[1] = sat(base[1] * k); _a[2] = sat(base[2] * k);
    b.setC(i, _a);
    b.height.data[i] = sat(0.5 + stip * 0.35 + (drift - 0.5) * 0.15);
    b.rough.data[i] = sat(0.62 + stip * 0.12 + drift * 0.06);
  });
  b.heightScale = 0.02;
  b.normalStrength = 0.85;
}

// ── road ───────────────────────────────────────────────────────────────────

function paintTarmac(b, rng, p) {
  const seed = p.seed ?? 1709;
  const bitumen = hexRGB(0x2c2c2f, _b);
  const bitumenL = hexRGB(0x4a4a4e, _c);

  b.each((u, v, i) => {
    // Aggregate: a dense pack of chippings.
    const w1 = N.worley2(u * 44, v * 44, 44, seed, 1);
    const w2 = N.worley2(u * 90, v * 90, 90, seed + 13, 1);
    const st1 = 1 - N.sstep(0.08, 0.30, w1.f1);
    const st2 = 1 - N.sstep(0.06, 0.24, w2.f1);
    const stone = Math.max(st1, st2 * 0.8);
    const id = st1 >= st2 * 0.8 ? w1.cellId : w2.cellId;
    const r0 = ((id >>> 11) & 255) / 255;

    const binder = N.fbm2p(u, v, 30, 4, 2.2, 0.55, seed + 5) * 0.5 + 0.5;
    mixRGB(bitumen, bitumenL, binder * 0.55, _a);
    if (stone > 0.05) {
      const g = 0.30 + r0 * 0.35;
      mixRGB(_a, rgb3(g, g * 0.99, g * 0.97), stone * 0.8, _a);
    }
    // Polished wheel tracks (two dark bands) — only if requested.
    if (p.wheelTracks) {
      const t1 = Math.exp(-Math.pow((u - 0.28) / 0.10, 2));
      const t2 = Math.exp(-Math.pow((u - 0.72) / 0.10, 2));
      const tr = Math.min(1, t1 + t2);
      mixRGB(_a, scaleRGB(_a, 0.78, _d), tr * 0.7, _a);
      b.rough.data[i] = sat(0.88 - tr * 0.22 - stone * 0.05);
    } else {
      b.rough.data[i] = sat(0.90 - stone * 0.06 + (1 - binder) * 0.05);
    }
    b.setC(i, _a);
    b.height.data[i] = sat(0.42 + stone * 0.45 + (binder - 0.5) * 0.25);
  });
  b.heightScale = 0.10;
  b.normalStrength = 1.25;
}

function overlayLanePaint(ctx, size, rng, p) {
  const style = p.lane ?? 'dashed';
  const w = size * (p.laneWidth ?? 0.045);
  ctx.save();
  ctx.fillStyle = p.laneColor ?? 'rgba(238,236,226,0.94)';
  if (style === 'solid') {
    ctx.fillRect(size * 0.5 - w * 0.5, 0, w, size);
  } else if (style === 'double') {
    ctx.fillRect(size * 0.5 - w * 1.6, 0, w, size);
    ctx.fillRect(size * 0.5 + w * 0.6, 0, w, size);
  } else {
    const dash = size * 0.34, gap = size * 0.16;
    for (let y = -gap; y < size + dash; y += dash + gap) {
      ctx.fillRect(size * 0.5 - w * 0.5, y, w, dash);
    }
  }
  // Worn paint: erase noise from the stripe.
  ctx.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 260; k++) {
    const x = size * 0.5 + (rng.next() - 0.5) * w * 4;
    const y = rng.next() * size;
    const r = rng.next() * size * 0.012 + 1;
    ctx.globalAlpha = 0.25 + rng.next() * 0.6;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

// ── toy box ────────────────────────────────────────────────────────────────

function paintLego(b, rng, p) {
  const seed = p.seed ?? 1801;
  const n = p.studs ?? 4;
  const base = hexRGB(p.color ?? 0xd01012, _b);
  b.each((u, v, i) => {
    const s = N.studGrid(u, v, n, 0.30, 0.045, seed);
    // Ring on top of each stud (where the logo would be).
    const ring = s.d < 0.30 ? 1 - N.sstep(0.20, 0.24, s.d) : 0;
    const micro = N.fbm2p(u, v, 240, 2, 2.2, 0.5, seed + 3) * 0.5 + 0.5;
    // Shading: the stud sidewall catches a highlight.
    const wall = s.h > 0 && s.h < 1 ? 1 : 0;
    const k = 0.90 + s.h * 0.18 + micro * 0.06 - wall * 0.05;
    _a[0] = sat(base[0] * k); _a[1] = sat(base[1] * k); _a[2] = sat(base[2] * k);
    b.setC(i, _a);
    b.height.data[i] = sat(0.22 + s.h * 0.70 + ring * 0.05 + micro * 0.04);
    b.rough.data[i] = sat(0.16 + micro * 0.05);
  });
  b.heightScale = 0.28;
  b.normalStrength = 1.5;
}

function paintBoardGameBase(b, rng, p) {
  const seed = p.seed ?? 1811;
  const tone = hexRGB(p.color ?? 0xe8dcbe, _b);
  b.each((u, v, i) => {
    const grain = paperBase(b, u, v, i, seed, tone);
    // Board card is thicker: slight quilting from the press.
    const press = N.fbm2p(u, v, 7, 3, 2, 0.5, seed + 5) * 0.5 + 0.5;
    const k = 0.97 + press * 0.06;
    _a[0] *= k; _a[1] *= k; _a[2] *= k;
    b.setC(i, _a);
    b.rough.data[i] = sat(0.42 + grain * 0.16);
  });
  b.heightScale = 0.012;
  b.normalStrength = 0.5;
}

function overlayBoardGame(ctx, size, rng, p) {
  const cols = p.cells ?? 8;
  const step = size / cols;
  const colours = p.colors ?? ['#d84a3c', '#3f7fbf', '#e8b93a', '#4fa262', '#8d5bb0'];
  const inset = step * 0.12;

  // A racetrack ring of spaces around the edge.
  ctx.save();
  ctx.lineWidth = Math.max(1, size * 0.004);
  ctx.strokeStyle = 'rgba(60,48,32,0.55)';
  const drawCell = (cx, cy, idx) => {
    const col = colours[idx % colours.length];
    roundRect(ctx, cx + inset, cy + inset, step - inset * 2, step - inset * 2, step * 0.14);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.88;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    // Little pip.
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.arc(cx + step * 0.5, cy + step * 0.5, step * 0.10, 0, TAU);
    ctx.fill();
  };
  let idx = 0;
  for (let x = 0; x < cols; x++) drawCell(x * step, 0, idx++);
  for (let y = 1; y < cols; y++) drawCell((cols - 1) * step, y * step, idx++);
  for (let x = cols - 2; x >= 0; x--) drawCell(x * step, (cols - 1) * step, idx++);
  for (let y = cols - 2; y >= 1; y--) drawCell(0, y * step, idx++);

  // Centre panel with a title.
  const m = step * 1.35;
  roundRect(ctx, m, m, size - m * 2, size - m * 2, step * 0.2);
  ctx.fillStyle = 'rgba(246,238,214,0.92)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(80,60,36,0.6)';
  ctx.stroke();
  drawVectorText(ctx, p.title ?? 'RC RUMBLE', size * 0.5, size * 0.42,
    { size: size * 0.075, align: 'center', color: '#5a3f22', weight: 0.16, tracking: 1.6 });
  drawVectorText(ctx, p.subtitle ?? 'THE BOARD GAME', size * 0.5, size * 0.54,
    { size: size * 0.038, align: 'center', color: '#8a6a44', weight: 0.14, tracking: 2.0 });
  // Compass rose.
  ctx.globalAlpha = 0.35;
  starPath(ctx, size * 0.5, size * 0.68, 4, size * 0.075, size * 0.022);
  ctx.fillStyle = '#8a6a44';
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}

function paintCardBase(b, rng, p) {
  const seed = p.seed ?? 1823;
  const tone = hexRGB(0xfaf7ef, _b);
  b.each((u, v, i) => {
    paperBase(b, u, v, i, seed, tone);
    b.setC(i, _a);
    b.rough.data[i] = 0.30 + b.height.data[i] * 0.12;
  });
  b.heightScale = 0.008;
  b.normalStrength = 0.4;
}

function overlayPlayingCard(ctx, size, rng, p) {
  const suit = p.suit ?? 'spade';
  const rank = p.rank ?? 'A';
  const red = suit === 'heart' || suit === 'diamond';
  const col = red ? '#c0392b' : '#1e1e24';

  ctx.save();
  // Card edge + border.
  roundRect(ctx, size * 0.03, size * 0.03, size * 0.94, size * 0.94, size * 0.07);
  ctx.fillStyle = 'rgba(252,250,245,1)';
  ctx.fill();
  ctx.lineWidth = size * 0.006;
  ctx.strokeStyle = 'rgba(150,140,120,0.7)';
  ctx.stroke();
  ctx.clip();

  // Corner indices (top-left and rotated bottom-right).
  const drawIndex = (x, y, rot) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    drawVectorText(ctx, rank, 0, 0, { size: size * 0.13, align: 'center', color: col, weight: 0.17 });
    drawSuit(ctx, suit, 0, size * 0.20, size * 0.048, col);
    ctx.restore();
  };
  drawIndex(size * 0.14, size * 0.09, 0);
  drawIndex(size * 0.86, size * 0.91, Math.PI);

  // Centre pip layout.
  const pips = { A: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 }[rank] ?? 0;
  if (pips === 1) {
    drawSuit(ctx, suit, size * 0.5, size * 0.5, size * 0.20, col);
  } else if (pips > 0) {
    const colsX = pips <= 3 ? [0.5] : [0.35, 0.65];
    const rowsN = Math.ceil(pips / colsX.length);
    let k = 0;
    for (let r = 0; r < rowsN; r++) {
      for (let c = 0; c < colsX.length && k < pips; c++, k++) {
        const y = 0.25 + (rowsN === 1 ? 0.25 : (r / (rowsN - 1)) * 0.5);
        drawSuit(ctx, suit, size * colsX[c], size * y, size * 0.062, col);
      }
    }
  } else {
    // Face card: a simple heraldic panel.
    roundRect(ctx, size * 0.24, size * 0.20, size * 0.52, size * 0.60, size * 0.03);
    ctx.strokeStyle = col; ctx.lineWidth = size * 0.008; ctx.stroke();
    ctx.globalAlpha = 0.15; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    drawVectorText(ctx, rank, size * 0.5, size * 0.36, { size: size * 0.2, align: 'center', color: col, weight: 0.16 });
    drawSuit(ctx, suit, size * 0.5, size * 0.66, size * 0.10, col);
  }

  // Wear: soft dirt at the corners + a crease.
  ctx.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 90; i++) {
    const x = rng.next() * size, y = rng.next() * size;
    const edge = Math.min(Math.min(x, size - x), Math.min(y, size - y)) / size;
    if (rng.next() < edge * 3) continue;
    ctx.globalAlpha = 0.05 + rng.next() * 0.08;
    ctx.fillStyle = '#b8ac92';
    ctx.beginPath(); ctx.arc(x, y, size * (0.01 + rng.next() * 0.05), 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

function paintDiceBase(b, rng, p) {
  const seed = p.seed ?? 1831;
  const base = hexRGB(p.color ?? 0xf2efe6, _b);
  b.each((u, v, i) => {
    const micro = N.fbm2p(u, v, 220, 2, 2.2, 0.5, seed) * 0.5 + 0.5;
    const swirl = N.fbm2p(u, v, 9, 3, 2, 0.5, seed + 5) * 0.5 + 0.5;
    const k = 0.95 + micro * 0.07 + swirl * 0.04;
    _a[0] = sat(base[0] * k); _a[1] = sat(base[1] * k); _a[2] = sat(base[2] * k);
    b.setC(i, _a);
    b.height.data[i] = 0.72 + (micro - 0.5) * 0.1;
    b.rough.data[i] = sat(0.13 + micro * 0.05);
  });
  b.heightScale = 0.14;
  b.normalStrength = 1.4;
}

/** Pip layouts for faces 1-6, in a 3×3 grid (col,row) in [0,2]. */
const PIP_LAYOUT = [
  [[1, 1]],
  [[0, 0], [2, 2]],
  [[0, 0], [1, 1], [2, 2]],
  [[0, 0], [2, 0], [0, 2], [2, 2]],
  [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
];

function overlayDice(ctx, size, rng, p) {
  const face = Math.max(1, Math.min(6, p.face ?? 1));
  const layout = PIP_LAYOUT[face - 1];
  const r = size * (p.pipRadius ?? 0.09);
  ctx.save();
  for (const [cx, cy] of layout) {
    const x = size * (0.26 + cx * 0.24);
    const y = size * (0.26 + cy * 0.24);
    // Pip = a dished hole: dark centre with a light rim.
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, p.pipColor ?? '#1c1c22');
    g.addColorStop(0.75, p.pipColor ?? '#1c1c22');
    g.addColorStop(1, 'rgba(90,90,100,0.85)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function paintAlphabetBlockBase(b, rng, p) {
  const seed = p.seed ?? 1847;
  const pal = WOOD_PALETTES[p.palette ?? 'maple'];
  const wp = { ...WOOD_DEFAULTS, rings: 6, ringContrast: 0.5, poreStrength: 0.25 };
  b.each((u, v, i) => {
    woodSubstance(u, v, pal, wp, seed, _a);
    b.setC(i, _a);
    b.height.data[i] = _woodOut.h;
    b.rough.data[i] = 0.35 + _woodOut.rough * 0.3;
  });
  b.heightScale = 0.04;
}

function overlayAlphabetBlock(ctx, size, rng, p) {
  const letter = (p.letter ?? 'A').toString().charAt(0);
  const col = p.letterColor ?? '#c0392b';
  ctx.save();
  // Painted border frame.
  ctx.strokeStyle = p.frameColor ?? '#2f6bb0';
  ctx.lineWidth = size * 0.05;
  ctx.strokeRect(size * 0.10, size * 0.10, size * 0.80, size * 0.80);
  // Big painted letter.
  drawVectorText(ctx, letter, size * 0.5, size * 0.26, {
    size: size * 0.48, align: 'center', color: col, weight: 0.2,
  });
  // Paint wear — chip the letter where the block has been chewed.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 160; i++) {
    ctx.globalAlpha = 0.15 + rng.next() * 0.6;
    ctx.beginPath();
    ctx.arc(rng.next() * size, rng.next() * size, size * (0.004 + rng.next() * 0.02), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

// ── hazard ─────────────────────────────────────────────────────────────────

function paintOilSlick(b, rng, p) {
  const seed = p.seed ?? 1901;
  b.each((u, v, i) => {
    const w = N.warp2(u, v, 0.10, 3, seed, 1, 3);
    const film = N.fbm2p(w.u, w.v, 5, 4, 2.1, 0.55, seed) * 0.5 + 0.5;
    const swirl = N.fbm2p(u, v, 16, 3, 2, 0.5, seed + 7) * 0.5 + 0.5;
    // Thin-film interference: cycle hue with the film thickness.
    hslRGB(frac(film * 1.7 + swirl * 0.4), 0.55, 0.16 + film * 0.14, _a);
    b.setC(i, _a);
    b.height.data[i] = 0.5 + (film - 0.5) * 0.3;
    b.rough.data[i] = sat(0.05 + swirl * 0.06);
    b.metal.data[i] = 0.25;
  });
  b.heightScale = 0.01;
  b.normalStrength = 0.5;
}

// ══════════════════════════════════════════════════════════ CATALOGUE
//
// Surface ids are the canonical ones from ARCHITECTURE.md:
//   0 default · 1 wood · 2 carpet · 3 tile · 4 concrete · 5 grass · 6 dirt
//   7 gravel · 8 sand · 9 water_shallow · 10 ice · 11 metal · 12 plastic
//   13 rubber · 14 glass · 15 oil_slick
//
// `physicalSize` = the number of metres one texture tile covers in the world.
// Materials.js uses it to keep texel density constant across the whole game.

/** @typedef {object} TextureDef */
export const TEXTURE_DEFS = {
  // ── wood ────────────────────────────────────────────────────────────────
  'wood/parquet': {
    family: 'wood', surfaceId: 1, physicalSize: 1.2, res: 0.5, seed: 1001,
    tags: ['floor', 'indoor', 'museum', 'warm', 'hero'],
    paint: paintParquet, post: postParquet,
    params: { blocks: 8, mode: 'herringbone', palette: 'oak', palette2: 'walnut', mix: 0.28, bevel: 0.07, stretch: 1.0 },
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.45, clearcoatRoughness: 0.22, envMapIntensity: 1.0 },
  },
  'wood/parquet_basket': {
    family: 'wood', surfaceId: 1, physicalSize: 1.2, res: 0.375, seed: 1002,
    tags: ['floor', 'indoor', 'museum', 'warm'],
    paint: paintParquet, post: postParquet,
    params: { blocks: 8, mode: 'basket', palette: 'beech', palette2: 'oak', mix: 0.3, bevel: 0.07 },
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.40, clearcoatRoughness: 0.24 },
  },
  'wood/oak_planks': {
    family: 'wood', surfaceId: 1, physicalSize: 1.5, res: 0.5, seed: 1011,
    tags: ['floor', 'indoor', 'plank', 'warm', 'hero'],
    paint: paintPlanks, post: postParquet,
    params: { rows: 6, perRow: 2, palette: 'oak', gap: 0.005, satin: 0.85, stretch: 1.8 },
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.35 },
  },
  'wood/pine_planks': {
    family: 'wood', surfaceId: 1, physicalSize: 1.5, res: 0.375, seed: 1013,
    tags: ['floor', 'crate', 'plank', 'light'],
    paint: paintPlanks,
    params: { rows: 5, perRow: 2, palette: 'pine', gap: 0.008, satin: 1.0, stretch: 1.6, gapColor: 0x3a2a16 },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'wood/plywood_varnish': {
    family: 'wood', surfaceId: 1, physicalSize: 1.2, res: 0.375, seed: 1021,
    tags: ['ramp', 'prop', 'varnish', 'glossy'],
    paint: paintPlywood, post: postPlywood,
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.12 },
  },
  'wood/mdf': {
    family: 'wood', surfaceId: 1, physicalSize: 1.0, res: 0.25, seed: 1031,
    tags: ['furniture', 'matte', 'prop'],
    paint: paintMDF,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },

  // ── carpet & fabric ─────────────────────────────────────────────────────
  'carpet/loop_pile': {
    family: 'carpet', surfaceId: 2, physicalSize: 1.0, res: 0.5, seed: 2001,
    tags: ['floor', 'indoor', 'soft', 'hero'],
    paint: paintCarpetLoop,
    params: { color: 0x8c3b3b, loops: 56 },
    material: { kind: 'physical', roughness: 1, metalness: 0, sheen: 0.6, sheenRoughness: 0.85, sheenColor: 0xffd9c0 },
  },
  'carpet/cut_pile': {
    family: 'carpet', surfaceId: 2, physicalSize: 1.0, res: 0.375, seed: 2011,
    tags: ['floor', 'indoor', 'soft'],
    paint: paintCarpetCut,
    params: { color: 0x6a6f5c },
    material: { kind: 'physical', roughness: 1, metalness: 0, sheen: 0.75, sheenRoughness: 0.7, sheenColor: 0xfff0dd },
  },
  'carpet/rug_woven': {
    family: 'carpet', surfaceId: 2, physicalSize: 1.6, res: 0.5, seed: 2021,
    tags: ['rug', 'prop', 'pattern', 'indoor'],
    paint: paintRug,
    material: { kind: 'physical', roughness: 1, metalness: 0, sheen: 0.4, sheenRoughness: 0.8 },
  },
  'fabric/denim': {
    family: 'fabric', surfaceId: 2, physicalSize: 0.5, res: 0.375, seed: 2101,
    tags: ['cloth', 'prop', 'blue'],
    paint: paintDenim,
    material: { kind: 'physical', roughness: 1, metalness: 0, sheen: 0.35, sheenRoughness: 0.9 },
  },
  'fabric/felt': {
    family: 'fabric', surfaceId: 2, physicalSize: 0.4, res: 0.25, seed: 2111,
    tags: ['cloth', 'toy', 'matte'],
    paint: paintFelt,
    params: { color: 0x2f6b4a },
    material: { kind: 'physical', roughness: 1, metalness: 0, sheen: 0.9, sheenRoughness: 0.95 },
  },
  'fabric/tablecloth_check': {
    family: 'fabric', surfaceId: 2, physicalSize: 0.9, res: 0.375, seed: 2121,
    tags: ['cloth', 'kitchen', 'pattern'],
    paint: paintTablecloth,
    material: { kind: 'physical', roughness: 1, metalness: 0, sheen: 0.5, sheenRoughness: 0.85 },
  },

  // ── tile ────────────────────────────────────────────────────────────────
  'tile/ceramic_glazed': {
    family: 'tile', surfaceId: 3, physicalSize: 1.2, res: 0.5, seed: 3001,
    tags: ['floor', 'indoor', 'shiny', 'hero'],
    paint: paintCeramicTile, post: postCeramicTile,
    params: { tiles: 4, mortar: 0.035, offset: 0 },
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.08 },
  },
  'tile/lino_check': {
    family: 'tile', surfaceId: 3, physicalSize: 2.4, res: 0.5, seed: 3011,
    tags: ['floor', 'indoor', 'checker', 'hero'],
    paint: paintLinoCheck, post: postLino,
    params: { checks: 8 },
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.20 },
  },
  'tile/mosaic': {
    family: 'tile', surfaceId: 3, physicalSize: 0.8, res: 0.375, seed: 3021,
    tags: ['floor', 'wall', 'pool', 'pattern'],
    paint: paintMosaic,
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.1 },
  },

  // ── concrete ────────────────────────────────────────────────────────────
  'concrete/poured': {
    family: 'concrete', surfaceId: 4, physicalSize: 2.0, res: 0.5, seed: 4001,
    tags: ['floor', 'outdoor', 'grey', 'hero'],
    paint: paintConcretePoured, post: postConcretePoured,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'concrete/screed': {
    family: 'concrete', surfaceId: 4, physicalSize: 2.0, res: 0.375, seed: 4011,
    tags: ['floor', 'indoor', 'smooth'],
    paint: paintConcreteScreed,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'concrete/rough': {
    family: 'concrete', surfaceId: 4, physicalSize: 1.6, res: 0.375, seed: 4021,
    tags: ['wall', 'outdoor', 'rough'],
    paint: paintConcreteRough, post: postConcreteRough,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'drywall/painted': {
    family: 'concrete', surfaceId: 4, physicalSize: 1.5, res: 0.25, seed: 4031,
    tags: ['wall', 'indoor', 'paint'],
    paint: paintDrywall,
    params: { color: 0xe6e2da },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'brick/red': {
    family: 'brick', surfaceId: 4, physicalSize: 0.9, res: 0.5, seed: 4101,
    tags: ['wall', 'outdoor', 'garden'],
    paint: paintBrick, post: postBrick,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },

  // ── road ────────────────────────────────────────────────────────────────
  'road/tarmac': {
    family: 'road', surfaceId: 4, physicalSize: 2.0, res: 0.5, seed: 4201,
    tags: ['road', 'outdoor', 'asphalt', 'hero'],
    paint: paintTarmac,
    params: { wheelTracks: true },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'road/tarmac_lane': {
    family: 'road', surfaceId: 4, physicalSize: 3.0, res: 0.5, seed: 4211,
    tags: ['road', 'outdoor', 'asphalt', 'markings'],
    paint: paintTarmac, overlay: overlayLanePaint,
    params: { wheelTracks: true, lane: 'dashed', laneWidth: 0.045 },
    inkRough: 0.55, inkHeight: 0.02,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },

  // ── nature ──────────────────────────────────────────────────────────────
  'grass/lawn': {
    family: 'grass', surfaceId: 5, physicalSize: 1.0, res: 0.5, seed: 5001,
    tags: ['ground', 'outdoor', 'garden', 'hero'],
    paint: paintGrass,
    params: { density: 0.055, bladeLen: 0.036 },
    ao: { radius: 0.03, strength: 0.9 },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'dirt/ground': {
    family: 'dirt', surfaceId: 6, physicalSize: 1.5, res: 0.5, seed: 6001,
    tags: ['ground', 'outdoor', 'garden'],
    paint: paintDirt, post: postDirt,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'gravel/bed': {
    family: 'gravel', surfaceId: 7, physicalSize: 1.0, res: 0.5, seed: 7001,
    tags: ['ground', 'outdoor', 'loose'],
    paint: paintGravel,
    params: { stones: 22 },
    ao: { radius: 0.05, strength: 1.1 },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'sand/beach': {
    family: 'sand', surfaceId: 8, physicalSize: 2.0, res: 0.375, seed: 8001,
    tags: ['ground', 'outdoor', 'loose'],
    paint: paintSand,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'water/shallow': {
    family: 'water', surfaceId: 9, physicalSize: 3.0, res: 0.375, seed: 9001,
    tags: ['water', 'animated', 'transparent'],
    paint: paintWaterLayer,
    params: { swell: 0.55, chop: 0.32, micro: 0.16, chopFreq: 22, microFreq: 90 },
    ao: { strength: 0 },
    material: {
      kind: 'physical', roughness: 1, metalness: 0,
      transmission: 0.92, thickness: 0.25, ior: 1.333,
      attenuationColor: 0x1f6f6a, attenuationDistance: 0.9,
      clearcoat: 1.0, clearcoatRoughness: 0.02,
      transparent: true, opacity: 1, animated: 'water', doubleSided: true,
    },
  },
  'water/layer_b': {
    family: 'water', surfaceId: 9, physicalSize: 1.7, res: 0.25, seed: 9011,
    tags: ['water', 'animated', 'internal'],
    paint: paintWaterLayer,
    params: { swell: 0.45, chop: 0.40, micro: 0.25, chopFreq: 34, microFreq: 140, waves: [[-8, 5, 1.0], [6, 9, 0.6]] },
    ao: { strength: 0 },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'ice/cracked': {
    family: 'ice', surfaceId: 10, physicalSize: 2.5, res: 0.5, seed: 10001,
    tags: ['ground', 'slippery', 'shiny', 'hero'],
    paint: paintIceCracked,
    material: {
      kind: 'physical', roughness: 1, metalness: 0,
      clearcoat: 1.0, clearcoatRoughness: 0.04,
      transmission: 0.35, thickness: 0.4, ior: 1.31,
      attenuationColor: 0x9fd8ea, attenuationDistance: 1.2, transparent: true,
    },
  },
  'ice/frosted': {
    family: 'ice', surfaceId: 10, physicalSize: 1.2, res: 0.375, seed: 10011,
    tags: ['ground', 'slippery', 'frost'],
    paint: paintIceFrosted,
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.4 },
  },

  // ── metal ───────────────────────────────────────────────────────────────
  'metal/brushed_alu': {
    family: 'metal', surfaceId: 11, physicalSize: 1.0, res: 0.375, seed: 11001,
    tags: ['metal', 'shiny', 'prop', 'hero'],
    paint: paintBrushedAlu, post: postBrushedAlu,
    material: { kind: 'standard', roughness: 1, metalness: 1, envMapIntensity: 1.25 },
  },
  'metal/galvanised': {
    family: 'metal', surfaceId: 11, physicalSize: 1.2, res: 0.375, seed: 11011,
    tags: ['metal', 'industrial', 'spangle'],
    paint: paintGalvanised,
    material: { kind: 'standard', roughness: 1, metalness: 1, envMapIntensity: 1.1 },
  },
  'metal/painted': {
    family: 'metal', surfaceId: 11, physicalSize: 1.0, res: 0.375, seed: 11021,
    tags: ['metal', 'paint', 'prop', 'worn'],
    paint: paintPaintedMetal,
    params: { color: 0xc23b2e, wear: 1 },
    material: { kind: 'physical', roughness: 1, metalness: 1, clearcoat: 0.3, clearcoatRoughness: 0.3 },
  },
  'metal/chrome': {
    family: 'metal', surfaceId: 11, physicalSize: 0.8, res: 0.25, seed: 11031,
    tags: ['metal', 'mirror', 'trim'],
    paint: paintChrome, post: postChrome,
    material: { kind: 'standard', roughness: 1, metalness: 1, envMapIntensity: 1.6 },
  },
  'metal/rust': {
    family: 'metal', surfaceId: 11, physicalSize: 1.2, res: 0.5, seed: 11041,
    tags: ['metal', 'rust', 'worn', 'outdoor'],
    paint: paintRust,
    material: { kind: 'standard', roughness: 1, metalness: 1 },
  },
  'metal/diamond_plate': {
    family: 'metal', surfaceId: 11, physicalSize: 0.9, res: 0.375, seed: 11051,
    tags: ['metal', 'ramp', 'grip', 'industrial'],
    paint: paintDiamondPlate,
    params: { cells: 6 },
    ao: { radius: 0.04, strength: 1.0 },
    material: { kind: 'standard', roughness: 1, metalness: 1, envMapIntensity: 1.1 },
  },

  // ── plastic ─────────────────────────────────────────────────────────────
  'plastic/abs_matte': {
    family: 'plastic', surfaceId: 12, physicalSize: 0.5, res: 0.25, seed: 12001,
    tags: ['toy', 'plastic', 'matte', 'hero'],
    paint: paintABSMatte,
    params: { color: 0xd8443c },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'plastic/injection_gloss': {
    family: 'plastic', surfaceId: 12, physicalSize: 0.5, res: 0.25, seed: 12011,
    tags: ['toy', 'plastic', 'glossy'],
    paint: paintABSGloss,
    params: { color: 0x2f6fd0 },
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.65, clearcoatRoughness: 0.06 },
  },
  'plastic/translucent': {
    family: 'plastic', surfaceId: 12, physicalSize: 0.4, res: 0.25, seed: 12021,
    tags: ['toy', 'plastic', 'transparent'],
    paint: paintTranslucentPlastic,
    params: { color: 0x54d6c0 },
    material: {
      kind: 'physical', roughness: 1, metalness: 0, transmission: 0.7, thickness: 0.15,
      ior: 1.49, transparent: true, clearcoat: 0.5, clearcoatRoughness: 0.08,
    },
  },

  // ── rubber ──────────────────────────────────────────────────────────────
  'rubber/tyre_tread': {
    family: 'rubber', surfaceId: 13, physicalSize: 0.5, res: 0.375, seed: 13001,
    tags: ['rubber', 'tyre', 'grip', 'hero'],
    paint: paintTyreTread,
    ao: { radius: 0.05, strength: 1.2 },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'rubber/floor_mat': {
    family: 'rubber', surfaceId: 13, physicalSize: 0.6, res: 0.375, seed: 13011,
    tags: ['rubber', 'floor', 'grip'],
    paint: paintRubberMat,
    params: { nubs: 18, color: 0x2c2f33 },
    ao: { radius: 0.05, strength: 1.1 },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },

  // ── glass ───────────────────────────────────────────────────────────────
  'glass/clear': {
    family: 'glass', surfaceId: 14, physicalSize: 1.5, res: 0.25, seed: 14001,
    tags: ['glass', 'transparent', 'hero'],
    paint: paintGlassClear, post: postGlassClear,
    ao: { strength: 0 },
    material: {
      kind: 'physical', roughness: 1, metalness: 0, transmission: 0.98, thickness: 0.06,
      ior: 1.52, transparent: true, clearcoat: 1, clearcoatRoughness: 0.02, doubleSided: true,
    },
  },
  'glass/frosted': {
    family: 'glass', surfaceId: 14, physicalSize: 1.0, res: 0.25, seed: 14011,
    tags: ['glass', 'translucent'],
    paint: paintGlassFrosted,
    ao: { strength: 0 },
    material: {
      kind: 'physical', roughness: 1, metalness: 0, transmission: 0.85, thickness: 0.10,
      ior: 1.52, transparent: true, doubleSided: true,
    },
  },

  // ── paper & card ────────────────────────────────────────────────────────
  'cardboard/kraft': {
    family: 'cardboard', surfaceId: 0, physicalSize: 0.6, res: 0.375, seed: 15001,
    tags: ['box', 'prop', 'paper'],
    paint: paintKraft,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'cardboard/corrugated': {
    family: 'cardboard', surfaceId: 0, physicalSize: 0.3, res: 0.375, seed: 15011,
    tags: ['box', 'prop', 'edge'],
    paint: paintCorrugated,
    ao: { radius: 0.04, strength: 1.2 },
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'paper/graph': {
    family: 'paper', surfaceId: 0, physicalSize: 0.3, res: 0.375, seed: 15101,
    tags: ['paper', 'prop', 'desk'],
    paint: paintGraphPaper,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'wallpaper/striped': {
    family: 'paper', surfaceId: 0, physicalSize: 0.53, res: 0.375, seed: 15111,
    tags: ['wall', 'indoor', 'pattern'],
    paint: paintWallpaperStripe,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },
  'wallpaper/floral': {
    family: 'paper', surfaceId: 0, physicalSize: 0.53, res: 0.375, seed: 15121,
    tags: ['wall', 'indoor', 'pattern', 'flowers'],
    paint: paintWallpaperFloralBase, overlay: overlayFloral,
    params: { cells: 3 },
    inkRough: 0.55, inkHeight: 0.01,
    material: { kind: 'standard', roughness: 1, metalness: 0 },
  },

  // ── toy box ─────────────────────────────────────────────────────────────
  'toy/lego_studs': {
    family: 'toy', surfaceId: 12, physicalSize: 0.032, res: 0.25, seed: 16001,
    tags: ['toy', 'brick', 'studs', 'plastic'],
    paint: paintLego,
    params: { studs: 4, color: 0xd01012 },
    ao: { radius: 0.07, strength: 1.15 },
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.08 },
  },
  'toy/board_game': {
    family: 'toy', surfaceId: 0, physicalSize: 0.45, res: 0.5, seed: 16011,
    tags: ['toy', 'board', 'print', 'floor'],
    paint: paintBoardGameBase, overlay: overlayBoardGame,
    params: { cells: 8, title: 'RC RUMBLE', subtitle: 'THE BOARD GAME' },
    inkRough: 0.32, inkHeight: 0.006,
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.25 },
  },
  'toy/playing_card': {
    family: 'toy', surfaceId: 0, physicalSize: 0.09, res: 0.375, seed: 16021,
    tags: ['toy', 'card', 'print'],
    paint: paintCardBase, overlay: overlayPlayingCard,
    params: { suit: 'spade', rank: 'A' },
    inkRough: 0.28, inkHeight: 0.004,
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.2 },
  },
  'toy/dice_pips': {
    family: 'toy', surfaceId: 12, physicalSize: 0.02, res: 0.25, seed: 16031,
    tags: ['toy', 'dice', 'plastic'],
    paint: paintDiceBase, overlay: overlayDice,
    params: { face: 1, color: 0xf2efe6 },
    inkRough: 0.2, inkHeight: -0.05,
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.05 },
  },
  'toy/alphabet_block': {
    family: 'toy', surfaceId: 1, physicalSize: 0.045, res: 0.25, seed: 16041,
    tags: ['toy', 'wood', 'letter', 'print'],
    paint: paintAlphabetBlockBase, overlay: overlayAlphabetBlock,
    params: { letter: 'A', palette: 'maple' },
    inkRough: 0.4, inkHeight: 0.008,
    material: { kind: 'physical', roughness: 1, metalness: 0, clearcoat: 0.25, clearcoatRoughness: 0.3 },
  },

  // ── hazard ──────────────────────────────────────────────────────────────
  'hazard/oil_slick': {
    family: 'hazard', surfaceId: 15, physicalSize: 1.0, res: 0.25, seed: 17001,
    tags: ['hazard', 'slippery', 'iridescent'],
    paint: paintOilSlick,
    ao: { strength: 0.3 },
    material: {
      kind: 'physical', roughness: 1, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.03,
      iridescence: 1.0, iridescenceIOR: 1.6, iridescenceThicknessRange: [120, 620],
    },
  },
};

for (const k in TEXTURE_DEFS) TEXTURE_DEFS[k].name = k;

/** Every catalogue key. */
export function listTextures() { return Object.keys(TEXTURE_DEFS); }
/** Look up a def (or undefined). */
export function getTextureDef(name) { return TEXTURE_DEFS[name]; }

// ══════════════════════════════════════════════════════════ BUILD PIPELINE

const _warned = new Set();
function warnOnce(msg) {
  if (_warned.has(msg)) return;
  _warned.add(msg);
  console.warn('[ProceduralTextures]', msg);
}

/** Make a CanvasTexture from an RGBA buffer, registered in the asset cache. */
function bufferTexture(assets, key, buf, size, srgb) {
  return assets.texture(key, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    img.data.set(buf);
    ctx.putImageData(img, 0, 0);
  }, { size, srgb });
}

/**
 * @typedef {object} TextureSet
 * @property {THREE.Texture} map            base colour (sRGB, alpha where relevant)
 * @property {THREE.Texture} normalMap      tangent-space normal (linear)
 * @property {THREE.Texture} ormMap         R = AO, G = roughness, B = metalness
 * @property {THREE.Texture} roughnessMap   === ormMap (three reads .g)
 * @property {THREE.Texture} metalnessMap   === ormMap (three reads .b)
 * @property {THREE.Texture} aoMap          === ormMap (three reads .r)
 * @property {THREE.Texture|null} emissiveMap
 * @property {Float32Array} height          displacement height field, [0,1]
 * @property {number} size
 * @property {boolean} hasAlpha
 * @property {TextureDef} def
 */

/**
 * Build the full PBR set for a catalogue entry. Prefer {@link textureSet},
 * which memoises this.
 *
 * @param {import('../core/Assets.js').Assets} assets
 * @param {string} name catalogue key
 * @param {{size?:number, seed?:number, tint?:number, recolor?:number,
 *          params?:object, key?:string, normalStrength?:number}} [opts]
 * @returns {TextureSet}
 */
export function buildTextureSet(assets, name, opts = {}) {
  const def = TEXTURE_DEFS[name];
  if (!def) {
    warnOnce(`unknown texture "${name}" — using fallback`);
    return fallbackSet(assets);
  }

  const size = opts.size ?? texSize(def.res ?? 0.375);
  const key = opts.key ?? `pt:${name}@${size}`;
  const seed = (opts.seed ?? def.seed ?? 1) | 0;
  const params = Object.assign({}, def.params, opts.params, { seed });
  const rng = new RNG(seed ^ 0x5f3a3c1d);
  const bake = new Bake(size);

  try {
    // 1 ─ per-texel base pass
    def.paint?.(bake, rng, params);

    // 2 ─ canvas overlay pass (printed graphics), composited by its own alpha
    if (def.overlay) {
      const c = makeCanvas(size);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, size, size);
      def.overlay(ctx, size, rng, params, bake);
      const img = ctx.getImageData(0, 0, size, size).data;
      const inkRough = def.inkRough ?? 0.35;
      const inkH = def.inkHeight ?? 0.01;
      const rgb = bake.rgb, rd = bake.rough.data, hd = bake.height.data;
      for (let i = 0, p4 = 0; i < bake.n2; i++, p4 += 4) {
        const a = img[p4 + 3] / 255;
        if (a <= 0) continue;
        const j = i * 3;
        rgb[j] += ((img[p4] / 255) - rgb[j]) * a;
        rgb[j + 1] += ((img[p4 + 1] / 255) - rgb[j + 1]) * a;
        rgb[j + 2] += ((img[p4 + 2] / 255) - rgb[j + 2]) * a;
        rd[i] += (inkRough - rd[i]) * a;
        hd[i] = sat(hd[i] + inkH * a);
      }
    }

    // 3 ─ wear / filter pass
    def.post?.(bake, rng, params);

    // 4 ─ recolour hooks
    if (opts.recolor != null) bake.recolor(opts.recolor, opts.recolorKeep ?? 0.3);
    if (opts.tint != null) bake.tint(opts.tint);
  } catch (err) {
    warnOnce(`"${name}" painter threw: ${err?.message ?? err}`);
    console.error(err);
  }

  return finishBake(assets, key, bake, def, opts);
}

/** Turn a finished {@link Bake} into GPU textures. */
function finishBake(assets, key, bake, def, opts = {}) {
  const size = bake.size, n2 = bake.n2;

  // ── base colour (+ alpha) ────────────────────────────────────────────────
  const rgba = new Uint8ClampedArray(n2 * 4);
  const alpha = bake._alpha ? bake._alpha.data : null;
  for (let i = 0, j = 0, k = 0; i < n2; i++, j += 3, k += 4) {
    rgba[k] = bake.rgb[j] * 255;
    rgba[k + 1] = bake.rgb[j + 1] * 255;
    rgba[k + 2] = bake.rgb[j + 2] * 255;
    rgba[k + 3] = alpha ? alpha[i] * 255 : 255;
  }
  const map = bufferTexture(assets, `${key}|map`, rgba, size, true);

  // ── normal from height ───────────────────────────────────────────────────
  const nStrength = (def.normalStrength ?? 1) * bake.normalStrength * (opts.normalStrength ?? 1);
  const nrm = N.heightToNormalRGBA(bake.height, nStrength);
  const normalMap = bufferTexture(assets, `${key}|nrm`, nrm, size, false);

  // ── AO ───────────────────────────────────────────────────────────────────
  const aoCfg = def.ao ?? null;
  const aoStrength = aoCfg?.strength ?? 1;
  let aoField = bake.getAO();
  if (!aoField) {
    if (aoStrength <= 0) {
      aoField = N.Field.constant(size, 1);
    } else {
      aoField = N.heightToAO(bake.height, {
        radius: aoCfg?.radius ?? 0.045,
        strength: aoStrength,
        dirs: aoCfg?.dirs ?? 8,
        steps: aoCfg?.steps ?? 4,
        heightScale: bake.heightScale,
        res: aoCfg?.res ?? 160,
      });
    }
  }

  // ── packed ORM ───────────────────────────────────────────────────────────
  const orm = new Uint8ClampedArray(n2 * 4);
  const aod = aoField.data, rod = bake.rough.data;
  const med = bake._metal ? bake._metal.data : null;
  for (let i = 0, k = 0; i < n2; i++, k += 4) {
    orm[k] = aod[i] * 255;
    orm[k + 1] = rod[i] * 255;
    orm[k + 2] = med ? med[i] * 255 : 0;
    orm[k + 3] = 255;
  }
  const ormMap = bufferTexture(assets, `${key}|orm`, orm, size, false);

  // ── emissive (rare) ──────────────────────────────────────────────────────
  let emissiveMap = null;
  if (bake._emis) {
    const em = new Uint8ClampedArray(n2 * 4);
    for (let i = 0, j = 0, k = 0; i < n2; i++, j += 3, k += 4) {
      em[k] = bake._emis[j] * 255;
      em[k + 1] = bake._emis[j + 1] * 255;
      em[k + 2] = bake._emis[j + 2] * 255;
      em[k + 3] = 255;
    }
    emissiveMap = bufferTexture(assets, `${key}|emi`, em, size, true);
  }

  return {
    map, normalMap, ormMap,
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    aoMap: ormMap,
    emissiveMap,
    height: bake.height.data,
    size,
    hasAlpha: alpha !== null,
    hasMetal: med !== null,
    def,
    name: def?.name ?? key,
  };
}

/** Flat 50 % grey set used when a name is unknown or a painter throws. */
export function fallbackSet(assets) {
  return assets.memo('pt:__fallback__', () => {
    const size = 8;
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = (y * size + x) * 4;
        const c = ((x >> 1) + (y >> 1)) & 1 ? 190 : 150;
        rgba[k] = c; rgba[k + 1] = c; rgba[k + 2] = c; rgba[k + 3] = 255;
      }
    }
    const map = bufferTexture(assets, 'pt:__fallback__|map', rgba, size, true);
    const nrm = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      nrm[i * 4] = 128; nrm[i * 4 + 1] = 128; nrm[i * 4 + 2] = 255; nrm[i * 4 + 3] = 255;
    }
    const normalMap = bufferTexture(assets, 'pt:__fallback__|nrm', nrm, size, false);
    const orm = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      orm[i * 4] = 255; orm[i * 4 + 1] = 200; orm[i * 4 + 2] = 0; orm[i * 4 + 3] = 255;
    }
    const ormMap = bufferTexture(assets, 'pt:__fallback__|orm', orm, size, false);
    return {
      map, normalMap, ormMap, roughnessMap: ormMap, metalnessMap: ormMap, aoMap: ormMap,
      emissiveMap: null, height: new Float32Array(size * size), size,
      hasAlpha: false, hasMetal: false,
      def: { family: 'fallback', surfaceId: 0, physicalSize: 1, material: {} },
      name: '__fallback__',
    };
  });
}

/**
 * Memoised {@link buildTextureSet}. This is the entry point every other
 * system should use.
 *
 * @param {import('../core/Assets.js').Assets} assets
 * @param {string} name
 * @param {object} [opts] see {@link buildTextureSet}
 * @returns {TextureSet}
 */
export function textureSet(assets, name, opts = {}) {
  if (!assets) return null;
  const def = TEXTURE_DEFS[name];
  const size = opts.size ?? texSize(def?.res ?? 0.375);
  let key = `pt:${name}@${size}`;
  if (opts.seed != null) key += `:s${opts.seed}`;
  if (opts.tint != null) key += `:t${(opts.tint >>> 0).toString(16)}`;
  if (opts.recolor != null) key += `:r${(opts.recolor >>> 0).toString(16)}`;
  if (opts.variant) key += `:${opts.variant}`;
  if (opts.params) {
    const pk = Object.keys(opts.params).sort().map((k) => `${k}=${opts.params[k]}`).join(',');
    if (pk) key += `:{${pk}}`;
  }
  return assets.memo(key, () => buildTextureSet(assets, name, { ...opts, size, key }));
}

// ══════════════════════════════════════════════════════════ SPECIAL MAPS

/**
 * The two scrolling wave layers that make water move.
 * Layer A is the big swell, layer B is faster and finer. `Materials.js`
 * patches a MeshPhysicalMaterial to blend them and scrolls their offsets.
 *
 * @returns {{normalA:THREE.Texture, normalB:THREE.Texture, scaleB:number,
 *            speedA:[number,number], speedB:[number,number]}}
 */
export function waterNormalLayers(assets, opts = {}) {
  return assets.memo(`pt:water/layers@${opts.size ?? 'auto'}`, () => {
    const a = textureSet(assets, 'water/shallow', { size: opts.size });
    const b = textureSet(assets, 'water/layer_b', { size: opts.size ? Math.max(128, opts.size >> 1) : undefined });
    return {
      normalA: a.normalMap,
      normalB: b.normalMap,
      colorMap: a.map,
      ormMap: a.ormMap,
      scaleB: opts.scaleB ?? 2.35,
      speedA: opts.speedA ?? [0.021, 0.014],
      speedB: opts.speedB ?? [-0.036, 0.028],
    };
  });
}

/**
 * Metallic-flake normal map for car paint. Tiny, extremely high-frequency,
 * and tiled hard so individual flakes stay sub-pixel until you get close.
 */
export function flakeNormalMap(assets, opts = {}) {
  const size = opts.size ?? Math.min(512, texSize(0.5));
  const seed = opts.seed ?? 4242;
  const density = opts.density ?? 0.55;
  return assets.memo(`pt:flake@${size}:${seed}:${density}`, () => {
    const h = new N.Field(size);
    h.fill((u, v) => {
      const w = N.worley2(u * size * 0.25, v * size * 0.25, Math.round(size * 0.25), seed, 1);
      const flake = 1 - N.sstep(0.0, 0.55, w.f1);
      const tilt = ((w.cellId >>> 7) & 255) / 255;
      return flake * (0.25 + tilt * 0.75) * density;
    });
    const buf = N.heightToNormalRGBA(h, opts.strength ?? 2.2);
    return bufferTexture(assets, `pt:flake@${size}:${seed}:${density}|nrm`, buf, size, false);
  });
}

/**
 * Generic tileable noise texture (R = fBm, G = worley F1, B = ridged,
 * A = high-frequency grain). Handy for FX dissolve masks and shader detail.
 */
export function noiseTexture(assets, opts = {}) {
  const size = opts.size ?? 256;
  const seed = opts.seed ?? 7;
  const freq = Math.max(1, Math.round(opts.freq ?? 8));
  return assets.memo(`pt:noise@${size}:${seed}:${freq}`, () => {
    const buf = new Uint8ClampedArray(size * size * 4);
    const inv = 1 / size;
    let k = 0;
    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < size; x++, k += 4) {
        const u = (x + 0.5) * inv;
        buf[k] = (N.fbm2p(u, v, freq, 5, 2, 0.5, seed) * 0.5 + 0.5) * 255;
        buf[k + 1] = Math.min(1, N.worley2(u * freq, v * freq, freq, seed + 11, 1).f1) * 255;
        buf[k + 2] = N.ridged2p(u, v, freq, 4, 2, 0.5, seed + 23, 2) * 255;
        buf[k + 3] = (N.perlin2(u * size * 0.5, v * size * 0.5, size * 0.5, size * 0.5, seed + 37) * 0.5 + 0.5) * 255;
      }
    }
    return bufferTexture(assets, `pt:noise@${size}:${seed}:${freq}|tex`, buf, size, false);
  });
}

// ══════════════════════════════════════════════════════════ TEXT & DECALS

/** Resolve a font family keyword to a CSS stack (system fonts only, no files). */
function fontStack(kind) {
  if (kind === 'serif') return 'Georgia, "Times New Roman", serif';
  if (kind === 'mono') return '"SF Mono", Menlo, Consolas, monospace';
  if (kind === 'condensed') return '"Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  return '"Helvetica Neue", Arial, sans-serif';
}

/**
 * Draw text into a canvas with an outline, a drop shadow and optional wear.
 * Used by tracks for signage, sponsor logos, sticker decals and prop labels.
 *
 * @param {import('../core/Assets.js').Assets} assets
 * @param {string} key cache key
 * @param {object} o
 * @param {string|string[]} o.text one line, or an array of lines
 * @param {number} [o.width] canvas width  (default 512)
 * @param {number} [o.height] canvas height (default width / 2)
 * @param {'vector'|'sans'|'serif'|'mono'|'condensed'} [o.font]
 * @param {number} [o.fontSize] px; auto-fit when omitted
 * @param {string} [o.color]
 * @param {string} [o.outline] outline colour (null = none)
 * @param {number} [o.outlineWidth] as a fraction of the font size
 * @param {string} [o.background] fill colour behind the text (null = transparent)
 * @param {number} [o.radius] background corner radius in px
 * @param {number} [o.wear] 0..1 — eats away at the paint
 * @param {number} [o.rotate] radians
 * @param {number} [o.padding] fraction of the smaller side
 * @param {number} [o.tracking] letter spacing (vector font: grid units)
 * @param {string} [o.shadow]
 * @param {number} [o.seed]
 * @returns {THREE.CanvasTexture}
 */
export function textTexture(assets, key, o = {}) {
  const cacheKey = `pt:text:${key}`;
  const cached = assets.getTexture(cacheKey);
  if (cached) return cached;

  const w = o.width ?? 512;
  const h = o.height ?? Math.round(w * 0.5);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rng = new RNG(o.seed ?? 12345);

  const lines = Array.isArray(o.text) ? o.text : String(o.text ?? '').split('\n');
  const pad = (o.padding ?? 0.08) * Math.min(w, h);
  const useVector = (o.font ?? 'vector') === 'vector';
  const color = o.color ?? '#ffffff';

  ctx.clearRect(0, 0, w, h);

  // Background plate.
  if (o.background) {
    ctx.save();
    roundRect(ctx, 0, 0, w, h, o.radius ?? 0);
    ctx.fillStyle = o.background;
    ctx.fill();
    if (o.border) {
      ctx.lineWidth = o.borderWidth ?? Math.max(2, h * 0.02);
      ctx.strokeStyle = o.border;
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.save();
  if (o.rotate) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate(o.rotate);
    ctx.translate(-w / 2, -h / 2);
  }

  const availW = w - pad * 2;
  const availH = h - pad * 2;
  const lineGap = o.lineGap ?? 0.25;

  if (useVector) {
    const tracking = o.tracking ?? 1.2;
    // Fit: pick the size that makes the widest line fill the box.
    let size = o.fontSize ?? Infinity;
    if (!o.fontSize) {
      for (const ln of lines) {
        const wAt100 = measureVectorText(ln, { size: 100, tracking });
        if (wAt100 > 0) size = Math.min(size, (availW / wAt100) * 100);
      }
      const totalLines = lines.length + (lines.length - 1) * lineGap;
      size = Math.min(size, availH / totalLines);
      if (!isFinite(size)) size = availH;
    }
    const step = size * (1 + lineGap);
    let y = (h - (lines.length * size + (lines.length - 1) * size * lineGap)) * 0.5;
    for (const ln of lines) {
      if (o.outline) {
        drawVectorText(ctx, ln, w / 2, y, {
          size, align: 'center', color: o.outline, tracking,
          weight: (o.weight ?? 0.15) + (o.outlineWidth ?? 0.09),
        });
      }
      drawVectorText(ctx, ln, w / 2, y, {
        size, align: 'center', color, tracking, weight: o.weight ?? 0.15,
        shadow: o.shadow ?? null, slant: o.slant ?? 0,
      });
      y += step;
    }
  } else {
    const family = fontStack(o.font);
    const weight = o.cssWeight ?? 800;
    let size = o.fontSize ?? availH / (lines.length * (1 + lineGap));
    if (!o.fontSize) {
      // Shrink to fit the widest line.
      ctx.font = `${weight} 100px ${family}`;
      let widest = 1;
      for (const ln of lines) widest = Math.max(widest, ctx.measureText(ln).width);
      size = Math.min(size, (availW / widest) * 100);
    }
    ctx.font = `${o.italic ? 'italic ' : ''}${weight} ${size}px ${family}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (o.shadow) { ctx.shadowColor = o.shadow; ctx.shadowBlur = size * 0.12; ctx.shadowOffsetY = size * 0.05; }
    const step = size * (1 + lineGap);
    let y = h / 2 - ((lines.length - 1) * step) / 2;
    for (const ln of lines) {
      if (o.outline) {
        ctx.lineWidth = size * (o.outlineWidth ?? 0.14);
        ctx.strokeStyle = o.outline;
        ctx.lineJoin = 'round';
        ctx.strokeText(ln, w / 2, y);
      }
      ctx.fillStyle = color;
      ctx.fillText(ln, w / 2, y);
      y += step;
    }
  }
  ctx.restore();

  // Wear: erase noise + scratches from whatever we just drew.
  const wear = o.wear ?? 0;
  if (wear > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const dots = Math.round(700 * wear);
    for (let i = 0; i < dots; i++) {
      const x = rng.next() * w, y = rng.next() * h;
      const m = N.fbm2p(x / w, y / h, 5, 3, 2, 0.5, o.seed ?? 3) * 0.5 + 0.5;
      if (rng.next() > m * 1.2) continue;
      ctx.globalAlpha = (0.15 + rng.next() * 0.7) * wear;
      ctx.beginPath();
      ctx.arc(x, y, Math.min(w, h) * (0.004 + rng.next() * 0.03) * (0.5 + wear), 0, TAU);
      ctx.fill();
    }
    const streaks = Math.round(28 * wear);
    ctx.lineCap = 'round';
    for (let i = 0; i < streaks; i++) {
      ctx.globalAlpha = (0.2 + rng.next() * 0.6) * wear;
      ctx.lineWidth = Math.min(w, h) * (0.003 + rng.next() * 0.012);
      const x = rng.next() * w, y = rng.next() * h;
      const a = rng.next() * TAU, l = Math.min(w, h) * (0.05 + rng.next() * 0.4);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = cacheKey;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = o.wrap ?? THREE.ClampToEdgeWrapping;
  tex.anisotropy = assets.maxAnisotropy;
  tex.needsUpdate = true;
  return assets.putTexture(cacheKey, tex);
}

/**
 * A complete signage panel: plate, border, screws, title, subtitle and grime.
 * Returns a `TextureSet`-shaped object so it can go straight into a material.
 */
export function signTexture(assets, key, o = {}) {
  const cacheKey = `pt:sign:${key}`;
  return assets.memo(cacheKey, () => {
    const w = o.width ?? 512;
    const h = o.height ?? Math.round(w * 0.42);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rng = new RNG(o.seed ?? 909);

    // Plate with a subtle vertical gradient.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const base = o.plate ?? '#1f5fa8';
    g.addColorStop(0, o.plateTop ?? base);
    g.addColorStop(1, o.plateBottom ?? '#123c6c');
    roundRect(ctx, 0, 0, w, h, o.radius ?? h * 0.08);
    ctx.fillStyle = g;
    ctx.fill();

    // Inner keyline.
    ctx.lineWidth = Math.max(2, h * 0.018);
    ctx.strokeStyle = o.border ?? 'rgba(255,255,255,0.85)';
    roundRect(ctx, h * 0.06, h * 0.06, w - h * 0.12, h - h * 0.12, h * 0.05);
    ctx.stroke();

    // Title + subtitle.
    const title = o.title ?? 'PIT LANE';
    const sub = o.subtitle ?? null;
    const tSize = o.titleSize ?? (sub ? h * 0.32 : h * 0.42);
    drawVectorText(ctx, title, w * 0.5, sub ? h * 0.20 : h * 0.5 - tSize * 0.5, {
      size: tSize, align: 'center', color: o.titleColor ?? '#ffffff', weight: 0.16, tracking: 1.5,
    });
    if (sub) {
      drawVectorText(ctx, sub, w * 0.5, h * 0.62, {
        size: o.subSize ?? h * 0.18, align: 'center',
        color: o.subColor ?? 'rgba(255,255,255,0.8)', weight: 0.14, tracking: 2.2,
      });
    }

    // Fixings.
    if (o.screws !== false) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const r = h * 0.035;
      for (const [sx, sy] of [[0.055, 0.13], [0.945, 0.13], [0.055, 0.87], [0.945, 0.87]]) {
        ctx.beginPath(); ctx.arc(w * sx, h * sy, r, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = r * 0.35;
        ctx.beginPath(); ctx.moveTo(w * sx - r * 0.6, h * sy); ctx.lineTo(w * sx + r * 0.6, h * sy); ctx.stroke();
      }
    }

    // Grime.
    ctx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 220; i++) {
      ctx.globalAlpha = 0.03 + rng.next() * 0.07;
      ctx.fillStyle = '#6c6a60';
      ctx.beginPath();
      ctx.arc(rng.next() * w, rng.next() * h, Math.min(w, h) * (0.01 + rng.next() * 0.08), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const tex = new THREE.CanvasTexture(canvas);
    tex.name = cacheKey;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = assets.maxAnisotropy;
    tex.needsUpdate = true;
    assets.putTexture(`${cacheKey}|map`, tex);
    return { map: tex, width: w, height: h };
  });
}

/**
 * Sponsor-style badge: a bold shape with a word inside. Deterministic from
 * the name, so `logoTexture(assets,'TURBO')` always looks the same.
 */
export function logoTexture(assets, key, o = {}) {
  const cacheKey = `pt:logo:${key}`;
  const cached = assets.getTexture(cacheKey);
  if (cached) return cached;

  const w = o.width ?? 512, h = o.height ?? 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const text = String(o.text ?? key).toUpperCase();
  const shape = o.shape ?? 'chevron';
  const fg = o.color ?? '#ffffff';
  const bg = o.background ?? '#e2231a';

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.fillStyle = bg;
  if (shape === 'chevron') {
    ctx.beginPath();
    ctx.moveTo(w * 0.02, h * 0.18);
    ctx.lineTo(w * 0.90, h * 0.18);
    ctx.lineTo(w * 0.98, h * 0.5);
    ctx.lineTo(w * 0.90, h * 0.82);
    ctx.lineTo(w * 0.02, h * 0.82);
    ctx.lineTo(w * 0.10, h * 0.5);
    ctx.closePath();
    ctx.fill();
  } else if (shape === 'shield') {
    ctx.beginPath();
    ctx.moveTo(w * 0.5, h * 0.06);
    ctx.lineTo(w * 0.92, h * 0.24);
    ctx.quadraticCurveTo(w * 0.92, h * 0.82, w * 0.5, h * 0.96);
    ctx.quadraticCurveTo(w * 0.08, h * 0.82, w * 0.08, h * 0.24);
    ctx.closePath();
    ctx.fill();
  } else if (shape === 'circle') {
    ctx.beginPath(); ctx.arc(w * 0.5, h * 0.5, Math.min(w, h) * 0.46, 0, TAU); ctx.fill();
  } else if (shape === 'star') {
    starPath(ctx, w * 0.5, h * 0.5, 5, Math.min(w, h) * 0.48, Math.min(w, h) * 0.21);
    ctx.fill();
  } else {
    roundRect(ctx, w * 0.03, h * 0.14, w * 0.94, h * 0.72, h * 0.12);
    ctx.fill();
  }
  // Highlight sweep.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,255,255,0.28)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.02)');
  grad.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();

  const unitW = Math.max(0.0001, measureVectorText(text, { size: 1, tracking: 1.1 }));
  const logoSize = Math.min(h * 0.42, (w * 0.70) / unitW);
  drawVectorText(ctx, text, w * 0.5, (h - logoSize) * 0.5, {
    size: logoSize, align: 'center', color: fg, weight: 0.19, tracking: 1.1, slant: o.slant ?? 0.12,
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.name = cacheKey;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = assets.maxAnisotropy;
  tex.needsUpdate = true;
  return assets.putTexture(cacheKey, tex);
}

/**
 * Free-form canvas decal. Give it a draw callback and get a cached texture.
 * `{ transparent: true }` by default so it can be laid over anything.
 */
export function decalTexture(assets, key, draw, o = {}) {
  const cacheKey = `pt:decal:${key}`;
  const cached = assets.getTexture(cacheKey);
  if (cached) return cached;
  const w = o.width ?? 256, h = o.height ?? w;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const rng = new RNG(o.seed ?? 1);
  try { draw(ctx, w, h, rng); }
  catch (err) { warnOnce(`decal "${key}" draw threw: ${err?.message ?? err}`); }
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = cacheKey;
  tex.colorSpace = o.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = o.wrap ?? THREE.ClampToEdgeWrapping;
  tex.anisotropy = assets.maxAnisotropy;
  tex.needsUpdate = true;
  return assets.putTexture(cacheKey, tex);
}

export default {
  TEXTURE_DEFS, listTextures, getTextureDef,
  textureSet, buildTextureSet, fallbackSet,
  texSize, RES_BY_QUALITY,
  textTexture, signTexture, logoTexture, decalTexture,
  waterNormalLayers, flakeNormalMap, noiseTexture,
  drawVectorText, measureVectorText, drawSuit, tileDraw, roundRect, starPath,
  Bake, hexRGB, hslRGB, mixRGB,
};
