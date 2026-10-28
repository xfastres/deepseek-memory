import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSearchTool } from '../index.js';
import { searchMemories } from '../host/search.js';

const REF = { session_id: 's1', event_seq: 2, event_type: 'user/message' };

function memory(over = {}) {
  return {
    id: 'M-1',
    status: 'active',
    content: '项目使用 pnpm 管理依赖',
    type: 'fact',
    scope: 'global',
    version: 1,
    source_refs: [REF],
    confidence: 0.9,
    importance: 3,
    ...over,
  };
}

test('search returns matching active memories with their evidence', () => {
  const found = searchMemories([memory()], 'pnpm');
  assert.equal(found.reason, null);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].id, 'M-1');
  assert.equal(found.results[0].type, 'fact');
  assert.equal(found.results[0].version, 1);
  assert.deepEqual(found.results[0].evidence, [REF], 'a proposal can cite what the search found');
  assert.ok(found.results[0].score > 0);
  assert.ok(found.results[0].hits.includes('pnpm'));
});

test('search hides everything the injector would not use', () => {
  const memories = [
    memory({ id: 'M-active' }),
    memory({ id: 'M-retracted', status: 'retracted' }),
    memory({ id: 'M-superseded', status: 'superseded' }),
    memory({ id: 'M-expired', valid_to: '2020-01-01T00:00:00.000Z' }),
    memory({ id: 'M-private', sensitivity: 'private' }),
    memory({ id: 'M-other-scope', scope: 'project:other' }),
    memory({ id: 'M-short', content: 'pn' }),
  ];
  const found = searchMemories(memories, 'pnpm', { now: new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(found.results.map((row) => row.id), ['M-active']);
  assert.equal(found.hidden, 6, 'every excluded row is counted, not silently dropped');
});

test('an objected memory is not searchable', () => {
  const found = searchMemories([memory()], 'pnpm', { suppressedIds: ['M-1'] });
  assert.deepEqual(found.results, []);
  assert.equal(found.hidden, 1);
});

test('search needs a query and never ranks on recency alone', () => {
  const empty = searchMemories([memory()], '   ');
  assert.deepEqual(empty.results, []);
  assert.equal(empty.reason, 'empty-query');
  const unrelated = searchMemories([memory()], '无关的查询词');
  assert.deepEqual(unrelated.results, [], 'a fresh memory that does not mention the words is not a hit');
});

test('search ranks by the query, filters by type, and honours the limit', () => {
  const memories = [
    memory({ id: 'M-1', content: '项目使用 pnpm 管理依赖' }),
    memory({ id: 'M-2', content: 'pnpm 的锁文件要提交' }),
    memory({ id: 'M-3', content: '用户偏好中文回答', type: 'preference' }),
  ];
  const ranked = searchMemories(memories, 'pnpm');
  assert.equal(ranked.results[0].id, 'M-1', 'the better lexical match comes first');
  const filtered = searchMemories(memories, '中文', { type: 'preference' });
  assert.deepEqual(filtered.results.map((row) => row.id), ['M-3'], 'the type filter still needs a lexical match');
  const limited = searchMemories(memories, 'pnpm', { limit: 1 });
  assert.equal(limited.results.length, 1);
  assert.equal(searchMemories(memories, 'pnpm', { limit: 999 }).results.length <= 20, true);
});

test('the tool reads through the Host and refuses when it cannot know what to hide', async () => {
  const calls = [];
  const app = {
    service: { async state() { return { memories: [memory()] }; } },
    runtime: { async suppressedIds() { return ['M-hidden']; } },
  };
  const tool = createSearchTool({ getApp: async () => app });
  assert.equal(tool.name, 'memory_search');
  assert.deepEqual(tool.parameters.required, ['query']);
  const value = await tool.execute({ query: 'pnpm' });
  assert.equal(value.ok, true);
  assert.equal(value.results[0].id, 'M-1');
  calls.push(value);
  const blocks = tool.output.render({}, value);
  assert.equal(blocks[0].type, 'text');

  const unavailable = createSearchTool({ getApp: async () => null });
  assert.deepEqual(await unavailable.execute({ query: 'pnpm' }), { ok: false, error: 'host-unavailable' });

  const noSuppression = createSearchTool({ getApp: async () => ({ service: app.service, runtime: { async suppressedIds() { throw new Error('boom'); } } }) });
  assert.deepEqual(await noSuppression.execute({ query: 'pnpm' }), { ok: false, error: 'suppressed-unavailable' }, 'a failing objection lookup never widens the search');

  const brokenState = createSearchTool({ getApp: async () => ({ service: { async state() { throw new Error('boom'); } }, runtime: app.runtime }) });
  assert.deepEqual(await brokenState.execute({ query: 'pnpm' }), { ok: false, error: 'search-failed' });
});
