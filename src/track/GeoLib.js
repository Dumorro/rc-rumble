/**
 * RC RUMBLE — procedural geometry primitives for track building.
 *
 * **House rule: every UV in this file is in METRES.** Combined with materials
 * requested at `sizeMeters: 1` (see `TrackBuilder#mat`) that gives a single,
 * globally constant texel density — a parquet block is the same size on the
 * floor, on a table top and on a ramp, and geometry from different helpers can
 * be merged into one draw call without any UV bookkeeping.
 *
 * Nothing here touches the scene graph or materials; the helpers return plain
 * `BufferGeometry` with `position`, `normal` and `uv` (plus `color` where a
 * helper is explicitly vertex-coloured), indexed, no groups — exactly the shape
 * `BufferGeometryUtils.mergeGeometries` wants.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

// ═════════════════════════════════════════════════════════════════ utilities

/** Ensure a geometry is indexed (mergeGeometries requires consistency). */
export function ensureIndexed(geo) {
  if (geo.getIndex()) return geo;
  const n = geo.getAttribute('position').count;
  const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) arr[i] = i;
  geo.setIndex(new THREE.BufferAttribute(arr, 1));
  return geo;
}

/**
 * Normalise a geometry for merging: indexed, exactly the attributes we want,
 * no groups, no morph targets.
 * @param {THREE.BufferGeometry} geo
 * @param {boolean} [wantColor]
 */
