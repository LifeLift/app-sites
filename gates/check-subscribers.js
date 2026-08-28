#!/usr/bin/env node
/**
 * check-subscribers.js — who does this pack manage, and is each of them actually managed?
 *
 * WHY THIS EXISTS
 * ───────────────
 * Until 2026-08-15 the pack had no roster. Propagation is pull ("it reports; the loop
 * decides"), so a repo was a subscriber if it happened to have pulled — and a repo that
 * never pulled was invisible to every tool in this pack BY CONSTRUCTION. Four weekly
 * Director passes reported clean while the two repos the pack was extracted to manage had
 * never received a single pack file. Then a Director, seeing no manifest in either, filed
 * them as "sources, not subscribers". Absence of an artifact was read as absence of intent.
 *
 * This gate makes that inference unnecessary and its conclusion unwritable:
 *
 *   1. subscribers.json DECLARES the set. Identity and intent only — there is no `status`
 *      field, because a status a Director can type is a status every downstream reader
 *      will trust, and the whole failure was a Director's typed conclusion.
 *   2. This gate DERIVES each entry's state from the subscriber's own INTEGRATION BRANCH —
 *      `git show origin/<integration>:agent-loop.manifest.json` — never from its working
 *      tree. Measured 2026-08-15: every sibling checkout on the Director's host sat on some
 *      session's feature branch (one with a pin two versions behind its own origin). A tree
 *      is whatever the last agent left; the remote-tracking ref is the branch of record.
 *   3. Every entry produces one line, every run, including the ones that are fine. A
 *      condition reported only when it fires cannot be told from one nobody checked.
 *
 * FAILS CLOSED, and says why. NO_DIR is red. WRONG_REMOTE is red. A checkout that has never
 * been fetched is red. If EVERY entry is unreachable the exit is 2 — "instrument not pointed
 * at anything" — not 1, because a red for everything is how red becomes background noise
 * (the design's own attacker found the naive `..` default resolves to `.claude/worktrees/`
 * from a session worktree, which would have made the very first run all-red for a path
 * reason and taught the reader to ignore it).
 *
 * NO NETWORK BY DEFAULT — the pack's rule for gates. Two opt-ins for the Director's own
 * run: --fetch (git fetch each clone first) and --allow-network (measure NO_DIR entries via
 * the GitHub API and tag the line via=remote). `npm run gates` and CI use --roster-only.
 *
 * MODES
 *   --roster-only        validate subscribers.json + cross-check capabilities.json; no repo
 *                        access. Add --base <ref> to also prove no id was REMOVED vs base.
 *   (default)            full measurement. Needs --checkouts-root <dir> or a derivable one:
 *                        parent of the pack's shared-clone root (git-common-dir), which is
 *                        where sibling checkouts live. Never cwd; never `..`.
 *
 *   node gates/check-subscribers.js --roster-only [--base origin/main]
 *   node gates/check-subscribers.js [--checkouts-root /abs] [--fetch] [--allow-network]
 *                                   [--max-fetch-age-days 7] [--json]
 *
 * Exit 0 = every non-retired entry ADOPTED (full) / roster consistent (roster-only)
 *      1 = at least one entry not ADOPTED, or a roster inconsistency
 *      2 = usage error, roster unreadable, or the instrument measured nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EXIT_OK = 0, EXIT_RED = 1, EXIT_USAGE = 2;

function die(msg) { console.error(`check-subscribers: ${msg}`); process.exit(EXIT_USAGE); }
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function readJson(p, what) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { die(`${what} unreadable at ${p}: ${e.message}`); }
}

// ── argv ──────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const packRoot = path.resolve(opt('--repo', process.cwd()));
const rosterPath = path.resolve(opt('--roster', path.join(packRoot, 'subscribers.json')));
const registryPath = path.resolve(opt('--registry', path.join(packRoot, 'capabilities.json')));
const rosterOnly = flag('--roster-only');
const baseRef = opt('--base', null);
const allowNetwork = flag('--allow-network');
const doFetch = flag('--fetch');
const maxFetchAgeDays = Number(opt('--max-fetch-age-days', '7'));
const asJson = flag('--json');

// ── roster: structural validation (hand-rolled; the pack keeps gates dependency-free) ──
const roster = readJson(rosterPath, 'roster');
const registry = readJson(registryPath, 'registry');
const problems = [];

if (roster.schema !== 1) problems.push('roster.schema must be 1');
if (!Array.isArray(roster.subscribers) || !roster.subscribers.length) problems.push('roster.subscribers must be a non-empty array');
// Which rendered prompts a subscriber owes at its integration ref is DERIVED from the roles it
// declares (subscribers.json `roles`, default loop + director; issue #109) and from its prompt
// mode (`prompts`: committed | inherited, #113). A control-plane repo runs [director, ops] and
// has no loop prompt to owe; a repo that inherits at run time commits no prompts at all. Until
// 2026-08-16 every subscriber was measured as if it ran the PR loop, and the honest states for
// idea-factory were a permanent red or a pointer file shaped like a prompt.
const ROLE_PROMPT = { loop: 'prompts/loop-monitor.md', director: 'prompts/director-weekly.md', 'daily-review': 'prompts/daily-review.md', contributor: 'prompts/contributor.md', ops: null };
const DEFAULT_ROLES = ['loop', 'director'];
function requiredRendered(entry) {
  if ((entry.prompts || 'committed') === 'inherited') return [];
  const roles = Array.isArray(entry.roles) && entry.roles.length ? entry.roles : DEFAULT_ROLES;
  return roles.map((r) => ROLE_PROMPT[r]).filter(Boolean);
}

const ids = new Set();
for (const s of roster.subscribers || []) {
  const where = `entry ${s && s.id ? s.id : JSON.stringify(s).slice(0, 40)}`;
  if (!s || typeof s !== 'object') { problems.push(`${where}: not an object`); continue; }
  for (const k of ['id', 'repo', 'role', 'local_path']) if (typeof s[k] !== 'string' || !s[k]) problems.push(`${where}: missing ${k}`);
  if (s.id && !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) problems.push(`${where}: id must be kebab-case`);
  if (s.id && ids.has(s.id)) problems.push(`${where}: duplicate id`);
  ids.add(s.id);
  if (s.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repo)) problems.push(`${where}: repo must be owner/name`);
  if (s.role && !['self', 'founding', 'subscriber'].includes(s.role)) problems.push(`${where}: role must be self|founding|subscriber`);
  if (s.tracking_issue !== undefined && !(Number.isInteger(s.tracking_issue) && s.tracking_issue > 0)) problems.push(`${where}: tracking_issue must be a positive integer`);
  if (s.retired !== undefined) {
    const r = s.retired;
    if (!r || typeof r !== 'object' || !r.at || !r.by || !r.quote || String(r.quote).length < 8) problems.push(`${where}: retired requires at, by, and a quote — a retirement without a quote is a deletion with better manners`);
  }
  if ('status' in s) problems.push(`${where}: has a "status" field. Status is DERIVED by this gate, never declared — remove it`);
  if (s.roles !== undefined && (!Array.isArray(s.roles) || !s.roles.length || s.roles.some((r) => !(r in ROLE_PROMPT)))) problems.push(`${where}: roles must be a non-empty array of ${Object.keys(ROLE_PROMPT).join('|')}`);
  if (Array.isArray(s.roles) && s.roles.length && s.roles.every((r) => !ROLE_PROMPT[r])) problems.push(`${where}: roles must include at least one pack role with a prompt (${Object.keys(ROLE_PROMPT).filter((r) => ROLE_PROMPT[r]).join('|')}) — ops alone is not adoption; the pack would run nothing there and read ADOPTED forever`);
  if (s.prompts !== undefined && !['committed', 'inherited'].includes(s.prompts)) problems.push(`${where}: prompts must be committed|inherited`);
  const known = new Set(['id', 'repo', 'host', 'role', 'local_path', 'since', 'tracking_issue', 'note', 'retired', 'roles', 'prompts']);
  for (const k of Object.keys(s)) if (!known.has(k)) problems.push(`${where}: unknown field ${k}`);
}
const selfIds = new Set((roster.subscribers || []).filter((s) => s.role === 'self').map((s) => s.id));
if (selfIds.size !== 1) problems.push(`exactly one role:self entry is required (found ${selfIds.size}) — the pack must measure itself so the instrument is known to work every run`);

// ── roster: cross-checks against capabilities.json ─────────────────────────────────────
for (const cap of registry.capabilities || []) {
  if ('proven_in' in cap) problems.push(`capabilities.json ${cap.id}: still uses proven_in — split it into originated_in (evidence born there, bespoke) and installed_in (the pack's artifact present+enabled at that subscriber's integration ref)`);
  for (const f of ['originated_in', 'installed_in']) {
    for (const name of cap[f] || []) {
      if (!ids.has(name)) problems.push(`capabilities.json ${cap.id}.${f} names "${name}", which is not a roster id — every repo the registry cites must be declared in subscribers.json`);
    }
  }
  for (const name of cap.installed_in || []) {
    if (selfIds.has(name)) problems.push(`capabilities.json ${cap.id}.installed_in names the pack itself — role:self never counts as installed anywhere`);
  }
  if ((cap.installed_in || []).length && !(cap.provides || []).length) {
    problems.push(`capabilities.json ${cap.id}: installed_in is non-empty but provides is [] — a prose-only capability has no artifact to be installed; its maturity rests on originated_in and must say so`);
  }
}

// ── roster: no id may be removed (only retired) ────────────────────────────────────────
if (baseRef) {
  const rel = path.relative(packRoot, rosterPath).split(path.sep).join('/');
  const r = git(packRoot, ['show', `${baseRef}:${rel}`]);
  if (r.ok) {
    let base; try { base = JSON.parse(r.out); } catch { base = null; }
    if (base && Array.isArray(base.subscribers)) {
      for (const b of base.subscribers) {
        if (!ids.has(b.id)) problems.push(`roster id "${b.id}" present at ${baseRef} is ABSENT here. Ids never leave; retire it (with a quote) instead. This is the design's own attacker: the repos that actually receive the pack are the ones with the fewest cross-references and the strongest incentive to "clean up".`);
      }
    }
  } else if (!/does not exist|exists on disk, but not in/.test(r.err)) {
    problems.push(`could not read roster at ${baseRef}: ${r.err}`);
  }
}

if (problems.length) {
  console.log('check-subscribers: ROSTER INCONSISTENT');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(EXIT_RED);
}
if (rosterOnly) {
  const active = roster.subscribers.filter((s) => !s.retired);
  console.log(`check-subscribers: roster consistent — ${roster.subscribers.length} declared (${active.length} active, ${roster.subscribers.length - active.length} retired); registry cross-checks clean${baseRef ? `; no id removed vs ${baseRef}` : ''}`);
  process.exit(EXIT_OK);
}

// ── full measurement ───────────────────────────────────────────────────────────────────
// Where do sibling checkouts live? The parent of the pack's SHARED CLONE — not cwd, which
// for a Director is a session worktree three levels down.
let checkoutsRoot = opt('--checkouts-root', null);
if (!checkoutsRoot) {
  const cd = git(packRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!cd.ok) die('cannot derive --checkouts-root: not a git repo? pass it explicitly');
  checkoutsRoot = path.dirname(path.dirname(cd.out)); // <root>/<pack>/.git -> <root>
}
checkoutsRoot = path.resolve(checkoutsRoot);
if (!fs.existsSync(checkoutsRoot)) die(`--checkouts-root does not exist: ${checkoutsRoot}`);

const packVersion = fs.existsSync(path.join(packRoot, 'VERSION')) ? fs.readFileSync(path.join(packRoot, 'VERSION'), 'utf8').trim() : null;
const packTags = new Set(git(packRoot, ['tag', '-l']).out.split('\n').filter(Boolean));

function normRemote(u) { return String(u || '').replace(/^git@github\.com:/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').toLowerCase(); }
function semverLt(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) < (pb[i] || 0)) return true; if ((pa[i] || 0) > (pb[i] || 0)) return false; }
  return false;
}

// Read a subscriber through its local clone's remote-tracking refs. Returns a measurement
// object; never touches the working tree.
function measureLocal(entry) {
  const dir = path.join(checkoutsRoot, entry.local_path);
  const m = { id: entry.id, via: 'local', dir };
  if (!fs.existsSync(dir)) { m.state = 'NO_DIR'; return m; }
  const remote = git(dir, ['remote', 'get-url', 'origin']);
  if (!remote.ok) { m.state = 'NO_REMOTE'; m.detail = 'no origin remote'; return m; }
  if (normRemote(remote.out) !== entry.repo.toLowerCase()) { m.state = 'WRONG_REMOTE'; m.detail = `origin=${remote.out}`; return m; }
  if (doFetch) { const f = git(dir, ['fetch', '-q', 'origin']); if (!f.ok) { m.fetch_error = f.err.slice(0, 120); } }
  // Freshness of the remote-tracking refs, from FETCH_HEAD in that clone's common dir.
  const cd = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const fh = cd.ok ? path.join(cd.out, 'FETCH_HEAD') : null;
  if (fh && fs.existsSync(fh)) m.fetched_days = Math.floor((Date.now() - fs.statSync(fh).mtimeMs) / 86400000);
  else m.fetched_days = null;
  // Candidate integration refs, in order: origin/HEAD's target, develop, main.
  const cands = [];
  const head = git(dir, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (head.ok) cands.push(head.out.replace('refs/remotes/', ''));
  for (const b of ['origin/develop', 'origin/main']) if (!cands.includes(b)) cands.push(b);
  let manifest = null, ref = null;
  for (const c of cands) {
    if (!git(dir, ['rev-parse', '--verify', '-q', c]).ok) continue;
    if (!ref) ref = c;
    const show = git(dir, ['show', `${c}:agent-loop.manifest.json`]);
    if (show.ok) { try { manifest = JSON.parse(show.out); ref = c; break; } catch { /* keep looking */ } }
  }
  if (!ref) { m.state = 'NO_REMOTE_REF'; m.detail = 'no origin/HEAD, origin/develop or origin/main — never fetched?'; return m; }
  // If the manifest names an integration branch, THAT is the ref of record; re-read there.
  if (manifest && manifest.branches && manifest.branches.integration) {
    const want = `origin/${manifest.branches.integration}`;
    if (want !== ref && git(dir, ['rev-parse', '--verify', '-q', want]).ok) {
      const show = git(dir, ['show', `${want}:agent-loop.manifest.json`]);
      ref = want;
      manifest = show.ok ? (() => { try { return JSON.parse(show.out); } catch { return null; } })() : null;
    }
  }
  m.ref = ref;
  m.sha = git(dir, ['rev-parse', '--short', ref]).out;
  m.manifest = manifest;
  m.tree = new Set(git(dir, ['ls-tree', '-r', '--name-only', ref]).out.split('\n').filter(Boolean));
  return m;
}

