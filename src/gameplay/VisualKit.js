/**
 * VisualKit — every mesh, ribbon and flare the gameplay layer draws.
 *
 * 100% generated in code (three primitives + hand-built BufferGeometry), all
 * geometry and materials memoised on `game.assets` so a field of eight cars
 * firing everything at once still shares one set of GPU resources.
 *
 * Nothing here allocates per frame: the ribbon/bolt/ring classes own typed
 * arrays and rewrite them in place.
 */

import * as THREE from 'three';
import { getMaterials } from '../render/Materials.js';

// ── scratch ────────────────────────────────────────────────────────────────
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const _q = new THREE.Quaternion();

/** Shared MaterialLibrary (null-safe). */
export function mats(game) {
  try { return getMaterials(game); } catch { return null; }
}

function geo(game, key, factory) {
  const g = game?.assets?.geometry?.(key, factory);
  return g ?? factory();
}

function mat(game, key, factory) {
  const m = game?.assets?.material?.(key, factory);
  return m ?? factory();
}

/** Bright unlit additive material — flares, trails, bolts, shock rings. */
export function additive(game, color = 0xffffff, opacity = 1) {
  const key = `gp/add/${(color >>> 0).toString(16)}/${opacity.toFixed(2)}`;
  return mat(game, key, () => new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  }));
}

/** Lit emissive material for solid glowing bodies (pad cores, nozzles). */
export function glow(game, color = 0xffffff, intensity = 2.4, opts = {}) {
  const M = mats(game);
  if (M) return M.emissive(color, intensity, opts);
  const key = `gp/glow/${(color >>> 0).toString(16)}/${intensity}`;
  return mat(game, key, () => new THREE.MeshStandardMaterial({
    color: opts.base ?? 0x0a0a0a, emissive: color, emissiveIntensity: intensity,
    roughness: 0.35, metalness: 0,
  }));
}

/** Vertex-coloured workhorse for small solid props (fins, fuses, debris). */
export function solid(game, color = 0xcccccc, { roughness = 0.5, metalness = 0.1 } = {}) {
  const key = `gp/solid/${(color >>> 0).toString(16)}/${roughness}/${metalness}`;
  return mat(game, key, () => new THREE.MeshStandardMaterial({
    color, roughness, metalness, dithering: true,
  }));
}

/** Chrome for the ball bearing — uses the procedural chrome family when present. */
export function chrome(game) {
  const M = mats(game);
  if (M) {
    try { return M.get('metal/chrome', { sizeMeters: 0.25 }); } catch { /* fall through */ }
  }
  return solid(game, 0xdfe6ee, { roughness: 0.08, metalness: 1.0 });
}

// ═══════════════════════════════════════════════════════════════ pickup pad

/**
 * A floating pickup pad: base ring, spinning core, ground glow.
 * `mesh.userData.parts = { ring, core, glow, halo }` for the animator.
 */
export function buildPadMesh(game, opts = {}) {
  const radius = opts.radius ?? 0.15;
  const color = opts.color ?? 0x51e2ff;
  const group = new THREE.Group();
  group.name = 'pickupPad';

  const ringGeo = geo(game, `gp/pad/ring/${radius}`, () =>
    new THREE.TorusGeometry(radius, radius * 0.09, 6, 28));
  const ring = new THREE.Mesh(ringGeo, glow(game, color, 2.2));
  ring.rotation.x = -Math.PI / 2;
  ring.castShadow = false;
  ring.receiveShadow = false;
  group.add(ring);

  const coreGeo = geo(game, `gp/pad/core/${radius}`, () =>
    new THREE.IcosahedronGeometry(radius * 0.42, 0));
  const core = new THREE.Mesh(coreGeo, glow(game, 0xffffff, 3.4, { base: 0x102030 }));
  core.position.y = radius * 0.36;
  group.add(core);

  // Additive halo shell around the core — reads at any distance.
  const haloGeo = geo(game, `gp/pad/halo/${radius}`, () =>
    new THREE.IcosahedronGeometry(radius * 0.72, 1));
  const halo = new THREE.Mesh(haloGeo, additive(game, color, 0.30));
  halo.position.y = core.position.y;
  group.add(halo);

  const glowGeo = geo(game, `gp/pad/glow/${radius}`, () => {
    const g = new THREE.CircleGeometry(radius * 1.25, 22);
    g.rotateX(-Math.PI / 2);
    return g;
  });
  const ground = new THREE.Mesh(glowGeo, additive(game, color, 0.22));
  ground.position.y = 0.004;
  group.add(ground);

  group.userData.parts = { ring, core, halo, glow: ground };
  group.userData.baseColor = color;
  return group;
}

