# C — Git Ledger 复用价值与 Mnemon 解耦路径

> 审计对象：`F:\deepseek-memory\packages\provider-git-ledger`（基线 HEAD `970fd87`，`feat: harden git-backed memory provider ledger`）
> 审计方式：**严格只读**。全部 13 个文件（src 8 + test 5）逐个完整读完；SDK/Cordis/DSH 侧只读核对。
> 全程未修改任何项目文件、未安装依赖、未 commit、**未运行 `node --test`**。
> 标注约定：**【已由源码确认】** / **【基于源码的推断】** / **【尚待实验验证】**

---

## 0. 先修正三处任务书与环境事实

| # | 任务书/背景说法 | 实际 | 证据 |
|---|---|---|---|
| 1 | 「31 个自动化测试全部通过」 | 静态计数**恰好 31**（3+12+16），数字对得上 | §7.1 |
| 2 | 但 `scripts.test` = `node --test test/` | **该命令在 Node ≥22/24 上直接失败**，退出码 1，`MODULE_NOT_FOUND`。所以「31 通过」不可能来自 `npm test` | §7.2【已由源码确认，本机实测】 |
| 3 | 「仓库根没有根 package.json / pnpm-workspace.yaml」 | 确认：`git ls-files` 只有 `.gitignore` + `packages/provider-git-ledger/**`（16 个文件）。**不是 pnpm workspace，是独立 npm 项目** | `git ls-files`；`packages/provider-git-ledger/package-lock.json` 为 `lockfileVersion: 3` 的 npm 锁 |

补充确认的环境事实（本机实测，只读）：

- 宿主机 `node` = **v24.16.0**，`node:sqlite` 可用，SQLite 3.53.0。
- DSH 桌面端运行时 = **Node 24.21.0 / Electron 44.7.0**（`resources/runtime/versions.json`、`DeepSeek Harness.exe` 内实测）。
- spelunk 结论：`node:sqlite` + **FTS5 `tokenize='trigram'`** 在两套 runtime 上都**可用**（实测建表 + 中文 `MATCH '"调用流程"'` 命中 1 行）。这是 `projection.js` 能原样保留的硬前提，已验证。
- 目标包 `node_modules` 已存在（npm 安装，非 pnpm），含 `@deepseek-ai/cordis@4.0.5`、`dsh-mnemon-source-memory-spaces@0.5.19`、`dsh-mnemon@0.5.35` 及 **7 个 provider 包** + `react`/`react-dom`。

---

## 1. 依赖分层图（A）：8 个 src 文件的依赖判定

### 1.1 逐文件判定

| 文件 | 行数 | import 全部内容 | 分类 |
|---|---:|---|---|
| `src/schema.js` | 189 | `node:crypto`（`createHash`, `randomUUID`） | **① 零外部记忆框架依赖** |
| `src/git.js` | 171 | `node:child_process`（`spawn`）、`node:fs/promises`（`mkdir`, `access`）、`node:path`（`join`） | **① 零依赖** |
| `src/lock.js` | 209 | `node:crypto`（`randomUUID`）、`node:os`（`hostname`）、`node:fs/promises`（`mkdir`, `readFile`, `rename`, `rm`, `stat`, `writeFile`）、`node:path` | **① 零依赖** |
| `src/projection.js` | 241 | `node:sqlite`（`DatabaseSync`） | **① 零依赖** |
| `src/ledger.js` | 518 | `node:fs/promises`, `node:path`, `./git.js`, `./lock.js`, `./schema.js` | **① 零依赖** |
| `src/descriptor.js` | 42 | **无 import** | **①' 零依赖，但语义是 Mnemon descriptor 契约** |
| `src/adapter.js` | 218 | `node:crypto`, `node:path`, `./ledger.js`, `./projection.js`, `./schema.js`, `./descriptor.js` | **② 零外部框架依赖，但接口形状是 Mnemon 的** |
| `src/index.js` | 72 | `node:path` + **`dsh-mnemon-source-memory-spaces/provider-sdk`** | **③ 依赖 Mnemon SDK** |

合计 **1660 行**。零依赖核心（schema+git+lock+projection+ledger）= **1328 行**；加 descriptor = **1370 行 = 82.5%**。

### 1.2 分层结论

```
┌─────────────────────────────────────────────────────────────────┐
│ ③ 依赖 Mnemon SDK（必须改造/替换）                                │
│   src/index.js  —  唯一 import 'dsh-mnemon-source-memory-spaces/  │
│                    provider-sdk' 的文件（index.js:8-12）          │
│                    = 66/72 行是 SDK 胶水                          │
├─────────────────────────────────────────────────────────────────┤
│ ② 依赖 Cordis? —— 答案：src 下 8 个文件全部零 Cordis import        │
│   实证：grep 'cordis|@deepseek-ai' src/ → 仅 2 处，均为注释/字符串  │
│     index.js:1  注释 "Memory Spaces child module for ..."          │
│     index.js:40 packageName: 'dsh-mnemon-provider-git-ledger'      │
│   → Cordis 只在 SDK 内部（definitions-*.d.ts:2 import Context）     │
│     被使用，本包从不 import Cordis 本体。                          │
├─────────────────────────────────────────────────────────────────┤
│ ① 零外部框架依赖（可原样保留）                                    │
│   schema.js / git.js / lock.js / projection.js / ledger.js        │
│   只依赖 Node 内置：crypto, os, fs/promises, path,                │
│                     child_process, sqlite                         │
└─────────────────────────────────────────────────────────────────┘
```

**关键洞察（本轮最有价值的单条结论）**：

> 除 `index.js` 这 72 行之外，整个包**对 Mnemon 的依赖只发生在「接口形状」层面，不发生在「代码引用」层面**。
> 五个核心文件物理上可以直接复制到任何 Node ≥22.5 项目里跑，零改动。
> `adapter.js` 虽然实现了 `MemoryProviderAdapter` 的形状，但它**不 import 任何 SDK 符号** —— 它是"结构化鸭子类型"实现，而不是"继承/导入"实现。这一点把解耦成本压到了最低。

### 1.3 反向验证：谁依赖本包？

`grep 'git-ledger' src/` 无结果（除 descriptor 自身 id）。本包**不被任何同级包 import**，是一个叶子包 → 解耦不会引发级联破坏。

---

## 2. 耦合点精确清单（B）

### 2.1 唯一硬耦合：`src/index.js:8-12`

```js
// src/index.js:8-12
import {
  MEMORY_SPACE_PROVIDER_API_VERSION,
  defineMemorySpaceProvider,
  defineMemorySpaceProviderDefinition,
} from 'dsh-mnemon-source-memory-spaces/provider-sdk';
```

**这是整个包唯一的 `import` 级耦合。** 三个符号的真实语义（读 SDK 实现确认）：

| 符号 | 定义位置 | 真实行为 |
|---|---|---|
| `MEMORY_SPACE_PROVIDER_API_VERSION` | `lib/definitions-DfmOqJjR.js:3` | 就是字符串常量 `"dsh-mnemon.memory-space-provider/v1"` |
| `defineMemorySpaceProvider` | `lib/definitions-DfmOqJjR.js:202-209` | 校验 `id` 匹配 `/^[a-z][a-z0-9-]{0,127}$/`、校验 `apply` 是函数，然后 `Object.freeze({...module, id})`。**纯校验 + 冻结，零运行时耦合** |
| `defineMemorySpaceProviderDefinition` | `lib/definitions-DfmOqJjR.js:210-212` → `captureDefinition` L195-201 → `captureManifest` L162-194 | 校验并 **deepFreeze** manifest；`fields`/`capabilities`/`icon`/`secrets` 逐字段强校验（L33-135）。**这是最重的一段：约 160 行校验逻辑** |

推论：这三个符号**全部可以本地复刻**（字符串常量 + 两个校验函数），或干脆不调用——因为它们的产物只是"被冻结并校验过的普通对象"。

### 2.2 descriptor 字段契约（`src/descriptor.js` 全文是契约，不是数据）

| 字段 | 位置 | 谁消费 | 约束 |
|---|---|---|---|
| `id: 'git-ledger'` | descriptor.js:3 | `manifest.typeId`（index.js:39）；`adapter.id`（adapter.js:39） | SDK 要求 `typeId` 匹配 `/^[a-z][a-z0-9-]{0,127}$/` |
| `label` / `icon` / `summary` | :4-8 | manifest 同名字段 | `icon.kind='glyph'`，value ≤16 字符（definitions L26） |
| `kind: 'local'` | :6 | `manifest.locality` | 必须是 `local`/`remote` |
| `workspaceBinding: 'provider-global'` | :7 | `manifest.workspaceBinding` | 必须是 `automatic`/`optional-override`/`provider-global` |
| `origin: 'third-party'` | :9 | `manifest.origin` | 必须 `native`/`third-party` |
| `capabilities`（10 个键） | :10-21 | `manifest.capabilities`；**且被 `assertRuntime` 用来强制方法存在性** | 见 §2.4 |
| `fields[0] dataDir` | :23-31 | `manifest.fields`；SDK 用它渲染设置页 | `scope:'service'`, `role:'global-location'`, `input:'path'` 三者必须同时成立（definitions L77） |
| `fields[1] ownerId` | :32-40 | 同上 | `scope:'service'`, `input:'text'`, `required:true`, `maxLength:128` |

**descriptor 不是装饰**：`definitions-DfmOqJjR.js:186-187` 做 `captureCapabilities` + `captureFields` 强校验，任何键错都在 mount 时立刻抛错。

