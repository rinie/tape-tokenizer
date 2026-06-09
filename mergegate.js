// mergegate.js — §13c spike: the scanner as a structure-aware merge gate.
//
// A git conflict is a flat tape cut on the LINE grid; its markers
// (<<<<<<< ======= >>>>>>>) rarely line up with structural seams. Two
// consequences this module makes operational:
//
//   1. splitConflict() reconstructs the two parent versions (ours / theirs) from
//      a marked file. Because the markers cut the line grid, a reconstructed
//      parent can itself be structurally unbalanced — the line boundary fell
//      between a bracket and its closer in the common tail. We *show* that.
//
//   2. mergeGate() validates a resolution: scan ours, theirs, and the merged
//      result; any structural seam present in `merged` beyond what either parent
//      had was INTRODUCED by the merge. A resolution that adds no new seam is
//      structurally safe; one that does is rejected, with the kinds it added.
//
// Comparison is by seam KIND counts (offsets shift between versions, so
// offset-level identity across versions is out of scope for the spike). The
// guiding invariant: a merge must be no more structurally broken than its
// parents.

import { LexicalScanner } from './lexical-scanner.js';

// Reconstruct ours/theirs from a file containing conflict markers.
function splitConflict(src) {
  const ours = [];
  const theirs = [];
  let state = 'common';
  let hadConflict = false;
  for (const line of src.split('\n')) {
    if (line.startsWith('<<<<<<<')) { state = 'ours'; hadConflict = true; continue; }
    if (line.startsWith('|||||||') && state === 'ours') { state = 'base'; continue; }   // diff3 base — drop
    if (line.startsWith('=======') && (state === 'ours' || state === 'base')) { state = 'theirs'; continue; }
    if (line.startsWith('>>>>>>>')) { state = 'common'; continue; }
    if (state === 'common') { ours.push(line); theirs.push(line); }
    else if (state === 'ours') ours.push(line);
    else if (state === 'theirs') theirs.push(line);
    // base lines are dropped
  }
  return { ours: ours.join('\n'), theirs: theirs.join('\n'), hadConflict };
}

// Structural seam signature of one version: the warning-severity findings,
// counted by kind, plus whether the version closes within itself.
function seamSignature(src, table) {
  const r = new LexicalScanner().scan(src, table);
  const seams = r.seams();
  const byKind = {};
  for (const s of seams) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  return { seams, byKind, selfContained: r.selfContained(), count: seams.length };
}

// Validate a resolution against its parents.
function mergeGate(ours, theirs, merged, table) {
  const o = seamSignature(ours, table);
  const t = seamSignature(theirs, table);
  const m = seamSignature(merged, table);

  // For each seam kind, the merged count must not exceed max(ours, theirs).
  const introduced = [];
  const kinds = new Set([...Object.keys(o.byKind), ...Object.keys(t.byKind), ...Object.keys(m.byKind)]);
  for (const k of kinds) {
    const mc = m.byKind[k] || 0;
    const parentMax = Math.max(o.byKind[k] || 0, t.byKind[k] || 0);
    if (mc > parentMax) introduced.push({ kind: k, mergedCount: mc, parentMax, added: mc - parentMax });
  }

  return { ours: o, theirs: t, merged: m, introduced, safe: introduced.length === 0 };
}

export { splitConflict, seamSignature, mergeGate };
