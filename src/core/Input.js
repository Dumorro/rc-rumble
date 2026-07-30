import CONFIG from './Config.js';
import { clamp, clamp01, deadzone, moveToward } from './MathUtils.js';

/**
 * Normalizes keyboard, gamepad and touch into a single InputState.
 * See ARCHITECTURE.md → InputState for the contract.
 *
 * Digital inputs are ramped so keyboard driving still feels analog — this is a
 * big part of why Re-Volt is catchable on a keyboard.
 */

const KEYMAP = {
  throttle:  ['ArrowUp', 'KeyW'],
  brake:     ['ArrowDown', 'KeyS'],
  left:      ['ArrowLeft', 'KeyA'],
  right:     ['ArrowRight', 'KeyD'],
  handbrake: ['Space'],
  fire:      ['ControlLeft', 'KeyF', 'Enter'],
  lookBack:  ['ShiftLeft', 'KeyB'],
  reset:     ['KeyR'],
  camera:    ['KeyC'],
  pause:     ['Escape', 'KeyP'],
  horn:      ['KeyH'],
};

export class InputState {
  constructor() {
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.handbrake = 0;
    this.fire = false;
    this.lookBack = false;
    this.reset = false;
    this.camera = false;
    this.pause = false;
    this.horn = false;
    /** raw (unramped) analog steer target, useful for AI mimicry / telemetry */
    this.steerTarget = 0;
    this.source = 'keyboard'; // 'keyboard' | 'gamepad' | 'touch'
  }

  copyFrom(o) {
    this.throttle = o.throttle; this.brake = o.brake; this.steer = o.steer;
    this.handbrake = o.handbrake; this.fire = o.fire; this.lookBack = o.lookBack;
    this.reset = o.reset; this.camera = o.camera; this.pause = o.pause;
    this.horn = o.horn; this.steerTarget = o.steerTarget; this.source = o.source;
    return this;
  }

  zero() {
    this.throttle = this.brake = this.steer = this.handbrake = 0;
    this.fire = this.lookBack = this.reset = this.camera = this.pause = this.horn = false;
    this.steerTarget = 0;
    return this;
  }
}

export class Input {
  constructor(game) {
    this.game = game;
    this.state = new InputState();
    /** Previous frame state, for edge detection. */
    this.prev = new InputState();

    this._keys = new Set();
    this._justPressed = new Set();
    this._justReleased = new Set();
    this._enabled = true;
    this._padIndex = null;
    this._touch = null;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onPadConnect = this._onPadConnect.bind(this);
    this._onPadDisconnect = this._onPadDisconnect.bind(this);
  }

  async init() {
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', this._onPadConnect);
    window.addEventListener('gamepaddisconnected', this._onPadDisconnect);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('gamepadconnected', this._onPadConnect);
    window.removeEventListener('gamepaddisconnected', this._onPadDisconnect);
  }

  setEnabled(v) { this._enabled = v; if (!v) this._keys.clear(); }

  /** True only on the frame the action went down. */
  pressed(action) {
    const codes = KEYMAP[action];
    if (codes) for (const c of codes) if (this._justPressed.has(c)) return true;
    return this._padPressed?.[action] === 1;
  }

  released(action) {
    const codes = KEYMAP[action];
    if (codes) for (const c of codes) if (this._justReleased.has(c)) return true;
    return false;
  }

  _held(action) {
    const codes = KEYMAP[action];
    if (!codes) return false;
    for (const c of codes) if (this._keys.has(c)) return true;
    return false;
  }

  _onKeyDown(e) {
    if (e.repeat) return;
    // Don't hijack browser shortcuts or typing in inputs.
    if (e.metaKey || e.ctrlKey && e.code !== 'ControlLeft') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    this._keys.add(e.code);
    this._justPressed.add(e.code);
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
  }

  _onKeyUp(e) {
    this._keys.delete(e.code);
    this._justReleased.add(e.code);
  }

  _onBlur() { this._keys.clear(); }

  _onPadConnect(e) {
    this._padIndex = e.gamepad.index;
    console.info(`[Input] gamepad connected: ${e.gamepad.id}`);
  }

  _onPadDisconnect(e) {
    if (this._padIndex === e.gamepad.index) this._padIndex = null;
  }

