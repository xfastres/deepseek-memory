#!/usr/bin/env node
/**
 * dsh-memory 埋点开关
 *
 * 埋点靠一个标记文件控制，**不需要重启 DSH**：
 *   开 → 创建 ~/.dsh/dsh-memory/trace-on
 *   关 → 删除它
 *
 * 用法：
 *   node scripts/memory-trace-switch.mjs            # 查看当前状态
 *   node scripts/memory-trace-switch.mjs --on       # 打开
 *   node scripts/memory-trace-switch.mjs --off      # 关闭
 *   node scripts/memory-trace-switch.mjs --status   # 只看状态
 */

import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const want = argv.includes('--on') ? true : argv.includes('--off') ? false : null;
const statusOnly = argv.includes('--status') || want === null;

const DATA_DIR = process.env.DSH_MEMORY_DATA_DIR?.trim() || join(homedir(), '.dsh', 'dsh-memory');
const MARKER = join(DATA_DIR, 'trace-on');
const TRACE = join(DATA_DIR, 'trace.jsonl');
const PORTS = [44885, 52995, 43337, 24938];

async function probeHost() {
  for (const port of PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/dsh-memory/ping`);
      if (!r.ok) continue;
      const json = await r.json();
      return { port, trace: json.injection?.trace ?? null };
    } catch { /* 换端口 */ }
  }
  return null;
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function human(bytes) {
  if (bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const rule = '─'.repeat(56);

async function main() {
  if (want !== null) {
    try {
      if (want) {
        writeFileSync(MARKER, `${new Date().toISOString()}\n`, 'utf8');
      } else if (existsSync(MARKER)) {
        unlinkSync(MARKER);
      }
    } catch (error) {
      console.log(`✗ 无法${want ? '创建' : '删除'}标记文件：${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(want ? '✓ 已打开埋点' : '✓ 已关闭埋点');
    console.log('');
  }

  const host = await probeHost();
  const onDisk = existsSync(MARKER);
  const traceSize = sizeOf(TRACE);

  console.log(rule);
  console.log(' dsh-memory 埋点状态');
  console.log(rule);
  console.log(` 标记文件    ${MARKER}`);
  console.log(` 文件存在    ${onDisk ? '是（已开）' : '否（已关）'}`);
  console.log(` 事件文件    ${TRACE}`);
  console.log(` 文件大小    ${human(traceSize)}`);

  if (host === null) {
    console.log(` Host        ✗ 连不上（DSH 是否在运行？）`);
    console.log('');
    console.log(' 磁盘上的标记已生效：下一次插件事件就会开始记录。');
    console.log(rule);
    return;
  }

  const t = host.trace;
  console.log(` Host        http://127.0.0.1:${host.port}`);
  console.log(` 运行中      ${t?.enabled ? '已开' : '已关'}（来源：${t?.source ?? '未知'}）`);
  console.log(` 已写入      ${t?.written ?? 0} 条${t?.dropped ? `（丢弃 ${t?.dropped}）` : ''}`);
  if (t?.seq) console.log(` 最新序号    #${t.seq}`);

  if (t?.source === 'environment') {
    console.log('');
    console.log(' ⚠ 当前由环境变量 DSH_MEMORY_TRACE 决定，标记文件不生效。');
    console.log('   要改用标记文件，需在启动 DSH 前取消该环境变量并重启一次。');
  }

  console.log('');
  if (t?.enabled) {
    console.log(' 下一步：另开终端运行实时流水');
    console.log('   node scripts/memory-flow-live.mjs');
  } else {
    console.log(' 下一步：打开埋点');
    console.log('   node scripts/memory-trace-switch.mjs --on');
  }
  console.log(rule);

  if (statusOnly && want === null) return;
}

await main();
