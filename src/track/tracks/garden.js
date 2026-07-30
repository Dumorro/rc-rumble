/**
 * GARDEN — the outdoor counterpart to the Toy Museum.
 *
 * A big suburban garden on a bright, slightly hazy afternoon. Gravel paths cut
 * through a lawn that will absolutely eat your momentum (grip 0.60), past a
 * vegetable patch, over a rockery crest, through a greenhouse, around a pond,
 * and back over a raised timber deck.
 *
 *   • **Verticality** — a 1.0 m rockery crest you go blind over, a 0.15 m
 *     greenhouse threshold, and a 1.10 m deck you launch off at the end of the
 *     lap onto a banked gravel landing.
 *   • **Shortcut** — a 0.95 m plank laid across the corner of the pond. Roughly
 *     8 m shorter than the path round the outside, but you have to hit a
 *     board narrower than three car-widths at speed. Miss it and you are in
 *     15 cm of water (surface 9, grip 0.35) and wading out.
 *   • **Hazards** — a garden hose crossing the path as a bump, a wooden ramp
 *     leaning on a flowerpot, and a sprinkler whose sweep leaves a permanently
 *     soaked arc across the gravel.
 *   • **Wind** — every shrub, hedge, flower and grass tuft sways in a vertex
 *     shader driven from `TrackSystem.update`.
 *
 * Lap ≈ 300 m; a flat-out AI lap is ~43 s, a contested race lap 48–58 s.
 */

import * as THREE from 'three';
import { SurfaceId } from '../Surfaces.js';
import * as G from '../GeoLib.js';
import { buildSprinkler, buildFan } from '../Props.js';

// ────────────────────────────────────────────────────────────── dimensions

const YARD = { x0: -46, x1: 46, z0: -42, z1: 42 };
const FENCE_H = 1.6;
/**
 * Lawn datum. The gravel path runs at y = 0 and the lawn sits 9 cm below it,
 * which is enough headroom for the Catmull-Rom undershoot (~7 cm) on the
 * approach to the 1 m rockery crest — any shallower and the path dips *under*
 * the grass for a few metres and the wheels read the wrong surface.
 */
const LAWN_Y = -0.09;
const POND = { x: 31, z: 30, r: 5.4, depth: 0.09 };
const GREENHOUSE = { x0: 27, x1: 43, z0: -30, z1: -13, y: 0.15, h: 2.6 };
/** Openings in the greenhouse, sized and placed where the racing line crosses. */
const GH_DOORS = {
  west: [-28.8, -24.2],     // in the x = x0 wall, as a z range
  south: [35.6, 40.2],      // in the z = z1 wall, as an x range
};
const DECK = { x0: -44, x1: -34, z0: 24, z1: 36, y: 1.10 };
const HOUSE = { x0: -46, x1: -30, z0: -6, z1: 16, h: 6.5 };
const ROCKERY = { x: -30.5, z: -38.5, r: 5.2, h: 0.95 };

const NODES = [
  [-38, 0, 12, 3.2],       // 0  ← START / FINISH, heading −Z
  [-38, 0, 0, 3.0],        // 1
  [-37, 0, -12, 3.0],      // 2
  [-35, 0, -22, 2.8],      // 3
  [-31, 0, -30, 2.8],      // 4
  [-25, 1.00, -35, 2.6],   // 5  ← blind crest over the rockery
  [-16, 0, -37, 2.8],      // 6
  [-6, 0, -36, 2.8],       // 7  ← vegetable beds, hose bump
  [4, 0, -34, 2.8],        // 8  ← the leaning plank ramp
  [14, 0, -32, 2.8],       // 9
  [23, 0, -29, 2.8],       // 10
  [31, 0.15, -24, 2.6],    // 11 ← into the greenhouse
  [37, 0.15, -16, 2.6],    // 12
  [40, 0, -6, 2.8],        // 13
  [41, 0, 6, 2.8],         // 14 ← sprinkler arc
  [40, 0, 17, 2.8],        // 15
  [40, 0, 28, 2.8],        // 16 ← pond plank branches off here
  [36, 0, 36, 2.8],        // 17
  [26, 0, 38, 2.8],        // 18
  [16, 0, 37, 2.8],        // 19
  [5, 0, 36, 2.8],         // 20
  // ── an excursion out across the middle lawn and back ──
  [-1, 0, 29, 2.8],        // 21
  [-3, 0, 20, 2.6],        // 22
  [-10, 0, 15, 2.6],       // 23
  [-19, 0, 17, 2.6],       // 24
  [-23, 0, 26, 2.6],       // 25
  [-19, 0, 34, 2.8],       // 26
  [-26, 0, 35, 2.6],       // 27
  [-33, 0.55, 33, 2.6],    // 28 ← up the deck ramp
  [-39, 1.10, 30, 2.6],    // 29 ← on the deck
  [-40, 1.10, 25, 2.6],    // 30 ← launch
  [-38, 0.30, 18, 3.0],    // 31 ← landing bank
];

export default {
  id: 'garden',
  name: 'Back Garden',
  difficulty: 'medium',
  laps: 3,
  theme: 'outdoor',
  order: 1,
  seed: 90210,
  previewColors: [0x5f8a3e, 0x8d8578, 0x2f7f8c],
  description:
    'Gravel paths through a summer garden. Blind crest over the rockery, a '
    + 'run through the greenhouse, a soaked sprinkler arc, and a plank across the '
    + 'pond for anyone brave enough. Finishes with a jump off the deck.',

  /** @param {import('../TrackBuilder.js').TrackBuilder} b */
  build(b) {
    b.centerline(NODES, { closed: true, samplesPerSegment: 30 });
    b.defaultSurface(SurfaceId.GRAVEL);

    buildGround(b);
    buildRoad(b);
    buildPond(b);
    buildGreenhouse(b);
    buildDeck(b);
    buildRockery(b);
    buildVegPatch(b);
    buildRampAndHose(b);
    buildSprinklerArc(b);
    buildHouseAndFence(b);
    buildPlanting(b);
    buildLighting(b);
    buildRaceData(b);
  },
};

// ═════════════════════════════════════════════════════════════════ the ground

