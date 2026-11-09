import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildInjectionKey, createInjectionLog, MAX_IN_MEMORY_RECORDS } from '../host/injection-log.js';

const HEAD = 'a'.repeat(40);
const AT = () => new Date('2026-10-28T08:00:00.000Z');

function entry(extra = {}) {
  return {
    sessionId: 'session-1',
    turn: 7,
    snapshotHead: HEAD,
    memoryIds: ['M-2', 'M-1'],
    text: '以下是用户已确认的长期记忆，仅作背景参考：\n1. 项目用 pnpm',
    ...extra,
  };
}

test('the dedupe key covers session, turn, snapshot, memory set and final text', () => {
  const base = buildInjectionKey(entry());
  assert.match(base, /^sha256:[0-9a-f]{64}$/u, 'a full SHA-256, not a prefix');
  assert.notEqual(buildInjectionKey(entry({ sessionId: 'session-2' })), base, 'session participates');
  assert.notEqual(buildInjectionKey(entry({ turn: 8 })), base, 'turn participates');
  assert.notEqual(buildInjectionKey(entry({ snapshotHead: 'b'.repeat(40) })), base, 'snapshot participates');
  assert.notEqual(buildInjectionKey(entry({ memoryIds: ['M-2'] })), base, 'the selected set participates');
  assert.notEqual(buildInjectionKey(entry({ text: '别的文本' })), base, 'the final text participates');
});

test('the key ignores memory order but the record keeps a sorted set', () => {
  assert.equal(
    buildInjectionKey(entry({ memoryIds: ['M-1', 'M-2'] })),
    buildInjectionKey(entry({ memoryIds: ['M-2', 'M-1'] })),
    'the same set must not produce two keys',
  );
  const log = createInjectionLog({ now: AT });
  const { record } = log.note(entry({ memoryIds: ['M-3', 'M-1', 'M-2'] }));
  assert.deepEqual(record.memory_ids, ['M-1', 'M-2', 'M-3']);
});

test('the text digest is the SHA-256 of exactly the returned text', () => {
  const log = createInjectionLog({ now: AT });
  const text = '注入内容 A';
  const { record } = log.note(entry({ text }));
  assert.match(record.text_digest, /^sha256:[0-9a-f]{64}$/u);
  const again = log.note(entry({ text: '注入内容 B' }));
  assert.notEqual(again.record.text_digest, record.text_digest, 'different text, different digest');
  assert.equal(record.chars, text.length);
});

test('two calls in one step produce one logical record but keep both counts', () => {
  const log = createInjectionLog({ now: AT });
  const first = log.note(entry());
  const second = log.note(entry());
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true, 'the second call must be recognised as a repeat');
  assert.equal(log.records().length, 1, 'one logical injection');
  assert.equal(log.records()[0].occurrences, 2, 'both provider calls are counted');
  assert.equal(log.stats().calls, 2, 'call statistics are never lost');
  assert.equal(log.stats().records, 1, 'logical records are deduped');
});

test('a different turn or snapshot is never merged silently', () => {
  const log = createInjectionLog({ now: AT });
  log.note(entry({ turn: 7 }));
  log.note(entry({ turn: 8 }));
  log.note(entry({ snapshotHead: 'c'.repeat(40) }));
  const records = log.records();
  assert.equal(records.length, 3, 'each scope keeps its own record');
  assert.deepEqual(records.map((record) => record.turn), [7, 8, 7]);
  assert.equal(new Set(records.map((record) => record.key)).size, 3);
});

test('the merge scope is declared, not implied by a hash', () => {
  const log = createInjectionLog({ now: AT });
  log.note(entry());
  log.note(entry());
  const [record] = log.records();
  assert.equal(record.scope, 'turn', 'merging happens at the turn, and says so');
  assert.equal(record.step, null, 'the provider cannot see a step number, so none is invented');
});

test('confirmed stays null without a host receipt', () => {
  const log = createInjectionLog({ now: AT });
  const { record } = log.note(entry());
  assert.equal(record.state, 'returned');
  assert.equal(record.confirmed, null, 'no receipt means unknown, not true');
  assert.equal(record.evidence, null);
});

