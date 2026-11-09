// Retract vs. erase (§8.3, phase 5.4).
//
// Two different promises, and the difference matters to a user asking for
// deletion:
//
//   retract  stops retrieval and injection, keeps the Git history. Reversible,
//            and the text is still in the repository.
//   erase    removes the text. This module implements what it can actually
//            reach: the ledger's working tree and the runtime copies (candidate
//            queue, objections, proposals, injection audit). It also rewrites
//            the Git history, and then says plainly that rewritten history is
//            not the same as "every copy is gone" — backups and anything
//            already exported are outside its reach (§8.3: "不能宣称重写 Git
//            历史就自动删除了所有副本").
//
// The honesty requirement is the point. A user who clicks "delete" and is told
// "已抑制" (suppressed) has been misled: the memory is still readable through
// /state, /history and /export. So this module never reports a stronger result
// than it achieved, and `describeErasure` names every place a copy could remain.

export const ERASE_SCOPES = Object.freeze(['ledger', 'runtime', 'history']);

/**
 * What a user request for deletion can actually do here.
 *
 * `delete` is a correction kind that only records an objection; it must not be
 * presented as an erasure. This maps the request onto the operation that would
 * honour it, or reports that none does.
 */
export function deletionIntent({ kind } = {}) {
  if (kind === 'delete' || kind === 'should_not_save') {
    return { erase: false, retract: false, reason: 'objection-only' };
  }
  return { erase: false, retract: false, reason: 'not-a-deletion' };
}

/**
 * Which copies of a memory the eraser can reach, and which it cannot.
 *
 * Returned as data rather than prose so the panel and the tests read the same
 * list. `reachable` entries are the ones `eraseMemory` actually removes.
 */
export function describeErasure() {
  return {
    reachable: [
      { scope: 'ledger', detail: 'records/ and changes/ in the Git working tree' },
      { scope: 'history', detail: 'Git commits that contained the text (history is rewritten)' },
      { scope: 'runtime', detail: 'candidates, objections, proposals and injection audit rows naming it' },
    ],
    // Named so nobody has to guess why a "delete" may still leave a copy behind.
    unreachable: [
      { scope: 'backup', detail: 'any backup, clone or snapshot of the repository taken earlier' },
      { scope: 'export', detail: 'anything already exported through /export' },
      { scope: 'session-log', detail: 'the DSH session log the evidence points at' },
    ],
  };
}

/**
 * May this memory be erased, and what should the caller be told?
 *
 * A memory that other memories point at (supersede chains) is still erasable:
 * the erasure reports which neighbours lose a link, rather than refusing or
 * silently breaking the chain.
 */
export function planErasure({ memory, memories = [] } = {}) {
  if (memory === null || typeof memory !== 'object' || typeof memory.id !== 'string' || memory.id === '') {
    return { allowed: false, reason: 'memory-unavailable' };
  }
  const neighbours = memories.filter((entry) => entry !== null
    && typeof entry === 'object'
    && entry.id !== memory.id
    && (entry.supersedes_id === memory.id || entry.superseded_by_id === memory.id));
  return {
    allowed: true,
    reason: null,
    memoryId: memory.id,
    // Reported, not hidden: erasing one end of a chain leaves the other end
    // pointing at an id that no longer exists.
    danglingNeighbours: neighbours.map((entry) => entry.id),
  };
}

/** A short, truthful sentence for the panel and for the model. */
export function describeErasureResult({ erased = false, scopes = [], danglingNeighbours = [], error = null } = {}) {
  if (error !== null) return { ok: false, message: `未能删除：${error}` };
  if (!erased) return { ok: false, message: '没有删除任何内容。' };
  const parts = [];
  if (scopes.includes('ledger')) parts.push('账本记录已移除');
  if (scopes.includes('history')) parts.push('Git 历史已重写');
  if (scopes.includes('runtime')) parts.push('运行时副本已清理');
  const dangling = danglingNeighbours.length === 0
    ? ''
    : ` 另有 ${danglingNeighbours.length} 条记忆仍指向它。`;
  return {
    ok: true,
    message: `${parts.join('，') || '已处理'}。${dangling} 备份、已导出的数据和会话日志中的副本不在清理范围内。`,
  };
}
