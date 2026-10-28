// Candidate extraction: find sentences the user actually said that look like
// durable memory.
//
// Three rules shape this module.
//
// 1. Only the user's own words are evidence. The caller passes user text; this
//    module never sees or trusts an assistant reply.
// 2. Precision beats recall. A wrong memory is worse than a missing one, so a
//    question or a hypothetical never becomes a candidate.
// 3. Every candidate carries what matched, so review can say why it appeared.

/** Sentences that are not statements of intent, whatever they contain. */
const QUESTION = /[？?]\s*$|(吗|呢|是不是|好不好|行不行|对不对)\s*$/u;
const HYPOTHETICAL = /(如果|假如|假设|万一|要是|倘若|若是)/u;
const UNCERTAIN = /(也许|可能|大概|或许|不一定|不确定)/u;

/** Delay markers: the claim is being deferred, not asserted. */
const RULES = [
  {
    name: 'instruction',
    type: 'instruction',
    confidence: 0.85,
    pattern: /(记住|记一下|记下|别忘了|下次记得|下次要|以后记住)/u,
  },
  {
    name: 'decision',
    type: 'decision',
    confidence: 0.75,
    pattern: /(决定|就按这个|就按|采纳|采用|定为|敲定)/u,
  },
  {
    name: 'preference',
    type: 'preference',
    confidence: 0.7,
    pattern: /(我更喜欢|我比较喜欢|我偏好|我倾向于|我习惯|我更愿意|更喜欢|一律|以后都|以后请|每次都要|不要再|别用|不用再|请用|请保持|尽量)/u,
  },
];

const MAX_TEXT = 200;
const MAX_PER_TURN = 3;

/** Split one message into sentences without changing a single character. */
export function sentences(text) {
  if (typeof text !== 'string') return [];
  return text
    .split(/[。！？!?；;\n]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Why a sentence is refused, or undefined when it may become a candidate. */
export function refusal(sentence) {
  if (typeof sentence !== 'string' || sentence.trim() === '') return 'empty';
  if (QUESTION.test(sentence)) return 'question';
  if (HYPOTHETICAL.test(sentence)) return 'hypothetical';
  return undefined;
}

function normalise(text) {
  return text.replace(/\s+/gu, '').toLowerCase();
}

/**
 * Extract candidate memories from one turn of user text.
 *
 * @param {string} text the user's own words for the turn
 * @param {{maxPerTurn?: number}} [options]
 * @returns {Array<{text: string, type: string, confidence: number, rule: string, matched: string[]}>}
 */
export function extractCandidates(text, options = {}) {
  const maxPerTurn = Number.isInteger(options.maxPerTurn) && options.maxPerTurn > 0
    ? options.maxPerTurn
    : MAX_PER_TURN;
  const found = [];
  const seen = new Set();

  for (const sentence of sentences(text)) {
    if (refusal(sentence) !== undefined) continue;
    if (sentence.length > MAX_TEXT) continue;

    let best;
    for (const rule of RULES) {
      const matches = sentence.match(new RegExp(rule.pattern.source, 'gu'));
      if (matches === null) continue;
      if (best === undefined || rule.confidence > best.rule.confidence) {
        best = { rule, matched: [...new Set(matches)] };
      }
    }
    if (best === undefined) continue;

    const key = normalise(sentence);
    if (seen.has(key)) continue;
    seen.add(key);

    let confidence = best.rule.confidence;
    if (/(一定|永远|始终|务必|必须)/u.test(sentence)) confidence += 0.05;
    if (UNCERTAIN.test(sentence)) confidence -= 0.15;
    confidence = Math.max(0.3, Math.min(0.95, Number(confidence.toFixed(2))));

    found.push({
      text: sentence,
      type: best.rule.type,
      confidence,
      rule: best.rule.name,
      matched: best.matched,
    });
    if (found.length >= maxPerTurn) break;
  }

  return found;
}
