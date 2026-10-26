// Memory Spaces child module for dsh-mnemon-source-memory-spaces 0.5.19.
// Mounted ONLY through that Source's `config.providers`; never a top-level plugin.
//
// This file is deliberately thin: real behavior is in ledger.js / projection.js /
// adapter.js, which are testable without Cordis.

import { join } from 'node:path';
import {
  MEMORY_SPACE_PROVIDER_API_VERSION,
  defineMemorySpaceProvider,
  defineMemorySpaceProviderDefinition,
} from 'dsh-mnemon-source-memory-spaces/provider-sdk';
import { GitLedgerAdapter } from './adapter.js';
import { descriptor } from './descriptor.js';

export { GitLedgerAdapter } from './adapter.js';
export { MemoryLedger, LedgerConflictError, EvidenceError, renderChangeNote } from './ledger.js';
export { ProjectionIndex } from './projection.js';
export { descriptor } from './descriptor.js';
export * as schema from './schema.js';

/**
 * Phase-1 evidence hook: the 0.5.19 RememberRequest carries no Session refs,
 * so a plain `mnemon_remember` call cannot be justified and is refused as a
 * `candidate`. A later phase supplies refs from the turn context. Tests and
 * embedders register a hook by name through `evidenceHooks`, because the
 * Source digests child config and refuses functions in it.
 */
const noEvidence = async () => undefined;
export const evidenceHooks = new Map([['none', noEvidence]]);

export function createDefinition({ dataDir, ownerId, evidence, evidenceHook, defaultRecallLimit } = {}) {
  const hook = evidence ?? evidenceHooks.get(evidenceHook ?? 'none');
  if (hook === undefined) throw new Error(`unknown git-ledger evidence hook: ${evidenceHook}`);
  return defineMemorySpaceProviderDefinition({
    manifest: {
      apiVersion: MEMORY_SPACE_PROVIDER_API_VERSION,
      kind: 'provider',
      typeId: descriptor.id,
      packageName: 'dsh-mnemon-provider-git-ledger',
      version: '0.0.1-alpha.0',
      label: descriptor.label,
      icon: descriptor.icon,
      summary: descriptor.summary,
      origin: descriptor.origin,
      locality: descriptor.kind,
      workspaceBinding: descriptor.workspaceBinding,
      capabilities: descriptor.capabilities,
      fields: descriptor.fields,
      secrets: [],
      scoreSemantics: 'normalized-relevance',
    },
    create(context) {
      const authority = context.memorySpaces ?? context.memoryBodies;
      return new GitLedgerAdapter({
        dataDir: dataDir ?? join(authority.runner.effectiveDataDir(), 'git-ledger'),
        ownerId: ownerId ?? 'local-user',
        defaultRecallLimit: defaultRecallLimit ?? context.config.defaultRecallLimit ?? 10,
        evidence: hook,
      });
    },
  });
}

export const definition = createDefinition();

export default defineMemorySpaceProvider({
  id: descriptor.id,
  apply(ctx, host, config) {
    host.install(ctx, config === undefined ? definition : createDefinition(config));
  },
});
