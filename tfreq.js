// tfreq.js — token frequency over real source trees: the measurement that the
// byte-allocation rule consumes.
//
//   node tfreq.js [options] <path...>
//
// The §13e allocation rule says: one byte = one role; FREQUENCY decides which
// role gets the short byte; the assignment is internal preference for reading
// the representation. This tool produces that frequency data — counts per
// class, per operator ROLE (grouped by tag byte, spellings listed), and per
// keyword/builtin — over whatever tree you point it at. Re-tuning the byte
// table is then a data question, not an intuition.

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { UniLexer, KLASS, KLASS_NAME } from './unilexer.js';
import { OP_LITERAL } from './token-tags.js';

const VERSION = '0.1.0';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', 'dist', 'build']);
const EXT_LANG = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.xml': 'xml', '.html': 'xml', '.htm': 'xml', '.svg': 'xml',
  '.rs': 'rust',
  '.sql': 'sql', '.pks': 'sql', '.pkb': 'sql', '.plsql': 'sql',
  '.py': 'py',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.json': 'json5', '.json5': 'json5', '.jsonc': 'json5',
};

const HELP = `tape-tokenizer tfreq — token frequencies for byte-allocation tuning (v${VERSION})

USAGE
  node tfreq.js [options] <path...>

  Walks the given files/directories (recursively), lexes each by extension
  (js/xml/rust/sql), and reports aggregate frequencies:

    - tokens per CLASS (ws, ident, keyword, op, …)
    - operators per ROLE (grouped by tag byte; dialect spellings listed),
      ranked — the data the §13e allocation rule consumes
    - top keywords, builtins, identifiers

OPTIONS
  -n, --top <k>    Rows per ranking section (default 15).
  -h, --help       Show this help and exit.
  -V, --version    Print version and exit.

EXIT STATUS
  0 ok, 2 usage error.
`;

function fail(msg) {
  process.stderr.write(`tfreq: ${msg}\nTry 'node tfreq.js --help' for usage.\n`);
  process.exit(2);
}

function collectFiles(paths) {
  const out = [];
  const visit = (p) => {
    let st;
    try { st = statSync(p); } catch { process.stderr.write(`tfreq: cannot stat '${p}'\n`); return; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(basename(p))) return;
      for (const e of readdirSync(p)) visit(join(p, e));
    } else if (st.isFile()) out.push(p);
  };
  for (const p of paths) visit(p);
  return out;
}

function bump(map, key, n = 1) { map.set(key, (map.get(key) || 0) + n); }

function ranked(map, top) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}

function analyze(files) {
  const classCounts = new Map();          // class name -> count
  const opRoles = new Map();              // role byte -> count
  const opSpellings = new Map();          // role byte -> Map(lexeme -> count)
  const keywords = new Map();             // lexeme (lowercased) -> count
  const builtins = new Map();
  const idents = new Map();
  let files_ = 0; let tokens = 0; let bytes = 0;

  for (const path of files) {
    const lang = EXT_LANG[extname(path).toLowerCase()];
    if (!lang) continue;
    let src;
    try { src = readFileSync(path, 'utf8'); } catch { continue; }
    const lx = new UniLexer();
    const u = lang === 'xml' ? lx.tokenizeXml(src)
      : lang === 'rust' ? lx.tokenizeRust(src)
      : lang === 'sql' ? lx.tokenizeSql(src)
      : lang === 'py' ? lx.tokenizePy(src)
      : lang === 'yaml' ? lx.tokenizeYaml(src)
      : lang === 'json5' ? lx.tokenizeJson5(src)
      : lx.tokenize(src);
    files_++; tokens += u.length; bytes += src.length;

    for (let t = 0; t < u.length; t++) {
      const k = u.classOf(t);
      bump(classCounts, KLASS_NAME[k]);
      if (k === KLASS.OP) {
        const b = u.tagOf(t);
        bump(opRoles, b);
        if (!opSpellings.has(b)) opSpellings.set(b, new Map());
        bump(opSpellings.get(b), u.lexemeOf(t));
      } else if (k === KLASS.KEYWORD) bump(keywords, u.lexemeOf(t).toLowerCase());
      else if (k === KLASS.BUILTIN) bump(builtins, u.lexemeOf(t).toLowerCase());
      else if (k === KLASS.IDENT) bump(idents, u.lexemeOf(t));
    }
  }
  return { classCounts, opRoles, opSpellings, keywords, builtins, idents, files: files_, tokens, bytes };
}

function report(a, top) {
  const lines = [];
  lines.push(`── ${a.files} files, ${a.tokens} tokens, ${a.bytes} bytes ──`);

  lines.push('', 'tokens per class:');
  for (const [name, n] of ranked(a.classCounts, 99)) {
    lines.push(`  ${name.padEnd(9)} ${String(n).padStart(7)}  ${(100 * n / a.tokens).toFixed(1)}%`);
  }

  lines.push('', `operator roles by frequency (the allocation-rule data; byte = role,`);
  lines.push(`spellings in brackets — short bytes should sit at the top):`);
  for (const [byte, n] of ranked(a.opRoles, top)) {
    const canon = OP_LITERAL[byte] ?? `0x${byte.toString(16)}`;
    const sp = [...a.opSpellings.get(byte).entries()].sort((x, y) => y[1] - x[1])
      .map(([lex, c]) => (lex === canon ? null : `${lex}:${c}`)).filter(Boolean).join(' ');
    const short = byte < 0x80 ? 'single' : 'block ';
    lines.push(`  ${canon.padEnd(4)} ${String(n).padStart(6)}  ${short} 0x${byte.toString(16)}${sp ? `  [${sp}]` : ''}`);
  }

  for (const [title, map] of [['keywords', a.keywords], ['builtins', a.builtins], ['identifiers', a.idents]]) {
    if (!map.size) continue;
    lines.push('', `top ${title}:`);
    const rows = ranked(map, top);
    const w = Math.max(...rows.map(([k]) => k.length), 4);
    for (const [k, n] of rows) lines.push(`  ${k.padEnd(w)} ${String(n).padStart(6)}`);
  }
  return lines.join('\n');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        top:     { type: 'string', short: 'n' },
        help:    { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (e) { fail(e.message); }
  const { values, positionals } = parsed;
  if (values.help)    { process.stdout.write(HELP); process.exit(0); }
  if (values.version) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
  if (!positionals.length) fail('no input paths given');
  const top = values.top ? parseInt(values.top, 10) : 15;
  if (!Number.isInteger(top) || top < 1) fail(`invalid --top '${values.top}'`);

  const files = collectFiles(positionals);
  if (!files.length) fail('no readable files found');
  process.stdout.write(report(analyze(files), top) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { analyze, report };
