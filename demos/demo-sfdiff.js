// demo-sfdiff.js — run with: node demos/demo-sfdiff.js
// Subforest diff: compare two versions as a forest of whole top-level units,
// matched by name — never as line deltas. The CLI form:
//   node sfdiff.js samples/sfdiff-old.js samples/sfdiff-new.js
import { readFileSync } from 'node:fs';
import { topLevelUnits, diffForests } from '../sfdiff.js';
import { ValueTape } from '../valuetape.js';

const oldSrc = readFileSync('samples/sfdiff-old.js', 'utf8');
const newSrc = readFileSync('samples/sfdiff-new.js', 'utf8');

const rows = diffForests(
  topLevelUnits(new ValueTape().tokenize(oldSrc)),
  topLevelUnits(new ValueTape().tokenize(newSrc)),
);

console.log('═══ subforest diff (breadth-first: whole units, matched by name) ══');
const MARK = { unchanged: '=', moved: '^', modified: '~', added: '+', removed: '-' };
for (const r of rows) {
  let line = `  ${MARK[r.verdict]} ${r.name.padEnd(20)} ${r.verdict}`;
  if (r.verdict === 'modified') {
    line += ` — first diff: '${r.diff.old?.lex}' → '${r.diff.new?.lex}'`;
  }
  console.log(line);
}

// The contrast: what a line-grid view of the same change looks like.
const oldLines = oldSrc.split('\n');
const newLines = new Set(newSrc.split('\n'));
const oldSet = new Set(oldLines);
const removed = oldLines.filter((l) => !newLines.has(l)).length;
const added = [...newLines].filter((l) => !oldSet.has(l)).length;

console.log('\n═══ the contrast ═════════════════════════════════════════════════');
console.log(`  naive line delta: ~${removed + added} changed lines (reformatting,`);
console.log('  comments and moves all read as churn on the line grid).');
console.log('  subforest verdict: ONE token actually changed (+ → -), one unit');
console.log('  moved, one added, one removed — helper\'s reformat is invisible,');
console.log('  because whitespace and comments are separate kinds in the pools.');

console.log('\n── reading the result ───────────────────────────────────────');
console.log('Match the forest by name (breadth-first, one level), compare units by');
console.log('content fingerprint, and descend only into the one modified unit —');
console.log('one step, to its first differing token. The DAG never materialises.');
