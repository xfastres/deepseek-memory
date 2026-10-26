// MemoryLedger: the single writer of the Git memory repository.
//
// Layout inside <repoRoot>:
//   manifest.json                      ledger format version + owner
//   records/<memory_id>.json           current record (one file per memory)
//   changes/<change_id>.json           structured change (what/why/evidence/commit)
//   changes/<change_id>.md             human-readable explanation of the same change
//   applied/<idempotency_key_sha>.json idempotency receipt -> change_id, commit
//
// Rules:
//   * Only `apply()` writes to records/ or changes/. Agents never edit files.
//   * A change exists only after `git commit` returned a real hash.
//   * Idempotency: the same idempotency_key returns the earlier receipt and
//     performs no second commit.
//   * Base-version check: UPDATE/RETRACT/SUPERSEDE must name the target's
//     current `last_change_id` (or omit it to accept the latest).
//   * The projection (SQLite) is downstream. The ledger emits a queued outbox
//     row per commit; `ProjectionIndex.replay()` drains it. A crash between
//     commit and index is repaired by replay.

import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitRepo, GitError } from './git.js';
import { RepoLock } from './lock.js';
import {
  CATEGORY_TO_TYPE,
  SchemaError,
  canonicalJson,
  newChangeId,
  newMemoryId,
  sha256,
  validateMemory,
  validateProposal,
} from './schema.js';

export const LEDGER_FORMAT_VERSION = 1;

export class LedgerConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'LedgerConflictError';
    this.details = details;
  }
}

export class EvidenceError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'EvidenceError';
    this.details = details;
  }
}

function recordPath(memoryId) {
  return `records/${memoryId}.json`;
}
function changePath(changeId) {
  return `changes/${changeId}.json`;
}
function changeNotePath(changeId) {
  return `changes/${changeId}.md`;
}
function receiptPath(idempotencyKey) {
  return `applied/${sha256(idempotencyKey)}.json`;
}

/** Default evidence check: refs must be well-formed; the caller may supply a real Session verifier. */
const acceptAllEvidence = async () => ({ verified: false, reason: 'no session verifier configured' });

export class MemoryLedger {
  /**
   * @param {object} options
   * @param {string} options.root absolute path of the memory repository
   * @param {string} options.ownerId trusted owner identity for this repository (one repo per owner)
   * @param {(refs: Array<{session_id:string,event_seq:number}>, signal?: AbortSignal) => Promise<{verified:boolean, reason?:string, missing?:Array<object>}>} [options.verifyEvidence]
   * @param {() => Date} [options.now]
   * @param {GitRepo} [options.git]
   * @param {(entry: object) => Promise<void>} [options.onCommitted] called after a successful commit, before the outbox row is considered delivered
   */
  constructor(options) {
    this.root = options.root;
    this.ownerId = options.ownerId;
    this.verifyEvidence = options.verifyEvidence ?? acceptAllEvidence;
    this.now = options.now ?? (() => new Date());
    this.git = options.git ?? new GitRepo(options.root, { identity: options.identity, command: options.gitCommand });
    this.queue = Promise.resolve();
    this.lock = new RepoLock(options.root, {
      timeoutMs: options.lockTimeoutMs,
      ttlMs: options.lockTtlMs,
      now: options.lockNow ?? (() => Date.now()),
    });
  }

  async open() {
    await this.git.init();
    for (const dir of ['records', 'changes', 'applied', 'outbox']) await mkdir(join(this.root, dir), { recursive: true });
    const manifestPath = join(this.root, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      manifest = { format_version: LEDGER_FORMAT_VERSION, owner_id: this.ownerId, created_at: this.now().toISOString() };
      await writeFile(manifestPath, canonicalJson(manifest));
      // applied/ and outbox/ are local operational state, not memory content: they stay out of history.
      // .ledger-lock (dir), stale-lock leftovers and the SQLite projection are operational too.
      await writeFile(join(this.root, '.gitignore'), 'applied/\noutbox/\n.ledger-lock/\n.ledger-lock.stale-*\n*.sqlite\n*.sqlite-*\n');
      await this.git.commitPaths(['manifest.json', '.gitignore'], 'ledger: initialize memory repository\n');
    }
    if (manifest.format_version !== LEDGER_FORMAT_VERSION) {
      throw new Error(`memory repository format ${manifest.format_version} is not supported by this ledger (${LEDGER_FORMAT_VERSION})`);
    }
    if (manifest.owner_id !== this.ownerId) {
      throw new Error(`memory repository belongs to owner ${manifest.owner_id}, not ${this.ownerId}`);
    }
    return this;
  }

