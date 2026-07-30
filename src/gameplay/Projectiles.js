/**
 * Projectiles — the pooled simulation host for everything a weapon spawns.
 *
 * A weapon never owns its own update loop or scene node lifetime. It hands the
 * manager an *entity* (a plain object it created once) and the manager takes
 * care of pooling, scene attachment, rigid-body registration, lifetimes,
 * despawning, car-contact routing and the shared explosion/splash/bolt pools.
 *
 * The weapon side of the contract (all optional except `update`):
 *
 * ```js
 * weapon.entityKind          // string pool key (defaults to weapon.id)
 * weapon.createEntity(mgr)   // → entity, built ONCE per pool slot
 * weapon.resetEntity(e, ctx, mgr)
 * weapon.update(dt, e, game) // → false to despawn. Runs in fixedUpdate.
 * weapon.sync(e, alpha, mgr) // visual placement; defaults to body/pos copy
 * weapon.onCarHit(e, car, payload, mgr)
 * weapon.onPropHit(e, payload, mgr)
 * weapon.onDespawn(e, mgr)
 * ```
 *
 * Entity fields the manager owns: `kind weapon alive age life ownerId owner
 * targetId target pos prevPos vel mesh aux body data`.
 */

import * as THREE from 'three';
import { Layer } from '../physics/index.js';
import { Burst, Splash, RingWave, Bolt } from './VisualKit.js';

const _v = new THREE.Vector3();

/** Caps so a chaotic 8-car pile-up cannot balloon the draw call count. */
const FX_CAP = { burst: 10, splash: 8, ring: 12, bolt: 8 };

export class Projectiles {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {object} [pickups] the owning PickupSystem (for effects + standings)
   */
  constructor(game, pickups = null) {
    this.game = game;
    this.pickups = pickups;
    this.bus = game?.bus ?? null;

    /** Scene root, kept at identity so world-space ribbons work. */
    this.root = new THREE.Group();
    this.root.name = 'gameplay:projectiles';
    this.root.matrixAutoUpdate = false;
    this._rootAdded = false;

    /** @type {object[]} live entities */
    this.active = [];
    /** @type {Map<string, object[]>} idle entities by kind */
    this._pools = new Map();
    /** @type {Map<number, object>} carId → Car, refreshed on race start */
    this._carById = new Map();

    this._bursts = [];
    this._splashes = [];
    this._rings = [];
    this._bolts = [];

    this._nextId = 1;
    this._unsub = [];
    this._newMeshes = false;

    /** Total entities ever spawned this race (debug). */
    this.spawnCount = 0;
  }

  // ═══════════════════════════════════════════════════════════════ lifecycle

  onRaceStart(ctx) {
    const scene = this.game?.scene;
    if (scene && !this._rootAdded) { scene.add(this.root); this._rootAdded = true; }
    this._carById.clear();
    const cars = ctx?.cars ?? this.game?.cars ?? [];
    for (let i = 0; i < cars.length; i++) this._carById.set(cars[i].id, cars[i]);
    this.clear();
    this._bind();
  }

  onRaceEnd() {
    this.clear();
    this._unbind();
    this._carById.clear();
  }

  _bind() {
    this._unbind();
    if (!this.bus) return;
    this._unsub.push(this.bus.on('car:collision', (p) => this._onCarCollision(p)));
    this._unsub.push(this.bus.on('prop:hit', (p) => this._onPropHit(p)));
  }

  _unbind() {
    for (let i = 0; i < this._unsub.length; i++) this._unsub[i]();
    this._unsub.length = 0;
  }

  // ═══════════════════════════════════════════════════════════════ spawning

