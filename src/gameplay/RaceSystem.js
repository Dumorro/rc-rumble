/**
 * RaceSystem — the rules of the race. Registered as `game.race`.
 *
 * Owns, per car: checkpoint validation (strictly in order), lap counting,
 * a continuous `progress` value (laps + fraction of lap) used for standings,
 * live position, wrong-way detection, lap / best-lap / total timing to the
 * millisecond, final-lap detection, finishing order, DNF handling and the
 * results payload.
 *
 * Also drives the race *flow*: 3-2-1-GO with the controls gated by the Game
 * state machine, then — once the player crosses the line — a finish-cam phase
 * during which the AI keeps racing until everyone is home or a timeout expires.
 *
 * Emits (canonical): race:countdown, race:start, race:checkpoint, race:lap,
 * race:position, race:finish, race:end, audio:music, camera:mode, car:respawn.
 * Emits (extra, documented in the return value): race:finalLap,
 * race:wrongway, race:lapRecord, race:phase.
 *
 * Degrades gracefully: with no track, no checkpoints or no centreline it stays
 * in a free-roam mode where everything still runs and nothing throws.
 */

import * as THREE from 'three';
import CONFIG from '../core/Config.js';
import { GameState } from '../core/Game.js';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { TrackNav, wrap01, loopDelta } from './TrackNav.js';
import { Standings, ProgressTrace, formatTime, formatGap, ordinal } from './Standings.js';

// ── scratch ────────────────────────────────────────────────────────────────
const _pos = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _la = new THREE.Vector3();
const _lb = new THREE.Vector3();
const _seg = { t: 0 };

export const RacePhase = Object.freeze({
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHING: 'finishing',   // player home, AI still running
  ENDED: 'ended',
});

/** Per-car race bookkeeping. Mirrored onto the Car for the public contract. */
export class RaceEntry {
  constructor(car, gridIndex) {
    /** @type {import('../vehicle/Car.js').Car} */
    this.car = car;
    this.id = car?.id ?? gridIndex;
    this.gridIndex = gridIndex;
    this.name = car?.def?.name ?? car?.name ?? (car?.isPlayer ? 'Player' : `CPU ${gridIndex + 1}`);
    this.isPlayer = !!car?.isPlayer;

    this.lap = 0;
    /** Last validly passed checkpoint index. */
    this.checkpoint = -1;
    /** The only checkpoint index this car may legally take next. */
    this.nextCheckpoint = 0;
    /** Gates legitimately skipped this lap (a small allowance, see MAX_SKIPS). */
    this.skips = 0;

    this.lapTime = 0;
    this.lastLap = 0;
    this.bestLap = Infinity;
    /** @type {number[]} */
    this.lapTimes = [];
    this.totalTime = 0;

    this.finished = false;
    this.finishTime = 0;
    this.finishOrder = -1;
    this.dnf = false;
    this.place = gridIndex + 1;
    this.prevPlace = gridIndex + 1;

    /** Continuous standings key: laps + fraction of lap. Monotonic while driving forward. */
    this.progress = 0;
    /**
     * Raw accumulated lap fraction. Built by integrating the per-step change in
     * `u`, so it is continuous across the finish line no matter what the lap
     * bookkeeping is doing. `progress` is this value clamped to the end of the
     * car's validated lap, which is what stops a gate-skipper being scored ahead.
     */
    this.uAccum = 0;
    this.hasProgress = false;
    this._lastU = 0;
    this._rejects = 0;
    /** Fraction of lap, 0 at the finish line. */
    this.u = 0;
    /** Raw centreline parameter (not finish-line relative). */
    this.rawU = -1;
    /** Signed metres from the centreline, + = right of travel. */
    this.lateral = 0;
    this.navDistance = 0;
    this.tangent = new THREE.Vector3(0, 0, -1);

    this.wrongWay = false;
    this._wrongTimer = 0;
    this.offTrack = false;
    this._offTimer = 0;
    this._stuckTimer = 0;
    this._respawnCooldown = 0;
    this.respawnCount = 0;
    this.lastCheckpointTime = 0;
    this.finalLapAnnounced = false;

    this.prevPos = new THREE.Vector3();
    this.hasPrev = false;
    this.trace = new ProgressTrace();
  }

  reset() {
    this.lap = 0;
    this.checkpoint = -1;
    this.nextCheckpoint = 0;
    this.skips = 0;
    this.lapTime = 0;
    this.lastLap = 0;
    this.bestLap = Infinity;
    this.lapTimes.length = 0;
    this.totalTime = 0;
    this.finished = false;
    this.finishTime = 0;
    this.finishOrder = -1;
    this.dnf = false;
    this.progress = 0;
    this.uAccum = 0;
    this.hasProgress = false;
    this._lastU = 0;
    this._rejects = 0;
    this.u = 0;
    this.rawU = -1;
    this.wrongWay = false;
    this._wrongTimer = 0;
    this.offTrack = false;
    this._offTimer = 0;
    this._stuckTimer = 0;
    this._respawnCooldown = 0;
    this.respawnCount = 0;
    this.lastCheckpointTime = 0;
    this.finalLapAnnounced = false;
    this.hasPrev = false;
    this.trace.reset();
  }
}

/** How many awkward gates a car may miss per lap before it must go back. */
const MAX_SKIPS = 1;

