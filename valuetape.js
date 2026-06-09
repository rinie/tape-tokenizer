// valuetape.js — §13b spike: a LOSSLESS, fully-pooled value tape.
//
// Every token — including whitespace and comments — lands on a dense integer
// tape as `(kind, poolIndex, offset)`. The actual text lives in per-kind value
// pools listed *next to* the tape. Two properties this proves:
//
//   1. Dedup keyed to uniqueness. Identifiers, keywords, whitespace and
//      punctuation are *interned* (limited vocabulary, hammered repeatedly);
//      numbers, strings, templates, regex and comments are stored *per
//      occurrence* (mostly unique — the waste is acceptable). Interned pool
//      entries also carry their occurrence offsets, so the pool doubles as a
//      cross-reference index (the substrate §13a queries).
//
//   2. Losslessness. The tape covers every byte; tokens are contiguous, so a
//      token's length is just the next token's offset. Concatenating the pooled
//      lexemes in tape order reproduces the source byte-for-byte — proving the
//      pools, not the original string, carry the content.
//
// Linter-grade JS lexer; templates are one token (no ${} split) — a noted spike
// limitation. The dense tape is integer; the pools are the swappable side data.

import { KEYWORDS } from './token-tags.js';

const K = {
  WS: 0, LINE_COMMENT: 1, BLOCK_COMMENT: 2, STRING: 3, TEMPLATE: 4,
  REGEX: 5, NUMBER: 6, IDENT: 7, KEYWORD: 8, PUNCT: 9,
};
const K_NAME = ['ws', 'line-comment', 'block-comment', 'string', 'template',
  'regex', 'number', 'ident', 'keyword', 'punct'];

// Dedup policy: intern where the vocabulary is limited; store-per-occurrence
// where tokens are mostly unique (§13b — dedup keyed to uniqueness).
const INTERNED = new Set([K.WS, K.IDENT, K.KEYWORD, K.PUNCT]);

const REGEX_PRECEDING_KW = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'yield', 'await', 'throw', 'case',
]);

const NUMBER_RE = /(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?|\.\d[\d_]*([eE][+-]?\d+)?)n?/y;

