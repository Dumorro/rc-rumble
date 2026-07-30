/**
 * Clone Pickup — instantly grants another pickup.
 *
 * Rare, flat-weighted (it is neither an equaliser nor a defence), and it rolls
 * fast so the reveal feels like a bonus rather than a delay. It can never roll
 * itself, so there is no infinite chain.
 */

import * as THREE from 'three';
import { carPos, projectilesOf, emitSpawn } from './Common.js';

const _p = new THREE.Vector3();

export const ClonePickup = {
  id: 'clone',
  name: 'Clone Pickup',
  icon: 'clone',
  slots: 1,
  uses: 1,
  aimMode: 'self',
  entityKind: 'clone',
  lifetime: 0.1,
  blurb: 'Free re-roll. Anything goes.',

  /** Flat and low: a pleasant surprise, never a strategy. */
  weight() { return 0.16; },
  usesFor() { return 1; },

  fire(ctx) {
    const game = ctx.game;
    const car = ctx.car;
    const pickups = ctx.pickups ?? game?.pickups;
    if (!pickups?.grant || !car) return false;

    const mgr = ctx.projectiles ?? projectilesOf(game);
    carPos(car, _p);
    _p.y += 0.09;
    mgr?.ring(_p, 0.5, 0.32, null, 0xffe89a);
    mgr?.burst(_p, 0.45, 0.28, null, 0xfff1b0);

    emitSpawn(game, {
      weaponId: 'clone', carId: car.id, position: _p, kind: 'clone',
    });

    // Re-roll on the next tick so the slot is definitely clear first.
    game?.after?.(0.001, () => {
      pickups.grant(car, { source: 'clone', fast: true, exclude: 'clone' });
    });
    // Belt and braces: if the game has no timer service, do it inline.
    if (!game?.after) pickups.grant(car, { source: 'clone', fast: true, exclude: 'clone' });
    return true;
  },
};

export default ClonePickup;
