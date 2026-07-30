#!/usr/bin/env node
/**
 * RC RUMBLE — end-to-end boot smoke test. `npm run smoke`
 *
 * Builds the game, serves the build, opens it in a real headless Chromium and
 * asserts the things that a green `npm run build` cannot:
 *
 *   1. the module graph actually EXECUTES (an import cycle or a bad top-level
 *      call is invisible to a bundler and fatal at runtime);
 *   2. every system's `init()` resolves and the boot overlay goes away;
 *   3. a race loads, the grid is full and the sim reaches `racing`;
 *   4. holding the throttle MOVES the car — forward, on the ground, at a
 *      plausible speed;
 *   5. the menu route reaches the main menu;
 *   6. nothing wrote to `console.error` and no exception escaped.
 *
 * Every one of those has broken here at least once while `vite build` stayed
 * green, which is the entire reason this file exists.
 *
 * ── dependencies ──────────────────────────────────────────────────────────
 * Playwright is NOT a dependency of this project and must never become one
 * (`three` is the only runtime dep, and adding a 300 MB browser to devDeps for
 * one script is a bad trade). The script therefore *borrows* an existing
 * Playwright install if the machine has one — the npx cache is where the
 * Playwright MCP server leaves it — and SKIPS cleanly if it does not. A skip
 * exits 0 so `npm run check` stays portable; pass `--require` in CI to turn a
 * skip into a failure.
 *
 * Usage:
 *   node tools/smoke.mjs                 build, serve, run, report
 *   node tools/smoke.mjs --url=http://localhost:5173   use a server already up
 *   node tools/smoke.mjs --no-build      reuse the existing dist/
 *   node tools/smoke.mjs --headed        watch it happen
 *   node tools/smoke.mjs --require       fail (exit 3) if Playwright is absent
 *   node tools/smoke.mjs --track=garden  smoke a different track
 */

import { existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'tools', '.smoke');

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const OPTS = {
  url: opt('url', null),
  port: Number(opt('port', 5188)),
  track: opt('track', 'toy_museum'),
  build: !flag('no-build'),
  headed: flag('headed'),
  require: flag('require'),
  keepShots: !flag('no-shots'),
  verbose: flag('verbose'),
};

// ──────────────────────────────────────────────────────── locate playwright

/**
 * Every `playwright` / `playwright-core` entry point on this machine, best
 * first: a project-local install, then a global one, then the npx cache (which
 * is content-addressed, so it has to be walked rather than guessed).
 *
 * Returns candidates rather than one answer on purpose. A borrowed Playwright
 * pins an exact browser revision — the npx cache here holds 1.62-alpha (wants
 * chromium 1232) next to 1.61.1 (wants 1228), and only 1228 is downloaded. So
 * "found a module" is not the same as "can launch a browser", and the caller
 * has to probe `executablePath()` before committing.
 */
function findPlaywrightCandidates() {
  const req = createRequire(import.meta.url);
  const dirs = [];
  const out = [];
  const push = (dir) => { if (dir && existsSync(dir) && !dirs.includes(dir)) dirs.push(dir); };

  for (const name of ['playwright', 'playwright-core']) {
    try { out.push({ path: req.resolve(name), how: 'local' }); } catch { /* not installed */ }
  }

  const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim();
  if (globalRoot) { push(join(globalRoot, 'playwright')); push(join(globalRoot, 'playwright-core')); }

  const npxCache = join(homedir(), '.npm', '_npx');
  if (existsSync(npxCache)) {
    for (const hash of readdirSync(npxCache)) {
      push(join(npxCache, hash, 'node_modules', 'playwright'));
      push(join(npxCache, hash, 'node_modules', 'playwright-core'));
    }
  }

  for (const dir of dirs) {
    for (const entry of ['index.mjs', 'index.js']) {
      const p = join(dir, entry);
      if (existsSync(p)) { out.push({ path: p, how: 'borrowed' }); break; }
    }
  }
  return out;
}

