/**
 * RC RUMBLE — controls reference.
 *
 * The bindings are read from the same table `core/Input.js` uses, so this
 * screen cannot drift from the real key map. Gamepad bindings are listed with
 * the standard-mapping button names, and the pad panel lights up live when a
 * controller is connected so you can confirm it is seen.
 */

import { el, setText, setClass } from '../Dom.js';
import { THEME, withAlpha, displayTextCanvas } from '../Theme.js';
import { Screen, MenuList } from '../Screen.js';

const C = THEME.color;

/** Mirrors KEYMAP in core/Input.js plus the human-readable labels. */
const BINDINGS = [
  { action: 'Accelerate', keys: ['↑', 'W'], pad: 'RT  /  A' },
  { action: 'Brake / Reverse', keys: ['↓', 'S'], pad: 'LT  /  B' },
  { action: 'Steer Left', keys: ['←', 'A'], pad: 'Left Stick ←' },
  { action: 'Steer Right', keys: ['→', 'D'], pad: 'Left Stick →' },
  { action: 'Handbrake', keys: ['SPACE'], pad: 'X' },
  { action: 'Fire Pickup', keys: ['CTRL', 'F', '↵'], pad: 'RB' },
  { action: 'Look Back', keys: ['SHIFT', 'B'], pad: 'LB' },
  { action: 'Respawn', keys: ['R'], pad: 'Y' },
  { action: 'Change Camera', keys: ['C'], pad: 'Back / View' },
  { action: 'Horn', keys: ['H'], pad: '—' },
  { action: 'Pause', keys: ['ESC', 'P'], pad: 'Start / Menu' },
  { action: 'Telemetry', keys: ['F3', '`'], pad: '—' },
];

const MENU_BINDINGS = [
  { action: 'Navigate', keys: ['↑', '↓', '←', '→'], pad: 'D-Pad / Left Stick' },
  { action: 'Select', keys: ['↵', 'SPACE'], pad: 'A' },
  { action: 'Back', keys: ['ESC', 'BACKSPACE'], pad: 'B' },
  { action: 'Cycle Tab', keys: ['Q', 'E'], pad: 'LB / RB' },
];

export class Controls extends Screen {
  static id = 'controls';

  build() {
    const root = el('.rcr-screen');
    root.appendChild(el('.rcr-scrim.heavy'));

    this.padChip = el('.rcr-chip.plain', { text: 'NO GAMEPAD' });

    this.menu = new MenuList(this, [
      { label: 'Back', onSelect: () => this.ui.pop() },
    ]);

    root.appendChild(el('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 'clamp(16px, 4vw, 48px)',
      },
    },
    el('.rcr-panel.rcr-ticks', {
      style: {
        padding: '22px 24px 18px', width: 'min(760px, 94vw)', maxHeight: '90vh',
        display: 'flex', flexDirection: 'column', gap: '14px',
      },
    },
    el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap' },
    },
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      el('.rcr-eyebrow', { text: 'Reference' }),
      displayTextCanvas('CONTROLS', {
        size: 38, tracking: 0.14, weight: 0.14, slant: 0.15,
        fill: '#ffffff', glow: withAlpha(C.cyan, 0.5), glowBlur: 22,
      })),
    this.padChip),
    el('div', { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: '0', display: 'flex', flexDirection: 'column', gap: '16px' } },
      section('Driving', BINDINGS),
      section('Menus', MENU_BINDINGS),
      el('div', {
        style: { fontSize: '11px', lineHeight: '1.7', color: C.inkDim, letterSpacing: '.02em' },
      },
      'Keyboard steering is ramped rather than binary — a tap gives you a small angle and '
        + 'counter-steer snaps back roughly twice as fast, which is what makes a slide catchable '
        + 'without an analogue stick. A connected gamepad takes over automatically the moment '
        + 'you touch it.')),
    el('.rcr-rule'),
    el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
      this.legend([['ESC', 'Back']]),
      this.menu.el))));

    return root;
  }

  onEnter() {
    this._poll();
    this._timer = setInterval(() => this._poll(), 500);
    this.own(() => clearInterval(this._timer));
  }

  _poll() {
    let name = null;
    try {
      const pads = navigator.getGamepads?.() ?? [];
      for (const p of pads) if (p?.connected) { name = p.id; break; }
    } catch { /* noop */ }
    setText(this.padChip, name ? shortPad(name) : 'NO GAMEPAD');
    setClass(this.padChip, 'plain', !name);
    setClass(this.padChip, 'good', !!name);
  }
}

function section(title, rows) {
  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
    el('.rcr-eyebrow', { text: title }));
  wrap.appendChild(el('div', {
    style: {
      display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '4px 18px',
      alignItems: 'center', fontSize: '9px', letterSpacing: '.26em',
      textTransform: 'uppercase', color: C.inkFaint, padding: '2px 2px 4px',
    },
  },
  el('span', { text: 'Action' }),
  el('span', { style: { textAlign: 'right' }, text: 'Keyboard' }),
  el('span', { style: { textAlign: 'right', minWidth: '150px' }, text: 'Gamepad' })));

  for (const b of rows) {
    wrap.appendChild(el('div', {
      style: {
        display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '6px 18px',
        alignItems: 'center', padding: '5px 2px',
        borderBottom: '1px solid rgba(255,255,255,0.045)',
      },
    },
    el('span', {
      style: { fontSize: '12px', letterSpacing: '.10em', color: C.ink, textTransform: 'uppercase', fontWeight: '600' },
      text: b.action,
    }),
    el('span', { style: { display: 'flex', gap: '5px', justifyContent: 'flex-end' } },
      ...b.keys.map(k => el('b', {
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          minWidth: '26px', height: '22px', padding: '0 7px',
          border: '1px solid rgba(255,255,255,.20)', borderRadius: '4px',
          background: 'rgba(255,255,255,.05)', color: C.ink,
          fontSize: '10px', letterSpacing: '.06em', fontWeight: '700',
        },
        text: k,
      }))),
    el('span', {
      style: {
        fontSize: '10px', letterSpacing: '.16em', color: C.inkDim,
        textAlign: 'right', minWidth: '150px', fontFamily: THEME.font.mono,
      },
      text: b.pad,
    })));
  }
  return wrap;
}

function shortPad(id) {
  const s = String(id).replace(/\(.*?\)/g, '').trim();
  return (s.length > 26 ? `${s.slice(0, 25)}…` : s).toUpperCase();
}

export default Controls;
