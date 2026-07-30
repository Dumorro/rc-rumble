/**
 * RC RUMBLE — physics public surface.
 *
 * Other systems should import from here (or from PhysicsWorld.js, which
 * re-exports the same essentials) rather than reaching into individual files.
 *
 *   import { RigidBody, Layer, makeBox, createRayHit } from '../physics/index.js';
 */

export { PhysicsWorld, SURFACE_FRICTION, SURFACE_BOUNCE } from './PhysicsWorld.js';
export { RigidBody, Layer, BodyType, createBoxBody, createSphereBody, createCapsuleBody } from './RigidBody.js';
export {
  ShapeType, makeBox, makeBoxSize, makeSphere, makeCapsule, makeCylinder,
  makeHull, makeHullFromGeometry, buildHullData, hullSupport,
  boxInertia, boxInertiaHalf, sphereInertia, shellInertia,
  cylinderInertia, capsuleInertia, parallelAxis, colliderInertia,
  colliderAABB, quatToMatrix3, validateHull,
} from './Shapes.js';
export {
  CollisionMesh, CollisionMeshBuilder, createRayHit,
  closestPointOnTriangleRaw, regionIsInternal, CP,
} from './CollisionMesh.js';
export { BVH, createBVHRayResult, rayTriangle } from './BVH.js';
export {
  Manifold, sphereVsTriangle, capsuleVsTriangle, hullVsTriangle,
  sphereVsSphere, sphereVsHull, hullVsHull,
  sweepSphereTriangle, rayHull, raySphere, SWEEP,
} from './Collision.js';
export { Broadphase } from './Broadphase.js';
export { Solver, ContactPool, ImpulseCache, contactKey } from './Solver.js';
export { DebugDraw, DEBUG_COLOR } from './DebugDraw.js';

export { default } from './PhysicsWorld.js';