// ═══════════════════════════════════════════════════════════════ projectiles

/** Firework rocket: nose cone, body, three fins, glowing nozzle. -Z is forward. */
export function buildRocketMesh(game, opts = {}) {
  const L = opts.length ?? 0.11;
  const R = opts.radius ?? 0.019;
  const body = new THREE.Group();
  body.name = 'firework';

  const tubeGeo = geo(game, `gp/rk/tube/${L}/${R}`, () => {
    const g = new THREE.CylinderGeometry(R, R, L * 0.66, 10, 1, false);
    g.rotateX(Math.PI / 2);
    return g;
  });
  const tube = new THREE.Mesh(tubeGeo, solid(game, 0xd93b2b, { roughness: 0.45, metalness: 0.15 }));
  body.add(tube);

  const noseGeo = geo(game, `gp/rk/nose/${L}/${R}`, () => {
    const g = new THREE.ConeGeometry(R, L * 0.34, 10);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -L * 0.5);
    return g;
  });
  const nose = new THREE.Mesh(noseGeo, solid(game, 0xf4f1e4, { roughness: 0.35 }));
  body.add(nose);

  const finGeo = geo(game, `gp/rk/fin/${R}`, () =>
    new THREE.BoxGeometry(R * 0.22, R * 1.7, L * 0.24));
  const finMat = solid(game, 0x2a2f38, { roughness: 0.6 });
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(finGeo, finMat);
    fin.position.z = L * 0.26;
    fin.rotation.z = (i / 3) * Math.PI * 2;
    fin.position.x = Math.sin(fin.rotation.z) * R * 0.85;
    fin.position.y = Math.cos(fin.rotation.z) * R * 0.85;
    body.add(fin);
  }

  const flameGeo = geo(game, `gp/rk/flame/${R}`, () => {
    const g = new THREE.ConeGeometry(R * 1.15, L * 0.9, 8, 1, true);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, L * 0.72);
    return g;
  });
  const flame = new THREE.Mesh(flameGeo, additive(game, 0xffb457, 0.85));
  body.add(flame);

  body.userData.parts = { flame, nose, tube };
  return body;
}

/** Heavy chromed ball bearing. */
export function buildBearingMesh(game, radius = 0.042) {
  const g = geo(game, `gp/bearing/${radius}`, () => new THREE.IcosahedronGeometry(radius, 2));
  const m = new THREE.Mesh(g, chrome(game));
  m.name = 'ballBearing';
  m.castShadow = true;
  return m;
}

/** Wobbly translucent water balloon. */
export function buildBalloonMesh(game, radius = 0.048) {
  const g = geo(game, `gp/balloon/${radius}`, () => new THREE.SphereGeometry(radius, 14, 10));
  const M = mats(game);
  let m;
  if (M) {
    try { m = M.get('glass/frosted', { color: 0x4fc3ff, opacity: 0.72, transparent: true }); }
    catch { m = null; }
  }
  m ??= mat(game, 'gp/balloonMat', () => new THREE.MeshStandardMaterial({
    color: 0x4fc3ff, roughness: 0.22, metalness: 0, transparent: true, opacity: 0.74,
  }));
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'waterBalloon';
  const knotGeo = geo(game, `gp/balloonKnot/${radius}`, () =>
    new THREE.ConeGeometry(radius * 0.3, radius * 0.5, 7));
  const knot = new THREE.Mesh(knotGeo, solid(game, 0x2c7fb0, { roughness: 0.5 }));
  knot.position.y = -radius * 1.05;
  knot.rotation.x = Math.PI;
  mesh.add(knot);
  return mesh;
}

