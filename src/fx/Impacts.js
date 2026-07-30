/**
 * RC RUMBLE — impacts.
 *
 * Three pieces, all impulse-scaled:
 *
 * 1. **Debris.** Real 3D chunks, not sprites: a pooled instanced mesh of small
 *    faceted lumps that tumble, bounce and settle. Sprites are fine for dust but
 *    a solid object breaking needs to be solid, and at RC scale the chunks are
 *    2–8 mm so a hundred of them is nothing. Lit with a cheap two-light model in
 *    the shader (no CSM patching, no dependency on the lighting rig).
 *
 * 2. **Shockwave ring.** A flat expanding ring on the contact plane for heavy
 *    hits, plus a screen-facing flash ring for explosions. This is what makes a
 *    big hit *read* at a glance.
 *
 * 3. **Screen flash hook.** `screenFlash()` forwards to `postfx.flash()`. It is
 *    deliberately **not** wired to `car:collision` / `car:land` / `weapon:hit`,
 *    because RenderSystem already flashes on those; doubling up would blow the
 *    frame out. Explosions and imperative bursts use it.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/MathUtils.js';
import { surfaceFX, chassisFX } from './SurfaceFX.js';
import { LAYER, frand, frandRange, toLinearRGB } from './ParticleSystem.js';
import { SPR } from './ParticleAtlas.js';
import { resetOpts } from './Sparks.js';

const GRAV = CONFIG.physics.gravity;

const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();

// ────────────────────────────────────────────────────── debris shader

const DEBRIS_VERT = /* glsl */`
precision highp float;

attribute vec3 aOffset;
attribute vec4 aQuat;       // orientation
attribute vec4 aColor;      // rgb + alpha
attribute float aScale;

uniform vec3 uSunDir;       // world space, toward the light
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;

varying vec3 vLight;
varying float vAlpha;
varying vec3 vTint;

#ifdef USE_FOG
  varying float vFogDepth;
#endif

vec3 rotateByQuat( vec3 v, vec4 q ) {
  vec3 t = 2.0 * cross( q.xyz, v );
  return v + q.w * t + cross( q.xyz, t );
}

void main() {
  vec3 local = rotateByQuat( position * aScale, aQuat );
  vec3 world = local + aOffset;
  vec3 nrm = normalize( rotateByQuat( normal, aQuat ) );

  float ndl = max( dot( nrm, uSunDir ), 0.0 );
  float up = nrm.y * 0.5 + 0.5;
  vLight = mix( uGroundColor, uSkyColor, up ) + uSunColor * ndl;
  vAlpha = aColor.a;
  vTint = aColor.rgb;

  vec4 mv = viewMatrix * vec4( world, 1.0 );
  #ifdef USE_FOG
    vFogDepth = - mv.z;
  #endif
  gl_Position = projectionMatrix * mv;
}
`;

const DEBRIS_FRAG = /* glsl */`
precision highp float;

varying vec3 vLight;
varying float vAlpha;
varying vec3 vTint;

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

void main() {
  if ( vAlpha < 0.01 ) discard;
  vec3 rgb = vTint * vLight;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogF = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    rgb = mix( rgb, fogColor, fogF );
  #endif
  gl_FragColor = vec4( rgb * vAlpha, vAlpha );
}
`;

/**
 * A small irregular faceted lump. Flat-shaded (per-face normals) so it catches
 * the light in distinct planes and reads as a solid chunk when it tumbles.
 */
