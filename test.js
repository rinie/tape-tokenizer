// test.js — regression assertions for the unified tape and the tools that
// ride it. validate.js checks real files against the lexical tables; this file
// pins down specific lexing/structure behaviours that once went wrong.
//
//   node test.js            (exit 0 = all pass, 1 = a failure)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

test('tfind: a match ending in a newline keeps its header on one line', () => {
  const r = spawnSync(process.execPath, ['tfind.js', '25.50', 'samples/sample.html'], { timeout: 5000, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^── token \d+: 25\.50\\n {3}──$/m);   // '25.50\n  ' + ' ──'
});

console.log('\n── unilexer qmd mode ──');

// structural tokens (tags + declarations) as 'mnemonic lexeme'; lossless
const qmdTags = (src) => {
  const tp = L.tokenizeQmd(src);
  assert.equal(tp.reconstruct(), src, 'tape is not lossless');
  const out = [];
  for (let t = 0; t < tp.length; t++) {
    const k = tp.classOf(t);
    if (k === KLASS.TAG || k === KLASS.DECL) out.push(`${tp.mnemonicOf(t)} ${tp.lexemeOf(t)}`);
  }
  return { out, findings: tp.repairMap().map((f) => `${f.kind}:${f.char}`), tp };
};

test('qmd: a heading of the same or a higher level ends a section (~)', () => {
  const { out, findings } = qmdTags('# A\ntext\n## B\n### C\n## D\n# E\n');
  assert.deepEqual(out, ['{ h1', '{ h2', '{ h3', '~ h3', '~ h2', '{ h2', '~ h2', '~ h1', '{ h1', '~ h1']);
  assert.deepEqual(findings, []);
});

test('qmd: a ::: closer ends the sections inside its div; a stray one is an orphan', () => {
  const { out, findings } = qmdTags('::: {.callout-note #c1}\n## In\nx\n:::\n## Out\n:::\n');
  assert.deepEqual(out, ['{ div.callout-note#c1', '{ h2', '~ h2', '} div.callout-note#c1', '{ h2', '} :::', '~ h2']);
  assert.deepEqual(findings, ['orphan-close-tag::::']);
  // an unclosed div is reported, its sections still end at EOF
  assert.deepEqual(qmdTags('::: aside\n# H\n').findings, ['unclosed-tag:div.aside']);
});

test('qmd: code bodies are raw text — fences, ::: and shortcodes inside are code', () => {
  const { out, findings, tp } = qmdTags('```{r}\n::: x\n{{< y >}}\n```\n````\n```\n````\n~~~ python\nz\n');
  assert.deepEqual(out, ['{ cell.r', '} cell.r', '{ code', '} code', '{ code.python']);
  assert.deepEqual(findings, ['unclosed-tag:code.python']);   // runs to EOF, reported
  const texts = [];
  for (let t = 0; t < tp.length; t++) if (tp.classOf(t) === KLASS.TEXT) texts.push(tp.lexemeOf(t));
  assert.deepEqual(texts, ['::: x\n{{< y >}}\n', '```\n', 'z\n']);
  // an escaped cell ({{python}}: shown, not run) is code in its language
  assert.deepEqual(qmdTags('```{{python}}\n1\n```\n```{.r}\n2\n```\n').out,
    ['{ code.python', '} code.python', '{ code.r', '} code.r']);
});

test('qmd: front matter, comments, shortcodes (not in inline code, not escaped)', () => {
  const { out, findings, tp } = qmdTags('---\na: 1\n---\n<!-- ::: -->\nSee {{< meta a >}}, `{{< no >}}` and {{{< esc >}}}, {{< pagebreak >}}{{% br %}} or {{< open\n');
  // an argument-less shortcode is one complete '/' token, like <br/>
  assert.deepEqual(out, ['! ---\na: 1\n---', '{ sc.meta', '} sc.meta', '/ sc.pagebreak', '/ sc.br', '{ sc.open']);
  assert.deepEqual(findings, ['unclosed-tag:sc.open']);
  assert.ok([...Array(tp.length).keys()].some((t) => tp.classOf(t) === KLASS.COMMENT));
});

test('qmd: lists — siblings, nesting at the content column, ends with ~', () => {
  assert.deepEqual(qmdTags('- a\n- b\n  - c\n  - d\n- e\n\ntext\n').out,
    ['{ ul', '{ li', '~ li', '{ li', '{ ul', '{ li', '~ li', '{ li', '~ li', '~ ul', '~ li', '{ li', '~ li', '~ ul']);
  // a lazy line stays in the item, an indented paragraph after a blank too;
  // 1. and 2) are one ordered list, a bullet starts another list
  assert.deepEqual(qmdTags('1. a\nlazy\n2) b\n\n   more\n- c\n').out,
    ['{ ol', '{ li', '~ li', '{ li', '~ li', '~ ol', '{ ul', '{ li', '~ li', '~ ul']);
  // blocks inside an item are measured from its content column
  assert.deepEqual(qmdTags('1.  x\n\n    ```\n    a\n    ```\n').out,
    ['{ ol', '{ li', '{ code', '} code', '~ li', '~ ol']);
  // a thematic break is not a list
  assert.deepEqual(qmdTags('* * *\n').out, []);
  // the rest of a marker line is a block of its own (quarto-web's list
  // tables: '- - ``` markdown', '  - ::: pad-to-code-block')
  const lt = qmdTags('- - ```md\n    ::: x\n    ```\n  - ::: pad\n\n    ::: a\n    :::\n\n    :::\n');
  assert.deepEqual(lt.out, ['{ ul', '{ li', '{ ul', '{ li', '{ code.md', '} code.md', '~ li', '{ li',
    '{ div.pad', '{ div.a', '} div.a', '} div.pad', '~ li', '~ ul', '~ li', '~ ul']);
  assert.deepEqual(lt.findings, []);
  // a sibling at the outer item's content column: '- a' at 4 opened an item
  // whose content is at 6; '- b' at 4 is measured from the outer item (4),
  // not that inner one (quarto-web tables.qmd)
  assert.deepEqual(qmdTags('- x\n  - y:\n\n    - a\n    - b\n').out,
    ['{ ul', '{ li', '{ ul', '{ li', '{ ul', '{ li', '~ li', '{ li', '~ li', '~ ul', '~ li', '~ ul', '~ li', '~ ul']);
});

test('qmd: block quotes nest, hold blocks, end with ~', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  // a lazy line continues the quote; a blank line ends it
  assert.deepEqual(view('> A\nlazy\n\nafter\n'), ['blockquote ~', '  "A"', '  "lazy"', '~', '"after"']);
  // nested quotes; a blank '>' line ends the inner one
  assert.deepEqual(view('> > a\n>\n> b\n'), ['blockquote ~', '  blockquote ~', '    "a"', '  ~', '  "b"', '~']);
  // a list inside: its items go on across '>' lines
  assert.deepEqual(qmdTags('> - a\n> - b\n').out, ['{ blockquote', '{ ul', '{ li', '~ li', '{ li', '~ li', '~ ul', '~ blockquote']);
  // a fence inside closes on a '>' line; one cut off by the quote's end is ~
  assert.deepEqual(qmdTags('> ```r\n> 1\n> ```\n').out, ['{ blockquote', '{ code.r', '} code.r', '~ blockquote']);
  const cut = qmdTags('> ```r\n> 1\n\nafter\n');
  assert.deepEqual(cut.out, ['{ blockquote', '{ code.r', '~ code.r', '~ blockquote']);
  assert.deepEqual(cut.findings, []);
  // in a list item: the item goes on after the quote
  assert.deepEqual(view('- i\n\n  > q\n\n  back\n'),
    ['ul ~', '  li ~', '    "i"', '    blockquote ~', '      "q"', '    ~', '    "back"', '  ~', '~']);
});

