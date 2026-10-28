import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createMemoryApp } from '../host/http-app.js';

const BROWSER = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:51840' };
const JSON_HEADERS = { 'content-type': 'application/json' };
const LOG = [
  { seq: 1, type: 'turn/start' },
  { seq: 2, type: 'user/message' },
  { seq: 3, type: 'turn/end' },
];

function makeRequest({ method = 'GET', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return {
    method,
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:51840', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeResponse() {
  const captured = { status: 0, body: '' };
  return {
    captured,
    writeHead(status) { captured.status = status; },
    end(body) { captured.body = body ?? ''; },
  };
}

async function call(app, path, options) {
  const res = makeResponse();
  const [routePath, query] = path.split('?');
  const req = makeRequest(options);
  // Handlers read the query from req.url; the route table is keyed by path only.
  if (query !== undefined) req.url = path;
  await app.routes[routePath](req, res);
  return { status: res.captured.status, json: res.captured.body === '' ? null : JSON.parse(res.captured.body) };
}

async function withApp(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-app-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('state answers an empty ledger and refuses untrusted callers', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.status, 200);
    assert.equal(state.json.ok, true);
    assert.deepEqual(state.json.memories, []);

    assert.equal((await call(app, '/api/dsh-memory/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await call(app, '/api/dsh-memory/state', { headers: { host: 'evil.example.com' } })).status, 403);
    assert.equal((await call(app, '/api/dsh-memory/state', { remoteAddress: '10.0.0.5' })).status, 403);
  });
});

test('the write fence matches the shipped task board: loopback and host, not a browser marker', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    // A local client with no Origin and no Sec-Fetch-Site still reaches the
    // handler, exactly like the task board's ledger. Evidence is what decides.
    const bare = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: JSON_HEADERS, body: { content: 'x', sourceRef: { session_id: 's', event_seq: 1 } },
    });
    assert.equal(bare.status, 200);

    // A cross-site request is still refused before anything is written.
    const crossSite = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site', origin: 'http://evil.example.com' },
      body: { content: 'y', sourceRef: { session_id: 's', event_seq: 1 } },
    });
    assert.equal(crossSite.status, 403);

    const foreignHost = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: { ...JSON_HEADERS, host: 'evil.example.com' },
      body: { content: 'z', sourceRef: { session_id: 's', event_seq: 1 } },
    });
    assert.equal(foreignHost.status, 403);

    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.json.memories.length, 1, 'only the accepted write landed');
  });
});

test('a mutation needs JSON and evidence', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const noJson = await call(app, '/api/dsh-memory/add', { method: 'POST', headers: BROWSER, body: { content: 'x' } });
    assert.equal(noJson.status, 415);

    const noEvidence = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS }, body: { content: '没有证据' },
    });
    assert.equal(noEvidence.status, 422);
    assert.equal(noEvidence.json.error, 'no-evidence');
  });
});

test('adding with an explicit source ref commits and shows up in state', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const added = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS },
      body: { content: '用户喜欢简洁的回答', type: 'preference', sourceRef: { session_id: 's1', event_seq: 2, event_type: 'user/message' } },
    });
    assert.equal(added.status, 200);
    assert.equal(added.json.ok, true);
    assert.equal(added.json.status, 'committed');

    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.json.memories.length, 1);
    assert.equal(state.json.memories[0].content, '用户喜欢简洁的回答');
    assert.equal(state.json.memories[0].version, 1);

    const exported = await call(app, '/api/dsh-memory/export');
    assert.equal(exported.json.format, 'dsh-memory/v2');
    assert.equal(exported.json.memories.length, 1);
    assert.equal(typeof exported.json.ledger.head, 'string');
  });
});

test('a turn is turned into a real event seq through sessionQuery', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({
      dataDir: dir,
      sessionQuery: {
        async listEvents() { return LOG; },
        async readEvent({ seq }) { return { target: { seq, data: { turn: 1 } } }; },
      },
    });
    const added = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS },
      body: { content: '来自第 1 轮', sessionId: 's1', turn: 1 },
    });
    assert.equal(added.status, 200);
    assert.equal(added.json.memory.source.event_seq, 2);
    assert.equal(added.json.memory.source.session_id, 's1');
  });
});

