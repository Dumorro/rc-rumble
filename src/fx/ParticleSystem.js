/**
 * RC RUMBLE — particle engine.
 *
 * Design
 * ------
 * • **Structure of arrays.** Every particle attribute lives in a typed array.
 *   Nothing is allocated after `init()`; spawning writes into a slot, killing a
 *   particle swap-removes it with the last live one so `[0, count)` is always
 *   contiguous and the instanced buffers upload as one `bufferSubData`.
 *
 * • **One instanced draw per layer.** A layer is a blend mode + a shader. Six of
 *   them cover the whole game (`add`, `alpha`, `lit`, `streak`, `ground`, `haze`),
 *   so the entire particle budget is six draw calls.
 *
 * • **Styles, not per-particle config.** An emitter references a style id; the
 *   style owns the life/size/colour/alpha curves, the sprite run and the physics
 *   coefficients. Per particle we only store what actually varies.
 *
 * • **Soft particles.** The fragment shader fades a particle out as it
 *   approaches opaque geometry, using the render system's linear-depth buffer
 *   (`postfx.passes.depthResolve.texture`, view distance in metres). That buffer
 *   is produced *after* the scene pass, so we sample last frame's copy — one
 *   frame of lag on a depth fade is invisible, and it avoids a framebuffer
 *   feedback loop. When the pass is off (low quality) the fade is disabled and
 *   the sprites' own feathered alpha carries the look.
 *
 * • **Hard cap.** `CONFIG.fx.maxParticles` via `q()`, split across layers. A
 *   full layer recycles its most-expired particle rather than dropping the new
 *   one, so a big explosion always reads even if dust was hogging the pool.
 */

import * as THREE from 'three';
import CONFIG, { q } from '../core/Config.js';
import { clamp, lerp, TAU } from '../core/MathUtils.js';
import { particleAtlas, hazeNoiseTexture, ATLAS_COLS, ATLAS_ROWS, SPR } from './ParticleAtlas.js';

// ─────────────────────────────────────────────────────── fast rng + trig

/**
 * xorshift32. Deterministic (so a replay reproduces the same sparks) and about
 * 3× faster than `Math.random()`, which matters when a burst spawns 200
 * particles and each one needs three numbers.
 */
let _rngState = (CONFIG.seed | 0) || 0x9e3779b9;
export function frand() {
  let x = _rngState;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  _rngState = x;
  return (x >>> 0) / 4294967296;
}
export function frandRange(a, b) { return a + (b - a) * frand(); }
export function fxReseed(seed) { _rngState = (seed | 0) || 0x9e3779b9; }

/**
 * Turbulence needs ~4 trig calls per particle per frame. At a few thousand
 * turbulent particles that is measurable, so we table it: 2048 entries is far
 * more resolution than a noise field needs.
 */
const SIN_BITS = 11;
const SIN_N = 1 << SIN_BITS;
const SIN_MASK = SIN_N - 1;
const SIN_SCALE = SIN_N / TAU;
const SIN_LUT = new Float32Array(SIN_N);
for (let i = 0; i < SIN_N; i++) SIN_LUT[i] = Math.sin((i / SIN_N) * TAU);
export const fastSin = (x) => SIN_LUT[(x * SIN_SCALE) & SIN_MASK];
export const fastCos = (x) => SIN_LUT[((x * SIN_SCALE) + (SIN_N >> 2)) & SIN_MASK];

// ─────────────────────────────────────────────────────────── curves

/**
 * A curve is 4 control points evaluated piecewise-linearly over normalized life.
 * Four points covers every shape we need (ease-in, ease-out, pop-and-fade,
 * hold-then-drop) and costs three compares.
 */
export function makeCurve(spec, fallback) {
  const src = Array.isArray(spec) ? spec : (spec == null ? fallback : [spec, spec, spec, spec]);
  const out = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    const v = src[Math.min(i, src.length - 1)];
    out[i] = v == null ? (fallback[Math.min(i, fallback.length - 1)] ?? 1) : v;
  }
  return out;
}

export function evalCurve(c, t) {
  const s = t * 3;
  if (s <= 0) return c[0];
  if (s >= 3) return c[3];
  const i = s | 0;
  return c[i] + (c[i + 1] - c[i]) * (s - i);
}

// ─────────────────────────────────────────────────────────── layers

export const LAYER = Object.freeze({
  /** Additive: sparks, flames, glows, electricity. Order independent. */
  ADD: 0,
  /** Premultiplied alpha, unlit: water droplets, debris flecks, leaves. */
  ALPHA: 1,
  /** Premultiplied alpha with cheap spherical lighting: smoke, dust, plumes. */
  LIT: 2,
  /** Additive, stretched along screen-space velocity: spark trails, speed lines. */
  STREAK: 3,
  /**
   * Additive flat quads lying on a surface: ripples, shockwave rings, ground
   * glow. **These do not move** — for a GROUND particle the velocity triplet is
   * reinterpreted as the plane normal, and the quad expands via its size curve.
   */
  GROUND: 4,
  /** Heat-haze shimmer: warped noise, low contrast, additive. */
  HAZE: 5,
});

const LAYER_COUNT = 6;
const LAYER_NAMES = ['add', 'alpha', 'lit', 'streak', 'ground', 'haze'];

/**
 * Fraction of the global particle budget each layer gets.
 * GROUND gets a bigger slice than its visual weight suggests because water
 * wakes, foam and shockwave rings all land there and a car ploughing through a
 * puddle will otherwise starve the rings.
 */
export const LAYER_SHARE = [0.28, 0.24, 0.26, 0.12, 0.08, 0.02];

/** Soft-depth-fade distance as a multiple of the particle's world size. */
const LAYER_SOFT = [0.55, 0.75, 1.35, 0.30, 1.10, 1.00];

// ─────────────────────────────────────────────────────────── GLSL

/**
 * Fog. Declared by hand rather than via three's chunks because an *additive*
 * particle lost to fog must contribute nothing rather than turn grey, and the
 * built-in `fog_fragment` only knows how to mix toward the fog colour.
 */
