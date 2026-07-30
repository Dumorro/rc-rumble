/**
 * RC RUMBLE — pause menu.
 *
 * Leaves the HUD on screen behind a heavy blur so you can still read your
 * position and lap while deciding. `UISystem` owns the actual `GameState.PAUSED`
 * transition; this screen only issues intents.
 */

import { el, setText, formatTime, ordinal } from '../Dom.js';
import { THEME, withAlpha, displayTextCanvas } from '../Theme.js';
import { Screen, MenuList } from '../Screen.js';

const C = THEME.color;

export class Pause extends Screen {
  static id = 'pause';

  constructor(ui, props) {
    super(ui, props);
    this.hidesHud = false;
    this.transitionMs = 260;
  }

  build() {
    const root = el('.rcr-screen');
    root.appendChild(el('.rcr-scrim.heavy'));

    this.menu = new MenuList(this, [
      { label: 'Resume', hint: 'ESC', onSelect: () => this.ui.setPaused(false) },
      { label: 'Restart Race', hint: 'From the grid', onSelect: () => this.ui.restartRace() },
      { label: 'Options', onSelect: () => this.ui.push('options', { inRace: true }) },
      { label: 'Controls', onSelect: () => this.ui.push('controls', { inRace: true }) },
      { label: 'Quit to Menu', onSelect: () => this.ui.quitToMenu() },
    ]);

    this.statLine = el('div', {
      style: {
        display: 'flex', gap: '18px', flexWrap: 'wrap',
        fontSize: '10px', letterSpacing: '.24em', textTransform: 'uppercase', color: C.inkFaint,
      },
    });

    root.appendChild(el('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '24px',
      },
    },
    el('.rcr-panel.rcr-ticks', {
      style: {
        padding: '26px 24px 20px', width: 'min(420px, 90vw)',
        display: 'flex', flexDirection: 'column', gap: '14px',
      },
    },
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      el('.rcr-eyebrow', { text: 'Race suspended' }),
      displayTextCanvas('PAUSED', {
        size: 44, tracking: 0.14, weight: 0.14, slant: 0.15,
        fill: '#ffffff', glow: withAlpha(C.cyan, 0.55), glowBlur: 26,
      })),
    this.statLine,
    el('.rcr-rule'),
    this.menu.el,
    this.legend([['↑↓', 'Navigate'], ['↵', 'Select'], ['ESC', 'Resume']]))));

    return root;
  }

  onEnter() {
    const hud = this.game?.race?.getHud?.();
    const track = this.game?.track;
    const bits = [];
    if (track?.name) bits.push(track.name);
    if (hud) {
      bits.push(`Lap ${hud.lap}/${hud.laps}`);
      bits.push(`${ordinal(hud.place)} of ${hud.carCount}`);
      if (Number.isFinite(hud.bestLap)) bits.push(`Best ${formatTime(hud.bestLap)}`);
    }
    setText(this.statLine, bits.join('   ·   '));
  }

  onBack() {
    this.sound('ui/back', 0.9);
    this.ui.setPaused(false);
    return true;
  }
}

export default Pause;
