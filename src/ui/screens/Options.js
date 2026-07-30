/**
 * RC RUMBLE — options.
 *
 * Everything here writes straight through `Settings`, which persists to
 * localStorage and pushes the value into the live system on the same tick — so
 * dragging the master volume or switching quality is audible / visible while
 * the menu is still open.
 */

import CONFIG from '../../core/Config.js';
import { el, setText } from '../Dom.js';
import { THEME, withAlpha, displayTextCanvas } from '../Theme.js';
import { Screen, MenuList } from '../Screen.js';
import { QUALITY_LEVELS, CAMERA_MODES, CAMERA_LABELS } from '../Settings.js';

const C = THEME.color;
const pct = (v) => `${Math.round(v * 100)}%`;

export class Options extends Screen {
  static id = 'options';

  build() {
    const root = el('.rcr-screen');
    root.appendChild(el('.rcr-scrim.heavy'));

    const S = this.ui.settings;
    const get = (k) => () => S.get(k);
    const set = (k) => (v) => S.set(k, v);

    this.hint = el('div', {
      style: { fontSize: '11px', lineHeight: '1.6', color: C.inkDim, minHeight: '3em', maxWidth: '34ch' },
    });

    this.menu = new MenuList(this, [
      { type: 'label', label: '— Video —' },
      {
        label: 'Quality', type: 'choice',
        options: QUALITY_LEVELS.map(v => ({ value: v, label: v.toUpperCase() })),
        get: get('quality'), set: set('quality'),
        hintText: 'Shadow resolution, post-processing and pixel ratio. The renderer also adapts automatically when frames get expensive.',
      },
      {
        label: 'Motion Blur', type: 'toggle',
        get: get('motionBlur'), set: set('motionBlur'),
        hintText: 'Per-object and radial blur. Off is cheaper and reads sharper on small screens.',
      },
      {
        label: 'Bloom', type: 'toggle',
        get: get('bloom'), set: set('bloom'),
        hintText: 'Glow around bright highlights: headlights, nitro, weapon flashes.',
      },
      { type: 'label', label: '— Camera —' },
      {
        label: 'Default View', type: 'choice',
        options: CAMERA_MODES.map(v => ({ value: v, label: (CAMERA_LABELS[v] ?? v).toUpperCase() })),
        get: get('cameraMode'), set: set('cameraMode'),
        hintText: 'Press C in a race to cycle views at any time.',
      },
      {
        label: 'Field of View', type: 'slider', min: 45, max: 95, step: 1,
        get: get('fov'), set: set('fov'), format: (v) => `${Math.round(v)}°`,
        hintText: 'Base FOV. Speed adds up to 16° more on top, which is where the sense of speed comes from.',
      },
      {
        label: 'Invert Look', type: 'toggle',
        get: get('invertLook'), set: set('invertLook'),
        hintText: 'Inverts vertical look for free-look and orbit cameras.',
      },
      {
        label: 'Screen Shake', type: 'slider', min: 0, max: 1, step: 0.1,
        get: get('screenShake'), set: set('screenShake'), format: pct,
        hintText: 'Impact and rumble trauma scaling. 0 disables shake entirely.',
      },
      {
        label: 'Cinematic Cuts', type: 'toggle',
        get: get('cameraCuts'), set: set('cameraCuts'),
        hintText: 'Automatic big-air and crash replay cuts during a race.',
      },
      { type: 'label', label: '— Audio —' },
      { label: 'Master', type: 'slider', min: 0, max: 1, step: 0.05, get: get('masterVolume'), set: set('masterVolume'), format: pct },
      { label: 'Music', type: 'slider', min: 0, max: 1, step: 0.05, get: get('musicVolume'), set: set('musicVolume'), format: pct },
      { label: 'Effects', type: 'slider', min: 0, max: 1, step: 0.05, get: get('sfxVolume'), set: set('sfxVolume'), format: pct },
      { label: 'Engine', type: 'slider', min: 0, max: 1, step: 0.05, get: get('engineVolume'), set: set('engineVolume'), format: pct },
      { type: 'label', label: '— HUD —' },
      { label: 'Minimap', type: 'toggle', get: get('showMinimap'), set: set('showMinimap') },
      { label: 'Standings Ladder', type: 'toggle', get: get('showLadder'), set: set('showLadder') },
      CONFIG.debug && {
        label: 'Telemetry Panel', type: 'toggle',
        get: get('showTelemetry'),
        set: (v) => { S.set('showTelemetry', v); this.ui.telemetry?.setEnabled(v); },
        hintText: 'Developer overlay: frame budget, physics counters and control traces. Also toggled with F3.',
      },
      {
        label: 'Touch Controls', type: 'choice',
        options: [
          { value: 'auto', label: 'AUTO' }, { value: 'on', label: 'ALWAYS' }, { value: 'off', label: 'NEVER' },
        ],
        get: get('touch'), set: (v) => { S.set('touch', v); this.ui.touch?.refresh(); },
      },
      { type: 'label', label: '' },
      {
        label: 'Reset to Defaults',
        onSelect: () => { S.reset(); this.menu.refresh(); this.ui.telemetry?.setEnabled(S.get('showTelemetry')); this.sound('ui/error', 0.6); },
      },
      { label: 'Back', onSelect: () => this.ui.pop() },
    ].filter(Boolean), {
      onFocus: (spec) => setText(this.hint, spec?.hintText ?? ''),
    });

    root.appendChild(el('div', {
      style: {
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'center', padding: 'clamp(16px, 4vw, 48px)',
      },
    },
    el('.rcr-panel.rcr-ticks', {
      style: {
        padding: '22px 22px 18px', width: 'min(620px, 94vw)', maxHeight: '88vh',
        display: 'flex', flexDirection: 'column', gap: '12px',
      },
    },
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      el('.rcr-eyebrow', { text: 'Settings' }),
      displayTextCanvas('OPTIONS', {
        size: 38, tracking: 0.14, weight: 0.14, slant: 0.15,
        fill: '#ffffff', glow: withAlpha(C.cyan, 0.5), glowBlur: 22,
      })),
    el('div', { style: { flex: '1 1 auto', overflowY: 'auto', minHeight: '0', paddingRight: '4px' } }, this.menu.el),
    el('.rcr-rule'),
    el('div', { style: { display: 'flex', gap: '16px', justifyContent: 'space-between', flexWrap: 'wrap' } },
      this.hint,
      this.legend([['↑↓', 'Navigate'], ['←→', 'Change'], ['ESC', 'Back']])))));

    return root;
  }

  onEnter() {
    this.menu.refresh();
    setText(this.hint, this.menu.current?.spec?.hintText ?? '');
  }

  onBack() {
    this.ui.settings.saveNow();
    this.sound('ui/back', 0.8);
    this.ui.pop();
    return true;
  }
}

export default Options;
