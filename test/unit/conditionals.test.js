import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConditionalStack, parseDirectiveLine } from '../../src/grammar/conditionals.js';
import { AttributeState } from '../../src/attribute-state.js';

test('parseDirectiveLine recognizes all four directive types', () => {
  assert.deepEqual(parseDirectiveLine('ifdef::flag[]'), { type: 'ifdef', target: 'flag', content: '' });
  assert.deepEqual(parseDirectiveLine('ifndef::flag[]'), { type: 'ifndef', target: 'flag', content: '' });
  assert.deepEqual(parseDirectiveLine('ifeval::[{n} > 1]'), { type: 'ifeval', target: '', content: '{n} > 1' });
  assert.deepEqual(parseDirectiveLine('endif::[]'), { type: 'endif', target: '', content: '' });
  assert.deepEqual(parseDirectiveLine('ifdef::flag[Some Text]'), { type: 'ifdef', target: 'flag', content: 'Some Text' });
});

test('parseDirectiveLine rejects non-directive lines', () => {
  assert.equal(parseDirectiveLine('This is ifdef-like but not a directive'), null);
  assert.equal(parseDirectiveLine('ifdef::flag'), null); // missing brackets
});

test('block-form ifdef pushes a frame and suppresses the false branch', () => {
  const state = new AttributeState();
  const stack = new ConditionalStack();
  const r1 = stack.process(parseDirectiveLine('ifdef::flag[]'), state);
  assert.equal(r1.kind, 'block');
  assert.equal(stack.suppressed, true); // flag is not defined
  const r2 = stack.process(parseDirectiveLine('endif::[]'), state);
  assert.equal(r2.kind, 'block');
  assert.equal(stack.suppressed, false);
});

test('ifdef true when the attribute is defined', () => {
  const state = new AttributeState();
  state.set('flag', 'yes');
  const stack = new ConditionalStack();
  stack.process(parseDirectiveLine('ifdef::flag[]'), state);
  assert.equal(stack.suppressed, false);
});

test('ifndef inverts ifdef', () => {
  const state = new AttributeState();
  const stack = new ConditionalStack();
  stack.process(parseDirectiveLine('ifndef::flag[]'), state);
  assert.equal(stack.suppressed, false); // flag undefined -> ifndef holds
});

test('single-line form emits inline text without pushing a frame', () => {
  const state = new AttributeState();
  state.set('flag', 'yes');
  const stack = new ConditionalStack();
  const r = stack.process(parseDirectiveLine('ifdef::flag[LIST-VISIBLE]'), state);
  assert.deepEqual(r, { kind: 'inline', text: 'LIST-VISIBLE' });
  assert.equal(stack.depth, 0);
});

test('single-line form drops when condition is false', () => {
  const state = new AttributeState();
  const stack = new ConditionalStack();
  const r = stack.process(parseDirectiveLine('ifdef::flag[LIST-VISIBLE]'), state);
  assert.deepEqual(r, { kind: 'inline-drop' });
});

test('single-line form resolves attribute references in its text', () => {
  const state = new AttributeState();
  state.set('flag', 'yes');
  state.set('name', 'World');
  const stack = new ConditionalStack();
  const r = stack.process(parseDirectiveLine('ifdef::flag[Hello, {name}!]'), state);
  assert.deepEqual(r, { kind: 'inline', text: 'Hello, World!' });
});

test('"," is OR and "+" is AND for multiple names', () => {
  const state = new AttributeState();
  state.set('a', '1');
  const stack = new ConditionalStack();

  const or = stack.process(parseDirectiveLine('ifdef::a,b[TEXT]'), state);
  assert.equal(or.kind, 'inline'); // a is set -> OR holds

  const and = stack.process(parseDirectiveLine('ifdef::a+b[TEXT]'), state);
  assert.equal(and.kind, 'inline-drop'); // b is not set -> AND fails
});

test('ifeval evaluates a resolved comparison expression', () => {
  const state = new AttributeState();
  state.set('count', '5');
  const stack = new ConditionalStack();
  const r = stack.process(parseDirectiveLine('ifeval::[{count} >= 3]'), state);
  assert.equal(r.kind, 'block');
  assert.equal(stack.suppressed, false);
});

test('endif with no open conditional is a D2 error', () => {
  const state = new AttributeState();
  const stack = new ConditionalStack();
  const r = stack.process(parseDirectiveLine('endif::[]'), state);
  assert.equal(r.kind, 'error');
  assert.equal(r.diagnostics[0].rule, 'D2');
});

test('nested conditionals: suppression is the OR of all open frames', () => {
  const state = new AttributeState();
  state.set('outer', 'yes');
  const stack = new ConditionalStack();
  stack.process(parseDirectiveLine('ifdef::outer[]'), state); // true
  assert.equal(stack.suppressed, false);
  stack.process(parseDirectiveLine('ifdef::inner[]'), state); // inner undefined -> false
  assert.equal(stack.suppressed, true);
  stack.process(parseDirectiveLine('endif::[]'), state);
  assert.equal(stack.suppressed, false);
  stack.process(parseDirectiveLine('endif::[]'), state);
  assert.equal(stack.depth, 0);
});

test('D2: markUnitStart/checkUnitEnd detect an unbalanced unit', () => {
  const state = new AttributeState();
  const stack = new ConditionalStack();
  const start = stack.markUnitStart();
  stack.process(parseDirectiveLine('ifdef::x[]'), state);
  const diagnostics = stack.checkUnitEnd(start);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rule, 'D2');
});
