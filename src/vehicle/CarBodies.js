/**
 * RC RUMBLE — 100 % procedural car geometry.
 *
 * Eight bespoke silhouettes, no assets, no imports of anything but three.
 *
 *   pebble      stubby rookie buggy — fat knobbly tyres, roll hoop, exposed tub
 *   toyeca      die-cast saloon      — greenhouse, chrome bumpers, mirrors
 *   openwheel   formula toy          — needle nose, exposed wheels, huge wing
 *   monster     monster truck        — enormous tyres, ladder chassis, light bar
 *   lowrider    slammed cruiser      — long bonnet, fins, wire wheels, pipes
 *   van         panel van            — tall box, big glass, roof rack
 *   wedge       prototype doorstop   — one straight wedge line, canopy, big wing
 *   speedster   clear-shell racer    — translucent tub, visible battery & motor
 *
 * How the shapes are made
 * -----------------------
 * The workhorse is `stationGeometry()`: a **loft** through a series of
 * cross-sections along −Z. Each section is a *superellipse* (a "squircle") with
 * independent half-width, height above and below its centreline, and a
 * `boxiness` exponent — p = 2 is an ellipse, p = 4 a squircle, p = 8 nearly a
 * box. Varying those six numbers down the length of the car is enough to get a
 * genuinely different, correctly-bevelled silhouette out of every shape, and
 * because it is a real loft the normals are smooth and it reads as moulded
 * plastic rather than as a pile of boxes.
 *
 * Tubular parts (bumpers, roll cages, exhausts, wing struts, mirror stalks)
 * are swept `TubeGeometry` along Catmull-Rom curves. Wheels are a revolved
 * tyre cross-section with **real tread-block geometry** modulated per lateral
 * band, plus a merged rim with spokes and a hub.
 *
 * Everything for one car *type* is merged into a handful of geometries — one
 * per material bucket — and cached on `game.assets`, so eight cars on the grid
 * cost about ten draw calls each, and re-loading a race rebuilds nothing.
 *
 * The antenna
 * -----------
 * The single most iconic Re-Volt visual. `AntennaChain` is a 4-segment verlet
 * chain solved in the *chassis frame*, driven by the full rotating-frame pseudo
 * force (linear acceleration + centrifugal + Euler + Coriolis) with an angular
 * spring pulling it back to straight. Spin the car and the antenna lashes
 * outward; land a jump and it snaps. It costs almost nothing.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, clamp01, lerp, TAU } from '../core/MathUtils.js';
import { getMaterials } from '../render/Materials.js';

// ═══════════════════════════════════════════════════════════════════════════
// Geometry toolkit
// ═══════════════════════════════════════════════════════════════════════════

const _m4 = new THREE.Matrix4();
const _m4b = new THREE.Matrix4();
const _e = new THREE.Euler();

/**
 * A superelliptic cross-section in the XY plane, as a closed CCW loop.
 * @param {number} n point count (multiple of 4 looks best)
 * @param {number} hw half width
 * @param {number} hTop half height above `cy`
 * @param {number} hBot half height below `cy`
 * @param {number} cy section centreline
 * @param {number} p boxiness (2 = ellipse, 4 = squircle, 8 ≈ box)
 * @param {number} tuck 0..1 how much the bottom half narrows
 * @param {Float32Array} [out]
 */
export function superSection(n, hw, hTop, hBot, cy, p, tuck = 0, out) {
  const pts = out && out.length === n * 2 ? out : new Float32Array(n * 2);
  const e = 2 / Math.max(1.05, p);
  for (let i = 0; i < n; i++) {
    const th = (i / n) * TAU;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const ac = Math.abs(c);
    const as = Math.abs(s);
    let x = hw * (c < 0 ? -1 : 1) * Math.pow(ac, e);
    const hh = s >= 0 ? hTop : hBot;
    const y = cy + hh * (s < 0 ? -1 : 1) * Math.pow(as, e);
    if (s < 0 && tuck > 0) x *= 1 - tuck * as;
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
  }
  return pts;
}

/**
 * Loft a tube through a list of stations.
 * @param {Array<{z:number, hw:number, hTop:number, hBot:number, cy?:number,
 *                p?:number, tuck?:number}>} stations ordered front (−Z) → rear
 * @param {{n?:number, cap?:boolean, uvScale?:number}} [opts]
 * @returns {THREE.BufferGeometry}
 */
