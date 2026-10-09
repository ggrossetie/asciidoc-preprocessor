// The attribute state tracked by the transducer stage.
//
// A mapping from attribute name to value, with a per-attribute locked flag.
// This is the *only* state directives may consult (ifdef/ifndef/ifeval,
// attribute references in an include target or directive attribute list).
// Block processing never feeds back into it.

// Same shape as Asciidoctor's AttributeReferenceRx: an optional escaping
// backslash on either side, and the parser-side {set:...} / {counter:...}
// forms, which are recognized only so they can be left alone (D4: they
// are parser-side mechanisms the transducer never evaluates).
const ATTR_REF = /(\\)?\{([\p{L}\p{N}_][\p{L}\p{N}_-]*|(?:set|counter2?):.*?)(\\)?\}/gu;

// Character-replacement attributes that every AsciiDoc processor resolves
// in a reference ({sp}, {nbsp}, ...) without them being "defined": they
// never satisfy ifdef, and an entry cannot shadow them in a reference.
export const INTRINSIC_CHAR_REFS = {
  startsb: '[',
  endsb: ']',
  vbar: '|',
  caret: '^',
  asterisk: '*',
  tilde: '~',
  plus: '&#43;',
  backslash: '\\',
  backtick: '`',
  blank: '',
  empty: '',
  sp: ' ',
  'two-colons': '::',
  'two-semicolons': ';;',
  nbsp: '&#160;',
  deg: '&#176;',
  zwsp: '&#8203;',
  quot: '&#34;',
  apos: '&#39;',
  lsquo: '&#8216;',
  rsquo: '&#8217;',
  ldquo: '&#8220;',
  rdquo: '&#8221;',
  wj: '&#8288;',
  brvbar: '&#166;',
  pp: '&#43;&#43;',
  cpp: 'C&#43;&#43;',
  cxx: 'C&#43;&#43;',
  amp: '&',
  lt: '<',
  gt: '>',
};

function normalizeName(name) {
  return name.toLowerCase();
}

export class AttributeState {
  // seed: object of name -> value (string), name -> { value, soft }, or
  // name -> null/false (unset, the API form of "name!").
  // Attributes set without the soft-set modifier are locked, matching
  // "attributes set via the API/CLI are locked unless marked soft". A
  // locked unset is remembered so that a body entry cannot define it.
  constructor(seed = {}) {
    this._entries = new Map(); // name -> { value, locked }; value === undefined means locked-unset
    for (const [rawName, rawSpec] of Object.entries(seed)) {
      const name = normalizeName(rawName);
      const soft = typeof rawSpec === 'object' && rawSpec !== null && 'soft' in rawSpec;
      const value = soft ? rawSpec.value : rawSpec;
      if (value === null || value === false || value === undefined) {
        if (!soft) this._entries.set(name, { value: undefined, locked: true });
        continue;
      }
      this._entries.set(name, { value: String(value), locked: !soft });
    }
  }

  has(rawName) {
    const entry = this._entries.get(normalizeName(rawName));
    return entry !== undefined && entry.value !== undefined;
  }

  get(rawName) {
    const entry = this._entries.get(normalizeName(rawName));
    return entry ? entry.value : undefined;
  }

  isLocked(rawName) {
    const entry = this._entries.get(normalizeName(rawName));
    return entry ? entry.locked : false;
  }

  // Applies a recognized attr-entry to the state.
  // Returns true if the state was modified, false if the name is locked
  // (per spec: "An entry naming a locked attribute does not modify the
  // state").
  set(rawName, value) {
    const name = normalizeName(rawName);
    const existing = this._entries.get(name);
    if (existing && existing.locked) return false;
    this._entries.set(name, { value, locked: false });
    return true;
  }

  unset(rawName) {
    const name = normalizeName(rawName);
    const existing = this._entries.get(name);
    if (existing && existing.locked) return false;
    this._entries.delete(name);
    return true;
  }

  // Eager, snapshot-semantics resolution of {name} references against the
  // state *at this point in the stream*. Unresolved references are left
  // untouched (Asciidoctor's default attribute-missing=skip).
  resolveReferences(text) {
    return this.substitute(text, 'skip').text;
  }

  // Resolves references under an explicit attribute-missing policy:
  //   'skip' / 'warn'  leave the reference as is
  //   'drop'           replace it with the empty string
  //   'drop-line'      the whole text is dropped (text === null)
  // Returns { text, missing: [names] }.
  substitute(text, attributeMissing = 'skip') {
    const missing = [];
    let dropLine = false;
    const result = text.replace(ATTR_REF, (match, preEsc, ref, postEsc) => {
      if (preEsc || postEsc) return `{${ref}}`;
      if (ref.includes(':')) return match; // {set:...} / {counter:...}: parser-side, never evaluated here
      const name = normalizeName(ref);
      if (this.has(name)) return this.get(name);
      if (name in INTRINSIC_CHAR_REFS) return INTRINSIC_CHAR_REFS[name];
      missing.push(name);
      if (attributeMissing === 'drop') return '';
      if (attributeMissing === 'drop-line') dropLine = true;
      return match;
    });
    return { text: dropLine ? null : result, missing };
  }

  snapshot() {
    const out = {};
    for (const [name, { value }] of this._entries) if (value !== undefined) out[name] = value;
    return out;
  }
}
