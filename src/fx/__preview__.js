/**
 * RC RUMBLE — standalone FX preview / soak harness.
 *
 * Runs the whole FX system without a track, a car system or the render pipeline,
 * against a fake `game` object that satisfies exactly the interface FX reads.
 * Its jobs:
 *
 *   • **Compile every shader.** Six particle layers, tyre marks, decals, debris,
 *     motes and god rays are all custom `ShaderMaterial`s. A GLSL typo only ever
 *     shows up on a real GL context, and this is the cheapest way to get one.
 *   • **Eyeball the look** of each effect in isolation, side by side.
 *   • **Soak-test** the pools: it drives a car in a circle laying marks and
 *     firing every burst type on a rotation, forever.
 *
 * Usage from the console (or a Playwright `evaluate`):
 * ```js
 * const m = await import('/src/fx/__preview__.js');
 * window.PREVIEW = m.mountFXPreview(document.body);
 * PREVIEW.errors;        // [] if every shader compiled
 * ```
 */

import * as THREE from 'three';
import { Assets } from '../core/Assets.js';
import { EventBus } from '../core/EventBus.js';
import { FXSystem } from './FXSystem.js';

/** Burst types cycled by the soak loop, in a readable order. */
const BURST_CYCLE = [
  'explosion', 'sparks', 'impact', 'splash', 'smoke', 'steam', 'debris',
  'electro', 'freeze', 'oil', 'confetti', 'sparkle', 'flash', 'shockwave',
  'ripple', 'nitro', 'plume', 'leaves', 'scorch',
];

/** Surfaces walked through by the demo car, so every spray archetype is seen. */
const SURFACE_TOUR = [1, 4, 5, 6, 7, 8, 9, 10, 11, 15];

const _v = new THREE.Vector3();

/**
 * A car object that satisfies the `Car` contract from ARCHITECTURE.md closely
 * enough for every FX consumer.
 */
function makeDemoCar(id, isPlayer) {
  const group = new THREE.Group();
  group.name = `demoCar${id}`;
  const wheels = [];
  for (let w = 0; w < 4; w++) {
    const front = w < 2;
    const left = w % 2 === 0;
    wheels.push({
      index: w, isFront: front, isLeft: left, isDriven: true, isSteered: front,
      restPosition: new THREE.Vector3(left ? -0.075 : 0.075, -0.02, front ? -0.10 : 0.10),
      radius: 0.033, width: 0.028,
      compression: 0.45, prevCompression: 0.45, suspensionForce: 8,
      contact: true,
      contactPoint: new THREE.Vector3(),
      contactNormal: new THREE.Vector3(0, 1, 0),
      surfaceId: 1,
      angularVelocity: 180, rotation: 0, steerAngle: front ? 0.18 : 0,
      slipRatio: 0.35, slipAngle: 0.38, load: 4.2,
      lateralForce: 3, longitudinalForce: 2,
      isSpinning: false, isLocked: false, skidIntensity: 0.75,
      mesh: null,
    });
  }
  return {
    id, isPlayer,
    def: {
      id: 'preview', name: 'Preview', class: 'amateur', drive: '4wd',
      chassis: ['metal', 'plastic', 'glass'][id % 3],
      mass: 1.6, topSpeed: 9, accel: 6, weightFront: 0.5,
      colorPrimary: [0xd0201c, 0x2060d0, 0x20b050][id % 3],
      colorSecondary: 0xffffff,
      exhausts: [[0, 0.03, 0.13]],
    },
    body: {
      mass: 1.6,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      pointVelocity(p, out) { return out.copy(this.velocity); },
      getForward: (o) => o.set(0, 0, -1),
      getRight: (o) => o.set(1, 0, 0),
      getUp: (o) => o.set(0, 1, 0),
    },
    group, wheels,
    speed: 6, speedKmh: 120, rpm: 9000, gear: 2, engineLoad: 0.85,
    throttle: 1, brake: 0, steer: 0.35, handbrake: 0.5,
    slipAngle: 0.38, driftFactor: 0.8, lateralG: 1.1, longitudinalG: 0.4,
    wheelsOnGround: 4, airborne: false, airTime: 0, lastLandImpact: 0,
    upsideDown: false, stuckTime: 0, dominantSurfaceId: 1,
    lap: 0, checkpoint: 0, place: id + 1, progress: 0,
    lapTime: 0, bestLap: Infinity, totalTime: 0, finished: false, wrongWay: false,
    weapon: null,
    effects: { boost: 0, frozen: 0, shielded: 0, squashed: 0, electro: 0, oiled: 0 },
  };
}

/**
 * Build the preview world. Does **not** create a renderer — pass one in, or use
 * `mountFXPreview` which makes its own.
 *
 * @param {{renderer:THREE.WebGLRenderer, cars?:number, radius?:number}} opts
 */
