#!/usr/bin/env node
/**
 * check-css.js — minimal well-formedness check for this repo's hand-written CSS.
 *
 * Checks: braces balance (with string and comment awareness), no unterminated comment or
 * string, and self-containment — no @import and no url() pointing off-site (http(s):// or
 * //). It is the css category of precommit.config.json. Non-.css arguments are skipped.
 *
 *   node scripts/check-css.js <file.css …> | --self-test
 *
 * Exit 0 clean, 1 findings, 2 usage error. No dependencies.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function checkCss(src, name) {
  const errs = [];
  const line = (pos) => { let l = 1; for (let k = 0; k < pos; k++) if (src.charCodeAt(k) === 10) l++; return l; };
  let depth = 0, i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) { errs.push(`${name}:${line(i)}: unterminated comment`); break; }
      i = end + 2; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') break; j++; }
      if (j >= n || src[j] !== c) { errs.push(`${name}:${line(i)}: unterminated string`); break; }
      i = j + 1; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth < 0) { errs.push(`${name}:${line(i)}: unexpected "}"`); depth = 0; } }
    i++;
  }
  if (depth > 0) errs.push(`${name}: ${depth} unclosed "{"`);
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const imp = /@import\b/.exec(stripped);
  if (imp) errs.push(`${name}:${line(imp.index)}: @import — the site must be self-contained`);
  const re = /url\(\s*['"]?\s*((?:https?:)?\/\/[^)'"\s]*)/gi;
  let m;
  while ((m = re.exec(stripped))) errs.push(`${name}:${line(m.index)}: external url(${m[1]}) — the site must be self-contained`);
  return errs;
}

const GOOD = '/* c */\n:root { --x: 1; }\na::before { content: "}"; }\n@media (max-width: 40em) { .a { color: red; } }\n';
const BAD = [
  ['unclosed brace', GOOD.replace('color: red; }', 'color: red; ')],
  ['stray brace', GOOD + '}\n'],
  ['unterminated comment', GOOD + '/* oops\n.c { color: blue; }\n'],
  ['unterminated string', GOOD.replace('"}"', '"}')],
  ['@import', '@import url(x.css);\n' + GOOD],
  ['external url', GOOD + '.b { background: url(https://x.example/i.png); }\n'],
];

function selfTest() {
  let fails = 0;
  const g = checkCss(GOOD, 'good');
  if (g.length) { console.log('self-test FAIL: good sample reported errors:\n  ' + g.join('\n  ')); fails++; } else console.log('self-test ok: good sample passes');
  for (const [label, src] of BAD) {
    const e = checkCss(src, label);
    if (!e.length) { console.log(`self-test FAIL: bad sample "${label}" was NOT caught`); fails++; } else console.log(`self-test ok: "${label}" caught (${e[0]})`);
  }
  console.log(fails ? `self-test: ${fails} failure(s)` : 'self-test: checker fails closed');
  return fails ? 1 : 0;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('usage: node scripts/check-css.js <file.css…> | --self-test'); return 2; }
  if (args.includes('--self-test')) return selfTest();
  let findings = 0, checked = 0;
  for (const f of args.filter((a) => !a.startsWith('--'))) {
    if (path.extname(f).toLowerCase() !== '.css') { console.log(`skip ${f} (not .css)`); continue; }
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (e) { console.log(`FAIL ${f}: unreadable (${e.code || e.message})`); findings++; continue; }
    const errs = checkCss(src, f);
    checked++;
    if (errs.length) { findings += errs.length; console.log(`FAIL ${f}\n  ${errs.join('\n  ')}`); } else console.log(`ok   ${f}`);
  }
  console.log(`check-css: files=${checked} findings=${findings}`);
  return findings ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { checkCss };
