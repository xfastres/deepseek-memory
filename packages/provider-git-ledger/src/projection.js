// ProjectionIndex: a disposable SQLite FTS5 projection of the committed ledger.
//
// Invariants:
//   * Only committed records enter the index; each row stores the git commit
//     it was indexed at (`indexed_commit`).
//   * `replay()` drains the ledger outbox: index the records a commit touched,
//     then ack. Crash between commit and index => the outbox row survives and
//     the next replay repairs the index. Indexing is UPSERT, so a replay is
//     idempotent.
//   * `rebuild()` drops everything and refolds from the ledger's committed
//     records at HEAD.
//   * Search excludes non-active rows by default.

import { DatabaseSync } from 'node:sqlite';

export const PROJECTION_SCHEMA_VERSION = 1;

/** Stamped when git cannot attribute a record path to a commit. Never a fake HEAD. */
export const UNKNOWN_COMMIT = 'unknown-commit';

export class ProjectionIndex {
  /**
   * @param {import('./ledger.js').MemoryLedger} ledger
   * @param {string} path sqlite file path or ':memory:'
   */
  constructor(ledger, path) {
    this.ledger = ledger;
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        importance INTEGER NOT NULL,
        confidence REAL NOT NULL,
        tags TEXT NOT NULL,
        entities TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_change_id TEXT NOT NULL,
        indexed_commit TEXT NOT NULL
      );
      -- trigram: substring recall and CJK text without a word segmenter (unicode61 keeps a whole
      -- CJK run as one token, so "调用流程" would not match "…展示调甄流程…"). Queries under 3 code
      -- points fall back to a LIKE scan in search().
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        memory_id UNINDEXED, content, tags, entities, tokenize = 'trigram'
      );
    `);
    const version = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (version === undefined) {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(PROJECTION_SCHEMA_VERSION));
    } else if (Number(version.value) !== PROJECTION_SCHEMA_VERSION) {
      throw new Error(`projection schema ${version.value} does not match ${PROJECTION_SCHEMA_VERSION}; rebuild required`);
    }
    this.upsert = this.db.prepare(`
      INSERT INTO memories (memory_id, owner_id, type, status, content, scope, importance, confidence, tags, entities, source_refs, created_at, updated_at, last_change_id, indexed_commit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        type = excluded.type, status = excluded.status, content = excluded.content, scope = excluded.scope,
        importance = excluded.importance, confidence = excluded.confidence, tags = excluded.tags, entities = excluded.entities,
        source_refs = excluded.source_refs, updated_at = excluded.updated_at, last_change_id = excluded.last_change_id,
        indexed_commit = excluded.indexed_commit
    `);
    this.deleteFts = this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?');
    this.insertFts = this.db.prepare('INSERT INTO memories_fts (memory_id, content, tags, entities) VALUES (?, ?, ?, ?)');
  }

  close() {
    this.db.close();
  }

  indexRecord(memory, commit) {
    this.db.exec('BEGIN');
    try {
      this.upsert.run(
        memory.memory_id, memory.owner_id, memory.type, memory.status, memory.content, memory.scope,
        memory.importance, memory.confidence, JSON.stringify(memory.tags), JSON.stringify(memory.entities),
        JSON.stringify(memory.source_refs), memory.created_at, memory.updated_at, memory.last_change_id, commit,
      );
      this.deleteFts.run(memory.memory_id);
      this.insertFts.run(memory.memory_id, memory.content, memory.tags.join(' '), memory.entities.join(' '));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Drain the ledger outbox. Returns the change ids indexed in this pass. */
  async replay({ failInjector } = {}) {
    const done = [];
    for (const entry of await this.ledger.pendingOutbox()) {
      if (!(await this.ledger.git.commitExists(entry.commit))) {
        // A commit that git does not know never happened; the outbox row is stale debris.
        await this.ledger.ackOutbox(entry.change_id);
        continue;
      }
      for (const memoryId of entry.memory_ids) {
        const memory = JSON.parse(await this.ledger.git.show(entry.commit, `records/${memoryId}.json`));
        if (failInjector) failInjector(entry, memory); // test hook: throw to simulate an index failure
        this.indexRecord(memory, entry.commit);
      }
      await this.ledger.ackOutbox(entry.change_id);
      done.push(entry.change_id);
    }
    return done;
  }

  /**
   * Drop the projection and fold it again from the COMMITTED records at HEAD.
   *
   * Provenance: each row's `indexed_commit` is the commit that last changed
   * that record file (`git log -1 -- <path>`), which is the commit that
   * produced this exact content. A full rebuild therefore reproduces the same
   * `indexed_commit` values a live replay would have written, instead of
   * stamping HEAD on everything. When git cannot attribute the path, the row
   * is stamped `UNKNOWN_COMMIT` rather than claiming HEAD.
   *
   * The Git repository is only read here; a failure mid-rebuild leaves the
   * committed memory untouched (only the disposable projection is in flux).
   */
  async rebuild() {
    const head = await this.ledger.git.head();
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM memories; DELETE FROM memories_fts;');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (head === null) return 0;
    let count = 0;
    // Paths come from the COMMITTED tree, not the working directory.
    for (const path of await this.ledger.git.lsTree(head, 'records/')) {
      if (!path.endsWith('.json')) continue;
      const raw = await this.ledger.git.showOrUndefined(head, path);
      if (raw === undefined) continue;
      const memory = JSON.parse(raw);
      const provenance = (await this.ledger.git.lastCommitFor(path)) ?? UNKNOWN_COMMIT;
      this.indexRecord(memory, provenance);
      count += 1;
    }
    // After a full rebuild every outbox row is covered by the committed tree.
    for (const entry of await this.ledger.pendingOutbox()) await this.ledger.ackOutbox(entry.change_id);
    return count;
  }

  count({ includeInactive = false } = {}) {
    const row = includeInactive
      ? this.db.prepare('SELECT COUNT(*) AS n FROM memories').get()
      : this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'active'").get();
    return row.n;
  }

  get(memoryId) {
    const row = this.db.prepare('SELECT * FROM memories WHERE memory_id = ?').get(memoryId);
    return row === undefined ? undefined : rowToMemory(row);
  }

  list({ limit = 100, includeInactive = false, type } = {}) {
    const clauses = [];
    const params = [];
    if (!includeInactive) clauses.push("status = 'active'");
    if (type) { clauses.push('type = ?'); params.push(type); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM memories ${where} ORDER BY importance DESC, updated_at DESC LIMIT ?`).all(...params, limit).map(rowToMemory);
  }

  /**
   * Literal-phrase FTS search (FTS5 syntax in the query is inert data).
   * Returns [{ memory, score }] with score in 0..1 (bm25 mapped), active only unless asked.
   */
  search(query, { limit = 10, includeInactive = false, type } = {}) {
    const normalized = query.trim().replaceAll(/\s+/gu, ' ');
    if (normalized === '') return [];
    const filters = [];
    const filterParams = [];
    if (!includeInactive) filters.push("m.status = 'active'");
    if (type) { filters.push('m.type = ?'); filterParams.push(type); }
    const extra = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
    // Each whitespace-separated term is one literal phrase; all terms must match (AND).
    const terms = normalized.split(' ');
    if (terms.every((t) => [...t].length >= 3)) {
      const match = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' ');
      const rows = this.db.prepare(`
        SELECT m.*, bm25(memories_fts) AS rank
        FROM memories_fts JOIN memories m ON m.memory_id = memories_fts.memory_id
        WHERE memories_fts MATCH ?${extra}
        ORDER BY rank ASC, m.importance DESC
        LIMIT ?
      `).all(match, ...filterParams, limit);
      return rows.map((row) => ({ memory: rowToMemory(row), score: bm25ToUnit(row.rank), indexed_commit: row.indexed_commit }));
    }
    // Trigram needs 3+ code points per term; shorter terms use a case-insensitive LIKE scan.
    const likeClauses = terms.map(() => "(m.content LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\' OR m.entities LIKE ? ESCAPE '\\')");
    const likeParams = terms.flatMap((t) => { const p = `%${t.replaceAll(/[\\%_]/gu, '\\$&')}%`; return [p, p, p]; });
    const rows = this.db.prepare(`
      SELECT m.* FROM memories m
      WHERE ${likeClauses.join(' AND ')}${extra}
      ORDER BY m.importance DESC, m.updated_at DESC
      LIMIT ?
    `).all(...likeParams, ...filterParams, limit);
    return rows.map((row) => ({ memory: rowToMemory(row), score: 0.5, indexed_commit: row.indexed_commit }));
  }
}

function bm25ToUnit(rank) {
  // bm25() returns negative numbers, better matches are more negative.
  const positive = Math.max(0, -rank);
  return Math.min(1, 1 - 1 / (1 + positive));
}

function rowToMemory(row) {
  return {
    memory_id: row.memory_id,
    owner_id: row.owner_id,
    layer: 'L1',
    type: row.type,
    status: row.status,
    content: row.content,
    scope: row.scope,
    importance: row.importance,
    confidence: row.confidence,
    tags: JSON.parse(row.tags),
    entities: JSON.parse(row.entities),
    source_refs: JSON.parse(row.source_refs),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_change_id: row.last_change_id,
    indexed_commit: row.indexed_commit,
  };
}
