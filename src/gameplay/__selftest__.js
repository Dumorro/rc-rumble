/**
 * Gameplay self-test — verifies the parts that only exist in a real browser:
 * the procedural MaterialLibrary path, every VisualKit mesh, the ribbon/bolt/
 * ring/burst pools, and a dry run of every weapon's `fire()` against the live
 * game.
 *
 * The pure logic (race rules, progress, standings, roll table, effects) is
 * covered headlessly; this covers the GPU-side wiring those tests cannot reach.
 *
 * Usage — from the browser console with `?debug=1`:
 *
 *   await GAME.pickups.selfTest()            // → { ok, passed, failed, errors }
 *   await GAME.pickups.selfTest({ visual: true })   // also parks a preview
 *                                                   // rig 3 m above the grid
 *
 * Never imported by the game itself: PickupSystem pulls it in dynamically, so
 * it costs nothing in the shipped bundle beyond a lazy chunk.
 */

import * as THREE from 'three';
import {
  mats, additive, glow, solid, chrome,
  buildPadMesh, buildRocketMesh, buildBearingMesh, buildBalloonMesh,
  buildBombMesh, buildShieldMesh, buildOilGeometry, oilMaterial,
  TrailRibbon, Bolt, RingWave, Burst, Splash,
} from './VisualKit.js';
import { WEAPON_LIST, rollWeapon, rollCandidates, usesFor } from './weapons/index.js';

const _v = new THREE.Vector3();

/**
 * @param {import('../core/Game.js').Game} game
 * @param {{visual?:boolean}} [opts] `visual: true` leaves a preview rig in the
 *        scene so you can eyeball every mesh at once.
 * @returns {Promise<{ok:boolean, passed:number, failed:number, errors:string[], group:THREE.Group|null}>}
 */
