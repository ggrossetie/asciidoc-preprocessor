// The document header mini-grammar (§2): doctitle, author, and revision
// lines, each line-oriented and unnested, recognized by position via a
// header-mode flag carried in the bounded context (see the transducer's
// `headerState`). This assigns the implicit attributes those lines define,
// subject to the locked rule.
//
// The author and revision grammars are ported from Asciidoctor
// (AuthorInfoLineRx, AuthorDelimiterRx, RevisionInfoLineRx,
// Parser.process_authors) so the implicit attributes match.
//
// Scope note: the setext (two-line, underlined) doctitle form is not
// recognized: deciding it needs one line of look-ahead, which §1 excludes.

const DOCTITLE_LINE = /^= +(\S.*?)\s*$/;
const AUTHOR_INFO_LINE =
  /^([\p{L}\p{N}_][\p{L}\p{N}_\-'.]*)(?: +([\p{L}\p{N}_][\p{L}\p{N}_\-'.]*))?(?: +([\p{L}\p{N}_][\p{L}\p{N}_\-'.]*))?(?: +<([^>]+)>)?$/u;
const AUTHOR_DELIMITER = /;(?: |$)/;
const REVISION_INFO_LINE = /^(?:[^\d{]*(.*?),)? *(?!:)(.*?)(?: *(?!^),?: *(.*))?$/;
const AUTHOR_KEYS = ['author', 'authorinitials', 'firstname', 'middlename', 'lastname', 'email'];

export function matchDoctitleLine(line) {
  const m = DOCTITLE_LINE.exec(line);
  return m ? { doctitle: m[1] } : null;
}

// Port of Asciidoctor's Parser.process_authors. With namesOnly, each entry
// is a plain name (as given by an `:author:` / `:authors:` entry), not an
// author-info line with an optional <email>.
export function processAuthors(authorLine, { namesOnly = false, multiple = true } = {}) {
  const meta = {};
  const entries = multiple && authorLine.includes(';') ? authorLine.split(AUTHOR_DELIMITER) : [authorLine];
  let idx = 0;
  for (const entry of entries) {
    if (entry === '') continue;
    idx++;
    const key = (k) => (idx === 1 ? k : `${k}_${idx}`);

    let segments = null;
    if (namesOnly) {
      let clean = entry;
      if (entry.includes('<')) {
        meta[key('author')] = entry.replace(/_/g, ' ');
        clean = entry.replace(/<[^>]+>/g, '');
      }
      const parts = clean.split(/\s+/).filter(Boolean);
      segments = parts.length > 3 ? [...parts.slice(0, 2), parts.slice(2).join(' ')] : parts;
    } else {
      const m = AUTHOR_INFO_LINE.exec(entry);
      if (m) segments = m.slice(1);
    }

    if (segments && segments.length > 0) {
      const fname = segments[0].replace(/_/g, ' ');
      meta[key('firstname')] = fname;
      meta[key('authorinitials')] = fname[0];
      let author = fname;
      if (segments[1]) {
        if (segments[2]) {
          const mname = segments[1].replace(/_/g, ' ');
          const lname = segments[2].replace(/_/g, ' ');
          meta[key('middlename')] = mname;
          meta[key('lastname')] = lname;
          author = `${fname} ${mname} ${lname}`;
          meta[key('authorinitials')] = `${fname[0]}${mname[0]}${lname[0]}`;
        } else {
          const lname = segments[1].replace(/_/g, ' ');
          meta[key('lastname')] = lname;
          author = `${fname} ${lname}`;
          meta[key('authorinitials')] = `${fname[0]}${lname[0]}`;
        }
      }
      meta[key('author')] ??= author;
      if (!namesOnly && segments[3]) meta[key('email')] = segments[3];
    } else {
      const author = entry.replace(/ {2,}/g, ' ').trim();
      meta[key('author')] = author;
      meta[key('firstname')] = author;
      meta[key('authorinitials')] = author[0];
    }

    if (idx === 1) {
      meta.authors = meta[key('author')];
    } else {
      if (idx === 2) for (const k of AUTHOR_KEYS) if (k in meta) meta[`${k}_1`] = meta[k];
      meta.authors = `${meta.authors}, ${meta[key('author')]}`;
    }
  }
  meta.authorcount = String(idx);
  return meta;
}

// The author line is whatever non-empty line follows the doctitle (and
// any attribute entries / comments in between): Asciidoctor does not
// require it to look like a name.
export function matchAuthorLine(line) {
  if (line.trim() === '') return null;
  return processAuthors(line);
}

// The revision line is whatever non-empty line follows the author line,
// provided it matches RevisionInfoLineRx (which almost any line does).
export function matchRevisionLine(line) {
  const m = REVISION_INFO_LINE.exec(line);
  if (!m) return null;
  const attrs = {};
  if (m[1]) attrs.revnumber = m[1].trimEnd();
  const component = (m[2] ?? '').trim();
  if (component !== '') {
    if (!m[1] && component.startsWith('v')) attrs.revnumber = component.slice(1);
    else attrs.revdate = component;
  }
  if (m[3]) attrs.revremark = m[3].trimEnd();
  return attrs;
}
