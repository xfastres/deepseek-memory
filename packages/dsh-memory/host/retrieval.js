// Retrieval and injection for the memory Host half.
//
// The roadmap asks for the simplest thing that can be explained: every memory
// that reaches a conversation must be able to answer "why is this here". So
// scoring is a plain weighted sum with the parts kept, and selection is a
// budgeted, deterministic pass over eligible memories. There is no vector
// index here yet, on purpose: a score nobody can read cannot be debugged.

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const WORD = /[a-z0-9]+/giu;

/**
 * Cross-language aliases, both directions.
 *
 * A user asks "命令行用哪个 shell" while the memory says "用 pwsh 而不是 bash";
 * lexical scoring cannot see that those are the same topic. A vector index
 * would, but the roadmap keeps that for when the evaluation set proves the
 * need — and one narrow gap is cheaper to close with a curated table than with
 * an embedding pipeline nobody can debug.
 *
 * Only terms whose meaning is unambiguous belong here. The table is small on
 * purpose: an alias that is wrong makes a memory appear where it does not
 * belong, which is worse than a miss.
 */
const ALIASES = new Map([
  ['shell', ['bash', 'pwsh', 'zsh', 'terminal', '命令行', '终端']],
  ['bash', ['shell', 'pwsh', '命令行']],
  ['pwsh', ['shell', 'bash', 'powershell', '命令行']],
  ['test', ['测试']],
  ['测试', ['test']],
  ['deps', ['依赖', 'dependency']],
  ['依赖', ['deps', 'dependency']],
  ['commit', ['提交']],
  ['提交', ['commit']],
  ['ledger', ['账本']],
  ['账本', ['ledger']],
  ['prompt', ['提示词']],
  ['提示词', ['prompt']],
  ['memory', ['记忆']],
  ['记忆', ['memory']],
  ['retrieval', ['检索']],
  ['检索', ['retrieval']],
  ['session', ['会话']],
  ['会话', ['session']],
]);

/** Expand grams with their aliases, so a synonym matches without a rewrite. */
export function expandGrams(units) {
  const expanded = new Set(units);
  for (const unit of units) {
    const aliases = ALIASES.get(unit);
    if (aliases === undefined) continue;
    for (const alias of aliases) {
      for (const gram of grams(alias)) expanded.add(gram);
    }
  }
  return expanded;
}

/**
 * Split text into comparable units: latin words plus CJK bigrams. Chinese has
 * no spaces, so bigrams are the smallest unit that still recalls a phrase.
 */
export function grams(text) {
  const value = String(text ?? '').toLowerCase();
  const units = new Set();
  for (const word of value.match(WORD) ?? []) {
    if (word.length > 1) units.add(word);
  }
  const cjk = value.replace(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu, ' ');
  for (const run of cjk.split(' ')) {
    if (run.length === 1) units.add(run);
    for (let index = 0; index + 1 < run.length; index += 1) units.add(run.slice(index, index + 2));
  }
  return units;
}

function lexicalScore(queryGrams, memoryGrams) {
  if (queryGrams.size === 0 || memoryGrams.size === 0) return { score: 0, hits: [] };
  const hits = [];
  for (const unit of queryGrams) {
    if (memoryGrams.has(unit)) hits.push(unit);
  }
  // Recall against the query, so a long memory is not punished for being long.
  return { score: hits.length / queryGrams.size, hits };
}

function recencyScore(updatedAt, now) {
  const then = Date.parse(updatedAt);
  if (Number.isNaN(then)) return 0;
  const days = Math.max(0, (now.getTime() - then) / 86_400_000);
  return 1 / (1 + days / 30); // half-life-ish, 30 days -> 0.5
}

function isExpired(memory, now) {
  if (memory.valid_to === null || memory.valid_to === undefined) return false;
  const end = Date.parse(memory.valid_to);
  return !Number.isNaN(end) && end <= now.getTime();
}

/**
 * Is this content worth remembering at all?
 *
 * A memory reaches every later turn, so a placeholder that slipped in during
 * testing costs more than a missing memory does. Two shapes are refused: a
 * fragment too short to carry a claim, and a repetition whose distinct
 * characters are too few to mean anything ("哈哈哈哈").
 */
export const MIN_CONTENT_LENGTH = 4;

export function contentQuality(text) {
  const value = String(text ?? '').trim();
  if (value.length < MIN_CONTENT_LENGTH) return 'too-short';
  const compact = value.replace(/\s+/gu, '');
  const distinct = new Set(Array.from(compact)).size;
  if (compact.length > 0 && distinct / compact.length < 0.4 && compact.length < 12) return 'repetitive';
  return null;
}

