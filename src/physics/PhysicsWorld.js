/* SCAFFOLD — owned by the Physics agent. Replace with the real implementation.
 * Contract: see ARCHITECTURE.md → System interface + RigidBody. */
export class PhysicsWorld {
  constructor(game) { this.game = game; this.bodies = []; this.track = null; }
  async init() {}
  setTrack(track) { this.track = track; }
  addBody(b) { this.bodies.push(b); return b; }
  removeBody(b) { const i = this.bodies.indexOf(b); if (i >= 0) this.bodies.splice(i, 1); }
  /** @returns {{hit:boolean, point:THREE.Vector3, normal:THREE.Vector3, distance:number, surfaceId:number}|null} */
  raycast(/* origin, dir, maxDist, out */) { return null; }
  fixedUpdate(/* dt */) {}
  clear() { this.bodies.length = 0; this.track = null; }
  dispose() { this.clear(); }
}
export default PhysicsWorld;
