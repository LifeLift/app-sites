#!/usr/bin/env node
/**
 * Does the PR body's own factual claims survive contact with the diff?
 *
 * Origin: issue #4. Of 15 review blockers measured in one downstream round, roughly a
 * QUARTER needed no model at all — they were mechanical contradictions between two
 * artifacts already in the repo. A body stating "no DB schema change, no migration" beside
 * a diff adding `CREATE INDEX IF NOT EXISTS`. A stated LOC delta 8.5x understated against
 * `git diff --shortstat`. Spending an adversarial model pass on these is waste, and worse,
 * it displaces reviewer attention from defects that genuinely need judgment.
 *
 * This matters more than "the PR body is a bit wrong" suggests. Where the human owner does
 * not read the tracker, owner-facing prose IS the interface, and a wrong document there is
 * the deliverable being wrong rather than a cosmetic slip.
 *
 * NOT THIS GATE: the launch-plan-404 incident (a merged plan pointing paid advertising at a
 * removed route) is a DIFFERENT shape and belongs to gates/check-stale-references.js. This
 * gate only ever inspects files the diff TOUCHES; that failure lives in a file the diff does
 * not touch, which is precisely why nobody notices it. An earlier revision of this header
 * cited that incident as if this gate covered it. It never did.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. Issue #4's own caveat is the design constraint:
 * claim-parsing is itself pattern matching with its own false positives, and "a
 * false-positive gate that agents learn to route around is worse than no gate." So this
 * compares STRUCTURED FACTS — does the diff touch `*.sql`, contain DDL, add a dependency
 * key, touch a non-doc file — and never attempts to parse prose intent. Every claim it
 * recognises must be stated in an explicit, unambiguous form. A body that says "this
 * shouldn't need any migrations I think" is NOT matched, on purpose: hedged prose is not a
 * claim, and treating it as one is how the gate starts crying wolf.
 *
 * The LOC check is narrower still. It fires only on a LABELLED figure ("LOC delta: 400",
 * "Lines changed: 400", "+400/-20") and allows 20% slack, because an author rounding is not
 * lying. Unlabelled numbers in prose are never read as LOC claims.
 *
 * Absence of a claim is never a finding. A body that says nothing about schemas is silent,
 * not wrong, and this gate has nothing to say about it.
 *
 * Usage:
 *   node gates/check-claims-vs-diff.js --base origin/main --head HEAD --body-file body.md
 *   node gates/check-claims-vs-diff.js --base origin/main            # body from GITHUB_EVENT_PATH
 *
 * Exit 0 = no contradiction (including "no claims found" and "no PR context").
 * Exit 1 = a claim contradicts the diff.
 * Exit 2 = could not run. Never report that as clean.
 */

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

function die(msg) {
  console.error(`check-claims-vs-diff: ${msg}`);
  process.exit(2);
}

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
}

// ── Claim detectors ────────────────────────────────────────────────────────────────────
// Each is an explicit, unambiguous phrasing. Deliberately not exhaustive: a claim form that
// is not listed is simply not checked, which is the safe direction. Adding a pattern here
// is cheap; adding one that over-matches costs the gate its credibility.

const NO_SCHEMA = [
  /\bno\s+(?:db\s+|database\s+)?schema\s+changes?\b/i,
  /\bno\s+migrations?\b/i,
  /\bschema\s*:\s*(?:none|unchanged|no\s+change)\b/i,
];
const NO_DEPS = [
  /\bno\s+new\s+(?:dependencies|deps|packages)\b/i,
  /\bno\s+dependency\s+changes?\b/i,
  /\bdependencies\s*:\s*(?:none|unchanged|no\s+change)\b/i,
];
const DOCS_ONLY = [
  /\bdocs?[- ]only\b/i,
  /\bdocumentation[- ]only\b/i,
  /\bonly\s+(?:touches|changes)\s+(?:the\s+)?docs\b/i,
];
// Labelled figures only. `+400/-20` is included because it is unambiguous by shape.
const LOC_CLAIM = [
  /\bLOC\s+delta\s*:\s*~?\s*([\d,]+)/i,
  /\blines?\s+changed\s*:\s*~?\s*([\d,]+)/i,
  /(?:^|\s)\+\s*([\d,]+)\s*\/\s*-\s*([\d,]+)(?:\s|$)/,
];