export function normalizeForMerge(geo, wantColor = false) {
  ensureIndexed(geo);
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const count = geo.getAttribute('position').count;
  if (!geo.getAttribute('uv')) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (wantColor && !geo.getAttribute('color')) {
    const c = new Float32Array(count * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  for (const name of Object.keys(geo.attributes)) {
    if (name === 'position' || name === 'normal' || name === 'uv') continue;
    if (wantColor && name === 'color') continue;
    geo.deleteAttribute(name);
  }
  geo.morphAttributes = {};
  geo.clearGroups();
  return geo;
}

/**
 * Merge a list of geometries, tolerating nulls and mismatched attribute sets.
 * @param {THREE.BufferGeometry[]} list
 * @param {boolean} [wantColor]
 * @returns {THREE.BufferGeometry|null}
 */
export function mergeList(list, wantColor = false) {
  const clean = [];
  for (const g of list) {
    if (!g) continue;
    const pos = g.getAttribute?.('position');
    if (!pos || pos.count === 0) continue;
    clean.push(normalizeForMerge(g, wantColor));
  }
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  try {
    const merged = mergeGeometries(clean, false);
    if (merged) return merged;
  } catch (err) {
    console.warn('[GeoLib] mergeGeometries failed, falling back:', err);
  }
  return clean[0];
}

/** Multiply the UVs (metres → metres, e.g. to stretch a decal). */
export function scaleUV(geo, su, sv = su, ou = 0, ov = 0) {
  const uv = geo.getAttribute('uv');
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Replace UVs with a planar projection in metres. `axis` is the plane normal. */
export function planarUV(geo, axis = 'y', ou = 0, ov = 0) {
  const pos = geo.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u, v;
    if (axis === 'x') { u = z; v = y; }
    else if (axis === 'z') { u = x; v = y; }
    else { u = x; v = z; }
    uv[i * 2] = u + ou; uv[i * 2 + 1] = v + ov;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Triplanar-ish UV: project along whichever axis each face points at most.
 * Great for organic props (rocks, mounds) where a single plane would smear.
 */
export function boxUV(geo) {
  const pos = geo.getAttribute('position');
  let nrm = geo.getAttribute('normal');
  if (!nrm) { geo.computeVertexNormals(); nrm = geo.getAttribute('normal'); }
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = z; v = y; }
    else if (ay >= az) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Paint every vertex one colour (for `M.vertexColor()` materials). */
export function setColor(geo, hex) {
  const pos = geo.getAttribute('position');
  _c.setHex(hex).convertSRGBToLinear();
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Per-vertex colour from a callback `(x,y,z,i) => hex`. */
export function colorize(geo, fn) {
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _c.setHex(fn(pos.getX(i), pos.getY(i), pos.getZ(i), i) >>> 0).convertSRGBToLinear();
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Vertical gradient tint, cheap fake AO / sun bleaching for foliage & props. */
export function gradientColor(geo, bottomHex, topHex, y0 = null, y1 = null) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const lo = y0 ?? bb.min.y, hi = y1 ?? bb.max.y;
  const span = Math.max(1e-5, hi - lo);
  const a = new THREE.Color(bottomHex).convertSRGBToLinear();
  const b = new THREE.Color(topHex).convertSRGBToLinear();
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const f = Math.min(1, Math.max(0, (pos.getY(i) - lo) / span));
    col[i * 3] = a.r + (b.r - a.r) * f;
    col[i * 3 + 1] = a.g + (b.g - a.g) * f;
    col[i * 3 + 2] = a.b + (b.b - a.b) * f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Flip winding + normals (turn a box into a room shell). */
export function flipGeometry(geo) {
  ensureIndexed(geo);
  const idx = geo.getIndex();
  const a = idx.array;
  for (let i = 0; i < a.length; i += 3) { const t = a[i]; a[i] = a[i + 2]; a[i + 2] = t; }
  idx.needsUpdate = true;
  const n = geo.getAttribute('normal');
  if (n) {
    for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    n.needsUpdate = true;
  }
  return geo;
}

/** Displace vertices along their normal with a deterministic hash noise. */
export function roughen(geo, amount = 0.01, freq = 4, seed = 1) {
  const pos = geo.getAttribute('position');
  let nrm = geo.getAttribute('normal');
  if (!nrm) { geo.computeVertexNormals(); nrm = geo.getAttribute('normal'); }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = hash3(x * freq, y * freq, z * freq, seed) * 2 - 1;
    pos.setXYZ(i,
      x + nrm.getX(i) * n * amount,
      y + nrm.getY(i) * n * amount,
      z + nrm.getZ(i) * n * amount);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export function hash3(x, y, z, seed = 0) {
  let h = Math.imul(Math.floor(x * 733) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(Math.floor(y * 941) ^ 0x27d4eb2f, 0xc2b2ae35);
  h ^= Math.imul(Math.floor(z * 619) ^ (seed | 0), 0x165667b1);
  h ^= h >>> 15;
  return ((h >>> 0) % 100003) / 100003;
}

/** Build a Matrix4 from position / euler / scale in one call. */
export function trs(px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _v.set(px, py, pz);
  _q.setFromEuler(new THREE.Euler(rx, ry, rz));
  _v2.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v, _q, _v2);
}

// ═════════════════════════════════════════════════════════════════ primitives

/**
 * Axis-aligned box with per-face metre UVs and (optionally) rounded edges.
 * Faces are independent grids projected onto the rounded-box surface, so the
 * bevel is exact and the normals read continuous across the seams.
 *
 * @param {number} w @param {number} h @param {number} d
 * @param {{radius?:number, seg?:number, uvRotateTop?:boolean, skip?:string}} [o]
 *        `skip` is any of 'xyzXYZ' — omit '-x' with 'x', '+x' with 'X' etc.
 */
export function boxMeters(w, h, d, o = {}) {
  const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
  const r = Math.max(0, Math.min(o.radius ?? 0, Math.min(hx, hy, hz) * 0.98));
  // A bevel costs 6·seg² quads. The default is deliberately mean (2, or 3 for a
  // chunky radius) because this is the single most-instantiated primitive in the
  // game; ask for more explicitly when a prop is a hero object.
  const seg = r > 0 ? Math.max(2, Math.min(8, o.seg ?? (r > 0.06 ? 3 : 2))) : 1;
  const skip = o.skip ?? '';

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  // ex/ey give the face's tangent basis, n the outward axis
  const faces = [
    { key: 'X', n: [1, 0, 0], ex: [0, 0, -1], ey: [0, 1, 0], su: d, sv: h },
    { key: 'x', n: [-1, 0, 0], ex: [0, 0, 1], ey: [0, 1, 0], su: d, sv: h },
    { key: 'Y', n: [0, 1, 0], ex: [1, 0, 0], ey: [0, 0, 1], su: w, sv: d },
    { key: 'y', n: [0, -1, 0], ex: [1, 0, 0], ey: [0, 0, -1], su: w, sv: d },
    { key: 'Z', n: [0, 0, 1], ex: [1, 0, 0], ey: [0, 1, 0], su: w, sv: h },
    { key: 'z', n: [0, 0, -1], ex: [-1, 0, 0], ey: [0, 1, 0], su: w, sv: h },
  ];

  const ix = hx - r, iy = hy - r, iz = hz - r;

  for (const f of faces) {
    if (skip.includes(f.key)) continue;
    const base = positions.length / 3;
    for (let j = 0; j <= seg; j++) {
      const bv = seg === 0 ? 0 : (j / seg) * 2 - 1;
      for (let i = 0; i <= seg; i++) {
        const av = seg === 0 ? 0 : (i / seg) * 2 - 1;
        // Flat point on the face.
        const px = f.n[0] * hx + f.ex[0] * av * (f.su * 0.5) + f.ey[0] * bv * (f.sv * 0.5);
        const py = f.n[1] * hy + f.ex[1] * av * (f.su * 0.5) + f.ey[1] * bv * (f.sv * 0.5);
        const pz = f.n[2] * hz + f.ex[2] * av * (f.su * 0.5) + f.ey[2] * bv * (f.sv * 0.5);
        let vx = px, vy = py, vz = pz, nx = f.n[0], ny = f.n[1], nz = f.n[2];
        if (r > 0) {
          const qx = Math.max(-ix, Math.min(ix, px));
          const qy = Math.max(-iy, Math.min(iy, py));
          const qz = Math.max(-iz, Math.min(iz, pz));
          let dx = px - qx, dy = py - qy, dz = pz - qz;
          const dl = Math.hypot(dx, dy, dz);
          if (dl > 1e-9) { dx /= dl; dy /= dl; dz /= dl; } else { dx = f.n[0]; dy = f.n[1]; dz = f.n[2]; }
          vx = qx + dx * r; vy = qy + dy * r; vz = qz + dz * r;
          nx = dx; ny = dy; nz = dz;
        }
        positions.push(vx, vy, vz);
        normals.push(nx, ny, nz);
        uvs.push((av * 0.5 + 0.5) * f.su, (bv * 0.5 + 0.5) * f.sv);
      }
    }
    // Winding: the (ex, ey) basis is left- or right-handed relative to the face
    // normal depending on the face, so pick the triangle order that makes the
    // geometric normal agree with `n` instead of hand-tuning six tables.
    const hand =
      (f.ey[1] * f.ex[2] - f.ey[2] * f.ex[1]) * f.n[0] +
      (f.ey[2] * f.ex[0] - f.ey[0] * f.ex[2]) * f.n[1] +
      (f.ey[0] * f.ex[1] - f.ey[1] * f.ex[0]) * f.n[2];
    const stride = seg + 1;
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * stride + i;
        const b = a + 1;
        const c = a + stride;
        const dd = c + 1;
        if (hand > 0) indices.push(a, c, b, b, c, dd);
        else indices.push(a, b, c, b, dd, c);
      }
    }
  }

  return finish(positions, normals, uvs, indices);
}

/** Convenience: a rounded box. */
export function roundedBox(w, h, d, radius = 0.02, seg = 4) {
  return boxMeters(w, h, d, { radius, seg });
}

/** Horizontal plane in XZ, normal +Y, centred at the origin, UV = metres. */
export function planeXZ(w, d, o = {}) {
  const sx = Math.max(1, o.segX ?? 1), sz = Math.max(1, o.segZ ?? 1);
  const positions = [], normals = [], uvs = [], indices = [];
  for (let j = 0; j <= sz; j++) {
    const fz = j / sz;
    for (let i = 0; i <= sx; i++) {
      const fx = i / sx;
      const x = (fx - 0.5) * w, z = (fz - 0.5) * d;
      const y = o.heightFn ? o.heightFn(x, z) : 0;
      positions.push(x, y, z);
      normals.push(0, 1, 0);
      uvs.push(x + (o.ou ?? 0), z + (o.ov ?? 0));
    }
  }
  const stride = sx + 1;
  for (let j = 0; j < sz; j++) {
    for (let i = 0; i < sx; i++) {
      const a = j * stride + i, b = a + 1, c = a + stride, dd = c + 1;
      indices.push(a, c, b, b, c, dd);
    }
  }
  const g = finish(positions, normals, uvs, indices);
  if (o.heightFn) g.computeVertexNormals();
  return g;
}

/** Vertical plane in XY, normal +Z, UV = metres. */
export function planeXY(w, h, o = {}) {
  const positions = [
    -w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0,
  ];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
  const uvs = [0, 0, w, 0, w, h, 0, h];
  if (o.ou || o.ov) for (let i = 0; i < 4; i++) { uvs[i * 2] += o.ou ?? 0; uvs[i * 2 + 1] += o.ov ?? 0; }
  return finish(positions, normals, uvs, [0, 1, 2, 0, 2, 3]);
}

/** Filled disc in XZ, normal +Y. */
export function discXZ(radius, seg = 32, o = {}) {
  const positions = [0, 0, 0], normals = [0, 1, 0], uvs = [0, 0], indices = [];
  const a0 = o.thetaStart ?? 0, aLen = o.thetaLength ?? Math.PI * 2;
  const n = Math.max(3, seg);
  // n+1 rim vertices: for a full circle the last one duplicates the first, which
  // closes the fan without a special case.
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * aLen;
    const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
    positions.push(x, 0, z); normals.push(0, 1, 0); uvs.push(x, z);
  }
  for (let i = 0; i < n; i++) indices.push(0, i + 2, i + 1);
  return finish(positions, normals, uvs, indices);
}

/** Annulus in XZ, normal +Y (pickup pads, plinth rims, sprinkler wet arc). */
export function ringXZ(rInner, rOuter, seg = 40, o = {}) {
  const positions = [], normals = [], uvs = [], indices = [];
  const a0 = o.thetaStart ?? 0, aLen = o.thetaLength ?? Math.PI * 2;
  const n = Math.max(3, seg);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * aLen;
    const ca = Math.cos(a), sa = Math.sin(a);
    positions.push(ca * rInner, 0, sa * rInner);
    normals.push(0, 1, 0);
    uvs.push(ca * rInner, sa * rInner);
    positions.push(ca * rOuter, 0, sa * rOuter);
    normals.push(0, 1, 0);
    uvs.push(ca * rOuter, sa * rOuter);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    indices.push(a, c, b, b, c, d);
  }
  return finish(positions, normals, uvs, indices);
}

/**
 * Cylinder / cone / prism with metre UVs (u = circumference, v = height).
 * @param {number} rTop @param {number} rBottom @param {number} h
 */
export function cylinderMeters(rTop, rBottom, h, seg = 20, o = {}) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, Math.max(3, seg),
    o.heightSeg ?? 1, !!o.open, o.thetaStart ?? 0, o.thetaLength ?? Math.PI * 2);
  const circ = Math.PI * (rTop + rBottom);
  scaleUV(geo, circ, h);
  // Cap UVs come out in 0..1 too; re-project them in metres for correctness.
  reprojectCaps(geo, Math.max(rTop, rBottom), h, circ);
  return normalizeForMerge(geo);
}

function reprojectCaps(geo, r, h, circ) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  if (!pos || !nrm || !uv) return;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(nrm.getY(i)) > 0.92) uv.setXY(i, pos.getX(i), pos.getZ(i));
  }
  uv.needsUpdate = true;
  void r; void h; void circ;
}

