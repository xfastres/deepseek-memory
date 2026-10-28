// Extraction evaluation harness (5.1).
//
// Pure: it takes cases and an extractor, returns per-case outcomes and the
// §13.1-style aggregates. It never writes a memory, a ledger or a file.
//
// A case expectation is a count of candidates: `expect: 'none'` means zero,
// `expect: 'candidate'` without `count` means at least one. Count-based
// matching keeps the arithmetic honest even when the extractor finds more or
// fewer sentences than expected.

import { extractCandidates } from '../host/extraction.js';
import { toLedgerType } from '../host/memory-types.js';

function expectedCountOf(entry) {
  if (entry === null || typeof entry !== 'object') return null;
  if (entry.expect === 'none') return 0;
  if (entry.expect !== 'candidate') return null;
  return Number.isInteger(entry.count) && entry.count >= 0 ? entry.count : 1;
}

/** Rate, or null when the denominator is zero: no cases, no claim. */
function rate(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

/**
 * Measure one extractor against a set of cases.
 *
 * @param {Array<object>} cases
 * @param {{extract?: Function}} [options]
 * @returns {{
 *   rows: Array<object>,
 *   cases: number,
 *   expected: number,
 *   extracted: number,
 *   truePositives: number,
 *   falsePositives: number,
 *   falseNegatives: number,
 *   precision: number|null,
 *   recall: number|null,
 *   exactCountCases: number,
 *   exactCountMatches: number,
 *   byType: Record<string, number>,
 *   missed: Array<object>,
 *   extra: Array<object>,
 * }}
 */
export function evaluateExtraction(cases, options = {}) {
  const extract = typeof options.extract === 'function' ? options.extract : extractCandidates;
  const list = Array.isArray(cases) ? cases.filter((entry) => entry !== null && typeof entry === 'object') : [];

  const rows = [];
  const byType = {};
  const missed = [];
  const extra = [];
  let expected = 0;
  let extractedTotal = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let exactCountCases = 0;
  let exactCountMatches = 0;

  for (const entry of list) {
    const want = expectedCountOf(entry);
    const found = extract(entry.text, entry.maxPerTurn === undefined ? {} : { maxPerTurn: entry.maxPerTurn });
    const foundRows = Array.isArray(found) ? found : [];
    const types = foundRows.map((row) => (row !== null && typeof row === 'object' ? toLedgerType(row.type) ?? row.type : null));
    if (want === null) {
      rows.push({ id: entry.id ?? null, want, got: foundRows.length, types, ignored: true });
      continue;
    }
    const tp = Math.min(foundRows.length, want);
    const fp = Math.max(0, foundRows.length - want);
    const fn = Math.max(0, want - foundRows.length);
    expected += want;
    extractedTotal += foundRows.length;
    truePositives += tp;
    falsePositives += fp;
    falseNegatives += fn;
    exactCountCases += 1;
    if (foundRows.length === want) exactCountMatches += 1;
    for (const type of types) {
      const key = type === null ? 'unknown' : String(type);
      byType[key] = (byType[key] ?? 0) + 1;
    }
    const row = { id: entry.id ?? null, want, got: foundRows.length, types, text: entry.text };
    rows.push(row);
    if (foundRows.length < want) missed.push({ ...row, note: entry.note ?? null });
    if (foundRows.length > want) extra.push({ ...row, note: entry.note ?? null });
  }

  return {
    rows,
    cases: list.length,
    expected,
    extracted: extractedTotal,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: rate(truePositives, truePositives + falsePositives),
    recall: rate(truePositives, truePositives + falseNegatives),
    exactCountCases,
    exactCountMatches,
    byType,
    missed,
    extra,
  };
}

/** One-line human summary for logs and progress notes. */
export function summariseExtraction(result) {
  const percent = (value) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
  return [
    `cases ${result.cases}`,
    `expected ${result.expected}`,
    `extracted ${result.extracted}`,
    `precision ${percent(result.precision)}`,
    `recall ${percent(result.recall)}`,
    `exact-count ${result.exactCountMatches}/${result.exactCountCases}`,
  ].join(' · ');
}
