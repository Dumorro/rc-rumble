# RC RUMBLE — Architecture Contract

> **Every agent working on this repo MUST read this file first and MUST NOT violate it.**
> It is the interface contract that lets many people work on separate systems in parallel
> without breaking each other.

## Product

A fully playable, AAA-polish RC-car racing game in the spirit of **Re-Volt (1999)**:
tiny radio-controlled cars racing through oversized real-world environments (toy museum,
garden, supermarket…), with real suspension physics, weight transfer, drifts, jumps,
pickups/weapons, chaotic AI packs, and a chase camera that feels like the original.

## Hard rules

1. **Three.js only.** No game engines (no Babylon, PlayCanvas), no physics libs
   (no cannon/ammo/rapier), no tween libs, no UI frameworks. `three` is the ONLY runtime dep.
   `three/examples/jsm/**` is allowed (it ships with three).
2. **Zero pre-made assets.** No downloaded textures, models, audio, or fonts.
   Everything is generated in code: canvas/noise textures, procedural geometry,
   WebAudio-synthesized sound, CSS/canvas-drawn UI. Data URIs of binary assets are banned.
3. **ES modules, no TypeScript.** Plain modern JS (`.js`), ESM `import`/`export`.
4. **60 fps budget on a 2021 laptop iGPU at 1600×900.** Every system must respect the
   frame budget table below. No per-frame allocations in hot paths — use scratch objects.
5. **Everything must keep running.** Never leave `main` in a broken state. If a subsystem
   is unfinished, it must no-op gracefully, not throw.
6. **Own your files.** Only edit files inside the directories you own (see Ownership).
   Need a change elsewhere? Use the documented interface or the EventBus.

## Coordinate system & units

- **Y-up**, right-handed (three.js default). `-Z` is "forward" for a car at identity rotation.
- **1 unit = 1 metre**, at **1:10 RC scale**. An RC car is ~0.30 m long, ~0.18 m wide,
  ~0.11 m tall, wheelbase ~0.20 m, wheel radius ~0.033 m, mass ~1.6 kg.
- Gravity is **exaggerated** like Re-Volt: `-19.6 m/s²` (2×g) so small cars feel weighty
  and arcs read correctly on a small scale. See `CONFIG.physics.gravity`.
- Top speed of a stock car ≈ 9 m/s (feels like ~120 km/h at RC scale).
- Angles in radians. Time in seconds.

## Runtime shape

```
main.js
  └── Game            (core/Game.js)     — owns systems, scene, camera, state machine
        ├── Loop      (core/Loop.js)     — fixed-step accumulator: 120 Hz physics, render at vsync
        ├── EventBus  (core/EventBus.js) — decoupled cross-system messaging
        ├── Input     (core/Input.js)    — keyboard + gamepad + touch → normalized InputState
        ├── Assets    (core/Assets.js)   — procedural texture/material cache (lazy, keyed)
        ├── Renderer  (render/Renderer.js)
        ├── Physics   (physics/PhysicsWorld.js)
        ├── Track     (track/TrackSystem.js)
        ├── Cars      (vehicle/CarSystem.js)
        ├── Race      (gameplay/RaceSystem.js)
        ├── Pickups   (gameplay/PickupSystem.js)
        ├── FX        (fx/FXSystem.js)
        ├── CameraDir (camera/CameraDirector.js)
        ├── Audio     (audio/AudioSystem.js)
        └── UI        (ui/UISystem.js)
```

### System interface

Every system is a class implementing this duck-type. All methods optional except `constructor`.

```js
export class FooSystem {
  /** @param {Game} game */
  constructor(game) { this.game = game; }

  /** async one-time setup. Called once, awaited, before the first frame. */
  async init() {}

  /** Called when a race/level is loaded. `ctx` = { track, cars, mode } */
  onRaceStart(ctx) {}
  onRaceEnd(ctx) {}

  /** Fixed-timestep simulation. dt is ALWAYS CONFIG.physics.fixedDt. */
  fixedUpdate(dt) {}

  /** Variable-rate update for visuals. `alpha` = interpolation factor [0,1]
   *  between previous and current physics state. */
  update(dt, alpha) {}

  /** Called after all update()s, right before render. Camera/postfx work goes here. */
  lateUpdate(dt, alpha) {}

  dispose() {}
}
```

