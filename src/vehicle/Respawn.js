/**
 * RC RUMBLE — Re-Volt style respawn.
 *
 * Re-Volt's reset is one of the reasons it stays fun when you are terrible at
 * it: it is *fast*, it puts you back on the racing line pointing the right way,
 * and it gives you a moment of grace so you are not immediately punted again.
 *
 * Detection (all per-car, all in the fixed step):
 *   flipped   — upside down for 1.5 s
 *   stuck     — throttle down but not moving for 3 s
 *   fell      — below the track bounds, or below the lowest respawn point
 *   lost      — 5 s of continuous air time (off the edge of the world)
 *   manual    — the player pressed reset, or the AI gave up
 *
 * Sequence: fade → teleport → settle → fade back, total ≈ `CONFIG.race.respawnDelay`.
 * The player gets a real screen fade through `PostFX.fadeTo`; AI cars are moved
 * instantly (nobody is looking).
 *
 * Placement resolves through everything TrackData might offer, in order:
 *   `respawns` (matching the car's checkpoint) → `checkpoints` → the AI racing
 *   line → the start grid → wherever the car already is. Then it drops a ray to
 *   find the actual floor, levels the car to the surface normal, keeps only the
 *   *yaw* from the reference orientation, and lifts it to its static ride height.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { createRayHit, Layer } from '../physics/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// Scratch
// ═══════════════════════════════════════════════════════════════════════════

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _n = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _m3 = new THREE.Matrix4();
const _hit = createRayHit();
const _tmp = new THREE.Vector3();
const _back = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Search order for the respawn clearance walk — alternates up/down the line. */
const BACK_FIRST = Object.freeze([-1, 1]);
const FWD_FIRST = Object.freeze([1, -1]);

const STATE_IDLE = 0;
const STATE_FADE = 1;
const STATE_SETTLE = 2;

/** Seconds of grace after a respawn. */
const INVULN_TIME = 1.6;

export class Respawn {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {import('./CarSystem.js').CarSystem} carSystem
   */
  constructor(game, carSystem) {
    this.game = game;
    this.carSystem = carSystem;
    /** @type {object|null} TrackData */
    this.track = null;
    /** Lowest sane Y — anything under this has fallen out of the world. */
    this.floorY = -8;
    this.enabled = true;

    // Thresholds (seconds).
    this.flipTime = 1.5;
    this.stuckLimit = 3.0;
    this.airLimit = 5.0;

    /**
     * Repeated-respawn escalation. "Never permanently stuck" is a hard
     * requirement, and the way it used to break was subtle: if the resolved
     * point is ITSELF blocked — inside a prop, under scenery, on top of another
     * car — the car respawns, wedges, trips the 3 s stuck timer, and respawns to
     * the same blocked point again, forever, with the player watching. Nothing
     * throws and nothing logs; the race just ends.
     *
     * So count respawns inside a window and step further back along the racing
     * line each time, which walks the car out of whatever it is stuck in.
     */
    this.repeatWindow = 12.0;      // s — respawns closer together than this stack
    this.repeatBackoff = 1.8;      // m of extra set-back per repeat
    this.maxBackoff = 12.0;        // m — stop walking backwards past this
    /** Clearance a respawn point needs, as a multiple of the car's half-length. */
    this.clearance = 1.15;

    this.fadeOut = 0.20;
    this.fadeIn = 0.30;
    this.settleTime = Math.max(0.10, (CONFIG.race.respawnDelay ?? 0.65) - 0.20);

    /** @type {Map<import('./Car.js').Car, object>} */
    this.states = new Map();
    /** Diagnostics. */
    this.count = 0;
    this.lastReason = '';
  }

  /** @param {object|null} track TrackData */
  onRaceStart(track) {
    this.track = track ?? null;
    this.states.clear();
    this.count = 0;
    const b = track?.environment?.bounds;
    let low = Infinity;
    if (b && !b.isEmpty?.()) low = b.min.y;
    if (Array.isArray(track?.respawns)) {
      for (const r of track.respawns) {
        const y = r?.position?.y;
        if (typeof y === 'number' && y < low) low = y;
      }
    }
    if (Array.isArray(track?.startGrid)) {
      for (const g of track.startGrid) {
        const y = g?.position?.y;
        if (typeof y === 'number' && y < low) low = y;
      }
    }
    this.floorY = Number.isFinite(low) ? low - 3.0 : -8;
  }

  onRaceEnd() {
    // Clear any half-finished fade so the screen never stays black.
    if (this.game?.renderer?.postfx?.fadeTo) {
      for (const [car, st] of this.states) {
        if (st.state !== STATE_IDLE && car.isPlayer) this.game.renderer.postfx.fadeTo(0, 0.2);
      }
    }
    this.states.clear();
    this.track = null;
  }

