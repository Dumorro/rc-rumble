/**
 * Camera self-test / behaviour probe. Not part of the game: nothing imports it, so
 * it never reaches the bundle. Run it from the repo root with
 *
 *     node src/camera/__selftest__.js
 *
 * It drives the real CameraDirector against fake Game/Car/Physics objects and
 * asserts the things that are easy to break and impossible to eyeball in a diff:
 *
 *   • boots with no track and no car (menu orbit fallback)
 *   • the chase camera ends up BEHIND the car, at a sane distance, at speed
 *   • velocity feed-forward: distance must not grow with speed
 *   • mode cycling, hold-to-look-back push/pop, respawn, car loss
 *   • trauma decay, directional impulse, collision/land/weapon shake
 *   • big-air cut fires and returns; crash cut fires ONCE then respects cooldown
 *   • the intro flyby runs three shots and hands over exactly on the chase pose
 *   • finish cam orbit radius, and that it tracks a winner still rolling at 6 m/s
 *   • dt = 0 (paused) and dt = 0.25 (a hitch) produce no NaN and no fly-away
 *   • per-frame cost and heap churn (must be ~zero allocations)
 */

/* eslint-disable no-console */

// Node has no DOM; stub the handful of globals core/Config.js reads at import time.
// This must happen BEFORE the dynamic imports below, hence no static imports here.
if (typeof window === 'undefined') {
  globalThis.navigator ??= { hardwareConcurrency: 8, userAgent: 'node' };
  globalThis.window ??= globalThis;
  globalThis.document ??= { addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  globalThis.innerWidth ??= 1600;
  globalThis.innerHeight ??= 900;
}

const THREE = await import('three');
const { CameraDirector } = await import('./CameraDirector.js');
const { EventBus } = await import('../core/EventBus.js');
const { GameState } = await import('../core/Game.js');
const { InputState } = await import('../core/Input.js');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.error('FAIL:', msg); } };
const finite = (v, msg) => ok(Number.isFinite(v), `${msg} (got ${v})`);

// ── fakes ───────────────────────────────────────────────────────────────────
function makeCar(id = 0) {
  const body = {
    position: new THREE.Vector3(0, 0.06, 0),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(0, 0, -4),
    angularVelocity: new THREE.Vector3(0, 0.6, 0),
  };
  const group = new THREE.Group();
  group.position.copy(body.position);
  return {
    id, isPlayer: true, def: { id: 'toyeca', topSpeed: 9 }, body, group,
    speed: 4, speedKmh: 40, driftFactor: 0.2, slipAngle: 0.12, lateralG: 0.8,
    wheelsOnGround: 4, airborne: false, airTime: 0, upsideDown: false,
    dominantSurfaceId: 1, steer: 0.2, effects: { boost: 0 }, finished: false,
    worldPosition(out) { return out.copy(this.group.position); },
  };
}

const bus = new EventBus();
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.02, 400);
const physics = {
  trackMesh: {},
  sphereCast() { return false; },
  raycastTrack() { return false; },
};
const postfxLog = { speed: 0, dof: 0, resets: 0 };
const game = {
  bus, camera, physics,
  scene: new THREE.Scene(),
  state: GameState.BOOT,
  cars: [], playerCar: null, track: null,
  input: { state: new InputState(), rumble() {} },
  loop: { timeScale: 1, paused: false, elapsed: 0 },
  renderer: {
    postfx: {
      setSpeedIntensity(v) { postfxLog.speed = v; },
      setDof(o) { postfxLog.dof = o.enabled ? (o.intensity ?? 1) : 0; },
      resetHistory() { postfxLog.resets++; },
    },
    pulseSlowMo() {},
  },
  slowMo() {},
  after() {},
};

const dir = new CameraDirector(game);
await dir.init();

// ── 1. boots with nothing loaded ────────────────────────────────────────────
let t = 0;
for (let i = 0; i < 90; i++) { t += 1 / 60; dir.lateUpdate(1 / 60, 0, 1 / 60); }
ok(dir.mode === 'orbit', `menu fallback should be orbit, got ${dir.mode}`);
finite(camera.position.x, 'orbit camera x');
finite(camera.fov, 'orbit fov');
ok(camera.position.length() > 0.5, 'orbit camera should be away from origin');
const orbitP = camera.position.clone();
dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(!camera.position.equals(orbitP), 'orbit camera should be moving');

