// lexical-scanner.js
// Milestone 2: structural tape scanner driven by a per-language lexical table.
//
// Extends the bracket-only scanner (bracket-scanner.js) with knowledge of which
// brackets to IGNORE — those inside strings and comments. The scanner stays
// language-agnostic; the swappable lexical table is the only thing that changes
// per language.
//
// Two settled design rules live in the core here:
//
//   1. Honest unterminated tokens. A multi-line token whose terminator is
//      missing (a `backtick` template or /* block comment that runs to EOF) is
//      recorded by WHERE IT STARTS only. We never guess where it ends — guessing
//      the end is the classic stack-based punctuation error that corrupts the
//      balance of everything after it. Such a token becomes an `unterminated-*`
//      finding and scanning STOPS (the tail is inside the unterminated token, or
//      it is corrupt; either way we refuse to fabricate structure for it).
//
//      A single-line string that hits a newline before its closing quote is a
//      different case: the grammar bounds it at the newline, so that is not a
//      guess — we report it and resume scanning as code. Only the unbounded,
//      multi-line tokens trigger the hard stop.
//
//   2. Tolerant, name-matched XML. Tags are a bracket family matched by interned
//      name (O(1) integer compare), not by nesting position. No envelope (root)
//      is required, and improper nesting (HTML5-style `<b><i></b>`) is REPORTED,
//      not enforced — observe and report, don't fault on first mismatch.
//
// Breadth-first / outside-in: read the depth-0 rows for the top-level skeleton
// (see `outline()`); nesting is a column of numbers, never an AST to walk.

// ── bracket ASCII codes ──────────────────────────────────────────────────────
const B_LPAREN   = 0x28;  // (
const B_RPAREN   = 0x29;  // )
const B_LBRACKET = 0x5B;  // [
const B_RBRACKET = 0x5D;  // ]
const B_LBRACE   = 0x7B;  // {
const B_RBRACE   = 0x7D;  // }

const IS_OPEN  = new Uint8Array(128);
const IS_CLOSE = new Uint8Array(128);
const CLOSE_OF = new Uint8Array(128);

IS_OPEN[B_LPAREN]   = IS_OPEN[B_LBRACKET]  = IS_OPEN[B_LBRACE]  = 1;
IS_CLOSE[B_RPAREN]  = IS_CLOSE[B_RBRACKET] = IS_CLOSE[B_RBRACE] = 1;
CLOSE_OF[B_LPAREN]   = B_RPAREN;
CLOSE_OF[B_LBRACKET] = B_RBRACKET;
CLOSE_OF[B_LBRACE]   = B_RBRACE;

// ── XML projection chars (one printable char per structural token) ───────────
const X_OPEN  = 0x3C;  // <  element open tag
const X_CLOSE = 0x3E;  // >  element close tag
const X_SELF  = 0x2F;  // /  self-closing tag
const X_COMM  = 0x23;  // #  comment
const X_DECL  = 0x21;  // !  declaration / processing-instruction / CDATA

// ── preprocessor-conditional projection chars (the SECOND, line-based family) ──
// A mnemonic ternary shape: #if ? … #else : … #endif ;
const P_IF    = 0x3F;  // ?  #if / #ifdef / #ifndef  (open)
const P_ELSE  = 0x3A;  // :  #elif / #else            (branch marker, no nesting)
const P_ENDIF = 0x3B;  // ;  #endif                   (close)

// ── helpers ───────────────────────────────────────────────────────────────────

function startsWith(src, i, str) {
  if (i + str.length > src.length) return false;
  for (let k = 0; k < str.length; k++) {
    if (src.charCodeAt(i + k) !== str.charCodeAt(k)) return false;
  }
  return true;
}

function isNameChar(code) {
  // tag-name bytes: letters, digits, '-', '_', ':', '.'
  return (code >= 0x61 && code <= 0x7A) || (code >= 0x41 && code <= 0x5A) ||
         (code >= 0x30 && code <= 0x39) ||
         code === 0x2D || code === 0x5F || code === 0x3A || code === 0x2E;
}