const FOG_PARS = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  varying float vFogDepth;
#endif

vec3 rcFogColor() {
  #ifdef USE_FOG
    return fogColor;
  #else
    return vec3( 0.0 );
  #endif
}

float rcFogFactor() {
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      return 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      return smoothstep( fogNear, fogFar, vFogDepth );
    #endif
  #else
    return 0.0;
  #endif
}
`;

const COMMON_VERT = /* glsl */`
precision highp float;

attribute vec3 aPos;
attribute vec4 aColor;      // rgb tint (linear working space) + alpha
attribute vec4 aXform;      // x,y = half size (m), z = roll (rad), w = atlas tile

uniform vec2  uAtlasTiles;
uniform vec2  uAtlasInset;
uniform float uSizeScale;
uniform float uSoftScale;

varying vec4 vColor;
varying vec2 vUv;
varying vec2 vQuad;
varying float vViewZ;
varying float vSoft;

#ifdef USE_FOG
  varying float vFogDepth;
#endif

vec2 atlasUv( vec2 uvIn, float tileIndex ) {
  float idx = floor( tileIndex + 0.5 );
  float col = mod( idx, uAtlasTiles.x );
  float row = floor( idx / uAtlasTiles.x );
  // the atlas is uploaded flipY:false, so flip v here to draw sprites upright
  vec2 local = vec2( uvIn.x, 1.0 - uvIn.y );
  local = mix( uAtlasInset, 1.0 - uAtlasInset, local );
  return ( vec2( col, row ) + local ) / uAtlasTiles;
}
`;

const COMMON_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uAtlas;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uSoftEnabled;
uniform float uIntensity;

varying vec4 vColor;
varying vec2 vUv;
varying vec2 vQuad;
varying float vViewZ;
varying float vSoft;

${FOG_PARS}

/** Fade the particle out as it approaches opaque geometry. */
float rcSoftFade() {
  if ( uSoftEnabled < 0.5 ) return 1.0;
  float sceneZ = texture2D( uDepth, gl_FragCoord.xy / uResolution ).x;
  // a zero/garbage read must never blank the particle
  if ( sceneZ <= 0.0001 ) return 1.0;
  return clamp( ( sceneZ - vViewZ ) / max( vSoft, 0.0005 ), 0.0, 1.0 );
}
`;

/** Camera-facing billboard: offset the vertex in view space. */
const SPRITE_VERT = /* glsl */`
${COMMON_VERT}
void main() {
  vec4 center = modelViewMatrix * vec4( aPos, 1.0 );
  float ca = cos( aXform.z );
  float sa = sin( aXform.z );
  vec2 p = position.xy;
  vec2 rp = vec2( p.x * ca - p.y * sa, p.x * sa + p.y * ca );
  vec2 halfSize = aXform.xy * uSizeScale;
  center.xy += rp * halfSize * 2.0;

  vViewZ = - center.z;
  vSoft = max( halfSize.y, 0.004 ) * uSoftScale;
  vQuad = p;
  vUv = atlasUv( uv, aXform.w );
  vColor = aColor;
  #ifdef USE_FOG
    vFogDepth = - center.z;
  #endif
  gl_Position = projectionMatrix * center;
}
`;

/** Velocity-aligned stretched quad. */
const STREAK_VERT = /* glsl */`
${COMMON_VERT}
attribute vec4 aVel;        // xyz = world velocity, w = stretch (seconds)
void main() {
  vec4 center = modelViewMatrix * vec4( aPos, 1.0 );
  vec3 velView = ( viewMatrix * vec4( aVel.xyz, 0.0 ) ).xyz;

  vec2 d = velView.xy;
  float dl = length( d );
  vec2 axis = dl > 1e-5 ? d / dl : vec2( 0.0, 1.0 );
  vec2 perp = vec2( -axis.y, axis.x );

  float width = aXform.x * uSizeScale;
  // the streak grows with screen-space speed: a slow spark is a dot, a fast one
  // is a tracer
  float len = ( aXform.y * uSizeScale ) + dl * aVel.w;

  center.xy += axis * ( position.y * len * 2.0 ) + perp * ( position.x * width * 2.0 );

  vViewZ = - center.z;
  vSoft = max( width, 0.004 ) * uSoftScale;
  vQuad = position.xy;
  vUv = atlasUv( uv, aXform.w );
  vColor = aColor;
  #ifdef USE_FOG
    vFogDepth = - center.z;
  #endif
  gl_Position = projectionMatrix * center;
}
`;

/** Flat quad lying on a surface; aVel.xyz is the plane normal. */
const GROUND_VERT = /* glsl */`
${COMMON_VERT}
attribute vec4 aVel;
void main() {
  vec3 nrm = aVel.xyz;
  vec3 n = normalize( dot( nrm, nrm ) > 1e-8 ? nrm : vec3( 0.0, 1.0, 0.0 ) );
  vec3 ref = abs( n.y ) > 0.98 ? vec3( 0.0, 0.0, 1.0 ) : vec3( 0.0, 1.0, 0.0 );
  vec3 t = normalize( cross( ref, n ) );
  vec3 b = cross( n, t );

  float ca = cos( aXform.z );
  float sa = sin( aXform.z );
  vec2 p = position.xy;
  vec2 rp = vec2( p.x * ca - p.y * sa, p.x * sa + p.y * ca );

  vec3 world = aPos + ( t * rp.x * aXform.x + b * rp.y * aXform.y ) * uSizeScale * 2.0;
  vec4 center = modelViewMatrix * vec4( world, 1.0 );

  vViewZ = - center.z;
  vSoft = max( aXform.y * uSizeScale, 0.004 ) * uSoftScale;
  vQuad = p;
  vUv = atlasUv( uv, aXform.w );
  vColor = aColor;
  #ifdef USE_FOG
    vFogDepth = - center.z;
  #endif
  gl_Position = projectionMatrix * center;
}
`;

