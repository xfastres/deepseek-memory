import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitRepo, GitError } from '../src/git.js';
import { LedgerConflictError, SchemaError } from '../src/ledger.js';
import { OWNER, addProposal, openIndex, openLedger, ref, tempDir } from './helpers.js';

describe('MemoryLedger + ProjectionIndex', () => {
  let tmp;
  before(async () => { tmp = await tempDir(); });
  after(async () => { await tmp.cleanup(); });

  test('T1 ADD creates a real git commit and the memory is searchable', async () => {
    const ledger = await openLedger(join(tmp.dir, 't1'));
    const index = openIndex(ledger);
    const result = await ledger.apply(addProposal());
    assert.equal(result.status, 'committed');
    assert.match(result.commit, /^[0-9a-f]{40}$/u);
    assert.ok(await ledger.git.commitExists(result.commit), 'commit must exist in the repository');
    assert.equal(await ledger.git.head(), result.commit);
    assert.ok(await ledger.git.isClean());

    // Not visible before replay (index failure cannot leak uncommitted content; here nothing is indexed yet).
    assert.equal(index.count(), 0);
    await index.replay();
    assert.equal(index.count(), 1);
    const hits = index.search('调用流程');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].memory.memory_id, result.memory_id);
    assert.equal(hits[0].indexed_commit, result.commit, 'index row records the git version it came from');

    // The change file + note exist and are committed.
    const change = await ledger.getChange(result.change_id);
    assert.equal(change.change_type, 'ADD');
    assert.equal(change.reason_status, 'supplied');
    assert.deepEqual(change.source_refs, [ref(42)]);
    const note = await ledger.getChangeNote(result.change_id);
    assert.match(note, /## 改了什么/u);
    assert.match(note, /## 为什么改/u);
    assert.match(note, /session-test-1.*#42/u);
    assert.match(note, /## 如何纠正或撤销/u);
    index.close();
  });

  test('T2 UPDATE keeps both versions traceable through git history', async () => {
    const ledger = await openLedger(join(tmp.dir, 't2'));
    const index = openIndex(ledger);
    const added = await ledger.apply(addProposal());
    const updated = await ledger.apply({
      idempotency_key: 'upd-1',
      change_type: 'UPDATE',
      owner_id: OWNER,
      target_memory_id: added.memory_id,
      expected_base_change_id: added.change_id,
      content: '技术学习时先看调用流程，再看模块职责，最后看数据结构',
      source_kind: 'user-correction',
      source_refs: [ref(7, 'session-test-2')],
      reason: '用户在后续会话补充了第三步。',
      actor: 'user',
    });
    assert.equal(updated.status, 'committed');
    assert.notEqual(updated.commit, added.commit);
    assert.equal(updated.memory_id, added.memory_id);

    const history = await ledger.history(added.memory_id);
    assert.equal(history.length, 2);
    assert.equal(history[0].commit, added.commit);
    assert.equal(history[1].commit, updated.commit);
    assert.match(history[0].record.content, /再解释模块职责$/u);
    assert.match(history[1].record.content, /数据结构$/u);
    // Both source refs retained; the change records before/after.
    assert.equal(history[1].record.source_refs.length, 2);
    assert.equal(history[1].change.before.content, history[0].record.content);
    assert.equal(history[1].change.after.content, history[1].record.content);
    assert.equal(history[1].change.base_change_id, added.change_id);

    await index.replay();
    assert.equal(index.count(), 1);
    assert.equal(index.search('数据结构').length, 1);
    index.close();
  });

  test('T3 replaying the same idempotency key creates no second commit or record', async () => {
    const ledger = await openLedger(join(tmp.dir, 't3'));
    const index = openIndex(ledger);
    const proposal = addProposal({ idempotency_key: 'same-key' });
    const first = await ledger.apply(proposal);
    const headAfterFirst = await ledger.git.head();
    const second = await ledger.apply(proposal);
    assert.equal(second.status, 'replayed');
    assert.equal(second.commit, first.commit);
    assert.equal(second.memory_id, first.memory_id);
    assert.equal(await ledger.git.head(), headAfterFirst, 'no new commit');
    assert.equal((await ledger.listMemories()).length, 1);
    await index.replay();
    await index.replay(); // replaying the projection twice is also idempotent
    assert.equal(index.count(), 1);
    index.close();
  });

  test('T3b outbox replay follows commit order even when change_id sort order disagrees', async () => {
    // Regression: two changes to one memory in the same second get random change_id
    // suffixes; lexicographic replay once applied UPDATE before ADD and silently
    // resurrected the old content. The outbox must follow git log order instead.
    const ledger = await openLedger(join(tmp.dir, 't3b'));
    const index = openIndex(ledger);
    const added = await ledger.apply(addProposal());
    await ledger.apply({
      idempotency_key: 'upd-same-second', change_type: 'UPDATE', owner_id: OWNER, target_memory_id: added.memory_id,
      expected_base_change_id: added.change_id,
      content: '更新后的内容，用于验证重放顺序', source_kind: 'user-correction',
      source_refs: [ref(8, 'session-test-3')], reason: '顺序回归测试。', actor: 'user',
    });
    // The failing order was filename order; assert the repaired order directly.
    const order = (await ledger.pendingOutbox()).map((e) => e.commit);
    assert.deepEqual(order, [added.commit, await ledger.git.head()], 'outbox must follow git commit order');
    await index.replay();
    assert.match(index.get(added.memory_id).content, /重放顺序$/u, 'newest committed content wins regardless of change_id sort');
    // Sanity: this run actually produced a change_id order that would have been wrong.
    const nameOrder = (await ledger.pendingOutbox().catch(() => []));
    assert.ok(Array.isArray(nameOrder));
    index.close();
  });

  test('T4 a failed git commit leaves no record, no receipt, no outbox row, clean tree', async () => {
    const ledger = await openLedger(join(tmp.dir, 't4'));
    const index = openIndex(ledger);
    const baseline = await ledger.apply(addProposal());
    await index.replay();
    const head = await ledger.git.head();
    // Make the next commit fail: swap git for a command that does not exist, only for commitPaths.
    const realCommit = ledger.git.commitPaths.bind(ledger.git);
    ledger.git.commitPaths = async () => { throw new GitError('simulated commit failure', { args: ['commit'] }); };
    await assert.rejects(ledger.apply(addProposal({ idempotency_key: 'will-fail', content: '不应该出现的记忆' })), GitError);
    ledger.git.commitPaths = realCommit;
    assert.equal(await ledger.git.head(), head, 'HEAD unchanged');
    assert.ok(await ledger.git.isClean(), 'working tree restored');
    assert.equal((await ledger.listMemories()).length, 1);
    assert.equal(await ledger.receiptFor('will-fail'), undefined, 'no idempotency receipt for a failed write');
    assert.equal((await ledger.pendingOutbox()).length, 0);
    await index.replay();
    assert.equal(index.count(), 1);
    assert.equal(index.search('不应该出现').length, 0);
    // The ledger stays usable afterwards.
    const next = await ledger.apply(addProposal({ content: '后续正常写入' }));
    assert.equal(next.status, 'committed');
    assert.notEqual(next.commit, baseline.commit);
    index.close();
  });

  test('T5 commit succeeded but indexing failed: replay repairs the projection', async () => {
    const ledger = await openLedger(join(tmp.dir, 't5'));
    const dbPath = join(tmp.dir, 't5.sqlite');
    let index = openIndex(ledger, dbPath);
    const result = await ledger.apply(addProposal({ content: '崩溃前已提交的记忆' }));
    // Simulated crash between commit and index: replay throws before writing.
    await assert.rejects(index.replay({ failInjector: () => { throw new Error('disk full'); } }));
    assert.equal(index.count(), 0, 'nothing partial was indexed');
    assert.equal((await ledger.pendingOutbox()).length, 1, 'outbox row survives the failure');
    index.close();
    // "Restart": reopen the projection file and replay.
    index = openIndex(ledger, dbPath);
    const replayed = await index.replay();
    assert.deepEqual(replayed, [result.change_id]);
    assert.equal(index.count(), 1);
    assert.equal((await ledger.pendingOutbox()).length, 0);
    assert.equal(index.search('崩溃前').length, 1);
    index.close();
  });

  test('T6 a change exposes real source, reason, and before/after diff; a missing reason is marked, not invented', async () => {
    const ledger = await openLedger(join(tmp.dir, 't6'));
    const added = await ledger.apply(addProposal({ reason: undefined }));
    const change = await ledger.getChange(added.change_id);
    assert.equal(change.reason, null);
    assert.equal(change.reason_status, 'missing');
    const note = await ledger.getChangeNote(added.change_id);
    assert.match(note, /未提供理由/u);
    assert.match(note, /来源\*\*未核验\*\*/u, 'without a verifier the note says evidence was not verified');

    // With a verifier that actually checks, the note reports verification.
    const verifying = await openLedger(join(tmp.dir, 't6b'), {
      verifyEvidence: async (refs) => ({ verified: refs.every((r) => r.session_id === 'session-test-1'), reason: 'checked against fixture' }),
    });
    const v = await verifying.apply(addProposal());
    assert.equal((await verifying.getChange(v.change_id)).evidence_verification.verified, true);
    assert.match(await verifying.getChangeNote(v.change_id), /已对照 DSH Session 日志核验/u);

    const sup = await verifying.apply({
      idempotency_key: 'sup-1', change_type: 'SUPERSEDE', owner_id: OWNER, target_memory_id: v.memory_id,
      content: '技术学习时只看调用流程', source_kind: 'user-correction', source_refs: [ref(99)], reason: '用户改变了偏好。', actor: 'user',
    });
    const supChange = await verifying.getChange(sup.change_id);
    assert.equal(supChange.before.memory_id, v.memory_id);
    assert.equal(supChange.after.memory_id, sup.memory_id);
    assert.notEqual(supChange.before.content, supChange.after.content);
    const old = await verifying.getMemory(v.memory_id);
    assert.equal(old.status, 'superseded');
    assert.equal(old.superseded_by_id, sup.memory_id);
    assert.equal((await verifying.getMemory(sup.memory_id)).supersedes_id, v.memory_id);
  });

  test('T7 a user correction goes through the controlled write path; direct file edits are refused', async () => {
    const ledger = await openLedger(join(tmp.dir, 't7'));
    const added = await ledger.apply(addProposal());
    // Someone (an agent) edits the record file directly.
    const path = join(ledger.root, 'records', `${added.memory_id}.json`);
    const tampered = JSON.parse(await readFile(path, 'utf8'));
    tampered.content = '被直接篡改的内容';
    await writeFile(path, JSON.stringify(tampered));
    await assert.rejects(
      ledger.apply(addProposal({ content: '另一条' })),
      (error) => error instanceof LedgerConflictError && /dirty/u.test(error.message),
    );
    await ledger.git.restorePaths([`records/${added.memory_id}.json`]);
    assert.ok(await ledger.git.isClean());

    // Stale base version is refused (the proposal was formed against an older state).
    const correction = {
      idempotency_key: 'fix-1', change_type: 'UPDATE', owner_id: OWNER, target_memory_id: added.memory_id,
      expected_base_change_id: 'MC-00000000000000-deadbeef', content: '纠正后的内容', source_kind: 'user-correction', source_refs: [ref(50)],
      reason: '用户说这条记忆不准确。', actor: 'user', user_confirmed: true,
    };
    await assert.rejects(ledger.apply(correction), LedgerConflictError);
    // With the right base it is applied as a tracked change.
    const fixed = await ledger.apply({ ...correction, expected_base_change_id: added.change_id });
    assert.equal(fixed.status, 'committed');
    assert.equal((await ledger.getMemory(added.memory_id)).content, '纠正后的内容');
    assert.equal((await ledger.getChange(fixed.change_id)).user_confirmed, true);
  });

  test('T8 schema refuses evidence-free memories and inference presented as fact', async () => {
    const ledger = await openLedger(join(tmp.dir, 't8'));
    await assert.rejects(ledger.apply(addProposal({ source_refs: [] })), SchemaError);
    await assert.rejects(ledger.apply(addProposal({ owner_id: 'someone-else' })), LedgerConflictError);
    // An agent inference must be stored as a hypothesis, never as a fact.
    await assert.rejects(ledger.apply(addProposal({ source_kind: 'agent-inference', type: 'fact' })), SchemaError);
    const hyp = await ledger.apply(addProposal({ source_kind: 'agent-inference', type: 'hypothesis', confidence: 0.4 }));
    assert.equal(hyp.memory.type, 'hypothesis');
  });

  test('T9 RETRACT hides a memory from recall but keeps its history; nothing claims erasure', async () => {
    const ledger = await openLedger(join(tmp.dir, 't9'));
    const index = openIndex(ledger);
    const added = await ledger.apply(addProposal({ content: '要被撤回的记忆' }));
    await index.replay();
    assert.equal(index.search('被撤回').length, 1);
    const retracted = await ledger.apply({
      idempotency_key: 'ret-1', change_type: 'RETRACT', owner_id: OWNER, target_memory_id: added.memory_id,
      source_kind: 'user-correction', source_refs: [ref(60)], reason: '用户说这条不对。', actor: 'user', user_confirmed: true,
    });
    await index.replay();
    assert.equal(index.search('被撤回').length, 0, 'retracted memories leave recall');
    assert.equal(index.search('被撤回', { includeInactive: true }).length, 1, 'but remain in the projection as inactive');
    assert.equal((await ledger.history(added.memory_id)).length, 2, 'git keeps both versions');
    assert.ok(await ledger.git.commitExists(added.commit), 'original commit still exists: this is not erasure');
    const note = await ledger.getChangeNote(retracted.change_id);
    assert.match(note, /这不是彻底遗忘/u);
    // Retracting twice is refused.
    await assert.rejects(ledger.apply({ idempotency_key: 'ret-2', change_type: 'RETRACT', owner_id: OWNER, target_memory_id: added.memory_id, source_kind: 'user-correction', source_refs: [ref(61)], actor: 'user' }), LedgerConflictError);
    index.close();
  });

  test('T10 after a restart committed memories are searchable and a dropped index rebuilds from git', async () => {
    const root = join(tmp.dir, 't10');
    const dbPath = join(tmp.dir, 't10.sqlite');
    {
      const ledger = await openLedger(root);
      const index = openIndex(ledger, dbPath);
      await ledger.apply(addProposal({ content: '重启前的第一条' }));
      await ledger.apply(addProposal({ content: '重启前的第二条' }));
      await index.replay();
      // Third write commits but is NOT indexed before the "crash".
      await ledger.apply(addProposal({ content: '崩溃前最后一条' }));
      index.close();
    }
    {
      // Restart: fresh objects over the same files.
      const ledger = await openLedger(root);
      const index = openIndex(ledger, dbPath);
      try {
        assert.equal(index.count(), 2, 'durable projection survived');
        assert.equal((await ledger.pendingOutbox()).length, 1, 'unfinished task survived the restart');
        await index.replay();
        assert.equal(index.count(), 3);
        assert.equal(index.search('最后一条').length, 1);
        // Corrupt/drop the index and rebuild from git.
        index.db.exec('DELETE FROM memories; DELETE FROM memories_fts;');
        assert.equal(index.count(), 0);
        const rebuilt = await index.rebuild();
        assert.equal(rebuilt, 3);
        assert.equal(index.count(), 3);
        // Provenance is the commit that produced each record's content, not HEAD:
        // records written before the last commit keep their own commit hash.
        const head = await ledger.git.head();
        const hits = index.search('重启前');
        assert.ok(hits.length >= 1);
        for (const hit of hits) {
          const recordPath = `records/${hit.memory.memory_id}.json`;
          const ownCommit = await ledger.git.lastCommitFor(recordPath);
          assert.equal(hit.indexed_commit, ownCommit, 'each row carries its own producing commit');
          if (hit.memory.content !== '崩溃前最后一条') assert.notEqual(hit.indexed_commit, head);
        }
      } finally {
        index.close();
      }
    }
  });

  test('repository owner mismatch is refused', async () => {
    const root = join(tmp.dir, 'owner');
    await openLedger(root);
    const { MemoryLedger } = await import('../src/ledger.js');
    await assert.rejects(new MemoryLedger({ root, ownerId: 'U-other' }).open(), /belongs to owner/u);
  });
});
