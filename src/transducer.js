// The stream-clocked line transducer: an independent preprocessing stage
// that consumes a source line stream and emits an output line stream plus
// a provenance map (output line -> source file and line). It maintains
// its own attribute state and never consults a parser; no information
// flows back into it. See README.md for the full model and COMPARISON.md
// for every known difference with Asciidoctor's PreprocessorReader.

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep, basename } from 'node:path';

import { AttributeState } from './attribute-state.js';
import { matchAttrEntryLine, foldContinuationLine, resolveEntryValue } from './grammar/attr-entry.js';
import { matchDoctitleLine, matchAuthorLine, matchRevisionLine, processAuthors } from './grammar/header.js';
import { DelimiterStack } from './grammar/delimiters.js';
import { ConditionalStack, parseDirectiveLine } from './grammar/conditionals.js';
import {
  parseIncludeLine,
  parseAttrlist,
  parseLinenos,
  parseTags,
  filterByLinenos,
  filterByTags,
  adjustIndentation,
  isAsciiDocFile,
} from './grammar/include.js';
import { applyDerivedHeaderAttribute, safeModeLevel } from './intrinsic-attributes.js';

const URI_SNIFF = /^[\p{L}][\p{L}\p{N}.+-]+:\/{1,2}/u;
const SAFE = 1;
const SECURE = 20;

// Line normalization, as Asciidoctor's prepare_source_string: CRLF -> LF,
// leading BOM dropped, and (for AsciiDoc content only) trailing whitespace
// stripped from every line.
export function splitLines(text, { trimEnd = true } = {}) {
  let s = text.replace(/^﻿/, '');
  if (s.includes('\r')) s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/\n$/, '');
  if (s === '') return [];
  const lines = s.split('\n');
  return trimEnd ? lines.map((l) => l.trimEnd()) : lines;
}

function defaultReadInclude(target, fromFile, baseDir) {
  const dir = fromFile && fromFile !== '<stdin>' ? dirname(fromFile) : baseDir;
  const filename = resolve(dir, target);
  try {
    return { filename, text: readFileSync(filename, 'utf8') };
  } catch {
    return null;
  }
}

// SAFE mode and above: an include path may not escape the base directory.
// Asciidoctor "recovers automatically" by re-rooting the path in the jail.
function jailTarget(target, fromFile, baseDir) {
  const dir = fromFile && fromFile !== '<stdin>' ? dirname(fromFile) : baseDir;
  const resolved = resolve(dir, target);
  const jail = resolve(baseDir);
  if (resolved === jail || resolved.startsWith(jail + sep)) return { target, outside: false };
  const segments = relative(jail, resolved)
    .split(sep)
    .filter((s) => s !== '..' && s !== '');
  return { target: resolve(jail, ...segments), outside: true };
}

export function transduce(input, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const readInclude = options.readInclude ?? ((target, fromFile) => defaultReadInclude(target, fromFile, baseDir));
  const safe = safeModeLevel(options.safe ?? 'unsafe');

  const mainFilename = typeof input === 'object' ? input.filename : '<stdin>';
  const mainText = typeof input === 'object' ? input.text : input;

  const attrState = new AttributeState(options.attributes ?? {});
  const maxDepth = parseInt(attrState.get('max-include-depth') ?? '64', 10);

  const ctx = {
    attrState,
    conditionalStack: new ConditionalStack(),
    delimiterStack: new DelimiterStack(),
    diagnostics: [],
    readInclude,
    baseDir,
    safe,
    mainFilename: mainFilename === '<stdin>' ? null : resolve(baseDir, mainFilename),
    maxDepth: maxDepth > 0 ? maxDepth : 0,
    includeChain: [], // resolved filenames of the units currently being expanded
    header: { state: 'pre', implicitAuthor: undefined, implicitAuthors: undefined },
    output: [],
    provenance: [],
  };

  let mainLines = splitLines(mainText);
  if (attrState.has('skip-front-matter')) mainLines = skipFrontMatter(mainLines, ctx, mainFilename);
  while (mainLines.length > 0 && mainLines[mainLines.length - 1] === '') mainLines.pop();

  transduceUnit(
    { filename: mainFilename, path: mainFilename === '<stdin>' ? '<stdin>' : basename(mainFilename), lines: mainLines.map((text, i) => ({ text, lineno: i + 1 })) },
    ctx,
  );
  if (ctx.header.state !== 'done') endHeader(ctx);
  for (const d of ctx.conditionalStack.checkDocumentEnd()) ctx.diagnostics.push({ ...d, file: mainFilename });

  return {
    lines: ctx.output,
    text: ctx.output.join('\n'),
    provenance: ctx.provenance,
    attributes: attrState.snapshot(),
    diagnostics: ctx.diagnostics,
  };
}

