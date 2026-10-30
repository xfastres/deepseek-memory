// Trace: a real-time, append-only event stream for the memory pipeline.
//
// Why a separate file instead of more fields on `runtime.json`: runtime.json is
// rewritten wholesale on every mutation (read-modify-write + atomic rename), so
// a reader polling it cannot tell "this is new" from "this is the same record".
// An append-only JSONL log has a monotonic order and never rewrites history.
//
// Rules that keep it safe:
//   1. Tracing never throws into the caller. A failed trace must not fail a turn.
//   2. Writes happen synchronously at the seam. The event count per turn is tiny
//      (a handful of appends), so this stays off the cost path in practice while
//      keeping the log's order exactly equal to the order of the seams.
//   3. The file is bounded. When it exceeds `maxBytes`, it is rotated to `.1`
//      once; a trace that grows forever is a disk leak.
//   4. It is opt-in, so a normal run pays nothing.
//
// How to turn it on — two ways, and the marker needs no restart:
//
//   a) A marker file. Create `~/.dsh/dsh-memory/trace-on` and tracing starts on
//      the next event; delete it and tracing stops. Checked per event, so it
//      works while the Host is already running.
//   b) `DSH_MEMORY_TRACE=1` in the environment that launched DSH. Fixed for the
//      life of the process; an explicit `0`/`false` vetoes the marker.
//
// Precedence: explicit option > environment variable > marker file.

import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const TRACE_FILE = 'trace.jsonl';
/** Presence of this file turns tracing on without an environment variable. */
export const TRACE_MARKER = 'trace-on';
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function envValue() {
  const raw = process.env.DSH_MEMORY_TRACE;
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}
export { envValue };

/**
 * Resolve the switch.
 *
 * `explicit` wins so tests can force either answer. A non-empty environment
 * variable then decides, so `DSH_MEMORY_TRACE=0` can veto the marker. Only when
 * neither is set does the marker file decide.
 */
export function traceEnabled(explicit, options = {}) {
  if (explicit === true || explicit === false) return explicit;
  const value = envValue();
  if (value !== '') return value === '1' || value === 'true' || value === 'yes' || value === 'on';
  const dir = options.dir;
  if (typeof dir !== 'string' || dir === '') return false;
  try {
    return existsSync(join(dir, TRACE_MARKER));
  } catch {
    return false;
  }
}

/** Is the switch fixed for this process, or may the marker change it live? */
function isFixed(explicit) {
  if (explicit === true || explicit === false) return true;
  return envValue() !== '';
}

/**
 * @param {object} options
 * @param {string} options.dir   directory holding trace.jsonl and the marker
 * @param {boolean} [options.enabled]
 * @param {number} [options.maxBytes]
 * @param {() => Date} [options.now]
 */
export function createTrace(options = {}) {
  const dir = options.dir;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const file = dir === undefined || dir === null ? null : join(dir, TRACE_FILE);
  const marker = dir === undefined || dir === null ? null : join(dir, TRACE_MARKER);
  const fixed = isFixed(options.enabled);
  let enabled = traceEnabled(options.enabled, { dir });

  let seq = 0;
  let dropped = 0;
  let written = 0;
  const counters = Object.create(null);

  /**
   * The switch for this call.
   *
   * When the environment decided it, the answer is fixed and free. When the
   * marker decides it, one `existsSync` per event keeps it live — a handful of
   * events per turn, so this costs nothing that matters and it buys "toggle
   * without restarting the Host".
   */
  function current() {
    if (fixed) return enabled;
    enabled = traceEnabled(undefined, { dir });
    return enabled;
  }

  /** Rotate once when the file outgrows its cap; never block on failure. */
  function rotateIfNeeded() {
    if (file === null) return;
    try {
      if (!existsSync(file)) return;
      if (statSync(file).size < maxBytes) return;
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
    if (file === null || !current()) return null;
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
    get enabled() { return current(); },
    file,
    marker,
    emit,
    /** Diagnostics for the ping probe. */
    stats: () => ({
      enabled: current(),
      source: fixed ? 'environment' : 'marker',
      file,
      marker,
      written,
      dropped,
      seq,
      counters: { ...counters },
    }),
  };
}
