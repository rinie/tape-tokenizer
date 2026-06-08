// A valid JS file whose regex literal contains quote characters. This used to
// be the documented JS_TABLE limitation — the ' inside /['"]/ was read as a
// string start and swallowed real structure (a FALSE seam). Now RESOLVED:
// JS_TABLE has `regex: true`, so this scans clean. Kept as a regression guard.
const re = /['"]/g;

function strip(a) {
  return a.replace(re, '');
}
