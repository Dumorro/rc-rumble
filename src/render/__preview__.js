/**
 * Material preview scene — a contact sheet of every procedural material.
 *
 * Not shipped with the game; it exists so a human (or a critic agent) can look
 * at the whole library at once and judge it.
 *
 *   import { buildMaterialPreviewScene } from './render/__preview__.js';
 *   game.scene.add(buildMaterialPreviewScene(THREE, game.assets));
 *
 * Each cell shows the same material on a sphere (curvature, highlights,
 * clearcoat) and on a tilted plane (tiling, texel density, normal detail),
 * with a readable label. Extra rows cover the parametric materials —
 * car paint, emissive, decals, vertex colour, soap bubble.
 *
 * The return value is a `THREE.Group` that also answers to `.group` and
 * `.scene` (self references) so any destructuring style works, and carries
 * `userData.preview = { entries, cols, rows, cellSize, dispose }`.
 */

import * as PT from './ProceduralTextures.js';
import { getMaterials } from './Materials.js';
import { CATALOGUE } from './TextureLib.js';

/**
 * @param {typeof import('three')} THREE the three namespace (passed in so this
 *        file never pulls a second copy of three into the bundle graph)
 * @param {import('../core/Assets.js').Assets} assets
 * @param {object} [opts]
 * @param {number} [opts.cellSize] world size of one grid cell, in metres
 * @param {boolean} [opts.lights] add its own lighting (default true)
 * @param {boolean} [opts.labels] add name labels (default true)
 * @param {boolean} [opts.ground] add a ground plane (default true)
 * @param {string[]} [opts.only] restrict to these catalogue names
 * @param {number} [opts.sizeMeters] world size to assume for texel density
 * @returns {import('three').Group}
 */