/** Additive / plain-alpha sprite. */
const SPRITE_FRAG = /* glsl */`
${COMMON_FRAG}
void main() {
  vec4 tex = texture2D( uAtlas, vUv );
  float a = tex.a * vColor.a;
  if ( a < 0.003 ) discard;
  a *= rcSoftFade();
  vec3 rgb = tex.rgb * vColor.rgb * uIntensity;
  float fogF = rcFogFactor();
  #ifdef FX_ADDITIVE
    rgb *= 1.0 - fogF;
  #else
    rgb = mix( rgb, rcFogColor(), fogF );
  #endif
  gl_FragColor = vec4( rgb * a, a );
}
`;

/**
 * Cheap "spherical billboard" lighting: treat the quad as a hemisphere facing
 * the camera, light it with the scene sun plus a sky/ground gradient. Costs one
 * normalize and two dots, and it is the single biggest thing that stops smoke
 * and dust from looking like flat decals.
 */
const LIT_FRAG = /* glsl */`
${COMMON_FRAG}
uniform vec3 uSunDirView;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uUpView;
uniform float uWrap;

void main() {
  vec4 tex = texture2D( uAtlas, vUv );
  float a = tex.a * vColor.a;
  if ( a < 0.003 ) discard;
  a *= rcSoftFade();

  float r2 = dot( vQuad, vQuad ) * 4.0;
  float nz = sqrt( max( 1.0 - min( r2, 1.0 ), 0.0 ) );
  vec3 n = normalize( vec3( vQuad * 2.0, nz + 0.35 ) );

  // wrapped diffuse: light bleeds around the silhouette the way it does in a
  // genuinely translucent puff
  float ndl = dot( n, uSunDirView );
  float diff = clamp( ( ndl + uWrap ) / ( 1.0 + uWrap ), 0.0, 1.0 );

  float upDot = dot( n, uUpView ) * 0.5 + 0.5;
  vec3 ambient = mix( uGroundColor, uSkyColor, upDot );

  vec3 rgb = tex.rgb * vColor.rgb * ( ambient + uSunColor * diff ) * uIntensity;
  rgb = mix( rgb, rcFogColor(), rcFogFactor() );
  gl_FragColor = vec4( rgb * a, a );
}
`;

/**
 * Heat shimmer. Without a scene-colour grab pass we cannot truly refract, so we
 * do the next best thing: two counter-scrolling octaves of warped noise
 * differenced against each other, which produces the same high-frequency
 * bright/dark ripple the eye reads as hot air. Bloom picks up the bright side.
 */
const HAZE_FRAG = /* glsl */`
${COMMON_FRAG}
uniform sampler2D uNoise;
uniform float uTime;
uniform float uWarp;

void main() {
  vec2 quv = vQuad + 0.5;
  vec2 w1 = texture2D( uNoise, quv * 1.7 + vec2( uTime * 0.11, -uTime * 0.42 ) ).rg * 2.0 - 1.0;
  vec2 w2 = texture2D( uNoise, quv * 3.3 - vec2( uTime * 0.07, uTime * 0.63 ) ).rg * 2.0 - 1.0;
  vec2 warp = ( w1 + w2 * 0.55 ) * uWarp;

  // The falloff is computed analytically rather than sampled from the atlas:
  // warping an atlas lookup would drag in the neighbouring tiles, and a gaussian
  // is both cheaper and exactly the shape we want.
  float r = length( vQuad + warp * 0.06 ) * 2.0;
  float mask = exp( -3.6 * r * r ) * vColor.a;
  if ( mask < 0.004 ) discard;
  mask *= rcSoftFade();

  float shimmer = ( w1.x * w2.y - w1.y * w2.x ) * 1.9 + ( w1.y + w2.x ) * 0.35;
  // radial containment: never show a rectangular edge on a shimmer patch
  float radial = 1.0 - smoothstep( 0.20, 0.5, length( vQuad ) );

  vec3 rgb = vColor.rgb * ( 0.45 + shimmer ) * uIntensity;
  float a = mask * radial * ( 0.30 + abs( shimmer ) * 0.70 );
  rgb *= 1.0 - rcFogFactor();
  gl_FragColor = vec4( rgb * a, a );
}
`;

// ─────────────────────────────────────────────────────────── flags

const F_BOUNCE = 1 << 0;
const F_STICK = 1 << 1;                 // stop dead on ground contact
const F_FADE_OUT_ON_STOP = 1 << 2;
const F_RANDOM_FRAME = 1 << 3;
const F_LOOP_FRAME = 1 << 4;

// ─────────────────────────────────────────────────────────── layer

/** Reused update-range record: pushing a fresh object every frame is garbage. */
function attachRange(attr, count) {
  let r = attr._rcRange;
  if (!r) { r = { start: 0, count: 0 }; attr._rcRange = r; }
  r.start = 0;
  r.count = count;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(r);
  attr.needsUpdate = true;
}

class ParticleLayer {
  constructor(kind, capacity, shared) {
    this.kind = kind;
    this.capacity = Math.max(16, capacity | 0);
    this.count = 0;
    this.spawned = 0;
    this.recycled = 0;
    this._victim = 0;

    const n = this.capacity;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.aspect = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.rotVel = new Float32Array(n);
    this.seed = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.cr = new Float32Array(n); this.cg = new Float32Array(n); this.cb = new Float32Array(n);
    this.groundY = new Float32Array(n);
    this.styleId = new Uint16Array(n);
    this.frameBase = new Uint16Array(n);
    this.flags = new Uint8Array(n);

    this.aPos = new Float32Array(n * 3);
    this.aColor = new Float32Array(n * 4);
    this.aXform = new Float32Array(n * 4);
    this.needsVel = (kind === LAYER.STREAK || kind === LAYER.GROUND);
    this.aVel = this.needsVel ? new Float32Array(n * 4) : null;

    this.isGround = kind === LAYER.GROUND;
    this.geometry = null;
    this.material = null;
    this.mesh = null;
    this._shared = shared;
  }

