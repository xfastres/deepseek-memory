import assert from 'node:assert/strict';
import { test } from 'node:test';

function reactStub() {
  return {
    createElement(type, props, ...children) { return { type, props, children }; },
    Fragment: Symbol('Fragment'),
    useEffect() {},
    useRef(value) { return { current: value === undefined ? null : value }; },
    useState(value) { return [value, () => {}]; },
  };
}

/** Load the client bundle, apply it, and return its exports plus the zh dictionary. */
async function load() {
  let registration;
  globalThis.window = { __ModuleLoader__: { load(value) { registration = value; } } };
  const styles = [];
  globalThis.document = {
    createElement() { return { dataset: {}, textContent: '', remove() {} }; },
    head: { append(element) { styles.push(element); } },
  };
  await import(`../client.js?panels=${Date.now()}-${Math.random()}`);
  const plugin = registration.factory(() => reactStub());
  let zh = {};
  let en = {};
  plugin.apply({
    effect(callback) { callback(); return () => {}; },
    get() { return undefined; },
    locale: { register(_ns, dictionaries) { zh = dictionaries.zh; en = dictionaries.en ?? {}; return () => {}; }, bind() { return (key) => key; } },
    slots: { inject(_name, callback) { return callback(); }, register() { return () => {}; } },
  });
  const t = (key) => (zh[key] === undefined ? key : zh[key]);
  return { plugin, t, en, css: styles.map((style) => style.textContent).join('\n') };
}

const local = [
  { id: 'memory-a', version: 1, status: 'active', content: '构建产物放在 dist 目录' },
  { id: 'memory-b', version: 1, status: 'active', content: '回答先给结论' },
  { id: 'memory-c', version: 2, status: 'superseded', content: '旧版本内容' },
];
const ledger = [
  { id: 'M-1', status: 'active', content: '用 pnpm 管理依赖', type: 'fact' },
  { id: 'M-2', status: 'active', content: '不要堆术语', type: 'constraint' },
  { id: 'M-3', status: 'retracted', content: '已撤回的规则', type: 'preference' },
];

test('memories are filtered by query, type and status without inventing fields', async () => {
  const { plugin } = await load();
  assert.equal(plugin.filterMemories(local, {}).length, 3);
  assert.deepEqual(plugin.filterMemories(local, { query: 'DIST' }).map((memory) => memory.id), ['memory-a']);
  assert.deepEqual(plugin.filterMemories(local, { query: '先给结论' }).map((memory) => memory.id), ['memory-b']);
  assert.deepEqual(plugin.filterMemories(local, { status: 'superseded' }).map((memory) => memory.id), ['memory-c']);
  assert.deepEqual(plugin.filterMemories(ledger, { type: 'constraint' }).map((memory) => memory.id), ['M-2']);
  // A type filter on records that never carried a type matches nothing.
  assert.deepEqual(plugin.filterMemories(local, { type: 'fact' }), []);
  assert.deepEqual(plugin.filterMemories(null, { query: 'x' }), []);
});

test('the type filter only offers types that exist in the data', async () => {
  const { plugin } = await load();
  assert.deepEqual(plugin.memoryTypes(ledger), ['constraint', 'fact', 'preference']);
  assert.deepEqual(plugin.memoryTypes(local), []);
  assert.deepEqual(plugin.memoryTypes([{ id: 'x' }, { type: '' }, { type: 'fact' }]), ['fact']);
});

test('a returned record is not presented as model-confirmed', async () => {
  const { plugin, t } = await load();
  const legacy = { state: 'returned', confirmed: null };
  const badges = plugin.injectionBadges(legacy, t);
  assert.equal(badges[0].text, '宿主已返回注入文本');
  assert.equal(badges[1].text, '尚未确认模型是否使用');
  assert.equal(badges[1].tone, 'pending');

  const confirmed = plugin.injectionBadges({ state: 'returned', confirmed: true, evidence: 'receipt-1' }, t);
  assert.equal(confirmed[1].text, '已确认模型使用');
  assert.equal(confirmed[1].tone, 'ok');

  // confirmed true without evidence is still unconfirmed - the code cannot prove it.
  const unproven = plugin.injectionBadges({ state: 'returned', confirmed: true }, t);
  assert.equal(unproven[1].text, '尚未确认模型是否使用');

  const empty = plugin.injectionBadges({}, t);
  assert.equal(empty[0].text, '该记录未提供');
});

