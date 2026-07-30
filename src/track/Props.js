/**
 * RC RUMBLE — the prop library.
 *
 * Three flavours of prop live here:
 *
 * 1. **Static decoration** — merged or instanced geometry, collision baked into
 *    the track mesh. Zero runtime cost.
 * 2. **Knockable dynamic props** — a `RigidBody` plus a visual. Traffic cones,
 *    dominoes, stacked blocks, marbles, tin cans, pencils, a ball, chess pieces,
 *    plant pots. Every one of these is deliberately *light* (a few grams to a
 *    couple of hundred) so a 1.6 kg car scatters them like a bowling ball, which
 *    is the single most Re-Volt thing a track can do.
 * 3. **Animated set dressing** — a rotating fan, a swinging pendulum, a model
 *    train that crosses the track, sprinklers. Driven from `PropRuntime.update`,
 *    the train optionally kinematic so it can shove a car out of the way.
 *
 * Dynamic props are only simulated near a car: `PropRuntime` disables bodies
 * further than `activeRadius` from the field (throttled, allocation-free) and
 * re-enables them well before a car arrives. Physics' own sleeping then keeps
 * a settled pile free.
 *
 * All geometry is procedural, all UVs are in metres (see `GeoLib.js`).
 */

import * as THREE from 'three';
import { RigidBody, Layer, makeBox, makeSphere, makeCapsule, makeCylinder, makeHull } from '../physics/index.js';
import { SurfaceId } from './Surfaces.js';
import * as G from './GeoLib.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const UP = new THREE.Vector3(0, 1, 0);

let _propId = 0;

// ═══════════════════════════════════════════════════════════════════ helpers

function xyz(v, d = [0, 0, 0]) {
  if (Array.isArray(v)) return [v[0] ?? d[0], v[1] ?? d[1], v[2] ?? d[2]];
  if (v && typeof v === 'object') return [v.x ?? d[0], v.y ?? d[1], v.z ?? d[2]];
  return d;
}

/**
 * Uniformly scale a collider. Dynamic props are authored at 1:1, so a
 * `scale` option has to rescale the shape as well as the mesh or the physics
 * and the visual drift apart.
 * @param {object} c @param {number} s
 */
function scaleCollider(c, s) {
  if (!c || Math.abs(s - 1) < 1e-6) return c;
  try {
    if (c.type === 'sphere') {
      return makeSphere(c.radius * s, new THREE.Vector3(c.centroid[0] * s, c.centroid[1] * s, c.centroid[2] * s));
    }
    if (c.type === 'capsule') {
      const ax = c.axis[0] > 0.5 ? 'x' : c.axis[2] > 0.5 ? 'z' : 'y';
      const mid = new THREE.Vector3(
        (c.p0[0] + c.p1[0]) * 0.5 * s,
        (c.p0[1] + c.p1[1]) * 0.5 * s,
        (c.p0[2] + c.p1[2]) * 0.5 * s,
      );
      return makeCapsule(c.radius * s, c.halfHeight * s, ax, mid);
    }
    if (c.vertices) {
      const v = new Float32Array(c.vertices.length);
      for (let i = 0; i < v.length; i++) v[i] = c.vertices[i] * s;
      return makeHull(v);
    }
  } catch (err) {
    console.warn('[Props] collider scale failed:', err);
  }
  return c;
}

/** Memoise a geometry on the builder so 200 cones share one buffer. */
function geoCache(b, key, factory) {
  b._propGeo ??= new Map();
  let g = b._propGeo.get(key);
  if (!g) { g = factory(); b._propGeo.set(key, g); b._ownedGeo.push(g); }
  return g;
}

// ═══════════════════════════════════════════════════════════ geometry makers

/** A classic traffic cone: square base, tapered body, reflective band. */
function coneGeo(height = 0.34, baseW = 0.19) {
  const parts = [];
  const base = G.boxMeters(baseW, height * 0.055, baseW, { radius: 0.006, seg: 2 });
  base.translate(0, height * 0.028, 0);
  parts.push(base);
  const body = G.cylinderMeters(height * 0.055, baseW * 0.36, height * 0.94, 14);
  body.translate(0, height * 0.055 + height * 0.47, 0);
  parts.push(body);
  const tip = G.sphereMeters(height * 0.055, 10);
  tip.translate(0, height * 0.995, 0);
  parts.push(tip);
  return G.mergeList(parts) ?? base;
}

/** The white reflective sleeve, drawn as a separate ring so it can be emissive. */
function coneBandGeo(height = 0.34, baseW = 0.19) {
  const y0 = height * 0.46;
  const r = baseW * 0.36 + (height * 0.055 - baseW * 0.36) * (y0 / (height * 0.94));
  const band = G.cylinderMeters(r * 0.93, r * 1.03, height * 0.17, 14, { open: true });
  band.translate(0, y0 + height * 0.1, 0);
  return band;
}

/** A domino: a rounded slab with pips. */
function dominoGeo(w = 0.10, h = 0.20, d = 0.028) {
  return G.boxMeters(w, h, d, { radius: 0.004, seg: 2 });
}

/** A toy building block with a stud pattern implied by the material. */
function blockGeo(w = 0.16, h = 0.10, d = 0.32, studs = true) {
  const parts = [G.boxMeters(w, h, d, { radius: 0.006, seg: 2 })];
  if (studs) {
    const cols = Math.max(1, Math.round(w / 0.08));
    const rows = Math.max(1, Math.round(d / 0.08));
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const st = G.cylinderMeters(0.024, 0.024, 0.017, 10);
        st.translate(
          (i - (cols - 1) / 2) * 0.08,
          h * 0.5 + 0.008,
          (j - (rows - 1) / 2) * 0.08,
        );
        parts.push(st);
      }
    }
  }
  return G.mergeList(parts) ?? parts[0];
}

/** A tin can: cylinder with rolled rims. */
function canGeo(r = 0.055, h = 0.13) {
  const parts = [G.cylinderMeters(r, r, h, 16)];
  const rimT = G.torusMeters(r, 0.005, 16, 6);
  rimT.rotateX(Math.PI / 2);
  rimT.translate(0, h * 0.5 - 0.004, 0);
  parts.push(rimT);
  const rimB = rimT.clone();
  rimB.translate(0, -(h - 0.008), 0);
  parts.push(rimB);
  return G.mergeList(parts) ?? parts[0];
}

/** A hexagonal pencil with a sharpened tip and an eraser. */
function pencilGeo(len = 0.19, r = 0.0075) {
  const parts = [];
  const body = G.cylinderMeters(r, r, len * 0.78, 6);
  body.rotateZ(Math.PI / 2);
  body.translate(-len * 0.06, 0, 0);
  parts.push(body);
  const wood = G.cylinderMeters(r * 0.22, r, len * 0.11, 8);
  wood.rotateZ(-Math.PI / 2);
  wood.translate(len * 0.39, 0, 0);
  parts.push(wood);
  const lead = G.cylinderMeters(r * 0.06, r * 0.24, len * 0.035, 6);
  lead.rotateZ(-Math.PI / 2);
  lead.translate(len * 0.462, 0, 0);
  parts.push(lead);
  const ferrule = G.cylinderMeters(r * 1.05, r * 1.05, len * 0.06, 8);
  ferrule.rotateZ(Math.PI / 2);
  ferrule.translate(-len * 0.42, 0, 0);
  parts.push(ferrule);
  const eraser = G.cylinderMeters(r * 0.95, r * 0.95, len * 0.05, 8);
  eraser.rotateZ(Math.PI / 2);
  eraser.translate(-len * 0.475, 0, 0);
  parts.push(eraser);
  return G.mergeList(parts) ?? parts[0];
}

/** A plant pot: tapered lathe with a rim, plus soil. */
function plantPotGeo(rTop = 0.24, rBottom = 0.17, h = 0.28) {
  return G.latheMeters([
    [rBottom * 0.72, 0],
    [rBottom, 0.012],
    [rTop * 0.96, h - 0.035],
    [rTop, h - 0.03],
    [rTop * 1.06, h - 0.008],
    [rTop * 1.06, h],
    [rTop * 0.9, h],
    [rTop * 0.88, h - 0.03],
    [rBottom * 0.86, 0.02],
    [0, 0.02],
  ], 22);
}

/** Chess piece profiles — lathe radius/height pairs, in metres. */
const CHESS_PROFILES = {
  pawn: [[0, 0], [0.052, 0], [0.055, 0.012], [0.040, 0.024], [0.026, 0.048],
    [0.030, 0.062], [0.020, 0.070], [0.034, 0.082], [0.038, 0.100], [0.030, 0.115],
    [0.0, 0.126]],
  rook: [[0, 0], [0.058, 0], [0.062, 0.014], [0.044, 0.030], [0.034, 0.070],
    [0.038, 0.110], [0.050, 0.128], [0.052, 0.150], [0.040, 0.150], [0.040, 0.135], [0, 0.135]],
  bishop: [[0, 0], [0.056, 0], [0.060, 0.014], [0.042, 0.032], [0.028, 0.080],
    [0.036, 0.100], [0.030, 0.112], [0.034, 0.140], [0.020, 0.170], [0.010, 0.186], [0, 0.190]],
  knight: [[0, 0], [0.058, 0], [0.062, 0.014], [0.044, 0.032], [0.032, 0.070],
    [0.040, 0.090], [0.034, 0.104], [0.040, 0.140], [0.022, 0.160], [0, 0.166]],
  queen: [[0, 0], [0.064, 0], [0.068, 0.016], [0.048, 0.038], [0.030, 0.100],
    [0.038, 0.126], [0.032, 0.140], [0.046, 0.176], [0.040, 0.196], [0.018, 0.210], [0, 0.216]],
  king: [[0, 0], [0.066, 0], [0.070, 0.016], [0.050, 0.040], [0.032, 0.110],
    [0.040, 0.138], [0.034, 0.152], [0.046, 0.192], [0.038, 0.212], [0.022, 0.224],
    [0.024, 0.244], [0, 0.248]],
};

