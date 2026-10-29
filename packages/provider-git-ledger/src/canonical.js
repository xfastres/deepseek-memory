// One canonical form for an ADD intent and its source refs.
//
// MemoryWriter hashes this before asking the ledger to write. The ledger does
// not import this module; the writer normalizes refs first and then passes the
// same array into the proposal, so the hash and the committed refs match.
//
// Rules (M1):
//   * Only the fields listed in INTENT_FIELDS are hashed. Anything else is ignored.
//   * Missing and null are different: null is kept, undefined is omitted.
//   * Object keys are sorted by UTF-16 code unit. Arrays keep the order this
//     function produces; callers do not get to choose a second order.
//   * source_refs are sorted by (session_id, event_seq). Exact duplicates collapse.
//     The same session and seq with a different event_type or quote_sha256 is a
//     conflict and throws; the first row is not silently kept.
//   * Strings are hashed as stored. No Unicode normalization. Lone surrogates
//     are refused before hashing.
//   * The only number allowed is event_seq, and it must be a safe non-negative
//     integer. 1e2 and 100 are the same value after JSON.parse; this module
//     does not try to recover the original spelling.

import { createHash } from 'node:crypto';

export const INTENT_FIELDS = Object.freeze([
  'change_type',
  'content',
  'type',
  'scope',
  'tags',
  'entities',
  'source_refs',
  'source_kind',
  'target_memory_id',
  'expected_base_change_id',
]);

export class EvidenceConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EvidenceConflictError';
    this.status = 422;
    this.error = 'evidence-conflict';
    this.details = details;
  }
}

export class CanonicalError extends Error {
  constructor(message, error = 'invalid-intent') {
    super(message);
    this.name = 'CanonicalError';
    this.status = 422;
    this.error = error;
  }
}

function assertWellFormed(value, label) {
  if (typeof value !== 'string' || value.isWellFormed() === false) {
    throw new CanonicalError(`${label} must be well-formed text`, 'invalid-text');
  }
}

function assertSafeSeq(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new CanonicalError(`${label} must be a safe non-negative integer`);
  }
}

function refKey(ref) {
  return {
    session_id: ref.session_id,
    event_seq: ref.event_seq,
    event_type: ref.event_type ?? null,
    quote_sha256: ref.quote_sha256 ?? null,
  };
}

/**
 * Sort and de-duplicate source refs, or throw when one event is cited twice
 * with different type or quote hash.
 *
 * @param {unknown} refs
 * @returns {Array<{session_id:string,event_seq:number,event_type?:string,quote_sha256?:string}>}
 */
export function normalizeSourceRefs(refs) {
  if (!Array.isArray(refs)) throw new CanonicalError('source_refs must be an array');
  const rows = refs.map((ref, index) => {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
      throw new CanonicalError(`source_refs[${index}] must be an object`);
    }
    assertWellFormed(ref.session_id, `source_refs[${index}].session_id`);
    if (ref.session_id.trim() === '') throw new CanonicalError(`source_refs[${index}].session_id is required`);
    assertSafeSeq(ref.event_seq, `source_refs[${index}].event_seq`);
    const out = { session_id: ref.session_id, event_seq: ref.event_seq };
    if (ref.event_type !== undefined && ref.event_type !== null) {
      assertWellFormed(ref.event_type, `source_refs[${index}].event_type`);
      out.event_type = ref.event_type;
    }
    if (ref.quote_sha256 !== undefined && ref.quote_sha256 !== null) {
      assertWellFormed(ref.quote_sha256, `source_refs[${index}].quote_sha256`);
      out.quote_sha256 = ref.quote_sha256;
    }
    return out;
  });
  const byEvent = new Map();
  for (const row of rows) {
    const key = `${row.session_id}#${row.event_seq}`;
    const previous = byEvent.get(key);
    if (previous === undefined) {
      byEvent.set(key, row);
      continue;
    }
    const left = refKey(previous);
    const right = refKey(row);
    if (left.event_type !== right.event_type || left.quote_sha256 !== right.quote_sha256) {
      throw new EvidenceConflictError('the same event is cited with different evidence', {
        session_id: row.session_id,
        event_seq: row.event_seq,
      });
    }
  }
  return [...byEvent.values()].sort((left, right) => {
    if (left.session_id < right.session_id) return -1;
    if (left.session_id > right.session_id) return 1;
    return left.event_seq - right.event_seq;
  });
}

function stringList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CanonicalError(`${label} must be an array`);
  const seen = new Set();
  const out = [];
  for (const item of value) {
    assertWellFormed(item, label);
    const trimmed = item.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * The exact object that is hashed. Unknown fields are dropped. ADD has no
 * target and no baseline, so those keys are null rather than omitted.
 */
export function canonicalIntent(intent) {
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new CanonicalError('intent must be an object');
  }
  assertWellFormed(intent.content ?? '', 'content');
  if (typeof intent.content !== 'string' || intent.content.trim() === '') {
    throw new CanonicalError('content is required', 'empty-content');
  }
  if (intent.change_type !== 'ADD') throw new CanonicalError('M1 only canonicalizes ADD');
  if (intent.type !== undefined && intent.type !== null) assertWellFormed(intent.type, 'type');
  if (intent.scope !== undefined && intent.scope !== null) assertWellFormed(intent.scope, 'scope');
  if (intent.source_kind !== undefined && intent.source_kind !== null) assertWellFormed(intent.source_kind, 'source_kind');
  const out = {
    change_type: 'ADD',
    content: intent.content,
    tags: stringList(intent.tags, 'tags'),
    entities: stringList(intent.entities, 'entities'),
    source_refs: normalizeSourceRefs(intent.source_refs ?? []),
    target_memory_id: null,
    expected_base_change_id: null,
  };
  // Absent and null stay different. Only an explicit null is hashed as null.
  for (const key of ['type', 'scope', 'source_kind']) {
    if (intent[key] === null) out[key] = null;
    else if (typeof intent[key] === 'string') out[key] = intent[key];
  }
  return out;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

/** Compact JSON of the canonical intent. Indent is not part of the hash. */
export function canonicalIntentJson(intent) {
  return JSON.stringify(sortKeys(canonicalIntent(intent)));
}

export function intentHash(intent) {
  return `sha256:${createHash('sha256').update(canonicalIntentJson(intent), 'utf8').digest('hex')}`;
}
