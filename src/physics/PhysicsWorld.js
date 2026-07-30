/**
 * RC RUMBLE — physics world.
 *
 * Owns the rigid bodies, the track collision mesh, the broad phase, the narrow
 * phase and the solver. Registered as `game.physics`.
 *
 * Step order (fixedUpdate, always CONFIG.physics.fixedDt = 1/120 s):
 *
 *   1. snapshot transforms for render interpolation
 *   2. integrate forces  (gravity, accumulated force/torque, damping)
 *   3. refresh world AABBs + world-space shape caches   ← the "predict" pass
 *   4. narrow phase vs the static meshes (BVH AABB query per body)
 *   5. broad phase (spatial hash) + narrow phase for dynamic pairs
 *   6. solve (warm start → velocity iterations → split-impulse position pass)
 *   7. integrate velocities into positions
 *   8. continuous collision for bodies flagged `ccd`
 *   9. sleeping
 *  10. emit 'car:collision' / 'prop:hit' for impulses above the threshold
 *
 * Nothing in the step allocates once the pools have warmed up.
 *
 * ⚠ Event payloads are POOLED (a 64-entry ring). Read them synchronously or
 *   copy what you need — do not hold the object or its Vector3s.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';

import { RigidBody, Layer, BodyType, createBoxBody, createSphereBody, createCapsuleBody } from './RigidBody.js';
import {
  ShapeType, makeBox, makeBoxSize, makeSphere, makeCapsule, makeCylinder,
  makeHull, makeHullFromGeometry,
} from './Shapes.js';
import { CollisionMesh, CollisionMeshBuilder, createRayHit } from './CollisionMesh.js';
import {
  Manifold, sphereVsTriangle, capsuleVsTriangle, hullVsTriangle,
  sphereVsSphere, sphereVsHull, hullVsHull,
  sweepSphereTriangle, SWEEP, rayHull, raySphere,
} from './Collision.js';
import { Broadphase } from './Broadphase.js';
import { Solver, ContactPool, contactKey } from './Solver.js';
import { DebugDraw } from './DebugDraw.js';

// ═══════════════════════════════════════════════════════════════════════════
// Surface material table (ARCHITECTURE.md canonical ids)
// ═══════════════════════════════════════════════════════════════════════════

/** Chassis-vs-surface friction multipliers. Mirrors the grip column. */
export const SURFACE_FRICTION = new Float32Array([
  1.00, // 0  default
  1.00, // 1  wood
  0.85, // 2  carpet
  1.05, // 3  tile
  1.00, // 4  concrete
  0.60, // 5  grass
  0.70, // 6  dirt
  0.55, // 7  gravel
  0.45, // 8  sand
  0.35, // 9  water_shallow
  0.18, // 10 ice
  0.95, // 11 metal
  0.90, // 12 plastic
  1.15, // 13 rubber
  1.02, // 14 glass
  0.10, // 15 oil_slick
]);

/** Restitution multiplier applied to the body's own restitution. */
export const SURFACE_BOUNCE = new Float32Array([
  1.00, 1.00, 0.35, 1.10, 0.90, 0.45, 0.40, 0.50,
  0.25, 0.30, 1.05, 1.15, 1.00, 1.80, 1.20, 0.60,
]);

// ═══════════════════════════════════════════════════════════════════════════
// Scratch
// ═══════════════════════════════════════════════════════════════════════════

const _v1 = new THREE.Vector3();
const _manifold = new Manifold();
const _triScratch = new Uint32Array(4096);
const _hitScratch = createRayHit();
const _hitScratch2 = createRayHit();
const _normalOut = new Float32Array(3);
// Per-body coplanar contact reduction scratch.
const _grpKeep = new Uint8Array(64);
const _grpDone = new Uint8Array(64);
const _grpIdx = new Int32Array(64);
const _grpSel = new Int32Array(4);

/** Extra skin around a body AABB when gathering candidate triangles. */
const AABB_MARGIN = 0.008;
/** Contacts closer than this with a matching normal are merged. */
const MERGE_RADIUS = 0.004;
const MERGE_RADIUS2 = MERGE_RADIUS * MERGE_RADIUS;
/** Size of the pooled event payload ring. */
const EVENT_RING = 64;

export class PhysicsWorld {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;

    /** @type {RigidBody[]} */
    this.bodies = [];
    /** Current TrackData (may be null). */
    this.track = null;
    /** @type {CollisionMesh|null} the track's collision mesh */
    this.trackMesh = null;
    /** @type {CollisionMesh[]} every static mesh queried by the world */
    this.staticMeshes = [];
    /** Surface table from the track, when present. */
    this.surfaces = null;

    const p = CONFIG.physics;
    this.gravity = p.gravity;
    this.fixedDt = p.fixedDt;
    this.maxContactsPerBody = p.maxContactsPerBody ?? 24;
    this.sleepConfig = {
      sleepLinear: p.sleepLinear,
      sleepAngular: p.sleepAngular,
      sleepTime: p.sleepTime,
    };

    this.broadphase = new Broadphase(0.55);
    this.contacts = new ContactPool(1024);
    this.solver = new Solver(p);
    this.debugDraw = new DebugDraw(game);

    /** Impulse (N·s) above which a contact fires a collision event. */
    this.impulseEventThreshold = 0.35;

