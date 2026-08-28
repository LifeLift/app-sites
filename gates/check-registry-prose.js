#!/usr/bin/env node
/**
 * Does the prose still agree with `capabilities.json` about what the registry says?
 *
 * Origin: issue #13. The 2026-W31 Director pass found THREE separate cases in one week of
 * shipped prose contradicting the registry or the filesystem, each caught by a human or an
 * agent happening to read both files at once:
 *   - `review/README.md` cited `prompt-review/SKILL.md`; the file is `review/prompt-review-SKILL.md`.
 *   - `README.md` said `eval-corpus` ships experimental with an empty `proven_in`. The
 *     registry said beta, proven in one repo — drift in the FLATTERING direction's mirror,
 *     understating the evidence in the file whose subject is honest evidence grading.
 *   - `evals/README.md` said "No repo has run this end-to-end" and that the registry marks
 *     the capability experimental with `proven_in: []`. The registry records an 18-run
 *     execution on 2026-07-24 that overturned a High-severity audit finding inspection had
 *     recommended landing. Whether it ran, its status, and its `proven_in` — three wrong
 *     claims in one sentence, in the document that governs when behavioural findings ship.
 *
 * This is the same shape as the failure gates/check-hook-pointers.js exists for — "a hook
 * that says X is in file Y is a DUPLICATE of file Y and will eventually disagree with it" —
 * pointed at documentation instead of a hook. The registry is the single source of truth for
 * maturity; the prose explaining it lives in at least four files; nothing kept them in step.
 *
 * WHAT THIS CHECKS. Mechanical agreement between a claim and the structured fact it names,
 * and nothing else — the same line check-claims-vs-diff.js draws between structured facts and
 * prose intent. Two claim families:
 *   1. STATUS. `example-capability` is/ships as/remains/is marked as <status>.
 *   2. PROVEN_IN. The literal key form `proven_in: []` / `proven_in: ["repo"]`, bound to a
 *      capability the same way a status is.
 * It does NOT judge whether an `evidence` string is accurate, whether a caveat is still true,
 * or whether the reasoning around a claim holds. Those need judgment.
 *
 * ── THE THING THAT DECIDES WHETHER THIS GATE IS WORTH SHIPPING ──────────────────────────
 * Capability ids appear in ordinary prose throughout the docs, usually nowhere near a status
 * word — and, worse, sometimes RIGHT NEXT to one in prose that is entirely correct. Measured
 * on this repo's 16 tracked markdown files before any pattern was fixed: a ±120-character
 * proximity window produces 10 id/status co-occurrences, of which SEVEN are correct prose a
 * proximity matcher would report. They fail in four distinct ways, and each one killed a
 * simpler design:
 *   - two capabilities in one sentence with a status each ("`pack-sync` ships as experimental
 *     ... `eval-corpus` is beta") — proximity binds the wrong pair;
 *   - past-tense narration of a FIXED error ("this sentence described both as experimental
 *     until 2026-W31, after `eval-corpus` had earned beta") — a true statement about a former
 *     status, which is what a repo that records its own corrections writes constantly;
 *   - a Director record QUOTING the wrong claim in order to document it;
 *   - a correct restatement ("`capabilities.json` marks `eval-corpus` as `beta`").
 * So binding is NOT proximity. A status binds to a capability only through an explicit,
 * present-tense connective drawn from a closed list ("is", "as", "ships as", "remains",
 * "is marked as", "status:", a table-cell pipe) with no sentence boundary and no blank line
 * between them, at most one line wrap, ≤60 characters. "had earned", "described as ... until",
 * "and this repo has" are not connectives, so those sentences are not claims. The status must
 * also READ AS A PREDICATE, not as an adjective on some other noun: "is a mature approach",
 * "beta software", "experimental work" name no registry fact, and the connective list alone
 * cannot tell them from a claim (see TRAILER_WORDS). Coordination
 * ("`a` and `b` ship as experimental") binds both, because incident 2 was exactly that shape
 * and a nearest-id-only rule would have missed the incident that motivated this gate.
 * Text inside prose-level double quotes is a quotation, not an assertion, and is skipped —
 * that is what keeps the gate off records that quote a claim in order to correct it. Quote
 * characters inside inline code (`proven_in: ["repo"]`) are not delimiters, or the mask would
 * swallow half the paragraph. Skipped-as-quoted claims are COUNTED in the summary: a blind
 * spot that is reported is a known cost, a silent one is a false clean.
 *
 * WHAT IT REFUSES TO CHECK, AND THE MEASUREMENTS THAT SETTLED IT. Issue #13 proposed two
 * things this gate does not do. Both were built, measured, and removed.
 *
 * (a) "no repo has run <id>" as a proven_in claim. Every occurrence of that construction in
 * this repo's markdown is SCOPED — "no repo has run it on real traffic", "the copy-adapt path
 * has never run end-to-end from a subscriber's loop", "no repo has production experience",
 * "not yet runnable *here*". A scoped claim about one way of running a capability is not a
 * claim that `proven_in` is empty, and it is true of capabilities that ARE proven. Unscoped
 * uses in the corpus: zero. The implemented form fired on a correct sentence in the
 * known-negative fixture ("no repo has run `example-capability` on real traffic with a second
 * grader") and the only fix available was to start parsing what the scope modifies — prose
 * intent, which is the line this gate does not cross. Nothing is lost: incident 3's sentence
 * is caught twice over by the status and `proven_in:` literal forms in the same sentence.
 *
 * (b) Bare repo-relative path citations that do not resolve (incident 1 above).
 * gates/check-citations.js already owns the `path:line` half. The bare-path half was
 * prototyped and MEASURED on this repo: 121 path-shaped tokens, 12 unresolved, and all 12
 * are false positives — illustrative paths in a rubric's examples (`src/api/routes.py`,
 * `.claude/skills/add-endpoint/SKILL.md`), paths that live in a SUBSCRIBER repo rather than
 * this one (`scripts/precommit.js`), and one historical quotation of the very typo from
 * incident 1. Zero true positives, a ~10% fire rate on correct prose. That is the ratio that
 * teaches agents to route around a gate, so the bare-path check is NOT implemented and should
 * not be added without a way to tell an example path from a claim. check-citations.js requires
 * `:NN` for exactly this reason: the line number is what turns a mention into a claim, and a
 * bare path is a mention.
 *
 * RECORDS ARE NOT SWEPT BY DEFAULT. `records/` holds dated, append-only history. A record
 * written in 2026-W31 saying a capability is experimental is a statement about that week; when
 * the capability reaches beta the record does not become a defect, and the only "fix" a gate
 * could demand there is falsifying history. Comparing a dated snapshot against current state
 * is a category error that would, with certainty and on a time delay, produce findings whose
 * correct resolution is "leave it alone" — the route-around failure mode again. So the default
 * sweep is tracked markdown minus `records/`; naming a file explicitly always scans it, and
 * --include-records restores it to the sweep. This is a real cost, honestly priced: at the
 * time of writing, `records/director/2026-W31.md:230` asserts `eval-corpus` is experimental
 * with `proven_in: []` — false when it was written, and contradicted by finding D8 in that
 * same document. This gate reports it when pointed at the file, and stays silent in the sweep.
 *
 * Every example in this header uses the placeholder id `example-capability` where a real one
 * would do, so this file can never be its own finding — same move as check-citations.js
 * writing `:NN` and check-capability-markers.js exempting its own literal placeholder. A
 * checker that reports its own documentation teaches people to ignore it.
 *
 * Usage:
 *   node gates/check-registry-prose.js                        # sweep tracked markdown
 *   node gates/check-registry-prose.js docs/ADOPTION.md       # named files, even under records/
 *   node gates/check-registry-prose.js --include-records
 *   node gates/check-registry-prose.js --repo . --capabilities capabilities.json
 *
 * Exit 0 = every recognised claim matches the registry (including "no claims found").
 * Exit 1 = a claim contradicts the registry.
 * Exit 2 = could not run. Never report that as clean.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function die(msg) {
  console.error(`check-registry-prose: ${msg}`);
  process.exit(2);
}

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
}

// ── Masking: what is not prose ─────────────────────────────────────────────────────────
// Nothing below deletes a LINE: comments and URLs are blanked in place character-for-
// character, and fenced blocks are emptied line by line. Offsets shift, but the line count
// does not, and every later stage reads the same masked text — so a reported line number is
// the line the author will find the claim on.

/** Fenced blocks are skipped whole: a document SHOWING a claim in an example is not making
 *  one. Same rule as check-citations.js and check-claims-vs-diff.js. */
