/**
 * RC RUMBLE — TrackSystem.
 *
 * Registry + loader for track modules. Registered on the Game as
 * `game.trackSystem` (see `src/main.js`).
 *
 * A track module is a plain object:
 * ```js
 * export default {
 *   id: 'toy_museum',
 *   name: 'Toy Museum',
 *   difficulty: 'easy',
 *   laps: 3,
 *   theme: 'indoor',
 *   previewColors: [0x8a6a3a, 0xf0e2c4, 0x8e1f22],
 *   description: '…',
 *   build(builder) { … }        // synchronous; talks only to the TrackBuilder
 * };
 * ```
 *
 * `load(id)` runs the module through a fresh {@link TrackBuilder} and returns a
 * fully populated `TrackData` (exactly the ARCHITECTURE.md shape).
 * `unload()` disposes every geometry the track owns and pulls its prop bodies
 * out of the physics world; catalogue materials are shared game-wide and are
 * deliberately *not* disposed.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { TrackBuilder } from './TrackBuilder.js';
import { updateWindMaterials } from './GeoLib.js';
import { SURFACES, SurfaceId, createSurfaceTable, getSurface } from './Surfaces.js';
import { CenterlineSpline, SplineSample, ClosestResult } from './Spline.js';
import toyMuseum from './tracks/toy_museum.js';
import garden from './tracks/garden.js';
import supermarket from './tracks/supermarket.js';

/** Every track module known to the game, in menu order. */
const BUILTIN = [toyMuseum, garden, supermarket];

const _sample = new SplineSample();
const _closest = new ClosestResult();
const _v = new THREE.Vector3();

