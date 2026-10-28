# 隔离宿主验收指南（已核实）

本文件的每条路径、环境和命令都按仓库与 profile 的实际内容核对过；未核实的内容会明确标注。
仓库根：`F:\deepseek-memory`（文档中一律用相对路径描述仓库内文件）。

## A. 验收前检查

| 检查项 | 事实 | 如何自己复核 |
|---|---|---|
| 插件入口 | `packages/dsh-memory/index.js`（`package.json` 的 `exports["."]`） | 读 `packages/dsh-memory/package.json` |
| 加载方式 | 生产 profile 里是 **junction 直连源码**：`node_modules/@local/dsh-memory → F:\deepseek-memory\packages\dsh-memory`，**没有打包步骤** | `Get-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-memory" \| Select LinkType,Target` |
| 何时生效 | Host half 只在 **DSH 进程启动时**加载；客户端半在页面刷新时重载 | 改完 `index.js`/`host/*.js` 必须重启 DSH |
| 数据目录 | `resolveDataDir()` 读 `DSH_MEMORY_DATA_DIR`，否则 `%USERPROFILE%\.dsh\dsh-memory`；**lazy**：第一次用到 store 时才读 | `index.js` 的 `resolveDataDir` |
| 生产数据 | `%USERPROFILE%\.dsh\dsh-memory`（账本 `ledger/`，运行时 `runtime/runtime.json`） | `Get-ChildItem "$env:USERPROFILE\.dsh\dsh-memory"` |
| 隔离数据 | `F:\dsh-memory-test-home\data`（由准备脚本创建） | 见 B 段 |
| 无需的环境变量 | 代码中**不存在** `DSH_MEMORY_DIGEST`，也没有 `make-injection-config.mjs`；摘要由 `sourceDigestOf()` 从原文计算 | `Select-String -Path packages/dsh-memory/**/*.js -Pattern DSH_MEMORY_DIGEST` |

> 由于是 junction 直连源码，"运行进程加载了哪份代码"等于"磁盘上的这份源码"——但**仍需重启**才会执行新代码。

## B. 自动化验收（先跑，失败则不必启动宿主）

```powershell
cd F:\deepseek-memory
node --test --test-force-exit packages\dsh-memory\test\*.test.mjs
```

期望：`pass` 等于 `tests`，`fail 0`。当前真实结果见进度文档。

## C. 准备隔离数据（幂等，可重复执行）

```powershell
cd F:\deepseek-memory
node scripts\prepare-isolated-acceptance.mjs
```

脚本会：

1. 拒绝生产目录或任何 `$HOME\.dsh` 下的路径（防误写）；
2. 在隔离目录创建**一条短小的 fixture 记忆**（`type: constraint`，内容含"隔离数据"字样，证据指向 `fixture-session-isolated`，因此可一眼识别为测试数据）；
3. 用 `condense()` + `sourceDigestOf()` 生成 `injection.json`，并**回读校验**：`loaded`、`usable`、`rejected`；
4. 重复执行不会新增记忆、不会覆盖已有 `injection.json`（除非 `--force`）。

预期输出包含 `usable : 1`、`rejected : []` 和隔离数据目录路径。

## D. 启动隔离宿主

在**同一个 PowerShell 会话**里先设变量，再启动 DSH（双击图标不会继承该变量）：

```powershell
$env:DSH_MEMORY_DATA_DIR = 'F:\dsh-memory-test-home\data'
# 从该会话启动 DSH（用你平时启动它的可执行文件/脚本）
```

确认隔离生效（任选其一）：

- 对话里调用 `dsh_memory_ping`：`injection.constraints.loaded` 应为 `true`，`usable` 为 `1`；
- 查看 `F:\dsh-memory-test-home\data\runtime\runtime.json` 是否被创建。

如果 `loaded` 为 `false` 且 `fallback` 含 `missing-file`，说明进程没读到隔离目录（环境变量没继承），**不要继续**，先解决启动方式。

## E. 对话验收

