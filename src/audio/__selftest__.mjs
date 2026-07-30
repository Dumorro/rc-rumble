/**
 * RC RUMBLE — audio self test.
 *
 *   node src/audio/__selftest__.mjs
 *
 * Drives the REAL AudioSystem, EngineSynth, TireAudio, Reverb and VoicePool
 * against a stubbed AudioContext — no DOM, no WebAudio, no browser. Every node
 * and AudioParam is a plain object, so this is deterministic and runs in about
 * a second, but the code under test is the shipping code.
 *
 * Why a stub and not a headless browser: audio fails *quietly*. An unknown car
 * class, a missing recipe, a reverb descriptor the resolver does not understand
 * — none of them throw, all of them play something plausible, and the bug ships
 * as "the fast car sounds a bit off". The assertions below are the ones that
 * would have caught the bugs we actually shipped and then found by hand:
 *
 *   • the rpm/gearbox contract really matches CarDefs (`redlineRpm`, not
 *     `maxRpm`; `gearCount`, not `gears`) — reading a field name that does not
 *     exist silently pinned every car to a 13500 fallback, which pitch-flattened
 *     the top 24 % of the fastest car's rev range and parked it on a fake
 *     rev-limiter bounce
 *   • class/drive voicing actually differentiates a rookie from a super
 *   • the limiter engages past redline and releases when cruising
 *   • a parametric track reverb resolves to the right ROOM CHARACTER (the museum
 *     must not come out as a 0.38 s cupboard) and every shipped track's
 *     ambienceId is one the audio system knows
 *   • all ~70 one-shots, every weapon × phase, every chassis × surface impact,
 *     every sustained loop and every music intent build without throwing
 *   • the voice pool recycles instead of leaking
 *   • nothing writes a filter above Nyquist on a 16 kHz device
 */

// ═══════════════════════════════════════════════════════════ Web Audio stub
//
// Installed on globalThis BEFORE any src/audio module is imported, because
// AudioSystem picks up `globalThis.AudioContext` at init().

/** Sample rate the next `new AudioContext()` will report. Tests override it. */
let FAKE_SR = 48000;
/** Nyquist of the context under test; any frequency write above it is a bug. */
let NYQ = FAKE_SR / 2;
/** Frequency writes that exceeded Nyquist, as `node.param = value`. */
const freqViolations = [];

function mkParam(v = 0, kind = '', owner = '') {
  const p = {
    value: v,
    defaultValue: v,
    _set(x) {
      const n = typeof x === 'number' ? x : NaN;
      if (kind === 'frequency' && Number.isFinite(n) && n > NYQ + 1e-6) {
        freqViolations.push(`${owner}.frequency = ${n.toFixed(0)} Hz (Nyquist ${NYQ})`);
      }
      if (Number.isFinite(n)) this.value = n;
      return this;
    },
    setValueAtTime(x) { return this._set(x); },
    linearRampToValueAtTime(x) { return this._set(x); },
    exponentialRampToValueAtTime(x) { return this._set(x); },
    setTargetAtTime(x) { return this._set(x); },
    setValueCurveAtTime() { return this; },
    cancelScheduledValues() { return this; },
    cancelAndHoldAtTime() { return this; },
  };
  return p;
}

function node(type) {
  const n = {
    __type: type,
    channelCount: 2, channelCountMode: 'max', channelInterpretation: 'speakers',
    numberOfInputs: 1, numberOfOutputs: 1,
    connect(d) { return d; },
    disconnect() {},
    start() {}, stop() {},
    addEventListener() {}, removeEventListener() {},
    setPosition() {}, setOrientation() {}, setPeriodicWave() {},
    buffer: null, loop: false, loopStart: 0, loopEnd: 0,
    type: 'sine', curve: null, oversample: 'none', normalize: true,
    distanceModel: 'inverse', panningModel: 'HRTF', refDistance: 1,
    maxDistance: 1e4, rolloffFactor: 1,
    coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0,
    onended: null,
  };
  n.gain = mkParam(1, 'gain', type);
  n.frequency = mkParam(350, 'frequency', type);
  n.detune = mkParam(0, 'detune', type);
  n.Q = mkParam(1, 'Q', type);
  n.pan = mkParam(0, 'pan', type);
  n.delayTime = mkParam(0, 'delayTime', type);
  n.offset = mkParam(0, 'offset', type);
  n.playbackRate = mkParam(1, 'playbackRate', type);
  for (const a of ['positionX', 'positionY', 'positionZ',
    'orientationX', 'orientationY', 'orientationZ']) n[a] = mkParam(0, a, type);
  for (const a of ['threshold', 'knee', 'ratio', 'attack', 'release', 'reduction']) {
    n[a] = mkParam(0, a, type);
  }
  return n;
}