export async function run(game, opts = {}) {
  const errors = [];
  let passed = 0;
  const check = (label, fn) => {
    try {
      const r = fn();
      if (r === false) { errors.push(`${label}: returned false`); return null; }
      passed++;
      return r;
    } catch (err) {
      errors.push(`${label}: ${err?.message ?? err}`);
      return null;
    }
  };

  const preview = new THREE.Group();
  preview.name = 'gameplay:selftest';

  // ── 1. material library ────────────────────────────────────────────────
  const M = check('getMaterials', () => mats(game));
  check('emissive material', () => !!glow(game, 0x51e2ff, 2.2));
  check('additive material', () => !!additive(game, 0xffffff, 0.5));
  check('solid material', () => !!solid(game, 0xcccccc));
  check('chrome material', () => !!chrome(game));
  check('oil material', () => !!oilMaterial(game));
  if (M) {
    check('M.bubble', () => !!M.bubble({ tint: 0xbfe8ff }));
    check("M.get('metal/chrome')", () => !!M.get('metal/chrome', { sizeMeters: 0.25 }));
    check("M.get('glass/frosted')", () => !!M.get('glass/frosted', {}));
    check("M.get('hazard/oil_slick')", () => !!M.get('hazard/oil_slick', { sizeMeters: 0.8 }));
  }

  // ── 2. every mesh builder ──────────────────────────────────────────────
  const built = [];
  const mesh = (label, fn) => {
    const m = check(label, fn);
    if (m) { built.push(m); preview.add(m); }
    return m;
  };
  mesh('pad mesh', () => buildPadMesh(game, { radius: 0.15 }));
  mesh('rocket mesh', () => buildRocketMesh(game, {}));
  mesh('bearing mesh', () => buildBearingMesh(game, 0.042));
  mesh('balloon mesh', () => buildBalloonMesh(game, 0.048));
  mesh('bomb mesh', () => buildBombMesh(game, 0.042));
  mesh('shield mesh', () => buildShieldMesh(game, 0.21));
  mesh('oil decal', () => {
    const g = buildOilGeometry(7, 0.34, 24);
    // Winding sanity: every triangle must face up, or physics/lighting break.
    const pos = g.attributes.position.array;
    const idx = g.index.array;
    let bad = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = pos[b] - pos[a], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vz = pos[c + 2] - pos[a + 2];
      if (ux * vz - uz * vx > 0) bad++;   // +Y normal ⇒ cross.y = uz*vx - ux*vz > 0
    }
    if (bad > 0) throw new Error(`${bad}/${idx.length / 3} oil triangles wound downward`);
    return new THREE.Mesh(g, oilMaterial(game));
  });

  // ── 3. dynamic FX ──────────────────────────────────────────────────────
  const camera = game?.camera ?? new THREE.PerspectiveCamera();
  check('trail ribbon', () => {
    const r = new TrailRibbon(game, { points: 12, color: 0xffb070 });
    preview.add(r.mesh);
    for (let i = 0; i < 12; i++) r.push(_v.set(i * 0.05, Math.sin(i) * 0.02, 0));
    r.update(camera, 1);
    if (!r.mesh.visible) throw new Error('ribbon stayed hidden after 12 points');
    if (r.geometry.drawRange.count !== 11 * 6) throw new Error('bad draw range');
    return true;
  });
  check('lightning bolt', () => {
    const b = new Bolt(game, { segments: 10 });
    preview.add(b.group);
    b.strike(_v.set(0, 0.2, 0), new THREE.Vector3(0.8, 0.25, 0.2), 0.4, Math.random);
    if (!b.update(1 / 120, camera)) throw new Error('bolt died immediately');
    return true;
  });
  check('ring wave', () => {
    const r = new RingWave(game, {});
    preview.add(r.mesh);
    r.fire(new THREE.Vector3(0, 0.02, 0), 1.2, 0.4);
    if (!r.update(1 / 120)) throw new Error('ring died immediately');
    return true;
  });
  check('burst', () => {
    const b = new Burst(game, {});
    preview.add(b.group);
    b.fire(new THREE.Vector3(0, 0.2, 0), 1.0, 0.5);
    if (!b.update(1 / 120)) throw new Error('burst died immediately');
    return true;
  });
  check('splash', () => {
    const s = new Splash(game, {});
    preview.add(s.group);
    s.fire(new THREE.Vector3(0, 0.05, 0), 0.5, 0.6);
    if (!s.update(1 / 120)) throw new Error('splash died immediately');
    return true;
  });

  // ── 4. roll table ──────────────────────────────────────────────────────
  check('roll table', () => {
    const out = [];
    const n = game?.cars?.length || 8;
    for (let place = 1; place <= n; place++) {
      rollCandidates(out, { place, carCount: n });
      if (out.length === 0) throw new Error(`no candidates at place ${place}`);
      for (let i = 0; i < 200; i++) {
        const w = rollWeapon(() => Math.random(), { place, carCount: n });
        if (!w || !w.id) throw new Error(`bad roll at place ${place}`);
        if (usesFor(w, place, n) < 1) throw new Error(`bad uses for ${w.id}`);
      }
    }
    return true;
  });

  // ── 5. live fire, every weapon, on the real player car ─────────────────
  const pickups = game?.pickups;
  const car = game?.playerCar;
  if (pickups && car && game.cars?.length) {
    const before = pickups.projectiles.spawnCount;
    for (const w of WEAPON_LIST) {
      check(`fire ${w.id}`, () => {
        pickups.clearSlot(car);
        // This runs synchronously inside one frame, so no time passes and the
        // post-shot cooldown from the previous weapon would still be up.
        const slot = pickups.slots.get(car.id);
        if (slot) slot.cooldown = 0;
        if (!pickups.give(car, w.id, 1)) throw new Error('give failed');
        const fired = pickups.tryFire(car, { backwards: false });
        // ElectroPulse legitimately refuses when there is nobody to zap.
        if (!fired && game.cars.length > 1) throw new Error('fire refused');
        return true;
      });
      // Let it live for a moment so update()/sync() run at least once.
      for (let i = 0; i < 4; i++) {
        pickups.projectiles.fixedUpdate(1 / 120);
        pickups.projectiles.update(1 / 120, 0);
      }
    }
    check('projectiles spawned', () => pickups.projectiles.spawnCount > before);
    pickups.clearSlot(car);
    pickups.projectiles.clear();
    for (const c of game.cars) pickups.effects.reset(c);
  } else {
    errors.push('live fire skipped: no player car in the scene');
  }

  // ── 6. effects round-trip ──────────────────────────────────────────────
  if (pickups && car) {
    check('effects round-trip', () => {
      const fx = pickups.effects;
      fx.reset(car);
      fx.apply(car, 'squashed', 0.05);
      if (!(car.effects.squashed > 0)) throw new Error('squashed did not apply');
      // Mods are recomputed in fixedUpdate, not in apply().
      fx.fixedUpdate(1 / 120);
      if (!(car.effectMods.torque < 1)) throw new Error('torque mod not written');
      for (let i = 0; i < 20; i++) fx.fixedUpdate(1 / 120);
      if (car.effects.squashed !== 0) throw new Error('squashed did not expire');
      if (car.effectMods.torque !== 1) throw new Error('mods not restored');
      return true;
    });
  }

  // ── preview rig ────────────────────────────────────────────────────────
  let group = null;
  if (opts.visual) {
    let x = -1.2;
    for (const m of preview.children) { m.position.x = x; x += 0.4; }
    _v.set(0, 3, 0);
    if (game?.playerCar?.group) _v.copy(game.playerCar.group.position).add(new THREE.Vector3(0, 1.2, 0));
    preview.position.copy(_v);
    game?.scene?.add(preview);
    game?.renderer?.lighting?.scanMaterials?.(true);
    group = preview;
  } else {
    for (const m of built) m.parent?.remove(m);
  }

  const result = {
    ok: errors.length === 0,
    passed,
    failed: errors.length,
    errors,
    group,
  };
  const tag = result.ok ? '✅' : '❌';
  console.log(`${tag} [gameplay selftest] ${passed} passed, ${errors.length} failed`);
  for (const e of errors) console.warn('   ·', e);
  return result;
}

export default run;
