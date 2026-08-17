#!/usr/bin/env node
/**
 * check-manifest-refs.js — every {{manifest.key}} in a prompt resolves against the schema.
 *
 * Prompts and skills are stack-agnostic because they reference manifest KEYS rather than
 * concrete commands. That indirection only works if the keys are real. Two ways it breaks,
 * both silent:
 *
 *   UNRESOLVABLE  {{commands.typo.run}} — the subscriber fills in everything they can find
 *                 and ships a prompt containing a literal {{...}}. The agent then reads an
 *                 instruction with a hole in it and does something adjacent.
 *
 *   OPTIONAL-UNGUARDED  a key that is legitimately absent from a valid manifest, referenced
 *                 without a conditional. Same dangling placeholder, but only for the
 *                 subscribers who omitted it — so it survives review in the repo where the
 *                 key happens to be set. This one was found by the author of
 *                 prompts/daily-review.md flagging their own uncertainty about
 *                 branches.integration_deploys_to, not by any check.
 *
 * Unresolvable keys FAIL. Optional-unguarded keys WARN, because guarding every optional
 * reference would be heavier than the problem — but they are listed by file and line so the
 * decision is explicit: guard it, or promote the key to required.
 *
 *   node gates/check-manifest-refs.js [dir ...]     (default: prompts skills)
 *
 * Exit 0 clean, 1 unresolvable refs, 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Prose placeholders that are deliberately not manifest keys: template instructions to a
// human, and date components in a filename pattern.
const NOT_MANIFEST = new Set([
  'placeholders', 'manifest.*', 'YYYY', 'ww', 'n', 'name', 'owner', 'repo', 'slug',
  'prompt_file', 'file', 'files',
]);

const REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const SCANNABLE = /\.(md|markdown|tmpl)$/i;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  if (fs.statSync(dir).isFile()) { if (SCANNABLE.test(dir)) out.push(dir); return out; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'worktrees'].includes(e.name)) continue;
      walk(p, out);
    } else if (SCANNABLE.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Walk a dotted key against the JSON Schema. Returns {found, required} where `required`
 * means every segment is required by its parent — i.e. a valid manifest always has it.
 */
function resolve(schema, dotted) {
  const parts = dotted.split('.');
  let node = schema;
  let required = true;
  for (const part of parts) {
    if (!node || node.type === 'object' || node.properties) {
      const props = node.properties || {};
      // `commands.gate.run` — `run` lives inside a oneOf branch, so look through it.
      let next = props[part];
      if (!next && node.oneOf) {
        for (const branch of node.oneOf) {
          if (branch.properties && branch.properties[part]) { next = branch.properties[part]; break; }
        }
      }
      if (!next) return { found: false, required: false };
      if (!(node.required || []).includes(part)) required = false;
      node = next;
      if (node.$ref) return { found: true, required };  // treat $ref targets as resolvable
    } else if (node.oneOf) {
      let next = null;
      for (const branch of node.oneOf) {
        if (branch.properties && branch.properties[part]) { next = branch.properties[part]; break; }
      }
      if (!next) return { found: false, required: false };
      required = false;   // inside a oneOf, presence is never guaranteed
      node = next;
    } else {
      return { found: false, required: false };
    }
  }
  return { found: true, required };
}

/** Explicit template conditional, e.g. `{{ if x }} ... {{ end }}`. */
function inlineGuard(line) {
  return /\{\{\s*if\b/.test(line) || /^\s*\{\{\s*(if|end)\b/.test(line);
}

/**
 * A [CAPABILITY: id] section is ALSO a guard, and the most common one in this pack: the
 * subscriber deletes the section outright when the capability is off, and when it is on,
 * that capability's `requires` in capabilities.json guarantees the key is declared.
 *
 * Without this, the gate flags every capability-gated reference — and a checker whose
 * warnings are mostly noise is one people stop reading, which costs more than the class of
 * bug it catches.
 *
 * The marker is treated as governing until the next markdown heading, which is how these
 * files are actually structured.
 */
function capabilityGuards(lines, capRequires) {
  const guards = new Array(lines.length).fill(null);
  let active = null;
  lines.forEach((line, i) => {
    const m = /\[CAPABILITY:\s*([A-Za-z0-9_-]+)\s*\]/.exec(line);
    if (m && m[1] !== 'id') active = m[1];
    else if (/^#{1,6}\s/.test(line) || /^-{3,}\s*$/.test(line)) active = null;
    guards[i] = active;
  });
  return (i, key) => {
    const cap = guards[i];
    if (!cap) return false;
    const reqs = capRequires.get(cap) || [];
    // Guarded if the governing capability declares this exact key, or its parent object.
    return reqs.some((r) => r === key || key.startsWith(r + '.') || r.startsWith(key + '.'));
  };
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const roots = args.length ? args : ['prompts', 'skills'];

  const schemaPath = path.join(__dirname, '..', 'agent-loop.manifest.schema.json');
  if (!fs.existsSync(schemaPath)) { console.error('check-manifest-refs: schema not found'); process.exit(2); }
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  const regPath = path.join(__dirname, '..', 'capabilities.json');
  const capRequires = new Map();
  if (fs.existsSync(regPath)) {
    for (const c of JSON.parse(fs.readFileSync(regPath, 'utf8')).capabilities) capRequires.set(c.id, c.requires || []);
  }

  let bad = 0, warned = 0, total = 0, scanned = 0;

  for (const root of roots) {
    for (const file of walk(root)) {
      scanned++;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const capGuard = capabilityGuards(lines, capRequires);
      lines.forEach((line, i) => {
        for (const m of line.matchAll(REF)) {
          const key = m[1];
          if (NOT_MANIFEST.has(key) || !key.includes('.')) continue;
          total++;
          const r = resolve(schema, key);
          if (!r.found) {
            bad++;
            console.log(
              `  [BAD]  ${file}:${i + 1}\n` +
              `         {{${key}}} does not resolve against agent-loop.manifest.schema.json.\n` +
              `         A subscriber fills in what they can find and ships a prompt with a hole in it.`
            );
          } else if (!r.required && !inlineGuard(line) && !capGuard(i, key)) {
            warned++;
            console.log(
              `  [WARN] ${file}:${i + 1}\n` +
              `         {{${key}}} is OPTIONAL in the schema but referenced unconditionally.\n` +
              `         A manifest that omits it ships a dangling placeholder. Guard the line, or\n` +
              `         promote the key to required.`
            );
          }
        }
      });
    }
  }

  console.log(
    bad === 0 && warned === 0
      ? `\ncheck-manifest-refs: ${total} reference(s) across ${scanned} file(s), all resolve and are required`
      : `\ncheck-manifest-refs: ${bad} unresolvable, ${warned} optional-unguarded, of ${total} reference(s)`
  );
  process.exit(bad === 0 ? 0 : 1);
}

if (require.main === module) main();
