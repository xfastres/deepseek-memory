import assert from 'node:assert/strict';
import { test } from 'node:test';

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

test('the Host half exposes exactly one exact ping route', () => {
  const routes = createRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'exact');
  assert.equal(routes[0].path, PING_PATH);
  assert.equal(typeof routes[0].handler, 'function');
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

test('apply registers both the route and the tool when services exist', () => {
  const registered = [];
  const tooled = [];
  const webServer = { register(route) { registered.push(route); return () => {}; } };
  const tools = { register(definition) { tooled.push(definition); return () => {}; } };
  const lookup = { webServer, tools };
  const scoped = {
    get: (name) => lookup[name],
    effect: (fn) => { fn(); return () => {}; },
  };
  apply({ inject: (_deps, callback) => callback(scoped) });
  assert.equal(registered.length, 1);
  assert.equal(tooled.length, 1);
  assert.equal(tooled[0].name, 'dsh_memory_ping');
});

test('apply never throws and registers the route once a web server exists', () => {
  const registered = [];
  const webServer = { register(route) { registered.push(route); return () => {}; } };

  assert.doesNotThrow(() => apply(undefined));
  assert.doesNotThrow(() => apply({}));
  assert.doesNotThrow(() => apply({ get: () => undefined }));
  assert.doesNotThrow(() => apply({ get: () => ({ register() { throw new Error('boom'); } }) }));

  const scoped = { get: (name) => (name === 'webServer' ? webServer : undefined), effect: (fn) => { fn(); return () => {}; } };
  apply({ inject: (_deps, callback) => callback(scoped) });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, PING_PATH);
});
