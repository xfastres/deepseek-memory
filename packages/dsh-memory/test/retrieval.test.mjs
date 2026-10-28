import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_MEMORY_CHARS,
  clipContent,
  contentQuality,
  eligibility,
  formatInjection,
  grams,
  scoreMemory,
  selectMemories,
} from '../host/retrieval.js';

const NOW = new Date('2026-10-28T12:00:00.000Z');

function memory(overrides = {}) {
  return {
    id: 'M-1',
    status: 'active',
    content: '用户偏好简洁的回答',
    scope: 'global',
    importance: 3,
    confidence: 0.95,
    accepted_at: '2026-10-27T12:00:00.000Z',
    ...overrides,
  };
}

test('grams splits latin words and CJK bigrams without a segmenter', () => {
  assert.ok(grams('部署 memory 插件').has('memory'));
  assert.ok(grams('调用流程').has('调用'));
  assert.ok(grams('调用流程').has('用流'));
  assert.ok(grams('调用流程').has('流程'));
  assert.equal(grams('').size, 0);
});

test('a Chinese phrase recalls the memory that contains it', () => {
  const relevant = memory({ id: 'M-1', content: '合并时要保留原来的记忆内容' });
  const irrelevant = memory({ id: 'M-2', content: '用户喜欢深色主题' });
  const result = selectMemories([relevant, irrelevant], '合并会不会覆盖原来的记忆', { now: NOW });
  assert.equal(result.chosen.length, 1);
  assert.equal(result.chosen[0].memory.id, 'M-1');
  assert.match(result.chosen[0].reason, /命中/);
});

test('a pinned memory always enters, even without a lexical match', () => {
  const pinned = memory({ id: 'M-P', content: '总是用中文回答', pinned: true });
  const result = selectMemories([pinned], '完全不相关的查询', { now: NOW });
  assert.equal(result.chosen.length, 1);
  assert.match(result.chosen[0].reason, /置顶/);
});

test('ineligible memories are excluded with a reason instead of silently dropped', () => {
  const memories = [
    memory({ id: 'M-super', status: 'superseded' }),
    memory({ id: 'M-retract', status: 'retracted' }),
    memory({ id: 'M-private', sensitivity: 'private' }),
    memory({ id: 'M-other', scope: 'workspace:F:/other-project' }),
    memory({ id: 'M-expired', valid_to: '2026-10-01T00:00:00.000Z' }),
  ];
  const result = selectMemories(memories, '用户偏好简洁的回答', { now: NOW, scope: 'workspace:F:/deepseek-memory' });
  assert.equal(result.chosen.length, 0);
  const reasons = Object.fromEntries(result.excluded.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons['M-super'], 'not-active');
  assert.equal(reasons['M-retract'], 'not-active');
  assert.equal(reasons['M-private'], 'private');
  assert.equal(reasons['M-other'], 'other-scope');
  assert.equal(reasons['M-expired'], 'expired');
});

test('the same workspace scope and global scope are both eligible', () => {
  const memories = [
    memory({ id: 'M-global', content: '项目使用 pnpm' }),
    memory({ id: 'M-local', content: '项目使用 pnpm 管理依赖', scope: 'workspace:F:/deepseek-memory' }),
  ];
  const result = selectMemories(memories, 'pnpm 依赖管理', { now: NOW, scope: 'workspace:F:/deepseek-memory' });
  assert.deepEqual(result.chosen.map((entry) => entry.memory.id), ['M-local', 'M-global']);
});

test('higher scores come first and the order is deterministic', () => {
  const strong = memory({ id: 'M-strong', content: '记忆合并保留原文', importance: 5, confidence: 1 });
  const weak = memory({ id: 'M-weak', content: '记忆合并保留原文', importance: 1, confidence: 0.2, accepted_at: '2026-01-01T00:00:00.000Z' });
  const first = selectMemories([weak, strong], '记忆合并', { now: NOW });
  const second = selectMemories([weak, strong], '记忆合并', { now: NOW });
  assert.deepEqual(first.chosen.map((entry) => entry.memory.id), ['M-strong', 'M-weak']);
  assert.deepEqual(second.chosen.map((entry) => entry.memory.id), first.chosen.map((entry) => entry.memory.id));
});

test('the budget and the limit both truncate, and pinned memories bypass the budget', () => {
  const big = memory({ id: 'M-big', content: '很长的记忆'.repeat(40) });
  const pinned = memory({ id: 'M-pinned', content: '置顶内容', pinned: true });
  const result = selectMemories([pinned, big], '很长的记忆', { now: NOW, budget: 50 });
  assert.deepEqual(result.chosen.map((entry) => entry.memory.id), ['M-pinned']);
  assert.ok(result.excluded.some((entry) => entry.id === 'M-big' && entry.reason === 'over-budget'));

  const many = Array.from({ length: 5 }, (unused, index) => memory({ id: `M-${index}`, content: '共同内容' }));
  const limited = selectMemories(many, '共同内容', { now: NOW, limit: 2 });
  assert.equal(limited.chosen.length, 2);
  assert.ok(limited.excluded.some((entry) => entry.reason === 'over-limit'));
});