  _stateFor(car) {
    let st = this.states.get(car);
    if (!st) {
      st = {
        state: STATE_IDLE, timer: 0, flipTimer: 0, reason: '', checkpoint: 0,
        // Repeated-respawn escalation, see `repeatWindow`.
        repeats: 0, sinceLast: Infinity, anchor: new THREE.Vector3(), hasAnchor: false,
      };
      this.states.set(car, st);
    }
    return st;
  }

  /**
   * Ask for a respawn. Idempotent while one is already running.
   * @param {import('./Car.js').Car} car
   * @param {number} [checkpointIndex] defaults to the car's current checkpoint
   * @param {string} [reason]
   */
  request(car, checkpointIndex, reason = 'manual') {
    if (!car || !this.enabled) return false;
    const st = this._stateFor(car);
    if (st.state !== STATE_IDLE) return false;
    st.state = STATE_FADE;
    st.timer = car.isPlayer ? this.fadeOut : 0;
    st.reason = reason;
    st.checkpoint = checkpointIndex ?? car.checkpoint ?? 0;
    st.flipTimer = 0;
    car.controlEnabled = false;
    car.clearControl();
    this.lastReason = reason;
    if (car.isPlayer) this.game?.renderer?.postfx?.fadeTo?.(0.92, this.fadeOut, 0x000000);
    // Immediate teleport for the AI — no reason to make them wait.
    if (!car.isPlayer) this._teleport(car, st);
    return true;
  }

