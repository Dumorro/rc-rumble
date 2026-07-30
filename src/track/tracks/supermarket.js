/**
 * SUPERMARKET SWEEP — a 1:1 hypermarket, raced by 30 cm RC cars after closing.
 *
 * A 74 × 51 m store under a 7 m ceiling, laid out the way real supermarkets are:
 * a bank of gondola runs down the middle with a perimeter aisle round the
 * outside. The racing line serpentines the middle three aisles and comes home
 * past the checkouts.
 *
 *   • **Checkouts** (south) — the start/finish straight runs the full width of
 *     the front of store, past the tills and the trolley bay, under a promo
 *     banner.
 *   • **Frozen foods** (west) — a long left-hander down a canyon of upright
 *     freezers, 2 m of glowing white cabinet on your right.
 *   • **The back aisle** (north) — the fastest straight on the lap, and the one
 *     with the loading dock across it.
 *   • **Aisle 4 / Aisle 6** — the serpentine, two 4.6 m aisles between 1.85 m
 *     gondolas, taken in opposite directions with a hairpin at each end.
 *
 * **Verticality** — the goods-in dock: a 6.6° pallet ramp up onto a 0.62 m
 * loading platform, 8 m along it, then off the end over the dock-leveller pit.
 *
 * **The jump** — measured off the built collision mesh, not off the design
 * sketch: 1.50 m of air over a 0.45 m pit, dropping 0.716 m off a 3.44° lip.
 * It clears from 5.25 m/s upward against a straight that arrives at 7.6. See
 * {@link buildDock}.
 *
 * **Shortcut** — the refit gap. One bay of the z = −20 gondola has been stripped
 * for a refit and boarded over at 0.50 m, and there is a pallet ramp up to it
 * from the back aisle. Cross it and you skip the whole east hairpin. It is
 * 2.2 m wide against a 3.4 m road, the deck is bare shelf steel (grip 0.95,
 * restitution 1.15 — it bounces), the entry is a 90° turn off the fastest
 * straight on the track, and the exit is a blind 0.50 m drop into Aisle 4
 * across the racing line. Measured at 22 m shorter (6.4% of the lap); you give
 * every bit of that back in entry speed if you are not already slow when you
 * commit.
 *
 * Lap 348 m, flat-out AI estimate 44 s — the same numbers as the museum.
 *
 * LAYOUT DISCIPLINE — every gondola run is PARALLEL to the piece of racing line
 * beside it and stops short of the cross-aisles, so no shelving footprint ever
 * contains a centreline node. The two things that do cross the line (the dock
 * and the refit gap) are driven over, not through.
 */

import * as THREE from 'three';
import { SurfaceId } from '../Surfaces.js';
import * as G from '../GeoLib.js';
import { buildFan } from '../Props.js';

// ────────────────────────────────────────────────────────────────── the store

const STORE = { x0: -40, x1: 45, z0: -27, z1: 24, h: 7 };

/** Gondola shelving. `depth` is the full silhouette — shelf boards live inside it. */
const RUN = { depth: 1.44, height: 1.85, x0: -23, x1: 32 };
/**
 * The z = −8 run stops short of the others: past here the Aisle 6 road swings
 * out toward the front of store and the clearance to the shelf face would drop
 * under 0.5 m.
 */
const RUN_SHORT_X1 = 27;
/** Centre z of each gondola run. The aisles are the 4.56 m gaps between them. */
const RUN_Z = [-20, -14, -8];
/** The upright freezer bank that divides the frozen aisle from the west hairpin. */
const FREEZER = { x: -32.8, z0: -15, z1: 8, depth: 1.44, height: 2.05 };

/**
 * The refit gap in the z = −20 run: one bay stripped and boarded over. The
 * shortcut crosses here, so the run is built as spans that skip it.
 */
const CUT = { x: 28, half: 1.45, y: 0.50 };

/**
 * Goods-in. The deck top is `y`; the ramp foot is at `rampX0` on the floor and
 * the ramp tops out AT `x0`, which is also a centreline node — a ramp that
 * tops out past the thing it climbs leaves a step across the racing line.
 */
const DOCK = { y: 0.62, x0: -3.6, x1: 4.4, z0: -26.4, z1: -21.2, rampX0: -9.0 };
/** The dock-leveller pit the jump clears. The store floor is laid AROUND this. */
const PIT = { x0: 4.4, x1: 5.95, z0: -26.4, z1: -21.2, depth: 0.45 };
/** Where you come down. Kept 0.15 m clear of the pit's east lip. */
const LAND_X = 6.1;

/** Centre z of each drivable aisle. */
const AISLE = { back: -23.5, four: -17.0, six: -11.0 };

const NODES = [
  [10, 0, 18.5, 3.8],       //  0 ← START / FINISH, heading −X past the tills
  [0, 0, 18.5, 3.8],        //  1
  [-12, 0, 18.5, 3.6],      //  2
  [-22, 0, 17.5, 3.6],      //  3
  [-30, 0, 14.5, 3.4],      //  4 ← produce corner
  [-35, 0, 9.0, 3.4],       //  5
  [-36, 0, 1.0, 3.4],       //  6 ← frozen foods, heading −Z
  [-36, 0, -8.0, 3.4],      //  7
  [-35, 0, -16.0, 3.4],     //  8
  [-32, 0, -21.5, 3.4],     //  9
  [-27, 0, -23.6, 3.6],     // 10 ← into the back aisle, heading +X
  [-19, 0, -23.5, 3.4],     // 11
  [-9, 0, -23.5, 3.4],      // 12 ← foot of the dock ramp
  [-3.6, 0.62, -23.5, 3.2], // 13 ← top of the ramp, AT the deck edge
  [4.4, 0.62, -23.5, 3.2],  // 14 ← take-off
  // ── 1.35 m of air over the dock-leveller pit ──
  // The landing node sits 0.14 m up and the run-out is spread over 4.9 m. That
  // is not cosmetic: `aiPath` derives target speed from `smoothCurvature`, which
  // is 3D over a 4 m window, so a jump's vertical pull-out reads to it as a
  // hairpin. Landing flat at y = 0 with a 3.4 m run-out gave kappa −0.52 one
  // node past touchdown and a 4.30 m/s target — the AI arriving on the brakes,
  // at 2 g, mid-landing. Both shipped tracks show the same dip at their own
  // jumps (museum 5.69 m/s, garden 5.47 m/s), so the real fix belongs in
  // `aiPath`; all a track can do is give the pull-out room.
  [6.1, 0.14, -23.5, 3.2],  // 15 ← landing (LAND_X)
  [11.0, 0, -23.5, 3.4],    // 16
  [17, 0, -23.3, 3.4],      // 17 ← the refit bay is 2.6 m south of here, at x = 28
  [34, 0, -23.1, 3.4],      // 18
  [39.5, 0, -21.3, 3.6],    // 19 ← east hairpin
  [41, 0, -19.0, 3.6],      // 20
  [38.5, 0, -17.2, 3.4],    // 21
  [32, 0, -17.0, 3.2],      // 22 ← Aisle 4, heading −X
  [12, 0, -17.0, 3.2],      // 23
  [0, 0, -17.0, 3.2],       // 24
  [-14, 0, -17.0, 3.2],     // 25
  [-23, 0, -17.0, 3.2],     // 26
  [-27.5, 0, -16.2, 3.4],   // 27 ← west hairpin
  [-29.5, 0, -14.0, 3.4],   // 28
  [-27.5, 0, -11.8, 3.4],   // 29
  [-23, 0, -11.0, 3.2],     // 30 ← Aisle 6, heading +X
  [-12, 0, -11.0, 3.2],     // 31
  [0, 0, -11.0, 3.2],       // 32
  [16, 0, -11.0, 3.2],      // 33
  [31, 0, -11.0, 3.4],      // 34
  [37, 0, -9.0, 3.6],       // 35 ← out into the front of store, heading +Z
  [40.5, 0, -2.0, 3.6],     // 36
  [39, 0, 8.0, 3.8],        // 37
  [35, 0, 15.0, 3.8],       // 38
  [28, 0, 18.3, 3.8],       // 39
];

