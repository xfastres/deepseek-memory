import assert from 'node:assert/strict';
import { test } from 'node:test';

function reactStub() {
  return {
    createElement(type, props, ...children) { return { type, props, children }; },
    Fragment: Symbol('Fragment'),
    useEffect() {},
    useState(value) { return [value, () => {}]; },
  };
}

function loadPlugin() {
  let registration;
  globalThis.window = {
    __ModuleLoader__: { load(value) { registration = value; } },
  };
  return import(`../client.js?test=${Date.now()}-${Math.random()}`).then(() => registration.factory((specifier) => {
    if (specifier !== 'react') throw new Error(`unexpected module ${specifier}`);
    return {
      createElement(type, props, ...children) { return { type, props, children }; },
      Fragment: Symbol('Fragment'),
      useEffect() {},
      useState(value) { return [value, () => {}]; },
    };
  }));
}

test('the plugin hard-depends only on layout services and registers its own panel', async () => {
  let registration;
  globalThis.window = {
    __ModuleLoader__: { load(value) { registration = value; } },
  };
  const appended = [];
  globalThis.document = {
    createElement() { return { dataset: {}, textContent: '', remove() {} }; },
    head: { append(element) { appended.push(element); } },
  };
  await import(`../client.js?test=${Date.now()}`);
  assert.equal(registration.id, '@local/dsh-memory');
  const plugin = registration.factory((specifier) => {
    assert.equal(specifier, 'react');
    return reactStub();
  });
  assert.deepEqual(plugin.inject, ['slots', 'locale']);
  assert.ok(!plugin.inject.some((name) => name.startsWith('remote.')));

  const registrations = [];
  const ctx = {
    effect() { return () => {}; },
    get(name) { return name === 'sessions' ? { kind: 'sessions' } : undefined; },
    locale: { register() { return () => {}; }, bind() { return (key) => key; } },
    slots: {
      inject(_name, callback) { return callback(); },
      register(options) { registrations.push(options); return () => {}; },
    },
  };
  plugin.apply(ctx);
  assert.deepEqual(registrations.map((entry) => entry.name), ['sidebar.panellist', 'main']);
  assert.equal(registrations[0].id, 'memory');
  assert.equal(registrations[1].key, 'memory');
  assert.equal(appended.length, 1);
});

test('tool activity is grouped separately from the readable conversation', async () => {
  const plugin = await loadPlugin();
  const messages = plugin.conversationMessages([
    { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: 'injected' }] } },
    { type: 'user/message', seq: 3, time: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'real question' }] } },
    { type: 'tool/call', seq: 4, time: 4, data: { name: 'read' } },
    { type: 'tool/result', seq: 5, time: 5, data: { message: { name: 'read', content: [{ type: 'text', text: 'tool output' }] } } },
    { type: 'assistant/message', seq: 6, time: 6, data: { message: { content: [{ type: 'text', text: 'real answer' }] } } },
  ]);
  assert.deepEqual(messages.map((message) => message.role), ['you', 'tools', 'assistant']);
  assert.equal(messages[0].text, 'real question');
  assert.equal(messages[1].items.length, 2);
  assert.equal(messages[1].items[1].text, 'tool output');
  assert.equal(messages[2].text, 'real answer');
});

test('message formatting renders markdown safely', async () => {
  const plugin = await loadPlugin();
  const html = plugin.formatMessage('# Title\n\n- **bold** item\n\n```\n<script>alert(1)</script>\n```');
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<pre><code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script>/);
  const rich = plugin.formatMessage('See [docs](https://example.com)\n\n> quoted\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(rich, /<a href="https:\/\/example\.com\/" target="_blank" rel="noreferrer">docs<\/a>/);
  assert.match(rich, /<blockquote>quoted<\/blockquote>/);
  assert.match(rich, /<table><thead><tr><th>A<\/th><th>B<\/th>/);
  assert.equal(plugin.formatMessage('[bad](javascript:alert(1))'), '<p>[bad](javascript:alert(1))</p>');
});

