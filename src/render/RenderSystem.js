/* SCAFFOLD — owned by the Render agent. Replace with the real implementation.
 * Minimal-but-working so the app always boots to something. */
import * as THREE from 'three';
import CONFIG, { q } from '../core/Config.js';

export class RenderSystem {
  constructor(game) { this.game = game; this.renderer = null; }

  async init() {
    const renderer = new THREE.WebGLRenderer({
      antialias: true, powerPreference: 'high-performance', stencil: false,
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, q(CONFIG.render.maxPixelRatio)));
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CONFIG.render.exposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.game.container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.game.assets.maxAnisotropy = Math.min(
      renderer.capabilities.getMaxAnisotropy(), q(CONFIG.render.anisotropy));

    this.game.scene.background = new THREE.Color(0x0a1020);
    const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x2a2418, 1.0);
    this.game.scene.add(hemi);

    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.game.camera.aspect = w / h;
    this.game.camera.updateProjectionMatrix();
  }

  render() { this.renderer.render(this.game.scene, this.game.camera); }

  dispose() {
    removeEventListener('resize', this._onResize);
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }
}
export default RenderSystem;
