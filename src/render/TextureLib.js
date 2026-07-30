/**
 * RC RUMBLE — texture catalogue index.
 *
 * A thin, dependency-free browsing layer over `ProceduralTextures.TEXTURE_DEFS`
 * so track builders can ask "what wood do I have?" or "give me everything
 * tagged `outdoor`" without knowing how any of it is generated.
 *
 *   import { CATALOGUE, byTag, preload, PRESETS } from './TextureLib.js';
 *
 *   for (const e of byTag('floor')) console.log(e.name, e.physicalSize);
 *   await preloadAsync(game.assets, PRESETS.toy_museum, (p, n) => bar(p, n));
 */

import * as PT from './ProceduralTextures.js';
import { SURFACE_MATERIAL } from './Materials.js';

/**
 * @typedef {object} CatalogueEntry
 * @property {string} name          catalogue key, e.g. 'wood/parquet'
 * @property {string} family        'wood' | 'carpet' | 'tile' | …
 * @property {number} surfaceId     canonical surface id (ARCHITECTURE.md)
 * @property {string[]} tags
 * @property {number} physicalSize  metres one texture tile covers
 * @property {number} res           resolution multiplier vs the quality base
 * @property {string} shading       'standard' | 'physical'
 * @property {boolean} animated
 * @property {boolean} transparent
 */

/** Every generated material family, as plain browsable data. */
export const CATALOGUE = Object.freeze(Object.entries(PT.TEXTURE_DEFS).map(([name, def]) => Object.freeze({
  name,
  family: def.family ?? 'misc',
  surfaceId: def.surfaceId ?? 0,
  tags: Object.freeze([...(def.tags ?? [])]),
  physicalSize: def.physicalSize ?? 1,
  res: def.res ?? 0.375,
  shading: def.material?.kind === 'physical' ? 'physical' : 'standard',
  animated: !!def.material?.animated,
  transparent: !!(def.material?.transparent || def.material?.transmission),
})));

const _byName = new Map(CATALOGUE.map((e) => [e.name, e]));

/** All catalogue names. */
export const NAMES = Object.freeze(CATALOGUE.map((e) => e.name));

/** Distinct family names, sorted. */
export const FAMILIES = Object.freeze([...new Set(CATALOGUE.map((e) => e.family))].sort());

/** Distinct tags, sorted. */
export const TAGS = Object.freeze([...new Set(CATALOGUE.flatMap((e) => e.tags))].sort());

/** @param {string} name @returns {CatalogueEntry|undefined} */
export function byName(name) { return _byName.get(name); }

/** @param {string} family @returns {CatalogueEntry[]} */
export function byFamily(family) { return CATALOGUE.filter((e) => e.family === family); }

/** @param {number} surfaceId @returns {CatalogueEntry[]} */
export function bySurface(surfaceId) { return CATALOGUE.filter((e) => e.surfaceId === surfaceId); }

/** @param {string} tag @returns {CatalogueEntry[]} */
export function byTag(tag) { return CATALOGUE.filter((e) => e.tags.includes(tag)); }

/** Entries matching every tag in the list. */
export function byTags(...tags) {
  return CATALOGUE.filter((e) => tags.every((t) => e.tags.includes(t)));
}

/** Loose substring search over name, family and tags. */
export function search(query) {
  const q = String(query ?? '').toLowerCase();
  if (!q) return [...CATALOGUE];
  return CATALOGUE.filter((e) =>
    e.name.toLowerCase().includes(q) ||
    e.family.includes(q) ||
    e.tags.some((t) => t.includes(q)));
}

/** Default catalogue entry for a canonical surface id. */
export function defaultForSurface(surfaceId) {
  return SURFACE_MATERIAL[surfaceId] ?? SURFACE_MATERIAL[0];
}

/** True if the name exists in the catalogue. */
export function exists(name) { return _byName.has(name); }

/**
 * Ready-made bundles per environment. Tracks preload one of these so the whole
 * level's textures are built during the loading screen instead of mid-race.
 */