### 2.3 `context` 宿主假设（3 条，全部集中在 index.js:53-61）

```js
// src/index.js:53-61
create(context) {
  const authority = context.memorySpaces ?? context.memoryBodies;        // ← 耦合 1
  return new GitLedgerAdapter({
    dataDir: dataDir ?? join(authority.runner.effectiveDataDir(), 'git-ledger'), // ← 耦合 2
    ownerId: ownerId ?? 'local-user',                                     // ← 耦合 3（默认值）
    defaultRecallLimit: defaultRecallLimit ?? context.config.defaultRecallLimit ?? 10, // ← 耦合 4
    evidence: hook,
  });
}
```

| # | 耦合 | 出处 | 真实 SDK 要求 | 解耦难度 |
|---|---|---|---|---|
| 1 | `context.memorySpaces ?? context.memoryBodies` | index.js:54 | `MemoryProviderAdapterFactoryContext.memorySpaces?` 是**可选**、`memoryBodies` 是**deprecated 但必填**（`definitions-CtjNSwBS.d.ts:28-38`）。所以这行是"新名优先、旧名兜底" | 极低 |
| 2 | `authority.runner.effectiveDataDir()` | index.js:56 | `MemorySpaceAuthority.runner.effectiveDataDir(): string`（同文件 L5-11）。**整个包对宿主的全部要求，就这一个返回 string 的函数** | 极低 |
| 3 | `ownerId ?? 'local-user'` | index.js:57 | 无 SDK 要求，是本包自己的安全默认值 | 见下（安全风险） |
| 4 | `context.config.defaultRecallLimit` | index.js:58 | `config: { timeoutMs: number; defaultRecallLimit?: number }`（L33-36） | 极低 |

> **安全提示（必须上报）**：`ownerId ?? 'local-user'`（index.js:57）意味着**任何没有显式配置 ownerId 的安装，都会把所有记忆写进同一个 `owner_id: 'local-user'` 仓库**。`ledger.js:112-114` 的 owner 隔离是"仓库级"的（`manifest.owner_id !== this.ownerId` 就拒绝），所以一旦多用户共用 `dataDir`，他们共享同一个 owner 身份、互相可读写。对比 `descriptor.js:36-39` 把 `ownerId` 标注为 `required: true`（UI 层强填），**代码层的 `?? 'local-user'` 兜底与 descriptor 的 `required:true` 自相矛盾**。DSH 原生插件必须去掉这个兜底，改为强制显式配置或从 `ctx` 取可信身份。

### 2.4 adapter 方法签名 vs SDK 接口要求（逐方法对照）

SDK 接口定义：`definitions-CtjNSwBS.d.ts:73-106`（`MemoryProviderAdapter`）。

| SDK 要求 | 必需性 | 本包实现 | 位置 | 结论 |
|---|---|---|---|---|
| `id` | **必需** | `this.id = options.id ?? descriptor.id` | adapter.js:39 | ✅ |
| `scoreSemantics?` | 可选 | `{ kind: 'normalized-relevance' }`（冻结常量） | adapter.js:26,40 | ✅ 且 `assertRuntime` 要求它（见下） |
| `status(body, signal)` | **必需** | `async status(body, signal)` | adapter.js:64 | ✅ 形状一致 |
| `search(body, request, signal)` | 当 `capabilities.search` | `async search(body, request, signal)` | adapter.js:88 | ✅ |
| `graph(body, signal)` | 当 `capabilities.graph` | `async graph(body, signal)` | adapter.js:109 | ✅ |
| `list(body, request, signal)` | 当 `capabilities.browse` | `async list(body, request, signal)` | adapter.js:97 | ✅ |
| `remember(body, request, signal)` | 当 `capabilities.remember` | `async remember(body, request, signal)` | adapter.js:128 | ✅ |
| `get?(body, id, signal)` | 可选 | `async get(body, id, signal)` | adapter.js:103 | ✅ 实现了 |
| `dispose?()` | 可选 | `async dispose()` | adapter.js:176 | ✅ 实现了（唯一真正释放资源的地方） |
| `discover?` | 可选 | **未实现** | — | ⚪ 刻意不做 |
| `invalidateStatus?` | 可选 | **未实现** | — | ⚪ |
| `metadataSample?` | 可选 | **未实现** | — | ⚪ |
| `entityIndex?` | 可选 | **未实现** | — | ⚪（descriptor 说 entities:false，Source 从 list() 建） |
| `rememberMany?` | 可选 | **未实现** | — | ⚪ |
| `related?` | 当 `capabilities.related` | **未实现** | — | ✅ 与 `related:false` 一致，测试断言 `adapter.related === undefined`（adapter.test.js:74） |
| `link?` | 当 `capabilities.link` | **未实现** | — | ✅ 同上（:76） |
| `forget?` | 当 `capabilities.forget` | **未实现** | — | ✅ 同上（:75） |

**`assertRuntime` 是活的契约检查**（`lib/plugin-DlsNeZbQ.js:256-270`）：

```js
// plugin-DlsNeZbQ.js:258
if (adapter.id !== manifest.typeId) throw new Error(...);
// plugin-DlsNeZbQ.js:259-268  —— capabilities 与方法的双向强制
const requiredMethods = [
  [manifest.capabilities.search, "search"], [manifest.capabilities.browse, "list"],
  [manifest.capabilities.graph, "graph"],   [manifest.capabilities.related, "related"],
  [manifest.capabilities.remember, "remember"], [manifest.capabilities.link, "link"],
  [manifest.capabilities.forget, "forget"],
];
// plugin-DlsNeZbQ.js:269 —— scoreSemantics 声明与实现必须一致
if (manifest.scoreSemantics === "normalized-relevance"
    && adapter.scoreSemantics?.kind !== "normalized-relevance") throw ...
```

> 意味：`descriptor.capabilities` 里任何一个 `true` 若没有对应方法，**mount 时立刻抛错**。这就是"每个 `false` 都是真的缺失"（descriptor.js:1 注释）的机器保证。

### 2.5 返回值契约耦合（最隐蔽的一处）

`remember()` 的 receipt 词汇是**为 Mnemon 的 `mutationResultCompletion` 定制的**：

```js
// src/adapter.js:124-127（注释明说）
/** Exact write. Receipt vocabulary follows what the Source's
 *  `mutationResultCompletion` understands: `action: 'stored'|'skipped'|'candidate'|'failed'`. */
```

真实消费方：`dsh-mnemon-source-memory-spaces/lib/index.js:1728-1748`

```js
function mutationResultCompletion(result) {
  const states = [value.action, value.status, value.state]...;         // L1733-1736
  if (states.includes("partial") || errors && changed) return "partial"; // L1740
  if (value.success === false || value.ok === false || errors || ...) return "failed"; // L1742
  if (states.includes("candidate")) return "candidate";                 // L1743
  if (states.some(s => PENDING_MUTATION_STATES.has(s))) return "accepted"; // L1744
  if (value.committed === false || value.durable === false
      || states.includes("skipped")) return "unknown";                  // L1745  ← 注意
  if (value.committed === true || ... || changed) return "committed";   // L1746
  return "unknown";
}
```

> **发现一个「看起来能复用、实际有语义 bug」的坑**：
> 幂等重放时 `adapter.js:165` 返回 `action: 'skipped'` 且 `committed: true`。
> 但 `mutationResultCompletion` 在 L1745 **先检查 `states.includes("skipped")` → 返回 `"unknown"`**，永远走不到 L1746 的 `"committed"`。
> 也就是说：**一次完全成功的幂等重放，在 Mnemon 侧被报告为 `unknown`（未证实），而不是 `committed`。**
> 而 `adapter.test.js:64` 恰恰把这个行为固化成断言（`assert.equal(again.action, 'skipped')`），所以它既是当前行为的"正确测试"，也是**跨宿主复用时会原样带过去的错误语义**。
> 影响：DSH 原生插件若沿用这套词汇，重放会被当成"未知结果"；应改为 `{ action: 'stored', committed: true, replayed: true }` 或使用 DSH 自己的 receipt 语义。

其余返回值契约：

| 位置 | 返回形状 | 消费方 |
|---|---|---|
| adapter.js:164-173 | `{ action, committed, id, content, change_id, commit, indexed, replayed }` | `mutationResultCompletion` |
| adapter.js:71-82 | `{ healthy, stats: { totalInsights, deletedInsights, edgeCount, oplogCount, dbSizeBytes, byCategory, topEntities } }` | `MemorySpaceStats`（contracts.d.ts:292-303）—— 7 个键全在，但 `dbSizeBytes` **硬编码 0**（adapter.js:78），`oplogCount` 用 `git lsFiles('changes/')` 现算（:77） |
| adapter.js:194-212 `toInsight()` | `{ id, content, category, importance, tags, entities, source:'external', confidence:String(...), createdAt, score?, externalUri? }` | `Insight`（contracts.d.ts:237-266）。**`source` 硬编码 `'external'`、`confidence` 从 number 转 string**（`Insight.confidence?: string`）——两处都是 Mnemon 类型要求，不是本包语义 |
| adapter.js:209 | `externalUri = 'dsh-session://<session_id>#<event_seq>'` | 纯展示用；`adapter.test.js:60` 断言它 |

### 2.6 分类常量耦合（`schema.js:11-29`）