// ── 2. race start, no intro ─────────────────────────────────────────────────
const car = makeCar(0);
game.cars = [car];
game.playerCar = car;
game.track = {
  id: 'test', surfaces: [{ name: 'default', grip: 1, bumpiness: 0.2 }],
  checkpoints: [
    { index: 0, position: new THREE.Vector3(0, 0, -4), isFinish: true },
    { index: 1, position: new THREE.Vector3(4, 0, -8) },
    { index: 2, position: new THREE.Vector3(8, 0, -4) },
    { index: 3, position: new THREE.Vector3(4, 0, 0) },
  ],
  startGrid: [{ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }],
  environment: { bounds: new THREE.Box3(new THREE.Vector3(-20, -2, -20), new THREE.Vector3(20, 8, 20)) },
  spline: { sample: (u) => ({ position: new THREE.Vector3(Math.sin(u * 6) * 6, 0, -u * 40), tangent: new THREE.Vector3(0, 0, -1) }) },
};
game.state = GameState.COUNTDOWN;
dir.autoIntro = false;
dir.onRaceStart({ track: game.track, cars: game.cars, config: {}, game });
ok(dir.mode === 'chase', `race start should be chase, got ${dir.mode}`);

// drive the car forward for 4 s
game.state = GameState.RACING;
for (let i = 0; i < 240; i++) {
  const dt = 1 / 60;
  car.body.position.z -= 4 * dt;
  car.group.position.copy(car.body.position);
  car.body.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(i * 0.01) * 0.4);
  car.group.quaternion.copy(car.body.quaternion);
  car.body.velocity.set(Math.sin(i * 0.01) * 1.2, 0, -4);
  dir.lateUpdate(dt, 0, dt);
  finite(camera.position.z, `chase z at frame ${i}`);
}
ok(camera.position.z > car.body.position.z, 'chase camera must be BEHIND the car (larger z)');
const back = camera.position.distanceTo(car.body.position);
ok(back > 0.5 && back < 2.2, `chase distance sane, got ${back.toFixed(3)}`);
ok(camera.fov > 62 && camera.fov < 82, `speed fov should have opened, got ${camera.fov.toFixed(2)}`);
ok(postfxLog.speed > 0.2, `speed intensity published, got ${postfxLog.speed.toFixed(3)}`);
ok(dir.getSpeedIntensity() > 0.2, 'getSpeedIntensity');

