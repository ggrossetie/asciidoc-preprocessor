import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateIfeval, resolveOperand, IfevalSyntaxError } from '../../src/grammar/ifeval.js';
import { AttributeState } from '../../src/attribute-state.js';

const state = (attrs = {}) => {
  const s = new AttributeState();
  for (const [k, v] of Object.entries(attrs)) s.set(k, v);
  return s;
};

test('operand typing follows Asciidoctor (resolve_expr_val)', () => {
  const s = state({ n: '42', v: '1.5', w: 'yes' });
  assert.equal(resolveOperand('"{n}"', s), '42');
  assert.equal(resolveOperand('{n}', s), 42);
  assert.equal(resolveOperand('{v}', s), 1.5);
  assert.equal(resolveOperand('true', s), true);
  assert.equal(resolveOperand('{missing}', s), null, 'missing references are dropped; empty is nil');
  assert.equal(resolveOperand('{w}', s), 0, 'Ruby String#to_i of a word is 0');
  assert.equal(resolveOperand('12abc', s), 12);
});

test('integer comparisons', () => {
  assert.equal(evaluateIfeval('5 >= 3', state()), true);
  assert.equal(evaluateIfeval('5 < 10', state()), true);
  assert.equal(evaluateIfeval('{n} == 5', state({ n: '5' })), true);
});

test('quoted operands compare as strings: "5" < "10" is false', () => {
  assert.equal(evaluateIfeval('"5" < "10"', state()), false);
  assert.equal(evaluateIfeval('"{doctype}" == "book"', state({ doctype: 'book' })), true);
});

test('unquoted words are integers (0), so they all compare equal', () => {
  assert.equal(evaluateIfeval('yes == no', state()), true);
});

test('comparing incompatible types is false, never an error', () => {
  assert.equal(evaluateIfeval('1 < "a"', state()), false);
  assert.equal(evaluateIfeval('{missing} > 1', state()), false);
  assert.equal(evaluateIfeval('true == "true"', state()), false);
  assert.equal(evaluateIfeval('true != "true"', state()), true);
});

test('anything that is not a binary comparison is a syntax error', () => {
  assert.throws(() => evaluateIfeval('true', state()), IfevalSyntaxError);
  assert.throws(() => evaluateIfeval('1 + 1', state()), IfevalSyntaxError);
});

test('no code is ever executed: a "call" is just an operand', () => {
  assert.equal(evaluateIfeval('system("rm -rf /") == 0', state()), true, 'unquoted text is the integer 0');
});
