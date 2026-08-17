#!/usr/bin/env node
/**
 * Do the citations in this text actually say what the text claims they say?
 *
 * Origin: issue #6, design question 4. The proposal there is cheap, narrow, frequent
 * checkpoint questions, and the issue names the failure mode of the mechanism itself: "a
 * cheap model answering 'yes, I validated it' without checking is worse than no gate, because
 * it manufactures false assurance." Its own conclusion is that a checkpoint must demand
 * EVIDENCE, not assent.
 *
 * THE INCIDENT. An agent describing a feature to the human owner asserted a premise about
 * user-authored text that the two actual call sites refute. It was describing the issue text,
 * not the code — and a decision, a ruling, and then a reversal were spent on that premise.
 * The checkpoint question issue #6 proposes for that moment is "have you read the call sites,
 * or are you describing the issue text?" Asked that way it invites a free "yes", and a free
 * "yes" is exactly the false assurance the issue warns about.
 *
 * This gate is the deterministic half of the answer. It cannot make an agent read anything.
 * What it can do is make the CLAIM of having read something falsifiable: require the answer
 * in the form `path:line` plus a quoted excerpt, then check the excerpt against the real
 * bytes on that real line. An agent that fabricates `src/foo.js:NN "..."` produces a citation
 * that fails; an agent that actually read the line produces one that passes without effort.
 * That asymmetry is the entire mechanism, so the quote comparison is deliberately strict —
 * see WHITESPACE below. Matching loosely would hand the fabricator a pass and cost the gate
 * the only thing it has.
 *
 * Every example path in this header is written with a placeholder line number (`:NN`) so that
 * it is not itself a citation. Same move as check-capability-markers.js exempting the literal
 * `[CAPABILITY: id]` placeholder: a checker that reports its own documentation as a defect
 * teaches people to ignore it. Prose files can use a fenced block instead — those are skipped.
 *
 * WHAT COUNTS AS A CITATION. `path/to/file.ext:NN`, optionally a range `:NN-MM`, optionally a
 * trailing grep-style column that is ignored. To be recognised the path must either contain a
 * directory separator or have an extension of two or more characters — `Section 3.a:12` and
 * `ratio 1.2:1` are prose, not citations, and a gate that reported them would be dismissed on
 * sight. Consequences of that bar, accepted knowingly: a bare single-letter extension with no
 * directory (`foo.c:NN`) is not recognised; write `src/foo.c:NN`. GitHub anchors (`#L42`) are
 * not recognised either. Fenced code blocks are skipped whole, because a document SHOWING the
 * citation format in an example is not making a citation — the same reason
 * check-claims-vs-diff.js strips fences before matching claims.
 *
 * HOW A QUOTE IS ASSOCIATED WITH A CITATION — an explicit format, not proximity. The quote
 * must be ADJACENT to the citation, separated by nothing but whitespace, the citation's own
 * backticks, or one of `— – - : , ( →`. Immediately-after wins; immediately-before is
 * accepted as the second form because `"text" (gates/x.js:NN)` is how people actually write.
 * Proximity heuristics were rejected: a paragraph mentioning two files and three quotes has
 * no honest answer to "which quote belongs to which citation", and guessing there produces
 * findings whose first reader correctly concludes the gate is wrong. The house principle from
 * check-claims-vs-diff.js applies unchanged — a gate that matches ambiguous prose is worse
 * than one that matches nothing. An unassociated quote is simply prose.
 *
 * Adjacency survives a line break, because markdown wraps and the first draft of this gate
 * paid for pretending otherwise: two fabricated quotes in the known-positive fixture escaped
 * purely by sitting one line below their citation, which is a formatting accident, not
 * evidence. So the window extends up to 2 following lines — but stops dead at a blank line or
 * a fence, since a paragraph break is a change of subject. The residual cost is stated plainly:
 * `Files: a.js:NN, b.js:MM` followed by a line that STARTS with a quote will attribute that
 * quote to `b.js:MM`. Rare, and it still only ever asks "is this text on that line".
 *
 * A CITATION WITH NO QUOTE IS NOT A FINDING (by default). Its path and line are still
 * verified, because those are claims the citation itself makes. But the absence of a quote is
 * the absence of a claim about content, and absence of a claim is never a finding here — same
 * rule as check-claims-vs-diff.js, which says nothing about a body that says nothing about
 * schemas. An author who did not use the format is silent, not wrong. Where a checkpoint
 * PROMPT explicitly demanded quoted evidence, silence is a failure to answer, and only then
 * is `--require-quote` correct. Do not turn it on by default; it converts every ordinary
 * cross-reference into an accusation.
 *
 * FILES THIS REPO DOES NOT TRACK. Skipped silently, never a finding: absolute paths and
 * `~`-paths (never recognised — outside the repo, unverifiable), URLs (blanked before
 * scanning), and paths that exist on disk but are untracked (`node_modules/`, build output).
 * A cited path that is not tracked verbatim is matched by unique path SUFFIX, so a report
 * writing `gates/check-citations.js:1` from a subdirectory still resolves; if two or more
 * tracked files match the suffix the citation is ambiguous and is skipped rather than guessed.
 * A path that resolves to NOTHING is a finding only if it contains a directory separator: a
 * sweep of this repo's own 57 tracked files found one bare-filename reference to a file in a
 * DIFFERENT repository, and calling that fabrication is a finding its reader is right to
 * dismiss. The cost is stated in WHAT THIS CANNOT DO.
 *
 * WHITESPACE AND WHAT ELSE IS FORGIVEN. Both sides are normalised by collapsing runs of
 * whitespace to a single space and trimming — indentation and wrapping are not content, and
 * requiring them would fail honest quotes constantly. Curly quotes and apostrophes are folded
 * to straight ones, because editors and models perform that substitution unasked. Nothing
 * else is forgiven: comparison is case-SENSITIVE and substring-exact, and dashes are left
 * alone (an en dash is not a hyphen, and code cares). An elision (`...` or `…`) splits the
 * quote into fragments that must appear on the line in order, which supports abridged quotes
 * without allowing reordering. A quote with fewer than 4 non-space characters of actual
 * content carries no evidence either way and is counted as unverified rather than passed.
 *
 * WHAT THIS CANNOT DO — the gate raises the cost of fabrication, it does not make fabrication
 * impossible, and these holes are known rather than discovered later:
 *   - it cannot tell whether the quoted line SUPPORTS the argument the text makes about it,
 *     only that the text really is on that line;
 *   - an author who omits quotes is not caught at all (that is what --require-quote is for,
 *     and only where the prompt demanded evidence);
 *   - a fabricated citation to a bare filename with no directory (`invented.js:NN "..."`) is
 *     skipped, per FILES THIS REPO DOES NOT TRACK — write paths and this hole closes;
 *   - a quote of four characters or fewer, or one made only of elisions, verifies nothing.
 * None of these produce a FALSE CLEAN on a checked citation: every hole is a citation the gate
 * declines to check and reports as unverifiable, never one it passes.
 *
 * Usage:
 *   node gates/check-citations.js report.md [--repo .]
 *   node gates/check-citations.js --body-file body.md --require-quote
 *   node gates/check-citations.js                     # text from GITHUB_EVENT_PATH (PR body)
 *
 * Exit 0 = every recognised citation checks out (including "no citations found").
 * Exit 1 = a citation names a file that is not there, a line that is not there, or a quote
 *          that is not on the line it is attributed to.
 * Exit 2 = could not run. Never report that as clean.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function die(msg) {
  console.error(`check-citations: ${msg}`);
  process.exit(2);
}

function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
}

// ── Recognising a citation ─────────────────────────────────────────────────────────────
// Relative paths only: a leading `/` or `~` cannot match, since the lookbehind rejects those
// characters before the path and the pattern itself never begins with one. That is the whole
// treatment of "external file" — unverifiable, so never claimed to be checked.
const CITATION = new RegExp(
  '(?<![\\w./~-])'                                  // not mid-path, mid-word or mid-URL
  + '((?:[A-Za-z0-9_.-]+/)*'                        // optional directories
  + '\\.?[A-Za-z0-9_-][A-Za-z0-9_.-]*'              // filename stem (may be a dotfile)
  + '\\.([A-Za-z][A-Za-z0-9]{0,9}))'                // extension, must start with a letter
  + ':(\\d+)(?:-(\\d+))?'                           // line, or line range
  + '(?::\\d+)?'                                    // grep-style column, ignored
  + '(?![\\w.-])',
  'g'
);

// Separators allowed between a citation and the quote attributed to it. Punctuation only —
// never words, so `see gates/x.js:NN where it says "foo"` does NOT associate, on purpose.
const SEP_AFTER = /[\s—–:,\-(→=]/;
const SEP_BEFORE = /[\s—–:,\-(\[→=]/;
const OPENERS = { '"': '"', '“': '”', '`': '`' };
const CLOSERS = { '"': '"', '”': '“', '`': '`' };
const MAX_QUOTE = 400;

/** The delimited string starting at `i`, or null if `i` is not an opening delimiter. */
function delimited(s, i) {
  const open = s[i];
  if (!(open in OPENERS)) return null;
  const end = s.indexOf(OPENERS[open], i + 1);
  if (end === -1 || end - i - 1 > MAX_QUOTE) return null;
  return s.slice(i + 1, end) || null;
}

