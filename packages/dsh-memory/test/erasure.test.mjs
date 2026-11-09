import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createLedgerService } from '../host/ledger-service.js';
import {
  deletionIntent,
  describeErasure,
  describeErasureResult,
  planErasure,
} from '../host/erasure.js';

const REF = [{ session_id: 'session-a', event_seq: 7 }];

async function withLedger(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-erase-'));
  try {
    await run(createLedgerService({ root: join(dir, 'ledger') }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a request to delete is reported as an objection, not as a deletion', () => {
  // "delete" is a correction kind: it records an objection, which hides the
  // memory from retrieval while leaving the text in the ledger, its history and
  // /export. Reporting it as done would be a false claim about the user's data.
  assert.deepEqual(deletionIntent({ kind: 'delete' }), { erase: false, retract: false, reason: 'objection-only' });
  assert.deepEqual(deletionIntent({ kind: 'should_not_save' }), { erase: false, retract: false, reason: 'objection-only' });
  assert.deepEqual(deletionIntent({ kind: 'wrong' }), { erase: false, retract: false, reason: 'not-a-deletion' });
  assert.deepEqual(deletionIntent({}), { erase: false, retract: false, reason: 'not-a-deletion' });
});

test('the erasure scope names what it cannot reach', () => {
  // §8.3: rewriting Git history does not delete every copy. The list is data so
  // the panel and the tests read the same one.
  const scope = describeErasure();
  assert.deepEqual(scope.reachable.map((entry) => entry.scope), ['ledger', 'history', 'runtime']);
  assert.deepEqual(scope.unreachable.map((entry) => entry.scope), ['backup', 'export', 'session-log']);
});

test('a plan refuses a missing memory and reports dangling neighbours', () => {
  assert.equal(planErasure({}).allowed, false);
  assert.equal(planErasure({ memory: null }).reason, 'memory-unavailable');
  const memory = { id: 'M-1', content: 'x' };
  const plan = planErasure({ memory, memories: [memory, { id: 'M-2', supersedes_id: 'M-1' }] });
  assert.equal(plan.allowed, true);
  assert.deepEqual(plan.danglingNeighbours, ['M-2'], 'the neighbour that will point at nothing is named');
});

test('the result sentence never claims more than was done', () => {
  assert.equal(describeErasureResult({ erased: false }).ok, false);
  assert.match(describeErasureResult({ erased: false }).message, /没有删除/);
  assert.match(describeErasureResult({ erased: false, error: 'busy' }).message, /busy/);
  const done = describeErasureResult({ erased: true, scopes: ['ledger', 'history', 'runtime'] });
  assert.equal(done.ok, true);
  assert.match(done.message, /账本记录已移除/);
  assert.match(done.message, /备份/, 'the sentence always names what it could not reach');
});

test('erasing removes the text from the ledger and from every commit', async () => {
  await withLedger(async (service) => {
    const secret = await service.add({ content: '要彻底删除的敏感内容 SECRET111', type: 'fact', sourceRefs: REF });
    // A second version, so there are two change files and two change notes; a
    // note is a human-readable copy of the text, so it has to go too.
    const first = secret.memory;
    await service.update({ memoryId: first.id, content: '改过一次的敏感内容 SECRET222', expectedBaseChangeId: first.last_change_id });
    const kept = await service.add({ content: '应当保留的其他内容 KEEP333', type: 'fact', sourceRefs: REF });

    const result = await service.erase({ memoryId: first.id });
    assert.equal(result.erased, true);
    assert.equal(result.complete, false, 'a rewritten history is never reported as every copy gone');
    assert.deepEqual(result.scopes, ['ledger', 'history']);
    assert.deepEqual(result.unreachable, ['backup', 'export', 'session-log']);

    const state = await service.state();
    assert.ok(!state.memories.some((memory) => memory.id === first.id), 'the memory is gone from the ledger');
    assert.ok(state.memories.some((memory) => memory.id === kept.memory.id), 'an unrelated memory is untouched');

    // The whole point: no commit anywhere still contains the text.
    const log = await service.open().then((ledger) => ledger.git.run(['log', '--all', '--format=%H']));
    const commits = log.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.ok(commits.length > 0, 'the repository still has history');
    const found = [];
    for (const commit of commits) {
      const files = await service.open().then((ledger) => ledger.git.lsTree(commit).catch(() => []));
      for (const file of files) {
        const blob = await service.open().then((ledger) => ledger.git.showOrUndefined(commit, file).catch(() => undefined));
        if (typeof blob === 'string' && (blob.includes('SECRET111') || blob.includes('SECRET222'))) found.push(`${commit}:${file}`);
      }
    }
    assert.deepEqual(found, [], 'no surviving blob contains the erased text');
  });
});

test('erasing an unknown memory reports not-found instead of succeeding quietly', async () => {
  await withLedger(async (service) => {
    const result = await service.erase({ memoryId: 'M-19990101-nope' });
    assert.equal(result.erased, false);
    assert.equal(result.reason, 'not-found');
    assert.deepEqual(result.scopes, []);
  });
});

test('erasing refuses a malformed id before it reaches git', async () => {
  await withLedger(async (service) => {
    await assert.rejects(() => service.erase({ memoryId: '../records/x' }), (error) => error.name === 'SchemaError');
  });
});
