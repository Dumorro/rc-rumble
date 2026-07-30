/**
 * RC RUMBLE — car definitions.
 *
 * Eight cars spanning the Re-Volt class ladder. Every number here is in SI at
 * 1:10 RC scale (metres / kilograms / seconds / radians) and everything the
 * simulation needs is either declared or *derived* from a handful of designer
 * intents, so tuning stays coherent:
 *
 *   intent            → derived
 *   ─────────────────────────────────────────────────────────────────────────
 *   accel (m/s²)      → engine peak torque (via 1st gear total ratio)
 *   topSpeed (m/s)    → gear ratios (redline lands exactly on each gear's top)
 *                     → aero drag coefficient (thrust == drag at topSpeed)
 *   suspension freq   → spring rate (from corner mass) and static ride height
 *   damping ratios    → bump / rebound damper rates
 *
 * That means you can change `accel` or `topSpeed` on a car and the whole
 * drivetrain re-balances itself instead of drifting out of tune.
 *
 * ── tuning targets (ARCHITECTURE.md) ──
 *   top speed ≈ 9 m/s · 0 → top in ≈ 2.5 s · catchable slides · visible
 *   weight transfer · readable jump arcs.
 */

import CONFIG from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/MathUtils.js';

/** Exaggerated gravity magnitude used for all static-load maths. */
export const G = Math.abs(CONFIG.physics.gravity ?? -19.6);

/** Multiply |speed| (m/s) by this for the HUD. 9 m/s ⇒ 120 "km/h". */
export const DISPLAY_SPEED_SCALE = 13.333;

/** Canonical class ladder, slowest → fastest. */
export const CAR_CLASSES = Object.freeze([
  'rookie', 'amateur', 'advanced', 'semi-pro', 'pro', 'super',
]);

/**
 * Fraction of the peak engine torque still available at 95 % of the redline.
 * Used to size the aero drag so wide-open throttle in top gear settles at
 * `topSpeed`. Keep in sync with `ENGINE_TORQUE_CURVE` in Drivetrain.js.
 */
const TORQUE_AT_TOP = 0.78;

/** Rolling-resistance coefficient (fraction of vertical load). */
const ROLL_COEFF = 0.018;

// ═══════════════════════════════════════════════════════════════════════════
// Defaults — every car inherits these and overrides what makes it special.
// ═══════════════════════════════════════════════════════════════════════════

