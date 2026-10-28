// One-time migration from the browser's local store into the Git ledger.
//
// The local store is the only place memories exist today, and the ledger will
// not accept an active memory without a real Session event. So migration is
// two steps: plan (resolve evidence, detect duplicates, name every refusal)
// and apply (let the ledger write, idempotently).
//
// Nothing is discarded silently. A legacy memory whose evidence cannot be
// proved stays in the browser and is reported, rather than being imported with
// a made-up `event_seq` — that would corrupt the audit trail on day one.

const CANDIDATE_KEY = 'dsh-memory.candidates.v1';
const FORMAL_KEY = 'dsh-memory.formal.v1';

function normalise(text) {
  return String(text ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * The identity used for duplicate detection: whitespace is dropped entirely,
 * because CJK text is often written with and without spaces for the same
 * sentence and that must not look like two memories.
 */
function dedupeKey(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/gu, '');
}

/**
 * Plan the memory half of the migration.
 *
 * @param {object} options
 * @param {Array<object>} [options.legacyMemories] records from `dsh-memory.formal.v1`
 * @param {Array<object>} [options.existingMemories] memories already in the ledger
 * @param {(input: {sessionId: string, turn: number}) => Promise<object|undefined>} options.resolve
 * @returns {Promise<{operations: Array<object>, skipped: Array<object>, deferred: object}>}
 */
export async function planMemoryMigration(options = {}) {
  const {
    legacyMemories = [],
    legacyCandidates = [],
    existingMemories = [],
    resolve,
  } = options;
  if (typeof resolve !== 'function') throw new Error('resolve is required');

  const seen = new Set(existingMemories.map((memory) => dedupeKey(memory.content)));
  const operations = [];
  const skipped = [];

  const active = legacyMemories.filter((memory) => memory && memory.status === 'active');
  for (const memory of active) {
    const content = normalise(memory.content);
    if (content === '') {
      skipped.push({ id: memory.id ?? null, reason: 'empty' });
      continue;
    }
    if (seen.has(dedupeKey(content))) {
      skipped.push({ id: memory.id ?? null, reason: 'duplicate' });
      continue;
    }
    const source = memory.source && typeof memory.source === 'object' ? memory.source : {};
    if (typeof source.session_id !== 'string' || !Number.isInteger(source.turn)) {
      skipped.push({ id: memory.id ?? null, reason: 'no-source' });
      continue;
    }
    let ref;
    try {
      ref = await resolve({ sessionId: source.session_id, turn: source.turn });
    } catch {
      ref = undefined;
    }
    if (ref === undefined || ref === null) {
      skipped.push({ id: memory.id ?? null, reason: 'no-evidence', session_id: source.session_id, turn: source.turn });
      continue;
    }
    seen.add(dedupeKey(content));
    operations.push({
      legacyId: memory.id ?? null,
      legacyVersion: memory.version ?? 1,
      proposal: {
        change_type: 'ADD',
        content,
        type: typeof memory.type === 'string' ? memory.type : 'fact',
        source_kind: memory.source_kind === 'agent-inference' ? 'agent-inference' : 'user-explicit',
        source_refs: [ref],
        // Stable per legacy record, so re-running the migration can never double-write.
        idempotency_key: `migrate:${memory.id ?? content}@${memory.version ?? 1}`,
      },
    });
  }

  // Superseded versions are visible in the ledger only as history of a moved
  // record; the legacy store keeps them in the same array, so state them.
  for (const memory of legacyMemories) {
    if (!memory || memory.status === 'active') continue;
    skipped.push({ id: memory.id ?? null, reason: 'history-not-migrated' });
  }

  return {
    operations,
    skipped,
    deferred: {
      candidates: legacyCandidates.length,
      reason: 'candidate-queue-not-built',
    },
  };
}

/**
 * Apply a plan through the ledger service. One failure does not stop the rest:
 * migration reports exactly which records landed and which did not.
 */
export async function applyMigration(service, plan) {
  const results = [];
  for (const operation of plan.operations) {
    try {
      const result = await service.apply(operation.proposal);
      results.push({ legacyId: operation.legacyId, status: result.status, memoryId: result.memory ? result.memory.id : null });
    } catch (error) {
      results.push({ legacyId: operation.legacyId, status: 'failed', error: (error && error.message) || String(error) });
    }
  }
  return {
    applied: results.filter((entry) => entry.status === 'committed').length,
    replayed: results.filter((entry) => entry.status === 'replayed').length,
    failed: results.filter((entry) => entry.status === 'failed').length,
    results,
    skipped: plan.skipped,
    deferred: plan.deferred,
  };
}

/** Read the two legacy keys out of a Web Storage-like object. */
export function readLegacyStore(storage) {
  const read = (key) => {
    try {
      const raw = storage.getItem(key);
      if (raw === null || raw === undefined) return [];
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  return { memories: read(FORMAL_KEY), candidates: read(CANDIDATE_KEY) };
}
