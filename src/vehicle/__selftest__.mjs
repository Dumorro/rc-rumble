/**
 * RC RUMBLE — vehicle self test.
 *
 *   node src/vehicle/__selftest__.mjs
 *
 * Pure JS + three's maths — no DOM, no WebGL, no renderer. Every car in the
 * roster is built for real (real RigidBody, real Suspension, real AeroBody)
 * and driven by script. Nothing here is stubbed out: a test that passes
 * against a mock of the thing it is testing proves nothing about what ships.
 *
 * Covers the invariants that turned out to be silently broken:
 *
 *   • a car in free flight obeys CONFIG.physics.gravity and nothing else
 *   • no wheel that is touching nothing may push on the chassis
 *   • no uncommanded pitch/roll couple while airborne
 */

import * as THREE from 'three';

import { PhysicsWorld } from '../physics/PhysicsWorld.js';
import { CollisionMeshBuilder } from '../physics/CollisionMesh.js';
import { Car } from './Car.js';
import { CAR_DEFS } from './CarDefs.js';
import { EventBus } from '../core/EventBus.js';
import CONFIG from '../core/Config.js';

// ───────────────────────────────────────────────────────── harness

let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else {
    failed++; failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  — ${detail}` : ''}`);
  }
}
function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

const DT = CONFIG.physics.fixedDt;
const G = -CONFIG.physics.gravity;

/** A floor far enough below that nothing in these tests can reach it. */
function farFloor(half = 400, y = -120) {
  const b = new CollisionMeshBuilder();
  b.addTriangles([
    -half, y, -half, half, y, -half, half, y, half,
    -half, y, -half, half, y, half, -half, y, half,
  ], null, 1);
  return b.build();
}

/**
 * Build one car in an otherwise empty world, high in the air.
 *
 * The floor exists only so `physics.staticMeshes` is non-empty — Suspension
 * substitutes a virtual ground plane when the world has no collision at all,
 * and that would quietly put wheels on the ground in a test about being off it.
 */
function airborneCar(def, y = 40) {
  const bus = new EventBus();
  const world = new PhysicsWorld({ bus });
  world.addStaticGeometry(farFloor());
  const game = { bus, physics: world, cars: [], loop: { timeScale: 1 } };
  const car = new Car(game, def, { position: new THREE.Vector3(0, y, 0) });
  game.cars.push(car);
  world.addBody(car.body);
  return { car, world };
}

const COAST = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

function fly(car, world, steps) {
  let sawContact = false;
  for (let i = 0; i < steps; i++) {
    car.applyControl(COAST);
    car.fixedUpdate(DT);
    world.fixedUpdate(DT);
    if (car.wheels.some((w) => w.contact)) sawContact = true;
  }
  return sawContact;
}

// ═══════════════════════════════════════════════════════════════════════════
section('1 · A car in free flight obeys the gravity contract');
// ═══════════════════════════════════════════════════════════════════════════
//
// REGRESSION GUARD. Two separate forces used to be applied to a car with all
// four wheels in the air, and between them they governed every jump in the
// game:
//
//   · Suspension applied an "extension-stop droop force" per contactless
//     wheel, with no reaction body. Four of them summed to net weight, and
//     because springFront ≠ springRear on every car, to a pitch couple as
//     well. Measured before the fix: effective g 22.90–24.70 m/s² against the
//     documented 19.60 (+16.8 % to +26.0 %), with up to 14.35 rad/s² of
//     uncommanded pitch — about 20× the air control the player has.
//   · AeroBody applied 22 % of its on-ground downforce in flight. No couple
//     (it was applied at the COM) but still +1.66 % to +7.94 % of extra
//     gravity, and per-car, so one ramp threw each car a different distance.
//
// Track authors size jump geometry against CONFIG.physics.gravity. If this
// section goes red, jumps have silently stopped matching the number every
// track was built around — do not widen the tolerance to make it pass.
{
  let worstErr = 0, worstCar = '';
  for (const def of CAR_DEFS) {
    const { car, world } = airborneCar(def);
    car.body.velocity.set(0, 0, 0);
    car.body.angularVelocity.set(0, 0, 0);

    const vy0 = car.body.velocity.y;
    const steps = 40;
    const touched = fly(car, world, steps);
    const t = steps * DT;
    const g = (vy0 - car.body.velocity.y) / t;
    const err = Math.abs(g - G) / G * 100;

    if (err > worstErr) { worstErr = err; worstCar = def.id; }
    ok(`${def.id}: never touched the floor (the test is really airborne)`, !touched);
    ok(`${def.id}: effective gravity is ${g.toFixed(3)} m/s² (contract ${G})`,
      err <= 2.0, `${err.toFixed(2)} % off`);
  }
  console.log(`    worst deviation: ${worstErr.toFixed(2)} % (${worstCar})`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · A contactless wheel applies no force to the chassis');
// ═══════════════════════════════════════════════════════════════════════════
//
// The direct statement of the invariant, independent of how gravity comes out:
// step an airborne car and check the suspension reported zero load and zero
// force at every wheel. This is what section 1 is really testing, and it fails
// loudly rather than as a percentage if someone reintroduces a droop force.
{
  for (const def of CAR_DEFS) {
    const { car, world } = airborneCar(def);
    car.body.velocity.set(0, 2, -6);
    fly(car, world, 12);

    const anyLoad = car.wheels.some((w) => w.load !== 0 || w.suspensionForce !== 0);
    ok(`${def.id}: all four wheels report zero load in the air`, !anyLoad,
      car.wheels.map((w) => w.load.toFixed(3)).join(' / '));
    ok(`${def.id}: suspension.totalLoad is zero in the air`,
      car.suspension.totalLoad === 0, String(car.suspension.totalLoad));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · A jump with no input lands at the attitude it left at');
// ═══════════════════════════════════════════════════════════════════════════
//
// The player's air control is the ONLY thing that should rotate a car in
// flight. Before the fix a 0.45 s hop with the controls untouched landed
// vanster at −79° (nose-slam), needle at +41° and phantom at +36° tail-first.
{
  const FLIGHT = 0.45;
  const steps = Math.round(FLIGHT / DT);
  const fwd = new THREE.Vector3();
  let worst = 0, worstCar = '';

  for (const def of CAR_DEFS) {
    const { car, world } = airborneCar(def);
    // Launch on a ballistic arc: 7 m/s forward, up at the speed a 0.45 s hang
    // time implies. Level, and not rotating.
    car.body.velocity.set(0, G * FLIGHT * 0.5, -7);
    car.body.angularVelocity.set(0, 0, 0);
    fly(car, world, steps);

    car.body.getForward(fwd);
    const pitchDeg = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)) * 180 / Math.PI;
    if (Math.abs(pitchDeg) > Math.abs(worst)) { worst = pitchDeg; worstCar = def.id; }
    ok(`${def.id}: pitched ${pitchDeg.toFixed(2)}° over a ${FLIGHT} s jump with no input`,
      Math.abs(pitchDeg) < 5.0, `${pitchDeg.toFixed(2)}°`);
  }
  console.log(`    worst uncommanded pitch: ${worst.toFixed(2)}° (${worstCar})`);
}

// ───────────────────────────────────────────────────────── report

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log('\x1b[31mFailures:\x1b[0m\n  ' + failures.join('\n  '));
  process.exit(1);
}
process.exit(0);
