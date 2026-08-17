#!/usr/bin/env node
/**
 * detect-cantfail-tests.js — tests that cannot fail read as green forever.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A test body with no reachable assertion can only fail via an unhandled
 * exception. It inflates the coverage count, turns the suite's green into
 * noise, and — worse — reads to every future agent as evidence the behavior
 * is protected when nothing is. Both source repos hit this independently:
 * lifelift-mobile-backend found a batch of Playwright specs that navigated
 * and looked around but asserted nothing (#528); ai-questions ported the
 * detector (#754) and immediately surfaced 27 jest tests with the same
 * disease. Two repos converging on the same tool is the strongest evidence
 * a spawned repo will need it too.
 *
 * THE RULE THIS PORTS (exact, from both siblings — they agree on it):
 *   Per TEST BLOCK (not per file): a `test(...)` / `it(...)` / `.each`
 *   variant whose body contains no assertion token in CODE position
 *   (strings and comments do not count) is an offender. "Assertion token"
 *   is a static presence check — `expect(`/`expect.` in the siblings; this
 *   port adds `assert(`/`assert.` (see DELTAS). Reachability is NOT
 *   analyzed: an expect inside an if-branch or a try{} with an empty catch
 *   still counts. Both siblings state this scoping explicitly — the
 *   tautological/conditionally-gated half of the audit needs mutation or
 *   human review, and a static reachability heuristic would fail correct
 *   tests, and a gate that fails correct configurations gets switched off.
 *   Visible skips (`test.skip`/`it.skip`/`test.todo`) are NOT flagged and
 *   not even discovered — they are visible non-coverage, not fake coverage
 *   (counted informationally, per ai-questions). Tests nested inside a
 *   `describe.skip` ARE still scanned, as in both siblings.
 *
 * RATCHET (shrink-only baseline): offenders listed in the baseline are
 * known legacy debt — warned, not failed. Any offender NOT in the baseline
 * FAILS the run. A baseline entry that no longer offends ALSO fails until
 * removed, so a fixed test can never silently lose its assertion again
 * under an old exemption, and stale grandfathering (itself debt) cannot
 * accumulate. --write-baseline refuses to GROW an existing baseline
 * (ai-questions guard, added after an agent tried to "fix" a red gate by
 * baselining the new offender): it may seed an absent baseline on first
 * adoption, and rewrite one that shrinks, never one that grows.
 *
 * PROVENANCE OF EACH DESIGN DECISION
 *   - Same-length MASKING of strings/comments (not removal): ai-questions
 *     (#762 review). Removal drifted offsets, let a `}` inside a string
 *     truncate brace-matching, and discovered commented-out tests. Masking
 *     keeps every offset stable so titles read back from the unmasked
 *     source, braces inside strings are blanked, and `// test('ghost'...)`
 *     is never discovered.
 *   - `test` AND `it` matchers: ai-questions (lifelift matched only `test`
 *     because Playwright specs never use `it`).
 *   - Duplicate-title `:: dup-N` ordinal keys: ai-questions (#762) — two
 *     same-titled offenders would otherwise share one baseline key, letting
 *     a fixed twin hide the still-broken one from the stale check. Ordinals
 *     count ALL tests in the file (not just offenders) so fixing the first
 *     twin makes the survivor's old key go stale and the ratchet fire.
 *   - Forward-slash offender keys via toPosixPath: ai-questions (#815/#807)
 *     — path.relative() emits backslashes on Windows, so every key
 *     mismatched its baselined twin and the gate failed every clean diff on
 *     the primary (Windows) host.
 *   - Per-test-block granularity and the WARN/FAIL/stale output shape: both
 *     siblings, identical.
 *
 * DELTAS — semantics deliberately changed here, with reasons
 *   - Assertion tokens now include `assert(` / `assert.` alongside
 *     `expect`: the siblings are jest/Playwright repos; this template's own
 *     unit-test convention is node:test + node:assert, so an expect-only
 *     rule would flag every correct node:test file in a spawned repo on day
 *     one. Broadening only ADDS ways for a test to count as asserting —
 *     verified against ai-questions' real tree with zero parity loss.
 *   - Missing baseline file = EMPTY baseline (siblings hard-fail): a
 *     spawned repo starts strict with zero ceremony; the output says so.
 *   - Malformed baseline / bad flags exit 2 (siblings used 1): gates in
 *     this pack reserve 1 for findings and fail closed with 2 on
 *     config/internal errors, so CI can tell "debt found" from "gate
 *     broken".
 *   - Discovery is glob-driven from --root (default: *.test.* / *.spec.* /
 *     __tests__ trees, always excluding node_modules, .git, worktrees)
 *     instead of each sibling's hardcoded spec directory — the template
 *     cannot know where a spawned repo keeps tests.
 *   - Baseline file shape is {"$comment", "entries": [...]} rather than the
 *     siblings' bare array: the shrink-only rule travels with the file so a
 *     future agent editing it reads the contract first. Bare arrays (and a
 *     "files" key) are still ACCEPTED on read for sibling compatibility.
 *
 * Usage:
 *   node gates/detect-cantfail-tests.js [--baseline <path>] [--root <dir>]
 *                                       [--write-baseline] [globs...]
 * First output line is machine-readable: cantfail=<n_new_violations> ...
 * Exit codes: 0 clean, 1 findings (new offenders and/or stale baseline
 * entries), 2 usage/config error. Fails closed: internal errors exit 2.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_GLOBS = [
  '**/*.test.{js,jsx,ts,tsx,mjs,cjs}',
  '**/*.spec.{js,jsx,ts,tsx,mjs,cjs}',
  '**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs}',
];
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'worktrees']);

