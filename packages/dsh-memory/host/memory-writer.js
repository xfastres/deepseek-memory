// MemoryWriter: the only Host path that may ask the ledger to commit an ADD.
//
// M1 is deliberately small. Production HTTP routes do not call this module,
// and writesEnabled defaults to false so constructing a writer does not open
// a write. A test (or a later phase) opts in explicitly.
//
// The ledger service's applyGated is not a public back door: it checks a
// token that exists only on this module. Passing the token from anywhere else
// is a bug, not a supported API.

import { randomUUID } from 'node:crypto';

import {
  EvidenceConflictError,
  canonicalIntent,
  intentHash,
} from '../../provider-git-ledger/src/canonical.js';

export class WriteGateError extends Error {
  constructor(status, error, message = error) {
    super(message);
    this.name = 'WriteGateError';
    this.status = status;
    this.error = error;
  }
}

function gateError(error) {
  if (error instanceof WriteGateError || error instanceof EvidenceConflictError) return error;
  if (error && error.status && error.error) return error;
  return new WriteGateError(500, 'internal', error && error.message ? error.message : 'write failed');
}

/**
 * @param {object} options
 * @param {{ applyGated: Function, ownerId?: string }} options.service
 * @param {(caller: unknown) => boolean} [options.callerAuth]
 * @param {(approvalId: string, hash: string) => Promise<{intent_sha256:string, actor?:string, user_confirmed?:boolean, source_kind?:string}|null|undefined>} [options.verifyApproval]
 * @param {(refs: object[]) => Promise<{verified:boolean}>} [options.verifyEvidence]
 * @param {boolean} [options.writesEnabled]
 */
export function createMemoryWriter(options = {}) {
  const {
    service,
    callerAuth = () => false,
    verifyApproval,
    verifyEvidence,
    writesEnabled = false,
  } = options;
  if (!service || typeof service.applyGated !== 'function') {
    throw new Error('memory writer requires a ledger service');
  }
  // One Symbol per writer. applyGated checks this exact value, so another
  // module that merely imported the service cannot mint a matching token.
  const token = Symbol('dsh-memory.writer');
  if (typeof service.bindWriter === 'function') service.bindWriter(token);

  async function apply({ caller, approvalId, intent } = {}) {
    try {
      if (callerAuth(caller) !== true) throw new WriteGateError(401, 'unauthenticated');
      if (writesEnabled !== true) throw new WriteGateError(503, 'write-gate-not-ready');
      if (typeof approvalId !== 'string' || approvalId.trim() === '') {
        throw new WriteGateError(403, 'approval-required');
      }
      if (typeof verifyApproval !== 'function') throw new WriteGateError(403, 'approval-required');

      const canonical = canonicalIntent(intent);
      const hash = intentHash(intent);
      const approval = await verifyApproval(approvalId, hash);
      if (approval === null || approval === undefined) throw new WriteGateError(403, 'approval-required');
      if (approval.intent_sha256 !== hash) throw new WriteGateError(409, 'approval-intent-mismatch');

      if (typeof verifyEvidence !== 'function') throw new WriteGateError(503, 'evidence-unavailable');
      const checked = await verifyEvidence(canonical.source_refs);
      if (checked === null || checked === undefined || checked.verified !== true) {
        throw new WriteGateError(422, 'evidence-invalid');
      }

      // The approval id is the idempotency key. A second call with the same
      // approval and the same intent replays the receipt. A different intent
      // never reaches here: the hash check above rejects it first, so the
      // ledger cannot be asked to commit a second meaning under this key.
      const result = await service.applyGated({
        idempotency_key: approvalId,
        change_type: 'ADD',
        content: canonical.content,
        type: canonical.type ?? 'fact',
        scope: canonical.scope ?? undefined,
        tags: canonical.tags,
        entities: canonical.entities,
        source_refs: canonical.source_refs,
        source_kind: approval.source_kind ?? canonical.source_kind ?? 'user-explicit',
        actor: approval.actor === 'system' || approval.actor === 'agent' ? approval.actor : 'user',
        user_confirmed: approval.user_confirmed === true,
      }, token);
      return { ...result, intent_sha256: hash };
    } catch (error) {
      throw gateError(error);
    }
  }

  return {
    apply,
    writesEnabled: writesEnabled === true,
    token,
    newApprovalId: () => `AP-${randomUUID()}`,
  };
}
