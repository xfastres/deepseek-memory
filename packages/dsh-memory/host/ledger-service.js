// Host-side memory service: the only writer of the local memory ledger.
//
// It wraps the already-tested Git ledger instead of reimplementing it, and
// exposes the small surface the HTTP routes need: read state, add, update,
// retract. Concurrency tokens are the ledger's own change ids, not version
// numbers, so the client can detect a stale edit exactly.
//
// This module is deliberately free of Cordis, HTTP and filesystem layout
// concerns so it can be tested against a temporary repository.

import { MemoryLedger } from '../../provider-git-ledger/src/ledger.js';
import { newChangeId } from '../../provider-git-ledger/src/schema.js';

export const OWNER_ID = 'local-user';

/** Map a ledger error onto the API error table in docs/dsh-memory-host-api.md. */
export function toApiError(error) {
  const name = error && error.name;
  const message = String((error && error.message) || '');
  if (name === 'LedgerConflictError') {
    if (/does not exist/.test(message)) return { status: 404, error: 'missing' };
    if (/working tree is dirty/.test(message)) return { status: 503, error: 'ledger-dirty' };
    return { status: 409, error: 'stale' };
  }
  if (name === 'LedgerLockError') return { status: 503, error: 'busy' };
  if (name === 'SchemaError') return { status: 422, error: 'invalid' };
  if (name === 'EvidenceError') return { status: 422, error: 'no-evidence' };
  return { status: 500, error: 'internal' };
}

function toUiMemory(record, version) {
  const firstRef = Array.isArray(record.source_refs) && record.source_refs.length > 0 ? record.source_refs[0] : null;
  return {
    id: record.memory_id,
    version,
    status: record.status,
    content: record.content,
    type: record.type,
    scope: record.scope,
    importance: record.importance,
    confidence: record.confidence,
    accepted_at: record.updated_at,
    last_change_id: record.last_change_id,
    source: firstRef === null ? null : { session_id: firstRef.session_id, event_seq: firstRef.event_seq },
    source_refs: record.source_refs,
  };
}

export function createLedgerService(options = {}) {
  const { root, ownerId = OWNER_ID, verifyEvidence, now, lockTimeoutMs } = options;
  if (typeof root !== 'string' || root === '') throw new Error('ledger root is required');
  const ledger = new MemoryLedger({ root, ownerId, verifyEvidence, now, lockTimeoutMs });
  let opening;

  async function open() {
    if (opening === undefined) opening = ledger.open();
    await opening;
    return ledger;
  }

  async function listMemories() {
    const ready = await open();
    const records = await ready.listMemories({ includeInactive: true });
    const out = [];
    for (const record of records) {
      const versions = await ready.history(record.memory_id);
      out.push(toUiMemory(record, versions.length === 0 ? 1 : versions.length));
    }
    return out;
  }

  async function state() {
    const ready = await open();
    const head = await ready.readHead();
    return { head, memories: await listMemories() };
  }

  async function apply(proposal) {
    const ready = await open();
    const full = { ...proposal, owner_id: ownerId, actor: 'user', user_confirmed: true };
    // Callers may pass an explicit key for replay safety; otherwise the ledger
    // gets a fresh one. An explicit `undefined` must not shadow the default.
    if (typeof full.idempotency_key !== 'string' || full.idempotency_key === '') {
      full.idempotency_key = newChangeId();
    }
    const result = await ready.apply(full);
    return {
      status: result.status,
      change_id: result.change_id,
      memory: toUiMemory(result.memory, undefined),
    };
  }

  function add({ content, type = 'fact', sourceRefs, idempotencyKey, scope, reason }) {
    return apply({
      change_type: 'ADD',
      content,
      type,
      source_kind: 'user-explicit',
      source_refs: sourceRefs,
      scope,
      reason,
      idempotency_key: idempotencyKey,
    });
  }

  function update({ memoryId, content, expectedBaseChangeId, sourceRefs, reason }) {
    return apply({
      change_type: 'UPDATE',
      target_memory_id: memoryId,
      content,
      source_kind: 'user-correction',
      source_refs: sourceRefs,
      expected_base_change_id: expectedBaseChangeId ?? null,
      reason,
    });
  }

  function retract({ memoryId, expectedBaseChangeId, reason, sourceRefs }) {
    return apply({
      change_type: 'RETRACT',
      target_memory_id: memoryId,
      source_kind: 'user-explicit',
      source_refs: sourceRefs,
      expected_base_change_id: expectedBaseChangeId ?? null,
      reason,
    });
  }

  return { open, state, listMemories, add, update, retract, apply, errorFor: toApiError };
}
