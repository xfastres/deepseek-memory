import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '../src/ledger.js';
import { ProjectionIndex } from '../src/projection.js';

export const OWNER = 'U-test';

export async function tempDir(prefix = 'git-ledger-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const ref = (seq, sessionId = 'session-test-1') => ({ session_id: sessionId, event_seq: seq, event_type: 'user/message' });

export async function openLedger(root, options = {}) {
  return new MemoryLedger({ root, ownerId: OWNER, ...options }).open();
}

/** A second writer process holding the same repository, for cross-process tests. */
export function writerScript() {
  return new URL('./writer-child.mjs', import.meta.url);
}

export function openIndex(ledger, path = ':memory:') {
  return new ProjectionIndex(ledger, path);
}

export function addProposal(overrides = {}) {
  return {
    idempotency_key: overrides.idempotency_key ?? `k-${Math.random().toString(36).slice(2)}`,
    change_type: 'ADD',
    owner_id: OWNER,
    content: '技术学习时优先展示调用流程，再解释模块职责',
    type: 'preference',
    source_kind: 'user-explicit',
    source_refs: [ref(42)],
    reason: '用户在 session-test-1 事件 42 明确说“记住这个偏好”。',
    actor: 'user',
    user_confirmed: true,
    ...overrides,
  };
}
