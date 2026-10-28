// Memory injection: put a small, explainable memory block into the prompt.
//
// Shape of the problem: prompt assembly is synchronous and only sees a scope,
// while the ledger is Git-backed and asynchronous. So the ledger is read into
// an in-memory snapshot (refreshed on writes and on a timer), and the context
// provider is a pure function over that snapshot.
//
// The current turn's text arrives out of band: `agent/pre-step` carries the
// messages entering the step, so the listener records the text and the
// provider looks it up later. Whether the scope object handed to the provider
// is the same object the listener saw cannot be assumed, so there are two
// paths and the chosen one is reported: a per-scope lookup when it matches, a
// general block (pinned and recent memories, no query scoring) otherwise.

import { formatInjection, selectMemories } from './retrieval.js';

export const CONTEXT_NAME = 'dsh-memory';
export const DEFAULT_LIMIT = 6;
export const DEFAULT_BUDGET = 800;

/** Pull readable text out of a message without depending on one content shape. */
export function messageText(message) {
  if (message === null || message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .join(' ');
  }
  if (typeof message.text === 'string') return message.text;
  return '';
}

/** The user text entering a step, from the pre-step message list. */
export function stepQuery(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const message of messages) {
    if (!message || message.role !== 'user') continue;
    const text = messageText(message).trim();
    if (text !== '') parts.push(text);
  }
  return parts.join('\n').slice(0, 4000);
}

/** Pure selection used by the provider: pinned first, then query relevance. */
export function chooseForContext(memories, query, options = {}) {
  const { now = new Date(), limit = DEFAULT_LIMIT, budget = DEFAULT_BUDGET } = options;
  return selectMemories(memories, query, { now, scope: 'global', limit, budget });
}

/**
 * @param {object} options
 * @param {{state: () => Promise<{memories: Array<object>}>}} options.service
 * @param {() => Date} [options.now]
 */
export function createInjectionRuntime(options = {}) {
  const { service } = options;
  if (!service || typeof service.state !== 'function') throw new Error('service with state() is required');
  const now = options.now ?? (() => new Date());

  let snapshot = { at: null, memories: [] };
  /** scope object -> {turn, text, at} */
  const byScope = new WeakMap();
  let latest = null;
  let lastPath = 'none';
  let lastObservePath = 'none';

  async function refresh() {
    const state = await service.state();
    snapshot = { at: now().toISOString(), memories: Array.isArray(state.memories) ? state.memories : [] };
    return snapshot;
  }

  /** Record what entered a step. Never throws: observation must not break a turn. */
  function observe(scope, payload) {
    try {
      const text = stepQuery(payload && payload.messages);
      const entry = { turn: payload && Number.isInteger(payload.turn) ? payload.turn : null, text, at: now().toISOString() };
      latest = entry;
      if (scope !== null && typeof scope === 'object') {
        byScope.set(scope, entry);
        lastObservePath = 'scope';
      } else {
        lastObservePath = 'unscoped';
      }
      return entry;
    } catch {
      return null;
    }
  }

  /** Look up the observation for an assembly scope, with an explicit fallback. */
  function lookup(scope) {
    if (scope !== null && typeof scope === 'object') {
      const remembered = byScope.get(scope);
      if (remembered !== undefined) {
        lastPath = 'scope';
        return remembered;
      }
    }
    if (latest !== null) {
      lastPath = 'latest';
      return latest;
    }
    lastPath = 'none';
    return { turn: null, text: '', at: null };
  }

  /**
   * The context text for one assembly.
   *
   * Empty string means "contribute nothing", which the prompt registry treats
   * as no context rather than an empty block.
   */
  function buildText(scope, options2 = {}) {
    const observation = lookup(scope);
    const chosen = chooseForContext(snapshot.memories, observation.text, {
      now: now(),
      limit: options2.limit ?? DEFAULT_LIMIT,
      budget: options2.budget ?? DEFAULT_BUDGET,
    });
    return { text: formatInjection(chosen.chosen), chosen: chosen.chosen, path: lastPath, observation };
  }

  return {
    refresh,
    observe,
    buildText,
    /**
     * Refresh only when the snapshot is missing or older than `ttlMs`.
     *
     * Called from the step boundary, where waiting is acceptable; the prompt
     * provider itself must stay synchronous and never touch the disk.
     */
    async ensureFresh(ttlMs = 30000) {
      const at = snapshot.at === null ? Number.NaN : Date.parse(snapshot.at);
      if (Number.isFinite(at) && now().getTime() - at < ttlMs) return false;
      await refresh();
      return true;
    },
    get path() { return lastPath; },
    get observed() { return lastObservePath; },
    get snapshot() { return snapshot; },
    get latestObservation() { return latest; },
  };
}
