import assert from 'node:assert/strict';
import { test } from 'node:test';

import { narrowingRequest } from '../host/narrowing.js';

const MEMORY = {
  id: 'M-1',
  status: 'active',
  content: '用户偏好通过图示理解复杂架构',
  source_refs: [{ session_id: 's1', event_seq: 2, event_type: 'user/message' }],
};

test('a review objection never invents a replacement sentence', () => {
  for (const kind of ['too_broad', 'missing_context', 'wrong_scope', 'duplicate']) {
    const decision = narrowingRequest({ objection: { kind }, memory: MEMORY });
    assert.equal(decision.propose, false, kind + ' must not become an automatically written proposal');
    assert.equal(decision.narrowed, false);
    assert.equal(decision.reason, 'no-narrower-wording', 'this module has no words of its own to narrow with');
  }
});

test('an objection that is a verdict is not a narrowing request at all', () => {
  for (const kind of ['wrong', 'outdated', 'should_not_save', 'delete', null, 'nonsense']) {
    const decision = narrowingRequest({ objection: { kind }, memory: MEMORY });
    assert.equal(decision.propose, false);
    assert.equal(decision.reason, 'not-a-review');
  }
  assert.equal(narrowingRequest({ }).reason, 'not-a-review');
  assert.equal(narrowingRequest({ objection: {}, memory: MEMORY }).reason, 'not-a-review');
});

test('a memory that cannot support a narrowing is named, not guessed at', () => {
  assert.equal(narrowingRequest({ objection: { kind: 'too_broad' }, memory: null }).reason, 'memory-unavailable');
  assert.equal(narrowingRequest({ objection: { kind: 'too_broad' }, memory: { ...MEMORY, status: 'retracted' } }).reason, 'memory-unavailable');
  assert.equal(narrowingRequest({ objection: { kind: 'too_broad' }, memory: { ...MEMORY, content: '   ' } }).reason, 'memory-unavailable');
  assert.equal(narrowingRequest({ objection: { kind: 'too_broad' }, memory: { ...MEMORY, source_refs: [] } }).reason, 'no-evidence');
  assert.equal(narrowingRequest({ objection: { kind: 'too_broad' }, memory: { ...MEMORY, source_refs: [null, 'x'] } }).reason, 'no-evidence');
});
