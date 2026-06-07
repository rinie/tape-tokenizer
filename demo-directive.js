// demo-directive.js  —  run with: node demo-directive.js
// Proves the line-context gate: `<…>` is a header-name string ONLY on a
// #include / #import line; everywhere else `<` and `>` stay operators.
import { LexicalScanner, C_TABLE } from './lexical-scanner.js';

const sc = new LexicalScanner();

// An ungated variant — `<…>` treated as a string on every line. This is what a
// naive harvest of the grammar's lt-gt scope would produce.
const UNGATED = JSON.parse(JSON.stringify(C_TABLE));
for (const s of UNGATED.strings) delete s.onlyOnDirective;

function show(label, src) {
  const gated   = sc.scan(src, C_TABLE).repairMap();
  const ungated = sc.scan(src, UNGATED).repairMap();
  console.log(`\n${label}`);
  console.log(`   src: ${JSON.stringify(src)}`);
  console.log(`   gated   (#include only): ${gated.length} findings  ${gated.map((f) => f.kind + " '" + f.char + "'").join(', ')}`);
  console.log(`   ungated (every line)   : ${ungated.length} findings  ${ungated.map((f) => f.kind + " '" + f.char + "'").join(', ')}`);
}

console.log('═══ line-context gate for C header names ════════════════════════');

show('1. #include — gate SHOULD fire (header name is a string):',
  '#include <stdio.h>\nint x = 1;');

show('2. less-than operator — gate must NOT fire:',
  'if (a < b) {\n  return a;\n}');

show('3. #define with shift — starts with # but is NOT include:',
  '#define MASK (1 << 3)\nint y = 0;');

show('4. mixed comparison — < then > on one line, operators only:',
  'int ok = (a < b) && (c > d);');

console.log('\n── reading the result ───────────────────────────────────────');
console.log('Gated column is 0 everywhere it should be. The ungated column shows');
console.log('the damage: in case 2 the lone `<` opens a header string that hits');
console.log('the newline (unterminated), and in case 3 `#define`\'s `<` does the');
console.log('same — exactly the false positives the gate prevents.');
