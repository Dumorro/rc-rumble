import * as THREE from 'three';
import CONFIG from './Config.js';
import { EventBus } from './EventBus.js';
import { Input } from './Input.js';
import { Loop } from './Loop.js';
import { Assets } from './Assets.js';
import { RNG } from './MathUtils.js';

/**
 * Game states.
 *
 *   boot → menu ⇄ loading → countdown → racing ⇄ paused → finished → results → menu
 */
export const GameState = Object.freeze({
  BOOT: 'boot',
  MENU: 'menu',
  LOADING: 'loading',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  PAUSED: 'paused',
  FINISHED: 'finished',   // player crossed the line, race still running for AI
  RESULTS: 'results',
});

/**
 * The Game owns everything. Systems talk to each other through `game.<name>`
 * or the EventBus — never by importing each other's internals.
 */
export class Game {
  constructor(container, uiRoot) {
    this.container = container;
    this.uiRoot = uiRoot;

    this.bus = new EventBus();
    this.rng = new RNG(CONFIG.seed);
    this.assets = new Assets(this);
    this.input = new Input(this);

    this.scene = new THREE.Scene();
    this.scene.name = 'root';
    /** The active render camera. CameraDirector owns it and may swap it. */
    this.camera = new THREE.PerspectiveCamera(CONFIG.render.fovBase, 1, 0.02, 400);
    this.camera.position.set(0, 1.2, 2.4);

    this.state = GameState.BOOT;
    this.prevState = null;

    /** Populated on race load. */
    this.track = null;
    /** @type {import('../vehicle/Car.js').Car[]} */
    this.cars = [];
    /** The human-controlled car. */
    this.playerCar = null;
    this.raceConfig = null;

    /** @type {Map<string, object>} */
    this.systems = new Map();
    /** Ordered list for update dispatch. */
    this._ordered = [];
    this._fixedUpdaters = [];
    this._updaters = [];
    this._lateUpdaters = [];

    this.loop = new Loop({
      fixedUpdate: (dt) => this._fixedUpdate(dt),
      update: (dt, a, raw) => this._update(dt, a, raw),
      lateUpdate: (dt, a, raw) => this._lateUpdate(dt, a, raw),
      render: (dt, a) => this._render(dt, a),
    });

    /** Systems can push {fn, time} to run something after N seconds of sim time. */
    this._timers = [];
  }

  // ───────────────────────────────────────────────────────── systems

  /**
   * @param {string} name property name exposed on the game (e.g. 'physics')
   * @param {object} system instance implementing the System duck-type
   */
  register(name, system) {
    if (this.systems.has(name)) throw new Error(`System "${name}" already registered`);
    this.systems.set(name, system);
    this[name] = system;
    this._ordered.push(system);
    if (typeof system.fixedUpdate === 'function') this._fixedUpdaters.push(system);
    if (typeof system.update === 'function') this._updaters.push(system);
    if (typeof system.lateUpdate === 'function') this._lateUpdaters.push(system);
    return system;
  }

  async initSystems(onProgress = () => {}) {
    await this.input.init();
    await this.assets.init();
    const total = this._ordered.length;
    let i = 0;
    for (const sys of this._ordered) {
      const name = sys.constructor?.name ?? 'system';
      onProgress(i / total, name);
      if (typeof sys.init === 'function') {
        try { await sys.init(); }
        catch (err) { console.error(`[Game] ${name}.init() failed:`, err); throw err; }
      }
      i++;
    }
    onProgress(1, 'ready');
  }

  // ───────────────────────────────────────────────────────── state

  setState(next) {
    if (this.state === next) return;
    this.prevState = this.state;
    this.state = next;
    this.loop.setPaused(next === GameState.PAUSED);
    this.bus.emit('game:state', { state: next, prev: this.prevState });
  }

  get isSimulating() {
    return this.state === GameState.COUNTDOWN
      || this.state === GameState.RACING
      || this.state === GameState.FINISHED;
  }

  /** Race control is locked out until 'GO'. */
  get controlsLive() {
    return this.state === GameState.RACING || this.state === GameState.FINISHED;
  }

  // ───────────────────────────────────────────────────────── race lifecycle

