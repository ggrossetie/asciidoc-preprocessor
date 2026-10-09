// The open-delimiter stack (§4). Tracks verbatim (listing/literal/fenced),
// passthrough, comment, and table delimiter lines. While any of these is
// open, the region is opaque: lines inside are not scanned for attribute
// entries, but directives (ifdef/ifndef/ifeval/include) remain recognized
// and still resolve against the state from before the region (write
// barrier, not a read barrier).
//
// Non-verbatim delimited blocks (example, sidebar, open, quote, etc.) are
// deliberately NOT tracked: an attribute entry is legal for the parser
// there, so lexical tracking is correct as-is.
//
// Passthrough (`++++`, left open by the proposal, Appendix C) is tracked:
// its content model is raw in Asciidoctor, so an entry-shaped line inside
// it is passed-through content, never an attribute entry. Fenced code
// (```), Asciidoctor's Markdown-compatible listing, is tracked like `----`.

const VERBATIM = /^(-{4,}|\.{4,})$/; // listing ----, literal ....
const FENCED = /^```.*$/; // ``` or ```lang; closed by a bare ```
const PASSTHROUGH = /^\+{4,}$/; // ++++
const COMMENT = /^\/{4,}$/; // ////
const TABLE = /^[|,:!]={3,}$/; // |===, ,===, :===, !=== (any number of "=" >= 3)

function classify(line) {
  if (VERBATIM.test(line)) return { kind: 'verbatim', closer: line };
  if (FENCED.test(line)) return { kind: 'verbatim', closer: '```' };
  if (PASSTHROUGH.test(line)) return { kind: 'passthrough', closer: line };
  if (COMMENT.test(line)) return { kind: 'comment', closer: line };
  if (TABLE.test(line)) return { kind: 'table', closer: line };
  return null;
}

export class DelimiterStack {
  constructor() {
    this._stack = []; // { kind, closer (exact line text that closes it) }
  }

  get isOpen() {
    return this._stack.length > 0;
  }

  get depth() {
    return this._stack.length;
  }

  get top() {
    return this._stack[this._stack.length - 1];
  }

  markUnitStart() {
    return this._stack.length;
  }

  // Diagnostics for D3 ("each include unit MUST leave the open-delimiter
  // stack as it found it"). An include unit that closes a region it did
  // not open leaves the stack shallower than it found it; one that opens
  // a region and leaves it open leaves it deeper. Both are reported.
  checkUnitEnd(startDepth, unitClosedOuter = 0) {
    const diagnostics = [];
    if (unitClosedOuter > 0) {
      diagnostics.push({
        rule: 'D3',
        severity: 'warning',
        message: `unbalanced delimiter: this include unit closed ${unitClosedOuter} delimited block(s) it did not open`,
      });
    }
    if (this._stack.length > startDepth) {
      diagnostics.push({
        rule: 'D3',
        severity: 'warning',
        message: `unbalanced delimiter: ${this._stack.length - startDepth} delimited block(s) opened in this include unit are still open at its end`,
      });
    }
    return diagnostics;
  }

  // Feeds one line; returns { isDelimiterLine, opened, closed } describing
  // what happened. A delimiter line is never itself scanned as content.
  //
  // The tracked kinds do not nest: while a region is open, only a line
  // that exactly matches its closing marker closes it. Any other
  // delimiter-shaped line encountered inside is opaque content (e.g. a
  // `|===` typed inside a listing block does not open a table).
  observe(line) {
    const top = this.top;
    if (top) {
      if (top.closer === line) {
        this._stack.pop();
        return { isDelimiterLine: true, opened: false, closed: true };
      }
      return { isDelimiterLine: false, opened: false, closed: false };
    }

    const found = classify(line);
    if (!found) return { isDelimiterLine: false, opened: false, closed: false };
    this._stack.push(found);
    return { isDelimiterLine: true, opened: true, closed: false };
  }
}