function makeChunkGeometry(seed = 1) {
  // Start from an octahedron and jitter the vertices, then explode into
  // independent triangles so each face gets its own normal.
  const base = new THREE.OctahedronGeometry(0.5, 0);
  const pos = base.getAttribute('position');
  let s = seed | 0 || 1;
  const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 4294967296) - 0.5;
  };
  // jitter unique vertices consistently by rounding the position as a key
  const map = new Map();
  for (let i = 0; i < pos.count; i++) {
    const kx = Math.round(pos.getX(i) * 1000);
    const ky = Math.round(pos.getY(i) * 1000);
    const kz = Math.round(pos.getZ(i) * 1000);
    const key = `${kx},${ky},${kz}`;
    let j = map.get(key);
    if (!j) {
      j = [pos.getX(i) * (1 + rnd() * 0.7), pos.getY(i) * (1 + rnd() * 0.7), pos.getZ(i) * (1 + rnd() * 0.7)];
      map.set(key, j);
    }
    pos.setXYZ(i, j[0], j[1], j[2]);
  }
  // PolyhedronGeometry is already non-indexed, so every triangle owns its
  // vertices and computeVertexNormals() gives us flat per-face shading.
  const geo = base.index ? base.toNonIndexed() : base;
  if (geo !== base) base.dispose();
  geo.computeVertexNormals();
  return geo;
}

class DebrisPool {
  constructor(capacity) {
    this.capacity = Math.max(8, capacity | 0);
    this.count = 0;

    const n = this.capacity;
    this.px = new Float32Array(n); this.py = new Float32Array(n); this.pz = new Float32Array(n);
    this.vx = new Float32Array(n); this.vy = new Float32Array(n); this.vz = new Float32Array(n);
    this.wx = new Float32Array(n); this.wy = new Float32Array(n); this.wz = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.groundY = new Float32Array(n);
    this.bounce = new Float32Array(n);
    this.rest = new Uint8Array(n);

    this.aOffset = new Float32Array(n * 3);
    this.aQuat = new Float32Array(n * 4);
    this.aColor = new Float32Array(n * 4);
    this.aScale = new Float32Array(n);

    this.geometry = null;
    this.material = null;
    this.mesh = null;
  }

  build() {
    const chunk = makeChunkGeometry(0x51a7);
    const geo = new THREE.InstancedBufferGeometry();
    // Copy the arrays rather than sharing the BufferAttributes: disposing the
    // source geometry would take the shared GPU buffers with it.
    geo.setAttribute('position',
      new THREE.BufferAttribute(chunk.getAttribute('position').array.slice(), 3));
    geo.setAttribute('normal',
      new THREE.BufferAttribute(chunk.getAttribute('normal').array.slice(), 3));
    chunk.dispose();

    const mk = (arr, item) => {
      const a = new THREE.InstancedBufferAttribute(arr, item);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.attrOffset = mk(this.aOffset, 3);
    this.attrQuat = mk(this.aQuat, 4);
    this.attrColor = mk(this.aColor, 4);
    this.attrScale = mk(this.aScale, 1);
    geo.setAttribute('aOffset', this.attrOffset);
    geo.setAttribute('aQuat', this.attrQuat);
    geo.setAttribute('aColor', this.attrColor);
    geo.setAttribute('aScale', this.attrScale);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
        uSunColor: { value: new THREE.Color(0.85, 0.82, 0.76) },
        uSkyColor: { value: new THREE.Color(0.32, 0.36, 0.42) },
        uGroundColor: { value: new THREE.Color(0.14, 0.12, 0.11) },
      },
    ]);

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: DEBRIS_VERT,
      fragmentShader: DEBRIS_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: true,        // debris is opaque geometry; it should occlude
      fog: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    mat.name = 'fx/debris';
    this.material = mat;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/debris';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 3;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.noCollision = true;
    this.mesh = mesh;
    return this;
  }

  alloc() {
    if (this.count < this.capacity) return this.count++;
    // recycle the most-expired chunk
    let best = -1, bestT = 0.4;
    for (let k = 0; k < 6; k++) {
      const i = (this._cursor = ((this._cursor | 0) + 613) % this.capacity);
      const t = this.life[i] > 0 ? this.age[i] / this.life[i] : 1;
      if (t > bestT) { bestT = t; best = i; }
    }
    return best;
  }

  kill(i) {
    const last = --this.count;
    if (i === last) return;
    // Written out longhand on purpose: a helper closure here would allocate on
    // every dying chunk.
    this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
    this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
    this.wx[i] = this.wx[last]; this.wy[i] = this.wy[last]; this.wz[i] = this.wz[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.groundY[i] = this.groundY[last];
    this.bounce[i] = this.bounce[last];
    this.rest[i] = this.rest[last];
    const a = i * 4, b = last * 4;
    this.aQuat[a] = this.aQuat[b]; this.aQuat[a + 1] = this.aQuat[b + 1];
    this.aQuat[a + 2] = this.aQuat[b + 2]; this.aQuat[a + 3] = this.aQuat[b + 3];
    this.aColor[a] = this.aColor[b]; this.aColor[a + 1] = this.aColor[b + 1];
    this.aColor[a + 2] = this.aColor[b + 2]; this.aColor[a + 3] = this.aColor[b + 3];
    this.aScale[i] = this.aScale[last];
  }

  clear() { this.count = 0; this.geometry.instanceCount = 0; }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh?.removeFromParent();
  }
}

