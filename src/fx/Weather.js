/**
 * RC RUMBLE — ambient atmosphere.
 *
 * The thing that separates a good-looking track from a *place* is that the air
 * has something in it. Three layers, all optional per track:
 *
 * 1. **Motes / pollen.** A persistent cloud of tiny specks in a box that follows
 *    the camera and wraps around, so you are always inside it and it never
 *    "runs out". Indoors they read as dust in a sunbeam (additive, bright when
 *    you look toward the sun); outdoors as pollen (warmer, slower, drifting).
 *    Its own tiny instanced mesh, not the particle pool — it must never compete
 *    with gameplay FX for the budget.
 *
 * 2. **Falling leaves.** Emitted from a ceiling plane above the camera, tumbling
 *    and swirling on a wind field, settling and fading when they touch down.
 *    Uses the shared particle pool at a very low rate.
 *
 * 3. **God rays.** Soft additive quads suspended between the camera and the sun,
 *    faded by how directly you are looking into it and blanked when the track
 *    geometry is between you and the sun (one throttled raycast). Cheap, and it
 *    gives the museum's windows and the garden's canopy an obvious light source.
 *
 * Tracks opt in with `TrackData.environment.weather`:
 * ```js
 * weather: {
 *   motes: 0.6,          // 0..1 density of the speck cloud
 *   moteStyle: 'dust',   // 'dust' | 'pollen' | 'snow' | 'ash'
 *   leaves: 0.4,         // 0..1 leaf fall rate
 *   leafColors: [0x8a9a34, 0xc07a22],
 *   godRays: 0.5,        // 0..1 shaft opacity
 *   wind: [0.35, 0, -0.1],
 *   boxSize: 14,         // metres, the mote cloud's extent
 * }
 * ```
 * If a track says nothing, we infer a sensible default from its skybox preset:
 * indoor → dust motes, outdoor → pollen + leaves + rays.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp, TAU } from '../core/MathUtils.js';
import { LAYER, frand, frandRange, toLinearRGB } from './ParticleSystem.js';
import { SPR, ATLAS_COLS, ATLAS_ROWS } from './ParticleAtlas.js';
import { resetOpts } from './Sparks.js';
import { createRayHit } from '../physics/index.js';

const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _sun = new THREE.Vector3(0.4, 0.85, 0.3);
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rayHit = createRayHit();

// ────────────────────────────────────────────────── mote cloud shader

const MOTE_VERT = /* glsl */`
precision highp float;

attribute vec3 aPos;
attribute vec2 aInfo;       // x = size (m), y = phase

uniform vec2 uAtlasTiles;
uniform vec2 uTile;
uniform float uTime;
uniform float uOpacity;
uniform vec3 uSunDirView;
uniform float uBackScatter;

varying vec2 vUv;
varying float vAlpha;

void main() {
  vec4 center = modelViewMatrix * vec4( aPos, 1.0 );

  // twinkle: a mote catching the light flickers as it rotates
  float tw = 0.55 + 0.45 * sin( uTime * 3.1 + aInfo.y * 31.4 );

  // Back-scatter: specks are far brighter when you look into the light.
  vec3 toCam = normalize( - center.xyz );
  float bs = max( dot( toCam, - uSunDirView ), 0.0 );
  float gain = mix( 1.0, 1.0 + 3.2 * pow( bs, 3.0 ), uBackScatter );

  // Fade out very close to the camera so specks never blanket the screen.
  float dist = length( center.xyz );
  float near = smoothstep( 0.10, 0.55, dist );
  float far = 1.0 - smoothstep( 6.0, 11.0, dist );

  vAlpha = uOpacity * tw * gain * near * far;

  vec2 p = position.xy;
  center.xy += p * aInfo.x * 2.0;
  vUv = ( uTile + vec2( uv.x, 1.0 - uv.y ) ) / uAtlasTiles;
  gl_Position = projectionMatrix * center;
}
`;

const MOTE_FRAG = /* glsl */`
precision highp float;

uniform sampler2D uAtlas;
uniform vec3 uColor;

varying vec2 vUv;
varying float vAlpha;

void main() {
  float a = texture2D( uAtlas, vUv ).a * vAlpha;
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( uColor * a, a );
}
`;

