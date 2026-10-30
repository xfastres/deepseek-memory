#!/usr/bin/env node
/**
 * dsh-memory 实时流水 —— 跟随 append-only 事件流
 *
 * 与 memory-flow-trace.mjs 的区别：
 *   trace.mjs  轮询「结果」（注入记录），看不到消息刚进来、面板被点击这些时刻
 *   本脚本     跟随 `/api/dsh-memory/trace` 的事件流，**一发消息就实时打出来**
 *
 * 前提：插件侧埋点必须开着
 *   1. 在启动 DSH 的环境里设置 DSH_MEMORY_TRACE=1
 *   2. 重启 DSH（Host 代码改动必须重启才生效）
 *   3. 运行本脚本
 *
 * 用法：
 *   node scripts/memory-flow-live.mjs                 # 跟随最新事件
 *   node scripts/memory-flow-live.mjs --from-start    # 从头回放全部历史
 *   node scripts/memory-flow-live.mjs --port 52995
 *   node scripts/memory-flow-live.mjs --compact       # 一行一事件，不打详情
 *
 * 只读：只 GET /trace，不写账本、不改状态。
 */

import { dataDir, makeApi, probeHost } from './lib/host-probe.mjs';

const argv = process.argv.slice(2);
const opt = { fromStart: false, compact: false, port: null, interval: 1 };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--from-start') opt.fromStart = true;
  else if (a === '--compact') opt.compact = true;
  else if (a.startsWith('--port=')) opt.port = Number(a.slice(7));
  else if (a === '--port') opt.port = Number(argv[++i]);
  else if (a.startsWith('--interval=')) opt.interval = Math.max(0.2, Number(a.slice(11)));
}

const DATA_DIR = dataDir();

// ═══ HTTP ══════════════════════════════════════════════════════════════
let port = null;
let api = null;

// ═══ 显示宽度 ══════════════════════════════════════════════════════════
function dw(text) {
  let w = 0;
  for (const ch of String(text)) {
    w += /[\u1100-\u1155\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6b\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1;
  }
  return w;
}
const time = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '??:??:??' : d.toLocaleTimeString('zh-CN', { hour12: false });
};

// ═══ 每种事件的渲染 ════════════════════════════════════════════════════
const KIND_META = {
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

function paint(text, color, enabled) {
  return enabled ? `\x1b[${color}m${text}\x1b[0m` : text;
}
const useColor = process.stdout.isTTY !== false && !process.env.NO_COLOR;

/** 渲染一条事件的详情。每个 kind 只打它真正携带的字段。 */
function detail(rec) {
  const d = rec;
  const lines = [];
  const put = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    lines.push(`      ${k}${' '.repeat(Math.max(2, 14 - dw(k)))} ${v}`);
  };

  switch (d.kind) {
    case 'pre-step:enter':
      put('会话', d.sessionId);
      put('轮次', `第 ${d.turn} 轮 / 第 ${d.step} 步`);
      put('消息数', `${d.messages} 条`);
      break;
    case 'observe':
      put('会话', d.sessionId);
      put('轮次', `第 ${d.turn} 轮`);
      put('原文', `${d.queryChars} 字`);
      if (d.query) lines.push(`      │ ${String(d.query).slice(0, 300)}`);
      put('观察路径', d.observePath);
      put('lookup', d.lookupPath);
      put('候选', `${d.candidates} 条${d.candidateRules?.length ? `（${d.candidateRules.join('、')}）` : ''}`);
      break;
    case 'candidate':
      put('id', d.id);
      put('类型', `${d.type}  置信 ${d.confidence}`);
      put('规则', d.rule);
      put('继承实体', `${d.entities} 个`);
      if (d.text) lines.push(`      │ "${String(d.text).slice(0, 200)}"`);
      break;
    case 'candidate:policy':
      put('id', d.id);
      put('决策', d.decision);
      put('状态', d.status);
      if (Array.isArray(d.reasons) && d.reasons.length) put('理由', d.reasons.join('、'));
      break;
    case 'snapshot':
      put('记忆数', `${d.memories} 条`);
      put('被屏蔽', `${d.suppressed} 条`);
      put('head', d.head ? `${String(d.head).slice(0, 16)}…` : null);
      if (d.degraded) put('降级', d.degraded);
      break;
    case 'constraints':
      put('加载', String(d.loaded));
      put('可用', `${d.usable} 条`);
      if (Array.isArray(d.fallback) && d.fallback.length) put('fallback', d.fallback.join(', '));
      break;
    case 'inject': {
      put('路径', d.path);
      put('字数', `${d.chars} 字`);
      if (d.pools) {
        put('约束池', `${d.pools.constraint?.used}/${d.pools.constraint?.budget}`);
        put('动态池', `${d.pools.dynamic?.used}/${d.pools.dynamic?.budget}`);
      }
      for (const e of d.chosen ?? []) {
        lines.push(`      ✓ ${e.id}  ${e.chars} 字  [${e.kind}]`);
        if (e.reason) lines.push(`         ${e.reason}`);
      }
      for (const e of d.excluded ?? []) {
        lines.push(`      ✗ ${e.id ?? '(空)'}  ${e.reason}${e.pool ? `  池=${e.pool}` : ''}`);
      }
      if (d.text) {
        lines.push('      ┌ 实际注入原文');
        for (const line of String(d.text).split('\n')) lines.push(`      │ ${line}`);
        lines.push('      └');
      }
      break;
    }
    case 'pre-step:exit':
      put('provider', d.providerRegistered ? '已注册' : `未注册${d.skipped ? `（${d.skipped}）` : ''}`);
      put('累计调用', `${d.calls} 次`);
      break;
    case 'http':
      put('路由', `${d.method} ${String(d.route).replace('/api/dsh-memory', '')}`);
      put('耗时', `${d.ms} ms`);
      put('状态', d.status);
      break;
    case 'propose':
      put('id', d.id);
      put('动作', `${d.action}${d.target ? ` → ${d.target}` : ''}`);
      put('类型', d.type);
      put('状态', d.status);
      if (d.content) lines.push(`      │ "${String(d.content).slice(0, 200)}"`);
      break;
    case 'search':
      put('查询', d.query);
      put('结果', `${d.results} 条`);
      put('隐藏', `${d.hidden} 条`);
      if (d.reason) put('原因', d.reason);
      break;
    default:
      put('数据', JSON.stringify(d).slice(0, 300));
  }
  return lines.join('\n');
}

