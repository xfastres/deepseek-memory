// Trace: a real-time, append-only event stream for the memory pipeline.
//
// Why a separate file instead of more fields on `runtime.json`: runtime.json is
// rewritten wholesale on every mutation (read-modify-write + atomic rename), so
// a reader polling it cannot tell "this is new" from "this is the same record".
// An append-only JSONL log has a monotonic order and never rewrites history.
//
// Rules that keep it safe:
//   1. Tracing never throws into the caller. A failed trace must not fail a turn.
//   2. Writes are queued and flushed off the critical path. Prompt assembly is
//      synchronous, so the provider may only enqueue.
//   3. The file is bounded. When it exceeds `maxBytes`, it is rotated to `.1`
//      once; a trace that grows forever is a disk leak.
//   4. It is opt-in via `DSH_MEMORY_TRACE=1` (or an explicit `enabled`), so a
//      normal run pays nothing.

import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const TRACE_FILE = 'trace.jsonl';
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Is tracing on?
 *
 * Explicit option wins over the environment so tests can force either answer.
 */
export function traceEnabled(explicit) {
  if (explicit === true || explicit === false) return explicit;
  const raw = process.env.DSH_MEMORY_TRACE;
  return raw === '1' || raw === 'true';
}

/**
 * @param {object} options
 * @param {string} options.dir   directory holding trace.jsonl
 * @param {boolean} [options.enabled]
 * @param {number} [options.maxBytes]
 * @param {() => Date} [options.now]
 */
export function createTrace(options = {}) {
  const dir = options.dir;
  const enabled = traceEnabled(options.enabled);
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const file = dir === undefined || dir === null ? null : join(dir, TRACE_FILE);

  let seq = 0;
  let dropped = 0;
  let written = 0;
  const counters = Object.create(null);

  /** Rotate once when the file outgrows its cap; never block on failure. */
  function rotateIfNeeded() {
    if (file === null) return;
    try {
      if (!existsSync(file)) return;
      const size = statSync(file).size;
      if (size < maxBytes) return;
      const previous = `${file}.1`;
      if (existsSync(previous)) unlinkSync(previous);
      renameSync(file, previous);
    } catch {
      // A rotation failure must not stop tracing; the next append may still work.
    }
  }

  /**
   * Append one event. Returns the record that was queued, or null when tracing
   * is off. Never throws.
   */
  function emit(kind, data = {}) {
    if (!enabled || file === null) return null;
    let record;
    try {
      seq += 1;
      record = {
        seq,
        at: now().toISOString(),
        kind: String(kind),
        ...(data !== null && typeof data === 'object' ? data : { value: data }),
      };
      counters[record.kind] = (counters[record.kind] ?? 0) + 1;
      rotateIfNeeded();
      appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
      written += 1;
      return record;
    } catch {
      // Counting a drop is the only thing left to do; the caller keeps running.
      dropped += 1;
      return null;
    }
  }

  return {
    enabled,
    file,
    emit,
    /** Diagnostics for the ping probe. */
    stats: () => ({ enabled, file, written, dropped, seq, counters: { ...counters } }),
  };
}