// SAME-LENGTH masking of string/template interiors and comments: every masked
// character becomes a space (quotes and newlines survive), so (a) braces
// inside strings cannot derail body brace-matching, (b) an `expect(` inside a
// string or comment cannot count as an assertion, and (c) a commented-out
// `test(...)` is not discovered as a real test — while every remaining
// character keeps its original offset, so titles can be read back from the
// unmasked source. Heuristic (regex literals and nested template
// interpolations are not fully parsed) — prefer improving this over
// allowlisting a miss.
function maskNonCode(source) {
  return source.replace(
    /(['"])(?:\\.|(?!\1)[^\\\n])*\1|`(?:\\.|[^\\`])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => {
      if (m[0] === '/') return m.replace(/[^\n]/g, ' ');
      return m[0] + m.slice(1, -1).replace(/[^\n]/g, ' ') + m[m.length - 1];
    });
}

// Find the body span of each test('name', fn) / it('name', fn) call
// (including .each variants) on the MASKED source; titles are recovered from
// the original source at the same offsets. The first '{' after the title is
// usually a destructured parameter ('async ({ page })'), so skip to the arrow
// first when one is present nearby, then brace-match. `.skip`/`.todo`/
// `.failing` are deliberately NOT matched — visible non-coverage, not fake
// coverage.
function findTests(source) {
  const masked = maskNonCode(source);
  const tests = [];
  // NOTE the title alternation is DISJOINT (`\\.` vs `[^\\\n]`): the siblings'
  // `(?:\\.|(?!\1).)*` lets a backslash match either branch, which is
  // exponential on an unterminated title full of backslashes (survives
  // masking; a 38-backslash 57-byte file hung the gate >15s). Disjointness is
  // behavior-identical on masked source — terminated string interiors are
  // already blanked to spaces — and `.` never matched `\n` anyway.
  const re = /\b(?:test|it)(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1\s*,/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const quoteStart = m.index + m[0].indexOf(m[1]);
    const title = source.slice(quoteStart + 1, quoteStart + 1 + m[2].length);
    let i = re.lastIndex;
    const arrow = masked.indexOf('=>', i);
    if (arrow !== -1 && arrow - i < 300) i = arrow + 2;
    while (i < masked.length && masked[i] !== '{') i++;
    if (i >= masked.length) continue;
    let depth = 0;
    const start = i;
    for (; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    // body is the MASKED slice — assertion checks run on it directly.
    tests.push({ title, body: masked.slice(start, i + 1) });
  }
  return tests;
}

// Static presence check, per the ported rule in the header: expect/assert in
// code position, reachability not analyzed.
const ASSERTION = /\b(?:expect|assert)\s*[.(]/;

function offendersInSource(file, source) {
  const offenders = [];
  // Duplicate titles in one file would share a `file :: title` key, which
  // would let one fixed duplicate hide its still-offending twin from the
  // stale check — disambiguate repeats with a stable occurrence suffix
  // (ordinal within the file, not line numbers, so unrelated edits above a
  // test don't churn the baseline).
  const seenTitles = new Map();
  for (const t of findTests(source)) {
    const n = (seenTitles.get(t.title) || 0) + 1;
    seenTitles.set(t.title, n);
    if (!ASSERTION.test(t.body)) {
      offenders.push(`${file} :: ${t.title}${n > 1 ? ` :: dup-${n}` : ''}`);
    }
  }
  return offenders;
}

// Baseline keys are OS-independent: '/' is never a legal path-segment
// character on Windows, so this substitution can never corrupt a filename,
// and on Linux/CI it is a no-op.
function toPosixPath(p) {
  return p.split('\\').join('/');
}

// ── glob support (zero-dependency) ─────────────────────────────────────────
// Supports: ** (any depth), * (within a segment), ?, {a,b,c}. Matched against
// forward-slash paths relative to --root.
function globToRegExp(glob) {
  let re = '';
  let i = 0;
  const g = toPosixPath(glob).replace(/^\.\//, '');
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more whole segments; bare `**` matches anything.
        if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 3; }
        else { re += '.*'; i += 2; }
      } else { re += '[^/]*'; i += 1; }
    } else if (c === '?') { re += '[^/]'; i += 1; }
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) { re += '\\{'; i += 1; }
      else {
        re += '(?:' + g.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
        i = end + 1;
      }
    } else { re += escapeRe(c); i += 1; }
  }
  return new RegExp('^' + re + '$');
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function listCandidateFiles(root) {
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; } // unreadable subdir: skip, not fatal
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        out.push(path.join(dir, e.name));
      }
    }
  })(root);
  return out;
}