  /**
   * @param {object} weapon a weapon module
   * @param {object} ctx passed to `weapon.resetEntity`
   * @returns {object|null} the live entity
   */
  spawn(weapon, ctx = null) {
    if (!weapon) return null;
    const kind = weapon.entityKind ?? weapon.id ?? 'generic';
    let pool = this._pools.get(kind);
    if (!pool) { pool = []; this._pools.set(kind, pool); }

    let e = pool.pop() ?? null;
    if (!e) {
      try {
        e = weapon.createEntity ? weapon.createEntity(this) : null;
      } catch (err) {
        console.warn(`[Projectiles] createEntity failed for "${kind}":`, err);
        return null;
      }
      if (!e) return null;
      e.kind = kind;
      e.pos ??= new THREE.Vector3();
      e.prevPos ??= new THREE.Vector3();
      e.vel ??= new THREE.Vector3();
      e.data ??= {};
      e.aux ??= null;
      e.mesh ??= null;
      e.body ??= null;
      if (e.mesh) { e.mesh.visible = false; this.root.add(e.mesh); this._newMeshes = true; }
      if (e.aux) {
        for (let i = 0; i < e.aux.length; i++) { this.root.add(e.aux[i]); }
        this._newMeshes = true;
      }
    }

    e.id = this._nextId++;
    e.weapon = weapon;
    e.alive = true;
    e.age = 0;
    e.life = weapon.lifetime ?? 6;
    e.owner = ctx?.car ?? null;
    e.ownerId = e.owner?.id ?? -1;
    e.target = ctx?.target ?? null;
    e.targetId = e.target?.id ?? -1;
    e.vel.set(0, 0, 0);
    if (e.mesh) e.mesh.visible = true;

    try { weapon.resetEntity?.(e, ctx, this); }
    catch (err) { console.warn(`[Projectiles] resetEntity failed for "${kind}":`, err); }

    e.prevPos.copy(e.pos);

    if (e.body) {
      e.body.userData ??= {};
      e.body.userData.id = 100000 + e.id;   // never collides with a car id
      e.body.userData.projectile = true;
      e.body.userData.entity = e;
      e.body.userData.kind = kind;
      e.body.userData.ownerId = e.ownerId;
      this.game?.physics?.addBody?.(e.body);
      e.body.wake?.();
    }

    this.active.push(e);
    this.spawnCount++;
    // A batch of freshly created lit meshes needs the lighting rig to notice.
    if (this._newMeshes) {
      this._newMeshes = false;
      this.game?.renderer?.lighting?.scanMaterials?.(true);
    }
    return e;
  }

  /** Retire an entity back to its pool. Safe to call twice. */
  despawn(e) {
    if (!e || !e.alive) return;
    e.alive = false;
    try { e.weapon?.onDespawn?.(e, this); }
    catch (err) { console.warn('[Projectiles] onDespawn threw:', err); }
    if (e.body) {
      this.game?.physics?.removeBody?.(e.body);
      if (e.body.userData) e.body.userData.entity = null;
    }
    if (e.mesh) e.mesh.visible = false;
    const i = this.active.indexOf(e);
    if (i >= 0) {
      const last = this.active.pop();
      if (i < this.active.length) this.active[i] = last;
    }
    const pool = this._pools.get(e.kind);
    if (pool && pool.length < 24) pool.push(e);
  }

  clear() {
    for (let i = this.active.length - 1; i >= 0; i--) this.despawn(this.active[i]);
    this.active.length = 0;
    for (const b of this._bursts) b.hide();
    for (const s of this._splashes) s.hide();
    for (const r of this._rings) r.hide();
    for (const b of this._bolts) b.hide();
  }

  // ═══════════════════════════════════════════════════════════════ step

  /** @param {number} dt always CONFIG.physics.fixedDt */
  fixedUpdate(dt) {
    const a = this.active;
    for (let i = a.length - 1; i >= 0; i--) {
      const e = a[i];
      if (!e.alive) { this.despawn(e); continue; }
      e.prevPos.copy(e.pos);
      e.age += dt;
      let keep = true;
      try {
        keep = e.weapon.update ? e.weapon.update(dt, e, this.game) !== false : true;
      } catch (err) {
        console.warn(`[Projectiles] update threw for "${e.kind}":`, err);
        keep = false;
      }
      if (!keep || e.age >= e.life) this.despawn(e);
    }
  }

  /** @param {number} dt sim-scaled delta @param {number} alpha interpolation */
  update(dt, alpha) {
    const camera = this.game?.camera ?? null;
    const a = this.active;
    for (let i = 0; i < a.length; i++) {
      const e = a[i];
      try {
        if (e.weapon.sync) e.weapon.sync(e, alpha, this);
        else if (e.body && e.mesh) e.body.applyToObject3D(e.mesh, alpha);
        else if (e.mesh) e.mesh.position.copy(e.pos);
        if (e.data?.ribbon) e.data.ribbon.update(camera, e.data.ribbonFade ?? 1);
      } catch (err) {
        console.warn(`[Projectiles] sync threw for "${e.kind}":`, err);
      }
    }
    for (let i = 0; i < this._bursts.length; i++) this._bursts[i].update(dt);
    for (let i = 0; i < this._splashes.length; i++) this._splashes[i].update(dt);
    for (let i = 0; i < this._rings.length; i++) this._rings[i].update(dt);
    for (let i = 0; i < this._bolts.length; i++) this._bolts[i].update(dt, camera);
  }

  // ═══════════════════════════════════════════════════════════════ contacts

  _onCarCollision(p) {
    const other = p?.other;
    const e = other?.entity;
    if (e && e.alive && e.weapon?.onCarHit) {
      const car = this._carById.get(p.carId) ?? null;
      if (car) {
        try { e.weapon.onCarHit(e, car, p, this); }
        catch (err) { console.warn(`[Projectiles] onCarHit threw for "${e.kind}":`, err); }
      }
    }
  }

