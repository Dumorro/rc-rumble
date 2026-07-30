/**
 * RC RUMBLE — the drivability gate. Run by `npm run check`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Back Garden shipped un-lappable. `HOUSE = { x0:-46, x1:-30, z0:-6, z1:16,
 * h:6.5 }` and the start/finish straight ran at x ≈ -37.7 from z = +16 to z = -6
 * — inside that footprint — and `buildHouseAndFence` laid unbroken 16 m × 6.5 m
 * brick slabs across BOTH of those walls, with a concrete eave roofing the lot.
 * The racing line entered a sealed box. Half the start grid, meanwhile, sat in
 * mid-air over the deck jump because `startGrid()` had no gap guard. Every one
 * of those defects is arithmetic on data that exists at build time, and every
 * one of them survived a build, a lint, four self-test suites and a contract
 * check, because nothing in the repo had ever tried to DRIVE a track.
 *
 * This does. Headlessly, with no renderer and no browser: a track builds fine in
 * Node — `getMaterials(null)` returns null, `TrackBuilder.mat()` falls back, and
 * `finishLine`/`banner` no-op without `assets` — so the CollisionMesh that comes
 * out is byte-for-byte the one the game drives on.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. lap closes         the centreline is a closed loop, checkpoints wrap
 *                         monotonically, and declared jump gaps do not eat it
 *   2. ground under it    every station outside a declared gap has a surface
 *                         within MAX_DROP below the centreline
 *   3. corridor clear     a CORRIDOR_HALF-wide channel along the centreline is
 *                         free of any face too steep to drive up, in the band
 *                         from STEP_OVER to CAR.height above the line
 *   4. grid + respawns    every slot has ground under it, is outside every gap,
 *                         and has no wall inside the car's own footprint
 *
 * WHAT "BLOCKING" MEANS, PRECISELY
 * --------------------------------
 * A hit blocks if BOTH hold:
 *
 *   • the triangle's own plane normal is steeper than MAX_CLIMB from horizontal
 *     (|n·up| < cos MAX_CLIMB) — a ramp you drive up is not an obstacle, a wall
 *     is. NOTE this must use `triNormal()`, not `RayHit.normal`: the raycast
 *     flips its normal to face the ray origin, so the sign is useless here.
 *   • it FACES the direction of travel (n·travel < -FACE_ON). A staircase you
 *     descend has risers pointing the way you are going; you drop off them. The
 *     same staircase taken upwards has them pointing at you, and stops you dead.
 *     Without this test every set of stairs in the game reads as a wall.
 *
 * NUMBERS, AND WHERE THEY COME FROM
 * ---------------------------------
 * Car dimensions are the ARCHITECTURE.md ones: 0.30 × 0.18 × 0.11 m, wheel
 * radius 0.033 m. STEP_OVER = 0.05 m is 1.5 wheel radii — about the tallest
 * lip a powered wheel will mount — so anything the probe can hit is, by
 * construction, taller than the car can climb.
 *
 * CORRIDOR_HALF = 0.45 m is the one number that is a judgement call, so here is
 * the measurement behind it. It asserts a 0.90 m clear channel: five car widths,
 * roughly a third of the 2.4–3.2 m roads these tracks use. Measured headroom on
 * the two shipped tracks, after the fixes that landed with this gate:
 *
 *      ±0.45  museum 0 hits   garden 0 hits     ← the gate
 *      ±0.60  museum 0 hits   garden 0 hits
 *      ±0.75  museum 2 hits   garden 0 hits
 *      ±0.90  museum 2 hits   garden 1 hit      ← road furniture at the edge
 *
 * So the setting is not tuned to the last centimetre of what passes — there is a
 * 33% margin before the first track goes red. Below ±0.45 you start being able
 * to thread a genuine obstruction; above ±0.75 kerbs and trackside furniture
 * that belong at the road edge start tripping it.
 *
 * KNOWN LIMITS — stated so nobody over-trusts a green
 * --------------------------------------------------
 *   • It proves a channel exists along the AUTHORED centreline. It does not
 *     prove a car can be *steered* down it at 9 m/s, that the corners are
 *     possible, or that a jump lands. That needs the vehicle sim, and this gate
 *     deliberately does not depend on src/vehicle.
 *   • It only sees static geometry. Knockable props with dynamic bodies, oil
 *     slicks and other out-of-band hazards are invisible to it.
 *   • Overhead clearance is checked only to CAR.height. A soffit at 0.5 m would
 *     pass here and stop a car that got airborne.
 *   • It says nothing about whether a lap is FUN.
 */