export function buildFXPreview(opts = {}) {
  const scene = new THREE.Scene();
  scene.name = 'fx-preview';
  scene.background = new THREE.Color(0x10141a);
  scene.fog = new THREE.Fog(0x10141a, 4, 22);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.02, 400);
  camera.position.set(0, 1.15, 2.6);
  camera.lookAt(0, 0.12, 0);
  camera.updateMatrixWorld(true);

  // ── a lit floor so the soft-particle fade and the marks have something to
  //    sit on, and so the debris shader has geometry to occlude against ──
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x39414c, roughness: 0.92, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = false;
  scene.add(floor);

  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
  sun.position.set(3.2, 5.5, 2.4);
  const sunTarget = new THREE.Object3D();
  scene.add(sun, sunTarget);
  const hemi = new THREE.HemisphereLight(0x87a8d0, 0x2a2420, 1.15);
  scene.add(hemi);

  // A 1×1 stand-in for the render system's linear-depth buffer. Its only job is
  // to make the soft-particle sampler path real: the value is "very far", so
  // nothing is actually faded.
  const depthStub = new THREE.DataTexture(
    new Float32Array([1000, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType,
  );
  depthStub.needsUpdate = true;

  /** The subset of `Game` that FX actually reads. */
  const game = {
    bus: new EventBus(),
    scene,
    camera,
    cars: [],
    playerCar: null,
    assets: null,
    renderer: {
      renderer: opts.renderer ?? null,
      lighting: { sun, sunTarget, hemi },
      sky: { sunDirection: sun.position.clone().normalize() },
      postfx: {
        passes: { depthResolve: { enabled: true, texture: depthStub } },
        flash() {},
      },
      adaptive: { step: 0 },
      registerResizeTarget(fn) {
        this._t = this._t || [];
        this._t.push(fn);
        fn(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 2));
        return () => {};
      },
      _resize(w, h, pr) { for (const f of this._t || []) f(w, h, pr); },
    },
    // No collision mesh, so decals will queue and find nothing to project onto —
    // exactly the "missing collaborator" path we want exercised.
    physics: {
      trackMesh: null,
      raycastTrack(o, d, max, out) { out.hit = false; return false; },
      surfaceBelow() { return 1; },
    },
  };
  game.assets = new Assets(game);

  const fx = new FXSystem(game);

  const carCount = opts.cars ?? 3;
  for (let i = 0; i < carCount; i++) game.cars.push(makeDemoCar(i, i === 0));
  game.playerCar = game.cars[0];

  const state = {
    scene, camera, game, fx, floor, depthStub,
    t: 0,
    burstTimer: 0,
    burstIndex: 0,
    surfaceTimer: 0,
    surfaceIndex: 0,
    radius: opts.radius ?? 1.15,
    ready: false,
  };

  return state;
}

