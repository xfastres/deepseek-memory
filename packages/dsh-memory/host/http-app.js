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

import { classifyCandidates } from './classification.js';
import { evaluateCandidatePolicies } from './policy.js';
import { toLedgerType } from './memory-types.js';
import { CORRECTION_KINDS } from './corrections.js';
import { AUTO_ACCEPT_TYPE_CHOICES, loadSettings, writeSettings } from './settings.js';
import { isOpenCandidateStatus } from './runtime-store.js';

import { createLedgerService, toApiError } from './ledger-service.js';
import { applyMigration, planMemoryMigration } from './migration.js';
import { createRuntimeStore } from './runtime-store.js';
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
 * Write fence: the same check as reads, deliberately.
 *
 * This mirrors the shipped task board's `isLoopbackRequest`, which guards its
 * ledger with exactly these checks and no extra browser marker. An extra
 * marker requirement would refuse writes from a shell that does not send
 * `Origin`, while reads kept working — a half-broken panel that is worse than
 * either choice. What still stops a hostile page is the cross-site check here,
 * the JSON content type (which forces a CORS preflight cross-origin), and the
 * web server's authentication layer in front of every route.
 */
export const isTrustedWrite = isTrustedRead;

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
  const runtime = createRuntimeStore({ root: join(dataDir, 'runtime'), now });
  const evidence = sessionQuery && typeof sessionQuery.listEvents === 'function'
    ? createEvidenceResolver({ sessionQuery })
    : null;

  function fail(res, error) {
    const mapped = toApiError(error);
    const status = error && typeof error.status === 'number' ? error.status : mapped.status;
    const code = error && typeof error.error === 'string' ? error.error : mapped.error;
    writeJson(res, status, { ok: false, error: code });
  }

  function runtimeFail(res, error) {
    if (error && typeof error.code === 'string') {
      const status = error.code === 'missing' ? 404
        : error.code === 'duplicate' ? 409
          : error.code === 'no-evidence' || error.code === 'empty' || error.code === 'invalid-kind' ? 422
            : error.code === 'busy' ? 503
              : 500;
      writeJson(res, status, { ok: false, error: error.code });
      return;
    }
    fail(res, error);
  }

  /**
   * Resolve evidence without letting a service failure become a 500.
   *
   * A session that does not exist makes `sessionQuery` throw, and that is a
   * refusal ("this claim cannot be proved"), not an internal fault. The reason
   * is reported so the caller knows why nothing was written.
   */
  async function resolveSafe(sessionId, turn) {
    if (evidence === null) return { error: 'no-evidence-resolver' };
    try {
      const ref = await evidence.resolve({ sessionId, turn });
      return ref === undefined || ref === null ? { error: 'no-evidence' } : { ref };
    } catch {
      return { error: 'session-unreadable' };
    }
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

    [`${API_PREFIX}/history`]: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      let memoryId = '';
      try {
        memoryId = new URL(req.url, 'http://127.0.0.1').searchParams.get('memoryId') || '';
      } catch {
        writeJson(res, 400, { ok: false, error: 'bad-request' });
        return;
      }
      if (memoryId === '') { writeJson(res, 400, { ok: false, error: 'missing-id' }); return; }
      try {
        const versions = await service.history(memoryId);
        if (versions.length === 0) { writeJson(res, 404, { ok: false, error: 'missing' }); return; }
        writeJson(res, 200, { ok: true, memoryId, versions });
      } catch (error) {
        fail(res, error);
      }
    },

    [`${API_PREFIX}/changes`]: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      let limit = 20;
      try {
        const raw = typeof req.url === 'string' ? new URL(req.url, 'http://127.0.0.1').searchParams.get('limit') : null;
        if (raw !== null && raw !== '') {
          if (!/^[0-9]+$/u.test(raw)) { writeJson(res, 400, { ok: false, error: 'bad-limit' }); return; }
          limit = Math.min(100, Math.max(1, Number(raw)));
        }
      } catch {
        writeJson(res, 400, { ok: false, error: 'bad-request' });
        return;
      }
      try {
        const result = await service.recentChanges(limit);
        writeJson(res, 200, { ok: true, head: result.head, count: result.changes.length, changes: result.changes });
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

    [`${API_PREFIX}/injections`]: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      let limit = 50;
      try {
        const raw = typeof req.url === 'string' ? new URL(req.url, 'http://127.0.0.1').searchParams.get('limit') : null;
        if (raw !== null && raw !== '') {
          if (!/^[0-9]+$/u.test(raw)) { writeJson(res, 400, { ok: false, error: 'bad-limit' }); return; }
          limit = Math.min(200, Math.max(1, Number(raw)));
        }
      } catch {
        writeJson(res, 400, { ok: false, error: 'bad-request' });
        return;
      }
      try {
        const injections = await runtime.listInjections({ limit });
        writeJson(res, 200, { ok: true, count: injections.length, injections });
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
        if (ref === undefined && body.sessionId !== undefined && body.turn !== undefined) {
          const resolved = await resolveSafe(body.sessionId, body.turn);
          if (resolved.error !== undefined) {
            writeJson(res, 422, { ok: false, error: 'no-evidence', reason: resolved.error });
            return;
          }
          ref = resolved.ref;
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
    [`${API_PREFIX}/candidates`]: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      try {
        const state = await service.state();
        const memories = Array.isArray(state.memories) ? state.memories : [];
        const loadedSettings = loadSettings(dataDir);
        writeJson(res, 200, {
          ok: true,
          candidates: evaluateCandidatePolicies(
            classifyCandidates(await runtime.listCandidates(), memories),
            {
              autoAccept: loadedSettings.settings.enabled === true && loadedSettings.settings.autoAccept === true,
              autoAcceptTypes: loadedSettings.settings.autoAcceptTypes,
            },
          ).map((row) => ({ ...row, open: isOpenCandidateStatus(row.status) })),
          summary: await runtime.summary(),
        });
      } catch (error) {
        runtimeFail(res, error);
      }
    },

    [`${API_PREFIX}/candidate`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        let ref = body.sourceRef;
        if (ref === undefined && typeof body.sessionId === 'string' && Number.isInteger(body.turn)) {
          const resolved = await resolveSafe(body.sessionId, body.turn);
          if (resolved.error !== undefined) {
            writeJson(res, 422, { ok: false, error: 'no-evidence', reason: resolved.error });
            return;
          }
          ref = resolved.ref;
        }
        if (ref === undefined || ref === null) { writeJson(res, 422, { ok: false, error: 'no-evidence' }); return; }
        const candidate = await runtime.addCandidate({
          text: body.text,
          type: body.type,
          sessionId: body.sessionId,
          turn: body.turn,
          confidence: body.confidence,
          reason: body.reason,
          origin: body.origin,
          sourceRef: ref,
        });
        writeJson(res, 200, { ok: true, candidate });
      } catch (error) {
        runtimeFail(res, error);
      }
    },

    [`${API_PREFIX}/review`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        if (typeof body.candidateId !== 'string' || body.candidateId === '') {
          writeJson(res, 400, { ok: false, error: 'missing-id' }); return;
        }
        const candidates = await runtime.listCandidates();
        const candidate = candidates.find((entry) => entry.id === body.candidateId);
        if (!candidate) { writeJson(res, 404, { ok: false, error: 'missing' }); return; }

        if (body.action === 'reject') {
          const reviewed = await runtime.setCandidateStatus(candidate.id, 'rejected');
          writeJson(res, 200, { ok: true, candidate: reviewed });
          return;
        }
        if (body.action === 'accept') {
          const content = typeof body.content === 'string' && body.content.trim() !== '' ? body.content.trim() : candidate.text;
          // Older candidates may still carry a rule kind the ledger does not
          // know; refusing here beats returning an opaque schema error.
          const type = toLedgerType(candidate.type);
          if (type === null) {
            writeJson(res, 422, { ok: false, error: 'invalid-type', candidateType: candidate.type ?? null });
            return;
          }
          const result = await service.add({
            content,
            type,
            sourceRefs: candidate.source_refs,
            idempotencyKey: `candidate:${candidate.id}`,
          });
          const reviewed = await runtime.setCandidateStatus(candidate.id, 'accepted_by_user', { memoryId: result.memory ? result.memory.id : undefined });
          writeJson(res, 200, { ok: true, status: result.status, memory: result.memory, candidate: reviewed });
          return;
        }
        if (body.action === 'merge') {
          const content = typeof body.content === 'string' ? body.content.trim() : '';
          if (typeof body.targetId !== 'string' || body.targetId === '') { writeJson(res, 400, { ok: false, error: 'missing-target' }); return; }
          if (content === '') { writeJson(res, 400, { ok: false, error: 'empty' }); return; }
          const result = await service.update({
            memoryId: body.targetId,
            content,
            expectedBaseChangeId: typeof body.expectedBaseChangeId === 'string' ? body.expectedBaseChangeId : null,
          });
          const reviewed = await runtime.setCandidateStatus(candidate.id, 'accepted_by_user', { memoryId: body.targetId, content });
          writeJson(res, 200, { ok: true, memory: result.memory, candidate: reviewed });
          return;
        }
        writeJson(res, 400, { ok: false, error: 'unknown-action' });
      } catch (error) {
        runtimeFail(res, error);
      }
    },

    /**
     * Objections: a claim the user called wrong.
     *
     * GET lists them, POST records one. The record is runtime-only; suppression
     * takes effect on the next injection refresh, and the ledger is untouched.
     */
    [`${API_PREFIX}/objections`]: async (req, res) => {
      if (req.method === 'GET') {
        if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
        try {
          const objections = await runtime.listObjections();
          writeJson(res, 200, { ok: true, objections, suppressed: await runtime.suppressedIds(), kinds: CORRECTION_KINDS });
        } catch (error) {
          runtimeFail(res, error);
        }
        return;
      }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        const memoryId = typeof body.memoryId === 'string' ? body.memoryId.trim() : '';
        if (memoryId === '') { writeJson(res, 400, { ok: false, error: 'missing-id' }); return; }
        const state = await service.state();
        const known = Array.isArray(state.memories) && state.memories.some((memory) => memory !== null && typeof memory === 'object' && memory.id === memoryId);
        if (!known) { writeJson(res, 404, { ok: false, error: 'missing' }); return; }
        const objection = await runtime.addObjection({ memoryId, kind: body.kind, reason: body.reason });
        writeJson(res, 200, { ok: true, objection, suppressed: await runtime.suppressedIds() });
      } catch (error) {
        runtimeFail(res, error);
      }
    },

    [`${API_PREFIX}/objections/clear`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        const cleared = await runtime.reinstate(body.memoryId);
        writeJson(res, 200, { ok: true, cleared, suppressed: await runtime.suppressedIds() });
      } catch (error) {
        runtimeFail(res, error);
      }
    },

    /**
     * Automatic-memory settings (§10.1.6).
     *
     * GET reports what is in force; POST changes only the three switches it
     * owns. A setting is never a memory and never enters the ledger.
     */
    [`${API_PREFIX}/settings`]: async (req, res) => {
      if (req.method === 'GET') {
        if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
        const loaded = loadSettings(dataDir);
        writeJson(res, 200, { ok: true, ...loaded, choices: { autoAcceptTypes: AUTO_ACCEPT_TYPE_CHOICES } });
        return;
      }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        const current = loadSettings(dataDir).settings;
        const next = {
          enabled: body.enabled === undefined ? current.enabled : body.enabled,
          autoAccept: body.autoAccept === undefined ? current.autoAccept : body.autoAccept,
          autoAcceptTypes: body.autoAcceptTypes === undefined ? current.autoAcceptTypes : body.autoAcceptTypes,
        };
        if (typeof next.enabled !== 'boolean') { writeJson(res, 400, { ok: false, error: 'invalid-settings', field: 'enabled' }); return; }
        if (typeof next.autoAccept !== 'boolean') { writeJson(res, 400, { ok: false, error: 'invalid-settings', field: 'autoAccept' }); return; }
        if (!Array.isArray(next.autoAcceptTypes)) { writeJson(res, 400, { ok: false, error: 'invalid-settings', field: 'autoAcceptTypes' }); return; }
        const written = writeSettings(dataDir, next);
        writeJson(res, 200, { ok: true, ...written, choices: { autoAcceptTypes: AUTO_ACCEPT_TYPE_CHOICES } });
      } catch (error) {
        fail(res, error);
      }
    },

    [`${API_PREFIX}/migrate`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!isTrustedWrite(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        const legacyMemories = Array.isArray(body.memories) ? body.memories : [];
        const legacyCandidates = Array.isArray(body.candidates) ? body.candidates : [];
        const state = await service.state();
        const plan = await planMemoryMigration({
          legacyMemories,
          legacyCandidates,
          existingMemories: state.memories,
          resolve: evidence === null
            ? async () => undefined
            : ({ sessionId, turn }) => evidence.resolve({ sessionId, turn }),
        });
        const summary = await applyMigration(service, plan);
        const candidates = await importCandidates(legacyCandidates);
        writeJson(res, 200, { ok: true, ...summary, deferred: { ...summary.deferred, ...candidates } });
      } catch (error) {
        fail(res, error);
      }
    },
  };

  /** Move legacy candidates into the runtime queue; unprovable ones are named. */
  async function importCandidates(legacyCandidates) {
    const imported = [];
    const skipped = [];
    for (const candidate of legacyCandidates) {
      const text = typeof candidate.text === 'string' ? candidate.text : '';
      const source = candidate.source && typeof candidate.source === 'object' ? candidate.source : {};
      if (text.trim() === '') { skipped.push({ id: candidate.id ?? null, reason: 'empty' }); continue; }
      let ref;
      try {
        ref = evidence !== null && typeof source.session_id === 'string' && Number.isInteger(source.turn)
          ? await evidence.resolve({ sessionId: source.session_id, turn: source.turn })
          : undefined;
      } catch {
        ref = undefined;
      }
      if (ref === undefined || ref === null) {
        skipped.push({ id: candidate.id ?? null, reason: 'no-evidence' });
        continue;
      }
      try {
        const added = await runtime.addCandidate({
          text,
          type: candidate.type,
          sessionId: source.session_id,
          turn: source.turn,
          confidence: candidate.confidence,
          origin: 'legacy',
          sourceRef: ref,
        });
        imported.push({ legacyId: candidate.id ?? null, candidateId: added.id });
      } catch (error) {
        skipped.push({ id: candidate.id ?? null, reason: (error && error.code) || 'failed' });
      }
    }
    return { candidates: { imported: imported.length, skipped } };
  }

  return { routes, service, runtime, evidence, settings: () => loadSettings(dataDir).settings };
}

/** Turn the handler table into the exact WebRoute list the web server wants. */
export function createAppRoutes(app) {
  return Object.entries(app.routes).map(([path, handler]) => ({ kind: 'exact', path, handler }));
}
