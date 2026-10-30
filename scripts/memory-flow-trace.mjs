#!/usr/bin/env node
/**
 * dsh-memory 消息流转追踪器 —— 按 12 步打印一条消息的完整流转
 *
 * 对应文档：docs/message-flow.md
 *
 * 每一步都打印**真实数据**：真实端点返回值、真实账本记录、真实打分结果、
 * 真实拼接文字。不是示意图，是这台机器上此刻发生的事。
 *
 * 用法：
 *   node scripts/memory-flow-trace.mjs                  # 跟踪最近一轮，打完退出
 *   node scripts/memory-flow-trace.mjs --live           # 常驻，每轮新注入就打一遍
 *   node scripts/memory-flow-trace.mjs --query "..."    # 预演：这句话会走完 12 步
 *   node scripts/memory-flow-trace.mjs --turn 8         # 指定看第 8 轮
 *   node scripts/memory-flow-trace.mjs --port 52995
 *
 * 只读：不写账本，不改状态。
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidatePorts } from './lib/host-probe.mjs';

// ═══ 参数 ══════════════════════════════════════════════════════════════
const argv = process.argv.slice(2);
const opt = { live: false, port: null, query: null, turn: null, interval: 2 };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--live') opt.live = true;
  else if (a.startsWith('--port=')) opt.port = Number(a.slice(7));
  else if (a === '--port') opt.port = Number(argv[++i]);
  else if (a.startsWith('--query=')) opt.query = a.slice(8);
  else if (a === '--query') opt.query = argv[++i];
  else if (a.startsWith('--turn=')) opt.turn = Number(a.slice(7));
  else if (a === '--turn') opt.turn = Number(argv[++i]);
  else if (a.startsWith('--interval=')) opt.interval = Number(a.slice(11));
}

// ═══ 路径 ══════════════════════════════════════════════════════════════
const DATA_DIR = process.env.DSH_MEMORY_DATA_DIR?.trim() || join(homedir(), '.dsh', 'dsh-memory');
const LEDGER = join(DATA_DIR, 'ledger');
const RECORDS = join(LEDGER, 'records');
const CHANGES = join(LEDGER, 'changes');
const RUNTIME = join(DATA_DIR, 'runtime', 'runtime.json');
const PLUGIN_DIRS = [
  process.env.DSH_MEMORY_PLUGIN_DIR?.trim(),
  'D:\\deepseek-memory-system\\deepseek-memory\\packages\\dsh-memory',
].filter(Boolean);

// ═══ 复用插件真实逻辑 ══════════════════════════════════════════════════
let P = {};
for (const dir of PLUGIN_DIRS) {
  try {
    P.retrieval = await import(pathToFileURL(join(dir, 'host', 'retrieval.js')).href);
    P.extraction = await import(pathToFileURL(join(dir, 'host', 'extraction.js')).href);
    P.evidence = await import(pathToFileURL(join(dir, 'host', 'session-evidence.js')).href);
    P.injection = await import(pathToFileURL(join(dir, 'host', 'injection.js')).href);
    break;
  } catch {
    // 换下一个候选目录
  }
}

// ═══ HTTP ══════════════════════════════════════════════════════════════
let port = null;
let resolvedPorts = null;
async function api(path) {
  if (resolvedPorts === null) resolvedPorts = candidatePorts(opt.port);
  for (const p of port ? [port] : resolvedPorts) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/dsh-memory${path}`);
      if (!r.ok) continue;
      port = p;
      return await r.json();
    } catch { /* 换端口 */ }
  }
  return null;
}

// ═══ 渲染工具 ══════════════════════════════════════════════════════════
const W = 74;
const HEAVY = '═'.repeat(W);
const LIGHT = '─'.repeat(W);

const STEP_NAMES = [
  '消息进来：DSH 触发 agent/pre-step 瀑布钩子',
  'observe()：记下你这句话',
  'extractCandidates()：挑「像记忆」的句子',
  'turnUserMessageSeq()：解析证据',
  'proposeForReview()：候选写进 runtime.json',
  'handleCorrection()：检查是不是在纠正记忆',
  'ensureFresh()：刷新 Git 账本快照',
  'refreshConstraints()：解析常驻约束',
  'flushInjections()：注入记录落盘',
  'ensureContext()：注册 prompt 上下文',
  'buildText()：lookup → 打分 → 拼字',
  'formatInjection()：最终注入原文',
  'prompt → 大模型 → 回复',
  '（后续）接受候选 → MemoryLedger.apply() → git commit',
];