function buildGround(b) {
  // The lawn: gently undulating so the garden is not a billiard table, but only
  // by ±2 cm — the gravel path runs at y = 0 and a bigger swell would swallow
  // its shoulder and leave a step a 3.3 cm wheel could not climb.
  b.floor({
    center: [(YARD.x0 + YARD.x1) / 2, (YARD.z0 + YARD.z1) / 2],
    size: [YARD.x1 - YARD.x0, YARD.z1 - YARD.z0],
    segments: 32,
    heightFn: (x, z) => (
      LAWN_Y
      + Math.sin(x * 0.075) * 0.008
      + Math.sin(z * 0.062 + 1.3) * 0.007
      + Math.sin((x + z) * 0.041) * 0.005
    ),
    material: 'grass/lawn', surfaceId: SurfaceId.GRASS,
  });

  // A soil border round the whole garden so the fence has something to sit in.
  const border = 1.6;
  for (const [c, s] of [
    [[0, YARD.z0 + border / 2], [YARD.x1 - YARD.x0, border]],
    [[0, YARD.z1 - border / 2], [YARD.x1 - YARD.x0, border]],
    [[YARD.x0 + border / 2, 0], [border, YARD.z1 - YARD.z0]],
    [[YARD.x1 - border / 2, 0], [border, YARD.z1 - YARD.z0]],
  ]) {
    b.floor({
      center: c, size: s, y: LAWN_Y + 0.012,
      material: 'dirt/ground', surfaceId: SurfaceId.DIRT,
    });
  }
}

// ════════════════════════════════════════════════════════════════════ road

/**
 * Key lap fractions, computed once and shared between the road, the deck and
 * the race data. Stored on the builder so nothing is module-global.
 */
function keyTimes(b) {
  if (b._gardenT) return b._gardenT;
  b._gardenT = {
    jumpFrom: b.tNear([-40, 1.10, 25.2]),
    jumpTo: b.tNear([-38.4, 0.32, 19.4]),
    rampStart: b.tNear([-28.4, 0.05, 34.6]),
    deckIn: b.tNear([-35.6, 1.02, 31.4]),
  };
  return b._gardenT;
}