/** Sphere with metre UVs. */
export function sphereMeters(radius, seg = 20, o = {}) {
  const geo = new THREE.SphereGeometry(radius, Math.max(4, seg), Math.max(3, Math.round(seg * 0.6)),
    o.phiStart ?? 0, o.phiLength ?? Math.PI * 2, o.thetaStart ?? 0, o.thetaLength ?? Math.PI);
  scaleUV(geo, Math.PI * 2 * radius, Math.PI * radius);
  return normalizeForMerge(geo);
}

/** Torus with metre UVs. */
export function torusMeters(radius, tube, segR = 24, segT = 12, arc = Math.PI * 2) {
  const geo = new THREE.TorusGeometry(radius, tube, Math.max(3, segT), Math.max(3, segR), arc);
  scaleUV(geo, radius * arc, Math.PI * 2 * tube);
  return normalizeForMerge(geo);
}

/**
 * Lathe a 2D profile `[[r, y], …]` around the Y axis. The workhorse for pots,
 * chess pieces, bottles, plinth mouldings.
 */
export function latheMeters(profile, seg = 24) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y));
  const geo = new THREE.LatheGeometry(pts, Math.max(3, seg));
  let maxR = 0, minY = Infinity, maxY = -Infinity;
  for (const [r, y] of profile) { maxR = Math.max(maxR, r); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  scaleUV(geo, Math.PI * 2 * maxR, Math.max(1e-3, maxY - minY));
  return normalizeForMerge(geo);
}