/** Cartoon bomb: black sphere, brass cap, fuse, spark. */
export function buildBombMesh(game, radius = 0.045) {
  const group = new THREE.Group();
  group.name = 'bomb';

  const ballGeo = geo(game, `gp/bomb/ball/${radius}`, () => new THREE.SphereGeometry(radius, 16, 12));
  const ball = new THREE.Mesh(ballGeo, solid(game, 0x14161c, { roughness: 0.38, metalness: 0.35 }));
  group.add(ball);

  const capGeo = geo(game, `gp/bomb/cap/${radius}`, () =>
    new THREE.CylinderGeometry(radius * 0.34, radius * 0.42, radius * 0.36, 10));
  const cap = new THREE.Mesh(capGeo, solid(game, 0xb9862f, { roughness: 0.3, metalness: 0.8 }));
  cap.position.y = radius * 0.94;
  group.add(cap);

  const fuseGeo = geo(game, `gp/bomb/fuse/${radius}`, () => {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(radius * 0.18, radius * 0.5, radius * 0.1),
      new THREE.Vector3(-radius * 0.1, radius * 0.9, -radius * 0.15),
      new THREE.Vector3(radius * 0.22, radius * 1.25, 0),
    ]);
    return new THREE.TubeGeometry(curve, 10, radius * 0.07, 5, false);
  });
  const fuse = new THREE.Mesh(fuseGeo, solid(game, 0xa08a5c, { roughness: 0.85 }));
  fuse.position.y = radius * 1.05;
  group.add(fuse);

  const sparkGeo = geo(game, `gp/bomb/spark/${radius}`, () =>
    new THREE.IcosahedronGeometry(radius * 0.24, 0));
  const spark = new THREE.Mesh(sparkGeo, additive(game, 0xfff0b0, 1));
  spark.position.set(radius * 0.22, radius * 2.32, 0);
  group.add(spark);

  const haloGeo = geo(game, `gp/bomb/halo/${radius}`, () =>
    new THREE.IcosahedronGeometry(radius * 0.55, 1));
  const halo = new THREE.Mesh(haloGeo, additive(game, 0xffb040, 0.28));
  halo.position.copy(spark.position);
  group.add(halo);

  group.userData.parts = { ball, spark, halo, fuse, cap };
  return group;
}

/** Iridescent shield bubble, sized to wrap a car. */
export function buildShieldMesh(game, radius = 0.20) {
  const g = geo(game, `gp/shield/${radius}`, () => new THREE.SphereGeometry(radius, 20, 14));
  const M = mats(game);
  let m = null;
  if (M) { try { m = M.bubble({ tint: 0xbfe8ff }); } catch { m = null; } }
  m ??= mat(game, 'gp/shieldMat', () => new THREE.MeshStandardMaterial({
    color: 0xbfe8ff, roughness: 0.05, metalness: 0.15,
    transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false,
  }));
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'shieldBubble';
  mesh.renderOrder = 6;
  // A faint additive rim so the bubble survives bright environments.
  const rimGeo = geo(game, `gp/shieldRim/${radius}`, () =>
    new THREE.SphereGeometry(radius * 1.02, 18, 12));
  const rim = new THREE.Mesh(rimGeo, additive(game, 0x8fd8ff, 0.16));
  mesh.add(rim);
  mesh.userData.parts = { rim };
  return mesh;
}

/**
 * Oil slick decal: an irregular blob in the XZ plane with an upward normal
 * (correct winding so the physics collision mesh accepts it as a floor).
 * @returns {THREE.BufferGeometry}
 */