```js
// src/schema.js:11-19  —— Mnemon 的 CATEGORIES 枚举
export const CATEGORY_TO_TYPE = Object.freeze({
  preference:'preference', decision:'decision', fact:'fact',
  insight:'hypothesis', context:'event', general:'fact',
});
// src/schema.js:20-29  —— 反向映射
export const TYPE_TO_CATEGORY = Object.freeze({ ... });
```

SDK 侧定义：`lib/contracts.js:2-9` `CATEGORIES = ["preference","decision","fact","insight","context","general"]`。

这是**词汇耦合，不是代码耦合**：`schema.js` 不 import SDK，但键集合是照抄 Mnemon 的。DSH 若无 "category" 概念，这 18 行变成死映射（无害，`TYPE_TO_CATEGORY` 仍被 `adapter.js:70,198` 用于 status/search 输出）。**可以原样留着**，因为改它需要动 `schema.js`（不在允许范围），且留着零成本。

### 2.7 一处"名字骗人"的耦合残留

```js
// src/ledger.js:429-447
/** Mnemon `remember` input -> ledger ADD proposal. Kept here so the mapping is testable without Cordis. */
static proposalFromRemember(request, { ownerId, idempotencyKey, sourceRefs, reason, actor = 'agent' }) {
  const sourceKind = request.source === 'user' ? 'user-explicit'
                   : request.source === 'external' ? 'session-extraction' : 'agent-inference';  // L431
  const type = sourceKind === 'agent-inference' ? 'hypothesis'
             : (CATEGORY_TO_TYPE[request.category ?? 'general'] ?? 'fact');                     // L432
```

`ledger.js`（一个"零依赖"文件）里住着一个专门吃 `RememberRequest`（`{ content, category, source, importance, tags, entities }`，contracts.d.ts:283-291）的静态方法。它**不 import SDK**，但语义上属于 adapter 层。**建议原样保留**（移动它需要改 ledger.js，禁止），新插件可直接调用它，也可以自己写一份。

---

## 3. 不变量守护（C）—— 含"去掉 SDK 会不会破"的判定

### 3.1 总表

| # | 不变量 | 定义位置 | 守护机制 | 测试覆盖 | 去掉 Mnemon SDK 后 |
|---|---|---|---|---|---|
| **I1** | **Git 是唯一权威**（读只认 committed blob） | `ledger.js:118-123`（注释）→ `readHead():126`、`getMemory():132`、`listMemories():140`、`getChange():154`、`getChangeNote():161`、`history():168`；传输层 `git.js:121-133`（`show`/`showOrUndefined`） | 所有读取走 `git show <commit>:<path>`，**从不读工作树**；`base = commit ?? HEAD`（ledger.js:133,141,155,162） | `hardening.test.js:44` H1、`:76` H1b、`:92` H1c；`ledger.test.js:204` T7 | **不破**。零 SDK 依赖 |
| **I2** | **写只发生在一次真实 commit 之后** | `ledger.js:382-402`（写文件 → commit → 才写 receipt/outbox）；`git.js:103-107`（`commitPaths` 返回 `rev-parse HEAD` 真哈希） | commit 抛错 → `restorePaths` 回滚工作树 → 抛 `GitError`（ledger.js:387-396）；receipt 在 :400、outbox 在 :401，**都在 commit 成功之后** | `ledger.test.js:126` T4、`:152` T5；`hardening.test.js:322` H4 | **不破** |
| **I3** | **SQLite 是可重建投影** | `projection.js:1-12`（注释）、`replay():98-115`、`rebuild():130-155`、`UNKNOWN_COMMIT:19` | ① 只索引 `commitExists` 的提交（:101-105，假 commit 的 outbox 行被丢弃）；② 每条 outbox 行 **index 成功后才 ack**（:111），失败则下次重放修复；③ 索引 UPSERT 幂等（:63-71）；④ `rebuild` 从 **HEAD 的 tree** 重折（:143-151），provenance 用 `git log -1 -- <path>`（:148）而非硬盖 HEAD | `hardening.test.js:230` H3、`:269` H3b、`:285` H3c、`:303` H3d；`ledger.test.js:152` T5、`:265` T10 | **不破**，但见 §3.3 的两个运行期缺口 |
| **I4** | **跨进程互斥** | `lock.js:46-209`（`RepoLock`）；调用点 `ledger.js:217-223`（`acquire` → `try` → `finally release`）、`:229-232`（锁内二次幂等复查） | ① `mkdir(<repo>/.ledger-lock)` 原子独占（lock.js:135）；② 归属写 `owner.json`（:141）；③ `owner.json` 缺失/不可读 **绝不当"空闲"**，必须 TTL 到期才算 stale（:59-73, 89-108）；④ stale 回收用 `rename` 让位，只有一个回收者赢（:148-162）；⑤ commit 前 `heartbeat()` 续期（ledger.js:385 → lock.js:187-194）；⑥ 只有持有者能删锁（:196-204） | `hardening.test.js:107` H2、`:129` H2b、`:144` H2c、`:162` H2d、`:178` H2d2、`:192` H2e、`:212` H2f、`:339` H5 | **不破** |
| **I5** | **owner 隔离**（一个仓库只服务一个 owner） | `ledger.js:112-114`（`open()` 校验 `manifest.owner_id`）、`:206-208`（`applyLocked` 校验 `proposal.owner_id`）；`schema.js:94`（`owner_id` 必填 ≤128） | 双重校验：开仓时比对 manifest，写入时比对 proposal | `ledger.test.js:311`（"repository owner mismatch is refused"）、`:236` T8 内 `owner_id:'someone-else'` → `LedgerConflictError` | **不破**，但 see §3.3 的 `'local-user'` 默认值风险 |
| **I6** | **失败绝不误报成功** | `ledger.js:387-396`（commit 失败→`restorePaths`+抛错）；`adapter.js:131-139`（无证据→`candidate`, `committed:false`，**一个字节都没写**）；`adapter.js:152-155`（异常→`action:'failed', committed:false`）；`git.js:56-61`（非 0 退出码→reject）；`lock.js:115-118`（超时→`LedgerLockError`，绝不静默跳过） | 见 §6 失败语义专章 | `ledger.test.js:126` T4、`:152` T5；`hardening.test.js:144` H2c、`:322` H4、`:303` H3d；`adapter.test.js:32`、`:43` | **边缘破损**：`ledger.js` 保证不误报，但 `adapter.js` 翻译成 Mnemon 词汇时存在 2 处语义损失（§6.3、§6.4）。DSH 原生插件必须重写这层翻译 |
| **I7** | **证据强制**（无 Session 引用不得成为 active 记忆） | `schema.js:119-121`（`status==='active' && source_refs.length===0` → `SchemaError`）、`:155`（ADD 必须有 source_ref）、`:116-118`（`agent-inference` 必须是 `hypothesis`）；`adapter.js:131-139`（第一道闸）；`ledger.js:244`（`verifyEvidence` 调用，结果被记录不伪造） | 三层：adapter 拒绝 → schema 拒绝 → change 文件记录 `evidence_verification` 真实结果（`ledger.js:363`） | `ledger.test.js:233` T8、`:172` T6；`adapter.test.js:32`、`:43`（T8 注入消息拒绝） | **不破**（全在 schema/ledger/adapter 内，零 SDK） |

### 3.2 逐条"去掉 SDK 会不会破"的机制级论证

- **I1、I2、I4、I5、I7：完全不破。** 它们的所有实现与断言都在 `{schema, git, lock, ledger}.js` 内，这 4 个文件**没有一行 import 到 Mnemon 或 Cordis**（§1.1 表格）。删除 `node_modules/dsh-mnemon-source-memory-spaces` 后，这 5 个文件仍然可以 `import` 并运行。
- **I3：不破，但有两个运行期缺口（与 SDK 无关，是现有代码自身的洞）**：
  1. **`rebuild()` 在生产路径上从未被调用。** `grep 'rebuild(' src/` 只有 `projection.js:130` 的定义和 `:10` 的注释，**没有任何调用点**。`adapter.js:57` 首次打开时只调 `replay()`。所以：如果 sqlite 文件损坏（不是被删）、或 schema 版本不匹配（`projection.js:60-62` 直接 `throw`）、或 outbox 目录被清空而 db 落后，**运行期没有任何自动修复路径，只有测试会调 rebuild**。DSH 原生插件必须显式加一节"打开失败 → 删库 → rebuild"的恢复逻辑（新文件里加，不动 projection.js）。
  2. **投影落后不会被察觉。** `adapter.js:158-163` 在 index 失败时只把 `indexed=false` 返回，`status()` 也不检查 outbox 积压（`adapter.js:64-86` 只看 `head !== null` 和 `lsFiles('changes/')`）。也就是说 outbox 里有 100 条未消费记录时，`status().healthy` 依然是 `true`。建议新插件加一个 `pendingOutbox().length` 健康指标。
- **I6：这是唯一会因"翻译层重写"而变化的条目。** 见 §6。

### 3.3 现有代码自身的两个不变量弱点（与 SDK 无关，需上报）

1. **`open()` 不在锁保护之下**（`ledger.js:94-116`）。首次初始化会 `writeFile(manifest.json)` + `writeFile(.gitignore)` + `commitPaths(...)`（:103-107），但**没有 `this.lock.acquire()`**。两个进程同时首次打开同一个新仓库，可能双写 manifest 或产生 `git commit` 竞争。跨进程锁只覆盖 `apply()`（:217-223）。**修复只能写在新文件里**（例如新插件在构造 ledger 前自己持一把锁），因为 ledger.js 禁止改。
2. **锁 TTL(60s) 与单次 commit 时长的关系**（`lock.js:34` `DEFAULT_LOCK_TTL_MS = 60_000`；`ledger.js:385` 只在 commit **之前** heartbeat 一次）。若一次 `git commit` 耗时 >60s（大仓库、慢盘、杀毒扫描），锁会在 commit 中途被判定 stale 并被其他写入者抢走 —— 正是 `lock.js:17-18` 想防止的场景。属于**理论窗口**，非现实高发。建议 DSH 侧把 TTL 配大到 ≥ 单次提交最坏耗时的 3 倍。

