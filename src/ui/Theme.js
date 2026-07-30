/**
 * RC RUMBLE — UI design system.
 *
 * Three things live here and nothing else:
 *
 *   1. **Tokens** — the colour / spacing / radius / shadow / motion vocabulary.
 *      Everything in `src/ui/**` reads from `THEME`; nothing hard-codes a hex.
 *   2. **The stylesheet** — one `<style>` element injected once, built from the
 *      tokens as CSS custom properties. No UI framework, no CSS file.
 *   3. **A procedurally drawn display typeface** — every glyph is defined here
 *      as a set of polylines in a unit em-box and stroked onto a canvas. No font
 *      files anywhere in this project, so the big speed / position numerals have
 *      to be *drawn*. They are, and they have a deliberate angular racing
 *      character: chamfered bowls, a slashed zero, monospaced digits so the lap
 *      timer never jitters, and an optional italic shear.
 *
 * Body copy uses the system UI stack (that is not an asset, it is the OS).
 */

// ═══════════════════════════════════════════════════════════════════════════
// Tokens
// ═══════════════════════════════════════════════════════════════════════════

export const THEME = Object.freeze({
  color: Object.freeze({
    // Backdrops — deep navy, never pure black, so bloom has somewhere to sit.
    void:      '#03050a',
    bg0:       '#05070c',
    bg1:       '#0a1018',
    bg2:       '#111a29',
    bg3:       '#1b2739',

    // Glass panels
    panel:     'rgba(9, 15, 26, 0.78)',
    panelHi:   'rgba(20, 32, 52, 0.86)',
    panelEdge: 'rgba(126, 186, 255, 0.20)',
    panelEdgeHot: 'rgba(96, 220, 255, 0.55)',

    // Ink
    ink:       '#e9f0ff',
    inkDim:    '#a3b4d0',
    inkFaint:  '#6b7c99',
    inkGhost:  'rgba(160, 185, 225, 0.28)',

    // Brand
    cyan:      '#54dcff',
    cyanDeep:  '#1898cf',
    cyanGlow:  'rgba(84, 220, 255, 0.55)',
    blue:      '#3f86ff',
    blueDeep:  '#17347e',
    amber:     '#ffb223',
    amberHot:  '#ff7a18',
    amberGlow: 'rgba(255, 178, 35, 0.5)',

    // Semantic
    good:      '#43e58c',
    bad:       '#ff4f62',
    warn:      '#ffcc33',
    info:      '#7db4ff',
    magenta:   '#d75cff',

    // Podium
    gold:      '#ffd166',
    silver:    '#d3dce8',
    bronze:    '#d08a4e',

    // Player highlight on the minimap / ladder
    player:    '#ffd166',
    rival:     '#7db4ff',
  }),

  /** 8-point-ish spacing scale, in px. */
  space: Object.freeze({ xs: 4, sm: 8, md: 12, lg: 18, xl: 26, xxl: 40, huge: 64 }),

  radius: Object.freeze({ xs: 3, sm: 6, md: 10, lg: 16, xl: 24, pill: 999 }),

  shadow: Object.freeze({
    soft:  '0 8px 30px rgba(0, 0, 0, 0.45)',
    hard:  '0 18px 60px rgba(0, 0, 0, 0.65)',
    inner: 'inset 0 1px 0 rgba(255, 255, 255, 0.07)',
    cyan:  '0 0 34px rgba(84, 220, 255, 0.28)',
    amber: '0 0 34px rgba(255, 178, 35, 0.30)',
  }),

  /** Motion curves. `snap` deliberately overshoots — menus should feel sprung. */
  ease: Object.freeze({
    out:   'cubic-bezier(0.16, 1, 0.30, 1)',
    in:    'cubic-bezier(0.70, 0.00, 0.84, 0.00)',
    inOut: 'cubic-bezier(0.65, 0.00, 0.35, 1.00)',
    snap:  'cubic-bezier(0.20, 1.30, 0.30, 1.00)',
    swift: 'cubic-bezier(0.32, 0.72, 0.00, 1.00)',
  }),

  /** Durations in ms. */
  dur: Object.freeze({ instant: 90, fast: 150, base: 240, slow: 420, screen: 520 }),

  z: Object.freeze({ hud: 10, touch: 20, screen: 40, toast: 60, telemetry: 80, fade: 90 }),

  font: Object.freeze({
    ui: '"Inter", "SF Pro Text", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  }),
});

/** Hex → `rgba()` with an alpha, for canvas work. */
export function withAlpha(hex, a) {
  if (typeof hex !== 'string') return `rgba(255,255,255,${a})`;
  if (hex.startsWith('rgba')) return hex;
  if (hex.startsWith('rgb(')) return hex.replace('rgb(', 'rgba(').replace(')', `,${a})`);
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Number → `#rrggbb`. Handy for CarDef.colorPrimary etc. */
export function hexOf(n) {
  return `#${(n >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Mix two `#rrggbb` strings. */
export function mixHex(a, b, t) {
  const pa = parseInt(a.replace('#', ''), 16);
  const pb = parseInt(b.replace('#', ''), 16);
  const r = Math.round(((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t);
  const g = Math.round(((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t);
  const bl = Math.round((pa & 255) + ((pb & 255) - (pa & 255)) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// The display typeface — "RUMBLE DISPLAY"
//
// Every glyph is `{ w, p, d }`:
//   w  advance width in em (cap height = 1.0)
//   p  array of flat polylines [x0,y0, x1,y1, …] in em space,
//      y = 0 at cap height, y = 1 on the baseline
//   d  array of [x,y] dot centres, drawn as squares of one stroke width
//   c  optional array of CLOSED polylines (bowls) — stroked with a join back
//      to the first point
// ═══════════════════════════════════════════════════════════════════════════

/** Chamfered rectangle as a closed polyline — the signature shape of the face. */
function bowl(x0, y0, x1, y1, c) {
  return [
    x0 + c, y0, x1 - c, y0,
    x1, y0 + c, x1, y1 - c,
    x1 - c, y1, x0 + c, y1,
    x0, y1 - c, x0, y0 + c,
  ];
}

const G = {
  ' ': { w: 0.30, p: [] },
  ' ': { w: 0.30, p: [] },

  // ── digits: monospaced at 0.60 em so timers and speeds never reflow ──
  '0': {
    w: 0.60,
    c: [bowl(0.05, 0.02, 0.55, 0.98, 0.15)],
    p: [[0.40, 0.24, 0.20, 0.76]],
  },
  '1': { w: 0.60, p: [[0.12, 0.26, 0.32, 0.02, 0.32, 0.98]] },
  '2': { w: 0.60, p: [[0.05, 0.24, 0.18, 0.02, 0.42, 0.02, 0.55, 0.22, 0.55, 0.36, 0.06, 0.98, 0.56, 0.98]] },
  '3': {
    w: 0.60,
    p: [
      [0.06, 0.20, 0.18, 0.02, 0.44, 0.02, 0.55, 0.19, 0.55, 0.34, 0.44, 0.48, 0.22, 0.48],
      [0.42, 0.48, 0.56, 0.62, 0.56, 0.81, 0.45, 0.98, 0.17, 0.98, 0.05, 0.80],
    ],
  },
  '4': { w: 0.60, p: [[0.42, 0.02, 0.04, 0.70, 0.57, 0.70], [0.42, 0.02, 0.42, 0.98]] },
  '5': { w: 0.60, p: [[0.55, 0.02, 0.13, 0.02, 0.09, 0.42, 0.42, 0.42, 0.56, 0.57, 0.56, 0.82, 0.45, 0.98, 0.17, 0.98, 0.05, 0.82]] },
  '6': {
    w: 0.60,
    p: [
      [0.53, 0.05, 0.22, 0.05, 0.06, 0.24, 0.06, 0.83, 0.18, 0.98, 0.44, 0.98, 0.56, 0.83, 0.56, 0.64, 0.44, 0.50, 0.16, 0.50, 0.06, 0.60],
    ],
  },
  '7': { w: 0.60, p: [[0.04, 0.02, 0.56, 0.02, 0.24, 0.98], [0.17, 0.52, 0.43, 0.52]] },
  '8': { w: 0.60, c: [bowl(0.06, 0.02, 0.54, 0.48, 0.12), bowl(0.04, 0.50, 0.56, 0.98, 0.13)] },
  '9': {
    w: 0.60,
    p: [
      [0.07, 0.93, 0.38, 0.93, 0.54, 0.74, 0.54, 0.15, 0.42, 0.02, 0.16, 0.02, 0.04, 0.15, 0.04, 0.34, 0.16, 0.48, 0.44, 0.48, 0.54, 0.38],
    ],
  },

  // ── letters ──
  'A': { w: 0.60, p: [[0.02, 0.98, 0.30, 0.02, 0.58, 0.98], [0.13, 0.66, 0.47, 0.66]] },
  'B': {
    w: 0.60,
    p: [
      [0.07, 0.98, 0.07, 0.02, 0.41, 0.02, 0.54, 0.16, 0.54, 0.35, 0.43, 0.48, 0.07, 0.48],
      [0.43, 0.48, 0.57, 0.62, 0.57, 0.84, 0.44, 0.98, 0.07, 0.98],
    ],
  },
  'C': { w: 0.58, p: [[0.55, 0.16, 0.42, 0.02, 0.18, 0.02, 0.05, 0.18, 0.05, 0.83, 0.18, 0.98, 0.42, 0.98, 0.55, 0.84]] },
  'D': { w: 0.60, p: [[0.07, 0.98, 0.07, 0.02, 0.38, 0.02, 0.56, 0.21, 0.56, 0.79, 0.38, 0.98, 0.07, 0.98]] },
  'E': { w: 0.54, p: [[0.51, 0.02, 0.07, 0.02, 0.07, 0.98, 0.52, 0.98], [0.07, 0.48, 0.42, 0.48]] },
  'F': { w: 0.52, p: [[0.51, 0.02, 0.07, 0.02, 0.07, 0.98], [0.07, 0.48, 0.41, 0.48]] },
  'G': { w: 0.62, p: [[0.57, 0.16, 0.44, 0.02, 0.19, 0.02, 0.06, 0.18, 0.06, 0.83, 0.19, 0.98, 0.44, 0.98, 0.58, 0.83, 0.58, 0.55, 0.34, 0.55]] },
  'H': { w: 0.60, p: [[0.07, 0.02, 0.07, 0.98], [0.54, 0.02, 0.54, 0.98], [0.07, 0.50, 0.54, 0.50]] },
  'I': { w: 0.28, p: [[0.14, 0.02, 0.14, 0.98]] },
  'J': { w: 0.52, p: [[0.46, 0.02, 0.46, 0.82, 0.33, 0.98, 0.15, 0.98, 0.04, 0.84]] },
  'K': { w: 0.58, p: [[0.07, 0.02, 0.07, 0.98], [0.55, 0.02, 0.09, 0.55], [0.24, 0.42, 0.57, 0.98]] },
  'L': { w: 0.50, p: [[0.07, 0.02, 0.07, 0.98, 0.49, 0.98]] },
  'M': { w: 0.72, p: [[0.05, 0.98, 0.05, 0.02, 0.35, 0.52, 0.65, 0.02, 0.65, 0.98]] },
  'N': { w: 0.62, p: [[0.07, 0.98, 0.07, 0.02, 0.56, 0.98, 0.56, 0.02]] },
  'O': { w: 0.62, c: [bowl(0.05, 0.02, 0.57, 0.98, 0.16)] },
  'P': { w: 0.58, p: [[0.07, 0.98, 0.07, 0.02, 0.43, 0.02, 0.55, 0.17, 0.55, 0.39, 0.43, 0.53, 0.07, 0.53]] },
  'Q': { w: 0.64, c: [bowl(0.05, 0.02, 0.57, 0.94, 0.16)], p: [[0.38, 0.68, 0.62, 1.04]] },
  'R': {
    w: 0.60,
    p: [
      [0.07, 0.98, 0.07, 0.02, 0.43, 0.02, 0.55, 0.17, 0.55, 0.37, 0.42, 0.51, 0.07, 0.51],
      [0.33, 0.51, 0.58, 0.98],
    ],
  },
  'S': { w: 0.58, p: [[0.55, 0.15, 0.42, 0.02, 0.18, 0.02, 0.05, 0.17, 0.05, 0.35, 0.16, 0.46, 0.43, 0.53, 0.55, 0.66, 0.55, 0.84, 0.42, 0.98, 0.17, 0.98, 0.04, 0.85]] },
  'T': { w: 0.56, p: [[0.02, 0.02, 0.54, 0.02], [0.28, 0.02, 0.28, 0.98]] },
  'U': { w: 0.60, p: [[0.06, 0.02, 0.06, 0.82, 0.20, 0.98, 0.41, 0.98, 0.55, 0.82, 0.55, 0.02]] },
  'V': { w: 0.60, p: [[0.03, 0.02, 0.30, 0.98, 0.57, 0.02]] },
  'W': { w: 0.80, p: [[0.03, 0.02, 0.21, 0.98, 0.40, 0.36, 0.59, 0.98, 0.77, 0.02]] },
  'X': { w: 0.58, p: [[0.04, 0.02, 0.54, 0.98], [0.54, 0.02, 0.04, 0.98]] },
  'Y': { w: 0.58, p: [[0.03, 0.02, 0.29, 0.50, 0.55, 0.02], [0.29, 0.50, 0.29, 0.98]] },
  'Z': { w: 0.58, p: [[0.04, 0.02, 0.55, 0.02, 0.05, 0.98, 0.56, 0.98]] },

  // ── punctuation & symbols ──
  '.': { w: 0.26, p: [], d: [[0.13, 0.92]] },
  ',': { w: 0.26, p: [[0.16, 0.86, 0.06, 1.08]] },
  ':': { w: 0.26, p: [], d: [[0.13, 0.30], [0.13, 0.86]] },
  ';': { w: 0.26, p: [[0.16, 0.86, 0.06, 1.08]], d: [[0.15, 0.30]] },
  '-': { w: 0.46, p: [[0.06, 0.52, 0.40, 0.52]] },
  '–': { w: 0.58, p: [[0.05, 0.52, 0.53, 0.52]] },
  '+': { w: 0.52, p: [[0.05, 0.52, 0.47, 0.52], [0.26, 0.31, 0.26, 0.73]] },
  '/': { w: 0.48, p: [[0.44, 0.00, 0.04, 1.02]] },
  '\\': { w: 0.48, p: [[0.04, 0.00, 0.44, 1.02]] },
  '!': { w: 0.26, p: [[0.13, 0.02, 0.13, 0.68]], d: [[0.13, 0.92]] },
  '?': { w: 0.52, p: [[0.04, 0.20, 0.15, 0.02, 0.37, 0.02, 0.48, 0.19, 0.48, 0.33, 0.26, 0.52, 0.26, 0.68]], d: [[0.26, 0.92]] },
  '\'': { w: 0.20, p: [[0.10, 0.02, 0.10, 0.26]] },
  '"': { w: 0.34, p: [[0.09, 0.02, 0.09, 0.26], [0.25, 0.02, 0.25, 0.26]] },
  '(': { w: 0.34, p: [[0.30, 0.00, 0.11, 0.28, 0.11, 0.72, 0.30, 1.00]] },
  ')': { w: 0.34, p: [[0.04, 0.00, 0.23, 0.28, 0.23, 0.72, 0.04, 1.00]] },
  '[': { w: 0.32, p: [[0.28, 0.00, 0.09, 0.00, 0.09, 1.00, 0.28, 1.00]] },
  ']': { w: 0.32, p: [[0.04, 0.00, 0.23, 0.00, 0.23, 1.00, 0.04, 1.00]] },
  '<': { w: 0.48, p: [[0.40, 0.14, 0.06, 0.52, 0.40, 0.90]] },
  '>': { w: 0.48, p: [[0.08, 0.14, 0.42, 0.52, 0.08, 0.90]] },
  '=': { w: 0.52, p: [[0.05, 0.38, 0.47, 0.38], [0.05, 0.66, 0.47, 0.66]] },
  '*': { w: 0.46, p: [[0.23, 0.10, 0.23, 0.54], [0.05, 0.20, 0.41, 0.46], [0.41, 0.20, 0.05, 0.46]] },
  '%': {
    w: 0.72,
    p: [[0.62, 0.02, 0.10, 0.98]],
    c: [bowl(0.03, 0.04, 0.29, 0.36, 0.08), bowl(0.43, 0.62, 0.69, 0.96, 0.08)],
  },
  '#': { w: 0.68, p: [[0.20, 0.02, 0.11, 0.98], [0.48, 0.02, 0.39, 0.98], [0.05, 0.34, 0.60, 0.34], [0.03, 0.66, 0.58, 0.66]] },
  '°': { w: 0.34, c: [bowl(0.05, 0.02, 0.29, 0.26, 0.07)] },
  '×': { w: 0.48, p: [[0.08, 0.28, 0.40, 0.76], [0.40, 0.28, 0.08, 0.76]] },
  '→': { w: 0.72, p: [[0.03, 0.52, 0.66, 0.52], [0.46, 0.30, 0.68, 0.52, 0.46, 0.74]] },
  '▲': { w: 0.50, c: [[0.25, 0.14, 0.46, 0.80, 0.04, 0.80]] },
  '▼': { w: 0.50, c: [[0.04, 0.20, 0.46, 0.20, 0.25, 0.86]] },
};

/** Fallback box so an unknown character is visible rather than silent. */
const MISSING = { w: 0.52, c: [bowl(0.06, 0.06, 0.46, 0.94, 0.08)] };

function glyphFor(ch) {
  return G[ch] ?? G[ch.toUpperCase?.()] ?? MISSING;
}

/**
 * Advance width of a string in em.
 * @param {string} text
 * @param {number} tracking extra advance per glyph, in em
 */
export function measureDisplayEm(text, tracking = 0.06) {
  let w = 0;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    w += glyphFor(s[i]).w + (i < s.length - 1 ? tracking : 0);
  }
  return w;
}

/** Pixel width of a string drawn at `size` px cap height. */
export function measureDisplay(text, size, tracking = 0.06) {
  return measureDisplayEm(text, tracking) * size;
}

/**
 * Draw display text on a 2D context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x anchor x (see `align`)
 * @param {number} y BASELINE y
 * @param {object} [o]
 * @param {number} [o.size=32]      cap height in px
 * @param {number} [o.tracking=0.06] letter spacing in em
 * @param {number} [o.weight=0.15]  stroke width in em
 * @param {number} [o.slant=0]      italic shear (0.18 ≈ 10°)
 * @param {'left'|'center'|'right'} [o.align='left']
 * @param {string|CanvasGradient} [o.fill]
 * @param {string} [o.outline]      colour of a fatter pass drawn underneath
 * @param {number} [o.outlineWidth=0.09] extra stroke width in em
 * @param {string} [o.glow]         shadow colour
 * @param {number} [o.glowBlur=18]
 * @param {number} [o.alpha=1]
 * @returns {number} the advance width in px
 */
export function drawDisplay(ctx, text, x, y, o = {}) {
  const s = String(text ?? '');
  const size = o.size ?? 32;
  const tracking = o.tracking ?? 0.06;
  const weight = o.weight ?? 0.15;
  const slant = o.slant ?? 0;
  const fill = o.fill ?? THEME.color.ink;
  const total = measureDisplay(s, size, tracking);

  let ox = x;
  if (o.align === 'center') ox = x - total * 0.5;
  else if (o.align === 'right') ox = x - total;

  ctx.save();
  if (o.alpha != null) ctx.globalAlpha *= o.alpha;
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 2.6;
  ctx.lineCap = 'butt';

  const passes = o.outline ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const isOutline = o.outline && pass === 0;
    ctx.strokeStyle = isOutline ? o.outline : fill;
    ctx.fillStyle = isOutline ? o.outline : fill;
    ctx.lineWidth = (weight + (isOutline ? (o.outlineWidth ?? 0.09) * 2 : 0)) * size;
    if (!isOutline && o.glow) {
      ctx.shadowColor = o.glow;
      ctx.shadowBlur = o.glowBlur ?? 18;
    } else {
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }

    let cx = ox;
    for (let i = 0; i < s.length; i++) {
      const g = glyphFor(s[i]);
      _emitGlyph(ctx, g, cx, y, size, slant, ctx.lineWidth);
      cx += (g.w + tracking) * size;
    }
  }

  ctx.restore();
  return total;
}

function _emitGlyph(ctx, g, cx, baseY, size, slant, lw) {
  // Shear about the baseline so the feet stay put.
  const sx = (px, py) => cx + (px + slant * (1 - py)) * size;
  const sy = (py) => baseY - (1 - py) * size;

  if (g.p) {
    for (let k = 0; k < g.p.length; k++) {
      const poly = g.p[k];
      if (poly.length < 4) continue;
      ctx.beginPath();
      ctx.moveTo(sx(poly[0], poly[1]), sy(poly[1]));
      for (let i = 2; i < poly.length; i += 2) ctx.lineTo(sx(poly[i], poly[i + 1]), sy(poly[i + 1]));
      ctx.stroke();
    }
  }
  if (g.c) {
    for (let k = 0; k < g.c.length; k++) {
      const poly = g.c[k];
      if (poly.length < 6) continue;
      ctx.beginPath();
      ctx.moveTo(sx(poly[0], poly[1]), sy(poly[1]));
      for (let i = 2; i < poly.length; i += 2) ctx.lineTo(sx(poly[i], poly[i + 1]), sy(poly[i + 1]));
      ctx.closePath();
      ctx.stroke();
    }
  }
  if (g.d) {
    const h = lw * 0.5;
    for (let k = 0; k < g.d.length; k++) {
      const px = sx(g.d[k][0], g.d[k][1]);
      const py = sy(g.d[k][1]);
      ctx.fillRect(px - h, py - h, lw, lw);
    }
  }
}

// ───────────────────────────────────────────────────────── DOM display text

const DPR_MAX = 2.5;
export function dpr() {
  return Math.min(globalThis.devicePixelRatio || 1, DPR_MAX);
}

/**
 * Render display text into a `<canvas>` sized to fit, ready to drop into DOM.
 * The canvas remembers its options on `canvas._rcrText` so `redrawDisplayText`
 * can re-render it after a DPR change.
 *
 * @returns {HTMLCanvasElement}
 */
export function displayTextCanvas(text, o = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = `rcr-dtext ${o.className ?? ''}`.trim();
  setDisplayText(canvas, text, o);
  return canvas;
}

/** (Re)draw display text into an existing canvas, resizing it to fit. */
export function setDisplayText(canvas, text, o = {}) {
  const opts = { ...o };
  const size = opts.size ?? 40;
  const tracking = opts.tracking ?? 0.06;
  const pad = opts.pad ?? Math.ceil(size * 0.34 + (opts.glowBlur ?? 0) * 0.5);
  const slant = opts.slant ?? 0;
  const w = Math.ceil(measureDisplay(text, size, tracking) + slant * size + pad * 2);
  const h = Math.ceil(size * 1.22 + pad * 2);
  const r = dpr();

  canvas._rcrText = { text, opts };
  if (canvas.width !== Math.ceil(w * r) || canvas.height !== Math.ceil(h * r)) {
    canvas.width = Math.ceil(w * r);
    canvas.height = Math.ceil(h * r);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(r, 0, 0, r, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawDisplay(ctx, text, pad, h - pad - size * 0.14, { ...opts, size, tracking, slant, align: 'left' });
  return canvas;
}

/** Re-render every display-text canvas under `root` (after a DPR change). */
export function refreshDisplayText(root) {
  if (!root) return;
  const list = root.querySelectorAll('canvas.rcr-dtext');
  for (const c of list) if (c._rcrText) setDisplayText(c, c._rcrText.text, c._rcrText.opts);
}

/**
 * Size a canvas for crisp drawing at the current DPR.
 * @returns {CanvasRenderingContext2D|null} with the transform already applied
 */
export function fitCanvas(canvas, cssW, cssH) {
  if (!canvas) return null;
  const r = dpr();
  const w = Math.max(1, Math.round(cssW));
  const h = Math.max(1, Math.round(cssH));
  const pw = Math.round(w * r);
  const ph = Math.round(h * r);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════
// Stylesheet
// ═══════════════════════════════════════════════════════════════════════════

const STYLE_ID = 'rcr-ui-style';

function cssVars() {
  const c = THEME.color;
  const lines = [];
  for (const k in c) lines.push(`  --c-${k}: ${c[k]};`);
  for (const k in THEME.space) lines.push(`  --s-${k}: ${THEME.space[k]}px;`);
  for (const k in THEME.radius) lines.push(`  --r-${k}: ${THEME.radius[k]}px;`);
  for (const k in THEME.shadow) lines.push(`  --sh-${k}: ${THEME.shadow[k]};`);
  for (const k in THEME.ease) lines.push(`  --e-${k}: ${THEME.ease[k]};`);
  for (const k in THEME.dur) lines.push(`  --d-${k}: ${THEME.dur[k]}ms;`);
  lines.push(`  --f-ui: ${THEME.font.ui};`);
  lines.push(`  --f-mono: ${THEME.font.mono};`);
  return lines.join('\n');
}

const CSS = () => `
.rcr {
${cssVars()}
  position: absolute; inset: 0;
  font-family: var(--f-ui);
  color: var(--c-ink);
  pointer-events: none;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  user-select: none; -webkit-user-select: none;
  --safe-t: env(safe-area-inset-top, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
  --safe-l: env(safe-area-inset-left, 0px);
  --safe-r: env(safe-area-inset-right, 0px);
}
.rcr *, .rcr *::before, .rcr *::after { box-sizing: border-box; margin: 0; padding: 0; }
.rcr canvas { display: block; }
.rcr button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.rcr .dim { color: var(--c-inkDim); }
.rcr .faint { color: var(--c-inkFaint); }
.rcr .mono { font-family: var(--f-mono); font-variant-numeric: tabular-nums; }
.rcr .hidden { display: none !important; }

/* ══════════════════════════════ screen shell ══════════════════════════════ */

.rcr-screens { position: absolute; inset: 0; pointer-events: none; z-index: ${THEME.z.screen}; }

.rcr-screen {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  pointer-events: auto;
  opacity: 1;
  transition: opacity var(--d-screen) var(--e-out);
  padding: calc(var(--safe-t) + 0px) calc(var(--safe-r)) calc(var(--safe-b)) calc(var(--safe-l));
}
.rcr-screen.is-transparent { pointer-events: none; }
.rcr-screen.is-transparent > * { pointer-events: auto; }
.rcr-screen.enter-from { opacity: 0; }
.rcr-screen.exit-to { opacity: 0; }
.rcr-screen .scr-body { position: absolute; inset: 0; display: flex; }

/* Backdrop treatments */
.rcr-scrim {
  position: absolute; inset: 0;
  background:
    radial-gradient(130% 100% at 18% 0%, rgba(23,52,126,0.40) 0%, rgba(3,5,10,0.0) 62%),
    linear-gradient(180deg, rgba(3,5,10,0.86) 0%, rgba(3,5,10,0.55) 42%, rgba(3,5,10,0.90) 100%);
  backdrop-filter: blur(2px) saturate(120%);
  -webkit-backdrop-filter: blur(2px) saturate(120%);
  transition: opacity var(--d-screen) var(--e-out);
}
.rcr-scrim.heavy { backdrop-filter: blur(14px) saturate(115%); -webkit-backdrop-filter: blur(14px) saturate(115%); }
.rcr-screen.enter-from .rcr-scrim, .rcr-screen.exit-to .rcr-scrim { opacity: 0; }

/* Animated diagonal speed-lines wash used behind menus */
.rcr-streaks {
  position: absolute; inset: -20%;
  background: repeating-linear-gradient(112deg,
    rgba(84,220,255,0.055) 0px, rgba(84,220,255,0.055) 1px,
    rgba(0,0,0,0) 1px, rgba(0,0,0,0) 92px);
  animation: rcr-streak 9s linear infinite;
  opacity: .8; pointer-events: none;
}
@keyframes rcr-streak { from { transform: translate3d(0,0,0); } to { transform: translate3d(-92px, 38px, 0); } }

.rcr-grid-fade {
  position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(180deg, rgba(84,220,255,0.05), rgba(84,220,255,0) 30%),
    repeating-linear-gradient(0deg, rgba(255,255,255,0.022) 0 1px, rgba(0,0,0,0) 1px 3px);
  mix-blend-mode: screen; opacity: .55;
}

/* ══════════════════════════════ panels & chrome ═══════════════════════════ */

.rcr-panel {
  position: relative;
  background: var(--c-panel);
  border: 1px solid var(--c-panelEdge);
  border-radius: var(--r-lg);
  box-shadow: var(--sh-hard), var(--sh-inner);
  backdrop-filter: blur(16px) saturate(140%);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
}
.rcr-panel::before {
  content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0) 34%);
}
/* Corner ticks — cheap way to make a rectangle feel engineered */
.rcr-ticks::after {
  content: ''; position: absolute; inset: 6px; pointer-events: none; border-radius: calc(var(--r-lg) - 4px);
  background:
    linear-gradient(var(--c-panelEdgeHot), var(--c-panelEdgeHot)) left  top    / 14px 1px no-repeat,
    linear-gradient(var(--c-panelEdgeHot), var(--c-panelEdgeHot)) left  top    / 1px 14px no-repeat,
    linear-gradient(var(--c-panelEdgeHot), var(--c-panelEdgeHot)) right top    / 14px 1px no-repeat,
    linear-gradient(var(--c-panelEdgeHot), var(--c-panelEdgeHot)) right top    / 1px 14px no-repeat,
    linear-gradient(var(--c-panelEdgeHot), var(--c-panelEdgeHot)) left  bottom / 14px 1px no-repeat,
    linear-gradient(var(--c-panelEdgeHot), var(--c-panelEdgeHot)) left  bottom / 1px 14px no-repeat,
    linear-gradient(var(--c-panelEdgeHot), var(--c-panelEdgeHot)) right bottom / 14px 1px no-repeat,
    linear-gradient(var(--c-panelEdgeHot), var(--c-panelEdgeHot)) right bottom / 1px 14px no-repeat;
  opacity: .8;
}

.rcr-eyebrow {
  font-size: 10px; letter-spacing: .38em; text-transform: uppercase;
  color: var(--c-cyan); opacity: .85; font-weight: 700;
}
.rcr-rule {
  height: 1px; background: linear-gradient(90deg, var(--c-panelEdgeHot), rgba(255,255,255,0));
  margin: var(--s-md) 0;
}
.rcr-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px; border-radius: var(--r-pill);
  font-size: 10px; letter-spacing: .16em; text-transform: uppercase; font-weight: 700;
  background: rgba(84,220,255,0.10); border: 1px solid rgba(84,220,255,0.28); color: var(--c-cyan);
}
.rcr-chip.amber { background: rgba(255,178,35,.10); border-color: rgba(255,178,35,.30); color: var(--c-amber); }
.rcr-chip.good  { background: rgba(67,229,140,.10); border-color: rgba(67,229,140,.30); color: var(--c-good); }
.rcr-chip.bad   { background: rgba(255,79,98,.10);  border-color: rgba(255,79,98,.32);  color: var(--c-bad); }
.rcr-chip.plain { background: rgba(255,255,255,.05); border-color: rgba(255,255,255,.14); color: var(--c-inkDim); }

/* ══════════════════════════════ menu lists ════════════════════════════════ */

.rcr-menu { display: flex; flex-direction: column; gap: 2px; }

.rcr-item {
  position: relative; display: flex; align-items: center; gap: 14px;
  padding: 13px 20px 13px 22px;
  border-radius: var(--r-md);
  color: var(--c-inkDim);
  letter-spacing: .16em; text-transform: uppercase; font-size: 14px; font-weight: 700;
  transition: color var(--d-fast) var(--e-out), background var(--d-fast) var(--e-out),
              transform var(--d-fast) var(--e-snap), letter-spacing var(--d-base) var(--e-out);
  cursor: pointer; overflow: hidden; text-align: left; width: 100%;
}
.rcr-item::before {
  content: ''; position: absolute; left: 0; top: 12%; bottom: 12%; width: 3px;
  background: linear-gradient(180deg, var(--c-cyan), var(--c-blue));
  border-radius: 3px; transform: scaleY(0); transform-origin: 50% 50%;
  transition: transform var(--d-base) var(--e-snap);
}
.rcr-item::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: linear-gradient(90deg, rgba(84,220,255,0.16), rgba(84,220,255,0) 68%);
  transition: opacity var(--d-base) var(--e-out);
}
.rcr-item .lbl { position: relative; z-index: 1; flex: 1; }
.rcr-item .val { position: relative; z-index: 1; color: var(--c-ink); font-weight: 800; letter-spacing: .1em; }
.rcr-item .hint { position: relative; z-index: 1; font-size: 10px; letter-spacing: .2em; color: var(--c-inkFaint); }
.rcr-item.is-focus { color: var(--c-ink); transform: translateX(6px); letter-spacing: .22em; }
.rcr-item.is-focus::before { transform: scaleY(1); }
.rcr-item.is-focus::after { opacity: 1; }
.rcr-item.is-disabled { opacity: .34; cursor: default; }
.rcr-item.is-disabled.is-focus { transform: none; }
.rcr-item .arrows { display: flex; gap: 8px; align-items: center; color: var(--c-inkFaint); font-size: 12px; }
.rcr-item.is-focus .arrows { color: var(--c-cyan); }

/* Slider control inside a menu row */
.rcr-slider { position: relative; width: 132px; height: 5px; border-radius: 3px; background: rgba(255,255,255,.10); overflow: hidden; }
.rcr-slider i { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, var(--c-cyanDeep), var(--c-cyan)); border-radius: 3px; transition: width var(--d-fast) var(--e-out); }
.rcr-item.is-focus .rcr-slider i { box-shadow: 0 0 14px var(--c-cyanGlow); }

.rcr-toggle { width: 42px; height: 22px; border-radius: var(--r-pill); background: rgba(255,255,255,.09);
  border: 1px solid rgba(255,255,255,.14); position: relative; transition: background var(--d-base) var(--e-out); }
.rcr-toggle i { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: var(--c-inkFaint); transition: transform var(--d-base) var(--e-snap), background var(--d-base) var(--e-out); }
.rcr-toggle.on { background: rgba(84,220,255,.20); border-color: rgba(84,220,255,.45); }
.rcr-toggle.on i { transform: translateX(20px); background: var(--c-cyan); box-shadow: 0 0 12px var(--c-cyanGlow); }

/* ══════════════════════════════ footer legend ═════════════════════════════ */

.rcr-legend {
  display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center;
  font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--c-inkFaint);
}
.rcr-legend b {
  display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 20px;
  padding: 0 6px; margin-right: 7px;
  border: 1px solid rgba(255,255,255,.20); border-radius: var(--r-xs);
  background: rgba(255,255,255,.05); color: var(--c-ink); font-size: 10px; letter-spacing: .06em;
}
.rcr-legend span { display: inline-flex; align-items: center; }

/* ══════════════════════════════ HUD ═══════════════════════════════════════ */

.rcr-hud {
  position: absolute; inset: 0; pointer-events: none; z-index: ${THEME.z.hud};
  opacity: 1; transition: opacity var(--d-base) var(--e-out);
  padding: calc(var(--safe-t) + 14px) calc(var(--safe-r) + 18px) calc(var(--safe-b) + 14px) calc(var(--safe-l) + 18px);
  font-variant-numeric: tabular-nums;
}
.rcr-hud.is-hidden { opacity: 0; }
.rcr-hud .corner { position: absolute; display: flex; flex-direction: column; }
.rcr-hud .tl { top: calc(var(--safe-t) + 14px);  left:  calc(var(--safe-l) + 18px); }
.rcr-hud .tr { top: calc(var(--safe-t) + 14px);  right: calc(var(--safe-r) + 18px); align-items: flex-end; }
.rcr-hud .bl { bottom: calc(var(--safe-b) + 14px); left:  calc(var(--safe-l) + 18px); }
.rcr-hud .br { bottom: calc(var(--safe-b) + 14px); right: calc(var(--safe-r) + 18px); align-items: flex-end; }

.hud-card {
  background: linear-gradient(180deg, rgba(9,15,26,.62), rgba(9,15,26,.42));
  border: 1px solid rgba(126,186,255,.14);
  border-radius: var(--r-md);
  box-shadow: 0 6px 24px rgba(0,0,0,.42);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  padding: 8px 12px;
}
.hud-label { font-size: 9px; letter-spacing: .30em; text-transform: uppercase; color: var(--c-inkFaint); }

/* position block */
.hud-pos { display: flex; align-items: baseline; gap: 8px; }
.hud-pos .place { position: relative; display: inline-block; transition: transform var(--d-base) var(--e-snap); }
.hud-pos.gain .place { animation: rcr-rank-up .55s var(--e-snap); }
.hud-pos.loss .place { animation: rcr-rank-down .55s var(--e-snap); }
@keyframes rcr-rank-up   { 0% { transform: translateY(16px) scale(.7); filter: brightness(3); } 100% { transform: none; } }
@keyframes rcr-rank-down { 0% { transform: translateY(-16px) scale(.7); filter: brightness(.4) saturate(2); } 100% { transform: none; } }

/* standings ladder */
.hud-ladder { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; min-width: 186px; }
.hud-row {
  display: grid; grid-template-columns: 20px 1fr auto; gap: 8px; align-items: center;
  padding: 3px 8px; border-radius: var(--r-sm);
  background: rgba(9,15,26,.46); border: 1px solid rgba(126,186,255,.09);
  font-size: 11px; letter-spacing: .08em; color: var(--c-inkDim);
  transition: background var(--d-base) var(--e-out), transform var(--d-base) var(--e-out);
}
.hud-row .n { color: var(--c-inkFaint); font-weight: 800; text-align: right; }
.hud-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: uppercase; }
.hud-row .gp { font-family: var(--f-mono); font-size: 10px; color: var(--c-inkFaint); }
.hud-row.me { background: rgba(255,209,102,.13); border-color: rgba(255,209,102,.42); color: var(--c-ink); }
.hud-row.me .n { color: var(--c-player); }
.hud-row.me .gp { color: var(--c-ink); }
.hud-row .swatch { width: 6px; height: 6px; border-radius: 2px; display: inline-block; margin-right: 6px; vertical-align: middle; }

/* lap times */
.hud-times { display: grid; grid-template-columns: auto auto; gap: 2px 14px; align-items: baseline; margin-top: 6px; }
.hud-times .k { font-size: 9px; letter-spacing: .26em; text-transform: uppercase; color: var(--c-inkFaint); }
.hud-times .v { font-family: var(--f-mono); font-size: 13px; color: var(--c-ink); letter-spacing: .02em; }
.hud-times .v.best { color: var(--c-magenta); }

.hud-delta {
  align-self: flex-end; margin-top: 6px; padding: 2px 10px; border-radius: var(--r-sm);
  font-family: var(--f-mono); font-size: 13px; font-weight: 700; letter-spacing: .04em;
  opacity: 0; transform: translateY(-4px);
  transition: opacity var(--d-base) var(--e-out), transform var(--d-base) var(--e-out);
}
.hud-delta.show { opacity: 1; transform: none; }
.hud-delta.up   { color: #04150c; background: var(--c-good); box-shadow: 0 0 22px rgba(67,229,140,.5); }
.hud-delta.down { color: #1a0308; background: var(--c-bad);  box-shadow: 0 0 22px rgba(255,79,98,.5); }

/* countdown */
.hud-count {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  pointer-events: none;
}
.hud-count canvas { filter: drop-shadow(0 0 40px rgba(84,220,255,.45)); }
.hud-count.punch canvas { animation: rcr-punch .62s var(--e-out); }
@keyframes rcr-punch {
  0%   { transform: scale(2.1); filter: blur(14px) drop-shadow(0 0 60px rgba(84,220,255,.9)); opacity: 0; }
  22%  { transform: scale(1.0); filter: blur(0px)  drop-shadow(0 0 44px rgba(84,220,255,.8)); opacity: 1; }
  74%  { transform: scale(1.0); opacity: 1; }
  100% { transform: scale(1.30); filter: blur(6px); opacity: 0; }
}

/* banners */
.hud-banner {
  position: absolute; left: 50%; top: 21%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: none;
}
.hud-banner .bar {
  padding: 7px 30px; border-radius: var(--r-sm);
  background: linear-gradient(90deg, rgba(255,122,24,0), rgba(255,122,24,.30), rgba(255,122,24,0));
  border-top: 1px solid rgba(255,178,35,.5); border-bottom: 1px solid rgba(255,178,35,.5);
}
.hud-banner.enter { animation: rcr-banner 3.2s var(--e-out) forwards; }
@keyframes rcr-banner {
  0%   { opacity: 0; transform: translate(-50%, -18px) scale(.94); }
  9%   { opacity: 1; transform: translate(-50%, 0) scale(1); }
  78%  { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -10px); }
}

/* toasts */
.hud-toasts {
  position: absolute; left: 50%; top: 34%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 7px; pointer-events: none;
}
.hud-toast {
  padding: 6px 16px; border-radius: var(--r-pill);
  font-size: 12px; font-weight: 800; letter-spacing: .22em; text-transform: uppercase;
  background: rgba(9,15,26,.72); border: 1px solid rgba(126,186,255,.24); color: var(--c-ink);
  box-shadow: 0 8px 26px rgba(0,0,0,.5);
  animation: rcr-toast-in .34s var(--e-snap);
  white-space: nowrap;
}
.hud-toast.out { animation: rcr-toast-out .32s var(--e-in) forwards; }
.hud-toast.good { border-color: rgba(67,229,140,.5);  color: var(--c-good); box-shadow: 0 0 26px rgba(67,229,140,.24); }
.hud-toast.bad  { border-color: rgba(255,79,98,.5);   color: var(--c-bad);  box-shadow: 0 0 26px rgba(255,79,98,.24); }
.hud-toast.warn { border-color: rgba(255,204,51,.5);  color: var(--c-warn); box-shadow: 0 0 26px rgba(255,204,51,.24); }
.hud-toast.info { border-color: rgba(84,220,255,.5);  color: var(--c-cyan); box-shadow: 0 0 26px rgba(84,220,255,.24); }
@keyframes rcr-toast-in  { from { opacity: 0; transform: translateY(14px) scale(.9); } to { opacity: 1; transform: none; } }
@keyframes rcr-toast-out { to { opacity: 0; transform: translateY(-10px) scale(.96); } }

/* wrong way — deliberately loud */
.hud-wrongway {
  position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%);
  display: none; flex-direction: column; align-items: center; gap: 6px; pointer-events: none;
}
.hud-wrongway.show { display: flex; animation: rcr-ww 0.72s steps(1) infinite; }
@keyframes rcr-ww { 0%, 55% { opacity: 1; } 56%, 100% { opacity: .18; } }

/* effect vignettes */
.hud-vig { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .22s linear; mix-blend-mode: screen; }
.hud-vig.frozen  { background: radial-gradient(115% 90% at 50% 50%, rgba(120,220,255,0) 42%, rgba(150,235,255,.62) 100%); }
.hud-vig.electro { background: radial-gradient(115% 90% at 50% 50%, rgba(160,120,255,0) 46%, rgba(190,140,255,.55) 100%); }
.hud-vig.oiled   { background: radial-gradient(115% 90% at 50% 50%, rgba(20,12,30,0) 34%, rgba(24,10,36,.92) 100%); mix-blend-mode: multiply; }
.hud-vig.soaked  { background: radial-gradient(110% 90% at 50% 44%, rgba(120,200,255,0) 30%, rgba(150,210,255,.55) 100%); }
.hud-vig.boost   { background: radial-gradient(120% 92% at 50% 50%, rgba(255,150,40,0) 52%, rgba(255,140,30,.42) 100%); }
.hud-vig.damage  { background: radial-gradient(110% 90% at 50% 50%, rgba(255,40,60,0) 42%, rgba(255,30,50,.60) 100%); }
.hud-blind { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .3s linear;
  background: radial-gradient(70% 60% at 50% 48%, rgba(190,225,255,.94), rgba(160,205,255,.55) 60%, rgba(120,170,230,.15) 100%);
  backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px); }

/* finish flourish */
.hud-finish { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; }
.hud-finish.show { display: flex; }
.hud-finish .flag { position: absolute; inset: 0; opacity: .0; animation: rcr-flag 1.5s var(--e-out) forwards; }
@keyframes rcr-flag { 0% { opacity: 0; transform: scale(1.2); } 18% { opacity: .95; } 100% { opacity: 0; transform: scale(1); } }

/* ══════════════════════════════ results ═══════════════════════════════════ */

.res-grid { display: flex; flex-direction: column; gap: 4px; }
.res-row {
  display: grid; grid-template-columns: 46px 1fr 92px 92px; gap: 10px; align-items: center;
  padding: 9px 14px; border-radius: var(--r-sm);
  background: rgba(255,255,255,.028); border: 1px solid rgba(126,186,255,.09);
  font-size: 12px; letter-spacing: .1em; color: var(--c-inkDim);
  opacity: 0; transform: translateX(-18px);
  animation: rcr-res-in .42s var(--e-out) forwards;
}
@keyframes rcr-res-in { to { opacity: 1; transform: none; } }
.res-row .pl { font-weight: 900; font-size: 15px; color: var(--c-inkFaint); text-align: right; }
.res-row .nm { text-transform: uppercase; font-weight: 700; color: var(--c-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.res-row .cr { font-size: 10px; letter-spacing: .16em; color: var(--c-inkFaint); text-transform: uppercase; }
.res-row .tt, .res-row .bl { font-family: var(--f-mono); font-size: 12px; text-align: right; }
.res-row.me { background: rgba(255,209,102,.11); border-color: rgba(255,209,102,.4); color: var(--c-ink); }
.res-row.p1 .pl { color: var(--c-gold); text-shadow: 0 0 18px rgba(255,209,102,.55); }
.res-row.p2 .pl { color: var(--c-silver); }
.res-row.p3 .pl { color: var(--c-bronze); }
.res-row.dnf { opacity: .5; }
.res-row .bl.rec { color: var(--c-magenta); }

.res-record {
  display: inline-flex; align-items: center; gap: 10px; padding: 8px 20px; border-radius: var(--r-pill);
  background: linear-gradient(90deg, rgba(215,92,255,.18), rgba(84,220,255,.16));
  border: 1px solid rgba(215,92,255,.5); color: #fff;
  font-size: 12px; font-weight: 800; letter-spacing: .3em; text-transform: uppercase;
  box-shadow: 0 0 40px rgba(215,92,255,.36);
  animation: rcr-record 2.4s var(--e-out) infinite;
}
@keyframes rcr-record { 0%,100% { transform: scale(1); box-shadow: 0 0 30px rgba(215,92,255,.28); }
                        50% { transform: scale(1.035); box-shadow: 0 0 54px rgba(215,92,255,.5); } }

/* ══════════════════════════════ car / track select ════════════════════════ */

.sel-stage { position: absolute; inset: 0; display: flex; flex-direction: column; }
.sel-top { display: flex; justify-content: space-between; align-items: flex-start; padding: 26px 34px 0; gap: 20px; }
.sel-bottom { margin-top: auto; padding: 0 34px 26px; display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; }

.stat-row { display: grid; grid-template-columns: 62px 1fr 26px; gap: 10px; align-items: center; margin: 7px 0; }
.stat-row .k { font-size: 9px; letter-spacing: .26em; text-transform: uppercase; color: var(--c-inkFaint); }
.stat-row .v { font-family: var(--f-mono); font-size: 10px; color: var(--c-inkDim); text-align: right; }
.stat-bar { position: relative; height: 7px; border-radius: 4px; background: rgba(255,255,255,.07); overflow: hidden; }
.stat-bar::after {
  content: ''; position: absolute; inset: 0;
  background: repeating-linear-gradient(90deg, rgba(0,0,0,.55) 0 1px, rgba(0,0,0,0) 1px 20%);
}
.stat-bar i {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: linear-gradient(90deg, var(--c-cyanDeep), var(--c-cyan));
  border-radius: 4px; box-shadow: 0 0 14px var(--c-cyanGlow);
  transition: width .42s var(--e-out);
}
.stat-bar.hot i { background: linear-gradient(90deg, var(--c-amberHot), var(--c-amber)); box-shadow: 0 0 14px var(--c-amberGlow); }

.swatches { display: flex; gap: 8px; flex-wrap: wrap; }
.swatch-btn {
  width: 26px; height: 26px; border-radius: 50%; cursor: pointer; position: relative;
  border: 2px solid rgba(255,255,255,.16);
  transition: transform var(--d-fast) var(--e-snap), border-color var(--d-fast) var(--e-out);
}
.swatch-btn:hover { transform: scale(1.12); }
.swatch-btn.on { border-color: #fff; transform: scale(1.16); box-shadow: 0 0 16px currentColor; }
.swatch-btn.is-focus::after {
  content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 1px dashed rgba(255,255,255,.6);
}

.carousel { display: flex; align-items: center; gap: 10px; justify-content: center; }
.carousel .dots { display: flex; gap: 6px; }
.carousel .dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,.20); transition: all var(--d-base) var(--e-out); }
.carousel .dot.on { background: var(--c-cyan); width: 20px; border-radius: 3px; box-shadow: 0 0 12px var(--c-cyanGlow); }
.nav-arrow {
  width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center;
  border: 1px solid var(--c-panelEdge); background: rgba(9,15,26,.6); color: var(--c-inkDim);
  transition: all var(--d-fast) var(--e-out);
}
.nav-arrow:hover { color: var(--c-ink); border-color: var(--c-panelEdgeHot); transform: scale(1.06); }

.card-grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); }
.track-card {
  position: relative; overflow: hidden; cursor: pointer;
  border-radius: var(--r-lg); border: 1px solid var(--c-panelEdge);
  background: linear-gradient(180deg, rgba(17,26,41,.86), rgba(6,10,18,.92));
  transition: transform var(--d-base) var(--e-snap), border-color var(--d-base) var(--e-out), box-shadow var(--d-base) var(--e-out);
}
.track-card .thumb { display: block; width: 100%; aspect-ratio: 16 / 9; background: rgba(0,0,0,.35); }
.track-card .meta { padding: 11px 14px 13px; display: flex; flex-direction: column; gap: 7px; }
.track-card .ttl { font-size: 14px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
.track-card .sub { font-size: 10px; letter-spacing: .18em; color: var(--c-inkFaint); text-transform: uppercase;
  display: flex; gap: 12px; flex-wrap: wrap; }
.track-card .desc { font-size: 11px; line-height: 1.5; color: var(--c-inkDim); letter-spacing: .02em;
  display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.track-card.is-focus { transform: translateY(-5px) scale(1.015); border-color: var(--c-panelEdgeHot);
  box-shadow: 0 22px 60px rgba(0,0,0,.6), var(--sh-cyan); }
.track-card.is-focus .ttl { color: var(--c-cyan); }
.diff { display: inline-flex; gap: 3px; align-items: center; }
.diff i { width: 12px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.16); }
.diff i.on { background: var(--c-amber); box-shadow: 0 0 8px var(--c-amberGlow); }

/* ══════════════════════════════ loading ═══════════════════════════════════ */

.load-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end;
  padding: 0 clamp(24px, 6vw, 84px) clamp(34px, 8vh, 84px); gap: 18px; }
.load-bar { position: relative; height: 4px; border-radius: 3px; background: rgba(255,255,255,.09); overflow: hidden; }
.load-bar i { position: absolute; inset: 0 auto 0 0; width: 0%; border-radius: 3px;
  background: linear-gradient(90deg, var(--c-blue), var(--c-cyan)); box-shadow: 0 0 22px var(--c-cyanGlow);
  transition: width .3s var(--e-out); }
.load-bar::after { content: ''; position: absolute; inset: 0; background:
  repeating-linear-gradient(115deg, rgba(255,255,255,.10) 0 8px, rgba(255,255,255,0) 8px 20px);
  animation: rcr-streak 1.1s linear infinite; }
.load-tip { font-size: 12px; line-height: 1.6; color: var(--c-inkDim); max-width: 60ch; letter-spacing: .03em; }
.load-spin { width: 26px; height: 26px; border-radius: 50%; border: 2px solid rgba(255,255,255,.14);
  border-top-color: var(--c-cyan); animation: rcr-spin .9s linear infinite; }
@keyframes rcr-spin { to { transform: rotate(360deg); } }

/* ══════════════════════════════ telemetry ═════════════════════════════════ */

.rcr-telemetry {
  position: absolute; top: calc(var(--safe-t) + 10px); left: calc(var(--safe-l) + 10px);
  z-index: ${THEME.z.telemetry};
  width: 306px; padding: 9px 11px 11px; pointer-events: none;
  background: rgba(3,6,12,.82); border: 1px solid rgba(126,186,255,.18); border-radius: var(--r-sm);
  font-family: var(--f-mono); font-size: 10px; line-height: 1.45; color: #b8c8e6;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}
.rcr-telemetry h4 { font-size: 9px; letter-spacing: .24em; color: var(--c-cyan); margin-bottom: 4px; font-weight: 700; text-transform: uppercase; }
.rcr-telemetry .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.rcr-telemetry .kv { display: flex; justify-content: space-between; gap: 8px; }
.rcr-telemetry .kv b { color: #eaf2ff; font-weight: 600; }
.rcr-telemetry .warnv { color: var(--c-warn); }
.rcr-telemetry .badv  { color: var(--c-bad); }
.rcr-telemetry hr { border: 0; border-top: 1px solid rgba(255,255,255,.09); margin: 6px 0 5px; }

/* ══════════════════════════════ touch controls ════════════════════════════ */

.rcr-touch { position: absolute; inset: 0; z-index: ${THEME.z.touch}; pointer-events: none; touch-action: none; display: none; }
.rcr-touch.on { display: block; }
.rcr-touch .pad { position: absolute; pointer-events: auto; touch-action: none; -webkit-tap-highlight-color: transparent; }
.rcr-touch .wheel { left: calc(var(--safe-l) + 14px); bottom: calc(var(--safe-b) + 14px); width: 168px; height: 168px; }
.rcr-touch .pedals { right: calc(var(--safe-r) + 14px); bottom: calc(var(--safe-b) + 14px);
  display: flex; flex-direction: column; gap: 12px; align-items: flex-end; }
.rcr-touch .btn {
  width: 84px; height: 74px; border-radius: var(--r-lg);
  display: grid; place-items: center; pointer-events: auto; touch-action: none;
  background: rgba(9,15,26,.5); border: 1px solid rgba(126,186,255,.22);
  color: var(--c-inkDim); font-size: 10px; letter-spacing: .22em; font-weight: 800; text-transform: uppercase;
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  transition: background .1s linear, color .1s linear, transform .1s var(--e-out);
}
.rcr-touch .btn.hot { background: rgba(84,220,255,.26); color: #fff; border-color: rgba(84,220,255,.6); transform: scale(.96); }
.rcr-touch .btn.gas.hot { background: rgba(67,229,140,.28); border-color: rgba(67,229,140,.6); }
.rcr-touch .btn.brk.hot { background: rgba(255,79,98,.28); border-color: rgba(255,79,98,.6); }
.rcr-touch .aux { position: absolute; right: calc(var(--safe-r) + 14px); top: calc(var(--safe-t) + 60px);
  display: flex; flex-direction: column; gap: 10px; }
.rcr-touch .aux .btn { width: 60px; height: 46px; font-size: 9px; }

/* pause button, top-centre on touch */
.rcr-pausebtn {
  position: absolute; top: calc(var(--safe-t) + 12px); left: 50%; transform: translateX(-50%);
  width: 42px; height: 34px; border-radius: var(--r-sm); pointer-events: auto;
  background: rgba(9,15,26,.5); border: 1px solid rgba(126,186,255,.2);
  display: none; place-items: center; z-index: ${THEME.z.touch};
}
.rcr-pausebtn.on { display: grid; }
.rcr-pausebtn i { width: 4px; height: 14px; background: var(--c-inkDim); box-shadow: 8px 0 0 var(--c-inkDim); margin-right: 8px; }

/* ══════════════════════════════ misc ══════════════════════════════════════ */

.rcr-fade { position: absolute; inset: 0; background: #03050a; opacity: 0; pointer-events: none;
  z-index: ${THEME.z.fade}; transition: opacity var(--d-slow) var(--e-inOut); }
.rcr-fade.on { opacity: 1; }

.rcr-title-wrap { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.rcr-title-sub { font-size: 11px; letter-spacing: .52em; color: var(--c-inkFaint); text-transform: uppercase; }

.rcr-version { position: absolute; right: 14px; bottom: 10px; font-size: 9px; letter-spacing: .22em;
  color: rgba(160,185,225,.28); text-transform: uppercase; }

/* ══════════════════════════════ responsive ════════════════════════════════ */

@media (max-width: 900px) {
  .sel-top { padding: 16px 18px 0; }
  .sel-bottom { padding: 0 18px 18px; flex-direction: column; align-items: stretch; }
  .hud-ladder { min-width: 150px; }
  .rcr-item { padding: 11px 14px 11px 16px; font-size: 12px; }
}
@media (max-width: 680px) {
  .rcr-hud { padding: calc(var(--safe-t) + 8px) calc(var(--safe-r) + 10px) calc(var(--safe-b) + 8px) calc(var(--safe-l) + 10px); }
  .rcr-hud .tl { top: calc(var(--safe-t) + 8px);  left:  calc(var(--safe-l) + 10px); }
  .rcr-hud .tr { top: calc(var(--safe-t) + 8px);  right: calc(var(--safe-r) + 10px); }
  .rcr-hud .bl { bottom: calc(var(--safe-b) + 8px); left:  calc(var(--safe-l) + 10px); }
  .rcr-hud .br { bottom: calc(var(--safe-b) + 8px); right: calc(var(--safe-r) + 10px); }
  .hud-ladder { display: none; }
  .res-row { grid-template-columns: 34px 1fr 76px; }
  .res-row .bl { display: none; }
  .card-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
  .track-card .desc { display: none; }
  .rcr-telemetry { width: 250px; font-size: 9px; }
}
@media (max-width: 460px) {
  .card-grid { grid-template-columns: 1fr; }
  .rcr-legend { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .rcr *, .rcr *::before, .rcr *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
  .rcr-streaks { animation: none; }
}
`;

let _injected = false;

/** Inject the stylesheet once. Safe to call repeatedly. */
export function injectStyles(doc = document) {
  if (_injected && doc.getElementById(STYLE_ID)) return;
  let el = doc.getElementById(STYLE_ID);
  if (!el) {
    el = doc.createElement('style');
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  el.textContent = CSS();
  _injected = true;
}

export function removeStyles(doc = document) {
  doc.getElementById(STYLE_ID)?.remove();
  _injected = false;
}

export default THEME;
