/**
 * RC RUMBLE — suspension.
 *
 * Four independent struts, each resolved by a downward cast along the chassis
 * up-axis. Everything that makes a car feel like it has mass lives here:
 *
 *  • **spring + separate bump / rebound damping** — rebound is always stiffer
 *    than bump (as on a real damper), which is what stops the car pogoing and
 *    makes it "take a set" in a corner.
 *  • **progressive bump stop** — the last ~16 % of travel ramps quadratically
 *    to ~5× the spring force, so bottoming out is firm but not a wall.
 *  • **anti-roll bars, front and rear separately** — the primary balance knob:
 *    stiffer front ARB ⇒ understeer, stiffer rear ⇒ oversteer.
 *  • **extension-stop droop force** — a fully-drooped wheel still hangs its
 *    unsprung mass off the chassis, so the car gets light over crests and
 *    leans the *right* way when one wheel drops into a hole.
 *  • **forces applied at the contact patch**, not at the chassis centre.
 *    Weight transfer under braking / cornering therefore *emerges*: the roll
 *    and pitch moments come from the geometry, the loads change, and the tyre
 *    model sees the new loads next step. Nothing is faked.
 *
 * Robustness
 * ----------
 * The primary query is `physics.raycastTrack` (the fastest query in the engine,
 * statics only, allocation free). If the ray misses — which happens on a thin
 * ramp lip, a grate, or the gap between two track pieces — we retry with a
 * **sphere cast** of 55 % of the wheel radius so the wheel rides the edge
 * instead of dropping through it.
 *
 * When the world has no collision at all (bare scaffold track) a virtual ground
 * plane keeps the cars drivable rather than falling forever. The game always
 * boots.
 */

import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { createRayHit, Layer } from '../physics/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Scratch — module level, never reallocated.
// ═══════════════════════════════════════════════════════════════════════════

const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _down = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _hub = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _force = new THREE.Vector3();
const _steerFwd = new THREE.Vector3();
const _steerRight = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _fallbackHit = createRayHit();

/** Cast origin is lifted this far above the strut anchor (m). */
const OVERCAST = 0.018;
/** A surface whose normal is more than ~72° from the chassis up is a wall. */
const MIN_NORMAL_DOT = 0.31;
/** Sphere-cast radius as a fraction of the wheel radius. */
const SPHERE_FRAC = 0.55;
/** Hard sanity clamp on strut load, as a multiple of the static corner load. */
const MAX_LOAD_FACTOR = 26.0;
/** Damper force clamp, as a multiple of the static corner load. */
const MAX_DAMPER_FACTOR = 9.0;
/** Extra cast lift when falling fast, so a landing is never tunnelled (m). */
const MAX_PREDICT_LIFT = 0.10;

export class Suspension {
  /** @param {import('./Car.js').Car} car */
  constructor(car) {
    this.car = car;
    this.def = car.def;
    const s = this.def.susp;

    this.travel = s.travel;
    this.restLength = s.restLength;
    this.springFront = s.springFront;
    this.springRear = s.springRear;
    this.bumpFront = s.bumpFront;
    this.reboundFront = s.reboundFront;
    this.bumpRear = s.bumpRear;
    this.reboundRear = s.reboundRear;
    this.arbFront = s.arbRateFront;
    this.arbRear = s.arbRateRear;
    this.bumpStopStart = s.bumpStopStart;
    this.bumpStopRate = s.bumpStopRate;
    this.droopRate = s.droopRate;
    this.camberStatic = s.camberStatic;
    this.camberPerComp = s.camberPerComp;
    this.forceLift = s.forceLift;

    /** Ground plane used when the world has no collision geometry. */
    this.fallbackGroundY = 0;
    this.useFallbackGround = true;

    /** Layer mask for the (rare) dynamic-body suspension cast. */
    this.castMask = Layer.TRACK | Layer.DEFAULT | Layer.PROP;

    /** Per-wheel scratch, sized once. */
    this._rawForce = new Float64Array(4);
    this._comp = new Float64Array(4);
    this._damper = new Float64Array(4);

    /** Diagnostics. */
    this.rayCount = 0;
    this.sphereCount = 0;
    /** Roll moment (N·m) produced by the ARBs last step — nice for telemetry. */
    this.arbMomentFront = 0;
    this.arbMomentRear = 0;
    /** Sum of the four strut loads (N) — the "sprung" support. */
    this.totalLoad = 0;
  }