export function buildOilGeometry(seed = 1, radius = 0.34, segments = 22) {
  const verts = new Float32Array((segments + 1) * 3);
  const norms = new Float32Array((segments + 1) * 3);
  const uvs = new Float32Array((segments + 1) * 2);
  const idx = new Uint16Array(segments * 3);

  // Deterministic lobe shape from the seed.
  const s = (seed * 0.618033) % 1;
  const l1 = 2 + Math.floor(s * 3);
  const l2 = 5 + Math.floor(((seed * 0.381966) % 1) * 4);
  const ph1 = s * Math.PI * 2;
  const ph2 = ((seed * 0.7548) % 1) * Math.PI * 2;

  norms[1] = 1;
  uvs[0] = 0.5; uvs[1] = 0.5;
  for (let i = 0; i < segments; i++) {
    const th = (i / segments) * Math.PI * 2;
    const r = radius * (1
      + 0.20 * Math.sin(th * l1 + ph1)
      + 0.11 * Math.sin(th * l2 + ph2)
      - 0.06);
    const x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    const o = (i + 1) * 3;
    verts[o] = x; verts[o + 1] = 0; verts[o + 2] = z;
    norms[o + 1] = 1;
    uvs[(i + 1) * 2] = x / (radius * 2.6) + 0.5;
    uvs[(i + 1) * 2 + 1] = z / (radius * 2.6) + 0.5;
  }
  for (let i = 0; i < segments; i++) {
    const a = i + 1;
    const b = ((i + 1) % segments) + 1;
    // (centre, next, current) → +Y normal
    idx[i * 3] = 0; idx[i * 3 + 1] = b; idx[i * 3 + 2] = a;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(norms, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/** Dark, rainbow-sheened oil material (uses the hazard/oil_slick family). */
export function oilMaterial(game) {
  const M = mats(game);
  if (M) {
    try {
      const m = M.get('hazard/oil_slick', { sizeMeters: 0.8, transparent: true, opacity: 0.94 });
      if (m) return m;
    } catch { /* fall through */ }
  }
  return mat(game, 'gp/oilMat', () => new THREE.MeshStandardMaterial({
    color: 0x14131a, roughness: 0.06, metalness: 0.55,
    transparent: true, opacity: 0.92, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }));
}

// ═══════════════════════════════════════════════════════════════ ribbon

/**
 * Camera-facing tapered ribbon used for smoke trails and lightning bolts.
 * Additive, so the tail fades to black rather than needing per-vertex alpha.
 */
export class TrailRibbon {
  /**
   * @param {object} game
   * @param {{points?:number, width?:number, color?:number, taper?:number,
   *          headWidth?:number, name?:string}} [opts]
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.max = Math.max(4, opts.points ?? 26);
    this.width = opts.width ?? 0.026;
    this.headWidth = opts.headWidth ?? 0.45;
    this.taper = opts.taper ?? 1.35;
    this.color = new THREE.Color(opts.color ?? 0xffffff);
    /** Brightness scale applied on top of the colour. */
    this.intensity = 1;

    this._pts = new Float32Array(this.max * 3);
    this._count = 0;

    const verts = this.max * 2;
    this._positions = new Float32Array(verts * 3);
    this._colors = new Float32Array(verts * 3);
    const tri = (this.max - 1) * 6;
    const idx = new Uint16Array(tri);
    for (let i = 0; i < this.max - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      idx[i * 6] = a; idx[i * 6 + 1] = b; idx[i * 6 + 2] = c;
      idx[i * 6 + 3] = b; idx[i * 6 + 4] = d; idx[i * 6 + 5] = c;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this._colors, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.geometry = g;

    this.material = mat(game, 'gp/ribbonMat', () => new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    }));

    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = opts.name ?? 'trailRibbon';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  reset(pos = null) {
    this._count = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
    if (pos) { this.push(pos); this.push(pos); }
  }

  /** Record a new head point (oldest is dropped once full). */
  push(pos) {
    const p = this._pts;
    if (this._count >= this.max) {
      // Shift down by one — max is small (≤ 32) so this is cheaper than a ring
      // plus the per-frame unwrap it would need.
      p.copyWithin(0, 3, this.max * 3);
      this._count = this.max - 1;
    }
    const o = this._count * 3;
    p[o] = pos.x; p[o + 1] = pos.y; p[o + 2] = pos.z;
    this._count++;
  }

  /** Move the head point without adding a new one (per-frame smoothing). */
  moveHead(pos) {
    if (this._count === 0) { this.push(pos); return; }
    const o = (this._count - 1) * 3;
    this._pts[o] = pos.x; this._pts[o + 1] = pos.y; this._pts[o + 2] = pos.z;
  }

  /** Rebuild the billboard strip. `fade` 0..1 scales the whole ribbon. */
  update(camera, fade = 1) {
    const n = this._count;
    if (n < 2 || fade <= 0.001) { this.mesh.visible = false; return; }
    buildRibbon(this._pts, n, this._positions, this._colors,
      camera, this.color, this.intensity * fade, this.width, this.headWidth, this.taper);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
    this.mesh.visible = true;
  }

  hide() { this.mesh.visible = false; }

  dispose() {
    this.geometry.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/**
 * Fill a billboarded triangle strip from a polyline. Shared by trails + bolts.
 * Head (last point) is brightest and narrowest-to-widest per `headWidth`.
 */
function buildRibbon(pts, n, positions, colors, camera, color, intensity, width, headWidth, taper) {
  const camPos = camera?.position;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    _a.set(pts[o], pts[o + 1], pts[o + 2]);
    // Segment direction (forward difference, backward at the end).
    if (i < n - 1) _b.set(pts[o + 3], pts[o + 4], pts[o + 5]);
    else _b.set(pts[o - 3], pts[o - 2], pts[o - 1]);
    _dir.copy(_b).sub(_a);
    if (i === n - 1) _dir.negate();
    if (_dir.lengthSq() < 1e-12) _dir.copy(_up);
    else _dir.normalize();

    if (camPos) _toCam.copy(camPos).sub(_a);
    else _toCam.set(0, 0, 1);
    _side.crossVectors(_dir, _toCam);
    if (_side.lengthSq() < 1e-12) _side.crossVectors(_dir, _up);
    if (_side.lengthSq() < 1e-12) _side.set(1, 0, 0);
    _side.normalize();

    // t = 0 at the tail, 1 at the head.
    const t = n > 1 ? i / (n - 1) : 1;
    const w = width * (headWidth + (1 - headWidth) * Math.pow(t, 0.6));
    const bright = intensity * Math.pow(t, taper);

    const v0 = i * 6, v1 = v0 + 3;
    positions[v0] = _a.x + _side.x * w;
    positions[v0 + 1] = _a.y + _side.y * w;
    positions[v0 + 2] = _a.z + _side.z * w;
    positions[v1] = _a.x - _side.x * w;
    positions[v1 + 1] = _a.y - _side.y * w;
    positions[v1 + 2] = _a.z - _side.z * w;

    const r = color.r * bright, g = color.g * bright, b = color.b * bright;
    colors[v0] = r; colors[v0 + 1] = g; colors[v0 + 2] = b;
    colors[v1] = r; colors[v1 + 1] = g; colors[v1 + 2] = b;
  }
}

// ═══════════════════════════════════════════════════════════════ lightning

/** Jagged chain-lightning bolt between two points, with a couple of branches. */
export class Bolt {
  constructor(game, opts = {}) {
    this.game = game;
    this.segments = opts.segments ?? 15;
    this.jitter = opts.jitter ?? 0.16;
    this.branches = opts.branches ?? 2;
    this.life = 0;
    this.duration = 0;
    /** @type {TrailRibbon[]} main + branch ribbons */
    this.ribbons = [];
    this.group = new THREE.Group();
    this.group.name = 'bolt';
    this.group.visible = false;

    const color = opts.color ?? 0xa8e4ff;
    for (let i = 0; i <= this.branches; i++) {
      const r = new TrailRibbon(game, {
        points: this.segments,
        width: (opts.width ?? 0.022) * (i === 0 ? 1 : 0.55),
        color,
        headWidth: 1,
        taper: 0.25,
        name: `boltSeg${i}`,
      });
      r.intensity = i === 0 ? 1.6 : 0.9;
      this.ribbons.push(r);
      this.group.add(r.mesh);
    }
  }

  /**
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3} to
   * @param {number} duration seconds
   * @param {()=>number} rnd 0..1 source
   */
  strike(from, to, duration = 0.42, rnd = Math.random) {
    this.duration = duration;
    this.life = duration;
    const len = from.distanceTo(to);
    const jit = this.jitter * Math.min(1, len * 0.6);

    for (let bi = 0; bi < this.ribbons.length; bi++) {
      const r = this.ribbons[bi];
      r.reset();
      // Branches split off part-way and end short of the target.
      const startF = bi === 0 ? 0 : 0.25 + rnd() * 0.35;
      const endF = bi === 0 ? 1 : startF + 0.22 + rnd() * 0.3;
      const segs = bi === 0 ? this.segments : Math.max(4, (this.segments * 0.5) | 0);
      for (let i = 0; i < segs; i++) {
        const f = startF + (endF - startF) * (i / (segs - 1));
        _a.lerpVectors(from, to, Math.min(1, f));
        if (i > 0 && i < segs - 1) {
          const s = jit * (bi === 0 ? 1 : 1.5) * Math.sin(Math.PI * (i / (segs - 1)));
          _a.x += (rnd() - 0.5) * s;
          _a.y += (rnd() - 0.5) * s + s * 0.25;
          _a.z += (rnd() - 0.5) * s;
        }
        r.push(_a);
      }
    }
    this.group.visible = true;
  }

  /** @returns {boolean} still alive */
  update(dt, camera) {
    if (this.life <= 0) { this.group.visible = false; return false; }
    this.life -= dt;
    if (this.life <= 0) { this.group.visible = false; return false; }
    const t = this.life / this.duration;
    // Flicker: lightning does not fade smoothly.
    const flick = 0.55 + 0.45 * Math.sin(this.life * 90) * Math.sin(this.life * 37);
    const fade = t * (0.6 + 0.4 * flick);
    for (let i = 0; i < this.ribbons.length; i++) this.ribbons[i].update(camera, fade);
    return true;
  }

  hide() {
    this.group.visible = false;
    this.life = 0;
    for (let i = 0; i < this.ribbons.length; i++) this.ribbons[i].hide();
  }

  dispose() {
    for (const r of this.ribbons) r.dispose();
    this.group.parent?.remove(this.group);
  }
}

// ═══════════════════════════════════════════════════════════════ ring wave

/** Expanding ground ring — shockwaves, explosions, pad pops. */
export class RingWave {
  constructor(game, opts = {}) {
    const inner = opts.inner ?? 0.80;
    const seg = opts.segments ?? 44;
    const g = geo(game, `gp/ring/${inner}/${seg}`, () => {
      const r = new THREE.RingGeometry(inner, 1, seg, 1);
      r.rotateX(-Math.PI / 2);
      return r;
    });
    this.material = additive(game, opts.color ?? 0xffffff, 0.9).clone();
    this.material.transparent = true;
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'ringWave';
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.life = 0;
    this.duration = 0;
    this.radius = 1;
    this.baseOpacity = opts.opacity ?? 0.85;
  }

  fire(pos, radius, duration = 0.45, normal = null, color = null) {
    this.mesh.position.copy(pos);
    if (normal) {
      _q.setFromUnitVectors(_up, normal);
      this.mesh.quaternion.copy(_q);
    } else {
      this.mesh.quaternion.identity();
    }
    if (color != null) this.material.color.set(color);
    this.radius = radius;
    this.duration = duration;
    this.life = duration;
    this.mesh.scale.setScalar(0.02);
    this.mesh.visible = true;
    this.material.opacity = this.baseOpacity;
    return this;
  }

  update(dt) {
    if (this.life <= 0) return false;
    this.life -= dt;
    if (this.life <= 0) { this.mesh.visible = false; return false; }
    const t = 1 - this.life / this.duration;
    const e = 1 - Math.pow(1 - t, 2.4);      // fast out, slow settle
    this.mesh.scale.setScalar(Math.max(0.02, this.radius * e));
    this.material.opacity = this.baseOpacity * (1 - t) * (1 - t);
    return true;
  }

  hide() { this.mesh.visible = false; this.life = 0; }

  dispose() {
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

// ═══════════════════════════════════════════════════════════════ burst

/** Explosion flash: additive core shell + expanding ring + a smoke puff shell. */
export class Burst {
  constructor(game, opts = {}) {
    this.group = new THREE.Group();
    this.group.name = 'burst';
    this.group.visible = false;

    const shellGeo = geo(game, 'gp/burst/shell', () => new THREE.IcosahedronGeometry(1, 2));
    this.coreMat = additive(game, opts.color ?? 0xffd08a, 1).clone();
    this.core = new THREE.Mesh(shellGeo, this.coreMat);
    this.group.add(this.core);

    this.flashMat = additive(game, opts.flash ?? 0xffffff, 1).clone();
    this.flash = new THREE.Mesh(shellGeo, this.flashMat);
    this.group.add(this.flash);

    this.smokeMat = mat(game, 'gp/burst/smokeMat', () => new THREE.MeshStandardMaterial({
      color: 0x2b2b30, roughness: 1, metalness: 0,
      transparent: true, opacity: 0.5, depthWrite: false, flatShading: true,
    })).clone();
    this.smoke = new THREE.Mesh(shellGeo, this.smokeMat);
    this.group.add(this.smoke);

    this.ring = new RingWave(game, { color: opts.ring ?? 0xffc070, inner: 0.72 });
    this.group.add(this.ring.mesh);

    this.life = 0;
    this.duration = 0;
    this.radius = 1;
  }

  fire(pos, radius = 1.0, duration = 0.55, normal = null) {
    this.group.position.copy(pos);
    this.radius = radius;
    this.duration = duration;
    this.life = duration;
    this.group.visible = true;
    this.core.scale.setScalar(radius * 0.18);
    this.flash.scale.setScalar(radius * 0.10);
    this.smoke.scale.setScalar(radius * 0.22);
    this.coreMat.opacity = 1;
    this.flashMat.opacity = 1;
    this.smokeMat.opacity = 0.0;
    // Rings look best flat on the ground; use the impact normal when we have one.
    this.ring.mesh.position.set(0, 0.012, 0);
    this.ring.fire(this.ring.mesh.position, radius * 1.5, duration * 1.5, normal);
    this.ring.mesh.position.set(0, 0.012, 0);
    return this;
  }

  update(dt) {
    if (this.life <= 0) { this.group.visible = false; return false; }
    this.life -= dt;
    this.ring.update(dt);
    if (this.life <= 0) { this.group.visible = false; this.ring.hide(); return false; }
    const t = 1 - this.life / this.duration;
    const e = 1 - Math.pow(1 - t, 3);
    this.flash.scale.setScalar(this.radius * (0.10 + 0.85 * e));
    this.flashMat.opacity = Math.max(0, 1 - t * 4.2);
    this.core.scale.setScalar(this.radius * (0.18 + 0.72 * e));
    this.coreMat.opacity = Math.max(0, (1 - t) * (1 - t) * 1.2);
    this.smoke.scale.setScalar(this.radius * (0.22 + 1.15 * e));
    this.smokeMat.opacity = 0.52 * Math.sin(Math.min(1, t * 1.15) * Math.PI) ** 0.7;
    this.group.rotation.y += dt * 0.9;
    return true;
  }

  hide() { this.group.visible = false; this.life = 0; this.ring.hide(); }

  dispose() {
    this.coreMat.dispose(); this.flashMat.dispose(); this.smokeMat.dispose();
    this.ring.dispose();
    this.group.parent?.remove(this.group);
  }
}

// ═══════════════════════════════════════════════════════════════ splash

/** Water-balloon burst: a flat expanding splat plus a dome of droplets. */
export class Splash {
  constructor(game, opts = {}) {
    this.group = new THREE.Group();
    this.group.name = 'splash';
    this.group.visible = false;

    const domeGeo = geo(game, 'gp/splash/dome', () => {
      const g = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
      return g;
    });
    this.domeMat = mat(game, 'gp/splash/mat', () => new THREE.MeshStandardMaterial({
      color: 0x9fdcff, roughness: 0.12, metalness: 0,
      transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
    })).clone();
    this.dome = new THREE.Mesh(domeGeo, this.domeMat);
    this.group.add(this.dome);

    this.ring = new RingWave(game, { color: opts.color ?? 0x9fdcff, inner: 0.62 });
    this.group.add(this.ring.mesh);

    this.life = 0; this.duration = 0; this.radius = 1;
  }

  fire(pos, radius = 0.5, duration = 0.6, normal = null) {
    this.group.position.copy(pos);
    this.radius = radius;
    this.duration = duration;
    this.life = duration;
    this.group.visible = true;
    this.dome.scale.set(radius * 0.2, radius * 0.15, radius * 0.2);
    this.domeMat.opacity = 0.6;
    this.ring.mesh.position.set(0, 0.01, 0);
    this.ring.fire(this.ring.mesh.position, radius * 2.2, duration * 1.3, normal, 0xbfeaff);
    this.ring.mesh.position.set(0, 0.01, 0);
    return this;
  }

  update(dt) {
    if (this.life <= 0) { this.group.visible = false; return false; }
    this.life -= dt;
    this.ring.update(dt);
    if (this.life <= 0) { this.group.visible = false; this.ring.hide(); return false; }
    const t = 1 - this.life / this.duration;
    const e = 1 - Math.pow(1 - t, 2.2);
    this.dome.scale.set(
      this.radius * (0.2 + 1.0 * e),
      this.radius * (0.15 + 0.9 * Math.sin(Math.min(1, t * 1.4) * Math.PI * 0.8)),
      this.radius * (0.2 + 1.0 * e),
    );
    this.domeMat.opacity = 0.6 * (1 - t) ** 1.5;
    return true;
  }

  hide() { this.group.visible = false; this.life = 0; this.ring.hide(); }

  dispose() {
    this.domeMat.dispose();
    this.ring.dispose();
    this.group.parent?.remove(this.group);
  }
}

export default {
  mats, additive, glow, solid, chrome,
  buildPadMesh, buildRocketMesh, buildBearingMesh, buildBalloonMesh,
  buildBombMesh, buildShieldMesh, buildOilGeometry, oilMaterial,
  TrailRibbon, Bolt, RingWave, Burst, Splash,
};
