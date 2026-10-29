#!/usr/bin/env node
/**
 * dsh-memory 注入流水监听器
 *
 * 用途：把「一轮对话里记忆是怎么被处理、最后往系统提示里注入了什么」打印成一大块日志。
 *
 * 数据来源（都是只读）：
 *   1. HTTP  /api/dsh-memory/state       —— 当前账本快照（含每条记忆正文）
 *   2. HTTP  /api/dsh-memory/injections  —— 注入记录（每轮一条，含预算与排除原因）
 *   3. 文件  ~/.dsh/dsh-memory/runtime/runtime.json —— 落盘后的注入记录（兜底）
 *   4. 文件  ~/.dsh/dsh-memory/ledger/records/*.json —— 按 memory_id 取正文
 *   5. 插件  host/retrieval.js           —— 复用真实的选择/渲染逻辑，保证输出与插件一致
 *
 * 关键点：注入记录里**不存**最终正文（只存 chars 和 digest），所以脚本用
 * memory_ids + 账本正文按 formatInjection 重建，并用长度与记录里的 chars 比对校验。
 *
 * 用法：
 *   node scripts/memory-flow-watch.mjs               # 常驻监听，每有新一轮注入就打印
 *   node scripts/memory-flow-watch.mjs --once        # 只打印最近一轮，然后退出
 *   node scripts/memory-flow-watch.mjs --all         # 先把历史全部打印一遍再监听
 *   node scripts/memory-flow-watch.mjs --query "..." # 预演：现在来这么一句会注入什么
 *   node scripts/memory-flow-watch.mjs --port 43337 --interval 2
 */

import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = {
  once: argv.includes('--once'),
  all: argv.includes('--all'),
  interval: 2,
  port: null,
  query: null,
};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--interval=')) opt.interval = Number(a.split('=')[1]);
  else if (a === '--interval') opt.interval = Number(argv[++i]);
  else if (a.startsWith('--port=')) opt.port = Number(a.split('=')[1]);
  else if (a === '--port') opt.port = Number(argv[++i]);
  else if (a.startsWith('--query=')) opt.query = a.slice(8);
  else if (a === '--query') opt.query = argv[++i];
}
if (!Number.isFinite(opt.interval) || opt.interval <= 0) opt.interval = 2;

// ── 路径与端口 ──────────────────────────────────────────────────────────
const DATA_DIR = process.env.DSH_MEMORY_DATA_DIR?.trim()
  || join(homedir(), '.dsh', 'dsh-memory');
const LEDGER_RECORDS = join(DATA_DIR, 'ledger', 'records');
const RUNTIME_FILE = join(DATA_DIR, 'runtime', 'runtime.json');
const PLUGIN_DIR = join(DATA_DIR, '..', '..', 'deepseek-memory-system', 'deepseek-memory', 'packages', 'dsh-memory');
// 插件目录按工作目录解析更可靠；失败则退回 DATA_DIR 推算
const CANDIDATE_PLUGIN_DIRS = [
  process.env.DSH_MEMORY_PLUGIN_DIR?.trim(),
  'D:\\deepseek-memory-system\\deepseek-memory\\packages\\dsh-memory',
  PLUGIN_DIR,
].filter(Boolean);

const CANDIDATE_PORTS = opt.port ? [opt.port] : [43337, 24938];

// ── 复用插件的真实逻辑 ──────────────────────────────────────────────────
let retrieval = null;
for (const dir of CANDIDATE_PLUGIN_DIRS) {
  try {
    retrieval = await import(pathToFileURL(join(dir, 'host', 'retrieval.js')).href);
    break;
  } catch {
    retrieval = null;
  }
}
const formatInjection = retrieval?.formatInjection ?? fallbackFormat;
const clipContent = retrieval?.clipContent ?? fallbackClip;
const selectMemories = retrieval?.selectMemories ?? null;
const eligibility = retrieval?.eligibility ?? null;

