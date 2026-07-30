/**
 * TOY MUSEUM — the flagship circuit.
 *
 * A grand natural-history museum at 1:1 scale, raced by 30 cm RC cars. Three
 * connected halls under a 10 m ceiling:
 *
 *   • **Grand Hall** (west) — parquet, a red carpet runner, the start/finish
 *     straight under a banner, glass cases, marble columns, velvet ropes.
 *   • **Dinosaur Hall** (north-east) — polished ceramic, and a 33 m sauropod
 *     skeleton whose front legs the racing line threads between, ribcage 1.7 m
 *     overhead.
 *   • **Rocket Hall** (south-east) — chequered lino, a 14 m rocket on a plinth,
 *     a long elevated display table you ramp up onto, and a marble staircase
 *     you jump down at the end of it.
 *
 * **Verticality** — a 0.70 m display table reached by a 4° ramp, run for 40 m,
 * then dropped off down five marble steps.
 *
 * **Shortcut** — a curtained service corridor along the south wall. About 9 m
 * shorter than the main line's swing through the Grand Hall, but 2.3 m wide,
 * carpeted (grip 0.85, high rolling resistance), cluttered with crates and
 * dominoes, entered off a fast straight with a hard right and exited blind into
 * the hairpin. Worth roughly a second if you nail it; costs three if you don't.
 *
 * Lap ≈ 345 m; a flat-out AI lap is ~45 s, a contested race lap 50–60 s.
 */

import * as THREE from 'three';
import { SurfaceId } from '../Surfaces.js';
import * as G from '../GeoLib.js';
import { buildFan, buildPendulum, buildTrain } from '../Props.js';

// ────────────────────────────────────────────────────────────── dimensions

const HALL = { x0: -46, x1: 46, z0: -31, z1: 32, h: 10 };
/** The X of the partition between the Grand Hall and the eastern galleries. */
const PART_X = -4;
/** The Z of the partition between the Dinosaur and Rocket halls. */
const PART_Z = 2;
/**
 * Service corridor. `wallZ` is the partition that hides it, `z` its centre line,
 * `x0`/`x1` the ends of the partition — the corridor is entered through the
 * curtained gap between `doorX0` and `x1`, and exits past the west end of the
 * partition at `x0`.
 */
const CORR = { wallZ: 29.4, z: 30.75, x0: -37, x1: 12, doorX0: 10 };
/** The elevated display table. */
const TABLE = { y: 0.70, x0: 39.0, x1: 46, z0: -6.5, z1: 26.5, extX0: 32.4, extZ0: 20.5 };
/** The sauropod. */
const DINO = { x: 19, z: -11, scale: 1.4 };
/** The rocket. */
const ROCKET = { x: 22, z: 12, height: 14, radius: 1.35, plinth: 0.42 };

const NODES = [
  [-40, 0, 14, 3.2],      // 0  ← START / FINISH, heading −Z
  [-40, 0, 2, 3.2],       // 1
  [-40, 0, -10, 3.0],     // 2
  [-39, 0, -20, 2.8],     // 3
  [-35, 0, -26, 2.8],     // 4
  [-27, 0, -28, 2.8],     // 5
  [-17, 0, -27, 2.8],     // 6
  [-8, 0, -24, 2.8],      // 7  ← through the north arch
  [1, 0, -22, 2.8],       // 8
  [9, 0, -18, 2.6],       // 9
  [15, 0, -12, 2.4],      // 10 ← between the dinosaur's front legs
  [23, 0, -10, 2.6],      // 11
  [30, 0, -13, 2.6],      // 12
  [34, 0, -20, 2.6],      // 13
  [34, 0, -27, 2.6],      // 14
  [40, 0, -28, 2.6],      // 15
  [43, 0, -21, 2.8],      // 16 ← east wall, heading +Z
  [43, 0, -11, 2.8],      // 17 ← ramp up begins
  // The ramp tops out at the table's south edge (z = TABLE.z0 = -6.5); the
  // centreline used to reach deck height only at z = -1, so for 5.5 m it ran
  // 0.34 m UNDER the ramp it is supposed to describe. Everything derived from
  // the spline — AI path, checkpoint heights, respawns, the chase camera — was
  // inside the woodwork there.
  [43, 0.70, -6.5, 3.0],  // 18 ← top of the ramp, at the table edge
  [43, 0.70, -1, 3.0],    // 19 ← on the display table
  [43, 0.70, 9, 3.0],     // 20
  [42, 0.70, 18, 2.8],    // 21
  [37, 0.70, 23, 2.8],    // 22
  [33, 0.70, 24.5, 3.0],  // 23 ← top of the marble stairs
  // The landing is 1.1 m clear of the staircase's west toe, and the turn south
  // starts from there. It used to land at x = 30.2 and turn immediately, which
  // walked the racing corridor straight across the stairs' 0.14 m side skirt at
  // z = 22.8 — a kerb across the exit of a jump you take at 8 m/s.
  [29.4, 0, 24.6, 3.0],   // 24 ← bottom
  // ── a full anticlockwise lap of the Rocket Hall around the plinth ──
  [30.0, 0, 18.5, 2.8],   // 25
  [30, 0, 11, 2.8],       // 26
  [27, 0, 5.5, 2.6],      // 27
  [20, 0, 5.2, 2.6],      // 28
  [13, 0, 7.5, 2.6],      // 29
  [9, 0, 13, 2.6],        // 30
  [10, 0, 20, 2.6],       // 31
  [10, 0, 26, 2.6],       // 32 ← service-corridor entrance (curtain, to the south)
  // ── deep through the Grand Hall and back to the hairpin ──
  [2, 0, 20, 2.6],        // 33
  [-5, 0, 13, 2.6],       // 34
  [-11, 0, 4, 2.6],       // 35
  [-20, 0, 0, 2.6],       // 36
  [-29, 0, 3, 2.6],       // 37
  [-33.5, 0, 11, 2.8],    // 38
  [-35, 0, 20, 3.2],      // 39
  [-42, 0, 29, 4.4],      // 40 ← hairpin
  [-42.5, 0, 22, 3.6],    // 41
];

export default {
  id: 'toy_museum',
  name: 'Toy Museum',
  difficulty: 'easy',
  laps: 3,
  theme: 'indoor',
  order: 0,
  seed: 41007,
  previewColors: [0x8a6a3a, 0xf0e2c4, 0x8e1f22],
  description:
    'Race across the polished floors of a grand museum. Thread the sauropod, '
    + 'ramp onto the display table and jump the marble stairs — or gamble on the '
    + 'staff corridor behind the curtain.',

  /** @param {import('../TrackBuilder.js').TrackBuilder} b */
  build(b) {
    b.centerline(NODES, { closed: true, samplesPerSegment: 30 });
    b.defaultSurface(SurfaceId.WOOD);

    buildShell(b);
    buildFloors(b);
    buildRoad(b);
    buildTable(b);
    buildStairs(b);
    buildShortcut(b);
    buildDinoHall(b);
    buildRocketHall(b);
    buildGrandHall(b);
    buildLighting(b);
    buildRaceData(b);
  },
};

