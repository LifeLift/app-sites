#!/usr/bin/env node
/**
 * check-html.js — strict-ish well-formedness check for this repo's hand-written HTML.
 *
 * WHY. This is a static site with no build step and no test suite, so "the page is fine" has
 * no runnable meaning unless something reads the file and can say no. This is that something.
 * It is `commands.syntax` in agent-loop.manifest.json and the html category of
 * precommit.config.json — declared only because it runs and can fail.
 *
 * WHAT IT CHECKS (each one is a real defect for a public policy page):
 *   - tags balance and nest (stack-based; every non-void element must be explicitly closed —
 *     stricter than browsers, on purpose: an unclosed <p> is legal HTML and still a smell)
 *   - attribute values are properly quoted; no stray `<` inside text
 *   - <!DOCTYPE html>, <html lang="…">, <head><meta charset>, <meta name="viewport">, <title>
 *   - exactly one <h1>
 *   - every <img> has alt; every <a> has a non-empty href
 *   - no duplicate id attributes
 *   - self-contained: no <script src>, <link href>, <img src>, or <iframe src> that points
 *     off-site (http(s):// or //). Same-site relative paths only. Inline <script> is also
 *     rejected — the site ships no JS.
 *
 * USAGE
 *   node scripts/check-html.js <file.html> [more.html …]     check named files
 *   node scripts/check-html.js --all                          every git-tracked *.html
 *   node scripts/check-html.js --self-test                    prove it passes good HTML and
 *                                                             FAILS bad HTML (fail-closed proof;
 *                                                             this is the manifest probe)
 *
 * Non-.html arguments are reported as skipped and do not fail the run (verify-affordances
 * probes {file} commands with a .js canary). Exit 0 clean, 1 findings, 2 usage error.
 * No dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);

function checkHtml(src, name) {
  const errs = [];
  const err = (pos, msg) => errs.push(`${name}:${lineOf(src, pos)}: ${msg}`);
  const stack = [];
  const ids = new Map();
  let i = 0;
  let sawDoctype = false, sawHtmlLang = false, sawCharset = false, sawViewport = false, titleCount = 0, h1Count = 0;

  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (/[<]/.test(src.slice(i))) err(i, 'stray "<" in text');
      break;
    }
    // text between i and lt: nothing to check except a stray '>' is fine in HTML
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) { err(i, 'unterminated comment'); break; }
      i = end + 3; continue;
    }
    if (/^<!doctype\s+html\s*>/i.test(src.slice(i, i + 40))) {
      if (stack.length || sawDoctype) err(i, 'doctype must be first and only');
      sawDoctype = true;
      i = src.indexOf('>', i) + 1; continue;
    }
    if (src[i + 1] === '!' || src[i + 1] === '?') { err(i, `unsupported declaration ${src.slice(i, i + 12)}…`); i = src.indexOf('>', i) + 1 || n; continue; }
    if (src[i + 1] === '/') {
      const m = /^<\/([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(src.slice(i));
      if (!m) { err(i, `malformed end tag near ${JSON.stringify(src.slice(i, i + 20))}`); i += 2; continue; }
      const tag = m[1].toLowerCase();
      if (VOID.has(tag)) err(i, `</${tag}> — void element must not be closed`);
      else if (!stack.length) err(i, `</${tag}> with nothing open`);
      else if (stack[stack.length - 1].tag !== tag) {
        const open = stack[stack.length - 1];
        err(i, `</${tag}> but <${open.tag}> (line ${lineOf(src, open.pos)}) is still open`);
        // resync: pop through to the matching tag if present, else ignore
        const idx = stack.map((s) => s.tag).lastIndexOf(tag);
        if (idx !== -1) stack.length = idx;
      } else stack.pop();
      i += m[0].length; continue;
    }
    // start tag
    const tm = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(i));
    if (!tm) { err(i, `stray "<" near ${JSON.stringify(src.slice(i, i + 20))}`); i += 1; continue; }
    const tag = tm[1].toLowerCase();
    let j = i + tm[0].length;
    const attrs = {};
    let selfClose = false;
    let ok = true;
    for (;;) {
      const ws = /^\s*/.exec(src.slice(j))[0].length; j += ws;
      if (j >= n) { err(i, `unterminated <${tag}>`); ok = false; break; }
      if (src[j] === '>') { j++; break; }
      if (src.startsWith('/>', j)) { selfClose = true; j += 2; break; }
      const am = /^([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(src.slice(j));
      if (!am) { err(j, `malformed attribute in <${tag}> near ${JSON.stringify(src.slice(j, j + 20))}`); ok = false; break; }
      const aname = am[1].toLowerCase();
      if (am[0].includes('=') && am[2] === undefined && am[3] === undefined && am[4] === undefined) {
        err(j, `attribute ${aname} in <${tag}> has "=" but no value`); ok = false; break;
      }
      const val = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : '';
      if (am[4] !== undefined) err(j, `attribute ${aname}="${val}" in <${tag}> must be quoted`);
      if (aname in attrs) err(j, `duplicate attribute ${aname} in <${tag}>`);
      attrs[aname] = val;
      j += am[0].length;
    }
    if (!ok) { i = j; continue; }
    if (selfClose && !VOID.has(tag)) err(i, `<${tag}/> — self-closing syntax on a non-void element`);

    // semantic checks
    if (tag === 'html') { if (!attrs.lang) err(i, '<html> lacks lang'); else sawHtmlLang = true; }
    if (tag === 'meta' && 'charset' in attrs) sawCharset = true;
    if (tag === 'meta' && (attrs.name || '').toLowerCase() === 'viewport') sawViewport = true;
    if (tag === 'title') titleCount++;
    if (tag === 'h1') h1Count++;
    if (tag === 'img' && !('alt' in attrs)) err(i, '<img> lacks alt');
    if (tag === 'a' && !attrs.href) err(i, '<a> lacks a non-empty href');
    if (tag === 'script') err(i, '<script> — this site ships no JavaScript');
    for (const k of ['src', 'href']) {
      if (k in attrs && ['script', 'link', 'img', 'iframe', 'source', 'video', 'audio'].includes(tag) && /^(https?:)?\/\//i.test(attrs[k])) {
        err(i, `<${tag} ${k}="${attrs[k]}"> — external asset; the site must be self-contained`);
      }
    }
    if (attrs.id !== undefined) {
      if (!attrs.id) err(i, `<${tag}> has an empty id`);
      else if (ids.has(attrs.id)) err(i, `duplicate id "${attrs.id}" (first at line ${ids.get(attrs.id)})`);
      else ids.set(attrs.id, lineOf(src, i));
    }

    if (!VOID.has(tag) && !selfClose) {
      if (RAW_TEXT.has(tag)) {
        const close = src.toLowerCase().indexOf(`</${tag}`, j);
        if (close === -1) { err(i, `unterminated <${tag}>`); i = n; continue; }
        const gt = src.indexOf('>', close);
        i = gt === -1 ? n : gt + 1;
        continue;
      }
      stack.push({ tag, pos: i });
    }
    i = j;
  }
  for (const s of stack) err(s.pos, `<${s.tag}> never closed`);
  if (!sawDoctype) err(0, 'missing <!DOCTYPE html>');
  if (!sawHtmlLang) err(0, 'missing <html lang="…">');
  if (!sawCharset) err(0, 'missing <meta charset>');
  if (!sawViewport) err(0, 'missing <meta name="viewport">');
  if (titleCount !== 1) err(0, `expected exactly one <title>, found ${titleCount}`);
  if (h1Count !== 1) err(0, `expected exactly one <h1>, found ${h1Count}`);
  return errs;
}