function stepHeader(n, title) {
  return `\n${LIGHT}\n 第 ${String(n).padStart(2)} 步  ${title}\n${LIGHT}`;
}
/** 按显示宽度补齐（中文占 2 列），否则中文键名会把冒号挤歪。 */
function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6b\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1;
  }
  return w;
}
function kv(k, v, indent = 2) {
  const pad = ' '.repeat(indent);
  const key = String(k);
  const fill = Math.max(2, 22 - displayWidth(key));
  return `${pad}${key}${' '.repeat(fill)} ${v}`;
}
function body(text, indent = 2) {
  const pad = ' '.repeat(indent);
  return String(text).split('\n').map((l) => `${pad}│ ${l}`).join('\n');
}
function fileLine(path, fn) {
  return `   文件  ${path}${fn ? `  →  ${fn}()` : ''}`;
}
function warn(msg) {
  return `   ⚠ ${msg}`;
}

// ═══ 账本读取 ══════════════════════════════════════════════════════════
async function ledgerRecords() {
  const map = new Map();
  try {
    for (const n of await readdir(RECORDS)) {
      if (!n.endsWith('.json')) continue;
      try {
        const r = JSON.parse(await readFile(join(RECORDS, n), 'utf8'));
        if (r?.memory_id) map.set(r.memory_id, r);
      } catch { /* 单条坏文件跳过 */ }
    }
  } catch { /* 目录不存在 */ }
  return map;
}

async function runtimeDoc() {
  try {
    return JSON.parse(await readFile(RUNTIME, 'utf8'));
  } catch {
    return { candidates: [], injections: [], proposals: [], objections: [] };
  }
}

