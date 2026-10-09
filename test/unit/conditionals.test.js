import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConditionalStack, parseDirectiveLine } from '../../src/grammar/conditionals.js';
import { AttributeState } from '../../src/attribute-state.js';

const parse = parseDirectiveLine;

test('parseDirectiveLine recognizes all four directive types', () => {
  assert.deepEqual(parse('ifdef::flag[]'), { escaped: false, type: 'ifdef', target: 'flag', delimiter: null, content: '' });
  assert.deepEqual(parse('ifeval::[{n} > 1]'), { escaped: false, type: 'ifeval', target: '', delimiter: null, content: '{n} > 1' });
  assert.deepEqual(parse('endif::[]'), { escaped: false, type: 'endif', target: '', delimiter: null, content: '' });
  assert.equal(parse('ifndef::a,b[Some Text]').delimiter, ',');
  assert.equal(parse('\\ifdef::flag[]').escaped, true);
});

test('parseDirectiveLine rejects non-directive lines', () => {
  assert.equal(parse('This is ifdef-like but not a directive'), null);
  assert.equal(parse('ifdef::flag'), null);
  assert.equal(parse('ifdef::a b[]'), null, 'targets cannot contain spaces');
});

test('block-form ifdef pushes a frame and suppresses the false branch', () => {
  const state = new AttributeState();
  const stack = new ConditionalStack();
  assert.deepEqual(stack.process(parse('ifdef::flag[]'), state), { kind: 'consumed' });
  assert.equal(stack.suppressed, true);
  stack.process(parse('endif::[]'), state);
  assert.equal(stack.suppressed, false);
});

test('ifndef inverts ifdef', () => {
  const stack = new ConditionalStack();
  stack.process(parse('ifndef::flag[]'), new AttributeState());
  assert.equal(stack.suppressed, false);
});

test('single-line form returns its text verbatim (no substitution) without pushing a frame', () => {
  const state = new AttributeState();
  state.set('flag', 'yes');
  const stack = new ConditionalStack();
  assert.deepEqual(stack.process(parse('ifdef::flag[Hello, {flag}!]'), state), { kind: 'inline', text: 'Hello, {flag}!' });
  assert.equal(stack.depth, 0);
  assert.deepEqual(stack.process(parse('ifndef::flag[X]'), state), { kind: 'consumed' });
});

test('"," is OR and "+" is AND; the first delimiter decides', () => {
  const state = new AttributeState();
  state.set('a', '1');
  const stack = new ConditionalStack();
  assert.equal(stack.process(parse('ifdef::a,b[T]'), state).kind, 'inline');
  assert.equal(stack.process(parse('ifdef::a+b[T]'), state).kind, 'consumed');
  assert.equal(stack.process(parse('ifdef::b,a+c[T]'), state).kind, 'consumed', 'split on ",": ["b", "a+c"], neither defined');
});

test('ifeval pushes a frame', () => {
  const state = new AttributeState();
  state.set('count', '5');
  const stack = new ConditionalStack();
  stack.process(parse('ifeval::[{count} >= 3]'), state);
  assert.equal(stack.suppressed, false);
  assert.equal(stack.depth, 1);
});

test('malformed directives are errors and push nothing', () => {
  const stack = new ConditionalStack();
  const state = new AttributeState();
  assert.equal(stack.process(parse('ifdef::[text]'), state).kind, 'error');
  assert.equal(stack.process(parse('ifeval::x[1 == 1]'), state).kind, 'error');
  assert.equal(stack.process(parse('ifeval::[nonsense]'), state).kind, 'error');
  assert.equal(stack.process(parse('endif::[text]'), state).kind, 'error');
  assert.equal(stack.depth, 0);
});

test('endif with no open conditional is an error', () => {
  const r = new ConditionalStack().process(parse('endif::[]'), new AttributeState());
  assert.equal(r.kind, 'error');
});

test('mismatched endif is an error and does NOT pop (as in Asciidoctor)', () => {
  const stack = new ConditionalStack();
  const state = new AttributeState();
  stack.process(parse('ifdef::a,b[]'), state);
  assert.equal(stack.process(parse('endif::a[]'), state).kind, 'error', 'endif must repeat the full target');
  assert.equal(stack.depth, 1);
  assert.deepEqual(stack.process(parse('endif::a,b[]'), state), { kind: 'consumed' });
  assert.equal(stack.depth, 0);
});

test('nested conditionals: inside a false branch nothing is evaluated, only nesting is tracked', () => {
  const state = new AttributeState();
  state.set('outer', 'yes');
  const stack = new ConditionalStack();
  stack.process(parse('ifdef::inner[]'), state);
  assert.equal(stack.suppressed, true);
  stack.process(parse('ifdef::outer[]'), state);
  assert.equal(stack.suppressed, true, 'still skipping, even though outer is defined');
  stack.process(parse('endif::[]'), state);
  assert.equal(stack.suppressed, true);
  stack.process(parse('endif::[]'), state);
  assert.equal(stack.suppressed, false);
});

test('D2: markUnitStart/checkUnitEnd detect an unbalanced unit', () => {
  const stack = new ConditionalStack();
  const start = stack.markUnitStart();
  stack.process(parse('ifdef::x[]'), new AttributeState());
  assert.equal(stack.checkUnitEnd(start)[0].rule, 'D2');
  assert.equal(stack.checkDocumentEnd()[0].rule, 'unterminated-conditional');
});