Registration order in `Game.SYSTEM_ORDER` defines update order. Do not reorder without
telling everyone.

### Update order (per frame)

```
Input.poll()
while (accumulator >= dt):        // fixed 1/120 s
    Physics.fixedUpdate           // integrate bodies, resolve collisions
    Cars.fixedUpdate              // suspension, tires, drivetrain → forces
    Race.fixedUpdate              // checkpoints, laps, positions
    Pickups.fixedUpdate           // pickup pads, projectile sim
Track.update      (visual: animated props, interactive objects)
Cars.update       (visual: mesh interpolation, wheel spin, body roll)
FX.update         (particles, tire marks, sparks)
Audio.update      (engine synth params, spatialization)
UI.update
CameraDir.lateUpdate
Renderer.render
```

## Shared data contracts

### `InputState` (produced by `core/Input.js`, read by everyone)

```js
{
  throttle: 0..1,       // analog
  brake:    0..1,       // analog (also reverse when stopped)
  steer:   -1..1,       // -1 = full left, +1 = full right
  handbrake: 0..1,
  fire:      bool,      // edge-triggered helpers: pressed(name)
  lookBack:  bool,
  reset:     bool,      // respawn to last checkpoint
  camera:    bool,      // cycle camera mode
  pause:     bool,
}
```

### `RigidBody` (physics/RigidBody.js)

```js
{
  position: Vector3, quaternion: Quaternion,
  velocity: Vector3, angularVelocity: Vector3,
  mass, invMass, inertiaTensorLocal: Vector3, invInertiaWorld: Matrix3,
  force: Vector3, torque: Vector3,
  // read-only interpolation snapshots kept by PhysicsWorld
  prevPosition: Vector3, prevQuaternion: Quaternion,
  collider: { type: 'hull'|'sphere'|'box', ... },
  applyForce(f, worldPoint), applyImpulse(j, worldPoint),
  pointVelocity(worldPoint, out)
}
```

### `TrackData` (produced by track/, consumed by physics, AI, race, camera, audio, fx)

```js
{
  id: 'toy_museum',
  name: 'Toy Museum',
  scene: THREE.Group,            // all visual meshes, added to game.scene
  collision: CollisionMesh,      // BVH-indexed triangle soup + per-tri surface id
  surfaces: SurfaceTable,        // id → { name, grip, rollingResistance, bumpiness, sfx, particle }
  spline: CenterlineSpline,      // .sample(t) → {position, tangent, normal, width}
  checkpoints: [ { index, position, quaternion, halfExtents, isFinish } ],
  startGrid:   [ { position, quaternion } ],   // >= 8 slots
  respawns:    [ { position, quaternion, checkpointIndex } ],
  pickupPads:  [ { position, quaternion } ],
  aiPath: { nodes: [ { position, width, targetSpeed, jump, shortcutId } ] },
  shortcuts:   [ { id, entry, exit, risk } ],
  props:       [ InteractiveProp ],
  environment: { skybox, fog, sun, ambient, ibl, bounds:Box3, scale },
  audio:       { reverb: {...}, ambienceId }
}
```

Surface ids (canonical, referenced by physics/audio/fx — do not renumber):

| id | name | grip | notes |
|----|------|------|-------|
| 0 | default | 1.00 | fallback |
| 1 | wood | 1.00 | museum floors |
| 2 | carpet | 0.85 | rolling resistance high, muffled |
| 3 | tile | 1.05 | squeaky, shiny |
| 4 | concrete | 1.00 | rough scrape |
| 5 | grass | 0.60 | dust+blades, slow |
| 6 | dirt | 0.70 | big dust plume |
| 7 | gravel | 0.55 | rattly, spray of stones |
| 8 | sand | 0.45 | heavy drag |
| 9 | water_shallow | 0.35 | splash, spray, slow |
| 10 | ice | 0.18 | near-zero grip |
| 11 | metal | 0.95 | sparky, ringing |
| 12 | plastic | 0.90 | toy surfaces |
| 13 | rubber | 1.15 | mats, ramps |
| 14 | glass | 1.02 | reflective |
| 15 | oil_slick | 0.10 | hazard |

