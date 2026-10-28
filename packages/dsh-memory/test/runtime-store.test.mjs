import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRuntimeStore, listTemporaryFiles } from '../host/runtime-store.js';

const REF = { session_id: 'session-a', event_seq: 4, event_type: 'user/message' };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-runtime-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a candidate survives a new store instance', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const added = await store.addCandidate({ text: '用户偏好中文回答', type: 'preference', sessionId: 'session-a', turn: 1, sourceRef: REF });
    assert.match(added.id, /^C-\d{8}-/);
    assert.equal(added.status, 'pending');

    const reopened = createRuntimeStore({ root });
    const candidates = await reopened.listCandidates();
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].text, '用户偏好中文回答');
    assert.deepEqual(candidates[0].source_refs, [REF]);
  });
});

test('an identical pending candidate is refused instead of doubled', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    await store.addCandidate({ text: '项目使用 pnpm', sessionId: 'session-a', turn: 1, sourceRef: REF });
    await assert.rejects(
      () => store.addCandidate({ text: '项目使用   pnpm ', sessionId: 'session-a', turn: 2, sourceRef: REF }),
      (error) => {
        assert.equal(error.code, 'duplicate');
        return true;
      },
    );
    assert.equal((await store.listCandidates()).length, 1);
  });
});

test('a candidate without evidence is refused', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    await assert.rejects(() => store.addCandidate({ text: '没有证据' }), (error) => {
      assert.equal(error.code, 'no-evidence');
      return true;
    });
    await assert.rejects(() => store.addCandidate({ text: '   ', sourceRef: REF }), (error) => {
      assert.equal(error.code, 'empty');
      return true;
    });
  });
});

test('reviewing a candidate records the outcome and the produced memory', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const candidate = await store.addCandidate({ text: '用户偏好中文回答', sessionId: 'session-a', turn: 1, sourceRef: REF });
    const reviewed = await store.setCandidateStatus(candidate.id, 'accepted', { memoryId: 'M-1' });
    assert.equal(reviewed.status, 'accepted');
    assert.equal(reviewed.memory_id, 'M-1');
    assert.equal(typeof reviewed.reviewed_at, 'string');

    await assert.rejects(() => store.setCandidateStatus('C-nope', 'accepted'), (error) => {
      assert.equal(error.code, 'missing');
      return true;
    });
    await assert.rejects(() => store.setCandidateStatus(candidate.id, 'maybe'), (error) => {
      assert.equal(error.code, 'invalid-status');
      return true;
    });
  });
});

test('an accepted candidate no longer blocks an identical new one', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const first = await store.addCandidate({ text: '同一句话', sourceRef: REF });
    await store.setCandidateStatus(first.id, 'accepted', { memoryId: 'M-1' });
    const second = await store.addCandidate({ text: '同一句话', sourceRef: REF });
    assert.notEqual(second.id, first.id);
    assert.equal((await store.listCandidates()).length, 2);
  });
});

test('injections are recorded with their reasons and returned newest last', async () => {
  await withRoot(async (root) => {
    const clock = [new Date('2026-10-28T10:00:00.000Z'), new Date('2026-10-28T11:00:00.000Z')];
    let index = 0;
    const store = createRuntimeStore({ root, now: () => clock[Math.min(index++, clock.length - 1)] });
    await store.recordInjection({ sessionId: 's1', turn: 1, memoryIds: ['M-1'], reasons: ['命中 2 个词'], chars: 20 });
    await store.recordInjection({ sessionId: 's1', turn: 2, memoryIds: ['M-1', 'M-2'], chars: 40 });
    const injections = await store.listInjections();
    assert.equal(injections.length, 2);
    assert.equal(injections[0].turn, 1);
    assert.deepEqual(injections[1].memory_ids, ['M-1', 'M-2']);
    assert.equal((await store.listInjections({ limit: 1 })).length, 1);
  });
});

test('old injections are pruned, and the cap keeps the newest', async () => {
  await withRoot(async (root) => {
    const day = 86_400_000;
    const base = Date.parse('2026-10-28T00:00:00.000Z');
    let clock = base - 60 * day;
    const store = createRuntimeStore({ root, now: () => new Date(clock) });
    await store.recordInjection({ sessionId: 's1', turn: 1, memoryIds: ['M-old'] });
    clock = base;
    await store.recordInjection({ sessionId: 's1', turn: 2, memoryIds: ['M-new'] });
    const injections = await store.listInjections();
    assert.equal(injections.length, 1);
    assert.deepEqual(injections[0].memory_ids, ['M-new']);
  });
});

test('a corrupt document is refused and left untouched', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'runtime.json'), '{not json', 'utf8');
    const store = createRuntimeStore({ root });
    await assert.rejects(() => store.listCandidates(), (error) => {
      assert.equal(error.code, 'corrupt');
      return true;
    });
    await assert.rejects(() => store.addCandidate({ text: 'x', sourceRef: REF }), (error) => {
      assert.equal(error.code, 'corrupt');
      return true;
    });
    assert.equal(await readFile(join(root, 'runtime.json'), 'utf8'), '{not json');
  });
});

test('concurrent writes are serialized and all land', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    await Promise.all([
      store.addCandidate({ text: '第一条', sourceRef: REF }),
      store.addCandidate({ text: '第二条', sourceRef: REF }),
      store.addCandidate({ text: '第三条', sourceRef: REF }),
    ]);
    assert.equal((await store.listCandidates()).length, 3);
    assert.deepEqual(await listTemporaryFiles(root), []);

    const document = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
    assert.equal(document.version, 1);
  });
});

test('the summary counts pending candidates without a full read by the caller', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const first = await store.addCandidate({ text: '待确认的', sourceRef: REF });
    await store.addCandidate({ text: '另一条待确认的', sourceRef: REF });
    await store.setCandidateStatus(first.id, 'rejected');
    const summary = await store.summary();
    assert.equal(summary.candidates, 2);
    assert.equal(summary.pending, 1);
    assert.equal(summary.injections, 0);
  });
});

test('a candidate records where it came from and never invents one', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const ruled = await store.addCandidate({ text: '项目使用 pnpm', sourceRef: REF, origin: 'rule' });
    assert.equal(ruled.origin, 'rule');
    const plain = await store.addCandidate({ text: '用户手动加入的', sourceRef: REF });
    assert.equal(plain.origin, null, 'an absent origin stays null');
    const odd = await store.addCandidate({ text: '来路不明的一条', sourceRef: REF, origin: 'whatever' });
    assert.equal(odd.origin, null, 'an unknown origin is not stored as-is');

    const reopened = createRuntimeStore({ root });
    const listed = await reopened.listCandidates();
    assert.deepEqual(listed.map((entry) => entry.origin), ['rule', null, null]);
  });
});
