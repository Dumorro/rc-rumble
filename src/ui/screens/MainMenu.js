/**
 * RC RUMBLE — title screen.
 *
 * Sits over the live 3D scene (the camera director's idle orbit keeps running
 * behind it), so the menu is a glass panel and a vignette rather than a page.
 * The wordmark is drawn with the procedural display face and gets a slow
 * chromatic shimmer plus a parallax lean that follows the pointer / stick.
 */

import { el, setText, setStyle } from '../Dom.js';
import { THEME, withAlpha, displayTextCanvas, setDisplayText, fitCanvas, drawDisplay } from '../Theme.js';
import { Screen, MenuList } from '../Screen.js';

const C = THEME.color;

export class MainMenu extends Screen {
  static id = 'main';

  constructor(ui, props) {
    super(ui, props);
    this.modal = true;
    this.hidesHud = true;
    this._t = 0;
    this._px = 0;
    this._py = 0;
    this._tx = 0;
    this._ty = 0;
  }

  build() {
    const root = el('.rcr-screen');
    root.appendChild(el('.rcr-scrim'));
    root.appendChild(el('.rcr-streaks'));

    // ── wordmark ──
    this.title = displayTextCanvas('RC RUMBLE', {
      size: 96, tracking: 0.11, weight: 0.135, slant: 0.16,
      fill: '#ffffff', glow: withAlpha(C.cyan, 0.75), glowBlur: 44, pad: 34,
    });
    this.title.style.maxWidth = '100%';
    this.accent = document.createElement('canvas');
    this.accent.style.display = 'block';

    this.titleWrap = el('.rcr-title-wrap', {
      style: { transition: 'transform .5s cubic-bezier(.16,1,.3,1)' },
    },
    el('.rcr-eyebrow', { text: 'Radio Controlled Mayhem' }),
    this.title,
    this.accent,
    el('.rcr-title-sub', { text: '1:10 scale · full contact' }));

    // ── menu ──
    this.menu = new MenuList(this, [
      {
        label: 'Race', hint: 'Single race',
        onSelect: () => this.ui.beginFlow('single'),
      },
      {
        label: 'Time Trial', hint: 'Alone against the clock',
        onSelect: () => this.ui.beginFlow('timetrial'),
      },
      {
        label: 'Championship', hint: 'Every track, points scored',
        onSelect: () => this.ui.beginFlow('championship'),
      },
      { label: 'Options', hint: 'Video · audio · camera', onSelect: () => this.ui.push('options') },
      { label: 'Controls', hint: 'Keyboard · gamepad', onSelect: () => this.ui.push('controls') },
    ]);

    this.panel = el('.rcr-panel.rcr-ticks', {
      style: { padding: '18px 14px', minWidth: 'min(360px, 84vw)' },
    }, this.menu.el);

    this.body = el('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        justifyContent: 'center', gap: 'clamp(16px, 4vh, 40px)',
        padding: 'clamp(24px, 6vw, 96px)',
      },
    }, this.titleWrap, this.panel);
    root.appendChild(this.body);

    // ── footer ──
    this.tip = el('div', {
      style: {
        fontSize: '11px', letterSpacing: '.10em', color: C.inkDim,
        maxWidth: '52ch', lineHeight: '1.6',
      },
    });
    root.appendChild(el('div', {
      style: {
        position: 'absolute', left: 'clamp(24px, 6vw, 96px)', right: 'clamp(24px, 6vw, 96px)',
        bottom: 'calc(var(--safe-b) + 20px)', display: 'flex', gap: '18px',
        justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap',
      },
    },
    this.tip,
    this.legend([
      ['↑↓', 'Navigate'], ['↵', 'Select'], ['ESC', 'Back'],
    ])));
    root.appendChild(el('.rcr-version', { text: 'build 0.1 · procedural everything' }));

    return root;
  }

  onEnter() {
    this.game?.bus?.emit?.('audio:music', { intent: 'menu' });
    this.game?.cameraDirector?.setMode?.('orbit', 0.9);
    setText(this.tip, pickTip());
    this._layout();

    this.own(this.ui.onResize(() => this._layout()));
    const move = (e) => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      this._tx = ((e.clientX ?? w / 2) / w - 0.5) * 2;
      this._ty = ((e.clientY ?? h / 2) / h - 0.5) * 2;
    };
    window.addEventListener('pointermove', move, { passive: true });
    this.own(() => window.removeEventListener('pointermove', move));
  }

  _layout() {
    const w = window.innerWidth;
    const size = Math.max(34, Math.min(w * 0.088, 104));
    setDisplayText(this.title, 'RC RUMBLE', {
      size, tracking: 0.11, weight: 0.135, slant: 0.16,
      fill: '#ffffff', glow: withAlpha(C.cyan, 0.75), glowBlur: size * 0.45, pad: size * 0.36,
    });
    this._drawAccent(size);
  }

  _drawAccent(size) {
    const w = Math.min(window.innerWidth * 0.5, 460);
    const h = Math.max(8, size * 0.13);
    this.accent.style.width = `${w}px`;
    this.accent.style.height = `${h}px`;
    const ctx = fitCanvas(this.accent, w, h);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    // A chequered speed bar: solid cyan fading into a checker tail.
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, C.cyan);
    g.addColorStop(0.42, C.blue);
    g.addColorStop(1, 'rgba(63,134,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(h * 0.6, 0);
    ctx.lineTo(w, 0);
    ctx.lineTo(w - h * 0.6, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
    const cell = h * 0.5;
    ctx.globalCompositeOperation = 'destination-out';
    for (let x = w * 0.42, i = 0; x < w; x += cell, i++) {
      for (let j = 0; j < 2; j++) {
        if ((i + j) % 2) continue;
        ctx.fillRect(x, j * cell, cell, cell);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  update(rawDt) {
    this._t += rawDt;
    // Parallax follows the pointer with a heavy spring — it should feel like
    // the camera moved, not like the DOM twitched.
    const k = 1 - Math.exp(-3.0 * Math.min(rawDt, 0.05));
    this._px += (this._tx - this._px) * k;
    this._py += (this._ty - this._py) * k;
    setStyle(this.titleWrap, 'transform',
      `translate3d(${(-this._px * 10).toFixed(2)}px, ${(-this._py * 6).toFixed(2)}px, 0)`);
    setStyle(this.panel, 'transform',
      `translate3d(${(-this._px * 4).toFixed(2)}px, ${(-this._py * 2.5).toFixed(2)}px, 0)`);
    // Slow breathing glow on the wordmark.
    const glow = 0.5 + 0.5 * Math.sin(this._t * 0.9);
    setStyle(this.title, 'filter', `drop-shadow(0 0 ${(10 + glow * 16).toFixed(1)}px ${withAlpha(C.cyan, 0.30 + glow * 0.18)})`);
  }

  onBack() {
    // Nothing above the title screen — a back press just re-focuses RACE.
    this.menu?.focus(0, false);
    this.sound('ui/back', 0.6);
    return true;
  }
}

const TIPS = [
  'Lift off before the apex — these cars rotate on the throttle, not the brake.',
  'The handbrake is a rotation tool, not a stop button. Stab it, then catch it.',
  'Grass is grip 0.60 and gravel is 0.55. The scenic route is always slower.',
  'A pickup rolls by race position: the leader gets defence, the back gets equalisers.',
  'You can steer in the air, but only a little. Set the landing before you leave the ramp.',
  'Water is 0.35 grip and slows you hard. The plank across the pond is worth the nerve.',
  'Tap R to respawn at the last checkpoint. It costs about a second — a wall costs more.',
  'Press C to cycle chase, far chase, bumper and cockpit cameras.',
  'Ice is grip 0.18. Nothing you do with the steering will save you; only the throttle will.',
];

function pickTip() {
  return `TIP · ${TIPS[Math.floor(Math.random() * TIPS.length)]}`;
}

export default MainMenu;
