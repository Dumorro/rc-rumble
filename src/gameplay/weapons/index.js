/**
 * Weapon registry + the position-weighted roll table.
 *
 * ── The balance philosophy ────────────────────────────────────────────────
 * Re-Volt's pickup table is not random, it is *positional*. The car in front is
 * handed defensive and minor items; the car at the back is handed equalisers.
 * That single rule is what makes a race chaotic but still decided by skill:
 *
 *   leader      shield · oil slick · ball bearing · turbo
 *   mid-field   turbo · balloon · bearing · firework
 *   backmarker  electro-pulse · bomb · shockwave · triple firework
 *
 * On top of the per-weapon `weight(place, carCount)` curves:
 *   • the item you just used is 3× less likely to come back (no machine-gunning),
 *   • the one before that is ~1.6× less likely,
 *   • items that need a victim (bomb, electro-pulse) are suppressed when there
 *     is nobody to hit,
 *   • a mild final-lap bias sharpens the fight for the podium without letting
 *     the leader be dogpiled from nowhere.
 *
 * Every weapon satisfies the ARCHITECTURE.md `Weapon` contract:
 *   { id, name, icon, slots, uses, aimMode, weight(place, carCount), fire(ctx),
 *     update?(dt, state, game) }
 * plus the optional pooling hooks documented in Projectiles.js.
 */

import { Firework } from './Firework.js';
import { OilSlick } from './OilSlick.js';
import { WaterBalloon } from './WaterBalloon.js';
import { ElectroPulse } from './ElectroPulse.js';
import { BallBearing } from './BallBearing.js';
import { Bomb } from './Bomb.js';
import { ClonePickup } from './ClonePickup.js';
import { Shockwave } from './Shockwave.js';
import { Turbo } from './Turbo.js';
import { Shield } from './Shield.js';

/** Canonical order — also the display order in any debug list. */
export const WEAPON_LIST = Object.freeze([
  Turbo,
  Shield,
  OilSlick,
  BallBearing,
  WaterBalloon,
  Firework,
  Shockwave,
  Bomb,
  ElectroPulse,
  ClonePickup,
]);

/** id → weapon module. */
export const WEAPONS = Object.freeze(WEAPON_LIST.reduce((acc, w) => {
  acc[w.id] = w;
  return acc;
}, {}));

export const WEAPON_IDS = Object.freeze(WEAPON_LIST.map(w => w.id));

/** Weapons that need another car to exist to be worth anything. */
const NEEDS_VICTIM = Object.freeze(['bomb', 'electro', 'firework']);

/** Weapons that are purely self-affecting (never blocked, never wasted). */
export const SELF_WEAPONS = Object.freeze(['turbo', 'shield', 'clone']);

export function getWeapon(id) { return WEAPONS[id] ?? null; }
export function isWeapon(id) { return !!WEAPONS[id]; }

/** Scratch weight buffer — the roll is allocation free. */
const _w = new Float64Array(32);

/**
 * Roll one weapon from the position-weighted table.
 *
 * @param {() => number} rnd 0..1 source (pass `game.rng.next.bind(game.rng)`
 *        for determinism)
 * @param {object} [opts]
 * @param {number} [opts.place] 1-based race position of the roller
 * @param {number} [opts.carCount]
 * @param {string|string[]} [opts.exclude] id(s) that may not be rolled
 * @param {string} [opts.lastId] the weapon this car just had
 * @param {string} [opts.prevId] the one before that
 * @param {object} [opts.context] `{ finalLap, lapsRemaining, gapAhead,
 *        gapBehind, hasCarAhead, hasCarBehind, soloRace }`
 * @returns {object} a weapon module (never null — falls back to Turbo)
 */
export function rollWeapon(rnd, opts = {}) {
  const place = opts.place ?? 1;
  const carCount = opts.carCount ?? 1;
  const ctx = opts.context ?? null;
  const exclude = opts.exclude ?? null;
  const n = WEAPON_LIST.length;
  let total = 0;

  for (let i = 0; i < n; i++) {
    const w = WEAPON_LIST[i];
    let weight = 0;
    try { weight = w.weight ? (w.weight(place, carCount, ctx) ?? 0) : 0.2; }
    catch { weight = 0; }
    if (!(weight > 0)) { _w[i] = 0; continue; }

    // ── exclusions ──
    if (exclude) {
      if (typeof exclude === 'string' ? exclude === w.id : exclude.indexOf(w.id) >= 0) {
        _w[i] = 0; continue;
      }
    }

    // ── anti-repeat ──
    if (w.id === opts.lastId) weight *= 0.30;
    else if (w.id === opts.prevId) weight *= 0.62;

    // ── situational ──
    if (ctx) {
      if (ctx.soloRace && NEEDS_VICTIM.indexOf(w.id) >= 0) weight *= 0.05;
      if (!ctx.hasCarAhead && (w.id === 'bomb' || w.id === 'firework')) weight *= 0.35;
      if (!ctx.hasCarBehind && w.id === 'oil') weight *= 0.25;
      if (ctx.finalLap) {
        // Sharpen the last-lap scrap: podium contenders get slightly more
        // attacking options, the leader keeps its defensive bias.
        if (place > 1 && place <= 4 && (w.id === 'firework' || w.id === 'turbo')) weight *= 1.25;
        if (w.id === 'clone') weight *= 0.5;
      }
      // A leader being reeled in gets a little more help than one cruising.
      if (place === 1 && ctx.gapBehind != null && ctx.gapBehind < 1.5) {
        if (w.id === 'oil' || w.id === 'shield' || w.id === 'turbo') weight *= 1.2;
      }
      // A hopeless backmarker gets the big stuff more often, but not always.
      if (ctx.gapAhead != null && ctx.gapAhead > 6 && place === carCount) {
        if (w.id === 'electro' || w.id === 'turbo') weight *= 1.3;
      }
    }

    _w[i] = weight;
    total += weight;
  }

  if (!(total > 0)) return Turbo;
  let r = rnd() * total;
  for (let i = 0; i < n; i++) {
    r -= _w[i];
    if (r <= 0) return WEAPON_LIST[i];
  }
  return WEAPON_LIST[n - 1];
}

/**
 * Ids with a non-zero chance for this roller — the pool the "rolling" slot
 * animation flickers through. Fills and returns `out`.
 * @returns {string[]}
 */
export function rollCandidates(out, opts = {}) {
  out.length = 0;
  const place = opts.place ?? 1;
  const carCount = opts.carCount ?? 1;
  const exclude = opts.exclude ?? null;
  for (let i = 0; i < WEAPON_LIST.length; i++) {
    const w = WEAPON_LIST[i];
    if (exclude) {
      if (typeof exclude === 'string' ? exclude === w.id : exclude.indexOf(w.id) >= 0) continue;
    }
    let weight = 0;
    try { weight = w.weight ? w.weight(place, carCount, opts.context ?? null) : 0.2; }
    catch { weight = 0; }
    if (weight > 0.05) out.push(w.id);
  }
  if (out.length === 0) out.push('turbo');
  return out;
}

/** How many uses a weapon comes with for this race position. */
export function usesFor(weapon, place, carCount) {
  if (!weapon) return 1;
  try {
    if (typeof weapon.usesFor === 'function') {
      return Math.max(1, Math.round(weapon.usesFor(place, carCount)));
    }
  } catch { /* fall through */ }
  return Math.max(1, weapon.uses ?? 1);
}

export {
  Firework, OilSlick, WaterBalloon, ElectroPulse, BallBearing,
  Bomb, ClonePickup, Shockwave, Turbo, Shield,
};

export default WEAPONS;
