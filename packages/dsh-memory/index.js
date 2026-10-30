/**
 * Host half of the memory bundle.
 *
 * Two hard rules shape this file:
 *
 * 1. Nothing here may block Web boot. Every step is guarded, and a failure
 *    leaves the plugin loaded but route-less instead of failing activation.
 * 2. Routes are reachable only from a loopback socket with a loopback Host
 *    header; mutations additionally need a browser same-origin marker.
 *
 * The route shape is not a guess: `webServer.register` takes
 * `{ kind: 'exact' | 'prefix', path, handler(req, res) }`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

import {
  API_PREFIX,
  createAppRoutes,
  createMemoryApp,
  isTrustedRead,
  isTrustedWrite,
  readJsonBody,
  writeJson,
} from './host/http-app.js';
import { CONTEXT_NAME, createInjectionRuntime } from './host/injection.js';
import { loadConfig, resolveConstraints } from './host/constraints.js';
import { applyCorrection, isCorrectionCandidate } from './host/correction-detect.js';
import { matchKnownEntities } from './host/entity-match.js';
import { extractCandidates } from './host/extraction.js';
import { candidateStatusForPolicy, decideAutoMemory, writeAutoAccepted } from './host/auto-memory.js';
import { searchMemories } from './host/search.js';
import { createTrace, envValue, traceEnabled, TRACE_FILE, TRACE_MARKER } from './host/trace.js';

export { API_PREFIX, isTrustedWrite, writeJson };

export const ROUTE_PREFIX = API_PREFIX;
export const PING_PATH = `${API_PREFIX}/ping`;

/** Routes served by the memory application, in addition to the ping probe. */
export const APP_ROUTE_NAMES = Object.freeze([
  'state', 'history', 'changes', 'export', 'add', 'update', 'retract', 'migrate', 'candidates', 'candidate', 'review', 'objections', 'objections/clear', 'settings', 'proposals', 'injections',
]);

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackAddress(value) {
  return typeof value === 'string' && LOOPBACK_ADDRESSES.has(value);
}

export function isLoopbackHostname(value) {
  return typeof value === 'string' && LOOPBACK_HOSTNAMES.has(value.toLowerCase());
}

/** The read fence, shared with the memory application. */
export const isTrustedRequest = isTrustedRead;

/**
 * Runtime capability probe. The index design depends on two facts that cannot
 * be assumed inside an Electron Host: whether `node:sqlite` is importable
 * without a launch flag, and whether FTS5 ships with a trigram tokenizer (the
 * only tokenizer that recalls CJK text without a word segmenter). Both are
 * answered once per process and cached, because the answer cannot change.
 */
let sqliteProbe;

export function probeSqlite() {
  if (sqliteProbe === undefined) {
    sqliteProbe = (async () => {
      const result = { ok: false, fts5: false, trigram: false, error: null };
      let db;
      try {
        const { DatabaseSync } = await import('node:sqlite');
        db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE probe (value TEXT); INSERT INTO probe VALUES (\'x\');');
        const row = db.prepare('SELECT COUNT(*) AS n FROM probe').get();
        result.ok = Number(row && row.n) === 1;
        try {
          db.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(content, tokenize = 'trigram');");
          db.exec("INSERT INTO probe_fts (content) VALUES ('调用流程');");
          const hit = db.prepare("SELECT count(*) AS n FROM probe_fts WHERE probe_fts MATCH '调用流';").get();
          result.fts5 = true;
          result.trigram = Number(hit && hit.n) === 1;
        } catch (ftsError) {
          result.error = `fts5: ${ftsError && ftsError.message ? ftsError.message : String(ftsError)}`;
        }
      } catch (error) {
        result.error = error && error.message ? error.message : String(error);
      } finally {
        try {
          if (db) db.close();
        } catch {
          // A failed close cannot change the probe answer.
        }
      }
      return result;
    })();
  }
  return sqliteProbe;
}

export async function probeRuntime() {
  return {
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    sqlite: await probeSqlite(),
  };
}