test('privacy is opt-in and never implied', () => {
  const secret = memory({ id: 'M-secret', content: '私密内容', sensitivity: 'private' });
  assert.equal(selectMemories([secret], '私密内容', { now: NOW }).chosen.length, 0);
  assert.equal(selectMemories([secret], '私密内容', { now: NOW, includePrivate: true }).chosen.length, 1);
});

test('an empty query keeps recency and importance signal, not lexical', () => {
  const recent = memory({ id: 'M-recent', content: '最近的决定' });
  const result = selectMemories([recent], '', { now: NOW });
  assert.equal(result.chosen.length, 1);
  assert.doesNotMatch(result.chosen[0].reason, /命中/);
});

test('the injected block is numbered, labelled and empty when nothing is chosen', () => {
  const chosen = selectMemories(
    [memory({ id: 'M-1', content: '偏好简洁' }), memory({ id: 'M-2', content: '用 pnpm', scope: 'workspace:F:/x' })],
    '偏好简洁 pnpm',
    { now: NOW, scope: 'workspace:F:/x' },
  ).chosen;
  const text = formatInjection(chosen);
  assert.match(text, /长期记忆/);
  assert.match(text, /^1\. /m);
  assert.match(text, /范围：workspace:F:\/x/);
  assert.equal(formatInjection([]), '');
});

test('eligibility answers one reason per exclusion', () => {
  assert.equal(eligibility(memory(), { now: NOW }), null);
  assert.equal(eligibility({ ...memory(), status: 'retracted' }, { now: NOW }), 'not-active');
  assert.equal(eligibility(memory({ valid_to: '2020-01-01T00:00:00.000Z' }), { now: NOW }), 'expired');
  assert.equal(eligibility(memory({ sensitivity: 'private' }), { now: NOW }), 'private');
  assert.equal(eligibility(memory({ scope: 'workspace:other' }), { now: NOW, scope: 'global' }), 'other-scope');
});

test('scoring keeps the parts so the number can be shown as a reason', () => {
  const scored = scoreMemory(memory({ content: '合并保留原文' }), '合并', { now: NOW });
  assert.ok(scored.total > 0 && scored.total <= 1);
  assert.equal(typeof scored.parts.lexical, 'number');
  assert.ok(scored.parts.hits.includes('合并'));
  assert.ok(scored.parts.recency > 0.9);
});

test('placeholder content never reaches a prompt', () => {
  assert.equal(contentQuality('快快快'), 'too-short');
  assert.equal(contentQuality('啊'), 'too-short');
  assert.equal(contentQuality('哈哈哈哈啊哈哈'), 'repetitive');
  assert.equal(contentQuality('回答要简洁'), null, 'a short real preference is fine');
  assert.equal(contentQuality('项目用 pnpm 而不是 npm'), null);
  assert.equal(contentQuality(''), 'too-short');
  assert.equal(contentQuality(null), 'too-short');
});

test('eligibility names the quality problem instead of silently dropping it', () => {
  const junk = { id: 'M-1', status: 'active', scope: 'global', content: '哈哈哈哈啊哈哈' };
  assert.equal(eligibility(junk, { now: new Date('2026-10-28T08:00:00.000Z') }), 'repetitive');
  const short = { id: 'M-2', status: 'active', scope: 'global', content: '快快快' };
  assert.equal(eligibility(short, { now: new Date('2026-10-28T08:00:00.000Z') }), 'too-short');
});

test('a long memory is clipped and still injected instead of dropped', () => {
  const long = { id: 'M-long', status: 'active', scope: 'global', type: 'instruction', content: '项目规则 '.repeat(200), accepted_at: '2026-10-28T00:00:00.000Z' };
  const result = selectMemories([long], '', { now: new Date('2026-10-28T08:00:00.000Z'), budget: 1200 });
  assert.equal(result.chosen.length, 1, 'the only real memory must reach the prompt');
  assert.equal(result.chosen[0].clipped, true);
  assert.equal(result.chosen[0].text.length, MAX_MEMORY_CHARS + '…（以下内容已截断）'.length);
  assert.match(formatInjection(result.chosen), /已截断/u, 'the cut is visible to the model');
});

test('a short memory is never marked as clipped', () => {
  const short = { id: 'M-short', status: 'active', scope: 'global', type: 'fact', content: '项目用 pnpm', accepted_at: '2026-10-28T00:00:00.000Z' };
  const result = selectMemories([short], '项目用 pnpm', { now: new Date('2026-10-28T08:00:00.000Z'), budget: 1200 });
  assert.equal(result.chosen[0].clipped, false);
  assert.equal(result.chosen[0].text, '项目用 pnpm');
});

test('clipContent says what it did', () => {
  assert.equal(clipContent('abc', 10), 'abc');
  assert.match(clipContent('abcdef', 3), /^abc…/u);
});
