#!/usr/bin/env node
/**
 * assumption-roulette.js — deterministic picker for the assumption-roulette mechanism:
 * find the least-tested, most-load-bearing file and hand the agent a target.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Scrutiny in an agent-driven repo piles up on whatever was touched last. Files nothing
 * touches accumulate unexamined assumptions until one of them is load-bearing and wrong.
 * The roulette mechanism (owner-designed on kaiserguy/ai-questions, where its first spin
 * found a high-severity production bug; ported to lifelift-mobile-backend by the Director
 * 2026-W28 per owner directive 2026-07-12) counters that drift: each round picks one
 * least-examined file and the agent asserts and EXECUTES real tests against that file's
 * assumptions. Both production repos converged on the same tool independently — the
 * strongest evidence it is core machinery, which is why it ships in the pack.
 *
 * THIS IS THE PICKER HALF ONLY. Both siblings couple selection to ledger bookkeeping
 * (assumptions/LEDGER.md, --record mode, record-file parsing for previousAssumptions).
 * That state machinery is deliberately NOT ported: a spawned repo has no ledger on day
 * one, and the pack contract for this tool is a stateless pick. The ledger's job —
 * "don't re-pick what was just tested" — is replaced by the test-reference graph itself:
 * the moment the agent writes a real test that imports the target, the target leaves the
 * untested bucket and the next run picks something else. Writing the test IS the ledger
 * update. The test-WRITING half stays with the agent; this tool only picks.
 *
 * RANKING (the semantics, stated once)
 *   1. files NO test references, before files some test references
 *      (a test references a file if any discovered test file imports/requires it —
 *      relative specifiers resolved, index files and extension-less specifiers handled,
 *      root-anchored specifiers as a crude alias catch, tsconfig/jsconfig
 *      `compilerOptions.paths` aliases resolved (single-`*` and exact patterns,
 *      best-effort JSONC parse of the root tsconfig.json/jsconfig.json), and
 *      path-shaped string literals resolved exactly to catch computed requires like
 *      `require(path.join(root, 'x.js'))`; Windows `\\` separators in specifiers are
 *      normalized; bare package names ignored.
 *      EXPLICITLY UNSUPPORTED — these will misrank affected files as "untested":
 *      jest moduleNameMapper, webpack/vite resolve.alias, nested/extended tsconfigs
 *      (`extends`, per-package tsconfigs), and dynamic requires built from variables
 *      or template strings. If your repo leans on those, pass --src or accept that
 *      the untested bucket is an overestimate.)
 *   2. then git churn (number of commits touching the file) DESCENDING — more history
 *      means more load-bearing and more chances for assumptions to have rotted.
 *      DEGRADED HISTORY is non-fatal and announced: a shallow clone truncates churn
 *      at the fetch depth (warning printed, `history:"shallow"` in --json); a repo
 *      with staged files but zero commits ranks everything churn 0 and falls through
 *      to LOC (`history:"none"`).
 *   3. then LOC descending — more surface, more assumptions
 *   4. then path ascending — pure tie-break, so runs on an unchanged tree are identical
 *
 * DELTAS FROM THE SIBLINGS (convergent-evolution decisions, resolved here)
 *   - RANDOMNESS DROPPED. Both siblings pick uniformly at random among the min-ledger-
 *     count files (Mulberry32 PRNG, --seed for tests). Random-without-a-ledger would
 *     re-pick the same bucket with no memory of past rounds; deterministic ranking is
 *     what makes a stateless picker coherent, and churn×LOC aims the first rounds at the
 *     most load-bearing untested files instead of a coin flip. Neither sibling weights
 *     by churn or LOC — that ranking is this port's addition, per the pack contract, so
 *     "mirror sibling weighting" resolves to: sibling weighting is ledger-min + uniform;
 *     we keep the "least-tested first" core and replace the tie-break.
 *   - .github/ excluded wholesale (lifelift) rather than only .github/workflows/
 *     (ai-questions): CI surface is a carve-out agents must not be steered into, and
 *     nothing under .github/ is assumption-testable app source.
 *   - lifelift additionally excludes claude-*.md (loop prompt files) to keep the
 *     roulette "pointed at the SYSTEM, not the loops' own instructions". Moot here —
 *     this universe is code-only — but the principle survives as the prompts/, skills/,
 *     .claude/ exclusions below.
 *   - lifelift's binary-extension superset (adds jar/keystore/p12/pem) adopted in
 *     spirit; also mostly moot under a code-only universe.
 *   - The siblings' --record path validation (lifelift hardens it to check BOTH
 *     path.win32.isAbsolute and path.posix.isAbsolute) is n/a — record mode is not
 *     ported.
 *   - No shell strings are ever built: everything runs through execFileSync("git",
 *     [args]) with argument arrays, which sidesteps cmd.exe-vs-bash quoting entirely
 *     (the POSIX_SH dance in evals/run-eval.js exists for tools that must run a shell
 *     COMMAND STRING; this tool never needs one).
 *
 * DEFAULT UNIVERSE (overridable with --src / --exclude, both repeatable globs)
 *   include: git-tracked files with a source extension:
 *            .js .mjs .cjs .jsx .ts .tsx .py .rb .go .rs .java .kt .kts .swift
 *            .c .h .cc .cpp .hpp .cs .php .sh
 *   exclude: test files (under __tests__/ __mocks__/ tests/ test/ spec/ e2e/, or named
 *            *.test.* *.spec.* *_test.* test_*.py conftest.py);
 *            node_modules/ and .git/ anywhere in the path;
 *            pack machinery + agent-instruction surfaces at the repo root:
 *            gates/ evals/ hooks/ sync/ bootstrap/ prompts/ skills/ docs/ .claude/
 *            .github/ (pack files are verified by the pack's own self-gates — same
 *            doctrine as verify-affordances' PACK_INTERNAL exemption);
 *            config-shaped files (*.config.*, .*rc.js/.cjs/.mjs, setup files).
 *   --src replaces the extension-based include (hard excludes still apply);
 *   --exclude adds to the exclusions.
 *
 * READ-ONLY TRIPWIRE
 *   This tool NEVER writes, stages, commits, or mutates anything — it picks and prints.
 *   And the roulette rule from both sibling repos carries over to whoever consumes the
 *   pick: the tests the agent then writes must EXECUTE the target — import the real
 *   module and assert on real behavior (code run, scratch script, live probe — never
 *   just reading source, and never mocking the target itself into vacuity; mock only
 *   its expensive externals). Assertions must be unconditional and able to fail.
 *
 * USAGE
 *   node gates/assumption-roulette.js [--root <dir>] [--json] [--top <n>]
 *                                     [--src <glob>...] [--exclude <glob>...]
 *
 * OUTPUT: first line is machine-readable (`assumption-roulette: target=... untested=...
 * churn=... loc=...`); then the human block (why this file, top co-changed files,
 * runners-up, instructions). --json emits the same as JSON. Deterministic across runs
 * on an unchanged tree.
 *
 * EXIT CODES: 0 = target selected; 1 = no candidate files (universe empty — a finding:
 * the mechanism cannot run here until the globs or the repo change); 2 = usage/config/
 * internal error (fail closed: a picker that half-ran must not look like a pick).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function fail(msg) {
  console.error(`assumption-roulette: ${msg}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Universe definition
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh',
]);

// Directory COMPONENTS excluded anywhere in the path (a vendored node_modules three
// levels deep is still vendored).
const HARD_EXCLUDED_COMPONENTS = new Set(['node_modules', '.git']);

// Repo-root PREFIXES excluded by default: pack machinery + agent-instruction surfaces.
// See header for the doctrine.
const DEFAULT_EXCLUDED_PREFIXES = [
  'gates/', 'evals/', 'hooks/', 'sync/', 'bootstrap/',
  'prompts/', 'skills/', 'docs/', '.claude/', '.github/',
];

// Test files: never candidates, always scanned for references.
const TEST_DIR_COMPONENTS = new Set(['__tests__', '__mocks__', 'tests', 'test', 'spec', 'e2e']);
const TEST_NAME_PATTERNS = [
  /\.test\.[^.]+$/i,
  /\.spec\.[^.]+$/i,
  /_test\.[^.]+$/i,
  /^test_.*\.py$/i,
  /^conftest\.py$/i,
];

// Config-shaped files: tooling wiring, not assumption-testable system source.
const CONFIG_NAME_PATTERNS = [
  /\.config\.[^.]+$/i,            // jest.config.js, vite.config.ts, ...
  /^\..*rc\.(js|cjs|mjs)$/i,      // .eslintrc.js, .prettierrc.cjs, ...
  /^(babel|jest|webpack|rollup|vitest|playwright|karma|gulpfile|gruntfile)\.[^.]+$/i,
  /^(setup|conftest)\.(js|cjs|mjs|ts)$/i,
];

// Repo-relative paths are keyed/compared as forward-slash throughout, to match
// `git ls-files` output (both siblings do the same).
function toPosix(p) {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

function pathComponents(rel) {
  return rel.split('/');
}

function isTestFile(rel) {
  const parts = pathComponents(rel);
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((c) => TEST_DIR_COMPONENTS.has(c))) return true;
  return TEST_NAME_PATTERNS.some((re) => re.test(base));
}

function extOf(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const m = base.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

// Minimal glob → RegExp: `**` crosses directories, `*` stays within a segment,
// `?` is one non-slash char. Enough for --src/--exclude without a dependency.
function globToRegExp(glob) {
  const g = toPosix(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more whole segments; bare `**` matches anything.
        if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; }
        else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function isCandidate(rel, srcRes, excludeRes) {
  const parts = pathComponents(rel);
  if (parts.some((c) => HARD_EXCLUDED_COMPONENTS.has(c))) return false;
  if (excludeRes.some((re) => re.test(rel))) return false;
  if (isTestFile(rel)) return false;
  // Ambient declaration files can never be require()d, so no test can ever reference
  // one and the stateless advance contract ("a real test imports the target") is
  // structurally unsatisfiable: the picker re-picks the same .d.ts forever. Found by
  // burst-audit round 3 (2026-08-11), which tested types/firebase-auth-rn.d.ts's
  // package claims and was then handed the same target again. Their assumptions are
  // claims about PACKAGES and stay auditable through tests that execute the package
  // (as that round's test does); the files themselves leave the universe.
  if (rel.endsWith('.d.ts') || rel.endsWith('.d.mts') || rel.endsWith('.d.cts')) return false;

  if (srcRes.length > 0) return srcRes.some((re) => re.test(rel));

  if (!SOURCE_EXTENSIONS.has(extOf(rel))) return false;
  if (DEFAULT_EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) return false;
  const base = parts[parts.length - 1];
  if (CONFIG_NAME_PATTERNS.some((re) => re.test(base))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// git plumbing — argument arrays only, never shell strings
// ---------------------------------------------------------------------------

function git(root, args, opts = {}) {
  // core.longpaths=true: on Windows (the primary host) a repo sitting under a deep
  // worktree path — .claude/worktrees/<name>/... is exactly deep enough — makes git
  // object reads die with "Filename too long" unless longpaths is on. A no-op on
  // Linux CI and on repos with short paths; found by executing this tool against a
  // fixture in the sandbox scratchpad, not by reading it.
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 28, // 256 MB — full-history --name-only on a mature repo is big
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function listTrackedFiles(root) {
  let out;
  try {
    out = git(root, ['-c', 'core.quotepath=false', 'ls-files']);
  } catch (e) {
    fail(`git ls-files failed in ${root} — not a git repo, or git unavailable: ${(e.stderr || e.message || '').toString().trim().split('\n')[0]}`);
  }
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * One pass over history: per-file commit counts, plus the commit→files lists needed
 * for the target's co-change report. \x01 delimits commits so no filename can fake a
 * boundary; core.quotepath=false keeps non-ASCII paths literal.
 */
