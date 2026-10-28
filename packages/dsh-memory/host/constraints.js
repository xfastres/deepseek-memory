import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eligibility } from './retrieval.js';
import { sourceDigestOf } from './condense.js';

/**
 * Standing-constraint configuration.
 *
 * Constraints are not memories: they say how the memories must be applied, they
 * live beside the ledger rather than inside it, and they carry a condensed
 * expression plus the fingerprint of the content it was condensed from. That
 * fingerprint is the whole safety property - an outdated summary is refused
 * instead of being injected as if it still described the memory.
 */

export const CONFIG_FILE = 'injection.json';
export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  version: CONFIG_VERSION,
  budget: 800,
  constraints: Object.freeze({ budget: 240, maxChars: 120, maxItems: 2, items: Object.freeze([]) }),
});

function isInt(value) {
  return Number.isInteger(value);
}

function inRange(value, low, high) {
  return isInt(value) && value >= low && value <= high;
}

/**
 * Normalise a parsed configuration, recording every fallback it had to take.
 *
 * A broken configuration is not an error: it means the documented defaults,
 * plus a diagnostic reason, because a bad file must never stop a conversation.
 */
export function normaliseConfig(raw) {
  const fallback = [];
  const value = raw !== null && typeof raw === 'object' ? raw : {};
  if (value.version !== CONFIG_VERSION) fallback.push('version');

  let budget = DEFAULT_CONFIG.budget;
  if (inRange(value.budget, 200, 8000)) budget = value.budget;
  else if (value.budget !== undefined) fallback.push('budget');

  const rawConstraints = value.constraints !== null && typeof value.constraints === 'object' ? value.constraints : {};
  let constraintBudget = DEFAULT_CONFIG.constraints.budget;
  if (inRange(rawConstraints.budget, 0, budget)) constraintBudget = rawConstraints.budget;
  else if (rawConstraints.budget !== undefined) fallback.push('constraints.budget');

  let maxChars = DEFAULT_CONFIG.constraints.maxChars;
  if (inRange(rawConstraints.maxChars, 20, 2000)) maxChars = rawConstraints.maxChars;
  else if (rawConstraints.maxChars !== undefined) fallback.push('constraints.maxChars');

  let maxItems = DEFAULT_CONFIG.constraints.maxItems;
  if (inRange(rawConstraints.maxItems, 0, 10)) maxItems = rawConstraints.maxItems;
  else if (rawConstraints.maxItems !== undefined) fallback.push('constraints.maxItems');

  const items = [];
  const rawItems = Array.isArray(rawConstraints.items) ? rawConstraints.items : [];
  if (rawConstraints.items !== undefined && !Array.isArray(rawConstraints.items)) fallback.push('constraints.items');
  rawItems.forEach((item, index) => {
    if (item === null || typeof item !== 'object') {
      fallback.push(`constraints.items[${index}]`);
      return;
    }
    const memoryId = typeof item.memoryId === 'string' ? item.memoryId.trim() : '';
    if (memoryId === '') {
      fallback.push(`constraints.items[${index}].memoryId`);
      return;
    }
    items.push({
      memoryId,
      digest: typeof item.digest === 'string' ? item.digest.trim() : '',
      sourceDigest: typeof item.sourceDigest === 'string' ? item.sourceDigest.trim() : '',
      method: typeof item.method === 'string' ? item.method : null,
      addedAt: typeof item.addedAt === 'string' ? item.addedAt : null,
    });
  });

  return {
    config: { version: CONFIG_VERSION, budget, constraints: { budget: constraintBudget, maxChars, maxItems, items } },
    fallback,
  };
}

/** Read the configuration file. A missing file is the documented default. */
export function loadConfig(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    return { config: normaliseConfig(null).config, fallback: ['no-data-dir'], loaded: false, path: null };
  }
  const path = join(dataDir, CONFIG_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
    return {
      config: normaliseConfig(null).config,
      fallback: [missing ? 'missing-file' : 'unreadable-file'],
      loaded: false,
      path,
    };
  }
  const normalised = normaliseConfig(raw);
  return { config: normalised.config, fallback: normalised.fallback, loaded: true, path };
}

/**
 * Decide which configured constraints may be used right now.
 *
 * Every rejection is named. A constraint gets exactly one exemption - the
 * lexical gate - and none of the checks here.
 */
export function resolveConstraints(options = {}) {
  const config = options.config ?? normaliseConfig(null).config;
  const memories = Array.isArray(options.memories) ? options.memories : [];
  const now = options.now ?? new Date();
  const scope = typeof options.scope === 'string' ? options.scope : 'global';
  const includePrivate = options.includePrivate === true;
  const byId = new Map(memories.filter((memory) => memory && typeof memory.id === 'string').map((memory) => [memory.id, memory]));

  const usable = [];
  const rejected = [];
  for (const item of config.constraints.items) {
    const memory = byId.get(item.memoryId);
    if (memory === undefined) {
      rejected.push({ memoryId: item.memoryId, reason: 'not-found' });
      continue;
    }
    const reason = eligibility(memory, { now, scope, includePrivate });
    if (reason !== null) {
      rejected.push({ memoryId: item.memoryId, reason });
      continue;
    }
    if (item.digest === '') {
      rejected.push({ memoryId: item.memoryId, reason: 'digest-empty' });
      continue;
    }
    if (item.digest.length > config.constraints.maxChars) {
      rejected.push({ memoryId: item.memoryId, reason: 'digest-too-long' });
      continue;
    }
    if (item.sourceDigest === '') {
      rejected.push({ memoryId: item.memoryId, reason: 'digest-unverified' });
      continue;
    }
    if (item.sourceDigest !== sourceDigestOf(memory.content)) {
      rejected.push({ memoryId: item.memoryId, reason: 'digest-stale' });
      continue;
    }
    usable.push({
      memory,
      digest: item.digest,
      method: item.method,
      memoryId: item.memoryId,
      charsOriginal: String(memory.content ?? '').length,
      charsDigest: item.digest.length,
    });
  }
  return { usable, rejected };
}
