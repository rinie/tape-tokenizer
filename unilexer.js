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
//                                                S=STRING X=TEMPLATE R=REGEX
//   operators        '=' (generic op run)
//   comments         '#'                         (same char XML mode uses)
//   whitespace       ' '  — so toPrintable() reads like ghost source
//
// The coarse class (for programmatic queries) is DERIVED from the tag byte via
// a 256-entry lookup — no second per-token column. Mnemonic for humans, class
// for machines, one byte for both.
//
// Scope (honest): JavaScript only for now. sfdiff.js rides this module;
// tokenizer.js (defuse) and lexical-scanner.js (scan/validate — seams, cpp,
// XML, multi-language tables) are migration targets, not yet migrated.

import { T, KEYWORDS } from './token-tags.js';

// ── classes (coarse, derived from the tag byte) ──────────────────────────────
const KLASS = {
  WS: 0, COMMENT: 1, STRING: 2, TEMPLATE: 3, REGEX: 4,
  NUMBER: 5, IDENT: 6, KEYWORD: 7, OP: 8, PUNCT: 9, BRACKET: 10,
};
const KLASS_NAME = ['ws', 'comment', 'string', 'template', 'regex',
  'number', 'ident', 'keyword', 'op', 'punct', 'bracket'];

const TAG_WS      = 0x20;     // ' '
const TAG_COMMENT = 0x23;     // '#'

// tag byte → class, built once from token-tags
const TAG_CLASS = new Uint8Array(256).fill(KLASS.PUNCT);
TAG_CLASS[TAG_WS] = KLASS.WS;
TAG_CLASS[TAG_COMMENT] = KLASS.COMMENT;
TAG_CLASS[T.STRING] = KLASS.STRING;       // S
TAG_CLASS[T.TEMPLATE] = KLASS.TEMPLATE;   // X
TAG_CLASS[T.REGEX] = KLASS.REGEX;         // R
TAG_CLASS[T.NUMBER] = KLASS.NUMBER;       // N
TAG_CLASS[T.DOUBLE] = KLASS.NUMBER;       // D
TAG_CLASS[T.IDENT] = KLASS.IDENT;         // I
TAG_CLASS[T.OP] = KLASS.OP;               // =
for (const byte of KEYWORDS.values()) TAG_CLASS[byte] = KLASS.KEYWORD;
for (const b of [T.LPAREN, T.RPAREN, T.LBRACKET, T.RBRACKET, T.LBRACE, T.RBRACE]) {
  TAG_CLASS[b] = KLASS.BRACKET;
}

// Dedup policy (§13b): intern the limited vocabularies, store literals per
// occurrence — the waste is acceptable.
const INTERNED = new Set([KLASS.WS, KLASS.IDENT, KLASS.KEYWORD, KLASS.OP, KLASS.PUNCT, KLASS.BRACKET]);

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

