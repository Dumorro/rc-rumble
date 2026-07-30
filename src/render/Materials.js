/**
 * RC RUMBLE — material factory.
 *
 * One place that turns the procedural texture catalogue into correctly
 * configured three.js materials:
 *
 *   const M = getMaterials(game);
 *   floor.material = M.get('wood/parquet', { sizeMeters: 12 });
 *   pad.material   = M.forSurface(13, { sizeMeters: 0.6 });
 *   car.material   = M.carPaint({ color: 0xd01010, flake: 0.7 });
 *
 * Two things make the world look expensive here:
 *
 * 1. **Constant texel density.** Every catalogue entry declares the number of
 *    metres one texture tile covers (`physicalSize`). `get(name,{sizeMeters})`
 *    divides through, so a 12 m museum floor and a 0.4 m skirting board show
 *    the same grain size. Mismatched texel density is the single biggest
 *    give-away of amateur 3D.
 * 2. **The right shading model per substance.** Clearcoat for car paint,
 *    varnished wood and glazed tile; transmission for glass, water and
 *    translucent toy plastic; sheen for carpet and cloth; iridescence for
 *    soap bubbles and oil slicks.
 *
 * Textures are cloned (never re-generated) per repeat variant — clones share
 * the same GPU upload, so this is free.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp01, lerp } from '../core/MathUtils.js';
import * as PT from './ProceduralTextures.js';

/**
 * Canonical surface id → default catalogue entry.
 * Ids are frozen by ARCHITECTURE.md; do not renumber.
 */
export const SURFACE_MATERIAL = Object.freeze({
  0: 'concrete/screed',
  1: 'wood/parquet',
  2: 'carpet/loop_pile',
  3: 'tile/ceramic_glazed',
  4: 'concrete/poured',
  5: 'grass/lawn',
  6: 'dirt/ground',
  7: 'gravel/bed',
  8: 'sand/beach',
  9: 'water/shallow',
  10: 'ice/cracked',
  11: 'metal/brushed_alu',
  12: 'plastic/abs_matte',
  13: 'rubber/floor_mat',
  14: 'glass/clear',
  15: 'hazard/oil_slick',
});

/**
 * Reverse index: catalogue entry → canonical surface id. Track builders use
 * this to stamp the right surface id onto collision triangles from whatever
 * material they picked for the visual mesh.
 * @param {string} name
 * @returns {number}
 */
let _surfaceOf = null;
export function surfaceIdOf(name) {
  if (!_surfaceOf) {
    _surfaceOf = new Map();
    for (const [k, v] of Object.entries(PT.TEXTURE_DEFS)) _surfaceOf.set(k, v.surfaceId ?? 0);
  }
  return _surfaceOf.get(name) ?? 0;
}

const _shaderChunkWater = /* glsl */`
#ifdef USE_NORMALMAP_TANGENTSPACE

	vec3 mapNA = texture2D( normalMap, vNormalMapUv + uWaterOffsetA ).xyz * 2.0 - 1.0;
	vec3 mapNB = texture2D( uWaterNormalB, vNormalMapUv * uWaterScaleB + uWaterOffsetB ).xyz * 2.0 - 1.0;
	// Whiteout blend of the two wave layers.
	vec3 mapN = normalize( vec3( mapNA.xy + mapNB.xy * uWaterBlend, mapNA.z * mapNB.z ) );
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );

#else

	#include <normal_fragment_maps>

#endif
`;

const _waterUniformDecl = /* glsl */`
uniform sampler2D uWaterNormalB;
uniform vec2 uWaterOffsetA;
uniform vec2 uWaterOffsetB;
uniform float uWaterScaleB;
uniform float uWaterBlend;
`;

/** Round a repeat value so tiny float differences don't fork the cache. */
const quant = (v) => Math.round(v * 1000) / 1000;

export class MaterialLibrary {
  /**
   * @param {import('../core/Assets.js').Assets} assets
   * @param {{envMapIntensity?:number, shadowSide?:boolean}} [opts]
   */
  constructor(assets, opts = {}) {
    this.assets = assets;
    /** @type {Map<string, THREE.Material>} */
    this._mats = new Map();
    /** @type {Map<string, THREE.Texture>} */
    this._clones = new Map();
    /** @type {THREE.Material[]} materials that animate */
    this._animated = [];
    this.envMapIntensity = opts.envMapIntensity ?? 1.0;
    this.envMap = null;
    /** Global normal-map strength multiplier (quality knob). */
    this.normalScale = opts.normalScale ?? 1.0;
    /** Set false on low-end hardware to drop transmission/clearcoat. */
    this.allowPhysical = opts.allowPhysical ?? (CONFIG.quality !== 'low');
    this._lastTime = 0;
    this._externallyDriven = false;
  }