/** Read-only liveness probe plus the cached runtime capability answer. */
export function createPingHandler(options = {}) {
  const status = typeof options.status === 'function' ? options.status : () => null;
  return async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        plugin: '@local/dsh-memory',
        phase: '3.1',
        time: new Date().toISOString(),
        pid: process.pid,
        runtime: await probeRuntime(),
        injection: safeStatus(status),
      });
    } catch {
      try {
        writeJson(res, 500, { ok: false, error: 'internal' });
      } catch {
        // The socket is already gone; nothing left to report to.
      }
    }
  };
}

function safeStatus(status) {
  try {
    return status();
  } catch {
    return null;
  }
}

/**
 * A minimal read-only tool that proves the Host half is mounted inside the
 * running Harness, and that becomes the seam for the phase 3 memory tools.
 */
export function createPingTool(options = {}) {
  const status = typeof options.status === 'function' ? options.status : () => null;
  return {
    name: 'dsh_memory_ping',
    description: 'Report whether the dsh-memory Host half is loaded and reachable.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          plugin: { type: 'string' },
          phase: { type: 'string' },
          time: { type: 'string' },
          runtime: { type: 'object' },
          injection: { type: 'object' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }];
      },
    },
    async execute() {
      return {
        ok: true,
        plugin: '@local/dsh-memory',
        phase: '3.1',
        time: new Date().toISOString(),
        runtime: await probeRuntime(),
        injection: safeStatus(status),
      };
    },
  };
}

/**
 * §11 `memory_propose`: the model may propose, never approve.
 *
 * Three rules, enforced here rather than trusted to the prompt:
 *   1. The proposal is evidence-bound: it is refused unless the current turn
 *      resolves to a real session event, so a change cannot be invented.
 *   2. It writes nothing but a runtime proposal; the ledger is untouched.
 *   3. Accepting is the user's act, on the Host route, against the version the
 *      user actually saw.
 */
export function createProposeTool(options = {}) {
  const getApp = typeof options.getApp === 'function' ? options.getApp : async () => null;
  const currentTurn = typeof options.currentTurn === 'function' ? options.currentTurn : () => null;
  return {
    name: 'memory_propose',
    description: 'Propose a change to a saved memory. The user must accept it; this tool never writes the memory ledger.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'merge', 'retract'] },
        targetMemoryId: { type: 'string', description: 'Required unless action is add.' },
        content: { type: 'string', description: 'The proposed text. Required unless action is retract.' },
        type: { type: 'string', description: 'Memory type for an add proposal, e.g. fact, preference, constraint.' },
        kind: { type: 'string', description: 'Why the user wants this, when it is a correction.' },
        reason: { type: 'string', description: 'A short explanation for the user.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          proposal: { type: 'object' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }];
      },
    },
    async execute(args = {}) {
      const turn = currentTurn();
      if (turn === null || typeof turn.sessionId !== 'string' || turn.sessionId === '' || !Number.isInteger(turn.turn)) {
        return { ok: false, error: 'no-turn-context' };
      }
      let app;
      try {
        app = await getApp();
      } catch {
        return { ok: false, error: 'host-unavailable' };
      }
      if (app === null || app === undefined || app.runtime === undefined || app.runtime === null) {
        return { ok: false, error: 'host-unavailable' };
      }
      let ref = null;
      try {
        ref = app.evidence === null || app.evidence === undefined
          ? null
          : await app.evidence.resolve({ sessionId: turn.sessionId, turn: turn.turn });
      } catch {
        ref = null;
      }
      if (ref === null || ref === undefined) return { ok: false, error: 'no-evidence' };
      try {
        const proposal = await app.runtime.addProposal({
          action: args.action,
          targetMemoryId: args.targetMemoryId,
          content: args.content,
          type: args.type,
          kind: args.kind,
          reason: args.reason,
          sourceRef: ref,
        });
        if (typeof options.trace === 'function') {
          options.trace('propose', {
            id: proposal.id,
            action: proposal.action,
            target: proposal.target_memory_id,
            type: proposal.type,
            content: String(proposal.content ?? '').slice(0, 200),
            status: proposal.status,
          });
        }
        return {
          ok: true,
          proposal: {
            id: proposal.id,
            action: proposal.action,
            target_memory_id: proposal.target_memory_id,
            content: proposal.content,
            status: proposal.status,
            created_at: proposal.created_at,
          },
        };
      } catch (error) {
        return { ok: false, error: String(error && error.code ? error.code : 'failed') };
      }
    },
  };
}

