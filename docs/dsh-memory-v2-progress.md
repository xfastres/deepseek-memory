# dsh-memory v2 执行进度

对照 [dsh-memory-roadmap-v2.md](dsh-memory-roadmap-v2.md)。只记录已验证的事实；未验证的一律标注。

## 阶段 2.1 Host↔Client 通道最小实验

**状态：代码完成，等待重启 DSH 后做界面验证。**

新增内容：

| 文件 | 变化 |
|---|---|
| `packages/dsh-memory/index.js` | 从空壳变为 Host 半边：回环请求守卫、`GET /api/dsh-memory/ping` 路由、`dsh_memory_ping` 工具 |
| `packages/dsh-memory/client.js` | 新增「测试 Host 连接」按钮，区分 404 / 403 / 超时 / 网络错误 |
| `packages/dsh-memory/package.json` | description 去掉误导性的 "read-only" |
| `test/host.test.mjs` | 9 项：路由形状、守卫、方法、工具定义、注册 |
| `test/host-http.test.mjs` | 4 项：真实 socket 上的 200 / 403 / 404 / 405 |

### 已验证（我这边可复现）

- `node --check` 两个文件均通过。
- 三个测试文件共 **28 项全部通过**（原有 15 项 + Host 9 项 + 真实 HTTP 4 项）。
- 真实 socket 验证：回环 + 同源请求返回 JSON 200；伪造 Host 头返回 403；跨站返回 403；未知路径 404；POST 返回 405。
- `apply()` 在缺少服务、注册抛异常、传入 undefined 时都不抛出（启动安全，有测试覆盖）。

### 未验证（必须由重启后的界面确认）

1. DSH 是否真的挂载了这个路由（`webServer.register` 的实际行为）。
2. 页面的同源 `fetch` 是否能通过 DSH 的认证层。
3. 重启后 DSH 是否正常启动。

命令行请求 `/api/dsh-memory/ping` 返回 **401**，这是 Web 服务器认证层在前，说明命令行验证不了路由本身，必须用页面内的按钮验证。

### 一个额外的验证通道

Host 半边还注册了 `dsh_memory_ping` 工具。重启后我可以用 `cordis_inspect_query` 的 `Tool.listTools` 直接看到它是否存在，从而独立确认 Host 已被加载，不必只依赖界面点击。

### 已确认需要重启

重启前查了一次 `Tool.listTools`，返回的几十个工具里**没有** `dsh_memory_ping`。这符合 Cordis 的加载方式：Host 半边在进程启动时加载，文件改动不会热更新（只有 Client 半边的界面会在刷新页面时重新加载）。所以阶段 2.1 的界面验证必须重启 DSH 应用。

## 阶段 2.3 正式迁移设计

**状态：设计文档完成**：[dsh-memory-host-api.md](dsh-memory-host-api.md)。

定稿的两个关键决策：

| 决策 | 结论 | 依据 |
|---|---|---|
| D1 通道 | web server 路由 + 同源 fetch | 任务板在本机已验证；Remote 是禁区 |
| D2 数据目录 | 插件自有 `~/.dsh/dsh-memory/`，不用 `storageDomain` | `storageDomain` 要求 zod `valueSchema`，而插件目录下 zod 不可解析（已核实 `False`）；KV 无查询能力；任务板用 `~/.dsh/task-board/` 是同类先例 |

另外补了一个**运行时能力探测**：`GET /ping` 现在返回 `node` / `electron` / `sqlite.ok` / `sqlite.fts5` / `sqlite.trigram`。

已核实的事实：系统 Node 24 上探测结果为 `{"node":"24.16.0","electron":null,"sqlite":{"ok":true,"fts5":true,"trigram":true}}`。
**未核实**：DSH 的 Electron 44 运行时里同样可用。这决定索引能否用 SQLite，若不可用则降级为内存倒排索引（设计中已写明降级路径）。

### 本阶段测试

29 / 29 通过（客户端 15 + Host 10 + 真实 HTTP 4）。

## 阶段 2.4a（部分）Host 存储层

**状态：服务层完成并有集成测试；HTTP 路由尚未接（等通道验证）。**

新增 `packages/dsh-memory/host/ledger-service.js`：包装已有的 Git 账本，暴露 `open / state / listMemories / add / update / retract`，并把账本异常映射成设计文档里的错误码表（`stale` 409、`missing` 404、`invalid` 422、`busy` 503）。

