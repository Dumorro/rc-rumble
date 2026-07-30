/**
 * RC RUMBLE — track select.
 *
 * Cards from `game.trackSystem.listTracks()`, each with a procedurally drawn
 * minimap of the track's own centreline (see `TrackMap.js` for how the shape is
 * sourced), a difficulty meter, length, lap count, your stored record, and the
 * theme colours the track publishes. Lap count and field size are adjustable
 * here, and mirrored / reversed toggles appear only if the track system
 * advertises support for them.
 */

import { el, clear, setText, setStyle, setClass, clamp, formatTime, formatLength } from '../Dom.js';
import { THEME, withAlpha, fitCanvas, drawDisplay, setDisplayText } from '../Theme.js';
import { Screen, MenuList } from '../Screen.js';
import { outlineFor, fitOutline, drawRibbon, outlineLength } from '../TrackMap.js';

const C = THEME.color;
const DIFFICULTY_RANK = { easy: 1, medium: 2, normal: 2, hard: 3, expert: 4, insane: 5 };

export class TrackSelect extends Screen {
  static id = 'track';

  constructor(ui, props) {
    super(ui, props);
    this.tracks = [];
    this.index = 0;
    this.focusZone = 0;    // 0 = cards, 1 = settings, 2 = actions
    this.cards = [];
  }

  build() {
    const root = el('.rcr-screen');
    root.appendChild(el('.rcr-scrim.heavy'));
    root.appendChild(el('.rcr-grid-fade'));

    this.tracks = safeList(this.game);
    const wanted = this.props.trackId ?? this.ui.settings.get('lastTrack');
    const i = this.tracks.findIndex(t => t.id === wanted);
    this.index = i >= 0 ? i : 0;

    const isChampionship = this.props.mode === 'championship';
    const head = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      el('.rcr-eyebrow', { text: isChampionship ? 'Championship calendar' : 'Step 2 of 2' }),
      this.heading(isChampionship ? 'THE SEASON' : 'CHOOSE A TRACK', { size: 38 }));

    // ── cards ──
    this.grid = el('.card-grid');
    this._buildCards();

    // ── settings ──
    const supportsMirror = this._supports('mirrored');
    const supportsReverse = this._supports('reversed');
    this.settings = new MenuList(this, [
      {
        label: 'Laps', type: 'slider', min: 1, max: 12, step: 1,
        get: () => this.ui.settings.get('laps'),
        set: (v) => this.ui.settings.set('laps', v),
        format: (v) => String(v),
      },
      {
        label: 'Opponents', type: 'slider', min: 0, max: 7, step: 1,
        get: () => (this.props.mode === 'timetrial' ? 0 : this.ui.settings.get('opponents')),
        set: (v) => this.ui.settings.set('opponents', v),
        format: (v) => String(v),
        disabled: this.props.mode === 'timetrial',
      },
      supportsMirror && {
        label: 'Mirrored', type: 'toggle',
        get: () => this.ui.settings.get('mirrored'),
        set: (v) => this.ui.settings.set('mirrored', v),
      },
      supportsReverse && {
        label: 'Reversed', type: 'toggle',
        get: () => this.ui.settings.get('reversed'),
        set: (v) => this.ui.settings.set('reversed', v),
      },
    ].filter(Boolean), { active: false });

    this.settingsPanel = el('.rcr-panel', {
      style: { padding: '10px 8px', minWidth: '270px' },
    }, this.settings.el);

