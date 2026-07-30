/**
 * RC RUMBLE — persistent tyre marks.
 *
 * The single most nostalgic detail in Re-Volt: black rubber ribbons that stay on
 * the museum parquet lap after lap and slowly fade, so by lap three you can read
 * the racing line off the floor.
 *
 * Implementation
 * --------------
 * One geometry, one draw call, `q(CONFIG.fx.tireMarkSegments)` quads in a ring
 * buffer. Each wheel owns a *writer* that remembers the last pair of contact-patch
 * edge points; when the wheel has moved far enough and is still slipping, we
 * stitch a new quad from the old edge pair to the new one. Because the ring is a
 * FIFO and the fade is purely time based, the quad we are about to overwrite is
 * always the most faded one — recycling is free.
 *
 * The fade happens entirely on the GPU: every vertex carries its birth time, and
 * the shader computes `1 - (uNow - birth) / uFade`. Zero CPU cost for thousands
 * of live segments.
 *
 * Surface awareness (see SurfaceFX.js):
 *   • hard floors  → dark rubber, crisp, narrow
 *   • loose ground → displaced material, lighter than the ground, wide and soft
 *   • ice          → pale scratch
 *   • oil / water  → wet smear / nothing at all
 */

import * as THREE from 'three';
import CONFIG, { q } from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/MathUtils.js';
import { surfaceFX, MARK } from './SurfaceFX.js';
import { SPR, ATLAS_COLS, ATLAS_ROWS } from './ParticleAtlas.js';

const VERT_SHADER = /* glsl */`
precision highp float;

attribute vec4 aColor;      // rgb (linear) + peak alpha
attribute vec2 aFade;       // x = birth time, y = lifetime multiplier

uniform float uNow;
uniform float uFade;

varying vec2 vUv;
varying vec4 vColor;
varying float vAge;

#ifdef USE_FOG
  varying float vFogDepth;
#endif

void main() {
  vUv = uv;
  vColor = aColor;
  float life = max( uFade * aFade.y, 0.05 );
  vAge = clamp( ( uNow - aFade.x ) / life, 0.0, 1.0 );
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  #ifdef USE_FOG
    vFogDepth = - mv.z;
  #endif
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG_SHADER = /* glsl */`
precision highp float;

uniform sampler2D uAtlas;
uniform vec2 uAtlasTiles;
uniform vec2 uTile;         // atlas cell (col,row) for the mark grain
uniform float uEdgeSoft;

