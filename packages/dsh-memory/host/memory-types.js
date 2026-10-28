// Storage vocabulary for memories.
//
// The Git ledger accepts exactly MEMORY_TYPES. Extraction rules may name a
// rule-specific kind ('instruction') because that is what the sentence looks
// like; the write boundary maps such a rule kind to the ledger vocabulary
// instead of failing at review time with an opaque schema error.
//
// An unknown kind is never silently turned into 'fact': the caller must be
// able to refuse it and say why.

import { MEMORY_TYPES } from '../../provider-git-ledger/src/schema.js';

/** Rule kind -> ledger type. Only kinds with the same meaning are listed. */
export const TYPE_ALIASES = Object.freeze({ instruction: 'constraint' });

/** The ledger type for a rule kind, or null when the kind is unsupported. */
export function toLedgerType(type) {
  if (typeof type !== 'string' || type === '') return null;
  if (MEMORY_TYPES.includes(type)) return type;
  const alias = TYPE_ALIASES[type];
  return alias !== undefined && MEMORY_TYPES.includes(alias) ? alias : null;
}
