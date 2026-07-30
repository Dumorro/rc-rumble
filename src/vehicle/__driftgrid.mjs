/**
 * SCRATCH drift measurement grid. Not a self-test; deleted before hand-off.
 *   node src/vehicle/__driftgrid.mjs [carId] [surface]
 */

import * as THREE from 'three';

import { PhysicsWorld } from '../physics/PhysicsWorld.js';
import { CollisionMeshBuilder } from '../physics/CollisionMesh.js';
import { Car } from './Car.js';
import { CAR_DEFS } from './CarDefs.js';
import { EventBus } from '../core/EventBus.js';
import CONFIG from '../core/Config.js';

const DT = CONFIG.physics.fixedDt;
const DEG = 180 / Math.PI;

export const SURFACES = [
  { id: 1, name: 'wood', grip: 1.00 },
  { id: 7, name: 'gravel', grip: 0.55 },
  { id: 10, name: 'ice', grip: 0.18 },
];

/** A big flat floor of one surface id, installed as the TRACK mesh. */
function floorMesh(surfaceId, half = 400) {
  const b = new CollisionMeshBuilder();
  b.addTriangles([
    -half, 0, -half, half, 0, -half, half, 0, half,
    -half, 0, -half, half, 0, half, -half, 0, half,
  ], null, surfaceId);
  return b.build({ name: `floor:${surfaceId}` });
}

export function makeWorld(surfaceId) {
  const bus = new EventBus();
  const world = new PhysicsWorld({ bus });
  world.setTrack({ collision: floorMesh(surfaceId), surfaces: null });
  return { bus, world };
}

export function spawnCar(def, surfaceId) {
  const { bus, world } = makeWorld(surfaceId);
  const game = { bus, physics: world, cars: [], loop: { timeScale: 1 } };
  const car = new Car(game, def, { position: new THREE.Vector3(0, def.comHeight + 0.02, 0) });
  game.cars.push(car);
  world.addBody(car.body);
  return { car, world, game };
}

const IN = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
export function step(car, world, throttle, brake, steer, handbrake) {
  IN.throttle = throttle; IN.brake = brake; IN.steer = steer; IN.handbrake = handbrake;
  car.applyControl(IN);
  car.fixedUpdate(DT);
  world.fixedUpdate(DT);
}

const _vl = new THREE.Vector3();
/**
 * TRUE chassis slip angle, −180…180 deg.
 *
 * `car.slipAngle` is deliberately NOT this: it is `atan2(vx, |vz| + 0.22)`,
 * which is bounded to ±90 deg and flips sign when the car travels backwards.
 * That is the right shape for the steering assists that consume it, and the
 * wrong shape for a spin test — "slip > 100" can never fire against it.
 */
export function trueSlip(car) {
  const b = car.body;
  b.worldToLocalDir(b.velocity, _vl);
  const along = -_vl.z;
  if (Math.hypot(_vl.x, along) < 0.30) return 0;   // too slow to have a heading
  return Math.atan2(_vl.x, along) * DEG;
}

/**
 * One drift attempt.
 *
 * settle → launch to `entrySpeed` → entry flick → closed-loop countersteering
 * hold → full opposite lock recovery.
 */
export function runDrift(def, surfaceId, combo, opts = {}) {
  const entrySpeed = opts.entrySpeed ?? 7.4;
  const holdTime = opts.holdTime ?? 2.4;
  const recTime = opts.recTime ?? 1.0;
  const { car, world } = spawnCar(def, surfaceId);

  // ── settle ────────────────────────────────────────────────────────────
  for (let i = 0; i < 90; i++) step(car, world, 0, 0, 0, 0);

  // ── launch ────────────────────────────────────────────────────────────
  //
  // Traction-managed, and steering to hold a straight line. Open-loop full
  // throttle does not reach 7.4 m/s on ice on ANY rear-driven car: the driven
  // wheels sit at slip ratio 12, the rears have no lateral grip left, and the
  // car spins out at ~4.4 m/s from a straight-line launch. That is a property
  // of the launch, not of the drift, and it silently voided a third of the grid.
  let launched = false;
  const maxLaunch = Math.round(16 / DT);
  for (let i = 0; i < maxLaunch; i++) {
    let sr = 0;
    for (const w of car.wheels) if (w.isDriven) sr = Math.max(sr, Math.abs(w.slipRatio));
    const thr = Math.max(0.12, Math.min(1, 1 - (sr - 0.30) / 0.45));
    const hold = Math.max(-0.5, Math.min(0.5, -trueSlip(car) / 18 - car.yawRate * 0.30));
    step(car, world, thr, 0, hold, 0);
    if (car.speed >= entrySpeed && Math.abs(trueSlip(car)) < 3) { launched = true; break; }
  }
  if (!launched) {
    return { ok: false, reason: 'noSpeed', peakSlip: 0, entry: car.speed };
  }
  const entry = car.speed;

  // ── entry flick ───────────────────────────────────────────────────────
  // Flick LEFT: steer is negative, which yaws the nose left of the velocity
  // vector, which is a POSITIVE slip angle. The whole run is signed from here.
  let peakSlip = 0;
  let spun = false;
  let phase = '';
  const eSteps = Math.round(combo.entryTime / DT);
  for (let i = 0; i < eSteps; i++) {
    step(car, world, combo.entryThrottle, combo.entryBrake, -combo.entrySteer, combo.entryHb);
    const s = Math.abs(trueSlip(car));
    if (s > peakSlip) peakSlip = s;
    if (s > 100) { spun = true; phase = 'entry'; break; }
  }

  // ── hold: PD countersteer toward +`combo.target` ──────────────────────
  //
  // Controlled on the SIGNED slip toward a SIGNED target. Controlling |slip|
  // and re-applying the sign makes the law bang-bang across slip = 0 and
  // spins every car regardless of how it is set up — that is a property of
  // the driver, not the car, and it measures nothing.
  const target = combo.target;
  let prev = trueSlip(car);
  let best = 0, run = 0;
  let bandSum = 0, bandN = 0;
  const hSteps = Math.round(holdTime / DT);
  for (let i = 0; i < hSteps && !spun; i++) {
    const slip = trueSlip(car);
    const rate = (slip - prev) / DT;
    prev = slip;
    const steer = Math.max(-1, Math.min(1,
      combo.kp * (slip - target) / 45 + combo.kd * rate / 45));
    step(car, world, combo.holdThrottle, 0, steer, 0);

    const now = trueSlip(car);
    const a = Math.abs(now);
    if (a > peakSlip) peakSlip = a;
    if (a > 100) { spun = true; phase = 'hold'; break; }
    if (a >= 25 && a <= 50) {
      run += DT; bandSum += a; bandN++;
      if (run > best) best = run;
    } else run = 0;
  }
  const exit = Math.abs(car.speed);

  // ── recovery: full opposite lock, off throttle ────────────────────────
  let recovered = -1;
  if (!spun) {
    const lock = trueSlip(car) >= 0 ? 1 : -1;
    const rSteps = Math.round(recTime / DT);
    for (let i = 0; i < rSteps; i++) {
      step(car, world, 0.12, 0, lock, 0);
      const a = Math.abs(trueSlip(car));
      if (a > peakSlip) peakSlip = a;
      if (a > 100) { spun = true; phase = 'recover'; break; }
      if (a < 10) { recovered = (i + 1) * DT; break; }
    }
  }

  const meanBand = bandN > 0 ? bandSum / bandN : 0;
  const held = !spun && best >= 1.0 && exit >= 0.60 * entry && recovered >= 0;
  return {
    ok: true, held, spun, best, meanBand, peakSlip, entry, exit, phase,
    speedFrac: exit / entry, recovered,
    reason: spun ? `spun:${phase}`
      : best < 1.0 ? 'noBand'
        : exit < 0.60 * entry ? 'slow'
          : recovered < 0 ? 'noRecover' : 'ok',
  };
}

