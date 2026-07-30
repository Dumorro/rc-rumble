/**
 * RC RUMBLE — vehicle public surface.
 *
 * Other systems should import from here rather than reaching into individual
 * files:
 *
 *   import { CarSystem, CAR_DEFS, getCarDef } from '../vehicle/index.js';
 */

export { CarSystem } from './CarSystem.js';
export { Car, Wheel, SURFACE_ROLL, chassisHullPoints } from './Car.js';
export {
  CAR_DEFS, CAR_BY_ID, CAR_CLASSES, DISPLAY_SPEED_SCALE, G,
  getCarDef, listCarDefs, carIdsByClass, pickOpponents, defineCar, ratingBar,
} from './CarDefs.js';
export { Suspension } from './Suspension.js';
export { Tire, MagicCurve, shapeFromSlide, magicPeakArg } from './Tire.js';
export { Drivetrain, engineTorqueFactor } from './Drivetrain.js';
export { AeroBody } from './AeroBody.js';
export { AIDriver, AIPath, buildAIPath } from './AIDriver.js';
export { Respawn, levelQuaternion } from './Respawn.js';
export {
  buildCarModel, getCarParts, carMaterials, buildWheelParts,
  AntennaChain, stationGeometry, superSection, roundBox, revolveX, tube,
} from './CarBodies.js';

export { CarSystem as default } from './CarSystem.js';