export class Impacts {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {import('./ParticleSystem.js').ParticleSystem} particles
   * @param {import('./Decals.js').Decals|null} decals
   */
  constructor(game, particles, decals) {
    this.game = game;
    this.P = particles;
    this.decals = decals;
    this.enabled = true;
    this.rate = 1;

    const cap = CONFIG.quality === 'low' ? 48
      : CONFIG.quality === 'medium' ? 96
        : CONFIG.quality === 'ultra' ? 256 : 160;
    this.debris = new DebrisPool(cap);

    /** Impulse thresholds. */
    this.minImpulse = 1.2;
    this.ringImpulse = 6.0;
    this.heavyImpulse = 14.0;

    this.styles = {};
    this.stats = { impacts: 0, debris: 0, rings: 0 };
    this._lightDirty = 0;
  }

  init() {
    this.debris.build();

    const P = this.P;
    if (!P) return this;
    const S = this.styles;

    // ── flat shockwave ring on the contact plane ──
    S.ring = P.defineStyle('fx/impact/ring', {
      layer: LAYER.GROUND,
      sprite: SPR.RING_HARD,
      life: [0.26, 0.42],
      size: [0.05, 0.09],
      sizeCurve: [0.15, 1.3, 2.6, 3.6],
      alpha: 0.85,
      alphaCurve: [1, 0.75, 0.3, 0],
      color: 0xfff0d8,
      colorCurve: [2.4, 1.5, 0.6, 0],
    });

    // ── camera-facing shock ring for explosions ──
    S.blastRing = P.defineStyle('fx/impact/blastRing', {
      layer: LAYER.ADD,
      sprite: SPR.RING_HARD,
      life: [0.20, 0.34],
      size: [0.06, 0.10],
      sizeCurve: [0.2, 1.6, 3.2, 4.6],
      alpha: 0.9,
      alphaCurve: [1, 0.7, 0.25, 0],
      color: 0xffe8c0,
      colorCurve: [3.2, 1.8, 0.7, 0],
      drag: 4,
    });

    // ── the white core flash at the contact point ──
    S.flash = P.defineStyle('fx/impact/flash', {
      layer: LAYER.ADD,
      sprite: SPR.GLOW,
      life: [0.07, 0.16],
      size: [0.03, 0.09],
      sizeCurve: [0.5, 1.3, 1.0, 0.35],
      alpha: 1,
      alphaCurve: [1, 0.85, 0.35, 0],
      color: 0xfff6e6,
      colorCurve: [4.5, 2.6, 1.0, 0],
      drag: 6,
    });

    // ── paint/plastic flecks: cheaper than real debris, used in bulk ──
    S.fleck = P.defineStyle('fx/impact/fleck', {
      layer: LAYER.ALPHA,
      sprite: SPR.CHIP, frames: 4, frameMode: 'random',
      life: [0.5, 1.2],
      size: [0.003, 0.009],
      alpha: 1,
      alphaCurve: [1, 1, 0.9, 0],
      gravity: GRAV,
      drag: 0.35,
      bounce: 0.3,
      groundFriction: 0.45,
      spin: [-24, 24],
      sizeJitter: 0.35,
    });

    // ── impact dust: whatever the surface is made of, punched into the air ──
    S.dust = P.defineStyle('fx/impact/dust', {
      layer: LAYER.LIT,
      sprite: SPR.SMOKE, frames: 8, frameMode: 'life',
      life: [0.5, 1.1],
      size: [0.025, 0.065],
      sizeCurve: [0.4, 1.2, 1.9, 2.5],
      alpha: 0.40,
      alphaCurve: [0, 1, 0.55, 0],
      gravity: GRAV * 0.03,
      drag: 2.6,
      rise: 0.8,
      turbulence: 2.2, turbScale: 4,
      spin: [-1.2, 1.2],
      sizeJitter: 0.3,
    });

    return this;
  }

