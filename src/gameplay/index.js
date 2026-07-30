/**
 * RC RUMBLE — gameplay public surface.
 *
 * Other systems should import from here rather than reaching into individual
 * files:
 *
 *   import { formatTime, ordinal, WEAPONS } from '../gameplay/index.js';
 *
 * Live handles at runtime:
 *   game.race                  RaceSystem
 *   game.race.standings        Standings
 *   game.race.nav              TrackNav
 *   game.pickups               PickupSystem
 *   game.pickups.pads          PickupPads
 *   game.pickups.effects       EffectsLayer   (also game.effects)
 *   game.pickups.projectiles   Projectiles
 */

export { RaceSystem, RaceEntry, RacePhase, simPos, carForward } from './RaceSystem.js';
export {
  Standings, ProgressTrace, compareEntries,
  formatTime, formatGap, ordinal,
} from './Standings.js';
export { EffectsLayer, EFFECT_KEYS } from './Effects.js';
export { PickupSystem } from './PickupSystem.js';
export { PickupPads } from './PickupPads.js';
export { Projectiles } from './Projectiles.js';
export { TrackNav, wrap01, loopDelta } from './TrackNav.js';
export {
  mats, additive, glow, solid, chrome,
  buildPadMesh, buildRocketMesh, buildBearingMesh, buildBalloonMesh,
  buildBombMesh, buildShieldMesh, buildOilGeometry, oilMaterial,
  TrailRibbon, Bolt, RingWave, Burst, Splash,
} from './VisualKit.js';
export {
  WEAPONS, WEAPON_LIST, WEAPON_IDS, SELF_WEAPONS,
  getWeapon, isWeapon, rollWeapon, rollCandidates, usesFor,
  Firework, OilSlick, WaterBalloon, ElectroPulse, BallBearing,
  Bomb, ClonePickup, Shockwave, Turbo, Shield,
} from './weapons/index.js';

export { default as RaceSystemDefault } from './RaceSystem.js';
export { default as PickupSystemDefault } from './PickupSystem.js';
