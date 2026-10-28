import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTO_ACCEPT_TYPES,
  POLICY_DECISIONS,
  REVIEW_ONLY_TYPES,
  evaluateCandidatePolicies,
  evaluateCandidatePolicy,
} from '../host/policy.js';

const base = { classification: { decision: 'ADD', targetId: null, reason: 'new' }, type: 'fact', confidence: 0.8, hasEvidence: true };

test('the policy answers only the five decisions §7.1 defines', () => {
  assert.deepEqual(POLICY_DECISIONS, ['AUTO_ACCEPT', 'REVIEW_REQUIRED', 'CONFLICT', 'NO_CHANGE', 'REJECT']);
  assert.deepEqual(AUTO_ACCEPT_TYPES, ['fact', 'preference', 'constraint']);
  assert.deepEqual(REVIEW_ONLY_TYPES, ['hypothesis', 'goal', 'decision', 'open_loop', 'event']);
  for (const result of [
    evaluateCandidatePolicy(base),
    evaluateCandidatePolicy({ ...base, confidence: 0.1 }),
    evaluateCandidatePolicy({ ...base, hasEvidence: false }),
    evaluateCandidatePolicy({ ...base, classification: { decision: 'CONFLICT' } }),
    evaluateCandidatePolicy({ ...base, classification: { decision: 'NO_CHANGE' } }),
  ]) {
    assert.ok(POLICY_DECISIONS.includes(result.decision));
    assert.ok(Array.isArray(result.reasons) && result.reasons.length > 0);
  }
});

test('missing evidence and an unknown type are rejected, not written', () => {
  assert.deepEqual(evaluateCandidatePolicy({ ...base, hasEvidence: false }), { decision: 'REJECT', reasons: ['no-evidence'] });
  assert.deepEqual(evaluateCandidatePolicy({ ...base, type: 'gossip' }), { decision: 'REJECT', reasons: ['type-not-allowed'] });
});

test('a duplicate or a conflict never reaches the writer', () => {
  assert.deepEqual(evaluateCandidatePolicy({ ...base, classification: { decision: 'NO_CHANGE' } }), { decision: 'NO_CHANGE', reasons: ['duplicate'] });
  assert.deepEqual(evaluateCandidatePolicy({ ...base, classification: { decision: 'CONFLICT' } }), { decision: 'CONFLICT', reasons: ['conflict'] });
});

test('sensitivity, low confidence and review-only types need the user', () => {
  assert.deepEqual(evaluateCandidatePolicy({ ...base, sensitive: true }), { decision: 'REVIEW_REQUIRED', reasons: ['sensitive'] });
  assert.deepEqual(evaluateCandidatePolicy({ ...base, confidence: 0.3 }), { decision: 'REVIEW_REQUIRED', reasons: ['low-confidence'] });
  assert.deepEqual(evaluateCandidatePolicy({ ...base, type: 'hypothesis' }), { decision: 'REVIEW_REQUIRED', reasons: ['type-needs-user'] });
  assert.deepEqual(evaluateCandidatePolicy({ ...base, type: null }), { decision: 'REVIEW_REQUIRED', reasons: ['type-unknown'] });
});

test('auto-accept is eligible but stays off until it is enabled', () => {
  assert.deepEqual(evaluateCandidatePolicy(base), { decision: 'REVIEW_REQUIRED', reasons: ['auto-accept-disabled'] });
  assert.deepEqual(evaluateCandidatePolicy({ ...base, autoAccept: true }), { decision: 'AUTO_ACCEPT', reasons: ['eligible'] });
  assert.deepEqual(
    evaluateCandidatePolicy({ ...base, type: 'event', autoAccept: true }),
    { decision: 'REVIEW_REQUIRED', reasons: ['type-needs-user'] },
  );
  assert.deepEqual(
    evaluateCandidatePolicy({ ...base, confidenceThreshold: 0.95 }),
    { decision: 'REVIEW_REQUIRED', reasons: ['low-confidence'] },
  );
});

test('the queue is annotated without changing its rows', () => {
  const rows = evaluateCandidatePolicies([
    { id: 'C-1', text: 'a', type: 'fact', confidence: 0.9, source_refs: [{ session_id: 's1', event_seq: 1 }], classification: { decision: 'ADD' } },
    { id: 'C-2', text: 'b', type: 'fact', confidence: 0.9, source_refs: [] },
  ], { autoAccept: false });
  assert.equal(rows[0].id, 'C-1');
  assert.deepEqual(rows[0].policy, { decision: 'REVIEW_REQUIRED', reasons: ['auto-accept-disabled'] });
  assert.deepEqual(rows[1].policy, { decision: 'REJECT', reasons: ['no-evidence'] });
  assert.deepEqual(evaluateCandidatePolicies(undefined), []);
});

test('the user allow-list narrows which types may be auto-accepted', () => {
  const base = { classification: { decision: 'ADD' }, confidence: 0.9, hasEvidence: true, autoAccept: true };
  assert.equal(evaluateCandidatePolicy({ ...base, type: 'fact', autoAcceptTypes: ['fact'] }).decision, 'AUTO_ACCEPT');
  assert.deepEqual(evaluateCandidatePolicy({ ...base, type: 'preference', autoAcceptTypes: ['fact'] }).reasons, ['type-not-auto']);
  assert.deepEqual(evaluateCandidatePolicy({ ...base, type: 'fact', autoAcceptTypes: [] }).reasons, ['type-not-auto']);
  assert.deepEqual(
    evaluateCandidatePolicy({ ...base, type: 'fact', autoAcceptTypes: ['goal'] }).reasons,
    ['type-not-auto'],
    'a list naming only review-only types allows nothing; settings can narrow, never widen',
  );
});
