// Minimal git transport: spawn `git` without a shell, bounded output, no network.
// The repository is the content authority; this module is the only writer of it.

import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';

export class GitError extends Error {
  constructor(message, { args, exitCode, stderr } = {}) {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class GitRepo {
  /**
   * @param {string} root absolute repository directory
   * @param {{ command?: string, timeoutMs?: number, identity?: { name: string, email: string } }} [options]
   */
  constructor(root, options = {}) {
    this.root = root;
    this.command = options.command ?? 'git';
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.identity = options.identity ?? { name: 'dsh-memory-ledger', email: 'ledger@dsh.local' };
  }

  async run(args, { signal, input } = {}) {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
      // Personal memory never leaves the machine through this module.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.autocrlf',
      GIT_CONFIG_VALUE_0: 'false',
    };
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { cwd: this.root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), this.timeoutMs);
      const onAbort = () => child.kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new GitError(`git failed to launch: ${error.message}`, { args }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Windows keeps the child's handles referenced after it exits, which
        // holds the Host process's event loop open for every git call it ever
        // made. The child is done here, so release the pipes and the handle.
        try {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
        } catch {
          // A handle already gone cannot hold anything open.
        }
        if (code !== 0) reject(new GitError(`git ${args[0]} exited ${code}: ${stderr.trim()}`, { args, exitCode: code, stderr }));
        else resolve(stdout);
      });
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  async isRepo() {
    try {
      await access(join(this.root, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  async init() {
    await mkdir(this.root, { recursive: true });
    if (await this.isRepo()) return;
    await this.run(['init', '-q', '-b', 'main']);
    await this.run(['config', 'user.name', this.identity.name]);
    await this.run(['config', 'user.email', this.identity.email]);
  }

  async head() {
    try {
      return (await this.run(['rev-parse', '--verify', 'HEAD'])).trim();
    } catch (error) {
      if (error instanceof GitError && /Needed a single revision|unknown revision|ambiguous argument/u.test(error.stderr ?? '')) return null;
      throw error;
    }
  }

  async isClean() {
    return (await this.statusPorcelain()) === '';
  }

  /** Raw porcelain status lines: untracked AND modified both count as not-clean. */
  async statusPorcelain() {
    return (await this.run(['status', '--porcelain'])).trim();
  }

  /** Stage exactly the given relative paths and commit. Returns the real commit hash. */
  async commitPaths(paths, message, { signal } = {}) {
    await this.run(['add', '--', ...paths], { signal });
    await this.run(['commit', '-q', '--no-verify', '--allow-empty-message', '-F', '-'], { signal, input: message });
    return (await this.run(['rev-parse', 'HEAD'], { signal })).trim();
  }

  /** Discard any staged or unstaged change to the given paths (used after a failed commit). */
  async restorePaths(paths) {
    const head = await this.head();
    if (head === null) {
      await this.run(['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', ...paths]).catch(() => {});
      return;
    }
    await this.run(['reset', '-q', 'HEAD', '--', ...paths]).catch(() => {});
    await this.run(['checkout', '-q', '--', ...paths]).catch(() => {});
    await this.run(['clean', '-q', '-f', '--', ...paths]).catch(() => {});
  }

  async show(commit, path) {
    return this.run(['show', `${commit}:${path}`]);
  }

  /** The committed blob at `commit` for `path`, or undefined when that path is absent there. */
  async showOrUndefined(commit, path) {
    try {
      return await this.show(commit, path);
    } catch (error) {
      if (error instanceof GitError && /does not exist|exists on disk, but not in|invalid object name|unknown revision/u.test(error.stderr ?? '')) return undefined;
      throw error;
    }
  }

  /** Paths recorded in the tree of one commit, optionally limited to a prefix. */
  async lsTree(commit, prefix = '') {
    const args = ['ls-tree', '-r', '--name-only', commit];
    if (prefix !== '') args.push('--', prefix);
    const out = await this.run(args);
    return out.split('\n').filter(Boolean);
  }

  /** The commit that last changed `path`, or undefined when no commit touched it. */
  async lastCommitFor(path) {
    const out = (await this.run(['log', '-1', '--format=%H', '--', path])).trim();
    return out === '' ? undefined : out;
  }

  async commitExists(commit) {
    try {
      await this.run(['cat-file', '-e', `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Commits touching a path, newest first: [{ hash, time, subject }]. */
  async log(path) {
    const out = await this.run(['log', '--format=%H%x1f%cI%x1f%s', '--', path]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [hash, time, subject] = line.split('\x1f');
      return { hash, time, subject };
    });
  }

  async lsFiles(prefix) {
    const out = await this.run(['ls-files', '--', prefix]);
    return out.split('\n').filter(Boolean);
  }
}
