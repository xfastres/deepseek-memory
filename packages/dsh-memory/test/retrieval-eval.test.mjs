// Retrieval quality on a realistic corpus.
//
// The scoring is lexical (latin words plus CJK bigrams), so the honest question
// is not "does it return something" but "does the right memory come first".
// Each case is a real phrasing a user might type, paired with the one memory
// that should answer it.
//
// This is a regression net, not a benchmark: if a weight change breaks recall,
// the failure names the query.

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectMemories } from '../host/retrieval.js';
import { RETRIEVAL_CASES, SEARCH_PARITY_QUERIES, retrievalCorpus } from '../eval/retrieval-cases.mjs';
import { evaluateRetrieval, evaluateSearchParity } from '../eval/retrieval-eval.mjs';

const now = () => new Date('2026-10-28T08:00:00.000Z');

function memory(id, content, extra = {}) {
  return {
    id,
    status: 'active',
    scope: 'global',
    type: 'fact',
    content,
    importance: 3,
    confidence: 0.9,
    accepted_at: '2026-10-20T00:00:00.000Z',
    last_change_id: 'MC-1',
    ...extra,
  };
}

const CORPUS = [
  memory('M-deps', '项目用 pnpm 而不是 npm 安装依赖'),
  memory('M-commit', '提交信息使用中文，不要用 emoji'),
  memory('M-style', '用户偏好简洁回答，避免冗长铺垫'),
  memory('M-path', 'dsh-memory 的账本位于 ~/.dsh/dsh-memory/ledger'),
  memory('M-inject', '记忆注入通过 systemPrompt.context 注册'),
  memory('M-log', '会话日志是 zstd 压缩的 jsonl，不要直接解析'),
  memory('M-test', '测试用 node --test 单独文件运行'),
  memory('M-shell', 'Windows 下用 pwsh 而不是 bash'),
  memory('M-lang', '所有回答都用中文'),
  memory('M-weight', '检索权重：lexical 0.6，recency 0.15，importance 0.15，confidence 0.1'),
];

const CASES = [
  { query: '怎么装依赖', expect: 'M-deps' },
  { query: '提交说明要不要加 emoji', expect: 'M-commit' },
  { query: '回答能简短点吗', expect: 'M-style' },
  { query: '账本放在哪个目录', expect: 'M-path' },
  { query: '怎么把记忆塞进提示词', expect: 'M-inject' },
  { query: '能直接读 session 的压缩文件吗', expect: 'M-log' },
  { query: '测试怎么跑', expect: 'M-test' },
  { query: '命令行用哪个 shell', expect: 'M-shell' },
  { query: '用什么语言回答', expect: 'M-lang' },
  { query: '检索的权重是多少', expect: 'M-weight' },
];

function rank(query, limit = CORPUS.length) {
  const result = selectMemories(CORPUS, query, { now: now(), limit, budget: 100000 });
  return result.chosen.map((entry) => entry.memory.id);
}

test('every realistic query puts its memory in the top three', () => {
  const misses = [];
  for (const { query, expect } of CASES) {
    const ordered = rank(query);
    const position = ordered.indexOf(expect);
    if (position === -1 || position > 2) misses.push({ query, expect, ordered: ordered.slice(0, 3), position });
  }
  assert.deepEqual(misses, [], `recall@3 failures: ${JSON.stringify(misses, null, 2)}`);
});

test('most realistic queries put their memory first', () => {
  const misses = [];
  for (const { query, expect } of CASES) {
    const ordered = rank(query);
    if (ordered[0] !== expect) misses.push({ query, expect, first: ordered[0] });
  }
  const hit = CASES.length - misses.length;
  assert.ok(hit / CASES.length >= 0.8, `recall@1 ${hit}/${CASES.length}: ${JSON.stringify(misses, null, 2)}`);
});

test('the evaluation set holds the hard rule: nothing forbidden is ever injected', () => {
  // §9.2 and §13.2: retracted, private and inferred material must reach the
  // block zero times. This is the one metric with a hard target, so it is a
  // gate; the other numbers are measurements and live in the CLI.
  const result = evaluateRetrieval({ corpus: retrievalCorpus(), cases: RETRIEVAL_CASES });
  assert.equal(result.forbiddenInjections, 0, `forbidden material reached the block: ${JSON.stringify(result.rows.filter((row) => row.forbidden.length > 0))}`);
  // And the corpus really does contain such material, so the check is not vacuous.
  const corpus = retrievalCorpus();
  assert.ok(corpus.some((memory) => memory.status === 'retracted'));
  assert.ok(corpus.some((memory) => memory.sensitivity === 'private'));
  assert.ok(corpus.some((memory) => memory.type === 'hypothesis'));
});

test('the evaluation set keeps its measured recall floor', () => {
  // A weight change that breaks recall should fail here and name the query.
  // The floor is below the current 94.7% so ordinary tuning has room, but high
  // enough that a real regression cannot pass.
  const result = evaluateRetrieval({ corpus: retrievalCorpus(), cases: RETRIEVAL_CASES });
  const misses = result.rows.filter((row) => row.expect !== null && (row.position === -1 || row.position >= 5));
  assert.ok(
    result.recallAt5 >= 0.9,
    `recall@5 ${(result.recallAt5 * 100).toFixed(1)}% is below the 90% floor; misses: ${JSON.stringify(misses.map((row) => ({ query: row.query, expect: row.expect, top: row.top })))}`,
  );
  assert.ok(result.recallAt1 >= 0.65, `recall@1 ${(result.recallAt1 * 100).toFixed(1)}% is below the 65% floor`);
});

test('a query with no relevant memory keeps the block empty', () => {
  const result = evaluateRetrieval({ corpus: retrievalCorpus(), cases: RETRIEVAL_CASES });
  for (const row of result.rows.filter((entry) => entry.expect === null)) {
    assert.equal(row.injected, 0, `"${row.query}" should inject nothing, got ${JSON.stringify(row.top)}`);
  }
});

test('memory_search never exposes what injection would hide', () => {
  // §11: the tool shares the injector's window. A memory the injector refuses
  // must not be findable through the tool either.
  const parity = evaluateSearchParity({ corpus: retrievalCorpus(), queries: SEARCH_PARITY_QUERIES });
  assert.deepEqual(parity.leaks, [], 'search leaked hidden material');
  assert.ok(parity.queries > 0, 'the parity check ran on real queries');
});

test('a query matching nothing keeps the block small instead of dumping the store', () => {
  const result = selectMemories(CORPUS, '周杰伦的演唱会门票', { now: now(), limit: 6, budget: 800 });
  assert.ok(result.chosen.length <= 6);
  for (const entry of result.chosen) {
    assert.equal(entry.score.parts.pinned, false);
  }
});

test('an empty query still respects the limit', () => {
  const result = selectMemories(CORPUS, '', { now: now(), limit: 3, budget: 800 });
  assert.equal(result.chosen.length, 3);
});