  /** Detect + advance every car's state machine. */
  fixedUpdate(dt) {
    const cars = this.carSystem?.cars;
    if (!cars || !this.enabled) return;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (!car?.body) continue;
      const st = this._stateFor(car);
      // Age the repeat counter. Survive a bad patch and the escalation resets.
      if (st.sinceLast < 1e6) {
        st.sinceLast += dt;
        if (st.sinceLast > this.repeatWindow && st.repeats !== 0) {
          st.repeats = 0;
          st.sinceLast = Infinity;
        }
      }

      if (st.state === STATE_FADE) {
        st.timer -= dt;
        if (st.timer <= 0) this._teleport(car, st);
        continue;
      }
      if (st.state === STATE_SETTLE) {
        st.timer -= dt;
        if (st.timer <= 0) {
          st.state = STATE_IDLE;
          car.controlEnabled = true;
        }
        continue;
      }

      this._detect(car, st, dt);
    }
  }

  _detect(car, st, dt) {
    // Player asked for it.
    if (car.isPlayer && car.control.reset) {
      this.request(car, car.checkpoint, 'manual');
      return;
    }

    // Fell out of the world — instant, no fade delay games.
    if (car.body.position.y < this.floorY) {
      this.request(car, car.checkpoint, 'fell');
      return;
    }

    // Upside down (and not just mid-barrel-roll).
    if (car.upsideDown && car.wheelsOnGround === 0) {
      st.flipTimer += dt;
      if (st.flipTimer > this.flipTime) {
        this.request(car, car.checkpoint, 'flipped');
        return;
      }
    } else if (car.upsideDown) {
      // On its roof, resting: that is worse, be quicker about it.
      st.flipTimer += dt * 1.6;
      if (st.flipTimer > this.flipTime) {
        this.request(car, car.checkpoint, 'flipped');
        return;
      }
    } else {
      st.flipTimer = Math.max(0, st.flipTimer - dt * 2.5);
    }

    // Wedged against scenery.
    if (car.stuckTime > this.stuckLimit) {
      this.request(car, car.checkpoint, 'stuck');
      return;
    }

    // Endless air = off the edge.
    if (car.airborne && car.airTime > this.airLimit) {
      this.request(car, car.checkpoint, 'lost');
    }
  }

  /** Place the car and start the settle phase. */
  _teleport(car, st) {
    // A respawn inside the window means the last one did not work. Step further
    // back along the line each time so we walk out of whatever is blocking it.
    st.repeats = (st.sinceLast <= this.repeatWindow) ? st.repeats + 1 : 0;
    st.sinceLast = 0;
    if (st.repeats === 0) {
      // First respawn of a series — anchor the escalation here. Without a fixed
      // anchor the set-back re-projects from wherever the car ended up last
      // time, so it wanders instead of walking steadily back up the line.
      st.anchor.copy(car.body.position);
      st.hasAnchor = true;
    }
    const backoff = Math.min(this.maxBackoff, st.repeats * this.repeatBackoff);
    const ok = this.resolvePoint(car, st.checkpoint, _pos, _quat, backoff,
      st.hasAnchor ? st.anchor : null);
    if (!ok) {
      // Nothing to go on — lift it in place and level it.
      _pos.copy(car.body.position);
      _pos.y += 0.10;
      car.getForward(_fwd);
      _fwd.y = 0;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
      _fwd.normalize();
      levelQuaternion(_fwd, WORLD_UP, _quat);
    }

    car.hardReset(_pos, _quat);
    car.invulnerable = INVULN_TIME;
    car.effects.shielded = Math.max(car.effects.shielded, INVULN_TIME * 0.6);
    car.stuckTime = 0;
    car.offTrackTime = 0;
    st.flipTimer = 0;
    st.state = STATE_SETTLE;
    st.timer = car.isPlayer ? this.settleTime : 0.05;
    this.count++;

    // The AI needs to re-acquire the racing line from its new position.
    car.aiDriver?.reset?.();

    if (car.isPlayer) {
      this.game?.renderer?.postfx?.fadeTo?.(0, this.fadeIn, 0x000000);
      this.game?.renderer?.postfx?.resetHistory?.();
    }

    const bus = this.game?.bus;
    if (bus) {
      const e = this._event();
      e.carId = car.id;
      e.position.copy(_pos);
      e.reason = st.reason;
      bus.emit('car:respawn', e);
    }
  }

  /**
   * Work out where a car should reappear.
   * @param {import('./Car.js').Car} car
   * @param {number} checkpointIndex
   * @param {THREE.Vector3} outPos
   * @param {THREE.Quaternion} outQuat
   * @returns {boolean}
   */
  resolvePoint(car, checkpointIndex, outPos, outQuat, backoff = 0, anchor = null) {
    const track = this.track;
    let refPos = null;
    let refQuat = null;
    let refFwd = null;

    // 1. explicit respawn points, best match at or before this checkpoint
    const rs = track?.respawns;
    if (Array.isArray(rs) && rs.length > 0) {
      let best = null;
      let bestIdx = -Infinity;
      for (const r of rs) {
        if (!r?.position) continue;
        const ci = r.checkpointIndex ?? 0;
        if (ci <= checkpointIndex && ci > bestIdx) { bestIdx = ci; best = r; }
      }
      // Nothing at or before? Take the last one (we are probably on lap 0).
      if (!best) {
        for (let i = rs.length - 1; i >= 0; i--) if (rs[i]?.position) { best = rs[i]; break; }
      }
      if (best) { refPos = best.position; refQuat = best.quaternion ?? null; }
    }

    // 2. the checkpoint itself
    if (!refPos && Array.isArray(track?.checkpoints) && track.checkpoints.length > 0) {
      const cps = track.checkpoints;
      const idx = clamp(checkpointIndex | 0, 0, cps.length - 1);
      const cp = cps[idx] ?? cps[0];
      if (cp?.position) { refPos = cp.position; refQuat = cp.quaternion ?? null; }
    }

    // 3. the AI racing line — always available if there is a path
    const path = this.carSystem?.aiPath;
    if (path) {
      const from = refPos ? _tmp.copy(refPos) : (anchor ?? car.body.position);
      const pr = path.projectGlobal(from);
      // Back up slightly so the car does not immediately re-cross a checkpoint,
      // plus the escalation set-back if earlier respawns here did not take.
      const s = pr.s - 0.18 - backoff;
      path.sampleAt(s, _origin, pr.index);
      path.tangentAt(s, _n, pr.index);
      if (!refPos) refPos = _origin;
      refFwd = _n;
    }

    // 4. the start grid
    if (!refPos && Array.isArray(track?.startGrid) && track.startGrid.length > 0) {
      const g = track.startGrid[car.id % track.startGrid.length];
      if (g?.position) { refPos = g.position; refQuat = g.quaternion ?? null; }
    }

    if (!refPos) return false;
    outPos.copy(refPos);

    // ── forward direction ──
    if (refFwd && refFwd.lengthSq() > 1e-6) {
      _fwd.copy(refFwd);
    } else if (refQuat) {
      _fwd.set(0, 0, -1).applyQuaternion(refQuat);
    } else {
      car.getForward(_fwd);
    }
    _fwd.y *= 0.25;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();

    // ── find the actual floor and level to it ──
    _n.copy(WORLD_UP);
    const physics = this.game?.physics;
    if (physics?.raycastTrack && physics.staticMeshes?.length) {
      _origin.copy(outPos);
      _origin.y += 0.60;
      if (physics.raycastTrack(_origin, _down, 3.0, _hit) && _hit.normal.y > 0.35) {
        outPos.copy(_hit.point);
        _n.copy(_hit.normal);
      }
    }
    outPos.addScaledVector(_n, car.def.comHeight + 0.012);
    levelQuaternion(_fwd, _n, outQuat);

    // ── is the destination actually EMPTY? ──
    // Finding a floor is not the same as finding room. Dropping the car onto a
    // point already occupied by scenery or another car is what turns a respawn
    // into a respawn-stuck-respawn loop. Nudge along the line until it is clear,
    // and if nothing is, lift straight up — falling a short way onto the track
    // is always recoverable, being interpenetrated is not.
    if (!this._isClear(car, outPos)) {
      const path = this.carSystem?.aiPath;
      let freed = false;
      if (path) {
        const pr = path.projectGlobal(outPos);
        // Walk BOTH ways along the line, nearest offset first, so a car blocked
        // by something long (a fallen barrier lying down the track) still gets
        // out without being sent half a lap backwards.
        for (let k = 1; k <= 14 && !freed; k++) {
          for (const dir of (k & 1) ? BACK_FIRST : FWD_FIRST) {
            path.sampleAt(pr.s + dir * k * 0.8, _tmp, pr.index);
            _tmp.addScaledVector(_n, car.def.comHeight + 0.012);
            if (this._isClear(car, _tmp)) { outPos.copy(_tmp); freed = true; break; }
          }
        }
      }
      if (!freed) {
        // Nothing along the line is free — drop in from above instead. A short
        // fall onto the track always resolves; being interpenetrated does not.
        outPos.addScaledVector(_n, Math.max(0.35, car.def.length));
      }
    }
    return true;
  }

  /**
   * Is there room for `car` at `p`? Checks other cars and physics bodies, not
   * the static mesh — the floor raycast already handled terrain, and what
   * actually traps a respawn is a prop or a rival sitting on the spot.
   *
   * Uses `overlapSphere`, which is the cheap bounding-sphere test; a respawn
   * happens a handful of times a race, so exactness is not worth a hull query.
   * @param {import('./Car.js').Car} car @param {THREE.Vector3} p
   */
  _isClear(car, p) {
    const physics = this.game?.physics;
    if (!physics?.overlapSphere) return true;
    const r = Math.max(0.06, car.def.hullHalf[2] * this.clearance);
    this._overlap ??= [];
    const n = physics.overlapSphere(p, r, this._overlap,
      Layer.CAR | Layer.PROP | Layer.DEBRIS);
    for (let i = 0; i < n; i++) {
      // Our own body does not block us.
      if (this._overlap[i] !== car.body) return false;
    }
    return true;
  }

  /** Pooled 'car:respawn' payload (8-entry ring). */
  _event() {
    this._ring ??= (() => {
      const r = new Array(8);
      for (let i = 0; i < 8; i++) r[i] = { carId: 0, position: new THREE.Vector3(), reason: '' };
      return r;
    })();
    this._ri = ((this._ri ?? 0) + 1) % 8;
    return this._ring[this._ri];
  }

  /** True while a car is mid-respawn (camera / HUD may want to know). */
  isRespawning(car) {
    const st = this.states.get(car);
    return !!st && st.state !== STATE_IDLE;
  }

  /** 0..1 how far through the respawn sequence a car is. */
  progress(car) {
    const st = this.states.get(car);
    if (!st || st.state === STATE_IDLE) return 0;
    const total = st.state === STATE_FADE ? this.fadeOut : this.settleTime;
    return clamp01(1 - st.timer / Math.max(1e-3, total));
  }
}

/**
 * Build an orientation with `up` = surface normal and the heading taken from
 * `forward` (projected into the surface plane). −Z is forward, so the basis is
 * assembled as [right, up, −forward].
 * @param {THREE.Vector3} forward
 * @param {THREE.Vector3} up
 * @param {THREE.Quaternion} out
 */
export function levelQuaternion(forward, up, out) {
  _up.copy(up);
  if (_up.lengthSq() < 1e-8) _up.copy(WORLD_UP);
  _up.normalize();
  _tmp.copy(forward).addScaledVector(_up, -forward.dot(_up));
  if (_tmp.lengthSq() < 1e-8) {
    _tmp.set(0, 0, -1).addScaledVector(_up, -(-_up.z));
    if (_tmp.lengthSq() < 1e-8) _tmp.set(1, 0, 0);
  }
  _tmp.normalize();
  _right.crossVectors(_tmp, _up).normalize();      // right = forward × up  (= +X)
  _back.copy(_tmp).multiplyScalar(-1);             // local +Z is backwards
  _m3.makeBasis(_right, _up, _back);
  return out.setFromRotationMatrix(_m3);
}

export default Respawn;
