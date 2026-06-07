// demo-seams.js  —  run with: node demo-seams.js
//
// C is two structure systems on one file: free-form braces, and the line-based
// preprocessor conditional family (#if … #endif). We scan as-written, WITHOUT
// expanding #include. A self-contained file proves itself well-formed. A file
// whose structure only closes across an include/file boundary shows up as a
// SEAM — a warning, not an error: "this isn't a clean standalone text file."
import { LexicalScanner, C_TABLE } from './lexical-scanner.js';

const sc = new LexicalScanner();

function show(label, src) {
  const r = sc.scan(src, C_TABLE);
  console.log(`\n${label}`);
  console.log('   printable :', JSON.stringify(r.toPrintable()));
  console.log('   self-contained:', r.selfContained());
  const seams = r.seams();
  if (seams.length === 0) {
    console.log('   seams: none ✓');
  } else {
    console.log(`   ⚠ ${seams.length} seam(s):`);
    for (const f of seams) {
      const span = f.endOffset !== undefined ? `off ${f.offset}→${f.endOffset}` : `off ${f.offset}`;
      console.log(`       • ${f.kind} '${f.char}'  (${span})${f.seam ? '  [' + f.seam + ']' : ''}`);
    }
  }
}

console.log('═══ #if/#endif as a second bracket family + file seams ══════════');

show('1. self-contained (include guard closes, braces nest) — clean:', `#ifndef FOO_H
#define FOO_H
struct P { int x, y; };
int f(int a) { return a > 0 ? a : -a; }
#endif`);

show('2. header FRAGMENT: #if with no #endif in this file — a seam:', `#if WITH_EXTRAS
void extra(void) { do_it(); }
// ... #endif lives in whatever includes us`);

show('3. macro opens a brace it never closes — a seam:', `#define BEGIN_NS namespace x {
BEGIN_NS
int g(void) { return 0; }
// the closing } is supplied by a matching END_NS elsewhere`);

show('4. the classic interleave: #if straddles a { } — a crossing:', `#if FOO
void f() {
#else
void f() { other();
#endif
}`);

show('5. stray #endif with no #if — a BOF seam:', `int ok = 1;
#endif
int after = 2;`);

console.log('\n── reading the result ───────────────────────────────────────');
console.log('Only case 1 is self-contained. 2–5 are seams: the file is not a');
console.log('nice standalone text file — its structure closes (if at all) across');
console.log('an include boundary. We WARN and point at both boundaries; we never');
console.log('fault, and we never expand the includes to "fix" it.');
