// scan.js — point the tape-tokenizer at real source trees.
//
// Structural balance / seam checker for source files, with an optional
// breadth-first def/use projection for JavaScript. Composes the library pieces
// (LexicalScanner + lexical tables + defuse) behind a conventional CLI:
// extension-based language detection, recursive directory walk, --help, and
// grep/linter-style exit codes.

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { parseArgs } from 'node:util';

import { LexicalScanner, JS_TABLE, C_TABLE, PYTHON_TABLE, XML_TABLE } from './lexical-scanner.js';
import { analyze, defUseOutline, useBeforeDef } from './defuse.js';

const VERSION = '0.1.0';

const TABLES = { c: C_TABLE, js: JS_TABLE, py: PYTHON_TABLE, xml: XML_TABLE };
const EXT_LANG = {
  '.c': 'c', '.h': 'c',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js',
  '.py': 'py',
  '.xml': 'xml', '.html': 'xml', '.htm': 'xml', '.svg': 'xml',
};
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', 'dist', 'build']);

const HELP = `tape-tokenizer scan — structural balance & seam checker (v${VERSION})

USAGE
  node scan.js [options] <path...>

  Scans source files for bracket balance and structural seams (unclosed/orphan
  brackets, preprocessor #if/#endif, XML tags), reporting each finding with both
  boundaries. Directories are walked recursively. This is a tolerant, linter-grade
  structural check — not a compiler.

ARGUMENTS
  <path...>            Files or directories to scan. Directories are walked
                       recursively (skipping ${[...SKIP_DIRS].join(', ')}).
                       Use '-' to read one source from stdin (needs --lang).

OPTIONS
  -l, --lang <lang>    Force language: c | js | py | xml. Default: detect from
                       file extension. Required when reading from stdin.
  -p, --policy <kind>  Provenance policy: lib (default) | own.
                         lib — third-party code; seams are warnings.
                         own — your code; seams are errors (def-before-use).
      --own            Shorthand for --policy own.
      --lib            Shorthand for --policy lib.
      --defuse         Also run the breadth-first def/use projection (JS only):
                       top-level outline + use-before-def findings.
  -q, --quiet          Print only files that have findings, plus the summary.
      --no-recurse     Do not descend into directories.
  -h, --help           Show this help and exit.
  -V, --version        Print version and exit.

LANGUAGE DETECTION (by extension)
  .c .h                  -> c
  .js .mjs .cjs .jsx     -> js
  .py                    -> py
  .xml .html .htm .svg   -> xml
  (other extensions are skipped unless --lang forces a language)

EXIT STATUS
  0   all scanned files clean
  1   one or more findings (seams or errors)
  2   usage error (bad option, no readable input)

EXAMPLES
  node scan.js src/                      Walk a tree (lib policy, auto-detect).
  node scan.js --own src/                Your code: seams are errors.
  node scan.js -l c kernel/*.c           Force C on a glob.
  node scan.js --defuse app.js           Balance + def/use on a JS file.
  type foo.c | node scan.js -l c -        Read one file from stdin (Windows).

KNOWN LIMITATION
  JS regex literals are not yet modelled: a regex containing a quote (e.g.
  /['"]/ ) is read as a string and can produce false seams on regex-heavy JS.
`;

function fail(msg) {
  process.stderr.write(`scan: ${msg}\n`);
  process.stderr.write("Try 'node scan.js --help' for usage.\n");
  process.exit(2);
}

function detectLang(path) {
  return EXT_LANG[extname(path).toLowerCase()] || null;
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 0x0A) line++;
  return line;
}

// Collect files from a path list. Directories walk recursively unless disabled.
function collectFiles(paths, recurse) {
  const out = [];
  const visit = (p) => {
    let st;
    try { st = statSync(p); } catch { process.stderr.write(`scan: cannot stat '${p}'\n`); return; }
    if (st.isDirectory()) {
      if (!recurse) return;
      if (SKIP_DIRS.has(basename(p))) return;
      for (const entry of readdirSync(p)) visit(join(p, entry));
    } else if (st.isFile()) {
      out.push(p);
    }
  };
  for (const p of paths) visit(p);
  return out;
}

