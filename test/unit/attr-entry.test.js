import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchAttrEntryLine, foldContinuationLine, resolveEntryValue } from '../../src/grammar/attr-entry.js';
import { AttributeState } from '../../src/attribute-state.js';

test('recognizes a simple attr-entry', () => {
  assert.deepEqual(matchAttrEntryLine(':name: value'), { unset: false, name: 'name', value: 'value', continuation: null });
});

test('recognizes an empty-value attr-entry', () => {
  assert.deepEqual(matchAttrEntryLine(':name:'), { unset: false, name: 'name', value: '', continuation: null });
});

test('recognizes prefix-bang and suffix-bang unset forms', () => {
  assert.equal(matchAttrEntryLine(':!name:').unset, true);
  assert.equal(matchAttrEntryLine(':name!:').unset, true);
});

test('rejects bang on both sides', () => {
  assert.equal(matchAttrEntryLine(':!name!:'), null);
});

test('name allows word chars and hyphens, not dots or spaces (spec grammar, stricter than Asciidoctor)', () => {
  assert.ok(matchAttrEntryLine(':my_attr-1: x'));
  assert.ok(matchAttrEntryLine(':café: x'), 'word characters are Unicode-aware, as in Asciidoctor');
  assert.equal(matchAttrEntryLine(':my.attr: x'), null);
  assert.equal(matchAttrEntryLine(':my attr: x'), null);
});

test('name must start with a word character', () => {
  assert.equal(matchAttrEntryLine(':-name: x'), null);
});

test('requires a space (not just adjacency) before the value', () => {
  assert.equal(matchAttrEntryLine(':name:value'), null);
});

test('value is the rest of the line, colons and all', () => {
  assert.equal(matchAttrEntryLine(':name: value :other: value2').value, 'value :other: value2');
});

test('a line that merely resembles an entry mid-sentence does not match', () => {
  assert.equal(matchAttrEntryLine('See :name: value for details'), null);
});

test('soft wrap marker (SP \\) is stripped and recorded', () => {
  assert.deepEqual(matchAttrEntryLine(':greeting: Hello \\'), { unset: false, name: 'greeting', value: 'Hello', continuation: ' \\' });
});

test('hard wrap marker (SP + SP \\) keeps the "+"', () => {
  assert.deepEqual(matchAttrEntryLine(':greeting: Hello + \\'), { unset: false, name: 'greeting', value: 'Hello +', continuation: ' \\' });
});

test('legacy continuation marker (SP +) is recognized, as in Asciidoctor', () => {
  assert.deepEqual(matchAttrEntryLine(':greeting: Hello +'), { unset: false, name: 'greeting', value: 'Hello', continuation: ' +' });
});

test('soft fold joins with a space and drops the continuation line indentation', () => {
  assert.deepEqual(foldContinuationLine('Hello', ' \\', '   World'), { consumed: true, value: 'Hello World', continuation: null });
});

test('hard fold joins with a newline', () => {
  assert.deepEqual(foldContinuationLine('Hello +', ' \\', 'World'), { consumed: true, value: 'Hello +\nWorld', continuation: null });
});

test('the value stays open only while lines repeat the first marker', () => {
  assert.equal(foldContinuationLine('a', ' \\', 'b \\').continuation, ' \\');
  assert.equal(foldContinuationLine('a', ' \\', 'b +').continuation, null);
});

test('an empty line ends the value without being consumed', () => {
  assert.deepEqual(foldContinuationLine('a', ' \\', ''), { consumed: false, value: 'a', continuation: null });
});

test('pass:[] values are unwrapped; references resolve only with the a (attributes) sub', () => {
  const state = new AttributeState();
  state.set('x', 'X');
  assert.equal(resolveEntryValue('pass:[{x} <b>]', state), '{x} <b>');
  assert.equal(resolveEntryValue('pass:a[{x} <b>]', state), 'X <b>');
  assert.equal(resolveEntryValue('{x} <b>', state), 'X <b>');
});