const DDL = /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|VIEW|SCHEMA|DATABASE|TYPE)\b/i;
const DOC_FILE = /(?:\.(?:md|markdown|txt|rst|adoc)$|^docs?\/)/i;

function matches(patterns, text) {
  for (const p of patterns) { const m = text.match(p); if (m) return m; }
  return null;
}

/** Strip fenced code blocks before claim-matching: a body QUOTING "no schema change" in an
 *  example or a log excerpt is not asserting it. Missing this would make the gate fire on
 *  its own documentation, which is how a gate first gets called noisy. */
function stripCode(body) {
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
  const cwd = get('--repo', process.cwd());
  const base = get('--base', null);
  const head = get('--head', 'HEAD');

  // ── Resolve the PR body ──────────────────────────────────────────────────────────────
  let body = null;
  const bodyFile = get('--body-file', null);
  if (get('--body', null) !== null) body = get('--body', '');
  else if (bodyFile) {
    if (!fs.existsSync(bodyFile)) die(`--body-file not found: ${bodyFile}`);
    body = fs.readFileSync(bodyFile, 'utf8');
  } else if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      body = ev.pull_request && ev.pull_request.body;
    } catch (e) { die(`could not parse GITHUB_EVENT_PATH: ${e.message}`); }
  }

  // No PR context is not a failure — a push to the integration branch has no body to check.
  // Say which case this is rather than printing a bare "clean" that reads like a pass.
  if (body === null || body === undefined) {
    console.log('check-claims-vs-diff: no PR body available (not a pull_request context) — nothing to check');
    return;
  }
  if (!base) die('no --base given; cannot compute the diff to compare claims against');

  // ── Collect structured facts about the diff ──────────────────────────────────────────
  let files, added, shortstat;
  try {
    const range = `${base}...${head}`;
    files = git(['diff', '--name-only', range], cwd).split('\n').map((s) => s.trim()).filter(Boolean);
    // Added lines only. A diff that DELETES a CREATE INDEX is not adding a schema change.
    added = git(['diff', '--unified=0', range], cwd)
      .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    shortstat = git(['diff', '--shortstat', range], cwd).trim();
  } catch (e) {
    die(`could not diff ${base}...${head}: ${e.message.split('\n')[0]}`);
  }

  // An empty diff cannot contradict anything, so every claim would pass — which is the
  // shape of a gate reporting "fine" when it means "could not check". Nearly always a bad
  // --base (a ref that is not actually an ancestor, or the branch compared against itself).
  // Fail closed: a real no-op PR is rare and can be skipped explicitly.
  if (!files.length) {
    die(`diff ${base}...${head} is empty — no claim can be contradicted, so this is a `
      + `misconfigured base ref, not a clean result`);
  }

  const text = stripCode(body);
  const findings = [];

  // 1. Schema / migration
  const schemaClaim = matches(NO_SCHEMA, text);
  if (schemaClaim) {
    const sqlFiles = files.filter((f) => /\.sql$/i.test(f) || /(?:^|\/)migrations?\//i.test(f));
    const ddlLines = added.filter((l) => DDL.test(l));
    if (sqlFiles.length || ddlLines.length) {
      findings.push({
        claim: schemaClaim[0].trim(),
        contradiction: [
          sqlFiles.length ? `${sqlFiles.length} schema/migration file(s): ${sqlFiles.slice(0, 3).join(', ')}` : null,
          ddlLines.length ? `${ddlLines.length} added DDL line(s), e.g. ${ddlLines[0].trim().slice(0, 80)}` : null,
        ].filter(Boolean).join('; '),
      });
    }
  }

  // 2. Dependencies. For package.json, PARSE both sides and diff the declared keys rather
  //    than matching added-line shapes: a line-shape regex silently misses single-line or
  //    reformatted JSON (it did, on the first version of this gate) and fires on any
  //    unrelated `"key": "value"` line. Key-set comparison has neither failure mode.
  const depClaim = matches(NO_DEPS, text);
  if (depClaim) {
    const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const jsonManifests = files.filter((f) => /(?:^|\/)package\.json$/i.test(f));
    const otherManifests = files.filter((f) => /(?:^|\/)(?:requirements\.txt|Cargo\.toml|go\.mod|Gemfile|pyproject\.toml)$/i.test(f));
    const introduced = [];

    for (const f of jsonManifests) {
      const read = (ref) => {
        try { return JSON.parse(git(['show', `${ref}:${f}`], cwd)); } catch (e) { return null; }
      };
      const before = read(base);
      const after = read(head);
      // A manifest that is new, deleted, or unparseable on either side cannot be key-diffed.
      // Say so rather than silently passing — unknown is not the same as unchanged.
      if (!before || !after) { introduced.push(`${f} (added/removed or unparseable — not key-diffed)`); continue; }
      for (const field of DEP_FIELDS) {
        const b = Object.keys(before[field] || {});
        const a = Object.keys(after[field] || {});
        const nw = a.filter((k) => !b.includes(k));
        if (nw.length) introduced.push(`${f} ${field}: +${nw.join(', +')}`);
      }
    }
    for (const f of otherManifests) {
      const depLines = added.filter((l) => /^\+[a-zA-Z0-9._-]+\s*(?:[=><~^]=?|\s)\s*\S/.test(l));
      if (depLines.length) introduced.push(`${f}: ${depLines.length} added requirement line(s), e.g. ${depLines[0].trim().slice(0, 60)}`);
    }

    if (introduced.length) {
      findings.push({ claim: depClaim[0].trim(), contradiction: introduced.join('; ') });
    }
  }

  // 3. Docs-only
  const docsClaim = matches(DOCS_ONLY, text);
  if (docsClaim) {
    const nonDoc = files.filter((f) => !DOC_FILE.test(f));
    if (nonDoc.length) {
      findings.push({
        claim: docsClaim[0].trim(),
        contradiction: `${nonDoc.length} non-doc file(s) changed: ${nonDoc.slice(0, 4).join(', ')}`,
      });
    }
  }

  // 4. LOC delta, labelled forms only, 20% slack.
  const locClaim = matches(LOC_CLAIM, text);
  if (locClaim && shortstat) {
    const ins = /(\d+) insertion/.exec(shortstat);
    const del = /(\d+) deletion/.exec(shortstat);
    const actual = (ins ? +ins[1] : 0) + (del ? +del[1] : 0);
    const stated = locClaim[2]
      ? +locClaim[1].replace(/,/g, '') + +locClaim[2].replace(/,/g, '')
      : +locClaim[1].replace(/,/g, '');
    if (actual > 0 && stated > 0) {
      const ratio = actual / stated;
      if (ratio > 1.2 || ratio < 0.8) {
        findings.push({
          claim: `stated ${locClaim[0].trim()} (${stated} lines)`,
          contradiction: `actual ${shortstat} = ${actual} lines — ${ratio.toFixed(1)}x the stated figure`,
        });
      }
    }
  }

  const checked = [schemaClaim, depClaim, docsClaim, locClaim].filter(Boolean).length;

  if (!findings.length) {
    console.log(`check-claims-vs-diff: ${checked} recognised claim(s), none contradicted by the diff`);
    return;
  }

  console.error('');
  console.error(`check-claims-vs-diff: ${findings.length} claim(s) contradicted by this diff`);
  for (const f of findings) {
    console.error('');
    console.error(`  claim  : "${f.claim}"`);
    console.error(`  reality: ${f.contradiction}`);
  }
  console.error('');
  console.error('  Fix the body or fix the diff. A PR body is read by humans who will not');
  console.error('  re-derive it from the patch, so a wrong one is a defect, not a typo.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = { stripCode, matches, NO_SCHEMA, NO_DEPS, DOCS_ONLY, LOC_CLAIM };
