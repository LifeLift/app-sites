#!/usr/bin/env node
/**
 * PreToolUse guardrail hook — blocks mutating git operations aimed at the
 * SHARED clone (C:\Users\skaiser\source\repos\ai-questions), per the
 * working-directory rule in claude-copilot-pr-monitor.md /
 * claude-director-weekly-review.md: all git work happens in the session's
 * OWN worktree; `git -C`-ing (or --git-dir-ing) into the shared clone and
 * mutating it has corrupted concurrent sessions' work more than once
 * (2026-07-10, 2026-W29 director record).
 *
 * ── ARCHITECTURE: DEFAULT-DENY VERB ALLOWLIST (not flag refereeing) ──────────
 * Earlier revisions tried to adjudicate WHICH FLAGS are dangerous
 * (`--force`, `-f`, `clean -fd`, `branch -D`, ...). That is the wrong
 * architecture: the flag parser was bypassed twice in two days —
 *   1. bundled short-option clusters: `push -uf` / `-fu` / `-qf` (the `-f`
 *      hid inside a cluster the isolated-`-f` regex never matched);
 *   2. option-VALUE confusion: `git push -o -o -f origin HEAD:main` and
 *      `git clean -e -e -f` (the second `-o`/`-e` is swallowed as the first
 *      one's value, shifting the real `-f` out of the parser's view).
 * This is the same lesson as #809/#813, where a regex guard fell six times
 * before the shell it was guarding was removed. So we STOP parsing flags.
 *
 * The working-directory rule this hook enforces says NO session may mutate the
 * shared clone AT ALL. So the guard no longer asks "is this flag dangerous?" —
 * it asks only "what git VERB is this, and does it target the shared clone?".
 * When the target repository is the shared clone, EVERY mutating verb is
 * blocked unconditionally, with NO flag parsing beyond identifying the verb
 * (the first non-option token). We use an ALLOWLIST of read-only verbs and
 * DEFAULT-DENY everything else — including verbs we don't recognize (fail
 * closed) — so a newly-invented or unusual mutating verb cannot slip through a
 * denylist we forgot to update. Behavior on every other path is unchanged:
 * anything targeting a different repo is allowed.
 *
 * Hook contract: reads the PreToolUse payload from stdin; for Bash tool calls,
 * denies via hookSpecificOutput.permissionDecision. Fails OPEN on any error —
 * a broken guardrail must never block legitimate work.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// The one repository no session may mutate. Everything else is allowed.
// ── CONFIG FROM THE MANIFEST (template port) ────────────────────────────────
// The original carried a hard-coded path. In the pack it resolves from the repo's
// agent-loop manifest, so one hook body serves every subscriber and there is exactly
// one place a clone path is written down.
//
// Resolution order: AGENT_LOOP_MANIFEST env override -> manifest at the repo root,
// walking up from cwd. If no manifest is found, the guard DISABLES ITSELF rather than
// guessing — a guard that fires on the wrong path would block legitimate work
// everywhere, which is worse than the gap it closes. Missing config is loud at adoption
// time via gates/check-capabilities.js, not silently improvised here.
function loadConfig() {
  const envPath = process.env.AGENT_LOOP_MANIFEST;
  const candidates = [];
  if (envPath) candidates.push(envPath);
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'agent-loop.manifest.json'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const c of candidates) {
    try {
      const m = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (m && m.repo && m.repo.shared_clone) {
        return {
          sharedRoot: m.repo.shared_clone,
          worktreesRel: '\\' + String(m.repo.worktrees_rel || '.claude/worktrees').replace(/\//g, '\\').replace(/^\\/, ''),
        };
      }
    } catch (_) { /* keep looking */ }
  }
  return null;
}

const CONFIG = loadConfig();
const SHARED_ROOT = CONFIG ? CONFIG.sharedRoot : null;

// Chain separators split one shell command into independent invocations, so a
// verb in a later `&&`/`||`/`;`/`|` segment isn't attributed to an earlier one
// (and vice-versa). Each segment is evaluated on its own.
const CHAIN_SEPARATOR_RE = /&&|\|\||;|\n|&|\|/;

// Git GLOBAL options (those that appear BEFORE the verb) that consume the
// following whitespace-separated token as their value. We skip both the option
// and its value while hunting for the verb, so a path or config value is never
// mistaken for the verb. `-C` also has an attached form (`-C<path>` /
// `-C"<path>"`) handled separately.
const GLOBAL_VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace',
  '--exec-path', '--config-env', '--attr-source', '--super-prefix'
]);

