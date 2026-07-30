/**
 * Turbo — a timed boost with a raised speed cap and a hard shove.
 *
 * The shove is an instantaneous impulse (so it *pops*), then a sustained thrust
 * for the duration, tapering out over the last half second so the drop-off is
 * not a cliff you have to catch. `effectMods.maxSpeed` goes to 1.42 for the
 * duration, and downforce rises so a boost over a crest does not launch you
 * into orbit.
 *
 * Available to everyone — the leader is never helpless — but the back of the
 * field gets two of them.
 */

import * as THREE from 'three';
import {
  carPos, carForward, effectsOf, projectilesOf, emitSpawn, ramp, fieldT,
} from './Common.js';

const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export const Turbo = {
  id: 'turbo',
  name: 'Turbo',
  icon: 'turbo',
  slots: 1,
  uses: 1,
  aimMode: 'self',
  entityKind: 'turbo',
  lifetime: 0.1,
  blurb: 'Speed cap up, hard shove.',

  // ── balance: universal, mildly back-weighted ───────────────────────────
  weight(place, carCount) { return ramp(place, carCount, 0.88, 1.00); },
  usesFor(place, carCount) { return fieldT(place, carCount) > 0.6 ? 2 : 1; },

  // ── tuning ────────────────────────────────────────────────────────────
  duration: 2.55,
  /** Extra seconds when the roll happens at the back of the field. */
  backBonus: 0.5,

  fire(ctx) {
    const game = ctx.game;
    const car = ctx.car;
    const fx = effectsOf(game);
    if (!fx || !car) return false;

    const t = ctx.fieldT ?? 0;
    const secs = Turbo.duration + Turbo.backBonus * t;
    fx.boost(car, secs, { sourceId: car.id, weaponId: 'turbo' });

    // A visible kick of light out of the back.
    const mgr = ctx.projectiles ?? projectilesOf(game);
    carPos(car, _p);
    carForward(car, _fwd);
    _p.addScaledVector(_fwd, -0.16);
    mgr?.ring(_p, 0.55, 0.28, null, 0x9fe0ff);

    emitSpawn(game, {
      weaponId: 'turbo', carId: car.id, position: _p, kind: 'boost',
    });
    game?.bus?.emit('camera:shake', { amount: car.isPlayer ? 0.35 : 0.08, duration: 0.22 });
    return true;
  },
};

export default Turbo;
