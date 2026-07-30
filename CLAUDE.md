# RC RUMBLE — agent brief

A AAA-polish RC-car racing game in the spirit of **Re-Volt (1999)**, written in
**pure Three.js** with **100% procedurally generated assets**.

## Read first

**`ARCHITECTURE.md` is the contract.** Read it before writing a line. It defines the
system interface, coordinate system/units, shared data shapes (`InputState`,
`RigidBody`, `TrackData`, surface ids), the canonical EventBus names, the frame
budget, and who owns which directory.

## Non-negotiables

1. `three` is the ONLY runtime dependency. No physics libs, no engines, no tween/UI libs.
   `three/examples/jsm/**` is fine.
2. No pre-made assets of any kind. Generate textures (canvas/noise), geometry, audio
   (WebAudio synthesis) and fonts (canvas-drawn) in code. No binary data URIs.
3. Plain ESM JavaScript. No TypeScript. JSDoc types welcome.
4. Stay inside the directory you own. Cross-system communication goes through the
   documented interfaces or `game.bus`.
5. `npm run build` must stay green and the game must always boot. Unfinished features
   no-op; they never throw.
6. No allocations in hot paths (`fixedUpdate`, particle updates). Use module-level
   scratch `Vector3`/`Quaternion`/`Matrix3` objects.

## Commands

```bash
npm run dev      # vite dev server on :5173
npm run build    # production build — must pass
npm run preview  # serve the build
```

Useful URLs while iterating:
`?debug=1` · `?track=garden` · `?car=phantom` · `?laps=1` · `?quality=low` · `?skipmenu=1`

## Feel target

Re-Volt's magic is that a 1.6 kg toy car on a 1:10 scale track feels *heavy, floaty and
catchable* at the same time. Weight transfer must be visible, slides must be
recoverable, jumps must arc readably, and a chase camera lag must sell the speed.
When a tuning choice is between "realistic" and "reads like Re-Volt", pick Re-Volt.
