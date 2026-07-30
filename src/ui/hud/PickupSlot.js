/**
 * RC RUMBLE — the pickup slot.
 *
 * Three states, all drawn on one canvas:
 *
 *   empty    a dashed pickup diamond, breathing gently
 *   rolling  a reel: icons whip past with motion blur and a rising click rate,
 *            decelerating into the settled item exactly as `chargeT` reaches 1
 *   armed    the settled icon with an ammo pip row, a coloured aura, and a
 *            fire prompt that pulses
 *
 * The roll is driven by `slot.chargeT` (0..1) from the PickupSystem, so the
 * animation and the simulation can never disagree.
 */

import { THEME, withAlpha, fitCanvas, drawDisplay } from '../Theme.js';
import { blitWeaponIcon, colorFor, labelFor, iconIdFor, REEL_ORDER } from './WeaponIcons.js';

const C = THEME.color;

export class PickupSlot {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-pickup';
    this.size = 0;
    this.height = 0;

    this._reelPos = 0;        // continuous index into REEL_ORDER
    this._settleFlash = 0;
    this._armPulse = 0;
    this._emptyT = 0;
    this._lastId = null;
    this._lastRolling = false;
    /** Set by the HUD so the prompt matches the actual binding. */
    this.fireKeyLabel = 'CTRL';
  }

  resize(size) {
    this.size = Math.max(56, Math.round(size));
    this.height = Math.round(this.size * 1.34);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.height}px`;
    return this;
  }

  /**
   * @param {object|null} slot car.weapon — { id, name, icon, ammo, chargeT, ready, rolling }
   * @param {number} rawDt
   */
  draw(slot, rawDt) {
    const s = this.size;
    if (!s) return;
    const ctx = fitCanvas(this.canvas, s, this.height);
    if (!ctx) return;
    ctx.clearRect(0, 0, s, this.height);

    const dt = Math.min(rawDt ?? 0.016, 0.05);
    const rolling = !!slot?.rolling;
    const armed = !!slot && !rolling && (slot.ammo ?? 0) > 0;
    const id = iconIdFor(slot?.icon ?? slot?.id);

    if (this._lastRolling && !rolling && armed) this._settleFlash = 1;
    this._lastRolling = rolling;
    this._lastId = id;

    this._settleFlash = Math.max(0, this._settleFlash - dt * 2.6);
    this._armPulse = (this._armPulse + dt * 2.3) % (Math.PI * 2);
    this._emptyT = (this._emptyT + dt * 1.5) % (Math.PI * 2);

    const cx = s * 0.5;
    const cy = s * 0.5;
    const r = s * 0.44;
    const accent = armed || rolling ? colorFor(rolling ? REEL_ORDER[Math.floor(this._reelPos) % REEL_ORDER.length] : id) : C.inkFaint;

    // ── frame ──
    ctx.save();
    const breathe = armed ? 0.5 + 0.5 * Math.sin(this._armPulse) : 0.35 + 0.2 * Math.sin(this._emptyT);
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI * 0.25);
    const half = r * 0.80;
    const plate = ctx.createLinearGradient(-half, -half, half, half);
    plate.addColorStop(0, 'rgba(24,38,60,0.80)');
    plate.addColorStop(1, 'rgba(6,11,20,0.86)');
    ctx.fillStyle = plate;
    roundRectPath(ctx, -half, -half, half * 2, half * 2, s * 0.10);
    ctx.fill();
    ctx.strokeStyle = withAlpha(accent, 0.32 + breathe * (armed ? 0.55 : 0.22));
    ctx.lineWidth = Math.max(1.4, s * 0.022);
    if (armed) {
      ctx.shadowColor = withAlpha(accent, 0.55 * breathe);
      ctx.shadowBlur = s * 0.20;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.restore();

    // ── contents ──
    const iconSize = s * 0.58;
    const ix = cx - iconSize * 0.5;
    const iy = cy - iconSize * 0.5;

    if (rolling) {
      const t = Math.min(1, Math.max(0, slot.chargeT ?? 0));
      // Rate ramps down as the roll settles: fast blur → discrete flicker.
      const rate = 26 * (1 - t) * (1 - t) + 1.5;
      this._reelPos += rate * dt;
      const n = REEL_ORDER.length;
      const base = Math.floor(this._reelPos) % n;
      const frac = this._reelPos - Math.floor(this._reelPos);

      ctx.save();
      // Clip to the frame so the reel really looks like it is inside a window.
      ctx.beginPath();
      ctx.rect(cx - r * 0.62, cy - r * 0.62, r * 1.24, r * 1.24);
      ctx.clip();
      const slide = r * 1.15;
      for (let k = -1; k <= 1; k++) {
        const idx = (base + k + n * 2) % n;
        const y = iy + (k + frac) * -slide;
        const a = 1 - Math.min(1, Math.abs((k + frac)) * 0.85);
        if (a <= 0.02) continue;
        blitWeaponIcon(ctx, REEL_ORDER[idx], ix, y, iconSize, a * (0.45 + 0.55 * t));
      }
      ctx.restore();

      // Charge ring.
      ctx.strokeStyle = withAlpha(C.cyan, 0.85);
      ctx.lineWidth = Math.max(1.6, s * 0.030);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.94, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * t);
      ctx.stroke();
    } else if (armed) {
      const pop = 1 + this._settleFlash * 0.45;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(pop, pop);
      ctx.translate(-cx, -cy);
      if (this._settleFlash > 0.01) {
        ctx.shadowColor = withAlpha('#ffffff', this._settleFlash);
        ctx.shadowBlur = s * 0.4 * this._settleFlash;
      }
      blitWeaponIcon(ctx, id, ix, iy, iconSize, 1);
      ctx.restore();
      ctx.shadowBlur = 0;
    } else {
      blitWeaponIcon(ctx, 'none', ix, iy, iconSize, 0.35 + breathe * 0.3);
    }

    // ── ammo pips ──
    const ammo = slot?.ammo ?? 0;
    if (armed && ammo > 1) {
      const pipR = s * 0.030;
      const gap = pipR * 3.0;
      const total = (ammo - 1) * gap;
      for (let i = 0; i < ammo; i++) {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(cx - total * 0.5 + i * gap, cy + r * 0.80, pipR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── label + prompt ──
    const labelY = s + (this.height - s) * 0.42;
    if (rolling) {
      drawDisplay(ctx, '...', cx, labelY, {
        size: s * 0.14, tracking: 0.16, weight: 0.18, align: 'center', fill: withAlpha(C.cyan, 0.8),
      });
    } else if (armed) {
      const name = (slot?.name || labelFor(id) || '').toUpperCase();
      drawDisplay(ctx, name, cx, labelY, {
        size: Math.min(s * 0.125, (s * 1.55) / Math.max(6, name.length) * 0.9),
        tracking: 0.10, weight: 0.17, align: 'center', fill: '#ffffff',
        glow: withAlpha(accent, 0.55), glowBlur: s * 0.12,
      });
      const promptA = 0.55 + 0.45 * Math.sin(this._armPulse * 1.7);
      drawDisplay(ctx, `${this.fireKeyLabel} TO FIRE`, cx, labelY + s * 0.155, {
        size: s * 0.085, tracking: 0.18, weight: 0.19, align: 'center',
        fill: withAlpha(C.amber, 0.45 + promptA * 0.5),
      });
    } else {
      drawDisplay(ctx, 'NO PICKUP', cx, labelY, {
        size: s * 0.095, tracking: 0.20, weight: 0.19, align: 'center',
        fill: withAlpha(C.inkFaint, 0.55),
      });
    }
  }
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export default PickupSlot;