class FakeBuffer {
  constructor(ch, len, sr) {
    this.numberOfChannels = ch; this.length = len; this.sampleRate = sr;
    this.duration = len / sr;
    this._d = Array.from({ length: ch }, () => new Float32Array(len));
  }
  getChannelData(i) { return this._d[i]; }
  copyToChannel() {} copyFromChannel() {}
}

class FakeCtx {
  constructor() {
    this.sampleRate = FAKE_SR;
    NYQ = FAKE_SR / 2;
    this.currentTime = 0;
    this.state = 'suspended';
    this.baseLatency = 0.01;
    this.destination = node('destination');
    this.listener = {
      positionX: mkParam(), positionY: mkParam(), positionZ: mkParam(),
      forwardX: mkParam(), forwardY: mkParam(), forwardZ: mkParam(-1),
      upX: mkParam(), upY: mkParam(1), upZ: mkParam(),
      setPosition() {}, setOrientation() {},
    };
  }
  createGain() { return node('gain'); }
  createBiquadFilter() { return node('biquad'); }
  createOscillator() { return node('osc'); }
  createBufferSource() { return node('bufsrc'); }
  createDelay() { return node('delay'); }
  createWaveShaper() { return node('shaper'); }
  createStereoPanner() { return node('stereo'); }
  createPanner() { return node('panner'); }
  createDynamicsCompressor() { return node('comp'); }
  createConvolver() { return node('conv'); }
  createChannelMerger() { return node('merger'); }
  createChannelSplitter() { return node('splitter'); }
  createConstantSource() { return node('const'); }
  createPeriodicWave() { return {}; }
  createAnalyser() {
    const a = node('analyser');
    a.fftSize = 2048; a.frequencyBinCount = 1024;
    a.getFloatTimeDomainData = (x) => x.fill(0);
    a.getByteFrequencyData = (x) => x.fill(0);
    a.getFloatFrequencyData = (x) => x.fill(-120);
    return a;
  }
  createBuffer(c, l, s) { return new FakeBuffer(c, l, s); }
  decodeAudioData() { return Promise.resolve(new FakeBuffer(2, 1, this.sampleRate)); }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

class FakeOfflineCtx extends FakeCtx {
  constructor(ch = 2, len = 1, sr = 48000) { super(); this.sampleRate = sr; this.length = len; this._ch = ch; }
  startRendering() { return Promise.resolve(new FakeBuffer(this._ch, this.length, this.sampleRate)); }
}

globalThis.AudioContext = FakeCtx;
globalThis.webkitAudioContext = FakeCtx;
globalThis.OfflineAudioContext = FakeOfflineCtx;
globalThis.window = globalThis;
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  createElement: () => ({ style: {}, addEventListener() {}, getContext: () => null }),
  body: { appendChild() {} },
  hidden: false, visibilityState: 'visible',
};
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node', maxTouchPoints: 0 }, configurable: true,
  });
}
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};

// ═══════════════════════════════════════════════════════════ imports
// Dynamic, so the stub above is in place first.

const THREE = await import('three');
const { AudioSystem } = await import('./AudioSystem.js');
const { EngineSynth, TIER_NEAR, TIER_MID, TIER_CULL } = await import('./EngineSynth.js');
const { AMBIENCE, resolveAmbience } = await import('./SFXSynth.js');
const { reverbDescFromParams, REVERB_PRESETS, resolveReverbName } = await import('./Reverb.js');
const CarDefsMod = await import('../vehicle/CarDefs.js');

const CAR_LIST = CarDefsMod.CAR_DEFS ?? CarDefsMod.CARS ?? CarDefsMod.default;
const DEFS = Array.isArray(CAR_LIST) ? CAR_LIST : Object.values(CAR_LIST ?? {});

// ═══════════════════════════════════════════════════════════ harness