class UniLexer {
  tokenize(src) {
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
        end = j; tag = TAG_WS;
      } else if (c === 0x2F && src.charCodeAt(i + 1) === 0x2F) {            // //
        let j = i + 2; while (j < len && src.charCodeAt(j) !== 0x0A) j++;
        end = j; tag = TAG_COMMENT;
      } else if (c === 0x2F && src.charCodeAt(i + 1) === 0x2A) {            // /*
        let j = i + 2; while (j < len && !(src.charCodeAt(j - 1) === 0x2A && src.charCodeAt(j) === 0x2F)) j++;
        end = Math.min(j + 1, len); tag = TAG_COMMENT;
      } else if (c === 0x22 || c === 0x27) {                                 // " '
        end = this._str(src, i, c); tag = T.STRING;
      } else if (c === 0x60) {                                               // `
        end = this._tmpl(src, i); tag = T.TEMPLATE;
      } else if (c === 0x2F && !prevValue && (end = this._regex(src, i)) !== -1) {
        tag = T.REGEX;
      } else if (isDigit(c) || (c === 0x2E && isDigit(src.charCodeAt(i + 1)))) {
        end = this._num(src, i);
        const lex = src.slice(i, end);
        // N = integer (incl. 0x/0b/0o/BigInt), D = float (decimal point / exponent)
        tag = (/^0[xXbBoO]/.test(lex) || !/[.eE]/.test(lex)) ? T.NUMBER : T.DOUBLE;
      } else if (isIdentStart(c)) {
        let j = i + 1; while (j < len && isIdentPart(src.charCodeAt(j))) j++;
        end = j;
        tag = KEYWORDS.get(src.slice(i, j)) ?? T.IDENT;
      } else if (TAG_CLASS[c] === KLASS.BRACKET) {
        end = i + 1; tag = c;
      } else if (c === 0x3B || c === 0x2C || c === 0x3A) {                   // ; , :
        end = i + 1; tag = c;
      } else if (c === 0x2E) {                                               // . (incl. ...)
        if (src.charCodeAt(i + 1) === 0x2E && src.charCodeAt(i + 2) === 0x2E) { end = i + 3; tag = T.OP; }
        else { end = i + 1; tag = T.DOT; }
      } else if (OP_CHARS.has(src[i])) {
        let j = i + 1; while (j < len && OP_CHARS.has(src[j])) j++;
        end = j; tag = T.OP;
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

    return this._result(src, tagArr, poolArr, offArr, linkArr, depthArr, n, pools);
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

  _result(src, tagArr, poolArr, offArr, linkArr, depthArr, n, pools) {
    const tagOf    = (t) => tagArr[t];
    const charOf   = (t) => String.fromCharCode(tagArr[t]);
    const classOf  = (t) => TAG_CLASS[tagArr[t]];
    const lexemeOf = (t) => pools[TAG_CLASS[tagArr[t]]][poolArr[t]].lexeme;
    const offsetOf = (t) => offArr[t];
    const linkOf   = (t) => linkArr[t];
    const depthOf  = (t) => depthArr[t];

    // One mnemonic char per token — keywords whisper, literals shout, brackets
    // are literal, whitespace breathes. Ghost source.
    function toPrintable() {
      let out = '';
      for (let t = 0; t < n; t++) out += String.fromCharCode(tagArr[t]);
      return out;
    }

    // Byte-for-byte reconstruction from the pools — the §13b losslessness proof,
    // now on the unified tape.
    function reconstruct() {
      let out = '';
      for (let t = 0; t < n; t++) out += pools[TAG_CLASS[tagArr[t]]][poolArr[t]].lexeme;
      return out;
    }

    // The listed-next-to-the-lexer view: tag char, class, depth, link, lexeme.
    function dump({ limit = n } = {}) {
      const rows = [];
      for (let t = 0; t < Math.min(n, limit); t++) {
        const lex = lexemeOf(t).replace(/\n/g, '↵').replace(/\t/g, '→');
        const link = linkArr[t] === -1 ? '' : ` →[${linkArr[t]}]`;
        rows.push(`[${String(t).padStart(4)}] ${charOf(t)}  ${KLASS_NAME[classOf(t)].padEnd(8)} d=${depthArr[t]}${link.padEnd(8)} ${lex.length > 28 ? lex.slice(0, 28) + '…' : lex}`);
      }
      return rows.join('\n');
    }

    function poolStats() {
      const tokensByClass = new Array(KLASS_NAME.length).fill(0);
      for (let t = 0; t < n; t++) tokensByClass[TAG_CLASS[tagArr[t]]]++;
      return KLASS_NAME.map((name, k) => ({
        name, interned: INTERNED.has(k), tokens: tokensByClass[k], entries: pools[k].length,
      }));
    }

    function occurrences(klass, lexeme) {
      if (!INTERNED.has(klass)) return null;
      for (const e of pools[klass]) if (e.lexeme === lexeme) return e.occ;
      return [];
    }

    // Minimal balance query on the unified tape: unmatched/orphan brackets with
    // both boundaries where known. (Seams/cpp/XML stay with lexical-scanner
    // until that migration.)
    function repairMap() {
      const findings = [];
      for (let t = 0; t < n; t++) {
        if (TAG_CLASS[tagArr[t]] !== KLASS.BRACKET || linkArr[t] !== -1) continue;
        if (IS_OPEN.has(tagArr[t])) {
          findings.push({ kind: 'unmatched-open', char: charOf(t), offset: offArr[t], startOffset: offArr[t], endOffset: src.length, tapeIndex: t });
        } else {
          findings.push({ kind: 'orphan-close', char: charOf(t), offset: offArr[t], tapeIndex: t });
        }
      }
      return findings;
    }

    return {
      length: n, tagArr, poolArr, offArr, linkArr, depthArr, pools, src,
      KLASS, KLASS_NAME, INTERNED,
      tagOf, charOf, classOf, lexemeOf, offsetOf, linkOf, depthOf,
      toPrintable, reconstruct, dump, poolStats, occurrences, repairMap,
    };
  }
}

export { UniLexer, KLASS, KLASS_NAME, TAG_CLASS, INTERNED };
