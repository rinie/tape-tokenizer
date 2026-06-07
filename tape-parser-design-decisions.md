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

## 2. The real work is the lexical table, not the bracket counting

Counting `{}[]()` onto a tape is ~200 lines and trivial. **The generality lives entirely in knowing which brackets to *ignore*** — those inside string literals, char literals, and comments:

- `"foo)"`, `'}'`, `` `tmpl ${x}` `` (JS template literals — note these nest!)
- `// )`, `/* ] */`, `# )` (line and block comments; `#` for shell/Python/Ruby)
- here-docs, raw strings (`r"..."`, `R"(...)"`), triple-quoted strings (Python)
- **nested** block comments (Rust, D) — needs a depth counter, not a flag

**This is data, not code.** Keep a small **per-language lexical table** describing string/comment/escape/raw delimiters and keyword lists. The scanner stays language-agnostic; the table is the only thing that changes per language. (Same split as routeMap/procedureMap in the OpenAPI work: the table is the swappable semantic layer, the scanner is the fixed Gutenberg infrastructure.)

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
- `git clone` with `--depth 1` unless history is needed.
- All code-related discussion and comments in **English**.

## 12. Open questions to resolve with the repo owner

- Exact tag-byte assignments for the new token classes (string/comment/keyword/identifier/number) vs. the existing scheme — align with what's already in the repo.
- Whether the printable projection is a build-time debug helper only, or a first-class output format worth stabilizing.
- Lenient-recovery policy for the repair map: just *report* imbalances, or also emit a *suggested* repaired nesting? (Default: report only; suggesting is a later, optional layer.)
- Template-literal and here-doc nesting depth limits, if any.
