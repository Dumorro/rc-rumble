/**
 * RC RUMBLE — the in-race HUD.
 *
 * Laid out for readability at 9 m/s on a 1:10 track, where your eyes are on the
 * centre of the screen and everything else has to be readable in peripheral
 * vision:
 *
 *   top-left      position + live standings ladder with gaps
 *   top-right     lap counter, current / last / best lap, split delta
 *   bottom-left   spline minimap with car dots and checkpoint markers
 *   bottom-right  analogue speedometer (needle, gear window, nitro bar)
 *   bottom-centre pickup slot with the rolling reel and a fire prompt
 *   centre        countdown, banners, toasts, wrong-way, effect vignettes
 *
 * Everything reads from `game.race.getHud()`, `game.race.getLadder()` and the
 * `Car` contract, and every read is optional-chained: with no race system, no
 * track and no cars the HUD simply shows nothing and never throws.
 */

import { el, clear, setText, setClass, setStyle, formatTime, formatDelta, ordinalParts, clamp, clamp01 } from '../Dom.js';
import { THEME, withAlpha, fitCanvas, drawDisplay, measureDisplay, setDisplayText, displayTextCanvas } from '../Theme.js';
import { Speedometer } from './Speedo.js';
import { Minimap } from './Minimap.js';
import { PickupSlot } from './PickupSlot.js';
import { colorFor } from './WeaponIcons.js';

const C = THEME.color;
const MAX_LADDER = 8;

export class HUD {
  /** @param {import('../UISystem.js').UISystem} ui */
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.root = null;
    this.visible = false;
    this._built = false;
    this._unsub = [];

    this.speedo = new Speedometer();
    this.minimap = new Minimap();
    this.pickup = new PickupSlot();

