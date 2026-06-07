// A perfectly valid JS file whose regex literal contains quote characters.
// JS_TABLE has no regex awareness, so it sees the ' inside /['"]/ as the start
// of a string and swallows real structure until the next quote — producing a
// FALSE imbalance. This is the documented limitation, proven, not hidden.
const re = /['"]/g;

function strip(a) {
  return a.replace(re, '');
}