// ═══ 12 步追踪 ══════════════════════════════════════════════════════════
async function trace(ctx) {
  const out = [];
  const { injection, state, runtime, records, query, now } = ctx;
  const memories = Array.isArray(state?.memories) ? state.memories : [];

  out.push('');
  out.push(HEAVY);
  out.push(` dsh-memory 消息流转追踪`);
  out.push(HEAVY);
  out.push(kv('时间', now.toISOString()));
  out.push(kv('会话', injection?.session_id ?? '(未记录)'));
  out.push(kv('轮次', injection?.turn ?? '(未记录)'));
  out.push(kv('账本 head', (state?.head ?? '').slice(0, 16) + '…'));
  out.push(kv('本轮查询', query === null ? '(未提供，用记录里的)' : JSON.stringify(query)));

  // ── 第 1 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(1, STEP_NAMES[0]));
  out.push(fileLine('index.js:764', 'onPreStep'));
  out.push('   钩子签名（inspect 查到的真实契约）：');
  out.push(body(`agent/pre-step   模式：waterfall\npayload = { agent, messages, turn, step, signal }\n返回    { kind: 'reject' } 或 { kind: 'enter', messages }`));
  out.push('   这一步做：记消息 → 提取 → 提候选 → 查纠正 → 刷新 → 落盘 → 注册 → next()');

  // ── 第 2 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(2, STEP_NAMES[1]));
  out.push(fileLine('host/injection.js:159', 'observe'));
  out.push(fileLine('host/injection.js:41', 'stepQuery'));
  const text = query ?? '';
  out.push(kv('取到的用户原文', `${text.length} 字`));
  if (text !== '') out.push(body(text.length > 300 ? `${text.slice(0, 300)}…` : text));
  out.push('   规则：只取 role === "user"；截断到 4000 字；存 byScope + byAgent 两份');
  if (P.injection?.scopeShape) {
    const shape = P.injection.scopeShape(injection ? { id: injection.session_id } : null);
    out.push(kv('scope 形状', JSON.stringify(shape)));
  }
  out.push(kv('观察路径', ctx.observedPath ?? '(未知)'));

  // ── 第 3 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(3, STEP_NAMES[2]));
  out.push(fileLine('host/extraction.js:94', 'extractCandidates'));
  if (text === '') {
    out.push(warn('没有查询文本，无法演示提取（用 --query 指定一句话）'));
  } else if (!P.extraction) {
    out.push(warn('未能加载 extraction.js'));
  } else {
    const sent = P.extraction.sentences(text);
    out.push(kv('切句结果', `${sent.length} 句`));
    for (const s of sent) {
      const refused = P.extraction.refusal(s);
      const tag = refused === undefined ? '✓ 进入规则匹配' : `✗ 拒绝(${refused})`;
      out.push(`     ${tag}  「${s.length > 40 ? `${s.slice(0, 40)}…` : s}」`);
    }
    const cands = P.extraction.extractCandidates(text);
    out.push(kv('提取到候选', `${cands.length} 条`));
    for (const c of cands) {
      out.push(`     • type=${c.type}  confidence=${c.confidence}  rule=${c.rule}`);
      out.push(`       matched=[${c.matched.join('、')}]`);
      out.push(`       text="${c.text.length > 50 ? `${c.text.slice(0, 50)}…` : c.text}"`);
    }
    if (cands.length === 0) out.push('     （没有命中任何规则：这句话不会变成候选）');
  }

  // ── 第 4 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(4, STEP_NAMES[3]));
  out.push(fileLine('host/session-evidence.js:43', 'turnUserMessageSeq'));
  const turnNo = injection?.turn;
  const sessionId = injection?.session_id;
  out.push(kv('要解析的轮次', String(turnNo ?? '(无)')));
  out.push('   逻辑：找该轮 turn/start 的 seq → 找下一条 user/message 的 seq');
  const memWithRef = memories.find((m) => Array.isArray(m.source_refs) && m.source_refs.length > 0);
  if (memWithRef) {
    const ref = memWithRef.source_refs[0];
    out.push(kv('账本里的真实证据', `seq=${ref.event_seq}  type=${ref.event_type}`));
    out.push(kv('所属会话', ref.session_id));
    out.push(kv('引文哈希', `${String(ref.quote_sha256 ?? '').slice(0, 24)}…`));
  } else {
    out.push(warn('账本里没有带 source_refs 的记忆'));
  }
  out.push('   解析失败 → 返回 undefined → 调用方不许写（这就是「不编造 event_seq」）');

  // ── 第 5 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(5, STEP_NAMES[4]));
  out.push(fileLine('index.js:529', 'proposeForReview'));
  out.push('   顺序（任一步失败就返回，什么都不写）：');
  out.push(body(`1. 与账本 active 记忆去重\n2. evidence.resolve({ sessionId, turn })\n3. settings.enabled === true\n4. service.state() 读账本\n5. runtime.addCandidate()\n6. decideAutoMemory() → 自动接受 / 冲突 / 待审`));
  const cands = Array.isArray(runtime?.candidates) ? runtime.candidates : [];
  out.push(kv('runtime 候选队列', `${cands.length} 条`));
  for (const c of cands.slice(-3)) {
    out.push(`     • ${c.id ?? '?'}  status=${c.status}  type=${c.type ?? '?'}`);
    out.push(`       "${String(c.text ?? '').slice(0, 50)}…"`);
  }
  if (cands.length === 0) out.push('     （队列为空：没有待审候选）');
  const settings = ctx.settings?.settings;
  out.push(kv('总开关 enabled', String(settings?.enabled ?? '?')));
  out.push(kv('自动接受 autoAccept', String(settings?.autoAccept ?? '?')));

  // ── 第 6 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(6, STEP_NAMES[5]));
  out.push(fileLine('host/correction-detect.js', 'isCorrectionCandidate'));
  out.push('   大多数轮次不是纠正 → 直接跳过，连账本都不打开');
  const objs = Array.isArray(runtime?.objections) ? runtime.objections : [];
  out.push(kv('当前异议', `${objs.length} 条`));
  if (ctx.objections?.suppressed?.length) {
    out.push(kv('被屏蔽记忆', ctx.objections.suppressed.join(', ')));
  } else {
    out.push('     （无屏蔽记忆）');
  }

  // ── 第 7 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(7, STEP_NAMES[6]));
  out.push(fileLine('host/injection.js:310', 'ensureFresh'));
  out.push(fileLine('host/injection.js:116', 'refresh'));
  out.push(kv('快照时间', state ? (ctx.ping?.injection?.snapshot_at ?? '(无)') : '(无)'));
  out.push(kv('TTL', '30 秒（30 秒内不重复读盘）'));
  out.push(kv('快照记忆数', `${memories.length} 条`));
  out.push('   fail-closed：读不到异议列表时，保留上次已过滤快照或注入空');
  out.push('   ——绝不「读失败就当没异议」，否则会把你否掉的记忆又放回来');

  // ── 第 8 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(8, STEP_NAMES[7]));
  out.push(fileLine('host/constraints.js', 'loadConfig / resolveConstraints'));
  const cons = ctx.ping?.injection?.constraints;
  out.push(kv('配置加载', String(cons?.loaded ?? '?')));
  out.push(kv('fallback', Array.isArray(cons?.fallback) ? cons.fallback.join(', ') : '(无)'));
  out.push(kv('可用约束', `${cons?.usable ?? 0} 条`));
  if (cons?.budget) {
    out.push(kv('约束预算', `total=${cons.budget.total} constraint=${cons.budget.constraint} maxChars=${cons.budget.maxChars} maxItems=${cons.budget.maxItems}`));
  }
  if (Array.isArray(cons?.fallback) && cons.fallback.includes('missing-file')) {
    out.push(`     → memory-settings.json 不存在，约束池空转（0/240）`);
  }

  // ── 第 9 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(9, STEP_NAMES[8]));
  out.push(fileLine('index.js:629', 'flushInjections'));
  out.push('   provider 绝不碰磁盘：组装时只排队，到这一步才写');
  const flush = ctx.ping?.injection?.flush;
  out.push(kv('上次落盘', flush?.ok === true ? '成功' : flush?.ok === false ? `失败(${flush.error})` : '(未发生)'));
  out.push(kv('累计写入', `${flush?.written ?? 0} 条`));
  out.push(kv('注入日志', `calls=${ctx.ping?.injection?.injection_log?.calls ?? 0} empty=${ctx.ping?.injection?.injection_log?.empty ?? 0} records=${ctx.ping?.injection?.injection_log?.records ?? 0}`));

  // ── 第 10 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(10, STEP_NAMES[9]));
  out.push(fileLine('index.js:702', 'ensureContext'));
  const active = memories.filter((m) => m.status === 'active');
  out.push(kv('active 记忆', `${active.length} 条`));
  const cs = ctx.ping?.injection?.context;
  out.push(kv('provider 已注册', String(cs?.registered ?? '?')));
  out.push(kv('provider 被调用', `${cs?.calls ?? 0} 次`));
  out.push(kv('累计注入字数', `${cs?.chars ?? 0} 字`));
  out.push(kv('skipped 原因', String(cs?.skipped ?? 'null')));
  if (active.length === 0) {
    out.push(`     → ${warn('账本无 active 记忆，provider 根本不注册（skipped=no-active-memory）')}`);
  } else {
    out.push('     → 有 active 记忆，provider 注册到 systemPrompt.context(name=dsh-memory, order=100)');
  }

  // ── 第 11 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(11, STEP_NAMES[10]));
  out.push(fileLine('host/injection.js:229', 'buildText'));
  out.push(fileLine('host/retrieval.js:179', 'selectMemories'));
  out.push(kv('lookup 路径', ctx.ping?.injection?.path ?? '(未知)'));
  out.push('   四种路径：scope（最准）/ agent（按会话 id）/ latest（只有一个会话）/ ambiguous（故意丢弃查询）');
  out.push('   ambiguous 的取舍：注入别的会话的查询「看起来对、其实是错的」，比什么都不注入更糟');
  if (text !== '') {
    const grams = P.retrieval?.grams?.(text) ?? [];
    out.push(kv('查询切词', `${grams.size ?? 0} 个单元`));
    out.push(`     [${[...grams].slice(0, 14).join('、')}${grams.size > 14 ? '…' : ''}]`);
    out.push('   中文按 bigram 切（两字一组），英文按单词；命中数 / 查询词数 = lexical');
  }

  if (!P.retrieval) {
    out.push(warn('未能加载 retrieval.js，无法演示打分'));
  } else {
    const selected = P.retrieval.selectMemories(memories, text, {
      now, scope: 'global', limit: 6, budget: 800,
      constraints: [], constraintBudget: 240, constraintMaxChars: 120, constraintMaxItems: 2,
    });
    const cPool = selected.pools.constraint;
    const dPool = selected.pools.dynamic;
    out.push('');
    out.push(kv('约束池', `${cPool.used}/${cPool.budget} 字`));
    out.push(kv('动态池', `${dPool.used}/${dPool.budget} 字`));
    out.push(kv('选中', `${selected.chosen.length} 条`));
    for (const e of selected.chosen) {
      const parts = e.score?.parts ?? {};
      out.push(`     ✓ ${e.memory.id}  ${e.chars_used} 字  总分 ${Number(e.score?.total ?? 0).toFixed(4)}`);
      out.push(`       pinned=${!!parts.pinned}  lexical=${Number(parts.lexical ?? 0).toFixed(4)}  hits=[${(parts.hits ?? []).join('、')}]`);
      out.push(`       confidence=${parts.confidence}  importance=${parts.importance}  recency=${Number(parts.recency ?? 0).toFixed(4)}`);
      out.push(`       理由: ${e.reason}`);
    }
    if (selected.chosen.length === 0) out.push('     （无）');
    out.push(kv('排除', `${selected.excluded.length} 条`));
    for (const e of selected.excluded) {
      out.push(`     ✗ ${e.id ?? '(空)'}  ${e.reason}${e.pool ? `  池=${e.pool}` : ''}`);
    }
    if (selected.excluded.length === 0) out.push('     （无）');
    ctx.selected = selected;
  }

  // ── 第 12 步 ──────────────────────────────────────────────────────────
  out.push(stepHeader(12, STEP_NAMES[11]));
  out.push(fileLine('host/retrieval.js:343', 'formatInjection'));
  let rendered = '';
  if (ctx.selected) {
    rendered = P.retrieval.formatInjection(ctx.selected.chosen);
  } else if (injection) {
    const rebuilt = [];
    for (const e of (injection.memories ?? [])) {
      const rec = records.get(e.id);
      if (rec) rebuilt.push({ memory: { ...rec, id: rec.memory_id, content: rec.content }, text: P.retrieval?.clipContent?.(rec.content) ?? rec.content });
    }
    rendered = rebuilt.length ? P.retrieval?.formatInjection?.(rebuilt) ?? '' : '';
  }
  if (rendered === '') {
    out.push(warn('本轮没有注入任何文字'));
  } else {
    out.push(`   最终注入原文（${rendered.length} 字）：`);
    out.push(`   ┌${'─'.repeat(W - 4)}`);
    for (const line of rendered.split('\n')) {
      out.push(`   │ ${line.length > W - 6 ? `${line.slice(0, W - 7)}…` : line}`);
    }
    out.push(`   └${'─'.repeat(W - 4)}`);
    if (injection?.chars !== undefined) {
      const ok = rendered.length === injection.chars;
      out.push(kv('长度校验', `${rendered.length} vs 记录 ${injection.chars} → ${ok ? '一致 ✓' : '不一致 ✗'}`));
    }
  }
  out.push(kv('进入 PromptAssembly', 'contexts[] 数组，与其他 sections/tools 一起打包'));

  // ── 第 13 步：发给模型 ────────────────────────────────────────────────
  out.push(stepHeader(13, STEP_NAMES[12]));
  out.push('   DSH 核心把 PromptAssembly 发给大模型，插件不参与这一步');
  out.push('   模型回复进会话日志（assistant 消息）');
  out.push('   ⚠ 插件不读它：stepQuery() 只取 role === "user"');
  out.push('   所以「不是聊天总结器，不把 AI 回复当成用户偏好的证据」');

  // ── 第 14 步：接受候选后的写入 ────────────────────────────────────────
  out.push(stepHeader(14, STEP_NAMES[13]));
  out.push(fileLine('host/http-app.js:459', '路由 /review'));
  out.push(fileLine('host/ledger-service.js:59', 'service.add / applyChange'));
  out.push(fileLine('provider-git-ledger/src/ledger.js', 'MemoryLedger.apply'));
  out.push('   四道闸门：');
  out.push(body(`1. 回环 socket（127.0.0.1 / ::1）\n2. 回环 Host 头\n3. 非跨站（sec-fetch-site !== 'cross-site'）\n4. x-dsh-memory-token 正确（token 由 GET /state 发给同源页面）`));
  out.push('   证据闸门：无 sessionQuery → 503 evidence-unavailable，不静默跳过');
  out.push('   并发闸门：/update /retract 必须带 expectedBaseChangeId，否则 400 missing-base');
  out.push('   写入流程：取文件锁 → 校验 source_refs → 写 records/ → 写 changes/ → git commit');

  const changes = ctx.changes?.changes ?? [];
  out.push(kv('账本变更历史', `${changes.length} 条`));
  for (const c of changes.slice(0, 3)) {
    out.push(`     • ${c.change_id}  ${c.change_type}  ${c.memory_id}`);
    out.push(`       commit=${String(c.commit).slice(0, 12)}…  at=${c.committed_at}`);
    out.push(`       内容="${String(c.content ?? '').slice(0, 40)}…"`);
  }
  const proposals = Array.isArray(runtime?.proposals) ? runtime.proposals : [];
  out.push(kv('AI 提案', `${proposals.length} 条`));
  for (const p of proposals.slice(-2)) {
    out.push(`     • ${p.id}  ${p.action}  status=${p.status}  origin=${p.origin}`);
  }
  out.push('   AI 提案只进 runtime.proposals（status: open），必须你在面板接受');

  // ── 结尾：当前状态 ────────────────────────────────────────────────────
  out.push('');
  out.push(HEAVY);
  out.push(' 当前状态汇总');
  out.push(HEAVY);
  out.push(kv('账本记忆', `${memories.length} 条（active ${active.length}）`));
  out.push(kv('注入记录', `${ctx.injections?.count ?? 0} 条`));
  out.push(kv('候选队列', `${cands.length} 条`));
  out.push(kv('异议', `${objs.length} 条`));
  out.push(kv('提案', `${proposals.length} 条`));
  out.push('');

  return out.join('\n');
}

