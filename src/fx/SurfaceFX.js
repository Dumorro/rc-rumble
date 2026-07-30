/**
 * RC RUMBLE — canonical surface → FX descriptor table.
 *
 * The ids are frozen by ARCHITECTURE.md (0..15). Everything visual that reacts
 * to "what am I driving on" reads from here, so a tweak to (say) how dirt looks
 * lands in the tyre marks, the wheel spray, the tyre smoke, the landing puff and
 * the impact debris all at once.
 *
 * Colours are authored as sRGB hex and pre-converted to the renderer's linear
 * working space at module load, because that is what a shader wants and doing it
 * per particle would be daft.
 *
 * Rates are "particles per second at full slip on one wheel". The emitters scale
 * them by slip, load, speed and the global FX load governor.
 */

import * as THREE from 'three';

/** Mark rendering styles. */
export const MARK = Object.freeze({
  NONE: 0,
  /** Dark rubber laid on a hard surface — the classic Re-Volt skid. */
  RUBBER: 1,
  /** Material displaced out of a loose surface: lighter than the ground. */
  DISPLACED: 2,
  /** A pale scuff — carpet lint, ice scratch, dusty polish. */
  SCUFF: 3,
  /** Wet/greasy smear (oil, water film). */
  SMEAR: 4,
});

/** Wheel-spray archetypes. Each FX subsystem maps these onto its own styles. */
export const SPRAY = Object.freeze({
  NONE: 0,
  DUST: 1,      // fine airborne powder
  PLUME: 2,     // big billowing dirt cloud
  GRIT: 3,      // gravel: dust + bouncing stones
  SHEET: 4,     // sand: broad low sheets
  BLADES: 5,    // grass: clippings + blades
  SPRAY: 6,     // water: droplets + rooster tail
  CRYSTAL: 7,   // ice: sparkling shavings
  LINT: 8,      // carpet fibres
  SLICK: 9,     // oil droplets
});

const _c = new THREE.Color();
/** hex (sRGB) → frozen [r,g,b] in linear working space. */
function lin(hex) {
  _c.setHex(hex, THREE.SRGBColorSpace);
  return Object.freeze([_c.r, _c.g, _c.b]);
}

/**
 * @typedef {object} SurfaceFXDesc
 * @property {number} id
 * @property {string} name
 * @property {number} loose      0 = hard floor, 1 = deep loose material
 * @property {number} wet        0 = dry, 1 = standing water
 * @property {number} sparky     0..1 chance/intensity of sparks when scraped
 * @property {number} dustiness  0..1 general airborne-dust multiplier
 * @property {number} markStyle  MARK.*
 * @property {number[]} markColor      linear rgb
 * @property {number} markAlpha        peak alpha of a fresh mark
 * @property {number} markWidth        multiplier on the tyre width
 * @property {number} markSoft         0 = crisp edges, 1 = very feathered
 * @property {number} spray      SPRAY.*
 * @property {number[]} sprayColor
 * @property {number[]} sprayColor2    secondary/darker tint for variation
 * @property {number} sprayRate        particles/sec at full slip
 * @property {number} spraySize        metres
 * @property {number} spraySpeed       m/s ejection speed
 * @property {number} sprayLift        0..1 how much goes up vs backwards
 * @property {number} sprayLife        seconds
 * @property {number[]} smokeColor     tyre-smoke tint on this surface
 * @property {number} smokeRate        multiplier on burnout smoke
 * @property {number} chips            0..1 solid bouncing debris fraction
 * @property {number} rollDust         0..1 dust kicked up just by rolling fast
 * @property {number} splashy          0..1 how much a landing throws material up
 * @property {number} decal            0..1 how readable a decal is here
 */

