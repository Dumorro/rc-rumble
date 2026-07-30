/**
 * src/audio/index.js — public surface of the audio system.
 *
 * `game.audio` is an {@link AudioSystem}. Everything else here is exported for
 * tooling / debugging; other systems should go through `game.audio` or the
 * EventBus, never reach into these directly.
 */

export { AudioSystem, default } from './AudioSystem.js';
export { EngineSynth, TIER_NEAR, TIER_MID, TIER_CULL } from './EngineSynth.js';
export { TireAudio, SURFACE_VOICES, surfaceVoice } from './TireAudio.js';
export {
  SFXSynth, RECIPES, LOOPS, AMBIENCE,
  impactRecipe, landRecipe, weaponFamily, resolveAmbience,
} from './SFXSynth.js';
export { MusicSystem } from './MusicSystem.js';
export { Reverb, REVERB_PRESETS, renderImpulseResponse, resolveReverbName } from './Reverb.js';
export { Listener, WATER_SURFACE_ID } from './Listener.js';
export { VoicePool, Voice, LoopHandle } from './VoicePool.js';
export * as DSP from './DSP.js';
