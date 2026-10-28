import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPersona, personaFresh, personaVersion } from '../host/persona.js';

function memory(id, extra = {}) {
  return {
    id,
    status: 'active',
    scope: 'global',
    type: 'preference',
    content: `偏好 ${id}`,
    accepted_at: '2026-10-20T00:00:00.000Z',
    entities: ['tone'],
    ...extra,
  };
}

test('two memories on one topic become one persona line with sources', () => {
  const persona = buildPersona([
    memory('M-1', { content: '回答要简洁' }),
    memory('M-2', { content: '不要长篇铺垫', accepted_at: '2026-10-22T00:00:00.000Z' }),
  ]);
  assert.equal(persona.lines.length, 1);
  assert.equal(persona.lines[0].count, 2);
  assert.deepEqual(persona.lines[0].sources, ['M-2', 'M-1'], 'newest member first');
  assert.equal(persona.lines[0].text, '不要长篇铺垫', 'the line quotes the newest member verbatim');
});

test('one memory is not a pattern', () => {
  const persona = buildPersona([memory('M-1')]);
  assert.deepEqual(persona.lines, []);
  assert.equal(persona.considered, 1);
});

test('only preferences, instructions and decisions count', () => {
  const persona = buildPersona([
    memory('M-1', { type: 'fact' }),
    memory('M-2', { type: 'fact' }),
    memory('M-3', { type: 'event' }),
  ]);
  assert.deepEqual(persona.lines, []);
});

test('retracted memories never reach the persona', () => {
  const persona = buildPersona([
    memory('M-1'),
    memory('M-2', { status: 'retracted' }),
  ]);
  assert.deepEqual(persona.lines, [], 'a withdrawn statement must not support a profile line');
});

test('memories with no entity do not merge into one vague line', () => {
  const persona = buildPersona([
    memory('M-1', { entities: [] }),
    memory('M-2', { entities: [] }),
  ]);
  assert.deepEqual(persona.lines, [], 'two unrelated statements are not a pattern');
});

test('a long headline is clipped instead of injected whole', () => {
  const long = 'x'.repeat(200);
  const persona = buildPersona([
    memory('M-1', { content: long }),
    memory('M-2'),
  ], { headlineLength: 20 });
  assert.equal(persona.lines[0].text.length, 21);
  assert.ok(persona.lines[0].text.endsWith('…'));
});

test('the persona version follows the ledger head', () => {
  assert.equal(personaVersion('0123456789abcdef'), '0123456789ab');
  assert.equal(personaVersion(''), null);
  assert.equal(personaVersion(undefined), null);
  assert.equal(personaFresh({ version: '0123456789ab' }, '0123456789abcdef'), true);
  assert.equal(personaFresh({ version: '0123456789ab' }, 'ffffffffffff'), false);
  assert.equal(personaFresh(null, '0123456789abcdef'), false);
});

test('hostile input yields an empty persona rather than an exception', () => {
  assert.deepEqual(buildPersona(undefined).lines, []);
  assert.deepEqual(buildPersona([null, {}, { id: 'M-1' }]).lines, []);
});
