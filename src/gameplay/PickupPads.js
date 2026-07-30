/**
 * PickupPads — the floating, rotating pickup pads on the track.
 *
 * Reads `TrackData.pickupPads`, and — if a track forgot to author any — lays a
 * sensible set down the centreline so the pickup layer is always exercisable.
 * Collection is a squared-distance test in `fixedUpdate` (8 cars × ≤ 48 pads is
 * nothing), with a satisfying scale-up pop, a ring wave, a respawn cooldown and
 * an elastic re-entry.
 *
 * All pad geometry and materials are shared (see VisualKit), so the visual cost
 * of 48 pads is four draw calls' worth of instanced-ish geometry, not 192
 * unique materials — which is why the pop animation is done with scale rather
 * than per-pad opacity.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/MathUtils.js';
import { buildPadMesh } from './VisualKit.js';
import { carPos, groundBelow } from './weapons/Common.js';

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _YP = new THREE.Vector3(0, 1, 0);

const MAX_PADS = 56;

export class PickupPads {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {object} pickups the owning PickupSystem
   */
  constructor(game, pickups) {
    this.game = game;
    this.pickups = pickups;

    /** @type {object[]} */
    this.pads = [];
    this.root = new THREE.Group();
    this.root.name = 'gameplay:pickupPads';
    this._rootAdded = false;

    // ── tuning ──────────────────────────────────────────────────────────
    /** Seconds a collected pad stays dark. */
    this.respawnTime = 4.6;
    /** Collection radius, metres (car half-width ≈ 0.09). */
    this.collectRadius = 0.27;
    /** Vertical window for a collection. */
    this.collectHeight = 0.30;
    /** Height the pad floats above its anchor. */
    this.hover = 0.058;
    /** Bob amplitude / rate. */
    this.bobAmount = 0.013;
    this.bobRate = 2.1;
    this.spinRate = 1.35;
    /** Generate pads down the centreline when the track has none. */
    this.autoPads = true;
    this.autoSpacing = 13.0;
    this.autoMax = 22;

    this._time = 0;
  }

  // ═══════════════════════════════════════════════════════════════ lifecycle

  onRaceStart(ctx) {
    const scene = this.game?.scene;
    if (scene && !this._rootAdded) { scene.add(this.root); this._rootAdded = true; }
    this.clear();
    this._time = 0;

    const track = ctx?.track ?? this.game?.track ?? null;
    let spots = Array.isArray(track?.pickupPads) ? track.pickupPads : [];
    let generated = false;
    if (spots.length === 0 && this.autoPads) {
      spots = this._generateSpots();
      generated = spots.length > 0;
    }

    const n = Math.min(MAX_PADS, spots.length);
    for (let i = 0; i < n; i++) {
      const s = spots[i];
      const pos = s?.position;
      if (!pos || typeof pos.x !== 'number') continue;
      const pad = this._makePad(i, pos, s?.quaternion ?? null);
      this.pads.push(pad);
    }

    if (this.pads.length) {
      // A batch of new lit meshes needs the shadow/light rig to re-scan.
      this.game?.renderer?.lighting?.scanMaterials?.(true);
    }
    if (generated) {
      console.info(`[PickupPads] track had no pickupPads — generated ${this.pads.length} along the centreline.`);
    }
  }

  onRaceEnd() { this.clear(); }

  clear() {
    for (let i = 0; i < this.pads.length; i++) {
      const p = this.pads[i];
      this.root.remove(p.group);
      disposePadGroup(p.group);
    }
    this.pads.length = 0;
  }

  dispose() {
    this.clear();
    if (this._rootAdded) { this.root.parent?.remove(this.root); this._rootAdded = false; }
  }

  // ═══════════════════════════════════════════════════════════════ build

  _generateSpots() {
    const nav = this.game?.race?.nav;
    if (!nav?.ready || nav.length < 8) return [];
    const out = [];
    const count = Math.min(this.autoMax, Math.max(4, Math.floor(nav.length / this.autoSpacing)));
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      nav.frameAt(u, pos, quat);
      // Stagger left/right/centre so they read as a placed set, not a conga line.
      const half = nav.halfWidthAt(u);
      const lane = (i % 3) - 1;
      nav.tangentAt(u, _n);
      _p.crossVectors(_n, _YP).normalize();
      pos.addScaledVector(_p, lane * Math.min(0.45, half * 0.42));
      out.push({ position: pos, quaternion: quat });
    }
    return out;
  }

  _makePad(id, position, quaternion) {
    const group = buildPadMesh(this.game, { radius: 0.15, color: 0x51e2ff });

    // Sit the pad on the surface below its anchor, aligned to the ground.
    _p.copy(position);
    const hit = groundBelow(this.game, _p, 1.4);
    if (hit) {
      _p.copy(hit.point);
      _n.copy(hit.normal);
    } else {
      _n.set(0, 1, 0);
    }
    const base = _p.clone().addScaledVector(_n, this.hover);
    group.position.copy(base);
    if (quaternion) group.quaternion.copy(quaternion);
    else { _q.setFromUnitVectors(_YP, _n); group.quaternion.copy(_q); }
    this.root.add(group);

    return {
      id,
      group,
      parts: group.userData.parts,
      base,
      normal: _n.clone(),
      active: true,
      cooldown: 0,
      popT: 0,
      spawnT: 1,
      phase: (id * 2.399963) % 6.2831853,
      lastCarId: -1,
    };
  }

  // ═══════════════════════════════════════════════════════════════ step

  /** @param {number} dt always CONFIG.physics.fixedDt */
  fixedUpdate(dt) {
    const pads = this.pads;
    if (pads.length === 0) return;
    const cars = this.game?.cars ?? [];
    const r2 = this.collectRadius * this.collectRadius;
    const hy = this.collectHeight;

    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad.active) {
        pad.cooldown -= dt;
        if (pad.cooldown <= 0) {
          pad.active = true;
          pad.spawnT = 0;
          pad.popT = 0;
          pad.group.visible = true;
          this.game?.bus?.emit('pickup:respawn', { padId: pad.id, position: pad.base });
        }
        continue;
      }
      if (pad.spawnT < 1) pad.spawnT = Math.min(1, pad.spawnT + dt / 0.36);

      for (let c = 0; c < cars.length; c++) {
        const car = cars[c];
        if (!car || car.finished) continue;
        // Re-Volt rule: a car already holding an item drives straight over the
        // pad and leaves it for somebody else. That is a real tactical choice.
        if (this.pickups?.canCollect && !this.pickups.canCollect(car)) continue;
        carPos(car, _p);
        const dy = _p.y - pad.base.y;
        if (dy < -hy || dy > hy) continue;
        const dx = _p.x - pad.base.x, dz = _p.z - pad.base.z;
        if (dx * dx + dz * dz > r2) continue;
        this._collect(pad, car);
        break;
      }
    }
  }

  _collect(pad, car) {
    pad.active = false;
    pad.cooldown = this.respawnTime;
    pad.popT = 0;
    pad.lastCarId = car.id;

    this.game?.bus?.emit('pickup:collected', { carId: car.id, padId: pad.id });
    // A bright ring at the pad so the collect always reads, even off-screen edge.
    this.pickups?.projectiles?.ring(pad.base, 0.62, 0.34, pad.normal, 0x8ff0ff);
    this.pickups?.grant?.(car, { padId: pad.id, source: 'pad' });
    if (car.isPlayer) {
      this.game?.bus?.emit('camera:shake', { amount: 0.10, duration: 0.12 });
    }
  }

  /** @param {number} dt sim-scaled */
  update(dt) {
    const pads = this.pads;
    if (pads.length === 0) return;
    this._time += dt;
    const t = this._time;

    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      const parts = pad.parts;

      if (!pad.active) {
        // Pop: expand fast, then vanish. Cheap, and no per-pad materials.
        if (pad.popT < 1) {
          pad.popT = Math.min(1, pad.popT + dt / 0.20);
          const s = 1 + pad.popT * 1.5;
          pad.group.scale.setScalar(s);
          if (pad.popT >= 1) { pad.group.visible = false; pad.group.scale.setScalar(1); }
        }
        continue;
      }

      // Elastic entry.
      let scale = 1;
      if (pad.spawnT < 1) {
        const e = pad.spawnT;
        scale = 1 - Math.pow(1 - e, 3);
        scale *= 1 + 0.22 * Math.sin(e * Math.PI * 2.2) * (1 - e);
      }
      pad.group.scale.setScalar(scale);

      const bob = Math.sin(t * this.bobRate + pad.phase) * this.bobAmount;
      pad.group.position.copy(pad.base).addScaledVector(pad.normal, bob);

      if (parts) {
        parts.core.rotation.y += dt * this.spinRate * 2.2;
        parts.core.rotation.x += dt * this.spinRate * 0.9;
        parts.halo.rotation.y -= dt * this.spinRate * 1.1;
        const pulse = 1 + Math.sin(t * 3.1 + pad.phase) * 0.10;
        parts.halo.scale.setScalar(pulse);
        parts.ring.rotation.z += dt * this.spinRate * 0.55;
        const gp = 1 + Math.sin(t * 2.4 + pad.phase * 1.7) * 0.12;
        parts.glow.scale.set(gp, 1, gp);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════ queries

  get count() { return this.pads.length; }

  get activeCount() {
    let n = 0;
    for (let i = 0; i < this.pads.length; i++) if (this.pads[i].active) n++;
    return n;
  }

  /** Nearest live pad ahead of a car — used by the AI to hunt pickups. */
  nearestActive(position, maxDist = 12) {
    let best = null, bestD = maxDist * maxDist;
    for (let i = 0; i < this.pads.length; i++) {
      const pad = this.pads[i];
      if (!pad.active) continue;
      const d = pad.base.distanceToSquared(position);
      if (d < bestD) { bestD = d; best = pad; }
    }
    return best;
  }

  padById(id) {
    for (let i = 0; i < this.pads.length; i++) if (this.pads[i].id === id) return this.pads[i];
    return null;
  }
}

function disposePadGroup(group) {
  group.traverse((o) => {
    // Geometry and materials are shared/memoised on Assets — do not dispose,
    // just detach. Assets.dispose() owns their lifetime.
    void o;
  });
}

export { clamp01 };
export default PickupPads;
