/**
 * RC RUMBLE — developer telemetry overlay.
 *
 * Only ever built when `CONFIG.debug` is on (or `game.ui.telemetry.setEnabled(true)`
 * from the console); toggled in game with **F3** or **`**. Shows the frame
 * budget from `game.loop.stats`, the counters every system publishes, and live
 * strip charts of the player's control inputs, slip and suspension travel — the
 * four traces you actually need when tuning a vehicle.
 *
 * All numeric text is written through `setText`, so a frame costs a handful of
 * string compares plus one small canvas repaint.
 */

import CONFIG from '../../core/Config.js';
import { el, setText, setClass, clamp01, formatTime } from '../Dom.js';
import { THEME, withAlpha, fitCanvas } from '../Theme.js';

const C = THEME.color;
const PLOT_SAMPLES = 180;

/** One ring-buffered trace on the strip chart. */
class Trace {
  constructor(label, color, min = 0, max = 1) {
    this.label = label;
    this.color = color;
    this.min = min;
    this.max = max;
    this.data = new Float32Array(PLOT_SAMPLES);
    this.head = 0;
  }
  push(v) {
    this.data[this.head] = Number.isFinite(v) ? v : 0;
    this.head = (this.head + 1) % PLOT_SAMPLES;
  }
  clear() { this.data.fill(0); this.head = 0; }
}

export class Telemetry {
  /** @param {import('../UISystem.js').UISystem} ui */
  constructor(ui) {
    this.ui = ui;
    this.game = ui.game;
    this.root = null;
    this.enabled = false;
    this._t = 0;
    this._sampleT = 0;

    this.traces = {
      throttle: new Trace('THR', '#43e58c', 0, 1),
      brake: new Trace('BRK', '#ff4f62', 0, 1),
      steer: new Trace('STR', '#54dcff', -1, 1),
      slip: new Trace('SLIP', '#ffb223', -0.8, 0.8),
      susp: new Trace('SUSP', '#d75cff', 0, 1),
    };
    this.frameTrace = new Trace('MS', '#7db4ff', 0, 34);
  }

  mount(parent) {
    if (this.root) return this.root;
    this.root = this._build();
    parent.appendChild(this.root);
    this.setEnabled(!!CONFIG.debug && !!this.ui.settings.get('showTelemetry'));
    return this.root;
  }

  unmount() {
    this.root?.remove();
    this.root = null;
  }

  _build() {
    const root = el('.rcr-telemetry.hidden');
    const kv = (label) => {
      const v = el('b', { text: '—' });
      return { row: el('.kv', null, el('span', { text: label }), v), v };
    };

    this.f = {
      fps: kv('fps'), frame: kv('frame'), sim: kv('sim'), render: kv('render'),
      steps: kv('steps'), scale: kv('scale'),
    };
    this.p = {
      bodies: kv('bodies'), awake: kv('awake'), contacts: kv('contacts'),
      pairs: kv('pairs'), tris: kv('tri tests'), pms: kv('phys ms'),
    };
    this.r = {
      draws: kv('draws'), tris: kv('tris'), progs: kv('programs'),
      gpu: kv('gpu ms'), quality: kv('quality'), pr: kv('pxratio'),
    };
    this.x = {
      particles: kv('particles'), marks: kv('marks'), decals: kv('decals'),
      voices: kv('voices'), cars: kv('cars'), state: kv('state'),
    };
    this.c = {
      speed: kv('speed'), gear: kv('gear'), rpm: kv('rpm'),
      surf: kv('surface'), wheels: kv('wheels'), drift: kv('drift'),
      lap: kv('lap'), place: kv('place'), grip: kv('grip usage'), cam: kv('camera'),
    };

    this.plot = document.createElement('canvas');
    this.plot.style.width = '100%';
    this.plot.style.height = '86px';
    this.plot.style.marginTop = '6px';
    this.plot.style.borderRadius = '3px';

    root.append(
      el('h4', { text: 'RC RUMBLE · TELEMETRY' }),
      el('.grid', null, ...Object.values(this.f).map(o => o.row)),
      el('hr'),
      el('h4', { text: 'physics' }),
      el('.grid', null, ...Object.values(this.p).map(o => o.row)),
      el('hr'),
      el('h4', { text: 'render / fx / audio' }),
      el('.grid', null, ...Object.values(this.r).map(o => o.row), ...Object.values(this.x).map(o => o.row)),
      el('hr'),
      el('h4', { text: 'player car' }),
      el('.grid', null, ...Object.values(this.c).map(o => o.row)),
      this.plot,
      el('div', {
        style: { marginTop: '5px', opacity: '.5', fontSize: '9px', letterSpacing: '.12em' },
        text: 'F3 toggle · thr grn · brk red · str cyn · slip amb · susp mag',
      }),
    );
    return root;
  }

