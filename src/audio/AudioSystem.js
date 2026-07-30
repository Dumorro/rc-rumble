/* SCAFFOLD — owned by the Audio agent. Replace with the real implementation. */
export class AudioSystem {
  constructor(game) { this.game = game; this.ready = false; }
  async init() {}
  onRaceStart() {}
  onRaceEnd() {}
  /** Must be called from a user gesture to unlock WebAudio. */
  async unlock() {}
  update() {}
  dispose() {}
}
export default AudioSystem;