// READ-ONLY verb allowlist. A verb qualifies ONLY if it is read-only in ALL of
// its forms — i.e. no flag or subcommand of it can mutate the working tree,
// index, HEAD, local refs, config, or stash. Verbs that are read-only in some
// forms but mutating in others (branch, tag, stash, reflog, worktree, remote,
// config, notes, submodule, gc, ...) are DELIBERATELY excluded: since we do no
// flag parsing, allowing them by verb would re-open exactly the bypass class
// this architecture exists to close. Excluding them merely over-blocks a rare
// read against the shared clone (run it in your own worktree instead) — the
// safe direction to err. `fetch` is included per the working-directory rule:
// it writes only remote-tracking refs and the object store, never a concurrent
// session's working tree, index, HEAD, or local branches.
const READ_ONLY_VERBS = new Set([
  'status', 'log', 'diff', 'show', 'fetch',
  'ls-files', 'ls-tree', 'ls-remote',
  'rev-parse', 'rev-list',
  'blame', 'annotate', 'grep', 'cat-file',
  'show-ref', 'show-branch', 'for-each-ref',
  'describe', 'shortlog', 'name-rev', 'whatchanged',
  'merge-base', 'diff-tree', 'diff-index', 'diff-files',
  'cherry', 'count-objects', 'verify-commit', 'verify-tag',
  'var', 'help', 'version'
]);

function tokenize(segment) {
  return segment.trim().split(/\s+/).filter(Boolean);
}

