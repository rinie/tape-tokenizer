// sfdiff.js — subforest diff: compare two versions of a file as a forest of
// whole top-level units, not as line deltas.
//
//   node sfdiff.js [options] <old> <new>
//
// The breadth-first move: a line diff hands you a *delta tree* — changes cut on
// the line grid, half-spans, shrapnel. This tool compares the two versions at
// the OUTLINE level first: segment each file's top level into units (named
// function/class declarations + the loose top-level code), match units by NAME
// across versions, and compare each unit by a content fingerprint. Only a
// *modified* unit is descended into — one step, to its first differing token.
//
// Fingerprints are computed over the value tape's significant tokens —
// whitespace and comments are separate kinds, so they simply don't participate.
// Consequences, all deliberate:
//   * reindenting / reformatting a unit  → UNCHANGED
//   * moving a unit within the file      → MOVED (content identical)
//   * editing a unit                     → MODIFIED, with the first differing
//                                          token pointed at in both versions
// A line diff reports all three as walls of changed lines.
//
// Linter-grade JS segmentation (same honest scope as defuse.js): top-level
// `function NAME` / `class NAME` declarations; everything else at the top level
// is pooled into one '(top-level code)' pseudo-unit.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { UniLexer, KLASS } from './unilexer.js';

import { VERSION } from './version.js';

const HELP = `tape-tokenizer sfdiff — subforest diff (v${VERSION})

USAGE
  node sfdiff.js [options] <old-file> <new-file>

  Compares two versions of a JavaScript file as a forest of whole top-level
  units (function/class declarations + loose top-level code), matched by name.
  Whitespace and comments do not participate in the comparison.

OPTIONS
  -v, --verbose        Also list unchanged units.
  -h, --help           Show this help and exit.
  -V, --version        Print version and exit.

VERDICTS
  =  unchanged   same content (reformatting/reindentation included)
  ^  moved       same content, different position in the file
  ~  modified    content differs — first differing token shown for both sides
  +  added       only in <new-file>
  -  removed     only in <old-file>

EXIT STATUS
  0   structurally identical (only =, possibly after reformatting)
  1   differences found (moved counts as a difference in position, not content)
  2   usage error
`;

function fail(msg) {
  process.stderr.write(`sfdiff: ${msg}\n`);
  process.stderr.write("Try 'node sfdiff.js --help' for usage.\n");
  process.exit(2);
}

const TRIVIA = new Set([KLASS.WS, KLASS.COMMENT]);
const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

// Segment a value tape's top level into units. Named units are `function NAME`
// / `class NAME` declarations (the whole span through the body's closing
// brace); all other top-level tokens pool into one '(top-level code)' unit.
function topLevelUnits(vt) {
  const n = vt.length;
  const named = [];
  const loose = [];
  let t = 0;
  while (t < n) {
    const k = vt.classOf(t);
    const lex = vt.lexemeOf(t);
    // only a declaration AT the top level is a unit — a function nested in
    // loose top-level code (an arrow body, an IIFE) belongs to that code
    if (k === KLASS.KEYWORD && (lex === 'function' || lex === 'class') && vt.depthOf(t) === 0) {
      // find the declared name before the first '(' or '{'
      let name = null;
      for (let u = t + 1; u < n; u++) {
        const ku = vt.classOf(u);
        if (ku === KLASS.IDENT) { name = vt.lexemeOf(u); break; }
        if (ku === KLASS.BRACKET && (vt.lexemeOf(u) === '(' || vt.lexemeOf(u) === '{')) break;
        if (TRIVIA.has(ku) || (ku === KLASS.OP && vt.lexemeOf(u) === '*')) continue;
        break;
      }
      // span to the close of the body: depth returns to 0 after the first '{'
      let d = 0; let sawBrace = false; let end = t;
      for (let v = t; v < n; v++) {
        if (vt.classOf(v) === KLASS.BRACKET) {
          const c = vt.lexemeOf(v);
          if (OPEN.has(c)) { d++; if (c === '{') sawBrace = true; }
          else if (CLOSE.has(c)) { d--; if (d === 0 && sawBrace && c === '}') { end = v; break; } }
        }
        end = v;
      }
      if (name !== null) {
        named.push(makeUnit(vt, name, t, end, named.length));
        t = end + 1;
        continue;
      }
    }
    loose.push(t);
    t++;
  }
  const units = [...named];
  if (loose.some((x) => !TRIVIA.has(vt.classOf(x)))) units.push(makeLooseUnit(vt, loose));
  return units;
}

// Significant-token signature: (class, lexeme) pairs, trivia excluded.
function sigTokens(vt, tokenIdxs) {
  const out = [];
  for (const t of tokenIdxs) {
    const k = vt.classOf(t);
    if (TRIVIA.has(k)) continue;
    out.push({ k, lex: vt.lexemeOf(t), off: vt.offsetOf(t) });
  }
  return out;
}