function skipFrontMatter(lines, ctx, filename) {
  const delim = lines[0];
  if (delim !== '---' && delim !== '+++') return lines;
  const end = lines.indexOf(delim, 1);
  if (end < 0) return lines;
  ctx.attrState.set('front-matter', lines.slice(1, end).join('\n'));
  ctx.frontMatterOffset = { file: filename, count: end + 1 };
  return lines.slice(end + 1);
}

// unit: { filename, path, lines: [{ text, lineno, synthetic? }] }
function transduceUnit(unit, ctx) {
  const { attrState, conditionalStack, delimiterStack } = ctx;
  const condStart = conditionalStack.markUnitStart();
  let delimStart = delimiterStack.markUnitStart();
  let closedOuter = 0;
  const offset = ctx.frontMatterOffset?.file === unit.filename && ctx.includeChain.length === 0 ? ctx.frontMatterOffset.count : 0;

  const diag = (d, lineno) => ctx.diagnostics.push({ ...d, file: unit.filename, ...(lineno !== undefined ? { line: lineno } : {}) });
  const emit = (text, src) => {
    ctx.output.push(text);
    ctx.provenance.push({ file: unit.filename, line: src.lineno + offset, ...(src.synthetic ? { synthetic: true } : {}) });
  };

  let pending = null; // attr-entry value continuation: { entry, value, continuation }

  const finalizePending = () => {
    applyEntry({ ...pending.entry, value: pending.value }, ctx);
    pending = null;
  };

  const processLine = (text, src) => {
    // Lines suppressed by a false conditional MUST NOT update state and are
    // dropped outright, except that nested conditional directives must
    // still be tracked so the matching endif is found (no look-ahead).
    if (conditionalStack.suppressed) {
      const directive = parseDirectiveLine(text);
      if (directive && !directive.escaped) {
        const result = conditionalStack.process(directive, attrState);
        if (result.kind === 'error') for (const d of result.diagnostics) diag(d, src.lineno);
      }
      return;
    }

    const delimResult = delimiterStack.observe(text);
    if (delimResult.isDelimiterLine) {
      if (delimResult.closed && delimiterStack.depth < delimStart) {
        closedOuter++;
        delimStart = delimiterStack.depth;
      }
      if (ctx.header.state !== 'done' && delimResult.opened && delimiterStack.top.kind !== 'comment') endHeader(ctx);
      emit(text, src);
      return;
    }

    // Directives remain recognized inside opaque regions (write barrier,
    // not a read barrier).
    const directive = parseDirectiveLine(text);
    if (directive) {
      if (directive.escaped) {
        emit(text.slice(1), src);
        return;
      }
      const result = conditionalStack.process(directive, attrState);
      if (result.kind === 'error') for (const d of result.diagnostics) diag(d, src.lineno);
      // Single-line form: the text *replaces* the directive line and is
      // processed as if it had been there (it may itself be a directive,
      // an include, or an attribute entry).
      else if (result.kind === 'inline') processLine(result.text, src);
      return;
    }

    const include = parseIncludeLine(text);
    if (include) {
      if (include.escaped) emit(text.slice(1), src);
      else processInclude(include, text, src, unit, ctx, emit, diag);
      return;
    }

    if (delimiterStack.isOpen) {
      // Opaque region: not scanned for attribute entries or header lines.
      emit(text, src);
      return;
    }

    if (ctx.header.state !== 'done' && processHeaderLine(text, ctx) === 'consumed') {
      emit(text, src);
      return;
    }

    const entry = matchAttrEntryLine(text);
    if (entry) {
      // The entry line stays in the output stream: the parser consumes it
      // too and maintains its own document attribute state (§5).
      emit(text, src);
      if (entry.continuation) pending = { entry, value: entry.value, continuation: entry.continuation };
      else applyEntry(entry, ctx);
      return;
    }

    emit(text, src);
  };

  for (const src of unit.lines) {
    if (pending) {
      const folded = foldContinuationLine(pending.value, pending.continuation, src.text);
      pending.value = folded.value;
      pending.continuation = folded.continuation;
      if (folded.consumed) {
        emit(src.text, src); // continuation lines are part of the entry, never scanned independently
        if (pending.continuation === null) finalizePending();
        continue;
      }
      finalizePending();
    }
    processLine(src.text, src);
  }

  if (pending) finalizePending(); // dangling continuation at unit end: finalize with what was accumulated

  for (const d of conditionalStack.checkUnitEnd(condStart)) diag(d);
  for (const d of delimiterStack.checkUnitEnd(delimStart, closedOuter)) diag(d);
}