import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { TrackSystem } from '../src/track/TrackSystem.js';
import { TrackBuilder } from '../src/track/TrackBuilder.js';
import { SplineSample } from '../src/track/Spline.js';
import { createRayHit, closestPointOnTriangleRaw, CP } from '../src/physics/CollisionMesh.js';

/** ARCHITECTURE.md § "Coordinate system & units". */
const CAR = { length: 0.30, width: 0.18, height: 0.11, wheelRadius: 0.033 };

/** Tallest lip a powered wheel will mount, ≈ 1.5 × wheel radius. */
const STEP_OVER = 0.05;
/** Half-width of the channel asserted along the centreline. See the header. */
const CORRIDOR_HALF = 0.45;
/** Sampling pitch along the centreline, metres. */
const STATION = 0.25;
/** Steeper than this from horizontal and it is a wall, not a ramp. */
const MAX_CLIMB_DEG = 50;
const MAX_CLIMB_COS = Math.cos((MAX_CLIMB_DEG * Math.PI) / 180);
/** How square-on a face has to be to count as "you drive into it". */
const FACE_ON = 0.25;
/** Ground must be within this far below the centreline (outside a gap). */
const MAX_DROP = 0.25;
/** Ray origins start this far above the point being tested. */
const PROBE_UP = 0.30;
/** A spawn slot may not sit more than this above its ground. */
const SPAWN_MAX_DROP = 0.30;
/** A wall this close to a parked car's centre means the car is inside it. */
const SPAWN_CLEAR = 0.16;
/** Declared jump gaps may not swallow more than this much of the lap. */
const MAX_GAP_FRACTION = 0.25;

const LANES = [-1, -0.5, 0, 0.5, 1].map((f) => f * CORRIDOR_HALF);
const PROBE_HEIGHTS = [STEP_OVER, CAR.height * 0.95];

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

// ─────────────────────────────────────────────────────────────── scratch

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s0 = new SplineSample();
const _s1 = new SplineSample();
const _hit = createRayHit();
const _triScratch = new Uint32Array(4096);

/** True if the triangle is a face you would drive into rather than over. */
function isWall(mesh, triIndex, travelDir) {
  mesh.triNormal(triIndex, _n);
  if (Math.abs(_n.y) >= MAX_CLIMB_COS) return false;      // drivable slope
  return _n.dot(travelDir) < -FACE_ON;                    // facing us
}

/**
 * Build one track exactly as the game does, but with no Game — so no canvas, no
 * WebGL context and no textures. Throws only if the track module itself throws.
 */
export function buildTrack(mod) {
  const b = new TrackBuilder(null, {
    id: mod.id,
    name: mod.name,
    theme: mod.theme,
    difficulty: mod.difficulty,
    laps: mod.laps ?? 3,
    seed: mod.seed ?? 1337,
    previewColors: mod.previewColors,
    description: mod.description,
  });
  mod.build(b);
  return { builder: b, track: b.build() };
}

// ══════════════════════════════════════════════════════════════ the checks

