// The open-delimiter stack (§4). Tracks verbatim (listing/literal),
// comment, and table delimiter lines. While any of these is open, the
// region is opaque: lines inside are not scanned for attribute entries,
// but directives (ifdef/ifndef/ifeval/include) remain recognized and still
// resolve against the state from before the region (write barrier, not a
// read barrier).
//
// Non-verbatim delimited blocks (example, sidebar, open, quote, etc.) are
// deliberately NOT tracked: an attribute entry is legal for the parser
// there, so lexical tracking is correct as-is.

const VERBATIM = /^(-{4,}|\.{4,})$/; // listing ----, literal ....
const COMMENT = /^\/{4,}$/; // ////
const TABLE = /^(\|===|,===|:===|!===)$/;

function classify(line) {
  const trimmed = line;
  if (VERBATIM.test(trimmed)) return 'verbatim';
  if (COMMENT.test(trimmed)) return 'comment';
  if (TABLE.test(trimmed)) return 'table';
  return null;
}

export class DelimiterStack {
  constructor() {
    this._stack = []; // { kind, marker (exact line text) }
  }

  get isOpen() {
    return this._stack.length > 0;
  }

  get depth() {
    return this._stack.length;
  }

  markUnitStart() {
    return this._stack.length;
  }

  // Diagnostics for D3 ("each include unit MUST leave the open-delimiter
  // stack as it found it").
  checkUnitEnd(startDepth) {
    if (this._stack.length === startDepth) return [];
    return [
      {
        rule: 'D3',
        message: `unbalanced delimiter: ${this._stack.length - startDepth} delimited block(s) opened in this include unit are still open at its end`,
      },
    ];
  }

  // Feeds one line; returns { isDelimiterLine, opened, closed } describing
  // what happened. A delimiter line is never itself scanned as content.
  //
  // The tracked kinds do not nest: while a region is open, only a line
  // that exactly matches its opening marker closes it. Any other
  // delimiter-shaped line encountered inside is opaque content (e.g. a
  // `|===` typed inside a listing block does not open a table).
  observe(line) {
    const top = this._stack[this._stack.length - 1];
    if (top) {
      if (top.marker === line) {
        this._stack.pop();
        return { isDelimiterLine: true, opened: false, closed: true };
      }
      return { isDelimiterLine: false, opened: false, closed: false };
    }

    const kind = classify(line);
    if (!kind) return { isDelimiterLine: false, opened: false, closed: false };
    this._stack.push({ kind, marker: line });
    return { isDelimiterLine: true, opened: true, closed: false };
  }
}