test('qmd: indented code after a blank line; footnotes hold indented blocks', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  // 4+ columns after a blank line is code (blank lines inside, not trailing);
  // without the blank line it continues the paragraph
  assert.deepEqual(view('text\n\n    a\n\n    b\n\nafter\n'), ['"text"', 'code ~', '  "a\\n\\n    b"', '~', '"after"']);
  assert.deepEqual(view('text\n    more\n'), ['"text"', '"more"']);
  // inside a list item, measured from its content column
  assert.deepEqual(qmdTags('- a\n\n      code\n').out, ['{ ul', '{ li', '{ code', '~ code', '~ li', '~ ul']);
  // [^id]: a container — its 4-indented paragraphs stay in, 8 is code
  const fn = qmdTags('[^n]: One.\n\n    Two.\n\n        code\n\n[^m]: Three.\n\nafter\n');
  assert.deepEqual(fn.out, ['{ fn.n', '{ code', '~ code', '~ fn.n', '{ fn.m', '~ fn.m']);
  assert.deepEqual(fn.findings, []);
});

test('qmd: a ": caption" line after a table is caption ~ … ~', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  assert.deepEqual(view('| a |\n|---|\n\n: Fruit {.striped}\n  prices\n\nafter\n'),
    ['[', '  [', '    "a"', '  ]', ']', 'caption ~', '  "Fruit {.striped}"', '  "prices"', '~', '"after"']);
  assert.deepEqual(qmdTags('+---+\n| x |\n+---+\nTable: Grid.\n').out, ['{ caption', '~ caption']);
  // not after a table: a ':' line is text (or a definition, after a term)
  assert.deepEqual(view('a\n\n: b\n'), ['dl ~', '  dt ~', '    "a"', '  ~', '  dd ~', '    "b"', '  ~', '~']);
  assert.deepEqual(view('a\nb\n: c\n'), ['"a"', '"b"', '": c"']);
});