// ═════════════════════════════════════════════════════════════════ the shell

function buildShell(b) {
  // Outer walls + ceiling. No floor here — each hall gets its own material.
  b.room({
    min: [HALL.x0, HALL.z0], max: [HALL.x1, HALL.z1],
    height: HALL.h, thickness: 0.5,
    floor: false, ceiling: true,
    wallMaterial: 'drywall/painted',
    wallMatOpts: { color: 0xefe6d2 },
    wallSurfaceId: SurfaceId.CONCRETE,
    ceilingMaterial: 'drywall/painted',
    ceilingTint: 0xd6cdba,
    skirting: { height: 0.14, material: 'wood/mdf' },
  });

  // A dado rail 1.5 m up, all the way round: reads as "grand interior" for one
  // extra draw call.
  const dadoY = 1.5;
  const inset = 0.28;
  const rails = [
    [[HALL.x0 + inset, HALL.z0 + inset], [HALL.x1 - inset, HALL.z0 + inset]],
    [[HALL.x0 + inset, HALL.z1 - inset], [HALL.x1 - inset, HALL.z1 - inset]],
    [[HALL.x0 + inset, HALL.z0 + inset], [HALL.x0 + inset, HALL.z1 - inset]],
    [[HALL.x1 - inset, HALL.z0 + inset], [HALL.x1 - inset, HALL.z1 - inset]],
  ];
  for (const [a, c] of rails) {
    b.wall(a, c, {
      thickness: 0.07, height: 0.11, y: dadoY,
      material: 'wood/mdf', surfaceId: SurfaceId.WOOD, cast: false,
    });
  }

  // ── partition: Grand Hall ↔ eastern galleries, with two tall arches ──
  const PW = 0.36, PH = 6.2;
  const archA = [-26.8, -19.8];
  const archB = [11.3, 18.7];
  const archH = 4.6;
  const segs = [[HALL.z0, archA[0]], [archA[1], archB[0]], [archB[1], HALL.z1]];
  for (const [z0, z1] of segs) {
    if (z1 - z0 < 0.05) continue;
    b.wall([PART_X, z0], [PART_X, z1], {
      thickness: PW, height: PH,
      material: 'drywall/painted', matOpts: { color: 0xe6dcc6 },
      surfaceId: SurfaceId.CONCRETE,
      skirting: { height: 0.14, material: 'wood/mdf' },
    });
  }
  for (const [z0, z1] of [archA, archB]) {
    b.wall([PART_X, z0], [PART_X, z1], {
      thickness: PW, height: PH - archH, y: archH,
      material: 'drywall/painted', matOpts: { color: 0xe6dcc6 },
      surfaceId: SurfaceId.CONCRETE,
    });
  }

  // ── partition: Dinosaur Hall ↔ Rocket Hall ──
  b.wall([6, PART_Z], [36, PART_Z], {
    thickness: 0.34, height: 5.0,
    material: 'drywall/painted', matOpts: { color: 0xe4d9c2 },
    surfaceId: SurfaceId.CONCRETE,
    skirting: { height: 0.14, material: 'wood/mdf' },
  });

  // ── partition hiding the service corridor ──
  // It stops at `doorX0`; the 2 m gap between there and the corridor's east
  // wall is the curtained entrance. Its west end is the blind exit.
  b.wall([CORR.x0, CORR.wallZ], [CORR.doorX0, CORR.wallZ], {
    thickness: 0.3, height: 4.2,
    material: 'drywall/painted', matOpts: { color: 0xded3bb },
    surfaceId: SurfaceId.CONCRETE,
    skirting: { height: 0.12, material: 'wood/mdf' },
  });
  // Lintel over the doorway.
  b.wall([CORR.doorX0, CORR.wallZ], [CORR.x1, CORR.wallZ], {
    thickness: 0.3, height: 1.8, y: 2.4,
    material: 'drywall/painted', matOpts: { color: 0xded3bb },
    surfaceId: SurfaceId.CONCRETE,
  });
  // The corridor's east end wall.
  b.wall([CORR.x1, CORR.wallZ], [CORR.x1, HALL.z1], {
    thickness: 0.3, height: 4.2,
    material: 'drywall/painted', matOpts: { color: 0xded3bb },
    surfaceId: SurfaceId.CONCRETE,
  });
  // Corridor ceiling — low and oppressive.
  const cceil = G.planeXZ(CORR.x1 - CORR.x0 + 2, HALL.z1 - CORR.wallZ);
  G.flipGeometry(cceil);
  cceil.translate((CORR.x0 + CORR.x1) / 2, 2.5, (CORR.wallZ + HALL.z1) / 2);
  b.add(cceil, b.mat('drywall/painted', { color: 0x8f887b }), {
    surfaceId: SurfaceId.CONCRETE, cast: false, receive: false,
  });
  cceil.dispose();
}

// ══════════════════════════════════════════════════════════════════ floors

function buildFloors(b) {
  // Grand Hall — parquet. Runs the full depth so the hairpin (which pokes into
  // the corridor's z-band west of the partition) always has ground under it.
  b.floor({
    center: [(HALL.x0 + PART_X) / 2, (HALL.z0 + HALL.z1) / 2],
    size: [PART_X - HALL.x0, HALL.z1 - HALL.z0],
    material: 'wood/parquet', surfaceId: SurfaceId.WOOD,
  });
  // Dinosaur Hall — glazed ceramic.
  b.floor({
    center: [(PART_X + HALL.x1) / 2, (HALL.z0 + PART_Z) / 2],
    size: [HALL.x1 - PART_X, PART_Z - HALL.z0],
    material: 'tile/ceramic_glazed', surfaceId: SurfaceId.TILE,
  });
  // Rocket Hall — chequered lino.
  b.floor({
    center: [(PART_X + HALL.x1) / 2, (PART_Z + HALL.z1) / 2],
    size: [HALL.x1 - PART_X, HALL.z1 - PART_Z],
    material: 'tile/lino_check', surfaceId: SurfaceId.TILE,
  });
  // Service corridor — cheap carpet tiles laid over the hall floor.
  // Deliberately draggy: that is the price of the shortcut.
  b.floor({
    center: [(CORR.x0 + CORR.x1) / 2, (CORR.wallZ + HALL.z1) / 2],
    size: [CORR.x1 - CORR.x0 + 2, HALL.z1 - CORR.wallZ - 0.3],
    y: 0.006,
    material: 'carpet/cut_pile', surfaceId: SurfaceId.CARPET,
  });
}

// ════════════════════════════════════════════════════════════════════ road

