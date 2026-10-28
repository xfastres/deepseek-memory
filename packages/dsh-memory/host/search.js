// §11 `memory_search`: the model may look, within the same window the user sees.
//
// Search is not a second injection path: it returns rows to the caller and
// never touches the prompt or the injection log. It also must not become a way
// around retrieval policy, so it reuses `eligibility` (active, unexpired,
// quality, non-private, scope) and additionally hides memories the user has
// objected to (D7). A memory the injector would not use must not be findable
// here either.

import { eligibility, scoreMemory } from './retrieval.js';

export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;
export const SEARCH_TEXT_LIMIT = 400;

/**
 * Search the ledger's active memories.
 *
 * @param {object[]} memories rows as the Host state exposes them
 * @param {string} query the user's words
 * @param {object} [options]
 * @returns {{ query: string, results: object[], hidden: number, reason: string|null }}
 */
export function searchMemories(memories, query, options = {}) {
  const text = typeof query === 'string' ? query.trim() : '';
  const rows = Array.isArray(memories) ? memories : [];
  const suppressed = new Set(Array.isArray(options.suppressedIds) ? options.suppressedIds.filter((id) => typeof id === 'string') : []);
  const now = options.now ?? new Date();
  const scope = typeof options.scope === 'string' ? options.scope : 'global';
  const type = typeof options.type === 'string' && options.type !== '' ? options.type : null;
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, SEARCH_MAX_LIMIT)
    : SEARCH_DEFAULT_LIMIT;

  if (text === '') return { query: '', results: [], hidden: 0, reason: 'empty-query' };

  const scored = [];
  let hidden = 0;
  for (const memory of rows) {
    if (memory === null || typeof memory !== 'object') continue;
    const reason = eligibility(memory, { now, scope });
    if (reason !== null) {
      hidden += 1;
      continue;
    }
    if (typeof memory.id === 'string' && suppressed.has(memory.id)) {
      hidden += 1;
      continue;
    }
    if (type !== null && memory.type !== type) continue;
    const score = scoreMemory(memory, text, { now });
    // Search must be about the query, not about recency: a fresh memory that
    // does not mention the words is not a search result.
    if (score.parts.lexical <= 0) continue;
    scored.push({ memory, score });
  }

  scored.sort((a, b) => b.score.total - a.score.total);
  return {
    query: text,
    hidden,
    reason: null,
    results: scored.slice(0, limit).map(({ memory, score }) => ({
      id: typeof memory.id === 'string' ? memory.id : '',
      type: typeof memory.type === 'string' ? memory.type : null,
      content: typeof memory.content === 'string' ? memory.content.slice(0, SEARCH_TEXT_LIMIT) : '',
      version: Number.isInteger(memory.version) ? memory.version : null,
      score: Math.round(score.total * 1000) / 1000,
      hits: score.parts.hits,
      // Evidence travels with the result so a proposal can cite it.
      evidence: Array.isArray(memory.source_refs) ? memory.source_refs.slice(0, 3) : [],
    })),
  };
}
