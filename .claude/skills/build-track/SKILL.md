---
name: build-track
description: Author a new race track (circuit) for the RC Rumble game, or fix/extend an existing one. Use this whenever the user wants a new track, level, circuit, course or environment for this game — including phrasings like "add a supermarket track", "build a toy store level", "make a night-time garden circuit", "the museum needs a better shortcut", "add verticality to the garden", or "this corner is impossible". Also use it when a track fails `npm run check`'s drivability gate, when a lap cannot be completed, or when a jump cannot be cleared. Track authoring here has a specific shape — declarative module, TrackBuilder-only, headless gate — and several failure modes that have already shipped once each, so reach for this rather than improvising.
---

# Building a track for RC Rumble

A track is a **declarative module** under `src/track/tracks/` that talks to nothing but
`TrackBuilder`. The builder emits merged geometry, a single `CollisionMesh` with
per-triangle surface ids, and all the race data (checkpoints, grid, respawns, pickups,
AI path). You never touch physics, rendering or the game loop.

The reason to work this way: a track that only talks to the builder can be **built
headlessly**, which is what lets `tools/drivability.mjs` prove it can actually be lapped
before anyone opens a browser. One of the two shipped tracks was never lappable — the
start straight ran inside a solid brick house — and every other gate was green while that
was true.

## The loop

1. **Sketch the centreline first**, as an array of `[x, y, z, width]` nodes. Everything
   else hangs off it: the road, checkpoints, grid, respawns, AI path, and the camera.
2. Write the module (shape below) and register it in `src/track/TrackSystem.js` → `BUILTIN`.
3. `node tools/drivability.mjs` — the fast inner loop, a couple of seconds. Fix until clean.
4. `npm run check` — full gates.
5. `npm run dev`, then `?skipmenu=1&track=<id>&debug=1&laps=1`. **Drive it.** The gate
   proves a corridor is clear; it cannot tell you whether a lap is fun.

## Module shape

```js
import { SurfaceId } from '../Surfaces.js';
import * as G from '../GeoLib.js';

const NODES = [
  [-40, 0, 14, 3.2],   // x, y, z, FULL road width (Spline.js:58) — not a half-width.
                       // node 0 is START/FINISH; travel is toward node 1
  [-40, 0, 2, 3.2],
  // …
];

export default {
  id: 'supermarket',            // must match the filename
  name: 'Supermarket Sweep',
  difficulty: 'medium',         // easy | medium | hard
  laps: 3,
  theme: 'indoor',              // indoor | outdoor — drives sky, IBL and reverb
  order: 2,                     // menu position
  seed: 90210,                  // any scatter/jitter is seeded from this; keep it fixed
  previewColors: [0xe8eef4, 0xf0b21e, 0x1e6fbf],   // 3 colours for the menu card
  description: 'One sentence the track-select screen shows.',

  /** @param {import('../TrackBuilder.js').TrackBuilder} b */
  build(b) {
    b.centerline(NODES, { closed: true, samplesPerSegment: 30 });
    b.defaultSurface(SurfaceId.TILE);
    // …geometry…
    b.checkpoints({ count: 20, halfWidthPad: 1.6 });
    b.startGrid({ count: 8, columns: 2, rowGap: 2.1, firstBack: 3.6, spread: 0.42 });
    b.respawns({ spacing: 12 });
    b.pickupRow(b.tNear([x, y, z]), { count: 3, spread: 0.9 });
    b.aiPath({ spacing: 3.0, topSpeed: 9.0, brake: 12.5, accel: 6.8,
               tyre: 0.58, safety: 0.90, raceLine: true, carHalfWidth: 0.13 });
  },
};
```

Split `build()` into named functions (`buildShell`, `buildRoad`, `buildRaceData`…) —
both shipped tracks do, and it keeps a 1000-line file navigable.

## Scale — the thing that goes wrong first

**The world is life-size and the car is a toy.** 1 unit = 1 metre; the car is 0.30 m
long, 0.18 m wide, wheel radius 0.033 m. A museum hall really is 90 m across and its
ceiling really is 10 m up.

So a 4 cm garden hose is a serious obstacle, a kerb is a wall, and a dining chair is
architecture. When something feels wrong, check its size against the car, not against
your mental image of the room. A "small" 7 cm lip is a quarter of the car's length.

Gravity is **−19.6** (deliberately 2g) and top speed is ~9 m/s. Both matter for jumps.

## Builder API

Read `references/builder-api.md` for the full signatures. The shape of it:

