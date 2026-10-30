import assert from 'node:assert/strict';
import test from 'node:test';

import { bannerText, createLiveView, isHeartbeatHttp, replayLive } from './memory-flow-live.mjs';

const at = '2026-10-30T06:02:03.000Z';

function ev(seq, kind, extra = {}) {
  return { seq, at, kind, ...extra };
}

function turn(extra = {}) {
  return [
    ev(1, 'http', { method: 'GET', route: '/api/dsh-memory/trace', ms: 2, status: 200 }),
    ev(2, 'http', { method: 'GET', route: '/api/dsh-memory/state', ms: 4, status: 200 }),
    ev(3, 'http', { method: 'GET', route: '/api/dsh-memory/candidates', ms: 3, status: 200 }),
    ev(4, 'pre-step:enter', { sessionId: 'sess-learn', turn: 3, step: 1, messages: 4 }),
    ev(5, 'http', { method: 'GET', route: '/api/dsh-memory/trace', ms: 1, status: 200 }),
    ev(6, 'observe', {
      sessionId: 'sess-learn',
      turn: 3,
      queryChars: 12,
      query: '记住：我习惯用 pwsh',
      observePath: 'scope',
      lookupPath: 'latest',
      candidates: 1,
      candidateRules: ['instruction'],
    }),
    ev(7, 'snapshot', { memories: 12, suppressed: 1, head: 'abc123def4567890', degraded: null }),
    ev(8, 'constraints', { loaded: true, usable: 1, fallback: [] }),
    ev(9, 'pre-step:exit', { providerRegistered: true, skipped: null, calls: 4 }),
    ev(10, 'http', { method: 'GET', route: '/api/dsh-memory/trace', ms: 1, status: 200 }),
    ev(11, 'inject', {
      path: 'latest',
      chars: extra.chars ?? 24,
      chosen: [{ id: 'M-1', kind: 'memory', chars: 10, reason: '词面命中' }],
      excluded: [{ id: 'M-2', reason: 'no-lexical-match' }],
      pools: { constraint: { used: 0, budget: 240 }, dynamic: { used: 10, budget: 800 } },
      text: extra.text === undefined ? '以下是已确认的记忆' : extra.text,
    }),
    ev(12, 'candidate', {
      id: 'C-1',
      text: '记住：我习惯用 pwsh',
      type: 'instruction',
      confidence: 0.85,
      rule: 'instruction',
      entities: 0,
    }),
    ev(13, 'candidate:policy', {
      id: 'C-1',
      decision: extra.decision ?? 'REVIEW_REQUIRED',
      status: extra.status ?? 'review_pending',
      reasons: extra.reasons ?? ['auto-accept-disabled'],
    }),
  ];
}

test('heartbeat is the tracer poll and the panel read GETs', () => {
  assert.equal(isHeartbeatHttp(ev(1, 'http', { method: 'GET', route: '/api/dsh-memory/trace' })), true);
  assert.equal(isHeartbeatHttp(ev(1, 'http', { method: 'GET', route: '/api/dsh-memory/state' })), true);
  assert.equal(isHeartbeatHttp(ev(1, 'http', { method: 'GET', route: '/api/dsh-memory/candidates' })), true);
  assert.equal(isHeartbeatHttp(ev(1, 'http', { method: 'POST', route: '/api/dsh-memory/review' })), false);
  assert.equal(isHeartbeatHttp(ev(1, 'http', { method: 'GET', route: '/api/dsh-memory/review' })), false);
});

test('a real turn reads as 进去 / 做了什么 / 出来 and hides polls', () => {
  const text = replayLive(turn(), { color: false });
  assert.match(text, /进去/);
  assert.match(text, /做了什么/);
  assert.match(text, /出来/);
  assert.match(text, /记住：我习惯用 pwsh/);
  assert.match(text, /sess-learn/);
  assert.match(text, /第 3 轮/);
  assert.match(text, /抽出\s+1 条/);
  assert.match(text, /入队\s+1 条/);
  assert.match(text, /24 字/);
  assert.match(text, /以下是已确认的记忆/);
  assert.match(text, /不写账本/);
  assert.match(text, /可自动接受（自动接受已关闭）/);
  assert.match(text, /不能在那里等 Git/);
  assert.match(text, /藏起 2 条/);
  assert.match(text, /例如 GET \/trace/);
  assert.doesNotMatch(text, /GET \/state/);
  assert.doesNotMatch(text, /GET \/candidates/);
  assert.doesNotMatch(text, /事件里只留了前/);
});

test('auto-accept does not claim the ledger write already succeeded', () => {
  const text = replayLive(turn({ decision: 'AUTO_ACCEPT', status: 'auto_accepted', reasons: ['eligible'] }), { color: false });
  assert.match(text, /写入之前/);
  assert.match(text, /写没写成这里看不出来/);
  assert.doesNotMatch(text, /已经写入/);
  assert.doesNotMatch(text, /已进账本/);
});

