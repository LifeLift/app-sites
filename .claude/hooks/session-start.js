#!/usr/bin/env node
/**
 * SessionStart orientation hook — the first thing an agent reads, every session.
 *
 * Prints POINTERS, never asserted facts. This is the one hard rule, and it comes from a
 * real failure: lifelift-mobile-backend's hook asserted which file held a test
 * credential. The claim was corrected in the repo's instruction file and NOT in the
 * hook, so two always-loaded surfaces sat in every context window contradicting each
 * other — with the false one printed first. It sent agents looking for a value that did
 * not exist where it said.
 *
 * A hook that says "X is in file Y" is a duplicate of file Y and will eventually
 * disagree with it. A hook that says "see file Y" cannot. So this file emits only:
 *   - values it reads live from the manifest (which cannot drift from itself), and
 *   - paths to the documents that own each fact.
 *
 * Everything printed is derived from the manifest. There are no repo-specific strings
 * in this file, which is what lets one hook body serve every subscriber.
 *
 * Contract: fast (<1s), fully offline, exit 0 always. A broken orientation hook must
 * never block a session.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function findManifest() {
  const envPath = process.env.AGENT_LOOP_MANIFEST;
  // The manifest may be read from an explicit path, but the REPO ROOT is where docs are
  // looked up — those are different when AGENT_LOOP_MANIFEST points outside the repo
  // (CI, tests). Resolve the root from git, falling back to the manifest's own directory.
  let gitRoot = null;
  try {
    gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch (_) { /* not a git repo */ }

  const candidates = envPath ? [envPath] : [];
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'agent-loop.manifest.json'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const c of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(c, 'utf8'));
      return { manifest, dir: gitRoot || path.dirname(c) };
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function branch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_) { return 'unknown'; }
}

function cmd(commands, key) {
  const c = commands && commands[key];
  return c && c.run ? c.run : null;
}

function main() {
  const found = findManifest();
  if (!found) return; // No manifest: say nothing rather than guess. Silence beats a wrong pointer.

  const m = found.manifest;
  const root = found.dir;
  const out = [];
  const commands = m.commands || {};
  const caps = m.capabilities || {};
  const on = (id) => (Array.isArray(caps) ? caps.includes(id) : caps[id] !== false);

  out.push(`== ${m.repo.name} — session orientation ==`);

  const b = m.branches || {};
  let line = `Branch: ${branch()} | integration: ${b.integration}`;
  if (b.integration_deploys_to) line += ` (merges deploy to ${b.integration_deploys_to})`;
  line += ` | production: ${b.production} — never merge or push to it; all PRs target ${b.integration}.`;
  out.push(line);

  // Worktree discipline, only where a shared clone actually exists.
  if (m.repo.shared_clone && on('shared-clone-guard')) {
    out.push(
      `Work only in YOUR OWN worktree under ${m.repo.worktrees_rel || '.claude/worktrees'}/. ` +
      'Never run a mutating git verb against the shared clone root — concurrent sessions share it ' +
      '(a PreToolUse guard enforces this and fails closed on unknown verbs).'
    );
  }

  // Gates, named by their real command. If a repo declares a capability but no command,
  // that inconsistency is check-capabilities' job to report — not this hook's to paper over.
  const gate = cmd(commands, 'gate');
  if (gate) out.push(`Local validation: '${gate}' — run it before claiming a change is verified.`);

  const real = cmd(commands, 'test_real');
  const unit = cmd(commands, 'test_unit');
  if (real && unit) {
    out.push(`Two test tiers: '${unit}' proves MOCK-level behavior only; '${real}' exercises the real stack. Know which one you are in.`);
  } else if (unit) {
    out.push(`Tests: '${unit}'.`);
  }

  if (cmd(commands, 'cantfail')) {
    out.push(`Tests must contain unconditional assertions — '${cmd(commands, 'cantfail')}' gates this.`);
  }

  // Explicitly absent capabilities are worth saying OUT LOUD. A named-but-dead check is
  // how a loop reports work as verified for weeks; a declared-absent one cannot.
  const dead = Object.entries(commands).filter(([, v]) => v === null).map(([k]) => k);
  if (dead.length) {
    out.push(`NOT AVAILABLE in this repo (do not cite as a completed check): ${dead.join(', ')}.`);
  }

  if (Array.isArray(m.carve_outs) && m.carve_outs.length) {
    const label = (m.escalation && m.escalation.human_gate_label) || 'needs-prod-review';
    const classifier = cmd(commands, 'carve_out');
    out.push(
      `High-risk carve-out (label '${label}', leave to humans): ${m.carve_outs.join(', ')}.` +
      (classifier ? ` Classify with '${classifier}' — run it, do not eyeball the path.` : '')
    );
  }

  if (Array.isArray(m.governance_files) && m.governance_files.length && on('governance-file-protection')) {
    out.push(
      `Governance files are OUT OF SCOPE for autonomous change or auto-merge: ${m.governance_files.join(', ')}. ` +
      'The loop does not rewrite the rules that bind it.'
    );
  }

  const blocked = (m.escalation && m.escalation.blocked_when_open) || [];
  if (blocked.length && on('outage-gate')) {
    out.push(
      `Before spending a metered resource, check whether it is structurally available: issue(s) ${blocked.join(', ')}. ` +
      'Read the state; never infer it from how a result looks.'
    );
  }

  // Pointers to documents that OWN facts. Listed only if they exist, so the hook can
  // never point at a file that is not there.
  const docs = [
    ['ENVIRONMENTS.md', 'environment truth table — read before debugging any "passes here, fails there"'],
    ['CLAUDE.md', 'repo rules and local facts'],
    ['AGENTS.md', 'repo rules and local facts'],
  ].filter(([f]) => fs.existsSync(path.join(root, f)));
  for (const [f, why] of docs) out.push(`${f}: ${why}.`);

  out.push('Credentials and secrets: reference by NAME, never copy values. This hook prints pointers only — where a value lives is stated in the docs above, not here.');

  console.log(out.join('\n'));
}

try { main(); } catch (_) { /* never block a session */ }
process.exit(0);
