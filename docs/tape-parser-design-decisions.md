# Tape-Parser — Design Decisions & Handoff

**For:** a coding agent continuing work in the `tape-tokenizer` repo.
**From:** a design conversation. These are settled decisions with the *why* attached, so don't silently reverse one — if a decision turns out wrong, change it deliberately and note why (practice corrects the theory).

**First step before coding:** read the existing repo. There is already a flat-tape tokenizer here (parallel `Uint32Array` hi/lo, an intern pool for O(1) identifier comparison, a single-byte tag scheme, comments stored as trivia in a side array). This work *extends* that design into a **general, tolerant, structural tape parser** for the `{}[]()` structure of most programming languages. Align with the existing tape format and naming; don't fork a parallel design.

---

## 1. What we're building

A parser that walks source as a byte stream and records the `{}[]()` bracket structure onto a flat tape, **tolerantly**: it never faults on unbalanced brackets. Balance is computed *after* the scan as a query over the tape, and the result is a **repair map** — every imbalance reported with its offset — not a first-error abort.

Philosophy (all already in the repo's spirit; keep it):
- **Result-not-exceptions.** Malformation is a *value*, not an emergency. No throwing on bad structure.
- **HTML5, not XML.** Lenient, recover, report findings — not fault-on-first-mismatch.
- **Positional / Gutenberg-honest.** The scanner records positions; it does not judge meaning. Balance is a separate semantic pass.
- **Observe and report, don't enforce and throw.**

## 1a. The spine — Postel's Law, the defensible form

Those four bullets are one principle wearing four hats. The name is **Postel's
Law** (the Robustness Principle): *be liberal in what you accept, be
conservative in what you send.* The whole design is that law applied to source
structure, and the two clauses map onto a single, concrete axis — **provenance**:

| Postel clause | here | mechanism |
|---|---|---|
| *Be liberal in what you accept* | other people's code — libraries, included headers, fragments | the scanner **never faults**; it recovers from unbalanced brackets, improper XML nesting, and `#if`/brace seams. Seams from `lib` code are **warnings**. |
| *Be conservative in what you send* | your own code — breadth-first, def-before-use, self-contained units | the `own` policy holds your files to closing within themselves; a seam in your code is an **error**, not a warning. |

So `--lib` vs `--own` (in `validate.js`) is not an arbitrary toggle — it is the
two halves of Postel, one per direction of data flow. Liberal on input,
conservative on output.

**The defensible form.** Postel's Law has earned real criticism (RFC 9413):
"be liberal" can breed ossification and silent corruption — garbage accepted
becomes garbage depended upon. This design dodges that because **liberal
acceptance is never silent**:

- Every tolerance produces a **reported finding** — both boundaries, a source
  offset, a named kind. We accept the malformed input *and* say exactly where
  and how it deviated. Liberality without hiding.
- The `own` policy is the enforcement of the conservative half — you do not get
  to ship your own seams unnoticed.

The rule, then: **liberal observation, conservative authorship, nothing
swallowed in silence.** Severity is not intrinsic to a finding — the scanner
only observes (Gutenberg-neutral); provenance decides what the observation
*means*. Keep that seam open: the scanner must never bake in a verdict.

### Why be liberal — Chesterton's Fence

Postel says *be liberal*; **Chesterton's Fence** says *why*. Don't tear down a
structure you don't understand: an unbalanced bracket or an unclosed `#if` in
someone else's header is not self-evidently wrong — it may be load-bearing (a
seam that closes across an `#include`, a deliberate `.inc` fragment idiom).
Rejecting the unexplained is arrogance, so we **preserve it on the tape and
merely report it**.

This keys directly to provenance and sharpens `lib` / `own` into something
deeper than "be nice to libraries":

- You may judge strictly only the fences **you built and understand** — your own
  code, held to closing within itself → **errors**.
- The fences **others built**, whose reason you can't see from this file, you
  preserve and merely note → **warnings**.
- Authorship *is* understanding *is* the license to judge.

The one hard line — *only refuse outright corruption* — is Chesterton-exact:
the fence comes down only once you understand it. An unterminated token running
to EOF is the case we genuinely *do* understand (there is no terminator; to
continue is to invent one), so that is where we stop. And even there we tear
nothing down — we refuse to *build* a fake fence by guessing the end.

> **Don't destroy the unexplained; don't fabricate the absent.**

## 2. The real work is the lexical table, not the bracket counting

Counting `{}[]()` onto a tape is ~200 lines and trivial. **The generality lives entirely in knowing which brackets to *ignore*** — those inside string literals, char literals, and comments:

- `"foo)"`, `'}'`, `` `tmpl ${x}` `` (JS template literals — note these nest!)
- `// )`, `/* ] */`, `# )` (line and block comments; `#` for shell/Python/Ruby)
- here-docs, raw strings (`r"..."`, `R"(...)"`), triple-quoted strings (Python)
- **nested** block comments (Rust, D) — needs a depth counter, not a flag

**This is data, not code.** Keep a small **per-language lexical table** describing string/comment/escape/raw delimiters and keyword lists. The scanner stays language-agnostic; the table is the only thing that changes per language. (Same split as routeMap/procedureMap in the OpenAPI work: the table is the swappable semantic layer, the scanner is the fixed Gutenberg infrastructure.)