function readChurn(root) {
  let out;
  try {
    out = git(root, ['-c', 'core.quotepath=false', 'log', '--name-only', '--pretty=format:\x01%H']);
  } catch (e) {
    const firstLine = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    // A repo with staged files but no commits yet is a legitimate day-one state for a
    // spawned repo (found by running this against a `git init && git add` fixture):
    // degrade to churn 0 for everything — LOC becomes the effective tie-break — and
    // say so, instead of failing closed on a state the pack explicitly targets.
    if (/does not have any commits yet|bad default revision|unknown revision/i.test(firstLine)) {
      return { churn: new Map(), commits: [], history: 'none' };
    }
    fail(`git log failed: ${firstLine}`);
  }
  let history = 'full';
  try {
    if (git(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true') history = 'shallow';
  } catch (_) { /* pre-2.15 git or odd repo: assume full rather than crash */ }
  const churn = new Map();      // file -> commit count
  const commits = [];           // array of string[] (files per commit)
  for (const chunk of out.split('\x01')) {
    if (!chunk.trim()) continue;
    const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const files = lines.slice(1); // line 0 is the hash
    if (files.length === 0) continue;
    commits.push(files);
    for (const f of files) churn.set(f, (churn.get(f) || 0) + 1);
  }
  return { churn, commits, history };
}

function countLines(root, rel) {
  try {
    const raw = fs.readFileSync(path.join(root, rel), 'utf8');
    if (raw.length === 0) return 0;
    return raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0);
  } catch (_) {
    return 0; // tracked but absent from the working tree — rank it low, don't crash
  }
}

// ---------------------------------------------------------------------------
// Test-reference graph
// ---------------------------------------------------------------------------

const RESOLVE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];