// ────────────────────────────────────────────────── god-ray shader

const RAY_VERT = /* glsl */`
precision highp float;

attribute vec3 aPos;
attribute vec4 aInfo;       // x = halfWidth, y = halfHeight, z = roll, w = phase

uniform float uTime;
uniform float uSizeScale;

varying vec2 vQuad;
varying float vPhase;

void main() {
  vec4 center = modelViewMatrix * vec4( aPos, 1.0 );
  float ca = cos( aInfo.z );
  float sa = sin( aInfo.z );
  vec2 p = position.xy;
  vec2 rp = vec2( p.x * ca - p.y * sa, p.x * sa + p.y * ca );
  center.xy += rp * vec2( aInfo.x, aInfo.y ) * 2.0 * uSizeScale;
  vQuad = p;
  vPhase = aInfo.w;
  gl_Position = projectionMatrix * center;
}
`;

const RAY_FRAG = /* glsl */`
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;

varying vec2 vQuad;
varying float vPhase;

void main() {
  // A shaft: soft across, long down, with a slow breathing shimmer.
  float across = 1.0 - smoothstep( 0.06, 0.5, abs( vQuad.x ) );
  float along = 1.0 - smoothstep( 0.15, 0.5, abs( vQuad.y ) );
  float shimmer = 0.82 + 0.18 * sin( uTime * 0.9 + vPhase * 6.28 + vQuad.y * 5.0 );
  float a = across * across * along * uOpacity * shimmer;
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( uColor * a, a );
}
`;

// ────────────────────────────────────────────────── mote presets

const MOTE_PRESETS = Object.freeze({
  dust: {
    sprite: SPR.MOTE, color: 0xfff2dc, size: [0.0018, 0.0055],
    drift: 0.055, rise: 0.018, opacity: 0.55, backScatter: 1.0, swirl: 0.35,
  },
  pollen: {
    sprite: SPR.POLLEN, color: 0xfff0b8, size: [0.0025, 0.0068],
    drift: 0.085, rise: 0.030, opacity: 0.42, backScatter: 0.85, swirl: 0.55,
  },
  snow: {
    sprite: SPR.SOFT, color: 0xf4fbff, size: [0.0030, 0.0075],
    drift: 0.13, rise: -0.22, opacity: 0.65, backScatter: 0.35, swirl: 0.7,
  },
  ash: {
    sprite: SPR.SOFT, color: 0x8e8880, size: [0.0022, 0.0060],
    drift: 0.10, rise: -0.06, opacity: 0.45, backScatter: 0.2, swirl: 0.5,
  },
});

// ────────────────────────────────────────────────────────────── system

export class Weather {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {import('./ParticleSystem.js').ParticleSystem} particles
   */
  constructor(game, particles) {
    this.game = game;
    this.P = particles;
    this.enabled = true;
    this.rate = 1;

    this.group = new THREE.Group();
    this.group.name = 'fx/weather';
    this.group.matrixAutoUpdate = false;

    /** Resolved settings for the current track. */
    this.settings = {
      motes: 0, moteStyle: 'dust', leaves: 0, godRays: 0,
      wind: new THREE.Vector3(),
      boxSize: 12,
      leafColors: [0x7f9a2f, 0xb8892c, 0xc9622a],
    };

    // Motes survive even on 'low': they are sub-pixel quads, so the fill cost is
    // negligible and they are most of what makes an indoor track feel like a
    // room rather than a diorama. God rays do not — those are big additive
    // quads and they are the first thing to go.
    this.moteCount = CONFIG.quality === 'low' ? 110
      : CONFIG.quality === 'medium' ? 220
        : CONFIG.quality === 'ultra' ? 640 : 380;

    this._motePos = null;
    this._moteInfo = null;
    this._moteVel = null;
    this._moteMesh = null;

    this.rayCount = CONFIG.quality === 'low' ? 0
      : (CONFIG.quality === 'ultra' ? 7 : 5);
    this._rayPos = null;
    this._rayInfo = null;
    this._rayMesh = null;
    this._rayOcclusion = 1;
    this._rayCheck = 0;

    this._leafAcc = 0;
    this.time = 0;
    this.styles = {};
    this.stats = { motes: 0, rays: 0, leaves: 0, occlusion: 1 };
    this._atlas = null;
  }

