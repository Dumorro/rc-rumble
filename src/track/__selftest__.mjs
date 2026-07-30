/**
 * RC RUMBLE — track self test.
 *
 *   node src/track/__selftest__.mjs
 *
 * Pure JS + three's maths — no DOM, no WebGL. A track builds perfectly well
 * headlessly (`getMaterials(null)` returns null, `TrackBuilder.mat()` falls
 * back, `finishLine`/`banner` no-op without `assets`), so the CollisionMesh
 * these tests measure is the one the game actually drives on.
 *
 * The point of this file is the DRIVABILITY GATE FIXTURES.
 *
 * `tools/drivability.mjs` fails `npm run check` when a registered track cannot
 * be lapped. A gate that has only ever been seen green is worth nothing — it
 * could be asserting nothing at all and look identical. So the fixtures below
 * build deliberately-broken tracks and assert the gate goes RED on each of the
 * four failure modes it claims to cover:
 *
 *   • a wall across the racing line               (the Back Garden's house)
 *   • a start-grid slot inside a declared gap     (the Back Garden's deck jump)
 *   • a spawn point buried in solid geometry      (the museum's respawn #11)
 *   • a hole in the road that is not a jump gap
 *
 * plus a clean control track that must stay GREEN, so a fixture that goes red
 * for the wrong reason cannot hide.
 *
 * The rest is regression cover for the specific defects that gate found.
 */

import * as THREE from 'three';

import { TrackBuilder } from './TrackBuilder.js';
import { SurfaceId, SURFACES, getSurface } from './Surfaces.js';
import { SplineSample } from './Spline.js';
import garden from './tracks/garden.js';
import toyMuseum from './tracks/toy_museum.js';
import { auditBuiltTrack, auditTrackModule, DRIVABILITY } from '../../tools/drivability.mjs';

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

// ───────────────────────────────────────────────────────── fixtures

/**
 * A minimal but complete track: a 60 m oval of concrete road on a slab, with a
 * finish line, checkpoints, a grid and respawns. Everything the gate looks at.
 * `extra(b)` runs after the road so a fixture can break exactly one thing.
 */
function ovalTrack(id, extra = null) {
  return {
    id,
    name: id,
    seed: 4242,
    build(b) {
      const nodes = [];
      const RX = 14, RZ = 9;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        nodes.push({ p: [Math.sin(a) * RX, 0, -Math.cos(a) * RZ], w: 3.0 });
      }
      b.centerline(nodes, { closed: true });
      b.defaultSurface(SurfaceId.CONCRETE);
      b.floor({
        center: [0, 0], size: [RX * 3, RZ * 4], y: -0.02,
        material: 'concrete/screed', surfaceId: SurfaceId.CONCRETE,
      });
      b.road({ material: 'concrete/poured', surfaceId: SurfaceId.CONCRETE });
      if (extra) extra(b);
      b.checkpoints({ count: 8 });
      b.startGrid({ count: 8, columns: 2 });
      b.respawns({ spacing: 8 });
      b.aiPath({ spacing: 3 });
    },
  };
}

/** Build a module and audit it, without going through the registry. */
function audit(mod) {
  return auditTrackModule(mod);
}

const kinds = (a) => a.findings.map((f) => f.kind);
const messages = (a) => a.findings.map((f) => `${f.kind}: ${f.message}`).join(' | ');

// ═══════════════════════════════════════ 1. the gate's control case

section('Drivability gate — the control must be GREEN');
{
  const clean = audit(ovalTrack('fixture_clean'));
  ok('a plain oval passes the drivability gate with zero findings',
    clean.total === 0,
    `${clean.total} finding(s): ${messages(clean)} `
    + `blocked=${clean.blocked.length} noGround=${clean.noGround.length}`);
  ok('…and the gate really did walk it (hundreds of stations, no gaps)',
    clean.stations > 100 && clean.gapStations === 0,
    `${clean.stations} stations, ${clean.gapStations} in gaps`);
  ok('…and it found real collision geometry to walk against',
    clean.track.collision.triangleCount > 100,
    `${clean.track.collision.triangleCount} tris`);
}

// ═══════════════════════════════════════ 2. RED: a wall across the line