// identifier bytes (for the regex value-position classifier)
function isIdentStartCode(c) {
  return (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || c === 0x5F || c === 0x24 || c > 127;
}
function isIdentPartCode(c) {
  return isIdentStartCode(c) || (c >= 0x30 && c <= 0x39);
}

// Keywords after which a `/` opens a regex, not a division. After any other
// identifier (a value) `/` is division. This is the one token of left-context
// the regex span needs — see §2a in the design doc.
const REGEX_PRECEDING_KW = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'yield', 'await', 'throw', 'case',
]);

// ── LexicalScanner ────────────────────────────────────────────────────────────

class LexicalScanner {
  constructor() {
    this._reset();
  }

  _reset() {
    const cap = 4096;
    this._tagArr    = new Uint8Array(cap);   // projection char code
    this._offsetArr = new Uint32Array(cap);  // source byte offset of token start
    this._jumpArr   = new Int32Array(cap);   // partner tape index (-1 = unmatched)
    this._depthArr  = new Uint32Array(cap);  // nesting depth (0 = top level)
    this._nameArr   = new Int32Array(cap);   // interned name id (-1 = none, e.g. braces)
    this._len       = 0;
    this._src       = '';

    this._internMap   = new Map();   // name → id
    this._internNames = [];          // id → name

    this._findings    = [];          // observed problems, each with a source offset
    this._unterminated = null;       // { kind, char, offset } if scan stopped early
  }

  _grow() {
    const n = this._tagArr.length * 2;
    const g = (Ctor, fill) => { const a = new Ctor(n); if (fill !== undefined) a.fill(fill); return a; };
    const tags = g(Uint8Array);            tags.set(this._tagArr);
    const offs = g(Uint32Array);           offs.set(this._offsetArr);
    const jmp  = g(Int32Array, -1);        jmp.set(this._jumpArr);
    const dep  = g(Uint32Array);           dep.set(this._depthArr);
    const nam  = g(Int32Array, -1);        nam.set(this._nameArr);
    this._tagArr = tags; this._offsetArr = offs; this._jumpArr = jmp;
    this._depthArr = dep; this._nameArr = nam;
  }

  _emit(tag, offset, depth, nameId) {
    if (this._len >= this._tagArr.length) this._grow();
    const i = this._len++;
    this._tagArr[i]    = tag;
    this._offsetArr[i] = offset;
    this._jumpArr[i]   = -1;
    this._depthArr[i]  = depth;
    this._nameArr[i]   = nameId === undefined ? -1 : nameId;
    return i;
  }

  _intern(name) {
    const existing = this._internMap.get(name);
    if (existing !== undefined) return existing;
    const id = this._internNames.length;
    this._internMap.set(name, id);
    this._internNames.push(name);
    return id;
  }

  scan(src, table) {
    this._reset();
    this._src = src;
    if (table && table.mode === 'xml') return this._scanXml(src);
    return this._scanBrackets(src, table || {});
  }

  // ── bracket-language mode (JS, C, …) ───────────────────────────────────────

  _scanBrackets(src, table) {
    const lineComments  = table.lineComments  || [];
    const blockComments = table.blockComments || [];
    const strings       = table.strings       || [];
    const preproc       = !!table.preprocessor;
    const hasRegex      = !!table.regex;
    const len = src.length;

    // Regex disambiguation needs one token of left context: is the previous
    // significant token a *value* (→ `/` is division) or not (→ `/` opens a
    // regex)? Tracked as we scan. Starts false (regex allowed at start of input).
    let prevValue = false;

    // Unified stack of open structural tokens, both families:
    //   { idx, family: 'brace'|'cpp', code, name? }
    // Braces and preprocessor conditionals share it so that when they interleave
    // instead of nesting, the crossing is visible.
    const stack = [];
    let depth = 0;
    let i = 0;

    // Tolerant close, shared by braces and #endif. Search the stack top-down for
    // the nearest matching opener; anything still open above it has its boundary
    // CROSSED by this closer (a seam, not clean nesting) — reported, not faulted.
    // Used only when the top of stack is not already a clean match, so well-formed
    // LIFO code takes the fast path and is unaffected.
    const closeStructural = (closeIdx, family, isMatch) => {
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) { if (isMatch(stack[s])) { found = s; break; } }
      if (found === -1) return;   // no opener in this file — orphan close (a BOF seam); jump stays -1
      for (let s = stack.length - 1; s > found; s--) {
        const sk = stack[s];
        if (sk.crossed) continue;
        sk.crossed = true;
        this._findings.push({
          kind: sk.family === family ? 'mismatch' : 'crossing',
          severity: 'warning',
          char: sk.name || String.fromCharCode(sk.code),
          offset: this._offsetArr[sk.idx],
          endOffset: this._offsetArr[closeIdx],
          tapeIndex: sk.idx,
          note: sk.family === family
            ? 'a nested opener of the same family is still open at this closer'
            : `${sk.family} and ${family} boundaries interleave here — a seam, not clean nesting`,
        });
      }
      const open = stack[found];
      stack.splice(found, 1);
      this._jumpArr[open.idx] = closeIdx;
      this._jumpArr[closeIdx] = open.idx;
    };