export class RaceSystem {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.bus = game?.bus ?? null;

    this.phase = RacePhase.IDLE;
    /** Total laps for this race. */
    this.laps = CONFIG.startup.laps;
    /** Seconds since GO. */
    this.raceTime = 0;
    /** Counts down to GO; > 0 only during the countdown phase. */
    this.countdown = 0;
    /** The number currently on screen (3,2,1,0). */
    this.countdownN = 3;

    /** @type {RaceEntry[]} grid order, never re-sorted */
    this.entries = [];
    /** @type {Map<number, RaceEntry>} */
    this.byId = new Map();
    /** @type {RaceEntry[]} in the order they crossed the line */
    this.finishers = [];
    /** Live standings helper — shared with the UI and the AI. */
    this.standings = new Standings(this);
    /** Centreline lookup table. */
    this.nav = new TrackNav(null);

    /** Precomputed checkpoint gates. */
    this.gates = [];
    this.finishGate = 0;
    /** Centreline parameter of the finish line. */
    this.finishU = 0;

    /** Set when the track gives us no checkpoints — everything still runs. */
    this.freeRoam = true;
    /** Latest results payload (also `race.results` for the entry array). */
    this.lastResults = null;
    /** @type {object[]} */
    this.results = [];
    this.bestLapOverall = { carId: -1, name: '', time: Infinity, lap: 0 };

    // ── tuning ──────────────────────────────────────────────────────────
    /** Quiet beat before the first "3" so the countdown does not clip the load. */
    this.preRoll = 0.85;
    /** Sim seconds the AI gets to finish after the player is home. */
    this.postRaceTimeout = 26.0;
    /** Minimum finish-cam hold before the results screen. */
    this.finishCamSeconds = CONFIG.race.finishCamSeconds ?? 6.0;
    /** Hard ceiling on race length; everything left is DNF'd. */
    this.raceTimeLimit = 900;
    /** Freeze horizontal motion on the grid until GO. */
    this.holdGrid = true;
    /** Auto-respawn a car that is upside down / wedged / off the world. */
    this.autoRespawn = true;
    this.upsideDownGrace = 2.4;
    this.stuckGrace = 3.2;
    this.offTrackGrace = 6.0;
    /** Handle the reset key here as well as in the vehicle sim (idempotent). */
    this.handleResetKey = true;
    /** Lateral distance beyond the road half-width that counts as off-track. */
    this.offTrackMargin = 1.6;

