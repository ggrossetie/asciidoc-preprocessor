import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchDoctitleLine, matchAuthorLine, matchRevisionLine } from '../../src/grammar/header.js';

test('doctitle line: single leading "=" and a space', () => {
  assert.deepEqual(matchDoctitleLine('= My Document'), { doctitle: 'My Document' });
  assert.equal(matchDoctitleLine('== Not a title'), null);
  assert.equal(matchDoctitleLine('=NoSpace'), null);
});

test('author line: name plus optional <email>', () => {
  assert.deepEqual(matchAuthorLine('Jane Q. Doe <jane@example.com>'), {
    author: 'Jane Q. Doe',
    firstname: 'Jane',
    middlename: 'Q.',
    lastname: 'Doe',
    email: 'jane@example.com',
    authorinitials: 'JQD',
  });
});

test('author line: single name, no email', () => {
  assert.deepEqual(matchAuthorLine('Cher'), { author: 'Cher', firstname: 'Cher', authorinitials: 'C' });
});

test('revision line: v<number>, optional date, optional remark', () => {
  assert.deepEqual(matchRevisionLine('v1.0, 2024-01-01: Initial release'), {
    revnumber: '1.0',
    revdate: '2024-01-01',
    revremark: 'Initial release',
  });
  assert.deepEqual(matchRevisionLine('v2.0'), { revnumber: '2.0' });
  assert.equal(matchRevisionLine('not a revision'), null);
});
