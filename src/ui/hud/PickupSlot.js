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

import { THEME, withAlpha, fitCanvas, drawDisplay, measureDisplay } from '../Theme.js';
import { blitWeaponIcon, colorFor, labelFor, iconIdFor, REEL_ORDER } from './WeaponIcons.js';

const C = THEME.color;

export class PickupSlot {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-pickup';
    /** Plate size. */
    this.size = 0;
    /** Canvas box — wider than the plate so long names have somewhere to go. */
    this.width = 0;
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
    // Room for the plate, the ammo pips, the weapon name and the fire prompt.
    this.width = Math.round(this.size * 2.15);
    this.height = Math.round(this.size * 1.52);
    this.canvas.style.width = `${this.width}px`;
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
    const ctx = fitCanvas(this.canvas, this.width, this.height);
    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);

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

    const cx = this.width * 0.5;
    const cy = s * 0.52;
    const r = s * 0.44;
    const accent = armed || rolling ? colorFor(rolling ? REEL_ORDER[Math.floor(this._reelPos) % REEL_ORDER.length] : id) : C.inkFaint;

    // ── frame: an upright hex-cut plate (a rotated square would fight the
    //    diamond pickup icon it contains) ──
    const breathe = armed ? 0.5 + 0.5 * Math.sin(this._armPulse) : 0.35 + 0.2 * Math.sin(this._emptyT);
    const half = r * 0.95;
    ctx.save();
    const plate = ctx.createLinearGradient(cx - half, cy - half, cx + half, cy + half);
    plate.addColorStop(0, 'rgba(24,38,60,0.80)');
    plate.addColorStop(1, 'rgba(6,11,20,0.88)');
    ctx.fillStyle = plate;
    cutRectPath(ctx, cx - half, cy - half, half * 2, half * 2, s * 0.16);
    ctx.fill();
    ctx.strokeStyle = withAlpha(accent, 0.30 + breathe * (armed ? 0.58 : 0.20));
    ctx.lineWidth = Math.max(1.4, s * 0.024);
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
    const nameY = s + s * 0.24;
    const promptY = nameY + s * 0.235;
    const maxW = this.width * 0.96;
    if (rolling) {
      drawDisplay(ctx, 'ROLLING', cx, nameY, {
        size: fitSize('ROLLING', 0.18, s * 0.135, maxW), tracking: 0.18,
        weight: 0.18, align: 'center', fill: withAlpha(C.cyan, 0.85),
      });
    } else if (armed) {
      const name = (slot?.name || labelFor(id) || '').toUpperCase();
      drawDisplay(ctx, name, cx, nameY, {
        // Measured, not guessed: "WATER BALLOON" has to fit the same box "OIL" does.
        size: fitSize(name, 0.09, s * 0.155, maxW),
        tracking: 0.09, weight: 0.17, align: 'center', fill: '#ffffff',
        glow: withAlpha(accent, 0.6), glowBlur: s * 0.14,
      });
      const promptA = 0.5 + 0.5 * Math.sin(this._armPulse * 1.7);
      const prompt = `${this.fireKeyLabel} TO FIRE`;
      const psz = fitSize(prompt, 0.16, s * 0.115, maxW);
      // A filled pill behind the prompt: amber-on-track-texture is unreadable
      // on a light floor, and this is the one HUD element that must be obeyed.
      const pw = measureDisplay(prompt, psz, 0.16) + psz * 1.3;
      const ph = psz * 1.85;
      ctx.fillStyle = `rgba(20, 12, 2, ${0.45 + promptA * 0.25})`;
      cutRectPath(ctx, cx - pw * 0.5, promptY - ph * 0.72, pw, ph, ph * 0.32);
      ctx.fill();
      ctx.strokeStyle = withAlpha(C.amber, 0.30 + promptA * 0.45);
      ctx.lineWidth = 1;
      ctx.stroke();
      drawDisplay(ctx, prompt, cx, promptY, {
        size: psz, tracking: 0.16, weight: 0.19, align: 'center',
        fill: withAlpha('#ffd88a', 0.75 + promptA * 0.25),
      });
    } else {
      drawDisplay(ctx, 'NO PICKUP', cx, nameY, {
        size: fitSize('NO PICKUP', 0.20, s * 0.11, maxW), tracking: 0.20,
        weight: 0.19, align: 'center', fill: withAlpha(C.inkFaint, 0.6),
      });
    }
  }
}

/** Largest cap height at which `text` still fits `maxWidth`, capped at `want`. */
function fitSize(text, tracking, want, maxWidth) {
  const em = measureDisplay(text, 1, tracking);
  if (em <= 0) return want;
  return Math.min(want, maxWidth / em);
}

/** A rectangle with its corners chamfered — matches the display typeface. */
function cutRectPath(ctx, x, y, w, h, c) {
  const cc = Math.min(c, w * 0.45, h * 0.45);
  ctx.beginPath();
  ctx.moveTo(x + cc, y);
  ctx.lineTo(x + w - cc, y);
  ctx.lineTo(x + w, y + cc);
  ctx.lineTo(x + w, y + h - cc);
  ctx.lineTo(x + w - cc, y + h);
  ctx.lineTo(x + cc, y + h);
  ctx.lineTo(x, y + h - cc);
  ctx.lineTo(x, y + cc);
  ctx.closePath();
}

export default PickupSlot;
