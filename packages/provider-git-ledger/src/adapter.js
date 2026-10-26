// GitLedgerAdapter: the MemoryProviderAdapter (dsh-mnemon.memory-space-provider/v1)
// over MemoryLedger + ProjectionIndex.
//
// Capability truth table (declared in descriptor.js and enforced here):
//   search   yes  FTS projection, active records only
//   browse   yes  list()
//   graph    yes  flat projection: nodes only + supersedes edges; no entity graph
//   entities no   -> Source builds from list()
//   related  no   -> method absent
//   remember yes  exact write; receipt is `committed` ONLY after a real git commit
//   link     no
//   forget   no   (deletionMode 'unsupported': RETRACT keeps history; true erasure is a later phase)
//
// Evidence: RememberRequest (0.5.19) carries no source refs and no reason.
// The adapter asks an injected `evidence` hook for the refs that justify the
// write. Without evidence the write is refused with a truthful `candidate`
// receipt (Mnemon maps that to not-committed), never with a fake commit.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MemoryLedger, LedgerConflictError } from './ledger.js';
import { ProjectionIndex } from './projection.js';
import { TYPE_TO_CATEGORY } from './schema.js';
import { descriptor } from './descriptor.js';

const SCORE_SEMANTICS = Object.freeze({ kind: 'normalized-relevance' });

export class GitLedgerAdapter {
  /**
   * @param {object} options
   * @param {string} options.dataDir directory that holds one repo per Memory Space: <dataDir>/<space id>/
   * @param {string} options.ownerId trusted owner identity (NOT a nickname)
   * @param {number} [options.defaultRecallLimit]
   * @param {(request, body) => Promise<{ sourceRefs: object[], reason?: string, idempotencyKey?: string, actor?: 'user'|'agent'|'system', userConfirmed?: boolean } | undefined>} [options.evidence]
   * @param {(refs, signal) => Promise<{verified:boolean, reason?:string}>} [options.verifyEvidence]
   * @param {(root: string) => string} [options.indexPath] where the sqlite projection lives; defaults inside the repo (gitignored)
   */
  constructor(options) {
    this.id = options.id ?? descriptor.id;
    this.scoreSemantics = SCORE_SEMANTICS;
    this.dataDir = options.dataDir;
    this.ownerId = options.ownerId;
    this.defaultRecallLimit = options.defaultRecallLimit ?? 10;
    this.evidence = options.evidence;
    this.verifyEvidence = options.verifyEvidence;
    this.indexPath = options.indexPath ?? ((root) => join(root, 'projection.sqlite'));
    this.gitCommand = options.gitCommand;
    this.spaces = new Map(); // body.id -> { ledger, index }
  }

  async space(body) {
    let open = this.spaces.get(body.id);
    if (open === undefined) {
      const root = join(this.dataDir, body.id);
      const ledger = await new MemoryLedger({ root, ownerId: this.ownerId, verifyEvidence: this.verifyEvidence, gitCommand: this.gitCommand }).open();
      const index = new ProjectionIndex(ledger, this.indexPath(root));
      await index.replay(); // repair anything a crash left between commit and index
      open = { ledger, index };
      this.spaces.set(body.id, open);
    }
    return open;
  }

