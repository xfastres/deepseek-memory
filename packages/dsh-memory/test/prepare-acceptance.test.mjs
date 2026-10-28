import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  checkDataDir,
  prepareAcceptance,
} from '../../../scripts/prepare-isolated-acceptance.mjs';
import { sourceDigestOf } from '../host/condense.js';

test('the preparation script refuses anything that could be production data', () => {
  assert.throws(() => checkDataDir(join(homedir(), '.dsh', 'dsh-memory')), /production data dir/u);
  assert.throws(() => checkDataDir(join(homedir(), '.dsh', 'anything-else')), /\$HOME\/\.dsh/u);
  assert.throws(() => checkDataDir('relative/path'), /absolute/u);
  assert.throws(() => checkDataDir('   '), /empty/u);
});

test('the preparation script produces a usable constraint whose digest matches the source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-prep-'));
  try {
    const result = await prepareAcceptance({ dataDir: dir });
    assert.equal(result.checked.loaded.loaded, true);
    assert.deepEqual(result.checked.loaded.fallback, []);
    assert.equal(result.checked.resolved.usable.length, 1, 'the fixture constraint is usable');
    assert.deepEqual(result.checked.resolved.rejected, []);
    const item = result.prepared.config.constraints.items[0];
    assert.equal(item.sourceDigest, sourceDigestOf(result.prepared.memory.content), 'the fingerprint is derived from the stored content');
    assert.ok(item.digest.length <= 120);
    assert.ok(item.digest.length > 0);
    const file = JSON.parse(await readFile(result.prepared.path, 'utf8'));
    assert.equal(file.constraints.items[0].memoryId, result.prepared.memory.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('running the script twice changes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-prep-'));
  try {
    const first = await prepareAcceptance({ dataDir: dir });
    const second = await prepareAcceptance({ dataDir: dir });
    assert.equal(first.prepared.memory.id, second.prepared.memory.id, 'the fixture memory is reused, not duplicated');
    assert.equal(second.prepared.existing, true);
    assert.equal(second.prepared.written, false, 'the configuration is left as it was');
    const before = await readFile(first.prepared.path, 'utf8');
    const after = await readFile(second.prepared.path, 'utf8');
    assert.equal(after, before);
    const state = await second.checked.state;
    assert.equal(state.memories.length, 1, 'no second memory appeared');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the fixture is marked as test data, not as a real memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-prep-'));
  try {
    const result = await prepareAcceptance({ dataDir: dir });
    const state = await result.checked.state;
    const memory = state.memories.find((entry) => entry.id === result.prepared.memory.id);
    assert.equal(memory.type, 'constraint');
    assert.equal(memory.scope, 'global');
    // The record must be identifiable as test data by looking at it alone.
    assert.match(String(memory.content), /隔离数据/u, 'the content says it is isolated test data');
    const refs = Array.isArray(memory.source_refs) ? memory.source_refs : [];
    assert.equal(refs[0]?.session_id, 'fixture-session-isolated', 'the evidence points at a synthetic fixture session');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
