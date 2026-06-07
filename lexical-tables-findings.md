# Lexical Table Findings (milestone 4)

The design handoff is explicit: a lexical table is a **starting hypothesis**, not
ground truth. Harvest it (from a TextMate grammar or the language's documented
lexical grammar), then **validate against real files** and record where it is
wrong for *structural* purposes. This file is that record.

Run the validation yourself: `node validate.js`

## What was added

- `PYTHON_TABLE` — `#` line comments; `"""…"""` / `'''…'''` triple-quoted
  (multi-line) strings listed **before** the single-quoted forms so the longer
  delimiter wins. Triple-quoted strings are the canonical multi-line token: an
  unterminated one running to EOF reports its **start** only and stops — never a
  guessed end.
- `validate.js` — runs a table over real files and reports balance + findings,
  each with a 1-based line (human-facing) and both boundaries where known.
- `samples/sample.py`, `samples/sample.xml` — real, valid files used as a
  known-good corpus.

## Validation results

| Corpus | Table | Result |
|---|---|---|
| The repo's own 8 `.js` files | `JS_TABLE` | ✓ all balanced |
| `samples/sample.py` (docstrings, f-strings, dicts, comments with brackets) | `PYTHON_TABLE` | ✓ balanced |
| `samples/sample.xml` (PI, comment, entities, `>` inside an attribute) | `XML_TABLE` | ✓ balanced |

## Holes found — recorded, not hidden

### 1. `JS_TABLE` has no regex-literal awareness (real hazard)

The repo's own files balance clean, but partly by luck: every regex in them (e.g.
`/[0-9a-fA-F_]/` in `tokenizer.js`) happens to contain internally-balanced
brackets and no quote characters. A regex that contains a quote breaks the table.

`samples/regex-hazard.js` is valid JS that proves it:

```
$ node validate.js js samples/regex-hazard.js
  ✗ 2 finding(s)     samples/regex-hazard.js
       • line 5: unmatched-open '['  (off 321→380)
       • line 5: unterminated-string '''  (off 322)
```

`/['"]/` — the scanner reads the `'` as a string start and swallows real
structure until the next quote. **Cause:** a regex literal is a context the
table doesn't model. **Fix (deferred):** add a `regex` span kind whose start is
disambiguated by the previous significant token (the `_isRegexStart` heuristic
already exists in `tokenizer.js`). Tracked as future table work.

### 2. Python f-string interpolation is treated as opaque (deferred)

`f"…{expr}…"` — brackets inside `{ }` are not counted as structure. In practice
this rarely affects balance because interpolations are themselves balanced, so
`sample.py` validates clean. Matches the design doc's open question on
template-literal / interpolation nesting. Deferred.

### 3. XML entities and attribute `>` validate correctly

`&amp;` / `&gt;` / `&lt;` flow through as opaque bytes (correct — they are not
tags), and a literal `>` inside a quoted attribute value does **not** end the
tag, because `_skipTag` skips quoted attribute values. No hole here; recorded as
a positive confirmation.

## Takeaway

Validation is load-bearing, not ceremony: the clean pass on real files is only
trustworthy alongside the adversarial case that exposes the table's edge. Both
ship together.

---

# Harvesting a real TextMate grammar — C (milestone 4, continued)

Source: `samples/grammars/c.tmLanguage.json` (VS Code's C grammar, the
`*.tmLanguage.json` strict-JSON form). Harvested with `harvest.js`:

```
node harvest.js samples/grammars/c.tmLanguage.json c
```

## The harvester self-validates

The candidate table derived from the grammar is **identical** to our
hand-written `C_TABLE`:

```
── diff vs hand-written C_TABLE (harvester self-check) ──
  lineComments:  ✓ match     (//)
  blockComments: ✓ match     (/* … */)
  strings:       ✓ match     ("…" and '…', both multiline:false)
```

Two cross-checks fell out of this for free:

- The grammar's `string.quoted.double.c` **end** is `"|(?<!\\)(?=\s*\n)` — the
  newline-bound alternative literally encodes "a `"` string cannot cross a
  newline". The harvester reads that as `multiline: false`, matching the choice
  we'd made by hand. The grammar *confirms* our hypothesis.
- `(R?)(")` (C++ raw-string prefix) is correctly **rejected** — the `R?`
  quantifier means it isn't a pure literal, so it can't become a fixed delimiter.

## The grammar is full of structure-hostile highlighting scopes

This is exactly why a harvested table is a hypothesis. The C grammar defines, as
"strings" and "comments", many things that are **not** structural delimiters.
The harvester rejected each, with a reason:

| Scope | begin → end | Why rejected |
|---|---|---|
| `string.quoted.other.lt-gt.include.c` | `<` → `>` | **The dangerous one.** This is `#include <stdio.h>` highlighting. As a delimiter it would make every `<`/`>` a string boundary. |
| `string.quoted.double.include.c` | `"` → `"` | `.include` sub-scope; redundant and out-of-context. |
| `string.unquoted.single.c` | `[^'"]` → … | char class, not a literal. |
| `comment.*.documentation/banner.c` | `(\/\*[!*]+…)` etc. | doc/banner highlighting; non-literal. |
| `comment.block.preprocessor.*.c` | `\n` / `^\s*((#)…)` | preprocessor *regions*, begin is `\n` — contextual, not a delimiter. |

## Proof that the rejection matters

`samples/sample.c` is real C containing `#include <stdio.h>`, `arr[0] < 10`,
char literals `'{'` `'}'`, and strings/comments full of brackets. With the
harvested (correct) table it is balanced. With a naive table that *kept* the
`<…>` include scope:

```
correct  (rejected <...>): 0 findings
naive    (kept <...>)    : 5 findings
     • unmatched-open '{'  off 204→596
     • unmatched-open '('  off 507→596
     • unterminated-string '<'  off 527   ← the '<' in `arr[0] < 10` opens a
     • orphan-close '}'  off 578             "string" that runs to EOF, swallowing
     • orphan-close '}'  off 594             the rest of the file
```

One wrongly-harvested delimiter corrupts the balance of the entire file — the
design doc's warning, demonstrated. The harvester earns its keep by refusing the
scopes that highlighting tolerates but structure cannot.

## Takeaway

Harvest, then **distrust**: accept only pure-literal delimiters from the
canonical structural scopes, reject the highlighting noise with a recorded
reason, and confirm against a hand-written table where one exists. The grammar
is a starting hypothesis and a useful cross-check — never ground truth.
