// harvest.js  —  run with: node harvest.js <grammar.tmLanguage.json> [refTable]
//
// Milestone-4 harvesting: read a TextMate grammar (the *.tmLanguage.json form —
// strict JSON, no deps) and derive a CANDIDATE lexical table for our scanner.
//
// The design doc's caveat is the whole point of this file: TextMate grammars are
// built for *highlighting*, which tolerates being slightly wrong. We use them for
// *structure*, where one bogus delimiter corrupts balance. So the harvester:
//
//   1. Only turns a pattern into a delimiter if its `begin`/`end` reduces to a
//      pure LITERAL (after unescaping). Anything with real regex machinery
//      (char classes, alternation, quantifiers, lookarounds, \s, \n) is rejected
//      with a reason — recorded, not silently dropped.
//   2. Only trusts the canonical structural scopes (`comment.line`,
//      `comment.block`, `string.quoted.double`, `string.quoted.single`).
//      Highlighting-only scopes (`.include`, `.lt-gt`, `.other`, `.unquoted`,
//      `.documentation`, `.banner`, `.preprocessor`, `.interpolated`) are
//      rejected — especially the dangerous `<…>` include scope, which would make
//      every `<`/`>` a string delimiter.
//
// Output: the candidate table, plus accepted/rejected logs, plus (optionally) a
// diff against a hand-written reference table to validate the harvester itself.

import { readFileSync } from 'fs';
import { JS_TABLE, C_TABLE, PYTHON_TABLE } from './lexical-scanner.js';

const REF = { js: JS_TABLE, c: C_TABLE, py: PYTHON_TABLE };

// Canonical structural scopes we trust as real delimiters.
const SCOPE = {
  lineComment:  /^comment\.line\b/,
  blockComment: /^comment\.block\b/,
  stringDouble: /^string\.quoted\.double\b/,
  stringSingle: /^string\.quoted\.single\b/,
};
// Highlighting-only sub-scopes that must NOT become structural delimiters.
const REJECT = /\.(include|lt-gt|other|unquoted|documentation|banner|preprocessor|interpolated|raw)\b/;

// Reduce a TextMate begin/end regex to a pure literal, or return null.
// Accepts literal chars + escaped metacharacters; rejects anything with real
// regex semantics. Transparently unwraps capturing / non-capturing groups that
// wrap the entire expression.
function toLiteral(re) {
  if (re == null) return null;
  let s = re.trim();

  // peel a single group that wraps the whole thing: (\/\*) or (?:…)
  for (;;) {
    const m = s.match(/^\((\?:)?(.*)\)$/s);
    if (!m) break;
    // only peel if the parens are balanced across the whole inner span
    let depth = 0, ok = true;
    for (let i = 0; i < m[2].length; i++) {
      const c = m[2][i];
      if (c === '\\') { i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) { ok = false; break; } depth--; }
    }
    if (!ok || depth !== 0) break;
    s = m[2];
  }

  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) return null;
      // an escaped metachar / slash / backslash denotes that literal char
      if ('/*+?.()[]{}|^$'.includes(n) || n === '\\') { out += n; i++; continue; }
      return null;   // \s \n \w \b … — not a literal
    }
    if ('[](){}?*+|^$.'.includes(c)) return null;   // bare regex metachar
    out += c;
  }
  return out.length ? out : null;
}

// Split a regex alternation at top level (respecting groups/escapes/classes).
function splitAlt(re) {
  if (re == null) return [];
  const parts = [];
  let depth = 0, inClass = false, cur = '';
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === '\\') { cur += c + (re[i + 1] ?? ''); i++; continue; }
    if (inClass) { cur += c; if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; cur += c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function collectScoped(grammar) {
  const out = [];
  const seen = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      const name = node.name || node.contentName;
      if (name && /^(comment|string)\b/.test(name) && (node.begin || node.match)) {
        const key = name + '|' + (node.begin || node.match) + '|' + (node.end || '');
        if (!seen.has(key)) { seen.add(key); out.push({ name, begin: node.begin, end: node.end, match: node.match }); }
      }
      for (const k of Object.keys(node)) walk(node[k]);
    }
  })(grammar);
  return out;
}