  reset() {
    this._rawForce.fill(0);
    this._comp.fill(0);
    this._damper.fill(0);
    this.totalLoad = 0;
    for (const w of this.car.wheels) {
      w.compression = 0;
      w.prevCompression = 0;
      w.compressionLength = 0;
      w.prevCompressionLength = 0;
      w.compressionVel = 0;
      w.suspensionForce = 0;
      w.load = 0;
      w.contact = false;
      w.wasContact = false;
      w.camber = 0;
      w.contactDepth = 0;
    }
  }

  /**
   * Cast, solve and apply all four struts. Leaves every wheel's contact,
   * load, camber and ground-frame axes ready for the tyre pass.
   * @param {number} dt
   */
  update(dt) {
    const car = this.car;
    const body = car.body;
    const wheels = car.wheels;
    if (!body) return;

    const physics = car.game?.physics ?? null;
    const hasStatics = !!physics && physics.staticMeshes && physics.staticMeshes.length > 0;

    body.getUp(_up);
    body.getRight(_right);
    body.getForward(_fwd);
    _down.copy(_up).multiplyScalar(-1);

    // How far the chassis is dropping along its own up axis — used to lift the
    // cast origin so a fast landing cannot step straight through the floor.
    const dropSpeed = Math.max(0, -body.velocity.dot(_up));
    const predictLift = Math.min(MAX_PREDICT_LIFT, dropSpeed * dt * 1.2);

    this.rayCount = 0;
    this.sphereCount = 0;

    // ── pass 1: cast + kinematics ──────────────────────────────────────
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      w.wasContact = w.contact;
      w.prevCompression = w.compression;
      w.prevCompressionLength = w.compressionLength;

      body.localToWorld(w.restPosition, _anchor);
      w.anchorWorld.copy(_anchor);

      const lift = OVERCAST + predictLift;
      _origin.copy(_anchor).addScaledVector(_up, lift);
      const rayLen = lift + this.restLength + w.radius;

      let found = false;
      if (hasStatics) {
        found = physics.raycastTrack(_origin, _down, rayLen, w.hit);
        this.rayCount++;
        if (found && w.hit.normal.dot(_up) < MIN_NORMAL_DOT) found = false;
        if (!found) {
          // Edge / thin-lip rescue: sweep a small sphere instead of a ray.
          const sr = w.radius * SPHERE_FRAC;
          if (physics.sphereCast(_origin, _down, sr, rayLen, w.hit, this.castMask)) {
            this.sphereCount++;
            const nd = w.hit.normal.dot(_up);
            if (nd >= MIN_NORMAL_DOT) {
              // Convert "distance until the sphere touches" into the equivalent
              // ray distance to the surface along the cast direction.
              w.hit.distance += sr / Math.max(0.34, nd);
              w.hit.hit = true;
              found = true;
            }
          }
        }
      }
      if (!found && this.useFallbackGround && !hasStatics) {
        found = this._castFallbackGround(_origin, _down, rayLen, w.hit);
      }

      let comp = 0;
      if (found) {
        comp = rayLen - w.hit.distance;
        w.contactDepth = comp > this.travel ? comp - this.travel : 0;
        comp = clamp(comp, 0, this.travel);
        w.contact = true;
        w.contactPoint.copy(w.hit.point);
        w.contactNormal.copy(w.hit.normal);
        w.surfaceId = w.hit.surfaceId | 0;
        w.contactBody = w.hit.body ?? null;
      } else {
        w.contact = false;
        w.contactDepth = 0;
        w.contactBody = null;
        // Keep the last normal for a graceful visual, but zero the load.
        w.contactNormal.copy(_up);
      }

      w.compressionLength = comp;
      w.compression = this.travel > 0 ? comp / this.travel : 0;
      w.compressionVel = (comp - w.prevCompressionLength) / dt;
      this._comp[i] = comp;

      // Hub position (chassis-local) — the visual wheel goes here.
      const hubDrop = this.restLength - comp;
      w.hubLocal.copy(w.restPosition).addScaledVector(UP_LOCAL, -hubDrop);
      body.localToWorld(w.hubLocal, _hub);
      w.hubWorld.copy(_hub);
      if (!w.contact) {
        // Park the notional contact point under the hub so FX have something sane.
        w.contactPoint.copy(_hub).addScaledVector(_up, -w.radius);
      }

      // ── ground frame for the tyre ─────────────────────────────────────
      const sa = w.steerAngle;
      if (sa !== 0) {
        const cs = Math.cos(sa), sn = Math.sin(sa);
        _steerFwd.copy(_fwd).multiplyScalar(cs).addScaledVector(_right, sn);
        _steerRight.copy(_right).multiplyScalar(cs).addScaledVector(_fwd, -sn);
      } else {
        _steerFwd.copy(_fwd);
        _steerRight.copy(_right);
      }

      const n = w.contactNormal;
      // Project the rolling direction into the contact plane.
      _tmp.copy(_steerFwd).addScaledVector(n, -_steerFwd.dot(n));
      if (_tmp.lengthSq() < 1e-8) _tmp.copy(_steerFwd);
      w.groundForward.copy(_tmp).normalize();
      w.groundRight.crossVectors(w.groundForward, n);
      if (w.groundRight.lengthSq() < 1e-8) w.groundRight.copy(_steerRight);
      else w.groundRight.normalize();

      // ── camber: chassis roll relative to the surface + geometry ───────
      const rollCamber = Math.asin(clamp(-n.dot(_steerRight), -1, 1));
      const staticComp = w.isFront
        ? this.def.susp.staticCompFront
        : this.def.susp.staticCompRear;
      const geoCamber = w.side * (this.camberStatic + this.camberPerComp * (comp - staticComp));
      w.camber = rollCamber + geoCamber;

      // ── damper rate along the strut (Bullet-style, body motion only) ──
      if (w.contact) {
        body.pointVelocity(w.contactPoint, _vel);
        const denom = Math.max(0.28, n.dot(_up));
        const relN = _vel.dot(n);
        // relN < 0 ⇒ approaching the surface ⇒ compressing.
        this._damper[i] = -relN / denom;
      } else {
        this._damper[i] = 0;
      }
    }

