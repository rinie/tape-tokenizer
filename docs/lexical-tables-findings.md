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
table doesn't model.

**RESOLVED.** `JS_TABLE` now has `regex: true`. The fix was *character
classification, not a regex engine* (§2a): a `prevValue` tracker supplies one
token of left context to disambiguate `/` (division in value position, else a
regex), and `_skipRegex` delimits the literal with a stateful end (`/` closes
only outside a `[ ]` class; `\` escapes; a newline means it was never a regex).
`samples/regex-cases.js` exercises quotes-in-class, brackets-in-class, escaped
slashes, `return /…/`, and real division — all balanced. `regex-hazard.js` (the
demonstration of the hole) now scans clean.

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

## Refinement — the dangerous scope is safe under a line-context gate

The `<…>` include scope is dangerous *globally*, but not *on a `#include`
line*. So rather than discard it, admit it under a gate: a header-name string
`<…>` opens only when the line is a `#include` / `#import` directive
(`onlyOnDirective: ['include', 'import']` in `C_TABLE`). Everywhere else `<`
and `>` stay operators. This is a line-local positional fact, not an AST walk —
scan back to the line start, require `#`, read the directive word.

**Why `#include`/`#import` and not bare "starts with `#`":** `#define MASK
(1 << 3)` also starts with `#`. Gating on bare `#` would let its `<<` open a
header string. Demonstrated in `demo-directive.js`:

```
                                        gated (#include only)   ungated (every line)
1. #include <stdio.h>                   0 findings              0
2. if (a < b) { … }                     0 findings              3   ← '<' opens a string to EOL
3. #define MASK (1 << 3)                0 findings              2   ← '#define' is not #include
4. (a < b) && (c > d)                   0 findings              0
```

The harvester closes the loop: it no longer flat-rejects the `lt-gt` scope —
it recognizes it and emits a **gated** delimiter (`string(gated)`), and the
self-check against the hand-written `C_TABLE` (which now carries the same gated
spec) still matches. The general lesson: harvesting is not binary accept/reject
— some highlighting scopes map to *context-gated* structure.

---

# C is two structure systems on one file — and the seams between them

C source is the line-based preprocessor *combined with* the free-form `{}`
language. Both are nesting structures; they share our one tape:

| family | delimiter | matched by | layer |
|---|---|---|---|
| `(){}[]` | single char | close char | free-form |
| `#if … #endif` | line keyword | directive keyword | line-based |

`C_TABLE` enables the second family with `preprocessor: true`. `#if` / `#ifdef`
/ `#ifndef` open (`#{` in the projection), `#endif` closes (`}#`), and `#elif`
/ `#else` render as `}# #{` — a branch marker is a close+open pair at the same
depth, so each segment reads as a balanced block: `#{ … }# #{ … }#`. The `#`
bookends every block on the outside. (Originally a ternary shape `?…:…;`;
revised so the bracket ROLE stays visible without overloading the true braces.)
They are keyword-matched (interned, O(1)) and live on the same stack as the
braces.

## We scan as-written — we do NOT expand `#include`

This is deliberate and breadth-first. A standalone, well-formed file proves
itself balanced on its own terms. A file whose structure only resolves across an
include boundary cannot — and **that is exactly the signal we want to surface**.

Such a file is reported as having **seams**: `selfContained()` is false and
`seams()` lists the boundaries that cross the file edge. Crucially these are
**warnings, not errors** — the file simply isn't a clean standalone text file.
The repair map separates the two axes:

- `severity: 'error'` — a true malformation that stops the scan (an unterminated
  multi-line token).
- `severity: 'warning'` — a **seam**: structure that doesn't close within the
  file (`unclosed-at-eof`), a closer with no opener (`unopened-at-bof`), or a
  `crossing` where the two families interleave instead of nest.

## The two families can interleave, not just nest

When `#if` straddles a `{ }` (different branches with different braces), the
families cross rather than nest — the same shape as XML's `<b><i></b>`. The
tolerant close (shared with XML) reports each crossing and recovers:

```
#if FOO
    void f() {
#else
    void f() { other();
#endif
}
```
→ two `crossing '{'` findings + one `unclosed-cond` seam. Reported, never
faulted, never "fixed" by guessing.

## Real fragment, validated

`samples/fragment.inc.c` is a real-world lousy include — an `.inc` that opens a
`#if` and a `{` it expects the includer to close:

```
$ node validate.js
  ✓ balanced     samples/sample.c           (self-contained)
  ⚠ 2 seam(s)    samples/fragment.inc.c
       • [seam] line 6: unclosed-cond 'if'  (off 305→535) — not self-contained …
       • [seam] line 8: unmatched-open '{'  (off 362→535) — not self-contained …
```

The seam carries **both boundaries** (where it opened → EOF). See
`demo-seams.js` for the full set: self-contained guard, fragment, brace-opening
macro, the interleave crossing, and a stray `#endif`.

## Takeaway

Two structure systems, one tape, scanned before the preprocessor runs. Files
that close within themselves are clean; files with strange seams across include
boundaries are **warned about, not rejected** — the scanner observes and
reports, it does not enforce or expand.

## Severity is provenance — a seam is a warning for the lib, an error for your code

The scanner only *observes* a seam (a positional fact, family-neutral). Whether
that seam is acceptable is a **policy** decision based on who wrote the file —
not something the scanner should bake in:

| provenance | rationale | seam verdict |
|---|---|---|
| **`lib`** (third-party / included headers) | You don't own them. Guards, `BEGIN/END` macro pairs, X-macro `.inc` fragments are *legitimately* not self-contained. | **warning** |
| **`own`** (your code) | If you write breadth-first, def-before-use, self-contained units, the file **must** close within itself. A seam is *your* broken discipline. | **error** |

`validate.js` carries this as a `--own` / `--lib` policy (default `lib`). The
exact same `fragment.inc.c` reads both ways:

```
  ⚠ 2 seam(s)    fragment.inc.c  [lib]   ← a library include: seams are expected
  ✗ 2 error(s)   fragment.inc.c  [own]   ← if it were ours: [error(seam-in-own-code)]
```

Hard malformations (unterminated tokens) are errors under either policy — only
the *seam* class flips. The scanner stays Gutenberg-neutral; provenance is the
swappable layer that decides what the observation *means*.
