// HTTP application for the memory Host half.
//
// Handlers are plain functions over (req, res) so they can be exercised
// headlessly. `index.js` binds them to `webServer` routes; the fence and the
// JSON body limits live here so every route shares one policy.
//
// Ordering matters for safety: the Host routes exist before the browser uses
// them. The page keeps its local store until switching over is verified, so a
// wrong route here costs a 404, not lost memories.

import { join } from 'node:path';

import { createLedgerService, toApiError } from './ledger-service.js';
import { createEvidenceResolver } from './session-evidence.js';

export const API_PREFIX = '/api/dsh-memory';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string') return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Read fence: loopback socket, loopback Host, and no cross-site provenance. */
export function isTrustedRead(req) {
  if (!req || typeof req !== 'object') return false;
  const remote = req.socket && req.socket.remoteAddress;
  if (!LOOPBACK_ADDRESSES.has(remote)) return false;
  const headers = req.headers || {};
  if (!isLoopbackHost(headers.host)) return false;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  if (typeof headers.origin !== 'string') return true;
  try {
    return new URL(headers.origin).host === new URL(`http://${headers.host}`).host;
  } catch {
    return false;
  }
}

/**
 * Write fence: a read-fence pass PLUS a browser same-origin marker. A bare
 * local curl is refused, because it can mutate memories.
 */
export function isTrustedWrite(req) {
  if (!isTrustedRead(req)) return false;
  const headers = req.headers || {};
  if (headers['sec-fetch-site'] === 'same-origin') return true;
  return typeof headers.origin === 'string';
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413, error: 'too-large' });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400, error: 'invalid-json' });
  }
}

function requiresJson(req) {
  const contentType = (req.headers && req.headers['content-type']) || '';
  return contentType.toLowerCase().startsWith('application/json');
}

/**
 * Build the memory application.
 *
 * @param {object} options
 * @param {string} options.dataDir absolute plugin data directory
 * @param {object} [options.sessionQuery] Host session query service, for evidence
 * @param {() => Date} [options.now]
 */
export function createMemoryApp(options = {}) {
  const { dataDir, sessionQuery, now } = options;
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('dataDir is required');
  const service = createLedgerService({ root: join(dataDir, 'ledger'), now });
  const evidence = sessionQuery && typeof sessionQuery.listEvents === 'function'
    ? createEvidenceResolver({ sessionQuery })
    : null;

  function fail(res, error) {
    const mapped = toApiError(error);
    const status = error && typeof error.status === 'number' ? error.status : mapped.status;
    const code = error && typeof error.error === 'string' ? error.error : mapped.error;
    writeJson(res, status, { ok: false, error: code });
  }

  const routes = {
    [`${API_PREFIX}/state`]: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      try {
        const state = await service.state();
        writeJson(res, 200, { ok: true, ...state });
      } catch (error) {
        fail(res, error);
      }
    },

    [`${API_PREFIX}/export`]: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      try {
        const state = await service.state();
        writeJson(res, 200, {
          ok: true,
          format: 'dsh-memory/v2',
          exported_at: new Date().toISOString(),
          ledger: { head: state.head },
          memories: state.memories,
        });
      } catch (error) {
        fail(res, error);
      }
    },

    [`${API_PREFIX}/add`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (content === '') { writeJson(res, 400, { ok: false, error: 'empty' }); return; }
        let ref = body.sourceRef;
        if (ref === undefined && evidence !== null && body.sessionId !== undefined && body.turn !== undefined) {
          ref = await evidence.resolve({ sessionId: body.sessionId, turn: body.turn });
          if (ref === undefined) { writeJson(res, 422, { ok: false, error: 'no-evidence' }); return; }
        }
        if (ref === undefined) { writeJson(res, 422, { ok: false, error: 'no-evidence' }); return; }
        const result = await service.add({
          content,
          type: typeof body.type === 'string' ? body.type : 'fact',
          sourceRefs: [ref],
          idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
        });
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        fail(res, error);
      }
    },

    [`${API_PREFIX}/update`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (typeof body.memoryId !== 'string' || body.memoryId === '') { writeJson(res, 400, { ok: false, error: 'missing-id' }); return; }
        if (content === '') { writeJson(res, 400, { ok: false, error: 'empty' }); return; }
        const result = await service.update({
          memoryId: body.memoryId,
          content,
          expectedBaseChangeId: typeof body.expectedBaseChangeId === 'string' ? body.expectedBaseChangeId : null,
        });
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        fail(res, error);
      }
    },

    [`${API_PREFIX}/retract`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        if (typeof body.memoryId !== 'string' || body.memoryId === '') { writeJson(res, 400, { ok: false, error: 'missing-id' }); return; }
        const result = await service.retract({
          memoryId: body.memoryId,
          expectedBaseChangeId: typeof body.expectedBaseChangeId === 'string' ? body.expectedBaseChangeId : null,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        fail(res, error);
      }
    },
  };

  return { routes, service, evidence };
}

/** Turn the handler table into the exact WebRoute list the web server wants. */
export function createAppRoutes(app) {
  return Object.entries(app.routes).map(([path, handler]) => ({ kind: 'exact', path, handler }));
}
