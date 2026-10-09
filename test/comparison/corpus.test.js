// Runs every case of the comparison corpus (compare/cases.js) through
// Asciidoctor.js and through the transducer + the same Asciidoctor.js
// parser, and asserts the observed verdict. A failing test here means one
// side changed behavior: update the case *and* COMPARISON.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cases } from '../../compare/cases.js';
import { runCase } from '../../compare/harness.js';

for (const c of cases) {
  test(`${c.id} [${c.category}] ${c.title} — expected: ${c.expect}`, async () => {
    const r = await runCase(c);
    assert.equal(r.verdictJs, c.expect, `Asciidoctor.js:\n${r.js.text}\n\ntransducer + parser:\n${r.pipelineJs.text}`);
  });
}
