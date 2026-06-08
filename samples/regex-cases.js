// Valid JS exercising the regex/division ambiguity. With regex classification
// on, all of these must balance — the regex contents (quotes, brackets) are
// skipped, and real division is left as an operator.

const quoteInClass = /['"]/g;          // quote chars inside a class — not strings
const braceInClass = /[{}()[\]]/;      // brackets inside a class — not structure
const escapedSlash = /a\/b\/c/;        // escaped '/' does not close
const afterParen   = (x) => /re/.test(x);
const afterComma   = [/a/, /b/, /c/];

function division(a, b) {
  return a / b / 2;                    // real division — not regexes
}

function keywordThenRegex(s) {
  if (s) return /^\d+$/.test(s);       // 'return' → regex
  return typeof s / 1;                 // 'typeof s' → value, then division
}

const balanced = (division(10, 2) > 0) && afterParen('x');