  attach(parent) { parent?.add(this.debris.mesh); return this; }

  // ─────────────────────────────────────────────────────────── events

  /**
   * A car/prop collision.
   *
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {THREE.Vector3|{x,y,z}|null} normal
   * @param {number} impulse N·s
   * @param {number} relSpeed m/s
   * @param {number} surfaceId
   * @param {string} chassis
   * @param {number|number[]} [carColor] sRGB hex or linear triplet for paint flecks
   */
  collision(point, normal, impulse, relSpeed, surfaceId, chassis, carColor) {
    const P = this.P;
    if (!this.enabled || !P) return;
    if (impulse < this.minImpulse) return;

    const surf = surfaceFX(surfaceId);
    const chas = chassisFX(chassis);
    const s = clamp01((impulse - this.minImpulse) / (this.heavyImpulse - this.minImpulse));

    _n.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    const px = point.x + _n.x * 0.006;
    const py = point.y + _n.y * 0.006;
    const pz = point.z + _n.z * 0.006;

    const o = resetOpts(_opts);
    o.groundY = point.y - 0.006;

    // ── core flash ──
    o.sizeMul = lerp(0.55, 1.7, s);
    o.alpha = lerp(0.35, 1, s);
    P.spawn(this.styles.flash, px, py, pz, 0, 0, 0, o);

    // ── surface dust punched out of the wall ──
    if (surf.dustiness > 0.04) {
      resetOpts(o);
      const c = surf.sprayColor;
      o.r = c[0]; o.g = c[1]; o.b = c[2];
      o.speedJitter = 0.55;
      o.radius = 0.010 + s * 0.014;
      o.sizeMul = lerp(0.7, 1.8, s);
      o.groundY = point.y - 0.006;
      const n = Math.round(lerp(2, 16, s) * surf.dustiness * this.rate);
      P.burstCone(this.styles.dust, px, py, pz, _n.x, _n.y + 0.45, _n.z,
        0.5 + s * 2.2, 0.9, n, o);
    }

    // ── paint flecks in the car's own colour ──
    if (s > 0.14) {
      resetOpts(o);
      const c = carColor !== undefined ? toLinearRGB(carColor) : chas.hot;
      o.r = c[0]; o.g = c[1]; o.b = c[2];
      o.speedJitter = 0.6;
      o.radius = 0.008;
      o.groundY = point.y - 0.006;
      o.sizeMul = lerp(0.8, 1.5, s);
      const n = Math.round(lerp(2, 18, s) * this.rate);
      P.burstCone(this.styles.fleck, px, py, pz, _n.x, _n.y + 0.55, _n.z,
        0.8 + s * 3.4, 0.95, n, o);
    }

    // ── shockwave ring on heavy hits ──
    if (impulse >= this.ringImpulse) {
      const rs = clamp01((impulse - this.ringImpulse) / (this.heavyImpulse - this.ringImpulse));
      const ro = resetOpts(_opts2);
      ro.sizeMul = lerp(0.7, 1.9, rs);
      ro.alpha = lerp(0.45, 1, rs);
      P.spawn(this.styles.ring, px, py, pz, _n.x, _n.y, _n.z, ro);
      this.stats.rings++;
    }

    // ── real 3D debris: only for genuinely big impacts ──
    if (impulse >= this.ringImpulse * 0.8) {
      const dn = Math.round(lerp(2, 14, s) * this.rate);
      const col = carColor !== undefined ? toLinearRGB(carColor) : surf.sprayColor;
      this.spawnDebris(px, py, pz, _n.x, _n.y + 0.5, _n.z,
        1.0 + s * 4.0, dn, {
          r: col[0], g: col[1], b: col[2],
          size: lerp(0.004, 0.012, s),
          groundY: point.y,
          life: lerp(1.4, 3.0, s),
        });
    }

    // ── scuff/soot decal where a hard hit ground into the wall ──
    if (this.decals && impulse >= this.ringImpulse && surf.decal > 0.4 && _n.y > 0.45) {
      this.decals.project('dustPatch', point, _n, lerp(0.05, 0.12, s), {
        alpha: 0.22 * s, life: lerp(4, 9, s),
      });
    }

    this.stats.impacts++;
  }