  // ─────────────────────────────────────────────────────────── build

  init(atlas) {
    this._atlas = atlas ?? this.P?.atlas ?? null;
    this._buildMotes();
    this._buildRays();
    this._defineStyles();
    return this;
  }

  _defineStyles() {
    const P = this.P;
    if (!P) return;
    const S = this.styles;

    S.leaf = P.defineStyle('fx/weather/leaf', {
      layer: LAYER.ALPHA,
      sprite: SPR.LEAF, frames: 4, frameMode: 'random',
      life: [4.5, 9.0],
      size: [0.008, 0.018],
      alpha: 0.92,
      alphaCurve: [0, 1, 1, 0],
      // Very light gravity + heavy drag = the fluttery descent of a real leaf.
      gravity: CONFIG.physics.gravity * 0.030,
      drag: 1.5,
      turbulence: 1.35, turbScale: 1.6, turbSpeed: 0.55,
      spin: [-2.6, 2.6],
      bounce: 0.05,
      stick: true,
      fadeOnStop: true,
      sizeJitter: 0.35,
    });

    S.petal = P.defineStyle('fx/weather/petal', {
      layer: LAYER.ALPHA,
      sprite: SPR.SOFT,
      life: [3.5, 7.0],
      size: [0.004, 0.009],
      aspect: 1.4,
      alpha: 0.7,
      alphaCurve: [0, 1, 1, 0],
      gravity: CONFIG.physics.gravity * 0.020,
      drag: 1.8,
      turbulence: 1.1, turbScale: 2.0, turbSpeed: 0.6,
      spin: [-3.5, 3.5],
    });

    S.fleck = P.defineStyle('fx/weather/fleck', {
      layer: LAYER.ADD,
      sprite: SPR.MOTE,
      life: [2.0, 5.0],
      size: [0.0014, 0.0035],
      alpha: 0.55,
      alphaCurve: [0, 1, 0.8, 0],
      color: 0xfff0d0,
      intensity: 1.5,
      gravity: CONFIG.physics.gravity * 0.004,
      drag: 1.0,
      turbulence: 0.9, turbScale: 2.4, turbSpeed: 0.4,
    });
  }