test('zero-character injection is visible', () => {
  const text = replayLive(turn({ chars: 0, text: '' }), { color: false });
  assert.match(text, /0 字/);
  assert.match(text, /没有往提示词里放内容/);
});

test('empty ledger skips injection instead of pretending something was injected', () => {
  const records = [
    ev(1, 'pre-step:enter', { sessionId: 's', turn: 1, step: 1, messages: 1 }),
    ev(2, 'observe', { queryChars: 4, query: '你好', observePath: 'scope', candidates: 0, candidateRules: [] }),
    ev(3, 'snapshot', { memories: 0, suppressed: 0, head: null }),
    ev(4, 'constraints', { loaded: true, usable: 0, fallback: [] }),
    ev(5, 'pre-step:exit', { providerRegistered: false, skipped: 'no-active-memory', calls: 0 }),
  ];
  const text = replayLive(records, { color: false });
  assert.match(text, /没有 active 记忆/);
  assert.match(text, /注入\s+没有/);
  assert.doesNotMatch(text, /实际放进提示词/);
});

test('panel write is shown, and the body is not invented', () => {
  const text = replayLive([
    ev(1, 'http', { method: 'POST', route: '/api/dsh-memory/review', ms: 20, status: 200 }),
  ], { color: false });
  assert.match(text, /POST \/review/);
  assert.match(text, /不是账本回执/);
  assert.match(text, /接受或合并才经 Writer 进账本/);
  assert.doesNotMatch(text, /已经写入/);
});

test('raw-http prints the poll the default view hides', () => {
  const text = replayLive(turn(), { color: false, rawHttp: true });
  assert.match(text, /GET \/trace/);
  assert.match(text, /记住：我习惯用 pwsh/);
});

test('compact stays one line per real event and still hides polls', () => {
  const text = replayLive(turn(), { color: false, compact: true });
  assert.match(text, /观察\/提取/);
  assert.match(text, /注入 prompt/);
  assert.doesNotMatch(text, /GET \/trace/);
  assert.doesNotMatch(text, /做了什么/);
});

test('candidates that arrive on the next poll still land in the same card', () => {
  const view = createLiveView({ color: false });
  const records = turn().filter((rec) => rec.kind !== 'candidate' && rec.kind !== 'candidate:policy');
  for (const rec of records) view.push(rec);
  assert.equal(view.endBatch(), '');
  view.push(ev(12, 'candidate', {
    id: 'C-1', text: '记住：我习惯用 pwsh', type: 'instruction', confidence: 0.85, rule: 'instruction', entities: 0,
  }));
  view.push(ev(13, 'candidate:policy', {
    id: 'C-1', decision: 'REVIEW_REQUIRED', status: 'review_pending', reasons: ['auto-accept-disabled'],
  }));
  const card = view.endBatch();
  assert.match(card, /进去/);
  assert.match(card, /入队\s+1 条/);
  assert.match(card, /不写账本/);
  assert.doesNotMatch(card, /补上候选/);
});

test('a panel write that arrives after the step is printed under that step', () => {
  const records = [
    ...turn(),
    ev(14, 'http', { method: 'POST', route: '/api/dsh-memory/review', ms: 20, status: 200 }),
  ];
  const text = replayLive(records, { color: false });
  const card = text.indexOf('sess-learn');
  const post = text.indexOf('POST /review');
  assert.ok(card >= 0 && post > card);
});

test('an earlier inject stays above the next message instead of being mixed into it', () => {
  const records = [
    ev(1, 'http', { method: 'GET', route: '/api/dsh-memory/trace', ms: 1, status: 200 }),
    ev(2, 'inject', { path: 'latest', chars: 0, text: '', chosen: [], excluded: [] }),
    ...turn().map((rec, index) => ({ ...rec, seq: index + 3 })),
  ];
  const text = replayLive(records, { color: false });
  const prior = text.indexOf('这条事件不带原文和轮次');
  const sessionAt = text.indexOf('sess-learn');
  const query = text.indexOf('记住：我习惯用 pwsh');
  assert.ok(prior >= 0 && sessionAt > prior && query > sessionAt);
  assert.match(text.slice(prior, sessionAt), /0 字/);
});

test('startup note explains the same three beats the cards use', () => {
  const text = bannerText({});
  assert.match(text, /进去/);
  assert.match(text, /做了什么/);
  assert.match(text, /出来/);
  assert.match(text, /不能在那里等 Git/);
  assert.match(text, /GET \/trace/);
  assert.match(text, /--raw-http/);
  assert.match(text, /不写账本/);
});
