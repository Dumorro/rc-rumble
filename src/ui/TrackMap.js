/**
 * RC RUMBLE — track-shape extraction and 2D fitting.
 *
 * Shared by the in-race minimap and the track-select cards. Everything is
 * derived from the centreline spline the track system already builds; when a
 * track has not been loaded yet (the select screen never loads geometry) we
 * fall back, in order, to
 *
 *   1. a cached outline from the last time that track was loaded,
 *   2. any preview node list a track module chose to publish
 *      (`previewPath` / `previewNodes` / `nodes`),
 *   3. a deterministic, seeded stylised circuit so the card is never blank.
 *
 * Only step 1 and 2 are the *real* shape; step 3 is clearly a stylisation and
 * is drawn dimmer so it never lies about a track you have not raced.
 */

import { clamp } from './Dom.js';

/** trackId → { pts: Float32Array (x,z pairs), real: boolean } */
const _outlineCache = new Map();

/**
 * Pull an (x, z) polyline out of whatever track-ish thing we were handed.
 * @param {object} source TrackData | CenterlineSpline | { nodes } | id string
 * @param {number} [count]
 * @returns {{pts: Float32Array, real: boolean, closed: boolean}|null}
 */
export function extractOutline(source, count = 220) {
  if (!source) return null;

  // TrackData → spline
  const spline = source.spline ?? (typeof source.sample === 'function' ? source : null);
  if (spline && typeof spline.sample === 'function') {
    const n = Math.max(24, count | 0);
    const pts = new Float32Array(n * 2);
    const out = {};
    for (let i = 0; i < n; i++) {
      let p = null;
      try {
        const s = spline.sample(i / n);
        p = s?.position ?? s;
      } catch { p = null; }
      if (!p || !Number.isFinite(p.x)) {
        // Fall back to positionAt if sample() has a different shape.
        try { p = spline.positionAt?.(i / n, out) ?? null; } catch { p = null; }
      }
      if (!p || !Number.isFinite(p.x)) return null;
      pts[i * 2] = p.x;
      pts[i * 2 + 1] = p.z;
    }
    return { pts, real: true, closed: spline.closed !== false };
  }

  // A raw node array, e.g. [[x,y,z,w], …] or [{position:{x,z}}, …]
  const nodes = source.previewPath ?? source.previewNodes ?? source.nodes ?? (Array.isArray(source) ? source : null);
  if (Array.isArray(nodes) && nodes.length >= 3) {
    const pts = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      let x, z;
      if (Array.isArray(n)) { x = n[0]; z = n.length >= 3 ? n[2] : n[1]; }
      else if (n?.position) { x = n.position.x; z = n.position.z; }
      else { x = n?.x; z = n?.z; }
      if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
      pts[i * 2] = x;
      pts[i * 2 + 1] = z;
    }
    return { pts, real: true, closed: true };
  }
  return null;
}

/** Remember a track's real outline so the select screen can show it later. */
export function cacheOutline(trackId, source) {
  if (!trackId) return null;
  const o = extractOutline(source, 240);
  if (o) _outlineCache.set(trackId, o);
  return o;
}

/**
 * The best outline we can produce for a track id right now.
 * @param {string} trackId
 * @param {object} [game] used to check whether the track is currently loaded
 * @param {object} [mod] the track module / listTracks() entry, if we have one
 */
export function outlineFor(trackId, game = null, mod = null) {
  const cached = _outlineCache.get(trackId);
  if (cached) return cached;

  if (game?.track?.id === trackId) {
    const o = cacheOutline(trackId, game.track);
    if (o) return o;
  }
  const reg = game?.trackSystem?.registry?.get?.(trackId);
  for (const candidate of [reg, mod]) {
    if (!candidate) continue;
    const o = extractOutline(candidate, 240);
    if (o) { _outlineCache.set(trackId, o); return o; }
  }
  const synth = syntheticOutline(trackId);
  _outlineCache.set(trackId, synth);
  return synth;
}

/** Deterministic stylised loop, so a card is never empty. Marked `real:false`. */
export function syntheticOutline(seedStr = 'track') {
  let h = 2166136261;
  const s = String(seedStr);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };

  const lobes = 3 + Math.floor(rnd() * 3);
  const n = 180;
  const pts = new Float32Array(n * 2);
  const phase = rnd() * Math.PI * 2;
  const a1 = 0.18 + rnd() * 0.16;
  const a2 = 0.08 + rnd() * 0.12;
  const squash = 0.62 + rnd() * 0.3;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = 1 + a1 * Math.sin(lobes * t + phase) + a2 * Math.sin((lobes + 2) * t - phase * 1.7);
    pts[i * 2] = Math.cos(t) * r;
    pts[i * 2 + 1] = Math.sin(t) * r * squash;
  }
  return { pts, real: false, closed: true };
}

