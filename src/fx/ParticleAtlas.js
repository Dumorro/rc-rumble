/**
 * RC RUMBLE — procedural particle sprite atlas.
 *
 * Every particle sprite in the game is drawn here, in code, into one 8×8 tile
 * atlas. No image files, no data URIs. One texture bind for the whole FX system.
 *
 * Layout: 8 columns × 8 rows, tile index = row * 8 + col (row 0 = top).
 * The atlas is uploaded with `flipY = false`, so tile row `r` occupies
 * `v ∈ [r/8, (r+1)/8]` and the shader flips the quad's v to draw sprites upright.
 *
 * Every tile is drawn with a transparent margin so mip-mapping cannot bleed a
 * neighbour's colour into a sprite's silhouette.
 *
 * Animated sprites live in contiguous runs (see `SPR`): the particle shader is
 * handed a float tile index and steps through the run over the particle's life.
 */

import * as THREE from 'three';
import { RNG, TAU, clamp01, lerp } from '../core/MathUtils.js';
import { fbm2p, worleyF1 } from '../render/noise/index.js';

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;
export const ATLAS_TILES = ATLAS_COLS * ATLAS_ROWS;

/**
 * Named tile indices. Runs of animation frames are contiguous and their length
 * is declared in `SPR_FRAMES`.
 */
export const SPR = Object.freeze({
  // row 0 — the workhorses
  SOFT: 0,          // gaussian blob, very soft
  GLOW: 1,          // tight hot core + wide halo
  SPARK: 2,         // pinpoint with a 4-way flare
  STREAK: 3,        // vertical tapered bar (velocity-aligned sparks/rain)
  FLARE: 4,         // 6-point star
  RING_SOFT: 5,     // feathered ring (shock ripple)
  RING_HARD: 6,     // crisp ring with a soft outer edge (shockwave)
  DROPLET: 7,       // teardrop

  // rows 1 — smoke animation (8 frames)
  SMOKE: 8,
  // row 2 — flame animation (8 frames)
  FLAME: 16,
  // row 3 — water splash crown animation (8 frames)
  SPLASH: 24,

  // row 4 — granular material
  DUST: 32,         // 4 grainy variants
  CHIP: 36,         // 4 angular solid chips

  // row 5 — organics
  BLADE: 40,        // 4 grass blades
  LEAF: 44,         // 4 leaves

  // row 6 — small bright things
  EMBER: 48,
  ELECTRIC: 49,     // 3 arc variants
  BUBBLE: 52,
  MOTE: 53,
  POLLEN: 54,
  HAZE: 55,         // tileable warp noise for the heat shimmer

  // row 7 — surface marks & misc
  SCUFF: 56,        // 4 rough smudges (marks, decals)
  SHARD: 60,        // glass shard
  SMOKE_PUFF: 61,   // single fat puff (cheap smoke)
  SPLAT: 62,        // irregular wet splat (decals)
  RIPPLE: 63,       // concentric water ring
});

export const SPR_FRAMES = Object.freeze({
  [SPR.SMOKE]: 8,
  [SPR.FLAME]: 8,
  [SPR.SPLASH]: 8,
  [SPR.DUST]: 4,
  [SPR.CHIP]: 4,
  [SPR.BLADE]: 4,
  [SPR.LEAF]: 4,
  [SPR.ELECTRIC]: 3,
  [SPR.SCUFF]: 4,
});

/** How many variants a sprite run has (1 when it is a single tile). */
export function spriteVariants(base) {
  return SPR_FRAMES[base] ?? 1;
}

// ──────────────────────────────────────────────────────────── draw helpers

