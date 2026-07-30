/**
 * RC RUMBLE — physics debug renderer.
 *
 * One preallocated THREE.LineSegments with vertex colours. Nothing is created
 * per frame; `begin()` resets a write cursor and `end()` bumps the draw range.
 * Completely inert (and never added to the scene) unless CONFIG.debug is on
 * AND `setEnabled(true)` has been called.
 *
 * Toggle from the console:  GAME.physics.debugDraw.setEnabled(true)
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';

const DEFAULT_SEGMENTS = 12000;

export const DEBUG_COLOR = Object.freeze({
  contact: 0x00ff88,
  contactDeep: 0xff3355,
  normal: 0xffee44,
  ray: 0x44aaff,
  rayHit: 0xff8800,
  aabb: 0x8866ff,
  bvh: 0x334477,
  sleeping: 0x666666,
  awake: 0x22ddff,
});

export class DebugDraw {
  /**
   * @param {object} game the Game (needs `.scene`; tolerates it being absent)
   * @param {number} [maxSegments]
   */
  constructor(game, maxSegments = DEFAULT_SEGMENTS) {
    this.game = game;
    this.maxSegments = maxSegments;
    this.enabled = false;
    this.attached = false;

    /** What to draw. Flip these from the console while running. */
    this.showContacts = true;
    this.showNormals = true;
    this.showAABBs = false;
    this.showBVH = false;
    this.showRays = false;
    this.bvhDepth = 6;

    this._cursor = 0;
    this._positions = null;
    this._colors = null;
    this.geometry = null;
    this.material = null;
    this.object = null;
    this._box = new Float32Array(6);
  }

  /** Lazily builds the GPU resources on first enable. */
  setEnabled(v) {
    v = !!v && !!CONFIG.debug;
    if (v === this.enabled) return this;
    this.enabled = v;
    if (v) this._ensure();
    if (this.object) this.object.visible = v;
    return this;
  }

  toggle() { return this.setEnabled(!this.enabled); }

  _ensure() {
    if (this.geometry) return;
    this._positions = new Float32Array(this.maxSegments * 6);
    this._colors = new Float32Array(this.maxSegments * 6);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this._colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.name = 'physics:debug';
    this.object.frustumCulled = false;
    this.object.renderOrder = 9999;
    const scene = this.game?.scene;
    if (scene && !this.attached) { scene.add(this.object); this.attached = true; }
  }

  // ───────────────────────────────────────────────────────── frame

  begin() {
    if (!this.enabled) return false;
    this._ensure();
    this._cursor = 0;
    return true;
  }

  end() {
    if (!this.enabled || !this.geometry) return;
    this.geometry.setDrawRange(0, this._cursor * 2);
    const pos = this.geometry.getAttribute('position');
    const col = this.geometry.getAttribute('color');
    // Upload only the written prefix (three r168+ API — the old `updateRange`
    // object is gone, so setting it would silently re-upload the whole buffer).
    const count = this._cursor * 6;
    pos.clearUpdateRanges();
    col.clearUpdateRanges();
    if (count > 0) {
      pos.addUpdateRange(0, count);
      col.addUpdateRange(0, count);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  // ───────────────────────────────────────────────────────── primitives

  /** @param {number} color 0xRRGGBB */
  line(x1, y1, z1, x2, y2, z2, color = 0xffffff) {
    if (!this.enabled || this._cursor >= this.maxSegments) return;
    const i = this._cursor * 6;
    const p = this._positions, c = this._colors;
    p[i] = x1; p[i + 1] = y1; p[i + 2] = z1;
    p[i + 3] = x2; p[i + 4] = y2; p[i + 5] = z2;
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    c[i] = r; c[i + 1] = g; c[i + 2] = b;
    c[i + 3] = r; c[i + 4] = g; c[i + 5] = b;
    this._cursor++;
  }

  lineV(a, b, color) { this.line(a.x, a.y, a.z, b.x, b.y, b.z, color); }

  /** Axis-aligned wire box from raw scalars. */
  box(x0, y0, z0, x1, y1, z1, color = DEBUG_COLOR.aabb) {
    this.line(x0, y0, z0, x1, y0, z0, color);
    this.line(x1, y0, z0, x1, y0, z1, color);
    this.line(x1, y0, z1, x0, y0, z1, color);
    this.line(x0, y0, z1, x0, y0, z0, color);
    this.line(x0, y1, z0, x1, y1, z0, color);
    this.line(x1, y1, z0, x1, y1, z1, color);
    this.line(x1, y1, z1, x0, y1, z1, color);
    this.line(x0, y1, z1, x0, y1, z0, color);
    this.line(x0, y0, z0, x0, y1, z0, color);
    this.line(x1, y0, z0, x1, y1, z0, color);
    this.line(x1, y0, z1, x1, y1, z1, color);
    this.line(x0, y0, z1, x0, y1, z1, color);
  }

  boxV(min, max, color) { this.box(min.x, min.y, min.z, max.x, max.y, max.z, color); }

  /** Small 3-axis cross at a point. */
  cross(x, y, z, size = 0.02, color = 0xffffff) {
    this.line(x - size, y, z, x + size, y, z, color);
    this.line(x, y - size, z, x, y + size, z, color);
    this.line(x, y, z - size, x, y, z + size, color);
  }

  /** Direction indicator with a small arrowhead in the XZ/XY plane. */
  arrow(ox, oy, oz, dx, dy, dz, length = 0.1, color = DEBUG_COLOR.normal) {
    const ex = ox + dx * length, ey = oy + dy * length, ez = oz + dz * length;
    this.line(ox, oy, oz, ex, ey, ez, color);
    // two barbs from an arbitrary perpendicular
    let px = -dy, py = dx, pz = 0;
    if (Math.abs(dz) > 0.9) { px = 0; py = -dz; pz = dy; }
    const l = Math.hypot(px, py, pz) || 1;
    px /= l; py /= l; pz /= l;
    const h = length * 0.25;
    this.line(ex, ey, ez, ex - dx * h + px * h * 0.6, ey - dy * h + py * h * 0.6, ez - dz * h + pz * h * 0.6, color);
    this.line(ex, ey, ez, ex - dx * h - px * h * 0.6, ey - dy * h - py * h * 0.6, ez - dz * h - pz * h * 0.6, color);
  }

  // ───────────────────────────────────────────────────────── physics views

  /** Wireframe of the BVH nodes down to `maxDepth`. */
  drawBVH(mesh, maxDepth = this.bvhDepth, color = DEBUG_COLOR.bvh) {
    if (!this.enabled || !mesh?.bvh?.built) return;
    const bvh = mesh.bvh;
    const b = this._box;
    for (let i = 0; i < bvh.nodeCount; i++) {
      const d = bvh.nodeDepth[i];
      if (d > maxDepth) continue;
      if (d < maxDepth && !bvh.isLeaf(i)) {
        // only draw the frontier + leaves to keep the line count sane
        if (d !== maxDepth) continue;
      }
      bvh.getNodeBounds(i, b);
      this.box(b[0], b[1], b[2], b[3], b[4], b[5], color);
    }
  }

  /** Contacts as a point + normal, red when deeply penetrating. */
  drawContacts(pool, normalLength = 0.05) {
    if (!this.enabled || !pool) return;
    for (let i = 0; i < pool.count; i++) {
      const deep = pool.depth[i] > 0.01;
      const c = deep ? DEBUG_COLOR.contactDeep : DEBUG_COLOR.contact;
      this.cross(pool.px[i], pool.py[i], pool.pz[i], 0.008, c);
      if (this.showNormals) {
        const scale = normalLength * (0.4 + Math.min(1, pool.jn[i] * 2));
        this.arrow(pool.px[i], pool.py[i], pool.pz[i],
          pool.nx[i], pool.ny[i], pool.nz[i], scale, DEBUG_COLOR.normal);
      }
    }
  }

  /** Body AABBs, dimmed while asleep. */
  drawBodies(bodies) {
    if (!this.enabled) return;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b.enabled) continue;
      this.boxV(b.aabbMin, b.aabbMax, b.sleeping ? DEBUG_COLOR.sleeping : DEBUG_COLOR.awake);
    }
  }

  /** A raycast and, if it hit, the hit point + surface normal. */
  drawRay(ox, oy, oz, dx, dy, dz, dist, hit = null) {
    if (!this.enabled) return;
    const end = hit?.hit ? hit.distance : dist;
    this.line(ox, oy, oz, ox + dx * end, oy + dy * end, oz + dz * end,
      hit?.hit ? DEBUG_COLOR.rayHit : DEBUG_COLOR.ray);
    if (hit?.hit) {
      this.arrow(hit.point.x, hit.point.y, hit.point.z,
        hit.normal.x, hit.normal.y, hit.normal.z, 0.04, DEBUG_COLOR.normal);
    }
  }

  dispose() {
    if (this.object && this.attached) {
      this.game?.scene?.remove(this.object);
      this.attached = false;
    }
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = null;
    this.material = null;
    this.object = null;
    this._positions = null;
    this._colors = null;
    this.enabled = false;
  }
}

export default DebugDraw;
