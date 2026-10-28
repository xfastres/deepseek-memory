import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Hash every original session artifact so a read-only probe can prove it did not write them. */
export async function sessionFileDigests(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) {
        result[path] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    }
  }
  await visit(root);
  return result;
}
