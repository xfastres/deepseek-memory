import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_CONFIG,
  loadConfig,
  normaliseConfig,
  resolveConstraints,
} from '../host/constraints.js';
import {
  condense,
  normaliseForDigest,
  protectiveReason,
  sourceDigestOf,
} from '../host/condense.js';

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

function configWith(items, extra = {}) {
  return normaliseConfig({
    version: 1,
    budget: 800,
    constraints: { budget: 240, maxChars: 120, maxItems: 2, items },
    ...extra,
  }).config;
}

function item(memoryValue, extra = {}) {
  return {
    memoryId: memoryValue.id,
    digest: '精简后的常驻约束内容',
    sourceDigest: sourceDigestOf(memoryValue.content),
    method: 'deterministic-v1',
    ...extra,
  };
}

// ---------------------------------------------------------------- digest rules

test('the fingerprint ignores formatting noise only', () => {
  assert.equal(normaliseForDigest('a\r\nb'), 'a\nb', 'CRLF becomes LF');
  assert.equal(normaliseForDigest('a  \nb\t\n'), 'a\nb', 'line-end whitespace is trimmed');
  assert.equal(normaliseForDigest('\n  文本  \n'), '文本', 'outer whitespace is trimmed');
  assert.equal(normaliseForDigest('a  b'), 'a  b', 'inner whitespace is NOT folded');
  assert.notEqual(normaliseForDigest('a  b'), normaliseForDigest('a b'), 'inner spacing still matters');
  assert.equal(normaliseForDigest('e\u0301'), normaliseForDigest('\u00e9'), 'NFC unifies composed and decomposed forms');
});

test('the same content always produces the same full fingerprint', () => {
  const digest = sourceDigestOf('项目用 pnpm');
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u, 'full SHA-256 with prefix');
  assert.equal(sourceDigestOf('项目用 pnpm'), digest);
  assert.equal(sourceDigestOf('项目用 pnpm  '), digest, 'trailing space is not a change');
  assert.equal(sourceDigestOf('项目用 pnpm\r\n'), digest, 'line ending is not a change');
  assert.notEqual(sourceDigestOf('项目用 pnpm 管理'), digest, 'a material change changes the digest');
});

// ------------------------------------------------------------- configuration

test('a missing configuration file means the documented defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-config-'));
  try {
    const loaded = loadConfig(dir);
    assert.equal(loaded.loaded, false);
    assert.deepEqual(loaded.fallback, ['missing-file']);
    assert.deepEqual(loaded.config, normaliseConfig(null).config);
    assert.equal(loaded.config.budget, DEFAULT_CONFIG.budget);
    assert.equal(loaded.config.constraints.budget, DEFAULT_CONFIG.constraints.budget);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt configuration file is reported, not thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-config-'));
  try {
    await writeFile(join(dir, 'injection.json'), '{ this is not json', 'utf8');
    const loaded = loadConfig(dir);
    assert.equal(loaded.loaded, false);
    assert.deepEqual(loaded.fallback, ['unreadable-file']);
    assert.equal(loaded.config.budget, DEFAULT_CONFIG.budget);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('out-of-range values fall back with a named reason each', () => {
  const { config, fallback } = normaliseConfig({
    version: 7,
    budget: 12,
    constraints: { budget: 9999, maxChars: 3, maxItems: 99, items: [] },
  });
  assert.equal(config.budget, DEFAULT_CONFIG.budget);
  assert.equal(config.constraints.budget, DEFAULT_CONFIG.constraints.budget);
  assert.equal(config.constraints.maxChars, DEFAULT_CONFIG.constraints.maxChars);
  assert.equal(config.constraints.maxItems, DEFAULT_CONFIG.constraints.maxItems);
  assert.deepEqual(fallback.sort(), ['budget', 'constraints.budget', 'constraints.maxChars', 'constraints.maxItems', 'version']);
});

test('a usable configuration is parsed without fallbacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-config-'));
  try {
    const rule = memory('M-rule', '先理解，再设计，再实现。');
    const payload = {
      version: 1,
      budget: 900,
      constraints: { budget: 200, maxChars: 100, maxItems: 1, items: [item(rule, { digest: '先理解再设计' })] },
    };
    await writeFile(join(dir, 'injection.json'), JSON.stringify(payload), 'utf8');
    const loaded = loadConfig(dir);
    assert.equal(loaded.loaded, true);
    assert.deepEqual(loaded.fallback, []);
    assert.equal(loaded.config.budget, 900);
    assert.equal(loaded.config.constraints.items.length, 1);
    assert.equal(loaded.config.constraints.items[0].memoryId, 'M-rule');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed item is dropped with a reason instead of breaking the file', () => {
  const { config, fallback } = normaliseConfig({
    version: 1,
    constraints: { items: [null, { memoryId: '  ' }, { memoryId: 'M-ok', digest: 'x' }] },
  });
  assert.equal(config.constraints.items.length, 1);
  assert.equal(config.constraints.items[0].memoryId, 'M-ok');
  assert.ok(fallback.includes('constraints.items[0]'));
  assert.ok(fallback.includes('constraints.items[1].memoryId'));
});