export default {
  id: 'supermarket',
  name: 'Supermarket Sweep',
  difficulty: 'medium',
  laps: 3,
  theme: 'indoor',
  order: 2,
  seed: 74112,
  previewColors: [0xe8eef4, 0xf0b21e, 0x1e6fbf],
  description:
    'Closing time at the hypermarket. Serpentine the aisles, launch off the '
    + 'goods-in dock over the leveller pit — or gamble on the boarded-over '
    + 'shelf in the refit bay.',

  /** @param {import('../TrackBuilder.js').TrackBuilder} b */
  build(b) {
    b.centerline(NODES, { closed: true, samplesPerSegment: 30 });
    b.defaultSurface(SurfaceId.TILE);

    buildShell(b);
    buildFloors(b);
    buildAisles(b);
    buildFreezers(b);
    buildRoad(b);
    buildDock(b);
    buildRefitGap(b);
    buildFrontOfStore(b);
    buildProduce(b);
    buildLighting(b);
    buildRaceData(b);
  },
};

// ═════════════════════════════════════════════════════════════════ the shell

function buildShell(b) {
  // Walls + ceiling. No floor — the zones below each get their own material,
  // and the dock pit needs a hole the room primitive cannot cut.
  b.room({
    min: [STORE.x0, STORE.z0], max: [STORE.x1, STORE.z1],
    height: STORE.h, thickness: 0.5,
    floor: false, ceiling: true,
    skip: ['s'],
    wallMaterial: 'drywall/painted',
    wallMatOpts: { color: 0xdfe5ea },
    wallSurfaceId: SurfaceId.CONCRETE,
    ceilingMaterial: 'metal/galvanised',
    ceilingTint: 0x8f979f,
    skirting: { height: 0.16, material: 'plastic/abs_matte' },
  });

  // ── the shopfront (south wall): a glazed curtain wall over a stub ──
  const front = [
    // [height, y, material, tint, surfaceId]
    [0.55, 0, 'metal/painted', 0x33383d, SurfaceId.METAL],
    [3.3, 0.55, 'glass/clear', 0xbfe0ea, SurfaceId.GLASS],
    [3.15, 3.85, 'drywall/painted', 0xdfe5ea, SurfaceId.CONCRETE],
  ];
  for (const [h, y, mat, tint, sid] of front) {
    b.wall([STORE.x0, STORE.z1], [STORE.x1, STORE.z1], {
      thickness: mat === 'glass/clear' ? 0.12 : 0.5, height: h, y,
      material: mat, matOpts: { color: tint }, surfaceId: sid, cast: h > 1,
    });
  }
  // Mullions, so the glazing reads as a shopfront rather than a sheet of ice.
  const mullion = G.boxMeters(0.09, 3.3, 0.16);
  const mullionMat = b.mat('metal/painted', { color: 0x2b3036 });
  for (let x = STORE.x0 + 2; x < STORE.x1; x += 3.6) {
    b.instanceAt('store:mullion', mullion, mullionMat, [x, 0.55, STORE.z1 - 0.2],
      null, 1, { collide: false, surfaceId: SurfaceId.METAL, cast: false });
  }
  mullion.dispose();

  // Steel roof trusses across the store — the thing that sells "7 m ceiling".
  const trussMat = b.mat('metal/galvanised', { color: 0x6d747b });
  for (let z = STORE.z0 + 5; z < STORE.z1; z += 8.5) {
    const chords = [];
    for (const y of [6.35, 6.85]) {
      const g = G.boxMeters(STORE.x1 - STORE.x0, 0.12, 0.14);
      g.translate((STORE.x0 + STORE.x1) / 2, y, z);
      chords.push(g);
    }
    for (let x = STORE.x0 + 1; x < STORE.x1; x += 2.2) {
      const g = G.boxMeters(0.07, 0.5, 0.09);
      g.translate(x, 6.6, z);
      chords.push(g);
    }
    const truss = G.mergeList(chords);
    for (const g of chords) g.dispose();
    if (truss) {
      b.add(truss, trussMat, { surfaceId: null, collide: false, cast: false, receive: false, decor: true });
      truss.dispose();
    }
  }
}

// ══════════════════════════════════════════════════════════════════ floors

/**
 * The store floor, laid as rectangles that go AROUND the dock-leveller pit.
 * `floor({ polygon, holes })` would be the obvious tool, but `GeoLib.polygonXZ`
 * negates z on the way from shape space to world space — `[[x, z]]` lands at
 * `(x, 0, −z)` — so a polygon floor with a hole would be mirrored about the
 * X axis. Four rectangles need no such trust.
 */
function buildFloors(b) {
  const vinyl = { material: 'tile/lino_check', surfaceId: SurfaceId.TILE, matOpts: { color: 0xdfe3e6 } };
  const polished = { material: 'tile/ceramic_glazed', surfaceId: SurfaceId.TILE, matOpts: { color: 0xe9e6de } };

  const rect = (x0, x1, z0, z1, o) => b.floor({
    center: [(x0 + x1) / 2, (z0 + z1) / 2], size: [x1 - x0, z1 - z0], ...o,
  });

  // Aisle bank — grey speckled vinyl, in three pieces so the pit stays open.
  rect(STORE.x0, PIT.x0, STORE.z0, -4, vinyl);
  rect(PIT.x1, STORE.x1, STORE.z0, -4, vinyl);
  rect(PIT.x0, PIT.x1, STORE.z0, PIT.z0, vinyl);
  // (PIT.z1 == -21.2 is north of -4, so this strip closes the last side.)
  rect(PIT.x0, PIT.x1, PIT.z1, -4, vinyl);

  // Front of store — polished ceramic, because that is what the customer sees.
  rect(STORE.x0, STORE.x1, -4, STORE.z1, polished);

  // Back-of-house concrete under the dock — in TWO pieces, because a single
  // slab here paves straight over the pit and quietly turns the jump into a
  // 0.62 m step down onto solid floor. The drivability gate cannot see that:
  // it skips declared gap stations entirely, so a gap that is not actually a
  // gap is invisible to it and it stays green either way.
  const bohO = { material: 'concrete/screed', surfaceId: SurfaceId.CONCRETE, y: 0.004, matOpts: { color: 0xa8a49c } };
  rect(DOCK.x0 - 6.5, PIT.x0, STORE.z0 + 0.3, -20.6, bohO);
  rect(PIT.x1, PIT.x1 + 3.5, STORE.z0 + 0.3, -20.6, bohO);
}

