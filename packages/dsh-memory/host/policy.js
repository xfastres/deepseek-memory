// Memory Policy: the hard gates between an extracted candidate and the Writer.
//
// It is a pure decision function. It never writes, never approves its own
// proposal and never overrides the user (D9). The five answers are the ones
// §7.1 of the roadmap defines: AUTO_ACCEPT / REVIEW_REQUIRED / CONFLICT /
// NO_CHANGE / REJECT.
//
// Auto-accept stays off until it is enabled by settings and covered by an
// evaluation set; the policy therefore reports "eligible but disabled" as
// REVIEW_REQUIRED instead of silently writing.

import { MEMORY_TYPES } from '../../provider-git-ledger/src/schema.js';

export const POLICY_DECISIONS = Object.freeze(['AUTO_ACCEPT', 'REVIEW_REQUIRED', 'CONFLICT', 'NO_CHANGE', 'REJECT']);

/** Types that may be auto-accepted once auto-accept is enabled. */
export const AUTO_ACCEPT_TYPES = Object.freeze(['fact', 'preference', 'constraint']);

/** Types that are never auto-accepted: they need the user's own decision. */
export const REVIEW_ONLY_TYPES = Object.freeze(['hypothesis', 'goal', 'decision', 'open_loop', 'event']);

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Decide what may happen to one candidate.
 *
 * @param {object} input
 * @param {{decision: string}|null} [input.classification] the 4.3 answer
 * @param {string|null} [input.type]
 * @param {number|null} [input.confidence]
 * @param {boolean} [input.hasEvidence] a real source ref exists
 * @param {boolean} [input.autoAccept] whether the user enabled auto-accept
 * @param {boolean} [input.sensitive] user marked it private / not for injection
 * @param {number} [input.confidenceThreshold]
 * @returns {{ decision: string, reasons: string[] }}
 */
export function evaluateCandidatePolicy(input = {}) {
  const decisionOf = (value) => (value !== null && typeof value === 'object' && typeof value.decision === 'string' ? value.decision : null);
  const classification = decisionOf(input.classification);
  const type = typeof input.type === 'string' ? input.type : null;
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence) ? input.confidence : null;
  const hasEvidence = input.hasEvidence !== false;
  const autoAccept = input.autoAccept === true;
  const sensitive = input.sensitive === true;
  const threshold = typeof input.confidenceThreshold === 'number' ? input.confidenceThreshold : DEFAULT_CONFIDENCE_THRESHOLD;

  if (classification === 'NO_CHANGE') return { decision: 'NO_CHANGE', reasons: ['duplicate'] };
  if (classification === 'CONFLICT') return { decision: 'CONFLICT', reasons: ['conflict'] };
  if (hasEvidence === false) return { decision: 'REJECT', reasons: ['no-evidence'] };
  if (type !== null && !MEMORY_TYPES.includes(type)) return { decision: 'REJECT', reasons: ['type-not-allowed'] };
  if (sensitive) return { decision: 'REVIEW_REQUIRED', reasons: ['sensitive'] };
  if (confidence !== null && confidence < threshold) return { decision: 'REVIEW_REQUIRED', reasons: ['low-confidence'] };
  if (type !== null && REVIEW_ONLY_TYPES.includes(type)) return { decision: 'REVIEW_REQUIRED', reasons: ['type-needs-user'] };
  if (type === null) return { decision: 'REVIEW_REQUIRED', reasons: ['type-unknown'] };
  if (!AUTO_ACCEPT_TYPES.includes(type)) return { decision: 'REVIEW_REQUIRED', reasons: ['type-not-auto'] };
  if (!autoAccept) return { decision: 'REVIEW_REQUIRED', reasons: ['auto-accept-disabled'] };
  return { decision: 'AUTO_ACCEPT', reasons: ['eligible'] };
}

/** Evaluate a whole queue without mutating it. */
export function evaluateCandidatePolicies(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list.map((candidate) => {
    const row = candidate !== null && typeof candidate === 'object' ? candidate : {};
    const refs = Array.isArray(row.source_refs) ? row.source_refs.filter((ref) => ref !== null && typeof ref === 'object') : [];
    return {
      ...row,
      policy: evaluateCandidatePolicy({
        classification: row.classification ?? null,
        type: row.type ?? null,
        confidence: row.confidence ?? null,
        hasEvidence: refs.length > 0,
        autoAccept: options.autoAccept === true,
        sensitive: options.sensitiveIds !== undefined && options.sensitiveIds !== null && Array.isArray(options.sensitiveIds)
          ? options.sensitiveIds.includes(row.id)
          : false,
        confidenceThreshold: options.confidenceThreshold,
      }),
    };
  });
}