function fallbackClip(text, limit = 400) {
  const v = String(text ?? '');
  return v.length <= limit ? v : `${v.slice(0, limit)}…（以下内容已截断）`;
}
function fallbackFormat(chosen, { header = '以下是用户已确认的长期记忆，仅作背景参考：' } = {}) {
  if (!Array.isArray(chosen) || chosen.length === 0) return '';
  const lines = [header];
  chosen.forEach((e, i) => {
    const scope = e.memory.scope && e.memory.scope !== 'global' ? `（范围：${e.memory.scope}）` : '';
    const body = typeof e.text === 'string' ? e.text : clipContent(e.memory.content);
    lines.push(`${i + 1}. ${body}${scope}`);
  });
  return lines.join('\n');
}

// ── HTTP ────────────────────────────────────────────────────────────────
let activePort = null;
async function api(path) {
  for (const port of activePort ? [activePort] : CANDIDATE_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh-memory${path}`);
      if (!res.ok) continue;
      activePort = port;
      return await res.json();
    } catch {
      // 换下一个端口
    }
  }
  return null;
}

// ── 账本 ────────────────────────────────────────────────────────────────
let ledgerCache = null;
async function ledgerRecords() {
  if (ledgerCache) return ledgerCache;
  const map = new Map();
  try {
    for (const name of await readdir(LEDGER_RECORDS)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(LEDGER_RECORDS, name), 'utf8'));
        if (rec && typeof rec.memory_id === 'string') map.set(rec.memory_id, rec);
      } catch {
        // 单条坏文件不影响整体
      }
    }
  } catch {
    // 账本目录不存在
  }
  ledgerCache = map;
  return map;
}

async function memoryContent(id, stateMemories) {
  const fromState = stateMemories?.find?.((m) => m && m.id === id);
  if (fromState && typeof fromState.content === 'string') return fromState;
  const rec = (await ledgerRecords()).get(id);
  return rec ?? null;
}

// ── 展示工具 ────────────────────────────────────────────────────────────
const RULE = '═'.repeat(72);
const THIN = '─'.repeat(72);
const pad = (label, n = 10) => String(label).padEnd(n, ' ');

function section(no, title) {
  return [`\n${THIN}`, ` ${no} ${title}`, THIN].join('\n');
}

function box(text, width = 66) {
  const lines = String(text).split('\n');
  const out = [`  ┌${'─'.repeat(width + 2)}`];
  for (const line of lines) {
    const shown = line.length > width ? `${line.slice(0, width - 1)}…` : line;
    out.push(`  │ ${shown}`);
  }
  out.push(`  └${'─'.repeat(width + 2)}`);
  return out.join('\n');
}

// ── 单轮注入报告 ────────────────────────────────────────────────────────
async function renderInjection(rec, index, total, state) {
  const stateMemories = state?.memories ?? [];
  const lines = [];

  lines.push('');
  lines.push(RULE);
  lines.push(` dsh-memory 注入流水  #${index}/${total}`);
  lines.push(RULE);
  lines.push(` ${pad('时间')}: ${rec.at ?? '(未知)'}`);
  lines.push(` ${pad('会话')}: ${rec.session_id ?? '(未记录)'}`);
  lines.push(` ${pad('轮次')}: ${rec.turn ?? '(未记录)'}    ${pad('出现次数')}: ${rec.occurrences ?? 1}`);
  lines.push(` ${pad('快照 head')}: ${(rec.snapshot_head ?? '(无)').slice(0, 16)}…`);
  lines.push(` ${pad('状态')}: ${rec.state ?? 'returned'}    ${pad('记录 key')}: ${(rec.key ?? '').slice(0, 20)}…`);

  // ① 候选池：这一轮快照里所有记忆 + 资格判定
  lines.push(section('①', '账本快照（候选池）'));
  if (stateMemories.length === 0) {
    lines.push('  （快照为空：账本里没有 active 记忆）');
  } else {
    const now = rec.at ? new Date(rec.at) : new Date();
    for (const m of stateMemories) {
      const reason = eligibility ? eligibility(m, { now, scope: 'global' }) : null;
      const flag = reason === null ? '✓ 可注入' : `✗ 排除(${reason})`;
      const meta = `type=${m.type ?? '?'} layer=${m.layer ?? '?'} status=${m.status ?? '?'} scope=${m.scope ?? '?'}`;
      const score = `置信 ${Number(m.confidence ?? 0).toFixed(2)} 重要 ${m.importance ?? 0}`;
      lines.push(`  ${flag}  ${m.id}`);
      lines.push(`      ${meta}  ${score}`);
      const body = String(m.content ?? '').replace(/\s+/g, ' ').trim();
      lines.push(`      正文(${body.length}字): ${body.length > 60 ? `${body.slice(0, 60)}…` : body}`);
    }
  }

  // ② 检索与预算
  lines.push(section('②', '检索与预算'));
  const pools = rec.pools ?? {};
  const cPool = pools.constraint ?? { budget: 240, used: 0 };
  const dPool = pools.dynamic ?? { budget: 800, used: 0 };
  lines.push(`  约束池（常驻约束，走 digest）: ${cPool.used}/${cPool.budget} 字`);
  lines.push(`  动态池（普通记忆，按分排序）: ${dPool.used}/${dPool.budget} 字`);
  const chosen = Array.isArray(rec.memories) ? rec.memories : [];
  lines.push(`  选中 ${chosen.length} 条:`);
  if (chosen.length === 0) lines.push('    （无）');
  for (const e of chosen) {
    lines.push(`    ✓ ${e.id}  ${e.chars_used ?? '?'} 字  池=${e.kind ?? 'memory'}`);
    lines.push(`        理由: ${e.reason ?? '(无)'}`);
  }
  const excluded = Array.isArray(rec.excluded) ? rec.excluded : [];
  lines.push(`  排除 ${excluded.length} 条:`);
  if (excluded.length === 0) lines.push('    （无）');
  for (const e of excluded) {
    lines.push(`    ✗ ${e.id ?? '(空 id)'}  原因: ${e.reason ?? '(无)'}${e.pool ? `  池=${e.pool}` : ''}`);
  }

  // ③ 重建最终注入正文
  lines.push(section('③', '最终注入到系统提示的原文（重建）'));
  const rebuilt = [];
  for (const e of chosen) {
    const mem = await memoryContent(e.id, stateMemories);
    if (!mem) {
      lines.push(`  ⚠ ${e.id} 在账本里找不到正文，无法重建`);
      continue;
    }
    rebuilt.push({
      memory: mem,
      text: clipContent(String(mem.content ?? '').replace(/\s+/g, ' ').trim()),
    });
  }
  const rendered = rebuilt.length > 0 ? formatInjection(rebuilt) : '';
  if (rendered === '') {
    lines.push('  （本轮没有注入任何文字）');
  } else {
    lines.push(box(rendered));
    const expected = rec.chars;
    const ok = typeof expected === 'number' ? rendered.length === expected : null;
    lines.push(`  校验: 重建长度 ${rendered.length} 字 vs 记录 chars ${expected ?? '(无)'} → ${ok === null ? '无记录可比' : ok ? '一致 ✓' : '不一致 ✗（记录可能来自不同快照）'}`);
  }

  // ④ 这条路径怎么来的
  lines.push(section('④', '数据流'));
  lines.push('  Git 账本 records/*.json');
  lines.push(`    → 快照（agent/pre-step 每轮刷新，TTL 30s）: ${stateMemories.length} 条 active`);
  lines.push('    → 资格过滤（status/scope/有效期/异议抑制）');
  lines.push(`    → 打分排序（置顶 > 分数 > id）→ 预算截断（动态池 ${dPool.used}/${dPool.budget}）`);
  lines.push(`    → formatInjection 渲染: ${rendered.length} 字`);
  lines.push('    → systemPrompt.context(name=dsh-memory, order=100) 注入本步 prompt');
  lines.push('    注：账本无 active 记忆时，provider 根本不注册（skipped=no-active-memory）');
  lines.push('');

  return lines.join('\n');
}

// ── 预演模式：给定一句话，现在会注入什么 ────────────────────────────────
async function dryRun(query) {
  const state = await api('/state');
  if (!state) {
    console.log('✗ 连不上 Host（/api/dsh-memory/state）。DSH 是否在运行？');
    process.exitCode = 1;
    return;
  }
  const memories = Array.isArray(state.memories) ? state.memories : [];
  const lines = [];
  lines.push('');
  lines.push(RULE);
  lines.push(' dsh-memory 预演：这句话现在会注入什么');
  lines.push(RULE);
  lines.push(` 查询: ${JSON.stringify(query)}  (${query.length} 字)`);
  lines.push(` 快照: ${memories.length} 条记忆   head=${(state.head ?? '').slice(0, 16)}…`);

  if (!selectMemories) {
    lines.push(' ⚠ 未能加载插件的 retrieval.js，无法预演打分');
    console.log(lines.join('\n'));
    return;
  }

  const now = new Date();
  const selected = selectMemories(memories, query, {
    now,
    scope: 'global',
    limit: 6,
    budget: 800,
    constraints: [],
    constraintBudget: 240,
    constraintMaxChars: 120,
    constraintMaxItems: 2,
  });

  lines.push(section('②', '检索与预算'));
  lines.push(`  约束池: ${selected.pools.constraint.used}/${selected.pools.constraint.budget} 字（无约束配置）`);
  lines.push(`  动态池: ${selected.pools.dynamic.used}/${selected.pools.dynamic.budget} 字`);
  lines.push(`  选中 ${selected.chosen.length} 条:`);
  for (const e of selected.chosen) {
    const parts = e.score?.parts ?? {};
    lines.push(`    ✓ ${e.memory.id}  ${e.chars_used} 字  总分 ${Number(e.score?.total ?? 0).toFixed(3)}`);
    lines.push(`        pinned=${!!parts.pinned} lexical=${parts.lexical ?? 0} hits=[${(parts.hits ?? []).join('、')}]`);
    lines.push(`        理由: ${e.reason}`);
  }
  if (selected.chosen.length === 0) lines.push('    （无）');
  lines.push(`  排除 ${selected.excluded.length} 条:`);
  for (const e of selected.excluded) {
    lines.push(`    ✗ ${e.id ?? '(空)'}  ${e.reason}${e.pool ? `  池=${e.pool}` : ''}`);
  }
  if (selected.excluded.length === 0) lines.push('    （无）');

  lines.push(section('③', '最终会注入的原文'));
  const rendered = formatInjection(selected.chosen);
  lines.push(rendered === '' ? '  （空：这一句不会触发任何记忆）' : box(rendered));
  lines.push(`  长度: ${rendered.length} 字 / 预算 800`);
  lines.push('');
  console.log(lines.join('\n'));
}

// ── 监听 ────────────────────────────────────────────────────────────────
async function loadInjections() {
  const fromApi = await api('/injections?limit=200');
  if (fromApi && Array.isArray(fromApi.injections)) return fromApi.injections;
  try {
    const doc = JSON.parse(await readFile(RUNTIME_FILE, 'utf8'));
    return Array.isArray(doc.injections) ? doc.injections : [];
  } catch {
    return [];
  }
}

async function currentState() {
  return (await api('/state')) ?? { memories: [] };
}

async function printOne(rec, index, total, state) {
  process.stdout.write(`${await renderInjection(rec, index, total, state)}\n`);
}

async function main() {
  if (opt.query !== null) {
    await dryRun(opt.query);
    return;
  }

  const first = await loadInjections();
  const state = await currentState();

  if (first.length === 0) {
    console.log('还没有任何注入记录。账本为空或还没有产生对话轮次。');
    if (!opt.once) console.log(`（监听中，每 ${opt.interval}s 检查一次…）`);
  } else if (opt.once) {
    await printOne(first[first.length - 1], first.length, first.length, state);
    return;
  } else if (opt.all) {
    for (let i = 0; i < first.length; i += 1) {
      await printOne(first[i], i + 1, first.length, state);
    }
  } else {
    await printOne(first[first.length - 1], first.length, first.length, state);
  }

  if (opt.once) return;

  // 常驻：以 key 去重，新记录出现就打印
  let seen = new Set(first.map((r) => r.key ?? `${r.at}:${r.chars}`));
  console.log(`\n监听中：每 ${opt.interval}s 轮询一次，出现新的注入就打印。Ctrl+C 退出。\n`);
  for (;;) {
    await new Promise((r) => setTimeout(r, opt.interval * 1000));
    const list = await loadInjections();
    const fresh = list.filter((r) => !seen.has(r.key ?? `${r.at}:${r.chars}`));
    if (fresh.length === 0) continue;
    const st = await currentState();
    for (const rec of fresh) {
      seen.add(rec.key ?? `${rec.at}:${rec.chars}`);
      await printOne(rec, list.length, list.length, st);
    }
  }
}

await main();