// ═══ 主流程 ══════════════════════════════════════════════════════════════
async function gather(queryOverride, turnFilter) {
  const ping = await api('/ping');
  const state = await api('/state');
  const runtime = await runtimeDoc();
  const records = await ledgerRecords();
  const injRes = await api('/injections?limit=200');
  const injections = Array.isArray(injRes?.injections) ? injRes.injections : [];
  const settings = await api('/settings');
  const objections = await api('/objections');
  const changes = await api('/changes?limit=10');

  let injection = injections[injections.length - 1] ?? null;
  if (turnFilter !== null) {
    const found = injections.filter((r) => r.turn === turnFilter);
    if (found.length > 0) injection = found[found.length - 1];
  }

  return {
    ping, state, runtime, records, settings, objections, changes,
    injections: injRes,
    injection,
    observedPath: ping?.injection?.observed ?? null,
    now: new Date(),
    query: queryOverride ?? '',
  };
}

async function main() {
  const base = await gather(opt.query, opt.turn);

  if (!base.ping) {
    console.log('✗ 连不上 Host。DSH 是否在运行？可试 --port <端口>');
    process.exitCode = 1;
    return;
  }

  if (opt.query !== null) {
    console.log(await trace({ ...base, query: opt.query }));
    if (!opt.live) return;
  } else {
    if (!base.injection) {
      console.log('还没有任何注入记录（账本空或还没产生对话轮次）。');
      if (!opt.live) return;
    } else {
      console.log(await trace(base));
      if (!opt.live) return;
    }
  }

  // 常驻：新注入出现就再打一遍
  let seen = new Set((base.injections?.injections ?? []).map((r) => r.key ?? r.at));
  console.log(`\n监听中：每 ${opt.interval}s 轮询，出现新注入就重新追踪。Ctrl+C 退出。\n`);
  for (;;) {
    await new Promise((r) => setTimeout(r, opt.interval * 1000));
    const fresh = await gather(opt.query, null);
    const list = fresh.injections?.injections ?? [];
    const newOnes = list.filter((r) => !seen.has(r.key ?? r.at));
    if (newOnes.length === 0) continue;
    for (const r of newOnes) seen.add(r.key ?? r.at);
    console.log(await trace({ ...fresh, injection: newOnes[newOnes.length - 1] }));
  }
}

await main();