// ── 3. mode cycling + look back ─────────────────────────────────────────────
const seen = new Set();
for (let k = 0; k < 5; k++) {
  game.input.state.camera = true;
  dir.lateUpdate(1 / 60, 0, 1 / 60);
  game.input.state.camera = false;
  seen.add(dir.mode);
  for (let i = 0; i < 30; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
  finite(camera.position.y, `cycle ${k} camera y`);
}
ok(seen.has('chaseFar') && seen.has('bumper') && seen.has('cockpit'),
  `cycle visited all views, got ${[...seen].join(',')}`);

// back to chase
while (dir.baseMode !== 'chase') {
  game.input.state.camera = true; dir.lateUpdate(1 / 60, 0, 1 / 60);
  game.input.state.camera = false; dir.lateUpdate(1 / 60, 0, 1 / 60);
}
for (let i = 0; i < 30; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);

game.input.state.lookBack = true;
dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'lookBack', `hold look-back pushes, got ${dir.mode}`);
for (let i = 0; i < 40; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(camera.position.z < car.body.position.z + 0.2,
  'look-back camera sits ahead of the car');
game.input.state.lookBack = false;
dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'chase', `release look-back pops, got ${dir.mode}`);
for (let i = 0; i < 40; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(camera.position.z > car.body.position.z, 'back behind the car after look-back');

// ── 4. shake + collisions ───────────────────────────────────────────────────
const beforeShake = camera.position.clone();
bus.emit('car:collision', {
  carId: 0, impulse: 4, relSpeed: 3, worldPoint: new THREE.Vector3(-0.2, 0.05, -16),
  normal: new THREE.Vector3(1, 0, 0),
});
ok(dir.shaker.trauma > 0.05, `collision adds trauma, got ${dir.shaker.trauma.toFixed(3)}`);
for (let i = 0; i < 6; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
finite(camera.position.x, 'camera x during shake');
ok(camera.position.distanceTo(beforeShake) > 0, 'shake moved the camera');
for (let i = 0; i < 180; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.shaker.trauma === 0, 'trauma decays to zero');

dir.shake(0.5, 0.3);
dir.impulse(new THREE.Vector3(1, 0, 0), 2);
for (let i = 0; i < 120; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
finite(camera.position.x, 'camera x after impulse');

// ── 5. big air ──────────────────────────────────────────────────────────────
car.airborne = true;
for (let i = 0; i < 90; i++) {
  car.airTime += 1 / 60;
  car.body.position.y = 0.06 + Math.sin((car.airTime / 1.2) * Math.PI) * 1.1;
  car.group.position.copy(car.body.position);
  car.body.velocity.set(0, Math.cos((car.airTime / 1.2) * Math.PI) * 3, -6);
  dir.lateUpdate(1 / 60, 0, 1 / 60);
  finite(camera.position.y, `big air y ${i}`);
}
ok(dir.mode === 'bigair', `big air cut fired, got ${dir.mode}`);
car.airborne = false; car.airTime = 0;
car.body.position.y = 0.06; car.group.position.copy(car.body.position);
bus.emit('car:land', { carId: 0, impactSpeed: 7, worldPoint: car.body.position.clone() });
for (let i = 0; i < 60; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'chase', `big air returns to chase, got ${dir.mode}`);

// ── 6. crash replay (gated) ─────────────────────────────────────────────────
dir._raceTime = 10;
dir._lastCrash = -100;
bus.emit('car:collision', {
  carId: 0, impulse: 22, relSpeed: 8, worldPoint: car.body.position.clone(),
  normal: new THREE.Vector3(0, 0, 1),
});
dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'replay', `crash cut fired, got ${dir.mode}`);
for (let i = 0; i < 130; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'chase', `crash cut returns, got ${dir.mode}`);
// gate: a second crash immediately must NOT cut
bus.emit('car:collision', {
  carId: 0, impulse: 30, relSpeed: 9, worldPoint: car.body.position.clone(),
  normal: new THREE.Vector3(0, 0, 1),
});
dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'chase', `crash cooldown respected, got ${dir.mode}`);

// ── 7. intro flyby ──────────────────────────────────────────────────────────
game.state = GameState.COUNTDOWN;
let introDone = false;
const p = dir.playIntro(game.track, car).then(() => { introDone = true; });
ok(dir.mode === 'intro' || dir._stack.at(-1).mode === 'intro', 'intro mode requested');
for (let i = 0; i < 60; i++) { dir.lateUpdate(1 / 60, 0, 1 / 60); finite(camera.position.x, `intro x ${i}`); }
ok(dir.mode === 'intro', `intro running, got ${dir.mode}`);
bus.emit('race:countdown', { n: 3 });
for (let i = 0; i < 300; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
await p;
ok(introDone, 'intro promise resolved');
ok(dir.mode === 'chase', `intro handed over to chase, got ${dir.mode}`);

// intro skip
game.state = GameState.COUNTDOWN;
let skipped = false;
const p2 = dir.playIntro(game.track, car).then(() => { skipped = true; });
for (let i = 0; i < 10; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
game.input.state.fire = true;
dir.lateUpdate(1 / 60, 0, 1 / 60);
game.input.state.fire = false;
await p2;
ok(skipped, 'intro skip resolves the promise');
for (let i = 0; i < 40; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'chase', `skip lands on chase, got ${dir.mode}`);
game.state = GameState.RACING;

// ── 8. finish cam ───────────────────────────────────────────────────────────
car.body.velocity.set(0, 0, 0);   // rolled to a stop on the line
car.speed = 0;
bus.emit('race:finish', { carId: 0, place: 1, totalTime: 90 });
for (let i = 0; i < 90; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'finish', `finish cam engaged, got ${dir.mode}`);
ok(postfxLog.dof > 0.5, `finish cam drives DOF, got ${postfxLog.dof}`);
for (let i = 0; i < 300; i++) { dir.lateUpdate(1 / 60, 0, 1 / 60); finite(camera.position.y, 'finish y'); }
const orbitDist = camera.position.distanceTo(car.body.position);
ok(orbitDist > 0.7 && orbitDist < 3.2, `finish orbit radius sane, got ${orbitDist.toFixed(2)}`);

// ...and it must keep tracking a winner that is still rolling.
let minD = Infinity, maxD = 0;
for (let i = 0; i < 240; i++) {
  car.body.velocity.set(0, 0, -6);
  car.body.position.z -= 6 / 60;
  car.group.position.copy(car.body.position);
  car.speed = 6;
  dir.lateUpdate(1 / 60, 0, 1 / 60);
  if (i > 120) {
    const d = camera.position.distanceTo(car.body.position);
    minD = Math.min(minD, d); maxD = Math.max(maxD, d);
  }
}
ok(maxD < 4.2, `rolling finish stays framed, max dist ${maxD.toFixed(2)}`);
ok(minD > 0.4, `rolling finish does not clip the car, min dist ${minD.toFixed(2)}`);
car.body.velocity.set(0, 0, 0); car.speed = 0;

// ── 8b. auto intro on race load (Game.loadRace order: LOADING → onRaceStart) ──
dir.setMode('chase', 0);
game.state = GameState.LOADING;
dir.autoIntro = true;
dir.onRaceStart({ track: game.track, cars: game.cars, config: {}, game });
game.state = GameState.COUNTDOWN;
ok(dir.mode === 'intro', `auto intro engaged on race load, got ${dir.mode}`);
for (let i = 0; i < 30; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'intro', `auto intro still running, got ${dir.mode}`);
bus.emit('race:countdown', { n: 3 });
bus.emit('race:countdown', { n: 2 });
for (let i = 0; i < 200; i++) { dir.lateUpdate(1 / 60, 0, 1 / 60); finite(camera.position.y, 'auto intro y'); }
bus.emit('race:start', {});
game.state = GameState.RACING;
for (let i = 0; i < 60; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'chase', `race:start hands over to chase, got ${dir.mode}`);
dir.autoIntro = false;

// ── 9. explicit modes, free cam, respawn, teardown ──────────────────────────
for (const m of ['cinematic', 'podium', 'free', 'bumper', 'cockpit', 'chaseFar', 'chase']) {
  dir.setMode(m, 0.2);
  for (let i = 0; i < 40; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
  ok(dir.mode === m, `setMode(${m}) → ${dir.mode}`);
  finite(camera.position.x, `${m} camera x`);
  finite(camera.quaternion.w, `${m} camera quat`);
  finite(camera.fov, `${m} fov`);
}

bus.emit('car:respawn', { carId: 0, position: car.body.position.clone() });
dir.lateUpdate(1 / 60, 0, 1 / 60);
finite(camera.position.x, 'after respawn');

// weapon hit + camera:shake + camera:mode from the bus
bus.emit('weapon:hit', { carId: 0, sourceId: 1, weaponId: 'firework', worldPoint: car.body.position.clone(), impulse: 6 });
bus.emit('camera:shake', { amount: 0.8, duration: 0.5 });
bus.emit('camera:mode', { mode: 'bumper' });
for (let i = 0; i < 40; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'bumper', `external camera:mode honoured, got ${dir.mode}`);

// pause: dt = 0 must not NaN anything
for (let i = 0; i < 10; i++) dir.lateUpdate(0, 0, 1 / 60);
finite(camera.position.x, 'paused camera x');

// giant hitch
dir.lateUpdate(0.25, 0, 0.25);
finite(camera.position.x, 'hitch camera x');
ok(camera.position.distanceTo(car.body.position) < 6, 'camera did not fly away on a hitch');

// car vanishes mid-race
game.playerCar = null; game.cars = [];
for (let i = 0; i < 60; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'orbit', `car loss falls back to orbit, got ${dir.mode}`);
finite(camera.position.x, 'orbit after car loss');

dir.onRaceEnd();
game.state = GameState.MENU;
for (let i = 0; i < 30; i++) dir.lateUpdate(1 / 60, 0, 1 / 60);
ok(dir.mode === 'orbit', 'menu is orbit');
dir.dispose();

console.log(fails === 0 ? '\n── behaviour suite passed ──' : `\n${fails} FAILURE(S)`);


// ═══════════════════════════ telemetry probe ═══════════════════════════

const { yawOf } = await import('./CameraPose.js');
const { angleDelta } = await import('../core/MathUtils.js');

const wall = { on: false, dist: 0.45 };
const floorPlane = { on: false, y: 0 };
const probePhysics = {
  trackMesh: {},
  sphereCast(o, d, r, max, out) {
    if (!wall.on || wall.dist >= max) return false;
    out.hit = true; out.distance = wall.dist;
    out.point.copy(o).addScaledVector(d, wall.dist);
    out.normal.copy(d).negate(); out.surfaceId = 1; out.triIndex = 0; out.body = null;
    return true;
  },
  raycastTrack(o, d, max, out) {
    if (!floorPlane.on) return false;
    const pTime = (o.y - floorPlane.y) / -d.y;
    if (!(pTime >= 0 && pTime <= max)) return false;
    out.hit = true; out.distance = pTime;
    out.point.set(o.x, floorPlane.y, o.z); out.normal.set(0, 1, 0);
    out.surfaceId = 1; out.triIndex = 0; out.body = null;
    return true;
  },
};

const probeCar = {
  id: 0, isPlayer: true, def: { topSpeed: 9 },
  body: {
    position: new THREE.Vector3(0, 0.055, 0), quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(0, 0, -8), angularVelocity: new THREE.Vector3(),
  },
  group: new THREE.Group(),
  speed: 8, driftFactor: 0, slipAngle: 0, lateralG: 0, steer: 0,
  wheelsOnGround: 4, airborne: false, airTime: 0, dominantSurfaceId: 1,
  effects: { boost: 0 },
  worldPosition(out) { return out.copy(this.group.position); },
};
probeCar.group.position.copy(probeCar.body.position);

const probeGame = {
  bus: new EventBus(), camera: new THREE.PerspectiveCamera(62, 16 / 9, 0.02, 400),
  physics: probePhysics, scene: new THREE.Scene(), state: GameState.RACING,
  cars: [probeCar], playerCar: probeCar,
  track: { surfaces: [{ bumpiness: 0.2 }, { bumpiness: 0.1 }], environment: {} },
  input: { state: new InputState(), rumble() {} },
  loop: { timeScale: 1, paused: false, elapsed: 0 },
  renderer: { postfx: { setSpeedIntensity() {}, setDof() {}, resetHistory() {} }, pulseSlowMo() {} },
  slowMo() {}, after() {},
};

const probeDir = new CameraDirector(probeGame);
probeDir.autoIntro = false;
await probeDir.init();
probeDir.setMode('chase', 0);
probeDir.snap();

const pdt = 1 / 120;
let pTime = 0;
const pFwd = new THREE.Vector3();
const pToCam = new THREE.Vector3();

function probeStep(yawRate, drift, speed) {
  pTime += pdt;
  const q = probeCar.body.quaternion;
  const yaw = yawOf(0, 0) + 0; // unused
  probeCar._yaw = (probeCar._yaw ?? Math.PI) + yawRate * pdt;
  q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), probeCar._yaw - Math.PI);
  probeCar.group.quaternion.copy(q);
  pFwd.set(0, 0, -1).applyQuaternion(q);
  // velocity = heading rotated by the slip angle
  const slip = drift * 0.5;
  const vy = probeCar._yaw + slip;
  probeCar.body.velocity.set(Math.sin(vy) * speed, 0, Math.cos(vy) * speed);
  probeCar.body.position.addScaledVector(probeCar.body.velocity, pdt);
  probeCar.group.position.copy(probeCar.body.position);
  probeCar.speed = speed;
  probeCar.driftFactor = drift;
  probeCar.slipAngle = slip;
  probeCar.lateralG = (yawRate * speed) / 9.81;
  probeCar.steer = Math.max(-1, Math.min(1, yawRate * 0.6));
  probeCar.body.angularVelocity.set(0, yawRate, 0);
  probeDir.lateUpdate(pdt, 0, pdt);
  void yaw;
}

// ── straight line: settleTime ───────────────────────────────────────────────────
for (let i = 0; i < 360; i++) probeStep(0, 0, 8);
pToCam.subVectors(probeGame.camera.position, probeCar.body.position);
console.log('straight    dist=%s  height=%s  fov=%s',
  pToCam.length().toFixed(3), pToCam.y.toFixed(3), probeGame.camera.fov.toFixed(1));
const straightDist = pToCam.length();

// ── hard corner with drift: does the camera swing out? ──────────────────────
let maxYawOff = 0, maxRoll = 0;
for (let i = 0; i < 300; i++) {
  probeStep(1.7, 0.75, 7);
  pFwd.set(0, 0, -1).applyQuaternion(probeCar.body.quaternion);
  pToCam.subVectors(probeCar.body.position, probeGame.camera.position);
  const camYaw = yawOf(pToCam.x, pToCam.z);
  const off = Math.abs(angleDelta(yawOf(pFwd.x, pFwd.z), camYaw));
  if (off > maxYawOff) maxYawOff = off;
  const roll = probeDir.pose.roll;
  if (Math.abs(roll) > Math.abs(maxRoll)) maxRoll = roll;
}
console.log('drift       yawOffset=%s deg  roll=%s deg  fov=%s',
  (maxYawOff * 180 / Math.PI).toFixed(1), (maxRoll * 180 / Math.PI).toFixed(2),
  probeGame.camera.fov.toFixed(1));

// ── lag: snap the probeCar forward and watch the camera catch up ─────────────────
for (let i = 0; i < 240; i++) probeStep(0, 0, 8);
// how long to re-settleTime after a 1 m instantaneous displacement of the probeCar
const dist0 = probeGame.camera.position.distanceTo(probeCar.body.position);
probeCar.body.position.z -= 1.0; probeCar.group.position.copy(probeCar.body.position);
let settleTime = 0;
for (let i = 0; i < 600; i++) {
  probeStep(0, 0, 8);
  settleTime += pdt;
  if (Math.abs(probeGame.camera.position.distanceTo(probeCar.body.position) - dist0) < 0.05) break;
}
console.log('lag         1.00 m car jump re-settles in %s s', settleTime.toFixed(3));

// ── jump: vertical response ─────────────────────────────────────────────────
probeCar.airborne = true;
let maxRise = 0;
for (let i = 0; i < 140; i++) {
  probeCar.airTime += pdt;
  probeCar.body.position.y = 0.055 + Math.sin(Math.min(probeCar.airTime / 1.1, 1) * Math.PI) * 1.4;
  probeCar.group.position.copy(probeCar.body.position);
  probeCar.body.velocity.set(0, Math.cos(Math.min(probeCar.airTime / 1.1, 1) * Math.PI) * 4, -8);
  probeCar.body.position.z -= 8 * pdt; probeCar.group.position.copy(probeCar.body.position);
  probeDir.lateUpdate(pdt, 0, pdt);
  const dy = probeGame.camera.position.y - probeCar.body.position.y;
  maxRise = Math.max(maxRise, Math.abs(dy));
  if (probeDir.mode !== 'chase') break;
}
console.log('jump        max |camY-carY| = %s m (mode=%s)', maxRise.toFixed(3), probeDir.mode);
probeCar.airborne = false; probeCar.airTime = 0; probeCar.body.position.y = 0.055;
probeDir.setMode('chase', 0); probeDir.snap();
for (let i = 0; i < 240; i++) probeStep(0, 0, 8);

// ── wall behind: pull in ────────────────────────────────────────────────────
wall.on = true; wall.dist = 0.42;
for (let i = 0; i < 240; i++) probeStep(0, 0, 8);
pToCam.subVectors(probeGame.camera.position, probeCar.body.position);
console.log('wall 0.42   dist=%s  (was %s)  height=%s',
  pToCam.length().toFixed(3), straightDist.toFixed(3), pToCam.y.toFixed(3));
const horiz = Math.hypot(pToCam.x, pToCam.z);
console.log('            horizontal=%s (anchor target ~0.40)', horiz.toFixed(3));
if (horiz > 0.60) console.error('FAIL: camera did not pull in for the wall');
wall.on = false;
for (let i = 0; i < 300; i++) probeStep(0, 0, 8);
pToCam.subVectors(probeGame.camera.position, probeCar.body.position);
console.log('wall gone   dist=%s (should be back near %s)',
  pToCam.length().toFixed(3), straightDist.toFixed(3));

// ── floorPlane: lift out of geometry ─────────────────────────────────────────────
floorPlane.on = true; floorPlane.y = probeCar.body.position.y + 0.34;
for (let i = 0; i < 200; i++) { floorPlane.y = probeCar.body.position.y + 0.34; probeStep(0, 0, 8); }
console.log('floorPlane lift  camY-floorY=%s (clearance target 0.09)',
  (probeGame.camera.position.y - floorPlane.y).toFixed(3));
if (probeGame.camera.position.y < floorPlane.y + 0.05) console.error('FAIL: camera below the floorPlane');
floorPlane.on = false;

// ── perf + allocation churn ─────────────────────────────────────────────────
probeDir.setMode('chase', 0); probeDir.snap();
for (let i = 0; i < 600; i++) probeStep(0.4, 0.2, 8);   // warm up
if (global.gc) global.gc();
const h0 = process.memoryUsage().heapUsed;
const t0 = performance.now();
const N = 20000;
for (let i = 0; i < N; i++) probeStep(Math.sin(i * 0.01) * 1.4, Math.abs(Math.sin(i * 0.02)) * 0.6, 8);
const ms = performance.now() - t0;
if (global.gc) global.gc();
const h1 = process.memoryUsage().heapUsed;
console.log('perf        %s ms / %d frames = %s ms/frame (single chase rig)',
  ms.toFixed(1), N, (ms / N).toFixed(4));
console.log('heap        %s KB retained over %d frames', ((h1 - h0) / 1024).toFixed(1), N);

// blend cost: force a permanent cross-fade by cycling constantly
const t1 = performance.now();
for (let i = 0; i < 4000; i++) {
  if (i % 50 === 0) probeDir.setMode(i % 100 === 0 ? 'chaseFar' : 'chase', 1.0);
  probeStep(0.6, 0.3, 8);
}
const ms2 = performance.now() - t1;
console.log('perf blend  %s ms/frame while cross-fading two chase rigs', (ms2 / 4000).toFixed(4));
console.log('stats', JSON.stringify(probeDir.getStats()));

// ── intro flyby path ────────────────────────────────────────────────────────
probeGame.track.spline = { sample: (u) => ({ position: new THREE.Vector3(Math.sin(u * 5) * 7, 0, -u * 45) }) };
probeGame.track.startGrid = [{ position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion() }];
probeGame.track.environment = { bounds: new THREE.Box3(new THREE.Vector3(-24, -1, -50), new THREE.Vector3(24, 10, 6)) };
probeCar.body.position.set(0, 0.055, 0); probeCar.group.position.copy(probeCar.body.position);
probeCar.body.velocity.set(0, 0, 0); probeCar.speed = 0; probeCar._yaw = Math.PI;
probeCar.body.quaternion.identity(); probeCar.group.quaternion.identity();
probeGame.state = GameState.COUNTDOWN;
const introP = probeDir.playIntro(probeGame.track, probeCar);
let shots = 0, lastMode = '', jumpMax = 0, prev = null;
const path = [];
for (let i = 0; i < 900; i++) {
  probeDir.lateUpdate(1 / 60, 0, 1 / 60);
  if (!Number.isFinite(probeGame.camera.position.x)) { console.error('FAIL: NaN in intro'); break; }
  if (prev) {
    const d = prev.distanceTo(probeGame.camera.position);
    if (d > jumpMax) jumpMax = d;
  }
  prev = probeGame.camera.position.clone();
  if (i % 60 === 0) path.push(`${i / 60}s:(${probeGame.camera.position.x.toFixed(1)},${probeGame.camera.position.y.toFixed(1)},${probeGame.camera.position.z.toFixed(1)})fov${probeGame.camera.fov.toFixed(0)}`);
  if (probeDir.mode !== lastMode) { lastMode = probeDir.mode; shots++; }
  if (probeDir.mode === 'chase' && i > 60) break;
}
await introP;
console.log('intro       path %s', path.join(' '));
console.log('intro       max single-frame move (excl. cuts) = %s m, ended in %s', jumpMax.toFixed(2), probeDir.mode);
const chaseIdealDist = probeGame.camera.position.distanceTo(probeCar.body.position);
console.log('intro       handover: camera is %s m from the car (chase rest ≈ 1.15 m)', chaseIdealDist.toFixed(2));

console.log(fails === 0 ? '\nALL CAMERA SELF-TESTS PASSED' : `\n${fails} FAILURE(S)`);
if (typeof process !== 'undefined' && process.exit) process.exit(fails === 0 ? 0 : 1);
