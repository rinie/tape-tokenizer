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