function blankFences(text) {
  const lines = String(text).split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) { inFence = !inFence; lines[i] = ''; continue; }
    if (inFence) lines[i] = '';
  }
  return lines.join('\n');
}

function blankComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** A URL can contain anything, including something id-shaped. */
function blankUrls(text) {
  return String(text).replace(/\bhttps?:\/\/\S+/g, (m) => ' '.repeat(m.length));
}

/**
 * Which characters sit inside an inline code span. Code is NOT blanked — ids and statuses are
 * nearly always written in backticks, so blanking it would blind the gate entirely. The mask
 * exists for one purpose: a `"` inside code is not a quotation delimiter. Without that,
 * `proven_in: ["lifelift-mobile-backend"]` opens a quote that swallows the rest of the
 * paragraph, and the gate goes quiet on real claims for a reason no reader could guess.
 */
function codeMask(text) {
  const mask = new Array(text.length).fill(false);
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') { i++; continue; }
    let n = 0;
    while (text[i + n] === '`') n++;
    const close = text.indexOf('`'.repeat(n), i + n);
    // An unterminated span, or one that reaches across a paragraph break, is not a code span.
    if (close === -1 || /\n\s*\n/.test(text.slice(i, close))) { i += n; continue; }
    for (let j = i; j < close + n; j++) mask[j] = true;
    i = close + n;
  }
  return mask;
}

