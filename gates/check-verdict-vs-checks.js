#!/usr/bin/env node
/**
 * Before an approving verdict is posted on a PR, does that PR's CI actually pass?
 *
 * Origin: issue #6, the `gh pr checks` row of the checkpoint table. The recorded failure is
 * six CONFIRMED_GOOD verdicts issued on a PR whose build was red (docs/METRICS.md, and
 * records/director/2026-W31.md). Those reviewers ran targeted probes and mutation checks —
 * the expensive, explicitly-instructed work — and skipped the one question that costs
 * nothing. A verdict is the most expensive artifact this pack produces and it was being
 * emitted on top of an unread free signal.
 *
 * WHY A SCRIPT AND NOT ANOTHER LINE OF PROSE. The rule already exists here three times:
 * prompts/loop-monitor.md STAGE 2 ("at least one check ran, and all completed
 * successfully"), skills/land-pr/SKILL.md step 5, skills/merge-train/SKILL.md step 7. All
 * three fire at MERGE time. A verdict is issued long before any merge gate is consulted, so
 * none of the three was ever positioned on the failing path. Three copies of a rule that
 * cannot fire is the argument for making it executable, not for writing a fourth.
 *
 * It also makes the SHA-BOUND clause executable for the first time. That clause is prose in
 * four places (loop-monitor.md, land-pr, merge-train, capabilities.json's
 * adversarial-internal-review caveat) and says the comment must state the head SHA it
 * reviewed. Prose cannot compare a SHA. This does.
 *
 * WHAT IT CHECKS, only when an approval is actually being asserted:
 *   1. every check in the rollup concluded successfully — anything FAILURE / CANCELLED /
 *      TIMED_OUT / ACTION_REQUIRED / STARTUP_FAILURE / STALE, or anything not COMPLETED, is
 *      a finding;
 *   2. ZERO checks is its own condition, not a pass. loop-monitor already separates "at
 *      least one check ran" from "all completed successfully", and director-weekly names the
 *      exact confusion ("nothing distinguishes held awaiting approval from no checks
 *      configured, so both present as zero checks"). An empty rollup is the shape of a
 *      pipeline that never triggered, which is the least safe moment to approve;
 *   3. the SHA the verdict names is the PR's current head.
 *
 * ABSENCE OF A VERDICT IS NOT A FINDING. Same rule as gates/check-claims-vs-diff.js: absence
 * of a claim is never a claim. Text with no approving token is silent, not wrong; this gate
 * exits 0 without so much as calling GitHub. It only ever objects to an approval that is
 * being asserted right now.
 *
 * WHAT COUNTS AS AN APPROVING TOKEN — the load-bearing judgement, so it is configurable.
 * I could not establish that `CONFIRMED_GOOD` is a fixed marker anywhere in this pack. It
 * appears exactly twice in the repo, in docs/METRICS.md and in the director record, and both
 * are describing a DOWNSTREAM incident (kaiserguy/ai-questions), not specifying an output
 * format. What this pack actually specifies is verdict SEMANTICS — VISIBLE, BINDING,
 * SHA-BOUND — and never a vocabulary. So hardcoding one token would be guessing, and
 * guessing narrow is the dangerous direction: an unrecognised approval is a gate that stays
 * silent and looks clean, which is worse than no gate because it manufactures assurance.
 * Hence a deliberately broad default list, plus:
 *     --approving-token <phrase>        add one (repeatable)
 *     --approving-tokens-file <path>    replace the default set entirely (one per line, # comments)
 * Tokens are matched as literal phrases, case-insensitively, at word boundaries, with
 * `_`/`-`/space interchangeable inside them, so CONFIRMED_GOOD, CONFIRMED-GOOD and
 * "confirmed good" are one token. Broad matching is on purpose: the cost of a false positive
 * here is being asked to look at a red build, and the cost of a false negative is the
 * incident above.
 *
 * DELIBERATE NON-GOALS. It does not read the verdict's findings, judge severity, or decide
 * whether blockers were addressed — that is the panel's job and no regex should attempt it.
 * It does not require the PR to be mergeable, non-draft, or based anywhere in particular;
 * the merge gates already own that and this is a pre-verdict checkpoint, not a merge gate.
 *
 * FAIL CLOSED. `gh` missing, an API error, a payload it does not recognise: exit 2, never
 * exit 0. "Could not reach GitHub" reported as "checks are fine" is the exact conflation
 * this whole pack exists around — "ran and found nothing" and "could not run" look identical
 * in a summary and mean opposite things (skills/land-pr/SKILL.md). An unfamiliar check
 * conclusion is likewise exit 2 and not a pass: this gate says so rather than guessing.
 *
 * HOW THE VERDICT TEXT ARRIVES: a file, by default. An agent about to post a verdict already
 * has it in a file for `gh pr comment --body-file`, so the bytes this gate reads are the
 * bytes that get posted — an argv string would be mangled by quoting and truncated by ARG_MAX
 * on a multi-kilobyte review, and stdin cannot be re-read when someone asks to see the
 * evidence again. Stdin is accepted (`--verdict-file -`, or piped with no flag) for pipelines.
 *
 * Usage:
 *   node gates/check-verdict-vs-checks.js --pr 12 --verdict-file verdict.md
 *   node gates/check-verdict-vs-checks.js --pr 12 --repo-slug owner/name --verdict-file -
 *   node gates/check-verdict-vs-checks.js --pr 12 --verdict-file v.md --pr-json fixture.json
 *
 * `--pr-json <path>` is the injectable seam. The GitHub read is one small function whose
 * whole contract is the JSON that this prints:
 *   gh pr view <n> --json number,headRefOid,url,state,isDraft,statusCheckRollup
 * Point --pr-json at a saved copy of that and the gate is fully testable with no network.
 *
 * Exit 0 = nothing asserted, or the approval holds up.
 * Exit 1 = an approving verdict contradicted by the PR's checks or head SHA.
 * Exit 2 = could not determine the CI state. Never report that as clean.
 */

