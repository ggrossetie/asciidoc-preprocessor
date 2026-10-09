import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AttributeState } from '../../src/attribute-state.js';

test('seeded attributes are locked by default', () => {
  const state = new AttributeState({ foo: 'bar' });
  assert.equal(state.get('foo'), 'bar');
  assert.equal(state.isLocked('foo'), true);
  assert.equal(state.set('foo', 'baz'), false);
  assert.equal(state.get('foo'), 'bar');
});

test('soft-set seeded attributes are overridable', () => {
  const state = new AttributeState({ foo: { value: 'bar', soft: true } });
  assert.equal(state.isLocked('foo'), false);
  assert.equal(state.set('foo', 'baz'), true);
  assert.equal(state.get('foo'), 'baz');
});

test('a seeded null is a locked unset (API "name!"): a body entry cannot define it', () => {
  const state = new AttributeState({ foo: null });
  assert.equal(state.has('foo'), false);
  assert.equal(state.set('foo', 'x'), false);
  assert.equal(state.has('foo'), false);
  assert.deepEqual(state.snapshot(), {});
});

test('names are normalized to lowercase', () => {
  const state = new AttributeState();
  state.set('Foo-Bar', '1');
  assert.equal(state.get('foo-bar'), '1');
  assert.equal(state.has('FOO-BAR'), true);
});

test('unset removes a value unless locked', () => {
  const state = new AttributeState({ locked: 'x', free: { value: 'y', soft: true } });
  assert.equal(state.unset('locked'), false);
  assert.equal(state.has('locked'), true);
  assert.equal(state.unset('free'), true);
  assert.equal(state.has('free'), false);
});

test('resolveReferences substitutes known attributes eagerly, leaves unknown ones untouched', () => {
  const state = new AttributeState();
  state.set('name', 'World');
  assert.equal(state.resolveReferences('Hello, {name}!'), 'Hello, World!');
  assert.equal(state.resolveReferences('Hello, {missing}!'), 'Hello, {missing}!');
});

test('escaped references are unescaped, not resolved', () => {
  const state = new AttributeState();
  state.set('name', 'World');
  assert.equal(state.resolveReferences('\\{name} {name\\}'), '{name} {name}');
});

test('intrinsic character references resolve but are not "defined"', () => {
  const state = new AttributeState();
  assert.equal(state.resolveReferences('a{sp}b{nbsp}'), 'a b&#160;');
  assert.equal(state.has('sp'), false);
});

test('{set:...} and {counter:...} are parser-side: left untouched', () => {
  const state = new AttributeState();
  assert.equal(state.resolveReferences('{counter:n} {set:a:b}'), '{counter:n} {set:a:b}');
});

test('attribute-missing policies: skip, drop, drop-line', () => {
  const state = new AttributeState();
  assert.deepEqual(state.substitute('a {x} b', 'skip'), { text: 'a {x} b', missing: ['x'] });
  assert.deepEqual(state.substitute('a {x} b', 'drop'), { text: 'a  b', missing: ['x'] });
  assert.deepEqual(state.substitute('a {x} b', 'drop-line'), { text: null, missing: ['x'] });
});

test('resolution is a snapshot: a later set does not retroactively change an earlier resolution', () => {
  const state = new AttributeState();
  state.set('a', '1');
  const resolved = state.resolveReferences('{a}');
  state.set('a', '2');
  assert.equal(resolved, '1');
});
