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

export const RUNTIME_FILE = 'runtime.json';
export const RUNTIME_VERSION = 1;
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
  return { version: RUNTIME_VERSION, candidates: [], injections: [] };
}

function candidateId(now) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/gu, '');
  return `C-${stamp}-${randomUUID().slice(0, 8)}`;
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
      candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
      injections: Array.isArray(parsed.injections) ? parsed.injections : [],
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
      return mutate((document) => {
        const twin = document.candidates.find((entry) => normalise(entry.text) === normalise(text) && entry.status === 'pending');
        if (twin) throw new RuntimeStoreError('an identical candidate is already pending', 'duplicate');
        const candidate = {
          id: candidateId(now()),
          text,
          type: typeof input.type === 'string' ? input.type : 'fact',
          status: 'pending',
          session_id: sessionId,
          turn,
          source_refs: [sourceRef],
          confidence: typeof input.confidence === 'number' ? input.confidence : 0.6,
          reason: typeof input.reason === 'string' ? input.reason : '',
          origin: CANDIDATE_ORIGINS.includes(input.origin) ? input.origin : null,
          created_at: now().toISOString(),
        };
        document.candidates.push(candidate);
        return candidate;
      });
    },

    /** Move a candidate to accepted / rejected / edited. The ledger write happens elsewhere. */
    async setCandidateStatus(id, status, meta = {}) {
      if (!['pending', 'accepted', 'rejected'].includes(status)) {
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
      const pending = document.candidates.filter((entry) => entry.status === 'pending').length;
      return {
        candidates: document.candidates.length,
        pending,
        injections: document.injections.length,
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