// ════════════════════════════════════════════════════════════════ the aisles

/**
 * One gondola run: a solid slab the full silhouette deep, with shelf boards and
 * stock recessed INSIDE it. Making the boards protrude would put decoration
 * outside the collision hull, and a car would drive through a shelf it can see.
 */
function gondolaRun(b, z, spans, o = {}) {
  const D = RUN.depth, H = o.height ?? RUN.height;
  const steel = b.mat('metal/painted', { color: o.color ?? 0xdadde1 });
  const shelfMat = b.mat('metal/galvanised', { color: 0xb9bec4 });

  for (const [x0, x1] of spans) {
    const len = x1 - x0;
    if (len < 0.3) continue;

    b.wall([x0, z], [x1, z], {
      thickness: D, height: H,
      material: 'metal/painted', matOpts: { color: o.color ?? 0xdadde1 },
      surfaceId: SurfaceId.METAL,
      skirting: { height: 0.12, material: 'plastic/abs_matte' },
    });

    // Shelf boards + a band of stock per level, recessed 0.05 m inside the face.
    const detail = [];
    for (const s of [-1, 1]) {
      for (const y of [0.46, 0.92, 1.38]) {
        const board = G.boxMeters(len - 0.1, 0.04, 0.34);
        board.translate((x0 + x1) / 2, y, z + s * (D / 2 - 0.22));
        detail.push(board);
      }
    }
    const boards = G.mergeList(detail);
    for (const g of detail) g.dispose();
    if (boards) {
      b.add(boards, shelfMat, { surfaceId: null, collide: false, cast: false, receive: true });
      boards.dispose();
    }

    // The stock itself: short tinted blocks, one InstancedMesh per colour.
    const tints = o.stock ?? [0xd8412f, 0xf0b21e, 0x2f6fbf, 0x3a9a53, 0xe8e2d4];
    const box = G.boxMeters(0.5, 0.34, 0.28, { radius: 0.01, seg: 2 });
    for (const s of [-1, 1]) {
      for (const y of [0.46, 0.92, 1.38]) {
        for (let x = x0 + 0.5; x < x1 - 0.3; x += 0.62) {
          const tint = tints[b.rndInt(0, tints.length - 1)];
          b.instanceAt(`gondola:stock:${tint}`, box,
            b.mat('cardboard/kraft', { color: tint }),
            [x, y + 0.19, z + s * (D / 2 - 0.20)], null, 1,
            { collide: false, surfaceId: null, cast: false, receive: true });
        }
      }
    }
    box.dispose();

    // Overstock pallets on the top deck: visible from the aisle floor as a rim
    // 17 car-heights up, which is most of what sells the scale here.
    const pallet = G.boxMeters(0.9, 0.55, 1.0, { radius: 0.02, seg: 2 });
    for (let x = x0 + 1.6; x < x1 - 1.0; x += 3.4) {
      b.instanceAt('gondola:overstock', pallet, b.mat('cardboard/corrugated', { color: 0xbfa77e }),
        [x, H, z], [0, b.rnd() * 0.2 - 0.1, 0], 1,
        { collide: false, surfaceId: null, cast: true, receive: false });
    }
    pallet.dispose();
  }
  void steel;
}

function buildAisles(b) {
  // Every run stops at RUN.x0 / RUN.x1 so the cross-aisle hairpins are clear of
  // shelving, and the z = −20 run additionally skips the refit bay.
  const cut = [CUT.x - CUT.half, CUT.x + CUT.half];
  gondolaRun(b, RUN_Z[0], [[RUN.x0, cut[0]], [cut[1], RUN.x1]]);
  gondolaRun(b, RUN_Z[1], [[RUN.x0, RUN.x1]]);
  gondolaRun(b, RUN_Z[2], [[RUN.x0, RUN_SHORT_X1]]);

  // End caps: promo stacks on the aisle mouths, where you clip them.
  for (const z of RUN_Z) {
    for (const x of [RUN.x0 - 0.5, (z === RUN_Z[2] ? RUN_SHORT_X1 : RUN.x1) + 0.5]) {
      b.prop('crate', { position: [x, 0, z], rotation: [0, 0.2, 0], width: 0.9, height: 0.7, depth: 0.9, open: true });
      b.prop('crate', { position: [x + 0.1, 0.7, z - 0.1], rotation: [0, -0.4, 0], width: 0.7, height: 0.5, depth: 0.7 });
      for (let i = 0; i < 5; i++) {
        b.prop('can', {
          position: [x + Math.cos(i * 1.7) * 0.55, 0, z + Math.sin(i * 1.7) * 0.55],
          color: [0xd8412f, 0x2f6fbf, 0xf0b21e][i % 3],
        });
      }
    }
  }

  // Aisle signage hung over each mouth. Numbered the way stores do it.
  const signs = [
    [RUN.x1 + 1.2, AISLE.back, ['AISLE 2', 'HOME · PET']],
    [RUN.x1 + 1.2, AISLE.four, ['AISLE 4', 'CEREAL · TEA']],
    [RUN_SHORT_X1 + 0.6, AISLE.six, ['AISLE 6', 'BAKERY']],
    [RUN.x0 - 1.2, AISLE.four, ['AISLE 4', 'CEREAL · TEA']],
    [RUN.x0 - 1.2, AISLE.six, ['AISLE 6', 'BAKERY']],
  ];
  const rodMat = b.mat('metal/brushed_alu', { color: 0x9aa1a8 });
  const rod = G.cylinderMeters(0.018, 0.018, 2.7, 6);
  for (const [x, z, text] of signs) {
    b.prop('picture_frame', {
      position: [x, 2.9, z], rotation: [0, Math.PI / 2, 0],
      width: 2.2, height: 0.7, text,
      background: '#1e6fbf', textColor: '#f4f8fc', frameColor: 0xc9ced4,
    });
    // Drop rods to the ceiling. Non-colliding: they are 2.6 m up, the gate only
    // probes to 0.104 m, and nothing that can get up there is a car.
    for (const s of [-1, 1]) {
      b.instanceAt('store:signRod', rod, rodMat, [x, 4.6, z + s * 0.9], null, 1,
        { collide: false, surfaceId: null, cast: false, decor: true });
    }
  }
  rod.dispose();

  // Spilled stock in the aisles, out at the road edge where a wide line finds it.
  const spills = [
    [8, AISLE.four, 1.35], [-6, AISLE.four, -1.35],
    [-16, AISLE.six, 1.3], [4, AISLE.six, -1.3], [16, AISLE.back, 1.4],
  ];
  for (const [x, z, off] of spills) {
    for (let i = 0; i < 7; i++) {
      b.prop('can', {
        position: [x + Math.cos(i * 2.2) * 0.7, 0.02 + (i % 2) * 0.13, z + off + Math.sin(i * 2.2) * 0.5],
        rotation: [i % 2 ? Math.PI / 2 : 0, i * 0.7, 0],
        color: [0xd8412f, 0x3a9a53, 0xf0b21e, 0x2f6fbf][i % 4],
      });
    }
    b.prop('crate', { position: [x - 0.9, 0, z + off * 1.12], rotation: [0, 0.7, 0], width: 0.6, height: 0.45, depth: 0.45, open: true });
  }

  // A ceiling fan over the back aisle, because the store's air-con is broken.
  buildFan(b, { position: [-14, 5.9, AISLE.back], radius: 1.2, blades: 4, speed: 1.9, dropLength: 0.7 });
}