    this._postRaceTimer = 0;
    this._lastBeep = 999;
    /** Largest believable per-step change in `u`; recomputed per race. */
    this._maxDu = 1;
    this._respawnScratch = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), checkpointIndex: 0 };
    this._hud = {
      phase: RacePhase.IDLE, countdown: 0, countdownN: 3, ready: false,
      raceTime: 0, lap: 1, laps: 3, place: 1, carCount: 0,
      lapTime: 0, lastLap: 0, bestLap: Infinity, sessionBest: Infinity,
      gapAhead: 0, gapLeader: 0, wrongWay: false, finalLap: false,
      finished: false, freeRoam: true, timeText: '0:00.000', lapText: '0:00.000',
    };
    this._ladder = [];
  }

  async init() {}

  // ═══════════════════════════════════════════════════════════════ lifecycle

  onRaceStart(ctx) {
    const track = ctx?.track ?? this.game?.track ?? null;
    const cars = ctx?.cars ?? this.game?.cars ?? [];
    const cfg = ctx?.config ?? this.game?.raceConfig ?? null;

    this.laps = Math.max(1, Math.round(cfg?.laps ?? CONFIG.startup.laps ?? 3));
    this.raceTime = 0;
    this._postRaceTimer = 0;
    this.finishers.length = 0;
    this.results = [];
    this.lastResults = null;
    this.bestLapOverall = { carId: -1, name: '', time: Infinity, lap: 0 };

    // ── centreline ──
    this.nav.dispose();
    this.nav = new TrackNav(track, { searchWindow: 48 });

    // ── gates ──
    this._buildGates(track);

    // ── entries ──
    this.entries.length = 0;
    this.byId.clear();
    for (let i = 0; i < cars.length; i++) {
      const e = new RaceEntry(cars[i], i);
      e.nextCheckpoint = this.gates.length > 1
        ? (this.finishGate + 1) % this.gates.length
        : this.finishGate;
      e.checkpoint = this.gates.length ? this.finishGate : -1;
      this.entries.push(e);
      this.byId.set(e.id, e);
      this._mirror(e);
    }
    this.standings.bind(this.entries);

    // Seed progress from the grid so the very first standings order is sane.
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      simPos(e.car, _pos);
      e.prevPos.copy(_pos);
      e.hasPrev = true;
      if (this.nav.ready) {
        const hit = this.nav.closest(_pos, -1);
        e.rawU = hit.u;
        e.u = wrap01(hit.u - this.finishU);
        e._lastU = e.u;
        // The grid sits within half a lap of the line. Anchor cars behind it to
        // a small negative value so the first crossing reads as progress ≈ 0.
        e.uAccum = e.u > 0.5 ? e.u - 1 : e.u;
        e.progress = e.uAccum;
        e.hasProgress = true;
      } else {
        e.uAccum = -i * 1e-4;
        e.progress = e.uAccum;
        e.hasProgress = true;
      }
      e.trace.sample(e.progress, 0);
    }

    // A change in `u` larger than this in one step can only be a glitch or a
    // teleport (40 m/s on this centreline), so it is discarded.
    this._maxDu = this.nav.ready
      ? Math.max(0.004, (40 * CONFIG.physics.fixedDt) / this.nav.length)
      : 1;
    this.standings.update(0);
    this._assignPlaces(true);

    this.phase = RacePhase.COUNTDOWN;
    this.countdown = (CONFIG.race.countdownSeconds ?? 3) + this.preRoll;
    this.countdownN = Math.ceil(CONFIG.race.countdownSeconds ?? 3);
    this._lastBeep = this.countdownN + 1;
    this.bus?.emit('race:phase', { phase: this.phase });
  }

  onRaceEnd() {
    this.phase = RacePhase.IDLE;
    this.entries.length = 0;
    this.byId.clear();
    this.finishers.length = 0;
    this.standings.clear();
    this.gates.length = 0;
    this.nav.dispose();
    this.freeRoam = true;
  }

  dispose() { this.onRaceEnd(); }

  // ═══════════════════════════════════════════════════════════════ gates

  _buildGates(track) {
    this.gates.length = 0;
    this.finishGate = 0;
    this.finishU = 0;
    const raw = Array.isArray(track?.checkpoints) ? track.checkpoints : [];
    if (raw.length === 0) {
      this.freeRoam = true;
      return;
    }

    // Sort by declared index, falling back to array order.
    const list = raw.map((c, i) => ({ c, i })).sort((a, b) => {
      const ai = a.c?.index ?? a.i, bi = b.c?.index ?? b.i;
      return ai === bi ? a.i - b.i : ai - bi;
    });

    for (let k = 0; k < list.length; k++) {
      const c = list[k].c;
      const p = c?.position;
      if (!p || typeof p.x !== 'number') continue;
      const quat = new THREE.Quaternion();
      if (c.quaternion) quat.copy(c.quaternion);
      const half = new THREE.Vector3(
        Math.max(0.25, c?.halfExtents?.x ?? 2.2),
        Math.max(0.25, c?.halfExtents?.y ?? 1.1),
        Math.max(0.08, c?.halfExtents?.z ?? 0.35),
      );
      const gate = {
        index: this.gates.length,
        sourceIndex: c?.index ?? list[k].i,
        position: new THREE.Vector3().copy(p),
        quaternion: quat,
        invQuaternion: quat.clone().invert(),
        half,
        isFinish: !!c?.isFinish,
        /** Unit vector along the legal direction of travel. */
        forward: new THREE.Vector3(0, 0, -1).applyQuaternion(quat),
        u: 0,
        source: c,
      };
      this.gates.push(gate);
    }

    if (this.gates.length === 0) { this.freeRoam = true; return; }
    this.freeRoam = false;

    // Finish line = the flagged gate, else gate 0.
    this.finishGate = Math.max(0, this.gates.findIndex(g => g.isFinish));
    if (this.finishGate < 0) this.finishGate = 0;
    this.gates[this.finishGate].isFinish = true;

    // Centreline parameter per gate, and a sanity pass on the gate facing:
    // if a gate points against the direction of travel, flip it. Tracks that
    // author quaternions loosely still get correct lap counting.
    if (this.nav.ready) {
      for (let i = 0; i < this.gates.length; i++) {
        const g = this.gates[i];
        const hit = this.nav.closest(g.position, -1);
        g.u = hit.u;
        if (g.forward.dot(hit.tangent) < 0) {
          g.forward.negate();
        }
        // Widen a gate that is clearly narrower than the road it sits on.
        const need = hit.halfWidth * 1.15;
        if (g.half.x < need) g.half.x = need;
      }
      this.finishU = this.gates[this.finishGate].u;
    } else {
      // No centreline: derive u from gate ordering so progress still advances.
      for (let i = 0; i < this.gates.length; i++) this.gates[i].u = i / this.gates.length;
      this.finishU = this.gates[this.finishGate].u;
    }

    // A single-gate track is legal (each forward crossing = one lap).
    if (this.gates.length === 1) this.gates[0].isFinish = true;
  }

  // ═══════════════════════════════════════════════════════════════ step

  /** @param {number} dt always CONFIG.physics.fixedDt */
  fixedUpdate(dt) {
    if (this.phase === RacePhase.IDLE || this.phase === RacePhase.ENDED) return;
    const entries = this.entries;
    if (entries.length === 0) {
      if (this.phase === RacePhase.COUNTDOWN) this._stepCountdown(dt);
      return;
    }

    if (this.phase === RacePhase.COUNTDOWN) {
      this._stepCountdown(dt);
      // Keep everyone honest on the grid and keep the visuals alive.
      for (let i = 0; i < entries.length; i++) {
        this._trackPosition(entries[i]);
        if (this.holdGrid) this._holdOnGrid(entries[i]);
      }
      this._updateHud();
      return;
    }

    this.raceTime += dt;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const car = e.car;
      if (!car) continue;

      if (e._respawnCooldown > 0) e._respawnCooldown -= dt;

      if (!e.finished && !e.dnf) {
        e.totalTime += dt;
        e.lapTime += dt;
      }

      this._trackPosition(e);
      if (!e.finished && !this.freeRoam) this._checkGates(e);
      this._checkWrongWay(e, dt);
      if (this.autoRespawn) this._checkRecovery(e, dt);

      e.trace.sample(e.progress, this.raceTime);
      this._mirror(e);
    }

    // Handle the player's reset request here too, so a respawn always works.
    if (this.handleResetKey) this._pollResetKey();

    this.standings.update(this.raceTime);
    this._assignPlaces(false);

    if (this.phase === RacePhase.FINISHING) {
      this._postRaceTimer += dt;
      const everyoneHome = this._allDone();
      if (everyoneHome && this._postRaceTimer >= Math.min(2.2, this.finishCamSeconds)) this._endRace();
      else if (this._postRaceTimer >= this.postRaceTimeout) this._endRace();
    } else if (!this.freeRoam && this.raceTime > this.raceTimeLimit) {
      this._endRace();
    }

    this._updateHud();
  }

  _stepCountdown(dt) {
    this.countdown -= dt;
    const n = Math.max(0, Math.ceil(this.countdown - 1e-6));
    if (n <= (CONFIG.race.countdownSeconds ?? 3) && n < this._lastBeep) {
      this._lastBeep = n;
      this.countdownN = n;
      this.bus?.emit('race:countdown', { n });
    }
    if (this.countdown <= 0) {
      if (this._lastBeep !== 0) {
        this._lastBeep = 0;
        this.countdownN = 0;
        this.bus?.emit('race:countdown', { n: 0 });
      }
      this._go();
    }
  }

  _go() {
    this.phase = RacePhase.RACING;
    this.countdown = 0;
    this.raceTime = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      e.lapTime = 0;
      e.totalTime = 0;
      e.trace.reset();
      e.trace.sample(e.progress, 0);
      e.car?.body?.wake?.();
    }
    this.game?.setState?.(GameState.RACING);
    this.bus?.emit('race:phase', { phase: this.phase });
    this.bus?.emit('race:start', {});
    this.bus?.emit('audio:music', { intent: 'race' });
  }

  /** Damp horizontal creep before GO so the standing start is a real one. */
  _holdOnGrid(e) {
    const body = e.car?.body;
    if (!body || body.static) return;
    body.velocity.x *= 0.55;
    body.velocity.z *= 0.55;
    body.angularVelocity.multiplyScalar(0.55);
  }

  // ── position / progress ────────────────────────────────────────────────

  _trackPosition(e) {
    const car = e.car;
    if (!car) return;
    simPos(car, _pos);
    if (!e.hasPrev) { e.prevPos.copy(_pos); e.hasPrev = true; }

    if (this.nav.ready) {
      const hit = this.nav.closest(_pos, e.rawU);
      e.rawU = hit.u;
      e.lateral = hit.lateral;
      e.navDistance = hit.distance;
      e.tangent.copy(hit.tangent);
      const u = wrap01(hit.u - this.finishU);
      if (!e.hasProgress) {
        e.u = u; e._lastU = u; e.uAccum = u; e.hasProgress = true;
      } else {
        // Integrate the *change* in u: continuous across the finish line, and
        // immune to whatever the lap bookkeeping is doing.
        const du = loopDelta(e._lastU, u);
        if (Math.abs(du) <= this._maxDu) {
          e.uAccum += du;
          e._lastU = u;
          e._rejects = 0;
        } else if (++e._rejects > 24) {
          // Persistent disagreement (respawn we did not see, closest-point
          // flip on a self-crossing track) — resync without crediting distance.
          e._lastU = u;
          e._rejects = 0;
        }
        e.u = u;
      }
      // A car may never be scored past the end of the lap it has validated.
      // This is what makes gate-skipping worthless without punishing anyone.
      e.progress = this.freeRoam ? e.uAccum : Math.min(e.uAccum, e.lap + 1 - 1e-4);
      e.offTrack = hit.distance > hit.halfWidth + this.offTrackMargin;
    } else {
      // No centreline: fall back to checkpoint-fraction progress.
      const n = this.gates.length;
      if (n > 0) {
        const cp = e.checkpoint >= 0 ? e.checkpoint : this.finishGate;
        const frac = wrap01((cp - this.finishGate) / n + 0.5 / n);
        e.u = frac;
        e._lastU = frac;
        e.uAccum = e.lap + frac;
        e.progress = e.uAccum;
        e.hasProgress = true;
      } else {
        e.progress = e.uAccum = e.lap;
      }
      e.offTrack = false;
    }
  }

  _checkWrongWay(e, dt) {
    const car = e.car;
    if (!car || e.finished || this.freeRoam || !this.nav.ready) {
      if (e.wrongWay) { e.wrongWay = false; this.bus?.emit('race:wrongway', { carId: e.id, active: false }); }
      return;
    }
    carForward(car, _fwd);
    const along = _fwd.dot(e.tangent);
    const speed = Math.abs(car.speed ?? 0);
    const threshold = Math.cos(CONFIG.race.wrongWayAngle ?? Math.PI * 0.6);
    const bad = along < threshold && speed > 0.55;
    if (bad) e._wrongTimer = Math.min(1.2, e._wrongTimer + dt);
    else e._wrongTimer = Math.max(0, e._wrongTimer - dt * 1.8);

    const next = e._wrongTimer > 0.38;
    if (next !== e.wrongWay) {
      e.wrongWay = next;
      this.bus?.emit('race:wrongway', { carId: e.id, active: next });
    }
  }

  // ── checkpoints ────────────────────────────────────────────────────────

  _checkGates(e) {
    const n = this.gates.length;
    if (n === 0) return;
    const car = e.car;
    simPos(car, _pos);
    _prev.copy(e.prevPos);
    e.prevPos.copy(_pos);
    if (_prev.distanceToSquared(_pos) < 1e-10) return;

    // 1. The gate we are supposed to take next.
    const next = e.nextCheckpoint;
    if (this._crossed(this.gates[next], _prev, _pos, +1)) {
      this._passGate(e, next, 0);
      return;
    }

    // 2. One gate of slack — a narrow or badly placed gate should not deadlock
    //    the lap. Never applies to the finish line, and only once per lap.
    if (n > 2 && e.skips < MAX_SKIPS) {
      const skip = (next + 1) % n;
      if (skip !== this.finishGate && this._crossed(this.gates[skip], _prev, _pos, +1)) {
        this._passGate(e, skip, 1);
        return;
      }
    }

    // 3. Reversing back through the gate we just took rolls the lap state back.
    if (e.checkpoint >= 0 && this._crossed(this.gates[e.checkpoint], _prev, _pos, -1)) {
      this._unpassGate(e, e.checkpoint);
    }
  }

  /**
   * Did the segment prev→cur pass through the gate box in direction `dir`?
   * Allocation free; works in the gate's local frame.
   */
  _crossed(gate, prev, cur, dir) {
    if (!gate) return false;
    // Cheap radius reject first.
    const r = gate.half.length() + prev.distanceTo(cur);
    if (gate.position.distanceToSquared(cur) > r * r
      && gate.position.distanceToSquared(prev) > r * r) return false;

    // Direction of travel through the plane.
    _v.copy(cur).sub(prev);
    const along = _v.dot(gate.forward);
    if (dir > 0 ? along <= 0 : along >= 0) return false;

    _la.copy(prev).sub(gate.position).applyQuaternion(gate.invQuaternion);
    _lb.copy(cur).sub(gate.position).applyQuaternion(gate.invQuaternion);
    return segmentHitsBox(_la, _lb, gate.half, _seg);
  }

  _passGate(e, index, skipped) {
    const n = this.gates.length;
    e.checkpoint = index;
    e.skips += skipped;
    e.lastCheckpointTime = this.raceTime;
    e.nextCheckpoint = (index + 1) % n;
    this.bus?.emit('race:checkpoint', { carId: e.id, index: this.gates[index].sourceIndex });
    if (this.gates[index].isFinish) this._completeLap(e);
    this._mirror(e);
  }

  _unpassGate(e, index) {
    const n = this.gates.length;
    if (this.gates[index].isFinish && e.lap > 0) {
      // Un-count the lap so `progress` stays continuous across the line.
      e.lap--;
      const t = e.lapTimes.pop();
      if (t !== undefined) {
        e.lapTime = t;
        e.lastLap = e.lapTimes.length ? e.lapTimes[e.lapTimes.length - 1] : 0;
        e.bestLap = e.lapTimes.length ? Math.min(...e.lapTimes) : Infinity;
      }
      e.finalLapAnnounced = false;
    }
    e.nextCheckpoint = index;
    e.checkpoint = (index - 1 + n) % n;
    e.skips = 0;
  }

  _completeLap(e) {
    e.lap++;
    e.skips = 0;
    const lt = e.lapTime;
    e.lapTime = 0;
    e.lastLap = lt;
    e.lapTimes.push(lt);
    if (lt > 0 && lt < e.bestLap) e.bestLap = lt;
    if (lt > 0 && lt < this.bestLapOverall.time) {
      this.bestLapOverall = { carId: e.id, name: e.name, time: lt, lap: e.lap };
      this.bus?.emit('race:lapRecord', { carId: e.id, lapTime: lt, lap: e.lap });
    }
    this.bus?.emit('race:lap', { carId: e.id, lap: e.lap, lapTime: lt, best: e.bestLap });

    if (e.lap >= this.laps) {
      this._finishCar(e);
      return;
    }
    if (e.lap === this.laps - 1 && !e.finalLapAnnounced) {
      e.finalLapAnnounced = true;
      this.bus?.emit('race:finalLap', { carId: e.id, lap: e.lap + 1, laps: this.laps });
      if (e.isPlayer) this.bus?.emit('audio:music', { intent: 'finalLap' });
    }
  }

  _finishCar(e) {
    if (e.finished) return;
    e.finished = true;
    e.finishTime = e.totalTime;
    e.finishOrder = this.finishers.length;
    e.place = e.finishOrder + 1;
    e.lapTime = 0;
    this.finishers.push(e);
    this._mirror(e);
    this.bus?.emit('race:finish', { carId: e.id, place: e.place, totalTime: e.finishTime });

    if (e.isPlayer) this._onPlayerFinish(e);
    if (this._allDone()) {
      // Everyone home. Give the finish cam a beat, then results.
      if (this.phase !== RacePhase.FINISHING) {
        this.phase = RacePhase.FINISHING;
        this._postRaceTimer = 0;
        this.bus?.emit('race:phase', { phase: this.phase });
      }
    }
  }

  _onPlayerFinish(e) {
    this.phase = RacePhase.FINISHING;
    this._postRaceTimer = 0;
    this.game?.setState?.(GameState.FINISHED);
    this.bus?.emit('race:phase', { phase: this.phase });
    this.bus?.emit('camera:mode', { mode: 'finish' });
    this.bus?.emit('audio:music', { intent: e.place === 1 ? 'victory' : 'race' });
    // Hint for the vehicle/AI layer: the human is done, feel free to drive it.
    if (e.car) e.car.autoDrive = true;
  }

  _allDone() {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e.finished && !e.dnf) return false;
    }
    return true;
  }

  // ── places ─────────────────────────────────────────────────────────────

  _assignPlaces(silent) {
    const order = this.standings.order;
    for (let i = 0; i < order.length; i++) {
      const e = order[i];
      const place = i + 1;
      if (e.place !== place) {
        e.prevPlace = e.place;
        e.place = place;
        if (e.car) e.car.place = place;
        if (!silent) this.bus?.emit('race:position', { carId: e.id, place, prevPlace: e.prevPlace });
      } else if (e.car) {
        e.car.place = place;
      }
    }
  }

  // ── recovery / respawn ─────────────────────────────────────────────────

  _pollResetKey() {
    const player = this.game?.playerCar;
    if (!player) return;
    if (!this.game?.input?.state?.reset) return;
    const e = this.byId.get(player.id);
    if (!e || e._respawnCooldown > 0) return;
    this.requestRespawn(player, 'manual');
  }

  _checkRecovery(e, dt) {
    const car = e.car;
    if (!car || e.finished || e._respawnCooldown > 0) return;

    // Off the bottom of the world.
    const bounds = this.game?.track?.environment?.bounds;
    const y = car.body?.position.y ?? 0;
    if (bounds && !bounds.isEmpty() && y < bounds.min.y - 3) {
      this.requestRespawn(car, 'fell');
      return;
    }

    const speed = Math.abs(car.speed ?? 0);
    const upside = !!car.upsideDown;
    if (upside && speed < 1.2) e._stuckTimer += dt;
    else if ((car.stuckTime ?? 0) > this.stuckGrace) e._stuckTimer += dt;
    else e._stuckTimer = Math.max(0, e._stuckTimer - dt * 2);

    if (e._stuckTimer > (upside ? this.upsideDownGrace : this.stuckGrace)) {
      this.requestRespawn(car, upside ? 'upsideDown' : 'stuck');
      return;
    }

    if (e.offTrack && this.nav.ready && e.navDistance > this.nav.halfWidthAt(e.rawU) + 6) {
      e._offTimer += dt;
      if (e._offTimer > this.offTrackGrace) this.requestRespawn(car, 'offTrack');
    } else {
      e._offTimer = Math.max(0, e._offTimer - dt * 2);
    }
  }

  /**
   * Put a car back on the road at its last checkpoint. Safe to call from
   * anywhere; absorbs duplicate calls within `CONFIG.race.respawnDelay`.
   * @param {object} car
   * @param {string} [reason]
   */
  requestRespawn(car, reason = 'manual') {
    const e = this.byId.get(car?.id);
    if (!e || e._respawnCooldown > 0) return false;
    e._respawnCooldown = Math.max(0.4, CONFIG.race.respawnDelay ?? 0.65);
    e.respawnCount++;
    e._stuckTimer = 0;
    e._offTimer = 0;

    const spot = this.getRespawn(e, this._respawnScratch);

    // Prefer the car's own respawn (it knows about wheels, antenna, engine…).
    let handled = false;
    if (typeof car.respawn === 'function') {
      try {
        car.respawn(spot.checkpointIndex, spot);
        handled = true;
      } catch (err) {
        console.warn('[RaceSystem] car.respawn threw, falling back to teleport:', err);
      }
    }
    if (!handled && car.body) {
      car.body.setTransform(spot.position, spot.quaternion, false);
      car.body.velocity.set(0, 0, 0);
      car.body.angularVelocity.set(0, 0, 0);
      car.body.clearForces();
      car.body.wake();
      if (car.group) {
        car.group.position.copy(spot.position);
        car.group.quaternion.copy(spot.quaternion);
      }
      this.bus?.emit('car:respawn', { carId: e.id, position: spot.position, reason });
    } else if (handled) {
      // The car did the work; still announce it for FX/audio/postfx.
      this.bus?.emit('car:respawn', { carId: e.id, position: spot.position, reason });
    }

    // Re-anchor progress so the teleport does not read as a lap.
    e.hasPrev = false;
    e.prevPos.copy(spot.position);
    if (this.nav.ready) {
      const hit = this.nav.closest(spot.position, -1);
      e.rawU = hit.u;
      e.u = wrap01(hit.u - this.finishU);
      e._lastU = e.u;
      e.uAccum = e.lap + e.u;
      e.progress = this.freeRoam ? e.uAccum : Math.min(e.uAccum, e.lap + 1 - 1e-4);
      e._rejects = 0;
    }
    this.game?.pickups?.effects?.reset?.(car);
    return true;
  }

  /**
   * Best respawn transform for an entry.
   * @param {RaceEntry} e
   * @param {{position:THREE.Vector3, quaternion:THREE.Quaternion, checkpointIndex:number}} out
   */
  getRespawn(e, out) {
    const track = this.game?.track;
    const cpIndex = e.checkpoint >= 0 ? this.gates[e.checkpoint]?.sourceIndex ?? 0 : 0;
    out.checkpointIndex = cpIndex;

    // 1. A respawn point authored for this checkpoint.
    const respawns = track?.respawns;
    if (Array.isArray(respawns) && respawns.length) {
      let best = null;
      for (let i = 0; i < respawns.length; i++) {
        if ((respawns[i]?.checkpointIndex ?? -1) === cpIndex) { best = respawns[i]; break; }
      }
      // 2. Otherwise the nearest respawn behind us on the centreline.
      if (!best && this.nav.ready) {
        let bestD = -Infinity;
        for (let i = 0; i < respawns.length; i++) {
          const p = respawns[i]?.position;
          if (!p) continue;
          const hit = this.nav.closest(p, -1);
          const d = loopDelta(hit.u, e.rawU);          // + when we are ahead of it
          if (d >= -0.01 && d > bestD) { bestD = d; best = respawns[i]; }
        }
        if (!best) best = respawns[0];
      }
      if (best?.position) {
        out.position.copy(best.position);
        if (best.quaternion) out.quaternion.copy(best.quaternion);
        else this._faceAlongTrack(out.position, out.quaternion);
        out.position.y += 0.06;
        return out;
      }
    }

    // 3. The checkpoint itself.
    const gate = e.checkpoint >= 0 ? this.gates[e.checkpoint] : this.gates[this.finishGate];
    if (gate) {
      out.position.copy(gate.position);
      out.quaternion.copy(gate.quaternion);
      // Nudge to the middle of the road and lift clear of the surface.
      out.position.y += 0.10;
      return out;
    }

    // 4. The grid slot.
    const slot = track?.startGrid?.[e.gridIndex] ?? track?.startGrid?.[0];
    if (slot?.position) {
      out.position.copy(slot.position);
      if (slot.quaternion) out.quaternion.copy(slot.quaternion);
      else out.quaternion.identity();
      out.position.y += 0.06;
      return out;
    }

    // 5. Last resort: the centreline.
    if (this.nav.ready) {
      this.nav.frameAt(e.rawU >= 0 ? e.rawU : 0, out.position, out.quaternion);
      out.position.y += 0.15;
      return out;
    }
    out.position.set(0, 0.3, 0);
    out.quaternion.identity();
    return out;
  }

  _faceAlongTrack(position, outQuat) {
    if (!this.nav.ready) { outQuat.identity(); return outQuat; }
    const hit = this.nav.closest(position, -1);
    _v.set(0, 0, -1);
    outQuat.setFromUnitVectors(_v, hit.tangent);
    return outQuat;
  }

  // ── results ────────────────────────────────────────────────────────────

  _endRace() {
    if (this.phase === RacePhase.ENDED) return;
    this.phase = RacePhase.ENDED;

    // Everyone still out there is a DNF, ranked by how far they got.
    const stragglers = this.entries.filter(e => !e.finished);
    stragglers.sort((a, b) => b.progress - a.progress);
    for (let i = 0; i < stragglers.length; i++) {
      const e = stragglers[i];
      e.dnf = true;
      e.place = this.finishers.length + i + 1;
      if (e.car) { e.car.place = e.place; e.car.finished = false; }
    }

    const results = this._buildResults();
    this.lastResults = results;
    this.results = results.entries;

    this.bus?.emit('race:phase', { phase: this.phase });
    this.bus?.emit('race:end', { results });
    const player = results.playerEntry;
    this.bus?.emit('audio:music', { intent: player && player.place === 1 ? 'victory' : 'menu' });
    this.bus?.emit('camera:mode', { mode: 'podium' });
    this.game?.setState?.(GameState.RESULTS);
  }

  /** Force the race to end right now (menu quit, debug). */
  abort() {
    if (this.phase === RacePhase.IDLE || this.phase === RacePhase.ENDED) return;
    this._endRace();
  }

  _buildResults() {
    const track = this.game?.track;
    const ordered = this.entries.slice().sort((a, b) => a.place - b.place);
    const winner = ordered[0] ?? null;
    const entries = ordered.map((e) => ({
      carId: e.id,
      name: e.name,
      carId_def: e.car?.def?.id ?? null,
      carName: e.car?.def?.name ?? e.name,
      isPlayer: e.isPlayer,
      place: e.place,
      laps: e.lap,
      totalTime: e.finished ? e.finishTime : e.totalTime,
      bestLap: Number.isFinite(e.bestLap) ? e.bestLap : null,
      lapTimes: e.lapTimes.slice(),
      finished: e.finished,
      dnf: e.dnf,
      respawns: e.respawnCount,
      gapToWinner: winner && e.finished && winner.finished ? e.finishTime - winner.finishTime : null,
      progress: e.progress,
    }));
    const playerEntry = entries.find(x => x.isPlayer) ?? null;
    return {
      trackId: track?.id ?? null,
      trackName: track?.name ?? null,
      mode: this.game?.raceConfig?.mode ?? 'single',
      laps: this.laps,
      carCount: this.entries.length,
      raceTime: this.raceTime,
      entries,
      winner: entries[0] ?? null,
      playerEntry,
      playerPlace: playerEntry?.place ?? 0,
      playerWon: !!playerEntry && playerEntry.place === 1,
      bestLapOverall: Number.isFinite(this.bestLapOverall.time) ? { ...this.bestLapOverall } : null,
    };
  }

  // ── mirrors + public reads ─────────────────────────────────────────────

  /** Push the race state onto the Car so every other system sees the contract. */
  _mirror(e) {
    const car = e.car;
    if (!car) return;
    car.lap = e.lap;
    car.checkpoint = e.checkpoint < 0 ? 0 : this.gates[e.checkpoint]?.sourceIndex ?? 0;
    car.place = e.place;
    car.progress = e.progress;
    car.lapTime = e.lapTime;
    car.bestLap = e.bestLap;
    car.totalTime = e.finished ? e.finishTime : e.totalTime;
    car.finished = e.finished;
    car.wrongWay = e.wrongWay;
  }

  _updateHud() {
    const h = this._hud;
    const player = this.game?.playerCar;
    const e = player ? this.byId.get(player.id) : null;
    h.phase = this.phase;
    h.ready = this.entries.length > 0;
    h.countdown = Math.max(0, this.countdown);
    h.countdownN = this.countdownN;
    h.raceTime = this.raceTime;
    h.laps = this.laps;
    h.carCount = this.entries.length;
    h.freeRoam = this.freeRoam;
    h.sessionBest = this.bestLapOverall.time;
    if (e) {
      h.lap = Math.min(this.laps, e.lap + 1);
      h.place = e.place;
      h.lapTime = e.lapTime;
      h.lastLap = e.lastLap;
      h.bestLap = e.bestLap;
      h.wrongWay = e.wrongWay;
      h.finished = e.finished;
      h.finalLap = e.lap === this.laps - 1;
      h.gapAhead = this.standings.intervalAhead(e.car);
      h.gapLeader = this.standings.gapToLeader(e.car);
      h.timeText = formatTime(e.finished ? e.finishTime : e.totalTime);
      h.lapText = formatTime(e.lapTime);
    }
    return h;
  }

  // ═══════════════════════════════════════════════════════════════ public API

  /** The HUD snapshot object (same instance every call — do not retain fields). */
  getHud() { return this._hud; }

  /** @returns {RaceEntry|null} */
  entryFor(carOrId) {
    if (!carOrId) return null;
    const id = typeof carOrId === 'number' ? carOrId : carOrId.id;
    return this.byId.get(id) ?? null;
  }

  /** 1-based position. */
  placeOf(carOrId) { return this.entryFor(carOrId)?.place ?? 0; }
  progressOf(carOrId) { return this.entryFor(carOrId)?.progress ?? 0; }
  lapOf(carOrId) { return this.entryFor(carOrId)?.lap ?? 0; }
  isFinished(carOrId) { return !!this.entryFor(carOrId)?.finished; }

  /** Standings ladder for the UI, best first. Fills and returns an array. */
  getLadder() { return this.standings.fill(this._ladder); }

  get carCount() { return this.entries.length; }
  get isRacing() { return this.phase === RacePhase.RACING || this.phase === RacePhase.FINISHING; }
  get isCountdown() { return this.phase === RacePhase.COUNTDOWN; }
  get finalLap() {
    const l = this.standings.leader;
    return !!l && l.lap >= this.laps - 1;
  }

  /** Leader / last car shortcuts used by the weapons. */
  get leaderCar() { return this.standings.leaderCar; }
  get lastCar() { return this.standings.lastCar; }

  /** Normalised field position (0 = leader, 1 = last). */
  fieldT(car) { return this.standings.fieldT(car); }

  /** `1:23.456` */
  formatTime(s, opts) { return formatTime(s, opts); }
  formatGap(s, opts) { return formatGap(s, opts); }
  ordinal(n) { return ordinal(n); }
}

