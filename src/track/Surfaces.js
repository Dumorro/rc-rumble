/**
 * RC RUMBLE — canonical surface table.
 *
 * The ids here are the ones frozen in ARCHITECTURE.md. **Never renumber them** —
 * physics, audio, FX and the vehicle tyre model all index straight into this
 * table, and collision triangles store the id in a `Uint8Array`.
 *
 * A `SurfaceTable` is simply an array indexed by surface id, so
 * `table[sid].grip` works and `PhysicsWorld.surfaceFriction()` picks it up for
 * free (it duck-types `Array.isArray(t) ? t[id] : …`).
 *
 * Column meanings
 * ---------------
 * `grip`              tyre friction multiplier (the ARCHITECTURE.md grip column)
 * `rollingResistance` fraction of load resisting forward motion (drivetrain drag)
 * `bumpiness`         0..1 amplitude of the procedural micro-bump the suspension
 *                     should inject (metres ≈ bumpiness × 0.012)
 * `bumpFreq`          spatial frequency of that bump, cycles/metre
 * `drag`              extra body drag while a wheel is in it (water, sand)
 * `restitution`       bounce multiplier (mirrors physics/SURFACE_BOUNCE)
 * `particle`          FX emitter family under a spinning/sliding wheel
 * `particleColor`     tint hint for that emitter (dust / spray colour)
 * `sfx`               rolling-noise sound id for AudioSystem
 * `impactSfx`         sound id when something hits this surface hard
 * `markOpacity`       0..1 tyre-mark alpha — 0 means "never mark this surface"
 * `markColor`         tyre-mark tint (dark rubber on hard floors, pale scuff on dirt)
 * `squeal`            0..1 how much tyre squeal this surface produces
 * `noise`             0..1 broadband rolling-noise loudness
 * `soft`              true for deformable surfaces (dust plume instead of smoke)
 * `wet`               true for water-like surfaces (splash + spray + ripples)
 * `sparks`            true if metal scrape should throw sparks
 * `offTrack`          true if the AI should treat it as a penalty surface
 * `minimapColor`      colour used by the UI minimap / preview swatches
 */

/** Canonical ids — use these instead of magic numbers. */
export const SurfaceId = Object.freeze({
  DEFAULT: 0,
  WOOD: 1,
  CARPET: 2,
  TILE: 3,
  CONCRETE: 4,
  GRASS: 5,
  DIRT: 6,
  GRAVEL: 7,
  SAND: 8,
  WATER: 9,
  ICE: 10,
  METAL: 11,
  PLASTIC: 12,
  RUBBER: 13,
  GLASS: 14,
  OIL: 15,
});

/** Number of canonical surfaces. Collision stores ids in a byte; keep ≤ 256. */
export const SURFACE_COUNT = 16;

function surface(id, name, o) {
  return Object.freeze({
    id,
    name,
    grip: 1.0,
    rollingResistance: 0.014,
    bumpiness: 0.02,
    bumpFreq: 3.0,
    drag: 0.0,
    restitution: 1.0,
    particle: 'dust',
    particleColor: 0xbdb6a6,
    sfx: 'roll_hard',
    impactSfx: 'hit_hard',
    markOpacity: 0.55,
    markColor: 0x1a1614,
    squeal: 0.8,
    noise: 0.5,
    soft: false,
    wet: false,
    sparks: false,
    offTrack: false,
    minimapColor: 0x8a8478,
    ...o,
  });
}

/**
 * The canonical table. Frozen — clone it with {@link createSurfaceTable} if a
 * track wants to tweak a value (e.g. a damp museum floor).
 * @type {ReadonlyArray<object>}
 */
