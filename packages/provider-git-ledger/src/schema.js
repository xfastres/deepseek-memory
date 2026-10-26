// Memory record and change-proposal schema for the Git ledger (phase 1: L1 atoms only).
// Every validator throws on malformed input; nothing here touches disk.

import { createHash, randomUUID } from 'node:crypto';

export const LAYERS = Object.freeze(['L1']);
export const MEMORY_TYPES = Object.freeze(['fact', 'preference', 'constraint', 'decision', 'goal', 'event', 'open_loop', 'hypothesis']);
export const MEMORY_STATUSES = Object.freeze(['active', 'superseded', 'retracted']);
export const CHANGE_TYPES = Object.freeze(['ADD', 'UPDATE', 'RETRACT', 'SUPERSEDE']);
export const SOURCE_KINDS = Object.freeze(['user-explicit', 'session-extraction', 'user-correction', 'agent-inference']);
// Mnemon categories map onto memory types; unknown categories become 'fact'.
export const CATEGORY_TO_TYPE = Object.freeze({
  preference: 'preference',
  decision: 'decision',
  fact: 'fact',
  insight: 'hypothesis',
  context: 'event',
  general: 'fact',
});
export const TYPE_TO_CATEGORY = Object.freeze({
  preference: 'preference',
  decision: 'decision',
  fact: 'fact',
  constraint: 'context',
  goal: 'context',
  event: 'context',
  open_loop: 'context',
  hypothesis: 'insight',
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

function text(value, label, max = 8192) {
  if (typeof value !== 'string') throw new SchemaError(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') throw new SchemaError(`${label} is required`);
  if (trimmed.length > max) throw new SchemaError(`${label} exceeds ${max} characters`);
  return trimmed;
}

function optionalText(value, label, max) {
  return value === undefined || value === null ? undefined : text(value, label, max);
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw new SchemaError(`${label} must be one of ${allowed.join(', ')}; got ${String(value)}`);
  return value;
}

function id(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new SchemaError(`${label} must match ${ID_RE}`);
  return value;
}

function stringList(value, label, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SchemaError(`${label} must be an array`);
  if (value.length > max) throw new SchemaError(`${label} accepts at most ${max} values`);
  return value.map((item, index) => text(item, `${label}[${index}]`, 200));
}

function isoTime(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new SchemaError(`${label} must be an ISO-8601 time`);
  return new Date(value).toISOString();
}

/** One pointer into the authoritative DSH Session log. Never a copy of the text. */
export function validateSourceRef(value, label = 'source_ref') {
  if (typeof value !== 'object' || value === null) throw new SchemaError(`${label} must be an object`);
  const sessionId = text(value.session_id, `${label}.session_id`, 256);
  const seq = value.event_seq;
  if (!Number.isInteger(seq) || seq < 0) throw new SchemaError(`${label}.event_seq must be a non-negative integer`);
  const out = { session_id: sessionId, event_seq: seq };
  if (value.event_type !== undefined) out.event_type = text(value.event_type, `${label}.event_type`, 64);
  if (value.quote_sha256 !== undefined) {
    if (!/^[0-9a-f]{64}$/u.test(value.quote_sha256)) throw new SchemaError(`${label}.quote_sha256 must be hex sha256`);
    out.quote_sha256 = value.quote_sha256;
  }
  return out;
}

/** Validate and normalize one memory record. Returns a fresh plain object. */
export function validateMemory(value) {
  if (typeof value !== 'object' || value === null) throw new SchemaError('memory must be an object');
  const m = {
    memory_id: id(value.memory_id, 'memory_id'),
    owner_id: text(value.owner_id, 'owner_id', 128),
    layer: oneOf(value.layer, LAYERS, 'layer'),
    type: oneOf(value.type, MEMORY_TYPES, 'type'),
    content: text(value.content, 'content'),
    status: oneOf(value.status, MEMORY_STATUSES, 'status'),
    source_kind: oneOf(value.source_kind, SOURCE_KINDS, 'source_kind'),
    confidence: value.confidence,
    scope: optionalText(value.scope, 'scope', 256) ?? 'global',
    tags: stringList(value.tags, 'tags', 20),
    entities: stringList(value.entities, 'entities', 50),
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.map((ref, i) => validateSourceRef(ref, `source_refs[${i}]`)) : [],
    valid_from: isoTime(value.valid_from, 'valid_from'),
    valid_to: value.valid_to === null || value.valid_to === undefined ? null : isoTime(value.valid_to, 'valid_to'),
    supersedes_id: value.supersedes_id === null || value.supersedes_id === undefined ? null : id(value.supersedes_id, 'supersedes_id'),
    superseded_by_id: value.superseded_by_id === null || value.superseded_by_id === undefined ? null : id(value.superseded_by_id, 'superseded_by_id'),
    importance: value.importance ?? 3,
    created_at: isoTime(value.created_at, 'created_at'),
    updated_at: isoTime(value.updated_at, 'updated_at'),
    last_change_id: id(value.last_change_id, 'last_change_id'),
  };
  if (typeof m.confidence !== 'number' || m.confidence < 0 || m.confidence > 1) throw new SchemaError('confidence must be within 0..1');
  if (!Number.isInteger(m.importance) || m.importance < 1 || m.importance > 5) throw new SchemaError('importance must be an integer 1..5');
  if (m.source_kind === 'agent-inference' && m.type !== 'hypothesis') {
    throw new SchemaError('agent-inference memories must be typed hypothesis; a model guess is not a user fact');
  }
  if (m.status === 'active' && m.source_refs.length === 0) {
    throw new SchemaError('an active memory needs at least one source_ref into a DSH Session');
  }
  return m;
}

/**
 * A change proposal is what an extractor, a user correction, or a Mnemon tool
 * call hands to the writer. It is NOT yet a memory. `idempotency_key` is the
 * caller's own stable key; replaying the same key never writes twice.
 */
export function validateProposal(value) {
  if (typeof value !== 'object' || value === null) throw new SchemaError('proposal must be an object');
  const changeType = oneOf(value.change_type, CHANGE_TYPES, 'change_type');
  const p = {
    idempotency_key: text(value.idempotency_key, 'idempotency_key', 256),
    change_type: changeType,
    owner_id: text(value.owner_id, 'owner_id', 128),
    target_memory_id: value.target_memory_id === undefined || value.target_memory_id === null ? null : id(value.target_memory_id, 'target_memory_id'),
    expected_base_change_id: value.expected_base_change_id === undefined || value.expected_base_change_id === null ? null : id(value.expected_base_change_id, 'expected_base_change_id'),
    content: optionalText(value.content, 'content'),
    type: value.type === undefined ? undefined : oneOf(value.type, MEMORY_TYPES, 'type'),
    source_kind: oneOf(value.source_kind, SOURCE_KINDS, 'source_kind'),
    confidence: value.confidence ?? (value.source_kind === 'user-explicit' || value.source_kind === 'user-correction' ? 0.95 : 0.6),
    importance: value.importance ?? 3,
    scope: optionalText(value.scope, 'scope', 256),
    tags: stringList(value.tags, 'tags', 20),
    entities: stringList(value.entities, 'entities', 50),
    source_refs: Array.isArray(value.source_refs) ? value.source_refs.map((ref, i) => validateSourceRef(ref, `source_refs[${i}]`)) : [],
    reason: optionalText(value.reason, 'reason', 4000),
    actor: oneOf(value.actor ?? 'agent', ['user', 'agent', 'system'], 'actor'),
    user_confirmed: value.user_confirmed === true,
  };
  if (changeType === 'ADD') {
    if (p.content === undefined) throw new SchemaError('ADD requires content');
    if (p.target_memory_id !== null) throw new SchemaError('ADD must not name a target_memory_id');
    if (p.source_refs.length === 0) throw new SchemaError('ADD requires at least one source_ref');
  } else {
    if (p.target_memory_id === null) throw new SchemaError(`${changeType} requires target_memory_id`);
    if ((changeType === 'UPDATE' || changeType === 'SUPERSEDE') && p.content === undefined) throw new SchemaError(`${changeType} requires content`);
    if (changeType === 'RETRACT' && p.content !== undefined) throw new SchemaError('RETRACT does not accept content');
  }
  return p;
}

export function newMemoryId(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `M-${stamp}-${randomUUID().slice(0, 8)}`;
}

export function newChangeId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
  return `MC-${stamp}-${randomUUID().slice(0, 8)}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic JSON for files and digests: sorted keys, 2-space indent, trailing newline. */
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}