section('Drivability gate — RED on a wall across the racing line');
{
  // This is the Back Garden's bug in miniature: a solid slab laid straight
  // across the racing line, exactly as `buildHouseAndFence` laid two of them
  // over the start/finish straight.
  const walled = audit(ovalTrack('fixture_walled', (b) => {
    const p = b.point(0.25, 0, 0);
    b.wall([p.x - 4, p.z], [p.x + 4, p.z], {
      thickness: 0.4, height: 3.0,
      material: 'brick/red', surfaceId: SurfaceId.CONCRETE,
    });
  }));
  ok('a wall across the line is reported as BLOCKED',
    walled.blocked.length > 0, `${walled.blocked.length} blocked probes`);
  ok('…at the lap fraction where the wall actually is',
    walled.blocked.some((x) => Math.abs(x.t - 0.25) < 0.02),
    `t values: ${[...new Set(walled.blocked.map((x) => x.t.toFixed(3)))].slice(0, 6).join(', ')}`);
  ok('…across the full width of the corridor, not just one lane',
    new Set(walled.blocked.map((x) => x.lane)).size >= 3,
    `${new Set(walled.blocked.map((x) => x.lane)).size} distinct lanes`);
  ok('…and the track therefore fails the gate',
    walled.total > 0, `${walled.total}`);
}

// ═══════════════════════════════════ 3. GREEN: a ramp is not a wall

section('Drivability gate — a ramp you drive up is NOT a wall');
{
  // The single most important false-positive to avoid: every kicker, ramp and
  // staircase in the game presents a steep face. Only the ones you drive INTO
  // count. A 12° ramp across the line must stay green.
  const ramped = audit(ovalTrack('fixture_ramp', (b) => {
    const a = b.point(0.25, 0, 0);
    const c = b.point(0.28, 0, 0);
    b.ramp({
      from: [a.x, 0, a.z], to: [c.x, 0.35, c.z],
      width: 3.4, thickness: 0.06,
      material: 'wood/plywood_varnish', surfaceId: SurfaceId.WOOD,
      support: false, lead: 0,
    });
  }));
  ok('a ramp laid along the racing line does not trip the corridor test',
    ramped.blocked.length === 0,
    `${ramped.blocked.length} blocked: ${ramped.blocked.slice(0, 2)
      .map((x) => `t=${x.t.toFixed(3)} [${x.point.x.toFixed(2)},${x.point.y.toFixed(2)},${x.point.z.toFixed(2)}]`).join(', ')}`);
}

// ═══════════════════════════════ 4. RED: a spawn slot over a jump gap

section('Drivability gate — RED on a spawn point over a declared gap');
{
  // The Back Garden shipped with grid slots 4-7 floating 0.40-0.94 m above the
  // deck jump. `startGrid()` now walks the grid back past a gap, so the bug can
  // no longer be built by hand — the fixture reproduces it by moving a slot
  // into the gap after the fact, which is precisely the state the gate has to
  // catch however it arises.
  const built = (() => {
    const mod = ovalTrack('fixture_gap', (b) => {
      b.jumpGap(0.30, 0.36, { lip: false });
    });
    const b = new TrackBuilder(null, { id: mod.id, seed: mod.seed });
    mod.build(b);
    return { builder: b, track: b.build() };
  })();

  const before = auditBuiltTrack(built.track, built.builder);
  ok('the oval with a declared jump gap is otherwise clean',
    before.total === 0, `${before.total}: ${messages(before)}`);
  ok('…and the gate skipped the gap rather than calling it a hole',
    before.gapStations > 0, `${before.gapStations} gap stations`);

  // Now drop grid slot 0 into the middle of the gap, in mid-air.
  const s = built.builder.spline.sample(0.33, new SplineSample());
  built.track.startGrid[0].position.copy(s.position).addScaledVector(s.normal, 0.6);

  const after = auditBuiltTrack(built.track, built.builder);
  ok('a grid slot inside a declared jump gap is reported',
    after.findings.some((f) => f.kind === 'startGrid' && /jump gap/.test(f.message)),
    messages(after));
  ok('…and the track fails the gate', after.total > 0, `${after.total}`);
}

// ═══════════════════════ 5. RED: a spawn point buried in geometry

section('Drivability gate — RED on a spawn point inside solid geometry');
{
  const built = (() => {
    const mod = ovalTrack('fixture_buried');
    const b = new TrackBuilder(null, { id: mod.id, seed: mod.seed });
    mod.build(b);
    return { builder: b, track: b.build() };
  })();
  // The museum's respawn #11 sat 0.44 m inside a display-case plinth: the
  // downward probe from above the slot lands on the TOP of the thing the car is
  // inside, so the measured "drop" comes out negative. Reproduce exactly that.
  const r = built.track.respawns[2];
  const box = new THREE.BoxGeometry(1.2, 0.3, 1.2);
  built.builder.addCollisionOnly(
    box, SurfaceId.WOOD,
    new THREE.Matrix4().setPosition(r.position.x, r.position.y + 0.40, r.position.z),
  );
  box.dispose();
  // Rebuild only the collision mesh; everything else about the track is intact.
  built.track.collision = built.builder._collision.build({ name: 'fixture' });

  const a = auditBuiltTrack(built.track, built.builder);
  ok('a respawn buried in a solid block is reported',
    a.findings.some((f) => f.kind === 'respawns'
      && /(INSIDE the geometry|wall .* from the car)/.test(f.message)),
    messages(a));
}

