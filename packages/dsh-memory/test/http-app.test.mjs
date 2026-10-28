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
  await app.routes[path](makeRequest(options), res);
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

test('a mutation without a browser marker is refused', async () => {
  await withApp(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const bare = await call(app, '/api/dsh-memory/add', {
      method: 'POST', headers: JSON_HEADERS, body: { content: 'x', sourceRef: { session_id: 's', event_seq: 1 } },
    });
    assert.equal(bare.status, 403);
    assert.equal(bare.json.error, 'forbidden');
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
