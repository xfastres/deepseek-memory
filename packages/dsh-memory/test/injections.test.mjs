import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveConstraints } from '../host/constraints.js';
import { sourceDigestOf } from '../host/condense.js';
import { createMemoryApp } from '../host/http-app.js';
import { createInjectionRuntime } from '../host/injection.js';

const BROWSER = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:51840' };
const HEAD = 'a'.repeat(40);
const NOW = () => new Date('2026-10-28T08:00:00.000Z');

function memory(id, content, extra = {}) {
  return {
    id,
    status: 'active',
    scope: 'global',
    type: 'fact',
    content,
    accepted_at: '2026-10-20T00:00:00.000Z',
    ...extra,
  };
}

function runtimeWith(memories, head = HEAD) {
  const service = {
    async state() {
      return { head, memories };
    },
  };
  return createInjectionRuntime({ service, now: NOW });
}

function constraintState(rule, digest) {
  const loaded = { config: { version: 1, budget: 800, constraints: { budget: 240, maxChars: 120, maxItems: 2, items: [] } }, fallback: [], loaded: true };
  const resolved = resolveConstraints({
    config: {
      ...loaded.config,
      constraints: {
        ...loaded.config.constraints,
        items: [{ memoryId: rule.id, digest, sourceDigest: sourceDigestOf(rule.content), method: 'deterministic-v1' }],
      },
    },
    memories: [rule],
    now: NOW(),
  });
  return { ...loaded, ...resolved };
}

const RULE = memory('M-rule', '先理解，再设计，再实现。每次只推进一个明确目标。', { type: 'instruction' });
const RULE_DIGEST = '先理解再设计再实现：每轮只推进一个目标。';

test('the constraint digest reaches the prompt and the cost is measured on the final text', async () => {
  const runtime = runtimeWith([RULE]);
  await runtime.refresh();
  runtime.setConstraints(constraintState(RULE, RULE_DIGEST));
  runtime.observe({ name: 'scope' }, { agent: { id: 'session-1' }, turn: 3, messages: [{ role: 'user', content: '随便问一句' }] });

  const built = runtime.buildText({ name: 'scope' });
  assert.ok(built.text.includes(RULE_DIGEST), 'the digest is what reaches the prompt');
  assert.equal(built.chars, built.text.length, 'chars describe the final text, not the selection');
  assert.ok(built.chars <= built.budget, 'the final text obeys the total budget');
  assert.equal(built.chosen.length, 1);
  assert.equal(built.chosen[0].kind, 'constraint');
  assert.equal(built.dataset, undefined);
});

test('the formatted header and numbering are inside the budget', async () => {
  const longDigest = 'A'.repeat(100);
  const runtime = runtimeWith([memory('M-rule-2', '另一条常驻约定，用于验证标题开销是否计入预算。', { type: 'instruction' })]);
  await runtime.refresh();
  const second = runtime.snapshot.memories[0];
  runtime.setConstraints({
    loaded: true,
    fallback: [],
    usable: [{ memory: second, digest: longDigest, method: 'deterministic-v1' }],
    rejected: [],
    config: { version: 1, budget: 800, constraints: { budget: 400, maxChars: 120, maxItems: 2, items: [] } },
  });
  runtime.observe({ name: 'scope' }, { agent: { id: 'session-1' }, turn: 3, messages: [] });
  const built = runtime.buildText({ name: 'scope' }, { budget: 110 });
  assert.ok(built.text.length <= 110, 'header + numbering are part of the budget');
  assert.ok(built.excluded.some((entry) => entry.reason === 'over-budget-after-format'), 'the entry that did not fit is named');
});

