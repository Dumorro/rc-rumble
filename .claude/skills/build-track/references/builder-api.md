# TrackBuilder API

Generated from the JSDoc in `src/track/TrackBuilder.js`. Regenerate rather than
hand-edit.

> **A generator cannot know when the source is lying.** This file once faithfully
> reproduced a `jumpGap` docblock claiming it builds a landing ramp; it does not, and
> because the file presents as "the source talking", the false claim read as more
> authoritative than prose would have. Fix wrong JSDoc at the source, then regenerate.
>
> Known source-vs-name divergences, which live here because no generator can find them:
> `jumpGap` lip eases with f² over `lipLength` against 0.28 m stations, so an authored
> angle comes out roughly half · `GeoLib.polygonXZ` negates z, mirroring polygon floors
> about X · `GeoLib.extrudeOutline` takes an XY outline extruded along Z, so a ramp
> cheek needs rotating into plane · `wall({ skirting })` hardcodes `SurfaceId.WOOD`
> whatever the skirting material · `shortcutRoad` is optional and will float a ribbon
> over your own geometry if your shortcut already has some · `_surfaceHint` falls back
> to `defaultSurface()` headlessly, so AI speeds differ between the audited and the
> driven track.

### `mat(name, opts = null)`

Fetch a catalogue material at the project-wide texel density (UVs are in
metres → `sizeMeters: 1`). Everything in a track should go through here.
@param {string} name catalogue key, e.g. `'wood/parquet'`
@param {object} [opts] forwarded to `MaterialLibrary#get`

### `matForSurface(sid, opts = null)`

Material for a canonical surface id. */

### `vcolor(opts = null)`

Flat vertex-coloured material (props, foliage, painted details). */

### `glow(color = 0xffffff, intensity = 2, opts = null)`

Emissive material (signage, lamps, pickup pads). */

### `decal(opts)`

Decal / sign / banner material. */

### `windMaterial(base, o = null)`

A wind-swayed clone of a material. Registered for per-frame updates.
@param {THREE.Material} base

### `centerline(nodes, opts =`

Define the racing centreline. Nodes may be `[x, y, z, width?, bank?, camber?]`
or `{ p:[x,y,z], w, bank, camber, tag }`.
@param {Array} nodes
@param {object} [opts] see {@link CenterlineSpline}

### `at(t, out = _smp)`

Sample the centreline. Returns a shared scratch — copy if you keep it. */

### `point(t, lateral = 0, vertical = 0, out = new THREE.Vector3())`

World point at a lap fraction with lateral/vertical offsets. */

### `advance(t, metres)`

Lap fraction `metres` further along than `t`. */

### `tNear(point)`

Lap fraction nearest to a world point. Build-time helper — handy for
anchoring props to the racing line.
@param {THREE.Vector3|number[]} point

### `lateralNear(point)`

Signed lateral offset (metres, +right) of a world point from the road. */

### `add(geometry, material, opts =`

Add a geometry to the world.
@param {THREE.BufferGeometry} geometry consumed — do not reuse afterwards
       unless `opts.keepSource` is set (it is cloned for merging anyway).
@param {THREE.Material} material
@param {object} [opts]
@param {THREE.Matrix4} [opts.matrix] world transform
@param {number|null} [opts.surfaceId] `null` ⇒ no collision
@param {boolean} [opts.collide=true]
@param {boolean} [opts.cast=true] cast shadows
@param {boolean} [opts.receive=true] receive shadows
@param {boolean} [opts.decor=false] park under the `decor` group (non-solid)
@param {number} [opts.order] renderOrder for transparent sorting
@param {boolean} [opts.vertexColors]
@param {boolean} [opts.noMerge] give it its own mesh (animated objects)
@returns {THREE.BufferGeometry} the world-space geometry that was stored

### `addAt(geometry, material, position, rotation = null, scale = null, opts =`

Same as {@link add} but with position/rotation/scale instead of a matrix. */

### `instance(key, geometry, material, matrix, opts =`

Register one instance of a repeated prop geometry. All instances sharing
`key` become a single `InstancedMesh`.
@param {string} key
@param {THREE.BufferGeometry} geometry only read on the first call
@param {THREE.Material} material
@param {THREE.Matrix4} matrix
@param {object} [opts] `collide`: false | true | 'box' (cheap AABB hull)

### `instanceAt(key, geometry, material, position, rotation = null, scale = null, opts =`

Convenience wrapper for {@link instance} with TRS arguments. */

### `addObject(obj,`

Attach an already-built Object3D (animated props). Never merged. */

### `addCollisionOnly(geometry, surfaceId = 0, matrix = null)`

Add raw triangles straight to collision without any visual (blockers). */

### `invisibleWall(a, bb, y = 0, height = 1.2, surfaceId = SurfaceId.DEFAULT)`

