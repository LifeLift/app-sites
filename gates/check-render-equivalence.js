#!/usr/bin/env node
/**
 * Is every rendered prompt and skill in this repo still exactly what the template renders?
 *
 * Origin: issue #12. The pack's doctrine is "Adapt, never copy — the pack is stack-agnostic
 * and your repo is not." Measured on 2026-08-02 against both live subscribers, re-rendering
 * each one's prompts at ITS OWN pinned pack_version, with THAT version's own `renderPrompt`,
 * against ITS OWN manifest: 8 of 8 files came out BYTE-IDENTICAL, +0 / -0. No subscriber
 * carries a single line of hand adaptation. The manifest seam already absorbs everything the
 * adaptation step was supposed to handle.
 *
 * That is a fact with a short shelf life unless something holds it. This gate turns the
 * measurement into an enforced invariant:
 *
 *     insertRenderMarker(renderPrompt(template_source, local_manifest)) == committed file
 *
 * It costs nothing today — it is already true everywhere — and it catches the first
 * divergence on the day it appears rather than the day someone happens to look. That matters
 * more here than "the prompt is a bit stale" suggests: this repo's whole thesis is that a
 * wrong prompt looks exactly like a right one, and a rendered file is the one artifact where
 * "is it right" is mechanically decidable instead of a judgement call.
 *
 * WHERE THE TEMPLATE SOURCE COMES FROM, AND WHY --template-dir IS REQUIRED.
 * In THIS repo, `prompts/` IS the template source. Rendering it and comparing the result to
 * itself is not a weak check, it is a vacuous one: the committed templates are deliberately
 * unrendered (`{{repo.name}}`, `[CAPABILITY: ...]` blocks intact), so a self-check is
 * guaranteed to "fail" for reasons that are not drift, and in any repo where it did pass it
 * would only prove the file contains no placeholders — never that it matches upstream. The
 * invariant is only meaningful in a SUBSCRIBER: a repo with a `pack_version` pin, a rendered
 * `prompts/`, and a checkout of the template at that pin to render from. So this gate refuses
 * to run without `--template-dir`, exactly as `sync/check-pack-version.js` already does, and
 * for the same reason. There is deliberately NO network fetch: the subscriber's loop is
 * already required to keep a local template clone, and a gate that reaches the network is a
 * gate that fails for reasons unrelated to what it measures.
 *
 * The renderer is loaded from `<template-dir>/bootstrap/lib/scaffold.js` when it exists, not
 * from this repo's copy. The committed file was produced by the pinned version's renderer;
 * checking it with a newer one measures the renderer, not the file. Falls back to the local
 * copy and says so.
 *
 * THE PIN MUST MATCH, AND VERSION ALONE DOES NOT PROVE IT. If `<template-dir>/VERSION`
 * differs from `manifest.pack_version`, every diff is ambiguous — inherited from the version
 * gap, or genuine local drift, and this gate cannot tell which. That is a could-not-run, not a
 * failure and certainly not a pass, so it exits 2 and says which two versions disagree.
 *
 * The VERSION file is necessary and NOT sufficient, which this gate learned on its own first
 * real run. Pointed at the template's `main` (VERSION 0.8.2) with a subscriber pinned to
 * 0.8.2, it reported a HAND EDIT in `prompts/director-weekly.md`. It was not one: two commits
 * had landed on `prompts/` after the 0.8.2 bump, so the checkout's CONTENT was ahead of the
 * version it names. A gate confidently misattributing a cause is worse than one that says it
 * cannot tell — that is exactly the "confident claim with nothing behind it" this pack exists
 * to catch, produced by the pack. So when the template dir is a git repo, the checkout is also
 * confirmed against the tag `v<pin>`: no such tag, or render sources differing from it, is a
 * could-not-run.
 *
 * `--allow-version-skew` downgrades both checks to warnings for the deliberate case: seeing
 * what an upgrade would change, as a diff of rendered output, which issue #12 calls an
 * inheritance decision rather than a defect. Under that flag the HAND EDIT label is widened to
 * admit "or the template advanced", because with an unpinned source those are not separable.
 *
 * THE RENDER_MARKER CONTRACT, HONOURED AS WRITTEN.
 * scaffold.js defines `mode: 'render'` files as: left alone on re-runs WHILE THE MARKER LINE
 * REMAINS, re-rendered when it is absent. A file that no longer carries the marker has been
 * taken over by a human. This gate reports it as a DECLARED OVERRIDE and never as drift —
 * removing the marker is how you say "I own this file now", and a gate that punished that
 * would be a gate people delete.
 *
 * One honest caveat about that, because the marker carries two meanings at once: absence also
 * tells `bootstrap` to re-render the file on its next run. So an override declared this way is
 * respected by this gate but is NOT protected from the scaffold — it survives until someone
 * runs bootstrap. That is the gap issue #12 proposes closing with structured overrides
 * ("replace section X", not a line patch); until those exist, this gate lists every override
 * it skipped, so the number is at least visible instead of silently growing.
 *
 * WHAT A DIFFERENCE MEANS. Issue #12's point is that each inequality has a distinct cause and
 * a bare red X hides which. Version skew is ruled out before anything is compared (above), so
 * what remains is local, and the gate labels each differing file mechanically:
 *   - the committed file still holds an unresolved non-prose `{{key}}` that the render
 *     resolves -> it predates rendering, or was rendered against a different manifest;
 *   - a `[CAPABILITY: id]` line is on one side of a hunk and not the other -> a capability
 *     flag flipped, which is the manifest and nothing else;
 *   - the committed line is ITSELF a legal render of the template line that produced the
 *     expected one (same literal prose, different value where the placeholder was) -> the
 *     manifest changed since this file was rendered. Re-render; nothing was hand-authored.
 *   - the prose differs outside any substituted value -> a hand edit. This one needs a human.
 * The last two are told apart by turning each template line into a pattern (literals kept,
 * non-prose placeholders as wildcards) rather than by comparing whole lines, which is a
 * distinction this gate got wrong on its first run of its own fixtures.
 *
 * The labels are a triage aid and can still be wrong at the edges (a hand edit that happens to
 * land exactly where a value was substituted reads as a manifest change). They never affect
 * the verdict — pass/fail is byte equality and nothing else.
 *
 * Usage:
 *   node gates/check-render-equivalence.js --template-dir ../agent-project-template
 *   node gates/check-render-equivalence.js --repo . --manifest agent-loop.manifest.json \
 *        --template-dir /path/to/template@pin [--allow-version-skew] [--max-hunks N]
 *
 * Exit 0 = every rendered file is byte-identical to a fresh render.
 * Exit 1 = at least one rendered file has drifted.
 * Exit 2 = could not run. Never report that as clean. An EMPTY file set is this case, not a
 *          pass: nothing to compare means a wrong --repo or --template-dir far more often
 *          than it means a repo with no prompts.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NAME = 'check-render-equivalence';

function die(msg, ...rest) {
  console.error(`${NAME}: ${msg}`);
  for (const line of rest) console.error(line);
  process.exit(2);
}

// Presence is tested on this SUBSTRING, not on RENDER_MARKER equality. The marker's wording
// has changed across pack versions and may change again; what identifies the line is the
// sentinel, and a subscriber whose marker text is a version behind is still a rendered file,
// not an override. Matching the exact string would silently reclassify those as human-owned —
// the one mistake this contract cannot afford.
const MARKER_SENTINEL = 'rendered-by-bootstrap';

// Mirrors the PROSE set inside scaffold.js's renderPrompt: keys it deliberately leaves alone
// because they are prose placeholders for a human, not manifest lookups. Duplicated on
// purpose — it is not exported, and reaching into the module's internals to get it would
// couple this gate to a private detail. If the two ever disagree, only a triage LABEL is
// wrong; the verdict comes from byte equality and never from this list.
const PROSE_KEYS = new Set(['placeholders', 'YYYY', 'ww', 'n', 'name', 'owner', 'prompt_file', 'manifest.*']);
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;

/** Non-prose placeholders left in a line — i.e. ones a real render would have substituted. */
function unresolvedKeys(line) {
  const out = [];
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(line)) !== null) {
    if (!PROSE_KEYS.has(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * The set of files bootstrap renders, derived by MIRRORING scaffoldFiles(): `prompts/*.md`
 * (never `.tmpl` — CLAUDE.md is generated from the manifest, not rendered) and
 * `skills/<name>/SKILL.md` except `bootstrap-project`, which is the template's own spawning
 * tool and has no business in a product repo. Kept as a list of {source, target} pairs so a
 * file that exists on one side only is reported as such rather than silently dropped.
 */
function renderTargets(templateDir) {
  const targets = [];
  const promptsDir = path.join(templateDir, 'prompts');
  if (fs.existsSync(promptsDir)) {
    for (const p of fs.readdirSync(promptsDir).sort()) {
      if (!p.endsWith('.md')) continue;
      targets.push({ source: path.join(promptsDir, p), rel: `prompts/${p}` });
    }
  }
  const skillsDir = path.join(templateDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const s of fs.readdirSync(skillsDir).sort()) {
      if (s === 'bootstrap-project') continue;
      const sk = path.join(skillsDir, s, 'SKILL.md');
      if (!fs.existsSync(sk)) continue;
      targets.push({ source: sk, rel: `skills/${s}/SKILL.md` });
    }
  }
  return targets;
}

/**
 * Line diff via LCS. No dependency, and no shelling out to `git diff`: the expected side is a
 * string that exists only in memory, so writing it to a temp file to diff it would be more
 * moving parts for the same answer.
 *
 * `a` is expected (the fresh render), `b` is actual (the committed file). '-' means a line the
 * render produced that the file does not have; '+' means a line the file has that the render
 * did not produce.
 */
const DIFF_LINE_CAP = 2000;

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: '=', text: a[i], i, j }); i++; j++; }
    else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) { ops.push({ op: '-', text: a[i], i, j }); i++; }
    else { ops.push({ op: '+', text: b[j], i, j }); j++; }
  }
  while (i < n) { ops.push({ op: '-', text: a[i], i, j }); i++; }
  while (j < m) { ops.push({ op: '+', text: b[j], i, j }); j++; }
  return ops;
}

