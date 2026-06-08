// demo-bracket.js  —  run with: node demo-bracket.js
import { BracketScanner } from '../bracket-scanner.js';

const scanner = new BracketScanner();

// ── test 1: balanced JS-like snippet ────────────────────────────────────────
console.log('═══ test 1: balanced snippet ═══════════════════════════════════');
const src1 = `function foo(a, b) {
  if (a > 0) {
    return [a, b];
  }
}`;

const r1 = scanner.scan(src1);
console.log(`tokens: ${r1.length}`);
console.log('toPrintable:   ', r1.toPrintable());
console.log('toPrintableIndented:\n' + r1.toPrintableIndented());
console.log('\ndumpColumns (with context):');
console.log(r1.dumpColumns({ showContext: true }));
console.log('\nrepairMap:', r1.repairMap());

// ── test 2: unbalanced input ─────────────────────────────────────────────────
console.log('\n\n═══ test 2: unbalanced input ════════════════════════════════');
const src2 = '{ [a, (b] }';
const r2 = scanner.scan(src2);
console.log('toPrintable:   ', r2.toPrintable());
console.log('\ndumpColumns:');
console.log(r2.dumpColumns({ showContext: true }));
console.log('\nrepairMap:', r2.repairMap());

// ── test 3: deeply nested ────────────────────────────────────────────────────
console.log('\n\n═══ test 3: depth check ═════════════════════════════════════');
const src3 = '{ { { () } } }';
const r3 = scanner.scan(src3);
console.log('toPrintable:   ', r3.toPrintable());
console.log('\ndumpColumns:');
console.log(r3.dumpColumns());

// ── test 4: orphan close ─────────────────────────────────────────────────────
console.log('\n\n═══ test 4: orphan close ════════════════════════════════════');
const src4 = 'a + b) * c';
const r4 = scanner.scan(src4);
console.log('toPrintable:   ', r4.toPrintable());
console.log('repairMap:', r4.repairMap());

// ── test 5: printable projection side-by-side with source ────────────────────
console.log('\n\n═══ test 5: real-world skeleton ═════════════════════════════');
const src5 = `
class Foo extends Bar {
  constructor(x) { super(x); this.items = []; }
  get(i) { return this.items[i]; }
}
`.trim();
const r5 = scanner.scan(src5);
console.log('printable skeleton:', r5.toPrintable());
console.log('repairMap:', r5.repairMap());