/** 1. The lap is a closed loop you can be scored around. */
function checkLapCloses(track, builder, fail) {
  const sp = track.spline;
  if (!sp) return fail('lap', 'no centreline spline at all — nothing can be lapped');
  if (sp.closed === false) fail('lap', 'centreline is not a closed loop');

  sp.positionAt(0, _a);
  sp.positionAt(1, _b);
  const seam = _a.distanceTo(_b);
  if (seam > 1e-3) {
    fail('lap', `centreline start and end are ${seam.toFixed(3)} m apart — the lap does not close`);
  }
  if (!(sp.length > 1)) fail('lap', `lap length is ${sp.length} m`);

  const cps = track.checkpoints ?? [];
  if (cps.length < 2) {
    fail('lap', `${cps.length} checkpoint(s); ARCHITECTURE.md requires >= 2`);
  } else {
    if (!cps[0].isFinish) fail('lap', 'checkpoints[0] is not the finish line');
    for (let i = 1; i < cps.length; i++) {
      if (!(cps[i].t > cps[i - 1].t)) {
        fail('lap', `checkpoint ${i} (t=${cps[i].t.toFixed(4)}) does not advance past ${i - 1} (t=${cps[i - 1].t.toFixed(4)})`);
        break;
      }
    }
  }

  let gapped = 0;
  for (const [from, to] of builder._gaps ?? []) {
    const span = from <= to ? to - from : 1 - from + to;
    gapped += span;
    if (span > MAX_GAP_FRACTION) {
      fail('lap', `a declared jump gap covers ${(span * 100).toFixed(1)}% of the lap `
        + `(t ${from.toFixed(3)}..${to.toFixed(3)}); ${(MAX_GAP_FRACTION * 100).toFixed(0)}% is the limit`);
    }
  }
  if (gapped > MAX_GAP_FRACTION) {
    fail('lap', `declared jump gaps cover ${(gapped * 100).toFixed(1)}% of the lap in total`);
  }
}

/**
 * 2 + 3. Walk the centreline. Ground below, corridor clear.
 * Returns the raw finding list so the caller can cluster it.
 */
function walkCentreline(track, builder) {
  const sp = track.spline;
  const mesh = track.collision;
  const out = { noGround: [], blocked: [], stations: 0, gapStations: 0 };
  if (!sp || !mesh || mesh.triangleCount === 0) return out;

  const n = Math.max(8, Math.ceil(sp.length / STATION));
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    out.stations++;
    if (builder.isGap(t0) || builder.isGap(t1)) { out.gapStations++; continue; }

    sp.sample(t0, _s0);
    sp.sample(t1, _s1);

    // ── ground under the racing line ──
    // World up, not the road normal: on a banked section the normal leans, and
    // an origin offset along it would probe a point beside the line, not above
    // it. The ray itself is straight down because that is the direction a car
    // falls.
    _a.copy(_s0.position).addScaledVector(UP, PROBE_UP);
    const grounded = mesh.raycast(_a, DOWN, PROBE_UP + MAX_DROP, _hit);
    if (!grounded) {
      out.noGround.push({ t: t0, point: _s0.position.clone() });
    }

    // ── corridor ──
    for (const lane of LANES) {
      for (const h of PROBE_HEIGHTS) {
        _s0.offset(lane, h, _a);
        _s1.offset(lane, h, _b);
        _d.copy(_b).sub(_a);
        const len = _d.length();
        if (len < 1e-6) continue;
        _d.multiplyScalar(1 / len);
        if (!mesh.raycast(_a, _d, len, _hit)) continue;
        if (!isWall(mesh, _hit.triIndex, _d)) continue;
        out.blocked.push({
          t: t0, lane, height: h,
          point: _hit.point.clone(),
          surfaceId: _hit.surfaceId,
        });
      }
    }
  }
  return out;
}

/**
 * 4. A spawn slot must have ground under it, be outside every declared gap, and
 * have no wall inside the car's own footprint.
 *
 * The wall test is a sphere query rather than a fan of rays: `querySphere`
 * hands back every candidate triangle around the car's body centre in one call,
 * and `closestPointOnTriangleRaw` then measures each one exactly — a ray fan can
 * thread between two ray directions and miss a post.
 */
