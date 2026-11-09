// HTTP application for the memory Host half.
//
// Handlers are plain functions over (req, res) so they can be exercised
// headlessly. `index.js` binds them to `webServer` routes; the fence and the
// JSON body limits live here so every route shares one policy.
//
// Ordering matters for safety: the Host routes exist before the browser uses
// them. The page keeps its local store until switching over is verified, so a
// wrong route here costs a 404, not lost memories.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { classifyCandidates } from './classification.js';
import { evaluateCandidatePolicies } from './policy.js';
import { toLedgerType } from './memory-types.js';
import { CORRECTION_KINDS } from './corrections.js';
import { narrowingRequest } from './narrowing.js';
import { describeErasure, describeErasureResult } from './erasure.js';
import { AUTO_ACCEPT_TYPE_CHOICES, loadSettings, updateSettings } from './settings.js';
import { isOpenCandidateStatus, PROPOSAL_ACTIONS } from './runtime-store.js';

import { createLedgerService, toApiError } from './ledger-service.js';
import { applyMigration, planMemoryMigration } from './migration.js';
import { createRuntimeStore } from './runtime-store.js';
import { createEvidenceResolver } from './session-evidence.js';
import { isId as isRecordId } from '../../provider-git-ledger/src/schema.js';

export const API_PREFIX = '/api/dsh-memory';
export const WRITE_TOKEN_HEADER = 'x-dsh-memory-token';
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

