import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedTurns, groupTurnsByDate, projectTurns, turnMessages, userFacingTurns } from '../src/index.js';

const session = { id: 'fixture-session' };
const at = (iso) => Date.parse(iso);
const event = (seq, time, type, data = {}) => ({ seq, time, type, data });
const boundary = (seq, time, type, turn, reason) => event(seq, time, type, { turn, ...(reason ? { reason: { kind: reason } } : {}) });

test('completed turns retain exact evidence range and are the only default extraction candidates', () => {
  const turns = projectTurns({ session, events: [
    boundary(0, at('2026-10-27T01:00:00Z'), 'turn/start', 1),
    event(1, at('2026-10-27T01:00:01Z'), 'user/message', { role: 'user', source: { kind: 'user' }, content: [] }),
    boundary(2, at('2026-10-27T01:00:02Z'), 'turn/end', 1, 'completed'),
    boundary(3, at('2026-10-27T02:00:00Z'), 'turn/start', 2),
    boundary(4, at('2026-10-27T02:00:02Z'), 'turn/end', 2, 'aborted'),
    boundary(5, at('2026-10-27T03:00:00Z'), 'turn/start', 3),
  ] });
  assert.deepEqual(turns.map((turn) => turn.status), ['completed', 'closed_incomplete', 'in_progress']);
  assert.deepEqual(completedTurns(turns).map((turn) => [turn.start_seq, turn.end_seq]), [[0, 2]]);
  assert.equal(turns[0].events[1].seq, 1);
  assert.deepEqual(turnMessages(turns[0]), [{ seq: 1, type: 'user/message', time: at('2026-10-27T01:00:01Z'), role: 'user', source_kind: 'user' }]);
});

test('date grouping uses turn start in Asia/Shanghai, including a UTC date boundary', () => {
  const turns = projectTurns({ session, events: [
    boundary(0, at('2026-10-26T16:00:00Z'), 'turn/start', 1),
    boundary(1, at('2026-10-26T16:01:00Z'), 'turn/end', 1, 'completed'),
    boundary(2, at('2026-10-26T15:59:59Z'), 'turn/start', 2),
    boundary(3, at('2026-10-26T16:00:01Z'), 'turn/end', 2, 'completed'),
  ] });
  assert.deepEqual(groupTurnsByDate(turns).map((group) => [group.date, group.turns.length]), [['2026-10-27', 1], ['2026-10-26', 1]]);
});

test('inherited events are not duplicated as new turns', () => {
  const turns = projectTurns({ session, inheritedEventCount: 2, events: [
    boundary(0, 0, 'turn/start', 1),
    boundary(1, 1, 'turn/end', 1, 'completed'),
    boundary(2, 2, 'turn/start', 2),
    boundary(3, 3, 'turn/end', 2, 'completed'),
  ] });
  assert.deepEqual(turns.map((turn) => turn.turn), [2]);
});

test('main timeline excludes delegated sessions but retains their separate raw source', () => {
  const delegated = projectTurns({ session: { id: 'child', origin: 'subagent' }, events: [boundary(0, 0, 'turn/start', 1)] });
  const user = projectTurns({ session, events: [boundary(0, 0, 'turn/start', 1)] });
  assert.equal(delegated[0].origin, 'subagent');
  assert.deepEqual(userFacingTurns([...delegated, ...user]).map((turn) => turn.session_id), ['fixture-session']);
});

test('nested or mismatched turn boundaries fail instead of creating false completed turns', () => {
  assert.throws(() => projectTurns({ session, events: [boundary(0, 0, 'turn/start', 1), boundary(1, 1, 'turn/start', 2)] }), /still open/);
  assert.throws(() => projectTurns({ session, events: [boundary(0, 0, 'turn/start', 1), boundary(1, 1, 'turn/end', 2, 'completed')] }), /does not match/);
});
