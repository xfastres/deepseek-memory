# dsh-memory 插件完整技术报告

> 用途：把当前插件的全部事实交给外部评审（GPT）检查。
> 编写原则：只写代码里真实存在的内容；未验证的部分明确标注为未验证；已知缺陷不隐瞒。
> 报告基准：2026-10-28，源码目录 `F:\deepseek-memory\packages\dsh-memory`，`client.js` 共 871 行。

---

## 1. 一句话定位

`@local/dsh-memory` 是 DSH（DeepSeek Harness）Web 界面上的一个本地插件。它提供一个叫 **记忆** 的侧边栏入口和一个 **工作记忆** 主面板，用来：

1. 只读地按时间浏览"今天、跨会话"的真实交互轮次；
2. 从某一条已完成的轮次里，手动记下一条**候选记忆**；
3. 把候选与已有**正式记忆**比较（新增 / 更新 / 无变化 / 需复核），由用户手动接受或拒绝；
4. 接受后生成一条带版本号的正式记忆，保留来源会话与轮次；
5. 导出 / 导入全部记忆数据为 JSON 文件。

**它不是**：自动提炼、检索注入、向量搜索、遗忘回滚。这些都没做。

---

## 2. 运行环境（事实）

| 项 | 值 |
|---|---|
| DSH 版本 | 0.2.1-rc.3 |
| Profile | `desktop` |
| Harness home | `C:\Users\yanghuisong\.dsh` |
| Profile 目录 | `C:\Users\yanghuisong\.dsh\profiles\desktop` |
| Web GUI | `http://127.0.0.1:51840` |
| 插件安装方式 | `"@local/dsh-memory": "link:F:/deepseek-memory/packages/dsh-memory"`（符号链接，改源码后刷新页面即生效，无需重装） |
| 插件版本 | 0.2.0，`private: true`，`type: module`，**零运行时依赖** |
| 语言/时区 | 界面中英双语文案；按浏览器本地时区分日（当前 `Asia/Shanghai`） |

安装状态：Profile 的 `dependencies` 含该 link，`bundles` 列表含 `@local/dsh-memory`；插件已安装并处于 `applied`。

**验证**：通过 `cordis_inspect_query`（Client `Slots.listSubTree`，root=`main`）确认 `main` slot 的 occupants 里有 `{ key: "memory", active: true }`。这证明**面板注册生效**，但不证明用户看到的内容正确（视觉验证另见 §11）。

---

## 3. 原始构想 vs 当前实现范围

用户的原始构想是四层长期记忆 + Git 历史 + 证据链 + 评审纠正 + 检索：

- **L0 对话**：原始会话
- **L1 原子**：从对话提炼的原子记忆
- **L2 场景**：一组原子构成的场景
- **L3 人格**：长期稳定的用户画像

当前实现只覆盖 L0 的**只读视图** + L1 的**手动单条录入**，其余全部未实现。

已确认的核心定义（属于需求基线，不可擅自改动）：

> 工作记忆 = L0 原始来源中，当天、跨会话、按时间排列的交互轮次的只读视图。它不是新的记忆层，不复制原始对话，也不会因为日期变化而删除内容。

其他已确认的需求约束：

- 展示**真实用户输入原文**，时间线和卡片标题**绝不生成 AI 摘要**。
- 时间线单位是**轮次（turn）**，不是单条消息。
- "所有真实发生的轮次都可以浏览，但只有正常完成的轮次，默认可以用于后续记忆提炼。"
- 证据规则：用户表达、项目事实、工作事件都可提炼，但**证据必须与结论匹配**；AI 回复和工具结果可以支撑事实与事件，但不能单独推断用户偏好。

---

## 4. 架构：为什么 Host 是空的

这是本插件最重要的设计决策，也是踩过事故之后的结果。

### 4.1 结构

```
@local/dsh-memory
├── index.js          Host 半边：只有一个空的 apply()，不注册任何服务
├── client.js         Client 半边：全部逻辑与 UI（871 行，单文件）
├── cordis.patch.yml  把插件插入 composition
├── package.json      清单 + dsh.client 元数据
├── locale/zh.json    语言资源（见 §10 已知问题：与 client.js 内联字典重复）
├── locale/en.json
├── icon.svg          侧边栏图标
└── test/client.test.mjs  12 项单元测试
```

