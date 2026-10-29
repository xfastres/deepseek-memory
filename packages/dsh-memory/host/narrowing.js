// What a "too broad" objection is allowed to become (§6.6).
//
// The roadmap is explicit: "用户说太宽泛" only means the scope needs another look. It
// does not authorise a replacement sentence. A narrower wording may be proposed
// only when evidence supports that exact wording. This module has no model and
// no second source of words, so it never produces one. The objection stays
// open and the user edits, keeps, or rejects the original.

import { isReviewOnlyKind } from './corrections.js';

/**
 * Decide whether an objection may become an update proposal.
 *
 * @returns {{propose: boolean, reason: string, narrowed: false}}
 */
export function narrowingRequest({ objection, memory } = {}) {
  const kind = objection !== null && typeof objection === 'object' ? objection.kind : null;
  if (!isReviewOnlyKind(kind)) return { propose: false, narrowed: false, reason: 'not-a-review' };
  if (memory === null || typeof memory !== 'object' || memory.status !== 'active' || typeof memory.content !== 'string' || memory.content.trim() === '') {
    return { propose: false, narrowed: false, reason: 'memory-unavailable' };
  }
  const refs = Array.isArray(memory.source_refs) ? memory.source_refs : [];
  if (!refs.some((ref) => ref !== null && typeof ref === 'object')) {
    return { propose: false, narrowed: false, reason: 'no-evidence' };
  }
  // Evidence that the sentence was said is not evidence for a narrower sentence.
  return { propose: false, narrowed: false, reason: 'no-narrower-wording' };
}