function buildRoad(b) {
  const T = keyTimes(b);
  b.jumpGap(T.jumpFrom, T.jumpTo, {
    lip: true, lipLength: 1.8, lipRise: 0.05,
    material: 'wood/oak_planks', surfaceId: SurfaceId.WOOD,
  });

  const gravel = {
    material: 'gravel/bed', surfaceId: SurfaceId.GRAVEL, step: 0.8,
    shoulder: {
      // A 0.9 m grass verge sloping down to the lawn: it is a real surface-5
      // run-off (grip 0.60 vs the path's 0.55 gravel, but far bumpier and with
      // 5× the rolling resistance) and it hides the step down to the lawn.
      width: 0.9, drop: -0.075,
      material: 'grass/lawn', surfaceId: SurfaceId.GRASS,
    },
  };

  // Ground-level gravel: everything from the landing all the way round to the
  // foot of the deck ramp. (`to < from` is a wrapped range — the loft handles it.)
  b.road({ ...gravel, from: T.jumpTo, to: T.rampStart });

  // The deck ramp: same gravel skin, but on a solid timber understructure.
  b.road({
    ...gravel, from: T.rampStart, to: T.deckIn,
    material: 'wood/plywood_varnish', surfaceId: SurfaceId.WOOD,
    shoulder: null,
  });
  b.roadUnderside({
    from: T.rampStart, to: T.deckIn, depth: 0.22, overhang: 0.06,
    material: 'wood/pine_planks', surfaceId: SurfaceId.WOOD, step: 0.8,
  });
  // Trestles under it so it is not a floating plank.
  const legGeo = G.boxMeters(0.10, 1, 0.10, { radius: 0.008, seg: 1 });
  const legMat = b.mat('wood/pine_planks', { color: 0x7d6141 });
  for (let i = 0; i <= 4; i++) {
    const t = b.spline.wrapT(T.rampStart + ((T.deckIn - T.rampStart + 1) % 1) * (i / 4));
    const s = b.at(t);
    const h = s.position.y - 0.22;
    if (h < 0.12) continue;
    for (const side of [-1, 1]) {
      const p = new THREE.Vector3();
      s.offset(side * (s.width * 0.5 - 0.12), -0.22 - h * 0.5, p);
      b.instanceAt('deck:trestle', legGeo, legMat, [p.x, p.y, p.z], null, [1, h, 1],
        { collide: false, cast: true, receive: false });
    }
  }
  legGeo.dispose();

  // Nothing is lofted across the deck itself — the deck boards *are* the surface.

  // The gravel landing bank: the road ribbon descends from 0.32 to 0 after the
  // jump, so give it a solid gravel body instead of leaving it in mid-air.
  b.roadUnderside({
    from: T.jumpTo, to: b.tNear([-38, 0.02, 13.5]),
    depth: 0.34, overhang: 0.5,
    material: 'gravel/bed', surfaceId: SurfaceId.GRAVEL, step: 0.7,
  });

  // Patio slabs where the path passes the house: harder, faster, squarer.
  b.stripe({
    from: b.tNear([-38, 0, 8]), to: b.tNear([-37, 0, -14]),
    width: 3.6, y: 0.012, bevel: 0.10,
    material: 'tile/ceramic_glazed', surfaceId: SurfaceId.TILE,
    matOpts: { color: 0xcfc6b2, params: { tiles: 3, mortar: 0.05 } },
  });

  // Wooden edging boards along the gravel — the classic garden-path detail, and
  // a 5 cm kerb you can clip.
  const edgeRanges = [[T.jumpTo, T.rampStart]];
  for (const side of [-1, 1]) {
    for (const [a, c] of edgeRanges) {
      const L2 = [
        { w: side, x: side * 0.02, y: 0.0, sid: SurfaceId.WOOD, mat: 'wood/pine_planks' },
        { w: side, x: side * 0.02, y: 0.055, sid: SurfaceId.WOOD, mat: 'wood/pine_planks' },
        { w: side, x: side * 0.09, y: 0.055, sid: null },
      ];
      const bands = b.spline.loft(L2, { from: a, to: c, stepMeters: 0.9, flip: side < 0 });
      for (const band of bands) {
        const p = L2[band.index];
        if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
        b.add(band.geometry, b.mat(p.mat, { color: 0x8a6a44 }), {
          surfaceId: p.sid, cast: false, receive: true,
        });
        band.geometry.dispose();
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════ the pond

function buildPond(b) {
  const P = POND;

  // The basin: a dished disc of silt whose rim meets the lawn exactly, so there
  // is no lip to catch a wheel — you just drive down into it.
  const basin = G.planeXZ(P.r * 2.3, P.r * 2.3, {
    segX: 28, segZ: 28, ou: P.x, ov: P.z,
    heightFn: (x, z) => {
      const d = Math.hypot(x, z) / (P.r * 1.06);
      if (d >= 1) return LAWN_Y;
      return LAWN_Y - P.depth * (1 - d * d);
    },
  });
  basin.translate(P.x, 0, P.z);
  b.add(basin, b.mat('dirt/ground', { color: 0x6b5a44 }), {
    surfaceId: SurfaceId.DIRT, cast: false, receive: true,
  });
  basin.dispose();

  // The water: a translucent, animated disc just under the lawn line. Surface 9
  // so grip collapses and FX know to splash. Drivable — you just wallow.
  const water = G.discXZ(P.r, 40);
  water.translate(P.x, LAWN_Y - 0.005, P.z);
  b.add(water, b.mat('water/shallow', {
    transparent: true, opacity: 0.86, doubleSide: true,
  }), {
    surfaceId: SurfaceId.WATER, cast: false, receive: true, order: 2,
  });
  water.dispose();

  // Stone coping round the rim.
  // Coping stones round the rim — but only where they are not in the way. The
  // pond has to stay enterable and, crucially, *exitable* from every side.
  const stone = G.boxMeters(0.40, 0.10, 0.28, { radius: 0.03, seg: 2 });
  const stoneMat = b.mat('concrete/rough', { color: 0xa9a294 });
  const N = 40;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const deg = (a * 180) / Math.PI;
    // Gaps: where the plank crosses (≈135°) and on the pond's outer, path-side
    // arc (≈300–360°) so a car that falls in can always drive back out.
    if (deg > 118 && deg < 172) continue;
    if (deg > 292 || deg < 12) continue;
    b.instanceAt('pond:coping', stone, stoneMat,
      [P.x + Math.cos(a) * (P.r + 0.18), LAWN_Y + 0.02, P.z + Math.sin(a) * (P.r + 0.18)],
      [0, -a, 0], 1, { collide: 'box', surfaceId: SurfaceId.CONCRETE });
  }
  stone.dispose();

  // Lily pads + a couple of rocks so the pond reads as water, not a blue disc.
  const pad = G.discXZ(0.28, 12);
  const padMat = b.mat('fabric/felt', { params: { color: 0x2f6b3a }, doubleSide: true });
  for (let i = 0; i < 9; i++) {
    const a = b.rnd() * Math.PI * 2;
    const rr = b.rnd() * (P.r - 1.2);
    b.instanceAt('pond:lily', pad, padMat,
      [P.x + Math.cos(a) * rr, LAWN_Y + 0.004, P.z + Math.sin(a) * rr],
      [0, b.rnd() * 3, 0], 0.7 + b.rnd() * 0.7,
      { collide: false, decor: true, cast: false });
  }
  pad.dispose();
  for (let i = 0; i < 4; i++) {
    const a = 2.4 + i * 0.5;
    b.prop('rock', {
      position: [P.x + Math.cos(a) * (P.r + 0.9), LAWN_Y, P.z + Math.sin(a) * (P.r + 0.9)],
      radius: 0.26 + b.rnd() * 0.22, seed: 20 + i, instanced: false,
    });
  }

  // ── the shortcut: a plank across the corner of the pond ──
  const A = [37.6, 0.28, 23.4];
  const Bb = [24.6, 0.28, 35.6];
  const sc = b.shortcut({
    id: 'pond_plank',
    name: 'The Plank',
    entryT: b.tNear([39.4, 0, 24.6]),
    exitT: b.tNear([25.6, 0, 37.4]),
    risk: 0.85,
    width: 0.95,
    savedMetres: 8,
    nodes: [
      { p: [39.6, 0.06, 24.4], w: 1.9 },
      { p: [38.2, 0.26, 23.6], w: 1.1 },
      { p: [A[0], A[1], A[2]], w: 0.95 },
      { p: [31.0, 0.30, 29.5], w: 0.95 },
      { p: [Bb[0], Bb[1], Bb[2]], w: 0.95 },
      { p: [24.0, 0.24, 36.4], w: 1.1 },
      { p: [23.2, 0.04, 37.6], w: 1.9 },
    ],
  });
  // The plank itself: three boards, slightly bowed, on two trestles.
  b.bridge({
    from: [39.4, 0.10, 24.5], to: [A[0], A[1], A[2]],
    width: 1.2, thickness: 0.07,
    material: 'wood/oak_planks', surfaceId: SurfaceId.WOOD,
  });
  b.bridge({
    from: [A[0], A[1], A[2]], to: [Bb[0], Bb[1], Bb[2]],
    width: 0.95, thickness: 0.065,
    material: 'wood/oak_planks', surfaceId: SurfaceId.WOOD,
    kerb: { height: 0.035, material: 'wood/pine_planks' },
    piers: { count: 2, radius: 0.075, depth: 0.55, material: 'wood/pine_planks' },
  });
  b.bridge({
    from: [Bb[0], Bb[1], Bb[2]], to: [23.4, 0.08, 37.4],
    width: 1.2, thickness: 0.07,
    material: 'wood/oak_planks', surfaceId: SurfaceId.WOOD,
  });
  void sc;

  // A sign warning you off it (which of course guarantees you take it).
  b.prop('picture_frame', {
    position: [39.0, 0.9, 22.4], rotation: [0, -0.7, 0],
    width: 0.8, height: 0.42, text: 'DEEP WATER',
    background: '#1d4a56', textColor: '#dff2f6', frameColor: 0x7d6a48,
  });
}

// ══════════════════════════════════════════════════════════════ greenhouse

function buildGreenhouse(b) {
  const H = GREENHOUSE;
  const w = H.x1 - H.x0, d = H.z1 - H.z0;
  const cx = (H.x0 + H.x1) / 2, cz = (H.z0 + H.z1) / 2;

  // Raised tiled floor — a real slab, so it has sides and cannot be seen under.
  const slab = G.boxMeters(w, H.y - LAWN_Y, d);
  b.addAt(slab, b.mat('tile/mosaic'), [cx, (H.y + LAWN_Y) / 2, cz], null, 1,
    { surfaceId: SurfaceId.TILE, cast: false, receive: true });
  slab.dispose();

  // Every wall is built in spans that skip the two openings, and the same
  // openings are used for the brick dwarf wall AND the glazing — a gap in one
  // and not the other would wall the circuit off.
  const alu = b.mat('metal/brushed_alu', { color: 0xd6dbe0 });
  const paneH = H.h - 0.45;
  const walls = [
    { fixed: H.z0, axis: 'x', from: H.x0, to: H.x1, gap: null },
    { fixed: H.z1, axis: 'x', from: H.x0, to: H.x1, gap: GH_DOORS.south },
    { fixed: H.x0, axis: 'z', from: H.z0, to: H.z1, gap: GH_DOORS.west },
    { fixed: H.x1, axis: 'z', from: H.z0, to: H.z1, gap: null },
  ];
  for (const wd of walls) {
    const spans = wd.gap
      ? [[wd.from, wd.gap[0]], [wd.gap[1], wd.to]]
      : [[wd.from, wd.to]];
    for (const [s0, s1] of spans) {
      if (s1 - s0 < 0.12) continue;
      const A = wd.axis === 'x' ? [s0, wd.fixed] : [wd.fixed, s0];
      const C = wd.axis === 'x' ? [s1, wd.fixed] : [wd.fixed, s1];
      b.wall(A, C, {
        thickness: 0.24, height: 0.45, y: LAWN_Y,
        material: 'brick/red', surfaceId: SurfaceId.CONCRETE,
      });
      b.wall(A, C, {
        thickness: 0.04, height: paneH, y: 0.45,
        material: 'glass/frosted',
        matOpts: { transparent: true, opacity: 0.30, doubleSide: true },
        surfaceId: SurfaceId.GLASS, cast: false,
      });
      const n = Math.max(1, Math.round((s1 - s0) / 1.6));
      for (let i = 0; i <= n; i++) {
        const f = s0 + ((s1 - s0) * i) / n;
        const pos = wd.axis === 'x'
          ? [f, 0.45 + paneH / 2, wd.fixed]
          : [wd.fixed, 0.45 + paneH / 2, f];
        const bar = G.boxMeters(0.05, paneH, 0.05);
        b.addAt(bar, alu, pos, null, 1, { surfaceId: null, collide: false, cast: false });
        bar.dispose();
      }
    }
    // Door jambs so an opening reads as a doorway.
    if (wd.gap) {
      for (const g of wd.gap) {
        const pos = wd.axis === 'x' ? [g, H.h * 0.5, wd.fixed] : [wd.fixed, H.h * 0.5, g];
        const jamb = G.boxMeters(0.10, H.h, 0.10);
        b.addAt(jamb, alu, pos, null, 1, { surfaceId: SurfaceId.METAL, cast: true });
        jamb.dispose();
      }
    }
  }

  // Pitched roof: two sloping glass planes + a ridge.
  const rise = 0.9;
  for (const s of [-1, 1]) {
    const slope = Math.hypot(d / 2, rise);
    const pane = G.boxMeters(w, 0.035, slope);
    const pitch = Math.atan2(rise, d / 2);
    b.addAt(pane, b.mat('glass/frosted', { transparent: true, opacity: 0.26, doubleSide: true }),
      [cx, H.h + rise / 2, cz + s * d / 4], [s * pitch, 0, 0], 1,
      { surfaceId: SurfaceId.GLASS, cast: false, receive: false });
    pane.dispose();
  }
  const ridge = G.boxMeters(w + 0.1, 0.07, 0.09);
  b.addAt(ridge, alu, [cx, H.h + rise, cz], null, 1, { surfaceId: null, collide: false, cast: true });
  ridge.dispose();

  // Staging benches down the far side with pots and seed trays — plenty to hit,
  // but clear of the line, which runs corner to corner.
  const benchTop = G.boxMeters(1.6, 0.05, 0.55, { radius: 0.01, seg: 2 });
  const benchLeg = G.boxMeters(0.06, 0.55, 0.06);
  const woodMat = b.mat('wood/pine_planks', { color: 0x9a8158 });
  for (let i = 0; i < 4; i++) {
    const z = H.z0 + 2.2 + i * 3.0;
    b.instanceAt('gh:bench', benchTop, woodMat, [H.x1 - 1.4, H.y + 0.58, z], null, 1,
      { collide: 'box', surfaceId: SurfaceId.WOOD });
    for (const dx of [-0.7, 0.7]) {
      b.instanceAt('gh:benchleg', benchLeg, woodMat, [H.x1 - 1.4 + dx, H.y + 0.275, z], null, 1,
        { collide: false, cast: true });
    }
    for (const dz of [-0.4, 0.1, 0.5]) {
      b.prop('plant_pot', {
        position: [H.x1 - 1.4, H.y + 0.61, z + dz],
        radius: 0.10, height: 0.13, color: 0xb4562f,
        plantColor: 0x4d8a3c, instanced: false,
      });
    }
  }
  benchTop.dispose();
  benchLeg.dispose();
  b.prop('watering_can', { position: [H.x0 + 1.8, H.y, H.z0 + 2.0], rotation: [0, 1.2, 0] });
  b.prop('watering_can', { position: [H.x1 - 3.2, H.y, H.z1 - 2.2], rotation: [0, -0.6, 0], scale: 0.8 });
  b.prop('tin_bucket', { position: [H.x0 + 2.4, H.y, H.z0 + 5.2] });

  // Ventilation fan in the gable — pure set dressing, but it sells the space.
  buildFan(b, {
    position: [cx, H.h + 0.35, H.z0 + 0.2], radius: 0.4, blades: 4,
    speed: 5.0, dropLength: 0.05, cage: true,
  });
}

// ═══════════════════════════════════════════════════════════════ the deck

function buildDeck(b) {
  const D = DECK;
  const w = D.x1 - D.x0, d = D.z1 - D.z0;
  const cx = (D.x0 + D.x1) / 2, cz = (D.z0 + D.z1) / 2;

  // Deck boards.
  const top = G.boxMeters(w, 0.12, d, { radius: 0.01, seg: 2 });
  b.addAt(top, b.mat('wood/oak_planks', { color: 0xa88450, rotation: Math.PI / 2 }),
    [cx, D.y - 0.06, cz], null, 1, { surfaceId: SurfaceId.WOOD, cast: true, receive: true });
  top.dispose();

  // Skirt + posts.
  const skirtParts = [];
  for (const [px, pz, pw, pd] of [
    [cx, D.z0 + 0.06, w, 0.12], [cx, D.z1 - 0.06, w, 0.12],
    [D.x0 + 0.06, cz, 0.12, d], [D.x1 - 0.06, cz, 0.12, d],
  ]) {
    const g = G.boxMeters(pw, D.y - 0.12, pd);
    g.translate(px, (D.y - 0.12) / 2, pz);
    skirtParts.push(g);
  }
  const skirt = G.mergeList(skirtParts);
  if (skirt) {
    b.add(skirt, b.mat('wood/pine_planks', { color: 0x7d6141 }), {
      surfaceId: SurfaceId.WOOD, cast: true, receive: true,
    });
    skirt.dispose();
  }
  for (const g of skirtParts) g.dispose();

  // (The approach ramp is the road ribbon itself — see buildRoad. Its timber
  // understructure and trestles are built there so they follow the spline
  // exactly rather than approximating it with a straight slab.)

  // A balustrade round the deck EXCEPT the launch edge, which is wide open.
  const postGeo = G.boxMeters(0.08, 0.5, 0.08, { radius: 0.012, seg: 2 });
  const railMat = b.mat('wood/pine_planks', { color: 0x8a6d47 });
  const edges = [
    [[D.x0 + 0.1, D.z1 - 0.1], [D.x1 - 0.1, D.z1 - 0.1]],
    [[D.x0 + 0.1, D.z0 + 0.1], [D.x0 + 0.1, D.z1 - 0.1]],
  ];
  for (const [a, c] of edges) {
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const n = Math.max(2, Math.round(len / 1.3));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      b.instanceAt('deck:post', postGeo, railMat,
        [a[0] + (c[0] - a[0]) * f, D.y, a[1] + (c[1] - a[1]) * f], null, 1,
        { collide: 'box', surfaceId: SurfaceId.WOOD });
    }
    const rail = G.beamBetween(
      new THREE.Vector3(a[0], D.y + 0.46, a[1]),
      new THREE.Vector3(c[0], D.y + 0.46, c[1]),
      0.09, 0.05, { radius: 0.015 },
    );
    b.add(rail, railMat, { surfaceId: SurfaceId.WOOD, cast: true, receive: false });
    rail.dispose();
  }
  postGeo.dispose();

  // (The gravel landing bank is built in buildRoad as the road's underside, so
  // it matches the ribbon exactly.)

  // Deck furniture — a table, two chairs, a parasol base. All knockable-adjacent.
  const tableTop = G.cylinderMeters(0.55, 0.55, 0.05, 18);
  const tableLeg = G.cylinderMeters(0.05, 0.07, 0.62, 10);
  b.addAt(tableTop, b.mat('plastic/injection_gloss', { color: 0xe4e0d6 }),
    [D.x0 + 3.4, D.y + 0.65, D.z1 - 3.0], null, 1, { surfaceId: SurfaceId.PLASTIC });
  b.addAt(tableLeg, b.mat('metal/brushed_alu'),
    [D.x0 + 3.4, D.y + 0.31, D.z1 - 3.0], null, 1, { surfaceId: SurfaceId.METAL });
  tableTop.dispose(); tableLeg.dispose();
  b.prop('plant_pot', { position: [D.x0 + 1.2, D.y, D.z1 - 1.4], radius: 0.28, height: 0.34, color: 0x9a5a34 });
  b.prop('plant_pot', { position: [D.x1 - 1.2, D.y, D.z1 - 1.4], radius: 0.28, height: 0.34, color: 0x9a5a34 });
  b.prop('gnome', { position: [D.x0 + 1.0, D.y, D.z0 + 2.0], rotation: [0, 0.6, 0] });

  // A "MIND THE DROP" board on the launch edge.
  b.prop('picture_frame', {
    position: [D.x1 - 2.0, D.y + 0.5, D.z0 + 0.5], rotation: [0, Math.PI, 0],
    width: 1.0, height: 0.42, text: 'MIND THE DROP',
    background: '#8a5a12', textColor: '#231a08', frameColor: 0x9a7a44,
  });
}

// ═══════════════════════════════════════════════════════════════ the rockery

function buildRockery(b) {
  const R = ROCKERY;

  // The crest the path goes over is built as a solid earth berm UNDER the road
  // ribbon, not as a mound the ribbon is draped over: a mound would poke
  // through the tarmac wherever its dome was steeper than the spline, which is
  // exactly what leaves a car scraping dirt on the racing line.
  b.roadUnderside({
    from: b.tNear([-31, 0, -30]), to: b.tNear([-16, 0, -37]),
    depth: 1.5, overhang: 1.1, step: 0.7,
    material: 'dirt/ground', surfaceId: SurfaceId.DIRT,
  });

  // The decorative rockery proper sits beside the crest.
  const mound = G.moundGeo(R.r, R.h, 26, 17, 0.22);
  b.addAt(mound, b.mat('dirt/ground', { color: 0x74603f }), [R.x, 0, R.z], null, 1,
    { surfaceId: SurfaceId.DIRT, cast: true, receive: true });
  mound.dispose();

  // Rocks bedded into it and along the berm flanks.
  for (let i = 0; i < 18; i++) {
    const a = b.rnd() * Math.PI * 2;
    const rr = 1.4 + b.rnd() * (R.r - 1.2);
    const x = R.x + Math.cos(a) * rr;
    const z = R.z + Math.sin(a) * rr;
    const h = Math.max(0, R.h * (1 - (rr / R.r) ** 2)) - 0.12;
    // keep them off the racing line
    if (Math.abs(b.lateralNear([x, h, z])) < 2.2) continue;
    b.prop('rock', {
      position: [x, h, z], radius: 0.24 + b.rnd() * 0.36,
      seed: 100 + i, rotation: [0, b.rnd() * 3, 0], instanced: false,
    });
  }
  // Alpines in the gaps.
  b.scatter('flower', {
    min: [R.x - R.r, R.z - R.r], max: [R.x + R.r, R.z + R.r],
    count: 26, clearRoad: 1.4, y: 0.2,
    propOpts: { height: 0.22, color: 0xe0679a, seed: 2 },
    scaleRange: [0.6, 1.0], instanced: true,
  });

  // A warning post at the blind crest.
  b.prop('picture_frame', {
    position: [-27.5, 0.9, -33.0], rotation: [0, -0.9, 0],
    width: 0.7, height: 0.4, text: 'BLIND CREST',
    background: '#9a7212', textColor: '#241b06', frameColor: 0x8a6a3a,
  });
}

// ══════════════════════════════════════════════════════════════ veg patch

function buildVegPatch(b) {
  const beds = [
    { c: [-10, -28], s: [7, 3.2] },
    { c: [-1, -28.6], s: [7, 3.2] },
    { c: [8, -28.6], s: [6, 3.0] },
  ];
  const sleeper = b.mat('wood/pine_planks', { color: 0x6a5030 });
  for (const bed of beds) {
    b.floor({
      center: bed.c, size: bed.s, y: 0.14,
      material: 'dirt/ground', surfaceId: SurfaceId.DIRT,
    });
    const [w, d] = bed.s;
    for (const [dx, dz, ww, dd] of [
      [0, -d / 2, w, 0.14], [0, d / 2, w, 0.14],
      [-w / 2, 0, 0.14, d], [w / 2, 0, 0.14, d],
    ]) {
      const g = G.boxMeters(ww, 0.2, dd);
      b.addAt(g, sleeper, [bed.c[0] + dx, 0.1, bed.c[1] + dz], null, 1,
        { surfaceId: SurfaceId.WOOD });
      g.dispose();
    }
    // Rows of plants.
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < Math.round(w / 0.9); c++) {
        b.prop('bush', {
          position: [
            bed.c[0] - w / 2 + 0.5 + c * 0.9,
            0.16,
            bed.c[1] - d / 2 + 0.5 + r * ((d - 1) / 3),
          ],
          rotation: [0, ((r * 7 + c * 3) % 12) * 0.52, 0],
          scale: 0.85 + ((r + c) % 4) * 0.12,
          // One seed + one colour: the whole vegetable patch is a single
          // InstancedMesh. Variety comes from the instance matrices.
          radius: 0.20, height: 0.34, cards: 4,
          color: 0x4f8a35, seed: 1, instanced: true,
        });
      }
    }
  }
  // Bean canes.
  const cane = G.cylinderMeters(0.012, 0.014, 1.5, 5);
  const caneMat = b.mat('wood/pine_planks', { color: 0xa08a5a });
  for (let i = 0; i < 12; i++) {
    const x = -13 + i * 0.55;
    b.instanceAt('veg:cane', cane, caneMat, [x, 0.15, -25.2], [0, 0, (i % 2 ? 0.16 : -0.16)], 1,
      { collide: false, cast: true });
  }
  cane.dispose();

  // A wheelbarrow-ish pile of pots and a scatter of knockables on the path edge.
  for (let i = 0; i < 5; i++) {
    b.prop('plant_pot', {
      position: [-3.2 + i * 0.5, 0, -33.2], radius: 0.16, height: 0.2,
      color: 0xb4562f, plant: i % 2 === 0,
    });
  }
  b.prop('tin_bucket', { position: [1.6, 0, -32.6] });
  b.prop('gnome', { position: [-7.0, 0, -33.0], rotation: [0, -0.8, 0] });
}