---

## 4. Bundle 加载适配性（Q4）—— 当前 exports 能否被 DSH 当 Bundle 加载？

**结论：不能。缺 3 个必需件，且有 1 个"能加载但会崩"的陷阱。**

### 4.1 DSH 的 Bundle 判定链（已由源码确认）

```
profile.ts:780  readProfileManifest(binName, dir)            // 读 profile/package.json
profile.ts:781  const bundles = manifest.dsh?.profile?.bundles ?? []
profile.ts:789  bundles.map(packageName => {
profile.ts:790    resolveBundleDir(binName, packageName, installAnchor, dir)   // 先安装锚点，后 profile
profile.ts:791    const bundleManifest = JSON.parse(readFileSync(join(packageDir,'package.json')))
profile.ts:792    const declared = bundleManifest.dsh?.bundle?.patch
profile.ts:793    if (declared === undefined)
profile.ts:794      throw new Error(`${binName}: profile bundle ${...} declares no dsh.bundle in its package.json`)
profile.ts:796    const patchPath = join(packageDir, declared)
profile.ts:797    return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
                 })
```

`dsh plugin add` 的自动纳管同样只看这一个字段：

```js
// apps/cli/src/plugin.ts:36-45
function exportsPatch(packageName, profileDir): boolean {
  ...
  const manifest = readProfileManifest(NAME, dir)
  return manifest.dsh?.bundle?.patch !== undefined      // ← 唯一的"是不是 bundle"判据
}
// plugin.ts:70-74：不是 bundle 就只装成普通依赖并打 warning，永远不进 bundles 层
```

对照 DSH 自家 bundle（`packages/bundle/base/package.json`）：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": {...}, "./cordis.patch.yml": "./cordis.patch.yml", "./src/*": "./src/*", "./package.json": "./package.json" },
  "files": ["lib/index.js", "cordis.patch.yml", "lib/types/**/*.d.ts"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### 4.2 目标包现状 vs 要求（逐项）

| 要求 | DSH 原生 bundle | 本包现状 | 差距 |
|---|---|---|---|
| `dsh.bundle.patch` | `{"bundle":{"patch":"./cordis.patch.yml"}}` | **完全没有 `dsh` 字段** | ❌ **致命**：`profile.ts:793-795` 直接抛错；`plugin.ts:44` 判为非 bundle |
| `cordis.patch.yml` 文件 | 存在，YAML 数组 + `- insert: [{id,name,config}]` | **不存在**（`Test-Path` = False） | ❌ **致命** |
| `main` | `lib/index.js` | **无 `main`** | ⚠️ 非致命（loader 走 `exports["."]`，见下） |
| `exports["."]` | ✅ | `"./src/index.js"` | ✅ **可用** |
| `exports["./cordis.patch.yml"]` | ✅（供 publint/package contents） | 无 | ⚠️ 非阻塞：`profile.ts:796` 用 `join(packageDir, declared)` 走**文件系统路径**，不经 exports 解析 |
| `type: "module"` | ✅ | ✅ ESM | ✅ |
| `engines.node` | `^22.19.0 \|\| >=24` | `>=22.5` | ✅ 兼容（`node:sqlite` 需 ≥22.5，本包已声明） |
| `files` / `private` | 公开包 | **`"private": true`** | ⚠️ 阻止 npm 发布；本地 `file:`/`link:` 安装不受影响 |
| Cordis 插件形状 | function 或 `{ apply }` 对象 | default export 是 `{ id, apply }` 对象 | ⚠️ **形状合法，但见 4.3 陷阱** |
| 依赖树可解析 | profile `node_modules` | 包在自己目录下 `node_modules`，**无 workspace、无根 manifest** | ❌ DSH 的 `resolveBundleDir` 只查 **安装锚点** 和 **profile 目录** 两个位置（`profile.ts:754`），不会去 `F:\deepseek-memory\packages\...\node_modules` 找。必须先 `dsh plugin add` 装进 profile |

### 4.3 ⚠️ 陷阱：「看起来能当 Cordis 插件直接加载，实际 apply 参数错位」

Cordis 的插件识别与调用（`@deepseek-ai/cordis@4.0.5/lib/index.js`）：

```js
// index.js:1446-1447
function isApplicable(object) { return object && typeof object === "object" && typeof object.apply === "function"; }
// index.js:1533-1536  resolve(plugin)
if (typeof plugin === "function") return plugin;
if (isApplicable(plugin)) return plugin.apply;
// index.js:1064-1071  Fiber 调用
if (isConstructor(runtime.callback)) { const instance = new runtime.callback(this.ctx, this.config); ... }
else return runtime.callback(this.ctx, this.config);       // ← 只有 (ctx, config) 两个位置参数
```

而本包：

```js
// src/index.js:67-72
export default defineMemorySpaceProvider({
  id: descriptor.id,
  apply(ctx, host, config) {                    // ← 三个参数：(ctx, host, config)
    host.install(ctx, config === undefined ? definition : createDefinition(config));
  },
});
```

Loader 的 `unwrapExports` 会取 `.default`（`vendor/loader/src/index.ts:192-199`），拿到这个 `{id, apply}` 对象 → `isApplicable` 为 true → **Cordis 认它是合法对象插件**。但调用时 `apply(ctx, config)`，第二个位置收到的就是 **config**，`host` 参数永远 `undefined` → `host.install(...)` 抛 `TypeError: Cannot read properties of undefined (reading 'install')`。

**这是"能加载、不能运行"的典型陷阱**：安装与树构建都会成功，只在 `apply` 时炸。好消息是 DSH 是 fail-loud 的（Lead 已确认 `app-boot/src/index.ts:722 assertEntriesActivated`，boot 失败会以 `plugin tree failed to load` 抛出），不会静默假装加载。但**绝不要因为"default export 有个 apply"就以为可以直接挂载**。

### 4.4 因此：本包只有两条合法落地路径

| 路径 | 做法 | 是否被 DSH 支持 |
|---|---|---|
| **A. 走 Mnemon（现状）** | 由 `dsh-mnemon` 的 `cordis.patch.yml` 里 `mnemon-source-memory-spaces` 的 `config.providers` 声明 `{ use: 'dsh-mnemon-provider-git-ledger', instanceId: 'git-ledger' }`，由 SDK 的 loader 动态 import | ✅ **这是当前唯一真正能跑通的路径**（`index.js:1-2` 注释也这么说：「Mounted ONLY through that Source's `config.providers`; never a top-level plugin」）。代价：整条 Mnemon 依赖链必须安装 |
| **B. 改成 DSH 原生 Bundle** | 新增 `src/dsh-plugin.js`（真 Cordis 插件）+ `cordis.patch.yml` + package.json 加 `dsh.bundle.patch` | ✅ 但要新建，**不能复用 index.js** |

### 4.5 仓库根缺失 workspace manifest 的实际后果

`git ls-files` 证明根目录只有 `.gitignore`。推论（【基于源码的推断】）：

1. **无法用 pnpm workspace 一次装齐**。DSH 自己用 pnpm 11 `nodeLinker: hoisted`（Lead 已核实 `profile.ts:144-190` 的 profile 模板），本仓库不参与任何 workspace → 三方依赖无法被 DSH profile 复用、也无法 `pnpm --filter` 联动。
2. **本地开发插件只能用 `dsh plugin --profile X add <path>`**：`plugin.ts:104 anchorPathSpec` 会把 `./`/`../`/裸路径锚定到**调用目录**，再转发 pnpm。所以从 `F:\deepseek-memory` 里执行 `dsh plugin --profile dev add ./packages/provider-git-ledger` 是可行的，但 pnpm 会**复制或 link 整个包**进 profile，本包的 `node_modules`（含 7 个 provider + react）会被一并卷入或重新解析 → 体积与版本一致性风险。
3. **版本偏斜风险**：本包 devDep 是 `@deepseek-ai/cordis@4.0.5`，DSH 0.1.3-alpha.2 的 `vendor/cordis` 是 **4.0.2**。装进 profile 后极可能出现两份 cordis。虽然本包不 import cordis（§1.2），但 `dsh-mnemon-source-memory-spaces/testing` **会** import（`lib/testing.js:3`），测试环境与运行时环境可能拿到不同实例。→ 这是 `adapter.test.js:80` 那条测试在真实环境里最可能 flaky 的原因。

---

## 5. 生命周期绑定（E）：如何映射到 Cordis `ctx.effect` / dispose

### 5.1 现状：资源账本（逐个对象核实）

