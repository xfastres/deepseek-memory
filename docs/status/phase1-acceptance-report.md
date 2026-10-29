# Phase 1 安全边界 —— 端到端验收报告

- 验收时间：2026-10-29 18:48–18:55（Asia/Shanghai）
- 运行中的应用：`http://127.0.0.1:64913`（进程启动 18:48:03）
- 结论：**通过**；无新增缺陷需修复

## 1. 重启与线上写令牌 —— 通过

| 检查 | 证据 |
|---|---|
| 应用确实加载了修复后的代码 | 进程启动 18:48:03 晚于最后一次插件改动 17:47:58；`desktop` profile 以软链方式加载 `F:/deepseek-memory/packages/dsh-memory`，运行的就是工作区代码 |
| `/state` 公布写令牌 | 活体 `GET /state` → 200，`writeToken` 为 64 位十六进制 |
| 无令牌写被拒 | `POST /add`、`POST /candidate` 无令牌 → `401 unauthorized` |
| 取证失败被拒 | 指向不存在会话的 `/add` → `422 no-evidence`（`session-unreadable`） |
| 基线强制 | `/update`、`/retract` 缺基线 → `400 missing-base` |

数据目录确认为生产目录 `~/.dsh/dsh-memory`（验收产生的变更记录可在其中查到）。

## 2. 候选接受 / 记忆编辑 / 撤回 —— 通过（真实应用）

用真实会话证据走完整链路（脚本 `tmp/acceptance-live.mjs`，可重复执行）：

1. `POST /candidate` 以 `session-d4cb6ebe…` turn 1 生成候选 `C-20261029-1ef93676`，证据为 `event_seq 9`，携带 `quote_sha256`；
2. `POST /review {action: accept}` → 落账为 `M-20261029-adeb262e`（commit `992b8b44`）；
3. `POST /update` 带新基线 → 编辑成功（change `MC-20261029104957-5ed3faed`）；
4. 用旧基线重复编辑 → `409 stale`（乐观并发生效）；
5. `POST /retract` 带最新基线 → 状态 `retracted`（commit `a58d5505`）；
6. 复查 `/state`：该记忆最终为 `retracted`。

**验收残留（真实账本，无法抹除历史，如实记录）**：一条已撤回的验收记忆 `M-20261029-adeb262e`、一条 `accepted_by_user` 候选 `C-20261029-1ef93676`、两个账本提交。内容明确标注“验收测试：安全边界”。

## 3. 生产配置不会启用 `allowUnverified` —— 通过

- 该开关只存在于 `createMemoryApp` 的入参，默认 `false`；
- 两处生产调用（`index.js` 的 `createRoutes` 与插件激活）都只传 `dataDir` + `sessionQuery`；
- 无环境变量、无 `cordis.patch.yml` 选项、无设置文件键可打开它；
- 线上反证：不可读会话的写入被 `422` 拒绝，说明证据校验确实在场。

## 4. 正式记忆写入入口盘点 —— 通过

账本唯一出口是 `host/ledger-service.js`（`MemoryLedger` 只在此处构造），所有入口最终都经过它：

| 入口 | 授权 | 证据 | 并发基线 |
|---|---|---|---|
| HTTP `/add`、`/migrate` | 令牌 | 强制（无证据服务则 503） | 不适用 |
| HTTP `/update`、`/retract` | 令牌 | 强制 | 强制 |
| HTTP `/review`（accept / merge） | 令牌 | 强制 | merge 强制 |
| HTTP `/proposal`（accept） | 令牌 | 强制 | 非 add 强制 |
| HTTP `/candidate`、`/objections`、`/objections/clear`、`/settings` | 令牌 | 不写账本 | 不适用 |
| 内部 `auto-memory.writeAutoAccepted` | 无 HTTP 暴露 | 候选必须先经 `evidence.resolve` 才能存在（无证据即无候选），写时 `service.add` 再次校验 | 不适用 |
| `host/memory-writer.js` 的 gated ADD | 未接线，仅测试使用 | 有 | 有 |
| 客户端 `localStorage` 副本 | 不写账本 | 不适用 | 不适用，文案已标注“未进账本” |

未发现可绕过授权、证据校验或统一写出口的路径。

## 5. 异议抑制快照 —— 通过（新增 3 条测试）

`injection.refresh()` 在 `suppressed()` 抛错时的行为，用 `security-boundary.test.mjs` 覆盖：

| 场景 | 结果 |
|---|---|
| 首次故障、无历史快照 | 注入为空，标记 `degraded: suppression-unavailable` |
| 持续故障（连续 3 次刷新） | 每次保持上一份已过滤快照，不扩大注入，`suppressed` 保留上次计数 |
| 进程重启后仍故障 | 注入为空（不会因为“新进程没快照”而放行） |
| 恢复后 | 按当前账本与当前异议集合重建过滤，不冻结故障前的旧集合，`degraded` 清除 |

## 6. 失败项与未验证项

**失败项：无。**

未验证（如实标注）：

- **面板人工点击**：直接用浏览器打开 GUI 返回 `401`（需要登录态），因此没有做 UI 级点击验证。面板调用的正是本次活体验收的同一批 handler；客户端令牌接线由 `client.test.mjs` 单测覆盖。
- **注入文本在真实回合中的可见性**：未在真实对话回合里目视确认注入块内容（抑制快照行为已用单测覆盖）。
- **多进程并发写**：未做跨进程并发压力验证。

## 7. 本次验收的代码改动

- 仅新增 3 条抑制快照回归测试（`packages/dsh-memory/test/security-boundary.test.mjs`），未修改任何生产代码；
- 回归：`dsh-memory` 400 通过 / 0 失败；`provider-git-ledger` 31 通过；`l0-conversation` 7 通过。
- 验收脚本留在 `tmp/acceptance-live.mjs`（`tmp/` 已被 Git 忽略），可重复执行。
