// demo.js  —  run with: node demo.js
import { Tokenizer } from './tokenizer.js';
import { T, TAG_NAME } from './token-tags.js';

const src = `
async function fetchUser(id) {
  const url = "https://api.example.com/users/" + id;
  const factor = 1.5;
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

class UserCache extends Map {
  constructor() {
    super();
    this.ttl = 60_000;
  }
}
`;

const tok = new Tokenizer();
const result = tok.tokenize(src);
const { tape, tag, payload, identName } = result;

console.log(`tape entries : ${tape.length}`);
console.log(`unique idents: ${result.intern.names.length} → [${result.intern.names.join(', ')}]`);
console.log(`string bufs  : ${result.strings.length}`);
console.log();
console.log('── tape dump ────────────────────────────────────────');

for (let i = 0; i < tape.length; i++) {
  const t   = tag(i);
  const p   = payload(i);
  const hex = `0x${t.toString(16).padStart(2, '0')}`;
  const name = (TAG_NAME[t] ?? `?${hex}`).padEnd(16);
  let detail = '';

  if      (t === T.IDENT)    detail = `id=${p}  "${identName(i)}"`;
  else if (t === T.STRING)   detail = `buf[${p}] = "${result.strings[p]}"`;
  else if (t === T.LBRACE || t === T.LPAREN || t === T.LBRACKET)
                             detail = `jump → [${p}]`;
  else if (t === T.RBRACE || t === T.RPAREN || t === T.RBRACKET)
                             detail = `match → [${p}]`;
  else if (t === T.NUMBER || t === T.DOUBLE)
                             detail = `src @${p} = "${src.slice(p, p+12).split(/\s/)[0]}"`;

  console.log(`[${String(i).padStart(3)}] ${hex}  ${name} ${detail}`);
}

// ── demo: O(1) subtree skip ───────────────────────────────────────────────────
console.log('\n── O(1) subtree skip demo ───────────────────────────');
for (let i = 0; i < tape.length; i++) {
  if (tag(i) === T.LBRACE) {
    const close = payload(i);
    console.log(`{ at [${i}] → skip to } at [${close}]  (${close - i - 1} entries inside)`);
  }
}

// ── demo: find all call sites by intern id comparison ─────────────────────────
console.log('\n── call site scan (O(n) single pass) ────────────────');
const fetchId = tok.intern('fetch');
for (let i = 0; i < tape.length - 1; i++) {
  if (tag(i) === T.IDENT && payload(i) === fetchId && tag(i + 1) === T.LPAREN) {
    console.log(`  "fetch" called at tape[${i}]`);
  }
}