'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const NAME = 'check-verdict-vs-checks';

function die(msg) {
  console.error(`${NAME}: CANNOT VERIFY — ${msg}`);
  console.error(`${NAME}: exit 2 means the CI state is UNKNOWN. Unknown is not green; do not`);
  console.error(`${NAME}: post an approving verdict on the strength of this run.`);
  process.exit(2);
}

// ── Approving vocabulary ───────────────────────────────────────────────────────────────
// Default set. `negatable: false` marks a phrase that is already negative in form ("no
// blockers"), which must not be run through the negation guard below or it would veto
// itself. Everything here is a literal phrase, never a regex, so a token supplied on the
// command line cannot inject pattern syntax.
/**
 * THE CANONICAL FORM, adopted 2026-W31 by owner decision.
 *
 *     VERDICT: APPROVED sha=<head-sha>
 *     VERDICT: BLOCKED
 *
 * Recognition was inference before this. The pack specified verdict SEMANTICS
 * (VISIBLE / BINDING / SHA-BOUND, in loop-monitor.md and both merge skills) and never an
 * output format; `CONFIRMED_GOOD` appears in this repo only as narrative ABOUT the
 * downstream incident, never as a specification. A gate inferring approval from prose is
 * wrong in the direction that costs the most: a token set that misses an approval exits 0
 * on a red build, which is the incident, silently.
 *
 * The phrase list below is retained as a FALLBACK, not replaced, and that is deliberate.
 * A canonical form only helps once every producer emits it, and until then a free-form
 * approval on a red build must still be caught. When a match comes from the fallback
 * rather than the canonical line, the output SAYS SO — so drift from the format is
 * visible without failing a review that was otherwise honest. Silent non-adoption is how
 * a format requirement becomes decoration.
 */
const CANONICAL_VERDICT = /^\s*VERDICT:\s*(APPROVED|BLOCKED)\b(.*)$/im;

const DEFAULT_APPROVING_TOKENS = [
  { phrase: 'CONFIRMED_GOOD', negatable: true },   // attested downstream (docs/METRICS.md)
  { phrase: 'CONFIRMED GOOD', negatable: true },
  { phrase: 'LGTM', negatable: true },
  { phrase: 'approved', negatable: true },
  { phrase: 'approving', negatable: true },
  { phrase: 'no blockers', negatable: false },
  { phrase: 'no blocking findings', negatable: false },
  { phrase: 'no blocking issues', negatable: false },
  { phrase: 'ship it', negatable: true },
  { phrase: 'safe to merge', negatable: true },
  { phrase: 'ready to merge', negatable: true },
  { phrase: 'clear to merge', negatable: true },
];

// Words that flip an approving token when they sit immediately before it. Deliberately tiny
// and deliberately local (three words of lookbehind): a real negation is adjacent, and
// anything cleverer starts parsing prose intent, which is what check-claims-vs-diff.js
// refuses to do for exactly the same reason.
const NEGATORS = /\b(?:not|never|cannot|can['’]?t|isn['’]?t|aren['’]?t|won['’]?t|without|no|nor|failed to|unable to)\b/i;

function escapeLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A phrase becomes a pattern where any run of space/underscore/hyphen matches any other. */
function phraseToPattern(phrase) {
  const body = phrase
    .trim()
    .split(/[\s_-]+/)
    .map(escapeLiteral)
    .join('[\\s_-]+');
  return new RegExp(`(^|[^\\w])(${body})(?![\\w])`, 'gi');
}

/**
 * Quoting a verdict is not issuing one. Strip fenced blocks, inline code and `>` quote lines
 * before looking for an approval, so a template, a rubric excerpt, or a paste of last round's
 * comment does not read as this round's approval — the same reason check-claims-vs-diff.js
 * strips code before claim-matching.
 *
 * SHA extraction deliberately does NOT use this: verdicts write the SHA in backticks, and a
 * SHA inside backticks is still the SHA being named.
 */
function stripQuoted(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((l) => !/^\s{0,3}>/.test(l))
    .join('\n');
}

function findApprovals(text, tokens) {
  const hay = stripQuoted(text);
  const hits = [];
  for (const t of tokens) {
    const re = phraseToPattern(t.phrase);
    let m;
    while ((m = re.exec(hay)) !== null) {
      const at = m.index + m[1].length;
      if (t.negatable) {
        const before = hay.slice(Math.max(0, at - 40), at);
        const tail = before.split(/[\s_-]+/).filter(Boolean).slice(-3).join(' ');
        if (NEGATORS.test(tail)) continue;   // "not approved", "cannot confirm good"
      }
      const line = hay.slice(0, at).split('\n').length;
      hits.push({ phrase: t.phrase, matched: m[2], line });
    }
  }
  return hits;
}

// ── Check rollup classification ────────────────────────────────────────────────────────
// SKIPPED and NEUTRAL count as passing: a correctly skipped job is the normal shape of a
// path-filtered workflow (the director record logs "two jobs correctly skipped" as healthy).
// Everything genuinely bad is enumerated rather than defaulted, and an unrecognised value
// falls through to `unknown`, which is exit 2 — this gate refuses to guess what a conclusion
// it has never seen means.
const PASS_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const FAIL_CONCLUSIONS = new Set([
  'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE',
]);
const PASS_STATES = new Set(['SUCCESS']);
const FAIL_STATES = new Set(['FAILURE', 'ERROR']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);

/** -> { verdict: 'pass'|'fail'|'pending'|'unknown', name, detail } */
function classifyCheck(entry) {
  if (!entry || typeof entry !== 'object') return { verdict: 'unknown', name: '(non-object rollup entry)', detail: String(entry) };
  const name = entry.name || entry.context || entry.workflowName || '(unnamed check)';

  // CheckRun shape: status + conclusion.
  if (typeof entry.status === 'string' && entry.status) {
    const status = entry.status.toUpperCase();
    if (status !== 'COMPLETED') {
      return { verdict: 'pending', name, detail: `status ${status} — has not completed` };
    }
    const concl = String(entry.conclusion || '').toUpperCase();
    if (PASS_CONCLUSIONS.has(concl)) return { verdict: 'pass', name, detail: concl };
    if (FAIL_CONCLUSIONS.has(concl)) return { verdict: 'fail', name, detail: concl };
    return { verdict: 'unknown', name, detail: `conclusion ${concl || '(empty)'} not recognised` };
  }

  // StatusContext shape: state only.
  if (typeof entry.state === 'string' && entry.state) {
    const state = entry.state.toUpperCase();
    if (PASS_STATES.has(state)) return { verdict: 'pass', name, detail: state };
    if (FAIL_STATES.has(state)) return { verdict: 'fail', name, detail: state };
    if (PENDING_STATES.has(state)) return { verdict: 'pending', name, detail: `state ${state} — has not completed` };
    return { verdict: 'unknown', name, detail: `state ${state} not recognised` };
  }

  return { verdict: 'unknown', name, detail: 'entry has neither status/conclusion nor state' };
}

// ── SHA handling ───────────────────────────────────────────────────────────────────────
// Abbreviations are normal in a verdict comment, so a candidate binds if either SHA is a
// prefix of the other at >= 7 chars. Candidates are any 7-40 hex run; an all-digit run
// (an issue number, a timestamp) can be a false candidate, which at worst reports "names a
// SHA that is not the head" where "names no SHA" was truer. Both are the same finding.
function shaCandidates(text) {
  const out = [];
  const re = /\b[0-9a-f]{7,40}\b/gi;
  let m;
  while ((m = re.exec(String(text))) !== null) out.push(m[0].toLowerCase());
  return [...new Set(out)];
}

