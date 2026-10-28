import test from 'node:test';
import assert from 'node:assert/strict';

import { extractCandidates, refusal, sentences } from '../host/extraction.js';

test('sentences split on terminal punctuation and keep the words', () => {
  assert.deepEqual(sentences('第一句。第二句！第三句？'), ['第一句', '第二句', '第三句']);
  assert.deepEqual(sentences('没有标点的一句话'), ['没有标点的一句话']);
  assert.deepEqual(sentences(''), []);
  assert.deepEqual(sentences(undefined), []);
});

test('a plain preference becomes a candidate with its evidence', () => {
  const found = extractCandidates('我更喜欢简洁的回答。');
  assert.equal(found.length, 1);
  assert.equal(found[0].type, 'preference');
  assert.equal(found[0].text, '我更喜欢简洁的回答');
  assert.deepEqual(found[0].matched, ['我更喜欢']);
  assert.equal(found[0].rule, 'preference');
});

test('an explicit memory instruction outranks a passing preference', () => {
  const found = extractCandidates('记住：这个项目不要用 npm。我比较喜欢 pnpm。');
  assert.equal(found.length, 2);
  assert.equal(found[0].type, 'instruction');
  assert.ok(found[0].confidence > found[1].confidence);
});

test('a question never becomes a candidate', () => {
  assert.equal(refusal('你喜欢简洁的回答吗？'), 'question');
  assert.equal(refusal('这个是不是应该用 pnpm？'), 'question');
  assert.deepEqual(extractCandidates('以后都用 pnpm 吗？'), []);
});

test('a hypothetical never becomes a candidate', () => {
  assert.equal(refusal('如果以后要部署，就不要再改路径了'), 'hypothetical');
  assert.deepEqual(extractCandidates('假如我以后都想要中文回复呢'), []);
});

test('uncertainty lowers confidence without inventing certainty', () => {
  const [certain] = extractCandidates('以后都请用中文回答。');
  const [unsure] = extractCandidates('以后大概都请用中文回答吧。');
  assert.ok(certain.confidence > unsure.confidence);
  assert.ok(unsure.confidence >= 0.3);
});

test('an emphatic instruction gains confidence but stays bounded', () => {
  const [plain] = extractCandidates('记住这个约定。');
  const [strong] = extractCandidates('以后务必记住这个约定。');
  assert.ok(strong.confidence >= plain.confidence);
  assert.ok(strong.confidence <= 0.95);
});

test('a repeated sentence is reported once', () => {
  const found = extractCandidates('以后都用 pnpm。以后都用 pnpm。');
  assert.equal(found.length, 1);
});

test('a turn never yields more than the cap', () => {
  const text = '记住第一件事。记住第二件事。记住第三件事。记住第四件事。';
  assert.equal(extractCandidates(text).length, 3);
  assert.equal(extractCandidates(text, { maxPerTurn: 1 }).length, 1);
});

test('chat that says nothing durable yields nothing', () => {
  assert.deepEqual(extractCandidates('今天天气不错，我们看看这个文件怎么改。'), []);
  assert.deepEqual(extractCandidates(''), []);
  assert.deepEqual(extractCandidates(undefined), []);
});

test('an over-long sentence is refused rather than truncated', () => {
  const long = '记住' + '啊'.repeat(250);
  assert.deepEqual(extractCandidates(long), []);
});