test('legacy records show "not provided" instead of fake zeros', async () => {
  const { plugin, t } = await load();
  const rows = plugin.injectionRows({ state: 'returned', confirmed: null, chars: 435 }, t);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.snapshot, '该记录未提供');
  assert.equal(byKey.reasons, '该记录未提供');
  assert.equal(byKey.pools, '该记录未提供');
  assert.equal(byKey.memories, '该记录未提供');
  assert.equal(byKey.excluded, '该记录未提供');
  assert.ok(!rows.some((row) => /0\/0/u.test(row.value)), 'no fabricated zero budget');
});

test('complete records render pools, reasons, chosen and excluded entries', async () => {
  const { plugin, t } = await load();
  const rows = plugin.injectionRows({
    snapshot_head: 'abc123',
    reasons: ['常驻约束（精简版）'],
    pools: { constraint: { budget: 240, used: 240 }, dynamic: { budget: 560, used: 0 } },
    memories: [{ id: 'M-2', kind: 'constraint', chars_used: 240, reason: '常驻约束（精简版）' }],
    excluded: [{ id: 'M-1', reason: 'over-budget' }],
  }, t);
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  assert.equal(byKey.snapshot, 'abc123');
  assert.equal(byKey.reasons, '常驻约束（精简版）');
  assert.match(byKey.pools, /约束: 240\/240/u);
  assert.match(byKey.pools, /动态: 0\/560/u);
  assert.match(byKey.memories, /M-2（约束 · 240）/u);
  assert.match(byKey.excluded, /M-1: over-budget/u);
});

test('the trace view normalises rows and keeps missing numbers missing', async () => {
  const { plugin, t } = await load();
  const view = plugin.injectionView({
    ok: true,
    injections: [
      { key: 'sha256:k1', turn: 98, chars: 435, occurrences: 2, state: 'returned', confirmed: null },
      { turn: 99 },
    ],
  }, t, 5);
  assert.equal(view.length, 2);
  assert.equal(view[0].key, 'sha256:k1');
  assert.equal(view[0].turn, 98);
  assert.equal(view[0].occurrences, 2);
  assert.equal(view[1].key, 'row-1', 'a missing key falls back to its index');
  assert.equal(view[1].chars, null, 'a missing char count stays null, not 0');
  assert.equal(view[1].occurrences, null);
  assert.equal(plugin.injectionView({ injections: new Array(60).fill({}) }, t, 5).length, 5);
  assert.deepEqual(plugin.injectionView(null, t), []);
});

test('the console theme and trace layout are part of the stylesheet', async () => {
  const { css } = await load();
  for (const rule of [
    '--dm-bg:#0b1220', '--dm-accent:#4f8cff', 'background:var(--dm-bg)',
    '.dm-toolbar{', '.dm-trace{', '.dm-trace-actions{', '.dm-badge-info', '.dm-type-constraint',
    'grid-template-columns:120px 1fr', '@media(max-width:720px)',
  ]) {
    assert.ok(css.includes(rule), `stylesheet is missing ${rule}`);
  }
});

test('a failed audit read stays retryable instead of throwing', async () => {
  const { plugin } = await load();
  const ok = await plugin.loadInjections(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, injections: [{ turn: 1 }] }),
  }));
  assert.equal(ok.status, 'ready');
  assert.equal(ok.records.length, 1);

  const httpError = await plugin.loadInjections(async () => ({ ok: false, status: 500, text: async () => 'boom' }));
  assert.deepEqual(httpError, { status: 'error', records: [], error: 'http-500' });

  const notOk = await plugin.loadInjections(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false }) }));
  assert.equal(notOk.status, 'error');
  assert.equal(notOk.error, 'http-200', 'a 200 without ok:true is still an error, not empty data');

  const badJson = await plugin.loadInjections(async () => ({ ok: true, status: 200, text: async () => 'not json' }));
  assert.equal(badJson.status, 'error');
  assert.deepEqual(badJson.records, []);

  const network = await plugin.loadInjections(async () => { throw new Error('offline'); });
  assert.equal(network.error, 'network');

  const timeout = await plugin.loadInjections(async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; });
  assert.equal(timeout.error, 'timeout');

  const noFetch = await plugin.loadInjections(undefined);
  assert.equal(noFetch.error, 'no-fetch');

  // Every branch resolves to a renderable state; nothing rejects.
  for (const result of [ok, httpError, notOk, badJson, network, timeout, noFetch]) {
    assert.ok(['ready', 'error'].includes(result.status));
    assert.ok(Array.isArray(result.records));
  }
});