/** Paragraph ranges: [start, end) split on blank lines. Every association this gate makes
 *  stops at a paragraph break, because a paragraph break is a change of subject. */
function paragraphs(text) {
  const out = [];
  let start = 0;
  const re = /\n[ \t]*\n/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push([start, m.index]);
    start = m.index + m[0].length;
  }
  out.push([start, text.length]);
  return out;
}

/**
 * Which characters sit inside a prose-level quotation. A record writing
 * `Line 63 said "<the wrong claim>"` is documenting an error, not committing one, and firing
 * there is the single most likely way this gate gets switched off.
 *
 * Only double quotes count, straight and curly. Markdown blockquotes (`>`) are deliberately
 * NOT treated as quotation: in this repo `>` marks the pack's own Origin notes and emphasis,
 * so skipping them would be a large blind spot pretending to be caution.
 *
 * Straight quotes are paired only when a paragraph contains an even number of them — an odd
 * count means an apostrophe or an inch mark got counted, and pairing from there masks
 * arbitrary text. Unbalanced paragraphs are left unmasked (the safe direction: report and let
 * a human judge, rather than fall silent).
 */
function quoteMask(text, code) {
  const mask = new Array(text.length).fill(false);
  for (const [pStart, pEnd] of paragraphs(text)) {
    const straight = [];
    const opens = [];
    for (let i = pStart; i < pEnd; i++) {
      if (code[i]) continue;
      if (text[i] === '"') straight.push(i);
      else if (text[i] === '“') opens.push(i);
      else if (text[i] === '”' && opens.length) {
        const o = opens.pop();
        for (let j = o; j <= i; j++) mask[j] = true;
      }
    }
    if (straight.length % 2 !== 0) continue;
    for (let k = 0; k + 1 < straight.length; k += 2) {
      for (let j = straight[k]; j <= straight[k + 1]; j++) mask[j] = true;
    }
  }
  return mask;
}

// ── Recognising ids, statuses and claims ───────────────────────────────────────────────

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Longest ids first so a containing id is never shadowed by a shorter one it contains. */
function findIds(text, ids) {
  const alts = ids.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_-])(${alts})(?![A-Za-z0-9_-])`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ id: m[1], start: m.index, end: m.index + m[1].length });
  return out;
}

function findStatuses(text, statuses) {
  const alts = statuses.slice().sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_-])(${alts})(?![A-Za-z0-9_-])`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ word: m[1], start: m.index, end: m.index + m[1].length });
  return out;
}