  // ──────────────────────────────────────────────────────── texture plumbing

  /**
   * A repeat/rotation variant of a base texture. Clones share the source, so
   * this costs no extra VRAM.
   */
  _tex(tex, rx, ry, rot = 0, offset = null) {
    if (!tex) return null;
    if (rx === 1 && ry === 1 && !rot && !offset) return tex;
    const key = `${tex.name}#${rx}x${ry}@${rot}${offset ? `+${offset[0]},${offset[1]}` : ''}`;
    let t = this._clones.get(key);
    if (!t) {
      t = tex.clone();
      t.name = key;
      t.repeat.set(rx, ry);
      if (rot) { t.center.set(0.5, 0.5); t.rotation = rot; }
      if (offset) t.offset.set(offset[0], offset[1]);
      this._clones.set(key, t);
    }
    return t;
  }

  /** Resolve the repeat for a material request. */
  _repeat(def, o) {
    if (o.repeat != null) {
      if (Array.isArray(o.repeat)) return [quant(o.repeat[0]), quant(o.repeat[1])];
      return [quant(o.repeat), quant(o.repeat)];
    }
    const phys = Math.max(1e-4, o.physicalSize ?? def?.physicalSize ?? 1);
    if (o.sizeMeters != null) {
      if (Array.isArray(o.sizeMeters)) {
        return [quant(Math.max(0.01, o.sizeMeters[0] / phys)), quant(Math.max(0.01, o.sizeMeters[1] / phys))];
      }
      const r = quant(Math.max(0.01, o.sizeMeters / phys));
      return [r, r];
    }
    return [1, 1];
  }

  // ──────────────────────────────────────────────────────── main entry point