/**
 * Fit a world-space (x, z) polyline into a `w × h` canvas box.
 *
 * The path is rotated so its longest principal axis runs horizontally, which
 * makes wildly different track shapes read at the same size on a card.
 *
 * @returns {{ sx:Float32Array, scale:number, cx:number, cz:number,
 *             ox:number, oy:number, cos:number, sin:number, w:number, h:number,
 *             project:(x:number,z:number,out:{x:number,y:number})=>{x:number,y:number} }}
 */
export function fitOutline(outline, w, h, { pad = 10, rotate = true, flipX = false } = {}) {
  const pts = outline?.pts ?? new Float32Array([0, 0, 1, 0, 1, 1]);
  const n = pts.length >> 1;

  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; }
  cx /= n; cz /= n;

  // Principal axis via the 2×2 covariance matrix.
  let angle = 0;
  if (rotate) {
    let sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < n; i++) {
      const dx = pts[i * 2] - cx;
      const dz = pts[i * 2 + 1] - cz;
      sxx += dx * dx; szz += dz * dz; sxz += dx * dz;
    }
    angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  }
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 2] - cx;
    const dz = pts[i * 2 + 1] - cz;
    const rx = dx * cos - dz * sin;
    const ry = dx * sin + dz * cos;
    if (rx < minX) minX = rx; if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry; if (ry > maxY) maxY = ry;
  }
  const spanX = Math.max(1e-4, maxX - minX);
  const spanY = Math.max(1e-4, maxY - minY);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
  const ox = w * 0.5 - ((minX + maxX) * 0.5) * scale;
  const oy = h * 0.5 - ((minY + maxY) * 0.5) * scale;
  const mirror = flipX ? -1 : 1;

  const sx = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 2] - cx;
    const dz = pts[i * 2 + 1] - cz;
    sx[i * 2] = (dx * cos - dz * sin) * scale * mirror + (flipX ? w - ox : ox);
    sx[i * 2 + 1] = (dx * sin + dz * cos) * scale + oy;
  }

  const fit = {
    sx, scale, cx, cz, ox, oy, cos, sin, w, h, mirror,
    project(x, z, out = { x: 0, y: 0 }) {
      const dx = x - cx;
      const dz = z - cz;
      out.x = (dx * cos - dz * sin) * scale * mirror + (flipX ? w - ox : ox);
      out.y = (dx * sin + dz * cos) * scale + oy;
      return out;
    },
  };
  return fit;
}

/**
 * Stroke the fitted path as a road ribbon: a dark casing, a lighter core, and
 * an optional dashed centre line.
 */
export function drawRibbon(ctx, fit, {
  width = 7, casing = 'rgba(3,6,12,0.9)', core = '#2c3d59',
  centre = null, closed = true, glow = null, dash = null,
} = {}) {
  const sx = fit.sx;
  const n = sx.length >> 1;
  if (n < 2) return;
  const path = new Path2D();
  path.moveTo(sx[0], sx[1]);
  for (let i = 1; i < n; i++) path.lineTo(sx[i * 2], sx[i * 2 + 1]);
  if (closed) path.closePath();

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = width * 1.8;
  }
  ctx.strokeStyle = casing;
  ctx.lineWidth = width + 3;
  ctx.stroke(path);
  ctx.shadowBlur = 0;
  ctx.strokeStyle = core;
  ctx.lineWidth = width;
  ctx.stroke(path);
  if (centre) {
    ctx.setLineDash(dash ?? [4, 6]);
    ctx.strokeStyle = centre;
    ctx.lineWidth = Math.max(1, width * 0.14);
    ctx.stroke(path);
    ctx.setLineDash([]);
  }
  ctx.restore();
  return path;
}

/** Total planar length of an outline, in metres. Used for the "length" chip. */
export function outlineLength(outline) {
  const pts = outline?.pts;
  if (!pts) return 0;
  const n = pts.length >> 1;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j * 2] - pts[i * 2];
    const dz = pts[j * 2 + 1] - pts[i * 2 + 1];
    d += Math.hypot(dx, dz);
  }
  return d;
}

export function clearOutlineCache() { _outlineCache.clear(); }

export { clamp };
