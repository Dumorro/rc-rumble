/**
 * Central tunable configuration.
 *
 * Units: metres, seconds, kilograms, radians. Scale is 1:10 RC.
 * Query-string overrides: ?debug=1&track=garden&car=phantom&laps=3&quality=low
 */

const qs = new URLSearchParams(globalThis.location?.search ?? '');
const qNum = (k, d) => (qs.has(k) ? Number(qs.get(k)) : d);
const qStr = (k, d) => (qs.has(k) ? String(qs.get(k)) : d);
const qBool = (k, d) => (qs.has(k) ? qs.get(k) !== '0' && qs.get(k) !== 'false' : d);

/** Detected once; render system may downgrade further. */
function guessQuality() {
  const mem = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent ?? '');
  if (mobile || mem <= 4 || cores <= 4) return 'low';
  if (mem <= 8 || cores <= 8) return 'medium';
  return 'high';
}

export const CONFIG = {
  debug: qBool('debug', false),
  seed: qNum('seed', 20250730),

  /** 'low' | 'medium' | 'high' | 'ultra' */
  quality: qStr('quality', guessQuality()),

  startup: {
    track: qStr('track', ''),      // '' = go to menu
    car: qStr('car', 'toyeca'),
    laps: qNum('laps', 3),
    opponents: qNum('opponents', 7),
    skipMenu: qBool('skipmenu', false),
  },

  physics: {
    fixedDt: 1 / 120,
    maxSubSteps: 8,
    gravity: -19.6,          // 2g — Re-Volt-style exaggeration at RC scale
    linearDamping: 0.02,
    angularDamping: 0.08,
    restitutionDefault: 0.25,
    frictionDefault: 0.8,
    sleepLinear: 0.02,
    sleepAngular: 0.05,
    sleepTime: 0.6,
    contactSlop: 0.0015,
    baumgarte: 0.22,
    solverIterations: 8,
    maxContactsPerBody: 24,
  },

  world: {
    scale: 10,               // real world is 10× the car; used for set dressing
    upAxis: [0, 1, 0],
  },

  race: {
    countdownSeconds: 3.0,
    maxCars: 8,
    respawnDelay: 0.65,
    wrongWayAngle: Math.PI * 0.6,
    finishCamSeconds: 6.0,
  },

  render: {
    exposure: 1.05,
    shadowMapSize: { low: 1024, medium: 2048, high: 2048, ultra: 4096 },
    shadowCascades: { low: 1, medium: 2, high: 3, ultra: 4 },
    maxPixelRatio: { low: 1.0, medium: 1.25, high: 1.75, ultra: 2.0 },
    anisotropy: { low: 2, medium: 4, high: 8, ultra: 16 },
    postfx: {
      bloom: true,
      motionBlur: { low: false, medium: false, high: true, ultra: true },
      ssao: { low: false, medium: false, high: true, ultra: true },
      vignette: true,
      grain: true,
      chromaticAberration: true,
      colorGrade: true,
    },
    fovBase: 62,
    fovSpeedGain: 16,        // extra degrees at top speed
  },

  fx: {
    maxParticles: { low: 2000, medium: 6000, high: 14000, ultra: 24000 },
    tireMarkSegments: { low: 512, medium: 1536, high: 3072, ultra: 6144 },
    tireMarkFade: 14.0,      // seconds until fully faded
    sparksEnabled: true,
    decalLimit: 128,
  },

  audio: {
    masterVolume: 0.85,
    musicVolume: 0.45,
    sfxVolume: 0.9,
    engineVolume: 0.7,
    maxVoices: 48,
    dopplerFactor: 0.6,
    speedOfSound: 343,
    rolloff: 1.4,
    refDistance: 1.2,
    maxDistance: 45,
  },

  camera: {
    mode: 'chase',
    chase: {
      distance: 1.05,
      height: 0.42,
      lookAhead: 0.55,
      lookHeight: 0.10,
      posStiffness: 11.0,
      posDamping: 1.0,
      rotStiffness: 8.0,
      velocityLead: 0.16,
      pitchFromAir: 0.18,
    },
    shakeDecay: 5.5,
    slowMoScale: 0.35,
  },

  input: {
    steerSpeed: 4.2,         // rate to reach full lock on keyboard
    steerReturn: 6.5,
    deadzone: 0.14,
    throttleSpeed: 6.0,
    brakeSpeed: 9.0,
  },

  ai: {
    lookAheadBase: 0.9,
    lookAheadSpeed: 0.22,
    rubberBand: 0.10,
    skillSpread: [0.80, 1.0],
    mistakeChance: 0.05,
  },
};

/** Resolve a per-quality value like `{low:1, medium:2, high:3, ultra:4}`. */
export function q(value, quality = CONFIG.quality) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value[quality] ?? value.high ?? value.medium ?? value.low;
  }
  return value;
}

export default CONFIG;
