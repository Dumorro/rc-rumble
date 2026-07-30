#!/usr/bin/env node
/**
 * RC RUMBLE — repo check. `npm run check`
 *
 *   1. Runs every `src/**\/__selftest__.{mjs,js}` suite, SEQUENTIALLY.
 *   2. Lints the source tree for the project's hard rules.
 *   3. Checks that every field in the ARCHITECTURE.md data contracts is
 *      actually WIRED UP — see `runContractCheck`.
 *
 * Suites run one at a time on purpose: the physics suite has load-sensitive
 * timing assertions (e.g. "a suspension raycast costs under 5 us") that flake
 * when another suite is competing for the CPU. A flaky red is worse than a
 * slower green.
 *
 * Node-only. No dependencies. Exits non-zero if anything fails.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ─────────────────────────────────────────────────────────── walk

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ALL_FILES = walk(SRC).filter((f) => ['.js', '.mjs'].includes(extname(f)));
const rel = (f) => relative(ROOT, f);
const isSelfTest = (f) => /__selftest__\.(mjs|js)$/.test(f);

// ─────────────────────────────────────────────────────────── 1. suites

function runSuites() {
  const suites = ALL_FILES.filter(isSelfTest).sort();
  console.log(C.bold(`\n▸ Self-tests (${suites.length} suites, sequential)\n`));

  let failed = 0;
  let totalPass = 0;
  let totalFail = 0;

  for (const suite of suites) {
    const t0 = Date.now();
    const res = spawnSync(process.execPath, [suite], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
    });
    const ms = Date.now() - t0;
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    // Suites print "N passed, M failed" as their last meaningful line.
    const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/i);
    const pass = m ? Number(m[1]) : 0;
    const fail = m ? Number(m[2]) : 0;
    totalPass += pass;
    totalFail += fail;

    const ok = res.status === 0 && fail === 0;
    if (!ok) failed++;

    const tally = m ? `${pass} passed, ${fail} failed` : C.yellow('no tally reported');
    console.log(`  ${ok ? C.green('✓') : C.red('✗')} ${rel(suite).padEnd(34)} ${tally} ${C.dim(`${ms} ms`)}`);

    if (!ok) {
      // Show only the failure section, not the whole run.
      const lines = out.split('\n');
      const start = Math.max(0, lines.findIndex((l) => /failures?:/i.test(l)));
      console.log(C.dim(lines.slice(start || -25).join('\n').trimEnd()));
      if (res.error) console.log(C.red(`    spawn error: ${res.error.message}`));
    }
  }

  return { failed, totalPass, totalFail, count: suites.length };
}

// ─────────────────────────────────────────────────────────── 2. lint

/**
 * The project's hard rules, as greps. Each rule reports file:line so a failure
 * is actionable without hunting.
 */
