import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLedgerService, toApiError } from '../host/ledger-service.js';

const REF = [{ session_id: 'session-a', event_seq: 7, event_type: 'user/message' }];

async function withService(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-ledger-'));
  try {
    const service = createLedgerService({ root: join(dir, 'ledger') });
    await run(service, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a fresh service creates the repository and reads an empty state', async () => {
  await withService(async (service) => {
    const state = await service.state();
    assert.equal(typeof state.head, 'string');
    assert.deepEqual(state.memories, []);
  });
});

test('adding a memory commits it and reports it as version one', async () => {
  await withService(async (service) => {
    const added = await service.add({ content: '用户喜欢简洁的回答', type: 'preference', sourceRefs: REF });
    assert.equal(added.status, 'committed');

    const state = await service.state();
    assert.equal(state.memories.length, 1);
    const [memory] = state.memories;
    assert.equal(memory.content, '用户喜欢简洁的回答');
    assert.equal(memory.status, 'active');
    assert.equal(memory.version, 1);
    assert.equal(memory.source.session_id, 'session-a');
    assert.equal(memory.source.event_seq, 7);
    assert.equal(typeof memory.last_change_id, 'string');
  });
});

test('an update needs the current change id and produces version two', async () => {
  await withService(async (service) => {
    await service.add({ content: '第一版', sourceRefs: REF });
    const [before] = (await service.state()).memories;

    const updated = await service.update({
      memoryId: before.id,
      content: '第一版，已修正',
      expectedBaseChangeId: before.last_change_id,
      sourceRefs: REF,
    });
    assert.equal(updated.status, 'committed');

    const [after] = (await service.state()).memories;
    assert.equal(after.id, before.id);
    assert.equal(after.content, '第一版，已修正');
    assert.equal(after.version, 2);
    assert.notEqual(after.last_change_id, before.last_change_id);
  });
});

test('a stale change id is refused instead of overwriting', async () => {
  await withService(async (service) => {
    await service.add({ content: '第一版', sourceRefs: REF });
    const [before] = (await service.state()).memories;
    await service.update({
      memoryId: before.id,
      content: '第二版',
      expectedBaseChangeId: before.last_change_id,
      sourceRefs: REF,
    });

    await assert.rejects(
      () => service.update({ memoryId: before.id, content: '过期编辑', expectedBaseChangeId: before.last_change_id, sourceRefs: REF }),
      (error) => {
        assert.equal(error.name, 'LedgerConflictError');
        assert.deepEqual(toApiError(error), { status: 409, error: 'stale' });
        return true;
      },
    );

    const [after] = (await service.state()).memories;
    assert.equal(after.content, '第二版');
  });
});

test('updating a missing memory maps to a 404', async () => {
  await withService(async (service) => {
    await assert.rejects(
      () => service.update({ memoryId: 'M-19990101-missing', content: 'x', sourceRefs: REF }),
      (error) => {
        assert.deepEqual(toApiError(error), { status: 404, error: 'missing' });
        return true;
      },
    );
  });
});

test('a replayed idempotency key never writes twice', async () => {
  await withService(async (service) => {
    const first = await service.add({ content: '只记一次', sourceRefs: REF, idempotencyKey: 'key-1' });
    const second = await service.add({ content: '只记一次', sourceRefs: REF, idempotencyKey: 'key-1' });
    assert.equal(first.status, 'committed');
    assert.equal(second.status, 'replayed');
    assert.equal((await service.state()).memories.length, 1);
  });
});

test('a memory without evidence is refused by the schema', async () => {
  await withService(async (service) => {
    await assert.rejects(
      () => service.add({ content: '没有证据', sourceRefs: [] }),
      (error) => {
        assert.deepEqual(toApiError(error), { status: 422, error: 'invalid' });
        return true;
      },
    );
    assert.equal((await service.state()).memories.length, 0);
  });
});

test('retracting keeps the record but marks it withdrawn', async () => {
  await withService(async (service) => {
    await service.add({ content: '将被撤回', sourceRefs: REF });
    const [before] = (await service.state()).memories;
    await service.retract({ memoryId: before.id, expectedBaseChangeId: before.last_change_id, reason: '用户要求撤回' });

    const [after] = (await service.state()).memories;
    assert.equal(after.status, 'retracted');
    assert.equal(after.content, '将被撤回');
    assert.equal(after.version, 2);
  });
});

test('a formal memory says how it came to be', async () => {
  const { createLedgerService } = await import('../host/ledger-service.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kind-'));
  try {
    const service = createLedgerService({ root: join(dir, 'ledger') });
    const added = await service.add({ content: '项目使用 pnpm', sourceRefs: [{ session_id: 's1', event_seq: 2 }] });
    assert.equal(added.memory.source_kind, 'user-explicit');
    const state = await service.state();
    assert.equal(state.memories[0].source_kind, 'user-explicit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the state row carries what retrieval needs to be safe', async () => {
  await withService(async (service) => {
    await service.add({
      content: '项目使用 pnpm 管理依赖',
      type: 'fact',
      sourceRefs: REF,
    });
    const [memory] = (await service.state()).memories;
    assert.deepEqual(memory.tags, [], 'the row carries a tag list even when the writer stored none');
    assert.deepEqual(memory.entities, [], 'entities are an array, never absent');
    assert.equal(memory.valid_to, null, 'no expiry is stated, not invented');
    assert.equal(memory.sensitivity, null, 'the ledger has no private marker yet; absent means absent');
  });
});

test('tags and entities reach the ledger instead of being dropped', async () => {
  await withService(async (service) => {
    const added = await service.add({
      content: '项目使用 pnpm 管理依赖',
      type: 'fact',
      sourceRefs: REF,
      tags: ['tooling', 'pnpm'],
      entities: ['pnpm', 'F:\\deepseek-memory'],
    });
    assert.equal(added.status, 'committed');
    assert.deepEqual(added.memory.tags, ['tooling', 'pnpm']);
    assert.deepEqual(added.memory.entities, ['pnpm', 'F:\\deepseek-memory']);

    const [memory] = (await service.state()).memories;
    assert.deepEqual(memory.tags, ['tooling', 'pnpm'], 'a reader sees the same structure the writer stored');

    const updated = await service.update({
      memoryId: memory.id,
      content: '项目使用 pnpm 管理依赖（工作区）',
      expectedBaseChangeId: memory.last_change_id,
      entities: ['pnpm', 'workspace'],
    });
    assert.deepEqual(updated.memory.entities, ['pnpm', 'workspace'], 'an explicit list replaces the old one');
    assert.deepEqual(updated.memory.tags, ['tooling', 'pnpm'], 'an omitted list keeps what was there');

    const unchanged = await service.update({
      memoryId: memory.id,
      content: '项目使用 pnpm 管理依赖（最终）',
      expectedBaseChangeId: updated.memory.last_change_id,
    });
    assert.deepEqual(unchanged.memory.entities, ['pnpm', 'workspace'], 'an update that says nothing about structure cannot erase it');
    assert.deepEqual(unchanged.memory.tags, ['tooling', 'pnpm']);
  });
});

test('the change list shows what each change did to the record', async () => {
  await withService(async (service) => {
    const added = await service.add({ content: '项目使用 pnpm', type: 'fact', sourceRefs: REF });
    const updated = await service.update({
      memoryId: added.memory.id,
      content: '项目使用 pnpm 9',
      expectedBaseChangeId: added.memory.last_change_id,
    });
    await service.retract({
      memoryId: added.memory.id,
      expectedBaseChangeId: updated.memory.last_change_id,
      reason: '项目迁移',
    });

    const { changes } = await service.recentChanges();
    assert.equal(changes.length, 3);

    const retract = changes[0];
    assert.equal(retract.change_type, 'RETRACT');
    assert.equal(retract.before.content, '项目使用 pnpm 9');
    assert.equal(retract.before.status, 'active');
    assert.equal(retract.after.status, 'retracted', 'the after-state is the record at that commit');
    assert.equal(retract.after.content, '项目使用 pnpm 9');

    const update = changes[1];
    assert.equal(update.change_type, 'UPDATE');
    assert.equal(update.before.content, '项目使用 pnpm');
    assert.equal(update.after.content, '项目使用 pnpm 9');

    const add = changes[2];
    assert.equal(add.change_type, 'ADD');
    assert.equal(add.before, null, 'an ADD has nothing before it');
    assert.equal(add.after.content, '项目使用 pnpm');
  });
});

test('a change whose record cannot be read shows null, not a guess', async () => {
  await withService(async (service) => {
    await service.add({ content: '项目使用 pnpm', type: 'fact', sourceRefs: REF });
    const { changes } = await service.recentChanges();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].after.content, '项目使用 pnpm');
    assert.equal(changes[0].before, null);
  });
});

test('each history version keeps the refs it was written with', async () => {
  await withService(async (service) => {
    const added = await service.add({ content: '项目使用 pnpm', type: 'fact', sourceRefs: REF });
    await service.update({
      memoryId: added.memory.id,
      content: '项目使用 pnpm 9',
      expectedBaseChangeId: added.memory.last_change_id,
    });
    const versions = await service.history(added.memory.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].source_refs[0].session_id, 'session-a');
    assert.equal(versions[0].source_refs[0].event_seq, 7);
    assert.equal(versions[1].source_refs[0].event_seq, 7, 'an update that adds no ref does not drop the original');
    assert.ok(versions.every((version) => Array.isArray(version.source_refs)));
  });
});
