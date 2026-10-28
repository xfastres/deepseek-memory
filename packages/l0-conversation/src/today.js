import { projectTurns } from './index.js';

/** Plain text from a message's content blocks; no AI summary or rewriting. */
export function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n').trim();
}

/** Only direct user-channel text feeds the preview; injected context is not human speech. */
export function previewText(turn, maxChars = 180) {
  const texts = turn.events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'user')
    .map((event) => ({ seq: event.seq, text: messageText(event.data) })).filter((item) => item.text !== '');
  const full = texts.map((item) => item.text).join('\n');
  return {
    text: full.length > maxChars ? `${full.slice(0, maxChars)}…` : full,
    truncated: full.length > maxChars,
    source_refs: texts.map((item) => ({ session_id: turn.session_id, event_seq: item.seq })),
  };
}

/** Project today's user-facing turns, retaining failed reads as explicit warnings. */
export async function readToday({ sessionQuery, now = new Date(), timeZone = 'Asia/Shanghai', signal }) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const sessions = await sessionQuery.listSessions(signal);
  const turns = [];
  const warnings = [];
  for (const record of sessions) {
    signal?.throwIfAborted();
    if (record.header.origin === 'subagent') continue;
    try {
      const snapshot = await sessionQuery.readSession(record.header.id);
      for (const turn of projectTurns(snapshot)) {
        if (new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(turn.started_at)) !== day) continue;
        const preview = previewText(turn);
        if (preview.text === '') continue;
        turns.push({
          id: `${turn.session_id}:${turn.turn}`,
          session_id: turn.session_id,
          turn: turn.turn,
          started_at: turn.started_at,
          status: turn.status,
          ...preview,
        });
      }
    } catch (error) {
      warnings.push({ session_id: record.header.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  turns.sort((left, right) => right.started_at - left.started_at || left.id.localeCompare(right.id));
  return { date: day, time_zone: timeZone, turns, warnings };
}
