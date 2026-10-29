// Why a user says a memory is wrong.
//
// §10.1 of the roadmap names the correction entries a user needs; keeping the
// list here means the UI, the Host and the tests share one vocabulary instead
// of each inventing strings. A free-text note may accompany a kind, but the
// kind is the machine-readable part.

export const CORRECTION_KINDS = Object.freeze([
  'wrong',
  'too_broad',
  'outdated',
  'missing_context',
  'wrong_scope',
  'duplicate',
  'should_not_save',
  'delete',
]);

/**
 * Natural-language cues may name a synonym (`incorrect`, `delete_request`).
 * Persistence and the panel vocabulary stay on CORRECTION_KINDS, so every
 * writer normalizes through this map before recording an objection.
 */
export const CORRECTION_KIND_ALIASES = Object.freeze({
  incorrect: 'wrong',
  delete_request: 'delete',
});

/**
 * Kinds that ask for a re-check rather than a stop (§6.3).
 *
 * "太宽泛" does not mean the memory is false, so the memory goes to
 * review_pending instead of being treated as corrected. The distinction is
 * documented in one place because the panel, the Host and the runtime all ask
 * the same question.
 */
export const REVIEW_ONLY_KINDS = Object.freeze(['too_broad', 'missing_context', 'wrong_scope', 'duplicate']);

export function isReviewOnlyKind(value) {
  return typeof value === 'string' && REVIEW_ONLY_KINDS.includes(value);
}

export function isCorrectionKind(value) {
  return typeof value === 'string' && CORRECTION_KINDS.includes(value);
}

/** Map a cue synonym onto the shared vocabulary, or leave a known kind alone. */
export function normalizeCorrectionKind(value) {
  if (typeof value !== 'string' || value === '') return value;
  if (Object.prototype.hasOwnProperty.call(CORRECTION_KIND_ALIASES, value)) {
    return CORRECTION_KIND_ALIASES[value];
  }
  return value;
}
