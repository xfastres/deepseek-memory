import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, createRoutes, PING_PATH } from '../index.js';

function fakeContext({ tools = [], webServer = { register() { return () => {}; } } } = {}) {
  return {
    get: (name) => ({ webServer, tools })[name],
    effect: (fn) => { fn(); return () => {}; },
  };
}

test('the diagnostic snapshot names the constraint, log and flush stages', async () => {
  const definitions = [];
  const tools = { register(definition) { definitions.push(definition); return () => {}; } };
  apply(fakeContext({ tools }));
  const tool = definitions.find((definition) => definition.name === 'dsh_memory_ping');
  assert.ok(tool !== undefined, 'the ping tool is registered');
  const value = await tool.execute();
  const snapshot = value.injection;
  assert.ok(snapshot !== null && typeof snapshot === 'object', 'the status object is reachable');
  assert.ok(snapshot.constraints !== undefined, 'configuration state is visible');
  assert.equal(typeof snapshot.constraints.loaded, 'boolean');
  assert.ok(Array.isArray(snapshot.constraints.rejected));
  assert.ok(snapshot.injection_log !== undefined, 'provider counters are visible');
  assert.equal(typeof snapshot.injection_log.calls, 'number');
  assert.equal(typeof snapshot.injection_log.empty, 'number');
  assert.equal(typeof snapshot.injection_log.records, 'number');
  assert.ok(snapshot.flush !== undefined, 'flush state is visible');
  assert.equal(snapshot.injection_log.confirmed, undefined, 'no receipt means no confirmed count to report');
});

test('the diagnostic snapshot never carries full memory text', async () => {
  const definitions = [];
  const tools = { register(definition) { definitions.push(definition); return () => {}; } };
  apply(fakeContext({ tools }));
  const tool = definitions.find((definition) => definition.name === 'dsh_memory_ping');
  const serialised = JSON.stringify(await tool.execute());
  assert.ok(serialised.length < 4000, 'the snapshot stays small');
  assert.ok(!serialised.includes('以下内容已截断'), 'no memory body leaks into the probe');
});

test('the route table stays exact-match and distinct after adding injections', () => {
  const routes = createRoutes({ dataDir: 'C:/tmp/never-touched', lookup: () => undefined });
  assert.equal(routes[0].path, PING_PATH);
  const paths = routes.map((route) => route.path);
  assert.ok(paths.includes('/api/dsh-memory/injections'));
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(routes.every((route) => route.kind === 'exact'));
});
