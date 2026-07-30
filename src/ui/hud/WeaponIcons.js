/**
 * RC RUMBLE — procedural weapon icons.
 *
 * Every pickup icon is drawn with canvas vector calls into a 0..1 unit box, so
 * they scale to any HUD size and cost nothing to ship. Rendered icons are
 * memoised into offscreen canvases keyed by `id|size|dpr` and blitted, which
 * keeps the rolling pickup reel (which swaps icon ~18×/s) free of per-frame
 * path work.
 */

import { THEME, withAlpha, dpr } from '../Theme.js';

const C = THEME.color;

/** Accent colour per weapon — also used for the slot glow and the reel. */
export const WEAPON_COLOR = Object.freeze({
  turbo:     '#ff8a1f',
  shield:    '#54dcff',
  oil:       '#b07cff',
  ball:      '#d3dce8',
  balloon:   '#49b8ff',
  firework:  '#ff5a3c',
  shockwave: '#7bffd0',
  bomb:      '#ff4f62',
  electro:   '#c98cff',
  clone:     '#ffd166',
  none:      '#6b7c99',
});

export const WEAPON_LABEL = Object.freeze({
  turbo: 'Turbo', shield: 'Shield', oil: 'Oil Slick', ball: 'Ball Bearing',
  balloon: 'Water Balloon', firework: 'Firework', shockwave: 'Shockwave',
  bomb: 'Bomb', electro: 'Electro-Pulse', clone: 'Clone Pickup',
});

/** The order the reel flickers through while a pickup is being decided. */
export const REEL_ORDER = Object.freeze([
  'turbo', 'firework', 'shield', 'oil', 'ball', 'bomb', 'balloon', 'electro', 'shockwave', 'clone',
]);

// ═══════════════════════════════════════════════════════════════ primitives

function poly(ctx, pts, close = true) {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  if (close) ctx.closePath();
}

