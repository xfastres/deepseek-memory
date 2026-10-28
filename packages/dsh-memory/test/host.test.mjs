import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createMemoryApp } from '../host/http-app.js';
import {
  apply,
  createPingHandler,
  createPingTool,
  createRoutes,
  isLoopbackAddress,
  isLoopbackHostname,
  isTrustedRequest,
  PING_PATH,
  probeRuntime,
  probeSqlite,
} from '../index.js';

function makeRequest({ remoteAddress = '127.0.0.1', method = 'GET', headers = {} } = {}) {
  return {
    method,
    socket: { remoteAddress },
    headers: { host: '127.0.0.1:51840', ...headers },
  };
}

function makeResponse() {
  const captured = { status: 0, headers: null, body: '' };
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers; },
    end(body) { captured.body = body ?? ''; },
  };
}

async function callPing(request) {
  const res = makeResponse();
  await createPingHandler()(request, res);
  return { status: res.captured.status, json: JSON.parse(res.captured.body) };
}

test('the Host half exposes the ping probe plus the memory routes', () => {
  const routes = createRoutes({ dataDir: 'C:/tmp/never-touched', lookup: () => undefined });
  assert.equal(routes[0].kind, 'exact');
  assert.equal(routes[0].path, PING_PATH);
  assert.equal(typeof routes[0].handler, 'function');
  const paths = routes.map((route) => route.path);
  assert.deepEqual(paths, [
    PING_PATH,
    '/api/dsh-memory/state',
    '/api/dsh-memory/export',
    '/api/dsh-memory/add',
    '/api/dsh-memory/update',
    '/api/dsh-memory/retract',
    '/api/dsh-memory/migrate',
    '/api/dsh-memory/candidates',
    '/api/dsh-memory/candidate',
    '/api/dsh-memory/review',
  ]);
  assert.equal(new Set(paths).size, paths.length, 'route paths must be distinct');
  for (const route of routes) {
    assert.equal(route.kind, 'exact');
    assert.equal(typeof route.handler, 'function');
  }
});

test('building the route list touches no disk', () => {
  // A directory that does not exist stands in for a broken data path: only a
  // request may open it, never plugin activation.
  assert.doesNotThrow(() => createRoutes({ dataDir: 'C:/definitely/not/here', lookup: () => undefined }));
});

test('a loopback request with a loopback Host header gets a JSON answer', async () => {
  const { status, json } = await callPing(makeRequest());
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.plugin, '@local/dsh-memory');
  assert.equal(typeof json.time, 'string');
  assert.ok(!Number.isNaN(Date.parse(json.time)));
  assert.equal(typeof json.runtime.node, 'string');
  assert.equal(typeof json.runtime.sqlite.ok, 'boolean');
});

test('a same-origin browser Origin passes', async () => {
  const { status } = await callPing(makeRequest({ headers: { origin: 'http://127.0.0.1:51840' } }));
  assert.equal(status, 200);
});