export const SURFACES = Object.freeze([
  surface(0, 'default', {
    grip: 1.00, rollingResistance: 0.014, bumpiness: 0.020, bumpFreq: 3.2,
    restitution: 1.00, particle: 'dust', particleColor: 0xb9b2a2,
    sfx: 'roll_hard', impactSfx: 'hit_hard',
    markOpacity: 0.55, squeal: 0.80, noise: 0.50,
    minimapColor: 0x8d8779,
  }),

  surface(1, 'wood', {
    grip: 1.00, rollingResistance: 0.012, bumpiness: 0.015, bumpFreq: 2.2,
    restitution: 1.00, particle: 'dust', particleColor: 0xcbA97a,
    sfx: 'roll_wood', impactSfx: 'hit_wood',
    markOpacity: 0.60, markColor: 0x241a12, squeal: 0.95, noise: 0.55,
    minimapColor: 0xa9773f,
  }),

  surface(2, 'carpet', {
    grip: 0.85, rollingResistance: 0.055, bumpiness: 0.100, bumpFreq: 6.5,
    drag: 0.05, restitution: 0.35, particle: 'fluff', particleColor: 0xd9c6b4,
    sfx: 'roll_carpet', impactSfx: 'hit_soft',
    markOpacity: 0.14, markColor: 0x2b1d1a, squeal: 0.18, noise: 0.28,
    soft: true, minimapColor: 0x8f3f3f,
  }),

  surface(3, 'tile', {
    grip: 1.05, rollingResistance: 0.010, bumpiness: 0.008, bumpFreq: 1.6,
    restitution: 1.10, particle: 'dust', particleColor: 0xe4e0d6,
    sfx: 'roll_tile', impactSfx: 'hit_hard',
    markOpacity: 0.70, markColor: 0x151313, squeal: 1.05, noise: 0.62,
    minimapColor: 0xd8d2c6,
  }),

  surface(4, 'concrete', {
    grip: 1.00, rollingResistance: 0.016, bumpiness: 0.050, bumpFreq: 4.0,
    restitution: 0.90, particle: 'dust', particleColor: 0xb0aca4,
    sfx: 'roll_concrete', impactSfx: 'hit_hard',
    markOpacity: 0.65, markColor: 0x191817, squeal: 0.92, noise: 0.66,
    minimapColor: 0x9b9992,
  }),

  // Grass must be SLOWER than gravel, or the garden's lawn is a better line than
  // its own path and the whole risk/reward of that track is inverted. It was
  // better than gravel on all four channels at once: 0.075 rolling resistance
  // against 0.085, 0.09 drag against 0.10, 0.160 bumpiness against 0.280 — and a
  // higher grip (0.60 vs 0.55) as well. Cutting a corner over the lawn was free.
  //
  // The grip column is frozen by ARCHITECTURE.md and stays as it is (long grass
  // really does hold a tyre better than loose stones — that is the *reward* half
  // of the trade). The cost is carried by rolling resistance, which is the one
  // channel with a live consumer: `CarSystem._buildSurfaceTables` reads it as a
  // multiplier of 0.018 (CarSystem.js:295-299), so 0.120 = 6.67× baseline where
  // gravel's 0.085 = 4.72× and sand's 0.130 = 7.22×. Grass now costs 41% more
  // rolling drag than the path it runs beside.
  //
  // `drag` and `bumpiness` are moved with it for consistency, but be honest
  // about what they do today: `bumpiness` is read only by CameraDirector
  // (CameraDirector.js:825) for camera shake, and nothing in src/ reads
  // `SurfaceTable.drag` at all — the only `.drag` consumers are AeroBody and the
  // particle integrator, both of which have their own field. Wiring those is a
  // src/vehicle job, not a src/track one.
  surface(5, 'grass', {
    grip: 0.60, rollingResistance: 0.120, bumpiness: 0.230, bumpFreq: 5.0,
    drag: 0.17, restitution: 0.45, particle: 'grass', particleColor: 0x5d8a3c,
    sfx: 'roll_grass', impactSfx: 'hit_soft',
    markOpacity: 0.10, markColor: 0x2f3a1d, squeal: 0.12, noise: 0.34,
    soft: true, offTrack: true, minimapColor: 0x5f8a3e,
  }),

  surface(6, 'dirt', {
    grip: 0.70, rollingResistance: 0.060, bumpiness: 0.200, bumpFreq: 3.6,
    drag: 0.07, restitution: 0.40, particle: 'dirt', particleColor: 0x8a6a45,
    sfx: 'roll_dirt', impactSfx: 'hit_soft',
    markOpacity: 0.28, markColor: 0x3a2a19, squeal: 0.16, noise: 0.46,
    soft: true, offTrack: true, minimapColor: 0x7d6040,
  }),

  surface(7, 'gravel', {
    grip: 0.55, rollingResistance: 0.085, bumpiness: 0.280, bumpFreq: 8.0,
    drag: 0.10, restitution: 0.50, particle: 'gravel', particleColor: 0x9a938a,
    sfx: 'roll_gravel', impactSfx: 'hit_gravel',
    markOpacity: 0.12, markColor: 0x3a352f, squeal: 0.10, noise: 0.82,
    soft: true, minimapColor: 0x8d8578,
  }),

  surface(8, 'sand', {
    grip: 0.45, rollingResistance: 0.130, bumpiness: 0.140, bumpFreq: 2.6,
    drag: 0.16, restitution: 0.25, particle: 'sand', particleColor: 0xd9c48f,
    sfx: 'roll_sand', impactSfx: 'hit_soft',
    markOpacity: 0.08, markColor: 0x8a7549, squeal: 0.08, noise: 0.40,
    soft: true, offTrack: true, minimapColor: 0xd2bd8a,
  }),

  surface(9, 'water_shallow', {
    grip: 0.35, rollingResistance: 0.180, bumpiness: 0.060, bumpFreq: 1.4,
    drag: 0.34, restitution: 0.30, particle: 'splash', particleColor: 0xbfe6ea,
    sfx: 'roll_water', impactSfx: 'hit_water',
    markOpacity: 0.00, squeal: 0.00, noise: 0.55,
    wet: true, offTrack: true, minimapColor: 0x2f7f8c,
  }),

  surface(10, 'ice', {
    grip: 0.18, rollingResistance: 0.006, bumpiness: 0.010, bumpFreq: 1.2,
    restitution: 1.05, particle: 'ice', particleColor: 0xdff2fa,
    sfx: 'roll_ice', impactSfx: 'hit_glass',
    markOpacity: 0.00, squeal: 0.35, noise: 0.30,
    minimapColor: 0xbfe4f2,
  }),

  surface(11, 'metal', {
    grip: 0.95, rollingResistance: 0.011, bumpiness: 0.030, bumpFreq: 2.0,
    restitution: 1.15, particle: 'spark', particleColor: 0xffc27a,
    sfx: 'roll_metal', impactSfx: 'hit_metal',
    markOpacity: 0.45, markColor: 0x141414, squeal: 1.10, noise: 0.74,
    sparks: true, minimapColor: 0x9fa6ad,
  }),

  surface(12, 'plastic', {
    grip: 0.90, rollingResistance: 0.013, bumpiness: 0.012, bumpFreq: 1.8,
    restitution: 1.00, particle: 'dust', particleColor: 0xd8d8dc,
    sfx: 'roll_plastic', impactSfx: 'hit_plastic',
    markOpacity: 0.50, markColor: 0x1b1b20, squeal: 0.86, noise: 0.58,
    minimapColor: 0xc45050,
  }),

  surface(13, 'rubber', {
    grip: 1.15, rollingResistance: 0.022, bumpiness: 0.030, bumpFreq: 5.5,
    restitution: 1.80, particle: 'none', particleColor: 0x2a2a2a,
    sfx: 'roll_rubber', impactSfx: 'hit_rubber',
    markOpacity: 0.80, markColor: 0x0d0d0d, squeal: 0.55, noise: 0.48,
    minimapColor: 0x33363a,
  }),

  surface(14, 'glass', {
    grip: 1.02, rollingResistance: 0.009, bumpiness: 0.004, bumpFreq: 1.0,
    restitution: 1.20, particle: 'none', particleColor: 0xd8f0ff,
    sfx: 'roll_glass', impactSfx: 'hit_glass',
    markOpacity: 0.35, markColor: 0x101418, squeal: 1.15, noise: 0.52,
    minimapColor: 0xa8d6e4,
  }),

  surface(15, 'oil_slick', {
    grip: 0.10, rollingResistance: 0.008, bumpiness: 0.006, bumpFreq: 1.0,
    restitution: 0.60, particle: 'oil', particleColor: 0x2a2430,
    sfx: 'roll_oil', impactSfx: 'hit_soft',
    markOpacity: 0.00, squeal: 0.05, noise: 0.22,
    wet: true, minimapColor: 0x2d2836,
  }),
]);