  /**
   * A landing. Softer than a collision: a ring, a puff and a settle, no flecks.
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {THREE.Vector3|{x,y,z}|null} normal
   * @param {number} impactSpeed m/s
   * @param {number} surfaceId
   */
  landing(point, normal, impactSpeed, surfaceId) {
    const P = this.P;
    if (!this.enabled || !P) return;
    const s = clamp01((Math.abs(impactSpeed) - 1.8) / 10);
    if (s <= 0.02) return;

    _n.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    const surf = surfaceFX(surfaceId);
    const ro = resetOpts(_opts2);
    ro.sizeMul = lerp(0.6, 2.1, s);
    ro.alpha = lerp(0.3, 0.85, s) * lerp(1, 0.5, surf.wet);
    P.spawn(this.styles.ring, point.x + _n.x * 0.004, point.y + _n.y * 0.004,
      point.z + _n.z * 0.004, _n.x, _n.y, _n.z, ro);

    if (s > 0.4 && surf.chips > 0.1) {
      const col = surf.sprayColor;
      this.spawnDebris(point.x, point.y + 0.006, point.z, _n.x, _n.y, _n.z,
        0.9 + s * 2.4, Math.round(lerp(1, 8, s)), {
          r: col[0], g: col[1], b: col[2],
          size: lerp(0.003, 0.008, s),
          groundY: point.y,
          life: lerp(1.2, 2.4, s),
        });
    }
    this.stats.impacts++;
  }

