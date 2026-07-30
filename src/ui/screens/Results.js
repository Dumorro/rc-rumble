/**
 * RC RUMBLE — results.
 *
 * Final standings with staggered row entry, the player's lap-by-lap breakdown,
 * a "new record" flourish when a personal best falls, championship points when
 * a season is running, and continue / retry.
 *
 * Everything comes from the `race:end` payload (`results` in `RaceSystem`), so
 * this screen is a pure view — it never recomputes a placing.
 */

import { el, clear, setText, setClass, formatTime, formatGap, ordinalParts, ordinal } from '../Dom.js';
import { THEME, withAlpha, displayTextCanvas, setDisplayText } from '../Theme.js';
import { Screen, MenuList } from '../Screen.js';

const C = THEME.color;

/** Classic points ladder, 1st → 8th. */
export const POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

export class Results extends Screen {
  static id = 'results';

  constructor(ui, props) {
    super(ui, props);
    this.hidesHud = true;
    this.results = props.results ?? null;
    this.records = props.records ?? null;
    this.championship = props.championship ?? null;
  }

  build() {
    const root = el('.rcr-screen');
    root.appendChild(el('.rcr-scrim.heavy'));
    root.appendChild(el('.rcr-grid-fade'));

    const r = this.results;
    const player = r?.playerEntry ?? null;
    const place = player?.place ?? 0;
    const won = place === 1;
    const dnf = !!player?.dnf;

    // ── headline ──
    const p = ordinalParts(place || 1);
    const headline = dnf ? 'DID NOT FINISH' : (won ? 'VICTORY' : `${p.num}${p.suf} PLACE`);
    this.headline = displayTextCanvas(headline, {
      size: 64, tracking: 0.10, weight: 0.14, slant: 0.15,
      fill: won ? C.gold : '#ffffff',
      glow: withAlpha(won ? C.gold : C.cyan, 0.7), glowBlur: 40,
    });

    const head = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
      el('.rcr-eyebrow', { text: `${r?.trackName ?? 'Race'} · ${r?.laps ?? 0} laps · ${r?.carCount ?? 0} cars` }),
      this.headline);

