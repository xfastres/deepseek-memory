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

## 阶段 2.6 运行时库：候选队列 + 注入记录

`packages/dsh-memory/host/runtime-store.js`，存放在 `~/.dsh/dsh-memory/runtime/runtime.json`。

**为什么不放进 Git 账本**：账本只存“用户确认过的记忆”。待确认候选和“这一轮注入了哪些记忆”是运行期事实——每一轮都可能变、要写得快、而且**绝不能出现在记忆历史里**。混进提交会让账本被噪音淹没，反而更难回答“这条记忆为什么在”。

实现要点：

- 单文件 JSON + 临时文件 + `rename` 原子替换；
- 复用账本那把跨进程锁（`mkdir` 排他），同一进程内再排队，并发写全部有序落地；
- **文件损坏就拒绝，绝不覆盖**——丢掉注入记录很难受，悄悄丢掉更糟；
- 待确认候选按内容去重（忽略空格，中文常带不带空格是同一句），重复提交返回 `duplicate`；
- 注入记录按 30 天 + 200 条上限自动清理，保留最新的。

配套路由：`GET /candidates`、`POST /candidate`、`POST /review`（`accept` / `merge` / `reject`）。

**accept 会真的写账本**：用候选自己带的 `source_refs`，幂等键 `candidate:<id>`，然后把候选标记为 accepted 并记下产出的 memory id。所以“候选 → 记忆”这条链路的证据是可追的。

迁移的候选部分也接上了：`/migrate` 现在把旧候选导入队列，没有证据的照样报 `no-evidence` 而不是猜。

10 项运行时库测试 + 2 项新路由测试（候选入队→接受→账本可见；各种拒绝路径）。

### 累计测试

- 快套件（客户端 18 + Host 11 + 真实 HTTP 4 + 证据 13 + 检索 12）= 58，约 0.32 秒
- HTTP 应用 10，约 12 秒
- 运行时库 10，约 0.4 秒
- 迁移 7（含真实 Git），约 3.6 秒
- 账本服务 8，约 13 秒
- **合计 93 项全部通过**

## 阶段 2.7 重启前能查的都查了（发现两个真问题）

不重启也能验证一部分“插件到底会不会被正确加载”。这轮查了三件事，其中两件查出了问题。

### 1. 插件能不能从 profile 里加载 → 能