  /** Called once per rendered frame, before any update. */
  poll(dt) {
    const s = this.state;
    this.prev.copyFrom(s);

    if (!this._enabled) { s.zero(); this._justPressed.clear(); this._justReleased.clear(); return s; }

    const pad = this._readGamepad();
    const cfg = CONFIG.input;

    let steerTarget = 0, throttleTarget = 0, brakeTarget = 0, handbrakeTarget = 0;
    let analog = false;

    if (pad) {
      analog = true;
      s.source = 'gamepad';
      steerTarget = deadzone(pad.axes[0] ?? 0, cfg.deadzone);
      // Triggers (buttons 7/6) preferred; fall back to A/B face buttons.
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      throttleTarget = rt > 0.02 ? rt : (pad.buttons[0]?.pressed ? 1 : 0);
      brakeTarget = lt > 0.02 ? lt : (pad.buttons[1]?.pressed ? 1 : 0);
      handbrakeTarget = pad.buttons[2]?.pressed ? 1 : 0;
      this._padPressed = {
        fire: pad.buttons[5]?.pressed ? 1 : 0,
        lookBack: pad.buttons[4]?.pressed ? 1 : 0,
        reset: pad.buttons[3]?.pressed ? 1 : 0,
        camera: pad.buttons[8]?.pressed ? 1 : 0,
        pause: pad.buttons[9]?.pressed ? 1 : 0,
      };
    } else if (this._touch) {
      analog = true;
      s.source = 'touch';
      steerTarget = this._touch.steer;
      throttleTarget = this._touch.throttle;
      brakeTarget = this._touch.brake;
      handbrakeTarget = this._touch.handbrake;
    } else {
      s.source = 'keyboard';
      steerTarget = (this._held('right') ? 1 : 0) - (this._held('left') ? 1 : 0);
      throttleTarget = this._held('throttle') ? 1 : 0;
      brakeTarget = this._held('brake') ? 1 : 0;
      handbrakeTarget = this._held('handbrake') ? 1 : 0;
    }

    s.steerTarget = steerTarget;

    if (analog) {
      s.steer = steerTarget;
      s.throttle = clamp01(throttleTarget);
      s.brake = clamp01(brakeTarget);
      s.handbrake = clamp01(handbrakeTarget);
    } else {
      // Ramp digital input so keyboard driving stays controllable.
      const rate = steerTarget === 0 ? cfg.steerReturn : cfg.steerSpeed;
      // Counter-steering snaps faster — critical for catching slides.
      const counterBoost = (steerTarget !== 0 && Math.sign(steerTarget) !== Math.sign(s.steer) && s.steer !== 0) ? 2.2 : 1;
      s.steer = moveToward(s.steer, steerTarget, rate * counterBoost * dt);
      s.throttle = moveToward(s.throttle, throttleTarget, cfg.throttleSpeed * dt * (throttleTarget > 0 ? 1 : 2));
      s.brake = moveToward(s.brake, brakeTarget, cfg.brakeSpeed * dt * (brakeTarget > 0 ? 1 : 2.5));
      s.handbrake = moveToward(s.handbrake, handbrakeTarget, 14 * dt);
    }

    s.steer = clamp(s.steer, -1, 1);
    s.fire = this._held('fire') || !!this._padPressed?.fire || !!this._touch?.fire;
    s.lookBack = this._held('lookBack') || !!this._padPressed?.lookBack || !!this._touch?.lookBack;
    s.reset = this.pressed('reset');
    s.camera = this.pressed('camera');
    s.pause = this.pressed('pause');
    s.horn = this._held('horn');

    this._justPressed.clear();
    this._justReleased.clear();
    return s;
  }

  _readGamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this._padIndex != null && pads[this._padIndex]) return pads[this._padIndex];
    for (const p of pads) {
      if (p && p.connected) {
        // Only auto-adopt once the player actually touches it.
        const active = p.buttons.some(b => b.pressed || b.value > 0.05)
          || p.axes.some(a => Math.abs(a) > 0.25);
        if (active) { this._padIndex = p.index; return p; }
      }
    }
    return null;
  }

  /** Called by the UI touch controls. Pass null to release control. */
  setTouch(state) { this._touch = state; }

  /** Controller rumble, used on impacts. */
  rumble(strong = 0.5, weak = 0.3, ms = 120) {
    const pad = this._padIndex != null ? navigator.getGamepads?.()[this._padIndex] : null;
    pad?.vibrationActuator?.playEffect?.('dual-rumble', {
      duration: ms, strongMagnitude: strong, weakMagnitude: weak,
    }).catch(() => {});
  }
}

const PREVENT_DEFAULT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab',
]);

export default Input;