    /**
     * Resting stabilisation — micro-slip / rolling resistance.
     *
     * A sequential-impulse solver leaves a small residual velocity on a body
     * held by several redundant coplanar contacts, and on a light prop with a
     * tiny inertia tensor (a 8 cm cube has I⁻¹ ≈ 3750) that residual integrates
     * into a visible drift and eventually topples a stack. Real contact patches
     * have static friction that resists exactly this micro-motion, so once a
     * body is genuinely supported (3+ contacts), receiving no gameplay force,
     * and already nearly still, its residual is bled off aggressively. It then
     * crosses the sleep thresholds and freezes solid.
     *
     * This never fights gameplay: anything with an applied force, fewer than
     * three contacts (a rolling ball, a box tipping onto an edge) or a real
     * velocity is left completely alone.
     */
    this.restStabilization = true;
    this.restLinear = 0.06;          // m/s   — 3× CONFIG.physics.sleepLinear
    this.restAngular = 1.10;         // rad/s — ~63°/s
    this.restLinearDamp = 0.86;
    this.restAngularDamp = 0.60;
    this.restMinContacts = 3;
    this.enabled = true;
    this.step = 0;

    // Deferred extra static geometry (addStaticGeometry).
    this._extraBuilder = null;
    this._extraMesh = null;
    this._extraDirty = false;

    // Pooled event payloads.
    this._evtRing = new Array(EVENT_RING);
    for (let i = 0; i < EVENT_RING; i++) {
      this._evtRing[i] = {
        carId: 0, propId: 0, body: null, other: null,
        impulse: 0, relSpeed: 0, surfaceId: 0,
        worldPoint: new THREE.Vector3(), normal: new THREE.Vector3(),
      };
    }
    this._evtIdx = 0;
    this._emittedKeys = new Int32Array(64);
    this._emittedCount = 0;

