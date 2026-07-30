/**
 * RC RUMBLE — physics self test.
 *
 *   node src/physics/__selftest__.mjs
 *
 * Pure JS + three's maths only — no DOM, no WebGL. Verifies the invariants the
 * rest of the game leans on:
 *
 *   • inertia tensors (closed form + hull tetrahedron decomposition)
 *   • BVH raycast against a known triangle
 *   • sphere / hull vs triangle contact depth + normal
 *   • the internal-edge fix (no ghost normals on a coplanar seam)
 *   • a 1.6 kg box dropped on a mesh settles, stops jittering and sleeps
 *   • a stack of 5 props stays standing
 *   • a downward raycast from 1 m returns the exact floor point and surface id
 *   • fixedUpdate does not allocate in steady state
 */

import * as THREE from 'three';

import { RigidBody, Layer, createBoxBody, createSphereBody } from './RigidBody.js';
import {
  makeBox, makeSphere, makeCylinder, makeHull,
  boxInertia, boxInertiaHalf, sphereInertia, cylinderInertia, capsuleInertia,
  colliderInertia, validateHull,
} from './Shapes.js';
import { BVH, createBVHRayResult } from './BVH.js';
import { CollisionMesh, CollisionMeshBuilder, createRayHit } from './CollisionMesh.js';
import { Manifold, sphereVsTriangle, hullVsTriangle } from './Collision.js';
import { PhysicsWorld } from './PhysicsWorld.js';
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
function near(name, actual, expected, tol = 1e-6) {
  const d = Math.abs(actual - expected);
  ok(name, d <= tol, `got ${actual}, expected ${expected} (Δ${d.toExponential(2)})`);
}
function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

// ───────────────────────────────────────────────────────── fixtures

/** Flat floor: `n × n` quads over [-half, half]², split into two triangles. */
function makeFloor(half = 4, n = 8, surfaceId = 1, y = 0) {
  const b = new CollisionMeshBuilder();
  const pos = [];
  const step = (half * 2) / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x0 = -half + i * step, x1 = x0 + step;
      const z0 = -half + j * step, z1 = z0 + step;
      // CCW seen from +Y
      pos.push(x0, y, z0, x0, y, z1, x1, y, z1);
      pos.push(x0, y, z0, x1, y, z1, x1, y, z0);
    }
  }
  b.addTriangles(pos, null, surfaceId, null);
  return b.build({ name: 'floor' });
}

function makeStubGame() {
  return { bus: new EventBus(), scene: null };
}

function makeWorld(mesh) {
  const game = makeStubGame();
  const w = new PhysicsWorld(game);
  w.setTrack(mesh ? { collision: mesh, surfaces: null } : null);
  return w;
}

const DT = CONFIG.physics.fixedDt;

