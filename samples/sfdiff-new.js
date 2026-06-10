// version 2
function late(y) { return y + 1; }

function helper(x) {
        // reformatted: new indentation, brace style, and this comment —
        // but the CONTENT is identical
        return x * 2;
}

function compute(a, b) {
  const t = helper(a);
  return t - b;
}

function extra(z) { return z; }

const top = compute(1, 2);
