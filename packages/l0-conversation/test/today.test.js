import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewText, readToday } from '../src/today.js';

const at = (iso) => Date.parse(iso);
const event = (seq, time, type, data = {}) => ({ seq, time, type, data });
const boundary = (seq, time, type, turn, reason = 'completed') => event(seq, time, type, { turn, ...(type === 'turn/end' ? { reason: { kind: reason } } : {}) });
const user = (seq, time, text, source = { kind: 'user' }) => event(seq, time, 'user/message', { role: 'user', source, content: [{ type: 'text', text }] });
function snapshot(id, events, origin) {
  return { session: { id, ...(origin ? { origin } : {}) }, events };
}

test('preview is verbatim direct-user text, truncates for display, and excludes injected context', () => {
  const turn = { session_id: 'a', events: [
    user(1, 0, 'not human context', { kind: 'time-context' }),
    user(2, 1, 'first\n'),
    user(3, 2, 'second'),
  ] };
  assert.deepEqual(previewText(turn, 5), { text: 'first…', truncated: true, source_refs: [{ session_id: 'a', event_seq: 2 }, { session_id: 'a', event_seq: 3 }] });
});

test('today combines only main-session turns from the local day and retains failed reads as warnings', async () => {
  const snapshots = {
    today: snapshot('today', [boundary(0, at('2026-10-27T01:00:00Z'), 'turn/start', 1), user(1, at('2026-10-27T01:00:01Z'), 'remember this'), boundary(2, at('2026-10-27T01:00:02Z'), 'turn/end', 1)]),
    yesterday: snapshot('yesterday', [boundary(0, at('2026-10-26T01:00:00Z'), 'turn/start', 1), user(1, at('2026-10-26T01:00:01Z'), 'old'), boundary(2, at('2026-10-26T01:00:02Z'), 'turn/end', 1)]),
    child: snapshot('child', [boundary(0, at('2026-10-27T02:00:00Z'), 'turn/start', 1), user(1, at('2026-10-27T02:00:01Z'), 'internal'), boundary(2, at('2026-10-27T02:00:02Z'), 'turn/end', 1)], 'subagent'),
    other: snapshot('other', [boundary(0, at('2026-10-27T03:00:00Z'), 'turn/start', 1), user(1, at('2026-10-27T03:00:01Z'), 'second session'), boundary(2, at('2026-10-27T03:00:02Z'), 'turn/end', 1)]),
  };
  const sessionQuery = {
    async listSessions() { return Object.values(snapshots).map((snapshot) => ({ header: snapshot.session })); },
    async readSession(id) { if (id === 'broken') throw new Error('unreadable'); return snapshots[id]; },
  };
  snapshots.broken = snapshot('broken', []);
  const result = await readToday({ sessionQuery, now: new Date('2026-10-27T04:00:00Z') });
  assert.equal(result.date, '2026-10-27');
  assert.deepEqual(result.turns.map((turn) => [turn.id, turn.text]), [['other:1', 'second session'], ['today:1', 'remember this']]);
  assert.deepEqual(result.warnings, [{ session_id: 'broken', message: 'unreadable' }]);
});