## 2a. Recognition taxonomy — every span classified by start × end (+ the inside rule)

There is no parsing anywhere. **Every lexical span is *delimited by character
classification*, never parsed** — match a start, consume everything-except-the-
close-or-escape, match an end. What differs between spans is only how hard the
start and the end are to *recognise*. Classify each delimiter on two axes:

**Start — recognise the opener:**
- **simple** — one unambiguous byte (`"` `'` `` ` ``). Pure 1-byte classification.
- **complex** — a multi-byte prefix matched against an exception/prefix table
  (`//` `/*` `<!--` `"""` `<![CDATA[`).
- **context** — the byte is *ambiguous*; needs lookback. Token-class for `/`
  (regex vs division); line-context for `<…>` (only after `#include`).

**End — recognise the closer:**
- **simple** — one byte (`"` closes `"`; newline closes `//`).
- **complex** — a multi-byte sequence (`*/` `-->` `"""` `]]>`).
- **stateful** — a byte that closes only *in a state* (regex `/` only when not
  inside a `[ ]` class).
- **parameterised** — the closer is fixed by what the *start* captured (Rust
  `r###"` → `"###`; a here-doc's label; matched hash count). The hardest end.

**Inside — the one universal rule:** consume every byte *except two classes* —
the **closer** and the **escape**. The escape (`\`) is the in-span exception that
defuses a would-be closer. Two orthogonal modifiers ride on top: **nesting** (a
depth counter — Rust nested `/* */`, template `${}`) and **multiline vs
newline-bounded**.

So a table entry is `{ startKind, startMatch, endKind, endMatch, escape,
nesting?, multiline?, context? }`. Worked examples:

| span | start | end | note |
|---|---|---|---|
| `"…"` string | simple | simple | escape `\` |
| `/* … */` | complex | complex | — |
| `"""…"""` (Python) | complex | complex | multiline |
| `<…>` include (C) | context (line) | simple | §1-gate |
| **regex `/…/`** | **context (token)** | **stateful (`[ ]`)** | the only context+stateful — "the hardest simple thing" |
| Rust `r###"…"###` | context+param | parameterised | **implemented** (unilexer Rust mode: decided after the ident scan stops at the `#`/`"` — bounded forward peek, no backtracking, nothing un-emitted; closer = `"` + the captured hash count) |
| here-doc | complex+param | parameterised | future |

Regex is implemented (`_skipRegex` + a `prevValue` left-context tracker, JS only):
character classification plus **one token of left context** for the ambiguous
`/`. No regex engine — we only *delimit* the literal so its quotes/brackets stop
polluting balance.

## 3. Input model: byte-level UTF-8, not codepoints

Scan **bytes**, do not decode to codepoints. `{}[]()`, quotes, and comment markers are all ASCII, and ASCII bytes can never appear as UTF-8 continuation bytes — so a pure byte scan is correct, fast, and never has to decode. (Page-boundary, not document.) Multibyte UTF-8 inside identifiers/strings just flows through as opaque bytes.

## 4. Per-language support: borrow the data, not the engine

- **Use TextMate grammars** (`*.tmLanguage.json`, the files behind VS Code highlighting) as the *starting point* for each language's lexical table. They're JSON, regex-based, and already enumerate string/comment/escape delimiters and keyword patterns. **Read their tables; extract our small config; ignore their highlighting machinery.** Every language we'd want already has one, maintained, on GitHub.
- **Do NOT adopt Tree-sitter.** It's an AST engine: depth-first, a compiled C dependency per language, and it error-recovers on *its* terms. That's the whole stack we're deliberately not building. We want a tolerant flat tape, not a parse tree.
- **Do NOT use LSP.** A language server is a running process over JSON-RPC, not a readable grammar. Wrong layer, far too heavy.
- **Caveat — validate the extracted table.** TextMate grammars are built for *highlighting*, which tolerates being slightly wrong (a mis-colored token is cosmetic). We use them for *structure*, where one missed string delimiter corrupts balance. So treat each extracted table as a **starting hypothesis** and validate it against real files per language; correct from what you observe. Don't trust it as ground truth.

## 5. Tape data structure (extend the existing one)

- Keep the dense **parallel `Uint32Array`** layout (hi/lo) already in the repo.
- Each token is an entry carrying at least its **source byte offset**.
- Keep the **intern pool** — it makes keyword/identifier and close-token matching an O(1) integer comparison.
- Keep the **single-byte tag scheme** (brackets use their ASCII value; classes get tags). Extend tags as needed for string/comment/keyword/identifier/number classes.
- Comments/whitespace: keep as **trivia in a side array**, attached by offset (as the repo already does).

## 6. Balance & repair map (the after-the-fact query)

- One **O(n) sweep** with a depth counter over the tape.
- Matching a close to its open is an **O(1)** interned-id / tag compare.
- Output a **repair map**: a list of findings — unmatched opens, orphan closes, mismatched pairs — **each with its source offset**, plus (optionally) the implied nesting under lenient recovery. Never stop at the first problem; report them all.

## 7. Printable projection (the debuggability decision — important)

Emit a **one-printable-char-per-token projection** as a `toPrintable()` (debug) rendering, *alongside* the dense numeric tape. **The printable form is a lossy, human-facing view — not the tape itself.** The machine uses the dense arrays; you read the printable string. Best of both.

Rules:
- **Brackets stay literal `{}[]()`.** They're already printable ASCII and self-synchronizing — don't re-encode the one thing that's already perfect.
- **Case mapping — decided (matches C/JS visual grammar):**
  - **lowercase for keywords** — they're the frequent, quiet skeleton. e.g. `i`=if, `f`=for/function, `w`=while, `r`=return.
  - **UPPER for the loud/rare things** — string literal `S`, numeric literal `N`, const/constant identifier `K`.
  - plain identifier → lowercase generic, e.g. `a`.
  - Rationale: in C/JS, UPPER means constant/macro — it *shouts*. Keywords are common connective tissue and should *whisper*. The projection must inherit the reader's existing visual rhythm, not impose a new one.
- **Collisions are fine — it's a projection, not a bijection.** Same-initial keywords (`for`/`function`, `if`/`int`) collide; resolve with a distinct letter, case, or second-letter fallback, but don't agonize — the real token id lives in the `Uint32Array`.
- **One char per token** keeps it aligned and cheap: the printable tape is itself a flat indexable string, and its length equals the token count.
- **Optional:** indent the printable char by depth so the tape *looks* like its nesting (an outline / page-15 view of the structure).

Goal: you can `cat` the tape, read the top-level skeleton at a glance, eyeball balance, grep it, and diff two versions — debug without binary or JSON noise hiding the signal.

## 8. Numbering & columns (breadth-first view)

Depth and position are **different axes** — render them as **separate columns**, not one number.

Per-token debug record: `{ offset, depth, tag }` (plus the source slice when dumping).

- **`offset` → 0-based.** It's a byte position / array index — a substrate fact. Distance from the start is zero.
- **`depth` → 0-based.** Top level *is* depth 0. `depth = opens − closes` naturally yields 0 at the top; don't fight the arithmetic. Scanning all `depth === 0` rows gives the top-level skeleton (the breadth-first outline); nesting is then a column of numbers (or indentation) instead of eye-matched brackets.
- **1-based ONLY in human-facing output.** Error/repair messages that point a person at a location use 1-based line/token ordinals ("unbalanced `(` at line 42, token 3"), because that's how editors number and how people count. Compute line by counting newlines before the offset.

The rule (this is the waterline): **0-based below the waterline (offsets, depth, indices — the machine's truth); 1-based above it, only where addressing a human who will go look.** Convert at the boundary. Canonical example: the first line of a file is **line 1 at offset 0** — both correct, two questions about the same position.

## 9. Engine & architecture (keep the hot scan swappable)

- **Prototype in JS with typed arrays** — this is where the design lives and where breadth-first iteration is fastest. Prove the tolerant-tape logic and the repair-map design here. V8 JITs tight typed-array loops respectably; it won't be simdjson-class but it's plenty for a linter-grade pass.
- **Architect the hot byte-classification scan as a swappable core.** If/when measurement demands (e.g. whole-repo-on-every-keystroke in an editor), compile that scan from **Zig or Rust to WASM** (+ a C ABI) and drop it under the *unchanged* tape interface. Keep the tape format and repair-map logic in JS (the plate); swap the scan engine underneath (the car). **Keep that seam open from day one** — don't fuse the scan into the tape logic.
- **SIMD note:** simdjson's speed comes from classifying bytes in parallel (finding structural chars and string delimiters across a vector at once) — the one thing JS can't do well. Only reach for the WASM/SIMD core if profiling on real workloads says so.
- **Do NOT use C++ for an embeddable core.** No stable ABI means you can't ship a `.so` and let consumers swap it; it fuses the caller to your exact build. Zig (explicit allocators = BYOB, error-unions = Result-not-exceptions, clean C ABI) or Rust (`extern "C"`, `portable-simd`, stable) are the right candidates if/when a native core is needed.

## 10. Suggested milestones

1. **Bracket-only tape on bytes**, no string/comment awareness yet → emit dense tape + `toPrintable()` + the `{offset, depth, tag}` column dump. Prove the projection and numbering feel right by eye.
2. **Add the lexical table** for one language (start with JS or C). Hand-write the first table; get string/comment/escape/template-nesting handling correct. Validate against real files.
3. **Repair-map query** — the O(n) balance sweep reporting all imbalances with offsets; human-facing messages in 1-based line/token.
4. **Harvest a TextMate grammar** into a second language's table; validate; note where the highlighting grammar was wrong for structural purposes.
5. **Profile.** Only if needed, extract the scan into a WASM core behind the existing tape interface.

## 11. Coding conventions (repo owner's standing preferences)

- **Node.js / JavaScript.** Always `.js` — never `.mjs` / `.cjs`.
- **Semicolons always; single quotes.**
- **No inline exports** — collect exports at the bottom of the file.
- ESLint: **`eslint-config-airbnb-extended`** (ESLint 9 flat config; TS-aware).
- Windows dev environment: prefer `cmd` over PowerShell over bash for shell commands.
  (The shell preference is for other reasons — *not* line endings.)
- `git clone` with `--depth 1` unless history is needed.
- All code-related discussion and comments in **English**.
- **Surface conventions — owner develops on Windows but prefers the unix forms.**
  Default to **lowercase**, **LF**, and **`/` directory separators** in anything
  the project emits (paths in output, generated files), even on Windows. These
  cost little and read consistently.
- **Two tiers, and don't confuse them.** "Observe and report, nothing swallowed
  in silence" governs **structure** (brackets, seams, crossings) — those are
  reported. **Cosmetic surface** (line endings, path slashes, case) carries no
  structural meaning, so it gets the *liberal half of Postel only*: accept any
  variant and **normalise silently — no warning**. A4-vs-Letter doesn't deserve a
  warning light; it's the same printer, a different paper size.
  - **Line endings** — `\n`, `\r\n`, a bare `\r`: all equivalent. The scanner
    reads bytes, so `\r` flows through as harmless trivia. Accept silently; do
    **not** flag CRLF, lone `\r`, or mixed endings. (Normalisation, if any,
    belongs to `.gitattributes`, not to a finding.)
  - **Path slashes** — accept `\` or `/` on input; emit `/` (see `scan.js`
    `showPath`). No warning.
  - **Case** — prefer lowercase (it reads more nicely); never warn on the choice.
- **Branching workflow:** the agent is the *only* brancher — every change goes on
  a topic branch with a PR; the repo owner resolves to `main` at each resting
  point. The agent does not merge or delete branches without being asked.
- **Sync discipline (because the owner resolves to `main` and deletes the topic
  branch on merge):**
  - **Before every local git action, fetch + check whether the remote branch is
    gone.** A deleted upstream means the last PR was merged — re-root on `main`
    rather than acting on a dead branch.
  - **Fetch before every push.**
  - **If `main` moved (you missed changes), merge `main` in** before continuing or
    pushing — don't build on a stale base. Merge (not rebase), keeping the
    owner's merge commits intact.
  - **Before starting a new slice of work, check for unresolved PRs**
    (`gh pr list --state open`) **and warn the owner** — let them decide whether
    to resolve first or proceed. Don't silently stack new work over an unmerged
    PR; that's how the #5/#6 duplicate-merge conflict happened.

## 12. Open questions to resolve with the repo owner

- Exact tag-byte assignments for the new token classes (string/comment/keyword/identifier/number) vs. the existing scheme — align with what's already in the repo.
- Whether the printable projection is a build-time debug helper only, or a first-class output format worth stabilizing.
- Lenient-recovery policy for the repair map: just *report* imbalances, or also emit a *suggested* repaired nesting? (Default: report only; suggesting is a later, optional layer.)
- Template-literal and here-doc nesting depth limits, if any.

---

## 13. Future directions (sketched, not yet committed)

Two related ideas. They are one stack: 13b (a uniform value/index mapping per
token) is the **substrate**; 13a (a breadth-first def/use projection) is the
**query** that rides on it.

### 13a. Breadth-first def/use projection — see depth-first code without drowning in the DAG

**Goal.** Display the breadth-first properties of depth-first-organised code (the
top-level shape, and def-before-use violations) without materialising the whole
dependency DAG. Aimed at def-before-use refactoring.

**The core realisation.** A DAG drowns you because you render *reachability* —
all paths, transitively, across every depth. Don't. **Breadth-first means
adjacency at one level, never transitive closure.** Peel the DAG one layer at a
time; each layer is a flat table. The tape's **depth column** is the leash that
keeps you on one slice; `outline()` already emits exactly that slice.

**What's nearly free from today's tape.**
- *Atomic spans.* Each depth-0 `{…}` is a top-level definition, and the jump
  pointers give its bounds in O(1). Reordering definitions is cut-and-paste of
  whole spans — no reparse.
- *O(1) name identity* via the intern pool (the `tokenizer.js` lineage).
- *Positional honesty.* Use-before-def is an offset comparison → a finding **with
  both boundaries** (use offset + def offset), straight into the repair-map model.

**What you add.** A second pass that, per depth-0 span, records
`{ definedName, usedNames[], offset, span:[open,close] }` — the def is the ident
before the depth-0 `(`/`{`; the uses are the interned idents inside. That yields a
**flat adjacency** (top-level def → names it directly mentions): an O(n) edge
list read as a table, not a sprawl. Then:
- `useBeforeDef()` — a linear sweep; any use whose def is later in the file is a
  finding, **severity by provenance** (lib = warning, own = error — Postel /
  Chesterton carry over verbatim: a forward reference in your own code breaks the
  discipline you opted into).
- `topoOrder()` — a suggested def-before-use reordering of the atomic spans.
  Honest part: a call graph is **not** a DAG — mutual recursion makes cycles.
  Don't fail; report each strongly-connected component as a cluster that needs a
  forward declaration to break. The cycle is a named finding, not a crash.

**Caveats (linter-grade, not compiler-grade).** Needs names on the tape (rides on
the intern-pool tape, not the structure-only scanner). It is positional and
tolerant — it won't resolve *which* `foo` under overloading/shadowing. Do def/use
**per scope level**; flattening nested scopes into one namespace brings the DAG
complexity back. It's a lossy, human-facing projection in the same spirit as
`toPrintable()`.

### 13b. Uniform value/index mapping per token — the side-tables listed next to the lexer

> **Spiked** — `valuetape.js` + `demos/demo-valuetape.js`. A lossless,
> fully-pooled value tape: every token (whitespace and comments included) is
> `(kind, poolIndex, offset)` on a dense integer tape; per-kind pools beside it;
> dedup keyed to uniqueness (ws/ident/keyword/punct interned, literals
> per-occurrence); interned entries carry occurrence offsets (the 13a
> cross-reference); `reconstruct()` rebuilds the source byte-for-byte from the
> pools. Observed: whitespace interns ~6× on a small sample. Templates are one
> token (no `${}` split) — a noted spike limitation.

**Goal.** Every value-bearing token (identifier, number, string, template, regex,
char, …) carries, as its dense-tape payload, an **index into a per-kind value
pool**. The tape stays pure integers (the simdjson spirit already in the repo);
the value pools are **listed next to the lexer output** as separate,
human-inspectable columns.

This *generalises the intern pool*. Identifiers already do it (intern id →
`names[]`); strings already half-do it (side-buffer index). Make it uniform and
per-kind: `IDENT → names[]`, `NUMBER/DOUBLE → numbers[]`, `STRING → strings[]`,
`TEMPLATE/REGEX/CHAR → their pools`. Then every token is one shape —
`(tag, flags, index)` — where value tokens index a value pool and structural
tokens index a partner (the jump). One uniform tape.

**Payoffs.**
- **O(1) value equality for *all* value kinds**, not just identifiers: two `3.14`
  literals or two `"foo"` strings are equal iff their indices are equal.
- **Inspectable.** A tape dump shows `IDENT id=4 "foo"`, `NUMBER n=2 "3.14"`,
  `STRING s=7 "bar"` — the values listed alongside the lexer, the dense tape
  staying numeric.

**Dedup is keyed to uniqueness — intern only where the vocabulary is limited.**
- **Identifiers (and keywords): intern / dedup.** Their uniqueness is limited — a
  small vocabulary hammered over and over (`i`, `foo`, `this`) — so collapsing the
  many occurrences to one entry pays: O(1) compare, and the occurrence list is the
  cross-reference 13a wants.
- **Numbers, strings, templates, regex, chars: don't bother — store one entry per
  occurrence.** They are mostly unique, so interning rarely pays its keep; the
  **waste of storing duplicates is acceptable** and the scan stays simpler/faster.
  (Equality still works via the offset/length lexeme; you just don't pre-collapse.)
- **Whitespace: a first-class indexed kind, and it interns like identifiers.**
  Indentation runs are a tiny, heavily-repeated vocabulary (`\n    `, `\n\t\t`), so
  dedup is very effective. Promoting whitespace from *sided trivia* (§5) to an
  indexed token makes the tape **lossless** — source reconstructs byte-for-byte
  from tape + pools — and, crucially for 13a, a moved span **carries its own
  leading/trailing whitespace and indentation** instead of losing its formatting.
  Comments fold in the same way.

**It is the substrate for 13a.** If each pool entry also records the **source
offsets where it occurred**, the value table becomes a cross-reference index:
every occurrence of `foo` → its offset list. That occurrence list *is* the
use-list def/use needs. So 13b is not a separate feature — it is the symbol /
occurrence index that 13a queries.

**Open per-kind choices (honest).**
- Store the **raw source slice** (offset+length, zero-alloc — the design doc's
  no-alloc interning option) vs a **decoded/parsed value** (escapes resolved,
  number parsed). Lossless leans to keeping the lexeme — `0x1F_00` and `7936` are
  the same value but different tokens; keep the text, parse on demand.
- Dedup keyed to uniqueness (above): intern identifiers/keywords/whitespace;
  store-per-occurrence for numbers/strings/regex/chars (waste acceptable).
- Stays positional/Gutenberg: pool entries are keyed by value but carry offsets,
  so the value column is still a *position* index, not a semantic claim.

### 13c. Structure-aware merge — a subforest, not a delta tree

> **Spiked (the merge gate)** — `mergegate.js` + `demos/demo-mergegate.js`.
> `splitConflict()` reconstructs ours/theirs from a marked file; `mergeGate()`
> scans both parents and the resolution and rejects any resolution that is *more*
> structurally broken than its parents (a seam kind whose count exceeds
> `max(ours, theirs)` was introduced by the merge). Demonstrated: a botched
> resolution that drops a `}` is rejected with `1× unmatched-open`; clean picks
> pass. Also shows the motivation for operation 1 — a conflict can split a `{`
> from its closing `}`, leaving a reconstructed parent unbalanced (markers on the
> line grid, not the structural grid). Operation 1 (re-seam conflicts to spans)
> and offset-level seam identity across versions remain future work.

**The observation.** A git conflict is a *tape with self-describing sentinels*
(`<<<<<<<` / `=======` / `>>>>>>>`), but cut on the **line grid** — wherever the
3-way text diff (Myers/histogram, structure-blind) couldn't auto-resolve
overlapping line ranges. Those marker boundaries almost never coincide with the
**structural seams** this scanner finds. A marker routinely starts mid-definition,
or splits a `{ }` pair so the open sits in *ours* and the close in *theirs*. They
are signals cut to the wrong grid.

Two costs, both things the scanner already sees:
- **Comprehension** — you resolve a fragment that isn't a structural unit; you're
  reasoning about half a span.
- **Correctness** — resolving marker-by-marker (ours here, theirs there) can land
  a file that is structurally unbalanced: an unmatched brace, a crossing, an
  unclosed `#if`. That is *precisely* a repair-map seam. Line-grain conflict
  granularity manufactures the exact malformation the scanner reports.

**The reframe — subforest, not delta tree.** A diff hands you a *delta tree*:
changes on the line grid, half-spans, shrapnel. Work instead with a **subforest**
— the affected **whole subtrees** (spans, top-level definitions, `#if/#endif`
regions) lifted out as complete units from the file's top-level **forest** (no
envelope → a forest of definitions, never one root, §6/§13a). You diff and merge
whole subtrees, not line deltas.

**Two operations the tape enables.**
1. **Re-seam the conflict to structure.** Widen each conflict region out to its
   enclosing structural seam — whole `{…}` span / whole definition / whole
   `#if…#endif` — using the jump pointers (O(1) bounds). Now you resolve whole
   units of the subforest, not line shrapnel.
2. **Validate the resolution (the scanner as a merge gate).** Scan the merged
   result; any structural seam present in the resolution but in *neither* parent
   was **introduced by the merge** — provenance: "this resolution broke balance."
   The repair map becomes a gate: a resolution that adds no new seam is
   structurally safe; one that does is rejected with both boundaries pointed at.

**Spine ties.** Endpoints (breadth — two worktrees) tell you *what* clashed; the
structural seams tell you *where it is safe to cut*. It is Chesterton's Fence on
the merge: don't trust the line-diff's seams (not load-bearing), preserve and
align to the real structural ones, and validate rather than assume. The whole
identity in one line: **git markers are a flat tape cut on the line grid; ours is
the same idea cut on the structural grid — a structure-aware merge re-seams the
conflict tape along the structural one.**

### 13d. Subforest diff — the breadth-first delta

> **Spiked** — `sfdiff.js` + `demos/demo-sfdiff.js` + the
> `samples/sfdiff-old.js` / `-new.js` pair.

The endpoint counterpart of 13c: compare two *versions* of a file as a forest of
whole top-level units, never as line deltas. Segment each version's top level
into units (named declarations + the loose top-level code), **match units by
name across versions** (the breadth-first move — one level, identity first),
compare each pair by a **content fingerprint over significant tokens**, and
descend only into a modified unit — one step, to its first differing token.

Because whitespace and comments are separate kinds on the value tape (13b), they
simply don't participate in the fingerprint. Consequences, all deliberate:

| change | line diff says | subforest diff says |
|---|---|---|
| reindent / reformat a unit | a wall of changed lines | **unchanged** |
| add/edit comments | changed lines | **unchanged** |
| move a unit within the file | remove-block + add-block | **moved** (content identical) |
| edit one token | changed line(s) | **modified**, first differing token pointed at in both versions |

Moved detection is an LCS over the common-name order (names that fell out of the
longest common subsequence moved). Exit 0 = structurally identical — which makes
`sfdiff` usable as a *reformat-safety check*: prove a formatting pass changed
nothing. Same honest segmentation scope as 13a (top-level `function`/`class`;
const/arrow forms pool into the loose unit). This is the worktree-vs-diff
conversation made into a tool: endpoints compared breadth-first on the
structural grid, the DAG never materialised.

### 13e. One lexer, one tape — the consolidation

> **Spiked** — `unilexer.js` + `demos/demo-unilexer.js`; `sfdiff.js` migrated
> onto it with byte-identical output.

The repo had grown **three lexers** (tokenizer.js, lexical-scanner.js,
valuetape.js), each with its own copy of string/comment/regex classification —
a maintenance seam of our own making. `unilexer.js` is the consolidation
target: **one scan pass, one uniform tape carrying both layers** — every token
indexes a per-class value pool (13b: dedup keyed to uniqueness, lossless
reconstruction, occurrence offsets), and brackets additionally carry partner
links and depth (tolerant, non-faulting).

**The encoding decision — the mnemonic byte IS the tag.** token-tags.js's
printable-ASCII scheme is promoted from debug labelling to the tape encoding
itself. One byte per token: brackets/punct keep their literal ASCII, keywords
get their lowercase mnemonics (`f`unction, `r`eturn, `i`f — they whisper),
literals their UPPERCASE initials (`I N D X R` — they shout; STRING is its
own delimiter — `"` `'` for strings, backtick for templates; `R` stays for
regex since `/` is division's — literal-ASCII like the brackets), operators
their own byte (single-char ops their literal ASCII — to free `^`/`~`, catch
moved to `H` and false to `u`; the 33 multi-char ops a contiguous 0x80–0xA0
block via the `OPS` table, decoded by `OP_LITERAL`), comments `#`, whitespace
`' '`. The coarse class for programmatic queries is *derived* from the byte
via a 256-entry lookup — no second per-token column. Mnemonic for humans,
class for machines, one byte for both. `toPrintable()` of the full tape is
then *ghost source*:

```
src   │ function add(a, b) {          const nums = [1, 2.5, 0xFF];
ghost │ f I(I, I) {                    c I = [N, D, N];
```

(Note the `N`/`D` int-vs-float distinction surviving into the ghost.)

**The rule (owner's formulation): indirection only for real variation, not
for a lack of letters — a byte is enough for a programming language.**

- **Closed vocabularies** — keywords, operators, punctuation, brackets: the
  language defines a fixed, finite set, so the tag byte IS the identity.
  Direct lexeme↔byte mapping (`KEYWORDS`, `OPS`/`OP_LITERAL`); no lookup to
  know *which* token. The pool entry for these carries only the occurrence
  list (the 13a cross-reference), never identity.
- **Open vocabularies** — identifiers, strings, numbers, comments, text,
  whitespace runs: unbounded by the language, varied by the program — *real
  variation* — so the byte carries the class and identity lives in the pool
  index.

**Operators are encoded by ROLE** (refinement, owner's call): OPS is the
operator-role registry — canonical C/JS-grounded spellings, dialect spellings
mapped on top (SQL_OP_ROLES: `:=` → assignment, `=` → equality, `<>`/`^=` →
not-equal, `||` → a concat role of its own). And frequency buys the short
byte, the keyword rule applied to operators: logical `&&`/`||` take the
singles 0x26/0x7C (the swap C never made); rare bitwise `&`/`|` pay the block
indirection. The byte answers "what does it do"; the pool answers "how it was
written"; OP_LITERAL renders the role's canonical spelling.

The allocation rule, complete (owner's formulation): **no operator-overloading
mess — one byte is one role, roles never share a byte; frequency analysis
decides which role gets the short byte; and the assignment is INTERNAL
preference for checking the representation, not semantics.** Every display
path decodes through the table (OP_LITERAL for the mnemonic, the pool for the
spelling), so reallocating a byte costs a legend update, never a meaning
change.

The byte budget confirms "a byte is enough": JS spends ~108 of the 222 usable
bytes (0x21–0xFE; control chars excluded) — 12 punct/bracket + 15 single-char
ops + 33 multi-char ops + 40 keywords + 6 literal classes + ws/comment. Even
C++ (~95 keywords, ~50 operators) fits with room left. The fixed vocabulary of
a programming language is byte-sized; only its *programs* need indirection.

**Migration state (honest):** sfdiff.js rides unilexer (verified byte-identical
verdicts); defuse.js rides unilexer (verified semantically identical — tape
indices shift because ws/comment tokens now occupy slots); valuetape.js stays
as the 13b historical spike and tokenizer.js is now demo-only.
lexical-scanner.js (scan/validate — seams, cpp/XML families, multi-language
tables, the harvested-table mechanism) is the remaining target; the
structural-seam machinery moves last because it is the most load-bearing.
Until then unilexer carries JS, XML, and a Rust LEXICAL mode (raw strings /
raw idents / nested comments / char-vs-lifetime — the parameterised-end row of
2a in running code; no Rust keyword/mnemonic table yet, so Rust words tokenize
as IDENT). The scan loop is parameterised per language (JS_OPTS / RUST_OPTS) —
one loop with hooks, never a third copy. The SQL/PL-SQL mode (Oracle dialect) followed: PL/SQL's block
keywords ARE the XML name-matched tag family wearing keyword clothes — IF /
LOOP / CASE / BEGIN open as '{' with the kind as interned value, and END IF is
ONE '}' token (two keywords, one closer) name-matched to its opener. The
keyword-vs-builtin split is the 13e encoding rule's boundary case: keywords
class 'keyword' (byte 'k'), well-known builtins class 'builtin' (byte 'B') —
both pooled, per-item mnemonic bytes deferred like Rust's. Dialects are a
registry (SQL_DIALECTS): oracle implemented; mysql / mssql / postgres / duckdb
foreseen as word-set + quoting entries, not scanner changes. Oracle lexical
specifics: '' doubled-quote escape, q'[…]' q-quoting (another 2a parameterised
end), "Quoted" = identifier not string, := <> .. operators.

### 13f. Whitespace association & the dump views — projections, not tape columns

> **Spiked** — `tdump.js`; defuse migration in the same PR.

**The question:** should whitespace be *associated* with a leading/following
"real" token, and would that complicate the tape?

**The decision: no tape change.** Whitespace tokens already sit physically
adjacent to their neighbours on the uniform tape (13b/13e), so attachment is
**derivable by adjacency in O(1)** — the ws token before a real token *is* its
leading trivia; the one after *is* its trailing. Conventions that split runs
(Roslyn-style: trailing trivia ends at the first newline, the rest leads the
next token) are equally derivable. Storing an owner column would bake ONE
attachment policy into the substrate; deriving keeps the tape Gutenberg-neutral
and lets each consumer attach differently (sfdiff ignores trivia entirely; a
span-mover takes the leading ws with the span; a comment-docs tool binds
comments forward). **Association is a view, not a fact of the tape.**

**The dump views (`tdump.js`)** — three projections over the one unchanged tape:

- `--full` — complete and revertible: exact JSON-escaped lexemes; the value
  column concatenates back to the original source (verified in the footer).
- `--brief` (default) — the signal with quiet whitespace (notation below).
- `--signal` — significant tokens only; trivia omitted *from the view* (it is
  still on the tape — a view, not a loss). Tape indices stay stable across
  views.

Each row is `[tape index] tag-char class#poolIndex value` — the index/value
pair listed next to the lexer, with interned classes visibly reusing pool
slots (`ws#0` is *the* single inter-token space). **Values are bare** in
brief/signal (the class column already implies the kind — quotes would be
noise; a string's own quotes are part of its lexeme and show naturally);
`--full` JSON-escapes the exact source text so the column reverts.

**XML on the unified tape — structural role over surface syntax** (owner's
call): an open tag projects as `{` and a close tag as `}` — the universal
bracket mnemonics — with the tag NAME as the pooled value. Names are interned,
so `<book>` and `</book>` share one pool slot (`{ tag#1 book` / `} tag#1 book`)
— the O(1) name match made visible in the dump. Text is `T`, declarations `!`,
comments `#`; attributes tokenize as ident/op/string inside the tag.

**The `>` is a closing separator, not a token of its own** (owner's call). An
attribute-less tag absorbs it: `<catalog>` is ONE tape token. An
attribute-less self-closing tag is one `/` token (`<br/>`). Only
attribute-bearing tags keep a trailing separator token — `>` (elided from the
signal view; it carries no signal) or `/>` (kept; it says the element closed).
Losslessness holds because tag tokens reconstruct from their source SPAN
(offset to next offset — §13b's offset+length raw-slice option), which carries
the `<`/`</` prefix and any absorbed `>` for free. `toPrintable()` of XML is
the same ghost-source skeleton as code — `<title>text</title>` reads `{T}`.
This is the first bite of the lexical-scanner migration (13e).

**The name for this is the RATFOR principle** (owner's framing — Kernighan &
Plauger, *Software Tools*, 1976). RATFOR's stance: FORTRAN's surface syntax is
not a reasonable medium for *seeing* structure, so give the structure one
rational surface (`{}` blocks, free form) and treat the underlying syntax as a
compilation detail. The mnemonic projection is the same move generalised:
**prefer the rational representation; don't follow the surface syntax too
deep.** `{` is what an open *is* — whether the underlying "FORTRAN" spells it
`{` or `<book>`.

**Refinement (owner's call): preserve the role, mark the family — never
overload.** Two *different* nesting families must not collapse onto one symbol:
C's `#if` is bracket-role but it is not a brace, so it renders as a
family-marked digraph — `#{` opens, `}#` closes, and `#else`/`#elif` render as
`}# #{` (a branch marker IS a close+open pair at the same depth, so every
segment reads as a balanced block) — the `#` bookending each block on the
OUTSIDE at both ends (`}#` over `#}`, mirroring `#{`). The brace shape carries the role; the `#` carries the family. XML tags
*may* use plain `{`/`}` because in an XML file there is no second brace family
to collide with; in C there is. (Tag bytes stay single internally — the digraph
lives in the projection layer, slightly relaxing §7's "length == token count"
for this family.) One inversion: RATFOR was a *writing* tool (author
rationally, compile down, never read the output); ours is a *reading*
projection (ingest any surface, view it rationally) — and because the tape is
lossless, the arrow runs both ways. The per-language lexical table (§2) is
exactly the "FORTRAN backend" of this scheme: the only place surface syntax is
allowed to matter.

**Brief whitespace notation** — report the common cases briefly, surface only
the deviations. The file's **indent unit** (tabs, or the most common
space-step) is detected once and declared in the header; then:

| rendering | meaning |
|---|---|
| `' '` | one inter-token space (the overwhelmingly common case) |
| `' '(n)` / `\t(n)` | n spaces / tabs mid-line |
| `\n` | the NEWLINE TOKEN — byte `0x10`, its own ws token: no structural value, but a line *signal* (its byte sits in the control range its content comes from) |
| `+` `-` `+2` `=` | on the following INDENT token: level change in units, sign first; `=` = unchanged (quiet) |
| `-\n` | a zero-indent line — the delta lands on the newline token itself |
| `\n(k)` | k consecutive newlines (blank lines) |
| `C(n)` | a comment that CONTAINS n newlines keeps them inside (byte `0x11`); single-line comments stay `#`, the trailing newline excluded |
| `…"  "` | an off-unit indent shown explicitly — a deviation worth seeing |

With newlines as their own tokens, `toPrintable()` breaks lines where the
source does — the ghost is line-structured like the original.

The sign comes **first** (owner's call, and the original `+\t`/`-\t` spec):
scanning the value column, a level change jumps out at the first glyph, while
quiet `\n` rows share no prefix with it — and it rides the diff `+`/`-` reflex.
The level *change* is the information; unchanged levels stay quiet — the same
breadth-first instinct as the folding outline (13d's `--outline`): show the
skeleton, fold the routine.