test('only a completed turn can create a local candidate', async () => {
  const plugin = await loadPlugin();
  const stored = [];
  globalThis.localStorage = {
    getItem: () => JSON.stringify(stored),
    setItem: (_key, value) => { stored.splice(0, stored.length, ...JSON.parse(value)); },
  };
  const turn = {
    status: 'completed', session_id: 'session-1', turn: 2,
    source_refs: [{ event_seq: 8 }],
  };
  const saved = plugin.saveCandidate(turn, '  remember this fact  ');
  assert.equal(saved[0].status, 'candidate');
  assert.equal(saved[0].text, 'remember this fact');
  assert.deepEqual(saved[0].source, { session_id: 'session-1', turn: 2, event_seq: 8 });
  assert.throws(() => plugin.saveCandidate({ ...turn, status: 'in_progress' }, 'no'), /incomplete/);
});

function memoryStore(seed = {}) {
  const store = { ...seed };
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? '[]',
    setItem: (key, value) => { store[key] = value; },
  };
  return store;
}

const CANDIDATE_KEY = 'dsh-memory.candidates.v1';
const FORMAL_KEY = 'dsh-memory.formal.v1';

function candidate(overrides = {}) {
  return {
    id: 'candidate-1', status: 'candidate', text: 'use concise answers',
    source: { session_id: 'session-1', turn: 3, event_seq: 9 },
    ...overrides,
  };
}

test('accepting an ADD creates version 1 and removes the candidate', async () => {
  const plugin = await loadPlugin();
  const store = memoryStore({ [CANDIDATE_KEY]: JSON.stringify([candidate()]) });
  assert.equal(plugin.compareCandidate(candidate(), []).outcome, 'ADD');

  const result = plugin.reviewCandidate('candidate-1', 'accept');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].status, 'active');
  assert.equal(result.memories[0].version, 1);
  assert.equal(result.memories[0].content, 'use concise answers');
  assert.deepEqual(JSON.parse(store[FORMAL_KEY]).length, 1);
});

test('accepting an UPDATE supersedes the old version and keeps the memory id', async () => {
  const plugin = await loadPlugin();
  const first = candidate();
  const store = memoryStore({ [CANDIDATE_KEY]: JSON.stringify([first]) });
  const created = plugin.reviewCandidate('candidate-1', 'accept');
  const memoryId = created.memories[0].id;

  const update = candidate({ id: 'candidate-2', text: 'use concise answers in Chinese' });
  store[CANDIDATE_KEY] = JSON.stringify([update]);
  const decision = plugin.compareCandidate(update, created.memories);
  assert.equal(decision.outcome, 'UPDATE');
  assert.equal(decision.base_version, 1);

  const updated = plugin.reviewCandidate('candidate-2', 'accept', { expectedBaseVersion: decision.base_version });
  const active = updated.memories.filter((memory) => memory.status === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].id, memoryId);
  assert.equal(active[0].version, 2);
  assert.equal(active[0].previous_version, 1);
  assert.equal(updated.memories.filter((memory) => memory.status === 'superseded').length, 1);
  assert.equal(updated.candidates.length, 0);
});

test('rejecting removes the candidate and leaves formal memory untouched', async () => {
  const plugin = await loadPlugin();
  const store = memoryStore({
    [CANDIDATE_KEY]: JSON.stringify([candidate(), candidate({ id: 'candidate-2', text: 'second' })]),
  });
  plugin.reviewCandidate('candidate-1', 'accept');
  const before = store[FORMAL_KEY];

  const rejected = plugin.reviewCandidate('candidate-2', 'reject');
  assert.equal(rejected.candidates.length, 0);
  assert.equal(store[FORMAL_KEY], before);
  assert.equal(rejected.memories.filter((memory) => memory.status === 'active').length, 1);
});

