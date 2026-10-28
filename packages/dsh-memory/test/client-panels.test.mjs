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
  plugin.apply({
    effect(callback) { callback(); return () => {}; },
    get() { return undefined; },
    locale: { register(_ns, dictionaries) { zh = dictionaries.zh; return () => {}; }, bind() { return (key) => key; } },
    slots: { inject(_name, callback) { return callback(); }, register() { return () => {}; } },
  });
  const t = (key) => (zh[key] === undefined ? key : zh[key]);
  return { plugin, t, css: styles.map((style) => style.textContent).join('\n') };
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
