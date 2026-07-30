/**
 * RC RUMBLE — tiny DOM + formatting helpers for the UI layer.
 *
 * Deliberately about 120 lines of vanilla helpers rather than a framework:
 * the whole front end is built from `el()` calls and direct textContent
 * writes, so there is no diffing cost and nothing to keep in sync.
 */

/**
 * Create an element.
 *
 *   el('div.card.is-open', { id:'x', style:{ width:'10px' } }, child, 'text')
 *
 * @param {string} spec `tag`, `tag.class.class`, or `.class` (implies div)
 * @param {object|null} [attrs] `class` appends, `style` may be an object,
 *        `dataset` may be an object, `on` may be `{ click: fn }`,
 *        anything else becomes an attribute (or a property if it exists).
 * @param {...(Node|string|null|undefined|Array)} children
 * @returns {HTMLElement}
 */
export function el(spec, attrs = null, ...children) {
  const parts = String(spec).split('.');
  const tag = parts[0] || 'div';
  const node = document.createElement(tag);
  if (parts.length > 1) node.className = parts.slice(1).join(' ');

  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') {
        node.className = node.className ? `${node.className} ${v}` : String(v);
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(node.style, v);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(node.dataset, v);
      } else if (k === 'on' && typeof v === 'object') {
        for (const ev in v) node.addEventListener(ev, v[ev]);
      } else if (k === 'text') {
        node.textContent = String(v);
      } else if (k === 'html') {
        node.innerHTML = String(v);
      } else if (k in node && k !== 'list' && typeof v !== 'object') {
        try { node[k] = v; } catch { node.setAttribute(k, String(v)); }
      } else {
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Set textContent only if it changed — avoids layout thrash in the HUD. */
export function setText(node, text) {
  if (!node) return;
  const s = text == null ? '' : String(text);
  if (node.textContent !== s) node.textContent = s;
}

/** Toggle a class only when it changes. */
export function setClass(node, name, on) {
  if (!node) return;
  if (node.classList.contains(name) !== !!on) node.classList.toggle(name, !!on);
}

/** Write a style property only when it changed (cached on the node). */
export function setStyle(node, prop, value) {
  if (!node) return;
  const cache = node._rcrStyle ??= {};
  if (cache[prop] === value) return;
  cache[prop] = value;
  node.style[prop] = value;
}

/** addEventListener that returns its own unsubscriber. */
export function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  return () => target.removeEventListener(type, fn, opts);
}

/** Force a style recalculation so the next class change animates. */
export function reflow(node) {
  if (node) void node.offsetWidth;
}

// ═══════════════════════════════════════════════════════════════ formatting

/** `1:23.456` · `23.456` under a minute. `--:--.---` for a non-finite input. */
export function formatTime(seconds, { ms = 3, forceMinutes = false, blank = '--.---' } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return blank;
  const t = seconds;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const sTxt = s.toFixed(ms).padStart(ms > 0 ? 3 + ms : 2, '0');
  if (m > 0 || forceMinutes) return `${m}:${sTxt}`;
  return sTxt;
}

/** `+1.234` / `-0.512`. */
export function formatDelta(seconds, ms = 3) {
  if (!Number.isFinite(seconds)) return '';
  const sign = seconds >= 0 ? '+' : '-';
  return sign + Math.abs(seconds).toFixed(ms);
}

/** `+1.2s` or `+3 laps`. */
export function formatGap(seconds, laps = 0) {
  if (laps > 0) return `+${laps} LAP${laps > 1 ? 'S' : ''}`;
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds > 60) return `+${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
  return `+${seconds.toFixed(seconds < 10 ? 2 : 1)}`;
}

const ORD = ['th', 'st', 'nd', 'rd'];
/** 1 → `1st`. */
export function ordinal(n) {
  const v = Math.round(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  const m = v % 100;
  return v + (ORD[(m - 20) % 10] ?? ORD[m] ?? ORD[0]);
}

/** 1 → `1ST` with the suffix split out, for two-tone display drawing. */
export function ordinalParts(n) {
  const v = Math.round(n);
  if (!Number.isFinite(v) || v <= 0) return { num: '-', suf: '' };
  const m = v % 100;
  return { num: String(v), suf: (ORD[(m - 20) % 10] ?? ORD[m] ?? ORD[0]).toUpperCase() };
}

/** 275.4 → `275 M`, 1420 → `1.42 KM`. */
export function formatLength(metres) {
  if (!Number.isFinite(metres) || metres <= 0) return '—';
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} KM` : `${Math.round(metres)} M`;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * Math.max(0, dt)));

/** Is this a touch-first device? Re-evaluated on demand, never cached wrong. */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const touch = (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window;
  return coarse && touch;
}
