// Deterministic condensation for standing constraints.
//
// A constraint reaches every turn, so it cannot be the full original document.
// The summary must also never pretend to be complete: whatever this file cannot
// keep safely, it reports as dropped or refuses to produce a summary at all.

import { createHash } from 'node:crypto';

/** Sentences whose meaning changes if they are cut away. */
export const PROTECTIVE_MARKERS = Object.freeze([
  // negation
  '不', '别', '禁止', '勿', '无需', '不必', '不得', '不能', '不要', '避免', '严禁',
  // condition
  '如果', '若', '只要', '除非', '否则', '假如', '一旦', '当',
  // order
  '先', '再', '然后', '之后', '随后', '最后',
  // exception
  '除外', '除了', '以外', '例外', '但是', '然而', '不过', '仅', '只',
  // precondition
  '前提', '必须', '需要', '才能', '只有', '至少',
]);

/** Why a sentence was left out of a summary. */
export const DROP_REASONS = Object.freeze({
  CAPACITY: 'over-capacity',
  LOWER_PRIORITY: 'lower-priority',
  EMPTY: 'empty',
});

/**
 * The canonical form used for fingerprints.
 *
 * Both the script that writes a digest and the runtime that verifies it must
 * call this, or "unchanged" would mean two different things.
 */
export function normaliseForDigest(content) {
  return String(content ?? '')
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/** Full SHA-256 over the UTF-8 bytes of the normalised content. */
export function sourceDigestOf(content) {
  return `sha256:${createHash('sha256').update(normaliseForDigest(content), 'utf8').digest('hex')}`;
}

function sentencesOf(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (value === '') return [];
  const parts = value.split(/(?<=[。！？!?；;\n])/u).map((part) => part.trim()).filter((part) => part !== '');
  return parts.length === 0 ? [value] : parts;
}

export function protectiveReason(sentence) {
  const value = String(sentence ?? '');
  for (const marker of PROTECTIVE_MARKERS) {
    if (value.includes(marker)) return marker;
  }
  return null;
}

/**
 * Condense one memory down to at most `maxChars`.
 *
 * Heuristic, and labelled as such. Protected sentences win the budget; when a
 * protected sentence cannot fit, this refuses instead of cutting it, because a
 * truncated "除非" rule is worse than no rule.
 */
export function condense(memory, options = {}) {
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 120;
  const method = typeof options.method === 'string' ? options.method : 'deterministic-v1';
  const content = String(memory && memory.content !== undefined ? memory.content : '');
  const sourceDigest = sourceDigestOf(content);
  const sentences = sentencesOf(content);
  if (sentences.length === 0) {
    return { ok: false, reason: 'empty-content', method, sourceDigest, maxChars, text: '', dropped: [] };
  }

  const protectedIndexes = [];
  const ordinaryIndexes = [];
  sentences.forEach((sentence, index) => {
    if (protectiveReason(sentence) !== null) protectedIndexes.push(index);
    else ordinaryIndexes.push(index);
  });

  const kept = [];
  const dropped = [];
  let used = 0;

  const tryKeep = (index) => {
    const sentence = sentences[index];
    if (used + sentence.length > maxChars) return false;
    kept.push(index);
    used += sentence.length;
    return true;
  };

  // 1. Protected sentences first: losing one changes the meaning.
  for (const index of protectedIndexes) {
    if (!tryKeep(index)) {
      return {
        ok: false,
        reason: 'protected-sentence-too-long',
        method,
        sourceDigest,
        maxChars,
        text: '',
        dropped: sentences.map((sentence, position) => ({
          text: sentence,
          reason: position === index ? DROP_REASONS.CAPACITY : (kept.includes(position) ? null : DROP_REASONS.LOWER_PRIORITY),
        })).filter((entry) => entry.reason !== null),
      };
    }
  }

  // 2. The opening sentence, when it is not already kept.
  if (!kept.includes(0)) tryKeep(0);

  // 3. Best-effort filler while the budget allows.
  for (const index of ordinaryIndexes) {
    if (kept.includes(index)) continue;
    if (!tryKeep(index)) dropped.push({ text: sentences[index], reason: DROP_REASONS.CAPACITY });
  }
  for (let index = 0; index < sentences.length; index += 1) {
    if (kept.includes(index)) continue;
    if (dropped.some((entry) => entry.text === sentences[index])) continue;
    dropped.push({ text: sentences[index], reason: DROP_REASONS.LOWER_PRIORITY });
  }

  const text = kept
    .sort((left, right) => left - right)
    .map((index) => sentences[index])
    .join(' ')
    .trim();

  if (text === '' || text.length > maxChars) {
    // Extremely short caps can make even one sentence impossible; refuse rather
    // than return something that silently dropped a rule.
    return { ok: false, reason: 'cannot-fit', method, sourceDigest, maxChars, text: '', dropped };
  }

  return { ok: true, method, sourceDigest, maxChars, text, dropped, protectedKept: protectedIndexes.filter((index) => kept.includes(index)) };
}

export const CONDENSERS = Object.freeze({ 'deterministic-v1': condense });
