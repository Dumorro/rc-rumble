import CONFIG from './Config.js';

/**
 * Fixed-timestep accumulator loop.
 *
 * Physics runs at exactly CONFIG.physics.fixedDt (120 Hz) so the vehicle model is
 * deterministic and stable. Rendering runs at vsync with an interpolation `alpha`
 * so motion is smooth on any refresh rate.
 *
 * Time scale (slow-mo) is applied to simulation time only — UI and audio fades
 * keep using real time via `rawDt`.
 */
export class Loop {
  constructor({ fixedUpdate, update, lateUpdate, render }) {
    this.fixedUpdate = fixedUpdate;
    this.update = update;
    this.lateUpdate = lateUpdate;
    this.render = render;

    this.dt = CONFIG.physics.fixedDt;
    this.maxSubSteps = CONFIG.physics.maxSubSteps;
    this.timeScale = 1;
    this.running = false;
    this.paused = false;

    this.elapsed = 0;        // simulated seconds since start
    this.rawElapsed = 0;     // wall-clock seconds since start
    this.frame = 0;
    this.alpha = 0;

    this._acc = 0;
    this._last = 0;
    this._raf = 0;
    this._tick = this._tick.bind(this);

    // Perf sampling
    this.stats = { fps: 0, frameMs: 0, simMs: 0, renderMs: 0, steps: 0 };
    this._fpsAcc = 0; this._fpsCount = 0; this._fpsTimer = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    this._acc = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  setPaused(v) {
    if (this.paused === v) return;
    this.paused = v;
    if (!v) this._last = performance.now(); // avoid a giant catch-up step
  }

  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    const frameStart = now;
    let rawDt = (now - this._last) / 1000;
    this._last = now;

    // Clamp: tab-switch, breakpoint, or a heavy hitch must not explode the sim.
    if (rawDt > 0.25) rawDt = 0.25;
    if (rawDt < 0) rawDt = 0;

    this.rawElapsed += rawDt;
    this.frame++;

    const simDt = this.paused ? 0 : rawDt * this.timeScale;
    this.elapsed += simDt;
    this._acc += simDt;

    const t0 = performance.now();
    let steps = 0;
    while (this._acc >= this.dt && steps < this.maxSubSteps) {
      this.fixedUpdate(this.dt);
      this._acc -= this.dt;
      steps++;
    }
    // If we blew the sub-step budget, drop the backlog rather than spiral.
    if (steps === this.maxSubSteps && this._acc > this.dt) this._acc = 0;

    this.alpha = this.dt > 0 ? this._acc / this.dt : 0;

    this.update(simDt, this.alpha, rawDt);
    this.lateUpdate(simDt, this.alpha, rawDt);
    const t1 = performance.now();

    this.render(simDt, this.alpha);
    const t2 = performance.now();

    // Stats (1 Hz rolling)
    this.stats.steps = steps;
    this.stats.simMs = t1 - t0;
    this.stats.renderMs = t2 - t1;
    this.stats.frameMs = t2 - frameStart;
    this._fpsAcc += rawDt; this._fpsCount++; this._fpsTimer += rawDt;
    if (this._fpsTimer >= 0.5) {
      this.stats.fps = this._fpsCount / this._fpsAcc;
      this._fpsAcc = 0; this._fpsCount = 0; this._fpsTimer = 0;
    }
  }
}

export default Loop;