function scan(root, globs) {
  const regexes = globs.map(globToRegExp);
  const offenders = [];
  let skips = 0;
  let fileCount = 0;
  for (const full of listCandidateFiles(root)) {
    const rel = toPosixPath(path.relative(root, full));
    if (!regexes.some((r) => r.test(rel))) continue;
    fileCount++;
    const source = fs.readFileSync(full, 'utf8');
    offenders.push(...offendersInSource(rel, source));
    skips += (maskNonCode(source).match(/\b(?:test|it|describe)\.(?:skip|todo)\s*[.(]/g) || []).length;
  }
  return { offenders: offenders.sort(), skips, fileCount };
}

// ── baseline I/O ────────────────────────────────────────────────────────────
const BASELINE_COMMENT =
  'SHRINK-ONLY baseline of known cant-fail tests (no reachable assertion). ' +
  'Entries may be REMOVED when fixed — never added. A new offender fails the ' +
  'gate and must gain a real assertion; an entry that no longer offends also ' +
  'fails the gate until deleted here. Managed by gates/detect-cantfail-tests.js.';

// Returns {entries, existed}. Accepts this pack's {"$comment","entries"} shape
// plus sibling-compatible shapes: a bare JSON array, or a "files" key.
// Malformed content is a CONFIG error (exit 2) — a gate that silently treats
// a corrupt baseline as empty would fail every baselined repo, and one that
// treated it as full would pass new debt.
function readBaseline(baselinePath) {
  if (!fs.existsSync(baselinePath)) return { entries: [], existed: false };
  const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); // throws -> exit 2
  let entries;
  if (Array.isArray(parsed)) entries = parsed;
  else if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries;
  else if (parsed && Array.isArray(parsed.files)) entries = parsed.files;
  else throw new Error('baseline must be a JSON array or {"$comment","entries":[...]}');
  if (!entries.every((e) => typeof e === 'string')) {
    throw new Error('baseline entries must all be strings');
  }
  return { entries, existed: true };
}

// Pure ratchet evaluation, separated from I/O for testability (both siblings).
// Returns {exitCode, lines} — exitCode 1 on fresh offenders OR stale baseline
// entries (the baseline may only shrink, immediately). The cantfail= summary
// line is emitted by main(), not here.
function evaluate(offenders, baseline) {
  const known = offenders.filter((o) => baseline.includes(o));
  const fresh = offenders.filter((o) => !baseline.includes(o));
  const stale = baseline.filter((b) => !offenders.includes(b));
  const lines = [];
  let exitCode = 0;

  if (known.length) {
    lines.push(`WARN: ${known.length} known can't-fail test(s) (baseline debt):`);
    for (const o of known) lines.push(`   - ${o}`);
  }
  if (stale.length) {
    exitCode = 1;
    lines.push(`FAIL: ${stale.length} baseline entr(y/ies) no longer offend — remove them from the baseline now (the ratchet only shrinks):`);
    for (const s of stale) lines.push(`   - ${s}`);
  }
  if (fresh.length) {
    exitCode = 1;
    lines.push(`FAIL: ${fresh.length} NEW can't-fail test(s) — every test must contain a reachable expect()/assert():`);
    for (const o of fresh) lines.push(`   - ${o}`);
  }
  if (exitCode === 0) {
    lines.push(`OK: can't-fail check passed (${offenders.length} total, all baselined).`);
  }
  return { exitCode, fresh, stale, known, lines };
}

