// Pure L0 read model: raw DSH events in, browsable turns and date groups out.
// This module never reads or writes session files and never invents a turn end.

/** Group one session's events by their explicit turn/start and turn/end brackets. */
export function projectTurns(snapshot) {
  const { session, events, inheritedEventCount = 0 } = snapshot;
  const turns = [];
  let current;
  for (const event of events) {
    if (event.seq < inheritedEventCount) continue;
    if (event.type === 'turn/start') {
      if (current !== undefined) throw new Error(`turn ${current.turn} is still open at seq ${event.seq}`);
      current = {
        session_id: session.id,
        origin: session.origin ?? null,
        turn: event.data.turn,
        start_seq: event.seq,
        end_seq: null,
        started_at: event.time,
        ended_at: null,
        status: 'in_progress',
        end_reason: null,
        events: [],
      };
      turns.push(current);
    }
    if (current !== undefined) current.events.push(event);
    if (event.type === 'turn/end' && current !== undefined) {
      if (event.data.turn !== current.turn) throw new Error(`turn/end ${event.data.turn} does not match turn ${current.turn}`);
      current.end_seq = event.seq;
      current.ended_at = event.time;
      current.end_reason = event.data.reason;
      current.status = event.data.reason.kind === 'completed' ? 'completed' : 'closed_incomplete';
      current = undefined;
    }
  }
  return turns;
}

/** Return only turns whose recorded end reason permits default M1 extraction. */
export function completedTurns(turns) {
  return turns.filter((turn) => turn.status === 'completed');
}

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Group turns newest-first by their start time in the selected display timezone. */
export function groupTurnsByDate(turns) {
  const groups = new Map();
  for (const turn of turns) {
    const date = dateFormatter.format(new Date(turn.started_at));
    const group = groups.get(date) ?? { date, turns: [] };
    group.turns.push(turn);
    groups.set(date, group);
  }
  return [...groups.values()].sort((left, right) => right.date.localeCompare(left.date));
}

/** Main timeline excludes delegated internal sessions; technical views may still read them. */
export function userFacingTurns(turns) {
  return turns.filter((turn) => turn.origin !== 'subagent');
}

/** A display-only message projection; it does not decide extraction eligibility. */
export function turnMessages(turn) {
  return turn.events.filter((event) => ['user/message', 'assistant/message', 'tool/result'].includes(event.type)).map((event) => ({
    seq: event.seq,
    type: event.type,
    time: event.time,
    role: event.type === 'user/message' ? event.data.role : event.data.message.role,
    source_kind: event.type === 'user/message' ? event.data.source?.kind : event.data.message.source?.kind,
  }));
}