  // ---------- reads: COMMITTED CONTENT ONLY ----------
  //
  // Every read resolves through `git show <commit>:<path>`, never the working
  // tree. A hand-edited, uncommitted record therefore cannot surface as an
  // official memory, and a partially applied write (crash before commit) is
  // invisible to readers.

  /** The commit all reads resolve against: HEAD. */
  async readHead() {
    const head = await this.git.head();
    if (head === null) return null;
    return head;
  }

  async getMemory(memoryId, { commit } = {}) {
    const base = commit ?? (await this.readHead());
    if (base === null) return undefined;
    const raw = await this.git.showOrUndefined(base, recordPath(memoryId));
    if (raw === undefined) return undefined;
    return validateMemory(JSON.parse(raw));
  }

  async listMemories({ includeInactive = false, commit } = {}) {
    const base = commit ?? (await this.readHead());
    if (base === null) return [];
    const paths = (await this.git.lsTree(base, 'records/')).filter((path) => path.endsWith('.json'));
    const out = [];
    for (const path of paths) {
      const raw = await this.git.showOrUndefined(base, path);
      if (raw === undefined) continue;
      const memory = validateMemory(JSON.parse(raw));
      if (includeInactive || memory.status === 'active') out.push(memory);
    }
    return out.sort((a, b) => a.memory_id.localeCompare(b.memory_id));
  }