export const PRESETS = Object.freeze({
  /** Toy museum: parquet, carpet, glass cases, brass fittings, toys. */
  toy_museum: Object.freeze([
    'wood/parquet', 'wood/oak_planks', 'wood/plywood_varnish', 'wood/mdf',
    'carpet/loop_pile', 'carpet/rug_woven',
    'tile/ceramic_glazed', 'tile/lino_check',
    'glass/clear', 'glass/frosted',
    'metal/brushed_alu', 'metal/chrome', 'metal/painted',
    'plastic/abs_matte', 'plastic/injection_gloss',
    'drywall/painted', 'wallpaper/striped',
    'toy/lego_studs', 'toy/board_game', 'toy/playing_card', 'toy/dice_pips',
    'toy/alphabet_block', 'cardboard/kraft', 'rubber/floor_mat',
  ]),
  /** Garden: grass, dirt, gravel, brick, water, sandpit. */
  garden: Object.freeze([
    'grass/lawn', 'dirt/ground', 'gravel/bed', 'sand/beach',
    'concrete/poured', 'concrete/rough', 'brick/red',
    'water/shallow', 'wood/pine_planks', 'metal/rust', 'metal/galvanised',
    'plastic/abs_matte', 'rubber/tyre_tread', 'road/tarmac',
  ]),
  /** Supermarket: lino, tile, cardboard, plastic, chrome shelving. */
  supermarket: Object.freeze([
    'tile/lino_check', 'tile/ceramic_glazed', 'concrete/screed',
    'cardboard/kraft', 'cardboard/corrugated',
    'metal/chrome', 'metal/brushed_alu', 'metal/diamond_plate',
    'plastic/abs_matte', 'plastic/injection_gloss', 'plastic/translucent',
    'glass/clear', 'rubber/floor_mat', 'paper/graph', 'drywall/painted',
  ]),
  /** Toy box / bedroom: everything bright and plastic. */
  toy_box: Object.freeze([
    'toy/lego_studs', 'toy/board_game', 'toy/playing_card', 'toy/dice_pips',
    'toy/alphabet_block', 'plastic/abs_matte', 'plastic/injection_gloss',
    'plastic/translucent', 'fabric/felt', 'fabric/denim', 'carpet/cut_pile',
    'wood/mdf', 'cardboard/kraft', 'rubber/floor_mat',
  ]),
  /** Freezer aisle / ice rink. */
  ice: Object.freeze([
    'ice/cracked', 'ice/frosted', 'tile/ceramic_glazed', 'metal/galvanised',
    'metal/brushed_alu', 'glass/frosted', 'concrete/screed', 'water/shallow',
  ]),
  /** The materials worth having no matter what the track is. */
  core: Object.freeze([
    'concrete/poured', 'wood/parquet', 'carpet/loop_pile', 'tile/ceramic_glazed',
    'grass/lawn', 'dirt/ground', 'gravel/bed', 'sand/beach', 'water/shallow',
    'ice/cracked', 'metal/brushed_alu', 'plastic/abs_matte', 'rubber/floor_mat',
    'glass/clear', 'hazard/oil_slick',
  ]),
});

/**
 * Build the PBR sets for a list of catalogue names, synchronously.
 * Unknown names are skipped with a warning rather than throwing.
 *
 * @param {import('../core/Assets.js').Assets} assets
 * @param {string[]|string} names
 * @param {(progress:number, name:string)=>void} [onProgress]
 * @returns {number} how many were built (or already cached)
 */
export function preload(assets, names, onProgress) {
  if (!assets) return 0;
  const list = Array.isArray(names) ? names : [names];
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    if (!_byName.has(name)) { console.warn('[TextureLib] unknown texture:', name); continue; }
    try {
      PT.textureSet(assets, name);
      done++;
    } catch (err) {
      console.warn('[TextureLib] preload failed for', name, err);
    }
    onProgress?.((i + 1) / list.length, name);
  }
  return done;
}

/**
 * Same as {@link preload} but yields to the event loop between families so a
 * loading bar can actually repaint. Use this from `init()`/`onRaceStart()`.
 *
 * @param {import('../core/Assets.js').Assets} assets
 * @param {string[]|string} names
 * @param {(progress:number, name:string)=>void} [onProgress]
 * @returns {Promise<number>}
 */
export async function preloadAsync(assets, names, onProgress) {
  if (!assets) return 0;
  const list = Array.isArray(names) ? names : [names];
  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    if (!_byName.has(name)) { console.warn('[TextureLib] unknown texture:', name); continue; }
    try {
      PT.textureSet(assets, name);
      done++;
    } catch (err) {
      console.warn('[TextureLib] preload failed for', name, err);
    }
    onProgress?.((i + 1) / list.length, name);
    // One frame (or microtask tick when there is no rAF) between families.
    await new Promise((r) => (globalThis.requestAnimationFrame
      ? requestAnimationFrame(() => r())
      : setTimeout(r, 0)));
  }
  return done;
}

/** Estimated VRAM in MB for a set of names at the current quality. */
export function estimateMemoryMB(names = NAMES) {
  let bytes = 0;
  for (const n of names) {
    const e = _byName.get(n);
    if (!e) continue;
    const s = PT.texSize(e.res);
    // base colour + normal + packed ORM, RGBA8, + ~33 % for mipmaps
    bytes += s * s * 4 * 3 * 1.34;
  }
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export default {
  CATALOGUE, NAMES, FAMILIES, TAGS, PRESETS,
  byName, byFamily, bySurface, byTag, byTags, search,
  defaultForSurface, exists, preload, preloadAsync, estimateMemoryMB,
};
