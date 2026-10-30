#!/usr/bin/env node
/**
 * dsh-memory 实时对照 —— 跟随 append-only 事件流，按一轮收成三块
 *
 *   进去      原文 / 会话 / 轮次
 *   做了什么  观察提取、快照、约束、候选与策略（藏起面板轮询）
 *   出来      注入了什么、候选几条、写不写账本
 *
 * 默认不打印本脚本自己的 GET /trace，也不打印面板只读刷新
 * （/state、/candidates 等）。Host 对每个路由都记一条 http
 * （packages/dsh-memory/index.js 的路由包装），所以这些轮询
 * 原先会把真正的记忆路径埋住。
 *
 * 前提：插件侧埋点开着（标记文件或 DSH_MEMORY_TRACE=1）。
 *
 * 用法：
 *   node scripts/memory-flow-live.mjs                 # 对照视图，跟随最新
 *   node scripts/memory-flow-live.mjs --from-start    # 从头回放
 *   node scripts/memory-flow-live.mjs --port 52995
 *   node scripts/memory-flow-live.mjs --raw-http      # 连轮询的原始 HTTP 也打
 *   node scripts/memory-flow-live.mjs --compact       # 一行一条（仍藏起轮询）
 *
 * 只读：只 GET /trace，不写账本、不改状态。
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_PREFIX = '/api/dsh-memory';

/**
 * 面板用来刷新自己的只读 GET，加上本脚本每秒拉取的 /trace。
 * 名单来自 client.js 的 probeHost（/state /candidates /changes
 * /objections /settings /proposals）以及 http-app.js 里其余只读路由。
 * 非 GET（面板的写入、埋点开关）不在此列。
 */
const HEARTBEAT_GET = new Set([
  '/trace',
  '/ping',
  '/state',
  '/history',
  '/changes',
  '/export',
  '/candidates',
  '/objections',
  '/settings',
  '/proposals',
  '/injections',
]);

export function parseArgs(argv) {
  const opt = { fromStart: false, compact: false, rawHttp: false, port: null, interval: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from-start') opt.fromStart = true;
    else if (a === '--compact') opt.compact = true;
    else if (a === '--raw-http') opt.rawHttp = true;
    else if (a.startsWith('--port=')) opt.port = Number(a.slice(7));
    else if (a === '--port') opt.port = Number(argv[++i]);
    else if (a.startsWith('--interval=')) opt.interval = Math.max(0.2, Number(a.slice(11)));
  }
  return opt;
}

export function httpPath(rec) {
  let route = String(rec?.route ?? '');
  const q = route.indexOf('?');
  if (q !== -1) route = route.slice(0, q);
  if (route.startsWith(API_PREFIX)) route = route.slice(API_PREFIX.length) || '/';
  return route || '/';
}

