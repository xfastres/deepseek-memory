import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply } from '../index.js';
import { normaliseConfig, resolveConstraints } from '../host/constraints.js';
import { condense, sourceDigestOf } from '../host/condense.js';
import { createMemoryApp } from '../host/http-app.js';

const NOW = () => new Date('2026-10-28T08:00:00.000Z');

function memory(id, content, extra = {}) {
  return { id, status: 'active', scope: 'global', type: 'fact', content, accepted_at: '2026-10-20T00:00:00.000Z', ...extra };
}

function makeRequest({ method = 'GET', headers = {}, url } = {}) {
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:59973', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:59973', ...headers },
    async *[Symbol.asyncIterator]() {},
  };
}

function makeResponse() {
  const captured = { status: 0, body: '' };
  return { captured, writeHead(status) { captured.status = status; }, end(body) { captured.body = body ?? ''; } };
}

/**
 * The real plugin, wired to stand-in host services.
 *
 * This is not a real DSH process: it exercises the exact registration contract
 * (webServer.register / systemPrompt.context / agent/pre-step / tools.register)
 * against an isolated data directory, so a wiring mistake shows up here even
 * though the host itself cannot be started from a test.
 */
async function withPlugin(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-wiring-'));
  const previous = process.env.DSH_MEMORY_DATA_DIR;
  process.env.DSH_MEMORY_DATA_DIR = dir;
  const captured = { routes: [], tools: [], providers: [], listeners: new Map() };
  const services = {
    webServer: { register(route) { captured.routes.push(route); return () => {}; } },
    tools: { register(definition) { captured.tools.push(definition); return () => {}; } },
    systemPrompt: { context(config) { captured.providers.push(config); return () => {}; } },
    sessionQuery: {
      async listEvents() { return []; },
      async readEvent() { return { target: { data: {} } }; },
      async listSessions() { return []; },
    },
  };
  const ctx = {
    get: (name) => services[name],
    effect: (fn) => { fn(); return () => {}; },
    on: (event, handler) => { captured.listeners.set(event, handler); return () => {}; },
  };
  try {
    apply(ctx);
    return await run({ dir, captured, services });
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_DATA_DIR;
    else process.env.DSH_MEMORY_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const PRE_STEP = 'agent/pre-step';
const STEP_PAYLOAD = {
  agent: { id: 'session-wiring-1' },
  turn: 5,
  step: 1,
  messages: [{ role: 'user', content: 'pnpm 依赖怎么安装' }],
  signal: undefined,
};

function runPreStep(captured) {
  const listener = captured.listeners.get(PRE_STEP);
  assert.equal(typeof listener, 'function', 'the plugin listens to the step boundary');
  return listener.call(undefined, STEP_PAYLOAD, () => Promise.resolve({ kind: 'enter', messages: STEP_PAYLOAD.messages }));
}

test('the plugin registers the step hook, the tool and the routes', async () => {
  await withPlugin(async ({ captured }) => {
    await runPreStep(captured);
    assert.equal(captured.listeners.has(PRE_STEP), true);
    assert.ok(captured.routes.some((route) => route.path === '/api/dsh-memory/injections'));
    assert.ok(captured.tools.some((definition) => definition.name === 'dsh_memory_ping'));
    // No active memory means no prompt provider: registering one would only add
    // a per-step call that always returns "". The reason must be visible.
    const tool = captured.tools.find((definition) => definition.name === 'dsh_memory_ping');
    const value = await tool.execute();
    assert.equal(value.injection.context.skipped, 'no-active-memory');
    assert.equal(value.injection.context.registered, false);
  });
});

test('with no active memory no context is contributed and no record is invented', async () => {
  await withPlugin(async ({ dir, captured }) => {
    await runPreStep(captured);
    assert.equal(captured.providers.length, 0, 'nothing is registered to contribute an empty block');
    assert.equal(existsSync(join(dir, 'runtime.json')), false, 'no injection record is invented');
  });
});

test('the diagnostic snapshot reports a missing configuration without crashing', async () => {
  await withPlugin(async ({ captured }) => {
    await runPreStep(captured);
    const tool = captured.tools.find((definition) => definition.name === 'dsh_memory_ping');
    const value = await tool.execute();
    assert.equal(value.ok, true);
    assert.equal(value.injection.constraints.loaded, false);
    assert.deepEqual(value.injection.constraints.fallback, ['missing-file']);
    assert.equal(value.injection.constraints.usable, 0);
    assert.equal(typeof value.injection.flush.ok === 'boolean' || value.injection.flush.ok === null, true);
  });
});

test('a configured constraint for a non-existent memory is reported, not injected', async () => {
  await withPlugin(async ({ dir, captured }) => {
    const config = {
      version: 1,
      budget: 800,
      constraints: {
        budget: 240,
        maxChars: 120,
        maxItems: 2,
        items: [{ memoryId: 'M-missing', digest: '摘要', sourceDigest: sourceDigestOf('原文'), method: 'manual' }],
      },
    };
    await writeFile(join(dir, 'injection.json'), JSON.stringify(config), 'utf8');
    await runPreStep(captured);
    const tool = captured.tools.find((definition) => definition.name === 'dsh_memory_ping');
    const value = await tool.execute();
    assert.equal(value.injection.constraints.loaded, true);
    assert.equal(value.injection.constraints.usable, 0);
    assert.equal(value.injection.constraints.rejected[0].reason, 'not-found');
  });
});

test('the read-only route answers from the real store with an empty list', async () => {
  await withPlugin(async ({ captured }) => {
    await runPreStep(captured);
    const route = captured.routes.find((entry) => entry.path === '/api/dsh-memory/injections');
    const res = makeResponse();
    await route.handler(makeRequest({ url: '/api/dsh-memory/injections?limit=5' }), res);
    assert.equal(res.captured.status, 200);
    const body = JSON.parse(res.captured.body);
    assert.equal(body.ok, true);
    assert.equal(body.count, 0);
    assert.deepEqual(body.injections, []);
  });
});

// ------------------------------------------------------------------ durability

test('concurrent injection writes do not lose updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-concurrent-'));
  try {
    const app = createMemoryApp({ dataDir: dir, now: NOW });
    const writes = Array.from({ length: 20 }, (_, index) => app.runtime.recordInjection({
      sessionId: 's1',
      turn: index + 1,
      memoryIds: [`M-${index}`],
      chars: index,
      key: `sha256:${String(index).padStart(4, '0')}`,
    }));
    const results = await Promise.allSettled(writes);
    const failed = results.filter((entry) => entry.status === 'rejected');
    assert.deepEqual(failed.map((entry) => String(entry.reason && entry.reason.message)), [], 'no write may fail');
    const list = await app.runtime.listInjections({ limit: 100 });
    assert.equal(list.length, 20, 'every write survives: read-modify-write is serialised');
    assert.equal(new Set(list.map((entry) => entry.turn)).size, 20);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a legacy runtime file keeps working and keeps its shape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-legacy-'));
  try {
    const app = createMemoryApp({ dataDir: dir, now: NOW });
    // Ask the store where it keeps its file instead of assuming the layout.
    await app.runtime.recordInjection({ sessionId: 'seed', turn: 0, memoryIds: [], chars: 0 });
    const entries = await readdir(dir, { recursive: true });
    const found = entries.map(String).find((entry) => entry.endsWith('runtime.json'));
    assert.ok(found !== undefined, 'the store has a runtime file');
    const file = join(dir, found);
    await writeFile(file, JSON.stringify({
      version: 1,
      candidates: [],
      injections: [{ at: '2026-10-27T00:00:00.000Z', session_id: 'old', turn: 1, memory_ids: ['M-1'], reasons: [], chars: 3 }],
    }), 'utf8');
    const list = await app.runtime.listInjections({ limit: 10 });
    assert.equal(list.length, 1, 'a legacy entry is still readable');
    assert.equal(list[0].key ?? null, null, 'an absent field stays absent');
    assert.equal(list[0].state ?? 'returned', 'returned');
    await app.runtime.recordInjection({ sessionId: 'new', turn: 2, memoryIds: ['M-2'], chars: 5 });
    const after = await app.runtime.listInjections({ limit: 10 });
    assert.equal(after.length, 2, 'new entries append without destroying old ones');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(Array.isArray(raw.injections));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- summary safety boundary

test('a long multi-rule memory is refused at every practical cap instead of being cut', () => {
  const rules = [
    '先理解现有实现，再提出方案，不要跳过调查。',
    '如果缺少关键信息，必须明确指出，不要用猜测填补。',
    '除非用户确认，否则不得扩大范围。',
    '除了明确列出的内容，其余一律删除。',
    '只有测试通过才能进入下一步。',
    '每次只推进一个明确目标。',
    '不得虚构文件、接口、依赖关系或运行结果。',
    '如果需要修改账本结构，必须先询问并取得批准。',
    '不要为了赶进度而实现未来的功能。',
    '发生失败时先报告原因，再修改实现。',
  ].join('');
  for (const cap of [120, 240, 400, 600]) {
    const result = condense({ content: rules }, { maxChars: cap });
    if (result.ok) {
      // If it ever succeeds, it must still keep every protected sentence.
      for (const rule of rules.split(/(?<=[。])/u).filter(Boolean)) {
        if (rule.includes('不') || rule.includes('先') || rule.includes('必须') || rule.includes('只有') || rule.includes('如果') || rule.includes('除非') || rule.includes('之外') || rule.includes('除了')) {
          assert.ok(result.text.includes(rule.slice(0, 6)), `protected rule dropped at cap ${cap}`);
        }
      }
    } else {
      assert.equal(result.text, '', `a refusal at cap ${cap} must not return partial text`);
      assert.ok(['protected-sentence-too-long', 'cannot-fit'].includes(result.reason), `unexpected reason at cap ${cap}: ${result.reason}`);
    }
  }
});

test('a manual digest is accepted when it matches the source fingerprint and rejected when it drifts', () => {
  const rule = memory('M-manual', '回答先给结论，再给依据。不要堆术语。');
  const config = normaliseConfig({
    version: 1,
    budget: 800,
    constraints: {
      budget: 240,
      maxChars: 120,
      maxItems: 2,
      items: [{ memoryId: 'M-manual', digest: '先结论后依据，不用术语。', sourceDigest: sourceDigestOf(rule.content), method: 'manual' }],
    },
  }).config;
  const ok = resolveConstraints({ config, memories: [rule], now: NOW() });
  assert.equal(ok.usable.length, 1, 'a human-written digest is legitimate input');
  assert.equal(ok.usable[0].digest, '先结论后依据，不用术语。');

  const changed = memory('M-manual', '回答先给结论，再给依据。不要堆术语。补充一条。');
  const stale = resolveConstraints({ config, memories: [changed], now: NOW() });
  assert.equal(stale.usable.length, 0);
  assert.equal(stale.rejected[0].reason, 'digest-stale', 'a changed source invalidates the digest');
});

test('the configured total budget wins over the built-in default', async () => {
  const rule = memory('M-rule', '先理解，再设计，再实现。每轮只推进一个目标。', { type: 'instruction' });
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-budget-'));
  try {
    const runtime = (await import('../host/injection.js')).createInjectionRuntime({
      service: { async state() { return { head: 'b'.repeat(40), memories: [rule] }; } },
      now: NOW,
    });
    await runtime.refresh();
    runtime.setConstraints({
      loaded: true,
      fallback: [],
      usable: [{ memory: rule, digest: '先理解再设计再实现。', method: 'deterministic-v1' }],
      rejected: [],
      config: { version: 1, budget: 90, constraints: { budget: 40, maxChars: 120, maxItems: 2, items: [] } },
    });
    runtime.observe({ name: 'scope' }, { agent: { id: 's1' }, turn: 1, messages: [] });
    const built = runtime.buildText({ name: 'scope' });
    assert.equal(built.budget, 90, 'the file value is used when the caller passes nothing');
    assert.ok(built.text.length <= 90);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
