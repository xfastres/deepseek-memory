// Candidate classification against the active ledger memories.
//
// The goal is the one thing the roadmap forbids doing silently: turning a
// conflicting claim into an update. This module therefore only ever answers
// ADD / NO_CHANGE / CONFLICT. UPDATE is a decision for the user (merge), so it
// is deliberately never inferred here.

export const DECISIONS = Object.freeze(['ADD', 'NO_CHANGE', 'CONFLICT']);

function normaliseClaim(text) {
  return String(text ?? '').replace(/\s+/gu, '').toLowerCase();
}

/** Tokens for overlap checks: latin words when present, otherwise characters. */
function tokens(text) {
  const value = normaliseClaim(text);
  if (value === '') return [];
  const words = value.match(/[a-z0-9]+/gu) ?? [];
  if (words.length > 0) return words;
  return [...value];
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / (a.size + b.size - common);
}

/**
 * Classify one candidate against the active memories.
 *
 * @returns {{ decision: 'ADD'|'NO_CHANGE'|'CONFLICT', targetId: string|null, reason: string }}
 *   `reason` is a short machine-readable explanation: empty / duplicate /
 *   included / overlap / new.
 */
export function classifyCandidate(candidate, memories) {
  const text = candidate !== null && typeof candidate === 'object' && typeof candidate.text === 'string'
    ? candidate.text
    : '';
  const type = candidate !== null && typeof candidate === 'object' && typeof candidate.type === 'string'
    ? candidate.type
    : null;
  const normal = normaliseClaim(text);
  if (normal === '') return { decision: 'NO_CHANGE', targetId: null, reason: 'empty' };

  const active = (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory !== null && typeof memory === 'object' && memory.status === 'active' && typeof memory.content === 'string');

  // A different memory type is a different kind of claim; it is neither a
  // duplicate nor a conflict of the same statement.
  const sameKind = (memory) => type === null || typeof memory.type !== 'string' || memory.type === type;
  const exact = active.find((memory) => sameKind(memory) && normaliseClaim(memory.content) === normal);
  if (exact !== undefined) return { decision: 'NO_CHANGE', targetId: exact.id ?? null, reason: 'duplicate' };

  const candidateTokens = tokens(text);
  let closest = null;
  let closestScore = 0;
  for (const memory of active) {
    if (!sameKind(memory)) continue;
    const value = normaliseClaim(memory.content);
    if (value.includes(normal) || normal.includes(value)) {
      return { decision: 'CONFLICT', targetId: memory.id ?? null, reason: 'included' };
    }
    const score = jaccard(candidateTokens, tokens(memory.content));
    if (score > closestScore) {
      closest = memory;
      closestScore = score;
    }
  }
  if (closest !== null && closestScore >= 0.6) {
    return { decision: 'CONFLICT', targetId: closest.id ?? null, reason: 'overlap' };
  }
  return { decision: 'ADD', targetId: null, reason: 'new' };
}

/** Classify a whole queue in one pass; never mutates its input. */
export function classifyCandidates(candidates, memories) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list.map((candidate) => ({
    ...(candidate !== null && typeof candidate === 'object' ? candidate : {}),
    classification: classifyCandidate(candidate, memories),
  }));
}