test('a stale edit is refused with 409 and an unknown memory with 404', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const created = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { content: '第一版', sourceRef: { session_id: 's1', event_seq: 2 } },
    });
    const memory = created.json.memory;

    const ok = await call(app, '/api/dsh-memory/update', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { memoryId: memory.id, content: '第二版', expectedBaseChangeId: memory.last_change_id },
    });
    assert.equal(ok.status, 200);

    const stale = await call(app, '/api/dsh-memory/update', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { memoryId: memory.id, content: '过期编辑', expectedBaseChangeId: memory.last_change_id },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, 'stale');

    const missing = await call(app, '/api/dsh-memory/update', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { memoryId: 'M-19990101-nope', content: 'x' },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'missing');
  });
});

test('migration imports what it can prove and reports what it cannot', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({
      dataDir: dir,
      sessionQuery: {
        async listEvents() { return LOG; },
        async readEvent({ seq }) { return { target: { seq, data: { turn: 1 } } }; },
      },
    });

    const migrated = await call(app, '/api/dsh-memory/migrate', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS },
      body: {
        memories: [
          { id: 'memory-1', version: 1, status: 'active', content: '有证据的记忆', source: { session_id: 's1', turn: 1 } },
          { id: 'memory-2', version: 1, status: 'active', content: '找不到证据的记忆', source: { session_id: 's1', turn: 9 } },
        ],
        candidates: [
          { id: 'candidate-1', text: '待确认的偏好', source: { session_id: 's1', turn: 1 } },
          { id: 'candidate-2', text: '没有来源的候选' },
        ],
      },
    });
    assert.equal(migrated.status, 200);
    assert.equal(migrated.json.applied, 1);
    assert.equal(migrated.json.failed, 0);
    assert.ok(migrated.json.skipped.some((entry) => entry.reason === 'no-evidence'));
    assert.equal(migrated.json.deferred.candidates.imported, 1);
    assert.equal(migrated.json.deferred.candidates.skipped[0].reason, 'no-evidence');

    const queued = await call(app, '/api/dsh-memory/candidates');
    assert.equal(queued.json.candidates.length, 1);
    assert.equal(queued.json.candidates[0].origin, 'legacy', 'imported candidates say where they came from');
    assert.equal(queued.json.candidates[0].text, '待确认的偏好');

    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.json.memories.length, 1);
    assert.equal(state.json.memories[0].content, '有证据的记忆');
    assert.equal(state.json.memories[0].source.event_seq, 2);

    const again = await call(app, '/api/dsh-memory/migrate', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS },
      body: { memories: [{ id: 'memory-1', version: 1, status: 'active', content: '有证据的记忆', source: { session_id: 's1', turn: 1 } }] },
    });
    assert.equal(again.json.replayed, 0);
    assert.equal(again.json.applied, 0);
    assert.ok(again.json.skipped.some((entry) => entry.reason === 'duplicate'));
  });
});

test('a candidate is queued, then accepted into the ledger with its own evidence', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({
      dataDir: dir,
      sessionQuery: {
        async listEvents() { return LOG; },
        async readEvent({ seq }) { return { target: { seq, data: { turn: 1 } } }; },
      },
    });

    const queued = await call(app, '/api/dsh-memory/candidate', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS },
      body: { text: '用户偏好中文回答', type: 'preference', sessionId: 's1', turn: 1, origin: 'user' },
    });
    assert.equal(queued.status, 200);
    assert.equal(queued.json.candidate.status, 'pending');
    assert.equal(queued.json.candidate.origin, 'user', 'the declared origin is kept');
    assert.equal(queued.json.candidate.source_refs[0].event_seq, 2);

    const list = await call(app, '/api/dsh-memory/candidates');
    assert.equal(list.json.candidates.length, 1);
    assert.equal(list.json.summary.pending, 1);

    const accepted = await call(app, '/api/dsh-memory/review', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS },
      body: { candidateId: queued.json.candidate.id, action: 'accept' },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.status, 'committed');
    assert.equal(accepted.json.memory.content, '用户偏好中文回答');
    assert.equal(accepted.json.candidate.status, 'accepted');

    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.json.memories.length, 1);
    assert.equal(state.json.memories[0].source.event_seq, 2);
  });
});

