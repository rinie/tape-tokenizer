# Changelog

Progress **and setbacks** across the project, by merged pull request. Dates are
merge dates. This is a prototype log, not a SemVer release history — it records
what was learned, including the wrong turns, in the spirit of the design's own
"observe and report, nothing swallowed in silence."

The arc: a flat **value-token tape** (PR #1, pre-project) grew into a tolerant,
positional **structural scanner** (#2–#10), with the design philosophy
(Postel's Law + Chesterton's Fence) crystallising along the way.

## Unreleased — repository cleanup (PR #11)

- **Reorganised the tree**: `demos/` for the runnable demos, `docs/` for the
  design docs; source stays at the root. `README.md` rewritten as a real front
  door (it had described only the original tokenizer); `docs/DESIGN.md` given a
  scope note pointing at the structural-parser design. Added this CHANGELOG.
- No behaviour change; all demos, `validate.js`, `scan.js`, and `harvest.js`
  verified after the move.

## PR #10 — Recognise JS regex literals · 2026-06-08

- **Resolved the JS regex hole** discovered back in #3 and carried as a known
  limitation through six PRs. The fix was *character classification, not a regex
  engine*: a one-token left-context tracker (`prevValue`) tells division from a
  regex `/`, and `_skipRegex` delimits the literal with a stateful end (`/`
  closes only outside a `[ ]` class; `\` escapes; a newline means it was never a
  regex). `JS_TABLE` gains `regex: true`; other tables unaffected.
- Recorded the **recognition taxonomy** (design §2a): every span = start
  (simple/complex/context) × end (simple/complex/stateful/parameterised) + the
  inside rule. Regex is the context-start + stateful-end worked example.

## PR #9 — `scan.js` CLI · 2026-06-08

- A conventional command-line front end (`node:util` `parseArgs`, `--help`,
  extension→language detection, recursive walk, `--own`/`--lib`, `--defuse`,
  stdin, linter exit codes) so the scanner runs on real source trees, not just
  hardcoded demos.

## PR #8 — Breadth-first def/use spike (§13a) · 2026-06-08

- First *build* (not just doc) of the def/use projection: per top-level def, its
  direct uses of other top-level names; use-before-def as positional findings
  with provenance severity; Tarjan SCC for a suggested def-before-use reorder
  with mutual-recursion cycles reported as forward-decl clusters. Proves
  "adjacency at one level, don't drown in the DAG."

## PR #7 — §13c structure-aware merge · 2026-06-08

- Doc: a git conflict is a tape cut on the *line grid*; its markers don't line up
  with structural seams. Reframe as a **subforest, not a delta tree** — re-seam
  conflicts to whole structural spans, and gate a resolution on "introduced no
  new seam" (the scanner as a merge gate).

## PR #5 / #6 — Future-directions doc · 2026-06-08  ⚠ setback

- Recorded §13a/§13b (def/use projection + uniform per-token value/index mapping;
  dedup keyed to uniqueness; whitespace as a lossless indexed kind) and the
  **sync-discipline** conventions.
- **Setback — duplicate merge + conflict.** After #4 merged, a stray push
  *recreated* the deleted `topic/harvest-c` branch; it was then merged as #6,
  colliding with the intended #5 and leaving #5 `CONFLICTING`. Resolved by
  merging `main` back into the branch and **verifying content** (no markers,
  each section present once) rather than trusting the auto-merge. Lesson, now a
  standing rule: *before every local git action, fetch and check whether the
  remote branch is gone; if `main` moved, merge it in first.* This is why the two
  PRs share a title and merged seconds apart.

## PR #4 — Harvest a real C TextMate grammar · 2026-06-07

- The biggest step. Harvested VS Code's C grammar into a lexical table and proved
  the loop on the clean case — the harvested table matched the hand-written
  `C_TABLE` exactly.
- **Near-miss, caught.** The grammar's `string.quoted.other.lt-gt.include` scope
  (`<` → `>`) is `#include` highlighting; harvesting it naively would make every
  `<`/`>` a string delimiter and swallow whole files. The harvester rejects it;
  later it was re-admitted **gated to `#include`/`#import` lines** (the
  line-context gate).
- Added the **`#if … #endif` second bracket family** (keyword-matched, tolerant
  of crossing the braces), the **seam** model (unclosed/orphan/crossing as
  findings with both boundaries), and the **provenance policy** (lib = warning,
  own = error).
- Crystallised the **design spine**: Postel's Law (what) + Chesterton's Fence
  (why) — don't reject structure you don't understand; severity is provenance,
  not intrinsic; nothing swallowed in silence.

## PR #3 — Python table + real-file validation · 2026-06-07  ⚠ found a hole

- Added `PYTHON_TABLE` (triple-quoted strings exercise the multi-line-token
  rule) and `validate.js` — run a table over real files and report balance.
- **Setback recorded, not hidden.** Validating real files surfaced that
  `JS_TABLE` had **no regex awareness**: a regex containing a quote (`/['"]/`)
  was read as a string and threw a false seam. `samples/regex-hazard.js` was
  added to *prove* the hole rather than paper over it; it stayed a documented
  limitation until #10.

## PR #2 — Tolerant structural tape scanner (milestones 1–2) · 2026-06-06

- `bracket-scanner.js` (flat bracket tape, 0-based depth, jump pointers) and
  `lexical-scanner.js` (per-language lexical tables so brackets inside
  strings/comments are ignored).
- Two rules baked in from the start: **honest unterminated tokens** (a multi-line
  token running to EOF is recorded by where it *starts*; the end is never
  guessed) and **tolerant, name-matched XML** with no required root (improper
  nesting reported, not enforced).

## PR #1 — Improve dump readability · 2026-04-18  (pre-project baseline)

- Mnemonic labels + brace-depth indentation for the original value-token tape's
  hex dump. The starting point this project extended.

---

### Recurring footnote

Every push warned `LF will be replaced by CRLF` (Windows checkout, no
`.gitattributes`). Cosmetic; line endings normalise on checkout. Left as-is.