function makeUnit(vt, name, start, end, order) {
  const idxs = [];
  for (let t = start; t <= end; t++) idxs.push(t);
  const sig = sigTokens(vt, idxs);
  return { name, order, offset: vt.offsetOf(start), sig, fp: sig.map((s) => `${s.k}\u0000${s.lex}`).join('\u0001') };
}

function makeLooseUnit(vt, idxs) {
  const sig = sigTokens(vt, idxs);
  return { name: '(top-level code)', order: 1e9, offset: idxs.length ? vt.offsetOf(idxs[0]) : 0, sig, fp: sig.map((s) => `${s.k}\u0000${s.lex}`).join('\u0001') };
}

// Longest common subsequence of two name arrays → the set of names that kept
// their relative order. Common names NOT in the LCS have moved.
function lcsNames(xs, ys) {
  const m = xs.length; const n = ys.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = xs[i] === ys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keep = new Set();
  let i = 0; let j = 0;
  while (i < m && j < n) {
    if (xs[i] === ys[j]) { keep.add(xs[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return keep;
}

// First differing significant token between two unit signatures.
function firstDiff(a, b) {
  const len = Math.min(a.sig.length, b.sig.length);
  for (let i = 0; i < len; i++) {
    if (a.sig[i].k !== b.sig[i].k || a.sig[i].lex !== b.sig[i].lex) {
      return { tok: i, old: a.sig[i], new: b.sig[i] };
    }
  }
  return { tok: len, old: a.sig[len] || null, new: b.sig[len] || null };   // one side has extra tokens
}

// The subforest diff proper.
function diffForests(oldUnits, newUnits) {
  const A = new Map(oldUnits.map((u) => [u.name, u]));
  const B = new Map(newUnits.map((u) => [u.name, u]));

  const commonOld = oldUnits.filter((u) => B.has(u.name)).map((u) => u.name);
  const commonNew = newUnits.filter((u) => A.has(u.name)).map((u) => u.name);
  const inOrder = lcsNames(commonOld, commonNew);

  const rows = [];
  for (const u of newUnits) {
    const prev = A.get(u.name);
    if (!prev) { rows.push({ verdict: 'added', name: u.name }); continue; }
    const sameContent = prev.fp === u.fp;
    const moved = !inOrder.has(u.name);
    if (sameContent && !moved) rows.push({ verdict: 'unchanged', name: u.name });
    else if (sameContent && moved) rows.push({ verdict: 'moved', name: u.name });
    else rows.push({ verdict: 'modified', name: u.name, diff: firstDiff(prev, u), moved });
  }
  for (const u of oldUnits) {
    if (!B.has(u.name)) rows.push({ verdict: 'removed', name: u.name });
  }
  return rows;
}

function describeTok(s) {
  return s === null ? '(end of unit)' : `'${s.lex}' @${s.off}`;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        verbose: { type: 'boolean', short: 'v' },
        help:    { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (e) { fail(e.message); }
  const { values, positionals } = parsed;
  if (values.help)    { process.stdout.write(HELP); process.exit(0); }
  if (values.version) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
  if (positionals.length !== 2) fail('expected exactly two files: <old> <new>');

  const [oldPath, newPath] = positionals;
  let oldSrc; let newSrc;
  try { oldSrc = readFileSync(oldPath, 'utf8'); } catch { fail(`cannot read '${oldPath}'`); }
  try { newSrc = readFileSync(newPath, 'utf8'); } catch { fail(`cannot read '${newPath}'`); }

  const oldUnits = topLevelUnits(new UniLexer().tokenize(oldSrc));
  const newUnits = topLevelUnits(new UniLexer().tokenize(newSrc));
  const rows = diffForests(oldUnits, newUnits);

  const MARK = { unchanged: '=', moved: '^', modified: '~', added: '+', removed: '-' };
  const counts = { unchanged: 0, moved: 0, modified: 0, added: 0, removed: 0 };

  process.stdout.write(`── subforest diff: ${oldPath} → ${newPath} ──\n`);
  for (const r of rows) {
    counts[r.verdict]++;
    if (r.verdict === 'unchanged' && !values.verbose) continue;
    let line = `  ${MARK[r.verdict]} ${r.name.padEnd(20)} ${r.verdict}`;
    if (r.verdict === 'moved') line += ' (content identical)';
    if (r.verdict === 'modified') {
      line += `${r.moved ? ' + moved' : ''} — first difference at token ${r.diff.tok}: ${describeTok(r.diff.old)} → ${describeTok(r.diff.new)}`;
    }
    process.stdout.write(line + '\n');
  }
  const summary = Object.entries(counts).filter(([, c]) => c > 0).map(([k, c]) => `${c} ${k}`).join(', ');
  process.stdout.write(`── summary: ${summary} ──\n`);

  const different = counts.moved + counts.modified + counts.added + counts.removed > 0;
  process.exit(different ? 1 : 0);
}

// Run the CLI only when invoked directly; demos import the functions.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { topLevelUnits, diffForests };
