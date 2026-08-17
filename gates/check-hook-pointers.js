#!/usr/bin/env node
/**
 * check-hook-pointers.js — keeps the always-loaded surface from asserting facts it does
 * not own.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A SessionStart hook is read at the top of every session. That makes it the most
 * expensive place in the system to be wrong, and the hardest place to notice being wrong.
 *
 * lifelift-mobile-backend's hook asserted which file held a test credential:
 *
 *     Test credentials: functions/.env.develop (BASELINE_USER_EMAIL / BASELINE_USER_PASSWORD)
 *
 * The password was not there. When the claim was corrected, it was corrected in CLAUDE.md
 * and NOT in the hook — so two always-loaded surfaces sat in every context window
 * contradicting each other, with the false one printed first. Agents went looking for a
 * value that lives only as an emulator-seed default.
 *
 * The general rule, and the only one that survives contact with time:
 *
 *     A hook that says "X is in file Y" is a DUPLICATE of file Y and will eventually
 *     disagree with it. A hook that says "see file Y" cannot.
 *
 * Both repos' hooks state this contract in their own header comments ("prints pointers
 * only, never values"). Neither enforced it. This gate does.
 *
 * WHAT IT FLAGS
 *   P1  an ENV-style identifier (SCREAMING_SNAKE) asserted to live at a concrete path
 *   P2  something that looks like an inlined secret value (assignment to a
 *       key/token/password/secret identifier)
 *   P3  a concrete path to a dotenv-style file presented as the location of named values
 *
 * WHAT IT DELIBERATELY ALLOWS
 *   - naming variables WITHOUT a location  ("reference BASELINE_USER_EMAIL by name")
 *   - naming files WITHOUT variables       ("see ENVIRONMENTS.md")
 *   - explicit negations                   ("... is NOT in functions/.env.develop")
 *   The failure mode is the CONJUNCTION of an identifier and a location asserted as fact.
 *
 * Exit 0 clean, 1 findings, 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Only text the hook EMITS can mislead a model. Code that merely reads configuration
// cannot. An earlier revision scanned whole lines and flooded on `process.env.FOO` —
// `.env` matched its path pattern — while MISSING the real bug, because the offending
// line ended "never copy values" and a blanket negation exemption swallowed it. Both
// failures came from matching lines instead of emitted strings.
const EMITS = /\b(echo|console\.(log|error|info)|print|printf|puts|out\.push|Write-(Host|Output))\b/;

const IDENT = '[A-Z][A-Z0-9_]{3,}';
// A concrete file location. `process.env` and similar property access are excluded by
// requiring the path to not be preceded by an identifier character or dot.
const PATHISH = '(?<![\\w.])(?:[\\w./\\\\-]+)?\\.(?:env[\\w.]*|json|ya?ml|toml|ini|cfg|properties)\\b';

const RE_IDENT = new RegExp(IDENT);
const RE_PATH = new RegExp(PATHISH);

// The ONLY safe exemption: an explicit negation binding the identifier to NOT being at
// that path ("BASELINE_USER_PASSWORD is NOT in functions/.env.develop"). That sentence is
// useful — it stops a wrong search — and is not an assertion of location. A negation
// elsewhere in the sentence, about something else entirely, exempts nothing.
const NEGATED_LOCATION = new RegExp(`\\b(?:not|never|no longer)\\b[^.;]{0,40}?${PATHISH}`, 'i');

// P2 — a value assigned inline to a secret-ish name. Placeholders are not values.
const P2 = /\b([A-Za-z_][\w-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)[\w-]*)\s*[:=]\s*["']?(?!<|\{\{|\$|\s*$|your|xxx|placeholder|example)([^\s"';,)]{6,})/i;

/** Pull the string literals out of an emitting line. */
function emittedStrings(line) {
  const out = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return out.filter(Boolean);
}

function findings(file) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#!')) return;
    if (!EMITS.test(line)) return; // not emitted -> cannot mislead a model

    for (const s of emittedStrings(line)) {
      if (P2.test(s)) {
        out.push({ n, code: 'P2', text: s, why: 'looks like an inlined secret VALUE' });
        continue;
      }
      if (!RE_IDENT.test(s) || !RE_PATH.test(s)) continue;
      if (NEGATED_LOCATION.test(s)) continue; // "X is NOT in <path>" — a pointer, not a claim
      out.push({
        n, code: 'P1', text: s,
        why: 'asserts that a named variable lives at a concrete path — this duplicates the file that owns that fact and will drift from it',
      });
    }
  });
  return out;
}

function collect(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return [target];
  const out = [];
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (e.isDirectory()) continue;
    if (/\.(sh|js|mjs|cjs|ps1|py)$/.test(e.name)) out.push(path.join(target, e.name));
  }
  return out;
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const targets = args.length ? args : ['.claude/hooks'];
  let total = 0;
  let scanned = 0;

  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    for (const file of collect(t)) {
      scanned++;
      for (const f of findings(file)) {
        total++;
        console.log(
          `  [${f.code}] ${file}:${f.n}\n` +
          `        ${f.text.slice(0, 150)}\n` +
          `        ${f.why}.\n` +
          `        Fix: print a POINTER to the document that owns this fact, not the fact.`
        );
      }
    }
  }

  if (scanned === 0) {
    console.log('check-hook-pointers: no hook scripts found — nothing to check');
    return process.exit(0);
  }
  console.log(total === 0
    ? `check-hook-pointers: ${scanned} file(s) clean`
    : `\ncheck-hook-pointers: ${total} finding(s) across ${scanned} file(s)`);
  process.exit(total === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { findings };