1. 问一个与 fixture 无关的问题（如"今天适合做什么"）——fixture 无词面匹配，恰好验证"约束绕过词面门槛"；
2. 从提示块确认出现了 `以下是用户已确认的长期记忆，仅作背景参考：`，且内容是**摘要**；
3. 查审计路由（端口以当前 GUI 为准）：

```powershell
curl.exe -s -H "sec-fetch-site: same-origin" "http://127.0.0.1:<port>/api/dsh-memory/injections?limit=5"
```

期望字段：`state:"returned"`、`confirmed:null`、`occurrences` 等于该轮 provider 实际调用次数、`snapshot_head` 等于账本 head、`memory_ids` 含 fixture 的 id。**不要预设 occurrences 一定是 2**，以实际值为准。

4. 再跑一次准备脚本并重启，确认 `runtime.json` 里的记录仍在（上限 200 条 / 30 天剪枝）。

## F. 失败排查

| 现象 | 先看哪里 | 常见原因 |
|---|---|---|
| 提示里没有记忆块 | `dsh_memory_ping` → `injection.context.skipped` | `no-active-memory`（隔离账本为空，准备脚本没跑或跑错目录）；`no-system-prompt-service`（宿主未提供该服务） |
| 块里有原文而不是摘要 | `constraints.rejected` | `digest-stale`（改了记忆没重算指纹）、`digest-unverified`（配置缺 sourceDigest） |
| `loaded:false` + `missing-file` | `injection.constraints.fallback` | 环境变量未继承，进程读的是生产目录 |
| 路由 404 | 路由表 | Host half 未重启（旧进程仍加载旧代码） |
| 路由 403 | 请求来源 | 只读路由要求**回环 socket + 回环 Host 头**；`sec-fetch-site: cross-site` 或非回环地址会被拒绝。回环请求**不带** same-origin 头仍然允许（已实测 200） |
| `flush.ok:false` | `injection.flush.error` | runtime 目录不可写、文件锁被占用、`runtime.json` 损坏（此时 store 拒绝覆盖，需人工处理该文件） |

宿主日志里插件的自述行以 `[dsh-memory]` 开头（注册失败、prompt context 注册失败等）。


## H. 已获得的真实宿主证据（只读观察，生产 profile）

以下不是推断，是 2026-10-28 20:2x 从运行中的生产宿主读取到的实际数据：

| turn | chars | occurrences | state | confirmed | snapshot_head |
|---|---|---|---|---|---|
| 95 | 435 | 1 | returned | null | 139ca8b… |
| 96 | 435 | 2 | returned | null | 139ca8b… |
| 97 | 435 | 2 | returned | null | 139ca8b… |
| 98 | 435 | 2 | returned | null | 139ca8b… |

- `snapshot_head` 与生产账本 `git rev-parse HEAD`（`139ca8babf3dc1f4d77bdb11251f10f076b448d5`）完全一致；
- `occurrences` 真实值是 **1 和 2 都出现过**，不能预设为 2；
- 用当前工作区代码对同一条记忆重新渲染（只读）：`final text length = 435`，与宿主记录**逐字符一致**（正文 400 + 截断标记 10 + 标题/序号/标签 25）；
- 路由实测：`?limit=5` → 200 + 4 条；`?limit=abc` → 400。

**需要注意的差异**：这些记录由 19:49 启动的进程写入，其 `reasons` 字段是旧实现的 `[memory_ids]`。当前工作区已改为真实入选原因；重启后新记录会呈现正确内容。`pools/memories/excluded` 目前为 `null/[]/[]` 也是该原因（运行进程早于诊断字段扩展）。

**仍未验证**：provider 返回的文本是否真的进入了模型提示（`confirmed` 恒为 `null`，宿主无回执）；隔离 profile 的端到端流程。

## G. 明确未验证的部分

- 真实进程是否真的把返回文本交给模型（`confirmed` 恒为 `null`，宿主无回执 API）；
- 真实 provider 每步调用次数（代码路径推断为 2，需以 `injection_log.calls` 实测为准）；
- 跨进程文件锁语义（只有单进程测试证据）。
