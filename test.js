// test.js — regression assertions for the unified tape and the tools that
// ride it. validate.js checks real files against the lexical tables; this file
// pins down specific lexing/structure behaviours that once went wrong.
//
//   node test.js            (exit 0 = all pass, 1 = a failure)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UniLexer, KLASS } from './unilexer.js';
import { LexicalScanner, XML_TABLE, HTML_TABLE, JS_TABLE } from './lexical-scanner.js';
import { mergeGate } from './mergegate.js';
import { topLevelUnits } from './sfdiff.js';
import { analyze } from './defuse.js';

const L = new UniLexer();
let failed = 0;
let passed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}

// significant tokens as [mnemonic, lexeme] pairs; every tape must also be lossless
function sig(tp) {
  assert.equal(tp.reconstruct(), tp.src, 'tape is not lossless');
  const out = [];
  for (let t = 0; t < tp.length; t++) {
    const k = tp.classOf(t);
    if (k !== KLASS.WS) out.push([tp.mnemonicOf(t), tp.lexemeOf(t)]);
  }
  return out;
}
const indentTokens = (tp) => sig(tp).filter(([m]) => m === ':{' || m === '}:');

console.log('── unilexer ──');

test("JS: '/*/' does not close the block comment it opens", () => {
  const s = sig(L.tokenize('a /*/ b */ c'));
  assert.deepEqual(s, [['I', 'a'], ['#', '/*/ b */'], ['I', 'c']]);
});

test("SQL: '/*/' does not close the block comment it opens", () => {
  const tp = L.tokenizeSql('select 1 /*/ (x */ from dual');
  assert.equal(tp.repairMap().length, 0);
});

test('JS: #private names are identifiers, not comments', () => {
  const s = sig(L.tokenize('class A { #x = 1; m() { return this.#x } }'));
  assert.equal(s.filter(([, l]) => l === '#x').length, 2);
  assert.ok(s.every(([m, l]) => l !== '#x' || m === 'I'));
});

test('JS: hashbang line is a comment', () => {
  const s = sig(L.tokenize('#!/usr/bin/env node\nlet a = 1'));
  assert.deepEqual(s[0], ['#', '#!/usr/bin/env node']);
});

test('JS: a UTF-8 BOM is whitespace, not part of the first identifier', () => {
  const s = sig(L.tokenize('\uFEFFimport x from "y"'));
  assert.deepEqual(s[0], ['M', 'import']);
});

test('numbers: exponent needs digits; BigInt suffix is JS-only', () => {
  assert.deepEqual(sig(L.tokenize('1n + 2e3'))[0], ['N', '1n']);
  assert.deepEqual(sig(L.tokenize('1n + 2e3'))[2], ['D', '2e3']);
  assert.deepEqual(sig(L.tokenizePy('x = 3eggs\n')).slice(2, 4), [['N', '3'], ['I', 'eggs']]);
});

test('Python: a bracket closing mid-line does not open an indent level', () => {
  assert.deepEqual(indentTokens(L.tokenizePy('x = foo(\n    a\n) + 1\ny = 2\n')), []);
});

test("Python: '\\' line continuation does not open an indent level", () => {
  assert.deepEqual(indentTokens(L.tokenizePy('x = 1 + \\\n    2\ny = 3\n')), []);
  assert.deepEqual(indentTokens(L.tokenizePy('x = 1 + \\\r\n    2\r\ny = 3\r\n')), []);
});

test('Python: real blocks still indent and dedent', () => {
  const tp = L.tokenizePy('if a:\n    b = (1,\n  2)\nc\n');
  assert.deepEqual(indentTokens(tp).map(([m]) => m), [':{', '}:']);
  assert.equal(tp.repairMap().length, 0);
});

test("Python: '//=' is one operator", () => {
  assert.ok(sig(L.tokenizePy('x //= 2\n')).some(([m, l]) => m === '//=' && l === '//='));
});

test("YAML: an apostrophe inside a plain scalar is not a quote", () => {
  const s = sig(L.tokenizeYaml("a:\n  msg: don't do it\n  b: [1, 2]\nc: 'x'\n"));
  assert.ok(s.some(([, l]) => l === "don't"));
  assert.ok(s.some(([m, l]) => m === "'" && l === "'x'"));
  assert.ok(s.some(([m]) => m === '['));
});

test("YAML: '#' opens a comment only after whitespace", () => {
  const s = sig(L.tokenizeYaml('a: foo#bar # c\n'));
  assert.ok(s.some(([m, l]) => m === 'I' && l === 'foo#bar'));
  assert.ok(s.some(([m, l]) => m === '#' && l === '# c'));
});

test('YAML: hex numbers are integers', () => {
  assert.ok(sig(L.tokenizeYaml('b: 0x1E\n')).some(([m, l]) => m === 'N' && l === '0x1E'));
});

console.log('\n── lexical-scanner ──');

test('XML: a bare < in text does not swallow the next tag', () => {
  const r = new LexicalScanner().scan('<p>a < b</p>', XML_TABLE);
  assert.equal(r.repairMap().length, 0);
});

test('XML: improper nesting is reported once per open tag', () => {
  const r = new LexicalScanner().scan('<a><b><c></a></b></c>', XML_TABLE);
  assert.deepEqual(r.repairMap().map((f) => `${f.kind}:${f.char}`), ['improper-nesting:b', 'improper-nesting:c']);
});

test('HTML: void elements and upper-case names balance', () => {
  const src = '<!DOCTYPE html>\n<HTML><head><meta charset="utf-8"><link rel="x"></head>\n'
    + '<body><p>a<br>b</P><img src="z"><hr/></body></html>\n';
  assert.equal(new LexicalScanner().scan(src, HTML_TABLE).repairMap().length, 0);
});

console.log('\n── tools ──');

test('mergeGate: an unterminated string in the merge is not safe', () => {
  const ours = 'function a() {\n  return "1";\n}\n';
  const theirs = 'function a() {\n  return "2";\n}\n';
  assert.equal(mergeGate(ours, theirs, 'function a() {\n  return "2;\n}\n', JS_TABLE).safe, false);
  assert.equal(mergeGate(ours, theirs, theirs + '/* trailing', JS_TABLE).safe, false);
  assert.equal(mergeGate(ours, theirs, theirs, JS_TABLE).safe, true);
});

test('sfdiff: a function nested in top-level code is not a top-level unit', () => {
  const units = topLevelUnits(L.tokenize('const run = () => {\n  function helper() { return 1 }\n}\nfunction top() {}\n'));
  assert.deepEqual(units.map((u) => u.name), ['top', '(top-level code)']);
});

test('defuse: a function nested in top-level code is not a top-level def', () => {
  const { du } = analyze('(function () { function inner() {} })();\nfunction outer() { inner() }\n');
  assert.deepEqual(du.defs.map((d) => d.name), ['outer']);
});

test('tfind: malformed objects terminate (no infinite loop)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tfind-'));
  try {
    for (const [i, body] of ['{"needle": }', '[{ "needle" }]', '{"a": ], "needle": 1}'].entries()) {
      const f = join(dir, `bad${i}.json`);
      writeFileSync(f, body);
      const r = spawnSync(process.execPath, ['tfind.js', 'needle', f], { timeout: 5000, encoding: 'utf8' });
      assert.equal(r.error, undefined, `${body}: ${r.error?.code}`);
      assert.equal(r.status, 0, `${body}: exit ${r.status}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`\n── ${passed} passed, ${failed} failed ──`);
process.exit(failed ? 1 : 0);
