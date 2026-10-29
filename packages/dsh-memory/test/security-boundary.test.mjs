import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createMemoryApp } from '../host/http-app.js';
import { applyCorrection, correctionKinds } from '../host/correction-detect.js';
import { normalizeCorrectionKind } from '../host/corrections.js';
import { createInjectionRuntime } from '../host/injection.js';
import { createRuntimeStore } from '../host/runtime-store.js';

const BROWSER = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:51840' };
const JSON_HEADERS = { 'content-type': 'application/json' };
const REF = { session_id: 's1', event_seq: 2, event_type: 'user/message' };

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
  if (query !== undefined) req.url = path;
  await app.routes[routePath](req, res);
  return { status: res.captured.status, json: res.captured.body === '' ? null : JSON.parse(res.captured.body) };
}

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-security-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeHeaders(app, extra = {}) {
  const state = await call(app, '/api/dsh-memory/state');
  assert.equal(state.status, 200);
  assert.equal(typeof state.json.writeToken, 'string');
  assert.ok(state.json.writeToken.length >= 32);
  return {
    ...BROWSER,
    ...JSON_HEADERS,
    'x-dsh-memory-token': state.json.writeToken,
    ...extra,
  };
}

test('a write without the session token is refused even on loopback', async () => {
  await withDir(async (dir) => {
    const app = createMemoryApp({ dataDir: dir, allowUnverified: true });
    const bare = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS },
      body: { content: '未授权写入', sourceRef: REF },
    });
    assert.equal(bare.status, 401);
    assert.equal(bare.json.error, 'unauthorized');

    const wrong = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers: { ...BROWSER, ...JSON_HEADERS, 'x-dsh-memory-token': 'not-the-token' },
      body: { content: '伪造令牌', sourceRef: REF },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'unauthorized');

    const headers = await writeHeaders(app);
    const ok = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers,
      body: { content: '授权写入', sourceRef: REF },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);

    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.json.memories.length, 1);
    assert.equal(state.json.memories[0].content, '授权写入');
  });
});

test('update and retract refuse a missing concurrency baseline', async () => {
  await withDir(async (dir) => {
    const app = createMemoryApp({ dataDir: dir, allowUnverified: true });
    const headers = await writeHeaders(app);
    const created = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers,
      body: { content: '基线记忆', sourceRef: REF },
    });
    assert.equal(created.status, 200);
    const memory = created.json.memory;

    const noBase = await call(app, '/api/dsh-memory/update', {
      method: 'POST',
      headers,
      body: { memoryId: memory.id, content: '无基线更新' },
    });
    assert.equal(noBase.status, 400);
    assert.equal(noBase.json.error, 'missing-base');

    const emptyBase = await call(app, '/api/dsh-memory/update', {
      method: 'POST',
      headers,
      body: { memoryId: memory.id, content: '空基线', expectedBaseChangeId: '' },
    });
    assert.equal(emptyBase.status, 400);
    assert.equal(emptyBase.json.error, 'missing-base');

    const retractNoBase = await call(app, '/api/dsh-memory/retract', {
      method: 'POST',
      headers,
      body: { memoryId: memory.id, reason: '无基线撤回' },
    });
    assert.equal(retractNoBase.status, 400);
    assert.equal(retractNoBase.json.error, 'missing-base');

    const state = await call(app, '/api/dsh-memory/state');
    assert.equal(state.json.memories[0].content, '基线记忆');
    assert.equal(state.json.memories[0].status, 'active');
  });
});

test('without sessionQuery, formal writes fail closed as evidence-unavailable', async () => {
  await withDir(async (dir) => {
    const app = createMemoryApp({ dataDir: dir });
    const headers = await writeHeaders(app);
    const added = await call(app, '/api/dsh-memory/add', {
      method: 'POST',
      headers,
      body: { content: '无会话证据仍想写入', sourceRef: REF },
    });
    assert.equal(added.status, 503);
    assert.equal(added.json.error, 'evidence-unavailable');

    const state = await call(app, '/api/dsh-memory/state');
    assert.deepEqual(state.json.memories, []);
  });
});

