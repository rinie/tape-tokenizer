// tdump.js — token dump: every token with its (pool index / value) pair, on the
// unified tape.
//
//   node tdump.js [--full | --brief | --signal] <file.js>
//
// Three views over ONE unchanged tape — this is the design answer to "would
// associating whitespace with a real token complicate the tape?": no. The tape
// stays uniform (whitespace IS a token, §13b lossless); association and
// noise-reduction are PROJECTIONS, derivable by adjacency, never stored:
//
//   --full     complete and revertible: exact lexemes (JSON-escaped), every
//              token. Concatenating the value column reproduces the source
//              byte-for-byte (verified in the footer).
//   --brief    the signal with quiet whitespace (default): ws is rendered in a
//              compact indent-aware notation — see below.
//   --signal   no trivia at all: significant tokens only.
//
// Brief whitespace notation. The dump first detects the file's INDENT UNIT
// (tabs, or the most common space-step — 2, 4, …) and reports it once in the
// header. Each ws token then renders as:
//
//   ' '          one inter-token space (the overwhelmingly common case)
//   ' '(n)       n spaces on one line          \t / \t(n)   tabs likewise
//   \n           newline, SAME indent level as the previous line — quiet
//   +\n  -\n     newline, indent one UNIT deeper / shallower. The sign LEADS
//   +2\n -3\n    (diff convention): scanning the column, a change jumps out at
//                the first glyph while quiet \n rows don't.
//   \n(k)        k consecutive newlines (blank lines); with a change: +\n(2)
//   …' '(n)      an OFF-UNIT indent (not a whole number of units) is shown
//                explicitly — that deviation is worth seeing.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { UniLexer, KLASS, KLASS_NAME } from './unilexer.js';

const VERSION = '0.1.0';

const HELP = `tape-tokenizer tdump — token dump with pool index/value pairs (v${VERSION})

USAGE
  node tdump.js [options] <file.js>
  node tdump.js [options] -          (read from stdin)

OPTIONS
      --full       Lossless view: every token, exact source text (JSON-escaped).
                   The value column concatenates back to the original source.
      --brief      Default. Bare values (the class column already implies the
                   kind — quotes would be noise); whitespace as compact indent
                   deltas (+\\n, -\\n, +2\\n — sign first), quiet when unchanged.
      --signal     Significant tokens only — no whitespace, no comments.
  -l, --lang <l>   Force language: js | xml. Default: detect from the file
                   extension (.xml/.html/.htm/.svg -> xml, else js).
  -h, --help       Show this help and exit.
  -V, --version    Print version and exit.

COLUMNS
  [tape index] tag-char class#poolIndex value

  The tag char is the mnemonic for the STRUCTURAL role, not the surface syntax:
  keywords whisper lowercase, literals shout uppercase, brackets are literal —
  and in XML mode an open tag is { and a close tag is }, with the tag NAME as
  the value (interned: <book> and </book> share the same pool slot).
  Interned classes (ws, ident, keyword, op, punct, bracket, tag) reuse pool
  slots; literal classes (string, number, comment, text, …) get one slot per
  occurrence.
`;

function fail(msg) {
  process.stderr.write(`tdump: ${msg}\nTry 'node tdump.js --help' for usage.\n`);
  process.exit(2);
}

// ── indent unit detection ─────────────────────────────────────────────────────
// Look at the leading whitespace of non-blank lines. Tabs win if present;
// otherwise the most common positive step between consecutive indent widths.
function detectIndentUnit(src) {
  const lines = src.split('\n');
  let sawTab = false;
  const widths = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^[ \t]*/)[0];
    if (m.includes('\t')) sawTab = true;
    widths.push(m.replace(/\t/g, '    ').length);   // tab≈4 just for stepping
  }
  if (sawTab) return { kind: 'tab', width: 1, label: '\\t (tabs)' };
  const steps = new Map();
  for (let i = 1; i < widths.length; i++) {
    const d = Math.abs(widths[i] - widths[i - 1]);
    if (d > 0) steps.set(d, (steps.get(d) || 0) + 1);
  }
  let best = 0; let bestCount = 0;
  for (const [d, c] of steps) if (c > bestCount || (c === bestCount && d < best)) { best = d; bestCount = c; }
  const width = best || 2;
  return { kind: 'space', width, label: `${width} spaces` };
}