function harvest(grammar) {
  const scoped = collectScoped(grammar);
  const accepted = [];
  const rejected = [];
  const lineComments = new Set();
  const blockComments = [];
  const strings = [];
  const blockSeen = new Set();
  const strSeen = new Set();

  for (const p of scoped) {
    let category = null;
    for (const [cat, rx] of Object.entries(SCOPE)) if (rx.test(p.name)) { category = cat; break; }

    if (!category) { rejected.push({ ...p, reason: 'non-structural scope (highlighting only)' }); continue; }
    if (REJECT.test(p.name)) {
      const lit = toLiteral(p.begin);
      rejected.push({ ...p, reason: `highlighting sub-scope ${lit ? `(would inject literal '${lit}' — dangerous)` : '(rejected)'}` });
      continue;
    }

    if (category === 'lineComment') {
      const open = toLiteral(p.begin || p.match);
      if (!open) { rejected.push({ ...p, reason: 'line-comment begin not a literal' }); continue; }
      if (!lineComments.has(open)) { lineComments.add(open); accepted.push({ name: p.name, kind: 'lineComment', open }); }
    } else if (category === 'blockComment') {
      const open = toLiteral(p.begin);
      const close = toLiteral(p.end);
      if (!open || !close) { rejected.push({ ...p, reason: 'block-comment begin/end not literal' }); continue; }
      const k = open + close;
      if (!blockSeen.has(k)) { blockSeen.add(k); blockComments.push({ open, close }); accepted.push({ name: p.name, kind: 'blockComment', open, close }); }
    } else {
      // string.quoted.double / single
      const open = toLiteral(p.begin);
      if (!open) { rejected.push({ ...p, reason: 'string begin not a literal' }); continue; }
      const alts = splitAlt(p.end);
      const literalEnds = alts.map(toLiteral).filter(Boolean);
      const newlineBound = alts.some((a) => /\\n/.test(a));
      const close = literalEnds[0] || open;
      const multiline = !newlineBound;
      if (!strSeen.has(open)) {
        strSeen.add(open);
        strings.push({ open, close, escape: '\\', multiline });
        accepted.push({ name: p.name, kind: 'string', open, close, multiline, newlineBound });
      }
    }
  }

  const table = {
    mode: 'brackets',
    lineComments: [...lineComments],
    blockComments,
    strings,
  };
  return { table, accepted, rejected };
}

// Compare two tables for the fields that matter to structure.
function diffTables(harvested, ref) {
  const norm = (t) => ({
    lineComments: [...(t.lineComments || [])].sort(),
    blockComments: (t.blockComments || []).map((b) => `${b.open}…${b.close}`).sort(),
    strings: (t.strings || []).map((s) => `${s.open}…${s.close}${s.multiline ? ' (ml)' : ''}`).sort(),
  });
  const a = norm(harvested), b = norm(ref);
  const lines = [];
  for (const key of ['lineComments', 'blockComments', 'strings']) {
    const onlyH = a[key].filter((x) => !b[key].includes(x));
    const onlyR = b[key].filter((x) => !a[key].includes(x));
    if (onlyH.length || onlyR.length) {
      lines.push(`  ${key}:`);
      for (const x of onlyH) lines.push(`     + harvested only: ${x}`);
      for (const x of onlyR) lines.push(`     - reference only: ${x}`);
    } else {
      lines.push(`  ${key}: ✓ match`);
    }
  }
  return lines.join('\n');
}

function main() {
  const [path, refKey] = process.argv.slice(2);
  if (!path) { console.error('usage: node harvest.js <grammar.tmLanguage.json> [js|c|py]'); process.exit(2); }

  const grammar = JSON.parse(readFileSync(path, 'utf8'));
  const { table, accepted, rejected } = harvest(grammar);

  console.log('── harvested candidate table ────────────────────────────────');
  console.log(JSON.stringify(table, null, 2));

  console.log('\n── accepted delimiters ──────────────────────────────────────');
  for (const a of accepted) console.log(`  ✓ ${a.kind.padEnd(12)} ${JSON.stringify(a).replace(/[{}"]/g, '')}`);

  console.log('\n── rejected patterns (highlighting noise, recorded) ─────────');
  for (const r of rejected) {
    const probe = r.begin ?? r.match;
    console.log(`  ✗ ${r.name}\n        begin/match: ${JSON.stringify(probe)}  end: ${JSON.stringify(r.end)}\n        reason: ${r.reason}`);
  }

  if (refKey && REF[refKey]) {
    console.log(`\n── diff vs hand-written ${refKey.toUpperCase()}_TABLE (harvester self-check) ──`);
    console.log(diffTables(table, REF[refKey]));
  }
}

main();
