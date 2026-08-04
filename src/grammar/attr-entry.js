// Closed, anchored grammar for an attribute entry line:
//
//   attr-entry = ":" ( name / "!" name / name "!" ) ":" [ sp value ]
//   name       = word-char *( word-char / "-" )
//   word-char  = ALPHA / DIGIT / "_"
//   sp         = 1*( SP / HTAB )
//   value      = <rest of line; may wrap>
//
// Recognition is decided purely from the character content of the line —
// no parser feedback.

const ATTR_ENTRY_LINE = /^:(!)?([A-Za-z0-9_][A-Za-z0-9_-]*)(!)?:(?:[ \t]+(.*))?$/;

// The wrap marker proper is always "SP \" (one space, one backslash) at the
// end of the line. Hard wrap is that same marker preceded by "SP +"; per
// spec, "the SP + is retained in the value as a hard line break
// replacement" — so only the trailing "SP \" is ever stripped, and a hard
// wrap leaves its "+" sitting in the folded content on purpose.
const TRAILING_MARKER = /[ \t]\\$/;
const HARD_TAIL = /[ \t]\+$/;

// Returns null, or { unset, name, value, wrap } where wrap is 'soft',
// 'hard', or null (value is complete on this line).
export function matchAttrEntryLine(line) {
  const m = ATTR_ENTRY_LINE.exec(line);
  if (!m) return null;
  const [, prefixBang, name, suffixBang, rawValue] = m;
  if (prefixBang && suffixBang) return null; // "!" on both sides is not a valid entry
  const unset = Boolean(prefixBang || suffixBang);
  const value = rawValue ?? '';
  const { content, wrap } = splitWrapMarker(value);
  return { unset, name, value: content, wrap };
}

// Detects a trailing wrap marker on a value fragment (first line or a
// continuation line) and strips it, returning the clean content plus which
// kind of wrap was requested. For a hard wrap the "+" is left in place.
export function splitWrapMarker(fragment) {
  if (!TRAILING_MARKER.test(fragment)) return { content: fragment, wrap: null };
  const stripped = fragment.replace(TRAILING_MARKER, '');
  return HARD_TAIL.test(stripped) ? { content: stripped, wrap: 'hard' } : { content: stripped, wrap: 'soft' };
}

// Folds one more physical line into an in-progress value continuation.
// Leading indentation of the continuation line is discarded before it is
// examined for a further wrap marker of its own.
export function foldContinuationLine(accumulated, wrap, rawLine) {
  const dedented = rawLine.replace(/^[ \t]+/, '');
  const { content, wrap: nextWrap } = splitWrapMarker(dedented);
  const joiner = wrap === 'hard' ? '\n' : ' ';
  return { value: accumulated + joiner + content, wrap: nextWrap };
}