function buildRoad(b) {
  const L = b.spline.length;
  // The marble staircase replaces the road between nodes 22 and 23.
  const stairFrom = b.tNear([33, 0.70, 24.5]);
  const stairTo = b.tNear([29.4, 0, 24.6]);
  b.jumpGap(stairFrom, stairTo, { lip: false });

  // The racing surface *is* the museum floor — no tarmac here. The route is
  // marked by an inlaid band in the floor itself (museums really do this), which
  // is opaque, needs no extra material family, and keeps the same surface id as
  // the hall it runs through. The ramp and the display table have real decks of
  // their own, so the inlay stops at the foot of the ramp and picks up again at
  // the bottom of the stairs.
  const rampT = b.tNear([43, 0, -12]);
  const archNorth = b.tNear([-6, 0, -23.4]);
  const archSouth = b.tNear([-4, 0, 14.6]);
  inlay(b, 0, archNorth, 'wood/parquet_basket', SurfaceId.WOOD, 0xc9a66e);
  inlay(b, archNorth, rampT, 'tile/mosaic', SurfaceId.TILE, 0xd8cfbc);
  inlay(b, stairTo, archSouth, 'tile/mosaic', SurfaceId.TILE, 0xd8cfbc);
  inlay(b, archSouth, 1, 'wood/parquet_basket', SurfaceId.WOOD, 0xc9a66e);

  // ── the red carpet runner down the start/finish straight ──
  // Laid along the LEFT third: cutting the inside is slower than staying wide.
  b.stripe({
    from: b.spline.wrapT(-14 / L), to: b.spline.wrapT(26 / L),
    width: 1.3, offset: -1.05, y: 0.010, bevel: 0.09,
    material: 'carpet/loop_pile', surfaceId: SurfaceId.CARPET,
    matOpts: { params: { color: 0x8b2226, loops: 56 } },
  });
  // A second runner across the return leg through the Grand Hall.
  b.stripe({
    from: b.tNear([-11, 0, 4]), to: b.tNear([-29, 0, 3]),
    width: 1.5, offset: 0.95, y: 0.010, bevel: 0.09,
    material: 'carpet/loop_pile', surfaceId: SurfaceId.CARPET,
    matOpts: { params: { color: 0x7d3a20, loops: 48 } },
  });
  // Woven rug through the Dinosaur Hall arch.
  b.stripe({
    from: b.tNear([-9, 0, -24]), to: b.tNear([3, 0, -22]),
    width: 2.6, y: 0.008, bevel: 0.10,
    material: 'carpet/rug_woven', surfaceId: SurfaceId.CARPET,
  });
}

/** An inlaid band in the floor that marks the racing line. */
function inlay(b, from, to, material, surfaceId, tint) {
  if (to - from < 0.003) return;
  b.stripe({
    from, to, width: 2.2, y: 0.004, bevel: 0.13,
    material, surfaceId,
    matOpts: { color: tint },
  });
}

// ═════════════════════════════════════════════════ the elevated display table

function buildTable(b) {
  const T = TABLE;
  const woodTop = 'wood/oak_planks';
  const woodSide = 'wood/mdf';

  // Deck: an L (long run down the east wall + a wide platform in the corner).
  const deckA = G.boxMeters(T.x1 - T.x0, 0.14, T.z1 - T.z0, { radius: 0.012, seg: 2 });
  deckA.translate((T.x0 + T.x1) / 2, T.y - 0.07, (T.z0 + T.z1) / 2);
  b.add(deckA, b.mat(woodTop), { surfaceId: SurfaceId.WOOD, cast: true, receive: true });
  deckA.dispose();

  const deckB = G.boxMeters(T.x0 - T.extX0, 0.14, T.z1 - T.extZ0, { radius: 0.012, seg: 2 });
  deckB.translate((T.extX0 + T.x0) / 2, T.y - 0.07, (T.extZ0 + T.z1) / 2);
  b.add(deckB, b.mat(woodTop), { surfaceId: SurfaceId.WOOD, cast: true, receive: true });
  deckB.dispose();

  // Skirt + legs so it reads as furniture, not a floating slab.
  const skirt = [];
  const push = (x, y, z, w, h, d) => {
    const g = G.boxMeters(w, h, d);
    g.translate(x, y, z);
    skirt.push(g);
  };
  push((T.x0 + T.x1) / 2, (T.y - 0.14) / 2, T.z0 + 0.05, T.x1 - T.x0, T.y - 0.14, 0.10);
  push(T.x0 + 0.05, (T.y - 0.14) / 2, (T.z0 + T.extZ0) / 2, 0.10, T.y - 0.14, T.extZ0 - T.z0);
  push((T.extX0 + T.x0) / 2, (T.y - 0.14) / 2, T.extZ0 + 0.05, T.x0 - T.extX0, T.y - 0.14, 0.10);
  push(T.extX0 + 0.05, (T.y - 0.14) / 2, (T.extZ0 + T.z1) / 2, 0.10, T.y - 0.14, T.z1 - T.extZ0);
  push((T.extX0 + T.x1) / 2, (T.y - 0.14) / 2, T.z1 - 0.05, T.x1 - T.extX0, T.y - 0.14, 0.10);
  const skirtGeo = G.mergeList(skirt);
  if (skirtGeo) {
    b.add(skirtGeo, b.mat(woodSide, { color: 0x6c5436 }), {
      surfaceId: SurfaceId.WOOD, cast: true, receive: true,
    });
    skirtGeo.dispose();
  }
  for (const g of skirt) g.dispose();

  // The ramp up onto it: the spline already climbs from node 17 to node 18, so
  // the deck has to meet the floor cleanly. A tapered plywood apron does it.
  // The ramp MUST top out at the deck's south edge (T.z0), not past it.
  //
  // It used to run to z = -1.0 while the deck starts at z = -6.5, so the last
  // 5.5 m of ramp was buried under the deck and never driven on. At the deck
  // edge the ramp had only climbed to 0.337 m of the 0.70 m deck height, which
  // left a 0.363 m step presenting a 43.8 deg face straight across the racing
  // line. That needs g·sin(43.8°) = 13.57 m/s² to climb; the fastest car in the
  // game has accel 13.37 and six of eight have 9.1–11. Measured: every car, at
  // every launch speed up to 14 m/s, stopped dead at z ≈ -6.65. The whole field
  // parked there ~4.5 s into the lap.
  //
  // Ending at T.z0 gives 0.70 m over 5.1 m = 7.8°, needing 2.67 m/s² — clearable
  // by every car — and keeps the table exactly where the author placed it.
  const rampFrom = [43, 0, -11.6];
  const rampTo = [43, T.y, T.z0];
  b.ramp({
    from: rampFrom, to: rampTo, width: 3.4, thickness: 0.10,
    material: 'wood/plywood_varnish', surfaceId: SurfaceId.WOOD,
    support: false, lead: 0.9,
    rails: { height: 0.09, material: 'wood/pine_planks' },
  });
  // Side cheeks so a car cannot drop off the ramp into the void beneath.
  for (const s of [-1, 1]) {
    const cheek = G.extrudeOutline([
      [-5.3, 0], [5.3, 0], [5.3, T.y], [-5.3, 0.02],
    ], 0.09);
    cheek.rotateY(Math.PI / 2);
    cheek.translate(43 + s * 1.75, 0, -6.3);
    b.add(cheek, b.mat(woodSide, { color: 0x6c5436 }), {
      surfaceId: SurfaceId.WOOD, cast: true, receive: true,
    });
    cheek.dispose();
  }

  // Guard rail along the open (west) edge of the long run so the drop is a
  // choice, not an accident — but leave the last 6 m open for the stairs.
  b.railing({
    from: b.tNear([43, T.y, -1]), to: b.tNear([41.5, T.y, 20]),
    side: 'left', height: 0.20, radius: 0.014, inset: 0.03,
    material: 'metal/brushed_alu', postSpacing: 1.6,
  });

  // Exhibits ON the table — you race past them.
  const caseZs = [-4, 2.5, 9, 15];
  for (let i = 0; i < caseZs.length; i++) {
    b.prop('display_case', {
      position: [45.0, TABLE.y, caseZs[i]],
      rotation: [0, Math.PI / 2, 0],
      width: 1.6, depth: 1.0, plinthHeight: 0.28, glassHeight: 0.55,
      plinthColor: 0x5d472e,
    });
  }
  for (let i = 0; i < 3; i++) {
    b.prop('book_stack', {
      position: [45.2, TABLE.y, -9 + i * 26], rotation: [0, i * 0.7, 0], count: 4, seed: 3 + i,
    });
  }
  // Loose props on the table — clip one and it showers off the edge.
  for (let i = 0; i < 8; i++) {
    b.prop('pencil', {
      position: [40.6 + (i % 2) * 0.5, TABLE.y + 0.02, -3 + i * 3.3],
      rotation: [0, 0.4 + i * 0.9, 0],
      color: [0xe8b81e, 0xd0402c, 0x2f6fd0, 0x3aa05a][i % 4],
    });
  }
  for (let i = 0; i < 5; i++) {
    b.prop('marble', { position: [41.2, TABLE.y + 0.06, 6 + i * 1.1], radius: 0.05 });
  }
}

