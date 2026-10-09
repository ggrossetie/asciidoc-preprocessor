// include::target[attrlist] directive recognition, and the content
// selection it supports (lines=, tag=/tags=, indent=).
//
// The selection algorithms are ported from Asciidoctor's
// PreprocessorReader so that the selected lines are identical; they are
// parser-orthogonal (they only look at the included file's own lines).

// Same shape as Asciidoctor's IncludeDirectiveRx.
const INCLUDE_LINE = /^(\\)?include::([^\s[](?:[^[]*[^\s[])?)\[(.+)?\]$/;

// Same shape as Asciidoctor's TagDirectiveRx.
const TAG_DIRECTIVE = /\b(?:tag|(e)nd)::(\S+?)\[\](?=$|[ \r])/;

// File extensions whose content is AsciiDoc, i.e. whose lines are
// themselves preprocessed (Asciidoctor's ASCIIDOC_EXTENSIONS).
export const ASCIIDOC_EXTENSIONS = ['.adoc', '.asciidoc', '.asc', '.ad', '.txt'];

export function isAsciiDocFile(filename) {
  return ASCIIDOC_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

export function parseIncludeLine(line) {
  const m = INCLUDE_LINE.exec(line);
  if (!m) return null;
  const [, escaped, target, attrlist] = m;
  return { escaped: Boolean(escaped), target, attrlist: attrlist ?? '' };
}

// A reduced AsciiDoc attrlist parser: comma-separated, `name=value` pairs
// with optionally quoted values; positional entries are ignored (include
// has none). `opts`/`options` expand to `<name>-option` keys, as in
// Asciidoctor (`opts=optional` -> `optional-option`).
export function parseAttrlist(attrlist) {
  const attrs = {};
  const re = /\s*([\p{L}\p{N}_][\p{L}\p{N}_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,]*))\s*(?:,|$)|\s*([^,]*)(?:,|$)/uy;
  let pos = 0;
  while (pos < attrlist.length) {
    re.lastIndex = pos;
    const m = re.exec(attrlist);
    if (!m || m[0] === '') break;
    pos = re.lastIndex;
    if (m[1] === undefined) continue;
    const name = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (name === 'opts' || name === 'options') {
      for (const opt of value.split(',')) if (opt.trim()) attrs[`${opt.trim()}-option`] = '';
    } else {
      attrs[name] = value;
    }
  }
  return attrs;
}

// Comma if present, otherwise semicolon (Asciidoctor's split_delimited_value).
function splitDelimitedValue(value) {
  return value.includes(',') ? value.split(',') : value.split(';');
}

// lines=1;3..5;10..-1 -> sorted unique line numbers, Infinity meaning "to the end".
export function parseLinenos(value) {
  const linenos = [];
  for (const ld of splitDelimitedValue(value)) {
    if (ld.includes('..')) {
      const [fromStr, toStr] = ld.split('..');
      const from = parseInt(fromStr, 10);
      if (toStr === '' || parseInt(toStr, 10) < 0) linenos.push(from, Infinity);
      else for (let i = from; i <= parseInt(toStr, 10); i++) linenos.push(i);
    } else {
      linenos.push(parseInt(ld, 10));
    }
  }
  const sorted = [...new Set(linenos.filter((n) => !Number.isNaN(n)))].sort((a, b) => a - b);
  return sorted.length > 0 ? sorted : null;
}

// Returns { lines: [{ text, lineno }], partial }
export function filterByLinenos(fileLines, linenos) {
  const remaining = [...linenos];
  const selected = [];
  let selectRemaining = false;
  for (let idx = 0; idx < fileLines.length; idx++) {
    const lineno = idx + 1;
    if (selectRemaining || (remaining[0] === Infinity && (selectRemaining = true))) {
      selected.push({ text: fileLines[idx], lineno });
    } else if (remaining[0] === lineno) {
      selected.push({ text: fileLines[idx], lineno });
      remaining.shift();
      if (remaining.length === 0) break;
    }
  }
  return { lines: selected, partial: true };
}

// tag=name / tags=a;!b;* / tags=** ... -> { name: include? }
export function parseTags(attrs) {
  if ('tag' in attrs) {
    const tag = attrs.tag;
    if (!tag || tag === '!') return null;
    return tag.startsWith('!') ? { [tag.slice(1)]: false } : { [tag]: true };
  }
  if ('tags' in attrs) {
    const tags = {};
    for (const td of splitDelimitedValue(attrs.tags)) {
      if (td && td !== '!') tags[td.startsWith('!') ? td.slice(1) : td] = !td.startsWith('!');
    }
    return Object.keys(tags).length > 0 ? tags : null;
  }
  return null;
}

// Port of PreprocessorReader#filter_lines_by_tags (tag lines themselves are
// never selected). Returns { lines: [{ text, lineno }], partial, warnings }.
export function filterByTags(fileLines, inputTags) {
  const tags = { ...inputTags };
  let select;
  let baseSelect;
  let wildcard;
  if ('**' in tags) {
    select = baseSelect = tags['**'];
    delete tags['**'];
    if ('*' in tags) {
      wildcard = tags['*'];
      delete tags['*'];
    } else if (!select && Object.values(tags)[0] === false) {
      wildcard = true;
    }
  } else if ('*' in tags) {
    if (Object.keys(tags)[0] === '*') select = baseSelect = !(wildcard = tags['*']);
    else {
      select = baseSelect = false;
      wildcard = tags['*'];
    }
    delete tags['*'];
  } else {
    select = baseSelect = !Object.values(tags).includes(true);
  }

  const selected = [];
  const warnings = [];
  const tagStack = [];
  const tagsSelected = new Set();
  let activeTag = null;
  for (let idx = 0; idx < fileLines.length; idx++) {
    const lineno = idx + 1;
    const l = fileLines[idx];
    if (l.includes('::') && l.includes('[]')) {
      const m = TAG_DIRECTIVE.exec(l);
      if (m) {
        const [, isEnd, thisTag] = m;
        if (isEnd) {
          if (thisTag === activeTag) {
            tagStack.pop();
            [activeTag, select] = tagStack.length === 0 ? [null, baseSelect] : tagStack[tagStack.length - 1];
          } else if (thisTag in tags) {
            const si = tagStack.findLastIndex(([k]) => k === thisTag);
            if (si >= 0) {
              tagStack.splice(si, 1);
              warnings.push(`mismatched end tag (expected '${activeTag}' but found '${thisTag}') at line ${lineno}`);
            } else {
              warnings.push(`unexpected end tag '${thisTag}' at line ${lineno}`);
            }
          }
        } else if (thisTag in tags) {
          if ((select = tags[thisTag])) tagsSelected.add(thisTag);
          tagStack.push([(activeTag = thisTag), select, lineno]);
        } else if (wildcard !== undefined) {
          select = activeTag && !select ? false : wildcard;
          tagStack.push([(activeTag = thisTag), select, lineno]);
        }
        continue;
      }
    }
    if (select) selected.push({ text: l, lineno });
  }
  for (const [tagName, , tagLineno] of tagStack) warnings.push(`detected unclosed tag '${tagName}' starting at line ${tagLineno}`);
  const missing = Object.entries(tags)
    .filter(([k, v]) => v && !tagsSelected.has(k))
    .map(([k]) => k);
  if (missing.length > 0) warnings.push(`tag${missing.length > 1 ? 's' : ''} '${missing.join(', ')}' not found`);
  const partial = !baseSelect || wildcard === false || Object.keys(tags).length > 0;
  return { lines: selected, partial, warnings };
}

// Port of Asciidoctor's adjust_indentation! (indent=N).
export function adjustIndentation(lines, indentSize) {
  let blockIndent = null;
  for (const { text } of lines) {
    if (text === '') continue;
    const lineIndent = text.length - text.trimStart().length;
    if (lineIndent === 0) {
      blockIndent = null;
      break;
    }
    if (blockIndent === null || lineIndent < blockIndent) blockIndent = lineIndent;
  }
  const newIndent = ' '.repeat(indentSize);
  for (const line of lines) {
    if (line.text === '') continue;
    const body = blockIndent ? line.text.slice(blockIndent) : line.text;
    line.text = indentSize === 0 ? body : newIndent + body;
  }
}