export function buildMaterialPreviewScene(THREE, assets, opts = {}) {
  const root = new THREE.Group();
  root.name = 'materialPreview';

  // Self references so `const { group } = build(...)` also works.
  try {
    Object.defineProperty(root, 'group', { value: root, enumerable: false });
    Object.defineProperty(root, 'scene', { value: root, enumerable: false });
  } catch { /* non-fatal */ }

  if (!assets) {
    console.warn('[__preview__] no assets — returning empty group');
    return root;
  }

  const M = getMaterials(assets);
  const cell = opts.cellSize ?? 1.6;
  const sizeMeters = opts.sizeMeters ?? cell * 0.9;
  const names = opts.only ?? CATALOGUE.map((e) => e.name);

  // ── shared geometry ───────────────────────────────────────────────────────
  const sphereGeo = new THREE.SphereGeometry(cell * 0.26, 48, 32);
  const plateGeo = new THREE.PlaneGeometry(cell * 0.86, cell * 0.86, 1, 1);
  const labelGeo = new THREE.PlaneGeometry(cell * 0.92, cell * 0.92 * 0.25);
  const rodGeo = new THREE.CylinderGeometry(cell * 0.02, cell * 0.02, cell * 0.28, 10);
  const owned = [sphereGeo, plateGeo, labelGeo, rodGeo];
  const ownedMaterials = [];

  const rodMat = new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.5, metalness: 0.6 });
  ownedMaterials.push(rodMat);

  /** Build one labelled cell. */
  const makeCell = (label, material, tag) => {
    const g = new THREE.Group();
    g.name = `preview:${label}`;

    // Back plate, tilted like a paint chip so you can see the tiling.
    const plate = new THREE.Mesh(plateGeo, material);
    plate.rotation.x = -Math.PI * 0.5;
    plate.position.y = 0.001;
    plate.receiveShadow = true;
    plate.castShadow = false;
    g.add(plate);

    // Sphere on a little stand.
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.y = cell * 0.14;
    g.add(rod);
    const ball = new THREE.Mesh(sphereGeo, material);
    ball.position.y = cell * 0.28 + cell * 0.26;
    ball.castShadow = true;
    ball.receiveShadow = true;
    g.add(ball);

    if (opts.labels !== false) {
      const tex = PT.textTexture(assets, `preview:${label}`, {
        text: [label, tag ?? ''].filter(Boolean),
        width: 512, height: 160,
        color: '#f2f4f8', outline: 'rgba(0,0,0,0.85)', outlineWidth: 0.10,
        font: 'vector', weight: 0.14, lineGap: 0.35, padding: 0.05,
      });
      const lm = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, toneMapped: false,
      });
      ownedMaterials.push(lm);
      const lbl = new THREE.Mesh(labelGeo, lm);
      lbl.rotation.x = -Math.PI * 0.5;
      lbl.position.set(0, 0.004, cell * 0.53);
      g.add(lbl);
    }
    return g;
  };

  // ── the catalogue grid ────────────────────────────────────────────────────
  /** @type {{name:string, material:import('three').Material}[]} */
  const entries = [];
  for (const name of names) {
    let mat;
    try {
      mat = M.get(name, { sizeMeters });
    } catch (err) {
      console.warn('[__preview__] failed:', name, err);
      continue;
    }
    entries.push({ name, material: mat });
  }

  // Extra parametric materials so the whole factory is on show.
  const extras = [];
  const push = (label, fn, tag) => {
    try { extras.push({ name: label, material: fn(), tag }); }
    catch (err) { console.warn('[__preview__] extra failed:', label, err); }
  };
  push('car paint red', () => M.carPaint({ color: 0xd0201c, metallic: 0.9, flake: 0.75 }), 'flake + clearcoat');
  push('car paint blue', () => M.carPaint({ color: 0x1b4fd8, metallic: 0.55, flake: 0.35 }), 'satin metallic');
  push('car paint pearl', () => M.carPaint({ color: 0xf2f4f8, metallic: 0.35, flake: 0.5, pearl: true }), 'iridescent pearl');
  push('car paint solid', () => M.carPaint({ color: 0x18b06a, metallic: 0.0, flake: 0.0 }), 'solid gloss');
  push('emissive', () => M.emissive(0x66ddff, 3.0), 'led glow');
  push('soap bubble', () => M.bubble(), 'iridescence');
  push('vertex colour', () => M.vertexColor({ flatShading: true }), 'prop workhorse');
  push('decal logo', () => M.decal({ logo: 'RUMBLE', shape: 'chevron', unlit: false }), 'sponsor badge');
  push('decal text', () => M.decal({ text: ['PIT', 'LANE'], outline: '#000000', wear: 0.4 }), 'signage');
  push('recoloured lego', () => M.get('toy/lego_studs', { sizeMeters, recolor: 0x2f7fd0, variant: 'blue' }), 'recolour hook');
  push('tarmac 8 m', () => M.get('road/tarmac', { sizeMeters: 8 }), 'texel density x8');
  push('tarmac 1 m', () => M.get('road/tarmac', { sizeMeters: 1 }), 'texel density x1');

  const all = [...entries, ...extras];
  const cols = opts.columns ?? Math.max(1, Math.ceil(Math.sqrt(all.length)));
  const rows = Math.ceil(all.length / cols);

  all.forEach((e, i) => {
    const cx = (i % cols) - (cols - 1) * 0.5;
    const cz = Math.floor(i / cols) - (rows - 1) * 0.5;
    const g = makeCell(e.name, e.material, e.tag ?? tagFor(e.name));
    g.position.set(cx * cell * 1.12, 0, cz * cell * 1.25);
    root.add(g);
  });

  // ── ground + lights ──────────────────────────────────────────────────────
  const width = cols * cell * 1.12 + cell * 2;
  const depth = rows * cell * 1.25 + cell * 2;

  if (opts.ground !== false) {
    const groundGeo = new THREE.PlaneGeometry(width, depth);
    owned.push(groundGeo);
    let groundMat;
    try {
      groundMat = M.get('concrete/screed', { sizeMeters: Math.max(width, depth) });
    } catch {
      groundMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4e, roughness: 0.9 });
      ownedMaterials.push(groundMat);
    }
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI * 0.5;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    root.add(ground);
  }

  if (opts.lights !== false) {
    const hemi = new THREE.HemisphereLight(0xbcd6ff, 0x2a2418, 0.65);
    root.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.4);
    sun.position.set(width * 0.35, Math.max(width, depth) * 0.6, depth * 0.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const ext = Math.max(width, depth) * 0.6;
    sun.shadow.camera.left = -ext;
    sun.shadow.camera.right = ext;
    sun.shadow.camera.top = ext;
    sun.shadow.camera.bottom = -ext;
    sun.shadow.camera.far = Math.max(width, depth) * 3;
    sun.shadow.bias = -0.0006;
    root.add(sun);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-width * 0.3, depth * 0.4, -depth * 0.4);
    root.add(fill);
  }

  const dispose = () => {
    for (const g of owned) g.dispose?.();
    for (const m of ownedMaterials) m.dispose?.();
    root.traverse((o) => {
      if (o.isMesh && o.geometry && !owned.includes(o.geometry)) o.geometry.dispose?.();
    });
  };

  root.userData.preview = {
    entries: all.map((e) => e.name),
    cols, rows, cellSize: cell, width, depth,
    /** Suggested camera framing for a screenshot. */
    camera: {
      position: [0, Math.max(width, depth) * 0.62, depth * 0.72],
      target: [0, cell * 0.25, 0],
      fov: 45,
    },
    dispose,
  };
  root.userData.dispose = dispose;
  return root;
}

/** Short descriptive tag under the name — surface id + family. */
function tagFor(name) {
  const def = PT.TEXTURE_DEFS[name];
  if (!def) return '';
  return `S${def.surfaceId ?? 0} ${def.family ?? ''} ${def.physicalSize ?? 1}M`;
}

/**
 * Convenience: everything needed to render the sheet standalone.
 * @returns {{scene:import('three').Scene, camera:import('three').PerspectiveCamera, group:import('three').Group}}
 */
export function buildMaterialPreviewStandalone(THREE, assets, opts = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11151c);
  const group = buildMaterialPreviewScene(THREE, assets, opts);
  scene.add(group);
  const cfg = group.userData.preview?.camera ?? { position: [0, 20, 20], target: [0, 0, 0], fov: 45 };
  const camera = new THREE.PerspectiveCamera(cfg.fov, 16 / 9, 0.05, 500);
  camera.position.set(...cfg.position);
  camera.lookAt(...cfg.target);
  return { scene, camera, group };
}

export default buildMaterialPreviewScene;