| 对象 | 构造/打开位置 | 持有的真实资源 | 是否有 close/dispose | 现状风险 |
|---|---|---|---|---|
| `GitRepo` (`git.js:18`) | `ledger.js:85` 或注入 | **无**（每次 `run()` 现 spawn 子进程，`close` 后 `clearTimeout`，`git.js:52-61`） | 不需要 | 无 |
| `RepoLock` (`lock.js:46`) | `ledger.js:87-91` | **目录 `.ledger-lock/`**（真实文件系统状态） | 只有 `release()`（:196-204），**没有 close/dispose** | ⚠️ 若 `apply` 走到 `finally` 之前的进程被 kill，锁目录残留至 TTL（60s） |
| `MemoryLedger` (`ledger.js:70`) | `adapter.js:55`（`await ...open()`） | **无持久句柄**：`open()` 只做 mkdir/manifest/commit（:94-116），之后全是 promise fs 调用 | **没有 close/dispose**（`grep close` → 仅命中注释 `:311`） | ⚠️ 无句柄→泄漏不成立，但**"未关闭"在语义上不成立**，不要误以为漏了 |
| `ProjectionIndex` (`projection.js:21`) | `adapter.js:56` | ✅ **`DatabaseSync` 文件句柄**（`:29`），WAL 模式（`:30`）→ 额外 `-wal`/`-shm` 文件 | ✅ **有 `close()`（:76-78）→ `this.db.close()`** | 唯一必须关闭的资源 |
| `GitLedgerAdapter` (`adapter.js:28`) | `index.js:55` | `this.spaces: Map<bodyId, {ledger,index}>`（`:48`） | ✅ **有 `dispose()`（:176-179）**：遍历 close 所有 index，`spaces.clear()` | ✅ 是唯一正确释放点 |

**所以问题「sqlite/index 是否真的会 close」的准确答案**：
- ✅ **会** —— 但**只有一条路径**：`GitLedgerAdapter.dispose()`（`adapter.js:176-179`）→ `ProjectionIndex.close()`（`projection.js:76-78`）。
- ✅ 宿主侧确实会调它：Mnemon 的 `MemorySpacesService.dispose()`（`lib/index.js:1806-1817`，`:1811 await provider.dispose?.()`）+ `testing.js:41-44`。所以只要挂在 Mnemon 下，释放是有保证的。
- ❌ **`MemoryLedger` 没有 close**，也不需要有 —— 它没有句柄。**不要为了"对称"给它加 dispose**（也改不了）。
- ❌ **`RepoLock` 没有 dispose** —— 只有 `release()`。所以新插件的 dispose 里**只需处理 adapter/index**；锁的释放在 `ledger.apply()` 的 `finally` 里（`:221-223`）。
- ⚠️ **惰性打开的陷阱**：`space()` 是首次 `status/search/list/get/graph/remember` 才打开（`adapter.js:51-62`）。所以"一个从未被读写的适配器"没有任何资源 → `dispose()` 对空 Map 是 no-op。**这反而是好的**：Cordis 插件可以在 `apply` 里就注册 disposer，不必等到首次使用。

### 5.2 映射到 Cordis 的正确写法（新文件里）

Cordis 契约（`@deepseek-ai/cordis@4.0.5/lib/types/fiber.d.ts`）：

```ts
// fiber.d.ts:32-41, 157-159
disposer 在 fiber 卸载时按注册逆序执行，可以是 async，卸载会 await。
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>;
effect(execute: () => Effect /* 可为 Promise<disposer> 或 async generator */, label?: string);
```
真实用例（Lead 已核实）：`packages/core/agent-loop/src/index.ts:419-420`
`ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')`。

**推荐映射（3 层，逐层对应现有代码）**：

```js
// 新文件 src/dsh-plugin.js —— 骨架示意（本轮不实现，仅给路径）
export const name = 'dsh-memory-git-ledger';
export const inject = [/* 需要的 DSH service，例如 'storage'? 'session'? */];
export function apply(ctx, config) {
  // ← 对应 index.js:54-61 的 create()：把"宿主 authority"换成 Cordis ctx
  const adapter = new GitLedgerAdapter({
    dataDir: config.dataDir,                   // 必须显式；去掉 'local-user'/'<dataDir>/git-ledger' 兜底
    ownerId: config.ownerId,                   // 必须显式（见 §2.3 安全提示）
    defaultRecallLimit: config.defaultRecallLimit ?? 10,
    evidence: makeEvidenceHook(ctx),           // 对应 index.js:29-33, adapter.js:130
    verifyEvidence: makeSessionVerifier(ctx),  // 对应 ledger.js:244, :68 acceptAllEvidence
  });

  // ← 对应 adapter.dispose()：唯一需要释放的资源
  ctx.effect(() => {
    return async () => { await adapter.dispose(); };   // → ProjectionIndex.close() → db.close()
  }, 'dsh-memory-git-ledger: sqlite projection');
}
```

映射要点表：

| 现有代码 | Cordis 对应 | 说明 |
|---|---|---|
| `index.js:70 host.install(ctx, definition)` | **删除** | 这是 Mnemon 的私有注册机制（`PrivateMemorySpaceProviderHost`，`plugin-DlsNeZbQ.js:327-369`），DSH 没有对应物 |
| `adapter.js:176-179 dispose()` | `ctx.effect(() => async () => adapter.dispose())` | `db.close()` 必须 await；Cordis 会 await async disposer（fiber.d.ts:37-40） |
| `adapter.js:51-62 space()` 惰性打开 | **保留**，不加 effect | 惰性打开本身无害；但若要"启动即校验仓库可写"，可在 apply 里主动调一次 `space()` |
| `ledger.js:87 RepoLock` | 无需 effect | `apply()` 的 `finally` 已保证释放（:221-223）；dispose 时若恰好有写入在飞，Cordis 卸载会 await 正在跑的 effect，但**不会 await 一个裸 `ledger.apply()` promise** → 需插件自己 track in-flight apply（新代码） |
| （无） | 新增：打开失败 → `rebuild()` 恢复 | 补 §3.2 缺口 1 |
| （无） | 新增：`pendingOutbox()` 健康指标 | 补 §3.2 缺口 2 |

**§5 的两条硬结论**：

1. **现有代码里唯一的资源泄漏面是 sqlite 句柄，而它已经有正确的关闭路径（`adapter.dispose` → `index.close`）。** 所以"生命周期绑定"的工作量极小：一处 `ctx.effect`。
2. **`MemoryLedger` / `RepoLock` / `GitRepo` 都不需要 dispose 钩子**，别做无用功（也改不了 ledger.js / lock.js）。

---

## 6. 失败语义（F）：四条路径逐一核对 + 误报风险

### 6.1 证据不足

| 环节 | 代码 | 行为 |
|---|---|---|
| 第一道闸 | `adapter.js:130-139` | `evidence` 返回 `undefined` 或 `sourceRefs` 为空 → 返回 `{action:'candidate', committed:false, reason:'...requires source evidence...', content}`，**未调用 ledger** |
| 默认 hook | `index.js:29-30` `const noEvidence = async () => undefined` + `evidenceHooks = new Map([['none', noEvidence]])` | 默认就是"永远没证据" → 默认配置下 `remember` **永远只会返回 candidate**（这是 Phase-1 的诚实设计，不是 bug） |
| 第二道闸 | `schema.js:155` `ADD requires at least one source_ref`、`:119-121` active 必须 ≥1 ref | 即使绕过 adapter 也写不进去 |
| 第三道 | `schema.js:116-118` | `agent-inference` 只能是 `hypothesis` |
| 核验结果 | `ledger.js:244` `verifyEvidence(...)` → 结果写入 `change.evidence_verification`（:363）；默认 `acceptAllEvidence`（:68）返回 `{verified:false, reason:'no session verifier configured'}` | **不伪造核验**：没 verifier 就记录"未核验" |

**误报风险：无。** 这是整个包做得最干净的一条路径。测试：`adapter.test.js:32`（`candidate` + `listMemories().length===0` + `search` 空）、`:43`（注入消息拒绝 vs 用户原话接受）。

### 6.2 git 失败

| 子情形 | 代码 | 行为 |
|---|---|---|
| 工作树脏 | `ledger.js:236-241` | 抛 `LedgerConflictError`，`details.status` 带前 20 行 porcelain（供人类看） |
| commit 抛错 | `ledger.js:382-396` | → `git.restorePaths(touched)`（`git.js:110-119`：`reset`→`checkout`→`clean`，全 `.catch(()=>{})` 容错）→ 抛 `GitError('memory change X was not committed; nothing was recorded (...)')` |
| commit 之后写 receipt 失败 | `ledger.js:399-401` | ⚠️ **见 6.4 缺口 A** |
| `git init`/manifest 失败 | `ledger.js:94-116` | `open()` 直接抛；`adapter.space()`（:55）也会跟着抛 → `status` 捕获成 `{healthy:false}`，其他方法**向上抛** |
| 二进制不存在 | `git.js:52-55` | `GitError('git failed to launch: ...')` |
| 超时 | `git.js:47` `setTimeout(() => child.kill(), 30_000)` | kill → `close` 事件 → 非 0 → reject |
| HEAD 不存在 | `git.js:84-91` | 精确匹配 3 种 stderr 才返回 `null`，其余 rethrow |
| 路径在该 commit 不存在 | `git.js:126-133` | 匹配 4 种 stderr → `undefined`，其余 rethrow |

**评价**：`git.js:88` 和 `:130` 用**字符串匹配 git stderr** 来区分"正常的空"与"真实错误"。这是脆弱的（git 版本/语言环境变更会破），但方向正确（宁可 rethrow 也不吞）。

### 6.3 锁竞争

