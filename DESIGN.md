# JS/TS Tape Tokenizer — Design Documentation

## Overview

A two-pass tokenizer for JavaScript/TypeScript that produces a **flat tape** of
64-bit entries — inspired by the simdjson tape structure. The tape is a single
contiguous array, cache-friendly, with no heap-allocated tree nodes.

### Why a tape?

Traditional tokenizers produce a linked list or tree of token objects. Each
`new Token(...)` allocation:
- Touches the GC heap
- Fragments cache lines
- Requires pointer-chasing to iterate

A tape packs everything into two parallel `Uint32Array`s. Sequential scan of
the token stream = sequential memory reads = hardware prefetcher paradise.

---

## Two-pass architecture

**Pass 1 — scan:**
- Walk the source buffer character by character
- Identify structural characters: brackets, quotes, operators
- Classify identifiers as keywords (single tag byte) or identifiers (intern pool lookup)
- Write one 64-bit entry per token to the tape
- Patch bracket pairs with jump targets as they close

**Pass 2 — consumer:**
- Walks the flat tape array
- Can skip entire subtrees in O(1) using the jump pointers on `{`, `(`, `[`
- Identifier comparison is O(1) integer compare (intern IDs, not string compare)

---

## 64-bit tape entry layout

```
bits 63–56  │ bits 55–48  │ bits 47–32   │ bits 31–0
────────────┼─────────────┼──────────────┼──────────────────────
  tag (u8)  │  flags (u8) │ reserved(u16)│  payload (u32)
```

### Tag byte

The tag byte is chosen to be **self-describing in a hex dump**:

| Range       | Meaning                         | Example                        |
|-------------|----------------------------------|-------------------------------|
| `0x00`      | EOF sentinel                     | —                             |
| `0x28–0x7E` | Punctuation (exact ASCII) or     | `0x28` = `(`                  |
|             | tier-1 keyword/literal           | `0x69` = `i` = KW_IF          |
| `0x80–0x8D` | Tier-2 keywords (rare)           | `0x80` = KW_BREAK             |

### Flags byte

Currently unused — reserved for future annotations:
- `0x01` optional-chain flag (`?.`)
- `0x02` spread flag (`...`)
- `0x04` TypeScript type-context flag

### Payload (u32)

| Tag                          | Payload meaning                    |
|------------------------------|------------------------------------|
| Keyword tag                  | Source byte offset                 |
| `IDENT` (0x49)               | Intern pool ID                     |
| `NUMBER` (0x4E), `DOUBLE` (0x44) | Source byte offset             |
| `STRING` (0x53)              | Index into string side-buffer      |
| `TEMPLATE` (0x58)            | Source byte offset                 |
| `REGEX` (0x52)               | Source byte offset                 |
| `LBRACE/LPAREN/LBRACKET`     | Tape index of matching closer      |
| `RBRACE/RPAREN/RBRACKET`     | Tape index of matching opener      |

---

## Tag byte assignment rationale

### Punctuation — exact ASCII

Bracket pairs and common punctuation use their literal ASCII values.
A hex dump is directly human-readable:

```
0x28 (   0x29 )   0x2C ,   0x2E .
0x3A :   0x3B ;   0x3D =   0x3F ?
0x5B [   0x5D ]   0x7B {   0x7D }
```

### Literals — UPPERCASE initial

Uppercase frees the corresponding lowercase letter for a keyword:

```
0x49 I  IDENT     0x4E N  NUMBER    0x44 D  DOUBLE
0x52 R  REGEX     0x53 S  STRING    0x58 X  TEMPLATE (eXpression)
```

### Keywords — frequency-based assignment

The **most-used keyword per starting letter** gets the best available
printable mnemonic char. Rarer keywords get `0x80+` sequential slots.

Frequency tiers (from corpus analysis of npm/GitHub JS codebases):
- ★★★ Very high: `const` `return` `function` `if` `this` `let` `new`
               `import` `export` `class` `for` `await` `async`
- ★★  Medium:    `else` `true` `false` `null` `var` `of` `in` `throw`
               `try` `catch` `while` `typeof` `extends` `super`
- ★   Low:       `switch` `case` `default` `break` `continue` `do`
               `delete` `finally` `instanceof` `static` `void`
               `yield` `debugger`

**Tier-1 assignments** (printable chars, collision resolution notes):

