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

import { T, KEYWORDS, OPS } from './token-tags.js';

// ── classes (coarse, derived from the tag byte) ──────────────────────────────
const KLASS = {
  WS: 0, COMMENT: 1, STRING: 2, TEMPLATE: 3, REGEX: 4,
  NUMBER: 5, IDENT: 6, KEYWORD: 7, OP: 8, PUNCT: 9, BRACKET: 10,
  TAG: 11, TEXT: 12, DECL: 13,          // XML mode
};
const KLASS_NAME = ['ws', 'comment', 'string', 'template', 'regex',
  'number', 'ident', 'keyword', 'op', 'punct', 'bracket',
  'tag', 'text', 'decl'];

const TAG_WS      = 0x20;     // ' '  intra-line whitespace (spaces/tabs)
const TAG_NL      = 0x10;     // newline token — no structural value, but a line
                              // SIGNAL (owner's byte choice; the token stands
                              // for a control character, so a control-range
                              // byte matches its nature)
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
for (const b of [T.LPAREN, T.RPAREN, T.LBRACKET, T.RBRACKET, T.LBRACE, T.RBRACE]) {
  TAG_CLASS[b] = KLASS.BRACKET;
}

// Dedup policy (§13b): intern the limited vocabularies, store literals per
// occurrence — the waste is acceptable. XML tag NAMES are a limited vocabulary
// (interned — open and close share the pool slot, making the name match
// visible); text/decl content is mostly unique (per occurrence).
const INTERNED = new Set([KLASS.WS, KLASS.IDENT, KLASS.KEYWORD, KLASS.OP, KLASS.PUNCT, KLASS.BRACKET, KLASS.TAG]);

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

const RUST_OPTS = {
  keywords: new Map(),   // honest gap: no Rust keyword/mnemonic table yet —
                         // all words tokenize as IDENT until that vocabulary
                         // exercise is done (fn, let, impl, match, …)
  regex: false,
  templates: false,
  charLifetimes: true,
  rawStrings: true,
  nestedComments: true,
};

class UniLexer {
  // Rust mode: the §2a parameterised-end row in running code — raw strings
  // r"…" / r#"…"# / r##"…"## (closer = '"' + the CAPTURED hash count, no
  // escapes), raw identifiers r#match, byte/C-string prefixes b"…" br#"…"#
  // c"…" cr#"…"#, char literals 'x' vs lifetimes 'a, nested block comments.
  tokenizeRust(src) {
    return this.tokenize(src, RUST_OPTS);
  }

  tokenize(src, opts = JS_OPTS) {
    const len = src.length;
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

    const emit = (tag, lexeme, off, depth) => {
      if (n >= cap) grow();
      tagArr[n] = tag;
      poolArr[n] = addToPool(TAG_CLASS[tag], lexeme, off);
      offArr[n] = off;
      linkArr[n] = -1;
      depthArr[n] = depth;
      return n++;
    };

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
        tag = oplen === 1 ? c : OPS.get(src.slice(i, end));
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
            linkArr[top.idx] = idx;
            linkArr[idx] = top.idx;
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

    return this._result(src, tagArr, poolArr, offArr, linkArr, depthArr, n, pools, TAG_CLASS, false);
  }

  // ── XML mode — same uniform tape, structural-role mnemonics ───────────────
  // Open tag token = `<name` (byte '{', value = interned NAME); close tag =
  // `</name` (byte '}', same name pool). Inside a tag, attributes tokenize as
  // ident/op/string and '>' / '/>' as punct. Outside, text runs are one TEXT
  // token (whitespace-only runs are WS). Tag pairs are name-matched onto the
  // link array, tolerantly (no fault on improper nesting or orphans).
  tokenizeXml(src) {
    const len = src.length;
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
            linkArr[idx] = idx;
            i = j + 2; continue;
          }
          if (isClose) {
            depth = depth > 0 ? depth - 1 : 0;
            const idx = emit(0x7D, KLASS.TAG, name, start, depth);   // '}'
            // tolerant name-match: nearest open with the same pool slot
            for (let s = stack.length - 1; s >= 0; s--) {
              if (stack[s].poolIdx === poolArr[idx]) {
                linkArr[stack[s].idx] = idx;
                linkArr[idx] = stack[s].idx;
                stack.splice(s, 1);
                break;
              }
            }
          } else {
            const idx = emit(0x7B, KLASS.TAG, name, start, depth);   // '{'
            stack.push({ idx, poolIdx: poolArr[idx] });
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
        if (top) { linkArr[top.idx] = idx; linkArr[idx] = top.idx; }
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

    return this._result(src, tagArr, poolArr, offArr, linkArr, depthArr, n, pools, TAG_CLASS_XML, true);
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
      if (b === TAG_COMMENT_ML) {                            // C(n), n = newlines inside
        return `C(${(lexemeOf(t).match(/\n/g) || []).length})`;
      }
      if (classTable[b] === KLASS.OP) return lexemeOf(t);
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
        if (IS_OPEN.has(tagArr[t]) || tagArr[t] === 0x7B) {
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
