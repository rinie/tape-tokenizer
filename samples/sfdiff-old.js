// version 1
function helper(x) { return x * 2; }

function gone(q) { return q - 1; }

function compute(a, b) {
  const t = helper(a);
  return t + b;
}

function late(y) { return y + 1; }

const top = compute(1, 2);