function chessGeo(kind = 'pawn') {
  const prof = CHESS_PROFILES[kind] ?? CHESS_PROFILES.pawn;
  const parts = [G.latheMeters(prof, 20)];
  if (kind === 'king') {
    const cx = G.boxMeters(0.010, 0.038, 0.010);
    cx.translate(0, 0.262, 0);
    parts.push(cx);
    const cy = G.boxMeters(0.026, 0.010, 0.010);
    cy.translate(0, 0.268, 0);
    parts.push(cy);
  } else if (kind === 'knight') {
    const head = G.boxMeters(0.026, 0.052, 0.062, { radius: 0.012, seg: 3 });
    head.rotateX(-0.28);
    head.translate(0, 0.190, 0.012);
    parts.push(head);
    const ear = G.boxMeters(0.008, 0.020, 0.010);
    ear.translate(0, 0.216, -0.010);
    parts.push(ear);
  } else if (kind === 'rook') {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const cren = G.boxMeters(0.016, 0.020, 0.016);
      cren.translate(Math.cos(a) * 0.038, 0.160, Math.sin(a) * 0.038);
      parts.push(cren);
    }
  }
  return G.mergeList(parts) ?? parts[0];
}

/** A dice cube. */
function diceGeo(size = 0.11) {
  return G.boxMeters(size, size, size, { radius: size * 0.14, seg: 4 });
}

/** A wooden alphabet block. */
function alphaBlockGeo(size = 0.15) {
  return G.boxMeters(size, size, size, { radius: size * 0.07, seg: 3 });
}

/** A stack of books — a static ramp-ish prop. */
function bookStackGeo(count = 4, seed = 1) {
  const parts = [];
  let y = 0;
  for (let i = 0; i < count; i++) {
    const w = 0.30 - i * 0.018 + (G.hash3(i, seed, 0, seed) - 0.5) * 0.03;
    const d = 0.22 - i * 0.012;
    const h = 0.032 + G.hash3(i, 1, seed, seed) * 0.026;
    const g = G.boxMeters(w, h, d, { radius: 0.004, seg: 2 });
    g.rotateY((G.hash3(i, 2, seed, seed) - 0.5) * 0.35);
    g.translate(0, y + h * 0.5, 0);
    parts.push(g);
    y += h;
  }
  return G.mergeList(parts) ?? parts[0];
}

/** A cardboard box (open or closed). */
function cardboardBoxGeo(w = 0.45, h = 0.35, d = 0.35, open = false) {
  if (!open) return G.boxMeters(w, h, d, { radius: 0.006, seg: 2 });
  const parts = [];
  const t = 0.008;
  parts.push((() => { const g = G.boxMeters(w, t, d); g.translate(0, t * 0.5, 0); return g; })());
  for (const [dx, dz, ww, dd] of [[-(w - t) / 2, 0, t, d], [(w - t) / 2, 0, t, d], [0, -(d - t) / 2, w, t], [0, (d - t) / 2, w, t]]) {
    const g = G.boxMeters(ww, h, dd);
    g.translate(dx, h * 0.5, dz);
    parts.push(g);
  }
  return G.mergeList(parts) ?? parts[0];
}

/** A glass display case: a plinth, four glass panes and a lid frame. */
function displayCaseParts(w = 1.2, d = 0.8, plinthH = 0.55, glassH = 0.7) {
  const plinth = G.boxMeters(w, plinthH, d, { radius: 0.012, seg: 2 });
  plinth.translate(0, plinthH * 0.5, 0);
  const cap = G.boxMeters(w + 0.05, 0.03, d + 0.05, { radius: 0.006, seg: 2 });
  cap.translate(0, plinthH + 0.015, 0);

  const glassParts = [];
  const gy = plinthH + 0.03 + glassH * 0.5;
  for (const [sx, sz, pw, pd] of [
    [0, -(d / 2), w, 0.008], [0, d / 2, w, 0.008],
    [-(w / 2), 0, 0.008, d], [w / 2, 0, 0.008, d],
  ]) {
    const g = G.boxMeters(pw, glassH, pd);
    g.translate(sx, gy, sz);
    glassParts.push(g);
  }
  const top = G.boxMeters(w, 0.008, d);
  top.translate(0, plinthH + 0.03 + glassH, 0);
  glassParts.push(top);

  const frameParts = [];
  for (const [sx, sz] of [[-(w / 2), -(d / 2)], [w / 2, -(d / 2)], [-(w / 2), d / 2], [w / 2, d / 2]]) {
    const g = G.boxMeters(0.02, glassH, 0.02);
    g.translate(sx, gy, sz);
    frameParts.push(g);
  }
  const rail = G.frameGeo(w, d, 0.022, 0.022);
  rail.rotateX(-Math.PI / 2);
  rail.translate(0, plinthH + 0.03 + glassH + 0.012, 0);
  frameParts.push(rail);

  return {
    plinth: G.mergeList([plinth, cap]),
    glass: G.mergeList(glassParts),
    frame: G.mergeList(frameParts),
  };
}

/** Velvet rope stanchion: base, post, ball finial. */
function stanchionGeo(h = 0.55) {
  const parts = [];
  const base = G.latheMeters([[0, 0], [0.085, 0], [0.088, 0.012], [0.05, 0.024], [0.018, 0.03], [0, 0.03]], 16);
  parts.push(base);
  const post = G.cylinderMeters(0.014, 0.016, h - 0.09, 10);
  post.translate(0, 0.03 + (h - 0.09) * 0.5, 0);
  parts.push(post);
  const ring = G.torusMeters(0.026, 0.006, 12, 6);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, h - 0.075, 0);
  parts.push(ring);
  const ball = G.sphereMeters(0.028, 12);
  ball.translate(0, h - 0.03, 0);
  parts.push(ball);
  return G.mergeList(parts) ?? base;
}

/** A simple pillar / column with a base and capital. */
function columnGeo(h = 4, r = 0.35) {
  const parts = [];
  parts.push(G.boxMeters(r * 2.5, 0.14, r * 2.5, { radius: 0.02, seg: 2 }));
  const base = G.mergeList(parts);
  base.translate(0, 0.07, 0);
  const shaft = G.cylinderMeters(r * 0.86, r, h - 0.32, 16);
  shaft.translate(0, 0.14 + (h - 0.32) * 0.5, 0);
  const cap = G.boxMeters(r * 2.6, 0.18, r * 2.6, { radius: 0.02, seg: 2 });
  cap.translate(0, h - 0.09, 0);
  return G.mergeList([base, shaft, cap]) ?? shaft;
}

/** A dinosaur skeleton: skull, vertebrae, ribs, legs, tail — all boxy bones. */
function dinoSkeletonParts(scale = 1) {
  const bones = [];
  const s = scale;
  // Spine: an arc from tail tip to skull, running along +Z.
  const spine = [];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const f = i / N;
    const z = (-0.5 + f) * 24 * s;
    // tail low, hips high, neck rising to the skull
    let y;
    if (f < 0.35) y = 1.1 + Math.pow(f / 0.35, 1.6) * 2.4;
    else if (f < 0.58) y = 3.5 + Math.sin((f - 0.35) / 0.23 * Math.PI) * 0.5;
    else y = 3.6 + Math.pow((f - 0.58) / 0.42, 1.4) * 3.2;
    spine.push(new THREE.Vector3(0, y * s, z));
  }
  for (let i = 0; i < spine.length - 1; i++) {
    const f = i / (spine.length - 1);
    const r = (0.10 + 0.16 * Math.sin(Math.min(1, f * 1.8) * Math.PI * 0.6)) * s;
    const seg = G.beamBetween(spine[i], spine[i + 1], r * 2, r * 2, { radius: r * 0.5 });
    bones.push(seg);
    if (i % 3 === 0 && f > 0.10 && f < 0.62) {
      // vertebral spike
      const sp = G.boxMeters(0.05 * s, (0.35 + 0.4 * Math.sin(f * Math.PI)) * s, 0.05 * s);
      sp.translate(spine[i].x, spine[i].y + (0.2 + 0.2 * Math.sin(f * Math.PI)) * s, spine[i].z);
      bones.push(sp);
    }
  }
  // Ribcage: paired arcs hanging off the middle of the spine. The drop is
  // clamped so the ribs always finish ~1.2 m (scaled) above the floor — a car
  // has to be able to drive under the belly, and a rib must never spear the
  // ground.
  for (let i = 12; i < 26; i += 2) {
    const p = spine[i];
    const drop = Math.max(0.5 * s, p.y - 1.2 * s);
    for (const side of [-1, 1]) {
      const pts = [
        new THREE.Vector3(p.x, p.y, p.z),
        new THREE.Vector3(p.x + side * 1.5 * s, p.y - 0.18 * drop, p.z),
        new THREE.Vector3(p.x + side * 1.9 * s, p.y - 0.63 * drop, p.z),
        new THREE.Vector3(p.x + side * 1.1 * s, p.y - drop, p.z),
      ];
      bones.push(G.tubeAlong(pts, 0.055 * s, 6));
    }
  }
  // Skull: a wedge-ish box with a jaw.
  const head = spine[spine.length - 1];
  const skull = G.boxMeters(0.7 * s, 0.7 * s, 1.7 * s, { radius: 0.12 * s, seg: 3 });
  skull.translate(head.x, head.y + 0.15 * s, head.z + 0.6 * s);
  bones.push(skull);
  const jaw = G.boxMeters(0.55 * s, 0.16 * s, 1.5 * s, { radius: 0.05 * s, seg: 2 });
  jaw.rotateX(0.12);
  jaw.translate(head.x, head.y - 0.28 * s, head.z + 0.55 * s);
  bones.push(jaw);
  // Legs: two pairs, straight down to the floor.
  const legAt = (idx, side, thick) => {
    const p = spine[idx];
    const hip = new THREE.Vector3(p.x + side * 0.9 * s, p.y - 0.5 * s, p.z);
    const knee = new THREE.Vector3(p.x + side * 1.5 * s, 1.5 * s, p.z + 0.4 * s);
    const foot = new THREE.Vector3(p.x + side * 1.6 * s, 0.06 * s, p.z - 0.2 * s);
    bones.push(G.beamBetween(hip, knee, thick, thick, { round: true, seg: 7 }));
    bones.push(G.beamBetween(knee, foot, thick * 0.8, thick * 0.8, { round: true, seg: 7 }));
    const pad = G.boxMeters(0.5 * s, 0.12 * s, 0.7 * s, { radius: 0.04 * s, seg: 2 });
    pad.translate(foot.x, 0.06 * s, foot.z);
    bones.push(pad);
  };
  legAt(20, -1, 0.30 * s); legAt(20, 1, 0.30 * s);
  legAt(26, -1, 0.24 * s); legAt(26, 1, 0.24 * s);

  return G.mergeList(bones);
}

