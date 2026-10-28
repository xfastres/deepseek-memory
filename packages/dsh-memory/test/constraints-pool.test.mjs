import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_CONSTRAINT_BUDGET,
  DEFAULT_CONSTRAINT_MAX_CHARS,
  DEFAULT_CONSTRAINT_MAX_ITEMS,
  selectMemories,
} from '../host/retrieval.js';

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

function constraint(memoryValue, digest, extra = {}) {
  return { memory: memoryValue, digest, ...extra };
}

const RULE = memory('M-rule', 'AI 协作规则：先理解，再设计，再实现。每次只推进一个明确目标。', { type: 'instruction' });
const RULE_DIGEST = '先理解再设计再实现：每次只推进一个可验证的目标。';

test('omitting constraints keeps the previous behaviour exactly', () => {
  const corpus = [
    memory('M-a', '项目用 pnpm 作为包管理器'),
    memory('M-b', '会议纪要归档在共享盘'),
  ];
  const withoutOption = selectMemories(corpus, 'pnpm 怎么装', { now: NOW() });
  const withEmptyList = selectMemories(corpus, 'pnpm 怎么装', { now: NOW(), constraints: [] });
  assert.deepEqual(withEmptyList.chosen.map((entry) => entry.memory.id), withoutOption.chosen.map((entry) => entry.memory.id));
  assert.equal(withEmptyList.used, withoutOption.used);
  assert.equal(withEmptyList.pools.constraint.used, 0);
  assert.equal(withEmptyList.pools.dynamic.budget, withoutOption.budget);
});

test('a constraint is chosen even when the query shares no words with it', () => {
  const corpus = [memory('M-a', '项目用 pnpm 作为包管理器')];
  const result = selectMemories(corpus, '完全不相关的提问', {
    now: NOW(),
    constraints: [constraint(RULE, RULE_DIGEST)],
  });
  const ids = result.chosen.map((entry) => entry.memory.id);
  assert.ok(ids.includes('M-rule'), 'the constraint bypasses the lexical gate');
  assert.ok(!ids.includes('M-a'), 'ordinary memories still need a lexical match');
  const rule = result.chosen.find((entry) => entry.memory.id === 'M-rule');
  assert.equal(rule.kind, 'constraint');
  assert.equal(rule.text, RULE_DIGEST, 'the digest is injected, never the full content');
  assert.equal(rule.chars_used, RULE_DIGEST.length);
  assert.equal(rule.chars_original, RULE.content.length);
});

test('an invalid or retracted or expired constraint never enters the result', () => {
  const retracted = memory('M-gone', '这条已经撤回的约定', { status: 'retracted' });
  const expired = memory('M-old', '这条已经过期的约定', { valid_to: '2026-01-01T00:00:00.000Z' });
  const tiny = memory('M-tiny', '快快快');
  const result = selectMemories([], '任意问题', {
    now: NOW(),
    constraints: [
      constraint(retracted, '摘要一'),
      constraint(expired, '摘要二'),
      constraint(tiny, '摘要三'),
      constraint(RULE, RULE_DIGEST),
    ],
  });
  const ids = result.chosen.map((entry) => entry.memory.id);
  assert.deepEqual(ids, ['M-rule'], 'only the valid constraint survives');
  const reasons = result.excluded.map((entry) => `${entry.id}:${entry.reason}`);
  assert.ok(reasons.includes('M-gone:not-active'));
  assert.ok(reasons.includes('M-old:expired'));
  assert.ok(reasons.includes('M-tiny:too-short'), 'quality checks apply to constraints too');
});

test('the constraint pool stops at its own budget instead of borrowing', () => {
  const first = memory('M-c1', '第一条基础约束的完整原文，足够长');
  const second = memory('M-c2', '第二条基础约束的完整原文，足够长');
  const digestA = 'A'.repeat(100);
  const digestB = 'B'.repeat(100);
  const result = selectMemories([], '任意问题', {
    now: NOW(),
    constraintBudget: 150,
    constraints: [constraint(first, digestA), constraint(second, digestB)],
  });
  assert.equal(result.chosen.length, 1);
  assert.equal(result.chosen[0].memory.id, 'M-c1');
  assert.deepEqual(
    result.excluded.map((entry) => `${entry.id}:${entry.reason}`),
    ['M-c2:over-constraint-budget'],
  );
  assert.equal(result.pools.constraint.used, 100);
  assert.equal(result.pools.constraint.budget, 150);
});

