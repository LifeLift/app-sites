#!/usr/bin/env node
/**
 * Does the rubric still claim to be validated against the model this repo runs?
 *
 * `review/README.md` says the rubric refresh fires on cadence AND whenever
 * `manifest.model.current` differs from the rubric's `validated-against`, and that on
 * mismatch behavioural rules flip to `stale` and are reported as unvalidated rather than
 * silently trusted. Nothing implemented that comparison. The rubric sat claiming
 * `Claude Opus 4.6-4.8` while every subscriber ran `claude-opus-5`, and the only scheduled
 * consumer was a quarterly cron two months out — so six rules (A1 Blocking, A2-A6 High)
 * were being cited as measured on a model none of them had been measured on.
 *
 * WHAT THIS GATE DOES AND DOES NOT ENFORCE. It does NOT require the rubric to be current;
 * re-validating a severity needs a measured eval run and cannot be a precondition for
 * merging unrelated work. It requires only that the rubric SAY SO when it is behind. A
 * stale rule that is labelled stale is honest and usable. A stale rule that is not
 * labelled is the failure this pack exists to prevent: a confident claim with nothing
 * behind it, indistinguishable from a verified one.
 *
 * So: mismatch + every Blocking/High row marked stale -> exit 0 with a warning.
 *     mismatch + any Blocking/High row unmarked       -> exit 1.
 *     no mismatch                                     -> exit 0.
 *
 * Deliberately NOT parsed as YAML beyond the two frontmatter keys, and deliberately not
 * clever about model-name matching: substring containment both ways, because a family name
 * ("Claude Opus 5") legitimately covers a point id ("claude-opus-5"), and anything smarter
 * would silently accept a mismatch it half-understood. When in doubt this gate reports a
 * mismatch — the failure mode is a spurious warning, not a false clean.
 *
 * Usage: node gates/check-rubric-validation.js [--manifest <path>] [--rubric <path>]
 */

'use strict';

const fs = require('fs');
const path = require('path');

function die(msg) {
  console.error(`check-rubric-validation: ${msg}`);
  process.exit(2);
}

// Normalise for comparison: lowercase, strip punctuation that varies between how a model is
// written in prose ("Claude Opus 4.6-4.8") and as an id ("claude-opus-4-6").
function norm(s) {
  return String(s)
    .toLowerCase()
    // Model ids spell a version with hyphens ("claude-opus-4-6") where prose uses a dot
    // ("Opus 4.6"). Join digit-hyphen-digit first, or the id tokenises to bare "4" and "6"
    // and matches nothing. ASCII hyphen only: an en dash separates a RANGE ("4.6–4.8"),
    // which must stay two tokens because this gate does not expand ranges.
    .replace(/(\d)-(\d)/g, '$1.$2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
}

/**
 * Does `validatedAgainst` cover `current`? Containment either direction counts: the
 * frontmatter names families and ranges, the manifest names a point release, and neither is
 * a substring of the other in general. A range like "4.6-4.8" is NOT expanded — this gate
 * does not attempt version arithmetic, because a wrong answer there is worse than no answer.
 */
function covers(validatedAgainst, current) {
  const v = norm(validatedAgainst);
  const c = norm(current);
  if (!v || !c) return false;
  if (v.includes(c) || c.includes(v)) return true;
  // Compare on the model line only ("claude opus 5" vs "claude opus 4.6 4.8"): every
  // alphabetic token of the current id must appear, AND its version token must too.
  const cTokens = c.split(' ').filter(Boolean);
  const words = cTokens.filter((t) => !/\d/.test(t));
  const versions = cTokens.filter((t) => /\d/.test(t));
  const wordsPresent = words.every((w) => v.includes(w));
  const versionPresent = versions.length === 0 || versions.some((x) => v.split(' ').includes(x));
  return wordsPresent && versionPresent;
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
  const repoRoot = path.resolve(get('--repo', process.cwd()));
  const manifestPath = path.resolve(get('--manifest', path.join(repoRoot, 'agent-loop.manifest.json')));
  const rubricPath = path.resolve(get('--rubric', path.join(repoRoot, 'review', 'prompt-review-SKILL.md')));

  if (!fs.existsSync(rubricPath)) die(`rubric not found: ${rubricPath}`);
  // No manifest is not this gate's business to adjudicate — a repo may legitimately vendor
  // the rubric with no loop at all. Say so and pass; verify-affordances owns that failure.
  if (!fs.existsSync(manifestPath)) {
    console.log('check-rubric-validation: no manifest; nothing to compare against (skipped)');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const current = manifest.model && manifest.model.current;
  if (!current) die('manifest declares no model.current');

  const text = fs.readFileSync(rubricPath, 'utf8');
  const va = text.match(/^validated-against:\s*(.+)$/m);
  if (!va) die(`rubric has no validated-against in frontmatter: ${rubricPath}`);
  const validatedAgainst = va[1].trim();

  if (covers(validatedAgainst, current)) {
    console.log(`check-rubric-validation: rubric validated against "${validatedAgainst}", covers ${current}`);
    return;
  }

  // Mismatch. The rubric is behind — now the only question is whether it admits it.
  const rows = text.split('\n').filter((l) => /^\|\s*A\d+\s*\|/.test(l));
  if (!rows.length) die('no antipattern rows found — table shape changed, this gate needs updating');

  const unmarked = [];
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    // | # | Pattern | Severity | Status | Mechanism |  -> ['', '#', 'Pattern', ...]
    const id = cells[1];
    const severity = cells[3] || '';
    const status = cells[4] || '';
    if (!/^(Blocking|High)$/i.test(severity)) continue;
    if (!/stale/i.test(status)) unmarked.push(`${id} (${severity})`);
  }

  console.error('');
  console.error(`check-rubric-validation: MODEL MISMATCH`);
  console.error(`  rubric validated-against : ${validatedAgainst}`);
  console.error(`  manifest model.current   : ${current}`);
  console.error('');

  if (unmarked.length) {
    console.error('  These Blocking/High rules do not say they are unvalidated on this model:');
    for (const u of unmarked) console.error(`    ${u}`);
    console.error('');
    console.error('  Mark them stale in the Status column, or re-validate and update');
    console.error('  validated-against with what you TESTED. Per review/README.md, clearing');
    console.error('  staleness needs a measured evals/run-eval.js before/after; marking it');
    console.error('  does not.');
    process.exit(1);
  }

  console.error(`  All ${rows.length} rows accounted for; every Blocking/High rule is marked stale.`);
  console.error('  Honest, but still owed a measured refresh — see review/README.md.');
}

if (require.main === module) main();
module.exports = { covers, norm };
