import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AUTO_ACCEPT_TYPE_CHOICES,
  DEFAULT_SETTINGS,
  loadSettings,
  normaliseSettings,
  writeSettings,
} from '../host/settings.js';

async function withDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-settings-'));
  try {
    await run(dir);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  }
}

test('the default settings are the safe ones', () => {
  assert.equal(DEFAULT_SETTINGS.enabled, true);
  assert.equal(DEFAULT_SETTINGS.autoAccept, false);
  assert.deepEqual([...DEFAULT_SETTINGS.autoAcceptTypes], ['fact', 'preference', 'constraint']);
});

test('a missing settings file means the defaults, named as such', async () => {
  await withDir(async (dir) => {
    const loaded = loadSettings(dir);
    assert.equal(loaded.loaded, false);
    assert.deepEqual(loaded.fallback, ['missing-file']);
    assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
    assert.equal(loaded.path.endsWith('memory-settings.json'), true);
  });
});

test('a broken value falls back and names the field', () => {
  const normalised = normaliseSettings({
    version: 1,
    enabled: 'yes',
    autoAccept: true,
    autoAcceptTypes: ['fact', 'hypothesis', 'fact', 7],
  });
  assert.equal(normalised.settings.enabled, DEFAULT_SETTINGS.enabled);
  assert.equal(normalised.settings.autoAccept, true);
  assert.deepEqual(normalised.settings.autoAcceptTypes, ['fact']);
  assert.deepEqual(normalised.fallback, ['enabled', 'autoAcceptTypes']);
});

test('saving is atomic and reloads to the same settings', async () => {
  await withDir(async (dir) => {
    const written = writeSettings(dir, { enabled: false, autoAccept: true, autoAcceptTypes: ['preference'] });
    assert.equal(written.loaded, true);
    assert.deepEqual(written.settings, { version: 1, enabled: false, autoAccept: true, autoAcceptTypes: ['preference'] });
    const raw = JSON.parse(await readFile(join(dir, 'memory-settings.json'), 'utf8'));
    assert.equal(raw.version, 1, 'the writer owns the version field');
    const names = await readdir(dir);
    assert.deepEqual(names, ['memory-settings.json'], 'no temporary file is left behind');
    const reloaded = loadSettings(dir);
    assert.deepEqual(reloaded.settings, written.settings);
    assert.deepEqual(reloaded.fallback, []);
  });
});

test('the auto-accept choices are the ledger types that can be written unattended', () => {
  assert.deepEqual([...AUTO_ACCEPT_TYPE_CHOICES], ['fact', 'preference', 'constraint']);
});