export async function readJsonBody(req) {
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
 * @param {boolean} [options.allowUnverified] test-only: permit ledger writes when
 *   sessionQuery is missing. Production always leaves this false.
 * @param {string} [options.writeToken] test-only override for the write token
 */
export function createMemoryApp(options = {}) {
  const { dataDir, sessionQuery, now, allowUnverified = false, writeToken: writeTokenOption } = options;
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('dataDir is required');
  const writeToken = typeof writeTokenOption === 'string' && writeTokenOption !== ''
    ? writeTokenOption
    : randomBytes(32).toString('hex');
  const runtime = createRuntimeStore({ root: join(dataDir, 'runtime'), now });
  const evidence = sessionQuery && typeof sessionQuery.listEvents === 'function'
    ? createEvidenceResolver({ sessionQuery })
    : null;
  // Formal writes need a live evidence verifier. Missing sessionQuery used to
  // silently skip verification (fail-open). That is now refused unless a test
  // explicitly opts into allowUnverified.
  const evidenceRequired = allowUnverified !== true;
  // Every ledger write re-checks its refs against the Session log (roadmap 5.1):
  // the resolver proves a turn at write time, and the verifier refuses a ref
  // whose event is gone, changed type, or no longer hashes to the recorded
  // quote. Without a session service there is nothing to check against, so the
  // resolver stays the only guard — and when evidence is required, writes stop.
  const service = createLedgerService({
    root: join(dataDir, 'ledger'),
    now,
    verifyEvidence: evidence === null ? undefined : (refs) => evidence.verify(refs),
  });

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
          : error.code === 'no-evidence' || error.code === 'empty' || error.code === 'invalid-kind' || error.code === 'invalid-type' ? 422
            : error.code === 'busy' ? 503
              : 500;
      writeJson(res, status, { ok: false, error: error.code });
      return;
    }
    fail(res, error);
  }

  /**
   * Loopback fence plus the write token published by /state.
   *
   * The token is not a secret from a local process — /state is already readable
   * on loopback — it is what a hostile page cannot obtain: a cross-origin fetch
   * may not read /state's body, and attaching this custom header forces a
   * preflight the Host never approves. So a page the user happens to visit
   * cannot drive a formal write from their own browser.
   */
  function authorizeWrite(req, res) {
    if (!isTrustedWrite(req)) {
      writeJson(res, 403, { ok: false, error: 'forbidden' });
      return false;
    }
    const headers = req.headers || {};
    const presented = headers[WRITE_TOKEN_HEADER];
    if (typeof presented !== 'string' || presented === '' || presented !== writeToken) {
      writeJson(res, 401, { ok: false, error: 'unauthorized' });
      return false;
    }
    return true;
  }

  /** Formal ledger writes need a live evidence verifier unless a test opts out. */
  function ensureEvidenceAvailable(res) {
    if (evidenceRequired && evidence === null) {
      writeJson(res, 503, { ok: false, error: 'evidence-unavailable' });
      return false;
    }
    return true;
  }

  function requireBaseChangeId(value, res) {
    if (typeof value !== 'string' || value.trim() === '') {
      writeJson(res, 400, { ok: false, error: 'missing-base' });
      return false;
    }
    return true;
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
        writeJson(res, 200, { ok: true, writeToken, ...state });
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
      // The id becomes a git pathspec, where `*`, `?` and `..` are glob and
      // revision syntax. Refuse a malformed one here as a client error instead
      // of letting git match several records and report them as one timeline.
      if (!isRecordId(memoryId)) { writeJson(res, 400, { ok: false, error: 'bad-id' }); return; }
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
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      if (!ensureEvidenceAvailable(res)) return;
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
          // Passed through untouched: the ledger schema is the one validator, so
          // a malformed list is refused with a real reason instead of vanishing.
          tags: body.tags,
          entities: body.entities,
        });
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        fail(res, error);
      }
    },

    [`${API_PREFIX}/update`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      if (!ensureEvidenceAvailable(res)) return;
      try {
        const body = await readJsonBody(req);
        if (typeof body.memoryId !== 'string' || body.memoryId === '') { writeJson(res, 400, { ok: false, error: 'missing-id' }); return; }
        // A trait-only change (privacy, pinning) does not restate the text, so
        // `content` is optional when at least one trait is given. When it is
        // given it must still be non-empty: an empty edit is a mistake, not a
        // way to blank a memory.
        const hasTrait = body.sensitivity !== undefined || body.pinned !== undefined;
        const rawContent = typeof body.content === 'string' ? body.content.trim() : '';
        if (rawContent === '' && !hasTrait) { writeJson(res, 400, { ok: false, error: 'empty' }); return; }
        if (typeof body.content === 'string' && rawContent === '') { writeJson(res, 400, { ok: false, error: 'empty' }); return; }
        if (!requireBaseChangeId(body.expectedBaseChangeId, res)) return;
        // An UPDATE may cite the session event that prompted it, but the panel's
        // edit flow has no such event (the user typed in a form). The service
        // therefore verifies the *effective* evidence: the new refs when given,
        // otherwise the refs the memory already carries. Either way something
        // real is checked — see ledger-service.apply.
        let ref = body.sourceRef;
        if (ref === undefined && body.sessionId !== undefined && body.turn !== undefined) {
          const resolved = await resolveSafe(body.sessionId, body.turn);
          if (resolved.error !== undefined) {
            writeJson(res, 422, { ok: false, error: 'no-evidence', reason: resolved.error });
            return;
          }
          ref = resolved.ref;
        }
        const result = await service.update({
          memoryId: body.memoryId,
          // Undefined means "keep the text": the ledger merges, so a trait-only
          // change leaves the content exactly as it was.
          content: rawContent === '' ? undefined : rawContent,
          expectedBaseChangeId: body.expectedBaseChangeId,
          sourceRefs: ref === undefined ? undefined : [ref],
          tags: body.tags,
          entities: body.entities,
          sensitivity: body.sensitivity,
          pinned: body.pinned,
        });
        // The new wording answers the objection (§6.5): the user may ask for it
        // to be cleared in the same request, so the memory is not left hidden
        // after they fixed it. A memory with no objection is not an error.
        //
        // The commit has already landed by this point, so a failure here must
        // not turn a successful write into an error response: the caller would
        // retry with a base id that is now stale and get a 409 for work that
        // succeeded. Report `objection_cleared: false` and let the panel retry
        // the clear on its own.
        let cleared = false;
        let clearError = null;
        if (body.clearObjection === true) {
          try {
            await runtime.reinstate(body.memoryId);
            cleared = true;
          } catch (error) {
            const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : null;
            if (code === 'missing') {
              // Nothing was objected to: not an error, and not a clear.
              cleared = false;
            } else {
              clearError = code ?? 'failed';
            }
          }
        }
        writeJson(res, 200, { ok: true, ...result, objection_cleared: cleared, ...(clearError === null ? {} : { objection_clear_error: clearError }) });
      } catch (error) {
        fail(res, error);
      }
    },

    [`${API_PREFIX}/retract`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      if (!ensureEvidenceAvailable(res)) return;
      try {
        const body = await readJsonBody(req);
        if (typeof body.memoryId !== 'string' || body.memoryId === '') { writeJson(res, 400, { ok: false, error: 'missing-id' }); return; }
        if (!requireBaseChangeId(body.expectedBaseChangeId, res)) return;
        // Same rule as /update: a RETRACT may cite the event that prompted it,
        // and when it does not, the service verifies the refs the memory already
        // carries rather than skipping the check.
        let ref = body.sourceRef;
        if (ref === undefined && body.sessionId !== undefined && body.turn !== undefined) {
          const resolved = await resolveSafe(body.sessionId, body.turn);
          if (resolved.error !== undefined) {
            writeJson(res, 422, { ok: false, error: 'no-evidence', reason: resolved.error });
            return;
          }
          ref = resolved.ref;
        }
        const result = await service.retract({
          memoryId: body.memoryId,
          expectedBaseChangeId: body.expectedBaseChangeId,
          sourceRefs: ref === undefined ? undefined : [ref],
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });
        writeJson(res, 200, { ok: true, ...result });
      } catch (error) {
        fail(res, error);
      }
    },

    /**
     * Permanent erasure (§8.3 "彻底删除", phase 5.4).
     *
     * Not a variant of /retract: a retraction stops use and keeps the history,
     * an erasure rewrites the history to remove the text. Because it is
     * irreversible it requires `confirm: true` in the body — a missing
     * confirmation is a 400, not a silent success — and it answers with the
     * scope it actually reached. `complete` is always false: a backup, a clone
     * or an earlier export is outside what this route can promise.
     */
    [`${API_PREFIX}/erase`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        if (typeof body.memoryId !== 'string' || body.memoryId === '') {
          writeJson(res, 400, { ok: false, error: 'missing-id' });
          return;
        }
        // Second confirmation, as the roadmap requires for an irreversible step.
        if (body.confirm !== true) {
          writeJson(res, 400, { ok: false, error: 'confirm-required', scope: describeErasure() });
          return;
        }
        const result = await service.erase({ memoryId: body.memoryId });
        // A memory that was not there is reported as such rather than as a
        // successful erasure of nothing.
        if (result.erased !== true) {
          writeJson(res, result.reason === 'not-found' ? 404 : 409, { ok: false, error: result.reason ?? 'not-erased', ...result });
          return;
        }
        // Runtime copies: candidates, objections, proposals and audit rows that
        // name this memory. The ledger cannot reach them.
        let runtimeCleared = 0;
        try {
          runtimeCleared = await runtime.forgetMemory(body.memoryId);
        } catch {
          // Reported, not hidden: the ledger part succeeded, the runtime part
          // did not, and the caller must be able to tell the difference.
          writeJson(res, 200, { ok: true, ...result, runtime_cleared: null, runtime_error: 'failed' });
          return;
        }
        writeJson(res, 200, {
          ok: true,
          ...result,
          scopes: [...result.scopes, 'runtime'],
          runtime_cleared: runtimeCleared,
          message: describeErasureResult({
            erased: true,
            scopes: [...result.scopes, 'runtime'],
          }).message,
        });
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
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        // The candidate text becomes a memory's content, so it must be a string.
        // The store coerced it with String(), which turned `text: 123` into the
        // candidate "123" and `text: {}` into "[object Object]" — junk that a
        // reviewer could accept straight into the ledger.
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          writeJson(res, 400, { ok: false, error: 'empty' });
          return;
        }
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
          entities: body.entities,
        });
        writeJson(res, 200, { ok: true, candidate });
      } catch (error) {
        runtimeFail(res, error);
      }
    },

    [`${API_PREFIX}/review`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!authorizeWrite(req, res)) return;
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
          if (!ensureEvidenceAvailable(res)) return;
          // Only a candidate still awaiting a decision may be accepted. Accepting
          // one that is already settled hits the idempotency receipt, which
          // replays the original commit and returns 200 — so an edited `content`
          // was silently discarded while the panel reported success (§8.2 "不静默覆盖").
          if (!isOpenCandidateStatus(candidate.status)) {
            writeJson(res, 409, { ok: false, error: 'not-open', status: candidate.status ?? null });
            return;
          }
          const content = typeof body.content === 'string' && body.content.trim() !== '' ? body.content.trim() : candidate.text;
          // Older candidates may still carry a rule kind the ledger does not
          // know; refusing here beats returning an opaque schema error.
          const type = toLedgerType(candidate.type);
          if (type === null) {
            writeJson(res, 422, { ok: false, error: 'invalid-type', candidateType: candidate.type ?? null });
            return;
          }
          const entities = Array.isArray(candidate.entities) && candidate.entities.length > 0 ? candidate.entities : undefined;
          const result = await service.add({
            content,
            type,
            sourceRefs: candidate.source_refs,
            ...(entities === undefined ? {} : { entities }),
            idempotencyKey: `candidate:${candidate.id}`,
          });
          const reviewed = await runtime.setCandidateStatus(candidate.id, 'accepted_by_user', { memoryId: result.memory ? result.memory.id : undefined });
          writeJson(res, 200, { ok: true, status: result.status, memory: result.memory, candidate: reviewed });
          return;
        }
        if (body.action === 'merge') {
          if (!ensureEvidenceAvailable(res)) return;
          const content = typeof body.content === 'string' ? body.content.trim() : '';
          if (typeof body.targetId !== 'string' || body.targetId === '') { writeJson(res, 400, { ok: false, error: 'missing-target' }); return; }
          if (content === '') { writeJson(res, 400, { ok: false, error: 'empty' }); return; }
          if (!requireBaseChangeId(body.expectedBaseChangeId, res)) return;
          const result = await service.update({
            memoryId: body.targetId,
            content,
            expectedBaseChangeId: body.expectedBaseChangeId,
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
          writeJson(res, 200, {
          ok: true,
          objections,
          suppressed: await runtime.suppressedIds(),
          review_pending: await runtime.reviewPendingIds(),
          kinds: CORRECTION_KINDS,
        });
        } catch (error) {
          runtimeFail(res, error);
        }
        return;
      }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        const memoryId = typeof body.memoryId === 'string' ? body.memoryId.trim() : '';
        if (memoryId === '') { writeJson(res, 400, { ok: false, error: 'missing-id' }); return; }
        const state = await service.state();
        const known = Array.isArray(state.memories) && state.memories.some((memory) => memory !== null && typeof memory === 'object' && memory.id === memoryId);
        if (!known) { writeJson(res, 404, { ok: false, error: 'missing' }); return; }
        const objection = await runtime.addObjection({ memoryId, kind: body.kind, reason: body.reason });
        const memory = state.memories.find((entry) => entry !== null && typeof entry === 'object' && entry.id === memoryId);
        // §6.6: a review objection does not invent a replacement. The response says
        // why no proposal was written, so the panel cannot claim one is pending.
        const narrowing = narrowingRequest({ objection, memory });
        writeJson(res, 200, { ok: true, objection, suppressed: await runtime.suppressedIds(), review_pending: await runtime.reviewPendingIds(), narrowing });
      } catch (error) {
        runtimeFail(res, error);
      }
    },

    [`${API_PREFIX}/objections/clear`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        // Same contract as POST /objections: a missing or non-string id is a
        // client error, not a runtime failure. Passing it straight through made
        // this the only write route answering 422 where its siblings answer 400.
        const memoryId = typeof body.memoryId === 'string' ? body.memoryId.trim() : '';
        if (memoryId === '') { writeJson(res, 400, { ok: false, error: 'missing-id' }); return; }
        const cleared = await runtime.reinstate(memoryId);
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
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        // Validation happens against the values in force, then the write is
        // serialised: a plain load-merge-write here lost a field whenever two
        // requests overlapped, and the losing change vanished without an error.
        let invalid = null;
        const written = await updateSettings(dataDir, (current) => {
          const next = {
            enabled: body.enabled === undefined ? current.enabled : body.enabled,
            autoAccept: body.autoAccept === undefined ? current.autoAccept : body.autoAccept,
            autoAcceptTypes: body.autoAcceptTypes === undefined ? current.autoAcceptTypes : body.autoAcceptTypes,
          };
          if (typeof next.enabled !== 'boolean') { invalid = 'enabled'; return null; }
          if (typeof next.autoAccept !== 'boolean') { invalid = 'autoAccept'; return null; }
          if (!Array.isArray(next.autoAcceptTypes)) { invalid = 'autoAcceptTypes'; return null; }
          return next;
        });
        if (invalid !== null) { writeJson(res, 400, { ok: false, error: 'invalid-settings', field: invalid }); return; }
        writeJson(res, 200, { ok: true, ...written, choices: { autoAcceptTypes: AUTO_ACCEPT_TYPE_CHOICES } });
      } catch (error) {
        fail(res, error);
      }
    },

    /**
     * AI proposals (§11): the model may submit, only the user may accept.
     *
     * Creating a proposal never touches the ledger. Accepting goes through the
     * same single writer the review panel uses, against the version the user
     * actually saw, so a concurrent edit cannot be silently overwritten.
     */
    [`${API_PREFIX}/proposals`]: async (req, res) => {
      if (req.method === 'GET') {
        if (!isTrustedRead(req)) { writeJson(res, 403, { ok: false, error: 'forbidden' }); return; }
        writeJson(res, 200, { ok: true, proposals: await runtime.listProposals(), actions: PROPOSAL_ACTIONS });
        return;
      }
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      try {
        const body = await readJsonBody(req);
        if (typeof body.proposalId !== 'string' || body.proposalId === '') {
          writeJson(res, 400, { ok: false, error: 'missing-id' }); return;
        }
        const proposals = await runtime.listProposals();
        const proposal = proposals.find((entry) => entry.id === body.proposalId);
        if (!proposal) { writeJson(res, 404, { ok: false, error: 'missing' }); return; }
        if (proposal.status !== 'open') { writeJson(res, 409, { ok: false, error: 'not-open', status: proposal.status }); return; }

        if (body.action === 'reject') {
          const reviewed = await runtime.setProposalStatus(proposal.id, 'rejected');
          writeJson(res, 200, { ok: true, proposal: reviewed });
          return;
        }
        if (body.action !== 'accept') { writeJson(res, 400, { ok: false, error: 'unknown-action' }); return; }
        if (!ensureEvidenceAvailable(res)) return;

        const expected = typeof body.expectedBaseChangeId === 'string' && body.expectedBaseChangeId !== ''
          ? body.expectedBaseChangeId
          : null;
        let result;
        if (proposal.action === 'add') {
          result = await service.add({
            content: proposal.content,
            type: proposal.type ?? undefined,
            sourceRefs: proposal.source_refs,
            idempotencyKey: `proposal:${proposal.id}`,
          });
        } else {
          if (expected === null) { writeJson(res, 400, { ok: false, error: 'missing-base' }); return; }
          if (typeof proposal.target_memory_id !== 'string' || proposal.target_memory_id === '') {
            writeJson(res, 422, { ok: false, error: 'missing-target' }); return;
          }
          result = proposal.action === 'retract'
            ? await service.retract({ memoryId: proposal.target_memory_id, expectedBaseChangeId: expected })
            : await service.update({ memoryId: proposal.target_memory_id, content: proposal.content, expectedBaseChangeId: expected });
        }
        const reviewed = await runtime.setProposalStatus(proposal.id, 'accepted', {
          memoryId: result && result.memory && typeof result.memory.id === 'string' ? result.memory.id : undefined,
        });
        writeJson(res, 200, { ok: true, status: result && result.status, memory: result ? result.memory : null, proposal: reviewed });
      } catch (error) {
        // Stale or busy stays retryable, so the proposal stays open.
        runtimeFail(res, error);
      }
    },

    [`${API_PREFIX}/migrate`]: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      if (!authorizeWrite(req, res)) return;
      if (!requiresJson(req)) { writeJson(res, 415, { ok: false, error: 'json-required' }); return; }
      if (!ensureEvidenceAvailable(res)) return;
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

  return { routes, service, runtime, evidence, writeToken, settings: () => loadSettings(dataDir).settings };
}

/** Turn the handler table into the exact WebRoute list the web server wants. */
export function createAppRoutes(app) {
  return Object.entries(app.routes).map(([path, handler]) => ({ kind: 'exact', path, handler }));
}