/** A rocket exhibit: body, nose cone, fins, engine bell, window. */
function rocketParts(height = 14, radius = 1.3) {
  const body = G.cylinderMeters(radius * 0.92, radius, height * 0.62, 22);
  body.translate(0, height * 0.31 + height * 0.06, 0);
  const skirt = G.cylinderMeters(radius, radius * 0.78, height * 0.06, 22);
  skirt.translate(0, height * 0.03, 0);
  const nose = G.cylinderMeters(0.02, radius * 0.92, height * 0.3, 22);
  nose.translate(0, height * 0.68 + height * 0.15, 0);
  const tip = G.sphereMeters(0.05, 8);
  tip.translate(0, height * 0.985, 0);
  const bell = G.cylinderMeters(radius * 0.35, radius * 0.62, height * 0.07, 18, { open: true });
  bell.translate(0, height * 0.005, 0);

  const fins = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const fin = G.extrudeOutline([
      [0, 0], [radius * 1.5, 0], [radius * 0.55, height * 0.16], [0, height * 0.18],
    ], 0.1);
    fin.rotateY(Math.PI / 2);
    fin.rotateY(a);
    fin.translate(Math.cos(a) * radius * 0.8, height * 0.055, Math.sin(a) * radius * 0.8);
    fins.push(fin);
  }
  const ring = G.torusMeters(radius * 1.005, 0.05, 24, 7);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, height * 0.52, 0);

  return {
    hull: G.mergeList([body, skirt, nose, tip, ring, ...fins]),
    bell: G.mergeList([bell]),
    stripe: (() => {
      const s1 = G.cylinderMeters(radius * 0.955, radius * 0.96, height * 0.07, 22, { open: true });
      s1.translate(0, height * 0.24, 0);
      const s2 = G.cylinderMeters(radius * 0.94, radius * 0.95, height * 0.05, 22, { open: true });
      s2.translate(0, height * 0.44, 0);
      return G.mergeList([s1, s2]);
    })(),
  };
}

/** A watering can. */
function wateringCanGeo(scale = 1) {
  const parts = [];
  const body = G.latheMeters([
    [0, 0], [0.14, 0], [0.15, 0.02], [0.15, 0.24], [0.13, 0.27], [0.13, 0.28], [0.12, 0.28], [0.12, 0.24], [0.13, 0.02], [0, 0.02],
  ], 18);
  parts.push(body);
  const spoutPts = [
    new THREE.Vector3(0.10, 0.06, 0), new THREE.Vector3(0.26, 0.10, 0),
    new THREE.Vector3(0.38, 0.24, 0), new THREE.Vector3(0.44, 0.30, 0),
  ];
  parts.push(G.tubeAlong(spoutPts, 0.028, 8));
  const rose = G.cylinderMeters(0.06, 0.035, 0.03, 12);
  rose.rotateZ(-0.6);
  rose.translate(0.46, 0.32, 0);
  parts.push(rose);
  const handle = G.tubeAlong([
    new THREE.Vector3(-0.10, 0.22, 0), new THREE.Vector3(-0.20, 0.34, 0),
    new THREE.Vector3(-0.05, 0.36, 0), new THREE.Vector3(0.04, 0.28, 0),
  ], 0.016, 7);
  parts.push(handle);
  const merged = G.mergeList(parts) ?? body;
  if (scale !== 1) merged.scale(scale, scale, scale);
  return merged;
}

/** A garden gnome, because of course. */
function gnomeGeo() {
  const parts = [];
  const bodyG = G.latheMeters([[0, 0], [0.10, 0], [0.11, 0.03], [0.10, 0.16], [0.07, 0.22], [0.05, 0.24], [0, 0.24]], 14);
  parts.push(bodyG);
  const head = G.sphereMeters(0.055, 12);
  head.translate(0, 0.275, 0);
  parts.push(head);
  const hat = G.cylinderMeters(0.004, 0.062, 0.14, 12);
  hat.translate(0, 0.375, 0);
  parts.push(hat);
  const beard = G.cylinderMeters(0.02, 0.05, 0.09, 10);
  beard.rotateX(0.25);
  beard.translate(0, 0.24, 0.035);
  parts.push(beard);
  return G.mergeList(parts) ?? bodyG;
}

/** A flowerpot with a plant (two materials: pot + foliage). */
function flowerPotParts(rTop = 0.20, h = 0.24) {
  return {
    pot: plantPotGeo(rTop, rTop * 0.72, h),
    soil: (() => { const g = G.discXZ(rTop * 0.88, 16); g.translate(0, h - 0.035, 0); return g; })(),
    plant: (() => { const g = G.foliageCluster(rTop * 1.4, h * 2.1, 5, 11); g.translate(0, h - 0.04, 0); return g; })(),
  };
}

// ═════════════════════════════════════════════════════════ the prop catalogue

/**
 * Each entry:
 * ```
 * {
 *   dynamic: bool,               // default for this prop
 *   mass, friction, restitution, // physics defaults
 *   build(b, o) -> {             // returns what to draw
 *     geo | parts: [{ geo, mat, surfaceId, glow }],
 *     collider, radius, centerY
 *   }
 * }
 * ```
 * `spawnProp` handles placement, instancing, collision and body creation.
 */