    scanLoop:
    while (i < len) {
      // 1. line comments — skip to newline (or EOF; reaching EOF here is fine)
      let skipped = false;
      for (const lc of lineComments) {
        if (startsWith(src, i, lc)) {
          i += lc.length;
          while (i < len && src.charCodeAt(i) !== 0x0A) i++;
          skipped = true;
          break;
        }
      }
      if (skipped) continue;

      // 2. block comments — multi-line; missing terminator is a HARD stop
      for (const bc of blockComments) {
        if (startsWith(src, i, bc.open)) {
          const start = i;
          i += bc.open.length;
          let closed = false;
          while (i < len) {
            if (startsWith(src, i, bc.close)) { i += bc.close.length; closed = true; break; }
            i++;
          }
          if (!closed) {
            // ran to EOF — note where it STARTED, do not guess the end
            this._stopUnterminated('unterminated-block-comment', bc.open, start);
            break scanLoop;
          }
          skipped = true;
          break;
        }
      }
      if (skipped) continue;

      // 3. string / template literals
      for (const s of strings) {
        // line-context gate: a spec may apply only on a preprocessor directive
        // line (e.g. C header names `<…>` only on `#include` / `#import`). This
        // is how an otherwise structure-hostile delimiter — `<`/`>`, which are
        // operators everywhere else — is admitted safely. The gate is a
        // line-local positional fact, not an AST: scan back to the line start,
        // require `#`, read the directive word.
        if (s.onlyOnDirective) {
          const d = this._lineDirective(src, i);
          if (!d || !s.onlyOnDirective.includes(d)) continue;
        }
        if (startsWith(src, i, s.open)) {
          const r = this._skipString(src, i, s);
          if (r.unterminated && !r.boundedByNewline) {
            // unbounded multi-line token (e.g. backtick) ran to EOF — HARD stop
            this._stopUnterminated('unterminated-string', s.open, i);
            break scanLoop;
          }
          if (r.unterminated && r.boundedByNewline) {
            // grammar bounds a single-line string at the newline: report + resume
            this._findings.push({ kind: 'unterminated-string', severity: 'error', char: s.open, offset: i });
            i = r.end;          // the newline; resume scanning code after it
          } else {
            i = r.end;          // just past the closing delimiter
          }
          prevValue = true;     // a string/template literal is a value
          skipped = true;
          break;
        }
      }
      if (skipped) continue;

      // 3.5 preprocessor conditionals — the SECOND, line-based bracket family.
      // #if/#ifdef/#ifndef open, #elif/#else mark a branch, #endif closes. They
      // are matched by keyword and live on the same tape/stack as the braces, so
      // a #if that straddles a { } shows up as a crossing in the repair map.
      if (preproc && src.charCodeAt(i) === 0x23) {        // '#'
        const dir = this._lineDirective(src, i);
        if (dir === 'if' || dir === 'ifdef' || dir === 'ifndef') {
          const idx = this._emit(P_IF, i, depth, this._intern(dir));
          stack.push({ idx, family: 'cpp', code: P_IF, name: dir });
          depth++;
          i++; continue;
        }
        if (dir === 'elif' || dir === 'else') {
          this._emit(P_ELSE, i, depth > 0 ? depth - 1 : 0, this._intern(dir));
          i++; continue;
        }
        if (dir === 'endif') {
          depth = depth > 0 ? depth - 1 : 0;
          const idx = this._emit(P_ENDIF, i, depth, this._intern('endif'));
          closeStructural(idx, 'cpp', (e) => e.family === 'cpp');
          i++; continue;
        }
        // #include / #define / #pragma etc. are single-line — not structural.
      }

      const code = src.charCodeAt(i);

      // 3.6 regex literal vs division — the only delimiter whose START is
      // ambiguous. In value position a `/` is division; otherwise it opens a
      // regex. The END is stateful: `/` closes only when not inside a `[ ]`
      // class, `\` escapes, and a newline means it was never a regex. Character
      // classification + one token of left context — no regex engine. (§2a)
      if (hasRegex && code === 0x2F && !prevValue) {       // '/'
        const end = this._skipRegex(src, i);
        if (end !== -1) { i = end; prevValue = true; continue; }
        // not a valid single-line regex — fall through; treat '/' as an operator
      }

      // 4. structural brackets
      if (code < 128 && IS_OPEN[code]) {
        const idx = this._emit(code, i, depth);
        stack.push({ idx, family: 'brace', code });
        depth++;
        prevValue = false;                  // after '(' '[' '{', a '/' is a regex
        i++; continue;
      }
      if (code < 128 && IS_CLOSE[code]) {
        depth = depth > 0 ? depth - 1 : 0;
        const idx = this._emit(code, i, depth);
        const top = stack[stack.length - 1];
        if (top && top.family === 'brace' && CLOSE_OF[top.code] === code) {
          stack.pop();                                    // clean LIFO close (fast path)
          this._jumpArr[top.idx] = idx;
          this._jumpArr[idx]     = top.idx;
        } else {
          // not a clean top match — tolerant search (may reveal a crossing seam)
          closeStructural(idx, 'brace', (e) => e.family === 'brace' && CLOSE_OF[e.code] === code);
        }
        prevValue = (code === 0x29 || code === 0x5D);     // ')' ']' end a value; '}' does not
        i++; continue;
      }

      // Position classification for the regex gate (only needed when regex is on).
      // Identifiers are values unless they are a keyword that introduces an
      // expression (return, typeof, …); numbers are values; operators are not.
      if (hasRegex) {
        if (isIdentStartCode(code)) {
          let k = i + 1;
          while (k < len && isIdentPartCode(src.charCodeAt(k))) k++;
          prevValue = !REGEX_PRECEDING_KW.has(src.slice(i, k));
          i = k; continue;
        }
        if (code >= 0x30 && code <= 0x39) { prevValue = true; i++; continue; }   // digit → value
        if (code !== 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D) prevValue = false; // operator
      }
      i++;
    }