/** @type {ReadonlyArray<SurfaceFXDesc>} */
export const SURFACE_FX = Object.freeze([
  // 0 — default / unknown
  Object.freeze({
    id: 0, name: 'default', loose: 0.05, wet: 0, sparky: 0.15, dustiness: 0.25,
    markStyle: MARK.RUBBER, markColor: lin(0x14100f), markAlpha: 0.42, markWidth: 1.0, markSoft: 0.35,
    spray: SPRAY.DUST, sprayColor: lin(0x9a958c), sprayColor2: lin(0x6f6a63),
    sprayRate: 42, spraySize: 0.055, spraySpeed: 1.5, sprayLift: 0.45, sprayLife: 0.7,
    smokeColor: lin(0xb8b2ab), smokeRate: 1.0, chips: 0.0, rollDust: 0.05,
    splashy: 0.25, decal: 1.0,
  }),
  // 1 — wood: museum parquet. Marks read beautifully on varnish.
  Object.freeze({
    id: 1, name: 'wood', loose: 0.0, wet: 0, sparky: 0.10, dustiness: 0.18,
    markStyle: MARK.RUBBER, markColor: lin(0x1a1210), markAlpha: 0.50, markWidth: 1.0, markSoft: 0.28,
    spray: SPRAY.DUST, sprayColor: lin(0xbfae95), sprayColor2: lin(0x8d7c68),
    sprayRate: 26, spraySize: 0.05, spraySpeed: 1.2, sprayLift: 0.55, sprayLife: 0.65,
    smokeColor: lin(0xcfc8c0), smokeRate: 1.15, chips: 0.0, rollDust: 0.04,
    splashy: 0.15, decal: 1.0,
  }),
  // 2 — carpet: muffled, lint instead of dust, marks are crushed pile not rubber.
  Object.freeze({
    id: 2, name: 'carpet', loose: 0.22, wet: 0, sparky: 0.0, dustiness: 0.35,
    markStyle: MARK.SCUFF, markColor: lin(0x2a2622), markAlpha: 0.30, markWidth: 1.25, markSoft: 0.75,
    spray: SPRAY.LINT, sprayColor: lin(0xc8bda8), sprayColor2: lin(0x8f8474),
    sprayRate: 30, spraySize: 0.035, spraySpeed: 1.1, sprayLift: 0.7, sprayLife: 1.1,
    smokeColor: lin(0xa9a29a), smokeRate: 0.55, chips: 0.10, rollDust: 0.10,
    splashy: 0.35, decal: 0.75,
  }),
  // 3 — tile: squeaky and shiny, tight crisp marks.
  Object.freeze({
    id: 3, name: 'tile', loose: 0.0, wet: 0.05, sparky: 0.18, dustiness: 0.12,
    markStyle: MARK.RUBBER, markColor: lin(0x191413), markAlpha: 0.55, markWidth: 0.95, markSoft: 0.20,
    spray: SPRAY.DUST, sprayColor: lin(0xd6d2cb), sprayColor2: lin(0x9d998f),
    sprayRate: 20, spraySize: 0.045, spraySpeed: 1.1, sprayLift: 0.5, sprayLife: 0.55,
    smokeColor: lin(0xd8d2cc), smokeRate: 1.25, chips: 0.0, rollDust: 0.03,
    splashy: 0.12, decal: 1.0,
  }),
  // 4 — concrete: rough, grey, chalky.
  Object.freeze({
    id: 4, name: 'concrete', loose: 0.06, wet: 0, sparky: 0.30, dustiness: 0.45,
    markStyle: MARK.RUBBER, markColor: lin(0x171514), markAlpha: 0.46, markWidth: 1.05, markSoft: 0.40,
    spray: SPRAY.DUST, sprayColor: lin(0xa8a49c), sprayColor2: lin(0x736f68),
    sprayRate: 52, spraySize: 0.065, spraySpeed: 1.7, sprayLift: 0.5, sprayLife: 0.85,
    smokeColor: lin(0xbfb9b2), smokeRate: 1.0, chips: 0.05, rollDust: 0.10,
    splashy: 0.30, decal: 1.0,
  }),
  // 5 — grass: blades, clippings, a green bruise on the turf.
  Object.freeze({
    id: 5, name: 'grass', loose: 0.55, wet: 0.15, sparky: 0.0, dustiness: 0.30,
    markStyle: MARK.DISPLACED, markColor: lin(0x3d4a20), markAlpha: 0.44, markWidth: 1.35, markSoft: 0.70,
    spray: SPRAY.BLADES, sprayColor: lin(0x6f9636), sprayColor2: lin(0x415c1d),
    sprayRate: 105, spraySize: 0.05, spraySpeed: 2.9, sprayLift: 0.62, sprayLife: 1.15,
    smokeColor: lin(0x8f9a72), smokeRate: 0.35, chips: 0.55, rollDust: 0.16,
    splashy: 0.75, decal: 0.55,
  }),
  // 6 — dirt: the signature big plume.
  Object.freeze({
    id: 6, name: 'dirt', loose: 0.80, wet: 0.05, sparky: 0.0, dustiness: 1.0,
    markStyle: MARK.DISPLACED, markColor: lin(0x6b4c2f), markAlpha: 0.52, markWidth: 1.45, markSoft: 0.65,
    spray: SPRAY.PLUME, sprayColor: lin(0xa9835a), sprayColor2: lin(0x6d5033),
    sprayRate: 150, spraySize: 0.10, spraySpeed: 2.6, sprayLift: 0.72, sprayLife: 1.6,
    smokeColor: lin(0xb59a7e), smokeRate: 0.45, chips: 0.25, rollDust: 0.35,
    splashy: 1.0, decal: 0.80,
  }),
  // 7 — gravel: rattly spray of stones.
  Object.freeze({
    id: 7, name: 'gravel', loose: 0.75, wet: 0, sparky: 0.20, dustiness: 0.70,
    markStyle: MARK.DISPLACED, markColor: lin(0x6d6a64), markAlpha: 0.40, markWidth: 1.40, markSoft: 0.72,
    spray: SPRAY.GRIT, sprayColor: lin(0x9c968c), sprayColor2: lin(0x625e58),
    sprayRate: 120, spraySize: 0.07, spraySpeed: 3.6, sprayLift: 0.55, sprayLife: 1.25,
    smokeColor: lin(0xa8a29a), smokeRate: 0.4, chips: 0.85, rollDust: 0.30,
    splashy: 0.90, decal: 0.5,
  }),
  // 8 — sand: heavy, low, broad sheets.
  Object.freeze({
    id: 8, name: 'sand', loose: 0.95, wet: 0.05, sparky: 0.0, dustiness: 0.85,
    markStyle: MARK.DISPLACED, markColor: lin(0xc4a878), markAlpha: 0.55, markWidth: 1.55, markSoft: 0.60,
    spray: SPRAY.SHEET, sprayColor: lin(0xe3cda0), sprayColor2: lin(0xa78d5f),
    sprayRate: 135, spraySize: 0.11, spraySpeed: 2.2, sprayLift: 0.5, sprayLife: 1.4,
    smokeColor: lin(0xd3bd96), smokeRate: 0.3, chips: 0.15, rollDust: 0.42,
    splashy: 1.0, decal: 0.70,
  }),
  // 9 — shallow water: no marks, everything is spray.
  Object.freeze({
    id: 9, name: 'water_shallow', loose: 0.10, wet: 1.0, sparky: 0.0, dustiness: 0.0,
    markStyle: MARK.NONE, markColor: lin(0x24313a), markAlpha: 0.0, markWidth: 1.0, markSoft: 1.0,
    spray: SPRAY.SPRAY, sprayColor: lin(0xdff0f7), sprayColor2: lin(0x9dc3d4),
    sprayRate: 190, spraySize: 0.045, spraySpeed: 4.2, sprayLift: 0.78, sprayLife: 0.95,
    smokeColor: lin(0xe6f2f7), smokeRate: 0.15, chips: 0.0, rollDust: 0.0,
    splashy: 1.0, decal: 0.4,
  }),
  // 10 — ice: near-zero grip, sparkling shavings, pale scratch.
  Object.freeze({
    id: 10, name: 'ice', loose: 0.20, wet: 0.35, sparky: 0.0, dustiness: 0.20,
    markStyle: MARK.SCUFF, markColor: lin(0xdff0ff), markAlpha: 0.34, markWidth: 1.15, markSoft: 0.55,
    spray: SPRAY.CRYSTAL, sprayColor: lin(0xf2fbff), sprayColor2: lin(0xbfe2f2),
    sprayRate: 80, spraySize: 0.035, spraySpeed: 3.0, sprayLift: 0.55, sprayLife: 0.85,
    smokeColor: lin(0xe8f6ff), smokeRate: 0.25, chips: 0.35, rollDust: 0.08,
    splashy: 0.55, decal: 0.6,
  }),
  // 11 — metal: sparks, ringing, dark marks.
  Object.freeze({
    id: 11, name: 'metal', loose: 0.0, wet: 0, sparky: 1.0, dustiness: 0.10,
    markStyle: MARK.RUBBER, markColor: lin(0x121110), markAlpha: 0.48, markWidth: 0.95, markSoft: 0.25,
    spray: SPRAY.DUST, sprayColor: lin(0xb9bcc0), sprayColor2: lin(0x7d8085),
    sprayRate: 18, spraySize: 0.04, spraySpeed: 1.4, sprayLift: 0.45, sprayLife: 0.5,
    smokeColor: lin(0xc6c2bd), smokeRate: 1.1, chips: 0.0, rollDust: 0.02,
    splashy: 0.10, decal: 0.9,
  }),
  // 12 — plastic: toy surfaces, slightly rubbery marks.
  Object.freeze({
    id: 12, name: 'plastic', loose: 0.0, wet: 0, sparky: 0.08, dustiness: 0.12,
    markStyle: MARK.RUBBER, markColor: lin(0x171518), markAlpha: 0.44, markWidth: 1.0, markSoft: 0.30,
    spray: SPRAY.DUST, sprayColor: lin(0xd0cdd4), sprayColor2: lin(0x95929a),
    sprayRate: 22, spraySize: 0.042, spraySpeed: 1.3, sprayLift: 0.5, sprayLife: 0.55,
    smokeColor: lin(0xd6d2d8), smokeRate: 1.2, chips: 0.0, rollDust: 0.03,
    splashy: 0.12, decal: 1.0,
  }),
  // 13 — rubber mats/ramps: grippiest thing on the track, blackest marks.
  Object.freeze({
    id: 13, name: 'rubber', loose: 0.0, wet: 0, sparky: 0.0, dustiness: 0.15,
    markStyle: MARK.RUBBER, markColor: lin(0x0d0c0c), markAlpha: 0.58, markWidth: 1.05, markSoft: 0.34,
    spray: SPRAY.DUST, sprayColor: lin(0x8a8785), sprayColor2: lin(0x5a5857),
    sprayRate: 24, spraySize: 0.045, spraySpeed: 1.2, sprayLift: 0.5, sprayLife: 0.6,
    smokeColor: lin(0x9e9a97), smokeRate: 1.4, chips: 0.0, rollDust: 0.03,
    splashy: 0.12, decal: 1.0,
  }),
  // 14 — glass: reflective, marks barely take.
  Object.freeze({
    id: 14, name: 'glass', loose: 0.0, wet: 0, sparky: 0.25, dustiness: 0.06,
    markStyle: MARK.SMEAR, markColor: lin(0x20242a), markAlpha: 0.22, markWidth: 0.9, markSoft: 0.5,
    spray: SPRAY.DUST, sprayColor: lin(0xe4f0f5), sprayColor2: lin(0xa9bcc4),
    sprayRate: 14, spraySize: 0.035, spraySpeed: 1.2, sprayLift: 0.45, sprayLife: 0.45,
    smokeColor: lin(0xdfe6ea), smokeRate: 1.05, chips: 0.0, rollDust: 0.02,
    splashy: 0.08, decal: 0.85,
  }),
  // 15 — oil slick: a hazard you can see coming.
  Object.freeze({
    id: 15, name: 'oil_slick', loose: 0.0, wet: 0.85, sparky: 0.0, dustiness: 0.0,
    markStyle: MARK.SMEAR, markColor: lin(0x0b0a10), markAlpha: 0.42, markWidth: 1.25, markSoft: 0.85,
    spray: SPRAY.SLICK, sprayColor: lin(0x2a2733), sprayColor2: lin(0x141220),
    sprayRate: 60, spraySize: 0.04, spraySpeed: 2.2, sprayLift: 0.55, sprayLife: 0.8,
    smokeColor: lin(0x585462), smokeRate: 0.5, chips: 0.0, rollDust: 0.0,
    splashy: 0.6, decal: 0.9,
  }),
]);

