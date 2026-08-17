#!/usr/bin/env node
/**
 * check-director-record.js — a Director record must carry one C0 line per roster entry.
 *
 * WHY. gates/check-subscribers.js derives every subscriber's state, but it runs in the
 * Director's session, and the Director's session is a place a step can be skipped, short-
 * written, or rationalised ("environmental, expected"). The record is the artifact that
 * outlives the session, so the record is where the check has to be enforceable. This gate
 * runs in CI on any PR that touches records/director/ and fails unless each touched record
 * contains a `C0 <id>:` line for every non-retired id in subscribers.json.
 *
 * It checks PRESENCE, not truth: it cannot tell a real measurement from a typed one. What
 * it removes is the silent case — a pass that never ran the roster leaves a record with no
 * C0 lines, and that record now cannot merge. A Director who wants to lie has to type seven
 * false measurements into a permanent file under their own attribution trailer, which is a
 * different and much rarer failure than forgetting.
 *
 * DAILY REVIEW LOG (issue #53) is comments, not files, and is out of scope here.
 *
 *   node gates/check-director-record.js <record.md> [<record.md> ...]
 *   node gates/check-director-record.js --changed-since <base-sha>   # records touched by a range
 *
 * Exit 0 = every checked record carries every required line; 1 = a line is missing;
 *      2 = usage error. A run that finds NO record to check exits 0 with a note — a PR that
 *      does not touch a record owes nothing here.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const repo = path.resolve(opt('--repo') || process.cwd());
const roster = JSON.parse(fs.readFileSync(path.join(repo, 'subscribers.json'), 'utf8'));
const required = roster.subscribers.filter((s) => !s.retired).map((s) => s.id);

let files = argv.filter((a) => a.endsWith('.md'));
const since = opt('--changed-since');
if (since) {
  const r = spawnSync('git', ['diff', '--name-only', since, 'HEAD', '--', 'records/director/'], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) { console.error(`check-director-record: git diff failed: ${r.stderr}`); process.exit(2); }
  // Only WEEKLY records owe C0 lines. records/director/ may also hold standing files — a
  // conditions register, an index — and a file that is not a week's pass measured nothing.
  files = files.concat(r.stdout.split('\n').filter((f) => /\/\d{4}-W\d{2}\.md$/.test(f) && fs.existsSync(path.join(repo, f))));
}
if (!files.length) { console.log('check-director-record: no Director record in scope — nothing owed'); process.exit(0); }

let bad = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(repo, f), 'utf8');
  const missing = required.filter((id) => !new RegExp(`(^|\\n)\\s*(\\| |- |\\* |> )?\\s*(\\*\\*)?C0\\s+${id.replace(/[-]/g, '\\-')}\\s*:`, 'm').test(text) && !new RegExp(`\`C0 ${id}:`).test(text));
  if (missing.length) {
    bad++;
    console.log(`check-director-record: ${f} is missing a C0 line for: ${missing.join(', ')}`);
    console.log('  Every non-retired roster id gets one line per pass, from `node gates/check-subscribers.js` — including the ones that are fine.');
    console.log('  A record with no C0 lines is a pass that never measured its subscribers, and that is the failure the roster exists to catch.');
  } else {
    console.log(`check-director-record: ${f} carries all ${required.length} C0 lines`);
  }
}
process.exit(bad ? 1 : 0);
