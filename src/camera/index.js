/**
 * Camera system barrel.
 *
 * `game.cameraDirector` is the only thing other systems normally need; the rigs
 * and helpers are exported for tools, debug overlays and the UI (which may want a
 * turntable of its own).
 *
 * ```js
 * import { CameraDirector, CAMERA_MODES } from './camera/index.js';
 * ```
 */

export { CameraDirector, CAMERA_MODES, CYCLE_MODES, default } from './CameraDirector.js';
export { ChaseCamera, CHASE_PRESETS } from './ChaseCamera.js';
export { OrbitCamera, ORBIT_PRESETS } from './OrbitCamera.js';
export { CinematicCamera, INTRO_SHOTS, samplePath } from './CinematicCamera.js';
export { FinishCamera, FINISH_PRESETS } from './FinishCamera.js';
export { FreeCamera } from './FreeCamera.js';
export { CameraShake } from './CameraShake.js';
export { CameraPose, blendPose, framingUp, dirFromYaw, yawOf, WORLD_UP } from './CameraPose.js';
export { CarState } from './CarState.js';
export {
  Spring, AngleSpring, Vec3Spring, springStep, approach, approachAngle, wrapPi, omegaForSettle,
} from './Spring.js';