test('merging into a chosen memory updates that memory even when the text differs', async () => {
  const plugin = await loadPlugin();
  const store = memoryStore({ [CANDIDATE_KEY]: JSON.stringify([candidate()]) });
  const created = plugin.reviewCandidate('candidate-1', 'accept');
  const target = created.memories[0];

  const manual = candidate({ id: 'candidate-2', text: '完全不同的中文内容' });
  store[CANDIDATE_KEY] = JSON.stringify([manual]);
  assert.equal(plugin.compareCandidate(manual, created.memories).outcome, 'ADD');

  const merged = plugin.reviewCandidate('candidate-2', 'accept', {
    targetId: target.id,
    expectedBaseVersion: target.version,
  });
  const active = merged.memories.filter((memory) => memory.status === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].id, target.id);
  assert.equal(active[0].version, 2);
  assert.equal(active[0].content, '完全不同的中文内容');
  assert.equal(merged.candidates.length, 0);
});

test('a stale base version is refused instead of overwriting a newer memory', async () => {
  const plugin = await loadPlugin();
  const store = memoryStore({
    [FORMAL_KEY]: JSON.stringify([
      { id: 'memory-1', version: 2, status: 'active', content: 'newer content' },
      { id: 'memory-1', version: 1, status: 'superseded', content: 'older content' },
    ]),
    [CANDIDATE_KEY]: JSON.stringify([candidate({ id: 'candidate-9', text: '完全不同的事情' })]),
  });

  assert.throws(
    () => plugin.reviewCandidate('candidate-9', 'accept', { targetId: 'memory-1', expectedBaseVersion: 1 }),
    /stale/,
  );
  const stored = JSON.parse(store[FORMAL_KEY]);
  assert.equal(stored.filter((memory) => memory.status === 'active').length, 1);
  assert.equal(stored.filter((memory) => memory.status === 'active')[0].version, 2);
  assert.equal(stored.length, 2);
  assert.equal(JSON.parse(store[CANDIDATE_KEY]).length, 1);
});

test('the review view decides accept availability and base version from the chosen target', async () => {  const plugin = await loadPlugin();
  const memories = [
    { id: 'memory-1', version: 3, status: 'active', content: 'use concise answers' },
    { id: 'memory-2', version: 1, status: 'active', content: '完全不同的内容' },
  ];

  const same = plugin.reviewView(candidate({ text: 'use concise answers' }), memories, '');
  assert.equal(same.outcome, 'NO_CHANGE');
  assert.equal(same.canAccept, false);
  assert.equal(same.after, null);

  const sameWithTarget = plugin.reviewView(candidate({ text: 'use concise answers' }), memories, 'memory-2');
  assert.equal(sameWithTarget.outcome, 'UPDATE');
  assert.equal(sameWithTarget.before, '完全不同的内容');
  assert.equal(sameWithTarget.canAccept, true);
  assert.equal(sameWithTarget.expectedBaseVersion, 1);

  const fresh = plugin.reviewView(candidate({ text: '今天部署了记忆插件' }), memories, '');
  assert.equal(fresh.outcome, 'ADD');
  assert.equal(fresh.canAccept, true);
  assert.equal(fresh.expectedBaseVersion, undefined);

  const update = plugin.reviewView(candidate({ text: 'use concise answers in Chinese' }), memories, '');
  assert.equal(update.outcome, 'UPDATE');
  assert.equal(update.canAccept, true);
  assert.equal(update.expectedBaseVersion, 3);
});

test('session history loading stops at the oldest page and tolerates a read-only reference', async () => {
  const plugin = await loadPlugin();
  const signal = new AbortController().signal;
  let pages = 0;
  let hasMore = true;
  const paged = {
    binding: {
      session: {
        getSnapshot: () => ({ hasMore }),
        loadOlder: async () => { pages += 1; if (pages >= 3) hasMore = false; },
      },
    },
  };
  assert.equal(await plugin.loadFullHistory(paged, signal), 3);
  assert.equal(pages, 3);
  assert.equal(await plugin.loadFullHistory({ binding: {} }, signal), 0);
});