function bindsTo(candidate, head) {
  const c = candidate.toLowerCase();
  const h = String(head).toLowerCase();
  if (c.length < 7 || h.length < 7) return false;
  return h.startsWith(c) || c.startsWith(h);
}

// ── The GitHub read — the whole injectable seam ────────────────────────────────────────
const PR_FIELDS = 'number,headRefOid,url,state,isDraft,statusCheckRollup';

function fetchPrJson({ pr, repoSlug, fixture }) {
  if (fixture) {
    if (!fs.existsSync(fixture)) die(`--pr-json not found: ${fixture}`);
    try {
      return JSON.parse(fs.readFileSync(fixture, 'utf8'));
    } catch (e) {
      die(`--pr-json is not valid JSON (${fixture}): ${e.message}`);
    }
  }
  const args = ['pr', 'view', String(pr), '--json', PR_FIELDS];
  if (repoSlug) args.push('--repo', repoSlug);
  let raw;
  try {
    raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    die(`\`gh ${args.join(' ')}\` failed: ${detail || e.code || 'unknown error'}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`gh returned output that is not JSON: ${e.message}`);
  }
}

/** Reject a payload we cannot reason about BEFORE drawing any conclusion from it. */
function validatePayload(p, source) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) die(`${source} is not a PR object`);
  const head = p.headRefOid;
  if (typeof head !== 'string' || !/^[0-9a-f]{7,40}$/i.test(head)) {
    die(`${source} has no usable headRefOid (got ${JSON.stringify(head)}) — cannot check the SHA binding`);
  }
  const rollup = p.statusCheckRollup;
  if (rollup !== null && rollup !== undefined && !Array.isArray(rollup)) {
    die(`${source} statusCheckRollup is ${typeof rollup}, expected an array — this gate needs updating`);
  }
  return { head, rollup: Array.isArray(rollup) ? rollup : [] , rollupWasNull: rollup === null || rollup === undefined };
}

function loadTokens(args, get) {
  const file = get('--approving-tokens-file', null);
  let tokens = DEFAULT_APPROVING_TOKENS.slice();
  let source = `default set (${tokens.length} phrases)`;
  if (file) {
    if (!fs.existsSync(file)) die(`--approving-tokens-file not found: ${file}`);
    const lines = fs.readFileSync(file, 'utf8').split('\n')
      .map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
    if (!lines.length) die(`--approving-tokens-file is empty: ${file} — a gate with no vocabulary recognises no approval and would pass everything`);
    // Phrases supplied by hand are treated as negatable unless they open with a negator,
    // which is how "no blockers" keeps working when someone re-declares it.
    tokens = lines.map((phrase) => ({ phrase, negatable: !NEGATORS.test(phrase.split(/[\s_-]+/)[0] || '') }));
    source = `${file} (${tokens.length} phrases)`;
  }
  const extra = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--approving-token' && args[i + 1]) extra.push(args[i + 1]);
  }
  for (const phrase of extra) tokens.push({ phrase, negatable: !NEGATORS.test(phrase.split(/[\s_-]+/)[0] || '') });
  if (extra.length) source += ` + ${extra.length} from --approving-token`;
  return { tokens, source };
}

function readVerdict(get) {
  const flag = get('--verdict-file', null);
  const readStdin = () => {
    try { return fs.readFileSync(0, 'utf8'); } catch (e) { die(`could not read verdict text from stdin: ${e.message}`); }
  };
  if (flag === '-') return readStdin();
  if (flag) {
    if (!fs.existsSync(flag)) die(`--verdict-file not found: ${flag}`);
    return fs.readFileSync(flag, 'utf8');
  }
  if (!process.stdin.isTTY) return readStdin();
  die('no verdict text given: pass --verdict-file <path> (or `-` for stdin). '
    + 'Point it at the same file you will hand to `gh pr comment --body-file`.');
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };

  const fixture = get('--pr-json', null);
  const pr = get('--pr', null);
  const repoSlug = get('--repo-slug', null);
  if (!pr && !fixture) die('no --pr <number> given; nothing to check the verdict against');

  const { tokens, source: tokenSource } = loadTokens(args, get);
  const verdictText = readVerdict(get);

  // ── Absence of a verdict is not a finding ────────────────────────────────────────────
  // Nothing is asserted, so there is nothing to contradict — and no reason to spend a
  // network call. This is the branch that keeps the gate cheap enough to run every time.
  const approvals = findApprovals(verdictText, tokens);
  if (!approvals.length) {
    console.log(`${NAME}: no approving token in this text (vocabulary: ${tokenSource}) — `
      + 'nothing asserted, nothing to check');
    return;
  }

  const shown = [...new Set(approvals.map((a) => a.matched))].slice(0, 4).join(', ');
  const payload = fetchPrJson({ pr, repoSlug, fixture });
  const { head, rollup, rollupWasNull } = validatePayload(payload, fixture ? `--pr-json ${fixture}` : 'gh pr view output');

  const classified = rollup.map(classifyCheck);
  const unknown = classified.filter((c) => c.verdict === 'unknown');
  if (unknown.length) {
    die(`${unknown.length} check(s) in the rollup could not be classified `
      + `(e.g. ${unknown[0].name}: ${unknown[0].detail}) — refusing to call this green`);
  }

  const failed = classified.filter((c) => c.verdict === 'fail');
  const pending = classified.filter((c) => c.verdict === 'pending');
  const passed = classified.filter((c) => c.verdict === 'pass');

  const findings = [];

  // 1 + 2. The rollup. Zero checks is its own condition, deliberately not folded into "all
  //        checks passed" — vacuous truth is how an untriggered pipeline reads as green.
  if (!rollup.length) {
    findings.push({
      title: 'ZERO checks on this PR',
      detail: rollupWasNull
        ? 'statusCheckRollup is null — GitHub reports no checks at all for this head'
        : 'the check rollup is empty — no workflow has reported on this head',
      why: 'loop-monitor.md STAGE 2 requires that AT LEAST ONE check ran before all-green counts. '
        + 'An empty rollup is not a passing build; it is usually a workflow that never triggered, '
        + 'and director-weekly.md notes that "held awaiting approval" and "no checks configured" '
        + 'both present this way.',
    });
  } else if (failed.length || pending.length) {
    findings.push({
      title: `${failed.length} failing / ${pending.length} incomplete check(s)`,
      detail: [...failed, ...pending].slice(0, 10).map((c) => `${c.name}: ${c.detail}`).join('; '),
      why: 'An approving verdict on a red or unfinished build is the recorded failure this gate '
        + 'exists for: six CONFIRMED_GOOD verdicts on a PR whose build was red.',
    });
  }

  // 3. SHA-BOUND, executable at last.
  const candidates = shaCandidates(verdictText);
  const bound = candidates.filter((c) => bindsTo(c, head));
  const allowMissingSha = args.includes('--allow-missing-sha');
  if (!bound.length) {
    if (!candidates.length && allowMissingSha) {
      console.error(`${NAME}: note — verdict names no SHA and --allow-missing-sha was passed; `
        + 'the SHA-BOUND clause is NOT being enforced on this run');
    } else if (!candidates.length) {
      findings.push({
        title: 'verdict names no SHA',
        detail: `PR head is ${head}`,
        why: 'The SHA-BOUND clause (loop-monitor.md STAGE 2, land-pr, merge-train, '
          + 'capabilities.json adversarial-internal-review) requires the comment to state the head '
          + 'SHA it reviewed. A verdict that names no commit cannot go stale, which means it never '
          + 'stops being cited. Pass --allow-missing-sha only if your verdict format genuinely omits it.',
      });
    } else {
      findings.push({
        title: 'verdict reviews a SHA that is not the current head',
        detail: `verdict names ${candidates.slice(0, 4).join(', ')}; PR head is ${head}`,
        why: 'A loop merged an architectural rewrite on verdicts that had reviewed an older commit. '
          + 'New commits landed since this review; re-read the head before approving it.',
      });
    }
  }

  if (!findings.length) {
    console.log(`${NAME}: approving verdict (${shown}) — ${passed.length} check(s) all green on `
      + `head ${head.slice(0, 12)}, verdict binds to it. Safe to post.`);
    return;
  }

  console.error('');
  console.error(`${NAME}: ${findings.length} problem(s) with posting this approving verdict`);
  console.error(`  approving token(s) : ${shown} (line ${approvals[0].line})`);
  console.error(`  PR head            : ${head}`);
  console.error(`  checks             : ${passed.length} passed, ${failed.length} failed, `
    + `${pending.length} incomplete, ${rollup.length} total`);
  for (const f of findings) {
    console.error('');
    console.error(`  ${f.title}`);
    console.error(`    ${f.detail}`);
    console.error(`    ${f.why}`);
  }
  console.error('');
  console.error('  Do not post this verdict. Either fix the build, wait for it, or post a verdict');
  console.error('  that says what is actually true about this commit. Reporting findings is always');
  console.error('  allowed — this gate only ever objects to an approval.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = {
  DEFAULT_APPROVING_TOKENS, phraseToPattern, stripQuoted, findApprovals,
  classifyCheck, shaCandidates, bindsTo, validatePayload, fetchPrJson, PR_FIELDS,
};