关键设计选择：**并发令牌用账本自己的 change id，不用版本号**。界面拿到 `last_change_id`，编辑时原样带回；过期就得到 409 `stale`。这比版本号更精确，也与账本已有的基线检查一致。

集成测试 8 项，全部跑在临时目录里的真实 Git 仓库上（非 mock）：建库、新增、更新、过期拒绝、缺失 404、幂等重放、无证据拒收、撤回。

### 发现的一个迁移障碍

账本 schema 要求 `active` 记忆**至少一条 `source_refs`，且每个 ref 必须带 `event_seq`**（Session 日志里的事件序号）。但界面里的旧数据只有 `{ session_id, turn }`，**没有 event_seq**。

所以阶段 2.5 的迁移不能直接把 localStorage 灌进去，必须先把 `turn` 解析成真实的 `event_seq` —— 这需要 Host 读取 Session 日志，也就是设计文档里的 Q5。这个依赖比原先估计的更早出现，已记入待验证清单。

### 累计测试

- 客户端 15 + Host 10 + 真实 HTTP 4 = 29（快，约 0.24 秒）
- 账本服务 8（慢，约 13 秒，因为每条都要真的 `git commit`）
- **合计 37 项全部通过**

## 阶段 2.4a 补充：证据解析（Q5 / Q6 已解决）

**Q5 有答案了**：Host 有 `ctx.sessionQuery` 服务，提供 `listEvents(sessionId)`、`readEvent({sessionId, seq})`、`readSession(sessionId)`。所以**不需要自己解压 zstd 会话文件**，用正式服务即可。

**Q6 已实现**：`packages/dsh-memory/host/session-evidence.js`

- `turnUserMessageSeq(records, turn)`：纯函数，按 `turn/start` 定位轮次，取该轮第一个 `user/message` 的 `seq`。
- `createEvidenceResolver({ sessionQuery })`：通过服务读日志；用 `readEvent` 核对 `data.turn`，因为 fork / 压缩后轮次号可能不连续——**核对不上就扫描纠正，仍对不上返回 `undefined`，拒绝写入**，绝不编造 `event_seq`。
- `quoteDigest(text)`：只存原文的 sha256，不复制原文。
- `verify(refs)`：检查证据是否还指向真实且类型正确的事件，返回 `event-missing` / `event-type-mismatch` / `session-unreadable`。

13 项测试，含“轮次号不连续时用读取纠正”和“读不到就拒绝而不是猜”两个关键场景。

### 累计测试

- 客户端 15 + Host 10 + 真实 HTTP 4 = 29（约 0.24 秒）
- 账本服务 8（约 13 秒，真实 `git commit`）
- 证据解析 13（约 0.12 秒）
- **合计 50 项全部通过**

## 阶段 2.4b 路由接线（Q3 已解决）

**Q3 有答案了，而且不是猜的**：`webServer` 服务契约里 `WebRoute` 的类型声明是

```ts
interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
```

与我们一直在用的形状完全一致，handler 也允许返回 Promise。所以路由形状不需要等重启就能确认。

