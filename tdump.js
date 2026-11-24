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
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { KLASS, KLASS_NAME, LANGS, langOfPath, tokenizeAs as tokenize } from './unilexer.js';

import { VERSION } from './version.js';

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
                   punct (: , ;) are always dropped, and so are XML/HTML
                   attributes. Raise n to peel a layer.
      --clike      With --outline, XML/HTML in a C-like layout: the name
                   before the brace and a bare close (book { … }), an empty
                   element as a statement (br;), text as a quoted string.
                   An element whose HTML end tag was omitted opens and
                   closes with ~ (li ~ … ~), so every { has its }. Text
                   drops trailing line-break whitespace and is shown with
                   character references decoded (&amp; -> &), except in
                   HTML <script>/<style>. qmd uses the same layout
                   (h2 ~ … ~ for ## or an --- underline, div.callout-note { … }, div[layout-ncol] { … }
                   for ::: {layout-ncol=2}, cell.r { … },
                   raw.html { … } for a {=html} block, div { … } for an
                   HTML <div> block,
                   ul ~ li ~ … ~ ~, dl ~ dt ~ … ~ dd ~ … ~ ~,
                   blockquote ~ … ~, fn.id ~ … ~,
                   code ~ … ~ for indented code), pipe, grid, simple and
                   multiline tables as
                   [ rows [ cells ] ] and a ': caption' after one as
                   caption ~ … ~,
                   text undecoded.
  -l, --lang <l>   Force language: js | xml | html | rust | sql | py | yaml |
                   json5 | qmd. Default: detect from the file extension
                   (.xml/.svg -> xml, .html/.htm -> html, .rs -> rust,
                   .sql/.pks/.pkb -> sql [Oracle], .py -> py,
                   .yaml/.yml -> yaml, .json/.json5/.jsonc -> json5,
                   .qmd -> qmd [Quarto block structure], else js).
  -h, --help       Show this help and exit.
  -V, --version    Print version and exit.

COLUMNS
  [tape index] tag-char class#poolIndex value

  The tag char is the mnemonic for the STRUCTURAL role, not the surface syntax:
  keywords whisper lowercase, literals shout uppercase, brackets are literal —
  and in XML mode an open tag is { and a close tag is }, with the tag NAME as
  the value (interned: <book> and </book> share the same pool slot). A
  complete tag (<br/>, an HTML void <br>) is /. In HTML mode an omitted
  optional end tag (</p>, </li>, </td>, </body>) shows as a zero-width ~.
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


// The breadth-first viewer (mirrors scan.js's toOutline for the older tape,
// generalised across unilexer's THREE bracket families — char-matched,
// name-matched, indentation — via one uniform test: a token is an OPENER iff
// it links FORWARD (link > its own index). No per-family byte lists needed.
// Tokens at depth >= maxDepth are folded: a matched opener sitting exactly at
// the fold boundary collapses its whole span to one line (`{ … 12 … }`) via
// its link, O(1) per fold — unmatched openers are never folded (never guess
// a missing close; they print open with a trailing `…?`, same as repairMap).
// Trivia (ws/comment) and bare structural punct (: , ;) are always dropped —
// pure separator noise once indentation already shows the nesting. So are
// XML/HTML attributes: an outline is the element tree, and `name = "value"`
// rows under every tag drown it (they stay on the tape; the dump modes show
// them).
function outlineLabel(u, t) {
  const klass = u.classOf(t);
  if (klass === KLASS.BRACKET) return u.mnemonicOf(t);
  const mnem = u.mnemonicOf(t);
  let lex = escapeNl(u.lexemeOf(t));
  if (lex.length > 60) lex = lex.slice(0, 60) + '…';
  return (!lex || lex === mnem) ? mnem : `${mnem} ${lex}`;
}

// After a start tag token, the index past its attributes: an element whose
// tag has attributes is the name token, then attribute tokens (names, '=',
// quoted values, whitespace), then a '>' or '/>' PUNCT — a tag without
// attributes carries its '>' itself, and the next token is already content.
function skipAttributes(u, n, t) {
  let j = t + 1;
  while (j < n) {
    const k = u.classOf(j);
    if (k === KLASS.TAG || k === KLASS.TEXT || k === KLASS.COMMENT || k === KLASS.DECL) return j;
    if (k === KLASS.PUNCT && (u.lexemeOf(j) === '>' || u.lexemeOf(j) === '/>')) return j + 1;
    j++;
  }
  return j;
}

// --clike: XML/HTML in a C-like layout — the name BEFORE the brace and a bare
// closing brace (`book {` … `}`), an element with no content as a statement
// (`br;`), text as a string literal. An element whose HTML end tag was
// omitted opens AND closes with `~` (`li ~` … `~`): braces always match, and
// the view never claims a close that is not in the source. Everything else
// (declarations, other languages) is unchanged.
function clikeLabel(u, t, unmatched, html = false, decode = true) {
  const tag = u.tagOf(t);
  const lex = u.lexemeOf(t);
  if (u.classOf(t) === KLASS.TAG) {
    if (tag === 0x7B) {
      // braces match: an element whose end tag was omitted opens with the
      // same '~' it closes with (li ~ … ~), never a '{' with no '}'
      const link = u.linkOf(t);
      return link !== -1 && u.tagOf(link) === 0x7E ? `${lex} ~` : `${lex} {`;
    }
    if (tag === 0x2F) return `${lex};`;
    if (tag === 0x7E) return '~';
    if (tag === 0x7D) return unmatched ? `} ${lex}` : '}';   // an orphan close keeps its name
  }
  if (u.classOf(t) === KLASS.TEXT) {
    // trailing source indentation (a line break plus the next line's indent,
    // kept by text before an omitted end tag) is layout, not content: drop
    // it. A trailing space on the same line ("Intro with ") stays.
    let txt = lex.replace(/\s*[\r\n]\s*$/, '');
    // qmd: no decoding — a code cell's body is code
    if (decode && !(html && inRawText(u, t))) txt = decodeEntities(txt, html);
    return JSON.stringify(txt.length > 60 ? txt.slice(0, 60) + '…' : txt);
  }
  return outlineLabel(u, t);
}

