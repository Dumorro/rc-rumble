/**
 * RC RUMBLE — rotating 3D car preview for the car-select screen.
 *
 * The main renderer belongs to the render system and is busy drawing the live
 * menu backdrop, so the preview owns a small, low-resolution `WebGLRenderer` of
 * its own for as long as the screen is open. Geometry and materials come from
 * the *real* vehicle builders (`getCarParts` / `carMaterials`), so what you see
 * on the select screen is literally the car you will drive, colour picker and
 * all.
 *
 * If a second WebGL context cannot be created (context limits, blocked GL) the
 * preview silently degrades to a procedurally drawn 2D blueprint of the same
 * car — no exception ever escapes.
 */

import * as THREE from 'three';
import { getCarParts, carMaterials } from '../vehicle/CarBodies.js';
import { THEME, withAlpha, fitCanvas, drawDisplay, dpr } from './Theme.js';

const C = THEME.color;

export class CarPreview {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'car-preview';
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    this.width = 320;
    this.height = 220;
    this.ok = false;
    this.spin = 0.6;
    this.spinSpeed = 0.55;
    this.tilt = 0.30;
    this._settle = 0;
    this._def = null;
    this._colors = null;
    this._group = null;
    this._fallbackReason = '';

    this.renderer = null;
    this.scene = null;
    this.camera = null;

