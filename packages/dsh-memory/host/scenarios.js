// Structural scenarios: group atoms that belong together, without summarising.
//
// A scenario here is nothing but a claim about grouping: "these memories were
// produced together, look at them as a set". No sentence is generated, so
// nothing can be hallucinated. Titles are derived from the members, and the
// group can be recomputed at any time from the ledger.
//
// Summaries, when they exist, are a separate concern that must pass a quote
// check; this module never produces text.

import { createHash } from 'node:crypto';

const DAY = 86_400_000;

function activeMemories(memories) {
  if (!Array.isArray(memories)) return [];
  return memories.filter((memory) => memory && memory.status === 'active' && typeof memory.content === 'string');
}

function sessionOf(memory) {
  const refs = Array.isArray(memory.source_refs) ? memory.source_refs : [];
  const first = refs.find((ref) => ref && typeof ref.session_id === 'string');
  return first === undefined ? undefined : first.session_id;
}

function timeOf(memory) {
  const parsed = Date.parse(memory.accepted_at ?? memory.updated_at ?? '');
  return Number.isNaN(parsed) ? undefined : parsed;
}

function periodOf(members) {
  const times = members.map(timeOf).filter((time) => time !== undefined);
  if (times.length === 0) return { from: null, to: null };
  return { from: new Date(Math.min(...times)).toISOString(), to: new Date(Math.max(...times)).toISOString() };
}

function stableId(kind, key, members) {
  // The readable part is truncated, so the digest carries the identity: two
  // session ids that share a 40-character prefix must not become one scenario.
  const digest = createHash('sha256')
    .update(`${key}\n${[...members].sort().join('\n')}`)
    .digest('hex')
    .slice(0, 10);
  return `S-${kind}-${key}-${digest}`;
}

/**
 * Cluster memories into scenarios.
 *
 * Two signals, both structural:
 *   - `session`: at least `minSessionMembers` memories from one session inside
 *     `windowDays`, because one working session is one episode;
 *   - `entity`: at least `minEntityMembers` memories naming the same entity,
 *     which links work done across sessions.
 *
 * @returns {{scenarios: Array<object>, orphans: string[]}}
 */
export function clusterMemories(memories, options = {}) {
  const {
    windowDays = 7,
    minSessionMembers = 3,
    minEntityMembers = 2,
  } = options;
  const eligible = activeMemories(memories);
  const scenarios = [];
  const covered = new Set();

  const bySession = new Map();
  for (const memory of eligible) {
    const sessionId = sessionOf(memory);
    if (sessionId === undefined) continue;
    const key = `${memory.scope ?? 'global'}::${sessionId}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(memory);
  }

  for (const [key, group] of bySession) {
    if (group.length < minSessionMembers) continue;
    const times = group.map(timeOf).filter((time) => time !== undefined);
    if (times.length > 0 && Math.max(...times) - Math.min(...times) > windowDays * DAY) continue;
    const members = group.map((memory) => memory.id);
    scenarios.push({
      id: stableId('session', key.replace(/[^a-z0-9]+/giu, '-').slice(0, 40), members),
      kind: 'session',
      key,
      members,
      period: periodOf(group),
      summary: null,
      origin: 'structural',
    });
    for (const id of members) covered.add(id);
  }

  const byEntity = new Map();
  for (const memory of eligible) {
    const entities = Array.isArray(memory.entities) ? memory.entities : [];
    for (const entity of entities) {
      if (typeof entity !== 'string' || entity.trim() === '') continue;
      const key = `${memory.scope ?? 'global'}::${entity.trim().toLowerCase()}`;
      if (!byEntity.has(key)) byEntity.set(key, []);
      byEntity.get(key).push(memory);
    }
  }

  for (const [key, group] of byEntity) {
    const unique = [...new Map(group.map((memory) => [memory.id, memory])).values()];
    if (unique.length < minEntityMembers) continue;
    const members = unique.map((memory) => memory.id);
    if (scenarios.some((scenario) => scenario.members.length === members.length && scenario.members.every((id) => members.includes(id)))) {
      continue;
    }
    scenarios.push({
      id: stableId('entity', key.replace(/[^a-z0-9]+/giu, '-').slice(0, 40), members),
      kind: 'entity',
      key,
      members,
      period: periodOf(unique),
      summary: null,
      origin: 'structural',
    });
  }

  const orphans = eligible.filter((memory) => !covered.has(memory.id)).map((memory) => memory.id);
  scenarios.sort((left, right) => right.members.length - left.members.length || left.id.localeCompare(right.id));
  return { scenarios, orphans };
}

/**
 * Which memories a user-written scenario summary may cover.
 *
 * A summary is only offered when every member still exists and is active, so a
 * stale summary cannot outlive the facts it describes.
 */
export function summarisable(scenario, memories) {
  if (scenario === null || typeof scenario !== 'object' || !Array.isArray(scenario.members)) return false;
  const byId = new Map((memories ?? []).map((memory) => [memory.id, memory]));
  return scenario.members.every((id) => {
    const memory = byId.get(id);
    return memory !== undefined && memory.status === 'active';
  });
}
