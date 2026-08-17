#!/usr/bin/env node
/**
 * check-model-attribution.js — is this work attributable to the model that produced it?
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every behavioural claim this pack makes is tied to a model version. The prompt-review
 * rubric carries `validated-against` and says outright that a rule tuned for one version
 * can regress on the next; `gates/check-rubric-validation.js` fails when the rubric no
 * longer covers `model.current`. All of that machinery assumes you can answer a simpler
 * question first: **which model actually did this work?**
 *
 * Today that answer lives in a convention — `model.commit_trailer` is declared in the
 * manifest and agents are asked to append it. A convention is exactly what fails silently.
 * `hooks/warn-carveout-edit.js` carried an unverified assumption in a header comment
 * through a full adoption cycle because the comment made it look considered rather than
 * open; `docs/ADOPTION.md` step 6 asked adopters to copy a file by hand and 0 of 2 did it.
 * An instruction nobody checks is a wish.
 *
 * WHAT IT CHECKS
 *   A1  every commit in the range carries the manifest's declared `model.commit_trailer`
 *   A2  the trailer names a model consistent with `model.current`
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * Attribution is not authorship policing. A human commit is not a defect, so `--allow`
 * exempts authors (or a `[skip-attribution]` marker) without weakening the rule for agent
 * work. And it never inspects WHAT a model produced — only that the record says which one
 * did, so a later regression can be traced to a version rather than guessed at.
 *
 * Usage:
 *   node gates/check-model-attribution.js --base origin/main [--head HEAD] [--allow <name>]
 *
 * Exit 0 = every commit attributable. 1 = one or more are not. 2 = could not run.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function die(msg) { console.error(`check-model-attribution: ${msg}`); process.exit(2); }

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 32 * 1024 * 1024 });
}

/** The trailer names a model if the manifest's model id survives normalisation into it. */
function trailerNamesModel(trailer, current) {
  const norm = (s) => String(s).toLowerCase().replace(/(\d)-(\d)/g, '$1.$2').replace(/[^a-z0-9.]+/g, ' ').trim();
  const t = norm(trailer);
  const words = norm(current).split(' ').filter(Boolean);
  // Every token of the model id must appear somewhere in the trailer. Deliberately loose
  // about ORDER and punctuation ("Claude Opus 5" vs "claude-opus-5") and deliberately
  // strict about presence: a trailer that omits the version is the case this gate exists
  // to catch, because it is the one that cannot be traced after a model change.
  return words.every((w) => t.includes(w));
}

/**
 * A trailer is attributable if it names ANY model this repo declares it runs on.
 *
 * `model.current` was modelled as a constant and is not one. Measured across three days in
 * agent-project-template: the Director ran on claude-opus-5, then claude-fable-5, then
 * claude-opus-5 again, and each flip made this gate reject a TRUTHFUL trailer in CI. The
 * owner's account of the mechanism is that the provider may move a Fable session to Opus
 * server-side on a safety trigger — so the model can change with nobody having decided
 * anything, mid-session, after the manifest was written.
 *
 * A gate that fires on honest attribution teaches authors to write dishonest attribution.
 * So the check widens from one id to a declared SET, and not one inch further: a trailer
 * naming a model NOT in the set still fails, and a missing trailer still fails. Those are
 * the two cases this gate exists to catch, and neither is weakened. What is dropped is the
 * false premise that a repo runs on exactly one model.
 */
function acceptedModels(m) {
  const extra = (m.model && Array.isArray(m.model.accepted)) ? m.model.accepted : [];
  return [m.model.current, ...extra].filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
  const cwd = path.resolve(get('--repo', process.cwd()));
  const base = get('--base', null);
  const head = get('--head', 'HEAD');
  const allow = (get('--allow', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

  const manifestPath = path.join(cwd, 'agent-loop.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('check-model-attribution: no manifest; nothing declares a trailer (skipped)');
    return;
  }
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const trailer = m.model && m.model.commit_trailer;
  const current = m.model && m.model.current;
  if (!trailer) die('manifest declares no model.commit_trailer — nothing to enforce');
  if (!current) die('manifest declares no model.current');
  const accepted = acceptedModels(m);

  if (!base) {
    console.log('check-model-attribution: no --base given; this gate is per-range (skipped)');
    return;
  }

  let shas;
  try {
    shas = git(['rev-list', `${base}..${head}`], cwd).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    die(`could not list ${base}..${head}: ${e.message.split('\n')[0]}`);
  }

  // An empty range is not a pass. It nearly always means a bad base ref, and reporting
  // "all commits attributable" over zero commits is the shape this pack exists to refuse.
  if (!shas.length) {
    die(`range ${base}..${head} contains no commits — a bad base ref, not a clean result`);
  }

  const missing = [];
  const mismatched = [];
  for (const sha of shas) {
    const body = git(['log', '-1', '--format=%B', sha], cwd);
    const author = git(['log', '-1', '--format=%an <%ae>', sha], cwd).trim();
    const subject = git(['log', '-1', '--format=%s', sha], cwd).trim();
    if (allow.some((a) => author.includes(a)) || /\[skip-attribution\]/i.test(body)) continue;

    const line = body.split('\n').find((l) => l.trim().startsWith(trailer.split(':')[0]));
    if (!line) { missing.push({ sha: sha.slice(0, 8), subject, author }); continue; }
    if (!accepted.some((id) => trailerNamesModel(line, id))) {
      mismatched.push({ sha: sha.slice(0, 8), subject, found: line.trim() });
    }
  }

  if (!missing.length && !mismatched.length) {
    console.log(`check-model-attribution: ${shas.length} commit(s), all attributable to ${accepted.join(', ')}`);
    return;
  }

  console.error('');
  if (missing.length) {
    console.error(`check-model-attribution: ${missing.length} commit(s) carry no attribution trailer`);
    for (const c of missing) console.error(`  ${c.sha}  ${c.subject.slice(0, 62)}`);
  }
  if (mismatched.length) {
    console.error('');
    console.error(`check-model-attribution: ${mismatched.length} commit(s) name a model this repo does not declare it runs on`);
    for (const c of mismatched) console.error(`  ${c.sha}  found: ${c.found.slice(0, 70)}`);
    console.error(`  Declared: ${accepted.join(', ')}  (model.current plus model.accepted)`);
    console.error('  If the trailer is TRUE, the manifest is the stale fact — add the id to');
    console.error('  model.accepted rather than rewriting the trailer to match.');
  }
  console.error('');
  console.error(`  Expected trailer: ${trailer}`);
  console.error('  Every behavioural claim in this pack is tied to a model version. Work that');
  console.error('  does not say which model produced it cannot be re-validated after an upgrade,');
  console.error('  and a later regression cannot be traced to a version rather than guessed at.');
  console.error('  Human commits: pass --allow <author> or add [skip-attribution] to the body.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = { trailerNamesModel };