test('qmd: an attribute-only div is named by its first key; quoted values are not classes', () => {
  const names = (s) => qmdTags(s).out.filter((x) => x[0] === '{');
  assert.deepEqual(names('::: {layout-ncol=2}\n:::\n::: {layout="[[1],[1,1]]"}\n:::\n'), ['{ div[layout-ncol]', '{ div[layout]']);
  // a class or id still wins; '.png' inside a quoted value is not a class
  assert.deepEqual(names('::: {.grid layout-ncol=2}\n:::\n::: {src="a.png" .x}\n:::\n::: {}\n:::\n'), ['{ div.grid', '{ div.x', '{ div']);
});

test('qmd: setext headings — === is h1, --- is h2, sections like ATX', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  // a paragraph (one or more lines) over the underline; the underline is hidden
  assert.deepEqual(view('Title\n=====\n\nIntro.\n\nSub\npart two\n--\n\nbody\n\n# Next\n'),
    ['h1 ~', '  "Title"', '  "Intro."', '  h2 ~', '    "Sub"', '    "part two"', '    "body"', '  ~', '~', 'h1 ~', '  "Next"', '~']);
  // not underlines: a spaced thematic break, ***, and --- under a list item
  assert.deepEqual(view('Text\n- - -\n\nText\n***\n'), ['"Text"', '"- - -"', '"Text"', '"***"']);
  assert.ok(!view('- a\n---\n').some((x) => /h\d/.test(x)));
  const t = new UniLexer().tokenizeQmd('A\n===\nB\n---\n');
  assert.equal(t.reconstruct(), 'A\n===\nB\n---\n');
});

