// P1/P2/P3/P4 hardening tests: committed-content authority, cross-process lock,
// lock recovery, rebuild provenance, and honest failure reporting.
import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LedgerConflictError } from '../src/ledger.js';
import { LedgerLockError, RepoLock, LOCK_DIR } from '../src/lock.js';
import { ProjectionIndex, UNKNOWN_COMMIT } from '../src/projection.js';
import { OWNER, addProposal, openIndex, openLedger, ref, tempDir, writerScript } from './helpers.js';

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [writerScript().pathname.replace(/^\/([A-Za-z]:)/u, '$1'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c) => { out += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        reject(new Error(`child produced no JSON (exit ${code}): ${out}\n${err}`));
        return;
      }
      resolve({ code, ...parsed });
    });
  });
}

describe('hardening: authoritative reads, locking, provenance', () => {
  let tmp;
  before(async () => { tmp = await tempDir('git-ledger-hardening-'); });
  after(async () => { await tmp.cleanup(); });

  // ---------- P1 ----------

  test('H1 an uncommitted hand edit never reaches reads or search', async () => {
    const ledger = await openLedger(join(tmp.dir, 'h1'));
    const index = openIndex(ledger);
    const added = await ledger.apply(addProposal({ content: '已提交的正式内容' }));
    await index.replay();
    assert.equal(index.search('已提交的正式内容').length, 1);

    // Tamper on disk, do not commit.
    const path = join(ledger.root, 'records', `${added.memory_id}.json`);
    const tampered = JSON.parse(await readFile(path, 'utf8'));
    tampered.content = '未提交的篡改内容';
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`);

    // Reads must serve the committed blob, not the working tree.
    assert.equal((await ledger.getMemory(added.memory_id)).content, '已提交的正式内容');
    const listed = await ledger.listMemories();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].content, '已提交的正式内容');
    // Existing projection still reflects the commit, never the edit.
    assert.equal(index.search('未提交的篡改内容').length, 0);
    assert.equal(index.search('已提交的正式内容').length, 1);

    // A writer refuses to build on the tampered tree, and says why.
    await assert.rejects(
      ledger.apply(addProposal({ content: '另一条' })),
      (error) => error instanceof LedgerConflictError && Array.isArray(error.details?.status) && error.details.status.some((line) => line.includes('records/')),
    );
    await ledger.git.restorePaths([`records/${added.memory_id}.json`]);
    assert.equal(await ledger.git.statusPorcelain(), '');
    index.close();
  });

  test('H1b an uncommitted NEW record file is invisible to readers', async () => {
    const ledger = await openLedger(join(tmp.dir, 'h1b'));
    await ledger.apply(addProposal({ content: '唯一的正式记忆' }));
    // A plausible-looking record that was never committed.
    await writeFile(join(ledger.root, 'records', 'M-20260101-fake0001.json'), `${JSON.stringify({
      memory_id: 'M-20260101-fake0001', owner_id: OWNER, layer: 'L1', type: 'fact', content: '未提交的伪造记忆',
      status: 'active', source_kind: 'user-explicit', confidence: 1, scope: 'global', tags: [], entities: [],
      source_refs: [ref(1)], valid_from: '2026-01-01T00:00:00.000Z', valid_to: null, supersedes_id: null,
      superseded_by_id: null, importance: 3, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      last_change_id: 'MC-20260101000000-fake0001',
    }, null, 2)}\n`);
    assert.equal((await ledger.listMemories()).length, 1, 'uncommitted file must not be listed');
    assert.equal(await ledger.getMemory('M-20260101-fake0001'), undefined, 'uncommitted file must not be readable');
    await unlink(join(ledger.root, 'records', 'M-20260101-fake0001.json'));
  });

  test('H1c a crashed write left in the tree cannot be read as official memory', async () => {
    const ledger = await openLedger(join(tmp.dir, 'h1c'));
    const added = await ledger.apply(addProposal({ content: '第一版内容' }));
    // Simulate "files written, commit never happened" for a pending UPDATE.
    const path = join(ledger.root, 'records', `${added.memory_id}.json`);
    const pending = JSON.parse(await readFile(path, 'utf8'));
    pending.content = '写到一半就崩溃的新内容';
    pending.last_change_id = 'MC-20260101000000-crash001';
    await writeFile(path, `${JSON.stringify(pending, null, 2)}\n`);
    assert.equal((await ledger.getMemory(added.memory_id)).content, '第一版内容', 'readers see the committed version');
    await ledger.git.restorePaths([`records/${added.memory_id}.json`]);
  });

  // ---------- P2 ----------

  test('H2 two independent processes writing concurrently both keep their committed updates', async () => {
    const root = join(tmp.dir, 'h2');
    await openLedger(root); // create + initialize the repository in this process
    const [a, b] = await Promise.all([
      runChild([root, OWNER, 'proc-a', '进程 A 写入的记忆', '0']),
      runChild([root, OWNER, 'proc-b', '进程 B 写入的记忆', '0']),
    ]);
    assert.equal(a.ok, true, `process A failed: ${JSON.stringify(a)}`);
    assert.equal(b.ok, true, `process B failed: ${JSON.stringify(b)}`);
    assert.notEqual(a.commit, b.commit, 'each writer produced its own commit');
    const ledger = await openLedger(root);
    const memories = await ledger.listMemories();
    const contents = memories.map((m) => m.content).sort();
    assert.deepEqual(contents, ['进程 A 写入的记忆', '进程 B 写入的记忆'].sort(), 'no committed update was lost');
    // Both commits are real and reachable, and neither overwrote the other.
    assert.ok(await ledger.git.commitExists(a.commit));
    assert.ok(await ledger.git.commitExists(b.commit));
    const history = await ledger.git.run(['log', '--format=%H']);
    assert.ok(history.includes(a.commit) && history.includes(b.commit));
    assert.equal(await ledger.git.statusPorcelain(), '', 'tree left clean');
  });

  test('H2b many ordered child writers produce one commit each and lose nothing', async () => {
    const root = join(tmp.dir, 'h2b');
    await openLedger(root);
    const children = [];
    for (let i = 0; i < 5; i += 1) {
      children.push(runChild([root, OWNER, `multi-${i}`, `并发批次记忆 ${i}`, String(i * 5)]));
    }
    const results = await Promise.all(children);
    for (const [i, result] of results.entries()) assert.equal(result.ok, true, `child ${i} failed: ${JSON.stringify(result)}`);
    const ledger = await openLedger(root);
    const memories = await ledger.listMemories();
    assert.equal(memories.length, 5);
    assert.deepEqual(memories.map((m) => m.content).sort(), [0, 1, 2, 3, 4].map((i) => `并发批次记忆 ${i}`).sort());
  });

  test('H2c lock contention is refused explicitly, never silently dropped', async () => {
    const root = join(tmp.dir, 'h2c');
    await openLedger(root);
    const holder = new RepoLock(root, { ttlMs: 60000 });
    await holder.acquire();
    const result = await runChild([root, OWNER, 'blocked', '被锁挡住', '0', '150']);
    assert.equal(result.ok, false, 'the blocked writer must fail loudly');
    assert.equal(result.name, 'LedgerLockError');
    assert.match(result.error, /locked by another writer/u);
    await holder.release();
    // The repository is unchanged by the refusal.
    const ledger = await openLedger(root);
    assert.equal((await ledger.listMemories()).length, 0);
    // After release the same proposal succeeds through the normal path.
    const retry = await runChild([root, OWNER, 'blocked', '被锁挡住', '0', '5000']);
    assert.equal(retry.ok, true, `retry failed: ${JSON.stringify(retry)}`);
  });

  test('H2d a crashed holder leaves a stale lock that the next writer reclaims', async () => {
    const root = join(tmp.dir, 'h2d');
    const ledger = await openLedger(root);
    // A lock directory whose owner is gone and whose TTL already expired.
    await mkdir(join(root, LOCK_DIR), { recursive: true });
    await writeFile(join(root, LOCK_DIR, 'owner.json'), JSON.stringify({
      token: 'dead-owner', pid: 999999, host: 'gone', acquired_at: 1, expires_at: 2,
    }));
    const result = await runChild([root, OWNER, 'after-crash', '崩溃后恢复写入', '0', '5000']);
    assert.equal(result.ok, true, `reclaim failed: ${JSON.stringify(result)}`);
    assert.equal((await ledger.listMemories()).length, 1);
    // The stale lock is gone and no stale leftovers remain.
    const leftovers = await ledger.git.statusPorcelain();
    assert.equal(leftovers, '');
  });

  test('H2d2 a lock directory with no owner record is never treated as free while fresh', async () => {
    const root = join(tmp.dir, 'h2d2');
    await openLedger(root);
    await mkdir(join(root, LOCK_DIR), { recursive: true });
    // Owner has not written itself yet (or died doing so): a fresh unattributed
    // lock directory must be respected, not stolen.
    const waiter = new RepoLock(root, { ttlMs: 60_000, timeoutMs: 0 });
    await assert.rejects(waiter.acquire(), LedgerLockError, 'a fresh unattributed lock is not free');
    // Once it is provably older than the TTL it is reclaimable.
    const aged = new RepoLock(root, { ttlMs: 50, timeoutMs: 0, now: () => Date.now() + 60_000 });
    const release = await aged.acquire();
    await release();
  });

  test('H2e a live lock is never stolen just because its TTL is close', async () => {
    const root = join(tmp.dir, 'h2e');
    await openLedger(root);
    let clock = 1_000;
    const holder = new RepoLock(root, { ttlMs: 1_000, now: () => clock });
    await holder.acquire();
    const waiter = new RepoLock(root, { ttlMs: 1_000, now: () => clock, timeoutMs: 0 });
    await assert.rejects(waiter.acquire(), LedgerLockError, 'a live lock must refuse the waiter');
    // The holder refreshes; the waiter still may not steal.
    clock = 1_500;
    await holder.heartbeat();
    clock = 1_900;
    const lateWaiter = new RepoLock(root, { ttlMs: 1_000, now: () => clock, timeoutMs: 0 });
    await assert.rejects(lateWaiter.acquire(), LedgerLockError, 'a refreshed lock stays owned');
    await holder.release();
    const after = new RepoLock(root, { ttlMs: 1_000, now: () => clock, timeoutMs: 0 });
    const release2 = await after.acquire();
    await release2();
  });

  test('H2f only the owner releases: a foreign token cannot delete a live lock', async () => {
    const root = join(tmp.dir, 'h2f');
    await openLedger(root);
    const holder = new RepoLock(root, { ttlMs: 60000 });
    await holder.acquire();
    const impostor = new RepoLock(root, { ttlMs: 60000 });
    await impostor.release(); // no token: no-op, must not remove the holder's lock
    assert.equal(await holder.isHeld(), true, 'the holder still owns the lock');
    await assert.rejects(
      new RepoLock(root, { ttlMs: 60000, timeoutMs: 0 }).acquire(),
      LedgerLockError,
    );
    await holder.release();
    assert.equal(await new RepoLock(root).isHeld(), false);
  });

  // ---------- P3 ----------

  test('H3 a deleted SQLite file rebuilds completely from git, twice with identical results', async () => {
    const root = join(tmp.dir, 'h3');
    const dbPath = join(tmp.dir, 'h3.sqlite');
    const ledger = await openLedger(root);
    const first = await ledger.apply(addProposal({ content: '重建目标一' }));
    const second = await ledger.apply(addProposal({ content: '重建目标二' }));
    await ledger.apply({
      idempotency_key: 'upd-h3', change_type: 'UPDATE', owner_id: OWNER, target_memory_id: first.memory_id,
      expected_base_change_id: first.change_id, content: '重建目标一（已更新）', source_kind: 'user-correction',
      source_refs: [ref(9)], reason: '重建测试。', actor: 'user',
    });

    let index = openIndex(ledger, dbPath);
    await index.replay();
    const before = index.list({ includeInactive: true, limit: 100 }).map((m) => ({ id: m.memory_id, content: m.content, commit: m.indexed_commit }));
    index.close();

    // Delete the projection entirely.
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true }).catch(() => {});
    await rm(`${dbPath}-shm`, { force: true }).catch(() => {});

    index = openIndex(ledger, dbPath);
    const rebuilt = await index.rebuild();
    assert.equal(rebuilt, 2);
    const afterFirst = index.list({ includeInactive: true, limit: 100 }).map((m) => ({ id: m.memory_id, content: m.content, commit: m.indexed_commit }));
    assert.deepEqual(afterFirst, before, 'rebuild reproduces the same rows and provenance as the live replay');
    // Idempotent: a second rebuild yields byte-identical rows.
    await index.rebuild();
    const afterSecond = index.list({ includeInactive: true, limit: 100 }).map((m) => ({ id: m.memory_id, content: m.content, commit: m.indexed_commit }));
    assert.deepEqual(afterSecond, afterFirst, 'two rebuilds agree');
    // Search works off the rebuilt index, and the updated version is the one found.
    assert.equal(index.search('重建目标一').length, 1);
    assert.match(index.search('重建目标一')[0].memory.content, /已更新/u);
    index.close();
    // git is untouched by all of that.
    assert.equal((await ledger.getMemory(second.memory_id)).content, '重建目标二');
  });

  test('H3b provenance is the commit that produced the content, not HEAD', async () => {
    const root = join(tmp.dir, 'h3b');
    const ledger = await openLedger(root);
    const a = await ledger.apply(addProposal({ content: '记录 A 的原始版本' }));
    const targetCommit = await ledger.git.lastCommitFor(`records/${a.memory_id}.json`);
    assert.equal(targetCommit, a.commit);
    // An unrelated later commit moves HEAD but must not change A's provenance.
    const b = await ledger.apply(addProposal({ content: '记录 B' }));
    assert.notEqual(b.commit, targetCommit);
    const index = openIndex(ledger);
    await index.rebuild();
    assert.equal(index.get(a.memory_id).indexed_commit, targetCommit, 'A keeps its own commit');
    assert.equal(index.get(b.memory_id).indexed_commit, b.commit);
    index.close();
  });

  test('H3c an unattributable record is stamped unknown, never a fake HEAD', async () => {
    const root = join(tmp.dir, 'h3c');
    const ledger = await openLedger(root);
    await ledger.apply(addProposal({ content: '可归属的记录' }));
    // Make git unable to attribute any record path to a commit.
    const realLastCommit = ledger.git.lastCommitFor.bind(ledger.git);
    ledger.git.lastCommitFor = async () => undefined;
    const index = openIndex(ledger);
    await index.rebuild();
    assert.equal(index.count(), 1);
    assert.equal(index.get(index.list()[0].memory_id).indexed_commit, UNKNOWN_COMMIT);
    ledger.git.lastCommitFor = realLastCommit;
    // Restoring the ability restores exact provenance.
    await index.rebuild();
    assert.notEqual(index.get(index.list()[0].memory_id).indexed_commit, UNKNOWN_COMMIT);
    index.close();
  });

  test('H3d a rebuild failure does not damage committed memory', async () => {
    const root = join(tmp.dir, 'h3d');
    const ledger = await openLedger(root);
    const added = await ledger.apply(addProposal({ content: '重建失败也要保住' }));
    const index = openIndex(ledger);
    await index.replay();
    const realShow = ledger.git.showOrUndefined.bind(ledger.git);
    ledger.git.showOrUndefined = async () => { throw new Error('simulated read failure during rebuild'); };
    await assert.rejects(index.rebuild(), /simulated read failure/u);
    ledger.git.showOrUndefined = realShow;
    assert.equal((await ledger.getMemory(added.memory_id)).content, '重建失败也要保住');
    assert.ok(await ledger.git.commitExists(added.commit));
    await index.rebuild();
    assert.equal(index.count(), 1);
    index.close();
  });

  // ---------- general honesty ----------

  test('H4 an exceptional repository state never reports a successful write', async () => {
    const root = join(tmp.dir, 'h4');
    const ledger = await openLedger(root);
    await ledger.apply(addProposal({ content: '基线' }));
    // Break the git command so the commit cannot complete.
    const realCommit = ledger.git.commitPaths.bind(ledger.git);
    ledger.git.commitPaths = async () => { throw new Error('git unavailable'); };
    await assert.rejects(ledger.apply(addProposal({ content: '不应写入 ' })), /not committed/u);
    ledger.git.commitPaths = realCommit;
    assert.equal((await ledger.listMemories()).length, 1);
    assert.equal(await ledger.git.statusPorcelain(), '', 'no debris left behind');
    // Idempotency key of the failed attempt was not consumed.
    assert.equal(await ledger.receiptFor(addProposal().idempotency_key), undefined);
    const ok = await ledger.apply(addProposal({ content: '恢复后写入' }));
    assert.equal(ok.status, 'committed');
  });

  test('H5 a pending lock file is ignored by the memory repository itself', async () => {
    const root = join(tmp.dir, 'h5');
    const ledger = await openLedger(root);
    await ledger.apply(addProposal({ content: '锁文件不应弄脏仓库' }));
    const release = await ledger.lock.acquire();
    try {
      assert.equal(await ledger.git.statusPorcelain(), '', 'the lock file is gitignored and blocks nothing');
    } finally {
      await release();
    }
    const again = await ledger.apply(addProposal({ content: '持锁期间之外仍可写入' }));
    assert.equal(again.status, 'committed');
  });
});
