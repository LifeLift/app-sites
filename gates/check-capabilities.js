#!/usr/bin/env node
/**
 * check-capabilities.js — reconciles what a repo ENABLED against what it NEEDS.
 *
 * The pack is deliberately not all-or-nothing. A shared-clone guard is load-bearing in a
 * repo where twenty sessions share one checkout and meaningless in a repo with one; a
 * metered-delegation economics dial is critical where an external agent bills per use and
 * noise where none exists. Adopting everything is how a template becomes the attention
 * dilution its own rubric warns about.
 *
 * So each capability declares when it APPLIES, and this gate reports four things:
 *
 *   MISSING-REQUIREMENT  enabled, but the manifest lacks something it needs -> it cannot work
 *   RECOMMENDED          mature, its detect condition matches this repo, not enabled
 *   UNNECESSARY          enabled, but its condition does not match -> pure overhead
 *   UNPROVEN             enabled and experimental -> you are the one measuring it
 *
 * Only MISSING-REQUIREMENT fails the build. The rest are advisory, because whether a
 * capability is worth its cost is a judgment about this repo that this gate cannot make.
 *
 *   node gates/check-capabilities.js --manifest agent-loop.manifest.json [--repo DIR] [--strict]
 *
 * Exit 0 clean, 1 findings (or advisories under --strict), 2 usage error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function die(m) { console.error(`check-capabilities: ${m}`); process.exit(2); }

/** Resolve a dotted path like "repo.shared_clone" against the manifest. */
function dig(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function isSet(v) {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Does this capability's declared condition hold for this repo? null = undecidable. */
function detect(cap, manifest, repoRoot) {
  const d = cap.detect;
  if (!d) return cap.default === 'on' ? true : null;
  if (d.manifest_set) return isSet(dig(manifest, d.manifest_set));
  if (d.manifest_nonempty) return isSet(dig(manifest, d.manifest_nonempty));
  // A string or an array of candidate locations; any one existing satisfies the detect.
  // Single-string-only was D9 (records/director/2026-W31.md): the template keeps skills
  // at skills/ while subscribers use .claude/skills, so the gate reported
  // skill-frontmatter-gate UNNECESSARY in the repo that authored it — a capability
  // reported absent while actively running, the exact conflation this pack exists for.
  if (d.path_exists) {
    const candidates = Array.isArray(d.path_exists) ? d.path_exists : [d.path_exists];
    return candidates.some((p) => fs.existsSync(path.join(repoRoot, p)));
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, dflt) => { const i = args.indexOf(f); return i === -1 ? dflt : args[i + 1]; };
  const strict = args.includes('--strict');
  const repoRoot = path.resolve(get('--repo', process.cwd()));
  const manifestPath = path.resolve(get('--manifest', path.join(repoRoot, 'agent-loop.manifest.json')));
  const registryPath = path.resolve(get('--registry', path.join(__dirname, '..', 'capabilities.json')));

  if (!fs.existsSync(manifestPath)) die(`manifest not found: ${manifestPath}`);
  if (!fs.existsSync(registryPath)) die(`registry not found: ${registryPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  // `capabilities` in the manifest may be an array of ids or an object of id -> bool.
  const raw = manifest.capabilities || {};
  const enabled = new Set(
    Array.isArray(raw) ? raw : Object.entries(raw).filter(([, v]) => v).map(([k]) => k)
  );
  const explicitlyOff = new Set(
    Array.isArray(raw) ? [] : Object.entries(raw).filter(([, v]) => v === false).map(([k]) => k)
  );

  let hard = 0;
  const advisories = [];
  const known = new Set(registry.capabilities.map((c) => c.id));

  for (const id of enabled) {
    if (!known.has(id)) {
      hard++;
      console.log(`  [UNKNOWN]  ${id}\n             not in the registry — typo, or a capability removed from the pack`);
    }
  }

  for (const cap of registry.capabilities) {
    const on = enabled.has(cap.id) || (!explicitlyOff.has(cap.id) && !raw[cap.id] && cap.default === 'on' && !Array.isArray(raw));
    const applies = detect(cap, manifest, repoRoot);

    if (on) {
      // A capability can also require a FILE to exist, not just a manifest key. Measured
      // 2026-08-02: session-orientation-hook was `true` in both subscribers, its hook was
      // registered, and neither repo had an always-loaded file anywhere — so the hook's
      // pointer list had nothing to point at while every signal reported healthy. A
      // capability whose artifact is absent is not enabled, it is decorative.
      const missingPaths = (cap.requires_path || []).filter(
        (rel) => !rel.split('|').some((alt) => fs.existsSync(path.join(repoRoot, alt.trim())))
      );
      if (missingPaths.length) {
        hard++;
        console.log(
          `  [MISSING-ARTIFACT] ${cap.id}\n` +
          `             enabled but these do not exist here: ${missingPaths.join(', ')}\n` +
          `             The capability cannot do anything. Create them, or disable it.`
        );
      }

      const missing = (cap.requires || []).filter((r) => !isSet(dig(manifest, r)));
      if (missing.length) {
        hard++;
        console.log(
          `  [MISSING-REQUIREMENT] ${cap.id}\n` +
          `             enabled but the manifest does not declare: ${missing.join(', ')}\n` +
          `             It cannot function. Declare them, or disable the capability.`
        );
      }
      if (applies === false) {
        advisories.push(
          `  [UNNECESSARY]  ${cap.id} (${cap.status})\n` +
          `             enabled, but its condition does not hold here: ${cap.applies_when}\n` +
          `             Cost if kept: ${cap.cost || 'unspecified'}\n` +
          `             ${cap.skip_when ? 'Skip when: ' + cap.skip_when : ''}`
        );
      }
      if (cap.status === 'experimental') {
        advisories.push(
          `  [UNPROVEN]     ${cap.id}\n` +
          `             experimental — ${cap.evidence || 'no production experience anywhere'}\n` +
          `             ${cap.caveat || ''}`
        );
      }
    } else if (applies === true && cap.status === 'mature' && !explicitlyOff.has(cap.id)) {
      advisories.push(
        `  [RECOMMENDED]  ${cap.id}\n` +
        `             mature, and its condition holds here: ${cap.applies_when}\n` +
        `             ${cap.evidence || cap.summary}\n` +
        `             Enable it, or set "${cap.id}": false to record the decision.`
      );
    }
  }

  if (hard) console.log('');
  if (advisories.length) {
    console.log('── advisories ──');
    console.log(advisories.join('\n'));
    console.log('');
  }

  const failed = hard > 0 || (strict && advisories.length > 0);
  console.log(
    hard === 0 && advisories.length === 0
      ? 'check-capabilities: clean'
      : `check-capabilities: ${hard} blocking, ${advisories.length} advisory`
  );
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
module.exports = { detect, dig };
