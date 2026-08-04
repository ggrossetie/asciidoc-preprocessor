// The document header mini-grammar (§2): doctitle, author, and revision
// lines, each line-oriented and unnested, recognized by position via a
// header-mode flag carried in the bounded context (see Transducer's
// `headerState`). This assigns the implicit attributes those lines define,
// subject to the locked rule.
//
// Scope note: this is a deliberately reduced subset of Asciidoctor's full
// author/revision grammar (single author, no author-list `;` separator,
// simplified revision line) — enough to demonstrate that header
// recognition is lexical (decidable by line shape + position), not a
// claim of full compatibility. See README.

const DOCTITLE_LINE = /^= (\S.*)$/;
const REVISION_LINE = /^v(\S+)(?:,\s*([^:]+?))?(?:\s*:\s*(.+))?$/;

export function matchDoctitleLine(line) {
  const m = DOCTITLE_LINE.exec(line);
  return m ? { doctitle: m[1] } : null;
}

// Lines that are themselves recognized by another lexical rule (an
// attr-entry, a directive) are never mistaken for a header line — a
// header slot only claims a line that doesn't already belong to a more
// specific grammar.
const LOOKS_LIKE_OTHER_GRAMMAR = /^:|^(ifdef|ifndef|ifeval|endif|include)::/;

export function matchAuthorLine(line) {
  if (line.trim() === '' || LOOKS_LIKE_OTHER_GRAMMAR.test(line)) return null;
  const m = /^(.*?)(?:\s*<([^>]+)>)?$/.exec(line);
  if (!m) return null;
  const [, namePart, email] = m;
  const names = namePart.trim().split(/\s+/).filter(Boolean);
  if (names.length === 0) return null;
  const [firstname, ...rest] = names;
  const lastname = rest.length > 0 ? rest[rest.length - 1] : undefined;
  const middlename = rest.length > 1 ? rest.slice(0, -1).join(' ') : undefined;
  const author = names.join(' ');
  const initials = [firstname, middlename, lastname].filter(Boolean).map((n) => n[0].toUpperCase()).join('');
  const attrs = { author, firstname, authorinitials: initials };
  if (middlename) attrs.middlename = middlename;
  if (lastname) attrs.lastname = lastname;
  if (email) attrs.email = email;
  return attrs;
}

export function matchRevisionLine(line) {
  if (LOOKS_LIKE_OTHER_GRAMMAR.test(line)) return null;
  const m = REVISION_LINE.exec(line);
  if (!m) return null;
  const [, revnumber, revdate, revremark] = m;
  const attrs = { revnumber };
  if (revdate) attrs.revdate = revdate.trim();
  if (revremark) attrs.revremark = revremark.trim();
  return attrs;
}
