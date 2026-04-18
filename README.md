# tape-tokenizer

A two-pass JavaScript/TypeScript tokenizer that produces a **flat tape** of
64-bit entries — inspired by the [simdjson](https://github.com/simdjson/simdjson)
tape structure. No heap-allocated token tree nodes, cache-friendly sequential
memory layout.

## Why a tape?

Traditional tokenizers allocate a linked list or tree of token objects.
Each `new Token(...)` touches the GC heap, fragments cache lines, and requires
pointer-chasing to iterate. A tape packs everything into two parallel
`Uint32Array`s — sequential iteration = sequential memory reads = hardware
prefetcher paradise.

## Features

- **Flat tape output** — two parallel `Uint32Array`s (`tags` + `payloads`), no object allocation per token
- **O(1) subtree skipping** — bracket jump pointers let you skip a whole function body or argument list in one read
- **Intern pool** — identifiers are interned; comparison is an integer `===`, not a string compare
- **Mnemonic tag bytes** — self-describing in a hex dump; punctuation uses exact ASCII values
- **Number / Double distinction** — integer vs. floating-point literals get separate tags
- **Single-pass bracket patching** — opener/closer pairs are linked during the scan, not in a post-pass

## Files

| File | Purpose |
|------|---------|
| `token-tags.js` | Tag byte constants, `TAG_NAME` reverse map, `KEYWORDS` map |
| `tokenizer.js`  | `Tokenizer` class — `tokenize(src)` → `{ tags, payloads, internPool }` |
| `demo.js`       | Example usage, tape dump, subtree-skip demo |
| `DESIGN.md`     | Full design documentation |

## Quick start

```js
import { tokenize } from './tokenizer.js';

const src = `const x = 1 + 2;`;
const { tags, payloads, internPool } = tokenize(src);

for (let i = 0; i < tags.length; i++) {
  console.log(i, tags[i].toString(16).padStart(2, '0'), payloads[i]);
}
```

Run the included demo:

```cmd
node demo.js
```

## Tape entry layout

Each token occupies one 64-bit entry split across two parallel `Uint32Array`s:

```
bits 63–56   bits 55–48   bits 47–32    bits 31–0
──────────   ──────────   ──────────    ──────────
 tag (u8)    flags (u8)   reserved      payload (u32)
```

### Tag byte highlights

Punctuation uses exact ASCII — a hex dump is directly human-readable:

```
0x28 (   0x29 )   0x5B [   0x5D ]   0x7B {   0x7D }
```

Literals use uppercase initials:

```
0x49 I  IDENT     0x4E N  NUMBER    0x44 D  DOUBLE
0x52 R  REGEX     0x53 S  STRING    0x58 X  TEMPLATE
```

The most-used keywords get the best printable mnemonic characters (e.g.
`0x69 i` = `KW_IF`, `0x63 c` = `KW_CONST`, `0x72 r` = `KW_RETURN`).
Rare keywords occupy the `0x80+` range. See [`DESIGN.md`](DESIGN.md) for
the full tag assignment rationale.

### Payload semantics

| Tag | Payload |
|-----|---------|
| Keyword | Source byte offset |
| `IDENT` | Intern pool ID |
| `NUMBER` / `DOUBLE` | Source byte offset |
| `STRING` | Index into string side-buffer |
| `LBRACE` / `LPAREN` / `LBRACKET` | Tape index of matching closer |
| `RBRACE` / `RPAREN` / `RBRACKET` | Tape index of matching opener |

### O(1) subtree skip example

```js
// skip the body of a function without touching every token inside
const openIdx = i;               // tape index of '{'
const closeIdx = payloads[i];    // jump directly to matching '}'
i = closeIdx + 1;
```

## Two-pass architecture

**Pass 1 — scan**
Walks the source buffer character by character, classifies tokens, writes
tape entries, and patches bracket jump pointers on the fly using a stack.

**Pass 2 — consumer**
Walks the flat arrays. Subtree skipping, identifier lookup, and keyword
dispatch are all O(1) integer operations.

## Extending to TypeScript

TypeScript-specific keywords can be added starting at `0x8E` (see
[`DESIGN.md`](DESIGN.md#extending-for-typescript)). The reserved flags byte
is earmarked for optional-chain (`?.`), spread (`...`), and type-context
annotations.

## License

MIT — see [LICENSE](LICENSE).