// Same measurement over the GitHub API, for entries with no local checkout. Only under
// --allow-network; the line is tagged via=remote so nobody mistakes it for a local read.
function measureRemote(entry) {
  const m = { id: entry.id, via: 'remote' };
  const gh = (args) => spawnSync('gh', ['api', ...args], { encoding: 'utf8' });
  const r = gh([`repos/${entry.repo}`, '--jq', '.default_branch']);
  if (r.status !== 0) { m.state = 'API_UNREACHABLE'; m.detail = (r.stderr || '').trim().slice(0, 120); return m; }
  let branch = r.stdout.trim();
  const readManifest = (b) => {
    const c = gh([`repos/${entry.repo}/contents/agent-loop.manifest.json?ref=${b}`, '--jq', '.content']);
    if (c.status !== 0) return null;
    try { return JSON.parse(Buffer.from(c.stdout.trim(), 'base64').toString('utf8')); } catch { return null; }
  };
  let manifest = readManifest(branch);
  if (manifest && manifest.branches && manifest.branches.integration && manifest.branches.integration !== branch) {
    branch = manifest.branches.integration; manifest = readManifest(branch);
  }
  m.ref = `origin/${branch}`;
  const sha = gh([`repos/${entry.repo}/commits/${branch}`, '--jq', '.sha']);
  m.sha = sha.status === 0 ? sha.stdout.trim().slice(0, 7) : '?';
  m.manifest = manifest;
  const t = gh([`repos/${entry.repo}/git/trees/${branch}?recursive=1`, '--jq', '.tree[].path']);
  m.tree = new Set(t.status === 0 ? t.stdout.split('\n').filter(Boolean) : []);
  m.fetched_days = 0;
  return m;
}

