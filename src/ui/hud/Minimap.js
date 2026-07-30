/**
 * RC RUMBLE — in-race minimap.
 *
 * Built entirely from the track's centreline spline: the road ribbon and the
 * checkpoint pips are baked once into an offscreen canvas when the track loads,
 * and every frame we blit that and stamp the car dots on top. Eight dots plus a
 * blit is well inside the UI frame budget.
 *
 * The player is a larger amber chevron pointing along its heading; rivals are
 * small dots in their livery colour, dimmed when they are a lap behind.
 */

import { THEME, withAlpha, fitCanvas, drawDisplay } from '../Theme.js';
import { outlineFor, cacheOutline, fitOutline, drawRibbon } from '../TrackMap.js';

const C = THEME.color;
const _p = { x: 0, y: 0 };

export class Minimap {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-minimap';
    this.w = 0;
    this.h = 0;
    this.fit = null;
    this.outline = null;
    this.checkpoints = null;
    this.startPoint = null;
    this._static = document.createElement('canvas');
    this._staticKey = '';
    this._trackId = null;
    this._pulse = 0;
  }

  resize(w, h) {
    this.w = Math.max(60, Math.round(w));
    this.h = Math.max(40, Math.round(h));
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this._staticKey = '';
    return this;
  }

  /** @param {object|null} track TrackData */
  setTrack(track) {
    this._trackId = track?.id ?? null;
    if (track) cacheOutline(track.id, track);
    this.outline = track ? outlineFor(track.id, null, track) : null;
    this.checkpoints = null;
    this.startPoint = null;

    if (track?.checkpoints?.length) {
      const cps = [];
      for (const cp of track.checkpoints) {
        const p = cp?.position;
        if (!p) continue;
        cps.push(p.x, p.z, cp.isFinish ? 1 : 0);
      }
      this.checkpoints = cps.length ? new Float32Array(cps) : null;
    }
    const grid = track?.startGrid?.[0]?.position;
    if (grid) this.startPoint = [grid.x, grid.z];
    this._staticKey = '';
    return this;
  }

  clear() {
    this.outline = null;
    this.checkpoints = null;
    this.startPoint = null;
    this._staticKey = '';
  }

  _bake() {
    const key = `${this._trackId}|${this.w}|${this.h}|${this.outline?.pts?.length ?? 0}`;
    if (this._staticKey === key) return;
    this._staticKey = key;

    const ctx = fitCanvas(this._static, this.w, this.h);
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.outline) { this.fit = null; return; }

    this.fit = fitOutline(this.outline, this.w, this.h, { pad: Math.max(8, this.w * 0.07) });
    const roadW = Math.max(3.2, Math.min(this.w, this.h) * 0.055);

    drawRibbon(ctx, this.fit, {
      width: roadW,
      casing: 'rgba(2,5,10,0.85)',
      core: this.outline.real ? 'rgba(70,96,136,0.92)' : 'rgba(60,78,108,0.5)',
      centre: withAlpha(C.cyan, this.outline.real ? 0.30 : 0.14),
      dash: [3, 5],
      closed: true,
    });

    // Checkpoint pips, drawn perpendicular to the local path direction.
    if (this.checkpoints) {
      ctx.save();
      ctx.lineCap = 'round';
      for (let i = 0; i < this.checkpoints.length; i += 3) {
        const x = this.checkpoints[i];
        const z = this.checkpoints[i + 1];
        const isFinish = this.checkpoints[i + 2] > 0.5;
        this.fit.project(x, z, _p);
        ctx.strokeStyle = isFinish ? withAlpha(C.amber, 0.95) : withAlpha(C.cyan, 0.42);
        ctx.lineWidth = isFinish ? 2.4 : 1.6;
        const r = isFinish ? roadW * 0.85 : roadW * 0.52;
        ctx.beginPath();
        ctx.arc(_p.x, _p.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Start/finish marker
    if (this.startPoint) {
      this.fit.project(this.startPoint[0], this.startPoint[1], _p);
      ctx.fillStyle = withAlpha(C.amber, 0.9);
      ctx.beginPath();
      ctx.arc(_p.x, _p.y, Math.max(2.4, roadW * 0.34), 0, Math.PI * 2);
      ctx.fill();
    }

    if (!this.outline.real) {
      drawDisplay(ctx, 'LAYOUT', this.w * 0.5, this.h - 5, {
        size: Math.max(7, this.h * 0.075), tracking: 0.3, weight: 0.2,
        align: 'center', fill: 'rgba(140,165,205,0.32)',
      });
    }
  }

  /**
   * @param {Array} cars    game.cars
   * @param {object} player game.playerCar
   * @param {number} rawDt
   */
  draw(cars, player, rawDt) {
    if (!this.w) return;
    this._bake();
    const ctx = fitCanvas(this.canvas, this.w, this.h);
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);

    // Backing plate
    ctx.fillStyle = 'rgba(6,11,20,0.55)';
    rrect(ctx, 0.5, 0.5, this.w - 1, this.h - 1, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(126,186,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.drawImage(this._static, 0, 0, this.w, this.h);
    if (!this.fit || !cars?.length) return;

    this._pulse = (this._pulse + rawDt * 2.4) % (Math.PI * 2);
    const dotR = Math.max(2.4, Math.min(this.w, this.h) * 0.035);
    const playerLap = player?.lap ?? 0;

    // Rivals first so the player dot always wins the overlap.
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car || car.isPlayer) continue;
      const pos = car.body?.position ?? car.group?.position;
      if (!pos) continue;
      this.fit.project(pos.x, pos.z, _p);
      const behind = (car.lap ?? 0) < playerLap;
      const col = liveryColor(car);
      ctx.globalAlpha = behind ? 0.5 : 0.95;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(_p.x, _p.y, dotR, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (player) {
      const pos = player.body?.position ?? player.group?.position;
      if (pos) {
        this.fit.project(pos.x, pos.z, _p);
        // Heading: rotate the world forward vector through the same fit rotation.
        let hx = 0, hy = -1;
        const q = player.body?.quaternion ?? player.group?.quaternion;
        if (q) {
          // forward = (0,0,-1) rotated by q, projected to XZ
          const fx = -2 * (q.x * q.z + q.w * q.y);
          const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
          const rx = fx * this.fit.cos - fz * this.fit.sin;
          const ry = fx * this.fit.sin + fz * this.fit.cos;
          const len = Math.hypot(rx, ry) || 1;
          hx = (rx / len) * this.fit.mirror;
          hy = ry / len;
        }
        const glow = 0.55 + 0.45 * Math.sin(this._pulse);
        ctx.save();
        ctx.translate(_p.x, _p.y);
        ctx.rotate(Math.atan2(hy, hx));
        ctx.shadowColor = withAlpha(C.player, 0.55 * glow);
        ctx.shadowBlur = dotR * 3.2;
        ctx.fillStyle = C.player;
        const r = dotR * 1.75;
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.lineTo(-r * 0.72, r * 0.74);
        ctx.lineTo(-r * 0.34, 0);
        ctx.lineTo(-r * 0.72, -r * 0.74);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(20,12,0,0.7)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

/**
 * Livery colour as a CSS string, memoised on the car — this runs once per car
 * per frame and template-literal churn in a per-frame path is exactly what the
 * no-allocation rule is about.
 */
function liveryColor(car) {
  if (car?._uiLiveryHex) return car._uiLiveryHex;
  const n = car?.colorPrimary ?? car?.def?.colorPrimary;
  let hex = C.rival;
  if (typeof n === 'number') hex = `#${(n >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
  else if (typeof n === 'string') hex = n;
  if (car) car._uiLiveryHex = hex;
  return hex;
}

function rrect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export default Minimap;
