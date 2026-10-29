import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CanonicalError,
  EvidenceConflictError,
  canonicalIntent,
  canonicalIntentJson,
  intentHash,
  normalizeSourceRefs,
} from '../../provider-git-ledger/src/canonical.js';

const REF = { session_id: 's1', event_seq: 2, event_type: 'user/message', quote_sha256: 'a'.repeat(64) };

function intent(over = {}) {
  return {
    change_type: 'ADD',
    content: '项目使用 pnpm',
    type: 'fact',
    scope: 'global',
    tags: ['tooling'],
    entities: ['pnpm'],
    source_refs: [REF],
    source_kind: 'user-explicit',
    ...over,
  };
}

test('key order does not change the hash', () => {
  const first = intent();
  const second = {
    source_kind: first.source_kind,
    source_refs: first.source_refs,
    entities: first.entities,
    tags: first.tags,
    scope: first.scope,
    type: first.type,
    content: first.content,
    change_type: first.change_type,
  };
  assert.equal(intentHash(first), intentHash(second));
});

test('source ref order does not change the hash', () => {
  const later = { session_id: 's2', event_seq: 1, event_type: 'user/message' };
  const earlier = { session_id: 's1', event_seq: 9, event_type: 'user/message' };
  assert.equal(
    intentHash(intent({ source_refs: [later, earlier] })),
    intentHash(intent({ source_refs: [earlier, later] })),
  );
  assert.deepEqual(normalizeSourceRefs([later, earlier]).map((ref) => ref.session_id), ['s1', 's2']);
});

test('exact duplicate refs collapse to one', () => {
  const refs = normalizeSourceRefs([REF, { ...REF }]);
  assert.equal(refs.length, 1);
});

test('the same event with a different quote is a conflict', () => {
  assert.throws(
    () => normalizeSourceRefs([REF, { ...REF, quote_sha256: 'b'.repeat(64) }]),
    (error) => error instanceof EvidenceConflictError && error.error === 'evidence-conflict',
  );
});

test('a missing field is not the same as null', () => {
  const omitted = canonicalIntent(intent({ scope: undefined }));
  const explicit = canonicalIntent(intent({ scope: null }));
  assert.equal(omitted.scope, undefined);
  assert.equal(explicit.scope, null);
  assert.notEqual(canonicalIntentJson(intent({ scope: undefined })), canonicalIntentJson(intent({ scope: null })));
});

test('unicode normalization is not applied before hashing', () => {
  const composed = 'é';
  const decomposed = 'é';
  assert.notEqual(intentHash(intent({ content: composed })), intentHash(intent({ content: decomposed })));
});

test('an unpaired surrogate is refused before hashing', () => {
  assert.throws(
    () => intentHash(intent({ content: '\uD800' })),
    (error) => error instanceof CanonicalError && error.error === 'invalid-text',
  );
});

test('negative zero and non-integers are refused', () => {
  assert.throws(() => normalizeSourceRefs([{ session_id: 's', event_seq: -0 }]), CanonicalError);
  assert.throws(() => normalizeSourceRefs([{ session_id: 's', event_seq: 1.5 }]), CanonicalError);
  assert.deepEqual(normalizeSourceRefs([{ session_id: 's', event_seq: 1e2 }]), [
    { session_id: 's', event_seq: 100 },
  ]);
});

test('empty content is refused', () => {
  assert.throws(
    () => canonicalIntent(intent({ content: '   ' })),
    (error) => error instanceof CanonicalError && error.error === 'empty-content',
  );
});
