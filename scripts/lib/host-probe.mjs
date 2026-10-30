#!/usr/bin/env node
/**
 * 共用的 Host 探测。
 *
 * 端口不能写死：DSH 每次启动都会换一个随机端口。三个来源按可靠性排序：
 *   1. `DSH_WEB_URL`   —— DSH 注入到每个 shell 的环境变量，最准
 *   2. `--port` 参数   —— 手动指定
 *   3. 常见端口回退    —— 环境变量缺失时（例如在 DSH 之外的终端里跑）
 *
 * 这里只做只读探测，不改任何状态。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 从 DSH_WEB_URL 取出端口，取不到返回 null。 */
export function portFromEnv(env = process.env) {
  const raw = env?.DSH_WEB_URL;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const url = new URL(raw);
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** 插件数据目录，与 Host 侧 resolveDataDir 保持一致。 */
export function dataDir(env = process.env) {
  const override = env?.DSH_MEMORY_DATA_DIR?.trim();
  return override !== undefined && override !== '' ? override : join(homedir(), '.dsh', 'dsh-memory');
}

/**
 * 按顺序尝试的端口列表，去重后返回。
 *
 * 环境变量优先，其次是显式参数，最后才是回退列表——所以一个正在运行的
 * Host 几乎总能被第一次尝试命中。
 */
export function candidatePorts(explicit, env = process.env) {
  const fromEnv = portFromEnv(env);
  const list = [];
  if (explicit !== null && explicit !== undefined && Number.isInteger(explicit)) list.push(explicit);
  if (fromEnv !== null) list.push(fromEnv);
  for (const port of [50691, 44885, 52995, 43337, 24938]) {
    if (!list.includes(port)) list.push(port);
  }
  return [...new Set(list)];
}

/**
 * 探测正在运行的 Host。
 *
 * 返回 `{ port, ping }`，或 null。每个端口只等一小会儿，避免在错误的端口上
 * 卡住整轮。
 */
export async function probeHost(options = {}) {
  const ports = candidatePorts(options.port, options.env);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500;
  for (const port of ports) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh-memory/ping`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const ping = await res.json();
      return { port, ping };
    } catch {
      // 这个端口没有 Host，试下一个。
    }
  }
  return null;
}

/** 一个绑定到已探测端口的只读 GET。 */
export function makeApi(port) {
  return async function api(path) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh-memory${path}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };
}
