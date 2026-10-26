// Child process writer for the cross-process concurrency test.
// Usage: node writer-child.mjs <repoRoot> <ownerId> <idempotencyKey> <content> [startDelayMs] [lockTimeoutMs]
// Prints one JSON line: { ok, status, commit, memory_id } or { ok: false, error, name }.

import { MemoryLedger } from '../src/ledger.js';

const [root, ownerId, key, content, startDelay, lockTimeout] = process.argv.slice(2);

async function main() {
  await new Promise((resolve) => { setTimeout(resolve, Number(startDelay ?? 0)); });
  const ledger = await new MemoryLedger({
    root,
    ownerId,
    lockTimeoutMs: Number(lockTimeout ?? 30000),
    verifyEvidence: async () => ({ verified: true, reason: 'child-process fixture' }),
  }).open();
  const result = await ledger.apply({
    idempotency_key: key,
    change_type: 'ADD',
    owner_id: ownerId,
    content,
    type: 'fact',
    source_kind: 'user-explicit',
    source_refs: [{ session_id: 'child-session', event_seq: 1 }],
    reason: '并发写入子进程',
    actor: 'user',
  });
  process.stdout.write(`${JSON.stringify({ ok: true, status: result.status, commit: result.commit, memory_id: result.memory_id })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, name: error.name, details: error.details ?? null })}\n`);
  process.exitCode = 1;
});