test('qmd: simple and multiline tables — columns from dash runs, the [ [ cells ] ] layout', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1).join(' ').replace(/\s+/g, ' ');
  // simple: a row per line, a blank cell kept as "" so columns stay aligned
  assert.equal(view('  Id   Name\n----   ------\n   1   one\n   2\n\n: Ids\n'),
    '[ [ "Id" "Name" ] [ "1" "one" ] [ "2" "" ] ] caption ~ "Ids" ~');
  // multiline: header lines are one row, rows run to a blank line or the border
  assert.equal(view('--------------\n Key  Value\n---- ---------\n a    first\n      line\n\n b    two\n--------------\n'),
    '[ [ "Key" "Value" ] [ "a" "first" "line" ] [ "b" "two" ] ]');
  // headerless forms
  assert.equal(view('---- ----\n a    b\n---- ----\n'), '[ [ "a" "b" ] ]');
  // not tables: thematic breaks, a border with no column line, a lone run
  assert.equal(view('-----\n\ntext\n\n- - -\n\nA\n---\n'), '"-----" "text" "- - -" h2 ~ "A" ~');
  assert.equal(view('-----\ntext\n-----\n'), '"-----" "text" "-----"');
  const src = '  Id   Name\n----   ------\n   1   one\n\n';
  assert.equal(new UniLexer().tokenizeQmd(src).reconstruct(), src);
});

test('qmd: raw HTML blocks — block-level tags are structure, Markdown between', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  // <div> … </div> holds Markdown; inline tags (<b>, <kbd>) stay text
  assert.deepEqual(view('<div class="x">\n\n- a\n\n</div>\n<details>\n<summary>More <b>info</b></summary>\nSee <kbd>K</kbd>.\n</details>\n'),
    ['div {', '  ul ~', '    li ~', '      "a"', '    ~', '  ~', '}', 'details {', '  summary {', '    "More <b>info</b>"', '  }', '  "See <kbd>K</kbd>."', '}']);
  // optional end tags are implied (~), void elements complete (hr;), a raw
  // element's body is text even with a tag in it
  assert.deepEqual(view('<ul>\n<li>one\n<li>two\n</ul>\n<hr>\n<script>\nif (a < b) { </div> }\n</script>\n'),
    ['ul {', '  li ~', '    "one"', '  ~', '  li ~', '    "two"', '  ~', '}', 'hr;', 'script {', '  "if (a < b) { </div> }"', '}']);
  // an autolink and an inline tag at line start are text
  assert.deepEqual(view('<https://quarto.org>\n<span>x</span>\n'), ['"<https://quarto.org>"', '"<span>x</span>"']);
  // tolerant: an orphan end tag and an unclosed <section> are findings
  assert.deepEqual(qmdTags('</div>\n\n<section>\nx\n').findings, ['orphan-close-tag:div', 'unclosed-tag:section']);
  assert.deepEqual(qmdTags('<div>\n<p>a\n</div>\n').findings, []);
});

test('qmd: a {=format} fence is a raw block, raw.format', () => {
  assert.deepEqual(qmdTags('```{=html}\n<b>x</b>\n```\n``` {=typst} \n#x\n```\n').out, ['{ raw.html', '} raw.html', '{ raw.typst', '} raw.typst']);
});

test('qmd: definition lists are dl ~ dt ~ … ~ dd ~ … ~ ~', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  // a term (after a blank line) needs a ':' or '~' definition next, a blank
  // line between allowed; a definition holds its indented blocks
  assert.deepEqual(view('Apple\n\n:   A fruit.\n\n    - red\n: Two.\n\nPear\n  ~ Green.\n\nafter\n'),
    ['dl ~', '  dt ~', '    "Apple"', '  ~', '  dd ~', '    "A fruit."', '    ul ~', '      li ~', '        "red"', '      ~', '    ~', '  ~',
      '  dd ~', '    "Two."', '  ~', '  dt ~', '    "Pear"', '  ~', '  dd ~', '    "Green."', '  ~', '~', '"after"']);
  // ':' after a paragraph line is text, and ':::' is still a div
  assert.deepEqual(view('a\nb\n: c\n'), ['"a"', '"b"', '": c"']);
  assert.deepEqual(qmdTags('T\n\n: d\n\n::: x\n:::\n').out, ['{ dl', '{ dt', '~ dt', '{ dd', '~ dd', '~ dl', '{ div.x', '} div.x']);
  assert.deepEqual(qmdTags('T\n: d\n').findings, []);
});

