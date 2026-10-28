import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLedgerService } from '../host/ledger-service.js';
import {
  applyMigration,
  planMemoryMigration,
  readLegacyStore,
} from '../host/migration.js';

const REF = { session_id: 'session-a', event_seq: 4, event_type: 'user/message' };

function resolveAll() {
  return async () => REF;
}

test('only active memories are planned, and each keeps a stable replay key', async () => {
  const plan = await planMemoryMigration({
    legacyMemories: [
      { id: 'memory-1', version: 2, status: 'active', content: '用户喜欢简洁的回答', source: { session_id: 'session-a', turn: 1 } },
      { id: 'memory-1', version: 1, status: 'superseded', content: '旧版本内容', source: { session_id: 'session-a', turn: 1 } },
      { id: 'memory-2', version: 1, status: 'active', content: '项目使用 pnpm', source: { session_id: 'session-a', turn: 2 } },
    ],
    resolve: resolveAll(),
  });

  assert.equal(plan.operations.length, 2);
  assert.equal(plan.operations[0].proposal.idempotency_key, 'migrate:memory-1@2');
  assert.equal(plan.operations[1].proposal.idempotency_key, 'migrate:memory-2@1');
  assert.deepEqual(plan.operations[0].proposal.source_refs, [REF]);
  assert.ok(plan.skipped.some((entry) => entry.reason === 'history-not-migrated'));
});

test('unprovable evidence is reported instead of imported with a guess', async () => {
  const plan = await planMemoryMigration({
    legacyMemories: [
      { id: 'memory-1', status: 'active', content: '有证据的', source: { session_id: 'session-a', turn: 1 } },
      { id: 'memory-2', status: 'active', content: '没有证据的', source: { session_id: 'session-a', turn: 99 } },
      { id: 'memory-3', status: 'active', content: '没有来源的' },
      { id: 'memory-4', status: 'active', content: '   ' },
    ],
    resolve: async ({ turn }) => (turn === 1 ? REF : undefined),
  });

  assert.deepEqual(plan.operations.map((entry) => entry.legacyId), ['memory-1']);
  const reasons = Object.fromEntries(plan.skipped.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons['memory-2'], 'no-evidence');
  assert.equal(reasons['memory-3'], 'no-source');
  assert.equal(reasons['memory-4'], 'empty');
});

test('a memory already in the ledger is not duplicated', async () => {
  const plan = await planMemoryMigration({
    legacyMemories: [{ id: 'memory-1', status: 'active', content: '用户喜欢简洁的回答', source: { session_id: 'session-a', turn: 1 } }],
    existingMemories: [{ id: 'M-1', content: '用户喜欢   简洁的回答' }],
    resolve: resolveAll(),
  });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.skipped[0].reason, 'duplicate');
});

test('a resolver that throws degrades to a reported skip', async () => {
  const plan = await planMemoryMigration({
    legacyMemories: [{ id: 'memory-1', status: 'active', content: '内容', source: { session_id: 'session-a', turn: 1 } }],
    resolve: async () => { throw new Error('session unreadable'); },
  });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.skipped[0].reason, 'no-evidence');
});

test('candidates are deferred with a count, not silently dropped', async () => {
  const plan = await planMemoryMigration({
    legacyMemories: [],
    legacyCandidates: [{ id: 'candidate-1' }, { id: 'candidate-2' }],
    resolve: resolveAll(),
  });
  assert.equal(plan.deferred.candidates, 2);
  assert.equal(plan.deferred.reason, 'candidate-queue-not-built');
});

test('migration writes real ledger commits and re-running replays instead of duplicating', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-migrate-'));
  try {
    const service = createLedgerService({ root: join(dir, 'ledger') });
    const plan = await planMemoryMigration({
      legacyMemories: [
        { id: 'memory-1', version: 2, status: 'active', content: '用户喜欢简洁的回答', source: { session_id: 'session-a', turn: 1 } },
        { id: 'memory-2', version: 1, status: 'active', content: '项目使用 pnpm', source: { session_id: 'session-a', turn: 2 } },
      ],
      resolve: resolveAll(),
    });

    const first = await applyMigration(service, plan);
    assert.equal(first.applied, 2);
    assert.equal(first.failed, 0);

    const state = await service.state();
    assert.equal(state.memories.length, 2);
    assert.equal(state.memories[0].source.event_seq, 4);

    const second = await applyMigration(service, plan);
    assert.equal(second.replayed, 2);
    assert.equal(second.applied, 0);
    assert.equal((await service.state()).memories.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the legacy store reader tolerates missing, malformed and non-array values', () => {
  const empty = readLegacyStore({ getItem: () => null });
  assert.deepEqual(empty, { memories: [], candidates: [] });

  const broken = readLegacyStore({ getItem: () => '{not json' });
  assert.deepEqual(broken, { memories: [], candidates: [] });

  const object = readLegacyStore({ getItem: () => '{"a":1}' });
  assert.deepEqual(object, { memories: [], candidates: [] });

  const good = readLegacyStore({
    getItem: (key) => (key === 'dsh-memory.formal.v1' ? '[{"id":"m"}]' : '[{"id":"c"}]'),
  });
  assert.equal(good.memories.length, 1);
  assert.equal(good.candidates.length, 1);
});
