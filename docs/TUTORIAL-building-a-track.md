# Tutorial — building a track from nothing

A worked example. By the end you will have a lappable circuit registered in the game,
proven by the headless gate, and you will have seen that gate catch two real mistakes
along the way — which is the part worth learning.

Budget about an hour. You need no browser until the very last step.

**Prerequisites:** read [`ARCHITECTURE.md`](../ARCHITECTURE.md) for units and the data
contract. The [`build-track` skill](../.claude/skills/build-track/SKILL.md) is the
condensed version of everything here; this document is the long-form walkthrough with the
mistakes left in.

---

## 0. The mental model

A track is a **declarative module** that talks to exactly one object: `TrackBuilder`. You
describe geometry; the builder emits merged meshes, one `CollisionMesh` carrying
per-triangle surface ids, and all the race data.

You never import physics, rendering or the game loop. That restriction is what makes a
track **buildable headlessly**, which is what lets `tools/drivability.mjs` prove a lap is
completable in ~200 ms without a GPU.

The single most important number: **1 unit = 1 metre, and the car is 0.30 m long.** The
world is life-size; the car is a toy. A 7 cm lip is a quarter of a car length. Gravity is
−19.6 (deliberately 2g) and top speed is ~9 m/s.

---

## 1. Sketch the centreline

Everything hangs off the centreline — road, checkpoints, grid, respawns, AI path, camera.
Get it right before you build anything you can see.

Nodes are `[x, y, z, halfWidth]`. Node 0 is the start/finish line, and the direction of
travel is toward node 1.

Create `src/track/tracks/rooftop.js`:

```js
import { SurfaceId } from '../Surfaces.js';

const NODES = [
  [0, 0, 20, 2.6],       // 0  ← START / FINISH, heading −Z
  [0, 0, 6, 2.6],        // 1
  [-4, 0, -6, 2.4],      // 2
  [-14, 0, -14, 2.4],    // 3
  [-24, 0, -10, 2.6],    // 4
  [-28, 0, 2, 2.6],      // 5
  [-24, 0, 16, 2.4],     // 6
  [-14, 0, 24, 2.4],     // 7
  [-4, 0, 26, 2.6],      // 8
];
```

Sanity-check the shape before going further: ~130 m of lap at 9 m/s is only ~15 s, which
is far too short. **Aim for 300–350 m — a 45–75 s lap.** Both shipped tracks are ~300 m.
Spread the nodes wider, or add more of them, until the arithmetic works.

A corner's minimum radius matters too. The AI solves corner speed as `sqrt(a_lat / k)`
with a lateral limit around 20 m/s², so a 3 m radius corner is a ~7.7 m/s corner. Corners
tighter than about 2 m are walking pace.

---

## 2. Minimum viable module

Add the export. `id` must match the filename.

```js
export default {
  id: 'rooftop',
  name: 'Rooftop Run',
  difficulty: 'medium',
  laps: 3,
  theme: 'outdoor',        // drives sky, IBL and reverb
  order: 2,                // menu position
  seed: 5150,              // all jitter/scatter derives from this — keep it fixed
  previewColors: [0x6b7280, 0x9ca3af, 0xf59e0b],
  description: 'A lap around the rooftops. Mind the gap.',

  /** @param {import('../TrackBuilder.js').TrackBuilder} b */
  build(b) {
    b.centerline(NODES, { closed: true, samplesPerSegment: 30 });
    b.defaultSurface(SurfaceId.CONCRETE);

    buildRoad(b);
    buildRaceData(b);
  },
};

function buildRoad(b) {
  b.road({
    material: 'concrete/poured',
    surfaceId: SurfaceId.CONCRETE,
    kerb: { width: 0.10, height: 0.035, material: 'concrete/screed' },
    wall: { height: 0.45, thickness: 0.12, material: 'brick/red', side: 'both' },
  });
}

function buildRaceData(b) {
  b.checkpoints({ count: 16, halfWidthPad: 1.6 });
  b.startGrid({ count: 8, columns: 2, rowGap: 2.1, firstBack: 3.6, spread: 0.42 });
  b.respawns({ spacing: 12 });
  b.aiPath({
    spacing: 3.0, topSpeed: 9.0, brake: 12.5, accel: 6.8,
    tyre: 0.58, safety: 0.90, raceLine: true, carHalfWidth: 0.13,
  });
}
```