/**
 * Extrude a 2D outline (in metres) along +Z by `depth`, then optionally rotate
 * so it lies flat. UVs come out in metres courtesy of three's WorldUVGenerator.
 * @param {Array<[number,number]>} outline
 * @param {number} depth
 * @param {{bevel?:number, bevelSeg?:number, curveSeg?:number, holes?:Array<Array<[number,number]>>}} [o]
 */
export function extrudeOutline(outline, depth, o = {}) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  if (o.holes) {
    for (const h of o.holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  const bevel = o.bevel ?? 0;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: o.bevelSeg ?? 2,
    curveSegments: o.curveSeg ?? 8,
    steps: 1,
  });
  geo.translate(0, 0, -depth * 0.5);
  return normalizeForMerge(geo);
}

/** Flat polygon in XZ from a 2D outline (arbitrary floor regions). */
export function polygonXZ(outline, o = {}) {
  const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, z)));
  if (o.holes) {
    for (const h of o.holes) shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, z))));
  }
  const geo = new THREE.ShapeGeometry(shape, o.curveSeg ?? 8);
  // ShapeGeometry lives in XY with +Z normals → rotate into XZ, normals +Y.
  geo.rotateX(-Math.PI / 2);
  // rotateX maps (x,y,0) → (x,0,-y): flip V so UVs stay right-handed in world XZ.
  scaleUV(geo, 1, -1);
  geo.computeVertexNormals();
  return normalizeForMerge(geo);
}

