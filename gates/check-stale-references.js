#!/usr/bin/env node
/**
 * Did this change delete something that an owner-facing document still tells a human to use?
 *
 * THE INCIDENT. A merged launch plan instructed the owner to point paid advertising at a URL
 * that returns 404. The route had been removed; the plan still named it; the correction lived
 * only in a PR comment, which is the one place that owner never looks. Where the human does
 * not read the tracker, owner-facing prose IS the interface, and a stale document there is
 * not cosmetic — it is the deliverable being wrong.
 *
 * WHY A SEPARATE GATE FROM check-claims-vs-diff.js. That gate quotes this same incident in
 * its own header, and does not catch it. It compares a PR body's claims against the diff, so
 * it only ever inspects files the diff TOUCHES. This failure is the opposite shape: the
 * damage is in a file the diff does not touch, which is exactly why nobody notices. Two
 * different questions, and the second one had no owner until now.
 *
 * WHAT IT COMPARES. String literals the diff REMOVES, against occurrences in owner-facing
 * documents the diff does NOT change. Removed-only is load-bearing in two directions:
 *
 *   - a diff that ADDS a route has not staled anything, so added lines are not sources;
 *   - a literal that appears in both removed and added lines was MOVED or reformatted, not
 *     deleted, so it is excluded. Without that second rule every reindent of a config block
 *     would report its own contents as stale, and a gate that noisy gets routed around.
 *
 * Deliberately narrow, on the same reasoning as check-claims-vs-diff.js: only full URLs and
 * multi-segment path-like literals are extracted, both above a length floor. Bare words and
 * single-segment paths are not, because "user" or "/api" appear everywhere and a finding
 * nobody believes is worse than no finding.
 *
 * Usage:
 *   node gates/check-stale-references.js --base origin/main [--head HEAD] [--repo .]
 *   node gates/check-stale-references.js --base origin/main --docs 'docs,README.md'
 *
 * Exit 0 = nothing removed is still referenced. 1 = a stale reference. 2 = could not run.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function die(msg) { console.error(`check-stale-references: ${msg}`); process.exit(2); }

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
}

// Full URLs, and absolute path-like literals with at least two segments. The length floors
// are the whole false-positive defence: `/a/b` is not distinctive, `/pricing/annual` is.
const URL_RE = /\bhttps?:\/\/[^\s"'`)>\],]{8,}/g;
const PATH_RE = /(?:^|[\s"'`(=])(\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+)/gi;
const MIN_PATH_LEN = 8;

function literalsFrom(lines) {
  const out = new Set();
  for (const l of lines) {
    const body = l.slice(1); // drop the +/- marker
    for (const m of body.match(URL_RE) || []) out.add(m.replace(/[.,;:)]+$/, ''));
    let m;
    PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(body)) !== null) {
      const p = m[1];
      if (p.length >= MIN_PATH_LEN) out.add(p);
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
  const cwd = path.resolve(get('--repo', process.cwd()));
  const base = get('--base', null);
  const head = get('--head', 'HEAD');

  // No base means no diff to reason about. This runs per-change, so a bare invocation is a
  // configuration mistake rather than a clean state — say which, and do not print a pass.
  if (!base) {
    console.log('check-stale-references: no --base given; this gate is per-change (skipped)');
    return;
  }

  let changed, removedLines, addedLines;
  try {
    const range = `${base}...${head}`;
    changed = git(['diff', '--name-only', range], cwd).split('\n').map((s) => s.trim()).filter(Boolean);
    const diff = git(['diff', '--unified=0', range], cwd).split('\n');
    removedLines = diff.filter((l) => l.startsWith('-') && !l.startsWith('---'));
    addedLines = diff.filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  } catch (e) {
    die(`could not diff ${base}...${head}: ${e.message.split('\n')[0]}`);
  }

  if (!changed.length) {
    die(`diff ${base}...${head} is empty — nothing can be stale, so this is a misconfigured `
      + `base ref, not a clean result`);
  }

  const removed = literalsFrom(removedLines);
  const added = literalsFrom(addedLines);
  // Present on both sides = moved or reformatted, not deleted.
  const deleted = [...removed].filter((r) => !added.has(r));
  if (!deleted.length) {
    console.log('check-stale-references: no URLs or routes removed by this change');
    return;
  }

  // Owner-facing surface: prose a human reads, minus whatever this change already updated.
  const docGlobs = (get('--docs', null) || 'docs,README.md,*.md').split(',').map((s) => s.trim());
  let docFiles;
  try {
    docFiles = git(['ls-files', ...docGlobs], cwd).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    die(`could not list doc files: ${e.message.split('\n')[0]}`);
  }
  const changedSet = new Set(changed);
  const targets = docFiles.filter((f) => !changedSet.has(f));

  const findings = [];
  for (const f of targets) {
    let content;
    try { content = fs.readFileSync(path.join(cwd, f), 'utf8'); } catch (_) { continue; }
    const lines = content.split('\n');
    for (const lit of deleted) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(lit)) {
          findings.push({ file: f, line: i + 1, literal: lit, text: lines[i].trim().slice(0, 100) });
          break; // one hit per literal per file is enough to act on
        }
      }
    }
  }

  if (!findings.length) {
    console.log(`check-stale-references: ${deleted.length} literal(s) removed, none still referenced in ${targets.length} unchanged doc(s)`);
    return;
  }

  console.error('');
  console.error(`check-stale-references: ${findings.length} stale reference(s) — this change removed something a document still names`);
  for (const f of findings) {
    console.error('');
    console.error(`  removed  : ${f.literal}`);
    console.error(`  still in : ${f.file}:${f.line}`);
    console.error(`  text     : ${f.text}`);
  }
  console.error('');
  console.error('  Update the document in this change, or say why it is still correct.');
  console.error('  A human reading that file has no way to know the reference is dead.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = { literalsFrom };