Note the kerb is **3.5 cm** and the wall **45 cm**. At this scale a kerb you could trip
over is a jump ramp, and a knee-high wall is unclimbable. When a number feels small,
compare it to 0.30 m rather than to a real rooftop.

---

## 3. Register it

`src/track/TrackSystem.js`:

```js
import rooftop from './tracks/rooftop.js';

const BUILTIN = [toyMuseum, garden, rooftop];
```

Nothing else. The registry drives the menu, the gate and the loader.

---

## 4. Run the gate — the inner loop

```bash
node tools/drivability.mjs
```

This is your fast feedback: it builds every registered track and proves each can be
lapped, in about a fifth of a second per track. Run it constantly. A clean result:

```
✓ rooftop   312 m · 1248 stations (0 in declared gaps) · 8104 tris · 8 grid · 21 respawns
✓ every registered track can be lapped
```

What it actually asserts:

- the lap closes — closed spline, seam < 1 mm, monotonic checkpoints
- ground exists within 0.25 m under every non-gap station
- a **±0.45 m corridor** is clear at **0.050 m and 0.104 m** above the line, every 0.25 m
- every grid slot and respawn has ground, sits outside every gap, and has no wall within
  0.16 m of the car's centre

"Blocking" needs a face steeper than 50° **and** facing into travel — so a staircase you
descend is not a wall, while the same staircase upwards is.

---

## 5. Mistake one: a building on the racing line

Add a rooftop plant room:

```js
const PLANT = { x0: -30, x1: -18, z0: -4, z1: 8, h: 3.0 };

function buildPlantRoom(b) {
  const P = PLANT;
  for (const [a, c] of [
    [[P.x0, P.z0], [P.x1, P.z0]],
    [[P.x0, P.z1], [P.x1, P.z1]],
    [[P.x0, P.z0], [P.x0, P.z1]],
    [[P.x1, P.z0], [P.x1, P.z1]],
  ]) {
    b.wall(a, c, { thickness: 0.3, height: P.h, material: 'brick/red',
                   surfaceId: SurfaceId.CONCRETE });
  }
}
```

Gate:

```
✗ rooftop   FAILED — 34 findings
    BLOCKED t 0.5231 (163.2 m) [-28.00, 0.05, 1.86] surface 4, all 5 lanes, 10 probe hits
```

Node 5 is `[-28, 0, 2]` and the plant room spans x −30..−18, z −4..8. **The racing line
runs through the building.** This is exactly how the Back Garden shipped: its start
straight ran inside a solid brick house and lap 1 ended 18 m in, while every other gate
was green.

Two honest fixes. Move the building off the line — usually right, since a wall is more
convincing than a mysterious doorway. Or cut a door, the way the greenhouse does:

```js
const PLANT_DOORS = { z0: -1.2, z1: 5.2 };   // sized from the ROAD extent, not by eye

// west wall in two spans that skip the doorway, plus a lintel over it
b.wall([P.x0, P.z0], [P.x0, PLANT_DOORS.z0], { /* … */ });
b.wall([P.x0, PLANT_DOORS.z1], [P.x0, P.z1], { /* … */ });
b.wall([P.x0, PLANT_DOORS.z0], [P.x0, PLANT_DOORS.z1],
       { y: 2.6, height: P.h - 2.6, /* … */ });   // lintel above head height
```

Size the gap from the **measured** road extent plus ~1.5 m each side. Use
`b.at(t)`/`b.point(t, lateral)` to get the real edge positions rather than guessing —
guessing is how you get a doorway the AI clips on every lap.

---

## 6. Mistake two: a jump nobody can clear

The fun part, and the one the gate **cannot** save you from.

```js
b.jumpGap(b.tNear([-14, 0, 24]), b.tNear([-8, 0, 25.4]), { /* … */ });
```

Gate output:

```
✓ rooftop   312 m · 1248 stations (23 in declared gaps) · …
```

Green — because the gate `continue`s over declared gap stations and has **no ballistic
test**. This is precisely how the Garden shipped a finale that faceplants every lap.

