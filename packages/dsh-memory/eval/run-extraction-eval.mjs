// Run the extraction evaluation set and print what it measured.
//
// Read-only by construction: it imports the pure extractor and the pure
// harness, and prints. No ledger, no runtime store, no files.
//
//   node packages/dsh-memory/eval/run-extraction-eval.mjs
//
// Exit code is always 0: this is a measurement, not a gate. A gate belongs in
// the test suite once the numbers have been reviewed.

import { EXTRACTION_CASES } from './extraction-cases.mjs';
import { evaluateExtraction, summariseExtraction } from './extraction-eval.mjs';

const result = evaluateExtraction(EXTRACTION_CASES);

console.log(summariseExtraction(result));
console.log('');
console.log('by type:', JSON.stringify(result.byType));
if (result.missed.length > 0) {
  console.log('');
  console.log(`missed (${result.missed.length}):`);
  for (const row of result.missed) {
    console.log(`  ${row.id}: want ${row.want}, got ${row.got}${row.note === null ? '' : ` (${row.note})`} — ${row.text.slice(0, 50)}`);
  }
}
if (result.extra.length > 0) {
  console.log('');
  console.log(`extra (${result.extra.length}):`);
  for (const row of result.extra) {
    console.log(`  ${row.id}: want ${row.want}, got ${row.got} — ${row.text.slice(0, 50)}`);
  }
}
console.log('');
console.log('per case:');
for (const row of result.rows) {
  const mark = row.ignored === true ? 'skip' : row.want === row.got ? 'ok  ' : 'diff';
  console.log(`  ${mark} ${row.id}: want ${row.want}, got ${row.got}, types ${JSON.stringify(row.types)}`);
}
