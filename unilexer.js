// unilexer.js — the lexer consolidation: ONE scan pass, ONE uniform tape.
//
// The repo had grown three lexers (tokenizer.js, lexical-scanner.js,
// valuetape.js), each with its own copy of string/comment/regex
// classification. This module is the consolidation target: a single pass that
// emits one tape carrying BOTH layers —
//
//   * the value layer: every token (whitespace and comments included) indexes a
//     per-class value pool, dedup keyed to uniqueness (§13b);
//   * the structural layer: brackets additionally carry a partner link (jump)
//     and a depth, tolerant and non-faulting.
//
// THE ENCODING PREFERENCE, made load-bearing: **the tape's tag byte IS the
// printable ASCII mnemonic** from token-tags.js — not a parallel debug label.
// One byte per token, self-describing in any dump (§7's visual grammar):
//
//   brackets/punct   their literal ASCII        ( ) { } [ ] ; , . :
//   keywords         lowercase mnemonics whisper f=function r=return i=if …
//   literals         UPPERCASE initials shout    I=IDENT N=NUMBER D=DOUBLE
//                                                R=REGEX ('/' is division's);
//                    strings/templates carry their own delimiter: " ' `
//   operators        their own byte: single-char ops their literal ASCII,
//                    multi-char ops a 0x80+ block (OPS in token-tags;
//                    OP_LITERAL decodes byte → text — '&&' is 0x89)
//   comments         '#' when single-line; a comment that CONTAINS newlines
//                    keeps them inside and tags 0x11, rendered C(n)
//   whitespace       intra-line runs ' ' (0x20); each newline run is its OWN
//                    token (0x10) — no structural value, but a line SIGNAL.
//                    toPrintable() breaks lines where the source does
//
// The coarse class (for programmatic queries) is DERIVED from the tag byte via
// a 256-entry lookup — no second per-token column. Mnemonic for humans, class
// for machines, one byte for both.
//
// Scope (honest): JavaScript only for now. sfdiff.js rides this module;
// tokenizer.js (defuse) and lexical-scanner.js (scan/validate — seams, cpp,
// XML, multi-language tables) are migration targets, not yet migrated.

import { T, KEYWORDS, OPS, OP_LITERAL, OP_CONCAT, SQL_OP_ROLES } from './token-tags.js';

// ── classes (coarse, derived from the tag byte) ──────────────────────────────
const KLASS = {
  WS: 0, COMMENT: 1, STRING: 2, TEMPLATE: 3, REGEX: 4,
  NUMBER: 5, IDENT: 6, KEYWORD: 7, OP: 8, PUNCT: 9, BRACKET: 10,
  TAG: 11, TEXT: 12, DECL: 13,          // XML mode
  BUILTIN: 14,                          // SQL: well-known built-in functions —
                                        // the owner's split: actual KEYWORDS vs
                                        // builtins (NVL, SUBSTR, …). Too many
                                        // for per-item bytes (the §13e rule's
                                        // boundary case): one byte 'B', interned
                                        // pool carries which.
};
const KLASS_NAME = ['ws', 'comment', 'string', 'template', 'regex',
  'number', 'ident', 'keyword', 'op', 'punct', 'bracket',
  'tag', 'text', 'decl', 'builtin'];

const TAG_WS      = 0x20;     // ' '  intra-line whitespace (spaces/tabs)
const TAG_NL      = 0x10;     // newline token — no structural value, but a line
                              // SIGNAL (owner's byte choice; the token stands
                              // for a control character, so a control-range
                              // byte matches its nature)
const TAG_INDENT  = 0x0E;     // SO (shift out)  — INDENT: a line opened a level.
const TAG_DEDENT  = 0x0F;     // SI (shift in)   — DEDENT: a level closed.
                              // The indentation bracket family (Python, YAML).
                              // Zero-width tokens at the line's content start;
                              // control-range like TAG_NL (line-signal tokens).
                              // Python's real { } dict braces stay brackets —
                              // the family must not overload them (RATFOR
                              // refinement) — so the projection renders the
                              // digraphs ':{' and '}:' (the colon that
                              // introduces blocks, bookended outside).
const TAG_COMMENT = 0x23;     // '#'  comment without newlines (// or one-line /* */)
const TAG_COMMENT_ML = 0x11;  // multi-line comment — newlines stay INSIDE the
                              // token; renders as C(n), n = newlines contained

// tag byte → class, built once from token-tags
const TAG_CLASS = new Uint8Array(256).fill(KLASS.PUNCT);
TAG_CLASS[TAG_WS] = KLASS.WS;
TAG_CLASS[TAG_NL] = KLASS.WS;             // a ws-class token of its own
TAG_CLASS[TAG_COMMENT] = KLASS.COMMENT;
TAG_CLASS[TAG_COMMENT_ML] = KLASS.COMMENT;
TAG_CLASS[T.STRING] = KLASS.STRING;       // "  double-quoted
TAG_CLASS[T.STRING_SQ] = KLASS.STRING;    // '  single-quoted
TAG_CLASS[T.TEMPLATE] = KLASS.TEMPLATE;   // X
TAG_CLASS[T.REGEX] = KLASS.REGEX;         // R
TAG_CLASS[T.NUMBER] = KLASS.NUMBER;       // N
TAG_CLASS[T.DOUBLE] = KLASS.NUMBER;       // D
TAG_CLASS[T.IDENT] = KLASS.IDENT;         // I
for (const byte of KEYWORDS.values()) TAG_CLASS[byte] = KLASS.KEYWORD;
// Operators are directly encoded — every operator has its OWN tag byte.
// Single-char ops use their literal ASCII (token-tags freed '^' and '~' for
// this: catch → 'H', false → 'u'); multi-char ops use the 0x80+ block from
// the OPS table, decoded back to text by OP_LITERAL.
for (const ch of '!%&*+-/<=>?@^|~') TAG_CLASS[ch.charCodeAt(0)] = KLASS.OP;
for (const byte of OPS.values()) TAG_CLASS[byte] = KLASS.OP;   // multi-char ops, 0x80+
TAG_CLASS[OP_CONCAT] = KLASS.OP;
for (const b of [T.LPAREN, T.RPAREN, T.LBRACKET, T.RBRACKET, T.LBRACE, T.RBRACE]) {
  TAG_CLASS[b] = KLASS.BRACKET;
}

// Dedup policy (§13b): intern the limited vocabularies, store literals per
// occurrence — the waste is acceptable. XML tag NAMES are a limited vocabulary
// (interned — open and close share the pool slot, making the name match
// visible); text/decl content is mostly unique (per occurrence).
const INTERNED = new Set([KLASS.WS, KLASS.IDENT, KLASS.KEYWORD, KLASS.OP, KLASS.PUNCT, KLASS.BRACKET, KLASS.TAG, KLASS.BUILTIN]);

// ── XML mode: structural role over surface syntax ────────────────────────────
// The mnemonic projection uses the STRUCTURAL role, not the source characters:
// every open tag is `{`, every close tag is `}` — the universal bracket
// mnemonics — with the tag NAME as the pooled value. `<book>` → `{ tag#1 book`,
// `</book>` → `} tag#1 book` (same pool slot). Text content is `T`, comments
// `#`, declarations/PI/CDATA `!`. Attributes inside a tag tokenize as
// ident/op/string; `>` and `/>` are punct.
const TAG_CLASS_XML = new Uint8Array(256).fill(KLASS.PUNCT);
TAG_CLASS_XML[TAG_WS] = KLASS.WS;
TAG_CLASS_XML[TAG_NL] = KLASS.WS;
TAG_CLASS_XML[TAG_COMMENT] = KLASS.COMMENT;     // #
TAG_CLASS_XML[TAG_COMMENT_ML] = KLASS.COMMENT;  // C(n)
TAG_CLASS_XML[0x21] = KLASS.DECL;               // !  <?…?> <!…> <![CDATA[…]]>
TAG_CLASS_XML[0x7B] = KLASS.TAG;                // {  open tag
TAG_CLASS_XML[0x7D] = KLASS.TAG;                // }  close tag
TAG_CLASS_XML[0x2F] = KLASS.TAG;                // /  complete self-closing tag
TAG_CLASS_XML[0x54] = KLASS.TEXT;               // T  text content
TAG_CLASS_XML[T.STRING] = KLASS.STRING;         // "  attribute values
TAG_CLASS_XML[T.STRING_SQ] = KLASS.STRING;      // '  attribute values
TAG_CLASS_XML[T.IDENT] = KLASS.IDENT;           // I  attribute names
TAG_CLASS_XML[T.OP] = KLASS.OP;                 // =