// ══════════════════════════════════════════════ leaning ramp + garden hose

function buildRampAndHose(b) {
  // A plank leaning on an upturned flowerpot: the classic garden jump.
  b.prop('plant_pot', {
    position: [6.6, 0, -35.4], radius: 0.30, height: 0.40,
    color: 0xa85a30, plant: false, dynamic: false, collide: true,
  });
  b.ramp({
    from: [2.6, 0, -33.6], to: [6.2, 0.42, -35.0],
    width: 2.2, thickness: 0.06,
    material: 'wood/plywood_varnish', surfaceId: SurfaceId.WOOD,
    support: false, lead: 0.6,
  });
  // A landing scuff so you can see where everyone touches down.
  b.patch({
    center: [10.2, 0.006, -33.4], radius: 1.5, segments: 20,
    material: 'dirt/ground', surfaceId: null,
    matOpts: { transparent: true, opacity: 0.55 },
  });
  // The garden hose: a long tube snaking across the path. Solid, ~4 cm — enough
  // to unsettle the car if you cross it at an angle.
  const hosePts = [];
  for (let i = 0; i <= 26; i++) {
    const f = i / 26;
    const x = -18 + f * 22;
    const z = -30.5 + Math.sin(f * 5.4) * 3.4 - f * 4.5;
    hosePts.push(new THREE.Vector3(x, 0.038, z));
  }
  const hose = G.tubeAlong(hosePts, 0.032, 6, false, 0.4, 0.55);
  b.add(hose, b.mat('rubber/floor_mat', { color: 0x2f6b3a }), {
    surfaceId: SurfaceId.RUBBER, cast: true, receive: true,
  });
  hose.dispose();
  // The reel it comes off.
  const reelSide = G.cylinderMeters(0.28, 0.28, 0.04, 18);
  const reelMat = b.mat('plastic/abs_matte', { color: 0x2a5f8a });
  for (const dz of [-0.14, 0.14]) {
    b.addAt(reelSide, reelMat, [-18.6, 0.30, -30.4 + dz], [Math.PI / 2, 0, 0], 1,
      { surfaceId: SurfaceId.PLASTIC });
  }
  reelSide.dispose();
  const reelCore = G.cylinderMeters(0.18, 0.18, 0.26, 14);
  b.addAt(reelCore, b.mat('rubber/floor_mat', { color: 0x2f6b3a }),
    [-18.6, 0.30, -30.4], [Math.PI / 2, 0, 0], 1, { surfaceId: SurfaceId.RUBBER });
  reelCore.dispose();
  const reelLeg = G.boxMeters(0.34, 0.30, 0.34, { radius: 0.02, seg: 2 });
  b.addAt(reelLeg, reelMat, [-18.6, 0.15, -30.4], null, 1, { surfaceId: SurfaceId.PLASTIC });
  reelLeg.dispose();
}

