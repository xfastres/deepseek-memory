import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchKnownEntities } from '../host/entity-match.js';

function memory(id, entities, extra = {}) {
  return { id, status: 'active', content: '记忆 ' + id, entities, ...extra };
}

test('a name the ledger already holds is inherited by the sentence that mentions it', () => {
  const memories = [memory('M-1', ['pnpm']), memory('M-2', ['Node.js'])];
  assert.deepEqual(matchKnownEntities('项目使用 pnpm 管理依赖', memories), ['pnpm']);
  assert.deepEqual(matchKnownEntities('我们升级 node.js 到 24', memories), ['Node.js'], 'matching is case-insensitive, the stored casing is kept');
});

test('nothing is invented and nothing short is matched', () => {
  assert.deepEqual(matchKnownEntities('项目使用 pnpm 管理依赖', []), [], 'an empty ledger contributes no names');
  assert.deepEqual(matchKnownEntities('项目使用 pnpm 管理依赖', [memory('M-1', ['yarn'])]), [], 'an unmentioned name is not attached');
  assert.deepEqual(matchKnownEntities('这个 a 很重要', [memory('M-1', ['a'])]), [], 'one-character names match everything and are ignored');
});

test('only active memories contribute, and duplicates collapse', () => {
  const memories = [
    memory('M-1', ['pnpm'], { status: 'retracted' }),
    memory('M-2', ['pnpm']),
    memory('M-3', ['pnpm', 'pnpm']),
  ];
  assert.deepEqual(matchKnownEntities('pnpm 是包管理器', memories), ['pnpm']);
  assert.deepEqual(matchKnownEntities('', memories), []);
  assert.deepEqual(matchKnownEntities(null, memories), []);
});

test('the inherited list stays bounded', () => {
  const memories = [memory('M-1', Array.from({ length: 80 }, (_, index) => 'entity' + index))];
  const text = Array.from({ length: 80 }, (_, index) => 'entity' + index).join(' ');
  assert.equal(matchKnownEntities(text, memories).length, 50);
});