// ═════════════════════════════════════════════════════════════ frozen foods

function buildFreezers(b) {
  const F = FREEZER;
  // A solid bank, exactly like a gondola but taller and lit from inside.
  b.wall([F.x, F.z0], [F.x, F.z1], {
    thickness: F.depth, height: F.height,
    material: 'metal/painted', matOpts: { color: 0xe6ebef },
    surfaceId: SurfaceId.METAL,
    skirting: { height: 0.14, material: 'plastic/abs_matte' },
  });

  // Glass doors down the racing-line side only — the other face is the hairpin's
  // and nobody looks at it.
  const doorMat = b.mat('glass/clear', { color: 0xcfe8f2, doubleSide: true, transparent: true, opacity: 0.4 });
  const glowMat = b.glow(0xdff0ff, 2.6, { base: 0x101820 });
  const door = G.boxMeters(0.06, 1.6, 0.86);
  const lamp = G.boxMeters(0.03, 0.05, 0.8);
  for (let z = F.z0 + 0.6; z < F.z1 - 0.4; z += 0.95) {
    b.instanceAt('freezer:door', door, doorMat, [F.x - F.depth / 2 + 0.02, 0.9, z],
      null, 1, { collide: false, surfaceId: null, cast: false, order: 3 });
    for (const y of [0.32, 1.02, 1.66]) {
      b.instanceAt('freezer:lamp', lamp, glowMat, [F.x - F.depth / 2 + 0.06, y, z],
        null, 1, { collide: false, surfaceId: null, cast: false });
    }
  }
  door.dispose();
  lamp.dispose();

  // Chest freezers against the WEST wall, not between the bank and the road.
  // The frozen aisle is 3.4 m of road with edges at x ≈ −37.7 / −34.3; the wall's
  // inner face is at −39.75, so a 1.0 m deep cabinet centred on −38.8 has 0.6 m
  // to the road edge and 1.85 m to the ±0.45 m corridor. Sited at −35.4 (which
  // is what `F.x − 2.6` gives) their 0.62 m plinths sat *inside* the corridor
  // and the gate reported five of them plus a respawn buried in one.
  for (let i = 0; i < 5; i++) {
    b.prop('display_case', {
      position: [-38.8, 0, F.z0 + 2.4 + i * 4.4], rotation: [0, Math.PI / 2, 0],
      width: 2.2, depth: 1.0, plinthHeight: 0.62, glassHeight: 0.24,
      plinthColor: 0xd6dce1,
    });
  }
  b.prop('picture_frame', {
    position: [F.x - F.depth / 2 - 0.05, 2.5, (F.z0 + F.z1) / 2], rotation: [0, -Math.PI / 2, 0],
    width: 3.0, height: 0.9, text: ['FROZEN', '−18 °C'],
    background: '#0f3f6b', textColor: '#dff0ff', frameColor: 0xc9ced4,
  });
}

// ═══════════════════════════════════════════════════════════════════ the road

/**
 * There is no tarmac in a supermarket — the racing surface IS the store floor.
 * The line is marked the way a warehouse marks a walkway: two painted lanes.
 * They are pure decals (`surfaceId: null`), so they change nothing underfoot.
 */
function buildRoad(b) {
  for (const off of [-1.15, 1.15]) {
    b.stripe({
      width: 0.16, offset: off, y: 0.008, bevel: 0,
      material: 'plastic/abs_matte', matOpts: { color: 0xf0b21e },
      surfaceId: null, step: 0.6,
    });
  }

  b.finishLine(0, { depth: 0.7 });
  b.banner(0, {
    text: 'RC RUMBLE', key: 'finish',
    height: 2.2, clearance: 1.3, width: 5.6,
    background: '#1e6fbf', textColor: '#f4f8fc', border: '#f0b21e',
  });
  b.banner(b.spline.wrapT(-52 / b.spline.length), {
    text: '3 FOR 2', key: 'promo',
    height: 2.2, clearance: 1.4, width: 5.0,
    background: '#d8412f', textColor: '#fff4e2', border: '#f0b21e',
  });
}

// ══════════════════════════════════════════════════════ goods-in: ramp + jump

/**
 * The dock, and the arithmetic behind the jump.
 *
 * RAMP — 0.62 m over 5.4 m of run is 6.55°, needing g·sin θ = 2.24 m/s² to
 * climb. Every car in the game has at least 9 m/s². It tops out AT `DOCK.x0`,
 * which is centreline node 13: the museum's table ramp topped out 5.5 m PAST
 * its deck edge and left a 43.8° face across the racing line that nothing in
 * the game could climb.
 *
 * JUMP — every number below was READ BACK off the built collision mesh by
 * raycasting down the line at 5 mm intervals, not taken from the design. The
 * design said "1.35 m gap, 0.62 m drop, 7.6° lip"; the mesh says:
 *
 *     take-off  x = 4.405  y = 0.720   (deck 0.62 + the lip's 0.10)
 *     landing   x = 5.905  y = 0.004   (the pit's east lip)
 *     gap 1.50 m · drop 0.716 m · lip 3.44°
 *
 * The lip is half the designed angle because `jumpGap` eases with f² over
 * `lipLength` but the loft stations are 0.28 m apart, so the last station lands
 * short of the full slope. With g = 19.6:
 *
 *     vy = v·sin θ ; t = (vy + √(vy² + 2gh)) / g ; range = v·cos θ·t
 *
 *     v = 8 m/s → 2.36 m      v = 6.0 m/s → 1.73 m
 *     v = 7 m/s → 2.04 m      v = 5.5 m/s → 1.58 m
 *
 * Minimum clearing speed 5.25 m/s. The AI arrives at 7.65, giving 36% margin.
 * Short of it you drop into a 0.45 m pit, which is the point of it. (The
 * Garden's deck jump needed 4.83 m of flight off a −5.73° lip and the car
 * covers 2.64 m — a downhill lip is almost always the mistake.)
 */