    /** Per-step perf counters (read by the debug overlay). */
    this.stats = {
      bodies: 0, awake: 0, pairs: 0, contacts: 0,
      staticContacts: 0, triangleTests: 0, ms: 0,
    };
  }

  async init() {
    if (CONFIG.debug) this.debugDraw.setEnabled(false); // opt-in from the console
  }

  // ═════════════════════════════════════════════════════════ track / statics

  /**
   * @param {object|null} track TrackData. `track.collision` should be a
   *        CollisionMesh; a raw BufferGeometry or null are tolerated.
   */
  setTrack(track) {
    this.track = track ?? null;
    this.trackMesh = null;
    this.surfaces = track?.surfaces ?? null;
    this.staticMeshes.length = 0;

    const c = track?.collision;
    if (c instanceof CollisionMesh) this.trackMesh = c;
    else if (c && c.isBufferGeometry) this.trackMesh = CollisionMesh.fromGeometry(c, 0, null, { name: 'track' });
    else if (c && c.bvh && c.tris) this.trackMesh = c;      // duck-typed mesh

    if (this.trackMesh) this.staticMeshes.push(this.trackMesh);
    if (this._extraMesh) this.staticMeshes.push(this._extraMesh);

    // Size the broadphase cell to the track scale (bounded to sane values).
    const b = this.trackMesh?.bounds;
    if (b && !b.isEmpty()) {
      const span = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
      this.broadphase.setCellSize(Math.min(1.5, Math.max(0.3, span / 90)));
    }
    this.solver.reset();
    return this.trackMesh;
  }

  /**
   * Append static collision geometry after the track is loaded (destructible
   * scenery becoming static, arena walls, gameplay blockers…).
   * The extra mesh is rebuilt lazily on the next step, so calling this in a
   * loop is cheap.
   * @param {THREE.BufferGeometry} geometry
   * @param {number} [surfaceId]
   * @param {THREE.Matrix4} [matrix]
   */
  addStaticGeometry(geometry, surfaceId = 0, matrix = null) {
    if (!geometry) return this;
    this._extraBuilder ??= new CollisionMeshBuilder();
    this._extraBuilder.addGeometry(geometry, surfaceId, matrix);
    this._extraDirty = true;
    return this;
  }

  /** Same, but walks an Object3D and reads `userData.surfaceId`. */
  addStaticObject(object3d, defaultSurfaceId = 0) {
    if (!object3d) return this;
    this._extraBuilder ??= new CollisionMeshBuilder();
    this._extraBuilder.addObject3D(object3d, defaultSurfaceId);
    this._extraDirty = true;
    return this;
  }

  _rebuildExtraStatic() {
    this._extraDirty = false;
    if (!this._extraBuilder || this._extraBuilder.isEmpty) return;
    const prev = this._extraMesh;
    this._extraMesh = this._extraBuilder.build({ name: 'static:extra' });
    const i = prev ? this.staticMeshes.indexOf(prev) : -1;
    if (i >= 0) this.staticMeshes[i] = this._extraMesh;
    else this.staticMeshes.push(this._extraMesh);
    // Wake everything — the world just changed shape underneath them.
    for (const b of this.bodies) b.wake();
  }

  // ═════════════════════════════════════════════════════════ bodies

  /** @param {RigidBody} body @returns {RigidBody} */
  addBody(body) {
    if (!body || body.world === this) return body;
    body.world = this;
    body.index = this.bodies.length;
    this.bodies.push(body);
    body.updateInertiaWorld();
    body.updateAABB();
    body.wake();
    return body;
  }

  /** @param {RigidBody} body */
  removeBody(body) {
    if (!body) return;
    const i = body.index >= 0 && this.bodies[body.index] === body
      ? body.index
      : this.bodies.indexOf(body);
    if (i < 0) return;
    // Anything resting on it must fall.
    this.wakeArea(body.aabbMin, body.aabbMax);
    const last = this.bodies.pop();
    if (i < this.bodies.length) { this.bodies[i] = last; last.index = i; }
    body.world = null;
    body.index = -1;
  }

  /** Wake every body whose AABB overlaps the given box (with a little slack). */
  wakeArea(min, max, pad = 0.05) {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.sleeping) continue;
      if (b.aabbMin.x > max.x + pad || b.aabbMax.x < min.x - pad) continue;
      if (b.aabbMin.y > max.y + pad || b.aabbMax.y < min.y - pad) continue;
      if (b.aabbMin.z > max.z + pad || b.aabbMax.z < min.z - pad) continue;
      b.wake();
    }
  }

  /** Wake everything (used on respawn / countdown). */
  wakeAll() { for (const b of this.bodies) b.wake(); }

  setGravity(y) { this.gravity = y; this.wakeAll(); }

  clear() {
    for (const b of this.bodies) { b.world = null; b.index = -1; }
    this.bodies.length = 0;
    this.staticMeshes.length = 0;
    this.trackMesh = null;
    this.track = null;
    this.surfaces = null;
    this._extraBuilder = null;
    this._extraMesh = null;
    this._extraDirty = false;
    this.contacts.reset();
    this.broadphase.clear();
    this.solver.reset();
  }

  onRaceEnd() { /* the Game calls clear() itself */ }

  // ═════════════════════════════════════════════════════════ step

  /** @param {number} dt always CONFIG.physics.fixedDt */
  fixedUpdate(dt) {
    if (!this.enabled) return;
    const t0 = (CONFIG.debug && typeof performance !== 'undefined') ? performance.now() : 0;
    this.step++;
    if (this._extraDirty) this._rebuildExtraStatic();

    const bodies = this.bodies;
    const n = bodies.length;
    this.contacts.reset();
    this._emittedCount = 0;
    this.stats.triangleTests = 0;

    // ── 1 & 2: snapshot, integrate forces ─────────────────────────────
    let awake = 0;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b.snapshot();
      b.contactCount = 0;
      b.lastImpulse = 0;
      if (!b.enabled) continue;
      b.integrateForces(dt, this.gravity);
      if (!b.sleeping) awake++;
    }

    // ── 3: predict — refresh bounds + world shape caches ──────────────
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (!b.enabled) continue;
      b.updateInertiaWorld();
      b.updateAABB(AABB_MARGIN);
      if (b.collisionEnabled && !b.sleeping) b.updateWorldCache(this.step);
    }

    // ── 4: static narrow phase ────────────────────────────────────────
    let staticContacts = 0;
    if (this.staticMeshes.length > 0) {
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        if (!b.enabled || !b.collisionEnabled || b.sleeping || b.static) continue;
        if (b.isTrigger) continue;
        staticContacts += this._collideBodyWithStatics(b);
      }
    }

    // ── 5: broad phase + dynamic narrow phase ─────────────────────────
    const pairs = this.broadphase.update(bodies);
    this._collidePairs(bodies);

    // ── 6: solve ──────────────────────────────────────────────────────
    this.solver.solve(this.contacts, dt);

    // ── 7: integrate velocities ───────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (!b.enabled) continue;
      b.integrateVelocity(dt);
    }

    // ── 8: continuous collision for fast small bodies ─────────────────
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.ccd && b.enabled && !b.sleeping && b.isMovable) this._applyCCD(b);
    }

    // ── 9: bounds refresh + sleeping ──────────────────────────────────
    // 9a. Classify AFTER the solve. Doing this before would see the gravity Δv
    //     (0.163 m/s at 120 Hz) that the contact solver is about to cancel, and
    //     nothing would ever qualify as "at rest".
    const cfg = this.sleepConfig;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b._sleepy = b.enabled ? isSleepy(b, cfg) : true;
    }
    // 9a′. Bleed off the solver's resting residual (see restStabilization).
    if (this.restStabilization) {
      const rl2 = this.restLinear * this.restLinear;
      const ra2 = this.restAngular * this.restAngular;
      for (let i = 0; i < n; i++) {
        const b = bodies[i];
        if (!b.enabled || !b.isMovable || b._wasForced) continue;
        if (b.contactCount < this.restMinContacts) continue;
        const lin2 = b.velocity.lengthSq();
        const ang2 = b.angularVelocity.lengthSq();
        if (lin2 > rl2 || ang2 > ra2) continue;
        b.velocity.multiplyScalar(this.restLinearDamp);
        b.angularVelocity.multiplyScalar(this.restAngularDamp);
        b._sleepy = isSleepy(b, cfg);
      }
    }

    // 9a″. A body may not fall asleep while it is still visibly sunk into
    //      something. Sleeping FREEZES the transform, so whatever penetration
    //      has not been recovered yet becomes permanent — and in a stack the
    //      residual of every level below adds up. Holding the doze off until the
    //      split-impulse pass has finished its job costs a few extra steps and
    //      keeps a 5-box tower ~1 mm from its exact height instead of ~4 mm.
    const maxRestPen = this.solver.positionSlop * 3;
    for (let i = 0; i < this.contacts.count; i++) {
      if (this.contacts.depth[i] <= maxRestPen) continue;
      const A = this.contacts.bodyA[i], B = this.contacts.bodyB[i];
      if (A) A._sleepy = false;
      if (B) B._sleepy = false;
    }

    // 9b. A body may not fall asleep while something lively is leaning on it.
    const pool = this.contacts;
    for (let i = 0; i < pool.count; i++) {
      const A = pool.bodyA[i], B = pool.bodyB[i];
      if (!A || !B) continue;
      if (!A._sleepy) B._keepAwake = true;
      if (!B._sleepy) A._keepAwake = true;
    }
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (!b.enabled) continue;
      b.updateAABB();
      b.updateSleep(dt, cfg);
    }

    // ── 10: events ────────────────────────────────────────────────────
    this._emitCollisionEvents();

    this.stats.bodies = n;
    this.stats.awake = awake;
    this.stats.pairs = pairs;
    this.stats.contacts = this.contacts.count;
    this.stats.staticContacts = staticContacts;
    if (t0) this.stats.ms = performance.now() - t0;
  }

  /** Debug visuals only. */
  update() {
    const d = this.debugDraw;
    if (!d.enabled) return;
    if (!d.begin()) return;
    if (d.showBVH && this.trackMesh) d.drawBVH(this.trackMesh);
    if (d.showAABBs) d.drawBodies(this.bodies);
    if (d.showContacts) d.drawContacts(this.contacts);
    d.end();
  }

  // ═════════════════════════════════════════════════════════ narrow phase

  /** @param {RigidBody} b @returns {number} contacts added */
  _collideBodyWithStatics(b) {
    const col = b.collider;
    if (!col) return 0;
    const start = this.contacts.count;
    const bodyFriction = b.friction;
    const bodyRest = b.restitution;

    for (let mi = 0; mi < this.staticMeshes.length; mi++) {
      const mesh = this.staticMeshes[mi];
      if (mesh.triangleCount === 0) continue;
      if (b.aabbMin.x > mesh.bounds.max.x || b.aabbMax.x < mesh.bounds.min.x) continue;
      if (b.aabbMin.y > mesh.bounds.max.y || b.aabbMax.y < mesh.bounds.min.y) continue;
      if (b.aabbMin.z > mesh.bounds.max.z || b.aabbMax.z < mesh.bounds.min.z) continue;

      const count = mesh.queryAABBRaw(
        b.aabbMin.x, b.aabbMin.y, b.aabbMin.z,
        b.aabbMax.x, b.aabbMax.y, b.aabbMax.z, _triScratch,
      );
      this.stats.triangleTests += count;

      for (let k = 0; k < count; k++) {
        const tri = _triScratch[k];
        _manifold.clear();
        let hit = false;
        if (col.type === ShapeType.SPHERE) {
          hit = sphereVsTriangle(b.cache.cx, b.cache.cy, b.cache.cz, col.radius, mesh, tri, _manifold);
        } else if (col.type === ShapeType.CAPSULE) {
          hit = capsuleVsTriangle(
            b.cache.ax, b.cache.ay, b.cache.az,
            b.cache.bx, b.cache.by, b.cache.bz,
            col.radius, mesh, tri, _manifold,
          );
        } else {
          hit = hullVsTriangle(b.cache, col, mesh, tri, _manifold);
        }
        if (!hit || _manifold.count === 0) continue;

        const sid = _manifold.surfaceId & 0x0f;
        const friction = clampF(bodyFriction * SURFACE_FRICTION[sid], 0, 2.5);
        const rest = clampF(bodyRest * SURFACE_BOUNCE[sid], 0, 0.92);

        const keyHi = contactKey(0, b.id);
        for (let c = 0; c < _manifold.count; c++) {
          // 2 bits mesh · 22 bits triangle · 2 bits manifold point — stable
          // frame to frame, which is what makes warm starting worth anything.
          const keyLo = ((mi & 3) << 24) | ((tri & 0x3fffff) << 2) | (c & 3);
          this._addStaticContact(
            b, start,
            _manifold.points[c * 3], _manifold.points[c * 3 + 1], _manifold.points[c * 3 + 2],
            _manifold.nx, _manifold.ny, _manifold.nz,
            _manifold.depths[c], friction, rest, sid, keyHi, keyLo,
          );
        }
      }
    }
    this._reduceCoplanar(start);
    const added = this.contacts.count - start;
    b.contactCount += added;
    return added;
  }

  /**
   * Collapse redundant coplanar contacts for one body.
   *
   * A 8 cm box straddling four floor quads gets its bottom face clipped into
   * four pieces, which yields a 3×3 grid of nine contacts that all share the
   * same +Y normal. Only four of them carry information; the extra five make
   * the constraint system badly rank-deficient, and Gauss-Seidel then converges
   * to an asymmetric impulse distribution that spins the body. Reducing each
   * same-normal group to four well-spread points is what makes stacks stand.
   */
  _reduceCoplanar(start) {
    const pool = this.contacts;
    const n = pool.count - start;
    if (n <= 4 || n > _grpKeep.length) return;

    for (let i = 0; i < n; i++) { _grpKeep[i] = 1; _grpDone[i] = 0; }

    for (let i = 0; i < n; i++) {
      if (_grpDone[i]) continue;
      const a = start + i;
      const nx = pool.nx[a], ny = pool.ny[a], nz = pool.nz[a];
      let g = 0;
      for (let j = i; j < n; j++) {
        if (_grpDone[j]) continue;
        const b = start + j;
        if (pool.nx[b] * nx + pool.ny[b] * ny + pool.nz[b] * nz < 0.995) continue;
        _grpDone[j] = 1;
        _grpIdx[g++] = j;
      }
      if (g <= 4) continue;

      // Keep the deepest, then greedily the furthest-from-kept.
      let deep = 0;
      for (let k = 1; k < g; k++) if (pool.depth[start + _grpIdx[k]] > pool.depth[start + _grpIdx[deep]]) deep = k;
      _grpSel[0] = _grpIdx[deep];
      let kept = 1;
      while (kept < 4) {
        let best = -1, bestScore = -1;
        for (let k = 0; k < g; k++) {
          const cand = _grpIdx[k];
          let dup = false;
          for (let q = 0; q < kept; q++) if (_grpSel[q] === cand) { dup = true; break; }
          if (dup) continue;
          const ci = start + cand;
          let minD = Infinity;
          for (let q = 0; q < kept; q++) {
            const cj = start + _grpSel[q];
            const dx = pool.px[ci] - pool.px[cj];
            const dy = pool.py[ci] - pool.py[cj];
            const dz = pool.pz[ci] - pool.pz[cj];
            const d = dx * dx + dy * dy + dz * dz;
            if (d < minD) minD = d;
          }
          const score = minD + pool.depth[ci] * 1e-4;
          if (score > bestScore) { bestScore = score; best = cand; }
        }
        if (best < 0) break;
        _grpSel[kept++] = best;
      }
      for (let k = 0; k < g; k++) {
        const cand = _grpIdx[k];
        let sel = false;
        for (let q = 0; q < kept; q++) if (_grpSel[q] === cand) { sel = true; break; }
        if (!sel) _grpKeep[cand] = 0;
      }
    }

    let w = start;
    for (let i = 0; i < n; i++) {
      if (!_grpKeep[i]) continue;
      pool.copyEntry(w, start + i);
      w++;
    }
    pool.count = w;
  }

  /**
   * Add a body-vs-world contact, merging near-duplicates from adjacent
   * triangles and capping the total per body.
   */
  _addStaticContact(body, start, px, py, pz, nx, ny, nz, depth, friction, rest, sid, keyHi, keyLo) {
    const pool = this.contacts;
    for (let j = start; j < pool.count; j++) {
      if (pool.nx[j] * nx + pool.ny[j] * ny + pool.nz[j] * nz < 0.995) continue;
      const dx = pool.px[j] - px, dy = pool.py[j] - py, dz = pool.pz[j] - pz;
      if (dx * dx + dy * dy + dz * dz > MERGE_RADIUS2) continue;
      if (depth > pool.depth[j]) {
        pool.depth[j] = depth;
        pool.px[j] = px; pool.py[j] = py; pool.pz[j] = pz;
        pool.friction[j] = friction;
        pool.restitution[j] = rest;
        pool.surfaceId[j] = sid;
      }
      return;
    }
    if (pool.count - start >= this.maxContactsPerBody) {
      // Replace the shallowest so the deepest penetrations always get solved.
      let worst = start, worstD = Infinity;
      for (let j = start; j < pool.count; j++) if (pool.depth[j] < worstD) { worstD = pool.depth[j]; worst = j; }
      if (depth <= worstD) return;
      pool.depth[worst] = depth;
      pool.px[worst] = px; pool.py[worst] = py; pool.pz[worst] = pz;
      pool.nx[worst] = nx; pool.ny[worst] = ny; pool.nz[worst] = nz;
      pool.friction[worst] = friction;
      pool.restitution[worst] = rest;
      pool.surfaceId[worst] = sid;
      pool.keyHi[worst] = keyHi;
      pool.keyLo[worst] = keyLo;
      return;
    }
    pool.add(null, body, px, py, pz, nx, ny, nz, depth, friction, rest, sid, keyHi, keyLo);
  }

  _collidePairs(bodies) {
    const bp = this.broadphase;
    for (let p = 0; p < bp.pairCount; p++) {
      const ia = bp.pairs[p * 2], ib = bp.pairs[p * 2 + 1];
      let A = bodies[ia], B = bodies[ib];
      if (!A || !B) continue;

      // Only a genuinely MOVING neighbour wakes a sleeper. Waking on mere
      // contact would make a settled stack ping-pong between sleep and wake
      // forever, since the last box to doze off would keep reviving the others.
      if (A.sleeping !== B.sleeping) {
        const sleeper = A.sleeping ? A : B;
        const mover = A.sleeping ? B : A;
        if (!mover._sleepy) {
          sleeper.wake();
          sleeper.updateInertiaWorld();
          sleeper.updateWorldCache(this.step);
        }
      }
      if (A.sleeping && B.sleeping) continue;
      A.updateWorldCache(this.step);
      B.updateWorldCache(this.step);

      _manifold.clear();
      if (!this._collideShapes(A, B, _manifold)) continue;

      if (A.isTrigger || B.isTrigger) {
        this._emitTrigger(A, B, _manifold);
        continue;
      }

      const friction = clampF(Math.sqrt(A.friction * B.friction), 0, 2.5);
      const rest = clampF(Math.max(A.restitution, B.restitution), 0, 0.92);
      const keyHi = contactKey(A.id, B.id);
      for (let c = 0; c < _manifold.count; c++) {
        this.contacts.add(
          A, B,
          _manifold.points[c * 3], _manifold.points[c * 3 + 1], _manifold.points[c * 3 + 2],
          _manifold.nx, _manifold.ny, _manifold.nz,
          _manifold.depths[c], friction, rest, 0,
          keyHi, _manifold.features[c] & 0x3ffffff,
        );
      }
      A.contactCount += _manifold.count;
      B.contactCount += _manifold.count;
      // NOTE: "keep my neighbour awake" is decided in step 9, AFTER the solve.
      // Doing it here would test velocities that still carry this step's
      // gravity Δv (0.163 m/s at 120 Hz), so nothing would ever sleep.
    }
  }

  /** Dispatch on collider types. Normal ends up pointing from A to B. */
  _collideShapes(A, B, m) {
    const ca = A.collider, cb = B.collider;
    if (!ca || !cb) return false;
    const ta = ca.type, tb = cb.type;

    if (ta === ShapeType.SPHERE && tb === ShapeType.SPHERE) {
      return sphereVsSphere(
        A.cache.cx, A.cache.cy, A.cache.cz, ca.radius,
        B.cache.cx, B.cache.cy, B.cache.cz, cb.radius, m,
      );
    }
    if (ta === ShapeType.SPHERE) {
      if (tb === ShapeType.CAPSULE) return this._sphereVsCapsule(A, ca, B, cb, m, false);
      return sphereVsHull(A.cache.cx, A.cache.cy, A.cache.cz, ca.radius, B.cache, cb, m);
    }
    if (tb === ShapeType.SPHERE) {
      if (ta === ShapeType.CAPSULE) return this._sphereVsCapsule(B, cb, A, ca, m, true);
      const ok = sphereVsHull(B.cache.cx, B.cache.cy, B.cache.cz, cb.radius, A.cache, ca, m);
      if (ok) m.flip();
      return ok;
    }
    if (ta === ShapeType.CAPSULE || tb === ShapeType.CAPSULE) {
      // Capsules against non-spheres are approximated by their end spheres.
      return this._capsuleApprox(A, ca, B, cb, m);
    }
    return hullVsHull(A.cache, ca, B.cache, cb, m);
  }

  /** Sphere (S) vs capsule (C). `flip` when S is body B. */
  _sphereVsCapsule(S, cs, C, cc, m, flip) {
    const t = closestParam(
      C.cache.ax, C.cache.ay, C.cache.az,
      C.cache.bx, C.cache.by, C.cache.bz,
      S.cache.cx, S.cache.cy, S.cache.cz,
    );
    const qx = C.cache.ax + (C.cache.bx - C.cache.ax) * t;
    const qy = C.cache.ay + (C.cache.by - C.cache.ay) * t;
    const qz = C.cache.az + (C.cache.bz - C.cache.az) * t;
    const ok = sphereVsSphere(S.cache.cx, S.cache.cy, S.cache.cz, cs.radius, qx, qy, qz, cc.radius, m);
    if (ok && flip) m.flip();
    return ok;
  }

  /** Capsule vs hull/capsule via two end spheres — good enough for props. */
  _capsuleApprox(A, ca, B, cb, m) {
    const capsuleIsA = ca.type === ShapeType.CAPSULE;
    const cap = capsuleIsA ? A : B;
    const capCol = capsuleIsA ? ca : cb;
    const other = capsuleIsA ? B : A;
    const otherCol = capsuleIsA ? cb : ca;
    if (otherCol.type === ShapeType.CAPSULE) {
      // capsule vs capsule: closest points between the two segments
      const t = closestParam(cap.cache.ax, cap.cache.ay, cap.cache.az,
        cap.cache.bx, cap.cache.by, cap.cache.bz,
        (other.cache.ax + other.cache.bx) * 0.5,
        (other.cache.ay + other.cache.by) * 0.5,
        (other.cache.az + other.cache.bz) * 0.5);
      const px = cap.cache.ax + (cap.cache.bx - cap.cache.ax) * t;
      const py = cap.cache.ay + (cap.cache.by - cap.cache.ay) * t;
      const pz = cap.cache.az + (cap.cache.bz - cap.cache.az) * t;
      const u = closestParam(other.cache.ax, other.cache.ay, other.cache.az,
        other.cache.bx, other.cache.by, other.cache.bz, px, py, pz);
      const qx = other.cache.ax + (other.cache.bx - other.cache.ax) * u;
      const qy = other.cache.ay + (other.cache.by - other.cache.ay) * u;
      const qz = other.cache.az + (other.cache.bz - other.cache.az) * u;
      const ok = sphereVsSphere(px, py, pz, capCol.radius, qx, qy, qz, otherCol.radius, m);
      if (ok && !capsuleIsA) m.flip();
      return ok;
    }
    let any = false;
    for (let s = 0; s < 2; s++) {
      const px = s ? cap.cache.bx : cap.cache.ax;
      const py = s ? cap.cache.by : cap.cache.ay;
      const pz = s ? cap.cache.bz : cap.cache.az;
      const sub = _subManifold;
      sub.clear();
      if (sphereVsHull(px, py, pz, capCol.radius, other.cache, otherCol, sub) && sub.count > 0) {
        if (!any) m.setNormal(sub.nx, sub.ny, sub.nz);
        m.add(sub.points[0], sub.points[1], sub.points[2], sub.depths[0], s);
        any = true;
      }
    }
    if (any && !capsuleIsA) m.flip();
    return any;
  }

  // ═════════════════════════════════════════════════════════ CCD

  /** Sphere-cast the frame's motion against the statics and clamp. */
  _applyCCD(b) {
    _v1.copy(b.position).sub(b.prevPosition);
    const dist = _v1.length();
    const r = Math.max(0.004, b.boundingRadius * 0.6);
    if (dist < r * 0.75) return;
    _v1.multiplyScalar(1 / dist);
    if (!this._sphereCastStatic(b.prevPosition, _v1, r, dist, _hitScratch2)) return;
    const back = Math.max(0, _hitScratch2.distance - 1e-3);
    b.position.copy(b.prevPosition).addScaledVector(_v1, back);
    // Kill the into-surface component so the next step resolves normally.
    const vn = b.velocity.dot(_hitScratch2.normal);
    if (vn < 0) b.velocity.addScaledVector(_hitScratch2.normal, -vn * (1 + b.restitution));
    b._cacheStamp = -1;
  }

  // ═════════════════════════════════════════════════════════ events

  _nextEvent() {
    const e = this._evtRing[this._evtIdx];
    this._evtIdx = (this._evtIdx + 1) % EVENT_RING;
    return e;
  }

  _emitCollisionEvents() {
    const bus = this.game?.bus;
    const pool = this.contacts;
    const thr = this.impulseEventThreshold;
    for (let i = 0; i < pool.count; i++) {
      const jn = pool.jn[i];
      const A = pool.bodyA[i], B = pool.bodyB[i];
      if (A && jn > A.lastImpulse) A.lastImpulse = jn;
      if (B && jn > B.lastImpulse) B.lastImpulse = jn;
      if (jn < thr || !bus) continue;

      // One event per body pair per step — keep the loudest contact.
      const pairKey = (((A ? A.id : 0) & 0xffff) << 16) | ((B ? B.id : 0) & 0xffff);
      let dup = false;
      for (let k = 0; k < this._emittedCount; k++) if (this._emittedKeys[k] === pairKey) { dup = true; break; }
      if (dup) continue;
      if (this._emittedCount < this._emittedKeys.length) this._emittedKeys[this._emittedCount++] = pairKey;

      const relSpeed = Math.abs(pool.approach[i]);
      if (A) this._fire(bus, A, B, i, jn, relSpeed);
      if (B) this._fire(bus, B, A, i, jn, relSpeed);
    }
  }

  _fire(bus, body, other, i, jn, relSpeed) {
    const pool = this.contacts;
    const isCar = (body.layer & Layer.CAR) !== 0;
    const isProp = (body.layer & Layer.PROP) !== 0 || (body.layer & Layer.DEBRIS) !== 0;
    if (!isCar && !isProp) return;

    const e = this._nextEvent();
    e.body = body;
    e.other = other ? (other.userData ?? other) : null;
    e.impulse = jn;
    e.relSpeed = relSpeed;
    e.surfaceId = pool.surfaceId[i];
    e.worldPoint.set(pool.px[i], pool.py[i], pool.pz[i]);
    // Report the normal pointing away from the surface that hit `body`.
    const s = pool.bodyB[i] === body ? 1 : -1;
    e.normal.set(pool.nx[i] * s, pool.ny[i] * s, pool.nz[i] * s);

    if (isCar) {
      e.carId = body.userData?.id ?? body.id;
      bus.emit('car:collision', e);
    } else {
      e.propId = body.userData?.id ?? body.id;
      bus.emit('prop:hit', e);
    }
  }

  _emitTrigger(A, B, m) {
    const bus = this.game?.bus;
    if (!bus) return;
    const e = this._nextEvent();
    e.body = A.isTrigger ? B : A;
    e.other = (A.isTrigger ? A : B).userData ?? null;
    e.impulse = 0;
    e.relSpeed = 0;
    e.surfaceId = 0;
    e.worldPoint.set(m.points[0], m.points[1], m.points[2]);
    e.normal.set(m.nx, m.ny, m.nz);
    bus.emit('physics:trigger', e);
  }

  // ═════════════════════════════════════════════════════════ queries

  /**
   * Raycast against the TRACK / static meshes only. This is the suspension hot
   * path — allocation free, and the fastest query in the engine.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir must be normalized
   * @param {number} maxDist
   * @param {import('./CollisionMesh.js').RayHit} out reuse this!
   * @returns {boolean}
   */
  raycastTrack(origin, dir, maxDist, out) {
    out.hit = false;
    out.distance = Infinity;
    out.triIndex = -1;
    out.body = null;
    let best = maxDist;
    let found = false;
    for (let i = 0; i < this.staticMeshes.length; i++) {
      const mesh = this.staticMeshes[i];
      if (mesh.triangleCount === 0) continue;
      if (mesh.raycastRaw(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, best, _hitScratch)) {
        if (_hitScratch.distance < best) {
          best = _hitScratch.distance;
          copyHit(_hitScratch, out);
          found = true;
        }
      }
    }
    return found;
  }

  /**
   * Raycast against the static meshes AND the dynamic bodies.
   * @param {number} [mask] layer mask — bodies not in the mask are ignored
   */
  raycast(origin, dir, maxDist, out, mask = Layer.ALL) {
    const found = this.raycastTrack(origin, dir, maxDist, out);
    let best = found ? out.distance : maxDist;

    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.enabled || !b.collisionEnabled || b.isTrigger) continue;
      if ((b.layer & mask) === 0) continue;
      const col = b.collider;
      if (!col) continue;

      // Cheap AABB reject first.
      if (!raySlab(origin, dir, best, b.aabbMin, b.aabbMax)) continue;
      b.updateWorldCache(this.step);

      let t = -1;
      let nx = 0, ny = 1, nz = 0;
      if (col.type === ShapeType.SPHERE) {
        t = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
          b.cache.cx, b.cache.cy, b.cache.cz, col.radius, best);
        if (t >= 0) {
          nx = origin.x + dir.x * t - b.cache.cx;
          ny = origin.y + dir.y * t - b.cache.cy;
          nz = origin.z + dir.z * t - b.cache.cz;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
        }
      } else if (col.type === ShapeType.CAPSULE) {
        // Approximate with the bounding sphere — fine for hit scans.
        t = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
          b.position.x, b.position.y, b.position.z, col.boundingRadius, best);
        if (t >= 0) {
          nx = origin.x + dir.x * t - b.position.x;
          ny = origin.y + dir.y * t - b.position.y;
          nz = origin.z + dir.z * t - b.position.z;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l; ny /= l; nz /= l;
        }
      } else {
        t = rayHull(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, best,
          b.cache, col, _normalOut);
        if (t >= 0) { nx = _normalOut[0]; ny = _normalOut[1]; nz = _normalOut[2]; }
      }

      if (t >= 0 && t < best) {
        best = t;
        out.hit = true;
        out.distance = t;
        out.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
        out.normal.set(nx, ny, nz);
        out.surfaceId = 0;
        out.triIndex = -1;
        out.body = b;
      }
    }
    return out.hit;
  }

  /**
   * Sweep a sphere through the world. Static meshes are exact; dynamic bodies
   * are approximated by their bounding spheres.
   */
  sphereCast(origin, dir, radius, maxDist, out, mask = Layer.ALL) {
    const found = this._sphereCastStatic(origin, dir, radius, maxDist, out);
    let best = found ? out.distance : maxDist;

    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.enabled || !b.collisionEnabled || b.isTrigger) continue;
      if ((b.layer & mask) === 0) continue;
      const t = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        b.position.x, b.position.y, b.position.z, b.boundingRadius + radius, best);
      if (t < 0 || t >= best) continue;
      best = t;
      out.hit = true;
      out.distance = t;
      const cx = origin.x + dir.x * t, cy = origin.y + dir.y * t, cz = origin.z + dir.z * t;
      let nx = cx - b.position.x, ny = cy - b.position.y, nz = cz - b.position.z;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      out.normal.set(nx, ny, nz);
      out.point.set(cx - nx * radius, cy - ny * radius, cz - nz * radius);
      out.surfaceId = 0;
      out.triIndex = -1;
      out.body = b;
    }
    return out.hit;
  }

  _sphereCastStatic(origin, dir, radius, maxDist, out) {
    out.hit = false;
    out.distance = Infinity;
    out.body = null;
    out.triIndex = -1;
    let best = maxDist;

    // Swept AABB of the sphere.
    const ex = dir.x * maxDist, ey = dir.y * maxDist, ez = dir.z * maxDist;
    const minx = Math.min(origin.x, origin.x + ex) - radius;
    const miny = Math.min(origin.y, origin.y + ey) - radius;
    const minz = Math.min(origin.z, origin.z + ez) - radius;
    const maxx = Math.max(origin.x, origin.x + ex) + radius;
    const maxy = Math.max(origin.y, origin.y + ey) + radius;
    const maxz = Math.max(origin.z, origin.z + ez) + radius;

    for (let mi = 0; mi < this.staticMeshes.length; mi++) {
      const mesh = this.staticMeshes[mi];
      if (mesh.triangleCount === 0) continue;
      const count = mesh.queryAABBRaw(minx, miny, minz, maxx, maxy, maxz, _triScratch);
      for (let k = 0; k < count; k++) {
        const tri = _triScratch[k];
        if (!sweepSphereTriangle(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
          radius, best, mesh.tris, tri * 9, mesh.planes, tri * 4)) continue;
        if (SWEEP.t >= best) continue;
        best = SWEEP.t;
        out.hit = true;
        out.distance = SWEEP.t;
        out.point.set(SWEEP.px, SWEEP.py, SWEEP.pz);
        out.normal.set(SWEEP.nx, SWEEP.ny, SWEEP.nz);
        out.surfaceId = mesh.surfaceIds[tri];
        out.triIndex = tri;
      }
    }
    return out.hit;
  }

  /**
   * Bodies whose shape (approximated by its bounding sphere) overlaps a sphere.
   * @param {THREE.Vector3} center @param {number} radius
   * @param {RigidBody[]} outBodies cleared then filled
   * @returns {number} count
   */
  overlapSphere(center, radius, outBodies, mask = Layer.ALL) {
    outBodies.length = 0;
    const r2 = radius * radius;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.enabled || (b.layer & mask) === 0) continue;
      // AABB reject
      if (b.aabbMin.x > center.x + radius || b.aabbMax.x < center.x - radius) continue;
      if (b.aabbMin.y > center.y + radius || b.aabbMax.y < center.y - radius) continue;
      if (b.aabbMin.z > center.z + radius || b.aabbMax.z < center.z - radius) continue;
      const dx = b.position.x - center.x, dy = b.position.y - center.y, dz = b.position.z - center.z;
      const rr = radius + b.boundingRadius;
      if (dx * dx + dy * dy + dz * dz > rr * rr) continue;
      void r2;
      outBodies.push(b);
    }
    return outBodies.length;
  }

  /** Closest point on the static geometry within `maxRadius`. */
  closestPointOnTrack(point, maxRadius, out) {
    out.hit = false;
    let best = Infinity;
    for (let i = 0; i < this.staticMeshes.length; i++) {
      if (this.staticMeshes[i].closestPoint(point, maxRadius, _hitScratch, _triScratch)) {
        if (_hitScratch.distance < best) { best = _hitScratch.distance; copyHit(_hitScratch, out); }
      }
    }
    return out.hit;
  }

  /** Surface id directly beneath a world point (fast helper for FX/audio). */
  surfaceBelow(point, maxDist = 1.0) {
    _v1.set(0, -1, 0);
    if (this.raycastTrack(point, _v1, maxDist, _hitScratch2)) return _hitScratch2.surfaceId;
    return 0;
  }

  /** Friction multiplier for a surface id, honouring the track's SurfaceTable. */
  surfaceFriction(surfaceId) {
    const t = this.surfaces;
    if (t) {
      const s = Array.isArray(t) ? t[surfaceId] : t[surfaceId] ?? t.get?.(surfaceId);
      if (s && typeof s.grip === 'number') return s.grip;
    }
    return SURFACE_FRICTION[surfaceId & 0x0f];
  }

  // ═════════════════════════════════════════════════════════ misc

  getStats() { return this.stats; }

  dispose() {
    this.clear();
    this.debugDraw.dispose();
  }
}