export const PROPS = {

  // ───────────────────────────────────────────────── knockable dynamic props

  cone: {
    dynamic: true, mass: 0.09, friction: 0.9, restitution: 0.16,
    build(b, o) {
      const h = o.height ?? 0.34, bw = o.baseWidth ?? 0.19;
      return {
        parts: [
          { geo: geoCache(b, `cone:${h}:${bw}`, () => coneGeo(h, bw)), mat: b.mat('plastic/injection_gloss', { color: o.color ?? 0xf4581c, sizeMeters: 1 }), surfaceId: SurfaceId.PLASTIC },
          { geo: geoCache(b, `coneband:${h}:${bw}`, () => coneBandGeo(h, bw)), mat: b.mat('plastic/abs_matte', { color: 0xf2f0e8 }), surfaceId: SurfaceId.PLASTIC, noCollide: true },
        ],
        collider: makeHull([
          [-bw / 2, 0, -bw / 2], [bw / 2, 0, -bw / 2], [bw / 2, 0, bw / 2], [-bw / 2, 0, bw / 2],
          [-0.03, h, -0.03], [0.03, h, -0.03], [0.03, h, 0.03], [-0.03, h, 0.03],
        ]),
        comY: h * 0.30,
        radius: Math.max(bw, h) * 0.6,
      };
    },
  },

  domino: {
    dynamic: true, mass: 0.055, friction: 0.55, restitution: 0.08,
    build(b, o) {
      const w = o.width ?? 0.10, h = o.height ?? 0.20, d = o.depth ?? 0.028;
      return {
        parts: [{
          geo: geoCache(b, `domino:${w}:${h}:${d}`, () => dominoGeo(w, h, d)),
          mat: b.mat('toy/dice_pips', { color: o.color ?? 0xf6f2e6, params: { face: o.face ?? 3 } }),
          surfaceId: SurfaceId.PLASTIC,
        }],
        collider: makeBox(w / 2, h / 2, d / 2),
        comY: h * 0.5,
        radius: h * 0.6,
      };
    },
  },

  block: {
    dynamic: true, mass: 0.13, friction: 0.75, restitution: 0.18,
    build(b, o) {
      const w = o.width ?? 0.16, h = o.height ?? 0.10, d = o.depth ?? 0.32;
      return {
        parts: [{
          geo: geoCache(b, `block:${w}:${h}:${d}:${o.studs !== false}`, () => blockGeo(w, h, d, o.studs !== false)),
          mat: b.mat('toy/lego_studs', { params: { color: o.color ?? 0xd01012, studs: 4 }, sizeMeters: 1 }),
          surfaceId: SurfaceId.PLASTIC,
        }],
        collider: makeBox(w / 2, h / 2 + 0.008, d / 2),
        comY: h * 0.5,
        radius: Math.max(w, d) * 0.6,
      };
    },
  },

  marble: {
    dynamic: true, mass: 0.022, friction: 0.22, restitution: 0.55,
    build(b, o) {
      const r = o.radius ?? 0.048;
      return {
        parts: [{
          geo: geoCache(b, `marble:${r}`, () => G.sphereMeters(r, 16)),
          mat: b.mat('glass/frosted', { color: o.color ?? 0x8fd6ff }),
          surfaceId: SurfaceId.GLASS,
        }],
        collider: makeSphere(r),
        comY: r,
        radius: r,
        rolling: 0.004,
      };
    },
  },

  can: {
    dynamic: true, mass: 0.075, friction: 0.42, restitution: 0.30,
    build(b, o) {
      const r = o.radius ?? 0.055, h = o.height ?? 0.13;
      return {
        parts: [{
          geo: geoCache(b, `can:${r}:${h}`, () => canGeo(r, h)),
          mat: b.mat('metal/brushed_alu', { color: o.color ?? 0xd8dee4 }),
          surfaceId: SurfaceId.METAL,
        }],
        collider: makeCylinder(r, h / 2, 12),
        comY: h * 0.5,
        radius: Math.max(r, h * 0.5) * 1.1,
      };
    },
  },

  pencil: {
    dynamic: true, mass: 0.008, friction: 0.30, restitution: 0.24,
    build(b, o) {
      const len = o.length ?? 0.19, r = o.radius ?? 0.0075;
      return {
        parts: [{
          geo: geoCache(b, `pencil:${len}:${r}`, () => pencilGeo(len, r)),
          mat: b.mat('plastic/injection_gloss', { color: o.color ?? 0xe8b81e }),
          surfaceId: SurfaceId.PLASTIC,
        }],
        collider: makeCapsule(r, len * 0.44, 'x'),
        comY: r,
        radius: len * 0.55,
        rolling: 0.0015,
      };
    },
  },

  ball: {
    dynamic: true, mass: 0.18, friction: 0.60, restitution: 0.62,
    build(b, o) {
      const r = o.radius ?? 0.16;
      return {
        parts: [{
          geo: geoCache(b, `ball:${r}`, () => G.sphereMeters(r, 22)),
          mat: b.mat('rubber/floor_mat', { color: o.color ?? 0xdd3344, sizeMeters: 1 }),
          surfaceId: SurfaceId.RUBBER,
        }],
        collider: makeSphere(r),
        comY: r,
        radius: r,
        rolling: 0.006,
      };
    },
  },

  dice: {
    dynamic: true, mass: 0.06, friction: 0.72, restitution: 0.28,
    build(b, o) {
      const size = o.size ?? 0.11;
      return {
        parts: [{
          geo: geoCache(b, `dice:${size}`, () => diceGeo(size)),
          mat: b.mat('toy/dice_pips', { params: { face: o.face ?? 1, color: o.color ?? 0xf2efe6 } }),
          surfaceId: SurfaceId.PLASTIC,
        }],
        collider: makeBox(size / 2, size / 2, size / 2),
        comY: size * 0.5,
        radius: size * 0.87,
      };
    },
  },

  alphabet_block: {
    dynamic: true, mass: 0.10, friction: 0.78, restitution: 0.20,
    build(b, o) {
      const size = o.size ?? 0.15;
      const letter = o.letter ?? 'A';
      return {
        parts: [{
          geo: geoCache(b, `alpha:${size}`, () => alphaBlockGeo(size)),
          mat: b.mat('toy/alphabet_block', { params: { letter, palette: o.palette ?? 'maple' }, variant: letter }),
          surfaceId: SurfaceId.WOOD,
        }],
        collider: makeBox(size / 2, size / 2, size / 2),
        comY: size * 0.5,
        radius: size * 0.87,
      };
    },
  },

  chess: {
    dynamic: true, mass: 0.11, friction: 0.66, restitution: 0.14,
    build(b, o) {
      const kind = o.piece ?? 'pawn';
      const white = o.white !== false;
      const prof = CHESS_PROFILES[kind] ?? CHESS_PROFILES.pawn;
      let h = 0, maxR = 0;
      for (const [r, y] of prof) { h = Math.max(h, y); maxR = Math.max(maxR, r); }
      return {
        parts: [{
          geo: geoCache(b, `chess:${kind}`, () => chessGeo(kind)),
          mat: b.mat(white ? 'plastic/abs_matte' : 'plastic/injection_gloss', { color: white ? 0xf0e8d4 : 0x231d18 }),
          surfaceId: SurfaceId.PLASTIC,
        }],
        collider: makeCylinder(maxR * 0.8, h * 0.5, 10),
        comY: h * 0.38,
        radius: Math.max(maxR, h * 0.5) * 1.1,
        mass: kind === 'king' || kind === 'queen' ? 0.16 : 0.11,
      };
    },
  },

  plant_pot: {
    dynamic: true, mass: 0.55, friction: 0.85, restitution: 0.10,
    build(b, o) {
      const rTop = o.radius ?? 0.20, h = o.height ?? 0.24;
      const parts = flowerPotParts(rTop, h);
      const list = [
        { geo: parts.pot, mat: b.mat('metal/painted', { params: { color: o.color ?? 0xb4562f, wear: 1 } }), surfaceId: SurfaceId.PLASTIC },
        { geo: parts.soil, mat: b.mat('dirt/ground'), surfaceId: SurfaceId.DIRT, noCollide: true },
      ];
      if (o.plant !== false) {
        list.push({
          geo: parts.plant,
          mat: b.mat('fabric/felt', { params: { color: o.plantColor ?? 0x3d7a3a }, doubleSide: true, sizeMeters: 1 }),
          surfaceId: null, noCollide: true, wind: true,
        });
      }
      return {
        parts: list,
        collider: makeCylinder(rTop * 0.9, h * 0.5, 10),
        comY: h * 0.34,
        radius: rTop * 1.6,
      };
    },
  },

  tin_bucket: {
    dynamic: true, mass: 0.30, friction: 0.70, restitution: 0.22,
    build(b, o) {
      const r = o.radius ?? 0.16, h = o.height ?? 0.22;
      const geo = geoCache(b, `bucket:${r}:${h}`, () => G.latheMeters([
        [0, 0], [r * 0.72, 0], [r * 0.76, 0.012], [r, h - 0.01], [r * 1.05, h],
        [r * 0.99, h], [r * 0.95, h - 0.02], [r * 0.7, 0.02], [0, 0.02],
      ], 18));
      return {
        parts: [{ geo, mat: b.mat('metal/galvanised'), surfaceId: SurfaceId.METAL }],
        collider: makeCylinder(r * 0.92, h * 0.5, 10),
        comY: h * 0.4,
        radius: r * 1.3,
      };
    },
  },

  // ─────────────────────────────────────────────────────── static decoration

  display_case: {
    dynamic: false,
    build(b, o) {
      const w = o.width ?? 1.2, d = o.depth ?? 0.8;
      const ph = o.plinthHeight ?? 0.55, gh = o.glassHeight ?? 0.7;
      const parts = displayCaseParts(w, d, ph, gh);
      const list = [
        { geo: parts.plinth, mat: b.mat(o.plinthMaterial ?? 'wood/mdf', { color: o.plinthColor ?? 0x6a5237 }), surfaceId: SurfaceId.WOOD },
        { geo: parts.frame, mat: b.mat('metal/brushed_alu'), surfaceId: SurfaceId.METAL },
        { geo: parts.glass, mat: b.mat('glass/clear', { doubleSide: true, opacity: 0.35, transparent: true }), surfaceId: SurfaceId.GLASS, order: 3 },
      ];
      return { parts: list, radius: Math.max(w, d) * 0.7, staticSurface: SurfaceId.WOOD };
    },
  },

  stanchion: {
    dynamic: false,
    build(b, o) {
      const h = o.height ?? 0.55;
      return {
        parts: [{
          geo: geoCache(b, `stanchion:${h}`, () => stanchionGeo(h)),
          mat: b.mat('metal/chrome'), surfaceId: SurfaceId.METAL,
        }],
        radius: 0.12, collideMode: 'box',
      };
    },
  },

  column: {
    dynamic: false,
    build(b, o) {
      const h = o.height ?? 4, r = o.radius ?? 0.35;
      return {
        parts: [{
          geo: geoCache(b, `column:${h}:${r}`, () => columnGeo(h, r)),
          mat: b.mat(o.material ?? 'concrete/screed', { color: o.color ?? 0xe8e2d4 }),
          surfaceId: SurfaceId.CONCRETE,
        }],
        radius: r * 1.4,
      };
    },
  },

  book_stack: {
    dynamic: false,
    build(b, o) {
      const n = o.count ?? 4;
      const seed = o.seed ?? 1;
      return {
        parts: [{
          geo: geoCache(b, `books:${n}:${seed & 7}`, () => bookStackGeo(n, seed)),
          mat: b.mat('cardboard/kraft', { color: o.color ?? 0xb0563a }),
          surfaceId: SurfaceId.DEFAULT,
        }],
        radius: 0.22,
      };
    },
  },

  crate: {
    dynamic: false,
    build(b, o) {
      const w = o.width ?? 0.45, h = o.height ?? 0.35, d = o.depth ?? 0.35;
      return {
        parts: [{
          geo: geoCache(b, `crate:${w}:${h}:${d}:${!!o.open}`, () => cardboardBoxGeo(w, h, d, !!o.open)),
          mat: b.mat(o.material ?? 'cardboard/corrugated'),
          surfaceId: SurfaceId.DEFAULT,
        }],
        radius: Math.max(w, d) * 0.75,
        collideMode: o.open ? true : 'box',
      };
    },
  },

  crate_heavy: {
    dynamic: true, mass: 1.1, friction: 0.8, restitution: 0.08,
    build(b, o) {
      const w = o.width ?? 0.4, h = o.height ?? 0.32, d = o.depth ?? 0.32;
      return {
        parts: [{
          geo: geoCache(b, `crateH:${w}:${h}:${d}`, () => cardboardBoxGeo(w, h, d, false)),
          mat: b.mat('cardboard/kraft'),
          surfaceId: SurfaceId.DEFAULT,
        }],
        collider: makeBox(w / 2, h / 2, d / 2),
        comY: h * 0.45,
        radius: Math.max(w, d) * 0.75,
      };
    },
  },

  dino_skeleton: {
    dynamic: false,
    build(b, o) {
      const s = o.scale ?? 1;
      return {
        parts: [{
          geo: geoCache(b, `dino:${s.toFixed(2)}`, () => dinoSkeletonParts(s)),
          mat: b.mat('concrete/screed', { color: o.color ?? 0xd8ceb2, roughness: 0.85 }),
          surfaceId: SurfaceId.DEFAULT,
        }],
        radius: 13 * s,
        // Only the legs and the mounting plinth need to be solid; the ribcage is
        // 5 m up, so full collision would be thousands of pointless triangles.
        collideMode: false,
      };
    },
  },

  rocket: {
    dynamic: false,
    build(b, o) {
      const h = o.height ?? 14, r = o.radius ?? 1.3;
      const parts = rocketParts(h, r);
      return {
        parts: [
          { geo: parts.hull, mat: b.mat('metal/painted', { params: { color: o.color ?? 0xe8e6df, wear: 0.7 } }), surfaceId: SurfaceId.METAL },
          { geo: parts.stripe, mat: b.mat('metal/painted', { params: { color: o.stripeColor ?? 0xc0322c, wear: 0.5 }, variant: 'stripe' }), surfaceId: SurfaceId.METAL, noCollide: true },
          { geo: parts.bell, mat: b.mat('metal/rust'), surfaceId: SurfaceId.METAL, noCollide: true },
        ],
        radius: r * 2,
        collideMode: false,
      };
    },
  },

  gnome: {
    dynamic: true, mass: 0.35, friction: 0.8, restitution: 0.12,
    build(b, o) {
      return {
        parts: [{
          geo: geoCache(b, 'gnome', () => gnomeGeo()),
          mat: b.mat('plastic/abs_matte', { color: o.color ?? 0xd8503c }),
          surfaceId: SurfaceId.PLASTIC,
        }],
        collider: makeCylinder(0.09, 0.19, 10),
        comY: 0.14,
        radius: 0.24,
      };
    },
  },

  watering_can: {
    dynamic: true, mass: 0.4, friction: 0.7, restitution: 0.18,
    build(b, o) {
      const s = o.scale ?? 1;
      return {
        parts: [{
          geo: geoCache(b, `wcan:${s}`, () => wateringCanGeo(s)),
          mat: b.mat('metal/galvanised'),
          surfaceId: SurfaceId.METAL,
        }],
        collider: makeBox(0.28 * s, 0.16 * s, 0.15 * s, new THREE.Vector3(0.08 * s, 0, 0)),
        comY: 0.13 * s,
        radius: 0.36 * s,
      };
    },
  },

  bush: {
    dynamic: false,
    build(b, o) {
      const r = o.radius ?? 0.5, h = o.height ?? 0.8;
      const seed = o.seed ?? 5;
      const geo = geoCache(b, `bush:${r}:${h}:${seed & 15}`, () => G.foliageCluster(r, h, o.cards ?? 6, seed));
      const base = b.mat('fabric/felt', { params: { color: o.color ?? 0x35682f }, doubleSide: true, sizeMeters: 1 });
      return {
        parts: [{ geo, mat: base, surfaceId: null, noCollide: true, wind: true }],
        radius: r,
        blocker: { radius: r * 0.55, height: h * 0.5, surfaceId: SurfaceId.GRASS },
      };
    },
  },

  grass_tuft: {
    dynamic: false,
    build(b, o) {
      const h = o.height ?? 0.09;
      const geo = geoCache(b, `tuft:${h}:${(o.seed ?? 1) & 7}`, () => G.grassTuft(h, 0.022, 3, o.seed ?? 1));
      return {
        parts: [{
          geo,
          mat: b.mat('grass/lawn', { doubleSide: true, sizeMeters: 1, color: o.color ?? 0xffffff }),
          surfaceId: null, noCollide: true, wind: true,
        }],
        radius: h,
      };
    },
  },

  flower: {
    dynamic: false,
    build(b, o) {
      const h = o.height ?? 0.22;
      const geo = geoCache(b, `flower:${h}:${(o.seed ?? 1) & 7}`, () => {
        const parts = [];
        const stem = G.cylinderMeters(0.005, 0.007, h, 5);
        stem.translate(0, h * 0.5, 0);
        parts.push(stem);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const petal = G.planeXY(0.045, 0.045);
          petal.rotateX(-Math.PI / 2.4);
          petal.rotateY(a);
          petal.translate(Math.cos(a) * 0.022, h, Math.sin(a) * 0.022);
          parts.push(petal);
        }
        const centre = G.sphereMeters(0.016, 8);
        centre.translate(0, h + 0.004, 0);
        parts.push(centre);
        return G.mergeList(parts) ?? stem;
      });
      return {
        parts: [{
          geo,
          mat: b.mat('plastic/abs_matte', { color: o.color ?? 0xe8c033, doubleSide: true }),
          surfaceId: null, noCollide: true, wind: true,
        }],
        radius: 0.06,
      };
    },
  },

  rock: {
    dynamic: false,
    build(b, o) {
      const r = o.radius ?? 0.3;
      const seed = o.seed ?? 3;
      return {
        parts: [{
          geo: geoCache(b, `rock:${r.toFixed(2)}:${seed & 15}`, () => {
            const g = G.sphereMeters(r, 12);
            G.roughen(g, r * 0.28, 6, seed);
            g.scale(1, 0.72, 0.92);
            return g;
          }),
          mat: b.mat('concrete/rough', { color: o.color ?? 0x9c968b }),
          surfaceId: SurfaceId.CONCRETE,
        }],
        radius: r * 1.3,
      };
    },
  },

  picture_frame: {
    dynamic: false,
    build(b, o) {
      const w = o.width ?? 1.2, h = o.height ?? 0.9;
      const frame = geoCache(b, `pframe:${w}:${h}`, () => G.frameGeo(w, h, 0.07, 0.06));
      const canvasGeo = geoCache(b, `pcanvas:${w}:${h}`, () => {
        const g = G.planeXY(w - 0.13, h - 0.13);
        G.scaleUV(g, 1 / (w - 0.13), 1 / (h - 0.13));
        return g;
      });
      return {
        parts: [
          { geo: frame, mat: b.mat('metal/painted', { params: { color: o.frameColor ?? 0xb08a3a, wear: 0.4 } }), surfaceId: SurfaceId.WOOD },
          {
            geo: canvasGeo,
            mat: o.text
              ? b.decal({ text: o.text, key: `frame:${o.text}`, width: 512, height: 384, background: o.background ?? '#2c3a52', textColor: o.textColor ?? '#e8dcc0', offsetFactor: 0, roughness: 0.8 })
              : b.mat('wallpaper/floral'),
            surfaceId: null, noCollide: true, zOffset: 0.012,
          },
        ],
        radius: Math.max(w, h) * 0.6,
        collideMode: 'box',
      };
    },
  },

  hedge: {
    dynamic: false,
    build(b, o) {
      const w = o.width ?? 1.0, h = o.height ?? 0.6, d = o.depth ?? 0.5;
      const geo = geoCache(b, `hedge:${w}:${h}:${d}`, () => {
        const g = G.boxMeters(w, h, d, { radius: Math.min(w, d) * 0.22, seg: 3 });
        G.roughen(g, 0.02, 22, 4);
        g.translate(0, h * 0.5, 0);
        return g;
      });
      return {
        parts: [{
          geo,
          mat: b.mat('fabric/felt', { params: { color: o.color ?? 0x2f5f2c }, sizeMeters: 1 }),
          surfaceId: SurfaceId.CARPET,
        }],
        radius: Math.max(w, d) * 0.6,
      };
    },
  },
};