test('review refuses what it cannot do instead of guessing', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });

    const noEvidence = await call(app, '/api/dsh-memory/candidate', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS }, body: { text: '没有证据' },
    });
    assert.equal(noEvidence.status, 422);

    const withRef = await call(app, '/api/dsh-memory/candidate', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { text: '有证据', sourceRef: { session_id: 's1', event_seq: 2 } },
    });
    assert.equal(withRef.status, 200);

    const duplicate = await call(app, '/api/dsh-memory/candidate', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { text: '有证据 ', sourceRef: { session_id: 's1', event_seq: 2 } },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error, 'duplicate');

    const missing = await call(app, '/api/dsh-memory/review', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS }, body: { candidateId: 'C-nope', action: 'accept' },
    });
    assert.equal(missing.status, 404);

    const unknownAction = await call(app, '/api/dsh-memory/review', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { candidateId: withRef.json.candidate.id, action: 'maybe' },
    });
    assert.equal(unknownAction.status, 400);
    assert.equal(unknownAction.json.error, 'unknown-action');

    const rejected = await call(app, '/api/dsh-memory/review', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { candidateId: withRef.json.candidate.id, action: 'reject' },
    });
    assert.equal(rejected.json.candidate.status, 'rejected');
    assert.equal((await call(app, '/api/dsh-memory/state')).json.memories.length, 0);
  });
});

test('an unreadable session is a refusal, not an internal error', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({
      dataDir: dir,
      sessionQuery: {
        async listEvents() { throw new Error('no such session'); },
        async readEvent() { throw new Error('no such session'); },
      },
    });
    const added = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS },
      body: { content: '读不到会话的记忆', sessionId: 'session-missing', turn: 1 },
    });
    assert.equal(added.status, 422, 'a missing session must not surface as a 500');
    assert.equal(added.json.error, 'no-evidence');
    assert.equal(added.json.reason, 'session-unreadable');

    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.json.memories.length, 0);
  });
});

test('invalid bodies, wrong methods and retraction behave', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const badJson = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS }, body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.error, 'invalid-json');

    const wrongMethod = await call(app, '/api/dsh-memory/add', { headers: BROWSER });
    assert.equal(wrongMethod.status, 405);

    const emptyContent = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS }, body: { content: '   ', sourceRef: { session_id: 's', event_seq: 1 } },
    });
    assert.equal(emptyContent.status, 400);
    assert.equal(emptyContent.json.error, 'empty');

    const created = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { content: '将被撤回', sourceRef: { session_id: 's1', event_seq: 2 } },
    });
    const retracted = await call(app, '/api/dsh-memory/retract', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { memoryId: created.json.memory.id, expectedBaseChangeId: created.json.memory.last_change_id, reason: '用户要求撤回' },
    });
    assert.equal(retracted.status, 200);
    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.json.memories[0].status, 'retracted');
  });
});

test('history returns the version timeline oldest first and refuses the rest', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const added = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { content: '先记住这条约定', type: 'fact', sourceRef: { session_id: 's1', event_seq: 2 } },
    });
    assert.equal(added.status, 200);
    const memoryId = added.json.memory.id;
    const updated = await call(app, '/api/dsh-memory/update', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { memoryId, content: '改成这条约定', expectedBaseChangeId: added.json.change_id },
    });
    assert.equal(updated.status, 200);

    const history = await call(app, '/api/dsh-memory/history?memoryId=' + memoryId);
    assert.equal(history.status, 200);
    assert.equal(history.json.ok, true);
    assert.equal(history.json.memoryId, memoryId);
    assert.equal(history.json.versions.length, 2);
    assert.deepEqual(history.json.versions.map((entry) => entry.change_type), ['ADD', 'UPDATE']);
    assert.deepEqual(history.json.versions.map((entry) => entry.version), [1, 2]);
    assert.equal(history.json.versions[0].content, '先记住这条约定');
    assert.equal(history.json.versions[1].content, '改成这条约定');
    assert.match(history.json.versions[0].commit, /^[0-9a-f]{7,40}$/u);
    assert.equal(typeof history.json.versions[1].committed_at, 'string');

    const missingId = await call(app, '/api/dsh-memory/history');
    assert.equal(missingId.status, 400);
    assert.equal(missingId.json.error, 'missing-id');

    const unknown = await call(app, '/api/dsh-memory/history?memoryId=M-0000000000000000-000000');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, 'missing');

    const forbidden = await call(app, '/api/dsh-memory/history?memoryId=' + memoryId, { headers: { host: 'evil.example' } });
    assert.equal(forbidden.status, 403);

    const wrongMethod = await call(app, '/api/dsh-memory/history?memoryId=' + memoryId, { method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS }, body: {} });
    assert.equal(wrongMethod.status, 405);
  });
});