test('cue kinds normalize onto the shared correction vocabulary before persistence', async () => {
  assert.equal(normalizeCorrectionKind('incorrect'), 'wrong');
  assert.equal(normalizeCorrectionKind('delete_request'), 'delete');
  assert.equal(normalizeCorrectionKind('outdated'), 'outdated');
  assert.deepEqual(correctionKinds('这条记忆错了'), ['incorrect']);

  await withDir(async (dir) => {
    const runtime = createRuntimeStore({ root: dir });
    const memory = {
      id: 'M-1',
      status: 'active',
      content: '项目使用 pnpm 管理依赖',
      type: 'fact',
      scope: 'global',
      tags: [],
      entities: ['pnpm'],
    };
    const wrong = await applyCorrection({
      text: '这条 pnpm 记忆错了',
      memories: [memory],
      suppressedIds: [],
      runtime,
    });
    assert.equal(wrong.recorded, true);
    assert.equal(wrong.kind, 'wrong');
    assert.equal(wrong.objection.kind, 'wrong');
    assert.deepEqual(await runtime.suppressedIds(), ['M-1']);

    await runtime.reinstate('M-1');
    const deleted = await applyCorrection({
      text: '删掉这条记忆：项目使用 pnpm 管理依赖',
      memories: [memory],
      suppressedIds: [],
      runtime,
    });
    assert.equal(deleted.recorded, true);
    assert.equal(deleted.kind, 'delete');
    assert.equal(deleted.objection.kind, 'delete');
  });
});

test('a failing suppressed lookup keeps the previous filtered snapshot', async () => {
  const memories = [
    { id: 'M-1', status: 'active', content: '项目使用 pnpm 管理依赖', type: 'fact', scope: 'global', tags: [], entities: [] },
    { id: 'M-2', status: 'active', content: '主题颜色用浅色', type: 'preference', scope: 'global', tags: [], entities: [] },
  ];
  let fail = false;
  const service = {
    async state() { return { head: 'abc', memories }; },
    async suppressed() {
      if (fail) throw new Error('runtime unavailable');
      return ['M-2'];
    },
  };
  const runtime = createInjectionRuntime({ service, now: () => new Date('2026-10-29T00:00:00Z') });
  await runtime.refresh();
  assert.deepEqual(runtime.snapshot.memories.map((entry) => entry.id), ['M-1']);
  assert.ok(!runtime.buildText(undefined).text.includes('浅色'));

  fail = true;
  await runtime.refresh();
  assert.deepEqual(runtime.snapshot.memories.map((entry) => entry.id), ['M-1'],
    'a suppression read failure must not re-inject an objected memory');
  assert.equal(runtime.snapshot.degraded, 'suppression-unavailable');
  assert.ok(!runtime.buildText(undefined).text.includes('浅色'));
});

test('a first suppression failure with no prior snapshot injects nothing', async () => {
  const memories = [
    { id: 'M-1', status: 'active', content: '项目使用 pnpm 管理依赖', type: 'fact', scope: 'global', tags: [], entities: [] },
  ];
  const runtime = createInjectionRuntime({
    service: {
      async state() { return { head: 'abc', memories }; },
      async suppressed() { throw new Error('runtime unavailable'); },
    },
    now: () => new Date('2026-10-29T00:00:00Z'),
  });
  await runtime.refresh();
  assert.deepEqual(runtime.snapshot.memories, []);
  assert.equal(runtime.snapshot.degraded, 'suppression-unavailable');
  assert.equal(runtime.buildText(undefined).text, '');
});