const BASE = {
  id: 'car',
  name: 'Car',
  class: 'amateur',
  blurb: '',
  /** Which procedural body recipe in CarBodies.js to build. */
  shape: 'toyeca',

  // ── bulk ────────────────────────────────────────────────────────────
  mass: 1.60,              // kg
  /** Fraction of the static weight carried by the FRONT axle. */
  weightFront: 0.50,
  /** Centre-of-mass height above the ground at static ride height (m). */
  comHeight: 0.040,
  /** Yaw / roll / pitch inertia multipliers on top of the box estimate. */
  inertiaScale: [1.10, 1.25, 1.05],   // [pitch(x), yaw(y), roll(z)]

  // ── dimensions ──────────────────────────────────────────────────────
  length: 0.300,
  width: 0.180,
  height: 0.105,
  wheelbase: 0.200,
  trackWidth: 0.156,
  /** Chassis collider box, half extents + local centre offset. */
  hullHalf: [0.082, 0.030, 0.142],
  hullCenterY: 0.012,
  /** Longitudinal offset of the collider from the COM (+ = toward the rear). */
  hullCenterZ: 0.0,

  // ── performance intent ──────────────────────────────────────────────
  topSpeed: 9.0,           // m/s, wide-open in top gear on wood
  accel: 8.0,              // m/s² peak thrust-limited acceleration
  drive: '4wd',            // '4wd' | 'rwd' | 'fwd'
  /** Front torque share for 4WD (ignored for rwd/fwd). */
  torqueSplitFront: 0.42,
  diff: 'lsd',             // 'open' | 'lsd' | 'locked'
  diffLock: 0.55,          // 0..1 locking authority for 'lsd'
  chassis: 'plastic',      // 'plastic' | 'glass' | 'metal'

  // ── engine / gearbox ────────────────────────────────────────────────
  redlineRpm: 14500,
  limiterRpm: 15200,
  idleRpm: 1500,
  /** Fractions of `topSpeed` at which each gear reaches the redline. */
  gearSpeeds: [0.30, 0.52, 0.76, 1.00],
  shiftUpFrac: 0.955,     // of redline
  /**
   * Downshift below this fraction of the redline. MUST sit clear of the rpm you
   * land on after an upshift (≈ 0.55 for these ratios) or the box will hunt.
   */
  shiftDownFrac: 0.455,
  shiftTime: 0.11,        // s of reduced torque
  shiftTorqueDip: 0.16,   // torque multiplier during a shift
  reverseRatio: 3.05,     // relative to 1st
  reverseTopFrac: 0.34,   // of topSpeed
  engineInertia: 1.05e-6, // kg·m² at the crank (reflected through the gears)
  engineBraking: 0.115,   // fraction of peak torque at the redline, off-throttle

  // ── brakes ──────────────────────────────────────────────────────────
  /** Total brake torque across all four wheels (N·m). */
  brakeTorque: 1.10,
  brakeBiasFront: 0.62,
  /** Extra retardation on the driven axle at light pedal — "regen" feel. */
  regenTorque: 0.16,
  handbrakeTorque: 1.45,

  // ── steering ────────────────────────────────────────────────────────
  steerMax: 0.520,        // rad at standstill (≈ 30°)
  steerMaxFast: 0.215,    // rad at topSpeed
  steerRate: 9.0,         // rad/s rack speed
  ackermann: 0.55,        // 0 = parallel, 1 = full Ackermann
  /** Yaw damping that only engages while counter-steering — makes slides catchable. */
  counterSteerAssist: 0.0075,

  // ── suspension ──────────────────────────────────────────────────────
  susp: {
    travel: 0.040,        // m of usable strut travel
    anchorY: 0.014,       // strut top, chassis-local (recomputed from comHeight)
    frequency: 5.15,      // Hz undamped natural frequency at the corner
    frequencyRear: null,  // null ⇒ same as front
    bumpRatio: 0.36,      // damping ratio, compression
    reboundRatio: 0.58,   // damping ratio, extension
    /** Anti-roll bar rates as a fraction of the corner spring rate. */
    arbFront: 0.42,
    arbRear: 0.26,
    /** Progressive bump stop: engages past this fraction of travel. */
    bumpStopStart: 0.84,
    bumpStopRate: 9.0,    // × spring rate at full compression
    /** Extra force pulling a fully-drooped wheel back up (keeps it planted). */
    droopRate: 0.10,
    /** Static camber (rad, negative = top of tyre leans in). */
    camberStatic: -0.030,
    /** Camber gained per metre of compression. */
    camberPerComp: -0.55,
    /** How much of the tyre's lateral force is applied above the contact
     *  patch, toward the COM. Tames roll-over without hiding weight transfer. */
    forceLift: 0.25,
  },

  // ── tyres ───────────────────────────────────────────────────────────
  tyre: {
    radius: 0.033,
    width: 0.028,
    /** Base friction coefficient on a grip-1.00 surface. */
    grip: 1.06,
    gripRear: null,       // null ⇒ same as front
    /** Slip ratio / slip angle at which each curve peaks. */
    peakSlipRatio: 0.125,
    peakSlipAngle: 0.145, // rad ≈ 8.3°
    /**
     * Force in a full slide ÷ peak force. THE feel knob:
     *  · slideLat  high (≈0.84) ⇒ a slide keeps most of its grip ⇒ catchable.
     *  · slideLong low  (≈0.58) ⇒ a locked wheel stops badly ⇒ over-braking hurts.
     */
    slideLat: 0.840,
    slideLong: 0.580,
    /** Magic-formula E — how flat-topped the curve is before the peak (0..0.9). */
    curveLong: 0.30,
    curveLat: 0.42,
    /** Grip lost per unit of load above the static corner load. */
    loadSensitivity: 0.135,
    /** Lateral force per radian of camber, as a fraction of Fz. */
    camberStiffness: 0.55,
    /** Relaxation lengths (m) — forces build over distance, not instantly. */
    relaxLong: 0.055,
    relaxLat: 0.095,
    rollResist: ROLL_COEFF,
    /** Wheel rotational inertia (kg·m²). */
    inertia: 1.9e-5,
  },

  // ── aero & air behaviour ────────────────────────────────────────────
  aero: {
    /** Extra drag multiplier on top of the derived value. */
    dragScale: 1.0,
    /** Sideways drag, as a multiple of the longitudinal coefficient. */
    lateralDrag: 3.2,
    /** Downforce at topSpeed as a fraction of static weight. */
    downforce: 0.34,
    /** Where the downforce acts, chassis-local Z (+ = rear). */
    downforceZ: 0.045,
    /** Ground effect bonus when the floor is close. */
    groundEffect: 0.35,
    // ── airborne authority (Re-Volt's soul) ──
    airPitch: 0.0235,     // N·m from throttle / brake
    airRoll: 0.0125,      // N·m from steer
    airYaw: 0.0165,       // N·m from steer
    /** Self-levelling spring toward world up (N·m per rad) + its damping. */
    selfLevel: 0.0130,
    selfLevelDamp: 0.0042,
    /** Aligns the nose with the velocity vector — makes arcs readable. */
    weathervane: 0.0072,
    /** Angular damping while airborne (1/s). */
    airAngularDamp: 1.05,
    /** Nose-down bias so jumps land front-wheels-first. */
    noseDown: 0.0038,
  },

  // ── presentation ────────────────────────────────────────────────────
  colorPrimary: 0xd0201c,
  colorSecondary: 0x1b1e24,
  colorAccent: 0xf5c400,
  antennaColor: 0xff2d55,
  /** Visual-only exaggeration of the suspension attitude (0 = off). */
  visualRollGain: 0.55,
  visualPitchGain: 0.50,
  visualSquatGain: 0.55,

  /** 0..5 star ratings for the car-select UI. */
  rating: { speed: 3, accel: 3, grip: 3, weight: 3 },
};