    // ── record flourish ──
    this.recordWrap = el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } });
    const rec = this.records;
    if (rec?.lapRecord) this.recordWrap.appendChild(el('.res-record', { text: '★ New Best Lap' }));
    if (rec?.raceRecord) this.recordWrap.appendChild(el('.res-record', { text: '★ New Race Record' }));

    // ── standings ──
    this.grid = el('.res-grid');
    this._buildRows();

    // ── player detail ──
    this.detail = el('.rcr-panel', {
      style: { padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '240px' },
    });
    this._buildDetail();

    // ── actions ──
    const isChampionship = !!this.championship;
    const more = isChampionship && this.championship.index < this.championship.tracks.length - 1;
    this.menu = new MenuList(this, [
      more
        ? { label: 'Next Round', hint: this.championship.tracks[this.championship.index + 1]?.name ?? '', onSelect: () => this.ui.championshipNext() }
        : { label: 'Continue', hint: isChampionship ? 'Season complete' : 'Back to the menu', onSelect: () => this.ui.quitToMenu() },
      { label: 'Retry', hint: 'Same car, same track', onSelect: () => this.ui.restartRace() },
      !isChampionship && { label: 'Change Car', onSelect: () => this.ui.quitToMenu('car') },
      !isChampionship && { label: 'Change Track', onSelect: () => this.ui.quitToMenu('track') },
    ].filter(Boolean));

    root.appendChild(el('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        gap: '14px', padding: 'clamp(18px, 4vw, 56px)', overflow: 'hidden',
      },
    },
    head,
    this.recordWrap,
    el('div', {
      style: { display: 'flex', gap: '16px', flex: '1 1 auto', minHeight: '0', flexWrap: 'wrap' },
    },
    el('div', {
      style: { flex: '2 1 420px', overflowY: 'auto', minHeight: '0', paddingRight: '4px' },
    }, this.grid),
    el('div', { style: { flex: '1 1 240px', display: 'flex', flexDirection: 'column', gap: '12px' } },
      this.detail,
      el('.rcr-panel', { style: { padding: '8px' } }, this.menu.el))),
    this.legend([['↑↓', 'Navigate'], ['↵', 'Select']])));

    return root;
  }

  _buildRows() {
    clear(this.grid);
    const entries = this.results?.entries ?? [];
    const champ = this.championship;
    // Header row
    this.grid.appendChild(el('div', {
      style: {
        display: 'grid', gridTemplateColumns: '46px 1fr 92px 92px', gap: '10px',
        padding: '0 14px 4px', fontSize: '9px', letterSpacing: '.28em',
        textTransform: 'uppercase', color: C.inkFaint,
      },
    },
    el('span', { style: { textAlign: 'right' }, text: 'Pos' }),
    el('span', { text: 'Driver' }),
    el('span', { style: { textAlign: 'right' }, text: champ ? 'Points' : 'Total' }),
    el('span', { style: { textAlign: 'right' }, text: 'Best lap' })));

    const winner = entries[0];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const cls = ['res-row'];
      if (e.isPlayer) cls.push('me');
      if (e.place <= 3) cls.push(`p${e.place}`);
      if (e.dnf || !e.finished) cls.push('dnf');
      const totalTxt = e.dnf ? 'DNF'
        : (i === 0 ? formatTime(e.totalTime, { forceMinutes: true })
          : (e.finished && winner?.finished ? formatGap(e.totalTime - winner.totalTime) : `+${(e.laps ?? 0)}L`));
      const pointsTxt = champ ? String(POINTS[e.place - 1] ?? 0) : totalTxt;
      const bestTxt = Number.isFinite(e.bestLap) ? formatTime(e.bestLap) : '--.---';
      const isFastest = Number.isFinite(e.bestLap)
        && e.bestLap === (this.results?.bestLapOverall?.time ?? -1);

      const row = el(cls.join('.').replace(/^/, '.'), {
        style: { animationDelay: `${Math.min(i * 55, 600)}ms` },
      },
      el('span.pl', { text: String(e.place) }),
      el('span', null,
        el('div.nm', { text: String(e.name ?? '—').toUpperCase() }),
        el('div.cr', { text: `${e.carName ?? ''}${e.respawns ? ` · ${e.respawns} resets` : ''}` })),
      el('span.tt', { text: pointsTxt }),
      el(`span.bl${isFastest ? '.rec' : ''}`, { text: bestTxt }));
      this.grid.appendChild(row);
    }

    if (champ) this._buildChampionshipTable();
  }

  _buildChampionshipTable() {
    const champ = this.championship;
    const totals = champ.points ?? {};
    const rows = Object.keys(totals)
      .map(k => ({ name: k, pts: totals[k], isPlayer: k === champ.playerName }))
      .sort((a, b) => b.pts - a.pts);
    if (!rows.length) return;

    this.grid.appendChild(el('.rcr-rule'));
    this.grid.appendChild(el('div', {
      style: {
        fontSize: '9px', letterSpacing: '.30em', textTransform: 'uppercase',
        color: C.cyan, padding: '2px 14px 6px',
      },
      text: `Season standings · round ${champ.index + 1} of ${champ.tracks.length}`,
    }));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      this.grid.appendChild(el(`.res-row${r.isPlayer ? '.me' : ''}${i < 3 ? `.p${i + 1}` : ''}`, {
        style: { animationDelay: `${Math.min(400 + i * 45, 900)}ms` },
      },
      el('span.pl', { text: String(i + 1) }),
      el('span.nm', { text: String(r.name).toUpperCase() }),
      el('span.tt', { text: String(r.pts) }),
      el('span.bl', { text: '' })));
    }
  }

  _buildDetail() {
    clear(this.detail);
    const p = this.results?.playerEntry;
    this.detail.appendChild(el('.rcr-eyebrow', { text: 'Your race' }));
    if (!p) {
      this.detail.appendChild(el('div', { style: { fontSize: '12px', color: C.inkDim }, text: 'No data.' }));
      return;
    }
    const rows = [
      ['Position', p.dnf ? 'DNF' : ordinal(p.place)],
      ['Total', formatTime(p.totalTime, { forceMinutes: true })],
      ['Best lap', Number.isFinite(p.bestLap) ? formatTime(p.bestLap) : '--.---'],
      ['Resets', String(p.respawns ?? 0)],
    ];
    const prev = this.records?.prevLap;
    if (Number.isFinite(prev) && Number.isFinite(p.bestLap)) {
      const d = p.bestLap - prev;
      rows.push(['vs record', `${d < 0 ? '-' : '+'}${Math.abs(d).toFixed(3)}`]);
    }
    for (const [k, v] of rows) {
      this.detail.appendChild(el('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: '12px', fontSize: '11px', letterSpacing: '.10em' },
      },
      el('span', { style: { color: C.inkFaint, textTransform: 'uppercase', fontSize: '9.5px', letterSpacing: '.22em' }, text: k }),
      el('span', { style: { fontFamily: THEME.font.mono, color: C.ink }, text: v })));
    }

    const laps = p.lapTimes ?? [];
    if (laps.length) {
      this.detail.appendChild(el('.rcr-rule'));
      this.detail.appendChild(el('.rcr-eyebrow', { text: 'Lap times' }));
      const best = Math.min(...laps);
      const wrap = el('div', {
        style: { display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '30vh', overflowY: 'auto' },
      });
      for (let i = 0; i < laps.length; i++) {
        const isBest = laps[i] === best;
        wrap.appendChild(el('div', {
          style: {
            display: 'flex', justifyContent: 'space-between', gap: '10px',
            fontFamily: THEME.font.mono, fontSize: '11px',
            color: isBest ? C.magenta : C.inkDim,
          },
        },
        el('span', { text: `L${i + 1}` }),
        el('span', { text: formatTime(laps[i]) })));
      }
      this.detail.appendChild(wrap);
    }
  }

  onEnter() {
    this.own(this.ui.onResize(() => {
      setDisplayText(this.headline, this.headline._rcrText?.text ?? '', {
        ...(this.headline._rcrText?.opts ?? {}),
        size: Math.max(28, Math.min(window.innerWidth * 0.062, 72)),
      });
    }));
    setDisplayText(this.headline, this.headline._rcrText?.text ?? '', {
      ...(this.headline._rcrText?.opts ?? {}),
      size: Math.max(28, Math.min(window.innerWidth * 0.062, 72)),
    });
    const won = this.results?.playerWon;
    this.game?.bus?.emit?.('audio:music', { intent: won ? 'victory' : 'menu' });
  }

  onBack() {
    // Deliberately does not close: you must pick an option.
    this.menu?.focus(0, false);
    this.sound('ui/error', 0.4);
    return true;
  }
}

export default Results;
