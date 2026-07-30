/**
 * RC RUMBLE — sequential-impulse contact solver.
 *
 *   • normal impulse, accumulated and clamped ≥ 0
 *   • two-direction friction with a COUPLED cone (‖jt‖ ≤ μ·jn), so a car does
 *     not get more grip diagonally than it does straight ahead
 *   • restitution applied as a velocity bias, gated by a threshold so a resting
 *     body never bounces on gravity's per-step Δv
 *   • split impulse (pseudo velocities) for penetration recovery, so pushing
 *     bodies apart never injects real kinetic energy — this is what lets a
 *     stack of props stand still instead of slowly exploding
 *   • warm starting across frames through a typed-array open-addressed cache
 *     keyed by (bodyA, bodyB, feature)
 *
 * Everything is Struct-of-Arrays. After the first few frames the pools stop
 * growing and a step allocates nothing.
 */

/** Relative normal speed below which restitution is ignored (m/s). */
const RESTITUTION_THRESHOLD = 0.5;
/** Maximum penetration-recovery pseudo velocity (m/s). */
const MAX_CORRECTION_VEL = 3.0;
/**
 * Fraction of last frame's impulse re-applied at the start of a step.
 *
 * This MUST be 1.0. Anything less is the single largest source of drift in a
 * resting pile, and it is not obvious why, so: warm starting is not a heuristic
 * nudge, it is the solver resuming from where it converged last step. Scaling it
 * by 0.9 throws away a tenth of the accumulated impulse every step and asks a
 * finite number of Gauss-Seidel sweeps to find it again.
 *
 * For the NORMAL impulse that mostly self-heals — gravity re-loads the contact
 * every step. For FRICTION it does not: the tangential impulse comes back 10%
 * short, so the contact leaks a little tangential velocity, in the same
 * direction every step because the configuration is the same, and that leak
 * integrates straight into permanent sliding. Measured on a 5-box tower held
 * awake for 15 s: 0.9 → 84.7 mm of shear and 3.9° of lean; 1.0 → 1.0 mm and
 * 0.01°, with the drift going flat after ~200 steps instead of growing without
 * bound. It also stopped the tower needing 56 relaxation sweeps to stand at all.
 *
 * Full warm starting cannot run away: `jn` is clamped ≥ 0 and the tangent pair
 * is clamped to the friction cone every iteration, so the re-applied impulse is
 * bounded by the current normal load, not by history.
 */
const WARM_START_FACTOR = 1.0;
/** Position (split-impulse) iterations. */
const POSITION_ITERATIONS = 3;
/** Overlap the position pass leaves behind (m). See Solver.positionSlop. */
const POSITION_SLOP = 0.0002;

/**
 * Warm-start key, PART 1: the body pair.
 *
 * The key is deliberately split into two 31-bit halves instead of one 53-bit
 * double. A double that large cannot be a V8 Smi, so every time it crossed a
 * function boundary (pool.add → cache.slotFor → hashKey) V8 boxed it into a
 * HeapNumber — ~150 bytes of garbage per contact per step, which is exactly the
 * kind of thing this engine is not allowed to do. Two small ints stay Smis all
 * the way through and the step allocates nothing.
 *
 * `+1` on the A field guarantees a non-zero hi, so hi === 0 can mean "empty".
 */
export function contactKey(idA, idB) {
  return (((idA & 0xfff) + 1) << 12) | (idB & 0xfff);
}

// ═══════════════════════════════════════════════════════════════════════════
// Contact pool (SoA)
// ═══════════════════════════════════════════════════════════════════════════

export class ContactPool {
  constructor(capacity = 1024) {
    this.capacity = 0;
    this.count = 0;
    /** @type {(import('./RigidBody.js').RigidBody|null)[]} */
    this.bodyA = [];
    /** @type {(import('./RigidBody.js').RigidBody|null)[]} */
    this.bodyB = [];
    this._grow(capacity);
  }