// ══════════════════════════════════════════════════════════════ sprinkler

function buildSprinklerArc(b) {
  // Placed just off the fast east straight so its arc washes right across the
  // racing line. The wet band is baked as surface 9 — grip drops to 0.35 in it,
  // permanently, whichever way the head happens to be pointing.
  buildSprinkler(b, {
    id: 'east_sprinkler',
    position: [37.0, 0.02, 6.5],
    radius: 4.6,
    sweep: Math.PI * 0.85,
    period: 4.6,
    rotation: 0.35,
    gripScale: 0.42,
    wetMaterial: 'water/shallow',
  });
  // A second, smaller one on the inside of the last corner before the deck.
  buildSprinkler(b, {
    id: 'lawn_sprinkler',
    position: [-7.0, 0.02, 24.5],
    radius: 4.4,
    sweep: Math.PI * 0.7,
    period: 3.4,
    rotation: 0.35,
    gripScale: 0.5,
  });
  // The hose feeding them.
  const feed = [];
  for (let i = 0; i <= 20; i++) {
    const f = i / 20;
    feed.push(new THREE.Vector3(
      37.0 - f * 4.0 + Math.sin(f * 6) * 0.4,
      0.032,
      6.5 + f * 12 + Math.cos(f * 5) * 0.5,
    ));
  }
  const g = G.tubeAlong(feed, 0.026, 5, false, 0.4, 0.6);
  b.add(g, b.mat('rubber/floor_mat', { color: 0x2f6b3a }), {
    surfaceId: SurfaceId.RUBBER, cast: false, receive: true,
  });
  g.dispose();
}