### `Car` (vehicle/Car.js) — read by camera, fx, audio, ui, gameplay, ai

This is a **hard contract**: other systems are written against it before the vehicle
code exists. Fields must be present and up to date every frame.

```js
{
  id: 0,                       // stable index, 0..7
  isPlayer: false,
  def: CarDef,                 // { id:'toyeca', name, class:'rookie'|'amateur'|'advanced'|'semi-pro'|'pro'|'super',
                               //   drive:'4wd'|'rwd'|'fwd', mass, topSpeed, accel, weightFront,
                               //   chassis:'plastic'|'glass'|'metal', colorPrimary, colorSecondary }
  body: RigidBody,             // authoritative simulation state
  group: THREE.Group,          // visual root (interpolated — never read for logic)
  wheels: [Wheel x4],          // FL, FR, RL, RR

  // ── live telemetry, updated every fixedUpdate ──
  speed: 0,                    // m/s along forward axis (signed)
  speedKmh: 0,                 // display value, already scaled to feel like a real car
  rpm: 0, gear: 1, engineLoad: 0..1,
  throttle: 0..1, brake: 0..1, steer: -1..1, handbrake: 0..1,
  slipAngle: 0,                // radians, chassis velocity vs heading
  driftFactor: 0..1,           // 0 = gripping, 1 = full slide
  lateralG: 0, longitudinalG: 0,
  wheelsOnGround: 0..4,
  airborne: false, airTime: 0, lastLandImpact: 0,
  upsideDown: false, stuckTime: 0,
  dominantSurfaceId: 0,        // surface under the most-loaded contact patch

  // ── race state, owned by RaceSystem ──
  lap: 0, checkpoint: 0, place: 1, progress: 0,  // progress = laps + fraction of lap, monotonic
  lapTime: 0, bestLap: Infinity, totalTime: 0,
  finished: false, wrongWay: false,

  // ── gameplay, owned by PickupSystem ──
  weapon: null,                // { id, ammo, chargeT } or null
  effects: { boost:0, frozen:0, shielded:0, squashed:0, electro:0, oiled:0 },

  // ── methods ──
  applyControl(inputState),    // AI or player writes desired controls here
  respawn(atCheckpointIndex),
  addImpulse(worldImpulse, worldPoint),
  getForward(out), getRight(out), getUp(out),
  worldPosition(out),          // interpolated visual position
  simPosition(out),            // exact physics position
}
```

`Wheel`:
```js
{
  index, isFront, isLeft, isDriven, isSteered,
  restPosition: Vector3,       // chassis-local suspension anchor
  radius, width,
  compression: 0..1, prevCompression, suspensionForce,
  contact: false, contactPoint: Vector3, contactNormal: Vector3, surfaceId: 0,
  angularVelocity, rotation, steerAngle,
  slipRatio, slipAngle, load, lateralForce, longitudinalForce,
  isSpinning, isLocked, skidIntensity: 0..1,
  mesh: THREE.Object3D
}
```

### `Weapon` (gameplay/weapons/*.js)

```js
{
  id: 'firework', name: 'Firework', icon: 'firework',
  slots: 1, uses: 1, aimMode: 'forward'|'back'|'self'|'target'|'drop',
  weight: (place, carCount) => 0..1,   // pickup roll weighting by race position
  fire(ctx),                            // ctx = { car, game, target, direction }
  update?(dt, state, game),
}
```

### EventBus events (canonical names)

Emit with `game.bus.emit(name, payload)`, listen with `game.bus.on(name, fn)`.

```
'car:collision'      { carId, other, impulse, worldPoint, normal, relSpeed, surfaceId }
'car:wheelContact'   { carId, wheelIndex, surfaceId, slip, load, worldPoint, normal }
'car:airborne'       { carId, duration, height }
'car:land'           { carId, impactSpeed, worldPoint }
'car:respawn'        { carId, position }
'car:drift'          { carId, angle, intensity }   // continuous while drifting
'race:countdown'     { n }            // 3,2,1,0(GO)
'race:start'         {}
'race:lap'           { carId, lap, lapTime, best }
'race:checkpoint'    { carId, index }
'race:position'      { carId, place, prevPlace }
'race:finish'        { carId, place, totalTime }
'race:end'           { results }
'pickup:collected'   { carId, padId }
'pickup:assigned'    { carId, weaponId }
'pickup:used'        { carId, weaponId, targetId }
'weapon:hit'         { carId, sourceId, weaponId, worldPoint, impulse }
'prop:hit'           { propId, impulse, worldPoint }
'ui:screen'          { name }
'camera:shake'       { amount, duration }
'camera:mode'        { mode }
'audio:music'        { intent }       // 'menu'|'race'|'finalLap'|'victory'
```