  /**
   * An explosion: a bright ball, a camera-facing shock ring, radial debris and a
   * scorch decal. Smoke is Smoke.js's job — FXSystem calls both.
   *
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {number} strength 0..1+
   * @param {THREE.Vector3|{x,y,z}|null} [normal] ground normal for the scorch
   */
  explosion(point, strength = 1, normal = null) {
    const P = this.P;
    if (!this.enabled || !P) return;
    const s = clamp(strength, 0, 2);

    const o = resetOpts(_opts);
    o.sizeMul = lerp(1.2, 3.4, s * 0.5);
    P.spawn(this.styles.flash, point.x, point.y, point.z, 0, 0, 0, o);

    const ro = resetOpts(_opts2);
    ro.sizeMul = lerp(1.0, 2.8, s * 0.5);
    P.spawn(this.styles.blastRing, point.x, point.y, point.z, 0, 0, 0, ro);
    ro.sizeMul *= 0.62;
    ro.lifeMul = 0.7;
    P.spawn(this.styles.blastRing, point.x, point.y, point.z, 0, 0, 0, ro);
    this.stats.rings += 2;

    // radial flecks + debris
    resetOpts(o);
    o.speedJitter = 0.6;
    o.radius = 0.012;
    o.groundY = point.y - 0.05;
    o.sizeMul = lerp(0.9, 1.8, s * 0.5);
    o.r = 0.55; o.g = 0.5; o.b = 0.46;
    const flecks = Math.round(lerp(10, 42, s * 0.5) * this.rate);
    for (let k = 0; k < flecks; k++) {
      const a = frand() * Math.PI * 2;
      const el = frandRange(-0.3, 1.0);
      const cl = Math.cos(el);
      P.burstCone(this.styles.fleck, point.x, point.y, point.z,
        Math.cos(a) * cl, Math.sin(el) + 0.25, Math.sin(a) * cl, 2.0 + s * 5.5, 0.25, 1, o);
    }

    const dn = Math.round(lerp(6, 22, s * 0.5) * this.rate);
    this.spawnDebris(point.x, point.y, point.z, 0, 1, 0, 2.2 + s * 4.5, dn, {
      r: 0.24, g: 0.21, b: 0.19,
      size: lerp(0.005, 0.013, s * 0.5),
      groundY: point.y - 0.02,
      life: lerp(1.8, 3.4, s * 0.5),
      spread: 1.6,
    });

    if (this.decals) {
      _d.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0);
      if (_d.lengthSq() < 1e-8) _d.set(0, 1, 0);
      _d.normalize();
      this.decals.project('scorch', point, _d, 0.10 + s * 0.16,
        { alpha: 0.75, life: 22 });
    }

