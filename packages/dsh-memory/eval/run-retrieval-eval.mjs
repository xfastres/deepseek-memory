// Run the retrieval evaluation set and print what it measured.
//
// Read-only by construction: pure functions in, numbers out. No ledger, no
// runtime store, no files.
//
//   node packages/dsh-memory/eval/run-retrieval-eval.mjs
//
// Exit code is always 0: this is a measurement, not a gate. The gate lives in
// test/retrieval-eval.test.mjs.

import { RETRIEVAL_CASES, SEARCH_PARITY_QUERIES, retrievalCorpus } from './retrieval-cases.mjs';
import { evaluateRetrieval, evaluateSearchParity, summariseRetrieval } from './retrieval-eval.mjs';

const corpus = retrievalCorpus();
const result = evaluateRetrieval({ corpus, cases: RETRIEVAL_CASES });

console.log(summariseRetrieval(result));

const missed = result.rows.filter((row) => row.expect !== null && (row.position === -1 || row.position >= 5));
if (missed.length > 0) {
  console.log('');
  console.log(`recall@5 misses (${missed.length}):`);
  for (const row of missed) {
    console.log(`  ${row.id}: expected ${row.expect}, top 5 ${JSON.stringify(row.top)}`);
  }
}

const noisy = result.rows.filter((row) => row.unexpected > 0);
if (noisy.length > 0) {
  console.log('');
  console.log(`cases with unexpected entries (${noisy.length}):`);
  for (const row of noisy) {
    console.log(`  ${row.id}: ${row.unexpected} unexpected, injected ${JSON.stringify(row.top.slice(0, row.injected))}`);
  }
}

const parity = evaluateSearchParity({ corpus, queries: SEARCH_PARITY_QUERIES });
console.log('');
console.log(`search parity: ${parity.queries} queries, ${parity.leaks.length} leaks`);
for (const leak of parity.leaks) {
  console.log(`  LEAK ${leak.id} for "${leak.query}" (${leak.reason})`);
}

console.log('');
console.log('per case:');
for (const row of result.rows) {
  const mark = row.expect === null
    ? (row.injected === 0 ? 'ok  ' : 'noise')
    : (row.position === 0 ? 'ok  ' : row.position === -1 ? 'miss' : `#${row.position + 1}`);
  console.log(`  ${mark} ${row.id}: injected ${row.injected}, ${row.chars} chars`);
}
