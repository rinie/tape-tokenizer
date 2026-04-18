// token-tags.js
//
// Tag byte encoding rules:
//   Punctuation  — exact ASCII value of the character itself
//   Literals     — UPPERCASE initial  (I N D R S X)
//   Keywords     — most-used per letter group gets the best available
//                  printable mnemonic char (lower or upper);
//                  secondary keywords get 0x80+ sequential slots
//   EOF          — 0x00 (NUL, never valid in source)
//
// Frequency tiers:  ★★★ very high  ★★ medium  ★ low
//
// Quick decode cheat sheet for hex dumps:
//   0x00        = EOF
//   0x28–0x7D   = punctuation (exact ascii) or tier-1 keyword/literal
//   0x80–0x8D   = tier-2 keyword (rare)
//   0x30        = null  (mnemonic: '0')
//   0x49 'I'    = IDENT
//   0x4E 'N'    = NUMBER (integer)
//   0x44 'D'    = DOUBLE (float)
//   0x52 'R'    = REGEX
//   0x53 'S'    = STRING
//   0x58 'X'    = TEMPLATE (eXpression string)
//   0x5E '^'    = catch  (caret catches upward — throw/catch arc)
//   0x7E '~'    = false  (bitwise NOT of true)

export const T = {

  // ── special ───────────────────────────────────────────────────────────────
  EOF:           0x00,

  // ── punctuation — exact ASCII ─────────────────────────────────────────────
  LPAREN:        0x28,  // (
  RPAREN:        0x29,  // )
  COMMA:         0x2C,  // ,
  DOT:           0x2E,  // .
  COLON:         0x3A,  // :
  SEMICOLON:     0x3B,  // ;
  OP:            0x3D,  // =  generic operator
  QUESTION:      0x3F,  // ?
  LBRACKET:      0x5B,  // [
  RBRACKET:      0x5D,  // ]
  LBRACE:        0x7B,  // {
  RBRACE:        0x7D,  // }

  // ── literals & identifier — UPPERCASE initial ─────────────────────────────
  IDENT:         0x49,  // I  — Identifier  (payload = intern pool id)
  NUMBER:        0x4E,  // N  — integer Number (payload = source offset)
  DOUBLE:        0x44,  // D  — Double / float (payload = source offset)
  REGEX:         0x52,  // R  — Regex  (payload = source offset)
  STRING:        0x53,  // S  — String (payload = string buffer index)
  TEMPLATE:      0x58,  // X  — eXpression string / template literal

  // ── keywords tier 1 — best available printable char ──────────────────────
  //
  //  Collision resolution notes:
  //  'i' = if        wins over import  (most frequent keyword in any codebase)
  //  'I' = IDENT already used as literal tag
  //  'n' = new       wins over null    ('N' = NUMBER literal)
  //  'r' = return    only R keyword    ('R' = REGEX literal)
  //  's' = super     ('S' = STRING literal; super > switch in class-heavy code)
  //  't' = this      wins decisively   (most-used T keyword)
  //  'T' = true      second T keyword, both common enough for single chars
  //  'M' = import    iMport — 'i'=if, 'I'=IDENT, so M (middle letter) used
  //  '^' = catch     throw/catch arc; caret visually catches upward
  //  '0' = null      null is falsy/zero; '0' is the perfect mnemonic
  //  '~' = false     bitwise NOT of true is false; ~ is the NOT operator
  //  'y' = typeof    tYpeof — 'y' free since yield demoted to tier-2
  //  'h' = throw     tHrow — 'h' free (no H keywords)
  //  'x' = extends   eXtends — 'X'=TEMPLATE but lowercase x is free

  KW_IF:         0x69,  // i  ★★★  most frequent keyword overall
  KW_CONST:      0x63,  // c  ★★★  most-used C keyword
  KW_CLASS:      0x43,  // C  ★★★  structural keyword
  KW_ASYNC:      0x41,  // A  ★★★
  KW_AWAIT:      0x61,  // a  ★★★  lowercase mirrors async/await pairing
  KW_LET:        0x6C,  // l  ★★★
  KW_FUNCTION:   0x66,  // f  ★★★  edges out for in raw token count
  KW_FOR:        0x46,  // F  ★★★  both function & for common enough for two slots
  KW_RETURN:     0x72,  // r  ★★★  ('R' = REGEX literal)
  KW_THIS:       0x74,  // t  ★★★
  KW_TRUE:       0x54,  // T  ★★   both this & true common; T is free
  KW_NEW:        0x6E,  // n  ★★★  ('N' = NUMBER literal)
  KW_IMPORT:     0x4D,  // M  ★★★  iMport — only M-initial in keyword set
  KW_EXPORT:     0x45,  // E  ★★★
  KW_ELSE:       0x65,  // e  ★★★  both export & else very common, each gets a char
  KW_SUPER:      0x73,  // s  ★★   ('S' = STRING literal)
  KW_EXTENDS:    0x78,  // x  ★★   eXtends
  KW_TYPEOF:     0x79,  // y  ★★   tYpeof
  KW_THROW:      0x68,  // h  ★★   tHrow
  KW_VAR:        0x76,  // v  ★★
  KW_OF:         0x6F,  // o  ★★
  KW_WHILE:      0x77,  // w  ★★
  KW_DELETE:     0x64,  // d  ★    ('D' = DOUBLE literal)
  KW_CATCH:      0x5E,  // ^  ★★   throw/catch arc mnemonic
  KW_NULL:       0x30,  // 0  ★★   null is falsy/zero
  KW_FALSE:      0x7E,  // ~  ★★   bitwise NOT of true

  // ── keywords tier 2 — 0x80+ sequential ───────────────────────────────────
  KW_BREAK:      0x80,
  KW_CASE:       0x81,
  KW_CONTINUE:   0x82,
  KW_DEBUGGER:   0x83,
  KW_DEFAULT:    0x84,
  KW_DO:         0x85,
  KW_FINALLY:    0x86,
  KW_IN:         0x87,
  KW_INSTANCEOF: 0x88,
  KW_STATIC:     0x89,
  KW_SWITCH:     0x8A,
  KW_TRY:        0x8B,
  KW_VOID:       0x8C,
  KW_YIELD:      0x8D,
};