  async getChange(changeId, { commit } = {}) {
    const base = commit ?? (await this.readHead());
    if (base === null) return undefined;
    const raw = await this.git.showOrUndefined(base, changePath(changeId));
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  async getChangeNote(changeId, { commit } = {}) {
    const base = commit ?? (await this.readHead());
    if (base === null) return undefined;
    return this.git.showOrUndefined(base, changeNotePath(changeId));
  }

  /** Every change that touched one memory, oldest first, with the committed record at each point. */
  async history(memoryId) {
    const commits = (await this.git.log(recordPath(memoryId))).reverse();
    const out = [];
    for (const commit of commits) {
      const record = JSON.parse(await this.git.show(commit.hash, recordPath(memoryId)));
      const change = await this.getChange(record.last_change_id, { commit: commit.hash });
      out.push({ commit: commit.hash, committed_at: commit.time, change_id: record.last_change_id, record, change });
    }
    return out;
  }

  async receiptFor(idempotencyKey) {
    try {
      return JSON.parse(await readFile(join(this.root, receiptPath(idempotencyKey)), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  // ---------- the write path ----------

  /**
   * Apply one proposal. Serialized per ledger AND across processes by the
   * repository lock. Returns
   * `{ status: 'committed' | 'replayed', change_id, commit, memory_id, memory }`.
   *
   * The lock is held from the working-tree check through `git commit`, so the
   * check→commit window cannot be entered by a second writer.
   */
  apply(proposalInput, { signal } = {}) {
    const run = this.queue.then(() => this.applyLocked(proposalInput, signal));
    this.queue = run.catch(() => {});
    return run;
  }

  async applyLocked(proposalInput, signal) {
    const proposal = validateProposal(proposalInput);
    if (proposal.owner_id !== this.ownerId) {
      throw new LedgerConflictError('proposal owner does not match this repository owner', { owner_id: proposal.owner_id });
    }

    // 1. Idempotency first: a replayed key returns the earlier receipt and does
    //    nothing else — no lock, no write, no second commit.
    const prior = await this.receiptFor(proposal.idempotency_key);
    if (prior !== undefined) {
      return { status: 'replayed', ...prior, memory: await this.getMemory(prior.memory_id, { commit: prior.commit }) };
    }

    // 2. Cross-process exclusivity covers the whole check→write→commit window.
    const release = await this.lock.acquire();
    try {
      return await this.applyUnderLock(proposal, signal);
    } finally {
      await release();
    }
  }

  async applyUnderLock(proposal, signal) {
    // Re-check idempotency under the lock: another process may have committed
    // this exact key while we waited for it.
    const raced = await this.receiptFor(proposal.idempotency_key);
    if (raced !== undefined) {
      return { status: 'replayed', ...raced, memory: await this.getMemory(raced.memory_id, { commit: raced.commit }) };
    }

    // 3. The working tree must equal HEAD. Untracked leftovers and hand edits
    //    are refused with the offending paths, never silently overwritten.
    const dirty = await this.git.statusPorcelain();
    if (dirty !== '') {
      throw new LedgerConflictError('memory repository working tree is dirty; refusing to write over unknown changes', {
        status: dirty.split('\n').slice(0, 20),
      });
    }

    // 4. Evidence: refs are required by schema; verification result is recorded, never invented.
    const evidence = await this.verifyEvidence(proposal.source_refs, signal);

    // 4. Resolve the target and check the base version.
    const now = this.now().toISOString();
    let before;
    if (proposal.change_type !== 'ADD') {
      before = await this.getMemory(proposal.target_memory_id);
      if (before === undefined) throw new LedgerConflictError(`target memory ${proposal.target_memory_id} does not exist`);
      if (proposal.expected_base_change_id !== null && proposal.expected_base_change_id !== before.last_change_id) {
        throw new LedgerConflictError('target memory changed since the proposal was formed', {
          expected: proposal.expected_base_change_id,
          actual: before.last_change_id,
        });
      }
      if (before.status !== 'active' && proposal.change_type !== 'UPDATE') {
        throw new LedgerConflictError(`target memory ${before.memory_id} is already ${before.status}`);
      }
    }

    // 5. Compute the after-state (pure).
    const changeId = newChangeId(this.now());
    const touched = [];
    const records = [];
    let after;
    let supersededRecord;
    if (proposal.change_type === 'ADD') {
      after = validateMemory({
        memory_id: newMemoryId(this.now()),
        owner_id: this.ownerId,
        layer: 'L1',
        type: proposal.type ?? 'fact',
        content: proposal.content,
        status: 'active',
        source_kind: proposal.source_kind,
        confidence: proposal.confidence,
        scope: proposal.scope,
        tags: proposal.tags,
        entities: proposal.entities,
        source_refs: proposal.source_refs,
        valid_from: now,
        valid_to: null,
        supersedes_id: null,
        superseded_by_id: null,
        importance: proposal.importance,
        created_at: now,
        updated_at: now,
        last_change_id: changeId,
      });
    } else if (proposal.change_type === 'UPDATE') {
      after = validateMemory({
        ...before,
        content: proposal.content,
        type: proposal.type ?? before.type,
        status: 'active',
        source_kind: proposal.source_kind,
        confidence: proposal.confidence,
        scope: proposal.scope ?? before.scope,
        tags: proposal.tags.length > 0 ? proposal.tags : before.tags,
        entities: proposal.entities.length > 0 ? proposal.entities : before.entities,
        source_refs: dedupeRefs([...before.source_refs, ...proposal.source_refs]),
        importance: proposal.importance ?? before.importance,
        updated_at: now,
        last_change_id: changeId,
      });
    } else if (proposal.change_type === 'RETRACT') {
      after = validateMemory({ ...before, status: 'retracted', valid_to: now, updated_at: now, last_change_id: changeId });
    } else {
      // SUPERSEDE: close the old record, create a new one that points back.
      after = validateMemory({
        memory_id: newMemoryId(this.now()),
        owner_id: this.ownerId,
        layer: 'L1',
        type: proposal.type ?? before.type,
        content: proposal.content,
        status: 'active',
        source_kind: proposal.source_kind,
        confidence: proposal.confidence,
        scope: proposal.scope ?? before.scope,
        tags: proposal.tags.length > 0 ? proposal.tags : before.tags,
        entities: proposal.entities.length > 0 ? proposal.entities : before.entities,
        source_refs: proposal.source_refs.length > 0 ? proposal.source_refs : before.source_refs,
        valid_from: now,
        valid_to: null,
        supersedes_id: before.memory_id,
        superseded_by_id: null,
        importance: proposal.importance ?? before.importance,
        created_at: now,
        updated_at: now,
        last_change_id: changeId,
      });
      supersededRecord = validateMemory({
        ...before,
        status: 'superseded',
        valid_to: now,
        superseded_by_id: after.memory_id,
        updated_at: now,
        last_change_id: changeId,
      });
      records.push(supersededRecord);
    }
    records.push(after);

    // 6. The structured change and its explanation. Reason comes from the
    //    proposal; absence is recorded as such rather than invented.
    const change = {
      change_id: changeId,
      change_type: proposal.change_type,
      owner_id: this.ownerId,
      actor: proposal.actor,
      user_confirmed: proposal.user_confirmed,
      idempotency_key: proposal.idempotency_key,
      target_memory_id: proposal.change_type === 'ADD' ? after.memory_id : before.memory_id,
      result_memory_id: after.memory_id,
      base_change_id: before?.last_change_id ?? null,
      before: before === undefined ? null : summarize(before),
      after: summarize(after),
      reason: proposal.reason ?? null,
      reason_status: proposal.reason === undefined ? 'missing' : 'supplied',
      source_refs: proposal.source_refs,
      evidence_verification: evidence,
      created_at: now,
      commit: null, // filled after git commit
      reverted_by_change_id: null,
    };

    // 7. Write files, commit, then fill the commit into the change file in the same commit
    //    is impossible (hash depends on content), so the commit hash lives in
    //    applied/ receipt + outbox + the NEXT change's base; `history()` resolves
    //    hashes from git log. We also amend nothing: commits are immutable.
    for (const record of records) {
      const path = recordPath(record.memory_id);
      await writeFile(join(this.root, path), canonicalJson(record));
      touched.push(path);
    }
    await writeFile(join(this.root, changePath(changeId)), canonicalJson(change));
    await writeFile(join(this.root, changeNotePath(changeId)), renderChangeNote(change, before, after, supersededRecord));
    touched.push(changePath(changeId), changeNotePath(changeId));

    let commit;
    try {
      // Keep the lock alive across a slow commit so a waiter does not reclaim it.
      await this.lock.heartbeat();
      commit = await this.git.commitPaths(touched, commitMessage(change), { signal });
    } catch (error) {
      await this.git.restorePaths(touched);
      // Surface the underlying git failure: a swallowed cause is indistinguishable
      // from a silent success elsewhere.
      throw new GitError(`memory change ${changeId} was not committed; nothing was recorded (${error?.message ?? error})`, {
        args: error?.args,
        exitCode: error?.exitCode,
        stderr: error?.stderr,
      });
    }

    // 8. Receipt (idempotency) and outbox (projection). Both are outside git history on purpose.
    const receipt = { change_id: changeId, commit, memory_id: after.memory_id, change_type: proposal.change_type, committed_at: now };
    await writeFile(join(this.root, receiptPath(proposal.idempotency_key)), canonicalJson(receipt));
    await writeFile(join(this.root, 'outbox', `${changeId}.json`), canonicalJson({ ...receipt, memory_ids: records.map((r) => r.memory_id) }));
    return { status: 'committed', ...receipt, memory: after };
  }

  // ---------- outbox for the projection ----------

  async pendingOutbox() {
    const names = (await readdir(join(this.root, 'outbox'))).filter((n) => n.endsWith('.json'));
    const entries = [];
    for (const name of names) entries.push(JSON.parse(await readFile(join(this.root, 'outbox', name), 'utf8')));
    // Replay MUST follow the real commit order. Lexicographic change_id order is
    // wrong for two changes in the same second (random suffix): the UPDATE could
    // apply before the ADD and silently resurrect the old content. git log order
    // is the authority.
    const order = new Map();
    let position = 0;
    for (const commit of (await this.git.run(['log', '--reverse', '--format=%H'])).split('\n').filter(Boolean)) {
      order.set(commit.trim(), position);
      position += 1;
    }
    entries.sort((a, b) => (order.get(a.commit) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.commit) ?? Number.MAX_SAFE_INTEGER));
    return entries;
  }

  async ackOutbox(changeId) {
    await rm(join(this.root, 'outbox', `${changeId}.json`), { force: true });
  }

  /** Mnemon `remember` input -> ledger ADD proposal. Kept here so the mapping is testable without Cordis. */
  static proposalFromRemember(request, { ownerId, idempotencyKey, sourceRefs, reason, actor = 'agent' }) {
    const sourceKind = request.source === 'user' ? 'user-explicit' : request.source === 'external' ? 'session-extraction' : 'agent-inference';
    const type = sourceKind === 'agent-inference' ? 'hypothesis' : (CATEGORY_TO_TYPE[request.category ?? 'general'] ?? 'fact');
    return {
      idempotency_key: idempotencyKey,
      change_type: 'ADD',
      owner_id: ownerId,
      content: request.content,
      type,
      source_kind: sourceKind,
      importance: request.importance ?? 3,
      tags: request.tags ?? [],
      entities: request.entities ?? [],
      source_refs: sourceRefs,
      reason,
      actor,
    };
  }
}

function dedupeRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.session_id}#${ref.event_seq}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarize(memory) {
  return {
    memory_id: memory.memory_id,
    type: memory.type,
    status: memory.status,
    content: memory.content,
    confidence: memory.confidence,
    scope: memory.scope,
    valid_from: memory.valid_from,
    valid_to: memory.valid_to,
    last_change_id: memory.last_change_id,
  };
}

function commitMessage(change) {
  // No memory content in the subject: subjects leak into reflogs and tooling.
  return `memory(${change.change_type.toLowerCase()}): ${change.result_memory_id}\n\nchange_id: ${change.change_id}\nactor: ${change.actor}\nuser_confirmed: ${change.user_confirmed}\n`;
}

/** The user-facing explanation. Every sentence is derived from the change; nothing is generated. */
export function renderChangeNote(change, before, after, superseded) {
  const lines = [];
  lines.push(`# 记忆变更 ${change.change_id}`, '');
  lines.push(`- 类型：${change.change_type}`);
  lines.push(`- 执行者：${change.actor}${change.user_confirmed ? '（用户已确认）' : '（未经用户确认）'}`);
  lines.push(`- 时间：${change.created_at}`);
  lines.push(`- 影响的记忆：${[change.target_memory_id, change.result_memory_id].filter((v, i, a) => a.indexOf(v) === i).join(', ')}`);
  lines.push('', '## 改了什么', '');
  if (before === undefined) {
    lines.push(`新增一条 ${after.type} 记忆：`, '', `> ${after.content}`);
  } else if (change.change_type === 'RETRACT') {
    lines.push(`撤回记忆 ${before.memory_id}，它此后不再参与召回：`, '', `> ${before.content}`);
  } else if (change.change_type === 'SUPERSEDE') {
    lines.push(`记忆 ${superseded.memory_id} 被新记忆 ${after.memory_id} 取代。`, '', '旧：', '', `> ${before.content}`, '', '新：', '', `> ${after.content}`);
  } else {
    lines.push('旧：', '', `> ${before.content}`, '', '新：', '', `> ${after.content}`);
    if (before.type !== after.type) lines.push('', `类型由 ${before.type} 改为 ${after.type}。`);
  }
  lines.push('', '## 为什么改', '');
  lines.push(change.reason ?? '**未提供理由。** 该变更的提案没有附带理由；系统不会代为补造。');
  lines.push('', '## 来源证据', '');
  if (change.source_refs.length === 0) lines.push('（无新增来源引用）');
  for (const ref of change.source_refs) lines.push(`- Session \`${ref.session_id}\` 事件 #${ref.event_seq}${ref.event_type ? ` (${ref.event_type})` : ''}`);
  const ev = change.evidence_verification;
  lines.push('', ev.verified ? '来源已对照 DSH Session 日志核验。' : `来源**未核验**：${ev.reason ?? '未知原因'}。`);
  lines.push('', '## 对后续检索与回答的影响', '');
  if (change.change_type === 'RETRACT') lines.push('该记忆退出有效集合，不再被检索命中，历史版本保留在 Git 中。');
  else if (change.change_type === 'SUPERSEDE') lines.push('旧记忆标记为 superseded，不再被检索命中；新记忆成为有效版本。');
  else lines.push(`新内容成为有效版本并进入检索索引（置信度 ${after.confidence}，适用范围 ${after.scope}）。`);
  lines.push('', '## 如何纠正或撤销', '');
  lines.push(`- 若内容有误：提交一个 UPDATE 或 SUPERSEDE 提案，目标 \`${after.memory_id}\`，并指定 expected_base_change_id=\`${change.change_id}\`。`);
  lines.push(`- 若整条不该存在：提交 RETRACT 提案，目标 \`${after.memory_id}\`。`);
  lines.push('- 以上操作都保留 Git 历史；这不是彻底遗忘。彻底清除需要单独的 FORGET 流程（本阶段未实现）。');
  lines.push('');
  return lines.join('\n');
}

export { SchemaError, GitError };
export { LedgerLockError } from './lock.js';