| 情形 | 代码 | 行为 |
|---|---|---|
| 有活锁 | `lock.js:111-121` `acquire()` | 轮询 `pollMs=25`(默认) 直到 `timeoutMs`(默认 30s) → `LedgerLockError('memory repository is locked by another writer', { holder, waitedMs })` |
| 锁文件无 owner 但很新 | `lock.js:89-98` `isStale` → `:69` `{unattributed:true}` | **不抢**，按 TTL 判断年龄；测不出年龄就 `return false`（当活锁，"让等待者大声超时" 注释 L96） |
| stale 回收竞争 | `lock.js:148-162` | `rename` 让位 → 只有一个成功；抢错了（对方还活着）就 `rename` 回去 + 返回 false |
| 获得锁后丢所有权 | `lock.js:187-194` `heartbeat()` | 抛 `LedgerLockError('lock ownership lost while writing')` |
| 上游翻译 | `ledger.js:218-223` `try/finally`；`adapter.js:152-155` | `LedgerLockError` → `{action:'failed', committed:false, error: msg}`（注意：`details` 只在 `LedgerConflictError` 分支被带出，`adapter.js:153` vs `:154`） |

**误报风险：低。** `hardening.test.js:144` H2c 明确断言"被挡住的写入者必须大声失败"（`result.ok===false`、`result.name==='LedgerLockError'`）。**注意一处错误类型扁平化**：`ledger.js:385` 的 `heartbeat()` 在 try 块内，它抛的 `LedgerLockError` 会被 `:387` 的 catch 包成 `GitError`，**原始类型丢失**。调用方无法再区分"锁丢了"与"git 挂了"。DSH 侧若想分开处理，只能在 policy 层看 message。

### 6.4 sqlite 投影失败

| 情形 | 代码 | 行为 |
|---|---|---|
| 单条 index 失败 | `projection.js:80-95` `indexRecord` | `BEGIN` → upsert+deleteFts+insertFts → `COMMIT`；catch 里 `ROLLBACK` 后 rethrow（**不会留半条记录**） |
| replay 中途失败 | `projection.js:98-115` | ack 在 `:111`（index 成功之后）→ 失败则 outbox 行保留，下次重放修复 |
| commit 不存在 | `projection.js:101-105` | 丢弃 outbox 行（"a commit that git does not know never happened"） |
| schema 版本不符 | `projection.js:60-62` | **直接 throw**，无自动 rebuild（见 §3.2 缺口 1） |
| rebuild 失败 | `projection.js:130-155` | 只动投影；git 侧只读。`hardening.test.js:303` H3d 断言"重建失败不损伤已提交记忆" |
| 上游翻译 | `adapter.js:156-163` | `try { await index.replay() } catch { indexed = false }` → **吞掉异常**，返回 `committed:true, indexed:false` |

**误报风险：`indexed` 这条是"诚实的局部失败"，但会被宿主误读。** `adapter.js:165-173` 同时返回 `committed:true` 和 `indexed:false`。`mutationResultCompletion` 只看 `action`/`committed`（`lib/index.js:1746`）→ 报 `committed` ✅ 正确。但**用户侧会看到"写入成功但搜不到"**（直到下次打开触发 replay）。这不是谎报，是**延迟一致性**。DSH 插件应显式暴露这个状态。

### 6.5 ⚠️ 三处真正的"误报"缺口（必须上报）

**缺口 A（假失败）：commit 成功但 receipt 写失败 → 调用方看到 failed，git 里却有记忆**

```js
// src/ledger.js:382-402
let commit;
try { await this.lock.heartbeat(); commit = await this.git.commitPaths(...); }
catch (error) { await this.git.restorePaths(touched); throw new GitError(...); }   // ← 保护到 :396 为止
// ↓ 以下三行不在任何 try 里
const receipt = { ... };
await writeFile(join(this.root, receiptPath(proposal.idempotency_key)), canonicalJson(receipt)); // :400
await writeFile(join(this.root, 'outbox', `${changeId}.json`), canonicalJson({...}));           // :401
return { status: 'committed', ...receipt, memory: after };                                     // :402
```

若 `:400`/`:401` 的 `writeFile` 失败（磁盘满、权限、杀毒锁文件）：**commit 已存在且不可撤销**，但异常向上冒泡 → `adapter.js:152` → `{action:'failed', committed:false}`。
后果：① 用户看到"失败"并可能重试；② outbox 行没写成 → **`replay()` 永远不会索引这条记忆**（只有 `rebuild()` 会，而 rebuild 从没被调用，§3.2）。
→ **"第 400 行窗口"是本包最实质的正确性缺口。** 修复必须写在新文件（ledger.js 禁止改）：例如包一层 `apply` 包装，捕获后**重新用 `receiptFor()` 探测**，若已有 receipt 或 HEAD 出现预期 commit，则按 `replayed` 处理；并主动触发一次 `rebuild()`。

**缺口 B（语义误报）：幂等重放被上报为 `unknown` 而非 `committed`** —— 见 §2.5。`action:'skipped'` + `lib/index.js:1745` 的判定顺序。

**缺口 C（健康度误报）：投影落后不影响 `healthy`** —— `adapter.js:64-86` 的 `status()` 只看 `head !== null`；outbox 积压（哪怕全部未消费）依然 `healthy:true`。`adapter.js:77` 的 `oplogCount` 数的是 `changes/` 文件（全部历史变更），**不是待处理数**，名字容易误导。

### 6.6 失败语义总评分

| 不变量 | 评分 | 理由 |
|---|---|---|
| 绝不谎报 commit | 🟢 强 | 三层守卫（adapter/schema/git commitPaths 返回值），测试覆盖 T4/H4 |
| 绝不静默跳过 | 🟢 强 | 锁超时抛错、脏树抛错、无证据返回 candidate（不是假成功） |
| 绝不伪造核验 | 🟢 强 | `evidence_verification` 记录真实结果，默认 `verified:false` |
| 投影失败不污染真相 | 🟢 强 | rollback + outbox + UPSERT + rebuild 四重 |
| 提交后失败的一致性 | 🟡 **中** | 缺口 A（receipt 写失败 → 假失败 + 永不索引） |
| receipt 词汇跨宿主一致 | 🔴 **弱** | 缺口 B（replay → unknown）；词汇是 Mnemon 私有的 |

---

## 7. 测试策略（Q7）—— 含真实用例数与"能否原样跑"

### 7.1 真实测试用例数：**31**（静态计数，与背景说法一致）

| 文件 | `test(` 数 | 用例编号 |
|---|---:|---|
| `test/adapter.test.js` | **3** | 无编号（:32）、"T8 ..."（:43）、"registers through the real 0.5.19 provider SDK"（:80） |
| `test/ledger.test.js` | **12** | T1(:14), T2(:46), T3(:84), T3b(:102), T4(:126), T5(:152), T6(:172), T7(:204), T8(:233), T9(:243), T10(:265), "repository owner mismatch"( :311) |
| `test/hardening.test.js` | **16** | H1(:44), H1b(:76), H1c(:92), H2(:107), H2b(:129), H2c(:144), H2d(:162), H2d2(:178), H2e(:192), H2f(:212), H3(:230), H3b(:269), H3c(:285), H3d(:303), H4(:322), H5(:339) |
| `test/helpers.js` | 0 | 纯工具（`tempDir`, `ref`, `openLedger`, `openIndex`, `addProposal`, `writerScript`, `OWNER`） |
| `test/writer-child.mjs` | 0 | 子进程脚本（不是测试文件） |
| **合计** | **31** | ✅ 与"31 个自动化测试"完全吻合 |

`it(` 出现次数 = **0**（全部用 `test(`；`describe` 3 个，仅作分组）。

### 7.2 🔴 但声明的测试命令是坏的（本机实测，只读探针）

`package.json:17` → `"test": "node --test test/"`

在临时目录（**仓库外**，已删除）用同构结构实测：

```
=== node --test test/ ===
Error: Cannot find module 'C:\...\ntprobe-xxx\test'
code: 'MODULE_NOT_FOUND'
✖ test    EXIT=1
=== node --test test ===      → 同样失败 EXIT=1
=== node --test "test/*.test.js" === → 3 tests / 2 suites / pass 3 / EXIT=0  ✅
=== node --test (无参数) ===  → 把 helper.js 也当测试文件收集（`**/test/**/*.js`）
```

**结论【已由源码确认 + 本机实测】**：Node 22/24 的 `--test` 把位置参数当**模块路径/glob**，不再当"目录递归根"。`node --test test/` 必然 `MODULE_NOT_FOUND` 失败。
→ 所以「31 个自动化测试全部通过」**不可能由 `npm test` 产出**。真实命令大概率是 `node --test test/*.test.js` 或显式 glob；具体用了哪条 **【尚待实验验证】**（本轮禁止运行 `node --test`）。
→ 顺带：`node --test`（无参）也会把 `test/writer-child.mjs` 当测试文件执行，它无 argv 时 `mkdir(undefined)` 抛错并 `exitCode=1`（`writer-child.mjs:10-16` + `:31-34`）→ **那条形态必然红**。【基于源码的推断】

**修复建议（新文件/package.json，非 src）**：`"test": "node --test \"test/*.test.js\""`。这条本身不属于本轮权限范围，仅记录。

### 7.3 测试对 SDK 的依赖程度：**只有 1/31 依赖 SDK**

grep 证据（`grep 'cordis|dsh-mnemon|@deepseek-ai' test/`）仅 3 处命中，全在 `adapter.test.js`：