    this._init();
  }

  _init() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
        powerPreference: 'low-power',
        preserveDrawingBuffer: false,
      });
      this.renderer.setPixelRatio(Math.min(dpr(), 1.75));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    } catch (err) {
      this._fallbackReason = String(err?.message ?? err);
      this.renderer = null;
      return;
    }

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1.5, 0.02, 12);
    this.camera.position.set(0, 0.17, 0.86);
    this.camera.lookAt(0, 0.045, 0);

    // Three-point rig: cool key from the front-left, warm rim behind, soft fill.
    const key = new THREE.DirectionalLight(0xdcecff, 3.1);
    key.position.set(-0.7, 1.1, 0.75);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -0.35;
    key.shadow.camera.right = 0.35;
    key.shadow.camera.top = 0.35;
    key.shadow.camera.bottom = -0.35;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 3.2;
    key.shadow.bias = -0.0009;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xffc98a, 2.4);
    rim.position.set(0.85, 0.5, -0.9);
    this.scene.add(rim);

    const fill = new THREE.HemisphereLight(0x9dc6ff, 0x141a26, 1.5);
    this.scene.add(fill);

    const spot = new THREE.PointLight(0x54dcff, 1.2, 2.2, 2);
    spot.position.set(0.1, 0.42, 0.5);
    this.scene.add(spot);

    // Turntable: a dark disc with a cyan rim, so the car is not floating.
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.28, 64),
      new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 0.55, metalness: 0.25 }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.0005;
    disc.receiveShadow = true;
    this.scene.add(disc);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.272, 0.284, 96),
      new THREE.MeshBasicMaterial({ color: 0x54dcff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.0008;
    this.scene.add(ring);
    this._ring = ring;
    this._disc = disc;

    this.turntable = new THREE.Group();
    this.scene.add(this.turntable);
    this.ok = true;
  }

  get usingWebGL() { return this.ok; }

  /** @param {number} w @param {number} h CSS px */
  resize(w, h) {
    this.width = Math.max(80, Math.round(w));
    this.height = Math.max(60, Math.round(h));
    if (this.ok) {
      this.renderer.setPixelRatio(Math.min(dpr(), 1.75));
      this.renderer.setSize(this.width, this.height, false);
      this.camera.aspect = this.width / this.height;
      this.camera.updateProjectionMatrix();
    } else {
      this.canvas.style.width = `${this.width}px`;
      this.canvas.style.height = `${this.height}px`;
    }
    return this;
  }

  /**
   * Show a car.
   * @param {object} def CarDef
   * @param {{primary?:number, secondary?:number}} [colors]
   */
  setCar(def, colors = null) {
    this._def = def ?? null;
    this._colors = colors;
    this._settle = 1;
    if (!this.ok || !def) return this;

    if (this._group) {
      this.turntable.remove(this._group);
      disposeInstanceMaterials(this._group);
      this._group = null;
    }
    try {
      this._group = buildPreviewModel(this.game, def, colors);
      if (this._group) this.turntable.add(this._group);
    } catch (err) {
      console.warn('[UI] car preview build failed', err);
      this._group = null;
    }
    // Frame the car: longer cars need the camera further back.
    const len = def.length ?? 0.3;
    const dist = 0.62 + len * 0.95;
    this.camera.position.set(0, 0.135 + len * 0.12, dist);
    this.camera.lookAt(0, 0.040 + len * 0.05, 0);
    if (this._ring) {
      const r = Math.max(0.20, len * 0.92);
      this._ring.scale.setScalar(r / 0.278);
      this._disc.scale.setScalar(r / 0.278);
    }
    return this;
  }

  /** Recolour without rebuilding geometry. */
  setColors(colors) {
    this._colors = colors;
    if (this._def) this.setCar(this._def, colors);
    return this;
  }

  /** Nudge the turntable (called on carousel change so it whips round). */
  kick(amount = 1.6) { this.spinSpeed = 0.55 + amount; }

  /** Drag support: raw radians. */
  addSpin(d) { this.spin += d; }

  update(rawDt) {
    const dt = Math.min(rawDt ?? 0.016, 0.05);
    this.spinSpeed += (0.55 - this.spinSpeed) * (1 - Math.exp(-3.4 * dt));
    this.spin += this.spinSpeed * dt;
    this._settle = Math.max(0, this._settle - dt * 2.2);

    if (!this.ok) { this._drawFallback(); return; }
    if (!this.width || !this.height) return;

    this.turntable.rotation.y = this.spin;
    // A gentle bob + a settle drop when the car changes.
    this.turntable.position.y = Math.sin(this.spin * 0.9) * 0.0016 + this._settle * this._settle * 0.06;
    this.turntable.rotation.z = Math.sin(this.spin * 0.7) * 0.012;
    if (this._ring) this._ring.material.opacity = 0.32 + 0.22 * (0.5 + 0.5 * Math.sin(this.spin * 2.1));

    try {
      this.renderer.render(this.scene, this.camera);
    } catch (err) {
      console.warn('[UI] car preview render failed; falling back to 2D', err);
      this.ok = false;
      this._fallbackReason = 'render';
    }
  }

  // ────────────────────────────────────────────────────── 2D fallback

  _drawFallback() {
    const ctx = fitCanvas(this.canvas, this.width, this.height);
    if (!ctx) return;
    const w = this.width, h = this.height;
    ctx.clearRect(0, 0, w, h);
    const def = this._def;
    if (!def) return;

    const cx = w * 0.5;
    const cy = h * 0.60;
    const L = Math.min(w * 0.74, h * 1.9);
    const scale = L / (def.length ?? 0.3);
    const bodyH = (def.height ?? 0.105) * scale;
    const wheelR = (def.tyre?.radius ?? 0.033) * scale;
    const wb = (def.wheelbase ?? 0.2) * scale;
    const primary = `#${((this._colors?.primary ?? def.colorPrimary) >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
    const secondary = `#${((this._colors?.secondary ?? def.colorSecondary) >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;

    // Blueprint grid
    ctx.strokeStyle = 'rgba(126,186,255,0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 22) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 22) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    // Ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + wheelR * 0.9, L * 0.52, wheelR * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Side silhouette: a simple, honest profile derived from the real numbers.
    const x0 = cx - L * 0.5;
    const x1 = cx + L * 0.5;
    const yb = cy;
    const yt = cy - bodyH * 1.15;
    ctx.fillStyle = primary;
    ctx.beginPath();
    ctx.moveTo(x0, yb);
    ctx.lineTo(x0 + L * 0.06, yt + bodyH * 0.28);
    ctx.lineTo(x0 + L * 0.30, yt);
    ctx.lineTo(x1 - L * 0.26, yt);
    ctx.lineTo(x1 - L * 0.04, yt + bodyH * 0.34);
    ctx.lineTo(x1, yb);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = withAlpha(secondary, 0.9);
    ctx.fillRect(x0, yb - bodyH * 0.22, L, bodyH * 0.22);

    // Wheels
    ctx.fillStyle = '#14161a';
    for (const wx of [cx - wb * 0.5, cx + wb * 0.5]) {
      ctx.beginPath();
      ctx.arc(wx, yb, wheelR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#b9bfc7';
      ctx.beginPath();
      ctx.arc(wx, yb, wheelR * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#14161a';
    }

    drawDisplay(ctx, '2D PREVIEW', w * 0.5, h - 10, {
      size: 9, tracking: 0.3, weight: 0.2, align: 'center', fill: withAlpha(C.inkFaint, 0.6),
    });
  }

  dispose() {
    if (this._group) {
      this.turntable?.remove(this._group);
      disposeInstanceMaterials(this._group);
      this._group = null;
    }
    this._disc?.geometry?.dispose();
    this._disc?.material?.dispose();
    this._ring?.geometry?.dispose();
    this._ring?.material?.dispose();
    try { this.renderer?.dispose(); } catch { /* noop */ }
    try { this.renderer?.forceContextLoss?.(); } catch { /* noop */ }
    this.renderer = null;
    this.scene = null;
    this.ok = false;
  }
}

// ═══════════════════════════════════════════════════════════════ model build

/**
 * Build a display-only copy of a car: real shell buckets, real wheels, real
 * antenna, sitting at its static ride height. No physics, no Car instance.
 */
function buildPreviewModel(game, def, colors) {
  const parts = getCarParts(game, def);
  if (!parts?.groups) return null;

  const duck = {
    id: 'preview',
    def,
    colorPrimary: colors?.primary ?? def.colorPrimary,
    colorSecondary: colors?.secondary ?? def.colorSecondary,
  };
  const mats = carMaterials(game, duck);
  const root = new THREE.Group();
  root.name = `preview:${def.id}`;

  const shell = new THREE.Group();
  for (const bucket in parts.groups) {
    const geo = parts.groups[bucket];
    if (!geo) continue;
    const mat = mats[bucket] ?? mats.paintA;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = bucket !== 'glass' && bucket !== 'shellGlass';
    mesh.receiveShadow = true;
    if (bucket === 'glass' || bucket === 'shellGlass') mesh.renderOrder = 2;
    shell.add(mesh);
  }
  root.add(shell);

  // Wheels at the static ride height.
  const s = def.susp ?? {};
  const drop = (isFront) => (s.restLength ?? 0.04)
    - (isFront ? (s.staticCompFront ?? 0.012) : (s.staticCompRear ?? 0.012));
  const anchors = def.wheelAnchors ?? [];
  if (parts.wheel && anchors.length === 4) {
    for (let i = 0; i < 4; i++) {
      const a = anchors[i];
      if (!a) continue;
      const g = new THREE.Group();
      const spin = new THREE.Group();
      const tyre = new THREE.Mesh(parts.wheel.tyre, mats.rubber);
      const rim = new THREE.Mesh(parts.wheel.rim, mats.rim);
      tyre.castShadow = true;
      rim.castShadow = true;
      spin.scale.x = (i & 1) === 0 ? -1 : 1;
      spin.add(tyre, rim);
      g.add(spin);
      g.position.set(a[0], a[1] - drop(i < 2), a[2]);
      // Static camber gives the stance a bit of attitude.
      g.rotation.z = ((i & 1) === 0 ? 1 : -1) * (s.camberStatic ?? 0);
      // A hint of steering lock on the front wheels reads much better in a
      // static preview than four dead-straight wheels.
      if (i < 2) g.rotation.y = 0.14;
      root.add(g);
    }
  }

  // Antenna — a static lean instead of the live AntennaChain sim.
  const ant = parts.antenna;
  if (ant?.mountGeo && ant?.segGeo) {
    const antRoot = new THREE.Group();
    antRoot.position.set(ant.x, ant.y, ant.z);
    const mount = new THREE.Mesh(ant.mountGeo, mats.dark);
    mount.position.y = 0.002;
    antRoot.add(mount);

    const n = Math.max(1, ant.segs ?? 4);
    const len = ant.segLen ?? 0.017;
    let y = 0;
    let lean = 0;
    for (let i = 0; i < n; i++) {
      const seg = new THREE.Mesh(ant.segGeo, mats.dark);
      seg.position.set(Math.sin(lean) * 0.0, y, 0);
      lean += 0.055 + i * 0.02;
      seg.rotation.z = lean;
      antRoot.add(seg);
      y += len * Math.cos(lean);
    }
    if (ant.ballGeo) {
      const ballMat = new THREE.MeshStandardMaterial({
        color: def.antennaColor ?? 0xff2d55,
        emissive: def.antennaColor ?? 0xff2d55,
        emissiveIntensity: 0.25,
        roughness: 0.30, metalness: 0.05,
      });
      ballMat.name = 'car:preview:antennaBall';
      const ball = new THREE.Mesh(ant.ballGeo, ballMat);
      ball.position.set(Math.sin(lean) * len * n * 0.5, y, 0);
      antRoot.add(ball);
    }
    root.add(antRoot);
  }

  // Sit the whole thing on the turntable.
  const box = new THREE.Box3().setFromObject(root);
  if (Number.isFinite(box.min.y)) root.position.y = -box.min.y;
  root.userData.previewMats = mats;
  return root;
}

/**
 * Only the per-instance materials belong to us — the shell/paint/tyre materials
 * are shared, cached library objects that races also use, so they must survive.
 */
function disposeInstanceMaterials(root) {
  const own = root?.userData?.previewMats?._instanceMats;
  if (Array.isArray(own)) for (const m of own) m?.dispose?.();
  const plate = root?.userData?.previewMats?.plate;
  if (plate && typeof plate.name === 'string' && plate.name.includes(':preview:')) plate.dispose?.();
  const seen = new Set();
  root?.traverse?.((o) => {
    const m = o.material;
    if (!m || seen.has(m)) return;
    seen.add(m);
    if (typeof m.name === 'string' && m.name.startsWith('car:preview:')) m.dispose();
  });
}

export default CarPreview;