// ═════════════════════════════════════════════════════════════════ spawning

/**
 * Instantiate a prop into a `TrackBuilder`.
 *
 * @param {import('./TrackBuilder.js').TrackBuilder} b
 * @param {string} kind key in {@link PROPS}
 * @param {object} o
 * @param {number[]} [o.position]
 * @param {number[]} [o.rotation] euler XYZ
 * @param {number|number[]} [o.scale]
 * @param {boolean} [o.dynamic] override the catalogue default
 * @param {boolean} [o.instanced] batch identical statics into an InstancedMesh
 * @param {number} [o.mass]
 * @returns {object|null} the prop record
 */
export function spawnProp(b, kind, o = {}) {
  const def = PROPS[kind];
  if (!def) { console.warn(`[Props] unknown prop "${kind}"`); return null; }

  const spec = def.build(b, o) ?? {};
  const parts = spec.parts ?? (spec.geo ? [{ geo: spec.geo, mat: spec.mat, surfaceId: spec.surfaceId }] : []);
  if (parts.length === 0) return null;

  const pos = xyz(o.position, [0, 0, 0]);
  const rot = xyz(o.rotation, [0, 0, 0]);
  let sc = o.scale ?? 1;
  if (Array.isArray(sc)) sc = [sc[0] ?? 1, sc[1] ?? sc[0] ?? 1, sc[2] ?? sc[0] ?? 1];
  else sc = [sc, sc, sc];

  const dynamic = o.dynamic ?? def.dynamic ?? false;

  if (dynamic) return spawnDynamic(b, kind, def, spec, parts, pos, rot, sc, o);
  return spawnStatic(b, kind, def, spec, parts, pos, rot, sc, o);
}

function spawnStatic(b, kind, def, spec, parts, pos, rot, sc, o) {
  _v.set(pos[0], pos[1], pos[2]);
  _e.set(rot[0], rot[1], rot[2]);
  _q.setFromEuler(_e);
  _s.set(sc[0], sc[1], sc[2]);
  _m.compose(_v, _q, _s);

  const collideMode = o.collide ?? spec.collideMode ?? true;
  const instanced = o.instanced ?? false;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.geo || !p.mat) continue;
    let mat = p.mat;
    if (p.wind) mat = getWindClone(b, mat);
    const geo = p.zOffset ? offsetClone(b, p.geo, p.zOffset) : p.geo;
    const collide = !p.noCollide && collideMode !== false && p.surfaceId != null;
    if (instanced) {
      // The geometry uuid has to be in the key: two `bush` props with different
      // radii cache different geometries, and they must not silently collapse
      // into one InstancedMesh drawn with whichever arrived first.
      b.instance(`prop:${kind}:${i}:${geo.uuid}:${mat.uuid}`, geo, mat, _m, {
        collide: collide ? (collideMode === 'box' ? 'box' : true) : false,
        surfaceId: p.surfaceId ?? 0,
        cast: p.cast ?? o.cast ?? true,
        receive: p.receive ?? true,
        decor: !collide,
        order: p.order ?? 0,
      });
    } else {
      b.add(geo, mat, {
        matrix: _m,
        surfaceId: collide ? p.surfaceId : null,
        collide,
        cast: p.cast ?? o.cast ?? true,
        receive: p.receive ?? true,
        decor: !collide,
        order: p.order ?? 0,
        vertexColors: p.vertexColors,
      });
    }
  }

  // Foliage-style props get a small invisible blocker so a car cannot drive
  // through the middle of a bush that is only made of alpha cards.
  if (spec.blocker && o.collide !== false) {
    const blk = G.boxMeters(spec.blocker.radius * 2, spec.blocker.height, spec.blocker.radius * 2);
    blk.translate(0, spec.blocker.height * 0.5, 0);
    b.addCollisionOnly(blk, spec.blocker.surfaceId ?? SurfaceId.DEFAULT, _m);
    blk.dispose();
  }

  const rec = {
    id: ++_propId,
    kind,
    dynamic: false,
    position: new THREE.Vector3(pos[0], pos[1], pos[2]),
    radius: (spec.radius ?? 0.3) * Math.max(sc[0], sc[1], sc[2]),
    body: null,
    group: null,
  };
  b.propRuntime.props.push(rec);
  return rec;
}