  /**
   * Get (or build) a material for a catalogue entry.
   *
   * @param {string} name catalogue key, e.g. `'wood/parquet'`
   * @param {object} [o]
   * @param {number|[number,number]} [o.sizeMeters] world size the material covers —
   *        sets the texture repeat so texel density stays constant
   * @param {number|[number,number]} [o.repeat] explicit repeat (overrides sizeMeters)
   * @param {number} [o.rotation] UV rotation in radians
   * @param {number} [o.color] multiplicative tint applied by the shader (cheap)
   * @param {number} [o.tint] multiplicative tint baked into the texture (forks the bake)
   * @param {number} [o.recolor] hue-replacing recolour baked into the texture
   * @param {number} [o.roughness] scales the roughness map
   * @param {number} [o.metalness] overrides metalness for non-metal-mapped sets
   * @param {number} [o.normalScale]
   * @param {number} [o.aoIntensity]
   * @param {boolean} [o.vertexColors]
   * @param {boolean} [o.flatShading]
   * @param {boolean} [o.transparent]
   * @param {number} [o.opacity]
   * @param {number} [o.alphaTest]
   * @param {boolean} [o.doubleSide]
   * @param {number} [o.emissive] emissive colour
   * @param {number} [o.emissiveIntensity]
   * @param {number} [o.envMapIntensity]
   * @param {number} [o.clearcoat] force clearcoat on/off
   * @param {number} [o.sheen]
   * @param {number} [o.transmission]
   * @param {number} [o.iridescence]
   * @param {number} [o.seed] re-roll the procedural detail
   * @param {number} [o.texSize] override the texture resolution
   * @param {object} [o.params] per-family painter params (colour, letter, face…)
   * @param {string} [o.variant] extra cache-key discriminator
   * @param {boolean} [o.depthWrite]
   * @param {boolean} [o.fog]
   * @returns {THREE.MeshStandardMaterial|THREE.MeshPhysicalMaterial}
   */
  get(name, o = {}) {
    const key = this._key(name, o);
    let m = this._mats.get(key);
    if (m) return m;
    try {
      m = this._build(name, o, key);
    } catch (err) {
      console.warn('[Materials] build failed for', name, err);
      m = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8, metalness: 0 });
      m.name = `${name}!fallback`;
    }
    this._mats.set(key, m);
    return m;
  }

  /** Alias kept for readability at call sites that talk about physical size. */
  materialFor(name, o = {}) { return this.get(name, o); }

  /**
   * Material for a canonical surface id (see ARCHITECTURE.md). Tracks can call
   * this straight from their surface table.
   * @param {number} surfaceId
   * @param {object} [o] same options as {@link get}, plus `{ name }` to pick a
   *        specific variant within the family
   */
  forSurface(surfaceId, o = {}) {
    const name = o.name ?? SURFACE_MATERIAL[surfaceId] ?? SURFACE_MATERIAL[0];
    return this.get(name, o);
  }

  /** All catalogue names that map to a surface id. */
  namesForSurface(surfaceId) {
    return Object.entries(PT.TEXTURE_DEFS)
      .filter(([, d]) => d.surfaceId === surfaceId)
      .map(([k]) => k);
  }

  _key(name, o) {
    let k = name;
    const parts = [];
    if (o.sizeMeters != null) parts.push(`s${Array.isArray(o.sizeMeters) ? o.sizeMeters.join('x') : o.sizeMeters}`);
    if (o.repeat != null) parts.push(`r${Array.isArray(o.repeat) ? o.repeat.join('x') : o.repeat}`);
    if (o.physicalSize != null) parts.push(`p${o.physicalSize}`);
    if (o.rotation) parts.push(`rot${quant(o.rotation)}`);
    if (o.color != null) parts.push(`c${(o.color >>> 0).toString(16)}`);
    if (o.tint != null) parts.push(`t${(o.tint >>> 0).toString(16)}`);
    if (o.recolor != null) parts.push(`rc${(o.recolor >>> 0).toString(16)}`);
    if (o.roughness != null) parts.push(`ro${o.roughness}`);
    if (o.metalness != null) parts.push(`me${o.metalness}`);
    if (o.normalScale != null) parts.push(`ns${o.normalScale}`);
    if (o.aoIntensity != null) parts.push(`ao${o.aoIntensity}`);
    if (o.vertexColors) parts.push('vc');
    if (o.flatShading) parts.push('fs');
    if (o.transparent) parts.push('tr');
    if (o.opacity != null) parts.push(`op${o.opacity}`);
    if (o.alphaTest != null) parts.push(`at${o.alphaTest}`);
    if (o.doubleSide) parts.push('ds');
    if (o.emissive != null) parts.push(`em${(o.emissive >>> 0).toString(16)}:${o.emissiveIntensity ?? 1}`);
    if (o.envMapIntensity != null) parts.push(`ei${o.envMapIntensity}`);
    if (o.clearcoat != null) parts.push(`cc${o.clearcoat}`);
    if (o.sheen != null) parts.push(`sh${o.sheen}`);
    if (o.transmission != null) parts.push(`tm${o.transmission}`);
    if (o.iridescence != null) parts.push(`ir${o.iridescence}`);
    if (o.seed != null) parts.push(`sd${o.seed}`);
    if (o.texSize != null) parts.push(`tx${o.texSize}`);
    if (o.depthWrite === false) parts.push('ndw');
    if (o.fog === false) parts.push('nfog');
    if (o.variant) parts.push(o.variant);
    if (o.params) {
      const pk = Object.keys(o.params).sort().map((x) => `${x}=${o.params[x]}`).join(',');
      if (pk) parts.push(`{${pk}}`);
    }
    return parts.length ? `${k}|${parts.join('|')}` : k;
  }

  _build(name, o, key) {
    const set = PT.textureSet(this.assets, name, {
      size: o.texSize, seed: o.seed, tint: o.tint, recolor: o.recolor,
      params: o.params, variant: o.variant,
    });
    const def = set?.def ?? PT.TEXTURE_DEFS[name] ?? {};
    const hint = def.material ?? {};
    const [rx, ry] = this._repeat(def, o);
    const rot = o.rotation ?? 0;

    const nScale = (o.normalScale ?? 1) * this.normalScale;
    const p = {
      map: this._tex(set.map, rx, ry, rot),
      normalMap: this._tex(set.normalMap, rx, ry, rot),
      roughnessMap: this._tex(set.ormMap, rx, ry, rot),
      aoMap: this._tex(set.ormMap, rx, ry, rot),
      roughness: o.roughness ?? hint.roughness ?? 1,
      metalness: 0,
      envMapIntensity: o.envMapIntensity ?? hint.envMapIntensity ?? this.envMapIntensity,
      dithering: true,
    };
    if (set.emissiveMap) p.emissiveMap = this._tex(set.emissiveMap, rx, ry, rot);

    // Metalness comes from the packed ORM blue channel when the family varies
    // it; otherwise it's a constant so a flat 0 in the map doesn't kill it.
    if (set.hasMetal) {
      p.metalnessMap = this._tex(set.ormMap, rx, ry, rot);
      p.metalness = o.metalness ?? 1;
    } else {
      p.metalness = o.metalness ?? hint.metalness ?? 0;
    }

    // Decide on the shading model.
    const wantClearcoat = (o.clearcoat ?? hint.clearcoat ?? 0) > 0;
    const wantTransmission = (o.transmission ?? hint.transmission ?? 0) > 0;
    const wantSheen = (o.sheen ?? hint.sheen ?? 0) > 0;
    const wantIridescence = (o.iridescence ?? hint.iridescence ?? 0) > 0;
    const physical = this.allowPhysical &&
      (hint.kind === 'physical' || wantClearcoat || wantTransmission || wantSheen || wantIridescence);

    /** @type {THREE.MeshStandardMaterial} */
    const mat = physical ? new THREE.MeshPhysicalMaterial(p) : new THREE.MeshStandardMaterial(p);
    mat.name = key;
    mat.normalScale.set(nScale, nScale);
    mat.aoMapIntensity = o.aoIntensity ?? hint.aoIntensity ?? 1;

    if (o.color != null) mat.color.setHex(o.color);
    if (o.vertexColors) mat.vertexColors = true;
    if (o.flatShading) mat.flatShading = true;
    if (o.fog === false) mat.fog = false;
    if (o.depthWrite === false) mat.depthWrite = false;

    if (o.emissive != null) {
      mat.emissive.setHex(o.emissive);
      mat.emissiveIntensity = o.emissiveIntensity ?? 1;
    } else if (hint.emissive != null) {
      mat.emissive.setHex(hint.emissive);
      mat.emissiveIntensity = hint.emissiveIntensity ?? 1;
    }

    if (physical) {
      if (wantClearcoat) {
        mat.clearcoat = o.clearcoat ?? hint.clearcoat;
        mat.clearcoatRoughness = o.clearcoatRoughness ?? hint.clearcoatRoughness ?? 0.15;
      }
      if (wantSheen) {
        mat.sheen = o.sheen ?? hint.sheen;
        mat.sheenRoughness = o.sheenRoughness ?? hint.sheenRoughness ?? 0.8;
        mat.sheenColor.setHex(o.sheenColor ?? hint.sheenColor ?? 0xffffff);
      }
      if (wantIridescence) {
        mat.iridescence = o.iridescence ?? hint.iridescence;
        mat.iridescenceIOR = o.iridescenceIOR ?? hint.iridescenceIOR ?? 1.5;
        const rangeSrc = o.iridescenceThicknessRange ?? hint.iridescenceThicknessRange;
        if (rangeSrc) mat.iridescenceThicknessRange = [rangeSrc[0], rangeSrc[1]];
      }
      if (wantTransmission) {
        mat.transmission = o.transmission ?? hint.transmission;
        mat.thickness = o.thickness ?? hint.thickness ?? 0.1;
        mat.ior = o.ior ?? hint.ior ?? 1.5;
        if (hint.attenuationColor != null) mat.attenuationColor.setHex(hint.attenuationColor);
        if (hint.attenuationDistance != null) mat.attenuationDistance = hint.attenuationDistance;
        // Transmission renders through the transmissive pass; keeping it out of
        // the transparent queue avoids paying for it twice.
        mat.transparent = o.transparent ?? (set.hasAlpha === true);
      }
      if (hint.specularIntensity != null) mat.specularIntensity = hint.specularIntensity;
      if (hint.specularColor != null) mat.specularColor.setHex(hint.specularColor);
      if (hint.anisotropy != null) {
        mat.anisotropy = hint.anisotropy;
        mat.anisotropyRotation = hint.anisotropyRotation ?? 0;
      }
    }

    // Transparency (alpha baked into the base colour map).
    const transparent = o.transparent ?? (set.hasAlpha || hint.transparent) ?? false;
    if (transparent && !wantTransmission) mat.transparent = true;
    if (o.opacity != null) { mat.opacity = o.opacity; if (o.opacity < 1) mat.transparent = true; }
    else if (hint.opacity != null) mat.opacity = hint.opacity;
    if (o.alphaTest != null) mat.alphaTest = o.alphaTest;

    if (o.doubleSide || hint.doubleSided) mat.side = THREE.DoubleSide;
    if (this.envMap) mat.envMap = this.envMap;

    // Animated families.
    if (hint.animated === 'water' && physical) this._makeWater(mat, rx, ry);

    return mat;
  }

  // ──────────────────────────────────────────────────────── animated water

  /**
   * Patch a material so it samples TWO scrolling wave normal maps and blends
   * them. This is what stops water reading as a static bumpy plane.
   */
  _makeWater(mat, rx, ry) {
    const layers = PT.waterNormalLayers(this.assets);
    if (!layers?.normalB) return;

    const uniforms = {
      uWaterNormalB: { value: layers.normalB },
      uWaterOffsetA: { value: new THREE.Vector2(0, 0) },
      uWaterOffsetB: { value: new THREE.Vector2(0.37, 0.61) },
      uWaterScaleB: { value: layers.scaleB },
      uWaterBlend: { value: 0.75 },
    };
    mat.userData.water = {
      uniforms,
      speedA: layers.speedA,
      speedB: layers.speedB,
      // Scroll speed is in UV units per second, scaled so bigger surfaces
      // (higher repeat) don't look like they are flowing faster.
      scale: 1 / Math.max(0.25, Math.sqrt(rx * ry)),
    };

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = _waterUniformDecl + shader.fragmentShader;
      if (shader.fragmentShader.indexOf('#include <normal_fragment_maps>') >= 0) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_maps>', _shaderChunkWater);
      }
    };
    // Delegate to three's default key (the onBeforeCompile source) and just
    // prefix it, so if another system composes over onBeforeCompile — e.g. the
    // lighting system's cascaded-shadow patch — its variation still counts.
    mat.customProgramCacheKey = () => `rcr-water-2layer|${mat.onBeforeCompile.toString()}`;

    // Self-driving: the renderer calls this every frame, so the water moves
    // even if nobody remembers to call `materials.update(dt)`.
    mat.onBeforeRender = () => {
      if (this._externallyDriven) return;
      const now = (globalThis.performance?.now?.() ?? Date.now()) * 0.001;
      if (this._lastTime === 0) this._lastTime = now;
      const dt = Math.min(0.1, now - this._lastTime);
      this._lastTime = now;
      this._advance(dt);
    };

    this._animated.push(mat);
  }

  _advance(dt) {
    for (let i = 0; i < this._animated.length; i++) {
      const w = this._animated[i].userData.water;
      if (!w) continue;
      const k = dt * w.scale;
      const a = w.uniforms.uWaterOffsetA.value;
      const b = w.uniforms.uWaterOffsetB.value;
      a.x = (a.x + w.speedA[0] * k) % 1;
      a.y = (a.y + w.speedA[1] * k) % 1;
      b.x = (b.x + w.speedB[0] * k) % 1;
      b.y = (b.y + w.speedB[1] * k) % 1;
    }
  }

  /**
   * Advance animated materials. Optional — call it from a system update if you
   * want water to respect pause/slow-mo; otherwise it self-drives.
   * @param {number} dt seconds
   */
  update(dt) {
    this._externallyDriven = true;
    this._advance(Math.min(0.1, dt || 0));
  }

  // ──────────────────────────────────────────────────────── special materials

  /**
   * Two-layer automotive paint: metallic base + metal flake + clearcoat.
   *
   * @param {object} [o]
   * @param {number} [o.color] base colour
   * @param {number} [o.metallic] 0 = solid colour, 1 = full metallic
   * @param {number} [o.flake] 0..1 sparkle amount
   * @param {number} [o.clearcoat]
   * @param {number} [o.roughness]
   * @param {number} [o.flakeRepeat] how tightly the flake map tiles
   * @param {boolean} [o.pearl] add an iridescent pearl shift
   * @returns {THREE.MeshPhysicalMaterial|THREE.MeshStandardMaterial}
   */
  carPaint(o = {}) {
    const color = o.color ?? 0xd0201c;
    const metallic = clamp01(o.metallic ?? 0.85);
    const flake = clamp01(o.flake ?? 0.6);
    const clearcoat = o.clearcoat ?? 1.0;
    const roughness = o.roughness ?? lerp(0.42, 0.24, metallic);
    const flakeRepeat = o.flakeRepeat ?? 26;
    const key = `carpaint|${(color >>> 0).toString(16)}|${metallic}|${flake}|${clearcoat}|${roughness}|${o.pearl ? 'p' : ''}`;
    const cached = this._mats.get(key);
    if (cached) return cached;

    if (!this.allowPhysical) {
      const simple = new THREE.MeshStandardMaterial({
        color, roughness: roughness * 0.9, metalness: metallic * 0.8,
        envMapIntensity: this.envMapIntensity * 1.2,
      });
      simple.name = key;
      this._mats.set(key, simple);
      return simple;
    }

    const mat = new THREE.MeshPhysicalMaterial({
      color,
      roughness,
      metalness: lerp(0.05, 0.95, metallic),
      clearcoat,
      clearcoatRoughness: o.clearcoatRoughness ?? 0.045,
      envMapIntensity: (o.envMapIntensity ?? this.envMapIntensity) * 1.35,
      dithering: true,
      sheen: 0,
    });
    mat.name = key;

    if (flake > 0.01) {
      const nrm = PT.flakeNormalMap(this.assets, { density: 0.35 + flake * 0.65 });
      mat.normalMap = this._tex(nrm, flakeRepeat, flakeRepeat, 0);
      const s = 0.10 + flake * 0.45;
      mat.normalScale.set(s, s);
      // Clearcoat stays glassy on top of the sparkly base.
      mat.clearcoatNormalScale = new THREE.Vector2(0.05, 0.05);
    }
    if (o.pearl) {
      mat.iridescence = 0.55;
      mat.iridescenceIOR = 1.35;
      mat.iridescenceThicknessRange = [220, 560];
    }
    if (this.envMap) mat.envMap = this.envMap;

    this._mats.set(key, mat);
    return mat;
  }

  /**
   * Unlit-looking emissive material for lamps, LEDs, neon and pickup glows.
   * @param {number} color
   * @param {number} [intensity]
   * @param {object} [o] `{ toneMapped, transparent, opacity, base }`
   */
  emissive(color = 0xffffff, intensity = 2.0, o = {}) {
    const key = `emissive|${(color >>> 0).toString(16)}|${intensity}|${o.base ?? 0}|${o.opacity ?? 1}|${o.toneMapped === false ? 'nt' : ''}`;
    const cached = this._mats.get(key);
    if (cached) return cached;
    const mat = new THREE.MeshStandardMaterial({
      color: o.base ?? 0x0a0a0a,
      emissive: color,
      emissiveIntensity: intensity,
      roughness: 0.4,
      metalness: 0,
      toneMapped: o.toneMapped !== false,
      transparent: o.opacity != null && o.opacity < 1,
      opacity: o.opacity ?? 1,
      fog: o.fog !== false,
    });
    mat.name = key;
    this._mats.set(key, mat);
    return mat;
  }

  /**
   * Decal / sticker / signage material. Lays flat on a surface without
   * z-fighting and can be lit or unlit.
   *
   * @param {object} o
   * @param {THREE.Texture} [o.texture] pre-made texture (from `textTexture`,
   *        `logoTexture`, `signTexture` or `decalTexture`)
   * @param {string|string[]} [o.text] shortcut: build a text texture
   * @param {string} [o.logo] shortcut: build a sponsor badge
   * @param {string} [o.key] cache key when using the shortcuts
   * @param {boolean} [o.unlit] MeshBasic instead of MeshStandard
   * @param {number} [o.color] tint
   * @param {number} [o.opacity]
   * @param {number} [o.roughness]
   * @param {number} [o.offsetFactor] polygon offset factor (more negative = closer)
   * @param {boolean} [o.doubleSide]
   * @returns {THREE.Material}
   */
  decal(o = {}) {
    let tex = o.texture ?? null;
    const idPart = o.key ?? (o.text ? `t:${Array.isArray(o.text) ? o.text.join('/') : o.text}` : o.logo ? `l:${o.logo}` : 'plain');
    if (!tex && o.text != null) {
      tex = PT.textTexture(this.assets, `decal:${idPart}`, {
        text: o.text, width: o.width ?? 512, height: o.height ?? 256,
        color: o.textColor ?? '#ffffff', outline: o.outline ?? null,
        background: o.background ?? null, wear: o.wear ?? 0.25,
        font: o.font ?? 'vector', seed: o.seed,
      });
    } else if (!tex && o.logo != null) {
      tex = PT.logoTexture(this.assets, `decal:${idPart}`, {
        text: o.logo, shape: o.shape, background: o.badgeColor, color: o.textColor,
      });
    }

    const key = `decal|${idPart}|${o.unlit ? 'u' : 's'}|${(o.color ?? 0xffffff).toString(16)}|${o.opacity ?? 1}|${o.offsetFactor ?? -2}|${o.doubleSide ? 'ds' : ''}`;
    const cached = this._mats.get(key);
    if (cached) return cached;

    const common = {
      map: tex,
      transparent: true,
      opacity: o.opacity ?? 1,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: o.offsetFactor ?? -2,
      polygonOffsetUnits: o.offsetUnits ?? -2,
      side: o.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      alphaTest: o.alphaTest ?? 0.01,
      toneMapped: o.toneMapped !== false,
    };
    const mat = o.unlit
      ? new THREE.MeshBasicMaterial(common)
      : new THREE.MeshStandardMaterial({ ...common, roughness: o.roughness ?? 0.55, metalness: 0 });
    if (o.color != null) mat.color.setHex(o.color);
    mat.name = key;
    this._mats.set(key, mat);
    return mat;
  }

  /**
   * Flat vertex-coloured material — the cheap workhorse for procedural
   * geometry that carries its own colours (props, foliage cards, debris).
   */
  vertexColor(o = {}) {
    const key = `vcol|${o.roughness ?? 0.7}|${o.metalness ?? 0}|${o.flatShading ? 'f' : ''}|${o.transparent ? 't' : ''}`;
    const cached = this._mats.get(key);
    if (cached) return cached;
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: o.roughness ?? 0.7,
      metalness: o.metalness ?? 0,
      flatShading: !!o.flatShading,
      transparent: !!o.transparent,
      opacity: o.opacity ?? 1,
      side: o.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
      dithering: true,
    });
    mat.name = key;
    this._mats.set(key, mat);
    return mat;
  }

  /** Soap-bubble / holographic toy: thin-film iridescence over transmission. */
  bubble(o = {}) {
    const key = `bubble|${o.tint ?? 0xffffff}|${o.thickness ?? 1}`;
    const cached = this._mats.get(key);
    if (cached) return cached;
    const mat = this.allowPhysical
      ? new THREE.MeshPhysicalMaterial({
        color: o.tint ?? 0xffffff,
        roughness: 0.03,
        metalness: 0,
        transmission: 0.96,
        thickness: 0.02,
        ior: 1.05,
        iridescence: 1,
        iridescenceIOR: 1.32,
        iridescenceThicknessRange: [120, 780],
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        envMapIntensity: this.envMapIntensity * 1.5,
      })
      : new THREE.MeshStandardMaterial({
        color: o.tint ?? 0xbfe8ff, roughness: 0.05, metalness: 0.1,
        transparent: true, opacity: 0.35, side: THREE.DoubleSide,
      });
    mat.name = key;
    this._mats.set(key, mat);
    return mat;
  }

  // ──────────────────────────────────────────────────────── housekeeping

  /** Attach an explicit environment map to every material (present and future). */
  setEnvironment(envMap, intensity = this.envMapIntensity) {
    this.envMap = envMap ?? null;
    this.envMapIntensity = intensity;
    for (const m of this._mats.values()) {
      if ('envMap' in m) m.envMap = this.envMap;
      if ('envMapIntensity' in m) m.envMapIntensity = intensity;
      m.needsUpdate = true;
    }
  }

  /** Number of live materials / texture clones (debug overlay). */
  stats() {
    return { materials: this._mats.size, clones: this._clones.size, animated: this._animated.length };
  }

  dispose() {
    for (const m of this._mats.values()) m.dispose?.();
    for (const t of this._clones.values()) t.dispose?.();
    this._mats.clear();
    this._clones.clear();
    this._animated.length = 0;
  }
}

/**
 * The shared library for a game (or a bare `Assets`). Memoised on the asset
 * cache, so every system gets the same instance and materials are shared.
 *
 * @param {{assets:import('../core/Assets.js').Assets}|import('../core/Assets.js').Assets} gameOrAssets
 * @returns {MaterialLibrary}
 */
export function getMaterials(gameOrAssets) {
  const assets = gameOrAssets?.assets ?? gameOrAssets;
  if (!assets?.memo) return null;
  return assets.memo('render/materialLibrary', () => new MaterialLibrary(assets));
}

export default MaterialLibrary;