test('a blank candidate is blocked early and gets its own message', async () => {
  const { plugin, t } = await load();
  assert.equal(plugin.candidateSubmitDisabled(''), true);
  assert.equal(plugin.candidateSubmitDisabled('   '), true);
  assert.equal(plugin.candidateSubmitDisabled(undefined), true);
  assert.equal(plugin.candidateSubmitDisabled('这一轮要记下的内容'), false);

  assert.equal(plugin.candidateErrorKey({ message: 'empty' }), 'candidateEmpty');
  assert.equal(t(plugin.candidateErrorKey({ message: 'empty' })), '候选内容不能为空。');
  assert.equal(plugin.candidateErrorKey({ message: 'incomplete' }), 'onlyCompleted');
  assert.equal(plugin.candidateErrorKey(null), 'onlyCompleted');
});

test('the memory editor rejects blank content with an accurate message', async () => {
  const { plugin, t } = await load();
  assert.equal(plugin.textSubmitDisabled('   '), true);
  assert.equal(plugin.textSubmitDisabled('保留这一条'), false);
  assert.equal(plugin.textSubmitDisabled, plugin.candidateSubmitDisabled, 'one guard, no divergence');

  assert.throws(() => plugin.editMemory('M-x', '   ', 1), /empty/u);
  assert.equal(t('emptyContent'), '内容不能为空。');
});

test('a memory exposes exactly the evidence references it really carries', async () => {
  const { plugin } = await load();
  const refs = plugin.evidenceRefsOf({
    id: 'M-1',
    source_refs: [
      { session_id: 'session-a', event_seq: 12 },
      { session_id: 'session-a', event_seq: 12 },
      { session_id: 'session-a' },
      { event_seq: 13 },
      null,
    ],
    source: { session_id: 'session-b', event_seq: 40 },
  });
  assert.deepEqual(refs, [
    { session_id: 'session-a', event_seq: 12 },
    { session_id: 'session-b', event_seq: 40 },
  ]);
  assert.deepEqual(plugin.evidenceRefsOf({ id: 'M-2' }), [], 'no reference is a real answer');
  assert.deepEqual(plugin.evidenceRefsOf(null), []);
});

test('an event seq is located only inside the turn that owns it', async () => {
  const { plugin } = await load();
  const turns = [
    { id: 's:1', session_id: 's', range: [1, 9] },
    { id: 's:2', session_id: 's', range: [10, 20] },
  ];
  assert.equal(plugin.locateTurnForEvent(turns, { session_id: 's', event_seq: 12 }).id, 's:2');
  assert.equal(plugin.locateTurnForEvent(turns, { session_id: 's', event_seq: 21 }), null);
  assert.equal(plugin.locateTurnForEvent(turns, { session_id: 'other', event_seq: 12 }), null);
  assert.equal(plugin.locateTurnForEvent([], { session_id: 's', event_seq: 1 }), null);
  assert.equal(plugin.locateTurnForEvent(null, null), null);
});

test('the evidence view rebuilds a real turn from session events', async () => {
  const { plugin } = await load();
  const item = {
    session_id: 'session-a', turn: 7, start_seq: 10, end_seq: 14, started_at: 1700000000000, status: 'completed',
    events: [
      { type: 'user/message', seq: 11, time: 1700000000000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住我喜欢简洁的回答' }] } },
      { type: 'assistant/message', seq: 12, time: 1700000000001, data: { message: { content: [{ type: 'text', text: '好的。' }] } } },
    ],
  };
  const turn = plugin.evidenceTurn('session-a', item);
  assert.equal(turn.id, 'session-a:7');
  assert.equal(turn.turn, 7);
  assert.deepEqual(turn.range, [10, 14]);
  assert.equal(turn.messages.length, 2);
  assert.deepEqual(turn.source_refs, [{ session_id: 'session-a', event_seq: 11 }]);
  assert.match(turn.text, /简洁/u);
});

test('ledger rows carry their evidence and offer an action only when they have one', async () => {
  const { plugin, t } = await load();
  const rows = plugin.ledgerView([
    { id: 'M-1', status: 'active', content: '用 pnpm', type: 'fact', source_refs: [{ session_id: 's', event_seq: 3 }] },
    { id: 'M-2', status: 'active', content: '无引用', type: 'fact' },
  ]);
  assert.equal(rows[0].refs.length, 1);
  assert.equal(rows[1].refs.length, 0);
  const called = [];
  const button = plugin.ledgerEvidenceButton(rows[0], t, (memory) => called.push(memory));
  assert.equal(button.props.className, 'dm-link');
  button.props.onClick();
  assert.equal(called[0].source_refs[0].event_seq, 3);
  assert.equal(plugin.ledgerEvidenceButton(rows[1], t, () => {}), null);
});

test('only the message produced by the evidence event is highlighted', async () => {
  const { plugin, t } = await load();
  const messages = plugin.conversationMessages([
    { type: 'user/message', seq: 11, time: 1700000000000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '记住我喜欢简洁' }] } },
    { type: 'assistant/message', seq: 12, time: 1700000000001, data: { message: { content: [{ type: 'text', text: '好的。' }] } } },
  ]);
  assert.equal(messages[0].seq, 11);
  assert.equal(messages[1].seq, 12);
  assert.equal(plugin.messageClass(messages[0], 11), 'dm-message dm-message-you dm-message-hit');
  assert.equal(plugin.messageClass(messages[1], 11), 'dm-message dm-message-assistant');
  assert.equal(plugin.messageClass(messages[0], null), 'dm-message dm-message-you');
  assert.equal(plugin.messageClass(messages[0], 99), 'dm-message dm-message-you');
  assert.equal(t('evidenceLocated').includes('高亮'), true);
});