| Hex  | Char | Token       | Note |
|------|------|-------------|------|
| 0x41 | `A`  | KW_ASYNC    | |
| 0x43 | `C`  | KW_CLASS    | structural keyword |
| 0x45 | `E`  | KW_EXPORT   | |
| 0x46 | `F`  | KW_FOR      | both for & function get a slot |
| 0x30 | `0`  | KW_NULL     | null is falsy/zero — perfect mnemonic |
| 0x54 | `T`  | KW_TRUE     | both this & true get a slot |
| 0x5E | `^`  | KW_CATCH    | caret "catches" upward — throw/catch arc |
| 0x61 | `a`  | KW_AWAIT    | lowercase mirrors async/await pairing |
| 0x63 | `c`  | KW_CONST    | most-used C keyword |
| 0x64 | `d`  | KW_DELETE   | D=DOUBLE literal, so lowercase |
| 0x65 | `e`  | KW_ELSE     | |
| 0x66 | `f`  | KW_FUNCTION | edges out for in raw count |
| 0x68 | `h`  | KW_THROW    | tHrow — h free (no H keywords) |
| 0x69 | `i`  | KW_IF       | most frequent keyword overall |
| 0x6C | `l`  | KW_LET      | |
| 0x6E | `n`  | KW_NEW      | N=NUMBER literal |
| 0x6F | `o`  | KW_OF       | |
| 0x4D | `M`  | KW_IMPORT   | iMport — i=if, I=IDENT |
| 0x72 | `r`  | KW_RETURN   | R=REGEX literal |
| 0x73 | `s`  | KW_SUPER    | S=STRING literal |
| 0x74 | `t`  | KW_THIS     | most-used T keyword |
| 0x76 | `v`  | KW_VAR      | |
| 0x77 | `w`  | KW_WHILE    | |
| 0x78 | `x`  | KW_EXTENDS  | eXtends — X=TEMPLATE |
| 0x79 | `y`  | KW_TYPEOF   | tYpeof — yield demoted to tier-2 |
| 0x7E | `~`  | KW_FALSE    | bitwise NOT of true = false |

**Tier-2 assignments** (0x80+ sequential, rare keywords):

```
0x80 KW_BREAK       0x81 KW_CASE        0x82 KW_CONTINUE
0x83 KW_DEBUGGER    0x84 KW_DEFAULT     0x85 KW_DO
0x86 KW_FINALLY     0x87 KW_IN          0x88 KW_INSTANCEOF
0x89 KW_STATIC      0x8A KW_SWITCH      0x8B KW_TRY
0x8C KW_VOID        0x8D KW_YIELD
```

---

## Intern pool

Identifiers are **interned**: the first occurrence of `"foo"` assigns it a
stable integer ID. All subsequent occurrences store the same ID as their
payload. This means:

- **Identifier comparison is O(1)**: compare two `u32` payloads
- **No string allocation per token**: just an integer
- **Symbol-table lookups** in a later analysis pass are O(1) hash lookups
  on small integers rather than string hashes

The intern pool uses a hand-rolled separate-chaining hash table on top of
a `Map<hash, [{name, id}]>`. The hash function is djb2, which has excellent
distribution for short identifier strings.

For very large files, the string slice on intern lookup can be replaced with
a source-offset + length pair to hash directly over the source buffer without
allocation.

---

## Bracket jump pointers

Every opening bracket (`{` `(` `[`) stores the tape index of its matching
closer as its payload. Every closer stores the tape index of its opener.

This enables:
- **Skip a function body**: read `{` payload → jump directly to `}` — O(1)
- **Skip an argument list**: read `(` payload → jump to `)` — O(1)
- **Nested subtree traversal**: recursive descent with no recursion overhead

The jump targets are filled in a two-phase approach within a single pass:
openers push their tape index onto a stack; closers pop the stack and
`_patch()` both sides.

---

## Number / Double distinction

The `NUMBER` tag (0x4E, `N`) is used for integer literals (including hex,
binary, octal, BigInt). The `DOUBLE` tag (0x44, `D`) is used when the
literal contains a decimal point or exponent (`1.5`, `3e10`, `.5`).

This lets a downstream pass route integer and float literals to different
handling paths without re-scanning the source.

---

## Files

| File            | Purpose                                      |
|-----------------|----------------------------------------------|
| `token-tags.js` | Tag byte constants, TAG_NAME reverse map, KEYWORDS map |
| `tokenizer.js`  | Tokenizer class — `tokenize(src)` → result   |
| `demo.js`       | Example usage, tape dump, subtree skip demo  |
| `DESIGN.md`     | This document                                |

---

## Extending for TypeScript

TypeScript-specific tokens can use the flags byte and/or extend the tier-2
range upward from `0x8E`:

```
0x8E  KW_TYPE        (type keyword)
0x8F  KW_INTERFACE
0x90  KW_ENUM
0x91  KW_NAMESPACE
0x92  KW_DECLARE
0x93  KW_ABSTRACT
0x94  KW_READONLY
0x95  KW_AS
0x96  KW_SATISFIES
0x97  KW_KEYOF
0x98  KW_INFER
```

The flags byte `0x04` can mark tokens that appear in a type-context position,
allowing a single-pass tokenizer to carry enough information for a type-aware
parser without a separate lexer mode.
