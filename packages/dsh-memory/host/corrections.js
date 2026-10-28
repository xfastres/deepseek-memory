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

export function isCorrectionKind(value) {
  return typeof value === 'string' && CORRECTION_KINDS.includes(value);
}