  /**
   * @param {{trackId:string, carId:string, laps:number, opponents:number, mode?:string}} cfg
   */
  async loadRace(cfg) {
    this.setState(GameState.LOADING);
    await this.unloadRace();

    this.raceConfig = {
      mode: 'single',
      laps: CONFIG.startup.laps,
      opponents: CONFIG.startup.opponents,
      ...cfg,
    };

    // 1. Track builds geometry + collision + spawn data.
    this.track = await this.trackSystem.load(this.raceConfig.trackId);
    this.scene.add(this.track.scene);
    this.physics.setTrack(this.track);

    // 2. Cars spawn onto the grid.
    this.cars = await this.carSystem.spawnField(this.track, this.raceConfig);
    this.playerCar = this.cars.find(c => c.isPlayer) ?? this.cars[0];

    // 3. Everyone else hooks in.
    const ctx = { track: this.track, cars: this.cars, config: this.raceConfig, game: this };
    for (const sys of this._ordered) sys.onRaceStart?.(ctx);

    this.setState(GameState.COUNTDOWN);
    this.bus.emit('race:loaded', ctx);
    return ctx;
  }

  async unloadRace() {
    if (!this.track && this.cars.length === 0) return;
    const ctx = { track: this.track, cars: this.cars, config: this.raceConfig, game: this };
    for (const sys of this._ordered) sys.onRaceEnd?.(ctx);

    this.carSystem?.despawnAll?.();
    this.cars = [];
    this.playerCar = null;

    if (this.track) {
      this.scene.remove(this.track.scene);
      this.trackSystem?.unload?.(this.track);
      this.track = null;
    }
    this.physics?.clear?.();
    this._timers.length = 0;
  }

  // ───────────────────────────────────────────────────────── time helpers

  /** Run `fn` after `seconds` of simulated time. */
  after(seconds, fn) {
    this._timers.push({ at: this.loop.elapsed + seconds, fn });
  }

  /** Temporarily scale simulation speed (slow-mo on big hits, etc). */
  slowMo(scale = CONFIG.camera.slowMoScale, seconds = 0.6) {
    this.loop.timeScale = scale;
    const token = ++this._slowMoToken;
    setTimeout(() => { if (token === this._slowMoToken) this.loop.timeScale = 1; }, seconds * 1000);
  }
  _slowMoToken = 0;

  // ───────────────────────────────────────────────────────── frame

  _fixedUpdate(dt) {
    if (!this.isSimulating) return;
    for (let i = 0; i < this._fixedUpdaters.length; i++) {
      const s = this._fixedUpdaters[i];
      try { s.fixedUpdate(dt); }
      catch (err) { this._systemError(s, 'fixedUpdate', err); }
    }
    // Sim timers
    for (let i = this._timers.length - 1; i >= 0; i--) {
      if (this.loop.elapsed >= this._timers[i].at) {
        const t = this._timers[i];
        this._timers.splice(i, 1);
        try { t.fn(); } catch (err) { console.error('[Game] timer threw:', err); }
      }
    }
  }

  _update(dt, alpha, rawDt) {
    this.input.poll(rawDt);
    for (let i = 0; i < this._updaters.length; i++) {
      const s = this._updaters[i];
      try { s.update(dt, alpha, rawDt); }
      catch (err) { this._systemError(s, 'update', err); }
    }
  }

  _lateUpdate(dt, alpha, rawDt) {
    for (let i = 0; i < this._lateUpdaters.length; i++) {
      const s = this._lateUpdaters[i];
      try { s.lateUpdate(dt, alpha, rawDt); }
      catch (err) { this._systemError(s, 'lateUpdate', err); }
    }
  }

  _render(dt, alpha) {
    this.renderer?.render(dt, alpha);
  }

  /** Log once per system+phase so a broken system doesn't spam 60×/s. */
  _systemError(sys, phase, err) {
    const key = `${sys.constructor?.name}.${phase}`;
    this._errored ??= new Set();
    if (!this._errored.has(key)) {
      this._errored.add(key);
      console.error(`[Game] ${key} threw (further errors suppressed):`, err);
    }
  }

  start() { this.loop.start(); }
  stop() { this.loop.stop(); }

  dispose() {
    this.stop();
    for (const sys of this._ordered) sys.dispose?.();
    this.input.dispose();
    this.assets.dispose();
  }
}

export default Game;
