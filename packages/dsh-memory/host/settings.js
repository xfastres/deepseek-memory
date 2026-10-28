// Automatic-memory settings (§10.1.6): the switches the user actually owns.
//
// Stored beside the ledger, not inside it: a setting is not a memory and must
// never appear in history. Defaults are the safe ones - extraction may queue
// candidates, but nothing is written automatically until the user says so.
//
// A broken file is not an error: it means the documented defaults plus a named
// diagnostic reason, because a bad setting must never stop a conversation.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SETTINGS_FILE = 'memory-settings.json';
export const SETTINGS_VERSION = 1;

/** Types the policy may auto-accept. Kept in step with host/policy.js. */
export const AUTO_ACCEPT_TYPE_CHOICES = Object.freeze(['fact', 'preference', 'constraint']);

export const DEFAULT_SETTINGS = Object.freeze({
  version: SETTINGS_VERSION,
  /** Whether extraction may queue candidates at all. */
  enabled: true,
  /** Whether eligible candidates may be written without review. */
  autoAccept: false,
  autoAcceptTypes: AUTO_ACCEPT_TYPE_CHOICES,
});

/** Normalise a parsed settings object, naming every fallback it had to take. */
export function normaliseSettings(raw) {
  const fallback = [];
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  if (value.version !== SETTINGS_VERSION) fallback.push('version');

  let enabled = DEFAULT_SETTINGS.enabled;
  if (typeof value.enabled === 'boolean') enabled = value.enabled;
  else if (value.enabled !== undefined) fallback.push('enabled');

  let autoAccept = DEFAULT_SETTINGS.autoAccept;
  if (typeof value.autoAccept === 'boolean') autoAccept = value.autoAccept;
  else if (value.autoAccept !== undefined) fallback.push('autoAccept');

  let autoAcceptTypes = [...AUTO_ACCEPT_TYPE_CHOICES];
  if (Array.isArray(value.autoAcceptTypes)) {
    const picked = [];
    for (const type of value.autoAcceptTypes) {
      if (!AUTO_ACCEPT_TYPE_CHOICES.includes(type)) {
        // One diagnostic per field, however many bad entries it had.
        if (!fallback.includes('autoAcceptTypes')) fallback.push('autoAcceptTypes');
        continue;
      }
      if (!picked.includes(type)) picked.push(type);
    }
    autoAcceptTypes = picked;
  } else if (value.autoAcceptTypes !== undefined) {
    fallback.push('autoAcceptTypes');
  }

  return { settings: { version: SETTINGS_VERSION, enabled, autoAccept, autoAcceptTypes }, fallback };
}

/** Read the settings file. A missing file is the documented default. */
export function loadSettings(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    return { settings: normaliseSettings(null).settings, fallback: ['no-data-dir'], loaded: false, path: null };
  }
  const path = join(dataDir, SETTINGS_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
    return {
      settings: normaliseSettings(null).settings,
      fallback: [missing ? 'missing-file' : 'unreadable-file'],
      loaded: false,
      path,
    };
  }
  const normalised = normaliseSettings(raw);
  return { settings: normalised.settings, fallback: normalised.fallback, loaded: true, path };
}

/**
 * Write settings atomically. The caller passes a full object; anything it does
 * not own (version) is written by this function, never by the caller.
 */
export function writeSettings(dataDir, next) {
  const normalised = normaliseSettings({ ...next, version: SETTINGS_VERSION });
  const path = join(dataDir, SETTINGS_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalised.settings, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
  return { settings: normalised.settings, fallback: normalised.fallback, loaded: true, path };
}
