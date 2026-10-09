import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transduce } from '../../src/transducer.js';
import { intrinsicAttributes } from '../../src/intrinsic-attributes.js';

const lines = (...l) => [...l, ''].join('\n');
const fs = (files) => (target) => (target in files ? { filename: target, text: files[target] } : null);

test('worked trace from the proposal (§2): entry, ifdef, entry, endif, include', () => {
  const result = transduce(lines(':a: 1', 'ifdef::a[]', ':b: 2', 'endif::[]', 'include::{b}.adoc[]'), {
    readInclude: fs({ '2.adoc': 'included content\n' }),
  });
  assert.deepEqual(result.attributes, { a: '1', b: '2' });
  assert.deepEqual(result.lines, [':a: 1', ':b: 2', 'included content'], 'entry lines stay in the stream for the parser (§5)');
  assert.deepEqual(result.diagnostics, []);
});

test('worked trace, false branch: skipped entry does not update state and is not emitted', () => {
  const result = transduce(lines(':a: 1', 'ifndef::a[]', ':c: 3', 'endif::[]'));
  assert.deepEqual(result.attributes, { a: '1' });
  assert.deepEqual(result.lines, [':a: 1']);
});

test('§5: for a conforming document, a body entry retargets a subsequent include', () => {
  const result = transduce(lines(':target: two', 'include::{target}.adoc[]'), { readInclude: fs({ 'two.adoc': 'from two\n' }) });
  assert.deepEqual(result.lines, [':target: two', 'from two']);
});

test('include content is itself transduced (nested attr-entries and conditionals apply)', () => {
  const result = transduce(lines('include::inc.adoc[]', 'ifdef::fromInclude[VISIBLE]'), { readInclude: fs({ 'inc.adoc': ':fromInclude: yes\n' }) });
  assert.deepEqual(result.lines, [':fromInclude: yes', 'VISIBLE']);
});

test('locked attribute (API/CLI, non-soft) cannot be overridden by a body entry', () => {
  const result = transduce(':release: 2.0\n', { attributes: { release: '1.0' } });
  assert.equal(result.attributes.release, '1.0');
});

test('D2/D3 are diagnosed lexically at end of unit; unterminated conditionals also at end of document', () => {
  const result = transduce(lines(':x: 1', 'ifdef::x[]', '----', 'foo'));
  const rules = result.diagnostics.map((d) => d.rule).sort();
  assert.deepEqual(rules, ['D2', 'D3', 'unterminated-conditional']);
});

test('D3: an include unit closing a block it did not open is diagnosed', () => {
  const result = transduce(lines('include::open.adoc[]', 'body', 'include::close.adoc[]'), {
    readInclude: fs({ 'open.adoc': '----\n', 'close.adoc': '----\n' }),
  });
  assert.equal(result.diagnostics.filter((d) => d.rule === 'D3').length, 2);
  assert.deepEqual(result.lines, ['----', 'body', '----'], 'output is unaffected (the transducer is total)');
});

test('opaque region (§4): attribute-entry-shaped text inside a listing is not recognized, passes through unchanged', () => {
  const result = transduce(lines('----', ':inside: nope', '----', 'ifdef::inside[SHOULD-NOT-APPEAR]'));
  assert.equal(result.attributes.inside, undefined);
  assert.deepEqual(result.lines, ['----', ':inside: nope', '----']);
});

test('opaque region (§4): directives remain recognized inside a listing and resolve against pre-region state', () => {
  const result = transduce(lines(':docattr: DOC', '----', 'ifdef::docattr[SEEN-INSIDE-LISTING]', '----'));
  assert.deepEqual(result.lines, [':docattr: DOC', '----', 'SEEN-INSIDE-LISTING', '----']);
});

test('opaque region (§4): an include inside a listing is still expanded', () => {
  const result = transduce(lines('----', 'include::snippet.js[]', '----'), { readInclude: fs({ 'snippet.js': 'const x = 1;\n' }) });
  assert.deepEqual(result.lines, ['----', 'const x = 1;', '----']);
});

test('opaque region: passthrough and fenced blocks', () => {
  const result = transduce(lines('++++', ':p: 1', '++++', '```', ':f: 1', '```'));
  assert.deepEqual(result.attributes, {});
});

test('Appendix A.3: attribute entry inside a table cell never reaches document-level state', () => {
  const src = lines(':docattr: DOC', '', '|===', 'a|', ':cellattr: CELL', '', 'ifdef::docattr[IFDEF-DOCATTR-VISIBLE]', '', 'ifdef::cellattr[IFDEF-CELLATTR-VISIBLE]', '', 'cell ref: {cellattr}', '|===');
  const result = transduce(src);
  assert.equal(result.attributes.cellattr, undefined);
  assert.ok(result.lines.includes('IFDEF-DOCATTR-VISIBLE'));
  assert.ok(!result.lines.includes('IFDEF-CELLATTR-VISIBLE'));
  assert.ok(result.lines.includes('cell ref: {cellattr}'));
});