/** Markdown wrappers and punctuation that carry no meaning between an id and its status. */
const NOISE = /[`*_~"'()[\]{}:;,—–‘’“”-]/g;

function normGap(gap) {
  return gap.replace(NOISE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The closed list of ways prose may bind a capability to a status. Present tense only: a
 * past-tense construction is a statement about a FORMER status and is true of correct prose
 * in a repo that records its own corrections. Anything not listed here is not a claim, which
 * is the safe direction — adding a form is cheap, and one that over-matches costs the gate
 * its credibility (check-claims-vs-diff.js, same rule).
 *
 * The empty gap is accepted (`| example-capability | mature |` in a table, or an appositive),
 * which is why callers must reject a gap containing sentence-ending punctuation first — or
 * "…in example-capability. Beta means…" would bind across the full stop.
 */
const CONNECTIVE = new RegExp(
  '^(?:'
  + '(?:is|are)?\\s*(?:still|now|currently|only|just)?\\s*'
  + '(?:marked|listed|registered|recorded|graded|rated|classified|shown|set|declared)?\\s*'
  + '(?:as|at|to)?\\s*(?:a|an|the)?\\s*(?:status)?\\s*(?:of|is)?\\s*'
  + '|(?:ships?|remains?|stays?|sits?)\\s*(?:as|at)?\\s*(?:a|an)?\\s*'
  + '|with\\s*(?:a|an)?\\s*status\\s*(?:of)?\\s*'
  + '|\\|'
  + ')$'
);

/** Joins that make a coordinated list of ids: "`a` and `b`", "`a`, `b`, and `c`". */
const COORDINATION = /^(?:and|&)?$/;

/**
 * What may follow a status word for it to be a PREDICATE ("`example-capability` is mature.")
 * rather than an ADJECTIVE modifying some other noun ("`example-capability` is a mature
 * approach", "beta software", "experimental work"). Without this, the connective list alone
 * binds every adjectival use, and adjectival use of exactly these three words is ordinary
 * English that this pack's docs are full of.
 *
 * So a status must be followed by a clause end, or by a word that cannot be the noun it
 * modifies. `capability`/`capabilities`/`gate` are listed BECAUSE they are the noun a genuine
 * claim uses ("is a mature capability"), which is the whole discrimination: the noun tells you
 * whether the sentence is about the registry entry or about something else.
 */
const TRAILER_WORDS = new Set([
  'with', 'and', 'or', 'but', 'because', 'since', 'so', 'for', 'in', 'on', 'at', 'per',
  'until', 'unless', 'while', 'though', 'here', 'there', 'now', 'today', 'proven_in',
  'capability', 'capabilities', 'gate', 'status', 'according', 'per_the',
]);

/** Is the text after a status word consistent with the status being the predicate? */
function trailerOk(text, end) {
  let i = end;
  while (i < text.length && /[`*_~\s]/.test(text[i])) {
    if (text[i] === '\n') return true;          // end of line ends the clause
    i++;
  }
  if (i >= text.length) return true;
  if (/[.,;:!?)|\]}—–"'>]/.test(text[i])) return true;
  const word = (text.slice(i).match(/^[A-Za-z_]+/) || [''])[0].toLowerCase();
  return TRAILER_WORDS.has(word);
}

const MAX_STATUS_GAP = 60;
const MAX_PROVEN_GAP = 100;
const MAX_COORD_JOIN = 30;

/** A gap may wrap once (markdown wraps), but may not cross a clause end or a blank line.
 *  A semicolon joins two independent clauses, so it is a change of subject exactly like a
 *  full stop: without it, "`example-capability`; beta means…" binds across the boundary. */
function gapUsable(gap, limit) {
  if (gap.length > limit) return false;
  if (/[.!?;]/.test(gap)) return false;
  if (/\n[ \t]*\n/.test(gap)) return false;
  if ((gap.match(/\n/g) || []).length > 1) return false;
  return true;
}

/** The id occurrence ending nearest before `pos`, or null. Binary search, because `idHits` is
 *  in ascending order and a linear scan here makes the whole gate quadratic in a long
 *  document. See lineOf for the measurement — that was the larger half of the same problem. */