test('two provider calls in one step keep one logical record and both counts', async () => {
  const runtime = runtimeWith([RULE]);
  await runtime.refresh();
  runtime.setConstraints(constraintState(RULE, RULE_DIGEST));
  runtime.observe({ name: 'scope' }, { agent: { id: 'session-1' }, turn: 5, messages: [] });

  const first = runtime.buildText({ name: 'scope' });
  const second = runtime.buildText({ name: 'scope' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(runtime.log.records().length, 1);
  assert.equal(runtime.log.records()[0].occurrences, 2);
  assert.equal(runtime.log.stats().calls, 2);
  assert.equal(runtime.log.stats().records, 1);
});

test('an empty store contributes no text and no record, but still counts the call', async () => {
  const runtime = runtimeWith([]);
  await runtime.refresh();
  runtime.observe({ name: 'scope' }, { agent: { id: 'session-1' }, turn: 1, messages: [] });
  const built = runtime.buildText({ name: 'scope' });
  assert.equal(built.text, '');
  assert.equal(built.record, null);
  assert.equal(runtime.log.records().length, 0);
  assert.equal(runtime.log.stats().calls, 1);
  assert.equal(runtime.log.stats().empty, 1);
});

test('confirmed stays null: the provider cannot prove delivery', async () => {
  const runtime = runtimeWith([RULE]);
  await runtime.refresh();
  runtime.setConstraints(constraintState(RULE, RULE_DIGEST));
  runtime.observe({ name: 'scope' }, { agent: { id: 'session-1' }, turn: 2, messages: [] });
  const built = runtime.buildText({ name: 'scope' });
  assert.equal(built.confirmed, null);
  assert.equal(built.record.confirmed, null);
  assert.equal(built.record.state, 'returned');
});

test('a new turn or a new snapshot produces a new identity', async () => {
  const runtime = runtimeWith([RULE]);
  await runtime.refresh();
  runtime.setConstraints(constraintState(RULE, RULE_DIGEST));
  runtime.observe({ name: 'a' }, { agent: { id: 'session-1' }, turn: 2, messages: [] });
  runtime.buildText({ name: 'a' });
  runtime.observe({ name: 'b' }, { agent: { id: 'session-1' }, turn: 3, messages: [] });
  runtime.buildText({ name: 'b' });
  assert.equal(runtime.log.records().length, 2);
  const keys = new Set(runtime.log.records().map((record) => record.key));
  assert.equal(keys.size, 2);
});

test('queued records are handed out once and can be marked flushed', async () => {
  const runtime = runtimeWith([RULE]);
  await runtime.refresh();
  runtime.setConstraints(constraintState(RULE, RULE_DIGEST));
  runtime.observe({ name: 'scope' }, { agent: { id: 'session-1' }, turn: 4, messages: [] });
  runtime.buildText({ name: 'scope' });
  const pending = runtime.pendingRecords();
  assert.equal(pending.length, 1);
  assert.equal(runtime.log.stats().pending, 1);
  runtime.markFlushed(pending.length);
  assert.deepEqual(runtime.pendingRecords(), []);
  assert.equal(runtime.log.stats().pending, 0);
});

test('a new record carries the pool split and the per-entry decision', async () => {
  const second = memory('M-plain', '项目用 pnpm 管理依赖，构建产物放在 dist 目录。');
  const runtime = runtimeWith([RULE, second]);
  await runtime.refresh();
  runtime.setConstraints(constraintState(RULE, RULE_DIGEST));
  runtime.observe({ name: 'scope' }, { agent: { id: 'session-1' }, turn: 9, messages: [{ role: 'user', content: 'pnpm 构建产物在哪' }] });
  const built = runtime.buildText({ name: 'scope' });
  assert.ok(built.text.length > 0);
  const record = runtime.pendingRecords()[0];
  assert.ok(record.pools !== null, 'the pool split is recorded');
  assert.equal(typeof record.pools.constraint.used, 'number');
  assert.equal(typeof record.pools.dynamic.used, 'number');
  assert.ok(record.pools.constraint.used <= record.pools.constraint.budget);
  assert.ok(Array.isArray(record.memories) && record.memories.length >= 1);
  for (const entry of record.memories) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(['constraint', 'memory'].includes(entry.kind));
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.length > 0, 'every entry says why it was chosen');
    assert.equal(entry.text, undefined, 'no memory body is copied into the audit record');
  }
  assert.ok(Array.isArray(record.excluded));
  assert.ok(record.reasons.every((reason) => !reason.startsWith('M-')), 'reasons are explanations, not memory ids');
});

// ------------------------------------------------------------ read-only route

const LOG = [
  { seq: 1, type: 'turn/start' },
  { seq: 2, type: 'user/message' },
  { seq: 3, type: 'turn/end' },
];

function makeRequest({ method = 'GET', headers = {}, body, url, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return {
    method,
    url,
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-injections-'));
  try {
    const sessionQuery = {
      async listEvents() { return LOG; },
      async readEvent() { return { target: { data: { turn: 1 } } }; },
    };
    const app = createMemoryApp({ dataDir: dir, sessionQuery, now: NOW });
    return await run(app, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the read-only route returns what was actually persisted', async () => {
  await withApp(async (app) => {
    await app.runtime.recordInjection({ sessionId: 's1', turn: 1, memoryIds: ['M-1'], chars: 12, key: 'sha256:aa' });
    await app.runtime.recordInjection({ sessionId: 's1', turn: 2, memoryIds: [], chars: 0 });
    const result = await call(app, '/api/dsh-memory/injections', { headers: BROWSER, url: '/api/dsh-memory/injections' });
    assert.equal(result.status, 200);
    assert.equal(result.json.count, 2);
    assert.equal(result.json.injections[0].session_id, 's1');
    assert.equal(result.json.injections[1].turn, 2);
  });
});

test('the route honours a limit and refuses a bad one', async () => {
  await withApp(async (app) => {
    for (let turn = 1; turn <= 5; turn += 1) await app.runtime.recordInjection({ turn });
    const limited = await call(app, '/api/dsh-memory/injections', { headers: BROWSER, url: '/api/dsh-memory/injections?limit=2' });
    assert.equal(limited.json.count, 2);
    assert.equal(limited.json.injections[1].turn, 5);
    const bad = await call(app, '/api/dsh-memory/injections', { headers: BROWSER, url: '/api/dsh-memory/injections?limit=abc' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'bad-limit');
  });
});

test('the route refuses a write and an untrusted caller, and works with no query string', async () => {
  await withApp(async (app) => {
    const post = await call(app, '/api/dsh-memory/injections', { method: 'POST', headers: BROWSER, url: '/api/dsh-memory/injections' });
    assert.equal(post.status, 405);
    const untrusted = await call(app, '/api/dsh-memory/injections', { headers: {}, url: '/api/dsh-memory/injections', remoteAddress: '203.0.113.9' });
    assert.equal(untrusted.status, 403);
    const bare = await call(app, '/api/dsh-memory/injections', { headers: BROWSER });
    assert.equal(bare.status, 200);
    assert.equal(bare.json.count, 0);
  });
});

test('legacy records without the new fields are still readable', async () => {
  await withApp(async (app) => {
    await app.runtime.recordInjection({ sessionId: 'old', turn: 1, memoryIds: ['M-9'], chars: 3 });
    const list = await app.runtime.listInjections({ limit: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0].key, null, 'an absent field reads as absent, not as a value');
    assert.equal(list[0].confirmed, null);
    assert.equal(list[0].state, 'returned');
  });
});
