// Which of the user's already-confirmed names appear in this sentence?
//
// Extraction cannot invent entities: an entity is a claim about the world, and
// a wrong one silently links unrelated memories. So a candidate may only carry
// an entity the ledger already holds — something the user (or a review) already
// accepted. This keeps the L2 entity clustering fed without adding inference.

const MIN_ENTITY_LENGTH = 2;
const MAX_ENTITIES = 50;

function normalise(value) {
  return String(value ?? '').toLocaleLowerCase();
}

/**
 * Entities from the ledger that the text actually mentions.
 *
 * Matching is case-insensitive and literal. Short entities (one character) are
 * ignored because they match almost everything; a single mention is enough,
 * and the original casing from the ledger is kept so rows stay readable.
 *
 * @param {string} text sentence the user said
 * @param {Array<object>} memories ledger memories
 * @returns {string[]} sorted, de-duplicated entities, at most 50
 */
export function matchKnownEntities(text, memories) {
  const value = normalise(text);
  if (value.trim() === '') return [];
  const found = new Map();
  for (const memory of Array.isArray(memories) ? memories : []) {
    if (memory === null || typeof memory !== 'object') continue;
    if (memory.status !== 'active') continue;
    for (const entity of Array.isArray(memory.entities) ? memory.entities : []) {
      if (typeof entity !== 'string') continue;
      const trimmed = entity.trim();
      if (trimmed.length < MIN_ENTITY_LENGTH) continue;
      const key = normalise(trimmed);
      if (found.has(key)) continue;
      if (!value.includes(key)) continue;
      found.set(key, trimmed);
      if (found.size >= MAX_ENTITIES) break;
    }
    if (found.size >= MAX_ENTITIES) break;
  }
  return [...found.values()].sort((left, right) => left.localeCompare(right));
}