/** rgba() string from 0..1 components. */
function rgba(r, g, b, a) {
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a.toFixed(4)})`;
}

/**
 * Multi-stop radial gradient approximating exp(-k·r^p) — a real gaussian falloff
 * instead of the linear ramp a two-stop gradient gives you (which reads as a
 * cheap "circle with a fuzzy edge").
 */
function gaussianGradient(ctx, cx, cy, r, { power = 2, k = 4.2, tint = 1, stops = 10, inner = 1 } = {}) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    let a = Math.exp(-k * Math.pow(t, power));
    // force a clean zero at the rim so the sprite never shows a hard disc edge
    a *= 1 - t * t * t;
    if (i === 0) a = inner;
    g.addColorStop(t, rgba(tint, tint, tint, clamp01(a)));
  }
  return g;
}

/** Fill a whole tile with a callback in normalized tile space. */
function tile(ctx, index, ts, fn) {
  const col = index % ATLAS_COLS;
  const row = (index / ATLAS_COLS) | 0;
  ctx.save();
  ctx.translate(col * ts, row * ts);
  ctx.beginPath();
  ctx.rect(0, 0, ts, ts);
  ctx.clip();
  fn(ctx, ts);
  ctx.restore();
}

/** Per-pixel grain multiply over a tile's alpha channel. */
function grainTile(ctx, index, ts, { freq = 5, octaves = 4, amount = 0.55, seed = 1, contrastPow = 1 } = {}) {
  const col = index % ATLAS_COLS;
  const row = (index / ATLAS_COLS) | 0;
  const x0 = col * ts, y0 = row * ts;
  const img = ctx.getImageData(x0, y0, ts, ts);
  const d = img.data;
  for (let y = 0; y < ts; y++) {
    const v = y / ts;
    for (let x = 0; x < ts; x++) {
      const i = (y * ts + x) * 4;
      if (d[i + 3] === 0) continue;
      const u = x / ts;
      let n = fbm2p(u * freq, v * freq, freq, octaves, 2.0, 0.55, seed) * 0.5 + 0.5;
      if (contrastPow !== 1) n = Math.pow(clamp01(n), contrastPow);
      const m = 1 - amount + amount * n;
      d[i + 3] = d[i + 3] * m;
      // grain the luminance a touch too so lit smoke has internal structure
      const lm = 0.82 + 0.18 * n * 2;
      d[i] = Math.min(255, d[i] * lm);
      d[i + 1] = Math.min(255, d[i + 1] * lm);
      d[i + 2] = Math.min(255, d[i + 2] * lm);
    }
  }
  ctx.putImageData(img, x0, y0);
}

/** Cellular "bubbly" alpha modulation — makes dust look like grains, not fog. */
function cellTile(ctx, index, ts, { period = 7, amount = 0.6, seed = 3, invert = false } = {}) {
  const col = index % ATLAS_COLS;
  const row = (index / ATLAS_COLS) | 0;
  const x0 = col * ts, y0 = row * ts;
  const img = ctx.getImageData(x0, y0, ts, ts);
  const d = img.data;
  for (let y = 0; y < ts; y++) {
    for (let x = 0; x < ts; x++) {
      const i = (y * ts + x) * 4;
      if (d[i + 3] === 0) continue;
      let f = worleyF1(x / ts * period, y / ts * period, period, seed);
      f = clamp01(f * 1.9);
      if (invert) f = 1 - f;
      const m = 1 - amount + amount * f;
      d[i + 3] = d[i + 3] * m;
    }
  }
  ctx.putImageData(img, x0, y0);
}

// ──────────────────────────────────────────────────────────── sprite painters

function drawSoft(ctx, ts) {
  const r = ts * 0.46;
  ctx.fillStyle = gaussianGradient(ctx, ts / 2, ts / 2, r, { power: 2.0, k: 3.6, inner: 0.95 });
  ctx.fillRect(0, 0, ts, ts);
}

function drawGlow(ctx, ts) {
  ctx.fillStyle = gaussianGradient(ctx, ts / 2, ts / 2, ts * 0.47, { power: 1.35, k: 7.5, inner: 1 });
  ctx.fillRect(0, 0, ts, ts);
  // hot core
  ctx.fillStyle = gaussianGradient(ctx, ts / 2, ts / 2, ts * 0.14, { power: 2.2, k: 4.0, inner: 1 });
  ctx.fillRect(0, 0, ts, ts);
}

function drawSpark(ctx, ts) {
  const c = ts / 2;
  // wide faint halo
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.46, { power: 1.1, k: 9.0, inner: 0.55 });
  ctx.fillRect(0, 0, ts, ts);
  // 4-way flare
  ctx.save();
  ctx.translate(c, c);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    const len = ts * (i % 2 ? 0.30 : 0.44);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -ts * 0.018);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, ts * 0.018);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // pinpoint core
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.075, { power: 2.4, k: 3.0, inner: 1 });
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillRect(0, 0, ts, ts);
  ctx.globalCompositeOperation = 'source-over';
}

function drawStreak(ctx, ts) {
  // A tapered vertical bar: bright at the leading tip (top), fading to the tail.
  const w = ts * 0.16;
  const g = ctx.createLinearGradient(0, ts * 0.06, 0, ts * 0.94);
  g.addColorStop(0.00, 'rgba(255,255,255,0)');
  g.addColorStop(0.12, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.62)');
  g.addColorStop(0.70, 'rgba(255,255,255,0.20)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(ts / 2, ts * 0.05);
  ctx.quadraticCurveTo(ts / 2 + w, ts * 0.30, ts / 2 + w * 0.35, ts * 0.95);
  ctx.lineTo(ts / 2 - w * 0.35, ts * 0.95);
  ctx.quadraticCurveTo(ts / 2 - w, ts * 0.30, ts / 2, ts * 0.05);
  ctx.closePath();
  ctx.fill();
  // soft bloom along the spine
  ctx.globalCompositeOperation = 'lighter';
  const g2 = ctx.createLinearGradient(0, 0, 0, ts);
  g2.addColorStop(0.05, 'rgba(255,255,255,0)');
  g2.addColorStop(0.18, 'rgba(255,255,255,0.35)');
  g2.addColorStop(0.9, 'rgba(255,255,255,0)');
  ctx.fillStyle = g2;
  ctx.fillRect(ts * 0.42, 0, ts * 0.16, ts);
  ctx.globalCompositeOperation = 'source-over';
}

function drawFlare(ctx, ts) {
  const c = ts / 2;
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.30, { power: 1.3, k: 8, inner: 0.9 });
  ctx.fillRect(0, 0, ts, ts);
  ctx.save();
  ctx.translate(c, c);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    ctx.rotate(TAU / 6);
    const len = ts * (i % 2 ? 0.32 : 0.47);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.25)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -ts * 0.026);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, ts * 0.026);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

function drawRing(ctx, ts, hard) {
  const c = ts / 2;
  const rOuter = ts * 0.46;
  const stops = 26;
  const g = ctx.createRadialGradient(c, c, 0, c, c, rOuter);
  const peak = hard ? 0.86 : 0.68;
  const inner = hard ? 0.11 : 0.30;
  for (let i = 0; i <= stops; i++) {
    const t = i / stops;
    let a;
    if (t < peak) {
      // inside: rise slowly then hard to the rim
      const u = t / peak;
      a = hard ? Math.pow(u, 6) * 0.55 : Math.pow(u, 2.4) * 0.55;
      a *= 1 - inner * (1 - u);
    } else {
      const u = (t - peak) / (1 - peak);
      a = lerp(1, 0, Math.pow(u, hard ? 0.75 : 1.25));
    }
    if (t > 0.995) a = 0;
    g.addColorStop(t, rgba(1, 1, 1, clamp01(a)));
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ts, ts);
}

function drawDroplet(ctx, ts) {
  // Teardrop, point up (motion direction), fat bottom.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ts * 0.5, ts * 0.08);
  ctx.bezierCurveTo(ts * 0.66, ts * 0.34, ts * 0.80, ts * 0.52, ts * 0.80, ts * 0.66);
  ctx.bezierCurveTo(ts * 0.80, ts * 0.85, ts * 0.66, ts * 0.94, ts * 0.5, ts * 0.94);
  ctx.bezierCurveTo(ts * 0.34, ts * 0.94, ts * 0.20, ts * 0.85, ts * 0.20, ts * 0.66);
  ctx.bezierCurveTo(ts * 0.20, ts * 0.52, ts * 0.34, ts * 0.34, ts * 0.5, ts * 0.08);
  ctx.closePath();
  const g = ctx.createRadialGradient(ts * 0.42, ts * 0.58, ts * 0.02, ts * 0.5, ts * 0.66, ts * 0.34);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0.10)');
  ctx.fillStyle = g;
  ctx.fill();
  // specular pip — reads as water rather than a grey blob
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = gaussianGradient(ctx, ts * 0.40, ts * 0.52, ts * 0.10, { power: 2, k: 4, inner: 0.9 });
  ctx.fillRect(0, 0, ts, ts);
  ctx.restore();
}

/**
 * One frame of a billowing smoke puff: a cluster of metaballs that grow and
 * separate over the animation, with the alpha dropping and the shape ragged.
 */
function drawSmokeFrame(ctx, ts, f, frames, rng) {
  const t = f / (frames - 1);
  const c = ts / 2;
  const blobs = 7;
  const spread = lerp(0.06, 0.20, t);
  const rBase = lerp(0.20, 0.30, t);
  const alpha = lerp(1.0, 0.42, t);
  ctx.save();
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * TAU + rng.range(-0.5, 0.5);
    const d = (i === 0 ? 0 : spread * ts * rng.range(0.55, 1.25));
    const x = c + Math.cos(a) * d;
    const y = c + Math.sin(a) * d * 0.92;
    const r = ts * rBase * rng.range(0.66, 1.12) * (i === 0 ? 1.15 : 1);
    ctx.globalCompositeOperation = i === 0 ? 'source-over' : 'lighter';
    ctx.fillStyle = gaussianGradient(ctx, x, y, r, {
      power: 2.0, k: 3.1, inner: alpha * (i === 0 ? 0.85 : 0.42),
    });
    ctx.fillRect(0, 0, ts, ts);
  }
  ctx.restore();
  // vignette the rim so the puff never clips the tile
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.5, { power: 5.5, k: 3.0, inner: 1 });
  ctx.fillRect(0, 0, ts, ts);
  ctx.globalCompositeOperation = 'source-over';
}

/** A flame lick: hot narrow core, cooler ragged crown, taller as it burns. */
function drawFlameFrame(ctx, ts, f, frames, rng) {
  const t = f / (frames - 1);
  const cx = ts * 0.5;
  const baseY = ts * 0.95;
  const h = lerp(0.72, 0.92, t) * ts;
  const w = lerp(0.34, 0.24, t) * ts;
  const lobes = 4;

  ctx.save();
  // outer body
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.5, baseY);
  for (let i = 0; i <= lobes; i++) {
    const u = i / lobes;
    const y = baseY - h * u;
    const wob = Math.sin(u * 7 + t * 5) * w * 0.16 * u;
    const hw = w * 0.5 * Math.pow(1 - u, 0.62) + w * 0.04;
    ctx.lineTo(cx - hw + wob, y);
  }
  ctx.lineTo(cx + w * 0.03, baseY - h);
  for (let i = lobes; i >= 0; i--) {
    const u = i / lobes;
    const y = baseY - h * u;
    const wob = Math.sin(u * 6.3 - t * 4.1) * w * 0.16 * u;
    const hw = w * 0.5 * Math.pow(1 - u, 0.62) + w * 0.04;
    ctx.lineTo(cx + hw + wob, y);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(0, baseY, 0, baseY - h);
  g.addColorStop(0.00, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.28, 'rgba(255,255,255,0.80)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.42)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fill();

  // white-hot core (the shader tints the sprite, so "white" == "hottest")
  ctx.globalCompositeOperation = 'lighter';
  const coreH = h * 0.46;
  const cg = ctx.createLinearGradient(0, baseY, 0, baseY - coreH);
  cg.addColorStop(0, 'rgba(255,255,255,0.9)');
  cg.addColorStop(0.6, 'rgba(255,255,255,0.35)');
  cg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.ellipse(cx, baseY - coreH * 0.42, w * 0.20, coreH * 0.52, 0, 0, TAU);
  ctx.fill();

  // sparks flicking off the crown
  for (let i = 0; i < 3; i++) {
    const x = cx + rng.range(-w * 0.4, w * 0.4);
    const y = baseY - h * rng.range(0.72, 1.0);
    ctx.fillStyle = gaussianGradient(ctx, x, y, ts * rng.range(0.02, 0.045), { power: 2, k: 3.5, inner: 0.8 });
    ctx.fillRect(0, 0, ts, ts);
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

/** Water crown: a rising cone of sheet water that breaks into droplets. */
function drawSplashFrame(ctx, ts, f, frames, rng) {
  const t = f / (frames - 1);
  const cx = ts * 0.5;
  const baseY = ts * 0.94;
  const h = lerp(0.26, 0.80, Math.pow(t, 0.7)) * ts;
  const spread = lerp(0.16, 0.44, t) * ts;
  const alpha = lerp(1.0, 0.38, Math.pow(t, 1.4));

  ctx.save();
  // the sheet: two curved lobes flaring outward
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + s * ts * 0.03, baseY);
    ctx.quadraticCurveTo(cx + s * spread * 0.45, baseY - h * 0.65, cx + s * spread, baseY - h);
    ctx.quadraticCurveTo(cx + s * spread * 0.72, baseY - h * 0.42, cx + s * ts * 0.13, baseY);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, baseY, 0, baseY - h);
    g.addColorStop(0, rgba(1, 1, 1, alpha * 0.85));
    g.addColorStop(0.45, rgba(1, 1, 1, alpha * 0.55));
    g.addColorStop(1, rgba(1, 1, 1, 0));
    ctx.fillStyle = g;
    ctx.fill();
  }
  // central column
  const cg = ctx.createLinearGradient(0, baseY, 0, baseY - h * 1.05);
  cg.addColorStop(0, rgba(1, 1, 1, alpha * 0.9));
  cg.addColorStop(0.5, rgba(1, 1, 1, alpha * 0.45));
  cg.addColorStop(1, rgba(1, 1, 1, 0));
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.moveTo(cx - ts * 0.10, baseY);
  ctx.quadraticCurveTo(cx - ts * 0.05, baseY - h * 0.7, cx, baseY - h * 1.02);
  ctx.quadraticCurveTo(cx + ts * 0.05, baseY - h * 0.7, cx + ts * 0.10, baseY);
  ctx.closePath();
  ctx.fill();

  // droplets: more and further out as the crown breaks up
  const drops = Math.round(lerp(2, 13, t));
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < drops; i++) {
    const a = rng.range(-2.6, -0.55);
    const d = spread * rng.range(0.5, 1.35);
    const x = cx + Math.cos(a) * d;
    const y = baseY - h * rng.range(0.35, 1.15) - Math.sin(-a) * 2;
    const r = ts * rng.range(0.012, 0.038);
    ctx.fillStyle = gaussianGradient(ctx, x, y, r, { power: 2, k: 3.4, inner: alpha });
    ctx.fillRect(0, 0, ts, ts);
  }
  // foam at the base
  ctx.fillStyle = gaussianGradient(ctx, cx, baseY - ts * 0.02, ts * lerp(0.14, 0.34, t), {
    power: 2.4, k: 4.2, inner: alpha * 0.5,
  });
  ctx.fillRect(0, 0, ts, ts);
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

/** Grainy dust puff — the alpha is chewed up by cellular + fbm noise. */
function drawDustBase(ctx, ts, variant, rng) {
  const c = ts / 2;
  const blobs = 4 + variant;
  ctx.save();
  for (let i = 0; i < blobs; i++) {
    const a = rng.range(0, TAU);
    const d = i === 0 ? 0 : ts * rng.range(0.04, 0.14);
    ctx.globalCompositeOperation = i === 0 ? 'source-over' : 'lighter';
    ctx.fillStyle = gaussianGradient(ctx, c + Math.cos(a) * d, c + Math.sin(a) * d,
      ts * rng.range(0.26, 0.40), { power: 1.9, k: 3.2, inner: i === 0 ? 0.9 : 0.4 });
    ctx.fillRect(0, 0, ts, ts);
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.5, { power: 4.5, k: 3.2, inner: 1 });
  ctx.fillRect(0, 0, ts, ts);
  ctx.globalCompositeOperation = 'source-over';
}

/** An angular solid chip — gravel, tarmac crumbs, plastic shrapnel. */
function drawChip(ctx, ts, variant, rng) {
  const c = ts / 2;
  const n = 5 + (variant % 3);
  const r0 = ts * 0.30;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng.range(-0.25, 0.25);
    const r = r0 * rng.range(0.6, 1.12);
    const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r * 0.86;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  // soft directional shading so a flat quad still reads as a solid lump
  const g = ctx.createLinearGradient(c - r0, c - r0, c + r0, c + r0);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(190,190,190,1)');
  g.addColorStop(1, 'rgba(105,105,105,1)');
  ctx.fillStyle = g;
  ctx.fill();
  // tiny highlight
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = gaussianGradient(ctx, c - r0 * 0.3, c - r0 * 0.35, r0 * 0.42, { power: 2, k: 5, inner: 0.35 });
  ctx.fill();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

/** A grass blade: tapered curved stroke with a darker base. */
function drawBlade(ctx, ts, variant, rng) {
  const bend = rng.range(-0.34, 0.34) + (variant - 1.5) * 0.10;
  const w = ts * rng.range(0.10, 0.17);
  const topY = ts * rng.range(0.08, 0.18);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ts * 0.5 - w * 0.5, ts * 0.94);
  ctx.quadraticCurveTo(ts * (0.5 + bend * 0.6), ts * 0.5, ts * (0.5 + bend), topY);
  ctx.quadraticCurveTo(ts * (0.5 + bend * 0.6) + w * 0.55, ts * 0.5, ts * 0.5 + w * 0.5, ts * 0.94);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, ts * 0.94, 0, topY);
  g.addColorStop(0, 'rgba(150,150,150,1)');
  g.addColorStop(0.4, 'rgba(235,235,235,1)');
  g.addColorStop(1, 'rgba(255,255,255,0.9)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

/** A leaf: lens-shaped blade with a midrib. */
function drawLeaf(ctx, ts, variant, rng) {
  const c = ts / 2;
  const len = ts * rng.range(0.40, 0.47);
  const wide = ts * rng.range(0.15, 0.24);
  const rot = rng.range(0, TAU);
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(0, -len);
  ctx.bezierCurveTo(wide, -len * 0.45, wide * 0.95, len * 0.45, 0, len);
  ctx.bezierCurveTo(-wide * 0.95, len * 0.45, -wide, -len * 0.45, 0, -len);
  ctx.closePath();
  const g = ctx.createLinearGradient(-wide, 0, wide, 0);
  g.addColorStop(0, 'rgba(130,130,130,1)');
  g.addColorStop(0.45, 'rgba(250,250,250,1)');
  g.addColorStop(1, 'rgba(165,165,165,1)');
  ctx.fillStyle = g;
  ctx.fill();
  // midrib + veins
  ctx.strokeStyle = 'rgba(90,90,90,0.75)';
  ctx.lineWidth = Math.max(1, ts * 0.012);
  ctx.beginPath();
  ctx.moveTo(0, -len * 0.92); ctx.lineTo(0, len * 0.92);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, ts * 0.007);
  ctx.strokeStyle = 'rgba(105,105,105,0.5)';
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    const y = (i / 4) * len * 0.8;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(wide * 0.7 * Math.sign(i || 1) * (variant % 2 ? 1 : -1), y + len * 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(-wide * 0.7 * Math.sign(i || 1) * (variant % 2 ? 1 : -1), y + len * 0.16);
    ctx.stroke();
  }
  ctx.restore();
}

/** Jagged electric arc, mostly vertical, forked. */
function drawElectric(ctx, ts, variant, rng) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const segs = 8 + variant * 2;
  const path = [];
  let x = ts * 0.5 + rng.range(-0.05, 0.05) * ts;
  for (let i = 0; i <= segs; i++) {
    const y = lerp(ts * 0.06, ts * 0.94, i / segs);
    x += rng.range(-0.13, 0.13) * ts;
    x = Math.max(ts * 0.12, Math.min(ts * 0.88, x));
    path.push([x, y]);
  }
  // glow pass then core pass
  for (const [lw, alpha] of [[ts * 0.10, 0.22], [ts * 0.045, 0.5], [ts * 0.016, 1.0]]) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = rgba(1, 1, 1, alpha);
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(path[0][0], path[0][1]);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
    ctx.stroke();
  }
  // forks
  for (let f = 0; f < 2; f++) {
    const i0 = 2 + ((rng.next() * (segs - 4)) | 0);
    let fx = path[i0][0], fy = path[i0][1];
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = ts * 0.012;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    for (let k = 0; k < 3; k++) {
      fx += rng.range(-0.16, 0.16) * ts;
      fy += rng.range(0.04, 0.11) * ts;
      ctx.lineTo(fx, fy);
    }
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

function drawBubble(ctx, ts) {
  const c = ts / 2, r = ts * 0.42;
  ctx.save();
  // rim-lit shell
  const g = ctx.createRadialGradient(c, c, r * 0.55, c, c, r);
  g.addColorStop(0, 'rgba(255,255,255,0.04)');
  g.addColorStop(0.78, 'rgba(255,255,255,0.20)');
  g.addColorStop(0.93, 'rgba(255,255,255,0.85)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(c, c, r, 0, TAU); ctx.fill();
  // highlight
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = gaussianGradient(ctx, c - r * 0.34, c - r * 0.38, r * 0.26, { power: 2, k: 4, inner: 0.85 });
  ctx.fillRect(0, 0, ts, ts);
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

function drawMote(ctx, ts) {
  const c = ts / 2;
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.44, { power: 1.2, k: 8.5, inner: 0.5 });
  ctx.fillRect(0, 0, ts, ts);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.11, { power: 2.2, k: 3.4, inner: 1 });
  ctx.fillRect(0, 0, ts, ts);
  // faint horizontal glint
  const g = ctx.createLinearGradient(c - ts * 0.4, c, c + ts * 0.4, c);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.32)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, c - ts * 0.012, ts, ts * 0.024);
  ctx.globalCompositeOperation = 'source-over';
}

function drawPollen(ctx, ts, rng) {
  const c = ts / 2;
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.34, { power: 1.8, k: 4.5, inner: 0.75 });
  ctx.fillRect(0, 0, ts, ts);
  // fuzzy hairs
  ctx.save();
  ctx.translate(c, c);
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  ctx.lineWidth = Math.max(1, ts * 0.008);
  for (let i = 0; i < 10; i++) {
    const a = rng.range(0, TAU);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * ts * 0.13, Math.sin(a) * ts * 0.13);
    ctx.lineTo(Math.cos(a) * ts * 0.35, Math.sin(a) * ts * 0.35);
    ctx.stroke();
  }
  ctx.restore();
}

/** Tileable warp noise for the heat-haze shader (RG = 2D offset, B = mask). */
function drawHazeNoise(ctx, ts) {
  const img = ctx.createImageData(ts, ts);
  const d = img.data;
  const period = 4;
  for (let y = 0; y < ts; y++) {
    for (let x = 0; x < ts; x++) {
      const u = x / ts, v = y / ts;
      const nx = fbm2p(u * period, v * period, period, 4, 2.0, 0.55, 11);
      const ny = fbm2p(u * period + 3.1, v * period + 7.7, period, 4, 2.0, 0.55, 29);
      const m = fbm2p(u * period * 0.5, v * period * 0.5, period * 0.5, 3, 2.0, 0.5, 41);
      const i = (y * ts + x) * 4;
      d[i] = Math.round(clamp01(nx * 0.5 + 0.5) * 255);
      d[i + 1] = Math.round(clamp01(ny * 0.5 + 0.5) * 255);
      d[i + 2] = Math.round(clamp01(m * 0.5 + 0.5) * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** A rough smudge — used for tyre-mark ends, decal scuffs, dirt splats. */
function drawScuff(ctx, ts, variant, rng) {
  const c = ts / 2;
  ctx.save();
  for (let i = 0; i < 9; i++) {
    const a = rng.range(0, TAU);
    const d = ts * rng.range(0, 0.20);
    const rx = ts * rng.range(0.14, 0.34);
    const ry = rx * rng.range(0.45, 1.0);
    ctx.globalCompositeOperation = i === 0 ? 'source-over' : 'lighter';
    ctx.save();
    ctx.translate(c + Math.cos(a) * d, c + Math.sin(a) * d);
    ctx.rotate(rng.range(0, TAU));
    ctx.scale(1, ry / rx);
    ctx.fillStyle = gaussianGradient(ctx, 0, 0, rx, { power: 1.7, k: 3.0, inner: i === 0 ? 0.85 : 0.35 });
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.5, { power: 4.0, k: 3.4, inner: 1 });
  ctx.fillRect(0, 0, ts, ts);
  ctx.globalCompositeOperation = 'source-over';
  void variant;
}

function drawShard(ctx, ts, rng) {
  const c = ts / 2;
  ctx.save();
  ctx.beginPath();
  const n = 3 + ((rng.next() * 2) | 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng.range(-0.4, 0.4);
    const r = ts * rng.range(0.16, 0.40);
    const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(c - ts * 0.3, c - ts * 0.3, c + ts * 0.3, c + ts * 0.3);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0.85)');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = Math.max(1, ts * 0.010);
  ctx.stroke();
  ctx.restore();
}

function drawSplat(ctx, ts, rng) {
  const c = ts / 2;
  ctx.save();
  ctx.beginPath();
  const n = 48;
  // phases fixed up front: sampling the RNG per vertex would make the outline
  // a jagged mess instead of an organic splat
  const p3 = rng.range(0, TAU), p7 = rng.range(0, TAU), p13 = rng.range(0, TAU);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const wob = 1
      + 0.22 * Math.sin(a * 3 + p3)
      + 0.13 * Math.sin(a * 7 + p7)
      + 0.07 * Math.sin(a * 13 + p13);
    const r = ts * 0.40 * wob;
    const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = gaussianGradient(ctx, c, c, ts * 0.46, { power: 3.0, k: 1.5, inner: 1 });
  ctx.fill();
  // satellite droplets
  for (let i = 0; i < 8; i++) {
    const a = rng.range(0, TAU);
    const d = ts * rng.range(0.36, 0.47);
    ctx.fillStyle = gaussianGradient(ctx, c + Math.cos(a) * d, c + Math.sin(a) * d,
      ts * rng.range(0.015, 0.045), { power: 2.2, k: 2.6, inner: 0.85 });
    ctx.fillRect(0, 0, ts, ts);
  }
  ctx.restore();
}

function drawRipple(ctx, ts) {
  const c = ts / 2;
  const rings = 3;
  ctx.save();
  for (let k = 0; k < rings; k++) {
    const rr = ts * (0.46 - k * 0.115);
    const a = 0.85 - k * 0.24;
    const stops = 18;
    const g = ctx.createRadialGradient(c, c, 0, c, c, rr);
    for (let i = 0; i <= stops; i++) {
      const t = i / stops;
      const peak = 0.88;
      let v = t < peak ? Math.pow(t / peak, 9) * 0.35 : lerp(1, 0, (t - peak) / (1 - peak));
      if (t > 0.995) v = 0;
      g.addColorStop(t, rgba(1, 1, 1, clamp01(v * a)));
    }
    ctx.globalCompositeOperation = k === 0 ? 'source-over' : 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, ts, ts);
  }
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

function drawSmokePuff(ctx, ts, rng) {
  drawSmokeFrame(ctx, ts, 3, 8, rng);
}

// ──────────────────────────────────────────────────────────── build

/**
 * Build (or fetch) the particle atlas.
 *
 * @param {import('../core/Assets.js').Assets} assets
 * @param {{tileSize?:number}} [opts]
 * @returns {THREE.CanvasTexture|null}
 */
export function particleAtlas(assets, opts = {}) {
  if (!assets) return null;
  const tileSize = opts.tileSize ?? 128;
  const size = tileSize * ATLAS_COLS;
  const key = `fx/atlas@${size}`;

  return assets.texture(key, (ctx) => {
    const ts = tileSize;
    const rng = new RNG(0x5eed1234);

    ctx.clearRect(0, 0, size, size);

    // ── row 0: workhorses ──
    tile(ctx, SPR.SOFT, ts, (c, s) => drawSoft(c, s));
    tile(ctx, SPR.GLOW, ts, (c, s) => drawGlow(c, s));
    tile(ctx, SPR.SPARK, ts, (c, s) => drawSpark(c, s));
    tile(ctx, SPR.STREAK, ts, (c, s) => drawStreak(c, s));
    tile(ctx, SPR.FLARE, ts, (c, s) => drawFlare(c, s));
    tile(ctx, SPR.RING_SOFT, ts, (c, s) => drawRing(c, s, false));
    tile(ctx, SPR.RING_HARD, ts, (c, s) => drawRing(c, s, true));
    tile(ctx, SPR.DROPLET, ts, (c, s) => drawDroplet(c, s));

    // ── row 1: smoke animation ──
    for (let f = 0; f < 8; f++) {
      const fr = new RNG(0xa11ce + f * 977);
      tile(ctx, SPR.SMOKE + f, ts, (c, s) => drawSmokeFrame(c, s, f, 8, fr));
      grainTile(ctx, SPR.SMOKE + f, ts, { freq: 4 + f * 0.5, octaves: 4, amount: 0.42, seed: 100 + f });
    }

    // ── row 2: flame animation ──
    for (let f = 0; f < 8; f++) {
      const fr = new RNG(0xf1a3e + f * 613);
      tile(ctx, SPR.FLAME + f, ts, (c, s) => drawFlameFrame(c, s, f, 8, fr));
    }

    // ── row 3: splash animation ──
    for (let f = 0; f < 8; f++) {
      const fr = new RNG(0x5b1a54 + f * 331);
      tile(ctx, SPR.SPLASH + f, ts, (c, s) => drawSplashFrame(c, s, f, 8, fr));
    }

    // ── row 4: dust + chips ──
    for (let v = 0; v < 4; v++) {
      const fr = new RNG(0xd057 + v * 149);
      tile(ctx, SPR.DUST + v, ts, (c, s) => drawDustBase(c, s, v, fr));
      cellTile(ctx, SPR.DUST + v, ts, { period: 6 + v, amount: 0.45 + v * 0.06, seed: 7 + v, invert: v % 2 === 1 });
      grainTile(ctx, SPR.DUST + v, ts, { freq: 6 + v, octaves: 4, amount: 0.55, seed: 200 + v, contrastPow: 1.25 });
    }
    for (let v = 0; v < 4; v++) {
      const fr = new RNG(0xc41b + v * 271);
      tile(ctx, SPR.CHIP + v, ts, (c, s) => drawChip(c, s, v, fr));
    }

    // ── row 5: organics ──
    for (let v = 0; v < 4; v++) {
      const fr = new RNG(0xb1ade + v * 193);
      tile(ctx, SPR.BLADE + v, ts, (c, s) => drawBlade(c, s, v, fr));
    }
    for (let v = 0; v < 4; v++) {
      const fr = new RNG(0x1eaf + v * 457);
      tile(ctx, SPR.LEAF + v, ts, (c, s) => drawLeaf(c, s, v, fr));
    }

    // ── row 6: small bright things ──
    tile(ctx, SPR.EMBER, ts, (c, s) => {
      drawGlow(c, s);
    });
    for (let v = 0; v < 3; v++) {
      const fr = new RNG(0xe1ec + v * 89);
      tile(ctx, SPR.ELECTRIC + v, ts, (c, s) => drawElectric(c, s, v, fr));
    }
    tile(ctx, SPR.BUBBLE, ts, (c, s) => drawBubble(c, s));
    tile(ctx, SPR.MOTE, ts, (c, s) => drawMote(c, s));
    tile(ctx, SPR.POLLEN, ts, (c, s) => drawPollen(c, s, new RNG(0xb011e)));

    // ── row 7: marks & misc ──
    for (let v = 0; v < 4; v++) {
      const fr = new RNG(0x5c0ff + v * 617);
      tile(ctx, SPR.SCUFF + v, ts, (c, s) => drawScuff(c, s, v, fr));
      grainTile(ctx, SPR.SCUFF + v, ts, { freq: 7 + v, octaves: 4, amount: 0.5, seed: 300 + v });
    }
    tile(ctx, SPR.SHARD, ts, (c, s) => drawShard(c, s, new RNG(0x5ba3d)));
    tile(ctx, SPR.SMOKE_PUFF, ts, (c, s) => drawSmokePuff(c, s, new RNG(0x9bff)));
    grainTile(ctx, SPR.SMOKE_PUFF, ts, { freq: 5, octaves: 4, amount: 0.45, seed: 401 });
    tile(ctx, SPR.SPLAT, ts, (c, s) => drawSplat(c, s, new RNG(0x591a7)));
    tile(ctx, SPR.RIPPLE, ts, (c, s) => drawRipple(c, s));

    void rng;
  }, {
    size,
    // The atlas is authored in the renderer's linear working space: the RGB
    // channels are pure intensity masks that get tinted per particle, so an
    // sRGB decode would just darken every sprite.
    srgb: false,
    wrap: THREE.ClampToEdgeWrapping,
    flipY: false,
    mipmaps: true,
  });
}

/**
 * Standalone haze-noise texture (its own tileable RepeatWrapping texture, since
 * the atlas is clamped and the shimmer shader needs to scroll it).
 */
export function hazeNoiseTexture(assets, opts = {}) {
  if (!assets) return null;
  const size = opts.size ?? 128;
  return assets.texture(`fx/haze@${size}`, (ctx) => drawHazeNoise(ctx, size), {
    size, srgb: false, wrap: THREE.RepeatWrapping, flipY: false, mipmaps: true,
  });
}

export default particleAtlas;