test('header mini-grammar: doctitle/author/revision lines assign implicit attributes and are still emitted', () => {
  const src = lines('= My Document', 'Jane Doe <jane@example.com>', 'v1.0, 2024-01-01', '', 'body text');
  const result = transduce(src);
  assert.equal(result.attributes.doctitle, 'My Document');
  assert.equal(result.attributes.author, 'Jane Doe');
  assert.equal(result.attributes.email, 'jane@example.com');
  assert.equal(result.attributes.revnumber, '1.0');
  assert.deepEqual(result.lines, src.split('\n').slice(0, -1));
});

test('header: entries and comments may precede the doctitle and sit between header lines', () => {
  const result = transduce(lines(':toc:', '// comment', '', '= Title', ':x: 1', 'Jane Doe', 'v2.0', ':y: 2', '', 'Not an author'));
  assert.equal(result.attributes.doctitle, 'Title');
  assert.equal(result.attributes.author, 'Jane Doe');
  assert.equal(result.attributes.revnumber, '2.0');
  assert.equal(result.attributes.y, '2');
});

test('header: an :author: entry is split into its components at the end of the header', () => {
  const result = transduce(lines('= Title', ':author: Jane Q. Doe', '', 'body'));
  assert.equal(result.attributes.lastname, 'Doe');
  assert.equal(result.attributes.authorinitials, 'JQD');
});

test('header: implicit attributes do not override attributes already defined', () => {
  const result = transduce(lines('= Title', 'Jane Doe'), { attributes: { author: { value: 'API Author', soft: true } } });
  assert.equal(result.attributes.author, 'API Author');
});

test('intrinsic attributes: backend/doctype/safe-mode attributes are seedable and derived ones follow header entries', () => {
  const result = transduce(
    lines('= Title', ':doctype: book', '', 'ifdef::doctype-book[BOOK]', 'ifdef::doctype-article[ARTICLE]', 'ifdef::basebackend-html[HTML]', 'ifdef::backend-html5-doctype-book[COMBO]'),
    { attributes: intrinsicAttributes() },
  );
  assert.deepEqual(result.lines.slice(-3), ['BOOK', 'HTML', 'COMBO']);
});

test('escaped directives are emitted without the backslash and not evaluated', () => {
  const result = transduce(lines('\\ifdef::x[]', '\\include::foo.adoc[]', '\\endif::[]'));
  assert.deepEqual(result.lines, ['ifdef::x[]', 'include::foo.adoc[]', 'endif::[]']);
  assert.deepEqual(result.diagnostics, []);
});

test('single-line ifdef: the replacement text is processed as a line of its own', () => {
  const result = transduce(lines(':x: 1', 'ifdef::x[include::inc.adoc[]]', 'ifdef::x[:y: 2]', 'ifdef::y[Y-DEFINED]'), {
    readInclude: fs({ 'inc.adoc': 'INCLUDED\n' }),
  });
  assert.deepEqual(result.lines, [':x: 1', 'INCLUDED', ':y: 2', 'Y-DEFINED']);
});

test('trailing whitespace is stripped from AsciiDoc lines (delimiters still match)', () => {
  const result = transduce('----   \n:in: x\n----\n');
  assert.equal(result.attributes.in, undefined);
  assert.deepEqual(result.lines, ['----', ':in: x', '----']);
});

test('value continuation: entry and continuation lines are emitted, the value is folded', () => {
  const result = transduce(lines(':long: first \\', '  second', 'after'));
  assert.equal(result.attributes.long, 'first second');
  assert.deepEqual(result.lines, [':long: first \\', '  second', 'after']);
});

test('include: lines= selects lines and keeps their true provenance', () => {
  const result = transduce(
    { filename: 'main.adoc', text: 'include::src.adoc[lines=2;4..5]\n' },
    { readInclude: fs({ 'src.adoc': 'l1\nl2\nl3\nl4\nl5\nl6\n' }) },
  );
  assert.deepEqual(result.lines, ['l2', 'l4', 'l5']);
  assert.deepEqual(
    result.provenance.map((p) => p.line),
    [2, 4, 5],
  );
});

test('include: tags= selects tagged regions, tag lines are never included', () => {
  const src = '// tag::a[]\nA\n// end::a[]\n// tag::b[]\nB\n// end::b[]\nC\n';
  const read = fs({ 'x.rb': src });
  assert.deepEqual(transduce('include::x.rb[tag=a]\n', { readInclude: read }).lines, ['A']);
  assert.deepEqual(transduce('include::x.rb[tags=a;b]\n', { readInclude: read }).lines, ['A', 'B']);
  assert.deepEqual(transduce('include::x.rb[tags=**;!b]\n', { readInclude: read }).lines, ['A', 'C']);
  assert.deepEqual(transduce('include::x.rb[tags=*]\n', { readInclude: read }).lines, ['A', 'B']);
});

test('include: indent= re-indents the included lines', () => {
  const result = transduce('include::x.py[indent=2]\n', { readInclude: fs({ 'x.py': '    def f():\n        pass\n' }) });
  assert.deepEqual(result.lines, ['  def f():', '      pass']);
});