test('ledger edits and retractions go through the Host writer with base change ids', async () => {
  const { plugin } = await load();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, status: 'applied', change_id: 'c-2' }) };
  };
  const client = plugin.createHostClient(fetchImpl);
  await client.update({ memoryId: 'M-1', content: '新内容', expectedBaseChangeId: 'c-1' });
  assert.equal(calls[0].url, 'api/dsh-memory/update');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { memoryId: 'M-1', content: '新内容', expectedBaseChangeId: 'c-1' });

  await client.retract({ memoryId: 'M-1', expectedBaseChangeId: 'c-1' });
  assert.equal(calls[1].url, 'api/dsh-memory/retract');
  assert.deepEqual(JSON.parse(calls[1].init.body), { memoryId: 'M-1', expectedBaseChangeId: 'c-1' });
  await client.retract({ memoryId: 'M-1' });
  assert.deepEqual(JSON.parse(calls[2].init.body), { memoryId: 'M-1' }, 'absent optionals are omitted, not sent as null');

  const conflict = plugin.createHostClient(async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ ok: false, error: 'stale' }) }));
  await assert.rejects(() => conflict.update({ memoryId: 'M-1', content: 'x' }), (error) => error.reason === 'stale');
  const forbidden = plugin.createHostClient(async () => ({ ok: false, status: 403, text: async () => 'no' }));
  await assert.rejects(() => forbidden.retract({ memoryId: 'M-1' }), (error) => error.reason === 'forbidden');
});

test('ledger rows keep the change id and version the writer needs', async () => {
  const { plugin } = await load();
  const rows = plugin.ledgerView([{ id: 'M-1', status: 'active', content: 'x', type: 'fact', last_change_id: 'c-9', version: 3 }]);
  assert.equal(rows[0].changeId, 'c-9');
  assert.equal(rows[0].version, 3);
  const bare = plugin.ledgerView([{ id: 'M-2', status: 'active', content: 'y', type: 'fact' }]);
  assert.equal(bare[0].changeId, null);
  assert.equal(bare[0].version, null);
});

test('the host candidate contract is read and written without inventing fields', async () => {
  const { plugin } = await load();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        ok: true,
        candidates: [{ id: 'C-1', text: '用 pnpm', type: 'fact', status: 'pending', reason: 'explicit', source_refs: [{ session_id: 's', event_seq: 4 }] }],
        summary: { pending: 1 },
      }),
    };
  };
  const client = plugin.createHostClient(fetchImpl);
  const queue = await client.candidates();
  assert.equal(calls[0].url, 'api/dsh-memory/candidates');
  assert.equal(calls[0].init.method, undefined, 'a read is a plain GET');
  assert.equal(queue.candidates.length, 1);
  assert.deepEqual(queue.summary, { pending: 1 });

  const view = plugin.hostCandidateView(queue);
  assert.equal(view.rows[0].type, 'fact');
  assert.equal(view.rows[0].status, 'pending');
  assert.deepEqual(view.rows[0].refs, [{ session_id: 's', event_seq: 4 }]);
  assert.deepEqual(view.rows[0].reason, 'explicit');

  const bare = plugin.hostCandidateView({ candidates: [{ id: 'C-2' }] });
  assert.equal(bare.rows[0].type, null);
  assert.equal(bare.rows[0].status, null);
  assert.equal(bare.rows[0].reason, '');
  assert.equal(bare.rows[0].refs.length, 0);
  assert.deepEqual(plugin.hostCandidateView(null), { summary: null, rows: [] });

  await client.candidate({ text: '记住这一点', sessionId: 's', turn: 3 });
  assert.equal(calls[1].url, 'api/dsh-memory/candidate');
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: '记住这一点', sessionId: 's', turn: 3 });

  await client.review({ candidateId: 'C-1', action: 'accept', content: '用 pnpm 管理依赖' });
  assert.equal(calls[2].url, 'api/dsh-memory/review');
  assert.deepEqual(JSON.parse(calls[2].init.body), { candidateId: 'C-1', action: 'accept', content: '用 pnpm 管理依赖' });

  const stale = plugin.createHostClient(async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ ok: false, error: 'stale' }) }));
  await assert.rejects(() => stale.review({ candidateId: 'C-1', action: 'merge', targetId: 'M-1', content: 'x' }), (error) => error.reason === 'stale');
});