// ═══════════════════════════════════════════════════════ the marble staircase

function buildStairs(b) {
  // Five monumental steps off the west edge of the table platform.
  b.stairs({
    from: [33.0, TABLE.y, 24.5],
    to: [30.5, 0, 24.5],
    steps: 5, width: 3.4, skirt: 0.22, nosing: 0.014,
    material: 'tile/ceramic_glazed', matOpts: { color: 0xe4e0d4 },
    surfaceId: SurfaceId.TILE,
  });
  // Balustrades either side — marble posts with a handrail.
  const postGeo = G.latheMeters([
    [0.05, 0], [0.055, 0.02], [0.032, 0.06], [0.045, 0.13], [0.030, 0.20],
    [0.042, 0.26], [0.038, 0.30], [0.05, 0.32], [0.05, 0.34], [0, 0.34],
  ], 12);
  const marble = b.mat('concrete/screed', { color: 0xe8e3d6 });
  for (const s of [-1, 1]) {
    for (let i = 0; i <= 5; i++) {
      const x = 33.0 - (2.5 / 5) * i;
      const y = TABLE.y - (TABLE.y / 5) * i;
      b.instanceAt('stair:baluster', postGeo, marble,
        [x, y, 24.5 + s * 1.85], null, 1, { collide: 'box', surfaceId: SurfaceId.CONCRETE });
    }
    const railPts = [
      new THREE.Vector3(33.3, TABLE.y + 0.36, 24.5 + s * 1.85),
      new THREE.Vector3(30.3, 0.34, 24.5 + s * 1.85),
    ];
    const rail = G.beamBetween(railPts[0], railPts[1], 0.07, 0.05, { radius: 0.02 });
    b.add(rail, marble, { surfaceId: SurfaceId.CONCRETE, cast: true, receive: true });
    rail.dispose();
  }
  postGeo.dispose();

  // A landing runner so the touchdown is soft-looking (and a hair slower).
  b.patch({
    center: [28.6, 0.004, 25.2], radius: 2.3, segments: 26,
    material: 'carpet/loop_pile', surfaceId: SurfaceId.CARPET,
    matOpts: { params: { color: 0x7c2a2c } },
  });
}

// ═══════════════════════════════════════════════════════════════ the shortcut