varying vec2 vUv;
varying vec4 vColor;
varying float vAge;

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
  // vUv.x runs across the ribbon (0..1), vUv.y runs along it and is used to
  // scroll the grain so a long skid does not show an obvious tiling period.
  vec2 cell = ( uTile + vec2( fract( vUv.x ), fract( vUv.y ) ) ) / uAtlasTiles;
  float grain = texture2D( uAtlas, cell ).a;

  // Feather the ribbon edges — a hard-edged quad strip screams "decal".
  float edge = smoothstep( 0.0, uEdgeSoft, vUv.x ) * smoothstep( 0.0, uEdgeSoft, 1.0 - vUv.x );

  float fade = 1.0 - vAge;
  fade *= fade;                       // fade out slowly, then quickly

  float a = vColor.a * edge * fade * mix( 0.55, 1.0, grain );
  if ( a < 0.004 ) discard;

  vec3 rgb = vColor.rgb;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogF = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    rgb = mix( rgb, fogColor, fogF );
  #endif
  gl_FragColor = vec4( rgb * a, a );
}
`;

const _v = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Per-wheel ribbon writer. Purely bookkeeping; the geometry lives in TireMarks.
 */
class MarkWriter {
  constructor() {
    this.active = false;
    this.lastLx = 0; this.lastLy = 0; this.lastLz = 0;
    this.lastRx = 0; this.lastRy = 0; this.lastRz = 0;
    this.lastCx = 0; this.lastCy = 0; this.lastCz = 0;
    this.lastV = 0;              // ribbon-length coordinate, for grain scrolling
    this.lastAlpha = 0;
    this.lastSurface = -1;
    this.idle = 0;
  }
  reset() {
    this.active = false;
    this.lastV = 0;
    this.lastAlpha = 0;
    this.lastSurface = -1;
    this.idle = 0;
  }
}

export class TireMarks {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {{atlas:THREE.Texture|null, maxSegments?:number}} opts
   */
  constructor(game, opts = {}) {
    this.game = game;
    this.enabled = true;

    this.maxSegments = Math.max(64, opts.maxSegments ?? q(CONFIG.fx.tireMarkSegments) ?? 1024);
    this.fadeSeconds = CONFIG.fx.tireMarkFade ?? 14;

    /** Minimum travel before a new quad is emitted, metres. */
    this.minStep = 0.022;
    /** Longest single quad; beyond this we break the ribbon (teleport/respawn). */
    this.maxStep = 0.55;
    /** Skid intensity below which nothing is laid down. */
    this.threshold = 0.12;
    /** How far above the surface the ribbon floats, metres. */
    this.lift = 0.0035;

    this.time = 0;
    this.head = 0;
    this.live = 0;

    /** @type {MarkWriter[]} indexed by carId*4 + wheelIndex */
    this.writers = [];
    for (let i = 0; i < CONFIG.race.maxCars * 4; i++) this.writers.push(new MarkWriter());

    this._atlas = opts.atlas ?? null;
    this.geometry = null;
    this.material = null;
    this.mesh = null;

    this._pos = null;
    this._uv = null;
    this._col = null;
    this._fade = null;
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;

    this.stats = { segments: 0, live: 0, emitted: 0 };
  }

  // ─────────────────────────────────────────────────────────── build

  init() {
    const n = this.maxSegments;
    const verts = n * 4;

    this._pos = new Float32Array(verts * 3);
    this._uv = new Float32Array(verts * 2);
    this._col = new Float32Array(verts * 4);
    this._fade = new Float32Array(verts * 2);

    // Every quad starts fully expired so nothing shows before it is written.
    for (let i = 0; i < verts; i++) {
      this._fade[i * 2] = -1e6;
      this._fade[i * 2 + 1] = 1;
    }

    const index = new Uint32Array(n * 6);
    for (let s = 0; s < n; s++) {
      const v = s * 4;
      const o = s * 6;
      index[o] = v; index[o + 1] = v + 1; index[o + 2] = v + 2;
      index[o + 3] = v; index[o + 4] = v + 2; index[o + 5] = v + 3;
    }

    const geo = new THREE.BufferGeometry();
    this.attrPos = new THREE.BufferAttribute(this._pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.attrUv = new THREE.BufferAttribute(this._uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.attrCol = new THREE.BufferAttribute(this._col, 4).setUsage(THREE.DynamicDrawUsage);
    this.attrFade = new THREE.BufferAttribute(this._fade, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.attrPos);
    geo.setAttribute('uv', this.attrUv);
    geo.setAttribute('aColor', this.attrCol);
    geo.setAttribute('aFade', this.attrFade);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geo;

    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uAtlas: { value: null },
        uAtlasTiles: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
        uTile: { value: new THREE.Vector2(SPR.SCUFF % ATLAS_COLS, (SPR.SCUFF / ATLAS_COLS) | 0) },
        uNow: { value: 0 },
        uFade: { value: this.fadeSeconds },
        uEdgeSoft: { value: 0.30 },
      },
    ]);
    uniforms.uAtlas.value = this._atlas;

    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT_SHADER,
      fragmentShader: FRAG_SHADER,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: true,
      // premultiplied alpha
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: false,
      // The ribbon sits a few millimetres above the floor; polygon offset kills
      // the last of the z-fighting on shallow viewing angles.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
    });
    mat.name = 'fx/tireMarks';
    this.material = mat;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fx/tireMarks';
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 4;              // under the particles, over the track
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.noCollision = true;
    this.mesh = mesh;

    this.stats.segments = n;
    return this;
  }

  setAtlas(tex) {
    this._atlas = tex;
    if (this.material) this.material.uniforms.uAtlas.value = tex;
    return this;
  }

  attach(parent) { parent?.add(this.mesh); return this; }

  // ─────────────────────────────────────────────────────────── per-frame

  /**
   * Poll every wheel of every car and lay down ribbon where appropriate.
   * @param {number} dt simulated seconds
   * @param {import('../vehicle/Car.js').Car[]} cars
   * @param {number} [rate] 0..1 global FX load scalar
   */
  update(dt, cars, rate = 1) {
    if (!this.enabled || !this.mesh) return;
    this.time += dt;
    this.material.uniforms.uNow.value = this.time;

    if (cars && dt > 0 && rate > 0.05) {
      for (let c = 0; c < cars.length; c++) this._updateCar(cars[c], dt);
    }

    this._flush();
    this.stats.live = this.live;
  }

  _updateCar(car, dt) {
    const wheels = car?.wheels;
    if (!wheels) return;
    const carId = (car.id | 0) & 7;

    const bodyVel = car.body?.velocity;
    const speed = bodyVel ? bodyVel.length() : Math.abs(car.speed ?? 0);

    for (let w = 0; w < wheels.length && w < 4; w++) {
      const wheel = wheels[w];
      const writer = this.writers[carId * 4 + w];
      if (!wheel) { writer.reset(); continue; }

      if (!wheel.contact) {
        writer.idle += dt;
        // A short hop should not break a continuous skid; a real flight should.
        if (writer.idle > 0.08) writer.reset();
        continue;
      }
      writer.idle = 0;

      const sid = wheel.surfaceId | 0;
      const fx = surfaceFX(sid);
      if (fx.markStyle === MARK.NONE) { writer.reset(); continue; }

      const intensity = this._intensity(wheel, car, speed);
      if (intensity < this.threshold) {
        // keep the anchor so a stuttering skid stitches instead of restarting,
        // but do not emit
        this._anchor(writer, wheel, car);
        continue;
      }
      if (writer.lastSurface !== sid) {
        // Surface change: restart so a dark rubber ribbon never bleeds into a
        // pale sand one across a single quad.
        this._anchor(writer, wheel, car);
        writer.lastSurface = sid;
        continue;
      }

      this._emit(writer, wheel, car, fx, intensity, speed);
    }
  }

  /**
   * How hard is this wheel marking the ground, 0..1.
   * Lateral slip dominates (that is a drift), but locked wheels under braking
   * and spinning wheels under power leave marks too.
   */
  _intensity(wheel, car, speed) {
    let t = clamp01(wheel.skidIntensity ?? 0);

    // Derive a fallback if the vehicle system has not filled skidIntensity.
    if (t === 0) {
      const slipA = Math.abs(wheel.slipAngle ?? 0);
      const slipR = Math.abs(wheel.slipRatio ?? 0);
      t = clamp01(Math.max(slipA / 0.42, (slipR - 0.14) / 0.55));
    }

    // Load matters: an unloaded inside wheel barely touches the floor.
    const load = wheel.load;
    if (typeof load === 'number' && load > 0) {
      const nominal = (car.body?.mass ?? 1.6) * 19.6 * 0.25;
      t *= clamp(load / Math.max(nominal, 0.05), 0.15, 1.6);
    }

    // No marks when crawling: rubber needs speed to smear.
    t *= clamp01((speed - 0.35) / 1.1);

    // Handbrake and heavy braking bias the look darker.
    const hb = car.handbrake ?? 0;
    if (hb > 0.2) t = Math.max(t, hb * 0.75 * clamp01((speed - 0.5) / 2.0));

    return clamp01(t);
  }

  /** Record the current contact patch edges without emitting a quad. */
  _anchor(writer, wheel, car) {
    if (!this._patch(wheel, car)) { writer.active = false; return; }
    writer.lastLx = _v.x - _right.x; writer.lastLy = _v.y - _right.y; writer.lastLz = _v.z - _right.z;
    writer.lastRx = _v.x + _right.x; writer.lastRy = _v.y + _right.y; writer.lastRz = _v.z + _right.z;
    writer.lastCx = _v.x; writer.lastCy = _v.y; writer.lastCz = _v.z;
    writer.active = true;
    writer.lastAlpha = 0;
    writer.lastSurface = wheel.surfaceId | 0;
  }

  /**
   * Compute the contact patch: `_v` = lifted centre, `_right` = half-width
   * vector across the ribbon. Returns false if we cannot place it.
   */
  _patch(wheel, car) {
    const cp = wheel.contactPoint;
    if (!cp) return false;

    _n.copy(wheel.contactNormal ?? _up.set(0, 1, 0));
    if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0);
    else _n.normalize();

    _v.copy(cp).addScaledVector(_n, this.lift);

    // Ribbon runs along the wheel's travel direction, so the width vector is
    // the wheel's axle direction projected onto the contact plane.
    const grp = car.group;
    if (grp) {
      _right.setFromMatrixColumn(grp.matrixWorld, 0);   // car +X
      _fwd.setFromMatrixColumn(grp.matrixWorld, 2).negate();
    } else if (car.body) {
      car.body.getRight(_right);
      car.body.getForward(_fwd);
    } else {
      _right.set(1, 0, 0);
      _fwd.set(0, 0, -1);
    }

    // Steered wheels lay their mark along their own heading.
    const steer = wheel.steerAngle ?? 0;
    if (steer !== 0) {
      const cs = Math.cos(steer), sn = Math.sin(steer);
      const rx = _right.x * cs - _fwd.x * sn;
      const ry = _right.y * cs - _fwd.y * sn;
      const rz = _right.z * cs - _fwd.z * sn;
      _right.set(rx, ry, rz);
    }

    // Project onto the contact plane and normalize.
    _right.addScaledVector(_n, -_right.dot(_n));
    if (_right.lengthSq() < 1e-8) return false;
    _right.normalize();

    const fxs = surfaceFX(wheel.surfaceId | 0);
    const halfWidth = Math.max(0.006, (wheel.width ?? 0.028) * 0.5 * fxs.markWidth);
    _right.multiplyScalar(halfWidth);
    return true;
  }

  _emit(writer, wheel, car, fx, intensity, speed) {
    if (!this._patch(wheel, car)) return;

    const cx = _v.x, cy = _v.y, cz = _v.z;
    if (!writer.active) {
      writer.lastLx = cx - _right.x; writer.lastLy = cy - _right.y; writer.lastLz = cz - _right.z;
      writer.lastRx = cx + _right.x; writer.lastRy = cy + _right.y; writer.lastRz = cz + _right.z;
      writer.lastCx = cx; writer.lastCy = cy; writer.lastCz = cz;
      writer.active = true;
      writer.lastAlpha = 0;
      writer.lastSurface = wheel.surfaceId | 0;
      return;
    }

    const dx = cx - writer.lastCx, dy = cy - writer.lastCy, dz = cz - writer.lastCz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < this.minStep) return;
    if (dist > this.maxStep) {
      // teleport / respawn / huge hitch — restart the ribbon
      writer.lastLx = cx - _right.x; writer.lastLy = cy - _right.y; writer.lastLz = cz - _right.z;
      writer.lastRx = cx + _right.x; writer.lastRy = cy + _right.y; writer.lastRz = cz + _right.z;
      writer.lastCx = cx; writer.lastCy = cy; writer.lastCz = cz;
      writer.lastAlpha = 0;
      return;
    }

    // ── colour & opacity for this surface ──
    const mc = fx.markColor;
    let alpha = fx.markAlpha * intensity;

    // Loose surfaces lighten as they dry/settle; hard surfaces darken with heat.
    if (fx.markStyle === MARK.DISPLACED) {
      alpha *= lerp(0.75, 1.15, clamp01(speed / 7));
    } else if (fx.markStyle === MARK.RUBBER) {
      // a long slide burns progressively blacker, exactly like the original
      alpha *= lerp(0.8, 1.25, clamp01(writer.lastAlpha / Math.max(fx.markAlpha, 0.01)));
    }
    alpha = clamp01(alpha);

    // Life multiplier: soft displaced trails settle back faster than rubber.
    const lifeMul = fx.markStyle === MARK.DISPLACED ? 0.55
      : fx.markStyle === MARK.SCUFF ? 0.7
        : fx.markStyle === MARK.SMEAR ? 0.85 : 1.0;

    const nlx = cx - _right.x, nly = cy - _right.y, nlz = cz - _right.z;
    const nrx = cx + _right.x, nry = cy + _right.y, nrz = cz + _right.z;

    const v0 = writer.lastV;
    const v1 = v0 + dist / Math.max(0.055, (wheel.width ?? 0.028) * 2.2);

    this._writeQuad(
      writer.lastLx, writer.lastLy, writer.lastLz,
      writer.lastRx, writer.lastRy, writer.lastRz,
      nrx, nry, nrz,
      nlx, nly, nlz,
      v0, v1,
      mc[0], mc[1], mc[2],
      writer.lastAlpha, alpha,
      lifeMul,
    );

    writer.lastLx = nlx; writer.lastLy = nly; writer.lastLz = nlz;
    writer.lastRx = nrx; writer.lastRy = nry; writer.lastRz = nrz;
    writer.lastCx = cx; writer.lastCy = cy; writer.lastCz = cz;
    writer.lastV = v1 % 64;
    writer.lastAlpha = alpha;
    this.stats.emitted++;
  }

  /**
   * Write one quad into the ring buffer.
   * Vertex order: (0) prev-left, (1) prev-right, (2) new-right, (3) new-left.
   */
  _writeQuad(
    ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx2, dy2, dz2,
    v0, v1, r, g, b, alpha0, alpha1, lifeMul,
  ) {
    const s = this.head;
    this.head = (this.head + 1) % this.maxSegments;
    if (this.live < this.maxSegments) this.live++;

    const p = s * 12;
    const P = this._pos;
    P[p] = ax; P[p + 1] = ay; P[p + 2] = az;
    P[p + 3] = bx; P[p + 4] = by; P[p + 5] = bz;
    P[p + 6] = cx2; P[p + 7] = cy2; P[p + 8] = cz2;
    P[p + 9] = dx2; P[p + 10] = dy2; P[p + 11] = dz2;

    const u = s * 8;
    const U = this._uv;
    U[u] = 0; U[u + 1] = v0;
    U[u + 2] = 1; U[u + 3] = v0;
    U[u + 4] = 1; U[u + 5] = v1;
    U[u + 6] = 0; U[u + 7] = v1;

    const C = this._col;
    const F = this._fade;
    const now = this.time;
    const c = s * 16;
    // ramp the alpha along the ribbon so a skid fades in and out smoothly
    const a0 = alpha0, a1 = alpha1;
    C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = a0;
    C[c + 4] = r; C[c + 5] = g; C[c + 6] = b; C[c + 7] = a0;
    C[c + 8] = r; C[c + 9] = g; C[c + 10] = b; C[c + 11] = a1;
    C[c + 12] = r; C[c + 13] = g; C[c + 14] = b; C[c + 15] = a1;

    const f = s * 8;
    for (let k = 0; k < 4; k++) {
      F[f + k * 2] = now;
      F[f + k * 2 + 1] = lifeMul;
    }

    if (s < this._dirtyMin) this._dirtyMin = s;
    if (s > this._dirtyMax) this._dirtyMax = s;
  }

  /** Upload only the quads we touched this frame. */
  _flush() {
    if (this._dirtyMax < this._dirtyMin) return;
    const lo = this._dirtyMin;
    const n = this._dirtyMax - lo + 1;
    range(this.attrPos, lo * 12, n * 12);
    range(this.attrUv, lo * 8, n * 8);
    range(this.attrCol, lo * 16, n * 16);
    range(this.attrFade, lo * 8, n * 8);
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
  }

  // ─────────────────────────────────────────────────────────── control

  /** Break every ribbon belonging to a car (respawn, teleport, race restart). */
  resetCar(carId) {
    const base = ((carId | 0) & 7) * 4;
    for (let w = 0; w < 4; w++) this.writers[base + w]?.reset();
  }

  /** Break every ribbon. */
  resetAll() {
    for (const w of this.writers) w.reset();
  }

  /** Wipe the marks themselves. */
  clear() {
    this.resetAll();
    const F = this._fade;
    if (F) for (let i = 0; i < F.length; i += 2) F[i] = -1e6;
    this.head = 0;
    this.live = 0;
    if (this.attrFade) {
      this.attrFade.clearUpdateRanges();
      this.attrFade.needsUpdate = true;
    }
    this._dirtyMin = Infinity;
    this._dirtyMax = -Infinity;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
    this.mesh?.removeFromParent();
  }
}

/** Reused update-range record per attribute — no garbage. */
function range(attr, start, count) {
  let r = attr._rcRange;
  if (!r) { r = { start: 0, count: 0 }; attr._rcRange = r; }
  r.start = start;
  r.count = count;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(r);
  attr.needsUpdate = true;
}

export default TireMarks;
