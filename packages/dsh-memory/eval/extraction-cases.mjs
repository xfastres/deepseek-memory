// Initial extraction evaluation set (5.1).
//
// These are hand-written phrasings a user might actually type, not results.
// `expect` is the behaviour we want; the extractor is measured against it, so
// a mismatch is information about the rules, never a case to weaken.
//
// Cases with `note: 'english'` are expected to miss today: the rules only know
// Chinese markers. They stay in the set so the gap stays visible.
//
// `count` is used when a message should produce a specific number of
// candidates; without it, `expect: 'candidate'` means at least one.

export const EXTRACTION_CASES = Object.freeze([
  { id: 'instr-zh', text: '记住，以后回答用中文。', expect: 'candidate', types: ['constraint'] },
  { id: 'instr-zh-2', text: '请记住：提交前先跑完整测试。', expect: 'candidate', types: ['constraint'] },
  { id: 'pref-zh', text: '我更喜欢简洁的回答，不要大段解释。', expect: 'candidate', types: ['preference'] },
  { id: 'pref-zh-2', text: '以后都用简体中文写文档。', expect: 'candidate', types: ['preference'] },
  { id: 'decision-zh', text: '决定使用 pnpm 管理依赖。', expect: 'candidate', types: ['decision'] },
  { id: 'decision-zh-2', text: '这次采用按周迭代的节奏。', expect: 'candidate', types: ['decision'] },
  { id: 'question-zh', text: '今天天气怎么样？', expect: 'none' },
  { id: 'question-zh-2', text: '这个接口是不是应该加缓存？', expect: 'none' },
  { id: 'hypothetical-zh', text: '如果以后想换语言，也可以考虑。', expect: 'none' },
  { id: 'hypothetical-zh-2', text: '假设我们要支持多用户，那要先改权限。', expect: 'none' },
  { id: 'chat-zh', text: '好的，谢谢！', expect: 'none' },
  { id: 'chat-zh-2', text: '嗯，我看看。', expect: 'none' },
  { id: 'uncertain-zh', text: '我可能更喜欢中文回答。', expect: 'candidate', types: ['preference'] },
  { id: 'multi-sentence', text: '项目用 pnpm。记住，测试必须先跑完整套件。', expect: 'candidate', count: 1, types: ['constraint'] },
  { id: 'cap-per-turn', text: '记住第一条。记住第二条。记住第三条。记住第四条。', expect: 'candidate', count: 3, maxPerTurn: 3, types: ['constraint'] },
  { id: 'long-sentence', text: `记住${'很长的说明'.repeat(50)}。`, expect: 'none' },
  { id: 'english-instr', text: 'Please remember that the project uses pnpm.', expect: 'candidate', types: ['constraint'], note: 'english' },
  { id: 'english-pref', text: 'I prefer short answers over long explanations.', expect: 'candidate', types: ['preference'], note: 'english' },
  { id: 'english-question', text: 'Which package manager should we use?', expect: 'none', note: 'english' },
  { id: 'mixed-cn-en', text: '记住：commit message 用中文写。', expect: 'candidate', types: ['constraint'] },
  { id: 'code-question', text: '这个函数能改成箭头函数吗？', expect: 'none' },
  { id: 'negative-pref', text: '不要用红色主题，太刺眼。', expect: 'candidate', types: ['preference'] },
  { id: 'task-description', text: '帮我看看这个报错。', expect: 'none' },
  { id: 'goal-zh', text: '目标是这周把 L2 接线完成。', expect: 'none' },
]);