/** Which memories may even be considered. Everything excluded has a reason. */
export function eligibility(memory, { now = new Date(), scope = 'global', includePrivate = false } = {}) {
  if (memory.status !== 'active') return 'not-active';
  if (isExpired(memory, now)) return 'expired';
  if (memory.sensitivity === 'private' && !includePrivate) return 'private';
  const quality = contentQuality(memory.content);
  if (quality !== null) return quality;
  const memoryScope = memory.scope ?? 'global';
  if (memoryScope !== 'global' && memoryScope !== scope) return 'other-scope';
  return null;
}

/**
 * Score one memory. The returned `parts` are what the UI shows as the reason,
 * so the number is never a black box.
 */
export function scoreMemory(memory, query, options = {}) {
  const now = options.now ?? new Date();
  const queryGrams = expandGrams(grams(query));
  const memoryGrams = expandGrams(grams(`${memory.content} ${(memory.tags ?? []).join(' ')} ${(memory.entities ?? []).join(' ')}`));
  const lexical = lexicalScore(queryGrams, memoryGrams);
  const recency = recencyScore(memory.accepted_at ?? memory.updated_at, now);
  const importance = Math.min(5, Math.max(1, Number(memory.importance) || 3)) / 5;
  const confidence = Math.min(1, Math.max(0, Number(memory.confidence) || 0.6));
  const pinned = memory.pinned === true;
  const total = pinned ? 1 : lexical.score * 0.6 + recency * 0.15 + importance * 0.15 + confidence * 0.1;
  return {
    total,
    parts: {
      lexical: lexical.score,
      hits: lexical.hits.slice(0, 8),
      recency,
      importance,
      confidence,
      pinned,
    },
  };
}

/**
 * Choose what enters the conversation.
 *
 * Rules: pinned memories are always in; everything else must be eligible,
 * non-zero-lexical when a query exists, and within the character budget.
 */
export function selectMemories(memories, query, options = {}) {
  const { now = new Date(), scope = 'global', limit = 8, budget = 1200, includePrivate = false } = options;
  const hasQuery = typeof query === 'string' && query.trim() !== '';
  const scored = [];
  const excluded = [];
  for (const memory of memories) {
    const reason = eligibility(memory, { now, scope, includePrivate });
    if (reason !== null) {
      excluded.push({ id: memory.id, reason });
      continue;
    }
    const score = scoreMemory(memory, query, { now });
    if (!score.parts.pinned) {
      if (hasQuery && score.parts.lexical === 0) {
        excluded.push({ id: memory.id, reason: 'no-lexical-match' });
        continue;
      }
      if (!hasQuery && score.total <= 0) {
        excluded.push({ id: memory.id, reason: 'no-signal' });
        continue;
      }
    }
    scored.push({ memory, score });
  }

  scored.sort((left, right) => {
    if (left.score.parts.pinned !== right.score.parts.pinned) return left.score.parts.pinned ? -1 : 1;
    if (right.score.total !== left.score.total) return right.score.total - left.score.total;
    return String(left.memory.id).localeCompare(String(right.memory.id));
  });

  const chosen = [];
  let used = 0;
  for (const entry of scored) {
    if (chosen.length >= limit) {
      excluded.push({ id: entry.memory.id, reason: 'over-limit' });
      continue;
    }
    const length = String(entry.memory.content ?? '').length;
    const isPinned = entry.score.parts.pinned;
    if (!isPinned && used + length > budget) {
      excluded.push({ id: entry.memory.id, reason: 'over-budget' });
      continue;
    }
    used += length;
    chosen.push({ ...entry, reason: explain(entry, hasQuery) });
  }
  return { chosen, excluded, used, budget };
}

/** One short, human-readable reason. Never empty, never a bare number. */
export function explain(entry, hasQuery) {
  const { parts } = entry.score;
  const reasons = [];
  if (parts.pinned) reasons.push('置顶');
  if (hasQuery && parts.hits.length > 0) reasons.push(`命中 ${parts.hits.length} 个词（${parts.hits.slice(0, 3).join('、')}）`);
  reasons.push(`置信度 ${parts.confidence.toFixed(2)}`);
  reasons.push(`重要度 ${Math.round(parts.importance * 5)}`);
  if (parts.recency >= 0.5) reasons.push('近期更新');
  return reasons.join('，');
}

/**
 * Render the injected block. Numbered so a reply can cite "记忆 #2", and
 * explicitly labelled as user-confirmed so the model does not treat it as
 * instructions.
 */
export function formatInjection(chosen, { header = '以下是用户已确认的长期记忆，仅作背景参考：' } = {}) {
  if (!Array.isArray(chosen) || chosen.length === 0) return '';
  const lines = [header];
  chosen.forEach((entry, index) => {
    const scope = entry.memory.scope && entry.memory.scope !== 'global' ? `（范围：${entry.memory.scope}）` : '';
    lines.push(`${index + 1}. ${String(entry.memory.content).replace(/\s+/g, ' ').trim()}${scope}`);
  });
  return lines.join('\n');
}
