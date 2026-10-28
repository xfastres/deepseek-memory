// Read-only verification against existing DSH sessions. No Agent or model is started.
// Usage: node scripts/verify-live.mjs [packaged DSH runtime] [DSH_HOME] [--session <id>] [--all]
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { sessionFileDigests } from './session-file-digests.mjs';
import { projectTurns, completedTurns, groupTurnsByDate } from '../src/index.js';

const runtime = process.argv[2] ?? 'F:/DsspSeekHarness/resources/app.asar/dsh';
const home = process.argv[3] ?? process.env.DSH_HOME;
const runtimeRequire = createRequire(join(runtime, 'package.json'));
const fromSource = (specifier) => import(pathToFileURL(runtimeRequire.resolve(specifier)).href);
const { Context } = await fromSource('@deepseek-ai/cordis');
const { default: SessionStore } = await fromSource('@deepseek-ai/dsh-session');
const { default: SessionProjectionRegistry } = await fromSource('@deepseek-ai/dsh-session-projection');
const JsonlSessionPersistence = await fromSource('@deepseek-ai/dsh-session-persistence-jsonl');
const { default: SqliteSessionQueryEngine } = await fromSource('@deepseek-ai/dsh-session-query-sqlite');
const args = process.argv.slice(4);
const requestedId = args.includes('--session') ? args[args.indexOf('--session') + 1] : undefined;
const all = args.includes('--all');
const listOnly = args.includes('--list-only');
if (!home) throw new Error('DSH_HOME is required for a live read-only verification');

// Use the version-matched packaged runtime, whose own Node/asar loader is required.
console.log(JSON.stringify({ mode: 'read-only-persistence', runtime, sessionRoot: join(home, 'sessions') }, null, 2));
process.on('uncaughtException', (error) => {
  console.error(`[l0-verify] fatal: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
process.on('unhandledRejection', (error) => {
  console.error(`[l0-verify] fatal rejection: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
const before = process.env.L0_SKIP_DIGEST === '1' ? undefined : await sessionFileDigests(join(home, 'sessions'));
let summaries;
let report;
const ctx = new Context();
try {
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(SessionStore);
  const persistence = await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') });
  const query = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' });
  const records = await ctx.sessionQuery.listSessions();
  summaries = records.map((record) => ({
    id: record.header.id,
    created_at: new Date(record.header.createdAt).toISOString(),
    live: record.live,
    persisted: record.persisted,
    origin: record.header.origin ?? null,
    format: record.formatStatus ?? null,
  }));
  const counts = (items, key) => Object.fromEntries([...items.reduce((map, item) => map.set(item[key], (map.get(item[key]) ?? 0) + 1), new Map())]);
  console.log(JSON.stringify({
    sessionCount: summaries.length,
    byOrigin: counts(summaries, 'origin'),
    byFormat: counts(summaries, 'format'),
    recentSessions: summaries.slice(0, 5),
  }, null, 2));
  const selected = listOnly ? [] : requestedId ? records.filter((record) => record.header.id === requestedId) : all ? records : records.filter((record) => record.persisted && record.header.origin !== 'subagent').slice(0, 2);
  if (requestedId && selected.length === 0) throw new Error(`No such session: ${requestedId}`);
  report = [];
  for (const record of selected) {
    const id = record.header.id;
    console.error(`[l0-verify] reading ${id}`);
    try {
      const snapshot = await ctx.sessionQuery.readSession(id);
      console.error(`[l0-verify] read ${id}: ${snapshot.events.length} events`);
      const turns = projectTurns(snapshot);
      const own = turns;
      assert.equal(new Set(own.map((turn) => turn.turn)).size, own.length, 'turn ids must be unique within a session');
      assert.ok(own.every((turn) => turn.start_seq >= snapshot.inheritedEventCount), 'inherited prefixes must not be reprocessed');
      assert.ok(own.every((turn) => turn.events.every((event) => event.seq >= turn.start_seq && (turn.end_seq === null || event.seq <= turn.end_seq))), 'turn ranges must contain their events');
      assert.ok(completedTurns(own).every((turn) => turn.end_reason.kind === 'completed'), 'only completed turns may be eligible');
      const groups = groupTurnsByDate(own);
      report.push({
        session_id: id,
        origin: record.header.origin ?? null,
        source: record.live ? 'live' : 'persisted',
        events: snapshot.events.length,
        inherited_event_count: snapshot.inheritedEventCount,
        turns: own.length,
        completed: own.filter((turn) => turn.status === 'completed').length,
        closed_incomplete: own.filter((turn) => turn.status === 'closed_incomplete').length,
        in_progress: own.filter((turn) => turn.status === 'in_progress').length,
        date_groups: groups.map((group) => ({ date: group.date, turns: group.turns.length })),
        turn_samples: own.slice(-3).map((turn) => ({
          turn: turn.turn,
          range: [turn.start_seq, turn.end_seq],
          status: turn.status,
          start_time: new Date(turn.started_at).toISOString(),
          events: turn.events.length,
          user_message_sources: turn.events.filter((event) => event.type === 'user/message').map((event) => ({
            seq: event.seq,
            kind: event.data.source?.kind ?? null,
            has_rpc_id: typeof event.data.source?.rpcId === 'string',
            client_time_zone: event.data.source?.clientTimeZone ?? null,
          })),
        })),
      });
    } catch (error) {
      report.push({ session_id: id, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    }
  }
  assert.ok(report.every((item) => item.error === undefined), 'every selected real session must read and project successfully');
  await query.dispose();
  await persistence.dispose();
} finally {
  await ctx.fiber.dispose();
}
const after = process.env.L0_SKIP_DIGEST === '1' ? before : await sessionFileDigests(join(home, 'sessions'));
if (before !== undefined) assert.deepEqual(after, before, 'read-only verification must not change original session files');
const sourceKinds = new Map();
const summary = {
  sessions_read: report.filter((item) => !item.error).length,
  session_errors: report.filter((item) => item.error).length,
  turns: report.reduce((count, item) => count + (item.turns ?? 0), 0),
  completed_turns: report.reduce((count, item) => count + (item.completed ?? 0), 0),
  incomplete_turns: report.reduce((count, item) => count + (item.closed_incomplete ?? 0), 0),
  open_turns: report.reduce((count, item) => count + (item.in_progress ?? 0), 0),
  source_files_unchanged: before !== undefined,
};
for (const item of report) {
  for (const sample of item.turn_samples ?? []) {
    for (const source of sample.user_message_sources) sourceKinds.set(source.kind, (sourceKinds.get(source.kind) ?? 0) + 1);
  }
}
summary.sampled_user_message_source_kinds = Object.fromEntries(sourceKinds);
const output = { mode: 'read-only-persistence', runtime, summary, sessions: summaries, verification: report };
const outputPath = process.env.L0_VERIFY_OUTPUT ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tmp', 'l0-live-verification.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...summary, report: outputPath }, null, 2));