function buildShortcut(b) {
  const Z = CORR.z;
  const sc = b.shortcut({
    id: 'staff_corridor',
    name: 'Staff Corridor',
    entryT: b.tNear([10, 0, 26]),
    exitT: b.tNear([-42, 0, 27]),
    risk: 0.65,
    width: 2.3,
    savedMetres: 9,
    nodes: [
      { p: [10.4, 0, 26.2], w: 2.6 },
      { p: [11.0, 0, 28.2], w: 2.0 },
      { p: [11.0, 0, Z], w: 2.0 },
      { p: [6, 0, Z], w: 2.3 },
      { p: [-6, 0, Z], w: 2.3 },
      { p: [-18, 0, Z], w: 2.3 },
      { p: [-28, 0, Z], w: 2.3 },
      { p: [-34.5, 0, Z - 0.2], w: 2.4 },
      { p: [-38.5, 0, 29.6], w: 2.8 },
      { p: [-41.0, 0, 27.0], w: 3.2 },
    ],
  });
  // The corridor floor is already carpet (buildFloors); the shortcut road here
  // is only a thin wear strip so the AI path has a surface to sample.
  b.shortcutRoad(sc, {
    material: 'carpet/cut_pile', surfaceId: SurfaceId.CARPET, step: 0.7,
  });

  // The curtain across the doorway — visual only, you burst straight through.
  // A subdivided plane so the ripple fixture has vertices to work with.
  const curtain = new THREE.PlaneGeometry(2.0, 2.35, 10, 6);
  b._ownedGeo.push(curtain);
  const curtainMat = b.decal({
    key: 'museum:curtain',
    text: ['STAFF', 'ONLY'],
    width: 512, height: 512,
    background: '#5c1a1e', textColor: '#e6c98a', outline: '#2a0a0c',
    doubleSide: true, offsetFactor: 0, roughness: 0.9,
  });
  const cm = new THREE.Mesh(curtain, curtainMat);
  cm.position.set(11.0, 1.18, CORR.wallZ + 0.02);
  cm.userData.noCollision = true;
  b.addObject(cm, { animated: true, decor: true });
  b.propRuntime.flag(cm, { amplitude: 0.06, frequency: 2.4 });

  // Clutter: crates, a bucket, dominoes, a mop. Everything knockable.
  b.prop('crate_heavy', { position: [-2.4, 0, Z + 0.55], rotation: [0, 0.3, 0], width: 0.5, height: 0.4, depth: 0.4 });
  b.prop('crate_heavy', { position: [-2.6, 0.4, Z + 0.5], rotation: [0, -0.2, 0], width: 0.42, height: 0.32, depth: 0.36 });
  b.prop('crate_heavy', { position: [-15.5, 0, Z - 0.6], rotation: [0, 0.9, 0], width: 0.46, height: 0.36, depth: 0.36 });
  b.prop('tin_bucket', { position: [-24.0, 0, Z + 0.6] });
  b.prop('tin_bucket', { position: [3.5, 0, Z - 0.65], radius: 0.14, height: 0.2 });
  for (let i = 0; i < 9; i++) {
    b.prop('domino', {
      position: [-8.5 + i * 0.34, 0, Z - 0.15 + Math.sin(i * 0.9) * 0.25],
      rotation: [0, 0.25 + i * 0.05, 0],
      face: 1 + (i % 6),
    });
  }
  for (let i = 0; i < 6; i++) {
    b.prop('marble', { position: [-30.5 + i * 0.4, 0, Z + (i % 2 ? 0.3 : -0.3)], radius: 0.045 });
  }

  // A cleaning trolley: a static frame with a knockable bucket on it.
  const alu = b.mat('metal/brushed_alu');
  const frame = G.mergeList([
    (() => { const g = G.boxMeters(0.5, 0.04, 0.36, { radius: 0.008, seg: 2 }); g.translate(0, 0.42, 0); return g; })(),
    (() => { const g = G.boxMeters(0.5, 0.03, 0.36, { radius: 0.006, seg: 2 }); g.translate(0, 0.14, 0); return g; })(),
    ...[[-0.22, -0.15], [0.22, -0.15], [-0.22, 0.15], [0.22, 0.15]].map(([x, z]) => {
      const g = G.cylinderMeters(0.014, 0.014, 0.42, 6);
      g.translate(x, 0.23, z);
      return g;
    }),
  ]);
  b.addAt(frame, alu, [-20.5, 0, Z + 0.4], [0, 0.4, 0], 1, { surfaceId: SurfaceId.METAL });
  frame.dispose();
  b.prop('tin_bucket', { position: [-20.4, 0.45, Z + 0.45], radius: 0.13, height: 0.18 });

  // Dim work lighting: a couple of caged bulbs.
  const bulbGeo = G.sphereMeters(0.05, 8);
  const bulbMat = b.glow(0xffd8a0, 3.0, { base: 0x241a08 });
  for (const x of [4, -10, -26]) {
    b.addAt(bulbGeo, bulbMat, [x, 2.35, Z], null, 1, { surfaceId: null, collide: false, cast: false, decor: true });
  }
  bulbGeo.dispose();

  // Warning signage where it rejoins the racing line.
  b.prop('picture_frame', {
    position: [-36.5, 1.6, CORR.wallZ - 0.22], rotation: [0, Math.PI, 0],
    width: 0.9, height: 0.6, text: ['NO', 'EXIT'], background: '#8e1f22', textColor: '#f4e8c8',
  });
}

// ══════════════════════════════════════════════════════════════ Dinosaur Hall

function buildDinoHall(b) {
  const D = DINO;

  // The sauropod: spine along X, front legs straddling the racing line.
  b.prop('dino_skeleton', {
    position: [D.x, 0.32, D.z],
    rotation: [0, Math.PI / 2, 0],
    scale: D.scale,
    color: 0xdcd0b2,
  });

  // Foot plinths + invisible blockers, so the legs are solid without paying for
  // collision on 4 000 bone triangles.
  const feet = [
    [18.72, -13.24], [18.72, -8.76],
    [23.76, -13.24], [23.76, -8.76],
  ];
  const pad = G.latheMeters([[0.62, 0], [0.66, 0.06], [0.6, 0.32], [0.5, 0.34], [0, 0.34]], 14);
  for (const [x, z] of feet) {
    b.addAt(pad, b.mat('concrete/screed', { color: 0x8d8578 }), [x, 0, z], null, 1,
      { surfaceId: SurfaceId.CONCRETE });
    b.blocker([x, 0.3, z], [0.78, 4.2, 0.78], { round: true, surfaceId: SurfaceId.DEFAULT });
  }
  pad.dispose();

  // An interpretive plaque at the foot of the beast.
  b.prop('picture_frame', {
    position: [D.x - 3.2, 0.9, -14.6], rotation: [0, 0.2, 0],
    width: 1.4, height: 0.8,
    text: ['SUPERSAURUS', 'LATE JURASSIC'],
    background: '#22303f', textColor: '#e6dcc0',
  });
  b.prop('stanchion', { position: [D.x - 4.2, 0, -14.0], instanced: true });
  b.prop('stanchion', { position: [D.x - 2.2, 0, -15.2], instanced: true });
  ropeBetween(b, [D.x - 4.2, 0.47, -14.0], [D.x - 2.2, 0.47, -15.2]);

  // Fossil cases along the north wall. Pushed back to 1.2 m off the wall: at
  // 2.4 m the last one (x = 37) straddled the racing line between nodes 14 and
  // 15, and its 0.55 m plinth is solid — a wall across the line, 130 m into the
  // lap, plus a respawn point buried in it.
  for (let i = 0; i < 6; i++) {
    const x = -1 + i * 7.6;
    b.prop('display_case', {
      position: [x, 0, HALL.z0 + 1.2], rotation: [0, 0, 0],
      width: 2.0, depth: 1.2, plinthHeight: 0.55, glassHeight: 0.8,
      plinthColor: 0x54402a,
    });
    b.prop('picture_frame', {
      position: [x, 2.6, HALL.z0 + 0.34],
      width: 1.6, height: 1.1,
      text: ['SPECIMEN', String(101 + i)],
      background: i % 2 ? '#2d3a2a' : '#33303f',
    });
  }

  // A skull on a low plinth right on the inside of the hairpin at node 13/14 —
  // clip it and you lose the exit.
  const skullPlinth = G.boxMeters(2.0, 0.5, 2.0, { radius: 0.03, seg: 2 });
  skullPlinth.translate(29.5, 0.25, -24.5);
  b.add(skullPlinth, b.mat('wood/mdf', { color: 0x5d472e }), { surfaceId: SurfaceId.WOOD });
  skullPlinth.dispose();
  const skull = G.mergeList([
    (() => { const g = G.boxMeters(0.6, 0.55, 1.3, { radius: 0.12, seg: 3 }); g.translate(0, 0.34, 0.06); return g; })(),
    (() => { const g = G.boxMeters(0.46, 0.14, 1.15, { radius: 0.05, seg: 2 }); g.rotateX(0.1); g.translate(0, 0.10, 0.02); return g; })(),
  ]);
  b.addAt(skull, b.mat('concrete/screed', { color: 0xd8ceb2 }), [29.5, 0.5, -24.5], [0, 0.6, 0], 1,
    { surfaceId: SurfaceId.CONCRETE });
  skull.dispose();

  // Marble columns down the middle of the hall.
  for (const [x, z] of [[7, -6], [7, -26], [32, -6]]) {
    b.prop('column', { position: [x, 0, z], height: 9.6, radius: 0.42, color: 0xeae3d2, instanced: true });
  }

  // Knockables scattered where the line is fast: a cluster of oversized dice
  // and toy blocks spilled from an exhibit crate.
  b.prop('crate', { position: [5.5, 0, -13.5], rotation: [0, 0.5, 0], width: 0.7, height: 0.5, depth: 0.5, open: true });
  for (let i = 0; i < 6; i++) {
    b.prop('dice', {
      position: [5.0 + Math.cos(i * 1.3) * 1.3, 0.02 + (i % 2) * 0.12, -13.0 + Math.sin(i * 1.3) * 1.3],
      rotation: [i * 0.4, i * 0.8, i * 0.3],
      face: 1 + (i % 6), size: 0.12,
    });
  }
  for (let i = 0; i < 5; i++) {
    b.prop('alphabet_block', {
      position: [11.0 + i * 0.24, 0.02, -21.5 + (i % 2) * 0.25],
      rotation: [0, i * 0.5, 0],
      letter: 'FOSSIL'[i], size: 0.15,
    });
  }

  // Cones marking a "conservation in progress" chicane on the exit of node 11.
  b.line('cone', {
    from: b.tNear([23, 0, -10]), to: b.tNear([30, 0, -13]),
    spacing: 1.15, edge: -0.86, y: 0, instanced: false,
  });

  // A big ceiling fan turning slowly above the hall.
  buildFan(b, { position: [14, 8.6, -20], radius: 1.5, blades: 5, speed: 1.5, dropLength: 0.9 });
}