/**
 * A right-triangular prism ramp: rises from y=0 at -Z to y=`h` at +Z, `w` wide
 * along X, `d` long along Z. Origin at the centre of the bottom face.
 */
export function wedge(w, h, d, o = {}) {
  const hx = w / 2, hz = d / 2;
  const y0 = o.startHeight ?? 0;
  const positions = [], normals = [], uvs = [], indices = [];
  const slopeLen = Math.hypot(d, h - y0);
  const push = (x, y, z, nx, ny, nz, u, v) => {
    positions.push(x, y, z); normals.push(nx, ny, nz); uvs.push(u, v);
    return positions.length / 3 - 1;
  };
  // slope (top face)
  const ny = d / slopeLen, nz = -(h - y0) / slopeLen;
  const s0 = push(-hx, y0, -hz, 0, ny, nz, 0, 0);
  const s1 = push(hx, y0, -hz, 0, ny, nz, w, 0);
  const s2 = push(hx, h, hz, 0, ny, nz, w, slopeLen);
  const s3 = push(-hx, h, hz, 0, ny, nz, 0, slopeLen);
  indices.push(s0, s2, s1, s0, s3, s2);
  // bottom
  const b0 = push(-hx, 0, -hz, 0, -1, 0, 0, 0);
  const b1 = push(hx, 0, -hz, 0, -1, 0, w, 0);
  const b2 = push(hx, 0, hz, 0, -1, 0, w, d);
  const b3 = push(-hx, 0, hz, 0, -1, 0, 0, d);
  indices.push(b0, b1, b2, b0, b2, b3);
  // back (+Z, the tall end)
  const k0 = push(-hx, 0, hz, 0, 0, 1, 0, 0);
  const k1 = push(hx, 0, hz, 0, 0, 1, w, 0);
  const k2 = push(hx, h, hz, 0, 0, 1, w, h);
  const k3 = push(-hx, h, hz, 0, 0, 1, 0, h);
  indices.push(k0, k1, k2, k0, k2, k3);
  if (y0 > 0) {
    // front lip (−Z)
    const f0 = push(-hx, 0, -hz, 0, 0, -1, 0, 0);
    const f1 = push(-hx, y0, -hz, 0, 0, -1, 0, y0);
    const f2 = push(hx, y0, -hz, 0, 0, -1, w, y0);
    const f3 = push(hx, 0, -hz, 0, 0, -1, w, 0);
    indices.push(f0, f1, f2, f0, f2, f3);
  }
  // sides
  const sideNs = [[-1, 0, 0], [1, 0, 0]];
  for (let s = 0; s < 2; s++) {
    const x = s === 0 ? -hx : hx;
    const n = sideNs[s];
    const p0 = push(x, 0, -hz, n[0], n[1], n[2], -hz, 0);
    const p1 = push(x, y0, -hz, n[0], n[1], n[2], -hz, y0);
    const p2 = push(x, h, hz, n[0], n[1], n[2], hz, h);
    const p3 = push(x, 0, hz, n[0], n[1], n[2], hz, 0);
    if (s === 0) indices.push(p0, p2, p1, p0, p3, p2);
    else indices.push(p0, p1, p2, p0, p2, p3);
  }
  return finish(positions, normals, uvs, indices);
}