// ─────────────────────────────────────────────────────────── grid

export function buildGrid() {
  const out = [];
  for (const entrySteer of [0.75, 1.0]) {
    for (const entryHb of [0, 0.55, 1.0]) {
      for (const entryThrottle of [0.35, 1.0]) {
        for (const entryTime of [0.12, 0.25]) {
          for (const holdThrottle of [0.35, 0.65]) {
            for (const target of [30, 40]) {
              out.push({
                entrySteer, entryHb, entryThrottle, entryBrake: 0, entryTime,
                holdThrottle, target, kp: 1.5, kd: 0.22,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────── main

if (process.argv[1] && process.argv[1].endsWith('__driftgrid.mjs')) {
  const onlyCar = process.argv[2];
  const onlySurf = process.argv[3];
  const grid = buildGrid();
  const t0 = Date.now();

  // Plumbing check first — the harness bug that produced two retracted reports.
  for (const s of SURFACES) {
    const { car, world } = spawnCar(CAR_DEFS[0], s.id);
    for (let i = 0; i < 120; i++) step(car, world, 0.6, 0, 0, 0);
    const w = car.wheels[3];
    console.log(`  plumbing ${s.name}: floor=${s.id} wheel.surfaceId=${w.surfaceId} `
      + `surfaceGrip=${w.surfaceGrip.toFixed(3)} muEff=${w.tire.muEff.toFixed(3)} `
      + `contact=${w.contact} load=${w.load.toFixed(2)}`);
  }
  console.log('');

  for (const def of CAR_DEFS) {
    if (onlyCar && def.id !== onlyCar) continue;
    const line = [];
    for (const s of SURFACES) {
      if (onlySurf && s.name !== onlySurf) continue;
      let holds = 0, slow = 0, noBand = 0, noRec = 0, noSpeed = 0;
      const sp = { entry: 0, hold: 0, recover: 0 };
      let lo = 999, hi = 0, bestRun = 0, peak = 0;
      for (const c of grid) {
        const r = runDrift(def, s.id, c);
        if (!r.ok) { noSpeed++; continue; }
        if (r.peakSlip > peak) peak = r.peakSlip;
        if (r.held) {
          holds++;
          if (r.meanBand < lo) lo = r.meanBand;
          if (r.meanBand > hi) hi = r.meanBand;
          if (r.best > bestRun) bestRun = r.best;
        } else if (r.spun) sp[r.phase]++;
        else if (r.reason === 'slow') slow++;
        else if (r.reason === 'noBand') noBand++;
        else if (r.reason === 'noRecover') noRec++;
      }
      line.push(`${s.name.padEnd(6)} ${String(holds).padStart(2)}/${grid.length} hold`
        + (holds ? ` band ${lo.toFixed(0)}-${hi.toFixed(0)}° max ${bestRun.toFixed(2)}s` : '                    ')
        + ` | spinE ${sp.entry} spinH ${sp.hold} spinR ${sp.recover} slow ${slow} noBand ${noBand} noRec ${noRec} noSpd ${noSpeed} peak ${peak.toFixed(0)}°`);
    }
    console.log(`${def.id.padEnd(9)} ${line.join('\n          ')}`);
  }
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