// ═════════════════════════════════════════════════════════ helpers

function clampF(v, a, b) { return v < a ? a : v > b ? b : v; }

function isSleepy(b, cfg) {
  if (!b.isMovable) return true;
  return b.velocity.lengthSq() <= cfg.sleepLinear * cfg.sleepLinear
    && b.angularVelocity.lengthSq() <= cfg.sleepAngular * cfg.sleepAngular;
}

function copyHit(src, dst) {
  dst.hit = src.hit;
  dst.distance = src.distance;
  dst.surfaceId = src.surfaceId;
  dst.triIndex = src.triIndex;
  dst.body = src.body;
  dst.point.copy(src.point);
  dst.normal.copy(src.normal);
}

function closestParam(ax, ay, az, bx, by, bz, px, py, pz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 < 1e-12) return 0;
  const t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function raySlab(origin, dir, maxT, min, max) {
  let tmin = 0, tmax = maxT;
  for (let a = 0; a < 3; a++) {
    const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
    const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
    const lo = a === 0 ? min.x : a === 1 ? min.y : min.z;
    const hi = a === 0 ? max.x : a === 1 ? max.y : max.z;
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return false; continue; }
    const inv = 1 / d;
    let t1 = (lo - o) * inv, t2 = (hi - o) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}

const _subManifold = new Manifold(4);

// Re-export the pieces other systems need so they only import PhysicsWorld.
export {
  RigidBody, Layer, BodyType, createBoxBody, createSphereBody, createCapsuleBody,
  CollisionMesh, CollisionMeshBuilder, createRayHit,
  ShapeType, makeBox, makeBoxSize, makeSphere, makeCapsule, makeCylinder,
  makeHull, makeHullFromGeometry,
};

export default PhysicsWorld;
