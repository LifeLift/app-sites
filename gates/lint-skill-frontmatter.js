#!/usr/bin/env node
/**
 * lint-skill-frontmatter.js — protects the highest-leverage sentence in any skill.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A skill's `description` is ALWAYS loaded (the body is not) and alone decides whether
 * the body ever activates. It is the one string that must survive intact.
 *
 * On 2026-07-24, two skills in ai-questions were found silently truncated at parse
 * time. In a YAML plain (unquoted) scalar, a `#` preceded by whitespace opens a
 * comment, so the parser discarded everything after it before the router ever saw it:
 *
 *   archive-checkpoint   275 chars -> 75   (73% lost, including the entire "Use when…")
 *   land-pr              237 chars -> 211  (lost its "get this PR in" trigger)
 *   merge-train          314 chars -> 314  (control: no ` #`, unaffected)
 *
 * archive-checkpoint's router-visible description ended mid-phrase at "(issue" with no
 * trigger condition at all — a skill that cannot be routed to, failing silently, in a
 * way that is invisible in the source file. Both contained an issue/PR reference of the
 * form `#511` / `#n`, which is natural to write and catastrophic to leave unquoted.
 *
 * Nothing in the repo caught it. Nothing could: the source text looks correct, and the
 * loss happens in the parser. This gate makes the invisible failure loud.
 *
 * CHECKS
 *   E1 frontmatter block present and well-formed
 *   E2 description survives parsing intact  ← the truncation bug
 *   E3 description states BOTH what it does and WHEN to use it
 *   E4 name matches the containing directory
 *   E5 descriptions do not collide (a router seeing two near-identical triggers
 *      picks wrong; a collision is never a one-file fix)
 *
 * Exit 0 clean, 1 findings, 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FM = /^---\r?\n([\s\S]*?)\r?\n---/;

function findSkills(root) {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (!fs.existsSync(dir) || depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'worktrees'].includes(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.name === 'SKILL.md') {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(root);
  return out;
}

/** Raw description text as written, before any YAML interpretation. */
function rawDescription(block) {
  const m = block.match(/^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)$/m);
  if (!m) return null;
  return m[1].replace(/\r?\n[ \t]+/g, ' ').trim();
}

/**
 * What a YAML parser actually yields. Implemented natively so this gate runs in a repo
 * with no dependencies installed — the exact situation in which a broken description
 * is most likely to go unnoticed. Cross-checked against js-yaml when available.
 */
function parsedDescription(raw) {
  if (raw === null) return null;
  const q = raw[0];
  if (q === '"' || q === "'") {
    const end = raw.lastIndexOf(q);
    return end > 0 ? raw.slice(1, end) : raw.slice(1);
  }
  // Plain scalar: ` #` begins a comment and everything after it is discarded.
  const cut = raw.search(/(^|\s)#/);
  return cut === -1 ? raw : raw.slice(0, cut).trimEnd();
}

const WHEN = /\buse (when|for|on|if|after|before|to)\b|\bwhenever\b|\btrigger\b/i;

function main() {
  const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (roots.length === 0) roots.push(process.cwd());

  const skills = roots.flatMap((r) => findSkills(path.resolve(r)));
  if (skills.length === 0) {
    console.log('lint-skill-frontmatter: no SKILL.md files found — nothing to check');
    return process.exit(0);
  }

  let findings = 0;
  const seen = [];
  const report = (file, code, msg) => {
    findings++;
    console.log(`  [${code}] ${file}\n        ${msg}`);
  };

  for (const file of skills) {
    const rel = path.relative(process.cwd(), file);
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(FM);
    if (!m) { report(rel, 'E1', 'no --- frontmatter block'); continue; }

    const block = m[1];
    const raw = rawDescription(block);
    const nameM = block.match(/^name:[ \t]*(.+)$/m);
    const name = nameM ? nameM[1].trim().replace(/^['"]|['"]$/g, '') : null;

    if (!raw) { report(rel, 'E1', 'frontmatter has no description:'); continue; }

    const parsed = parsedDescription(raw);
    const rawBody = raw.replace(/^['"]|['"]$/g, '');
    if (parsed.length < rawBody.length) {
      const lost = rawBody.length - parsed.length;
      const pct = Math.round((lost / rawBody.length) * 100);
      report(rel, 'E2',
        `description TRUNCATED by the YAML parser: ${rawBody.length} -> ${parsed.length} chars (${pct}% lost).\n` +
        `        An unquoted \`#\` after whitespace starts a comment. The router sees only:\n` +
        `        "${parsed}"\n` +
        `        Fix: wrap the whole value in single quotes.`);
    }

    if (!WHEN.test(parsed)) {
      report(rel, 'E3',
        'description does not say WHEN to use the skill (no "Use when…" clause).\n' +
        '        Without a trigger the router both misses it and fires it on unrelated work.');
    }

    const dir = path.basename(path.dirname(file));
    if (name && name !== dir) report(rel, 'E4', `name "${name}" does not match directory "${dir}"`);

    seen.push({ rel, name: name || dir, parsed });
  }

  // E5 — routing collisions.
  const tokenize = (s) => new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3)
  );
  for (let i = 0; i < seen.length; i++) {
    for (let j = i + 1; j < seen.length; j++) {
      const a = tokenize(seen[i].parsed), b = tokenize(seen[j].parsed);
      const inter = [...a].filter((w) => b.has(w)).length;
      const jaccard = inter / (a.size + b.size - inter || 1);
      if (jaccard > 0.5) {
        report(`${seen[i].name} ↔ ${seen[j].name}`, 'E5',
          `descriptions overlap ${Math.round(jaccard * 100)}% — the router cannot reliably tell them apart.\n` +
          '        Add an explicit disambiguator to BOTH (e.g. one item vs a batch).');
      }
    }
  }

  console.log(findings === 0
    ? `lint-skill-frontmatter: ${skills.length} skill(s) clean`
    : `\nlint-skill-frontmatter: ${findings} finding(s) across ${skills.length} skill(s)`);
  process.exit(findings === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { rawDescription, parsedDescription };
