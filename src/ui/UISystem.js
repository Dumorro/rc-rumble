/**
 * RC RUMBLE — UISystem.
 *
 * `game.ui`. Owns everything the player looks at that is not the 3D scene:
 *
 *   • a **screen stack** with enter/exit transitions (`push` / `pop` / `show`),
 *   • the **HUD**, telemetry overlay and touch controls,
 *   • **input routing** — keyboard and gamepad drive the same action vocabulary
 *     the mouse does, and the game's own input is disabled while a menu owns
 *     the screen so you can never drive a car through a menu,
 *   • the **pause flow** (`GameState.PAUSED` ⇄ racing),
 *   • the **race flow** — main → car → track → loading → race → results, plus a
 *     simple championship season,
 *   • **audio unlock** on the first click or keypress.
 *
 * Routing is driven by the canonical `game:state` event plus the documented
 * race / pickup events, so the UI follows the simulation rather than the other
 * way round. Every collaborator read is optional-chained: with no race system,
 * no track system and no audio, the menus still open and the game still boots.
 */

import CONFIG from '../core/Config.js';
import { GameState } from '../core/Game.js';

import { injectStyles, refreshDisplayText, THEME } from './Theme.js';
import { el, clear, setClass, isTouchDevice } from './Dom.js';
import { Settings } from './Settings.js';
import { HUD } from './hud/HUD.js';
import { Telemetry } from './hud/Telemetry.js';
import { TouchControls } from './TouchControls.js';
import { cacheOutline } from './TrackMap.js';

import { MainMenu } from './screens/MainMenu.js';
import { CarSelect } from './screens/CarSelect.js';
import { TrackSelect } from './screens/TrackSelect.js';
import { Loading } from './screens/Loading.js';
import { Pause } from './screens/Pause.js';
import { Results, POINTS } from './screens/Results.js';
import { Options } from './screens/Options.js';
import { Controls } from './screens/Controls.js';

/** name → Screen subclass. */
const SCREENS = {
  [MainMenu.id]: MainMenu,
  [CarSelect.id]: CarSelect,
  [TrackSelect.id]: TrackSelect,
  [Loading.id]: Loading,
  [Pause.id]: Pause,
  [Results.id]: Results,
  [Options.id]: Options,
  [Controls.id]: Controls,
};

/** Gamepad repeat timings for menu navigation. */
const NAV_DELAY = 0.36;
const NAV_REPEAT = 0.11;
const STICK_DEADZONE = 0.55;

