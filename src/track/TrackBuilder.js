/**
 * RC RUMBLE — the track authoring DSL.
 *
 * A track module is a small declarative script that talks to this builder and
 * nothing else:
 *
 * ```js
 * export function build(b) {
 *   b.centerline(NODES, { closed: true });
 *   b.environment({ skybox: 'museum', grade: 'museum', … });
 *   b.road({ material: 'wood/parquet', surfaceId: 1, wall: { height: 0.4 } });
 *   b.stripe({ from: 0.02, to: 0.34, width: 1.4, material: 'carpet/loop_pile', surfaceId: 2 });
 *   b.ramp({ from: [16, 0, -20], to: [24, 0.62, -18], width: 2.6 });
 *   b.prop('cone', { position: [2, 0, -6] });
 *   // …
 * }
 * ```
 *
 * Everything the builder emits is
 *  * **batched** — geometry is bucketed by material and merged with
 *    `mergeGeometries`, repeated props go into `InstancedMesh`es, so a whole
 *    circuit lands in a handful of draw calls;
 *  * **collidable** — every solid surface is appended to ONE `CollisionMesh`
 *    with a correct per-triangle surface id;
 *  * **UV-correct** — see `GeoLib.js`: all UVs are in metres and all materials
 *    are requested at `sizeMeters: 1`, so texel density is identical everywhere.
 *
 * The builder also derives all of the race data from the centreline:
 * checkpoints, a staggered start grid (≥ 8 slots), respawn points, pickup pads
 * and an AI path with per-node target speeds from curvature.
 */

import * as THREE from 'three';
import { CollisionMeshBuilder } from '../physics/CollisionMesh.js';
import { getMaterials } from '../render/Materials.js';
import * as PT from '../render/ProceduralTextures.js';
import { CenterlineSpline, SplineSample, ClosestResult } from './Spline.js';
import { createSurfaceTable, getSurface, SurfaceId } from './Surfaces.js';
import * as G from './GeoLib.js';
import { PROPS, spawnProp, PropRuntime } from './Props.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _s = new THREE.Vector3(1, 1, 1);
const _smp = new SplineSample();
const _smp2 = new SplineSample();
const FORWARD = new THREE.Vector3(0, 0, -1);

/** Above this many vertices a merge bucket is flushed into its own mesh. */
const MAX_BUCKET_VERTS = 160000;

let _uid = 0;

export class TrackBuilder {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {{id:string, name?:string, theme?:string, difficulty?:string,
   *          laps?:number, seed?:number, previewColors?:number[]}} meta
   */
  constructor(game, meta = {}) {
    this.game = game;
    this.meta = {
      id: meta.id ?? `track${++_uid}`,
      name: meta.name ?? meta.id ?? 'Track',
      theme: meta.theme ?? 'indoor',
      difficulty: meta.difficulty ?? 'easy',
      laps: meta.laps ?? 3,
      seed: meta.seed ?? 1337,
      previewColors: meta.previewColors ?? [0x8a6a3a, 0xd8cbb0, 0x4d6b8a],
      description: meta.description ?? '',
    };

    /** @type {import('../render/Materials.js').MaterialLibrary|null} */
    this.materials = getMaterials(game);
    this.assets = game?.assets ?? null;

    this.scene = new THREE.Group();
    this.scene.name = `track:${this.meta.id}`;
    /** Non-collidable decoration goes here so it can be culled/hidden as a set. */
    this.decor = new THREE.Group();
    this.decor.name = 'decor';
    this.scene.add(this.decor);
    /** Animated set dressing (fans, trains, sprinklers). */
    this.animated = new THREE.Group();
    this.animated.name = 'animated';
    this.scene.add(this.animated);
    /** Pickup pad visuals — gameplay may hide or replace these. */
    this.padGroup = new THREE.Group();
    this.padGroup.name = 'pickupPads';
    this.scene.add(this.padGroup);

    /** @type {CenterlineSpline|null} */
    this.spline = null;
    this.surfaces = createSurfaceTable();

    this._collision = new CollisionMeshBuilder();
    /** @type {Map<string, {material:THREE.Material, geos:THREE.BufferGeometry[], verts:number, cast:boolean, receive:boolean, order:number, wantColor:boolean, meshes:THREE.Mesh[]}>} */
    this._buckets = new Map();
    /** @type {Map<string, {geometry:THREE.BufferGeometry, material:THREE.Material, mats:THREE.Matrix4[], cast:boolean, receive:boolean}>} */
    this._instances = new Map();
    /** @type {THREE.BufferGeometry[]} everything we must dispose on unload */
    this._ownedGeo = [];
    /** @type {THREE.Material[]} materials WE created (wind, water clones) */
    this._ownedMat = [];
    /** @type {THREE.Material[]} materials to advance each frame (wind sway) */
    this._windMats = [];

    this.bounds = new THREE.Box3();
    this._envDesc = null;
    this._audio = { reverb: { roomSize: 0.55, damping: 0.35, wet: 0.28 }, ambienceId: null };

    /** @type {object[]} */
    this.checkpointList = null;
    this.startGridList = null;
    this.respawnList = null;
    /** @type {Array<{position:THREE.Vector3, quaternion:THREE.Quaternion, id:number}>} */
    this.pads = [];
    /** @type {Array<object>} */
    this.shortcutList = [];
    /** @type {Array<[number,number,object]>} t-ranges with no road surface */
    this._gaps = [];
    /** @type {PropRuntime} */
    this.propRuntime = new PropRuntime(game, this);
    /** @type {Array<{t:number, speed:number}>} manual AI speed hints */
    this._speedHints = [];
    /** @type {Array<{position:THREE.Vector3, radius:number, gripScale:number, a0:number, a1:number, kind:string, active:boolean}>} */
    this.surfaceZones = [];
    /** Simple deterministic RNG so a track always builds identically. */
    this._rngState = (this.meta.seed | 0) || 1;

    this.stats = { meshes: 0, instanced: 0, triangles: 0, collisionTris: 0, buckets: 0 };
  }

  // ═══════════════════════════════════════════════════════════════ utilities