// Derive state from a measurement. This is the ONLY place a status is decided.
function derive(entry, m) {
  if (m.state) return m; // structural failure already set (NO_DIR etc.)
  const isSelf = entry.role === 'self';
  const notes = [];
  if (!m.manifest) { m.state = entry.tracking_issue ? 'OWED' : 'OWED-UNTRACKED'; m.detail = `no agent-loop.manifest.json at ${m.ref}`; return m; }
  const pin = m.manifest.pack_version;
  m.pin = pin;
  if (!pin) { m.state = 'PIN_MISSING'; return m; }
  if (isSelf) {
    // The pack against itself: pin must equal VERSION at the same ref.
    if (packVersion && pin !== packVersion) { m.state = 'SELF_PIN_MISMATCH'; m.detail = `manifest ${pin} vs VERSION ${packVersion}`; return m; }
  } else if (!packTags.has(`v${pin}`)) {
    m.state = 'PIN_UNRESOLVED'; m.detail = `no tag v${pin} in the pack — the pin identifies nothing (issue #17's failure mode)`; return m;
  }
  const missing = requiredRendered(entry).filter((p) => !m.tree.has(p));
  if (missing.length && !isSelf) { m.state = 'RENDER_INCOMPLETE'; m.detail = `missing ${missing.join(', ')} at ${m.ref}`; return m; }
  if (m.fetched_days === null) { m.state = 'NEVER_FETCHED'; return m; }
  if (m.fetched_days > maxFetchAgeDays) { m.state = 'FETCH_STALE'; m.detail = `remote-tracking refs are ${m.fetched_days}d old (> ${maxFetchAgeDays}); measurement is of a stale branch of record — run with --fetch`; return m; }
  if (!isSelf && packVersion && semverLt(pin, packVersion)) notes.push(`behind v${packVersion}`);
  m.state = 'ADOPTED';
  if (notes.length) m.detail = notes.join('; ');
  return m;
}

