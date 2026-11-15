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
import { outlineView } from './tdump.js';

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

const htmlFindings = (src) => new LexicalScanner().scan(src, HTML_TABLE).repairMap().map((f) => `${f.kind}:${f.char}`);

test('HTML: optional end tags (li, p, dt/dd, option) are implied, not seams', () => {
  assert.deepEqual(htmlFindings('<ul><li>a<li>b<ul><li>c<li>d</ul><li>e</ul>'), []);
  assert.deepEqual(htmlFindings('<body><p>one<p>two<div>x</div><p>three<hr><p>four</body>'), []);
  assert.deepEqual(htmlFindings('<dl><dt>a<dd>b<dt>c<dd>d</dl>'), []);
  assert.deepEqual(htmlFindings('<select><optgroup label=x><option>1<option>2<optgroup label=y><option>3</select>'), []);
});

test('HTML: table sections, rows and cells close implicitly', () => {
  assert.deepEqual(htmlFindings('<table><thead><tr><th>A<th>B<tbody><tr><td>1<td>2<tr><td>3</table>'), []);
});

test('HTML: end of input closes html/head/body/p', () => {
  const r = new LexicalScanner().scan('<!DOCTYPE html><html><head><title>t</title><body><p>hi', HTML_TABLE);
  assert.equal(r.repairMap().length, 0);
  const implied = [...r.tags].map((t, i) => (t === 0x7E ? r.nameOf(i) : null)).filter(Boolean);
  assert.deepEqual(implied, ['head', 'p', 'body', 'html']);
});

test('HTML: a nested list item does not close the outer one', () => {
  const r = new LexicalScanner().scan('<ul><li>a<ul><li>b</ul></ul>', HTML_TABLE);
  const outerLi = 1;
  assert.equal(r.nameOf(outerLi), 'li');
  assert.equal(r.nameOf(r.jumps[outerLi]), 'li');
  assert.ok(r.offsets[r.jumps[outerLi]] > r.src.indexOf('</ul>'), 'outer li must close at the outer </ul>');
});

test('HTML: a block start tag ends <p> through inline elements', () => {
  const r = new LexicalScanner().scan('<p><b><i>x</i>y<div>z</div>', HTML_TABLE);
  assert.deepEqual(r.repairMap().map((f) => `${f.kind}:${f.char}`), ['improper-nesting:b']);
  const implied = [...r.tags].map((t, i) => (t === 0x7E ? r.nameOf(i) : null)).filter(Boolean);
  assert.deepEqual(implied, ['b', 'p'], 'the <b> and the <p> end where <div> starts');
  assert.deepEqual(htmlFindings('<ul><li><a href=x>a<li>b</ul>'), ['improper-nesting:a']);
  assert.deepEqual(htmlFindings('<p><b>x</b><div>y</div>'), []);
  // <button> is a scope barrier: the <div> inside it does not end the <p>
  assert.deepEqual(htmlFindings('<p><button>x<div>y</div></button>'), []);
  const b = new LexicalScanner().scan('<p><button>x<div>y</div></button>', HTML_TABLE);
  assert.equal(b.offsets[b.jumps[0]], b.src.length, 'the <p> ends at end of input, not at the <div>');
});

const impliedAt = (src) => {
  const r = new LexicalScanner().scan(src, HTML_TABLE);
  return [...r.tags].map((t, i) => (t === 0x7E ? `${r.nameOf(i)}@${r.offsets[i]}` : null)).filter(Boolean);
};

test('HTML: <head> ends at the first content it cannot hold', () => {
  const src = '<html><head><meta charset=x><title>t</title>\n<div>x</div></html>';
  assert.deepEqual(htmlFindings(src), []);
  assert.deepEqual(impliedAt(src), [`head@${src.indexOf('<div>')}`]);
  const text = '<head><link rel=a>\n  Hello';
  assert.deepEqual(impliedAt(text), [`head@${text.indexOf('Hello')}`]);
  // comments, whitespace and head content keep it open
  assert.deepEqual(impliedAt('<head><title>t</title> <!-- c --> <style>p{}</style></head>'), []);
  // a <noscript> in head is a required-end element: its <link> does not end <head>
  assert.deepEqual(impliedAt('<head><noscript><link></noscript><p>a'), ['head@33', 'p@37']);
  // an explicit </head> after body content has nothing left to close
  assert.deepEqual(htmlFindings('<head><title>t</title>x</head>'), ['orphan-close-tag:head']);
});

test('HTML: <colgroup> ends at anything but <col>', () => {
  assert.deepEqual(impliedAt('<table><colgroup><col><col><tr><td>1</table>'), ['colgroup@27', 'td@36', 'tr@36']);
  assert.deepEqual(impliedAt('<table><colgroup><col> x </table>'), ['colgroup@23']);
  assert.deepEqual(htmlFindings('<table><colgroup><col>\n<caption>c</caption><tr><td>1</table>'), []);
});

test('HTML: required end tags are still reported', () => {
  assert.deepEqual(htmlFindings('<div><b>x</div>'), ['improper-nesting:b', 'unclosed-tag:b']);
  assert.deepEqual(htmlFindings('<p>a</p></p>'), ['orphan-close-tag:p']);
  assert.deepEqual(htmlFindings('<div><p>a'), ['unclosed-tag:div']);
});