function isWs(c)         { return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D; }
function isDigit(c)      { return c >= 0x30 && c <= 0x39; }
function isIdentStart(c) { return (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || c === 0x5F || c === 0x24 || c > 127; }
function isIdentPart(c)  { return isIdentStart(c) || isDigit(c); }

class ValueTape {
  tokenize(src) {
    const len = src.length;
    const pools = K_NAME.map(() => []);
    const internMaps = K_NAME.map((_, k) => (INTERNED.has(k) ? new Map() : null));

    let cap = 1024;
    let kindArr = new Uint8Array(cap);
    let idxArr = new Uint32Array(cap);
    let offArr = new Uint32Array(cap);
    let n = 0;

    const emit = (kind, idx, off) => {
      if (n >= cap) {
        cap *= 2;
        const a = new Uint8Array(cap); a.set(kindArr); kindArr = a;
        const b = new Uint32Array(cap); b.set(idxArr); idxArr = b;
        const c = new Uint32Array(cap); c.set(offArr); offArr = c;
      }
      kindArr[n] = kind; idxArr[n] = idx; offArr[n] = off; n++;
    };

    const addToPool = (kind, lexeme, off) => {
      const pool = pools[kind];
      if (INTERNED.has(kind)) {
        const m = internMaps[kind];
        let idx = m.get(lexeme);
        if (idx === undefined) { idx = pool.length; pool.push({ lexeme, occ: [] }); m.set(lexeme, idx); }
        pool[idx].occ.push(off);   // every occurrence recorded → cross-reference
        return idx;
      }
      const idx = pool.length;
      pool.push({ lexeme, off });
      return idx;
    };

    let i = 0;
    let prevValue = false;   // regex gate: is the previous significant token a value?
    while (i < len) {
      const start = i;
      const c = src.charCodeAt(i);
      let kind;
      let end;

      if (isWs(c)) {
        let j = i + 1; while (j < len && isWs(src.charCodeAt(j))) j++;
        end = j; kind = K.WS;
      } else if (c === 0x2F && src.charCodeAt(i + 1) === 0x2F) {
        let j = i + 2; while (j < len && src.charCodeAt(j) !== 0x0A) j++;
        end = j; kind = K.LINE_COMMENT;
      } else if (c === 0x2F && src.charCodeAt(i + 1) === 0x2A) {
        let j = i + 2; while (j < len && !(src.charCodeAt(j - 1) === 0x2A && src.charCodeAt(j) === 0x2F)) j++;
        end = Math.min(j + 1, len); kind = K.BLOCK_COMMENT;
      } else if (c === 0x22 || c === 0x27) {
        end = this._str(src, i, c); kind = K.STRING;
      } else if (c === 0x60) {
        end = this._tmpl(src, i); kind = K.TEMPLATE;
      } else if (c === 0x2F && !prevValue && (end = this._regex(src, i)) !== -1) {
        kind = K.REGEX;
      } else if (isDigit(c) || (c === 0x2E && isDigit(src.charCodeAt(i + 1)))) {
        NUMBER_RE.lastIndex = i; const m = NUMBER_RE.exec(src);
        end = m ? i + m[0].length : i + 1; kind = K.NUMBER;
      } else if (isIdentStart(c)) {
        let j = i + 1; while (j < len && isIdentPart(src.charCodeAt(j))) j++;
        end = j; kind = KEYWORDS.has(src.slice(i, j)) ? K.KEYWORD : K.IDENT;
      } else {
        end = i + 1; kind = K.PUNCT;
      }

      const lexeme = src.slice(start, end);
      emit(kind, addToPool(kind, lexeme, start), start);

      // advance the regex gate (whitespace/comments are transparent)
      if (kind === K.WS || kind === K.LINE_COMMENT || kind === K.BLOCK_COMMENT) { /* keep prevValue */ }
      else if (kind === K.KEYWORD) prevValue = !REGEX_PRECEDING_KW.has(lexeme);
      else if (kind === K.PUNCT) prevValue = (lexeme === ')' || lexeme === ']');
      else prevValue = true;   // string / template / regex / number / ident

      i = end;
    }

    return this._result(src, kindArr.slice(0, n), idxArr.slice(0, n), offArr.slice(0, n), n, pools);
  }

  _str(src, i, quote) {
    const len = src.length;
    let j = i + 1;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === 0x5C) { j += 2; continue; }
      if (c === 0x0A) return j;          // unterminated at newline — token ends here
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
    return len;
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

  _result(src, kindArr, idxArr, offArr, n, pools) {
    const kindOf   = (t) => kindArr[t];
    const indexOf  = (t) => idxArr[t];
    const offsetOf = (t) => offArr[t];
    const lengthOf = (t) => (t + 1 < n ? offArr[t + 1] : src.length) - offArr[t];
    const lexemeOf = (t) => pools[kindArr[t]][idxArr[t]].lexeme;

    // Byte-for-byte reconstruction FROM THE POOLS (not from src) — the proof.
    function reconstruct() {
      let out = '';
      for (let t = 0; t < n; t++) out += pools[kindArr[t]][idxArr[t]].lexeme;
      return out;
    }

    // Per-kind dedup stats: tokens emitted vs unique pool entries.
    function poolStats() {
      const tokensByKind = new Array(K_NAME.length).fill(0);
      for (let t = 0; t < n; t++) tokensByKind[kindArr[t]]++;
      return K_NAME.map((name, k) => ({
        kind: k, name, interned: INTERNED.has(k),
        tokens: tokensByKind[k], entries: pools[k].length,
      }));
    }

    // All source offsets where an interned lexeme occurs (the cross-reference
    // index 13a wants). Only meaningful for interned kinds.
    function occurrences(kind, lexeme) {
      if (!INTERNED.has(kind)) return null;
      for (const e of pools[kind]) if (e.lexeme === lexeme) return e.occ;
      return [];
    }

    return {
      length: n, kindArr, idxArr, offArr, pools, src,
      K, K_NAME, INTERNED,
      kindOf, indexOf, offsetOf, lengthOf, lexemeOf,
      reconstruct, poolStats, occurrences,
    };
  }
}

export { ValueTape, K, K_NAME, INTERNED };
