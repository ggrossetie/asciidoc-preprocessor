import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchDoctitleLine, matchAuthorLine, matchRevisionLine, processAuthors } from '../../src/grammar/header.js';

test('doctitle line: single leading "=" and a space', () => {
  assert.deepEqual(matchDoctitleLine('= My Document'), { doctitle: 'My Document' });
  assert.equal(matchDoctitleLine('== Not a title'), null);
  assert.equal(matchDoctitleLine('=NoSpace'), null);
});

test('author line: name plus optional <email>', () => {
  assert.deepEqual(matchAuthorLine('Jane Q. Doe <jane@example.com>'), {
    author: 'Jane Q. Doe',
    authors: 'Jane Q. Doe',
    authorcount: '1',
    firstname: 'Jane',
    middlename: 'Q.',
    lastname: 'Doe',
    email: 'jane@example.com',
    authorinitials: 'JQD',
  });
});

test('author line: several authors separated by ";"', () => {
  const m = matchAuthorLine('Jane Doe <jane@example.com>; John Smith');
  assert.equal(m.authorcount, '2');
  assert.equal(m.authors, 'Jane Doe, John Smith');
  assert.equal(m.author_2, 'John Smith');
  assert.equal(m.lastname_1, 'Doe');
});

test('author line: underscores join multi-word name parts', () => {
  assert.equal(matchAuthorLine('Ludwig_van Beethoven').firstname, 'Ludwig van');
});

test('author line: anything else is taken whole as the author name', () => {
  assert.deepEqual(matchAuthorLine('Cher'), { author: 'Cher', authors: 'Cher', authorcount: '1', firstname: 'Cher', authorinitials: 'C' });
});

test('names-only processing (for an :author: entry)', () => {
  assert.equal(processAuthors('Jane Q. Doe', { namesOnly: true, multiple: false }).lastname, 'Doe');
});

test('revision line: number, date, remark', () => {
  assert.deepEqual(matchRevisionLine('v1.0, 2024-01-01: Initial release'), { revnumber: '1.0', revdate: '2024-01-01', revremark: 'Initial release' });
  assert.deepEqual(matchRevisionLine('v2.0'), { revnumber: '2.0' });
  assert.deepEqual(matchRevisionLine('2024-01-01'), { revdate: '2024-01-01' });
});
