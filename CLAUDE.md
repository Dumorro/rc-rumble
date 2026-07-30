# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

RC RUMBLE — an RC-car racing game in the spirit of **Re-Volt (1999)**, in pure Three.js
with 100% procedurally generated assets. ~78k lines, 10 systems.

## Read first

**`ARCHITECTURE.md` is a binding contract, not documentation.** It defines the system
interface, units, the shared data shapes (`InputState`, `RigidBody`, `TrackData`, `Car`,
`Wheel`, `Weapon`), the canonical surface-id table, the EventBus names, the frame budget
and the directory ownership map. `tools/check.mjs` **parses it** and fails the build on
drift, so editing it changes what the gates enforce.

`STATUS.md` is the current verified state. `PROMPT.md` is the original brief.
[`README.md`](README.md) is the overview. To add a circuit, use the **`build-track`
skill** (`.claude/skills/build-track/`) — or read
[`docs/TUTORIAL-building-a-track.md`](docs/TUTORIAL-building-a-track.md) for the
long-form walkthrough with the mistakes left in.

## Commands

```bash
npm run dev      # vite dev server on :5173
npm run build    # production build
npm run check    # THE gate: self-tests + lint + contract wiring + drivability
npm run smoke    # boots the built game in real Chrome and drives it
npm run preview  # serve the build
```

Run one suite directly (much faster than `check`, which runs them sequentially):

```bash
node src/physics/__selftest__.mjs     # 136 assertions, pure maths, no DOM
node src/vehicle/__selftest__.mjs     # incl. the per-car per-surface drift grid
node src/audio/__selftest__.mjs       # drives the real synth on a stubbed AudioContext
node src/track/__selftest__.mjs       # both tracks, built for real
node src/camera/__selftest__.js
node src/gameplay/__selftest__.js
node tools/drivability.mjs            # builds every track, proves it can be lapped
```

Query params: `?debug=1` (exposes `window.GAME`) · `?track=garden` · `?car=phantom` ·
`?laps=1` · `?opponents=0` · `?quality=low` · `?skipmenu=1`

## Architecture

`main.js` registers ten systems on a `Game` in a fixed order that **is** the update
order. Each implements an optional `init/onRaceStart/fixedUpdate/update/lateUpdate/
onRaceEnd/dispose` duck-type and is reachable as `game.<name>`.

`core/Loop.js` runs **physics at a fixed 120 Hz** and renders at vsync, passing an
interpolation `alpha`. So:

- `fixedUpdate(dt)` — `dt` is *always* `CONFIG.physics.fixedDt`. Simulation only.
- `update(dt, alpha)` — visuals. Interpolate from `body.prevPosition/prevQuaternion`;
  never read the render transform back for logic.

Systems never import each other. They talk through `game.<name>` public APIs or
`game.bus`. **EventBus payload lifetime differs by producer** — physics payloads are
pooled in a 64-entry ring (read synchronously or copy), gameplay payloads are freshly
allocated with cloned vectors (safe to retain).

Everything is generated at runtime and memoised on `game.assets` (`texture`, `material`,
`geometry`, `memo`). Tracks are authored as declarative modules under
`src/track/tracks/` that talk only to `TrackBuilder`, which emits merged geometry plus a
single `CollisionMesh` carrying per-triangle surface ids.

## Non-negotiables

1. `three` is the ONLY runtime dependency. No physics libs, no engines, no tween/UI
   libraries. `three/examples/jsm/**` is fine.
2. No pre-made assets. Textures from canvas/noise, geometry from code, audio from
   WebAudio synthesis, glyphs drawn on canvas. No binary data URIs.
3. Plain ESM JavaScript, no TypeScript. JSDoc types welcome.
4. Stay in the directory you own (`ARCHITECTURE.md` → Ownership).
5. The game must always boot. Unfinished features no-op; they never throw.
6. No allocations in `fixedUpdate` or particle updates — use module-level scratch
   `Vector3`/`Quaternion`/`Matrix3`.

## Traps that have cost real time here

**A green suite has never once caught a serious defect in this project.** Every real bug
came from something that *exercised* the game. Prefer a measurement over an argument.

- **Prove a new gate red before trusting it.** Two gates here passed on the exact bug
  they guarded — the contract lint stayed green because leftover JSDoc still mentioned a
  removed field, and a doorway fixture counted triangles *wholly inside* a box, so a 16 m
  wall slab's vertices fell outside and a sealed wall passed. Reintroduce the defect,
  watch it fail, restore.
- **The inert-feature class.** A field written every frame and read by nobody. Five
  shipped (`effectMods`, `hazardSurfaceId`, an engine-synth field name no producer wrote,
  the bomb fuse, a boost loop with no stop). `check.mjs` step 3 catches documented ones;
  it cannot see undocumented ones.
- **Headless browsers lie.** Playwright's default `headless: true` is
  chrome-headless-shell, whose software WebGL schedules rAF at a few hertz — the same
  build reported 4 frames vs 342 under full Chrome. Use `channel: 'chromium'`. Keep one
  `page.evaluate` in flight; overlapping polls queue behind a busy page (track build is
  ~6 s of synchronous work) and turn "slow" into "never answers".
- **Wall-clock assertions flake under load.** Two physics timing assertions measured
  0.94 µs idle and 26.9 µs loaded. They are retried once and demoted to warnings — if you
  see them named in a failure, re-run before chasing a regression.
- **`raycastTrack` reads the mesh from `setTrack()`**, not geometry added via
  `addStaticGeometry()`. A harness that misses this silently rides cars on their chassis
  hulls and reports identical numbers for every surface.
- **`RayHit.normal` is flipped toward the ray origin.** For "is this a wall", use the
  stored plane via `CollisionMesh.triNormal(triIndex)`.
- Known gaps print loudly in yellow and never gate (`CONTRACT_KNOWN_INERT`, the drift
  `KNOWN GAP` banner). A red nobody can fix today trains everyone to ignore reds.

## Feel target

A 1.6 kg toy car at 1:10 scale must feel heavy, floaty and catchable at once. Weight
transfer visible, slides recoverable, jumps arcing readably, chase-camera lag selling the
speed. When "realistic" and "reads like Re-Volt" conflict, pick Re-Volt.

Open work is tracked at https://github.com/Dumorro/rc-rumble/issues/12. A critic pass
scored the shipped experience **4.5/10** against real Re-Volt; three blockers stand —
cars cannot hold a drift on wood, the Garden's deck jump is unclearable, and the renderer
is 40–80% over budget so the quality governor's degraded output is what players see.