function star(ctx, cx, cy, r, ri, points, rot = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 ? ri : r;
    const a = rot + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function bolt(ctx, cx, cy, w, h) {
  poly(ctx, [
    cx + w * 0.12, cy - h * 0.50,
    cx - w * 0.42, cy + h * 0.06,
    cx - w * 0.06, cy + h * 0.06,
    cx - w * 0.20, cy + h * 0.50,
    cx + w * 0.44, cy - h * 0.10,
    cx + w * 0.06, cy - h * 0.10,
  ]);
}

// ═══════════════════════════════════════════════════════════════ the icons
// Each painter draws inside a 0..1 box; the caller has already translated and
// scaled, and set lineWidth to a size-relative value.

const PAINT = {
  turbo(ctx, k) {
    // Three swept flame chevrons.
    const grad = ctx.createLinearGradient(0.1 * k, k, 0.9 * k, 0);
    grad.addColorStop(0, '#ffdf7a');
    grad.addColorStop(0.5, '#ff9a1f');
    grad.addColorStop(1, '#ff4d18');
    ctx.fillStyle = grad;
    for (let i = 0; i < 3; i++) {
      const o = i * 0.185;
      poly(ctx, [
        (0.14 + o) * k, 0.16 * k,
        (0.42 + o) * k, 0.50 * k,
        (0.14 + o) * k, 0.84 * k,
        (0.27 + o) * k, 0.84 * k,
        (0.55 + o) * k, 0.50 * k,
        (0.27 + o) * k, 0.16 * k,
      ]);
      ctx.globalAlpha = 1 - i * 0.24;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },

  shield(ctx, k) {
    const g = ctx.createLinearGradient(0, 0.1 * k, 0, 0.94 * k);
    g.addColorStop(0, '#a9ecff');
    g.addColorStop(1, '#1c8fd0');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0.5 * k, 0.08 * k);
    ctx.lineTo(0.87 * k, 0.24 * k);
    ctx.quadraticCurveTo(0.87 * k, 0.74 * k, 0.5 * k, 0.94 * k);
    ctx.quadraticCurveTo(0.13 * k, 0.74 * k, 0.13 * k, 0.24 * k);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.moveTo(0.5 * k, 0.16 * k);
    ctx.lineTo(0.78 * k, 0.28 * k);
    ctx.quadraticCurveTo(0.78 * k, 0.52 * k, 0.5 * k, 0.62 * k);
    ctx.closePath();
    ctx.fill();
  },

  oil(ctx, k) {
    // A puddle with a falling drop.
    ctx.fillStyle = '#1b1030';
    ctx.beginPath();
    ctx.ellipse(0.5 * k, 0.72 * k, 0.40 * k, 0.17 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = withAlpha('#b07cff', 0.55);
    ctx.beginPath();
    ctx.ellipse(0.40 * k, 0.70 * k, 0.15 * k, 0.062 * k, -0.3, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createLinearGradient(0, 0.08 * k, 0, 0.52 * k);
    g.addColorStop(0, '#d7bcff');
    g.addColorStop(1, '#7a48c8');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0.5 * k, 0.08 * k);
    ctx.quadraticCurveTo(0.72 * k, 0.34 * k, 0.66 * k, 0.44 * k);
    ctx.arc(0.5 * k, 0.44 * k, 0.16 * k, 0, Math.PI);
    ctx.quadraticCurveTo(0.28 * k, 0.34 * k, 0.5 * k, 0.08 * k);
    ctx.fill();
  },

  ball(ctx, k) {
    const g = ctx.createRadialGradient(0.38 * k, 0.34 * k, 0.03 * k, 0.5 * k, 0.5 * k, 0.44 * k);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, '#cfd8e3');
    g.addColorStop(1, '#4a5568');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0.5 * k, 0.52 * k, 0.36 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.035 * k;
    ctx.beginPath();
    ctx.arc(0.44 * k, 0.42 * k, 0.19 * k, Math.PI * 0.95, Math.PI * 1.65);
    ctx.stroke();
    // Motion streaks.
    ctx.strokeStyle = 'rgba(211,220,232,0.42)';
    ctx.lineWidth = 0.045 * k;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(0.05 * k, (0.30 + i * 0.19) * k);
      ctx.lineTo((0.16 + i * 0.02) * k, (0.30 + i * 0.19) * k);
      ctx.stroke();
    }
  },

  balloon(ctx, k) {
    const g = ctx.createLinearGradient(0.3 * k, 0.1 * k, 0.7 * k, 0.9 * k);
    g.addColorStop(0, '#a5e6ff');
    g.addColorStop(0.6, '#3aa4ff');
    g.addColorStop(1, '#1d5fd0');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0.5 * k, 0.08 * k);
    ctx.bezierCurveTo(0.90 * k, 0.34 * k, 0.86 * k, 0.94 * k, 0.5 * k, 0.94 * k);
    ctx.bezierCurveTo(0.14 * k, 0.94 * k, 0.10 * k, 0.34 * k, 0.5 * k, 0.08 * k);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.beginPath();
    ctx.ellipse(0.37 * k, 0.44 * k, 0.085 * k, 0.15 * k, -0.45, 0, Math.PI * 2);
    ctx.fill();
  },

  firework(ctx, k) {
    // Rocket body + fins + flame.
    const g = ctx.createLinearGradient(0.3 * k, 0, 0.7 * k, 0);
    g.addColorStop(0, '#ff8a70');
    g.addColorStop(0.45, '#ff5a3c');
    g.addColorStop(1, '#bf2a14');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0.5 * k, 0.05 * k);
    ctx.quadraticCurveTo(0.70 * k, 0.28 * k, 0.68 * k, 0.62 * k);
    ctx.lineTo(0.32 * k, 0.62 * k);
    ctx.quadraticCurveTo(0.30 * k, 0.28 * k, 0.5 * k, 0.05 * k);
    ctx.fill();
    ctx.fillStyle = '#e9f0ff';
    poly(ctx, [0.32 * k, 0.44 * k, 0.14 * k, 0.68 * k, 0.32 * k, 0.66 * k]);
    ctx.fill();
    poly(ctx, [0.68 * k, 0.44 * k, 0.86 * k, 0.68 * k, 0.68 * k, 0.66 * k]);
    ctx.fill();
    const f = ctx.createLinearGradient(0, 0.62 * k, 0, 0.98 * k);
    f.addColorStop(0, '#ffe58a');
    f.addColorStop(0.5, '#ff9f2e');
    f.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.fillStyle = f;
    poly(ctx, [0.36 * k, 0.62 * k, 0.64 * k, 0.62 * k, 0.5 * k, 0.99 * k]);
    ctx.fill();
  },

  shockwave(ctx, k) {
    ctx.strokeStyle = '#7bffd0';
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const r = (0.14 + i * 0.13) * k;
      ctx.globalAlpha = 1 - i * 0.26;
      ctx.lineWidth = (0.075 - i * 0.016) * k;
      ctx.beginPath();
      ctx.arc(0.5 * k, 0.52 * k, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#d8fff2';
    ctx.beginPath();
    ctx.arc(0.5 * k, 0.52 * k, 0.065 * k, 0, Math.PI * 2);
    ctx.fill();
  },

  bomb(ctx, k) {
    const g = ctx.createRadialGradient(0.40 * k, 0.52 * k, 0.03 * k, 0.5 * k, 0.62 * k, 0.42 * k);
    g.addColorStop(0, '#5a6478');
    g.addColorStop(0.55, '#1e2534');
    g.addColorStop(1, '#0a0e16');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0.5 * k, 0.62 * k, 0.33 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#39404f';
    ctx.fillRect(0.42 * k, 0.20 * k, 0.16 * k, 0.13 * k);
    ctx.strokeStyle = '#c8ae7a';
    ctx.lineWidth = 0.055 * k;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0.52 * k, 0.21 * k);
    ctx.quadraticCurveTo(0.80 * k, 0.14 * k, 0.72 * k, 0.04 * k);
    ctx.stroke();
    star(ctx, 0.74 * k, 0.035 * k, 0.13 * k, 0.05 * k, 6, 0);
    ctx.fillStyle = '#ffcf4a';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(0.38 * k, 0.50 * k, 0.075 * k, 0.045 * k, -0.6, 0, Math.PI * 2);
    ctx.fill();
  },

  electro(ctx, k) {
    ctx.strokeStyle = withAlpha('#c98cff', 0.85);
    ctx.lineWidth = 0.05 * k;
    ctx.beginPath();
    ctx.arc(0.5 * k, 0.5 * k, 0.40 * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([0.09 * k, 0.07 * k]);
    ctx.strokeStyle = withAlpha('#c98cff', 0.45);
    ctx.lineWidth = 0.035 * k;
    ctx.beginPath();
    ctx.arc(0.5 * k, 0.5 * k, 0.30 * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const g = ctx.createLinearGradient(0.3 * k, 0.1 * k, 0.7 * k, 0.9 * k);
    g.addColorStop(0, '#fff6b0');
    g.addColorStop(1, '#b45cff');
    ctx.fillStyle = g;
    bolt(ctx, 0.5 * k, 0.5 * k, 0.62 * k, 0.78 * k);
    ctx.fill();
  },

  clone(ctx, k) {
    // Two offset stacked pickup diamonds.
    for (let i = 1; i >= 0; i--) {
      const o = i * 0.11;
      ctx.globalAlpha = i ? 0.45 : 1;
      const g = ctx.createLinearGradient((0.5 - o) * k, (0.12 + o) * k, (0.5 - o) * k, (0.88 + o) * k);
      g.addColorStop(0, '#fff0bd');
      g.addColorStop(1, '#e0a520');
      ctx.fillStyle = g;
      poly(ctx, [
        (0.50 - o) * k, (0.10 + o) * k,
        (0.86 - o) * k, (0.50 + o) * k,
        (0.50 - o) * k, (0.90 + o) * k,
        (0.14 - o) * k, (0.50 + o) * k,
      ]);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    poly(ctx, [0.50 * k, 0.20 * k, 0.68 * k, 0.42 * k, 0.50 * k, 0.50 * k, 0.32 * k, 0.42 * k]);
    ctx.fill();
  },

  /** Empty slot: an outlined pickup diamond. */
  none(ctx, k) {
    ctx.strokeStyle = withAlpha(C.inkFaint, 0.55);
    ctx.lineWidth = 0.055 * k;
    ctx.setLineDash([0.09 * k, 0.07 * k]);
    poly(ctx, [0.5 * k, 0.14 * k, 0.84 * k, 0.5 * k, 0.5 * k, 0.86 * k, 0.16 * k, 0.5 * k]);
    ctx.stroke();
    ctx.setLineDash([]);
  },
};

/** Alias table so an unexpected weapon id still shows something sensible. */
const ALIAS = {
  nitro: 'turbo', boost: 'turbo', rocket: 'firework', missile: 'firework',
  oil_slick: 'oil', water_balloon: 'balloon', ballbearing: 'ball',
  electro_pulse: 'electro', pulse: 'shockwave', mine: 'bomb',
};

export function iconIdFor(id) {
  if (!id) return 'none';
  const k = String(id);
  if (PAINT[k]) return k;
  if (ALIAS[k] && PAINT[ALIAS[k]]) return ALIAS[k];
  return 'none';
}

export function colorFor(id) { return WEAPON_COLOR[iconIdFor(id)] ?? WEAPON_COLOR.none; }
export function labelFor(id) { return WEAPON_LABEL[iconIdFor(id)] ?? '—'; }

// ═══════════════════════════════════════════════════════════════ rendering

const _cache = new Map();

/**
 * Get (and memoise) a rendered icon canvas.
 * @param {string} id weapon id
 * @param {number} size CSS px — the canvas is DPR-scaled internally
 * @returns {HTMLCanvasElement}
 */
export function iconCanvas(id, size) {
  const key = `${iconIdFor(id)}|${Math.round(size)}|${dpr().toFixed(2)}`;
  let c = _cache.get(key);
  if (c) return c;
  const r = dpr();
  c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(size * r));
  c.height = Math.max(1, Math.round(size * r));
  const ctx = c.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  drawWeaponIcon(ctx, id, 0, 0, size);
  _cache.set(key, c);
  return c;
}

/**
 * Draw a weapon icon directly.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} id
 * @param {number} x @param {number} y top-left
 * @param {number} size box size in px
 */
export function drawWeaponIcon(ctx, id, x, y, size) {
  const key = iconIdFor(id);
  const paint = PAINT[key] ?? PAINT.none;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = 'round';
  try { paint(ctx, size); } catch { /* an icon must never break the HUD */ }
  ctx.restore();
}

/** Blit a memoised icon (cheap — use this in per-frame HUD code). */
export function blitWeaponIcon(ctx, id, x, y, size, alpha = 1) {
  const c = iconCanvas(id, size);
  const prev = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prev * alpha;
  ctx.drawImage(c, x, y, size, size);
  ctx.globalAlpha = prev;
}

export function clearIconCache() {
  _cache.clear();
}