// ------------------------------------------------------------ constraint gate

test('a verifiable constraint is usable', () => {
  const rule = memory('M-rule', '先理解，再设计，再实现。');
  const result = resolveConstraints({ config: configWith([item(rule)]), memories: [rule], now: NOW() });
  assert.equal(result.usable.length, 1);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.usable[0].charsOriginal, rule.content.length);
});

test('every rejection has a name', () => {
  const active = memory('M-ok', '先理解，再设计，再实现。');
  const gone = memory('M-gone', '已经撤回的约定', { status: 'retracted' });
  const expired = memory('M-old', '已经过期的约定', { valid_to: '2026-01-01T00:00:00.000Z' });
  const otherScope = memory('M-scope', '属于别的项目的约定', { scope: 'workspace:F:/other' });
  const config = configWith([
    { memoryId: 'M-missing', digest: '摘要', sourceDigest: sourceDigestOf('x') },
    item(gone),
    item(expired),
    item(otherScope),
    item(active, { digest: '' }),
    item(active, { digest: 'X'.repeat(121) }),
    item(active, { sourceDigest: '' }),
    item(active, { sourceDigest: sourceDigestOf('别的内容') }),
    item(active),
  ]);
  const result = resolveConstraints({ config, memories: [active, gone, expired, otherScope], now: NOW() });
  const reasons = result.rejected.map((entry) => `${entry.memoryId}:${entry.reason}`).sort();
  assert.deepEqual(reasons, [
    'M-gone:not-active',
    'M-missing:not-found',
    'M-ok:digest-empty',
    'M-ok:digest-stale',
    'M-ok:digest-too-long',
    'M-ok:digest-unverified',
    'M-old:expired',
    'M-scope:other-scope',
  ]);
  assert.equal(result.usable.length, 1, 'only the fully verifiable item survives');
});

// ---------------------------------------------------------------- condensing

test('a condensed summary keeps every sentence that carries a rule', () => {
  const content = [
    '先理解现有实现，再提出方案。',
    '如果缺少关键信息，必须明确指出，不要用猜测填补。',
    '除非用户确认，否则不得扩大范围。',
    '除了明确列出的内容，其余一律删除。',
    '只有测试通过才能进入下一步。',
    '项目使用 pnpm 管理依赖。',
    '会议记录归档在共享盘。',
  ].join('');
  const result = condense({ content }, { maxChars: 200 });
  assert.equal(result.ok, true);
  const kept = result.text;
  for (const fragment of ['先理解', '如果缺少', '除非用户确认', '除了明确列出', '只有测试通过']) {
    assert.ok(kept.includes(fragment), `protected fragment must survive: ${fragment}`);
  }
  assert.equal(result.sourceDigest, sourceDigestOf(content));
  assert.ok(result.text.length <= 200);
});

test('a sentence with no protective marker is the one that gets dropped', () => {
  const content = '项目使用 pnpm 管理依赖。会议记录归档在共享盘。只有测试通过才能进入下一步。';
  const result = condense({ content }, { maxChars: 30 });
  assert.equal(result.ok, true);
  assert.ok(result.text.includes('只有测试通过'), 'the precondition survives');
  assert.ok(result.dropped.length > 0, 'what was left out is reported');
  assert.ok(result.dropped.every((entry) => typeof entry.reason === 'string' && entry.reason !== ''));
  assert.ok(result.dropped.some((entry) => entry.reason === 'over-capacity'));
});

test('a protected sentence that cannot fit is refused, never truncated', () => {
  const content = '除非用户明确确认，否则不得擅自扩大本次任务的范围，也不得提前实现未来的功能。';
  const result = condense({ content }, { maxChars: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'protected-sentence-too-long');
  assert.equal(result.text, '');
  assert.ok(result.dropped.length >= 1);
});

test('an empty memory cannot be condensed into a summary', () => {
  const result = condense({ content: '   ' }, { maxChars: 120 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'empty-content');
});

test('protective marking is visible for each rule kind', () => {
  assert.equal(protectiveReason('不要虚构结果'), '不');
  assert.equal(protectiveReason('如果缺少信息就停下来'), '如果');
  assert.equal(protectiveReason('先调查现状'), '先');
  assert.ok(protectiveReason('除明确列出的以外都删除') !== null, 'an exception clause is protective');
  assert.equal(protectiveReason('必须提供证据'), '必须');
  assert.equal(protectiveReason('会议记录归档在共享盘'), null);
});

test('a condensed summary is itself a valid short digest', () => {
  const content = '先理解，再设计，再实现。每次只推进一个明确目标。';
  const result = condense({ content }, { maxChars: 120 });
  assert.equal(result.ok, true);
  assert.ok(result.text.length <= 120);
  assert.equal(result.method, 'deterministic-v1', 'the method is named, and it is a heuristic');
  assert.equal(result.sourceDigest, sourceDigestOf(`${content} `), 'trailing spaces are not a change');
});
