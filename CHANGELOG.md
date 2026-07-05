# Changelog

Progress **and setbacks** across the project, by merged pull request. Dates are
merge dates. This is a prototype log, not a SemVer release history — it records
what was learned, including the wrong turns, in the spirit of the design's own
"observe and report, nothing swallowed in silence."

The arc: a flat **value-token tape** (PR #1, pre-project) grew into a tolerant,
positional **structural scanner** (#2–#10), with the design philosophy
(Postel's Law + Chesterton's Fence) crystallising along the way; then the
housekeeping wave (#11–#14: layout, line endings, surface conventions), the
**breadth-first projections** built on it (#15–#18: tape views, the §13 spikes,
the subforest diff), and the **consolidation + encoding wave** (#20–#25: one
lexer/one tape, the RATFOR projection principle, and the byte-encoding rule —
direct bytes for closed vocabularies, indirection only for real variation).

## Unreleased — per-keyword mnemonic bytes for Rust (RUST_KEYWORDS)

- Closes the "honest gap" left by PR #29: Rust words no longer all tokenize
  as generic IDENT. Worked the alphabet budget in three tiers rather than one
  shared generic byte: (1) same lexeme AND role as JS — reuse the JS byte
  outright (else/false/for/if/in/let/return/true/while/break/continue/const/
  async/await, plus static/super/try/typeof/yield where Rust's meaning
  drifts from JS's but the spelling stays the mnemonic); (2) different
  spelling, matching role — `fn` takes the SAME byte as JS's `function` and
  Python's `def` (one function role, three languages), `self` takes JS's
  `this` byte (the receiver role); (3) Rust-only concepts with no role to
  borrow — three genuine free-letter fits (mut/pub/struct), everything else
  (as/crate/dyn/enum/extern/impl/loop/match/mod/move/ref/Self/trait/type/
  use/where) takes a 0x80+ block byte decoded back to its spelling by a new
  `RUST_KW_LITERAL` table — the exact `OP_LITERAL` move, one tier down.
- The forcing insight: legible ASCII letters ran out (JS's own keyword table
  already claims nearly the whole alphabet), but byte VALUES didn't — 256 is
  plenty for one language's keywords. "Out of letters" means "block byte +
  decode table," never "share a byte between two different roles" — the
  §13e discipline held under real pressure instead of being relaxed.
- Left as plain IDENT on purpose: `union` (weak/contextual, like Python's
  soft `match`/`case`) and reserved-for-future words that don't appear in
  real code (become, box, priv, unsized, …).
- `samples/sample.rs` extended to exercise the new vocabulary (struct/impl/
  trait/enum/mod/match/loop/dyn/where/move/as, alongside the existing
  raw-string/lifetime coverage); still lossless.

## PR #37 — `tdump.js --outline`: breadth-first view over any of the 7 modes · 2026-07-05

- Ported `scan.js`'s folded breadth-first outline (fold at depth n; a matched
  span starting at depth n-1 collapses to one line via its jump pointer) onto
  the unified tape, generalised across unilexer's THREE bracket families —
  char-matched, name-matched (XML/SQL), indentation (Python/YAML) — with one
  uniform test instead of three per-family byte lists: a token is an OPENER
  iff it links FORWARD (`link(t) > t`). Trivia and bare structural punct
  (`:`/`,`/`;`) are always dropped — separator noise once indentation already
  shows the nesting.
- Motivated by reading a real 675KB OpenAPI spec (a `oneOf` of 30 alternative
  message-type schemas behind one generic POST endpoint) without a jq/XSLT
  mental model: `--outline 9` collapsed the spec to exactly the sibling list
  needed to see the 30 alternatives at a glance, each unexplored branch
  folded to `{ … 620 … }` — proving the "list children at a depth, skip
  whole subtrees via link before descending" idea from the JSON5 design note
  as a real, reusable CLI view rather than a one-off script.

## PR #36 — JSON5 mode (also accepts plain JSON) · 2026-07-05

- `tokenizeJson5` is `tokenize()` narrowed, not a new scan loop: object/array
  `{}[]` are the same char-matched bracket family as JS, `:`/`,` are already
  punct, and `true`/`false`/`null` reuse JS's own keyword bytes — a 3-entry
  keyword map is the entire vocabulary table.
- JSON5's relaxations over strict JSON (single-quoted strings, hex ints,
  unquoted identifier keys, `//`/`/* */` comments, trailing commas) were
  already things `tokenize()` accepted unconditionally, so plain JSON
  tokenizes identically under the same table — JSON is a subset, not a
  separate mode. A stricter table that flags those relaxations rather than
  silently accepting them is deferred (a validation pass over the same tape).
- Object keys carry no distinct tag byte from string values — "is this a
  key" is purely positional (first of a pair inside `{`, followed by `:`),
  recoverable from the tape without the lexer overloading anything for it.
- New fixtures `samples/sample.json` (strict) and `samples/sample.json5`
  (comments, unquoted keys, trailing commas, hex/leading-decimal numbers,
  mixed quoting); `tdump.js`/`tfreq.js` wired for `.json`/`.json5`/`.jsonc`.

## PR #35 — `_tape()` retrofit onto the four older modes · 2026-07-05

- `tokenize` (JS/Rust), `tokenizeXml`, and `tokenizeSql` each carried their own
  inline copy of the pool/grow/emit tape builder from before `_tape()` existed
  (`tokenizePy`/`tokenizeYaml` were the first to use it). All three now route
  through the shared builder; the direct `linkArr[a] = b; linkArr[b] = a;`
  writes scattered through bracket/tag/keyword linking became `link(a, b)`
  calls, and a `poolOf(t)` accessor was added to `_tape()` so XML's
  name-matched tag linking (which needs the interned pool slot, not just the
  token index) still works without reaching into the builder's private
  arrays. `tokenizeRust` needed no change — it already delegates to
  `tokenize`. Verified lossless (`reconstruct() === src`) across all six
  modes, plus `validate.js`, `tfreq.js`, and the `sfdiff` demo unaffected.

## PR #34 — Python + YAML modes: the indentation bracket family (`:{` `}:`) · 2026-06-12

- A third bracket family, after char-matched and name/keyword-matched:
  **indentation-based**. `TAG_INDENT`/`TAG_DEDENT` are zero-width tokens at
  the line's content start, linked like any bracket pair, rendered as the
  digraphs `:{` / `}:`; suppressed inside `([{` (implicit line joining); EOF
  closes whatever's still open.
- `tokenizePy`: triple-quoted (multiline) and single-quoted (newline-bounded)
  strings, string prefixes (`r/b/f/u` combinations), `:=` walrus → assignment
  role, `->` → arrow role, role-grounded keyword bytes for the ones worth
  naming (`def`, `del`, `raise`, `True`/`False`/`None`), generic keyword byte
  for the rest.
- `tokenizeYaml`: `#` comments, both quote styles (`''` is the single-quote
  escape), `---`/`...` document markers (closing all open indent levels),
  block scalars `|`/`>` consumed as ONE string token whose end is determined
  by dedent — an indentation-parameterised end, the same §2a row as Rust's
  raw strings.
- Bug found during verification: the shared whitespace-run scanner consumed
  straight through a newline into the next line's leading indent, so no
  INDENT token ever fired (column was always measured from the wrong
  position). Fixed by stopping ws runs immediately after their last
  `\n`/`\r`, leaving the indent for the line-start branch to measure.
- `tdump.js`/`tfreq.js` wired for `.py`/`.yaml`/`.yml`.

## PR #33 — Add tfreq.js — the frequency data the byte-allocation rule consumes · 2026-06-12

- A measurement tool, not a design change: walks a tree, lexes by extension,
  and reports token counts per class, operator counts per ROLE (grouped by
  tag byte, dialect spellings listed), and top keywords/builtins/identifiers.
  Turns "which byte should this role get" from intuition into a data
  question, per the §13e allocation rule.

## PR #32 — Doc: the complete byte-allocation rule for operators · 2026-06-12

- §13e written down in the user's own words: one byte is one role, roles
  never share a byte; frequency decides which role gets the short byte; the
  assignment is internal preference for reading the representation, not
  semantics. PR #31 was merged mid-flight while pushing this follow-up —
  re-rooted on `main` and pushed as its own PR rather than force-pushing over
  the merge.

## PR #31 — Operator ROLE registry: dialect spellings map to role bytes · 2026-06-12

- **The byte answers "what does it do"; the pool answers "how it was written."**
  OPS reframed as the operator-role registry with C/JS-grounded canonical
  spellings; dialects map their spellings onto roles: Oracle `:=` → assignment
  (0x3D), `=` → equality (0x80 — the Pascal/Oracle reading), `<>`/`!=`/`^=` →
  one not-equal role, `||` → a new CONCAT role byte (mapping it to logical-or
  would mis-role; mapping to `+` would overload arithmetic).
- **The swap C never made**: logical `&&`/`||` vastly outnumber bitwise, so the
  singles 0x26/0x7C now carry the LOGICAL roles and bitwise `&`/`|` moved to
  the block — frequency buys the short byte, the keyword rule applied to
  operators. Display unchanged everywhere (mnemonic column = canonical role
  spelling via OP_LITERAL, value = the lexeme; the ghost already showed
  lexemes).

## PR #30 — Oracle SQL/PL-SQL mode · 2026-06-12

- PL/SQL block keywords are the XML name-matched tag family wearing keyword
  clothes: `IF`/`LOOP`/`CASE`/`BEGIN` open as `{` with the kind as interned
  value; **`END IF` is one `}` token** (two keywords, one closer), name-matched
  tolerantly; plain `END` closes the nearest opener.
- The vocabulary split: keywords class `keyword` byte `k`, well-known
  **built-ins** class `builtin` byte `B` (NVL, SUBSTR, …); a word in both sets
  (REPLACE) is a builtin when `(` follows. Dialects are a data registry —
  oracle implemented; mysql/mssql/postgres/duckdb foreseen as word-set entries.
- Oracle lexical: `--` comments, `'it''s'` doubled-quote escape, `q'[…]'`
  q-quoting (another §2a parameterised end), `"Quoted"` = identifier.

## PR #29 — Rust lexical mode · 2026-06-12

- The §2a **parameterised end** in running code: raw strings `r#"…"#` close on
  `"` + the CAPTURED hash count (`r##"even a "# stays inside"##` is one
  token). Decided with **no backtracking** — the ident scan already stops at
  the `#`/`"`; bounded forward peek, tape stays append-only.
- The scan loop became parameterised per language (JS_OPTS/RUST_OPTS hooks) —
  one loop, never a third copy. Raw idents `r#match`, nested block comments
  (depth counter), char-vs-lifetime `'x'` vs `'static`. Gap: no Rust keyword
  table yet — words tokenize as IDENT.

## PR #28 — tdump: escape newlines in values · 2026-06-12

- Audit: multi-line TOKENS must display internal newlines as `\n`, never as
  real breaks. Templates leaked; fixed via escapeNl on all brief/signal values.
  Invariant: only the newline token (0x10) and the ghost produce real breaks.

## PR #27 — Newline is its own token (0x10) · 2026-06-11

- Each newline run is its own ws-class token — no structural value, but a line
  SIGNAL; ws runs split into newline + intra-line indent tokens (JS and XML).
- Comments KEEP their newlines: byte 0x11, rendered `C(n)`; and in the ghost a
  multi-line comment displays as the whitespace it occupies (its line breaks),
  keeping the ghost line-aligned with the source. tdump deltas moved to the
  indent token (`+`/`-`/`=`), sign first.

## PR #26 — Changelog catch-up #19–#25 · 2026-06-11

- This file brought up to date through the encoding wave.

## PR #25 — Operator/literal encoding arc · 2026-06-11

Six commits, three owner decisions, one rule at the end:

- **Ghost renders operators in full** (`I && I`, not `I & I`) — the projection
  may be wider than one char per token (the cpp-digraph precedent).
- **Every operator gets its OWN byte**: single-char ops their literal ASCII;
  the 33 multi-char JS ops a contiguous `0x80–0xA0` block (`OPS` map), decoded
  by `OP_LITERAL`. Free printables were rejected: ~22 free vs 33 ops, and a
  reused printable (`$` meaning `&&`) is a *false* mnemonic — worse than an
  opaque byte the table decodes. Bonus correctness: longest-match per operator
  (`a=+b` is `=` then `+`, not one bogus `=+` run).
- **Strings and templates carry their own delimiter byte**: `"` 0x22, `'` 0x27
  (also positioned for C char literals), backtick 0x60 for templates. `S` and
  `X` returned to the free letters; regex keeps `R` (`/` is division's).
- **The encoding rule, named** (design §13e): *indirection only for real
  variation, not for a lack of letters — a byte is enough for a programming
  language.* Closed vocabularies (keywords, operators, punctuation, brackets)
  get direct lexeme↔byte maps; open vocabularies (idents, strings, numbers,
  comments, text, ws) carry identity in the pool index. JS spends ~108 of 222
  usable bytes.

## PR #24 — Operators: first-char tag bytes · 2026-06-11  ⚠ superseded same day

- First step toward direct operator encoding: tag byte = the operator's first
  char (`&&` → `&`), pool carries the lexeme. To free `^`/`~`, two keyword
  reassignments: catch `^`→`H` (catcH, pairing with `h` = throw), false
  `~`→`u` (untrue).
- **Superseded within hours** by #25's per-operator bytes — the family-byte
  scheme answered "which family" but the owner wanted "which operator" from
  the byte alone. The keyword reassignments survived; the first-char rule
  did not. Recorded as the stepping stone it was.

## PR #23 — cpp digraphs + XML `>` absorption · 2026-06-10

- **RATFOR refinement: preserve the role, mark the family — never overload.**
  C's `#if` is bracket-role but not a brace: it renders as family-marked
  digraphs, the `#` bookending each block on the outside — `#{` opens, `}#`
  closes, and `#else`/`#elif` render as `}# #{` (a branch marker IS a
  close+open pair; each segment reads balanced by eye). Replaced the earlier
  ternary mnemonics `?:;`. Tag bytes stay single; digraphs live in the
  projection layer.
- **XML: the `>` belongs to the tag.** `<catalog>` is one tape token (the
  closing separator absorbed); `<br/>` one `/` token; only attribute-bearing
  tags keep a separator token (`>` elided from the signal view). Tag tokens
  reconstruct from source spans (§13b's offset+length option).

## PR #22 — defuse on unilexer; tdump views; XML mode · 2026-06-10

- **defuse.js migrated** to the unified tape (semantically identical;
  tokenizer.js is now demo-only). **§13f answered**: whitespace association is
  derivable by adjacency — a projection, never a tape column.
- **tdump.js**: three views over one tape — `--full` (lossless, revertible),
  `--brief` (quiet whitespace), `--signal` (no trivia). Brief whitespace
  notation: indent unit detected once; `' '` and `\n` quiet; level changes as
  sign-first deltas `+\n` / `-\n` (revised mid-PR from `\n+1` on owner
  feedback — the sign leads so changes jump out at the first glyph).
- ⚠ **Found mid-PR**: tdump had been running the **JS lexer over XML** (the
  owner's screenshot showed `<?` as an op token). Fixed by giving unilexer a
  real **XML mode**: open/close tags as `{`/`}` with the interned NAME as
  value (open and close share a pool slot — the O(1) name match visible),
  text `T`, declarations `!`. Bare dump values (the class column already
  implies the kind; quotes were noise).
- The **RATFOR principle** named and recorded: prefer the rational
  representation; don't follow the surface syntax too deep. The lexical table
  is the "FORTRAN backend" — the only place surface syntax may matter.

## PR #21 — Sync discipline: warn about open PRs · 2026-06-10

- New standing rule in §11: before starting a new slice, check
  `gh pr list --state open` and warn the owner — no silent stacking over an
  unmerged PR (the #5/#6 lesson, made procedure).

## PR #20 — Lexer consolidation: unilexer.js · 2026-06-10

- The repo had grown **three lexers** (tokenizer.js, lexical-scanner.js,
  valuetape.js), each with its own string/comment/regex classification.
  `unilexer.js` is the consolidation: one scan pass, one uniform tape carrying
  both layers — value pools (§13b: lossless, dedup by uniqueness, occurrence
  offsets) and structural links + depth.
- **The encoding decision**: the token-tags mnemonic byte IS the tape's tag
  byte, not a debug label; the coarse class is derived from it via a 256-entry
  lookup. `toPrintable()` becomes *ghost source*: `function add(a, b) {` →
  `f I(I, I) {`.
- Consolidation proven by migrating **sfdiff.js** with byte-identical output.
  valuetape.js marked historical; lexical-scanner.js (seams, cpp/XML families,
  harvested tables) the remaining target.

## PR #19 — Changelog catch-up #12–#18 · 2026-06-10

- This file brought up to date (it had stopped at #11); the stale `Unreleased`
  header dated, the CRLF footnote closed by #12 noted.

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