// ════════════════════════════════════════════════════════════════ Rocket Hall

function buildRocketHall(b) {
  const R = ROCKET;
  // Plinth.
  const plinth = G.latheMeters([
    [4.0, 0], [4.1, 0.08], [3.9, R.plinth - 0.06], [3.8, R.plinth], [0, R.plinth],
  ], 24);
  b.addAt(plinth, b.mat('concrete/screed', { color: 0xd9d2c2 }), [R.x, 0, R.z], null, 1,
    { surfaceId: SurfaceId.CONCRETE });
  plinth.dispose();
  b.blocker([R.x, R.plinth, R.z], [3.0, 6.0, 3.0], { round: true, surfaceId: SurfaceId.METAL });

  b.prop('rocket', {
    position: [R.x, R.plinth, R.z], height: R.height, radius: R.radius,
    color: 0xecebe4, stripeColor: 0xb8322c,
  });

  // Gantry rail + rope around it so you read "do not touch".
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.prop('stanchion', {
      position: [R.x + Math.cos(a) * 4.9, 0, R.z + Math.sin(a) * 4.9], instanced: true,
    });
    const a2 = ((i + 1) / 8) * Math.PI * 2;
    ropeBetween(b,
      [R.x + Math.cos(a) * 4.9, 0.47, R.z + Math.sin(a) * 4.9],
      [R.x + Math.cos(a2) * 4.9, 0.47, R.z + Math.sin(a2) * 4.9]);
  }

  b.prop('picture_frame', {
    position: [R.x - 5.2, 1.2, R.z + 2.0], rotation: [0, -0.5, 0],
    width: 1.8, height: 1.0,
    text: ['ORBITER MK II', 'FLIGHT READY 1971'],
    background: '#1e2c44', textColor: '#e8dcc0',
  });

  // A model railway that crosses the racing line twice, almost square on — a
  // real kinematic obstacle that will shove a car sideways if you meet it.
  buildTrain(b, {
    points: [
      [3, 0, 9], [3, 0, 23], [16, 0, 25], [21, 0, 20], [16, 0, 11], [9, 0, 8],
    ],
    speed: 2.4, gauge: 0.30, y: 0.004, color: 0x1f6b34, wagons: 2, kinematic: true,
  });
  b.prop('picture_frame', {
    position: [6.2, 1.0, 17.0], rotation: [0, 1.3, 0],
    width: 1.1, height: 0.5, text: 'MIND THE TRAIN',
    background: '#8e6a1f', textColor: '#20180a',
  });

  // Benches + a potted plant at the hall edge, out of the way but readable.
  const bench = G.mergeList([
    (() => { const g = G.boxMeters(2.0, 0.09, 0.5, { radius: 0.02, seg: 2 }); g.translate(0, 0.44, 0); return g; })(),
    ...[-0.8, 0.8].map((x) => {
      const g = G.boxMeters(0.12, 0.4, 0.42, { radius: 0.02, seg: 2 });
      g.translate(x, 0.2, 0);
      return g;
    }),
  ]);
  for (const [x, z, ry] of [[6.5, 10.5, 0], [36, 6, Math.PI / 2], [16, 1.2, 0]]) {
    b.instanceAt('museum:bench', bench, b.mat('wood/oak_planks'), [x, 0, z], [0, ry, 0], 1,
      { collide: 'box', surfaceId: SurfaceId.WOOD });
  }
  bench.dispose();
  b.prop('plant_pot', { position: [8.6, 0, 4.6], radius: 0.34, height: 0.42, color: 0x9a5a34 });
  b.prop('plant_pot', { position: [34.0, 0, 4.6], radius: 0.30, height: 0.38, color: 0x8d5230 });

  // A giant chess set on the lino, right on the inside of the last corner
  // before the corridor entrance — glorious to scatter.
  const pieces = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
  for (let i = 0; i < 8; i++) {
    b.prop('chess', {
      position: [-15.75 + i * 0.56, 0, -21.7], piece: pieces[i], white: true, scale: 1.6,
    });
    b.prop('chess', {
      position: [-15.75 + i * 0.56, 0, -18.4], piece: 'pawn', white: false, scale: 1.6,
    });
  }
  // One 4.6 m board tile, not a mosaic of them: the material repeat is forced.
  b.floor({
    center: [-14, -20.05], size: [4.6, 4.6], y: 0.004,
    material: 'toy/board_game', matOpts: { repeat: 1 / 4.6 },
    surfaceId: null, collide: false, decor: true,
  });

  // Columns. The first one used to stand at [8, 26], 1.5 m from the centreline
  // on the outside of the corridor-entrance corner — a 9.6 m marble column with
  // a 0.52 m plinth, inside the racing corridor.
  for (const [x, z] of [[6.6, 27.2], [38, 24], [38, 8]]) {
    b.prop('column', { position: [x, 0, z], height: 9.6, radius: 0.42, color: 0xeae3d2, instanced: true });
  }
}