export class TrackSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** @type {Map<string, object>} */
    this.registry = new Map();
    /** @type {object|null} the loaded TrackData */
    this.current = null;
    /** @type {TrackBuilder|null} */
    this.builder = null;
    this.buildMs = 0;
    this._elapsed = 0;
    this._windMats = [];
    this._runtime = null;

    for (const mod of BUILTIN) this.registerTrack(mod);
  }

  async init() {
    // Nothing to load — every asset is procedural and built on demand.
  }

  // ═════════════════════════════════════════════════════════════════ registry

  /**
   * Add (or replace) a track module.
   * @param {{id:string, name?:string, build:(b:TrackBuilder)=>void}} mod
   */
  registerTrack(mod) {
    if (!mod?.id || typeof mod.build !== 'function') {
      console.warn('[TrackSystem] ignoring invalid track module', mod);
      return this;
    }
    this.registry.set(mod.id, mod);
    return this;
  }

  hasTrack(id) { return this.registry.has(id); }

  /**
   * Menu data for every track. Cheap — no geometry is built.
   * @returns {Array<{id, name, difficulty, laps, length, theme, previewColors, description}>}
   */
  listTracks() {
    const out = [];
    for (const mod of this.registry.values()) {
      out.push({
        id: mod.id,
        name: mod.name ?? mod.id,
        difficulty: mod.difficulty ?? 'easy',
        laps: mod.laps ?? CONFIG.startup.laps ?? 3,
        length: mod.length ?? mod.lengthMeters ?? 0,
        theme: mod.theme ?? 'indoor',
        previewColors: mod.previewColors ?? [0x777777, 0x999999, 0xbbbbbb],
        description: mod.description ?? '',
        order: mod.order ?? 0,
      });
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }

  /** The default track id when nothing was asked for. */
  get defaultTrackId() {
    return this.registry.keys().next().value ?? 'toy_museum';
  }

  // ═════════════════════════════════════════════════════════════════ loading

  /**
   * Build a track. Never throws — on failure it returns a minimal but valid,
   * drivable TrackData so the game still boots.
   * @param {string} id
   * @returns {Promise<object>} TrackData
   */
  async load(id) {
    const wanted = this.registry.has(id) ? id : this.defaultTrackId;
    if (wanted !== id) console.warn(`[TrackSystem] unknown track "${id}", falling back to "${wanted}"`);
    const mod = this.registry.get(wanted);

    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    let track = null;
    try {
      const builder = new TrackBuilder(this.game, {
        id: mod.id,
        name: mod.name,
        theme: mod.theme,
        difficulty: mod.difficulty,
        laps: mod.laps ?? CONFIG.startup.laps ?? 3,
        seed: mod.seed ?? CONFIG.seed,
        previewColors: mod.previewColors,
        description: mod.description,
      });
      this.builder = builder;
      mod.build(builder);
      track = builder.build();
    } catch (err) {
      console.error(`[TrackSystem] building "${wanted}" failed:`, err);
      track = this._emergencyTrack(wanted, err);
    }
    this.buildMs = ((typeof performance !== 'undefined') ? performance.now() : 0) - t0;

    // Cache the measured lap length back onto the module so the menu can show it
    // without building anything.
    if (mod && track?.lengthMeters) mod.length = Math.round(track.lengthMeters);

    this.current = track;
    this._windMats = track._windMaterials ?? [];
    this._runtime = track._runtime ?? null;
    this._elapsed = 0;

    if (CONFIG.debug) {
      console.log(
        `[TrackSystem] "${track.id}" built in ${this.buildMs.toFixed(1)} ms · `
        + `${track.lengthMeters?.toFixed(1)} m · flat-out ≈ ${track.estimatedLapSeconds?.toFixed(1)} s`,
        track.stats,
      );
    }
    return track;
  }

  /**
   * Called by Game after the cars exist. This is where prop bodies join the
   * physics world (the world is guaranteed to be set up by now).
   */
  onRaceStart(ctx) {
    const track = ctx?.track ?? this.current;
    const rt = track?._runtime;
    if (!rt) return;
    rt.game = this.game;
    rt.attach();
    rt.reset();
  }

  onRaceEnd() {
    this.current?._runtime?.detach?.();
  }

  /** Put every knockable prop back where the author placed it. */
  resetProps() {
    this.current?._runtime?.reset?.();
  }

  /**
   * Tear a track down. Geometries and track-owned materials are disposed;
   * catalogue materials belong to the shared `MaterialLibrary` and are not.
   * @param {object} [track] defaults to the current one
   */
  unload(track = this.current) {
    if (!track) return;
    try {
      track._runtime?.dispose?.();

      if (track.scene) {
        track.scene.parent?.remove(track.scene);
        track.scene.traverse((obj) => {
          if (obj.isInstancedMesh) obj.dispose?.();
        });
      }
      for (const g of track._ownedGeometries ?? []) g?.dispose?.();
      for (const m of track._ownedMaterials ?? []) m?.dispose?.();
      track.collision?.dispose?.();
      track._ownedGeometries = [];
      track._ownedMaterials = [];
    } catch (err) {
      console.warn('[TrackSystem] unload had trouble:', err);
    }
    if (track === this.current) {
      this.current = null;
      this.builder = null;
      this._windMats = [];
      this._runtime = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════ update

  /** Prop culling (throttled inside PropRuntime). */
  fixedUpdate(dt) {
    this._runtime?.fixedUpdate(dt);
  }

  /** Animated props, wind sway, prop visual sync. */
  update(dt, alpha = 1) {
    if (!this.current) return;
    this._elapsed += dt;
    if (this._windMats.length) updateWindMaterials(this._windMats, dt);
    this._runtime?.update(dt, alpha);
  }

  // ══════════════════════════════════════════════════════════════ queries

  /**
   * Progress of a world position around the lap, as a fraction [0,1).
   * Allocation-free; pass the caller's last value as `hintT` for a cheap
   * windowed search.
   * @param {THREE.Vector3} position
   * @param {number} [hintT]
   * @returns {number}
   */
  progressAt(position, hintT = undefined) {
    const spline = this.current?.spline;
    if (!spline) return 0;
    spline.closestPoint(position, _closest, hintT != null ? { hintT, window: 24 } : null);
    return _closest.t;
  }

  /**
   * Full road information at a world position: lap fraction, lateral offset,
   * road width, whether the point is on the road at all.
   * @param {THREE.Vector3} position
   * @param {ClosestResult} [out]
   */
  roadInfo(position, out = _closest, hintT = undefined) {
    const spline = this.current?.spline;
    if (!spline) return null;
    spline.closestPoint(position, out, hintT != null ? { hintT, window: 24 } : null);
    return out;
  }

  /** Sample the centreline. Returns a shared scratch — copy what you keep. */
  sample(t, out = _sample) {
    const spline = this.current?.spline;
    if (!spline) return out;
    return spline.sample(t, out);
  }

  /** Surface descriptor for an id (grip, particle, sfx, tyre-mark opacity…). */
  surface(id) {
    const table = this.current?.surfaces;
    return (table && table[id & 0x0f]) || getSurface(id);
  }

  /** Surface id under a world point (delegates to physics). */
  surfaceAt(position, maxDist = 1.0) {
    return this.game?.physics?.surfaceBelow?.(position, maxDist) ?? 0;
  }

  /**
   * Extra grip multiplier from dynamic zones (sprinklers, spills). 1 = normal.
   * The baked collision surface id remains authoritative; this is on top.
   */
  gripMultiplierAt(position) {
    return this.current?.gripAt ? this.current.gripAt(position) : 1;
  }

  /** The respawn nearest to (but behind) a checkpoint index. */
  respawnFor(checkpointIndex) {
    const list = this.current?.respawns;
    if (!list || list.length === 0) return null;
    let best = list[0];
    for (const r of list) {
      if (r.checkpointIndex === checkpointIndex) return r;
      if (r.checkpointIndex <= checkpointIndex) best = r;
    }
    return best;
  }

  /** The respawn nearest a world position (used by the "reset" key). */
  nearestRespawn(position) {
    const list = this.current?.respawns;
    if (!list || list.length === 0) return null;
    let best = list[0], bestD = Infinity;
    for (const r of list) {
      const d = r.position.distanceToSquared(position);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  /** Debug helper: a line showing the centreline and the AI racing line. */
  buildDebugPath(color = 0x33ff88, offsetLine = true) {
    const track = this.current;
    if (!track?.spline) return null;
    const group = new THREE.Group();
    group.name = 'debug:aiPath';
    const pts = track.spline.toPoints(256, 0, 0.05);
    pts.push(pts[0].clone());
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false })));
    if (offsetLine && track.aiPath?.nodes?.length) {
      const rl = [];
      for (const n of track.aiPath.nodes) {
        _v.copy(n.position).addScaledVector(n.right, n.offset).addScaledVector(n.normal, 0.07);
        rl.push(_v.clone());
      }
      rl.push(rl[0].clone());
      const g2 = new THREE.BufferGeometry().setFromPoints(rl);
      group.add(new THREE.Line(g2, new THREE.LineBasicMaterial({ color: 0xffaa33, depthTest: false })));
    }
    group.renderOrder = 999;
    return group;
  }

  dispose() {
    this.unload();
    this.registry.clear();
  }

  // ═══════════════════════════════════════════════════════════════ fallback

  /**
   * If a track module throws we still have to hand the Game something drivable.
   * A 120 m oval on a concrete slab with a grid and checkpoints keeps every
   * other system alive so the failure is visible but not fatal.
   */
  _emergencyTrack(id, err) {
    console.warn('[TrackSystem] using the emergency oval for', id);
    const b = new TrackBuilder(this.game, {
      id, name: `${id} (failed)`, theme: 'indoor', difficulty: 'easy', laps: 3,
      description: String(err?.message ?? err ?? 'build failed'),
    });
    const nodes = [];
    const R = 18, r = 11;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      nodes.push({ p: [Math.sin(a) * R, 0, -Math.cos(a) * r], w: 3.4 });
    }
    b.centerline(nodes, { closed: true });
    b.defaultSurface(SurfaceId.CONCRETE);
    b.road({
      material: 'concrete/poured', surfaceId: SurfaceId.CONCRETE,
      wall: { height: 0.4, thickness: 0.2, material: 'concrete/rough', surfaceId: SurfaceId.CONCRETE },
    });
    b.floor({ center: [0, 0], size: [R * 3, r * 3], y: -0.02, material: 'concrete/screed', surfaceId: SurfaceId.CONCRETE });
    b.environment({
      skybox: 'studio', grade: 'neutral', exposure: 1.0,
      ambient: { sky: 0xdfe6ee, ground: 0x50504a, intensity: 0.9 },
      sun: { color: 0xffffff, intensity: 2.0, elevation: 0.9, azimuth: 0.6, castShadow: true },
    });
    b.finishLine(0);
    b.checkpoints({ count: 10 });
    b.startGrid();
    b.respawns();
    b.pickupPads({ rows: 2 });
    b.aiPath();
    return b.build();
  }
}

export { SURFACES, SurfaceId, createSurfaceTable, CenterlineSpline, TrackBuilder };
export default TrackSystem;
