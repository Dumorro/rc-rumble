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
 *                                        → solves for C in closed form,
 *                                          because the asymptote of the magic
 *                                          formula is exactly D·sin(C·π/2)
 *   `curveLong` / `curveLat`   (= E)
 *        how "flat-topped" the curve is between the linear region and the peak
 *   `grip`, `loadSensitivity`
 *        μ and how much of it you lose as vertical load rises
 *
 * That makes the two properties that actually decide game feel directly
 * dialable: `slideLat` ≈ 0.84 means a sliding tyre still returns 84 % of its
 * peak lateral force, which is *why* a Re-Volt slide is catchable. Longitudinal
 * `slideLong` ≈ 0.58 means a locked wheel loses 42 % of its stopping power, so
 * over-braking is punished.
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
 * C from the desired slide/peak force ratio.
 * The magic formula's asymptote is D·sin(C·π/2); taking the branch with C > 1
 * (the branch that actually has a peak) gives C = 2 − (2/π)·asin(f).
 * @param {number} slideFraction 0.2 … 0.98
 */
export function shapeFromSlide(slideFraction) {
  const f = clamp(slideFraction, 0.18, 0.985);
  return 2 - (2 / Math.PI) * Math.asin(f);
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
   * @param {number} slideFraction force in a full slide ÷ peak force
   * @param {number} E curvature (0 = classic, higher = flatter top)
   */
  constructor(peakAt, slideFraction, E) {
    this.C = shapeFromSlide(slideFraction);
    this.E = clamp(E, -1.5, 0.92);
    this.peakAt = Math.max(1e-4, peakAt);
    this.B = magicPeakArg(this.C, this.E) / this.peakAt;
    /** dF/dslip at zero slip, per newton of peak force D. */
    this.stiffnessPerD = this.B * this.C;
    this.slideFraction = Math.sin((this.C * Math.PI) / 2);
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
    this.rollResist = t.rollResist;
    this.inertia = t.inertia;
    /** Reference load for the load-sensitivity curve (N). */
    this.nominalLoad = Math.max(0.5, isFront
      ? def.axleLoadFront * 0.5
      : def.axleLoadRear * 0.5);

    this.longCurve = new MagicCurve(t.peakSlipRatio, t.slideLong, t.curveLong);
    this.latCurve = new MagicCurve(t.peakSlipAngle, t.slideLat, t.curveLat);

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
    /** 0..1 skid intensity for tyre marks / squeal. */
    this.skid = 0;
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
    this.saturation = 0; this.skid = 0; this.slipSpeed = 0;
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
      this.skid = 0; this.slipSpeed = 0;
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

    // ── magic formula ──────────────────────────────────────────────────
    let fx0 = D * this.longCurve.shape(this.slipRatio);
    // Lateral force opposes the lateral patch motion, hence the sign flip.
    let fy0 = -D * this.latCurve.shape(this.slipAngle);

    // Camber thrust: a leaning tyre pushes toward the lean.
    if (camber !== 0) {
      fy0 += this.camberStiffness * camber * load;
    }

    // ── friction ellipse ───────────────────────────────────────────────
    // Both channels draw on the same patch. Normalise by the per-axis peak
    // (lateral peaks a touch lower than longitudinal on a real tyre).
    const dLat = D * 0.985;
    const ex = fx0 / (D || 1);
    const ey = fy0 / (dLat || 1);
    const e = Math.sqrt(ex * ex + ey * ey);
    let scale = 1;
    if (e > 1) scale = 1 / e;
    this.fx = fx0 * scale;
    this.fy = fy0 * scale;
    this.saturation = e;

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
    this.skid = clamp01(bySpeed * lerp(0.35, 1, bySat) * byLoad);

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