- Host 半边 `index.js` 内容为 `export function apply() {}`，**有意为空**。
- Client 半边 `inject: ['slots', 'locale']`，只硬依赖这两个稳定布局服务。
- 会话数据通过**可选的** `ctx.get('sessions')` 获取，并在 `main` 面板渲染时作为 prop 传入。

### 4.2 曾经的事故（必须知道）

早期版本做了自定义 Host 服务 `MemoryConversationService`，用 `bindTypertRemote` 暴露成 `remote.memoryConversation`，Client 端硬 `inject` 了这个命名空间。

结果 **DSH 无法启动**：

```
Error: web boot: 1 entry did not activate
@local/dsh-memory: pending (waiting for service: remote.memoryConversation)
```

崩溃日志位于 `C:\Users\yanghuisong\AppData\Roaming\@deepseek-ai\dsh-desktop\logs\crash-2026-10-28T00-58-*.log`。

根因：本地 bundle 的 `@Remote` 命名空间没有被生成进 Client 的远程映射表，Client 硬 `inject` 一个不存在的服务就会永久 pending，Web boot 直接失败。恢复方式是移除该 bundle 后逐个恢复其他插件。

### 4.3 由此确立的硬约束

1. **不得再引入自定义 Host Remote 命名空间。**
2. **Client 硬 inject 只能包含确定存在的服务**（当前只有 `slots`、`locale`）。
3. 需要 Host 能力时，先验证通道，再改代码；不允许直接假设。

### 4.4 代价（如实说明）

- 记忆数据目前存在**浏览器 localStorage**，不是 Host 运行时库，也不进 Git。
- 换浏览器、清缓存、换机器都会丢，只能靠导出文件搬运。
- 已知 Host 侧**确实存在**正规持久化服务（`storageDomain`，带 zod schema 的 KV，`ctx.get("storageDomain")`），但把它的数据接到 Client 需要新建 Host↔Client 通道（Remote 命名空间 / session command / HTTP route）。**这条通道尚未验证**，所以本轮没有动它。

---

## 5. 数据来源：读取会话用的确切 API

全部来自公开的 Client 服务 `ctx.sessions`（不是自定义 Remote）：

| 调用 | 用途 |
|---|---|
| `sessions.refresh()` | 刷新会话列表 |
| `sessions.list.getSnapshot()` | 得到 `{ ids, byId }` |
| `sessions.retain(sessionId, { source: 'memory-view', signal })` | 获取会话引用 |
| `reference.ready` | 等待事件流就绪 |
| `reference.binding.eventSource.getSnapshot().entries` | 读取当前事件窗口 |
| `reference.binding.session.getSnapshot().hasMore` | 是否还有更早历史 |
| `reference.binding.session.loadOlder()` | 向前加载更早历史 |
| `reference.release()` | 释放引用 |

### 5.1 筛选逻辑

```
今天 = 浏览器本地日期（Intl.DateTimeFormat('en-CA')）
候选会话 = 列表里 origin !== 'subagent'
           且 updatedAt 是今天
           且能读出至少一个「今天开始、且有真实用户输入」的轮次
```

`origin === 'subagent'` 用于排除子代理会话，避免把委派对话混进主时间线。

### 5.2 历史加载

`loadFullHistory()` 会反复 `loadOlder()` 直到 `hasMore === false`，**上限 40 页**，支持 AbortSignal 中断，参考实现缺失时静默返回 0。目的是让长会话里"今天较早的轮次"不因初始窗口太小而漏掉。

### 5.3 事件类型与字段（实际依赖的部分）

| 事件 | 依赖字段 |
|---|---|
| `turn/start` | `data.turn`、`seq`、`time` |
| `turn/end` | `data.reason.kind`（`completed` 才算正常完成） |
| `user/message` | `data.source.kind`（必须 `=== 'user'`）、`data.content[].text` |
| `assistant/message` | `data.message.content[].text` |
| `tool/call` | `data.name` |
| `tool/result` | `data.message.name`、`data.message.content[].text` |

**关键规则**：只有 `source.kind === 'user'` 的用户消息才算真实用户输入。系统注入的时间上下文（`time-context` 等）被明确排除，不会被误当成用户发言。

---

## 6. 数据模型

### 6.1 内存中的轮次（turn，派生，不落盘）

```js
{
  id: "sessionId:turnNumber",
  session_id, turn,
  range: [start_seq, end_seq],
  started_at, status,            // completed | closed_incomplete | in_progress
  messages: [ ...本轮消息 ],      // 见 6.2
  text, truncated, source_refs   // 用户原文预览，source_refs = [{session_id, event_seq}]
}
```