  setEnabled(v) {
    this.enabled = !!v;
    setClass(this.root, 'hidden', !this.enabled);
    if (this.enabled) for (const k in this.traces) this.traces[k].clear();
    // Slide the HUD's top-left block clear of the panel rather than letting a
    // debug overlay bury the player's position and the standings ladder.
    const hud = this.ui.hud?.root;
    if (hud) hud.style.setProperty('--tl-shift', this.enabled ? `${(this.root?.offsetWidth || 306) + 14}px` : '0px');
    return this.enabled;
  }

  toggle() { return this.setEnabled(!this.enabled); }

  // ═══════════════════════════════════════════════════════════════ frame

  update(rawDt) {
    if (!this.enabled || !this.root) return;
    const game = this.game;

    // Sample the traces at a fixed 60 Hz regardless of the render rate.
    this._sampleT += rawDt;
    const car = game?.playerCar;
    while (this._sampleT >= 1 / 60) {
      this._sampleT -= 1 / 60;
      this.traces.throttle.push(car?.throttle ?? 0);
      this.traces.brake.push(car?.brake ?? 0);
      this.traces.steer.push(car?.steer ?? 0);
      this.traces.slip.push(car?.slipAngle ?? 0);
      this.traces.susp.push(avgCompression(car));
      this.frameTrace.push(game?.loop?.stats?.frameMs ?? 0);
    }

    // Text is refreshed at 8 Hz — plenty, and it keeps the DOM quiet.
    this._t += rawDt;
    if (this._t >= 0.125) {
      this._t = 0;
      this._refreshText();
    }
    this._drawPlot();
  }

  _refreshText() {
    const game = this.game;
    const ls = game?.loop?.stats ?? {};
    const budget = 16.6;
    setText(this.f.fps.v, (ls.fps ?? 0).toFixed(0));
    setClass(this.f.fps.v, 'badv', (ls.fps ?? 60) < 45);
    setClass(this.f.fps.v, 'warnv', (ls.fps ?? 60) >= 45 && (ls.fps ?? 60) < 56);
    setText(this.f.frame.v, `${(ls.frameMs ?? 0).toFixed(1)}ms`);
    setClass(this.f.frame.v, 'badv', (ls.frameMs ?? 0) > budget);
    setText(this.f.sim.v, `${(ls.simMs ?? 0).toFixed(1)}ms`);
    setText(this.f.render.v, `${(ls.renderMs ?? 0).toFixed(1)}ms`);
    setText(this.f.steps.v, String(ls.steps ?? 0));
    setText(this.f.scale.v, (game?.loop?.timeScale ?? 1).toFixed(2));

    const ps = game?.physics?.stats ?? {};
    setText(this.p.bodies.v, String(ps.bodies ?? 0));
    setText(this.p.awake.v, String(ps.awake ?? 0));
    setText(this.p.contacts.v, String(ps.contacts ?? 0));
    setText(this.p.pairs.v, String(ps.pairs ?? 0));
    setText(this.p.tris.v, String(ps.triangleTests ?? 0));
    setText(this.p.pms.v, `${(ps.ms ?? 0).toFixed(2)}ms`);

    let rs = null;
    try { rs = game?.renderer?.getStats?.(); } catch { rs = null; }
    setText(this.r.draws.v, String(rs?.drawCalls ?? 0));
    setText(this.r.tris.v, formatK(rs?.triangles ?? 0));
    setText(this.r.progs.v, String(rs?.programs ?? 0));
    setText(this.r.gpu.v, rs?.gpuMs != null ? `${Number(rs.gpuMs).toFixed(1)}ms` : '—');
    setText(this.r.quality.v, String(rs?.quality ?? CONFIG.quality));
    setText(this.r.pr.v, (rs?.pixelRatio ?? 1).toFixed(2));

    const fx = game?.fx?.getStats?.() ?? game?.fx?.stats ?? {};
    setText(this.x.particles.v, `${fx.particles ?? 0}/${fx.capacity ?? 0}`);
    setText(this.x.marks.v, String(fx.marks ?? 0));
    setText(this.x.decals.v, String(fx.decals ?? 0));
    let au = null;
    try { au = game?.audio?.stats?.(); } catch { au = null; }
    setText(this.x.voices.v, String(au?.voices?.active ?? au?.voices?.used ?? au?.active ?? 0));
    setText(this.x.cars.v, String(game?.cars?.length ?? 0));
    setText(this.x.state.v, String(game?.state ?? '—'));

    const car = game?.playerCar;
    setText(this.c.speed.v, car ? `${(car.speedKmh ?? 0).toFixed(0)} (${(car.speed ?? 0).toFixed(2)} m/s)` : '—');
    setText(this.c.gear.v, car ? String(car.gear ?? 0) : '—');
    setText(this.c.rpm.v, car ? (car.rpm ?? 0).toFixed(0) : '—');
    setText(this.c.surf.v, car ? surfaceName(this.game, car.dominantSurfaceId ?? 0) : '—');
    setText(this.c.wheels.v, car ? `${car.wheelsOnGround ?? 0}/4${car.airborne ? ' AIR' : ''}` : '—');
    setText(this.c.drift.v, car ? (car.driftFactor ?? 0).toFixed(2) : '—');
    setText(this.c.grip.v, car ? (car.gripUsage ?? 0).toFixed(2) : '—');
    const hud = game?.race?.getHud?.();
    setText(this.c.lap.v, hud ? `${hud.lap}/${hud.laps} ${formatTime(hud.lapTime)}` : '—');
    setText(this.c.place.v, hud ? `${hud.place}/${hud.carCount}` : '—');
    setText(this.c.cam.v, String(game?.cameraDirector?.getMode?.() ?? '—'));
  }

