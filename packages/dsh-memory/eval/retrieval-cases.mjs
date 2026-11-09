// The retrieval evaluation set (roadmap §13.2: 20–50 real questions).
//
// Each case is a phrasing a user might actually type, paired with the one
// memory that should answer it. `expect: null` means the store holds nothing
// relevant and the block should stay empty — that is the false-injection side of
// the measurement, not a missing case.
//
// The corpus deliberately contains the traps that make lexical retrieval fail:
// two memories sharing a word, a memory that is retracted or private or an
// inference, and topics that are near each other but distinct.

export const RETRIEVAL_CORPUS = Object.freeze([
  // --- the everyday set ---
  { id: 'M-deps', type: 'fact', content: '项目用 pnpm 而不是 npm 安装依赖' },
  { id: 'M-commit', type: 'constraint', content: '提交信息使用中文，不要用 emoji' },
  { id: 'M-style', type: 'preference', content: '用户偏好简洁回答，避免冗长铺垫' },
  { id: 'M-path', type: 'fact', content: 'dsh-memory 的账本位于 ~/.dsh/dsh-memory/ledger' },
  { id: 'M-inject', type: 'fact', content: '记忆注入通过 systemPrompt.context 注册' },
  { id: 'M-log', type: 'fact', content: '会话日志是 zstd 压缩的 jsonl，不要直接解析' },
  { id: 'M-test', type: 'constraint', content: '测试用 node --test 单独文件运行' },
  { id: 'M-shell', type: 'preference', content: 'Windows 下用 pwsh 而不是 bash' },
  { id: 'M-lang', type: 'constraint', content: '所有回答都用中文' },
  { id: 'M-weight', type: 'fact', content: '检索权重：lexical 0.6，recency 0.15，importance 0.15，confidence 0.1' },
  { id: 'M-evidence', type: 'constraint', content: '写入正式记忆必须带 session_id 和 event_seq 证据' },
  { id: 'M-branch', type: 'constraint', content: '提交前先跑完整测试套件' },
  { id: 'M-json', type: 'fact', content: '运行时状态存在 runtime.json，不是账本的一部分' },
  { id: 'M-scope', type: 'fact', content: '正式记忆目前都是 global scope，没有 workspace 隔离' },
  { id: 'M-obj', type: 'fact', content: '用户标记有误的记忆会立即退出检索和注入' },
  { id: 'M-err', type: 'constraint', content: '错误提示要说明原因，不要只说失败' },
  { id: 'M-doc', type: 'preference', content: '文档用中文写，代码注释用英文' },
  { id: 'M-perf', type: 'fact', content: 'state() 每次刷新只应派发一次 git 进程' },

  // --- traps: material the injector must never surface ---
  { id: 'M-retracted', type: 'fact', status: 'retracted', content: '这条已撤回的依赖约定不应再被检索到' },
  { id: 'M-private', type: 'fact', sensitivity: 'private', content: '私密记忆：某个内部地址，不应进入普通注入' },
  { id: 'M-hypo', type: 'hypothesis', content: '用户可能偏好用 yarn 管理依赖（推断，未确认）' },

  // --- a near-neighbour pair, so a single shared word is not enough ---
  { id: 'M-form', type: 'fact', content: '填写表单后点击提交按钮' },
  { id: 'M-cache', type: 'fact', content: '构建产物放在 dist 目录，不要提交到仓库' },
]);

const BASE = {
  status: 'active',
  scope: 'global',
  importance: 3,
  confidence: 0.9,
  accepted_at: '2026-10-20T00:00:00.000Z',
};

/** The corpus with the fields retrieval reads filled in. */
export function retrievalCorpus() {
  return RETRIEVAL_CORPUS.map((memory) => ({ ...BASE, ...memory }));
}

/**
 * Query -> the memory that should answer it.
 *
 * `expect: null` cases are ones where the right behaviour is an empty (or
 * at least tiny) block: nothing in the store covers them.
 */
export const RETRIEVAL_CASES = Object.freeze([
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
  { query: '写记忆需要什么证据', expect: 'M-evidence' },
  { query: '提交之前要做什么', expect: 'M-branch' },
  { query: '运行时状态存在哪', expect: 'M-json' },
  { query: '记忆有 workspace 隔离吗', expect: 'M-scope' },
  { query: '标记有误之后会怎样', expect: 'M-obj' },
  { query: '报错信息应该怎么写', expect: 'M-err' },
  { query: '文档用什么语言', expect: 'M-doc' },
  { query: 'state 刷新的性能要求', expect: 'M-perf' },
  { query: 'dist 目录要提交吗', expect: 'M-cache' },

  // Nothing in the store covers these, so the honest answer is a small block.
  { query: '周杰伦的演唱会门票怎么买', expect: null },
  { query: '今天上海的天气怎么样', expect: null },
]);

/**
 * Queries used to check that `memory_search` hides what injection hides.
 *
 * Each one is chosen to match a memory that must stay hidden.
 */
export const SEARCH_PARITY_QUERIES = Object.freeze([
  '已撤回的依赖约定',
  '内部地址 私密记忆',
  'yarn 管理依赖',
]);