  async status(body, signal) {
    try {
      const { ledger, index } = await this.space(body);
      const head = await ledger.git.head();
      const all = index.list({ includeInactive: true, limit: 100000 });
      const byCategory = {};
      for (const m of all) if (m.status === 'active') byCategory[TYPE_TO_CATEGORY[m.type]] = (byCategory[TYPE_TO_CATEGORY[m.type]] ?? 0) + 1;
      return {
        healthy: head !== null,
        stats: {
          totalInsights: all.filter((m) => m.status === 'active').length,
          deletedInsights: all.filter((m) => m.status !== 'active').length,
          edgeCount: all.filter((m) => m.supersedes_id).length,
          oplogCount: (await ledger.git.lsFiles('changes/')).filter((p) => p.endsWith('.json')).length,
          dbSizeBytes: 0,
          byCategory,
          topEntities: topEntities(all),
        },
      };
    } catch (error) {
      return { healthy: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async search(body, request, signal) {
    const { index } = await this.space(body);
    const hits = index.search(request.query, {
      limit: request.limit ?? this.defaultRecallLimit,
      type: request.category ? categoryToTypeFilter(request.category) : undefined,
    });
    return { results: hits.map((hit) => toInsight(hit.memory, hit.score)) };
  }

  async list(body, request, signal) {
    const { index } = await this.space(body);
    if (request.query) return (await this.search(body, { query: request.query, limit: request.limit, category: request.category }, signal)).results;
    return index.list({ limit: request.limit ?? 100, type: request.category ? categoryToTypeFilter(request.category) : undefined }).map((m) => toInsight(m));
  }

  async get(body, id, signal) {
    const { index } = await this.space(body);
    const memory = index.get(id);
    return memory === undefined ? undefined : toInsight(memory);
  }

  async graph(body, signal) {
    const { index } = await this.space(body);
    const all = index.list({ includeInactive: true, limit: 100000 });
    const ids = new Set(all.map((m) => m.memory_id));
    const edges = [];
    for (const m of all) {
      if (m.supersedes_id && ids.has(m.supersedes_id)) edges.push({ sourceId: m.supersedes_id, targetId: m.memory_id, label: 'superseded by', color: '#aaaaaa', type: 'temporal' });
    }
    return {
      nodes: all.map((m) => ({ ...toInsight(m), color: m.status === 'active' ? '#3498db' : '#95a5a6', kind: 'memory' })),
      edges,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Exact write. Receipt vocabulary follows what the Source's
   * `mutationResultCompletion` understands: `action: 'stored'|'skipped'|'candidate'|'failed'`.
   */
  async remember(body, request, signal) {
    const { ledger, index } = await this.space(body);
    const justification = this.evidence === undefined ? undefined : await this.evidence(request, body, signal);
    if (justification === undefined || !Array.isArray(justification.sourceRefs) || justification.sourceRefs.length === 0) {
      // Truthful refusal: nothing was written. Mnemon reports this as not committed.
      return {
        action: 'candidate',
        committed: false,
        reason: 'git-ledger requires source evidence (DSH Session event references) for every write; none was available for this request',
        content: request.content,
      };
    }
    const idempotencyKey = justification.idempotencyKey ?? defaultIdempotencyKey(body.id, request, justification.sourceRefs);
    const proposal = MemoryLedger.proposalFromRemember(request, {
      ownerId: this.ownerId,
      idempotencyKey,
      sourceRefs: justification.sourceRefs,
      reason: justification.reason,
      actor: justification.actor ?? (request.source === 'user' ? 'user' : 'agent'),
    });
    if (justification.userConfirmed) proposal.user_confirmed = true;
    let result;
    try {
      result = await ledger.apply(proposal, { signal });
    } catch (error) {
      if (error instanceof LedgerConflictError) return { action: 'failed', committed: false, error: error.message, details: error.details ?? null };
      return { action: 'failed', committed: false, error: error instanceof Error ? error.message : String(error) };
    }
    // Index after commit. An index failure does not change the truth: the
    // commit exists and the outbox row remains; the next open/replay repairs it.
    let indexed = true;
    try {
      await index.replay();
    } catch {
      indexed = false;
    }
    return {
      action: result.status === 'replayed' ? 'skipped' : 'stored',
      committed: true,
      id: result.memory_id,
      content: result.memory.content,
      change_id: result.change_id,
      commit: result.commit,
      indexed,
      replayed: result.status === 'replayed',
    };
  }

  async dispose() {
    for (const { index } of this.spaces.values()) index.close();
    this.spaces.clear();
  }
}

function defaultIdempotencyKey(spaceId, request, refs) {
  const h = createHash('sha256');
  h.update(spaceId).update('\0').update(request.content).update('\0');
  for (const ref of refs) h.update(`${ref.session_id}#${ref.event_seq};`);
  return `remember:${h.digest('hex')}`;
}

function categoryToTypeFilter(category) {
  const types = Object.entries(TYPE_TO_CATEGORY).filter(([, c]) => c === category).map(([t]) => t);
  return types.length === 1 ? types[0] : undefined; // multi-type categories are not filtered at the SQL level
}

function toInsight(memory, score) {
  const insight = {
    id: memory.memory_id,
    content: memory.content,
    category: TYPE_TO_CATEGORY[memory.type] ?? 'general',
    importance: memory.importance,
    tags: memory.tags,
    entities: memory.entities,
    source: 'external',
    confidence: String(memory.confidence),
    createdAt: memory.created_at,
  };
  if (score !== undefined) insight.score = score;
  if (memory.source_refs?.length > 0) {
    const ref = memory.source_refs[0];
    insight.externalUri = `dsh-session://${ref.session_id}#${ref.event_seq}`;
  }
  return insight;
}

function topEntities(all) {
  const counts = new Map();
  for (const m of all) if (m.status === 'active') for (const e of m.entities) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts.entries()].map(([entity, count]) => ({ entity, count })).sort((a, b) => b.count - a.count).slice(0, 10);
}
