import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createProposeTool } from '../index.js';
import { createRuntimeStore } from '../host/runtime-store.js';

const REF = { session_id: 'session-a', event_seq: 4, event_type: 'user/message' };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-proposals-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a proposal is stored open, with evidence, and is not a memory', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const proposal = await store.addProposal({
      action: 'update', targetMemoryId: 'M-1', content: '新内容', sourceRef: REF, kind: 'wrong', reason: '记错了',
    });
    assert.equal(proposal.status, 'open');
    assert.equal(proposal.origin, 'llm');
    assert.equal(proposal.target_memory_id, 'M-1');
    assert.deepEqual(proposal.source_refs, [REF]);
    assert.deepEqual(await store.listProposals(), [proposal]);
    assert.equal((await store.summary()).proposals, 1);
    assert.deepEqual(await store.listCandidates(), [], 'a proposal never enters the candidate queue');
  });
});

test('a proposal without evidence, content or target is refused', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const code = (input) => store.addProposal(input).then(() => 'accepted', (error) => error.code);

    assert.equal(await code({ action: 'update', targetMemoryId: 'M-1', content: 'x' }), 'no-evidence');
    assert.equal(await code({ action: 'update', targetMemoryId: 'M-1', content: '  ', sourceRef: REF }), 'empty');
    assert.equal(await code({ action: 'update', content: 'x', sourceRef: REF }), 'empty-target');
    assert.equal(await code({ action: 'retract', sourceRef: REF }), 'empty-target');
    assert.equal(await code({ action: 'write', targetMemoryId: 'M-1', content: 'x', sourceRef: REF }), 'invalid-action');
    assert.equal(await code({ action: 'update', targetMemoryId: 'M-1', content: 'x', kind: 'maybe', sourceRef: REF }), 'invalid-kind');
    // An add proposal needs no target, but still needs content and evidence.
    assert.equal(await code({ action: 'add', sourceRef: REF }), 'empty');
    const added = await store.addProposal({ action: 'add', content: '新记忆', type: 'fact', sourceRef: REF });
    assert.equal(added.target_memory_id, null);
  });
});

test('an identical open proposal is not doubled, a resolved one may be proposed again', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const first = await store.addProposal({ action: 'update', targetMemoryId: 'M-1', content: '新内容', sourceRef: REF });
    await assert.rejects(
      () => store.addProposal({ action: 'update', targetMemoryId: 'M-1', content: '新内容', sourceRef: REF }),
      (error) => error.code === 'duplicate',
    );
    await store.setProposalStatus(first.id, 'rejected');
    const second = await store.addProposal({ action: 'update', targetMemoryId: 'M-1', content: '新内容', sourceRef: REF });
    assert.notEqual(second.id, first.id);
  });
});

test('an unknown proposal status is refused', async () => {
  await withRoot(async (root) => {
    const store = createRuntimeStore({ root });
    const proposal = await store.addProposal({ action: 'add', content: '新记忆', tech: undefined, sourceRef: REF });
    await assert.rejects(() => store.setProposalStatus(proposal.id, 'maybe'), (error) => error.code === 'invalid-status');
    await assert.rejects(() => store.setProposalStatus('P-nope', 'accepted'), (error) => error.code === 'missing');
  });
});

test('the tool proposes with turn-bound evidence and never writes the ledger', async () => {
  const calls = [];
  const app = {
    evidence: { async resolve({ sessionId, turn }) { return sessionId === 's1' && turn === 3 ? REF : null; } },
    runtime: {
      async addProposal(input) {
        calls.push(input);
        return { id: 'P-1', action: input.action, target_memory_id: input.targetMemoryId ?? null, content: input.content ?? '', status: 'open', created_at: 'now' };
      },
    },
  };
  const tool = createProposeTool({ getApp: async () => app, currentTurn: () => ({ sessionId: 's1', turn: 3 }) });
  assert.equal(tool.name, 'memory_propose');
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.output.schema.type, 'object');

  const value = await tool.execute({ action: 'update', targetMemoryId: 'M-1', content: '新内容', kind: 'wrong' });
  assert.equal(value.ok, true);
  assert.equal(value.proposal.id, 'P-1');
  assert.deepEqual(calls[0].sourceRef, REF, 'the user words behind the proposal are recorded');
  const blocks = tool.output.render({}, value);
  assert.equal(blocks[0].type, 'text');
});

test('the tool refuses without a turn, without evidence, or with a bad action', async () => {
  const noTurn = createProposeTool({ getApp: async () => ({ runtime: { addProposal: async () => { throw new Error('must not run'); } } }), currentTurn: () => null });
  assert.deepEqual(await noTurn.execute({ action: 'add', content: 'x' }), { ok: false, error: 'no-turn-context' });

  const noEvidence = createProposeTool({
    getApp: async () => ({ evidence: { async resolve() { return null; } }, runtime: { addProposal: async () => { throw new Error('must not run'); } } }),
    currentTurn: () => ({ sessionId: 's1', turn: 3 }),
  });
  assert.deepEqual(await noEvidence.execute({ action: 'add', content: 'x' }), { ok: false, error: 'no-evidence' });

  const badAction = createProposeTool({
    getApp: async () => ({
      evidence: { async resolve() { return REF; } },
      runtime: { async addProposal() { const error = new Error('nope'); error.code = 'invalid-action'; throw error; } },
    }),
    currentTurn: () => ({ sessionId: 's1', turn: 3 }),
  });
  assert.deepEqual(await badAction.execute({ action: 'write', content: 'x' }), { ok: false, error: 'invalid-action' });
});
