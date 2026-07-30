/* SCAFFOLD — owned by the Tracks agent. Replace with the real implementation.
 * Must return a TrackData object (ARCHITECTURE.md → TrackData). */
import * as THREE from 'three';

export class TrackSystem {
  constructor(game) { this.game = game; this.current = null; }
  async init() {}
  /** @returns {Promise<import('./types.js').TrackData>} */
  async load(id) {
    const scene = new THREE.Group();
    scene.name = `track:${id}`;
    this.current = {
      id, name: id, scene,
      collision: null, surfaces: null, spline: null,
      checkpoints: [], startGrid: [{ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }],
      respawns: [], pickupPads: [], aiPath: { nodes: [] }, shortcuts: [], props: [],
      environment: { bounds: new THREE.Box3(new THREE.Vector3(-50, -5, -50), new THREE.Vector3(50, 30, 50)), scale: 10 },
      audio: {},
    };
    return this.current;
  }
  unload() { this.current = null; }
  listTracks() { return []; }
  update() {}
  dispose() {}
}
export default TrackSystem;