  _grow(cap) {
    const old = this.capacity;
    this.capacity = cap;
    const f = (prev, stride = 1) => {
      const a = new Float32Array(cap * stride);
      if (prev) a.set(prev.subarray(0, Math.min(prev.length, cap * stride)));
      return a;
    };
    this.px = f(this.px); this.py = f(this.py); this.pz = f(this.pz);
    this.nx = f(this.nx); this.ny = f(this.ny); this.nz = f(this.nz);
    this.depth = f(this.depth);
    this.friction = f(this.friction);
    this.restitution = f(this.restitution);

    this.rax = f(this.rax); this.ray = f(this.ray); this.raz = f(this.raz);
    this.rbx = f(this.rbx); this.rby = f(this.rby); this.rbz = f(this.rbz);
    this.t1x = f(this.t1x); this.t1y = f(this.t1y); this.t1z = f(this.t1z);
    this.t2x = f(this.t2x); this.t2y = f(this.t2y); this.t2z = f(this.t2z);

    // raw r × axis  (n, t1, t2) for A and B
    this.crossA = f(this.crossA, 9);
    this.crossB = f(this.crossB, 9);
    // invI · (r × axis)
    this.angA = f(this.angA, 9);
    this.angB = f(this.angB, 9);

    this.nMass = f(this.nMass);
    this.t1Mass = f(this.t1Mass);
    this.t2Mass = f(this.t2Mass);
    this.velBias = f(this.velBias);
    this.posBias = f(this.posBias);
    /** Pre-solve relative normal velocity (negative = approaching). */
    this.approach = f(this.approach);

    this.jn = f(this.jn);
    this.jt1 = f(this.jt1);
    this.jt2 = f(this.jt2);
    this.jp = f(this.jp);

    const u8 = (prev) => { const a = new Uint8Array(cap); if (prev) a.set(prev.subarray(0, Math.min(prev.length, cap))); return a; };
    this.surfaceId = u8(this.surfaceId);
    const i32 = (prev) => { const a = new Int32Array(cap); if (prev) a.set(prev.subarray(0, Math.min(prev.length, cap))); return a; };
    this.keyHi = i32(this.keyHi);
    this.keyLo = i32(this.keyLo);
    this.cacheSlot = i32(this.cacheSlot);

    this.bodyA.length = cap;
    this.bodyB.length = cap;
    for (let i = old; i < cap; i++) { this.bodyA[i] = null; this.bodyB[i] = null; }
  }

  reset() { this.count = 0; }

  /**
   * Move a contact's *input* fields (everything the narrow phase produces).
   * Solver-derived data is rebuilt in `_prepare`, so it does not need copying.
   * Used by PhysicsWorld's per-body contact reduction.
   */
  copyEntry(dst, src) {
    if (dst === src) return;
    this.bodyA[dst] = this.bodyA[src];
    this.bodyB[dst] = this.bodyB[src];
    this.px[dst] = this.px[src]; this.py[dst] = this.py[src]; this.pz[dst] = this.pz[src];
    this.nx[dst] = this.nx[src]; this.ny[dst] = this.ny[src]; this.nz[dst] = this.nz[src];
    this.depth[dst] = this.depth[src];
    this.friction[dst] = this.friction[src];
    this.restitution[dst] = this.restitution[src];
    this.surfaceId[dst] = this.surfaceId[src];
    this.keyHi[dst] = this.keyHi[src];
    this.keyLo[dst] = this.keyLo[src];
    this.jn[dst] = 0; this.jt1[dst] = 0; this.jt2[dst] = 0; this.jp[dst] = 0;
  }