  _onPropHit(p) {
    const other = p?.other;
    const e = other?.entity;
    if (e && e.alive && e.weapon?.onPropHit) {
      try { e.weapon.onPropHit(e, p, this); }
      catch (err) { console.warn(`[Projectiles] onPropHit threw for "${e.kind}":`, err); }
    }
  }

  // ═══════════════════════════════════════════════════════════════ helpers

  /** @returns {import('../vehicle/Car.js').Car|null} */
  carById(id) { return this._carById.get(id) ?? null; }

  /** @returns {import('../vehicle/Car.js').Car[]} */
  get cars() { return this.game?.cars ?? []; }

  /** Resolve a `car:collision` payload's `other` into a Car when it is one. */
  resolveCar(userData) {
    if (!userData) return null;
    if (userData.isCar || userData.wheels) return userData;
    const id = userData.id;
    if (id == null) return null;
    const c = this._carById.get(id);
    return c && (c === userData || c.body?.userData === userData) ? c : (c ?? null);
  }

  get count() { return this.active.length; }

  /** Count of live entities of one kind — used to cap concurrent slicks etc. */
  countOfKind(kind) {
    let n = 0;
    for (let i = 0; i < this.active.length; i++) if (this.active[i].kind === kind) n++;
    return n;
  }

  /** Oldest live entity of a kind (for recycling when at the cap). */
  oldestOfKind(kind) {
    let best = null;
    for (let i = 0; i < this.active.length; i++) {
      const e = this.active[i];
      if (e.kind !== kind) continue;
      if (!best || e.age > best.age) best = e;
    }
    return best;
  }

  // ── shared FX pools ────────────────────────────────────────────────────

  _acquire(pool, cap, factory) {
    for (let i = 0; i < pool.length; i++) if (pool[i].life <= 0) return pool[i];
    if (pool.length < cap) {
      const fx = factory();
      pool.push(fx);
      const node = fx.group ?? fx.mesh;
      if (node) this.root.add(node);
      return fx;
    }
    // At the cap: steal the one closest to finishing.
    let best = pool[0];
    for (let i = 1; i < pool.length; i++) if (pool[i].life < best.life) best = pool[i];
    return best;
  }

  /** Explosion flash + ring + smoke shell. */
  burst(pos, radius = 0.9, duration = 0.55, normal = null, color = null) {
    const fx = this._acquire(this._bursts, FX_CAP.burst, () => new Burst(this.game, {}));
    if (color != null) fx.coreMat.color.set(color);
    fx.fire(pos, radius, duration, normal);
    return fx;
  }

  /** Water splash dome + ring. */
  splash(pos, radius = 0.5, duration = 0.6, normal = null) {
    const fx = this._acquire(this._splashes, FX_CAP.splash, () => new Splash(this.game, {}));
    fx.fire(pos, radius, duration, normal);
    return fx;
  }

  /** Bare expanding ring (shockwave, pad pop). */
  ring(pos, radius = 1, duration = 0.45, normal = null, color = 0xffffff) {
    const fx = this._acquire(this._rings, FX_CAP.ring, () => new RingWave(this.game, {}));
    fx.fire(pos, radius, duration, normal, color);
    return fx;
  }

  /** Chain-lightning bolt from → to. */
  bolt(from, to, duration = 0.4, color = null) {
    const fx = this._acquire(this._bolts, FX_CAP.bolt, () => new Bolt(this.game, {}));
    if (color != null) for (const r of fx.ribbons) r.color.set(color);
    fx.strike(from, to, duration, () => Math.random());
    return fx;
  }

  /** Small ground scorch/impact ring — the cheap "something happened" tell. */
  tick(pos, normal = null, color = 0xfff0c0) {
    return this.ring(pos, 0.34, 0.26, normal, color);
  }

  dispose() {
    this.clear();
    this._unbind();
    for (const pool of this._pools.values()) {
      for (const e of pool) {
        try { e.weapon?.disposeEntity?.(e, this); } catch { /* ignore */ }
        e.data?.ribbon?.dispose?.();
        e.mesh?.parent?.remove(e.mesh);
      }
      pool.length = 0;
    }
    this._pools.clear();
    for (const b of this._bursts) b.dispose();
    for (const s of this._splashes) s.dispose();
    for (const r of this._rings) r.dispose();
    for (const b of this._bolts) b.dispose();
    this._bursts.length = this._splashes.length = this._rings.length = this._bolts.length = 0;
    if (this._rootAdded) { this.root.parent?.remove(this.root); this._rootAdded = false; }
  }
}

export { Layer, _v };
export default Projectiles;