// Normalize a Windows path for comparison: strip surrounding quotes, unify
// separators to backslash, collapse duplicate separators, strip trailing
// separators, lowercase (Windows is case-insensitive). Pure string transform,
// so it works even for paths that don't exist on this machine (as in tests).
function normalizePath(p) {
  if (!p) return '';
  let s = String(p).trim();
  s = s.replace(/^["']+/, '').replace(/["']+$/, '');
  s = s.replace(/\//g, '\\');
  s = s.replace(/\\+/g, '\\');
  s = s.replace(/\\+$/, '');
  return s.toLowerCase();
}

const SHARED_NORM = normalizePath(SHARED_ROOT);

// Best-effort realpath (catches subst: drives, junctions, symlinks that alias
// the shared clone under a different literal path). Returns '' if the path
// can't be resolved on this machine — the common case in tests — so callers
// fall back to the pure-string comparison below.
function realNorm(p) {
  const cleaned = String(p || '').trim().replace(/^["']+/, '').replace(/["']+$/, '');
  if (!cleaned) return '';
  try {
    const resolver = (fs.realpathSync && fs.realpathSync.native) || fs.realpathSync;
    return normalizePath(resolver(cleaned));
  } catch (_) {
    return '';
  }
}

const SHARED_REAL = realNorm(SHARED_ROOT);

// ── SANCTIONED SESSION WORKTREES ────────────────────────────────────────────
// In this repo's layout, every session's OWN worktree lives UNDER the shared
// root at `<shared>\.claude\worktrees\<name>`. Those worktrees are the sanctioned
// per-session workspaces the working-directory rule tells sessions to use — the
// guard exists to protect the shared root's OWN working tree, NOT to fence
// sessions out of their own worktrees. So BOTH layers must treat any path under
// `<shared>\.claude\worktrees\` as NOT-the-shared-clone: a session doing
// `git -C "<own-worktree>" commit` (direct or wrapped) is doing exactly what the
// rule prescribes. (Without this, the guard both wrongly blocks legitimate
// worktree git — panel Finding C — and, via the coarse layer, wrongly blocks
// ordinary commands that merely NAME a worktree path — panel Finding B.)
const WORKTREES_REL = CONFIG ? CONFIG.worktreesRel : '\\.claude\\worktrees';
const WORKTREES_PREFIXES = [
  SHARED_NORM + WORKTREES_REL,
  ...(SHARED_REAL ? [SHARED_REAL + WORKTREES_REL] : [])
];

// True when a NORMALIZED path lies strictly under a `.claude\worktrees\` subtree
// of the shared root — i.e. inside some session's sanctioned worktree. The
// worktrees directory itself (`<shared>\.claude\worktrees`, no trailing child)
// is part of the shared working tree and is deliberately NOT excluded.
function isSanctionedWorktreePath(normCandidate) {
  return WORKTREES_PREFIXES.some((w) => normCandidate.startsWith(w + '\\'));
}

// True when `candidate` refers to the shared clone: either exactly its root,
// or any path inside it (a `.git` dir, a subdirectory — `git -C`/`--git-dir` on
// any of them operates on the shared repository) — EXCEPT a session's own
// sanctioned worktree under `.claude\worktrees\`, which is excluded above. Both
// the literal string and, when resolvable, the realpath are compared, so
// subst/junction aliases and mixed separator/case/trailing-slash spellings all
// resolve to the same repo.
function pathTargetsShared(candidate) {
  if (!candidate) return false;
  const cands = [normalizePath(candidate)];
  const real = realNorm(candidate);
  if (real) cands.push(real);
  const targets = [SHARED_NORM];
  if (SHARED_REAL) targets.push(SHARED_REAL);
  for (const c of cands) {
    if (!c) continue;
    if (isSanctionedWorktreePath(c)) continue; // session's own worktree — sanctioned
    for (const t of targets) {
      if (c === t || c.startsWith(t + '\\')) return true;
    }
  }
  return false;
}

// Collect every path a git segment aims at via a directory-targeting global
// option: `-C <path>`, `-C<path>`, `-C"<path>"`, `--git-dir[=| ]<path>`,
// `--work-tree[=| ]<path>`. These are exactly how a session targets a repo
// other than its cwd — i.e. how it would reach into the shared clone.
function targetPaths(tokens) {
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-C' || t === '--git-dir' || t === '--work-tree') {
      if (i + 1 < tokens.length) paths.push(tokens[i + 1]);
    } else if (t.startsWith('-C') && t.length > 2) {
      paths.push(t.slice(2));
    } else if (t.startsWith('--git-dir=')) {
      paths.push(t.slice('--git-dir='.length));
    } else if (t.startsWith('--work-tree=')) {
      paths.push(t.slice('--work-tree='.length));
    }
  }
  return paths;
}

// The verb is the FIRST non-option token after `git`, once global options
// (and their space-separated values) are consumed. No flags on the verb itself
// are inspected. Returns null if the segment has no git invocation or no verb
// (e.g. `git -C <path> --version`), meaning there is no operation to block.
function gitVerb(tokens) {
  let i = 0;
  while (i < tokens.length && !/(^|[\\/])git(\.exe)?$/i.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  i++; // step past `git`
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      // `-C<path>` attached form carries its own value in the same token.
      if (name === '-C' && t.length > 2) {
        i += 1;
      } else if (eq === -1 && GLOBAL_VALUE_OPTS.has(name)) {
        i += 2; // skip the option AND its value token
      } else {
        i += 1; // boolean flag or `--opt=value` form
      }
      continue;
    }
    return t.toLowerCase(); // first non-option token = the verb
  }
  return null;
}

// A command is blocked iff ANY of its chained segments runs a git verb that
// (a) targets the shared clone and (b) is not on the read-only allowlist.
// Unknown/unrecognized verbs fail CLOSED (blocked). Segments targeting any
// other repo, and segments with no verb, are allowed.
function blockedVerb(command) {
  const segments = command.split(CHAIN_SEPARATOR_RE);
  for (const seg of segments) {
    if (!/(^|[\s\\/])git(\.exe)?(\s|$)/i.test(seg)) continue;
    const tokens = tokenize(seg);
    if (!targetPaths(tokens).some(pathTargetsShared)) continue;
    const verb = gitVerb(tokens);
    if (verb === null) continue; // options only — no operation
    if (!READ_ONLY_VERBS.has(verb)) return verb;
  }
  return null;
}

// ── COARSE FAIL-CLOSED LAYER (belt-and-suspenders over the tokenizer) ─────────
// The tokenizer above only adjudicates DIRECTLY-parsed, top-level git
// invocations — its git-detection regexes require the character before `git`
// to be start-of-string, whitespace, or a slash. It is therefore blind, BY
// CONSTRUCTION, to git that has been handed to a subshell or interpreter, where
// `git` is preceded by `(`, `"`, or `'`:
//   (git -C "<shared>" push -f origin main)
//   bash -c "git -C '<shared>' push -f origin main"
//   sh   -c "git -C '<shared>' push -f origin main"
//   powershell -Command "git -C '<shared>' clean -xfd"
//   (git --git-dir="<shared>\.git" commit -m x)
//   (git -C "<shared>" quantumforce)          // even an unknown verb
//   'git' -C "<shared>" push ...              // single-quoted git token
//   bash -c "git -C \"<shared>\" push ..."    // escaped-quote nesting
// The #865 redesign closed the flag-trick bypass class but RE-OPENED this
// WRAPPER class: because the tokenizer never recognizes `git` in those forms,
// the command is silently ALLOWED (issue #652 regression, panel-confirmed).
//
// RATIONALE for blocking every wrapped form unconditionally: there is NO
// legitimate reason to wrap a git command aimed at the shared clone in a
// subshell or interpreter. Even a read can — and must — be done unwrapped
// (`git -C "<shared>" status`), which the tokenizer already permits. So this
// layer fails CLOSED: if the RAW command references the shared clone (the shared
// ROOT working tree — NOT a sanctioned `.claude\worktrees\` session worktree
// beneath it) AND actually RUNS git (a PARSED git token somewhere in the
// segment — `git`/`git.exe`, bare or wrapped in `(` `"` `'` `$(` `` ` `` — NOT a
// mere `git` substring like `github`/`gitignore`/`...-git.js`) AND the segment
// is NOT a directly-parsed top-level git command the tokenizer approved as
// read-only, we BLOCK. Wrapped = blocked, full stop. Two things this layer must
// NOT do (panel Finding B, the regression this revision fixes): fire on a
// command that merely NAMES a path containing the substring "git" but runs no
// git (`echo "...block-shared-clone-git.js"`), or fence a session out of its own
// worktree. The two layers are INDEPENDENT: the tokenizer adjudicates direct git
// by verb; this layer blocks everything wrapped, ignoring token boundaries.

// Kill switch used only by the mutation-proof tests to disable this layer and
// demonstrate that the wrapper block lives ENTIRELY here (tokenizer unaffected).
const COARSE_DISABLED = process.env.BLOCK_SHARED_CLONE_DISABLE_COARSE === '1';

// Mutation-proof switch: when set, the coarse layer reverts its git-detection to
// the OLD naive SUBSTRING test (`/git/` anywhere in the segment) instead of the
// parsed-git-token scan below. The regression tests flip this on to prove the
// token requirement is load-bearing: under substring mode the panel's
// false-positive payloads (`echo "...block-shared-clone-git.js"`, etc.) go RED
// (wrongly blocked again); with it off they are ALLOWED. Never set in production.
const COARSE_SUBSTRING_MODE = process.env.BLOCK_SHARED_CLONE_COARSE_SUBSTRING === '1';

// Every normalized spelling of the shared clone the coarse scan matches against.
const SCAN_TARGETS = [SHARED_NORM, ...(SHARED_REAL ? [SHARED_REAL] : [])];

// Normalize a whole command string for coarse SUBSTRING scanning: unify
// separators to backslash, collapse duplicate separators, lowercase. Unlike
// normalizePath this deliberately does NOT strip quotes or trailing separators —
// it scans the raw string as-is for the shared path appearing in ANY position
// (inside quotes, after `-C`, nested inside a `bash -c` argument), so token
// boundaries never matter. A reference that continues into
// `\.claude\worktrees\<name>` points at a SANCTIONED session worktree, not the
// shared root working tree, and does NOT count (panel Finding B/C).
function rawReferencesShared(str) {
  const scan = String(str || '').replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
  for (const t of SCAN_TARGETS) {
    if (!t) continue;
    let idx = scan.indexOf(t);
    while (idx !== -1) {
      const after = scan.slice(idx + t.length);
      if (!/^\\\.claude\\worktrees\\/.test(after)) return true; // real shared-root ref
      idx = scan.indexOf(t, idx + 1); // this occurrence was a worktree path; keep looking
    }
  }
  return false;
}

// A raw token IS a git invocation iff, after stripping the shell grouping /
// quoting / substitution punctuation that clings to a wrapped git token
// (`(git`, `"git`, `'git`, `$(git`, `` `git ``, `git"`, `x)` ...), it is a bare
// `git`/`git.exe` OR a path-qualified one (`/usr/bin/git`, `C:\...\git.exe`).
// This is the tokenizer's own boundary regex, applied token-by-token across the
// WHOLE segment so it also sees git that the top-level parser is blind to. It
// REJECTS mere substrings — `github`, `gitignore`, `digit`, `legitimate`, or a
// filename like `block-shared-clone-git.js` — which is the entire point: the old
// `/git/` substring test over-blocked ordinary commands that only NAME such a
// path (panel Finding B).
function tokenIsGit(token) {
  const stripped = String(token)
    .replace(/^[('"`${]+/, '')
    .replace(/[)'"`}]+$/, '');
  return /(^|[\\/])git(\.exe)?$/i.test(stripped);
}

// A segment "runs git" (for the coarse layer) iff some token is a git token.
// Under the mutation-proof substring switch, fall back to the old naive test.
function segmentRunsGit(seg, tokens) {
  if (COARSE_SUBSTRING_MODE) return /git/i.test(seg);
  return tokens.some(tokenIsGit);
}

// The ONE shape the coarse layer exempts: a directly-parsed top-level git
// command (its FIRST token IS the git executable) whose verb the tokenizer
// treats as read-only — or which carries no verb at all (an options-only
// invocation like `git -C <shared> --version`). This is exactly the direct read
// the tokenizer already permits against the shared clone; everything else that
// references the shared clone and runs git is a wrapped/delegated form.
function isDirectApprovedReadOnlyGit(tokens) {
  const first = tokens[0];
  if (!first || !/(^|[\\/])git(\.exe)?$/i.test(first)) return false;
  const verb = gitVerb(tokens);
  return verb === null || READ_ONLY_VERBS.has(verb);
}

// Coarse layer: block any chained segment that references the shared clone AND
// actually RUNS git (a parsed git token, not a mere `git` substring), unless it
// is the one exempt shape (direct read-only git). Returns the offending raw
// segment (for the deny message), or null.
function coarseWrapperBlocked(command) {
  if (COARSE_DISABLED) return null;
  const segments = command.split(CHAIN_SEPARATOR_RE);
  for (const seg of segments) {
    if (!rawReferencesShared(seg)) continue;
    const tokens = tokenize(seg);
    if (!segmentRunsGit(seg, tokens)) continue;
    if (isDirectApprovedReadOnlyGit(tokens)) continue;
    return seg.trim();
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function allow() {
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

async function main() {
  // No manifest, no shared clone declared -> nothing to protect. Disable rather than
  // guess: a guard aimed at the wrong path denies legitimate work in every session.
  if (!SHARED_ROOT) return allow();

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return allow(); // malformed/absent payload — fail open
  }

  // Both shells can issue git. PowerShell is the PRIMARY shell on this Windows host and this
  // harness exposes it as a first-class tool separate from Bash, so gating on 'Bash' alone left
  // the shared-clone rule unenforced on the most-used path — `git -C "<shared>" checkout` via
  // PowerShell bypassed BOTH layers of this guard. (Resolves the open assumption recorded in
  // .claude/skills/README.md. Note an MCP git tool would still bypass this; none is installed —
  // re-check if one is added.)
  if (payload.tool_name !== 'Bash' && payload.tool_name !== 'PowerShell') {
    return allow();
  }

  const command = (payload.tool_input && payload.tool_input.command) || '';
  const verb = blockedVerb(command);
  if (verb) {
    return deny(
      `BLOCKED by the working-directory rule (prompts/loop-monitor.md Stage 0 / ` +
      `prompts/director-weekly.md Stage 0): the git verb "${verb}" mutates the ` +
      `SHARED clone at ${SHARED_ROOT}, which no session may touch. All git ` +
      `work happens in YOUR SESSION'S own worktree — concurrent sessions share ` +
      `this clone and mutating it corrupts their work (happened 2026-07-10 and ` +
      `again 2026-W29). Only read-only git verbs (status, log, diff, show, ` +
      `fetch, rev-parse, ...) are permitted against the shared clone; re-run ` +
      `any mutating command against your own worktree instead. (Default-deny: ` +
      `unrecognized verbs are blocked too — if this was a genuine read, run it ` +
      `in your worktree or ask the Director to add the verb to the allowlist.)`
    );
  }

  // Coarse fail-closed layer: catch WRAPPED/DELEGATED git touching the shared
  // clone that the tokenizer is blind to (subshells, bash/sh/powershell -c,
  // single-quoted or escaped-quote git). Wrapped = blocked, full stop.
  const wrappedSeg = coarseWrapperBlocked(command);
  if (wrappedSeg) {
    return deny(
      `BLOCKED by the working-directory rule (prompts/loop-monitor.md Stage 0 / ` +
      `prompts/director-weekly.md Stage 0): a WRAPPED/DELEGATED git command ` +
      `references the SHARED clone at ${SHARED_ROOT}, which no session may ` +
      `touch. There is no legitimate reason to wrap a git command aimed at the ` +
      `shared clone in a subshell or interpreter (\`(git ...)\`, ` +
      `\`bash -c "git ..."\`, \`sh -c\`, \`powershell -Command\`, single-quoted ` +
      `\`'git'\`, escaped-quote nesting): even reads must be run UNWRAPPED ` +
      `(\`git -C "<repo>" status\`) in YOUR SESSION'S own worktree. Offending ` +
      `segment: ${wrappedSeg}. Re-run against your own worktree, unwrapped.`
    );
  }

  return allow();
}

// Fail OPEN: a broken guardrail must never block legitimate work.
main().catch(() => process.exit(0));