// ── SQL / PL-SQL mode ─────────────────────────────────────────────────────────
// PL/SQL's block keywords are the XML name-matched tag family wearing keyword
// clothes: IF / LOOP / CASE / BEGIN open as '{' with the KIND as the interned
// value, and END IF is ONE '}' token (two keywords, one closer, value 'if'),
// name-matched tolerantly to its opener. SQL has no brace family to collide
// with, so plain { } per the RATFOR rule — exactly like XML tags.
//
// The vocabulary split (owner's call): actual KEYWORDS (closed, the language)
// class 'keyword' byte 'k'; well-known BUILT-IN functions class 'builtin' byte
// 'B' — both interned, the pool says which. Per-keyword mnemonic bytes are the
// same deferred vocabulary exercise as Rust's.
//
// Dialects: one scanner, swappable word sets. Oracle implemented; mysql /
// mssql / postgres / duckdb are foreseen entries in SQL_DIALECTS (different
// keyword/builtin/quoting choices — e.g. mysql backtick identifiers, mssql
// [bracket] identifiers — land here, not in the scanner).
const TAG_CLASS_SQL = new Uint8Array(256).fill(KLASS.PUNCT);
TAG_CLASS_SQL[TAG_WS] = KLASS.WS;
TAG_CLASS_SQL[TAG_NL] = KLASS.WS;
TAG_CLASS_SQL[TAG_COMMENT] = KLASS.COMMENT;
TAG_CLASS_SQL[TAG_COMMENT_ML] = KLASS.COMMENT;
TAG_CLASS_SQL[0x7B] = KLASS.TAG;                // {  block opener (if/loop/case/begin)
TAG_CLASS_SQL[0x7D] = KLASS.TAG;                // }  END / END IF / END LOOP / END CASE
TAG_CLASS_SQL[0x6B] = KLASS.KEYWORD;            // k  keyword (generic byte; pool says which)
TAG_CLASS_SQL[0x42] = KLASS.BUILTIN;            // B  built-in function
TAG_CLASS_SQL[T.STRING_SQ] = KLASS.STRING;      // '  string ('' doubles as the escape)
TAG_CLASS_SQL[T.IDENT] = KLASS.IDENT;           // I  identifier (incl. "Quoted" ones)
TAG_CLASS_SQL[T.NUMBER] = KLASS.NUMBER;
TAG_CLASS_SQL[T.DOUBLE] = KLASS.NUMBER;
for (const ch of '!%&*+-/<=>?@^|~') TAG_CLASS_SQL[ch.charCodeAt(0)] = KLASS.OP;
for (const byte of OPS.values()) TAG_CLASS_SQL[byte] = KLASS.OP;
TAG_CLASS_SQL[OP_CONCAT] = KLASS.OP;
for (const b of [T.LPAREN, T.RPAREN, T.LBRACKET, T.RBRACKET]) TAG_CLASS_SQL[b] = KLASS.BRACKET;

// Python rides the JS class table (same keyword/literal/op bytes) plus the
// indent family.
const TAG_CLASS_PY = TAG_CLASS.slice();
TAG_CLASS_PY[TAG_INDENT] = KLASS.TAG;
TAG_CLASS_PY[TAG_DEDENT] = KLASS.TAG;

// YAML: indent family + per-language byte choices — '|' and '>' are STRING
// bytes here (a block scalar is a string whose delimiter is its indicator);
// '!' is the DECL byte ('---' / '...' document markers).
const TAG_CLASS_YAML = new Uint8Array(256).fill(KLASS.PUNCT);
TAG_CLASS_YAML[TAG_WS] = KLASS.WS;
TAG_CLASS_YAML[TAG_NL] = KLASS.WS;
TAG_CLASS_YAML[TAG_COMMENT] = KLASS.COMMENT;
TAG_CLASS_YAML[TAG_COMMENT_ML] = KLASS.COMMENT;
TAG_CLASS_YAML[TAG_INDENT] = KLASS.TAG;
TAG_CLASS_YAML[TAG_DEDENT] = KLASS.TAG;
TAG_CLASS_YAML[0x22] = KLASS.STRING;            // "double"
TAG_CLASS_YAML[0x27] = KLASS.STRING;            // 'single' ('' doubles)
TAG_CLASS_YAML[0x7C] = KLASS.STRING;            // |  literal block scalar
TAG_CLASS_YAML[0x3E] = KLASS.STRING;            // >  folded block scalar
TAG_CLASS_YAML[0x21] = KLASS.DECL;              // !  --- / ... document markers
TAG_CLASS_YAML[T.IDENT] = KLASS.IDENT;
TAG_CLASS_YAML[T.NUMBER] = KLASS.NUMBER;
TAG_CLASS_YAML[T.DOUBLE] = KLASS.NUMBER;
for (const b of [T.LPAREN, T.RPAREN, T.LBRACKET, T.RBRACKET, T.LBRACE, T.RBRACE]) {
  TAG_CLASS_YAML[b] = KLASS.BRACKET;            // flow style [a, b] {k: v}
}

// Block-byte keyword roles decoded back to their spelling for the mnemonic
// column, shared across every language — the OP_LITERAL move, one tier
// down (keywords, not operators). Populated below by PY_KEYWORDS and (later
// in the file) RUST_KEYWORDS.
const KW_LITERAL = {};

// Python keywords, the same 13e allocation discipline as Rust: same lexeme
// AND role as JS reuse the JS byte; role-grounded reuse where the SPELLING
// differs but the role matches (def/del/raise); one genuine free-letter fit
// left after Rust claimed mut/pub/struct (global -> 'g'); 'as' shares Rust's
// role byte (0xA7 — same spelling, the same "reinterpret as" family, same
// move as reusing JS bytes for near-but-not-identical semantics elsewhere);
// everything else Python-only takes a fresh 0x80+ block byte, decoded via
// KW_LITERAL. Soft keywords (match/case) stay identifiers — Python's own
// analog of Rust's weak `union`.
const PY_KEYWORDS = new Map([
  // same lexeme, same byte as JS
  ...['if', 'else', 'for', 'while', 'return', 'class', 'import', 'in',
    'try', 'finally', 'continue', 'break', 'yield', 'await', 'async']
    .map((w) => [w, KEYWORDS.get(w)]),
  // role-grounded
  ['def', 0x66],     // the function role ('f')
  ['del', 0x64],     // the delete role ('d')
  ['raise', 0x68],   // the throw role ('h')
  ['True', 0x54], ['False', 0x75], ['None', 0x30],
  // last free-letter fit after Rust's mut/pub/struct
  ['global', 0x67],  // g
  // shares Rust's 'as' role byte (0xA7) — same spelling, same family
  ['as', 0xA7],
  // Python-only roles, no free letter left — fresh block bytes
  ['and', 0xB7], ['or', 0xB8], ['not', 0xB9], ['is', 0xBA], ['from', 0xBB],
  ['with', 0xBC], ['lambda', 0xBD], ['nonlocal', 0xBE], ['assert', 0xBF],
  ['elif', 0xC0], ['except', 0xC1], ['pass', 0xC2],
]);
for (const [word, byte] of PY_KEYWORDS) if (byte >= 0x80) KW_LITERAL[byte] = word;
for (const byte of PY_KEYWORDS.values()) TAG_CLASS_PY[byte] = KLASS.KEYWORD;

const SQL_DIALECTS = {
  oracle: {
    // block structure: opener kinds; 'end' is handled specially (multi-word closer)
    openers: new Set(['if', 'loop', 'case', 'begin']),
    opRoles: SQL_OP_ROLES,   // spelling -> role byte (:= = <> != ^= ||)
    keywords: new Set([
      'select', 'from', 'where', 'insert', 'update', 'delete', 'into', 'values',
      'set', 'and', 'or', 'not', 'null', 'is', 'as', 'then', 'elsif', 'else',
      'when', 'declare', 'procedure', 'function', 'package', 'body', 'return',
      'cursor', 'type', 'exception', 'raise', 'exit', 'while', 'for', 'in',
      'commit', 'rollback', 'savepoint', 'grant', 'revoke', 'create', 'alter',
      'drop', 'replace', 'table', 'view', 'index', 'trigger', 'sequence',
      'union', 'all', 'distinct', 'group', 'by', 'having', 'order', 'asc',
      'desc', 'between', 'like', 'exists', 'join', 'left', 'right', 'inner',
      'outer', 'full', 'cross', 'on', 'using', 'connect', 'start', 'with',
      'fetch', 'open', 'close', 'bulk', 'collect', 'forall', 'pragma',
      'constant', 'default', 'out', 'nocopy', 'rownum', 'dual', 'true', 'false',
    ]),
    builtins: new Set([
      'nvl', 'nvl2', 'coalesce', 'decode', 'nullif', 'substr', 'instr',
      'length', 'upper', 'lower', 'initcap', 'trim', 'ltrim', 'rtrim', 'lpad',
      'rpad', 'replace', 'translate', 'concat', 'chr', 'ascii', 'to_date',
      'to_char', 'to_number', 'to_timestamp', 'cast', 'sysdate', 'systimestamp',
      'current_date', 'extract', 'add_months', 'months_between', 'last_day',
      'next_day', 'trunc', 'round', 'ceil', 'floor', 'abs', 'mod', 'power',
      'sqrt', 'sign', 'greatest', 'least', 'count', 'sum', 'avg', 'min', 'max',
      'listagg', 'row_number', 'rank', 'dense_rank', 'lag', 'lead',
      'regexp_like', 'regexp_substr', 'regexp_replace', 'regexp_instr', 'user',
    ]),
  },
  // mysql: {...}  mssql: {...}  postgres: {...}  duckdb: {...}   ← foreseen
};

const CLOSE_OF = { [T.LPAREN]: T.RPAREN, [T.LBRACKET]: T.RBRACKET, [T.LBRACE]: T.RBRACE };
const IS_OPEN  = new Set([T.LPAREN, T.LBRACKET, T.LBRACE]);
const IS_CLOSE = new Set([T.RPAREN, T.RBRACKET, T.RBRACE]);