## Optional contract extensions

Fields a producer MAY supply and a consumer MUST treat as optional. Each one has a
documented fallback, so an absent field degrades a feature — it never breaks a system.
Anything added here must keep that property.

| Field | Producer | Consumer | If absent |
|---|---|---|---|
| `CarDef.exhausts: [[x,y,z], …]` | vehicle | fx | No exhaust puffs. Correct default — these are electric RC cars. |
| `CarDef.nozzles: [[x,y,z], …]` | vehicle | fx | Nitro jet origins synthesized from wheel `restPosition`. |
| `TrackData.environment.weather` | track | fx | Inferred from `environment.skybox` (indoor ⇒ dust motes, outdoor ⇒ pollen). |
| `prop.userData.material: 'metal'\|'glass'` | track | audio | Generic clatter instead of a material-specific impact. |
| `Car.effects.submerged: 0..1` | gameplay | audio | Underwater filter falls back to `dominantSurfaceId === 9`, which works. |

### Fields gameplay adds to `Car` (beyond the Car contract)

`PickupSystem` / `EffectsLayer` write these every fixed step. They are public — the
vehicle sim, FX, renderer and UI are all expected to read them.

| Field | Owner | Meaning |
|---|---|---|
| `effectMods: {grip,torque,steer,brake,maxSpeed,downforce,antiRoll}` | Effects | Handling multipliers, `1` = normal. **The single channel the vehicle sim must read** — do not also read `car.effects` directly, or effects apply twice. |
| `effectVisual: {boost,frost,shield,squash,spark,soak,blind}` | Effects | Eased 0..1 weights for renderer/FX. Never snaps. |
| `shieldCharges: int` | Effects | Hits the bubble still absorbs. `effects.shielded > 0` alone does **not** block. |
| `invulnerable: number` | Respawn | `> 0` blocks weapon damage **without** burning a shield charge. |
| `hasBomb`, `bombFuse` | Bomb | Holder flag + fuse; `bombFuse` mirrors `effects.bomb`. |
| `hazardSurfaceId: number` | PickupSystem | `15` while inside an oil slick. Slicks are published **out of band**, not through the collision mesh, because `addStaticGeometry` is append-only and a slick expires. Grip lookup must be `car.hazardSurfaceId \|\| wheel.surfaceId`. |
| `weapon.{name,icon,ready,rolling,uses,aimMode,dual}` | PickupSystem | Extends the `{id,ammo,chargeT}` contract. **While `ready === false` the `id` is a flickering display value — never act on it.** |

Extra `car.effects` keys beyond the documented six: `blinded`, `soaked`, `bomb`.

### Additional EventBus names

Emitted by core: `game:state {state, prev}`.
Emitted by audio: `audio:mute {muted}`.
Emitted by gameplay: `race:phase`, `race:finalLap`, `race:wrongway`, `race:lapRecord`,
`effect:start`, `effect:end`, `weapon:blocked`, `weapon:spawn`, `weapon:expire`,
`pickup:roll`, `pickup:respawn`, `bomb:attach|transfer|tick|explode|refused`.
Extra fields on canonical events: `pickup:assigned.uses`, `car:respawn.reason`
(`manual|stuck|upsideDown|offTrack|fell`).

**Payload lifetime differs by producer.** Physics event payloads are POOLED (64-entry
ring) — read them synchronously or copy. Gameplay payloads are freshly allocated and
their `worldPoint` is a private clone — listeners may retain them.

### Track requirements

A track needs **≥ 2 checkpoints** (realistically 6+) and a centreline. Degradation:

- No `checkpoints` ⇒ `freeRoam`: countdown and standings still work, but no laps and no finish.
- No `spline` ⇒ falls back to `aiPath.nodes` ⇒ `checkpoints` via closed Catmull-Rom.
  All three absent ⇒ no wrong-way, no off-track, and **no auto-generated pickup pads,
  therefore no weapons at all**.