/**
 * §11 `memory_search`: read-only lookup of memories the injector would also use.
 *
 * It reuses the same eligibility gate as injection and hides memories the user
 * objected to, so a memory that must not enter the prompt cannot be read back
 * through a tool either. It never writes, never logs an injection, and never
 * returns withdrawn, superseded or pending material.
 */
export function createSearchTool(options = {}) {
  const getApp = typeof options.getApp === 'function' ? options.getApp : async () => null;
  return {
    name: 'memory_search',
    description: 'Search the saved memories that may be used in this conversation. Read-only; returns ids, types, text and evidence pointers.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "What to look for, in the user's words." },
        type: { type: 'string', description: 'Optional memory type filter, e.g. fact, preference, constraint.' },
        limit: { type: 'integer', description: 'Maximum results (1-20, default 8).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          query: { type: 'string' },
          results: { type: 'array' },
          hidden: { type: 'integer' },
          reason: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value) }];
      },
    },
    async execute(args = {}) {
      let app;
      try {
        app = await getApp();
      } catch {
        return { ok: false, error: 'host-unavailable' };
      }
      if (app === null || app === undefined || app.service === undefined || app.service === null) {
        return { ok: false, error: 'host-unavailable' };
      }
      let suppressedIds = [];
      try {
        suppressedIds = app.runtime !== null && app.runtime !== undefined && typeof app.runtime.suppressedIds === 'function'
          ? await app.runtime.suppressedIds()
          : [];
      } catch {
        // A failing objection lookup must not silently widen the search: an
        // empty list here would show objected memories again.
        return { ok: false, error: 'suppressed-unavailable' };
      }
      try {
        const state = await app.service.state();
        const memories = state !== null && state !== undefined && Array.isArray(state.memories) ? state.memories : [];
        const found = searchMemories(memories, args.query, { suppressedIds, type: args.type, limit: args.limit });
        if (typeof options.trace === 'function') {
          options.trace('search', {
            query: String(args.query ?? '').slice(0, 200),
            results: Array.isArray(found.results) ? found.results.length : 0,
            hidden: found.hidden ?? 0,
            reason: found.reason ?? null,
          });
        }
        return { ok: true, query: found.query, results: found.results, hidden: found.hidden, reason: found.reason };
      } catch {
        return { ok: false, error: 'search-failed' };
      }
    },
  };
}

/** The plugin data directory. Overridable for tests and manual experiments. */

export function resolveDataDir(env = process.env) {
  const override = env && typeof env.DSH_MEMORY_DATA_DIR === 'string' ? env.DSH_MEMORY_DATA_DIR.trim() : '';
  if (override !== '') return override;
  return join(homedir(), '.dsh', 'dsh-memory');
}

/**
 * Build the route list. The memory application is created lazily on the first
 * request, so plugin activation touches no disk and cannot fail on a bad path.
 */