test('an empty text is counted as a call but never recorded as an injection', () => {
  const log = createInjectionLog({ now: AT });
  const result = log.note(entry({ text: '' }));
  assert.equal(result.record, null);
  assert.equal(log.records().length, 0, 'nothing entered the prompt, so nothing is logged');
  assert.equal(log.stats().calls, 1, 'the call still happened and is still counted');
  assert.equal(log.stats().empty, 1, 'and it is visible as an empty return');
});

test('missing identifiers degrade instead of throwing', () => {
  const log = createInjectionLog({ now: AT });
  const { record } = log.note({ text: '仍然记录' });
  assert.equal(record.session_id, null);
  assert.equal(record.turn, null);
  assert.equal(record.snapshot_head, null);
  assert.deepEqual(record.memory_ids, []);
  assert.match(record.key, /^sha256:[0-9a-f]{64}$/u);
});

test('records carry first and last timestamps for repeated calls', () => {
  let clock = 0;
  const log = createInjectionLog({ now: () => new Date(Date.UTC(2026, 9, 28, 8, 0, clock++)) });
  const first = log.note(entry());
  const second = log.note(entry());
  assert.equal(first.record.first_at, '2026-10-28T08:00:00.000Z');
  assert.equal(second.record.first_at, '2026-10-28T08:00:00.000Z', 'first_at does not move');
  assert.equal(second.record.last_at, '2026-10-28T08:00:01.000Z', 'last_at does');
});

test('a partial pools object is recorded as unknown, never thrown on', () => {
  // This runs inside the prompt provider. A throw there is caught upstream and
  // the provider returns an empty string, so the whole memory block silently
  // vanishes from that turn - the audit row was taking the feature down with it.
  const log = createInjectionLog({ now: AT });
  const shapes = [
    {},
    { constraint: {} },
    { dynamic: {} },
    { constraint: null },
    { constraint: { budget: 1 } },
    { constraint: { budget: 240, used: 100 } },
    'nonsense',
    null,
  ];
  shapes.forEach((pools, index) => {
    const { record } = log.note(entry({ text: `block ${index}`, pools }));
    // Anything without at least one usable number is "unknown", not a guess.
    const constraint = pools !== null && typeof pools === 'object' && pools.constraint !== null && typeof pools.constraint === 'object' ? pools.constraint : null;
    const dynamic = pools !== null && typeof pools === 'object' && pools.dynamic !== null && typeof pools.dynamic === 'object' ? pools.dynamic : null;
    const hasNumber = (pool) => pool !== null && (Number.isFinite(pool.budget) || Number.isFinite(pool.used));
    if (!hasNumber(constraint) && !hasNumber(dynamic)) {
      assert.equal(record.pools, null, `pools=${JSON.stringify(pools)} is recorded as unknown`);
    } else {
      assert.ok(record.pools !== null, `pools=${JSON.stringify(pools)} keeps what it had`);
    }
  });
  // A complete split is still recorded exactly.
  const { record } = log.note(entry({ text: 'full', pools: { constraint: { budget: 240, used: 100 }, dynamic: { budget: 560, used: 40 } } }));
  assert.deepEqual(record.pools, { constraint: { budget: 240, used: 100 }, dynamic: { budget: 560, used: 40 } });
});

test('the in-memory log is bounded, and its sequence numbers stay monotonic', () => {
  // Every provider call used to add a record that was never released, so a long
  // session grew the Host heap for as long as it ran. Persisted records are the
  // audit trail; the in-memory list only needs the unflushed tail.
  const log = createInjectionLog({ now: AT });
  const total = MAX_IN_MEMORY_RECORDS + 250;
  for (let index = 1; index <= total; index += 1) {
    log.note(entry({ turn: index, text: `block ${index}` }));
  }
  const stats = log.stats();
  assert.equal(stats.records, MAX_IN_MEMORY_RECORDS, 'the cap is honoured');
  assert.equal(stats.dropped, total - MAX_IN_MEMORY_RECORDS, 'drops are counted, not silent');
  assert.equal(stats.calls, total, 'calls are still counted in full');

  const kept = log.records();
  assert.equal(kept.at(-1).seq, total, 'the newest record keeps its true sequence');
  assert.ok(kept.every((record, index) => index === 0 || record.seq > kept[index - 1].seq), 'sequence stays monotonic');
});
