// Natural-language correction (§6.1–6.4), without guessing.
//
// The user may call a memory wrong in words instead of clicking a button. The
// job of this module is narrow: decide whether the words are a correction at
// all, then find the one memory they can only mean. Two rules keep it safe:
//
// 1. A correction cue must be aimed at a memory ("那条记忆错了", "delete that
//    memory", "this is outdated"), not just any complaint about the code.
// 2. The target must be the single clear lexical match. Two plausible targets,
//    or a weak score, means no action — the roadmap says "不得猜测并修改其他条目",
//    and an objection is enough to block a memory from retrieval, so a guess
//    is not harmless.
//
// Recording an objection is all this does: it suppresses the memory at once
// (D7) and is not a ledger write. Editing or retracting stays a user decision.

import { normalizeCorrectionKind } from './corrections.js';
import { scoreMemory } from './retrieval.js';
import { narrowingRequest } from './narrowing.js';

/** The cues, strongest first. `kind` is a documented correction kind. */
export const CORRECTION_CUES = Object.freeze([
  { kind: 'delete_request', pattern: /(删掉|删除|清掉)\s*(这|那)?\s*(条|个)?\s*(记忆|记录|条目)|delete (that|this) (memory|entry)|forget (that|this) memory/iu },
  { kind: 'should_not_save', pattern: /(不该|不应该|不要)\s*(保存|存|记下来|记住)|should not (be )?(saved|stored?)/iu },
  { kind: 'outdated', pattern: /(已经?过时|过时了|不再适用|已经不是|变了)|(outdated|no longer (true|applies)|already changed)/iu },
  { kind: 'too_broad', pattern: /(太宽泛|太笼统|范围太广)|(too broad|too vague)/iu },
  { kind: 'wrong_scope', pattern: /(范围错|作用域错|用错地方|scope is wrong|wrong scope)/iu },
  { kind: 'missing_context', pattern: /(缺少上下文|缺少适用条件|没有写条件|missing context)/iu },
  { kind: 'duplicate', pattern: /(重复了|重复的记忆|和.*重复)|(duplicate(d)? memory)/iu },
  { kind: 'incorrect', pattern: /((这条|那条|这个)?记忆(写|记)?(错|不对|有误))|(记错|说错)|(that (memory )?is (wrong|incorrect)|remembered (that )?wrongly)/iu },
]);

/** The memory nouns a correction sentence must contain to be aimed at memory. */
const MEMORY_NOUN = /(记忆|记录|条目|memory|memories)/iu;

/** Every cue that the text matches, strongest first. */
export function correctionKinds(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.trim() === '') return [];
  return CORRECTION_CUES.filter((cue) => cue.pattern.test(value)).map((cue) => cue.kind);
}

/**
 * A cheap check the caller can run before touching any storage: most messages
 * are not corrections, and opening the ledger to discover that would slow down
 * every turn for nothing.
 */
export function isCorrectionCandidate(text) {
  const value = typeof text === 'string' ? text : '';
  return value.trim() !== '' && MEMORY_NOUN.test(value) && correctionKinds(value).length > 0;
}

/** The quote is only used for the objection reason; it is never stored as a memory. */
function quoteOf(text) {
  return String(text ?? '').trim().replace(/\s+/gu, ' ').slice(0, 240);
}

/**
 * Decide whether this message corrects one memory.
 *
 * @param {object} input
 * @param {string} input.text the user's message
 * @param {object[]} input.memories the ledger rows the conversation may use
 * @param {string[]} [input.suppressedIds] memories already objected to
 * @returns {{ act: boolean, kind: string|null, memoryId: string|null, reason: string, candidates: string[] }}
 */
export function evaluateCorrection({ text, memories, suppressedIds = [] } = {}) {
  const value = typeof text === 'string' ? text : '';
  const kinds = correctionKinds(value);
  const none = { act: false, kind: null, memoryId: null, reason: 'no-cue', candidates: [] };
  if (kinds.length === 0) return none;
  if (!MEMORY_NOUN.test(value)) return { ...none, reason: 'not-about-memory' };

  const suppressed = new Set(Array.isArray(suppressedIds) ? suppressedIds : []);
  const scored = [];
  for (const memory of Array.isArray(memories) ? memories : []) {
    if (memory === null || typeof memory !== 'object') continue;
    if (memory.status !== 'active') continue;
    if (typeof memory.id === 'string' && suppressed.has(memory.id)) continue;
    const score = scoreMemory(memory, value);
    if (score.parts.lexical <= 0) continue;
    scored.push({ id: memory.id, lexical: score.parts.lexical, total: score.total });
  }
  scored.sort((left, right) => right.lexical - left.lexical);

  if (scored.length === 0) return { ...none, reason: 'no-target' };
  if (scored.length > 1 && scored[0].lexical - scored[1].lexical < 0.05) {
    // Two memories are equally plausible. Ask, do not guess: the user can pick
    // in the panel, and nothing is suppressed on a coin flip.
    return { act: false, kind: kinds[0], memoryId: null, reason: 'ambiguous-target', candidates: scored.slice(0, 3).map((row) => row.id) };
  }
  // A correction sentence is mostly cue words, so the overlap is small by
  // nature; what matters is that some distinctive token matched at all.
  if (scored[0].lexical < 0.05) return { act: false, kind: kinds[0], memoryId: null, reason: 'weak-target', candidates: [scored[0].id] };

  return {
    act: true,
    kind: kinds[0],
    memoryId: scored[0].id,
    reason: quoteOf(value),
    candidates: scored.slice(0, 3).map((row) => row.id),
  };
}

/**
 * Record the objection when the words clearly name one memory.
 *
 * A storage failure is reported, never hidden: the roadmap says a failed
 * persistence must be told to the user rather than claimed as done.
 */
export async function applyCorrection({ text, memories, suppressedIds, runtime }) {
  const decision = evaluateCorrection({ text, memories, suppressedIds });
  if (!decision.act) return { recorded: false, ...decision };
  // Cue patterns may speak in synonyms; the runtime vocabulary does not.
  const kind = normalizeCorrectionKind(decision.kind);
  const normalized = { ...decision, kind };
  if (runtime === null || runtime === undefined || typeof runtime.addObjection !== 'function') {
    return { recorded: false, ...normalized, reason: 'runtime-unavailable' };
  }
  try {
    const objection = await runtime.addObjection({ memoryId: normalized.memoryId, kind, reason: normalized.reason });
    // Both correction entries must say the same thing about a review objection:
    // it is recorded, and no replacement wording exists yet (§6.6).
    const memory = (Array.isArray(memories) ? memories : [])
      .find((row) => row !== null && typeof row === 'object' && row.id === normalized.memoryId) ?? null;
    return { recorded: true, ...normalized, objection, narrowing: narrowingRequest({ objection, memory }) };
  } catch (error) {
    const code = String((error && error.code) || 'failed');
    // An existing objection is the same outcome: the memory is already hidden.
    return { recorded: false, ...normalized, reason: code === 'duplicate' ? 'already-objected' : `failed:${code}` };
  }
}
