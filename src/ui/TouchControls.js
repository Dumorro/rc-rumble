/**
 * RC RUMBLE — on-screen controls for touch devices.
 *
 * A relative steering arc on the left (grab anywhere inside the pad, the knob
 * follows your thumb and springs back when you let go), throttle / brake pedals
 * on the right, and a column of auxiliary buttons for fire, handbrake, reset
 * and camera. Everything is pushed into `game.input.setTouch(state)`, which is
 * the documented hand-off point in `core/Input.js`.
 *
 * The controls are shown when `pointer: coarse` is reported (or forced on in
 * the options), and hidden whenever a menu screen is open so they can never
 * steal a tap from a button.
 */

import { el, setClass, clamp, clamp01, isTouchDevice } from './Dom.js';
import { THEME, withAlpha, fitCanvas, drawDisplay } from './Theme.js';

const C = THEME.color;

/** The object handed to Input every frame. Reused — zero allocation. */
const TOUCH_STATE = {
  steer: 0, throttle: 0, brake: 0, handbrake: 0, fire: false, lookBack: false,
};

export class TouchControls {
  /** @param {import('./UISystem.js').UISystem} ui */
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.root = null;
    this.active = false;
    this.enabled = false;

    this.steer = 0;
    this.steerTarget = 0;
    this._wheelPointer = null;
    this._wheelStartX = 0;
    this._wheelStartSteer = 0;
    this._pressed = new Map();     // pointerId → button element
    this._buttons = {};
  }

  mount(parent) {
    if (this.root) return this.root;
    this.root = this._build();
    parent.appendChild(this.root);
    this.refresh();
    return this.root;
  }

  unmount() {
    this.game?.input?.setTouch?.(null);
    this.root?.remove();
    this.root = null;
  }

  _build() {
    const root = el('.rcr-touch');

    // ── steering pad ──
    this.wheelCanvas = document.createElement('canvas');
    this.wheelCanvas.style.width = '100%';
    this.wheelCanvas.style.height = '100%';
    this.wheelPad = el('.pad.wheel', null, this.wheelCanvas);
    root.appendChild(this.wheelPad);

    this.wheelPad.addEventListener('pointerdown', (e) => {
      if (this._wheelPointer != null) return;
      this._wheelPointer = e.pointerId;
      this._wheelStartX = e.clientX;
      this._wheelStartSteer = this.steerTarget;
      this.wheelPad.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    const wheelMove = (e) => {
      if (e.pointerId !== this._wheelPointer) return;
      const r = this.wheelPad.getBoundingClientRect();
      const travel = Math.max(40, r.width * 0.42);
      this.steerTarget = clamp(this._wheelStartSteer + (e.clientX - this._wheelStartX) / travel, -1, 1);
      e.preventDefault();
    };
    const wheelUp = (e) => {
      if (e.pointerId !== this._wheelPointer) return;
      this._wheelPointer = null;
      this.steerTarget = 0;
    };
    this.wheelPad.addEventListener('pointermove', wheelMove);
    this.wheelPad.addEventListener('pointerup', wheelUp);
    this.wheelPad.addEventListener('pointercancel', wheelUp);
    this.wheelPad.addEventListener('lostpointercapture', wheelUp);

    // ── pedals ──
    this._buttons.brake = this._button('BRAKE', 'btn brk');
    this._buttons.gas = this._button('GAS', 'btn gas');
    root.appendChild(el('.pad.pedals', null, this._buttons.brake, this._buttons.gas));

    // ── aux column ──
    this._buttons.fire = this._button('FIRE', 'btn');
    this._buttons.hand = this._button('HAND', 'btn');
    this._buttons.reset = this._button('RESET', 'btn');
    this._buttons.cam = this._button('CAM', 'btn');
    this._buttons.look = this._button('LOOK', 'btn');
    root.appendChild(el('.aux', null,
      this._buttons.fire, this._buttons.hand, this._buttons.look,
      this._buttons.reset, this._buttons.cam));

    // ── pause ──
    this.pauseBtn = el('.rcr-pausebtn', { type: 'button' }, el('i'));
    this.pauseBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.ui.togglePause();
    });
    root.appendChild(this.pauseBtn);

    return root;
  }

  _button(label, cls) {
    const b = el(`button.${cls.split(' ').join('.')}`, { type: 'button', text: label });
    b._down = false;
    const down = (e) => {
      b._down = true;
      setClass(b, 'hot', true);
      this._pressed.set(e.pointerId, b);
      b.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
      // One-shot buttons fire on press.
      if (b === this._buttons.reset) this._tapReset();
      if (b === this._buttons.cam) this._tapCamera();
    };
    const up = (e) => {
      if (!b._down) return;
      b._down = false;
      setClass(b, 'hot', false);
      this._pressed.delete(e?.pointerId);
    };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    b.addEventListener('pointerleave', (e) => { if (b.hasPointerCapture?.(e.pointerId)) return; up(e); });
    return b;
  }

  _tapReset() {
    const car = this.game?.playerCar;
    if (!car) return;
    try { this.game?.race?.requestRespawn?.(car, 'touch'); }
    catch { /* noop */ }
  }

  _tapCamera() {
    try { this.game?.cameraDirector?.cycleMode?.(1); } catch { /* noop */ }
  }

  // ═══════════════════════════════════════════════════════════ visibility

  /** Re-evaluate whether the pad should be on screen. */
  refresh() {
    const mode = this.ui.settings.get('touch');
    this.enabled = mode === 'on' || (mode !== 'off' && isTouchDevice());
    this._apply();
  }

  _apply() {
    const show = this.enabled && this.active;
    setClass(this.root, 'on', show);
    setClass(this.pauseBtn, 'on', show);
    // Tell the HUD to lift its bottom corners clear of the thumbs.
    setClass(this.ui.hud?.root, 'touch-on', show);
    if (!show) {
      this.steer = this.steerTarget = 0;
      for (const b of Object.values(this._buttons)) { b._down = false; setClass(b, 'hot', false); }
      this._wheelPointer = null;
      this.game?.input?.setTouch?.(null);
    }
  }

  /** Called by UISystem: true only while the player is actually driving. */
  setActive(v) {
    if (this.active === !!v) return;
    this.active = !!v;
    this._apply();
  }

  // ═══════════════════════════════════════════════════════════ frame

  update(rawDt) {
    if (!this.root) return;
    const show = this.enabled && this.active;
    if (!show) return;

    // Spring the steering back to centre when nothing is holding it.
    const rate = this._wheelPointer != null ? 26 : 12;
    this.steer += (this.steerTarget - this.steer) * (1 - Math.exp(-rate * Math.min(rawDt, 0.05)));
    if (Math.abs(this.steer) < 0.002) this.steer = 0;

    TOUCH_STATE.steer = this.steer;
    TOUCH_STATE.throttle = this._buttons.gas._down ? 1 : 0;
    TOUCH_STATE.brake = this._buttons.brake._down ? 1 : 0;
    TOUCH_STATE.handbrake = this._buttons.hand._down ? 1 : 0;
    TOUCH_STATE.fire = !!this._buttons.fire._down;
    TOUCH_STATE.lookBack = !!this._buttons.look._down;
    this.game?.input?.setTouch?.(TOUCH_STATE);

    this._drawWheel();
  }

  _drawWheel() {
    const r = this.wheelPad.getBoundingClientRect();
    const w = Math.max(60, r.width);
    const h = Math.max(60, r.height);
    const ctx = fitCanvas(this.wheelCanvas, w, h);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.62;
    const rad = Math.min(w, h) * 0.40;
    const a0 = Math.PI * 1.18;
    const a1 = Math.PI * 1.82;

    // Arc track
    ctx.strokeStyle = 'rgba(126,186,255,0.16)';
    ctx.lineWidth = Math.max(6, rad * 0.20);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, rad, a0, a1);
    ctx.stroke();

    // Active fill from centre to the knob
    const mid = (a0 + a1) * 0.5;
    const ka = mid + (a1 - a0) * 0.5 * this.steer;
    ctx.strokeStyle = withAlpha(C.cyan, 0.55);
    ctx.lineWidth = Math.max(5, rad * 0.16);
    ctx.beginPath();
    ctx.arc(cx, cy, rad, Math.min(mid, ka), Math.max(mid, ka));
    ctx.stroke();

    // Centre notch
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - rad - rad * 0.16);
    ctx.lineTo(cx, cy - rad + rad * 0.16);
    ctx.stroke();

    // Knob
    const kx = cx + Math.cos(ka) * rad;
    const ky = cy + Math.sin(ka) * rad;
    ctx.fillStyle = this._wheelPointer != null ? '#ffffff' : withAlpha(C.cyan, 0.9);
    ctx.shadowColor = C.cyanGlow;
    ctx.shadowBlur = rad * 0.4;
    ctx.beginPath();
    ctx.arc(kx, ky, rad * 0.19, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    drawDisplay(ctx, 'STEER', cx, h - 4, {
      size: Math.max(8, rad * 0.17), tracking: 0.28, weight: 0.19,
      align: 'center', fill: withAlpha(C.inkFaint, 0.7),
    });
  }
}

export default TouchControls;