function spawnDynamic(b, kind, def, spec, parts, pos, rot, sc, o) {
  const scale = Math.max(sc[0], sc[1], sc[2]);
  const group = new THREE.Group();
  group.name = `prop:${kind}:${_propId + 1}`;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p.geo || !p.mat) continue;
    let mat = p.mat;
    if (p.wind) mat = getWindClone(b, mat);
    const mesh = new THREE.Mesh(p.geo, mat);
    mesh.castShadow = p.cast ?? true;
    mesh.receiveShadow = p.receive ?? true;
    mesh.userData.noCollision = true;
    if (p.order) mesh.renderOrder = p.order;
    // Bodies rotate about their COM, so shift the visual down by comY.
    mesh.position.y = -(spec.comY ?? 0);
    group.add(mesh);
  }
  group.scale.set(sc[0], sc[1], sc[2]);

  const mass = (o.mass ?? spec.mass ?? def.mass ?? 0.1) * scale * scale * scale;
  const collider = scaleCollider(spec.collider ?? makeBox(0.05, 0.05, 0.05), scale);
  _e.set(rot[0], rot[1], rot[2]);
  _q.setFromEuler(_e);

  const body = new RigidBody({
    collider,
    mass,
    position: [pos[0], pos[1] + (spec.comY ?? 0) * scale, pos[2]],
    quaternion: _q.clone(),
    layer: Layer.PROP,
    mask: Layer.ALL,
    friction: o.friction ?? def.friction ?? 0.7,
    restitution: o.restitution ?? def.restitution ?? 0.2,
    rollingFriction: o.rolling ?? spec.rolling ?? 0.0,
    linearDamping: o.linearDamping ?? 0.03,
    angularDamping: o.angularDamping ?? 0.12,
    allowSleep: true,
    ccd: (spec.radius ?? 0.1) * scale < 0.09,
    name: `${kind}#${_propId + 1}`,
  });
  body.userData = { kind, propId: ++_propId, id: _propId, prop: true, track: true };

  const rec = {
    id: _propId,
    kind,
    dynamic: true,
    body,
    group,
    position: new THREE.Vector3(pos[0], pos[1], pos[2]),
    home: new THREE.Vector3(pos[0], pos[1] + (spec.comY ?? 0) * scale, pos[2]),
    homeQuat: _q.clone(),
    radius: (spec.radius ?? 0.2) * scale,
    comY: (spec.comY ?? 0) * scale,
    enabled: true,
  };
  b.propRuntime.register(rec);
  b.scene.add(group);
  return rec;
}

/** Cache a wind-swayed clone per source material. */
function getWindClone(b, mat) {
  b._windClones ??= new Map();
  let m = b._windClones.get(mat.uuid);
  if (!m) {
    m = b.windMaterial(mat, { strength: 0.07, frequency: 1.6, scale: 0.8 });
    b._windClones.set(mat.uuid, m);
  }
  return m;
}

/** Cache a z-offset clone of a geometry (picture canvases in their frames). */
function offsetClone(b, geo, dz) {
  b._offsetClones ??= new Map();
  const key = `${geo.uuid}:${dz}`;
  let g = b._offsetClones.get(key);
  if (!g) {
    g = geo.clone();
    g.translate(0, 0, dz);
    b._offsetClones.set(key, g);
    b._ownedGeo.push(g);
  }
  return g;
}

// ═══════════════════════════════════════════════════════ animated set dressing

/**
 * An animated fixture. `update(dt, elapsed)` drives it; everything is optional
 * so a fixture can be purely visual or push a kinematic body around.
 */
class Fixture {
  constructor(kind, object, opts = {}) {
    this.kind = kind;
    this.object = object;
    this.opts = opts;
    this.body = null;
    this.time = 0;
  }
  update() {}
}

class CustomFixture extends Fixture {
  /** `fn(dt, elapsed, object)` — the escape hatch for one-off animations. */
  constructor(object, fn, o = {}) {
    super('custom', object, o);
    this.fn = fn;
  }
  update(dt, elapsed) { this.fn(dt, elapsed, this.object); }
}

class SpinFixture extends Fixture {
  constructor(object, o) {
    super('spin', object, o);
    this.axis = o.axis ?? 'y';
    this.speed = o.speed ?? 2.2;
    this.wobble = o.wobble ?? 0;
  }
  update(dt) {
    this.time += dt;
    const a = this.time * this.speed;
    if (this.axis === 'x') this.object.rotation.x = a;
    else if (this.axis === 'z') this.object.rotation.z = a;
    else this.object.rotation.y = a;
    if (this.wobble) this.object.rotation.z = Math.sin(this.time * 1.7) * this.wobble;
  }
}

class PendulumFixture extends Fixture {
  constructor(object, o) {
    super('pendulum', object, o);
    this.amplitude = o.amplitude ?? 0.5;
    this.period = o.period ?? 2.4;
    this.axis = o.axis ?? 'x';
    this.phase = o.phase ?? 0;
  }
  update(dt) {
    this.time += dt;
    const a = Math.sin((this.time / this.period) * Math.PI * 2 + this.phase) * this.amplitude;
    if (this.axis === 'z') this.object.rotation.z = a;
    else this.object.rotation.x = a;
  }
}

class TrackedFixture extends Fixture {
  /** Moves an object back and forth along a polyline (a model train, a trolley). */
  constructor(object, o) {
    super('tracked', object, o);
    this.points = (o.points ?? []).map((p) => new THREE.Vector3(...xyz(p)));
    this.speed = o.speed ?? 2.0;
    this.loop = o.loop !== false;
    this.pingPong = !!o.pingPong;
    this.dir = 1;
    this.dist = o.startDistance ?? 0;
    this.segLen = [];
    this.total = 0;
    for (let i = 0; i < this.points.length - 1; i++) {
      const l = this.points[i].distanceTo(this.points[i + 1]);
      this.segLen.push(l);
      this.total += l;
    }
    if (this.loop && this.points.length > 2) {
      const l = this.points[this.points.length - 1].distanceTo(this.points[0]);
      this.segLen.push(l);
      this.total += l;
    }
    this.body = o.body ?? null;
    this._prev = new THREE.Vector3();
  }

  sample(d, outPos, outDir) {
    if (this.total <= 0 || this.points.length < 2) { outPos.copy(this.points[0] ?? _v.set(0, 0, 0)); return; }
    let dd = d % this.total;
    if (dd < 0) dd += this.total;
    for (let i = 0; i < this.segLen.length; i++) {
      if (dd <= this.segLen[i] || i === this.segLen.length - 1) {
        const a = this.points[i];
        const bq = this.points[(i + 1) % this.points.length];
        const f = this.segLen[i] > 1e-6 ? Math.min(1, dd / this.segLen[i]) : 0;
        outPos.lerpVectors(a, bq, f);
        if (outDir) outDir.copy(bq).sub(a).normalize();
        return;
      }
      dd -= this.segLen[i];
    }
  }

  update(dt) {
    this.time += dt;
    this._prev.copy(this.object.position);
    this.dist += this.speed * dt * this.dir;
    if (this.pingPong) {
      if (this.dist > this.total) { this.dist = this.total; this.dir = -1; }
      else if (this.dist < 0) { this.dist = 0; this.dir = 1; }
    }
    this.sample(this.dist, _v, _v2);
    this.object.position.copy(_v);
    if (_v2.lengthSq() > 1e-8) {
      const yaw = Math.atan2(_v2.x * this.dir, _v2.z * this.dir);
      this.object.rotation.y = yaw + Math.PI;
    }
    if (this.body) {
      // Kinematic: velocity carries the push, position keeps it exact.
      const inv = dt > 1e-6 ? 1 / dt : 0;
      this.body.velocity.set(
        (_v.x - this._prev.x) * inv,
        (_v.y - this._prev.y) * inv,
        (_v.z - this._prev.z) * inv,
      );
      this.body.position.set(_v.x, _v.y + (this.opts.bodyLift ?? 0), _v.z);
      this.body.quaternion.setFromEuler(this.object.rotation);
      this.body._cacheStamp = -1;
      this.body.updateAABB(0.02);
    }
  }
}

class SprinklerFixture extends Fixture {
  /**
   * A sweeping sprinkler. The wet arc is baked into the collision surface (so
   * grip really drops), and this fixture animates the head plus a fan of water
   * "blades" and optionally toggles a `gripZone`.
   */
  constructor(object, o) {
    super('sprinkler', object, o);
    this.head = o.head ?? object;
    this.fan = o.fan ?? null;
    this.sweep = o.sweep ?? Math.PI * 0.75;
    this.period = o.period ?? 4.2;
    this.zone = o.zone ?? null;
  }
  update(dt) {
    this.time += dt;
    const f = Math.sin((this.time / this.period) * Math.PI * 2);
    const a = (this.opts.center ?? 0) + f * this.sweep * 0.5;
    this.head.rotation.y = a;
    if (this.fan) {
      this.fan.rotation.y = a;
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 9.0);
      this.fan.scale.set(pulse, 1, pulse);
      this.fan.material.opacity = 0.20 + 0.10 * Math.sin(this.time * 5.3);
    }
    if (this.zone) {
      this.zone.a0 = a - this.sweep * 0.5;
      this.zone.a1 = a + this.sweep * 0.5;
    }
  }
}