// Render one ws lexeme in the brief notation. `state.units` carries the current
// indent level (in units) across calls.
function briefWs(lexeme, unit, state) {
  const nl = (lexeme.match(/\n/g) || []).length;
  if (nl === 0) {
    if (/^ +$/.test(lexeme)) return lexeme.length === 1 ? "' '" : `' '(${lexeme.length})`;
    if (/^\t+$/.test(lexeme)) return lexeme.length === 1 ? '\\t' : `\\t(${lexeme.length})`;
    return JSON.stringify(lexeme);                      // mixed — explicit
  }
  const tail = lexeme.slice(lexeme.lastIndexOf('\n') + 1);   // the new line's indent
  let units;
  let offUnit = false;
  if (unit.kind === 'tab') {
    units = (tail.match(/\t/g) || []).length;
    offUnit = /[^\t]/.test(tail);
  } else {
    const cols = tail.replace(/\t/g, ' '.repeat(4)).length;
    units = Math.floor(cols / unit.width);
    offUnit = cols % unit.width !== 0 || /\t/.test(tail);
  }
  // sign-first (diff convention): the level change leads, quiet \n stays bare
  const delta = units - state.units;
  let sign = '';
  if (delta === 1) sign = '+';
  else if (delta === -1) sign = '-';
  else if (delta !== 0) sign = `${delta > 0 ? '+' : ''}${delta}`;
  let out = sign + (nl === 1 ? '\\n' : `\\n(${nl})`);
  if (offUnit && tail.length) out += ` ${JSON.stringify(tail)}`;   // deviation: show it
  state.units = units;
  return out;
}

// ── the dump itself — a projection over the unchanged tape ───────────────────
// Brief/signal show BARE values: the class column already implies the kind, so
// quotes are noise (a string's own quotes are part of its lexeme and show
// naturally). Full shows the exact source text JSON-escaped — that column
// concatenates back to the original.
function dumpTokens(src, mode = 'brief', lang = 'js') {
  const u = lang === 'xml' ? new UniLexer().tokenizeXml(src) : new UniLexer().tokenize(src);
  const unit = detectIndentUnit(src);
  const state = { units: 0 };
  const lines = [];

  if (mode === 'brief') lines.push(`indent unit: ${unit.label}; +\\n/-\\n = level change in units (sign leads); quiet \\n when unchanged`);

  for (let t = 0; t < u.length; t++) {
    const klass = u.classOf(t);
    const trivia = klass === KLASS.WS || klass === KLASS.COMMENT;
    if (mode === 'signal' && trivia) continue;

    const lexeme = u.lexemeOf(t);
    let value;
    if (mode === 'full') value = JSON.stringify(u.rawOf(t));               // exact, revertible
    else if (klass === KLASS.WS) value = briefWs(lexeme, unit, state);
    else if (klass === KLASS.COMMENT || klass === KLASS.TEXT || klass === KLASS.DECL) {
      value = (lexeme.length > 40 ? lexeme.slice(0, 40) + '…' : lexeme).replace(/\n/g, '\\n');
    } else value = lexeme;                                                 // bare — class implies kind

    lines.push(`[${String(t).padStart(4)}] ${u.charOf(t)} ${(KLASS_NAME[klass] + '#' + u.poolArr[t]).padEnd(12)} ${value}`);
  }

  const footer = [`${u.length} tokens`];
  if (mode === 'full') footer.push(`lossless: ${u.reconstruct() === src ? 'PASS (value column reverts to the original)' : 'FAIL'}`);
  if (mode === 'signal') footer.push('trivia omitted (still on the tape — this is a view, not a loss)');
  lines.push(`── ${footer.join('; ')} ──`);
  return lines.join('\n');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        full:    { type: 'boolean' },
        brief:   { type: 'boolean' },
        signal:  { type: 'boolean' },
        lang:    { type: 'string',  short: 'l' },
        help:    { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (e) { fail(e.message); }
  const { values, positionals } = parsed;
  if (values.help)    { process.stdout.write(HELP); process.exit(0); }
  if (values.version) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
  if (positionals.length !== 1) fail('expected exactly one file (or - for stdin)');

  const mode = values.full ? 'full' : values.signal ? 'signal' : 'brief';
  let lang = values.lang;
  if (lang && lang !== 'js' && lang !== 'xml') fail(`unknown --lang '${lang}' (expected js | xml)`);
  if (!lang) {
    const ext = positionals[0] === '-' ? '' : extname(positionals[0]).toLowerCase();
    lang = ['.xml', '.html', '.htm', '.svg'].includes(ext) ? 'xml' : 'js';
  }
  let src;
  try {
    src = positionals[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(positionals[0], 'utf8');
  } catch { fail(`cannot read '${positionals[0]}'`); }

  process.stdout.write(dumpTokens(src, mode, lang) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { dumpTokens, detectIndentUnit, briefWs };