### 6.2 本轮消息

```js
{ id, role: "you" | "assistant", time, text }
{ id, role: "tools", items: [{ id, role: "tool", time, name, text }] }
```

连续的工具调用/结果会**合并成一组**，在 UI 中用 `<details>` **默认折叠**。

### 6.3 候选记忆（candidate，存 localStorage）

```js
{
  id: "<时间戳>-<随机>",
  text: "用户手写的记忆内容",      // 必须非空，≤2000 字
  status: "candidate",
  created_at: ISO8601,
  source: { session_id, turn, event_seq }
}
```

约束：只有 `status === 'completed'` 的轮次才能创建候选；最多保留 200 条。

### 6.4 正式记忆（memory，存 localStorage）

```js
{
  id: "memory-<candidateId>",   // 更新时沿用同一条 id
  version: 1,                    // 每次接受更新 +1
  status: "active" | "superseded",
  content: "记忆正文",
  source: { session_id, turn, event_seq },
  accepted_at: ISO8601,
  previous_version: 1            // 仅更新产生的新版本带此字段
}
```

**不变量**：同一条 `id` 最多只有一个 `status === 'active'` 的版本。

版本历史：升版时旧记录不删除，只把 `status` 改为 `superseded`，正文原样保留。界面上每条正式记忆可以展开"历史版本（N）"查看所有被取代的版本。

两种产生新版本的途径：

1. **从候选接受**（`reviewCandidate`）：内容默认取候选文本，也可以传入编辑后的内容。
2. **直接编辑正式记忆**（`editMemory`）：接受之后仍可修改，同样生成新版本，旧版本进入历史。

### 6.5 导出文件格式

```json
{
  "format": "dsh-memory/v1",
  "exported_at": "ISO8601",
  "candidates": [ ... ],
  "memories": [ ... ]
}
```

导入时会校验 `format`，按 `id@version` 去重，并把同一 id 的多个 active 版本收敛为最新一个（其余置为 `superseded`）。

### 6.6 localStorage 键

```
dsh-memory.candidates.v1
dsh-memory.formal.v1
```

---

## 7. 交互流程

```
侧边栏「记忆」
   ↓
工作记忆页
   ├─ 顶部工具条：导出 / 导入 / 刷新
   ├─ 正式记忆（可折叠，Markdown 渲染，带 vN）
   ├─ 候选记忆（可折叠，逐条显示比较结果）
   └─ 今日时间线（按时间倒序的轮次卡片）
          ↓ 点击卡片
      轮次详情页
         ├─ 返回
         ├─ 头部：第 N 轮 + 状态 + 会话 ID
         └─ 轮次框（.dm-turn-box）
              ├─ 右上角「记下这一轮」（仅 completed 可见）
              ├─ 点击后原地展开 textarea → 保存候选
              └─ 本轮消息列表（你 / AI 文本 + 折叠的工具组）
```

### 7.1 候选的比较与处置

每条候选显示一个结果标签和"变更前/变更后"：

| 结果 | 含义 | 接受按钮 |
|---|---|---|
| `ADD` | 没有对应正式记忆 | 可用 → 新建 v1 |
| `UPDATE` | 命中唯一一条相关正式记忆 | 可用 → 该记忆升版，旧版置 superseded |
| `NO_CHANGE` | 内容完全相同 | 禁用 |
| `REVIEW` | 命中多条，需人工判断 | 禁用（除非手动选择合并目标） |

**手动合并**：每条候选有「合并到」下拉框，列出所有 active 正式记忆。选中某条后：

1. 比较结果强制按 `UPDATE` 处理到该条（即使自动结果是 ADD）；
2. 出现一个**可编辑的「合并后内容」**文本框，默认值为 `原内容 + 空行 + 候选文本`（若原文已包含候选文本则不重复追加）；
3. 接受时写入的是这个文本框里的内容，原内容作为旧版本保留在「历史版本」里。

**接受后编辑**：正式记忆卡片上有「编辑」，保存后生成新版本，旧版本进历史。版本不一致时拒绝写入并提示"正式记忆已变化，请重新比较"。

**接受/拒绝后候选立即从列表移除**（`splice`），不会残留。拒绝不产生任何正式记忆。

**版本冲突保护**：`UPDATE` 会校验 `current.version === decision.base_version`，不一致则抛 `stale`，拒绝写入。这是为将来多人/多端同时修改预留的乐观锁。

---

