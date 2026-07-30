/**
 * RC RUMBLE — analogue speedometer.
 *
 * A real dial, not a number in a box: swept scale with major/minor ticks and
 * drawn numerals, an RPM ring around the outside that goes red at the limiter,
 * a tapered needle with a drop shadow and a counterweight, a digital readout in
 * the display face, a gear window, and a nitro/boost bar across the bottom.
 *
 * Everything static (bezel, ticks, numerals) is baked into an offscreen canvas
 * once per size, so a frame costs one blit plus a handful of arcs.
 */

import { THEME, withAlpha, fitCanvas, drawDisplay, dpr } from '../Theme.js';

const C = THEME.color;

/** Dial sweep, in radians, clockwise from the canvas +X axis. */
const A0 = Math.PI * 0.76;
const A1 = Math.PI * 2.24;
const SWEEP = A1 - A0;

/** Dial radii as fractions of the widget size. Shared by the bake and the
 *  per-frame pass, which must agree exactly. */
const R_OUTER = 0.475;
const R_DIAL = 0.400;
const R_TICK_OUT = 0.386;
const R_TICK_IN = 0.336;
const R_MINOR_IN = 0.358;

export class Speedometer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-speedo';
    this.size = 0;
    this.maxSpeed = 140;
    this._static = document.createElement('canvas');
    this._staticKey = '';
    // Smoothed display values so the needle has real inertia.
    this.needle = 0;
    this.rpmSmooth = 0;
    this.boostSmooth = 0;
    this._shiftFlash = 0;
    this._lastGear = 1;
  }

  /** @param {number} size CSS px (square) */
  resize(size) {
    this.size = Math.max(90, Math.round(size));
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    this._staticKey = '';
    return this;
  }

  /** Round the scale top up to a sensible number above the car's top speed. */
  setMaxSpeed(kmh) {
    const v = Math.max(40, Math.ceil((kmh * 1.14) / 20) * 20);
    if (v !== this.maxSpeed) { this.maxSpeed = v; this._staticKey = ''; }
    return this;
  }

  // ────────────────────────────────────────────────────────── static bake

  _bakeStatic() {
    const key = `${this.size}|${this.maxSpeed}|${dpr().toFixed(2)}`;
    if (this._staticKey === key) return;
    this._staticKey = key;

    const s = this.size;
    const ctx = fitCanvas(this._static, s, s);
    if (!ctx) return;
    ctx.clearRect(0, 0, s, s);

    const cx = s * 0.5;
    const cy = s * 0.5;
    const rOuter = s * R_OUTER;
    const rDial = s * R_DIAL;
    const rTickOut = s * R_TICK_OUT;
    const rTickIn = s * R_TICK_IN;
    const rMinorIn = s * R_MINOR_IN;

    // ── glass body ──
    const body = ctx.createRadialGradient(cx - s * 0.13, cy - s * 0.18, s * 0.03, cx, cy, rOuter);
    body.addColorStop(0, 'rgba(26,40,64,0.86)');
    body.addColorStop(0.62, 'rgba(9,15,26,0.80)');
    body.addColorStop(1, 'rgba(4,7,13,0.92)');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.fill();

    // Bezel
    ctx.strokeStyle = withAlpha(C.panelEdge, 1);
    ctx.lineWidth = Math.max(1, s * 0.006);
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
    ctx.stroke();

    // Inner well
    ctx.strokeStyle = 'rgba(126,186,255,0.10)';
    ctx.lineWidth = Math.max(1, s * 0.004);
    ctx.beginPath();
    ctx.arc(cx, cy, rDial, 0, Math.PI * 2);
    ctx.stroke();

    // ── RPM ring track ──
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = s * 0.036;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.442, A0, A1);
    ctx.stroke();

    // ── ticks ──
    const majorStep = this.maxSpeed >= 200 ? 40 : 20;
    const minorStep = majorStep / 4;
    const redFrom = 0.86;

    for (let v = 0; v <= this.maxSpeed + 0.001; v += minorStep) {
      const t = v / this.maxSpeed;
      const a = A0 + SWEEP * t;
      const major = Math.abs(v % majorStep) < 1e-6;
      const hot = t >= redFrom;
      const ri = major ? rTickIn : rMinorIn;
      ctx.strokeStyle = hot
        ? (major ? '#ff6a5a' : 'rgba(255,106,90,0.55)')
        : (major ? 'rgba(233,240,255,0.90)' : 'rgba(163,180,208,0.42)');
      ctx.lineWidth = major ? s * 0.017 : s * 0.008;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * ri, cy + Math.sin(a) * ri);
      ctx.lineTo(cx + Math.cos(a) * rTickOut, cy + Math.sin(a) * rTickOut);
      ctx.stroke();
    }

    // Redline arc
    ctx.strokeStyle = 'rgba(255,79,98,0.5)';
    ctx.lineWidth = s * 0.014;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, rTickOut + s * 0.014, A0 + SWEEP * redFrom, A1);
    ctx.stroke();

    // ── numerals ──
    // Label every other major when the dial would otherwise crowd: eight
    // numbers over a 265° sweep at this diameter simply do not fit.
    const labelStep = (this.maxSpeed / majorStep) > 6 ? majorStep * 2 : majorStep;
    const numSize = s * 0.070;
    for (let v = 0; v <= this.maxSpeed + 0.001; v += labelStep) {
      const t = v / this.maxSpeed;
      const a = A0 + SWEEP * t;
      const r = rTickIn - numSize * 0.62;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      drawDisplay(ctx, String(Math.round(v)), x, y + numSize * 0.46, {
        size: numSize,
        tracking: 0.02,
        weight: 0.17,
        align: 'center',
        fill: t >= redFrom ? 'rgba(255,140,130,0.95)' : 'rgba(200,216,240,0.80)',
      });
    }

    // Unit label, tucked into the empty wedge under the readout.
    drawDisplay(ctx, 'KM/H', cx, cy + s * 0.408, {
      size: s * 0.052, tracking: 0.26, weight: 0.17, align: 'center',
      fill: 'rgba(163,180,208,0.55)',
    });

    // Boost bar track, just under the hub (drawn static, filled dynamically).
    const bw = s * 0.34;
    const bh = s * 0.028;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    roundRect(ctx, cx - bw / 2, cy + s * 0.082, bw, bh, bh * 0.5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // ──────────────────────────────────────────────────────────── per frame

  /**
   * @param {object} st
   * @param {number} st.kmh          display speed
   * @param {number} st.rpm01        0..1 engine speed toward the limiter
   * @param {number|string} st.gear  -1 reverse, 0 neutral, 1.. forward
   * @param {number} st.boost01      0..1 nitro/turbo remaining
   * @param {boolean} st.limiter     on the rev limiter
   * @param {number} st.drift01      0..1, tints the needle
   * @param {number} rawDt
   */
  draw(st, rawDt) {
    const s = this.size;
    if (!s) return;
    this._bakeStatic();
    const ctx = fitCanvas(this.canvas, s, s);
    if (!ctx) return;
    ctx.clearRect(0, 0, s, s);
    ctx.drawImage(this._static, 0, 0, s, s);

    const cx = s * 0.5;
    const cy = s * 0.5;

    // ── smoothing ──
    const k = 1 - Math.exp(-16 * Math.min(rawDt, 0.05));
    const target = Math.min(1, Math.max(0, (st.kmh ?? 0) / this.maxSpeed));
    this.needle += (target - this.needle) * k;
    this.rpmSmooth += ((st.rpm01 ?? 0) - this.rpmSmooth) * (1 - Math.exp(-24 * Math.min(rawDt, 0.05)));
    this.boostSmooth += ((st.boost01 ?? 0) - this.boostSmooth) * (1 - Math.exp(-12 * Math.min(rawDt, 0.05)));

    const gear = st.gear ?? 1;
    if (gear !== this._lastGear) { this._shiftFlash = 1; this._lastGear = gear; }
    this._shiftFlash = Math.max(0, this._shiftFlash - rawDt * 3.2);

    // ── RPM ring ──
    const rp = Math.min(1, this.rpmSmooth);
    if (rp > 0.001) {
      const hot = rp > 0.92 || st.limiter;
      const g = ctx.createLinearGradient(0, 0, s, s);
      if (hot) { g.addColorStop(0, '#ff8b5a'); g.addColorStop(1, '#ff3b4e'); }
      else { g.addColorStop(0, C.cyanDeep); g.addColorStop(1, C.cyan); }
      ctx.strokeStyle = g;
      ctx.lineWidth = s * 0.036;
      ctx.lineCap = 'round';
      ctx.shadowColor = hot ? 'rgba(255,70,80,0.65)' : C.cyanGlow;
      ctx.shadowBlur = s * (hot ? 0.09 : 0.055);
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.442, A0, A0 + SWEEP * rp);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ── swept speed arc, hugging the inside of the tick ring ──
    if (this.needle > 0.004) {
      const hot = this.needle > 0.86;
      ctx.strokeStyle = hot ? withAlpha('#ff6a5a', 0.85) : withAlpha(C.cyan, 0.50);
      ctx.lineWidth = s * 0.014;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, R_DIAL * s - s * 0.005, A0, A0 + SWEEP * this.needle);
      ctx.stroke();
    }

    // ── boost bar ──
    const bw = s * 0.34;
    const bh = s * 0.028;
    const bx = cx - bw / 2;
    const by = cy + s * 0.082;
    if (this.boostSmooth > 0.002) {
      const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      g.addColorStop(0, '#ffcf5a');
      g.addColorStop(1, '#ff6a1f');
      ctx.fillStyle = g;
      ctx.shadowColor = 'rgba(255,140,40,0.6)';
      ctx.shadowBlur = s * 0.05;
      roundRect(ctx, bx, by, Math.max(bh, bw * Math.min(1, this.boostSmooth)), bh, bh * 0.5);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // ── needle ──
    const a = A0 + SWEEP * this.needle;
    const nLen = s * 0.360;
    const nBack = s * 0.070;
    const halfW = s * 0.018;
    const cos = Math.cos(a), sin = Math.sin(a);
    const px = -sin, py = cos;
    const tipX = cx + cos * nLen, tipY = cy + sin * nLen;
    const baseX = cx - cos * nBack, baseY = cy - sin * nBack;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = s * 0.03;
    ctx.shadowOffsetY = s * 0.008;
    const drift = Math.min(1, st.drift01 ?? 0);
    const needleCol = drift > 0.35
      ? mix('#ff4f62', '#ffb223', 1 - drift)
      : (this.needle > 0.86 ? '#ff5a4a' : '#ff8f5c');
    const ng = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
    ng.addColorStop(0, withAlpha(needleCol, 0.35));
    ng.addColorStop(0.35, needleCol);
    ng.addColorStop(1, '#fff2e2');
    ctx.fillStyle = ng;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(cx + px * halfW * 0.55 - cos * s * 0.01, cy + py * halfW * 0.55 - sin * s * 0.01);
    ctx.lineTo(baseX + px * halfW, baseY + py * halfW);
    ctx.lineTo(baseX - px * halfW, baseY - py * halfW);
    ctx.lineTo(cx - px * halfW * 0.55 - cos * s * 0.01, cy - py * halfW * 0.55 - sin * s * 0.01);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Hub
    const hub = ctx.createRadialGradient(cx - s * 0.008, cy - s * 0.010, s * 0.004, cx, cy, s * 0.048);
    hub.addColorStop(0, '#5d6c85');
    hub.addColorStop(0.6, '#1d2635');
    hub.addColorStop(1, '#080c14');
    ctx.fillStyle = hub;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.048, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = withAlpha(needleCol, 0.55);
    ctx.lineWidth = Math.max(1, s * 0.005);
    ctx.stroke();

    // ── digital readout, in the empty wedge at the bottom of the sweep ──
    const speedTxt = String(Math.max(0, Math.round(st.kmh ?? 0)));
    drawDisplay(ctx, speedTxt, cx, cy + s * 0.330, {
      size: s * 0.150,
      tracking: 0.03,
      weight: 0.155,
      slant: 0.10,
      align: 'center',
      fill: '#ffffff',
      glow: this.needle > 0.86 ? 'rgba(255,90,74,0.75)' : 'rgba(84,220,255,0.55)',
      glowBlur: s * 0.10,
    });

    // ── gear window, above the hub ──
    const gearTxt = gear === -1 ? 'R' : (gear === 0 ? 'N' : String(gear));
    const gy = cy - s * 0.150;
    ctx.fillStyle = 'rgba(4,8,15,0.68)';
    roundRect(ctx, cx - s * 0.058, gy - s * 0.078, s * 0.116, s * 0.108, s * 0.016);
    ctx.fill();
    ctx.strokeStyle = st.limiter
      ? 'rgba(255,79,98,0.75)'
      : withAlpha(C.cyan, 0.22 + this._shiftFlash * 0.6);
    ctx.lineWidth = Math.max(1, s * 0.005);
    ctx.stroke();
    drawDisplay(ctx, gearTxt, cx, gy + s * 0.008, {
      size: s * 0.076, tracking: 0.02, weight: 0.19, align: 'center', slant: 0.08,
      fill: st.limiter ? '#ff8b7a' : mix('#dce8ff', '#ffffff', this._shiftFlash),
      glow: this._shiftFlash > 0.02 ? withAlpha(C.cyan, this._shiftFlash) : null,
      glowBlur: s * 0.08,
    });

    // NITRO tag only while there is boost to show, so the dial stays quiet.
    if (this.boostSmooth > 0.002) {
      drawDisplay(ctx, 'NITRO', cx, cy + s * 0.163, {
        size: s * 0.042, tracking: 0.26, weight: 0.19, align: 'center', fill: '#ffcf5a',
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────── helpers

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const u = Math.max(0, Math.min(1, t));
  const r = Math.round(((pa >> 16) & 255) * (1 - u) + ((pb >> 16) & 255) * u);
  const g = Math.round(((pa >> 8) & 255) * (1 - u) + ((pb >> 8) & 255) * u);
  const bl = Math.round((pa & 255) * (1 - u) + (pb & 255) * u);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

export default Speedometer;