    return this._buildResult();
  }

  // The C-preprocessor directive on the line containing offset i, or null.
  // "Line starts with #" precisely: first non-whitespace byte is '#', then the
  // following word (after optional whitespace, allowing `#  include`). Returns
  // the lowercase directive word (e.g. 'include', 'define') or null.
  _lineDirective(src, i) {
    let p = i;
    while (p > 0 && src.charCodeAt(p - 1) !== 0x0A) p--;            // line start
    while (p < i && (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)) p++;
    if (src.charCodeAt(p) !== 0x23) return null;                    // '#'
    p++;
    while (p < src.length && (src.charCodeAt(p) === 0x20 || src.charCodeAt(p) === 0x09)) p++;
    let w = '';
    while (p < src.length) {
      const c = src.charCodeAt(p);
      if (c >= 0x61 && c <= 0x7A) { w += src[p]; p++; } else break;  // a-z
    }
    return w || null;
  }

  // Scan a regex literal from its opening '/'. STATEFUL END: '/' closes only
  // when not inside a '[ ]' character class; '\' escapes the next byte; a
  // newline means this was never a regex (they cannot span lines). Returns the
  // index just past the trailing flags, or -1 to mean "not a regex — it's a '/'
  // operator." No regex grammar is interpreted; we only delimit.
  _skipRegex(src, i) {
    const len = src.length;
    let j = i + 1;
    let inClass = false;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === 0x0A) return -1;             // newline → not a single-line regex
      if (c === 0x5C) { j += 2; continue; }  // backslash escapes the next byte
      if (c === 0x5B) inClass = true;        // '['  enter char class
      else if (c === 0x5D) inClass = false;  // ']'  leave char class
      else if (c === 0x2F && !inClass) {     // '/'  closes only outside a class
        j++;
        while (j < len && isIdentPartCode(src.charCodeAt(j))) j++;   // flags
        return j;
      }
      j++;
    }
    return -1;                               // EOF before close → not a regex
  }

  // Scan a string/template starting at the opening delimiter.
  // Returns { end } on success, or { unterminated, boundedByNewline, end }.
  _skipString(src, i, spec) {
    const len = src.length;
    const escape = spec.escape ? spec.escape.charCodeAt(0) : -1;
    let j = i + spec.open.length;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (escape !== -1 && c === escape) { j += 2; continue; }
      if (!spec.multiline && c === 0x0A) {
        return { unterminated: true, boundedByNewline: true, end: j };
      }
      if (startsWith(src, j, spec.close)) {
        return { end: j + spec.close.length };
      }
      j++;
    }
    return { unterminated: true, boundedByNewline: false, end: len };
  }

  // ── XML mode — tags as a tolerant, name-matched bracket family ─────────────

  _scanXml(src) {
    const len = src.length;
    const stack = [];   // { idx, nameId } of open element tags awaiting a close

    let i = 0;
    scanLoop:
    while (i < len) {
      if (src.charCodeAt(i) !== 0x3C) { i++; continue; }   // not '<'

      // comment / declaration / PI / CDATA — skip as opaque spans
      if (startsWith(src, i, '<!--')) {
        const start = i; i += 4;
        let closed = false;
        while (i < len) { if (startsWith(src, i, '-->')) { i += 3; closed = true; break; } i++; }
        if (!closed) { this._stopUnterminated('unterminated-comment', '<!--', start); break scanLoop; }
        this._emit(X_COMM, start, stack.length);
        continue;
      }
      if (startsWith(src, i, '<![CDATA[')) {
        const start = i; i += 9;
        let closed = false;
        while (i < len) { if (startsWith(src, i, ']]>')) { i += 3; closed = true; break; } i++; }
        if (!closed) { this._stopUnterminated('unterminated-cdata', '<![CDATA[', start); break scanLoop; }
        this._emit(X_DECL, start, stack.length);
        continue;
      }
      if (startsWith(src, i, '<?') || startsWith(src, i, '<!')) {
        const start = i;
        const r = this._skipTag(src, i);
        if (r.unterminated) { this._stopUnterminated('unterminated-tag', '<', start); break scanLoop; }
        this._emit(X_DECL, start, stack.length);
        i = r.end;
        continue;
      }

      // element tag — open, close, or self-closing
      const start = i;
      const isClose = startsWith(src, i, '</');
      let j = i + (isClose ? 2 : 1);
      const nameStart = j;
      while (j < len && isNameChar(src.charCodeAt(j))) j++;
      const name = src.slice(nameStart, j);

      const r = this._skipTag(src, i);
      if (r.unterminated) { this._stopUnterminated('unterminated-tag', '<', start); break scanLoop; }

      if (isClose) {
        this._closeXmlTag(name, start, stack);
      } else if (r.selfClosing || name === '') {
        // self-closing (or a bare '<>' we won't nest) — matched, zero span
        const idx = this._emit(X_SELF, start, stack.length, name ? this._intern(name) : -1);
        this._jumpArr[idx] = idx;
      } else {
        const nameId = this._intern(name);
        const idx = this._emit(X_OPEN, start, stack.length, nameId);
        stack.push({ idx, nameId });
      }
      i = r.end;
    }

    return this._buildResult();
  }

  // Skip from '<' to the matching '>', honoring quoted attribute values that may
  // contain '>'. Returns { end, selfClosing } or { unterminated:true }.
  _skipTag(src, i) {
    const len = src.length;
    let j = i + 1;
    let lastNonWs = 0;
    while (j < len) {
      const c = src.charCodeAt(j);
      if (c === 0x22 || c === 0x27) {           // " or ' — skip quoted attr value
        const quote = c; j++;
        while (j < len && src.charCodeAt(j) !== quote) j++;
        if (j >= len) return { unterminated: true };
        j++; continue;
      }
      if (c === 0x3E) {                          // '>'
        return { end: j + 1, selfClosing: lastNonWs === 0x2F };
      }
      if (c !== 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) lastNonWs = c;
      j++;
    }
    return { unterminated: true };
  }

  // Tolerant close: match the NEAREST open tag of the same name, even if it is
  // not on top of the stack (improper nesting). Report skipped-over opens.
  _closeXmlTag(name, offset, stack) {
    const nameId = this._internNames.indexOf(name) === -1 ? -1 : this._intern(name);

    let found = -1;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s].nameId === nameId && nameId !== -1) { found = s; break; }
    }

    if (found === -1) {
      // orphan close — no matching open anywhere on the stack
      this._emit(X_CLOSE, offset, stack.length, nameId === -1 ? this._intern(name) : nameId);
      // jump stays -1; surfaces as orphan-close in the repair map
      return;
    }

    const openEntry = stack[found];
    // any tags above the matched open were left unclosed → improper nesting
    for (let s = stack.length - 1; s > found; s--) {
      this._findings.push({
        kind: 'improper-nesting',
        severity: 'warning',
        char: this._internNames[stack[s].nameId],
        offset: this._offsetArr[stack[s].idx],
        endOffset: offset,
        tapeIndex: stack[s].idx,
        note: `still open when </${name}> closed`,
      });
    }
    stack.splice(found, 1);   // remove just the matched open; leave the rest open

    const depth = this._depthArr[openEntry.idx];
    const idx = this._emit(X_CLOSE, offset, depth, openEntry.nameId);
    this._jumpArr[openEntry.idx] = idx;
    this._jumpArr[idx]           = openEntry.idx;
  }

  // ── shared ─────────────────────────────────────────────────────────────────

  // Record an unterminated multi-line token. We know TWO real boundaries: where
  // it opened (startOffset) and where the input ran out (endOffset = EOF). We
  // show both and guess neither a logical terminator nor any depth past here —
  // scanning has already stopped, so no later token's depth is fabricated.
  _stopUnterminated(kind, char, startOffset) {
    const endOffset = this._src.length;   // EOF — factual outer boundary, not a guessed close
    this._unterminated = { kind, char, startOffset, endOffset };
    this._findings.push({
      kind, char, severity: 'error',      // a hard stop — scanning cannot continue
      offset: startOffset,                // primary (sort) boundary: where it opened
      startOffset, endOffset,             // both boundaries shown; terminator unknown
      note: 'opened here; ran to end of input — terminator not found, end not guessed',
    });
  }

  _buildResult() {
    const len     = this._len;
    const tags    = this._tagArr.slice(0, len);
    const offsets = this._offsetArr.slice(0, len);
    const jumps   = this._jumpArr.slice(0, len);
    const depths  = this._depthArr.slice(0, len);
    const names   = this._nameArr.slice(0, len);
    const src     = this._src;
    const internNames = [...this._internNames];
    const scanFindings = [...this._findings];
    const unterminated = this._unterminated;

    const nameOf = (i) => (names[i] === -1 ? null : internNames[names[i]]);

    function toPrintable() {
      let out = '';
      for (let i = 0; i < len; i++) out += String.fromCharCode(tags[i]);
      return out;
    }

    function toPrintableIndented() {
      const lines = [];
      for (let i = 0; i < len; i++) {
        lines.push('  '.repeat(depths[i]) + String.fromCharCode(tags[i]));
      }
      return lines.join('\n');
    }

    // Breadth-first top-level skeleton: just the depth-0 tokens, in order.
    function outline() {
      const rows = [];
      for (let i = 0; i < len; i++) {
        if (depths[i] !== 0) continue;
        const nm = nameOf(i);
        rows.push({ tapeIndex: i, char: String.fromCharCode(tags[i]), name: nm, offset: offsets[i] });
      }
      return rows;
    }

    // Folded outline — the breadth-first viewer. Show only tokens at depth
    // < maxDepth; a MATCHED opener sitting at the fold boundary collapses its
    // whole span to one line (`{ … 12 … }`) via its jump pointer, O(1) per fold.
    // Raise maxDepth to peel one more layer. Unmatched openers are NOT folded —
    // we never guess a missing end — they print open with a trailing `…?`.
    function toOutline(maxDepth = 1) {
      const out = [];
      let i = 0;
      while (i < len) {
        const d = depths[i];
        if (d >= maxDepth) { i++; continue; }   // beyond the fold (under an unmatched opener)
        const tag = tags[i];
        const nm = nameOf(i);
        const label = String.fromCharCode(tag) + (nm ? nm : '');
        const indent = '  '.repeat(d);
        const isOpener = (tag < 128 && IS_OPEN[tag]) || tag === X_OPEN || tag === P_IF;
        const j = jumps[i];
        if (isOpener && d === maxDepth - 1) {
          if (j !== -1 && j !== i) {
            const inner = j - i - 1;
            const close = String.fromCharCode(tags[j]);
            out.push(inner === 0 ? `${indent}${label}${close}` : `${indent}${label} … ${inner} … ${close}`);
            i = j + 1;
            continue;
          }
          if (j === -1) { out.push(`${indent}${label} …?`); i++; continue; }   // unmatched — no fold
        }
        out.push(indent + label);
        i++;
      }
      return out.join('\n');
    }

    function dumpColumns({ showContext = false } = {}) {
      const rows = [];
      for (let i = 0; i < len; i++) {
        const ch   = String.fromCharCode(tags[i]);
        const nm   = nameOf(i);
        const jump = jumps[i] === -1 ? '   ?' : `→[${String(jumps[i]).padStart(3)}]`;
        let row = `[${String(i).padStart(4)}]  off=${String(offsets[i]).padStart(6)}  d=${String(depths[i]).padStart(3)}  ${ch}  ${jump}`;
        if (nm) row += `  ${nm}`;
        if (showContext) {
          const a = Math.max(0, offsets[i] - 8);
          const b = Math.min(src.length, offsets[i] + 9);
          row += `  «${src.slice(a, b).replace(/\n/g, '↵').replace(/\t/g, '→')}»`;
        }
        rows.push(row);
      }
      return rows.join('\n');
    }

    // The after-the-fact balance query (milestone 3 lives here): every imbalance
    // with its source offset. Unmatched opens/closes are derived from jump == -1;
    // improper-nesting and unterminated findings were recorded during the scan.
    // All sorted by offset so a human reads them in source order.
    function repairMap() {
      const eof = src.length;
      const findings = [...scanFindings];
      for (let i = 0; i < len; i++) {
        if (jumps[i] !== -1) continue;
        const tag = tags[i];
        const ch  = nameOf(i) || String.fromCharCode(tag);
        if (tag === X_OPEN || IS_OPEN[tag] || tag === P_IF) {
          // opener with no partner: show both boundaries — where it opened, and
          // EOF, the point at which it was still open. The close is not guessed.
          // This is a SEAM, not an error: the file isn't self-contained — the
          // partner presumably lives across an #include / file boundary.
          const kind = tag === X_OPEN ? 'unclosed-tag' : tag === P_IF ? 'unclosed-cond' : 'unmatched-open';
          findings.push({
            kind, severity: 'warning', seam: 'unclosed-at-eof',
            char: ch, offset: offsets[i], startOffset: offsets[i], endOffset: eof, tapeIndex: i,
            note: 'opener has no close in this file — not self-contained (resolves across an include/file seam?)',
          });
        } else if (tag === X_CLOSE || IS_CLOSE[tag] || tag === P_ENDIF) {
          // closer with no opener: only one boundary is real (the close itself);
          // the matching open is absent — again a seam, not an error.
          const kind = tag === X_CLOSE ? 'orphan-close-tag' : tag === P_ENDIF ? 'orphan-endif' : 'orphan-close';
          findings.push({
            kind, severity: 'warning', seam: 'unopened-at-bof',
            char: ch, offset: offsets[i], tapeIndex: i,
            note: 'closer has no opener in this file — not self-contained (seam?)',
          });
        }
        // comments / declarations / self-close / #else markers: not imbalances
      }
      findings.sort((a, b) => a.offset - b.offset);
      return findings;
    }

    // The seams are the warning-class findings: the file's structure does not
    // close within itself. They are NOT errors — they're exactly the "strange
    // seam" signal (a fragment, a macro that opens a brace, an unguarded #if,
    // an interleaved boundary) that says this isn't a clean standalone text file.
    function seams() {
      return repairMap().filter((f) => f.severity === 'warning');
    }

    // True when the structure closes within the file (no seams). Errors
    // (unterminated tokens) are a separate axis and don't affect this.
    function selfContained() {
      return seams().length === 0;
    }

    return {
      length: len, tags, offsets, jumps, depths, names, src, internNames,
      unterminated, nameOf,
      toPrintable, toPrintableIndented, outline, toOutline, dumpColumns,
      repairMap, seams, selfContained,
    };
  }
}