    this.screenFlash(0xffd9a0, clamp01(0.30 * s), 0.20);
    this.stats.impacts++;
  }

  // ─────────────────────────────────────────────────────────── debris

  /**
   * Fire `n` solid chunks in a cone.
   *
   * @param {number} x @param {number} y @param {number} z
   * @param {number} dx @param {number} dy @param {number} dz
   * @param {number} speed
   * @param {number} n
   * @param {{r?:number,g?:number,b?:number,size?:number,groundY?:number,
   *          life?:number,spread?:number}} [o]
   */
  spawnDebris(x, y, z, dx, dy, dz, speed, n, o = {}) {
    const D = this.debris;
    if (!D.mesh || n <= 0) return;

    const len = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / len, ay = dy / len, az = dz / len;
    const spread = o.spread ?? 0.85;
    const size = o.size ?? 0.006;
    const life = o.life ?? 2.0;
    const gy = o.groundY ?? (y - 0.02);
    const r = o.r ?? 0.5, g = o.g ?? 0.5, b = o.b ?? 0.5;

    for (let k = 0; k < n; k++) {
      const i = D.alloc();
      if (i < 0) break;

      // random direction in the cone
      const a = frand() * Math.PI * 2;
      const t = Math.sqrt(frand()) * spread;
      let ox = ax + (Math.cos(a) * t);
      let oy = ay + (frandRange(-0.35, 0.35) * t) + t * 0.25;
      let oz = az + (Math.sin(a) * t);
      const ol = Math.hypot(ox, oy, oz) || 1;
      ox /= ol; oy /= ol; oz /= ol;
      const sp = speed * (0.45 + 0.55 * frand());

      D.px[i] = x + ox * 0.004;
      D.py[i] = y + oy * 0.004;
      D.pz[i] = z + oz * 0.004;
      D.vx[i] = ox * sp; D.vy[i] = oy * sp; D.vz[i] = oz * sp;
      D.wx[i] = frandRange(-26, 26);
      D.wy[i] = frandRange(-26, 26);
      D.wz[i] = frandRange(-26, 26);
      D.age[i] = 0;
      D.life[i] = life * (0.7 + frand() * 0.6);
      D.groundY[i] = gy;
      D.bounce[i] = 0.24 + frand() * 0.22;
      D.rest[i] = 0;

      // random start orientation
      _axis.set(frandRange(-1, 1), frandRange(-1, 1), frandRange(-1, 1));
      if (_axis.lengthSq() < 1e-6) _axis.set(0, 1, 0);
      _axis.normalize();
      _q.setFromAxisAngle(_axis, frand() * Math.PI * 2);
      const q4 = i * 4;
      D.aQuat[q4] = _q.x; D.aQuat[q4 + 1] = _q.y; D.aQuat[q4 + 2] = _q.z; D.aQuat[q4 + 3] = _q.w;

      D.aColor[q4] = r; D.aColor[q4 + 1] = g; D.aColor[q4 + 2] = b; D.aColor[q4 + 3] = 1;
      D.aScale[i] = size * (0.65 + frand() * 0.8);
      this.stats.debris++;
    }
  }

  /** @param {number} dt */
  update(dt, camera) {
    const D = this.debris;
    if (!D.mesh) return;
    if (dt > 0) this._simulateDebris(D, dt);
    this._packDebris(D);
    this._refreshDebrisLight();
    void camera;
  }

  _simulateDebris(D, dt) {
    let i = 0;
    while (i < D.count) {
      const age = D.age[i] + dt;
      if (age >= D.life[i]) { D.kill(i); continue; }
      D.age[i] = age;

      if (D.rest[i]) { i++; continue; }

      let vx = D.vx[i], vy = D.vy[i], vz = D.vz[i];
      vy += GRAV * dt;
      // mild air drag so tiny chunks do not fly like cannonballs
      const damp = Math.exp(-1.1 * dt);
      vx *= damp; vy *= damp; vz *= damp;

      let py = D.py[i] + vy * dt;
      if (py <= D.groundY[i]) {
        py = D.groundY[i];
        if (vy < 0) {
          vy = -vy * D.bounce[i];
          vx *= 0.62; vz *= 0.62;
          D.wx[i] *= 0.55; D.wy[i] *= 0.55; D.wz[i] *= 0.55;
          if (vy < 0.16) {
            // settle: freeze it where it lies and let it fade out
            D.rest[i] = 1;
            vx = 0; vy = 0; vz = 0;
            D.wx[i] = 0; D.wy[i] = 0; D.wz[i] = 0;
            const remain = D.life[i] - age;
            if (remain > 0.9) D.life[i] = age + 0.9;
          }
        }
      }

      D.px[i] += vx * dt;
      D.pz[i] += vz * dt;
      D.py[i] = py;
      D.vx[i] = vx; D.vy[i] = vy; D.vz[i] = vz;

      // integrate the orientation: q += 0.5 * ω ⊗ q, then renormalize
      const q4 = i * 4;
      const qx = D.aQuat[q4], qy = D.aQuat[q4 + 1], qz = D.aQuat[q4 + 2], qw = D.aQuat[q4 + 3];
      const h = dt * 0.5;
      const ox = D.wx[i] * h, oy = D.wy[i] * h, oz = D.wz[i] * h;
      let nx = qx + (oy * qz - oz * qy + ox * qw);
      let ny = qy + (oz * qx - ox * qz + oy * qw);
      let nz = qz + (ox * qy - oy * qx + oz * qw);
      let nw = qw - (ox * qx + oy * qy + oz * qz);
      const inv = 1 / (Math.hypot(nx, ny, nz, nw) || 1);
      D.aQuat[q4] = nx * inv; D.aQuat[q4 + 1] = ny * inv;
      D.aQuat[q4 + 2] = nz * inv; D.aQuat[q4 + 3] = nw * inv;
      i++;
    }
  }

  _packDebris(D) {
    const O = D.aOffset, C = D.aColor;
    for (let i = 0; i < D.count; i++) {
      const i3 = i * 3;
      O[i3] = D.px[i]; O[i3 + 1] = D.py[i]; O[i3 + 2] = D.pz[i];
      // fade out over the last 30% of life
      const tn = D.life[i] > 0 ? D.age[i] / D.life[i] : 1;
      C[i * 4 + 3] = tn < 0.7 ? 1 : clamp01((1 - tn) / 0.3);
    }
    D.geometry.instanceCount = D.count;
    if (D.count === 0) return;
    range(D.attrOffset, 0, D.count * 3);
    range(D.attrQuat, 0, D.count * 4);
    range(D.attrColor, 0, D.count * 4);
    range(D.attrScale, 0, D.count);
  }

  /** Keep the debris lighting roughly in step with the scene sun. */
  _refreshDebrisLight() {
    if (--this._lightDirty > 0) return;
    this._lightDirty = 15;                 // ~4× a second is plenty
    const lighting = this.game?.renderer?.lighting;
    const u = this.debris.material?.uniforms;
    if (!u) return;
    const sun = lighting?.sun;
    if (sun) {
      // `lightDirection` is the published contract (direction light TRAVELS, so
      // negate for "toward the sun"). `sun.position` is only a fallback: under
      // CSM the sun object is a parked, invisible placeholder.
      const lit = lighting.lightDirection;
      if (lit && lit.lengthSq() > 1e-8) {
        u.uSunDir.value.copy(lit).normalize().negate();
      } else {
        _d.copy(sun.position);
        const tgt = lighting.sunTarget?.position;
        if (tgt) _d.sub(tgt);
        if (_d.lengthSq() > 1e-8) u.uSunDir.value.copy(_d).normalize();
      }
      u.uSunColor.value.copy(sun.color).multiplyScalar(clamp(sun.intensity ?? 2, 0, 8) * 0.34);
    }
    const hemi = lighting?.hemi;
    if (hemi) {
      const hi = clamp(hemi.intensity ?? 1, 0, 6) * 0.42;
      u.uSkyColor.value.copy(hemi.color).multiplyScalar(hi);
      u.uGroundColor.value.copy(hemi.groundColor).multiplyScalar(hi * 0.75);
    }
  }

  // ─────────────────────────────────────────────────────── screen hook

  /**
   * Additive pre-tonemap screen flash, via the render system.
   *
   * NOTE: RenderSystem already flashes on 'weapon:hit', 'car:land' and
   * 'car:collision'. Do not call this from those paths.
   */
  screenFlash(color = 0xffffff, strength = 0.3, seconds = 0.18) {
    if (strength <= 0.002) return;
    this.game?.renderer?.postfx?.flash?.(color, strength, seconds);
  }

  /** Ask the camera for a shake — the camera system owns the actual response. */
  shake(amount, duration = 0.3) {
    if (amount <= 0.001) return;
    this.game?.bus?.emit('camera:shake', { amount, duration });
  }

  clear() { this.debris.clear(); }
  reset() { this.debris.clear(); }
  dispose() { this.debris.dispose(); }
}

function range(attr, start, count) {
  let r = attr._rcRange;
  if (!r) { r = { start: 0, count: 0 }; attr._rcRange = r; }
  r.start = start;
  r.count = count;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(r);
  attr.needsUpdate = true;
}

const _opts = {
  speedJitter: 0.5, radius: 0, groundY: -1e6,
  inheritX: 0, inheritY: 0, inheritZ: 0,
  r: 1, g: 1, b: 1, alpha: 1, sizeMul: 1, lifeMul: 1,
  size: undefined, life: undefined, aspect: undefined,
  rot: undefined, spin: undefined, frame: undefined,
};
const _opts2 = {
  speedJitter: 0.5, radius: 0, groundY: -1e6,
  inheritX: 0, inheritY: 0, inheritZ: 0,
  r: 1, g: 1, b: 1, alpha: 1, sizeMul: 1, lifeMul: 1,
  size: undefined, life: undefined, aspect: undefined,
  rot: undefined, spin: undefined, frame: undefined,
};

export default Impacts;
