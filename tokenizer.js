// tokenizer.js
import { T, KEYWORDS } from './token-tags.js';

// djb2 hash — fast, good distribution for short identifier strings
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export class Tokenizer {
  constructor() {
    this.reset();
  }

  reset() {
    // Tape stored as two parallel Uint32Arrays for cache efficiency.
    // Entry i:  hi[i] = (tag << 24) | (flags << 16)
    //           lo[i] = payload (u32)
    this._hiArr = new Uint32Array(4096);
    this._loArr = new Uint32Array(4096);
    this._tapeLen = 0;

    // Intern pool: Map<hash, [{name, id}]> + names array
    this._internMap = new Map();
    this._internNames = [];
    this._nextInternId = 0;

    // Side buffer for decoded string literal content
    this._strings = [];

    // Stack of tape indices for open brackets awaiting their jump target
    this._bracketStack = [];

    this._src = '';
    this._pos = 0;
  }

  // ── intern pool ────────────────────────────────────────────────────────────

  intern(name) {
    const h = hashStr(name);
    const bucket = this._internMap.get(h);
    if (bucket) {
      for (const entry of bucket) {
        if (entry.name === name) return entry.id;
      }
      const id = this._nextInternId++;
      bucket.push({ name, id });
      this._internNames.push(name);
      return id;
    }
    const id = this._nextInternId++;
    this._internMap.set(h, [{ name, id }]);
    this._internNames.push(name);
    return id;
  }

  nameOf(internId) {
    return this._internNames[internId];
  }

  // ── tape I/O ───────────────────────────────────────────────────────────────

  _grow() {
    const n = this._hiArr.length * 2;
    const hi = new Uint32Array(n); hi.set(this._hiArr);
    const lo = new Uint32Array(n); lo.set(this._loArr);
    this._hiArr = hi;
    this._loArr = lo;
  }

  _emit(tag, flags, payload) {
    if (this._tapeLen >= this._hiArr.length) this._grow();
    const i = this._tapeLen++;
    this._hiArr[i] = (tag << 24) | (flags << 16);
    this._loArr[i] = payload >>> 0;
    return i;  // returns tape index (needed for bracket patching)
  }

  _patch(idx, payload) {
    this._loArr[idx] = payload >>> 0;
  }

  // ── public API ─────────────────────────────────────────────────────────────

  tokenize(src) {
    this.reset();
    this._src = src;
    this._pos = 0;

    while (this._pos < src.length) {
      this._skipWhitespaceAndComments();
      if (this._pos >= src.length) break;

      const ch = src[this._pos];
      const offset = this._pos;

      if (isIdentStart(ch)) {
        this._scanIdentOrKeyword(offset);
      } else if (isDigit(ch) || (ch === '.' && isDigit(src[this._pos + 1]))) {
        this._scanNumber(offset);
      } else if (ch === '"' || ch === "'") {
        this._scanString(offset, ch);
      } else if (ch === '`') {
        this._scanTemplate(offset);
      } else if (ch === '/' && this._isRegexStart()) {
        this._scanRegex(offset);
      } else {
        this._scanPunctOrOp(offset, ch);
      }
    }

    this._emit(T.EOF, 0, this._pos);

    // Patch any unclosed brackets (malformed input — point to EOF)
    while (this._bracketStack.length > 0) {
      this._patch(this._bracketStack.pop(), this._tapeLen - 1);
    }

    return this._buildResult();
  }

  // ── scanners ───────────────────────────────────────────────────────────────

  _scanIdentOrKeyword(offset) {
    const src = this._src;
    let end = this._pos;
    while (end < src.length && isIdentPart(src[end])) end++;
    const word = src.slice(this._pos, end);
    this._pos = end;

    const kwTag = KEYWORDS.get(word);
    if (kwTag !== undefined) {
      this._emit(kwTag, 0, offset);
    } else {
      const id = this.intern(word);
      this._emit(T.IDENT, 0, id);
    }
  }

  _scanNumber(offset) {
    const src = this._src;
    let end = this._pos;
    let isFloat = false;

    if (src[end] === '0' && end + 1 < src.length) {
      const next = src[end + 1].toLowerCase();
      if (next === 'x') { end += 2; while (end < src.length && /[0-9a-fA-F_]/.test(src[end])) end++; }
      else if (next === 'b') { end += 2; while (end < src.length && /[01_]/.test(src[end])) end++; }
      else if (next === 'o') { end += 2; while (end < src.length && /[0-7_]/.test(src[end])) end++; }
      else { ({ end, isFloat } = scanDecimal(src, end)); }
    } else {
      ({ end, isFloat } = scanDecimal(src, end));
    }

    // BigInt suffix
    if (end < src.length && src[end] === 'n') end++;

    this._pos = end;
    // Use DOUBLE tag if the literal contains a decimal point or exponent
    this._emit(isFloat ? T.DOUBLE : T.NUMBER, 0, offset);
  }

  _scanString(offset, quote) {
    const src = this._src;
    let i = this._pos + 1;
    let result = '';
    while (i < src.length && src[i] !== quote) {
      if (src[i] === '\\') { i++; result += unescapeChar(src[i] ?? ''); }
      else result += src[i];
      i++;
    }
    this._pos = i + 1;
    const strIdx = this._strings.length;
    this._strings.push(result);
    this._emit(T.STRING, 0, strIdx);
  }

  _scanTemplate(offset) {
    // Simplified: treat the whole template as one token (no expression splitting)
    const src = this._src;
    let i = this._pos + 1;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') i++;
      i++;
    }
    this._pos = i + 1;
    this._emit(T.TEMPLATE, 0, offset);
  }

  _scanRegex(offset) {
    const src = this._src;
    let i = this._pos + 1;
    let inClass = false;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '[')  { inClass = true;  i++; continue; }
      if (src[i] === ']')  { inClass = false; i++; continue; }
      if (!inClass && src[i] === '/') { i++; break; }
      i++;
    }
    while (i < src.length && /[gimsuy]/.test(src[i])) i++;
    this._pos = i;
    this._emit(T.REGEX, 0, offset);
  }

  _scanPunctOrOp(offset, ch) {
    this._pos++;
    switch (ch) {
      case '(': { const i = this._emit(T.LPAREN,   0, 0); this._bracketStack.push(i); break; }
      case ')': { const i = this._emit(T.RPAREN,   0, 0); this._patchBracket(i); break; }
      case '[': { const i = this._emit(T.LBRACKET, 0, 0); this._bracketStack.push(i); break; }
      case ']': { const i = this._emit(T.RBRACKET, 0, 0); this._patchBracket(i); break; }
      case '{': { const i = this._emit(T.LBRACE,   0, 0); this._bracketStack.push(i); break; }
      case '}': { const i = this._emit(T.RBRACE,   0, 0); this._patchBracket(i); break; }
      case ';': this._emit(T.SEMICOLON, 0, offset); break;
      case ',': this._emit(T.COMMA,     0, offset); break;
      case '.':
        // Handle ... spread
        if (this._src[this._pos] === '.' && this._src[this._pos + 1] === '.') {
          this._pos += 2;
          this._emit(T.OP, 0, offset);
        } else {
          this._emit(T.DOT, 0, offset);
        }
        break;
      case ':': this._emit(T.COLON,    0, offset); break;
      case '?': this._emit(T.QUESTION, 0, offset); break;
      default:  this._scanMultiCharOp(offset); break;
    }
  }

  _patchBracket(closeIdx) {
    if (this._bracketStack.length > 0) {
      const openIdx = this._bracketStack.pop();
      this._patch(openIdx, closeIdx);   // open  → jump to close
      this._patch(closeIdx, openIdx);   // close → back-ref to open
    }
  }

  _scanMultiCharOp(offset) {
    const src = this._src;
    const OP_CHARS = new Set(['=','!','<','>','&','|','^','~','+','-','*','%','/','?',':','@']);
    let end = this._pos;
    while (end < src.length && OP_CHARS.has(src[end])) end++;
    this._pos = end;
    this._emit(T.OP, 0, offset);
  }

  _skipWhitespaceAndComments() {
    const src = this._src;
    let i = this._pos;
    while (i < src.length) {
      const ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
      if (ch === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i - 1] === '*' && src[i] === '/')) i++;
        i++;
        continue;
      }
      break;
    }
    this._pos = i;
  }

  _isRegexStart() {
    // Heuristic: after IDENT, RPAREN, RBRACKET, NUMBER, DOUBLE → division
    if (this._tapeLen === 0) return true;
    const lastTag = (this._hiArr[this._tapeLen - 1] >>> 24) & 0xFF;
    return lastTag !== T.IDENT    &&
           lastTag !== T.RPAREN   &&
           lastTag !== T.RBRACKET &&
           lastTag !== T.NUMBER   &&
           lastTag !== T.DOUBLE;
  }

  _buildResult() {
    const tok = this;
    return {
      tape: {
        hi:     this._hiArr.slice(0, this._tapeLen),
        lo:     this._loArr.slice(0, this._tapeLen),
        length: this._tapeLen,
      },
      intern:  { names: [...this._internNames] },
      strings: [...this._strings],
      src:     this._src,

      // Accessor helpers
      tag:     (i) => (tok._hiArr[i] >>> 24) & 0xFF,
      flags:   (i) => (tok._hiArr[i] >>> 16) & 0xFF,
      payload: (i) => tok._loArr[i],

      // Convenience: name of identifier at tape index i
      identName: (i) => tok._internNames[tok._loArr[i]],
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
         ch === '_' || ch === '$' || ch.charCodeAt(0) > 127;
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function scanDecimal(src, i) {
  let isFloat = false;
  while (i < src.length && (isDigit(src[i]) || src[i] === '_')) i++;
  if (src[i] === '.' && src[i + 1] !== '.') {
    isFloat = true; i++;
    while (i < src.length && (isDigit(src[i]) || src[i] === '_')) i++;
  }
  if (src[i] === 'e' || src[i] === 'E') {
    isFloat = true; i++;
    if (src[i] === '+' || src[i] === '-') i++;
    while (i < src.length && isDigit(src[i])) i++;
  }
  return { end: i, isFloat };
}

function unescapeChar(ch) {
  const MAP = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
  return MAP[ch] ?? ch;
}
