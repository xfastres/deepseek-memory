// End-to-end HTTP check for the Host route: a real loopback server, real
// requests, real JSON. This proves the handler behaves over the wire; that DSH
// itself mounts it is proven separately by loading the plugin inside the app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPingHandler, createRoutes, PING_PATH } from '../index.js';

function listen() {
  const handler = createPingHandler();
  const server = createServer((req, res) => {
    if (req.url === PING_PATH) {
      handler(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function request(port, { path = PING_PATH, method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const sent = { host: `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) sent['content-length'] = String(payload.length);
    import('node:http').then(({ request: httpRequest }) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    }, reject);
  });
}

test('a loopback browser-ish request gets JSON over a real socket', async () => {
  const { server, port } = await listen();
  try {
    const response = await request(port, {
      headers: { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = JSON.parse(response.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.pid, 'number');
  } finally {
    server.closeAllConnections?.();    server.close();
  }
});

test('a foreign Host header is refused over a real socket', async () => {
  const { server, port } = await listen();
  try {
    const response = await request(port, { headers: { host: 'evil.example.com' } });
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error, 'forbidden');
  } finally {
    server.closeAllConnections?.();    server.close();
  }
});

test('a cross-site request is refused, and an unknown path stays 404', async () => {
  const { server, port } = await listen();
  try {
    const crossSite = await request(port, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);

    const missing = await request(port, { path: '/api/dsh-memory/unknown' });
    assert.equal(missing.status, 404);
  } finally {
    server.closeAllConnections?.();    server.close();
  }
});

test('wrong methods are rejected with JSON rather than a crash', async () => {
  const { server, port } = await listen();
  try {
    const response = await request(port, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(JSON.parse(response.body).error, 'method-not-allowed');
  } finally {
    server.closeAllConnections?.();    server.close();
  }
});

function listenAll(dataDir) {
  const routes = createRoutes({ dataDir, lookup: () => undefined });
  const table = new Map(routes.map((route) => [route.path, route.handler]));
  const server = createServer((req, res) => {
    const handler = table.get(req.url);
    if (handler) { handler(req, res); return; }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test('the memory routes answer over a real socket, with the fence intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-http-'));
  const { server, port } = await listenAll(dir);
  try {
    const state = await request(port, { path: '/api/dsh-memory/state' });
    assert.equal(state.status, 200);
    const parsed = JSON.parse(state.body);
    assert.equal(parsed.ok, true);
    assert.ok(Array.isArray(parsed.memories));

    const forged = await request(port, { path: '/api/dsh-memory/state', headers: { host: 'evil.example.com' } });
    assert.equal(forged.status, 403);

    const crossSite = await request(port, {
      path: '/api/dsh-memory/add',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'http://evil.example.com' },
      body: { content: '从别的站点写入', sourceRef: { session_id: 's', event_seq: 1 } },
    });
    assert.equal(crossSite.status, 403, 'a cross-site page cannot mutate memories');
    const after = await request(port, { path: '/api/dsh-memory/state' });
    assert.equal(JSON.parse(after.body).memories.length, 0, 'the refused write left nothing behind');
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