function buildDock(b) {
  const D = DOCK;
  const concrete = b.mat('concrete/screed', { color: 0xb4b0a6 });

  // ── the platform ──
  const deck = G.boxMeters(D.x1 - D.x0, D.y, D.z1 - D.z0, { radius: 0.01, seg: 2 });
  deck.translate((D.x0 + D.x1) / 2, D.y / 2, (D.z0 + D.z1) / 2);
  b.add(deck, concrete, { surfaceId: SurfaceId.CONCRETE, cast: true, receive: true });
  deck.dispose();

  // Yellow safety edge along the open (south) lip of the platform.
  const edge = G.boxMeters(D.x1 - D.x0, 0.02, 0.28);
  edge.translate((D.x0 + D.x1) / 2, D.y + 0.005, D.z1 - 0.14);
  b.add(edge, b.mat('plastic/abs_matte', { color: 0xf0b21e }), {
    surfaceId: null, collide: false, cast: false, receive: true, order: 1,
  });
  edge.dispose();

  // ── the ramp up ──
  b.ramp({
    from: [D.rampX0, 0, AISLE.back], to: [D.x0, D.y, AISLE.back],
    width: 4.0, thickness: 0.12,
    material: 'metal/diamond_plate', surfaceId: SurfaceId.METAL,
    support: false, lead: 0,
    rails: { height: 0.10, material: 'metal/painted' },
  });
  // Cheeks either side of the ramp so a wheel off the edge meets a slope, not
  // a 0.62 m drop onto the concrete.
  //
  // `extrudeOutline` builds the outline in XY and extrudes along Z. This ramp
  // runs along X, so the outline is already in the right plane and must NOT be
  // rotated. Rotating it (as the museum's ramp correctly does, because that one
  // runs along Z) turns the cheek into a 0.62 m wall lying straight across the
  // racing corridor — the drivability gate caught exactly that here.
  for (const s of [-1, 1]) {
    const cheek = G.extrudeOutline([[-2.7, 0], [2.7, 0], [2.7, D.y], [-2.7, 0.02]], 0.10);
    cheek.translate(D.x0 - 2.7, 0, AISLE.back + s * 2.05);
    b.add(cheek, b.mat('metal/painted', { color: 0x9aa1a8 }), {
      surfaceId: SurfaceId.METAL, cast: true, receive: true,
    });
    cheek.dispose();
  }

  // ── the pit ──
  const pitMat = b.mat('concrete/rough', { color: 0x6f6c66 });
  const pitFloor = G.planeXZ(PIT.x1 - PIT.x0, PIT.z1 - PIT.z0);
  pitFloor.translate((PIT.x0 + PIT.x1) / 2, -PIT.depth, (PIT.z0 + PIT.z1) / 2);
  b.add(pitFloor, pitMat, { surfaceId: SurfaceId.CONCRETE, cast: false, receive: true });
  pitFloor.dispose();
  // Its east and end walls (the west side is the platform's own face).
  for (const [a, c] of [
    [[PIT.x1, PIT.z0], [PIT.x1, PIT.z1]],
    [[PIT.x0, PIT.z0], [PIT.x1, PIT.z0]],
    [[PIT.x0, PIT.z1], [PIT.x1, PIT.z1]],
  ]) {
    b.wall(a, c, {
      thickness: 0.1, height: PIT.depth, y: -PIT.depth,
      material: 'concrete/rough', matOpts: { color: 0x6f6c66 },
      surfaceId: SurfaceId.CONCRETE, cast: false,
    });
  }

  // ── the gap itself ──
  b.jumpGap(b.tNear([D.x1, D.y, AISLE.back]), b.tNear([LAND_X, 0, AISLE.back]), {
    lipRise: 0.10, lipLength: 1.5,
    material: 'metal/diamond_plate', surfaceId: SurfaceId.METAL,
  });

  // Hazard chevrons and cones round the pit, so it reads before you commit.
  for (const s of [-1, 1]) {
    b.prop('cone', { position: [PIT.x0 - 0.9, D.y, AISLE.back + s * 2.4], height: 0.4 });
    b.prop('cone', { position: [PIT.x1 + 0.8, 0, AISLE.back + s * 2.4], height: 0.4 });
  }
  b.prop('picture_frame', {
    position: [PIT.x1 + 3.2, 1.5, STORE.z0 + 0.55],
    width: 1.6, height: 0.9, text: ['GOODS IN', 'NO ENTRY'],
    background: '#d8412f', textColor: '#fff4e2',
  });

  // Dressing on the platform: a cage trolley, roll cages, shrink-wrapped stock.
  for (let i = 0; i < 3; i++) {
    b.prop('crate_heavy', {
      position: [D.x0 + 1.0 + i * 1.4, D.y, D.z0 + 1.1], rotation: [0, 0.2 * i, 0],
      width: 0.8, height: 0.7, depth: 0.7,
    });
  }
  b.prop('crate_heavy', { position: [D.x0 + 1.2, D.y + 0.7, D.z0 + 1.0], width: 0.6, height: 0.5, depth: 0.5 });
  b.prop('tin_bucket', { position: [D.x1 - 1.2, D.y, D.z0 + 0.9] });

  // A roller shutter on the back wall, behind the dock.
  const shutter = G.boxMeters(7.0, 4.2, 0.12);
  shutter.translate((D.x0 + D.x1) / 2, 2.1, STORE.z0 + 0.32);
  b.add(shutter, b.mat('metal/galvanised', { color: 0x8a9199 }), {
    surfaceId: SurfaceId.METAL, cast: false, receive: true,
  });
  shutter.dispose();
}

// ════════════════════════════════════════════════════════════ the shelf cut

/**
 * The refit bay. One bay of the z = −20 gondola is stripped and boarded at
 * 0.50 m; a pallet ramp leans on it from the back aisle and there is nothing at
 * all on the Aisle 4 side — you come off a 0.50 m ledge, blind, across the line.
 *
 * The deck is bare shelf steel: grip 0.95 against the floor's 1.05, rolling
 * resistance 0.011 against 0.010, bumpiness 0.030 against 0.008, restitution
 * 1.15 against 1.10. Worse on every channel that separates two dry surfaces —
 * `drag` is 0.0 for both and cannot distinguish them. That is deliberate: the
 * Garden's lawn once beat its own gravel path on grip AND rolling resistance
 * AND drag AND bumpiness, which made cutting the corner strictly free.
 */
