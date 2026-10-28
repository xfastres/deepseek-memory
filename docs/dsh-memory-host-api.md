# dsh-memory Host API 设计（阶段 2.3）

> 状态：设计，未实施。依据 [dsh-memory-roadmap-v2.md](dsh-memory-roadmap-v2.md) §8 阶段 2。
> 本文回答四件事：数据放哪、Host 暴露什么接口、失败怎么处理、旧数据怎么迁。

---

## 1. 通道与安全

### 1.1 采用的做法

| 层 | 做法 | 依据 |
|---|---|---|
| 传输 | DSH 自带 web server + 插件注册的 HTTP 路由（`ctx.webServer.register`） | 任务板插件在本机已验证可用 |
| 前端调用 | 页面同源 `fetch('/api/dsh-memory/...')` | 浏览器自动携带认证 Cookie |
| 拒绝 | 不用自定义 Remote 命名空间 | Remote 曾导致 `web boot: 1 entry did not activate`，是明确禁区 |

### 1.2 请求围栏

读接口（`GET`）：

1. socket 地址必须是回环（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`）；
2. `Host` 头必须是回环主机名；
3. `sec-fetch-site` 不得为 `cross-site`；
4. 若带 `Origin`，其 host 必须等于 `Host`。

写接口（`POST`）在上面四条之外**再加一条**：必须存在浏览器同源标记 —— `sec-fetch-site: same-origin`、或带 `Origin`、或携带 DSH 的浏览器认证 Cookie。裸 `curl` 即使来自本机也写不进去。

理由：读接口泄露的是“本机已存在的记忆”，风险有限；写接口能篡改记忆，必须要求浏览器来源。任务板对它的控制面用的就是同样的分层。

---

## 2. 数据放在哪（决策 D2 定稿）

### 2.1 结论

**不用 `storageDomain`，改用插件自有目录 `~/.dsh/dsh-memory/`。**

```
~/.dsh/dsh-memory/
  ledger/           Git 仓库：正式记忆（L1/L2/L3），一条变更一个提交
  index.sqlite      可重建的 FTS5 检索投影（trigram + bm25）
  runtime.sqlite    候选队列、设置、注入记录（不进 Git）
  .ledger-lock      仓库锁
```

### 2.2 为什么不用 `storageDomain`

| 考量 | `storageDomain` | 插件自有目录 |
|---|---|---|
| 依赖 | 要求 `valueSchema` 为 zod 对象；**本插件目录下 `zod` 不可解析**（已核实） | 零依赖 |
| 数据模型 | `KvTable` 只有 get/entries/keys/put/delete/update | 可用 SQLite 建索引、排序、事务 |
| 候选队列需要 | 按会话查、按时间排序、按状态筛 | KV 只能整表遍历 |
| 本机先例 | 只有 DSH 自己的缓存用它（`session_projcache`） | 任务板用 `~/.dsh/task-board/` + JSON + lock 文件 |

`storageDomain` 的优点是官方、有 schema 校验、能统一备份；但它解决的是“小配置项”的问题，而我们的核心需求是可查询的队列和索引。

**重新评估条件**：如果以后 DSH 提供“统一数据目录 + 导出备份”且只需要存设置，可以把 `runtime.sqlite` 里的设置表迁过去。

### 2.3 索引可用性有前置条件

`index.sqlite` 用 `node:sqlite`。已核实：系统 Node 24 上 `sqlite = ok`、`fts5 = ok`、`trigram = ok`。
**但 DSH 跑在 Electron 44 里，其 Node 是否同样支持未经实测**。

因此 `GET /api/dsh-memory/ping` 会返回：

```json
{ "ok": true, "runtime": { "node": "24.16.0", "electron": "44.7.0",
  "sqlite": { "ok": true, "fts5": true, "trigram": true, "error": null } } }
