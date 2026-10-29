// Runtime state that is not memory content: the candidate queue and the
// injection log.
//
// Why a separate store: the Git ledger holds only what the user confirmed. A
// candidate waiting for review and a record of "these memories were injected
// into that turn" are operational facts — they change on every turn, must be
// cheap to write, and must never appear as memory history. Mixing them into
// commits would flood the ledger with noise and make "why is this memory here"
// harder, not easier.
//
// Storage is one JSON document plus an atomic rename, guarded by the same
// cross-process lock the ledger uses. A corrupt document is refused, never
// silently replaced: losing the injection log is annoying, losing it without
// saying so is worse.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LedgerLockError, RepoLock } from '../../provider-git-ledger/src/lock.js';
import { toLedgerType } from './memory-types.js';
import { isCorrectionKind, isReviewOnlyKind, normalizeCorrectionKind } from './corrections.js';

export const RUNTIME_FILE = 'runtime.json';
export const RUNTIME_VERSION = 1;

/**
 * §7.2 candidate statuses. A candidate is not "pending": it has been proposed,
 * may be under validation, may be waiting for the user, may have been accepted
 * by the user or by the policy, and may have ended as a conflict or no-change.
 * The distinction is what makes the queue's audit trail honest.
 */
export const CANDIDATE_STATUSES = Object.freeze([
  'proposed',
  'validating',
  'review_pending',
  'auto_accepted',
  'accepted_by_user',
  'rejected',
  'conflict',
  'no_change',
  'failed',
]);

/** Statuses that still need a decision, so the queue is still waiting. */
export const OPEN_CANDIDATE_STATUSES = Object.freeze(['proposed', 'validating', 'review_pending', 'conflict']);

/** Files written before §7.2 keep these values; read them without rewriting them. */
export const LEGACY_CANDIDATE_STATUSES = Object.freeze({
  pending: 'review_pending',
  accepted: 'accepted_by_user',
  rejected: 'rejected',
});

/** Read one stored status as the §7.2 value; unknown values are kept verbatim. */
export function toCandidateStatus(status) {
  if (typeof status !== 'string') return null;
  if (CANDIDATE_STATUSES.includes(status)) return status;
  return LEGACY_CANDIDATE_STATUSES[status] ?? status;
}

/**
 * §11 AI proposals: what the model may submit, and what the user must still do.
 * A proposal is not a candidate: it has no evidence rule of its own, it is
 * never injected, and accepting it is a deliberate user action.
 */
export const PROPOSAL_ACTIONS = Object.freeze(['add', 'update', 'merge', 'retract']);
export const PROPOSAL_STATUSES = Object.freeze(['open', 'accepted', 'rejected', 'failed']);

export function isProposalAction(value) {
  return typeof value === 'string' && PROPOSAL_ACTIONS.includes(value);
}

export function isOpenCandidateStatus(status) {
  return OPEN_CANDIDATE_STATUSES.includes(toCandidateStatus(status));
}
export const MAX_INJECTIONS = 200;
export const INJECTION_MAX_AGE_DAYS = 30;
/**
 * Where a candidate came from. Additive field: an absent or unknown origin is
 * stored as null so old documents keep loading and nothing is invented.
 */
export const CANDIDATE_ORIGINS = Object.freeze(['rule', 'user', 'legacy', 'llm']);

export class RuntimeStoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RuntimeStoreError';
    this.code = code;
    this.details = details;
  }
}

function emptyDocument() {
  return { version: RUNTIME_VERSION, candidates: [], injections: [], objections: [], proposals: [] };
}

function candidateId(now) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/gu, '');
  return `C-${stamp}-${randomUUID().slice(0, 8)}`;
}

function objectionId(now) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/gu, '');
  return `O-${stamp}-${randomUUID().slice(0, 8)}`;
}

function proposalId(now) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/gu, '');
  return `P-${stamp}-${randomUUID().slice(0, 8)}`;
}

function normalise(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/gu, '');
}

/**
 * @param {object} options
 * @param {string} options.root directory holding runtime.json
 * @param {() => Date} [options.now]
 * @param {number} [options.lockTimeoutMs]
 */
