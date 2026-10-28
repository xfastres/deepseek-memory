/**
 * Host half of the memory bundle.
 *
 * Phase 2.1 is a deliberate minimal experiment: one read-only route that proves
 * the page can reach this Host half over the DSH web server. It deliberately
 * owns no memory data yet — the Git ledger arrives in phase 2.4, after this
 * channel and its failure modes are verified.
 *
 * Two hard rules shape this file:
 *
 * 1. Nothing here may block Web boot. Every step is guarded, and a failure
 *    leaves the plugin loaded but route-less instead of failing activation.
 * 2. The route is reachable only from a loopback socket with a loopback Host
 *    header and no cross-site browser provenance. That is the same fence the
 *    installed task-board plugin uses for its own local API.
 */

export const ROUTE_PREFIX = '/api/dsh-memory';
export const PING_PATH = `${ROUTE_PREFIX}/ping`;

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

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackAddress(value) {
  return typeof value === 'string' && LOOPBACK_ADDRESSES.has(value);
}

export function isLoopbackHostname(value) {
  return typeof value === 'string' && LOOPBACK_HOSTNAMES.has(value.toLowerCase());
}

/**
 * Authoritative request fence: the socket address plus the Host header decide,
 * and X-Forwarded-For is never consulted. A cross-site browser request is
 * always refused; when the browser sends an Origin, it must equal the Host.
 */
export function isTrustedRequest(req) {
  if (!req || typeof req !== 'object') return false;
  const socket = req.socket;
  if (!socket || !isLoopbackAddress(socket.remoteAddress)) return false;
  const hostHeader = req.headers ? req.headers.host : undefined;
  if (typeof hostHeader !== 'string') return false;
  let authority;
  try {
    authority = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(authority.hostname)) return false;
  const headers = req.headers || {};
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (typeof origin !== 'string') return true;
  try {
    return new URL(origin).host === authority.host;
  } catch {
    return false;
  }
}

export function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
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
        phase: '2.2',
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

export function createRoutes() {
  return [{ kind: 'exact', path: PING_PATH, handler: createPingHandler() }];
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
        phase: '2.2',
        time: new Date().toISOString(),
        runtime: await probeRuntime(),
      };
    },
  };
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
    for (const route of createRoutes()) keep(ctx, webServer.register(route));
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