/**
 * A flight of stairs, first riser at -Z, climbing toward +Z.
 * Origin at the centre of the bottom of the first riser.
 */
export function stairsGeo(width, steps, rise, run, o = {}) {
  const geos = [];
  const nose = o.nosing ?? 0.012;
  const r = o.radius ?? 0.008;
  for (let i = 0; i < steps; i++) {
    const y = rise * (i + 0.5);
    const z = run * (i + 0.5);
    const g = boxMeters(width, rise, run + nose, { radius: r, seg: 2 });
    g.translate(0, y, z - nose * 0.5);
    geos.push(g);
  }
  if (o.skirt) {
    // Solid triangular sides so nothing can wedge under the treads.
    for (const s of [-1, 1]) {
      const outline = [[0, 0], [run * steps, 0]];
      for (let i = steps; i >= 1; i--) {
        outline.push([run * i, rise * i]);
        outline.push([run * (i - 1), rise * i]);
      }
      const g = extrudeOutline(outline, o.skirt);
      // outline is (z, y) → map to world: rotate so X=depth becomes Z
      g.rotateY(-Math.PI / 2);
      g.translate(s * (width * 0.5 + o.skirt * 0.5 - 0.001), 0, 0);
      geos.push(g);
    }
  }
  return mergeList(geos) ?? boxMeters(width, rise, run);
}

/** An oriented beam/box between two world points (railings, ropes, pipes). */
export function beamBetween(a, b, w, h, o = {}) {
  _v.set(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = _v.length();
  if (len < 1e-6) return boxMeters(w, h, 0.01);
  const geo = o.round
    ? cylinderMeters(w * 0.5, w * 0.5, len, o.seg ?? 10)
    : boxMeters(w, h, len, { radius: o.radius ?? 0 });
  if (o.round) geo.rotateX(Math.PI / 2);      // cylinder is +Y, we want +Z
  _v.normalize();
  _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _v);
  geo.applyQuaternion(_q);
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

/**
 * A catenary "rope" (velvet rope, garden hose, cable) between two points, as a
 * tube. `sag` is the dip at mid-span in metres.
 */
export function ropeBetween(a, b, radius = 0.02, sag = 0.25, seg = 14, radial = 7) {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const f = i / seg;
    const x = a.x + (b.x - a.x) * f;
    const z = a.z + (b.z - a.z) * f;
    const yl = a.y + (b.y - a.y) * f;
    const dip = Math.sin(Math.PI * f);
    pts.push(new THREE.Vector3(x, yl - sag * dip, z));
  }
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
  const geo = new THREE.TubeGeometry(curve, seg * 2, radius, Math.max(3, radial), false);
  scaleUV(geo, curve.getLength(), Math.PI * 2 * radius);
  return normalizeForMerge(geo);
}

/**
 * A tube following an arbitrary polyline (hoses, pipes, handrails, bones).
 * `stepMeters` controls the tessellation along the length — it dominates the
 * triangle count, so long runs should ask for a coarse step.
 */
