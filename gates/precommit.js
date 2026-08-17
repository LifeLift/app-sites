#!/usr/bin/env node
/**
 * precommit.js — the path-aware gate: run only the checks the diff deserves.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Both production repos this pack is distilled from converged on the same shape
 * independently, from the same pain in opposite directions:
 *
 *   - lifelift-mobile-backend (#576): `npm run precommit` ran the entire repo-wide
 *     chain (lint + full jest CI + the whole CSS build/validate pipeline) on every
 *     invocation. Too slow, so humans and agents skipped it — an always-run-everything
 *     gate degrades into a run-nothing gate.
 *   - ai-questions (#755): the repo had NO local gate at all, while two agent docs
 *     confidently described a "pre-push hook" that had never existed.
 *
 * The converged answer: derive the changed-file set from git, map paths to check
 * categories, run only what applies. Docs-only changes return in under a second;
 * code changes get syntax + the relevant test slice. A gate that is fast enough to
 * always run is the only gate that actually runs.
 *
 * This port is CONFIG-DRIVEN (precommit.config.json) where both sources hardcoded
 * their category tables — a spawned repo declares its own path→check mapping instead
 * of editing gate source. Semantics are ported, not lines.
 *
 * DESIGN PROVENANCE (which repo each decision came from, and what was changed)
 * ────────────────────────────────────────────────────────────────────────────
 *   - Staged-first file source (staged if any, else diff vs the integration base):
 *     identical in both sources, kept verbatim.
 *   - Deletion handling: `--diff-filter=d` PLUS an fs.existsSync belt-over-suspenders
 *     filter — the ai-questions form (their #762 review: a deleted .js file otherwise
 *     plans as `node --check <gone>` and fails every commit that removes code).
 *     lifelift used `--diff-filter=ACMR` + existence check; same intent, `d` is the
 *     tighter spelling.
 *   - merge-base diffing (diff vs `git merge-base <base> HEAD`, not vs <base>
 *     directly): from ai-questions. Diffing against the base ref itself reports files
 *     OTHER people changed on the base since you branched; merge-base reports only
 *     your own work.
 *   - GIT_* env scrubbing for child checks: converged in both after a real incident —
 *     git hooks export GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE into the hook env, and a
 *     child that shells out to git then operates on the REAL repo regardless of cwd
 *     (observed in lifelift: a test fixture's `git add -A` staged mass deletions in
 *     the real index). Kept, non-negotiable.
 *   - TOOLING vs FAIL distinction: NEW here, inherited from this pack's
 *     verify-affordances lineage (lifelift #532: eslint was dead for ~25 days because
 *     "the check could not run" read exactly like "the check ran and passed/failed").
 *     Neither source runner drew this line; every non-zero exit printed the same
 *     FAIL. A check that cannot run (exit 127, command not found, cannot find module)
 *     is labeled TOOLING, loudly — it still fails the gate (fail closed), but a
 *     reader must never mistake a broken toolchain for a code problem or vice versa.
 *
 * SEMANTICS DELIBERATELY CHANGED (with reasons)
 * ─────────────────────────────────────────────
 *   - Multi-match instead of first-match-wins. Both sources used ordered categories
 *     where the first match claimed the file (so "docs beats functions" had to be
 *     encoded as list position). A config-driven tool cannot assume the author got
 *     the ordering subtleties right; letting a file fire every category it matches
 *     composes better ("an .ejs edit re-runs the css validators" was a patch-on-patch
 *     in lifelift; here it is just a second matching category). Docs-only skipping is
 *     expressed as a category with zero checks, not as ordering magic.
 *   - No category short-circuit. Both sources stopped after the first category
 *     containing a failure (their later categories were expensive full suites). Here
 *     every planned check runs and the summary reports the full picture — the checks
 *     a config declares are already scoped to the diff, and partial reports are how
 *     "it also broke X" gets discovered one commit too late.
 *   - PRECOMMIT_FULL=1 became `--all` (treat every tracked file as changed). Same
 *     capability, but flag-shaped and file-driven instead of a second hardcoded
 *     check matrix to keep in sync with the first.
 *   - POSIX sh preferred over `shell: true` (both sources used shell:true on win32,
 *     i.e. cmd.exe). This template's run-eval.js pattern is copied instead: cmd.exe
 *     does not understand single quotes or `$(...)`, so a check string that works
 *     when typed can silently misbehave — and a check that cannot run must never
 *     read like a check that failed.
 *
 * ADVERSARIAL-REVIEW FIXES (2026-07-25, fixtures in the review record)
 * ────────────────────────────────────────────────────────────────────
 *   - Staged detection is now decided on the UNFILTERED `--cached` diff. Before,
 *     a staged pure deletion was invisible (--diff-filter=d), the gate fell back
 *     to the branch diff, and a delete-only commit was judged by unrelated
 *     unstaged edits. source=staged with zero checkable files runs "always" only.
 *   - All git calls pass `-c core.quotepath=off`, and remaining C-quoted paths
 *     (embedded quotes/control bytes) are decoded. Before, any non-ASCII filename
 *     came back C-quoted, failed the existsSync filter, and SILENTLY escaped
 *     every check — a broken ümlaut.js passed the gate.
 *   - Placeholder substitution uses a replacement function: a file named a$&b.js
 *     no longer corrupts the command via String.replace $-patterns; quote() also
 *     escapes embedded double quotes.
 *   - POSIX-sh detection rejects WSL bash (System32 bash.exe launches a Linux VM
 *     that passes the probe but lacks the repo's toolchain); with Git Bash off
 *     PATH the gate now correctly falls back to cmd.exe instead of reporting
 *     TOOLING for every check.
 *   - A category match pattern that matches a literal backslash draws a stderr
 *     warning (git paths are POSIX; such patterns usually never match).
 *
 * RECURSION TRIPWIRE
 * ──────────────────
 * This tool is itself `commands.gate` in the manifest. verify-affordances PROBES the
 * declared gate command by executing it — so if a config check here invoked
 * verify-affordances probing, the gate would run the prober which runs the gate,
 * forever. A config check may reference verify-affordances ONLY with --scan-only;
 * anything else is rejected at config load (exit 2). Enforced in validateConfig(),
 * not just stated.
 *
 * CONTRACT
 * ────────
 *   config   precommit.config.json at the repo root, or --config <path>.
 *            { "base": "origin/develop"?,
 *              "categories": [ { "id", "match": [regex vs repo-relative POSIX paths],
 *                                "checks": [ { "name", "run", "perFile"?, "warn"? } ] } ],
 *              "always": [checks], "fallback": { "checks": [checks] } }
 *   files    staged if any; else diff vs --base / config.base / manifest
 *            branches.integration -> origin/<integration> / origin/develop /
 *            origin/main; --all = every tracked file. No changes -> "always" only.
 *   placeholders  {file} one file (perFile), {files} space-joined double-quoted,
 *            {filelist} path to a temp file of newline-separated paths.
 *   output   first line machine-readable (source/base/files/config), one
 *            OK/FAIL/WARN/TOOLING line per check with elapsed seconds, summary last.
 *   exit     0 clean, 1 any non-warn check failed (FAIL or TOOLING), 2 usage/config
 *            error. Fails closed: internal errors exit 2, never 0.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Prefer POSIX sh (see header). Same detection pattern as evals/run-eval.js, PLUS
// a WSL rejection the review added: on Windows, C:\Windows\System32\bash.exe is the
// WSL *launcher* — it passes an `exit 0` probe but runs commands inside a Linux VM
// where the repo's Windows toolchain (node, npx, ...) does not exist, turning every
// check into TOOLING. Git Bash reports uname MINGW*/MSYS*; WSL reports Linux.
const POSIX_SH = (() => {
  for (const candidate of ['bash', 'sh']) {
    const probe = spawnSync(candidate, ['-c', 'uname'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) continue;
    if (process.platform === 'win32' && /\blinux\b/i.test(probe.stdout || '')) continue;
    return candidate;
  }
  return null;
})();

const CHECK_TIMEOUT_MS = 900000;

function sh(cmd, opts = {}) {
  if (POSIX_SH) return spawnSync(POSIX_SH, ['-c', cmd], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, ...opts });
  return spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, ...opts });
}