test('a sustained suppression outage keeps the same filtered snapshot on every refresh', async () => {
  const memories = [
    { id: 'M-1', status: 'active', content: '项目使用 pnpm 管理依赖', type: 'fact', scope: 'global', tags: [], entities: [] },
    { id: 'M-2', status: 'active', content: '主题颜色用浅色', type: 'preference', scope: 'global', tags: [], entities: [] },
  ];
  let fail = false;
  let ticks = 0;
  const runtime = createInjectionRuntime({
    service: {
      async state() { return { head: 'abc', memories }; },
      async suppressed() {
        if (fail) throw new Error('runtime unavailable');
        return ['M-2'];
      },
    },
    now: () => new Date(Date.UTC(2026, 9, 29, 0, 0, ticks++)),
  });
  await runtime.refresh();
  const goodAt = runtime.snapshot.at;
  assert.deepEqual(runtime.snapshot.memories.map((entry) => entry.id), ['M-1']);

  fail = true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runtime.refresh();
    assert.deepEqual(runtime.snapshot.memories.map((entry) => entry.id), ['M-1'],
      `refresh ${attempt + 1} of the outage must not widen the block`);
    assert.equal(runtime.snapshot.degraded, 'suppression-unavailable');
    assert.ok(!runtime.buildText(undefined).text.includes('浅色'));
  }
  assert.notEqual(runtime.snapshot.at, goodAt, 'the degraded snapshot is timestamped as a refresh');
  assert.equal(runtime.snapshot.suppressed, 1, 'the last known suppression count is kept');
});

test('after a restart a still-broken suppression read injects nothing, and recovery restores the filter', async () => {
  const memories = [
    { id: 'M-1', status: 'active', content: '项目使用 pnpm 管理依赖', type: 'fact', scope: 'global', tags: [], entities: [] },
    { id: 'M-2', status: 'active', content: '主题颜色用浅色', type: 'preference', scope: 'global', tags: [], entities: [] },
  ];
  let broken = true;
  const service = {
    async state() { return { head: 'abc', memories }; },
    async suppressed() {
      if (broken) throw new Error('runtime unavailable');
      return ['M-2'];
    },
  };

  // A new process: no prior snapshot exists, so a broken read must inject nothing.
  const restarted = createInjectionRuntime({ service, now: () => new Date('2026-10-29T01:00:00Z') });
  await restarted.refresh();
  assert.deepEqual(restarted.snapshot.memories, []);
  assert.equal(restarted.snapshot.degraded, 'suppression-unavailable');

  // Once the runtime is readable again the filter is rebuilt from the ledger,
  // not from the empty degraded snapshot.
  broken = false;
  await restarted.refresh();
  assert.deepEqual(restarted.snapshot.memories.map((entry) => entry.id), ['M-1']);
  assert.equal(restarted.snapshot.degraded, undefined);
  assert.ok(restarted.buildText(undefined).text.includes('pnpm'));
  assert.ok(!restarted.buildText(undefined).text.includes('浅色'));
});

test('recovery after an in-process outage returns to live filtering, not the stale snapshot', async () => {
  const memories = [
    { id: 'M-1', status: 'active', content: '项目使用 pnpm 管理依赖', type: 'fact', scope: 'global', tags: [], entities: [] },
    { id: 'M-2', status: 'active', content: '主题颜色用浅色', type: 'preference', scope: 'global', tags: [], entities: [] },
    { id: 'M-3', status: 'active', content: '提交信息用中文', type: 'constraint', scope: 'global', tags: [], entities: [] },
  ];
  let fail = false;
  let objected = ['M-2'];
  const runtime = createInjectionRuntime({
    service: {
      async state() { return { head: 'abc', memories }; },
      async suppressed() {
        if (fail) throw new Error('runtime unavailable');
        return objected;
      },
    },
    now: () => new Date('2026-10-29T02:00:00Z'),
  });
  await runtime.refresh();
  fail = true;
  await runtime.refresh();
  assert.deepEqual(runtime.snapshot.memories.map((entry) => entry.id), ['M-1', 'M-3']);

  // The objection set changed while suppression was unreadable; recovery must
  // adopt the current set instead of pinning what it saw before the outage.
  objected = ['M-2', 'M-3'];
  fail = false;
  await runtime.refresh();
  assert.deepEqual(runtime.snapshot.memories.map((entry) => entry.id), ['M-1']);
  assert.equal(runtime.snapshot.degraded, undefined);
});

