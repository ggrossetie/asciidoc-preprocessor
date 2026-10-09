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
//
// Compatibility note: Asciidoctor's AttributeEntryRx is looser
// (`^:(!?\w[^:]*):`) and then *sanitizes* the name by deleting invalid
// characters (`:First Name: Dan` sets `firstname`). The spec grammar keeps
// the documented name constraints instead; such lines are not entries
// here (see COMPARISON.md).

const ATTR_ENTRY_LINE = /^:(!)?([\p{L}\p{N}_][\p{L}\p{N}_-]*)(!)?:(?:[ \t]+(.*))?$/u;

// Continuation markers, as in Asciidoctor (Parser.processAttributeEntry):
// a value ending with SP "\" (soft wrap; a preceding SP "+" makes it a hard
// wrap) or, legacy form, with SP "+" continues on the next line. The
// marker of the first line is the one every continuation line must repeat
// to keep the value open. Folding stops at an empty line, which is not
// consumed.
export const CONTINUATION = ' \\';
export const CONTINUATION_LEGACY = ' +';

// Returns null, or { unset, name, value, continuation } where continuation
// is the marker that keeps the value open (CONTINUATION or
// CONTINUATION_LEGACY), or null when the value is complete on this line.
export function matchAttrEntryLine(line) {
  const m = ATTR_ENTRY_LINE.exec(line);
  if (!m) return null;
  const [, prefixBang, name, suffixBang, rawValue] = m;
  if (prefixBang && suffixBang) return null; // "!" on both sides is not a valid entry
  const unset = Boolean(prefixBang || suffixBang);
  const { content, continuation } = splitContinuation(rawValue ?? '');
  return { unset, name, value: content, continuation };
}

// Detects a trailing continuation marker on the first value fragment and
// strips it. For a hard wrap ("+ \") the "+" is left in place on purpose:
// it is what makes the fold a newline, and it reproduces AsciiDoc's own
// hard line break once the value is substituted into body text.
function splitContinuation(fragment) {
  for (const marker of [CONTINUATION, CONTINUATION_LEGACY]) {
    if (fragment.endsWith(marker)) return { content: fragment.slice(0, -2).trimEnd(), continuation: marker };
  }
  return { content: fragment, continuation: null };
}

// Folds one more physical line into an in-progress value.
// Returns { consumed, value, continuation }: an empty line ends the value
// without being consumed; otherwise the line is consumed, its leading
// indentation discarded, and the value stays open only if the line ends
// with the same marker as the first line.
export function foldContinuationLine(accumulated, marker, rawLine) {
  if (rawLine === '') return { consumed: false, value: accumulated, continuation: null };
  let next = rawLine.trimStart();
  const keepOpen = next.endsWith(marker);
  if (keepOpen) next = next.slice(0, -2).trimEnd();
  const joiner = accumulated.endsWith(' +') ? '\n' : ' ';
  return { consumed: true, value: accumulated + joiner + next, continuation: keepOpen ? marker : null };
}

// pass:[...] / pass:SUBS[...] values: the macro is unwrapped, and only the
// attributes substitution (if requested) is applied — the preprocessor
// performs no other substitution.
const PASS_VALUE = /^pass:([a-z]+(?:,[a-z-]+)*)?\[([\s\S]*)\]$/;
const ATTRIBUTE_SUBS = new Set(['a', 'attributes', 'n', 'normal', 'header']);

// Computes the value an entry assigns: eager (snapshot) resolution of
// attribute references against the state at this point in the stream.
export function resolveEntryValue(value, attrState) {
  const pass = PASS_VALUE.exec(value);
  if (pass) {
    const subs = (pass[1] ?? '').split(',');
    return subs.some((s) => ATTRIBUTE_SUBS.has(s)) ? attrState.resolveReferences(pass[2]) : pass[2];
  }
  return attrState.resolveReferences(value);
}