// Git hooks leak repo-location vars into children; scrub them (union of both source
// repos' lists — each learned a different subset the hard way).
const GIT_LOCATION_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
];

function childEnv() {
  const env = { ...process.env };
  for (const v of GIT_LOCATION_VARS) delete env[v];
  return env;
}

class ConfigError extends Error {}

function git(args, cwd) {
  // core.quotepath=off: with the default (on), git C-quotes any path containing
  // non-ASCII bytes ("scripts/\303\274mlaut.js", quotes included) — the existsSync
  // filter then drops it and the file SILENTLY escapes every check (found by this
  // review: a broken ümlaut.js passed the gate with files=0). Off means only
  // genuinely unrepresentable names (embedded ", \, control chars) stay quoted;
  // dequoteGitPath below decodes those.
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', env: childEnv() });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

// Decode a git C-quoted path ("a\"b\303\244.js" -> a"bä.js). Octal escapes are
// UTF-8 BYTES, so collect bytes and decode once at the end.
function dequoteGitPath(line) {
  if (line.length < 2 || line[0] !== '"' || line[line.length - 1] !== '"') return line;
  const body = line.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    let ch = body[i];
    if (ch !== '\\') { for (const b of Buffer.from(ch, 'utf8')) bytes.push(b); continue; }
    const next = body[++i];
    if (next >= '0' && next <= '7') {
      let oct = next;
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i];
      bytes.push(parseInt(oct, 8));
    } else {
      const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', a: '\x07', v: '\v', '"': '"', '\\': '\\' };
      for (const b of Buffer.from(simple[next] !== undefined ? simple[next] : next, 'utf8')) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function gitLines(args, cwd) {
  const out = git(args, cwd);
  return out === null ? null : out.split('\n').map((s) => dequoteGitPath(s.trim())).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function validateChecks(checks, where) {
  if (!Array.isArray(checks)) throw new ConfigError(`${where}: "checks" must be an array`);
  for (const c of checks) {
    if (!c || typeof c.name !== 'string' || !c.name) throw new ConfigError(`${where}: every check needs a string "name"`);
    if (typeof c.run !== 'string' || !c.run.trim()) throw new ConfigError(`${where}: check "${c.name}" needs a non-empty "run"`);
    // RECURSION TRIPWIRE (see header): this tool IS commands.gate, and
    // verify-affordances probing executes commands.gate. Only --scan-only is safe.
    if (/verify-affordances/.test(c.run) && !/--scan-only/.test(c.run)) {
      throw new ConfigError(
        `${where}: check "${c.name}" invokes verify-affordances without --scan-only. ` +
        `That recurses: verify-affordances probing runs the gate, which is this tool. ` +
        `Use --scan-only or drop the check.`);
    }
  }
  return checks;
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`config not found: ${configPath} (create precommit.config.json or pass --config)`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(`config is not valid JSON: ${configPath}: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be a JSON object');
  if (!Array.isArray(raw.categories)) throw new ConfigError('config needs a "categories" array');

  const categories = raw.categories.map((cat, i) => {
    if (!cat || typeof cat.id !== 'string' || !cat.id) throw new ConfigError(`categories[${i}]: needs a string "id"`);
    if (!Array.isArray(cat.match) || !cat.match.length) throw new ConfigError(`category "${cat.id}": needs a non-empty "match" array of regex strings`);
    const regexes = cat.match.map((p) => {
      if (typeof p !== 'string') throw new ConfigError(`category "${cat.id}": match entries must be strings`);
      // Windows-authored footgun: a pattern matching a literal backslash separator
      // (JSON "scripts\\\\foo") can never match — git reports POSIX paths. Warn on
      // stderr (not an error: idioms like [\\/] contain a literal-backslash branch
      // yet still match via the /).
      if (p.includes('\\\\')) {
        console.error(`precommit: WARNING: category "${cat.id}" match ${JSON.stringify(p)} matches a literal backslash — changed files are repo-relative POSIX paths (forward slashes); this pattern may never match.`);
      }
      try { return new RegExp(p); } catch (e) { throw new ConfigError(`category "${cat.id}": bad regex ${JSON.stringify(p)}: ${e.message}`); }
    });
    return { id: cat.id, regexes, checks: validateChecks(cat.checks || [], `category "${cat.id}"`) };
  });

  const always = validateChecks(raw.always || [], '"always"');
  const fallbackChecks = raw.fallback ? validateChecks(raw.fallback.checks || [], '"fallback"') : [];
  const base = raw.base === undefined ? null : raw.base;
  if (base !== null && (typeof base !== 'string' || !base)) throw new ConfigError('"base" must be a non-empty string when present');
  return { base, categories, always, fallbackChecks };
}

// ---------------------------------------------------------------------------
// Changed-file set
// ---------------------------------------------------------------------------

function resolveBaseCandidates(explicitBase, config, root) {
  // Precedence: --base flag > config.base > manifest branches.integration >
  // origin/develop > origin/main. Explicit choices are strict (a configured base
  // that does not resolve is a config error, not a silent degrade to a much
  // smaller HEAD diff); the default chain degrades ref by ref.
  if (explicitBase) return { candidates: [explicitBase], strict: true };
  if (config.base) return { candidates: [config.base], strict: true };
  const candidates = [];
  const manifestPath = path.join(root, 'agent-loop.manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const integration = m && m.branches && m.branches.integration;
      if (typeof integration === 'string' && integration) candidates.push(`origin/${integration}`);
    } catch (_) { /* unreadable manifest: fall through to the default chain */ }
  }
  for (const ref of ['origin/develop', 'origin/main']) {
    if (!candidates.includes(ref)) candidates.push(ref);
  }
  return { candidates, strict: false };
}

function changedFiles(root, baseInfo, allFlag) {
  const exists = (f) => fs.existsSync(path.join(root, f));

  if (allFlag) {
    const all = gitLines(['ls-files'], root) || [];
    return { source: 'all', base: '-', files: all.filter(exists) };
  }

  // "Staged if any" must be decided on the UNFILTERED index diff. Deciding on the
  // filtered list made a staged pure deletion (git rm + commit) invisible, so the
  // gate silently fell through to the branch diff and judged the delete-only commit
  // by unrelated unstaged edits to tracked files (found by this review). A staged
  // deletion means "the user is committing the index" — the checkable file set may
  // legitimately be empty.
  const stagedAny = gitLines(['diff', '--cached', '--name-only'], root) || [];
  if (stagedAny.length) {
    const staged = gitLines(['diff', '--cached', '--name-only', '--diff-filter=d'], root) || [];
    return { source: 'staged', base: '-', files: staged.filter(exists) };
  }

  for (const ref of baseInfo.candidates) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root) === null) continue;
    // merge-base so the diff reports this branch's work, not everything that landed
    // on the base since the branch point (ai-questions form).
    const mb = git(['merge-base', ref, 'HEAD'], root);
    const against = mb !== null ? mb.trim() : ref;
    const diff = gitLines(['diff', '--name-only', '--diff-filter=d', against], root) || [];
    return { source: 'diff', base: ref, files: [...new Set(diff)].filter(exists) };
  }
  if (baseInfo.strict) {
    throw new ConfigError(`base ref does not resolve: ${baseInfo.candidates[0]} (fix "base"/--base, or fetch the ref)`);
  }
  // No usable base ref anywhere (fresh repo, no remote): degrade to working tree vs
  // HEAD, loudly in the header line via base=HEAD.
  const diff = gitLines(['diff', '--name-only', '--diff-filter=d', 'HEAD'], root) || [];
  return { source: 'diff', base: 'HEAD', files: [...new Set(diff)].filter(exists) };
}

// ---------------------------------------------------------------------------
// Planning (pure — exported for tests)
// ---------------------------------------------------------------------------

// Multi-match: a file fires EVERY category whose regexes match it (see header for
// why this deliberately differs from both sources' first-match-wins).
function matchFiles(files, categories) {
  const byCategory = new Map(categories.map((c) => [c.id, []]));
  const unmatched = [];
  for (const f of files) {
    let any = false;
    for (const cat of categories) {
      if (cat.regexes.some((re) => re.test(f))) { byCategory.get(cat.id).push(f); any = true; }
    }
    if (!any) unmatched.push(f);
  }
  return { byCategory, unmatched };
}

const quote = (f) => `"${f.replace(/"/g, '\\"')}"`;
// Substitute a placeholder whether or not the config author already quoted it —
// `node --check "{file}"` and `node --check {file}` must both produce one level
// of quoting (files with spaces are in the lifelift unit-test edge-case list).
// The replacement is a FUNCTION so String.replace never interprets $-patterns in
// the value: a file named `a$&b.js` used to expand to `a{file}b.js` (found by
// this review).
const sub = (cmd, token, value) => cmd.replace(new RegExp(`"?\\{${token}\\}"?`, 'g'), () => value);

/**
 * Expand one check over a file set into concrete invocations.
 * perFile:true (or a {file} placeholder, which implies it) => one invocation per
 * file. {filelist} is deferred: the temp file is created at run time and cleaned up.
 */
function buildInvocations(check, files) {
  const perFile = Boolean(check.perFile) || /\{file\}/.test(check.run);
  if (perFile) {
    return files.map((f) => ({
      label: `${check.name} ${f}`,
      cmd: sub(sub(check.run, 'file', quote(f)), 'files', quote(f)),
      files: [f],
    }));
  }
  const hasPlaceholder = /\{(files|filelist)\}/.test(check.run);
  if (hasPlaceholder && files.length === 0) return []; // nothing to point the check at
  return [{
    label: check.name,
    cmd: sub(check.run, 'files', files.map(quote).join(' ')),
    files,
  }];
}

/**
 * Classify a finished child process. THE distinction this pack exists to draw:
 *   FAIL    = the check ran and found problems (a working linter reporting violations)
 *   TOOLING = the check could not run at all (missing binary, unresolvable module,
 *             missing script, timeout). Reads loudly different, still gates.
 */
const TOOLING_RE = new RegExp([
  'command not found',
  'not recognized as an internal or external command',
  "'[^']+' is not recognized",
  'Cannot find module',
  'ERR_MODULE_NOT_FOUND',
  'No such file or directory',
  'missing script:',
  "couldn't find .*config",
  'no configuration file',
].join('|'), 'i');

function classify(r) {
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error && r.error.code === 'ETIMEDOUT') return { status: 'TOOLING', why: `timed out after ${CHECK_TIMEOUT_MS / 1000}s` };
  if (r.error) return { status: 'TOOLING', why: `could not spawn: ${r.error.message}` };
  if (r.status === 0) return { status: 'OK', why: '' };
  if (r.status === 127 || r.status === 9009 || TOOLING_RE.test(out)) {
    return { status: 'TOOLING', why: `exit ${r.status} — the check could not run` };
  }
  return { status: 'FAIL', why: `exit ${r.status}` };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

let tmpCounter = 0;

function runInvocation(inv, check, categoryId, root, tally) {
  let cmd = inv.cmd;
  let tmp = null;
  if (/\{filelist\}/.test(cmd)) {
    tmp = path.join(os.tmpdir(), `precommit-filelist-${process.pid}-${tmpCounter++}.txt`);
    fs.writeFileSync(tmp, inv.files.join('\n') + '\n');
    cmd = sub(cmd, 'filelist', quote(tmp.replace(/\\/g, '/')));
  }
  const started = Date.now();
  let r;
  try {
    r = sh(cmd, { cwd: root, env: childEnv() });
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ } }
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  let { status, why } = classify(r);

  // warn:true never gates. A failing warn check prints WARN; a warn check that
  // cannot RUN still prints TOOLING (a dead check must never look like a soft one)
  // but does not gate either.
  const gates = !check.warn;
  if (check.warn && status === 'FAIL') status = 'WARN';

  const notes = [];
  if (why) notes.push(why);
  if (status === 'TOOLING') notes.push('CHECK COULD NOT RUN — toolchain/config problem, NOT a code failure. Fix the tooling before trusting this gate.');
  if (!gates && status !== 'OK') notes.push('warn-only, does not gate');

  console.log(`${status.padEnd(7)} [${categoryId}] ${inv.label} (${secs}s)${notes.length ? ' — ' + notes.join('; ') : ''}`);
  if (status !== 'OK') {
    const detail = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (detail) console.log(detail.split('\n').slice(0, 30).map((l) => `        ${l}`).join('\n'));
  }

  tally[status.toLowerCase()]++;
  if (gates && (status === 'FAIL' || status === 'TOOLING')) tally.gateFailed = true;
}

function runChecks(checks, files, categoryId, root, tally) {
  for (const check of checks) {
    const invocations = buildInvocations(check, files);
    if (!invocations.length && /\{(file|files|filelist)\}/.test(check.run)) {
      console.log(`note    [${categoryId}] ${check.name}: file placeholder with no files — skipped`);
      continue;
    }
    for (const inv of invocations) runInvocation(inv, check, categoryId, root, tally);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let configFlag = null;
  let baseFlag = null;
  let allFlag = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') configFlag = args[++i];
    else if (args[i] === '--base') baseFlag = args[++i];
    else if (args[i] === '--all') allFlag = true;
    else throw new ConfigError(`unknown argument: ${args[i]} (usage: precommit.js [--config <path>] [--base <ref>] [--all])`);
  }
  if (configFlag === undefined || baseFlag === undefined) throw new ConfigError('--config/--base need a value');

  const rootOut = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (rootOut === null) throw new ConfigError('not inside a git repository');
  const root = rootOut.trim();

  const configPath = path.resolve(root, configFlag || 'precommit.config.json');
  const config = loadConfig(configPath);

  const baseInfo = resolveBaseCandidates(baseFlag, config, root);
  const { source, base, files } = changedFiles(root, baseInfo, allFlag);

  // First line: machine-readable run header.
  console.log(`precommit: source=${source} base=${base} files=${files.length} config=${path.relative(root, configPath) || '.'}`);

  const tally = { ok: 0, fail: 0, warn: 0, tooling: 0, gateFailed: false };
  const started = Date.now();

  if (files.length === 0 && !allFlag) {
    console.log(source === 'staged'
      ? 'precommit: staged change has no checkable files (deletions only) — running "always" checks only.'
      : 'precommit: no changed files — running "always" checks only.');
    runChecks(config.always, [], 'always', root, tally);
  } else {
    runChecks(config.always, files, 'always', root, tally);
    const { byCategory, unmatched } = matchFiles(files, config.categories);
    for (const cat of config.categories) {
      const catFiles = byCategory.get(cat.id);
      if (!catFiles.length) continue;
      if (!cat.checks.length) {
        console.log(`note    [${cat.id}] ${catFiles.length} file(s), no checks configured — skipped by design`);
        continue;
      }
      runChecks(cat.checks, catFiles, cat.id, root, tally);
    }
    if (unmatched.length) {
      if (config.fallbackChecks.length) {
        runChecks(config.fallbackChecks, unmatched, 'fallback', root, tally);
      } else {
        console.log(`note    [fallback] ${unmatched.length} file(s) matched no category and no fallback is configured: ${unmatched.join(', ')}`);
      }
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const verdict = tally.gateFailed ? 'FAIL' : 'PASS';
  console.log(`precommit: ${verdict} ok=${tally.ok} fail=${tally.fail} warn=${tally.warn} tooling=${tally.tooling} (${secs}s)`);
  return tally.gateFailed ? 1 : 0;
}

module.exports = { matchFiles, buildInvocations, classify, loadConfig, TOOLING_RE };

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`precommit: CONFIG ERROR: ${e.message}`);
      process.exit(2);
    }
    // Fail closed: an internal error must never read as a clean pass.
    console.error(`precommit: INTERNAL ERROR (failing closed): ${e && e.stack || e}`);
    process.exit(2);
  }
}