// ═══════════════════════════════════════════════════════════════ helpers

/** Exact physics position (never the interpolated visual one). */
export function simPos(car, out) {
  if (car?.body?.position) return out.copy(car.body.position);
  if (typeof car?.simPosition === 'function') return car.simPosition(out);
  if (car?.group?.position) return out.copy(car.group.position);
  return out.set(0, 0, 0);
}

/** Forward axis of a car (-Z). */
export function carForward(car, out) {
  if (car?.body?.getForward) return car.body.getForward(out);
  if (typeof car?.getForward === 'function') return car.getForward(out);
  if (car?.group) return out.set(0, 0, -1).applyQuaternion(car.group.quaternion);
  return out.set(0, 0, -1);
}

/**
 * Segment (a→b) vs origin-centred AABB with half extents `h`. Slab clipping,
 * allocation free. Writes the entry parameter into `out.t`.
 */
function segmentHitsBox(a, b, h, out) {
  let t0 = 0, t1 = 1;
  for (let axis = 0; axis < 3; axis++) {
    const ao = axis === 0 ? a.x : axis === 1 ? a.y : a.z;
    const bo = axis === 0 ? b.x : axis === 1 ? b.y : b.z;
    const ho = axis === 0 ? h.x : axis === 1 ? h.y : h.z;
    const d = bo - ao;
    if (Math.abs(d) < 1e-9) {
      if (ao < -ho || ao > ho) return false;
      continue;
    }
    let lo = (-ho - ao) / d;
    let hi = (ho - ao) / d;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    if (lo > t0) t0 = lo;
    if (hi < t1) t1 = hi;
    if (t0 > t1) return false;
  }
  out.t = t0;
  return true;
}

export { formatTime, formatGap, ordinal, clamp, clamp01 };
export default RaceSystem;
