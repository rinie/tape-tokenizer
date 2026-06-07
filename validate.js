// validate.js  —  run with: node validate.js [lang] [file...]
//
// The milestone-4 discipline: a lexical table is a HYPOTHESIS. Run the scanner
// over real files and check whether the structure comes out balanced. A
// known-good file that reports an imbalance reveals a hole in the table — that
// is the signal we want, not a failure to hide.
//
//   node validate.js                 → run the built-in suite
//   node validate.js js foo.js bar.js
//   node validate.js py sample.py
//
// Languages: js | c | py | xml

import { readFileSync } from 'fs';
import { LexicalScanner, JS_TABLE, C_TABLE, PYTHON_TABLE, XML_TABLE } from './lexical-scanner.js';

const TABLES = { js: JS_TABLE, c: C_TABLE, py: PYTHON_TABLE, xml: XML_TABLE };

function lineOf(src, offset) {
  // 1-based line number — human-facing, above the waterline
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src.charCodeAt(i) === 0x0A) line++;
  }
  return line;
}

function validateFile(path, table) {
  let src;
  try {
    src = readFileSync(path, 'utf8');
  } catch (e) {
    return { path, error: e.message };
  }
  const sc = new LexicalScanner();
  const r = sc.scan(src, table);
  const findings = r.repairMap().map((f) => ({ ...f, line: lineOf(src, f.offset ?? f.startOffset ?? 0) }));
  return {
    path,
    bytes: src.length,
    tokens: r.length,
    selfContained: r.selfContained(),
    errors: findings.filter((f) => f.severity === 'error'),
    seams: findings.filter((f) => f.severity === 'warning'),
    stoppedEarly: r.unterminated,
  };
}

function report(res) {
  if (res.error) {
    console.log(`  ✗ ${res.path}  — ${res.error}`);
    return;
  }
  // Three outcomes: clean, seam-only (warning — not self-contained), error.
  let verdict;
  if (res.errors.length) verdict = `✗ ${res.errors.length} error(s)`;
  else if (res.seams.length) verdict = `⚠ ${res.seams.length} seam(s)`;
  else verdict = '✓ balanced';
  const stop = res.stoppedEarly ? `  [stopped early: ${res.stoppedEarly.kind} @${res.stoppedEarly.startOffset}]` : '';
  console.log(`  ${verdict.padEnd(14)} ${res.path}  (${res.tokens} structural tokens, ${res.bytes} bytes)${stop}`);
  for (const f of [...res.errors, ...res.seams]) {
    const span = f.endOffset !== undefined ? `off ${f.offset}→${f.endOffset}` : `off ${f.offset}`;
    const sev = f.severity === 'warning' ? 'seam' : 'error';
    console.log(`       • [${sev}] line ${f.line}: ${f.kind} '${f.char}'  (${span})${f.note ? ' — ' + f.note : ''}`);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.length >= 2) {
    const lang = args[0];
    const table = TABLES[lang];
    if (!table) {
      console.error(`unknown language '${lang}' — use one of: ${Object.keys(TABLES).join(', ')}`);
      process.exit(2);
    }
    console.log(`── validating ${args.length - 1} file(s) as '${lang}' ──`);
    for (const f of args.slice(1)) report(validateFile(f, table));
    return;
  }

  // Built-in suite: scan the repo's own source (real, known-good files).
  console.log('── built-in suite ───────────────────────────────────────────');
  console.log('JS_TABLE vs the repo\'s own JavaScript (should be balanced):');
  for (const f of ['bracket-scanner.js', 'lexical-scanner.js', 'demo-bracket.js',
                   'demo-lexical.js', 'demo.js', 'token-tags.js', 'tokenizer.js', 'validate.js']) {
    report(validateFile(f, JS_TABLE));
  }
  console.log('\nC_TABLE vs real C (self-contained vs a fragment with seams):');
  report(validateFile('samples/sample.c', C_TABLE));
  report(validateFile('samples/fragment.inc.c', C_TABLE));

  console.log('\nPYTHON_TABLE vs a real Python file:');
  report(validateFile('samples/sample.py', PYTHON_TABLE));
  console.log('\nXML_TABLE vs a real XML fragment:');
  report(validateFile('samples/sample.xml', XML_TABLE));
}

main();