// installed_in must be BACKED at the measured ref: capability enabled in that subscriber's
// manifest AND every provides[] path present. A manifest boolean alone is a declaration —
// the same declared≠actual class this whole gate exists to remove.
const UNREACHABLE = new Set(['NO_DIR', 'NO_REMOTE', 'WRONG_REMOTE', 'NO_REMOTE_REF', 'API_UNREACHABLE']);
function checkInstalledIn(measurements) {
  const byId = Object.fromEntries(measurements.map((m) => [m.id, m]));
  const bad = [], unverifiable = new Set();
  for (const cap of registry.capabilities || []) {
    for (const id of cap.installed_in || []) {
      const m = byId[id];
      // A claim about a subscriber this host cannot reach is UNVERIFIABLE HERE, not false.
      // Reporting it as red every week on the host without the checkout is how a reader
      // learns to skip the whole block; it is listed once, and it does not fail the run.
      if (!m || UNREACHABLE.has(m.state)) { unverifiable.add(`${id} (${m ? m.state : 'unmeasured'})`); continue; }
      if (m.state !== 'ADOPTED' && m.state !== 'RENDER_INCOMPLETE') { bad.push(`${cap.id}.installed_in names ${id}, whose state is ${m.state}`); continue; }
      const caps = m.manifest && m.manifest.capabilities || {};
      const on = Array.isArray(caps) ? caps.includes(cap.id) : caps[cap.id] === true;
      if (!on) { bad.push(`${cap.id}.installed_in names ${id}, but it is not enabled in ${id}'s manifest at ${m.ref}`); continue; }
      const missing = (cap.provides || []).filter((p) => !(m.tree.has(p) || m.tree.has(`.claude/${p}`)));
      if (missing.length) bad.push(`${cap.id}.installed_in names ${id}, but ${missing.join(', ')} absent at ${m.ref}`);
    }
  }
  return { bad, unverifiable: [...unverifiable] };
}