class FlagFixture extends Fixture {
  /** A cloth that ripples by animating its vertices — cheap and readable. */
  constructor(mesh, o) {
    super('flag', mesh, o);
    this.mesh = mesh;
    this.amp = o.amplitude ?? 0.05;
    this.freq = o.frequency ?? 3.2;
    this.base = mesh.geometry.getAttribute('position').array.slice();
  }
  update(dt) {
    this.time += dt;
    const pos = this.mesh.geometry.getAttribute('position');
    const a = pos.array;
    const base = this.base;
    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3];
      const by = base[i * 3 + 1];
      const f = Math.max(0, bx + 0.5);
      a[i * 3 + 2] = base[i * 3 + 2]
        + Math.sin(this.time * this.freq + bx * 6.0 + by * 2.0) * this.amp * f;
    }
    pos.needsUpdate = true;
  }
}

// ══════════════════════════════════════════════════════════════ prop runtime

/**
 * Owns dynamic prop bodies and animated fixtures for one loaded track.
 *
 * `update(dt, alpha)` is called by `TrackSystem.update`, `fixedUpdate(dt)` by
 * `TrackSystem.fixedUpdate`. Bodies are added to the physics world in
 * `attach()` (from `TrackSystem.onRaceStart`) and removed in `detach()`.
 */
export class PropRuntime {
  constructor(game, builder) {
    this.game = game;
    this.builder = builder;
    this.track = null;
    /** @type {object[]} every prop record, static and dynamic */
    this.props = [];
    /** @type {object[]} dynamic subset (has .body and .group) */
    this.dynamic = [];
    /** @type {Fixture[]} */
    this.fixtures = [];
    /** @type {RigidBody[]} kinematic bodies owned by fixtures */
    this.kinematics = [];
    this.attached = false;

    /** Metres from the nearest car within which a prop body is simulated. */
    this.activeRadius = 9.0;
    /** Hysteresis so a prop on the edge does not flicker on and off. */
    this.sleepRadius = 13.0;
    this._cullTimer = 0;
    this._cullEvery = 0.1;
    this._elapsed = 0;
  }

  register(rec) {
    this.props.push(rec);
    if (rec.dynamic) this.dynamic.push(rec);
  }

  /** Register an animated fixture. */
  addFixture(fixture) {
    this.fixtures.push(fixture);
    if (fixture.body) this.kinematics.push(fixture.body);
    return fixture;
  }

  custom(object, fn, o) { return this.addFixture(new CustomFixture(object, fn, o ?? {})); }
  spin(object, o) { return this.addFixture(new SpinFixture(object, o ?? {})); }
  pendulum(object, o) { return this.addFixture(new PendulumFixture(object, o ?? {})); }
  tracked(object, o) { return this.addFixture(new TrackedFixture(object, o ?? {})); }
  sprinkler(object, o) { return this.addFixture(new SprinklerFixture(object, o ?? {})); }
  flag(mesh, o) { return this.addFixture(new FlagFixture(mesh, o ?? {})); }

  /** Add every body to the physics world. Safe to call twice. */
  attach() {
    const phys = this.game?.physics;
    if (!phys || this.attached) return;
    for (const rec of this.dynamic) {
      if (!rec.body) continue;
      rec.body.enabled = true;
      rec.enabled = true;
      phys.addBody(rec.body);
      rec.body.sleep();
    }
    for (const body of this.kinematics) phys.addBody(body);
    this.attached = true;
  }

  /** Remove every body from the physics world. */
  detach() {
    const phys = this.game?.physics;
    if (phys) {
      for (const rec of this.dynamic) if (rec.body) phys.removeBody(rec.body);
      for (const body of this.kinematics) phys.removeBody(body);
    }
    this.attached = false;
  }

  /** Return every dynamic prop to its authored pose (used on race restart). */
  reset() {
    for (const rec of this.dynamic) {
      if (!rec.body) continue;
      rec.body.setTransform(rec.home, rec.homeQuat);
      rec.body.velocity.set(0, 0, 0);
      rec.body.angularVelocity.set(0, 0, 0);
      rec.body.enabled = true;
      rec.enabled = true;
      rec.body.sleep();
      rec.body.applyToObject3D(rec.group, 1);
    }
  }

  /**
   * Enable/disable prop bodies by distance to the nearest car. Called from
   * `fixedUpdate`, throttled — allocation-free.
   */
  fixedUpdate(dt) {
    this._cullTimer -= dt;
    if (this._cullTimer > 0) return;
    this._cullTimer = this._cullEvery;

    const cars = this.game?.cars;
    if (!cars || cars.length === 0) return;
    const near2 = this.activeRadius * this.activeRadius;
    const far2 = this.sleepRadius * this.sleepRadius;

    for (let i = 0; i < this.dynamic.length; i++) {
      const rec = this.dynamic[i];
      const body = rec.body;
      if (!body) continue;
      let best = Infinity;
      for (let c = 0; c < cars.length; c++) {
        const car = cars[c];
        const p = car?.body?.position ?? car?.group?.position;
        if (!p) continue;
        const dx = p.x - body.position.x;
        const dy = p.y - body.position.y;
        const dz = p.z - body.position.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) best = d2;
      }
      if (rec.enabled) {
        // Only park a prop that is already asleep — never freeze one mid-flight.
        if (best > far2 && body.sleeping) { body.enabled = false; rec.enabled = false; }
      } else if (best < near2) {
        body.enabled = true;
        rec.enabled = true;
        body.updateInertiaWorld();
        body.updateAABB(0.02);
      }
    }
  }

  /** Sync visuals + drive fixtures. */
  update(dt, alpha = 1) {
    this._elapsed += dt;
    for (let i = 0; i < this.dynamic.length; i++) {
      const rec = this.dynamic[i];
      if (!rec.body || !rec.group) continue;
      if (!rec.enabled && rec.group.userData._parked) continue;
      rec.body.applyToObject3D(rec.group, alpha);
      rec.group.userData._parked = !rec.enabled;
    }
    for (let i = 0; i < this.fixtures.length; i++) {
      try { this.fixtures[i].update(dt, this._elapsed); }
      catch (err) {
        if (!this._fixtureWarned) { this._fixtureWarned = true; console.warn('[Props] fixture threw:', err); }
      }
    }
  }

  dispose() {
    this.detach();
    for (const rec of this.dynamic) {
      rec.group?.parent?.remove(rec.group);
      rec.group = null;
      rec.body = null;
    }
    for (const f of this.fixtures) {
      if (f instanceof FlagFixture) f.base = null;
    }
    this.props.length = 0;
    this.dynamic.length = 0;
    this.fixtures.length = 0;
    this.kinematics.length = 0;
  }
}

// ══════════════════════════════════════════════ composite animated builders

/**
 * A ceiling / pedestal fan. Returns `{ group, fixture }`; the blades spin.
 * @param {import('./TrackBuilder.js').TrackBuilder} b
 */
export function buildFan(b, o = {}) {
  const r = o.radius ?? 0.7;
  const blades = o.blades ?? 4;
  const group = new THREE.Group();
  group.position.set(...xyz(o.position, [0, 3, 0]));

  const cageMat = b.mat('metal/brushed_alu');
  const bladeMat = b.mat('metal/painted', { params: { color: o.color ?? 0x3a4652, wear: 0.35 } });

  // Static mount.
  const mount = new THREE.Mesh(G.cylinderMeters(0.05, 0.05, o.dropLength ?? 0.5, 10), cageMat);
  mount.position.y = (o.dropLength ?? 0.5) * 0.5;
  mount.castShadow = true;
  mount.userData.noCollision = true;
  group.add(mount);

  const hub = new THREE.Group();
  const hubMesh = new THREE.Mesh(G.cylinderMeters(0.10, 0.12, 0.09, 14), cageMat);
  hubMesh.userData.noCollision = true;
  hub.add(hubMesh);
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    const blade = new THREE.Mesh(G.boxMeters(r, 0.012, 0.20, { radius: 0.005, seg: 2 }), bladeMat);
    blade.position.set(Math.cos(a) * r * 0.55, 0, Math.sin(a) * r * 0.55);
    blade.rotation.y = -a;
    blade.rotation.z = 0.22;
    blade.castShadow = true;
    blade.userData.noCollision = true;
    hub.add(blade);
  }
  hub.position.y = 0;
  group.add(hub);

  if (o.cage !== false) {
    const cage = new THREE.Mesh(G.torusMeters(r * 1.05, 0.012, 26, 6), cageMat);
    cage.rotation.x = Math.PI / 2;
    cage.userData.noCollision = true;
    group.add(cage);
  }

  b.addObject(group, { animated: true });
  const fixture = b.propRuntime.spin(hub, { speed: o.speed ?? 3.4, axis: 'y' });
  return { group, hub, fixture };
}

/** A swinging pendulum (a wrecking-ball style hazard, or a grandfather clock). */
export function buildPendulum(b, o = {}) {
  const group = new THREE.Group();
  group.position.set(...xyz(o.position, [0, 3, 0]));
  const len = o.length ?? 2.2;
  const mat = b.mat(o.material ?? 'metal/brushed_alu');

  const pivot = new THREE.Group();
  const rod = new THREE.Mesh(G.cylinderMeters(0.022, 0.022, len, 8), mat);
  rod.position.y = -len * 0.5;
  rod.castShadow = true;
  rod.userData.noCollision = true;
  pivot.add(rod);
  const bob = new THREE.Mesh(
    o.disc ? G.cylinderMeters(o.radius ?? 0.28, o.radius ?? 0.28, 0.05, 20) : G.sphereMeters(o.radius ?? 0.22, 16),
    b.mat(o.bobMaterial ?? 'metal/chrome'),
  );
  if (o.disc) bob.rotation.x = Math.PI / 2;
  bob.position.y = -len;
  bob.castShadow = true;
  bob.userData.noCollision = true;
  pivot.add(bob);
  group.add(pivot);

  const bracket = new THREE.Mesh(G.boxMeters(0.10, 0.08, 0.10), mat);
  bracket.position.y = 0.05;
  bracket.userData.noCollision = true;
  group.add(bracket);

  b.addObject(group, { animated: true });
  const fixture = b.propRuntime.pendulum(pivot, {
    amplitude: o.amplitude ?? 0.5, period: o.period ?? 2.6, axis: o.axis ?? 'x', phase: o.phase ?? 0,
  });
  return { group, pivot, bob, fixture };
}

