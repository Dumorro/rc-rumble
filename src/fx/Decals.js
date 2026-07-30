/**
 * RC RUMBLE — pooled decal projector.
 *
 * Scorch marks, oil slicks, water rings, wet patches and dirt splats are
 * *projected* onto the track's collision mesh rather than slapped on as a flat
 * quad, so they wrap over kerbs, ramps and the lip of a table without floating
 * or clipping.
 *
 * How it works
 * ------------
 * 1. Build an oriented box (the projector) around the impact point, aligned to
 *    the surface normal.
 * 2. Ask the collision BVH for the triangles in the box's world AABB.
 * 3. Reject back-facing triangles, then clip each survivor against the box's six
 *    planes with Sutherland–Hodgman and fan-triangulate the result.
 * 4. Write the triangles into a fixed-stride slot of one big non-indexed
 *    geometry, with UVs from the projector basis and a per-vertex birth time.
 *
 * The whole thing runs once per decal (never per frame), and slots are a ring
 * buffer capped by `CONFIG.fx.decalLimit`. The fade is a GPU-side function of
 * the birth time, so live decals cost nothing on the CPU.
 *
 * Spawn requests are queued and at most `maxPerFrame` are built per frame, so a
 * ten-car pile-up cannot produce a hitch.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp01 } from '../core/MathUtils.js';
import { SPR, ATLAS_COLS, ATLAS_ROWS } from './ParticleAtlas.js';
import { toLinearRGB, frand } from './ParticleSystem.js';

/** Triangles per slot. A 0.5 m decal on a typical track lands ~10–30. */
const TRIS_PER_SLOT = 40;
const VERTS_PER_SLOT = TRIS_PER_SLOT * 3;

const VERT_SHADER = /* glsl */`
precision highp float;

attribute vec4 aColor;      // rgb (linear) + peak alpha
attribute vec4 aParams;     // x = birth, y = life, z = fadeIn, w = unused

uniform float uNow;

varying vec2 vUv;
varying vec4 vColor;
varying float vFade;

#ifdef USE_FOG
  varying float vFogDepth;
#endif

void main() {
  vUv = uv;
  vColor = aColor;

  float age = uNow - aParams.x;
  float life = max( aParams.y, 0.001 );
  float inT = max( aParams.z, 0.0001 );
  float grow = clamp( age / inT, 0.0, 1.0 );
  float out_ = 1.0 - clamp( age / life, 0.0, 1.0 );
  // ease the tail so a decal dissolves instead of blinking out
  vFade = grow * out_ * out_;

  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  #ifdef USE_FOG
    vFogDepth = - mv.z;
  #endif
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG_SHADER = /* glsl */`
precision highp float;

uniform sampler2D uAtlas;
uniform vec2 uAtlasTiles;

varying vec2 vUv;
varying vec4 vColor;
varying float vFade;

#ifdef USE_FOG
  uniform vec3 fogColor;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  varying float vFogDepth;
#endif