// ═══════════════════════════════ 6. RED: a hole that is not a jump gap

section('Drivability gate — RED on a hole in the road');
{
  // A track whose road simply stops: no floor, no declared gap. This is what a
  // mis-set `from`/`to` on a `road()` call produces, and it is invisible to
  // every other check in the repo.
  const holed = {
    id: 'fixture_hole',
    name: 'fixture_hole',
    seed: 7,
    build(b) {
      const nodes = [];
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * Math.PI * 2;
        nodes.push({ p: [Math.sin(ang) * 14, 0, -Math.cos(ang) * 9], w: 3.0 });
      }
      b.centerline(nodes, { closed: true });
      b.defaultSurface(SurfaceId.CONCRETE);
      // Road everywhere EXCEPT t 0.40..0.50, and no floor slab under it.
      b.road({ from: 0.5, to: 1.4, material: 'concrete/poured', surfaceId: SurfaceId.CONCRETE });
      b.checkpoints({ count: 8 });
      b.startGrid({ count: 8, columns: 2 });
      b.respawns({ spacing: 8 });
      b.aiPath({ spacing: 3 });
    },
  };
  const a = audit(holed);
  ok('an undeclared hole in the road is reported as NO GROUND',
    a.noGround.length > 0, `${a.noGround.length} stations`);
  ok('…at the lap fractions where the road is actually missing',
    a.noGround.every((x) => x.t > 0.38 && x.t < 0.52),
    `t range ${Math.min(...a.noGround.map((x) => x.t)).toFixed(3)}..`
    + `${Math.max(...a.noGround.map((x) => x.t)).toFixed(3)}`);
}

// ═══════════════════════════════════ 7. the shipped tracks must be green

section('The shipped tracks can be lapped');
{
  for (const mod of [toyMuseum, garden]) {
    const a = audit(mod);
    ok(`${mod.id} passes the drivability gate`,
      a.total === 0,
      `${a.total} finding(s) · ${a.blocked.length} blocked · ${a.noGround.length} no-ground · `
      + messages(a));
  }
}

// ═══════════════════════════ 8. regressions the gate found

section('Regressions — the Back Garden');
{
  const { track, builder } = audit(garden);

  // The house. The start straight runs INSIDE the footprint (x -46..-30,
  // z -6..+16), so both walls it crosses must have a real hole in them. Count
  // collision triangles that actually lie in each wall plane, inside the
  // doorway's x range, in the band a car occupies. Zero, or the car is in a box.
  const DOORWAY = { x0: -40.6, x1: -35.0, y0: 0.06, y1: 2.0 };
  const scratch = new Uint32Array(8192);
  const min = new THREE.Vector3();
  const max = new THREE.Vector3();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Cv = new THREE.Vector3();
  for (const z of [-6, 16]) {
    min.set(DOORWAY.x0, DOORWAY.y0, z - 0.25);
    max.set(DOORWAY.x1, DOORWAY.y1, z + 0.25);
    const n = track.collision.queryAABB(min, max, scratch);
    let inside = 0;
    for (let k = 0; k < n; k++) {
      track.collision.getTriangle(scratch[k], A, B, Cv);
      const all = [A, B, Cv].every((v) => (
        v.x >= DOORWAY.x0 - 1e-3 && v.x <= DOORWAY.x1 + 1e-3
        && v.y >= DOORWAY.y0 - 1e-3 && v.y <= DOORWAY.y1 + 1e-3
        && Math.abs(v.z - z) <= 0.25 + 1e-3
      ));
      if (all) inside++;
    }
    ok(`the house wall at z = ${z} has an opening on the racing line`,
      inside === 0, `${inside} collision triangle(s) still block the doorway`);
  }

  // The start grid must be behind the finish line and out of the deck jump.
  const inGap = track.startGrid.filter((s) => builder.isGap(builder.tNear(s.position)));
  ok('no start-grid slot is inside the deck jump gap', inGap.length === 0,
    `${inGap.length} of ${track.startGrid.length}`);
  ok('the grid still has the 8 slots the contract requires',
    track.startGrid.length >= 8, `${track.startGrid.length}`);
  // Slots must run BACKWARDS from the line, never past it.
  const finishT = 0;
  const backwards = track.startGrid.every((s, i) => {
    if (i === 0) return true;
    const a = builder.spline.wrapT(finishT - track.startGrid[i - 1].t);
    const c = builder.spline.wrapT(finishT - s.t);
    return c >= a - 1e-6;
  });
  ok('grid slots are ordered backwards from the finish line', backwards);

  // The deck. The ramp must arrive AT deck height, not under the deck.
  const deckY = 1.10;
  let onDeck = false;
  const smp = new SplineSample();
  for (let i = 0; i < 4000; i++) {
    builder.spline.sample(i / 4000, smp);
    if (Math.abs(smp.position.x - (-34)) < 0.15 && smp.position.z > 24 && smp.position.z < 36) {
      onDeck = Math.abs(smp.position.y - deckY) < 0.08;
      break;
    }
  }
  ok('the deck ramp reaches deck height at the deck edge (x = -34)', onDeck);
}

