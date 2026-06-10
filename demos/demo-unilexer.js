// demo-unilexer.js — run with: node demos/demo-unilexer.js
// The lexer consolidation: one pass, one tape carrying both layers — and the
// tag byte IS the printable mnemonic (token-tags.js as the tape encoding).
import { UniLexer, KLASS } from '../unilexer.js';

const src = `// totals
function add(a, b) {
  const sum = a + b;
  return sum;
}

const nums = [1, 2.5, 0xFF];
const re = /['"]/g;
const greeting = \`hi \${nums[0]}\`;
if (add(1, 2) > 2) { console.log(greeting); }
`;

const u = new UniLexer().tokenize(src);

console.log('═══ the mnemonic projection (one tag byte per token) ═════════════');
console.log('source, then its ghost — keywords whisper (f,c,r,i), literals shout');
console.log('(I,N,D,S,X,R), brackets are literal, ops are =, whitespace breathes:\n');
for (const [line, ghost] of zipLines(src, u)) {
  console.log('  src   │ ' + line);
  console.log('  ghost │ ' + ghost);
}

console.log('═══ the dump: tag char + derived class + structure, one tape ═════');
console.log(u.dump({ limit: 14 }));
console.log(`  … (${u.length} tokens total)`);

console.log('\n═══ both layers on one tape ═══════════════════════════════════════');
console.log('  reconstruct() === source :', u.reconstruct() === src ? 'PASS ✓ (lossless, from the pools)' : 'FAIL ✗');
const opens = [];
for (let t = 0; t < u.length; t++) {
  if (u.charOf(t) === '{' && u.linkOf(t) !== -1) opens.push(t);
}
const body = opens[0];
console.log(`  structural links: '{' at tape[${body}] → '}' at tape[${u.linkOf(body)}] (O(1) body skip)`);
console.log('  repairMap:', JSON.stringify(u.repairMap()));

console.log('\n═══ pools (dedup keyed to uniqueness, occurrences kept) ═══════════');
for (const s of u.poolStats()) {
  if (!s.tokens) continue;
  console.log(`  ${s.name.padEnd(9)} ${String(s.tokens).padStart(4)} tokens → ${String(s.entries).padStart(3)} entries  ${s.interned ? '(interned)' : '(per-occurrence)'}`);
}
console.log(`  ident "add" occurs at offsets [${u.occurrences(KLASS.IDENT, 'add').join(', ')}]`);

console.log('\n── reading the result ───────────────────────────────────────');
console.log('One scan emits the value layer (pools, lossless) AND the structural');
console.log('layer (links, depth) on the same tape, and the single tag byte is');
console.log('simultaneously the machine class (via a 256-entry lookup) and the');
console.log('human mnemonic. sfdiff.js now rides this; tokenizer.js and');
console.log('lexical-scanner.js are the remaining migration targets.');

// helper: render src lines beside their mnemonic ghost (same byte widths,
// because the projection is one char per token but tokens span many chars —
// so the ghost is built per line from the tokens that start on that line).
function zipLines(source, tape) {
  const lines = source.split('\n');
  const perLine = lines.map(() => '');
  let lineNo = 0; let lineStart = 0;
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  for (let t = 0; t < tape.length; t++) {
    const off = tape.offsetOf(t);
    while (lineNo + 1 < starts.length && off >= starts[lineNo + 1]) { lineNo++; lineStart = starts[lineNo]; }
    const ch = tape.charOf(t);
    if (ch !== ' ') perLine[lineNo] += ch;
    else if (perLine[lineNo] && !perLine[lineNo].endsWith(' ')) perLine[lineNo] += ' ';
  }
  return lines.map((l, k) => [l, perLine[k] ?? '']).filter(([l, g]) => l.trim() || g.trim());
}
