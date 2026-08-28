#!/usr/bin/env node
/**
 * verify-affordances.js — the deterministic answer to "a named check that does nothing".
 *
 * WHY THIS EXISTS
 * ───────────────
 * Prompt-review premise P4: verbal instruction alone changes style; AFFORDANCES change
 * reliability. A rule like "lint before you push" earns its context cost only when the
 * thing it names can actually be invoked. Unpaired, it is theater that still costs
 * attention on every turn.
 *
 * The failure this gate is built from is real and was measured, not imagined. In
 * lifelift-mobile-backend, three separate agent prompts named `npx eslint` as a
 * verification step. On 2026-07-24 it was executed and found to lint NOTHING:
 *   - repo root pinned eslint ^10.6.0 but shipped only a legacy .eslintrc.json, so
 *     eslint 10 exited with "couldn't find eslint.config.(js|mjs|cjs)";
 *   - functions/ declared ^8.57.1 but never installed it, so npx resolved 10.x there
 *     too and failed identically;
 *   - the repo's own precommit script called `npx --no-install eslint` and therefore
 *     failed for the same reason.
 * It had been dead ~25 days (tracked as #532). Every loop run in that window reported
 * work as checked. Nothing detected it, because nothing distinguished "the check ran
 * and found no problems" from "the check could not run at all" — those are the same
 * shape to a reader, and opposite in meaning.
 *
 * Worse: an automated audit of those same prompts proposed fixing it by routing lint
 * through `cd functions && npx eslint`. That was also broken. A reviewer reading rather
 * than executing would have shipped a second dead command as the fix for the first.
 * Reading cannot catch this class. Only execution can.
 *
 * WHAT IT CHECKS
 * ──────────────
 *   probe : every command declared in the manifest RESOLVES (the tool is installed and
 *           can start). Not "passes" — resolves. A linter reporting violations is
 *           healthy; a linter that cannot find its config is not.
 *   scan  : no prompt/skill file names a stack command that the manifest does not
 *           declare, and none cites a capability the manifest declares as null.
 *
 * Exit 0 = clean, 1 = findings, 2 = usage/config error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Stack build/test tooling. A prompt naming one of these directly has inlined a
// stack-specific command instead of resolving it through the manifest — which is how
// prompts drift out of sync with the repo and how the same command gets stated three
// different ways in three files. Deliberately excludes git/gh/cd/ls/grep: those are
// well represented in training, stable across repos, and cost nothing to name.
const STACK_TOOLS = [
  'npm', 'npx', 'yarn', 'pnpm', 'node', 'make', 'cargo', 'pytest', 'python', 'python3',
  'go', 'dotnet', 'swift', 'xcodebuild', 'mvn', 'gradle', './gradlew', 'gradlew',
  'bundle', 'rake', 'composer', 'php', 'ruby', 'deno', 'bun', 'tox', 'poetry', 'pip',
];

function fail(msg) { console.error(`verify-affordances: ${msg}`); process.exit(2); }

// Minimal YAML reader for the flat manifest shapes we need. Avoids adding a dependency
// to every subscribing repo — this gate must run before `install` is known to work.
function readManifest(file) {
  if (!fs.existsSync(file)) fail(`manifest not found: ${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(raw);
  try {
    // Prefer a real parser when the repo happens to have one.
    const yaml = require('js-yaml');
    return yaml.load(raw);
  } catch (_) {
    fail('js-yaml unavailable and manifest is YAML. Convert to agent-loop.manifest.json or install js-yaml.');
  }
}

function listFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'worktrees'].includes(e.name)) continue;
      listFiles(p, out);
    } else if (/\.(md|markdown)$/i.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Probe one declared command. Uses `probe` when supplied (e.g. "--version"), which is
 * the reliable signal: it proves the tool resolves without running a real job.
 *
 * The critical distinction — and the whole reason this file exists — is between a
 * NON-ZERO EXIT (the tool ran and reported something) and a TOOLING/CONFIG ERROR (the
 * tool could not run at all). We treat the latter as the failure. A linter exiting 1
 * with violations is working; a linter exiting 2 with "couldn't find config" is not.
 */