`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `@local/dsh-memory`；`node_modules/@local/dsh-memory` 是指向 `F:\deepseek-memory\packages\dsh-memory` 的 Junction。

直接按 App 的路径加载：

```
import('file:///C:/Users/..../.dsh/profiles/desktop/node_modules/@local/dsh-memory/index.js')
→ LOADED_FROM_PROFILE function ["webServer","tools"] ... apply
```

模块图（含 `../../provider-git-ledger/src/*`）能正常求值，导出齐全。**注意 `ledger.js` 不 import `projection.js`**，所以 `node:sqlite` 不在启动路径上——Electron 里没有 `node:sqlite` 也不会影响加载。

### 2. 发现的问题：`ctx.inject(deps, cb)` 这个用法没有依据

原来 Host 半边用 `ctx.inject(['webServer'], cb)` 拿服务。查了证据：

- 已安装的插件里**没有一个**用 `ctx.inject(`（扫了 60 个包）；
- 服务契约明确写的是 `ctx.get("name")`（可选）和 `ctx.tools`（注入）；
- 同 profile 的任务板插件用的是 `export const inject = [...]` + 直接访问。

如果这个用法不存在，异常会被激活守卫吞掉，重启后表现为「路由没挂上」，白白浪费一次重启。

已改为：`export const inject = ['webServer','tools']` + `ctx.get()` 优先、属性访问兜底。

### 3. 发现的问题：git 子进程句柄不释放

`provider-git-ledger/src/git.js` 的 `run()` 在 `close` 时没释放管道和句柄。Windows 上这会让每个 git 调用留下一个仍然被引用的 `ChildProcess`——测试进程因此不退出；在长期运行的 Host 里则是句柄累积。

已改为在 `close` 时 `destroy()` 三个管道并 `unref()`。

### 测试方式的一条经验

写这条真实套接字测试时踩到：测试自己的 server 回调里抛了 `TypeError`，响应没写出去，socket 一直开着，于是 `node --test` 跑完全部用例却**不退出**。教训是「测试挂住」未必是产品泄漏，先看测试自己的错误。现在整套测试加 `--test-force-exit` 运行。

### 累计测试

- 快套件（客户端 18 + Host 12 + 真实 HTTP **5** + 证据 13 + 检索 12 + 运行时库 10）= 70
- HTTP 应用 10
- 迁移 7 + 账本 8 = 15
- **合计 95 项全部通过**

## 阶段 2.8 对照已上线插件校验通道细节

任务板插件（`@linxin666/dsh-client-ui-task-board`，就在同一个 profile 里、已经在正常跑）是唯一可直接读的「Host 路由 + 浏览器调用」参考实现。这轮把我们的做法逐条对照了一遍。

### 1. 浏览器端的 URL 必须是**文档相对**的（已改）

任务板源码里的注释（issue #1707）写得很清楚：

> 客户端基址是**文档相对**的。Host 注册的是根绝对路径 `/api/task-board`，但页面是以 `<base href="./">` 提供的，所以浏览器半边必须**去掉前导斜杠**，否则部署在子路径下就会逃出入口目录。

于是它的常量是 `CLIENT_API_PREFIX = "/api/task-board".slice(1)`，调用是 `fetch("api/task-board/verification")`。

我们原来用的是 `/api/dsh-memory`（根绝对）。已改为 `api/dsh-memory`。在根路径部署下两者等价，但在子路径下相对路径才正确——而且这是已上线插件踩过坑之后的结论。

### 2. 读请求防护：逐条对照，完全一致（无需改）

任务板的 `isLoopbackRequest`：回环 socket 地址 + 回环 Host 头 + `sec-fetch-site` 不是 `cross-site` + 有 `origin` 时必须同 Host。我们的 `isTrustedRead` 与之逐条一致。

### 3. 写请求防护：我们原来比参考实现更严（已放宽）

任务板对写请求**不加额外的浏览器标记**，用的就是同一个 `isLoopbackRequest`（逆向代理场景用单独的 token 头）。

我们原来要求写请求额外带 `origin` 或 `sec-fetch-site: same-origin`。这看起来更安全，但真实风险是：如果桌面壳的请求不带这两个头，**读能通、写全 403**——用户会看到一个能看不能改的界面，比两种极端都糟。

已改为与参考实现一致：读写用同一把锁。仍然拦得住的是：跨站请求（`sec-fetch-site` / `origin` 不匹配）、跨站必须过 CORS 预检（因为我们要求 `content-type: application/json`）、以及**web server 认证层在路由之前**（我们自己测过：不带凭证从命令行访问返回 401）。

### 4. 一个工具教训

用 PowerShell 的 `Get-Content -Raw` + `Set-Content -NoNewline` 批量替换含中文的测试文件，把 UTF-8 编码弄坏了（中文变成乱码，测试直接语法错误）。这类文件之后一律用编辑工具改，不做编码往返；被弄坏的文件从 git 恢复。

### 累计测试

- 快套件（客户端 18 + Host 12 + 真实 HTTP 5 + 证据 13 + 检索 12 + 运行时库 10）= 70
- HTTP 应用 10
- 迁移 7 + 账本 8 = 15
- **合计 95 项全部通过**

## 阶段 2.9 界面里的「导入到记忆库」按钮

界面现在会在**连接成功且本地有记忆**时显示一个按钮：「导入到记忆库（N 条）」。

点了之后：

1. 把本地 `dsh-memory.formal.v1` 和 `dsh-memory.candidates.v1` 一起 POST 到 `api/dsh-memory/migrate`；
2. Host 侧按前面那套规则逐条判断（有证据才导入、重复跳过、历史版本跳过）；
3. 界面把结果变成一句人话：

```
导入完成：新增 3 条，重复 1 条，失败 0 条，跳过 3 条（duplicate 1，no-evidence 2）
```

失败时显示具体原因（`not-mounted` / `forbidden` / `unauthorized` / `network`）。

刻意没做的事：**导入成功后不删除本地数据**。本地存储留作回退，等切换读路径验证过之后再谈清理。多留一份副本比丢一份数据好。

### 认证层的一个观察

用命令行访问 `http://127.0.0.1:51840/`（首页本身）也返回 **401**，且响应里没有 `WWW-Authenticate`。说明认证不是标准的 Basic/Bearer 挑战，而是要求浏览器带某个由页面启动时获得的凭证（Cookie 或桌面壳注入的请求头）。

这反而说明我们的方案没问题：任务板客户端用的是**同样的裸 `fetch`**（相对 URL、不加任何头），它在浏览器里能正常工作。所以浏览器会把这些凭证自动带上，我们的调用会被同等对待。

### 累计测试

- 快套件（客户端 **21** + Host 12 + 真实 HTTP 5 + 证据 13 + 检索 12 + 运行时库 10）= 73
- HTTP 应用 10
- 迁移 7 + 账本 8 = 15
- **合计 98 项全部通过**

## 下一步

界面刷新后应显示「记忆库：已连接」。点「导入到记忆库」即可把本地记忆搬进 Git 账本。之后做阶段 3 注入。

---

# 阶段 2.4 通道验证：**通过**（2026-10-28 重启后）

重启后逐项验证，全部成功。

## 1. Host 半边已加载

调用 `dsh_memory_ping` 工具返回：

```json
{"ok":true,"plugin":"@local/dsh-memory","phase":"2.4",
 "runtime":{"node":"24.21.0","electron":"44.7.0",
            "sqlite":{"ok":true,"fts5":true,"trigram":true,"error":null}}}
```

关键发现：**Electron 里 `node:sqlite` 可用，而且 FTS5 + trigram 分词器都在**。路线图里「索引用 SQLite FTS5 trigram」的假设成立，不需要换方案。

## 2. HTTP 路由已挂载，而且做插件的路由不需要浏览器凭证

```
GET /api/dsh-memory/ping   -> 200 {"ok":true,...}
GET /api/dsh-memory/state  -> 200 {"ok":true,"head":"072fb205...","memories":[]}
GET /api/nope-xyz          -> 401 unauthorized
GET /                       -> 401 "dsh web authentication required"
```

**插件注册的路由绕过认证层**：未注册路径和首页都返回 401，我们注册的路由直接 200。这就是任务板能工作的原因，也解释了之前命令行探测为什么全是 401——探的是没注册的路径。

⚠️ 安全含义：这意味着**任何本机进程都能访问这些路由**。所以「回环 + 回环 Host + 非跨站」这道自建防护不是多余的，它是唯一的一道门。

## 3. 证据解析端到端成功

```
POST /api/dsh-memory/add {sessionId:"session-69dd0347-...", turn:1}
-> 200 {"status":"committed","memory":{"id":"M-20261028-64ee2f5f",...}}
```

真实会话 → 真实 `event_seq` → Git 提交，全链路打通。

**首次尝试的 422 不是 bug**：我挑的第一个会话只有 315 字节，本来就没有轮次，返回 `no-evidence` 是正确行为。换成有内容的会话立刻成功。

## 4. 真实 Git 历史

`~/.dsh/dsh-memory/ledger`：

```
132599e memory(retract): M-20261028-64ee2f5f
619dec4 memory(retract): M-20261028-5d798d92
b3f2d72 memory(retract): M-20261028-25022f54
9b02394 memory(add): M-20261028-25022f54
d229e69 memory(add): M-20261028-5d798d92
e02dacb memory(add): M-20261028-64ee2f5f
072fb20 ledger: initialize memory repository
```

每条变更一个提交，撤回也留痕。三条验证用的临时记忆已全部撤回，账本现在 `active: 0`、`total: 3`。

## 5. 修掉一个真 bug：会话读不到时返回 500

验证中发现：给**不存在的 sessionId** 提交记忆返回 `500 internal`，因为 `sessionQuery` 对不存在的会话会抛异常，落在了兜底分支。

「这个会话读不到」是**拒绝**，不是内部故障。已改为 `422 {"error":"no-evidence","reason":"session-unreadable"}`，并补了测试。

## 测试

**99 项通过。**

---

# 阶段 3 记忆注入：代码就绪（待重启验证）

## 难点在哪里

提示词组装是**同步**的，而账本是 **Git 支撑的异步**读写。同步与异步之间必须有个缓存。

再看更难的一处：注入要按「这一轮用户在说什么」选记忆，但 `systemPrompt.context({text})` 拿到的 `AssembleContext` 只有 `{scope, signal}`，**没有用户消息**。

所以设计成三段：

1. `agent/pre-step` 拿到**这一轮进入步骤的消息**（这里才有用户的真实原话），记下来；
2. 账本内容缓存在内存里，快照超过 30 秒才刷新——而且**只在步骤边界刷新**，因为那里可以等；
3. 提示词 provider 是**纯同步函数**，只查快照、绝不碰磁盘。

## 一件不确定的事，处理方式是「都试，并且报告走的是哪条」

`pre-step` 里拿到的 scope 对象，和 `systemPrompt.context` 里拿到的 `context.scope`，**是不是同一个对象**我没法离线证实。

所以运行时同时维护两条路：
- 按对象身份命中 → `path: "scope"`（每个会话各自的查询，最理想）
- 命中不了 → 退回最近一次观测 → `path: "latest"`（可能是别的会话的查询，不理想但不会错到离谱）

`dsh_memory_ping` 会报告 `observed` 和 `path`，重启后一眼就能看出走的是哪条。

## 空账本绝不进入提示词组装

代码写完后我意识到一个风险：`systemPrompt.context` 注册的东西会在**每一次**提示词组装时执行。如果组装抛异常，用户的每一轮都会失败——这正是「保持 DSH 正常启动」绝对不能碰的。

所以改成**惰性注册**：只有账本里确实存在 `active` 记忆时，才在步骤边界注册这个 context。空账本时这个插件完全不参与组装，零风险。

当前账本 `active: 0`，所以重启后注入不会生效——这是设计好的。

## 顺手修的一个设计问题

`apply()` 原本在激活时就刷新账本快照，这会**在插件激活时创建账本目录**（git init）。测试里调用 `apply()` 就会污染真实数据目录。改成只在步骤边界和写操作后刷新，`apply()` 本身不碰磁盘。

## 测试

**113 项通过**（新增 14 项：注入运行时 11 项、接线 3 项）。

## 下一步

重启 → `dsh_memory_ping` 看 `injection.observed` 是什么 → 加一条真实记忆 → 再开一轮会话，看记忆是否真的进了提示词。

---

# 阶段 4.1 提炼规则：只观测，不写入

自动提炼的第一步不是「写」，而是「先看看规则会挑出什么」。

规则很保守，宁可漏也不猜：

| 类型 | 命中的说法 | 基础置信度 |
|---|---|---|
| instruction | 记住、记一下、别忘了、下次记得 | 0.85 |
| decision | 决定、就按、采纳、定为 | 0.75 |
| preference | 我更喜欢、以后都、请用、不要再、别用、尽量 | 0.70 |

三条硬规则：

1. **只用用户原话。** 助手说的话永远不是提炼依据。
2. **问句和假设一律不出候选。** 「以后都用 pnpm 吗？」「如果以后要部署…」都不是承诺。这条踩过一次坑：句子切分把问号去掉了，`吗` 结尾的检查又用了 `\b` 词边界——中文没有词边界，规则形同虚设。测试抓到了。
3. **不确定就降分，不装确定。** 出现「可能/也许/大概」时置信度降 0.15。

现在只在 `agent/pre-step` 里**跑规则并把结果放进状态报告**，一条都不写：

```json
"candidates": 1,
"candidate_sample": [{"type":"instruction","rule":"instruction","confidence":0.85,"text":"记住 pnpm 是包管理器"}]
```

等真实会话跑过几轮，看误报多少，再决定要不要落库。**先看数据，再开写开关。**

新增 11 项测试，**总计 124 项通过**。

---

# 阶段 3 检索质量评估：10 条真实问法，先漏一条

写了 10 条「用户可能怎么问」和它对应的那条记忆，问检索排不排得出来。第一次跑：

**9 条排第一，1 条完全没召回。**

漏掉的是这条：

| | |
|---|---|
| 记忆 | `Windows 下用 pwsh 而不是 bash` |
| 问法 | `命令行用哪个 shell` |

原因很实在：字面上没有任何重叠。「shell」不在记忆里，「命令行」也不在。词法检索看不见同义关系。

这正是路线图里 D4 等着的信号——**同义召回缺口出现了**。但一条缺口不值得换整套向量检索，所以先补一张**很窄的同义词表**（跨中英双向）：shell↔bash/pwsh/命令行、测试↔test、依赖↔deps、提交↔commit、账本↔ledger、提示词↔prompt、记忆↔memory、检索↔retrieval、会话↔session。

补完之后 10 条全部命中，`recall@1` 仍保持在 8/10 以上。表刻意做小：**错的同义词会把不相关的记忆顶上来，比漏一条更糟**。

新增 4 项评估测试，**总计 128 项通过**。

## 这条评估线的价值

它抓住的正是「测试全绿但实际没用」那类问题——检索本身没有任何报错，只是排不出来。以后改权重、改分词，这张表会立刻告诉你有没有变差。
