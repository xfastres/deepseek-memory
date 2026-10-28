import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseForContext,
  createInjectionRuntime,
  messageText,
  scopeShape,
  stepQuery,
} from '../host/injection.js';

const now = () => new Date('2026-10-28T08:00:00.000Z');

function memory(id, text, extra = {}) {
  return {
    id,
    status: 'active',
    scope: 'global',
    type: 'fact',
    content: text,
    importance: 3,
    confidence: 0.9,
    accepted_at: '2026-10-20T00:00:00.000Z',
    last_change_id: 'MC-1',
    ...extra,
  };
}

function serviceOf(memories) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async state() {
      calls += 1;
      return { head: 'abc', memories };
    },
  };
}

test('message text is read from every content shape without guessing', () => {
  assert.equal(messageText({ role: 'user', content: '纯文本' }), '纯文本');
  assert.equal(messageText({ role: 'user', content: [{ type: 'text', text: '分片' }, { type: 'text', text: '文本' }] }), '分片 文本');
  assert.equal(messageText({ role: 'user', content: ['字符串片'] }), '字符串片');
  assert.equal(messageText({ role: 'user', text: '旧形状' }), '旧形状');
  assert.equal(messageText({ role: 'user' }), '');
  assert.equal(messageText(null), '');
  assert.equal(messageText(undefined), '');
});

test('only user messages become the query, and the query is bounded', () => {
  const query = stepQuery([
    { role: 'system', content: '系统提示不该进来' },
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '助手的话不该进来' },
    { role: 'user', content: '第二句' },
  ]);
  assert.equal(query, '第一句\n第二句');
  assert.ok(!query.includes('系统提示'));
  assert.ok(!query.includes('助手'));
  assert.equal(stepQuery(undefined), '');
  assert.equal(stepQuery([{ role: 'user', content: '   ' }]), '');
});

test('pinned memories survive an empty query and stay budget exempt', () => {
  const memories = [
    memory('M-pin', '用户要求所有回答用中文', { pinned: true }),
    memory('M-other', '无关的一条'),
  ];
  const chosen = chooseForContext(memories, '', { now: now(), budget: 200 });
  assert.equal(chosen.chosen[0].memory.id, 'M-pin');
  assert.equal(chosen.chosen[0].score.parts.pinned, true);
});

test('a query steers selection but never resurrects an ineligible memory', () => {
  const memories = [
    memory('M-live', '项目用 pnpm 不用 npm'),
    memory('M-dead', '项目用 npm 装依赖', { status: 'retracted' }),
    memory('M-private', '私密内容', { scope: 'private' }),
  ];
  const chosen = chooseForContext(memories, 'pnpm 依赖', { now: now() });
  assert.deepEqual(chosen.chosen.map((entry) => entry.memory.id), ['M-live']);
});

test('the snapshot is replaced on refresh, not merged', async () => {
  const service = serviceOf([memory('M-1', '第一条')]);
  const runtime = createInjectionRuntime({ service, now });
  await runtime.refresh();
  assert.equal(runtime.snapshot.memories.length, 1);

  service.state = async () => ({ head: 'def', memories: [] });
  await runtime.refresh();
  assert.equal(runtime.snapshot.memories.length, 0);
  assert.equal(runtime.snapshot.at, '2026-10-28T08:00:00.000Z');
});

test('an observed scope drives its own query', async () => {
  const service = serviceOf([
    memory('M-pnpm', '项目用 pnpm 作为包管理器'),
    memory('M-other', '会议纪要归档在共享盘'),
  ]);
  const runtime = createInjectionRuntime({ service, now });
  await runtime.refresh();

  const scopeA = { name: 'session-a' };
  runtime.observe(scopeA, { turn: 3, messages: [{ role: 'user', content: 'pnpm 怎么装' }] });
  const built = runtime.buildText(scopeA);
  assert.equal(built.path, 'scope');
  assert.deepEqual(built.chosen.map((entry) => entry.memory.id), ['M-pnpm']);
  assert.match(built.text, /pnpm/);
});

test('an unknown scope falls back to the latest observation and says so', async () => {
  const service = serviceOf([memory('M-pnpm', '项目用 pnpm 作为包管理器')]);
  const runtime = createInjectionRuntime({ service, now });
  await runtime.refresh();

  runtime.observe({ name: 'session-a' }, { turn: 1, messages: [{ role: 'user', content: 'pnpm 的问题' }] });
  const built = runtime.buildText({ name: 'session-b' });
  assert.equal(built.path, 'latest');
  assert.equal(built.observation.turn, 1);
});