function render(rec, seqWidth) {
  const meta = KIND_META[rec.kind] ?? { icon: '·', label: rec.kind, color: '0' };
  const seq = String(rec.seq).padStart(seqWidth, ' ');
  const head = [
    paint(seq, '90', useColor),
    paint(time(rec.at), '90', useColor),
    paint(`${meta.icon} ${meta.label}`, meta.color, useColor),
  ].join('  ');

  if (opt.compact) {
    const brief = [];
    if (rec.sessionId) brief.push(rec.sessionId.slice(0, 20));
    if (rec.turn !== undefined && rec.turn !== null) brief.push(`t${rec.turn}`);
    if (rec.chars !== undefined) brief.push(`${rec.chars}字`);
    if (rec.decision) brief.push(rec.decision);
    if (rec.route) brief.push(`${rec.method} ${String(rec.route).replace('/api/dsh-memory', '')}`);
    return `${head}${brief.length ? `  ${brief.join(' ')}` : ''}`;
  }

  const det = detail(rec);
  return det === '' ? head : `${head}\n${det}`;
}

// ═══ 主循环 ════════════════════════════════════════════════════════════
async function main() {
  const host = await probeHost({ port: opt.port });
  if (host === null) {
    console.log('✗ 连不上 Host。DSH 是否在运行？可试 --port <端口>');
    process.exitCode = 1;
    return;
  }
  port = host.port;
  api = makeApi(port);
  const probe = host.ping;
  if (!probe.injection?.trace?.enabled) {
    console.log('');
    console.log('⚠ 插件侧埋点没开，事件流是空的。');
    console.log('');
    console.log('   打开埋点（不需要重启 DSH）：');
    console.log('     node scripts/memory-trace-switch.mjs --on');
    console.log('');
    console.log('   然后重新运行本脚本。');
    console.log('');
    console.log(`   当前 trace 状态: ${JSON.stringify(probe.injection.trace ?? { enabled: false })}`);
    console.log('');
    process.exitCode = 2;
    return;
  }

  const traceFile = probe.injection.trace.file;
  console.log('');
  console.log('═'.repeat(72));
  console.log(' dsh-memory 实时流水');
  console.log('═'.repeat(72));
  console.log(` Host        http://127.0.0.1:${port}`);
  console.log(` 事件文件    ${traceFile}`);
  console.log(` 已写入      ${probe.injection.trace.written} 条${probe.injection.trace.dropped ? `（丢弃 ${probe.injection.trace.dropped}）` : ''}`);
  console.log('');
  console.log(' 跟随中…发一条消息就能看到它走到哪一步。Ctrl+C 退出。');
  console.log('');

  let since = 0;
  if (!opt.fromStart) {
    const head = await api('/trace?limit=1');
    since = head?.lastSeq ?? 0;
    if (since > 0) console.log(` （从 #${since} 之后开始；用 --from-start 回放全部）\n`);
  }

  let seqWidth = 3;
  for (;;) {
    const batch = await api(`/trace?since=${since}&limit=500`);
    if (batch === null) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const rec of batch.records ?? []) {
      if (rec.seq > since) since = rec.seq;
      seqWidth = Math.max(seqWidth, String(rec.seq).length);
      process.stdout.write(`${render(rec, seqWidth)}\n`);
    }
    await new Promise((r) => setTimeout(r, opt.interval * 1000));
  }
}

await main();
