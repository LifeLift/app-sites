#!/usr/bin/env node
/**
 * PreToolUse guardrail hook — non-blocking WARNING when Edit/Write targets a path under
 * the repo's high-risk carve-out surfaces: deploy/CI-gating files that must not be
 * touched on autopilot without the human-review routing in mind.
 *
 * Deliberately a WARN, not a BLOCK. Legitimate carve-out work still has to edit these
 * files — the point is only that nobody edits them without noticing. A block here would
 * be quickly disabled, and a disabled guard protects nothing.
 *
 * ADVISORY ONLY — NOT THE SOURCE OF TRUTH. The authoritative classifier is
 * `commands.carve_out` in the manifest, run in CI. This prefix list exists to shorten the
 * feedback loop, and a hand-maintained list WILL drift narrower than the real gate: in
 * ai-questions, a prose carve-out that omitted `.github/workflows/**` let two
 * workflow-touching PRs merge unlabeled (#779/#780). Treat a match here as a prompt to
 * run the real classifier, never as a substitute for it.
 *
 * RESOLVED 2026-W31 — this header used to record an ASSUMPTION that "ask" surfaces as a
 * passive advisory, flagged for an adopting Director to verify. It does not, and the
 * assumption survived a full adoption cycle unchecked precisely because the header made it
 * read as a considered position rather than an open question. An assumption that ships
 * unverified in a template gets re-inherited, not re-tested.
 *
 * "ask" renders a BLOCKING MODAL at the human operator, mid-run. Observed in ai-questions
 * with ~10 concurrent agents; the owner: "I'm seeing a ton of these and I never have any
 * context with which to make a decision. I always just click Allow Once." Two harms — the
 * warning's intended reader is the AGENT, and a human handed a path plus guardrail prose
 * with no diff cannot act on it; and a prompt that is always approved is not a control, it
 * trains reflexive click-through on the class of modal that should carry weight.
 *
 * It was also redundant, which is the deciding argument. The carve-out is enforced
 * mechanically at merge time: the labeller applies the human-gate label add-only, and the
 * label gate fails the PR while it is present. An agent may freely EDIT a carve-out path;
 * it still cannot MERGE one. The edit-time modal protected nothing the label gate does not
 * already protect deterministically.
 *
 * So: "allow" plus permissionDecisionReason — the agent still receives the routing
 * reminder, no modal is raised. If a hard stop is ever genuinely wanted, use "deny"
 * DELIBERATELY. Do not reintroduce "ask" expecting it to be passive.
 *
 * The general rule this produced, now pack policy — see docs/ADOPTION.md, "Hooks advise
 * the agent": a hook may raise a human-facing prompt only where no deterministic gate
 * exists downstream of it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Carve-out prefixes come from the manifest so one hook body serves every subscriber.
// Falls back to a conservative default set if no manifest is found; an empty list simply
// makes the hook a no-op, which is the right behavior for a repo with no carve-out.
function loadCarveOuts() {
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
      if (m && Array.isArray(m.carve_outs)) {
        // Normalize glob-ish entries to plain prefixes: this is a substring guard, not a
        // glob engine. `.github/workflows/**` -> `.github/workflows/`.
        return m.carve_outs.map((p) => String(p).replace(/\*+$/, '').replace(/\/?$/, '/'));
      }
    } catch (_) { /* keep looking */ }
  }
  return ['.github/workflows/', 'tests/validation/'];
}

const CARVEOUT_PREFIXES = loadCarveOuts();

// Label name is repo-specific; the concept is not.
const HUMAN_GATE_LABEL = (() => {
  try {
    const p = process.env.AGENT_LOOP_MANIFEST || path.join(process.cwd(), 'agent-loop.manifest.json');
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (m.escalation && m.escalation.human_gate_label) || 'needs-prod-review';
  } catch (_) { return 'needs-prod-review'; }
})();

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

function warn(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason
    }
  }));
  process.exit(0);
}

function normalizeRelPath(filePath, cwd) {
  if (!filePath) return '';
  let p = filePath.replace(/\\/g, '/');
  if (cwd) {
    const normCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (p.toLowerCase().startsWith(normCwd.toLowerCase() + '/')) {
      p = p.slice(normCwd.length + 1);
    }
  }
  return p.replace(/^\.\//, '');
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return allow();
  }

  if (payload.tool_name !== 'Edit' && payload.tool_name !== 'Write') {
    return allow();
  }

  const filePath = payload.tool_input && payload.tool_input.file_path;
  const relPath = normalizeRelPath(filePath, payload.cwd);

  const hit = CARVEOUT_PREFIXES.find((prefix) => relPath.startsWith(prefix));
  if (hit) {
    return warn(
      `HIGH-RISK CARVE-OUT surface: "${relPath}" is under ${hit}. ` +
      'Deploy/CI-gating files here must not be implemented-then-merged autonomously — a ' +
      `PR touching this path should carry the human-gate label (${HUMAN_GATE_LABEL}) and ` +
      'go to a human. This warning is ADVISORY and its prefix list can drift: run the ' +
      "repo's authoritative classifier (manifest `commands.carve_out`) on the real diff " +
      'before deciding. Confirm this edit is intentional and routed correctly.'
    );
  }

  return allow();
}

// Fail OPEN: an advisory hook must never block work on its own errors.
main().catch(() => process.exit(0));