| group | methods |
|---|---|
| centreline | `centerline` `at(t)` `point(t,lat,vert)` `advance(t,m)` `tNear(pt)` `lateralNear(pt)` |
| road | `road` `roadWithGaps` `roadUnderside` `stripe` `railing` `patch` |
| structure | `floor` `wall` `room` `bridge` `tunnel` `stairs` |
| air | `ramp` `kicker` `halfPipe` `loop` `jumpGap` |
| dressing | `prop` `scatter` `line` `banner` `finishLine` `decal` `glow` |
| raw | `add` `addAt` `instance` `instanceAt` `addObject` `addCollisionOnly` |
| bounds | `invisibleWall` `blocker` |
| race data | `checkpoints` `startGrid` `respawns` `pickupRow` `aiPath` |
| materials | `mat(name, opts)` `matForSurface(id)` `vcolor` `windMaterial` |
| shortcuts / zones | `shortcut` `shortcutRoad` (optional — omit if your shortcut already has geometry, or you float a ribbon over it) `gripZone` `pickupPads` `defaultSurface` |

Material keys live in **`src/render/ProceduralTextures.js`**, not `Materials.js` — there
are 53 of them and grepping the obvious file finds 16.

`kicker()`, `loop()`, `halfPipe()`, `tunnel()` and `roadWithGaps()` all exist and **have
never been called by a track**. Read that as *unexercised on a real layout — budget for
surprises*, not as *safe*: the track self-test only builds the shipped tracks, so none of
these has ever run in anger. They are still the right tools for verticality, and both
older tracks being flat is a gap worth closing. Measure what they build (see above)
rather than assuming the options mean what they say.

Props available to `prop`/`scatter`/`line`: `alphabet_block ball block book_stack bush
can chess column cone crate crate_heavy dice dino_skeleton display_case domino flower
gnome grass_tuft hedge marble pencil picture_frame plant_pot rock rocket stanchion
tin_bucket watering_can`.

## Surfaces

Use `SurfaceId.*` (see `src/track/Surfaces.js`). The grip column is frozen — physics,
audio and FX all key off these ids.

The trap: a shortcut is only a gamble if its surface is genuinely worse on the channels
that can differ. Note `drag` is **0 for every dry surface**, so indoors three-of-four
(grip, rollingResistance, bumpiness) is the ceiling — do not reach for water or oil just
to satisfy a fourth. Grass once beat gravel on grip *and* rolling resistance *and* drag *and*
bumpiness, so cutting the lawn was strictly free and the intended racing line was the
slow way round. When you place a tempting surface, compare all four numbers, not just grip.

## Failure modes that have already shipped here

Each of these cost real debugging time. The drivability gate now catches most of them —
which is exactly why you should run it before you look at anything.

**A wall across the racing line.** The Garden's house laid solid 16 m brick slabs at
z = −6 and z = +16 while the start straight ran at x = −38, between them. Lap 1 ended
18 m in. If a structure's footprint contains any centreline node, it needs a door —
follow the `GH_DOORS` / `HOUSE_DOORS` pattern: build the wall as spans that skip a gap,
and size the gap from the measured road extent plus ~1.5 m each side, not by eye.

**A ramp that tops out past the thing it climbs.** The museum's display table began at
z = −6.5 but its ramp only reached deck height at z = −1, so 5.5 m of ramp was buried
under the deck and the deck presented a **43.8° face** across the track. That needs
13.57 m/s² to climb; the fastest car has 13.37. Impassable by 0.2 m/s². Make the ramp
top out **at** the deck edge, and put the centreline node there too — the museum's
centreline ran 0.34 m *under* its own ramp, taking the AI path, checkpoint heights,
respawns and the chase camera into the woodwork with it.

**A jump nobody can clear.** The Garden's deck jump needs 4.83 m of flight off a −5.73°
lip; at top speed a car covers 2.64 m. Before authoring a gap, do the arithmetic:

```
launch speed v (≈ 7 m/s realistic, not the 9 m/s top speed — nobody arrives flat out)
vertical   vy = v·sin(θ) + (drop assist)
time aloft t  = (vy + √(vy² + 2·g·h)) / g      with g = 19.6, h = launch height − landing height
range         = v·cos(θ)·t
```

A downhill lip (negative θ) is almost always a mistake. Give the lip a slight nose-up
angle, and size the gap to the range at *realistic* entry speed with margin.

**A start grid floating in space.** `startGrid()` walks slots backwards from the line;
four of the Garden's eight sat 0.40–0.94 m above a declared jump gap. Check there is
7–8 m of solid road behind the finish line before the first hazard, or tighten `rowGap`.

