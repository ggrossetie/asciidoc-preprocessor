// The stream-clocked line transducer: an independent preprocessing stage
// that consumes a source line stream and emits an output line stream plus
// a provenance map (output line -> source file and line). It maintains
// its own attribute state and never consults a parser; no information
// flows back into it. See README.md for the full model.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AttributeState } from './attribute-state.js';
import { matchAttrEntryLine, foldContinuationLine } from './grammar/attr-entry.js';
import { matchDoctitleLine, matchAuthorLine, matchRevisionLine } from './grammar/header.js';
import { DelimiterStack } from './grammar/delimiters.js';
import { ConditionalStack, parseDirectiveLine } from './grammar/conditionals.js';
import { parseIncludeLine } from './grammar/include.js';

function splitLines(text) {
  const withoutTrailingNewline = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return withoutTrailingNewline === '' ? [] : withoutTrailingNewline.split('\n');
}

function defaultReadInclude(target, fromFile, baseDir) {
  const dir = fromFile ? dirname(fromFile) : baseDir;
  const filename = resolve(dir, target);
  try {
    return { filename, text: readFileSync(filename, 'utf8') };
  } catch {
    return null;
  }
}

class Unit {
  constructor(filename, lines) {
    this.filename = filename;
    this.lines = lines;
  }
}

export function transduce(input, options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const readInclude = options.readInclude ?? ((target, fromFile) => defaultReadInclude(target, fromFile, baseDir));

  const mainFilename = typeof input === 'object' ? input.filename : '<stdin>';
  const mainText = typeof input === 'object' ? input.text : input;

  const ctx = {
    attrState: new AttributeState(options.attributes ?? {}),
    conditionalStack: new ConditionalStack(),
    delimiterStack: new DelimiterStack(),
    diagnostics: [],
    readInclude,
    includeChain: new Set(),
    headerState: 'expect-title', // 'expect-title' -> 'expect-author' -> 'expect-revision' -> 'done'
  };

  const outputLines = [];
  const provenance = [];
  transduceUnit(new Unit(mainFilename, splitLines(mainText)), ctx, outputLines, provenance);

  return {
    lines: outputLines,
    text: outputLines.join('\n'),
    provenance,
    attributes: ctx.attrState.snapshot(),
    diagnostics: ctx.diagnostics,
  };
}