test('host queue reviews name the candidate and never invent a target', async () => {
  const { plugin, t } = await load();
  const calls = [];
  const client = plugin.createHostClient(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, candidate: { id: 'C-1', status: 'rejected' } }) };
  });
  await client.review({ candidateId: 'C-1', action: 'reject' });
  assert.equal(calls[0].url, 'api/dsh-memory/review');
  assert.deepEqual(JSON.parse(calls[0].init.body), { candidateId: 'C-1', action: 'reject' });

  await client.review({ candidateId: 'C-1', action: 'accept' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { candidateId: 'C-1', action: 'accept' });

  assert.equal(t('hostCandidateAccepted'), '已接受候选，记忆已写入账本。');
  assert.equal(t('hostCandidateRejected'), '已拒绝该候选。');
  assert.match(t('hostCandidateFailed').replace('{reason}', 'stale'), /stale/u);
});

test('the local store is labelled as unledgered and stays migratable', async () => {
  const { plugin, t } = await load();
  assert.match(t('localCandidates'), /未进 Git 账本/u);
  assert.match(t('localCandidates'), /导入到记忆库/u);
  assert.match(t('migrateButton').replace('{count}', '3'), /3 项/u);
  // Migration reports remain honest about refusals: reasons are counted, not hidden.
  const summary = plugin.migrationSummary({ applied: 2, replayed: 1, failed: 0, skipped: [{ reason: 'no-evidence' }, { reason: 'no-evidence' }, { reason: 'duplicate' }] }, t);
  assert.ok(summary !== null && summary !== undefined);
  assert.equal(typeof summary, 'string');
});

test('the history timeline keeps versions ordered and diffs them honestly', async () => {
  const { plugin } = await load();

  const rows = plugin.versionView({
    memoryId: 'M-1',
    versions: [
      { version: 1, change_type: 'ADD', content: '第一版约定', change_id: 'c-1', committed_at: '2026-10-01T00:00:00Z' },
      { version: 2, change_type: 'UPDATE', content: '第二版约定', change_id: 'c-2', committed_at: '2026-10-02T00:00:00Z', reason: '用户纠正' },
    ],
  }).rows;
  assert.deepEqual(rows.map((row) => row.version), [1, 2]);
  assert.deepEqual(rows.map((row) => row.changeType), ['ADD', 'UPDATE']);
  assert.equal(rows[1].reason, '用户纠正');
  assert.equal(rows[0].reason, '');
  assert.deepEqual(plugin.versionView({}).rows, []);
  const bare = plugin.versionView({ versions: [{}] }).rows[0];
  assert.equal(bare.version, null);
  assert.equal(bare.changeType, null);
  assert.equal(bare.committedAt, null);
  assert.equal(bare.content, '');

  assert.deepEqual(plugin.diffLines('a\nb', 'a\nb'), [{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }]);
  assert.deepEqual(plugin.diffLines('第一版约定', '第二版约定').map((line) => line.kind).sort(), ['add', 'del']);
  assert.deepEqual(plugin.diffLines('', '新内容'), [{ kind: 'add', text: '新内容' }]);
  assert.deepEqual(plugin.diffLines('旧内容', ''), [{ kind: 'del', text: '旧内容' }]);
  const inserted = plugin.diffLines('a\nc', 'a\nb\nc');
  assert.deepEqual(inserted.map((line) => line.kind), ['same', 'add', 'same']);

  const calls = [];
  const client = plugin.createHostClient(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, memoryId: 'M 1', versions: [] }) };
  });
  await client.history({ memoryId: 'M 1' });
  assert.equal(calls[0].url, 'api/dsh-memory/history?memoryId=M%201');
  assert.equal(calls[0].init.method, undefined);
});