// ═════════════════════════════════════════════════════════ house and fence

function buildHouseAndFence(b) {
  const H = HOUSE;
  // A slice of the house wall, so the garden has a believable owner.
  b.wall([H.x1, H.z0], [H.x1, H.z1], {
    thickness: 0.4, height: H.h,
    material: 'brick/red', surfaceId: SurfaceId.CONCRETE,
  });
  b.wall([H.x0, H.z0], [H.x1, H.z0], {
    thickness: 0.4, height: H.h,
    material: 'brick/red', surfaceId: SurfaceId.CONCRETE,
  });
  b.wall([H.x0, H.z1], [H.x1, H.z1], {
    thickness: 0.4, height: H.h,
    material: 'brick/red', surfaceId: SurfaceId.CONCRETE,
  });
  // Windows + a back door.
  for (let i = 0; i < 3; i++) {
    const z = H.z0 + 4 + i * 6;
    const frame = G.frameGeo(1.5, 1.7, 0.12, 0.1);
    b.addAt(frame, b.mat('metal/painted', { params: { color: 0xf0ece2, wear: 0.35 } }),
      [H.x1 + 0.18, 2.4, z], [0, Math.PI / 2, 0], 1, { surfaceId: null, collide: false });
    frame.dispose();
    const pane = G.planeXY(1.3, 1.5);
    b.addAt(pane, b.mat('glass/clear', { transparent: true, opacity: 0.35, doubleSide: true }),
      [H.x1 + 0.16, 2.4, z], [0, Math.PI / 2, 0], 1, { surfaceId: null, collide: false, decor: true });
    pane.dispose();
  }
  const door = G.boxMeters(1.0, 2.1, 0.08, { radius: 0.01, seg: 2 });
  b.addAt(door, b.mat('wood/mdf', { color: 0x2f5a3a }), [H.x1 + 0.20, 1.05, H.z1 - 3.0],
    [0, Math.PI / 2, 0], 1, { surfaceId: SurfaceId.WOOD });
  door.dispose();
  // Roof line.
  const eave = G.boxMeters(H.x1 - H.x0 + 0.6, 0.3, H.z1 - H.z0 + 0.6, { radius: 0.04, seg: 2 });
  b.addAt(eave, b.mat('concrete/rough', { color: 0x6a6258 }),
    [(H.x0 + H.x1) / 2, H.h + 0.15, (H.z0 + H.z1) / 2], null, 1,
    { surfaceId: SurfaceId.CONCRETE });
  eave.dispose();

  // Timber fence right round the garden. A close-boarded panel reads exactly
  // like palings once the plank texture is on it, and costs four slabs instead
  // of two thousand instanced boards — the posts and the capping rail carry the
  // silhouette.
  const trimMat = b.mat('wood/pine_planks', { color: 0x6f5636 });
  const sides = [
    { a: [YARD.x0, YARD.z0], c: [YARD.x1, YARD.z0], axis: 'x' },
    { a: [YARD.x0, YARD.z1], c: [YARD.x1, YARD.z1], axis: 'x' },
    { a: [YARD.x0, YARD.z0], c: [YARD.x0, YARD.z1], axis: 'z' },
    { a: [YARD.x1, YARD.z0], c: [YARD.x1, YARD.z1], axis: 'z' },
  ];
  const postGeo = G.boxMeters(0.11, FENCE_H + 0.16, 0.11, { radius: 0.008, seg: 2 });
  const capGeo = G.boxMeters(0.16, 0.05, 2.4, { radius: 0.008, seg: 2 });
  for (const s of sides) {
    const len = Math.hypot(s.c[0] - s.a[0], s.c[1] - s.a[1]);
    b.wall(s.a, s.c, {
      thickness: 0.06, height: FENCE_H, y: LAWN_Y,
      material: 'wood/pine_planks', matOpts: { color: 0x8a6f47, rotation: Math.PI / 2 },
      surfaceId: SurfaceId.WOOD,
    });
    const yaw = s.axis === 'x' ? 0 : Math.PI / 2;
    const posts = Math.max(2, Math.round(len / 2.4));
    for (let i = 0; i <= posts; i++) {
      const f = i / posts;
      const x = s.a[0] + (s.c[0] - s.a[0]) * f;
      const z = s.a[1] + (s.c[1] - s.a[1]) * f;
      b.instanceAt('fence:post', postGeo, trimMat,
        [x, LAWN_Y + (FENCE_H + 0.16) / 2, z], [0, yaw, 0], 1,
        { collide: false, cast: true, receive: true });
      if (i < posts) {
        b.instanceAt('fence:cap', capGeo, trimMat,
          [s.a[0] + (s.c[0] - s.a[0]) * (f + 0.5 / posts), LAWN_Y + FENCE_H + 0.02,
            s.a[1] + (s.c[1] - s.a[1]) * (f + 0.5 / posts)],
          [0, yaw + Math.PI / 2, 0], [1, 1, len / posts / 2.4],
          { collide: false, cast: true, receive: false });
      }
    }
    b.invisibleWall(s.a, s.c, LAWN_Y, FENCE_H, SurfaceId.WOOD);
  }
  postGeo.dispose();
  capGeo.dispose();
}

