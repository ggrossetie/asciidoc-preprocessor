// include::target[attrlist] directive recognition.
//
// Scope note: content-selection features (lines=, tag(s)=) are parser-
// orthogonal to the transducer model this project demonstrates and are
// out of scope here — an include always contributes the full referenced
// unit. See README.

const INCLUDE_LINE = /^include::([^[\]]+)\[(.*)\]$/;

export function parseIncludeLine(line) {
  const m = INCLUDE_LINE.exec(line);
  if (!m) return null;
  const [, target, attrlist] = m;
  return { target, attrlist };
}