/** Import candidates until one has a browser binary actually on disk. */
async function loadChromium() {
  const tried = [];
  for (const cand of findPlaywrightCandidates()) {
    try {
      const mod = await import(pathToFileURL(cand.path).href);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (!chromium) continue;
      // Full chromium first (real WebGL), headless shell as the fallback.
      for (const channel of [undefined, 'chromium']) {
        let exe = null;
        try { exe = channel ? chromium.executablePath({ channel }) : chromium.executablePath(); }
        catch { continue; }
        if (exe && existsSync(exe)) return { chromium, channel, path: cand.path, how: cand.how, exe };
      }
      tried.push(`${cand.path} (browser not downloaded)`);
    } catch (err) {
      tried.push(`${cand.path} (${err.message.split('\n')[0]})`);
    }
  }
  return { chromium: null, tried };
}

// ──────────────────────────────────────────────────────── server plumbing

const CLEANUP = [];
let cleanupArmed = false;
function registerCleanup(fn) {
  CLEANUP.push(fn);
  if (cleanupArmed) return;
  cleanupArmed = true;
  const fire = () => { while (CLEANUP.length) { try { CLEANUP.pop()(); } catch { /* best effort */ } } };
  process.on('exit', fire);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { fire(); process.exit(130); });
  }
  process.on('uncaughtException', (e) => { fire(); console.error(e); process.exit(1); });
}

function run(cmd, args, label) {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  if (res.status !== 0) {
    console.log(C.red(`  ✗ ${label} failed`));
    console.log(C.dim(`${res.stdout ?? ''}${res.stderr ?? ''}`.split('\n').slice(-20).join('\n')));
    process.exit(1);
  }
  return res.stdout ?? '';
}

/** Ask the OS for a port nobody is using, so parallel runs cannot collide. */
async function freePort(preferred) {
  const net = await import('node:net');
  const tryPort = (p) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(0));
    srv.listen(p, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  return (await tryPort(preferred)) || (await tryPort(0));
}

/**
 * Start `vite preview` as its own process group.
 *
 * Deliberately NOT via `npx`: npx forks a grandchild, so `child.kill()` reaps
 * the wrapper and leaves the real server holding the port. The next run then
 * finds the port busy, silently talks to the stale server, and fails in a way
 * that looks like a game bug. `detached: true` + `kill(-pid)` takes the whole
 * group down.
 */
