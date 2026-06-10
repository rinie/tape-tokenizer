// defuse.js — §13a spike: breadth-first def/use projection on the intern-pool tape.
//
// Proves the core claim: you can see the def-before-use shape of code WITHOUT
// materialising the dependency DAG. The trick is adjacency at ONE level — direct
// edges between top-level definitions — never transitive closure.
//
// Substrate: unilexer.js — the consolidated tape. Keyword/literal tag bytes are
// the same token-tags mnemonics, the structural links let pass 1 enumerate
// top-level defs by O(1) skipping each body, and the interned ident pool index
// makes def↔use an integer compare. (Originally rode tokenizer.js; migrated in
// the §13e consolidation. The unified tape also carries ws/comment tokens —
// they are simply never matched by the branches below.)
//
// Linter-grade, honest scope: recognises `function NAME …{}` and `class NAME …{}`
// top-level declarations (clear brace bodies). const/arrow forms and nested-scope
// resolution are deliberately out of scope for the spike — see the caveats at the
// bottom. Positional ordering uses the tape index (monotonic in source order;
// 0-based below the waterline).

import { UniLexer } from './unilexer.js';
import { T } from './token-tags.js';

function isOpen(tag)  { return tag === T.LBRACE || tag === T.LPAREN || tag === T.LBRACKET; }
function isClose(tag) { return tag === T.RBRACE || tag === T.RPAREN || tag === T.RBRACKET; }

// Pass 1 + Pass 2 — enumerate depth-0 defs (skipping bodies via links), then
// collect each body's direct uses of other top-level names.
function extractDefUse(u) {
  const tag = u.tagOf;
  const identId = (t) => u.poolArr[t];   // interned ident pool index = stable id
  const identName = (t) => u.lexemeOf(t);
  const len = u.length;

  // Pass 1 — top-level definitions only. Skip each body in O(1) via its jump.
  const defs = [];
  let i = 0;
  while (i < len) {
    const t = tag(i);
    if (t === T.KW_FUNCTION || t === T.KW_CLASS) {
      // def name = first IDENT before the body brace
      let nameIdx = -1;
      // body open = first LBRACE at local depth 0 after the keyword
      let bodyOpen = -1;
      let d = 0;
      for (let k = i + 1; k < len; k++) {
        const tk = tag(k);
        if (tk === T.IDENT && nameIdx === -1 && d === 0) nameIdx = k;
        if (tk === T.LBRACE && d === 0) { bodyOpen = k; break; }
        if (isOpen(tk)) d++;
        else if (isClose(tk)) { if (d === 0) break; d--; }
      }
      // unmatched body brace → link -1: no unit (tolerant; the seam is the
      // structural layer's finding, not ours)
      const bodyClose = bodyOpen === -1 ? -1 : u.linkOf(bodyOpen);
      if (nameIdx !== -1 && bodyOpen !== -1 && bodyClose > bodyOpen) {
        defs.push({
          nameId: identId(nameIdx), name: identName(nameIdx),
          index: nameIdx, kind: t === T.KW_CLASS ? 'class' : 'function',
          bodyOpen, bodyClose, uses: new Map(),
        });
        i = bodyClose + 1;   // O(1) skip the whole body — stay at the top level
        continue;
      }
    }
    i++;
  }

  const byId = new Map(defs.map((d) => [d.nameId, d]));
  const topIds = new Set(defs.map((d) => d.nameId));

  // Pass 2 — direct uses inside each body, restricted to top-level names.
  // Breadth-first: the whole top-level span is one unit (nested scopes included).
  for (const def of defs) {
    for (let p = def.bodyOpen + 1; p < def.bodyClose; p++) {
      if (tag(p) === T.IDENT) {
        const id = identId(p);
        if (id !== def.nameId && topIds.has(id) && !def.uses.has(id)) def.uses.set(id, p);
      }
    }
  }

  return { defs, byId, topIds };
}

// The breadth-first outline: top-level names in file order, each with the
// top-level names it directly references. A flat adjacency table, not a graph.
function defUseOutline(du) {
  return du.defs.map((d) => ({
    name: d.name,
    kind: d.kind,
    index: d.index,
    uses: [...d.uses.keys()].map((id) => du.byId.get(id).name),
  }));
}

// Use-before-def: a top-level name referenced before its definition appears in
// the file. Positional finding with BOTH boundaries (use index + def index).
// Severity by provenance (Postel/Chesterton): lib = warning, own = error.
function useBeforeDef(du, policy = 'lib') {
  const findings = [];
  for (const def of du.defs) {
    for (const [usedId, useIndex] of def.uses) {
      const target = du.byId.get(usedId);
      if (target.index > useIndex) {
        findings.push({
          kind: 'use-before-def',
          severity: policy === 'own' ? 'error' : 'warning',
          user: def.name, used: target.name,
          useIndex, defIndex: target.index,        // both boundaries
          note: `${def.name} references ${target.name} at tape[${useIndex}], but ${target.name} is defined later at tape[${target.index}]`,
        });
      }
    }
  }
  findings.sort((a, b) => a.useIndex - b.useIndex);
  return findings;
}

// Suggested def-before-use reordering. Tarjan SCC over the top-level uses graph:
// it emits components in dependency-first order (a def's dependencies before the
// def) — exactly def-before-use — and any component of size > 1 is a mutual-
// recursion CYCLE that cannot be linearised: report it as a forward-decl cluster,
// never a failure.
function topoOrder(du) {
  const ids = du.defs.map((d) => d.nameId);
  const adj = new Map(ids.map((id) => [id, [...du.byId.get(id).uses.keys()]]));

  let counter = 0;
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], sccs = [];

  const strongconnect = (v) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v)) {
      if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) { low.set(v, Math.min(low.get(v), index.get(w))); }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const v of ids) if (!index.has(v)) strongconnect(v);

  const order = [];
  const cycles = [];
  for (const comp of sccs) {
    const names = comp.map((id) => du.byId.get(id).name);
    const selfLoop = comp.length === 1 && adj.get(comp[0]).includes(comp[0]);
    if (comp.length > 1 || selfLoop) cycles.push(names);
    order.push(...names);
  }
  return { order, cycles };
}

// Convenience: tokenize then extract.
function analyze(src) {
  const result = new UniLexer().tokenize(src);
  return { result, du: extractDefUse(result) };
}

export { extractDefUse, defUseOutline, useBeforeDef, topoOrder, analyze };