    // ── pass 2: spring, damper, bump stop ──────────────────────────────
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      if (!w.contact) { this._rawForce[i] = 0; continue; }
      const k = w.isFront ? this.springFront : this.springRear;
      const comp = this._comp[i];
      let f = k * comp;

      // Progressive bump stop.
      const stopAt = this.travel * this.bumpStopStart;
      if (comp > stopAt) {
        const span = Math.max(1e-4, this.travel - stopAt);
        const x = (comp - stopAt) / span;
        f += k * this.bumpStopRate * x * x * span;
      }
      // Extra push-back when the strut is being driven past its stop.
      if (w.contactDepth > 0) {
        f += k * this.bumpStopRate * 1.4 * w.contactDepth;
      }

      // Damper: bump and rebound rates differ.
      const rate = this._damper[i];
      const cBump = w.isFront ? this.bumpFront : this.bumpRear;
      const cReb = w.isFront ? this.reboundFront : this.reboundRear;
      const c = rate >= 0 ? cBump : cReb;
      const staticLoad = this.def.staticLoad[i];
      const damperMax = staticLoad * MAX_DAMPER_FACTOR;
      const damper = clamp(c * rate, -damperMax, damperMax);
      f += damper;

      this._rawForce[i] = f;
    }

    // ── pass 3: anti-roll bars ─────────────────────────────────────────
    this.arbMomentFront = this._applyARB(0, 1, this.arbFront);
    this.arbMomentRear = this._applyARB(2, 3, this.arbRear);

    // ── pass 4: clamp, store, apply ────────────────────────────────────
    this.totalLoad = 0;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const staticLoad = this.def.staticLoad[i];

      if (!w.contact) {
        // Extension stop: the unsprung mass hangs off the chassis.
        w.load = 0;
        w.suspensionForce = 0;
        const droop = (w.isFront ? this.springFront : this.springRear)
          * this.travel * this.droopRate;
        if (droop > 0) {
          _force.copy(_up).multiplyScalar(-droop);
          body.applyForce(_force, w.anchorWorld);
        }
        continue;
      }

      const load = clamp(this._rawForce[i], 0, staticLoad * MAX_LOAD_FACTOR);
      w.load = load;
      w.suspensionForce = load;
      this.totalLoad += load;

      if (load > 0) {
        _force.copy(w.contactNormal).multiplyScalar(load);
        body.applyForce(_force, w.contactPoint);
      }
    }
  }

  /**
   * Torsion bar between two wheels on the same axle. Returns the roll moment.
   * @param {number} a left wheel index @param {number} b right wheel index
   * @param {number} rate N/m of anti-roll stiffness
   */
  _applyARB(a, b, rate) {
    if (rate <= 0) return 0;
    const wa = this.car.wheels[a];
    const wb = this.car.wheels[b];
    // A bar only works when both ends have something to react against.
    if (!wa.contact && !wb.contact) return 0;
    const delta = this._comp[a] - this._comp[b];
    if (delta === 0) return 0;
    const f = rate * delta;
    // Push down on the compressed side, lift the extended side.
    if (wa.contact) this._rawForce[a] += f;
    if (wb.contact) this._rawForce[b] -= f;
    return f * (this.car.def.trackWidth * 0.5) * 2;
  }

  /** Virtual ground plane, so a track with no collision is still drivable. */
  _castFallbackGround(origin, dir, maxDist, out) {
    const y = this.fallbackGroundY;
    let t;
    if (origin.y <= y) {
      t = 0;                                   // already at/below the plane
    } else {
      if (dir.y > -1e-4) return false;         // pointing away from the plane
      t = (y - origin.y) / dir.y;
      if (t > maxDist) return false;
    }
    out.hit = true;
    out.distance = t;
    out.point.set(origin.x + dir.x * t, y, origin.z + dir.z * t);
    out.normal.set(0, 1, 0);
    out.surfaceId = 0;
    out.triIndex = -1;
    out.body = null;
    return true;
  }

  /** Average compression 0..1 across an axle (visuals / telemetry). */
  axleCompression(front) {
    const a = front ? 0 : 2;
    return (this.car.wheels[a].compression + this.car.wheels[a + 1].compression) * 0.5;
  }

  /** Roll indicator: −1 fully leaning left … +1 fully leaning right. */
  rollBias() {
    const w = this.car.wheels;
    const l = (w[0].compression + w[2].compression) * 0.5;
    const r = (w[1].compression + w[3].compression) * 0.5;
    return clamp(r - l, -1, 1);
  }

  /** Pitch indicator: −1 nose down … +1 nose up. */
  pitchBias() {
    const w = this.car.wheels;
    const f = (w[0].compression + w[1].compression) * 0.5;
    const r = (w[2].compression + w[3].compression) * 0.5;
    return clamp(f - r, -1, 1);
  }

  /** Squat indicator: 0 fully extended … 1 fully compressed. */
  squat() {
    const w = this.car.wheels;
    return clamp01((w[0].compression + w[1].compression + w[2].compression + w[3].compression) * 0.25);
  }
}

const UP_LOCAL = new THREE.Vector3(0, 1, 0);

export default Suspension;
