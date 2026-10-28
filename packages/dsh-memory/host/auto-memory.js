// Controlled auto-accept (§4.5): the only place that may write without review.
//
// Three rules make it safe to leave switched on:
//   1. It is off unless the user enabled both the master switch and auto-accept.
//   2. Every gate is the policy gate the review UI shows; nothing is bypassed.
//   3. It writes through the same single writer (`service.add`) with a
//      deterministic idempotency key, so a retry cannot double-write.
//
// It never approves an AI proposal against the user's wishes: the candidate is
// produced by the rule extractor, and the ledger records its evidence.

import { classifyCandidate } from './classification.js';
import { evaluateCandidatePolicy } from './policy.js';

/** Decide what should happen to one freshly extracted candidate. */
/** The candidate status a policy decision leaves behind. */
export function candidateStatusForPolicy(decision) {
  if (decision === 'AUTO_ACCEPT') return 'auto_accepted';
  if (decision === 'CONFLICT') return 'conflict';
  if (decision === 'NO_CHANGE') return 'no_change';
  if (decision === 'REJECT') return 'rejected';
  return 'review_pending';
}

const normaliseText = (value) => String(value ?? '').toLowerCase().replace(/\s+/gu, '');

/**
 * Decide what should happen to one freshly extracted candidate.
 *
 * `reviewPending` carries the memories the user objected to in a way that asks
 * for a re-check. Re-extracting the same sentence must not quietly bring it
 * back as an auto-accepted memory while the user is still deciding, so it goes
 * to review instead (§6.4: "异议尚未解决的记忆不能被自动接受流程重新激活").
 */
export function decideAutoMemory({ candidate, memories, settings, reviewPending = [] }) {
  const classification = classifyCandidate(candidate, memories);
  const refs = candidate !== null && typeof candidate === 'object' && Array.isArray(candidate.source_refs)
    ? candidate.source_refs
    : [];
  const waiting = new Set(Array.isArray(reviewPending) ? reviewPending.filter((id) => typeof id === 'string') : []);
  if (waiting.size > 0) {
    const text = normaliseText(candidate !== null && typeof candidate === 'object' ? candidate.text : '');
    const blocked = (Array.isArray(memories) ? memories : []).some((memory) => memory !== null
      && typeof memory === 'object'
      && typeof memory.id === 'string'
      && waiting.has(memory.id)
      && normaliseText(memory.content) === text);
    if (blocked) {
      return { classification, policy: { decision: 'REVIEW_REQUIRED', reasons: ['objected-memory'] } };
    }
  }
  const policy = evaluateCandidatePolicy({
    classification,
    type: candidate !== null && typeof candidate === 'object' ? candidate.type : null,
    confidence: candidate !== null && typeof candidate === 'object' ? candidate.confidence : null,
    hasEvidence: refs.length > 0,
    autoAccept: settings !== null && typeof settings === 'object' && settings.enabled === true && settings.autoAccept === true,
    autoAcceptTypes: settings !== null && typeof settings === 'object' ? settings.autoAcceptTypes : undefined,
  });
  return { classification, policy };
}

/**
 * Write an auto-accepted candidate through the single writer.
 *
 * A failed write leaves the candidate pending: the user can still review it,
 * and nothing is claimed to have been saved.
 */
export async function writeAutoAccepted({ service, runtime, candidate }) {
  const result = await service.add({
    content: candidate.text,
    type: candidate.type,
    sourceRefs: candidate.source_refs,
    idempotencyKey: `auto:${candidate.id}`,
  });
  const memoryId = result !== null && typeof result === 'object' && result.memory !== null && typeof result.memory === 'object'
    ? result.memory.id
    : undefined;
  await runtime.setCandidateStatus(candidate.id, 'auto_accepted', typeof memoryId === 'string' ? { memoryId } : {});
  return result;
}