    // ── live state ──
    this._place = 0;
    this._placeShown = -1;
    this._lap = -1;
    this._laps = -1;
    this._toasts = [];
    this._countdownN = null;
    this._countTimer = 0;
    this._wrongWay = false;
    this._deltaTimer = 0;
    this._curSplits = [];
    this._bestSplits = null;
    this._lapCount = 0;
    this._finishShown = false;
    this._ladderRows = [];
    this._displaySpeedScale = 13.333;
    this._maxKmh = 140;
    this._vw = 1280;
    this._vh = 720;
  }

  // ═══════════════════════════════════════════════════════════════ build

  mount(parent) {
    if (this.root) return this.root;
    this.root = this._build();
    parent.appendChild(this.root);
    this._wire();
    this.layout();
    this.setVisible(false);
    return this.root;
  }

  unmount() {
    for (const f of this._unsub) { try { f(); } catch { /* noop */ } }
    this._unsub.length = 0;
    this.root?.remove();
    this.root = null;
    this._built = false;
  }

  _build() {
    const root = el('.rcr-hud.is-hidden');

    // ── effect vignettes (behind everything) ──
    this.vig = {
      boost: el('.hud-vig.boost'),
      frozen: el('.hud-vig.frozen'),
      electro: el('.hud-vig.electro'),
      oiled: el('.hud-vig.oiled'),
      soaked: el('.hud-vig.soaked'),
      damage: el('.hud-vig.damage'),
    };
    this.blind = el('.hud-blind');
    root.append(this.vig.boost, this.vig.frozen, this.vig.electro,
      this.vig.oiled, this.vig.soaked, this.vig.damage, this.blind);

    // ── top-left: position + ladder ──
    // The place, its ordinal suffix and the field size share one canvas so the
    // three sit on exactly one baseline at any size — DOM baseline alignment
    // against a padded canvas never quite lands.
    this.placeCanvas = document.createElement('canvas');
    this.placeCanvas.className = 'hud-place';
    this.posBlock = el('.hud-pos', null, this.placeCanvas);
    this.ladder = el('.hud-ladder');
    root.appendChild(el('.corner.tl', null, this.posBlock, this.ladder));

    // ── top-right: laps + times ──
    this.lapCanvas = displayTextCanvas('LAP 1/3', {
      size: 22, tracking: 0.14, weight: 0.16, slant: 0.12,
      fill: C.ink, glow: withAlpha(C.cyan, 0.35), glowBlur: 14, pad: 8,
    });
    this.timeCur = el('span.v');
    this.timeLast = el('span.v');
    this.timeBest = el('span.v.best');
    this.timeTotal = el('span.v');
    const times = el('.hud-card', null,
      el('.hud-times', null,
        el('span.k', { text: 'Lap' }), this.timeCur,
        el('span.k', { text: 'Last' }), this.timeLast,
        el('span.k', { text: 'Best' }), this.timeBest,
        el('span.k', { text: 'Race' }), this.timeTotal,
      ));
    this.delta = el('.hud-delta');
    root.appendChild(el('.corner.tr', null, this.lapCanvas, times, this.delta));

    // ── bottom-left: minimap ──
    this.minimapWrap = el('.hud-minimap-wrap', {
      style: { position: 'relative', display: 'flex', flexDirection: 'column', gap: '4px' },
    }, this.minimap.canvas);
    root.appendChild(el('.corner.bl', null, this.minimapWrap));

    // ── bottom-right: speedo ──
    root.appendChild(el('.corner.br', null, this.speedo.canvas));

    // ── bottom-centre: pickup ──
    this.pickupWrap = el('.hud-pickup-wrap', {
      style: {
        position: 'absolute', left: '50%', bottom: 'calc(var(--safe-b) + 12px)',
        transform: 'translateX(-50%)', display: 'flex', justifyContent: 'center',
        pointerEvents: 'none',
      },
    }, this.pickup.canvas);
    root.appendChild(this.pickupWrap);

    // ── centre overlays ──
    this.countWrap = el('.hud-count');
    this.countCanvas = displayTextCanvas('3', {
      size: 150, tracking: 0.02, weight: 0.14, slant: 0.14,
      fill: '#ffffff', glow: withAlpha(C.cyan, 0.8), glowBlur: 60, pad: 34,
    });
    this.countWrap.appendChild(this.countCanvas);
    this.countWrap.style.display = 'none';
    root.appendChild(this.countWrap);

    this.bannerWrap = el('.hud-banner');
    this.bannerWrap.style.display = 'none';
    root.appendChild(this.bannerWrap);

    this.toastWrap = el('.hud-toasts');
    root.appendChild(this.toastWrap);

    this.wrongWayEl = el('.hud-wrongway', null,
      displayTextCanvas('WRONG WAY', {
        size: 44, tracking: 0.14, weight: 0.16, slant: 0.14,
        fill: '#ff5a4a', outline: 'rgba(20,0,4,0.9)', glow: 'rgba(255,60,60,0.7)', glowBlur: 34,
      }),
      el('div', {
        style: {
          fontSize: '11px', letterSpacing: '.34em', color: '#ffb0a8',
          textTransform: 'uppercase', textAlign: 'center',
        },
        text: 'Turn around',
      }));
    root.appendChild(this.wrongWayEl);

    this.finishWrap = el('.hud-finish');
    this.finishFlag = document.createElement('canvas');
    this.finishFlag.className = 'flag';
    this.finishWrap.appendChild(this.finishFlag);
    this.finishText = el('div', {
      style: { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' },
    });
    this.finishWrap.appendChild(this.finishText);
    root.appendChild(this.finishWrap);

    this._built = true;
    return root;
  }

  // ═══════════════════════════════════════════════════════════════ events

  _wire() {
    const bus = this.game?.bus;
    if (!bus) return;
    const sub = (name, fn) => this._unsub.push(bus.on(name, fn));
    const isPlayer = (id) => id != null && id === this.game?.playerCar?.id;

    sub('race:countdown', (e) => {
      const n = e?.n;
      if (n == null) return;
      this._showCountdown(n);
    });

    sub('race:finalLap', (e) => {
      if (!isPlayer(e?.carId)) return;
      this.banner('FINAL LAP', 'Everything on the line');
      this.ui.sound('ui/whoosh', 0.8);
    });

    sub('race:lap', (e) => {
      if (!isPlayer(e?.carId)) return;
      this._lapCount++;
      const lt = e.lapTime ?? 0;
      const improved = Number.isFinite(lt) && lt > 0 && (this._prevBest == null || lt < this._prevBest);
      if (improved) {
        this._prevBest = lt;
        this._bestSplits = this._curSplits.slice();
        if (this._lapCount > 1) this.toast(`NEW BEST LAP  ${formatTime(lt)}`, 'good', 2.6);
      }
      this._curSplits.length = 0;
    });

    sub('race:lapRecord', (e) => {
      if (!isPlayer(e?.carId)) return;
      this.toast('SESSION RECORD', 'info', 2.4);
    });

    sub('race:checkpoint', (e) => {
      if (!isPlayer(e?.carId)) return;
      const hud = this.game?.race?.getHud?.();
      const t = hud?.lapTime ?? 0;
      const i = this._curSplits.length;
      this._curSplits.push(t);
      const ref = this._bestSplits?.[i];
      if (Number.isFinite(ref) && this._lapCount > 0) this._showDelta(t - ref);
    });

    sub('race:wrongway', (e) => {
      if (!isPlayer(e?.carId)) return;
      this._wrongWay = !!e.active;
      setClass(this.wrongWayEl, 'show', this._wrongWay);
      if (this._wrongWay) this.ui.sound('ui/error', 0.5);
    });

    sub('race:finish', (e) => {
      if (!isPlayer(e?.carId)) return;
      this._showFinish(e.place ?? 0);
    });

    sub('race:position', (e) => {
      if (!isPlayer(e?.carId)) return;
      const prev = e.prevPlace ?? 0;
      const now = e.place ?? 0;
      if (!prev || !now || prev === now) return;
      setClass(this.posBlock, 'gain', now < prev);
      setClass(this.posBlock, 'loss', now > prev);
      clearTimeout(this._rankTimer);
      this._rankTimer = setTimeout(() => {
        setClass(this.posBlock, 'gain', false);
        setClass(this.posBlock, 'loss', false);
      }, 620);
      if (now < prev) this.toast(`OVERTAKE  P${now}`, 'good', 1.5);
    });

    sub('pickup:collected', (e) => {
      if (!isPlayer(e?.carId)) return;
      this._pickupFlash = 1;
    });

    sub('pickup:assigned', (e) => {
      if (!isPlayer(e?.carId)) return;
      this.toast(String(e.weaponId ?? '').toUpperCase().replace(/_/g, ' '), 'info', 1.3);
    });

    sub('weapon:hit', (e) => {
      if (isPlayer(e?.carId)) {
        this.toast(hitText(e.weaponId), 'bad', 1.8);
        this._damageFlash = 1;
      } else if (isPlayer(e?.sourceId)) {
        this.toast('DIRECT HIT!', 'good', 1.5);
      }
    });

    sub('weapon:blocked', (e) => {
      if (!isPlayer(e?.carId)) return;
      this.toast('SHIELD HELD!', 'info', 1.6);
    });

    sub('bomb:attach', (e) => {
      if (isPlayer(e?.carId ?? e?.targetId)) this.toast('BOMB ON BOARD!', 'bad', 2.2);
    });
    sub('bomb:transfer', (e) => {
      if (isPlayer(e?.fromId)) this.toast('BOMB PASSED!', 'good', 2.0);
      else if (isPlayer(e?.toId ?? e?.carId)) this.toast('BOMB PASSED TO YOU!', 'bad', 2.0);
    });
    sub('bomb:explode', (e) => {
      if (isPlayer(e?.carId)) this.toast('BOOM', 'bad', 1.6);
    });

    sub('car:respawn', (e) => {
      if (!isPlayer(e?.carId)) return;
      this._curSplits.length = 0;
      this._deltaTimer = 0;
      setClass(this.delta, 'show', false);
    });
  }

  // ═══════════════════════════════════════════════════════════ lifecycle

  onRaceStart(ctx) {
    const track = ctx?.track ?? this.game?.track ?? null;
    this.minimap.setTrack(track);
    this._place = 0;
    this._placeShown = -1;
    this._lap = -1;
    this._laps = -1;
    this._prevBest = null;
    this._bestSplits = null;
    this._curSplits.length = 0;
    this._lapCount = 0;
    this._finishShown = false;
    this._wrongWay = false;
    this._damageFlash = 0;
    this._pickupFlash = 0;
    setClass(this.wrongWayEl, 'show', false);
    setClass(this.finishWrap, 'show', false);
    this.bannerWrap.style.display = 'none';
    clear(this.toastWrap);
    this._toasts.length = 0;

    const def = this.game?.playerCar?.def;
    this._displaySpeedScale = this.game?.carSystem?.displaySpeedScale ?? 13.333;
    this._maxKmh = (def?.topSpeed ?? 9) * this._displaySpeedScale;
    this.speedo.setMaxSpeed(this._maxKmh);
    this.pickup.fireKeyLabel = this.ui.fireKeyLabel();
    this._buildLadder(ctx?.cars ?? this.game?.cars ?? []);
    this.layout();
  }

  onRaceEnd() {
    this.minimap.clear();
    clear(this.toastWrap);
    this._toasts.length = 0;
    setClass(this.wrongWayEl, 'show', false);
    setClass(this.finishWrap, 'show', false);
    this.countWrap.style.display = 'none';
  }

  setVisible(v) {
    this.visible = !!v;
    setClass(this.root, 'is-hidden', !v);
  }

  // ═══════════════════════════════════════════════════════════════ layout

  layout(w = window.innerWidth, h = window.innerHeight) {
    this._vw = w; this._vh = h;
    if (!this.root) return;
    const m = Math.min(w, h);
    const compact = w < 700 || h < 480;

    const speedoSize = clamp(m * (compact ? 0.30 : 0.245), 96, 208);
    this.speedo.resize(speedoSize);

    const mapW = clamp(w * (compact ? 0.30 : 0.165), 104, 236);
    this.minimap.resize(mapW, mapW * 0.70);

    const pickSize = clamp(m * (compact ? 0.155 : 0.115), 58, 100);
    this.pickup.resize(pickSize);

    this._placeSize = clamp(m * 0.088, 32, 68);
    this._drawPlace();
    setDisplayText(this.lapCanvas, this._lapText(), {
      size: clamp(m * 0.030, 15, 24), tracking: 0.14, weight: 0.16, slant: 0.12,
      fill: C.ink, glow: withAlpha(C.cyan, 0.35), glowBlur: 14, pad: 8,
    });
    setDisplayText(this.countCanvas, this.countCanvas._rcrText?.text ?? '3', {
      ...(this.countCanvas._rcrText?.opts ?? {}),
      size: clamp(m * 0.24, 78, 190),
    });

    // Hide the ladder / minimap when the player asked for a bare HUD.
    setClass(this.ladder, 'hidden', !this.ui.settings.get('showLadder'));
    setClass(this.minimapWrap, 'hidden', !this.ui.settings.get('showMinimap'));
  }

  // ═══════════════════════════════════════════════════════════════ frame

  /** @param {number} rawDt real seconds — never scaled by pause or slow-mo. */
  update(rawDt) {
    if (!this.root || !this.visible) return;
    const game = this.game;
    const race = game?.race;
    const hud = race?.getHud?.() ?? null;
    const car = game?.playerCar ?? null;

    this._updateToasts(rawDt);
    this._updateCountdown(rawDt);

    // ── speedo ──
    const kmh = car ? (car.speedKmh ?? Math.abs(car.speed ?? 0) * this._displaySpeedScale) : 0;
    const def = car?.def;
    const rpm01 = def?.limiterRpm ? clamp01((car?.rpm ?? 0) / def.limiterRpm)
      : clamp01((car?.rpm ?? 0) / 16000);
    const boost01 = car ? clamp01((car.effects?.boost ?? 0) / 2.4) : 0;
    this.speedo.draw({
      kmh,
      rpm01,
      gear: car?.gear ?? 0,
      boost01,
      limiter: rpm01 > 0.985,
      drift01: car?.driftFactor ?? 0,
    }, rawDt);

    // ── minimap ──
    if (this.ui.settings.get('showMinimap')) {
      this.minimap.draw(game?.cars, car, rawDt);
    }

    // ── pickup ──
    this.pickup.draw(car?.weapon ?? null, rawDt);

    if (!hud) return;

    // ── position ──
    if (hud.place !== this._place || hud.carCount !== this._carCount) {
      this._place = hud.place;
      this._carCount = hud.carCount;
      this._drawPlace();
    }

    // ── laps ──
    if (hud.lap !== this._lap || hud.laps !== this._laps) {
      this._lap = hud.lap;
      this._laps = hud.laps;
      setDisplayText(this.lapCanvas, this._lapText(), {
        ...(this.lapCanvas._rcrText?.opts ?? {}),
        fill: hud.finalLap ? C.amber : C.ink,
        glow: withAlpha(hud.finalLap ? C.amber : C.cyan, 0.4),
      });
    }

    // ── times ──
    setText(this.timeCur, formatTime(hud.lapTime, { forceMinutes: false }));
    setText(this.timeLast, hud.lastLap > 0 ? formatTime(hud.lastLap) : '--.---');
    setText(this.timeBest, Number.isFinite(hud.bestLap) ? formatTime(hud.bestLap) : '--.---');
    setText(this.timeTotal, formatTime(hud.raceTime, { forceMinutes: true }));

    // ── ladder ──
    this._updateLadder(race, car);

    // ── vignettes ──
    this._updateEffects(car, rawDt);
  }

  // ─────────────────────────────────────────────────────────── sub-updates

  /** Big place numeral + ordinal suffix + field size, all on one baseline. */
  _drawPlace() {
    const size = this._placeSize || 52;
    const p = ordinalParts(this._place || 1);
    const total = this._carCount || this.game?.cars?.length || 8;

    const sufSize = size * 0.30;
    const totSize = size * 0.22;
    const numW = measureDisplay(p.num, size, 0.02);
    const sufW = measureDisplay(p.suf, sufSize, 0.10);
    const totTxt = `/${total}`;
    const totW = measureDisplay(totTxt, totSize, 0.16);

    const pad = Math.ceil(size * 0.26);
    const gap = size * 0.09;
    const w = Math.ceil(pad * 2 + numW + gap + sufW + gap * 1.8 + totW);
    const h = Math.ceil(size * 1.14 + pad * 1.4);
    this.placeCanvas.style.width = `${w}px`;
    this.placeCanvas.style.height = `${h}px`;
    const ctx = fitCanvas(this.placeCanvas, w, h);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const baseline = h - pad * 0.9;
    let x = pad;
    const hot = (this._place || 9) <= 3;
    x += drawDisplay(ctx, p.num, x, baseline, {
      size, tracking: 0.02, weight: 0.15, slant: 0.16,
      fill: '#ffffff',
      glow: withAlpha(hot ? C.amber : C.cyan, 0.55),
      glowBlur: size * 0.42,
    });
    x += gap;
    x += drawDisplay(ctx, p.suf, x, baseline, {
      size: sufSize, tracking: 0.10, weight: 0.19, slant: 0.16,
      fill: hot ? C.amber : C.cyan,
    });
    x += gap * 1.8;
    drawDisplay(ctx, totTxt, x, baseline, {
      size: totSize, tracking: 0.16, weight: 0.20, slant: 0.16,
      fill: withAlpha(C.inkFaint, 0.85),
    });
  }

  _lapText() {
    const l = this._lap > 0 ? this._lap : 1;
    const n = this._laps > 0 ? this._laps : 3;
    return `LAP ${l}/${n}`;
  }

  _buildLadder(cars) {
    clear(this.ladder);
    this._ladderRows = [];
    const n = Math.min(cars?.length ?? 0, MAX_LADDER);
    for (let i = 0; i < n; i++) {
      const swatch = el('i.swatch');
      const nm = el('span.nm', null, swatch, el('span', { text: '—' }));
      const row = {
        el: el('.hud-row', null, el('span.n', { text: String(i + 1) }), nm, el('span.gp', { text: '—' })),
        num: null, name: nm.lastChild, gap: null, swatch,
      };
      row.num = row.el.firstChild;
      row.gap = row.el.lastChild;
      this._ladderRows.push(row);
      this.ladder.appendChild(row.el);
    }
  }

  _updateLadder(race, player) {
    if (!race?.getLadder || !this._ladderRows.length) return;
    if (!this.ui.settings.get('showLadder')) return;
    let list;
    try { list = race.getLadder(); } catch { return; }
    if (!list) return;
    const n = this._ladderRows.length;
    for (let i = 0; i < n; i++) {
      const row = this._ladderRows[i];
      const e = list[i];
      if (!e) { setClass(row.el, 'hidden', true); continue; }
      setClass(row.el, 'hidden', false);
      const car = e.car ?? e;
      const isMe = player && car?.id === player.id;
      setClass(row.el, 'me', !!isMe);
      setText(row.num, String(i + 1));
      setText(row.name, shortName(e.name ?? car?.def?.name ?? `CAR ${i + 1}`));
      const col = liveryHex(car);
      setStyle(row.swatch, 'background', col);
      // Gap: interval to the car ahead, or the leader's own lap tag.
      let gapTxt = '—';
      if (i === 0) {
        gapTxt = e.dnf ? 'DNF' : 'LEAD';
      } else {
        const prev = list[i - 1];
        const lapDiff = (prev?.lap ?? 0) - (e.lap ?? 0);
        if (e.dnf) gapTxt = 'DNF';
        else if (lapDiff > 0) gapTxt = `+${lapDiff}L`;
        else {
          const g = safeGap(race, car);
          gapTxt = Number.isFinite(g) && g > 0.001 ? `+${g.toFixed(g < 10 ? 2 : 1)}` : '—';
        }
      }
      setText(row.gap, gapTxt);
    }
  }

  _updateEffects(car, rawDt) {
    const v = car?.effectVisual ?? null;
    const e = car?.effects ?? null;
    const g = (visualKey, timerKey, scale = 1) => {
      const a = v?.[visualKey];
      if (Number.isFinite(a)) return clamp01(a * scale);
      const t = e?.[timerKey];
      return Number.isFinite(t) ? clamp01(t * 0.8 * scale) : 0;
    };
    setStyle(this.vig.boost, 'opacity', String(g('boost', 'boost', 0.85).toFixed(2)));
    setStyle(this.vig.frozen, 'opacity', String(g('frost', 'frozen').toFixed(2)));
    setStyle(this.vig.electro, 'opacity', String(g('spark', 'electro').toFixed(2)));
    setStyle(this.vig.oiled, 'opacity', String(g('squash', 'oiled', 0.7).toFixed(2)));
    setStyle(this.vig.soaked, 'opacity', String(g('soak', 'soaked', 0.85).toFixed(2)));
    setStyle(this.blind, 'opacity', String(g('blind', 'blinded').toFixed(2)));

    this._damageFlash = Math.max(0, (this._damageFlash ?? 0) - rawDt * 1.9);
    setStyle(this.vig.damage, 'opacity', (this._damageFlash * 0.85).toFixed(2));
  }

  // ─────────────────────────────────────────────────────────── countdown

  _showCountdown(n) {
    const txt = n <= 0 ? 'GO!' : String(n);
    const size = clamp(Math.min(this._vw, this._vh) * (n <= 0 ? 0.28 : 0.24), 80, 220);
    setDisplayText(this.countCanvas, txt, {
      size, tracking: n <= 0 ? 0.08 : 0.02, weight: 0.14, slant: 0.14, pad: size * 0.3,
      fill: n <= 0 ? '#eaffe9' : '#ffffff',
      glow: n <= 0 ? 'rgba(70,255,150,0.85)' : withAlpha(C.cyan, 0.8),
      glowBlur: size * 0.4,
    });
    this.countWrap.style.display = 'flex';
    this.countWrap.classList.remove('punch');
    void this.countWrap.offsetWidth;
    this.countWrap.classList.add('punch');
    this._countTimer = n <= 0 ? 0.9 : 0.95;
  }

  _updateCountdown(rawDt) {
    if (this._countTimer <= 0) return;
    this._countTimer -= rawDt;
    if (this._countTimer <= 0) {
      this.countWrap.style.display = 'none';
      this.countWrap.classList.remove('punch');
    }
  }

  // ─────────────────────────────────────────────────────────────── delta

  _showDelta(seconds) {
    if (!Number.isFinite(seconds)) return;
    const up = seconds < 0;
    setText(this.delta, formatDelta(seconds));
    setClass(this.delta, 'up', up);
    setClass(this.delta, 'down', !up);
    setClass(this.delta, 'show', true);
    this._deltaTimer = 3.0;
    clearTimeout(this._deltaHide);
    this._deltaHide = setTimeout(() => setClass(this.delta, 'show', false), 3000);
  }

  // ─────────────────────────────────────────────────────────── toasts

  /** @param {string} text @param {'info'|'good'|'bad'|'warn'} kind @param {number} secs */
  toast(text, kind = 'info', secs = 2.0) {
    if (!this.toastWrap || !text) return;
    // Collapse an identical toast that is already on screen.
    for (const t of this._toasts) {
      if (t.text === text) { t.life = secs; return; }
    }
    const node = el(`.hud-toast.${kind}.in-start`, { text });
    this.toastWrap.appendChild(node);
    // One reflow, then drop the start class so the transition actually runs.
    void node.offsetWidth;
    node.classList.remove('in-start');
    this._toasts.push({ node, life: secs, text });
    while (this._toasts.length > 4) {
      const dead = this._toasts.shift();
      dead.node.remove();
    }
  }

  _updateToasts(rawDt) {
    for (let i = this._toasts.length - 1; i >= 0; i--) {
      const t = this._toasts[i];
      t.life -= rawDt;
      if (t.life <= 0) {
        if (!t.out) {
          t.out = true;
          t.node.classList.add('out');
          t.life = 0.34;
        } else {
          t.node.remove();
          this._toasts.splice(i, 1);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────── banner

  banner(title, sub = '') {
    if (!this.bannerWrap) return;
    clear(this.bannerWrap);
    const size = clamp(Math.min(this._vw, this._vh) * 0.062, 22, 52);
    this.bannerWrap.appendChild(el('.bar', null,
      displayTextCanvas(title, {
        size, tracking: 0.16, weight: 0.15, slant: 0.14,
        fill: '#fff3e0', glow: withAlpha(C.amberHot, 0.75), glowBlur: size * 0.8,
      })));
    if (sub) {
      this.bannerWrap.appendChild(el('div', {
        style: { fontSize: '10px', letterSpacing: '.34em', color: C.amber, textTransform: 'uppercase' },
        text: sub,
      }));
    }
    this.bannerWrap.style.display = 'flex';
    this.bannerWrap.classList.remove('enter');
    void this.bannerWrap.offsetWidth;
    this.bannerWrap.classList.add('enter');
    clearTimeout(this._bannerTimer);
    clearTimeout(this._bannerHide);
    this._bannerTimer = setTimeout(() => this.bannerWrap.classList.remove('enter'), 2900);
    this._bannerHide = setTimeout(() => { this.bannerWrap.style.display = 'none'; }, 3300);
  }

  // ─────────────────────────────────────────────────────────── finish

  _showFinish(place) {
    if (this._finishShown) return;
    this._finishShown = true;

    const w = this._vw, h = this._vh;
    const ctx = fitCanvas(this.finishFlag, w, h);
    if (ctx) {
      ctx.clearRect(0, 0, w, h);
      // A big waving checker sweep — drawn, not an image.
      const cell = Math.max(24, Math.min(w, h) * 0.07);
      for (let y = 0; y < h + cell; y += cell) {
        for (let x = 0; x < w + cell; x += cell) {
          const on = (((x / cell) | 0) + ((y / cell) | 0)) % 2 === 0;
          const wave = Math.sin((x / w) * 6.0 + (y / h) * 1.6) * cell * 0.22;
          ctx.fillStyle = on ? 'rgba(250,252,255,0.92)' : 'rgba(8,11,18,0.92)';
          ctx.fillRect(x, y + wave, cell + 1, cell + 1);
        }
      }
      const fade = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.1, w * 0.5, h * 0.5, Math.max(w, h) * 0.62);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }

    clear(this.finishText);
    const p = ordinalParts(place || 1);
    const size = clamp(Math.min(w, h) * 0.12, 40, 120);
    this.finishText.appendChild(displayTextCanvas('FINISH', {
      size: size * 0.55, tracking: 0.24, weight: 0.15, slant: 0.14,
      fill: '#ffffff', glow: withAlpha(C.cyan, 0.7), glowBlur: size * 0.5,
    }));
    this.finishText.appendChild(displayTextCanvas(`${p.num}${p.suf}`, {
      size, tracking: 0.06, weight: 0.15, slant: 0.16,
      fill: place === 1 ? C.gold : '#ffffff',
      glow: withAlpha(place === 1 ? C.gold : C.cyan, 0.8), glowBlur: size * 0.6,
    }));
    setClass(this.finishWrap, 'show', true);
    // The results screen takes over shortly; clear the flourish either way.
    clearTimeout(this._finishTimer);
    this._finishTimer = setTimeout(() => setClass(this.finishWrap, 'show', false), 3600);
  }
}

// ═══════════════════════════════════════════════════════════════ helpers

function shortName(name) {
  const s = String(name ?? '').toUpperCase();
  return s.length > 13 ? `${s.slice(0, 12)}…` : s;
}

function liveryHex(car) {
  const n = car?.colorPrimary ?? car?.def?.colorPrimary;
  if (typeof n === 'number') return `#${(n >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
  return C.rival;
}

function safeGap(race, car) {
  try { return race?.standings?.intervalAhead?.(car) ?? NaN; }
  catch { return NaN; }
}

function hitText(weaponId) {
  switch (weaponId) {
    case 'firework': return 'HIT BY FIREWORK';
    case 'bomb': return 'BOMB WENT OFF';
    case 'electro': return 'ELECTRO-PULSED';
    case 'balloon': return 'SOAKED';
    case 'ball': return 'BALL BEARING HIT';
    case 'oil': return 'OIL SLICK';
    case 'shockwave': return 'SHOCKWAVE';
    default: return 'HIT';
  }
}

export { colorFor };
export default HUD;
