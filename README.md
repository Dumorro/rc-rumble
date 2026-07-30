# RC RUMBLE

An RC-car racing game in the spirit of **Re-Volt (1999)** — tiny radio-controlled cars
racing through oversized real-world environments, with real suspension physics, weight
transfer, pickups and a chase camera that sells the speed.

Built in **pure Three.js** with **100% procedurally generated assets**. There is not a
single texture, model, sound or font file in this repository. Every material is painted
on a canvas from noise, every mesh is generated from primitives, every sound is
synthesised in WebAudio, and every glyph is drawn as vector paths. `three` is the only
runtime dependency.

~78k lines across 10 systems, including a custom rigid-body physics engine.

```bash
npm install
npm run dev     # http://localhost:5173
```

Arrow keys or WASD to drive, Space handbrake, Ctrl/F to fire, C to change camera,
R to respawn, H horn, M mute.

## Status

The game is playable end to end: menus → car select → track select → an 8-car race with
weapons → results. Two tracks, eight cars, ten weapons.

It is **not finished**, and the gap is documented rather than hidden. A harsh critic pass
that researched real Re-Volt, built a testable rubric and graded the source against it
scored the shipped experience:

> **4.5 / 10. Would a Re-Volt fan prefer this build? No — not today, and not close.**
> "The underlying engineering is an 8. The shipped experience is a 4.5."

Three blockers stand: cars cannot hold a drift on wood, the Garden's deck jump is
unclearable, and the renderer is 40–80% over frame budget so the quality governor's
degraded output is what most players see. See the
[roadmap](https://github.com/Dumorro/rc-rumble/issues/12).

[`STATUS.md`](STATUS.md) is the verified state — what has actually been measured, in a
browser, versus what is merely asserted by a test.

## Commands

```bash
npm run dev      # vite dev server on :5173
npm run build    # production build
npm run check    # THE gate: self-tests + lint + contract wiring + drivability
npm run smoke    # boots the built game in real Chrome and drives it
npm run preview  # serve the build
```

Run one suite directly — much faster than `check`, which runs them sequentially:

```bash
node src/physics/__selftest__.mjs    # 136 assertions, pure maths, no DOM
node src/vehicle/__selftest__.mjs    # incl. the per-car per-surface drift grid
node src/audio/__selftest__.mjs      # drives the real synth on a stubbed AudioContext
node src/track/__selftest__.mjs
node src/camera/__selftest__.js
node src/gameplay/__selftest__.js
node tools/drivability.mjs           # builds every track, proves it can be lapped
```

Query params: `?debug=1` (exposes `window.GAME`) · `?track=garden` · `?car=phantom` ·
`?laps=1` · `?opponents=0` · `?quality=low` · `?skipmenu=1`

## Documentation

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | **The contract.** Units, system interface, shared data shapes, surface ids, EventBus names, frame budget, directory ownership. `tools/check.mjs` parses it, so editing it changes what the build enforces. |
| [`STATUS.md`](STATUS.md) | Verified state — measured, not assumed |
| [`CLAUDE.md`](CLAUDE.md) | Orientation for coding agents, including the traps that cost real time |
| [`docs/TUTORIAL-building-a-track.md`](docs/TUTORIAL-building-a-track.md) | Build a circuit from nothing, with the mistakes left in |
| [`.claude/skills/build-track/`](.claude/skills/build-track/SKILL.md) | Skill for authoring tracks — the condensed tutorial |
| [`PROMPT.md`](PROMPT.md) | The original brief this was built from |

## How it fits together

`main.js` registers ten systems on a `Game` in an order that **is** the update order.
`core/Loop.js` runs physics at a fixed **120 Hz** and renders at vsync with an
interpolation factor, so `fixedUpdate` is simulation-only and `update` interpolates from
the previous physics transform.

Systems never import each other — they communicate through `game.<name>` public APIs or
the EventBus. Tracks are declarative modules that talk only to `TrackBuilder`, which is
what allows them to be built headlessly and proven lappable without a GPU.

```
core/      Game, fixed-step Loop, EventBus, Input, Config, procedural asset cache
physics/   custom rigid bodies, BVH, sequential-impulse solver, CCD
vehicle/   suspension, Pacejka-style tyres, drivetrain, 8 procedural cars, AI
track/     TrackBuilder + declarative track modules
gameplay/  race rules, pickups, 10 weapons, status effects
render/    pipeline, CSM shadows, procedural sky/IBL, PBR texture generation, post-FX
fx/        pooled particles, tyre marks, decals, sparks, splash
audio/     WebAudio engine synth, tyre/surface audio, 70 one-shots, adaptive music
camera/    chase, cinematic, finish, shake
ui/        menus, HUD, minimap, results
```

## Testing philosophy

Worth stating plainly, because it shaped the whole project:

**A green suite has never once caught a serious defect here.** Every real bug was found
by something that *exercised* the game — a critic reading source against a Re-Volt
rubric, an agent driving in a browser, a screenshot, a headless corridor sweep.

Three examples, all of which shipped while every test was green:

- One of two tracks had **never been lappable** — the start straight ran inside a solid
  brick house.
- The tyre model's friction ellipse was **arithmetically inert**: a fully locked tyre
  kept 87% of its cornering force, so the handbrake stopped the car instead of rotating
  it.
- An airborne suspension force added **18–25% to gravity** and pitched cars up to 20×
  harder than the player could counter — so the same ramp threw every car a different
  distance, for a reason no level designer could have seen.

Two rules came out of that, and both are enforced:

1. **Prove a gate red before trusting it.** Two gates here passed on the exact bug they
   guarded — one because leftover JSDoc still mentioned a removed field, one because it
   counted triangles *wholly inside* a box and a 16 m wall's vertices fell outside.
2. **Known gaps print loudly and never gate.** A red nobody can fix today trains everyone
   to ignore reds.

## Licence

MIT.
