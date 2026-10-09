// These tests run the *real* Asciidoctor.js (the reference, parser-clocked
// implementation) side by side with this project's stream-clocked
// transducer, on the exact reproducible examples from the proposal's
// Appendix A. They exist to make the divergence claimed by the proposal
// falsifiable rather than asserted: if a future Asciidoctor release closes
// the gap, these tests start failing and say so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as asciidoctor from 'asciidoctor';

import { transduce } from '../../src/transducer.js';

// Appendix A.1: conditional vs. substitution divergence inside a list's
// look-ahead buffering.
const LIST_LOOKAHEAD_SRC = [
  '* first item',
  '+',
  ':flag: yes',
  '+',
  'ifdef::flag[LIST-VISIBLE]',
  '',
  'intervening paragraph',
  '',
  'ifdef::flag[LATER-VISIBLE]',
  '',
  'value: {flag}',
  '',
].join('\n');

test('Appendix A.1 — Asciidoctor (parser-clocked): both conditionals inside the list are dropped, yet {flag} substitutes', async () => {
  const html = await asciidoctor.convert(LIST_LOOKAHEAD_SRC, { safe: 'unsafe' });
  assert.equal(html.includes('LIST-VISIBLE'), false, 'dropped by list look-ahead buffering, per Appendix A.1');
  assert.equal(html.includes('LATER-VISIBLE'), false, 'dropped even past a blank line and an intervening paragraph');
  assert.equal(html.includes('value: yes'), true, 'yet the parser-phase substitution sees the attribute as set');
});

test('Appendix A.1 — the transducer (stream-clocked): both conditionals are kept, consistently with the entry preceding them in the stream', () => {
  const result = transduce(LIST_LOOKAHEAD_SRC);
  assert.ok(result.lines.includes('LIST-VISIBLE'));
  assert.ok(result.lines.includes('LATER-VISIBLE'));
  assert.equal(result.attributes.flag, 'yes');
});

test('Appendix A.1 — the same two lines work in Asciidoctor outside a list (no look-ahead involved)', async () => {
  const src = [':flag: yes', '', 'ifdef::flag[OUTSIDE-LIST-VISIBLE]', ''].join('\n');
  const html = await asciidoctor.convert(src, { safe: 'unsafe' });
  assert.equal(html.includes('OUTSIDE-LIST-VISIBLE'), true, 'same directive, no list buffering: consistent with the transducer everywhere');
});

// Appendix A.3: an attribute entry inside an AsciiDoc table cell is scoped
// to the cell's nested document and never reaches document-level state —
// in Asciidoctor today, and (by construction, via the write-barrier rule
// of §4) in the transducer too.
const TABLE_CELL_SRC = [
  ':docattr: DOC',
  '',
  '|===',
  'a|',
  ':cellattr: CELL',
  '',
  'ifdef::docattr[IFDEF-DOCATTR-VISIBLE]',
  '',
  'ifdef::cellattr[IFDEF-CELLATTR-VISIBLE]',
  '',
  'cell ref: {cellattr}',
  '|===',
  '',
].join('\n');

test('Appendix A.3 — Asciidoctor: a directive in the table reads pre-table state, a cell entry never reaches it, the cell itself substitutes locally', async () => {
  const html = await asciidoctor.convert(TABLE_CELL_SRC, { safe: 'unsafe' });
  assert.ok(html.includes('IFDEF-DOCATTR-VISIBLE'));
  assert.ok(!html.includes('IFDEF-CELLATTR-VISIBLE'));
  assert.ok(html.includes('cell ref: CELL'), 'nested-document substitution at the parser phase');
});

test('Appendix A.3 — the transducer: table opacity (§4) reproduces the same three outcomes at the preprocessor level', () => {
  const result = transduce(TABLE_CELL_SRC);
  assert.ok(result.lines.includes('IFDEF-DOCATTR-VISIBLE'), 'directives read through the opaque region (write barrier, not read barrier)');
  assert.ok(!result.lines.includes('IFDEF-CELLATTR-VISIBLE'), 'a cell entry never updates the document-level attribute state');
  assert.equal(result.attributes.cellattr, undefined);
  assert.ok(
    result.lines.includes('cell ref: {cellattr}'),
    'the transducer does not substitute body text; {cellattr} -> CELL is cell-local, parser-phase work the transducer deliberately leaves undone',
  );
});

// A conforming document (§5): no list buffering, no table cell involved —
// here the two implementations should agree end to end.
test('agreement on a conforming document: transducer output and Asciidoctor rendering are consistent', async () => {
  const src = [':release: 2.0', '', 'ifdef::release[Released: {release}]', ''].join('\n');
  const result = transduce(src);
  // The single-line form emits its text verbatim; {release} is substituted by the parser, as in Asciidoctor.
  assert.deepEqual(result.lines, [':release: 2.0', '', 'Released: {release}']);

  const html = await asciidoctor.convert(src, { safe: 'unsafe' });
  assert.ok(html.includes('Released: 2.0'));
});
