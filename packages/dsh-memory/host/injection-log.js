import { createHash } from 'node:crypto';

/**
 * Logical injection records.
 *
 * A provider call is not an injection: the host may call the same provider more
 * than once per step, and a provider that returns nothing injected nothing. So
 * this module counts calls separately from records, and a record only exists
 * once text actually came back.
 */

export const KEY_PREFIX = 'sha256:';
const SEPARATOR = '\u0000';

/** Full SHA-256 of the exact UTF-8 bytes, never a prefix. */
export function digestOf(text) {
  return `${KEY_PREFIX}${createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')}`;
}

function normaliseIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))].sort();
}

/**
 * Copy the budget split without trusting its shape.
 *
 * This runs inside the prompt provider, so a throw here does not merely lose an
 * audit row: the provider catches it and returns an empty string, which silently
 * removes the whole memory block from that turn. Reading `pools.constraint.budget`
 * unguarded did exactly that for any partial pools object. A missing pool is
 * reported as null rather than guessed at.
 */
function readPool(pool) {
  if (pool === null || typeof pool !== 'object') return null;
  const budget = Number.isFinite(pool.budget) ? pool.budget : null;
  const used = Number.isFinite(pool.used) ? pool.used : null;
  if (budget === null && used === null) return null;
  return { budget, used };
}

function readPools(pools) {
  if (pools === null || typeof pools !== 'object') return null;
  const constraint = readPool(pools.constraint);
  const dynamic = readPool(pools.dynamic);
  if (constraint === null && dynamic === null) return null;
  return { constraint, dynamic };
}

/**
 * The identity of one logical injection.
 *
 * The memory set is sorted so a different selection order cannot produce a
 * second record. The final text is digested, not the selection, because the
 * selection is not what reached the prompt.
 */
export function buildInjectionKey({ sessionId, turn, snapshotHead, memoryIds, text } = {}) {
  const parts = [
    typeof sessionId === 'string' ? sessionId : '',
    Number.isInteger(turn) ? String(turn) : '',
    typeof snapshotHead === 'string' ? snapshotHead : '',
    normaliseIds(memoryIds).join(','),
    digestOf(text),
  ];
  return `${KEY_PREFIX}${createHash('sha256').update(parts.join(SEPARATOR), 'utf8').digest('hex')}`;
}

/**
 * How many records the in-memory log keeps.
 *
 * Nothing reads old records from here: the audit trail is persisted through the
 * runtime store (`/injections` reads that), and `pendingRecords()` only needs the
 * ones not yet flushed. Keeping every record of a long session was a slow leak —
 * one small object per provider call, forever, in the Host process. The cap is
 * far above any realistic unflushed backlog, and dropping the oldest is safe
 * because those were already flushed.
 */
export const MAX_IN_MEMORY_RECORDS = 500;

/**
 * @param {{now?: () => Date}} [options]
 */
export function createInjectionLog(options = {}) {
  const now = options.now ?? (() => new Date());
  const records = [];
  const byKey = new Map();
  const counters = { calls: 0, empty: 0, dropped: 0 };

  /**
   * Forget the oldest records once the cap is reached.
   *
   * `byKey` is pruned in the same pass, so a duplicate detection for a very old
   * block simply misses and starts a fresh record instead of resurrecting a
   * dropped one. Losing that merge is harmless: it can only happen after
   * hundreds of newer injections.
   */
  function trim() {
    if (records.length <= MAX_IN_MEMORY_RECORDS) return;
    const excess = records.length - MAX_IN_MEMORY_RECORDS;
    const removed = records.splice(0, excess);
    for (const record of removed) {
      if (byKey.get(record.key) === record) byKey.delete(record.key);
    }
    counters.dropped += removed.length;
  }

  /**
   * One provider call.
   *
   * Merging happens at the turn, and the record says so: the provider is never
   * told which step it is serving, so claiming per-step records would be
   * invention. Repeated calls inside a turn increment `occurrences` instead of
   * appending a second record.
   */
  function note(input = {}) {
    counters.calls += 1;
    const text = typeof input.text === 'string' ? input.text : '';
    if (text === '') {
      counters.empty += 1;
      return { record: null, duplicate: false };
    }
    const key = buildInjectionKey({ ...input, text });
    const at = now().toISOString();
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.occurrences += 1;
      existing.last_at = at;
      return { record: existing, duplicate: true };
    }
    const record = {
      // A monotonic sequence lets a reader say "everything up to N is done"
      // without depending on array position, which trimming can change.
      seq: (counters.dropped + records.length) + 1,
      key,
      scope: 'turn',
      step: null,
      // 'returned' means this call produced non-empty text for the host. There is
      // no 'prepared' record: preparation and return are the same synchronous
      // call, so a separate state would be a claim we cannot observe.
      state: input.state === 'prepared' ? 'prepared' : 'returned',
      confirmed: null,
      evidence: null,
      session_id: typeof input.sessionId === 'string' ? input.sessionId : null,
      turn: Number.isInteger(input.turn) ? input.turn : null,
      snapshot_head: typeof input.snapshotHead === 'string' ? input.snapshotHead : null,
      memory_ids: normaliseIds(input.memoryIds),
      // Why each entry was chosen. Ids alone cannot explain a decision.
      reasons: Array.isArray(input.reasons) ? input.reasons.slice(0, 20).map((value) => String(value).slice(0, 160)) : [],
      pools: readPools(input.pools),
      memories: Array.isArray(input.memories) ? input.memories.slice(0, 20) : [],
      excluded: Array.isArray(input.excluded) ? input.excluded.slice(0, 20) : [],
      text_digest: digestOf(text),
      chars: text.length,
      occurrences: 1,
      first_at: at,
      last_at: at,
    };
    records.push(record);
    byKey.set(key, record);
    trim();
    return { record, duplicate: false };
  }

  return {
    note,
    records: () => records.slice(),
    stats: () => ({ calls: counters.calls, empty: counters.empty, records: records.length, dropped: counters.dropped }),
  };
}