/**
 * The quote attributed to a citation by what FOLLOWS it. `window` is the rest of the citation's
 * line, plus the wrapped continuation (see scan). A backtick in position 0 is the citation's
 * own closing wrapper and is skipped; a backtick anywhere after a separator is a delimiter.
 * Adjacency is decided by delimiter position alone, never by alternation order — an earlier
 * version used one regex with `"…"` before `` `…` `` and truncated `` `"name": "x"` `` to
 * `name`, quietly weakening the very comparison this gate exists to make.
 */
function quoteAfter(window) {
  let i = window[0] === '`' ? 1 : 0;
  while (i < window.length && SEP_AFTER.test(window[i])) i++;
  return delimited(window, i);
}

/** The quote attributed to a citation by what PRECEDES it on the same line: `"text" (path:42)`. */
function quoteBefore(before) {
  let i = before.length - 1;
  if (before[i] === '`') i--;                       // the citation's own opening wrapper
  while (i >= 0 && SEP_BEFORE.test(before[i])) i--;
  if (i < 0 || !(before[i] in CLOSERS)) return null;
  const start = before.lastIndexOf(CLOSERS[before[i]], i - 1);
  if (start === -1 || i - start - 1 > MAX_QUOTE) return null;
  return before.slice(start + 1, i) || null;
}