// Character references in --clike text are decoded (the view shows what the
// text says, `"XML & the art"`, not how it was escaped). XML's five
// predefined entities plus numeric references (&#38; &#x26;) everywhere;
// in HTML also a handful of common named ones. An unknown or malformed
// reference is left as written, never guessed at.
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const HTML_ENTITIES = {
  ...XML_ENTITIES, nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', laquo: '«', raquo: '»', middot: '·', times: '×', deg: '°',
  euro: '€', shy: '­',
};
function decodeEntities(s, html) {
  const named = html ? HTML_ENTITIES : XML_ENTITIES;
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g, (m, dec, hex, name) => {
    if (name !== undefined) return Object.hasOwn(named, name) ? named[name] : m;
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) ? String.fromCodePoint(cp) : m;
  });
}

// HTML <script>/<style> hold raw text: '&amp;' there is four characters, not
// an escape (title/textarea do decode references, so they are not listed).
// The text's element is the nearest TAG token before it — attributes in
// between are IDENT/STRING/PUNCT, never TAG.
const RAW_TEXT_NO_REFS = new Set(['script', 'style']);
function inRawText(u, t) {
  for (let i = t - 1; i >= 0; i--) {
    if (u.classOf(i) !== KLASS.TAG) continue;
    return u.tagOf(i) === 0x7B && RAW_TEXT_NO_REFS.has(u.lexemeOf(i).toLowerCase());
  }
  return false;
}

function outlineView(src, lang, maxDepth, { clike = false } = {}) {
  const u = tokenize(src, lang);
  const n = u.length;
  const markup = lang === 'xml' || lang === 'html' || lang === 'qmd';
  // XML/HTML start tags carry attributes; qmd tags have none, and the token
  // after one (a table's zero-width '[') is content, never skipped
  const attrs = lang === 'xml' || lang === 'html';
  const label = markup && clike ? (t, unmatched = false) => clikeLabel(u, t, unmatched, lang === 'html', lang !== 'qmd') : (t) => outlineLabel(u, t);
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
    // <b y="2"/>: an element closed by the '/>' after its attributes is one
    // self-contained line, the same '/' as an attribute-less <c/>
    if (markup && isOpener && u.classOf(link) === KLASS.PUNCT) {
      lines.push(clike ? `${indent}${u.lexemeOf(t)};` : `${indent}/ ${u.lexemeOf(t)}`);
      t = link + 1;
      continue;
    }
    if (isOpener && d === maxDepth - 1) {
      // count the element's content, not its (hidden) attributes
      const inner = link - (attrs && klass === KLASS.TAG ? skipAttributes(u, n, t) : t + 1);
      const openLabel = label(t);
      const closeLabel = label(link);
      lines.push(inner <= 0 ? `${indent}${openLabel}${closeLabel}` : `${indent}${openLabel} … ${inner} … ${closeLabel}`);
      t = link + 1;
      continue;
    }
    const unmatched = link === -1 && (klass === KLASS.BRACKET || klass === KLASS.TAG);
    lines.push(indent + label(t, unmatched) + (unmatched ? ' …?' : ''));
    // a start tag (open '{' or void '/'): its attributes are not structure
    const tag = u.tagOf(t);
    t = attrs && klass === KLASS.TAG && (tag === 0x7B || tag === 0x2F) ? skipAttributes(u, n, t) : t + 1;
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
    if (mode === 'signal' && (lang === 'xml' || lang === 'html') && klass === KLASS.PUNCT && u.lexemeOf(t) === '>') continue;

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
        clike:   { type: 'boolean' },
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
  if (lang && !LANGS.includes(lang)) fail(`unknown --lang '${lang}' (expected ${LANGS.join(' | ')})`);
  if (!lang) lang = (positionals[0] === '-' ? null : langOfPath(positionals[0])) ?? 'js';
  let outlineDepth = 0;
  if (values.outline !== undefined) {
    outlineDepth = parseInt(values.outline, 10);
    if (!Number.isInteger(outlineDepth) || outlineDepth < 1) fail(`invalid --outline '${values.outline}' (expected a depth >= 1)`);
  }
  if (values.clike && !outlineDepth) fail('--clike only applies to --outline');

  let src;
  try {
    src = positionals[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(positionals[0], 'utf8');
  } catch { fail(`cannot read '${positionals[0]}'`); }

  process.stdout.write((outlineDepth ? outlineView(src, lang, outlineDepth, { clike: !!values.clike }) : dumpTokens(src, mode, lang)) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { dumpTokens, detectIndentUnit, briefWs, outlineView };