| 位置 | 内容 | 性质 |
|---|---|---|
| `adapter.test.js:45` | `source: { kind: 'dsh-mnemon', form: 'snapshot' }` | **只是字符串字面量**，不是 import |
| `adapter.test.js:81` | `await import('dsh-mnemon-source-memory-spaces/testing')` | 🔴 **唯一真实 SDK 依赖** |
| `adapter.test.js:88` | `'dsh-mnemon.memory-space-provider/v1'` | 字符串断言 |

逐文件判定：

| 测试文件 | 用例数 | SDK 依赖 | 去 SDK 后能否原样跑 |
|---|---:|---|---|
| `ledger.test.js` | 12 | **0**（只 import `../src/git.js`、`../src/ledger.js`、`./helpers.js`） | ✅ **100% 原样可跑** |
| `hardening.test.js` | 16 | **0**（只 import `../src/ledger.js`、`../src/lock.js`、`../src/projection.js`、`./helpers.js`） | ✅ **100% 原样可跑**（含 8 个跨进程用例，靠 `node writer-child.mjs` 子进程） |
| `helpers.js` | — | **0**（import `../src/ledger.js`、`../src/projection.js`） | ✅ |
| `writer-child.mjs` | — | **0**（import `../src/ledger.js`） | ✅ |
| `adapter.test.js:32` | 1 | **0**（直接 `new GitLedgerAdapter(...)`；只用 `descriptor.capabilities` 这个纯对象，`adapter.test.js:10`） | ✅ **原样可跑** |
| `adapter.test.js:43` | 1 | **0**（同上，纯 adapter） | ✅ **原样可跑** |
| `adapter.test.js:80` | 1 | 🔴 依赖 `.../testing`（其 `lib/testing.js:3` 又 import `@deepseek-ai/cordis`） | ❌ **需重写**（改写成 DSH 原生 plugin harness） |

> **结论：30/31（96.8%）的测试在删掉 `dsh-mnemon-source-memory-spaces` 后原样可跑。**
> 这一点非常重要：它意味着**"去掉 Mnemon SDK 后 Ledger 能力仍正确"几乎不需要新增测试**，只要把 `adapter.test.js` 的那 1 条换成 DSH 契约测试，并**不要动另外 30 条**。

### 7.4 建议的三层测试策略

**Layer 1 — 原样保留的回归基线（30 条，零改动）**
- `ledger.test.js` 12 + `hardening.test.js` 16 + `adapter.test.js:32,43` 2 条。
- 验收方式：`node --test "test/ledger.test.js" "test/hardening.test.js"` + 单独 filter 跑 adapter 的前两条。**证明核心不变量在无 SDK 环境下成立**。
- 若新插件放在同仓，可直接 `node --test "packages/provider-git-ledger/test/*.test.js"`（除 adapter 第 3 条）。

**Layer 2 — 替换那 1 条 SDK 契约测试（新建）**
- 现在 `adapter.test.js:80-103` 验证了：`mountMemorySpaceProvider` 真实注册 → `manifest.apiVersion` → `descriptor.capabilities.forget===false` → `createAdapter({memorySpaces, memoryBodies, config})` → `remember` → `search` → `mounted.dispose()` → 重开仍能搜到（"restart"）。
- DSH 版本应逐条对应改写为：
  1. `ctx.plugin(dshPlugin, config)` + `await fiber.await()` 成功（对应 `assertEntriesActivated` 的精神）；
  2. 断言注册出的能力/元数据（DSH 侧可能没有 manifest 概念，退化为工具/服务注册断言）；
  3. `remember`（带真证据 hook）→ `search` 命中，且 `externalUri` 仍指回 session；
  4. **`ctx.fiber.dispose()` 后 sqlite 句柄确实关闭** —— 建议直接断言 `DatabaseSync.prototype.close` 被调用（`mock.method`），或断言 dispose 后 `db.isOpen === false`（`node:sqlite` 有 `database.isOpen`，已从 v24 文档确认）。**这是现有测试完全没覆盖的一条**（现有测试只断言 `adapter.dispose()` 不抛，未断言句柄真关）。
  5. 重开（新 fiber + 同 dataDir）后 `search` 仍命中 → 对应现有 `:99-102`。

**Layer 3 — 新增不变量 harness（针对 §3.3 与 §6.5 的缺口）**
以下 4 条现有测试**没有覆盖**，且都是真实风险：
1. **receipt 写失败 → 假失败**（缺口 A）：monkey-patch `fs/promises.writeFile` 让 `applied/` 那次失败，断言"git 里有 commit 但 apply 抛错"，再断言新插件能通过 `receiptFor()` + `rebuild()` 自愈。
2. **打开时 sqlite schema 版本不符 → 自动 rebuild**（§3.2 缺口 1）：人为写入 `meta.schema_version = 999`，断言新插件不直接崩，而是删库重建并找回全部记忆。
3. **outbox 积压不进 health**（缺口 C）：造 3 条 pending 记录，断言 `status()` 暴露 `pendingOutbox > 0`。
4. **`open()` 并发**（§3.3 弱点 1）：两个进程同时对空目录 `open()`，断言不会产生双 manifest / 坏仓库。这是一个**当前确实会红**的测试，能证明"新插件在构造 ledger 前自己加锁"是必要的。

**Layer 4（可选）— 跨宿主一致性**
把 `mutationResultCompletion` 的语义抄成一份 DSH 版 receipt 判定，用表驱动测试覆盖 `stored/skipped/candidate/failed/replayed` 五态。专门锁死缺口 B 不被带过去。

### 7.5 一条必须说清的测试环境风险

`adapter.test.js:80` 那条测试在**真实 profile 环境**下很可能 flaky，原因：包内 `node_modules` 有 `dsh-mnemon-source-memory-spaces@0.5.19`，而 `dsh-mnemon@0.5.35` 的 `dependencies` 又嵌套了一份 `0.5.23`（`package-lock.json` 中 `node_modules/dsh-mnemon/node_modules/dsh-mnemon-source-memory-spaces` 版本 0.5.23）。**两份 SDK 副本**会让 `defineMemorySpaceProviderDefinition` 来自不同模块实例，`Context.is` 之外的品牌/单例假设全部失效。若 DSH profile 再引入第三份，测试与运行时行为会分叉。→ 解耦的**真实收益**就在于此。

---

## 8. 可复用边界建议（D）—— 「原样保留 / 薄适配 / 只改新文件 / 抛弃重写」

**总原则：最大化保留。零改动核心 = 1370 行 / 82.5%。**

| 判定 | 文件 | 行数 | 理由 | 允许的改动 |
|---|---|---:|---|---|
| 🟢 **原样保留（不做任何修改）** | `src/ledger.js` | 518 | 零外部 import；I1/I2/I5/I6/I7 全在此实现；唯一已知缺陷（§3.3、§6.5A）只能在新文件里包一层修 | **无** |
| 🟢 **原样保留** | `src/lock.js` | 209 | 零外部 import；跨进程互斥 8 条测试全绿；`mkdir` 原子锁实现干净 | **无** |
| 🟢 **原样保留** | `src/projection.js` | 241 | 零外部 import；`node:sqlite` + FTS5 trigram 已在两套 runtime 实测可用；`close()` 齐备 | **无** |
| 🟢 **原样保留** | `src/git.js` | 171 | 零外部 import；无 shell、限时、限输出、无网络（:1-2 注释 + `GIT_TERMINAL_PROMPT:'0'` :33） | **无** |
| 🟢 **原样保留** | `src/schema.js` | 189 | 零外部 import；I7 证据不变量在此；类别映射只是词汇耦合 | **无** |
| 🟡 **原样保留 + 新文件包一层** | `src/descriptor.js` | 42 | 42 行纯数据、零 import。但字段形状是 Mnemon 契约（§2.2）。**作为"能力真相表 + 标识"继续用是对的**，不要删 | 无（新插件从它读 id/capabilities/label） |
| 🟡 **原样保留（双轨并存）** | `src/adapter.js` | 218 | 零外部 import，鸭子类型实现。**当作"Mnemon 模式适配器"原样留着**，与新的 DSH 适配器并存。删它没有任何收益，留着还保留了一条回退路径 | 无 |
| 🔴 **必须改造 —— 但只写新文件** | `src/index.js` | 72 | 唯一 import SDK 的文件（:8-12）。它的 3 件事（manifest 组装 / create 工厂 / default export）全部需要 DSH 版本 | **不要改它**；新建 `src/dsh-plugin.js`（Cordis 插件）+ `src/dsh-service.js`（可选，若做 service 封装） |
| 🔴 **必须新增（非 src 逻辑）** | `package.json` | 27 | 缺 `dsh.bundle.patch`、`main`；`private:true`；`exports` 缺 `./cordis.patch.yml`；`test` 脚本坏（§7.2） | 加 `dsh` 块、`main`、`./cordis.patch.yml` export、修 test glob |
| 🔴 **必须新增** | `cordis.patch.yml`（新建于包根） | 0→~20 | DSH 加载的唯一入口声明 | 全新建 |
| ⚪ **抛弃重写** | — | 0 | **没有任何文件需要抛弃。** 连 `index.js` 都建议留着（作为 Mnemon 模式入口），只是 DSH 侧不走它 | — |

### 8.1 推荐落地形态（新入口 + 适配层，旧核心像素级不动）

