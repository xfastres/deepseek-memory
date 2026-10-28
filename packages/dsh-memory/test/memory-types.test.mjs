import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MEMORY_TYPES } from '../../provider-git-ledger/src/schema.js';
import { TYPE_ALIASES, toLedgerType } from '../host/memory-types.js';

test('every ledger type passes through unchanged', () => {
  for (const type of MEMORY_TYPES) assert.equal(toLedgerType(type), type);
});

test('a rule kind is mapped to the ledger type with the same meaning', () => {
  assert.deepEqual(TYPE_ALIASES, { instruction: 'constraint' });
  assert.equal(toLedgerType('instruction'), 'constraint');
  assert.ok(MEMORY_TYPES.includes(toLedgerType('instruction')));
});

test('an unsupported or missing kind is refused instead of guessed', () => {
  assert.equal(toLedgerType('gossip'), null);
  assert.equal(toLedgerType(''), null);
  assert.equal(toLedgerType(null), null);
  assert.equal(toLedgerType(42), null);
});
