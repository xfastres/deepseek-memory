import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidateStatusForPolicy, decideAutoMemory, writeAutoAccepted } from '../host/auto-memory.js';

const SETTINGS_ON = { enabled: true, autoAccept: true, autoAcceptTypes: ['fact', 'preference', 'constraint'] };
const SETTINGS_OFF = { enabled: true, autoAccept: false, autoAcceptTypes: ['fact', 'preference', 'constraint'] };

const candidate = (over) => ({
  id: 'C-1',
  text: '项目使用 pnpm',
  type: 'fact',
  confidence: 0.9,
  source_refs: [{ session_id: 's1', event_seq: 2 }],
  ...over,
});

test('nothing is auto-accepted until the user switches it on', () => {
  const off = decideAutoMemory({ candidate: candidate(), memories: [], settings: SETTINGS_OFF });
  assert.equal(off.policy.decision, 'REVIEW_REQUIRED');
  assert.deepEqual(off.policy.reasons, ['auto-accept-disabled']);
  const on = decideAutoMemory({ candidate: candidate(), memories: [], settings: SETTINGS_ON });
  assert.equal(on.policy.decision, 'AUTO_ACCEPT');
  assert.deepEqual(on.policy.reasons, ['eligible']);
});

test('the master switch stops auto-accept even when the second switch is on', () => {
  const decided = decideAutoMemory({
    candidate: candidate(),
    memories: [],
    settings: { ...SETTINGS_ON, enabled: false },
  });
  assert.equal(decided.policy.decision, 'REVIEW_REQUIRED');
});

test('the user allow-list is the ceiling: a type they excluded stays for review', () => {
  const decided = decideAutoMemory({
    candidate: candidate({ type: 'preference' }),
    memories: [],
    settings: { ...SETTINGS_ON, autoAcceptTypes: ['fact'] },
  });
  assert.equal(decided.policy.decision, 'REVIEW_REQUIRED');
  assert.deepEqual(decided.policy.reasons, ['type-not-auto']);
});

test('confidence, evidence and conflicts still gate auto-accept', () => {
  const lowConfidence = decideAutoMemory({ candidate: candidate({ confidence: 0.2 }), memories: [], settings: SETTINGS_ON });
  assert.deepEqual(lowConfidence.policy.reasons, ['low-confidence']);
  const noEvidence = decideAutoMemory({ candidate: candidate({ source_refs: [] }), memories: [], settings: SETTINGS_ON });
  assert.deepEqual(noEvidence.policy.reasons, ['no-evidence']);
  const existing = [{ id: 'M-1', status: 'active', type: 'fact', content: '项目使用 pnpm' }];
  const duplicate = decideAutoMemory({ candidate: candidate(), memories: existing, settings: SETTINGS_ON });
  assert.equal(duplicate.policy.decision, 'NO_CHANGE');
});

test('an auto-accepted candidate is written once, through the single writer', async () => {
  const added = [];
  const statuses = [];
  const service = {
    async add(input) {
      added.push(input);
      return { status: 'applied', memory: { id: 'M-9' } };
    },
  };
  const runtime = { async setCandidateStatus(id, status, extra) { statuses.push({ id, status, extra }); return {}; } };
  const result = await writeAutoAccepted({ service, runtime, candidate: candidate() });
  assert.equal(result.memory.id, 'M-9');
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], {
    content: '项目使用 pnpm',
    type: 'fact',
    sourceRefs: [{ session_id: 's1', event_seq: 2 }],
    idempotencyKey: 'auto:C-1',
  });
  assert.deepEqual(statuses, [{ id: 'C-1', status: 'auto_accepted', extra: { memoryId: 'M-9' } }]);
});

test('a failing write surfaces instead of claiming success', async () => {
  const service = { async add() { throw new Error('ledger busy'); } };
  const runtime = { async setCandidateStatus() { throw new Error('must not be called'); } };
  await assert.rejects(() => writeAutoAccepted({ service, runtime, candidate: candidate() }), /ledger busy/);
});

test('the policy decision maps to an honest candidate status', () => {
  assert.equal(candidateStatusForPolicy('AUTO_ACCEPT'), 'auto_accepted');
  assert.equal(candidateStatusForPolicy('CONFLICT'), 'conflict');
  assert.equal(candidateStatusForPolicy('NO_CHANGE'), 'no_change');
  assert.equal(candidateStatusForPolicy('REJECT'), 'rejected');
  assert.equal(candidateStatusForPolicy('REVIEW_REQUIRED'), 'review_pending');
  assert.equal(candidateStatusForPolicy('something-else'), 'review_pending', 'the safe default keeps it in the queue');
});