const ELISION = /\s*(?:\.\.\.|…)\s*/;
const MIN_QUOTE_CHARS = 4;
const CONTINUATION = 2;

/**
 * Is this candidate quote just another reference? `loop-monitor.md:85`, `land-pr:68`,
 * `merge-train:44` is a LIST, and reading each item as the previous item's quoted excerpt is
 * nonsense — but it is exactly what adjacency alone concludes, and it is what this gate did to
 * a real record in this repo on its first full sweep. Looser than CITATION on purpose: this
 * test only ever DROPS an association, so over-matching costs a check nobody could have
 * learned anything from (a "quote" of the form `foo:12` carries no evidence either way).
 */
const REFERENCE_SHAPED = /^[A-Za-z0-9_./-]+:\d+(?:-\d+)?$/;

/** Collapse whitespace, fold curly quotes. Case and every other character are preserved —
 *  loosening past this is how a fabricated quote starts passing. */
function normalize(s) {
  return String(s)
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Fragments of a quote, split on elisions. Empty => nothing verifiable was quoted. */
function quoteFragments(quote) {
  return normalize(quote).split(ELISION).map((p) => p.trim()).filter(Boolean);
}

/** true = every fragment appears, in order, in `haystack`. false = it does not. */
function quoteMatches(quote, haystack) {
  const h = normalize(haystack);
  let idx = 0;
  for (const frag of quoteFragments(quote)) {
    const at = h.indexOf(frag, idx);
    if (at === -1) return false;
    idx = at + frag.length;
  }
  return true;
}

/**
 * Every citation in `text`, with the quote attributed to it if the explicit format was used.
 * Lines inside fenced code blocks are skipped whole; URLs are blanked in place (keeping
 * length, so the adjacency lookups either side of a citation stay honest).
 */
function scan(text) {
  const found = [];
  // Blank HTML comments in place (keeping line structure) for the same reason fenced blocks
  // are skipped: a commented-out citation is not shown to any reader, so it asserts nothing,
  // and "why is it complaining about the part I commented out" is how a gate loses its
  // audience.
  const lines = String(text).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(?:```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const line = raw.replace(/\bhttps?:\/\/\S+/g, (m) => ' '.repeat(m.length));
    CITATION.lastIndex = 0;
    let m;
    while ((m = CITATION.exec(line)) !== null) {
      const [whole, filePath, ext, start, end] = m;
      // The false-positive bar: a directory separator, or a real-looking extension.
      if (!filePath.includes('/') && ext.length < 2) continue;

      // Markdown wraps. A quote that opens after the citation and closes on the next line, or
      // that begins on the next line entirely, is still an explicit attribution — so the
      // lookahead window is the rest of this line plus up to CONTINUATION following lines,
      // joined by a space (which is what normalise() would do to a wrap anyway). A blank line
      // or a fence marker ends the window: a paragraph break is a change of subject, and
      // reaching across one would be the proximity guessing this gate refuses to do.
      const window = [line.slice(m.index + whole.length)];
      for (let j = i + 1; j <= i + CONTINUATION && j < lines.length; j++) {
        if (!lines[j].trim() || /^\s*(?:```|~~~)/.test(lines[j])) break;
        window.push(lines[j].replace(/^\s*>\s?/, ''));
      }
      let a = quoteAfter(window.join(' '));
      if (a !== null && REFERENCE_SHAPED.test(a.trim())) a = null;
      let b = a === null ? quoteBefore(line.slice(0, m.index)) : null;
      if (b !== null && REFERENCE_SHAPED.test(b.trim())) b = null;

      found.push({
        path: filePath,
        start: parseInt(start, 10),
        end: end ? parseInt(end, 10) : parseInt(start, 10),
        ranged: Boolean(end),
        quote: a !== null ? a : b,
        where: a !== null ? 'after' : b !== null ? 'before' : null,
        textLine: i + 1,
        raw: whole,
      });
    }
  }
  return found;
}

