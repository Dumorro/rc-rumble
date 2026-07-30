# The prompt that started this project

Verbatim, as given at the start of the session that produced this repository.

---

I want you to build a fully playable RC car racing game that clones the spirit, physics, track design and fun of the classic Re-Volt (1999), pushed to modern AAA quality.

It should feature:
- Highly detailed RC cars with realistic suspension, tire physics, drifts, jumps and weight transfer
- Multiple tracks inspired by Re-Volt’s iconic environments (toy museum, garden, supermarket, etc.) with verticality, shortcuts and interactive objects
- Power-ups, weapons, pickups and chaotic multiplayer-style racing feel
- Dynamic camera that feels like classic Re-Volt (chase + cinematic moments)
- Fully procedural or high-quality generated visuals, particle effects, tire marks, sparks, dust, water splash, etc.
- Synthesized or high-quality engine sounds, collisions, power-up effects and music-ready structure

Everything must be utterly perfect and visually beautiful, with AAA-level polish in every system (textures, lighting, physics, audio, UI, particle systems, track details).

Fan out sub-agents and have sub-agents tackle each major system individually (cars & physics, tracks & environment, power-ups & combat, camera & presentation, audio, effects, UI, overall game feel). You should /loop on each item and have a separate sub-agent act as a really harsh critic that visually and mechanically compares the result side-by-side (blind) against real Re-Volt gameplay footage and modern high-end RC racing games. If the critic is not utterly wowed and does not prefer your version, keep iterating.

Do this entirely in Three.js (no external game engines or pre-made assets). /loop until it's utterly perfect. Fan out sub-agents and ultracode.

---

## What it produced

~78k lines across 10 systems, `three` as the only runtime dependency, and zero
pre-made assets — every texture, mesh, sound and glyph is generated in code.

The harsh critic was built as specified: three agents researched real Re-Volt and
modern racers to produce a testable rubric, four graded the source against it, and
one synthesised and spot-checked the findings. Its verdict:

> **4.5 / 10. Would a Re-Volt fan prefer this build? No — not today, and not close.**
> "The underlying engineering is an 8. The shipped experience is a 4.5."

That verdict, and the work remaining to answer it, is tracked in
[the roadmap](https://github.com/Dumorro/rc-rumble/issues/12). The instruction to
loop until the critic prefers our version has **not** been satisfied.

See `STATUS.md` for the verified state and `ARCHITECTURE.md` for the contract.