function extractSpecifiers(rel, content) {
  const specs = [];
  for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of content.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of content.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of content.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  // jest.requireActual / vi.importActual load the REAL module past its mocks — the one
  // reference form that proves the test executes the target rather than a double. A
  // test built this way (mock the module's expensive deps, requireActual the target)
  // read as "no reference" until 2026-08-11, when the first burst-audit round re-picked
  // an already-tested entry point: the stateless picker never advances past a file whose
  // only real-execution reference uses this form.
  for (const m of content.matchAll(/\brequireActual\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of content.matchAll(/\bimportActual\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  // jest.mock/vi.mock with a factory can null a module out, but the test still had to
  // NAME it — and near-universally also imports it. We do not count mock() calls as
  // references on their own: a target mocked into vacuity should not read as tested.
  //
  // Computed requires: found by executing this tool against the real lifelift clone,
  // not by reading it — `require(path.join(rootPath, 'validation-pipeline.js'))` in
  // functions/__tests__/validation-pipeline.test.js left validation-pipeline.js ranked
  // "untested". Any string literal that looks like a source file path gets one
  // resolution attempt (repo-root-relative and test-dir-relative, exact match only —
  // no extension guessing, so a bare mention in a comment about some OTHER repo's
  // file cannot mark a local file tested unless the path actually resolves here).
  for (const m of content.matchAll(/['"]([\w@.\\/-]+\.(?:js|mjs|cjs|jsx|ts|tsx|py))['"]/g)) {
    specs.push(`lit:${m[1]}`);
  }
  // Second computed-require shape, also found by the lifelift spot-check:
  // `path.join(__dirname, '..', '..', 'public', 'scripts', 'service-worker.js')`
  // — no single literal carries the path. Join the call's string-literal arguments
  // in order (identifiers like __dirname/rootPath drop out; both conventionally
  // anchor at the test's own dir or the repo root, which are exactly the two bases
  // the lit: resolver tries).
  for (const m of content.matchAll(/\bpath\.join\s*\(([^()]*)\)/g)) {
    const parts = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (parts.length > 0) specs.push(`lit:${parts.join('/')}`);
  }
  if (rel.endsWith('.py')) {
    for (const m of content.matchAll(/^\s*(?:from|import)\s+([\w.]+)/gm)) {
      specs.push(`py:${m[1]}`);
    }
  }
  return specs;
}

/**
 * Best-effort tsconfig/jsconfig `compilerOptions.paths` reader. Found necessary by
 * executing the port against an alias fixture: `import x from '@app/foo'` silently
 * ranked src/foo.ts untested. Single-`*` and exact alias patterns only; JSONC
 * comments/trailing commas stripped crudely; any parse failure means "no aliases"
 * (never fatal — a broken tsconfig must not take the picker down). `extends` chains
 * and per-package tsconfigs are NOT followed (stated in the header).
 */
function loadAliasPatterns(root) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = fs.readFileSync(path.join(root, name), 'utf8')
        .replace(/^\uFEFF/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
      const co = JSON.parse(raw).compilerOptions;
      if (!co || !co.paths || typeof co.paths !== 'object') continue;
      const baseUrl = toPosix(co.baseUrl || '.');
      const patterns = [];
      for (const [alias, targets] of Object.entries(co.paths)) {
        if (!Array.isArray(targets) || (alias.match(/\*/g) || []).length > 1) continue;
        for (const t of targets) {
          if (typeof t === 'string' && (t.match(/\*/g) || []).length <= 1) {
            patterns.push({ alias, target: toPosix(t) });
          }
        }
      }
      if (patterns.length) return { baseUrl, patterns };
    } catch (_) { /* absent or unparseable -> no aliases */ }
  }
  return null;
}

/**
 * Resolve one specifier from one test file to a tracked repo path, or null.
 * Relative specifiers resolve against the test file's directory; tsconfig-paths
 * aliases (if a root tsconfig/jsconfig declares them) resolve through the alias map;
 * root-anchored and bare specifiers get one crude attempt from the repo root
 * (catches `/src/x` and repo-rooted aliases); genuinely bare package names miss
 * everything in the tracked set and fall out naturally. Windows `\` separators are
 * normalized first (a `require('..\\src\\x')` is rare but real — found by fixture).
 */
function resolveSpecifier(spec, testRel, tracked, aliasMap) {
  spec = spec.replace(/\\/g, '/');
  const tryPaths = (base) => {
    const norm = path.posix.normalize(base);
    if (norm.startsWith('..')) return null;
    if (tracked.has(norm)) return norm;
    for (const ext of RESOLVE_EXTS) if (tracked.has(norm + ext)) return norm + ext;
    for (const ext of RESOLVE_EXTS) if (tracked.has(`${norm}/index${ext}`)) return `${norm}/index${ext}`;
    return null;
  };

  if (spec.startsWith('lit:')) {
    const lit = spec.slice(4).replace(/^\/+/, '');
    for (const base of [lit, `${path.posix.dirname(testRel)}/${lit}`]) {
      const norm = path.posix.normalize(base);
      if (!norm.startsWith('..') && tracked.has(norm)) return norm;
    }
    return null;
  }

  if (spec.startsWith('py:')) {
    const mod = spec.slice(3).replace(/^\.+/, '');
    if (!mod) return null;
    const asPath = mod.replace(/\./g, '/');
    const dir = path.posix.dirname(testRel);
    for (const base of [asPath, `${dir}/${asPath}`]) {
      const norm = path.posix.normalize(base);
      if (norm.startsWith('..')) continue;
      if (tracked.has(`${norm}.py`)) return `${norm}.py`;
      if (tracked.has(`${norm}/__init__.py`)) return `${norm}/__init__.py`;
    }
    return null;
  }

  if (spec.startsWith('.')) {
    return tryPaths(`${path.posix.dirname(testRel)}/${spec}`);
  }

  if (aliasMap) {
    for (const { alias, target } of aliasMap.patterns) {
      let substituted = null;
      const star = alias.indexOf('*');
      if (star === -1) {
        if (spec === alias) substituted = target;
      } else {
        const prefix = alias.slice(0, star);
        const suffix = alias.slice(star + 1);
        if (spec.length >= prefix.length + suffix.length
            && spec.startsWith(prefix) && spec.endsWith(suffix)) {
          const middle = spec.slice(prefix.length, spec.length - suffix.length);
          substituted = target.includes('*') ? target.replace('*', middle) : target;
        }
      }
      if (substituted !== null) {
        const hit = tryPaths(`${aliasMap.baseUrl}/${substituted}`);
        if (hit) return hit;
      }
    }
  }

  return tryPaths(spec.replace(/^\/+/, ''));
}

function buildReferencedSet(root, trackedList) {
  const tracked = new Set(trackedList);
  const testFiles = trackedList.filter((f) => {
    if (pathComponents(f).some((c) => HARD_EXCLUDED_COMPONENTS.has(c))) return false;
    if (!isTestFile(f)) return false;
    const e = extOf(f);
    return SOURCE_EXTENSIONS.has(e);
  });

  const aliasMap = loadAliasPatterns(root);
  const referenced = new Set();
  for (const tf of testFiles) {
    let content;
    try {
      content = fs.readFileSync(path.join(root, tf), 'utf8');
    } catch (_) {
      continue;
    }
    for (const spec of extractSpecifiers(tf, content)) {
      const hit = resolveSpecifier(spec, tf, tracked, aliasMap);
      if (hit) referenced.add(hit);
    }
  }
  return { referenced, testFileCount: testFiles.length };
}

// ---------------------------------------------------------------------------
// Ranking + co-change
// ---------------------------------------------------------------------------

function rankCandidates(candidates, referenced, churn, root) {
  const rows = candidates.map((file) => ({
    file,
    untested: !referenced.has(file),
    churn: churn.get(file) || 0,
    loc: countLines(root, file),
  }));
  rows.sort((a, b) => {
    if (a.untested !== b.untested) return a.untested ? -1 : 1;
    if (b.churn !== a.churn) return b.churn - a.churn;
    if (b.loc !== a.loc) return b.loc - a.loc;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  return rows;
}

function topCoChanged(target, commits, limit) {
  const tally = new Map();
  for (const files of commits) {
    if (!files.includes(target)) continue;
    for (const f of files) {
      if (f === target) continue;
      tally.set(f, (tally.get(f) || 0) + 1);
    }
  }
  return [...tally.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([file, count]) => ({ file, commits: count }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  `Write tests that EXECUTE the target: import/require the real module and assert on real behavior (code run, scratch script, live probe) - never just reading source.`,
  `Never mock the target itself into vacuity; mock only its expensive externals (network, clocks, paid APIs).`,
  `Assertions must be unconditional and able to fail - a test that cannot fail records nothing.`,
  `Prove at least one test fails when the assumption is broken (negative control), then restore.`,
  `This picker is stateless: the target leaves the untested bucket the moment a real test references it, which is what advances the roulette to the next file.`,
];

function usage() {
  console.error('usage: node gates/assumption-roulette.js [--root <dir>] [--json] [--top <n>] [--src <glob>...] [--exclude <glob>...]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false, top: 5, src: [], exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      if (!argv[i + 1]) usage();
      args.root = argv[++i];
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--top') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) usage();
      args.top = n;
    } else if (a === '--src' || a === '--exclude') {
      const key = a.slice(2);
      let took = 0;
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        args[key].push(argv[++i]);
        took++;
      }
      if (took === 0) usage();
    } else {
      usage();
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`--root is not a directory: ${root}`);
  }

  let srcRes, excludeRes;
  try {
    srcRes = args.src.map(globToRegExp);
    excludeRes = args.exclude.map(globToRegExp);
  } catch (e) {
    fail(`bad glob: ${e.message}`);
  }

  const trackedList = listTrackedFiles(root).map(toPosix);
  const candidates = trackedList.filter((f) => isCandidate(f, srcRes, excludeRes));

  if (candidates.length === 0) {
    console.log('assumption-roulette: no-candidates');
    console.error(`No candidate files under ${root} (tracked: ${trackedList.length}). Adjust --src/--exclude or add source files.`);
    process.exit(1);
  }

  const { referenced, testFileCount } = buildReferencedSet(root, trackedList);
  const { churn, commits, history } = readChurn(root);
  const ranked = rankCandidates(candidates, referenced, churn, root);
  const historyNote = history === 'shallow'
    ? 'WARNING: shallow clone - churn is truncated at the fetch depth, so churn-based ordering may not reflect true history; unfetched history also hides co-change data. Unshallow (git fetch --unshallow) for accurate ranking.'
    : history === 'none'
      ? 'note: repo has no commits yet - churn is 0 for every file, ranking falls through to LOC.'
      : null;

  const target = ranked[0];
  const runnersUp = ranked.slice(1, 1 + args.top);
  const coChanged = topCoChanged(target.file, commits, args.top);
  const untestedCount = ranked.filter((r) => r.untested).length;

  if (args.json) {
    console.log(JSON.stringify({
      target: { ...target, coChanged },
      runnersUp,
      universe: {
        root,
        candidates: candidates.length,
        untested: untestedCount,
        testFiles: testFileCount,
        history,
        ...(historyNote ? { historyNote } : {}),
      },
      instructions: INSTRUCTIONS,
    }, null, 2));
    process.exit(0);
  }

  console.log(`assumption-roulette: target=${target.file} untested=${target.untested ? 'yes' : 'no'} churn=${target.churn} loc=${target.loc}`);
  console.log('');
  if (historyNote) console.log(historyNote);
  console.log(`Target: ${target.file}`);
  console.log(`  untested: ${target.untested
    ? `yes - no test references it (${testFileCount} test file(s) scanned)`
    : `no - some test references it (and so does every other candidate: ${untestedCount} untested remain)`}`);
  console.log(`  churn:    ${target.churn} commit(s) touch it`);
  console.log(`  loc:      ${target.loc}`);
  if (coChanged.length) {
    console.log(`  top co-changed: ${coChanged.map((c) => `${c.file} (${c.commits})`).join(', ')}`);
  }
  if (runnersUp.length) {
    console.log('Runners-up:');
    runnersUp.forEach((r, i) => {
      console.log(`  ${i + 2}. ${r.file} (${r.untested ? 'untested' : 'tested'}, churn ${r.churn}, loc ${r.loc})`);
    });
  }
  console.log(`Universe: ${candidates.length} candidate(s), ${untestedCount} untested, ${testFileCount} test file(s) scanned.`);
  console.log('Instructions:');
  for (const line of INSTRUCTIONS) console.log(`  - ${line}`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  toPosix,
  isTestFile,
  isCandidate,
  globToRegExp,
  extractSpecifiers,
  resolveSpecifier,
  loadAliasPatterns,
  rankCandidates,
  topCoChanged,
};