export class UISystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = game?.uiRoot ?? document.body;

    this.settings = new Settings(game);
    /** @type {import('./Screen.js').Screen[]} */
    this.stack = [];
    /** Race setup being assembled by the menu flow. */
    this.flow = this._defaultFlow();
    /** @type {{tracks:Array, index:number, points:Object, playerName:string}|null} */
    this.championship = null;
    /** Latest results payload, kept for the results screen + a retry. */
    this.lastResults = null;
    this.lastRecords = null;

    this.hud = null;
    this.telemetry = null;
    this.touch = null;

    this._resizeSubs = new Set();
    this._unsub = [];
    this._audioUnlocked = false;
    this._navTimer = 0;
    this._navDir = 0;
    this._padPrev = 0;
    this._stateBeforePause = GameState.RACING;
    this._loadingRequested = false;
    this._raceRequestId = 0;
    this._lastW = 0;
    this._lastH = 0;
    this._dpr = 0;
  }

  _defaultFlow() {
    // An explicit URL parameter must beat a value persisted from a previous
    // session, or the documented debug URLs (?car=phantom, ?laps=1 …) silently
    // do nothing and you get last session's car instead.
    const url = CONFIG.startup.fromUrl ?? {};
    const saved = (key, urlKey, fallback) => (
      url[urlKey] ? fallback : (this.settings?.get(key) ?? fallback)
    );
    return {
      mode: 'single',
      carId: saved('lastCar', 'car', CONFIG.startup.car),
      carColor: null,
      trackId: url.track ? CONFIG.startup.track : (this.settings?.get('lastTrack') ?? ''),
      laps: saved('laps', 'laps', CONFIG.startup.laps),
      opponents: saved('opponents', 'opponents', CONFIG.startup.opponents),
      mirrored: false,
      reversed: false,
    };
  }

  // ═══════════════════════════════════════════════════════════ lifecycle

  async init() {
    injectStyles();

    this.layer = el('.rcr');
    this.screenLayer = el('.rcr-screens');
    this.fadeEl = el('.rcr-fade');

    this.hud = new HUD(this);
    this.telemetry = new Telemetry(this);
    this.touch = new TouchControls(this);

    this.hud.mount(this.layer);
    this.layer.appendChild(this.screenLayer);
    this.touch.mount(this.layer);
    this.telemetry.mount(this.layer);
    this.layer.appendChild(this.fadeEl);
    this.root.appendChild(this.layer);

    this.settings.apply();
    this._installEvents();
    this._installInput();
    this._installAudioUnlock();
    this._resize();

    // Boot straight into the right screen for whatever state we are already in.
    this._routeState(this.game?.state ?? GameState.BOOT);
    return this;
  }

  dispose() {
    for (const f of this._unsub) { try { f(); } catch { /* noop */ } }
    this._unsub.length = 0;
    for (const s of this.stack.slice()) s.unmount();
    this.stack.length = 0;
    this.hud?.unmount();
    this.telemetry?.unmount();
    this.touch?.unmount();
    this.layer?.remove();
    this.settings.saveNow();
  }

  // ═══════════════════════════════════════════════════════════ events

  _installEvents() {
    const bus = this.game?.bus;
    if (!bus) return;
    const sub = (n, f) => this._unsub.push(bus.on(n, f));

    sub('game:state', (e) => this._routeState(e?.state, e?.prev));

    sub('race:loaded', (ctx) => {
      // Cache the real spline outline so the select screens can draw it later.
      try { if (ctx?.track?.id) cacheOutline(ctx.track.id, ctx.track); } catch { /* noop */ }
    });

    sub('race:end', (e) => this._onRaceEnd(e?.results ?? null));

    // Any weapon/impact feedback that deserves a controller rumble.
    sub('weapon:hit', (e) => {
      if (e?.carId !== this.game?.playerCar?.id) return;
      if (this.settings.get('rumble')) this.game?.input?.rumble?.(0.8, 0.5, 200);
    });
    sub('car:collision', (e) => {
      if (e?.carId !== this.game?.playerCar?.id) return;
      const j = e?.impulse ?? 0;
      if (j < 3 || !this.settings.get('rumble')) return;
      this.game?.input?.rumble?.(Math.min(1, j / 18), Math.min(1, j / 30), 90);
    });
  }

  _installInput() {
    const onKey = (e) => this._onKeyDown(e);
    window.addEventListener('keydown', onKey, { capture: true });
    this._unsub.push(() => window.removeEventListener('keydown', onKey, { capture: true }));

    const onResize = () => this._resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    this._unsub.push(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    });

    // The renderer publishes adaptive pixel-ratio changes too — take those if
    // it is already up, otherwise the window listener above is enough.
    try {
      const off = this.game?.renderer?.registerResizeTarget?.(() => this._resize());
      if (typeof off === 'function') this._unsub.push(off);
    } catch { /* renderer not ready yet — window resize covers us */ }
  }

  _installAudioUnlock() {
    const unlock = () => {
      if (this._audioUnlocked) return;
      this._audioUnlocked = true;
      try { this.game?.audio?.unlock?.(); } catch { /* noop */ }
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    window.addEventListener('touchstart', unlock, true);
    this._unsub.push(() => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
    });
  }

  // ═══════════════════════════════════════════════════════════ resize

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const d = Math.min(window.devicePixelRatio || 1, 2.5);
    if (w === this._lastW && h === this._lastH && d === this._dpr) return;
    const dprChanged = d !== this._dpr;
    this._lastW = w; this._lastH = h; this._dpr = d;

    if (dprChanged) refreshDisplayText(this.layer);
    this.hud?.layout(w, h);
    for (const fn of this._resizeSubs) {
      try { fn(w, h); } catch (err) { console.warn('[UI] resize handler threw', err); }
    }
    for (const s of this.stack) { try { s.resize(w, h); } catch { /* noop */ } }
  }

  /** Subscribe to viewport changes. @returns {() => void} unsubscribe */
  onResize(fn) {
    this._resizeSubs.add(fn);
    return () => this._resizeSubs.delete(fn);
  }

  // ═══════════════════════════════════════════════════════════ screens

  get top() { return this.stack[this.stack.length - 1] ?? null; }

  /** True while any screen that wants pointer/keyboard focus is open. */
  get modalOpen() {
    for (const s of this.stack) if (s.modal) return true;
    return false;
  }

  hasScreen(name) {
    for (const s of this.stack) if (s.name === name) return true;
    return false;
  }

  /**
   * Push a screen on top of the stack.
   * @param {string} name @param {object} [props]
   */
  push(name, props = {}) {
    const Ctor = SCREENS[name];
    if (!Ctor) { console.warn(`[UI] unknown screen "${name}"`); return null; }
    const screen = new Ctor(this, props);
    this.stack.push(screen);
    screen.mount(this.screenLayer);
    this._afterStackChange(name);
    return screen;
  }

  /** Pop the top screen. */
  pop() {
    const s = this.stack.pop();
    s?.unmount();
    this._afterStackChange(this.top?.name ?? null);
    return s ?? null;
  }

  /** Replace the whole stack with one screen (or clear it with `null`). */
  show(name, props = {}) {
    this.clearScreens();
    return name ? this.push(name, props) : null;
  }

  /** Back-compat with the original scaffold API. */
  showScreen(name, props) { return this.show(name, props); }

  clearScreens() {
    while (this.stack.length) this.stack.pop()?.unmount();
    this._afterStackChange(null);
  }

  /** Remove every screen with this name (used by the pause flow). */
  closeScreen(name) {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i].name === name) this.stack.splice(i, 1)[0].unmount();
    }
    this._afterStackChange(this.top?.name ?? null);
  }

  _afterStackChange(name) {
    const modal = this.modalOpen;
    setClass(this.screenLayer, 'is-open', modal);
    this.screenLayer.style.pointerEvents = modal ? 'auto' : 'none';

    // Hand the keyboard to the UI while a menu is up.
    const input = this.game?.input;
    if (input) {
      if (modal) input.setEnabled(false);
      else { input.setEnabled(false); input.setEnabled(true); }   // also clears stuck keys
    }

    // HUD visibility: hidden if any open screen wants it hidden.
    let hide = false;
    for (const s of this.stack) if (s.hidesHud) hide = true;
    const racing = this._isRaceState(this.game?.state);
    this.hud?.setVisible(racing && !hide);
    this.touch?.setActive(racing && !modal);

    if (name) this.game?.bus?.emit?.('ui:screen', { name });
  }

  _isRaceState(state) {
    return state === GameState.COUNTDOWN || state === GameState.RACING
      || state === GameState.PAUSED || state === GameState.FINISHED;
  }

  // ═══════════════════════════════════════════════════════════ routing

  _routeState(state, prev) {
    switch (state) {
      case GameState.MENU:
        this.touch?.setActive(false);
        if (!this.hasScreen(MainMenu.id) || this.stack.length !== 1) this.show(MainMenu.id);
        break;

      case GameState.LOADING:
        if (!this.hasScreen(Loading.id)) {
          this.show(Loading.id, { trackId: this.flow.trackId || this.game?.raceConfig?.trackId });
        }
        break;

      case GameState.COUNTDOWN:
        this.clearScreens();
        this.hud?.onRaceStart({ track: this.game?.track, cars: this.game?.cars });
        this.hud?.setVisible(true);
        this.touch?.setActive(true);
        break;

      case GameState.RACING:
        if (prev === GameState.PAUSED) this.closeScreen(Pause.id);
        this.hud?.setVisible(!this._anyHidesHud());
        this.touch?.setActive(!this.modalOpen);
        break;

      case GameState.PAUSED:
        if (!this.hasScreen(Pause.id)) this.push(Pause.id);
        break;

      case GameState.FINISHED:
        this.touch?.setActive(!this.modalOpen);
        break;

      case GameState.RESULTS:
        this.touch?.setActive(false);
        if (!this.hasScreen(Results.id)) {
          this.show(Results.id, {
            results: this.lastResults ?? this.game?.race?.lastResults ?? null,
            records: this.lastRecords,
            championship: this.championship,
          });
        }
        break;

      default:
        break;
    }
    this._afterStackChange(this.top?.name ?? null);
  }

  _anyHidesHud() {
    for (const s of this.stack) if (s.hidesHud) return true;
    return false;
  }

  // ═══════════════════════════════════════════════════════════ race flow

  /** @param {'single'|'timetrial'|'championship'} mode */
  beginFlow(mode = 'single') {
    this.flow = this._defaultFlow();
    this.flow.mode = mode;
    this.championship = null;
    if (mode === 'timetrial') this.flow.opponents = 0;
    if (mode === 'championship') {
      const tracks = safeTracks(this.game);
      this.championship = {
        tracks,
        index: 0,
        points: {},
        playerName: '',
      };
    }
    this.push(CarSelect.id, { mode });
  }

  /** Kick off the race described by `this.flow`. */
  startFlow() {
    if (this.championship) {
      // The season always runs the full calendar in order, starting from the
      // track you highlighted.
      const i = this.championship.tracks.findIndex(t => t.id === this.flow.trackId);
      this.championship.index = i >= 0 ? i : 0;
      this.flow.trackId = this.championship.tracks[this.championship.index]?.id ?? this.flow.trackId;
    }
    this.startRace({
      trackId: this.flow.trackId,
      carId: this.flow.carId,
      laps: this.flow.laps,
      opponents: this.flow.opponents,
      mode: this.flow.mode,
      mirrored: this.flow.mirrored,
      reversed: this.flow.reversed,
    });
  }

  /**
   * Show the loading screen, let the browser paint, then build the race.
   * Never throws — a failed load drops back to the main menu with a toast.
   */
  startRace(cfg) {
    const id = ++this._raceRequestId;
    const trackId = cfg.trackId || this.game?.trackSystem?.defaultTrackId || 'toy_museum';
    const loading = this.show(Loading.id, { trackId });
    loading?.setProgress?.(0.08, 'preparing');

    // Two frames: one to mount, one to guarantee a paint before the hitch.
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      if (id !== this._raceRequestId) return;
      loading?.setProgress?.(0.32, 'building track');
      try {
        await this.game.loadRace({
          trackId,
          carId: cfg.carId ?? this.settings.get('lastCar'),
          laps: cfg.laps ?? this.settings.get('laps'),
          opponents: cfg.opponents ?? this.settings.get('opponents'),
          mode: cfg.mode ?? 'single',
          mirrored: !!cfg.mirrored,
          reversed: !!cfg.reversed,
        });
        loading?.setProgress?.(1, 'go');
      } catch (err) {
        console.error('[UI] race load failed', err);
        if (id !== this._raceRequestId) return;
        this.show(MainMenu.id);
        try { this.game?.setState?.(GameState.MENU); } catch { /* noop */ }
      }
    }));
  }

  /** Re-run the current race configuration from the grid. */
  restartRace() {
    const cfg = this.game?.raceConfig ?? null;
    this.setPaused(false, true);
    this.startRace({
      trackId: cfg?.trackId ?? this.flow.trackId,
      carId: cfg?.carId ?? this.flow.carId,
      laps: cfg?.laps ?? this.flow.laps,
      opponents: cfg?.opponents ?? this.flow.opponents,
      mode: cfg?.mode ?? this.flow.mode,
    });
  }

  /** Tear the race down and go back to the menu (optionally deeper in). */
  async quitToMenu(target = 'main') {
    this._raceRequestId++;
    this.setPaused(false, true);
    this.clearScreens();
    this.hud?.setVisible(false);
    this.hud?.onRaceEnd();
    this.touch?.setActive(false);
    try { await this.game?.unloadRace?.(); } catch (err) { console.warn('[UI] unload failed', err); }
    try { this.game?.setState?.(GameState.MENU); } catch { /* noop */ }
    this.show(MainMenu.id);
    if (target === 'car') this.push(CarSelect.id, { mode: this.flow.mode });
    else if (target === 'track') {
      this.push(CarSelect.id, { mode: this.flow.mode });
      this.push(TrackSelect.id, { mode: this.flow.mode });
    }
  }

  /** Advance a championship season to the next round. */
  championshipNext() {
    const champ = this.championship;
    if (!champ) { this.quitToMenu(); return; }
    champ.index = Math.min(champ.index + 1, champ.tracks.length - 1);
    this.flow.trackId = champ.tracks[champ.index]?.id ?? this.flow.trackId;
    this.startRace({
      trackId: this.flow.trackId,
      carId: this.flow.carId,
      laps: this.flow.laps,
      opponents: this.flow.opponents,
      mode: 'championship',
    });
  }

  _onRaceEnd(results) {
    this.lastResults = results;
    this.lastRecords = null;
    if (!results) return;

    const p = results.playerEntry;
    if (p && results.trackId) {
      this.lastRecords = this.settings.submitResult(results.trackId, {
        bestLap: p.bestLap ?? Infinity,
        totalTime: p.finished && !p.dnf ? p.totalTime : Infinity,
        won: p.place === 1,
      });
    }

    const champ = this.championship;
    if (champ) {
      champ.playerName = p?.name ?? champ.playerName ?? 'You';
      for (const e of results.entries ?? []) {
        const pts = POINTS[e.place - 1] ?? 0;
        champ.points[e.name] = (champ.points[e.name] ?? 0) + pts;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════ pause

  togglePause() {
    if (this.game?.state === GameState.PAUSED) this.setPaused(false);
    else if (this._canPause()) this.setPaused(true);
  }

  _canPause() {
    const s = this.game?.state;
    return s === GameState.RACING || s === GameState.COUNTDOWN || s === GameState.FINISHED;
  }

  /** @param {boolean} on @param {boolean} [silent] */
  setPaused(on, silent = false) {
    const game = this.game;
    if (!game) return;
    if (on) {
      if (game.state === GameState.PAUSED) return;
      if (!this._canPause()) return;
      this._stateBeforePause = game.state;
      if (!silent) this.sound('ui/back', 0.9);
      game.setState(GameState.PAUSED);
    } else {
      if (game.state !== GameState.PAUSED) { this.closeScreen(Pause.id); return; }
      // Drop anything the pause menu opened on top of itself first.
      while (this.top && this.top.name !== Pause.id) this.pop();
      this.closeScreen(Pause.id);
      if (!silent) this.sound('ui/confirm', 0.7);
      game.setState(this._stateBeforePause ?? GameState.RACING);
    }
  }

  // ═══════════════════════════════════════════════════════════ input

  _onKeyDown(e) {
    if (e.repeat && !NAV_KEYS.has(e.code)) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    // Global toggles.
    if (e.code === 'F3' || e.code === 'Backquote') {
      const on = this.telemetry?.toggle?.();
      this.settings.set('showTelemetry', !!on);
      e.preventDefault();
      return;
    }

    const screen = this.top;
    if (!screen) {
      // No menu open: pause is handled from the polled InputState so keyboard
      // and gamepad agree. Nothing else to do here.
      return;
    }

    // A screen owns the keyboard. Give it the raw event first, then the action.
    let handled = false;
    try { handled = !!screen.onKey(e); } catch (err) { console.error('[UI] onKey', err); }
    if (!handled) {
      const action = ACTION_FOR_KEY[e.code];
      if (action) {
        try { handled = !!screen.onAction(action); } catch (err) { console.error('[UI] onAction', err); }
        if (!handled && action === 'back') { this.pop(); handled = true; }
      }
    }
    if (handled || NAV_KEYS.has(e.code)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Menu navigation from a gamepad — only while a screen owns the input. */
  _pollGamepad(rawDt) {
    const screen = this.top;
    if (!screen) { this._navDir = 0; this._padPrev = 0; return; }
    let pad = null;
    try {
      const pads = navigator.getGamepads?.() ?? [];
      for (const p of pads) if (p?.connected) { pad = p; break; }
    } catch { pad = null; }
    if (!pad) { this._navDir = 0; this._padPrev = 0; return; }

    const b = pad.buttons;
    const ax = pad.axes?.[0] ?? 0;
    const ay = pad.axes?.[1] ?? 0;
    const up = !!b[12]?.pressed || ay < -STICK_DEADZONE;
    const down = !!b[13]?.pressed || ay > STICK_DEADZONE;
    const left = !!b[14]?.pressed || ax < -STICK_DEADZONE;
    const right = !!b[15]?.pressed || ax > STICK_DEADZONE;

    let dir = 0;
    if (up) dir = 1; else if (down) dir = 2; else if (left) dir = 3; else if (right) dir = 4;

    if (dir !== this._navDir) {
      this._navDir = dir;
      this._navTimer = NAV_DELAY;
      if (dir) this._fire(screen, NAV_ACTIONS[dir]);
    } else if (dir) {
      this._navTimer -= rawDt;
      if (this._navTimer <= 0) {
        this._navTimer = NAV_REPEAT;
        this._fire(screen, NAV_ACTIONS[dir]);
      }
    }

    // Edge-triggered buttons: A, B, LB, RB, Start.
    let mask = 0;
    if (b[0]?.pressed) mask |= 1;
    if (b[1]?.pressed) mask |= 2;
    if (b[4]?.pressed) mask |= 4;
    if (b[5]?.pressed) mask |= 8;
    if (b[9]?.pressed) mask |= 16;
    const rising = mask & ~this._padPrev;
    this._padPrev = mask;
    if (rising & 1) this._fire(screen, 'confirm');
    if (rising & 2) this._fire(screen, 'back');
    if (rising & 4) this._fire(screen, 'tabL');
    if (rising & 8) this._fire(screen, 'tabR');
    if (rising & 16) {
      if (screen.name === Pause.id) this.setPaused(false);
      else this._fire(screen, 'confirm');
    }
  }

  _fire(screen, action) {
    if (!screen || !action) return;
    try {
      const handled = screen.onAction(action);
      if (!handled && action === 'back') this.pop();
    } catch (err) { console.error('[UI] gamepad action', err); }
  }

  // ═══════════════════════════════════════════════════════════ frame

  /**
   * @param {number} dt   simulated seconds (0 while paused)
   * @param {number} alpha
   * @param {number} rawDt real seconds
   */
  update(dt, alpha, rawDt) {
    const rt = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(rawDt, 0.1) : 0.016;
    this.settings.tick(rt);

    // Pause from the polled InputState (keyboard + gamepad) when free of menus.
    if (!this.top && this.game?.input?.state?.pause) this.togglePause();
    this._pollGamepad(rt);

    for (let i = 0; i < this.stack.length; i++) {
      const s = this.stack[i];
      try { s.update(rt); } catch (err) { console.error(`[UI] ${s.name}.update`, err); }
    }

    try { this.hud?.update(rt); } catch (err) { this._once('hud', err); }
    try { this.telemetry?.update(rt); } catch (err) { this._once('telemetry', err); }
    try { this.touch?.update(rt); } catch (err) { this._once('touch', err); }
  }

  _once(key, err) {
    this._errs ??= new Set();
    if (this._errs.has(key)) return;
    this._errs.add(key);
    console.error(`[UI] ${key} threw (further errors suppressed):`, err);
  }

  // ═══════════════════════════════════════════════════════════ system hooks

  onRaceStart(ctx) {
    this.hud?.onRaceStart(ctx);
    this.lastResults = null;
    this.lastRecords = null;
    this.touch?.refresh();
  }

  onRaceEnd() {
    this.hud?.onRaceEnd();
  }

  // ═══════════════════════════════════════════════════════════ helpers

  /** Play a UI sound. Silent (and free) before the audio graph is unlocked. */
  sound(name, volume = 1) {
    try { this.game?.audio?.play?.(name, { volume }); } catch { /* noop */ }
  }

  /** The label the HUD should print in the "fire" prompt. */
  fireKeyLabel() {
    const src = this.game?.input?.state?.source;
    if (src === 'gamepad') return 'RB';
    if (src === 'touch' || isTouchDevice()) return 'TAP';
    return 'CTRL';
  }

  /** Screen fade for transitions. `amount` 0..1. */
  fade(amount, seconds = 0.4) {
    if (!this.fadeEl) return;
    this.fadeEl.style.transitionDuration = `${Math.max(0, seconds)}s`;
    setClass(this.fadeEl, 'on', amount > 0.5);
    // Hand it to the post stack too, so the 3D scene fades with the DOM.
    try { this.game?.renderer?.postfx?.fadeTo?.(amount, seconds); } catch { /* noop */ }
  }

  /** Convenience for other systems: raise a HUD toast. */
  toast(text, kind = 'info', secs = 2) {
    this.hud?.toast(text, kind, secs);
  }
}

// ─────────────────────────────────────────────────────────────── key maps

const ACTION_FOR_KEY = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Enter: 'confirm', NumpadEnter: 'confirm', Space: 'confirm',
  Escape: 'back', Backspace: 'back',
  KeyQ: 'tabL', KeyE: 'tabR',
  Tab: 'down',
};

const NAV_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Tab', 'Backspace',
]);

const NAV_ACTIONS = [null, 'up', 'down', 'left', 'right'];

function safeTracks(game) {
  try {
    const list = game?.trackSystem?.listTracks?.();
    if (Array.isArray(list) && list.length) return list.slice();
  } catch { /* noop */ }
  return [{ id: 'toy_museum', name: 'Toy Museum' }];
}

export { THEME, clear };
export default UISystem;