// ═══════════════════════════════════════════════════════════════ Grand Hall

function buildGrandHall(b) {
  // Finish-line banner + painted line.
  b.finishLine(0, { depth: 0.6 });
  b.banner(0.0, {
    text: 'RC RUMBLE', key: 'finish',
    height: 2.0, clearance: 1.2, width: 5.4,
    background: '#8e1f22', textColor: '#f7ecd2', border: '#e0bd6a',
  });
  b.banner(b.spline.wrapT(-40 / b.spline.length), {
    text: 'TOY MUSEUM', key: 'entry',
    height: 2.0, clearance: 1.3, width: 5.2,
    background: '#243b52', textColor: '#eee2c4', border: '#cbb27e',
  });

  // A barrier of display cases between the two parallel straights, so the
  // hairpin reads as a hairpin.
  for (let i = 0; i < 5; i++) {
    const z = 11 - i * 5.2;
    b.prop('display_case', {
      position: [-36.9, 0, z], rotation: [0, Math.PI / 2, 0],
      width: 3.0, depth: 1.1, plinthHeight: 0.62, glassHeight: 0.9,
      plinthColor: 0x63492c,
    });
  }

  // Velvet ropes along the outside of the start straight.
  for (let i = 0; i < 9; i++) {
    const z = 18 - i * 4.0;
    b.prop('stanchion', { position: [-43.6, 0, z], instanced: true });
    if (i > 0) ropeBetween(b, [-43.6, 0.47, z + 4.0], [-43.6, 0.47, z]);
  }

  // Columns down the hall.
  for (const z of [-22, -8, 6, 22]) {
    b.prop('column', { position: [-20.5, 0, z], height: 9.6, radius: 0.45, color: 0xece5d4, instanced: true });
  }

  // Framed paintings on the west wall.
  for (let i = 0; i < 7; i++) {
    const z = -24 + i * 8;
    b.prop('picture_frame', {
      position: [HALL.x0 + 0.3, 2.4, z], rotation: [0, Math.PI / 2, 0],
      width: 1.8 + (i % 3) * 0.4, height: 1.3,
      text: ['GALLERY', String.fromCharCode(65 + i)],
      background: ['#2f3b2c', '#382c3a', '#2a3446'][i % 3],
      frameColor: 0xb08a3a,
    });
  }

  // Big woven rug in the middle of the return leg + a scatter of toys on it.
  b.floor({
    center: [-15.5, 2], size: [9, 5], y: 0.006,
    material: 'carpet/rug_woven', surfaceId: SurfaceId.CARPET,
  });
  for (let i = 0; i < 7; i++) {
    b.prop('block', {
      position: [-18.0 + i * 0.34, 0.02 + (i % 3) * 0.11, 0.6 + Math.sin(i) * 0.5],
      rotation: [0, i * 0.6, 0],
      color: [0xd01012, 0x1f6bd0, 0xe8c033, 0x2f9a4a][i % 4],
      width: 0.16, height: 0.10, depth: 0.32,
    });
  }
  b.prop('ball', { position: [-12.5, 0.17, 3.5], radius: 0.17, color: 0xe0483c });
  b.prop('ball', { position: [-23.0, 0.13, 4.6], radius: 0.13, color: 0x2f7fd0 });

  // A grandfather clock with a swinging pendulum, in the corner of the hairpin.
  const clockBody = G.mergeList([
    (() => { const g = G.boxMeters(0.6, 2.1, 0.4, { radius: 0.03, seg: 2 }); g.translate(0, 1.05, 0); return g; })(),
    (() => { const g = G.boxMeters(0.72, 0.6, 0.5, { radius: 0.04, seg: 2 }); g.translate(0, 2.3, 0); return g; })(),
    (() => { const g = G.boxMeters(0.7, 0.1, 0.48, { radius: 0.02, seg: 2 }); g.translate(0, 0.05, 0); return g; })(),
  ]);
  b.addAt(clockBody, b.mat('wood/oak_planks', { color: 0x5a3c22 }), [-44.2, 0, 30.0], [0, -0.5, 0], 1,
    { surfaceId: SurfaceId.WOOD });
  clockBody.dispose();
  const face = G.discXZ(0.24, 20);
  face.rotateX(Math.PI / 2);
  b.addAt(face, b.mat('paper/graph', { color: 0xf0e6cc }), [-43.95, 2.3, 29.78], [0, -0.5, 0], 1,
    { surfaceId: null, collide: false, decor: true });
  face.dispose();
  buildPendulum(b, {
    position: [-44.2, 1.9, 29.86], length: 1.1, radius: 0.14, disc: true,
    amplitude: 0.36, period: 2.0, axis: 'z',
    material: 'metal/brushed_alu', bobMaterial: 'metal/chrome',
  });

  // Museum shop corner: crates, books, a spilled jar of marbles.
  b.prop('crate', { position: [-10.5, 0, 24.0], rotation: [0, 0.4, 0], width: 0.8, height: 0.6, depth: 0.6 });
  b.prop('crate', { position: [-11.4, 0.6, 23.8], rotation: [0, -0.2, 0], width: 0.6, height: 0.45, depth: 0.45 });
  b.prop('book_stack', { position: [-9.2, 0, 22.6], rotation: [0, 0.8, 0], count: 5, seed: 9 });
  for (let i = 0; i < 10; i++) {
    b.prop('marble', {
      position: [-8.0 + Math.cos(i * 2.1) * 0.9, 0.05, 20.5 + Math.sin(i * 2.1) * 0.9],
      radius: 0.042,
      color: [0x8fd6ff, 0xffcf6a, 0xff8fa8, 0x9dffb0][i % 4],
    });
  }
}

// ═════════════════════════════════════════════════════════ lighting & mood