**Checkpoint direction.** If a checkpoint has no `quaternion` *and* the spline is
missing, gate direction is meaningless and laps never count. `checkpoints()` derives
both from the centreline, so this only bites if you hand-author them.

**Texel density.** `b.mat(name)` requests `sizeMeters: 1` by default so texture scale is
consistent everywhere. Override only with a physical reason, and in metres.

## Measuring a built track headlessly

The gate tells you the corridor is clear. It cannot tell you whether your jump lands,
whether your shortcut is actually shorter, or whether the thing you built matches the
thing you designed. **Measure the built `CollisionMesh` — never trust your own numbers.**

This section exists because an author following the rest of this document still shipped a
"jump" that was a step down onto solid ground: they had cut a pit out of the floor and
then laid another slab straight over it. **A declared gap that is not a gap is invisible
to the gate**, exactly like an unclearable one. Raycasting found it in seconds.

Build a track outside the game and probe it:

```js
import { TrackBuilder } from './src/track/TrackBuilder.js';
import { createRayHit } from './src/physics/CollisionMesh.js';
import mytrack from './src/track/tracks/mytrack.js';

const b = new TrackBuilder(null, { id: mytrack.id, seed: mytrack.seed });
mytrack.build(b);
const t = b.build();                       // t.collision, t.spline, t.shortcuts, …
const hit = createRayHit();
```

**Read a jump's real profile** — walk the line in 5 mm steps and raycast down:

```js
for (let x = takeoffX - 0.5; x < landingX + 0.5; x += 0.005) {
  const from = new THREE.Vector3(x, 3, z);
  const y = t.collision.raycast(from, DOWN, 6, hit) && hit.hit ? 3 - hit.distance : null;
  // the last solid y before the drop is your take-off; the first after is your landing
}
```

Then feed the measured take-off, landing and lip angle into the ballistic formula below —
not your design values. A design that said 1.35 m gap / 7.6° lip measured 1.50 m / 3.44°
on the built mesh, because `jumpGap` eases the lip with f² over `lipLength` while loft
stations sit 0.28 m apart. **Every authored lip angle comes out roughly half.**

**Check a shortcut is really shorter:** compare `t.shortcuts[0].length` against the
main-line arc between its `entryT` and `exitT`. A "shortcut" that is longer is scenery.

**Sweep the corridor for margin** rather than accepting the gate's pass/fail: re-run its
corridor check at ±0.45 / 0.60 / 0.75 / 0.90 m and see where your track first goes red.
The header of `tools/drivability.mjs` records the shipped tracks' numbers, so you can
calibrate against them — reproduce that table first to prove your harness is sound.

**Clearances you would otherwise eyeball:** sample the spline every 0.25 m, project each
piece of scenery onto it, and take the minimum. Ten lines, and it replaces the hour that
hand-computing three layout revisions costs.

`estimatedLapSeconds` on the built track gives you the lap-time sanity check.

## What the gate checks — and what it does not

`tools/drivability.mjs` builds every registered track and asserts: the lap closes;
ground exists under every non-gap station; a ±0.45 m corridor is clear at 0.050 m and
0.104 m above the line, every 0.25 m; and every grid slot and respawn has ground, sits
outside every gap, and has no wall within 0.16 m. "Blocking" needs both a face steeper
than 50° and one facing into travel — so a staircase you descend is not a wall, and the
same staircase upwards is.

It does **not** simulate a car. It says nothing about whether corners are takeable at
speed, whether a jump lands, whether dynamic props are in the way, or whether the lap is
any good. It also skips declared gap stations entirely, which is why the unclearable
deck jump survived it.

If you add a check to that file, **prove it red before trusting it**: reintroduce the
defect, watch it fail, restore. Two gates in this repo passed on the exact bug they
guarded — one because leftover JSDoc still mentioned a removed field, one because it
counted triangles *wholly inside* a box and a 16 m wall slab's vertices fell outside.

## Making a lap worth driving

The gate gives you drivable. These give you good:

- **A lap of 45–75 s**, ~300–350 m. Both shipped tracks are ~300 m.
- **Real verticality.** The museum has a 10 m ceiling and uses 0.70 m of it.
- **One genuine shortcut** with a risk/reward tradeoff — narrower, worse surface,
  blind exit, worth roughly a second if nailed and costing three if not.
- **Scale-selling set dressing.** The player believes it is 1:10 because a chair leg is
  taller than the car, not because you said so.
- **Nowhere to get permanently stuck.** Respawn escalation exists, but it returns the
  car to the racing line — if the line itself is impassable, it loops forever.