let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else {
    failed++; failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function near(name, actual, expected, tol = 1e-6) {
  const d = Math.abs(actual - expected);
  ok(name, d <= tol, `got ${actual}, expected ${expected} (Δ${d.toExponential(2)})`);
}
function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

/** Collect console.warn while `fn` runs. */
function captureWarnings(fn) {
  const out = [];
  const orig = console.warn;
  console.warn = (...a) => out.push(String(a[0]));
  try { fn(); } finally { console.warn = orig; }
  return out;
}

// ═══════════════════════════════════════════════════════════ fixtures

function makeCar(def, i = 0, opts = {}) {
  const d = opts.distance ?? 3;
  return {
    id: opts.id ?? i,
    isPlayer: opts.isPlayer ?? (i === 0),
    def,
    group: { position: { x: 0, y: 0.1, z: -d } },
    body: { position: { x: 0, y: 0.1, z: -d }, velocity: { x: 0, y: 0, z: -6 } },
    wheels: [0, 1, 2, 3].map(() => ({
      contact: true, load: 8, surfaceId: opts.surfaceId ?? 0,
      skidIntensity: opts.skid ?? 0.3, slipRatio: 0.05, slipAngle: 0.1,
    })),
    speed: opts.speed ?? 6,
    rpm: def.idleRpm, gear: 1, engineLoad: 0.8,
    throttle: 1, brake: 0, handbrake: 0,
    slipAngle: 0.2, driftFactor: 0.3, wheelsOnGround: 4, airborne: false,
    dominantSurfaceId: opts.surfaceId ?? 0,
    effects: {}, lap: 1, place: i + 1, progress: 1 + i * 0.01,
  };
}

function makeGame() {
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500);
  cam.position.set(0, 0.3, 0);
  cam.updateMatrixWorld(true);
  return {
    bus: { on() { return () => {}; }, off() {}, emit() {} },
    camera: cam,
    cars: [], playerCar: null,
    raceConfig: { laps: 3 },
    state: 'race',
    loop: { timeScale: 1 },
    input: { rumble() {} },
    physics: { raycastTrack: () => null, createRayHit: () => ({}) },
  };
}

/** Boot a real AudioSystem on the stub. */
async function boot(game = makeGame()) {
  const A = new AudioSystem(game);
  await A.init();
  await A.unlock();
  return { A, game, ctx: A.ctx };
}

/** Advance `n` frames of audio at 60 Hz, keeping ctx.currentTime honest. */
function run(A, ctx, n, per = null) {
  for (let f = 0; f < n; f++) {
    ctx.currentTime += 1 / 60;
    per?.(f);
    A.update(1 / 60, 0, 1 / 60);
  }
}

const MUSEUM_TRACK = {
  id: 'toy_museum',
  audio: {
    reverb: { roomSize: 0.86, damping: 0.22, wet: 0.34, preDelay: 0.02 },
    ambienceId: 'museum_hall',
  },
  environment: { skybox: { preset: 'museum', mode: 'indoor', roomHeight: 10 } },
};

// ═══════════════════════════════════════════════════════════ 1. rpm contract

section('engine rpm / gearbox contract vs CarDefs');
{
  const { A, game, ctx } = await boot();
  ok('CarDefs exposes at least one car', DEFS.length > 0, `${DEFS.length}`);

  const warns = captureWarnings(() => {
    for (let i = 0; i < DEFS.length; i++) new EngineSynth(A, makeCar(DEFS[i], i), i);
  });
  ok('no shipped car warns about an unknown class or drive', warns.length === 0,
    warns.join(' | '));

  for (const def of DEFS) {
    const e = new EngineSynth(A, makeCar(def, 0), 0);
    eq(`${def.id}: redline reads def.redlineRpm`, e.redlineRpm, def.redlineRpm);
    eq(`${def.id}: idle reads def.idleRpm`, e.idleRpm, def.idleRpm);
    eq(`${def.id}: gear count reads def.gearCount`, e.gearCount, def.gearCount);
    near(`${def.id}: limiter reads def.limiterRpm`, e.limiterRpm, def.limiterRpm, 0.5);
  }

  // The bug this file exists for: a field-name typo makes every car share one
  // hardcoded fallback, which silently erases the per-class rev range.
  const fellBack = DEFS.filter((d) => {
    const e = new EngineSynth(A, makeCar(d, 0), 0);
    return e.redlineRpm === 13500 && d.redlineRpm !== 13500;
  });
  ok('no car silently falls back to the 13500 default redline', fellBack.length === 0,
    fellBack.map((d) => d.id).join(', '));

  // Distinct redlines must survive into the synth, or fast cars stop sounding fast.
  const uniqDef = new Set(DEFS.map((d) => d.redlineRpm)).size;
  const uniqSyn = new Set(DEFS.map((d) => new EngineSynth(A, makeCar(d, 0), 0).redlineRpm)).size;
  eq('distinct redlines in CarDefs survive into the synth', uniqSyn, uniqDef);

  // rpmN must span idle→limiter, so full revs is 1.0 and not a clamped plateau.
  for (const def of DEFS) {
    const e = new EngineSynth(A, makeCar(def, 0), 0);
    ok(`${def.id}: rpmN band ends at the limiter, not below redline`,
      e.maxRpm >= def.redlineRpm, `maxRpm ${e.maxRpm} < redline ${def.redlineRpm}`);
    ok(`${def.id}: limitAt sits just under 1`, e.limitAt > 0.9 && e.limitAt < 1,
      `${e.limitAt}`);
  }

  // Aliases still work for a hand-rolled def that predates the real names.
  const alias = new EngineSynth(A, makeCar({ class: 'pro', drive: 'rwd', topSpeed: 9,
    idleRpm: 1200, maxRpm: 15000, gears: 6 }, 0), 0);
  eq('legacy alias def.maxRpm is still honoured', alias.redlineRpm, 15000);
  eq('legacy alias def.gears is still honoured', alias.gearCount, 6);
  const bare = new EngineSynth(A, makeCar({ class: 'pro', drive: 'rwd', topSpeed: 9 }, 0), 0);
  eq('a def with no rpm fields falls back to 13500', bare.redlineRpm, 13500);
  eq('a def with no gear fields falls back to 4 gears', bare.gearCount, 4);
  // gearSpeeds is the raw source `gearCount` is derived from.
  const gs = new EngineSynth(A, makeCar({ class: 'pro', gearSpeeds: [0.3, 0.6, 1.0] }, 0), 0);
  eq('gearCount can be derived from gearSpeeds.length', gs.gearCount, 3);

  A.dispose();
  void game; void ctx;
}

