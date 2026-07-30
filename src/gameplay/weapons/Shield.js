/**
 * Shield — a visible bubble that absorbs exactly one hit.
 *
 * Every damaging weapon routes through `Effects.tryDamage`, so a shield blocks
 * everything uniformly: a direct firework, a bomb hand-off, an electro-pulse,
 * an oil slick trigger, a shockwave. That single choke point is why the item is
 * worth carrying and why it behaves predictably.
 *
 * The bubble entity follows its car visually and dies the moment the effect
 * ends — whether that is the timer running out or the charge being spent.
 */

import * as THREE from 'three';
import { clamp01 } from '../../core/MathUtils.js';
import { buildShieldMesh } from '../VisualKit.js';
import {
  carPos, effectsOf, projectilesOf, emitSpawn, ramp,
} from './Common.js';

const _p = new THREE.Vector3();

export const Shield = {
  id: 'shield',
  name: 'Shield',
  icon: 'shield',
  slots: 1,
  uses: 1,
  aimMode: 'self',
  entityKind: 'shield',
  lifetime: 20.0,
  blurb: 'Absorbs the next hit.',

  // ── balance: the leader's best friend ─────────────────────────────────
  weight(place, carCount) { return ramp(place, carCount, 0.95, 0.40); },
  usesFor() { return 1; },

  // ── tuning ────────────────────────────────────────────────────────────
  duration: 15.0,
  radius: 0.21,

  fire(ctx) {
    const game = ctx.game;
    const car = ctx.car;
    const fx = effectsOf(game);
    if (!fx || !car) return false;

    fx.shield(car, Shield.duration, {
      sourceId: car.id, weaponId: 'shield',
    });

    const mgr = ctx.projectiles ?? projectilesOf(game);
    // Only one bubble per car, please.
    if (mgr) {
      for (let i = 0; i < mgr.active.length; i++) {
        const a = mgr.active[i];
        if (a.kind === 'shield' && a.data.car === car) { mgr.despawn(a); break; }
      }
      mgr.spawn(Shield, ctx);
      carPos(car, _p);
      mgr.ring(_p, 0.7, 0.4, null, 0xbfe8ff);
    }

    emitSpawn(game, {
      weaponId: 'shield', carId: car.id, position: carPos(car, _p), kind: 'shield',
    });
    return true;
  },

  createEntity(mgr) {
    const mesh = buildShieldMesh(mgr.game, Shield.radius);
    // Per-entity materials: the library ones are shared, and we animate opacity.
    mesh.material = mesh.material.clone();
    const rim = mesh.userData.parts?.rim;
    if (rim) rim.material = rim.material.clone();
    return { mesh, data: { car: null, pulse: 0, popping: 0 } };
  },

  disposeEntity(e) {
    e.mesh?.material?.dispose?.();
    e.mesh?.userData?.parts?.rim?.material?.dispose?.();
  },

  resetEntity(e, ctx) {
    const d = e.data;
    d.car = ctx.car ?? null;
    d.pulse = 0;
    d.popping = 0;
    e.life = Shield.lifetime;
    if (d.car) carPos(d.car, e.pos);
    if (e.mesh) {
      e.mesh.visible = true;
      e.mesh.scale.setScalar(0.2);
      e.mesh.position.copy(e.pos);
    }
  },

  update(dt, e) {
    const d = e.data;
    const car = d.car;
    if (!car) return false;
    d.pulse += dt;
    carPos(car, e.pos);
    const remaining = car.effects?.shielded ?? 0;
    if (remaining <= 0) {
      // Pop out over a fifth of a second rather than vanishing.
      d.popping += dt;
      return d.popping < 0.22;
    }
    return true;
  },

  sync(e) {
    const d = e.data;
    if (!e.mesh || !d.car) return;
    const g = d.car.group;
    e.mesh.position.copy(g ? g.position : e.pos);
    if (g) e.mesh.quaternion.copy(g.quaternion);

    const remaining = d.car.effects?.shielded ?? 0;
    // Spawn-in bloom, steady shimmer, then a fast expanding pop.
    let s;
    if (d.popping > 0) {
      const t = clamp01(d.popping / 0.22);
      s = 1 + t * 0.9;
      setOpacity(e.mesh, (1 - t) * 0.55);
    } else {
      const grow = clamp01(d.pulse / 0.22);
      const shimmer = 1 + Math.sin(d.pulse * 5.5) * 0.025;
      // Flash brighter in the last two seconds so the player knows it is going.
      const warn = remaining > 0 && remaining < 2
        ? 0.55 + 0.45 * Math.sin(d.pulse * 22)
        : 1;
      s = (0.2 + 0.8 * (1 - Math.pow(1 - grow, 3))) * shimmer;
      setOpacity(e.mesh, 0.42 * warn * grow);
    }
    e.mesh.scale.setScalar(s);
  },

  onDespawn(e) {
    if (e.mesh) e.mesh.visible = false;
    e.data.car = null;
  },
};

function setOpacity(mesh, v) {
  if (mesh.material && mesh.material.opacity !== undefined) {
    mesh.material.transparent = true;
    mesh.material.opacity = v;
  }
  const rim = mesh.userData.parts?.rim;
  if (rim?.material) rim.material.opacity = v * 0.4;
}

export default Shield;
