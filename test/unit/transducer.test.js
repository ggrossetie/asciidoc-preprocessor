import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transduce } from '../../src/transducer.js';

test('worked trace from the proposal (§2): entry, ifdef, entry, endif, include', () => {
  const src = [':a: 1', 'ifdef::a[]', ':b: 2', 'endif::[]', 'include::{b}.adoc[]', ''].join('\n');
  const result = transduce(src, {
    readInclude: (target) => (target === '2.adoc' ? { filename: '2.adoc', text: 'included content\n' } : null),
  });
  assert.deepEqual(result.attributes, { a: '1', b: '2' });
  assert.deepEqual(result.lines, ['included content']);
  assert.deepEqual(result.diagnostics, []);
});

test('worked trace, false branch: skipped entry does not update state and is not emitted', () => {
  const src = [':a: 1', 'ifndef::a[]', ':c: 3', 'endif::[]', ''].join('\n');
  const result = transduce(src);
  assert.deepEqual(result.attributes, { a: '1' });
  assert.deepEqual(result.lines, []);
});

test('§5: for a conforming document, a body entry retargets a subsequent include', () => {
  const src = [':target: two', 'include::{target}.adoc[]', ''].join('\n');
  const files = { 'two.adoc': 'from two\n' };
  const result = transduce(src, { readInclude: (target) => (files[target] ? { filename: target, text: files[target] } : null) });
  assert.deepEqual(result.lines, ['from two']);
});

test('include content is itself transduced (nested attr-entries and conditionals apply)', () => {
  const src = ['include::inc.adoc[]', 'ifdef::fromInclude[VISIBLE]', ''].join('\n');
  const files = { 'inc.adoc': ':fromInclude: yes\n' };
  const result = transduce(src, { readInclude: (target) => (files[target] ? { filename: target, text: files[target] } : null) });
  assert.deepEqual(result.lines, ['VISIBLE']);
});

test('locked attribute (API/CLI, non-soft) cannot be overridden by a body entry', () => {
  const result = transduce(':release: 2.0\n', { attributes: { release: '1.0' } });
  assert.equal(result.attributes.release, '1.0');
});

test('D1 is out of scope for the transducer (needs the block model) but D2/D3 are diagnosed lexically', () => {
  // ifdef's own body is left open too (never reaches a matching endif),
  // and within it a listing is opened and never closed: both are
  // lexically detectable at end of unit.
  const result = transduce([':x: 1', 'ifdef::x[]', '----', 'foo', ''].join('\n'));
  const rules = result.diagnostics.map((d) => d.rule).sort();
  assert.deepEqual(rules, ['D2', 'D3']);
});

test('opaque region (§4): attribute-entry-shaped text inside a listing is not recognized, passes through unchanged', () => {
  const src = ['----', ':inside: nope', '----', 'ifdef::inside[SHOULD-NOT-APPEAR]', ''].join('\n');
  const result = transduce(src);
  assert.equal(result.attributes.inside, undefined);
  assert.deepEqual(result.lines, ['----', ':inside: nope', '----']);
});

test('opaque region (§4): directives remain recognized inside a listing and resolve against pre-region state', () => {
  const src = [':docattr: DOC', '----', 'ifdef::docattr[SEEN-INSIDE-LISTING]', '----', ''].join('\n');
  const result = transduce(src);
  assert.deepEqual(result.lines, ['----', 'SEEN-INSIDE-LISTING', '----']);
});

test('opaque region (§4): an include inside a listing is still expanded (textual snippet inclusion keeps working)', () => {
  const src = ['----', 'include::snippet.adoc[]', '----', ''].join('\n');
  const files = { 'snippet.adoc': 'const x = 1;\n' };
  const result = transduce(src, { readInclude: (target) => (files[target] ? { filename: target, text: files[target] } : null) });
  assert.deepEqual(result.lines, ['----', 'const x = 1;', '----']);
});

test('Appendix A.3: attribute entry inside a table cell never reaches document-level state', () => {
  const src = [':docattr: DOC', '', '|===', 'a|', ':cellattr: CELL', '', 'ifdef::docattr[IFDEF-DOCATTR-VISIBLE]', '', 'ifdef::cellattr[IFDEF-CELLATTR-VISIBLE]', '', 'cell ref: {cellattr}', '|===', ''].join('\n');
  const result = transduce(src);
  assert.equal(result.attributes.cellattr, undefined);
  assert.ok(result.lines.includes('IFDEF-DOCATTR-VISIBLE'), 'a directive inside the table reads pre-table state');
  assert.ok(!result.lines.includes('IFDEF-CELLATTR-VISIBLE'), 'an entry inside the cell never reaches the document state');
  assert.ok(result.lines.includes('cell ref: {cellattr}'), 'the preprocessor does not do body substitution; that is cell-local, parser-phase work');
});

test('header mini-grammar: doctitle/author/revision lines assign implicit attributes and are still emitted', () => {
  const src = ['= My Document', 'Jane Doe <jane@example.com>', 'v1.0, 2024-01-01', '', 'body text', ''].join('\n');
  const result = transduce(src);
  assert.equal(result.attributes.doctitle, 'My Document');
  assert.equal(result.attributes.author, 'Jane Doe');
  assert.equal(result.attributes.email, 'jane@example.com');
  assert.equal(result.attributes.revnumber, '1.0');
  assert.deepEqual(result.lines, src.split('\n').slice(0, -1));
});

test('header mode ends at the first non-header-shaped line; that line is then tried as ordinary content', () => {
  const src = ['= My Document', ':custom: value', ''].join('\n');
  const result = transduce(src);
  assert.equal(result.attributes.doctitle, 'My Document');
  assert.equal(result.attributes.custom, 'value'); // recognized as attr-entry, not as an author line
  assert.deepEqual(result.lines, ['= My Document']);
});

test('provenance maps each output line back to its source file and line, across an include', () => {
  const src = ['before', 'include::inc.adoc[]', 'after', ''].join('\n');
  const files = { 'inc.adoc': 'first\nsecond\n' };
  const result = transduce(
    { filename: 'main.adoc', text: src },
    { readInclude: (target) => (files[target] ? { filename: target, text: files[target] } : null) },
  );
  assert.deepEqual(result.lines, ['before', 'first', 'second', 'after']);
  assert.deepEqual(result.provenance, [
    { file: 'main.adoc', line: 1 },
    { file: 'inc.adoc', line: 1 },
    { file: 'inc.adoc', line: 2 },
    { file: 'main.adoc', line: 3 },
  ]);
});

test('a circular include is diagnosed and does not hang', () => {
  const files = { 'a.adoc': 'include::b.adoc[]\n', 'b.adoc': 'include::a.adoc[]\n' };
  const result = transduce(
    { filename: 'a.adoc', text: files['a.adoc'] },
    { readInclude: (target) => (files[target] ? { filename: target, text: files[target] } : null) },
  );
  assert.ok(result.diagnostics.some((d) => d.rule === 'include-cycle'));
});

test('an unresolved include target is diagnosed and leaves a placeholder line', () => {
  const result = transduce('include::missing.adoc[]\n', { readInclude: () => null });
  assert.equal(result.diagnostics[0].rule, 'include-missing');
  assert.ok(result.lines[0].includes('missing.adoc'));
});