const REGEX_PRECEDING_KW = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'yield', 'await', 'throw', 'case',
]);
const OP_CHARS = new Set(['=', '!', '<', '>', '&', '|', '^', '~', '+', '-', '*', '%', '/', '?', '@']);

function isWs(c)         { return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D; }
function isDigit(c)      { return c >= 0x30 && c <= 0x39; }
function isIdentStart(c) { return (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || c === 0x5F || c === 0x24 || c > 127; }
function isIdentPart(c)  { return isIdentStart(c) || isDigit(c); }

// Per-language scan options — the lexical-table idea (§2) arriving at the
// unified lexer: ONE scan loop, hooks per language, never a third copy of it.
const JS_OPTS = {
  keywords: KEYWORDS,    // lexeme → mnemonic byte (closed vocabulary)
  regex: true,           // /…/ literals via the prevValue gate
  templates: true,       // `…` literals
  charLifetimes: false,  // Rust ' handling (char literal vs lifetime)
  rawStrings: false,     // Rust r#"…"# (parameterised end) + r#ident
  nestedComments: false, // Rust /* /* */ */ — depth counter, not a flag
};

// Rust keywords, same 13e allocation rule as everywhere else — byte-per-role,
// never overload — worked in three tiers:
//   1. same lexeme AND same role as JS: reuse the JS byte outright (else,
//      false, for, if, in, let, return, true, while, break, continue, const,
//      async, await — plus static/super/try/typeof/yield/of, whose Rust
//      meaning differs somewhat from JS's but the SPELLING is the mnemonic,
//      same call already made for Python's 'in'/'or'/etc).
//   2. different spelling, matching ROLE: fn -> the function role (same
//      byte as JS's KW_FUNCTION AND Python's def — 'f' is the function
//      mnemonic across all three); self -> the receiver role (JS's KW_THIS).
//   3. Rust-only concepts, no JS role to borrow: three get a genuine free
//      ASCII letter with an unambiguous first-letter fit (mut/pub/struct —
//      the alphabet is otherwise fully claimed by JS's own keyword table);
//      everything else with no free legible letter takes a 0x80+ block byte,
//      decoded back to its spelling by KW_LITERAL for the mnemonic column —
//      the exact operator-role move (OP_LITERAL), applied to keywords
//      instead of operators, because the finite resource here is legible
//      ASCII, not byte VALUES (256 of those is plenty for one language's
//      keywords). 'as' (0xA7) is shared with Python's 'as' — same spelling,
//      same "reinterpret as" family, one byte for both languages.
// Left as plain IDENT on purpose: 'union' (a WEAK/contextual keyword — only
// special in one syntactic position, like Python's soft match/case) and the
// handful of reserved-for-future-use words that essentially never appear in
// real code (become, box, priv, unsized, abstract, final, override, macro).
const RUST_KEYWORDS = new Map([
  ...['else', 'false', 'for', 'if', 'in', 'let', 'return', 'static', 'super',
    'true', 'try', 'typeof', 'while', 'yield', 'async', 'await',
    'break', 'continue', 'const']
    .map((w) => [w, KEYWORDS.get(w)]),
  ['fn', KEYWORDS.get('function')],   // the function role
  ['self', KEYWORDS.get('this')],     // the receiver role
  ['mut', 0x6D], ['pub', 0x70], ['struct', 0x53],
  ['as', 0xA7], ['crate', 0xA8], ['dyn', 0xA9], ['enum', 0xAA],
  ['extern', 0xAB], ['impl', 0xAC], ['loop', 0xAD], ['match', 0xAE],
  ['mod', 0xAF], ['move', 0xB0], ['ref', 0xB1], ['Self', 0xB2],
  ['trait', 0xB3], ['type', 0xB4], ['use', 0xB5], ['where', 0xB6],
]);

for (const [word, byte] of RUST_KEYWORDS) if (byte >= 0x80) KW_LITERAL[byte] = word;

for (const byte of RUST_KEYWORDS.values()) TAG_CLASS[byte] = KLASS.KEYWORD;

const RUST_OPTS = {
  keywords: RUST_KEYWORDS,
  regex: false,
  templates: false,
  charLifetimes: true,
  rawStrings: true,
  nestedComments: true,
  hashAttr: true,        // '#' of #[derive(…)] is the ANNOTATION role — byte
                         // '@' (the C/JS-ground glyph: decorators/annotations).
                         // Without this the bare '#' would take byte 0x23,
                         // which the class table reads as COMMENT.
};

// JSON5 is JS's tokenize() with everything narrowed, never widened: the ONLY
// bare words are true/false/null (reusing JS's own bytes — no third meaning
// for T/u/0); no regex, no templates, no Rust hooks. Everything JSON5 is
// MORE permissive about than strict JSON — single-quoted strings, hex ints,
// // and /* */ comments, unquoted identifier keys, trailing commas — tokenize()
// already accepts unconditionally, so a plain-JSON file tokenizes identically
// under this table: JSON is a subset, not a separate mode. A stricter table
// that FLAGS the JSON5-only relaxations (rather than silently accepting them)
// is future work — a validation pass over this same tape, not a new lexer.
const JSON5_KEYWORDS = new Map([
  ['true',  T.KW_TRUE],
  ['false', T.KW_FALSE],
  ['null',  T.KW_NULL],
]);

const JSON5_OPTS = {
  keywords: JSON5_KEYWORDS,
  regex: false,
  templates: false,      // JSON5 strings are " or ' — never `
  charLifetimes: false,
  rawStrings: false,
  nestedComments: false,
};

class UniLexer {
  // JSON5 mode (also accepts plain JSON — see JSON5_OPTS above): object/array
  // brackets are the same char-matched family as JS's { } [ ], ':' and ','
  // are already punct, strings/numbers/comments already tolerant enough.
  // Object keys carry NO distinct byte from string values — "is this a key"
  // is purely positional (first of a pair inside '{', followed by ':'), which
  // a breadth-first visitor reads straight off the tape without the lexer
  // needing to overload anything for it.
  tokenizeJson5(src) {
    return this.tokenize(src, JSON5_OPTS);
  }
  // Rust mode: the §2a parameterised-end row in running code — raw strings
  // r"…" / r#"…"# / r##"…"## (closer = '"' + the CAPTURED hash count, no
  // escapes), raw identifiers r#match, byte/C-string prefixes b"…" br#"…"#
  // c"…" cr#"…"#, char literals 'x' vs lifetimes 'a, nested block comments.
  tokenizeRust(src) {
    return this.tokenize(src, RUST_OPTS);
  }

  tokenize(src, opts = JS_OPTS) {
    const len = src.length;
    const tp = this._tape();
    const emit = (tag, lexeme, off, depth) => tp.emit(tag, TAG_CLASS[tag], lexeme, off, depth);
    const { link } = tp;

    const stack = [];   // open brackets: { idx, tag }
    let depth = 0;
    let prevValue = false;
    let i = 0;

    while (i < len) {
      const start = i;
      const c = src.charCodeAt(i);
      let tag;
      let end;

      if (isWs(c)) {
        let j = i + 1; while (j < len && isWs(src.charCodeAt(j))) j++;
        // newline segments are their OWN tokens (TAG_NL); intra-line runs stay TAG_WS
        this._emitWs(emit, src, i, j, depth);
        i = j; continue;
      } else if (c === 0x2F && src.charCodeAt(i + 1) === 0x2F) {            // //
        let j = i + 2; while (j < len && src.charCodeAt(j) !== 0x0A) j++;
        end = j; tag = TAG_COMMENT;                                          // newline excluded
      } else if (c === 0x2F && src.charCodeAt(i + 1) === 0x2A) {            // /*
        let j;
        if (opts.nestedComments) {
          // Rust/D: block comments NEST — a depth counter, not a flag (§2a)
          let d = 1; j = i + 2;
          while (j < len && d > 0) {
            if (src.charCodeAt(j) === 0x2F && src.charCodeAt(j + 1) === 0x2A) { d++; j += 2; }
            else if (src.charCodeAt(j) === 0x2A && src.charCodeAt(j + 1) === 0x2F) { d--; j += 2; }
            else j++;
          }
          end = j;
        } else {
          j = i + 2; while (j < len && !(src.charCodeAt(j - 1) === 0x2A && src.charCodeAt(j) === 0x2F)) j++;
          end = Math.min(j + 1, len);
        }
        // newlines INSIDE a comment belong to the comment (C(n)); without, '#'
        tag = src.slice(i, end).includes('\n') ? TAG_COMMENT_ML : TAG_COMMENT;
      } else if (opts.charLifetimes && c === 0x27) {                         // Rust '
        // 'x' / '\n' are char literals (tag '); 'a / 'static are lifetimes
        // (ident-class — they NAME something). Decided by bounded peek:
        // ident-start after the quote with no closing quote right after it.
        const r = this._charOrLifetime(src, i);
        end = r.end; tag = r.lifetime ? T.IDENT : T.STRING_SQ;
      } else if (c === 0x22 || c === 0x27) {                                 // " '
        end = this._str(src, i, c); tag = c;   // tagged with its own quote
      } else if (opts.templates && c === 0x60) {                             // `
        end = this._tmpl(src, i); tag = T.TEMPLATE;
      } else if (opts.regex && c === 0x2F && !prevValue && (end = this._regex(src, i)) !== -1) {
        tag = T.REGEX;
      } else if (isDigit(c) || (c === 0x2E && isDigit(src.charCodeAt(i + 1)))) {
        end = this._num(src, i);
        const lex = src.slice(i, end);
        // N = integer (incl. 0x/0b/0o/BigInt), D = float (decimal point / exponent)
        tag = (/^0[xXbBoO]/.test(lex) || !/[.eE]/.test(lex)) ? T.NUMBER : T.DOUBLE;
      } else if (isIdentStart(c)) {
        let j = i + 1; while (j < len && isIdentPart(src.charCodeAt(j))) j++;
        const word = src.slice(i, j);
        // Rust raw strings / raw idents: the ident scan ALREADY stopped at the
        // '#' or '"', so the decision point needs no backtracking — a bounded
        // forward peek from here (the parameterised-end row of §2a).
        if (opts.rawStrings && (word === 'r' || word === 'b' || word === 'br' || word === 'c' || word === 'cr')) {
          const r = this._rawOpen(src, j, word);
          if (r) { end = r.end; tag = r.tag; }
          else { end = j; tag = opts.keywords.get(word) ?? T.IDENT; }
        } else {
          end = j;
          tag = opts.keywords.get(word) ?? T.IDENT;
        }
      } else if (TAG_CLASS[c] === KLASS.BRACKET) {
        end = i + 1; tag = c;
      } else if (c === 0x3B || c === 0x2C || c === 0x3A) {                   // ; , :
        end = i + 1; tag = c;
      } else if (c === 0x2E) {                                               // . (incl. ...)
        if (src.charCodeAt(i + 1) === 0x2E && src.charCodeAt(i + 2) === 0x2E) { end = i + 3; tag = OPS.get('...'); }
        else { end = i + 1; tag = T.DOT; }
      } else if (OP_CHARS.has(src[i])) {
        // every operator gets its OWN byte: longest match against the OPS
        // table (maximal munch per OPERATOR, not per run — 'a=+b' is '=' then
        // '+'). Multi-char ops take their 0x80+ byte; single chars their ASCII.
        let oplen = 1;
        for (const l of [4, 3, 2]) {
          if (i + l <= len && OPS.has(src.slice(i, i + l))) { oplen = l; break; }
        }
        end = i + oplen;
        // singles route through OPS too: '&' / '|' are the BITWISE roles and
        // live in the block now (0x26/0x7C carry logical && / ||)
        tag = OPS.get(src.slice(i, end)) ?? c;
      } else if (opts.hashAttr && c === 0x23) {
        // Rust attribute hash: the ANNOTATION role, ground glyph '@' —
        // 0x23 is the comment-role byte and must not be emitted as punct
        end = i + 1; tag = 0x40;
      } else {
        end = i + 1; tag = c < 128 ? c : T.OP;   // bare ASCII punct keeps its own byte
      }

      const lexeme = src.slice(start, end);
      const klass = TAG_CLASS[tag];

      // structural layer: brackets get depth + tolerant partner links
      let idx;
      if (klass === KLASS.BRACKET) {
        if (IS_OPEN.has(tag)) {
          idx = emit(tag, lexeme, start, depth);
          stack.push({ idx, tag });
          depth++;
        } else {
          depth = depth > 0 ? depth - 1 : 0;
          idx = emit(tag, lexeme, start, depth);
          const top = stack[stack.length - 1];
          if (top && CLOSE_OF[top.tag] === tag) {
            stack.pop();
            link(top.idx, idx);
          }
          // mismatch / orphan: link stays -1 — tolerant, reported via repairMap
        }
      } else {
        idx = emit(tag, lexeme, start, depth);
      }

      // regex gate: trivia is transparent, keywords mostly end value position
      if (klass === KLASS.WS || klass === KLASS.COMMENT) { /* keep prevValue */ }
      else if (klass === KLASS.KEYWORD) prevValue = !REGEX_PRECEDING_KW.has(lexeme);
      else if (klass === KLASS.BRACKET) prevValue = (tag === T.RPAREN || tag === T.RBRACKET);
      else if (klass === KLASS.OP || klass === KLASS.PUNCT) prevValue = false;
      else prevValue = true;

      i = end;
    }

    return tp.finish(this, src, TAG_CLASS, false);
  }

  // ── XML mode — same uniform tape, structural-role mnemonics ───────────────
  // Open tag token = `<name` (byte '{', value = interned NAME); close tag =
  // `</name` (byte '}', same name pool). Inside a tag, attributes tokenize as
  // ident/op/string and '>' / '/>' as punct. Outside, text runs are one TEXT
  // token (whitespace-only runs are WS). Tag pairs are name-matched onto the
  // link array, tolerantly (no fault on improper nesting or orphans).
  tokenizeXml(src) {
    const len = src.length;
    const tp = this._tape();
    const { emit, link } = tp;

    const isNameChar = (c) => (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) ||
      (c >= 0x30 && c <= 0x39) || c === 0x2D || c === 0x5F || c === 0x3A || c === 0x2E;

    const stack = [];   // open tags: { idx, poolIdx }
    let depth = 0;
    let inTag = false;
    let i = 0;

    while (i < len) {
      const start = i;
      const c = src.charCodeAt(i);

      if (!inTag) {
        if (c === 0x3C) {                                            // '<'
          if (src.startsWith('<!--', i)) {
            let j = i + 4; while (j < len && !src.startsWith('-->', j)) j++;
            j = Math.min(j + 3, len);
            const cmt = src.slice(start, j);
            emit(cmt.includes('\n') ? TAG_COMMENT_ML : TAG_COMMENT, KLASS.COMMENT, cmt, start, depth);
            i = j; continue;
          }
          if (src.startsWith('<![CDATA[', i)) {
            let j = i + 9; while (j < len && !src.startsWith(']]>', j)) j++;
            j = Math.min(j + 3, len);
            emit(0x21, KLASS.DECL, src.slice(start, j), start, depth);
            i = j; continue;
          }
          if (src.startsWith('<?', i) || src.startsWith('<!', i)) {
            let j = i + 2; let q = 0;
            while (j < len) {                                        // to '>' honoring quotes
              const cj = src.charCodeAt(j);
              if (q) { if (cj === q) q = 0; }
              else if (cj === 0x22 || cj === 0x27) q = cj;
              else if (cj === 0x3E) { j++; break; }
              j++;
            }
            emit(0x21, KLASS.DECL, src.slice(start, j), start, depth);
            i = j; continue;
          }
          const isClose = src.charCodeAt(i + 1) === 0x2F;            // '</'
          let j = i + (isClose ? 2 : 1);
          const nameStart = j;
          while (j < len && isNameChar(src.charCodeAt(j))) j++;
          const name = src.slice(nameStart, j);
          if (!name) {                                               // bare '<' — punct
            emit(0x3C, KLASS.PUNCT, '<', start, depth);
            i++; continue;
          }
          // attribute-less complete self-closing tag <br/> — ONE token, self-linked
          if (!isClose && src.charCodeAt(j) === 0x2F && src.charCodeAt(j + 1) === 0x3E) {
            const idx = emit(0x2F, KLASS.TAG, name, start, depth);   // '/'
            link(idx, idx);
            i = j + 2; continue;
          }
          if (isClose) {
            depth = depth > 0 ? depth - 1 : 0;
            const idx = emit(0x7D, KLASS.TAG, name, start, depth);   // '}'
            // tolerant name-match: nearest open with the same pool slot
            for (let s = stack.length - 1; s >= 0; s--) {
              if (stack[s].poolIdx === tp.poolOf(idx)) {
                link(stack[s].idx, idx);
                stack.splice(s, 1);
                break;
              }
            }
          } else {
            const idx = emit(0x7B, KLASS.TAG, name, start, depth);   // '{'
            stack.push({ idx, poolIdx: tp.poolOf(idx) });
            depth++;
          }
          // '>' directly after the name (no attributes): the closing separator
          // belongs to the tag — <catalog> is ONE token. The token's span
          // includes the '>' (rawOf reads spans), so losslessness holds.
          if (src.charCodeAt(j) === 0x3E) { i = j + 1; continue; }
          i = j; inTag = true; continue;
        }
        // text run up to the next '<'; whitespace-only runs split into
        // newline/intra-line tokens like everywhere else
        let j = i; while (j < len && src.charCodeAt(j) !== 0x3C) j++;
        const run = src.slice(start, j);
        if (/^\s+$/.test(run)) this._emitWs((tg, lx, of, d) => emit(tg, KLASS.WS, lx, of, d), src, start, j, depth);
        else emit(0x54, KLASS.TEXT, run, start, depth);              // 'T'
        i = j; continue;
      }

      // inside a tag: attributes until '>' or '/>'
      if (c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D) {
        let j = i + 1; while (j < len && /\s/.test(src[j])) j++;
        this._emitWs((tg, lx, of, d) => emit(tg, KLASS.WS, lx, of, d), src, start, j, depth);
        i = j; continue;
      }
      if (c === 0x22 || c === 0x27) {                                // attr value
        let j = i + 1; while (j < len && src.charCodeAt(j) !== c) j++;
        j = Math.min(j + 1, len);
        emit(c, KLASS.STRING, src.slice(start, j), start, depth);   // its own quote
        i = j; continue;
      }
      if (c === 0x3E) {                                              // '>'
        emit(0x3E, KLASS.PUNCT, '>', start, depth);
        i++; inTag = false; continue;
      }
      if (c === 0x2F && src.charCodeAt(i + 1) === 0x3E) {            // '/>' self-close
        depth = depth > 0 ? depth - 1 : 0;
        const idx = emit(0x3E, KLASS.PUNCT, '/>', start, depth);
        const top = stack.pop();
        if (top) link(top.idx, idx);
        i += 2; inTag = false; continue;
      }
      if (isNameChar(c)) {                                           // attr name
        let j = i + 1; while (j < len && isNameChar(src.charCodeAt(j))) j++;
        emit(T.IDENT, KLASS.IDENT, src.slice(start, j), start, depth);
        i = j; continue;
      }
      if (c === 0x3D) { emit(T.OP, KLASS.OP, '=', start, depth); i++; continue; }
      emit(c < 128 ? c : T.OP, KLASS.PUNCT, src[i], start, depth);
      i++;
    }

    return tp.finish(this, src, TAG_CLASS_XML, true);
  }

  // Split a whitespace run [from,to) into NEWLINE tokens (TAG_NL — each
  // maximal run of CR-LF chars) and intra-line runs (TAG_WS). The newline is a line
  // signal; the indent that follows is its own token.
  _emitWs(emit, src, from, to, depth) {
    let i = from;
    while (i < to) {
      const nl0 = src.charCodeAt(i) === 0x0A || src.charCodeAt(i) === 0x0D;
      let j = i + 1;
      while (j < to) {
        const cj = src.charCodeAt(j);
        if ((cj === 0x0A || cj === 0x0D) !== nl0) break;
        j++;
      }
      emit(nl0 ? TAG_NL : TAG_WS, src.slice(i, j), i, depth);
      i = j;
    }
  }

  // Shared tape builder — every mode (tokenize/tokenizeXml/tokenizeSql/
  // tokenizePy/tokenizeYaml) routes through this one emit/link/finish trio.
  _tape() {
    const pools = KLASS_NAME.map(() => []);
    const internMaps = KLASS_NAME.map((_, k) => (INTERNED.has(k) ? new Map() : null));
    let cap = 1024;
    let tagArr = new Uint8Array(cap);
    let poolArr = new Uint32Array(cap);
    let offArr = new Uint32Array(cap);
    let linkArr = new Int32Array(cap).fill(-1);
    let depthArr = new Uint32Array(cap);
    let n = 0;
    const grow = () => {
      cap *= 2;
      const a = new Uint8Array(cap); a.set(tagArr); tagArr = a;
      const b = new Uint32Array(cap); b.set(poolArr); poolArr = b;
      const c = new Uint32Array(cap); c.set(offArr); offArr = c;
      const d = new Int32Array(cap).fill(-1); d.set(linkArr.subarray(0, n)); linkArr = d;
      const e = new Uint32Array(cap); e.set(depthArr); depthArr = e;
    };
    const addToPool = (klass, lexeme, off) => {
      const pool = pools[klass];
      if (INTERNED.has(klass)) {
        const m = internMaps[klass];
        let idx = m.get(lexeme);
        if (idx === undefined) { idx = pool.length; pool.push({ lexeme, occ: [] }); m.set(lexeme, idx); }
        pool[idx].occ.push(off);
        return idx;
      }
      const idx = pool.length;
      pool.push({ lexeme, off });
      return idx;
    };
    const emit = (tag, klass, lexeme, off, depth) => {
      if (n >= cap) grow();
      tagArr[n] = tag;
      poolArr[n] = addToPool(klass, lexeme, off);
      offArr[n] = off;
      linkArr[n] = -1;
      depthArr[n] = depth;
      return n++;
    };
    const link = (a, b) => { linkArr[a] = b; linkArr[b] = a; };
    const poolOf = (t) => poolArr[t];
    const finish = (self, src, classTable, spanRaw) =>
      self._result(src, tagArr, poolArr, offArr, linkArr, depthArr, n, pools, classTable, spanRaw);
    return { emit, link, poolOf, finish };
  }

  // ── Python mode — the INDENTATION bracket family ───────────────────────────
  // Indentation IS the structure (depth is literally the column): a deeper
  // line opens TAG_INDENT, a shallower one closes with TAG_DEDENT — zero-width
  // tokens at the line's content start, linked like any bracket pair. Inside
  // ( [ { the family is suppressed (implicit line joining, the CPython rule);
  // blank and comment-only lines change nothing. EOF closes what's open —
  // a Python file always dedents implicitly. Tabs count to the next multiple
  // of 8 (the CPython tabstop).
  tokenizePy(src) {
    const tp = this._tape();
    const { emit, link } = tp;
    const len = src.length;
    const indents = [0];
    const indentTok = [];
    const brStack = [];     // ( [ { — real brackets, also suppress the family
    let depth = 0;
    let atLineStart = true;
    let i = 0;

    const PYPFX = /^[rRbBuUfF]{1,2}$/;
    const emitWsRun = (from, to) =>
      this._emitWs((tg, lx, of, dp) => emit(tg, KLASS.WS, lx, of, dp), src, from, to, depth);

    while (i < len) {
      let c = src.charCodeAt(i);

      if (atLineStart && brStack.length === 0) {
        let j = i; let col = 0;
        while (j < len) {
          const cj = src.charCodeAt(j);
          if (cj === 0x20) col += 1;
          else if (cj === 0x09) col += 8 - (col % 8);
          else break;
          j++;
        }
        if (j > i) emitWsRun(i, j);
        i = j;
        if (i >= len) break;
        c = src.charCodeAt(i);
        if (c !== 0x0A && c !== 0x0D && c !== 0x23) {     // real content
          if (col > indents[indents.length - 1]) {
            indents.push(col);
            const idx = emit(TAG_INDENT, KLASS.TAG, '', i, depth);
            indentTok.push(idx);
            depth++;
          } else {
            while (indents.length > 1 && col < indents[indents.length - 1]) {
              indents.pop();
              depth = depth > 0 ? depth - 1 : 0;
              const idx = emit(TAG_DEDENT, KLASS.TAG, '', i, depth);
              const open = indentTok.pop();
              if (open !== undefined) link(open, idx);
            }
          }
        }
        atLineStart = false;
        continue;
      }

      const start = i;
      if (isWs(c)) {
        let j = i + 1; while (j < len && isWs(src.charCodeAt(j))) j++;
        // stop AFTER the last newline: the next line's leading indent must be
        // left for the line-start branch to measure
        const run = src.slice(i, j);
        const lastNl = Math.max(run.lastIndexOf('\n'), run.lastIndexOf('\r'));
        if (lastNl !== -1) {
          j = i + lastNl + 1;
          atLineStart = true;
        }
        emitWsRun(i, j);
        i = j; continue;
      }
      if (c === 0x23) {                                       // # comment
        let j = i + 1; while (j < len && src.charCodeAt(j) !== 0x0A) j++;
        emit(TAG_COMMENT, KLASS.COMMENT, src.slice(start, j), start, depth);
        i = j; continue;
      }
      if (c === 0x22 || c === 0x27) {                         // strings (no prefix)
        i = this._pyString(src, i, c, start, depth, emit);
        continue;
      }
      if (isDigit(c) || (c === 0x2E && isDigit(src.charCodeAt(i + 1)))) {
        const end = this._num(src, i);
        const lex = src.slice(start, end);
        emit(/[.eE]/.test(lex) && !/^0[xXbBoO]/.test(lex) ? T.DOUBLE : T.NUMBER, KLASS.NUMBER, lex, start, depth);
        i = end; continue;
      }
      if (isIdentStart(c)) {
        let j = i + 1; while (j < len && isIdentPart(src.charCodeAt(j))) j++;
        const word = src.slice(i, j);
        const q = j < len ? src.charCodeAt(j) : -1;
        if (PYPFX.test(word) && (q === 0x22 || q === 0x27)) { // r'…' b"…" f'…'
          i = this._pyString(src, j, q, start, depth, emit);
          continue;
        }
        const kw = PY_KEYWORDS.get(word);
        emit(kw ?? T.IDENT, kw ? KLASS.KEYWORD : KLASS.IDENT, word, start, depth);
        i = j; continue;
      }
      if (TAG_CLASS[c] === KLASS.BRACKET) {                   // ( [ { ) ] }
        if (c === 0x28 || c === 0x5B || c === 0x7B) {
          const idx = emit(c, KLASS.BRACKET, src[i], start, depth);
          brStack.push({ idx, close: CLOSE_OF[c] });
          depth++;
        } else {
          depth = depth > 0 ? depth - 1 : 0;
          const idx = emit(c, KLASS.BRACKET, src[i], start, depth);
          const top = brStack[brStack.length - 1];
          if (top && top.close === c) { brStack.pop(); link(top.idx, idx); }
        }
        i++; continue;
      }
      if (c === 0x3A && src.charCodeAt(i + 1) === 0x3D) {     // := walrus — assignment role
        emit(0x3D, KLASS.OP, ':=', start, depth);
        i += 2; continue;
      }
      if (c === 0x2D && src.charCodeAt(i + 1) === 0x3E) {     // -> — the arrow role
        emit(0x8D, KLASS.OP, '->', start, depth);
        i += 2; continue;
      }
      if (OP_CHARS.has(src[i])) {
        let oplen = 1;
        for (const l of [3, 2]) {
          if (i + l <= len && OPS.has(src.slice(i, i + l))) { oplen = l; break; }
        }
        const lex = src.slice(i, i + oplen);
        emit(OPS.get(lex) ?? c, KLASS.OP, lex, start, depth);
        i += oplen; continue;
      }
      emit(c < 128 ? c : T.OP, KLASS.PUNCT, src[i], start, depth);
      i++;
    }
    while (indents.length > 1) {                              // implicit EOF dedents
      indents.pop();
      depth = depth > 0 ? depth - 1 : 0;
      const idx = emit(TAG_DEDENT, KLASS.TAG, '', len, depth);
      const open = indentTok.pop();
      if (open !== undefined) link(open, idx);
    }
    return tp.finish(this, src, TAG_CLASS_PY, true);
  }

  // Python string from its quote char (prefix already consumed into start):
  // triple-quoted is multiline; single-quoted is newline-bounded. The escape
  // skip is the same for raw strings (a backslash still defuses a closer).
  _pyString(src, qpos, quote, start, depth, emit) {
    const len = src.length;
    const triple = src.charCodeAt(qpos + 1) === quote && src.charCodeAt(qpos + 2) === quote;
    let j = qpos + (triple ? 3 : 1);
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === 0x5C) { j += 2; continue; }
      if (triple) {
        if (c === quote && src.charCodeAt(j + 1) === quote && src.charCodeAt(j + 2) === quote) { j += 3; break; }
      } else {
        if (c === 0x0A) break;                                 // newline-bounded
        if (c === quote) { j++; break; }
      }
      j++;
    }
    j = Math.min(j, len);
    emit(quote, KLASS.STRING, src.slice(start, j), start, depth);
    return j;
  }

  // ── YAML mode — indent family + linter-grade scalars ───────────────────────
  // '#' comments (line start or after whitespace), both quote styles ('' is
  // the single-quote escape), '---' / '...' document markers (DECL — they also
  // close all open indent levels), block scalars '|' / '>' consumed as ONE
  // string token whose end is the dedent (an indentation-parameterised end),
  // flow brackets [ ] { } linked, plain words as identifiers.
  tokenizeYaml(src) {
    const tp = this._tape();
    const { emit, link } = tp;
    const len = src.length;
    const indents = [0];
    const indentTok = [];
    const brStack = [];
    let depth = 0;
    let atLineStart = true;
    let lineCol = 0;
    let i = 0;

    const emitWsRun = (from, to) =>
      this._emitWs((tg, lx, of, dp) => emit(tg, KLASS.WS, lx, of, dp), src, from, to, depth);
    const closeAll = (at) => {
      while (indents.length > 1) {
        indents.pop();
        depth = depth > 0 ? depth - 1 : 0;
        const idx = emit(TAG_DEDENT, KLASS.TAG, '', at, depth);
        const open = indentTok.pop();
        if (open !== undefined) link(open, idx);
      }
    };
    const isWordChar = (c) => isIdentPart(c) || c === 0x2D || c === 0x2E || c === 0x2F;

    while (i < len) {
      let c = src.charCodeAt(i);

      if (atLineStart && brStack.length === 0) {
        let j = i; let col = 0;
        while (j < len && src.charCodeAt(j) === 0x20) { col++; j++; }
        if (j > i) emitWsRun(i, j);
        i = j;
        if (i >= len) break;
        c = src.charCodeAt(i);
        if (c !== 0x0A && c !== 0x0D && c !== 0x23) {
          if ((src.startsWith('---', i) || src.startsWith('...', i))
              && (i + 3 >= len || isWs(src.charCodeAt(i + 3)))) {
            closeAll(i);                                       // marker resets structure
            emit(0x21, KLASS.DECL, src.slice(i, i + 3), i, depth);
            i += 3; lineCol = 0; atLineStart = false; continue;
          }
          if (col > indents[indents.length - 1]) {
            indents.push(col);
            const idx = emit(TAG_INDENT, KLASS.TAG, '', i, depth);
            indentTok.push(idx);
            depth++;
          } else {
            while (indents.length > 1 && col < indents[indents.length - 1]) {
              indents.pop();
              depth = depth > 0 ? depth - 1 : 0;
              const idx = emit(TAG_DEDENT, KLASS.TAG, '', i, depth);
              const open = indentTok.pop();
              if (open !== undefined) link(open, idx);
            }
          }
          lineCol = col;
        }
        atLineStart = false;
        continue;
      }

      const start = i;
      if (isWs(c)) {
        let j = i + 1; while (j < len && isWs(src.charCodeAt(j))) j++;
        // stop AFTER the last newline: the next line's leading indent must be
        // left for the line-start branch to measure
        const run = src.slice(i, j);
        const lastNl = Math.max(run.lastIndexOf('\n'), run.lastIndexOf('\r'));
        if (lastNl !== -1) {
          j = i + lastNl + 1;
          atLineStart = true;
        }
        emitWsRun(i, j);
        i = j; continue;
      }
      if (c === 0x23) {                                        // comment (post-ws by loop shape)
        let j = i + 1; while (j < len && src.charCodeAt(j) !== 0x0A) j++;
        emit(TAG_COMMENT, KLASS.COMMENT, src.slice(start, j), start, depth);
        i = j; continue;
      }
      if (c === 0x27) {                                        // 'single' — '' escape
        const end = this._sqlStr(src, i);
        emit(0x27, KLASS.STRING, src.slice(start, end), start, depth);
        i = end; continue;
      }
      if (c === 0x22) {                                        // "double" — backslash escape
        let j = i + 1;
        while (j < len && src.charCodeAt(j) !== 0x22) { if (src.charCodeAt(j) === 0x5C) j++; j++; }
        j = Math.min(j + 1, len);
        emit(0x22, KLASS.STRING, src.slice(start, j), start, depth);
        i = j; continue;
      }
      if ((c === 0x7C || c === 0x3E)) {                        // | or > block scalar
        let j = i + 1;
        while (j < len && /[+\-0-9]/.test(src[j])) j++;        // chomping/indent modifiers
        let k = j; while (k < len && (src.charCodeAt(k) === 0x20 || src.charCodeAt(k) === 0x09)) k++;
        const atEol = k >= len || src.charCodeAt(k) === 0x0A || src.charCodeAt(k) === 0x0D;
        if (atEol) {
          // consume following lines while blank or indented deeper than lineCol
          let p = k;
          for (;;) {
            // advance past the newline of the current line
            while (p < len && src.charCodeAt(p) !== 0x0A) p++;
            if (p >= len) break;
            p++;                                               // past the newline
            // measure next line
            let q = p; let col = 0;
            while (q < len && src.charCodeAt(q) === 0x20) { col++; q++; }
            const ch = q < len ? src.charCodeAt(q) : -1;
            if (ch === -1) { p = len; break; }
            if (ch === 0x0A || ch === 0x0D) { p = q; continue; }   // blank line — keep going
            if (col > lineCol) { p = q; continue; }                // body line — keep going
            p = p - 1; break;                                      // dedent: scalar ended before this line's newline... keep the newline outside
          }
          const end = Math.min(Math.max(p, k), len);
          emit(c, KLASS.STRING, src.slice(start, end), start, depth);
          i = end; continue;
        }
        emit(c < 128 ? c : T.OP, KLASS.PUNCT, src[i], start, depth);
        i++; continue;
      }
      if (TAG_CLASS_YAML[c] === KLASS.BRACKET) {               // flow style
        if (c === 0x28 || c === 0x5B || c === 0x7B) {
          const idx = emit(c, KLASS.BRACKET, src[i], start, depth);
          brStack.push({ idx, close: CLOSE_OF[c] });
          depth++;
        } else {
          depth = depth > 0 ? depth - 1 : 0;
          const idx = emit(c, KLASS.BRACKET, src[i], start, depth);
          const top = brStack[brStack.length - 1];
          if (top && top.close === c) { brStack.pop(); link(top.idx, idx); }
        }
        i++; continue;
      }
      if (isDigit(c)) {
        const end = this._num(src, i);
        const lex = src.slice(start, end);
        emit(/[.eE]/.test(lex) ? T.DOUBLE : T.NUMBER, KLASS.NUMBER, lex, start, depth);
        i = end; continue;
      }
      if (isIdentStart(c)) {                                   // plain scalar word
        let j = i + 1; while (j < len && isWordChar(src.charCodeAt(j))) j++;
        emit(T.IDENT, KLASS.IDENT, src.slice(start, j), start, depth);
        i = j; continue;
      }
      emit(c < 128 ? c : T.OP, KLASS.PUNCT, src[i], start, depth);  // : - & * ! ? , …
      i++;
    }
    closeAll(len);
    return tp.finish(this, src, TAG_CLASS_YAML, true);
  }

  // ── SQL / PL-SQL mode — keyword-matched block family, dialect word sets ────
  tokenizeSql(src, dialect = 'oracle') {
    const d = SQL_DIALECTS[dialect];
    if (!d) throw new Error(`unknown SQL dialect '${dialect}' (have: ${Object.keys(SQL_DIALECTS).join(', ')})`);
    const len = src.length;
    const tp = this._tape();
    const { emit, link } = tp;

    const kwStack = [];     // open block keywords: { idx, kindId }  (name-matched)
    const brStack = [];     // ( [ parens/brackets (LIFO)
    let depth = 0;
    let i = 0;

    const isSqlIdentStart = (c) => isIdentStart(c);
    const isSqlIdentPart = (c) => isIdentPart(c) || c === 0x24;   // $ in Oracle idents

    while (i < len) {
      const start = i;
      const c = src.charCodeAt(i);

      if (isWs(c)) {
        let j = i + 1; while (j < len && isWs(src.charCodeAt(j))) j++;
        this._emitWs((tg, lx, of, dp) => emit(tg, KLASS.WS, lx, of, dp), src, i, j, depth);
        i = j; continue;
      }
      if (c === 0x2D && src.charCodeAt(i + 1) === 0x2D) {           // -- line comment
        let j = i + 2; while (j < len && src.charCodeAt(j) !== 0x0A) j++;
        emit(TAG_COMMENT, KLASS.COMMENT, src.slice(start, j), start, depth);
        i = j; continue;
      }
      if (c === 0x2F && src.charCodeAt(i + 1) === 0x2A) {           // /* … */ (non-nested)
        let j = i + 2; while (j < len && !(src.charCodeAt(j - 1) === 0x2A && src.charCodeAt(j) === 0x2F)) j++;
        j = Math.min(j + 1, len);
        const cmt = src.slice(start, j);
        emit(cmt.includes(String.fromCharCode(0x0A)) ? TAG_COMMENT_ML : TAG_COMMENT, KLASS.COMMENT, cmt, start, depth);
        i = j; continue;
      }
      if (c === 0x27) {                                             // '…' — '' is the escape
        const end = this._sqlStr(src, i);
        emit(T.STRING_SQ, KLASS.STRING, src.slice(start, end), start, depth);
        i = end; continue;
      }
      if (c === 0x22) {                                             // "Quoted" IDENTIFIER (not a string)
        let j = i + 1; while (j < len && src.charCodeAt(j) !== 0x22) j++;
        j = Math.min(j + 1, len);
        emit(T.IDENT, KLASS.IDENT, src.slice(start, j), start, depth);
        i = j; continue;
      }
      if (isDigit(c) || (c === 0x2E && isDigit(src.charCodeAt(i + 1)))) {
        const end = this._num(src, i);
        const lex = src.slice(start, end);
        emit(/[.eE]/.test(lex) ? T.DOUBLE : T.NUMBER, KLASS.NUMBER, lex, start, depth);
        i = end; continue;
      }
      if (isSqlIdentStart(c)) {
        let j = i + 1; while (j < len && isSqlIdentPart(src.charCodeAt(j))) j++;
        const word = src.slice(i, j);
        const lower = word.toLowerCase();

        // q'[…]' — Oracle's parameterised-delimiter string (q-quoting)
        if ((lower === 'q' || lower === 'nq') && src.charCodeAt(j) === 0x27) {
          const end = this._qQuote(src, i, j);
          emit(T.STRING_SQ, KLASS.STRING, src.slice(start, end), start, depth);
          i = end; continue;
        }

        if (lower === 'end') {
          // the multi-word closer: END [IF|LOOP|CASE] — TWO keywords, ONE '}'
          let k = j; while (k < len && isWs(src.charCodeAt(k))) k++;
          let k2 = k; while (k2 < len && isSqlIdentPart(src.charCodeAt(k2))) k2++;
          const next = src.slice(k, k2).toLowerCase();
          let kind = null; let end = j;
          if (next === 'if' || next === 'loop' || next === 'case') { kind = next; end = k2; }
          depth = depth > 0 ? depth - 1 : 0;
          // emit the closer; value = the kind it closes (or the popped opener's kind)
          let closes = kind;
          let openAt = -1;
          if (kind) {
            for (let s = kwStack.length - 1; s >= 0; s--) {
              if (kwStack[s].kind === kind) { openAt = kwStack[s].idx; kwStack.splice(s, 1); break; }
            }
          } else if (kwStack.length) {
            const top = kwStack.pop();              // plain END: nearest opener, any kind
            closes = top.kind; openAt = top.idx;
          }
          const idx = emit(0x7D, KLASS.TAG, closes ?? 'end', start, depth);
          if (openAt !== -1) link(openAt, idx);
          i = end; continue;
        }

        if (d.openers.has(lower)) {                 // IF / LOOP / CASE / BEGIN → '{'
          const idx = emit(0x7B, KLASS.TAG, lower, start, depth);
          kwStack.push({ idx, kind: lower });
          depth++;
          i = j; continue;
        }

        // the split: keyword vs builtin vs plain identifier. A word in BOTH
        // sets (e.g. REPLACE) is a builtin when a '(' follows, else a keyword.
        let p = j; while (p < len && (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)) p++;
        const calls = src.charCodeAt(p) === 0x28;
        if (d.builtins.has(lower) && (calls || !d.keywords.has(lower))) {
          emit(0x42, KLASS.BUILTIN, word, start, depth);             // B
        } else if (d.keywords.has(lower)) {
          emit(0x6B, KLASS.KEYWORD, word, start, depth);             // k
        } else {
          emit(T.IDENT, KLASS.IDENT, word, start, depth);            // I
        }
        i = j; continue;
      }
      if (c === 0x28 || c === 0x5B) {                               // ( [
        const idx = emit(c, KLASS.BRACKET, src[i], start, depth);
        brStack.push({ idx, close: c === 0x28 ? 0x29 : 0x5D });
        depth++;
        i++; continue;
      }
      if (c === 0x29 || c === 0x5D) {                               // ) ]
        depth = depth > 0 ? depth - 1 : 0;
        const idx = emit(c, KLASS.BRACKET, src[i], start, depth);
        const top = brStack[brStack.length - 1];
        if (top && top.close === c) {
          brStack.pop();
          link(top.idx, idx);
        }
        i++; continue;
      }
      if (c === 0x3A && src.charCodeAt(i + 1) === 0x3D) {           // := — assignment ROLE
        emit(d.opRoles.get(':='), KLASS.OP, ':=', start, depth);
        i += 2; continue;
      }
      if (c === 0x2E && src.charCodeAt(i + 1) === 0x2E) {           // .. range
        emit(OPS.get('..'), KLASS.OP, '..', start, depth);
        i += 2; continue;
      }
      if (OP_CHARS.has(src[i])) {                                   // ops, longest match
        // dialect spellings resolve to ROLE bytes first (= -> equality,
        // <> / ^= -> not-equal, || -> concat), then the shared registry
        let oplen = 1;
        for (const l of [3, 2]) {
          const cand = src.slice(i, i + l);
          if (i + l <= len && (d.opRoles.has(cand) || OPS.has(cand))) { oplen = l; break; }
        }
        const lex = src.slice(i, i + oplen);
        emit(d.opRoles.get(lex) ?? OPS.get(lex) ?? c, KLASS.OP, lex, start, depth);
        i += oplen; continue;
      }
      emit(c < 128 ? c : T.OP, KLASS.PUNCT, src[i], start, depth);  // ; , . : @ %…
      i++;
    }

    return tp.finish(this, src, TAG_CLASS_SQL, true);
  }

  // Oracle string: '…' where '' (doubled quote) is the escape; may span lines.
  _sqlStr(src, i) {
    const len = src.length;
    let j = i + 1;
    while (j < len) {
      if (src.charCodeAt(j) === 0x27) {
        if (src.charCodeAt(j + 1) === 0x27) { j += 2; continue; }   // '' — escaped quote
        return j + 1;
      }
      j++;
    }
    return len;   // unterminated: token to EOF (start is honest)
  }

  // Oracle q-quoting: q'X…X' where X is a chosen delimiter; the bracket pairs
  // ( [ { < close with their partners. Another §2a parameterised end.
  _qQuote(src, i, quotePos) {
    const len = src.length;
    const open = src.charCodeAt(quotePos + 1);
    const PAIR = { 0x28: 0x29, 0x5B: 0x5D, 0x7B: 0x7D, 0x3C: 0x3E };
    const close = PAIR[open] ?? open;
    let j = quotePos + 2;
    while (j < len) {
      if (src.charCodeAt(j) === close && src.charCodeAt(j + 1) === 0x27) return j + 2;
      j++;
    }
    return len;
  }

  // Rust raw string / raw identifier, decided AFTER the ident scan stopped at
  // the '#' or '"' — bounded forward peek, no backtracking, nothing un-emitted.
  //   r#*"  …  "#*   raw string: the closer is '"' + the CAPTURED hash count;
  //                  NO escape processing inside (that is the point of raw)
  //   r#ident        raw identifier (exactly one hash, then ident-start)
  // Returns { end, tag } or null (plain ident after all — e.g. a variable r).
  _rawOpen(src, j, word) {
    const len = src.length;
    let k = j;
    while (k < len && src.charCodeAt(k) === 0x23) k++;   // count '#'s
    const hashes = k - j;
    if (k < len && src.charCodeAt(k) === 0x22) {
      // raw string: scan for '"' followed by `hashes` '#'s — parameterised end
      let p = k + 1;
      while (p < len) {
        if (src.charCodeAt(p) === 0x22) {
          let h = 0;
          while (h < hashes && src.charCodeAt(p + 1 + h) === 0x23) h++;
          if (h === hashes) return { end: p + 1 + hashes, tag: T.STRING };
        }
        p++;
      }
      return { end: len, tag: T.STRING };   // unterminated: token to EOF (start is honest)
    }
    if (word.endsWith('r') && hashes === 1 && k < len && isIdentStart(src.charCodeAt(k))) {
      let p = k + 1;
      while (p < len && isIdentPart(src.charCodeAt(p))) p++;
      return { end: p, tag: T.IDENT };      // raw identifier r#match
    }
    return null;
  }

  // Rust `'`: char literal ('x', '\n', '\u{1F600}') vs lifetime ('a, 'static).
  // Lifetime iff ident-start follows the quote and the char after that is not
  // the closing quote; '\…' is always a char literal.
  _charOrLifetime(src, i) {
    const len = src.length;
    const c1 = src.charCodeAt(i + 1);
    if (c1 === 0x5C) {                                  // '\…' — char with escape
      let p = i + 2;
      while (p < len && src.charCodeAt(p) !== 0x27 && src.charCodeAt(p) !== 0x0A) p++;
      return { end: Math.min(p + 1, len), lifetime: false };
    }
    if (isIdentStart(c1) && src.charCodeAt(i + 2) !== 0x27) {
      let p = i + 2;                                    // lifetime: 'name
      while (p < len && isIdentPart(src.charCodeAt(p))) p++;
      return { end: p, lifetime: true };
    }
    // plain char 'x' (or a lone quote — consume to the close on this line)
    let p = i + 1;
    while (p < len && src.charCodeAt(p) !== 0x27 && src.charCodeAt(p) !== 0x0A) p++;
    return { end: Math.min(p + 1, len), lifetime: false };
  }

  _str(src, i, quote) {
    const len = src.length;
    let j = i + 1;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === 0x5C) { j += 2; continue; }
      if (c === 0x0A) return j;          // newline-bounded: token ends here
      if (c === quote) return j + 1;
      j++;
    }
    return len;
  }

  _tmpl(src, i) {
    const len = src.length;
    let j = i + 1;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === 0x5C) { j += 2; continue; }
      if (c === 0x60) return j + 1;
      j++;
    }
    return len;   // unterminated: token runs to EOF (start is honest; see lexical-scanner for the seam)
  }

  _regex(src, i) {
    const len = src.length;
    let j = i + 1;
    let inClass = false;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === 0x0A) return -1;
      if (c === 0x5C) { j += 2; continue; }
      if (c === 0x5B) inClass = true;
      else if (c === 0x5D) inClass = false;
      else if (c === 0x2F && !inClass) { j++; while (j < len && isIdentPart(src.charCodeAt(j))) j++; return j; }
      j++;
    }
    return -1;
  }

  _num(src, i) {
    const len = src.length;
    let j = i;
    if (src.charCodeAt(j) === 0x30 && j + 1 < len && /[xXbBoO]/.test(src[j + 1])) {
      j += 2; while (j < len && /[0-9a-fA-F_]/.test(src[j])) j++;
    } else {
      while (j < len && /[\d_]/.test(src[j])) j++;
      if (src[j] === '.' && /\d/.test(src[j + 1] ?? '')) { j++; while (j < len && /[\d_]/.test(src[j])) j++; }
      if (/[eE]/.test(src[j] ?? '')) { j++; if (/[+-]/.test(src[j] ?? '')) j++; while (j < len && /\d/.test(src[j])) j++; }
    }
    if (src[j] === 'n') j++;             // BigInt
    return j;
  }

  _result(src, tagArr, poolArr, offArr, linkArr, depthArr, n, pools, classTable = TAG_CLASS, xml = false) {
    const tagOf    = (t) => tagArr[t];
    const charOf   = (t) => String.fromCharCode(tagArr[t]);
    const classOf  = (t) => classTable[tagArr[t]];
    const lexemeOf = (t) => pools[classTable[tagArr[t]]][poolArr[t]].lexeme;
    const offsetOf = (t) => offArr[t];
    const linkOf   = (t) => linkArr[t];
    const depthOf  = (t) => depthArr[t];

    // The exact source text of one token. For XML tag tokens the pooled value
    // is the NAME (interned, shared by open and close); the surrounding syntax
    // ('<', '</', an absorbed '>' or '/>') is recovered from the token's source
    // SPAN — tokens are contiguous, so span = this offset to the next. This is
    // §13b's offset+length raw-slice option, applied to the tag class.
    const rawOf = (t) => {
      if (xml && classTable[tagArr[t]] === KLASS.TAG) {
        return src.slice(offArr[t], t + 1 < n ? offArr[t + 1] : src.length);
      }
      return lexemeOf(t);
    };

    // The printable mnemonic of one token. Usually the tag byte's char;
    // OPERATORS render their full pooled lexeme ('&&', '>=', '++') — the tag
    // byte is the family, the lexeme is the exact operator, and ops are short
    // enough to show whole (the cpp-digraph precedent: the projection may be
    // wider than one char per token).
    const mnemonicOf = (t) => {
      const b = tagArr[t];
      if (b === TAG_NL) return '\\n';                      // printable escape (dumps)
      if (b === TAG_INDENT) return ':{';                     // indent family digraphs —
      if (b === TAG_DEDENT) return '}:';                     // role kept, braces not overloaded
      if (b === TAG_COMMENT_ML) {                            // C(n), n = newlines inside
        return `C(${(lexemeOf(t).match(/\n/g) || []).length})`;
      }
      if (classTable[b] === KLASS.OP) return OP_LITERAL[b] ?? lexemeOf(t);
      if (classTable[b] === KLASS.KEYWORD && b >= 0x80) return KW_LITERAL[b] ?? lexemeOf(t);
      return String.fromCharCode(b);
    };

    // One mnemonic per token — keywords whisper, literals shout, brackets are
    // literal, operators show themselves, whitespace breathes. Ghost source.
    // (In XML mode, open/close tags project as `{` / `}` — the structural
    // role, not the surface syntax.)
    function toPrintable() {
      let out = '';
      // TAG_NL renders as a REAL newline here: the ghost breaks lines where
      // the source does (dumps use the escaped form via mnemonicOf). A
      // multi-line comment DISPLAYS AS THE WHITESPACE IT OCCUPIES — just its
      // line breaks — so the ghost stays line-aligned with the source
      // (C(n) is the dump form, not the ghost form).
      for (let t = 0; t < n; t++) {
        const b = tagArr[t];
        if (b === TAG_NL) out += '\n';
        else if (b === TAG_COMMENT_ML) out += '\n'.repeat((lexemeOf(t).match(/\n/g) || []).length);
        else out += mnemonicOf(t);
      }
      return out;
    }

    // Byte-for-byte reconstruction from the pools — the §13b losslessness proof,
    // now on the unified tape (tag tokens restore their implied '<' / '</').
    function reconstruct() {
      let out = '';
      for (let t = 0; t < n; t++) out += rawOf(t);
      return out;
    }

    // The listed-next-to-the-lexer view: tag char, class, depth, link, lexeme.
    function dump({ limit = n } = {}) {
      const rows = [];
      for (let t = 0; t < Math.min(n, limit); t++) {
        const lex = lexemeOf(t).replace(/\n/g, '↵').replace(/\t/g, '→');
        const link = linkArr[t] === -1 ? '' : ` →[${linkArr[t]}]`;
        rows.push(`[${String(t).padStart(4)}] ${mnemonicOf(t).padEnd(4)} ${KLASS_NAME[classOf(t)].padEnd(8)} d=${depthArr[t]}${link.padEnd(8)} ${lex.length > 28 ? lex.slice(0, 28) + '…' : lex}`);
      }
      return rows.join('\n');
    }

    function poolStats() {
      const tokensByClass = new Array(KLASS_NAME.length).fill(0);
      for (let t = 0; t < n; t++) tokensByClass[classTable[tagArr[t]]]++;
      return KLASS_NAME.map((name, k) => ({
        name, interned: INTERNED.has(k), tokens: tokensByClass[k], entries: pools[k].length,
      }));
    }

    function occurrences(klass, lexeme) {
      if (!INTERNED.has(klass)) return null;
      for (const e of pools[klass]) if (e.lexeme === lexeme) return e.occ;
      return [];
    }

    // Minimal balance query on the unified tape: unmatched/orphan brackets and
    // tags with both boundaries where known. (Full seam machinery — cpp family,
    // provenance — stays with lexical-scanner until that migration.)
    function repairMap() {
      const findings = [];
      for (let t = 0; t < n; t++) {
        const k = classTable[tagArr[t]];
        if ((k !== KLASS.BRACKET && k !== KLASS.TAG) || linkArr[t] !== -1) continue;
        const isTag = k === KLASS.TAG;
        const ch = isTag ? lexemeOf(t) : charOf(t);
        if (IS_OPEN.has(tagArr[t]) || tagArr[t] === 0x7B || tagArr[t] === TAG_INDENT) {
          findings.push({ kind: isTag ? 'unclosed-tag' : 'unmatched-open', char: ch, offset: offArr[t], startOffset: offArr[t], endOffset: src.length, tapeIndex: t });
        } else {
          findings.push({ kind: isTag ? 'orphan-close-tag' : 'orphan-close', char: ch, offset: offArr[t], tapeIndex: t });
        }
      }
      return findings;
    }

    return {
      length: n, tagArr, poolArr, offArr, linkArr, depthArr, pools, src,
      KLASS, KLASS_NAME, INTERNED,
      tagOf, charOf, classOf, lexemeOf, offsetOf, linkOf, depthOf, rawOf, mnemonicOf,
      toPrintable, reconstruct, dump, poolStats, occurrences, repairMap,
    };
  }
}

export { UniLexer, KLASS, KLASS_NAME, TAG_CLASS, INTERNED };