test('the Git trail keeps commit facts and tolerates missing ones', async () => {
  const { plugin } = await load();
  const view = plugin.changeView({
    head: 'abcdef0123456789',
    changes: [
      { commit: 'abcdef0123', committed_at: '2026-10-28T10:00:00Z', change_id: 'c-2', change_type: 'UPDATE', actor: 'user', reason: '纠正', memory_id: 'M-1', content: '新内容' },
      { commit: '1234567890', committed_at: '2026-10-28T09:00:00Z', change_id: 'c-1', change_type: 'ADD', reason: '', memory_id: 'M-1', content: '旧内容' },
    ],
  });
  assert.equal(view.head, 'abcdef0123456789');
  assert.deepEqual(view.rows.map((row) => row.changeType), ['UPDATE', 'ADD']);
  assert.equal(view.rows[0].reason, '纠正');
  assert.equal(view.rows[1].reason, '');
  assert.equal(view.rows[0].memoryId, 'M-1');

  const bare = plugin.changeView({ changes: [{}] }).rows[0];
  assert.equal(bare.commit, null);
  assert.equal(bare.changeType, null);
  assert.equal(bare.committedAt, null);
  assert.equal(bare.content, null);
  assert.equal(plugin.changeView(null).head, null);
  assert.deepEqual(plugin.changeView(null).rows, []);
  assert.deepEqual(plugin.changeView(undefined).rows, []);

  const calls = [];
  const client = plugin.createHostClient(async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, head: null, changes: [] }) };
  });
  await client.changes();
  assert.equal(calls[0], 'api/dsh-memory/changes');
  await client.changes({ limit: 5 });
  assert.equal(calls[1], 'api/dsh-memory/changes?limit=5');
  await client.changes({ limit: 0 });
  assert.equal(calls[2], 'api/dsh-memory/changes', 'an unusable limit is not sent');
});

test('a candidate origin is named in words, or left absent', async () => {
  const { plugin, t } = await load();
  assert.equal(plugin.originLabel('rule', t), '自动提取');
  assert.equal(plugin.originLabel('user', t), '用户手动');
  assert.equal(plugin.originLabel('legacy', t), '旧数据迁移');
  assert.equal(plugin.originLabel('llm', t), '模型建议');
  assert.equal(plugin.originLabel(null, t), null, 'no origin invents no label');
  assert.equal(plugin.originLabel('unknown-origin', t), null, 'an unknown origin is not translated into a claim');

  const rows = plugin.hostCandidateView({
    candidates: [
      { id: 'C-1', text: '自动提取的', origin: 'rule' },
      { id: 'C-2', text: '没有来源的' },
      { id: 'C-3', text: '非法来源', origin: 42 },
    ],
  }).rows;
  assert.deepEqual(rows.map((row) => row.origin), ['rule', null, null]);
});

test('a formal memory describes its origin on the row, without inventing one', async () => {
  const { plugin, t } = await load();
  assert.equal(plugin.sourceKindLabel('user-explicit', t), '用户明确');
  assert.equal(plugin.sourceKindLabel('agent-inference', t), '模型推断');
  assert.equal(plugin.sourceKindLabel(null, t), null);
  assert.equal(plugin.sourceKindLabel('something-else', t), null);

  const rows = plugin.ledgerView([
    { id: 'M-1', status: 'active', content: 'x', type: 'fact', source_kind: 'session-extraction' },
    { id: 'M-2', status: 'active', content: 'y', type: 'fact' },
  ]);
  assert.equal(rows[0].sourceKind, 'session-extraction');
  assert.equal(rows[1].sourceKind, null);
});

test('a classified candidate says whether it is new, identical or conflicting', async () => {
  const { plugin, t } = await load();
  assert.equal(plugin.decisionLabel('ADD', t), '新增');
  assert.equal(plugin.decisionLabel('NO_CHANGE', t), '与现有记忆相同');
  assert.equal(plugin.decisionLabel('CONFLICT', t), '需与现有记忆合并');
  assert.equal(plugin.decisionLabel(null, t), null);
  assert.equal(plugin.decisionLabel('UPDATE', t), null, 'the UI never invents an update decision');

  const rows = plugin.hostCandidateView({
    candidates: [
      { id: 'C-1', text: 'a', classification: { decision: 'CONFLICT', targetId: 'M-9', reason: 'overlap' } },
      { id: 'C-2', text: 'b' },
    ],
  }).rows;
  assert.equal(rows[0].decision, 'CONFLICT');
  assert.equal(rows[0].decisionTarget, 'M-9');
  assert.equal(rows[1].decision, null);
  assert.equal(rows[1].decisionTarget, null);
});