/** Consecutive non-equal ops, grouped so a changed line reports as one hunk and not two. */
function hunks(ops) {
  const out = [];
  let cur = null;
  for (const o of ops) {
    if (o.op === '=') { if (cur) { out.push(cur); cur = null; } continue; }
    if (!cur) cur = { line: o.i + 1, expected: [], actual: [] };
    if (o.op === '-') cur.expected.push(o.text);
    else cur.actual.push(o.text);
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Is the checkout in `templateDir` actually the pin, and not merely a tree whose VERSION file
 * says so? Read-only git, no shell. Returns:
 *   { state: 'unknown' }        not a git repo (a tarball or archive export) — VERSION is all
 *                               there is, and this gate has already checked it.
 *   { state: 'untagged' }       a git repo with no `v<pin>` tag: the pin names a version this
 *                               checkout cannot demonstrate it is at.
 *   { state: 'ahead', files }   tagged, but the render sources differ from the tag.
 *   { state: 'at-pin' }         confirmed.
 */
function confirmAtPin(templateDir, pin) {
  const git = (args) => spawnSync('git', ['-C', templateDir, ...args], { encoding: 'utf8', timeout: 60000 });
  if (git(['rev-parse', '--git-dir']).status !== 0) return { state: 'unknown' };
  const tag = `v${pin}`;
  if (git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]).status !== 0) return { state: 'untagged', tag };
  // Working tree vs tag, restricted to what actually gets rendered. A template whose gates or
  // docs moved cannot change a rendered prompt, and failing on that would be noise.
  const d = git(['diff', '--name-only', tag, '--', 'prompts', 'skills']);
  if (d.status !== 0) return { state: 'unknown' };
  const files = d.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return files.length ? { state: 'ahead', tag, files } : { state: 'at-pin', tag };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * A template line as a pattern: literal prose, with each NON-prose placeholder as a wildcard.
 * `| gate | {{commands.gate.run}} |` becomes /^\| gate \| (.*?) \|$/, which matches every
 * legitimate render of that line and nothing else.
 *
 * This is what separates "the manifest changed" from "someone edited the prose", and the
 * cruder test it replaced could not. The first version of this gate compared whole lines
 * against the template's line set, so any line that had been substituted at all read as a
 * substitution difference — and a hand edit appended to a line carrying
 * `{{branches.integration}}` was reported as MANIFEST CHANGED. A confident wrong cause, on
 * the fixture built to catch exactly that. Prose placeholders (`{{YYYY}}`) stay literal,
 * because renderPrompt leaves them in place.
 */
function skeletonRe(line) {
  let out = '';
  let last = 0;
  let found = false;
  let m;
  PLACEHOLDER.lastIndex = 0;
  while ((m = PLACEHOLDER.exec(line)) !== null) {
    if (PROSE_KEYS.has(m[1])) continue;
    out += escapeRe(line.slice(last, m.index)) + '(.*?)';
    last = m.index + m[0].length;
    found = true;
  }
  if (!found) return null;
  return new RegExp(`^${out}${escapeRe(line.slice(last))}$`);
}

/** Every substitution-bearing line of a template source, as a pattern. Built once per file. */
function skeletons(src) {
  return src.split('\n').map(skeletonRe).filter(Boolean);
}

/**
 * Which of issue #12's causes does this difference look like? Triage only — see the header.
 * `templateLines` is the set of lines in the UNRENDERED template source; `skels` are their
 * patterns.
 */
function attribute(hs, templateLines, pinConfirmed, skels = []) {
  let substituted = 0;
  let verbatim = 0;
  let capability = false;
  const unrendered = new Set();
  for (const h of hs) {
    // A `[CAPABILITY: id]` line inside a hunk means a whole section appeared or vanished, and
    // only one input can do that: the capability flag in the manifest. Checked before the
    // line-level analysis because it explains the entire hunk at once.
    if ([...h.expected, ...h.actual].some((l) => /\[CAPABILITY:/.test(l))) capability = true;
    for (const e of h.expected) {
      if (!e.trim()) continue;
      // Template prose that survived substitution untouched, yet differs here.
      if (templateLines.has(e)) { verbatim++; continue; }
      // Otherwise: is the COMMITTED line also a legal render of the same template line? If so
      // only the substituted value differs. If not, the prose around the value was edited.
      const re = skels.find((r) => r.test(e));
      if (re && h.actual.some((a) => re.test(a))) substituted++;
      else if (re) verbatim++;
      else substituted++;
    }
    for (const a of h.actual) for (const k of unresolvedKeys(a)) unrendered.add(k);
  }
  if (capability) {
    return {
      label: 'CAPABILITY TOGGLED',
      detail: 'a [CAPABILITY: id] section is present on one side and absent on the other — only '
        + 'manifest.capabilities can do that',
      action: 'Re-render. The manifest turned a capability on or off after this file was rendered.',
    };
  }
  if (unrendered.size) {
    return {
      label: 'NEVER RENDERED, or rendered against a different manifest',
      detail: `the committed file still carries unresolved ${[...unrendered].slice(0, 4).map((k) => `{{${k}}}`).join(', ')}`,
      action: 'Re-render. A live prompt with a hole in it is the defect renderPrompt exists to prevent.',
    };
  }
  if (verbatim === 0 && substituted > 0) {
    return {
      label: 'MANIFEST CHANGED',
      detail: 'every differing line came out of a substituted region; no template prose differs',
      action: 'Re-render against the current manifest. Nothing here was hand-authored.',
    };
  }
  if (verbatim > 0) {
    // Only separable from "the template advanced" when the source is confirmed at the pin.
    // Without that confirmation, say both rather than pick the one that sounds decisive.
    return pinConfirmed ? {
      label: 'HAND EDIT',
      detail: `${verbatim} differing line(s) occur verbatim in the template source, so the prose itself differs here`,
      action: 'Either fold the change upstream into the template, or take ownership of the file '
        + 'by removing its render marker — which declares the override instead of hiding it.',
    } : {
      label: 'HAND EDIT or TEMPLATE ADVANCED (not separable — source is not confirmed at the pin)',
      detail: `${verbatim} differing line(s) occur verbatim in the template source, so the prose itself differs here`,
      action: 'Check the template out at the pin and re-run to tell these apart. If the template '
        + 'advanced, this is an inheritance decision: review the rendered diff and bump the pin.',
    };
  }
  return { label: 'STRUCTURAL', detail: 'lines added or removed only', action: 'Read the diff below.' };
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
  const repoRoot = path.resolve(get('--repo', process.cwd()));
  const manifestPath = path.resolve(get('--manifest', path.join(repoRoot, 'agent-loop.manifest.json')));
  const allowSkew = args.includes('--allow-version-skew');
  const maxHunks = Math.max(1, parseInt(get('--max-hunks', '4'), 10) || 4);
  const templateArg = get('--template-dir', null);

  // ── Inputs ────────────────────────────────────────────────────────────────────────────
  if (!templateArg) {
    die('no --template-dir.',
      '  This gate renders the TEMPLATE\'s prompts against THIS repo\'s manifest and compares the',
      '  result to the committed files. In the template repo itself, prompts/ IS the source, so a',
      '  self-check compares a file with a render of itself — vacuous, and guaranteed to differ',
      '  because the templates are deliberately unrendered. The invariant is a subscriber-side one.',
      '  Point this at a local checkout of the template at your pinned pack_version (the loop is',
      '  already expected to keep one — see sync/check-pack-version.js, which requires the same).');
  }
  const templateDir = path.resolve(templateArg);
  if (!fs.existsSync(templateDir)) die(`template dir not found: ${templateDir}`);
  if (templateDir === repoRoot) {
    die(`--template-dir is the repo itself (${repoRoot}).`,
      '  Comparing a file to a render of itself proves only that it holds no placeholders — never',
      '  that it still matches upstream. Give a checkout of the template at the pinned version.');
  }
  if (!fs.existsSync(manifestPath)) die(`manifest not found: ${manifestPath}`);

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { die(`could not parse ${manifestPath}: ${e.message}`); }
  const pin = manifest.pack_version;
  if (!pin) die(`${manifestPath} declares no pack_version — nothing says which template version rendered these files`);

  // ── The renderer, from the template being rendered ────────────────────────────────────
  const templateScaffold = path.join(templateDir, 'bootstrap', 'lib', 'scaffold.js');
  const localScaffold = path.join(__dirname, '..', 'bootstrap', 'lib', 'scaffold.js');
  const scaffoldPath = fs.existsSync(templateScaffold) ? templateScaffold : localScaffold;
  let scaffold;
  try { scaffold = require(scaffoldPath); }
  catch (e) { die(`could not load scaffold.js from ${scaffoldPath}: ${e.message}`); }
  const { renderPrompt, insertRenderMarker } = scaffold;
  if (typeof renderPrompt !== 'function' || typeof insertRenderMarker !== 'function') {
    die(`${scaffoldPath} does not export renderPrompt + insertRenderMarker — this gate has nothing to render with`);
  }
  // A template pinned before render_overrides existed (every tag ≤ v0.9.0) renders without
  // applying the manifest's overrides and would report every override line as HAND EDIT. The
  // override step is a post-render transform on the subscriber's data, so when the pinned
  // renderer lacks it, this checkout's is applied on top — the same rule bootstrap/render.js
  // --pin follows. Never silently drop a declared override.
  const overridesDeclared = Array.isArray(manifest.render_overrides) && manifest.render_overrides.length > 0;
  const applyOverridesOnTop = overridesDeclared && typeof scaffold.applyRenderOverrides !== 'function'
    ? require(localScaffold).applyRenderOverrides : null;
  const renderWithOverrides = (src, file) => {
    const out = renderPrompt(src, manifest, { file });
    return applyOverridesOnTop ? applyOverridesOnTop(out, manifest, file, { substitute: (t) => renderPrompt(t, manifest, {}) }) : out;
  };

  // ── The pin must match, or every diff is ambiguous ────────────────────────────────────
  const versionFile = path.join(templateDir, 'VERSION');
  const templateVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null;
  if (templateVersion === null && !allowSkew) {
    die(`no VERSION in ${templateDir}`,
      `  Cannot confirm the checkout is at this repo's pin (${pin}), so a difference could not be`,
      '  attributed. Check the template out at the pin, or pass --allow-version-skew and read every',
      '  difference as possibly inherited from the version gap.');
  }
  if (templateVersion !== null && templateVersion !== String(pin)) {
    if (!allowSkew) {
      die(`version skew: manifest pins pack_version ${pin}, template checkout is ${templateVersion}.`,
        '  A difference would be un-attributable — inherited from the gap, or genuine local drift.',
        `  Check the template out at v${pin}, or pass --allow-version-skew to read the diff as an`,
        '  inheritance decision (issue #12: "template advanced" is a review, not a defect).');
    }
    console.log(`${NAME}: WARNING — comparing against template ${templateVersion} while this repo pins ${pin}.`);
    console.log('  Differences below may be inherited from that gap rather than local drift.');
    console.log('');
  }

  // VERSION agreeing is necessary, not sufficient — see the header. Confirm against the tag
  // when the checkout is a git repo at all.
  const atPin = confirmAtPin(templateDir, pin);
  // 'unknown' counts as confirmed: a tarball export or vendored copy has no git history to
  // interrogate, VERSION is the only pin signal that exists there and it already matched —
  // the same standard sync/check-pack-version.js works to. Hedging every non-git checkout
  // would make the hedge permanent, and a caveat that is always printed stops being read.
  const pinConfirmed = atPin.state === 'at-pin' || atPin.state === 'unknown';
  if (atPin.state === 'untagged' || atPin.state === 'ahead') {
    const lines = atPin.state === 'untagged'
      ? [`template dir is a git repo with no ${atPin.tag} tag, so it cannot show it is the pinned version.`,
        '  VERSION alone is not proof: a tree can carry commits landed after its own version bump.']
      : [`template checkout is AHEAD of ${atPin.tag} in the files this gate renders from:`,
        ...atPin.files.slice(0, 6).map((f) => `    ${f}`),
        atPin.files.length > 6 ? `    +${atPin.files.length - 6} more` : null,
        '  Its VERSION still reads the pin, so the content moved without the version moving.'].filter(Boolean);
    if (!allowSkew) {
      die(...lines, '',
        `  Run \`git -C ${templateDir} checkout ${atPin.tag || `v${pin}`}\` and re-run, or pass`,
        '  --allow-version-skew to compare anyway and read every difference as possibly inherited.',
        '  Reporting a cause this gate cannot actually distinguish is the failure it exists to catch.');
    }
    console.log(`${NAME}: WARNING — ${lines[0]}`);
    console.log('  Causes below are hedged accordingly.');
    console.log('');
  }

  // ── Discovery. An empty set is a misconfiguration, not a pass ─────────────────────────
  const targets = renderTargets(templateDir);
  if (!targets.length) {
    die(`no renderable sources under ${templateDir} (prompts/*.md, skills/*/SKILL.md).`,
      '  A template with nothing to render is a wrong --template-dir, not a clean result.');
  }

  const drifted = [];
  const overrides = [];
  const absent = [];
  const clean = [];

  for (const t of targets) {
    const committedPath = path.join(repoRoot, t.rel);
    if (!fs.existsSync(committedPath)) { absent.push(t.rel); continue; }
    const actual = fs.readFileSync(committedPath, 'utf8');

    // The marker contract: no marker means a human took the file over. Declared override,
    // never drift. Skipped BEFORE rendering — the render would be irrelevant to a file that
    // is no longer claiming to be one.
    if (!actual.includes(MARKER_SENTINEL)) { overrides.push(t.rel); continue; }

    const src = fs.readFileSync(t.source, 'utf8');
    let expected;
    try { expected = insertRenderMarker(renderWithOverrides(src, t.rel)); }
    catch (e) { die(`renderPrompt threw on ${t.rel}: ${e.message}`); }

    if (expected === actual) { clean.push(t.rel); continue; }

    const aLines = expected.split('\n');
    const bLines = actual.split('\n');
    let hs = null;
    if (aLines.length <= DIFF_LINE_CAP && bLines.length <= DIFF_LINE_CAP) {
      hs = hunks(lcsDiff(aLines, bLines));
    }
    drifted.push({
      rel: t.rel,
      expectedLines: aLines.length,
      actualLines: bLines.length,
      hunks: hs,
      cause: hs ? attribute(hs, new Set(src.split('\n')), pinConfirmed, skeletons(src)) : null,
    });
  }

  const considered = clean.length + overrides.length + drifted.length;
  if (considered === 0) {
    die(`none of the ${targets.length} renderable file(s) exist under ${repoRoot}.`,
      `  Missing: ${absent.slice(0, 5).join(', ')}${absent.length > 5 ? `, +${absent.length - 5} more` : ''}`,
      '  Nothing to compare is a wrong --repo far more often than it is a repo with no prompts.');
  }

  // ── Report ────────────────────────────────────────────────────────────────────────────
  if (!drifted.length) {
    // Say how the pin was established, not just that it was — "0.8.0 per its VERSION file" and
    // "0.8.0 confirmed at tag v0.8.0" are different strengths of evidence and a reader of a
    // green result is entitled to know which one they got.
    const provenance = atPin.state === 'at-pin' ? `${templateVersion} confirmed at ${atPin.tag}`
      : atPin.state === 'unknown' ? `${templateVersion} per VERSION, not a git checkout`
        : `${templateVersion || '?'} — pin NOT confirmed (${atPin.state})`;
    console.log(`${NAME}: ${clean.length}/${clean.length + overrides.length} rendered file(s) byte-identical to `
      + `render(template ${provenance}, ${path.basename(manifestPath)})`);
    if (overrides.length) {
      console.log('');
      console.log(`  ${overrides.length} declared override(s) — no render marker, so a human owns them:`);
      for (const o of overrides) console.log(`    ${o}`);
      console.log('');
      console.log('  Not drift, and not checked. Note that bootstrap re-renders unmarked files on its');
      console.log('  next run, so this declaration is respected here but not protected there.');
      if (!clean.length) {
        console.log('');
        console.log('  EVERY file is an override — this gate enforced nothing on this run.');
      }
    }
    if (absent.length) {
      console.log(`  ${absent.length} template file(s) not present here: ${absent.join(', ')}`);
    }
    return;
  }

  console.error('');
  console.error(`${NAME}: ${drifted.length} rendered file(s) DIFFER from a fresh render`);
  console.error(`  template ${templateDir} @ ${templateVersion || 'unknown'} · manifest pin ${pin} · renderer ${path.relative(repoRoot, scaffoldPath) || scaffoldPath}`);

  for (const d of drifted) {
    const hs = d.hunks;
    console.error('');
    if (!hs) {
      console.error(`  ${d.rel}: differs (${d.expectedLines} expected vs ${d.actualLines} committed lines)`);
      console.error('    too large to diff in-process; run: diff <(render) committed');
      continue;
    }
    const added = hs.reduce((n, h) => n + h.actual.length, 0);
    const removed = hs.reduce((n, h) => n + h.expected.length, 0);
    console.error(`  ${d.rel}  +${added} / -${removed} lines in ${hs.length} hunk(s)  [${d.cause.label}]`);
    console.error(`    ${d.cause.detail}`);
    for (const h of hs.slice(0, maxHunks)) {
      console.error(`    @ line ${h.line}`);
      for (const e of h.expected.slice(0, 3)) console.error(`      render   : ${e.slice(0, 110)}`);
      for (const a of h.actual.slice(0, 3)) console.error(`      committed: ${a.slice(0, 110)}`);
    }
    if (hs.length > maxHunks) console.error(`    ... ${hs.length - maxHunks} more hunk(s) (--max-hunks to show more)`);
    console.error(`    -> ${d.cause.action}`);
  }

  console.error('');
  console.error(`  ${clean.length} file(s) clean, ${overrides.length} declared override(s)`
    + `${absent.length ? `, ${absent.length} not present here` : ''}.`);
  console.error('');
  console.error('  Measured 2026-08-02: every rendered file in every subscriber was byte-identical to a');
  console.error('  fresh render, +0/-0. A difference here is new, and it is one of the causes above —');
  console.error('  not a judgement call. Re-render, upstream it, or declare the override.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = {
  renderTargets, lcsDiff, hunks, attribute, skeletonRe, skeletons,
  unresolvedKeys, confirmAtPin, MARKER_SENTINEL,
};
