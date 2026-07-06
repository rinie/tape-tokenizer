// tfind.js — zoom into a large tape by content instead of by depth. Where
// tdump --outline answers "what's the shape at depth N", tfind answers
// "where does THIS text live, and what's the natural unit around it" —
// useful once a file (an OpenAPI spec, a Postman collection) is too big to
// peel outline-layer by outline-layer to find one thing.
//
//   node tfind.js [options] <needle> <file.json>
//
// For every token whose lexeme contains <needle>, prints:
//   - a breadcrumb: the chain of enclosing containers, innermost first,
//     each labelled by its OWN key (if it's a keyed value — the JSON/OpenAPI
//     convention: {"purchaseOrder": {...}}) or by a "name"/"title" sibling
//     (the Postman-collection convention: [{"name": "...", "request": {...}}]).
//   - the nearest enclosing "natural unit": the innermost ancestor with
//     either kind of label — printed in full, exact source text (lossless,
//     the same span-slice §13b already uses elsewhere).
// Neither convention is guessed at semantically; both are read straight off
// the tape's own key/value and sibling structure.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { UniLexer, KLASS } from './unilexer.js';

const VERSION = '0.1.0';

const HELP = `tape-tokenizer tfind — zoom into a tape by content, not by depth (v${VERSION})

USAGE
  node tfind.js [options] <needle> <file.json>

OPTIONS
  -i, --ignore-case   Case-insensitive substring match.
  -l, --lang <l>      Force language: js | xml | rust | sql | py | yaml | json5.
                      Default: detect from the file extension (see tdump.js --help).
  -c, --context       Also print the breadcrumb-only view (no zoomed text),
                      one line per ancestor level, innermost first.
  -u, --up <n>        Zoom to the (n+1)-th labelled ancestor instead of the
                      nearest one (n >= 0, default 0) — raise it when the
                      nearest label is too narrow (e.g. zoom out from one
                      field to the example/request it belongs to).
  -h, --help          Show this help and exit.
  -V, --version       Print version and exit.

EXIT STATUS
  0 ok (at least one match), 1 no matches, 2 usage error.
`;

function fail(msg) {
  process.stderr.write(`tfind: ${msg}\nTry 'node tfind.js --help' for usage.\n`);
  process.exit(2);
}

function tokenize(src, lang) {
  return lang === 'xml' ? new UniLexer().tokenizeXml(src)
    : lang === 'rust' ? new UniLexer().tokenizeRust(src)
    : lang === 'sql' ? new UniLexer().tokenizeSql(src)
    : lang === 'py' ? new UniLexer().tokenizePy(src)
    : lang === 'yaml' ? new UniLexer().tokenizeYaml(src)
    : lang === 'json5' ? new UniLexer().tokenizeJson5(src)
    : new UniLexer().tokenize(src);
}