test('the policy decision is named honestly, including "off"', async () => {
  const { plugin, t } = await load();
  assert.equal(plugin.policyLabel({ decision: 'AUTO_ACCEPT', reasons: ['eligible'] }, t), '可自动接受');
  assert.equal(plugin.policyLabel({ decision: 'REVIEW_REQUIRED', reasons: ['auto-accept-disabled'] }, t), '可自动接受（自动接受已关闭）');
  assert.equal(plugin.policyLabel({ decision: 'REVIEW_REQUIRED', reasons: ['low-confidence'] }, t), '待复核');
  assert.equal(plugin.policyLabel({ decision: 'CONFLICT', reasons: ['conflict'] }, t), '冲突待处理');
  assert.equal(plugin.policyLabel({ decision: 'NO_CHANGE', reasons: ['duplicate'] }, t), '无需变化');
  assert.equal(plugin.policyLabel({ decision: 'REJECT', reasons: ['no-evidence'] }, t), '拒绝写入');
  assert.equal(plugin.policyLabel(null, t), null);
  assert.equal(plugin.policyLabel({ decision: 'MAYBE' }, t), null, 'an unknown decision is not translated into a claim');

  const rows = plugin.hostCandidateView({
    candidates: [
      { id: 'C-1', text: 'a', policy: { decision: 'REVIEW_REQUIRED', reasons: ['auto-accept-disabled'] } },
      { id: 'C-2', text: 'b' },
    ],
  }).rows;
  assert.deepEqual(rows[0].policy, { decision: 'REVIEW_REQUIRED', reasons: ['auto-accept-disabled'] });
  assert.equal(rows[1].policy, null);
});

test('an objection goes to the runtime routes, never through the writer', async () => {
  const { plugin } = await load();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, objections: [], suppressed: [] }) };
  };
  const client = plugin.createHostClient(fetchImpl);
  const listed = await client.objections();
  assert.deepEqual(listed.suppressed, []);
  await client.object({ memoryId: 'M-1', reason: '记错了' });
  await client.object({ memoryId: 'M-2' });
  await client.clearObjection({ memoryId: 'M-1' });

  assert.deepEqual(calls.map((call) => call.url), [
    'api/dsh-memory/objections',
    'api/dsh-memory/objections',
    'api/dsh-memory/objections',
    'api/dsh-memory/objections/clear',
  ]);
  assert.equal(calls[0].init.method, undefined, 'listing is a plain GET');
  assert.deepEqual(JSON.parse(calls[1].init.body), { memoryId: 'M-1', reason: '记错了' });
  assert.deepEqual(JSON.parse(calls[2].init.body), { memoryId: 'M-2' }, 'an absent reason is omitted, not invented');
  assert.deepEqual(JSON.parse(calls[3].init.body), { memoryId: 'M-1' });
  assert.equal(calls.every((call) => call.url.startsWith('api/dsh-memory/objections')), true);
});

test('the objection words exist in both dictionaries', async () => {
  const { t, en } = await load();
  for (const key of ['object', 'objectConfirm', 'objected', 'reinstate', 'objectedDone', 'objectFailed', 'reinstateDone']) {
    assert.notEqual(t(key), key, 'missing zh text for ' + key);
    assert.equal(typeof en[key], 'string', 'missing en text for ' + key);
  }
});

test('correction kinds are named, and an unknown kind is not translated', async () => {
  const { plugin, t } = await load();
  assert.equal(plugin.correctionLabel('wrong', t), '错误');
  assert.equal(plugin.correctionLabel('too_broad', t), '太宽泛');
  assert.equal(plugin.correctionLabel('missing_context', t), '缺少上下文');
  assert.equal(plugin.correctionLabel('should_not_save', t), '不应保存');
  assert.equal(plugin.correctionLabel('nonsense', t), null);
  assert.equal(plugin.correctionLabel(null, t), null);

  const calls = [];
  const client = plugin.createHostClient(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  });
  await client.object({ memoryId: 'M-1', kind: 'too_broad' });
  assert.deepEqual(JSON.parse(calls[0].init.body), { memoryId: 'M-1', kind: 'too_broad' }, 'the kind travels, no reason is invented');
});

test('the settings switches travel as booleans and nothing else', async () => {
  const { plugin, t } = await load();
  const calls = [];
  const client = plugin.createHostClient(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, settings: { enabled: true, autoAccept: false } }) };
  });
  const listed = await client.settings();
  assert.equal(listed.settings.autoAccept, false);
  await client.saveSettings({ autoAccept: true });
  await client.saveSettings({ enabled: false });
  assert.deepEqual(calls.map((call) => call.url), ['api/dsh-memory/settings', 'api/dsh-memory/settings', 'api/dsh-memory/settings']);
  assert.deepEqual(JSON.parse(calls[1].init.body), { autoAccept: true });
  assert.deepEqual(JSON.parse(calls[2].init.body), { enabled: false });
  for (const key of ['settingsTitle', 'settingsOn', 'settingsAutoAccept', 'settingsSave', 'settingsSaved', 'settingsFailed', 'settingsHint']) {
    assert.notEqual(t(key), key, 'missing zh text for ' + key);
  }
});

