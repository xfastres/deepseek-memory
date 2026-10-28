import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CORRECTION_KINDS, isCorrectionKind, isReviewOnlyKind } from '../host/corrections.js';

test('the correction vocabulary is the one §10.1 names', () => {
  assert.deepEqual(CORRECTION_KINDS, [
    'wrong',
    'too_broad',
    'outdated',
    'missing_context',
    'wrong_scope',
    'duplicate',
    'should_not_save',
    'delete',
  ]);
  for (const kind of CORRECTION_KINDS) assert.equal(isCorrectionKind(kind), true);
});

test('an unknown kind is not accepted as a correction', () => {
  assert.equal(isCorrectionKind('maybe'), false);
  assert.equal(isCorrectionKind(''), false);
  assert.equal(isCorrectionKind(null), false);
  assert.equal(isCorrectionKind(42), false);
});

test('review-only kinds are the ones that ask for a re-check, not a stop', () => {
  assert.equal(isReviewOnlyKind('too_broad'), true);
  assert.equal(isReviewOnlyKind('missing_context'), true);
  assert.equal(isReviewOnlyKind('wrong_scope'), true);
  assert.equal(isReviewOnlyKind('duplicate'), true);
  for (const kind of ['wrong', 'outdated', 'should_not_save', 'delete']) {
    assert.equal(isReviewOnlyKind(kind), false, kind + ' means stop using it, not re-check it');
  }
  assert.equal(isReviewOnlyKind('nonsense'), false);
  assert.equal(isReviewOnlyKind(null), false);
});