/**
 * A model train on a loop of track. Optionally kinematic so it can shove cars
 * out of the way where it crosses the racing line.
 */
export function buildTrain(b, o = {}) {
  const pts = o.points ?? [[-4, 0, -4], [4, 0, -4], [4, 0, 4], [-4, 0, 4]];
  const railMat = b.mat('metal/rust');
  const sleeperMat = b.mat('wood/pine_planks', { color: 0x6a5238 });
  const gauge = o.gauge ?? 0.28;
  const railY = o.y ?? 0.012;

  // Rails + sleepers as static, merged, low geometry.
  const world = pts.map((p) => new THREE.Vector3(...xyz(p)));
  const closed = o.closed !== false;
  const curve = new THREE.CatmullRomCurve3(world, closed, 'catmullrom', 0.4);
  const n = Math.max(16, Math.ceil(curve.getLength() / 0.3));
  const railL = [], railR = [], sleepers = [];
  const tan = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const p = curve.getPoint(f);
    curve.getTangent(f, tan);
    _v.set(-tan.z, 0, tan.x).normalize();
    railL.push(new THREE.Vector3(p.x + _v.x * gauge * 0.5, p.y + railY, p.z + _v.z * gauge * 0.5));
    railR.push(new THREE.Vector3(p.x - _v.x * gauge * 0.5, p.y + railY, p.z - _v.z * gauge * 0.5));
    if (i % 3 === 0) {
      const sl = G.boxMeters(gauge * 1.5, 0.016, 0.05, { radius: 0.004, seg: 1 });
      _e.set(0, Math.atan2(tan.x, tan.z), 0);
      _q.setFromEuler(_e);
      _m.compose(new THREE.Vector3(p.x, p.y + 0.008, p.z), _q, new THREE.Vector3(1, 1, 1));
      sl.applyMatrix4(_m);
      sleepers.push(sl);
    }
  }
  const rails = G.mergeList([
    G.tubeAlong(railL, 0.010, 5, closed),
    G.tubeAlong(railR, 0.010, 5, closed),
  ]);
  if (rails) b.add(rails, railMat, { surfaceId: SurfaceId.METAL, cast: false, receive: true });
  const sleeperGeo = G.mergeList(sleepers);
  if (sleeperGeo) b.add(sleeperGeo, sleeperMat, { surfaceId: SurfaceId.WOOD, cast: false, receive: true });
  rails?.dispose();
  sleeperGeo?.dispose();

  // The locomotive + two wagons, as one group.
  const group = new THREE.Group();
  const bodyMat = b.mat('metal/painted', { params: { color: o.color ?? 0x1f6b34, wear: 0.6 } });
  const trimMat = b.mat('metal/chrome');

  const loco = new THREE.Group();
  const boiler = new THREE.Mesh(G.cylinderMeters(0.09, 0.09, 0.36, 14), bodyMat);
  boiler.rotation.x = Math.PI / 2;
  boiler.position.set(0, 0.13, 0.05);
  loco.add(boiler);
  const cab = new THREE.Mesh(G.boxMeters(0.20, 0.17, 0.18, { radius: 0.02, seg: 2 }), bodyMat);
  cab.position.set(0, 0.16, -0.20);
  loco.add(cab);
  const funnel = new THREE.Mesh(G.cylinderMeters(0.045, 0.035, 0.12, 10), trimMat);
  funnel.position.set(0, 0.26, 0.18);
  loco.add(funnel);
  const base = new THREE.Mesh(G.boxMeters(0.22, 0.05, 0.62, { radius: 0.008, seg: 2 }), trimMat);
  base.position.set(0, 0.05, 0);
  loco.add(base);
  for (const [wx, wz, wr] of [[0.11, 0.16, 0.055], [-0.11, 0.16, 0.055], [0.11, -0.14, 0.075], [-0.11, -0.14, 0.075]]) {
    const wheel = new THREE.Mesh(G.cylinderMeters(wr, wr, 0.022, 12), trimMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, wr, wz);
    loco.add(wheel);
  }
  group.add(loco);

  for (let i = 1; i <= (o.wagons ?? 2); i++) {
    const wag = new THREE.Group();
    const tub = new THREE.Mesh(G.boxMeters(0.22, 0.14, 0.36, { radius: 0.015, seg: 2 }), bodyMat);
    tub.position.set(0, 0.14, 0);
    wag.add(tub);
    const wbase = new THREE.Mesh(G.boxMeters(0.24, 0.04, 0.40, { radius: 0.006, seg: 1 }), trimMat);
    wbase.position.set(0, 0.05, 0);
    wag.add(wbase);
    for (const [wx, wz] of [[0.12, 0.12], [-0.12, 0.12], [0.12, -0.12], [-0.12, -0.12]]) {
      const wheel = new THREE.Mesh(G.cylinderMeters(0.05, 0.05, 0.02, 10), trimMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, 0.05, wz);
      wag.add(wheel);
    }
    wag.position.z = -0.52 * i;
    group.add(wag);
  }
  group.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.userData.noCollision = true; } });
  group.position.copy(world[0]);

  b.addObject(group, { animated: true });

  let body = null;
  if (o.kinematic !== false) {
    body = new RigidBody({
      collider: makeBox(0.13, 0.14, 0.80, new THREE.Vector3(0, 0, -0.5)),
      mass: 0,
      kinematic: true,
      position: [world[0].x, world[0].y + 0.18, world[0].z],
      layer: Layer.PROP,
      mask: Layer.CAR | Layer.PROP | Layer.PROJECTILE,
      friction: 0.55,
      restitution: 0.25,
      allowSleep: false,
      name: 'train',
    });
    body.userData = { kind: 'train', propId: ++_propId, id: _propId, prop: true, track: true };
  }

  const fixture = b.propRuntime.tracked(group, {
    points: world.map((p) => [p.x, p.y, p.z]),
    speed: o.speed ?? 1.6,
    loop: closed,
    body,
    bodyLift: 0.18,
  });
  return { group, fixture, body };
}

/**
 * A garden sprinkler. Bakes a damp arc into the track (surface 9) and animates
 * the head plus a translucent water fan. Returns `{ group, fixture, zone }`.
 */
export function buildSprinkler(b, o = {}) {
  const pos = xyz(o.position, [0, 0, 0]);
  const group = new THREE.Group();
  group.position.set(pos[0], pos[1], pos[2]);
  const metal = b.mat('metal/galvanised');

  const spike = new THREE.Mesh(G.cylinderMeters(0.018, 0.03, 0.12, 8), metal);
  spike.position.y = 0.06;
  spike.userData.noCollision = true;
  group.add(spike);
  const bodyMesh = new THREE.Mesh(G.cylinderMeters(0.05, 0.06, 0.09, 12), metal);
  bodyMesh.position.y = 0.16;
  bodyMesh.userData.noCollision = true;
  group.add(bodyMesh);

  const head = new THREE.Group();
  head.position.y = 0.21;
  const arm = new THREE.Mesh(G.boxMeters(0.02, 0.02, 0.14), metal);
  arm.position.set(0, 0, 0.06);
  arm.userData.noCollision = true;
  head.add(arm);
  const nozzle = new THREE.Mesh(G.cylinderMeters(0.012, 0.02, 0.05, 8), metal);
  nozzle.rotation.x = -1.1;
  nozzle.position.set(0, 0.02, 0.13);
  nozzle.userData.noCollision = true;
  head.add(nozzle);
  group.add(head);

  // Water fan: a translucent, additive cone of "spray".
  const radius = o.radius ?? 3.0;
  const sweep = o.sweep ?? Math.PI * 0.8;
  const fanGeo = G.discXZ(radius, 22, { thetaStart: -sweep * 0.5, thetaLength: sweep });
  const fanMat = new THREE.MeshBasicMaterial({
    color: 0xcdeaf2, transparent: true, opacity: 0.22, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: true,
  });
  b._ownedMat.push(fanMat);
  const fan = new THREE.Mesh(fanGeo, fanMat);
  fan.position.y = 0.05;
  fan.rotation.x = 0;
  fan.renderOrder = 4;
  fan.userData.noCollision = true;
  fan.frustumCulled = false;
  group.add(fan);

  b.addObject(group, { animated: true });

  // The damp arc: baked as surface 9 so grip really drops, plus a visible
  // darker patch.
  if (o.wetPatch !== false) {
    b.patch({
      center: [pos[0], pos[1] + 0.004, pos[2]],
      radius: radius * 0.92,
      innerRadius: 0.25,
      ring: true,
      segments: 40,
      material: o.wetMaterial ?? 'water/shallow',
      surfaceId: SurfaceId.WATER,
      rotation: o.rotation ?? 0,
      thetaStart: -sweep * 0.5,
      thetaLength: sweep,
      order: 1,
    });
  }

  b.gripZone({
    id: o.id ?? 'sprinkler',
    center: [pos[0], pos[1], pos[2]],
    radius: radius * 0.92,
    innerRadius: 0.2,
    gripScale: o.gripScale ?? 0.45,
    surfaceId: SurfaceId.WATER,
  });
  const zone = b.surfaceZones[b.surfaceZones.length - 1];

  const fixture = b.propRuntime.sprinkler(group, {
    head, fan, sweep, period: o.period ?? 4.4, zone, center: o.rotation ?? 0,
  });
  return { group, fixture, zone, fan };
}

export {
  Fixture, CustomFixture, SpinFixture, PendulumFixture,
  TrackedFixture, SprinklerFixture, FlagFixture,
};
export default PROPS;
