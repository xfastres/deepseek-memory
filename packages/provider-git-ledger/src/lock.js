// Cross-process write lock for one memory repository.
//
// Why: the in-process promise queue only serializes writers in ONE process.
// Two hosts (or a host plus a maintenance script) can otherwise interleave
// `write files` and `git commit`, so one writer's commit could capture the
// other writer's half-applied files.
//
// Design:
//   * Exclusivity comes from `mkdir(<repo>/.ledger-lock)`, which is atomic and
//     exclusive on every supported platform — no "file exists but is empty
//     yet" window that a file-based lock would expose to concurrent readers.
//   * Ownership is recorded in `<lockdir>/owner.json` as
//     `{ token, pid, host, acquired_at, expires_at }`. `owner.json` being
//     missing or unreadable is NEVER taken as "free": a lock directory is only
//     reclaimable once its TTL has expired and it cannot be attributed to a
//     live owner.
//   * The owner refreshes `expires_at` (heartbeat) while writing, so a slow but
//     live writer is not robbed by a waiter.
//   * A crashed owner leaves an expired lock; a waiter reclaims it by renaming
//     the directory aside (atomic), which guarantees only one reclaimer wins.
//   * Refusals are explicit: contention and timeout raise LedgerLockError with
//     the holder identity. Nothing is ever silently skipped.
//   * The lock directory is not part of memory content; it is gitignored by the
//     repository's own `.gitignore`.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LOCK_DIR = '.ledger-lock';
export const LOCK_OWNER = 'owner.json';
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
export const DEFAULT_LOCK_TTL_MS = 60_000;

export class LedgerLockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LedgerLockError';
    this.details = details;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export class RepoLock {
  constructor(root, { timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, ttlMs = DEFAULT_LOCK_TTL_MS, now = () => Date.now(), pollMs = 25 } = {}) {
    this.root = root;
    this.path = join(root, LOCK_DIR);
    this.ownerPath = join(this.path, LOCK_OWNER);
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.now = now;
    this.pollMs = pollMs;
    this.token = undefined;
  }

  /** The recorded owner, or `{ unattributed: true }` when the dir exists without a readable owner. */
  async readHolder() {
    try {
      const raw = await readFile(this.ownerPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token !== 'string') return { unattributed: true, reason: 'owner.json has no token' };
      return parsed;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // Either no lock at all, or a lock directory whose owner has not been
        // written yet (or whose owner file was removed). Distinguish by dir.
        return (await this.dirExists()) ? { unattributed: true, reason: 'owner.json absent' } : undefined;
      }
      return { unattributed: true, reason: `owner.json unreadable: ${error?.code ?? error?.message}` };
    }
  }

  async dirExists() {
    try {
      const info = await stat(this.path);
      return info.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Staleness requires positive evidence: an expired TTL, or an unattributed
   * lock directory that is older than the TTL (its owner died before it could
   * record itself). An unreadable-but-recent lock is treated as LIVE.
   */
  async isStale(holder) {
    if (holder === undefined) return true;
    if (holder.unattributed === true) {
      try {
        const info = await stat(this.ownerPath).catch(() => stat(this.path));
        return this.now() - info.mtimeMs > this.ttlMs;
      } catch {
        return false; // cannot age it: assume live, let the waiter time out loudly
      }
    }
    const expires = holder.expires_at;
    if (typeof expires === 'number') return expires <= this.now();
    // An owner record without a numeric expiry is only reclaimable once old.
    try {
      const info = await stat(this.ownerPath);
      return this.now() - info.mtimeMs > this.ttlMs;
    } catch {
      return false;
    }
  }

  /** Claim the lock, waiting up to `timeoutMs`. Throws LedgerLockError on contention. */
  async acquire() {
    const deadline = this.now() + this.timeoutMs;
    for (;;) {
      if (await this.tryAcquireOnce()) return this.release.bind(this);
      if (this.now() >= deadline) {
        const holder = await this.readHolder();
        throw new LedgerLockError('memory repository is locked by another writer', { holder, waitedMs: this.timeoutMs });
      }
      await sleep(this.pollMs);
    }
  }

  async tryAcquireOnce() {
    const token = randomUUID();
    const payload = {
      token,
      pid: process.pid,
      host: hostname(),
      acquired_at: this.now(),
      expires_at: this.now() + this.ttlMs,
    };
    // mkdir is the atomic exclusivity primitive.
    let created = false;
    try {
      await mkdir(this.path);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (created) {
      await writeFile(this.ownerPath, JSON.stringify(payload));
      this.token = token;
      return true;
    }
    // Someone holds it. Reclaim only on positive staleness evidence.
    const holder = await this.readHolder();
    if (!(await this.isStale(holder))) return false;
    const aside = `${this.path}.stale-${randomUUID()}`;
    try {
      await rename(this.path, aside);
    } catch (error) {
      if (error?.code === 'ENOENT') return false; // another reclaimer already won
      throw error;
    }
    const movedHolder = await this.readHolderAt(aside);
    if (!(await this.isStaleAt(aside, movedHolder))) {
      // We raced a live owner: put it back and report contention.
      await rename(aside, this.path).catch(() => {});
      return false;
    }
    await rm(aside, { recursive: true, force: true });
    return this.tryAcquireOnce();
  }

  async readHolderAt(dir) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, LOCK_OWNER), 'utf8'));
      return typeof parsed?.token === 'string' ? parsed : { unattributed: true };
    } catch {
      return { unattributed: true };
    }
  }

  async isStaleAt(dir, holder) {
    if (holder.unattributed === true) {
      try {
        const info = await stat(dir);
        return this.now() - info.mtimeMs > this.ttlMs;
      } catch {
        return true;
      }
    }
    return typeof holder.expires_at === 'number' ? holder.expires_at <= this.now() : false;
  }

  /** Refresh expiry so a long write is not stolen by a waiter. */
  async heartbeat() {
    if (this.token === undefined) return;
    const holder = await this.readHolder();
    if (holder?.token !== this.token) {
      throw new LedgerLockError('lock ownership lost while writing', { holder });
    }
    await writeFile(this.ownerPath, JSON.stringify({ ...holder, expires_at: this.now() + this.ttlMs }));
  }

  async release() {
    if (this.token === undefined) return;
    const token = this.token;
    this.token = undefined;
    const holder = await this.readHolder();
    // Deleting another writer's lock would break exclusivity: only the owner removes it.
    if (holder?.token !== token) return;
    await rm(this.path, { recursive: true, force: true });
  }

  async isHeld() {
    return this.dirExists();
  }
}
