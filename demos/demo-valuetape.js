// demo-valuetape.js — run with: node demos/demo-valuetape.js
// §13b: a lossless, fully-pooled value tape. Every token indexed into a per-kind
// pool listed beside the tape; dedup keyed to uniqueness; reconstructable.
import { ValueTape } from '../valuetape.js';

const src = `// a small sample
function add(a, b) {
  const sum = a + b;
  const sum2 = a + b;          // identical whitespace + idents repeat
  return /[0-9]+/.test(sum) ? sum : 0;
}

const result = add(1, 2);
const again  = add(3, 4);
`;

const vt = new ValueTape().tokenize(src);

console.log('═══ tape ════════════════════════════════════════════════════════');
console.log(`${vt.length} tokens over ${src.length} bytes (every byte covered).`);

console.log('\n═══ pools listed next to the lexer (dedup keyed to uniqueness) ══');
console.log('  kind            tokens  entries  policy        compression');
for (const s of vt.poolStats()) {
  if (s.tokens === 0) continue;
  const policy = s.interned ? 'interned' : 'per-occurrence';
  const ratio = s.entries ? (s.tokens / s.entries).toFixed(2) + '×' : '—';
  console.log(`  ${s.name.padEnd(14)}  ${String(s.tokens).padStart(6)}  ${String(s.entries).padStart(7)}  ${policy.padEnd(14)} ${s.interned ? ratio : '—'}`);
}

console.log('\n═══ losslessness — reconstruct FROM THE POOLS ═══════════════════');
const round = vt.reconstruct();
console.log('  reconstruct() === source :', round === src ? 'PASS ✓ (byte-for-byte)' : 'FAIL ✗');

console.log('\n═══ cross-reference (interned pools carry occurrence offsets) ═══');
console.log('  this is the substrate §13a queries — every use of a name, for free:');
for (const name of ['add', 'sum', 'b']) {
  const occ = vt.occurrences(vt.K.IDENT, name);
  console.log(`    ident "${name}" → ${occ.length} occurrence(s) at offsets [${occ.join(', ')}]`);
}
const wsRuns = vt.poolStats().find((s) => s.name === 'ws');
console.log(`    whitespace: ${wsRuns.tokens} runs collapsed to ${wsRuns.entries} unique entries`);

console.log('\n── reading the result ───────────────────────────────────────');
console.log('Interned kinds (ws, ident, keyword, punct) compress — the same few');
console.log('lexemes repeat; each entry keeps its occurrence offsets. Literal kinds');
console.log('(number, string, regex, comment) are stored once per occurrence. The');
console.log('dense tape is just integers; the pools beside it hold the text, and');
console.log('together they rebuild the source exactly.');