test('memory export and import round-trips without duplicating records', async () => {
  const plugin = await loadPlugin();
  const store = {};
  globalThis.localStorage = {
    getItem: (key) => store[key] ?? '[]',
    setItem: (key, value) => { store[key] = value; },
  };
  store['dsh-memory.formal.v1'] = JSON.stringify([
    { id: 'memory-1', version: 1, status: 'superseded', content: 'old' },
    { id: 'memory-1', version: 2, status: 'active', content: 'current' },
  ]);
  store['dsh-memory.candidates.v1'] = JSON.stringify([
    { id: 'candidate-1', status: 'candidate', text: 'pending' },
  ]);
  const exported = plugin.exportMemory();
  assert.equal(exported.format, 'dsh-memory/v1');
  assert.equal(exported.memories.length, 2);

  store['dsh-memory.formal.v1'] = '[]';
  store['dsh-memory.candidates.v1'] = '[]';
  const imported = plugin.importMemory(JSON.stringify(exported));
  assert.equal(imported.added.memories, 2);
  assert.equal(imported.added.candidates, 1);
  assert.equal(imported.memories.filter((memory) => memory.status === 'active').length, 1);

  const again = plugin.importMemory(exported);
  assert.equal(again.added.memories, 0);
  assert.equal(again.added.candidates, 0);
  assert.throws(() => plugin.importMemory('{"format":"other"}'), /format/);
});

test('a merge draft keeps the original text and skips duplication', async () => {
  const plugin = await loadPlugin();
  assert.equal(plugin.mergeDraft('原内容', '新内容'), '原内容\n\n新内容');
  assert.equal(plugin.mergeDraft('', '新内容'), '新内容');
  assert.equal(plugin.mergeDraft('原内容', ''), '原内容');
  assert.equal(plugin.mergeDraft('原内容包含新内容', '新内容'), '原内容包含新内容');
});

test('merging concatenates by default and keeps the original version in history', async () => {
  const plugin = await loadPlugin();
  const store = memoryStore({ [CANDIDATE_KEY]: JSON.stringify([candidate({ text: '原内容' })]) });
  const created = plugin.reviewCandidate('candidate-1', 'accept');
  const target = created.memories[0];

  const addition = candidate({ id: 'candidate-2', text: '新内容' });
  store[CANDIDATE_KEY] = JSON.stringify([addition]);
  const view = plugin.reviewView(addition, created.memories, target.id);
  const merged = plugin.reviewCandidate('candidate-2', 'accept', {
    targetId: target.id,
    expectedBaseVersion: view.expectedBaseVersion,
    content: plugin.mergeDraft(view.before, addition.text),
  });

  const active = merged.memories.filter((memory) => memory.status === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].content, '原内容\n\n新内容');
  assert.equal(active[0].version, 2);
  const history = merged.memories.filter((memory) => memory.id === target.id && memory.status === 'superseded');
  assert.equal(history.length, 1);
  assert.equal(history[0].content, '原内容');
});

test('a formal memory can be edited after acceptance and keeps the old version', async () => {
  const plugin = await loadPlugin();
  const store = memoryStore({ [CANDIDATE_KEY]: JSON.stringify([candidate({ text: '第一版' })]) });
  const created = plugin.reviewCandidate('candidate-1', 'accept');
  const memory = created.memories[0];

  const edited = plugin.editMemory(memory.id, '第一版，已修正', memory.version);
  const active = edited.memories.filter((entry) => entry.status === 'active');
  assert.equal(active.length, 1);
  assert.equal(active[0].content, '第一版，已修正');
  assert.equal(active[0].version, 2);
  const history = edited.memories.filter((entry) => entry.id === memory.id && entry.status === 'superseded');
  assert.equal(history.length, 1);
  assert.equal(history[0].content, '第一版');

  assert.throws(() => plugin.editMemory(memory.id, '过期编辑', memory.version), /stale/);
  assert.throws(() => plugin.editMemory(memory.id, '   ', 2), /empty/);
  assert.equal(JSON.parse(store[FORMAL_KEY]).filter((entry) => entry.status === 'active').length, 1);
});
