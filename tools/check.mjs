#!/usr/bin/env node
/**
 * RC RUMBLE — repo check. `npm run check`
 *
 *   1. Runs every `src/**\/__selftest__.{mjs,js}` suite, SEQUENTIALLY.
 *   2. Lints the source tree for the project's hard rules.
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

// ─────────────────────────────────────────────────────────── run

console.log(C.bold('\nRC RUMBLE — repo check'));
console.log(C.dim(`${ALL_FILES.length} source files under src/`));

const suites = runSuites();
const violations = runLint();

const ok = suites.failed === 0 && violations === 0;

console.log(C.bold('\n▸ Summary\n'));
console.log(`  self-tests  ${suites.totalPass} passed, ${suites.totalFail} failed  ${C.dim(`(${suites.count} suites)`)}`);
console.log(`  lint        ${violations} violation${violations === 1 ? '' : 's'}`);
console.log(ok ? C.green('\n  PASS\n') : C.red('\n  FAIL\n'));

process.exit(ok ? 0 : 1);