// ═══════════════════════════════════════════════════════════ 2. voicing

section('class / drive voicing actually differentiates');
{
  const { A } = await boot();
  const byClass = new Map();
  for (const def of DEFS) {
    const e = new EngineSynth(A, makeCar(def, 0), 0);
    if (!byClass.has(def.class)) byClass.set(def.class, e);
  }
  ok('every CarDefs class has a voicing entry', byClass.size >= 4, `${byClass.size} classes`);

  const rookie = [...byClass.entries()].find(([k]) => k === 'rookie')?.[1];
  const sup = [...byClass.entries()].find(([k]) => k === 'super')?.[1];
  if (rookie && sup) {
    ok('a super revs higher than a rookie', sup.maxHz > rookie.maxHz,
      `super ${sup.maxHz.toFixed(1)} Hz vs rookie ${rookie.maxHz.toFixed(1)} Hz`);
  } else {
    ok('rookie and super classes both present in CarDefs', false,
      `saw ${[...byClass.keys()].join(', ')}`);
  }

  // Per-car jitter: eight of the same car must not be eight identical voices.
  const same = DEFS[0];
  const hz = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    new EngineSynth(A, makeCar(same, i, { id: i }), i).idleHz);
  ok('a pack of identical cars gets per-car voicing jitter',
    new Set(hz.map((v) => v.toFixed(4))).size === hz.length,
    hz.map((v) => v.toFixed(1)).join(', '));

  A.dispose();
}

// ═══════════════════════════════════════════════════════════ 3. limiter

section('rev limiter engages past redline and releases');
{
  for (const id of [DEFS[0].id, DEFS[DEFS.length - 1].id]) {
    const def = DEFS.find((d) => d.id === id);
    const { A, game, ctx } = await boot();
    const car = makeCar(def, 0, { distance: 1 });
    game.cars = [car]; game.playerCar = car;
    A.onRaceStart({ track: MUSEUM_TRACK, cars: [car] });
    A.update(1 / 60, 0, 1 / 60);
    const e = A.engineFor(0);
    ok(`${id}: engine was created and built`, !!e && e.alive === true);
    if (e) {
      car.gear = e.gearCount; car.throttle = 1;
      car.rpm = def.limiterRpm;
      run(A, ctx, 60);
      near(`${id}: rpmN saturates at 1 on the limiter`, e.rpmN, 1, 0.01);
      ok(`${id}: the limiter bounce is engaged`, e.limiting > 0.9, `${e.limiting.toFixed(3)}`);

      car.rpm = def.redlineRpm * 0.80;
      run(A, ctx, 90);
      ok(`${id}: cruising at 80 % redline is below the limiter`,
        e.rpmN > 0.6 && e.rpmN < 0.9, `rpmN ${e.rpmN.toFixed(3)}`);
      ok(`${id}: the limiter released when revs dropped`, e.limiting < 0.05,
        `${e.limiting.toFixed(3)}`);

      car.rpm = def.idleRpm; car.throttle = 0;
      run(A, ctx, 90);
      ok(`${id}: rpmN returns to 0 at idle`, e.rpmN < 0.03, `${e.rpmN.toFixed(3)}`);
    }
    A.onRaceEnd(); A.dispose();
  }
}