function startPreview(port, logPath) {
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const out = existsSync(join(ROOT, 'node_modules')) ? openSync(logPath, 'w') : 'ignore';
  const child = spawn(process.execPath, [viteBin, 'preview', '--port', String(port), '--strictPort'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  return {
    child,
    kill() {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    },
  };
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { redirect: 'follow' });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// ──────────────────────────────────────────────────────── assertions

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? C.green('✓') : C.red('✗')} ${name}${detail ? C.dim(`  ${detail}`) : ''}`);
}

/** Console/page errors we consider environmental rather than our bug. */
const IGNORED_ERROR = [
  /AudioContext was not allowed to start/i,   // no user gesture in headless
  /The AudioContext was not allowed/i,
  /Automatic fallback to software WebGL/i,
  /WebGL.*SwiftShader/i,
  /GroupMarkerNotSet/i,
  /Failed to load resource.*favicon/i,
];
const noisy = (text) => IGNORED_ERROR.some((re) => re.test(text));

// ──────────────────────────────────────────────────────── the run

async function main() {
  console.log(C.bold('\nRC RUMBLE — boot smoke test'));

  const pw = await loadChromium();
  if (!pw.chromium) {
    const msg = 'no usable Playwright + Chromium on this machine — smoke test skipped.';
    if (OPTS.require) {
      console.log(C.red(`\n  ✗ ${msg}`));
      for (const t of pw.tried ?? []) console.log(C.dim(`      tried ${t}`));
      console.log('');
      process.exit(3);
    }
    console.log(C.yellow(`\n  ⊘ ${msg}`));
    for (const t of pw.tried ?? []) console.log(C.dim(`      tried ${t}`));
    console.log(C.dim('    Run `npx playwright install chromium` once to enable it.\n'));
    process.exit(0);
  }
  const { chromium } = pw;
  console.log(C.dim(`playwright: ${pw.how} from ${pw.path}`));
  console.log(C.dim(`chromium:   ${pw.exe}`));

  let base = OPTS.url;
  let server = null;

  if (!base) {
    if (OPTS.build) {
      console.log(C.dim('building…'));
      run('npm', ['run', 'build'], 'vite build');
    } else if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
      console.log(C.red('  ✗ --no-build given but dist/index.html does not exist'));
      process.exit(1);
    }
    if (OPTS.keepShots) mkdirSync(SHOTS, { recursive: true });
    const port = await freePort(OPTS.port);
    base = `http://127.0.0.1:${port}`;
    server = startPreview(port, join(SHOTS, 'preview.log'));
    // Reap it however we exit — a crash between here and the `finally` used to
    // leave the port held, and the NEXT run then talked to a stale server.
    registerCleanup(() => server.kill());
    if (!(await waitForServer(base))) {
      console.log(C.red(`  ✗ preview server never came up on ${base}`));
      process.exit(1);
    }
  }
  console.log(C.dim(`serving: ${base}`));

  if (OPTS.keepShots) mkdirSync(SHOTS, { recursive: true });

  const browser = await chromium.launch({
    headless: !OPTS.headed,
    ...(pw.channel ? { channel: pw.channel } : {}),
    // NOTE: do NOT force `--use-angle=swiftshader` here. Software rasterisation
    // turns the IBL prefilter and the first shader compiles into a multi-minute
    // stall, which surfaces as a bogus "game never booted" failure. Let Chrome
    // pick the real GPU; `--enable-unsafe-swiftshader` only permits the
    // software path as a last resort on machines without one.
    args: [
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    await raceScenario(browser, base);
    await menuScenario(browser, base);
  } finally {
    await browser.close().catch(() => {});
    if (server) server.kill();
  }

  console.log(C.bold('\n▸ Summary\n'));
  console.log(`  ${results.length - failures} passed, ${failures} failed`);
  if (OPTS.keepShots) console.log(C.dim(`  screenshots in tools/.smoke/`));
  console.log(failures === 0 ? C.green('\n  PASS\n') : C.red('\n  FAIL\n'));
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Poll a predicate from Node with plain `page.evaluate`.
 *
 * NOT `page.waitForFunction`: its in-page poller and this game's
 * requestAnimationFrame loop do not co-exist in headless Chromium — the loop
 * stalls after a handful of frames while the poller is installed, and the run
 * reports a boot failure for a game that is in fact running perfectly (verified
 * side by side: same URL, same flags, 870 frames when polled from Node, 4 when
 * polled by waitForFunction). Driving the poll from outside the page keeps the
 * page's frame loop untouched.
 *
 * @param {import('playwright').Page} page
 * @param {() => {ok:boolean}} fn evaluated in the page; must return `{ ok, … }`
 * @returns {Promise<{ok:boolean, last:object|null}>}
 */
async function poll(page, fn, timeoutMs, { everyMs = 1000, evalMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stalls = 0;
  while (Date.now() < deadline) {
    // `page.evaluate` never rejects when the page's main thread is wedged, so
    // it needs its own timeout or the whole run hangs instead of reporting.
    // The budget is generous: a cold track build is ~6 s of straight-line
    // synchronous work, and evaluates issued during it simply queue.
    last = await Promise.race([
      page.evaluate(fn).catch(() => null),
      new Promise((r) => setTimeout(() => r({ __stalled: true }), evalMs)),
    ]);
    if (last?.__stalled) { stalls++; last = null; }
    if (last?.ok) return { ok: true, last, stalls };
    if (OPTS.verbose) process.stdout.write(C.dim(`      poll ${JSON.stringify(last)}\n`));
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { ok: false, last, stalls };
}

/** Open a page with error capture wired up before any script runs. */
async function openPage(browser, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !noisy(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => { if (!noisy(String(e))) errors.push(`uncaught: ${e.message}`); });
  // 60 s, not the 30 s default: macOS takes its time on the FIRST launch of a
  // freshly downloaded "Google Chrome for Testing.app" (Gatekeeper scans the
  // bundle), and that shows up here as a navigation timeout, not a launch one.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Hammering `page.evaluate` the instant domcontentloaded fires races the
  // execution context the bundle is still being created in, and the calls hang
  // rather than fail. One settle beat costs nothing and removes the whole class.
  await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  return { ctx, page, errors };
}

async function raceScenario(browser, base) {
  console.log(C.bold('\n▸ Race route\n'));
  const url = `${base}/?skipmenu=1&debug=1&track=${OPTS.track}&laps=1`;
  const { ctx, page, errors } = await openPage(browser, url);

  try {
    // 1. boot
    const booted = await poll(page, () => ({
      ok: !!globalThis.GAME && globalThis.GAME.loop && globalThis.GAME.loop.frame > 4,
      frame: globalThis.GAME?.loop?.frame ?? -1,
    }), 90_000);
    check('boots and starts the frame loop', booted.ok,
      `frame ${booted.last?.frame ?? '?'}${booted.stalls ? `, ${booted.stalls} unresponsive polls` : ''}`);
    if (!booted) {
      const diag = await page.evaluate(() => ({
        hasGame: !!globalThis.GAME,
        frame: globalThis.GAME?.loop?.frame ?? -1,
        state: globalThis.GAME?.state ?? null,
        bootMsg: document.getElementById('boot-msg')?.textContent ?? '',
        bootErr: (document.getElementById('boot-err')?.textContent ?? '').split('\n')[0],
      })).catch((e) => ({ evalFailed: e.message.split('\n')[0] }));
      console.log(C.dim(`      ${JSON.stringify(diag)}`));
      if (errors.length) console.log(C.dim(`      console: ${errors.slice(0, 3).join(' | ')}`));
      return;
    }

    // 2. boot overlay is gone
    const overlayHidden = await page.evaluate(() => {
      const b = document.getElementById('boot');
      return !b || b.classList.contains('hidden') || b.style.display === 'none';
    });
    check('boot overlay is dismissed', overlayHidden);

    // 3. race loaded
    const loaded = (await poll(page, () => ({
      ok: !!(globalThis.GAME.track && globalThis.GAME.cars.length > 1 && globalThis.GAME.playerCar),
    }), 90_000)).ok;
    const world = await page.evaluate(() => {
      const g = globalThis.GAME;
      return {
        track: g.track?.id ?? null,
        cars: g.cars.length,
        players: g.cars.filter((c) => c.isPlayer).length,
        checkpoints: g.track?.checkpoints?.length ?? 0,
        grid: g.track?.startGrid?.length ?? 0,
        collisionTris: g.track?.collision?.triangleCount ?? 0,
        pads: g.track?.pickupPads?.length ?? 0,
        aiNodes: g.track?.aiPath?.nodes?.length ?? 0,
      };
    });
    check('track + full grid loaded', loaded && world.cars >= 2 && world.players === 1, JSON.stringify(world));
    check('track has collision geometry', world.collisionTris > 500, `${world.collisionTris} tris`);
    check('track has checkpoints and a grid', world.checkpoints >= 2 && world.grid >= 8,
      `${world.checkpoints} cp / ${world.grid} slots`);

    // 4. the sim reaches `racing`
    const racing = await poll(page, () => ({
      ok: globalThis.GAME.race?.phase === 'racing', phase: globalThis.GAME.race?.phase,
    }), 180_000);
    check('countdown completes and the race starts', racing.ok, `phase ${racing.last?.phase ?? '?'}`);

    // 5. the car drives
    const drive = await page.evaluate(async () => {
      const g = globalThis.GAME;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const car = g.playerCar;
      const fwd = car.getForward(new (car.body.position.constructor)());
      const start = car.body.position.clone();
      const key = { code: 'ArrowUp', key: 'ArrowUp', bubbles: true };
      window.dispatchEvent(new KeyboardEvent('keydown', key));
      let maxSpeed = 0; let minGround = 4; let sumY = 0; let n = 0;
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        maxSpeed = Math.max(maxSpeed, car.speed);
        minGround = Math.min(minGround, car.wheelsOnGround);
        sumY += car.body.position.y; n++;
      }
      window.dispatchEvent(new KeyboardEvent('keyup', key));
      const end = car.body.position.clone();
      const delta = end.clone().sub(start);
      return {
        maxSpeed: +maxSpeed.toFixed(2),
        speedKmh: +car.speedKmh.toFixed(1),
        travelled: +delta.length().toFixed(2),
        forwardDot: +delta.normalize().dot(fwd).toFixed(2),
        avgY: +(sumY / n).toFixed(3),
        minWheelsOnGround: minGround,
        fps: +g.loop.stats.fps.toFixed(1),
        steps: g.loop.stats.steps,
        simMs: +g.loop.stats.simMs.toFixed(2),
        renderMs: +g.loop.stats.renderMs.toFixed(2),
        odometer: +(car.odometer ?? 0).toFixed(1),
      };
    });
    check('throttle accelerates the car', drive.maxSpeed > 3, `${drive.maxSpeed} m/s (${drive.speedKmh} km/h)`);
    check('car travels forward', drive.travelled > 5 && drive.forwardDot > 0.3,
      `${drive.travelled} m, fwd·Δ=${drive.forwardDot}`);
    check('car stays on the ground', drive.minWheelsOnGround >= 2 && Math.abs(drive.avgY) < 3,
      `${drive.minWheelsOnGround}/4 wheels, avg y=${drive.avgY}`);
    // Deliberately a LIVENESS check, not a performance one. This runs headless
    // on whatever box happens to be free, often next to other builds, and a
    // starved page here has measured 4 fps while the same build renders at 58
    // in a foreground browser. Asserting 60 fps from here would produce a red
    // that means nothing. What this can honestly prove is that the fixed-step
    // loop is stepping and not wedged; real frame budget lives in
    // `game.renderer.getStats()` on a real machine.
    check('sim loop is live', drive.fps > 2 && drive.steps > 0,
      `${drive.fps} fps, ${drive.steps} steps, sim ${drive.simMs} ms, render ${drive.renderMs} ms`);

    // 6. every registered system survived a frame
    const errored = await page.evaluate(() => [...(globalThis.GAME._errored ?? [])]);
    check('no system threw during update', errored.length === 0, errored.join(', '));

    if (OPTS.keepShots) await page.screenshot({ path: join(SHOTS, 'race.png') });
    check('race route: clean console', errors.length === 0, errors.slice(0, 3).join(' | '));
    if (errors.length) writeFileSync(join(SHOTS, 'race-errors.txt'), errors.join('\n'));
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function menuScenario(browser, base) {
  console.log(C.bold('\n▸ Menu route\n'));
  const { ctx, page, errors } = await openPage(browser, `${base}/`);
  try {
    const booted = await poll(page, () => ({
      ok: document.querySelectorAll('#ui-root *').length > 3
        && (document.getElementById('boot')?.classList.contains('hidden') ?? true),
    }), 90_000);
    check('menu route boots', booted.ok);

    // The menu build has no ?debug=1, so GAME is not exposed. Assert on the DOM.
    const dom = await page.evaluate(() => {
      const root = document.getElementById('ui-root');
      const boot = document.getElementById('boot');
      const text = (root?.innerText ?? '').replace(/\s+/g, ' ').trim();
      return {
        nodes: root ? root.querySelectorAll('*').length : 0,
        bootHidden: !boot || boot.classList.contains('hidden') || boot.style.display === 'none',
        canvas: !!document.querySelector('#app canvas'),
        sample: text.slice(0, 160),
      };
    });
    check('boot overlay dismissed on the menu route', dom.bootHidden);
    check('a WebGL canvas exists', dom.canvas);
    check('main menu rendered DOM', dom.nodes > 5, `${dom.nodes} nodes · "${dom.sample.slice(0, 60)}"`);

    if (OPTS.keepShots) await page.screenshot({ path: join(SHOTS, 'menu.png') });
    check('menu route: clean console', errors.length === 0, errors.slice(0, 3).join(' | '));
    if (errors.length) writeFileSync(join(SHOTS, 'menu-errors.txt'), errors.join('\n'));
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(C.red(`\nsmoke test crashed: ${err?.stack ?? err}\n`));
  process.exit(1);
});