test('qmd: pipe tables are [ rows [ cells ] ] with zero-width brackets', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  assert.deepEqual(view('| a | b |\n|---|:-:|\n| 1 |   |\n\nafter\n'),
    ['[', '  [', '    "a"', '    "b"', '  ]', '  [', '    "1"', '    ""', '  ]', ']', '"after"']);
  // no outer pipes; an escaped pipe and a pipe in `code` are cell content
  assert.deepEqual(view('a | b\n--|--\n`x|y` | c\\|d\nend\n'),
    ['[', '  [', '    "a"', '    "b"', '  ]', '  [', '    "`x|y`"', '    "c\\\\|d"', '  ]', ']', '"end"']);
  assert.deepEqual(qmdTags('| a |\n|---|\n').findings, []);
});

test('qmd: grid tables are the same [ rows [ cells ] ]; a row spans its | lines', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  const grid = [
    '+-----+--------------+',
    '| Day | Plan         |',
    '+=====+==============+',
    '| Mon | - a|b        |',   // '|' off a border column is cell text
    '|     | {{< br >}} c |',
    '+-----+--------------+',
    '| Tue |              |',
    '+-----+--------------+',
    '',
    'after',
    '',
  ].join('\n');
  assert.deepEqual(view(grid), ['[', '  [', '    "Day"', '    "Plan"', '  ]',
    '  [', '    "Mon"', '    "- a|b"', '    sc.br;', '    "c"', '  ]', '  [', '    "Tue"', '  ]', ']', '"after"']);
  assert.deepEqual(qmdTags(grid).findings, []);
  // a border with no | line after it is not a table
  assert.deepEqual(view('+---+\ntext\n'), ['"+---+"', '"text"']);
  // no closing border: the last row and the table still close
  assert.deepEqual(view('+---+\n| x |\n'), ['[', '  [', '    "x"', '  ]', ']']);
});

test('qmd outline: a table right after a tag keeps its [ (qmd tags have no attributes)', () => {
  const view = (s) => outlineView(s, 'qmd', 99, { clike: true }).split('\n').slice(1);
  assert.deepEqual(view('::: x\n| a |\n|---|\n:::\n'), ['div.x {', '  [', '    [', '      "a"', '    ]', '  ]', '}']);
  assert.deepEqual(view('{{< pagebreak >}}\n\n+---+\n| b |\n+---+\n'), ['sc.pagebreak;', '[', '  [', '    "b"', '  ]', ']']);
});

test('qmd: tdump --outline --clike and samples/sample.qmd', () => {
  assert.deepEqual(outlineView('# T\n::: note\nhi\n:::\n```{r}\n1\n```\n{{< pagebreak >}}\n', 'qmd', 99, { clike: true }).split('\n').slice(1),
    ['h1 ~', '  "T"', '  div.note {', '    "hi"', '  }', '  cell.r {', '    "1"', '  }', '  sc.pagebreak;', '~']);
  const src = readFileSync('samples/sample.qmd', 'utf8');
  const { findings } = qmdTags(src);
  assert.deepEqual(findings, ['orphan-close-tag::::'], 'one deliberate seam: the stray :::');
});

console.log('\n── tools ──');

test('every CLI tool reports the package.json version', () => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const tool of ['scan.js', 'sfdiff.js', 'tdump.js', 'tfind.js', 'tfreq.js']) {
    const r = spawnSync(process.execPath, [tool, '--version'], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), version, tool);
  }
});

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

