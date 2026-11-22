# Changelog

Progress **and setbacks** across the project, by merged pull request. Dates are
merge dates; version lines (`## v0.8.0`) mark where a numbered version was
cut. This is a prototype log, not a SemVer release history — it records
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
Then content search (#45–#47: `tfind.js`), a review pass with the first
regression suite (#50), and the **HTML wave** (#51–#57: optional end tags,
HTML mode in unilexer, content-based ends, attribute-free outlines, and a
sample page that exercises all of it), a docs sync (#58), and the **C-like
outline** (#59–#62: `tdump --clike`, matching `~` for omitted end tags, text
without layout whitespace and with character references decoded; #63–#64:
docs and an entity-bearing HTML sample). Then a first **Markdown** step
(#65: Quarto qmd block structure — sections, fenced divs, code cells,
shortcodes — tolerantly, where Quarto 2's own parser is strict; #66–#67:
docs, complete argument-less shortcodes), cut as **v0.8.0**.

## v0.8.0 · 2026-11-22

The first numbered version: everything below, through #67. `package.json`
is the single source (`version.js` reads it), and every CLI tool's
`--version` reports it — they all said `0.1.0` until now. Releases are
marked here as `## vX.Y.Z` lines between the PR entries.

## PR #67 — qmd: argument-less shortcodes are complete · 2026-11-22

- `{{< pagebreak >}}` printed as an empty `sc.pagebreak {` … `}` block. A
  shortcode with no arguments is now ONE self-linked `/` token spanning the
  whole shortcode, like `<br/>`: `sc.pagebreak;` in `--clike`,
  `/ sc.pagebreak` in the default outline. Shortcodes with arguments keep
  their `{ … }` pair; the tape stays lossless.

## PR #65 — qmd: Quarto Markdown block structure (prototype) · 2026-11-22

- Prompted by Quarto 2's parser post ("Parsing and Source Maps", Posit, May
  2026), which makes the opposite choice — a formal grammar, and a document
  that fails it is refused. The tape takes the other half of Postel's Law:
  structure recorded tolerantly, imbalance reported, both boundaries kept,
  `reconstruct()` lossless (so nothing is lost the way `*a*`/`_a_` merge in
  a Pandoc AST).
- `unilexer.tokenizeQmd` (`-l qmd`, `.qmd`), on the XML/HTML tag bytes:
  front matter as one `!`; ATX headings open `h1`…`h6`, ended by a heading
  of the same or a higher level with a zero-width `~` (the HTML optional-end
  idea), never past an enclosing div; `::: {.callout-note}` opens
  `div.callout-note` (with `#id`), a bare `:::` closes the nearest div and
  the sections inside it; ```` ```{r} ```` opens `cell.r`, other fences
  `code.<lang>` / `code`, with ONE raw-text body (fences, `:::`, shortcodes
  inside are code; CommonMark's at-least-as-long closer); inline
  `{{< name … >}}` is `sc.name { … }`, skipped inside `` `code` `` and when
  escaped `{{{< >}}}`; a `<!--` block is a comment.
- Findings: a stray `:::` is an orphan close, an unclosed div, fence or
  shortcode an unclosed opener — on the tape, not an error.
- `tdump --outline` (both layouts; `--clike` text is not entity-decoded
  here), `tfind` breadcrumbs (`div.summary <- h3 <- h2 <- h1`) and `tfreq`
  work unchanged. `samples/sample.qmd` has one deliberate stray `:::`.
- Not handled yet: setext headings, block quotes and list items as
  containers, other raw HTML, indented code; `scan.js` (lexical-scanner)
  has no qmd table.

## PR #64 — samples/sample.html: &amp; entities · 2026-11-16

- The sample page now escapes `&` as `&amp;` in a link's text and `href`,
  a table header and the closing paragraph, so `tdump --outline 99 --clike`
  shows #62's decoding on HTML too (`"Orders & returns"`, `"Amount & VAT"`,
  `"Done & dusted"`); the `<script>`'s `&&` stays raw. The sample test
  checks both. Structure, verdict and implied list are unchanged.

## PR #62 — --clike: character references decoded · 2026-11-16

- `--clike` text now shows what it says, not how it was escaped:
  `"XML &amp; the art of &gt; brackets"` reads `"XML & the art of > brackets"`.
  Numeric references (`&#65;`, `&#x42;`) and XML's five named entities are
  decoded everywhere, plus a handful of common HTML names (`&nbsp;`,
  `&hellip;`, `&mdash;`, …) in HTML. An unknown or malformed reference stays
  as written.
- HTML `<script>`/`<style>` text is raw, so `&amp;` there is left alone;
  `<title>`/`<textarea>` do decode. CDATA is a declaration, not text, and is
  never touched. The tape and the default outline are unchanged.

## PR #61 — --clike: trailing layout whitespace trimmed · 2026-11-15

- Text that runs up to an omitted end tag keeps the line break and the next
  line's indentation (`"Amount\n    "`) — right for the tape, noise in the
  C-like view. `--clike` now drops a trailing whitespace run that contains a
  line break; a same-line trailing space (`"Intro with "`) is content and
  stays. The tape and the default outline are unchanged.

## PR #60 — --clike: braces match · 2026-11-15

- In #59's layout an element whose HTML end tag was omitted opened with `{`
  and closed with `~` (`li {` … `~`), so the `{` had no `}`. It now opens
  with `~` too (`li ~` … `~`, folded `li ~ … 10 … ~`): every `{` has its
  `}`, and every `~` opener has its `~`.
- This also applies to an element the scanner closes implicitly although its
  end tag was required (the `<b>` in `samples/sample.html`); `scan.js`
  still reports that one.

## PR #59 — tdump --outline --clike: a C-like layout for XML/HTML · 2026-11-15

- A second layout for the XML/HTML outline, next to the default one where
  the symbol comes first (`{ book` … `} book`). With `--clike` the name
  comes before the brace and the close is a bare brace (`book {` … `}`).
  An element with no content is a statement (`br;`), and text is a quoted
  string. A folded element reads `book { … 33 … }`.
- An omitted HTML end tag still shows as `~`, not `}`, so the view never
  shows a close that is not in the source. An orphan close keeps its name
  (`} z …?`) so you can tell which one it is.
- Only `--outline` uses it, and only for XML/HTML; other languages print
  as before. `--clike` without `--outline` is a usage error.

## PR #57 — tfind: one-line match headers · 2026-11-15

- An HTML text token keeps its trailing newline, so `tfind 25.50
  samples/sample.html` split the `── token N: … ──` header across two
  lines. Newlines in the header are now shown as `\n` (and `\r` as `\r`),
  as `tdump` shows them. The zoomed text below is unchanged.

## PR #56 — samples/sample.html · 2026-11-15

- An HTML sample for `HTML_TABLE` and unilexer's HTML mode. It omits every
  end tag the spec allows, puts markup-looking text in `<title>`, `<style>`
  and `<script>`, and uses void elements. It also has one deliberate seam:
  an unclosed `<b>` inside a `<p>` that a `<div>` ends.
- `validate.js` runs it under the library policy, and `test.js` checks the
  verdict (only the `<b>`), the implied closes, and that unilexer
  reconstructs it losslessly.

## PR #55 — tdump --outline hides XML/HTML attributes · 2026-11-15

- In XML/HTML, `--outline` printed every attribute as three rows under its
  tag (`I lang`, `=`, `" "en"`), which buried the element tree. The outline
  now skips a start tag's attributes up to its `>` or `/>`. They stay on the
  tape, and the dump modes (`--brief`, `--signal`, `--full`) still show them.
- An element closed by `/>` after attributes (`<b y="2"/>`) printed as
  `{ b` with no close, because the `/>` was dropped as punctuation. It is now
  one `/ b` line, the same as an attribute-free `<c/>`.
- A folded element's count (`{ book … 12 … }`) now counts only its content,
  not its attributes.
- Other languages are unchanged.

## PR #54 — HTML: `<head>` and `<colgroup>` end at content they can't hold · 2026-11-15

- `<head><title>t</title><div>` left the `<div>` inside `<head>`. Only
  `<body>` ended `<head>`, and `<colgroup>` waited for a table start tag.
  A browser ends both elements at the first content they cannot contain.
- New `HTML_TABLE.endedByContent` maps each element to the start tags it may
  hold. `<head>` may hold `<meta>`, `<link>`, `<title>`, `<style>`,
  `<script>`, `<noscript>`, `<template>`, `<base>` and a few legacy ones.
  `<colgroup>` may hold `<col>` and `<template>`.
- Any other start tag ends the element, and so does text that is not
  whitespace. The end is a zero-width `~` token where that content starts.
  unilexer keeps leading whitespace inside the element and starts the text
  token at the first visible character. Comments and whitespace do not end
  the element.
- If the source still has an explicit `</head>` after body content, it is
  reported as `orphan-close-tag`. A browser ignores that tag too.

## PR #53 — HTML: a block start tag ends `<p>` through inline elements · 2026-11-15

- `<p><b>x<div>` reported the `<p>` as unclosed: a start tag only looked
  through the run of optional-end elements on top of the stack, and the
  `<b>` stopped the search. A browser closes both.
- The search now also passes over inline (phrasing) elements — the new
  `HTML_TABLE.phrasingElements` set: `a`, `b`, `em`, `span`, `strong`, …
  A block element (`<div>`, `<ul>`) still bounds it, and so do the inline
  elements the HTML parser treats as scope barriers (`<button>`,
  `<object>`), which are left out of the set.
- Everything down to the ended element closes as zero-width `~` tokens, in
  both scanners. The `<p>`'s end is optional, so it is not reported; the
  `<b>`'s end is not, so `scan.js` still reports it once as
  `improper-nesting` ("still open when <div> ended <p>") — the same rule
  applies to `<li><a>x<li>`.

## PR #52 — HTML mode for unilexer (tdump, tfind, tfreq) · 2026-11-15

- `.html`/`.htm` went through unilexer's plain XML mode, so `tdump
  --outline` showed every `<br>`, `<li>` and `<p>` as an unmatched `…?`, and
  a `<` inside a `<script>` opened a bogus tag.
- New `tokenizeHtml()` — `tokenizeXml()` with the `HTML_TABLE` rules,
  IMPORTED from `lexical-scanner.js` so both scanners share one rule list:
  names fold to lower case, void elements are complete `/` tokens, omitted
  optional end tags become zero-width `~` tokens linked to their opener,
  and raw-text elements (`<script>`, `<style>`, `<textarea>`, `<title>`)
  hold one TEXT token. The last rule is new to `scan.js` as well.
- `tfind` breadcrumbs now include name-matched openers: in XML/HTML the
  chain is the enclosing elements (`li <- ul#menu <- body`), and the zoom is
  the innermost element, through its close tag (or up to where it was
  implicitly ended).
- The language dispatch that tdump, tfind and tfreq each carried a copy of
  is now `langOfPath()` / `tokenizeAs()` in `unilexer.js`; `--lang html`
  everywhere.

## PR #51 — HTML: optional end tags are implied, not seams · 2026-11-15

- Follow-up to the HTML table: `<p>one<p>two`, `<li>a<li>b</ul>`,
  `<tr><td>1<td>2</table>` and a document that never writes `</body>` or
  `</html>` were reported as unclosed tags / improper nesting, though the
  spec allows every one of those omissions.
- `HTML_TABLE.optionalEnd` lists, per element, the start tags that end it
  (the WHATWG "optional tags" rules: p, li, dt/dd, rt/rp, option/optgroup,
  colgroup, caption, thead/tbody/tfoot, tr, td/th, html/head/body). Such an
  element is also ended by its parent's close tag and by end of input.
- An implied end is a ZERO-WIDTH token with its own projection char `~` (at
  the offset of whatever ended it), linked like a real close — the tape
  never claims a `</p>` that is not in the source.
- Linter-grade, deliberately: a start tag only ends elements in the run of
  optional-end elements on top of the stack, so a nested list's `<li>`
  can't close the outer one, but `<p><b>x<div>` still reports the `<p>`
  (a browser would close it — fixed in #53). Content-based
  rules (a `<colgroup>` ended by any non-`<col>` content) are left out
  (added in #54). Plain XML is unchanged.

## PR #50 — review fixes: lexer edge cases, tool hangs, a test suite · 2026-11-15

- Setback, found in a code review: `unilexer.js` had no assertions at all —
  `validate.js` only exercised `lexical-scanner.js`, and the demos print but
  never check. Every bug below passed the existing suite. New `test.js` (20
  regression assertions, wired into `npm test` via a new `package.json`)
  fails on each of them against the old code.
- `tfind` looped forever on a malformed object (`{"k": }`, `[{ "k" }]`): a
  closer in value position linked backward and the key walk restarted.
- unilexer: `/*/` closed the block comment it opened (JS/Rust/JSON5 and SQL);
  JS `#private` names and the `#!` hashbang were tagged with the COMMENT byte;
  a UTF-8 BOM glued onto the first identifier; `1e`-without-digits was read
  as an exponent and the BigInt `n` suffix was accepted in every language.
- Python: a bracket closing mid-line left stale line-start state (`) + 1`
  opened a phantom indent level), and `\` line continuation was ignored;
  `//=` is now one operator.
- YAML: an apostrophe inside a plain scalar (`don't`) opened a quoted string
  that swallowed the following lines; `#` opened a comment mid-word; hex
  numbers were tagged as floats.
- `mergeGate` compared warning-class seams only, so a merge that left a
  string or block comment unterminated was judged safe. Errors count now.
- `sfdiff` / `defuse` took nested `function` declarations (inside an arrow
  body or IIFE) for top-level units. Depth 0 only now. `sfdiff.js` also lost
  its literal NUL/SOH bytes (now `\u0000` escapes) — git had treated the
  file as binary.
- `scan.js`: `.html`/`.htm` get an HTML table (case-insensitive names, void
  elements like `<br>`/`<img>` complete on their own); XML improper nesting is
  reported once per open tag instead of once per later close; a bare `<` in
  text no longer swallows the next tag; `*`/`?` in the last path segment are
  expanded by the tool itself, so the README's `kernel\*.c` works from cmd.

## PR #49 — XML: DOCTYPE internal subset stays one declaration (fixes #48) · 2026-11-14

- Setback, found by comparing against another XML viewer: a
  `<!DOCTYPE root [ … ]>` ended at the first `>` inside its internal subset
  (the one closing `<!ENTITY …>`), so the rest of the subset leaked onto the
  tape as a `text` token. `scan.js` still said clean — `lexical-scanner.js`
  had the same bug and silently skipped the leftover as text — and the
  lossless check couldn't catch it, because the text token carried the
  missing bytes. A wrong split that round-trips is still a wrong split.
- Both scanners now share one rule (`xmlDeclEnd`, duplicated so
  `lexical-scanner.js` stays import-free): a DOCTYPE's `[ … ]` is opaque,
  with quotes, comments and PIs inside it skipped so their `>` / `]` don't
  end it. Case-insensitive `<!doctype`.
- An unterminated internal subset is now reported by `scan.js` as an
  `unterminated-tag` error instead of passing as clean; `unilexer.js` stays
  tolerant and runs the declaration to EOF.
- Regression sample: `samples/doctype-subset.xml` (comment, PI, quoted `>`
  and `]>` inside the subset). Existing `samples/sample.xml` output unchanged.

## PR #47 — tfind.js: truncate long match lexemes; a Transsmart cross-cutting example · 2026-07-06

- Setback, found by using it: the `── token N: … ──` header printed the whole
  matched lexeme. A match inside a Postman request body, which is stored as
  one string of several KB, produced a header line thousands of characters
  long. The header now truncates at 80 characters; the zoomed text below
  still prints in full.
- `openapi-exploration/transsmart/README.md` gains an example where one
  search cuts across many requests.

## PR #46 — agv README: tfind.js findings across all 5 specs · 2026-07-06

- `openapi-exploration/agv/README.md` gains a "Zooming in with tfind.js"
  section covering all five AGV specs, including a case where the nearest
  label is a bare `$ref` wrapper and `-u 3` widens to the full response
  block.

## PR #45 — tfind.js: zoom into a tape by content, not depth · 2026-07-05

- New tool, `tfind.js`, answering the question `--outline` can't: "where
  does THIS text live in a file too big to peel depth-layer by depth-layer,
  and what's the natural unit around it." For every token matching a
  substring: a breadcrumb of enclosing containers (innermost first, each
  labelled by its own JSON key — the OpenAPI/schema convention — or by a
  `name`/`title` sibling — the Postman-collection convention, neither
  guessed at semantically, both read straight off the key/value and
  sibling structure already on the tape), then the nearest labelled
  ancestor's exact source text (lossless, the same offset-span slice
  §13b already uses elsewhere).
- `--up N` widens the zoom past the nearest label when it's too narrow (in
  deeply nested JSON almost every level is technically "keyed," so the
  nearest one alone isn't always the meaningful unit) — the same "raise to
  peel" ergonomics `--outline` already has, applied to content-search
  instead of depth.
- Verified on both labelling conventions: a Postman request found via its
  `name` sibling three levels up from a URL match (surfacing 2 more
  matches — the same URL echoed in two recorded example responses'
  `originalRequest`, which the breadcrumb alone makes obvious); an AGV
  OpenAPI example value found via its enclosing schema's own JSON key.

## PR #40 — CSV-loaded keyword vocabulary + shared imported-keyword byte (SQL, Rust, Python) · 2026-07-05

- Investigated (at the user's request) a CSV-driven keyword table before
  building anything: cross-checking SQL's 86 Oracle keywords against every
  other table found only 21 exact-spelling reuse candidates; the remaining
  ~65 would all be equally-illegible block bytes no matter which specific
  values they got — hand-picking had stopped buying anything at this point.
- New shape instead of more block bytes: **a keyword IS an identifier,
  lexically** — every non-reused SQL keyword shares ONE byte (`T_EXTKW`),
  classed IDENT, interned into the SAME pool as any other identifier.
  `tfreq`'s identifier listing picks them up for free (zero tooling change);
  the mnemonic column shows a stable `id{n}` — n is the word's position
  among the CSV's non-reused entries, never a per-file pool index, so it
  can't depend on what else is in whatever file is scanned. Appending a
  keyword is now genuinely unlimited: the byte was already spent once, up
  front, forever — "out of bytes" can't happen again.
- Follow-up (owner's call, "overlapping assignments across different
  languages" are fine as long as the C/JS base stays in core): Rust's and
  Python's OWN former block-byte tiers (Rust's as/crate/dyn/enum/extern/
  impl/loop/match/mod/move/ref/Self/trait/type/use/where; Python's and/or/
  not/is/from/with/lambda/nonlocal/assert/elif/except/pass/as) moved onto
  the SAME `T_EXTKW` + CSV mechanism, retiring `KW_LITERAL` (the per-word
  block-byte decode table) entirely — nothing hardcoded needs a block byte
  anymore. Rust's `id7` and Python's `id7` are unrelated and never
  compared, so the overlap is harmless; `_result()`/`_tape().finish()` now
  take an explicit `extkwIndex` parameter (each language passes its OWN
  index map) instead of `mnemonicOf` hardcoding a single table.
- What stays hardcoded, explicit, and in-core (never CSV, never
  auto-discovered from another table at runtime): the C/JS-grounded base
  (`KEYWORDS` in token-tags.js) and the hand-curated reuse/role-grounded
  tiers that read from it (`RUST_KEYWORDS`, `PY_KEYWORDS`,
  `SQL_KEYWORD_REUSE`) — auto-discovery would mean editing one language's
  table could silently change another's byte assignments, the opposite of
  the stability this whole mechanism is for.
- The vocabulary itself moved out of hardcoded `Set`/`Map` entries into
  `sql-keywords-oracle.csv`, `rust-keywords.csv`, and `python-keywords.csv`,
  loaded via `loadKeywordCsv()` at module load, resolved relative to
  `unilexer.js` via `import.meta.url` — the same "derive a table from an
  external source" move `harvest.js` already makes
  for TextMate grammars. One rule: append, don't insert — inserting a word
  mid-file shifts every id after it; appending only ever adds a new one.

## PR #41 — Add openapi-exploration folder: AGV specs + Transsmart collection · 2026-07-05

- New `openapi-exploration/` folder: the 5 hand-written AGV OpenAPI specs
  (conventional per-resource REST, a contrast against HostNet's single
  generic-endpoint + 30-way `oneOf`), and a real Transsmart APIv2 Postman
  collection export (~3.4MB, 46k tokens) — kept as raw Postman JSON rather
  than converted to OpenAPI, since it's already lossless through
  `tokenizeJson5` and `--outline` works on it directly.

## PR #42 — README: real --outline example against the Transsmart collection · 2026-07-05

- Added a concrete `--outline 2` example against the Transsmart collection
  to the Quick start section, verified to match a fresh run exactly.

## PR #43 — openapi-exploration: per-folder README with --outline output · 2026-07-05

- `agv/README.md`: `--outline 3` for each of the 5 specs. `transsmart/
  README.md`: `--outline 2` for the collection top level plus the peeled
  folder/request tree (9→10, corrected — see #44).

## PR #44 — transsmart README: add --outline depth 3 and 4 output · 2026-07-05

- Depth 3: collection metadata plus each of the 10 top-level sections
  folded to span size ("2.0 Shipment management" the largest at 13113
  tokens, "0. Introduction" the smallest at 116). Depth 4: opens each
  section to name/item/description/auth/event — each section's
  description links back to its matching devdocs.transsmart.com anchor,
  and every section but Introduction/Reports carries its own auth
  override.

## PR #39 — per-keyword mnemonic bytes for Python (PY_KEYWORDS) · 2026-07-05

- Closed the last generic-byte bucket: Python's `elif`/`except`/`pass`/
  `with`/`as`/`from`/`is`/`not`/`and`/`or`/`lambda`/`global`/`nonlocal`/
  `assert` no longer share one undifferentiated 'k' byte — each gets its own
  role byte, same discipline as Rust's table.
- `RUST_KW_LITERAL` renamed to `KW_LITERAL` and made shared across every
  language's keyword table, not private to Rust — so a role assigned a block
  byte in one language is visible when Python's table is built next to it,
  and the same role can never quietly land on two different bytes.
- `as` deliberately REUSES Rust's role byte (0xA7) rather than taking a new
  one — same spelling, same "reinterpret as" family (import-as/with-as/
  except-as vs Rust's type-cast as); `global` took the one remaining
  free-letter fit ('g') after Rust's mut/pub/struct; everything else
  Python-only took a fresh block byte past Rust's highest (0xB7-0xC2).
- `samples/sample.py` extended with a section exercising every newly-mapped
  keyword; still lossless.

## PR #38 — per-keyword mnemonic bytes for Rust (RUST_KEYWORDS) · 2026-07-05

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