function buildLighting(b) {
  b.environment({
    skybox: { preset: 'museum', mode: 'indoor', roomHeight: HALL.h, ceilingColor: 0x2a2620 },
    sun: {
      color: 0xfff2dc, intensity: 2.5,
      elevation: 0.78, azimuth: 1.05, castShadow: true,
    },
    ambient: { sky: 0xf2e6ce, ground: 0x3f3225, intensity: 1.10 },
    fog: { color: 0x2b2318, near: 46, far: 150 },
    ibl: { intensity: 0.95, tint: 0xfff0dd, enabled: true },
    grade: 'museum',
    exposure: 1.06,
    bloom: { strength: 0.48, threshold: 0.86, knee: 0.35, radius: 0.55 },
    vignette: 0.30,
    lights: [
      // Warm pools over the three halls.
      { type: 'point', color: 0xffd9a8, intensity: 26, position: [-30, 6.4, -6], distance: 30, decay: 2 },
      { type: 'point', color: 0xffd9a8, intensity: 24, position: [-24, 6.4, 16], distance: 28, decay: 2 },
      { type: 'point', color: 0xfff0d0, intensity: 26, position: [16, 6.6, -18], distance: 32, decay: 2 },
      { type: 'point', color: 0xfff0d0, intensity: 24, position: [24, 6.6, 14], distance: 32, decay: 2 },
      // Spotlight on the rocket.
      {
        type: 'spot', color: 0xffe6c0, intensity: 90,
        position: [ROCKET.x - 6, 9.4, ROCKET.z - 5], target: [ROCKET.x, 5, ROCKET.z],
        angle: 0.42, penumbra: 0.6, distance: 26, decay: 2, castShadow: false,
      },
      // Spotlight along the dinosaur.
      {
        type: 'spot', color: 0xffeed2, intensity: 80,
        position: [DINO.x + 2, 9.2, DINO.z + 8], target: [DINO.x, 3.2, DINO.z],
        angle: 0.5, penumbra: 0.65, distance: 26, decay: 2, castShadow: false,
      },
      // The corridor's grubby work lights.
      { type: 'point', color: 0xffc078, intensity: 5, position: [4, 2.2, CORR.z], distance: 9, decay: 2 },
      { type: 'point', color: 0xffc078, intensity: 5, position: [-10, 2.2, CORR.z], distance: 9, decay: 2 },
      { type: 'point', color: 0xffc078, intensity: 5, position: [-26, 2.2, CORR.z], distance: 9, decay: 2 },
    ],
    bounds: new THREE.Box3(
      new THREE.Vector3(HALL.x0 - 1, -1.5, HALL.z0 - 1),
      new THREE.Vector3(HALL.x1 + 1, HALL.h + 1, HALL.z1 + 1),
    ),
  });

  b.audio({
    reverb: { roomSize: 0.86, damping: 0.22, wet: 0.34, preDelay: 0.02 },
    ambienceId: 'museum_hall',
  });

  // Shafts of light from the clerestory windows, with dust drifting in them.
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0xffe9c4, transparent: true, opacity: 0.055, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: true,
  });
  b._ownedMat.push(shaftMat);
  const shafts = [];
  const shaftSpots = [
    [-30, -14], [-30, 4], [-30, 22], [8, -22], [24, -6], [30, 18],
  ];
  for (const [x, z] of shaftSpots) {
    const g = G.cylinderMeters(1.4, 3.4, HALL.h - 0.4, 14, { open: true });
    g.translate(x + 3.0, (HALL.h - 0.4) * 0.5, z - 1.5);
    shafts.push(g);
  }
  const shaftGeo = G.mergeList(shafts);
  for (const g of shafts) g.dispose();
  if (shaftGeo) {
    const mesh = new THREE.Mesh(shaftGeo, shaftMat);
    mesh.renderOrder = 3;
    mesh.userData.noCollision = true;
    mesh.frustumCulled = false;
    b.addObject(mesh, { decor: true });
    b._ownedGeo.push(shaftGeo);
  }

  // Dust motes: a slowly rising Points cloud inside the shafts.
  const MOTES = 900;
  const pos = new Float32Array(MOTES * 3);
  const spd = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    const s = shaftSpots[i % shaftSpots.length];
    pos[i * 3] = s[0] + 3.0 + (b.rnd() - 0.5) * 5.2;
    pos[i * 3 + 1] = b.rnd() * (HALL.h - 1.0) + 0.2;
    pos[i * 3 + 2] = s[1] - 1.5 + (b.rnd() - 0.5) * 5.2;
    spd[i] = 0.02 + b.rnd() * 0.06;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const moteTex = b.assets
    ? (() => {
      const PTmod = b.assets;
      return makeDotTexture(PTmod);
    })()
    : null;
  const moteMat = new THREE.PointsMaterial({
    color: 0xffeccd, size: 0.045, sizeAttenuation: true,
    transparent: true, opacity: 0.55, depthWrite: false,
    blending: THREE.AdditiveBlending, map: moteTex ?? null,
    alphaTest: 0.01, toneMapped: true,
  });
  b._ownedMat.push(moteMat);
  b._ownedGeo.push(moteGeo);
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  motes.userData.noCollision = true;
  motes.renderOrder = 4;
  b.addObject(motes, { animated: true });
  b.propRuntime.custom(motes, (dt) => {
    const a = moteGeo.getAttribute('position');
    const arr = a.array;
    for (let i = 0; i < MOTES; i++) {
      arr[i * 3 + 1] += spd[i] * dt;
      arr[i * 3] += Math.sin(arr[i * 3 + 1] * 1.7 + i) * dt * 0.02;
      if (arr[i * 3 + 1] > HALL.h - 0.4) arr[i * 3 + 1] = 0.15;
    }
    a.needsUpdate = true;
  });
}

/** A soft round dot, drawn once, used as the dust-mote sprite. */
function makeDotTexture(assets) {
  const key = 'track:museum:dot';
  const cached = assets.getTexture(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = key;
  tex.colorSpace = THREE.SRGBColorSpace;
  return assets.putTexture(key, tex);
}

// ═════════════════════════════════════════════════════════════ race layout

function buildRaceData(b) {
  b.checkpoints({ count: 20, halfWidthPad: 1.6 });
  b.startGrid({ count: 8, columns: 2, rowGap: 2.1, firstBack: 3.6, spread: 0.42 });
  b.respawns({ spacing: 12 });

  b.pickupRow(b.spline.wrapT(b.tNear([-40, 0, -6])), { count: 3, spread: 1.0 });
  b.pickupRow(b.tNear([-24, 0, -28]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([27, 0, 5.5]), { count: 3, spread: 0.8 });
  b.pickupRow(b.tNear([12, 0, -14]), { count: 3, spread: 0.8 });
  b.pickupRow(b.tNear([43, 0, -16]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([43, 0.70, 12]), { count: 3, spread: 1.0, y: 0.014 });
  b.pickupRow(b.tNear([10, 0, 21]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([-20, 0, 0]), { count: 3, spread: 0.9 });

  b.aiPath({
    spacing: 3.0, topSpeed: 9.0, brake: 12.5, accel: 6.8,
    tyre: 0.58, safety: 0.90, raceLine: true, carHalfWidth: 0.13,
  });
}

// ═══════════════════════════════════════════════════════════════════ helpers

/** A hanging velvet rope between two stanchion tops. */
function ropeBetween(b, a, c) {
  const geo = G.ropeBetween(
    new THREE.Vector3(a[0], a[1], a[2]),
    new THREE.Vector3(c[0], c[1], c[2]),
    0.018, 0.10, 10, 6,
  );
  b.add(geo, b.mat('fabric/felt', { params: { color: 0x8e1f22 } }), {
    surfaceId: null, collide: false, cast: true, receive: false, decor: true,
  });
  geo.dispose();
}