export function stationGeometry(stations, opts = {}) {
  const n = opts.n ?? 20;
  const cap = opts.cap !== false;
  const S = stations.length;
  const sections = new Array(S);
  for (let i = 0; i < S; i++) {
    const st = stations[i];
    sections[i] = superSection(n, st.hw, st.hTop, st.hBot, st.cy ?? 0, st.p ?? 4, st.tuck ?? 0);
  }

  const ringVerts = S * n;
  const capVerts = cap ? 2 * (n + 1) : 0;
  const positions = new Float32Array((ringVerts + capVerts) * 3);
  const uvs = new Float32Array((ringVerts + capVerts) * 2);
  const indices = [];

  for (let i = 0; i < S; i++) {
    const sec = sections[i];
    const z = stations[i].z;
    const v = S > 1 ? i / (S - 1) : 0;
    for (let j = 0; j < n; j++) {
      const o = (i * n + j) * 3;
      positions[o] = sec[j * 2];
      positions[o + 1] = sec[j * 2 + 1];
      positions[o + 2] = z;
      const u = (i * n + j) * 2;
      uvs[u] = j / n;
      uvs[u + 1] = v;
    }
  }
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      const a = i * n + j;
      const bIdx = i * n + j2;
      const c = (i + 1) * n + j2;
      const d = (i + 1) * n + j;
      indices.push(a, bIdx, c, a, c, d);
    }
  }

  if (cap) {
    // Front cap (−Z end): fan to the centroid, wound so it faces −Z.
    let base = ringVerts;
    for (let end = 0; end < 2; end++) {
      const si = end === 0 ? 0 : S - 1;
      const sec = sections[si];
      const z = stations[si].z;
      let cxs = 0, cys = 0;
      for (let j = 0; j < n; j++) { cxs += sec[j * 2]; cys += sec[j * 2 + 1]; }
      cxs /= n; cys /= n;
      const centre = base;
      positions[centre * 3] = cxs;
      positions[centre * 3 + 1] = cys;
      positions[centre * 3 + 2] = z;
      uvs[centre * 2] = 0.5; uvs[centre * 2 + 1] = 0.5;
      for (let j = 0; j < n; j++) {
        const idx = base + 1 + j;
        positions[idx * 3] = sec[j * 2];
        positions[idx * 3 + 1] = sec[j * 2 + 1];
        positions[idx * 3 + 2] = z;
        uvs[idx * 2] = 0.5 + 0.5 * Math.cos((j / n) * TAU);
        uvs[idx * 2 + 1] = 0.5 + 0.5 * Math.sin((j / n) * TAU);
      }
      for (let j = 0; j < n; j++) {
        const a = base + 1 + j;
        const bIdx = base + 1 + ((j + 1) % n);
        if (end === 0) indices.push(centre, bIdx, a);
        else indices.push(centre, a, bIdx);
      }
      base += n + 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Convenience: a bevelled box built as a 4-station loft. Rounded on every edge.
 */
export function roundBox(w, h, d, round = 0.3, n = 16, p = 6) {
  const hw = w * 0.5, hh = h * 0.5, hd = d * 0.5;
  const r = clamp(round, 0, 0.9);
  const inset = Math.min(hw, hh) * r;
  const cap = Math.min(hd * 0.45, inset);
  const s = (hw - inset) / hw;
  const sh = (hh - inset) / hh;
  return stationGeometry([
    { z: -hd, hw: hw * s, hTop: hh * sh, hBot: hh * sh, p },
    { z: -hd + cap, hw, hTop: hh, hBot: hh, p },
    { z: hd - cap, hw, hTop: hh, hBot: hh, p },
    { z: hd, hw: hw * s, hTop: hh * sh, hBot: hh * sh, p },
  ], { n });
}

/**
 * Revolve a cross-section around the X axis. Used for tyres.
 * @param {Float32Array} prof pairs of (w, r) forming a CLOSED loop
 * @param {Uint8Array} tread 1 where the point sits on the tread face
 * @param {number} segs radial segments
 * @param {(theta:number, w:number, band:number)=>number} mod radial offset
 */
export function revolveX(prof, tread, segs, mod) {
  const m = prof.length / 2;
  const positions = new Float32Array(segs * m * 3);
  const uvs = new Float32Array(segs * m * 2);
  const indices = [];
  for (let k = 0; k < segs; k++) {
    const th = (k / segs) * TAU;
    const ct = Math.cos(th), st = Math.sin(th);
    for (let j = 0; j < m; j++) {
      const w = prof[j * 2];
      let r = prof[j * 2 + 1];
      if (tread[j]) r += mod(th, w, j);
      const o = (k * m + j) * 3;
      positions[o] = w;
      positions[o + 1] = r * ct;
      positions[o + 2] = r * st;
      const u = (k * m + j) * 2;
      uvs[u] = k / segs * 4;
      uvs[u + 1] = j / m;
    }
  }
  for (let k = 0; k < segs; k++) {
    const k2 = (k + 1) % segs;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const a = k * m + j;
      const b = k * m + j2;
      const c = k2 * m + j2;
      const d = k2 * m + j;
      indices.push(a, b, c, a, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** A swept tube through a list of [x,y,z] points. */
export function tube(points, radius, tubeSegs = 7, pathSegs = null, closed = false) {
  const pts = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'catmullrom', 0.4);
  const seg = pathSegs ?? Math.max(6, points.length * 5);
  return new THREE.TubeGeometry(curve, seg, radius, tubeSegs, closed);
}

/** Normalise a geometry so it can always be merged with its siblings. */
function normalizeGeo(geo) {
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) {
    const count = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!geo.index) {
    const count = geo.attributes.position.count;
    const idx = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  geo.morphAttributes = {};
  geo.clearGroups();
  return geo;
}

// ═══════════════════════════════════════════════════════════════════════════
// Part builder — accumulates geometry per material bucket, then merges.
// ═══════════════════════════════════════════════════════════════════════════

class PartBuilder {
  constructor() {
    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this.buckets = new Map();
  }

  /**
   * @param {string} key material bucket
   * @param {THREE.BufferGeometry} geo consumed (transformed in place)
   * @param {{pos?:number[], rot?:number[], scale?:number|number[], mirrorX?:boolean}} [t]
   */
  add(key, geo, t) {
    if (!geo) return this;
    if (t) {
      _m4.identity();
      if (t.rot) { _e.set(t.rot[0] || 0, t.rot[1] || 0, t.rot[2] || 0); _m4.makeRotationFromEuler(_e); }
      if (t.scale !== undefined) {
        const s = t.scale;
        _m4b.makeScale(
          Array.isArray(s) ? s[0] : s,
          Array.isArray(s) ? s[1] : s,
          Array.isArray(s) ? s[2] : s,
        );
        _m4.multiply(_m4b);
      }
      if (t.pos) _m4.setPosition(t.pos[0] || 0, t.pos[1] || 0, t.pos[2] || 0);
      geo.applyMatrix4(_m4);
    }
    let list = this.buckets.get(key);
    if (!list) { list = []; this.buckets.set(key, list); }
    list.push(normalizeGeo(geo));
    return this;
  }

  /** Add a part and its mirror image across X. */
  addPair(key, factory, t) {
    this.add(key, factory(), t);
    const t2 = { ...t };
    t2.pos = t?.pos ? [-(t.pos[0] || 0), t.pos[1] || 0, t.pos[2] || 0] : undefined;
    if (t?.rot) t2.rot = [t.rot[0] || 0, -(t.rot[1] || 0), -(t.rot[2] || 0)];
    this.add(key, factory(), t2);
    return this;
  }

  /** Merge every bucket. @returns {Object<string, THREE.BufferGeometry>} */
  build() {
    const out = {};
    for (const [key, list] of this.buckets) {
      if (list.length === 0) continue;
      if (list.length === 1) { out[key] = list[0]; continue; }
      let merged = null;
      try { merged = mergeGeometries(list, false); } catch { merged = null; }
      if (merged) {
        out[key] = merged;
        for (const g of list) g.dispose();
      } else {
        // Extremely unlikely; keep the first and drop the rest rather than throw.
        out[key] = list[0];
        for (let i = 1; i < list.length; i++) list[i].dispose();
      }
    }
    return out;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared parts
// ═══════════════════════════════════════════════════════════════════════════

/** A wrap-around tubular bumper. */
function addBumper(b, key, { z, y, halfW, radius = 0.0055, wrap = 0.024, drop = 0.004, sag = 0 }) {
  const s = Math.sign(z) || 1;
  b.add(key, tube([
    [-halfW * 0.86, y - drop, z - s * wrap],
    [-halfW, y, z],
    [-halfW * 0.5, y + sag, z + s * 0.002],
    [0, y + sag * 1.2, z + s * 0.003],
    [halfW * 0.5, y + sag, z + s * 0.002],
    [halfW, y, z],
    [halfW * 0.86, y - drop, z - s * wrap],
  ], radius, 7));
}

/** A headlight or tail-light lens with a chrome bezel. */
function addLamp(b, lensKey, { x, y, z, r, depth = 0.006, bezel = true, flat = false, dir = null }) {
  const face = dir ?? (z > 0 ? 1 : -1);
  const lens = flat
    ? new THREE.CylinderGeometry(r, r * 0.94, depth, 12, 1)
    : new THREE.SphereGeometry(r, 12, 8, 0, TAU, 0, Math.PI * 0.5);
  if (flat) b.add(lensKey, lens, { pos: [x, y, z], rot: [Math.PI * 0.5, 0, 0] });
  else b.add(lensKey, lens, { pos: [x, y, z], rot: [face < 0 ? -Math.PI * 0.5 : Math.PI * 0.5, 0, 0] });
  if (bezel) {
    b.add('chrome', new THREE.TorusGeometry(r * 1.06, r * 0.16, 6, 14), { pos: [x, y, z] });
  }
}

/** A rectangular light panel (modern brake bar). */
function addLightBarPanel(b, key, { x, y, z, w, h, d = 0.005 }) {
  b.add(key, roundBox(w, h, d, 0.4, 12, 5), { pos: [x, y, z] });
}

/** Wing mirror: stalk + housing. */
function addMirror(b, { x, y, z, out = 0.016, up = 0.008 }) {
  const s = Math.sign(x) || 1;
  b.add('chrome', tube([
    [x, y, z],
    [x + s * out * 0.6, y + up * 0.6, z - 0.002],
    [x + s * out, y + up, z - 0.004],
  ], 0.0022, 6));
  b.add('paintB', roundBox(0.009, 0.010, 0.005, 0.5, 12, 4), {
    pos: [x + s * out, y + up + 0.004, z - 0.005], rot: [0, s * 0.28, 0],
  });
  b.add('glass', roundBox(0.0072, 0.0082, 0.001, 0.5, 10, 4), {
    pos: [x + s * out * 1.02, y + up + 0.004, z - 0.0078], rot: [0, s * 0.28, 0],
  });
}

/** Rear wing: plane + endplates + struts. */
function addWing(b, { z, y, halfW, chord, thick = 0.0035, aoa = -0.16, endplate = 0.012, strut = null, mat = 'paintB' }) {
  // The blade is a thin loft so it has a real aerofoil-ish bevel.
  const blade = stationGeometry([
    { z: -chord * 0.5, hw: halfW, hTop: thick * 0.55, hBot: thick * 0.35, p: 2.4 },
    { z: -chord * 0.12, hw: halfW, hTop: thick, hBot: thick * 0.6, p: 3.0 },
    { z: chord * 0.32, hw: halfW, hTop: thick * 0.8, hBot: thick * 0.5, p: 3.0 },
    { z: chord * 0.5, hw: halfW * 0.995, hTop: thick * 0.3, hBot: thick * 0.22, p: 2.2 },
  ], { n: 14 });
  // The loft already runs span-on-X / chord-on-Z, so it needs no reorientation.
  b.add(mat, blade, { pos: [0, y, z], rot: [aoa, 0, 0] });

  if (endplate > 0) {
    for (let s = -1; s <= 1; s += 2) {
      b.add(mat, roundBox(0.0032, endplate, chord * 1.15, 0.35, 10, 5),
        { pos: [s * halfW, y + endplate * 0.16, z] });
    }
  }
  if (strut) {
    for (let s = -1; s <= 1; s += 2) {
      b.add('chrome', tube([
        [s * strut.x, strut.y0, strut.z0],
        [s * strut.x, (strut.y0 + y) * 0.5, (strut.z0 + z) * 0.5],
        [s * strut.x, y - thick, z],
      ], 0.0026, 6));
    }
  }
}

/** Visible battery pack with terminals and a strap. */
function addBattery(b, { x = 0, y, z, w = 0.048, h = 0.020, d = 0.030 }) {
  b.add('battery', roundBox(w, h, d, 0.18, 12, 7), { pos: [x, y, z] });
  // Terminals.
  for (let s = -1; s <= 1; s += 2) {
    b.add('chrome', new THREE.CylinderGeometry(0.0026, 0.0026, 0.006, 8),
      { pos: [x + s * w * 0.26, y + h * 0.5 + 0.002, z - d * 0.28] });
  }
  // Retaining strap.
  b.add('dark', roundBox(w * 1.06, 0.0022, 0.006, 0.3, 8, 6), { pos: [x, y + h * 0.5 + 0.001, z] });
  // Wiring loom.
  b.add('dark', tube([
    [x - w * 0.26, y + h * 0.5 + 0.004, z - d * 0.28],
    [x - w * 0.1, y + h * 0.5 + 0.010, z - d * 0.10],
    [x + w * 0.12, y + h * 0.5 + 0.008, z + d * 0.16],
  ], 0.0016, 5));
}

/** Electric motor + pinion, for the cars that show their guts. */
function addMotor(b, { x = 0, y, z, r = 0.013, len = 0.030 }) {
  const can = new THREE.CylinderGeometry(r, r, len, 14, 1);
  b.add('dark', can, { pos: [x, y, z], rot: [0, 0, Math.PI * 0.5] });
  b.add('chrome', new THREE.CylinderGeometry(r * 0.36, r * 0.36, len * 0.18, 10),
    { pos: [x + len * 0.56, y, z], rot: [0, 0, Math.PI * 0.5] });
  b.add('accent', new THREE.TorusGeometry(r * 1.02, r * 0.10, 6, 16),
    { pos: [x - len * 0.22, y, z], rot: [0, Math.PI * 0.5, 0] });
}

/** A seated driver: helmet, visor, shoulders, and (optionally) arms. */
function addDriver(b, { y, z, scale = 1, arms = true, wheel = null }) {
  const hr = 0.017 * scale;
  b.add('driver', new THREE.SphereGeometry(hr, 14, 10), { pos: [0, y + hr * 1.15, z] });
  // Visor band.
  b.add('glass', new THREE.SphereGeometry(hr * 1.015, 14, 8, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.34, Math.PI * 0.26),
    { pos: [0, y + hr * 1.15, z], rot: [0, -Math.PI * 0.5, 0] });
  // Shoulders / torso.
  b.add('paintB', roundBox(0.036 * scale, 0.020 * scale, 0.024 * scale, 0.55, 12, 3),
    { pos: [0, y - 0.001, z + 0.008 * scale] });
  if (arms) {
    for (let s = -1; s <= 1; s += 2) {
      b.add('driver', tube([
        [s * 0.016 * scale, y + 0.002, z + 0.004 * scale],
        [s * 0.014 * scale, y + 0.000, z - 0.010 * scale],
        [s * 0.008 * scale, y - 0.002, z - 0.019 * scale],
      ], 0.0035 * scale, 6));
    }
  }
  if (wheel) {
    b.add('dark', new THREE.TorusGeometry(wheel.r, wheel.r * 0.22, 6, 16),
      { pos: [0, wheel.y, wheel.z], rot: [wheel.tilt ?? -0.5, 0, 0] });
  }
}

/** Tubular roll hoop / cage. */
function addRollBar(b, { halfW, y0, y1, z, back = 0.02, radius = 0.0032, brace = true }) {
  b.add('chrome', tube([
    [-halfW, y0, z],
    [-halfW * 0.98, y1 * 0.72, z - 0.001],
    [-halfW * 0.7, y1, z - 0.002],
    [0, y1 * 1.03, z - 0.003],
    [halfW * 0.7, y1, z - 0.002],
    [halfW * 0.98, y1 * 0.72, z - 0.001],
    [halfW, y0, z],
  ], radius, 6));
  if (brace) {
    for (let s = -1; s <= 1; s += 2) {
      b.add('chrome', tube([
        [s * halfW * 0.86, y1 * 0.92, z - 0.002],
        [s * halfW * 0.7, y1 * 0.5, z + back * 0.6],
        [s * halfW * 0.6, y0, z + back],
      ], radius * 0.85, 6));
    }
  }
}

/** Exhaust pipe(s). */
function addExhaust(b, { x, y, z, len = 0.03, r = 0.0035, splay = 0.1 }) {
  const s = Math.sign(x) || 1;
  b.add('chrome', tube([
    [x, y, z - len],
    [x + s * splay * 0.3, y + 0.001, z - len * 0.3],
    [x + s * splay, y + 0.002, z],
  ], r, 8));
  b.add('dark', new THREE.CylinderGeometry(r * 1.15, r * 1.15, 0.003, 10),
    { pos: [x + s * splay, y + 0.002, z + 0.0015], rot: [Math.PI * 0.5, 0, 0] });
}

/** A flat quad for the racing-number decal, facing +Y. */
function numberPlate(w, h) {
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  g.rotateX(-Math.PI * 0.5);
  return g;
}

/** Under-body floor pan — reads as a chassis plate from low camera angles. */
function addFloor(b, { y, halfW, zFront, zRear }) {
  b.add('dark', roundBox(halfW * 2, 0.0035, zRear - zFront, 0.12, 10, 8),
    { pos: [0, y, (zFront + zRear) * 0.5] });
}

// ═══════════════════════════════════════════════════════════════════════════
// Wheels
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A tyre cross-section: bead → sidewall bulge → shoulder → tread face → back.
 * Returns `{ prof, tread }` where `prof` is (w, r) pairs on a closed loop.
 */
function tyreProfile(radius, halfW, rimR, style) {
  const bulge = style === 'monster' || style === 'knobby' ? 1.10 : 1.03;
  const shoulder = style === 'slick' ? 0.10 : 0.17;
  const faceW = halfW * (style === 'slick' ? 0.90 : 0.80);
  const midR = lerp(rimR, radius, 0.62);
  const pts = [
    // outer side, from the bead outward
    [halfW * 0.52, rimR, 0],
    [halfW * 0.86, lerp(rimR, midR, 0.55), 0],
    [halfW * bulge, midR, 0],
    [halfW * 0.99, lerp(midR, radius, 0.72), 0],
    [faceW, radius - radius * shoulder * 0.10, 1],
    // tread face
    [faceW * 0.55, radius, 1],
    [0, radius, 1],
    [-faceW * 0.55, radius, 1],
    [-faceW, radius - radius * shoulder * 0.10, 1],
    // inner side back to the bead
    [-halfW * 0.99, lerp(midR, radius, 0.72), 0],
    [-halfW * bulge, midR, 0],
    [-halfW * 0.86, lerp(rimR, midR, 0.55), 0],
    [-halfW * 0.52, rimR, 0],
    // inner bead face
    [-halfW * 0.50, rimR * 0.93, 0],
    [halfW * 0.50, rimR * 0.93, 0],
  ];
  const prof = new Float32Array(pts.length * 2);
  const tread = new Uint8Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    prof[i * 2] = pts[i][0];
    prof[i * 2 + 1] = pts[i][1];
    tread[i] = pts[i][2];
  }
  return { prof, tread };
}

/** Style → tread parameters. */
const TREAD = {
  knobby: { blocks: 11, depth: 0.055, bands: 3, phase: 0.5, centreGroove: 0.0, sharp: 0.55 },
  monster: { blocks: 9, depth: 0.085, bands: 3, phase: 0.5, centreGroove: 0.0, sharp: 0.42 },
  street: { blocks: 22, depth: 0.026, bands: 4, phase: 0.25, centreGroove: 0.030, sharp: 0.72 },
  slick: { blocks: 30, depth: 0.011, bands: 2, phase: 0.5, centreGroove: 0.016, sharp: 0.85 },
  wire: { blocks: 20, depth: 0.022, bands: 4, phase: 0.25, centreGroove: 0.026, sharp: 0.75 },
};

/**
 * @param {number} radius
 * @param {number} width full width
 * @param {'knobby'|'monster'|'street'|'slick'|'wire'} style
 * @param {number} quality 0..1 → segment count
 */
export function buildWheelParts(radius, width, style = 'street', quality = 1) {
  const halfW = width * 0.5;
  const rimR = radius * (style === 'monster' ? 0.52 : style === 'wire' ? 0.66 : 0.60);
  const segs = Math.round(lerp(20, 34, clamp01(quality)));
  const { prof, tread } = tyreProfile(radius, halfW, rimR, style);
  const T = TREAD[style] ?? TREAD.street;
  const depth = radius * T.depth;

  const tyre = revolveX(prof, tread, segs, (theta, w) => {
    // Lateral band index → phase-shifted block pattern (a real tread pattern).
    const band = Math.floor(clamp01((w / halfW + 1) * 0.5) * T.bands);
    const a = (theta / TAU) * T.blocks + band * T.phase;
    const frac = a - Math.floor(a);
    // Smooth square wave: 1 on the block, 0 in the groove.
    const edge = T.sharp * 0.5;
    const block = clamp01(frac / edge) * clamp01((1 - frac) / edge);
    let d = -depth * (1 - Math.min(1, block));
    if (T.centreGroove > 0 && Math.abs(w) < halfW * 0.10) d = -radius * T.centreGroove;
    return d;
  });

  // ── rim: barrel + face + spokes + hub ──
  const parts = [];
  const barrel = new THREE.CylinderGeometry(rimR, rimR, halfW * 1.44, segs, 1, true);
  barrel.rotateZ(Math.PI * 0.5);
  parts.push(normalizeGeo(barrel));

  const faceOff = halfW * 0.60;
  if (style === 'wire') {
    // Wire wheel: many thin spokes to a small hub.
    const spokes = 20;
    for (let i = 0; i < spokes; i++) {
      const th = (i / spokes) * TAU;
      const g = new THREE.CylinderGeometry(0.0009, 0.0009, rimR * 0.94, 4, 1);
      _m4.makeRotationZ(th);
      g.translate(0, rimR * 0.47, 0);
      g.applyMatrix4(_m4);
      g.translate(faceOff * (i % 2 ? 1 : 0.55), 0, 0);
      parts.push(normalizeGeo(g));
    }
    const ring = new THREE.TorusGeometry(rimR * 0.97, rimR * 0.05, 6, segs);
    ring.rotateY(Math.PI * 0.5);
    ring.translate(faceOff, 0, 0);
    parts.push(normalizeGeo(ring));
  } else {
    const spokes = style === 'monster' ? 6 : style === 'slick' ? 5 : 5;
    const sw = rimR * (style === 'monster' ? 0.30 : 0.24);
    for (let i = 0; i < spokes; i++) {
      const th = (i / spokes) * TAU;
      const g = roundBox(sw, rimR * 0.90, halfW * 0.34, 0.4, 10, 5);
      g.translate(0, rimR * 0.45, 0);
      _m4.makeRotationZ(th);
      g.applyMatrix4(_m4);
      g.translate(faceOff * 0.55, 0, 0);
      parts.push(normalizeGeo(g));
    }
    const dish = new THREE.CylinderGeometry(rimR * 0.99, rimR * 0.93, halfW * 0.10, segs, 1);
    dish.rotateZ(Math.PI * 0.5);
    dish.translate(faceOff, 0, 0);
    parts.push(normalizeGeo(dish));
  }
  // Hub + nut.
  const hub = new THREE.CylinderGeometry(rimR * 0.30, rimR * 0.26, halfW * 1.0, 12, 1);
  hub.rotateZ(Math.PI * 0.5);
  hub.translate(faceOff * 0.25, 0, 0);
  parts.push(normalizeGeo(hub));
  const nut = new THREE.CylinderGeometry(rimR * 0.13, rimR * 0.13, halfW * 0.24, 6, 1);
  nut.rotateZ(Math.PI * 0.5);
  nut.translate(faceOff * 1.12, 0, 0);
  parts.push(normalizeGeo(nut));

  let rim = null;
  try { rim = mergeGeometries(parts, false); } catch { rim = null; }
  if (!rim) rim = parts[0];
  else for (const g of parts) g.dispose();

  return { tyre, rim, rimRadius: rimR };
}

// ═══════════════════════════════════════════════════════════════════════════
// Antenna — verlet chain in the chassis frame
// ═══════════════════════════════════════════════════════════════════════════

const _aTmp = new THREE.Vector3();
const _aTmp2 = new THREE.Vector3();
const _aQ = new THREE.Quaternion();
const _aQi = new THREE.Quaternion();
const _AXIS_Y = new THREE.Vector3(0, 1, 0);
const _WORLD_G = new THREE.Vector3(0, -19.6, 0);

/**
 * A springy 4-segment antenna with a ball on top.
 *
 * Solved in the CHASSIS frame, so the whole rotating-frame pseudo force is
 * available and the antenna reacts to yaw spin, landings and hard cornering
 * exactly the way the real toy does. Points are relative to the antenna base.
 */
export class AntennaChain {
  /**
   * @param {number} segCount
   * @param {number} segLen
   * @param {{lean?:number, stiffness?:number, damping?:number,
   *          accelGain?:number, gravityGain?:number}} [opts]
   */
  constructor(segCount, segLen, opts = {}) {
    this.n = segCount;
    this.segLen = segLen;
    this.lean = opts.lean ?? 0.16;          // rad, backward rake at rest
    this.stiffness = opts.stiffness ?? 780; // 1/s² angular spring
    this.damping = opts.damping ?? 3.1;     // 1/s velocity damping
    this.accelGain = opts.accelGain ?? 1.25;
    this.gravityGain = opts.gravityGain ?? 0.14;
    this.maxTilt = opts.maxTilt ?? 1.15;    // rad from the rest direction

    const N = segCount + 1;
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.rest = new Float32Array(N * 3);
    this._prevOmega = new THREE.Vector3();
    this._acc = 0;
    this.reset();
  }

  reset() {
    const sl = this.segLen;
    const c = Math.cos(this.lean), s = Math.sin(this.lean);
    for (let i = 0; i <= this.n; i++) {
      const o = i * 3;
      this.rest[o] = 0;
      this.rest[o + 1] = i * sl * c;
      this.rest[o + 2] = i * sl * s;
      this.pos[o] = this.rest[o];
      this.pos[o + 1] = this.rest[o + 1];
      this.pos[o + 2] = this.rest[o + 2];
      this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
    }
    this._prevOmega.set(0, 0, 0);
    this._acc = 0;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} accelWorld chassis linear acceleration (m/s²)
   * @param {THREE.Vector3} omegaWorld chassis angular velocity (rad/s)
   * @param {THREE.Quaternion} quat chassis orientation
   * @param {THREE.Vector3} basePos antenna base in chassis space
   */
  update(dt, accelWorld, omegaWorld, quat, basePos) {
    if (!(dt > 0)) return;
    // Pseudo-force = gravity − linear acceleration, in the chassis frame.
    _aQi.copy(quat).invert();
    _aTmp.copy(_WORLD_G).sub(accelWorld).applyQuaternion(_aQi);
    const gx = _aTmp.x * this.gravityGain;
    const gy = _aTmp.y * this.gravityGain;
    const gz = _aTmp.z * this.gravityGain;
    // The accel term gets its own (larger) gain so the whip reads.
    _aTmp2.copy(accelWorld).applyQuaternion(_aQi).multiplyScalar(-this.accelGain);
    const ax = _aTmp2.x, ay = _aTmp2.y, az = _aTmp2.z;

    // Rotating-frame terms.
    _aTmp.copy(omegaWorld).applyQuaternion(_aQi);
    const wx = _aTmp.x, wy = _aTmp.y, wz = _aTmp.z;
    const alx = (wx - this._prevOmega.x) / dt;
    const aly = (wy - this._prevOmega.y) / dt;
    const alz = (wz - this._prevOmega.z) / dt;
    this._prevOmega.set(wx, wy, wz);

    // Fixed substeps keep the stiff spring stable at any frame rate.
    const h = 1 / 180;
    this._acc = Math.min(this._acc + Math.min(dt, 0.05), h * 12);
    while (this._acc >= h) {
      this._acc -= h;
      this._step(h, gx + ax, gy + ay, gz + az, wx, wy, wz, alx, aly, alz);
    }
    void basePos;
  }

  _step(h, ax, ay, az, wx, wy, wz, alx, aly, alz) {
    const p = this.pos;
    const v = this.vel;
    const rest = this.rest;
    const n = this.n;
    const k = this.stiffness;
    const dmp = Math.exp(-this.damping * h);

    for (let i = 1; i <= n; i++) {
      const o = i * 3;
      const px = p[o], py = p[o + 1], pz = p[o + 2];

      // Angular spring: pull toward the straight continuation of the segment
      // below, blended with the absolute rest pose so it never folds over.
      const q = (i - 1) * 3;
      let dx, dy, dz;
      if (i === 1) {
        dx = rest[3] - rest[0]; dy = rest[4] - rest[1]; dz = rest[5] - rest[2];
      } else {
        const r = (i - 2) * 3;
        dx = p[q] - p[r]; dy = p[q + 1] - p[r + 1]; dz = p[q + 2] - p[r + 2];
        const l = Math.hypot(dx, dy, dz) || 1;
        dx = (dx / l) * this.segLen; dy = (dy / l) * this.segLen; dz = (dz / l) * this.segLen;
        // Blend with the absolute rest direction so the whole whip returns home.
        const rdx = rest[o] - rest[q], rdy = rest[o + 1] - rest[q + 1], rdz = rest[o + 2] - rest[q + 2];
        dx = dx * 0.68 + rdx * 0.32;
        dy = dy * 0.68 + rdy * 0.32;
        dz = dz * 0.68 + rdz * 0.32;
      }
      const tx = p[q] + dx, ty = p[q + 1] + dy, tz = p[q + 2] + dz;

      // Centrifugal: −ω × (ω × r).  Euler: −α × r.  Coriolis: −2 ω × v.
      const cx = wy * pz - wz * py;
      const cy = wz * px - wx * pz;
      const cz = wx * py - wy * px;
      const cfx = -(wy * cz - wz * cy);
      const cfy = -(wz * cx - wx * cz);
      const cfz = -(wx * cy - wy * cx);
      const eux = -(aly * pz - alz * py);
      const euy = -(alz * px - alx * pz);
      const euz = -(alx * py - aly * px);
      const cox = -2 * (wy * v[o + 2] - wz * v[o + 1]);
      const coy = -2 * (wz * v[o] - wx * v[o + 2]);
      const coz = -2 * (wx * v[o + 1] - wy * v[o]);

      v[o] = (v[o] + ((tx - px) * k + ax + cfx + eux + cox) * h) * dmp;
      v[o + 1] = (v[o + 1] + ((ty - py) * k + ay + cfy + euy + coy) * h) * dmp;
      v[o + 2] = (v[o + 2] + ((tz - pz) * k + az + cfz + euz + coz) * h) * dmp;

      p[o] = px + v[o] * h;
      p[o + 1] = py + v[o + 1] * h;
      p[o + 2] = pz + v[o + 2] * h;
    }

    // Inextensibility: two Gauss-Seidel passes from the base outward.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i <= n; i++) {
        const o = i * 3, q = (i - 1) * 3;
        let dx = p[o] - p[q], dy = p[o + 1] - p[q + 1], dz = p[o + 2] - p[q + 2];
        const l = Math.hypot(dx, dy, dz);
        if (l < 1e-9) { p[o + 1] = p[q + 1] + this.segLen; continue; }
        const f = this.segLen / l;
        p[o] = p[q] + dx * f;
        p[o + 1] = p[q + 1] + dy * f;
        p[o + 2] = p[q + 2] + dz * f;
      }
    }
  }

  /** Tip position (chassis space, relative to the base). */
  tip(out) {
    const o = this.n * 3;
    return out.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shape builders — one per car. y = 0 is the CENTRE OF MASS, −Z is forward.
// ═══════════════════════════════════════════════════════════════════════════

/** @typedef {{lower:object[], upper?:object[], n?:number}} Silhouette */

function buildPebble(b, def) {
  const floorY = -def.comHeight + 0.019;
  const lower = [
    { z: -0.126, hw: 0.046, hTop: 0.021, hBot: 0.010, cy: floorY + 0.012, p: 2.8 },
    { z: -0.106, hw: 0.068, hTop: 0.029, hBot: 0.014, cy: floorY + 0.013, p: 3.3 },
    { z: -0.064, hw: 0.086, hTop: 0.033, hBot: 0.017, cy: floorY + 0.015, p: 4.0, tuck: 0.10 },
    { z: -0.008, hw: 0.090, hTop: 0.035, hBot: 0.018, cy: floorY + 0.016, p: 4.6, tuck: 0.12 },
    { z: 0.050, hw: 0.090, hTop: 0.033, hBot: 0.018, cy: floorY + 0.016, p: 4.6, tuck: 0.12 },
    { z: 0.100, hw: 0.080, hTop: 0.026, hBot: 0.014, cy: floorY + 0.014, p: 3.6 },
    { z: 0.126, hw: 0.050, hTop: 0.018, hBot: 0.009, cy: floorY + 0.012, p: 2.8 },
  ];
  const upper = [
    { z: -0.044, hw: 0.048, hTop: 0.006, hBot: 0.032, cy: floorY + 0.040, p: 3.0 },
    { z: -0.016, hw: 0.062, hTop: 0.011, hBot: 0.036, cy: floorY + 0.042, p: 3.6 },
    { z: 0.048, hw: 0.062, hTop: 0.013, hBot: 0.036, cy: floorY + 0.042, p: 3.6 },
    { z: 0.076, hw: 0.046, hTop: 0.007, hBot: 0.030, cy: floorY + 0.038, p: 3.0 },
  ];
  b.add('paintA', stationGeometry(lower, { n: 20 }));
  b.add('paintB', stationGeometry(upper, { n: 18 }));

  const topY = floorY + 0.055;
  addRollBar(b, { halfW: 0.052, y0: floorY + 0.030, y1: topY + 0.022, z: 0.030, back: 0.030 });
  addDriver(b, { y: topY - 0.006, z: 0.006, scale: 0.92, wheel: { r: 0.011, y: topY + 0.002, z: -0.026, tilt: -0.55 } });
  addBumper(b, 'chrome', { z: -0.130, y: floorY + 0.010, halfW: 0.072, radius: 0.006, wrap: 0.022, sag: 0.001 });
  addBumper(b, 'chrome', { z: 0.132, y: floorY + 0.012, halfW: 0.070, radius: 0.006, wrap: 0.020 });
  addLamp(b, 'head', { x: -0.048, y: floorY + 0.028, z: -0.120, r: 0.0090 });
  addLamp(b, 'head', { x: 0.048, y: floorY + 0.028, z: -0.120, r: 0.0090 });
  addLightBarPanel(b, 'brake', { x: -0.052, y: floorY + 0.026, z: 0.126, w: 0.020, h: 0.010 });
  addLightBarPanel(b, 'brake', { x: 0.052, y: floorY + 0.026, z: 0.126, w: 0.020, h: 0.010 });
  addLamp(b, 'reverse', { x: 0, y: floorY + 0.020, z: 0.128, r: 0.005, flat: true });
  addBattery(b, { y: floorY + 0.014, z: 0.060, w: 0.052, h: 0.018, d: 0.030 });
  addFloor(b, { y: floorY - 0.002, halfW: 0.072, zFront: -0.100, zRear: 0.108 });
  // Mud flaps.
  for (let s = -1; s <= 1; s += 2) {
    b.add('dark', roundBox(0.026, 0.014, 0.0028, 0.25, 8, 6),
      { pos: [s * 0.058, floorY + 0.001, 0.116] });
  }
  b.add('plate', numberPlate(0.036, 0.030), { pos: [0, floorY + 0.056, 0.016] });

  return {
    antenna: { x: 0.040, y: floorY + 0.036, z: 0.086, len: 0.062, segs: 4, ballR: 0.0072 },
    wheelStyle: 'knobby',
    shellCentre: [0, 0, 0],
  };
}

function buildToyeca(b, def) {
  const floorY = -def.comHeight + 0.016;
  const lower = [
    { z: -0.148, hw: 0.052, hTop: 0.014, hBot: 0.008, cy: floorY + 0.014, p: 3.0 },
    { z: -0.132, hw: 0.072, hTop: 0.017, hBot: 0.011, cy: floorY + 0.014, p: 4.2 },
    { z: -0.092, hw: 0.086, hTop: 0.019, hBot: 0.014, cy: floorY + 0.015, p: 5.2, tuck: 0.10 },
    { z: -0.030, hw: 0.090, hTop: 0.021, hBot: 0.015, cy: floorY + 0.016, p: 6.0, tuck: 0.12 },
    { z: 0.042, hw: 0.090, hTop: 0.021, hBot: 0.015, cy: floorY + 0.016, p: 6.0, tuck: 0.12 },
    { z: 0.108, hw: 0.086, hTop: 0.019, hBot: 0.013, cy: floorY + 0.015, p: 5.0, tuck: 0.08 },
    { z: 0.138, hw: 0.070, hTop: 0.016, hBot: 0.010, cy: floorY + 0.014, p: 4.0 },
    { z: 0.150, hw: 0.050, hTop: 0.013, hBot: 0.008, cy: floorY + 0.013, p: 3.0 },
  ];
  // Greenhouse: raked screen, flat roof, fastback tail.
  const upper = [
    { z: -0.070, hw: 0.062, hTop: 0.004, hBot: 0.024, cy: floorY + 0.032, p: 4.0 },
    { z: -0.046, hw: 0.076, hTop: 0.014, hBot: 0.030, cy: floorY + 0.036, p: 4.6 },
    { z: -0.010, hw: 0.079, hTop: 0.020, hBot: 0.032, cy: floorY + 0.038, p: 5.4 },
    { z: 0.048, hw: 0.078, hTop: 0.019, hBot: 0.032, cy: floorY + 0.038, p: 5.4 },
    { z: 0.086, hw: 0.070, hTop: 0.011, hBot: 0.028, cy: floorY + 0.034, p: 4.4 },
    { z: 0.108, hw: 0.056, hTop: 0.003, hBot: 0.022, cy: floorY + 0.030, p: 3.4 },
  ];
  b.add('paintA', stationGeometry(lower, { n: 22 }));
  b.add('paintB', stationGeometry(upper, { n: 20 }));

  // Glass: a slightly inset copy of the greenhouse band.
  const glass = upper.map((s) => ({ ...s, hw: s.hw * 0.985, hTop: s.hTop * 0.98, hBot: s.hBot * 0.62, cy: s.cy + 0.001 }));
  b.add('glass', stationGeometry(glass, { n: 20, cap: false }));

  const beltY = floorY + 0.030;
  // Chrome beltline strip.
  for (let s = -1; s <= 1; s += 2) {
    b.add('chrome', roundBox(0.0034, 0.0034, 0.170, 0.5, 8, 4), { pos: [s * 0.0885, beltY + 0.002, 0.000] });
  }
  // Grille.
  b.add('dark', roundBox(0.062, 0.012, 0.006, 0.30, 12, 8), { pos: [0, floorY + 0.016, -0.146] });
  for (let i = -2; i <= 2; i++) {
    b.add('chrome', roundBox(0.058, 0.0016, 0.002, 0.4, 6, 6), { pos: [0, floorY + 0.016 + i * 0.0032, -0.149] });
  }
  addBumper(b, 'chrome', { z: -0.152, y: floorY + 0.008, halfW: 0.078, radius: 0.0055, wrap: 0.020, sag: 0.0008 });
  addBumper(b, 'chrome', { z: 0.154, y: floorY + 0.008, halfW: 0.076, radius: 0.0055, wrap: 0.018 });
  addLamp(b, 'head', { x: -0.060, y: floorY + 0.020, z: -0.146, r: 0.0088 });
  addLamp(b, 'head', { x: 0.060, y: floorY + 0.020, z: -0.146, r: 0.0088 });
  addLightBarPanel(b, 'brake', { x: -0.062, y: floorY + 0.020, z: 0.150, w: 0.022, h: 0.011 });
  addLightBarPanel(b, 'brake', { x: 0.062, y: floorY + 0.020, z: 0.150, w: 0.022, h: 0.011 });
  addLamp(b, 'reverse', { x: -0.030, y: floorY + 0.013, z: 0.152, r: 0.0046, flat: true });
  addLamp(b, 'reverse', { x: 0.030, y: floorY + 0.013, z: 0.152, r: 0.0046, flat: true });
  addMirror(b, { x: -0.074, y: beltY + 0.006, z: -0.052, out: 0.014, up: 0.006 });
  addMirror(b, { x: 0.074, y: beltY + 0.006, z: -0.052, out: 0.014, up: 0.006 });
  addDriver(b, { y: floorY + 0.032, z: 0.006, scale: 0.80, arms: true, wheel: { r: 0.010, y: floorY + 0.036, z: -0.024, tilt: -0.6 } });
  addBattery(b, { y: floorY + 0.010, z: 0.096, w: 0.050, h: 0.014, d: 0.026 });
  addExhaust(b, { x: 0.048, y: floorY - 0.002, z: 0.150, len: 0.028, r: 0.0032, splay: 0.004 });
  addFloor(b, { y: floorY - 0.004, halfW: 0.078, zFront: -0.128, zRear: 0.132 });
  // Small boot-lid spoiler.
  b.add('paintB', roundBox(0.120, 0.0040, 0.020, 0.35, 12, 6), { pos: [0, floorY + 0.026, 0.120], rot: [-0.14, 0, 0] });
  b.add('plate', numberPlate(0.052, 0.042), { pos: [0, floorY + 0.0585, 0.020] });

  return {
    antenna: { x: 0.056, y: floorY + 0.026, z: 0.100, len: 0.070, segs: 4, ballR: 0.0074 },
    wheelStyle: 'street',
    shellCentre: [0, 0, 0],
  };
}

function buildOpenWheel(b, def) {
  const floorY = -def.comHeight + 0.010;
  // Needle nose → wide sidepods → tapered engine cover.
  const lower = [
    { z: -0.176, hw: 0.011, hTop: 0.006, hBot: 0.004, cy: floorY + 0.010, p: 2.2 },
    { z: -0.150, hw: 0.019, hTop: 0.009, hBot: 0.006, cy: floorY + 0.011, p: 2.6 },
    { z: -0.110, hw: 0.026, hTop: 0.013, hBot: 0.008, cy: floorY + 0.012, p: 3.0 },
    { z: -0.056, hw: 0.031, hTop: 0.016, hBot: 0.010, cy: floorY + 0.013, p: 3.4 },
    { z: -0.010, hw: 0.038, hTop: 0.019, hBot: 0.011, cy: floorY + 0.013, p: 3.6 },
    { z: 0.048, hw: 0.036, hTop: 0.020, hBot: 0.011, cy: floorY + 0.013, p: 3.6 },
    { z: 0.108, hw: 0.028, hTop: 0.017, hBot: 0.010, cy: floorY + 0.013, p: 3.2 },
    { z: 0.150, hw: 0.018, hTop: 0.012, hBot: 0.008, cy: floorY + 0.012, p: 2.6 },
  ];
  b.add('paintA', stationGeometry(lower, { n: 18 }));

  // Sidepods.
  for (let s = -1; s <= 1; s += 2) {
    const pod = stationGeometry([
      { z: -0.056, hw: 0.010, hTop: 0.008, hBot: 0.006, cy: 0, p: 2.6 },
      { z: -0.030, hw: 0.020, hTop: 0.014, hBot: 0.009, cy: 0, p: 3.4 },
      { z: 0.040, hw: 0.021, hTop: 0.014, hBot: 0.009, cy: 0, p: 3.6 },
      { z: 0.076, hw: 0.012, hTop: 0.009, hBot: 0.006, cy: 0, p: 2.8 },
    ], { n: 16 });
    b.add('paintB', pod, { pos: [s * 0.049, floorY + 0.014, 0.006] });
    // Radiator inlet.
    b.add('dark', roundBox(0.004, 0.016, 0.014, 0.3, 8, 6), { pos: [s * 0.060, floorY + 0.015, -0.038] });
  }

  // Engine cover / airbox.
  b.add('paintB', stationGeometry([
    { z: 0.010, hw: 0.020, hTop: 0.008, hBot: 0.018, cy: floorY + 0.032, p: 3.0 },
    { z: 0.036, hw: 0.026, hTop: 0.013, hBot: 0.022, cy: floorY + 0.034, p: 3.4 },
    { z: 0.096, hw: 0.022, hTop: 0.010, hBot: 0.020, cy: floorY + 0.030, p: 3.2 },
    { z: 0.124, hw: 0.012, hTop: 0.005, hBot: 0.014, cy: floorY + 0.026, p: 2.6 },
  ], { n: 16 }));
  // Airbox scoop above the driver.
  b.add('accent', stationGeometry([
    { z: -0.004, hw: 0.013, hTop: 0.010, hBot: 0.006, cy: floorY + 0.044, p: 2.6 },
    { z: 0.014, hw: 0.016, hTop: 0.012, hBot: 0.008, cy: floorY + 0.046, p: 3.0 },
    { z: 0.034, hw: 0.012, hTop: 0.008, hBot: 0.006, cy: floorY + 0.042, p: 2.6 },
  ], { n: 14 }));

  addDriver(b, { y: floorY + 0.028, z: -0.014, scale: 0.72, arms: true, wheel: { r: 0.0092, y: floorY + 0.030, z: -0.038, tilt: -0.75 } });

  // Front wing + nose cone details.
  addWing(b, {
    z: -0.176, y: floorY + 0.004, halfW: 0.078, chord: 0.026, thick: 0.0030,
    aoa: 0.14, endplate: 0.014, mat: 'paintB',
  });
  // Rear wing on struts.
  addWing(b, {
    z: 0.158, y: floorY + 0.052, halfW: 0.076, chord: 0.034, thick: 0.0038,
    aoa: -0.24, endplate: 0.020, mat: 'paintB',
    strut: { x: 0.016, y0: floorY + 0.020, z0: 0.140 },
  });
  // Diffuser.
  b.add('dark', roundBox(0.070, 0.008, 0.030, 0.2, 10, 8), { pos: [0, floorY + 0.001, 0.132], rot: [0.22, 0, 0] });
  // Suspension wishbones (visible, open-wheeler style).
  for (const [zAxle, xTip] of [[def.axleZFront, 0.070], [def.axleZRear, 0.072]]) {
    for (let s = -1; s <= 1; s += 2) {
      b.add('chrome', tube([
        [s * 0.014, floorY + 0.016, zAxle - 0.012],
        [s * 0.045, floorY + 0.010, zAxle - 0.002],
        [s * xTip, floorY + 0.006, zAxle],
      ], 0.0018, 5));
      b.add('chrome', tube([
        [s * 0.014, floorY + 0.004, zAxle + 0.012],
        [s * 0.045, floorY + 0.002, zAxle + 0.004],
        [s * xTip, floorY + 0.000, zAxle],
      ], 0.0018, 5));
    }
  }
  addLamp(b, 'head', { x: -0.012, y: floorY + 0.014, z: -0.166, r: 0.0044 });
  addLamp(b, 'head', { x: 0.012, y: floorY + 0.014, z: -0.166, r: 0.0044 });
  addLightBarPanel(b, 'brake', { x: 0, y: floorY + 0.046, z: 0.172, w: 0.020, h: 0.008, d: 0.004 });
  addLamp(b, 'reverse', { x: 0, y: floorY + 0.012, z: 0.150, r: 0.0038, flat: true });
  addBattery(b, { y: floorY + 0.012, z: 0.070, w: 0.030, h: 0.014, d: 0.032 });
  addMotor(b, { y: floorY + 0.014, z: 0.106, r: 0.011, len: 0.026 });
  b.add('plate', numberPlate(0.026, 0.030), { pos: [0, floorY + 0.048, 0.062] });

  return {
    antenna: { x: 0.020, y: floorY + 0.030, z: 0.118, len: 0.062, segs: 4, ballR: 0.0066 },
    wheelStyle: 'slick',
    shellCentre: [0, 0, 0],
  };
}

function buildMonster(b, def) {
  const floorY = -def.comHeight + 0.032;
  const lower = [
    { z: -0.140, hw: 0.062, hTop: 0.024, hBot: 0.012, cy: floorY + 0.020, p: 4.0 },
    { z: -0.118, hw: 0.082, hTop: 0.030, hBot: 0.016, cy: floorY + 0.021, p: 5.0 },
    { z: -0.070, hw: 0.092, hTop: 0.033, hBot: 0.019, cy: floorY + 0.022, p: 6.4 },
    { z: -0.006, hw: 0.096, hTop: 0.035, hBot: 0.020, cy: floorY + 0.022, p: 7.0 },
    { z: 0.062, hw: 0.096, hTop: 0.033, hBot: 0.020, cy: floorY + 0.022, p: 7.0 },
    { z: 0.116, hw: 0.088, hTop: 0.028, hBot: 0.016, cy: floorY + 0.021, p: 5.4 },
    { z: 0.140, hw: 0.066, hTop: 0.022, hBot: 0.012, cy: floorY + 0.020, p: 4.0 },
  ];
  const upper = [
    { z: -0.062, hw: 0.070, hTop: 0.006, hBot: 0.030, cy: floorY + 0.056, p: 4.4 },
    { z: -0.040, hw: 0.084, hTop: 0.020, hBot: 0.036, cy: floorY + 0.060, p: 5.6 },
    { z: 0.038, hw: 0.084, hTop: 0.022, hBot: 0.036, cy: floorY + 0.060, p: 6.2 },
    { z: 0.070, hw: 0.070, hTop: 0.008, hBot: 0.030, cy: floorY + 0.055, p: 4.4 },
  ];
  b.add('paintA', stationGeometry(lower, { n: 20 }));
  b.add('paintB', stationGeometry(upper, { n: 18 }));
  const glass = upper.map((s) => ({ ...s, hw: s.hw * 0.99, hBot: s.hBot * 0.5, cy: s.cy + 0.001 }));
  b.add('glass', stationGeometry(glass, { n: 18, cap: false }));

  // Ladder chassis rails + axle tubes: the visual signature of a monster truck.
  for (let s = -1; s <= 1; s += 2) {
    b.add('dark', roundBox(0.010, 0.010, 0.250, 0.2, 8, 8), { pos: [s * 0.044, floorY - 0.006, 0.000] });
  }
  for (const zAxle of [def.axleZFront, def.axleZRear]) {
    b.add('dark', new THREE.CylinderGeometry(0.0075, 0.0075, def.trackWidth * 0.92, 12),
      { pos: [0, -def.comHeight + def.tyre.radius, zAxle], rot: [0, 0, Math.PI * 0.5] });
    b.add('chrome', new THREE.SphereGeometry(0.011, 12, 8),
      { pos: [0, -def.comHeight + def.tyre.radius, zAxle] });
    // Coil-overs, visibly long.
    for (let s = -1; s <= 1; s += 2) {
      b.add('accent', new THREE.CylinderGeometry(0.0052, 0.0052, 0.052, 10),
        { pos: [s * 0.062, floorY - 0.008, zAxle], rot: [0, 0, s * 0.16] });
    }
  }
  // Roof light bar.
  b.add('chrome', tube([
    [-0.062, floorY + 0.082, -0.030],
    [0, floorY + 0.086, -0.032],
    [0.062, floorY + 0.082, -0.030],
  ], 0.0030, 6));
  for (let i = -2; i <= 2; i++) {
    addLamp(b, 'head', { x: i * 0.026, y: floorY + 0.088, z: -0.034, r: 0.0072 });
  }
  addBumper(b, 'chrome', { z: -0.148, y: floorY + 0.006, halfW: 0.088, radius: 0.0075, wrap: 0.026, sag: 0.002 });
  addBumper(b, 'chrome', { z: 0.150, y: floorY + 0.006, halfW: 0.086, radius: 0.0075, wrap: 0.024 });
  addLamp(b, 'head', { x: -0.062, y: floorY + 0.030, z: -0.138, r: 0.0092 });
  addLamp(b, 'head', { x: 0.062, y: floorY + 0.030, z: -0.138, r: 0.0092 });
  addLightBarPanel(b, 'brake', { x: -0.066, y: floorY + 0.028, z: 0.144, w: 0.024, h: 0.014 });
  addLightBarPanel(b, 'brake', { x: 0.066, y: floorY + 0.028, z: 0.144, w: 0.024, h: 0.014 });
  addLamp(b, 'reverse', { x: 0, y: floorY + 0.016, z: 0.146, r: 0.0055, flat: true });
  addDriver(b, { y: floorY + 0.052, z: 0.000, scale: 0.86, wheel: { r: 0.011, y: floorY + 0.056, z: -0.030, tilt: -0.55 } });
  addBattery(b, { y: floorY + 0.010, z: 0.100, w: 0.056, h: 0.020, d: 0.032 });
  addExhaust(b, { x: -0.070, y: floorY + 0.030, z: 0.070, len: 0.050, r: 0.0044, splay: 0.006 });
  addExhaust(b, { x: 0.070, y: floorY + 0.030, z: 0.070, len: 0.050, r: 0.0044, splay: 0.006 });
  b.add('plate', numberPlate(0.056, 0.046), { pos: [0, floorY + 0.0825, 0.000] });

  return {
    antenna: { x: 0.062, y: floorY + 0.050, z: 0.110, len: 0.086, segs: 4, ballR: 0.0090 },
    wheelStyle: 'monster',
    shellCentre: [0, 0, 0],
  };
}

function buildLowrider(b, def) {
  const floorY = -def.comHeight + 0.010;
  const lower = [
    { z: -0.164, hw: 0.056, hTop: 0.010, hBot: 0.006, cy: floorY + 0.010, p: 3.4 },
    { z: -0.146, hw: 0.078, hTop: 0.013, hBot: 0.008, cy: floorY + 0.010, p: 5.0 },
    { z: -0.100, hw: 0.090, hTop: 0.015, hBot: 0.010, cy: floorY + 0.011, p: 6.4, tuck: 0.08 },
    { z: -0.040, hw: 0.093, hTop: 0.016, hBot: 0.011, cy: floorY + 0.011, p: 7.0, tuck: 0.10 },
    { z: 0.036, hw: 0.093, hTop: 0.016, hBot: 0.011, cy: floorY + 0.011, p: 7.0, tuck: 0.10 },
    { z: 0.112, hw: 0.090, hTop: 0.015, hBot: 0.010, cy: floorY + 0.011, p: 6.0, tuck: 0.06 },
    { z: 0.152, hw: 0.076, hTop: 0.012, hBot: 0.008, cy: floorY + 0.010, p: 4.6 },
    { z: 0.166, hw: 0.056, hTop: 0.010, hBot: 0.007, cy: floorY + 0.010, p: 3.4 },
  ];
  // Long low roof, thin pillars, fastback.
  const upper = [
    { z: -0.060, hw: 0.062, hTop: 0.003, hBot: 0.018, cy: floorY + 0.024, p: 4.0 },
    { z: -0.036, hw: 0.076, hTop: 0.011, hBot: 0.022, cy: floorY + 0.027, p: 5.0 },
    { z: 0.004, hw: 0.079, hTop: 0.014, hBot: 0.024, cy: floorY + 0.029, p: 6.0 },
    { z: 0.056, hw: 0.077, hTop: 0.012, hBot: 0.024, cy: floorY + 0.028, p: 5.6 },
    { z: 0.100, hw: 0.066, hTop: 0.005, hBot: 0.020, cy: floorY + 0.024, p: 4.0 },
    { z: 0.124, hw: 0.052, hTop: 0.001, hBot: 0.016, cy: floorY + 0.021, p: 3.2 },
  ];
  b.add('paintA', stationGeometry(lower, { n: 22 }));
  b.add('paintB', stationGeometry(upper, { n: 20 }));
  const glass = upper.map((s) => ({ ...s, hw: s.hw * 0.985, hBot: s.hBot * 0.55, cy: s.cy + 0.0008 }));
  b.add('glass', stationGeometry(glass, { n: 20, cap: false }));

  // Tail fins.
  for (let s = -1; s <= 1; s += 2) {
    b.add('paintA', stationGeometry([
      { z: 0.060, hw: 0.004, hTop: 0.004, hBot: 0.004, cy: 0, p: 2.4 },
      { z: 0.110, hw: 0.005, hTop: 0.013, hBot: 0.006, cy: 0.004, p: 2.8 },
      { z: 0.158, hw: 0.004, hTop: 0.016, hBot: 0.006, cy: 0.006, p: 2.4 },
    ], { n: 12 }), { pos: [s * 0.086, floorY + 0.014, 0] });
  }
  // Full-length chrome side spear + skirts.
  for (let s = -1; s <= 1; s += 2) {
    b.add('chrome', roundBox(0.0040, 0.0044, 0.250, 0.5, 8, 4), { pos: [s * 0.0925, floorY + 0.014, -0.002] });
    b.add('paintA', roundBox(0.0070, 0.0100, 0.150, 0.4, 8, 6), { pos: [s * 0.088, floorY + 0.001, 0.004] });
  }
  // Wide chrome grille.
  b.add('chrome', roundBox(0.086, 0.012, 0.008, 0.3, 14, 7), { pos: [0, floorY + 0.011, -0.160] });
  for (let i = 0; i < 9; i++) {
    b.add('dark', roundBox(0.0020, 0.009, 0.002, 0.4, 6, 6), { pos: [(i - 4) * 0.0092, floorY + 0.011, -0.1635] });
  }
  addBumper(b, 'chrome', { z: -0.170, y: floorY + 0.005, halfW: 0.082, radius: 0.0062, wrap: 0.018, sag: 0.001 });
  addBumper(b, 'chrome', { z: 0.172, y: floorY + 0.005, halfW: 0.080, radius: 0.0062, wrap: 0.016 });
  addLamp(b, 'head', { x: -0.064, y: floorY + 0.014, z: -0.161, r: 0.0080 });
  addLamp(b, 'head', { x: 0.064, y: floorY + 0.014, z: -0.161, r: 0.0080 });
  addLamp(b, 'head', { x: -0.046, y: floorY + 0.014, z: -0.163, r: 0.0058 });
  addLamp(b, 'head', { x: 0.046, y: floorY + 0.014, z: -0.163, r: 0.0058 });
  addLamp(b, 'brake', { x: -0.070, y: floorY + 0.016, z: 0.166, r: 0.0070 });
  addLamp(b, 'brake', { x: 0.070, y: floorY + 0.016, z: 0.166, r: 0.0070 });
  addLamp(b, 'reverse', { x: -0.036, y: floorY + 0.010, z: 0.168, r: 0.0046, flat: true });
  addLamp(b, 'reverse', { x: 0.036, y: floorY + 0.010, z: 0.168, r: 0.0046, flat: true });
  addMirror(b, { x: -0.078, y: floorY + 0.021, z: -0.048, out: 0.013, up: 0.005 });
  addMirror(b, { x: 0.078, y: floorY + 0.021, z: -0.048, out: 0.013, up: 0.005 });
  addDriver(b, { y: floorY + 0.023, z: 0.010, scale: 0.76, wheel: { r: 0.010, y: floorY + 0.026, z: -0.022, tilt: -0.65 } });
  addBattery(b, { y: floorY + 0.008, z: 0.108, w: 0.052, h: 0.012, d: 0.024 });
  addExhaust(b, { x: -0.052, y: floorY - 0.002, z: 0.170, len: 0.030, r: 0.0034, splay: 0.006 });
  addExhaust(b, { x: 0.052, y: floorY - 0.002, z: 0.170, len: 0.030, r: 0.0034, splay: 0.006 });
  addFloor(b, { y: floorY - 0.003, halfW: 0.084, zFront: -0.140, zRear: 0.146 });
  b.add('plate', numberPlate(0.048, 0.040), { pos: [0, floorY + 0.0435, 0.010] });

  return {
    antenna: { x: 0.060, y: floorY + 0.016, z: 0.126, len: 0.076, segs: 4, ballR: 0.0072 },
    wheelStyle: 'wire',
    shellCentre: [0, 0, 0],
  };
}

function buildVan(b, def) {
  const floorY = -def.comHeight + 0.022;
  const lower = [
    { z: -0.152, hw: 0.062, hTop: 0.016, hBot: 0.010, cy: floorY + 0.014, p: 4.0 },
    { z: -0.138, hw: 0.082, hTop: 0.020, hBot: 0.014, cy: floorY + 0.014, p: 5.4 },
    { z: -0.104, hw: 0.090, hTop: 0.024, hBot: 0.017, cy: floorY + 0.015, p: 7.0 },
    { z: -0.040, hw: 0.092, hTop: 0.026, hBot: 0.018, cy: floorY + 0.015, p: 8.0 },
    { z: 0.060, hw: 0.092, hTop: 0.026, hBot: 0.018, cy: floorY + 0.015, p: 8.0 },
    { z: 0.132, hw: 0.090, hTop: 0.024, hBot: 0.016, cy: floorY + 0.015, p: 7.0 },
    { z: 0.152, hw: 0.078, hTop: 0.020, hBot: 0.012, cy: floorY + 0.014, p: 5.0 },
  ];
  // A tall box with a forward-raked screen.
  const upper = [
    { z: -0.140, hw: 0.070, hTop: 0.006, hBot: 0.020, cy: floorY + 0.040, p: 4.6 },
    { z: -0.118, hw: 0.084, hTop: 0.024, hBot: 0.028, cy: floorY + 0.050, p: 6.0 },
    { z: -0.080, hw: 0.090, hTop: 0.042, hBot: 0.034, cy: floorY + 0.058, p: 7.4 },
    { z: -0.010, hw: 0.092, hTop: 0.046, hBot: 0.036, cy: floorY + 0.060, p: 8.4 },
    { z: 0.090, hw: 0.092, hTop: 0.046, hBot: 0.036, cy: floorY + 0.060, p: 8.4 },
    { z: 0.140, hw: 0.088, hTop: 0.042, hBot: 0.032, cy: floorY + 0.058, p: 7.0 },
    { z: 0.154, hw: 0.074, hTop: 0.034, hBot: 0.026, cy: floorY + 0.054, p: 5.4 },
  ];
  b.add('paintB', stationGeometry(upper, { n: 22 }));
  b.add('paintA', stationGeometry(lower, { n: 22 }));

  // Windscreen + side windows as separate inset glass panels.
  b.add('glass', roundBox(0.150, 0.040, 0.004, 0.25, 14, 8),
    { pos: [0, floorY + 0.076, -0.116], rot: [0.30, 0, 0] });
  for (let s = -1; s <= 1; s += 2) {
    b.add('glass', roundBox(0.004, 0.032, 0.062, 0.25, 10, 8), { pos: [s * 0.0915, floorY + 0.078, -0.062] });
    b.add('glass', roundBox(0.004, 0.028, 0.048, 0.25, 10, 8), { pos: [s * 0.0915, floorY + 0.076, 0.100] });
  }
  b.add('glass', roundBox(0.120, 0.030, 0.004, 0.25, 12, 8), { pos: [0, floorY + 0.076, 0.152] });

  // Roof rack.
  for (let s = -1; s <= 1; s += 2) {
    b.add('chrome', roundBox(0.0032, 0.0032, 0.190, 0.5, 6, 5), { pos: [s * 0.066, floorY + 0.110, 0.010] });
  }
  for (let i = -1; i <= 1; i++) {
    b.add('chrome', roundBox(0.140, 0.0030, 0.0030, 0.5, 6, 5), { pos: [0, floorY + 0.110, 0.010 + i * 0.062] });
  }
  // Two-tone waistline stripe.
  for (let s = -1; s <= 1; s += 2) {
    b.add('accent', roundBox(0.0032, 0.0080, 0.280, 0.5, 8, 4), { pos: [s * 0.0928, floorY + 0.036, 0.000] });
  }
  addBumper(b, 'chrome', { z: -0.158, y: floorY + 0.008, halfW: 0.084, radius: 0.0066, wrap: 0.020, sag: 0.001 });
  addBumper(b, 'chrome', { z: 0.160, y: floorY + 0.008, halfW: 0.082, radius: 0.0066, wrap: 0.018 });
  b.add('dark', roundBox(0.076, 0.014, 0.006, 0.3, 12, 8), { pos: [0, floorY + 0.020, -0.150] });
  addLamp(b, 'head', { x: -0.062, y: floorY + 0.022, z: -0.150, r: 0.0090, flat: false });
  addLamp(b, 'head', { x: 0.062, y: floorY + 0.022, z: -0.150, r: 0.0090, flat: false });
  addLightBarPanel(b, 'brake', { x: -0.070, y: floorY + 0.030, z: 0.156, w: 0.016, h: 0.030 });
  addLightBarPanel(b, 'brake', { x: 0.070, y: floorY + 0.030, z: 0.156, w: 0.016, h: 0.030 });
  addLamp(b, 'reverse', { x: 0, y: floorY + 0.016, z: 0.158, r: 0.0050, flat: true });
  addMirror(b, { x: -0.084, y: floorY + 0.070, z: -0.106, out: 0.020, up: 0.004 });
  addMirror(b, { x: 0.084, y: floorY + 0.070, z: -0.106, out: 0.020, up: 0.004 });
  addDriver(b, { y: floorY + 0.062, z: -0.058, scale: 0.82, wheel: { r: 0.010, y: floorY + 0.066, z: -0.084, tilt: -0.35 } });
  addBattery(b, { y: floorY + 0.012, z: 0.116, w: 0.056, h: 0.016, d: 0.028 });
  addExhaust(b, { x: 0.056, y: floorY - 0.002, z: 0.158, len: 0.032, r: 0.0036, splay: 0.004 });
  addFloor(b, { y: floorY - 0.004, halfW: 0.084, zFront: -0.132, zRear: 0.140 });
  b.add('plate', numberPlate(0.070, 0.040), { pos: [0, floorY + 0.1065, -0.040] });

  return {
    antenna: { x: 0.060, y: floorY + 0.104, z: 0.120, len: 0.070, segs: 4, ballR: 0.0076 },
    wheelStyle: 'street',
    shellCentre: [0, 0, 0],
  };
}

function buildWedge(b, def) {
  const floorY = -def.comHeight + 0.010;
  // One uninterrupted wedge line from a knife nose to a tall tail.
  const lower = [
    { z: -0.168, hw: 0.040, hTop: 0.004, hBot: 0.004, cy: floorY + 0.006, p: 3.0 },
    { z: -0.144, hw: 0.066, hTop: 0.008, hBot: 0.007, cy: floorY + 0.008, p: 4.2 },
    { z: -0.096, hw: 0.086, hTop: 0.014, hBot: 0.010, cy: floorY + 0.010, p: 5.6, tuck: 0.06 },
    { z: -0.036, hw: 0.095, hTop: 0.022, hBot: 0.012, cy: floorY + 0.012, p: 6.6, tuck: 0.10 },
    { z: 0.030, hw: 0.097, hTop: 0.028, hBot: 0.013, cy: floorY + 0.013, p: 7.0, tuck: 0.12 },
    { z: 0.098, hw: 0.094, hTop: 0.030, hBot: 0.012, cy: floorY + 0.013, p: 6.4, tuck: 0.10 },
    { z: 0.150, hw: 0.082, hTop: 0.028, hBot: 0.010, cy: floorY + 0.012, p: 5.0 },
    { z: 0.168, hw: 0.062, hTop: 0.024, hBot: 0.008, cy: floorY + 0.011, p: 3.6 },
  ];
  b.add('paintA', stationGeometry(lower, { n: 22 }));

  // Low bubble canopy, mostly glass.
  const canopy = [
    { z: -0.060, hw: 0.044, hTop: 0.004, hBot: 0.018, cy: floorY + 0.030, p: 3.0 },
    { z: -0.032, hw: 0.058, hTop: 0.013, hBot: 0.022, cy: floorY + 0.034, p: 3.6 },
    { z: 0.010, hw: 0.060, hTop: 0.016, hBot: 0.024, cy: floorY + 0.036, p: 4.0 },
    { z: 0.054, hw: 0.052, hTop: 0.010, hBot: 0.022, cy: floorY + 0.032, p: 3.4 },
  ];
  b.add('glass', stationGeometry(canopy, { n: 18 }));
  // Canopy frame.
  b.add('paintB', stationGeometry(canopy.map((s) => ({ ...s, hw: s.hw * 1.03, hTop: s.hTop * 1.02, hBot: s.hBot * 0.30 })), { n: 18, cap: false }));

  // NACA-ish roof intake and shoulder vents.
  b.add('dark', roundBox(0.026, 0.006, 0.030, 0.3, 10, 6), { pos: [0, floorY + 0.040, 0.076], rot: [-0.12, 0, 0] });
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < 3; i++) {
      b.add('dark', roundBox(0.020, 0.0026, 0.0060, 0.4, 6, 6),
        { pos: [s * 0.070, floorY + 0.026 + i * 0.005, 0.088], rot: [0, 0, s * 0.22] });
    }
  }
  // Huge rear wing.
  addWing(b, {
    z: 0.174, y: floorY + 0.058, halfW: 0.092, chord: 0.040, thick: 0.0042,
    aoa: -0.26, endplate: 0.024, mat: 'paintB',
    strut: { x: 0.030, y0: floorY + 0.030, z0: 0.150 },
  });
  // Front splitter.
  b.add('paintB', roundBox(0.170, 0.0038, 0.024, 0.3, 14, 7), { pos: [0, floorY + 0.002, -0.166], rot: [0.06, 0, 0] });
  // Rear diffuser.
  b.add('dark', roundBox(0.120, 0.010, 0.034, 0.2, 12, 8), { pos: [0, floorY + 0.002, 0.152], rot: [0.26, 0, 0] });
  addDriver(b, { y: floorY + 0.028, z: 0.004, scale: 0.74, wheel: { r: 0.0092, y: floorY + 0.030, z: -0.026, tilt: -0.7 } });
  addLamp(b, 'head', { x: -0.052, y: floorY + 0.010, z: -0.156, r: 0.0060, flat: true });
  addLamp(b, 'head', { x: 0.052, y: floorY + 0.010, z: -0.156, r: 0.0060, flat: true });
  addLightBarPanel(b, 'brake', { x: 0, y: floorY + 0.030, z: 0.172, w: 0.100, h: 0.007, d: 0.005 });
  addLamp(b, 'reverse', { x: 0, y: floorY + 0.018, z: 0.170, r: 0.0044, flat: true });
  addBattery(b, { y: floorY + 0.010, z: 0.100, w: 0.054, h: 0.014, d: 0.030 });
  addMotor(b, { y: floorY + 0.014, z: 0.132, r: 0.012, len: 0.030 });
  addFloor(b, { y: floorY - 0.002, halfW: 0.088, zFront: -0.140, zRear: 0.148 });
  b.add('plate', numberPlate(0.044, 0.038), { pos: [0, floorY + 0.0435, 0.098] });

  return {
    antenna: { x: 0.070, y: floorY + 0.026, z: 0.118, len: 0.070, segs: 4, ballR: 0.0072 },
    wheelStyle: 'slick',
    shellCentre: [0, 0, 0],
  };
}

function buildSpeedster(b, def) {
  const floorY = -def.comHeight + 0.010;
  const lower = [
    { z: -0.156, hw: 0.034, hTop: 0.008, hBot: 0.005, cy: floorY + 0.008, p: 2.6 },
    { z: -0.134, hw: 0.058, hTop: 0.012, hBot: 0.008, cy: floorY + 0.009, p: 3.2 },
    { z: -0.088, hw: 0.078, hTop: 0.018, hBot: 0.011, cy: floorY + 0.011, p: 3.8, tuck: 0.08 },
    { z: -0.028, hw: 0.085, hTop: 0.023, hBot: 0.012, cy: floorY + 0.012, p: 4.2, tuck: 0.12 },
    { z: 0.036, hw: 0.085, hTop: 0.025, hBot: 0.012, cy: floorY + 0.012, p: 4.2, tuck: 0.12 },
    { z: 0.098, hw: 0.078, hTop: 0.024, hBot: 0.011, cy: floorY + 0.012, p: 3.8, tuck: 0.08 },
    { z: 0.140, hw: 0.062, hTop: 0.020, hBot: 0.009, cy: floorY + 0.011, p: 3.2 },
    { z: 0.156, hw: 0.040, hTop: 0.014, hBot: 0.007, cy: floorY + 0.010, p: 2.6 },
  ];
  // The shell itself is the translucent part — that is the whole point of the car.
  b.add('shellGlass', stationGeometry(lower, { n: 24 }));

  // Painted spine and nose so it is still readable at speed.
  b.add('paintA', stationGeometry([
    { z: -0.150, hw: 0.016, hTop: 0.010, hBot: 0.008, cy: floorY + 0.010, p: 2.6 },
    { z: -0.100, hw: 0.020, hTop: 0.020, hBot: 0.010, cy: floorY + 0.012, p: 3.0 },
    { z: -0.010, hw: 0.022, hTop: 0.026, hBot: 0.010, cy: floorY + 0.013, p: 3.2 },
    { z: 0.090, hw: 0.020, hTop: 0.026, hBot: 0.010, cy: floorY + 0.013, p: 3.0 },
    { z: 0.150, hw: 0.014, hTop: 0.021, hBot: 0.008, cy: floorY + 0.011, p: 2.6 },
  ], { n: 16 }));
  for (let s = -1; s <= 1; s += 2) {
    b.add('paintB', roundBox(0.0060, 0.0090, 0.230, 0.5, 8, 4), { pos: [s * 0.083, floorY + 0.014, 0.000] });
  }

  // Everything inside is visible through the shell — so it has to be good.
  addBattery(b, { y: floorY + 0.010, z: 0.060, w: 0.050, h: 0.014, d: 0.034 });
  addMotor(b, { y: floorY + 0.013, z: 0.106, r: 0.012, len: 0.028 });
  // Drive shafts and diff.
  b.add('chrome', new THREE.CylinderGeometry(0.0022, 0.0022, 0.084, 8),
    { pos: [0, floorY + 0.008, 0.020], rot: [Math.PI * 0.5, 0, 0] });
  for (const zAxle of [def.axleZFront, def.axleZRear]) {
    b.add('chrome', new THREE.CylinderGeometry(0.0020, 0.0020, def.trackWidth * 0.86, 8),
      { pos: [0, floorY + 0.006, zAxle], rot: [0, 0, Math.PI * 0.5] });
    b.add('dark', new THREE.SphereGeometry(0.0075, 12, 8), { pos: [0, floorY + 0.006, zAxle] });
  }
  // Servo + receiver box.
  b.add('dark', roundBox(0.020, 0.014, 0.016, 0.25, 10, 7), { pos: [-0.030, floorY + 0.012, -0.048] });
  b.add('accent', roundBox(0.018, 0.008, 0.014, 0.3, 10, 6), { pos: [0.030, floorY + 0.012, -0.052] });

  addDriver(b, { y: floorY + 0.026, z: 0.000, scale: 0.70, wheel: { r: 0.0088, y: floorY + 0.028, z: -0.028, tilt: -0.7 } });
  // Low ducktail spoiler.
  b.add('paintA', roundBox(0.140, 0.0040, 0.026, 0.35, 14, 6), { pos: [0, floorY + 0.032, 0.140], rot: [-0.22, 0, 0] });
  for (let s = -1; s <= 1; s += 2) {
    b.add('paintA', roundBox(0.0034, 0.010, 0.024, 0.4, 8, 5), { pos: [s * 0.069, floorY + 0.028, 0.140] });
  }
  addLamp(b, 'head', { x: -0.044, y: floorY + 0.014, z: -0.146, r: 0.0068 });
  addLamp(b, 'head', { x: 0.044, y: floorY + 0.014, z: -0.146, r: 0.0068 });
  addLightBarPanel(b, 'brake', { x: 0, y: floorY + 0.024, z: 0.156, w: 0.086, h: 0.0075, d: 0.005 });
  addLamp(b, 'reverse', { x: 0, y: floorY + 0.014, z: 0.156, r: 0.0042, flat: true });
  addFloor(b, { y: floorY - 0.001, halfW: 0.080, zFront: -0.132, zRear: 0.140 });
  b.add('plate', numberPlate(0.042, 0.036), { pos: [0, floorY + 0.0395, 0.052] });

  return {
    antenna: { x: 0.058, y: floorY + 0.030, z: 0.108, len: 0.072, segs: 4, ballR: 0.0070 },
    wheelStyle: 'slick',
    shellCentre: [0, 0, 0],
  };
}

const SHAPE_BUILDERS = {
  pebble: buildPebble,
  toyeca: buildToyeca,
  openwheel: buildOpenWheel,
  monster: buildMonster,
  lowrider: buildLowrider,
  van: buildVan,
  wedge: buildWedge,
  speedster: buildSpeedster,
};

// ═══════════════════════════════════════════════════════════════════════════
// Parts assembly (cached per car TYPE)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build (or fetch from the asset cache) all the geometry for one car type.
 * @param {import('../core/Game.js').Game} game
 * @param {object} def CarDef
 */
export function getCarParts(game, def) {
  const key = `vehicle/parts/${def.id}`;
  const assets = game?.assets;
  const factory = () => buildCarParts(def, game);
  return assets?.memo ? assets.memo(key, factory) : factory();
}

function buildCarParts(def, game) {
  const b = new PartBuilder();
  const builder = SHAPE_BUILDERS[def.shape] ?? SHAPE_BUILDERS.toyeca;
  let meta;
  try {
    meta = builder(b, def) ?? {};
  } catch (err) {
    console.error(`[CarBodies] shape "${def.shape}" failed, using a fallback body:`, err);
    meta = buildFallback(b, def);
  }
  const groups = b.build();
  if (!groups.paintA && !groups.shellGlass) {
    // Absolute last resort — never ship an invisible car.
    const fb = new PartBuilder();
    meta = { ...buildFallback(fb, def), ...meta };
    Object.assign(groups, fb.build());
  }

  const quality = game?.renderer?.quality === 'low' ? 0.25
    : game?.renderer?.quality === 'medium' ? 0.6 : 1;
  const wheelStyle = meta.wheelStyle ?? 'street';
  const wheel = buildWheelParts(def.tyre.radius, def.tyre.width, wheelStyle, quality);

  const ant = meta.antenna ?? { x: 0.05, y: 0.02, z: 0.10, len: 0.070, segs: 4, ballR: 0.0072 };
  const segLen = ant.len / ant.segs;
  const antenna = {
    ...ant,
    segLen,
    segGeo: new THREE.CylinderGeometry(0.0011, 0.0007, segLen, 6, 1),
    ballGeo: new THREE.SphereGeometry(ant.ballR, 12, 9),
    mountGeo: new THREE.CylinderGeometry(0.0030, 0.0038, 0.008, 8, 1),
  };
  // The segment geometry is authored centred; shift it so y = 0 is its base.
  antenna.segGeo.translate(0, segLen * 0.5, 0);

  return { groups, wheel, antenna, wheelStyle, meta };
}

/** A crude but complete car, used only if a shape builder throws. */
function buildFallback(b, def) {
  const floorY = -def.comHeight + 0.016;
  b.add('paintA', stationGeometry([
    { z: -def.length * 0.48, hw: def.width * 0.26, hTop: 0.012, hBot: 0.008, cy: floorY + 0.012, p: 3.2 },
    { z: -def.length * 0.20, hw: def.width * 0.49, hTop: 0.020, hBot: 0.014, cy: floorY + 0.014, p: 5.0 },
    { z: def.length * 0.20, hw: def.width * 0.49, hTop: 0.020, hBot: 0.014, cy: floorY + 0.014, p: 5.0 },
    { z: def.length * 0.48, hw: def.width * 0.26, hTop: 0.012, hBot: 0.008, cy: floorY + 0.012, p: 3.2 },
  ], { n: 16 }));
  b.add('paintB', roundBox(def.width * 0.72, 0.024, def.length * 0.42, 0.4, 14, 5),
    { pos: [0, floorY + 0.032, 0.008] });
  addLightBarPanel(b, 'brake', { x: 0, y: floorY + 0.020, z: def.length * 0.49, w: def.width * 0.5, h: 0.008 });
  addLamp(b, 'head', { x: -def.width * 0.3, y: floorY + 0.018, z: -def.length * 0.49, r: 0.007 });
  addLamp(b, 'head', { x: def.width * 0.3, y: floorY + 0.018, z: -def.length * 0.49, r: 0.007 });
  return {
    antenna: { x: def.width * 0.3, y: floorY + 0.030, z: def.length * 0.3, len: 0.068, segs: 4, ballR: 0.0072 },
    wheelStyle: 'street',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Materials
// ═══════════════════════════════════════════════════════════════════════════

function fallbackStandard(color, roughness = 0.5, metalness = 0.1) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/**
 * Resolve the material bucket → THREE.Material map for one car instance.
 * Shared library materials are reused; the animated light materials and the
 * number plate are freshly created per car so they can be driven independently.
 */
export function carMaterials(game, car) {
  const M = getMaterials(game);
  const def = car.def;
  const primary = car.colorPrimary ?? def.colorPrimary;
  const secondary = car.colorSecondary ?? def.colorSecondary;
  const accent = def.colorAccent ?? 0xffffff;
  const glassy = def.chassis === 'glass';

  const paintA = M
    ? M.carPaint({ color: primary, metallic: def.chassis === 'metal' ? 0.88 : 0.55, flake: 0.55, clearcoat: 1.0 })
    : fallbackStandard(primary, 0.32, 0.6);
  const paintB = M
    ? M.carPaint({ color: secondary, metallic: def.chassis === 'metal' ? 0.55 : 0.25, flake: 0.28, clearcoat: 0.85, roughness: 0.34 })
    : fallbackStandard(secondary, 0.42, 0.2);
  const accentMat = M
    ? M.carPaint({ color: accent, metallic: 0.45, flake: 0.2, clearcoat: 0.7 })
    : fallbackStandard(accent, 0.4, 0.2);

  const chrome = M ? M.get('metal/chrome', { sizeMeters: 0.09 }) : fallbackStandard(0xdfe4ea, 0.10, 1.0);
  const dark = M ? M.get('plastic/abs_matte', { sizeMeters: 0.10, color: 0x2a2d33 }) : fallbackStandard(0x2a2d33, 0.72, 0.05);
  const battery = M ? M.get('plastic/abs_matte', { sizeMeters: 0.08, color: 0x2c3a4a }) : fallbackStandard(0x2c3a4a, 0.6, 0.1);
  const driver = M ? M.get('plastic/injection_gloss', { sizeMeters: 0.06, color: 0xf2e4d0 }) : fallbackStandard(0xf2e4d0, 0.42, 0.0);
  const rubber = M ? M.get('rubber/tyre_tread', { sizeMeters: 0.085 }) : fallbackStandard(0x14161a, 0.86, 0.02);
  const rim = M ? M.get('metal/brushed_alu', { sizeMeters: 0.06 }) : fallbackStandard(0xb9bfc7, 0.28, 0.9);

  let glass;
  if (M) {
    glass = M.get('glass/clear', { sizeMeters: 0.12, transparent: true, opacity: 0.42, roughness: 0.06, doubleSide: true, depthWrite: false });
  } else {
    glass = new THREE.MeshStandardMaterial({ color: 0x9fd4e8, transparent: true, opacity: 0.4, roughness: 0.08, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
  }

  let shellGlass = glass;
  if (glassy) {
    shellGlass = M
      ? M.get('plastic/translucent', {
        sizeMeters: 0.16, color: primary, transparent: true, opacity: 0.44,
        roughness: 0.12, doubleSide: true, depthWrite: false,
      })
      : new THREE.MeshStandardMaterial({ color: primary, transparent: true, opacity: 0.45, roughness: 0.14, side: THREE.DoubleSide, depthWrite: false });
  }

  // ── per-instance animated lights ──
  const brake = new THREE.MeshStandardMaterial({
    color: 0x2a0405, emissive: 0xff1a12, emissiveIntensity: 0.55,
    roughness: 0.28, metalness: 0.0, toneMapped: true,
  });
  brake.name = `car:${car.id}:brake`;
  const reverse = new THREE.MeshStandardMaterial({
    color: 0x14161a, emissive: 0xfff4e0, emissiveIntensity: 0.0,
    roughness: 0.3, metalness: 0.0,
  });
  reverse.name = `car:${car.id}:reverse`;
  const head = new THREE.MeshStandardMaterial({
    color: 0x101318, emissive: 0xfff2d0, emissiveIntensity: 1.6,
    roughness: 0.14, metalness: 0.0,
  });
  head.name = `car:${car.id}:head`;

  let plate;
  const num = String((car.raceNumber ?? car.id + 1) % 100);
  if (M) {
    plate = M.decal({
      key: `carnum:${num}`, text: num, width: 256, height: 256,
      textColor: '#ffffff', outline: '#101318', background: null,
      wear: 0.18, font: 'condensed', unlit: false, roughness: 0.45,
      doubleSide: false, opacity: 0.95,
    });
  }
  if (!plate) plate = fallbackStandard(0xffffff, 0.5, 0.0);

  return {
    paintA, paintB, accent: accentMat, chrome, dark, battery, driver,
    rubber, rim, glass, shellGlass, brake, reverse, head, plate,
    _instanceMats: [brake, reverse, head],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Model assembly
// ═══════════════════════════════════════════════════════════════════════════

const _antA = new THREE.Vector3();
const _antQ = new THREE.Quaternion();

/**
 * Build the visual model for a car and attach it under `car.group`.
 *
 * @param {import('../core/Game.js').Game} game
 * @param {import('./Car.js').Car} car
 * @returns {object} model — see the fields assigned below
 */
export function buildCarModel(game, car) {
  const def = car.def;
  const parts = getCarParts(game, def);
  const mats = carMaterials(game, car);

  const shell = new THREE.Group();
  shell.name = 'shell';
  const meshes = [];

  for (const bucket in parts.groups) {
    const geo = parts.groups[bucket];
    if (!geo) continue;
    const mat = mats[bucket] ?? mats.paintA;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `${def.id}:${bucket}`;
    mesh.castShadow = bucket !== 'glass' && bucket !== 'shellGlass' && bucket !== 'plate';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (bucket === 'glass' || bucket === 'shellGlass') mesh.renderOrder = 2;
    if (bucket === 'plate') mesh.renderOrder = 1;
    shell.add(mesh);
    meshes.push(mesh);
  }
  car.group.add(shell);

  // ── wheels ────────────────────────────────────────────────────────────
  const wheelGroups = new Array(4);
  const wheelSpins = new Array(4);
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const g = new THREE.Group();
    g.name = `wheel${i}`;
    const spin = new THREE.Group();
    spin.name = `spin${i}`;
    const tyre = new THREE.Mesh(parts.wheel.tyre, mats.rubber);
    const rim = new THREE.Mesh(parts.wheel.rim, mats.rim);
    tyre.castShadow = true;
    rim.castShadow = true;
    tyre.receiveShadow = true;
    // The rim dish faces outboard, so mirror the right-hand wheels.
    const flip = w.side > 0 ? 1 : -1;
    spin.scale.x = flip;
    spin.add(tyre);
    spin.add(rim);
    g.add(spin);
    g.position.copy(w.hubLocal);
    car.group.add(g);
    wheelGroups[i] = g;
    wheelSpins[i] = spin;
    w.mesh = g;
  }

  // ── antenna ───────────────────────────────────────────────────────────
  const ant = parts.antenna;
  const antRoot = new THREE.Group();
  antRoot.name = 'antenna';
  antRoot.position.set(ant.x, ant.y, ant.z);
  shell.add(antRoot);

  const mount = new THREE.Mesh(ant.mountGeo, mats.dark);
  mount.position.y = 0.002;
  mount.castShadow = false;
  antRoot.add(mount);

  const segMats = mats.dark;
  const segs = [];
  for (let i = 0; i < ant.segs; i++) {
    const m = new THREE.Mesh(ant.segGeo, segMats);
    m.castShadow = false;
    m.matrixAutoUpdate = true;
    antRoot.add(m);
    segs.push(m);
  }
  const ballMat = new THREE.MeshStandardMaterial({
    color: def.antennaColor ?? 0xff2d55,
    emissive: def.antennaColor ?? 0xff2d55,
    emissiveIntensity: 0.22,
    roughness: 0.30, metalness: 0.05,
  });
  ballMat.name = `car:${car.id}:antennaBall`;
  const ball = new THREE.Mesh(ant.ballGeo, ballMat);
  ball.castShadow = false;
  antRoot.add(ball);

  const chain = new AntennaChain(ant.segs, ant.segLen, {
    lean: 0.18,
    stiffness: 720,
    damping: 2.9,
    accelGain: 1.35,
    gravityGain: 0.16,
  });
  writeAntenna(chain, segs, ball, ant.segLen);

  // ── model ─────────────────────────────────────────────────────────────
  const model = {
    shell,
    meshes,
    wheelGroups,
    wheelSpins,
    antennaRoot: antRoot,
    antennaSegs: segs,
    antennaBall: ball,
    antennaChain: chain,
    materials: mats,
    brakeMaterial: mats.brake,
    reverseMaterial: mats.reverse,
    headMaterial: mats.head,
    ballMaterial: ballMat,
    wheelStyle: parts.wheelStyle,

    /** Drive the antenna. Called from Car.updateVisual. */
    updateAntenna(dt, accelWorld, quat) {
      const body = car.body;
      if (!body) return;
      chain.update(dt, accelWorld, body.angularVelocity, quat ?? body.quaternion, antRoot.position);
      writeAntenna(chain, segs, ball, ant.segLen);
    },
    resetAntenna() {
      chain.reset();
      writeAntenna(chain, segs, ball, ant.segLen);
    },
    /** Repaint on the fly (car-select preview, team liveries). */
    setColors(primary, secondary) {
      car.colorPrimary = primary;
      car.colorSecondary = secondary;
      const next = carMaterials(game, car);
      for (const mesh of meshes) {
        const bucket = mesh.name.split(':')[1];
        const m = next[bucket];
        if (m) mesh.material = m;
      }
      model.materials = next;
      model.brakeMaterial = next.brake;
      model.reverseMaterial = next.reverse;
      model.headMaterial = next.head;
    },
    dispose() {
      // Geometry is cached and shared per car type — never disposed here.
      for (const m of mats._instanceMats) m.dispose();
      ballMat.dispose();
      shell.removeFromParent();
      for (const g of wheelGroups) g?.removeFromParent();
    },
  };

  return model;
}

/** Push the chain state into the segment meshes. */
function writeAntenna(chain, segs, ball, segLen) {
  const p = chain.pos;
  for (let i = 0; i < segs.length; i++) {
    const a = i * 3;
    const b = (i + 1) * 3;
    const dx = p[b] - p[a];
    const dy = p[b + 1] - p[a + 1];
    const dz = p[b + 2] - p[a + 2];
    const len = Math.hypot(dx, dy, dz) || segLen;
    const m = segs[i];
    m.position.set(p[a], p[a + 1], p[a + 2]);
    _antA.set(dx / len, dy / len, dz / len);
    _antQ.setFromUnitVectors(_AXIS_Y, _antA);
    m.quaternion.copy(_antQ);
    m.scale.set(1, len / segLen, 1);
  }
  const t = segs.length * 3;
  ball.position.set(p[t], p[t + 1], p[t + 2]);
}

export default buildCarModel;