test('XML: optional end tags are an HTML-only rule', () => {
  const r = new LexicalScanner().scan('<ul><li>a<li>b</ul>', XML_TABLE);
  assert.deepEqual(r.repairMap().map((f) => f.kind).sort(), ['improper-nesting', 'improper-nesting', 'unclosed-tag', 'unclosed-tag']);
});

console.log('\n── unilexer HTML mode ──');

const HTML_PAGE = '<!DOCTYPE html>\n<HTML><head><meta charset="utf-8"><title>a<b</title>\n'
  + '<script>if (a<b && c>d) x="</div>";</script><body><ul id="m"><li>a<li>b <b>c</b></ul>'
  + '<table><tr><td>1<td>2<tr><td>3</table><p>one<p>two<br><img src="x"/><div>x</div>';

test('HTML: lossless, balanced, same verdict as the structural scanner', () => {
  const t = L.tokenizeHtml(HTML_PAGE);
  assert.equal(t.reconstruct(), HTML_PAGE);
  assert.deepEqual(t.repairMap(), []);
  assert.deepEqual(new LexicalScanner().scan(HTML_PAGE, HTML_TABLE).repairMap(), []);
});

test('HTML: implied closes are zero-width ~ tokens linked to their opener', () => {
  const t = L.tokenizeHtml('<ul><li>a<li>b</ul>');
  const rows = [];
  for (let i = 0; i < t.length; i++) if (t.classOf(i) === KLASS.TAG) rows.push(`${t.mnemonicOf(i)}${t.lexemeOf(i)}@${t.offsetOf(i)}→${t.linkOf(i)}`);
  assert.deepEqual(rows, ['{ul@0→7', '{li@4→3', '~li@9→1', '{li@9→6', '~li@14→4', '}ul@14→0']);
  for (let i = 0; i < t.length; i++) if (t.tagOf(i) === 0x7E) assert.equal(t.rawOf(i), '', 'implied close must be zero-width');
});

test('HTML: unilexer ends <p> through inline elements too', () => {
  const t = L.tokenizeHtml('<p><b>x<div>y</div>');
  const ends = [];
  for (let i = 0; i < t.length; i++) if (t.tagOf(i) === 0x7E) ends.push(`${t.lexemeOf(i)}@${t.offsetOf(i)}`);
  assert.deepEqual(ends, ['b@7', 'p@7']);
  assert.deepEqual(t.repairMap(), []);
});

test('HTML: unilexer ends <head>/<colgroup> on content, at the first visible char', () => {
  for (const src of ['<head><link rel=a>\n  Hello <b>w</b>', '<table><colgroup><col><tr><td>1</table>']) {
    const t = L.tokenizeHtml(src);
    assert.equal(t.reconstruct(), src);
    assert.deepEqual(t.repairMap(), []);
  }
  const t = L.tokenizeHtml('<head><link rel=a>\n  Hello');
  const i = [...Array(t.length).keys()].find((k) => t.tagOf(k) === 0x7E);
  assert.equal(t.lexemeOf(i), 'head');
  assert.equal(t.offsetOf(i), 21);
  assert.equal(t.lexemeOf(i + 1), 'Hello');
});

test('HTML: void elements are complete; names fold to lower case', () => {
  const s = sig(L.tokenizeHtml('<P>a<BR>b<img src="x"></p>'));
  assert.deepEqual(s.filter(([m]) => '{}/~'.includes(m)).map(([m, l]) => m + l), ['{p', '/br', '/img', '}p']);
});

test('HTML: script/style/title content is text, not markup', () => {
  const s = sig(L.tokenizeHtml('<script>if (a<b) x = "</div>";</script><title>a<b</title>'));
  assert.deepEqual(s.map(([m]) => m).join(' '), '{ T } { T }');
});

test('XML mode is unchanged by the HTML rules', () => {
  const t = L.tokenizeXml('<ul><li>a<li>b</ul><br>');
  assert.equal(t.repairMap().map((f) => f.kind).sort().join(), 'unclosed-tag,unclosed-tag,unclosed-tag');
});

test('tfind: HTML breadcrumb names elements and zooms to the innermost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tfind-'));
  try {
    const f = join(dir, 'page.html');
    writeFileSync(f, '<body><ul id="menu"><li>Home<li>About <b>us</b></ul><p>x</body>');
    const r = spawnSync(process.execPath, ['tfind.js', 'About', f], { timeout: 5000, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /breadcrumb \(innermost first\): li <- ul#menu <- body/);
    assert.match(r.stdout, /\n<li>About <b>us<\/b>\n/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('tdump --outline: XML/HTML attributes are hidden, the element tree stays', () => {
  const xml = `<a x="1"><b y="2"/><c/><d z=3 w='4'>t</d></a>`;
  const body = (out) => out.split('\n').slice(1);    // drop the header line
  assert.deepEqual(body(outlineView(xml, 'xml', 3)),
    ['{ a', '  / b', '  / c', '  { d', '    T t', '  } d', '} a']);
  const html = '<ul id="m" class=x><li><a href="/">Home</a><li><img src="i.png" alt="">x</ul>';
  assert.deepEqual(body(outlineView(html, 'html', 3)),
    ['{ ul', '  { li', '    { a … 1 … } a', '  ~ li', '  { li', '    / img', '    T x', '  ~ li', '} ul']);
  // other languages are untouched: a JSON key is not an attribute
  assert.match(outlineView('{"a": 1}', 'json5', 2), /" "a"/);
});

console.log(`\n── ${passed} passed, ${failed} failed ──`);
process.exit(failed ? 1 : 0);