```

**降级方案**（探测结果为否时）：

- `runtime.sqlite` → `runtime.json` + 追加日志 + 原子改名（照抄任务板的做法）；
- `index.sqlite` → 启动时把 Git 账本读进内存建倒排索引（慢但正确，反正可重建）。

---

## 3. 接口清单

所有响应统一 `{ ok: true, ...data }` 或 `{ ok: false, error: "<机器可读原因>" }`。
所有写接口要求 `content-type: application/json`，请求体上限 2 MB。

### 3.1 读

| 方法与路径 | 作用 | 响应要点 |
|---|---|---|
| `GET /ping` | 存活与运行时能力探测 | `runtime`（见 §2.3） |
| `GET /state` | 一次性取全部界面状态 | `revision`、`memories`、`candidates`、`settings`、`ledger`（提交数、最后提交时间） |
| `GET /export` | 导出完整数据 | 与现有 `dsh-memory/v1` 格式兼容，附加 `ledger_commit` |

`revision` 是单调递增整数：界面每次改完都带回，用于发现“别处也改过”。

### 3.2 写

| 方法与路径 | 请求 | 语义 |
|---|---|---|
| `POST /candidates` | `{ text, source:{session_id,turn,event_seqs} }` | 新增候选；证据字段必填 |
| `POST /review` | `{ candidateId, action:'accept'\|'reject', targetId?, expectedBaseVersion?, content? }` | 接受/拒绝/合并；`content` 是编辑后的正文 |
| `POST /edit` | `{ memoryId, content, expectedVersion }` | 直接编辑正式记忆，生成新版本 |
| `POST /settings` | `{ ...partial }` | 更新设置（注入开关、预算等） |
| `POST /import` | 导出格式的 JSON | 一次性迁移旧 localStorage 数据 |

### 3.3 错误码

| `error` | HTTP | 含义 | 界面表现 |
|---|---|---|---|
| `stale` | 409 | 基线版本已过期 | “正式记忆已变化，请重新比较” |
| `missing` | 404 | 候选或记忆不存在 | “这条记录已不存在” |
| `empty` | 400 | 正文为空 | 表单内提示 |
| `no-evidence` | 422 | 证据不满足 §4.2 规则 | 说明缺哪类证据 |
| `ledger-not-ready` | 503 | 账本未初始化完成 | “记忆库正在初始化” |
| `forbidden` | 403 | 围栏拒绝 | “请求来源不被接受” |

---

## 4. 失败处理契约

1. **每个 handler 都被 try/catch 包住**，异常一律转成 `{ ok:false }` JSON，绝不外抛。
2. **Host 半边注册失败不影响启动**：与阶段 2.1 相同，全部 try/catch。
3. **界面必须能在 Host 不可用时工作**：进入“本地模式”——继续用现有 localStorage 逻辑读写，顶部显示一条说明“当前为本地模式，数据未写入记忆库”。这样任何一步出错都不会让页面变砖。
4. **写操作先写日志再应答**：`POST /review` 先追加 intent 到运行时库，再动 Git，再提交；中途失败能在下次启动时看出未完成的意图。
5. **不做静默重试**：冲突（`stale`）交给用户决定。

---

## 5. 旧数据迁移

沿用任务板的做法，用导入标记保证只迁一次：

```
localStorage["dsh-memory.migrated"] = "<ledgerId>"
```

流程：

1. 读取本地 `dsh-memory.candidates.v1`、`dsh-memory.formal.v1`；
2. 若标记等于当前账本 id，跳过；
3. 否则调用 `POST /import`，Host 端逐条校验后写入，返回 `{ imported, skipped }`；
4. 成功后写标记，**不删除**本地数据（保留为只读备份，直到用户手动清理）。

Host 端幂等：同一 `id@version` 重复导入不重复写入。

---

## 6. 实施顺序（2.4 / 2.5）

| 步骤 | 内容 | 验收 |
|---|---|---|
| 2.4a | Host 内接入 `provider-git-ledger`：初始化 `~/.dsh/dsh-memory/ledger`，实现 `GET /state`（只读） | 页面显示的记忆与 localStorage 一致；账本目录生成且有提交 |
| 2.4b | 把 `/review`、`/edit` 接上，界面写操作改走 HTTP | 每次接受产生一个 Git 提交；原有 15 项行为测试改为针对 Host 逻辑后全部通过 |
| 2.4c | 本地模式与 Host 模式的切换 | 故意停掉路由，页面仍可读写本地，且提示清晰 |
| 2.5 | 一次性迁移 | 迁移前后条目、版本、历史一致；重复刷新不重复导入 |

每个子步骤都先跑一次“最小实验”再改正式代码。

---

## 7. 待验证清单

| 编号 | 问题 | 何时能答 |
|---|---|---|
| Q1 | DSH 的 Electron 运行时里 `node:sqlite` 是否可用、FTS5 是否带 trigram | 重启后点「测试 Host 连接」 |
| Q2 | 页面同源 fetch 能否通过 DSH 认证层 | 同上 |
| Q3 | `webServer.register` 的真实路由形状是否与任务板一致 | 同上（404 / 403 / 200 三者必居其一） |
| Q4 | 插件能否从 `~/.dsh` 之外的路径访问数据目录（沙箱限制） | 2.4a |
| Q5 | Host 到会话日志的读取权限（阶段 3 需要） | 阶段 3.1 |