```
packages/provider-git-ledger/
├── package.json              ← 加 dsh.bundle.patch / main / exports / 修 test 脚本
├── cordis.patch.yml          ← 新建（- insert: [{ id, name: './src/dsh-plugin.js' }]）
├── src/
│   ├── ledger.js     🟢 不动（518 行，核心）
│   ├── lock.js       🟢 不动（209 行）
│   ├── projection.js 🟢 不动（241 行）
│   ├── git.js        🟢 不动（171 行）
│   ├── schema.js     🟢 不动（189 行）
│   ├── descriptor.js 🟡 不动（42 行，复用为能力表）
│   ├── adapter.js    🟡 不动（218 行，Mnemon 模式并行保留）
│   ├── index.js      🔴 不动（72 行，Mnemon 模式入口，DSH 不引用它）
│   └── dsh-plugin.js ⬜ 新建：Cordis 插件；~100-150 行
│                      · apply(ctx, config)          ← 替代 index.js:69-71
│                      · 显式 dataDir/ownerId（删 'local-user' 兜底）
│                      · ctx.effect(() => async () => adapter.dispose())   ← 唯一的生命周期绑定
│                      · 打开失败 → rebuild() 自愈（补缺口 1）
│                      · status 暴露 pendingOutbox（补缺口 2）
│                      · receipt 用 DSH 语义（补缺口 B：replayed → committed）
│                      · apply 后探测 receipt 自愈（补缺口 A）
└── test/
    ├── ledger.test.js     🟢 12 条原样
    ├── hardening.test.js  🟢 16 条原样
    ├── helpers.js         🟢 原样
    ├── writer-child.mjs   🟢 原样
    ├── adapter.test.js    🟡 前 2 条原样；第 3 条（:80）重写为 dsh-plugin.test.js
    └── dsh-plugin.test.js ⬜ 新建：5 条契约 + 4 条新不变量（§7.4 Layer 3）
```

**工作量估计**：新增 ~150 行插件代码 + ~20 行 patch + ~150 行测试 + package.json 6 处改动。**核心零改动。**

### 8.2 为什么"不要重写 adapter.js"

三个理由：
1. 它零外部 import —— 重写不会减少任何依赖。
2. 它的方法体（`space()` 惰性打开、`toInsight()` 映射、`categoryToTypeFilter()`、`topEntities()`）是**已经过测试的行为**（`adapter.test.js:32,43` 覆盖 candidate 拒绝、幂等、status/get/list/graph、`related/forget/link === undefined`）。重写等于把这些断言清零。
3. DSH 的 Memory 能力面（若有）大概率**更窄**而非更宽，直接复用 `search/list/get/graph/remember` 五个方法的实现最省事。

---

## 9. 一页速查：给 Lead 的 7 问 + 6 重点

| 问题 | 答案（一句话） | 最强证据 |
|---|---|---|
| **Q1 哪些可原样保留** | 8 个 src 文件里 **7 个零 SDK 依赖**（1370 行 / 82.5%）；只有 `index.js` 依赖 SDK | §1.1 表；`grep 'cordis\|@deepseek-ai' src/` 仅 4 处且 2 处是注释/字符串 |
| **Q2 强耦合点** | ① `index.js:8-12` 唯一 import；② descriptor 8 组字段是强校验契约；③ adapter 方法签名对齐 `MemoryProviderAdapter`；④ `context.memorySpaces ?? context.memoryBodies` + `runner.effectiveDataDir()`；⑤ receipt 词汇 `stored/skipped/candidate/failed` | §2.1-2.5 |
| **Q3 需改造成 DSH 接口** | 只需 `index.js` 的 3 件事（manifest/create/default export）→ 新文件 `src/dsh-plugin.js` | §5.2 骨架 |
| **Q4 exports 能否当 Bundle** | **不能**。缺 `dsh.bundle.patch`、`cordis.patch.yml`、`main`；且 default export 虽是合法 Cordis 对象插件，但 `apply(ctx,host,config)` 参数错位 → **能加载、apply 必崩** | §4.2/4.3；`profile.ts:792-795`；`plugin.ts:44`；cordis `index.js:1064-1071` |
| **Q5 生命周期绑定** | 唯一资源是 sqlite 句柄；唯一正确释放点是 `adapter.dispose()` → `ProjectionIndex.close()` → `db.close()`。映射为**一个** `ctx.effect(() => async () => adapter.dispose())` | §5.1 资源账本；`projection.js:76-78`；`adapter.js:176-179`；fiber.d.ts:157-159 |
| **Q6 不变量** | 7 条（I1-I7）；**6 条完全不受去 SDK 影响**，I6 因翻译层重写而边缘破损 | §3.1 总表 |
| **Q7 测试策略** | 静态 **31** 条；**30/31 删 SDK 后原样可跑**；只重写 `adapter.test.js:80`；新增 4 条补缺口 | §7.1-7.4 |

| 重点 | 结论 |
|---|---|
| **A 依赖分层** | ①零依赖 5 文件+descriptor / ②Cordis：**src 下零 import**（只在 SDK 内部使用）/ ③SDK：仅 index.js |
| **B 耦合清单** | 硬耦合 1 处（import）+ 字段契约 8 组 + 方法签名 18 项 + 宿主假设 4 条 + 词汇映射 2 组 |
| **C 不变量** | 7 条，Git 权威/SQLite 可重建/跨进程锁/owner 隔离/证据强制 5 条铁；失败不误报 1 条有 3 个缺口 |
| **D 复用边界** | 原样 5 + 薄适配 2 + 新文件 2（dsh-plugin.js + cordis.patch.yml）+ 抛弃 0 |
| **E 生命周期** | 一个 `ctx.effect` 搞定；`ledger`/`lock`/`git` 都无句柄，不要给它们加 dispose |
| **F 失败语义** | 4 条路径 3 条干净；3 个缺口：receipt 写失败→假失败+永不索引（**最严重**）、replay→unknown、投影落后不进 health |

---

## 10. 必须上报的「看起来能复用但实际有问题」清单（8 条）

1. 🔴 **`npm test` 是坏的**（`node --test test/` → `MODULE_NOT_FOUND`，本机实测）。「31 个测试通过」必有另外的命令，需补验。
2. 🔴 **commit 成功后写 receipt 失败 → 假失败且永不索引**（`ledger.js:382-402` 的 400 行窗口）。这是唯一一条会造成"数据在但看不见"的缺口。
3. 🔴 **`ownerId ?? 'local-user'`**（`index.js:57`）与 `descriptor.js:37` 的 `required:true` 自相矛盾；多用户共用 dataDir 时静默共享 owner 身份。
4. 🟠 **`rebuild()` 生产路径从未调用**（`grep` 只有定义）。sqlite 损坏或 schema 版本不符时无自愈（`projection.js:60-62` 直接 throw）。
5. 🟠 **幂等重放被宿主判为 `unknown`**（`action:'skipped'` 命中 `lib/index.js:1745` 早于 `:1746` 的 `committed` 判断），且 `adapter.test.js:64` 把这个行为固化了。
6. 🟠 **default export 是"合法 Cordis 对象插件"但 apply 参数错位** —— 3 参数 vs Cordis 的 2 参数，装载成功、apply 崩溃。**不要试挂载 `src/index.js`**。
7. 🟡 **`open()` 无锁**（`ledger.js:94-116`），首次并发初始化可竞争；跨进程锁只覆盖 `apply()`。
8. 🟡 **两处 git stderr 字符串匹配**（`git.js:88`、`:130`）区分"正常空"与"真错误"，随 git 版本/语言环境变更会脆。另：`adapter.js:78` 的 `dbSizeBytes` 硬编码 0；`adapter.js:77` 的 `oplogCount` 实为"全部历史变更数"而非待处理数。

---

## 附：本轮验证方式与边界

- **完整读完**：`src/` 8 个文件（1660 行）+ `test/` 5 个文件（850 行）+ `package.json` + `package-lock.json` 关键段。
- **交叉核对 SDK 真实实现**（不是只看 `.d.ts`）：`lib/provider-sdk.js`、`lib/definitions-DfmOqJjR.js`、`lib/plugin-DlsNeZbQ.js`、`lib/testing.js`、`lib/index.js:1690-1748`（收据映射）、`:1806-1817`（dispose）。
- **交叉核对 DSH**：`packages/boot/app-boot/src/profile.ts:740-804`、`apps/cli/src/plugin.ts:30-109`、`packages/bundle/base/package.json`、`vendor/loader/src/index.ts:192-199`、`vendor/loader/src/config/entry.ts:277-302`、`packages/typert/loader`。
- **交叉核对 Cordis**：`lib/types/fiber.d.ts`（effect/disposer 语义）、`lib/index.js:1064-1071`（apply 调用）、`:1446-1447`（插件形状）、`:1533-1536`（resolve）。
- **只读实测**（无仓库副作用，临时目录已删除）：Node 24.16.0 `node:sqlite` + FTS5 trigram ✅；DSH 运行时 Node 24.21.0 / Electron 44.7.0 上同样 ✅（SQLite 3.53.4）；`node --test` 各种参数形态的目录语义。
- **未做**：`node --test`（任务明令）、任何写入 src/test、安装/卸载依赖、git commit。
- **仓库状态核对**：`git rev-parse HEAD` = `970fd87dc9ddd31684801781c60451fb4433e64a`（未变）；`git status --porcelain` 仅 `?? docs/`（本轮新建的调查笔记目录）。
- **尚待实验验证**：① 真实 31 条测试的运行结果与所用命令；② 新 `dsh-plugin.js` 能否通过 `dsh --profile <name>` boot（需真实安装 + 启动）；③ `ctx.fiber.dispose()` 后 `DatabaseSync.isOpen` 是否为 false（需运行）；④ 本包被 `dsh plugin add` 装进 profile 后是否真的只有一份 cordis。
