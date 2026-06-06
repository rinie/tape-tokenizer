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
    const len = src.length;

    const stack = [];   // tape indices of open brackets awaiting a close
    let depth = 0;
    let i = 0;

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
        if (startsWith(src, i, s.open)) {
          const r = this._skipString(src, i, s);
          if (r.unterminated && !r.boundedByNewline) {
            // unbounded multi-line token (e.g. backtick) ran to EOF — HARD stop
            this._stopUnterminated('unterminated-string', s.open, i);
            break scanLoop;
          }
          if (r.unterminated && r.boundedByNewline) {
            // grammar bounds a single-line string at the newline: report + resume
            this._findings.push({ kind: 'unterminated-string', char: s.open, offset: i });
            i = r.end;          // the newline; resume scanning code after it
          } else {
            i = r.end;          // just past the closing delimiter
          }
          skipped = true;
          break;
        }
      }
      if (skipped) continue;

      // 4. structural brackets
      const code = src.charCodeAt(i);
      if (code < 128 && IS_OPEN[code]) {
        const idx = this._emit(code, i, depth);
        stack.push(idx);
        depth++;
      } else if (code < 128 && IS_CLOSE[code]) {
        depth = depth > 0 ? depth - 1 : 0;
        const idx = this._emit(code, i, depth);
        if (stack.length > 0) {
          const openIdx = stack[stack.length - 1];
          if (CLOSE_OF[this._tagArr[openIdx]] === code) {
            stack.pop();
            this._jumpArr[openIdx] = idx;
            this._jumpArr[idx]     = openIdx;
          }
          // mismatch: leave opener on stack; this close is an orphan (jump -1)
        }
      }
      i++;
    }

    return this._buildResult();
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
        char: this._internNames[stack[s].nameId],
        offset: this._offsetArr[stack[s].idx],
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
      kind, char,
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
        if (tag === X_OPEN || IS_OPEN[tag]) {
          // opener with no partner: show both boundaries — where it opened, and
          // EOF, the point at which it was still open. The close is not guessed.
          const kind = tag === X_OPEN ? 'unclosed-tag' : 'unmatched-open';
          findings.push({ kind, char: ch, offset: offsets[i], startOffset: offsets[i], endOffset: eof, tapeIndex: i });
        } else if (tag === X_CLOSE || IS_CLOSE[tag]) {
          // closer with no opener: only one boundary is real (the close itself);
          // the matching open is absent, so we do not invent its position.
          const kind = tag === X_CLOSE ? 'orphan-close-tag' : 'orphan-close';
          findings.push({ kind, char: ch, offset: offsets[i], tapeIndex: i });
        }
        // comments / declarations / self-close: not imbalances
      }
      findings.sort((a, b) => a.offset - b.offset);
      return findings;
    }

    return {
      length: len, tags, offsets, jumps, depths, names, src, internNames,
      unterminated, nameOf,
      toPrintable, toPrintableIndented, outline, dumpColumns, repairMap,
    };
  }
}

// ── lexical tables (the swappable per-language data) ─────────────────────────

const JS_TABLE = {
  mode: 'brackets',
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
  lineComments: ['//'],
  blockComments: [{ open: '/*', close: '*/' }],
  strings: [
    { open: '"', close: '"', escape: '\\', multiline: false },
    { open: "'", close: "'", escape: '\\', multiline: false },
  ],
};

const XML_TABLE = { mode: 'xml' };

export { LexicalScanner, JS_TABLE, C_TABLE, XML_TABLE };
