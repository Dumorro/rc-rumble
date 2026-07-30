/**
 * RC RUMBLE — tyre model.
 *
 * A simplified-but-real Pacejka "Magic Formula" tyre:
 *
 *     F(x) = D · sin( C · arctan( Bx − E(Bx − arctan Bx) ) )
 *
 * with independent longitudinal (slip-ratio) and lateral (slip-angle) curves.
 *
 * How the shape is authored
 * -------------------------
 * Raw B/C/D/E are miserable to tune, so the car defs declare *intent* and this
 * module derives the coefficients once per wheel:
 *
 *   `peakSlipRatio` / `peakSlipAngle`
 *        where the curve peaks           → solves for B (numerically)
 *   `slideLong` / `slideLat`
 *        force in a full slide as a fraction of the peak
 *                                        → solves for C numerically so the
 *                                          curve passes through that fraction
 *                                          at the channel's REACHABLE full-slide
 *                                          point: a locked wheel (|κ| = 1) and a
 *                                          fully sideways tyre (α = 90°)
 *   `curveLong` / `curveLat`   (= E)
 *        how "flat-topped" the curve is between the linear region and the peak
 *   `grip`, `loadSensitivity`
 *        μ and how much of it you lose as vertical load rises
 *
 * That makes the two properties that actually decide game feel directly
 * dialable, and — since the fit moved off the asymptote — the numbers now mean
 * what they say. `slideLong` = 0.58 means a locked wheel returns 58 % of its
 * peak stopping force, so over-braking is punished. `slideLat` = 0.64 (BASE)
 * means a fully sideways tyre returns 64 % of its peak cornering force, and a
 * partial drift keeps more (≈ 0.89 at 25°, ≈ 0.83 at 35°, ≈ 0.78 at 45°).
 * Both were previously fitted at infinite slip, which no channel can reach, and
 * so delivered ≈ 88 % and ≈ 70 % instead.
 *
 * `slideLat` used to be 0.84, which put the whole 25°–90° range inside a
 * 0.92 → 0.84 band: the tyre had no slide REGIME at all, so a rear axle could
 * only ever grip (and snap the car straight) or be overwhelmed (and spin it).
 * The number that makes a slide CATCHABLE is not this one — catchability comes
 * from the front axle, which in a countersteered slide works at small slip
 * angles near the peak where this curve is untouched. See CarDefs.js.
 *
 * Also modelled
 * -------------
 * • **Load sensitivity** — μ falls as Fz rises, so an unloaded inside wheel is
 *   not "free grip" and weight transfer costs you overall cornering power.
 * • **Friction ellipse** — longitudinal and lateral demands compete for one
 *   contact patch. Trail-brake into a corner and the fronts give up.
 * • **Camber thrust** ("camber-lite") — a leaning tyre pushes toward the lean.
 * • **Relaxation length** — force builds over *distance travelled*, not
 *   instantly. This is what makes fast steering inputs feel like rubber
 *   instead of a physics constraint, and it is also what keeps the wheel
 *   angular-velocity solver stable (the linearisation below accounts for it).
 * • **Per-surface grip** — multiplier from the canonical surface-id table.
 *
 * Nothing here allocates. One `Tire` per wheel, `solve()` in the hot path.
 */

import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';

/**
 * Full-slide reference points — where `slideLong` / `slideLat` are measured.
 * Both are the real operating point the knob's name refers to, and both are
 * reachable, which the old asymptotic fit was not. See shapeFromSlide.
 */
/** A fully locked wheel: kappa = (0 - vx)/|vx| = -1, so |kappa| = 1. */
const LOCKED_SLIP_RATIO = 1.0;
/** `atan2(vy, |vx| + eps)` bounds the slip angle at 90 deg — fully sideways. */
const FULL_SLIDE_SLIP_ANGLE = Math.PI / 2;

/** Speed floor used when normalising the slip ratio (m/s). */
const SLIP_REF_SPEED = 0.72;
/** Denominator floor for the slip angle (m/s) — keeps atan2 sane at rest. */
const ANGLE_REF_SPEED = 0.34;
/** Relaxation is evaluated at least this fast so forces exist at standstill. */
const RELAX_REF_SPEED = 0.55;
/** Slip ratios beyond this are clamped (a locked or spinning wheel). */
const MAX_SLIP_RATIO = 12.0;
/** Contact-patch sliding speed at which skid FX start / saturate (m/s). */
const SKID_ON = 0.30;
const SKID_FULL = 2.30;

