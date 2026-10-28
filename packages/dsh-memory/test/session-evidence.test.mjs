import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSourceRef,
  createEvidenceResolver,
  quoteDigest,
  turnUserMessageSeq,
} from '../host/session-evidence.js';

// A small but realistic log: two turns, with tool traffic between the messages.
const LOG = [
  { seq: 1, type: 'session/start' },
  { seq: 2, type: 'turn/start' },
  { seq: 3, type: 'user/message' },
  { seq: 4, type: 'assistant/message' },
  { seq: 5, type: 'tool/call' },
  { seq: 6, type: 'tool/result' },
  { seq: 7, type: 'turn/end' },
  { seq: 8, type: 'turn/start' },
  { seq: 9, type: 'assistant/message' },
  { seq: 10, type: 'user/message' },
  { seq: 11, type: 'turn/end' },
];

test('the first user message inside the requested turn is the evidence', () => {
  assert.equal(turnUserMessageSeq(LOG, 1), 3);
  assert.equal(turnUserMessageSeq(LOG, 2), 10);
});

test('a turn without a user message proves nothing', () => {
  const noUser = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message' },
    { seq: 3, type: 'turn/end' },
  ];
  assert.equal(turnUserMessageSeq(noUser, 1), undefined);
});

test('out-of-range and malformed turn ordinals are refused', () => {
  assert.equal(turnUserMessageSeq(LOG, 0), undefined);
  assert.equal(turnUserMessageSeq(LOG, 3), undefined);
  assert.equal(turnUserMessageSeq(LOG, -1), undefined);
  assert.equal(turnUserMessageSeq(LOG, 1.5), undefined);
  assert.equal(turnUserMessageSeq(null, 1), undefined);
});

test('records are ordered by seq, not by arrival order', () => {
  const shuffled = [...LOG].reverse();
  assert.equal(turnUserMessageSeq(shuffled, 1), 3);
  assert.equal(turnUserMessageSeq(shuffled, 2), 10);
});

test('a user message before the first turn start is never evidence', () => {
  const seeded = [
    { seq: 1, type: 'user/message' },
    { seq: 2, type: 'turn/start' },
    { seq: 3, type: 'assistant/message' },
  ];
  assert.equal(turnUserMessageSeq(seeded, 1), undefined);
});

test('a source ref carries the session, the seq and the event type', () => {
  const ref = buildSourceRef(LOG, { sessionId: 'session-a', turn: 2 });
  assert.deepEqual(ref, { session_id: 'session-a', event_seq: 10, event_type: 'user/message' });
  assert.equal(buildSourceRef(LOG, { sessionId: 'session-a', turn: 9 }), undefined);
});

test('the quote digest is a stable sha256 of the exact text', () => {
  assert.equal(quoteDigest('abc').length, 64);
  assert.equal(quoteDigest('abc'), quoteDigest('abc'));
  assert.notEqual(quoteDigest('abc'), quoteDigest('abd'));
  assert.equal(quoteDigest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the resolver reads the log through the service and returns a real ref', async () => {
  const calls = [];
  const resolver = createEvidenceResolver({
    sessionQuery: {
      async listEvents(sessionId) { calls.push(sessionId); return LOG; },
    },
  });
  assert.deepEqual(await resolver.resolve({ sessionId: 'session-a', turn: 1 }), {
    session_id: 'session-a', event_seq: 3, event_type: 'user/message',
  });
  assert.deepEqual(calls, ['session-a']);
  assert.equal(await resolver.resolve({ sessionId: 'session-a', turn: 7 }), undefined);
});

test('a confirmed ordinal resolves to the turn start the log agrees with', async () => {
  const read = [];
  const resolver = createEvidenceResolver({
    sessionQuery: {
      async listEvents() { return LOG; },
      async readEvent({ seq }) { read.push(seq); return { target: { seq, type: 'turn/start', data: { turn: seq <= 3 ? 1 : 2 } } }; },
    },
  });
  assert.equal((await resolver.resolve({ sessionId: 'session-a', turn: 2 })).event_seq, 10);
  assert.deepEqual(read, [8]);
});

test('non-contiguous turn numbers are corrected by reading, not guessed', async () => {
  // Turn numbering restarts oddly: the second turn/start carries turn 5.
  const LOG_ODD = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'user/message' },
    { seq: 3, type: 'turn/end' },
    { seq: 4, type: 'turn/start' },
    { seq: 5, type: 'user/message' },
    { seq: 6, type: 'turn/end' },
  ];
  const turnsBySeq = { 1: 1, 4: 5 };
  const resolver = createEvidenceResolver({
    sessionQuery: {
      async listEvents() { return LOG_ODD; },
      async readEvent({ seq }) { return { target: { seq, type: 'turn/start', data: { turn: turnsBySeq[seq] } } }; },
    },
  });
  // Asking for turn 5 finds the second turn/start even though it is the 2nd.
  assert.equal((await resolver.resolve({ sessionId: 'session-a', turn: 5 })).event_seq, 5);
  // The ordinal guess for turn 2 is rejected: no turn start carries turn 2.
  assert.equal(await resolver.resolve({ sessionId: 'session-a', turn: 2 }), undefined);
});

test('a turn whose user message is missing yields no ref instead of a wrong one', async () => {
  const NO_USER = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message' },
    { seq: 3, type: 'turn/end' },
  ];
  const resolver = createEvidenceResolver({
    sessionQuery: {
      async listEvents() { return NO_USER; },
      async readEvent({ seq }) { return { target: { seq, data: { turn: 1 } } }; },
    },
  });
  assert.equal(await resolver.resolve({ sessionId: 'session-a', turn: 1 }), undefined);
});

test('verification reports missing, mismatched and unreadable evidence', async () => {
  const resolver = createEvidenceResolver({
    sessionQuery: {
      async listEvents(sessionId) {
        if (sessionId === 'gone') throw new Error('no such session');
        return LOG;
      },
    },
  });

  assert.deepEqual(await resolver.verify([{ session_id: 'session-a', event_seq: 3, event_type: 'user/message' }]), { verified: true });

  const missing = await resolver.verify([{ session_id: 'session-a', event_seq: 99 }]);
  assert.equal(missing.verified, false);
  assert.equal(missing.missing[0].reason, 'event-missing');

  const mismatch = await resolver.verify([{ session_id: 'session-a', event_seq: 3, event_type: 'tool/result' }]);
  assert.equal(mismatch.missing[0].reason, 'event-type-mismatch');
  assert.equal(mismatch.missing[0].actual, 'user/message');

  const unreadable = await resolver.verify([{ session_id: 'gone', event_seq: 3 }]);
  assert.equal(unreadable.missing[0].reason, 'session-unreadable');
});

test('a resolver refuses to be built without a usable service', () => {
  assert.throws(() => createEvidenceResolver({}), /listEvents/);
  assert.throws(() => createEvidenceResolver({ sessionQuery: {} }), /listEvents/);
});