test('samples/sample.html: one deliberate seam, every optional end implied', () => {
  const src = readFileSync('samples/sample.html', 'utf8');
  const r = new LexicalScanner().scan(src, HTML_TABLE);
  assert.deepEqual(r.repairMap().map((f) => `${f.kind}:${f.char}`), ['improper-nesting:b']);
  const implied = [...r.tags].map((t, i) => (t === 0x7E ? r.nameOf(i) : null)).filter(Boolean).sort();
  assert.deepEqual(implied, ['b', 'body', 'colgroup', 'dd', 'dt', 'head', 'html', 'li', 'li',
    'p', 'p', 'tbody', 'td', 'td', 'td', 'td', 'th', 'th', 'thead', 'tr', 'tr', 'tr']);
  const t = L.tokenizeHtml(src);
  assert.equal(t.reconstruct(), src);
  assert.deepEqual(t.repairMap(), []);
  // --clike decodes &amp; in text; the <script> && stays raw
  const text = outlineView(src, 'html', 99, { clike: true }).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('"'));
  for (const s of ['"Orders & returns"', '"Amount & VAT"', '"Done & dusted"']) assert.ok(text.includes(s), s);
  assert.ok(text.some((l) => l.startsWith('"if (a < b && c > d)')));
  assert.ok(!text.some((l) => l.includes('&amp;')));
});

test('tdump --outline --clike: name before the brace, bare close', () => {
  const body = (out) => out.split('\n').slice(1);
  const xml = '<a x="1"><b y="2"/><c/><d>t</d><e><f>u</f></e></a></z>';
  assert.deepEqual(body(outlineView(xml, 'xml', 3, { clike: true })),
    ['a {', '  b;', '  c;', '  d {', '    "t"', '  }', '  e {', '    f { … 1 … }', '  }', '}', '} z …?']);
  // an omitted HTML end tag: the element opens and closes with ~, so every
  // '{' has its '}' (also when folded)
  assert.deepEqual(body(outlineView('<ul><li>a<br>b</ul>', 'html', 3, { clike: true })),
    ['ul {', '  li ~', '    "a"', '    br;', '    "b"', '  ~', '}']);
  assert.deepEqual(body(outlineView('<ul><li>a<li>b</ul>', 'html', 2, { clike: true })),
    ['ul {', '  li ~ … 1 … ~', '  li ~ … 1 … ~', '}']);
  // trailing line break + indent is layout and is dropped; a same-line
  // trailing space is content and stays
  assert.deepEqual(body(outlineView('<p>a <b>b</b>\n<p>c\n  </p>', 'html', 3, { clike: true })),
    ['p ~', '  "a "', '  b {', '    "b"', '  }', '~', 'p {', '  "c"', '}']);
  // character references are decoded (numeric everywhere, XML's five, a few
  // HTML names); unknown ones stay as written, raw <script>/<style> text and
  // CDATA are never decoded
  assert.deepEqual(body(outlineView('<a>x &amp; &lt;y&gt; &#65;&#x42; &nbsp; &bogus; &#0;<![CDATA[&amp;]]></a>', 'xml', 3, { clike: true })),
    ['a {', '  "x & <y> AB &nbsp; &bogus; &#0;"', '  ! <![CDATA[&amp;]]>', '}']);
  assert.deepEqual(body(outlineView('<script>a &amp;&amp; b</script><title>A &amp; B&nbsp;&hellip;</title>', 'html', 3, { clike: true })),
    ['script {', '  "a &amp;&amp; b"', '}', 'title {', '  "A & B …"', '}']);
  // other languages are unchanged
  assert.equal(outlineView('{"a": [1]}', 'json5', 3, { clike: true }), outlineView('{"a": [1]}', 'json5', 3));
  const r = spawnSync(process.execPath, ['tdump.js', '--clike', 'samples/sample.xml'], { encoding: 'utf8' });
  assert.equal(r.status, 2, 'without --outline it is a usage error');
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