const CANARY_CONTENT = {
  '.js': "'use strict';\nmodule.exports = {};\n",
  '.mjs': 'export default {};\n',
  '.ts': 'export {};\n',
  '.py': 'pass\n',
  '.rb': "# frozen_string_literal: true\n",
  '.go': 'package canary\n',
};

function probeCommand(key, spec, repoRoot) {
  if (spec === null || spec === undefined) {
    return { key, status: 'declared-absent', detail: 'explicitly null — prompts may not cite it' };
  }
  const cwd = spec.cwd ? path.join(repoRoot, spec.cwd) : repoRoot;
  if (!fs.existsSync(cwd)) return { key, status: 'FAIL', detail: `cwd does not exist: ${spec.cwd}` };

  // A {file} command MUST be probed by actually running it against a real file.
  //
  // This is the hard-won part. An earlier revision probed with `--version`, and it
  // reported the lifelift eslint as HEALTHY — the precise bug this gate exists to catch.
  // `eslint --version` prints a version happily; the failure is in CONFIG RESOLUTION,
  // which only occurs when the tool is asked to process a file. A liveness probe that
  // does not exercise the real code path is worth nothing.
  let cmdline;
  let canaryPath = null;
  if (/\{files?\}/.test(spec.run)) {
    const ext = (spec.canary && path.extname(spec.canary)) || guessExt(spec.run) || '.js';
    canaryPath = path.join(cwd, `.affordance-canary${ext}`);
    fs.writeFileSync(canaryPath, CANARY_CONTENT[ext] || '');
    cmdline = spec.run.replace(/\{files?\}/g, path.basename(canaryPath));
  } else {
    cmdline = spec.probe || spec.run;
  }

  const r = spawnSync(cmdline, { cwd, shell: true, encoding: 'utf8', timeout: 120000 });
  if (canaryPath) { try { fs.unlinkSync(canaryPath); } catch (_) {} }
  const out = `${r.stdout || ''}${r.stderr || ''}`;

  if (r.error && r.error.code === 'ETIMEDOUT') return { key, status: 'FAIL', detail: 'timed out' };
  if (r.status === 127 || /not recognized|command not found|No such file/i.test(out)) {
    return { key, status: 'FAIL', detail: `tool does not resolve: ${firstLine(out)}` };
  }
  // Config/tooling errors masquerading as ordinary failures — the eslint case verbatim.
  const CONFIG_ERROR = /couldn't find .*config|cannot find module|ENOENT|is not configured|no configuration file|missing script|ERR_MODULE_NOT_FOUND|Oops! Something went wrong/i;
  if (CONFIG_ERROR.test(out)) {
    // Report the line that actually matched, not merely the first line of output —
    // tools commonly emit deprecation warnings ahead of the real diagnostic.
    const diag = out.split('\n').map((l) => l.trim()).find((l) => CONFIG_ERROR.test(l));
    return { key, status: 'FAIL', detail: `resolves but is misconfigured: ${diag || firstLine(out)}` };
  }
  // Exit-code policy differs by probe TYPE, and conflating them is how this check stopped
  // being able to fail.
  //
  // CANARY RUN (the command had a {file} placeholder): a non-zero exit is HEALTHY. A linter
  // reporting violations on the canary is a working linter — that is the whole distinction
  // this gate exists to draw, and the genuinely broken cases were already caught above by the
  // 127 and CONFIG_ERROR checks.
  //
  // EXPLICIT PROBE (`eas --version`, `npm run precommit -- --help`): a non-zero exit means the
  // tool did not resolve, and that IS the failure.
  //
  // The previous form was `return ok || r.status !== null ? okBranch : failBranch`, where
  // `r.status !== null` is true for any process that ran at all — so the FAIL branch was
  // unreachable and `expect_exit` was dead. It reported `[ ok ] build exit 1` for an `eas`
  // binary that is not installed. Caught by the first spawned repo's CI, not by review.
  if (canaryPath) return { key, status: 'ok', detail: `ran against canary, exit ${r.status}` };

  const accepted = spec.expect_exit || [0];
  return accepted.includes(r.status)
    ? { key, status: 'ok', detail: `exit ${r.status}` }
    : { key, status: 'FAIL', detail: `probe exited ${r.status}: ${firstLine(out)}` };
}