function usage(msg) {
  if (msg) console.error(`detect-cantfail-tests: ${msg}`);
  console.error('Usage: node gates/detect-cantfail-tests.js [--baseline <path>] [--root <dir>] [--write-baseline] [globs...]');
  return 2;
}

function main() {
  const args = process.argv.slice(2);
  let root = process.cwd();
  let baselinePath = null;
  let writeBaseline = false;
  const globs = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root') {
      if (!args[i + 1]) return usage('--root requires a value');
      root = path.resolve(args[++i]);
    } else if (a === '--baseline') {
      if (!args[i + 1]) return usage('--baseline requires a value');
      baselinePath = path.resolve(args[++i]);
    } else if (a === '--write-baseline') {
      writeBaseline = true;
    } else if (a === '--update-baseline') {
      return usage('unknown flag --update-baseline (the sibling repos\' name) — this tool calls it --write-baseline');
    } else if (a === '--help' || a === '-h') {
      usage();
      return 0;
    } else if (a.startsWith('--')) {
      return usage(`unknown flag ${a}`);
    } else {
      globs.push(a);
    }
  }

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return usage(`--root is not a directory: ${root}`);
  }
  if (baselinePath === null) baselinePath = path.join(root, 'cantfail-baseline.json');

  const { offenders, skips, fileCount } = scan(root, globs.length ? globs : DEFAULT_GLOBS);

  let baseline;
  try {
    baseline = readBaseline(baselinePath);
  } catch (e) {
    console.error(`detect-cantfail-tests: could not read baseline ${baselinePath}: ${e.message}`);
    return 2; // config error — fail closed, distinct from findings
  }

  if (writeBaseline) {
    // Shrink-only applies to WRITES too: refuse to ADD entries via rewrite —
    // new offenders must be fixed, not baselined. Seeding an absent baseline
    // is the one exception, for first adoption.
    if (baseline.existed) {
      const added = offenders.filter((o) => !baseline.entries.includes(o));
      if (added.length) {
        const staleCount = baseline.entries.filter((b) => !offenders.includes(b)).length;
        console.log(`cantfail=${added.length} stale=${staleCount} baselined=${offenders.length - added.length} files=${fileCount}`);
        console.error(`FAIL: --write-baseline would ADD ${added.length} entr(y/ies); the ratchet only shrinks. Fix the new offender(s) instead:`);
        for (const a of added) console.error(`   - ${a}`);
        return 1;
      }
    }
    fs.writeFileSync(baselinePath,
      JSON.stringify({ $comment: BASELINE_COMMENT, entries: offenders }, null, 2) + '\n');
    console.log(`cantfail=0 stale=0 baselined=${offenders.length} files=${fileCount}`);
    console.log(`Baseline ${baseline.existed ? 'rewritten' : 'seeded'} with ${offenders.length} entr(y/ies): ${baselinePath}`);
    return 0;
  }

  const { exitCode, fresh, stale, known, lines } = evaluate(offenders, baseline.entries);
  console.log(`cantfail=${fresh.length} stale=${stale.length} baselined=${known.length} files=${fileCount}`);
  if (!baseline.existed) {
    console.log(`INFO: no baseline file at ${baselinePath} — treating as empty (new repos start strict).`);
  }
  for (const line of lines) (exitCode ? console.error : console.log)(line);
  if (skips) console.log(`INFO: ${skips} visible skip/todo marker(s) (not flagged — visible non-coverage is not fake coverage).`);
  return exitCode;
}

module.exports = {
  maskNonCode, findTests, offendersInSource, scan, evaluate,
  toPosixPath, globToRegExp, readBaseline,
};

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    // Gate tools fail CLOSED: an internal error must not read as "clean".
    console.error(`detect-cantfail-tests: internal error: ${e && e.stack || e}`);
    process.exit(2);
  }
}