/** Advance the preview by `dt` seconds. */
export function updateFXPreview(state, dt) {
  const { game, fx } = state;
  state.t += dt;

  // ── drive the demo cars in circles at different phases ──
  const speed = 5.5;
  for (let i = 0; i < game.cars.length; i++) {
    const car = game.cars[i];
    const r = state.radius + i * 0.42;
    const w = speed / r;
    const a = state.t * w + (i * Math.PI * 2) / game.cars.length;

    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    car.group.position.set(x, 0.045, z);
    // face along the tangent
    car.group.rotation.set(0, -a + Math.PI * 0.5, 0);
    // lean into the corner, like a real chassis would
    car.group.rotation.z = 0.14;
    car.group.updateMatrixWorld(true);

    car.body.position.copy(car.group.position);
    car.body.velocity.set(-Math.sin(a) * speed, 0, Math.cos(a) * speed);
    car.speed = speed;

    // slip oscillates so the marks, smoke and dust all pulse
    const slip = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(state.t * 0.9 + i));
    car.driftFactor = slip;

    // car 0 boosts every few seconds
    car.effects.boost = (i === 0 && Math.sin(state.t * 0.55) > 0.35) ? 1 : 0;

    const sid = SURFACE_TOUR[(state.surfaceIndex + i) % SURFACE_TOUR.length];
    car.dominantSurfaceId = sid;
    for (let k = 0; k < 4; k++) {
      const wheel = car.wheels[k];
      _v.copy(wheel.restPosition).applyMatrix4(car.group.matrixWorld);
      wheel.contactPoint.set(_v.x, 0, _v.z);
      wheel.contactNormal.set(0, 1, 0);
      wheel.surfaceId = sid;
      wheel.skidIntensity = slip;
      wheel.slipAngle = slip * 0.45;
      wheel.slipRatio = slip * 0.5;
      wheel.isSpinning = slip > 0.8 && !wheel.isFront;
      wheel.rotation += dt * 40;
    }
  }

  // ── rotate through the surfaces ──
  state.surfaceTimer += dt;
  if (state.surfaceTimer > 2.5) {
    state.surfaceTimer = 0;
    state.surfaceIndex = (state.surfaceIndex + 1) % SURFACE_TOUR.length;
  }

  // ── fire a different burst type on a timer, in front of the camera ──
  state.burstTimer += dt;
  if (state.burstTimer > 0.55) {
    state.burstTimer = 0;
    const type = BURST_CYCLE[state.burstIndex % BURST_CYCLE.length];
    state.burstIndex++;
    const a = state.burstIndex * 1.31;
    _v.set(Math.cos(a) * 0.55, 0.10, Math.sin(a) * 0.55 - 0.2);
    fx.burst(type, _v, {
      strength: 1,
      surfaceId: SURFACE_TOUR[state.surfaceIndex],
      normal: { x: 0, y: 1, z: 0 },
    });
  }

  // ── exercise the event paths too ──
  if ((state.burstIndex % 4) === 0 && state.burstTimer === 0) {
    const car = game.cars[0];
    _v.copy(car.group.position);
    game.bus.emit('car:collision', {
      carId: 0, other: null, impulse: 7.5, worldPoint: _v,
      normal: { x: 0, y: 0.2, z: 1 }, relSpeed: 5.5, surfaceId: 11,
    });
    game.bus.emit('car:land', { carId: 1, impactSpeed: 6.5, worldPoint: _v });
    game.bus.emit('weapon:hit', {
      carId: 0, sourceId: 1, weaponId: 'firework', worldPoint: _v, impulse: 10,
    });
  }

  // slow orbit so we see everything from several angles
  const ca = state.t * 0.22;
  state.camera.position.set(Math.sin(ca) * 2.9, 1.05 + Math.sin(state.t * 0.4) * 0.25, Math.cos(ca) * 2.9);
  state.camera.lookAt(0, 0.14, 0);
  state.camera.updateMatrixWorld(true);

  fx.update(dt, 0, dt);
}

/**
 * Create a renderer, mount a canvas into `container` and run the preview.
 *
 * @param {HTMLElement} container
 * @param {{cars?:number, radius?:number}} [opts]
 * @returns {{renderer, state, errors:string[], stop():void, dispose():void}}
 */
export function mountFXPreview(container, opts = {}) {
  const errors = [];
  const target = container ?? document.body;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x10141a, 1);
  // Shader errors are the whole point of this harness.
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = gl.getProgramInfoLog(program) || '';
    const vlog = gl.getShaderInfoLog(vs) || '';
    const flog = gl.getShaderInfoLog(fs) || '';
    errors.push(`${log}\nVERTEX: ${vlog}\nFRAGMENT: ${flog}`.trim());
    console.error('[fx-preview] shader error:', log, vlog, flog);
  };

  const canvas = renderer.domElement;
  canvas.style.position = 'fixed';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.zIndex = '99999';
  target.appendChild(canvas);

  const state = buildFXPreview({ ...opts, renderer });

  let raf = 0;
  let last = performance.now();
  let running = true;
  let frames = 0;

  const onResize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    state.camera.aspect = innerWidth / Math.max(innerHeight, 1);
    state.camera.updateProjectionMatrix();
    state.game.renderer._resize(innerWidth, innerHeight, Math.min(devicePixelRatio || 1, 2));
  };
  addEventListener('resize', onResize);

  const api = {
    renderer, state, errors, frames: 0, ready: false,
    stop() { running = false; cancelAnimationFrame(raf); },
    dispose() {
      api.stop();
      removeEventListener('resize', onResize);
      state.fx.dispose();
      state.depthStub.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };

  const tick = (now) => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60;
    try {
      updateFXPreview(state, dt);
      renderer.render(state.scene, state.camera);
    } catch (err) {
      errors.push(String(err && err.stack ? err.stack : err));
      console.error('[fx-preview] frame threw:', err);
      running = false;
      return;
    }
    frames++;
    api.frames = frames;
    api.ready = frames > 3;
  };

  (async () => {
    await state.fx.init();
    state.fx.onRaceStart({
      track: {
        environment: {
          skybox: 'museum',
          weather: { motes: 0.9, moteStyle: 'dust', leaves: 0.6, godRays: 0.8, boxSize: 10 },
        },
      },
      cars: state.game.cars,
      game: state.game,
    });
    state.ready = true;
    onResize();
    last = performance.now();
    raf = requestAnimationFrame(tick);
  })().catch((err) => {
    errors.push(String(err && err.stack ? err.stack : err));
    console.error('[fx-preview] init failed:', err);
  });

  return api;
}

export default mountFXPreview;
