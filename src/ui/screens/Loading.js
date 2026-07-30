/**
 * RC RUMBLE — loading screen.
 *
 * Track building is synchronous and heavy, so this screen exists mainly to give
 * the browser something to paint before the hitch. `UISystem.startFlow()` mounts
 * it, yields two animation frames so it is definitely on screen, and only then
 * calls `game.loadRace()`.
 *
 * The progress bar is honest about what it can know: it advances through the
 * named phases the UI drives, then pins at 92 % until `race:loaded` lands.
 */

import { el, setText, setStyle, clamp01, formatLength } from '../Dom.js';
import { THEME, withAlpha, displayTextCanvas, setDisplayText, fitCanvas } from '../Theme.js';
import { Screen } from '../Screen.js';
import { outlineFor, fitOutline, drawRibbon, outlineLength } from '../TrackMap.js';

const C = THEME.color;

const TIPS = [
  'Weight transfer is everything. Brake in a straight line, then let the nose settle before you turn.',
  'Handbrake plus throttle rotates the car. Handbrake alone just makes you a passenger.',
  'The car in last place gets the nastiest pickups. Being behind is a weapon.',
  'Shortcuts are always narrower than they look at speed. Commit early or not at all.',
  'A shield absorbs exactly one hit — spend it, do not hoard it.',
  'Landing flat is faster than landing pretty. Level the car in the air with the pitch controls.',
  'Oil is grip 0.10. If you see the rainbow, lift.',
  'Every surface has its own grip: wood 1.00, carpet 0.85, grass 0.60, gravel 0.55, ice 0.18.',
  'The chase camera lags on purpose. Trust the car, not the picture.',
];

export class Loading extends Screen {
  static id = 'loading';

  constructor(ui, props) {
    super(ui, props);
    this.modal = true;
    this.hidesHud = true;
    this.transitionMs = 320;
    this._p = 0;
    this._shown = 0;
    this._t = 0;
  }

  build() {
    const root = el('.rcr-screen', {
      style: { background: 'radial-gradient(120% 100% at 20% 0%, #16233d 0%, #04070d 66%)' },
    });
    root.appendChild(el('.rcr-streaks'));

    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.style.position = 'absolute';
    this.mapCanvas.style.inset = '0';
    this.mapCanvas.style.opacity = '0.30';
    root.appendChild(this.mapCanvas);

    this.title = displayTextCanvas('LOADING', {
      size: 62, tracking: 0.10, weight: 0.14, slant: 0.15,
      fill: '#ffffff', glow: withAlpha(C.cyan, 0.55), glowBlur: 32,
    });
    this.sub = el('div', {
      style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' },
    });
    this.bar = el('i');
    this.msg = el('div', {
      style: {
        display: 'flex', gap: '10px', alignItems: 'center', fontSize: '10px',
        letterSpacing: '.30em', textTransform: 'uppercase', color: C.inkFaint,
      },
    }, el('.load-spin'), el('span', { text: 'preparing' }));
    this.msgText = this.msg.lastChild;
    this.tip = el('.load-tip');

    root.appendChild(el('.load-wrap', null,
      el('.rcr-eyebrow', { text: 'Now entering' }),
      this.title,
      this.sub,
      el('.load-bar', null, this.bar),
      el('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: '20px', alignItems: 'flex-end', flexWrap: 'wrap' },
      }, this.tip, this.msg)));

    return root;
  }

  onEnter() {
    const trackId = this.props.trackId ?? this.ui.flow?.trackId;
    const info = findTrack(this.game, trackId);
    setText(this.tip, TIPS[Math.floor(Math.random() * TIPS.length)]);
    setDisplayText(this.title, String(info?.name ?? 'LOADING').toUpperCase(), {
      ...(this.title._rcrText?.opts ?? {}),
      size: Math.max(30, Math.min(window.innerWidth * 0.062, 74)),
    });

    const outline = outlineFor(trackId, this.game, info);
    this.sub.replaceChildren(
      el('.rcr-chip.amber', { text: String(info?.difficulty ?? 'easy').toUpperCase() }),
      el('.rcr-chip.plain', { text: `${this.ui.flow?.laps ?? info?.laps ?? 3} LAPS` }),
      el('.rcr-chip.plain', {
        text: formatLength(info?.length || (outline?.real ? outlineLength(outline) : 0)),
      }),
      el('.rcr-chip.plain', {
        text: `${(this.ui.flow?.opponents ?? 7) + 1} CARS`,
      }),
    );

    this._outline = outline;
    this.own(this.ui.onResize(() => this._drawMap()));
    this._drawMap();
  }

  _drawMap() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = fitCanvas(this.mapCanvas, w, h);
    if (!ctx || !this._outline) return;
    ctx.clearRect(0, 0, w, h);
    const fit = fitOutline(this._outline, w * 0.72, h * 0.78, { pad: 80 });
    ctx.save();
    ctx.translate(w * 0.26, h * 0.08);
    drawRibbon(ctx, fit, {
      width: Math.max(6, w * 0.006),
      casing: 'rgba(0,0,0,0)',
      core: withAlpha(C.cyan, 0.22),
      centre: withAlpha(C.cyan, 0.30),
      dash: [6, 12],
      glow: withAlpha(C.cyan, 0.20),
    });
    ctx.restore();
  }

  /** @param {number} p 0..1 @param {string} [msg] */
  setProgress(p, msg) {
    this._p = clamp01(p);
    if (msg) setText(this.msgText, msg);
  }

  update(rawDt) {
    this._t += rawDt;
    // Ease toward the reported progress so the bar never jumps.
    this._shown += (this._p - this._shown) * (1 - Math.exp(-6 * Math.min(rawDt, 0.05)));
    setStyle(this.bar, 'width', `${(this._shown * 100).toFixed(1)}%`);
    setStyle(this.mapCanvas, 'transform', `translateY(${(Math.sin(this._t * 0.5) * 6).toFixed(1)}px)`);
  }

  onAction() { return true; }   // swallow everything while loading
  onBack() { return true; }
}

function findTrack(game, id) {
  try {
    const list = game?.trackSystem?.listTracks?.() ?? [];
    return list.find(t => t.id === id) ?? list[0] ?? null;
  } catch { return null; }
}

export default Loading;