// ═══════════════════════════════════════════════════════════════════════════
// Curve fitting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * C from the desired slide/peak force ratio, measured AT A REACHABLE SLIP.
 *
 * The obvious fit is the closed form C = 2 − (2/π)·asin(f), which makes the
 * curve's ASYMPTOTE equal f. That was wrong in a way that is easy to miss: the
 * asymptote is the force at infinite slip, and neither channel can get there.
 * Slip angle is `atan2(vy, |vx| + 0.34)`, so it is bounded by 90°; slip ratio
 * for a locked wheel is exactly −1. Authoring `slideLat = 0.84` and believing a
 * sliding tyre returned 84% of peak actually produced 88% fully sideways and
 * 95% in a 24° drift — the knob was calibrated in units the model never reached.
 *
 * So fit at the operating point the name refers to instead: solve numerically
 * for the C whose curve passes through `f` at `refSlip`. Retention is just
 * `shape(refSlip)` because the magic formula peaks at exactly 1 by construction
 * (at the peak C·atan(g) = π/2, so sin(...) = 1).
 *
 * Rejected alternative: fitting at a fixed multiple of the peak slip (3× was
 * proposed). It is unreachable for the longitudinal channel — no C in the
 * peak-bearing range gets down to 58% that early, so the solve silently clamps
 * at its bound and misses the target by 8 points — and laterally it drags the
 * asymptote down to 50% (27% on `needle`), which makes a fully sideways car
 * much looser rather than more catchable.
 *
 * @param {number} slideFraction 0.2 … 0.98, force at `refSlip` ÷ peak force
 * @param {number} E curvature, must match the curve this C is for
 * @param {number} peakAt slip at which the curve peaks
 * @param {number} refSlip slip at which `slideFraction` is measured
 */
export function shapeFromSlide(slideFraction, E = 0, peakAt = 1, refSlip = Infinity) {
  const f = clamp(slideFraction, 0.18, 0.985);
  const e = clamp(E, -1.5, 0.92);
  // Legacy/no-reference behaviour: fit the asymptote in closed form.
  if (!Number.isFinite(refSlip)) return 2 - (2 / Math.PI) * Math.asin(f);

  const retentionAt = (C) => {
    const bx = (magicPeakArg(C, e) / Math.max(1e-6, peakAt)) * refSlip;
    return Math.sin(C * Math.atan(bx - e * (bx - Math.atan(bx))));
  };
  // Retention falls monotonically with C over the peak-bearing range (1, 2).
  let lo = 1.0005, hi = 1.999;
  if (retentionAt(lo) <= f) return lo;
  if (retentionAt(hi) >= f) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) * 0.5;
    if (retentionAt(mid) > f) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Solve for the argument u* = B·x at which the curve peaks, given C and E.
 * Peak ⇔ C·arctan(g(u)) = π/2 ⇔ g(u) = tan(π/2C), where
 * g(u) = (1−E)u + E·arctan(u) is strictly increasing for E < 1.
 */