section('Regressions — surfaces');
{
  const grass = getSurface(SurfaceId.GRASS);
  const gravel = getSurface(SurfaceId.GRAVEL);
  ok('grass costs more rolling resistance than gravel',
    grass.rollingResistance > gravel.rollingResistance,
    `grass ${grass.rollingResistance} vs gravel ${gravel.rollingResistance}`);
  ok('grass is not free on every channel at once (the lawn must not be a line)',
    !(grass.rollingResistance < gravel.rollingResistance
      && grass.drag < gravel.drag
      && grass.bumpiness < gravel.bumpiness),
    `grass roll/drag/bump ${grass.rollingResistance}/${grass.drag}/${grass.bumpiness}, `
    + `gravel ${gravel.rollingResistance}/${gravel.drag}/${gravel.bumpiness}`);
  // CarSystem reads rollingResistance as a multiple of 0.018 when <= 0.2 and
  // clamps at 8, so a value above 0.144 is silently truncated.
  for (const s of SURFACES) {
    if (s.rollingResistance > 0.2) {
      ok(`surface ${s.id} (${s.name}) rolling resistance is in multiplier range`, false,
        `${s.rollingResistance} > 0.2 is read as an ABSOLUTE coefficient by CarSystem`);
    }
  }
  ok('every surface rolling resistance stays inside CarSystem\'s multiplier range',
    SURFACES.every((s) => s.rollingResistance <= 0.2));
  ok('the ARCHITECTURE.md grip column is unchanged',
    getSurface(SurfaceId.GRASS).grip === 0.60
    && getSurface(SurfaceId.GRAVEL).grip === 0.55
    && getSurface(SurfaceId.ICE).grip === 0.18);
}

section('Regressions — TrackBuilder');
{
  // `ramp()` used to stack a `th·cos(pitch)` hump on top of its own foot.
  const b = new TrackBuilder(null, { id: 'rampcheck', seed: 1 });
  b.centerline([
    { p: [-6, 0, 0], w: 3 }, { p: [0, 0, -6], w: 3 },
    { p: [6, 0, 0], w: 3 }, { p: [0, 0, 6], w: 3 },
  ], { closed: true });
  b.ramp({
    from: [0, 0, -6], to: [3, 0.5, -6],
    width: 2.0, thickness: 0.10, surfaceId: SurfaceId.WOOD, support: false, lead: 0.9,
  });
  const mesh = b.build().collision;
  // Nothing may stick up in front of the ramp's foot.
  let maxY = -Infinity;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Cv = new THREE.Vector3();
  for (let t = 0; t < mesh.triangleCount; t++) {
    mesh.getTriangle(t, A, B, Cv);
    for (const v of [A, B, Cv]) if (v.x < -0.05 && v.x > -1.2) maxY = Math.max(maxY, v.y);
  }
  ok('ramp() builds no lead-in hump when the foot is already on the ground',
    maxY <= 1e-6, `highest vertex behind the ramp foot is y=${maxY.toFixed(4)}`);
}

section('Drivability gate — its own tuning');
{
  ok('the corridor is at least 2 car widths wide',
    DRIVABILITY.CORRIDOR_HALF * 2 >= DRIVABILITY.CAR.width * 2,
    `${(DRIVABILITY.CORRIDOR_HALF * 2).toFixed(2)} m vs ${DRIVABILITY.CAR.width} m`);
  ok('the low probe sits above the tallest step a wheel can mount',
    DRIVABILITY.PROBE_HEIGHTS[0] >= DRIVABILITY.CAR.wheelRadius,
    `${DRIVABILITY.PROBE_HEIGHTS[0]} vs wheel radius ${DRIVABILITY.CAR.wheelRadius}`);
  ok('the high probe sits inside the car\'s own height',
    DRIVABILITY.PROBE_HEIGHTS[1] < DRIVABILITY.CAR.height,
    `${DRIVABILITY.PROBE_HEIGHTS[1]} vs ${DRIVABILITY.CAR.height}`);
  ok('stations are closer together than the car is long',
    DRIVABILITY.STATION < DRIVABILITY.CAR.length,
    `${DRIVABILITY.STATION} vs ${DRIVABILITY.CAR.length}`);
}

// ───────────────────────────────────────────────────────── report

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log('\x1b[31mFailures:\x1b[0m\n  ' + failures.join('\n  '));
  process.exit(1);
}
process.exit(0);
