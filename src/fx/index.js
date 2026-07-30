/**
 * RC RUMBLE — FX public surface.
 *
 * Other systems should import from here rather than reaching into individual
 * files, and in almost every case should just use `game.fx`.
 *
 *   import { FXSystem } from '../fx/index.js';
 *   game.fx.burst('explosion', point, { strength: 1.2 });
 */

export { FXSystem, Emitter, WEAPON_FX } from './FXSystem.js';
export {
  ParticleSystem, LAYER, LAYER_SHARE,
  toLinearRGB, frand, frandRange, fxReseed, fastSin, fastCos,
  makeCurve, evalCurve,
} from './ParticleSystem.js';
export {
  particleAtlas, hazeNoiseTexture, SPR, SPR_FRAMES, spriteVariants,
  ATLAS_COLS, ATLAS_ROWS, ATLAS_TILES,
} from './ParticleAtlas.js';
export { TireMarks } from './TireMarks.js';
export { Decals, DECAL } from './Decals.js';
export { Sparks, resetOpts } from './Sparks.js';
export { Dust } from './Dust.js';
export { Splash } from './Splash.js';
export { Smoke } from './Smoke.js';
export { Impacts } from './Impacts.js';
export { Nitro } from './Nitro.js';
export { Weather, MOTE_PRESETS } from './Weather.js';
export {
  SURFACE_FX, surfaceFX, MARK, SPRAY, CHASSIS_FX, chassisFX,
  isWater, isIce, isOil, isMetal, looseness,
} from './SurfaceFX.js';

export { default } from './FXSystem.js';