export function magicPeakArg(C, E) {
  const e = clamp(E, -2.0, 0.94);
  const target = Math.tan(Math.PI / (2 * Math.max(1.0005, C)));
  const g = (u) => (1 - e) * u + e * Math.atan(u);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48 && g(hi) < target; i++) hi *= 2;
  if (g(hi) < target) return hi;                     // degenerate — no peak
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) * 0.5;
    if (g(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * A fitted magic-formula channel. Immutable; created once per wheel per axis.
 */
export class MagicCurve {
  /**
   * @param {number} peakAt slip (ratio, or radians) at which the peak occurs
   * @param {number} slideFraction force at `refSlip` ÷ peak force
   * @param {number} E curvature (0 = classic, higher = flatter top)
   * @param {number} refSlip the slip `slideFraction` is measured at — the
   *        channel's full-slide operating point, not infinity
   */
  constructor(peakAt, slideFraction, E, refSlip = Infinity) {
    // E first: the C solve depends on it.
    this.E = clamp(E, -1.5, 0.92);
    this.peakAt = Math.max(1e-4, peakAt);
    this.refSlip = refSlip;
    this.C = shapeFromSlide(slideFraction, this.E, this.peakAt, refSlip);
    this.B = magicPeakArg(this.C, this.E) / this.peakAt;
    /** dF/dslip at zero slip, per newton of peak force D. */
    this.stiffnessPerD = this.B * this.C;
    /** Realised retention at `refSlip` — should equal the authored value. */
    this.slideFraction = Number.isFinite(refSlip) ? this.shape(refSlip) : Math.sin((this.C * Math.PI) / 2);
    /** Force retained at infinite slip. Informational; not the authored knob. */
    this.asymptote = Math.sin((this.C * Math.PI) / 2);
  }

  /** F/D for a signed slip value. Odd function, range ≈ [−1, 1]. */
  shape(x) {
    const bx = this.B * x;
    const abx = bx < 0 ? -bx : bx;
    const at = Math.atan(abx);
    const arg = abx - this.E * (abx - at);
    const y = Math.sin(this.C * Math.atan(arg));
    return bx < 0 ? -y : y;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tire
// ═══════════════════════════════════════════════════════════════════════════

export class Tire {
  /**
   * @param {object} def CarDef (reads `def.tyre`)
   * @param {boolean} isFront
   */
  constructor(def, isFront) {
    const t = def.tyre;
    this.def = def;
    this.isFront = isFront;

    this.radius = t.radius;
    this.width = t.width;
    /** Base friction coefficient on a grip-1.00 surface. */
    this.mu = isFront ? t.gripFront : t.gripRearEff;
    this.loadSensitivity = t.loadSensitivity;
    this.camberStiffness = t.camberStiffness;
    this.relaxLong = Math.max(0.006, t.relaxLong);
    this.relaxLat = Math.max(0.008, t.relaxLat);
    /**
     * Per-axle. The rear runs higher than the front deliberately — the torque
     * pulls the rear tyres into a small negative slip ratio on a trailing
     * throttle, that longitudinal demand comes out of the same friction budget
     * as the cornering force, and the tail therefore lets go first when the
     * driver lifts. See `ROLL_COEFF_REAR` in CarDefs.js.
     */
    this.rollResist = isFront ? t.rollResistFront : t.rollResistRear;
    this.inertia = t.inertia;
    /** Reference load for the load-sensitivity curve (N). */
    this.nominalLoad = Math.max(0.5, isFront
      ? def.axleLoadFront * 0.5
      : def.axleLoadRear * 0.5);

    this.longCurve = new MagicCurve(t.peakSlipRatio, t.slideLong, t.curveLong, LOCKED_SLIP_RATIO);
    this.latCurve = new MagicCurve(t.peakSlipAngle, t.slideLat, t.curveLat, FULL_SLIDE_SLIP_ANGLE);

    // ── state ─────────────────────────────────────────────────────────
    /** Relaxed (lagged) slip states — the values FX and audio should read. */
    this.slipRatio = 0;
    this.slipAngle = 0;
    /** Instantaneous (unlagged) slips, for debugging. */
    this.slipRatioRaw = 0;
    this.slipAngleRaw = 0;

    // ── outputs, refreshed by solve() ─────────────────────────────────
    /** Longitudinal force along the wheel's rolling direction (N). */
    this.fx = 0;
    /** Lateral force along the wheel's right axis (N). */
    this.fy = 0;
    /** Peak available force at the current load (N) — the friction circle. */
    this.peakForce = 0;
    /** |F| / peakForce, 0..1+ — how close this tyre is to letting go. */
    this.saturation = 0;
    /** 0..1 skid intensity for tyre marks — ANY sliding, including a locked
     *  wheel or a spinning one going perfectly straight. */
    this.skid = 0;
    /**
     * 0..1 skid intensity from the SIDEWAYS component of the slide only.
     *
     * `skid` is the right signal for a tyre mark: a wheel locked under braking
     * lays rubber whether or not the car is sideways. It is the wrong signal
     * for "is this car drifting", which is what `car.driftFactor` answers for
     * FX, audio and scoring — and it was being used for both.
     */
    this.skidLat = 0;
    /** Contact-patch sliding speed (m/s). */
    this.slipSpeed = 0;
    /** ∂Fx/∂ω — consumed by the implicit wheel-spin integrator. */
    this.dFxDomega = 0;
    /** Self-aligning-ish torque proxy, for force feedback / telemetry. */
    this.alignTorque = 0;
    /** μ actually used last solve (after surface + load sensitivity). */
    this.muEff = this.mu;
  }

  reset() {
    this.slipRatio = 0; this.slipAngle = 0;
    this.slipRatioRaw = 0; this.slipAngleRaw = 0;
    this.fx = 0; this.fy = 0;
    this.saturation = 0; this.skid = 0; this.skidLat = 0; this.slipSpeed = 0;
    this.dFxDomega = 0; this.alignTorque = 0;
    this.peakForce = 0;
  }

  /**
   * Evaluate the contact patch.
   *
   * All velocities are of the CONTACT POINT, expressed in the wheel's ground
   * frame: `vx` along the wheel's rolling direction, `vy` along its right axis.
   *
   * @param {number} dt
   * @param {number} vx   longitudinal patch velocity (m/s, + = forward)
   * @param {number} vy   lateral patch velocity (m/s, + = toward wheel right)
   * @param {number} omega wheel angular velocity (rad/s, + = rolling forward)
   * @param {number} load  vertical load Fz (N, ≥ 0)
   * @param {number} surfaceGrip grip multiplier from the surface table
   * @param {number} camber signed camber angle (rad, + = top leans right)
   * @param {number} [gripScale] extra per-car / per-effect multiplier
   */
  solve(dt, vx, vy, omega, load, surfaceGrip, camber, gripScale = 1) {
    const r = this.radius;

    if (load <= 1e-4) {
      // Airborne or fully unloaded: no force, but keep bleeding the slip state
      // toward zero so the tyre does not "remember" a slide across a jump.
      const decay = clamp01(dt * 9);
      this.slipRatio += (0 - this.slipRatio) * decay;
      this.slipAngle += (0 - this.slipAngle) * decay;
      this.slipRatioRaw = 0; this.slipAngleRaw = 0;
      this.fx = 0; this.fy = 0;
      this.peakForce = 0; this.saturation = 0;
      this.skid = 0; this.skidLat = 0; this.slipSpeed = 0;
      this.dFxDomega = 0; this.alignTorque = 0;
      return;
    }

    // ── μ with load sensitivity ────────────────────────────────────────
    const muBase = this.mu * surfaceGrip * gripScale;
    const loadRatio = load / this.nominalLoad;
    const muLoad = 1 - this.loadSensitivity * (loadRatio - 1);
    const mu = muBase * clamp(muLoad, 0.42, 1.55);
    this.muEff = mu;
    const D = mu * load;
    this.peakForce = D;

    // ── raw slips ──────────────────────────────────────────────────────
    const absVx = vx < 0 ? -vx : vx;
    const vRef = absVx > SLIP_REF_SPEED ? absVx : SLIP_REF_SPEED;
    let kappa = (omega * r - vx) / vRef;
    if (kappa > MAX_SLIP_RATIO) kappa = MAX_SLIP_RATIO;
    else if (kappa < -MAX_SLIP_RATIO) kappa = -MAX_SLIP_RATIO;
    const alpha = Math.atan2(vy, absVx + ANGLE_REF_SPEED);
    this.slipRatioRaw = kappa;
    this.slipAngleRaw = alpha;

    // ── relaxation (first-order lag in DISTANCE, not time) ─────────────
    const vRelax = absVx > RELAX_REF_SPEED ? absVx : RELAX_REF_SPEED;
    const cLong = clamp01((dt * vRelax) / this.relaxLong);
    const cLat = clamp01((dt * vRelax) / this.relaxLat);
    this.slipRatio += (kappa - this.slipRatio) * cLong;
    this.slipAngle += (alpha - this.slipAngle) * cLat;

    // ── combined slip ──────────────────────────────────────────────────
    //
    // ONE friction budget, spent along the direction the patch is actually
    // sliding. This replaced a post-hoc friction ellipse that was arithmetically
    // incapable of taking the lateral force away from a locked wheel, which is
    // why the cars could not drift.
    //
    // The old form evaluated each channel at its own slip and then scaled both
    // by 1/e with e = hypot(fx/D, fy/(0.985·D)). A locked wheel only ever
    // DEMANDS `slideLong` (0.580) longitudinally, so at full lateral grip
    // e = hypot(0.580, 1.015) = 1.169 and scale = 0.855, against 0.985 for a
    // free-rolling tyre — a ratio of 0.868. **A fully locked tyre kept 87 % of
    // its cornering force.** The handbrake stopped the car instead of rotating
    // it, and no combination of inputs could exceed ~9.5° of chassis slip.
    //
    // Now: normalise each slip by its own peak, take the resulting vector, read
    // ONE force magnitude at the combined slip, and point it opposite the slide.
    // A locked wheel has |sx| ≫ |sy|, so the direction is almost pure
    // longitudinal and the lateral share falls out as sy/s — roughly 9 % rather
    // than 87 %. Nothing is clamped and nothing is scaled after the fact; the
    // ellipse is implicit in the geometry, which is where it belongs.
    const sx = this.slipRatio / this.longCurve.peakAt;
    const sy = this.slipAngle / this.latCurve.peakAt;
    const s = Math.sqrt(sx * sx + sy * sy);

    let fx0 = 0, fy0 = 0;
    if (s > 1e-9) {
      // Direction cosines in normalised-slip space. wx² + wy² = 1.
      const wx = sx / s;
      const wy = sy / s;
      const kx = wx * wx;
      const ky = wy * wy;
      // Both authored slide numbers survive: a pure-longitudinal slide reads
      // the long curve at its own operating point and returns slideLong, a
      // pure-lateral one returns slideLat, and mixed slides blend by direction.
      const magLong = this.longCurve.shape(s * this.longCurve.peakAt);
      const magLat = this.latCurve.shape(s * this.latCurve.peakAt);
      // shape() is odd and s ≥ 0, so both are ≥ 0 here; the sign comes from w.
      const mag = magLong * kx + magLat * ky;
      // Lateral peaks a touch lower than longitudinal on a real tyre. Kept as a
      // directional blend rather than the old separate normalisation constant.
      const f = D * mag * (kx + 0.985 * ky);
      fx0 = f * wx;
      fy0 = -f * wy;
      this.saturation = s;
    } else {
      this.saturation = 0;
    }

    // Camber thrust: a leaning tyre pushes toward the lean. Applied after the
    // budget because it is a geometric effect, not patch sliding — but it may
    // not conjure grip a sliding tyre does not have, so it is capped by what
    // is left of the lateral budget.
    if (camber !== 0) {
      const headroom = Math.max(0, D - Math.abs(fy0));
      fy0 += clamp(this.camberStiffness * camber * load, -headroom, headroom);
    }

    this.fx = fx0;
    this.fy = fy0;
    // The implicit wheel solver used to be handed the ellipse's scale factor.
    // There is no longer a post-hoc scale, so it gets 1 and picks up the
    // saturation through the slope falloff below instead.
    const scale = 1;

    // ── linearisation for the implicit wheel solver ────────────────────
    // Fx ≈ D·(B·C)·κ near zero, κ = (ωr − vx)/vRef, and the lag scales the
    // response within this step, so ∂Fx/∂ω = D·B·C · cLong · r / vRef.
    // Past the peak the slope collapses; use a smooth falloff so a spinning
    // wheel does not get artificially glued.
    const kn = Math.abs(this.slipRatio) / this.longCurve.peakAt;
    const slopeFade = kn <= 1 ? 1 : 1 / (1 + (kn - 1) * (kn - 1) * 1.6);
    this.dFxDomega = (D * this.longCurve.stiffnessPerD * cLong * slopeFade * r) / vRef
      * (scale < 1 ? scale : 1);

    // ── skid / squeal ─────────────────────────────────────────────────
    const slipVx = omega * r - vx;
    const slipSpeed = Math.sqrt(slipVx * slipVx + vy * vy);
    this.slipSpeed = slipSpeed;
    const bySpeed = smoothstep((slipSpeed - SKID_ON) / (SKID_FULL - SKID_ON));
    const bySat = smoothstep((this.saturation - 0.80) / 0.35);
    const byLoad = clamp01(loadRatio * 1.6);
    const shared = lerp(0.35, 1, bySat) * byLoad;
    this.skid = clamp01(bySpeed * shared);
    // Same intensity curve, driven by the SIDEWAYS sliding speed alone.
    const absVy = vy < 0 ? -vy : vy;
    this.skidLat = clamp01(smoothstep((absVy - SKID_ON) / (SKID_FULL - SKID_ON)) * shared);

    // ── pneumatic-trail-ish aligning torque (telemetry / FFB) ──────────
    const trail = 0.28 * this.width * (1 - clamp01(Math.abs(this.slipAngle) / (this.latCurve.peakAt * 2.2)));
    this.alignTorque = -this.fy * trail;
  }

  /** Rolling-resistance torque magnitude at a given load (N·m, always ≥ 0). */
  rollingTorque(load, surfaceRoll = 1) {
    return this.rollResist * surfaceRoll * load * this.radius;
  }
}

export default Tire;