test('non-loopback sockets, hosts, cross-site and foreign origins are refused', async () => {
  assert.equal((await callPing(makeRequest({ remoteAddress: '10.0.0.5' }))).status, 403);
  assert.equal((await callPing(makeRequest({ headers: { host: 'evil.example.com' } }))).status, 403);
  assert.equal((await callPing(makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
  assert.equal((await callPing(makeRequest({ headers: { origin: 'http://evil.example.com' } }))).status, 403);
  assert.equal((await callPing(makeRequest({ remoteAddress: null }))).status, 403);
  assert.equal((await callPing({ method: 'GET', headers: { host: '127.0.0.1:51840' } })).status, 403);
});

test('the fence only accepts get and head', async () => {
  assert.equal((await callPing(makeRequest({ method: 'POST' }))).status, 405);
  assert.equal((await callPing(makeRequest({ method: 'GET' }))).status, 200);
  assert.equal((await callPing(makeRequest({ method: 'HEAD' }))).status, 200);
});

test('the request fence recognises loopback shapes only', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.168.1.2'), false);
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('example.com'), false);
  assert.equal(isTrustedRequest(undefined), false);
  assert.equal(isTrustedRequest({ socket: { remoteAddress: '127.0.0.1' } }), false);
});

test('the runtime probe answers sqlite and trigram fts5 in one cached call', async () => {
  const first = await probeRuntime();
  assert.equal(typeof first.node, 'string');
  assert.equal(typeof first.sqlite.ok, 'boolean');
  assert.equal(typeof first.sqlite.fts5, 'boolean');
  assert.equal(typeof first.sqlite.trigram, 'boolean');
  assert.equal(await probeSqlite(), first.sqlite);
  assert.equal(await probeSqlite(), await probeSqlite());
});

test('the ping tool is a well-formed read-only tool definition', async () => {
  const tool = createPingTool();
  assert.equal(tool.name, 'dsh_memory_ping');
  assert.equal(typeof tool.description, 'string');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(typeof tool.output.schema, 'object');
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(typeof tool.execute, 'function');
  const value = await tool.execute({}, {});
  assert.equal(value.ok, true);
  assert.equal(value.plugin, '@local/dsh-memory');
  assert.equal(typeof value.runtime.sqlite.ok, 'boolean');
  const blocks = tool.output.render({}, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /dsh-memory/);
});

test('apply registers every route and the tool through the documented service access', () => {
  const registered = [];
  const tooled = [];
  const webServer = { register(route) { registered.push(route); return () => {}; } };
  const tools = { register(definition) { tooled.push(definition); return () => {}; } };
  const ctx = {
    get: (name) => ({ webServer, tools })[name],
    effect: (fn) => { fn(); return () => {}; },
  };
  apply(ctx);
  assert.equal(registered.length, 10);
  assert.equal(registered[0].path, PING_PATH);
  assert.equal(tooled.length, 1);
  assert.equal(tooled[0].name, 'dsh_memory_ping');
});

test('apply also works when services arrive as context properties', () => {
  const registered = [];
  const webServer = { register(route) { registered.push(route); return () => {}; } };
  apply({ webServer });
  assert.equal(registered.length, 10);
  assert.equal(registered[0].path, PING_PATH);
});

test('apply never throws and registers the route once a web server exists', () => {
  const registered = [];
  const webServer = { register(route) { registered.push(route); return () => {}; } };

  assert.doesNotThrow(() => apply(undefined));
  assert.doesNotThrow(() => apply({}));
  assert.doesNotThrow(() => apply({ get: () => undefined }));
  assert.doesNotThrow(() => apply({ get: () => ({ register() { throw new Error('boom'); } }) }));

  apply({ get: (name) => (name === 'webServer' ? webServer : undefined), effect: (fn) => { fn(); return () => {}; } });
  assert.equal(registered.length, 10);
  assert.equal(registered[0].path, PING_PATH);
});

test('one broken registration does not disable the others', () => {
  const listeners = [];
  const systemPrompt = { context() { return () => {}; } };
  const ctx = {
    get: (name) => ({
      tools: { register() { throw new Error('invalid definition'); } },
      systemPrompt,
    })[name],
    effect: (fn) => { fn(); return () => {}; },
    on: (event, handler) => { listeners.push({ event, handler }); return () => {}; },
  };
  apply(ctx);
  assert.equal(listeners.length, 1, 'the step observer still registers when the tool is refused');
});

test('the ping tool schema stays inside the documented schema node shape', () => {
  const tool = createPingTool();
  assert.equal(typeof tool.output.schema.properties.injection.type, 'string', 'type must be one name, never an array');
});

test('apply keeps an empty ledger entirely out of prompt assembly', () => {
  const contexts = [];
  const systemPrompt = { context(entry) { contexts.push(entry); return () => {}; } };
  apply({
    get: (name) => ({ systemPrompt })[name],
    effect: (fn) => { fn(); return () => {}; },
    on: () => () => {},
  });
  assert.equal(contexts.length, 0, 'an empty store registers no prompt context at all');
});

test('the step observer records the query and feeds the probe', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-wire-'));
  const previous = process.env.DSH_MEMORY_DATA_DIR;
  process.env.DSH_MEMORY_DATA_DIR = dir;
  try {
    const contexts = [];
    const listeners = [];
    const tooled = [];
    const systemPrompt = { context(entry) { contexts.push(entry); return () => {}; } };
    const tools = { register(definition) { tooled.push(definition); return () => {}; } };
    const ctx = {
      get: (name) => ({ systemPrompt, tools })[name],
      effect: (fn) => { fn(); return () => {}; },
      on: (event, handler) => { listeners.push({ event, handler }); return () => {}; },
    };
    apply(ctx);

    let stepped = false;
    const decision = { kind: 'enter', messages: [] };
    // The Host binds a listener to its scope, so record under that same object.
    const result = await listeners[0].handler.call(
      ctx,
      { agent: { id: 'session-x' }, messages: [{ role: 'user', content: '记住 pnpm 是包管理器' }], turn: 2, step: 1 },
      () => { stepped = true; return decision; },
    );
    assert.equal(stepped, true);
    assert.deepEqual(result, decision);
    assert.equal(contexts.length, 0, 'an empty ledger still registers no prompt context');

    const probe = await tooled[0].execute();
    assert.equal(probe.injection.memories, 0);
    assert.equal(probe.injection.observed, 'scope', 'the step was recorded under the bound scope object');
    assert.equal(probe.injection.last_turn, 2);
    assert.ok(probe.injection.last_query_chars > 0);
    assert.equal(typeof probe.injection.snapshot_at, 'string');
    assert.equal(probe.injection.candidates, 1, 'the durable sentence is proposed');
    assert.equal(probe.injection.candidate_sample[0].rule, 'instruction');
    assert.ok(probe.injection.candidate_sample[0].text.includes('pnpm'));
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_DATA_DIR;
    else process.env.DSH_MEMORY_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a ledger with an active memory reaches the prompt, and only then', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-prompt-'));
  const previous = process.env.DSH_MEMORY_DATA_DIR;
  process.env.DSH_MEMORY_DATA_DIR = dir;
  try {
    const ref = { session_id: 'session-x', event_seq: 2, event_type: 'user/message' };
    const seed = createMemoryApp({ dataDir: dir });
    await seed.service.add({ content: '这个项目用 pnpm，不用 npm', type: 'fact', sourceRefs: [ref] });

    const contexts = [];
    const listeners = [];
    const systemPrompt = { context(entry) { contexts.push(entry); return () => {}; } };
    const ctx = {
      get: (name) => ({ systemPrompt })[name],
      effect: (fn) => { fn(); return () => {}; },
      on: (event, handler) => { listeners.push({ event, handler }); return () => {}; },
    };
    apply(ctx);
    assert.equal(contexts.length, 0, 'nothing is registered before the first step');

    await listeners[0].handler.call(
      ctx,
      { agent: { id: 'session-x' }, messages: [{ role: 'user', content: 'pnpm 怎么装依赖' }], turn: 1, step: 1 },
      () => ({ kind: 'enter', messages: [] }),
    );

    assert.equal(contexts.length, 1, 'the step boundary registers the context');
    assert.equal(contexts[0].name, 'dsh-memory');
    const text = contexts[0].text({ scope: ctx });
    assert.match(text, /pnpm/);
  } finally {
    if (previous === undefined) delete process.env.DSH_MEMORY_DATA_DIR;
    else process.env.DSH_MEMORY_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