  build() {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const mk = (arr, item) => {
      const a = new THREE.InstancedBufferAttribute(arr, item);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.attrPos = mk(this.aPos, 3);
    this.attrColor = mk(this.aColor, 4);
    this.attrXform = mk(this.aXform, 4);
    geo.setAttribute('aPos', this.attrPos);
    geo.setAttribute('aColor', this.attrColor);
    geo.setAttribute('aXform', this.attrXform);
    if (this.aVel) {
      this.attrVel = mk(this.aVel, 4);
      geo.setAttribute('aVel', this.attrVel);
    }
    geo.instanceCount = 0;
    // Particles roam the whole track; a real bounding sphere would either be
    // wrong or would have to be recomputed every frame. We never cull.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const { atlas, noise } = this._shared;
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        // NOTE: textures are deliberately null here — UniformsUtils.merge clones
        // any Texture it finds, which would duplicate the atlas per layer.
        uAtlas: { value: null },
        uDepth: { value: null },
        uNoise: { value: null },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uAtlasTiles: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
        uAtlasInset: { value: new THREE.Vector2(0, 0) },
        uSizeScale: { value: 1 },
        uSoftScale: { value: LAYER_SOFT[this.kind] },
        uSoftEnabled: { value: 0 },
        uIntensity: { value: 1 },
        uTime: { value: 0 },
        uWarp: { value: this.kind === LAYER.HAZE ? 0.55 : 0.55 },
        uSunDirView: { value: new THREE.Vector3(0.35, 0.6, 0.72) },
        uSunColor: { value: new THREE.Color(0.9, 0.86, 0.8) },
        uSkyColor: { value: new THREE.Color(0.42, 0.48, 0.56) },
        uGroundColor: { value: new THREE.Color(0.20, 0.18, 0.16) },
        uUpView: { value: new THREE.Vector3(0, 1, 0) },
      },
    ]);
    uniforms.uAtlas.value = atlas;
    uniforms.uNoise.value = noise;
    const tileRes = atlas?.image?.width ? atlas.image.width / ATLAS_COLS : 128;
    const inset = 0.75 / tileRes;
    uniforms.uAtlasInset.value.set(inset, inset);

    const additive = (this.kind === LAYER.ADD || this.kind === LAYER.STREAK
      || this.kind === LAYER.GROUND || this.kind === LAYER.HAZE);

    let vert = SPRITE_VERT;
    if (this.kind === LAYER.STREAK) vert = STREAK_VERT;
    else if (this.kind === LAYER.GROUND) vert = GROUND_VERT;

    let frag = SPRITE_FRAG;
    if (this.kind === LAYER.LIT) frag = LIT_FRAG;
    else if (this.kind === LAYER.HAZE) frag = HAZE_FRAG;

    const defines = {};
    if (additive) defines.FX_ADDITIVE = '';
    if (this.kind === LAYER.LIT) uniforms.uWrap = { value: 0.55 };

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      defines,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: true,
      // Everything the engine outputs is premultiplied, so "additive" and
      // "normal" differ only in the destination factor.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    mat.name = `fx/particles/${LAYER_NAMES[this.kind]}`;
    this.material = mat;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = mat.name;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = this.isGround ? 6 : (additive ? 12 : 10);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.noCollision = true;
    this.mesh = mesh;
    return this;
  }

  /** @returns {number} the slot to write, or -1 if the layer refuses. */
  alloc() {
    if (this.count < this.capacity) return this.count++;
    // Full: steal the most-expired particle we can find cheaply. A rotating
    // cursor over 8 candidates approximates "oldest" without an O(n) scan.
    let best = -1;
    let bestT = 0.35;
    for (let k = 0; k < 8; k++) {
      const i = (this._victim + k * 977) % this.capacity;
      const t = this.life[i] > 0 ? this.age[i] / this.life[i] : 1;
      if (t > bestT) { bestT = t; best = i; }
    }
    this._victim = (this._victim + 1) % this.capacity;
    if (best < 0) return -1;
    this.recycled++;
    return best;
  }

  kill(i) {
    const last = --this.count;
    if (i !== last) this._move(last, i);
  }

  _move(from, to) {
    this.px[to] = this.px[from]; this.py[to] = this.py[from]; this.pz[to] = this.pz[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.size[to] = this.size[from];
    this.aspect[to] = this.aspect[from];
    this.rot[to] = this.rot[from];
    this.rotVel[to] = this.rotVel[from];
    this.seed[to] = this.seed[from];
    this.alpha[to] = this.alpha[from];
    this.cr[to] = this.cr[from]; this.cg[to] = this.cg[from]; this.cb[to] = this.cb[from];
    this.groundY[to] = this.groundY[from];
    this.styleId[to] = this.styleId[from];
    this.frameBase[to] = this.frameBase[from];
    this.flags[to] = this.flags[from];
  }

  upload() {
    const n = this.count;
    this.geometry.instanceCount = n;
    if (n === 0) return;
    attachRange(this.attrPos, n * 3);
    attachRange(this.attrColor, n * 4);
    attachRange(this.attrXform, n * 4);
    if (this.attrVel) attachRange(this.attrVel, n * 4);
  }

  clear() { this.count = 0; }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
  }
}

// ─────────────────────────────────────────────────────────── scratch

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _col = new THREE.Color();
const _mat3 = new THREE.Matrix3();

// ─────────────────────────────────────────────────────────── system

