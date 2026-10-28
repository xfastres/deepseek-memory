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

import {
  API_PREFIX,
  createAppRoutes,
  createMemoryApp,
  isTrustedRead,
  isTrustedWrite,
  writeJson,
} from './host/http-app.js';

export { API_PREFIX, isTrustedWrite, writeJson };

export const ROUTE_PREFIX = API_PREFIX;
export const PING_PATH = `${API_PREFIX}/ping`;

/** Routes served by the memory application, in addition to the ping probe. */
export const APP_ROUTE_NAMES = Object.freeze(['state', 'export', 'add', 'update', 'retract', 'migrate']);

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
export function createPingHandler() {
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
        phase: '2.4',
        time: new Date().toISOString(),
        pid: process.pid,
        runtime: await probeRuntime(),
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

/**
 * A minimal read-only tool that proves the Host half is mounted inside the
 * running Harness, and that becomes the seam for the phase 3 memory tools.
 */
export function createPingTool() {
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
        phase: '2.4',
        time: new Date().toISOString(),
        runtime: await probeRuntime(),
      };
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
export function createRoutes({ dataDir = resolveDataDir(), lookup = () => undefined } = {}) {
  const routes = [{ kind: 'exact', path: PING_PATH, handler: createPingHandler() }];
  let app;
  const getApp = () => {
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

function registerRoutes(ctx) {
  try {
    if (!ctx) return;
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (!webServer || typeof webServer.register !== 'function') return;
    const lookup = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);
    for (const route of createRoutes({ lookup })) keep(ctx, webServer.register(route));
  } catch {
    // A Host-half failure must never take the Harness down with it.
  }
}

function registerTool(ctx) {
  try {
    if (!ctx) return;
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
    if (!tools || typeof tools.register !== 'function') return;
    keep(ctx, tools.register(createPingTool()));
  } catch {
    // Same rule as above: stay loaded, stay silent.
  }
}

export function apply(ctx) {
  try {
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => registerRoutes(scoped));
      ctx.inject(['tools'], (scoped) => registerTool(scoped));
      return;
    }
    registerRoutes(ctx);
    registerTool(ctx);
  } catch {
    // Same rule as above: stay loaded, stay silent.
  }
}
