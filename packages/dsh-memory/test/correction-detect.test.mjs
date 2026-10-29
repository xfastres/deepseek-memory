import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyCorrection, correctionKinds, evaluateCorrection, isCorrectionCandidate } from '../host/correction-detect.js';
import { createRuntimeStore } from '../host/runtime-store.js';
import { searchMemories } from '../host/search.js';

const REF = { session_id: 's1', event_seq: 2, event_type: 'user/message' };

function memory(over = {}) {
  return {
    id: 'M-1',
    status: 'active',
    content: '项目使用 pnpm 管理依赖',
    type: 'fact',
    scope: 'global',
    tags: [],
    entities: ['pnpm'],
    ...over,
  };
}

test('only a correction aimed at a memory counts as one', () => {
  assert.deepEqual(correctionKinds('这条记忆错了'), ['incorrect']);
  assert.deepEqual(correctionKinds('那条记忆已经过时了'), ['outdated']);
  assert.deepEqual(correctionKinds('删掉这条记忆'), ['delete_request']);
  assert.deepEqual(correctionKinds('这个范围太宽泛了'), ['too_broad']);
  assert.deepEqual(correctionKinds('the memory is outdated'), ['outdated']);
  assert.deepEqual(correctionKinds('delete that memory'), ['delete_request']);
  assert.deepEqual(correctionKinds('我算错了这个数'), [], 'a maths mistake is not a memory correction');
  assert.deepEqual(correctionKinds('今天天气不错'), []);
  assert.equal(isCorrectionCandidate('这条记忆错了'), true);
  assert.equal(isCorrectionCandidate('今天天气不错'), false, 'ordinary chat never opens the ledger');
  assert.equal(isCorrectionCandidate('错了'), false, 'a bare complaint is not aimed at a memory');
  // A cue without a memory noun stays out: "错了" alone is too broad to act on.
  const notAimed = evaluateCorrection({ text: '过时了', memories: [memory()] });
  assert.equal(notAimed.act, false);
  assert.equal(notAimed.reason, 'not-about-memory');
});

test('an unambiguous lexical target becomes an objection', () => {
  const decision = evaluateCorrection({ text: '这条 pnpm 记忆已经过时了', memories: [memory()] });
  assert.equal(decision.act, true);
  assert.equal(decision.memoryId, 'M-1');
  assert.equal(decision.kind, 'outdated');
  assert.ok(decision.reason.includes('pnpm'));
});

test('an ambiguous or missing target is never guessed', () => {
  const first = memory({ id: 'M-1', content: '项目使用 pnpm 管理依赖' });
  const second = memory({ id: 'M-2', content: '项目使用 pnpm 运行测试' });
  const ambiguous = evaluateCorrection({ text: '这条 pnpm 记忆错了', memories: [first, second] });
  assert.equal(ambiguous.act, false);
  assert.equal(ambiguous.reason, 'ambiguous-target');
  assert.deepEqual(ambiguous.candidates, ['M-1', 'M-2']);

  const unrelated = evaluateCorrection({ text: '这条记忆已经过时了', memories: [memory({ content: '用户偏好中文回答' })] });
  assert.equal(unrelated.act, false);
  assert.equal(unrelated.reason, 'no-target', 'no lexical token matched, so there is no target to weaken');

  const nothing = evaluateCorrection({ text: '这条记忆已经过时了', memories: [] });
  assert.equal(nothing.act, false);
  assert.equal(nothing.reason, 'no-target');

  const nonActive = evaluateCorrection({ text: '这条 pnpm 记忆已经过时了', memories: [memory({ status: 'retracted' })] });
  assert.equal(nonActive.act, false, 'a retracted memory needs no objection');
});

test('an already objected memory is not objected to twice', () => {
  const decision = evaluateCorrection({ text: '这条 pnpm 记忆已经过时了', memories: [memory()], suppressedIds: ['M-1'] });
  assert.equal(decision.act, false);
  assert.equal(decision.reason, 'no-target');
});

test('recording the objection suppresses the memory at once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-correction-'));
  try {
    const runtime = createRuntimeStore({ root: dir });
    const result = await applyCorrection({ text: '这条 pnpm 记忆已经过时了', memories: [memory()], suppressedIds: [], runtime });
    assert.equal(result.recorded, true);
    assert.equal(result.objection.memory_id, 'M-1');
    assert.equal(result.objection.kind, 'outdated');
    assert.deepEqual(await runtime.suppressedIds(), ['M-1']);

    const again = await applyCorrection({ text: '这条 pnpm 记忆已经过时了', memories: [memory()], suppressedIds: await runtime.suppressedIds(), runtime });
    assert.equal(again.recorded, false);
    assert.equal(again.reason, 'no-target', 'already suppressed, nothing more to do');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a natural-language review objection says no replacement exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-narrow-'));
  try {
    const runtime = createRuntimeStore({ root: dir });
    const withRefs = memory({ source_refs: [{ session_id: 's1', event_seq: 2, event_type: 'user/message' }] });
    const broad = await applyCorrection({ text: '这条 pnpm 记忆太宽泛了', memories: [withRefs], runtime });
    assert.equal(broad.recorded, true);
    assert.equal(broad.objection.kind, 'too_broad');
    assert.deepEqual(broad.narrowing, { propose: false, narrowed: false, reason: 'no-narrower-wording' },
      'the natural-language path reports the same thing the panel does');
    assert.deepEqual(await runtime.reviewPendingIds(), ['M-1']);

    // The memory is hidden from search through the same suppression D7 uses.
    const found = searchMemories([withRefs], 'pnpm', { suppressedIds: await runtime.suppressedIds() });
    assert.deepEqual(found.results, [], 'a memory awaiting new wording is not searchable');
    assert.equal(found.hidden, 1);

    const noRefs = memory({ id: 'M-2', content: '项目使用 pnpm 管理依赖（旧）' });
    const bare = await applyCorrection({ text: '这条 pnpm 记忆太宽泛了', memories: [noRefs], runtime });
    assert.equal(bare.recorded, true);
    assert.equal(bare.narrowing.reason, 'no-evidence', 'a memory with no citation cannot be narrowed against evidence');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a storage failure is reported, never claimed as done', async () => {
  const runtime = { async addObjection() { const error = new Error('disk'); error.code = 'busy'; throw error; } };
  const result = await applyCorrection({ text: '这条 pnpm 记忆已经过时了', memories: [memory()], runtime });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'failed:busy');

  const unavailable = await applyCorrection({ text: '这条 pnpm 记忆已经过时了', memories: [memory()], runtime: null });
  assert.equal(unavailable.recorded, false);
  assert.equal(unavailable.reason, 'runtime-unavailable');
});

test('a duplicate objection is the same outcome as success', async () => {
  const runtime = {
    async addObjection() {
      const error = new Error('already');
      error.code = 'duplicate';
      throw error;
    },
  };
  const result = await applyCorrection({ text: '这条 pnpm 记忆已经过时了', memories: [memory()], runtime });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'already-objected');
});
