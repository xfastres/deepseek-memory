import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXTRACTION_CASES } from '../eval/extraction-cases.mjs';
import { evaluateExtraction, summariseExtraction } from '../eval/extraction-eval.mjs';

test('the evaluation set is well formed', () => {
  assert.ok(Array.isArray(EXTRACTION_CASES));
  assert.ok(EXTRACTION_CASES.length >= 20, 'a set of a few cases measures nothing');
  const ids = new Set();
  let candidates = 0;
  let none = 0;
  for (const entry of EXTRACTION_CASES) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(entry.id !== '');
    assert.equal(ids.has(entry.id), false, 'duplicate case id: ' + entry.id);
    ids.add(entry.id);
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.trim() !== '');
    assert.ok(entry.expect === 'candidate' || entry.expect === 'none', 'unknown expectation: ' + entry.expect);
    if (entry.expect === 'candidate') candidates += 1; else none += 1;
    if (entry.count !== undefined) assert.ok(Number.isInteger(entry.count) && entry.count >= 0);
    for (const type of entry.types ?? []) assert.equal(typeof type, 'string');
  }
  assert.ok(candidates >= 8, 'the set needs positive cases');
  assert.ok(none >= 8, 'the set needs negative cases; without them precision is untested');
});

test('the harness arithmetic is count-based and honest about empty denominators', () => {
  const cases = [
    { id: 'a', text: 'x', expect: 'candidate' },
    { id: 'b', text: 'y', expect: 'none' },
  ];
  const noneFound = evaluateExtraction(cases, { extract: () => [] });
  assert.equal(noneFound.extracted, 0);
  assert.equal(noneFound.truePositives, 0);
  assert.equal(noneFound.precision, null, 'no extraction means no precision claim');
  assert.equal(noneFound.recall, 0);
  assert.equal(noneFound.missed.length, 1);
  assert.equal(noneFound.extra.length, 0);

  const tooMany = evaluateExtraction([{ id: 'a', text: 'x', expect: 'candidate' }], {
    extract: () => [{ type: 'fact' }, { type: 'fact' }],
  });
  assert.equal(tooMany.precision, 0.5, 'one of two extracted rows was wanted');
  assert.equal(tooMany.recall, 1);
  assert.equal(tooMany.extra.length, 1);

  const exact = evaluateExtraction([{ id: 'a', text: 'x', expect: 'candidate', count: 3 }], {
    extract: () => [{ type: 'instruction' }, { type: 'fact' }, { type: 'fact' }],
  });
  assert.equal(exact.exactCountMatches, 1);
  assert.deepEqual(exact.byType, { constraint: 1, fact: 2 }, 'types are reported in ledger vocabulary');
  assert.match(summariseExtraction(exact), /cases 1/u);
});

test('the extractor makes no false positives and misses only the documented English gap', () => {
  const result = evaluateExtraction(EXTRACTION_CASES);
  assert.equal(result.extra.length, 0, 'a false positive is worse than a miss; this is the precision gate');
  const undocumented = result.missed.filter((row) => row.note !== 'english');
  assert.deepEqual(undocumented, [], 'a non-English miss is a rule regression, not an accepted gap');
  assert.ok(result.missed.every((row) => row.note === 'english'), 'only the documented gap may remain');
  assert.ok(result.precision === 1 || result.precision === null);
});
