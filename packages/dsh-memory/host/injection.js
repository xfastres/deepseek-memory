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

import { formatInjection, selectMemories, DEFAULT_CONSTRAINT_BUDGET, DEFAULT_CONSTRAINT_MAX_CHARS, DEFAULT_CONSTRAINT_MAX_ITEMS } from './retrieval.js';
import { createInjectionLog } from './injection-log.js';

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
  return selectMemories(memories, query, {
    now,
    scope: 'global',
    limit,
    budget,
    constraints: options.constraints ?? [],
    constraintBudget: options.constraintBudget ?? DEFAULT_CONSTRAINT_BUDGET,
    constraintMaxChars: options.constraintMaxChars ?? DEFAULT_CONSTRAINT_MAX_CHARS,
    constraintMaxItems: options.constraintMaxItems ?? DEFAULT_CONSTRAINT_MAX_ITEMS,
  });
}

/** A compact, string-only description of a scope object, for diagnosis. */
export function scopeShape(scope) {
  if (scope === null || scope === undefined) return { type: String(scope) };
  if (typeof scope !== 'object') return { type: typeof scope };
  let keys = [];
  try {
    keys = Object.keys(scope).slice(0, 12);
  } catch {
    keys = [];
  }
  const sessionish = [];
  const add = (value) => {
    if (typeof value === 'string' && /^session-|^[0-9a-f-]{20,}$/u.test(value)) sessionish.push(value.slice(0, 48));
  };
  try {
    add(scope.id);
    add(scope.key);
    add(scope.sessionId);
    add(scope.name);
    if (scope.agent && typeof scope.agent === 'object') add(scope.agent.id);
  } catch {
    // A getter that throws is itself information; the keys above still show.
  }
  return { type: 'object', keys, sessionish };
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
  /** agent id -> {turn, text, at} */
  const byAgent = new Map();
  let latest = null;
  let lastPath = 'none';
  let lastObservePath = 'none';
  let probe = null;
  const injectionLog = createInjectionLog({ now });
  let flushed = 0;
  let constraintState = { usable: [], rejected: [], config: null, fallback: [], loaded: false };

  async function refresh() {
    const state = await service.state();
    // An objection suppresses a memory before retrieval ever sees it (D7):
    // the filter runs here, not inside scoring, so no scorer can forget it.
    // A failed suppression read must not fail open: keep the last filtered
    // snapshot when one exists, otherwise inject nothing until suppression is
    // readable again. Re-injecting an objected memory after the user already
    // objected is worse than a temporarily empty block.
    let suppressed = [];
    if (typeof service.suppressed === 'function') {
      try {
        const ids = await service.suppressed();
        suppressed = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
      } catch {
        if (snapshot.at !== null) {
          snapshot = {
            ...snapshot,
            at: now().toISOString(),
            degraded: 'suppression-unavailable',
          };
          return snapshot;
        }
        snapshot = {
          at: now().toISOString(),
          head: typeof state.head === 'string' ? state.head : null,
          memories: [],
          suppressed: 0,
          degraded: 'suppression-unavailable',
        };
        return snapshot;
      }
    }
    const memories = Array.isArray(state.memories) ? state.memories : [];
    snapshot = {
      at: now().toISOString(),
      head: typeof state.head === 'string' ? state.head : null,
      memories: suppressed.length === 0 ? memories : memories.filter((memory) => !(memory !== null && typeof memory === 'object' && suppressed.includes(memory.id))),
      suppressed: suppressed.length,
    };
    return snapshot;
  }

  /** Record what entered a step. Never throws: observation must not break a turn. */
  function observe(scope, payload) {
    try {
      const text = stepQuery(payload && payload.messages);
      const agentId = payload && payload.agent && typeof payload.agent.id === 'string' ? payload.agent.id : null;
      const entry = { turn: payload && Number.isInteger(payload.turn) ? payload.turn : null, agentId, text, at: now().toISOString() };
      latest = entry;
      if (scope !== null && typeof scope === 'object') {
        byScope.set(scope, entry);
        lastObservePath = 'scope';
      } else {
        lastObservePath = 'unscoped';
      }
      if (agentId !== null) byAgent.set(agentId, entry);
      if (probe === null) probe = { observed: scopeShape(scope), agent: agentId === null ? null : agentId.slice(0, 48) };
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Look up the observation for an assembly scope.
   *
   * Three outcomes, and the difference matters:
   *   - `scope`: the assembly reported the very object the step recorded;
   *   - `agent`: the scope carried a session id we observed;
   *   - `latest`: only one session has ever been seen, so "latest" is that one.
   *
   * When several sessions have been seen and none of the above matches, the
   * answer is `ambiguous` and the query is dropped. Injecting another session's
   * query would be worse than injecting nothing: it looks correct and is not.
   */
  function lookup(scope) {
    if (scope !== null && typeof scope === 'object') {
      const remembered = byScope.get(scope);
      if (remembered !== undefined) {
        lastPath = 'scope';
        return remembered;
      }
      const shape = scopeShape(scope);
      for (const candidate of shape.sessionish ?? []) {
        for (const [agentId, entry] of byAgent) {
          if (agentId.startsWith(candidate) || candidate.startsWith(agentId.slice(0, 36))) {
            lastPath = 'agent';
            return entry;
          }
        }
      }
    }
    if (probe !== null && probe.observed !== undefined) {
      probe.consumed = scopeShape(scope);
    }
    if (byAgent.size > 1) {
      lastPath = 'ambiguous';
      return { turn: null, text: '', at: null };
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
    // Precedence: explicit option, then the configured budget, then the default.
    // The config file is the user's contract; an option is the caller's override.
    const configuredBudget = constraintState.config !== null && constraintState.config !== undefined && Number.isInteger(constraintState.config.budget)
      ? constraintState.config.budget
      : DEFAULT_BUDGET;
    const budget = Number.isInteger(options2.budget) ? options2.budget : configuredBudget;
    const limit = options2.limit ?? DEFAULT_LIMIT;
    const selected = chooseForContext(snapshot.memories, observation.text, {
      now: now(),
      limit,
      budget,
      constraints: constraintState.usable,
      constraintBudget: constraintState.config === null ? undefined : constraintState.config.constraints.budget,
      constraintMaxChars: constraintState.config === null ? undefined : constraintState.config.constraints.maxChars,
      constraintMaxItems: constraintState.config === null ? undefined : constraintState.config.constraints.maxItems,
    });

    // The selection budget counts bodies; the prompt costs a header, numbering
    // and labels too. So shrink the selection until the text that will really
    // be returned fits, and record why each entry left.
    const excluded = selected.excluded.slice();
    let chosen = selected.chosen.slice();
    let rendered = formatInjection(chosen);
    while (rendered.length > budget && chosen.length > 0) {
      const dynamic = [...chosen].reverse().find((entry) => entry.kind !== 'constraint');
      const victim = dynamic ?? chosen[chosen.length - 1];
      chosen = chosen.filter((entry) => entry !== victim);
      excluded.push({
        id: victim.memory && victim.memory.id ? victim.memory.id : null,
        reason: 'over-budget-after-format',
        pool: victim.kind === 'constraint' ? 'constraint' : 'dynamic',
      });
      rendered = formatInjection(chosen);
    }

    const memoryIds = chosen.map((entry) => (entry.memory && entry.memory.id ? entry.memory.id : '')).filter((id) => id !== '');
    const { record, duplicate } = injectionLog.note({
      sessionId: observation.agentId ?? null,
      turn: observation.turn ?? null,
      snapshotHead: snapshot.head ?? null,
      memoryIds,
      reasons: chosen.map((entry) => entry.reason),
      // Audit needs the budget split and the per-entry decision, not the body.
      pools: selected.pools,
      memories: chosen.map((entry) => ({
        id: entry.memory && entry.memory.id ? entry.memory.id : null,
        kind: entry.kind === 'constraint' ? 'constraint' : 'memory',
        chars_used: entry.chars_used ?? entry.text.length,
        reason: String(entry.reason ?? ''),
      })),
      excluded: excluded.slice(0, 20).map((entry) => ({ id: entry.id ?? null, reason: entry.reason ?? null })),
      text: rendered,
    });

    return {
      text: rendered,
      chosen,
      excluded,
      path: lastPath,
      observation,
      chars: rendered.length,
      pools: selected.pools,
      budget,
      record,
      duplicate,
      confirmed: null,
    };
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
    get probe() { return probe; },
    get agentCount() { return byAgent.size; },
    get snapshot() { return snapshot; },
    get constraints() { return constraintState; },
    get log() { return { stats: () => ({ ...injectionLog.stats(), pending: injectionLog.records().length - flushed }), records: () => injectionLog.records() }; },
    setConstraints(next) {
      constraintState = next ?? { usable: [], rejected: [], config: null, fallback: [], loaded: false };
    },
    pendingRecords() { return injectionLog.records().slice(flushed); },
    markFlushed(count) { flushed += Math.max(0, Number.isInteger(count) ? count : 0); },
    get lastInjection() { return injectionLog.records().slice(-1)[0] ?? null; },
    get latestObservation() { return latest; },
  };
}