export function createRoutes({ dataDir = resolveDataDir(), lookup = () => undefined, getApp: shared, status } = {}) {
  const routes = [{ kind: 'exact', path: PING_PATH, handler: createPingHandler({ status }) }];
  // `/trace/switch` flips the marker file, so tracing can be turned on and off
  // without restarting the Host. It writes only that marker, never the ledger,
  // and it needs the same loopback fence plus the write token as other mutations.
  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/trace/switch`,
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      // The token lives on the memory app; without it a cross-origin page could
      // toggle diagnostics. The environment case is fixed and refuses this.
      let want;
      try {
        const body = await readJsonBody(req);
        want = body !== null && typeof body === 'object' && body.enabled === true;
      } catch {
        writeJson(res, 400, { ok: false, error: 'bad-request' });
        return;
      }
      if (envValue() !== '') {
        writeJson(res, 409, {
          ok: false,
          error: 'fixed-by-environment',
          enabled: traceEnabled(),
          hint: 'DSH_MEMORY_TRACE is set, so the marker cannot override it',
        });
        return;
      }
      try {
        const marker = join(dataDir, TRACE_MARKER);
        if (want) writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8');
        else if (existsSync(marker)) unlinkSync(marker);
        writeJson(res, 200, { ok: true, enabled: traceEnabled(undefined, { dir: dataDir }), marker });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: 'switch-failed' });
      }
    },
  });
  // `/trace` serves the append-only event stream. `?since=<seq>` returns only
  // newer records, which is what a live follower needs; without it the whole
  // file comes back, bounded by `limit`.
  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/trace`,
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      let since = 0;
      let limit = 200;
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const rawSince = url.searchParams.get('since');
        const rawLimit = url.searchParams.get('limit');
        if (rawSince !== null && rawSince !== '') {
          if (!/^[0-9]+$/u.test(rawSince)) { writeJson(res, 400, { ok: false, error: 'bad-since' }); return; }
          since = Number(rawSince);
        }
        if (rawLimit !== null && rawLimit !== '') {
          if (!/^[0-9]+$/u.test(rawLimit)) { writeJson(res, 400, { ok: false, error: 'bad-limit' }); return; }
          limit = Math.min(1000, Math.max(1, Number(rawLimit)));
        }
      } catch {
        writeJson(res, 400, { ok: false, error: 'bad-request' });
        return;
      }
      try {
        const file = join(dataDir, TRACE_FILE);
        let text = '';
        try {
          text = await readFile(file, 'utf8');
        } catch {
          writeJson(res, 200, { ok: true, enabled: traceEnabled(undefined, { dir: dataDir }), count: 0, records: [], lastSeq: 0 });
          return;
        }
        const records = [];
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          try {
            const record = JSON.parse(trimmed);
            if (record !== null && typeof record === 'object' && Number.isInteger(record.seq) && record.seq > since) {
              records.push(record);
            }
          } catch {
            // A half-written line at the tail is expected; skip it.
          }
        }
        const kept = records.slice(-limit);
        writeJson(res, 200, {
          ok: true,
          enabled: traceEnabled(undefined, { dir: dataDir }),
          count: kept.length,
          total: records.length,
          lastSeq: kept.length === 0 ? since : kept[kept.length - 1].seq,
          records: kept,
        });
      } catch (error) {
        writeJson(res, 500, { ok: false, error: 'trace-failed' });
      }
    },
  });
  let app;
  const getApp = typeof shared === 'function' ? shared : () => {
    if (app === undefined) app = createMemoryApp({ dataDir, sessionQuery: lookup('sessionQuery') });
    return app;
  };
  for (const name of APP_ROUTE_NAMES) {
    const path = `${API_PREFIX}/${name}`;
    routes.push({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          await getApp().routes[path](req, res);
        } catch {
          try {
            writeJson(res, 500, { ok: false, error: 'internal' });
          } catch {
            // The socket is already gone.
          }
        }
      },
    });
  }
  return routes;
}

function keep(ctx, dispose) {
  if (typeof dispose !== 'function') return;
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-memory: host surface');
}

/**
 * Resolve a service both ways the Host documents: `ctx.get(name)` for the
 * optional form and property access for the injected form. `undefined` means
 * "not available here", never an exception.
 */