## 8. 比较算法（当前是启发式，不是语义匹配）

```js
normalize(v)  = v.toLocaleLowerCase().replace(/\s+/g, ' ').trim()

grams(v):
  compact = normalize(v) 去掉所有空格
  pieces  = { 长度>1 的英文单词 } ∪ { compact 的所有相邻二字切分 }
  return pieces

related(a, b):
  return |grams(a) ∩ grams(b)| >= 2
```

- 中文靠**二字组（bigram）**匹配，不依赖空格分词，所以无空格的中文句子也能比较。
- 判定阈值是"共享至少 2 个片段"。
- `compareCandidate` 先查完全相同 → `NO_CHANGE`；再查相关集合：1 条 → `UPDATE`，多条 → `REVIEW`，0 条 → `ADD`。

**这是刻意保守的**：宁可判成"新增/需复核"，也不自动覆盖已有正式记忆。

---

## 9. 安全与边界

| 方面 | 做法 |
|---|---|
| 会话文件 | **只读**。不写、不复制、不改 DSH Session 日志；它是唯一权威来源 |
| 自定义 Remote | **零**。没有 Host 服务，没有 Remote 命名空间 |
| Client 硬依赖 | 只有 `slots`、`locale` 两个必定存在的布局服务 |
| HTML 注入 | 所有会话文本先 `escapeHtml`（`& < > " '`）再套 Markdown 标记 |
| 链接 | 只允许 `http:` / `https:` / `mailto:`；其它（如 `javascript:`）原样转义为纯文本；外链带 `target="_blank" rel="noreferrer"` |
| AI 摘要 | 时间线/卡片标题从不生成摘要，只显示原文 |
| 工具结果 | 默认折叠，需主动展开 |
| 样式 | 只用 `--dsw-alias-*` 主题 token，无硬编码颜色，不导入 Host 的 primitives 包 |
| 数据落点 | 仅浏览器 localStorage；用户可显式导出 |

---

## 10. 已知缺陷（我自己发现的，供评审重点检查）

### 10.1 功能性 bug（阶段 1 已修复，代码与纯函数级验证）

1. ~~**`NO_CHANGE` / `REVIEW` 候选选了合并目标后，接受按钮仍是禁用状态。**~~
   **已修复**：合并目标改为 `MemoryPage` 的受控 state（`targets` 映射），选择会触发重渲染；"是否可接受 / 按哪个版本更新"抽成纯函数 `reviewView()`，可单元测试。

2. ~~**"已保存为候选"提示永远看不到。**~~
   **已修复**：保存成功的提示上移到 `MemoryPage` 的 `notice`；`CandidateForm` 只保留表单内的错误提示。

3. ~~**`mergeTarget` 会在任何其他操作后丢失。**~~
   **已修复**：不再把 UI 状态挂在数据对象上；接受/拒绝后主动清掉该候选的目标选择。

4. **版本冲突保护此前是死代码**（阶段 1 一并修复）。
   原实现里 `base_version` 与写入前读到的版本必然一致，`stale` 永远触发不了。
   现在 `reviewCandidate` 接受显式的 `expectedBaseVersion`（由界面渲染时的 `reviewView` 计算），版本不一致会抛 `stale`，界面显示"正式记忆已变化，请重新比较"。该路径已有测试覆盖。

5. ~~**"合并"实际是整条覆盖。**~~
   原实现接受合并时，新版本正文只取候选文本，原记忆内容在界面里直接消失（数据里仍以 superseded 保留，但界面不显示）。
   **已修复**：合并改为"拼接 + 接受前可编辑"，并新增"历史版本"与"接受后编辑"。

### 10.2 一致性问题

4. **`locale/zh.json`、`locale/en.json` 与 `client.js` 内联字典重复**，且 JSON 只含少量键。运行时用的是内联字典，JSON 文件实际未参与渲染，但仍在 `package.json` 的 `exports` 和 `files` 里，属于两个真相源。

5. **`package.json` 的 `description` 仍写 "read-only"**，而现在插件会写候选和正式记忆（虽然是本地）。

6. **`client.js` 里有未使用的 CSS 与文案键**：`.dm-preview`、`.dm-source`、`.dm-message-tool`、`.dm-status-in_progress`（无样式），以及 `nothingToExport`、`compare`、`accepted`、`rejected`、`stale` 等 i18n 键。

7. **`package.json` 未声明 Config**，所有参数（候选上限 200、历史上限 40 页、预览 320 字、二字组阈值 2）都硬编码在代码里，用户无法通过 `cordis.patch.yml` 调整。