// ═══════════════════════════════════════════════════════════ 4. warnOnce

section('unknown class / drive warns exactly once per mistake');
{
  const { A } = await boot();
  const bad = { ...DEFS[0], class: 'turbo-nonsense', drive: '6wd' };
  const warns = captureWarnings(() => {
    for (let i = 0; i < 8; i++) new EngineSynth(A, makeCar(bad, i, { id: 900 + i }), i);
  });
  eq('eight cars sharing one typo produce two warnings, not sixteen', warns.length, 2);
  ok('the warning names the offending value',
    warns.some((w) => w.includes('turbo-nonsense')), warns.join(' | '));
  ok('the warning lists the valid classes',
    warns.some((w) => w.includes('rookie') && w.includes('super')), warns.join(' | '));

  // Already-warned keys stay quiet for the rest of the session.
  const again = captureWarnings(() => { new EngineSynth(A, makeCar(bad, 0, { id: 999 }), 0); });
  eq('a repeat of the same mistake is silent', again.length, 0);
  A.dispose();
}

// ═══════════════════════════════════════════════════════════ 5. track audio

section('track reverb / ambience resolution');
{
  const { A, game, ctx } = await boot();
  const car = makeCar(DEFS[0], 0, { distance: 2 });
  game.cars = [car]; game.playerCar = car;

  A.onRaceStart({ track: MUSEUM_TRACK, cars: [car] });
  run(A, ctx, 10);
  const st = A.stats();

  // The bug: `audio.reverb` is a PARAMETER BAG, not a preset name. Read as a
  // name it resolves to nothing, falls back to a small room, and the museum
  // gets a 0.38 s cupboard that nobody notices because it still plays.
  ok('a parametric museum reverb resolves to the museum character',
    /museum/.test(String(st.reverb?.current)), String(st.reverb?.current));
  ok('the resolved room is large, not a cupboard',
    /:(\d+(?:\.\d+)?)/.test(String(st.reverb?.current))
      && parseFloat(String(st.reverb.current).match(/:(\d+(?:\.\d+)?)/)[1]) > 2.0,
    String(st.reverb?.current));
  near('the track wet level is honoured', st.reverb?.wet, 0.34, 1e-3);
  eq('museum_hall resolves to the museum ambience bed', st.ambience, 'museum');

  // Descriptor shapes the resolver has to cope with.
  eq('a string reverb name still resolves', resolveReverbName('hall') in REVERB_PRESETS, true);
  eq('an object with .preset unwraps', resolveAmbience({ preset: 'museum' }), 'museum');
  eq('an unknown ambience falls back to default', resolveAmbience('nonsense-xyz'), 'default');
  eq('an empty ambience falls back to default', resolveAmbience(''), 'default');

  // Size drives character when the hint says nothing useful.
  const big = reverbDescFromParams({ roomSize: 0.86 }, null);
  const small = reverbDescFromParams({ roomSize: 0.18 }, null);
  ok('a big roomSize yields a long rt60', big.rt60 > 2.0, `${big.rt60.toFixed(2)} s`);
  ok('a small roomSize yields a short rt60', small.rt60 < 0.8, `${small.rt60.toFixed(2)} s`);
  ok('bigger rooms get more early reflections', big.erCount > small.erCount,
    `${big.erCount} vs ${small.erCount}`);

  // A track that says nothing must still land somewhere sane.
  A.onRaceEnd();
  A.onRaceStart({ track: { id: 'unknown_track_xyz' }, cars: [car] });
  run(A, ctx, 5);
  const bare = A.stats();
  ok('a track with no audio block still gets a reverb', !!bare.reverb?.current,
    String(bare.reverb?.current));
  eq('a track with no ambience falls back to the default bed', bare.ambience, 'default');

  A.onRaceEnd(); A.dispose();
}