// ── lexical tables (the swappable per-language data) ─────────────────────────

const JS_TABLE = {
  mode: 'brackets',
  regex: true,   // recognise /…/ literals (context-start, stateful-end) so their
                 // brackets/quotes don't pollute balance. See §2a / _skipRegex.
  lineComments: ['//'],
  blockComments: [{ open: '/*', close: '*/' }],
  strings: [
    { open: '"',  close: '"',  escape: '\\', multiline: false },
    { open: "'",  close: "'",  escape: '\\', multiline: false },
    { open: '`',  close: '`',  escape: '\\', multiline: true  },  // template — runs to EOF if unterminated
  ],
};

const C_TABLE = {
  mode: 'brackets',
  // C is two structure systems on one file: the free-form braces below, and the
  // line-based preprocessor conditional family (#if … #endif), enabled here. Both
  // share one tape; where they interleave instead of nest, we report a crossing.
  preprocessor: true,
  lineComments: ['//'],
  blockComments: [{ open: '/*', close: '*/' }],
  strings: [
    { open: '"', close: '"', escape: '\\', multiline: false },
    { open: "'", close: "'", escape: '\\', multiline: false },
    // Header-name string `<…>` — admitted ONLY on a #include / #import line.
    // The TextMate grammar's `string.quoted.other.lt-gt.include` scope, made
    // safe by a line-context gate so `<`/`>` stay operators everywhere else.
    { open: '<', close: '>', escape: null, multiline: false, onlyOnDirective: ['include', 'import'] },
  ],
};