    // ── detail strip ──
    this.detailName = el('div', {
      style: { fontSize: '15px', fontWeight: '800', letterSpacing: '.16em', textTransform: 'uppercase' },
    });
    this.detailDesc = el('div', {
      style: { fontSize: '11.5px', lineHeight: '1.6', color: C.inkDim, maxWidth: '54ch' },
    });
    this.detailRecord = el('div', {
      style: { fontFamily: THEME.font.mono, fontSize: '11px', color: C.inkFaint, letterSpacing: '.06em' },
    });
    this.detail = el('.rcr-panel.rcr-ticks', {
      style: { padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 320px' },
    }, this.detailName, this.detailDesc, this.detailRecord);

    // ── actions ──
    this.actions = new MenuList(this, [
      { label: isChampionship ? 'Start Season' : 'Race', onSelect: () => this.confirm() },
      { label: 'Back', onSelect: () => this.ui.pop() },
    ], { vertical: false, wrap: false, active: false });

    root.appendChild(el('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        gap: '14px', padding: 'clamp(18px, 4vw, 54px)', overflow: 'hidden',
      },
    },
    head,
    el('div', { style: { flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px' } }, this.grid),
    el('div', {
      style: { display: 'flex', gap: '14px', alignItems: 'stretch', flexWrap: 'wrap' },
    }, this.detail, this.settingsPanel),
    el('div', {
      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '16px', flexWrap: 'wrap' },
    },
    this.legend([['←→↑↓', 'Navigate'], ['↵', 'Race'], ['ESC', 'Back']]),
    this.actions.el)));

    this.menu = null;
    return root;
  }

  _supports(flag) {
    const ts = this.game?.trackSystem;
    if (!ts) return false;
    if (typeof ts.supports === 'function') { try { return !!ts.supports(flag); } catch { return false; } }
    if (ts.features && typeof ts.features === 'object') return !!ts.features[flag];
    // The load() contract takes a plain id today; only advertise the toggles
    // when the track system has explicitly opted in.
    return false;
  }