  /** Deterministic [0,1). */
  rnd() {
    this._rngState = (this._rngState + 0x6d2b79f5) >>> 0;
    let t = this._rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  rndRange(a, b) { return a + (b - a) * this.rnd(); }
  rndInt(a, b) { return Math.floor(this.rndRange(a, b + 1)); }
  rndPick(arr) { return arr[Math.floor(this.rnd() * arr.length)]; }

  /**
   * Fetch a catalogue material at the project-wide texel density (UVs are in
   * metres → `sizeMeters: 1`). Everything in a track should go through here.
   * @param {string} name catalogue key, e.g. `'wood/parquet'`
   * @param {object} [opts] forwarded to `MaterialLibrary#get`
   */
  mat(name, opts = null) {
    if (!this.materials) return this._fallbackMat();
    const o = opts ? { ...opts } : {};
    if (o.sizeMeters == null && o.repeat == null) o.sizeMeters = 1;
    try {
      return this.materials.get(name, o);
    } catch (err) {
      console.warn('[TrackBuilder] material failed:', name, err);
      return this._fallbackMat();
    }
  }

  /** Material for a canonical surface id. */
  matForSurface(sid, opts = null) {
    if (!this.materials) return this._fallbackMat();
    const o = opts ? { ...opts } : {};
    if (o.sizeMeters == null && o.repeat == null) o.sizeMeters = 1;
    try { return this.materials.forSurface(sid, o); }
    catch { return this._fallbackMat(); }
  }

  /** Flat vertex-coloured material (props, foliage, painted details). */
  vcolor(opts = null) {
    if (!this.materials) return this._fallbackMat();
    return this.materials.vertexColor(opts ?? {});
  }

  /** Emissive material (signage, lamps, pickup pads). */
  glow(color = 0xffffff, intensity = 2, opts = null) {
    if (!this.materials) return this._fallbackMat();
    return this.materials.emissive(color, intensity, opts ?? {});
  }

  /** Decal / sign / banner material. */
  decal(opts) {
    if (!this.materials) return this._fallbackMat();
    return this.materials.decal(opts);
  }

  _fallbackMat() {
    this._fallback ??= new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.8 });
    if (!this._ownedMat.includes(this._fallback)) this._ownedMat.push(this._fallback);
    return this._fallback;
  }

  /**
   * A wind-swayed clone of a material. Registered for per-frame updates.
   * @param {THREE.Material} base
   */
  windMaterial(base, o = null) {
    const m = G.makeWindMaterial(base, o ?? {});
    this._ownedMat.push(m);
    this._windMats.push(m);
    return m;
  }

  // ══════════════════════════════════════════════════════════════ centreline

  /**
   * Define the racing centreline. Nodes may be `[x, y, z, width?, bank?, camber?]`
   * or `{ p:[x,y,z], w, bank, camber, tag }`.
   * @param {Array} nodes
   * @param {object} [opts] see {@link CenterlineSpline}
   */
  centerline(nodes, opts = {}) {
    this.spline = new CenterlineSpline(nodes, { closed: true, samplesPerSegment: 30, ...opts });
    return this;
  }

  /** Lap length in metres (0 before {@link centerline}). */
  get length() { return this.spline?.length ?? 0; }

  /** Sample the centreline. Returns a shared scratch — copy if you keep it. */
  at(t, out = _smp) { return this.spline ? this.spline.sample(t, out) : out; }

  /** World point at a lap fraction with lateral/vertical offsets. */
  point(t, lateral = 0, vertical = 0, out = new THREE.Vector3()) {
    if (!this.spline) return out.set(0, 0, 0);
    this.spline.sample(t, _smp);
    return _smp.offset(lateral, vertical, out);
  }

  /** Lap fraction `metres` further along than `t`. */
  advance(t, metres) {
    if (!this.spline) return t;
    return this.spline.wrapT(t + metres / this.spline.length);
  }

  /**
   * Lap fraction nearest to a world point. Build-time helper — handy for
   * anchoring props to the racing line.
   * @param {THREE.Vector3|number[]} point
   */
  tNear(point) {
    if (!this.spline) return 0;
    _v.set(...toXYZ(point));
    this.spline.closestPoint(_v, _closest);
    return _closest.t;
  }

  /** Signed lateral offset (metres, +right) of a world point from the road. */
  lateralNear(point) {
    if (!this.spline) return 0;
    _v.set(...toXYZ(point));
    this.spline.closestPoint(_v, _closest);
    return _closest.lateral;
  }

  // ══════════════════════════════════════════════════════════ low-level add

  /**
   * Add a geometry to the world.
   *
   * @param {THREE.BufferGeometry} geometry consumed — do not reuse afterwards
   *        unless `opts.keepSource` is set (it is cloned for merging anyway).
   * @param {THREE.Material} material
   * @param {object} [opts]
   * @param {THREE.Matrix4} [opts.matrix] world transform
   * @param {number|null} [opts.surfaceId] `null` ⇒ no collision
   * @param {boolean} [opts.collide=true]
   * @param {boolean} [opts.cast=true] cast shadows
   * @param {boolean} [opts.receive=true] receive shadows
   * @param {boolean} [opts.decor=false] park under the `decor` group (non-solid)
   * @param {number} [opts.order] renderOrder for transparent sorting
   * @param {boolean} [opts.vertexColors]
   * @param {boolean} [opts.noMerge] give it its own mesh (animated objects)
   * @returns {THREE.BufferGeometry} the world-space geometry that was stored
   */
  add(geometry, material, opts = {}) {
    if (!geometry || !material) return null;
    const pos = geometry.getAttribute?.('position');
    if (!pos || pos.count === 0) return null;

    const collide = opts.collide !== false && opts.surfaceId != null;
    const mtx = opts.matrix ?? null;

    if (collide) {
      this._collision.addGeometry(geometry, opts.surfaceId | 0, mtx);
    }

    // World-space copy for rendering / merging.
    const world = geometry.clone();
    if (mtx) world.applyMatrix4(mtx);
    G.normalizeForMerge(world, !!opts.vertexColors);
    this._expandBounds(world);

    if (opts.noMerge) {
      const mesh = new THREE.Mesh(world, material);
      mesh.castShadow = opts.cast !== false;
      mesh.receiveShadow = opts.receive !== false;
      if (opts.order != null) mesh.renderOrder = opts.order;
      mesh.name = opts.name ?? 'trackMesh';
      mesh.userData.surfaceId = opts.surfaceId ?? 0;
      if (!collide) mesh.userData.noCollision = true;
      (opts.decor ? this.decor : this.scene).add(mesh);
      this._ownedGeo.push(world);
      this.stats.meshes++;
      return world;
    }

    const cast = opts.cast !== false;
    const receive = opts.receive !== false;
    const order = opts.order ?? 0;
    const key = `${material.uuid}|${cast ? 1 : 0}${receive ? 1 : 0}|${order}|${opts.decor ? 'd' : 's'}|${opts.vertexColors ? 'c' : ''}`;
    let bucket = this._buckets.get(key);
    if (!bucket) {
      bucket = {
        material, geos: [], verts: 0, cast, receive, order,
        decor: !!opts.decor, wantColor: !!opts.vertexColors, meshes: [],
      };
      this._buckets.set(key, bucket);
    }
    bucket.geos.push(world);
    bucket.verts += world.getAttribute('position').count;
    if (bucket.verts > MAX_BUCKET_VERTS) this._flushBucket(bucket, key);
    return world;
  }

  /** Same as {@link add} but with position/rotation/scale instead of a matrix. */
  addAt(geometry, material, position, rotation = null, scale = null, opts = {}) {
    _v.set(...toXYZ(position));
    if (rotation) { _e.set(...toXYZ(rotation)); _q.setFromEuler(_e); } else _q.identity();
    if (scale == null) _s.set(1, 1, 1);
    else if (typeof scale === 'number') _s.set(scale, scale, scale);
    else _s.set(...toXYZ(scale));
    _m.compose(_v, _q, _s);
    return this.add(geometry, material, { ...opts, matrix: _m });
  }

  /**
   * Register one instance of a repeated prop geometry. All instances sharing
   * `key` become a single `InstancedMesh`.
   *
   * @param {string} key
   * @param {THREE.BufferGeometry} geometry only read on the first call
   * @param {THREE.Material} material
   * @param {THREE.Matrix4} matrix
   * @param {object} [opts] `collide`: false | true | 'box' (cheap AABB hull)
   */
  instance(key, geometry, material, matrix, opts = {}) {
    let inst = this._instances.get(key);
    if (!inst) {
      const g = G.normalizeForMerge(geometry.clone(), !!opts.vertexColors);
      g.computeBoundingBox();
      inst = {
        geometry: g, material, mats: [],
        cast: opts.cast !== false, receive: opts.receive !== false,
        decor: !!opts.decor, order: opts.order ?? 0,
      };
      this._instances.set(key, inst);
      this._ownedGeo.push(g);
    }
    const m = matrix.clone();
    inst.mats.push(m);

    const collide = opts.collide;
    if (collide === 'box') {
      const bb = inst.geometry.boundingBox;
      bb.getCenter(_v);
      bb.getSize(_v2);
      const box = G.boxMeters(Math.max(0.01, _v2.x), Math.max(0.01, _v2.y), Math.max(0.01, _v2.z));
      box.translate(_v.x, _v.y, _v.z);
      this._collision.addGeometry(box, opts.surfaceId ?? 0, m);
      box.dispose();
    } else if (collide && opts.surfaceId != null) {
      this._collision.addGeometry(inst.geometry, opts.surfaceId | 0, m);
    }

    // Keep the world bounds honest even though the mesh does not exist yet.
    if (inst.geometry.boundingBox) {
      _tmpBox.copy(inst.geometry.boundingBox).applyMatrix4(m);
      this.bounds.union(_tmpBox);
    }
    return this;
  }

  /** Convenience wrapper for {@link instance} with TRS arguments. */
  instanceAt(key, geometry, material, position, rotation = null, scale = null, opts = {}) {
    _v.set(...toXYZ(position));
    if (rotation) { _e.set(...toXYZ(rotation)); _q.setFromEuler(_e); } else _q.identity();
    if (scale == null) _s.set(1, 1, 1);
    else if (typeof scale === 'number') _s.set(scale, scale, scale);
    else _s.set(...toXYZ(scale));
    _m.compose(_v, _q, _s);
    return this.instance(key, geometry, material, _m, opts);
  }

  /** Attach an already-built Object3D (animated props). Never merged. */
  addObject(obj, { animated = false, decor = true, collide = false, surfaceId = 0 } = {}) {
    if (!obj) return this;
    (animated ? this.animated : decor ? this.decor : this.scene).add(obj);
    if (collide) this._collision.addObject3D(obj, surfaceId);
    obj.updateWorldMatrix?.(true, true);
    _tmpBox.setFromObject(obj);
    if (!_tmpBox.isEmpty()) this.bounds.union(_tmpBox);
    return this;
  }

  /** Add raw triangles straight to collision without any visual (blockers). */
  addCollisionOnly(geometry, surfaceId = 0, matrix = null) {
    if (geometry) this._collision.addGeometry(geometry, surfaceId | 0, matrix);
    return this;
  }

  /**
   * An invisible wall — the safety net that stops a car leaving the world.
   * @param {number[]} a `[x, z]` @param {number[]} bb `[x, z]`
   */
  invisibleWall(a, bb, y = 0, height = 1.2, surfaceId = SurfaceId.DEFAULT) {
    const dx = bb[0] - a[0], dz = bb[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return this;
    const geo = G.boxMeters(0.06, height, len);
    _v.set((a[0] + bb[0]) / 2, y + height / 2, (a[1] + bb[1]) / 2);
    _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(dx, dz));
    _m.compose(_v, _q, _s.set(1, 1, 1));
    this._collision.addGeometry(geo, surfaceId, _m);
    geo.dispose();
    return this;
  }

  /**
   * An invisible solid volume. The workhorse for making a visually complex prop
   * (a skeleton's legs, a bush, a fence) collide as something simple and cheap.
   * @param {number[]} center `[x, y, z]` — y is the BOTTOM of the volume
   * @param {number|number[]} size `s` or `[w, h, d]`
   */
  blocker(center, size, o = {}) {
    const s = Array.isArray(size) ? size : [size, size, size];
    const w = s[0] ?? 0.5, h = s[1] ?? w, d = s[2] ?? w;
    const geo = o.round
      ? G.cylinderMeters(w * 0.5, w * 0.5, h, o.seg ?? 10)
      : G.boxMeters(w, h, d);
    const c = toXYZ(center);
    _v.set(c[0], c[1] + h * 0.5, c[2]);
    _q.setFromAxisAngle(UP, o.rotation ?? 0);
    _m.compose(_v, _q, _s.set(1, 1, 1));
    this._collision.addGeometry(geo, o.surfaceId ?? SurfaceId.DEFAULT, _m);
    geo.dispose();
    return this;
  }

  _expandBounds(geo) {
    geo.computeBoundingBox();
    if (geo.boundingBox && !geo.boundingBox.isEmpty()) this.bounds.union(geo.boundingBox);
  }

  _flushBucket(bucket, key) {
    const merged = G.mergeList(bucket.geos, bucket.wantColor);
    bucket.geos.length = 0;
    bucket.verts = 0;
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = bucket.cast;
    mesh.receiveShadow = bucket.receive;
    mesh.renderOrder = bucket.order;
    mesh.name = `batch:${bucket.material.name || key.slice(0, 8)}`;
    mesh.userData.noCollision = true;    // collision was registered separately
    mesh.frustumCulled = true;
    (bucket.decor ? this.decor : this.scene).add(mesh);
    this._ownedGeo.push(merged);
    this.stats.meshes++;
    const idx = merged.getIndex();
    this.stats.triangles += idx ? idx.count / 3 : merged.getAttribute('position').count / 3;
  }

  // ═════════════════════════════════════════════════════════════════ the road

  /**
   * Loft the racing surface along the centreline.
   *
   * @param {object} [o]
   * @param {number} [o.from=0] @param {number} [o.to=1] lap-fraction range
   * @param {string} [o.material='concrete/poured'] road material key
   * @param {number} [o.surfaceId=4]
   * @param {number} [o.widthScale=1]
   * @param {number} [o.step=0.85] station spacing in metres
   * @param {object|false} [o.shoulder] `{ width, drop, material, surfaceId }`
   *        a strip outside the road edge (grass/gravel run-off)
   * @param {object|false} [o.kerb] `{ width, height, material, surfaceId }`
   *        a raised lip at the road edge
   * @param {object|false} [o.wall] `{ height, thickness, material, surfaceId,
   *        side:'both'|'left'|'right', inset }` — a solid barrier
   * @param {object|false} [o.rail] `{ height, radius, material, posts }`
   *        a see-through railing instead of a wall
   * @param {object|false} [o.under] `{ depth, material, surfaceId }` — a skirt
   *        under the ribbon so an elevated road is solid from below
   * @param {number} [o.centreLine] optional painted centre stripe width
   */
  road(o = {}) {
    if (!this.spline) return this;
    const from = o.from ?? 0;
    const to = o.to ?? 1;
    const roadSid = o.surfaceId ?? SurfaceId.CONCRETE;
    const roadMat = o.material ?? 'concrete/poured';

    const sh = o.shoulder;
    const kb = o.kerb;
    const wl = o.wall;
    const under = o.under;
    const wallSide = wl ? (wl.side ?? 'both') : 'none';

    // Build the cross-section left → right.
    //
    // Convention: `w` is ±1 (the road edge, so the ribbon follows the spline's
    // per-node width) and every extra offset is in METRES via `x`. A band's
    // surface id / material come from its LEFT point; a point with `sid: null`
    // terminates a band.
    const L = [];
    const sw = sh ? (sh.width ?? 0.5) : 0;           // shoulder width, metres
    const drop = sh ? (sh.drop ?? -0.02) : 0;
    const shSid = sh ? (sh.surfaceId ?? SurfaceId.GRASS) : null;
    const shMat = sh ? (sh.material ?? 'grass/lawn') : undefined;
    const wh = wl ? (wl.height ?? 0.4) : 0;
    const wth = wl ? (wl.thickness ?? 0.14) : 0;
    const wSid = wl ? (wl.surfaceId ?? SurfaceId.CONCRETE) : null;
    const wMat = wl ? (wl.material ?? 'concrete/rough') : undefined;
    const kw = kb ? (kb.width ?? 0.10) : 0;
    const kh = kb ? (kb.height ?? 0.035) : 0;
    const kSid = kb ? (kb.surfaceId ?? SurfaceId.CONCRETE) : null;
    const kMat = kb ? (kb.material ?? 'concrete/screed') : undefined;

    const wallLeft = wallSide === 'both' || wallSide === 'left';
    const wallRight = wallSide === 'both' || wallSide === 'right';
    const outX = sw + kw;                    // metres from the road edge to the barrier
    const push = (w, x, y, sid, mat) => { L.push({ w, x, y, sid, mat }); };

    // ══ left half ══
    if (wallLeft) {
      push(-1, -(outX + wth), 0, wSid, wMat);   // band: outer face (up)
      push(-1, -(outX + wth), wh, wSid, wMat);  // band: cap
      push(-1, -outX, wh, wSid, wMat);          // band: inner face (down)
    }
    if (sh) push(-1, -outX, drop, shSid, shMat);          // band: shoulder
    if (kb) {
      if (!sh && !wallLeft) push(-1, -kw, 0, kSid, kMat); // band: kerb outer face (up)
      push(-1, -kw, kh, kSid, kMat);                      // band: kerb top
      push(-1, 0, kh, kSid, kMat);                        // band: kerb inner face (down)
    }
    push(-1, 0, 0, roadSid, roadMat);                     // band: THE ROAD

    // ══ right half (mirrored) ══
    if (kb) {
      push(1, 0, 0, kSid, kMat);                          // band: kerb inner face (up)
      push(1, 0, kh, kSid, kMat);                         // band: kerb top
      if (sh) push(1, kw, kh, shSid, shMat);
      else if (wallRight) push(1, kw, kh, wSid, wMat);
      else push(1, kw, kh, kSid, kMat);                   // band: kerb outer face (down)
    } else if (sh) {
      push(1, 0, 0, shSid, shMat);
    } else if (wallRight) {
      push(1, 0, 0, wSid, wMat);                          // band: inner face (up)
    } else {
      push(1, 0, 0, null);                                // terminator
    }
    if (sh) push(1, outX, drop, wallRight ? wSid : null, wallRight ? wMat : undefined);
    if (wallRight) {
      push(1, outX, wh, wSid, wMat);                      // band: cap
      push(1, outX + wth, wh, wSid, wMat);                // band: outer face (down)
      push(1, outX + wth, 0, null);                       // terminator
    } else if (kb && !sh) {
      push(1, kw, 0, null);                               // terminator
    }

    const bands = this.spline.loft(L, {
      from, to,
      stepMeters: o.step ?? 0.85,
      widthScale: o.widthScale ?? 1,
    });
    for (const band of bands) {
      const p = L[band.index];
      if (!p || p.mat === undefined || p.sid == null) { band.geometry.dispose(); continue; }
      this.add(band.geometry, this.mat(p.mat, p.matOpts), {
        surfaceId: p.sid,
        cast: o.cast ?? false,
        receive: true,
      });
      band.geometry.dispose();
    }

    // A skirt under an elevated ribbon, so it is solid from below and reads as
    // a real structure rather than a floating sheet.
    if (under) this.roadUnderside({ from, to, ...under });

    if (o.rail) this.railing({ from, to, ...o.rail });
    if (o.centreLine) {
      this.stripe({
        from, to, width: o.centreLine, y: 0.001,
        material: o.centreLineMaterial ?? 'road/tarmac_lane',
        surfaceId: null, decal: true,
      });
    }
    return this;
  }

  /**
   * A flat "runner" laid on top of the road — carpet strips, painted lines,
   * damp patches. Slightly raised and bevelled at the edges so a wheel cannot
   * catch on it. `surfaceId: null` makes it a pure decal (no collision), which
   * is what you want for paint.
   */
  stripe(o = {}) {
    if (!this.spline) return this;
    const w = o.width ?? 1.2;
    const off = o.offset ?? 0;
    const y = o.y ?? 0.006;
    const bevel = o.bevel ?? Math.min(0.06, w * 0.12);
    const sid = o.surfaceId === undefined ? SurfaceId.CARPET : o.surfaceId;
    const mat = o.material ?? 'carpet/loop_pile';
    const half = w / 2;

    const L = [];
    if (bevel > 0 && !o.decal) {
      L.push({ x: off - half - bevel, y: 0, sid, mat, smooth: true });
      L.push({ x: off - half, y, sid, mat, smooth: true });
      L.push({ x: off + half, y, sid, mat, smooth: true });
      L.push({ x: off + half + bevel, y: 0, sid: null });
    } else {
      L.push({ x: off - half, y, sid, mat });
      L.push({ x: off + half, y, sid: null });
    }

    const bands = this.spline.loft(L, {
      from: o.from ?? 0, to: o.to ?? 1,
      stepMeters: o.step ?? 0.7,
      uOffset: -half,
    });
    const material = o.materialRef
      ?? (o.decal
        ? this.decal({ key: o.key ?? `stripe:${mat}`, texture: o.texture ?? null, color: o.color ?? 0xffffff, unlit: !!o.unlit, opacity: o.opacity ?? 1 })
        : this.mat(mat, o.matOpts));
    for (const band of bands) {
      const p = L[band.index];
      if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
      this.add(band.geometry, material, {
        surfaceId: p.sid, collide: p.sid != null,
        cast: false, receive: true, order: o.decal ? 1 : 0,
      });
      band.geometry.dispose();
    }
    return this;
  }

  /** A solid underside + side walls for an elevated stretch of road. */
  roadUnderside(o = {}) {
    if (!this.spline) return this;
    const depth = o.depth ?? 0.18;
    const mat = o.material ?? 'wood/pine_planks';
    const sid = o.surfaceId ?? SurfaceId.WOOD;
    const overhang = o.overhang ?? 0.05;
    // With `flip`, cross(d, tangent) is negated, which turns these three bands
    // into: left flank facing out, floor facing down, right flank facing out.
    const L = [
      { w: -1, x: -overhang, y: 0, sid, mat },                // left flank
      { w: -1, x: -overhang, y: -depth, sid, mat },           // underside
      { w: 1, x: overhang, y: -depth, sid, mat },             // right flank
      { w: 1, x: overhang, y: 0, sid: null },
    ];
    const bands = this.spline.loft(L, {
      from: o.from ?? 0, to: o.to ?? 1, stepMeters: o.step ?? 1.1, flip: true,
    });
    for (const band of bands) {
      const p = L[band.index];
      if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
      this.add(band.geometry, this.mat(p.mat), { surfaceId: p.sid, cast: true, receive: true });
      band.geometry.dispose();
    }
    return this;
  }

  /**
   * A see-through railing along the road: two rails plus posts. Collides so a
   * car bounces off it, but you can see the drop behind it.
   */
  railing(o = {}) {
    if (!this.spline) return this;
    const from = o.from ?? 0;
    let to = o.to ?? 1;
    if (to <= from) to += 1;
    const side = o.side ?? 'both';
    const h = o.height ?? 0.26;
    const r = o.radius ?? 0.016;
    const inset = o.inset ?? 0.02;
    const sid = o.surfaceId ?? SurfaceId.METAL;
    const material = this.mat(o.material ?? 'metal/brushed_alu');
    const spacing = o.postSpacing ?? 1.4;
    const span = (to - from) * this.spline.length;
    const posts = Math.max(2, Math.round(span / spacing) + 1);

    const sides = side === 'both' ? [-1, 1] : side === 'left' ? [-1] : [1];
    const postGeo = G.cylinderMeters(r * 1.25, r * 1.5, h, 8);

    for (const s of sides) {
      // Rails as lofted tubes: cheap and follows banking exactly.
      for (const level of [h, h * 0.52]) {
        const L = [
          { w: s, x: -s * inset, y: level - r, sid, mat: o.material ?? 'metal/brushed_alu' },
          { w: s, x: -s * inset, y: level + r, sid: null },
        ];
        // A flat ribbon reads as a rail at RC scale and costs 2 tris per station.
        const bands = this.spline.loft(L, { from, to, stepMeters: 0.5 });
        for (const band of bands) {
          const p = L[band.index];
          if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
          this.add(band.geometry, material, { surfaceId: p.sid, cast: true, receive: false });
          band.geometry.dispose();
        }
        // and the back face so it is not invisible from the other side
        const L2 = [
          { w: s, x: -s * inset, y: level + r, sid, mat: o.material ?? 'metal/brushed_alu' },
          { w: s, x: -s * inset, y: level - r, sid: null },
        ];
        const bands2 = this.spline.loft(L2, { from, to, stepMeters: 0.5, flip: true });
        for (const band of bands2) {
          const p = L2[band.index];
          if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
          this.add(band.geometry, material, { surfaceId: null, collide: false, cast: false, receive: false });
          band.geometry.dispose();
        }
      }
      for (let i = 0; i < posts; i++) {
        const t = from + ((to - from) * i) / (posts - 1);
        this.spline.sample(t, _smp);
        _smp.offset(s * (_smp.width * 0.5 - inset), h * 0.5, _v);
        _q.setFromUnitVectors(UP, _smp.normal);
        _m.compose(_v, _q, _s.set(1, 1, 1));
        this.instance(`rail:post:${o.material ?? 'alu'}:${r}:${h}`, postGeo, material, _m,
          { collide: false, cast: true, receive: false, surfaceId: sid });
      }
    }
    postGeo.dispose();
    return this;
  }

  /**
   * Mark a stretch of the centreline as **air** — no road surface. Used for
   * jumps: the spline still runs through it (so lap progress and the AI keep
   * working) but there is nothing to drive on.
   *
   * Automatically builds a take-off lip and a landing ramp unless disabled.
   */
  jumpGap(from, to, o = {}) {
    this._gaps.push([from, to, o]);
    if (!this.spline) return this;
    const sid = o.surfaceId ?? SurfaceId.WOOD;
    const mat = o.material ?? 'wood/plywood_varnish';

    if (o.lip !== false) {
      // A short up-kick right before the gap so the car pops rather than dribbles.
      const lipLen = o.lipLength ?? 1.6;
      const lipT = this.spline.wrapT(from - lipLen / this.spline.length);
      const rise = o.lipRise ?? 0.07;
      const L = [
        { w: -1, y: 0, sid, mat },
        { w: 1, y: 0, sid: null },
      ];
      const bands = this.spline.loft(L, {
        from: lipT, to: from, stepMeters: 0.28,
        onStation: (smp, i, n) => {
          const f = n > 1 ? i / (n - 1) : 1;
          smp.position.addScaledVector(smp.normal, rise * f * f);
        },
      });
      for (const band of bands) {
        const p = L[band.index];
        if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
        this.add(band.geometry, this.mat(p.mat), { surfaceId: p.sid, cast: true, receive: true });
        band.geometry.dispose();
      }
    }
    return this;
  }

  /** True if a lap fraction falls inside a declared jump gap. */
  isGap(t) {
    const tt = this.spline ? this.spline.wrapT(t) : t;
    for (const [a, b] of this._gaps) {
      if (a <= b) { if (tt >= a && tt <= b) return true; }
      else if (tt >= a || tt <= b) return true;
    }
    return false;
  }

  /** The t-ranges of the road that are NOT gaps, in order from `from`. */
  solidRanges(from = 0, to = 1) {
    const gaps = this._gaps
      .map(([a, b]) => [a, b])
      .filter(([a, b]) => a < b)
      .sort((p, q) => p[0] - q[0]);
    const out = [];
    let cursor = from;
    for (const [a, b] of gaps) {
      if (b <= from || a >= to) continue;
      if (a > cursor) out.push([cursor, Math.min(a, to)]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < to) out.push([cursor, to]);
    return out;
  }

  /**
   * Loft the road but skip every declared jump gap. This is what tracks should
   * call: `b.roadWithGaps({ … })`.
   */
  roadWithGaps(o = {}) {
    const ranges = this.solidRanges(o.from ?? 0, o.to ?? 1);
    if (ranges.length === 0) return this.road(o);
    for (const [a, b] of ranges) {
      if (b - a < 1e-4) continue;
      this.road({ ...o, from: a, to: b });
    }
    return this;
  }

  // ══════════════════════════════════════════════════════════════ structures

  /**
   * A flat floor region (a hall floor, a patio, a lawn). Either an axis-aligned
   * rectangle or an arbitrary polygon.
   *
   * @param {object} o
   * @param {number[]} [o.center] `[x, z]`
   * @param {number[]} [o.size] `[w, d]`
   * @param {Array<[number,number]>} [o.polygon] world XZ outline (overrides the rect)
   * @param {Array<Array<[number,number]>>} [o.holes]
   * @param {number} [o.y=0]
   * @param {number} [o.rotation] radians about Y (rect only)
   */
  floor(o = {}) {
    const sid = o.surfaceId ?? SurfaceId.CONCRETE;
    const mat = this.mat(o.material ?? 'concrete/poured', o.matOpts);
    let geo;
    if (o.polygon) {
      geo = G.polygonXZ(o.polygon, { holes: o.holes });
      geo.translate(0, o.y ?? 0, 0);
      this.add(geo, mat, { surfaceId: o.collide === false ? null : sid, cast: false, receive: true, decor: o.decor });
    } else {
      const [w, d] = o.size ?? [10, 10];
      const seg = o.heightFn ? (o.segments ?? Math.max(2, Math.ceil(Math.max(w, d) / 1.2))) : 1;
      geo = G.planeXZ(w, d, {
        segX: seg, segZ: seg, heightFn: o.heightFn,
        ou: (o.center?.[0] ?? 0), ov: (o.center?.[1] ?? 0),
      });
      const rot = o.rotation ?? 0;
      _v.set(o.center?.[0] ?? 0, o.y ?? 0, o.center?.[1] ?? 0);
      _q.setFromAxisAngle(UP, rot);
      _m.compose(_v, _q, _s.set(1, 1, 1));
      this.add(geo, mat, { matrix: _m, surfaceId: o.collide === false ? null : sid, cast: false, receive: true, decor: o.decor });
    }
    geo.dispose();
    return this;
  }

  /**
   * A vertical wall between two XZ points. `both` gives it thickness (a real
   * slab); otherwise it is a single-sided plane facing left of a→b.
   */
  wall(a, b, o = {}) {
    const th = o.thickness ?? 0.2;
    const h = o.height ?? 3;
    const y = o.y ?? 0;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return this;
    const sid = o.surfaceId ?? SurfaceId.CONCRETE;
    const mat = this.mat(o.material ?? 'drywall/painted', o.matOpts);
    const geo = G.boxMeters(th, h, len, { radius: o.radius ?? 0, seg: 2, skip: o.skipTop ? 'Y' : '' });
    _v.set((a[0] + b[0]) / 2, y + h / 2, (a[1] + b[1]) / 2);
    _q.setFromAxisAngle(UP, Math.atan2(dx, dz));
    _m.compose(_v, _q, _s.set(1, 1, 1));
    this.add(geo, mat, { matrix: _m, surfaceId: sid, cast: o.cast !== false, receive: true });
    geo.dispose();
    if (o.skirting) {
      const sk = G.boxMeters(th + 0.03, o.skirting.height ?? 0.09, len);
      _v.set((a[0] + b[0]) / 2, y + (o.skirting.height ?? 0.09) / 2, (a[1] + b[1]) / 2);
      _m.compose(_v, _q, _s.set(1, 1, 1));
      this.add(sk, this.mat(o.skirting.material ?? 'wood/mdf'), {
        matrix: _m, surfaceId: SurfaceId.WOOD, cast: false, receive: true,
      });
      sk.dispose();
    }
    return this;
  }

  /**
   * A closed room shell: four walls (with optional door gaps), a floor and a
   * ceiling. The single most useful indoor primitive.
   *
   * @param {object} o
   * @param {number[]} o.min `[x, z]` @param {number[]} o.max `[x, z]`
   * @param {number} [o.height=6]
   * @param {Array<{side:'n'|'s'|'e'|'w', at:number, width:number, height?:number}>} [o.doors]
   *        `at` is the world coordinate along the wall's axis
   */
  room(o = {}) {
    const [x0, z0] = o.min ?? [-10, -10];
    const [x1, z1] = o.max ?? [10, 10];
    const h = o.height ?? 6;
    const th = o.thickness ?? 0.3;
    const y = o.y ?? 0;
    const doors = o.doors ?? [];
    const wallMat = o.wallMaterial ?? 'drywall/painted';
    const wallSid = o.wallSurfaceId ?? SurfaceId.CONCRETE;

    if (o.floor !== false) {
      this.floor({
        center: [(x0 + x1) / 2, (z0 + z1) / 2], size: [x1 - x0, z1 - z0], y,
        material: o.floorMaterial ?? 'concrete/screed',
        surfaceId: o.floorSurfaceId ?? SurfaceId.CONCRETE,
        matOpts: o.floorMatOpts,
      });
    }
    if (o.ceiling !== false) {
      const geo = G.planeXZ(x1 - x0, z1 - z0, { ou: (x0 + x1) / 2, ov: (z0 + z1) / 2 });
      G.flipGeometry(geo);
      geo.translate((x0 + x1) / 2, y + h, (z0 + z1) / 2);
      this.add(geo, this.mat(o.ceilingMaterial ?? 'drywall/painted', { color: o.ceilingTint ?? 0xf0ece2 }), {
        surfaceId: o.ceilingCollide === false ? null : wallSid, cast: false, receive: false,
      });
      geo.dispose();
    }

    // Each wall is split into spans by the doors on that side.
    const sides = [
      { key: 'n', axis: 'x', fixed: z0, a: x0, b: x1, normalIn: 1 },
      { key: 's', axis: 'x', fixed: z1, a: x0, b: x1, normalIn: -1 },
      { key: 'w', axis: 'z', fixed: x0, a: z0, b: z1, normalIn: 1 },
      { key: 'e', axis: 'z', fixed: x1, a: z0, b: z1, normalIn: -1 },
    ];
    for (const s of sides) {
      if (o.skip && o.skip.includes(s.key)) continue;
      const cuts = doors
        .filter((d) => d.side === s.key)
        .map((d) => [d.at - d.width / 2, d.at + d.width / 2, d.height ?? h * 0.72])
        .sort((p, q) => p[0] - q[0]);
      let cursor = s.a;
      for (const [ca, cb, dh] of cuts) {
        if (ca > cursor) this._wallSpan(s, cursor, ca, y, h, th, wallMat, wallSid, o);
        // lintel above the door
        if (dh < h - 0.02) this._wallSpan(s, ca, cb, y + dh, h - dh, th, wallMat, wallSid, o);
        cursor = Math.max(cursor, cb);
      }
      if (cursor < s.b) this._wallSpan(s, cursor, s.b, y, h, th, wallMat, wallSid, o);
    }
    return this;
  }

  _wallSpan(s, a, b, y, h, th, mat, sid, o) {
    if (b - a < 1e-3 || h < 1e-3) return;
    const A = s.axis === 'x' ? [a, s.fixed] : [s.fixed, a];
    const B = s.axis === 'x' ? [b, s.fixed] : [s.fixed, b];
    this.wall(A, B, {
      thickness: th, height: h, y,
      material: mat, surfaceId: sid,
      matOpts: o.wallMatOpts,
      skirting: y < 0.01 ? o.skirting : null,
      cast: o.wallCast !== false,
    });
  }

  /**
   * A ramp between two world points. Automatically fitted: length and pitch come
   * from the endpoints, and it gets a lead-in wedge so a wheel never hits a step.
   *
   * @param {object} o
   * @param {number[]} o.from `[x, y, z]` bottom @param {number[]} o.to `[x, y, z]` top
   * @param {number} [o.width=2.4]
   * @param {number} [o.thickness=0.09]
   * @param {object|false} [o.rails] `{ height, material }`
   */
  ramp(o = {}) {
    const A = new THREE.Vector3(...toXYZ(o.from ?? [0, 0, 0]));
    const B = new THREE.Vector3(...toXYZ(o.to ?? [0, 1, 4]));
    const w = o.width ?? 2.4;
    const th = o.thickness ?? 0.09;
    const sid = o.surfaceId ?? SurfaceId.WOOD;
    const mat = this.mat(o.material ?? 'wood/plywood_varnish', o.matOpts);

    _v.copy(B).sub(A);
    const run = Math.hypot(_v.x, _v.z);
    const rise = _v.y;
    const len = Math.hypot(run, rise);
    if (len < 1e-3) return this;
    const yaw = Math.atan2(_v.x, _v.z);
    const pitch = Math.atan2(rise, run);

    // A slab, rotated. The lead-in taper is a thin wedge at the bottom.
    const slab = G.boxMeters(w, th, len, { radius: o.radius ?? 0.01, seg: 2 });
    _v2.copy(A).add(B).multiplyScalar(0.5);
    _v2.y -= (th * 0.5) / Math.max(0.2, Math.cos(pitch));
    _e.set(-pitch, yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_v2, _q, _s.set(1, 1, 1));
    this.add(slab, mat, { matrix: _m, surfaceId: sid, cast: true, receive: true });
    slab.dispose();

    // Lead-in: a shallow wedge so the transition is smooth even at speed.
    const leadLen = o.lead ?? Math.min(0.7, len * 0.3);
    if (leadLen > 0.02) {
      const lipH = Math.max(0.004, th * Math.cos(pitch));
      const lead = G.wedge(w, lipH + rise * (leadLen / Math.max(len, 1e-3)) * 0, leadLen);
      _v.set(0, 0, 0);
      // Place it just before A, climbing to the ramp's leading edge.
      const dirX = Math.sin(yaw), dirZ = Math.cos(yaw);
      _v2.set(A.x - dirX * leadLen * 0.5, A.y, A.z - dirZ * leadLen * 0.5);
      _e.set(0, yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_v2, _q, _s.set(1, 1, 1));
      this.add(lead, mat, { matrix: _m, surfaceId: sid, cast: false, receive: true });
      lead.dispose();
    }

    // Support legs / plinth so it does not float.
    if (o.support !== false && rise > 0.12) {
      const legW = Math.min(0.14, w * 0.1);
      for (const sx of [-1, 1]) {
        const legH = rise;
        const leg = G.boxMeters(legW, legH, legW);
        _v2.set(
          B.x - Math.sin(yaw) * 0.16 + Math.cos(yaw) * sx * (w * 0.5 - legW),
          B.y - legH * 0.5 - th * 0.5,
          B.z - Math.cos(yaw) * 0.16 - Math.sin(yaw) * sx * (w * 0.5 - legW),
        );
        _e.set(0, yaw, 0, 'YXZ'); _q.setFromEuler(_e);
        _m.compose(_v2, _q, _s.set(1, 1, 1));
        this.add(leg, this.mat(o.supportMaterial ?? 'wood/pine_planks'), {
          matrix: _m, surfaceId: SurfaceId.WOOD, cast: true, receive: true,
        });
        leg.dispose();
      }
    }

    if (o.rails) {
      const rh = o.rails.height ?? 0.1;
      const rmat = this.mat(o.rails.material ?? 'wood/pine_planks');
      for (const sx of [-1, 1]) {
        const rail = G.boxMeters(0.05, rh, len);
        _v2.copy(A).add(B).multiplyScalar(0.5);
        _v2.y += rh * 0.5;
        _v2.x += Math.cos(yaw) * sx * (w * 0.5 - 0.025);
        _v2.z -= Math.sin(yaw) * sx * (w * 0.5 - 0.025);
        _e.set(-pitch, yaw, 0, 'YXZ'); _q.setFromEuler(_e);
        _m.compose(_v2, _q, _s.set(1, 1, 1));
        this.add(rail, rmat, { matrix: _m, surfaceId: SurfaceId.WOOD, cast: true, receive: true });
        rail.dispose();
      }
    }
    return this;
  }

  /**
   * A kicker jump on the road at lap fraction `t`: a short raised wedge across
   * the racing line. Cars pop off it; nothing can catch on it.
   */
  kicker(t, o = {}) {
    if (!this.spline) return this;
    const len = o.length ?? 1.8;
    const rise = o.rise ?? 0.14;
    const half = len / (2 * this.spline.length);
    const from = this.spline.wrapT(t - half);
    const to = this.spline.wrapT(t + half);
    const sid = o.surfaceId ?? SurfaceId.WOOD;
    const mat = o.material ?? 'wood/plywood_varnish';
    const widthScale = o.widthScale ?? 1;
    const L = [
      { w: -widthScale, y: 0, sid, mat },
      { w: widthScale, y: 0, sid: null },
    ];
    const bands = this.spline.loft(L, {
      from, to, stepMeters: 0.2, widthScale,
      onStation: (smp, i, n) => {
        const f = n > 1 ? i / (n - 1) : 0;
        // ease in, sharp lip at the end
        const shape = o.symmetric ? Math.sin(f * Math.PI) : f * f * (3 - 2 * f);
        smp.position.addScaledVector(smp.normal, rise * shape);
      },
    });
    for (const band of bands) {
      const p = L[band.index];
      if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
      this.add(band.geometry, this.mat(p.mat), { surfaceId: p.sid, cast: true, receive: true });
      band.geometry.dispose();
    }
    // Fill the void beneath so it is a solid block, not a tent.
    const under = [
      { w: -widthScale, y: 0, sid: null },
      { w: -widthScale, y: -0.02, sid, mat },
      { w: widthScale, y: -0.02, sid, mat },
      { w: widthScale, y: 0, sid: null },
    ];
    const b2 = this.spline.loft(under, { from, to, stepMeters: 0.4, widthScale, flip: true });
    for (const band of b2) band.geometry.dispose();
    if (o.aiJump !== false) this._speedHints.push({ t, speed: o.approachSpeed ?? 8.0, jump: true });
    return this;
  }

  /**
   * A half-pipe / banked wall: the road's outer edge curls up into a smooth
   * quarter-circle you can ride.
   */
  halfPipe(o = {}) {
    if (!this.spline) return this;
    const from = o.from ?? 0, to = o.to ?? 1;
    const radius = o.radius ?? 1.2;
    const side = o.side ?? 1;
    const seg = Math.max(3, o.segments ?? 6);
    const sid = o.surfaceId ?? SurfaceId.CONCRETE;
    const mat = o.material ?? 'concrete/poured';
    const L = [];
    if (side < 0) {
      for (let i = seg; i >= 0; i--) {
        const a = (i / seg) * (Math.PI / 2);
        L.push({
          w: -1, x: -(1 - Math.cos(a)) * radius, y: (1 - Math.cos(Math.PI / 2 - a)) * radius,
          sid, mat, smooth: true,
        });
      }
      L.push({ w: 1, y: 0, sid: null });
    } else {
      L.push({ w: -1, y: 0, sid, mat, smooth: true });
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * (Math.PI / 2);
        L.push({
          w: 1, x: (1 - Math.cos(a)) * radius, y: (1 - Math.cos(Math.PI / 2 - a)) * radius,
          sid, mat, smooth: true,
        });
      }
      L[L.length - 1] = { ...L[L.length - 1], sid: null };
    }
    const bands = this.spline.loft(L, { from, to, stepMeters: o.step ?? 0.7 });
    for (const band of bands) {
      const p = L[band.index];
      if (!p || p.mat === undefined || p.sid == null) { band.geometry.dispose(); continue; }
      this.add(band.geometry, this.mat(p.mat), { surfaceId: p.sid, cast: false, receive: true });
      band.geometry.dispose();
    }
    return this;
  }

  /**
   * A stunt loop-the-loop: a full vertical circle of road, entered and exited
   * tangentially at ground level. Built on its own spline so the main
   * centreline (and therefore lap progress) is untouched.
   *
   * @param {object} o
   * @param {number[]} o.at `[x, y, z]` entry point on the ground
   * @param {number} o.heading radians — 0 = travelling −Z
   * @param {number} [o.radius=1.3]
   * @param {number} [o.width=1.9]
   * @param {number} [o.lead=2.5] straight lead-in/out length
   */
  loop(o = {}) {
    const at = new THREE.Vector3(...toXYZ(o.at ?? [0, 0, 0]));
    const heading = o.heading ?? 0;
    const r = o.radius ?? 1.3;
    const w = o.width ?? 1.9;
    const lead = o.lead ?? 2.5;
    const sid = o.surfaceId ?? SurfaceId.PLASTIC;
    const mat = o.material ?? 'plastic/injection_gloss';

    const fx = Math.sin(heading), fz = -Math.cos(heading);   // forward
    const nodes = [];
    const pushNode = (dist, y) => {
      nodes.push({ p: [at.x + fx * dist, at.y + y, at.z + fz * dist], w });
    };
    pushNode(-lead, 0);
    pushNode(-lead * 0.5, 0);
    pushNode(-0.15, 0.004);
    // Full circle in the vertical plane containing the forward axis.
    const steps = o.segments ?? 22;
    for (let i = 1; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const d = Math.sin(a) * r;
      const y = r - Math.cos(a) * r;
      nodes.push({ p: [at.x + fx * d, at.y + y, at.z + fz * d], w });
    }
    pushNode(0.15, 0.004);
    pushNode(lead * 0.5, 0);
    pushNode(lead, 0);

    const loopSpline = new CenterlineSpline(nodes, {
      closed: false, samplesPerSegment: 14, upMode: 'transport',
    });
    const L = [
      { w: -1, y: 0, sid, mat, smooth: false },
      { w: 1, y: 0, sid: null },
    ];
    const bands = loopSpline.loft(L, { from: 0, to: 1, stepMeters: 0.16 });
    for (const band of bands) {
      const p = L[band.index];
      if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
      this.add(band.geometry, this.mat(p.mat), { surfaceId: p.sid, cast: true, receive: true });
      band.geometry.dispose();
    }
    // Outer shell (the underside of the loop) so it reads as a solid tube and a
    // car cannot fall through the back of a one-sided triangle.
    const outer = [
      { w: -1, y: -0.03, sid, mat: o.shellMaterial ?? 'plastic/abs_matte' },
      { w: 1, y: -0.03, sid: null },
    ];
    const b2 = loopSpline.loft(outer, { from: 0, to: 1, stepMeters: 0.16, flip: true });
    for (const band of b2) {
      const p = outer[band.index];
      if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
      this.add(band.geometry, this.mat(p.mat), { surfaceId: p.sid, cast: true, receive: true });
      band.geometry.dispose();
    }
    // Side walls keep you on it.
    for (const s of [-1, 1]) {
      const side = [
        { w: s, x: s * 0.01, y: -0.03, sid, mat: o.shellMaterial ?? 'plastic/abs_matte' },
        { w: s, x: s * 0.01, y: 0.10, sid: null },
      ];
      const b3 = loopSpline.loft(side, { from: 0, to: 1, stepMeters: 0.2, flip: s > 0 });
      for (const band of b3) {
        const p = side[band.index];
        if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
        this.add(band.geometry, this.mat(p.mat), { surfaceId: p.sid, cast: true, receive: false });
        band.geometry.dispose();
      }
    }
    return this;
  }

  /**
   * A flight of stairs from `from` to `to` (world points). Steps are real
   * geometry with a solid skirt, so a car can bounce down them but cannot fall
   * inside.
   */
  stairs(o = {}) {
    const A = new THREE.Vector3(...toXYZ(o.from ?? [0, 1, 0]));
    const B = new THREE.Vector3(...toXYZ(o.to ?? [0, 0, 3]));
    const steps = Math.max(1, o.steps ?? 5);
    const w = o.width ?? 2.6;
    _v.copy(B).sub(A);
    const run = Math.hypot(_v.x, _v.z) / steps;
    const rise = Math.abs(_v.y) / steps;
    const yaw = Math.atan2(_v.x, _v.z);
    const geo = G.stairsGeo(w, steps, rise, run, { skirt: o.skirt ?? 0.1, nosing: o.nosing ?? 0.01, radius: 0.006 });
    // stairsGeo climbs toward +Z from the bottom of the first riser; we go DOWN
    // from A to B, so anchor at B (the low end) and face back up the slope.
    _v2.copy(B);
    _e.set(0, yaw + Math.PI, 0, 'YXZ');
    _q.setFromEuler(_e);
    _m.compose(_v2, _q, _s.set(1, 1, 1));
    this.add(geo, this.mat(o.material ?? 'tile/ceramic_glazed', o.matOpts), {
      matrix: _m, surfaceId: o.surfaceId ?? SurfaceId.TILE, cast: true, receive: true,
    });
    geo.dispose();
    return this;
  }

  /**
   * A bridge / plank between two world points: a deck with optional kerbs,
   * solid underneath, plus supports.
   */
  bridge(o = {}) {
    const A = new THREE.Vector3(...toXYZ(o.from ?? [0, 0, 0]));
    const B = new THREE.Vector3(...toXYZ(o.to ?? [0, 0, 6]));
    const w = o.width ?? 1.1;
    const th = o.thickness ?? 0.07;
    const sid = o.surfaceId ?? SurfaceId.WOOD;
    const mat = this.mat(o.material ?? 'wood/pine_planks', o.matOpts);
    _v.copy(B).sub(A);
    const len = _v.length();
    if (len < 1e-3) return this;
    const yaw = Math.atan2(_v.x, _v.z);
    const pitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));

    const deck = G.boxMeters(w, th, len, { radius: 0.008, seg: 2 });
    _v2.copy(A).add(B).multiplyScalar(0.5);
    _v2.y -= th * 0.5;
    _e.set(-pitch, yaw, 0, 'YXZ'); _q.setFromEuler(_e);
    _m.compose(_v2, _q, _s.set(1, 1, 1));
    this.add(deck, mat, { matrix: _m, surfaceId: sid, cast: true, receive: true });
    deck.dispose();

    if (o.kerb) {
      const kh = o.kerb.height ?? 0.05;
      const kmat = this.mat(o.kerb.material ?? 'wood/pine_planks');
      for (const s of [-1, 1]) {
        const k = G.boxMeters(0.05, kh, len, { radius: 0.008, seg: 2 });
        _v2.copy(A).add(B).multiplyScalar(0.5);
        _v2.y += kh * 0.5 - th * 0.02;
        _v2.x += Math.cos(yaw) * s * (w * 0.5 - 0.025);
        _v2.z -= Math.sin(yaw) * s * (w * 0.5 - 0.025);
        _e.set(-pitch, yaw, 0, 'YXZ'); _q.setFromEuler(_e);
        _m.compose(_v2, _q, _s.set(1, 1, 1));
        this.add(k, kmat, { matrix: _m, surfaceId: sid, cast: true, receive: true });
        k.dispose();
      }
    }
    if (o.piers) {
      const n = o.piers.count ?? 2;
      const pr = o.piers.radius ?? 0.07;
      const drop = o.piers.depth ?? 0.6;
      const pmat = this.mat(o.piers.material ?? 'wood/pine_planks');
      const pier = G.cylinderMeters(pr, pr * 1.15, drop, 8);
      for (let i = 0; i < n; i++) {
        const f = (i + 1) / (n + 1);
        _v2.lerpVectors(A, B, f);
        _v2.y -= drop * 0.5 + th;
        _m.compose(_v2, IDENT_Q, _s.set(1, 1, 1));
        this.instance(`bridge:pier:${pr}:${drop}`, pier, pmat, _m,
          { collide: 'box', surfaceId: sid, cast: true, receive: true });
      }
      pier.dispose();
    }
    return this;
  }

  /**
   * A tunnel: a lofted half-cylinder shell over a stretch of the road, open at
   * both ends, dark inside. Collides on the inside so a car can ride the walls.
   */
  tunnel(o = {}) {
    if (!this.spline) return this;
    const from = o.from ?? 0, to = o.to ?? 0.1;
    const radius = o.radius ?? 1.8;
    const seg = Math.max(4, o.segments ?? 9);
    const sid = o.surfaceId ?? SurfaceId.CONCRETE;
    const mat = o.material ?? 'concrete/rough';
    const L = [];
    for (let i = 0; i <= seg; i++) {
      const a = Math.PI * (i / seg);
      L.push({
        x: -Math.cos(a) * radius, y: Math.sin(a) * radius,
        sid, mat, smooth: true,
      });
    }
    L[L.length - 1] = { ...L[L.length - 1], sid: null };
    const bands = this.spline.loft(L, { from, to, stepMeters: o.step ?? 0.8, flip: true, uOffset: 0 });
    for (const band of bands) {
      const p = L[band.index];
      if (!p || p.mat === undefined || p.sid == null) { band.geometry.dispose(); continue; }
      this.add(band.geometry, this.mat(p.mat, { color: o.tint ?? 0xb8b4ac }), {
        surfaceId: p.sid, cast: o.cast !== false, receive: true,
      });
      band.geometry.dispose();
    }
    return this;
  }

  /**
   * An overhead banner / arch across the road. Two posts and a stretched cloth
   * with procedurally drawn text.
   */
  banner(t, o = {}) {
    if (!this.spline) return this;
    this.spline.sample(t, _smp);
    const h = o.height ?? 1.5;
    const clearance = o.clearance ?? 1.0;
    const w = (o.width ?? _smp.width + 1.2);
    const postR = o.postRadius ?? 0.07;
    const postMat = this.mat(o.postMaterial ?? 'metal/brushed_alu');

    for (const s of [-1, 1]) {
      _smp.offset(s * w * 0.5, h * 0.5, _v);
      const post = G.cylinderMeters(postR, postR * 1.2, h, 10);
      _q.setFromUnitVectors(UP, _smp.normal);
      _m.compose(_v, _q, _s.set(1, 1, 1));
      this.add(post, postMat, { matrix: _m, surfaceId: SurfaceId.METAL, cast: true, receive: true });
      post.dispose();
    }

    const clothH = h - clearance;
    if (clothH > 0.08) {
      const tex = this.assets
        ? PT.textTexture(this.assets, `banner:${this.meta.id}:${o.key ?? o.text ?? 'finish'}`, {
          text: o.text ?? 'FINISH',
          width: 1024, height: 256,
          color: o.textColor ?? '#fff6e2',
          background: o.background ?? '#8e1f22',
          outline: o.outline ?? '#2a0a0b',
          outlineWidth: 6,
          border: o.border ?? '#e8c66a',
          borderWidth: 10,
          font: 'vector', weight: 1.25, tracking: 0.1, wear: 0.3,
          seed: this.meta.seed,
        })
        : null;
      const bmat = tex
        ? this.decal({ texture: tex, key: `banner:${this.meta.id}:${o.key ?? o.text ?? 'finish'}`, doubleSide: true, roughness: 0.75, offsetFactor: 0 })
        : this.mat('fabric/felt', { color: 0x8e1f22, doubleSide: true });
      const cloth = G.planeXY(w, clothH);
      G.scaleUV(cloth, 1 / w, 1 / clothH);      // decal wants 0..1
      _smp.offset(0, clearance + clothH * 0.5, _v);
      _smp.orientation(_q);
      _m.compose(_v, _q, _s.set(1, 1, 1));
      this.add(cloth, bmat, { matrix: _m, surfaceId: null, collide: false, cast: false, receive: false, decor: true, order: 2 });
      cloth.dispose();
      // A crossbar so the cloth hangs from something.
      const bar = G.cylinderMeters(0.035, 0.035, w, 8);
      bar.rotateZ(Math.PI / 2);
      _smp.offset(0, clearance + clothH, _v);
      _smp.orientation(_q);
      _m.compose(_v, _q, _s.set(1, 1, 1));
      this.add(bar, postMat, { matrix: _m, surfaceId: null, collide: false, cast: true, receive: false });
      bar.dispose();
    }
    return this;
  }

  /**
   * A painted start/finish line across the road (chequered, drawn in code).
   */
  finishLine(t, o = {}) {
    if (!this.spline || !this.assets) return this;
    const depth = o.depth ?? 0.55;
    const tex = PT.decalTexture(this.assets, `finishline:${this.meta.id}`, (ctx, w, hh) => {
      const cols = 16, rows = 3;
      const cw = w / cols, ch = hh / rows;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          ctx.fillStyle = ((i + j) & 1) ? '#f4f1e8' : '#16161a';
          ctx.fillRect(i * cw, j * ch, cw + 1, ch + 1);
        }
      }
      // scuffed
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#000';
      for (let i = 0; i < 90; i++) {
        const x = Math.random() * w, y = Math.random() * hh;
        ctx.fillRect(x, y, 2 + Math.random() * 22, 1 + Math.random() * 3);
      }
      ctx.globalAlpha = 1;
    }, { width: 512, height: 96, wrap: THREE.RepeatWrapping });
    const mat = this.decal({ texture: tex, key: `finishline:${this.meta.id}`, roughness: 0.6, offsetFactor: -4, offsetUnits: -4 });

    const halfT = depth / (2 * this.spline.length);
    // `mat: 'x'` is only a "this band exists" sentinel — the material below is
    // used directly, since a decal is not a catalogue entry.
    const L = [
      { w: -1.02, y: 0.0035, sid: null, mat: 'x' },
      { w: 1.02, y: 0.0035, sid: null },
    ];
    const bands = this.spline.loft(L, {
      from: this.spline.wrapT(t - halfT), to: this.spline.wrapT(t + halfT), stepMeters: 0.12,
    });
    for (const band of bands) {
      if (band.index !== 0) { band.geometry.dispose(); continue; }
      // UVs are metres; normalise them to 0..1 across the strip.
      const uv = band.geometry.getAttribute('uv');
      this.spline.sample(t, _smp2);
      const span = _smp2.width * 1.02;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / span, uv.getY(i) / depth);
      uv.needsUpdate = true;
      this.add(band.geometry, mat, {
        surfaceId: null, collide: false, cast: false, receive: true, order: 1,
      });
      band.geometry.dispose();
    }
    return this;
  }

  /**
   * A ground decal patch (oil, damp, scuff, a sprinkler's wet arc). Purely
   * visual unless `surfaceId` is given.
   */
  patch(o = {}) {
    const r = o.radius ?? 1;
    const geo = o.ring
      ? G.ringXZ(o.innerRadius ?? r * 0.4, r, o.segments ?? 36, { thetaStart: o.thetaStart ?? 0, thetaLength: o.thetaLength ?? Math.PI * 2 })
      : G.discXZ(r, o.segments ?? 28, { thetaStart: o.thetaStart ?? 0, thetaLength: o.thetaLength ?? Math.PI * 2 });
    const mat = o.material
      ? this.mat(o.material, { ...(o.matOpts ?? {}), transparent: o.opacity != null, opacity: o.opacity ?? 1 })
      : this.mat('hazard/oil_slick');
    const c = toXYZ(o.center ?? [0, 0.004, 0]);
    _v.set(c[0], c[1] ?? 0.004, c[2]);
    _q.setFromAxisAngle(UP, o.rotation ?? 0);
    _m.compose(_v, _q, _s.set(1, 1, 1));
    this.add(geo, mat, {
      matrix: _m, surfaceId: o.surfaceId ?? null, collide: o.surfaceId != null,
      cast: false, receive: true, order: o.order ?? 1, decor: o.surfaceId == null,
    });
    geo.dispose();
    return this;
  }

  // ══════════════════════════════════════════════════════════════════ props

  /**
   * Place a prop from the library. See `Props.js` for the catalogue.
   * @param {string} kind
   * @param {object} opts `{ position, rotation, scale, color, dynamic, instanced, … }`
   */
  prop(kind, opts = {}) {
    try {
      return spawnProp(this, kind, opts);
    } catch (err) {
      console.warn(`[TrackBuilder] prop "${kind}" failed:`, err);
      return null;
    }
  }

  /** Scatter `count` copies of a prop inside a rectangle, avoiding the road. */
  scatter(kind, o = {}) {
    const [x0, z0] = o.min ?? [-5, -5];
    const [x1, z1] = o.max ?? [5, 5];
    const count = o.count ?? 8;
    const clear = o.clearRoad ?? 0;
    const res = { t: 0, dist: 0, lateral: 0 };
    for (let i = 0; i < count; i++) {
      let ok = false;
      for (let tries = 0; tries < 10 && !ok; tries++) {
        _v.set(this.rndRange(x0, x1), o.y ?? 0, this.rndRange(z0, z1));
        if (clear > 0 && this.spline) {
          this.spline.closestPoint(_v, _closest);
          if (Math.abs(_closest.lateral) < _closest.width * 0.5 + clear) continue;
        }
        ok = true;
      }
      if (!ok) continue;
      this.prop(kind, {
        ...o.propOpts,
        position: [_v.x, o.y ?? 0, _v.z],
        rotation: [0, this.rnd() * Math.PI * 2, 0],
        scale: o.scaleRange ? this.rndRange(o.scaleRange[0], o.scaleRange[1]) : (o.propOpts?.scale ?? 1),
        instanced: o.instanced !== false,
        // A caller that pins `seed` in propOpts wants ONE geometry variant (and
        // therefore one InstancedMesh); otherwise vary it.
        seed: o.propOpts?.seed ?? this.rndInt(0, 9999),
      });
      void res;
    }
    return this;
  }

  /**
   * Line props up along a stretch of road at a lateral offset — velvet ropes,
   * cones marking a chicane, dominoes, hedges.
   */
  line(kind, o = {}) {
    if (!this.spline) return this;
    const from = o.from ?? 0;
    let to = o.to ?? 0.1;
    if (to <= from) to += 1;
    const span = (to - from) * this.spline.length;
    const spacing = o.spacing ?? 1.0;
    const n = Math.max(1, Math.round(span / spacing));
    for (let i = 0; i <= n; i++) {
      const t = this.spline.wrapT(from + ((to - from) * i) / n);
      this.spline.sample(t, _smp);
      const lat = typeof o.offset === 'function' ? o.offset(i / n) : (o.offset ?? 0);
      const edge = o.edge != null ? o.edge * _smp.width * 0.5 : 0;
      _smp.offset(lat + edge, o.y ?? 0, _v);
      const yaw = Math.atan2(_smp.tangent.x, _smp.tangent.z) + Math.PI + (o.yawOffset ?? 0);
      this.prop(kind, {
        ...o.propOpts,
        position: [_v.x, _v.y, _v.z],
        rotation: [0, yaw, 0],
        instanced: o.instanced !== false,
        seed: i * 977 + this.meta.seed,
      });
    }
    return this;
  }

  // ═════════════════════════════════════════════════════════ race layout data

  /**
   * Generate checkpoints along the centreline. `checkpoints[0]` is the finish.
   * @param {{count?:number, halfWidthPad?:number, height?:number, depth?:number, finishT?:number}} [o]
   */
  checkpoints(o = {}) {
    if (!this.spline) return this;
    const len = this.spline.length;
    const count = Math.max(4, o.count ?? Math.round(len / 17));
    const pad = o.halfWidthPad ?? 1.4;
    const finishT = o.finishT ?? 0;
    const list = [];
    for (let i = 0; i < count; i++) {
      const t = this.spline.wrapT(finishT + i / count);
      this.spline.sample(t, _smp);
      const pos = new THREE.Vector3();
      _smp.offset(0, o.lift ?? 0.5, pos);
      const quat = new THREE.Quaternion();
      _smp.orientation(quat);
      list.push({
        index: i,
        position: pos,
        quaternion: quat,
        halfExtents: new THREE.Vector3(_smp.width * 0.5 + pad, o.height ?? 1.4, o.depth ?? 0.4),
        isFinish: i === 0,
        t,
        distance: t * len,
        width: _smp.width,
        forward: _smp.tangent.clone(),
      });
    }
    this.checkpointList = list;
    return this;
  }

  /**
   * A staggered start grid behind the finish line. ≥ 8 slots by contract.
   * @param {{count?:number, rowGap?:number, columns?:number, spread?:number,
   *          firstBack?:number, lift?:number, finishT?:number}} [o]
   */
  startGrid(o = {}) {
    if (!this.spline) return this;
    const count = Math.max(8, o.count ?? 8);
    const columns = Math.max(1, o.columns ?? 2);
    const rowGap = o.rowGap ?? 2.05;
    const firstBack = o.firstBack ?? 3.4;
    const stagger = o.stagger ?? rowGap * 0.42;
    const finishT = o.finishT ?? 0;
    const len = this.spline.length;
    const list = [];
    for (let i = 0; i < count; i++) {
      const row = Math.floor(i / columns);
      const col = i % columns;
      const back = firstBack + row * rowGap + col * stagger;
      const t = this.spline.wrapT(finishT - back / len);
      this.spline.sample(t, _smp);
      const spread = o.spread ?? Math.min(0.34, _smp.width * 0.16);
      const lateral = columns === 1 ? 0 : (col - (columns - 1) / 2) * (spread * 2);
      const pos = new THREE.Vector3();
      _smp.offset(lateral, o.lift ?? 0.055, pos);
      const quat = new THREE.Quaternion();
      _smp.orientation(quat);
      list.push({ position: pos, quaternion: quat, index: i, t, lateral });
    }
    this.startGridList = list;
    return this;
  }

  /**
   * Respawn points every `spacing` metres, each tagged with the checkpoint it
   * belongs to. Guaranteed to sit on solid road (gaps are skipped forward).
   */
  respawns(o = {}) {
    if (!this.spline) return this;
    const spacing = o.spacing ?? 13;
    const len = this.spline.length;
    const n = Math.max(6, Math.round(len / spacing));
    const cps = this.checkpointList ?? [];
    const list = [];
    for (let i = 0; i < n; i++) {
      let t = this.spline.wrapT(i / n);
      // Nudge out of a jump gap so a respawn never drops the car into the void.
      let guard = 0;
      while (this.isGap(t) && guard++ < 40) t = this.advance(t, 0.6);
      this.spline.sample(t, _smp);
      const pos = new THREE.Vector3();
      _smp.offset(0, o.lift ?? 0.14, pos);
      const quat = new THREE.Quaternion();
      _smp.orientation(quat);
      // Which checkpoint have we most recently passed?
      let cpIndex = 0;
      for (let c = 0; c < cps.length; c++) if (cps[c].t <= t + 1e-6) cpIndex = c;
      list.push({ position: pos, quaternion: quat, checkpointIndex: cpIndex, t });
    }
    this.respawnList = list;
    return this;
  }

  /**
   * A row of pickup pads across the road at lap fraction `t`.
   * @param {number} t
   * @param {{count?:number, spread?:number, y?:number, radius?:number}} [o]
   */
  pickupRow(t, o = {}) {
    if (!this.spline) return this;
    const count = Math.max(1, o.count ?? 3);
    const radius = o.radius ?? 0.16;
    this.spline.sample(t, _smp);
    const spread = o.spread ?? Math.min(_smp.width * 0.3, 0.85);
    for (let i = 0; i < count; i++) {
      const lateral = count === 1 ? 0 : ((i / (count - 1)) * 2 - 1) * spread;
      const pos = new THREE.Vector3();
      _smp.offset(lateral, o.y ?? 0.012, pos);
      const quat = new THREE.Quaternion();
      _smp.orientation(quat);
      this.pads.push({ position: pos, quaternion: quat, id: this.pads.length, t, radius });
      this._padVisual(pos, quat, radius);
    }
    return this;
  }

  /** Evenly spaced pickup rows around the lap. */
  pickupPads(o = {}) {
    if (!this.spline) return this;
    const rows = o.rows ?? 5;
    const offset = o.offset ?? 0.11;
    for (let i = 0; i < rows; i++) {
      let t = this.spline.wrapT(offset + i / rows);
      let guard = 0;
      while (this.isGap(t) && guard++ < 40) t = this.advance(t, 0.8);
      this.pickupRow(t, o);
    }
    return this;
  }

  _padVisual(position, quaternion, radius) {
    this._padGeo ??= (() => {
      const g = G.ringXZ(radius * 0.55, radius, 24);
      this._ownedGeo.push(g);
      return g;
    })();
    this._padMat ??= this.glow(0xffd479, 1.7, { opacity: 0.85, base: 0x241a05 });
    const mesh = new THREE.Mesh(this._padGeo, this._padMat);
    mesh.position.copy(position);
    mesh.quaternion.copy(quaternion);
    mesh.userData.noCollision = true;
    mesh.renderOrder = 2;
    this.padGroup.add(mesh);
  }

  /**
   * A registered shortcut. `nodes` (world points) define its own drivable line;
   * the builder derives AI nodes for it so the AI can occasionally take it.
   *
   * @param {object} o
   * @param {string} o.id
   * @param {number} o.entryT lap fraction where it leaves the main line
   * @param {number} o.exitT lap fraction where it rejoins
   * @param {number} [o.risk=0.5] 0 = free, 1 = suicidal
   * @param {Array} [o.nodes] centreline nodes for the shortcut path
   * @param {number} [o.width=1.8]
   * @param {number} [o.savedMetres] how much shorter it is (informational)
   */
  shortcut(o = {}) {
    const spline = o.nodes ? new CenterlineSpline(o.nodes, { closed: false, samplesPerSegment: 22, width: o.width ?? 1.8 }) : null;
    const entry = new THREE.Vector3();
    const exit = new THREE.Vector3();
    if (spline) {
      spline.positionAt(0, entry);
      spline.positionAt(1, exit);
    } else if (this.spline) {
      this.spline.positionAt(o.entryT ?? 0, entry);
      this.spline.positionAt(o.exitT ?? 0, exit);
    }
    const sc = {
      id: o.id ?? `shortcut${this.shortcutList.length}`,
      entry, exit,
      risk: o.risk ?? 0.5,
      entryT: o.entryT ?? 0,
      exitT: o.exitT ?? 0,
      spline,
      length: spline?.length ?? 0,
      savedMetres: o.savedMetres ?? 0,
      name: o.name ?? null,
      aiNodes: [],
    };
    this.shortcutList.push(sc);
    return sc;
  }

  /**
   * Loft a shortcut's road surface using its own spline. Call after
   * {@link shortcut}.
   */
  shortcutRoad(sc, o = {}) {
    if (!sc?.spline) return this;
    const sid = o.surfaceId ?? SurfaceId.CONCRETE;
    const mat = o.material ?? 'concrete/screed';
    const L = [];
    if (o.wall) {
      const h = o.wall.height ?? 0.35, th = o.wall.thickness ?? 0.12;
      L.push({ w: -1, x: -th, y: h, sid: o.wall.surfaceId ?? SurfaceId.CONCRETE, mat: o.wall.material ?? 'drywall/painted' });
      L.push({ w: -1, x: 0, y: h, sid: o.wall.surfaceId ?? SurfaceId.CONCRETE, mat: o.wall.material ?? 'drywall/painted' });
      L.push({ w: -1, x: 0, y: 0, sid, mat });
      L.push({ w: 1, y: 0, sid: o.wall.surfaceId ?? SurfaceId.CONCRETE, mat: o.wall.material ?? 'drywall/painted' });
      L.push({ w: 1, x: 0, y: h, sid: o.wall.surfaceId ?? SurfaceId.CONCRETE, mat: o.wall.material ?? 'drywall/painted' });
      L.push({ w: 1, x: th, y: h, sid: null });
    } else {
      L.push({ w: -1, y: 0, sid, mat });
      L.push({ w: 1, y: 0, sid: null });
    }
    const bands = sc.spline.loft(L, { from: 0, to: 1, stepMeters: o.step ?? 0.7 });
    for (const band of bands) {
      const p = L[band.index];
      if (!p || p.mat === undefined || p.sid == null) { band.geometry.dispose(); continue; }
      this.add(band.geometry, this.mat(p.mat, p.matOpts), { surfaceId: p.sid, cast: false, receive: true });
      band.geometry.dispose();
    }
    if (o.ceiling) {
      const C = [
        { w: -1.02, y: o.ceiling.height ?? 0.9, sid: o.ceiling.surfaceId ?? SurfaceId.CONCRETE, mat: o.ceiling.material ?? 'drywall/painted' },
        { w: 1.02, y: o.ceiling.height ?? 0.9, sid: null },
      ];
      const cb = sc.spline.loft(C, { from: 0, to: 1, stepMeters: 1.0, flip: true });
      for (const band of cb) {
        const p = C[band.index];
        if (!p || p.mat === undefined) { band.geometry.dispose(); continue; }
        this.add(band.geometry, this.mat(p.mat, { color: o.ceiling.tint ?? 0xbdb8ad }), {
          surfaceId: p.sid, cast: false, receive: false,
        });
        band.geometry.dispose();
      }
    }
    return this;
  }

  /**
   * Build the AI path from the centreline: a node every `spacing` metres with a
   * curvature-derived target speed, then a two-pass braking/acceleration solve
   * so the speeds are actually reachable.
   *
   * @param {{spacing?:number, topSpeed?:number, brake?:number, accel?:number,
   *          tyre?:number, safety?:number, raceLine?:boolean}} [o]
   */
  aiPath(o = {}) {
    if (!this.spline) { this.aiPathData = { nodes: [] }; return this; }
    const spacing = o.spacing ?? 3.2;
    const len = this.spline.length;
    const n = Math.max(8, Math.round(len / spacing));
    const topSpeed = o.topSpeed ?? 9.0;
    const brake = o.brake ?? 13.0;       // m/s² — 2 g gravity means big numbers
    const accel = o.accel ?? 7.0;
    const tyre = o.tyre ?? 1.05;
    const safety = o.safety ?? 0.92;
    const gravity = 19.6;
    const raceLine = o.raceLine !== false;

    const nodes = new Array(n);
    const kappa = new Float64Array(n);
    const ds = len / n;

    for (let i = 0; i < n; i++) {
      const t = i / n;
      this.spline.sample(t, _smp);
      const k = this.spline.smoothCurvature(t, o.window ?? 4.0, 5);
      kappa[i] = k;
      const sid = this._surfaceHint(_smp);
      const grip = getSurface(sid).grip;
      const aLat = Math.max(0.5, grip * gravity * tyre);
      const kAbs = Math.max(1e-4, Math.abs(k));
      const vCorner = Math.sqrt(aLat / kAbs);
      nodes[i] = {
        position: _smp.position.clone(),
        forward: _smp.tangent.clone(),
        normal: _smp.normal.clone(),
        right: _smp.binormal.clone(),
        width: _smp.width,
        t,
        curvature: k,
        surfaceId: sid,
        targetSpeed: Math.min(topSpeed, vCorner) * safety,
        jump: this.isGap(t),
        shortcutId: null,
        offset: 0,
        brakeHint: 0,
      };
    }

    // Manual hints (kickers want to be hit at speed).
    for (const hint of this._speedHints) {
      const i = Math.round(this.spline.wrapT(hint.t) * n) % n;
      nodes[i].targetSpeed = Math.max(nodes[i].targetSpeed, Math.min(topSpeed, hint.speed));
      if (hint.jump) nodes[i].jump = true;
    }

    // Backward pass: you must be able to brake down to the next corner.
    for (let pass = 0; pass < 3; pass++) {
      for (let k = n - 1; k >= 0; k--) {
        const j = (k + 1) % n;
        const vNext = nodes[j].targetSpeed;
        const vMax = Math.sqrt(vNext * vNext + 2 * brake * ds);
        if (nodes[k].targetSpeed > vMax) {
          nodes[k].targetSpeed = vMax;
          nodes[k].brakeHint = 1;
        }
      }
    }
    // Forward pass: you cannot accelerate faster than the engine allows.
    for (let pass = 0; pass < 3; pass++) {
      for (let k = 0; k < n; k++) {
        const p = (k - 1 + n) % n;
        const vPrev = nodes[p].targetSpeed;
        const vMax = Math.sqrt(vPrev * vPrev + 2 * accel * ds);
        if (nodes[k].targetSpeed > vMax) nodes[k].targetSpeed = vMax;
      }
    }

    // A crude but effective racing line: hug the inside of a corner, drift out
    // on entry/exit. Then smooth so it is drivable.
    if (raceLine) {
      const carHalf = o.carHalfWidth ?? 0.13;
      for (let i = 0; i < n; i++) {
        const k = kappa[i];
        const usable = Math.max(0, nodes[i].width * 0.5 - carHalf - 0.12);
        const strength = Math.min(1, Math.abs(k) * 12);
        nodes[i].offset = -Math.sign(k) * usable * strength;
      }
      for (let pass = 0; pass < 8; pass++) {
        for (let i = 0; i < n; i++) {
          const a = nodes[(i - 1 + n) % n].offset;
          const b = nodes[i].offset;
          const c = nodes[(i + 1) % n].offset;
          const usable = Math.max(0, nodes[i].width * 0.5 - carHalf - 0.12);
          nodes[i].offset = Math.max(-usable, Math.min(usable, (a + 2 * b + c) / 4));
        }
      }
    }

    // Shortcut sub-paths, appended after the main loop with a shortcutId.
    for (const sc of this.shortcutList) {
      if (!sc.spline) continue;
      const sn = Math.max(3, Math.round(sc.spline.length / spacing));
      sc.aiNodes.length = 0;
      for (let i = 0; i <= sn; i++) {
        const t = i / sn;
        sc.spline.sample(t, _smp);
        const k = sc.spline.smoothCurvature(t, 3.0, 3);
        const sid = this._surfaceHint(_smp);
        const grip = getSurface(sid).grip;
        const kAbs = Math.max(1e-4, Math.abs(k));
        const node = {
          position: _smp.position.clone(),
          forward: _smp.tangent.clone(),
          normal: _smp.normal.clone(),
          right: _smp.binormal.clone(),
          width: _smp.width,
          t: sc.entryT,
          shortcutT: t,
          curvature: k,
          surfaceId: sid,
          targetSpeed: Math.min(topSpeed, Math.sqrt(Math.max(0.5, grip * gravity * tyre) / kAbs)) * safety * 0.94,
          jump: false,
          shortcutId: sc.id,
          offset: 0,
          brakeHint: 0,
        };
        sc.aiNodes.push(node);
      }
      // Same braking solve along the branch.
      for (let pass = 0; pass < 2; pass++) {
        for (let k = sc.aiNodes.length - 2; k >= 0; k--) {
          const vNext = sc.aiNodes[k + 1].targetSpeed;
          const vMax = Math.sqrt(vNext * vNext + 2 * brake * (sc.spline.length / sn));
          if (sc.aiNodes[k].targetSpeed > vMax) sc.aiNodes[k].targetSpeed = vMax;
        }
      }
    }

    this.aiPathData = {
      nodes,
      spacing: ds,
      closed: true,
      topSpeed,
      branches: this.shortcutList.filter((s) => s.aiNodes.length > 0).map((s) => ({
        id: s.id, entryT: s.entryT, exitT: s.exitT, risk: s.risk, nodes: s.aiNodes,
      })),
    };
    return this;
  }

  /** Best-effort surface id under a sample — used to weight AI target speeds. */
  _surfaceHint(sample) {
    const phys = this.game?.physics;
    if (!phys || !phys.trackMesh) return this._defaultSurfaceId ?? SurfaceId.CONCRETE;
    _v.copy(sample.position).addScaledVector(sample.normal, 0.4);
    _v2.copy(sample.normal).multiplyScalar(-1);
    return phys.raycastTrack(_v, _v2, 1.2, _rayHit) ? _rayHit.surfaceId : (this._defaultSurfaceId ?? SurfaceId.CONCRETE);
  }

  /** Tell the AI-path builder what the road is mostly made of. */
  defaultSurface(sid) { this._defaultSurfaceId = sid; return this; }

  // ═════════════════════════════════════════════════════════════ environment

  /** Store the render-system environment descriptor. */
  environment(desc) {
    this._envDesc = { ...(this._envDesc ?? {}), ...(desc ?? {}) };
    return this;
  }

  /** Store the audio descriptor (reverb + ambience). */
  audio(desc) {
    this._audio = { ...this._audio, ...(desc ?? {}) };
    return this;
  }

  /**
   * A grip-modifying zone the vehicle system may optionally sample (a
   * sprinkler's wet arc, a patch of spilled oil that is animated). The baked
   * collision surface id remains the authoritative source; this is an extra.
   */
  gripZone(o = {}) {
    this.surfaceZones.push({
      kind: o.kind ?? 'grip',
      position: new THREE.Vector3(...toXYZ(o.center ?? [0, 0, 0])),
      radius: o.radius ?? 2,
      innerRadius: o.innerRadius ?? 0,
      a0: o.a0 ?? 0,
      a1: o.a1 ?? Math.PI * 2,
      gripScale: o.gripScale ?? 0.6,
      surfaceId: o.surfaceId ?? null,
      active: o.active !== false,
      sweep: o.sweep ?? null,
      id: o.id ?? `zone${this.surfaceZones.length}`,
    });
    return this;
  }

  // ══════════════════════════════════════════════════════════════════ build

  /** @returns {object} TrackData, exactly the ARCHITECTURE.md shape. */
  build() {
    // Flush merge buckets and instanced meshes.
    for (const [key, bucket] of this._buckets) {
      if (bucket.geos.length) this._flushBucket(bucket, key);
    }
    this.stats.buckets = this._buckets.size;
    this._buckets.clear();

    for (const [key, inst] of this._instances) {
      if (inst.mats.length === 0) continue;
      const mesh = new THREE.InstancedMesh(inst.geometry, inst.material, inst.mats.length);
      for (let i = 0; i < inst.mats.length; i++) mesh.setMatrixAt(i, inst.mats[i]);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = inst.cast;
      mesh.receiveShadow = inst.receive;
      mesh.renderOrder = inst.order;
      mesh.name = `inst:${key}`;
      mesh.userData.noCollision = true;
      mesh.computeBoundingSphere?.();
      mesh.frustumCulled = false;   // instanced sets straddle the whole track
      (inst.decor ? this.decor : this.scene).add(mesh);
      this.stats.instanced++;
      const idx = inst.geometry.getIndex();
      this.stats.triangles += (idx ? idx.count / 3 : inst.geometry.getAttribute('position').count / 3) * inst.mats.length;
    }
    this._instances.clear();

    // Collision.
    let collision = null;
    try {
      collision = this._collision.build({ name: `track:${this.meta.id}`, convexSin: 0.1 });
      this.stats.collisionTris = collision.triangleCount;
    } catch (err) {
      console.error('[TrackBuilder] collision build failed:', err);
    }

    // Race data — generate anything the track did not ask for explicitly.
    if (!this.checkpointList) this.checkpoints();
    if (!this.startGridList) this.startGrid();
    if (!this.respawnList) this.respawns();
    if (this.pads.length === 0) this.pickupPads();
    if (!this.aiPathData) this.aiPath();

    // Bounds: the union of every mesh, padded, with a floor.
    const bounds = this.bounds.clone();
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-20, -2, -20), new THREE.Vector3(20, 8, 20));
    bounds.expandByScalar(0.5);

    const env = {
      bounds,
      scale: 10,
      ...(this._envDesc ?? {}),
    };
    if (!env.bounds) env.bounds = bounds;

    const track = {
      id: this.meta.id,
      name: this.meta.name,
      theme: this.meta.theme,
      difficulty: this.meta.difficulty,
      laps: this.meta.laps,
      description: this.meta.description,
      previewColors: this.meta.previewColors,
      lengthMeters: this.spline?.length ?? 0,

      scene: this.scene,
      collision,
      surfaces: this.surfaces,
      spline: this.spline,

      checkpoints: this.checkpointList ?? [],
      startGrid: this.startGridList ?? [],
      respawns: this.respawnList ?? [],
      pickupPads: this.pads,
      aiPath: this.aiPathData ?? { nodes: [] },
      shortcuts: this.shortcutList,
      props: this.propRuntime.props,
      surfaceZones: this.surfaceZones,

      environment: env,
      audio: this._audio,

      // internals the TrackSystem needs for update/unload
      _runtime: this.propRuntime,
      _windMaterials: this._windMats,
      _ownedGeometries: this._ownedGeo,
      _ownedMaterials: this._ownedMat,
      _gaps: this._gaps,
      stats: this.stats,

      /** Optional helper: extra grip multiplier at a world point (zones). */
      gripAt: (point) => {
        let g = 1;
        for (let i = 0; i < this.surfaceZones.length; i++) {
          const z = this.surfaceZones[i];
          if (!z.active) continue;
          const dx = point.x - z.position.x, dz = point.z - z.position.z;
          const d = Math.hypot(dx, dz);
          if (d > z.radius || d < z.innerRadius) continue;
          if (z.a1 - z.a0 < Math.PI * 2 - 1e-3) {
            let a = Math.atan2(dz, dx);
            if (a < z.a0) a += Math.PI * 2;
            if (a > z.a1) continue;
          }
          g = Math.min(g, z.gripScale);
        }
        return g;
      },
    };

    if (this.spline) this.spline.trackId = this.meta.id;
    this.propRuntime.track = track;
    return track;
  }
}

// ────────────────────────────────────────────────────────────────── helpers

const UP = new THREE.Vector3(0, 1, 0);
const IDENT_Q = new THREE.Quaternion();
const _tmpBox = new THREE.Box3();
const _rayHit = {
  hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(),
  distance: 0, surfaceId: 0, triIndex: -1, body: null,
};
const _closest = new ClosestResult();

/** Accept `[x,y,z]`, `{x,y,z}` or a Vector3. */
function toXYZ(v) {
  if (Array.isArray(v)) return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  if (v && typeof v === 'object') return [v.x ?? 0, v.y ?? 0, v.z ?? 0];
  const n = Number(v) || 0;
  return [n, n, n];
}

export { toXYZ, PROPS };
export default TrackBuilder;
