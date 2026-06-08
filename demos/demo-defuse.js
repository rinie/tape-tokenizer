// demo-defuse.js — run with: node demo-defuse.js
// Breadth-first def/use projection (§13a spike): see the def-before-use shape of
// depth-first-organised code without drawing the DAG.
import { analyze, defUseOutline, useBeforeDef, topoOrder } from '../defuse.js';

const src = `
function helper(x) {
  return x * 2;
}

function main() {
  const a = helper(10);     // helper: defined earlier — clean
  const b = late(a);        // late:   defined LATER — use-before-def
  return isEven(b);         // isEven: defined LATER — use-before-def
}

function late(y) {
  return y + 1;
}

function isEven(n) {
  if (n === 0) return true;
  return isOdd(n - 1);      // mutual recursion with isOdd — a cycle
}

function isOdd(n) {
  if (n === 0) return false;
  return isEven(n - 1);
}
`;

const { du } = analyze(src);

console.log('═══ breadth-first outline (top-level defs, file order) ══════════');
console.log('Adjacency at ONE level — each def and the top-level names it directly uses.');
console.log('No transitive closure, no DAG walk:\n');
for (const row of defUseOutline(du)) {
  const uses = row.uses.length ? row.uses.join(', ') : '—';
  console.log(`  [tape ${String(row.index).padStart(3)}]  ${row.kind.padEnd(8)} ${row.name.padEnd(8)} → uses: ${uses}`);
}

console.log('\n═══ use-before-def findings (positional, both boundaries) ═══════');
console.log('lib policy (a library — warnings):');
for (const f of useBeforeDef(du, 'lib')) {
  console.log(`  ⚠ [${f.severity}] ${f.user} → ${f.used}  (use tape[${f.useIndex}] → def tape[${f.defIndex}])`);
}
console.log('own policy (your code — the def-before-use discipline you opted into → errors):');
for (const f of useBeforeDef(du, 'own')) {
  console.log(`  ✗ [${f.severity}] ${f.user} → ${f.used}  (use tape[${f.useIndex}] → def tape[${f.defIndex}])`);
}

console.log('\n═══ suggested def-before-use reordering ═════════════════════════');
const { order, cycles } = topoOrder(du);
console.log('  order (dependencies first):', order.join(' → '));
if (cycles.length) {
  console.log('  cycles that cannot be linearised (need a forward declaration):');
  for (const c of cycles) console.log(`     ↺ { ${c.join(' , ')} }  — break with a forward decl`);
} else {
  console.log('  no cycles — a clean topological order exists.');
}

console.log('\n── reading the result ───────────────────────────────────────');
console.log('main references late and isEven before they appear → two use-before-def');
console.log('findings (note for JS these are hoisted, so legal — but against the');
console.log('def-before-use *discipline*, which is the point). isEven/isOdd are');
console.log('mutually recursive → reported as a forward-decl cluster, not a failure.');
console.log('Everything is one breadth-first level: we never expanded the DAG.');