/**
 * @typedef {object} ParticleStyleDesc
 * @property {number} [layer] LAYER.* (default LAYER.ALPHA)
 * @property {number} [sprite] base atlas tile (SPR.*)
 * @property {number} [frames] tiles in the sprite run
 * @property {'life'|'loop'|'random'|'static'} [frameMode]
 * @property {number} [fps] frames/second when frameMode === 'loop'
 * @property {[number,number]} [life] seconds, random range
 * @property {[number,number]} [size] metres (half-extent), random range
 * @property {number[]} [sizeCurve] 4-point multiplier over life
 * @property {number} [aspect] height/width ratio
 * @property {number[]|number} [alphaCurve] 4-point alpha over life
 * @property {number} [alpha] peak alpha
 * @property {number|number[]} [color] start colour (sRGB hex, or linear triplet)
 * @property {number|number[]} [colorEnd] end colour
 * @property {number[]|number} [colorCurve] 4-point luminance multiplier
 * @property {number} [gravity] m/s²
 * @property {number} [drag] linear drag, 1/s
 * @property {number} [turbulence] m/s² of swirl
 * @property {number} [turbScale] spatial frequency, 1/m
 * @property {number} [turbSpeed] how fast the field evolves
 * @property {number} [rise] extra upward acceleration (hot gas), m/s²
 * @property {[number,number]} [spin] rad/s range
 * @property {number} [stretch] streak length per m/s of screen velocity
 * @property {number} [bounce] restitution against the ground plane recorded at spawn
 * @property {number} [groundFriction] tangential loss on bounce
 * @property {boolean} [stick] stop dead on ground contact
 * @property {boolean} [fadeOnStop] shorten the remaining life once stopped
 * @property {number} [intensity] colour multiplier (HDR headroom for additives)
 * @property {number} [sizeJitter] 0..1
 */

export class ParticleSystem {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {{max?:number, tileSize?:number}} [opts]
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.enabled = true;

    const budget = opts.max ?? q(CONFIG.fx.maxParticles) ?? 6000;
    this.maxParticles = Math.max(256, budget | 0);

    /** @type {ParticleLayer[]} */
    this.layers = [];
    /** @type {object[]} */
    this.styles = [];
    this._styleByName = new Map();

    this.group = new THREE.Group();
    this.group.name = 'fx/particles';
    this.group.matrixAutoUpdate = false;
    this.group.frustumCulled = false;

    this.atlas = null;
    this.noise = null;

    this.time = 0;
    /** Global size multiplier — quality knob. */
    this.sizeScale = 1;

    this._softEnabled = false;
    /**
     * Consecutive frames the depth-resolve pass has been running. The resolve
     * target holds *last* frame's depth, so a pass we just switched on is still
     * full of stale content for one frame.
     */
    this._softStable = 0;
    /**
     * Ask PostFX to keep its linear-depth pass alive for us. PostFX only runs
     * the resolve when AO, motion blur or DOF want it — and at 'low' and
     * 'medium' none of them do, which would lose the soft-particle fade on
     * exactly the hardware where dust sits closest to the floor and hard
     * intersections are most obvious. The pass is one full-screen R16F blit
     * (~0.2 ms at 900p); we ask for it from 'medium' up, and we stop asking the
     * moment the renderer's adaptive governor starts shedding quality.
     * Set to false to leave PostFX entirely alone.
     */
    this.requestDepthPass = CONFIG.quality !== 'low';
    this._resolution = new THREE.Vector2(1920, 1080);
    this._unsubResize = null;

