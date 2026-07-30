/**
 * RC RUMBLE — screen base class + the shared menu-list widget.
 *
 * A `Screen` is a self-contained DOM subtree with an enter/exit transition and
 * a small action vocabulary (`up`, `down`, `left`, `right`, `confirm`, `back`,
 * `tabL`, `tabR`, `alt`). `UISystem` owns a stack of them and routes input to
 * the top one, so keyboard, gamepad, mouse and touch all drive the same code.
 */

import { el, clear, setText, setClass, reflow, clamp } from './Dom.js';
import { THEME, displayTextCanvas } from './Theme.js';

export class Screen {
  /** Stable id used by `ui.show('name')`. Subclasses override. */
  static id = 'screen';

  /**
   * @param {import('./UISystem.js').UISystem} ui
   * @param {object} [props]
   */
  constructor(ui, props = {}) {
    this.ui = ui;
    this.game = ui.game;
    this.props = props;
    this.name = /** @type {typeof Screen} */ (this.constructor).id;

    /** @type {HTMLElement|null} */
    this.el = null;
    /** Set false for screens that must not eat clicks over the canvas. */
    this.modal = true;
    /** Set false to keep the HUD on screen underneath (pause, results). */
    this.hidesHud = true;
    /** Blocks the game's own input while open. */
    this.blocksGameInput = true;
    /** Enter/exit transition length in ms — matched to the CSS. */
    this.transitionMs = THEME.dur.screen;

    this._alive = false;
    this._unsub = [];
    /** @type {MenuList|null} the list that currently owns focus */
    this.menu = null;
  }

  // ─────────────────────────────────────────────────────────── lifecycle

  /** @returns {HTMLElement} subclasses build their DOM here. */
  build() { return el('.rcr-screen'); }

  mount(parent) {
    if (this.el) return this.el;
    this.el = this.build();
    this.el.classList.add('rcr-screen');
    this.el.dataset.screen = this.name;
    if (!this.modal) this.el.classList.add('is-transparent');
    this.el.classList.add('enter-from');
    parent.appendChild(this.el);
    reflow(this.el);
    this.el.classList.remove('enter-from');
    this._alive = true;
    try { this.onEnter(); } catch (err) { console.error(`[UI] ${this.name}.onEnter`, err); }
    return this.el;
  }

  unmount() {
    if (!this.el) return;
    const node = this.el;
    this._alive = false;
    try { this.onExit(); } catch (err) { console.error(`[UI] ${this.name}.onExit`, err); }
    for (const fn of this._unsub) { try { fn(); } catch { /* noop */ } }
    this._unsub.length = 0;
    node.classList.add('exit-to');
    const kill = () => { node.remove(); };
    const t = setTimeout(kill, this.transitionMs + 60);
    node.addEventListener('transitionend', (e) => {
      if (e.target === node && e.propertyName === 'opacity') { clearTimeout(t); kill(); }
    }, { once: true });
    this.el = null;
    try { this.destroy(); } catch (err) { console.error(`[UI] ${this.name}.destroy`, err); }
  }

  onEnter() {}
  onExit() {}
  destroy() {}

  /** Real-time update (never scaled by slow-mo / pause). */
  update(_rawDt) {}

  /** Called on resize. */
  resize(_w, _h) {}

  /** Track a teardown function that runs on unmount. */
  own(fn) { if (typeof fn === 'function') this._unsub.push(fn); return fn; }

  /** Subscribe to the bus for the lifetime of the screen. */
  listen(event, fn) { this.own(this.game?.bus?.on?.(event, fn)); }

  // ───────────────────────────────────────────────────────────── input

  /**
   * @param {'up'|'down'|'left'|'right'|'confirm'|'back'|'tabL'|'tabR'|'alt'|'start'} action
   * @returns {boolean} true if handled
   */
  onAction(action) {
    if (this.menu?.handle(action)) return true;
    if (action === 'back') return this.onBack();
    return false;
  }

  /** Raw keydown hook for screen-specific shortcuts. Return true if handled. */
  onKey(_e) { return false; }

  /** Default back behaviour: pop this screen. */
  onBack() {
    this.ui.pop();
    return true;
  }

  // ─────────────────────────────────────────────────────────── helpers

  sound(name, volume = 1) { this.ui.sound(name, volume); }

  /** A big display-face heading. */
  heading(text, opts = {}) {
    return displayTextCanvas(text, {
      size: opts.size ?? 54,
      tracking: opts.tracking ?? 0.10,
      weight: opts.weight ?? 0.14,
      slant: opts.slant ?? 0.14,
      fill: opts.fill ?? THEME.color.ink,
      glow: opts.glow ?? THEME.color.cyanGlow,
      glowBlur: opts.glowBlur ?? 26,
      ...opts,
    });
  }