function checkSpawns(track, builder, label, list, fail) {
  const mesh = track.collision;
  if (!mesh) return;
  if (!list || list.length === 0) return fail(label, `no ${label} points at all`);
  if (label === 'startGrid' && list.length < 8) {
    fail(label, `${list.length} slots; ARCHITECTURE.md requires >= 8`);
  }

  for (let i = 0; i < list.length; i++) {
    const slot = list[i];
    const p = slot.position;
    const where = `[${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}]`;

    // Inside a declared jump gap ⇒ it spawns over the void.
    if (builder.isGap(builder.tNear(p))) {
      fail(label, `#${i} at ${where} sits inside a declared jump gap`);
      continue;
    }

    // Ground below.
    _a.copy(p).addScaledVector(UP, PROBE_UP + SPAWN_MAX_DROP);
    const maxDist = (PROBE_UP + SPAWN_MAX_DROP) * 2;
    if (!mesh.raycast(_a, DOWN, maxDist, _hit)) {
      fail(label, `#${i} at ${where} has no ground under it within ${SPAWN_MAX_DROP.toFixed(2)} m`);
      continue;
    }
    const drop = _hit.distance - (PROBE_UP + SPAWN_MAX_DROP);
    if (drop > SPAWN_MAX_DROP) {
      fail(label, `#${i} at ${where} floats ${drop.toFixed(2)} m above its ground`);
      continue;
    }
    if (drop < -0.02) {
      fail(label, `#${i} at ${where} is ${(-drop).toFixed(2)} m INSIDE the geometry above it`);
      continue;
    }

    // Clear space around the parked car.
    _b.copy(p).addScaledVector(UP, CAR.height * 0.5);
    const count = mesh.querySphere(_b, SPAWN_CLEAR, _triScratch);
    for (let k = 0; k < count; k++) {
      const tri = _triScratch[k];
      mesh.triNormal(tri, _n);
      if (Math.abs(_n.y) >= MAX_CLIMB_COS) continue;          // floor or ramp
      closestPointOnTriangleRaw(mesh.tris, tri * 9, _b.x, _b.y, _b.z);
      const dy = CP.y - _b.y;
      if (Math.abs(dy) > CAR.height * 0.6) continue;          // above or below the body
      const dx = CP.x - _b.x, dz = CP.z - _b.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < SPAWN_CLEAR) {
        fail(label, `#${i} at ${where} has a wall ${d.toFixed(2)} m from the car's centre `
          + `(surface ${mesh.surfaceAt(tri)}) — the car spawns inside it`);
        break;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════ the audit

/**
 * Audit an already-built track. Exported so `src/track/__selftest__.mjs` can
 * point it at deliberately-broken fixtures and assert it goes red — a gate
 * nobody has ever seen fail is worth nothing.
 *
 * @param {object} track TrackData from `TrackBuilder#build()`
 * @param {import('../src/track/TrackBuilder.js').TrackBuilder} builder
 * @returns {{findings:Array<{kind:string,message:string}>,
 *            blocked:Array, noGround:Array, stations:number, gapStations:number,
 *            total:number}}
 */
export function auditBuiltTrack(track, builder) {
  const findings = [];
  const fail = (kind, message) => findings.push({ kind, message });

  if (!track.collision || track.collision.triangleCount === 0) {
    fail('collision', 'the track built no collision geometry at all');
  }
  checkLapCloses(track, builder, fail);
  const walk = walkCentreline(track, builder);
  checkSpawns(track, builder, 'startGrid', track.startGrid, fail);
  checkSpawns(track, builder, 'respawns', track.respawns, fail);

  return {
    findings,
    blocked: walk.blocked,
    noGround: walk.noGround,
    stations: walk.stations,
    gapStations: walk.gapStations,
    total: findings.length + walk.blocked.length + walk.noGround.length,
  };
}

/** Build a track module and audit it in one call. */
export function auditTrackModule(mod) {
  const { builder, track } = buildTrack(mod);
  return { ...auditBuiltTrack(track, builder), track, builder };
}

/** The tuning the gate runs at, so a self-test can assert against real numbers. */
export const DRIVABILITY = Object.freeze({
  CAR, STEP_OVER, CORRIDOR_HALF, STATION,
  MAX_CLIMB_DEG, FACE_ON, MAX_DROP, SPAWN_MAX_DROP, SPAWN_CLEAR,
  MAX_GAP_FRACTION, PROBE_HEIGHTS: Object.freeze([...PROBE_HEIGHTS]),
});

// ═══════════════════════════════════════════════════════════════ reporting

/** Collapse a run of findings at consecutive stations into one line. */
function cluster(items, gapT = 0.006) {
  const out = [];
  for (const x of items) {
    const last = out[out.length - 1];
    if (last && x.t - last[last.length - 1].t < gapT) last.push(x);
    else out.push([x]);
  }
  return out;
}

/**
 * @param {{red,green,yellow,dim,bold}} C colour helpers from check.mjs
 * @returns {number} number of tracks that failed
 */
export function runDrivabilityCheck(C, log = console.log) {
  log(C.bold('\n▸ Drivability\n'));

  let registry;
  try {
    registry = new TrackSystem(null).registry;
  } catch (err) {
    log(`  ${C.red('✗')} could not read the track registry: ${err?.message ?? err}`);
    return 1;
  }

  log(C.dim(`  ${registry.size} registered track(s) · corridor ±${CORRIDOR_HALF.toFixed(2)} m `
    + `(${(CORRIDOR_HALF * 2 / CAR.width).toFixed(1)} car widths) · probe heights `
    + `${PROBE_HEIGHTS.map((h) => h.toFixed(3)).join(' / ')} m · station ${STATION} m`));

  let failedTracks = 0;

  for (const mod of registry.values()) {
    let audit = null;
    const t0 = Date.now();
    try {
      audit = auditTrackModule(mod);
    } catch (err) {
      log(`  ${C.red('✗')} ${mod.id.padEnd(14)} build threw: ${err?.message ?? err}`);
      log(C.dim(`      ${(err?.stack ?? '').split('\n').slice(1, 4).join('\n      ')}`));
      failedTracks++;
      continue;
    }
    const { track, findings } = audit;
    const walk = audit;

    const ms = Date.now() - t0;
    const total = audit.total;
    const ok = total === 0;
    if (!ok) failedTracks++;

    log(`  ${ok ? C.green('✓') : C.red('✗')} ${mod.id.padEnd(14)} `
      + `${track.lengthMeters.toFixed(0)} m · ${walk.stations} stations `
      + `(${walk.gapStations} in declared gaps) · ${track.collision?.triangleCount ?? 0} tris · `
      + `${track.startGrid.length} grid · ${track.respawns.length} respawns `
      + `${ok ? '' : C.red(`· ${total} finding${total === 1 ? '' : 's'} `)}${C.dim(`${ms} ms`)}`);

    for (const c of cluster(walk.blocked)) {
      const f = c[0];
      const lanes = [...new Set(c.map((x) => x.lane.toFixed(2)))].join(', ');
      log(C.red(`      BLOCKED  t ${f.t.toFixed(4)}  (${(f.t * track.lengthMeters).toFixed(1)} m into the lap)`));
      log(C.dim(`               a wall crosses the racing corridor at `
        + `[${f.point.x.toFixed(2)}, ${f.point.y.toFixed(2)}, ${f.point.z.toFixed(2)}], `
        + `surface ${f.surfaceId}, lanes ${lanes}, ${c.length} probe hit(s)`));
    }
    for (const c of cluster(walk.noGround)) {
      const f = c[0];
      log(C.red(`      NO GROUND  t ${f.t.toFixed(4)}  (${(f.t * track.lengthMeters).toFixed(1)} m into the lap)`));
      log(C.dim(`               nothing solid within ${MAX_DROP} m under `
        + `[${f.point.x.toFixed(2)}, ${f.point.y.toFixed(2)}, ${f.point.z.toFixed(2)}], `
        + `and it is not a declared jump gap · ${c.length} station(s)`));
    }
    for (const f of findings) {
      log(C.red(`      ${f.kind.toUpperCase()}  ${f.message}`));
    }
  }

  if (failedTracks === 0) {
    log(`  ${C.green('✓')} every registered track can be lapped`);
  }
  return failedTracks;
}

export default runDrivabilityCheck;

// ─────────────────────────────────────────────────────────── CLI

/**
 * Run directly: `node tools/drivability.mjs`
 *
 * This guard was missing, and its absence was worse than a plain bug. Three
 * documents told authors to use this as their fast inner loop — "run it
 * constantly, fix until clean" — and without an entry point the file exported
 * its function and exited 0 in silence. The prescribed loop was unconditionally
 * green, so anyone who read silence as success would iterate against a no-op
 * until `npm run check` finally told them the truth.
 */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const plain = process.argv.includes('--no-color') || !process.stdout.isTTY;
  const paint = (code) => (s) => (plain ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
  const C = {
    red: paint(31), green: paint(32), yellow: paint(33),
    dim: paint(2), bold: paint(1),
  };
  const failed = runDrivabilityCheck(C);
  process.exit(failed === 0 ? 0 : 1);
}