Do the arithmetic yourself, with `g = 19.6`:

```
v  = realistic entry speed  (use ~7 m/s, NOT the 9 m/s top speed — nobody arrives flat out)
vy = v·sin(θ)                       θ = lip angle, positive = nose-up
h  = launch height − landing height
t  = (vy + √(vy² + 2·g·h)) / g
range = v·cos(θ)·t
```

At 7 m/s off a level lip with no drop, range is **0 m** — a level lip with no drop is not
a jump. Give it 6° of nose-up and a 0.4 m drop and you get ≈ 2.1 m. That is your gap
budget, and you should build the gap **shorter** than it.

The Garden's deck jump needs 4.83 m off a **−5.73°** lip — launching *downhill*. At top
speed the car covers 2.64 m. It is short even at 18 m/s, twice any car's top speed.

So: **never author a downhill lip**, size the gap to realistic speed with margin, and
consider `b.kicker(t, opts)`, which exists, carries an AI speed hint, and has never once
been called by a shipped track.

---

## 7. Surfaces and a shortcut worth taking

A shortcut is only a gamble if its surface is worse on **every** channel. Check all four
in `src/track/Surfaces.js` — grip, `rollingResistance`, `drag`, `bumpiness` — not just
grip.

The Garden got this wrong: grass beat gravel on all four *and* on grip, so cutting the
lawn was strictly free and the intended racing line was the slow way round.

A good shortcut is narrower, on a worse surface, with a blind entry or exit — worth about
a second if nailed and costing three if not.

---

## 8. Dress it, then drive it

```js
b.scatter('crate', { count: 14, near: 0.35, spread: 3.2 });
b.line('cone', { from: b.tNear([-24, 0, -10]), to: b.tNear([-28, 0, 2]), spacing: 1.4 });
b.prop('plant_pot', { at: [-20, 0, 12], scale: 1.2 });
b.finishLine(0, { banner: true });
b.pickupRow(b.tNear([-14, 0, -14]), { count: 3, spread: 0.9 });
```

Available prop kinds: `alphabet_block ball block book_stack bush can chess column cone
crate crate_heavy dice dino_skeleton display_case domino flower gnome grass_tuft hedge
marble pencil picture_frame plant_pot rock rocket stanchion tin_bucket watering_can`.

Set dressing is what sells 1:10. The player believes it because a crate is taller than
the car, not because the description says "toy".

Then the full gates, and finally your eyes:

```bash
npm run check                       # suites + lint + contract wiring + drivability
npm run dev
# http://localhost:5173/?skipmenu=1&track=rooftop&debug=1&laps=1
```

**Drive it.** The gate proves a corridor is geometrically clear. It says nothing about
whether corners are takeable at speed, whether the jump lands, or whether the lap is any
good. Every serious defect in this project was found by something that *exercised* the
game — a critic, a browser, a screenshot, a corridor sweep. None came from a green suite.

---

## Checklist

- [ ] 300–350 m lap, 45–75 s
- [ ] `node tools/drivability.mjs` clean
- [ ] `npm run check` PASS
- [ ] Real verticality — the museum has a 10 m ceiling and uses 0.70 m of it
- [ ] One genuine shortcut with a risk/reward tradeoff
- [ ] Every jump's range computed at realistic entry speed, not top speed
- [ ] No downhill lips
- [ ] Nowhere to get permanently stuck — respawn returns the car to the racing line, so
      if the line itself is impassable it loops forever
- [ ] Driven, in a browser, by you

## Where to look next

| | |
|---|---|
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | units, data contracts, EventBus, ownership |
| [`.claude/skills/build-track/`](../.claude/skills/build-track/SKILL.md) | the condensed version of this document |
| [`references/builder-api.md`](../.claude/skills/build-track/references/builder-api.md) | all 57 builder methods, generated from source |
| `src/track/tracks/toy_museum.js` | the fuller worked example — halls, shortcut, ramp, stairs |
| `src/track/tracks/garden.js` | outdoor: water, wind-animated foliage, a greenhouse |
| `tools/drivability.mjs` | the gate itself — read it to know what it does not check |