// Python — derived from its documented lexical grammar (the same delimiters a
// TextMate grammar encodes), then VALIDATED against real files (see validate.js).
//
// Order matters: the triple-quoted delimiters MUST be listed before the single
// ones, because the scanner checks string specs in order and `"""` must win over
// `"`. Triple-quoted strings are multi-line — so an unterminated one running to
// EOF is the canonical "note the start, never guess the end" case.
//
// Known limitation (deferred, matches the design doc's open question on template
// nesting): f-string interpolation `f"...{expr}..."` is treated as opaque string
// content, so brackets inside `{ }` are not counted as structure. Real-world
// validation confirms this rarely affects balance, since interpolations are
// themselves balanced — but it is a hypothesis the table makes, noted honestly.
const PYTHON_TABLE = {
  mode: 'brackets',
  lineComments: ['#'],
  blockComments: [],
  strings: [
    { open: '"""', close: '"""', escape: '\\', multiline: true  },
    { open: "'''", close: "'''", escape: '\\', multiline: true  },
    { open: '"',   close: '"',   escape: '\\', multiline: false },
    { open: "'",   close: "'",   escape: '\\', multiline: false },
  ],
};

const XML_TABLE = { mode: 'xml' };

export { LexicalScanner, JS_TABLE, C_TABLE, PYTHON_TABLE, XML_TABLE };