function service(ctx, name) {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name);
      if (value !== undefined && value !== null) return value;
    }
  } catch {
    // Fall through to property access.
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

/**
 * Declared hard dependencies, the form other plugins in this profile use.
 * `webServer` carries the routes, `tools` carries the ping tool.
 */
export const inject = ['webServer', 'tools'];

/** Prompt-context name; also the name reported by the ping probe. */
export { CONTEXT_NAME };

/** A compact, secret-free view of the injection cache for the ping probe. */
function injectionSnapshot(injection, contextState) {
  if (injection === null || injection === undefined) return null;
  const snapshot = injection.snapshot;
  const latest = injection.latestObservation;
  return {
    memories: Array.isArray(snapshot.memories) ? snapshot.memories.length : 0,
    snapshot_at: snapshot.at,
    path: injection.path,
    observed: injection.observed,
    sessions: injection.agentCount,
    scope_probe: injection.probe,
    last_turn: latest === null || latest === undefined ? null : latest.turn,
    last_query_chars: latest === null || latest === undefined ? 0 : String(latest.text ?? '').length,
  };
}

export function apply(ctx) {
  /**
   * Each registration is attempted on its own.
   *
   * This is not defensive style: a single invalid definition used to kill every
   * registration after it, because one try block covered them all. The routes
   * kept working while the tool and the step observer silently disappeared, and
   * nothing reported it.
   */
  const attempt = (step) => {
    try {
      step();
    } catch (error) {
      // One broken registration must not disable the others, and it must be
      // visible: a silently missing tool looks exactly like a plugin that never
      // loaded.
      try {
        const name = step && step.name ? step.name : 'anonymous';
        console.warn(`[dsh-memory] registration failed (${name}): ${error && error.message ? error.message : String(error)}`);
      } catch {
        // Logging must not become the failure.
      }
    }
  };

  const lookup = (name) => service(ctx, name);
  let app;
  const getApp = () => {
    if (app === undefined) app = createMemoryApp({ dataDir: resolveDataDir(), sessionQuery: lookup('sessionQuery') });
    return app;
  };

  // The trace is created once and shared by every seam below. `DSH_MEMORY_TRACE=1`
  // turns it on; when it is off, `emit` is a cheap no-op.
  const trace = createTrace({ dir: resolveDataDir() });

  const injection = createInjectionRuntime({
    service: {
      state: () => getApp().service.state(),
      suppressed: () => getApp().runtime.suppressedIds(),
    },
  });
  /** What the rule engine proposes for the current turn. Nothing is written. */
  let proposed = [];
  let currentTurn = null;
  const status = () => ({
    ...injectionSnapshot(injection, contextState),
    trace: trace.stats(),
    context: contextState === undefined || contextState === null ? null : { ...contextState },
    constraints: (() => {
      const state = injection.constraints;
      return {
        loaded: state.loaded === true,
        usable: Array.isArray(state.usable) ? state.usable.length : 0,
        rejected: Array.isArray(state.rejected) ? state.rejected.slice(0, 6) : [],
        fallback: Array.isArray(state.fallback) ? state.fallback.slice(0, 6) : [],
        budget: state.config === null || state.config === undefined ? null : {
          total: state.config.budget,
          constraint: state.config.constraints.budget,
          maxChars: state.config.constraints.maxChars,
          maxItems: state.config.constraints.maxItems,
        },
      };
    })(),
    injection_log: injection.log.stats(),
    flush: { ...flushState },
    candidates: proposed.length,
    candidate_sample: proposed.slice(0, 2).map((entry) => ({ type: entry.type, rule: entry.rule, confidence: entry.confidence, text: entry.text.slice(0, 60) })),
  });
  const refresh = () => {
    injection.refresh().catch(() => {});
  };

  /**
   * Offer extracted sentences for review, never as memories.
   *
   * A candidate needs proof that the user said it, so the turn is resolved to
   * its exact event first; when that fails nothing is written and nothing is
   * invented. A sentence already present in the ledger is skipped, so review
   * does not collect the same claim every turn. This is fire-and-forget: a
   * ledger problem must not delay or fail a turn.
   */
  const proposeForReview = (payload, entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const sessionId = payload && payload.agent && typeof payload.agent.id === 'string' ? payload.agent.id : null;
    const turn = payload && Number.isInteger(payload.turn) ? payload.turn : null;
    if (sessionId === null || turn === null) return;
    const known = new Set(injection.snapshot.memories
      .filter((memory) => memory && memory.status === 'active')
      .map((memory) => String(memory.content ?? '').replace(/\s+/gu, '').toLowerCase()));
    const fresh = entries.filter((entry) => !known.has(entry.text.replace(/\s+/gu, '').toLowerCase()));
    if (fresh.length === 0) return;
    Promise.resolve()
      .then(() => getApp())
      .then((app) => Promise.resolve(app.evidence === null || app.evidence === undefined ? undefined : app.evidence.resolve({ sessionId, turn }))
        .then(async (ref) => {
          if (ref === undefined || ref === null) return;
          const settings = typeof app.settings === 'function' ? app.settings() : { enabled: true, autoAccept: false, autoAcceptTypes: [] };
          // The master switch stops extraction itself, not only the writing.
          if (settings.enabled !== true) return;
          const autoAcceptOn = settings.autoAccept === true;
          // The ledger is read even when auto-accept is off: a candidate may only
          // inherit entity names the user already confirmed there (§4.2).
          return Promise.resolve(app.service.state()).then(async (state) => {
            const memories = state !== null && state !== undefined && Array.isArray(state.memories) ? state.memories : [];
            const reviewPending = autoAcceptOn ? await app.runtime.reviewPendingIds() : [];
            return Promise.all(fresh.map((entry) => Promise.resolve(app.runtime.addCandidate({
              text: entry.text,
              type: entry.type,
              sessionId,
              turn,
              confidence: entry.confidence,
              reason: entry.rule,
              origin: 'rule',
              sourceRef: ref,
              entities: matchKnownEntities(entry.text, memories),
            })).then((candidate) => {
              trace.emit('candidate', {
                id: candidate.id ?? null,
                text: String(candidate.text ?? '').slice(0, 200),
                type: candidate.type ?? null,
                confidence: candidate.confidence ?? null,
                rule: candidate.reason ?? null,
                entities: Array.isArray(candidate.entities) ? candidate.entities.length : 0,
              });
              const decided = decideAutoMemory({ candidate, memories, settings, reviewPending });
              trace.emit('candidate:policy', {
                id: candidate.id ?? null,
                decision: decided.policy.decision,
                status: candidateStatusForPolicy(decided.policy.decision),
                reasons: decided.policy.reasons ?? [],
              });
              if (decided.policy.decision !== 'AUTO_ACCEPT') {
                // The queue says what the policy decided, not just "pending".
                return Promise.resolve(app.runtime.setCandidateStatus(candidate.id, candidateStatusForPolicy(decided.policy.decision))).catch(() => undefined);
              }
              // A failed auto-write leaves the candidate pending for review.
              return writeAutoAccepted({ service: app.service, runtime: app.runtime, candidate }).catch(() => undefined);
            }).catch(() => undefined)));
          });
        }))
      .catch(() => {});
  };

  /**
   * Turn a natural-language complaint into an objection (§6.1–6.4).
   *
   * Only an unambiguous target is objected to; otherwise nothing happens and
   * the user decides in the panel. The objection suppresses the memory from
   * retrieval at once (D7) and is not a ledger write, so a wrong guess could
   * not corrupt history — but it would still hide a good memory, which is why
   * ambiguity means no action. Gated by the same master switch as extraction.
   */
  const handleCorrection = (payload, text) => {
    // Most turns are not corrections; do not open the ledger to find that out.
    if (!isCorrectionCandidate(text)) return;
    Promise.resolve()
      .then(() => getApp())
      .then((app) => {
        const settings = typeof app.settings === 'function' ? app.settings() : { enabled: true };
        if (settings.enabled !== true) return undefined;
        return Promise.all([app.service.state(), app.runtime.suppressedIds()]).then(([state, suppressedIds]) => {
          const memories = state !== null && state !== undefined && Array.isArray(state.memories) ? state.memories : [];
          return applyCorrection({
            text,
            memories,
            suppressedIds,
            runtime: app.runtime,
          }).then((decision) => {
            contextState.lastCorrection = {
              act: decision.act === true,
              recorded: decision.recorded === true,
              reason: decision.reason,
              // Null when nothing was objected to; otherwise why no narrower
              // wording exists, so the panel is not the only place that knows.
              narrowing: decision.narrowing === undefined || decision.narrowing === null ? null : decision.narrowing.reason,
            };
            if (decision.recorded === true) {
              // A memory that was just called wrong must not come back in the
              // next prompt, so the snapshot is rebuilt rather than waited for.
              injection.refresh().catch(() => {});
            }
          });
        });
      })
      .catch(() => {});
  };

  const flushState = { ok: null, error: null, written: 0 };
  /**
   * Persist queued injection records at a step boundary.
   *
   * The provider never touches the disk: records are queued while assembling
   * and written here, where waiting is already acceptable and a second writer
   * cannot be running. A failure keeps the queue so the next boundary retries.
   */
  const flushInjections = () => {
    const pending = injection.pendingRecords();
    if (pending.length === 0) return;
    let app;
    try {
      app = getApp();
    } catch (error) {
      flushState.ok = false;
      flushState.error = String(error && error.message ? error.message : error).slice(0, 120);
      return;
    }
    // Sequential on purpose: the store serialises whole-file read-modify-write,
    // and doing them one at a time keeps the on-disk order equal to the order in
    // which the records were produced.
    const writeAll = async () => {
      for (const record of pending) {
        await app.runtime.recordInjection({
          sessionId: record.session_id,
          turn: record.turn,
          snapshotHead: record.snapshot_head,
          memoryIds: record.memory_ids,
          reasons: Array.isArray(record.reasons) ? record.reasons : [],
          chars: record.chars,
          key: record.key,
          state: record.state,
          confirmed: record.confirmed,
          evidence: record.evidence,
          occurrences: record.occurrences,
          pools: record.pools,
          memories: record.memories,
          excluded: record.excluded,
        });
      }
    };
    writeAll()
      .then(() => {
        injection.markFlushed(pending.length);
        flushState.ok = true;
        flushState.error = null;
        flushState.written += pending.length;
      })
      .catch((error) => {
        flushState.ok = false;
        flushState.error = String(error && error.message ? error.message : error).slice(0, 120);
      });
  };

  /** Re-resolve the standing constraints against the current ledger snapshot. */
  const refreshConstraints = () => {
    try {
      const loaded = loadConfig(resolveDataDir());
      const resolved = resolveConstraints({ config: loaded.config, memories: injection.snapshot.memories, now: new Date() });
      injection.setConstraints({ ...loaded, ...resolved });
    } catch (error) {
      injection.setConstraints({ loaded: false, fallback: ['resolve-failed'], usable: [], rejected: [], config: null });
    }
  };

  const systemPrompt = service(ctx, 'systemPrompt');
  let contextOff = null;
  /**
   * Registration and calls are recorded, never inferred.
   *
   * The prompt seam is the one place this plugin can be wrong invisibly: a
   * context that never registered looks exactly like a workspace with nothing
   * worth remembering. Status therefore reports which step happened.
   */
  const contextState = { registered: false, calls: 0, chars: 0, error: null, skipped: null };
  /**
   * Register the prompt context only once the ledger holds an active memory.
   * Prompt assembly is on the critical path of every step, so an empty store
   * keeps this plugin out of it entirely.
   */
  const ensureContext = () => {
    if (!systemPrompt || typeof systemPrompt.context !== 'function') {
      contextState.skipped = systemPrompt ? 'missing-context-api' : 'no-system-prompt-service';
      return;
    }
    if (contextOff !== null) return;
    const eligible = injection.snapshot.memories.some((memory) => memory && memory.status === 'active');
    if (!eligible) {
      contextState.skipped = 'no-active-memory';
      return;
    }
    const provider = (context) => {
      try {
        const built = injection.buildText(context && context.scope);
        const text = built.text;
        contextState.calls += 1;
        contextState.chars += text.length;
        trace.emit('inject', {
          path: built.path ?? null,
          chars: text.length,
          chosen: Array.isArray(built.chosen) ? built.chosen.map((entry) => ({
            id: entry.memory && entry.memory.id ? entry.memory.id : null,
            kind: entry.kind ?? 'memory',
            chars: entry.chars_used ?? (typeof entry.text === 'string' ? entry.text.length : 0),
            reason: String(entry.reason ?? ''),
          })) : [],
          excluded: Array.isArray(built.excluded) ? built.excluded.slice(0, 20) : [],
          pools: built.pools ?? null,
          text,
        });
        return text;
      } catch (error) {
        contextState.error = `provider: ${String(error && error.message ? error.message : error).slice(0, 120)}`;
        trace.emit('inject:failed', { error: contextState.error });
        return '';
      }
    };
    try {
      contextOff = systemPrompt.context({ name: CONTEXT_NAME, order: 100, text: provider });
      if (typeof contextOff !== 'function') contextOff = () => {};
      keep(ctx, contextOff);
      contextState.registered = true;
      contextState.skipped = null;
    } catch (error) {
      contextOff = null;
      contextState.error = `register: ${String(error && error.message ? error.message : error).slice(0, 120)}`;
      console.warn('[dsh-memory] prompt context registration failed:', contextState.error);
    }
  };

  attempt(() => {
    const webServer = service(ctx, 'webServer');
    if (!webServer || typeof webServer.register !== 'function') return;
    for (const route of createRoutes({ lookup, getApp, status })) {
      const handler = route.handler;
      keep(ctx, webServer.register({
        ...route,
        handler: async (req, res) => {
          // Every panel action goes through here, so this is the one seam that
          // sees what the user clicked and whether the Host accepted it.
          const started = Date.now();
          try {
            await handler(req, res);
          } finally {
            trace.emit('http', {
              route: route.path,
              method: req.method,
              ms: Date.now() - started,
              status: typeof res.statusCode === 'number' ? res.statusCode : null,
            });
            if (req.method !== 'GET') refresh();
          }
        },
      }));
    }
  });

  attempt(() => {
    const tools = service(ctx, 'tools');
    if (tools && typeof tools.register === 'function') {
      keep(ctx, tools.register(createPingTool({ status })));
      keep(ctx, tools.register(createProposeTool({ getApp, currentTurn: () => currentTurn, trace: trace.emit })));
      keep(ctx, tools.register(createSearchTool({ getApp, trace: trace.emit })));
    }
  });

  // Observe the text entering each step and keep the snapshot fresh. The
  // refresh happens here, never in the prompt provider, because this is the
  // only place where waiting for the ledger is acceptable.
  attempt(() => {
    if (typeof ctx.on !== 'function') return;
    const onPreStep = function onPreStep(payload, next) {
      // The propose tool binds its evidence to this turn, so it must know it.
      currentTurn = payload !== null && payload !== undefined
        && payload.agent !== null && payload.agent !== undefined && typeof payload.agent.id === 'string'
        && Number.isInteger(payload.turn)
        ? { sessionId: payload.agent.id, turn: payload.turn }
        : null;
      trace.emit('pre-step:enter', {
        sessionId: currentTurn === null ? null : currentTurn.sessionId,
        turn: currentTurn === null ? null : currentTurn.turn,
        step: payload !== null && payload !== undefined && Number.isInteger(payload.step) ? payload.step : null,
        messages: Array.isArray(payload && payload.messages) ? payload.messages.length : 0,
      });
      const observed = injection.observe(this === undefined ? ctx : this, payload);
      try {
        proposed = observed === null ? [] : extractCandidates(observed.text);
      } catch {
        proposed = [];
      }
      trace.emit('observe', {
        sessionId: currentTurn === null ? null : currentTurn.sessionId,
        turn: currentTurn === null ? null : currentTurn.turn,
        queryChars: observed === null ? 0 : String(observed.text ?? '').length,
        query: observed === null ? '' : String(observed.text ?? '').slice(0, 500),
        observePath: injection.observed,
        lookupPath: injection.path,
        candidates: proposed.length,
        candidateRules: proposed.map((entry) => entry.rule),
      });
      proposeForReview(payload, proposed);
      handleCorrection(payload, observed === null ? '' : observed.text);
      // A failed refresh must not skip registration: the two are separate
      // steps, and the previous shape hid exactly that failure.
      return Promise.resolve(injection.ensureFresh())
        .catch((error) => {
          contextState.error = `refresh: ${String(error && error.message ? error.message : error).slice(0, 120)}`;
          trace.emit('refresh:failed', { error: contextState.error });
        })
        .then(() => {
          const snapshot = injection.snapshot;
          trace.emit('snapshot', {
            memories: Array.isArray(snapshot.memories) ? snapshot.memories.length : 0,
            suppressed: snapshot.suppressed ?? 0,
            head: snapshot.head ?? null,
            degraded: snapshot.degraded ?? null,
          });
          refreshConstraints();
          const constraints = injection.constraints;
          trace.emit('constraints', {
            loaded: constraints.loaded === true,
            usable: Array.isArray(constraints.usable) ? constraints.usable.length : 0,
            fallback: Array.isArray(constraints.fallback) ? constraints.fallback : [],
          });
          flushInjections();
          ensureContext();
          trace.emit('pre-step:exit', {
            providerRegistered: contextState.registered === true,
            skipped: contextState.skipped,
            calls: contextState.calls,
          });
        })
        .then(() => next());
    };
    const off = ctx.on('agent/pre-step', onPreStep);
    if (typeof off === 'function') keep(ctx, off);
    else if (off && typeof off.dispose === 'function') keep(ctx, () => off.dispose());
  });
}
