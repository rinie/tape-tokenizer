// bracket-scanner.js
// Language-agnostic bracket structure scanner (milestone 1).
// Scans source bytes for {}[]() and records them on a flat tape.
// No string/comment awareness yet — brackets inside strings are counted.
// Tolerant: never throws on unbalanced input; jumps stay -1 for orphans.

// ── bracket ASCII codes (same values used in token-tags.js) ──────────────────
const B_LPAREN   = 0x28;  // (
const B_RPAREN   = 0x29;  // )
const B_LBRACKET = 0x5B;  // [
const B_RBRACKET = 0x5D;  // ]
const B_LBRACE   = 0x7B;  // {
const B_RBRACE   = 0x7D;  // }

// Lookup tables — indexed by char code (0-127)
const IS_OPEN  = new Uint8Array(128);
const IS_CLOSE = new Uint8Array(128);
const CLOSE_OF = new Uint8Array(128);  // opener → expected closer

IS_OPEN[B_LPAREN]   = IS_OPEN[B_LBRACKET]  = IS_OPEN[B_LBRACE]  = 1;
IS_CLOSE[B_RPAREN]  = IS_CLOSE[B_RBRACKET] = IS_CLOSE[B_RBRACE] = 1;
CLOSE_OF[B_LPAREN]   = B_RPAREN;
CLOSE_OF[B_LBRACKET] = B_RBRACKET;
CLOSE_OF[B_LBRACE]   = B_RBRACE;

// ── BracketScanner ────────────────────────────────────────────────────────────

class BracketScanner {
  constructor() {
    this._reset();
  }

  _reset() {
    const cap = 4096;
    this._tagArr    = new Uint8Array(cap);    // bracket char code
    this._offsetArr = new Uint32Array(cap);   // source byte offset
    this._jumpArr   = new Int32Array(cap).fill(-1);  // tape index of partner (-1 = unmatched)
    this._depthArr  = new Uint32Array(cap);   // nesting depth at this token (0 = top level)
    this._len       = 0;
    this._src       = '';
  }

  _grow() {
    const n = this._tagArr.length * 2;
    const tags    = new Uint8Array(n);    tags.set(this._tagArr);
    const offsets = new Uint32Array(n);   offsets.set(this._offsetArr);
    const jumps   = new Int32Array(n).fill(-1);   jumps.set(this._jumpArr);
    const depths  = new Uint32Array(n);   depths.set(this._depthArr);
    this._tagArr    = tags;
    this._offsetArr = offsets;
    this._jumpArr   = jumps;
    this._depthArr  = depths;
  }

  _emit(tag, offset, depth) {
    if (this._len >= this._tagArr.length) this._grow();
    const i = this._len++;
    this._tagArr[i]    = tag;
    this._offsetArr[i] = offset;
    this._jumpArr[i]   = -1;
    this._depthArr[i]  = depth;
    return i;
  }

  scan(src) {
    this._reset();
    this._src = src;

    // Stack entries: { idx (tape index), tag (opener char code) }
    const stack = [];
    let depth = 0;

    for (let i = 0, len = src.length; i < len; i++) {
      const code = src.charCodeAt(i);
      if (code >= 128) continue;

      if (IS_OPEN[code]) {
        const idx = this._emit(code, i, depth);
        stack.push(idx);
        depth++;
      } else if (IS_CLOSE[code]) {
        depth = depth > 0 ? depth - 1 : 0;
        const idx = this._emit(code, i, depth);

        if (stack.length > 0) {
          const openIdx = stack[stack.length - 1];
          const openTag = this._tagArr[openIdx];
          if (CLOSE_OF[openTag] === code) {
            // Matched pair — wire jump pointers in both directions
            stack.pop();
            this._jumpArr[openIdx] = idx;
            this._jumpArr[idx]     = openIdx;
          }
          // Mismatch: leave opener on stack; close gets jump -1 (orphan)
        }
        // Empty stack: orphan close, jump stays -1
      }
    }
    // Remaining stack entries are unclosed openers; their jumps stay -1

    return this._buildResult(this._len);
  }

  _buildResult(len) {
    const tags    = this._tagArr.slice(0, len);
    const offsets = this._offsetArr.slice(0, len);
    const jumps   = this._jumpArr.slice(0, len);
    const depths  = this._depthArr.slice(0, len);
    const src     = this._src;

    // toPrintable: one char per token (brackets are already printable ASCII)
    function toPrintable() {
      let out = '';
      for (let i = 0; i < len; i++) out += String.fromCharCode(tags[i]);
      return out;
    }

    // toPrintableIndented: each token on its own line, indented by depth
    function toPrintableIndented() {
      const lines = [];
      for (let i = 0; i < len; i++) {
        lines.push('  '.repeat(depths[i]) + String.fromCharCode(tags[i]));
      }
      return lines.join('\n');
    }

    // dumpColumns: tabular {offset, depth, tag} dump, one row per token.
    // opts.showContext = true adds a short source excerpt around each bracket.
    function dumpColumns({ showContext = false } = {}) {
      const rows = [];
      for (let i = 0; i < len; i++) {
        const ch     = String.fromCharCode(tags[i]);
        const jump   = jumps[i] === -1 ? '   ?' : `→[${String(jumps[i]).padStart(3)}]`;
        let row = `[${String(i).padStart(4)}]  off=${String(offsets[i]).padStart(6)}  d=${String(depths[i]).padStart(3)}  ${ch}  ${jump}`;
        if (showContext) {
          const start = Math.max(0, offsets[i] - 8);
          const end   = Math.min(src.length, offsets[i] + 9);
          const ctx   = src.slice(start, end).replace(/\n/g, '↵').replace(/\t/g, '→');
          row += `  «${ctx}»`;
        }
        rows.push(row);
      }
      return rows.join('\n');
    }

    // repairMap: all unmatched brackets with their offsets.
    // (Full balance sweep is milestone 3; this is the raw unmatched list.)
    function repairMap() {
      const eof = src.length;
      const findings = [];
      for (let i = 0; i < len; i++) {
        if (jumps[i] !== -1) continue;
        const tag = tags[i];
        const ch  = String.fromCharCode(tag);
        if (IS_OPEN[tag]) {
          // opener with no partner: show both boundaries — opened here, still
          // open at EOF. The close position is not guessed.
          findings.push({ kind: 'unmatched-open', char: ch, offset: offsets[i], startOffset: offsets[i], endOffset: eof, tapeIndex: i });
        } else {
          // orphan close: only the close boundary is real; opener absent.
          findings.push({ kind: 'orphan-close', char: ch, offset: offsets[i], tapeIndex: i });
        }
      }
      return findings;
    }

    return { length: len, tags, offsets, jumps, depths, src, toPrintable, toPrintableIndented, dumpColumns, repairMap };
  }
}

export { BracketScanner };