test('changes lists recent ledger commits newest first and validates its limit', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const empty = await call(app, '/api/dsh-memory/changes');
    assert.equal(empty.status, 200);
    assert.equal(empty.json.ok, true);
    assert.deepEqual(empty.json.changes, []);
    assert.ok(empty.json.head === null || typeof empty.json.head === 'string');

    const added = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { content: '账本留痕第一条', type: 'fact', sourceRef: { session_id: 's1', event_seq: 2 } },
    });
    assert.equal(added.status, 200);
    const updated = await call(app, '/api/dsh-memory/update', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { memoryId: added.json.memory.id, content: '账本留痕第二条', expectedBaseChangeId: added.json.change_id },
    });
    assert.equal(updated.status, 200);

    const recent = await call(app, '/api/dsh-memory/changes?limit=10');
    assert.equal(recent.status, 200);
    assert.equal(recent.json.count, 2);
    assert.deepEqual(recent.json.changes.map((entry) => entry.change_type), ['UPDATE', 'ADD']);
    assert.equal(recent.json.changes[0].memory_id, added.json.memory.id);
    assert.equal(recent.json.changes[0].content, '账本留痕第二条');
    assert.match(recent.json.changes[0].commit, /^[0-9a-f]{7,40}$/u);
    assert.equal(typeof recent.json.head, 'string');

    const limited = await call(app, '/api/dsh-memory/changes?limit=1');
    assert.equal(limited.json.changes.length, 1);
    assert.equal(limited.json.changes[0].change_type, 'UPDATE');

    assert.equal((await call(app, '/api/dsh-memory/changes?limit=abc')).status, 400);
    assert.equal((await call(app, '/api/dsh-memory/changes', { headers: { host: 'evil.example.com' } })).status, 403);
    assert.equal((await call(app, '/api/dsh-memory/changes', { method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS }, body: {} })).status, 405);
  });
});

test('the queue says whether a candidate is new, identical or conflicting', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({
      dataDir: dir,
      sessionQuery: {
        async listEvents() { return LOG; },
        async readEvent({ seq }) { return { target: { seq, data: { turn: 1 } } }; },
      },
    });
    const queued = await call(app, '/api/dsh-memory/candidate', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { text: '项目使用 pnpm', type: 'fact', sessionId: 's1', turn: 1 },
    });
    assert.equal(queued.status, 200);
    const empty = await call(app, '/api/dsh-memory/candidates');
    assert.equal(empty.json.candidates[0].classification.decision, 'ADD');

    const accepted = await call(app, '/api/dsh-memory/review', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { candidateId: queued.json.candidate.id, action: 'accept' },
    });
    assert.equal(accepted.status, 200);
    const memoryId = accepted.json.memory.id;

    await call(app, '/api/dsh-memory/candidate', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { text: '项目使用 pnpm', type: 'fact', sessionId: 's1', turn: 1 },
    });
    await call(app, '/api/dsh-memory/candidate', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { text: '项目使用 pnpm 管理依赖', type: 'fact', sessionId: 's1', turn: 1 },
    });
    await call(app, '/api/dsh-memory/candidate', {
      method: 'POST', headers: { ...BROWSER, ...JSON_HEADERS },
      body: { text: '偏好中文回答', type: 'preference', sessionId: 's1', turn: 1 },
    });

    const list = await call(app, '/api/dsh-memory/candidates');
    const byText = new Map(list.json.candidates.map((entry) => [entry.text, entry.classification]));
    assert.equal(byText.get('项目使用 pnpm').decision, 'NO_CHANGE');
    assert.equal(byText.get('项目使用 pnpm').targetId, memoryId);
    assert.equal(byText.get('项目使用 pnpm 管理依赖').decision, 'CONFLICT');
    assert.equal(byText.get('偏好中文回答').decision, 'ADD');

    const byPolicy = new Map(list.json.candidates.map((entry) => [entry.text, entry.policy]));
    assert.deepEqual(byPolicy.get('项目使用 pnpm'), { decision: 'NO_CHANGE', reasons: ['duplicate'] });
    assert.deepEqual(byPolicy.get('项目使用 pnpm 管理依赖'), { decision: 'CONFLICT', reasons: ['conflict'] });
    assert.deepEqual(byPolicy.get('偏好中文回答'), { decision: 'REVIEW_REQUIRED', reasons: ['auto-accept-disabled'] });
  });
});