/** @param {number} id @returns {object} never undefined — falls back to id 0 */
export function getSurface(id) {
  return SURFACES[(id | 0) & 0x0f] ?? SURFACES[0];
}

/** @param {number} id */
export function surfaceName(id) { return getSurface(id).name; }

/** @param {number} id */
export function surfaceGrip(id) { return getSurface(id).grip; }

/**
 * A mutable copy of the canonical table, optionally patched per track.
 *
 *   createSurfaceTable({ 1: { grip: 0.96 } })   // slightly waxed museum floor
 *
 * @param {Record<number, object>} [overrides]
 * @returns {Array<object>} SurfaceTable — index by surface id
 */
export function createSurfaceTable(overrides = null) {
  const table = SURFACES.map((s) => ({ ...s }));
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      const id = Number(k) & 0x0f;
      if (!table[id]) continue;
      Object.assign(table[id], overrides[k]);
      table[id].id = id;
    }
  }
  return table;
}

/**
 * Surfaces a wheel should treat as "off the racing line" for the AI and for the
 * wrong-surface warning in the HUD.
 */
export const OFF_TRACK_SURFACES = Object.freeze(
  SURFACES.filter((s) => s.offTrack).map((s) => s.id),
);

/** Lateral acceleration (m/s²) a tyre can hold on a surface, at 2 g gravity. */
export function lateralCapacity(id, gravity = 19.6, tyreFactor = 1.0) {
  return getSurface(id).grip * gravity * tyreFactor;
}

export default SURFACES;