// ═══════════════════════════════════════════════════════════════════════════
// The field
// ═══════════════════════════════════════════════════════════════════════════

/** @type {Array<object>} raw definitions, merged over BASE by `defineCar`. */
const RAW = [
  // ───────────────────────────────────────────────────────────── ROOKIE
  {
    id: 'pebble',
    name: 'Pebble',
    class: 'rookie',
    shape: 'pebble',
    blurb: 'Stubby four-wheel-drive starter buggy. Slow, forgiving, unkillable.',
    mass: 1.52,
    length: 0.255, width: 0.176, height: 0.112,
    wheelbase: 0.172, trackWidth: 0.158,
    hullHalf: [0.080, 0.031, 0.120], hullCenterY: 0.014,
    comHeight: 0.040,
    topSpeed: 7.45,
    accel: 6.55,
    drive: '4wd',
    torqueSplitFront: 0.46,
    diff: 'locked',
    chassis: 'plastic',
    weightFront: 0.49,
    brakeTorque: 0.98, brakeBiasFront: 0.60,
    steerMax: 0.545, steerMaxFast: 0.250,
    inertiaScale: [1.05, 1.15, 1.00],
    susp: {
      travel: 0.046, frequency: 4.55, frequencyRear: 4.35,
      bumpRatio: 0.40, reboundRatio: 0.62,
      arbFront: 0.30, arbRear: 0.22,
      camberStatic: -0.020,
    },
    tyre: { radius: 0.0345, width: 0.032, grip: 1.10, peakSlipAngle: 0.170, relaxLat: 0.105 },
    aero: { downforce: 0.16, airPitch: 0.0225, airRoll: 0.0115, selfLevel: 0.0155 },
    colorPrimary: 0x2fa8dd, colorSecondary: 0xf2f4f7, colorAccent: 0xffcf2e,
    antennaColor: 0xffe11a,
    rating: { speed: 1, accel: 2, grip: 4, weight: 2 },
  },

  // ──────────────────────────────────────────────────────────── AMATEUR
  {
    id: 'toyeca',
    name: 'Toyeca',
    class: 'amateur',
    shape: 'toyeca',
    blurb: 'Die-cast saloon. The benchmark: neutral, planted, honest.',
    mass: 1.62,
    length: 0.300, width: 0.180, height: 0.100,
    wheelbase: 0.202, trackWidth: 0.154,
    hullHalf: [0.082, 0.029, 0.142], hullCenterY: 0.012,
    comHeight: 0.038,
    topSpeed: 8.55,
    accel: 7.55,
    drive: '4wd',
    torqueSplitFront: 0.40,
    diff: 'lsd', diffLock: 0.55,
    chassis: 'metal',
    weightFront: 0.53,
    colorPrimary: 0xe23b2c, colorSecondary: 0x22262e, colorAccent: 0xd8dde4,
    antennaColor: 0x2fe08a,
    rating: { speed: 3, accel: 3, grip: 3, weight: 3 },
  },
  {
    id: 'vanster',
    name: 'Vanster',
    class: 'amateur',
    shape: 'van',
    blurb: 'Front-drive panel van. Heavy, tall, understeers — and shrugs off hits.',
    mass: 2.05,
    length: 0.312, width: 0.184, height: 0.140,
    wheelbase: 0.210, trackWidth: 0.152,
    hullHalf: [0.085, 0.046, 0.150], hullCenterY: 0.026,
    comHeight: 0.052,
    topSpeed: 8.15,
    accel: 6.85,
    drive: 'fwd',
    diff: 'open',
    chassis: 'metal',
    weightFront: 0.60,
    inertiaScale: [1.20, 1.35, 1.20],
    brakeTorque: 1.22, brakeBiasFront: 0.68,
    steerMax: 0.480, steerMaxFast: 0.200,
    counterSteerAssist: 0.0095,
    susp: {
      travel: 0.042, frequency: 4.95, frequencyRear: 5.35,
      bumpRatio: 0.40, reboundRatio: 0.60,
      arbFront: 0.50, arbRear: 0.20,
      forceLift: 0.32,
    },
    tyre: { grip: 1.02, gripRear: 0.99, width: 0.026, peakSlipAngle: 0.155 },
    aero: { lateralDrag: 4.1, downforce: 0.18, airPitch: 0.0195, selfLevel: 0.0115 },
    colorPrimary: 0xf4f6f8, colorSecondary: 0x2b6cb0, colorAccent: 0xc9ced6,
    antennaColor: 0xff7a1a,
    visualRollGain: 0.75, visualPitchGain: 0.60,
    rating: { speed: 2, accel: 2, grip: 3, weight: 5 },
  },

  // ─────────────────────────────────────────────────────────── ADVANCED
  {
    id: 'stomper',
    name: 'Stomper',
    class: 'advanced',
    shape: 'monster',
    blurb: 'Monster truck. Enormous travel, enormous wheels, enormous roll.',
    mass: 2.25,
    length: 0.298, width: 0.212, height: 0.168,
    wheelbase: 0.198, trackWidth: 0.196,
    hullHalf: [0.088, 0.038, 0.135], hullCenterY: 0.052,
    comHeight: 0.072,
    topSpeed: 8.30,
    accel: 8.15,
    drive: '4wd',
    torqueSplitFront: 0.48,
    diff: 'locked',
    chassis: 'metal',
    weightFront: 0.51,
    inertiaScale: [1.25, 1.30, 1.35],
    brakeTorque: 1.28, brakeBiasFront: 0.55,
    steerMax: 0.500, steerMaxFast: 0.215,
    susp: {
      travel: 0.072, anchorY: 0.030, frequency: 3.55, frequencyRear: 3.45,
      bumpRatio: 0.44, reboundRatio: 0.66,
      arbFront: 0.20, arbRear: 0.16,
      bumpStopStart: 0.80, bumpStopRate: 7.0,
      camberStatic: -0.012, camberPerComp: -0.30,
      forceLift: 0.42,
    },
    tyre: {
      radius: 0.050, width: 0.044, grip: 1.13,
      peakSlipAngle: 0.190, peakSlipRatio: 0.150,
      relaxLat: 0.125, relaxLong: 0.070, inertia: 5.6e-5,
      loadSensitivity: 0.100,
    },
    aero: {
      lateralDrag: 4.4, downforce: 0.10, groundEffect: 0.10,
      airPitch: 0.0330, airRoll: 0.0180, airYaw: 0.0200,
      selfLevel: 0.0175, noseDown: 0.0026,
    },
    colorPrimary: 0x8bc53f, colorSecondary: 0x3b2a1c, colorAccent: 0xffffff,
    antennaColor: 0xff3b30,
    visualRollGain: 0.85, visualPitchGain: 0.70, visualSquatGain: 0.70,
    rating: { speed: 2, accel: 4, grip: 4, weight: 5 },
  },

  // ────────────────────────────────────────────────────────── SEMI-PRO
  {
    id: 'cruiser',
    name: 'Cruiser',
    class: 'semi-pro',
    shape: 'lowrider',
    blurb: 'Slammed rear-drive lowrider. Glued down until it isn\'t.',
    mass: 1.88,
    length: 0.330, width: 0.186, height: 0.082,
    wheelbase: 0.226, trackWidth: 0.160,
    hullHalf: [0.086, 0.024, 0.156], hullCenterY: 0.006,
    comHeight: 0.030,
    topSpeed: 9.10,
    accel: 8.35,
    drive: 'rwd',
    diff: 'lsd', diffLock: 0.70,
    chassis: 'metal',
    weightFront: 0.47,
    inertiaScale: [1.15, 1.40, 0.95],
    brakeTorque: 1.16, brakeBiasFront: 0.60,
    handbrakeTorque: 1.75,
    steerMax: 0.505, steerMaxFast: 0.195,
    counterSteerAssist: 0.0065,
    susp: {
      travel: 0.026, anchorY: 0.006, frequency: 6.35, frequencyRear: 6.05,
      bumpRatio: 0.34, reboundRatio: 0.56,
      arbFront: 0.55, arbRear: 0.34,
      camberStatic: -0.045, camberPerComp: -0.70,
      forceLift: 0.18,
    },
    tyre: {
      radius: 0.030, width: 0.032, grip: 1.09, gripRear: 1.13,
      peakSlipAngle: 0.132, relaxLat: 0.085,
    },
    aero: { downforce: 0.30, airPitch: 0.0195, airRoll: 0.0135, selfLevel: 0.0105 },
    colorPrimary: 0x6a2fbf, colorSecondary: 0xf0c24a, colorAccent: 0xe8e2d0,
    antennaColor: 0x3ad0ff,
    visualRollGain: 0.35, visualPitchGain: 0.40,
    rating: { speed: 4, accel: 4, grip: 4, weight: 4 },
  },

  // ─────────────────────────────────────────────────────────────── PRO
  {
    id: 'needle',
    name: 'Needle',
    class: 'pro',
    shape: 'openwheel',
    blurb: 'Open-wheel formula toy. Vicious turn-in, zero forgiveness.',
    mass: 1.44,
    length: 0.352, width: 0.176, height: 0.078,
    wheelbase: 0.234, trackWidth: 0.164,
    hullHalf: [0.048, 0.024, 0.168], hullCenterY: 0.010,
    comHeight: 0.031,
    topSpeed: 9.55,
    accel: 8.85,
    drive: 'rwd',
    diff: 'lsd', diffLock: 0.62,
    chassis: 'plastic',
    weightFront: 0.44,
    inertiaScale: [1.05, 1.30, 0.85],
    brakeTorque: 1.32, brakeBiasFront: 0.64,
    steerMax: 0.470, steerMaxFast: 0.180,
    counterSteerAssist: 0.0058,
    redlineRpm: 16200, limiterRpm: 17000,
    gearSpeeds: [0.28, 0.50, 0.74, 1.00],
    susp: {
      travel: 0.028, anchorY: 0.008, frequency: 6.85, frequencyRear: 6.45,
      bumpRatio: 0.33, reboundRatio: 0.55,
      arbFront: 0.62, arbRear: 0.40,
      camberStatic: -0.055, camberPerComp: -0.85,
      forceLift: 0.14,
    },
    tyre: {
      radius: 0.032, width: 0.036, grip: 1.15, gripRear: 1.20,
      peakSlipAngle: 0.120, peakSlipRatio: 0.110,
      slideLat: 0.795, curveLat: 0.52, relaxLat: 0.075, relaxLong: 0.045,
      loadSensitivity: 0.160,
    },
    aero: {
      downforce: 0.62, downforceZ: 0.070, groundEffect: 0.55,
      airPitch: 0.0175, airRoll: 0.0105, airYaw: 0.0135,
      selfLevel: 0.0085, weathervane: 0.0098, noseDown: 0.0052,
    },
    colorPrimary: 0xf03a17, colorSecondary: 0x0f1116, colorAccent: 0xffffff,
    antennaColor: 0xffe11a,
    visualRollGain: 0.25, visualPitchGain: 0.30, visualSquatGain: 0.40,
    rating: { speed: 5, accel: 5, grip: 4, weight: 1 },
  },

  // ───────────────────────────────────────────────────────────── SUPER
  {
    id: 'wedge',
    name: 'Wedge',
    class: 'super',
    shape: 'wedge',
    blurb: 'Prototype doorstop. All-wheel drive, all-wheel violence.',
    mass: 1.70,
    length: 0.336, width: 0.194, height: 0.084,
    wheelbase: 0.224, trackWidth: 0.168,
    hullHalf: [0.090, 0.026, 0.160], hullCenterY: 0.010,
    comHeight: 0.033,
    topSpeed: 9.85,
    accel: 9.55,
    drive: '4wd',
    torqueSplitFront: 0.38,
    diff: 'lsd', diffLock: 0.75,
    chassis: 'plastic',
    weightFront: 0.46,
    inertiaScale: [1.05, 1.25, 0.90],
    brakeTorque: 1.36, brakeBiasFront: 0.60,
    steerMax: 0.485, steerMaxFast: 0.190,
    redlineRpm: 15800, limiterRpm: 16500,
    susp: {
      travel: 0.030, anchorY: 0.009, frequency: 6.45, frequencyRear: 6.25,
      bumpRatio: 0.34, reboundRatio: 0.56,
      arbFront: 0.56, arbRear: 0.40,
      camberStatic: -0.048, camberPerComp: -0.78,
      forceLift: 0.16,
    },
    tyre: {
      radius: 0.031, width: 0.034, grip: 1.17,
      peakSlipAngle: 0.128, peakSlipRatio: 0.118, relaxLat: 0.078,
    },
    aero: {
      downforce: 0.55, downforceZ: 0.058, groundEffect: 0.48,
      airPitch: 0.0205, airRoll: 0.0125, airYaw: 0.0155,
      selfLevel: 0.0100, weathervane: 0.0088, noseDown: 0.0046,
    },
    colorPrimary: 0xffd400, colorSecondary: 0x14161b, colorAccent: 0xff3b30,
    antennaColor: 0xff2d55,
    visualRollGain: 0.30, visualPitchGain: 0.35,
    rating: { speed: 5, accel: 5, grip: 5, weight: 2 },
  },
  {
    id: 'phantom',
    name: 'Phantom',
    class: 'super',
    shape: 'speedster',
    blurb: 'Clear-shell speedster. Feather-light, twitchy, and very fast.',
    mass: 1.30,
    length: 0.318, width: 0.172, height: 0.086,
    wheelbase: 0.214, trackWidth: 0.156,
    hullHalf: [0.080, 0.026, 0.150], hullCenterY: 0.010,
    comHeight: 0.034,
    topSpeed: 10.10,
    accel: 9.20,
    drive: 'rwd',
    diff: 'lsd', diffLock: 0.50,
    chassis: 'glass',
    weightFront: 0.45,
    inertiaScale: [0.95, 1.15, 0.80],
    brakeTorque: 1.20, brakeBiasFront: 0.62,
    handbrakeTorque: 1.60,
    steerMax: 0.520, steerMaxFast: 0.205,
    counterSteerAssist: 0.0050,
    redlineRpm: 16800, limiterRpm: 17600,
    susp: {
      travel: 0.032, anchorY: 0.010, frequency: 6.05, frequencyRear: 5.75,
      bumpRatio: 0.32, reboundRatio: 0.54,
      arbFront: 0.48, arbRear: 0.30,
      camberStatic: -0.042, camberPerComp: -0.72,
      forceLift: 0.15,
    },
    tyre: {
      radius: 0.031, width: 0.030, grip: 1.12, gripRear: 1.14,
      peakSlipAngle: 0.138, relaxLat: 0.082, inertia: 1.5e-5,
    },
    aero: {
      downforce: 0.44, downforceZ: 0.052, groundEffect: 0.42,
      airPitch: 0.0215, airRoll: 0.0140, airYaw: 0.0175,
      selfLevel: 0.0095, weathervane: 0.0085, noseDown: 0.0044,
    },
    colorPrimary: 0x4de0ff, colorSecondary: 0x101820, colorAccent: 0xffffff,
    antennaColor: 0xff2d55,
    visualRollGain: 0.32, visualPitchGain: 0.36,
    rating: { speed: 5, accel: 5, grip: 4, weight: 1 },
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Normalisation & derivation
// ═══════════════════════════════════════════════════════════════════════════

function mergeSub(base, over) {
  if (!over) return { ...base };
  const out = { ...base };
  for (const k in over) if (over[k] !== undefined && over[k] !== null) out[k] = over[k];
  return out;
}

/**
 * Merge a raw definition over BASE and compute every derived quantity the
 * simulation needs. Pure — safe to call at module scope.
 * @param {object} raw
 * @returns {object} CarDef
 */
export function defineCar(raw) {
  const d = { ...BASE, ...raw };
  d.susp = mergeSub(BASE.susp, raw.susp);
  d.tyre = mergeSub(BASE.tyre, raw.tyre);
  d.aero = mergeSub(BASE.aero, raw.aero);
  d.rating = mergeSub(BASE.rating, raw.rating);
  d.hullHalf = (raw.hullHalf ?? BASE.hullHalf).slice();
  d.inertiaScale = (raw.inertiaScale ?? BASE.inertiaScale).slice();
  d.gearSpeeds = (raw.gearSpeeds ?? BASE.gearSpeeds).slice();

  const s = d.susp;
  const t = d.tyre;
  const a = d.aero;

  // ── mass distribution ───────────────────────────────────────────────
  const weight = d.mass * G;
  d.weight = weight;
  d.axleLoadFront = weight * d.weightFront;
  d.axleLoadRear = weight * (1 - d.weightFront);
  d.staticLoad = [
    d.axleLoadFront * 0.5, d.axleLoadFront * 0.5,
    d.axleLoadRear * 0.5, d.axleLoadRear * 0.5,
  ];
  d.cornerMassFront = d.mass * d.weightFront * 0.5;
  d.cornerMassRear = d.mass * (1 - d.weightFront) * 0.5;

  // ── wheel geometry, chassis-local (−Z forward, +X right, +Y up) ─────
  const halfWb = d.wheelbase * 0.5;
  const halfTr = d.trackWidth * 0.5;
  /** Longitudinal COM offset so `weightFront` is honoured by the geometry. */
  const comZ = (d.weightFront - 0.5) * d.wheelbase;
  d.comZ = comZ;
  d.axleZFront = -halfWb - comZ;
  d.axleZRear = halfWb - comZ;

  // Anchor Y so that at static compression the COM sits at `comHeight`.
  const freqF = s.frequency;
  const freqR = s.frequencyRear ?? s.frequency;
  s.springFront = d.cornerMassFront * Math.pow(2 * Math.PI * freqF, 2);
  s.springRear = d.cornerMassRear * Math.pow(2 * Math.PI * freqR, 2);
  s.staticCompFront = clamp((d.cornerMassFront * G) / s.springFront, 0, s.travel * 0.92);
  s.staticCompRear = clamp((d.cornerMassRear * G) / s.springRear, 0, s.travel * 0.92);
  const critF = 2 * Math.sqrt(s.springFront * d.cornerMassFront);
  const critR = 2 * Math.sqrt(s.springRear * d.cornerMassRear);
  s.bumpFront = critF * s.bumpRatio;
  s.reboundFront = critF * s.reboundRatio;
  s.bumpRear = critR * s.bumpRatio;
  s.reboundRear = critR * s.reboundRatio;
  s.arbRateFront = s.springFront * s.arbFront;
  s.arbRateRear = s.springRear * s.arbRear;
  /** Minimum anchor→hub gap at full bump, so the wheel never reaches the anchor. */
  s.standoff = s.standoff ?? 0.006;
  /** Anchor → hub distance at FULL DROOP. */
  s.restLength = s.travel + s.standoff;

  // anchorY: wheelCentreLocalY(static) = radius − comHeight
  //          anchorY = wheelCentreLocalY + (restLength − staticComp)
  const wcF = t.radius - d.comHeight;
  const wcR = t.radius - d.comHeight;
  s.anchorYFront = wcF + (s.restLength - s.staticCompFront);
  s.anchorYRear = wcR + (s.restLength - s.staticCompRear);
  s.anchorY = (s.anchorYFront + s.anchorYRear) * 0.5;

  /** [x, y, z] chassis-local strut anchors, order FL FR RL RR. */
  d.wheelAnchors = [
    [-halfTr, s.anchorYFront, d.axleZFront],
    [+halfTr, s.anchorYFront, d.axleZFront],
    [-halfTr, s.anchorYRear, d.axleZRear],
    [+halfTr, s.anchorYRear, d.axleZRear],
  ];

  // ── drivetrain ──────────────────────────────────────────────────────
  const redlineOmega = (d.redlineRpm * 2 * Math.PI) / 60;
  d.redlineOmega = redlineOmega;
  d.limiterOmega = (d.limiterRpm * 2 * Math.PI) / 60;
  d.idleOmega = (d.idleRpm * 2 * Math.PI) / 60;

  /** Total ratio (engine → wheel) per gear, index 0 = 1st. */
  d.gearRatios = d.gearSpeeds.map((frac) => {
    const wheelOmega = Math.max(0.5, (d.topSpeed * frac) / t.radius);
    return redlineOmega / wheelOmega;
  });
  d.gearCount = d.gearRatios.length;
  d.reverseGearRatio = redlineOmega / Math.max(0.5, (d.topSpeed * d.reverseTopFrac) / t.radius);

  /** Peak wheel torque needed for `accel`, summed over the driven wheels. */
  const peakWheelTorque = d.accel * d.mass * t.radius;
  d.peakWheelTorque = peakWheelTorque;
  d.enginePeakTorque = peakWheelTorque / d.gearRatios[0];

  /** Shift speeds (m/s) per gear — where the redline lands. */
  d.gearTopSpeeds = d.gearSpeeds.map((f) => d.topSpeed * f);

  // ── aero, sized so wide-open in top gear settles at `topSpeed` ──────
  const topRatio = d.gearRatios[d.gearCount - 1];
  const thrustAtTop = (d.enginePeakTorque * TORQUE_AT_TOP * topRatio) / t.radius;
  const rollingAtTop = t.rollResist * weight;
  const v2 = d.topSpeed * d.topSpeed;
  a.dragK = Math.max(0.004, ((thrustAtTop - rollingAtTop) / v2) * a.dragScale);
  a.lateralDragK = a.dragK * a.lateralDrag;
  a.downforceK = (a.downforce * weight) / v2;

  // ── driven-wheel mask ───────────────────────────────────────────────
  const fwd = d.drive === 'fwd' || d.drive === '4wd';
  const rwd = d.drive === 'rwd' || d.drive === '4wd';
  d.driven = [fwd, fwd, rwd, rwd];
  d.driveSplit = d.drive === '4wd'
    ? [d.torqueSplitFront * 0.5, d.torqueSplitFront * 0.5,
      (1 - d.torqueSplitFront) * 0.5, (1 - d.torqueSplitFront) * 0.5]
    : d.drive === 'fwd' ? [0.5, 0.5, 0, 0] : [0, 0, 0.5, 0.5];
  d.drivenCount = d.driven.reduce((n, v) => n + (v ? 1 : 0), 0);

  /** Brake torque per wheel at full pedal. */
  d.brakeSplit = [
    d.brakeTorque * d.brakeBiasFront * 0.5,
    d.brakeTorque * d.brakeBiasFront * 0.5,
    d.brakeTorque * (1 - d.brakeBiasFront) * 0.5,
    d.brakeTorque * (1 - d.brakeBiasFront) * 0.5,
  ];

  // ── tyre (Tire.js fits B/C/D/E from these) ──────────────────────────
  t.gripFront = t.grip;
  t.gripRearEff = t.gripRear ?? t.grip;

  // ── inertia estimate (about the COM) ────────────────────────────────
  const m = d.mass;
  const w = d.width, h = d.height, l = d.length;
  d.inertia = [
    (m * (h * h + l * l) / 12) * d.inertiaScale[0],   // pitch, about X
    (m * (w * w + l * l) / 12) * d.inertiaScale[1],   // yaw,   about Y
    (m * (w * w + h * h) / 12) * d.inertiaScale[2],   // roll,  about Z
  ];

  // ── convenience for the UI ──────────────────────────────────────────
  d.classIndex = Math.max(0, CAR_CLASSES.indexOf(d.class));
  d.topSpeedKmh = Math.round(d.topSpeed * DISPLAY_SPEED_SCALE);
  d.zeroToTop = estimateZeroToTop(d);

  return d;
}

/** Closed-form-ish estimate of the 0 → 95 % top-speed time, for the UI. */
function estimateZeroToTop(d) {
  const vmax = d.topSpeed * 1.045;
  const A = d.accel;
  const target = d.topSpeed * 0.95;
  const r = clamp01(1 - target / vmax);
  if (r <= 1e-4) return 9.9;
  return Math.min(9.9, (vmax / A) * -Math.log(r));
}

/** @type {object[]} */
export const CAR_DEFS = RAW.map(defineCar);

/** @type {Map<string, object>} */
export const CAR_BY_ID = new Map(CAR_DEFS.map((d) => [d.id, d]));

/** @param {string} id @returns {object} never null — falls back to `toyeca`. */
export function getCarDef(id) {
  return CAR_BY_ID.get(id) ?? CAR_BY_ID.get('toyeca') ?? CAR_DEFS[0];
}

/** Shallow list for the car-select UI (the defs themselves, do not mutate). */
export function listCarDefs() { return CAR_DEFS; }

/** Ids ordered by class then speed — a sensible menu order. */
export function carIdsByClass() {
  return CAR_DEFS.slice()
    .sort((a, b) => (a.classIndex - b.classIndex) || (a.topSpeed - b.topSpeed))
    .map((d) => d.id);
}

/**
 * Pick `n` opponent ids for a race, biased toward the player's class so the
 * field is competitive but varied. Deterministic given `rng`.
 * @param {string} playerId
 * @param {number} n
 * @param {{next:()=>number}} rng
 */
export function pickOpponents(playerId, n, rng) {
  const player = getCarDef(playerId);
  const pool = CAR_DEFS.filter((d) => d.id !== playerId);
  // Score by class proximity with a little noise so it is not always the same.
  const scored = pool.map((d) => ({
    d,
    s: Math.abs(d.classIndex - player.classIndex) + (rng ? rng.next() * 1.15 : 0),
  }));
  scored.sort((a, b) => a.s - b.s);
  const out = [];
  for (let i = 0; i < n; i++) out.push(scored[i % scored.length].d.id);
  return out;
}

/** Interpolate a rating into a 0..1 bar value. */
export function ratingBar(v) { return clamp01(lerp(0, 1, v / 5)); }

export default CAR_DEFS;