function firstLine(s) {
  return (s || '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '(no output)';
}

/**
 * Which [CAPABILITY: id] section governs each line, and whether that capability requires a
 * given manifest key. Mirrors the same logic in check-manifest-refs.js — a marker governs
 * until the next markdown heading, which is how these files are structured.
 */
function capabilitySections(lines, capRequires) {
  const govern = new Array(lines.length).fill(null);
  let active = null;
  lines.forEach((line, i) => {
    const m = /\[CAPABILITY:\s*([A-Za-z0-9_-]+)\s*\]/.exec(line);
    if (m && m[1] !== 'id') active = m[1];
    else if (/^#{1,6}\s/.test(line) || /^-{3,}\s*$/.test(line)) active = null;
    govern[i] = active;
  });
  return (i, key) => {
    const cap = govern[i];
    if (!cap) return false;
    return (capRequires.get(cap) || []).some((r) => r === key || key.startsWith(r + '.') || r.startsWith(key + '.'));
  };
}

/** Best-effort file extension for the canary, inferred from the tool being invoked. */
function guessExt(run) {
  if (/\b(eslint|node|npx|jest|prettier)\b/.test(run)) return '.js';
  if (/\b(tsc|ts-node)\b/.test(run)) return '.ts';
  if (/\b(py(test|lint)?|python3?|ruff|black|mypy)\b/.test(run)) return '.py';
  if (/\b(rubocop|ruby)\b/.test(run)) return '.rb';
  if (/\bgo\b/.test(run)) return '.go';
  return null;
}

// Commands that ship WITH the pack. They are legitimately named in pack prompts, are not
// repo stack commands, and are verified by the pack's own self-gate rather than by any
// subscriber's manifest. Without this exemption every subscriber gets a false positive
// the moment a prompt tells them to run a gate.
const PACK_INTERNAL = /(^|[\s/\\])(gates|sync|evals|hooks)[/\\][\w.-]+\.(js|sh)/;

// Unfilled template placeholders — `{{commands.gate.run}}` — are not commands yet.
const PLACEHOLDER = /\{\{.*?\}\}/;

/** Extract backticked inline code that looks like a runnable command. */
function extractCommands(text) {
  const hits = [];
  for (const m of text.matchAll(/`([^`\n]{2,200})`/g)) {
    const s = m[1].trim();
    const head = s.split(/\s+/)[0];
    if (!STACK_TOOLS.includes(head)) continue;
    if (PACK_INTERNAL.test(s) || PLACEHOLDER.test(s)) continue;
    hits.push(s);
  }
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i === -1 ? dflt : args[i + 1];
  };
  const repoRoot = path.resolve(get('--repo', process.cwd()));
  const manifestPath = path.resolve(get('--manifest', path.join(repoRoot, 'agent-loop.manifest.yml')));
  // Default scan scope is the directories that contain INSTRUCTIONS TO THIS REPO'S AGENTS —
  // not the whole repo. Scanning everything sounds safer and is not: `review/` holds the
  // prompt-review rubric, whose worked examples deliberately quote OTHER stacks
  // (`pytest tests/unit -x`, `make openapi`) to illustrate a point. Those are teaching
  // material, not instructions, and flagging them trains people to ignore this gate.
  // Measured: the first spawned repo's CI failed on exactly those two lines.
  const DEFAULT_SCAN = ['prompts', 'skills', '.claude'];
  const promptDirs = (get('--prompts', null) || DEFAULT_SCAN.join(','))
    .split(',')
    .map((d) => path.resolve(repoRoot, d.trim()))
    .filter((d) => fs.existsSync(d));
  const doProbe = !args.includes('--scan-only');
  const doScan = !args.includes('--probe-only');

  const manifest = readManifest(manifestPath);

  const regPath = path.join(__dirname, '..', 'capabilities.json');
  const capRequires = new Map();
  if (fs.existsSync(regPath)) {
    for (const c of JSON.parse(fs.readFileSync(regPath, 'utf8')).capabilities) capRequires.set(c.id, c.requires || []);
  }
  const commands = manifest.commands || {};
  let findings = 0;

  if (doProbe) {
    console.log('── probe: do declared commands actually resolve? ──');
    for (const [key, spec] of Object.entries(commands)) {
      const r = probeCommand(key, spec, repoRoot);
      const tag = r.status === 'FAIL' ? 'FAIL' : r.status === 'ok' ? ' ok ' : r.status === 'declared-absent' ? 'null' : 'skip';
      if (r.status === 'FAIL') findings++;
      console.log(`  [${tag}] ${key.padEnd(10)} ${r.detail}`);
    }
  }

  if (doScan) {
    console.log('\n── scan: do prompts name commands the manifest does not declare? ──');
    const declared = new Set(
      Object.entries(commands)
        .filter(([, v]) => v && v.run)
        .map(([, v]) => v.run.replace(/\s*\{files?\}\s*/g, '').trim())
    );
    const nullKeys = Object.entries(commands).filter(([, v]) => v === null).map(([k]) => k);

    for (const dir of promptDirs) {
      for (const file of listFiles(dir)) {
        const text = fs.readFileSync(file, 'utf8');
        const rel = path.relative(repoRoot, file);
        for (const cmd of new Set(extractCommands(text))) {
          const normalized = cmd.replace(/\s*<[^>]*>\s*/g, '').trim();
          const known = [...declared].some((d) => normalized.startsWith(d) || d.startsWith(normalized));
          if (!known) {
            findings++;
            console.log(`  [FAIL] ${rel}: names undeclared stack command \`${cmd}\``);
          }
        }
        // A prompt must not cite a capability the manifest says does not exist — UNLESS the
        // citation sits inside a [CAPABILITY: id] section whose capability requires that
        // command. Such a section is conditional by construction: a subscriber without the
        // capability deletes it, and a subscriber with it has the command declared.
        //
        // Without this the pack's own generic prompts fail in every repo that legitimately
        // lacks an optional tier. Measured: daily-nonogram's first CI run failed on
        // contributor.md and daily-review.md citing test_real and cantfail — both already
        // correctly gated, and both flagged anyway. A gate that fails correct configurations
        // gets switched off, and then it protects nothing.
        const lines = text.split('\n');
        const govern = capabilitySections(lines, capRequires);
        for (const key of nullKeys) {
          // `\b` is too loose: `-` `_` `/` `.` all count as word boundaries, so a key like
          // `lint` matched inside the FILENAME `lint-skill-frontmatter.js`. Require the key
          // to stand alone as a token, not to be a fragment of a longer identifier or path.
          const re = new RegExp(`(?<![\\w/.-])${key}(?![\\w/.-])`, 'i');
          lines.forEach((line, i) => {
            if (!re.test(line)) return;
            if (/no (working )?\w*lint|is dead|runs nowhere|does not exist|NOT AVAILABLE/i.test(line)) return;
            if (govern(i, `commands.${key}`)) return;   // conditional by construction
            findings++;
            console.log(`  [FAIL] ${rel}:${i + 1}: cites '${key}', which the manifest declares as null (absent)`);
          });
        }
      }
    }
  }

  console.log(findings === 0 ? '\nverify-affordances: clean' : `\nverify-affordances: ${findings} finding(s)`);
  process.exit(findings === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { probeCommand, extractCommands, STACK_TOOLS };