export function tubeAlong(points, radius = 0.03, radial = 8, closed = false, tension = 0.4, stepMeters = 0.18) {
  const pts = points.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2])));
  if (pts.length < 2) return cylinderMeters(radius, radius, 0.1, radial);
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'catmullrom', tension);
  const len = curve.getLength();
  const seg = Math.max(6, Math.min(400, Math.ceil(len / Math.max(0.02, stepMeters))));
  const geo = new THREE.TubeGeometry(curve, seg, radius, Math.max(3, radial), closed);
  scaleUV(geo, len, Math.PI * 2 * radius);
  return normalizeForMerge(geo);
}

/**
 * A hollow rectangular frame (picture frames, window mullions, display-case
 * uprights) in the XY plane, extruded along Z.
 */
export function frameGeo(w, h, thickness, depth) {
  const hw = w / 2, hh = h / 2, t = thickness;
  const outline = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const hole = [[-hw + t, -hh + t], [-hw + t, hh - t], [hw - t, hh - t], [hw - t, -hh + t]];
  return extrudeOutline(outline, depth, { holes: [hole] });
}

/**
 * A convex "mound"/rockery: a squashed, noise-displaced hemisphere that meets the
 * ground cleanly (skirt vertices are pinned to y=0 so no gap can appear).
 */
export function moundGeo(radius, height, seg = 24, seed = 7, roughness = 0.16) {
  const geo = new THREE.SphereGeometry(1, Math.max(6, seg), Math.max(4, seg >> 1), 0, Math.PI * 2, 0, Math.PI * 0.5);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const rim = 1 - Math.min(1, y * 1.15);              // 1 at the ground, 0 at the top
    const n = (hash3(x * 3.1, y * 2.3, z * 3.7, seed) - 0.5) * roughness * (1 - rim * 0.85);
    const s = 1 + n;
    pos.setXYZ(i, x * radius * s, Math.max(0, y * height * s), z * radius * s);
  }
  geo.computeVertexNormals();
  boxUV(geo);
  return normalizeForMerge(geo);
}

/**
 * A crossed-quad foliage bush: N quads through a common vertical axis, with a
 * vertex `color` gradient and a `windPhase` stashed in UV.z... (kept in the
 * `color` alpha-free channels, so the wind shader reads `position.y` instead).
 */
export function foliageCluster(radius, height, cards = 5, seed = 3) {
  const geos = [];
  for (let i = 0; i < cards; i++) {
    const a = (i / cards) * Math.PI + hash3(i, seed, 1, seed) * 0.4;
    const w = radius * 2 * (0.75 + hash3(i, 2, seed, seed) * 0.5);
    const h = height * (0.8 + hash3(i, 3, seed, seed) * 0.4);
    const g = planeXY(w, h);
    g.translate(0, h * 0.5, 0);
    g.rotateY(a);
    g.rotateZ((hash3(i, 4, seed, seed) - 0.5) * 0.3);
    g.translate(
      (hash3(i, 5, seed, seed) - 0.5) * radius * 0.5,
      0,
      (hash3(i, 6, seed, seed) - 0.5) * radius * 0.5,
    );
    geos.push(g);
  }
  const merged = mergeList(geos);
  if (!merged) return planeXY(radius * 2, height);
  // Double-sided lighting is handled by the material; give the cards soft
  // upward normals so they read as volume rather than flat cards.
  const pos = merged.getAttribute('position');
  const nrm = merged.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) {
    _v.set(pos.getX(i), pos.getY(i) * 0.4 + 0.6, pos.getZ(i)).normalize();
    nrm.setXYZ(i, _v.x, _v.y, _v.z);
  }
  nrm.needsUpdate = true;
  return merged;
}

/**
 * A grass tuft fan — three crossed blades. Cheap enough to instance thousands
 * of times, and reads correctly at RC scale (a blade is ~4 cm).
 */
export function grassTuft(height = 0.09, width = 0.02, blades = 3, seed = 1) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI + hash3(b, seed, 0, seed) * 0.8;
    const ca = Math.cos(a), sa = Math.sin(a);
    const h = height * (0.7 + hash3(b, 1, seed, seed) * 0.6);
    const bend = (hash3(b, 2, seed, seed) - 0.5) * h * 0.5;
    const base = positions.length / 3;
    const hw = width * 0.5;
    positions.push(-hw * ca, 0, -hw * sa);
    positions.push(hw * ca, 0, hw * sa);
    positions.push(bend * ca, h, bend * sa);
    for (let k = 0; k < 3; k++) normals.push(-sa * 0.3, 0.9, ca * 0.3);
    uvs.push(0, 0, width, 0, width * 0.5, h);
    indices.push(base, base + 1, base + 2);
  }
  return finish(positions, normals, uvs, indices);
}

