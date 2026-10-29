import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { createLedgerService } from '../host/ledger-service.js';
import { createMemoryWriter, WriteGateError } from '../host/memory-writer.js';
import { EvidenceConflictError, intentHash } from '../../provider-git-ledger/src/canonical.js';

const git = promisify(execFile);
const REF = {
  session_id: 's1',
  event_seq: 2,
  event_type: 'user/message',
  quote_sha256: 'ab'.repeat(32),
};

function intent(over = {}) {
  return {
    change_type: 'ADD',
    content: '项目使用 pnpm',
    type: 'fact',
    scope: 'global',
    tags: ['tooling'],
    entities: ['pnpm'],
    source_refs: [REF],
    source_kind: 'user-explicit',
    ...over,
  };
}

async function commitCount(root) {
  const { stdout } = await git('git', ['rev-list', '--count', 'HEAD'], { cwd: root });
  return Number(stdout.trim());
}

async function setup(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-m1-writer-'));
  const root = join(dir, 'ledger');
  const service = createLedgerService({ root });
  await service.open();
  const approvals = new Map();
  const writer = createMemoryWriter({
    service,
    writesEnabled: true,
    callerAuth: (caller) => caller !== null && typeof caller === 'object' && caller.id === 'panel',
    verifyApproval: async (approvalId, hash) => {
      const row = approvals.get(approvalId);
      if (!row) return null;
      return {
        intent_sha256: row.intent_sha256,
        actor: 'user',
        user_confirmed: true,
        source_kind: 'user-explicit',
        ...(row.intent_sha256 === hash ? {} : {}),
      };
    },
    verifyEvidence: async () => ({ verified: true }),
    ...overrides,
    service: overrides.service ?? service,
  });
  return {
    dir,
    root,
    service,
    writer,
    grant(body = intent()) {
      const id = writer.newApprovalId();
      approvals.set(id, { intent_sha256: intentHash(body) });
      return id;
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function rejected(error, status, code) {
  assert.equal(error instanceof WriteGateError || error instanceof EvidenceConflictError, true);
  assert.equal(error.status, status);
  assert.equal(error.error, code);
  return true;
}

test('a gated ADD commits once, records the receipt, and shows the memory as active', async () => {
  const fx = await setup();
  try {
    const body = intent();
    const approvalId = fx.grant(body);
    const before = await commitCount(fx.root);
    const result = await fx.writer.apply({ caller: { id: 'panel' }, approvalId, intent: body });
    assert.equal(result.status, 'committed');
    assert.equal(typeof result.commit, 'string');
    assert.equal(result.memory.status, 'active');
    assert.equal(result.memory.content, body.content);
    assert.equal(result.memory.source_kind, 'user-explicit');
    assert.equal(await commitCount(fx.root), before + 1);

    const ledger = await fx.service.open();
    const receipt = await ledger.receiptFor(approvalId);
    assert.equal(receipt.commit, result.commit);
    assert.equal(receipt.change_id, result.change_id);
    assert.equal(receipt.memory_id, result.memory.id);

    const state = await fx.service.state();
    assert.equal(state.memories.length, 1);
    assert.equal(state.memories[0].id, result.memory.id);
    assert.equal(state.memories[0].status, 'active');
    assert.equal(state.memories[0].source.event_seq, 2);
  } finally {
    await fx.cleanup();
  }
});

test('replaying the same approval and intent does not create a second commit', async () => {
  const fx = await setup();
  try {
    const body = intent();
    const approvalId = fx.grant(body);
    const first = await fx.writer.apply({ caller: { id: 'panel' }, approvalId, intent: body });
    const afterFirst = await commitCount(fx.root);
    const second = await fx.writer.apply({ caller: { id: 'panel' }, approvalId, intent: body });
    assert.equal(second.status, 'replayed');
    assert.equal(second.change_id, first.change_id);
    assert.equal(second.commit, first.commit);
    assert.equal(await commitCount(fx.root), afterFirst);
    assert.equal((await fx.service.state()).memories.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test('the same approval with a different intent is refused and writes nothing', async () => {
  const fx = await setup();
  try {
    const body = intent();
    const approvalId = fx.grant(body);
    const before = await commitCount(fx.root);
    await assert.rejects(
      () => fx.writer.apply({
        caller: { id: 'panel' },
        approvalId,
        intent: intent({ content: '项目使用 npm' }),
      }),
      (error) => rejected(error, 409, 'approval-intent-mismatch'),
    );
    assert.equal(await commitCount(fx.root), before);
    assert.equal((await fx.service.state()).memories.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('a failed gate writes no commit', async () => {
  const fx = await setup();
  try {
    const body = intent();
    const before = await commitCount(fx.root);
    await assert.rejects(
      () => fx.writer.apply({ caller: { id: 'other' }, approvalId: fx.grant(body), intent: body }),
      (error) => rejected(error, 401, 'unauthenticated'),
    );

    const closedDir = await mkdtemp(join(tmpdir(), 'dsh-m1-closed-'));
    const closedService = createLedgerService({ root: join(closedDir, 'ledger') });
    const closed = createMemoryWriter({
      service: closedService,
      writesEnabled: false,
      callerAuth: () => true,
      verifyApproval: async (_id, hash) => ({ intent_sha256: hash, user_confirmed: true }),
      verifyEvidence: async () => ({ verified: true }),
    });
    await assert.rejects(
      () => closed.apply({ caller: { id: 'panel' }, approvalId: 'AP-1', intent: body }),
      (error) => rejected(error, 503, 'write-gate-not-ready'),
    );
    await rm(closedDir, { recursive: true, force: true });

    await assert.rejects(
      () => fx.writer.apply({ caller: { id: 'panel' }, approvalId: 'AP-missing', intent: body }),
      (error) => rejected(error, 403, 'approval-required'),
    );

    const bareDir = await mkdtemp(join(tmpdir(), 'dsh-m1-bare-'));
    const bareService = createLedgerService({ root: join(bareDir, 'ledger') });
    const noEvidence = createMemoryWriter({
      service: bareService,
      writesEnabled: true,
      callerAuth: () => true,
      verifyApproval: async (_id, hash) => ({ intent_sha256: hash, user_confirmed: true }),
    });
    await assert.rejects(
      () => noEvidence.apply({ caller: { id: 'panel' }, approvalId: 'AP-2', intent: body }),
      (error) => rejected(error, 503, 'evidence-unavailable'),
    );
    await rm(bareDir, { recursive: true, force: true });

    const badDir = await mkdtemp(join(tmpdir(), 'dsh-m1-bad-'));
    const badService = createLedgerService({ root: join(badDir, 'ledger') });
    const badEvidence = createMemoryWriter({
      service: badService,
      writesEnabled: true,
      callerAuth: () => true,
      verifyApproval: async (_id, hash) => ({ intent_sha256: hash, user_confirmed: true }),
      verifyEvidence: async () => ({ verified: false }),
    });
    await assert.rejects(
      () => badEvidence.apply({ caller: { id: 'panel' }, approvalId: 'AP-3', intent: body }),
      (error) => rejected(error, 422, 'evidence-invalid'),
    );
    await rm(badDir, { recursive: true, force: true });

    assert.equal(await commitCount(fx.root), before);
    assert.equal((await fx.service.state()).memories.length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('conflicting evidence is refused before a commit', async () => {
  const fx = await setup();
  try {
    const before = await commitCount(fx.root);
    const body = intent({
      source_refs: [REF, { ...REF, quote_sha256: 'cd'.repeat(32) }],
    });
    await assert.rejects(
      () => fx.writer.apply({ caller: { id: 'panel' }, approvalId: 'AP-conflict', intent: body }),
      (error) => error instanceof EvidenceConflictError && error.error === 'evidence-conflict',
    );
    assert.equal(await commitCount(fx.root), before);
  } finally {
    await fx.cleanup();
  }
});

test('applyGated without the writer token does not commit', async () => {
  const fx = await setup();
  try {
    const before = await commitCount(fx.root);
    await assert.rejects(
      () => fx.service.applyGated({ change_type: 'ADD', content: '不该写入', source_refs: [REF] }),
      (error) => error.status === 403 && error.error === 'forbidden',
    );
    assert.equal(await commitCount(fx.root), before);
  } finally {
    await fx.cleanup();
  }
});