// ════════════════════════════════════════════════════════════════ planting

function buildPlanting(b) {
  // Hedges: solid, wind-still (they are boxes, not cards) barriers that shape
  // the corners without walling the garden in.
  const hedges = [
    { a: [-20, -14], c: [-4, -14] },
    { a: [4, -14], c: [18, -14] },
    { a: [10, 6], c: [10, 22] },
    { a: [2, 10], c: [2, -2] },
    { a: [-22, 4], c: [-8, 4] },
  ];
  for (const h of hedges) {
    const len = Math.hypot(h.c[0] - h.a[0], h.c[1] - h.a[1]);
    const n = Math.max(1, Math.round(len / 1.0));
    const yaw = Math.atan2(h.c[0] - h.a[0], h.c[1] - h.a[1]);
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      b.prop('hedge', {
        position: [h.a[0] + (h.c[0] - h.a[0]) * f, 0, h.a[1] + (h.c[1] - h.a[1]) * f],
        rotation: [0, yaw, 0],
        width: 1.05, height: 0.62 + ((i * 29) % 11) / 55, depth: 0.62,
        color: [0x2f5f2c, 0x336831, 0x2b5828][i % 3],
        instanced: false,
      });
    }
  }

  // Shrub borders along the fence — wind-animated crossed cards.
  for (const s of [
    { min: [YARD.x0 + 1.2, YARD.z0 + 1.2], max: [YARD.x1 - 1.2, YARD.z0 + 3.4] },
    { min: [YARD.x0 + 1.2, YARD.z1 - 3.4], max: [YARD.x1 - 1.2, YARD.z1 - 1.2] },
    { min: [YARD.x0 + 1.2, YARD.z0 + 1.2], max: [YARD.x0 + 3.4, YARD.z1 - 1.2] },
    { min: [YARD.x1 - 3.4, YARD.z0 + 1.2], max: [YARD.x1 - 1.2, YARD.z1 - 1.2] },
  ]) {
    b.scatter('bush', {
      min: s.min, max: s.max, count: 42, clearRoad: 1.0, y: 0.02,
      propOpts: { radius: 0.44, height: 0.85, cards: 5, color: 0x2f6b32 },
      scaleRange: [0.7, 1.35], instanced: true,
    });
  }

  // Grass tufts along the path edges. Four blade layouts and one fixed height —
  // size variation comes from the instance matrix, so this is four draw calls
  // for ~900 tufts rather than 900 geometries.
  for (let i = 0; i < 900; i++) {
    const t = b.rnd();
    const side = b.rnd() < 0.5 ? -1 : 1;
    const off = side * (b.spline.widthAt(t) * 0.5 + 0.7 + b.rnd() * 2.4);
    const p = b.point(t, off, 0.005);
    if (p.y > 0.5) continue;                        // skip the deck and the ramp
    b.prop('grass_tuft', {
      position: [p.x, p.y, p.z],
      rotation: [0, b.rnd() * 6.28, 0],
      scale: 0.7 + b.rnd() * 0.9,
      height: 0.09,
      seed: i & 3, instanced: true,
    });
  }

  // Flower clumps, mostly out of the way, a few tempting ones on the apex.
  const clumps = [
    [-30, 20], [-24, 24], [-12, 22], [2, 24], [16, 22],
    [24, 8], [30, -4], [18, -20], [-2, -20], [-20, -22],
    [-34, -14], [12, 12], [-10, 2],
  ];
  const colours = [0xe0679a, 0xe8c033, 0xa26fd0];
  for (let c = 0; c < clumps.length; c++) {
    for (let i = 0; i < 9; i++) {
      b.prop('flower', {
        position: [
          clumps[c][0] + (b.rnd() - 0.5) * 1.8,
          LAWN_Y + 0.005,
          clumps[c][1] + (b.rnd() - 0.5) * 1.8,
        ],
        rotation: [0, b.rnd() * 6.28, 0],
        // Fixed geometry, varied by matrix — see the grass tufts above.
        height: 0.22,
        scale: 0.7 + b.rnd() * 0.7,
        color: colours[(c + i) % colours.length],
        seed: 1,
        instanced: true,
      });
    }
  }

  // Loose knockables on the racing line: a football, croquet balls, a watering
  // can, a scatter of pots at the gravel apexes.
  b.prop('ball', { position: [-32.5, 0.19, -26.0], radius: 0.19, color: 0xf0f0e8 });
  b.prop('ball', { position: [20.5, 0.14, 34.6], radius: 0.14, color: 0xe0483c });
  for (let i = 0; i < 6; i++) {
    b.prop('marble', {
      position: [-4.0 + i * 0.45, 0.06, 33.2 + (i % 2) * 0.4],
      radius: 0.055,
      color: [0xd8503c, 0x2f6fd0, 0xe8c033, 0x3aa05a][i % 4],
    });
  }
  b.prop('watering_can', { position: [-27.6, 0, 22.4], rotation: [0, 2.1, 0] });
  for (let i = 0; i < 4; i++) {
    b.prop('plant_pot', {
      position: [33.0 + Math.cos(i * 1.6) * 1.0, 0, -8.0 + Math.sin(i * 1.6) * 1.0],
      radius: 0.18, height: 0.22, color: 0xb4562f, plant: i % 2 === 0,
    });
  }
  b.prop('gnome', { position: [40.0, 0, 20.5], rotation: [0, -1.2, 0] });
  b.prop('gnome', { position: [-2.0, 0, 30.0], rotation: [0, 2.4, 0] });

  // Cones marking where the council dug up the path.
  b.line('cone', {
    from: b.tNear([40, 0, 17]), to: b.tNear([40, 0, 24]),
    spacing: 1.3, edge: 0.84, instanced: false,
    propOpts: { height: 0.30, baseWidth: 0.17 },
  });
  b.patch({
    center: [41.6, 0.006, 20.5], radius: 1.2, segments: 18,
    material: 'dirt/ground', surfaceId: SurfaceId.DIRT,
  });
}

