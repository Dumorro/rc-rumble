import * as THREE from 'three';
import CONFIG, { q } from './Config.js';

/**
 * Procedural asset registry.
 *
 * NOTHING is loaded from disk or network — every texture, material and geometry
 * is generated in code and cached by key. Generators are registered lazily so a
 * texture is only ever built once, on first use.
 *
 *   assets.texture('wood/oak', (ctx, size) => { ... })      // canvas painter
 *   assets.material('museum/floor', () => new THREE.MeshStandardMaterial(...))
 *   assets.geometry('prop/dice', () => new THREE.BoxGeometry(...))
 */
export class Assets {
  constructor(game) {
    this.game = game;
    this._textures = new Map();
    this._materials = new Map();
    this._geometries = new Map();
    this._misc = new Map();
    this.anisotropy = q(CONFIG.render.anisotropy);
    /** Set by the renderer once it exists so textures get the right colour space. */
    this.maxAnisotropy = this.anisotropy;
  }

  async init() {}

  /**
   * Build (or fetch) a texture from a canvas painter.
   * @param {string} key
   * @param {(ctx:CanvasRenderingContext2D, size:number)=>void} painter
   * @param {{size?:number, srgb?:boolean, repeat?:[number,number], wrap?:number,
   *          mipmaps?:boolean, flipY?:boolean}} [opts]
   * @returns {THREE.CanvasTexture}
   */
  texture(key, painter, opts = {}) {
    const cached = this._textures.get(key);
    if (cached) return cached;

    const size = opts.size ?? 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    painter(ctx, size);

    const tex = new THREE.CanvasTexture(canvas);
    tex.name = key;
    tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = opts.wrap ?? THREE.RepeatWrapping;
    if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
    tex.anisotropy = this.maxAnisotropy;
    tex.generateMipmaps = opts.mipmaps !== false;
    tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    if (opts.flipY === false) tex.flipY = false;
    tex.needsUpdate = true;

    this._textures.set(key, tex);
    return tex;
  }

  /** Register an already-built texture (e.g. a DataTexture) under a key. */
  putTexture(key, tex) {
    tex.name ||= key;
    tex.anisotropy = this.maxAnisotropy;
    this._textures.set(key, tex);
    return tex;
  }

  getTexture(key) { return this._textures.get(key); }

  /** @param {string} key @param {()=>THREE.Material} factory */
  material(key, factory) {
    let m = this._materials.get(key);
    if (!m) { m = factory(); m.name ||= key; this._materials.set(key, m); }
    return m;
  }

  /** @param {string} key @param {()=>THREE.BufferGeometry} factory */
  geometry(key, factory) {
    let g = this._geometries.get(key);
    if (!g) { g = factory(); g.name ||= key; this._geometries.set(key, g); }
    return g;
  }

  /** Generic memoized value (curves, LUTs, audio buffers…). */
  memo(key, factory) {
    let v = this._misc.get(key);
    if (v === undefined) { v = factory(); this._misc.set(key, v); }
    return v;
  }

  has(key) {
    return this._textures.has(key) || this._materials.has(key)
      || this._geometries.has(key) || this._misc.has(key);
  }

  stats() {
    return {
      textures: this._textures.size,
      materials: this._materials.size,
      geometries: this._geometries.size,
      misc: this._misc.size,
    };
  }

  dispose() {
    for (const t of this._textures.values()) t.dispose?.();
    for (const m of this._materials.values()) m.dispose?.();
    for (const g of this._geometries.values()) g.dispose?.();
    this._textures.clear(); this._materials.clear();
    this._geometries.clear(); this._misc.clear();
  }
}

export default Assets;
