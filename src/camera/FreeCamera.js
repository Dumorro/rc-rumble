/**
 * FreeCamera — the debug rig. Orbit, fly, pan, zoom.
 *
 * Controls (all optional, all no-ops if the hardware isn't there):
 *   drag LMB / touch      orbit (yaw + pitch)
 *   drag RMB / MMB        pan the focus point
 *   wheel                 zoom (log-scaled, so it works at 0.4 m and 40 m)
 *   throttle / brake      dolly in/out            (W/S, right/left trigger)
 *   steer                 orbit yaw               (A/D, left stick X)
 *   handbrake / fire      down / up               (Space / Ctrl)
 *   double-click          re-centre on the player car
 *
 * It only listens to the DOM while it is the active mode: the listeners are
 * attached in activate() and removed in deactivate(), so a stray drag in the
 * menu can never move the race camera.
 *
 * Not shipped-facing: reachable via the camera-cycle only when CONFIG.debug, or
 * explicitly with `game.cameraDirector.setMode('free')`.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp } from '../core/MathUtils.js';
import { WORLD_UP } from './CameraPose.js';
import { Spring, Vec3Spring, wrapPi } from './Spring.js';

const _eye = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _v = new THREE.Vector3();

const MIN_PITCH = -1.45;
const MAX_PITCH = 1.45;

export class FreeCamera {
  /** @param {import('./CameraDirector.js').CameraDirector} director */
  constructor(director) {
    this.director = director;
    this.game = director?.game ?? null;
    this.name = 'free';

    this.focus = new THREE.Vector3(0, 0.3, 0);
    this.yaw = 0.6;
    this.pitch = 0.35;
    this.distance = 3.0;
    this.fovValue = CONFIG.render.fovBase;

    this.pos = new Vec3Spring(16, 1);
    this.focusSpring = new Vec3Spring(12, 1);
    this.fov = new Spring(CONFIG.render.fovBase, 6, 1);

    this.moveSpeed = 2.2;      // m/s at distance 3
    this.orbitSpeed = 1.6;     // rad/s from the steer axis
    this.mouseSpeed = 0.0060;  // rad/px
    this.panSpeed = 0.0016;    // m/px per metre of distance

    this._dragging = 0;        // 0 none, 1 orbit, 2 pan
    this._px = 0; this._py = 0;
    this._pointerId = null;
    this._el = null;
    this._bound = false;
    this._lastClick = 0;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContext = this._onContext.bind(this);
  }

  // ───────────────────────────────────────────────────────────── lifecycle

  activate(ctx, fromPose = null) {
    const cs = ctx?.carState;
    if (cs?.valid) this.focus.copy(cs.position);
    else if (ctx?.track?.environment?.bounds?.isBox3 && !ctx.track.environment.bounds.isEmpty()) {
      ctx.track.environment.bounds.getCenter(this.focus);
    }

    if (fromPose) {
      // Derive the orbit from wherever the camera is, so entering free-cam is a
      // no-op visually and you can just start dragging.
      _v.subVectors(fromPose.position, this.focus);
      const len = _v.length();
      if (len > 1e-3) {
        this.distance = clamp(len, 0.15, 400);
        this.yaw = Math.atan2(_v.x, _v.z);
        this.pitch = clamp(Math.asin(clamp(_v.y / len, -1, 1)), MIN_PITCH, MAX_PITCH);
      }
      this.pos.snap(fromPose.position);
      this.fov.snap(fromPose.fov);
      this.fovValue = fromPose.fov;
    } else {
      this._place();
      this.pos.snap(_eye);
    }
    this.focusSpring.snap(this.focus);
    this._bind();
    return this;
  }

  deactivate() { this._unbind(); this._dragging = 0; return this; }
  isDone() { return false; }
  snap() { return this; }

  // ─────────────────────────────────────────────────────────────── input

  _bind() {
    if (this._bound) return;
    const el = this.game?.container ?? this.game?.renderer?.renderer?.domElement ?? null;
    this._el = el ?? (typeof window !== 'undefined' ? window : null);
    if (!this._el?.addEventListener) return;
    this._el.addEventListener('pointerdown', this._onDown, { passive: false });
    this._el.addEventListener('wheel', this._onWheel, { passive: false });
    this._el.addEventListener('contextmenu', this._onContext);
    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', this._onMove, { passive: true });
      window.addEventListener('pointerup', this._onUp, { passive: true });
      window.addEventListener('pointercancel', this._onUp, { passive: true });
    }
    this._bound = true;
  }

  _unbind() {
    if (!this._bound) return;
    this._el?.removeEventListener?.('pointerdown', this._onDown);
    this._el?.removeEventListener?.('wheel', this._onWheel);
    this._el?.removeEventListener?.('contextmenu', this._onContext);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('pointerup', this._onUp);
      window.removeEventListener('pointercancel', this._onUp);
    }
    this._bound = false;
  }

  _onContext(e) { e.preventDefault?.(); }

  _onDown(e) {
    this._pointerId = e.pointerId ?? null;
    this._px = e.clientX; this._py = e.clientY;
    this._dragging = (e.button === 2 || e.button === 1) ? 2 : 1;
    e.preventDefault?.();

    const now = performance.now();
    if (now - this._lastClick < 320) this._recentre();
    this._lastClick = now;
  }

  _onMove(e) {
    if (!this._dragging) return;
    if (this._pointerId != null && e.pointerId != null && e.pointerId !== this._pointerId) return;
    const dx = e.clientX - this._px;
    const dy = e.clientY - this._py;
    this._px = e.clientX; this._py = e.clientY;

    if (this._dragging === 1) {
      this.yaw = wrapPi(this.yaw - dx * this.mouseSpeed);
      this.pitch = clamp(this.pitch + dy * this.mouseSpeed, MIN_PITCH, MAX_PITCH);
    } else {
      // Pan in the camera's screen plane.
      this._basis();
      const s = this.panSpeed * Math.max(this.distance, 0.2);
      this.focus.addScaledVector(_right, -dx * s);
      this.focus.addScaledVector(_v.crossVectors(_right, _fwd).normalize(), dy * s);
    }
  }

  _onUp() { this._dragging = 0; this._pointerId = null; }

  _onWheel(e) {
    const d = e.deltaY || 0;
    // Log zoom: 10% per notch, so it feels the same at every scale.
    this.distance = clamp(this.distance * Math.exp(clamp(d, -400, 400) * 0.0014), 0.12, 500);
    e.preventDefault?.();
  }

  _recentre() {
    const car = this.director?.targetCar ?? this.game?.playerCar ?? null;
    if (car?.group) car.group.getWorldPosition(this.focus);
    else if (car?.body?.position) this.focus.copy(car.body.position);
  }

  // ───────────────────────────────────────────────────────────── per frame

  _basis() {
    const cp = Math.cos(this.pitch);
    _fwd.set(-Math.sin(this.yaw) * cp, -Math.sin(this.pitch), -Math.cos(this.yaw) * cp).normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
    if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
    _right.normalize();
    return _fwd;
  }

  /** @param {THREE.Vector3} [centre] orbit centre (defaults to the raw focus) */
  _place(centre = this.focus) {
    const cp = Math.cos(this.pitch);
    _eye.set(
      centre.x + Math.sin(this.yaw) * cp * this.distance,
      centre.y + Math.sin(this.pitch) * this.distance,
      centre.z + Math.cos(this.yaw) * cp * this.distance);
    _look.copy(centre);
    return _eye;
  }

  update(dt, ctx, out) {
    dt = clamp(dt, 0, 0.25);
    // Use wall-clock time: the debug camera must stay usable while paused.
    const rdt = clamp(ctx?.rawDt ?? dt, 0, 0.25);

    const input = this.game?.input?.state;
    if (input) {
      this._basis();
      const boost = input.handbrake > 0.5 && input.fire ? 4 : 1;
      const speed = this.moveSpeed * boost * clamp(this.distance / 3, 0.25, 8);
      const fwdAmt = (input.throttle - input.brake) * speed * rdt;
      if (fwdAmt !== 0) {
        this.focus.addScaledVector(_fwd, fwdAmt);
        // Dollying with the keys should close the distance, not just slide.
        this.distance = clamp(this.distance - fwdAmt * 0.35, 0.12, 500);
      }
      if (input.steer !== 0 && !this._dragging) {
        this.yaw = wrapPi(this.yaw - input.steer * this.orbitSpeed * rdt);
      }
      const vert = (input.fire ? 1 : 0) - (input.handbrake > 0.5 ? 1 : 0);
      if (vert !== 0 && boost === 1) this.focus.y += vert * speed * 0.7 * rdt;
    }

    this.focusSpring.update(this.focus, rdt, 14, 1);
    this._place(this.focusSpring.value);

    this.pos.update(_eye, rdt, 18, 1);
    this.fov.update(this.fovValue, rdt, 6, 1);

    out.lookAt(this.pos.value, _look, WORLD_UP, 0);
    out.fov = clamp(this.fov.value, 12, 120);
    out.shakeScale = 0;
    out.dofIntensity = 0;
    out.focusDistance = 0;
    out.speedIntensity = 0;
    return out;
  }

  dispose() { this._unbind(); }
}

export default FreeCamera;