  _buildMotes() {
    if (this.moteCount <= 0) return;
    const n = this.moteCount;
    this._motePos = new Float32Array(n * 3);
    this._moteInfo = new Float32Array(n * 2);
    this._moteVel = new Float32Array(n * 3);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.attrMotePos = new THREE.InstancedBufferAttribute(this._motePos, 3)
      .setUsage(THREE.DynamicDrawUsage);
    this.attrMoteInfo = new THREE.InstancedBufferAttribute(this._moteInfo, 2)
      .setUsage(THREE.StaticDrawUsage);
    geo.setAttribute('aPos', this.attrMotePos);
    geo.setAttribute('aInfo', this.attrMoteInfo);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const preset = MOTE_PRESETS.dust;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this._atlas },
        uAtlasTiles: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
        uTile: { value: new THREE.Vector2(preset.sprite % ATLAS_COLS, (preset.sprite / ATLAS_COLS) | 0) },
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uColor: { value: new THREE.Color(1, 0.95, 0.86) },
        uSunDirView: { value: new THREE.Vector3(0, 0, 1) },
        uBackScatter: { value: 1 },
      },
      vertexShader: MOTE_VERT,
      fragmentShader: MOTE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    mat.name = 'fx/weather/motes';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/weather/motes';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 14;
    mesh.userData.noCollision = true;
    this._moteMesh = mesh;
    this.group.add(mesh);
  }

  _buildRays() {
    if (this.rayCount <= 0) return;
    const n = this.rayCount;
    this._rayPos = new Float32Array(n * 3);
    this._rayInfo = new Float32Array(n * 4);

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this.attrRayPos = new THREE.InstancedBufferAttribute(this._rayPos, 3)
      .setUsage(THREE.DynamicDrawUsage);
    this.attrRayInfo = new THREE.InstancedBufferAttribute(this._rayInfo, 4)
      .setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.attrRayPos);
    geo.setAttribute('aInfo', this.attrRayInfo);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1, 0.93, 0.78) },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
        uSizeScale: { value: 1 },
      },
      vertexShader: RAY_VERT,
      fragmentShader: RAY_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    mat.name = 'fx/weather/godRays';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/weather/godRays';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 13;
    mesh.userData.noCollision = true;
    this._rayMesh = mesh;
    this.group.add(mesh);

    // Fixed shaft geometry — only the anchor position moves.
    for (let i = 0; i < n; i++) {
      const i4 = i * 4;
      this._rayInfo[i4] = frandRange(0.22, 0.75);      // half width
      this._rayInfo[i4 + 1] = frandRange(1.6, 3.4);    // half height
      this._rayInfo[i4 + 2] = 0;                        // roll, set per frame
      this._rayInfo[i4 + 3] = frand();                  // shimmer phase
    }
  }

  attach(parent) { parent?.add(this.group); return this; }

  // ─────────────────────────────────────────────────────── race hooks

  /**
   * Resolve the atmosphere for a track. Accepts `TrackData.environment` (it reads
   * `.weather` and falls back to inferring from `.skybox`).
   * @param {object|null} environment
   */
  apply(environment) {
    const s = this.settings;
    const w = environment?.weather;

    // ── infer a default from the skybox when the track says nothing ──
    const sky = typeof environment?.skybox === 'string'
      ? environment.skybox
      : environment?.skybox?.preset ?? environment?.skybox?.mode ?? 'day';
    const indoor = sky === 'museum' || sky === 'supermarket' || sky === 'studio'
      || environment?.skybox?.mode === 'indoor';

    if (w) {
      s.motes = clamp01(w.motes ?? (indoor ? 0.6 : 0.35));
      s.moteStyle = w.moteStyle ?? (indoor ? 'dust' : 'pollen');
      s.leaves = clamp01(w.leaves ?? (indoor ? 0 : 0.3));
      s.godRays = clamp01(w.godRays ?? (indoor ? 0.55 : 0.35));
      s.boxSize = clamp(w.boxSize ?? 12, 3, 60);
      if (Array.isArray(w.wind)) s.wind.set(w.wind[0] ?? 0, w.wind[1] ?? 0, w.wind[2] ?? 0);
      else if (w.wind?.isVector3) s.wind.copy(w.wind);
      else s.wind.set(indoor ? 0.04 : 0.30, 0, indoor ? 0.02 : -0.12);
      if (Array.isArray(w.leafColors) && w.leafColors.length) s.leafColors = w.leafColors;
    } else {
      s.motes = indoor ? 0.60 : 0.30;
      s.moteStyle = indoor ? 'dust' : 'pollen';
      s.leaves = indoor ? 0 : 0.28;
      s.godRays = indoor ? 0.55 : 0.30;
      s.boxSize = indoor ? 10 : 16;
      s.wind.set(indoor ? 0.04 : 0.30, 0, indoor ? 0.02 : -0.12);
    }

    // ── configure the mote cloud ──
    const preset = MOTE_PRESETS[s.moteStyle] ?? MOTE_PRESETS.dust;
    this._motePreset = preset;
    if (this._moteMesh) {
      const u = this._moteMesh.material.uniforms;
      u.uTile.value.set(preset.sprite % ATLAS_COLS, (preset.sprite / ATLAS_COLS) | 0);
      const c = toLinearRGB(preset.color);
      u.uColor.value.setRGB(c[0], c[1], c[2]);
      u.uBackScatter.value = preset.backScatter;
      u.uOpacity.value = 0;               // ramps up in update()
      u.uAtlas.value = this._atlas ?? this.P?.atlas ?? null;
      this._seedMotes();
      this._moteMesh.geometry.instanceCount = s.motes > 0.01 ? this.moteCount : 0;
    }

    if (this._rayMesh) {
      this._rayMesh.geometry.instanceCount = s.godRays > 0.01 ? this.rayCount : 0;
      const col = environment?.sun?.color;
      if (col !== undefined) {
        const c = toLinearRGB(col);
        this._rayMesh.material.uniforms.uColor.value.setRGB(c[0], c[1], c[2]);
      }
    }
    this._rayOcclusion = 1;
    return this;
  }

  /** Distribute motes randomly through the follow box. */
  _seedMotes() {
    const n = this.moteCount;
    if (n <= 0 || !this._motePos) return;
    const preset = this._motePreset ?? MOTE_PRESETS.dust;
    const half = this.settings.boxSize * 0.5;
    const cam = this.game?.camera;
    if (cam) _camPos.setFromMatrixPosition(cam.matrixWorld);
    else _camPos.set(0, 1, 0);

    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      this._motePos[i3] = _camPos.x + frandRange(-half, half);
      this._motePos[i3 + 1] = _camPos.y + frandRange(-half * 0.45, half * 0.75);
      this._motePos[i3 + 2] = _camPos.z + frandRange(-half, half);
      const i2 = i * 2;
      this._moteInfo[i2] = frandRange(preset.size[0], preset.size[1]);
      this._moteInfo[i2 + 1] = frand();
      this._moteVel[i3] = frandRange(-1, 1) * preset.drift;
      this._moteVel[i3 + 1] = preset.rise + frandRange(-0.3, 0.3) * preset.drift;
      this._moteVel[i3 + 2] = frandRange(-1, 1) * preset.drift;
    }
    this.attrMotePos.needsUpdate = true;
    this.attrMoteInfo.needsUpdate = true;
    this.attrMoteInfo.clearUpdateRanges();
  }

  onRaceEnd() {
    if (this._moteMesh) this._moteMesh.material.uniforms.uOpacity.value = 0;
    if (this._rayMesh) this._rayMesh.material.uniforms.uOpacity.value = 0;
  }

  // ─────────────────────────────────────────────────────────── update

  /**
   * @param {number} dt real-ish seconds (weather keeps drifting while paused so
   *   a paused frame does not look dead — pass the sim dt if you disagree)
   * @param {THREE.Camera} camera
   */
  update(dt, camera) {
    if (!this.enabled || !camera) return;
    this.time += dt;

    _camPos.setFromMatrixPosition(camera.matrixWorld);
    _camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    if (_camFwd.lengthSq() < 1e-8) _camFwd.set(0, 0, -1);
    else _camFwd.normalize();

    this._readSun();
    this._updateMotes(dt, camera);
    this._updateRays(dt);
    this._updateLeaves(dt);
  }

  _readSun() {
    const lighting = this.game?.renderer?.lighting;
    // `lighting.lightDirection` is the published contract: a unit vector along
    // the direction light TRAVELS, so negate it for "toward the sun". Do NOT go
    // back to `sun.position - sunTarget.position` — with CSM running, `sun` is a
    // parked, invisible placeholder and its position is not authoritative.
    const lit = lighting?.lightDirection;
    if (lit && lit.lengthSq() > 1e-8) {
      _sun.copy(lit).normalize().negate();
      return;
    }
    const sun = lighting?.sun;
    if (sun) {
      _v.copy(sun.position);
      const tgt = lighting.sunTarget?.position;
      if (tgt) _v.sub(tgt);
      if (_v.lengthSq() > 1e-8) _sun.copy(_v).normalize();
    } else {
      const skyDir = this.game?.renderer?.sky?.sunDirection;
      if (skyDir && skyDir.lengthSq() > 1e-8) _sun.copy(skyDir).normalize();
    }
  }

  _updateMotes(dt, camera) {
    const mesh = this._moteMesh;
    if (!mesh || this.settings.motes <= 0.01 || this.moteCount <= 0) {
      if (mesh) mesh.geometry.instanceCount = 0;
      this.stats.motes = 0;
      return;
    }
    const preset = this._motePreset ?? MOTE_PRESETS.dust;
    const u = mesh.material.uniforms;

    // ease in so a track load does not pop a cloud of specks into existence
    u.uOpacity.value = lerp(u.uOpacity.value,
      preset.opacity * this.settings.motes * this.rate, clamp01(dt * 2.2));
    u.uTime.value = this.time;

    // sun direction in view space
    _v.copy(_sun);
    _v.transformDirection(camera.matrixWorldInverse);
    u.uSunDirView.value.copy(_v).normalize();

    const P = this._motePos, V = this._moteVel;
    const half = this.settings.boxSize * 0.5;
    const wind = this.settings.wind;
    const swirl = preset.swirl;
    const t = this.time;

    const cx = _camPos.x, cy = _camPos.y, cz = _camPos.z;
    const yLo = cy - half * 0.45, yHi = cy + half * 0.75;

    for (let i = 0; i < this.moteCount; i++) {
      const i3 = i * 3;
      let x = P[i3], y = P[i3 + 1], z = P[i3 + 2];

      // gentle swirl so motes never travel in straight lines
      const ph = this._moteInfo[i * 2 + 1] * 6.2831853;
      const sx = Math.sin(t * 0.55 + ph) * swirl * 0.045;
      const sy = Math.sin(t * 0.41 + ph * 1.7) * swirl * 0.030;
      const sz = Math.cos(t * 0.48 + ph * 0.7) * swirl * 0.045;

      x += (V[i3] + wind.x + sx) * dt;
      y += (V[i3 + 1] + wind.y + sy) * dt;
      z += (V[i3 + 2] + wind.z + sz) * dt;

      // wrap around the follow box: the cloud is effectively infinite
      if (x < cx - half) x += half * 2; else if (x > cx + half) x -= half * 2;
      if (z < cz - half) z += half * 2; else if (z > cz + half) z -= half * 2;
      if (y < yLo) y = yHi; else if (y > yHi) y = yLo;

      P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
    }

    mesh.geometry.instanceCount = this.moteCount;
    rangeAll(this.attrMotePos, this.moteCount * 3);
    this.stats.motes = this.moteCount;
  }

  _updateRays(dt) {
    const mesh = this._rayMesh;
    const s = this.settings;
    if (!mesh || s.godRays <= 0.01 || this.rayCount <= 0) {
      if (mesh) mesh.geometry.instanceCount = 0;
      this.stats.rays = 0;
      return;
    }
    const u = mesh.material.uniforms;
    u.uTime.value = this.time;

    // How directly are we looking into the sun? Shafts only exist toward it.
    const facing = clamp01(_camFwd.dot(_sun) * 0.5 + 0.5);
    const aim = Math.pow(clamp01((facing - 0.42) / 0.58), 1.6);

    // Throttled occlusion test: if the track is between us and the sun, no rays.
    this._rayCheck -= dt;
    if (this._rayCheck <= 0) {
      this._rayCheck = 0.12;
      const physics = this.game?.physics;
      let occ = 1;
      if (physics?.raycastTrack) {
        _v.copy(_camPos).addScaledVector(_sun, 0.05);
        occ = physics.raycastTrack(_v, _sun, 30, _rayHit) ? 0 : 1;
      }
      this._rayOcclusion = lerp(this._rayOcclusion, occ, 0.5);
    }
    this.stats.occlusion = this._rayOcclusion;

    const target = s.godRays * aim * this._rayOcclusion * 0.24 * this.rate;
    u.uOpacity.value = lerp(u.uOpacity.value, target, clamp01(dt * 3.5));
    if (u.uOpacity.value < 0.002) {
      mesh.geometry.instanceCount = 0;
      this.stats.rays = 0;
      return;
    }

    // Anchor the shafts in a fan between the camera and the sun. They live at a
    // fixed distance so they never intersect the car or the near plane.
    _right.crossVectors(_sun, _up.set(0, 1, 0));
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _sun).normalize();

    // roll the quads so they line up with the sun direction on screen
    const roll = Math.atan2(_sun.x * _camFwd.z - _sun.z * _camFwd.x, _sun.y);

    for (let i = 0; i < this.rayCount; i++) {
      const i3 = i * 3, i4 = i * 4;
      const spread = ((i / Math.max(this.rayCount - 1, 1)) - 0.5) * 2;
      const dist = 4.5 + (i % 3) * 1.1;
      const lateral = spread * 1.5 + Math.sin(this.time * 0.23 + i) * 0.18;
      const vertical = 0.7 + Math.sin(this.time * 0.17 + i * 2.1) * 0.25;
      this._rayPos[i3] = _camPos.x + _sun.x * dist + _right.x * lateral + _up.x * vertical;
      this._rayPos[i3 + 1] = _camPos.y + _sun.y * dist + _right.y * lateral + _up.y * vertical;
      this._rayPos[i3 + 2] = _camPos.z + _sun.z * dist + _right.z * lateral + _up.z * vertical;
      this._rayInfo[i4 + 2] = roll + spread * 0.10;
    }

    mesh.geometry.instanceCount = this.rayCount;
    rangeAll(this.attrRayPos, this.rayCount * 3);
    rangeAll(this.attrRayInfo, this.rayCount * 4);
    this.stats.rays = this.rayCount;
  }

  _updateLeaves(dt) {
    const P = this.P;
    const s = this.settings;
    if (!P || s.leaves <= 0.01) return;

    const rate = s.leaves * 5.5 * this.rate;
    this._leafAcc += rate * dt;
    let n = this._leafAcc | 0;
    this._leafAcc -= n;
    if (n > 3) n = 3;
    if (n <= 0) return;

    const half = s.boxSize * 0.45;
    const o = resetOpts(_opts);
    o.speedJitter = 0.5;

    // Ground plane for the settle: sample the track under the spawn point once.
    for (let k = 0; k < n; k++) {
      const x = _camPos.x + frandRange(-half, half);
      const z = _camPos.z + frandRange(-half, half);
      const y = _camPos.y + frandRange(1.6, 3.2);

      let groundY = _camPos.y - 3;
      const physics = this.game?.physics;
      if (physics?.raycastTrack) {
        _v.set(x, y, z);
        _up.set(0, -1, 0);
        if (physics.raycastTrack(_v, _up, 12, _rayHit)) groundY = _rayHit.point.y + 0.004;
      }
      o.groundY = groundY;

      const useLeaf = frand() < 0.72;
      const colors = s.leafColors;
      const c = toLinearRGB(colors[(frand() * colors.length) | 0]);
      o.r = c[0]; o.g = c[1]; o.b = c[2];
      o.rot = frand() * TAU;
      o.spin = frandRange(-2.6, 2.6);

      P.spawn(useLeaf ? this.styles.leaf : this.styles.petal, x, y, z,
        s.wind.x * frandRange(0.6, 1.5) + frandRange(-0.12, 0.12),
        -frandRange(0.10, 0.30),
        s.wind.z * frandRange(0.6, 1.5) + frandRange(-0.12, 0.12), o);
      this.stats.leaves++;
    }
    o.rot = undefined;
    o.spin = undefined;
  }

  // ─────────────────────────────────────────────────────── one-shots

  /**
   * A puff of ambient specks — a car brushing a bush, a prop being knocked over.
   * @param {THREE.Vector3|{x,y,z}} point
   * @param {number} [count]
   * @param {number|number[]} [color]
   */
  disturb(point, count = 8, color) {
    const P = this.P;
    if (!P || !this.enabled) return;
    const o = resetOpts(_opts);
    o.speedJitter = 0.6;
    o.radius = 0.03;
    if (color !== undefined) {
      const c = toLinearRGB(color);
      o.r = c[0]; o.g = c[1]; o.b = c[2];
    }
    P.burstCone(this.styles.fleck, point.x, point.y, point.z, 0, 1, 0,
      0.35, 0.95, Math.round(count * this.rate), o);
  }

  clear() {
    this._leafAcc = 0;
  }

  dispose() {
    this._moteMesh?.geometry.dispose();
    this._moteMesh?.material.dispose();
    this._rayMesh?.geometry.dispose();
    this._rayMesh?.material.dispose();
    this.group.removeFromParent();
  }
}

function rangeAll(attr, count) {
  let r = attr._rcRange;
  if (!r) { r = { start: 0, count: 0 }; attr._rcRange = r; }
  r.start = 0;
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

export { MOTE_PRESETS };
export default Weather;