function nextSig(u, n, t) {
  for (let i = t; i < n; i++) if (u.classOf(i) !== KLASS.WS && u.classOf(i) !== KLASS.COMMENT) return i;
  return -1;
}
function prevSig(u, t) {
  for (let i = t; i >= 0; i--) if (u.classOf(i) !== KLASS.WS && u.classOf(i) !== KLASS.COMMENT) return i;
  return -1;
}
function stripQuotes(s) { return s.replace(/^["']|["']$/g, ''); }

// Does this object/array (open..close) have a DIRECT (same-nesting) sibling
// string key equal to one of `names`? Walks key:value pairs one level deep
// only — a nested object's OWN "name" field must never count (a Postman
// header entry has its own unrelated "name", for instance).
function directSiblingLabel(u, n, open, close, names) {
  if (u.lexemeOf(open) !== '{') return null;
  let t = nextSig(u, n, open + 1);
  while (t !== -1 && t < close) {
    if (u.classOf(t) === KLASS.BRACKET && u.lexemeOf(t) === '}') break;
    const keyTok = t;
    const key = stripQuotes(u.lexemeOf(keyTok));
    let valTok = nextSig(u, n, keyTok + 1); // ':'
    valTok = nextSig(u, n, valTok + 1);     // value start
    if (names.includes(key) && u.classOf(valTok) === KLASS.STRING) {
      return stripQuotes(u.lexemeOf(valTok));
    }
    let valEnd = valTok;
    if (u.classOf(valTok) === KLASS.BRACKET) valEnd = u.linkOf(valTok);
    t = nextSig(u, n, valEnd + 1);
    if (t !== -1 && u.lexemeOf(t) === ',') t = nextSig(u, n, t + 1);
  }
  return null;
}

// Every enclosing '{'/'[' around token t, innermost first, each carrying
// its own label: the key it's the value of (JSON/OpenAPI convention), else
// a "name"/"title" sibling (Postman-collection convention), else null.
function enclosers(u, n, t) {
  const chain = [];
  for (let i = t - 1; i >= 0; i--) {
    if (u.classOf(i) !== KLASS.BRACKET) continue;
    const lex = u.lexemeOf(i);
    if (lex !== '{' && lex !== '[') continue;
    const close = u.linkOf(i);
    if (close === -1 || close < t) continue;
    let keyLabel = null;
    const colon = prevSig(u, i - 1);
    if (colon !== -1 && u.lexemeOf(colon) === ':') {
      const k = prevSig(u, colon - 1);
      if (k !== -1 && u.classOf(k) === KLASS.STRING) keyLabel = stripQuotes(u.lexemeOf(k));
    }
    const nameLabel = keyLabel ? null : directSiblingLabel(u, n, i, close, ['name', 'title']);
    chain.push({ open: i, close, label: keyLabel ?? nameLabel });
  }
  return chain;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'ignore-case': { type: 'boolean', short: 'i' },
        lang:          { type: 'string',  short: 'l' },
        context:       { type: 'boolean', short: 'c' },
        up:            { type: 'string',  short: 'u' },
        help:          { type: 'boolean', short: 'h' },
        version:       { type: 'boolean', short: 'V' },
      },
    });
  } catch (e) { fail(e.message); }
  const { values, positionals } = parsed;
  if (values.help)    { process.stdout.write(HELP); process.exit(0); }
  if (values.version) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
  if (positionals.length !== 2) fail('expected exactly <needle> <file>');
  const [needle, filePath] = positionals;

  let up = 0;
  if (values.up !== undefined) {
    up = parseInt(values.up, 10);
    if (!Number.isInteger(up) || up < 0) fail(`invalid --up '${values.up}' (expected an integer >= 0)`);
  }

  let lang = values.lang;
  if (lang && !['js', 'xml', 'rust', 'sql', 'py', 'yaml', 'json5'].includes(lang)) {
    fail(`unknown --lang '${lang}' (expected js | xml | rust | sql | py | yaml | json5)`);
  }
  if (!lang) {
    const ext = extname(filePath).toLowerCase();
    lang = ['.xml', '.html', '.htm', '.svg'].includes(ext) ? 'xml'
      : ext === '.rs' ? 'rust'
      : ['.sql', '.pks', '.pkb', '.plsql'].includes(ext) ? 'sql'
      : ext === '.py' ? 'py'
      : ['.yaml', '.yml'].includes(ext) ? 'yaml'
      : ['.json', '.json5', '.jsonc'].includes(ext) ? 'json5'
      : 'js';
  }

  let src;
  try { src = readFileSync(filePath, 'utf8'); } catch { fail(`cannot read '${filePath}'`); }

  const u = tokenize(src, lang);
  const n = u.length;
  const cmp = values['ignore-case'] ? (s) => s.toLowerCase() : (s) => s;
  const target = cmp(needle);

  const matches = [];
  for (let t = 0; t < n; t++) if (cmp(u.lexemeOf(t)).includes(target)) matches.push(t);

  if (!matches.length) {
    process.stdout.write(`no matches for ${JSON.stringify(needle)}\n`);
    process.exit(1);
  }

  const out = [];
  out.push(`${matches.length} match(es) for ${JSON.stringify(needle)}`);
  for (const m of matches) {
    const lex = u.lexemeOf(m);
    const shownLex = lex.length > 80 ? lex.slice(0, 80) + '…' : lex;  // a matched
    // token can be an entire raw request body (Postman stores it as ONE
    // string) — truncate the header line, the zoomed text below is unaffected
    out.push('', `── token ${m}: ${shownLex} ──`);
    const chain = enclosers(u, n, m);
    out.push('breadcrumb (innermost first): ' + (chain.map((c) => c.label ?? `#${c.open}`).join(' <- ') || '(top level)'));

    if (values.context) continue;

    const labelled = chain.filter((c) => c.label !== null);
    const unit = labelled[up];
    if (!unit) {
      out.push(labelled.length
        ? `(only ${labelled.length} labelled ancestor(s) — --up ${up} goes past the root)`
        : '(no labelled ancestor found — top-level match)');
      continue;
    }
    const rank = up === 0 ? 'nearest' : `labelled ancestor #${up + 1} (0 = nearest)`;
    out.push(`zoomed to ${up === 0 ? 'the nearest labelled ancestor' : rank} ("${unit.label}", tokens ${unit.open}..${unit.close}):`, '');
    const startOff = u.offsetOf(unit.open);
    const endTok = unit.close + 1;
    const endOff = endTok < n ? u.offsetOf(endTok) : src.length;
    out.push(src.slice(startOff, endOff));
  }
  process.stdout.write(out.join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { enclosers, directSiblingLabel };
