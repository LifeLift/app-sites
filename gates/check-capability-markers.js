#!/usr/bin/env node
/**
 * check-capability-markers.js — every [CAPABILITY: id] marker names a real capability.
 *
 * Prompts and skills gate optional sections with [CAPABILITY: some-id] so a subscriber can
 * delete what does not apply. The marker is only useful if the id resolves: a typo, or an id
 * left behind after a capability is renamed or removed from capabilities.json, produces a
 * section nobody can reason about — the subscriber cannot tell whether it applies, and
 * check-capabilities.js will never mention it because it only ever looks at the manifest.
 *
 * That is the same silent-divergence shape the rest of this pack exists to close, so it gets
 * the same treatment: a deterministic check rather than a convention people are asked to
 * remember.
 *
 * Written after a hand-rolled version of this scan reported 4 failures that were all the
 * literal placeholder `[CAPABILITY: id]` appearing in the files' own explanatory headers.
 * A checker whose false positives outnumber nothing is a checker people learn to ignore, so
 * that exact placeholder is exempt by name.
 *
 *   node gates/check-capability-markers.js [dir ...]      (default: prompts skills docs)
 *
 * Exit 0 clean, 1 findings, 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// The documented placeholder, not a marker. `id` is never a real capability id.
const PLACEHOLDER = 'id';
const MARKER = /\[CAPABILITY:\s*([A-Za-z0-9_-]+)\s*\]/g;
const SCANNABLE = /\.(md|markdown|tmpl|ya?ml|json)$/i;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const st = fs.statSync(dir);
  if (st.isFile()) { if (SCANNABLE.test(dir)) out.push(dir); return out; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'worktrees'].includes(e.name)) continue;
      walk(p, out);
    } else if (SCANNABLE.test(e.name)) out.push(p);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const roots = args.length ? args : ['prompts', 'skills', 'docs', '.github'];

  const regPath = path.join(__dirname, '..', 'capabilities.json');
  if (!fs.existsSync(regPath)) { console.error('check-capability-markers: capabilities.json not found'); process.exit(2); }
  const known = new Set(JSON.parse(fs.readFileSync(regPath, 'utf8')).capabilities.map((c) => c.id));

  let total = 0, bad = 0, scanned = 0;
  const used = new Set();

  for (const root of roots) {
    for (const file of walk(root)) {
      scanned++;
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(MARKER)) {
          const id = m[1];
          if (id === PLACEHOLDER) continue;   // the documented convention, not a marker
          total++;
          used.add(id);
          if (!known.has(id)) {
            bad++;
            console.log(
              `  [BAD] ${file}:${i + 1}\n` +
              `        [CAPABILITY: ${id}] — not in capabilities.json\n` +
              `        Either the id is a typo, or the capability was renamed/removed and this\n` +
              `        section was left orphaned.`
            );
          }
        }
      });
    }
  }

  // A capability that nothing gates on is not an error, but it is worth surfacing: it means
  // either the feature needs no prompt changes, or a section was never written for it.
  const gateable = [...known].filter((id) => !used.has(id));
  if (gateable.length) {
    console.log(`\n  note: ${gateable.length} capabilities are never referenced by a marker:`);
    console.log(`        ${gateable.join(', ')}`);
    console.log('        Fine if they need no prompt text; a gap if they do.');
  }

  console.log(bad === 0
    ? `\ncheck-capability-markers: ${total} marker(s) across ${scanned} file(s), all resolve`
    : `\ncheck-capability-markers: ${bad} invalid of ${total} marker(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

if (require.main === module) main();