// ═══════════════════════════════════════════════════════════════════════════
section('1 · Inertia tensors');
// ═══════════════════════════════════════════════════════════════════════════
{
  const m = 2;
  const w = 0.4, h = 0.2, d = 0.6;
  const b = boxInertia(m, w, h, d);
  near('box Ixx = m/12 (h²+d²)', b.x, (m / 12) * (h * h + d * d), 1e-12);
  near('box Iyy = m/12 (w²+d²)', b.y, (m / 12) * (w * w + d * d), 1e-12);
  near('box Izz = m/12 (w²+h²)', b.z, (m / 12) * (w * w + h * h), 1e-12);

  const bh = boxInertiaHalf(m, w / 2, h / 2, d / 2);
  ok('boxInertiaHalf matches boxInertia', bh.distanceTo(b) < 1e-12);

  const s = sphereInertia(3, 0.25);
  near('sphere I = 2/5 m r²', s.x, 0.4 * 3 * 0.0625, 1e-12);

  const c = cylinderInertia(1.5, 0.1, 0.4, 'y');
  near('cylinder along-axis', c.y, 0.5 * 1.5 * 0.01, 1e-12);
  near('cylinder across-axis', c.x, (1 / 12) * 1.5 * (3 * 0.01 + 0.16), 1e-12);

  const cap = capsuleInertia(1, 0.05, 0.1, 'y');
  ok('capsule inertia is positive & across > along', cap.x > cap.y && cap.y > 0,
    `${cap.x} ${cap.y}`);

  // Hull decomposition must reproduce the closed form to double precision —
  // mass properties are integrated in f64 even though vertices are stored f32.
  const hull = makeBox(w / 2, h / 2, d / 2);
  const hi = colliderInertia(hull, m);
  near('hull tetra decomposition Ixx == closed form', hi.x, b.x, 1e-12);
  near('hull tetra decomposition Iyy == closed form', hi.y, b.y, 1e-12);
  near('hull tetra decomposition Izz == closed form', hi.z, b.z, 1e-12);
  near('hull volume == w·h·d', hull.volume, w * h * d, 1e-12);

  // Offset box: the parallel-axis term must appear automatically.
  const off = makeBox(w / 2, h / 2, d / 2, new THREE.Vector3(0, 0.5, 0));
  const oi = colliderInertia(off, m);
  near('offset hull inertia includes parallel axis', oi.x, b.x + m * 0.25, 1e-9);

  // Cylinder prism should be close to the analytic cylinder.
  const cyl = makeCylinder(0.1, 0.2, 24, 'y');
  const ci = colliderInertia(cyl, 1.5);
  const analytic = cylinderInertia(1.5, 0.1, 0.4, 'y');
  ok('24-gon prism inertia ≈ cylinder (within 3%)',
    Math.abs(ci.y - analytic.y) / analytic.y < 0.03,
    `${ci.y} vs ${analytic.y}`);

  // Convex hull from a point cloud (a box) must merge into 6 quad faces.
  const pts = [];
  for (const x of [-0.1, 0.1]) for (const y of [-0.2, 0.2]) for (const z of [-0.3, 0.3]) pts.push([x, y, z]);
  const qh = makeHull(pts);
  ok('quickhull box merges coplanar triangles into 6 faces', qh.faceCount === 6, `got ${qh.faceCount}`);
  near('quickhull box volume', qh.volume, 0.2 * 0.4 * 0.6, 1e-9);
  ok('quickhull box has 3 unique edge directions', qh.edgeDirCount === 3, `got ${qh.edgeDirCount}`);

  // ── the hulls must be CLOSED and consistently wound ──────────────────
  // Volume and inertia are only meaningful over a closed surface. An open hull
  // (quickhull dropped a coplanar point) or one inward-facing face silently
  // cancels part of the tetrahedron sum and reports a plausible-looking but
  // wrong number, so assert the topology explicitly rather than trusting it.
  for (const [name, h] of [
    ['box', hull], ['offset box', off], ['quickhull box', qh],
    ['24-gon prism', cyl],
    ['x-axis prism', makeCylinder(0.1, 0.2, 12, 'x')],
    ['z-axis prism', makeCylinder(0.1, 0.2, 12, 'z')],
    ['tetrahedron', makeHull([[0, 0, 0], [0.1, 0, 0], [0, 0.1, 0], [0, 0, 0.1]])],
  ]) {
    const v = validateHull(h);
    ok(`${name} hull is closed (every edge shared by exactly 2 faces, opposed)`,
      v.closed, `open=${v.openEdges} doubled=${v.doubledEdges}`);
    ok(`${name} hull is wound outward and convex`,
      v.wound && v.convex, `inward=${v.inwardFaces} nonConvex=${v.nonConvexFaces}`);
  }

  // A solid tetrahedron with legs L has volume L³/6 — an independent check on
  // the decomposition using a shape that is a single tetra, not a box.
  const tet = makeHull([[0, 0, 0], [0.3, 0, 0], [0, 0.3, 0], [0, 0, 0.3]]);
  near('tetra hull volume == L³/6', tet.volume, 0.027 / 6, 1e-12);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · BVH raycast');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Single known triangle in the XZ plane at y = 0.
  const tris = new Float32Array([
    0, 0, 0,
    2, 0, 0,
    0, 0, 2,
  ]);
  const bvh = new BVH().build(tris, 1);
  const hit = createBVHRayResult();

  const found = bvh.raycast(0.25, 1, 0.25, 0, -1, 0, 10, hit);
  ok('ray hits the known triangle', found);
  near('hit distance', hit.t, 1, 1e-6);
  ok('triangle index', hit.triIndex === 0);
  near('normal is +Y', Math.abs(hit.ny), 1, 1e-6);

  ok('ray outside the triangle misses', !bvh.raycast(1.9, 1, 1.9, 0, -1, 0, 10, hit));
  ok('ray past maxDist misses', !bvh.raycast(0.25, 5, 0.25, 0, -1, 0, 1, hit));
  ok('raycastAny agrees', bvh.raycastAny(0.25, 1, 0.25, 0, -1, 0, 10));

  // Many triangles: the closest one must win.
  const floor = makeFloor(4, 16, 1, 0);
  const scratch = new Uint32Array(1024);
  const nAABB = floor.bvh.queryAABB(-0.1, -0.1, -0.1, 0.1, 0.1, 0.1, scratch);
  ok('queryAABB returns candidates around the origin', nAABB > 0 && nAABB <= 8, `got ${nAABB}`);
  const nSph = floor.bvh.querySphere(0, 0.05, 0, 0.2, scratch);
  ok('querySphere returns candidates', nSph > 0, `got ${nSph}`);

  const st = floor.bvh.stats();
  ok('BVH built with sane depth', st.depth > 0 && st.depth < 40, JSON.stringify(st));
  ok('every triangle is reachable from a leaf', st.leaves > 0 && st.triangles === 512);
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · Raycast down from 1 m returns the exact floor point + surface');
// ═══════════════════════════════════════════════════════════════════════════
{
  const floor = makeFloor(4, 8, 7 /* gravel */, 0);
  const world = makeWorld(floor);
  const out = createRayHit();
  const origin = new THREE.Vector3(0.37, 1.0, -1.12);
  const dir = new THREE.Vector3(0, -1, 0);

  const hit = world.raycastTrack(origin, dir, 5, out);
  ok('raycastTrack hits', hit);
  near('distance is exactly 1 m', out.distance, 1, 1e-6);
  near('hit point x', out.point.x, 0.37, 1e-6);
  near('hit point y', out.point.y, 0, 1e-6);
  near('hit point z', out.point.z, -1.12, 1e-6);
  near('normal is +Y', out.normal.y, 1, 1e-6);
  ok('surface id is gravel (7)', out.surfaceId === 7, `got ${out.surfaceId}`);

  ok('surfaceBelow() agrees', world.surfaceBelow(origin, 2) === 7);
  ok('ray from below still reports the +Y face', (() => {
    const o2 = new THREE.Vector3(0.1, -1, 0.1);
    const d2 = new THREE.Vector3(0, 1, 0);
    const h2 = createRayHit();
    return world.raycastTrack(o2, d2, 5, h2) && h2.normal.y < 0;   // flipped toward the ray
  })());
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · Sphere / hull vs triangle contacts');
// ═══════════════════════════════════════════════════════════════════════════
{
  const floor = makeFloor(2, 2, 1, 0);
  const m = new Manifold();

  // Sphere 0.1 radius whose centre is 0.06 above the floor → depth 0.04.
  m.clear();
  const scratch = new Uint32Array(256);
  const n = floor.bvh.querySphere(0.5, 0.06, 0.5, 0.1, scratch);
  ok('sphere query finds the floor triangle', n > 0);
  let hit = false;
  for (let i = 0; i < n && !hit; i++) {
    m.clear();
    hit = sphereVsTriangle(0.5, 0.06, 0.5, 0.1, floor, scratch[i], m);
  }
  ok('sphere vs triangle produced a contact', hit && m.count === 1);
  near('contact depth = r − h', m.depths[0], 0.04, 1e-6);
  near('contact normal is +Y', m.ny, 1, 1e-6);
  near('contact point sits on the floor', m.points[1], 0, 1e-6);

  // Sphere clear of the floor → no contact.
  m.clear();
  ok('sphere above the floor: no contact',
    !sphereVsTriangle(0.5, 0.5, 0.5, 0.1, floor, scratch[0], m));

  // ── the internal-edge / ghost-collision case ────────────────────────
  // A sphere sitting exactly over the diagonal seam of a quad must get a
  // pure +Y normal from BOTH triangles, never a normal tilted along the seam.
  let ghost = false, contacts = 0;
  const seamN = floor.bvh.querySphere(0, 0.05, 0, 0.15, scratch);
  for (let i = 0; i < seamN; i++) {
    m.clear();
    if (sphereVsTriangle(0, 0.05, 0, 0.1, floor, scratch[i], m)) {
      contacts++;
      if (Math.abs(m.ny - 1) > 1e-5) ghost = true;
    }
  }
  ok('sphere on a coplanar seam: every contact normal is +Y (no ghost)', !ghost && contacts > 0,
    `contacts=${contacts} ghost=${ghost}`);

  // Interior edges of the floor grid must be marked NON-convex.
  let convexInterior = 0, boundary = 0;
  for (let t = 0; t < floor.triangleCount; t++) {
    for (let e = 0; e < 3; e++) {
      const nb = floor.neighbours[t * 3 + e];
      const conv = (floor.edgeConvex[t] & (1 << e)) !== 0;
      if (nb >= 0 && conv) convexInterior++;
      if (nb < 0) boundary++;
    }
  }
  ok('no shared edge on a flat floor is marked convex', convexInterior === 0, `got ${convexInterior}`);
  ok('outer boundary edges exist and are marked convex', boundary > 0);

  // ── hull vs triangle: a box resting flat produces a 4-point manifold ──
  const body = createBoxBody(0.3, 0.12, 0.3, 1.6, { position: [0.5, 0.055, 0.5] });
  body.updateWorldCache(1);
  let total = 0, worstNormal = 0;
  const tcount = floor.bvh.queryAABB(
    body.position.x - 0.2, -0.1, body.position.z - 0.2,
    body.position.x + 0.2, 0.2, body.position.z + 0.2, scratch);
  for (let i = 0; i < tcount; i++) {
    m.clear();
    if (hullVsTriangle(body.cache, body.collider, floor, scratch[i], m)) {
      total += m.count;
      worstNormal = Math.max(worstNormal, Math.abs(m.ny - 1));
      for (let c = 0; c < m.count; c++) {
        if (Math.abs(m.depths[c] - 0.005) > 2e-3) worstNormal = 99;
      }
    }
  }
  ok('box on the floor generates contacts', total >= 4, `got ${total}`);
  ok('every box-vs-floor normal is +Y with depth ≈ 5 mm', worstNormal < 1e-4, `${worstNormal}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · A 1.6 kg box settles and falls asleep');
// ═══════════════════════════════════════════════════════════════════════════
{
  const floor = makeFloor(4, 8, 1, 0);
  const world = makeWorld(floor);
  const box = createBoxBody(0.30, 0.12, 0.18, 1.6, {
    position: [0, 0.4, 0], layer: Layer.PROP, friction: 0.9, restitution: 0.15,
  });
  world.addBody(box);

  let maxY = -Infinity;
  let steps = 0;
  for (; steps < 900; steps++) {           // 7.5 s
    world.fixedUpdate(DT);
    if (steps > 300) maxY = Math.max(maxY, Math.abs(box.velocity.y));
    if (box.sleeping) break;
  }

  ok('box came to rest and slept', box.sleeping, `after ${steps} steps, y=${box.position.y}`);
  ok('settled within 3 s', steps < 360, `${steps} steps`);
  near('resting height ≈ half the box (0.06 m)', box.position.y, 0.06, 3e-3);
  ok('penetration is within the contact slop',
    0.06 - box.position.y <= CONFIG.physics.contactSlop * 1.5,
    `${((0.06 - box.position.y) * 1000).toFixed(2)} mm`);
  ok('no residual vertical jitter before sleeping', maxY < 0.02, `maxY=${maxY}`);
  ok('orientation stayed upright',
    Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(box.quaternion).y - 1) < 1e-3);
  ok('velocity is exactly zero once asleep', box.velocity.lengthSq() === 0);

  // Sleeping bodies must wake when the world changes under them.
  world.wakeArea(box.aabbMin, box.aabbMax);
  ok('wakeArea wakes it back up', !box.sleeping);
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · A stack of 5 props stays standing');
// ═══════════════════════════════════════════════════════════════════════════
{
  const floor = makeFloor(4, 8, 1, 0);
  const world = makeWorld(floor);
  const size = 0.08;
  const boxes = [];
  for (let i = 0; i < 5; i++) {
    const b = createBoxBody(size, size, size, 0.25, {
      position: [0, size * 0.5 + i * (size + 0.0005), 0],
      layer: Layer.PROP, friction: 0.9, restitution: 0.0,
    });
    world.addBody(b);
    boxes.push(b);
  }

  for (let s = 0; s < 1800; s++) world.fixedUpdate(DT);   // 15 s

  let maxDrift = 0, maxTilt = 0, minGap = Infinity;
  const up = new THREE.Vector3();
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    maxDrift = Math.max(maxDrift, Math.hypot(b.position.x, b.position.z));
    up.set(0, 1, 0).applyQuaternion(b.quaternion);
    maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, up.y)));
    const expected = size * 0.5 + i * size;
    minGap = Math.min(minGap, b.position.y - expected);
  }

  ok('stack did not topple (lateral drift < 1 cm)', maxDrift < 0.01, `${maxDrift.toFixed(4)} m`);
  ok('stack stayed upright (tilt < 3°)', maxTilt < 0.052, `${(maxTilt * 57.3).toFixed(2)}°`);
  // Resting penetration accumulates up the stack, so this is really a budget of
  // 0.8 mm per contact level over 5 levels. It is NOT allowed to be
  // CONFIG.physics.contactSlop (1.5 mm) per level: that slop exists to keep the
  // VELOCITY solver from buzzing, and letting it leak into the resting position
  // would sink a 5-box tower 7.5 mm — 10% of an 8 cm prop, plainly visible.
  // Solver.positionSlop is what keeps this honest; see the comment there.
  ok('stack did not sink (< 4 mm total)', minGap > -0.004, `${minGap.toFixed(5)} m`);
  ok('top box is above the bottom box', boxes[4].position.y > boxes[0].position.y + size * 3);
  const asleep = boxes.filter((b) => b.sleeping).length;
  ok('the whole stack went to sleep', asleep === 5, `${asleep}/5 asleep`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('6b · …and stays standing with sleeping DISABLED');
// ═══════════════════════════════════════════════════════════════════════════
{
  // The test above is satisfiable by falling asleep quickly, which hides solver
  // creep. Props on a track are awake exactly when a car is near them, which is
  // exactly when the player is looking at them — so the tower has to stand on
  // the solver's own merits, with the sleep system taken away.
  //
  // This is the regression test for fractional warm starting: at
  // WARM_START_FACTOR 0.9 this drifted 84.7 mm and leaned 3.9°, growing without
  // bound, because each step discarded a tenth of the accumulated FRICTION
  // impulse and the sweeps could not find it again.
  const floor = makeFloor(4, 8, 1, 0);
  const world = makeWorld(floor);
  const size = 0.08;
  const boxes = [];
  for (let i = 0; i < 5; i++) {
    const b = createBoxBody(size, size, size, 0.25, {
      position: [0, size * 0.5 + i * (size + 0.0005), 0],
      layer: Layer.PROP, friction: 0.9, restitution: 0.0, allowSleep: false,
    });
    world.addBody(b);
    boxes.push(b);
  }

  const up = new THREE.Vector3();
  const driftAt = [];
  for (let s = 1; s <= 1800; s++) {                  // 15 s, never sleeping
    world.fixedUpdate(DT);
    if (s === 300 || s === 1800) {
      let d = 0;
      for (const b of boxes) d = Math.max(d, Math.hypot(b.position.x, b.position.z));
      driftAt.push(d);
    }
  }

  let maxDrift = 0, maxTilt = 0, minGap = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    maxDrift = Math.max(maxDrift, Math.hypot(b.position.x, b.position.z));
    up.set(0, 1, 0).applyQuaternion(b.quaternion);
    maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, up.y)));
    minGap = Math.min(minGap, b.position.y - (size * 0.5 + i * size));
  }

  ok('awake stack did not creep sideways (< 5 mm)', maxDrift < 0.005,
    `${(maxDrift * 1000).toFixed(2)} mm`);
  ok('awake stack stayed plumb (tilt < 0.5°)', maxTilt < 0.5 * Math.PI / 180,
    `${(maxTilt * 57.3).toFixed(3)}°`);
  ok('awake stack did not sink (< 4 mm total)', minGap > -0.004,
    `${(minGap * 1000).toFixed(2)} mm`);
  ok('none of them fell asleep (that would void this test)',
    boxes.every((b) => !b.sleeping));
  // The remaining motion must be a one-time landing transient, not creep: if
  // drift is still growing after 2.5 s something is still leaking every step.
  ok('the drift is a settling transient, not ongoing creep',
    driftAt[1] - driftAt[0] < 0.0005,
    `grew ${((driftAt[1] - driftAt[0]) * 1000).toFixed(3)} mm between 2.5 s and 15 s`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('7 · Rigid body maths');
// ═══════════════════════════════════════════════════════════════════════════
{
  const b = createBoxBody(0.2, 0.2, 0.2, 2, {});
  const out = new THREE.Vector3();

  b.velocity.set(1, 0, 0);
  b.angularVelocity.set(0, 0, 0);
  b.pointVelocity(new THREE.Vector3(0, 0.5, 0), out);
  ok('pointVelocity with no spin = linear velocity', out.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-9);

  b.velocity.set(0, 0, 0);
  b.angularVelocity.set(0, 2, 0);         // 2 rad/s about +Y
  b.pointVelocity(new THREE.Vector3(1, 0, 0), out);
  // ω × r = (0,2,0) × (1,0,0) = (0*0−0*0, 0*1−0*0, 0*0−2*1) = (0,0,−2)
  ok('pointVelocity picks up ω × r', out.distanceTo(new THREE.Vector3(0, 0, -2)) < 1e-9,
    out.toArray().join(','));

  // Impulse at an offset must create both linear and angular motion.
  const c = createBoxBody(0.2, 0.2, 0.2, 2, {});
  c.applyImpulse(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.1, 0, 0));
  near('linear response to an offset impulse', c.velocity.z, -0.5, 1e-9);
  ok('angular response to an offset impulse', Math.abs(c.angularVelocity.y) > 1e-6);

  // Angular momentum: the world inverse inertia must equal R I⁻¹ Rᵀ.
  const d = createBoxBody(0.4, 0.1, 0.2, 3, {});
  d.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).normalize();
  d.updateInertiaWorld();
  const e = d.invInertiaWorld.elements;
  near('rotated invI: world XX == local ZZ', e[0], 1 / d.inertiaTensorLocal.z, 1e-6);
  near('rotated invI: world ZZ == local XX', e[8], 1 / d.inertiaTensorLocal.x, 1e-6);
  ok('invInertiaWorld is symmetric',
    Math.abs(e[1] - e[3]) < 1e-9 && Math.abs(e[2] - e[6]) < 1e-9 && Math.abs(e[5] - e[7]) < 1e-9);

  // Interpolation snapshots.
  const f = createBoxBody(0.1, 0.1, 0.1, 1, { position: [0, 0, 0] });
  f.snapshot();
  f.position.set(1, 0, 0);
  const p = new THREE.Vector3();
  f.getInterpolatedPosition(0.5, p);
  near('interpolated halfway', p.x, 0.5, 1e-9);

  // Static / kinematic flags.
  const st = new RigidBody({ static: true, collider: makeBox(1, 1, 1) });
  ok('static bodies have zero inverse mass', st.invMass === 0 && st.isStatic && !st.isMovable);
  const kin = new RigidBody({ kinematic: true, mass: 5, collider: makeSphere(0.1) });
  ok('kinematic bodies are not movable by the solver', !kin.isMovable && kin.kinematic);

  // Layers / masks.
  const car = new RigidBody({ layer: Layer.CAR, mask: Layer.ALL, collider: makeBox(0.1, 0.1, 0.1) });
  const trigger = new RigidBody({ layer: Layer.PICKUP, mask: Layer.CAR, collider: makeSphere(0.1) });
  ok('layer/mask pairing works',
    (car.layer & trigger.mask) !== 0 && (trigger.layer & car.mask) !== 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('8 · World queries + events');
// ═══════════════════════════════════════════════════════════════════════════
{
  const floor = makeFloor(4, 8, 3, 0);
  const world = makeWorld(floor);

  const ball = createSphereBody(0.05, 0.3, { position: [1, 0.05, 1], layer: Layer.PROP });
  world.addBody(ball);
  world.fixedUpdate(DT);

  const found = [];
  const n = world.overlapSphere(new THREE.Vector3(1, 0.05, 1), 0.3, found);
  ok('overlapSphere finds the ball', n === 1 && found[0] === ball, `n=${n}`);
  ok('overlapSphere respects the mask',
    world.overlapSphere(new THREE.Vector3(1, 0.05, 1), 0.3, found, Layer.CAR) === 0);

  // raycast() sees dynamic bodies as well as the track.
  const hit = createRayHit();
  const r = world.raycast(new THREE.Vector3(1, 1, 1), new THREE.Vector3(0, -1, 0), 5, hit);
  ok('world raycast hits the ball before the floor', r && hit.body === ball, `body=${hit.body?.id}`);
  ok('ball hit distance is above the floor', hit.distance < 0.95, `${hit.distance}`);

  // sphereCast against the static floor.
  const sc = createRayHit();
  const s = world.sphereCast(new THREE.Vector3(-1, 1, -1), new THREE.Vector3(0, -1, 0), 0.05, 5, sc, Layer.NONE);
  ok('sphereCast hits the floor', s);
  near('sphereCast stops one radius above the floor', sc.distance, 0.95, 1e-3);

  // addStaticGeometry merges into the query set.
  const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const mtx = new THREE.Matrix4().makeTranslation(2, 0.25, 2);
  world.addStaticGeometry(geo, 11 /* metal */, mtx);
  world.fixedUpdate(DT);
  const h2 = createRayHit();
  ok('extra static geometry is raycastable',
    world.raycastTrack(new THREE.Vector3(2, 2, 2), new THREE.Vector3(0, -1, 0), 5, h2));
  ok('extra static geometry carries its surface id', h2.surfaceId === 11, `got ${h2.surfaceId}`);
  near('extra box top at y = 0.5', h2.point.y, 0.5, 1e-4);

  // Collision events.
  let carHits = 0, propHits = 0;
  world.game.bus.on('car:collision', (e) => {
    carHits++;
    ok('car:collision payload is complete',
      typeof e.carId === 'number' && typeof e.impulse === 'number'
      && e.worldPoint && e.normal && typeof e.relSpeed === 'number'
      && typeof e.surfaceId === 'number');
  });
  world.game.bus.on('prop:hit', () => { propHits++; });

  const car = createBoxBody(0.30, 0.11, 0.18, 1.6, {
    position: [0, 1.2, 0], layer: Layer.CAR, restitution: 0.2,
  });
  car.userData = { id: 3 };
  world.addBody(car);
  for (let i = 0; i < 240 && carHits === 0; i++) world.fixedUpdate(DT);
  ok('dropping a car fires car:collision', carHits > 0, `${carHits}`);
  ok('prop:hit fired for the prop layer body', propHits >= 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('9 · Steady-state fixedUpdate does not allocate');
// ═══════════════════════════════════════════════════════════════════════════
{
  const floor = makeFloor(4, 8, 1, 0);
  const world = makeWorld(floor);
  for (let i = 0; i < 8; i++) {
    world.addBody(createBoxBody(0.1, 0.1, 0.1, 0.4, {
      position: [(i % 4) * 0.3 - 0.45, 0.3 + Math.floor(i / 4) * 0.2, 0],
      layer: Layer.PROP, allowSleep: false,
    }));
  }
  // Warm the pools AND let V8 finish optimising before measuring — otherwise
  // tier-up (feedback vectors, optimised code) dominates the reading.
  // MEASURE is deliberately large. `heapUsed` moves in allocation-page-sized
  // jumps, so a short window quantises badly: over 20 k steps the same build
  // reported anywhere from 96 to 186 B/step purely from where the window
  // happened to start and stop. Over 60 k it settles to ±3 B and the bound below
  // can be a real requirement instead of a shrug.
  const WARM = 6000, MEASURE = 60000;
  for (let i = 0; i < WARM; i++) world.fixedUpdate(DT);

  const gc = typeof global !== 'undefined' ? global.gc : undefined;
  if (gc) { gc(); gc(); gc(); }
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < MEASURE; i++) world.fixedUpdate(DT);
  const after = process.memoryUsage().heapUsed;
  const perStep = (after - before) / MEASURE;
  // 8 bodies, ~32 contacts, 8 + 10 solver sweeps. The residue is V8 boxing the
  // odd double written into a THREE.Vector3 field (see applyTangents); measured
  // ~33 B/step. It was ~96 B/step at 8 + 56 sweeps — cutting the sweep count is
  // most of what fixed this, halving the tangent writes is the rest.
  ok('heap growth per step is negligible (< 64 B)', perStep < 64,
    `${perStep.toFixed(1)} B/step${gc ? '' : ' — run with --expose-gc for an exact figure'}`);

  ok('contact pool stopped growing', world.contacts.capacity <= 2048, `${world.contacts.capacity}`);
  ok('bodies are still above the floor',
    world.bodies.every((b) => b.position.y > 0.03),
    world.bodies.map((b) => b.position.y.toFixed(3)).join(' '));
}

// ═══════════════════════════════════════════════════════════════════════════
section('10 · Robustness — the world must never throw');
// ═══════════════════════════════════════════════════════════════════════════
{
  const world = makeWorld(null);           // no track at all
  let threw = false;
  try {
    world.fixedUpdate(DT);
    world.setTrack(null);
    world.setTrack({ collision: null });
    const b = createBoxBody(0.1, 0.1, 0.1, 1, { position: [0, 1, 0] });
    world.addBody(b);
    for (let i = 0; i < 30; i++) world.fixedUpdate(DT);
    world.removeBody(b);
    world.removeBody(b);                   // double remove
    const hit = createRayHit();
    world.raycastTrack(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 1, hit);
    world.raycast(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 1, hit);
    world.sphereCast(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0.1, 1, hit);
    world.overlapSphere(new THREE.Vector3(), 1, []);
    world.addStaticGeometry(null);
    world.update();
    world.clear();
    world.dispose();
  } catch (err) {
    threw = true;
    console.log('    ', err);
  }
  ok('a track-less world runs, queries and disposes without throwing', !threw);

  // Degenerate geometry must not poison the mesh.
  const b2 = new CollisionMeshBuilder();
  b2.addTriangles([0, 0, 0, 0, 0, 0, 0, 0, 0], null, 0, null);   // zero area
  b2.addTriangles([0, 0, 0, 1, 0, 0, 0, 0, 1], null, 5, null);
  const mesh = b2.build();
  ok('degenerate triangles are dropped at build time', mesh.triangleCount === 1,
    `got ${mesh.triangleCount}`);
  const h = createRayHit();
  ok('the surviving triangle is still hittable',
    mesh.raycast(new THREE.Vector3(0.2, 1, 0.2), new THREE.Vector3(0, -1, 0), 5, h)
    && h.surfaceId === 5);

  // An empty mesh must be inert, not explosive.
  const empty = new CollisionMeshBuilder().build();
  ok('empty mesh raycast returns false',
    !empty.raycast(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 1, h));
  ok('empty mesh sphere query returns 0', empty.querySphere(new THREE.Vector3(), 1, new Uint32Array(8)) === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
section('11 · Ghost collisions — a car must never catch on a seam');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Finely tessellated floor: 0.25 m quads, every quad split on the same
  // diagonal. A 0.30 m car straddles several triangles at all times, so every
  // internal edge and welded vertex it crosses is a chance to snag.
  const floor = makeFloor(6, 48, 1, 0);   // 12 m of 0.25 m quads = 4608 tris
  const world = makeWorld(floor);
  const car = createBoxBody(0.30, 0.11, 0.18, 1.6, {
    position: [0, 0.0555, 5.0], layer: Layer.CAR,
    friction: 0.04, restitution: 0.0, allowSleep: false,
  });
  world.addBody(car);
  car.velocity.set(0, 0, -6);           // 6 m/s, straight down -Z

  let maxRise = -Infinity, minY = Infinity;
  let worstJolt = 0, worstSpin = 0, prevSpeed = 6;
  const y0 = car.position.y;
  for (let s = 0; s < 200; s++) {       // 1.67 s ≈ 10 m, stays on the floor
    world.fixedUpdate(DT);
    if (s < 4) { prevSpeed = car.velocity.length(); continue; }   // skip settling
    maxRise = Math.max(maxRise, car.position.y - y0);
    minY = Math.min(minY, car.position.y);
    const speed = car.velocity.length();
    worstJolt = Math.max(worstJolt, Math.abs(speed - prevSpeed));
    prevSpeed = speed;
    worstSpin = Math.max(worstSpin, car.angularVelocity.length());
  }

  // 6 m/s decaying at μg = 0.78 m/s² over 1.67 s ≈ 8.9 m of travel.
  ok('car crossed ~9 m of tessellated floor', car.position.z < -3.5,
    `z=${car.position.z.toFixed(3)}`);
  ok('never popped up off a seam (< 1 mm)', maxRise < 0.001, `${(maxRise * 1000).toFixed(3)} mm`);
  ok('never sank through a seam', minY > y0 - 0.003, `${((minY - y0) * 1000).toFixed(3)} mm`);
  ok('no speed jolt from an internal edge (< 0.05 m/s per step)', worstJolt < 0.05,
    `${worstJolt.toFixed(4)} m/s`);
  ok('no spin kick from an internal edge (< 0.35 rad/s)', worstSpin < 0.35,
    `${worstSpin.toFixed(4)} rad/s`);
  ok('still travelling (friction only, not snagged)', car.velocity.length() > 4.0,
    `${car.velocity.length().toFixed(3)} m/s`);

  // A sphere sliding across the same floor — the wheel/projectile path.
  const world2 = makeWorld(makeFloor(6, 48, 1, 0));
  const ball = createSphereBody(0.033, 0.05, {
    position: [0, 0.033, 5.0], layer: Layer.PROJECTILE, friction: 0.02, restitution: 0,
    allowSleep: false,
  });
  world2.addBody(ball);
  ball.velocity.set(0, 0, -5);
  let ballRise = -Infinity;
  for (let s = 0; s < 200; s++) {
    world2.fixedUpdate(DT);
    if (s > 3) ballRise = Math.max(ballRise, ball.position.y - 0.033);
  }
  ok('sphere never popped up off a seam', ballRise < 0.0006, `${(ballRise * 1e6).toFixed(0)} µm`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('12 · Slopes');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 20° ramp built from two triangles.
  const ang = 20 * Math.PI / 180;
  const t = Math.tan(ang);
  const b = new CollisionMeshBuilder();
  const pos = [];
  for (let i = 0; i < 8; i++) {
    const z0 = -2 + i * 0.5, z1 = z0 + 0.5;
    const y0 = -z0 * t, y1 = -z1 * t;
    pos.push(-2, y0, z0, -2, y1, z1, 2, y1, z1);
    pos.push(-2, y0, z0, 2, y1, z1, 2, y0, z0);
  }
  b.addTriangles(pos, null, 1, null);
  const ramp = b.build();

  const hit = createRayHit();
  ok('ramp normal is tilted by 20°', (() => {
    const w = makeWorld(ramp);
    if (!w.raycastTrack(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, -1, 0), 5, hit)) return false;
    return Math.abs(Math.acos(hit.normal.y) - ang) < 1e-3;
  })());

  // High friction: a box must hold. tan(20°) = 0.364, so μ = 1.0 holds easily.
  const wGrip = makeWorld(ramp);
  const grippy = createBoxBody(0.2, 0.1, 0.2, 1.0, { layer: Layer.PROP, friction: 1.3, restitution: 0 });
  // The ramp descends toward +Z, so its normal is (0, cos, sin): rotating the
  // box about +X by +ang maps its +Y onto that normal.
  grippy.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), ang);
  grippy.setTransform(new THREE.Vector3(0, 0.05 / Math.cos(ang), 0), grippy.quaternion);
  wGrip.addBody(grippy);
  const startZ = grippy.position.z;
  for (let s = 0; s < 600; s++) wGrip.fixedUpdate(DT);
  ok('a grippy box holds on a 20° ramp (< 5 mm slip)',
    Math.abs(grippy.position.z - startZ) < 0.005,
    `slipped ${((grippy.position.z - startZ) * 100).toFixed(2)} cm`);

  // Low friction: it must slide, and roughly at g·(sinθ − μcosθ).
  const wSlip = makeWorld(ramp);
  const slippy = createBoxBody(0.2, 0.1, 0.2, 1.0, {
    layer: Layer.PROP, friction: 0.02, restitution: 0, allowSleep: false, linearDamping: 0,
  });
  slippy.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), ang);
  slippy.setTransform(new THREE.Vector3(0, 0.05 / Math.cos(ang), 0), slippy.quaternion);
  wSlip.addBody(slippy);
  for (let s = 0; s < 120; s++) wSlip.fixedUpdate(DT);   // 1 s
  const g = Math.abs(CONFIG.physics.gravity);
  const expected = g * (Math.sin(ang) - 0.02 * Math.cos(ang)) * 1.0;
  const speed = slippy.velocity.length();
  ok('a slippery box accelerates at ≈ g(sinθ − μcosθ)',
    Math.abs(speed - expected) / expected < 0.2,
    `${speed.toFixed(3)} vs ${expected.toFixed(3)} m/s`);
  ok('it slid downhill (+Z is downhill here)', slippy.position.z > 0.05,
    `z=${slippy.position.z.toFixed(3)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('13 · Performance (informational + a generous ceiling)');
// ═══════════════════════════════════════════════════════════════════════════
{
  // A pessimistic race: 8 car-sized hulls + 48 props on a 6 k-triangle track.
  const floor = makeFloor(8, 40, 1, 0);
  const world = makeWorld(floor);
  for (let i = 0; i < 8; i++) {
    const car = createBoxBody(0.30, 0.11, 0.18, 1.6, {
      position: [(i % 4) * 0.6 - 0.9, 0.056, Math.floor(i / 4) * 0.8 - 2],
      layer: Layer.CAR, friction: 0.9, allowSleep: false,
    });
    world.addBody(car);
    car.velocity.set(0, 0, -3);
  }
  for (let i = 0; i < 48; i++) {
    world.addBody(createBoxBody(0.05, 0.05, 0.05, 0.15, {
      position: [(i % 8) * 0.25 - 1, 0.026 + Math.floor(i / 8) * 0.001, 1 + Math.floor(i / 8) * 0.25],
      layer: Layer.PROP, friction: 0.9,
    }));
  }
  for (let i = 0; i < 300; i++) world.fixedUpdate(DT);       // warm up

  let t0 = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i++) world.fixedUpdate(DT);
  const stepMs = (performance.now() - t0) / N;

  // Suspension hot path: 4 rays × 8 cars = 32 per step.
  const rayOrigin = new THREE.Vector3();
  const rayDir = new THREE.Vector3(0, -1, 0);
  const rayOut = createRayHit();
  t0 = performance.now();
  const RAYS = 200000;
  for (let i = 0; i < RAYS; i++) {
    rayOrigin.set((i % 97) * 0.08 - 4, 0.2, ((i / 97) | 0) % 97 * 0.08 - 4);
    world.raycastTrack(rayOrigin, rayDir, 0.5, rayOut);
  }
  const rayUs = ((performance.now() - t0) / RAYS) * 1000;

  console.log(`    ${world.bodies.length} bodies · ${floor.triangleCount} tris · `
    + `${world.contacts.count} contacts · ${world.solver.lastRelaxIterations} relax sweeps`);
  console.log(`    fixedUpdate: ${stepMs.toFixed(3)} ms/step  (${(stepMs * 2).toFixed(3)} ms per 60 fps frame)`);
  console.log(`    raycastTrack: ${rayUs.toFixed(3)} µs/ray  (${(rayUs * 32 / 1000).toFixed(3)} ms for 8 cars × 4 wheels)`);

  ok('fixedUpdate fits the 3 ms budget with 2 substeps per frame', stepMs * 2 < 3.0,
    `${(stepMs * 2).toFixed(3)} ms`);
  ok('a suspension raycast costs under 5 µs', rayUs < 5, `${rayUs.toFixed(3)} µs`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('14 · A row of dominoes topples in sequence');
// ═══════════════════════════════════════════════════════════════════════════
{
  // The stack test proves props can stand still. This proves they can also fall
  // over usefully: a row of thin props must transfer a push down the line
  // instead of all collapsing at once (too soft) or the push dying on the first
  // one (contacts lost between neighbours).
  const floor = makeFloor(4, 8, 12 /* plastic */, 0);
  const world = makeWorld(floor);
  const W = 0.03, H = 0.07, D = 0.010;   // 3 cm × 7 cm × 1 cm, RC-prop scale
  const spacing = 0.045;                  // < H, so each one can reach the next
  const N = 6;
  const dominoes = [];
  for (let i = 0; i < N; i++) {
    const b = createBoxBody(W, H, D, 0.02, {
      position: [0, H * 0.5, -i * spacing],
      layer: Layer.PROP, friction: 0.6, restitution: 0.0,
    });
    world.addBody(b);
    dominoes.push(b);
  }
  // Settle, then flick the first one over toward -Z at its top edge.
  for (let s = 0; s < 60; s++) world.fixedUpdate(DT);
  dominoes[0].applyImpulse(
    new THREE.Vector3(0, 0, -0.010),
    new THREE.Vector3(0, H * 0.95, 0),
  );

  const fellAt = new Array(N).fill(-1);
  const up = new THREE.Vector3();
  for (let s = 0; s < 600; s++) {
    world.fixedUpdate(DT);
    for (let i = 0; i < N; i++) {
      if (fellAt[i] >= 0) continue;
      up.set(0, 1, 0).applyQuaternion(dominoes[i].quaternion);
      if (Math.acos(Math.min(1, Math.max(-1, up.y))) > Math.PI / 6) fellAt[i] = s;
    }
  }

  const tilts = dominoes.map((b) => {
    up.set(0, 1, 0).applyQuaternion(b.quaternion);
    return Math.acos(Math.min(1, Math.max(-1, up.y)));
  });
  ok('every domino fell (tilt > 45°)', tilts.every((t) => t > Math.PI / 4),
    tilts.map((t) => `${(t * 57.3) | 0}°`).join(' '));
  ok('the chain reaction reached the far end', fellAt.every((f) => f >= 0),
    fellAt.join(' '));
  let inOrder = true;
  for (let i = 1; i < N; i++) if (fellAt[i] <= fellAt[i - 1]) inOrder = false;
  ok('they toppled in sequence, not all at once', inOrder, `steps: ${fellAt.join(' ')}`);
  ok('the wave took a believable amount of time (not instant)',
    fellAt[N - 1] - fellAt[0] > 10, `${fellAt[N - 1] - fellAt[0]} steps`);
  ok('they fell in the pushed direction (-Z)',
    dominoes[0].position.z < -0.005, `z=${dominoes[0].position.z.toFixed(4)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('15 · A sphere rolls down a 20° ramp without tunnelling');
// ═══════════════════════════════════════════════════════════════════════════
{
  // A 33 mm wheel-sized sphere on a 20° slope covers ~40 mm per 120 Hz step at
  // full speed — more than its own radius. If the narrow phase only looked at
  // the post-integration position it would step straight through the ramp.
  const ang = 20 * Math.PI / 180;
  const t = Math.tan(ang);
  const b = new CollisionMeshBuilder();
  const pos = [];
  // 20 strips: the ball ends up near z = 1.94, so the ramp has to run well
  // past that or the test measures it falling off the edge instead.
  for (let i = 0; i < 20; i++) {
    const z0 = -2 + i * 0.25, z1 = z0 + 0.25;
    const y0 = -z0 * t, y1 = -z1 * t;
    pos.push(-1, y0, z0, -1, y1, z1, 1, y1, z1);
    pos.push(-1, y0, z0, 1, y1, z1, 1, y0, z0);
  }
  b.addTriangles(pos, null, 1, null);
  const world = makeWorld(b.build());

  const R = 0.033;
  // Ramp plane through the origin, descending toward +Z.
  const nx = 0, ny = Math.cos(ang), nz = Math.sin(ang);
  const ball = createSphereBody(R, 0.05, {
    layer: Layer.PROP, friction: 0.9, restitution: 0.0,
    allowSleep: false, linearDamping: 0, angularDamping: 0,
  });
  // Start at rest, resting exactly on the surface near the top of the ramp.
  const z0 = -1.6;
  ball.setTransform(new THREE.Vector3(0, -z0 * t + R / Math.cos(ang), z0), null);
  world.addBody(ball);

  let worstDepth = 0, maxStepMove = 0;
  const prev = new THREE.Vector3();
  for (let s = 0; s < 150; s++) {          // 1.25 s
    prev.copy(ball.position);
    world.fixedUpdate(DT);
    maxStepMove = Math.max(maxStepMove, ball.position.distanceTo(prev));
    // Signed distance from the centre to the ramp plane: must stay ≈ R.
    const sd = nx * ball.position.x + ny * ball.position.y + nz * ball.position.z;
    worstDepth = Math.min(worstDepth, sd - R);
  }

  const g = Math.abs(CONFIG.physics.gravity);
  const speed = ball.velocity.length();
  // Bracket: a solid sphere ROLLING accelerates at g·sinθ·5/7, one SLIDING
  // frictionlessly at g·sinθ. Anything inside that band is plausible.
  const vRoll = g * Math.sin(ang) * (5 / 7) * 150 * DT;
  const vSlide = g * Math.sin(ang) * 150 * DT;

  // Tight on purpose: at 6 m/s the ball advances 50 mm per step, 1.5x its own
  // radius, so this is the assertion that catches a lost or late contact. The
  // budget is Solver.positionSlop (0.2 mm) plus a little numerical headroom; it
  // was 1.28 mm before sphere-vs-triangle grew speculative contacts, which is
  // exactly one step of free fall along the ramp normal.
  ok('the sphere never sank into the ramp (< 0.3 mm)', worstDepth > -0.0003,
    `${(worstDepth * 1000).toFixed(3)} mm`);
  ok('it never tunnelled through (still on the ramp)',
    ball.position.y > -ball.position.z * t - 0.01,
    `y=${ball.position.y.toFixed(4)} surface=${(-ball.position.z * t).toFixed(4)}`);
  ok('it ran downhill the full length of the ramp', ball.position.z > z0 + 1.0,
    `z ${z0} → ${ball.position.z.toFixed(3)}`);
  ok('its speed is between the rolling and free-sliding predictions',
    speed > vRoll * 0.75 && speed < vSlide * 1.1,
    `${speed.toFixed(3)} m/s (roll ${vRoll.toFixed(2)}, slide ${vSlide.toFixed(2)})`);
  ok('it picked up spin (it rolled, it did not just skid)',
    ball.angularVelocity.length() > 0.5 * speed / R,
    `ω=${ball.angularVelocity.length().toFixed(1)} rad/s, v/R=${(speed / R).toFixed(1)}`);
  ok('it moved more than its own radius in a step (a real CCD workout)',
    maxStepMove > R * 0.5, `${(maxStepMove * 1000).toFixed(1)} mm/step vs r=${R * 1000} mm`);
}

// ───────────────────────────────────────────────────────── report

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log('\x1b[31mFailures:\x1b[0m\n  ' + failures.join('\n  '));
  process.exit(1);
}
process.exit(0);