function main() {
  const args = process.argv.slice(2);
  const get = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
  const flag = (f) => args.includes(f);
  const cwd = path.resolve(get('--repo', process.cwd()));
  const requireQuote = flag('--require-quote');

  // ── Resolve the text to check ────────────────────────────────────────────────────────
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--repo', '--body-file'].includes(args[i - 1])));
  const file = get('--body-file', positional[0] || null);
  let text = null;
  let source = file;

  if (file) {
    if (!fs.existsSync(file)) die(`file not found: ${file}`);
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { die(`could not read ${file}: ${e.message}`); }
  } else if (process.env.GITHUB_EVENT_PATH && fs.existsSync(process.env.GITHUB_EVENT_PATH)) {
    try {
      const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      text = ev.pull_request && ev.pull_request.body;
      source = 'PR body';
    } catch (e) { die(`could not parse GITHUB_EVENT_PATH: ${e.message}`); }
  }

  // No text is not a failure — a push with no PR has no body to check. Say which case it is
  // rather than printing a bare "clean" that reads like a pass.
  if (text === null || text === undefined) {
    console.log('check-citations: no text given and no PR body available — nothing to check');
    return;
  }

  // ── The tracked file set. Untracked-and-absent is the fabrication signature; being unable
  //    to tell tracked from untracked at all is not a clean result, so that fails closed. ──
  let tracked;
  try {
    tracked = git(['ls-files'], cwd).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    die(`could not list tracked files in ${cwd}: ${e.message.split('\n')[0]}`);
  }
  if (!tracked.length) die(`no tracked files in ${cwd} — wrong --repo, not a clean result`);
  const trackedSet = new Set(tracked);

  const citations = scan(text);
  if (!citations.length) {
    console.log(`check-citations: no citations found in ${source} — nothing to verify`);
    return;
  }

  const findings = [];
  const seen = new Set();
  const contents = new Map();
  let verified = 0, quoted = 0, skipped = 0;

  for (const c of citations) {
    const key = `${c.path}:${c.start}-${c.end}:${c.quote || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Resolve the cited path against the tracked set, verbatim or by unique suffix.
    let resolved = trackedSet.has(c.path) ? c.path : null;
    if (!resolved) {
      const suffix = tracked.filter((t) => t.endsWith('/' + c.path));
      if (suffix.length === 1) resolved = suffix[0];
      else if (suffix.length > 1) { skipped++; continue; }   // ambiguous — guessing is worse
    }
    if (!resolved) {
      // Exists but untracked (dependency, generated file): not this gate's business.
      if (fs.existsSync(path.join(cwd, c.path))) { skipped++; continue; }
      // A bare filename with no directory is not a structural claim about THIS repo, and a
      // sweep of this repo's own prose proved it: capabilities.json cites
      // `lifelift-mobile-backend session-start.sh:16`, a real file in another repository.
      // Reporting that as fabrication is a finding whose reader is immediately right to
      // dismiss it. A fabricator citing evidence here writes a path; require one.
      if (!c.path.includes('/')) { skipped++; continue; }
      findings.push({ c, why: 'no tracked file matches that path' });
      continue;
    }

    if (!contents.has(resolved)) {
      try { contents.set(resolved, fs.readFileSync(path.join(cwd, resolved), 'utf8')); }
      catch (_) { contents.set(resolved, null); }
    }
    const content = contents.get(resolved);
    // Tracked but unreadable or binary: cannot verify, so do not claim to have.
    if (content === null || content.includes('\0')) { skipped++; continue; }

    const lines = content.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    if (c.start < 1 || c.end > lines.length || c.end < c.start) {
      findings.push({ c, resolved, why: `${resolved} has ${lines.length} line(s)` });
      continue;
    }
    verified++;

    if (c.quote === null || c.quote === undefined) {
      if (requireQuote) findings.push({ c, resolved, why: 'no quoted excerpt attributed to this citation (--require-quote)' });
      continue;
    }

    const frags = quoteFragments(c.quote);
    const substance = frags.join('').replace(/\s/g, '').length;
    if (!frags.length || substance < MIN_QUOTE_CHARS) { skipped++; continue; }

    const cited = lines.slice(c.start - 1, c.end).join(' ');
    if (quoteMatches(c.quote, cited)) { quoted++; continue; }

    findings.push({
      c,
      resolved,
      why: c.ranged ? 'quoted text does not appear anywhere in that range' : 'quoted text does not appear on that line',
      actual: normalize(cited).slice(0, 160),
    });
  }

  if (!findings.length) {
    console.log(`check-citations: ${verified} citation(s) resolved in ${source}, ${quoted} with a quote `
      + `matched against the cited line(s), ${skipped} unverifiable (untracked, ambiguous or binary)`);
    return;
  }

  console.error('');
  console.error(`check-citations: ${findings.length} unsupported citation(s) in ${source}`);
  for (const f of findings) {
    console.error('');
    console.error(`  cited at : ${source}:${f.c.textLine}`);
    console.error(`  citation : ${f.c.raw}${f.resolved && f.resolved !== f.c.path ? ` (resolved to ${f.resolved})` : ''}`);
    if (f.c.quote) console.error(`  claimed  : "${normalize(f.c.quote).slice(0, 160)}"`);
    if (f.actual !== undefined) console.error(`  actual   : "${f.actual}"`);
    console.error(`  why      : ${f.why}`);
  }
  console.error('');
  console.error('  A citation is a claim to have read something. Fix the citation, or read the');
  console.error('  file and cite what is actually there. A reader who trusts a fabricated');
  console.error('  reference is worse off than one given nothing.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = { scan, normalize, quoteMatches, quoteFragments, quoteAfter, quoteBefore, CITATION };