// Reverse map — tag byte → constant name (for debug dumps)
export const TAG_NAME = Object.fromEntries(
  Object.entries(T).map(([k, v]) => [v, k])
);

// Keyword string → tag byte (used by tokenizer pass 1)
export const KEYWORDS = new Map([
  ['async',      T.KW_ASYNC],
  ['await',      T.KW_AWAIT],
  ['break',      T.KW_BREAK],
  ['case',       T.KW_CASE],
  ['catch',      T.KW_CATCH],
  ['class',      T.KW_CLASS],
  ['const',      T.KW_CONST],
  ['continue',   T.KW_CONTINUE],
  ['debugger',   T.KW_DEBUGGER],
  ['default',    T.KW_DEFAULT],
  ['delete',     T.KW_DELETE],
  ['do',         T.KW_DO],
  ['else',       T.KW_ELSE],
  ['export',     T.KW_EXPORT],
  ['extends',    T.KW_EXTENDS],
  ['false',      T.KW_FALSE],
  ['finally',    T.KW_FINALLY],
  ['for',        T.KW_FOR],
  ['function',   T.KW_FUNCTION],
  ['if',         T.KW_IF],
  ['import',     T.KW_IMPORT],
  ['in',         T.KW_IN],
  ['instanceof', T.KW_INSTANCEOF],
  ['let',        T.KW_LET],
  ['new',        T.KW_NEW],
  ['null',       T.KW_NULL],
  ['of',         T.KW_OF],
  ['return',     T.KW_RETURN],
  ['static',     T.KW_STATIC],
  ['super',      T.KW_SUPER],
  ['switch',     T.KW_SWITCH],
  ['this',       T.KW_THIS],
  ['throw',      T.KW_THROW],
  ['true',       T.KW_TRUE],
  ['try',        T.KW_TRY],
  ['typeof',     T.KW_TYPEOF],
  ['var',        T.KW_VAR],
  ['void',       T.KW_VOID],
  ['while',      T.KW_WHILE],
  ['yield',      T.KW_YIELD],
]);
