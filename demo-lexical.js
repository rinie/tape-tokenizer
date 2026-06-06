// demo-lexical.js  —  run with: node demo-lexical.js
import { LexicalScanner, JS_TABLE, XML_TABLE } from './lexical-scanner.js';

const sc = new LexicalScanner();

// ── test 1: brackets inside strings/comments are IGNORED ─────────────────────
console.log('═══ test 1: strings & comments hide their brackets ══════════════');
const src1 = `function f(a) {
  const s = "a ) string ] with } brackets";
  // a comment ) ] } too
  /* block ) ] } comment */
  return [a];
}`;
const r1 = sc.scan(src1, JS_TABLE);
console.log('printable:', r1.toPrintable(), '  (only real structure: (){[]})');
console.log('repairMap:', r1.repairMap());

// ── test 2: backtick template that runs to EOF — note start, DON'T guess end ──
console.log('\n═══ test 2: unterminated template literal (the key case) ════════');
const src2 = 'const x = foo({ a: 1 }); const y = `unterminated ${bar} to the end (((';
const r2 = sc.scan(src2, JS_TABLE);
console.log('printable:', r2.toPrintable(), '  (the (((  after the backtick are NOT counted)');
console.log('unterminated:', r2.unterminated);
console.log('repairMap:', r2.repairMap());

// ── test 3: unterminated block comment — also a hard stop ────────────────────
console.log('\n═══ test 3: unterminated block comment ══════════════════════════');
const src3 = 'a(b) { /* never closed ] } ) ';
const r3 = sc.scan(src3, JS_TABLE);
console.log('printable:', r3.toPrintable());
console.log('unterminated:', r3.unterminated);
console.log('repairMap:', r3.repairMap());

// ── test 4: single-line string hitting newline — bounded, resume as code ─────
console.log('\n═══ test 4: single-line string newline = grammar-bounded ════════');
const src4 = 'foo("oops no close\n) + bar()';
const r4 = sc.scan(src4, JS_TABLE);
console.log('printable:', r4.toPrintable(), '  (scanning RESUMED after the newline)');
console.log('repairMap:', r4.repairMap());

// ── test 5: XML without envelope (no root), proper nesting ───────────────────
console.log('\n═══ test 5: XML fragment, no root element ═══════════════════════');
const src5 = `<item id="1">a</item>
<item id="2"><b>x</b></item>
<!-- a comment <not a tag> -->`;
const r5 = sc.scan(src5, XML_TABLE);
console.log('printable:', r5.toPrintable());
console.log('outline (depth-0, breadth-first):');
for (const t of r5.outline()) console.log('   ', t);
console.log('repairMap:', r5.repairMap());

// ── test 6: XML improper nesting — reported, not enforced ────────────────────
console.log('\n═══ test 6: improper nesting <b><i></b></i> ═════════════════════');
const src6 = '<b><i>text</b></i>';
const r6 = sc.scan(src6, XML_TABLE);
console.log('printable:', r6.toPrintable());
console.log('dumpColumns:');
console.log(r6.dumpColumns({ showContext: true }));
console.log('repairMap:', r6.repairMap());

// ── test 7: unterminated XML tag (missing '>') — note start, stop ────────────
console.log('\n═══ test 7: unterminated XML tag ════════════════════════════════');
const src7 = '<a><b attr="v" oops to the end';
const r7 = sc.scan(src7, XML_TABLE);
console.log('printable:', r7.toPrintable());
console.log('unterminated:', r7.unterminated);
console.log('repairMap:', r7.repairMap());
