/**
 * Shockwave — a radial push centred on you that flips everything nearby.
 *
 * Pure physics chaos: no status effect worth speaking of, just a hard outward
 * shove with a big upward bias and a roll kick, so cars in a tight pack get put
 * on their roofs. Short range, so it is a "get out of the sandwich" tool rather
 * than an area denial weapon, and it never touches the firer.
 */

import * as THREE from 'three';
import { clamp01 } from '../../core/MathUtils.js';
import {
  carPos, carUp, blast, projectilesOf, shake, emitSpawn, ramp,
} from './Common.js';

const _p = new THREE.Vector3();
const _up = new THREE.Vector3();

export const Shockwave = {
  id: 'shockwave',
  name: 'Shockwave',
  icon: 'shockwave',
  slots: 1,
  uses: 1,
  aimMode: 'self',
  entityKind: 'shockwave',
  lifetime: 1.0,
  blurb: 'Flips everyone around you.',

  // ── balance: back-half crowd control ──────────────────────────────────
  weight(place, carCount) { return ramp(place, carCount, 0.18, 0.90, 1.15); },
  usesFor() { return 1; },

  // ── tuning ────────────────────────────────────────────────────────────
  radius: 3.1,
  deltaV: 4.8,
  upBias: 1.15,
  spin: 5.5,
  roll: 9.5,
  /** Brief loss of grip so victims cannot instantly recover. */
  wobbleTime: 0.7,

  fire(ctx) {
    const game = ctx.game;
    const car = ctx.car;
    const mgr = ctx.projectiles ?? projectilesOf(game);

    carPos(car, _p);
    carUp(car, _up);

    // Ground-hugging double ring: a fast bright one and a slower ghost.
    mgr?.ring(_p, Shockwave.radius * 0.95, 0.42, null, 0xbfe6ff);
    game?.after?.(0.07, () => {
      mgr?.ring(_p, Shockwave.radius * 1.25, 0.55, null, 0x7fb8ff);
    });
    mgr?.burst(_p, 0.9, 0.34, null, 0xcfe8ff);

    const hits = blast(game, {
      position: _p,
      radius: Shockwave.radius,
      deltaV: Shockwave.deltaV,
      upBias: Shockwave.upBias,
      spin: Shockwave.spin,
      roll: Shockwave.roll,
      effect: 'oiled',
      effectTime: Shockwave.wobbleTime,
      sourceId: car?.id ?? -1,
      weaponId: 'shockwave',
      skipCarId: car?.id ?? -1,
      propDeltaV: 7.5,
      falloffPower: 1.35,
      minFalloff: 0.22,
      shake: 0.8,
    });

    // The firer gets planted, not thrown — a satisfying "thump" without
    // handing them a free launch.
    if (car?.body) {
      car.body.wake();
      car.body.velocity.addScaledVector(_up, -1.1);
    }

    emitSpawn(game, {
      weaponId: 'shockwave', carId: car?.id ?? -1, position: _p, kind: 'wave',
    });
    shake(game, 0.9, 0.4);
    void hits; void clamp01;
    return true;
  },
};

export default Shockwave;
