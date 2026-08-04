import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateIfeval, IfevalSyntaxError } from '../../src/grammar/ifeval.js';

test('numeric comparisons', () => {
  assert.equal(evaluateIfeval('5 >= 3'), true);
  assert.equal(evaluateIfeval('5 >= 30'), false);
  assert.equal(evaluateIfeval('5 == 5'), true);
  assert.equal(evaluateIfeval('5 != 5'), false);
  assert.equal(evaluateIfeval('2 < 10'), true);
});

test('string comparisons for non-numeric operands', () => {
  assert.equal(evaluateIfeval('"beta" == "beta"'), true);
  assert.equal(evaluateIfeval('"alpha" != "beta"'), true);
  assert.equal(evaluateIfeval("'alpha' < 'beta'"), true);
});

test('unquoted bare tokens are accepted as operands', () => {
  assert.equal(evaluateIfeval('yes == yes'), true);
  assert.equal(evaluateIfeval('yes == no'), false);
});

test('rejects expressions outside the supported comparison subset', () => {
  assert.throws(() => evaluateIfeval('1 + 1'), IfevalSyntaxError);
  assert.throws(() => evaluateIfeval('true'), IfevalSyntaxError);
  assert.throws(() => evaluateIfeval('system("rm -rf /")'), IfevalSyntaxError);
});