// ═════════════════════════════════════════════════════════ lighting & mood

function buildLighting(b) {
  b.environment({
    skybox: {
      preset: 'day', mode: 'outdoor',
      turbidity: 3.4, rayleigh: 2.6,
      sunElevation: 0.72, sunAzimuth: 2.15,
      groundColor: 0x5f7a48, horizonHaze: 0.26,
    },
    sun: {
      color: 0xfff3dc, intensity: 3.4,
      elevation: 0.72, azimuth: 2.15, castShadow: true,
      animate: { speed: 0.012, elevationAmplitude: 0.045 },
    },
    ambient: { sky: 0xbcd6f0, ground: 0x5d7040, intensity: 1.15 },
    fog: { color: 0xc9dcea, near: 55, far: 200 },
    ibl: { intensity: 1.05, tint: 0xffffff, enabled: true },
    grade: 'garden',
    exposure: 1.04,
    bloom: { strength: 0.42, threshold: 0.95, knee: 0.4, radius: 0.5 },
    vignette: 0.24,
    lights: [
      // A cool bounce inside the greenhouse so it does not go black.
      {
        type: 'point', color: 0xd8f0e4, intensity: 12,
        position: [(GREENHOUSE.x0 + GREENHOUSE.x1) / 2, 1.8, (GREENHOUSE.z0 + GREENHOUSE.z1) / 2],
        distance: 22, decay: 2,
      },
    ],
    bounds: new THREE.Box3(
      new THREE.Vector3(YARD.x0 - 2, -2, YARD.z0 - 2),
      new THREE.Vector3(YARD.x1 + 2, 12, YARD.z1 + 2),
    ),
  });

  b.audio({
    reverb: { roomSize: 0.28, damping: 0.62, wet: 0.12 },
    ambienceId: 'garden_day',
  });
}

// ═════════════════════════════════════════════════════════════ race layout

function buildRaceData(b) {
  b.finishLine(0, { depth: 0.55 });
  b.banner(0, {
    text: 'BACK GARDEN', key: 'garden:finish',
    height: 2.0, clearance: 1.2, width: 5.0,
    background: '#2c5d2f', textColor: '#f2f0dc', border: '#c8a94e',
  });

  b.checkpoints({ count: 19, halfWidthPad: 1.6 });
  b.startGrid({ count: 8, columns: 2, rowGap: 2.05, firstBack: 3.4, spread: 0.42 });
  b.respawns({ spacing: 12 });

  b.pickupRow(b.tNear([-37, 0, -8]), { count: 3, spread: 1.0 });
  b.pickupRow(b.tNear([-19, 0, -36.5]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([9, 0, -33]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([34, 0.15, -20]), { count: 3, spread: 0.8 });
  b.pickupRow(b.tNear([40.5, 0, 12]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([10, 0, 37]), { count: 3, spread: 1.0 });
  b.pickupRow(b.tNear([-12, 0, 15.6]), { count: 3, spread: 0.9 });
  b.pickupRow(b.tNear([-24, 0, 30]), { count: 3, spread: 0.9 });

  b.aiPath({
    spacing: 3.0, topSpeed: 9.0, brake: 11.5, accel: 6.4,
    tyre: 0.52, safety: 0.88, raceLine: true, carHalfWidth: 0.13,
  });
}
