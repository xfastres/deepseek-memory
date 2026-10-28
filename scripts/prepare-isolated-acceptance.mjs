#!/usr/bin/env node
/**
 * Prepare an isolated acceptance data directory for dsh-memory.
 *
 * Why this exists: verifying the injection path needs a ledger with at least one
 * active memory and an `injection.json` whose `sourceDigest` matches that memory
 * exactly. Doing that by hand is where mistakes come from - a wrong digest means
 * the constraint is silently refused and the run proves nothing.
 *
 * Rules this script enforces:
 *   1. It never writes to the production data directory (`$HOME/.dsh/dsh-memory`)
 *      or anywhere inside `$HOME/.dsh`.
 *   2. Running it twice changes nothing: the fixture memory is matched by its
 *      exact content, and `injection.json` is left alone unless `--force` is set.
 *   3. Every fixture record carries `fixture: true` in its reason, so test data is
 *      never mistaken for a real memory.
 *
 * Usage:
 *   node scripts/prepare-isolated-acceptance.mjs [--data-dir <abs path>] [--force] [--dry-run]
 *
 * The data directory it prints is the one to pass as DSH_MEMORY_DATA_DIR before
 * starting DSH; the plugin reads that variable lazily (see resolveDataDir()).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLedgerService } from '../packages/dsh-memory/host/ledger-service.js';
import { loadConfig, resolveConstraints } from '../packages/dsh-memory/host/constraints.js';
import { condense, sourceDigestOf } from '../packages/dsh-memory/host/condense.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRODUCTION_DIR = join(homedir(), '.dsh', 'dsh-memory');
const FIXTURE_MARKER = 'fixture:isolated-acceptance';
const FIXTURE_CONTENT = '测试约束（隔离数据）：回答先给结论，再给依据。不要堆术语。';
const FIXTURE_SESSION = 'fixture-session-isolated';

export function defaultDataDir() {
  const fromEnv = process.env.DSH_MEMORY_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(dirname(REPO_ROOT), 'dsh-memory-test-home', 'data');
}

/** Refuse anything that could be the production store. */
export function checkDataDir(dataDir) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') throw new Error('data dir is empty');
  // Check the raw input: resolve() would make a relative path absolute and hide
  // the mistake.
  if (!isAbsolute(dataDir.trim())) throw new Error('data dir must be absolute');
  const target = resolve(dataDir);
  const production = resolve(PRODUCTION_DIR);
  if (target === production) throw new Error(`refusing the production data dir: ${target}`);
  const rel = relative(join(homedir(), '.dsh'), target);
  // On Windows, relative() across drives returns the absolute path, so an
  // absolute result means "different drive" - which is outside .dsh.
  const insideDsh = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (insideDsh) {
    throw new Error(`refusing a path inside $HOME/.dsh: ${target}`);
  }
  return target;
}

function fixtureSourceRef(turn = 1) {
  return { session_id: FIXTURE_SESSION, event_seq: 2, event_type: 'user/message' };
}

/**
 * Create the fixture memory once. Returns how many records were added.
 *
 * The reference points at a session that exists only in this fixture data; it is
 * deliberately obvious that it is not a real conversation. Retrieval does not
 * re-verify evidence, so the record works for acceptance while staying clearly
 * labelled as test data.
 */
export async function seedFixtureMemory(dataDir) {
  const service = createLedgerService({ root: join(dataDir, 'ledger') });
  const state = await service.state();
  const memories = Array.isArray(state.memories) ? state.memories : [];
  if (memories.some((memory) => String(memory.content ?? '') === FIXTURE_CONTENT)) {
    return { added: 0, memory: memories.find((memory) => String(memory.content ?? '') === FIXTURE_CONTENT) };
  }
  await service.add({
    content: FIXTURE_CONTENT,
    type: 'constraint',
    scope: 'global',
    reason: FIXTURE_MARKER,
    sourceRefs: [fixtureSourceRef()],
    idempotencyKey: `fixture-${sourceDigestOf(FIXTURE_CONTENT).slice(7, 23)}`,
  });
  const after = await service.state();
  const memory = (Array.isArray(after.memories) ? after.memories : []).find(
    (entry) => String(entry.content ?? '') === FIXTURE_CONTENT,
  );
  return { added: 1, memory };
}

/** Build (and optionally write) the constraint configuration for the fixture. */
export async function prepareConfig(dataDir, { force = false, dryRun = false } = {}) {
  const { memory } = await seedFixtureMemory(dataDir);
  if (memory === undefined) throw new Error('fixture memory could not be created');
  const summary = condense({ content: memory.content }, { maxChars: 120 });
  const config = {
    version: 1,
    budget: 800,
    constraints: {
      budget: 240,
      maxChars: 120,
      maxItems: 2,
      items: [
        {
          memoryId: memory.id,
          digest: summary.ok ? summary.text : memory.content.slice(0, 120),
          sourceDigest: sourceDigestOf(memory.content),
          method: summary.ok ? 'deterministic-v1' : 'manual',
          addedAt: new Date().toISOString(),
        },
      ],
    },
  };
  const path = join(dataDir, 'injection.json');
  const exists = existsSync(path);
  if (!exists || force) {
    if (!dryRun) await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
  return { path, config, written: !exists || force, existing: exists, memory, summary };
}

/** Read the configuration back through the real loader and resolve it. */
export async function verify(dataDir) {
  const service = createLedgerService({ root: join(dataDir, 'ledger') });
  const state = await service.state();
  const loaded = loadConfig(dataDir);
  const resolved = resolveConstraints({ config: loaded.config, memories: state.memories ?? [] });
  return { state, loaded, resolved };
}

export async function prepareAcceptance(options = {}) {
  const dataDir = checkDataDir(options.dataDir ?? defaultDataDir());
  if (!options.dryRun) await mkdir(dataDir, { recursive: true });
  const prepared = await prepareConfig(dataDir, { force: options.force === true, dryRun: options.dryRun === true });
  const checked = await verify(dataDir);
  return { dataDir, prepared, checked };
}

function parseArgs(argv) {
  const options = { dataDir: undefined, force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir') options.dataDir = argv[(index += 1)];
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('node scripts/prepare-isolated-acceptance.mjs [--data-dir <abs>] [--force] [--dry-run]');
    return;
  }
  const result = await prepareAcceptance(options);
  const { dataDir, prepared, checked } = result;
  console.log(`data dir      : ${dataDir}`);
  console.log(`repo          : ${REPO_ROOT}`);
  console.log(`fixture memory: ${prepared.memory.id} (${String(prepared.memory.content).length} chars)`);
  console.log(`digest        : ${JSON.stringify(prepared.config.constraints.items[0].digest)}`);
  console.log(`sourceDigest  : ${prepared.config.constraints.items[0].sourceDigest}`);
  console.log(`config file   : ${prepared.path} (${prepared.written ? 'written' : 'left as it was'})`);
  console.log(`loaded        : ${checked.loaded.loaded}`);
  console.log(`fallback      : ${JSON.stringify(checked.loaded.fallback)}`);
  console.log(`usable        : ${checked.resolved.usable.length}`);
  console.log(`rejected      : ${JSON.stringify(checked.resolved.rejected)}`);
  console.log('');
  console.log('next:');
  console.log(`  $env:DSH_MEMORY_DATA_DIR = '${dataDir}'`);
  console.log('  restart DSH from the same shell (the value is read when the plugin opens its store)');
  console.log('  ask one question, then check http://127.0.0.1:<port>/api/dsh-memory/injections?limit=5');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`error: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  });
}