test('candidate statuses are named, and the queue action follows the Host flag', async () => {
  const { plugin, t } = await load();
  assert.equal(plugin.candidateStatusLabel('proposed', t), '已提出');
  assert.equal(plugin.candidateStatusLabel('review_pending', t), '待复核');
  assert.equal(plugin.candidateStatusLabel('auto_accepted', t), '自动接受');
  assert.equal(plugin.candidateStatusLabel('accepted_by_user', t), '用户接受');
  assert.equal(plugin.candidateStatusLabel('no_change', t), '无需变化');
  assert.equal(plugin.candidateStatusLabel('mystery', t), null);

  const view = plugin.hostCandidateView({ candidates: [
    { id: 'C-1', text: 'a', status: 'review_pending', open: true },
    { id: 'C-2', text: 'b', status: 'auto_accepted', open: false },
  ] });
  assert.equal(view.rows[0].open, true);
  assert.equal(view.rows[1].open, false);
});

test('proposal rows carry the ledger version the user must confirm against', async () => {
  const { plugin, t } = await load();
  const ledger = plugin.ledgerView([
    { id: 'M-1', status: 'active', content: '项目使用 pnpm', type: 'fact', last_change_id: 'c-1', version: 1 },
  ]);
  const view = plugin.proposalView({
    proposals: [
      { id: 'P-1', action: 'update', target_memory_id: 'M-1', content: '项目使用 pnpm 9', status: 'open', kind: 'outdated', reason: '版本变了' },
      { id: 'P-2', action: 'add', target_memory_id: null, content: '新事实', status: 'open' },
      { id: 'P-3', action: 'retract', target_memory_id: 'M-gone', content: '', status: 'open' },
    ],
  }, ledger);
  assert.equal(view[0].currentContent, '项目使用 pnpm');
  assert.equal(view[0].proposedContent, '项目使用 pnpm 9');
  assert.equal(view[0].changeId, 'c-1');
  assert.equal(view[0].targetFound, true);
  assert.equal(view[1].targetId, null);
  assert.equal(view[1].targetFound, true, 'an add proposal has no target, so nothing is missing');
  assert.equal(view[2].targetFound, false, 'a retract proposal for a gone memory is not silently accepted');
  assert.equal(plugin.proposalActionLabel('merge', t), '合并');
  assert.equal(plugin.proposalActionLabel('nonsense', t), null);
});

test('proposal decisions send the proposal id, the action, and only a real base change id', async () => {
  const { plugin, t } = await load();
  const calls = [];
  const client = plugin.createHostClient(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, proposal: { status: 'accepted' } }) };
  });
  const listed = await client.proposals();
  assert.deepEqual(listed.proposal, { status: 'accepted' });
  await client.reviewProposal({ proposalId: 'P-1', action: 'accept', expectedBaseChangeId: 'c-1' });
  await client.reviewProposal({ proposalId: 'P-2', action: 'reject' });
  assert.deepEqual(calls.map((call) => call.url), ['api/dsh-memory/proposals', 'api/dsh-memory/proposals', 'api/dsh-memory/proposals']);
  assert.deepEqual(JSON.parse(calls[1].init.body), { proposalId: 'P-1', action: 'accept', expectedBaseChangeId: 'c-1' });
  assert.deepEqual(JSON.parse(calls[2].init.body), { proposalId: 'P-2', action: 'reject' }, 'a rejection carries no base change id');
  for (const key of ['proposalsTitle', 'proposalsHint', 'proposalAccept', 'proposalReject', 'proposalStale', 'proposalMissingTarget', 'proposalAccepted', 'proposalRejected', 'proposalFailed', 'proposalBefore', 'proposalAfter']) {
    assert.notEqual(t(key), key, 'missing zh text for ' + key);
  }
});

test('a new wording asks the Host to clear the review objection it answers', async () => {
  const { plugin } = await load();
  const calls = [];
  const client = plugin.createHostClient(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  });
  await client.update({ memoryId: 'M-1', content: '新表述', expectedBaseChangeId: 'c-1', clearObjection: true });
  await client.update({ memoryId: 'M-1', content: '普通修改', expectedBaseChangeId: 'c-1' });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    memoryId: 'M-1', content: '新表述', expectedBaseChangeId: 'c-1', clearObjection: true,
  });
  assert.equal(JSON.parse(calls[1].init.body).clearObjection, undefined, 'an ordinary edit does not claim to answer anything');
});