### 10.3 性能/规模

8. 会话是**串行**逐个 retain + 读事件，今天会话很多时会慢，没有并发或进度提示。
9. localStorage 约 5MB 上限，当前无容量检查。
10. `loadFullHistory` 最多 40 页，超长会话仍可能读不全，且没有"还有更多"的提示。

### 10.4 未做的能力（相对四层构想）

11. 没有自动提炼（只能手动"记下这一轮"）。
12. 没有检索，也没有把记忆注入新对话。
13. 没有 L2 场景、L3 人格。
14. 没有向量/语义搜索。
15. 没有遗忘、撤回、回滚、删除正式记忆的入口。
16. 没有 Git 提交，没有运行时数据库。
17. 没有"清除全部数据"入口。

---

## 11. 验证状态（严格区分已测 / 未测）

### 已执行并通过

| 项目 | 结果 |
|---|---|
| `node --check packages/dsh-memory/client.js` | 通过 |
| `node --test packages/dsh-memory/test/client.test.mjs` | **15 / 15 通过** |
| `packages/l0-conversation`（`turns.test.js` + `today.test.js`） | **7 / 7 通过** |
| `packages/provider-git-ledger`（ledger + adapter + hardening） | **31 / 31 通过**（含真实 git 仓库往返，约 39 秒） |
| 面板注册 | `Slots.listSubTree(root=main)` 显示 `key: "memory", active: true` |
| 用户手工验收（本报告编写前） | 用户明确回复"这些测试都正常"，覆盖：启动/入口、今日时间线、格式、完整会话、候选、只读边界、异常状态、外观 |

### 15 项单元测试分别覆盖

1. 硬依赖只有 `slots`/`locale`，且不依赖任何 `remote.*`；注册了 `sidebar.panellist` 与 `main` 两个面板。
2. 工具调用被分成独立分组，注入的上下文（`time-context`）被排除。
3. Markdown 渲染安全：`<script>` 被转义；标题/加粗/代码块、链接、引用、表格正确；`javascript:` 链接不生成 `<a>`。
4. 只有已完成轮次才能创建候选；未完成轮次抛错。
5. 接受 `ADD`：生成 v1、候选移除、写入 localStorage。
6. 接受 `UPDATE`：沿用原 memory id 升到 v2、旧版置 superseded、`previous_version` 正确、候选移除。
7. 拒绝：候选移除、正式记忆字节不变。
8. 手动合并：即使自动结果是 `ADD`，指定目标后该目标升版为 v2，全局只保留 1 条 active。
9. 版本冲突：`expectedBaseVersion` 过期时抛 `stale`，且不写入任何内容。
10. `reviewView`：`NO_CHANGE` 无目标→不可接受；选目标→可接受且 base 取目标版本；`ADD`→可接受无 base；`UPDATE`→base 取当前版本。
11. 历史分页：`hasMore` 变 false 时停止；引用对象缺 `session` 方法时安全返回 0。
12. 导出/导入往返：去重、active 唯一、错误格式抛错。
13. `mergeDraft`：拼接时保留原文、任一侧为空时的退化、原文已包含新内容时不重复追加。
14. 合并接受：默认拼接为"原内容 + 新内容"，升到 v2，原文作为 superseded 记录留在历史里。
15. 接受后编辑：生成 v2、旧版进历史；过期版本抛 `stale`；空内容抛 `empty`；localStorage 仍只有 1 条 active。

### 额外的真实文件往返验证（阶段 1）

用 Node 直接调用插件导出的纯函数，把 `exportMemory()` 的结果写进系统临时目录的真实 `.json` 文件（676 字节），再读回来 `importMemory()`：

- `format` 为 `dsh-memory/v1`
- 导入 2 条记忆（含 1 条 superseded）+ 1 条候选
- active 收敛为 1 条
- Markdown 内容原样保留（`# 偏好\n\n- 简洁回答\n- 中文`）
- 重复导入新增 0 条（幂等）

### 未验证（必须承认）