/** Helper: pack arrays into a BufferGeometry. */
function finish(positions, normals, uvs, indices) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  const maxIdx = positions.length / 3;
  const idx = maxIdx > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

// ═══════════════════════════════════════════════════════════ wind animation

/**
 * Patch a `MeshStandardMaterial` so its vertices sway. Used for hedges, shrubs
 * and grass in the garden.
 *
 * The sway is driven by a uniform the caller advances (`mat.userData.wind.time`),
 * scaled by the vertex's height above the object's base so the trunk stays put.
 * Composes safely with the CSM hook the render system installs later: we set a
 * distinct `customProgramCacheKey` so three does not reuse a non-swaying
 * program, and we only touch the *vertex* shader (CSM edits the fragment one).
 *
 * @param {THREE.Material} mat cloned before patching if `clone` is true
 * @param {{strength?:number, frequency?:number, scale?:number, base?:number, clone?:boolean}} [o]
 */
export function makeWindMaterial(mat, o = {}) {
  const m = o.clone === false ? mat : mat.clone();
  const strength = o.strength ?? 0.06;
  const frequency = o.frequency ?? 1.35;
  const scale = o.scale ?? 0.55;
  const base = o.base ?? 0.0;
  const uniforms = {
    uWindTime: { value: 0 },
    uWindStrength: { value: strength },
    uWindFreq: { value: frequency },
    uWindScale: { value: scale },
    uWindBase: { value: base },
    uWindDir: { value: new THREE.Vector2(0.86, 0.5) },
  };
  m.userData = m.userData || {};
  m.userData.wind = { uniforms, time: 0 };
  m.name = `${mat.name || 'mat'}:wind`;

  const prev = (typeof m.onBeforeCompile === 'function'
    && m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) ? m.onBeforeCompile : null;

  m.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `
      uniform float uWindTime;
      uniform float uWindStrength;
      uniform float uWindFreq;
      uniform float uWindScale;
      uniform float uWindBase;
      uniform vec2  uWindDir;
      ${shader.vertexShader}`
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          float hgt = max( 0.0, transformed.y - uWindBase );
          float amp = uWindStrength * hgt * uWindScale;
          float ph  = uWindTime * uWindFreq + wp.x * 0.55 + wp.z * 0.41;
          float gust = 0.65 + 0.35 * sin( uWindTime * 0.23 + wp.x * 0.05 );
          float s1 = sin( ph );
          float s2 = sin( ph * 2.17 + 1.7 ) * 0.35;
          vec2 off = uWindDir * ( ( s1 + s2 ) * amp * gust );
          transformed.x += off.x;
          transformed.z += off.y;
          transformed.y -= abs( off.x + off.y ) * 0.18;
        }`,
      );
  };
  const baseKey = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = function () {
    return `wind|${strength}|${frequency}|${scale}|${base}|${baseKey ? baseKey() : ''}`;
  };
  m.needsUpdate = true;
  return m;
}

/** Advance every wind material handed to it. */
export function updateWindMaterials(mats, dt) {
  for (let i = 0; i < mats.length; i++) {
    const w = mats[i]?.userData?.wind;
    if (!w) continue;
    w.time += dt;
    w.uniforms.uWindTime.value = w.time;
  }
}

export default {
  boxMeters, roundedBox, planeXZ, planeXY, discXZ, ringXZ, cylinderMeters,
  sphereMeters, torusMeters, latheMeters, extrudeOutline, polygonXZ, wedge,
  stairsGeo, beamBetween, ropeBetween, tubeAlong, frameGeo, moundGeo,
  foliageCluster, grassTuft, mergeList, normalizeForMerge, ensureIndexed,
  scaleUV, planarUV, boxUV, setColor, colorize, gradientColor, flipGeometry,
  roughen, trs, hash3, makeWindMaterial, updateWindMaterials,
};