export function createRuntimeStore(options = {}) {
  const { root, lockTimeoutMs = 5_000 } = options;
  if (typeof root !== 'string' || root === '') throw new Error('root is required');
  const now = options.now ?? (() => new Date());
  const file = join(root, RUNTIME_FILE);
  const lock = new RepoLock(root, { timeoutMs: lockTimeoutMs, now: () => now().getTime() });
  let queue = Promise.resolve();

  async function read() {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyDocument();
      throw new RuntimeStoreError(`runtime store unreadable: ${error.code ?? error.message}`, 'unreadable');
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RuntimeStoreError('runtime.json is not valid JSON; refusing to overwrite it', 'corrupt');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new RuntimeStoreError('runtime.json has an unexpected shape; refusing to overwrite it', 'corrupt');
    }
    return {
      version: RUNTIME_VERSION,
      // Old files are read as the new vocabulary; the file is rewritten only
      // when something is actually stored, never just because it was read.
      candidates: Array.isArray(parsed.candidates)
        ? parsed.candidates.map((entry) => (entry !== null && typeof entry === 'object'
          ? { ...entry, status: toCandidateStatus(entry.status) ?? entry.status }
          : entry))
        : [],
      injections: Array.isArray(parsed.injections) ? parsed.injections : [],
      objections: Array.isArray(parsed.objections) ? parsed.objections : [],
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
    };
  }

  async function write(document) {
    await mkdir(root, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new RuntimeStoreError(`runtime store not written: ${error.code ?? error.message}`, 'unwritable');
    }
  }

  /** Serialize every mutation: one process, one writer, one lock. */
  async function mutate(change) {
    const run = async () => {
      await mkdir(root, { recursive: true });
      try {
        await lock.acquire();
      } catch (error) {
        if (error instanceof LedgerLockError) throw new RuntimeStoreError('runtime store is busy', 'busy');
        throw error;
      }
      try {
        const document = await read();
        const result = await change(document);
        prune(document);
        await write(document);
        return result;
      } finally {
        await lock.release().catch(() => {});
      }
    };
    const chained = queue.then(run, run);
    queue = chained.then(() => undefined, () => undefined);
    return chained;
  }

  function prune(document) {
    const cutoff = now().getTime() - INJECTION_MAX_AGE_DAYS * 86_400_000;
    document.injections = document.injections.filter((entry) => {
      const at = Date.parse(entry?.at);
      return Number.isNaN(at) ? false : at >= cutoff;
    });
    if (document.injections.length > MAX_INJECTIONS) {
      document.injections = document.injections.slice(document.injections.length - MAX_INJECTIONS);
    }
  }

  return {
    async listCandidates() {
      return (await read()).candidates;
    },

    /** Add a candidate. An identical pending candidate is refused, not doubled. */
    async addCandidate(input = {}) {
      const text = String(input.text ?? '').trim();
      if (text === '') throw new RuntimeStoreError('candidate text is empty', 'empty');
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : null;
      const turn = Number.isInteger(input.turn) ? input.turn : null;
      const sourceRef = input.sourceRef && typeof input.sourceRef === 'object' ? input.sourceRef : null;
      if (sourceRef === null) throw new RuntimeStoreError('candidate needs evidence', 'no-evidence');
      // The ledger vocabulary is the only one a candidate may carry. Mapping
      // (instruction -> constraint) happens here; an unmapped kind is refused
      // now, not queued to fail later at review.
      const mapped = typeof input.type === 'string' && input.type !== '' ? toLedgerType(input.type) : 'fact';
      if (mapped === null) throw new RuntimeStoreError(`the ledger cannot store type ${input.type}`, 'invalid-type');
      return mutate((document) => {
        const twin = document.candidates.find((entry) => normalise(entry.text) === normalise(text) && isOpenCandidateStatus(entry.status));
        if (twin) throw new RuntimeStoreError('an identical candidate is already pending', 'duplicate');
        const candidate = {
          id: candidateId(now()),
          text,
          type: mapped,
          status: 'proposed',
          session_id: sessionId,
          turn,
          source_refs: [sourceRef],
          confidence: typeof input.confidence === 'number' ? input.confidence : 0.6,
          reason: typeof input.reason === 'string' ? input.reason : '',
          origin: CANDIDATE_ORIGINS.includes(input.origin) ? input.origin : null,
          // Names the ledger already holds and this sentence mentions; the
          // candidate does not invent structure (§4.2).
          entities: Array.isArray(input.entities)
            ? input.entities.filter((entity) => typeof entity === 'string' && entity.trim() !== '').map((entity) => entity.trim()).slice(0, 50)
            : [],
          created_at: now().toISOString(),
        };
        document.candidates.push(candidate);
        return candidate;
      });
    },

    /**
     * Record that the user called this memory wrong.
     *
     * Runtime only: an objection suppresses retrieval immediately (D7) and is
     * not a ledger change. Retracting or editing the memory stays a separate,
     * deliberate Git write.
     */
    async addObjection(input = {}) {
      const memoryId = typeof input.memoryId === 'string' ? input.memoryId.trim() : '';
      if (memoryId === '') throw new RuntimeStoreError('objection needs a memory id', 'empty');
      // Cue synonyms (`incorrect`, `delete_request`) normalize onto the shared
      // vocabulary before the kind is checked. An unknown kind is still refused
      // rather than defaulted, so "wrong" is never invented on the user's behalf.
      const kind = input.kind === undefined || input.kind === null
        ? null
        : normalizeCorrectionKind(input.kind);
      if (kind !== null && !isCorrectionKind(kind)) {
        throw new RuntimeStoreError(`unknown correction kind: ${String(input.kind)}`, 'invalid-kind');
      }
      return mutate((document) => {
        const twin = document.objections.find((entry) => entry.memory_id === memoryId && entry.status === 'active');
        if (twin) throw new RuntimeStoreError('this memory is already objected', 'duplicate');
        const objection = {
          id: objectionId(now()),
          memory_id: memoryId,
          kind: isCorrectionKind(kind) ? kind : null,
          reason: typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '',
          status: 'active',
          created_at: now().toISOString(),
        };
        document.objections.push(objection);
        return objection;
      });
    },

    /** Objections in the order they were made. */
    async listObjections() {
      return (await read()).objections;
    },

    /**
     * Memory ids whose objection asks for a re-check, not a stop (§6.3).
     *
     * These are still suppressed from retrieval: an unreviewed "too broad"
     * claim must not be presented as confirmed. The list exists so the panel
     * and the auto-accept guard can tell "hidden until fixed" from "hidden
     * because it was wrong".
     */
    async reviewPendingIds() {
      const document = await read();
      const ids = [];
      for (const entry of document.objections) {
        if (entry === null || typeof entry !== 'object') continue;
        if (entry.status !== 'active' || typeof entry.memory_id !== 'string') continue;
        if (!isReviewOnlyKind(entry.kind)) continue;
        if (!ids.includes(entry.memory_id)) ids.push(entry.memory_id);
      }
      return ids;
    },

    /** Memory ids the user has objected to and not reinstated. */
    async suppressedIds() {
      const document = await read();
      const ids = [];
      for (const entry of document.objections) {
        if (entry === null || typeof entry !== 'object') continue;
        if (entry.status !== 'active' || typeof entry.memory_id !== 'string') continue;
        if (!ids.includes(entry.memory_id)) ids.push(entry.memory_id);
      }
      return ids;
    },

    /** Undo an objection for one memory; history of the objection is kept. */
    async reinstate(memoryId) {
      const id = typeof memoryId === 'string' ? memoryId.trim() : '';
      if (id === '') throw new RuntimeStoreError('reinstate needs a memory id', 'empty');
      return mutate((document) => {
        let changed = 0;
        for (const entry of document.objections) {
          if (entry.memory_id !== id || entry.status !== 'active') continue;
          entry.status = 'reinstated';
          entry.reinstated_at = now().toISOString();
          changed += 1;
        }
        if (changed === 0) throw new RuntimeStoreError(`no active objection for ${id}`, 'missing');
        return changed;
      });
    },

    /** Move a candidate to accepted / rejected / edited. The ledger write happens elsewhere. */
    async setCandidateStatus(id, status, meta = {}) {
      if (!CANDIDATE_STATUSES.includes(status)) {
        throw new RuntimeStoreError(`unknown candidate status: ${status}`, 'invalid-status');
      }
      return mutate((document) => {
        const candidate = document.candidates.find((entry) => entry.id === id);
        if (!candidate) throw new RuntimeStoreError(`no candidate ${id}`, 'missing');
        candidate.status = status;
        candidate.reviewed_at = now().toISOString();
        if (typeof meta.memoryId === 'string') candidate.memory_id = meta.memoryId;
        if (typeof meta.content === 'string') candidate.edited_content = meta.content;
        return candidate;
      });
    },

    /**
     * Record an AI proposal (§11 memory_propose).
     *
     * Evidence is required: a proposal without the user's own words behind it
     * is refused here, so the model cannot manufacture a change out of nothing.
     */
    async addProposal(input = {}) {
      if (!isProposalAction(input.action)) {
        throw new RuntimeStoreError(`unknown proposal action: ${String(input.action)}`, 'invalid-action');
      }
      const action = input.action;
      const content = typeof input.content === 'string' ? input.content.trim() : '';
      if (action !== 'retract' && content === '') throw new RuntimeStoreError('proposal needs content', 'empty');
      const targetMemoryId = typeof input.targetMemoryId === 'string' ? input.targetMemoryId.trim() : '';
      if (action !== 'add' && targetMemoryId === '') {
        throw new RuntimeStoreError('this proposal needs a target memory', 'empty-target');
      }
      const sourceRef = input.sourceRef && typeof input.sourceRef === 'object' ? input.sourceRef : null;
      if (sourceRef === null) throw new RuntimeStoreError('proposal needs the user words behind it', 'no-evidence');
      if (input.kind !== undefined && input.kind !== null && !isCorrectionKind(input.kind)) {
        throw new RuntimeStoreError(`unknown correction kind: ${String(input.kind)}`, 'invalid-kind');
      }
      // An add proposal names the type the ledger will store. An update or a
      // retract keeps the target's type, so a type there is ignored rather than
      // becoming a second way to change it. An unmapped kind is refused before
      // the proposal exists, the same rule a candidate follows.
      let type = null;
      if (action === 'add' && typeof input.type === 'string' && input.type !== '') {
        type = toLedgerType(input.type);
        if (type === null) throw new RuntimeStoreError(`the ledger cannot store type ${input.type}`, 'invalid-type');
      }
      return mutate((document) => {
        const twin = document.proposals.find((entry) => entry.status === 'open'
          && entry.action === action
          && entry.target_memory_id === (targetMemoryId === '' ? null : targetMemoryId)
          && normalise(entry.content) === normalise(content));
        if (twin) throw new RuntimeStoreError('an identical proposal is already open', 'duplicate');
        const proposal = {
          id: proposalId(now()),
          action,
          target_memory_id: targetMemoryId === '' ? null : targetMemoryId,
          content: action === 'retract' ? '' : content,
          type,
          kind: isCorrectionKind(input.kind) ? input.kind : null,
          reason: typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : '',
          origin: 'llm',
          source_refs: [sourceRef],
          status: 'open',
          created_at: now().toISOString(),
        };
        document.proposals.push(proposal);
        return proposal;
      });
    },

    async listProposals() {
      return (await read()).proposals;
    },

    async setProposalStatus(id, status, meta = {}) {
      if (!PROPOSAL_STATUSES.includes(status)) {
        throw new RuntimeStoreError(`unknown proposal status: ${status}`, 'invalid-status');
      }
      return mutate((document) => {
        const proposal = document.proposals.find((entry) => entry.id === id);
        if (!proposal) throw new RuntimeStoreError(`no proposal ${id}`, 'missing');
        proposal.status = status;
        proposal.reviewed_at = now().toISOString();
        if (typeof meta.memoryId === 'string') proposal.memory_id = meta.memoryId;
        return proposal;
      });
    },

    async recordInjection(record = {}) {
      const memoryIds = Array.isArray(record.memoryIds) ? record.memoryIds.filter((id) => typeof id === 'string') : [];
      return mutate((document) => {
        const entry = {
          at: now().toISOString(),
          session_id: typeof record.sessionId === 'string' ? record.sessionId : null,
          turn: Number.isInteger(record.turn) ? record.turn : null,
          memory_ids: memoryIds,
          reasons: Array.isArray(record.reasons) ? record.reasons.slice(0, 20) : [],
          chars: Number.isFinite(record.chars) ? record.chars : 0,
          // Additive fields. Old files simply lack them, and nothing here reads
          // a missing field as empty rather than as absent.
          key: typeof record.key === 'string' ? record.key : null,
          snapshot_head: typeof record.snapshotHead === 'string' ? record.snapshotHead : null,
          state: typeof record.state === 'string' ? record.state : 'returned',
          // A receipt from the host is the only thing that may set this true.
          confirmed: record.confirmed === true && typeof record.evidence === 'string' ? true : null,
          evidence: typeof record.evidence === 'string' ? record.evidence : null,
          occurrences: Number.isInteger(record.occurrences) && record.occurrences > 0 ? record.occurrences : 1,
          pools: record.pools !== null && typeof record.pools === 'object' ? record.pools : null,
          memories: Array.isArray(record.memories) ? record.memories.slice(0, 20) : [],
          excluded: Array.isArray(record.excluded) ? record.excluded.slice(0, 50) : [],
        };
        document.injections.push(entry);
        return entry;
      });
    },

    async listInjections({ limit = 50 } = {}) {
      const document = await read();
      return document.injections.slice(-Math.max(0, limit));
    },

    /** Diagnostics for the panel: sizes without reading every record. */
    async summary() {
      const document = await read();
      const pending = document.candidates.filter((entry) => isOpenCandidateStatus(entry.status)).length;
      const objected = document.objections.filter((entry) => entry !== null && typeof entry === 'object' && entry.status === 'active').length;
      return {
        candidates: document.candidates.length,
        pending,
        injections: document.injections.length,
        objections: objected,
        proposals: document.proposals.filter((entry) => entry !== null && typeof entry === 'object' && entry.status === 'open').length,
      };
    },
  };
}

/** Leftover temporary files from a crashed write; safe to report, never guessed. */
export async function listTemporaryFiles(root) {
  try {
    const entries = await readdir(root);
    return entries.filter((name) => name.startsWith(`${RUNTIME_FILE}.`) && name.endsWith('.tmp'));
  } catch {
    return [];
  }
}