const active = roster.subscribers.filter((s) => !s.retired);
const retired = roster.subscribers.filter((s) => s.retired);
const measurements = [];
for (const s of active) {
  let m = measureLocal(s);
  if (m.state === 'NO_DIR' && allowNetwork) m = measureRemote(s);
  measurements.push(derive(s, m));
}
const unreachable = measurements.filter((m) => ['NO_DIR', 'NO_REMOTE', 'WRONG_REMOTE', 'NO_REMOTE_REF', 'API_UNREACHABLE'].includes(m.state));
if (unreachable.length === measurements.length) {
  console.log(`check-subscribers: INSTRUMENT MEASURED NOTHING — all ${measurements.length} entries unreachable from checkouts-root ${checkoutsRoot}`);
  for (const m of measurements) console.log(`  C0 ${m.id}: ${m.state} ${m.detail || m.dir || ''}`);
  console.log('  This is exit 2, not 1: a red for everything is a mis-pointed instrument, not a finding. Pass --checkouts-root.');
  process.exit(EXIT_USAGE);
}

const { bad: installedProblems, unverifiable: installedUnverifiable } = checkInstalledIn(measurements);
const red = measurements.filter((m) => m.state !== 'ADOPTED');

if (asJson) {
  console.log(JSON.stringify({ checkouts_root: checkoutsRoot, pack_version: packVersion, measurements: measurements.map(({ tree, manifest, ...rest }) => rest), retired: retired.map((s) => s.id), installed_in_problems: installedProblems, installed_in_unverifiable: installedUnverifiable }, null, 2));
} else {
  console.log(`check-subscribers: ${active.length} active roster entries measured from ${checkoutsRoot} (pack v${packVersion})`);
  for (const s of active) {
    const m = measurements.find((x) => x.id === s.id);
    const parts = [`C0 ${m.id}: ${m.state}`, `role=${s.role}`, `roles=${(Array.isArray(s.roles) && s.roles.length ? s.roles : DEFAULT_ROLES).join('+')}${(s.prompts || 'committed') === 'inherited' ? ' prompts=inherited' : ''}`, `repo=${s.repo}`];
    if (m.ref) parts.push(`ref=${m.ref}@${m.sha}`);
    if (m.pin) parts.push(`pin=${m.pin}`);
    if (m.fetched_days !== undefined && m.fetched_days !== null) parts.push(`fetched=${m.fetched_days}d`);
    if (m.via === 'remote') parts.push('via=remote');
    if (s.tracking_issue) parts.push(`tracker=#${s.tracking_issue}`);
    if (m.detail) parts.push(`— ${m.detail}`);
    console.log('  ' + parts.join(' '));
  }
  for (const s of retired) console.log(`  C0 ${s.id}: RETIRED ${s.retired.at} by ${s.retired.by} — "${s.retired.quote}"`);
  if (installedProblems.length) { console.log('  installed_in claims NOT BACKED at the measured ref:'); for (const p of installedProblems) console.log(`    - ${p}`); }
  if (installedUnverifiable.length) console.log(`  installed_in claims unverifiable from this host (not red; measure with --allow-network): ${installedUnverifiable.join(', ')}`);
  console.log(red.length || installedProblems.length
    ? `check-subscribers: ${red.length} of ${active.length} not ADOPTED${installedProblems.length ? `; ${installedProblems.length} installed_in claim(s) unbacked` : ''} — every one above is a finding, and OWED on a founding entry is the week's headline`
    : `check-subscribers: all ${active.length} ADOPTED`);
}
process.exit(red.length || installedProblems.length ? EXIT_RED : EXIT_OK);