test('the constraint item count is capped independently of the ordinary limit', () => {
  const items = Array.from({ length: 4 }, (_, index) => constraint(memory(`M-c${index}`, `第 ${index} 条基础约束的原文，足够长`), `摘要${index}`));
  const result = selectMemories([], '', {
    now: NOW(),
    limit: 10,
    constraints: items,
  });
  assert.equal(result.chosen.length, DEFAULT_CONSTRAINT_MAX_ITEMS);
  assert.ok(result.excluded.some((entry) => entry.reason === 'over-constraint-limit'));
});

test('a digest longer than the per-item cap is refused, never truncated', () => {
  const tooLong = 'X'.repeat(DEFAULT_CONSTRAINT_MAX_CHARS + 1);
  const exact = 'Y'.repeat(DEFAULT_CONSTRAINT_MAX_CHARS);
  const result = selectMemories([], '', {
    now: NOW(),
    constraints: [
      constraint(memory('M-long', '超长摘要对应的原文，足够长'), tooLong),
      constraint(memory('M-exact', '恰好上限的摘要原文，足够长'), exact),
    ],
  });
  assert.deepEqual(result.chosen.map((entry) => entry.memory.id), ['M-exact']);
  assert.ok(result.excluded.some((entry) => entry.id === 'M-long' && entry.reason === 'digest-too-long'));
  assert.equal(result.chosen[0].text.length, DEFAULT_CONSTRAINT_MAX_CHARS, 'the accepted digest is untouched');
});

test('an empty digest is refused rather than injected as nothing', () => {
  const result = selectMemories([], '', {
    now: NOW(),
    constraints: [constraint(RULE, '   ')],
  });
  assert.equal(result.chosen.length, 0);
  assert.ok(result.excluded.some((entry) => entry.reason === 'digest-empty'));
});

test('both pools obey the total budget together', () => {
  const big = memory('M-big', `项目用 pnpm 管理依赖。${'补充说明。'.repeat(60)}`);
  const result = selectMemories([big], 'pnpm 依赖', {
    now: NOW(),
    budget: 300,
    constraintBudget: 240,
    constraints: [constraint(RULE, 'Z'.repeat(120))],
  });
  assert.equal(result.pools.constraint.used, 120);
  assert.equal(result.pools.dynamic.budget, 180, 'ordinary memories only see what is left');
  assert.ok(result.used <= 300, 'the total is never exceeded');
  assert.ok(result.excluded.some((entry) => entry.id === 'M-big' && entry.reason === 'over-budget'));
});

test('constraint usage is subtracted before the ordinary pool spends', () => {
  const small = memory('M-small', '项目用 pnpm 管理依赖');
  const second = memory('M-rule-2', '第二条常驻约定：先看现状再提方案，不虚构结果。', { type: 'instruction' });
  const result = selectMemories([small], 'pnpm 依赖', {
    now: NOW(),
    budget: 800,
    constraints: [constraint(RULE, 'Z'.repeat(120)), constraint(second, 'Y'.repeat(120))],
  });
  assert.equal(result.pools.constraint.used, 240);
  assert.equal(result.pools.dynamic.used, small.content.length);
  assert.equal(result.used, 240 + small.content.length);
  assert.equal(result.pools.dynamic.budget, 800 - 240);
});

test('a long ordinary memory is still clipped, not dropped', () => {
  const long = memory('M-long', `pnpm 依赖说明。${'详细内容。'.repeat(200)}`);
  const result = selectMemories([long], 'pnpm 依赖', {
    now: NOW(),
    constraints: [constraint(RULE, RULE_DIGEST)],
  });
  assert.equal(result.chosen.length, 2);
  const entry = result.chosen.find((item) => item.memory.id === 'M-long');
  assert.equal(entry.clipped, true, 'clipping behaviour is unchanged');
  assert.equal(entry.chars_original, 1010, 'the original length is reported, not lost');
  assert.ok(entry.text.includes('…（以下内容已截断）'), 'the cut is still marked');
  assert.ok(entry.text.length <= 400 + '…（以下内容已截断）'.length);
});

test('the default constraint pool is what the constants say', () => {
  assert.equal(DEFAULT_CONSTRAINT_BUDGET, 240);
  assert.equal(DEFAULT_CONSTRAINT_MAX_CHARS, 120);
  assert.equal(DEFAULT_CONSTRAINT_MAX_ITEMS, 2);
  const result = selectMemories([], '', { now: NOW(), constraints: [constraint(RULE, RULE_DIGEST)] });
  assert.equal(result.pools.constraint.budget, DEFAULT_CONSTRAINT_BUDGET);
});