    this.stats = {
      alive: 0, capacity: 0, spawned: 0, recycled: 0, dropped: 0,
      simMs: 0, layers: new Int32Array(LAYER_COUNT),
    };
  }

  // ───────────────────────────────────────────────────────── lifecycle

  init() {
    const assets = this.game?.assets;
    const tileSize = CONFIG.quality === 'low' ? 64 : (CONFIG.quality === 'ultra' ? 192 : 128);
    this.atlas = particleAtlas(assets, { tileSize });
    this.noise = hazeNoiseTexture(assets, { size: CONFIG.quality === 'low' ? 64 : 128 });

    const shared = { atlas: this.atlas, noise: this.noise };
    let cap = 0;
    for (let k = 0; k < LAYER_COUNT; k++) {
      const c = Math.max(32, Math.round(this.maxParticles * LAYER_SHARE[k]));
      const layer = new ParticleLayer(k, c, shared).build();
      this.layers.push(layer);
      this.group.add(layer.mesh);
      cap += layer.capacity;
    }
    this.stats.capacity = cap;

    const renderer = this.game?.renderer;
    if (renderer?.registerResizeTarget) {
      this._unsubResize = renderer.registerResizeTarget((w, h, pr) => {
        this._resolution.set(Math.max(1, Math.floor(w * pr)), Math.max(1, Math.floor(h * pr)));
        for (const l of this.layers) l.material.uniforms.uResolution.value.copy(this._resolution);
      });
    }
    return this;
  }

  attach(parent) { parent?.add(this.group); return this; }

  dispose() {
    this._unsubResize?.();
    this._unsubResize = null;
    for (const l of this.layers) l.dispose();
    this.layers.length = 0;
    this.group.removeFromParent();
  }

  // ───────────────────────────────────────────────────────── styles

  /**
   * Register a style. Idempotent by name; returns the style id used by every
   * spawn call.
   * @param {string} name
   * @param {ParticleStyleDesc} d
   * @returns {number}
   */
  defineStyle(name, d = {}) {
    const existing = this._styleByName.get(name);
    if (existing !== undefined) return existing;

    const frames = Math.max(1, d.frames ?? 1);
    const frameMode = d.frameMode ?? (frames > 1 ? 'life' : 'static');
    let flags = 0;
    if (frameMode === 'random') flags |= F_RANDOM_FRAME;
    else if (frameMode === 'loop') flags |= F_LOOP_FRAME;
    if (d.bounce) flags |= F_BOUNCE;
    if (d.stick) flags |= F_STICK | F_BOUNCE;
    if (d.fadeOnStop) flags |= F_FADE_OUT_ON_STOP;

    const colorA = toLinearRGB(d.color ?? 0xffffff);
    const colorB = toLinearRGB(d.colorEnd ?? d.color ?? 0xffffff);

    const style = {
      id: this.styles.length,
      name,
      layer: d.layer ?? LAYER.ALPHA,
      sprite: d.sprite ?? SPR.SOFT,
      frames,
      frameMode,
      fps: d.fps ?? 14,
      lifeMin: d.life?.[0] ?? 0.6,
      lifeMax: d.life?.[1] ?? d.life?.[0] ?? 0.9,
      sizeMin: d.size?.[0] ?? 0.05,
      sizeMax: d.size?.[1] ?? d.size?.[0] ?? 0.07,
      sizeCurve: makeCurve(d.sizeCurve, [1, 1, 1, 1]),
      aspect: d.aspect ?? 1,
      alpha: d.alpha ?? 1,
      alphaCurve: makeCurve(d.alphaCurve, [0, 1, 0.7, 0]),
      colorCurve: makeCurve(d.colorCurve, [1, 1, 1, 1]),
      cr0: colorA[0], cg0: colorA[1], cb0: colorA[2],
      cr1: colorB[0], cg1: colorB[1], cb1: colorB[2],
      gravity: d.gravity ?? 0,
      drag: d.drag ?? 1.0,
      turbulence: d.turbulence ?? 0,
      turbScale: d.turbScale ?? 2.2,
      turbSpeed: d.turbSpeed ?? 0.9,
      rise: d.rise ?? 0,
      spinMin: d.spin?.[0] ?? 0,
      spinMax: d.spin?.[1] ?? d.spin?.[0] ?? 0,
      stretch: d.stretch ?? 0,
      bounce: d.bounce ?? 0,
      groundFriction: d.groundFriction ?? 0.35,
      intensity: d.intensity ?? 1,
      sizeJitter: d.sizeJitter ?? 0,
      flags,
    };
    this.styles.push(style);
    this._styleByName.set(name, style.id);
    return style.id;
  }

  styleId(name) { const v = this._styleByName.get(name); return v === undefined ? -1 : v; }
  style(id) { return this.styles[id]; }

  // ───────────────────────────────────────────────────────── spawning

  /**
   * Spawn one particle. Allocation free.
   *
   * For LAYER.GROUND styles the (vx,vy,vz) triplet is the **plane normal**, not
   * a velocity.
   *
   * @param {number} styleId
   * @param {number} x @param {number} y @param {number} z
   * @param {number} vx @param {number} vy @param {number} vz
   * @param {object} [o] optional overrides: `size`, `sizeMul`, `life`, `lifeMul`,
   *   `alpha`, `r`/`g`/`b` (linear tint multipliers), `groundY`, `rot`, `spin`,
   *   `frame`, `aspect`
   * @returns {number} slot index, or -1 if the spawn was refused
   */
  spawn(styleId, x, y, z, vx, vy, vz, o) {
    if (!this.enabled) return -1;
    const st = this.styles[styleId];
    if (!st) return -1;
    const L = this.layers[st.layer];
    if (!L) return -1;
    const i = L.alloc();
    if (i < 0) { this.stats.dropped++; return -1; }

    const r1 = frand(), r2 = frand(), r3 = frand();

    L.px[i] = x; L.py[i] = y; L.pz[i] = z;
    L.vx[i] = vx; L.vy[i] = vy; L.vz[i] = vz;
    L.age[i] = 0;

    let life = lerp(st.lifeMin, st.lifeMax, r1);
    if (o) {
      if (o.life !== undefined) life = o.life;
      if (o.lifeMul !== undefined) life *= o.lifeMul;
    }
    L.life[i] = life > 0.02 ? life : 0.02;

    let size = lerp(st.sizeMin, st.sizeMax, r2);
    if (st.sizeJitter) size *= 1 + (r3 - 0.5) * 2 * st.sizeJitter;
    if (o) {
      if (o.size !== undefined) size = o.size;
      if (o.sizeMul !== undefined) size *= o.sizeMul;
    }
    L.size[i] = size;
    L.aspect[i] = (o && o.aspect !== undefined) ? o.aspect : st.aspect;

    L.rot[i] = (o && o.rot !== undefined) ? o.rot : r1 * TAU;
    L.rotVel[i] = (o && o.spin !== undefined) ? o.spin : lerp(st.spinMin, st.spinMax, r2);
    L.seed[i] = r3;
    L.alpha[i] = ((o && o.alpha !== undefined) ? o.alpha : 1) * st.alpha;
    L.cr[i] = (o && o.r !== undefined) ? o.r : 1;
    L.cg[i] = (o && o.g !== undefined) ? o.g : 1;
    L.cb[i] = (o && o.b !== undefined) ? o.b : 1;
    L.groundY[i] = (o && o.groundY !== undefined) ? o.groundY : -1e6;
    L.styleId[i] = styleId;
    L.flags[i] = st.flags;

    let frame = st.sprite;
    if (o && o.frame !== undefined) frame = st.sprite + (o.frame % st.frames);
    else if (st.flags & F_RANDOM_FRAME) frame = st.sprite + ((r3 * st.frames) | 0);
    L.frameBase[i] = frame;

    L.spawned++;
    this.stats.spawned++;
    return i;
  }

  /**
   * Spawn `n` particles in a cone. The most-used helper in the FX system, so it
   * takes plain numbers and never allocates.
   *
   * @param {number} styleId
   * @param {number} x @param {number} y @param {number} z origin
   * @param {number} dx @param {number} dy @param {number} dz cone axis (need not be unit)
   * @param {number} speed base ejection speed
   * @param {number} spread 0 = laser, 1 = hemisphere, 2 = sphere
   * @param {number} n count
   * @param {object} [o] spawn overrides plus `speedJitter` (0..1), `radius`
   *   (positional jitter, m), `inheritX`/`inheritY`/`inheritZ` (m/s added to all)
   */
  burstCone(styleId, x, y, z, dx, dy, dz, speed, spread, n, o) {
    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len, ay = dy / len, az = dz / len;

    // orthonormal basis around the axis
    let ux = 0, uy = 1, uz = 0;
    if (ay > 0.94 || ay < -0.94) { ux = 1; uy = 0; uz = 0; }
    let tx = uy * az - uz * ay, ty = uz * ax - ux * az, tz = ux * ay - uy * ax;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ay * tz - az * ty, by = az * tx - ax * tz, bz = ax * ty - ay * tx;

    const jitter = (o && o.speedJitter !== undefined) ? o.speedJitter : 0.45;
    const radius = (o && o.radius) || 0;
    const ivx = (o && o.inheritX) || 0;
    const ivy = (o && o.inheritY) || 0;
    const ivz = (o && o.inheritZ) || 0;

    for (let k = 0; k < n; k++) {
      const a = frand() * TAU;
      // sqrt keeps a wide cone from clumping at the rim
      const s = Math.sqrt(frand()) * spread;
      const ca = fastCos(a), sa = fastSin(a);
      let ox = ax + (tx * ca + bx * sa) * s;
      let oy = ay + (ty * ca + by * sa) * s;
      let oz = az + (tz * ca + bz * sa) * s;
      const ol = Math.hypot(ox, oy, oz) || 1;
      ox /= ol; oy /= ol; oz /= ol;

      const sp = speed * (1 - jitter * frand());
      let sx = x, sy = y, sz = z;
      if (radius > 0) {
        sx += (frand() - 0.5) * radius * 2;
        sy += (frand() - 0.5) * radius * 2;
        sz += (frand() - 0.5) * radius * 2;
      }
      this.spawn(styleId, sx, sy, sz, ox * sp + ivx, oy * sp + ivy, oz * sp + ivz, o);
    }
  }

  /** Spawn `n` particles radially on a horizontal disc. */
  burstDisc(styleId, x, y, z, radius, speed, upBias, n, o) {
    for (let k = 0; k < n; k++) {
      const a = frand() * TAU;
      const r = radius * Math.sqrt(frand());
      const ca = fastCos(a), sa = fastSin(a);
      this.spawn(styleId, x + ca * r, y, z + sa * r, ca * speed, upBias * speed, sa * speed, o);
    }
  }

  // ───────────────────────────────────────────────────────── update

  /**
   * @param {number} dt simulated seconds (0 while paused, scaled in slow-mo)
   * @param {THREE.Camera} camera
   */
  update(dt, camera) {
    if (!this.enabled) return;
    const t0 = performance.now();

    if (dt > 0.1) dt = 0.1;
    else if (dt < 0) dt = 0;
    this.time += dt;

    this._refreshDepth();
    this._refreshLighting(camera);

    let alive = 0;
    let recycled = 0;
    for (let k = 0; k < this.layers.length; k++) {
      const L = this.layers[k];
      if (dt > 0) this._simulate(L, dt);
      this._pack(L);
      L.upload();
      const u = L.material.uniforms;
      u.uSizeScale.value = this.sizeScale;
      u.uTime.value = this.time;
      this.stats.layers[k] = L.count;
      alive += L.count;
      recycled += L.recycled;
    }
    this.stats.alive = alive;
    this.stats.recycled = recycled;
    this.stats.simMs = this.stats.simMs * 0.88 + (performance.now() - t0) * 0.12;
  }

  _refreshDepth() {
    const renderer = this.game?.renderer;
    const pass = renderer?.postfx?.passes?.depthResolve;

    if (pass && pass.texture && this.requestDepthPass && !pass.enabled) {
      // See `requestDepthPass`. PostFX recomputes this whenever its own quality
      // knobs change, so the request is re-made every frame rather than latched.
      const step = renderer.adaptive?.step ?? 0;
      if (step < 3) pass.enabled = true;
    }

    const running = !!(pass && pass.enabled && pass.texture);
    this._softStable = running ? (this._softStable < 3 ? this._softStable + 1 : 3) : 0;
    const ok = this._softStable >= 2;

    this._softEnabled = ok;
    for (let i = 0; i < this.layers.length; i++) {
      const u = this.layers[i].material.uniforms;
      u.uDepth.value = ok ? pass.texture : null;
      u.uSoftEnabled.value = ok ? 1 : 0;
    }
  }

  _refreshLighting(camera) {
    const lit = this.layers[LAYER.LIT];
    if (!lit || !camera) return;
    const u = lit.material.uniforms;
    const lighting = this.game?.renderer?.lighting;

    // A camera matrix is orthonormal, so the inverse of its 3×3 rotation block
    // is its transpose — no matrix inversion, and it works before the renderer
    // has computed matrixWorldInverse for this frame.
    _mat3.setFromMatrix4(camera.matrixWorld).transpose();

    const sun = lighting?.sun;
    if (sun) {
      _v3a.copy(sun.position);
      const tgt = lighting.sunTarget?.position;
      if (tgt) _v3a.sub(tgt);
      if (_v3a.lengthSq() < 1e-8) _v3a.set(0.4, 1, 0.3);
      _v3a.normalize();
      _v3b.copy(_v3a).applyMatrix3(_mat3).normalize();
      u.uSunDirView.value.copy(_v3b);
      const inten = clamp(sun.intensity ?? 2, 0, 8) * 0.42;
      u.uSunColor.value.copy(sun.color).multiplyScalar(inten);
    }

    const hemi = lighting?.hemi;
    if (hemi) {
      const hi = clamp(hemi.intensity ?? 1, 0, 6) * 0.55;
      u.uSkyColor.value.copy(hemi.color).multiplyScalar(hi);
      u.uGroundColor.value.copy(hemi.groundColor).multiplyScalar(hi * 0.7);
    }

    u.uUpView.value.set(0, 1, 0).applyMatrix3(_mat3).normalize();
  }

  /** @param {ParticleLayer} L */
  _simulate(L, dt) {
    const styles = this.styles;
    const t = this.time;

    if (L.isGround) {
      // Ground quads are static: only age and roll advance.
      let i = 0;
      while (i < L.count) {
        const age = L.age[i] + dt;
        if (age >= L.life[i]) { L.kill(i); continue; }
        L.age[i] = age;
        L.rot[i] += L.rotVel[i] * dt;
        i++;
      }
      return;
    }

    let i = 0;
    while (i < L.count) {
      const s = styles[L.styleId[i]];
      const age = L.age[i] + dt;
      if (age >= L.life[i]) { L.kill(i); continue; }
      L.age[i] = age;

      let vx = L.vx[i], vy = L.vy[i], vz = L.vz[i];

      if (s.gravity !== 0) vy += s.gravity * dt;
      if (s.rise !== 0) vy += s.rise * dt;

      if (s.turbulence > 0) {
        const f = s.turbScale;
        const ts = t * s.turbSpeed + L.seed[i] * 6.2831853;
        const px = L.px[i], py = L.py[i], pz = L.pz[i];
        // A cheap divergence-light field: three orthogonal shears built from
        // four LUT lookups. Not true curl noise, but it swirls convincingly.
        const a = fastSin(pz * f + ts);
        const b = fastCos(px * f - ts * 0.83);
        const c = fastSin(py * f * 0.7 + ts * 1.31);
        const d = fastCos(pz * f * 1.13 - ts * 0.61);
        const k = s.turbulence * dt;
        vx += (a * d - c * 0.5) * k;
        vy += (b * c) * k * 0.75;
        vz += (c * b - a * 0.5) * k;
      }

      if (s.drag > 0) {
        // exact exponential drag — unconditionally stable
        const damp = Math.exp(-s.drag * dt);
        vx *= damp; vy *= damp; vz *= damp;
      }

      let y = L.py[i] + vy * dt;
      const flags = L.flags[i];

      // Ground plane recorded at spawn: no raycasts inside the particle loop.
      if ((flags & F_BOUNCE) !== 0 && y < L.groundY[i]) {
        y = L.groundY[i];
        if ((flags & F_STICK) !== 0) {
          vx = 0; vy = 0; vz = 0;
          L.rotVel[i] = 0;
          if ((flags & F_FADE_OUT_ON_STOP) !== 0) {
            const remain = L.life[i] - age;
            if (remain > 0.25) L.life[i] = age + 0.25;
          }
        } else if (vy < 0) {
          vy = -vy * s.bounce;
          const fr = 1 - s.groundFriction;
          vx *= fr; vz *= fr;
          L.rotVel[i] *= fr;
          // settle instead of jittering forever on a micro-bounce
          if (vy < 0.12) { vy = 0; L.groundY[i] = -1e6; }
        }
      }

      L.px[i] += vx * dt;
      L.pz[i] += vz * dt;
      L.py[i] = y;
      L.vx[i] = vx; L.vy[i] = vy; L.vz[i] = vz;
      L.rot[i] += L.rotVel[i] * dt;
      i++;
    }
  }

  /** Evaluate the curves and fill the GPU attributes. @param {ParticleLayer} L */
  _pack(L) {
    const styles = this.styles;
    const P = L.aPos, C = L.aColor, X = L.aXform, V = L.aVel;
    for (let i = 0; i < L.count; i++) {
      const s = styles[L.styleId[i]];
      const life = L.life[i];
      const tn = life > 0 ? L.age[i] / life : 1;

      const i3 = i * 3, i4 = i * 4;
      P[i3] = L.px[i]; P[i3 + 1] = L.py[i]; P[i3 + 2] = L.pz[i];

      const size = L.size[i] * evalCurve(s.sizeCurve, tn);
      X[i4] = size;
      X[i4 + 1] = size * L.aspect[i];
      X[i4 + 2] = L.rot[i];

      let frame = L.frameBase[i];
      if (s.frames > 1) {
        if ((s.flags & F_LOOP_FRAME) !== 0) {
          frame = s.sprite + ((((L.age[i] * s.fps) | 0) + ((L.seed[i] * s.frames) | 0)) % s.frames);
        } else if ((s.flags & F_RANDOM_FRAME) === 0) {
          const f = (tn * s.frames) | 0;
          frame = s.sprite + (f >= s.frames ? s.frames - 1 : f);
        }
      }
      X[i4 + 3] = frame;

      const lum = evalCurve(s.colorCurve, tn) * s.intensity;
      let a = evalCurve(s.alphaCurve, tn) * L.alpha[i];
      if (a < 0) a = 0; else if (a > 1) a = 1;
      C[i4] = lerp(s.cr0, s.cr1, tn) * L.cr[i] * lum;
      C[i4 + 1] = lerp(s.cg0, s.cg1, tn) * L.cg[i] * lum;
      C[i4 + 2] = lerp(s.cb0, s.cb1, tn) * L.cb[i] * lum;
      C[i4 + 3] = a;

      if (V) {
        // STREAK: velocity. GROUND: plane normal (stored in the same slots).
        V[i4] = L.vx[i]; V[i4 + 1] = L.vy[i]; V[i4 + 2] = L.vz[i];
        V[i4 + 3] = s.stretch;
      }
    }
  }

  // ───────────────────────────────────────────────────────── misc

  /** Kill every live particle. */
  clear() {
    for (const L of this.layers) { L.clear(); L.upload(); }
    this.stats.alive = 0;
  }

  /** Per-layer colour multiplier (nitro pushes the additive layer hotter). */
  setIntensity(layerKind, v) {
    const L = this.layers[layerKind];
    if (L) L.material.uniforms.uIntensity.value = v;
    return this;
  }

  /** How full a layer is, 0..1 — emitters throttle themselves with this. */
  pressure(layerKind) {
    const L = this.layers[layerKind];
    return L ? L.count / L.capacity : 1;
  }

  getStats() { return this.stats; }
}

// ─────────────────────────────────────────────────────────── helpers

/** hex (sRGB) | [r,g,b] (already linear) | THREE.Color → [r,g,b] linear */
export function toLinearRGB(c) {
  if (Array.isArray(c)) return [c[0], c[1], c[2]];
  if (c && c.isColor) return [c.r, c.g, c.b];
  _col.setHex((c ?? 0xffffff) >>> 0, THREE.SRGBColorSpace);
  return [_col.r, _col.g, _col.b];
}

export default ParticleSystem;
