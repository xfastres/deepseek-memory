import test from 'node:test';
import assert from 'node:assert/strict';

import { clusterMemories, summarisable } from '../host/scenarios.js';

function memory(id, extra = {}) {
  return {
    id,
    status: 'active',
    scope: 'global',
    type: 'fact',
    content: `记忆 ${id}`,
    accepted_at: '2026-10-20T00:00:00.000Z',
    source_refs: [{ session_id: 'session-a', event_seq: 1, event_type: 'user/message' }],
    ...extra,
  };
}

test('three memories from one session become one scenario', () => {
  const { scenarios } = clusterMemories([
    memory('M-1'),
    memory('M-2'),
    memory('M-3'),
  ]);
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].kind, 'session');
  assert.deepEqual(scenarios[0].members.sort(), ['M-1', 'M-2', 'M-3']);
  assert.equal(scenarios[0].summary, null, 'a structural scenario never invents text');
  assert.equal(scenarios[0].origin, 'structural');
});

test('two memories from one session stay separate', () => {
  const { scenarios, orphans } = clusterMemories([memory('M-1'), memory('M-2')]);
  assert.equal(scenarios.length, 0);
  assert.deepEqual(orphans.sort(), ['M-1', 'M-2']);
});

test('a session spread beyond the window is not one episode', () => {
  const { scenarios } = clusterMemories([
    memory('M-1', { accepted_at: '2026-09-01T00:00:00.000Z' }),
    memory('M-2', { accepted_at: '2026-10-20T00:00:00.000Z' }),
    memory('M-3', { accepted_at: '2026-10-21T00:00:00.000Z' }),
  ]);
  assert.equal(scenarios.length, 0);
});

test('a shared entity links memories across sessions', () => {
  const { scenarios } = clusterMemories([
    memory('M-1', { entities: ['dsh-memory'], source_refs: [{ session_id: 'session-a', event_seq: 1 }] }),
    memory('M-2', { entities: ['dsh-memory'], source_refs: [{ session_id: 'session-b', event_seq: 2 }] }),
  ]);
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].kind, 'entity');
});

test('inactive memories never join a scenario', () => {
  const { scenarios, orphans } = clusterMemories([
    memory('M-1'),
    memory('M-2'),
    memory('M-3', { status: 'retracted' }),
    memory('M-4', { status: 'superseded' }),
  ]);
  assert.equal(scenarios.length, 0);
  assert.deepEqual(orphans.sort(), ['M-1', 'M-2']);
});

test('the same member set is not reported twice under two signals', () => {
  const shared = { entities: ['x'], accepted_at: '2026-10-20T00:00:00.000Z' };
  const { scenarios } = clusterMemories([
    memory('M-1', shared),
    memory('M-2', shared),
    memory('M-3', shared),
  ]);
  assert.equal(scenarios.length, 1);
});

test('a summary is only allowed while every member is still active', () => {
  const memories = [memory('M-1'), memory('M-2')];
  const scenario = { members: ['M-1', 'M-2'] };
  assert.equal(summarisable(scenario, memories), true);
  assert.equal(summarisable(scenario, [memory('M-1'), memory('M-2', { status: 'retracted' })]), false);
  assert.equal(summarisable(scenario, [memory('M-1')]), false);
  assert.equal(summarisable(null, memories), false);
});

test('hostile input yields no scenarios rather than an exception', () => {
  assert.deepEqual(clusterMemories(undefined).scenarios, []);
  assert.deepEqual(clusterMemories([null, {}, { id: 'M-1' }]).scenarios, []);
});

test('two sessions with the same long prefix stay two scenarios', () => {
  const prefix = 'session-'.repeat(6);
  const { scenarios } = clusterMemories([
    memory('M-1', { source_refs: [{ session_id: prefix + '-a', event_seq: 1, event_type: 'user/message' }] }),
    memory('M-2', { source_refs: [{ session_id: prefix + '-a', event_seq: 2, event_type: 'user/message' }] }),
    memory('M-3', { source_refs: [{ session_id: prefix + '-a', event_seq: 3, event_type: 'user/message' }] }),
    memory('M-4', { source_refs: [{ session_id: prefix + '-b', event_seq: 1, event_type: 'user/message' }] }),
    memory('M-5', { source_refs: [{ session_id: prefix + '-b', event_seq: 2, event_type: 'user/message' }] }),
    memory('M-6', { source_refs: [{ session_id: prefix + '-b', event_seq: 3, event_type: 'user/message' }] }),
  ]);
  const sessionScenarios = scenarios.filter((scenario) => scenario.kind === 'session');
  assert.equal(sessionScenarios.length, 2, 'two different sessions are two episodes');
  assert.notEqual(sessionScenarios[0].id, sessionScenarios[1].id, 'a clipped prefix must not decide identity');
  assert.equal(sessionScenarios[0].members.length, 3);
  assert.equal(sessionScenarios[1].members.length, 3);
});
