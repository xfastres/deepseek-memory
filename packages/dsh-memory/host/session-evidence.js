// Turn -> evidence resolution.
//
// The Git ledger refuses an active memory without a real source ref, and a ref
// must carry the Session's own `event_seq`. The UI only knows a turn ordinal,
// so this module maps one onto the exact event that proves the claim: the
// first `user/message` inside that turn. No text is copied and no seq is
// invented — when the event cannot be located the answer is `undefined` and
// the caller must not write.
//
// The lookup is a pure function over `(seq, type)` records, which is exactly
// what `sessionQuery.listEvents()` returns, so it is testable without a Host.

import { createHash } from 'node:crypto';

/** sha256 of the exact quoted text; the ledger stores this instead of a copy. */
export function quoteDigest(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** The exact user text of one event's data, or '' when it holds none. */
function eventText(data) {
  if (data === null || data === undefined) return '';
  const message = Array.isArray(data.content) ? data : (data.message ?? null);
  if (message === null || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function ordered(records) {
  return [...records].sort((left, right) => left.seq - right.seq);
}

/**
 * The seq of the first user message inside one turn.
 *
 * @param {Array<{seq: number, type: string}>} records ascending or unordered raw-log records
 * @param {number} turn 1-based ordinal among `turn/start` events, matching the UI
 * @returns {number|undefined} the event seq, or undefined when it is not provable
 */
export function turnUserMessageSeq(records, turn) {
  if (!Array.isArray(records) || !Number.isInteger(turn) || turn < 1) return undefined;
  const events = ordered(records);
  const starts = events.filter((record) => record.type === 'turn/start');
  if (turn > starts.length) return undefined;
  const startSeq = starts[turn - 1].seq;
  const endSeq = turn < starts.length ? starts[turn].seq : Number.POSITIVE_INFINITY;
  const message = events.find((record) => record.type === 'user/message' && record.seq > startSeq && record.seq < endSeq);
  return message === undefined ? undefined : message.seq;
}

/** Build the ledger source ref for a turn, or undefined when it cannot be proved. */
export function buildSourceRef(records, { sessionId, turn }) {
  const seq = turnUserMessageSeq(records, turn);
  if (seq === undefined) return undefined;
  return { session_id: String(sessionId), event_seq: seq, event_type: 'user/message' };
}

/**
 * Bind this module to a live `ctx.sessionQuery`. The returned resolver reads
 * the log through the documented service; it never touches session files.
 */
export function createEvidenceResolver({ sessionQuery }) {
  if (!sessionQuery || typeof sessionQuery.listEvents !== 'function') {
    throw new Error('sessionQuery with listEvents is required');
  }
  const canReadEvents = typeof sessionQuery.readEvent === 'function';

  async function turnOf(sessionId, seq) {
    const window = await sessionQuery.readEvent({ sessionId, seq });
    const data = window && window.target ? window.target.data : undefined;
    return data === undefined ? undefined : data.turn;
  }

  /**
   * Attach the sha256 of the exact words the ref points at, when the log can
   * be read. The roadmap asks a memory record to keep the original quote hash
   * so a later reader can tell whether the evidence still says what it said.
   * Nothing is invented: no readable text means no hash.
   */
  async function withQuote(ref) {
    if (ref === undefined || ref === null || !canReadEvents) return ref;
    let data;
    try {
      const window = await sessionQuery.readEvent({ sessionId: ref.session_id, seq: ref.event_seq });
      data = window && window.target ? window.target.data : undefined;
    } catch {
      return ref;
    }
    const text = eventText(data);
    if (text === '') return ref;
    return { ...ref, quote_sha256: quoteDigest(text) };
  }

  return {
    /**
     * Resolve one turn to a provable source ref.
     *
     * The ordinal is a guess until the log confirms it: fork, compaction and
     * import can leave `data.turn` non-contiguous. When the service can read
     * an event we confirm the ordinal and, if it is wrong, scan the turn
     * starts for the real one. When nothing confirms, the answer is
     * `undefined` — the caller must not write a memory.
     */
    async resolve({ sessionId, turn }) {
      if (!Number.isInteger(turn) || turn < 1) return undefined;
      const records = await sessionQuery.listEvents(sessionId);
      if (!Array.isArray(records)) return undefined;
      const starts = [...records].sort((left, right) => left.seq - right.seq)
        .filter((record) => record.type === 'turn/start');
      if (starts.length === 0) return undefined;

      if (!canReadEvents) return buildSourceRef(records, { sessionId, turn });

      const ordinal = starts[turn - 1];
      if (ordinal !== undefined && await turnOf(sessionId, ordinal.seq) === turn) {
        return withQuote(buildSourceRef(records, { sessionId, turn }));
      }
      for (const start of starts.slice(0, 500)) {
        if (await turnOf(sessionId, start.seq) !== turn) continue;
        const startSeq = start.seq;
        const message = [...records].sort((left, right) => left.seq - right.seq)
          .find((record) => record.type === 'user/message' && record.seq > startSeq);
        if (message === undefined) return undefined;
        const nextStart = starts.find((other) => other.seq > startSeq);
        if (nextStart !== undefined && message.seq > nextStart.seq) return undefined;
        return withQuote({ session_id: String(sessionId), event_seq: message.seq, event_type: 'user/message' });
      }
      return undefined;
    },
    /** Check that every ref still points at a real event of the right type. */
    async verify(refs) {
      const missing = [];
      const seen = new Map();
      for (const ref of refs) {
        let records = seen.get(ref.session_id);
        if (records === undefined) {
          try {
            records = await sessionQuery.listEvents(ref.session_id);
          } catch {
            records = null;
          }
          seen.set(ref.session_id, records);
        }
        if (records === null) {
          missing.push({ ...ref, reason: 'session-unreadable' });
          continue;
        }
        const target = records.find((record) => record.seq === ref.event_seq);
        if (target === undefined) missing.push({ ...ref, reason: 'event-missing' });
        else if (ref.event_type !== undefined && target.type !== ref.event_type) {
          missing.push({ ...ref, reason: 'event-type-mismatch', actual: target.type });
        } else if (typeof ref.quote_sha256 === 'string' && canReadEvents) {
          // The words must still hash to the recorded value; a changed event
          // means the memory is no longer backed by the evidence it cites.
          let data;
          try {
            const window = await sessionQuery.readEvent({ sessionId: ref.session_id, seq: ref.event_seq });
            data = window && window.target ? window.target.data : undefined;
          } catch {
            missing.push({ ...ref, reason: 'event-unreadable' });
            continue;
          }
          const text = eventText(data);
          if (text === '') missing.push({ ...ref, reason: 'quote-unreadable' });
          else if (quoteDigest(text) !== ref.quote_sha256) missing.push({ ...ref, reason: 'quote-mismatch' });
        }
      }
      return missing.length === 0
        ? { verified: true }
        : { verified: false, reason: 'evidence-not-found', missing };
    },
  };
}