void main() {
  if ( vFade <= 0.002 ) discard;
  // vUv already carries the atlas cell offset baked in by the CPU side, so the
  // fragment shader is a straight sample.
  vec4 tex = texture2D( uAtlas, vUv );
  float a = tex.a * vColor.a * vFade;
  if ( a < 0.004 ) discard;
  vec3 rgb = tex.rgb * vColor.rgb;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogF = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    rgb = mix( rgb, fogColor, fogF );
  #endif
  gl_FragColor = vec4( rgb * a, a );
}
`;

// ─────────────────────────────────────────────────────────── scratch

const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _triN = new THREE.Vector3();

const _triIndices = new Uint32Array(4096);

/**
 * Sutherland–Hodgman clip buffers, in *projector space* (x,y ∈ [-1,1] across the
 * decal, z along the normal). Fixed size, reused, never reallocated.
 */
const CLIP_MAX = 24;
const _clipA = new Float32Array(CLIP_MAX * 3);
const _clipB = new Float32Array(CLIP_MAX * 3);

/**
 * Clip a polygon against `plane`: keeps the half-space where
 * `dot(p, axis) <= limit` (axis given as an index 0/1/2 and a sign).
 * @returns {number} new vertex count
 */
function clipAxis(src, srcCount, dst, axis, sign, limit) {
  let out = 0;
  for (let i = 0; i < srcCount; i++) {
    const j = (i + 1) % srcCount;
    const ix = i * 3, jx = j * 3;
    const di = sign * src[ix + axis] - limit;
    const dj = sign * src[jx + axis] - limit;
    const inI = di <= 0;
    const inJ = dj <= 0;
    if (inI) {
      if (out >= CLIP_MAX) return out;
      const o = out * 3;
      dst[o] = src[ix]; dst[o + 1] = src[ix + 1]; dst[o + 2] = src[ix + 2];
      out++;
    }
    if (inI !== inJ) {
      const denom = di - dj;
      const t = denom !== 0 ? di / denom : 0;
      if (out >= CLIP_MAX) return out;
      const o = out * 3;
      dst[o] = src[ix] + (src[jx] - src[ix]) * t;
      dst[o + 1] = src[ix + 1] + (src[jx + 1] - src[ix + 1]) * t;
      dst[o + 2] = src[ix + 2] + (src[jx + 2] - src[ix + 2]) * t;
      out++;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────── decal kinds

/**
 * Built-in decal presets. `sprite` is an atlas tile; `color` is sRGB hex.
 * Consumers can also pass a fully custom descriptor to `project()`.
 */
export const DECAL = Object.freeze({
  scorch: { sprite: SPR.SPLAT, color: 0x171310, alpha: 0.82, life: 26, fadeIn: 0.08, depth: 0.16 },
  soot: { sprite: SPR.SCUFF, variants: 4, color: 0x241d18, alpha: 0.55, life: 18, fadeIn: 0.12, depth: 0.14 },
  oil: { sprite: SPR.SPLAT, color: 0x0a0912, alpha: 0.90, life: 999, fadeIn: 0.25, depth: 0.12 },
  waterRing: { sprite: SPR.RIPPLE, color: 0xa8ccdc, alpha: 0.45, life: 3.2, fadeIn: 0.10, depth: 0.10 },
  wet: { sprite: SPR.SPLAT, color: 0x24313a, alpha: 0.42, life: 7.0, fadeIn: 0.05, depth: 0.10 },
  mud: { sprite: SPR.SPLAT, color: 0x5a4029, alpha: 0.60, life: 14, fadeIn: 0.06, depth: 0.12 },
  dustPatch: { sprite: SPR.SCUFF, variants: 4, color: 0x9a8f7e, alpha: 0.36, life: 9, fadeIn: 0.15, depth: 0.12 },
  frost: { sprite: SPR.SPLAT, color: 0xd8f0ff, alpha: 0.50, life: 10, fadeIn: 0.08, depth: 0.10 },
  glow: { sprite: SPR.RING_SOFT, color: 0xffd090, alpha: 0.70, life: 1.4, fadeIn: 0.03, depth: 0.10 },
});

export class Decals {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {{atlas:THREE.Texture|null, limit?:number}} opts
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.enabled = true;

    this.limit = Math.max(8, opts.limit ?? CONFIG.fx.decalLimit ?? 64);
    this.maxPerFrame = 2;
    /** Lift along the surface normal, metres. Fights z-fighting with the floor. */
    this.lift = 0.0022;

    this.time = 0;
    this.head = 0;
    this._atlas = opts.atlas ?? null;

    this.geometry = null;
    this.material = null;
    this.mesh = null;

    this._pos = null;
    this._uv = null;
    this._col = null;
    this._par = null;

    /** Slot metadata so we can retire or query decals. */
    this._slotTris = new Int32Array(this.limit);
    this._slotBirth = new Float32Array(this.limit);
    this._slotLife = new Float32Array(this.limit);

    /** Pending spawn requests, pooled. */
    this._queue = [];
    this._queuePool = [];
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;

    this.stats = { slots: this.limit, used: 0, tris: 0, queued: 0, builtMs: 0 };
  }

  init() {
    const verts = this.limit * VERTS_PER_SLOT;
    this._pos = new Float32Array(verts * 3);
    this._uv = new Float32Array(verts * 2);
    this._col = new Float32Array(verts * 4);
    this._par = new Float32Array(verts * 4);
    // life 0 ⇒ vFade 0 ⇒ discarded; unused slots draw nothing.
    for (let i = 0; i < verts; i++) this._par[i * 4 + 1] = 0;

    const geo = new THREE.BufferGeometry();
    this.attrPos = new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrUv = new THREE.BufferAttribute(this._uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.attrCol = new THREE.BufferAttribute(this._col, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrPar = new THREE.BufferAttribute(this._par, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.attrPos);
    geo.setAttribute('uv', this.attrUv);
    geo.setAttribute('aColor', this.attrCol);
    geo.setAttribute('aParams', this.attrPar);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uAtlas: { value: null },
        uAtlasTiles: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
        uNow: { value: 0 },
      },
    ]);
    uniforms.uAtlas.value = this._atlas;

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT_SHADER,
      fragmentShader: FRAG_SHADER,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -8,
    });
    mat.name = 'fx/decals';
    this.material = mat;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/decals';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 5;                 // above tyre marks, below particles
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.noCollision = true;
    this.mesh = mesh;
    return this;
  }

  setAtlas(tex) {
    this._atlas = tex;
    if (this.material) this.material.uniforms.uAtlas.value = tex;
    return this;
  }

  attach(parent) { parent?.add(this.mesh); return this; }

  // ─────────────────────────────────────────────────────────── API

  /**
   * Queue a decal. Returns true if it was accepted into the queue.
   *
   * @param {string|object} kind key of DECAL, or a descriptor
   * @param {THREE.Vector3|{x,y,z}} position world-space contact point
   * @param {THREE.Vector3|{x,y,z}|null} normal surface normal (defaults to +Y)
   * @param {number} radius half-extent of the decal, metres
   * @param {object} [o] `{ rotation, color, alpha, life, fadeIn, sprite, variant, depth }`
   */
  project(kind, position, normal, radius, o) {
    if (!this.enabled || !this.mesh) return false;
    if (this._queue.length > 12) return false;         // hard backpressure

    const preset = typeof kind === 'string' ? DECAL[kind] : kind;
    if (!preset) return false;

    const req = this._queuePool.pop() || {
      px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0,
      radius: 0.2, rotation: 0, sprite: 0, r: 1, g: 1, b: 1,
      alpha: 1, life: 10, fadeIn: 0.1, depth: 0.12,
    };
    req.px = position.x; req.py = position.y; req.pz = position.z;
    if (normal) {
      req.nx = normal.x; req.ny = normal.y; req.nz = normal.z;
    } else { req.nx = 0; req.ny = 1; req.nz = 0; }
    req.radius = Math.max(0.02, radius);
    req.rotation = o?.rotation ?? frand() * Math.PI * 2;

    const variants = preset.variants ?? 1;
    const variant = o?.variant ?? ((frand() * variants) | 0);
    req.sprite = (o?.sprite ?? preset.sprite) + (variant % variants);

    const col = toLinearRGB(o?.color ?? preset.color ?? 0xffffff);
    req.r = col[0]; req.g = col[1]; req.b = col[2];
    req.alpha = o?.alpha ?? preset.alpha ?? 1;
    req.life = o?.life ?? preset.life ?? 10;
    req.fadeIn = o?.fadeIn ?? preset.fadeIn ?? 0.1;
    req.depth = o?.depth ?? preset.depth ?? 0.12;

    this._queue.push(req);
    this.stats.queued = this._queue.length;
    return true;
  }

  /** @param {number} dt simulated seconds */
  update(dt) {
    if (!this.mesh) return;
    this.time += dt;
    this.material.uniforms.uNow.value = this.time;

    if (this._queue.length) {
      const t0 = performance.now();
      let built = 0;
      while (this._queue.length && built < this.maxPerFrame) {
        const req = this._queue.shift();
        this._build(req);
        this._queuePool.push(req);
        built++;
      }
      this.stats.builtMs = performance.now() - t0;
      this.stats.queued = this._queue.length;
    }

    this._flush();

    // Book-keeping for the debug overlay only.
    let used = 0, tris = 0;
    for (let i = 0; i < this.limit; i++) {
      if (this._slotTris[i] > 0 && this.time - this._slotBirth[i] < this._slotLife[i]) {
        used++; tris += this._slotTris[i];
      }
    }
    this.stats.used = used;
    this.stats.tris = tris;
  }

  // ─────────────────────────────────────────────────────────── build

  _build(req) {
    const mesh = this.game?.physics?.trackMesh;
    if (!mesh || mesh.triangleCount === 0) return;

    // ── projector basis ──
    _n.set(req.nx, req.ny, req.nz);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    // A stable tangent: pick the world axis least aligned with the normal.
    const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
    if (ay <= ax && ay <= az) _t.set(0, 1, 0);
    else if (ax <= az) _t.set(1, 0, 0);
    else _t.set(0, 0, 1);
    _b.crossVectors(_n, _t).normalize();
    _t.crossVectors(_b, _n).normalize();

    // roll the decal around its normal
    const cr = Math.cos(req.rotation), sr = Math.sin(req.rotation);
    const tx = _t.x * cr + _b.x * sr, ty = _t.y * cr + _b.y * sr, tz = _t.z * cr + _b.z * sr;
    const bx = -_t.x * sr + _b.x * cr, by = -_t.y * sr + _b.y * cr, bz = -_t.z * sr + _b.z * cr;
    _t.set(tx, ty, tz);
    _b.set(bx, by, bz);

    const R = req.radius;
    const D = Math.max(req.depth, R * 0.35);
    const ox = req.px, oy = req.py, oz = req.pz;

    // ── candidate triangles ──
    const reach = Math.hypot(R, D) + 0.01;
    _min.set(ox - reach, oy - reach, oz - reach);
    _max.set(ox + reach, oy + reach, oz + reach);
    const count = Math.min(mesh.queryAABB(_min, _max, _triIndices), _triIndices.length);
    if (count === 0) return;

    // ── slot ──
    const slot = this.head;
    this.head = (this.head + 1) % this.limit;
    const vBase = slot * VERTS_PER_SLOT;

    const P = this._pos, U = this._uv, C = this._col, PA = this._par;
    const tris = mesh.tris;
    const planes = mesh.planes;

    const invR = 0.5 / R;                 // projector space → uv (0..1)
    const cellX = (req.sprite % ATLAS_COLS) / ATLAS_COLS;
    const cellY = (((req.sprite / ATLAS_COLS) | 0)) / ATLAS_ROWS;
    const cellW = 1 / ATLAS_COLS;
    const cellH = 1 / ATLAS_ROWS;
    // half-texel inset so the decal cannot sample its atlas neighbour
    const inset = 0.0015;

    let written = 0;
    for (let k = 0; k < count && written < TRIS_PER_SLOT; k++) {
      const tri = _triIndices[k];
      const pb = tri * 4;
      // Back-facing triangles would project the decal onto the underside of a
      // ramp, so reject anything not roughly facing the projector.
      const facing = planes[pb] * _n.x + planes[pb + 1] * _n.y + planes[pb + 2] * _n.z;
      if (facing < 0.20) continue;

      const t9 = tri * 9;
      _va.set(tris[t9], tris[t9 + 1], tris[t9 + 2]);
      _vb.set(tris[t9 + 3], tris[t9 + 4], tris[t9 + 5]);
      _vc.set(tris[t9 + 6], tris[t9 + 7], tris[t9 + 8]);

      // → projector space
      let n0 = 3;
      for (let vi = 0; vi < 3; vi++) {
        const v = vi === 0 ? _va : (vi === 1 ? _vb : _vc);
        const dx = v.x - ox, dy = v.y - oy, dz = v.z - oz;
        const o3 = vi * 3;
        _clipA[o3] = dx * _t.x + dy * _t.y + dz * _t.z;
        _clipA[o3 + 1] = dx * _b.x + dy * _b.y + dz * _b.z;
        _clipA[o3 + 2] = dx * _n.x + dy * _n.y + dz * _n.z;
      }

      // clip against the six box planes: ±x ≤ R, ±y ≤ R, ±z ≤ D
      n0 = clipAxis(_clipA, n0, _clipB, 0, +1, R); if (n0 < 3) continue;
      n0 = clipAxis(_clipB, n0, _clipA, 0, -1, R); if (n0 < 3) continue;
      n0 = clipAxis(_clipA, n0, _clipB, 1, +1, R); if (n0 < 3) continue;
      n0 = clipAxis(_clipB, n0, _clipA, 1, -1, R); if (n0 < 3) continue;
      n0 = clipAxis(_clipA, n0, _clipB, 2, +1, D); if (n0 < 3) continue;
      n0 = clipAxis(_clipB, n0, _clipA, 2, -1, D); if (n0 < 3) continue;

      // triangle normal for the lift (use the plane, it is already normalized)
      _triN.set(planes[pb], planes[pb + 1], planes[pb + 2]);

      // fan-triangulate back into world space
      for (let f = 1; f < n0 - 1 && written < TRIS_PER_SLOT; f++) {
        const vi = [0, f, f + 1];
        const o = (vBase + written * 3);
        for (let c = 0; c < 3; c++) {
          const s3 = vi[c] * 3;
          const lx = _clipA[s3], ly = _clipA[s3 + 1], lz = _clipA[s3 + 2];
          const wx = ox + _t.x * lx + _b.x * ly + _n.x * lz + _triN.x * this.lift;
          const wy = oy + _t.y * lx + _b.y * ly + _n.y * lz + _triN.y * this.lift;
          const wz = oz + _t.z * lx + _b.z * ly + _n.z * lz + _triN.z * this.lift;

          const p3 = (o + c) * 3;
          P[p3] = wx; P[p3 + 1] = wy; P[p3 + 2] = wz;

          const u = clamp01(lx * invR + 0.5);
          const v = clamp01(ly * invR + 0.5);
          const p2 = (o + c) * 2;
          U[p2] = cellX + (inset + u * (1 - 2 * inset)) * cellW;
          U[p2 + 1] = cellY + (inset + (1 - v) * (1 - 2 * inset)) * cellH;

          const p4 = (o + c) * 4;
          C[p4] = req.r; C[p4 + 1] = req.g; C[p4 + 2] = req.b; C[p4 + 3] = req.alpha;
          PA[p4] = this.time; PA[p4 + 1] = req.life; PA[p4 + 2] = req.fadeIn; PA[p4 + 3] = 0;
        }
        written++;
      }
    }

    // blank the rest of the slot so a previous, larger decal cannot linger
    for (let i = written; i < TRIS_PER_SLOT; i++) {
      const o = vBase + i * 3;
      for (let c = 0; c < 3; c++) {
        const p3 = (o + c) * 3;
        P[p3] = 0; P[p3 + 1] = -1e5; P[p3 + 2] = 0;
        const p4 = (o + c) * 4;
        PA[p4] = 0; PA[p4 + 1] = 0; PA[p4 + 2] = 1; PA[p4 + 3] = 0;
      }
    }

    this._slotTris[slot] = written;
    this._slotBirth[slot] = this.time;
    this._slotLife[slot] = req.life;

    if (slot < this._dirtyMin) this._dirtyMin = slot;
    if (slot > this._dirtyMax) this._dirtyMax = slot;

    // Draw range: keep it tight to the highest slot ever used.
    const usedSlots = Math.max(this._maxSlotUsed ?? 0, slot + 1);
    this._maxSlotUsed = usedSlots;
    this.geometry.setDrawRange(0, usedSlots * VERTS_PER_SLOT);
  }

  _flush() {
    if (this._dirtyMax < this._dirtyMin) return;
    const lo = this._dirtyMin * VERTS_PER_SLOT;
    const n = (this._dirtyMax - this._dirtyMin + 1) * VERTS_PER_SLOT;
    range(this.attrPos, lo * 3, n * 3);
    range(this.attrUv, lo * 2, n * 2);
    range(this.attrCol, lo * 4, n * 4);
    range(this.attrPar, lo * 4, n * 4);
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
  }

  clear() {
    this._queue.length = 0;
    this.head = 0;
    this._maxSlotUsed = 0;
    if (this._par) for (let i = 0; i < this._par.length; i += 4) this._par[i + 1] = 0;
    this._slotTris.fill(0);
    this.geometry?.setDrawRange(0, 0);
    if (this.attrPar) {
      this.attrPar.clearUpdateRanges();
      this.attrPar.needsUpdate = true;
    }
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh?.removeFromParent();
  }
}

function range(attr, start, count) {
  let r = attr._rcRange;
  if (!r) { r = { start: 0, count: 0 }; attr._rcRange = r; }
  r.start = start;
  r.count = count;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(r);
  attr.needsUpdate = true;
}

export default Decals;
