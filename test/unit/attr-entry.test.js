import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchAttrEntryLine } from '../../src/grammar/attr-entry.js';

test('recognizes a simple attr-entry', () => {
  assert.deepEqual(matchAttrEntryLine(':name: value'), { unset: false, name: 'name', value: 'value', wrap: null });
});

test('recognizes an empty-value attr-entry', () => {
  assert.deepEqual(matchAttrEntryLine(':name:'), { unset: false, name: 'name', value: '', wrap: null });
});

test('recognizes prefix-bang unset form', () => {
  assert.deepEqual(matchAttrEntryLine(':!name:'), { unset: true, name: 'name', value: '', wrap: null });
});

test('recognizes suffix-bang unset form', () => {
  assert.deepEqual(matchAttrEntryLine(':name!:'), { unset: true, name: 'name', value: '', wrap: null });
});

test('rejects bang on both sides', () => {
  assert.equal(matchAttrEntryLine(':!name!:'), null);
});

test('name allows word chars and hyphens, not dots or spaces', () => {
  assert.ok(matchAttrEntryLine(':my_attr-1: x'));
  assert.equal(matchAttrEntryLine(':my.attr: x'), null);
  assert.equal(matchAttrEntryLine(':my attr: x'), null);
});

test('name must start with a word character', () => {
  assert.equal(matchAttrEntryLine(':-name: x'), null);
});

test('requires a space (not just adjacency) before the value', () => {
  assert.equal(matchAttrEntryLine(':name:value'), null);
});

test('value is the rest of the line, colons and all: a second ":x:" pair does not start a new entry', () => {
  const m = matchAttrEntryLine(':name: value :other: value2');
  assert.deepEqual(m, { unset: false, name: 'name', value: 'value :other: value2', wrap: null });
});

test('a line that merely resembles an entry mid-sentence does not match without being the whole line', () => {
  assert.equal(matchAttrEntryLine('See :name: value for details'), null);
});

test('soft wrap marker folds with a single space, marker is stripped', () => {
  const m = matchAttrEntryLine(':greeting: Hello \\');
  assert.deepEqual(m, { unset: false, name: 'greeting', value: 'Hello', wrap: 'soft' });
});

test('hard wrap marker folds with a newline and retains the "+"', () => {
  const m = matchAttrEntryLine(':greeting: Hello + \\');
  assert.deepEqual(m, { unset: false, name: 'greeting', value: 'Hello +', wrap: 'hard' });
});
