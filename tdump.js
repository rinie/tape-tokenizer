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
  -o, --outline <n>  Breadth-first view, folded at depth n (n >= 1): tokens at
                   depth < n print; a matched span starting at depth n-1 folds
                   to one line (\`{ … 12 … }\`) via its link. Trivia and bare
                   punct (: , ;) are always dropped. Raise n to peel a layer.
  -l, --lang <l>   Force language: js | xml | rust | sql | py | yaml | json5.
                   Default: detect from the file
                   extension (.xml/.html/.htm/.svg -> xml, .rs -> rust,
                   .sql/.pks/.pkb -> sql [Oracle], .py -> py,
                   .yaml/.yml -> yaml, .json/.json5/.jsonc -> json5, else js).
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

// Newlines inside a token's value display as the 2-char escape — only the
// newline TOKEN (0x10) and the ghost ever produce real line breaks.
function escapeNl(s) {
  return s.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

// Sign-first delta string ('' when unchanged)
function deltaSign(delta) {
  if (delta === 0) return '';
  if (delta === 1) return '+';
  if (delta === -1) return '-';
  return `${delta > 0 ? '+' : ''}${delta}`;
}

// Indent width of an intra-line ws lexeme, in units; offUnit if not whole.
function measureIndent(lexeme, unit) {
  if (unit.kind === 'tab') {
    return { units: (lexeme.match(/\t/g) || []).length, offUnit: /[^\t]/.test(lexeme) };
  }
  const cols = lexeme.replace(/\t/g, ' '.repeat(4)).length;
  return { units: Math.floor(cols / unit.width), offUnit: cols % unit.width !== 0 || /\t/.test(lexeme) };
}

// Render one ws token in the brief notation. Newlines are their OWN tokens
// (TAG_NL, byte 0x10) since the newline-token change; the indent that follows
// is a separate ws token, and the level delta renders on whichever token ends
// the line transition:
//   \n / \n(k)    the newline(s); carries the delta itself ONLY when the new
//                 line has zero indent (no indent token follows)
//   + / - / +2    the following indent token: level change, sign first
//   =             the following indent token: level unchanged — quiet
//   ' ' ' '(n)    mid-line spacing, as before
// `state` carries {units, afterNl} across calls; `next` is the next token's
// {isIntraWs} for the zero-indent case.
function briefWs(lexeme, unit, state, isNl, nextIsIntraWs) {
  if (isNl) {
    const k = (lexeme.match(/\n/g) || []).length || lexeme.length;
    let out = k === 1 ? '\\n' : `\\n(${k})`;
    state.afterNl = true;
    if (!nextIsIntraWs) {                       // zero-indent line: delta lands here
      const sign = deltaSign(0 - state.units);
      out = sign + out;
      state.units = 0;
      state.afterNl = false;
    }
    return out;
  }
  if (state.afterNl) {                          // this token IS the line's indent
    state.afterNl = false;
    const { units, offUnit } = measureIndent(lexeme, unit);
    const sign = deltaSign(units - state.units);
    state.units = units;
    if (offUnit) return `${sign || '='} ${JSON.stringify(lexeme)}`;   // deviation: show it
    return sign || '=';
  }
  // mid-line spacing
  if (/^ +$/.test(lexeme)) return lexeme.length === 1 ? "' '" : `' '(${lexeme.length})`;
  if (/^\t+$/.test(lexeme)) return lexeme.length === 1 ? '\\t' : `\\t(${lexeme.length})`;
  return JSON.stringify(lexeme);                // mixed — explicit
}

function tokenize(src, lang) {
  return lang === 'xml' ? new UniLexer().tokenizeXml(src)
    : lang === 'rust' ? new UniLexer().tokenizeRust(src)
    : lang === 'sql' ? new UniLexer().tokenizeSql(src)
    : lang === 'py' ? new UniLexer().tokenizePy(src)
    : lang === 'yaml' ? new UniLexer().tokenizeYaml(src)
    : lang === 'json5' ? new UniLexer().tokenizeJson5(src)
    : new UniLexer().tokenize(src);
}

// The breadth-first viewer (mirrors scan.js's toOutline for the older tape,
// generalised across unilexer's THREE bracket families — char-matched,
// name-matched, indentation — via one uniform test: a token is an OPENER iff
// it links FORWARD (link > its own index). No per-family byte lists needed.
// Tokens at depth >= maxDepth are folded: a matched opener sitting exactly at
// the fold boundary collapses its whole span to one line (`{ … 12 … }`) via
// its link, O(1) per fold — unmatched openers are never folded (never guess
// a missing close; they print open with a trailing `…?`, same as repairMap).
// Trivia (ws/comment) and bare structural punct (: , ;) are always dropped —
// pure separator noise once indentation already shows the nesting.
function outlineLabel(u, t) {
  const klass = u.classOf(t);
  if (klass === KLASS.BRACKET) return u.mnemonicOf(t);
  const mnem = u.mnemonicOf(t);
  let lex = escapeNl(u.lexemeOf(t));
  if (lex.length > 60) lex = lex.slice(0, 60) + '…';
  return (!lex || lex === mnem) ? mnem : `${mnem} ${lex}`;
}

function outlineView(src, lang, maxDepth) {
  const u = tokenize(src, lang);
  const n = u.length;
  const lines = [];
  let t = 0;
  while (t < n) {
    const klass = u.classOf(t);
    if (klass === KLASS.WS || klass === KLASS.COMMENT || klass === KLASS.PUNCT) { t++; continue; }
    const d = u.depthOf(t);
    if (d >= maxDepth) { t++; continue; }
    const indent = '  '.repeat(d);
    const link = u.linkOf(t);
    const isOpener = link !== -1 && link > t;
    if (isOpener && d === maxDepth - 1) {
      const inner = link - t - 1;
      const label = `${outlineLabel(u, t)}`;
      const closeLabel = outlineLabel(u, link);
      lines.push(inner <= 0 ? `${indent}${label}${closeLabel}` : `${indent}${label} … ${inner} … ${closeLabel}`);
      t = link + 1;
      continue;
    }
    const unmatched = link === -1 && (klass === KLASS.BRACKET || klass === KLASS.TAG);
    lines.push(indent + outlineLabel(u, t) + (unmatched ? ' …?' : ''));
    t++;
  }
  return `outline (folded at depth ${maxDepth}; raise to peel a layer):\n${lines.join('\n')}`;
}

// ── the dump itself — a projection over the unchanged tape ───────────────────
// Brief/signal show BARE values: the class column already implies the kind, so
// quotes are noise (a string's own quotes are part of its lexeme and show
// naturally). Full shows the exact source text JSON-escaped — that column
// concatenates back to the original.
function dumpTokens(src, mode = 'brief', lang = 'js') {
  const u = tokenize(src, lang);
  const unit = detectIndentUnit(src);
  const state = { units: 0, afterNl: true };   // file start counts as a line start
  const lines = [];

  if (mode === 'brief') lines.push(`indent unit: ${unit.label}; on the indent token: +1/-1 = level change (sign first), = unchanged; \\n is its own token`);

  for (let t = 0; t < u.length; t++) {
    const klass = u.classOf(t);
    const trivia = klass === KLASS.WS || klass === KLASS.COMMENT;
    if (mode === 'signal' && trivia) continue;
    // xml: a bare '>' after attributes is a tag-closing separator, not signal.
    // ('/>' stays — it says the element closed.) Attribute-less tags absorb
    // their '>' into the tag token, so this row only occurs after attributes.
    if (mode === 'signal' && lang === 'xml' && klass === KLASS.PUNCT && u.lexemeOf(t) === '>') continue;

    const lexeme = u.lexemeOf(t);
    let value;
    if (klass !== KLASS.WS) state.afterNl = false;   // any non-ws token ends the line-start window
    if (mode === 'full') value = JSON.stringify(u.rawOf(t));               // exact, revertible
    else if (klass === KLASS.WS) {
      const isNl = u.tagOf(t) === 0x10;
      const nextIsIntraWs = t + 1 < u.length && u.classOf(t + 1) === KLASS.WS && u.tagOf(t + 1) !== 0x10;
      value = briefWs(lexeme, unit, state, isNl, nextIsIntraWs);
    } else if (klass === KLASS.COMMENT || klass === KLASS.TEXT || klass === KLASS.DECL) {
      value = escapeNl(lexeme.length > 40 ? lexeme.slice(0, 40) + '…' : lexeme);
    } else value = escapeNl(lexeme);   // bare — class implies kind; a multi-line
                                       // lexeme (template) DISPLAYS its newlines
                                       // as \n escapes, never as real breaks

    lines.push(`[${String(t).padStart(4)}] ${u.mnemonicOf(t).padEnd(4)} ${(KLASS_NAME[klass] + '#' + u.poolArr[t]).padEnd(12)} ${value}`);
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
        outline: { type: 'string',  short: 'o' },
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
  if (lang && !['js', 'xml', 'rust', 'sql', 'py', 'yaml', 'json5'].includes(lang)) fail(`unknown --lang '${lang}' (expected js | xml | rust | sql | py | yaml | json5)`);
  if (!lang) {
    const ext = positionals[0] === '-' ? '' : extname(positionals[0]).toLowerCase();
    lang = ['.xml', '.html', '.htm', '.svg'].includes(ext) ? 'xml'
      : ext === '.rs' ? 'rust'
      : ['.sql', '.pks', '.pkb', '.plsql'].includes(ext) ? 'sql'
      : ext === '.py' ? 'py'
      : ['.yaml', '.yml'].includes(ext) ? 'yaml'
      : ['.json', '.json5', '.jsonc'].includes(ext) ? 'json5'
      : 'js';
  }
  let outlineDepth = 0;
  if (values.outline !== undefined) {
    outlineDepth = parseInt(values.outline, 10);
    if (!Number.isInteger(outlineDepth) || outlineDepth < 1) fail(`invalid --outline '${values.outline}' (expected a depth >= 1)`);
  }

  let src;
  try {
    src = positionals[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(positionals[0], 'utf8');
  } catch { fail(`cannot read '${positionals[0]}'`); }

  process.stdout.write((outlineDepth ? outlineView(src, lang, outlineDepth) : dumpTokens(src, mode, lang)) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { dumpTokens, detectIndentUnit, briefWs };