function transduceUnit(unit, ctx, outputLines, provenance) {
  const condStart = ctx.conditionalStack.markUnitStart();
  const delimStart = ctx.delimiterStack.markUnitStart();

  const emit = (text, lineNo) => {
    outputLines.push(text);
    provenance.push({ file: unit.filename, line: lineNo });
  };

  let pending = null; // in-progress attr-entry value continuation: { unset, name, value, wrap }

  const finalizePending = () => {
    const resolved = ctx.attrState.resolveReferences(pending.value);
    if (pending.unset) ctx.attrState.unset(pending.name);
    else ctx.attrState.set(pending.name, resolved);
    pending = null;
  };

  for (let i = 0; i < unit.lines.length; i++) {
    const rawLine = unit.lines[i];
    const lineNo = i + 1;

    if (pending) {
      const folded = foldContinuationLine(pending.value, pending.wrap, rawLine);
      pending.value = folded.value;
      pending.wrap = folded.wrap;
      if (pending.wrap === null) finalizePending();
      continue; // continuation lines are consumed as part of the entry, never scanned independently
    }

    // Lines suppressed by a false conditional MUST NOT update state and are
    // dropped outright, except that nested conditional directives must
    // still be tracked so the matching endif is found (no look-ahead).
    if (ctx.conditionalStack.suppressed) {
      const directive = parseDirectiveLine(rawLine);
      if (directive) {
        const result = ctx.conditionalStack.process(directive, ctx.attrState);
        if (result.kind === 'error') for (const d of result.diagnostics) ctx.diagnostics.push({ ...d, file: unit.filename, line: lineNo });
      }
      continue;
    }

    const delimResult = ctx.delimiterStack.observe(rawLine);
    if (delimResult.isDelimiterLine) {
      emit(rawLine, lineNo);
      continue;
    }

    // Directives remain recognized inside opaque regions (write barrier,
    // not a read barrier).
    const directive = parseDirectiveLine(rawLine);
    if (directive) {
      const result = ctx.conditionalStack.process(directive, ctx.attrState);
      if (result.kind === 'error') {
        for (const d of result.diagnostics) ctx.diagnostics.push({ ...d, file: unit.filename, line: lineNo });
      } else if (result.kind === 'inline') {
        emit(result.text, lineNo);
      }
      continue; // 'block' / 'inline-drop' consumed with no emission
    }

    const include = parseIncludeLine(rawLine);
    if (include) {
      const target = ctx.attrState.resolveReferences(include.target);
      if (ctx.includeChain.has(target)) {
        ctx.diagnostics.push({ rule: 'include-cycle', message: `circular include: ${target}`, file: unit.filename, line: lineNo });
        continue;
      }
      const fetched = ctx.readInclude(target, unit.filename);
      if (!fetched) {
        ctx.diagnostics.push({ rule: 'include-missing', message: `unresolved include target: ${target}`, file: unit.filename, line: lineNo });
        emit(`Unresolved directive in ${unit.filename} - include::${target}[]`, lineNo);
        continue;
      }
      ctx.includeChain.add(target);
      transduceUnit(new Unit(fetched.filename, splitLines(fetched.text)), ctx, outputLines, provenance);
      ctx.includeChain.delete(target);
      continue;
    }

    if (ctx.delimiterStack.isOpen) {
      // Opaque region: not scanned for attribute entries or header lines.
      emit(rawLine, lineNo);
      continue;
    }

    if (ctx.headerState !== 'done') {
      const handled = tryHeaderLine(rawLine, ctx);
      if (handled === 'blank') {
        ctx.headerState = 'done';
        emit(rawLine, lineNo);
        continue;
      }
      if (handled) {
        emit(rawLine, lineNo);
        continue;
      }
      // Not header-shaped: header mode ends, this line falls through to
      // ordinary attr-entry / content recognition below.
      ctx.headerState = 'done';
    }

    const entry = matchAttrEntryLine(rawLine);
    if (entry) {
      if (entry.wrap === null) {
        const resolved = ctx.attrState.resolveReferences(entry.value);
        if (entry.unset) ctx.attrState.unset(entry.name);
        else ctx.attrState.set(entry.name, resolved);
      } else {
        pending = { unset: entry.unset, name: entry.name, value: entry.value, wrap: entry.wrap };
      }
      continue; // attribute entry lines are consumed, never emitted
    }

    emit(rawLine, lineNo);
  }

  if (pending) finalizePending(); // dangling continuation at unit end: finalize with what was accumulated

  for (const d of ctx.conditionalStack.checkUnitEnd(condStart)) ctx.diagnostics.push({ ...d, file: unit.filename });
  for (const d of ctx.delimiterStack.checkUnitEnd(delimStart)) ctx.diagnostics.push({ ...d, file: unit.filename });
}

// Returns 'blank' (header ends here), true (line consumed as a header
// line, state advanced), or false (not header-shaped at the current slot).
function tryHeaderLine(line, ctx) {
  if (line.trim() === '') return 'blank';

  if (ctx.headerState === 'expect-title') {
    const m = matchDoctitleLine(line);
    if (!m) return false;
    if (!ctx.attrState.isLocked('doctitle')) ctx.attrState.set('doctitle', m.doctitle);
    ctx.headerState = 'expect-author';
    return true;
  }

  if (ctx.headerState === 'expect-author') {
    const m = matchAuthorLine(line);
    if (!m) return false;
    for (const [name, value] of Object.entries(m)) {
      if (!ctx.attrState.isLocked(name)) ctx.attrState.set(name, value);
    }
    ctx.headerState = 'expect-revision';
    return true;
  }

  if (ctx.headerState === 'expect-revision') {
    const m = matchRevisionLine(line);
    if (!m) return false;
    for (const [name, value] of Object.entries(m)) {
      if (!ctx.attrState.isLocked(name)) ctx.attrState.set(name, value);
    }
    ctx.headerState = 'done';
    return true;
  }

  return false;
}
