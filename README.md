# tape-tokenizer

A **tolerant, positional, structural tape scanner** for source code — and the
flat-tape tokenizer it grew out of. It walks source as a byte stream and records
the `(){}[]` structure (plus XML tags and C preprocessor conditionals) onto a
single flat tape, **never faulting**: imbalance is reported as a *value* (a
repair map with both boundaries), not thrown as an error.

Inspired by the [simdjson](https://github.com/simdjson/simdjson) tape: no
heap-allocated tree, cache-friendly sequential layout, and **classification, not
parsing** — every lexical span is *delimited* by character classification, never
grammared into an AST.

## What it does

- **Structural balance + seams.** Scans `(){}[]` on bytes, ignoring brackets
  inside strings/comments/regex. Unbalanced input never throws — it surfaces as
  findings (unmatched, orphan, crossing, unterminated), each with its source
  offset(s).
- **Per-language lexical tables.** JS, C, Python, XML. The scanner is
  language-agnostic; the swappable table is the only thing that changes. Tables
  can be **harvested** from real TextMate grammars (`harvest.js`).
- **Two structure systems on one tape.** Free-form braces *and* the line-based C
  preprocessor (`#if … #endif`) coexist; where they interleave instead of nest,
  the crossing is reported (a *seam*), never enforced.
- **Provenance policy.** A seam is a **warning for library code**, an **error for
  your own** — the two halves of Postel's Law (be liberal in what you accept, be
  conservative in what you send). See the design spine.
- **Breadth-first projections.** `outline()` for the depth-0 skeleton;
  `defuse.js` for a def/use view (top-level adjacency + use-before-def) *without
  materialising the dependency DAG*.

## Quick start

```cmd
node scan.js src\               :: walk a tree (auto-detect language)
node scan.js --own src\         :: your code: seams are errors
node scan.js -l c kernel\*.c    :: force the C table
node scan.js --defuse app.js    :: balance + def/use projection (JS)
node scan.js --tape app.js      :: print the structural tape as indented ASCII
node scan.js --outline 1 app.js :: folded breadth-first view (raise to peel)
node sfdiff.js old.js new.js    :: subforest diff — whole units, not line deltas
node tdump.js app.js            :: token dump (pool index/value; quiet whitespace)
node tdump.js --signal app.js   :: significant tokens only; --full = revertible
node scan.js --help             :: full usage
```

`scan.js` exits `0` clean, `1` if findings, `2` on a usage error (grep/linter
convention).

## Repository layout

```
scan.js              CLI front end (extension detection, recursive walk, policy)
validate.js          batch validator + built-in self-test suite
lexical-scanner.js   the structural scanner + the lexical tables (JS/C/PY/XML)
bracket-scanner.js   milestone-1 reference: bracket-only scanner
harvest.js           derive a lexical table from a *.tmLanguage.json grammar
defuse.js            breadth-first def/use projection (rides unilexer.js)
tdump.js             token dump: pool index/value pairs; full | brief | signal
unilexer.js          ONE lexer, ONE tape: value pools + structural links in a
                     single pass; tag byte IS the mnemonic
                     (JS, XML, Rust-lexical, Oracle SQL/PLSQL)
valuetape.js         §13b spike (historical; superseded by unilexer.js)
mergegate.js         §13c spike: scanner as a structure-aware merge gate
sfdiff.js            subforest diff — compare versions as whole top-level units
tokenizer.js         the original flat value-token tape (historical; demo-only)
token-tags.js        the mnemonic tag-byte scheme (shared by unilexer + tokenizer)
demos/               runnable demos for each piece (node demos/demo-*.js)
samples/             real files used for validation (incl. a C TextMate grammar)
docs/                design docs (see below)
CHANGELOG.md         progress and setbacks across the PRs
```

## The two layers

1. **Value-token tape** (`tokenizer.js` + `token-tags.js`) — the original work: a
   64-bit-per-token flat tape with an intern pool and mnemonic tag bytes, where
   every token is `(tag, flags, payload)`. Documented in
   [`docs/DESIGN.md`](docs/DESIGN.md).
2. **Structural scanner** (`lexical-scanner.js` and friends) — the tolerant,
   positional structure-and-seam layer this project is mostly about. Documented
   in [`docs/tape-parser-design-decisions.md`](docs/tape-parser-design-decisions.md).

`defuse.js` rides on layer 1 (it needs interned names); `scan.js` / `validate.js`
ride on layer 2.

## Docs

- [`docs/tape-parser-design-decisions.md`](docs/tape-parser-design-decisions.md)
  — the living design spine: philosophy (Postel's Law + Chesterton's Fence), the
  recognition taxonomy (§2a), and future directions (§13: def/use, value/index,
  structure-aware merge).
- [`docs/lexical-tables-findings.md`](docs/lexical-tables-findings.md) — what
  validating tables against real files revealed (harvested-table holes, the
  `<…>` include hazard, the resolved JS regex hole).
- [`docs/DESIGN.md`](docs/DESIGN.md) — the original value-token tape design.
- [`CHANGELOG.md`](CHANGELOG.md) — the progress-and-setbacks history.

## Status

Working prototype, JavaScript, no dependencies (Node 18+ for `node:util`
`parseArgs`; Node 22+ runs the ESM `.js` files without a `package.json`). Tables
are linter-grade and tolerant, not a compiler. See the CHANGELOG for what's
landed and what's still sketched.

## License

MIT — see [LICENSE](LICENSE).