test('with no observation at all the provider still offers pinned memories', async () => {
  const service = serviceOf([memory('M-pin', '始终用中文回答', { pinned: true })]);
  const runtime = createInjectionRuntime({ service, now });
  await runtime.refresh();

  const built = runtime.buildText(undefined);
  assert.equal(built.path, 'none');
  assert.deepEqual(built.chosen.map((entry) => entry.memory.id), ['M-pin']);
});

test('an empty store contributes no text at all', async () => {
  const runtime = createInjectionRuntime({ service: serviceOf([]), now });
  await runtime.refresh();
  const built = runtime.buildText(undefined);
  assert.equal(built.text, '');
  assert.deepEqual(built.chosen, []);
});

test('observation never throws, even with a hostile payload', () => {
  const runtime = createInjectionRuntime({ service: serviceOf([]), now });
  assert.doesNotThrow(() => runtime.observe(null, undefined));
  assert.doesNotThrow(() => runtime.observe({}, { messages: 'not-an-array' }));
  assert.equal(runtime.latestObservation.turn, null);
  assert.equal(runtime.latestObservation.text, '');
});

test('a service without state is refused at construction', () => {
  assert.throws(() => createInjectionRuntime({}), /state/);
  assert.throws(() => createInjectionRuntime({ service: {} }), /state/);
});

test('with two sessions seen, an unknown scope drops the query instead of guessing', async () => {
  const service = serviceOf([memory('M-pnpm', '项目用 pnpm 作为包管理器')]);
  const runtime = createInjectionRuntime({ service, now });
  await runtime.refresh();

  runtime.observe({ name: 'a' }, { agent: { id: 'session-a' }, turn: 1, messages: [{ role: 'user', content: 'pnpm 的问题' }] });
  runtime.observe({ name: 'b' }, { agent: { id: 'session-b' }, turn: 1, messages: [{ role: 'user', content: '完全不相关的话题' }] });

  const built = runtime.buildText({ name: 'c' });
  assert.equal(built.path, 'ambiguous');
  assert.equal(built.observation.text, '', 'another session query must never be borrowed');
});

test('a scope carrying the session id matches that session, not the latest', async () => {
  const service = serviceOf([
    memory('M-pnpm', '项目用 pnpm 作为包管理器'),
    memory('M-other', '会议纪要归档在共享盘'),
  ]);
  const runtime = createInjectionRuntime({ service, now });
  await runtime.refresh();

  runtime.observe({ name: 'a' }, { agent: { id: 'session-aaaa1111' }, turn: 1, messages: [{ role: 'user', content: 'pnpm 怎么装' }] });
  runtime.observe({ name: 'b' }, { agent: { id: 'session-bbbb2222' }, turn: 1, messages: [{ role: 'user', content: '会议纪要放哪' }] });

  const built = runtime.buildText({ sessionId: 'session-aaaa1111' });
  assert.equal(built.path, 'agent');
  assert.deepEqual(built.chosen.map((entry) => entry.memory.id), ['M-pnpm']);
});

test('the probe records what the step scope looked like, once', () => {
  const runtime = createInjectionRuntime({ service: serviceOf([]), now });
  runtime.observe({ id: 'session-1234567890abcdef' }, { agent: { id: 'session-abcdefghijklmnop' }, turn: 4, messages: [] });
  runtime.observe({ id: 'session-ffff' }, { agent: { id: 'session-ffff' }, turn: 5, messages: [] });
  assert.equal(runtime.agentCount, 2);
  assert.deepEqual(runtime.probe.observed.keys, ['id']);
  assert.equal(runtime.probe.agent, 'session-abcdefghijklmnop');
  assert.deepEqual(runtime.probe.observed.sessionish, ['session-1234567890abcdef']);
});

test('scopeShape never throws on hostile objects', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'id', { get() { throw new Error('nope'); } });
  const shape = scopeShape(hostile);
  assert.equal(shape.type, 'object');
  assert.deepEqual(shape.sessionish, []);
  assert.equal(scopeShape(undefined).type, 'undefined');
  assert.equal(scopeShape('text').type, 'string');
});
