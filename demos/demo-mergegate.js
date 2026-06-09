// demo-mergegate.js — run with: node demos/demo-mergegate.js
// §13c: the scanner as a structure-aware merge gate.
import { splitConflict, seamSignature, mergeGate } from '../mergegate.js';
import { JS_TABLE } from '../lexical-scanner.js';

const T = JS_TABLE;

function v(sig) {
  return sig.selfContained ? 'balanced' : `${sig.count} seam(s): ${Object.keys(sig.byKind).join(', ')}`;
}

// ── Conflict 1: well-placed conflict, both parents balanced ──────────────────
console.log('═══ conflict 1: clean parents, gate three resolutions ═══════════');
const conflict1 = `function area(w, h) {
<<<<<<< ours
  const a = w * h;
  return a;
=======
  return w * h;
>>>>>>> theirs
}`;
const { ours: o1, theirs: t1 } = splitConflict(conflict1);
console.log('  ours   :', v(seamSignature(o1, T)));
console.log('  theirs :', v(seamSignature(t1, T)));

// (a) take ours — a clean pick
const good = o1;
// (b) take theirs — also clean
const alsoGood = t1;
// (c) a botched resolution: dropped the closing brace
const bad = `function area(w, h) {
  const a = w * h;
  return a;`;

for (const [label, merged] of [['take ours', good], ['take theirs', alsoGood], ['botched (dropped })', bad]]) {
  const g = mergeGate(o1, t1, merged, T);
  if (g.safe) {
    console.log(`  ✓ SAFE     ${label} — introduced no new seam`);
  } else {
    const what = g.introduced.map((i) => `${i.added}× ${i.kind}`).join(', ');
    console.log(`  ✗ REJECTED ${label} — merge introduced: ${what}`);
  }
}

// ── Conflict 2: the markers cut between a bracket and its closer ─────────────
console.log('\n═══ conflict 2: markers don\'t align with structure ═════════════');
const conflict2 = `function f() {
<<<<<<< ours
  while (a) {
    g();
=======
  h();
>>>>>>> theirs
  }
}`;
const { ours: o2, theirs: t2 } = splitConflict(conflict2);
console.log('  reconstructed ours   :', v(seamSignature(o2, T)));
console.log('  reconstructed theirs :', v(seamSignature(t2, T)));
console.log('  → the conflict boundary fell between the `while {` and the common');
console.log('    tail `}` that closes it. "theirs" inherits a tail `}` with no opener');
console.log('    — an orphan close. The line-grid markers cut across a structural');
console.log('    span; this is exactly what a structure-aware merge would re-seam.');

console.log('\n── reading the result ───────────────────────────────────────');
console.log('Gate rule: a resolution may not be more structurally broken than its');
console.log('parents. "take ours/theirs" add nothing → SAFE; the botched resolution');
console.log('introduces an unmatched `{` that neither parent had → REJECTED. And a');
console.log('conflict can split a bracket from its closer, leaving a reconstructed');
console.log('parent unbalanced — the markers-on-the-line-grid problem itself.');