function scanOne(src, lang, policy, withDefuse) {
  const sc = new LexicalScanner();
  const r = sc.scan(src, TABLES[lang]);
  const findings = r.repairMap().map((f) => ({ ...f, line: lineOf(src, f.offset ?? f.startOffset ?? 0) }));
  const errors = findings.filter((f) => f.severity === 'error');
  let seams = findings.filter((f) => f.severity === 'warning');

  // def/use (JS only): use-before-def joins the findings, severity by policy.
  let outline = null;
  if (withDefuse && lang === 'js') {
    const { du } = analyze(src);
    outline = defUseOutline(du);
    const ubd = useBeforeDef(du, policy).map((f) => ({
      ...f, kind: 'use-before-def', char: `${f.user}→${f.used}`,
      offset: undefined, line: undefined,
      detail: `use tape[${f.useIndex}] → def tape[${f.defIndex}]`,
    }));
    if (policy === 'own') errors.push(...ubd);
    else seams.push(...ubd);
  }

  // Under 'own', structural seams are errors too.
  if (policy === 'own') { errors.push(...seams); seams = []; }
  return { tokens: r.length, bytes: src.length, errors, seams, outline };
}

function reportFile(path, lang, res, quiet) {
  const clean = res.errors.length === 0 && res.seams.length === 0;
  if (quiet && clean) return;
  let verdict;
  if (res.errors.length) verdict = `✗ ${res.errors.length} error(s)`;
  else if (res.seams.length) verdict = `⚠ ${res.seams.length} seam(s)`;
  else verdict = '✓ clean';
  process.stdout.write(`  ${verdict.padEnd(14)} ${path}  [${lang}]\n`);
  for (const f of [...res.errors, ...res.seams]) {
    const where = f.line !== undefined ? `line ${f.line}` : (f.detail || '');
    const span = f.endOffset !== undefined ? ` (off ${f.offset}→${f.endOffset})` : '';
    process.stdout.write(`       • ${f.kind} ${f.char !== undefined ? `'${f.char}' ` : ''}${where}${span}\n`);
  }
  if (res.outline) {
    process.stdout.write(`       def/use outline (${res.outline.length} top-level defs):\n`);
    for (const d of res.outline) {
      const uses = d.uses.length ? d.uses.join(', ') : '—';
      process.stdout.write(`         ${d.kind} ${d.name} → ${uses}\n`);
    }
  }
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        lang:    { type: 'string',  short: 'l' },
        policy:  { type: 'string',  short: 'p' },
        own:     { type: 'boolean' },
        lib:     { type: 'boolean' },
        defuse:  { type: 'boolean' },
        quiet:   { type: 'boolean', short: 'q' },
        'no-recurse': { type: 'boolean' },
        help:    { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
  } catch (e) {
    fail(e.message);
  }
  const { values, positionals } = parsed;

  if (values.help)    { process.stdout.write(HELP); process.exit(0); }
  if (values.version) { process.stdout.write(`${VERSION}\n`); process.exit(0); }

  // resolve policy
  let policy = values.policy || 'lib';
  if (values.own) policy = 'own';
  if (values.lib) policy = 'lib';
  if (policy !== 'lib' && policy !== 'own') fail(`invalid --policy '${policy}' (expected lib | own)`);

  // resolve forced language
  if (values.lang && !TABLES[values.lang]) fail(`unknown --lang '${values.lang}' (expected ${Object.keys(TABLES).join(' | ')})`);

  if (positionals.length === 0) fail('no input paths given');

  const recurse = !values['no-recurse'];
  let anyFinding = false;
  const totals = { files: 0, clean: 0, seams: 0, errors: 0, skipped: 0 };

  // stdin mode
  if (positionals.length === 1 && positionals[0] === '-') {
    if (!values.lang) fail("reading from stdin requires --lang");
    const src = readFileSync(0, 'utf8');
    const res = scanOne(src, values.lang, policy, values.defuse);
    reportFile('<stdin>', values.lang, res, values.quiet);
    process.exit(res.errors.length || res.seams.length ? 1 : 0);
  }

  const files = collectFiles(positionals, recurse);
  if (files.length === 0) fail('no readable files found in the given paths');

  process.stdout.write(`── scan [policy: ${policy}] ──\n`);
  for (const path of files) {
    const lang = values.lang || detectLang(path);
    if (!lang) { totals.skipped++; continue; }
    let src;
    try { src = readFileSync(path, 'utf8'); } catch { process.stderr.write(`scan: cannot read '${path}'\n`); totals.skipped++; continue; }
    const res = scanOne(src, lang, policy, values.defuse);
    reportFile(path, lang, res, values.quiet);
    totals.files++;
    if (res.errors.length) { totals.errors++; anyFinding = true; }
    else if (res.seams.length) { totals.seams++; anyFinding = true; }
    else totals.clean++;
  }

  process.stdout.write(
    `\n── summary ──\n  ${totals.files} scanned: ${totals.clean} clean, `
    + `${totals.seams} with seams, ${totals.errors} with errors`
    + (totals.skipped ? `; ${totals.skipped} skipped (unknown extension)` : '') + '\n',
  );
  process.exit(anyFinding ? 1 : 0);
}

main();