/** 本脚本的自轮询，或面板只读刷新。写请求不是心跳。 */
export function isHeartbeatHttp(rec) {
  if (!rec || rec.kind !== 'http') return false;
  const method = String(rec.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return false;
  return HEARTBEAT_GET.has(httpPath(rec));
}

function dw(text) {
  let w = 0;
  for (const ch of String(text)) {
    w += /[\u1100-\u1155\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6b\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1;
  }
  return w;
}

function timeOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '??:??:??' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

function paint(text, color, enabled) {
  return enabled ? `\x1b[${color}m${text}\x1b[0m` : text;
}

const TYPE_ZH = {
  fact: '事实',
  preference: '偏好',
  constraint: '约束',
  decision: '决定',
  goal: '目标',
  event: '事件',
  open_loop: '未完成',
  hypothesis: '假设',
  instruction: '记住类，写入账本时映射成约束',
};

const REASON_ZH = {
  eligible: '类型、置信和证据都过了，而且自动接受开着',
  duplicate: '账本里已经有同样的内容',
  conflict: '和已有记忆冲突',
  'no-evidence': '没有对上用户原话的证据',
  'type-not-allowed': '类型不在账本允许的范围内',
  sensitive: '被标成敏感，要人来决定',
  'low-confidence': '置信度低于门槛',
  'type-needs-user': '这种类型必须人来决定',
  'type-unknown': '类型不明',
  'type-not-auto': '这种类型不在自动接受范围内',
  'auto-accept-disabled': '自动接受没开',
  'objected-memory': '同一句还在异议里，不能自动写回去',
};

const EXCLUDE_ZH = {
  'missing-memory': '约束指向的记忆不在',
  'digest-empty': '没有可用摘要',
  'digest-too-long': '摘要超过单条上限，拒绝而不是截断',
  'over-constraint-limit': '超过约束条数上限',
  'over-constraint-budget': '超过约束池预算',
  'over-budget': '超过预算',
  'over-budget-after-format': '加上标题和序号后超过预算，被拿掉',
  'no-lexical-match': '和这句原话对不上词',
  'no-signal': '没有可匹配的信号',
  'over-limit': '超过条数上限',
};

const PATH_ZH = {
  scope: '按本步同一个 scope 对上了原话',
  agent: '按会话 id 对上了原话',
  latest: '目前只见过一个会话，用的是最近一次原话',
  ambiguous: '多个会话对不上，这次不用原话去打分（用错会话比不注入更糟）',
  none: '没有观察记录',
};

const OBSERVE_ZH = {
  scope: '原话绑在本步的 scope 上',
  unscoped: '这一步没有 scope 对象',
};

const SKIP_ZH = {
  'no-active-memory': '账本里还没有 active 记忆，所以故意不注册提示词接口。空库不进每一步的组装，因此不会有注入。',
  'missing-context-api': '宿主没有 systemPrompt.context，挂不上注入。',
  'no-system-prompt-service': '没有 systemPrompt 服务，挂不上注入。',
};

/**
 * 非 GET 路由在做什么。事件里没有请求正文，所以只说明这个接口的职责，
 * 不猜测这次是接受还是拒绝。依据 host/http-app.js。
 */
const WRITE_ZH = {
  '/add': '写入账本的接口。',
  '/update': '更新账本的接口（要带基线版本）。',
  '/retract': '撤回账本的接口。',
  '/review': '接受、拒绝或合并候选。只有接受或合并才经 Writer 进账本；拒绝只改候选状态。',
  '/proposals': '处理 AI 提案。只有接受才写账本。',
  '/candidate': '往运行时候选队列加一条，本身不是账本写入。',
  '/objections': '记一条异议：相关记忆退出检索和注入，账本正文不改。',
  '/objections/clear': '清除异议。',
  '/settings': '保存总开关或自动接受，不写记忆正文。',
  '/migrate': '把浏览器本地副本导入账本。',
  '/trace/switch': '切换埋点开关，不写账本。',
};

function typeLabel(type) {
  if (type === undefined || type === null || type === '') return '（无类型）';
  const zh = TYPE_ZH[type];
  return zh ? `${type}（${zh}）` : String(type);
}

function reasonLabel(code) {
  const zh = REASON_ZH[code];
  return zh ? `${code}（${zh}）` : String(code);
}

function excludeLabel(code) {
  const zh = EXCLUDE_ZH[code];
  return zh ? `${code}（${zh}）` : String(code ?? '');
}

const STATUS_ZH = {
  review_pending: '待审',
  auto_accepted: '标记为自动接受',
  conflict: '冲突',
  no_change: '无需变化',
  rejected: '已拒绝',
  proposed: '刚入队',
  open: '还开着',
};

function statusLabel(status) {
  if (status === undefined || status === null || status === '') return '（无）';
  const zh = STATUS_ZH[status];
  return zh ? `${zh}（${status}）` : String(status);
}

function memoryKindLabel(kind) {
  if (kind === 'constraint') return 'constraint（常驻约束）';
  if (kind === 'memory' || kind === undefined || kind === null || kind === '') return 'memory（普通记忆）';
  return String(kind);
}

/** 策略事件发在写入之前。AUTO_ACCEPT 只表示会尝试写，不表示已经进账本。 */
function policyOutcome(decision, reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  if (decision === 'AUTO_ACCEPT') {
    return '可自动接受。接着会尝试写入账本。这条事件发在写入之前，写没写成这里看不出来。';
  }
  if (decision === 'REVIEW_REQUIRED') {
    const label = list.includes('auto-accept-disabled') ? '可自动接受（自动接受已关闭）' : '待复核';
    return `${label}。不写账本，留在待审队列。`;
  }
  if (decision === 'CONFLICT') return '冲突待处理。不写账本。';
  if (decision === 'NO_CHANGE') return '无需变化。不写账本。';
  if (decision === 'REJECT') return '拒绝写入。不写账本。';
  if (decision === undefined || decision === null || decision === '') return '没有决策字段。';
  return `${decision}。`;
}

function blankStep(enter) {
  return {
    enter: enter ?? null,
    observe: null,
    snapshot: null,
    constraints: null,
    refreshFailed: null,
    exit: null,
    injects: [],
    injectFailed: null,
    candidateEvents: [],
    policies: [],
    hidden: 0,
    flushed: false,
    waitedInject: false,
    waitedQuiet: false,
  };
}

function stepTitle(step) {
  const enter = step?.enter;
  const turn = enter && Number.isInteger(enter.turn) ? enter.turn : null;
  const n = enter && Number.isInteger(enter.step) ? enter.step : null;
  const when = timeOf(enter?.at ?? step?.observe?.at ?? step?.exit?.at);
  const where = turn === null && n === null
    ? '轮次未标明'
    : `第 ${turn === null ? '?' : turn} 轮 · 第 ${n === null ? '?' : n} 步`;
  return `${where}    ${when}`;
}

function expectsInject(step) {
  const exit = step?.exit;
  if (!exit) return false;
  if (exit.providerRegistered !== true) return false;
  if (exit.skipped) return false;
  return true;
}

function expectsMoreCandidates(step) {
  const extracted = Number(step?.observe?.candidates ?? 0);
  return extracted > (step?.candidateEvents?.length ?? 0);
}

function bar() {
  return '─'.repeat(64);
}

function heading(text, color, enabled) {
  return paint(text, color, enabled);
}

/**
 * 启动说明。三块标题和每一轮卡片上的副标题是同一句话，
 * 方便对着屏幕还原 index.js / injection.js 里的顺序。
 */
export function bannerText(info = {}) {
  const lines = [];
  lines.push('');
  lines.push('═'.repeat(64));
  lines.push(' dsh-memory 实时对照');
  lines.push('═'.repeat(64));
  if (info.port) lines.push(` Host        http://127.0.0.1:${info.port}`);
  if (info.traceFile) lines.push(` 事件文件    ${info.traceFile}`);
  if (info.written !== undefined && info.written !== null) {
    const dropped = info.dropped ? `（丢弃 ${info.dropped}）` : '';
    lines.push(` 已写入      ${info.written} 条${dropped}`);
  }
  lines.push('');
  lines.push(' 画面上每一轮分成三块，顺序就是 agent/pre-step 里的真实顺序：');
  lines.push('');
  lines.push('   进去      只抄原话、会话和轮次，不改对话里的消息。');
  lines.push('   做了什么  在步边界准备快照和约束。提示词组装是同步的，');
  lines.push('             不能在那里等 Git，所以读账本放在这一步，不放在注入里。');
  lines.push('   出来      宿主来取提示词时才注入，而且只读刚才的快照，不写账本。');
  lines.push('             从原话抽出的句子默认也不进账本，只进待审队列；');
  lines.push('             自动接受打开且策略通过，才会尝试写。事件发在写入之前。');
  lines.push('');
  lines.push(' 候选入队是丢到后台的，常常比「本步结束」更晚，也不能拖住这一轮。');
  lines.push(' 候选事件不带轮次号，能对上最近一次观察时就归到那一轮。');
  lines.push(' 纠正检查和注入记录落盘没有单独事件，画面上不会多这两行。');
  lines.push('');
  if (info.compact) {
    lines.push(' 当前是紧凑模式：一行一条，仍然藏起只读轮询。');
  } else if (info.rawHttp) {
    lines.push(' 已打开 --raw-http：只读轮询也会按原始 HTTP 打印。');
  } else {
    lines.push(' 默认藏起本脚本每秒的 GET /trace，以及面板刷新用的只读 GET');
    lines.push(' （/ping /state /candidates /changes /objections /settings /proposals 等）。');
    lines.push(' 要看这些原始 HTTP，加 --raw-http。一行一条用 --compact。');
  }
  lines.push('');
  if (info.fromStart) lines.push(' 从第一条开始回放。');
  else if (info.since > 0) lines.push(` 从 #${info.since} 之后开始。要看更早的，加 --from-start。`);
  lines.push(' 跟随中。发一条消息就能看到这三块。Ctrl+C 退出。');
  lines.push('');
  return lines.join('\n');
}

function renderQuery(observe) {
  const lines = [];
  if (!observe) {
    lines.push('  原文      还没有观察事件');
    return lines;
  }
  const chars = Number(observe.queryChars ?? 0);
  const query = observe.query === undefined || observe.query === null ? '' : String(observe.query);
  lines.push(`  原文      ${chars} 字`);
  if (chars === 0 || query === '') {
    lines.push('            这一步没有 role=user 的文字（只拼接用户消息，不含助手回复）。');
  } else {
    if (chars > query.length) lines.push(`            事件里只留了前 ${query.length} 字，后面的没记下来。`);
    for (const line of query.split('\n')) lines.push(`  │ ${line}`);
  }
  return lines;
}

function renderDid(step) {
  const lines = [];
  const observe = step.observe;
  if (observe) {
    const how = OBSERVE_ZH[observe.observePath] ?? (observe.observePath ? String(observe.observePath) : '未标明');
    lines.push(`  1. 记下原话（${how}）。这一步只观察。`);
    const n = Number(observe.candidates ?? 0);
    const rules = Array.isArray(observe.candidateRules) && observe.candidateRules.length
      ? `：${observe.candidateRules.join('、')}`
      : '';
    lines.push(`  2. 用规则抽出 ${n} 条候选${rules}。抽出来还不是账本里的记忆。`);
  } else {
    lines.push('  1. 这一轮没有观察事件。');
  }
  if (step.refreshFailed) {
    lines.push(`  · 快照刷新失败：${step.refreshFailed.error ?? '未知'}。注册仍会继续，用的是上一份快照。`);
  }
  if (step.snapshot) {
    const s = step.snapshot;
    const head = s.head
      ? `，head ${String(s.head).slice(0, 12)}${String(s.head).length > 12 ? '…' : ''}`
      : '';
    lines.push(`  3. 快照：${s.memories ?? 0} 条记忆，屏蔽 ${s.suppressed ?? 0} 条${head}。`);
    lines.push('     注入只读这份内存快照。过期（约 30 秒）或缺失才会重读账本；这条事件看不出这次有没有重读。');
    if (s.degraded) lines.push(`     降级：${s.degraded}（异议名单读失败时不会把记忆放行）。`);
  }
  if (step.constraints) {
    const c = step.constraints;
    const loaded = c.loaded === true ? '配置已加载' : '配置没加载';
    const fb = Array.isArray(c.fallback) && c.fallback.length ? `，回落 ${c.fallback.join('、')}` : '';
    lines.push(`  4. 按这份快照解析常驻约束：${loaded}，可用 ${c.usable ?? 0} 条${fb}。`);
  }
  if (step.exit) {
    const exit = step.exit;
    if (exit.providerRegistered === true && !exit.skipped) {
      const calls = `累计被调用 ${exit.calls ?? 0} 次`;
      lines.push(step.injects.length > 0 || step.injectFailed
        ? `  5. 提示词接口已注册（${calls}）。取到的内容在下面「出来」。`
        : `  5. 提示词接口已注册（${calls}）。宿主来取提示词时才会注入。`);
    } else {
      const why = SKIP_ZH[exit.skipped] ?? (exit.skipped ? String(exit.skipped) : '未注册');
      lines.push(`  5. 提示词接口：${why}`);
    }
  } else {
    lines.push('  · 还没看到「本步结束」。后面的快照或注入可能还在这一轮里。');
  }
  return lines;
}

function renderCandidateBlock(cand, policy) {
  const lines = [];
  const id = cand?.id ?? policy?.id ?? '（无 id）';
  if (cand) {
    lines.push(`  · ${id}  ${typeLabel(cand.type)}  置信 ${cand.confidence ?? '?'}`);
    if (cand.rule) lines.push(`    规则 ${cand.rule}`);
    if (cand.text) lines.push(`    「${String(cand.text).slice(0, 200)}」`);
    if (Number(cand.entities) > 0) lines.push(`    继承已确认实体 ${cand.entities} 个（不会凭空起名）`);
  }
  if (policy) {
    const reasons = Array.isArray(policy.reasons) ? policy.reasons : [];
    lines.push(`    策略：${policyOutcome(policy.decision, reasons)}`);
    if (reasons.length) lines.push(`    理由 ${reasons.map(reasonLabel).join('、')}`);
    if (policy.status) lines.push(`    队列状态 ${statusLabel(policy.status)}。这是策略要留下的状态，不是账本回执`);
  } else if (cand) {
    lines.push('    策略事件还没到。入队本身不写账本。');
  }
  return lines;
}

function renderInjectBody(inject) {
  const lines = [];
  const chars = Number(inject.chars ?? 0);
  const path = inject.path
    ? `路径 ${inject.path}${PATH_ZH[inject.path] ? `：${PATH_ZH[inject.path]}` : ''}`
    : '路径未标明';
  lines.push(`  注入      ${chars} 字（${path}）`);
  if (inject.pools) {
    const c = inject.pools.constraint;
    const d = inject.pools.dynamic;
    if (c) lines.push(`  约束池    ${c.used ?? '?'}/${c.budget ?? '?'}`);
    if (d) lines.push(`  动态池    ${d.used ?? '?'}/${d.budget ?? '?'}`);
  }
  const chosen = Array.isArray(inject.chosen) ? inject.chosen : [];
  const excluded = Array.isArray(inject.excluded) ? inject.excluded : [];
  lines.push(`  选中      ${chosen.length} 条，没选 ${excluded.length} 条`);
  for (const e of chosen) {
    lines.push(`    ✓ ${e.id ?? '（无 id）'}  ${e.chars ?? 0} 字  [${memoryKindLabel(e.kind)}]`);
    if (e.reason) lines.push(`      ${e.reason}`);
  }
  for (const e of excluded) {
    lines.push(`    ✗ ${e.id ?? '（无 id）'}  ${excludeLabel(e.reason)}${e.pool ? `  池=${e.pool}` : ''}`);
  }
  if (inject.text) {
    lines.push('  ┌ 实际放进提示词的原文');
    for (const line of String(inject.text).split('\n')) lines.push(`  │ ${line}`);
    lines.push('  └');
  } else if (chars === 0) {
    lines.push('  （0 字：接口被调用了，但没有往提示词里放内容。）');
  }
  return lines;
}

function renderOut(step) {
  const lines = [];
  const extracted = Number(step.observe?.candidates ?? 0);
  const queued = step.candidateEvents.length;
  lines.push(`  抽出      ${extracted} 条`);
  lines.push(`  入队      ${queued} 条`);
  if (extracted > queued) {
    lines.push('            入队比抽出少，不一定是丢了。已在账本里的句子、对不上这轮证据、');
    lines.push('            或总开关关着，代码会直接返回，不再发候选事件。');
  }
  if (queued === 0 && extracted === 0) {
    lines.push('            没有像「记住…」这样的句子，就不会进队列，更不会写账本。');
  }
  const policies = new Map(step.policies.map((p) => [p.id, p]));
  const seen = new Set();
  for (const cand of step.candidateEvents) {
    seen.add(cand.id);
    lines.push(...renderCandidateBlock(cand, policies.get(cand.id)));
  }
  for (const policy of step.policies) {
    if (seen.has(policy.id)) continue;
    lines.push(...renderCandidateBlock(null, policy));
  }
  if (step.injectFailed) {
    lines.push(`  注入失败  ${step.injectFailed.error ?? '未知'}`);
  }
  if (step.injects.length === 0 && !step.injectFailed) {
    if (!expectsInject(step) && step.exit) {
      lines.push('  注入      没有。上面第 5 点的原因成立时，宿主不会来取这段记忆。');
    } else if (step.exit) {
      lines.push('  注入      到打印这一块为止还没有。接口已注册，要等宿主来取提示词。');
    } else {
      lines.push('  注入      还没到那一步。');
    }
  }
  for (const inject of step.injects) lines.push(...renderInjectBody(inject));
  if (step.hidden > 0) {
    lines.push(`  （这一轮中间藏起 ${step.hidden} 条只读轮询，例如 GET /trace 或面板刷新）`);
  }
  return lines;
}

function renderStep(step, color) {
  const enter = step.enter;
  const session = enter?.sessionId ? String(enter.sessionId) : '（没有会话 id）';
  const turn = enter && Number.isInteger(enter.turn) ? enter.turn : null;
  const n = enter && Number.isInteger(enter.step) ? enter.step : null;
  const messages = enter && Number.isInteger(enter.messages) ? enter.messages : null;
  const lines = [
    bar(),
    heading(stepTitle(step), '36', color),
    bar(),
    heading('进去', '36', color),
    '  只抄原话和轮次，不改对话里的消息。',
    `  会话      ${session}`,
    `  轮次      第 ${turn === null ? '?' : turn} 轮 / 第 ${n === null ? '?' : n} 步`,
    `  消息      ${messages === null ? '?' : messages} 条（含各角色；原文只取其中的用户消息）`,
    ...renderQuery(step.observe),
    '',
    heading('做了什么', '33', color),
    '  在步边界准备快照。提示词组装是同步的，不能在那里等 Git。',
    ...renderDid(step),
    '',
    heading('出来', '32', color),
    '  注入只读这份快照，不写账本。抽出来的句子默认也不进账本。',
    ...renderOut(step),
    bar(),
    '',
  ];
  return lines.join('\n');
}

function renderInjectFollowup(step, inject, color) {
  const lines = [
    bar(),
    heading(`补上注入    ${stepTitle(step)}`, '32', color),
    '出来',
    '  宿主这次来取提示词了。只读快照，不写账本。',
    ...renderInjectBody(inject),
    bar(),
    '',
  ];
  return lines.join('\n');
}

function renderInjectStandalone(inject, color) {
  const lines = [
    bar(),
    heading(`注入    ${timeOf(inject.at)}`, '32', color),
    '进去',
    '  这条事件不带原文和轮次。原文在更早的「观察」里；对不上时多半是上一次组装。',
    '做了什么',
    '  宿主调用了提示词接口，按快照挑选。这一步不写账本。',
    '出来',
    ...renderInjectBody(inject),
    bar(),
    '',
  ];
  return lines.join('\n');
}

function renderCandidateFollowup(cand, policy, color) {
  const lines = [
    bar(),
    heading('补上候选', '33', color),
    '  这条是后台到的，事件本身没有轮次，归在最近一次还缺候选的观察上。',
    '  入队不是写账本。',
    ...renderCandidateBlock(cand, policy),
    bar(),
    '',
  ];
  return lines.join('\n');
}

function renderHttpStory(rec, color) {
  const method = String(rec.method ?? 'GET').toUpperCase();
  const path = httpPath(rec);
  const status = rec.status ?? '?';
  const writing = method !== 'GET';
  const hint = WRITE_ZH[path] ?? (writing
    ? '这条写请求的正文不在事件里，只能看到路由和状态码。'
    : '这是一次只读请求，不会改账本。');
  const lines = [
    bar(),
    heading(`${writing ? '面板写入' : '只读 HTTP'}    ${timeOf(rec.at)}`, '34', color),
    '进去',
    `  ${method} ${path}`,
    '做了什么',
    `  ${hint}`,
    '出来',
    `  Host 返回 ${status}，耗时 ${rec.ms ?? '?'} ms。`,
    '  返回 200 只说明 Host 接受了请求，不是账本回执；非 200 就是这次没按成功做完。',
    bar(),
    '',
  ];
  return lines.join('\n');
}

function renderTool(rec, color) {
  if (rec.kind === 'propose') {
    const lines = [
      bar(),
      heading(`AI 提案    ${timeOf(rec.at)}`, '33', color),
      '进去',
      `  动作 ${rec.action ?? '?'}${rec.target ? ` → ${rec.target}` : ''}  类型 ${typeLabel(rec.type)}`,
      rec.content ? `  │ ${String(rec.content).slice(0, 200)}` : '  （没有正文）',
      '做了什么',
      '  模型调用了 memory_propose。只进运行时提案队列，接受之前不写账本。',
      '出来',
      `  id ${rec.id ?? '?'}  状态 ${rec.status ?? '?'}`,
      rec.status === 'open' ? '  open 表示还在队列里，不是账本记录。' : '  状态原文如上，这条事件不含账本回执。',
      bar(),
      '',
    ];
    return lines.join('\n');
  }
  if (rec.kind === 'search') {
    const lines = [
      bar(),
      heading(`记忆检索    ${timeOf(rec.at)}`, '34', color),
      '进去',
      `  查询 ${rec.query ?? ''}`,
      '做了什么',
      '  模型调用了 memory_search。只查当前允许注入的记忆，被异议藏起的不会返回。不写账本。',
      '出来',
      `  结果 ${rec.results ?? 0} 条，隐藏 ${rec.hidden ?? 0} 条${rec.reason ? `（${rec.reason}）` : ''}`,
      bar(),
      '',
    ];
    return lines.join('\n');
  }
  return '';
}

function kindMeta(kind) {
  const table = {
    'pre-step:enter': { icon: '▶', label: '消息进入', color: '36' },
    observe: { icon: '◉', label: '观察/提取', color: '36' },
    candidate: { icon: '＋', label: '候选入队', color: '33' },
    'candidate:policy': { icon: '◇', label: '候选策略', color: '33' },
    snapshot: { icon: '⟳', label: '快照刷新', color: '35' },
    constraints: { icon: '⚖', label: '约束解析', color: '35' },
    inject: { icon: '★', label: '注入 prompt', color: '32' },
    'inject:failed': { icon: '✗', label: '注入失败', color: '31' },
    'refresh:failed': { icon: '✗', label: '刷新失败', color: '31' },
    'pre-step:exit': { icon: '▶', label: '本步结束', color: '36' },
    http: { icon: '⇄', label: '面板/HTTP', color: '34' },
    propose: { icon: '✎', label: 'AI 提案', color: '33' },
    search: { icon: '⌕', label: '记忆检索', color: '34' },
  };
  return table[kind] ?? { icon: '·', label: kind, color: '0' };
}

function compactLine(rec, color, seqWidth) {
  const meta = kindMeta(rec.kind);
  const seq = String(rec.seq ?? '').padStart(seqWidth, ' ');
  const head = [
    paint(seq, '90', color),
    paint(timeOf(rec.at), '90', color),
    paint(`${meta.icon} ${meta.label}`, meta.color, color),
  ].join('  ');
  const brief = [];
  if (rec.sessionId) brief.push(String(rec.sessionId).slice(0, 20));
  if (rec.turn !== undefined && rec.turn !== null) brief.push(`t${rec.turn}`);
  if (rec.chars !== undefined) brief.push(`${rec.chars}字`);
  if (rec.decision) brief.push(rec.decision);
  if (rec.route) brief.push(`${rec.method} ${httpPath(rec)}`);
  if (rec.query && rec.kind === 'observe') brief.push(`${rec.queryChars ?? 0}字`);
  return `${head}${brief.length ? `  ${brief.join(' ')}` : ''}`;
}

function rawDetail(rec) {
  const lines = [];
  const put = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    lines.push(`      ${k}${' '.repeat(Math.max(2, 14 - dw(k)))} ${v}`);
  };
  if (rec.kind === 'http') {
    put('路由', `${rec.method} ${httpPath(rec)}`);
    put('耗时', `${rec.ms} ms`);
    put('状态', rec.status);
    return lines.join('\n');
  }
  put('数据', JSON.stringify(rec).slice(0, 300));
  return lines.join('\n');
}

function rawBlock(rec, color, seqWidth) {
  const meta = kindMeta(rec.kind);
  const seq = String(rec.seq ?? '').padStart(seqWidth, ' ');
  const head = [
    paint(seq, '90', color),
    paint(timeOf(rec.at), '90', color),
    paint(`${meta.icon} ${meta.label}`, meta.color, color),
  ].join('  ');
  const det = rawDetail(rec);
  return det === '' ? head : `${head}\n${det}`;
}

function stepForCandidate(view) {
  if (view.current && !view.current.flushed && expectsMoreCandidates(view.current)) return view.current;
  if (view.last && expectsMoreCandidates(view.last)) return view.last;
  if (view.current && !view.current.flushed) return view.current;
  return view.last ?? view.current;
}

function stepForPolicy(view, id) {
  const has = (step) => step && step.candidateEvents.some((c) => c.id === id);
  if (has(view.current)) return view.current;
  if (has(view.last)) return view.last;
  return stepForCandidate(view);
}

/**
 * 把事件流收成对照卡片。
 *
 * endBatch 在每次轮询结束时调用。注入和候选常常比「本步结束」晚一个瞬间：
 * 缺注入时多等一批；抽出了但候选还没到时再多等一批，以便合成同一张卡片。
 * 下一步消息进来会立刻结算上一张，不再等。
 */
export function createLiveView(options = {}) {
  const color = options.color !== false;
  const compact = options.compact === true;
  const rawHttp = options.rawHttp === true;
  const view = {
    color,
    compact,
    rawHttp,
    hidden: 0,
    seqWidth: 3,
    current: null,
    last: null,
    /** 本轮还没打印时先到的面板写入 / 工具调用，跟在这一轮卡片后面。 */
    pending: [],
  };

  function hold(text) {
    if (!text) return '';
    if (view.current && !view.current.flushed) {
      view.pending.push(text);
      return '';
    }
    return text;
  }

  function flush() {
    const side = view.pending.join('');
    view.pending = [];
    if (!view.current || view.current.flushed) return side;
    view.current.flushed = true;
    const text = renderStep(view.current, color);
    view.last = view.current;
    view.current = null;
    return text + side;
  }

  function feed(rec) {
    const kind = rec.kind;
    if (kind === 'pre-step:enter') {
      const prev = flush();
      view.current = blankStep(rec);
      return prev;
    }
    if (kind === 'observe' || kind === 'snapshot' || kind === 'constraints' || kind === 'refresh:failed' || kind === 'pre-step:exit') {
      if (!view.current) view.current = blankStep(null);
      if (kind === 'observe') view.current.observe = rec;
      else if (kind === 'snapshot') view.current.snapshot = rec;
      else if (kind === 'constraints') view.current.constraints = rec;
      else if (kind === 'refresh:failed') view.current.refreshFailed = rec;
      else view.current.exit = rec;
      return '';
    }
    if (kind === 'candidate') {
      const target = stepForCandidate(view);
      if (!target) return renderCandidateFollowup(rec, null, color);
      target.candidateEvents.push(rec);
      if (target.flushed) {
        const policy = target.policies.find((p) => p.id === rec.id) ?? null;
        return renderCandidateFollowup(rec, policy, color);
      }
      return '';
    }
    if (kind === 'candidate:policy') {
      const target = stepForPolicy(view, rec.id);
      if (!target) return renderCandidateFollowup(null, rec, color);
      target.policies.push(rec);
      if (target.flushed) {
        const cand = target.candidateEvents.find((c) => c.id === rec.id) ?? null;
        return renderCandidateFollowup(cand, rec, color);
      }
      return '';
    }
    if (kind === 'inject' || kind === 'inject:failed') {
      const open = view.current && !view.current.flushed && view.current.exit ? view.current : null;
      if (open) {
        if (kind === 'inject') open.injects.push(rec);
        else open.injectFailed = rec;
        return '';
      }
      if (view.last && kind === 'inject' && view.last.injects.length === 0) {
        view.last.injects.push(rec);
        return renderInjectFollowup(view.last, rec, color);
      }
      if (kind === 'inject:failed') {
        return `${bar()}\n${heading('注入失败', '31', color)}\n  ${rec.error ?? '未知'}\n${bar()}\n`;
      }
      return renderInjectStandalone(rec, color);
    }
    if (kind === 'propose' || kind === 'search') return renderTool(rec, color);
    return `${compactLine(rec, color, view.seqWidth)}\n${rawDetail(rec)}\n`;
  }

  return {
    get hidden() { return view.hidden; },
    banner(info = {}) {
      return bannerText({ ...info, compact, rawHttp });
    },
    push(rec) {
      if (!rec || typeof rec !== 'object') return '';
      view.seqWidth = Math.max(view.seqWidth, String(rec.seq ?? '').length);
      const heartbeat = isHeartbeatHttp(rec);
      if (heartbeat) {
        view.hidden += 1;
        if (!rawHttp && view.current && !view.current.flushed) view.current.hidden += 1;
        if (!rawHttp) return '';
      }
      if (compact) return `${compactLine(rec, color, view.seqWidth)}\n`;
      if (rec.kind === 'http') {
        const block = heartbeat
          ? `${rawBlock(rec, color, view.seqWidth)}\n`
          : renderHttpStory(rec, color);
        return hold(block);
      }
      const text = feed(rec);
      if (rec.kind === 'propose' || rec.kind === 'search') return hold(text);
      return text;
    },
    endBatch() {
      if (compact) return '';
      if (!view.current || view.current.flushed || !view.current.exit) return '';
      const complete = view.current.injects.length > 0 || view.current.injectFailed || !expectsInject(view.current);
      if (!complete && !view.current.waitedInject) {
        view.current.waitedInject = true;
        return '';
      }
      if (complete && expectsMoreCandidates(view.current) && !view.current.waitedQuiet) {
        view.current.waitedQuiet = true;
        return '';
      }
      return flush();
    },
  };
}

/** 回放一组事件并结算等待中的卡片。测试和离线对照用。 */
export function replayLive(records, options = {}) {
  const view = createLiveView(options);
  const parts = [];
  if (options.banner) parts.push(view.banner(options.banner));
  for (const rec of records) {
    const text = view.push(rec);
    if (text) parts.push(text);
  }
  const first = view.endBatch();
  if (first) parts.push(first);
  const second = view.endBatch();
  if (second) parts.push(second);
  return parts.join('');
}

async function api(state, path) {
  const ports = state.port ? [state.port] : state.ports;
  for (const p of state.port ? [state.port] : ports) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/dsh-memory${path}`);
      if (!r.ok) continue;
      state.port = p;
      return await r.json();
    } catch { /* 换端口 */ }
  }
  return null;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const state = { port: opt.port, ports: opt.port ? [opt.port] : [52995, 43337, 24938] };
  const probe = await api(state, '/ping');
  if (!probe) {
    console.log('✗ 连不上 Host。DSH 是否在运行？可试 --port <端口>');
    process.exitCode = 1;
    return;
  }
  if (!probe.injection?.trace?.enabled) {
    console.log('');
    console.log('⚠ 插件侧埋点没开，事件流是空的。需要两步：');
    console.log('');
    console.log('   1. 在启动 DSH 的环境变量里设置：');
    console.log('      DSH_MEMORY_TRACE=1');
    console.log('   或者不用重启，直接：');
    console.log('      node scripts/memory-trace-switch.mjs --on');
    console.log('');
    console.log('   2. 若改的是 Host 代码，才需要重启 DSH。标记文件不用重启。');
    console.log('');
    console.log('   然后重新运行本脚本。');
    console.log('');
    console.log(`   当前 trace 状态: ${JSON.stringify(probe.injection.trace ?? { enabled: false })}`);
    console.log('');
    process.exitCode = 2;
    return;
  }

  const useColor = process.stdout.isTTY !== false && !process.env.NO_COLOR;
  const view = createLiveView({ compact: opt.compact, rawHttp: opt.rawHttp, color: useColor });
  let since = 0;
  if (!opt.fromStart) {
    const head = await api(state, '/trace?limit=1');
    since = head?.lastSeq ?? 0;
  }
  process.stdout.write(view.banner({
    port: state.port,
    traceFile: probe.injection.trace.file,
    written: probe.injection.trace.written,
    dropped: probe.injection.trace.dropped,
    fromStart: opt.fromStart,
    since,
  }));

  let lastPrint = Date.now();
  let hiddenAtPrint = view.hidden;
  for (;;) {
    const batch = await api(state, `/trace?since=${since}&limit=500`);
    if (batch === null) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    let printed = false;
    for (const rec of batch.records ?? []) {
      if (rec.seq > since) since = rec.seq;
      const text = view.push(rec);
      if (text) {
        process.stdout.write(text);
        printed = true;
      }
    }
    const tail = view.endBatch();
    if (tail) {
      process.stdout.write(tail);
      printed = true;
    }
    if (printed) {
      lastPrint = Date.now();
      hiddenAtPrint = view.hidden;
    } else if (Date.now() - lastPrint >= 30000 && view.hidden !== hiddenAtPrint) {
      const n = view.hidden - hiddenAtPrint;
      process.stdout.write(paint(`……仍在跟随。刚藏起 ${n} 条只读轮询（GET /trace 或面板刷新），没有新的记忆步骤。\n`, '90', useColor));
      lastPrint = Date.now();
      hiddenAtPrint = view.hidden;
    }
    await new Promise((r) => setTimeout(r, opt.interval * 1000));
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