test('include: leveloffset= wraps the content in synthetic entries (outside opaque regions only)', () => {
  const result = transduce(lines('include::ch.adoc[leveloffset=+1]'), { readInclude: fs({ 'ch.adoc': '= Chapter\n' }) });
  assert.deepEqual(result.lines, [':leveloffset: +1', '', '= Chapter', '', ':leveloffset!:']);
  assert.equal(result.attributes.leveloffset, undefined, 'restored after the include');
});

test('include: non-AsciiDoc content is not preprocessed', () => {
  const result = transduce('include::x.rb[]\n', { readInclude: fs({ 'x.rb': ':a: 1\nifdef::a[]\n' }) });
  assert.deepEqual(result.lines, [':a: 1', 'ifdef::a[]']);
  assert.equal(result.attributes.a, undefined);
});

test('include: opts=optional drops a missing include silently', () => {
  const result = transduce('include::missing.adoc[opts=optional]\n', { readInclude: () => null });
  assert.deepEqual(result.lines, []);
  assert.equal(result.diagnostics[0].severity, 'info');
});

test('include: an unresolved target leaves the Asciidoctor placeholder line', () => {
  const result = transduce({ filename: 'main.adoc', text: 'include::missing.adoc[]\n' }, { readInclude: () => null });
  assert.equal(result.diagnostics[0].rule, 'include-missing');
  assert.deepEqual(result.lines, ['Unresolved directive in main.adoc - include::missing.adoc[]']);
});

test('include: attribute-missing=drop-line drops an include whose target references a missing attribute', () => {
  const result = transduce(lines(':attribute-missing: drop-line', 'include::{nope}/a.adoc[]', 'after'), { readInclude: () => null });
  assert.deepEqual(result.lines, [':attribute-missing: drop-line', 'after']);
});

test('include: secure safe mode turns includes into links', () => {
  const result = transduce('include::chapter.adoc[]\n', { safe: 'secure' });
  assert.deepEqual(result.lines, ['link:chapter.adoc[role=include]']);
});

test('include: URIs need allow-uri-read', () => {
  const result = transduce('include::https://example.org/a.adoc[]\n');
  assert.deepEqual(result.lines, ['link:https://example.org/a.adoc[role=include]']);
});

test('include: max-include-depth is enforced', () => {
  const result = transduce('include::a.adoc[]\n', {
    attributes: { 'max-include-depth': '1' },
    readInclude: fs({ 'a.adoc': 'include::b.adoc[]\n', 'b.adoc': 'B\n' }),
  });
  assert.deepEqual(result.lines, ['include::b.adoc[]']);
  assert.equal(result.diagnostics[0].rule, 'include-depth');
});

test('provenance maps each output line back to its source file and line, across an include', () => {
  const result = transduce({ filename: 'main.adoc', text: lines('before', 'include::inc.adoc[]', 'after') }, { readInclude: fs({ 'inc.adoc': 'first\nsecond\n' }) });
  assert.deepEqual(result.lines, ['before', 'first', 'second', 'after']);
  assert.deepEqual(result.provenance, [
    { file: 'main.adoc', line: 1 },
    { file: 'inc.adoc', line: 1 },
    { file: 'inc.adoc', line: 2 },
    { file: 'main.adoc', line: 3 },
  ]);
});

test('front matter is skipped when skip-front-matter is set, and provenance accounts for it', () => {
  const result = transduce({ filename: 'm.adoc', text: lines('---', 'title: x', '---', 'body') }, { attributes: { 'skip-front-matter': '' } });
  assert.deepEqual(result.lines, ['body']);
  assert.equal(result.attributes['front-matter'], 'title: x');
  assert.deepEqual(result.provenance, [{ file: 'm.adoc', line: 4 }]);
});

test('a circular include is diagnosed and does not hang', () => {
  const files = { 'a.adoc': 'include::b.adoc[]\n', 'b.adoc': 'include::a.adoc[]\n' };
  const result = transduce({ filename: 'a.adoc', text: files['a.adoc'] }, { readInclude: fs(files) });
  assert.ok(result.diagnostics.some((d) => d.rule === 'include-cycle'));
});

test('comment region (§4): inert — no directive is evaluated, lines are emitted verbatim', () => {
  const result = transduce(lines('////', 'ifdef::nope[]', 'include::missing.adoc[]', '\\ifdef::x[]', ':c: 1', '////', '', 'AFTER'), { readInclude: () => null });
  assert.deepEqual(result.lines, ['////', 'ifdef::nope[]', 'include::missing.adoc[]', '\\ifdef::x[]', ':c: 1', '////', '', 'AFTER']);
  assert.deepEqual(result.diagnostics, [], 'no unbalanced conditional, no include read attempt');
  assert.equal(result.attributes.c, undefined);
});

test('comment region (§4): a conditional around a comment block still applies to it as a whole', () => {
  const result = transduce(lines('ifdef::nope[]', '////', 'hidden comment', '////', 'endif::[]', 'AFTER'));
  assert.deepEqual(result.lines, ['AFTER']);
});