// Applies a recognized attribute entry to the transducer's state.
function applyEntry(entry, ctx) {
  const { attrState } = ctx;
  let name = entry.name.toLowerCase();
  if (name === 'numbered') name = 'sectnums';
  else if (name === 'hardbreaks') name = 'hardbreaks-option';
  if (entry.unset) {
    attrState.unset(name);
    return;
  }
  let value = resolveEntryValue(entry.value, attrState);
  if (name === 'leveloffset' && /^[+-]\d+$/.test(value)) {
    const current = parseInt(attrState.get('leveloffset') ?? '0', 10) || 0;
    value = String(current + parseInt(value, 10));
  }
  if (ctx.header.state !== 'done' && applyDerivedHeaderAttribute(name, value, attrState)) return;
  attrState.set(name, value);
}

// The header mini-grammar, driven by a header-mode flag (bounded context).
// Returns 'consumed' when the line was claimed as a header line, or
// 'pass' when it must go through ordinary recognition (attribute entries,
// comments, content) — possibly after header mode ended.
function processHeaderLine(text, ctx) {
  const { header, attrState } = ctx;
  const isComment = text.startsWith('//') && !text.startsWith('///');
  const isEntry = matchAttrEntryLine(text) !== null;

  if (text === '') {
    if (header.state !== 'pre') endHeader(ctx);
    return 'pass';
  }
  if (isComment || isEntry) return 'pass'; // allowed anywhere in the header

  switch (header.state) {
    case 'pre': {
      const m = matchDoctitleLine(text);
      if (!m) {
        endHeader(ctx);
        return 'pass';
      }
      if (!attrState.has('doctitle')) attrState.set('doctitle', m.doctitle);
      header.state = 'author';
      return 'consumed';
    }
    case 'author': {
      const meta = matchAuthorLine(text);
      setImplicit(meta, attrState);
      header.implicitAuthor = attrState.get('author');
      header.implicitAuthors = attrState.get('authors');
      header.state = 'revision';
      return 'consumed';
    }
    case 'revision': {
      const meta = matchRevisionLine(text);
      if (meta) {
        setImplicit(meta, attrState);
        header.state = 'rest';
        return 'consumed';
      }
      endHeader(ctx);
      return 'pass';
    }
    default:
      endHeader(ctx);
      return 'pass';
  }
}

// Implicit header attributes never override an attribute already defined
// (e.g. soft-set through the API), as in Asciidoctor.
function setImplicit(meta, attrState) {
  for (const [name, value] of Object.entries(meta)) if (!attrState.has(name)) attrState.set(name, value);
}

// At the end of the header, an `:author:` / `:authors:` entry that stands
// in for (or overrides) the author line is split into its components.
function endHeader(ctx) {
  const { header, attrState } = ctx;
  if (header.state === 'done') return;
  header.state = 'done';
  let meta = null;
  if (attrState.has('author') && attrState.get('author') !== header.implicitAuthor) {
    meta = processAuthors(attrState.get('author'), { namesOnly: true, multiple: false });
  } else if (attrState.has('authors') && attrState.get('authors') !== header.implicitAuthors) {
    meta = processAuthors(attrState.get('authors'), { namesOnly: true });
  }
  if (meta && meta.authorcount !== '0') for (const [name, value] of Object.entries(meta)) attrState.set(name, value);
}

