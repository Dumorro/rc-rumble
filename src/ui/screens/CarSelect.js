/**
 * RC RUMBLE — car select.
 *
 * A carousel over `game.carSystem.listCars()` with a live rotating 3D preview
 * built from the real vehicle geometry, stat bars derived from the CarDef's own
 * `rating` block (and cross-checked against the physical numbers), the drive
 * type / chassis / class chips, and a colour picker that rebuilds the paint
 * material live so what you pick is what you race.
 */

import { el, clear, setText, setStyle, setClass, clamp } from '../Dom.js';
import { THEME, withAlpha, hexOf, displayTextCanvas, setDisplayText } from '../Theme.js';
import { Screen, MenuList } from '../Screen.js';
import { CarPreview } from '../CarPreview.js';

const C = THEME.color;

/** Livery palette offered by the colour picker. Index 0 = the car's own paint. */
export const LIVERY_PALETTE = [
  null,               // stock
  0xe23b2c, 0xff7a18, 0xffd400, 0x8bc53f, 0x2fa8dd,
  0x4de0ff, 0x6a2fbf, 0xd75cff, 0xf2f4f7, 0x14161b,
];

const STAT_KEYS = [
  { key: 'speed', label: 'Speed' },
  { key: 'accel', label: 'Accel' },
  { key: 'grip', label: 'Grip' },
  { key: 'weight', label: 'Weight' },
];

export class CarSelect extends Screen {
  static id = 'car';

  constructor(ui, props) {
    super(ui, props);
    this.cars = [];
    this.index = 0;
    this.colorIndex = 0;
    this.focusZone = 0;      // 0 = carousel, 1 = colours, 2 = actions
    this.preview = null;
  }

  build() {
    const root = el('.rcr-screen');
    root.appendChild(el('.rcr-scrim'));

    this.cars = safeList(this.game);
    const wanted = this.props.carId ?? this.ui.settings.get('lastCar');
    const i = this.cars.findIndex(c => c.id === wanted);
    this.index = i >= 0 ? i : 0;
    this.colorIndex = clamp(this.ui.settings.get('carColor') + 1, 0, LIVERY_PALETTE.length - 1);

    // ── header ──
    this.modeChip = el('.rcr-chip.amber', { text: modeLabel(this.props.mode) });
    const head = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      el('.rcr-eyebrow', { text: 'Step 1 of 2' }),
      this.heading('CHOOSE YOUR CAR', { size: 40 }),
      el('div', { style: { display: 'flex', gap: '8px' } }, this.modeChip));