  _buildCards() {
    clear(this.grid);
    this.cards = [];
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      const thumb = document.createElement('canvas');
      thumb.className = 'thumb';
      const card = el('.track-card', {
        on: {
          click: () => { this.select(i); this.confirm(); },
          pointerenter: () => { if (this.index !== i) { this.select(i); this.sound('ui/hover', 0.45); } },
        },
      }, thumb,
      el('.meta', null,
        el('.ttl', { text: String(t.name ?? t.id).toUpperCase() }),
        el('.sub', null,
          diffMeter(t.difficulty),
          el('span', { text: formatLength(this._lengthOf(t)) }),
          el('span', { text: `${t.laps ?? 3} LAPS` }),
          el('span', { text: String(t.theme ?? '').toUpperCase() })),
        el('.desc', { text: t.description ?? '' })));
      this.grid.appendChild(card);
      this.cards.push({ el: card, thumb, track: t, drawn: false });
    }
  }

  _lengthOf(t) {
    if (Number.isFinite(t.length) && t.length > 0) return t.length;
    const o = outlineFor(t.id, this.game, t);
    return o?.real ? outlineLength(o) : 0;
  }

  // ═══════════════════════════════════════════════════════════ lifecycle

  onEnter() {
    this.own(this.ui.onResize(() => this._redrawThumbs(true)));
    this._redrawThumbs(true);
    this.select(this.index, true);
    this._refreshFocus();
  }

  update() {}

  _redrawThumbs(force = false) {
    for (const c of this.cards) {
      const r = c.thumb.getBoundingClientRect();
      const w = Math.max(80, Math.round(r.width || 240));
      const h = Math.max(50, Math.round(r.height || w * 0.5625));
      if (!force && c.drawn && c.w === w && c.h === h) continue;
      c.w = w; c.h = h; c.drawn = true;
      drawTrackThumb(c.thumb, w, h, c.track, this.game, this.ui);
    }
  }

  // ═══════════════════════════════════════════════════════════ selection

  get current() { return this.tracks[this.index] ?? null; }

  select(i, silent = false) {
    const n = this.tracks.length;
    if (!n) return;
    this.index = ((i % n) + n) % n;
    for (let k = 0; k < this.cards.length; k++) {
      setClass(this.cards[k].el, 'is-focus', k === this.index && this.focusZone === 0);
    }
    const t = this.current;
    if (!t) return;
    setText(this.detailName, String(t.name ?? t.id).toUpperCase());
    setText(this.detailDesc, t.description ?? 'No briefing available for this circuit.');
    const rec = this.ui.settings.recordFor(t.id);
    const bits = [
      `BEST LAP ${Number.isFinite(rec.bestLap) ? formatTime(rec.bestLap) : '--.---'}`,
      `BEST RACE ${Number.isFinite(rec.bestRace) ? formatTime(rec.bestRace, { forceMinutes: true }) : '--:--.---'}`,
      `WINS ${rec.wins}/${rec.races}`,
    ];
    setText(this.detailRecord, bits.join('   ·   '));
    this.cards[this.index]?.el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    if (!silent) this.sound('ui/hover', 0.45);
  }

  /** How many cards fit per row, so up/down move by a row. */
  _columns() {
    if (this.cards.length < 2) return 1;
    const a = this.cards[0].el.getBoundingClientRect();
    // `.track-card.is-focus` lifts the focused card by translateY(-5px) and scales it,
    // so two cards on the SAME row can differ in `top` by several pixels. Compare row
    // membership by centre-y against half a card height — a real second row is a whole
    // card lower, so the tolerance is never ambiguous.
    const tol = Math.max(8, a.height * 0.5);
    const aMid = a.top + a.height * 0.5;
    let cols = 1;
    for (let i = 1; i < this.cards.length; i++) {
      const b = this.cards[i].el.getBoundingClientRect();
      if (Math.abs((b.top + b.height * 0.5) - aMid) > tol) break;
      cols++;
    }
    return Math.max(1, cols);
  }

  _refreshFocus() {
    for (let k = 0; k < this.cards.length; k++) {
      setClass(this.cards[k].el, 'is-focus', k === this.index && this.focusZone === 0);
    }
    setStyle(this.settingsPanel, 'borderColor', this.focusZone === 1 ? C.panelEdgeHot : C.panelEdge);
    this.settings.setActive(this.focusZone === 1);
    this.actions.setActive(this.focusZone === 2);
    this.settings.refresh();
  }

  confirm() {
    const t = this.current;
    if (!t) return;
    this.ui.settings.set('lastTrack', t.id);
    this.sound('ui/confirm', 1);
    this.ui.flow.trackId = t.id;
    this.ui.flow.laps = this.ui.settings.get('laps');
    this.ui.flow.opponents = this.props.mode === 'timetrial' ? 0 : this.ui.settings.get('opponents');
    this.ui.flow.mirrored = this.ui.settings.get('mirrored');
    this.ui.flow.reversed = this.ui.settings.get('reversed');
    this.ui.startFlow();
  }

  // ═══════════════════════════════════════════════════════════ input

  onAction(action) {
    const cols = this._columns();
    switch (action) {
      case 'left':
        if (this.focusZone === 1) { this.settings.adjust(-1); return true; }
        if (this.focusZone === 2) { this.actions.move(-1); this._refreshFocus(); return true; }
        this.select(this.index - 1);
        return true;
      case 'right':
        if (this.focusZone === 1) { this.settings.adjust(1); return true; }
        if (this.focusZone === 2) { this.actions.move(1); this._refreshFocus(); return true; }
        this.select(this.index + 1);
        return true;
      case 'up':
        if (this.focusZone === 1) {
          if (this.settings.index === 0) { this.focusZone = 0; this._refreshFocus(); return true; }
          this.settings.move(-1);
          return true;
        }
        if (this.focusZone === 2) { this.focusZone = 1; this._refreshFocus(); return true; }
        if (this.index - cols >= 0) { this.select(this.index - cols); return true; }
        return true;
      case 'down':
        if (this.focusZone === 0) {
          if (this.index + cols < this.tracks.length) { this.select(this.index + cols); return true; }
          this.focusZone = 1;
          this._refreshFocus();
          return true;
        }
        if (this.focusZone === 1) {
          if (this.settings.index >= this.settings.items.length - 1) { this.focusZone = 2; this._refreshFocus(); return true; }
          this.settings.move(1);
          return true;
        }
        return true;
      case 'confirm':
        if (this.focusZone === 1) { this.settings.activate(); return true; }
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

// ═══════════════════════════════════════════════════════════════ thumbnails

/** Draw one track card thumbnail: themed sky wash + the real spline shape. */
export function drawTrackThumb(canvas, w, h, track, game, ui) {
  const ctx = fitCanvas(canvas, w, h);
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const colors = Array.isArray(track?.previewColors) && track.previewColors.length
    ? track.previewColors
    : [0x2b3a55, 0x3d5170, 0x54dcff];
  const hex = (n) => `#${(n >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;

  // Themed backdrop
  const bg = ctx.createLinearGradient(0, 0, w * 0.4, h);
  bg.addColorStop(0, withAlpha(hex(colors[0]), 0.55));
  bg.addColorStop(0.55, 'rgba(7,12,21,0.92)');
  bg.addColorStop(1, 'rgba(4,7,13,0.98)');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // A faint contour wash so an empty card still has depth.
  ctx.globalAlpha = 0.10;
  ctx.strokeStyle = hex(colors[1] ?? colors[0]);
  ctx.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    for (let x = 0; x <= w; x += 8) {
      const y = h * 0.5 + Math.sin((x / w) * 5.2 + i * 0.85) * h * (0.06 + i * 0.035);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const outline = outlineFor(track?.id, game, track);
  if (outline) {
    const fit = fitOutline(outline, w, h, { pad: Math.max(12, w * 0.09) });
    drawRibbon(ctx, fit, {
      width: Math.max(3.4, w * 0.020),
      casing: 'rgba(2,5,10,0.85)',
      core: outline.real ? hex(colors[2] ?? 0x54dcff) : 'rgba(120,150,195,0.35)',
      centre: 'rgba(255,255,255,0.30)',
      dash: [3, 5],
      glow: outline.real ? withAlpha(hex(colors[2] ?? 0x54dcff), 0.45) : null,
    });
    // Start marker at the first sample.
    ctx.fillStyle = C.amber;
    ctx.beginPath();
    ctx.arc(fit.sx[0], fit.sx[1], Math.max(2.6, w * 0.012), 0, Math.PI * 2);
    ctx.fill();

    // Be honest: a track we have never built only has a stylised layout.
    if (!outline.real) {
      drawDisplay(ctx, 'LAYOUT REVEALED AFTER YOUR FIRST RACE', w * 0.5, h - 7, {
        size: Math.max(6.5, h * 0.052), tracking: 0.20, weight: 0.20,
        align: 'center', fill: 'rgba(160,185,225,0.42)',
      });
    }
  }

  // Record badge
  const rec = ui?.settings?.recordFor?.(track?.id);
  if (rec && Number.isFinite(rec.bestLap)) {
    const txt = formatTime(rec.bestLap);
    const pad = 6;
    const size = Math.max(8, h * 0.075);
    ctx.fillStyle = 'rgba(4,8,15,0.72)';
    const tw = txt.length * size * 0.6 + pad * 2;
    ctx.fillRect(w - tw - 6, 6, tw, size * 1.7);
    drawDisplay(ctx, txt, w - 6 - pad, 6 + size * 1.2, {
      size, tracking: 0.04, weight: 0.17, align: 'right', fill: C.magenta,
    });
  }

  // Vignette
  const v = ctx.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.2, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

function diffMeter(difficulty) {
  const rank = DIFFICULTY_RANK[String(difficulty ?? 'easy').toLowerCase()] ?? 1;
  const wrap = el('.diff', { title: String(difficulty ?? '').toUpperCase() });
  for (let i = 0; i < 5; i++) wrap.appendChild(el(`i${i < rank ? '.on' : ''}`));
  return wrap;
}

function safeList(game) {
  try {
    const list = game?.trackSystem?.listTracks?.();
    if (Array.isArray(list) && list.length) return list.slice();
  } catch { /* noop */ }
  return [{ id: 'toy_museum', name: 'Toy Museum', difficulty: 'easy', laps: 3, theme: 'indoor', description: '' }];
}

export default TrackSelect;
