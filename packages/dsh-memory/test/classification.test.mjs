import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DECISIONS, classifyCandidate, classifyCandidates } from '../host/classification.js';

const memory = (id, content, extra = {}) => ({ id, content, status: 'active', type: 'fact', ...extra });
const candidate = (text, extra = {}) => ({ id: 'C-1', text, type: 'fact', ...extra });

test('the classifier only ever answers ADD, NO_CHANGE or CONFLICT', () => {
  assert.deepEqual(DECISIONS, ['ADD', 'NO_CHANGE', 'CONFLICT']);
  for (const result of [
    classifyCandidate(candidate('全新的约定'), []),
    classifyCandidate(candidate('项目使用 pnpm'), [memory('M-1', '项目使用 pnpm')]),
    classifyCandidate(candidate('项目使用 pnpm 管理依赖'), [memory('M-1', '项目使用 pnpm')]),
  ]) {
    assert.ok(DECISIONS.includes(result.decision));
    assert.ok(typeof result.reason === 'string' && result.reason !== '');
  }
});

test('an identical claim is NO_CHANGE, not an update', () => {
  const result = classifyCandidate(candidate('项目使用  pnpm'), [memory('M-1', '项目使用 pnpm')]);
  assert.equal(result.decision, 'NO_CHANGE');
  assert.equal(result.targetId, 'M-1');
  assert.equal(result.reason, 'duplicate');
});

test('containment and strong overlap are CONFLICT, never a silent overwrite', () => {
  const included = classifyCandidate(candidate('pnpm'), [memory('M-1', '项目使用 pnpm')]);
  assert.equal(included.decision, 'CONFLICT');
  assert.equal(included.reason, 'included');
  assert.equal(included.targetId, 'M-1');

  const overlap = classifyCandidate(
    candidate('项目使用 pnpm 管理所有依赖'),
    [memory('M-1', '项目使用 pnpm 管理依赖')],
  );
  assert.equal(overlap.decision, 'CONFLICT');
  assert.equal(overlap.reason, 'overlap');
});

test('a different memory type is a different claim, not a conflict', () => {
  const result = classifyCandidate(candidate('项目使用 pnpm', { type: 'preference' }), [memory('M-1', '项目使用 pnpm', { type: 'fact' })]);
  assert.equal(result.decision, 'ADD');
});

test('inactive memories never take part in classification', () => {
  const result = classifyCandidate(candidate('项目使用 pnpm'), [memory('M-1', '项目使用 pnpm', { status: 'retracted' })]);
  assert.equal(result.decision, 'ADD');
  assert.equal(result.targetId, null);
});

test('an empty claim is NO_CHANGE with an honest reason', () => {
  assert.deepEqual(classifyCandidate(candidate('   '), []), { decision: 'NO_CHANGE', targetId: null, reason: 'empty' });
  assert.deepEqual(classifyCandidate(null, []), { decision: 'NO_CHANGE', targetId: null, reason: 'empty' });
});

test('classifying a queue keeps the original rows and adds the answer', () => {
  const rows = classifyCandidates(
    [candidate('项目使用 pnpm'), candidate('偏好中文回答', { type: 'preference' })],
    [memory('M-1', '项目使用 pnpm')],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].classification.decision, 'NO_CHANGE');
  assert.equal(rows[0].text, '项目使用 pnpm');
  assert.equal(rows[1].classification.decision, 'ADD');
  assert.deepEqual(classifyCandidates(undefined, []), []);
  assert.deepEqual(classifyCandidates([null], []).length, 1);
});