    // ── preview stage ──
    this.preview = new CarPreview(this.game);
    this.stage = el('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
      },
    }, el('div', {
      style: { width: 'min(74vw, 900px)', height: 'min(52vh, 520px)', pointerEvents: 'auto' },
    }, this.preview.canvas));

    // ── name plate ──
    this.nameCanvas = displayTextCanvas('CAR', {
      size: 46, tracking: 0.08, weight: 0.14, slant: 0.15,
      fill: '#ffffff', glow: withAlpha(C.cyan, 0.5), glowBlur: 26,
    });
    this.classChip = el('.rcr-chip', { text: '—' });
    this.driveChip = el('.rcr-chip.plain', { text: '—' });
    this.chassisChip = el('.rcr-chip.plain', { text: '—' });
    this.blurb = el('div', {
      style: {
        fontSize: '12px', lineHeight: '1.6', color: C.inkDim,
        maxWidth: '38ch', letterSpacing: '.02em',
      },
    });

    // ── stat bars ──
    this.statRows = {};
    const stats = el('div', { style: { marginTop: '4px', minWidth: '236px' } });
    for (const s of STAT_KEYS) {
      const fill = el('i');
      const bar = el('.stat-bar', null, fill);
      const val = el('span.v', { text: '—' });
      stats.appendChild(el('.stat-row', null, el('span.k', { text: s.label }), bar, val));
      this.statRows[s.key] = { fill, val, bar };
    }
    this.specLine = el('div', {
      style: {
        fontFamily: THEME.font.mono, fontSize: '10px', color: C.inkFaint,
        letterSpacing: '.06em', marginTop: '8px', lineHeight: '1.7',
      },
    });

    this.infoPanel = el('.rcr-panel.rcr-ticks', {
      style: { padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' },
    },
    this.nameCanvas,
    el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      this.classChip, this.driveChip, this.chassisChip),
    this.blurb,
    el('.rcr-rule'),
    stats,
    this.specLine);

    // ── colour picker ──
    this.swatchWrap = el('.swatches');
    this._buildSwatches();
    this.colorPanel = el('.rcr-panel', {
      style: { padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '9px' },
    },
    el('.rcr-eyebrow', { text: 'Livery' }),
    this.swatchWrap);

    // ── carousel + actions ──
    this.dots = el('.dots');
    this.counter = el('span', {
      style: { fontFamily: THEME.font.mono, fontSize: '11px', color: C.inkFaint, letterSpacing: '.14em' },
    });
    this.carousel = el('.carousel', null,
      el('button.nav-arrow', { type: 'button', text: '‹', on: { click: () => this.step(-1) } }),
      this.dots,
      el('button.nav-arrow', { type: 'button', text: '›', on: { click: () => this.step(1) } }),
      this.counter);

    this.actions = new MenuList(this, [
      { label: 'Confirm', hint: 'Pick a track', onSelect: () => this.confirm() },
      { label: 'Back', hint: 'Main menu', onSelect: () => this.ui.pop() },
    ], { vertical: false, wrap: false });
    this.actions.el.style.display = 'flex';
    this.actions.el.style.flexDirection = 'row';
    this.actions.el.style.gap = '6px';

    root.appendChild(this.stage);
    root.appendChild(el('.sel-stage', null,
      el('.sel-top', null, head, this.colorPanel),
      el('.sel-bottom', null,
        this.infoPanel,
        el('div', {
          style: { display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'flex-end' },
        }, this.carousel, this.actions.el,
        this.legend([['←→', 'Change car'], ['↑↓', 'Section'], ['↵', 'Confirm'], ['ESC', 'Back']])),
      )));

    this.menu = null;    // zone routing handles input, not a single list
    return root;
  }

  _buildSwatches() {
    clear(this.swatchWrap);
    this.swatchEls = [];
    for (let i = 0; i < LIVERY_PALETTE.length; i++) {
      const c = LIVERY_PALETTE[i];
      const btn = el('button.swatch-btn', {
        type: 'button',
        title: c == null ? 'Stock livery' : hexOf(c),
        on: {
          click: () => { this.setColor(i); this.focusZone = 1; this._refreshFocus(); },
          pointerenter: () => this.sound('ui/hover', 0.35),
        },
      });
      this.swatchEls.push(btn);
      this.swatchWrap.appendChild(btn);
    }
  }

  // ═══════════════════════════════════════════════════════════ lifecycle

  onEnter() {
    this.own(this.ui.onResize((w, h) => this._layout(w, h)));
    // Drag the preview to spin it.
    let dragging = false;
    let lastX = 0;
    const down = (e) => { dragging = true; lastX = e.clientX; this.preview?.kick(0.1); };
    const move = (e) => {
      if (!dragging) return;
      this.preview?.addSpin((e.clientX - lastX) * -0.012);
      lastX = e.clientX;
    };
    const up = () => { dragging = false; };
    this.preview.canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    this.own(() => {
      this.preview?.canvas?.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    });

    this._layout(window.innerWidth, window.innerHeight);
    this.select(this.index, true);
    this._refreshFocus();
  }

  destroy() {
    this.preview?.dispose();
    this.preview = null;
  }

  _layout(w = window.innerWidth, h = window.innerHeight) {
    const box = this.preview?.canvas?.parentElement;
    if (box && this.preview) {
      const r = box.getBoundingClientRect();
      this.preview.resize(r.width || w * 0.7, r.height || h * 0.5);
    }
    setDisplayText(this.nameCanvas, this.nameCanvas._rcrText?.text ?? 'CAR', {
      ...(this.nameCanvas._rcrText?.opts ?? {}),
      size: clamp(Math.min(w, h) * 0.055, 24, 48),
    });
  }

  update(rawDt) {
    this.preview?.update(rawDt);
  }

  // ═══════════════════════════════════════════════════════════ selection

  get current() { return this.cars[this.index] ?? null; }

  step(dir) {
    const n = this.cars.length;
    if (!n) return;
    this.select((this.index + dir + n) % n);
    this.preview?.kick(1.4 * Math.sign(dir || 1));
    this.sound('ui/click', 0.8);
  }

  select(i, silent = false) {
    const n = this.cars.length;
    if (!n) return;
    this.index = ((i % n) + n) % n;
    const def = this.cars[this.index];
    if (!def) return;

    setDisplayText(this.nameCanvas, String(def.name ?? def.id).toUpperCase(), {
      ...(this.nameCanvas._rcrText?.opts ?? {}),
    });
    setText(this.classChip, String(def.class ?? 'amateur').toUpperCase());
    setText(this.driveChip, String(def.drive ?? '4wd').toUpperCase());
    setText(this.chassisChip, `${String(def.chassis ?? 'plastic').toUpperCase()} SHELL`);
    setText(this.blurb, def.blurb ?? '');

    const r = def.rating ?? {};
    for (const s of STAT_KEYS) {
      const row = this.statRows[s.key];
      if (!row) continue;
      const v = clamp(Number(r[s.key] ?? 3), 0, 5);
      setStyle(row.fill, 'width', `${(v / 5) * 100}%`);
      setClass(row.bar, 'hot', v >= 5);
      setText(row.val, String(v));
    }

    const top = (def.topSpeed ?? 9) * 13.333;
    setText(this.specLine,
      `${top.toFixed(0)} km/h · 0-top ${estimate0to100(def).toFixed(1)}s · ${(def.mass ?? 1.6).toFixed(2)} kg`
      + `\n${((def.weightFront ?? 0.5) * 100).toFixed(0)}% front · wheelbase ${((def.wheelbase ?? 0.2) * 1000).toFixed(0)} mm`);
    this.specLine.style.whiteSpace = 'pre-line';

    this._refreshDots();
    this._refreshSwatches();
    this.preview?.setCar(def, this._colors());
    if (!silent) this.sound('ui/hover', 0.4);
  }

  _colors() {
    const def = this.current;
    const c = LIVERY_PALETTE[this.colorIndex];
    if (!def) return null;
    return {
      primary: c == null ? def.colorPrimary : c,
      secondary: def.colorSecondary,
    };
  }

  setColor(i) {
    const n = LIVERY_PALETTE.length;
    this.colorIndex = ((i % n) + n) % n;
    this.ui.settings.set('carColor', this.colorIndex - 1);
    this._refreshSwatches();
    this.preview?.setColors(this._colors());
    this.sound('ui/select', 0.7);
  }

  _refreshDots() {
    clear(this.dots);
    for (let i = 0; i < this.cars.length; i++) {
      this.dots.appendChild(el(`.dot${i === this.index ? '.on' : ''}`));
    }
    setText(this.counter, `${String(this.index + 1).padStart(2, '0')} / ${String(this.cars.length).padStart(2, '0')}`);
  }

  _refreshSwatches() {
    const def = this.current;
    for (let i = 0; i < this.swatchEls.length; i++) {
      const c = LIVERY_PALETTE[i];
      const hex = c == null ? hexOf(def?.colorPrimary ?? 0x888888) : hexOf(c);
      const btn = this.swatchEls[i];
      setStyle(btn, 'background', hex);
      setStyle(btn, 'color', hex);
      setClass(btn, 'on', i === this.colorIndex);
      setClass(btn, 'is-focus', this.focusZone === 1 && i === this.colorIndex);
    }
  }

  _refreshFocus() {
    setClass(this.infoPanel, 'zone', this.focusZone === 0);
    setStyle(this.carousel, 'opacity', this.focusZone === 0 ? '1' : '0.75');
    setStyle(this.colorPanel, 'borderColor',
      this.focusZone === 1 ? C.panelEdgeHot : C.panelEdge);
    for (const item of this.actions.items) {
      setClass(item.el, 'is-focus', this.focusZone === 2 && this.actions.items.indexOf(item) === this.actions.index);
    }
    this._refreshSwatches();
  }

  confirm() {
    const def = this.current;
    if (!def) return;
    this.ui.settings.set('lastCar', def.id);
    this.ui.settings.set('carColor', this.colorIndex - 1);
    this.ui.flow.carId = def.id;
    this.ui.flow.carColor = LIVERY_PALETTE[this.colorIndex];
    this.sound('ui/confirm', 1);
    this.ui.push('track', { mode: this.props.mode });
  }

  // ═══════════════════════════════════════════════════════════ input

  onAction(action) {
    switch (action) {
      case 'left':
        if (this.focusZone === 1) { this.setColor(this.colorIndex - 1); return true; }
        if (this.focusZone === 2) { this.actions.move(-1); this._refreshFocus(); return true; }
        this.step(-1);
        return true;
      case 'right':
        if (this.focusZone === 1) { this.setColor(this.colorIndex + 1); return true; }
        if (this.focusZone === 2) { this.actions.move(1); this._refreshFocus(); return true; }
        this.step(1);
        return true;
      case 'up':
        this.focusZone = (this.focusZone + 2) % 3;
        this.sound('ui/hover', 0.5);
        this._refreshFocus();
        return true;
      case 'down':
        this.focusZone = (this.focusZone + 1) % 3;
        this.sound('ui/hover', 0.5);
        this._refreshFocus();
        return true;
      case 'tabL': this.step(-1); return true;
      case 'tabR': this.step(1); return true;
      case 'confirm':
        if (this.focusZone === 2) { this.actions.activate(); return true; }
        this.confirm();
        return true;
      case 'back':
        this.sound('ui/back', 0.8);
        this.ui.pop();
        return true;
      default:
        return false;
    }
  }
}

// ─────────────────────────────────────────────────────────────── helpers

function safeList(game) {
  try {
    const list = game?.carSystem?.listCars?.();
    if (Array.isArray(list) && list.length) return list.slice();
  } catch { /* noop */ }
  return [{
    id: 'toyeca', name: 'Toyeca', class: 'amateur', drive: '4wd', chassis: 'plastic',
    colorPrimary: 0xe23b2c, colorSecondary: 0x22262e, topSpeed: 9, mass: 1.6,
    rating: { speed: 3, accel: 3, grip: 3, weight: 3 }, blurb: '',
  }];
}

/** Rough 0 → top-speed time from the declared peak acceleration. */
function estimate0to100(def) {
  const a = def.accel ?? 11;
  const v = def.topSpeed ?? 9;
  // Thrust tapers with drag; an exponential approach fits the sim closely.
  return Math.max(0.6, (v / a) * 2.1);
}

function modeLabel(mode) {
  switch (mode) {
    case 'timetrial': return 'Time Trial';
    case 'championship': return 'Championship';
    default: return 'Single Race';
  }
}

export default CarSelect;
