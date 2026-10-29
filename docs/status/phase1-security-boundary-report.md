# Phase 1 — 安全边界最小修复包：验收报告

- 基线提交：`4ea0a00`（工作树干净）
- 范围：只修 Phase 0 审计确认的 P0/P1，不引入 Hindsight、不重构 L0–L3、不扩 UI
- 结论：**已修复并全绿**

## 1. 修了什么

| 编号 | 问题（Phase 0） | 修复 | 落点 |
|---|---|---|---|
| P0-1 | 写围栏 `isTrustedWrite = isTrustedRead`，只校验 loopback；`/update`、`/retract`、`/review` 可省略 `expectedBaseChangeId`，并发基线可被绕过 | `/state` 公布进程内随机写令牌；所有写路由要求请求头 `x-dsh-memory-token`，缺失/错误 → `401 unauthorized`；`/update`、`/retract`、`/review`(merge) 强制要求非空基线 → `400 missing-base` | `host/http-app.js`、`client.js` |
| P1-1 | 纠正线索词 `incorrect` / `delete_request` 与持久化词汇 `wrong` / `delete` 不一致，`addObjection` 直接拒收 | 新增 `CORRECTION_KIND_ALIASES` 与 `normalizeCorrectionKind()`；`applyCorrection` 与 `runtime-store.addObjection` 在入库前归一化，未知 kind 仍然拒收 | `host/corrections.js`、`host/correction-detect.js`、`host/runtime-store.js` |
| P1-2 | 缺少 `sessionQuery` 时证据校验被静默跳过（fail-open） | 新增 `allowUnverified`（仅供测试，默认 `false`）；生产缺证据服务时写入 → `503 evidence-unavailable` | `host/http-app.js` |
| P1-4 | `refresh()` 中 `suppressed()` 抛错时清空抑制集，导致被反对的记忆重新注入 | 抑制读取失败改为 fail-closed：保留上一份已过滤快照并标记 `degraded: 'suppression-unavailable'`；无历史快照时注入空集 | `host/injection.js` |
| P1-3 | 浏览器 `localStorage` 副本仍自称“正式记忆”，与 Git 账本双权威 | 仅改文案与提示：`浏览器本地副本（未进账本）` + “正式记忆以记忆库（Git 账本）为准”；不动架构 | `client.js` |

配套：客户端在 `/state` 响应里静默学习令牌（插件作用域共享，因为每次点击都会新建 client），写请求自动带上；无基线时前端先给出 `versionChanged` 提示，不再发一个必然失败的请求。

## 2. 回归测试

新增 `packages/dsh-memory/test/security-boundary.test.mjs`（6 条）：

1. 无令牌/错令牌的写被拒（即使来自 loopback），带正确令牌才落账；
2. `/update`、`/retract` 缺基线或空基线 → `400 missing-base`，账本未被改动；
3. 无 `sessionQuery` 时正式写 → `503 evidence-unavailable`，账本为空；
4. 纠正线索词归一化后再入库（含 `applyCorrection` → runtime 全链路）；
5. 抑制读取失败时保留上一份过滤快照，且不重新注入被反对的记忆；
6. 首次抑制读取失败、无历史快照时注入为空。

同时更新受影响断言：

- `http-app.test.mjs`：`call()` 自动携带令牌（可用 `unauth: true` 关闭），原“裸写 200”改为“裸写 401 + 带令牌 200”；未知记忆用例补上基线，使 404 仍由查表失败产生。
- `injection.test.mjs`：原“抑制失败就放弃过滤”的断言改为“保留上次过滤 + 标记降级”。
- `client-panels.test.mjs`：本地副本文案断言。
- `client.test.mjs`：新增“从 `/state` 学习令牌、跨 client 复用”的回归测试。

## 3. 命令与结果

```
node --test "packages/dsh-memory/test/*.test.mjs"      → 397 pass / 0 fail  (≈103s)
node --test "packages/provider-git-ledger/test/*.test.js" → 31 pass / 0 fail
node --test "packages/l0-conversation/test/*.test.js"     → 7 pass / 0 fail
node --test packages/dsh-memory/test/host-http.test.mjs   → 5 pass（真实 socket）
```

安全边界 6 条、HTTP 路由 31 条均单独复跑确认。真实 socket 的围栏用例（本机 Origin 正常、外站 Host/Sec-Fetch-Site 被拒）继续通过。

> 后续已在真实运行的应用上完成端到端验收（令牌、候选接受、编辑、撤回、抑制快照），见 [phase1-acceptance-report.md](phase1-acceptance-report.md)。

## 4. 残余风险 / 未验证

- **令牌的威胁模型**：本机进程仍可读 `/state` 拿到令牌，它不是对抗本地恶意进程的凭据；它挡的是“用户浏览器里的第三方页面伪造写请求”（跨源读不到响应体，自定义头会触发 Host 不放行的预检）。真正的进程级授权要等 ApprovalStore / `writesEnabled` 接线（本阶段明确未做）。
- **面板点击未验证**：活体验收走的是面板调用的同一批 HTTP handler；浏览器直接打开 GUI 需要登录态（401），因此没有做 UI 级点击。客户端令牌接线由 `client.test.mjs` 覆盖。
- **强基线带来的行为变化**：`/update`、`/retract` 不再接受“无基线”调用。任何外部脚本/旧客户端若省略 `expectedBaseChangeId` 会收到 `400 missing-base`，这是有意的收紧。
- **degraded 快照**：抑制服务持续不可用时，注入块会保持“上次的过滤结果”而不是随账本更新；这是有意的保守取舍，`snapshot.degraded` 可用于诊断。
- **未接线**：`host/memory-writer.js` 的 gated ADD 仍未挂到生产路由，本轮是在旧 HTTP 入口上加固，不是统一写入路径迁移。

## 5. 改动文件

```
packages/dsh-memory/host/http-app.js          写令牌 + 证据闸门 + 强制基线
packages/dsh-memory/host/corrections.js       词汇别名与归一化
packages/dsh-memory/host/correction-detect.js 纠错入库前归一化
packages/dsh-memory/host/runtime-store.js     反对 kind 归一化
packages/dsh-memory/host/injection.js         抑制失败 fail-closed
packages/dsh-memory/client.js                 令牌学习/携带、无基线提示、本地副本文案
packages/dsh-memory/test/security-boundary.test.mjs  新增
packages/dsh-memory/test/{http-app,injection,client-panels,client}.test.mjs  断言更新
```

