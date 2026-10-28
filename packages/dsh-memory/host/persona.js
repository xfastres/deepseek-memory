// Persona: a read-only view over the long-lived preferences and instructions.
//
// A persona line is never generated text. It is one of the user's own sentences
// (the most recent member of a cluster) plus the ids that support it and a
// count. That keeps the rule the whole system is built on: every conclusion
// must point at words the user actually said.
//
// This view never enters the prompt. It looks like the ideal thing to inject —
// short and general — but it cannot be traced back by the model, and once a
// picture of the user is in the context the model tends to confirm it instead
// of reading the evidence.

// These must be ledger types (MEMORY_TYPES in provider-git-ledger/schema.js),
// not rule kinds. Extraction says "instruction", but the write boundary maps
// it to "constraint" (memory-types.js); reading "instruction" here would
// silently drop every instruction the user ever gave.
const PERSONA_TYPES = new Set(['preference', 'constraint', 'decision']);
const HEADLINE = 80;

function eligible(memories) {
  if (!Array.isArray(memories)) return [];
  return memories.filter((memory) => memory
    && memory.status === 'active'
    && PERSONA_TYPES.has(memory.type)
    && typeof memory.content === 'string'
    && memory.content.trim() !== '');
}

function timeOf(memory) {
  const parsed = Date.parse(memory.accepted_at ?? memory.updated_at ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function entitiesOf(memory) {
  const entities = Array.isArray(memory.entities) ? memory.entities : [];
  return entities
    .filter((entity) => typeof entity === 'string' && entity.trim() !== '')
    .map((entity) => entity.trim().toLowerCase())
    .sort();
}

/**
 * Group memories by type and shared entity.
 *
 * A memory with entities joins one cluster per entity; a memory without any
 * entity forms its own singleton cluster under its type, so unrelated
 * statements are not silently merged into one "preference" line.
 */
function clusters(memories) {
  const groups = new Map();
  for (const memory of memories) {
    const entities = entitiesOf(memory);
    const keys = entities.length === 0
      ? [`${memory.type}::<none>::${memory.id}`]
      : entities.map((entity) => `${memory.type}::${entity}`);
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, { type: memory.type, key, members: [] });
      groups.get(key).members.push(memory);
    }
  }
  return [...groups.values()];
}

/**
 * Build the persona view.
 *
 * @param {Array<object>} memories ledger memories
 * @param {{minSources?: number, headlineLength?: number}} [options]
 * @returns {{lines: Array<object>, considered: number}}
 */
export function buildPersona(memories, options = {}) {
  const minSources = Number.isInteger(options.minSources) && options.minSources > 0 ? options.minSources : 2;
  const headlineLength = Number.isInteger(options.headlineLength) ? options.headlineLength : HEADLINE;
  const source = eligible(memories);

  const lines = [];
  for (const cluster of clusters(source)) {
    if (cluster.members.length < minSources) continue;
    const ordered = [...cluster.members].sort((left, right) => timeOf(right) - timeOf(left));
    const headline = ordered[0];
    lines.push({
      type: cluster.type,
      text: headline.content.length > headlineLength ? `${headline.content.slice(0, headlineLength)}…` : headline.content,
      sources: ordered.map((memory) => memory.id),
      count: ordered.length,
    });
  }

  lines.sort((left, right) => right.count - left.count || left.text.localeCompare(right.text));
  return { lines, considered: source.length };
}

/**
 * A version string for the view: the ledger head is enough, because the ledger
 * is the only source. When the head changes the cached persona is stale.
 */
export function personaVersion(head) {
  if (typeof head !== 'string' || head.trim() === '') return null;
  return head.trim().slice(0, 12);
}

/** Is a cached persona still describing the current ledger? */
export function personaFresh(cached, head) {
  if (cached === null || typeof cached !== 'object') return false;
  const version = personaVersion(head);
  if (version === null) return false;
  return cached.version === version;
}