新增 `packages/dsh-memory/host/http-app.js`，提供 5 条真实路由：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/dsh-memory/state` | GET | 读全部记忆与账本头 |
| `/api/dsh-memory/export` | GET | 导出 `dsh-memory/v2` |
| `/api/dsh-memory/add` | POST | 新增；带 `sessionId + turn` 时用证据解析换真 event_seq |
| `/api/dsh-memory/update` | POST | 编辑；基线 change id 不符返回 409 |
| `/api/dsh-memory/retract` | POST | 撤回 |

安全分层：读接口只需回环 + 同 Host；**写接口额外要求浏览器同源标记**，裸 curl 写不进去。

关键顺序：**路由先存在、页面暂不调用**。页面仍用本地存储，所以即使路由有问题，用户看到的也只是一个未被使用的 404，而不是丢失的记忆。

7 项测试覆盖：未授权拒绝、缺浏览器标记拒绝、缺证据 422、真证据写入、`turn → event_seq` 全链路、409 / 404、非法 JSON / 错误方法 / 撤回。

### 累计测试

- 快套件（客户端 15 + Host 12 + 真实 HTTP 4 + 证据 13）= 44，约 0.23 秒
- HTTP 应用 7，约 7.6 秒
- 账本服务 8，约 13 秒
- **合计 59 项全部通过**

## 阶段 3.1 / 3.2 起步（不依赖重启的部分）

**3.1 的问题有答案了**：`agent/pre-step` 是 waterfall 事件，payload 里带 `{ agent, messages, turn, step, signal }`。也就是说注入点**能读到本轮用户消息和轮次号**，不需要别的手段。

由此确定了注入方案（详见 [dsh-memory-phase3-design.md](dsh-memory-phase3-design.md)）：**pre-step 只观察不改写消息**，`systemPrompt.context` 在组装提示词时读取观察结果并注入一个独立上下文块。不往会话里塞伪造的用户消息——那会破坏“L0 是唯一事实源”。

**3.2 检索已实现**：`packages/dsh-memory/host/retrieval.js`，12 项测试。

打分是加权和且**保留每一项**，所以每个结果都能回答“为什么是它”：

```
总分 = 相关度×0.6 + 新近度×0.15 + 重要度×0.15 + 置信度×0.1
置顶直接满分且不受预算限制
```

被排除的记忆都带原因（`not-active` / `expired` / `private` / `other-scope` / `no-lexical-match` / `over-limit` / `over-budget`），不是静默丢弃。

### 累计测试

- 快套件（客户端 15 + Host 12 + 真实 HTTP 4 + 证据 13）= 44，约 0.23 秒
- HTTP 应用 7 + 检索 12 = 19，约 7.8 秒
- 账本服务 8，约 13 秒
- **合计 71 项全部通过**

## 阶段 2.4c（第一步）界面能看见记忆库状态

**状态：只加了连接探测和状态显示，数据流未切换。**

界面新增 `createHostClient(fetch)`：读 `/state`，把每一种失败翻译成明确原因（`not-mounted` / `forbidden` / `unauthorized` / `unexpected` / 网络异常 / 超时）。

页面顶部现在常驻一行状态：

- `记忆库：连接中…`
- `记忆库：已连接 · 3 条 · 提交 abc1234`
- `记忆库：未连接（本地模式）· not-mounted`

这样重启后不需要点按钮也能立刻看到通道是否打通，而且**数据流完全没动**——页面仍然读写 localStorage，所以连接失败不会影响任何现有功能。

18 项客户端测试（新增 3 项：正常读取与部分字段容错、六种不可达原因的区分、三种状态文案）。

### 累计测试

- 客户端 18 + Host 12 + 真实 HTTP 4 + 证据 13 + 检索 12 = 59，约 0.24 秒
- HTTP 应用 7，约 7.6 秒
- 账本服务 8，约 13 秒
- **合计 74 项全部通过**

## 阶段 2.5 迁移（Host 侧完成）

`packages/dsh-memory/host/migration.js` + 路由 `POST /api/dsh-memory/migrate`。

迁移分两步，都不静默丢弃任何东西：

**plan**（规划）——对每条本地记忆：

| 情况 | 处理 |
|---|---|
| 能解析出真实证据 | 生成 ADD 提案，`idempotency_key = migrate:<id>@<version>` |
| 证据解析不出来 | 跳过，原因 `no-evidence`，**留在浏览器里** |
| 没有 `{session_id, turn}` | 跳过，原因 `no-source` |
| 内容为空 | 跳过，原因 `empty` |
| 账本里已有相同内容 | 跳过，原因 `duplicate` |
| 历史版本（superseded） | 跳过，原因 `history-not-migrated` |
| 待确认候选 | 延后，原因 `candidate-queue-not-built`（运行时库还没建） |

**apply**（写入）——逐条写账本，一条失败不影响其余，最后报告 `applied / replayed / failed / skipped`。

两个刻意的设计：

1. **解析不出证据就不迁移**，而不是给个 `event_seq: 0` 蒙过去。宁可看到「这条没迁过去，因为找不到来源」，也不要账本第一天就有假证据。
2. **幂等键固定**，重复点迁移只会 `replayed`，不会写出两条一样的记忆。

7 项测试，其中一项跑真实 Git 账本：写入 2 条 → 提交了 2 次 → 再迁移一次 → `replayed: 2`、账本仍是 2 条。

### 累计测试

- 快套件（客户端 18 + Host 11 + 真实 HTTP 4 + 证据 13 + 检索 12）= 58，约 0.32 秒
- HTTP 应用 8，约 10.6 秒
- 迁移 7（含真实 Git），约 3.6 秒
- 账本服务 8，约 13 秒
- **合计 81 项全部通过**

## 下一步

重启 → 看顶部状态行。已连接则调 `/migrate` 把本地记忆搬进账本；之后才切换读写。