function lineOf(src, pos) { let l = 1; for (let k = 0; k < pos && k < src.length; k++) if (src.charCodeAt(k) === 10) l++; return l; }

const GOOD = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title><link rel="stylesheet" href="/assets/site.css"></head>
<body><h1 id="top">Hi</h1><p>text &amp; more <a href="/x/">link</a></p><img src="/a.png" alt=""><br><ul><li>one</li></ul><!-- c --></body></html>
`;
const BAD = [
  ['unclosed p', GOOD.replace('<p>text', '<div>text')],
  ['missing alt', GOOD.replace(' alt=""', '')],
  ['external script', GOOD.replace('</body>', '<script src="https://cdn.example/x.js"></script></body>')],
  ['two h1', GOOD.replace('</body>', '<h1>again</h1></body>')],
  ['no doctype', GOOD.replace('<!DOCTYPE html>\n', '')],
  ['unquoted attr', GOOD.replace('href="/x/"', 'href=/x/')],
  ['dup id', GOOD.replace('<p>', '<p id="top">')],
  ['empty href', GOOD.replace('href="/x/"', 'href=""')],
  ['unterminated tag', GOOD.replace('<br>', '<br')],
  ['inline script', GOOD.replace('</body>', '<script>1</script></body>')],
];

function selfTest() {
  let fails = 0;
  const g = checkHtml(GOOD, 'good');
  if (g.length) { console.log('self-test FAIL: good sample reported errors:\n  ' + g.join('\n  ')); fails++; }
  else console.log('self-test ok: good sample passes');
  for (const [label, src] of BAD) {
    const e = checkHtml(src, label);
    if (!e.length) { console.log(`self-test FAIL: bad sample "${label}" was NOT caught`); fails++; }
    else console.log(`self-test ok: "${label}" caught (${e[0]})`);
  }
  console.log(fails ? `self-test: ${fails} failure(s) — checker does not fail closed` : 'self-test: checker fails closed');
  return fails ? 1 : 0;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('usage: node scripts/check-html.js <file.html…> | --all | --self-test'); return 2; }
  if (args.includes('--self-test')) return selfTest();
  let files = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--all')) {
    const out = execFileSync('git', ['ls-files', '-z', '--', '*.html', '**/*.html'], { encoding: 'utf8' });
    files = out.split('\0').filter(Boolean);
  }
  let findings = 0, checked = 0;
  for (const f of files) {
    if (path.extname(f).toLowerCase() !== '.html') { console.log(`skip ${f} (not .html)`); continue; }
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (e) { console.log(`FAIL ${f}: unreadable (${e.code || e.message})`); findings++; continue; }
    const errs = checkHtml(src, f);
    checked++;
    if (errs.length) { findings += errs.length; console.log(`FAIL ${f}\n  ${errs.join('\n  ')}`); }
    else console.log(`ok   ${f}`);
  }
  console.log(`check-html: files=${checked} findings=${findings}`);
  return findings ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { checkHtml };
