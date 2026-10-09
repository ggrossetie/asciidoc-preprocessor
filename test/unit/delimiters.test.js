import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DelimiterStack } from '../../src/grammar/delimiters.js';

test('opens and closes a listing block', () => {
  const stack = new DelimiterStack();
  assert.equal(stack.isOpen, false);
  assert.deepEqual(stack.observe('----'), { isDelimiterLine: true, opened: true, closed: false });
  assert.equal(stack.isOpen, true);
  assert.deepEqual(stack.observe('some code'), { isDelimiterLine: false, opened: false, closed: false });
  assert.deepEqual(stack.observe('----'), { isDelimiterLine: true, opened: false, closed: true });
  assert.equal(stack.isOpen, false);
});

test('closing marker must match the opening marker exactly (length matters)', () => {
  const stack = new DelimiterStack();
  stack.observe('-----'); // 5 dashes
  assert.deepEqual(stack.observe('----'), { isDelimiterLine: false, opened: false, closed: false }); // 4 dashes: not a close
  assert.equal(stack.isOpen, true);
  assert.deepEqual(stack.observe('-----'), { isDelimiterLine: true, opened: false, closed: true });
});

test('a delimiter-shaped line inside an open region of a different kind is inert content, not a nested open', () => {
  const stack = new DelimiterStack();
  stack.observe('----'); // open listing
  assert.deepEqual(stack.observe('|==='), { isDelimiterLine: false, opened: false, closed: false });
  assert.equal(stack.depth, 1);
  stack.observe('----'); // close listing
  assert.equal(stack.isOpen, false);
});

test('table delimiters open and close', () => {
  const stack = new DelimiterStack();
  stack.observe('|===');
  assert.equal(stack.isOpen, true);
  stack.observe('|===');
  assert.equal(stack.isOpen, false);
});

test('D3: markUnitStart/checkUnitEnd detect an unbalanced unit', () => {
  const stack = new DelimiterStack();
  const start = stack.markUnitStart();
  stack.observe('----');
  const diagnostics = stack.checkUnitEnd(start);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, 'D3');
});

test('D3: a balanced unit reports no diagnostics', () => {
  const stack = new DelimiterStack();
  const start = stack.markUnitStart();
  stack.observe('----');
  stack.observe('----');
  assert.deepEqual(stack.checkUnitEnd(start), []);
});

test('table delimiters may have more than three "="', () => {
  const stack = new DelimiterStack();
  stack.observe('|=====');
  assert.equal(stack.isOpen, true);
  stack.observe('|===');
  assert.equal(stack.isOpen, true, 'closer must match exactly');
  stack.observe('|=====');
  assert.equal(stack.isOpen, false);
});

test('fenced code (```lang) is a verbatim region closed by a bare ```', () => {
  const stack = new DelimiterStack();
  stack.observe('```ruby');
  assert.equal(stack.top.kind, 'verbatim');
  stack.observe('```');
  assert.equal(stack.isOpen, false);
});

test('passthrough (++++) is opaque', () => {
  const stack = new DelimiterStack();
  stack.observe('++++');
  assert.equal(stack.top.kind, 'passthrough');
});

test('D3: a unit closing a block it did not open is reported', () => {
  const stack = new DelimiterStack();
  assert.equal(stack.checkUnitEnd(0, 1)[0].rule, 'D3');
});
