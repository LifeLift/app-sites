#!/usr/bin/env node
/**
 * carve-out-paths.js — the authoritative answer to "is this path high-risk?"
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every loop needs a set of paths that must not be changed autonomously. The tempting
 * implementation is prose in a prompt — "work touching DB, deploy config, or secrets is
 * not autonomous" — and it fails the same way every time: the prose list drifts NARROWER
 * than reality, because prose is written from memory and memory omits.
 *
 * In ai-questions the prose carve-out omitted `.github/workflows/**`. Two PRs changed
 * workflow files, neither was labeled, both merged autonomously (#779/#780). The fix was
 * a machine-readable table — because a table is run, not recalled.
 *
 * DESIGN
 * ──────
 * There is deliberately NO exclusion or negation list. Exclusions are how a carve-out
 * quietly stops carving: one plausible-looking exception, and the surface it was meant to
 * protect is open. If a specific change inside a carve-out is genuinely safe, that is a
 * human's call on that PR — not a rule encoded here.
 *
 * FAILS CLOSED. An unreadable manifest, a malformed pattern, or an unexpected error
 * reports MATCHED, not clean. A classifier that fails open is worse than none: it converts
 * "we could not check" into "it is fine", which is the same conflation that let a dead
 * linter pass as a passing gate.
 *
 *   node gates/carve-out-paths.js --files <file-with-one-path-per-line>
 *   node gates/carve-out-paths.js path/one path/two
 *   git diff --name-only origin/main... | node gates/carve-out-paths.js --stdin
 *
 * First line of output is always `matched=true|false`, so callers can branch on it.
 * Exit 0 = no match, 1 = matched, 2 = usage error (which also prints matched=true).
 */

'use strict';

const fs = require('fs');
const path = require('path');

function failClosed(msg) {
  console.log('matched=true');
  console.error(`carve-out-paths: FAILING CLOSED — ${msg}`);
  process.exit(2);
}

/**
 * Minimal glob -> RegExp. Supports `**`, `*`, `?`, and a leading `!`-free literal.
 * Deliberately small: a full glob engine is a dependency, and this gate must run in a repo
 * before `npm install` is known to work.
 */
function globToRe(glob) {
  const g = String(glob).replace(/\\/g, '/').trim();
  if (!g) return null;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  // A bare directory prefix ("scripts/ci/") should match everything under it.
  if (g.endsWith('/')) re += '.*';
  return new RegExp('^' + re + '$');
}

function loadManifest(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.AGENT_LOOP_MANIFEST) candidates.push(process.env.AGENT_LOOP_MANIFEST);
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'agent-loop.manifest.json'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const c of candidates) {
    try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch (_) { /* keep looking */ }
  }
  return failClosed('no readable agent-loop.manifest.json found');
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

  const manifest = loadManifest(flag('--manifest'));

  // Both surfaces are high-risk. governance_files are included deliberately: a loop able
  // to edit the rules that bind it has no rules, and that hole existed unnoticed in a real
  // repo — its classifier returned no match for its own guard hooks.
  const surfaces = [
    ...(manifest.carve_outs || []).map((p) => ({ pattern: p, surface: 'carve-out' })),
    ...(manifest.governance_files || []).map((p) => ({ pattern: p, surface: 'governance' })),
  ];
  if (!surfaces.length) failClosed('manifest declares neither carve_outs nor governance_files');

  const compiled = surfaces.map((s) => {
    const re = globToRe(s.pattern);
    if (!re) failClosed(`unparseable pattern: ${s.pattern}`);
    return { ...s, re };
  });

  let files = [];
  const listFile = flag('--files');
  if (listFile) {
    try { files = fs.readFileSync(listFile, 'utf8').split('\n'); }
    catch (e) { failClosed(`cannot read --files ${listFile}: ${e.message}`); }
  } else if (argv.includes('--stdin')) {
    try { files = fs.readFileSync(0, 'utf8').split('\n'); }
    catch (e) { failClosed(`cannot read stdin: ${e.message}`); }
  } else {
    files = argv.filter((a) => !a.startsWith('--') && a !== listFile);
  }

  files = files.map((f) => String(f).replace(/\\/g, '/').replace(/^\.\//, '').trim()).filter(Boolean);
  if (!files.length) failClosed('no input paths given');

  const hits = [];
  for (const f of files) {
    // One hit per SURFACE, not one hit per file. The earlier version broke out of this loop
    // on the first pattern that matched, and because carve_outs are compiled ahead of
    // governance_files that silently masked the governance surface for every path in both
    // lists — which, in this repo, was 8 of the 9 governance patterns. `surfaces=governance`
    // was reachable only for `agent-loop.manifest.json`, the one governance-only entry.
    //
    // It made no difference to the yes/no question C5 asks, which is why it survived: both
    // surfaces are high-risk and `matched=` was always right. It mattered to anything reading
    // WHICH surface, and this file's own header says both are reported deliberately.
    const seen = new Set();
    for (const c of compiled) {
      if (seen.has(c.surface)) continue;
      // Match the full path, and also treat a pattern as matching any file beneath it.
      if (c.re.test(f) || c.re.test(f.replace(/\/[^/]*$/, '/'))) {
        hits.push({ file: f, surface: c.surface, pattern: c.pattern });
        seen.add(c.surface);
      }
    }
  }

  const matched = hits.length > 0;
  console.log(`matched=${matched}`);
  console.log(`surfaces=${[...new Set(hits.map((h) => h.surface))].join(', ') || 'none'}`);
  console.log(`file_count=${files.length}`);
  for (const h of hits) console.log(`hit=${h.file} [${h.surface}] via ${h.pattern}`);

  process.exit(matched ? 1 : 0);
}

if (require.main === module) main();
module.exports = { globToRe };