// Every shipped track's ambience id must be one the audio system knows. Read
// from source rather than by building the track, so this stays cheap and does
// not depend on the geometry pipeline booting.
section('every shipped track declares audio the system understands');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const dir = path.join(here, '..', 'track', 'tracks');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')); } catch { /* none */ }
  ok('found the track sources', files.length > 0, dir);

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const ids = [...src.matchAll(/ambienceId\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const id of ids) {
      const r = resolveAmbience(id);
      ok(`${f}: ambienceId '${id}' resolves to a real bed (${r})`,
        r !== 'default' || id === 'default', `fell back to '${r}'`);
      ok(`${f}: bed '${r}' exists`, !!AMBIENCE[r]);
    }
    // A parametric reverb with a big room must not be readable as a preset NAME
    // — that is exactly the mis-read that produced the cupboard museum.
    const rs = [...src.matchAll(/reverb\s*:\s*\{[^}]*roomSize\s*:\s*([0-9.]+)/g)]
      .map((m) => parseFloat(m[1]));
    for (const size of rs) {
      const d = reverbDescFromParams({ roomSize: size }, null);
      ok(`${f}: roomSize ${size} → rt60 ${d.rt60.toFixed(2)} s is proportionate`,
        size < 0.5 ? d.rt60 < 1.2 : d.rt60 > 0.9,
        `rt60 ${d.rt60.toFixed(2)} s for roomSize ${size}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════ 6. sound library

section('the whole sound library builds without throwing');
{
  const { A, game, ctx } = await boot();
  const car = makeCar(DEFS[0], 0, { distance: 2 });
  game.cars = [car]; game.playerCar = car;
  A.onRaceStart({ track: MUSEUM_TRACK, cars: [car] });

  const names = A.listSounds();
  ok('the recipe book is not empty', names.length > 20, `${names.length} sounds`);

  const errs = [];
  for (const n of names) {
    try { A.play(n); } catch (e) { errs.push(`${n}: ${e.message}`); }
  }
  ok(`all ${names.length} one-shots play without throwing`, errs.length === 0,
    errs.slice(0, 5).join(' | '));
  run(A, ctx, 120);

  // An unknown name must fall back audibly, not explode and not go silent.
  const unknownWarns = captureWarnings(() => {
    try { A.play('definitely/not/a/sound'); } catch (e) { errs.push('unknown threw: ' + e.message); }
  });
  ok('an unknown sound name does not throw', !errs.some((e) => e.startsWith('unknown threw')));
  ok('an unknown sound name warns', unknownWarns.length > 0, 'no warning emitted');

  const werr = [];
  for (const w of ['firework', 'turbo', 'bomb', 'oil', 'shield', 'clone', 'electro',
    'rocket', 'missile', 'nitro', 'mine', 'not-a-weapon']) {
    for (const k of ['fire', 'hit']) {
      try { A.playWeapon(w, k); } catch (e) { werr.push(`${w}/${k}: ${e.message}`); }
    }
  }
  ok('every weapon id × phase resolves (aliases and junk included)', werr.length === 0,
    werr.slice(0, 5).join(' | '));

  const ierr = [];
  for (const ch of ['plastic', 'metal', 'rubber', 'glass', undefined]) {
    for (let s = 0; s < 16; s++) {
      try {
        A.impact({ chassis: ch, surfaceId: s, impulse: 4, position: { x: 0, y: 0, z: -2 } });
      } catch (e) { ierr.push(`${ch}/${s}: ${e.message}`); }
    }
  }
  ok('every chassis × surface impact resolves', ierr.length === 0, ierr.slice(0, 5).join(' | '));

  const lerr = [];
  for (const [on, off] of [['startBoost', 'stopBoost'],
    ['startPickupRoll', 'stopPickupRoll'], ['startElectro', 'stopElectro']]) {
    try { A[on]?.(0); run(A, ctx, 30); A[off]?.(0); run(A, ctx, 10); }
    catch (e) { lerr.push(`${on}: ${e.message}`); }
  }
  try { A.startBombTick?.(0); run(A, ctx, 20); A.updateBombTick?.(0, 0.5); run(A, ctx, 20); }
  catch (e) { lerr.push(`bombTick: ${e.message}`); }
  ok('every sustained loop starts and stops cleanly', lerr.length === 0, lerr.join(' | '));

  const merr = [];
  for (const i of ['menu', 'countdown', 'race', 'tension', 'finish', 'none', 'nonsense']) {
    try { A.setMusicIntent(i); run(A, ctx, 10); } catch (e) { merr.push(`${i}: ${e.message}`); }
  }
  ok('every music intent switches without throwing', merr.length === 0, merr.join(' | '));

  const rerr = [];
  for (const r of ['room', 'hall', 'museum', 'garage', 'supermarket', 'outdoor', 'nonsense']) {
    try { A.setReverb(r); run(A, ctx, 5); } catch (e) { rerr.push(`${r}: ${e.message}`); }
  }
  for (const am of [...Object.keys(AMBIENCE), 'nonsense']) {
    try { A.setAmbience(am); run(A, ctx, 5); } catch (e) { rerr.push(`amb ${am}: ${e.message}`); }
  }
  ok('every reverb and ambience switch is safe', rerr.length === 0, rerr.slice(0, 5).join(' | '));

  A.onRaceEnd(); A.dispose();
}

// ═══════════════════════════════════════════════════════════ 7. tiering

section('distance tiering and culling');
{
  const { A, game, ctx } = await boot();
  const dists = [1, 4, 8, 12, 18, 26, 34, 44];
  const cars = dists.map((d, i) => makeCar(DEFS[i % DEFS.length], i, { distance: d, id: i }));
  // Car 0 is the player and is pinned to full detail regardless of distance.
  cars[0].isPlayer = true;
  game.cars = cars; game.playerCar = cars[0];
  A.onRaceStart({ track: MUSEUM_TRACK, cars });
  run(A, ctx, 30);

  for (let i = 0; i < cars.length; i++) {
    const e = A.engineFor(i);
    const d = e.distance;
    const want = cars[i].isPlayer ? 2 : d < TIER_NEAR ? 2 : d < TIER_MID ? 1 : 0;
    eq(`car at ${dists[i]} m (d=${d.toFixed(1)}) is tier ${want}`, e.tier, want);
  }

  // Everyone piles up on the camera: every engine must promote back to full
  // detail promptly, or a pack fight sounds thin.
  for (const c of cars) { c.group.position.z = -2; c.body.position.z = -2; }
  run(A, ctx, 12);
  ok('a pile-up promotes every engine back to tier 2',
    cars.every((_, i) => A.engineFor(i).tier === 2),
    cars.map((_, i) => A.engineFor(i).tier).join(','));

  // And back out again — no engine may get stuck at full rate.
  for (let i = 0; i < cars.length; i++) {
    cars[i].group.position.z = -60; cars[i].body.position.z = -60;
  }
  run(A, ctx, 20);
  ok('cars beyond the cull radius drop to tier 0',
    cars.every((_, i) => cars[i].isPlayer || A.engineFor(i).tier === 0),
    cars.map((_, i) => A.engineFor(i).tier).join(','));
  ok('the cull radius is beyond the mid tier', TIER_CULL > TIER_MID);

  A.onRaceEnd(); A.dispose();
}

// ═══════════════════════════════════════════════════════════ 8. voice pool

section('voice pool recycles instead of leaking');
{
  const { A, game, ctx } = await boot();
  const car = makeCar(DEFS[0], 0, { distance: 2 });
  game.cars = [car]; game.playerCar = car;
  A.onRaceStart({ track: MUSEUM_TRACK, cars: [car] });

  const names = A.listSounds();
  for (let round = 0; round < 3; round++) {
    for (const n of names) A.play(n);
    run(A, ctx, 60);
  }
  const mid = A.stats().voices;
  ok('the pool never exceeds its ceiling', mid.active <= mid.max,
    `${mid.active}/${mid.max}`);
  eq('active + free accounts for the whole pool', mid.active + mid.free, mid.max);
  ok('voices were actually started', mid.started > names.length, `${mid.started}`);

  run(A, ctx, 600);
  const end = A.stats().voices;
  ok('voices are returned to the pool once they finish', end.free > end.max * 0.8,
    `${end.free}/${end.max} free, ${end.active} still active`);
  eq('the pool is still fully accounted for after settling', end.active + end.free, end.max);

  A.onRaceEnd();
  const after = A.stats().voices;
  eq('race end does not lose voices', after.active + after.free, after.max);
  A.dispose();
}

// ═══════════════════════════════════════════════════════════ 9. mute

section('mute silences the buses');
{
  const { A, game, ctx } = await boot();
  const car = makeCar(DEFS[0], 0, { distance: 1 });
  game.cars = [car]; game.playerCar = car;
  A.onRaceStart({ track: MUSEUM_TRACK, cars: [car] });
  car.rpm = DEFS[0].redlineRpm * 0.7; car.throttle = 1;
  run(A, ctx, 60);
  const loud = A.masterOut?.gain.value ?? A.masterIn?.gain.value ?? 1;
  ok('the master bus is open while racing', loud > 0, `${loud}`);

  A.toggleMute();
  run(A, ctx, 60);
  eq('mute reports muted', A.stats().muted, true);
  const quiet = A.masterOut?.gain.value ?? A.masterIn?.gain.value ?? 1;
  ok('the master bus is closed while muted', quiet <= 1e-3, `${quiet}`);

  A.toggleMute();
  run(A, ctx, 60);
  eq('unmute reports unmuted', A.stats().muted, false);
  const back = A.masterOut?.gain.value ?? A.masterIn?.gain.value ?? 0;
  ok('the master bus reopens after unmute', back > 0, `${back}`);

  A.onRaceEnd(); A.dispose();
}

// ═══════════════════════════════════════════════════════════ 10. Nyquist

section('nothing writes above Nyquist on a 16 kHz device');
{
  freqViolations.length = 0;
  FAKE_SR = 16000;
  const { A, game, ctx } = await boot();
  eq('the context really is 16 kHz', ctx.sampleRate, 16000);

  const cars = [0, 1, 2, 3].map((i) =>
    makeCar(DEFS[i % DEFS.length], i, { distance: 1 + i * 3, id: i, surfaceId: i * 3 }));
  game.cars = cars; game.playerCar = cars[0];
  A.onRaceStart({ track: MUSEUM_TRACK, cars });

  for (const n of A.listSounds()) A.play(n);
  for (let s = 0; s < 16; s++) {
    A.impact({ chassis: 'plastic', surfaceId: s, impulse: 5, position: { x: 0, y: 0, z: -2 } });
  }
  run(A, ctx, 240, (f) => {
    for (const c of cars) {
      c.rpm = c.def.idleRpm + (c.def.redlineRpm - c.def.idleRpm) * Math.abs(Math.sin(f * 0.05 + c.id));
      c.gear = 1 + ((f >> 5) % c.def.gearCount);
      c.speed = Math.abs(Math.sin(f * 0.03 + c.id)) * c.def.topSpeed;
    }
  });

  ok('no filter or oscillator exceeded Nyquist at 16 kHz', freqViolations.length === 0,
    `${freqViolations.length} writes, e.g. ${freqViolations.slice(0, 3).join(' | ')}`);

  A.onRaceEnd(); A.dispose();
  FAKE_SR = 48000;
}

// ═══════════════════════════════════════════════════════════ 11. lifecycle

section('lifecycle is re-entrant');
{
  const { A, game, ctx } = await boot();
  const errs = [];
  let engAfterEnd = -1, tireAfterEnd = -1;
  for (let round = 0; round < 3; round++) {
    const cars = [0, 1, 2].map((i) => makeCar(DEFS[i % DEFS.length], i, { id: i, distance: 2 + i }));
    game.cars = cars; game.playerCar = cars[0];
    try {
      A.onRaceStart({ track: MUSEUM_TRACK, cars });
      run(A, ctx, 40);
      A.onRaceEnd();
      engAfterEnd = A.stats().engines;
      tireAfterEnd = A.stats().tires;
      // Note: updating again with game.cars still populated legitimately
      // re-creates the voices — the results screen still has cars on it.
      run(A, ctx, 10);
    } catch (e) { errs.push(`round ${round}: ${e.message}`); }
  }
  ok('start/end can cycle repeatedly', errs.length === 0, errs.join(' | '));
  eq('engines are released on race end', engAfterEnd, 0);
  eq('tires are released on race end', tireAfterEnd, 0);

  // Emptying the field must release everything and keep it released.
  game.cars = []; game.playerCar = null;
  run(A, ctx, 10);
  eq('an empty field holds no engines', A.stats().engines, 0);
  eq('an empty field holds no tires', A.stats().tires, 0);

  // A mid-race car list swap must not leak engines.
  const a1 = [0, 1, 2].map((i) => makeCar(DEFS[i], i, { id: i, distance: 2 }));
  game.cars = a1; game.playerCar = a1[0];
  A.onRaceStart({ track: MUSEUM_TRACK, cars: a1 });
  run(A, ctx, 20);
  const a2 = [0, 1].map((i) => makeCar(DEFS[i], i, { id: i, distance: 2 }));
  game.cars = a2; game.playerCar = a2[0];
  run(A, ctx, 20);
  eq('shrinking the field disposes the extra engine', A.stats().engines, 2);

  A.onRaceEnd();
  ok('dispose() is safe', (() => { try { A.dispose(); return true; } catch { return false; } })());
  ok('a second dispose() is safe',
    (() => { try { A.dispose(); return true; } catch { return false; } })());
}

// ═══════════════════════════════════════════════════════════ report

if (failed) {
  console.log(`\n\x1b[31mFailures:\x1b[0m\n  ${failures.join('\n  ')}`);
}
console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed ? 1 : 0);