function processInclude(include, line, src, unit, ctx, emit, diag) {
  const { attrState } = ctx;
  const { target } = include;
  const attrlistText = include.attrlist;
  const unresolved = (t) => emit(`Unresolved directive in ${unit.path} - include::${t}[${attrlistText}]`, src);

  let expandedTarget = target;
  if (target.includes('{')) {
    const policy = attrState.get('attribute-missing') ?? 'skip';
    const mode = policy === 'warn' ? 'drop-line' : policy;
    const r = attrState.substitute(target, mode);
    expandedTarget = r.text ?? '';
    if (expandedTarget === '') {
      const attrs = parseAttrlist(attrState.resolveReferences(attrlistText));
      if ('optional-option' in attrs) {
        diag({ rule: 'include-dropped', severity: 'info', message: `optional include dropped because resolved target is blank: include::${target}[${attrlistText}]` }, src.lineno);
        return;
      }
      if (mode === 'drop-line') {
        diag({ rule: 'include-dropped', severity: 'info', message: `include dropped due to missing attribute: include::${target}[${attrlistText}]` }, src.lineno);
        return;
      }
      diag({ rule: 'include-dropped', severity: 'warning', message: `include dropped because resolved target is blank: include::${target}[${attrlistText}]` }, src.lineno);
      unresolved(target);
      return;
    }
  }

  // §2: attribute references in the directive's attribute list resolve
  // against the transducer state too (lines=, tags=, leveloffset=, ...).
  const attrs = parseAttrlist(attrState.resolveReferences(attrlistText));
  const asLink = () => {
    const lt = expandedTarget.includes(' ') ? `pass:c[${expandedTarget}]` : expandedTarget;
    const la = attrState.has('compat-mode') ? attrlistText : `role=include${attrlistText ? `,${attrlistText}` : ''}`;
    emit(`link:${lt}[${la}]`, src);
  };

  if (ctx.safe >= SECURE) {
    asLink();
    return;
  }

  const isUri = URI_SNIFF.test(expandedTarget);
  if (isUri && !attrState.has('allow-uri-read')) {
    diag({ rule: 'include-uri', severity: 'warning', message: `cannot include contents of URI: ${expandedTarget} (allow-uri-read attribute not enabled)` }, src.lineno);
    asLink();
    return;
  }

  if (ctx.maxDepth === 0) {
    emit(line, src);
    return;
  }
  if (ctx.includeChain.length >= ctx.maxDepth) {
    diag({ rule: 'include-depth', severity: 'error', message: `maximum include depth of ${ctx.maxDepth} exceeded` }, src.lineno);
    emit(line, src);
    return;
  }

  let readTarget = expandedTarget;
  if (!isUri && ctx.safe >= SAFE) {
    const jailed = jailTarget(expandedTarget, unit.filename, ctx.baseDir);
    if (jailed.outside) diag({ rule: 'include-jail', severity: 'warning', message: `include file path is outside of jail; recovering automatically: ${expandedTarget}` }, src.lineno);
    readTarget = jailed.target;
  }

  const fetched = ctx.readInclude(readTarget, unit.filename, attrs);
  if (!fetched) {
    if ('optional-option' in attrs) {
      diag({ rule: 'include-missing', severity: 'info', message: `optional include dropped because include file not found: ${expandedTarget}` }, src.lineno);
      return;
    }
    diag({ rule: 'include-missing', severity: 'error', message: `include file not found: ${expandedTarget}` }, src.lineno);
    unresolved(target);
    return;
  }

  // Cycle detection (by resolved filename). Asciidoctor has none: a cycle
  // recurses until max-include-depth, duplicating the content each time.
  if (ctx.includeChain.includes(fetched.filename) || resolve(ctx.baseDir, fetched.filename) === ctx.mainFilename) {
    diag({ rule: 'include-cycle', severity: 'error', message: `circular include: ${expandedTarget}` }, src.lineno);
    return;
  }

  const asciidoc = isAsciiDocFile(fetched.filename);
  let lines = splitLines(fetched.text, { trimEnd: asciidoc }).map((text, i) => ({ text, lineno: i + 1 }));

  const linenos = 'lines' in attrs && attrs.lines !== '' ? parseLinenos(attrs.lines) : null;
  const tags = linenos ? null : parseTags(attrs);
  if (linenos) {
    lines = filterByLinenos(lines.map((l) => l.text), linenos).lines;
  } else if (tags) {
    const filtered = filterByTags(
      lines.map((l) => l.text),
      tags,
    );
    for (const w of filtered.warnings) diag({ rule: 'include-tags', severity: 'warning', message: `${w} of include file: ${fetched.filename}` }, src.lineno);
    lines = filtered.lines;
  }
  if ('indent' in attrs) adjustIndentation(lines, parseInt(attrs.indent, 10) || 0);
  if (lines.length === 0) return;

  const child = { filename: fetched.filename, path: relative(ctx.baseDir, fetched.filename) || basename(fetched.filename), lines };

  if (!asciidoc) {
    // Non-AsciiDoc content (source code, CSV, ...) is not preprocessed: no
    // directives, no attribute entries, no delimiter tracking (§2).
    for (const l of lines) {
      ctx.output.push(l.text);
      ctx.provenance.push({ file: child.filename, line: l.lineno });
    }
    return;
  }

  // leveloffset=: the included lines are wrapped in synthetic attribute
  // entries, exactly as Asciidoctor does — but only outside opaque regions,
  // where they would otherwise become displayed text.
  if ('leveloffset' in attrs && !ctx.delimiterStack.isOpen) {
    const current = attrState.get('leveloffset');
    const synthetic = (text) => ({ text, lineno: src.lineno, synthetic: true });
    child.lines = [
      synthetic(`:leveloffset: ${attrs.leveloffset}`),
      synthetic(''),
      ...lines,
      synthetic(''),
      synthetic(current ? `:leveloffset: ${current}` : ':leveloffset!:'),
    ];
  }

  ctx.includeChain.push(fetched.filename);
  transduceUnit(child, ctx);
  ctx.includeChain.pop();
}
