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
export function decideAutoMemory({ candidate, memories, settings }) {
  const classification = classifyCandidate(candidate, memories);
  const refs = candidate !== null && typeof candidate === 'object' && Array.isArray(candidate.source_refs)
    ? candidate.source_refs
    : [];
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
  await runtime.setCandidateStatus(candidate.id, 'accepted', typeof memoryId === 'string' ? { memoryId } : {});
  return result;
}