  _drawPlot() {
    const w = this.root.clientWidth - 22;
    const h = 86;
    if (w <= 10) return;
    const ctx = fitCanvas(this.plot, w, h);
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    // Backing + midline
    ctx.fillStyle = 'rgba(255,255,255,0.030)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5 + 0.5);
    ctx.lineTo(w, h * 0.5 + 0.5);
    ctx.stroke();

    // 16.6 ms budget line on the frame trace (top third of the plot).
    const frameH = h * 0.34;
    ctx.strokeStyle = withAlpha(C.bad, 0.35);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const budgetY = frameH - (16.6 / this.frameTrace.max) * frameH;
    ctx.moveTo(0, budgetY);
    ctx.lineTo(w, budgetY);
    ctx.stroke();
    ctx.setLineDash([]);
    this._strokeTrace(ctx, this.frameTrace, w, 0, frameH, 0.55);

    const bodyY = frameH + 2;
    const bodyH = h - frameH - 2;
    for (const k in this.traces) this._strokeTrace(ctx, this.traces[k], w, bodyY, bodyH, 1);
  }

  _strokeTrace(ctx, tr, w, y0, hh, alpha) {
    const n = PLOT_SAMPLES;
    const dx = w / (n - 1);
    ctx.strokeStyle = tr.color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const idx = (tr.head + i) % n;
      const t = clamp01((tr.data[idx] - tr.min) / (tr.max - tr.min || 1));
      const x = i * dx;
      const y = y0 + hh - t * hh;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function avgCompression(car) {
  const ws = car?.wheels;
  if (!ws?.length) return 0;
  let s = 0;
  for (let i = 0; i < ws.length; i++) s += ws[i]?.compression ?? 0;
  return s / ws.length;
}

const SURFACE_NAMES = [
  'default', 'wood', 'carpet', 'tile', 'concrete', 'grass', 'dirt', 'gravel',
  'sand', 'water', 'ice', 'metal', 'plastic', 'rubber', 'glass', 'oil',
];

function surfaceName(game, id) {
  try {
    const s = game?.trackSystem?.surface?.(id);
    if (s?.name) return `${id} ${s.name}`;
  } catch { /* noop */ }
  return `${id} ${SURFACE_NAMES[id] ?? '?'}`;
}

function formatK(n) {
  if (n > 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n > 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n | 0);
}

export default Telemetry;