  /**
   * @param {import('./RigidBody.js').RigidBody|null} a null = static world
   * @param {import('./RigidBody.js').RigidBody|null} b
   * @returns {number} contact index, or -1 if the pool refused to grow
   */
  add(a, b, px, py, pz, nx, ny, nz, depth, friction, restitution, surfaceId, keyHi, keyLo) {
    if (this.count >= this.capacity) {
      if (this.capacity >= 65536) return -1;
      this._grow(this.capacity * 2);
    }
    const i = this.count++;
    this.bodyA[i] = a; this.bodyB[i] = b;
    this.px[i] = px; this.py[i] = py; this.pz[i] = pz;
    this.nx[i] = nx; this.ny[i] = ny; this.nz[i] = nz;
    this.depth[i] = depth;
    this.friction[i] = friction;
    this.restitution[i] = restitution;
    this.surfaceId[i] = surfaceId;
    this.keyHi[i] = keyHi;
    this.keyLo[i] = keyLo;
    this.jn[i] = 0; this.jt1[i] = 0; this.jt2[i] = 0; this.jp[i] = 0;
    return i;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Warm-start cache — open addressed, typed arrays, zero GC
// ═══════════════════════════════════════════════════════════════════════════

const MAX_PROBE = 12;
/**
 * Entries untouched for this many frames are recyclable.
 *
 * Must be comfortably longer than a manifold hiccup. A resting contact's feature
 * id is not perfectly stable: when two coincident faces are within AXIS_EPS the
 * SAT winner can flip between A's face and B's, which changes the key, and a
 * clipped point can drop in and out for a step or two while a stack settles. At
 * a TTL of 3 those brief absences expired the entry, so the contact came back
 * with no warm-start history — and with WARM_START_FACTOR at 1.0 that history is
 * load-bearing.
 *
 * Worse, it made the simulation depend on BODY IDS. Whether an expiring entry
 * had actually been cleared yet depended on where `_sweepCursor` was relative to
 * that entry's slot, and the slot comes from hashing the body ids. The same
 * 5-box tower settled anywhere between 2.19 mm and 5.89 mm of shear purely
 * according to how many bodies had been constructed earlier in the process.
 * At a TTL of 8+ it is 2.19 mm every time, for every id offset.
 *
 * 12 frames is 0.1 s at 120 Hz: long enough to ride out churn, short enough that
 * genuinely dead contacts free their slots promptly.
 */
const CACHE_TTL = 12;

export class ImpulseCache {
  constructor(bits = 13) {
    const size = 1 << bits;
    this.mask = size - 1;
    this.keysHi = new Int32Array(size);      // 0 = empty
    this.keysLo = new Int32Array(size);
    this.vals = new Float32Array(size * 3);  // jn, jt1, jt2
    this.stamp = new Int32Array(size);
    this.frame = 0;
    this._sweepCursor = 0;
  }

  beginFrame() {
    this.frame++;
    // Incremental expiry — 1/16 of the table per step, amortised and cheap.
    const size = this.mask + 1;
    const chunk = size >> 4;
    for (let k = 0; k < chunk; k++) {
      const i = (this._sweepCursor + k) & this.mask;
      if (this.keysHi[i] !== 0 && this.frame - this.stamp[i] > CACHE_TTL) {
        this.keysHi[i] = 0; this.keysLo[i] = 0;
        this.vals[i * 3] = 0; this.vals[i * 3 + 1] = 0; this.vals[i * 3 + 2] = 0;
      }
    }
    this._sweepCursor = (this._sweepCursor + chunk) & this.mask;
  }

  /** @returns {number} slot index (claimed if new), or -1 when the run is full */
  slotFor(hi, lo) {
    const h = hashKey(hi, lo) & this.mask;
    let firstStale = -1;
    for (let p = 0; p < MAX_PROBE; p++) {
      const i = (h + p) & this.mask;
      const kh = this.keysHi[i];
      if (kh === hi && this.keysLo[i] === lo) return i;
      if (kh === 0) {
        const t = firstStale >= 0 ? firstStale : i;
        this.keysHi[t] = hi; this.keysLo[t] = lo;
        this.vals[t * 3] = 0; this.vals[t * 3 + 1] = 0; this.vals[t * 3 + 2] = 0;
        return t;
      }
      if (firstStale < 0 && this.frame - this.stamp[i] > CACHE_TTL) firstStale = i;
    }
    if (firstStale >= 0) {
      this.keysHi[firstStale] = hi;
      this.keysLo[firstStale] = lo;
      this.vals[firstStale * 3] = 0;
      this.vals[firstStale * 3 + 1] = 0;
      this.vals[firstStale * 3 + 2] = 0;
      return firstStale;
    }
    return -1;
  }

  clear() {
    this.keysHi.fill(0);
    this.keysLo.fill(0);
    this.vals.fill(0);
    this.stamp.fill(0);
    this.frame = 0;
  }
}

/** Integer-only mix of the two key halves — never leaves Smi range. */
function hashKey(hi, lo) {
  let h = Math.imul(hi ^ 0x9e3779b9, 2654435761) ^ Math.imul(lo + 1, 40503);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return h >>> 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Solver
// ═══════════════════════════════════════════════════════════════════════════

export class Solver {
  constructor(config = {}) {
    this.iterations = config.solverIterations ?? 8;
    /**
     * Extra velocity sweeps run WITHOUT the restitution bias. They add no
     * energy — they only finish converging what the biased pass started.
     *
     * Rather than burning a fixed (and possibly huge) number of sweeps, the
     * relaxation pass runs against a CONTACT-SOLVE BUDGET: few contacts get many
     * sweeps, many contacts get few. Worst-case cost per step is therefore
     * bounded at `iterations * n + relaxBudget` contact solves regardless of how
     * much is going on in the world.
     *
     * The ceiling used to be 56, which made a resting 5-box tower cost 8 + 56 =
     * 64 velocity sweeps per step — several times the whole physics frame
     * budget once eight cars are on track. Almost all of that was compensating
     * for fractional warm starting; with WARM_START_FACTOR at 1.0 the steady
     * state needs no sweeps at all, because the solver starts from last step's
     * answer.
     *
     * What the sweeps are still for is the TRANSIENT: five boxes landing at once
     * is a stiff impulse-propagation problem and Gauss-Seidel needs roughly a
     * sweep per stack level to carry load from the floor to the top. Measured
     * one-time landing shear on that tower (which then stops growing entirely):
     * relax 4 → 17-23 mm, 8 → 8-23 mm, 16 → 1.6-4.1 mm, 56 → 1.0-2.4 mm.
     * 16 is therefore the lowest ceiling that keeps the tower inside the 5 mm
     * requirement, and it is 2.7x cheaper than what it replaced.
     */
    this.relaxBudget = config.relaxBudget ?? 320;
    this.minRelaxIterations = config.minRelaxIterations ?? 4;
    this.maxRelaxIterations = config.maxRelaxIterations ?? 16;
    /** Set to a number to pin the relaxation sweep count (tests/debug). */
    this.relaxIterations = config.relaxIterations ?? 0;
    this.positionIterations = config.positionIterations ?? POSITION_ITERATIONS;
    this.baumgarte = config.baumgarte ?? 0.22;
    this.slop = config.contactSlop ?? 0.0015;
    /**
     * Penetration the POSITION pass is allowed to leave behind.
     *
     * This is deliberately much smaller than `contactSlop`. The usual reason to
     * tolerate slop-sized overlap is that Baumgarte stabilisation feeds the
     * correction back into real velocity, so chasing zero penetration pumps
     * energy and buzzes. This solver corrects position with pseudo velocities
     * (split impulse), which cannot add kinetic energy — so it can converge to
     * near-zero overlap safely.
     *
     * It matters because resting penetration ACCUMULATES up a stack: at
     * `contactSlop` = 1.5 mm a 5-box tower would sink 7.5 mm, which at 1:10 RC
     * scale is a visible 10% of an 8 cm prop and reads as boxes melting into
     * each other. A small non-zero value is still kept so a resting contact
     * does not oscillate across the touching/separated boundary and lose its
     * warm-start history.
     */
    this.positionSlop = config.positionSlop ?? Math.min(this.slop, POSITION_SLOP);
    this.restitutionThreshold = config.restitutionThreshold ?? RESTITUTION_THRESHOLD;
    this.maxCorrectionVel = config.maxCorrectionVel ?? MAX_CORRECTION_VEL;
    this.warmStartFactor = config.warmStartFactor ?? WARM_START_FACTOR;
    /**
     * Penetration-recovery relaxation. Gauss-Seidel resolves a symmetric
     * 4-point manifold asymmetrically, and because the position pass rotates
     * the body directly that asymmetry shows up as a slow, relentless tilt in
     * a stack. A Jacobi (simultaneous) update with under-relaxation keeps a
     * symmetric configuration symmetric, which is exactly what stacks need.
     */
    this.jacobiPosition = config.jacobiPosition !== false;
    this.positionRelax = config.positionRelax ?? 0.7;
    /** Scale on the ROTATIONAL part of the position correction. */
    this.positionAngularFactor = config.positionAngularFactor ?? 1.0;
    this.cache = new ImpulseCache(config.cacheBits ?? 13);
    this._dj = new Float32Array(1024);
    /** Largest normal impulse applied last solve — handy for debugging. */
    this.maxImpulse = 0;
  }

  configure(cfg) {
    if (cfg.solverIterations !== undefined) this.iterations = cfg.solverIterations;
    if (cfg.baumgarte !== undefined) this.baumgarte = cfg.baumgarte;
    if (cfg.contactSlop !== undefined) {
      this.slop = cfg.contactSlop;
      this.positionSlop = Math.min(this.slop, POSITION_SLOP);
    }
    if (cfg.positionSlop !== undefined) this.positionSlop = cfg.positionSlop;
    return this;
  }

  /**
   * Full solve: prepare → warm start → velocity iterations → position
   * iterations. Pseudo velocities are left on the bodies for the integrator.
   * @param {ContactPool} pool
   * @param {number} dt
   */
  solve(pool, dt) {
    const n = pool.count;
    this.maxImpulse = 0;
    if (n === 0) return;
    this.cache.beginFrame();
    this._prepare(pool, dt);
    this._warmStart(pool);
    // Symmetric Gauss-Seidel: alternating the sweep direction roughly doubles
    // the convergence rate on a stack and, more importantly, cancels the
    // ordering bias that otherwise leaves a resting box with a small residual
    // spin in one consistent direction.
    for (let it = 0; it < this.iterations; it++) this._iterateVelocity(pool, (it & 1) === 1, true);
    const relax = this.relaxIterations > 0 ? this.relaxIterations : Math.min(
      this.maxRelaxIterations,
      Math.max(this.minRelaxIterations, (this.relaxBudget / n) | 0),
    );
    this.lastRelaxIterations = relax;
    for (let it = 0; it < relax; it++) this._iterateVelocity(pool, (it & 1) === 0, false);
    for (let it = 0; it < this.positionIterations; it++) this._iteratePosition(pool);
    this._store(pool);
  }

  // ───────────────────────────────────────────────────────── prepare

  _prepare(pool, dt) {
    const invDt = dt > 0 ? 1 / dt : 0;
    const beta = this.baumgarte;
    const posSlop = this.positionSlop;
    const maxCorr = this.maxCorrectionVel;
    const rt = this.restitutionThreshold;

    for (let i = 0; i < pool.count; i++) {
      const A = pool.bodyA[i], B = pool.bodyB[i];
      const nx = pool.nx[i], ny = pool.ny[i], nz = pool.nz[i];
      const px = pool.px[i], py = pool.py[i], pz = pool.pz[i];

      // Sleeping / kinematic / static bodies are immovable anchors — they must
      // not contribute inverse mass, or the contact goes soft (impulses would
      // be computed as if the anchor could recoil, then never applied to it).
      const imA = (A && A.isMovable) ? A.invMass : 0;
      const imB = (B && B.isMovable) ? B.invMass : 0;

      let rax = 0, ray = 0, raz = 0, rbx = 0, rby = 0, rbz = 0;
      if (A) { rax = px - A.position.x; ray = py - A.position.y; raz = pz - A.position.z; }
      if (B) { rbx = px - B.position.x; rby = py - B.position.y; rbz = pz - B.position.z; }
      pool.rax[i] = rax; pool.ray[i] = ray; pool.raz[i] = raz;
      pool.rbx[i] = rbx; pool.rby[i] = rby; pool.rbz[i] = rbz;

      // Orthonormal tangent basis, deterministic in n (keeps warm starting valid).
      const s = nz >= 0 ? 1 : -1;
      const a = -1 / (s + nz);
      const bxy = nx * ny * a;
      const t1x = 1 + s * nx * nx * a, t1y = s * bxy, t1z = -s * nx;
      const t2x = bxy, t2y = s + ny * ny * a, t2z = -ny;
      pool.t1x[i] = t1x; pool.t1y[i] = t1y; pool.t1z[i] = t1z;
      pool.t2x[i] = t2x; pool.t2y[i] = t2y; pool.t2z[i] = t2z;

      const ca = pool.crossA, cb = pool.crossB, aa = pool.angA, ab = pool.angB;
      const o = i * 9;

      // r × axis for each of the three axes
      cross(rax, ray, raz, nx, ny, nz, ca, o);
      cross(rax, ray, raz, t1x, t1y, t1z, ca, o + 3);
      cross(rax, ray, raz, t2x, t2y, t2z, ca, o + 6);
      cross(rbx, rby, rbz, nx, ny, nz, cb, o);
      cross(rbx, rby, rbz, t1x, t1y, t1z, cb, o + 3);
      cross(rbx, rby, rbz, t2x, t2y, t2z, cb, o + 6);

      if (A && A.isMovable) {
        mulInvI(A, ca, o, aa, o);
        mulInvI(A, ca, o + 3, aa, o + 3);
        mulInvI(A, ca, o + 6, aa, o + 6);
      } else {
        aa[o] = 0; aa[o + 1] = 0; aa[o + 2] = 0;
        aa[o + 3] = 0; aa[o + 4] = 0; aa[o + 5] = 0;
        aa[o + 6] = 0; aa[o + 7] = 0; aa[o + 8] = 0;
      }
      if (B && B.isMovable) {
        mulInvI(B, cb, o, ab, o);
        mulInvI(B, cb, o + 3, ab, o + 3);
        mulInvI(B, cb, o + 6, ab, o + 6);
      } else {
        ab[o] = 0; ab[o + 1] = 0; ab[o + 2] = 0;
        ab[o + 3] = 0; ab[o + 4] = 0; ab[o + 5] = 0;
        ab[o + 6] = 0; ab[o + 7] = 0; ab[o + 8] = 0;
      }

      // Effective masses: k = imA + imB + (invIA(rA×ax))·(rA×ax) + …
      const kn = imA + imB
        + aa[o] * ca[o] + aa[o + 1] * ca[o + 1] + aa[o + 2] * ca[o + 2]
        + ab[o] * cb[o] + ab[o + 1] * cb[o + 1] + ab[o + 2] * cb[o + 2];
      const k1 = imA + imB
        + aa[o + 3] * ca[o + 3] + aa[o + 4] * ca[o + 4] + aa[o + 5] * ca[o + 5]
        + ab[o + 3] * cb[o + 3] + ab[o + 4] * cb[o + 4] + ab[o + 5] * cb[o + 5];
      const k2 = imA + imB
        + aa[o + 6] * ca[o + 6] + aa[o + 7] * ca[o + 7] + aa[o + 8] * ca[o + 8]
        + ab[o + 6] * cb[o + 6] + ab[o + 7] * cb[o + 7] + ab[o + 8] * cb[o + 8];
      pool.nMass[i] = kn > 1e-12 ? 1 / kn : 0;
      pool.t1Mass[i] = k1 > 1e-12 ? 1 / k1 : 0;
      pool.t2Mass[i] = k2 > 1e-12 ? 1 / k2 : 0;

      // Target normal velocity.
      //
      // SPECULATIVE CONTACTS. The narrow phase keeps contacts that are still
      // slightly separated (see Collision.KEEP_SLOP) so a fast body is caught
      // before it can tunnel. Those must not be solved to vn = 0 — that would
      // stop a car a few millimetres above the floor and let it hover and slide
      // (very visible on a slope). A separated contact instead permits exactly
      // the approach speed that closes the gap in one step and no more, so it
      // costs nothing until the surfaces really meet.
      const vn = relativeNormalVelocity(pool, i, A, B, nx, ny, nz, o);
      pool.approach[i] = vn;
      const sep = -pool.depth[i];
      if (sep > 0) {
        pool.velBias[i] = -sep * invDt;
      } else {
        const e = pool.restitution[i];
        pool.velBias[i] = (e > 0 && vn < -rt) ? -e * vn : 0;
      }

      // Penetration recovery (split impulse — never touches real velocity).
      const pen = pool.depth[i] - posSlop;
      let bias = pen > 0 ? pen * beta * invDt : 0;
      if (bias > maxCorr) bias = maxCorr;
      pool.posBias[i] = bias;

      // Warm-start slot.
      pool.cacheSlot[i] = this.cache.slotFor(pool.keyHi[i], pool.keyLo[i]);
    }
  }

  _warmStart(pool) {
    const f = this.warmStartFactor;
    const cache = this.cache;
    for (let i = 0; i < pool.count; i++) {
      const slot = pool.cacheSlot[i];
      if (slot < 0) { pool.jn[i] = 0; pool.jt1[i] = 0; pool.jt2[i] = 0; continue; }
      const jn = cache.vals[slot * 3] * f;
      const jt1 = cache.vals[slot * 3 + 1] * f;
      const jt2 = cache.vals[slot * 3 + 2] * f;
      pool.jn[i] = jn; pool.jt1[i] = jt1; pool.jt2[i] = jt2;
      if (jn !== 0) applyAxis(pool, i, 0, jn);
      applyTangents(pool, i, jt1, jt2);
    }
  }

  // ───────────────────────────────────────────────────────── iterations

  _iterateVelocity(pool, reverse = false, useBias = true) {
    const n = pool.count;
    for (let k = 0; k < n; k++) {
      const i = reverse ? n - 1 - k : k;
      const A = pool.bodyA[i], B = pool.bodyB[i];
      const o = i * 9;

      // ── normal ──
      const nx = pool.nx[i], ny = pool.ny[i], nz = pool.nz[i];
      let vn = relativeNormalVelocity(pool, i, A, B, nx, ny, nz, o);
      let dj = pool.nMass[i] * ((useBias ? pool.velBias[i] : 0) - vn);
      let next = pool.jn[i] + dj;
      if (next < 0) next = 0;
      dj = next - pool.jn[i];
      pool.jn[i] = next;
      if (dj !== 0) applyAxis(pool, i, 0, dj);
      if (next > this.maxImpulse) this.maxImpulse = next;

      // ── friction (coupled cone) ──
      const mu = pool.friction[i];
      if (mu <= 0 || next <= 0) {
        // Undo any warm-started friction rather than silently dropping it.
        const u1 = -pool.jt1[i], u2 = -pool.jt2[i];
        pool.jt1[i] = 0; pool.jt2[i] = 0;
        applyTangents(pool, i, u1, u2);
        continue;
      }

      const t1x = pool.t1x[i], t1y = pool.t1y[i], t1z = pool.t1z[i];
      const t2x = pool.t2x[i], t2y = pool.t2y[i], t2z = pool.t2z[i];
      const v1 = relativeAxisVelocity(pool, i, A, B, t1x, t1y, t1z, o + 3);
      const v2 = relativeAxisVelocity(pool, i, A, B, t2x, t2y, t2z, o + 6);

      let n1 = pool.jt1[i] - pool.t1Mass[i] * v1;
      let n2 = pool.jt2[i] - pool.t2Mass[i] * v2;
      const maxF = mu * next;
      const len = Math.sqrt(n1 * n1 + n2 * n2);
      if (len > maxF) {
        const k = maxF / len;
        n1 *= k; n2 *= k;
      }
      const d1 = n1 - pool.jt1[i];
      const d2 = n2 - pool.jt2[i];
      pool.jt1[i] = n1; pool.jt2[i] = n2;
      applyTangents(pool, i, d1, d2);
    }
  }

  _iteratePosition(pool) {
    const n = pool.count;
    if (this._dj.length < n) this._dj = new Float32Array(nextPow2(n));
    const dj = this._dj;
    const jacobi = this.jacobiPosition;
    const relax = jacobi ? this.positionRelax : 1.0;
    const angF = this.positionAngularFactor;

    // Pass 1 — compute the correction for every contact from the CURRENT
    // pseudo velocities. In Jacobi mode nothing is applied yet, so two
    // identical contacts get identical corrections and symmetry survives.
    for (let i = 0; i < n; i++) {
      dj[i] = 0;
      const bias = pool.posBias[i];
      if (bias <= 0) continue;
      const A = pool.bodyA[i], B = pool.bodyB[i];
      const o = i * 9;
      const nx = pool.nx[i], ny = pool.ny[i], nz = pool.nz[i];

      let vn = 0;
      if (A) {
        vn -= A.pseudoVelocity.x * nx + A.pseudoVelocity.y * ny + A.pseudoVelocity.z * nz;
        vn -= A.pseudoAngularVelocity.x * pool.crossA[o]
          + A.pseudoAngularVelocity.y * pool.crossA[o + 1]
          + A.pseudoAngularVelocity.z * pool.crossA[o + 2];
      }
      if (B) {
        vn += B.pseudoVelocity.x * nx + B.pseudoVelocity.y * ny + B.pseudoVelocity.z * nz;
        vn += B.pseudoAngularVelocity.x * pool.crossB[o]
          + B.pseudoAngularVelocity.y * pool.crossB[o + 1]
          + B.pseudoAngularVelocity.z * pool.crossB[o + 2];
      }

      let d = pool.nMass[i] * (bias - vn) * relax;
      let next = pool.jp[i] + d;
      if (next < 0) next = 0;
      d = next - pool.jp[i];
      pool.jp[i] = next;
      dj[i] = d;
      if (!jacobi && d !== 0) applyPseudo(pool, i, d, angF);
    }

    if (!jacobi) return;
    for (let i = 0; i < n; i++) if (dj[i] !== 0) applyPseudo(pool, i, dj[i], angF);
  }

  _store(pool) {
    const cache = this.cache;
    for (let i = 0; i < pool.count; i++) {
      const slot = pool.cacheSlot[i];
      if (slot < 0) continue;
      cache.vals[slot * 3] = pool.jn[i];
      cache.vals[slot * 3 + 1] = pool.jt1[i];
      cache.vals[slot * 3 + 2] = pool.jt2[i];
      cache.stamp[slot] = cache.frame;
    }
  }

  reset() { this.cache.clear(); }
}

// ═════════════════════════════════════════════════════════ inline helpers

/** Apply a penetration-recovery impulse to the pseudo velocities only. */
function applyPseudo(pool, i, dj, angF) {
  const o = i * 9;
  const nx = pool.nx[i], ny = pool.ny[i], nz = pool.nz[i];
  const A = pool.bodyA[i];
  if (A && A.isMovable) {
    const im = A.invMass;
    A.pseudoVelocity.x -= nx * dj * im;
    A.pseudoVelocity.y -= ny * dj * im;
    A.pseudoVelocity.z -= nz * dj * im;
    A.pseudoAngularVelocity.x -= pool.angA[o] * dj * angF;
    A.pseudoAngularVelocity.y -= pool.angA[o + 1] * dj * angF;
    A.pseudoAngularVelocity.z -= pool.angA[o + 2] * dj * angF;
  }
  const B = pool.bodyB[i];
  if (B && B.isMovable) {
    const im = B.invMass;
    B.pseudoVelocity.x += nx * dj * im;
    B.pseudoVelocity.y += ny * dj * im;
    B.pseudoVelocity.z += nz * dj * im;
    B.pseudoAngularVelocity.x += pool.angB[o] * dj * angF;
    B.pseudoAngularVelocity.y += pool.angB[o + 1] * dj * angF;
    B.pseudoAngularVelocity.z += pool.angB[o + 2] * dj * angF;
  }
}

function nextPow2(v) { let p = 1; while (p < v) p <<= 1; return p; }

function cross(ax, ay, az, bx, by, bz, out, o) {
  out[o] = ay * bz - az * by;
  out[o + 1] = az * bx - ax * bz;
  out[o + 2] = ax * by - ay * bx;
}

function mulInvI(body, src, so, dst, doff) {
  const e = body.invInertiaWorld.elements;
  const x = src[so], y = src[so + 1], z = src[so + 2];
  dst[doff] = e[0] * x + e[3] * y + e[6] * z;
  dst[doff + 1] = e[1] * x + e[4] * y + e[7] * z;
  dst[doff + 2] = e[2] * x + e[5] * y + e[8] * z;
}

/** vRel · n  computed without re-crossing: uses the stored r × n. */
function relativeNormalVelocity(pool, i, A, B, nx, ny, nz, o) {
  let vn = 0;
  if (A) {
    vn -= A.velocity.x * nx + A.velocity.y * ny + A.velocity.z * nz;
    vn -= A.angularVelocity.x * pool.crossA[o]
      + A.angularVelocity.y * pool.crossA[o + 1]
      + A.angularVelocity.z * pool.crossA[o + 2];
  }
  if (B) {
    vn += B.velocity.x * nx + B.velocity.y * ny + B.velocity.z * nz;
    vn += B.angularVelocity.x * pool.crossB[o]
      + B.angularVelocity.y * pool.crossB[o + 1]
      + B.angularVelocity.z * pool.crossB[o + 2];
  }
  return vn;
}

/** Same for an arbitrary stored axis slot (o = i*9 + axis*3). */
function relativeAxisVelocity(pool, i, A, B, ax, ay, az, o) {
  let v = 0;
  if (A) {
    v -= A.velocity.x * ax + A.velocity.y * ay + A.velocity.z * az;
    v -= A.angularVelocity.x * pool.crossA[o]
      + A.angularVelocity.y * pool.crossA[o + 1]
      + A.angularVelocity.z * pool.crossA[o + 2];
  }
  if (B) {
    v += B.velocity.x * ax + B.velocity.y * ay + B.velocity.z * az;
    v += B.angularVelocity.x * pool.crossB[o]
      + B.angularVelocity.y * pool.crossB[o + 1]
      + B.angularVelocity.z * pool.crossB[o + 2];
  }
  return v;
}

/**
 * Apply BOTH tangent impulses in one pass.
 *
 * Same result as two `applyAxis` calls, half the property writes. That matters
 * more than it looks: `velocity`/`angularVelocity` are THREE.Vector3, so every
 * component store is a double going into a normal object field, and V8 has not
 * unboxed double fields since 8.0 — a fraction of those stores survive as
 * MutableHeapNumbers and show up as steady-state heap growth in a loop that runs
 * (sweeps x contacts) times per step. Combining the tangent pair takes the
 * per-contact-per-sweep store count from 18 to 12.
 */
function applyTangents(pool, i, d1, d2) {
  if (d1 === 0 && d2 === 0) return;
  const o1 = i * 9 + 3, o2 = i * 9 + 6;
  // Impulse in world space is t1*d1 + t2*d2 — one vector, one set of writes.
  const lx = pool.t1x[i] * d1 + pool.t2x[i] * d2;
  const ly = pool.t1y[i] * d1 + pool.t2y[i] * d2;
  const lz = pool.t1z[i] * d1 + pool.t2z[i] * d2;

  const A = pool.bodyA[i];
  if (A && A.isMovable) {
    const im = A.invMass;
    const aa = pool.angA;
    const v = A.velocity, w = A.angularVelocity;
    v.x -= lx * im; v.y -= ly * im; v.z -= lz * im;
    w.x -= aa[o1] * d1 + aa[o2] * d2;
    w.y -= aa[o1 + 1] * d1 + aa[o2 + 1] * d2;
    w.z -= aa[o1 + 2] * d1 + aa[o2 + 2] * d2;
  }
  const B = pool.bodyB[i];
  if (B && B.isMovable) {
    const im = B.invMass;
    const ab = pool.angB;
    const v = B.velocity, w = B.angularVelocity;
    v.x += lx * im; v.y += ly * im; v.z += lz * im;
    w.x += ab[o1] * d1 + ab[o2] * d2;
    w.y += ab[o1 + 1] * d1 + ab[o2 + 1] * d2;
    w.z += ab[o1 + 2] * d1 + ab[o2 + 2] * d2;
  }
}

/** axis: 0 = normal, 1 = tangent 1, 2 = tangent 2. */
function applyAxis(pool, i, axis, j) {
  const o = i * 9 + axis * 3;
  let ax, ay, az;
  if (axis === 0) { ax = pool.nx[i]; ay = pool.ny[i]; az = pool.nz[i]; }
  else if (axis === 1) { ax = pool.t1x[i]; ay = pool.t1y[i]; az = pool.t1z[i]; }
  else { ax = pool.t2x[i]; ay = pool.t2y[i]; az = pool.t2z[i]; }

  const A = pool.bodyA[i];
  if (A && A.isMovable) {
    const im = A.invMass;
    A.velocity.x -= ax * j * im;
    A.velocity.y -= ay * j * im;
    A.velocity.z -= az * j * im;
    A.angularVelocity.x -= pool.angA[o] * j;
    A.angularVelocity.y -= pool.angA[o + 1] * j;
    A.angularVelocity.z -= pool.angA[o + 2] * j;
  }
  const B = pool.bodyB[i];
  if (B && B.isMovable) {
    const im = B.invMass;
    B.velocity.x += ax * j * im;
    B.velocity.y += ay * j * im;
    B.velocity.z += az * j * im;
    B.angularVelocity.x += pool.angB[o] * j;
    B.angularVelocity.y += pool.angB[o + 1] * j;
    B.angularVelocity.z += pool.angB[o + 2] * j;
  }
}

export default Solver;
