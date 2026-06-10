# Changelog

Progress **and setbacks** across the project, by merged pull request. Dates are
merge dates. This is a prototype log, not a SemVer release history — it records
what was learned, including the wrong turns, in the spirit of the design's own
"observe and report, nothing swallowed in silence."

The arc: a flat **value-token tape** (PR #1, pre-project) grew into a tolerant,
positional **structural scanner** (#2–#10), with the design philosophy
(Postel's Law + Chesterton's Fence) crystallising along the way; then the
housekeeping wave (#11–#14: layout, line endings, surface conventions) and the
**breadth-first projections** built on it (#15–#18: tape views, the §13 spikes,
the subforest diff).

## PR #18 — Breadth-first views: folding outline + subforest diff · 2026-06-10

- `scan.js --outline <n>`: the tape **folded** at depth *n* — a matched opener
  collapses its whole span to one line (`{ … 12 … }`) via its jump pointer;
  raise *n* to peel one more layer. Unmatched openers are never folded (no
  guessed ends) — they print `…?`.
- `sfdiff.js` (**§13d, spiked**): the subforest diff — compare two versions as a
  forest of whole top-level units **matched by name**, fingerprinted over
  significant tokens. Whitespace and comments are separate kinds on the value
  tape, so reformatting reads as *unchanged*, a relocated unit as *moved*, and a
  one-token edit as *modified* with the first differing token shown for both
  sides. On the demo pair: ~11 changed lines on the line grid vs **one** changed
  token on the structural grid. Exit 0 = structurally identical, so it doubles
  as a reformat-safety check.

## PR #17 — Spike: structure-aware merge gate (§13c) · 2026-06-09

- `mergegate.js`: `splitConflict()` reconstructs ours/theirs from a
  conflict-marked file; `mergeGate()` rejects any resolution that is *more
  structurally broken than its parents* (a seam kind exceeding
  `max(ours, theirs)` was introduced by the merge). Demonstrated: a botched
  resolution dropping a `}` is rejected with `1× unmatched-open`; clean picks
  pass.
- Also demonstrated the §13c thesis literally: a conflict whose markers split a
  `while {` from its closing `}` leaves the reconstructed parent unbalanced —
  the line grid cutting across a structural span. Operation 1 (re-seaming
  conflicts to spans) remains future work.

## PR #16 — Spike: lossless fully-pooled value tape (§13b) · 2026-06-09

- `valuetape.js`: every token — whitespace and comments included — on a dense
  integer tape as `(kind, poolIndex, offset)`, with per-kind value pools beside
  it. **Dedup keyed to uniqueness**: ws/ident/keyword/punct interned (whitespace
  compressed ~6× on the sample), literals stored per occurrence. Interned
  entries carry occurrence offsets — the cross-reference §13a queries.
- `reconstruct()` rebuilds the source **byte-for-byte from the pools**, proving
  losslessness — the property that later made the subforest diff
  whitespace-blind for free. Templates are one token (no `${}` split) — noted
  limitation.

## PR #15 — `scan.js --tape` · 2026-06-09

- `-t/--tape` prints the structural tape as indented ASCII — one printable char
  per token, indented by nesting depth — for any language table.

## PR #14 — Cosmetic surface is liberal-only Postel · 2026-06-08  ⚠ correction

- **Setback (a mis-stated principle), corrected the same day.** #13 had recorded
  "accept both, warn for the exception" for line endings; the owner's actual
  position is *no warning at all* for cosmetics. The doc now draws the line:
  **structure** gets observe-and-report; **cosmetic surface** (line endings,
  slashes, case) gets only the liberal half — accept any variant, normalise
  silently. CRLF, lone `\r`, and mixed endings are explicitly *not* findings:
  "A4 vs Letter — a different paper size in the same printer."

## PR #13 — Unix `/` in scan output; surface conventions · 2026-06-08

- `scan.js` displays paths with `/` regardless of OS (input accepts either
  slash). Design §11 records the owner's surface conventions: lowercase, LF,
  and `/` in anything the project emits — Windows development notwithstanding.

## PR #12 — `.gitattributes`: normalise text to LF · 2026-06-08

- `* text=auto eol=lf` ends the recurring CRLF warning noted in this file's
  footnote (git was right to warn; the fix is declaring the canonical form).
  Renormalisation was a no-op — the blobs were already LF — so the change is
  the attribute file only. Warnings since flipped direction (`CRLF → LF`),
  confirming the attribute governs.

## PR #11 — Repository cleanup · 2026-06-08

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

Every push through PR #11 warned `LF will be replaced by CRLF` (Windows
checkout, no `.gitattributes`). Cosmetic; left as-is at the time — then
resolved in PR #12 by declaring LF canonical.