function buildRefitGap(b) {
  const zRun = RUN_Z[0];
  const nearZ = zRun + RUN.depth / 2;    // −19.28, the Aisle 4 face
  const farZ = zRun - RUN.depth / 2;     // −20.72, the back-aisle face
  const steel = b.mat('metal/galvanised', { color: 0xa9b0b6 });

  // ── the boarded-over bay ──
  const deck = G.boxMeters(CUT.half * 2, 0.08, RUN.depth + 0.5, { radius: 0.008, seg: 2 });
  deck.translate(CUT.x, CUT.y - 0.04, zRun);
  b.add(deck, steel, { surfaceId: SurfaceId.METAL, cast: true, receive: true });
  deck.dispose();
  // Legs, so it is a shelf and not a floating plank.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.addAt(G.boxMeters(0.09, CUT.y - 0.08, 0.09), steel,
        [CUT.x + sx * (CUT.half - 0.2), (CUT.y - 0.08) / 2, zRun + sz * (RUN.depth / 2 - 0.1)],
        null, 1, { surfaceId: SurfaceId.METAL, cast: false, receive: false });
    }
  }
  // Low kerbs down the sides of the crossing — enough to keep a wheel on, not
  // enough to save you if you arrive sideways.
  for (const sx of [-1, 1]) {
    const kerb = G.boxMeters(0.07, 0.09, RUN.depth + 0.5);
    kerb.translate(CUT.x + sx * (CUT.half - 0.04), CUT.y + 0.045, zRun);
    b.add(kerb, steel, { surfaceId: SurfaceId.METAL, cast: false, receive: true });
    kerb.dispose();
  }

  // ── the pallet ramp up from the back aisle ──
  // 0.50 m over 1.48 m of run is 18.7°, needing g·sin θ = 6.28 m/s². The
  // slowest car in the game has 9.1, so it is climbable — but only if you are
  // still moving, which is the whole gamble. Its foot pokes 0.4 m inside the
  // back aisle's road edge (1.30 m off the centreline, against a ±0.45 m
  // corridor): the mouth of the shortcut is deliberately something you can
  // clip if you run wide on the fastest straight on the lap.
  const rampFootZ = farZ - 1.48;
  b.ramp({
    from: [CUT.x, 0, rampFootZ], to: [CUT.x, CUT.y, farZ],
    width: 2.2, thickness: 0.10,
    material: 'wood/plywood_varnish', surfaceId: SurfaceId.WOOD,
    support: false, lead: 0,
  });
  // This ramp runs along Z, so the cheek outline DOES need rotating into ZY.
  // `rotateY(-PI/2)` maps outline +X to world +Z; `rotateY(+PI/2)` maps it to
  // world −Z and puts the wedge's tall end at the ramp's FOOT. (toy_museum.js
  // rotates the wrong way for the same reason — cosmetic there, since the deck
  // hides it.)
  for (const sx of [-1, 1]) {
    const cheek = G.extrudeOutline([[-0.74, 0], [0.74, 0], [0.74, CUT.y], [-0.74, 0.02]], 0.08);
    cheek.rotateY(-Math.PI / 2);
    cheek.translate(CUT.x + sx * 1.14, 0, farZ - 0.74);
    b.add(cheek, b.mat('wood/pine_planks'), { surfaceId: SurfaceId.WOOD, cast: false, receive: true });
    cheek.dispose();
  }

  // ── the exit: a drop, not a ramp ──
  // There is only 0.68 m between the shelf face and the Aisle 4 road edge here.
  // A run-out ramp would need 1.8 m and would therefore lie across the racing
  // line, so it does not get one. You fall the 0.50 m.
  b.prop('picture_frame', {
    position: [CUT.x, 1.35, nearZ + 0.08], rotation: [0, Math.PI, 0],
    width: 1.5, height: 0.55, text: 'BAY CLOSED',
    background: '#d8412f', textColor: '#fff4e2',
  });
  b.prop('cone', { position: [CUT.x - 1.7, 0, nearZ + 0.35], height: 0.4 });
  b.prop('cone', { position: [CUT.x + 1.7, 0, nearZ + 0.35], height: 0.4 });

  // Scaffold and stripped shelf parts stacked in the bay, at head height.
  for (let i = 0; i < 4; i++) {
    const bar = G.cylinderMeters(0.03, 0.03, 2.6, 6);
    bar.rotateZ(Math.PI / 2);
    bar.translate(CUT.x, 1.55 + i * 0.09, zRun - 0.3 + i * 0.2);
    b.add(bar, steel, { surfaceId: null, collide: false, cast: true, receive: false, decor: true });
    bar.dispose();
  }

  // ── the registered branch ──
  // No `shortcutRoad`: the ramp, deck and floor above already ARE the surface,
  // and a lofted ribbon along this spline would float over the drop and put a
  // 0.2 m edge inside Aisle 4's racing corridor.
  b.shortcut({
    id: 'refit_bay',
    name: 'Refit Bay',
    entryT: b.tNear([CUT.x, 0, AISLE.back]),
    exitT: b.tNear([CUT.x - 1.5, 0, AISLE.four]),
    risk: 0.8,
    width: 2.2,
    // Measured: 30.0 m of main line between entryT and exitT against a 7.8 m
    // branch spline.
    savedMetres: 22,
    nodes: [
      { p: [CUT.x, 0, AISLE.back + 0.6], w: 2.6 },
      { p: [CUT.x, 0, rampFootZ], w: 2.2 },
      { p: [CUT.x, CUT.y, farZ], w: 2.0 },
      { p: [CUT.x, CUT.y, nearZ], w: 2.0 },
      { p: [CUT.x - 0.6, 0.10, nearZ + 0.55], w: 2.2 },
      { p: [CUT.x - 1.5, 0, AISLE.four - 0.4], w: 2.6 },
      { p: [CUT.x - 3.0, 0, AISLE.four], w: 3.0 },
    ],
  });
}

// ═══════════════════════════════════════════════════════════ front of store