/**
 * @param {number} id
 * @returns {SurfaceFXDesc}
 */
export function surfaceFX(id) {
  return SURFACE_FX[(id | 0) & 0x0f] || SURFACE_FX[0];
}

export function isWater(id) { return ((id | 0) & 0x0f) === 9; }
export function isIce(id) { return ((id | 0) & 0x0f) === 10; }
export function isOil(id) { return ((id | 0) & 0x0f) === 15; }
export function isMetal(id) { return ((id | 0) & 0x0f) === 11; }
export function looseness(id) { return surfaceFX(id).loose; }

/** Chassis material → spark colour + how readily it throws sparks. */
export const CHASSIS_FX = Object.freeze({
  metal: Object.freeze({ spark: 1.0, sparkColor: lin(0xfff0c0), hot: lin(0xffb040), scrapeLight: 1.0 }),
  glass: Object.freeze({ spark: 0.35, sparkColor: lin(0xdff2ff), hot: lin(0x9fd0ff), scrapeLight: 0.5 }),
  plastic: Object.freeze({ spark: 0.12, sparkColor: lin(0xffe0b0), hot: lin(0xff9060), scrapeLight: 0.25 }),
});

export function chassisFX(kind) {
  return CHASSIS_FX[kind] || CHASSIS_FX.plastic;
}

export default SURFACE_FX;