An invisible wall — the safety net that stops a car leaving the world.
@param {number[]} a `[x, z]` @param {number[]} bb `[x, z]`

### `blocker(center, size, o =`

An invisible solid volume. The workhorse for making a visually complex prop
(a skeleton's legs, a bush, a fence) collide as something simple and cheap.
@param {number[]} center `[x, y, z]` — y is the BOTTOM of the volume
@param {number|number[]} size `s` or `[w, h, d]`

### `road(o =`

Loft the racing surface along the centreline.
@param {object} [o]
@param {number} [o.from=0] @param {number} [o.to=1] lap-fraction range
@param {string} [o.material='concrete/poured'] road material key
@param {number} [o.surfaceId=4]
@param {number} [o.widthScale=1]
@param {number} [o.step=0.85] station spacing in metres
@param {object|false} [o.shoulder] `{ width, drop, material, surfaceId }`
       a strip outside the road edge (grass/gravel run-off)
@param {object|false} [o.kerb] `{ width, height, material, surfaceId }`
       a raised lip at the road edge
@param {object|false} [o.wall] `{ height, thickness, material, surfaceId,
       side:'both'|'left'|'right', inset }` — a solid barrier
@param {object|false} [o.rail] `{ height, radius, material, posts }`
       a see-through railing instead of a wall
@param {object|false} [o.under] `{ depth, material, surfaceId }` — a skirt
       under the ribbon so an elevated road is solid from below
@param {number} [o.centreLine] optional painted centre stripe width

### `stripe(o =`

A flat "runner" laid on top of the road — carpet strips, painted lines,
damp patches. Slightly raised and bevelled at the edges so a wheel cannot
catch on it. `surfaceId: null` makes it a pure decal (no collision), which
is what you want for paint.

### `roadUnderside(o =`

A solid underside + side walls for an elevated stretch of road. */

### `railing(o =`

A see-through railing along the road: two rails plus posts. Collides so a
car bounces off it, but you can see the drop behind it.

### `jumpGap(from, to, o =`

Mark a stretch of the centreline as **air** — no road surface. Used for
jumps: the spline still runs through it (so lap progress and the AI keep
working) but there is nothing to drive on.
Builds a take-off lip only. There is NO landing ramp — this docblock used to
claim one, the generated API reference copied the claim, and an author
trusted it. If you need a landing, build it yourself.
NOTE the lip comes out shallower than you ask for: the rise eases with f^2
over `lipLength` while loft stations sit 0.28 m apart, so the last station
stops short of the full slope. A 7.6 deg design measured 3.44 deg on the
built mesh. Measure the lip off the CollisionMesh rather than trusting the
option — see docs/TUTORIAL-building-a-track.md.

### `isGap(t)`

True if a lap fraction falls inside a declared jump gap. */

### `solidRanges(from = 0, to = 1)`

The t-ranges of the road that are NOT gaps, in order from `from`. */

### `roadWithGaps(o =`

Loft the road but skip every declared jump gap. This is what tracks should
call: `b.roadWithGaps({ … })`.

### `floor(o =`

A flat floor region (a hall floor, a patio, a lawn). Either an axis-aligned
rectangle or an arbitrary polygon.
@param {object} o
@param {number[]} [o.center] `[x, z]`
@param {number[]} [o.size] `[w, d]`
@param {Array<[number,number]>} [o.polygon] world XZ outline (overrides the rect)
@param {Array<Array<[number,number]>>} [o.holes]
@param {number} [o.y=0]
@param {number} [o.rotation] radians about Y (rect only)

### `wall(a, b, o =`

A vertical wall between two XZ points. `both` gives it thickness (a real
slab); otherwise it is a single-sided plane facing left of a→b.

### `room(o =`

A closed room shell: four walls (with optional door gaps), a floor and a
ceiling. The single most useful indoor primitive.
@param {object} o
@param {number[]} o.min `[x, z]` @param {number[]} o.max `[x, z]`
@param {number} [o.height=6]
@param {Array<{side:'n'|'s'|'e'|'w', at:number, width:number, height?:number}>} [o.doors]
       `at` is the world coordinate along the wall's axis

### `ramp(o =`

A ramp between two world points. Automatically fitted: length and pitch come
from the endpoints, and it gets a lead-in wedge so a wheel never hits a step.
@param {object} o
@param {number[]} o.from `[x, y, z]` bottom @param {number[]} o.to `[x, y, z]` top
@param {number} [o.width=2.4]
@param {number} [o.thickness=0.09]
@param {number} [o.lead] length of the ground→foot taper
@param {number} [o.groundY=from.y] ground height at the foot. Only when this
       is BELOW `from.y` is a lead-in wedge built — otherwise the slab's top
       surface already meets the ground and a wedge would be a hump.
@param {object|false} [o.rails] `{ height, material }`

### `kicker(t, o =`

A kicker jump on the road at lap fraction `t`: a short raised wedge across
the racing line. Cars pop off it; nothing can catch on it.

### `halfPipe(o =`

A half-pipe / banked wall: the road's outer edge curls up into a smooth
quarter-circle you can ride.

### `loop(o =`

A stunt loop-the-loop: a full vertical circle of road, entered and exited
tangentially at ground level. Built on its own spline so the main
centreline (and therefore lap progress) is untouched.
@param {object} o
@param {number[]} o.at `[x, y, z]` entry point on the ground
@param {number} o.heading radians — 0 = travelling −Z
@param {number} [o.radius=1.3]
@param {number} [o.width=1.9]
@param {number} [o.lead=2.5] straight lead-in/out length

### `stairs(o =`

A flight of stairs from `from` to `to` (world points). Steps are real
geometry with a solid skirt, so a car can bounce down them but cannot fall
inside.

### `bridge(o =`

A bridge / plank between two world points: a deck with optional kerbs,
solid underneath, plus supports.

### `tunnel(o =`

A tunnel: a lofted half-cylinder shell over a stretch of the road, open at
both ends, dark inside. Collides on the inside so a car can ride the walls.

### `banner(t, o =`

An overhead banner / arch across the road. Two posts and a stretched cloth
with procedurally drawn text.

### `finishLine(t, o =`

A painted start/finish line across the road (chequered, drawn in code).

### `patch(o =`

A ground decal patch (oil, damp, scuff, a sprinkler's wet arc). Purely
visual unless `surfaceId` is given.

### `prop(kind, opts =`

Place a prop from the library. See `Props.js` for the catalogue.
@param {string} kind
@param {object} opts `{ position, rotation, scale, color, dynamic, instanced, … }`

### `scatter(kind, o =`

Scatter `count` copies of a prop inside a rectangle, avoiding the road. */

### `line(kind, o =`

Line props up along a stretch of road at a lateral offset — velvet ropes,
cones marking a chicane, dominoes, hedges.

### `checkpoints(o =`

Generate checkpoints along the centreline. `checkpoints[0]` is the finish.
@param {{count?:number, halfWidthPad?:number, height?:number, depth?:number, finishT?:number}} [o]

### `startGrid(o =`

A staggered start grid behind the finish line. ≥ 8 slots by contract.
Slots are pushed FURTHER BACK past any declared jump gap. `respawns()` has
always nudged forward out of a gap; this did not, and the garden's grid ran
straight off the back of the deck: slots 4–7 sat 0.40 / 0.69 / 0.84 / 0.94 m
above nothing, over the deck jump, so half the field fell out of the world
on the countdown. The nudge has to go backwards, not forwards, or a grid
slot ends up AHEAD of the line it is supposed to start behind — and the
whole grid shifts by the same amount so the stagger is preserved.
@param {{count?:number, rowGap?:number, columns?:number, spread?:number,
         firstBack?:number, lift?:number, finishT?:number}} [o]

### `respawns(o =`

Respawn points every `spacing` metres, each tagged with the checkpoint it
belongs to. Guaranteed to sit on solid road (gaps are skipped forward).

### `pickupRow(t, o =`

A row of pickup pads across the road at lap fraction `t`.
@param {number} t
@param {{count?:number, spread?:number, y?:number, radius?:number}} [o]

### `pickupPads(o =`

Evenly spaced pickup rows around the lap. */

### `shortcut(o =`

A registered shortcut. `nodes` (world points) define its own drivable line;
the builder derives AI nodes for it so the AI can occasionally take it.
@param {object} o
@param {string} o.id
@param {number} o.entryT lap fraction where it leaves the main line
@param {number} o.exitT lap fraction where it rejoins
@param {number} [o.risk=0.5] 0 = free, 1 = suicidal
@param {Array} [o.nodes] centreline nodes for the shortcut path
@param {number} [o.width=1.8]
@param {number} [o.savedMetres] how much shorter it is (informational)

### `shortcutRoad(sc, o =`

Loft a shortcut's road surface using its own spline. Call after
{@link shortcut}.

### `aiPath(o =`

Build the AI path from the centreline: a node every `spacing` metres with a
curvature-derived target speed, then a two-pass braking/acceleration solve
so the speeds are actually reachable.
@param {{spacing?:number, topSpeed?:number, brake?:number, accel?:number,
         tyre?:number, safety?:number, raceLine?:boolean}} [o]

### `defaultSurface(sid)`

Tell the AI-path builder what the road is mostly made of. */

### `environment(desc)`

Store the render-system environment descriptor. */

### `audio(desc)`

Store the audio descriptor (reverb + ambience). */

### `gripZone(o =`

A grip-modifying zone the vehicle system may optionally sample (a
sprinkler's wet arc, a patch of spilled oil that is animated). The baked
collision surface id remains the authoritative source; this is an extra.

### `build()`

@returns {object} TrackData, exactly the ARCHITECTURE.md shape. */
