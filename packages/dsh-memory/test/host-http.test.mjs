// End-to-end HTTP check for the Host route: a real loopback server, real
// requests, real JSON. This proves the handler behaves over the wire; that DSH
// itself mounts it is proven separately by loading the plugin inside the app.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { createPingHandler, PING_PATH } from '../index.js';

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

function request(port, { path = PING_PATH, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const sent = { host: `127.0.0.1:${port}`, ...headers };
    import('node:http').then(({ request: httpRequest }) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: sent }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
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
    server.close();
  }
});

test('a foreign Host header is refused over a real socket', async () => {
  const { server, port } = await listen();
  try {
    const response = await request(port, { headers: { host: 'evil.example.com' } });
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error, 'forbidden');
  } finally {
    server.close();
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
    server.close();
  }
});

test('wrong methods are rejected with JSON rather than a crash', async () => {
  const { server, port } = await listen();
  try {
    const response = await request(port, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(JSON.parse(response.body).error, 'method-not-allowed');
  } finally {
    server.close();
  }
});
