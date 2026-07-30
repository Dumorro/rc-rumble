/**
 * Procedural noise & pattern toolkit — barrel export.
 *
 *   import * as N from './noise/index.js';
 *
 * Everything in here is:
 *   • deterministic (seeded, no Math.random),
 *   • allocation-free in per-pixel paths (shared scratch objects),
 *   • and **seamlessly tileable** — sampling u,v over [0,1) and repeating the
 *     result must never show a seam. That is a hard requirement, not a nicety.
 *
 * Layers:
 *   Hash      — integer hashing + gradient tables
 *   Perlin    — periodic gradient noise, fBm, ridged, turbulence, domain warp
 *   Worley    — periodic cellular noise, F1/F2, cell ids, crack networks
 *   Patterns  — brick/tile/plank/parquet layouts, weaves, wood, studs, stripes
 *   Field     — Float32 wrap-around image + filters (blur, directional blur,
 *               morphology) + Sobel normal / AO / curvature derivation
 *   Stamps    — drawn wear passes (scratches, streaks, dust, cracks, chips)
 */

export * from './Hash.js';
export * from './Perlin.js';
export * from './Worley.js';
export * from './Patterns.js';
export * from './Field.js';
export * from './Stamps.js';