- Checkpoint `quaternion` **and** spline both absent ⇒ gate direction is meaningless and
  laps never count. This is the one genuinely fragile combination.

`environment.weather` shape:
```js
{ motes: bool, moteStyle: 'dust'|'pollen'|'snow'|'ash', leaves: bool,
  leafColors: [hex, …], godRays: bool, wind: [x,y,z], boxSize: number }
```

Tracks that want the authored look described in their brief should set this explicitly —
"dust motes in shafts of light" in the museum and drifting pollen in the garden are
authored atmosphere, not something the inference can guess well.

## Frame budget (ms, at 1600×900 on iGPU)

| System | budget |
|---|---|
| Physics + vehicles (8 cars, 120 Hz) | 3.0 |
| Track visual update + props | 0.8 |
| FX (particles, marks, decals) | 1.5 |
| Audio | 0.5 |
| UI | 0.7 |
| Render (main + shadow + postfx) | 8.0 |
| **Total** | **~14.5 (budget 16.6)** |

## Ownership map

Do not write outside your directory. Cross-cutting changes go through the interfaces above.

| Directory | Owner system | Responsibility |
|---|---|---|
| `src/core/**` | Core | Game, Loop, Input, EventBus, Config, Assets, math utils, RNG |
| `src/physics/**` | Physics | RigidBody, BVH, collision detection/response, PhysicsWorld |
| `src/vehicle/**` | Cars | Suspension, tires, drivetrain, car bodies, car meshes, AI drivers |
| `src/track/**` | Tracks | Track building, environments, props, surfaces, splines, AI paths |
| `src/gameplay/**` | Gameplay | Race rules, positions, pickups, weapons, projectiles |
| `src/render/**` | Render | Renderer setup, lighting, materials, procedural textures, post-FX |
| `src/fx/**` | FX | Particles, tire marks, sparks, dust, splash, smoke, decals |
| `src/camera/**` | Camera | Chase/cinematic/replay cameras, shake, FOV dynamics |
| `src/audio/**` | Audio | WebAudio graph, engine synth, SFX synth, music, reverb |
| `src/ui/**` | UI | HUD, menus, screens, theming, fonts (canvas-drawn) |

## Quality bar (what "AAA" means here)

- **Cars:** 4 independently sprung wheels, load-sensitive Pacejka-style tire curves,
  weight transfer visible in body roll/pitch/squat, anti-roll bars, aero downforce,
  engine + gearbox + differential, differentiated handling per car class
  (4WD/RWD/FWD, glass/plastic/metal chassis), damage-free but wobbly antenna & suspension
  visuals, correct behaviour in air (limited pitch control like Re-Volt).
- **Tracks:** real verticality (ramps, tables, shelves), at least one shortcut per track,
  interactive scatter props with physics, oversized real-world set dressing so the
  RC scale reads instantly, baked-feel lighting with a moving sun, per-track colour grade.
- **Feel:** the car should be catchable in a slide, punish over-braking, reward
  throttle control, and produce a readable "pop" on jumps. Reset/respawn in < 1 s.
- **Presentation:** chase camera with spring lag + speed FOV, cinematic intro flyby,
  slow-mo on big hits, replay-style finish cam, screen shake proportional to impulse.
- **FX:** persistent tire marks that fade, surface-correct particles, sparks on metal
  scrape, water splash + ripple, dust plumes, exhaust heat shimmer for nitro,
  bloom + motion blur + vignette + film grain + colour grading.
- **Audio:** granular/additive engine synth driven by RPM & load, tire squeal that
  tracks slip angle, surface-dependent rolling noise, doppler for AI cars, impacts
  scaled by impulse, convolution reverb per environment, adaptive music stems.
- **UI:** an actual menu system (main → car select → track select → race → results),
  HUD with speed, position, lap, lap times, pickup slot, minimap, position ladder.

## Debug tooling

`?debug=1` enables the debug overlay (`src/core/Debug.js`): frame graph, physics
wireframes, AI path, telemetry plots. `?track=garden&car=phantom&laps=1` for fast iteration.
Keep debug code behind `if (CONFIG.debug)`.
