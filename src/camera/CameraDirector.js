/* SCAFFOLD — owned by the Camera agent. Replace with the real implementation. */
export class CameraDirector {
  constructor(game) { this.game = game; this.mode = 'chase'; }
  async init() {}
  onRaceStart() {}
  onRaceEnd() {}
  setMode(m) { this.mode = m; }
  shake() {}
  lateUpdate() {}
  dispose() {}
}
export default CameraDirector;