function buildFrontOfStore(b) {
  // ── the checkouts ──
  // A row of tills between the start/finish straight and the aisle bank. They
  // are PARALLEL to the road and 3.4 m clear of its southern edge; nothing here
  // is ever between two centreline nodes.
  const tillMat = b.mat('plastic/abs_matte', { color: 0xd9dee3 });
  const beltMat = b.mat('rubber/floor_mat', { color: 0x22262b });
  for (let i = 0; i < 8; i++) {
    const x = -18 + i * 4.6;
    const body = G.mergeList([
      (() => { const g = G.boxMeters(1.1, 0.92, 0.8, { radius: 0.03, seg: 2 }); g.translate(0, 0.46, 0); return g; })(),
      (() => { const g = G.boxMeters(0.55, 0.78, 2.6, { radius: 0.03, seg: 2 }); g.translate(0.9, 0.39, 1.5); return g; })(),
    ]);
    b.addAt(body, tillMat, [x, 0, 13.0], null, 1, { surfaceId: SurfaceId.PLASTIC });
    body.dispose();
    const belt = G.boxMeters(0.44, 0.03, 2.4);
    belt.translate(x + 0.9, 0.79, 14.5);
    b.add(belt, beltMat, { surfaceId: SurfaceId.RUBBER, cast: false, receive: true });
    belt.dispose();
    // Lane number on a post.
    b.prop('picture_frame', {
      position: [x, 1.85, 12.6], width: 0.5, height: 0.5, text: String(i + 1),
      background: i % 3 === 0 ? '#3a9a53' : '#1e6fbf', textColor: '#f4f8fc',
    });
    b.prop('book_stack', { position: [x + 0.85, 0.80, 15.4], rotation: [0, 0.4 * i, 0], count: 4, seed: 11 + i });
  }

  // ── the trolley bay, on the outside of the start straight ──
  const trolley = G.mergeList([
    (() => { const g = G.boxMeters(0.52, 0.42, 0.74, { radius: 0.03, seg: 2 }); g.translate(0, 0.44, 0); return g; })(),
    ...[[-0.22, -0.32], [0.22, -0.32], [-0.22, 0.32], [0.22, 0.32]].map(([dx, dz]) => {
      const g = G.cylinderMeters(0.018, 0.018, 0.24);
      g.translate(dx, 0.12, dz);
      return g;
    }),
  ]);
  // Nested along X, not Z: the road edge here is z = 20.4 and a Z-nested bay of
  // nine trolleys is 4.1 m deep, which walks straight back onto the start/finish
  // straight. Turned side-on the whole bay is 0.52 m deep and sits 1.5 m clear.
  const trolleyMat = b.mat('metal/chrome', { color: 0xc8ced4 });
  for (let bay = 0; bay < 3; bay++) {
    for (let i = 0; i < 9; i++) {
      b.instanceAt('store:trolley', trolley, trolleyMat,
        [-12 + bay * 9.5 + i * 0.42, 0, 22.2], [0, Math.PI / 2, 0], 1,
        { collide: 'box', surfaceId: SurfaceId.METAL, cast: true });
    }
  }
  trolley.dispose();

  // ── queue barriers along the inside of the straight ──
  for (let i = 0; i < 8; i++) {
    const x = 14 - i * 4.0;
    b.prop('stanchion', { position: [x, 0, 15.9], instanced: true });
    if (i > 0) ropeBetween(b, [x + 4.0, 0.47, 15.9], [x, 0.47, 15.9]);
  }

  // ── the deli / bakery counter in the south-east ──
  b.floor({
    center: [24, 4], size: [11, 8], y: 0.006,
    material: 'tile/mosaic', matOpts: { color: 0xd9cfbc },
    surfaceId: SurfaceId.TILE,
  });
  const counter = G.mergeList([
    (() => { const g = G.boxMeters(9.0, 1.05, 1.1, { radius: 0.03, seg: 2 }); g.translate(0, 0.52, 0); return g; })(),
  ]);
  b.addAt(counter, b.mat('metal/brushed_alu'), [24, 0, 6.4], null, 1, { surfaceId: SurfaceId.METAL });
  counter.dispose();
  b.prop('picture_frame', {
    position: [24, 2.4, 7.0], rotation: [0, Math.PI, 0],
    width: 3.2, height: 0.8, text: ['DELI', 'FRESH TODAY'],
    background: '#8a5a1e', textColor: '#fff0d4',
  });
  for (let i = 0; i < 6; i++) {
    b.prop('book_stack', { position: [20.4 + i * 1.4, 1.05, 6.4], rotation: [0, i, 0], count: 3, seed: 40 + i });
  }

  // Loose trolleys and a spilled shopping basket ON the racing line's outside.
  b.prop('crate', { position: [-24, 0, 20.4], rotation: [0, 0.5, 0], width: 0.7, height: 0.5, depth: 0.5, open: true });
  for (let i = 0; i < 8; i++) {
    b.prop('ball', {
      position: [-23 + Math.cos(i * 1.9) * 1.1, 0.11, 20.6 + Math.sin(i * 1.9) * 1.1],
      radius: 0.11, color: [0xe8622c, 0xd8b81e, 0x8ab63a][i % 3],
    });
  }
}

// ══════════════════════════════════════════════════════════════════ produce

function buildProduce(b) {
  // The north-west corner, on the outside of the produce hairpin. Everything
  // here is at least 1.2 m outside the road edge.
  b.floor({
    center: [-33, 16], size: [12, 12], y: 0.006,
    material: 'tile/mosaic', matOpts: { color: 0xcfd7c4 },
    surfaceId: SurfaceId.TILE,
  });

  const crateMat = b.mat('wood/pine_planks', { color: 0xb38c56 });
  const bin = G.mergeList([
    (() => { const g = G.boxMeters(1.6, 0.62, 1.6, { radius: 0.02, seg: 2 }); g.translate(0, 0.31, 0); return g; })(),
  ]);
  // Sited from the road extent, not by eye: the produce corner sweeps through
  // (−22, 17.5) → (−30, 14.5) → (−35, 9) with a 3.4 m road, so nothing here
  // goes east of x = −24 or south of z = 16 near the apex. A bin at (−31, 15)
  // put its corner 0.2 m from centreline node 4.
  for (const [x, z] of [[-36.5, 20.5], [-32.5, 21.5], [-37.5, 16.0], [-28.0, 21.8], [-24.0, 21.5]]) {
    b.instanceAt('produce:bin', bin, crateMat, [x, 0, z], [0, 0.2, 0], 1,
      { collide: 'box', surfaceId: SurfaceId.WOOD });
    for (let i = 0; i < 6; i++) {
      b.prop('ball', {
        position: [x + (b.rnd() - 0.5) * 1.1, 0.68, z + (b.rnd() - 0.5) * 1.1],
        radius: 0.09 + b.rnd() * 0.04,
        color: [0xd8412f, 0xe8912c, 0x8ab63a, 0xe0c832][i % 4],
      });
    }
  }
  bin.dispose();

  for (const [x, z] of [[-38.5, 12], [-30.5, 21], [-25.5, 21.5]]) {
    b.prop('plant_pot', { position: [x, 0, z], radius: 0.4, height: 0.5, color: 0x8d6a48 });
    b.prop('bush', { position: [x, 0.5, z], radius: 0.42, seed: 7 + x, instanced: false });
  }
  b.prop('picture_frame', {
    position: [-33, 2.6, 22.4], rotation: [0, Math.PI, 0],
    width: 3.0, height: 0.9, text: ['PRODUCE', 'PICK OF THE DAY'],
    background: '#3a7a2e', textColor: '#f0f8e8',
  });

  // ── the misted floor ──
  // The produce misters have been leaking. Water is worse than tile on grip
  // (0.35 vs 1.05), rolling resistance (0.180 vs 0.010), drag (0.34 vs 0) and
  // bumpiness (0.060 vs 0.008), so it is a hazard and never a tempting line.
  //
  // It sits 3.2 m OFF the racing line on the exit of the produce corner: 1.25 m
  // clear of the road edge, so you only find it by running wide. Centred on the
  // line it would have been a 0.35-grip carpet across a corner, and — worse —
  // the AI path would read it in-game (`_surfaceHint` raycasts the real mesh)
  // but not headlessly (no physics world ⇒ `defaultSurface`), so the built
  // track and the audited track would disagree about that corner's speed.
  b.patch({
    center: [-26.5, 0.006, 11.0], radius: 2.0, segments: 28,
    material: 'water/shallow', surfaceId: SurfaceId.WATER,
    matOpts: { transparent: true, opacity: 0.55 },
  });
  b.gripZone({ id: 'produce_mist', center: [-26.5, 0, 11.0], radius: 2.0, gripScale: 0.42, kind: 'wet' });
  b.prop('cone', { position: [-25.4, 0, 9.4], height: 0.4 });
  b.prop('cone', { position: [-27.6, 0, 12.6], height: 0.4 });
  b.prop('picture_frame', {
    position: [-25.6, 0.5, 9.0], rotation: [0, -0.7, 0],
    width: 0.7, height: 0.6, text: ['WET', 'FLOOR'],
    background: '#e8b81e', textColor: '#2a2208',
  });
}