  /** Standard bottom-left key legend. */
  legend(pairs) {
    return el('.rcr-legend', null, ...pairs.map(([k, v]) => el('span', null, el('b', { text: k }), v)));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MenuList — the focusable row list used by every menu screen
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {object} MenuItem
 * @property {string} [id]
 * @property {string} label
 * @property {'action'|'toggle'|'choice'|'slider'|'label'} [type]
 * @property {string} [hint]
 * @property {boolean} [disabled]
 * @property {() => any} [get]
 * @property {(v:any) => void} [set]
 * @property {Array<{value:any,label:string}>|string[]} [options]
 * @property {number} [min] @property {number} [max] @property {number} [step]
 * @property {(v:number)=>string} [format]
 * @property {() => void} [onSelect]
 * @property {(dir:number)=>boolean} [onAdjust] custom left/right handler
 */
export class MenuList {
  /**
   * @param {Screen} screen
   * @param {MenuItem[]} items
   * @param {object} [opts] `{ vertical=true, wrap=true, onFocus }`
   */
  constructor(screen, items, opts = {}) {
    this.screen = screen;
    this.ui = screen.ui;
    this.items = [];
    this.index = 0;
    this.vertical = opts.vertical !== false;
    this.wrap = opts.wrap !== false;
    this.onFocus = opts.onFocus ?? null;
    /** Screens with several focus zones park a list by setting this false. */
    this.active = opts.active !== false;
    this.el = el(`.rcr-menu${this.vertical ? '' : '.is-row'}`, { role: 'menu' });
    this.setItems(items);
  }

  /** Show / hide the focus marker without losing the focused index. */
  setActive(v) {
    const next = !!v;
    if (this.active === next) return this;
    this.active = next;
    this.refresh();
    return this;
  }

  setItems(items) {
    clear(this.el);
    this.items = [];
    for (const spec of (items ?? [])) {
      if (!spec) continue;
      const row = this._buildRow(spec);
      this.items.push(row);
      this.el.appendChild(row.el);
    }
    this.index = this._firstEnabled(0, 1);
    this.refresh();
  }

  _buildRow(spec) {
    const type = spec.type ?? 'action';
    const lbl = el('span.lbl', { text: spec.label ?? '' });
    const row = {
      spec, type,
      el: el('button.rcr-item', { type: 'button', tabIndex: -1 }),
      lbl,
      val: null, slider: null, fill: null, toggle: null,
      disabled: !!spec.disabled,
    };
    row.el.appendChild(lbl);

    if (type === 'toggle') {
      row.toggle = el('.rcr-toggle', null, el('i'));
      row.el.appendChild(row.toggle);
    } else if (type === 'choice') {
      row.val = el('span.val');
      row.el.appendChild(el('.arrows', null, el('span', { text: '‹' }), row.val, el('span', { text: '›' })));
    } else if (type === 'slider') {
      row.fill = el('i');
      row.slider = el('.rcr-slider', null, row.fill);
      row.val = el('span.val', { style: { minWidth: '44px', textAlign: 'right', fontSize: '12px' } });
      row.el.appendChild(el('.arrows', null, row.slider, row.val));
    } else if (spec.hint) {
      row.el.appendChild(el('span.hint', { text: spec.hint }));
    }
    if (type === 'label') {
      row.el.classList.add('is-disabled');
      row.disabled = true;
    }

    row.el.addEventListener('pointerenter', () => {
      if (row.disabled) return;
      const i = this.items.indexOf(row);
      if (i >= 0 && i !== this.index) { this.focus(i); this.ui.sound('ui/hover', 0.5); }
    });
    row.el.addEventListener('click', (e) => {
      if (row.disabled) return;
      const i = this.items.indexOf(row);
      if (i >= 0) this.focus(i);
      // Clicking the right-hand half of a choice/slider steps it forward.
      if (type === 'choice' || type === 'slider') {
        const r = row.el.getBoundingClientRect();
        this.adjust(e.clientX > r.left + r.width * 0.62 ? 1 : -1);
      } else {
        this.activate();
      }
    });
    return row;
  }

  _firstEnabled(from, dir) {
    const n = this.items.length;
    if (n === 0) return 0;
    for (let k = 0; k < n; k++) {
      const i = ((from + dir * k) % n + n) % n;
      if (!this.items[i].disabled) return i;
    }
    return 0;
  }

  focus(i, silent = true) {
    const n = this.items.length;
    if (n === 0) return;
    this.index = clamp(i, 0, n - 1);
    for (let k = 0; k < n; k++) setClass(this.items[k].el, 'is-focus', this.active && k === this.index);
    if (!silent) this.ui.sound('ui/hover', 0.55);
    this.onFocus?.(this.items[this.index]?.spec, this.index);
  }

  move(dir) {
    const n = this.items.length;
    if (n === 0) return false;
    let i = this.index;
    for (let k = 0; k < n; k++) {
      i += dir;
      if (i < 0 || i >= n) {
        if (!this.wrap) return false;
        i = (i + n) % n;
      }
      if (!this.items[i].disabled) { this.focus(i); this.ui.sound('ui/hover', 0.5); return true; }
    }
    return false;
  }

  get current() { return this.items[this.index] ?? null; }

  activate() {
    const row = this.current;
    if (!row || row.disabled) { this.ui.sound('ui/error', 0.7); return false; }
    const s = row.spec;
    if (row.type === 'toggle') {
      const v = !s.get?.();
      s.set?.(v);
      this.ui.sound('ui/select', 0.8);
      this.refresh();
      return true;
    }
    if (row.type === 'choice' || row.type === 'slider') { return this.adjust(1); }
    this.ui.sound('ui/confirm', 0.9);
    try { s.onSelect?.(); } catch (err) { console.error('[UI] menu action threw', err); }
    return true;
  }

  adjust(dir) {
    const row = this.current;
    if (!row || row.disabled) return false;
    const s = row.spec;
    if (typeof s.onAdjust === 'function') {
      const handled = s.onAdjust(dir);
      this.refresh();
      if (handled !== false) this.ui.sound('ui/click', 0.7);
      return handled !== false;
    }
    if (row.type === 'toggle') {
      const want = dir > 0;
      if (!!s.get?.() === want) return false;
      s.set?.(want);
      this.ui.sound('ui/select', 0.8);
      this.refresh();
      return true;
    }
    if (row.type === 'choice') {
      const opts = normOptions(s.options);
      if (!opts.length) return false;
      const cur = s.get?.();
      let i = opts.findIndex(o => o.value === cur);
      if (i < 0) i = 0;
      i = (i + dir + opts.length) % opts.length;
      s.set?.(opts[i].value);
      this.ui.sound('ui/click', 0.8);
      this.refresh();
      return true;
    }
    if (row.type === 'slider') {
      const min = s.min ?? 0, max = s.max ?? 1, step = s.step ?? 0.05;
      const cur = Number(s.get?.() ?? 0);
      const next = clamp(Math.round((cur + dir * step) * 1e6) / 1e6, min, max);
      if (next === cur) return false;
      s.set?.(next);
      this.ui.sound('ui/click', 0.5);
      this.refresh();
      return true;
    }
    return false;
  }

  /** Repaint values (call after external state changes). */
  refresh() {
    for (const row of this.items) {
      const s = row.spec;
      row.disabled = !!(typeof s.disabled === 'function' ? s.disabled() : s.disabled) || row.type === 'label';
      setClass(row.el, 'is-disabled', row.disabled);
      if (s.label != null) setText(row.lbl, s.label);
      if (row.type === 'toggle') {
        setClass(row.toggle, 'on', !!s.get?.());
      } else if (row.type === 'choice' && row.val) {
        const opts = normOptions(s.options);
        const cur = s.get?.();
        const found = opts.find(o => o.value === cur);
        setText(row.val, found?.label ?? String(cur ?? '—'));
      } else if (row.type === 'slider' && row.val) {
        const min = s.min ?? 0, max = s.max ?? 1;
        const cur = Number(s.get?.() ?? 0);
        const t = max > min ? (cur - min) / (max - min) : 0;
        if (row.fill) row.fill.style.width = `${(clamp(t, 0, 1) * 100).toFixed(1)}%`;
        setText(row.val, s.format ? s.format(cur) : `${Math.round(t * 100)}%`);
      }
    }
    for (let k = 0; k < this.items.length; k++) {
      setClass(this.items[k].el, 'is-focus', this.active && k === this.index);
    }
  }

  /** @returns {boolean} handled */
  handle(action) {
    if (this.items.length === 0) return false;
    switch (action) {
      case 'up':    return this.vertical ? this.move(-1) : false;
      case 'down':  return this.vertical ? this.move(1) : false;
      case 'left':  return this.vertical ? this.adjust(-1) : this.move(-1);
      case 'right': return this.vertical ? this.adjust(1) : this.move(1);
      case 'confirm': return this.activate();
      default: return false;
    }
  }
}

function normOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map(o => (typeof o === 'object' && o !== null
    ? { value: o.value, label: o.label ?? String(o.value) }
    : { value: o, label: String(o).toUpperCase() }));
}

export default Screen;