function idBefore(idHits, pos) {
  let lo = 0;
  let hi = idHits.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idHits[mid].end <= pos) { best = idHits[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** Extend a bound id backwards across a coordinated list, so "`a` and `b` ship as X" is a
 *  claim about both. Incident 2 in the header was exactly this shape. */
function coordinated(text, idHits, anchor) {
  const list = [anchor];
  let head = anchor;
  for (;;) {
    const prev = idBefore(idHits, head.start);
    if (!prev) break;
    const join = text.slice(prev.end, head.start);
    if (join.length > MAX_COORD_JOIN || !gapUsable(join, MAX_COORD_JOIN)) break;
    if (!COORDINATION.test(normGap(join))) break;
    list.unshift(prev);
    head = prev;
  }
  return list;
}

/** Tokens permitted between an id and a `proven_in:` literal it is bound to. An allowlist,
 *  not a length limit: "…is beta, `proven_in: [...]`" binds; narrative does not. */
const PROVEN_GAP_TOKENS = new Set([
  'is', 'are', 'ships', 'ship', 'remains', 'remain', 'stays', 'stay', 'sits', 'sit',
  'marked', 'listed', 'registered', 'recorded', 'graded', 'rated', 'declared', 'shown',
  'as', 'at', 'to', 'with', 'and', 'still', 'now', 'currently', 'only', 'just',
  'a', 'an', 'the', 'status', 'of', 'its', 'it', 'has', 'have', 'in', 'set',
]);

const PROVEN_LITERAL = /proven_in\s*[:=]\s*(\[[^\]\n]*\])/g;

// There is deliberately no "no repo has run <id>" matcher. It was built and measured out —
// see WHAT IT REFUSES TO CHECK (a) in the header before adding one back.

function parseArray(literal) {
  return literal
    .slice(1, -1)
    .split(',')
    .map((s) => s.replace(/["'`\s]/g, ''))
    .filter(Boolean);
}

/**
 * Line numbers from a precomputed index. The obvious `text.slice(0, i).split('\n').length` is
 * O(document) per finding, which made the gate quadratic in findings: measured at 33s on a
 * 22MB input with 1000 findings, 2.1s once both this and idBefore stopped rescanning.
 */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function excerpt(text, from, to) {
  return text.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, 120);
}

const sameSet = (a, b) => a.length === b.length && a.slice().sort().join(' ') === b.slice().sort().join(' ');

/**
 * Every claim in one document, with the registry fact it names.
 * Returns { findings, checked, quoted } — `quoted` is the count skipped as quotation, which
 * is reported rather than swallowed.
 */
function checkText(raw, reg, label) {
  const text = blankUrls(blankComments(blankFences(raw)));
  const code = codeMask(text);
  const quotes = quoteMask(text, code);
  const lines = lineIndex(text);
  const registry = reg.caps;
  const ids = Object.keys(registry);
  const statuses = reg.statuses;

  const idHits = findIds(text, ids);
  const findings = [];
  let checked = 0;
  let quoted = 0;
  if (!idHits.length) return { findings, checked, quoted };

  // ── 1. Status claims ────────────────────────────────────────────────────────────────
  for (const s of findStatuses(text, statuses)) {
    const anchor = idBefore(idHits, s.start);
    if (!anchor) continue;
    const gap = text.slice(anchor.end, s.start);
    if (!gapUsable(gap, MAX_STATUS_GAP)) continue;
    if (!CONNECTIVE.test(normGap(gap))) continue;
    if (!trailerOk(text, s.end)) continue;
    if (quotes[s.start]) { quoted++; continue; }

    const claimed = s.word.toLowerCase();
    for (const hit of coordinated(text, idHits, anchor)) {
      checked++;
      const actual = String(registry[hit.id].status).toLowerCase();
      if (actual === claimed) continue;
      findings.push({
        line: lineOf(lines, hit.start),
        claim: excerpt(text, hit.start, s.end),
        says: `${hit.id} is ${claimed}`,
        registry: `${hit.id} status = ${registry[hit.id].status}`,
      });
    }
  }

  // ── 2. `proven_in:` literals ────────────────────────────────────────────────────────
  PROVEN_LITERAL.lastIndex = 0;
  let m;
  while ((m = PROVEN_LITERAL.exec(text)) !== null) {
    const anchor = idBefore(idHits, m.index);
    if (!anchor) continue;
    const gap = text.slice(anchor.end, m.index);
    if (!gapUsable(gap, MAX_PROVEN_GAP)) continue;
    const tokens = normGap(gap).split(' ').filter(Boolean);
    if (!tokens.every((t) => PROVEN_GAP_TOKENS.has(t) || statuses.includes(t))) continue;
    if (quotes[m.index]) { quoted++; continue; }

    const claimedRepos = parseArray(m[1]);
    for (const hit of coordinated(text, idHits, anchor)) {
      checked++;
      const actual = registry[hit.id].proven_in || [];
      if (sameSet(claimedRepos, actual)) continue;
      findings.push({
        line: lineOf(lines, hit.start),
        claim: excerpt(text, hit.start, m.index + m[0].length),
        says: `${hit.id} proven_in: [${claimedRepos.join(', ')}]`,
        registry: `${hit.id} proven_in = [${actual.join(', ')}]`,
      });
    }
  }

  for (const f of findings) f.file = label;
  return { findings, checked, quoted };
}

// ── Driver ─────────────────────────────────────────────────────────────────────────────

function loadRegistry(file) {
  if (!fs.existsSync(file)) die(`capabilities registry not found: ${file}`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { die(`could not parse ${file}: ${e.message}`); }
  const list = parsed && parsed.capabilities;
  if (!Array.isArray(list) || !list.length) die(`${file} has no capabilities array — cannot check any claim against it`);

  // The status VOCABULARY is every status the schema defines, not only the ones currently in
  // use. Deriving it from the entries alone means that a registry with no `mature` capability
  // stops recognising "is mature" as a claim at all — a silent miss dressed as a clean run.
  const vocab = new Set(Object.keys((parsed && parsed.status_meaning) || {}).map((s) => s.toLowerCase()));

  const caps = {};
  for (const c of list) {
    // A malformed entry is not a licence to check the rest and call it clean: the prose this
    // gate reads may be about precisely the entry that failed to parse.
    if (!c || typeof c.id !== 'string' || !c.id) die(`${file} has a capability with no id`);
    if (typeof c.status !== 'string' || !c.status) die(`${file} entry "${c.id}" has no status`);
    if (c.proven_in !== undefined && !Array.isArray(c.proven_in)) die(`${file} entry "${c.id}" has a non-array proven_in`);
    caps[c.id] = { status: c.status, proven_in: c.proven_in || [] };
    vocab.add(String(c.status).toLowerCase());
  }
  if (!vocab.size) die(`${file} defines no statuses — nothing to check prose against`);
  return { caps, statuses: [...vocab] };
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
  const flag = (f) => args.includes(f);
  const VALUED = ['--repo', '--capabilities'];
  const cwd = path.resolve(get('--repo', process.cwd()));
  const registry = loadRegistry(path.resolve(get('--capabilities', path.join(cwd, 'capabilities.json'))));

  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUED.includes(args[i - 1])));

  let files;
  let scope;
  if (positional.length) {
    files = positional;
    scope = `${files.length} file(s) named on the command line`;
    for (const f of files) if (!fs.existsSync(path.resolve(cwd, f))) die(`file not found: ${f}`);
  } else {
    let tracked;
    try { tracked = git(['ls-files', '*.md'], cwd).split('\n').map((s) => s.trim()).filter(Boolean); }
    catch (e) { die(`could not list tracked files in ${cwd}: ${e.message.split('\n')[0]}`); }
    // No markdown at all is not a clean result — it is nearly always the wrong --repo.
    if (!tracked.length) die(`no tracked markdown in ${cwd} — wrong --repo, not a clean result`);
    const includeRecords = flag('--include-records');
    files = includeRecords ? tracked : tracked.filter((f) => !/^records\//.test(f));
    scope = `${files.length} tracked markdown file(s)`
      + (includeRecords ? ' (records included)' : `, ${tracked.length - files.length} under records/ not swept`);
  }

  const findings = [];
  let checked = 0;
  let quoted = 0;
  for (const f of files) {
    let raw;
    try { raw = fs.readFileSync(path.resolve(cwd, f), 'utf8'); }
    catch (e) { die(`could not read ${f}: ${e.message}`); }
    const r = checkText(raw, registry, f);
    findings.push(...r.findings);
    checked += r.checked;
    quoted += r.quoted;
  }

  if (!findings.length) {
    console.log(`check-registry-prose: ${checked} registry claim(s) in ${scope}, all matching capabilities.json`
      + (quoted ? `; ${quoted} skipped as quotation` : ''));
    return;
  }

  console.error('');
  console.error(`check-registry-prose: ${findings.length} prose claim(s) contradicted by capabilities.json`);
  for (const f of findings) {
    console.error('');
    console.error(`  claimed at: ${f.file}:${f.line}`);
    console.error(`  prose     : "${f.claim}"`);
    console.error(`  reads as  : ${f.says}`);
    console.error(`  registry  : ${f.registry}`);
  }
  console.error('');
  console.error('  Fix the prose, or fix the registry — whichever is wrong. The registry is the');
  console.error('  single source of truth for maturity; prose that restates it is a duplicate');
  console.error('  and will drift, and a reader cannot tell a stale claim from a current one.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = {
  checkText, loadRegistry, codeMask, quoteMask, normGap, gapUsable, coordinated, trailerOk,
  CONNECTIVE, PROVEN_LITERAL, TRAILER_WORDS,
};