// ══════════════════════════════════════════════════════════ lighting & mood

function buildLighting(b) {
  b.environment({
    skybox: { preset: 'supermarket', mode: 'indoor', roomHeight: STORE.h, ceilingColor: 0x33383e },
    sun: { color: 0xf4f8ff, intensity: 1.9, elevation: 1.05, azimuth: 0.2, castShadow: true },
    ambient: { sky: 0xeaf2fa, ground: 0x4a5058, intensity: 1.25 },
    fog: { color: 0x2b3138, near: 60, far: 170 },
    ibl: { intensity: 0.95, tint: 0xeef4ff, enabled: true },
    grade: 'supermarket',
    exposure: 1.02,
    bloom: { strength: 0.42, threshold: 0.90, knee: 0.32, radius: 0.5 },
    vignette: 0.22,
    lights: [
      { type: 'point', color: 0xeaf4ff, intensity: 24, position: [-24, 5.6, -20], distance: 30, decay: 2 },
      { type: 'point', color: 0xeaf4ff, intensity: 24, position: [4, 5.6, -20], distance: 30, decay: 2 },
      { type: 'point', color: 0xeaf4ff, intensity: 22, position: [-10, 5.6, -14], distance: 28, decay: 2 },
      { type: 'point', color: 0xeaf4ff, intensity: 22, position: [12, 5.6, -11], distance: 28, decay: 2 },
      { type: 'point', color: 0xdff0ff, intensity: 18, position: [-34, 4.4, -4], distance: 26, decay: 2 },
      { type: 'point', color: 0xfff2dc, intensity: 26, position: [0, 5.4, 16], distance: 36, decay: 2 },
      { type: 'point', color: 0xfff2dc, intensity: 22, position: [24, 5.0, 6], distance: 28, decay: 2 },
      // Work light over the dock — the only warm thing in the building.
      { type: 'spot', color: 0xffd8a0, intensity: 60, position: [0, 5.2, -25], target: [1, 0.6, -23], angle: 0.6, penumbra: 0.5, distance: 20, decay: 2, castShadow: false },
    ],
    bounds: new THREE.Box3(
      new THREE.Vector3(STORE.x0 - 1, -2, STORE.z0 - 1),
      new THREE.Vector3(STORE.x1 + 1, STORE.h + 1, STORE.z1 + 1),
    ),
  });

  b.audio({
    reverb: { roomSize: 0.62, damping: 0.42, wet: 0.26, preDelay: 0.014 },
    ambienceId: 'supermarket',
  });

  // Fluorescent battens on the ceiling, running with the aisles.
  const batten = G.boxMeters(3.4, 0.10, 0.24);
  const battenMat = b.glow(0xeaf4ff, 3.4, { base: 0x1a2028 });
  const housing = G.boxMeters(3.6, 0.12, 0.34);
  const housingMat = b.mat('metal/painted', { color: 0xb8bfc6 });
  for (const z of [-23.5, -17, -11, -4.5, 2, 9, 16, 21]) {
    for (let x = STORE.x0 + 4; x < STORE.x1 - 2; x += 4.4) {
      b.instanceAt('store:batten', batten, battenMat, [x, 6.0, z], null, 1,
        { collide: false, surfaceId: null, cast: false });
      b.instanceAt('store:battenBox', housing, housingMat, [x, 6.09, z], null, 1,
        { collide: false, surfaceId: null, cast: false });
    }
  }
  batten.dispose();
  housing.dispose();
}

// ══════════════════════════════════════════════════════════════ race layout

function buildRaceData(b) {
  b.checkpoints({ count: 20, halfWidthPad: 1.6 });
  // 8 slots, 2 columns: rows sit 3.4 / 5.45 / 7.5 / 9.55 m back from the line,
  // all of it on the checkout straight, and 40 m clear of the dock jump.
  b.startGrid({ count: 8, columns: 2, rowGap: 2.05, firstBack: 3.4, spread: 0.45 });
  b.respawns({ spacing: 12 });

  b.pickupRow(b.tNear([-6, 0, 18.5]), { count: 3, spread: 1.0 });
  b.pickupRow(b.tNear([-36, 0, -3]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([-14, 0, -23.5]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([10, 0, -23.5]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([20, 0, -17]), { count: 3, spread: 0.85 });
  b.pickupRow(b.tNear([-18, 0, -17]), { count: 3, spread: 0.85 });
  b.pickupRow(b.tNear([-4, 0, -11]), { count: 3, spread: 0.85 });
  b.pickupRow(b.tNear([40, 0, 2]), { count: 3, spread: 1.0 });

  b.aiPath({
    spacing: 3.0, topSpeed: 9.0, brake: 12.5, accel: 6.8,
    tyre: 0.58, safety: 0.90, raceLine: true, carHalfWidth: 0.13,
  });
}

// ═══════════════════════════════════════════════════════════════════ helpers

/** A hanging queue rope between two stanchion tops. */
function ropeBetween(b, a, c) {
  const geo = G.ropeBetween(
    new THREE.Vector3(a[0], a[1], a[2]),
    new THREE.Vector3(c[0], c[1], c[2]),
    0.016, 0.09, 10, 6,
  );
  b.add(geo, b.mat('fabric/felt', { params: { color: 0x1e6fbf } }), {
    surfaceId: null, collide: false, cast: true, receive: false, decor: true,
  });
  geo.dispose();
}