const RULES = [
  {
    name: 'only "three" and relative paths may be imported',
    test(src) {
      const hits = [];
      // Match only the specifier itself. A cross-line `[\s\S]*?` here will
      // happily leap over unrelated code to find a later `from '…'` and report
      // a bogus hit — the specifier is the only part we actually need.
      const re = /\bfrom\s*['"]([^'"\n]+)['"]|^\s*import\s+['"]([^'"\n]+)['"]/gm;
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1] ?? m[2];
        const okBare = spec === 'three' || spec.startsWith('three/');
        const okRel = spec.startsWith('./') || spec.startsWith('../');
        const okNode = spec.startsWith('node:');   // self-tests only, checked below
        if (!okBare && !okRel && !okNode) {
          hits.push({ line: lineOf(src, m.index), text: spec });
        }
      }
      return hits;
    },
  },
  {
    name: 'no node: builtins outside self-tests (browser code)',
    skip: isSelfTest,
    test(src) {
      const hits = [];
      const re = /from\s*['"](node:[^'"]+)['"]/g;
      let m;
      while ((m = re.exec(src))) hits.push({ line: lineOf(src, m.index), text: m[1] });
      return hits;
    },
  },
  {
    name: 'no remote asset URLs',
    test(src) {
      const hits = [];
      // Ignore URLs inside comments/docs — only flag ones in code-ish positions.
      const re = /['"`](https?:\/\/[^'"`\s]+)['"`]/g;
      let m;
      while ((m = re.exec(src))) {
        const url = m[1];
        // XML/GLSL namespaces and spec links are not assets.
        if (/w3\.org|khronos\.org|opengl\.org|schema\.org/.test(url)) continue;
        hits.push({ line: lineOf(src, m.index), text: url });
      }
      return hits;
    },
  },
  {
    name: 'no embedded binary assets (base64 data URIs)',
    test(src) {
      const hits = [];
      const re = /data:(?:image|audio|video|font|application)\/[a-z0-9.+-]+;base64,/gi;
      let m;
      while ((m = re.exec(src))) hits.push({ line: lineOf(src, m.index), text: m[0] });
      return hits;
    },
  },
  {
    name: 'no stray scratch files',
    fileTest: (f) => /(?:^|\/)(?:__s\d+|__scratch__|scratch|tmp|temp)\.(?:m?js)$/.test(f),
  },
  {
    name: 'no leftover focused/skipped test markers',
    test(src) {
      const hits = [];
      const re = /\b(?:describe|it|test)\.(?:only|skip)\b/g;
      let m;
      while ((m = re.exec(src))) hits.push({ line: lineOf(src, m.index), text: m[0] });
      return hits;
    },
  },
];

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function runLint() {
  console.log(C.bold('\n▸ Lint\n'));
  let violations = 0;

  for (const rule of RULES) {
    const found = [];

    for (const file of ALL_FILES) {
      if (rule.skip?.(file)) continue;

      if (rule.fileTest) {
        if (rule.fileTest(file)) found.push({ file, line: 0, text: '' });
        continue;
      }

      const src = readFileSync(file, 'utf8');
      for (const hit of rule.test(src)) found.push({ file, ...hit });
    }

    if (found.length === 0) {
      console.log(`  ${C.green('✓')} ${rule.name}`);
    } else {
      violations += found.length;
      console.log(`  ${C.red('✗')} ${rule.name} ${C.dim(`(${found.length})`)}`);
      for (const f of found.slice(0, 12)) {
        console.log(C.dim(`      ${rel(f.file)}${f.line ? `:${f.line}` : ''}  ${f.text}`));
      }
      if (found.length > 12) console.log(C.dim(`      … and ${found.length - 12} more`));
    }
  }

  return violations;
}


// ─────────────────────────────────────────── 3. contract wiring

/**
 * The bug class this project keeps producing: a feature that is fully built and
 * fully INERT. Three shipped before this check existed —
 *
 *   `car.effectMods`      seven handling multipliers, recomputed every step by
 *                         gameplay, read by nobody. Five of seven status
 *                         effects therefore did nothing at all.
 *   `car.hazardSurfaceId` oil slicks published surface id 15 out-of-band; the
 *                         vehicle grip lookup never read it, so oil was not
 *                         slippery.
 *   engine synth          read a CarDef field name no producer ever wrote.
 *
 * — and each cost real time to find by inspection. They share one shape, and it
 * is mechanical rather than a judgement call: a name in the ARCHITECTURE.md
 * contracts that only ever appears in ONE top-level `src/` directory is either a
 * producer nobody consumes or a consumer nobody produces. A contract exists to
 * be crossed; a field that never leaves its own system is not participating in
 * one.
 *
 * Deliberately NOT a write-vs-read analysis. Classifying `Object.assign(car.mods,
 * …)` or `car.mods ??= {}` correctly needs real parsing, and getting it wrong in
 * either direction makes the rule untrustworthy. "Referenced from two different
 * directories" needs no parsing and catches all three fixtures above.
 *
 * Known limits, stated so nobody over-trusts it: a field whose name is a common
 * word (`id`, `name`, `position`) matches everywhere and is effectively
 * unchecked — this rule produces false NEGATIVES there, never false positives.
 */

/** Words that appear on the VALUE side of a contract line, not field names. */
const CONTRACT_NOISE = new Set([
  'true', 'false', 'null', 'undefined', 'Infinity', 'NaN',
  'THREE', 'Vector3', 'Quaternion', 'Matrix3', 'Box3', 'Group', 'Object3D',
  'RigidBody', 'CollisionMesh', 'CenterlineSpline', 'SurfaceTable', 'CarDef',
  'Wheel', 'InteractiveProp', 'bool', 'number', 'string', 'int',
]);

/**
 * Fields that legitimately live in one directory.
 *
 * Every entry MUST carry a justification. An entry without one fails the lint —
 * the allowlist is where "this is genuinely internal" gets distinguished from
 * "I could not be bothered to wire it up", and an unexplained exemption is
 * indistinguishable from the bug.
 */
const CONTRACT_ALLOW = {
  invInertiaWorld:
    'Solver working state. Consumers use applyInvInertia()/pointVelocity(), never the matrix.',
  prevQuaternion:
    'Interpolation snapshot. Consumers read it through getInterpolatedQuaternion() and '
    + 'applyToObject3D(alpha), which is the supported API; the raw field is physics-internal.',
  prevPosition:
    'Same as prevQuaternion — consumed via getInterpolatedPosition()/applyToObject3D(alpha).',
  applyControl:
    'Both callers live in src/vehicle by design: CarSystem routes player input and AIDriver '
    + 'drives the CPU cars. The contract documents it so other systems COULD drive a car, not '
    + 'because one currently does.',
  uses:
    'Dead bookkeeping, verified harmless. Written at PickupSystem.js:280/316/411 and read '
    + 'nowhere; `ammo` is the live field and is what the HUD renders (PickupSlot.js:64,155). '
    + 'Nothing is missing — `uses` is a redundant copy, not an unwired feature.',
  hasBomb:
    'Genuinely read, single-directory: it is the hand-off guard that stops the bomb being '
    + 'passed to a car that already holds one (Bomb.js:90,93,99,188). A false positive of the '
    + '2-directory heuristic, not a gap in the code.',
};

/**
 * REAL DEFECTS the rule caught that this agent cannot fix from its own scope.
 *
 * These are NOT exemptions. Each one is a producer with no consumer — the exact
 * class of bug this rule exists to find. They are held here instead of in
 * CONTRACT_ALLOW so that `npm run check` prints them loudly on every run rather
 * than passing in silence, while still leaving the gate green so unrelated work
 * is not blocked by a defect its author did not introduce.
 *
 * Delete an entry the moment it is wired up. Do not add one to quiet a failure.
 */
const CONTRACT_KNOWN_INERT = {
  bombFuse:
    'BOMB FUSE COUNTDOWN IS INERT. `car.bombFuse` is written every frame '
    + '(Bomb.js:166,274) and read by nothing; so is `car.effects.bomb` (Bomb.js:167,275), '
    + 'whose key is not even in Effects.EFFECT_KEYS. `bomb:tick` is emitted at an '
    + 'accelerating 1.4→10.9 Hz cadence carrying {carId, fuse, urgency} (Bomb.js:210) and has '
    + 'no subscriber. AudioSystem.startBombTick/updateBombTick/stopBombTick (AudioSystem.js:'
    + '840-851) are fully implemented over a `bomb/tick` sample and are called only by the '
    + 'audio selftest. Net effect: the hot-potato bomb has no HUD countdown and makes no '
    + 'ticking sound — the player gets a "BOMB ON BOARD!" toast, an in-world spark/glow on '
    + 'the bomb mesh, then "BOOM". Fix is in src/ui + src/audio, which this agent does not own.',
};

/**
 * Field names from the ARCHITECTURE.md contracts. Two sources, deliberately:
 *
 *  1. the ```js fences under a `### `Name`` heading (Car, Wheel, RigidBody, …);
 *  2. the first column of the tables under `### Fields <system> adds to <X>`,
 *     which the document itself describes as public and "expected to be read".
 *
 * The table under `## Optional contract extensions` is EXCLUDED on purpose: that
 * section defines fields a producer MAY supply, each with a documented fallback,
 * so an unconsumed one is a documented degradation rather than a defect. Both of
 * the real fixtures (`effectMods`, `hazardSurfaceId`) live in source 2 — a fence
 * -only parser silently missed the exact bugs that motivated this rule.
 */
function contractFields(md) {
  const out = new Map();                       // field → contract name
  const addFence = (contract, body) => {
    const clean = body.replace(/\/\/[^\n]*/g, '');            // strip line comments
    for (const f of clean.matchAll(/\b([A-Za-z_]\w*)\s*[:(]/g)) {
      if (!CONTRACT_NOISE.has(f[1])) out.set(f[1], contract);
    }
    // Bare identifier lists — `index, isFront, isLeft,` — lines with no `:`/`(`.
    for (const line of clean.split('\n')) {
      if (line.includes(':') || line.includes('(')) continue;
      for (const part of line.split(',')) {
        const t = part.trim();
        if (/^[A-Za-z_]\w*$/.test(t) && !CONTRACT_NOISE.has(t)) out.set(t, contract);
      }
    }
  };

  // 1. `### `Name`` sections and their code fences.
  const secRe = /^###\s+`(\w+)`[^\n]*\n([\s\S]*?)(?=^#{2,3}\s|\Z)/gm;
  let m;
  while ((m = secRe.exec(md))) {
    for (const fence of m[2].matchAll(/```(?:js)?\n([\s\S]*?)```/g)) addFence(m[1], fence[1]);
  }

  // 2. `### Fields <system> adds to <X>` tables — public, must be consumed.
  const tabRe = /^###\s+Fields\s+[^\n]*?adds to\s+`?(\w+)`?[^\n]*\n([\s\S]*?)(?=^#{2,3}\s|\Z)/gm;
  while ((m = tabRe.exec(md))) {
    const contract = m[1];
    for (const row of m[2].split('\n')) {
      if (!row.startsWith('|') || /^\|[\s-]+\|/.test(row)) continue;   // skip separators
      const first = row.split('|')[1] ?? '';
      for (const tick of first.matchAll(/`([^`]+)`/g)) {
        for (const id of tick[1].matchAll(/[A-Za-z_]\w*/g)) {
          if (!CONTRACT_NOISE.has(id[0])) out.set(id[0], contract);
        }
      }
    }
  }
  return out;
}

function runContractCheck(files) {
  console.log(C.bold('\n▸ Contract wiring\n'));
  const md = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
  const fields = contractFields(md);

  // field → set of top-level src/ directories that mention it
  const seen = new Map();
  const sources = files.filter((f) => !isSelfTest(f));
  // Comments are stripped before matching. A field named only in a docblock is
  // NOT wired up — and a leftover comment is exactly what a half-removed
  // integration leaves behind, so counting them lets the rule be defeated by the
  // very debris the bug produces. Found while validating: three `effectMods`
  // mentions survived in JSDoc after the reads were removed, and the rule stayed
  // green until this strip was added.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const cache = sources.map((f) => ({
    dir: relative(SRC, f).split('/')[0],
    src: stripComments(readFileSync(f, 'utf8')),
  }));

  for (const [field] of fields) {
    const re = new RegExp(`\\b${field}\\b`);
    const dirs = new Set();
    for (const c of cache) if (re.test(c.src)) dirs.add(c.dir);
    seen.set(field, dirs);
  }

  const bad = [];
  for (const [field, contract] of fields) {
    if (CONTRACT_ALLOW[field] || CONTRACT_KNOWN_INERT[field]) continue;
    const dirs = seen.get(field);
    if (dirs.size === 0) bad.push({ field, contract, dirs, why: 'never referenced in src/' });
    else if (dirs.size === 1) bad.push({ field, contract, dirs, why: `only in src/${[...dirs][0]}/` });
  }

  // An entry with no justification is itself a violation — in either list.
  const unjustified = [
    ...Object.entries(CONTRACT_ALLOW),
    ...Object.entries(CONTRACT_KNOWN_INERT),
  ].filter(([, why]) => typeof why !== 'string' || why.trim().length < 10).map(([f]) => f);

  console.log(C.dim(`  ${fields.size} contract fields parsed from ARCHITECTURE.md`));
  if (bad.length === 0) console.log(`  ${C.green('✓')} every contract field is referenced from 2+ systems`);
  else {
    console.log(`  ${C.red('✗')} contract fields that never cross a system boundary ${C.dim(`(${bad.length})`)}`);
    for (const b of bad.slice(0, 20)) {
      console.log(C.dim(`      ${b.contract}.${b.field}  —  ${b.why}`));
    }
    if (bad.length > 20) console.log(C.dim(`      … and ${bad.length - 20} more`));
  }
  if (unjustified.length) {
    console.log(`  ${C.red('✗')} allowlist entries without a justification: ${unjustified.join(', ')}`);
  }

  // Known-inert features are printed in full, every run. They do not fail the
  // gate, but they are never allowed to go quiet either.
  const inert = Object.entries(CONTRACT_KNOWN_INERT);
  if (inert.length) {
    console.log(`  ${C.yellow('!')} ${C.bold(`KNOWN INERT FEATURES (${inert.length}) — built, documented, unwired`)}`);
    for (const [field, why] of inert) {
      console.log(C.yellow(`      ${field}: ${why}`));
    }
  }
  return bad.length + unjustified.length;
}

// ─────────────────────────────────────────────────────────── run

console.log(C.bold('\nRC RUMBLE — repo check'));
console.log(C.dim(`${ALL_FILES.length} source files under src/`));

const suites = runSuites();
const violations = runLint();
const contractGaps = runContractCheck(ALL_FILES);

const ok = suites.failed === 0 && violations === 0 && contractGaps === 0;

console.log(C.bold('\n▸ Summary\n'));
console.log(`  self-tests  ${suites.totalPass} passed, ${suites.totalFail} failed  ${C.dim(`(${suites.count} suites)`)}`);
console.log(`  lint        ${violations} violation${violations === 1 ? '' : 's'}`);
console.log(ok ? C.green('\n  PASS\n') : C.red('\n  FAIL\n'));

process.exit(ok ? 0 : 1);
