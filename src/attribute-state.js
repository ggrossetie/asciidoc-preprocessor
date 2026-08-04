// The attribute state tracked by the transducer stage.
//
// A mapping from attribute name to value, with a per-attribute locked flag.
// This is the *only* state directives may consult (ifdef/ifndef/ifeval,
// attribute references in an include target or directive attribute list).
// Block processing never feeds back into it.

const ATTR_REF = /\{([a-z0-9_][a-z0-9_-]*)\}/g;

function normalizeName(name) {
  return name.toLowerCase();
}

export class AttributeState {
  // seed: object of name -> value (string) or name -> { value, soft }.
  // Attributes set without the soft-set modifier are locked, matching
  // "attributes set via the API/CLI are locked unless marked soft".
  constructor(seed = {}) {
    this._entries = new Map(); // name -> { value, locked }
    for (const [rawName, rawSpec] of Object.entries(seed)) {
      const name = normalizeName(rawName);
      const soft = typeof rawSpec === 'object' && rawSpec !== null && 'soft' in rawSpec;
      const value = soft ? rawSpec.value : rawSpec;
      this._entries.set(name, { value: String(value), locked: !soft });
    }
  }

  has(rawName) {
    return this._entries.has(normalizeName(rawName));
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
  // untouched (mirrors Asciidoctor's default attribute-missing=skip).
  resolveReferences(text) {
    return text.replace(ATTR_REF, (match, rawName) => {
      const name = normalizeName(rawName);
      return this._entries.has(name) ? this._entries.get(name).value : match;
    });
  }

  snapshot() {
    const out = {};
    for (const [name, { value }] of this._entries) out[name] = value;
    return out;
  }
}
