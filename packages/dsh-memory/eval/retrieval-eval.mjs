// Retrieval evaluation: the numbers roadmap §13.2 asks for.
//
// §13.2 wants a 20–50 case set annotated with the memory each query should
// retrieve, and these metrics:
//
//   recall@5            did the expected memory appear in the top five
//   false-injection     how much unrelated material entered the block
//   mean injected chars how big the block is per turn
//   forbidden injections  retracted / superseded / private / objected memories
//                         that reached the block; the target is zero
//
// This is a measurement harness, not a gate. The gate lives in the test suite;
// here the numbers are printed so a weight change can be judged by them.
//
// Read-only by construction: it imports pure functions and prints.

import { formatInjection, selectMemories } from '../host/retrieval.js';
import { searchMemories } from '../host/search.js';

/**
 * Run every case and compute the metrics.
 *
 * `now` is fixed so recency scoring cannot drift between runs and make two
 * measurements incomparable.
 */
export function evaluateRetrieval({ corpus, cases, now, limit = 8, budget = 800 } = {}) {
  const at = now ?? new Date('2026-10-28T08:00:00.000Z');
  const rows = [];
  let recallAt5 = 0;
  let recallAt1 = 0;
  let totalChars = 0;
  let totalInjected = 0;
  let totalUnexpected = 0;
  let forbidden = 0;

  for (const item of cases) {
    const result = selectMemories(corpus, item.query, { now: at, limit, budget });
    const ids = result.chosen.map((entry) => entry.memory.id);
    const position = item.expect === null ? -1 : ids.indexOf(item.expect);
    const text = formatInjection(result.chosen);

    // Anything that reached the block without being the expected memory counts
    // as unexpected. A case with no expectation (`expect: null`) expects an
    // empty block, so every entry is unexpected.
    const unexpected = item.expect === null
      ? ids.length
      : ids.filter((id) => id !== item.expect).length;

    // The one metric with a hard target of zero: material the roadmap forbids
    // from ordinary retrieval (§9.2) must never appear, whatever the query.
    const forbiddenHere = result.chosen.filter((entry) => {
      const memory = entry.memory;
      if (memory.status !== 'active') return true;
      if (memory.sensitivity === 'private') return true;
      if (memory.type === 'hypothesis') return true;
      return false;
    }).map((entry) => entry.memory.id);

    if (item.expect !== null && position !== -1 && position < 5) recallAt5 += 1;
    if (item.expect !== null && position === 0) recallAt1 += 1;
    totalChars += text.length;
    totalInjected += ids.length;
    totalUnexpected += unexpected;
    forbidden += forbiddenHere.length;

    rows.push({
      id: item.id ?? item.query,
      query: item.query,
      expect: item.expect,
      position,
      top: ids.slice(0, 5),
      injected: ids.length,
      unexpected,
      chars: text.length,
      forbidden: forbiddenHere,
    });
  }

  const scored = cases.filter((item) => item.expect !== null).length;
  return {
    cases: cases.length,
    scored,
    recallAt5: scored === 0 ? 0 : recallAt5 / scored,
    recallAt1: scored === 0 ? 0 : recallAt1 / scored,
    // Share of injected entries that were not the expected memory.
    falseInjectionRate: totalInjected === 0 ? 0 : totalUnexpected / totalInjected,
    meanInjectedChars: cases.length === 0 ? 0 : totalChars / cases.length,
    meanInjectedEntries: cases.length === 0 ? 0 : totalInjected / cases.length,
    forbiddenInjections: forbidden,
    rows,
  };
}

/**
 * Does `memory_search` expose anything injection would refuse?
 *
 * The tool shares the injector's window (§11), so a memory the injector hides
 * must not be findable through it either. Reported separately because it is a
 * different surface with the same rule.
 */
export function evaluateSearchParity({ corpus, queries, now } = {}) {
  const at = now ?? new Date('2026-10-28T08:00:00.000Z');
  const leaks = [];
  for (const query of Array.isArray(queries) ? queries : []) {
    const found = searchMemories(corpus, query, { now: at });
    for (const row of found.results) {
      const memory = corpus.find((entry) => entry.id === row.id);
      if (memory === undefined) continue;
      const hidden = memory.status !== 'active'
        || memory.sensitivity === 'private'
        || memory.type === 'hypothesis';
      if (hidden) leaks.push({ query, id: row.id, reason: 'injector-would-hide' });
    }
  }
  return { queries: Array.isArray(queries) ? queries.length : 0, leaks };
}

/** One readable line per metric, for the CLI. */
export function summariseRetrieval(result) {
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  return [
    `cases ${result.cases} · scored ${result.scored}`,
    `recall@5 ${pct(result.recallAt5)} · recall@1 ${pct(result.recallAt1)}`,
    `false-injection ${pct(result.falseInjectionRate)}`,
    `mean injected ${result.meanInjectedChars.toFixed(0)} chars / ${result.meanInjectedEntries.toFixed(2)} entries`,
    `forbidden injections ${result.forbiddenInjections} (target 0)`,
  ].join('\n');
}