- **没有浏览器自动化控制**（Playwright MCP 不可用），所有 UI 都是通过代码 + 用户截图 + 用户口头验收确认的，没有截图级回归。
- **`loadFullHistory` 只在假对象上测过**，没有在真实超长会话上确认时间线是否真的变全。
- **导出/导入只测了纯函数**，没有在真实浏览器里点过下载和文件选择。
- §10.1 的三个 bug 已在代码与纯函数层面修复并测过，但**仍未在真实界面点击确认**。
- 尝试用 HTTP 直接抓取客户端 bundle 以证明"新代码已送达浏览器"时返回 **401 未授权**，因此无法从命令行证实浏览器端加载的字节与磁盘一致；只能确认插件是 `link:` 安装，刷新页面即从磁盘重新读取。
- **未在真实"多会话、长时间使用"场景下压测过性能**。
- 未做浅色主题的显式回归（token 理论上自适应）。

---

## 12. 相关但尚未接入的包

同一仓库里还有两个与后续阶段相关、但**当前插件完全没有引用**的包：

### `packages/provider-git-ledger`（`dsh-mnemon-provider-git-ledger` 0.0.1-alpha.0）

- 定位：给 `dsh-mnemon-source-memory-spaces` 0.5.19 用的 Git 后端 Memory Spaces Provider（phase 1 只做 L1 原子）。
- 能力：带证据的 memory 记录、变更提案（ADD/UPDATE/RETRACT/SUPERSEDE）、乐观并发（`expected_base_change_id`）、Git 提交、投影索引重建。
- schema 里已有完整模型：`memory_id`、`layer`、`type`（fact/preference/constraint/decision/goal/event/open_loop/hypothesis）、`status`（active/superseded/retracted）、`source_kind`、`confidence`、`source_refs`、`valid_from/to`、`supersedes_id`。
- **当前状态：31 项测试通过，但没有安装进 profile，也没有被 dsh-memory 调用。**

### `packages/l0-conversation`

- 定位：纯函数版的 L0 轮次投影（`projectTurns` / `completedTurns` / `groupTurnsByDate` / `userFacingTurns` / `turnMessages`），外加 `scripts/verify-live.mjs`（只读真实 Session 验证）与 `scripts/session-file-digests.mjs`（前后哈希，证明没改会话文件）。
- **当前状态：7 项测试通过；其 `src/today.js` 依赖 Host `sessionQuery`，已被 Client 版 `readToday` 取代，未安装。**

两包与被安装插件之间目前**没有依赖关系**，也不在 `package.json` 的 `files`/`exports` 里。

---

## 13. 如果要继续做，下一步的选项与风险

| 选项 | 内容 | 风险 |
|---|---|---|
| A | 把候选/正式记忆迁到 Host `storageDomain` + Git 提交 | **高**：需要新建 Host↔Client 通道；一旦通道假设错误会重复 §4.2 的启动失败 |
| B | 修 §10.1 三个 bug（按钮禁用、提示不可见、合并目标丢失） | **已完成（阶段 1）** |
| C | 检索与注入（把相关记忆送进新对话的 prompt） | 中，需要 Host 侧 `systemPrompt.section()` 或 `agent.inject()` |
| D | 自动提炼 | 中高，涉及模型调用与证据校验 |
| E | L2/L3 层 | 高，需要先定义场景与人格的结构 |

**建议顺序**：B → A（先验证通道）→ C → D → E。

---

## 14. 给评审者的具体问题

1. §8 的 bigram 启发式是否会在真实使用中产生大量误判 `UPDATE`？阈值 2 是否合理？
2. §6.4 的"同 id 多版本、仅一个 active"模型，是否足够支撑将来的 Git 提交与冲突解决？
3. §4 的"Host 空壳 + 纯 Client"架构，在功能继续增长（检索、自动提炼）后是否必然要推翻？如果是，什么时候切换最划算？
4. 候选列表已改为"受控 targets + 纯函数 reviewView"，是否还需要进一步收敛成 reducer？
5. localStorage 作为现阶段存储，是否需要先加容量与数据校验，再考虑迁移？
6. 现在的"手动接受才写入"的流程，是否符合"证据必须与结论匹配"的原始需求？

---

## 15. 术语表

| 术语 | 含义 |
|---|---|
| L0 / L1 / L2 / L3 | 对话 / 原子记忆 / 场景 / 人格，四层记忆构想 |
| Turn（轮次） | 一次 `turn/start` 到 `turn/end` 之间的完整交互单元 |
| Candidate（候选） | 用户手写、尚未成为正式记忆的条目 |
| Formal memory（正式记忆） | 被用户接受、带版本号与来源的记忆 |
| `source_refs` | 指回 DSH Session 的指针（session_id + event_seq），不是原文副本 |
| 工作记忆 | 今天的跨会话只读轮次视图，不是新的记忆层 |
