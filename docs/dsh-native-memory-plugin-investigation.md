# DSH 原生记忆插件 — 技术设计调查报告

> **调查对象**
> - 宿主源码：`F:\xufeng\deepseek\deepseek-harness-master`，git HEAD `69646b1`，根包 `@deepseek-ai/dsh-root@0.1.3-alpha.2`，pnpm `11.7.0`，Node `^22.19.0 || >=24`
> - 记忆提供者：`F:\deepseek-memory`，git HEAD `970fd87`，核心包 `packages/provider-git-ledger`
>
> **调查轮次**：只读调查，未修改任何项目源码、未安装依赖、未改 Profile、未提交 git。
> 本轮唯一写入：`docs/_investigation/` 下 4 份调查笔记（工作草稿，非交付物）。
>
> **标注约定**
> - **【已由源码确认】** 直接读到运行代码并交叉验证编译产物
> - **【基于源码的推断】** 由代码结构/测试断言推断，未直接观察执行
> - **【尚待实验验证】** 必须运行程序才能定论，本轮禁止执行
>
> 三名并行调查员的原始笔记（本报告的事实底稿）：
> [A-bundle-loading.md](_investigation/A-bundle-loading.md) · [B-session-evidence.md](_investigation/B-session-evidence.md) · [C-ledger-reuse.md](_investigation/C-ledger-reuse.md) · [lead-verified-facts.md](_investigation/lead-verified-facts.md)

---

## 0. 结论先行

### 0.1 核心判断

**当前 DSH 源码具备实现该系统的必要能力，但有三个必须先接受的结构性事实。**

| # | 结论 | 证据强度 |
|---|---|---|
| 1 | DSH 原生扩展点**足够**：插件即 Cordis 插件，Bundle 即声明 `dsh.bundle.patch` 的 npm 包，无需 Mnemon 参与 | **已由源码确认** |
| 2 | 插件**可以**读取已完成会话的完整事件日志，且能拿到 `user` / `assistant` / `tool` / `plugin` 四种来源的可靠标记 | **已由源码确认** |
| 3 | **不存在「会话结束」信号**。DSH 的「会话」是进程内 live 对象，不是「一段有始有终的对话」。只能以 **turn** 为原子窗口做增量提取 | **已由源码确认**（这是架构事实，不是遗漏） |
| 4 | 会话日志里**没有 userId / owner**。owner 必须由部署配置显式声明 | **已由源码确认** |
| 5 | 现有 Git Ledger **1370 行（82.5%）对 Mnemon 零依赖**，可一个字符不动地保留；只有 `index.js` 72 行是 SDK 胶水 | **已由源码确认** |
| 6 | `source.kind === 'user'` **不等于**「人类亲手输入」——多条非人类路径也用它。这是本设计最容易犯的错 | **已由源码确认** |

### 0.2 推荐路线（一句话）

> **保留 Ledger 核心 1370 行不动，新建一个 DSH 原生 Cordis 插件入口（约 150 行）+ 一个 bundle patch 文件（约 20 行），把「提取窗口」定为 `turn/end`，「证据来源」定为「`source.kind==='user'` 且非本插件注入」，「owner」定为显式配置。分 7 个阶段小步验收。**

### 0.3 六条必须放弃的幻想

| 幻想 | 现实 | 依据 |
|---|---|---|
| 「监听会话结束事件，一次性提取整段对话」 | 不存在该事件。只能在每个 turn 结束时增量提取 | B §3.1、§12 第 1 条 |
| 「`kind:'user'` 就是用户说的」 | headless 任务文本、`/goal` 附件、ACP 会话都用它 | B §6.5 |
| 「会话里有 userId，直接拿来做 owner」 | `SessionHeader` 无此字段；只有 `$DSH_HOME` 级隔离 | B §8.1、§12 第 3 条 |
| 「用 `session/disposed` 做最后补救提取」 | 此刻 `ctx.sessions.flush()` 必抛（已从 store 移除） | B §12 第 13 条 |
| 「把 `src/index.js` 直接挂上去试」 | 它是**合法** Cordis 插件但 `apply(ctx, host, config)` 参数错位，装载成功、apply 抛 TypeError | C 坑 6 |
| 「`npm test` 跑过 31 个测试」 | `node --test test/` 在 Node ≥22 上 `MODULE_NOT_FOUND`。31 这个**数字**对，**命令**错 | C §7.2 |

---

## 1. DSH 原生插件加载的真实调用链

### 1.1 总图（已由源码确认）

DSH 没有「插件注册表」，也没有「扫描插件目录」。整棵运行时树是**在空数组上叠补丁**叠出来的。

```
apps/cli/src/bin.ts
  └─ apps/cli/src/profile-boot.ts:210  runProfile(options)
       │
       ├─ :119  prepareProfile(name)
       │        ├─ 首次：initProfile() 落盘 profile 模板
       │        └─ 每次：重写 cordis.yml 为 "[]"     ← 根配置永远是空数组！
       │            (profile-boot.ts:81-85 PROFILE_ROOT_CONFIG)
       │
       ├─ :161  loadProfile()  →  packages/boot/app-boot/src/profile.ts:820
       │        ├─ :824  resolveProfileDir → $DSH_HOME/profiles/<name>/
       │        ├─ :780  readProfileManifest   读 profile/package.json
       │        ├─ :781  manifest.dsh.profile.bundles   ← Bundle 列表（有序）
       │        └─ :789  bundles.map(layer =>
       │             ├─ :790  resolveBundleDir()      两锚点：先安装处，后 profile
       │             ├─ :792  declared = bundleManifest.dsh.bundle.patch   ★ 关键字段
       │             ├─ :796  patchPath = join(packageDir, declared)
       │             └─ :797  loadOverlayPatches(patchPath)   ← 解析成 PatchOptions[]
       │           )
       │
       ├─ :162  healProfilesModuleFallback()
       │        维护 $DSH_HOME/profiles/node_modules：
       │        普通 Node 写 symlink / 打包版写 ESM proxy
       │        (profile.ts:552-565, :568-578, :407-453)
       │
       ├─ 四层 patch 叠加（profile-boot.ts:137-144 allPatches）
       │   ① bundlePatches      每个 bundle 的 cordis.patch.yml，按 bundles 顺序
       │   ② profile.patches    profile 自己的 cordis.patch.yml
       │   ③ homePatches        $DSH_HOME/cordis.patch.yml（机器级，压过 profile 层）
       │   ④ overlays           --patch 文件（args.ts:138，可重复）+ telemetry 开关
       │
       └─ :264  boot(NAME, rootConfig, structuredClone(allPatches(composed)), prepare)
            └─ packages/boot/app-boot/src/index.ts:787  boot()
                 ├─ :794  new Context()
                 ├─ :800  ctx.provide('dshHomePath', dshHomePath)
                 ├─ :801  await ctx.plugin(Loader)          ← Cordis Loader 服务
                 ├─ :802  await prepare?.(ctx)              ← 注入环境快照 / cmdline
                 ├─ :804  mountRootInclude()                ← :516
                 │        └─ :553 ctx.loader.create({
                 │                 id:'include', name:'cordis:include',
                 │                 config:{ path, patches } })
                 │             ↓ vendor/include/src/index.ts:273 [Service.init]
                 │             :316 applyPatches()
                 │             :58  applyEntryPatches([], patches, warn)   ← 真正的补丁应用
                 │             :317 root.update() → group.ts:59 → :71 Promise.allSettled(create)
                 │             ← 注意：并发挂载，行顺序不承载装载语义
                 ├─ :812  await ctx.get('loader').await()    ← 等整棵树 settle
                 └─ :814  assertEntriesActivated(ctx)        ← 未激活即抛错（fail-loud）
```

**三条最容易误解的地方**

1. **根配置永远是 `[]`**（`profile-boot.ts:81-85`）。所有行都来自 patch。所以「改 cordis.yml」是死路。
2. **行顺序不决定加载顺序**。`base/cordis.patch.yml:12-13` 注释明说 row order carries no load semantics。真正决定的是 **`inject` 服务依赖**（`vendor/cordis/src/fiber.ts:611-639` epoch 门控）。
3. **并发挂载**：`group.ts:71` 用 `Promise.allSettled(config.map(create))`。所以插件之间不能假设彼此的 `apply` 是串行的。

### 1.2 `dsh.bundle` 的声明与解析

**声明**（真实例子，`packages/bundle/base/package.json:31-35`）：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

**解析**：`packages/boot/app-boot/src/profile.ts:792`

```ts
const declared = bundleManifest.dsh?.bundle?.patch
if (declared === undefined) {
  throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
}
const patchPath = join(packageDir, declared)
```

**要点**
- 路径**相对包根目录**，不是相对 profile。
- 声明缺失是**硬失败**（`:793-795` 直接 throw），不是「无 patch」。
- 另有两处独立读取同一字段：`apps/cli/src/plugin.ts:44`（判断是否为 bundle）、`scripts/verify-cordis-config.ts:260`。
- **【已由源码确认】** 类型定义在 `packages/util/package-manifest/src/types.ts:27-30`，但该包**只有 type export、无运行时校验** —— 解析是各处手写 `JSON.parse` + 字段探测。

### 1.3 patch 文件的真实语法

> 完整真实范例：`packages/bundle/sdk-minimal/cordis.patch.yml`（168 行）与 `packages/bundle/base/cordis.patch.yml`（487 行）。

顶层是 **YAML 数组**，元素是 loader patch 条目：

```yaml
- insert:                                  # 往树里插入行
    - id: session                          # 行 id（后续 patch 靠它定位）
      name: '@deepseek-ai/dsh-session'     # npm 包名 / file:// URL / cordis:builtin
      config: { ... }                      # 传给插件的配置
      inject: [foo, bar]                   # 声明依赖的服务（决定装载时机）
      disabled: !!js process.platform === 'win32'

- id: session                              # 按 id 覆盖已存在行
  config: { ... }                          # ⚠ 整块替换，不是深合并

- id: hmr
  disabled: true                           # 禁用一行
```

**关键语义（全部已由源码确认）**

| 事实 | 证据 |
|---|---|
| `config` 是**整块替换**，不是深合并 —— 覆盖一行必须重述全部键 | `vendor/include/src/index.ts:121-124` |
| 未匹配的 patch 只 **warn 不失败** | `vendor/include/src/index.ts:111-114` |
| 解析失败才硬失败（非数组、非 mapping） | `app-boot/src/index.ts:359-366` |
| `!!js <expr>` 可写 JS 表达式 | `app-boot/src/index.ts:225 userPatchesSchema = entryListSchema` |
| `./x` `../x` 会转 `file://`，基准是**补丁文件目录** | `app-boot/src/index.ts:326-336 anchorInsertedPluginNames` |
| 同一 patch 列表内，后一个 patch 可以定位前一个 insert 的行 | `vendor/include/src/index.ts:96-101 buildMap(insert)` |

**🚩 一个已实测确认的高危陷阱（与本次设计直接相关）**

`applyEntryPatches` 的索引键是 **裸 `entry.id`**（`vendor/include/src/index.ts:66-75 buildMap`）。而 Loader 的 `Entry` 对象上 `include:` 前缀只是一个 getter（供 `ctx.loader.resolve()` 用），**不在数据索引里**。

因此这种写法**静默失效**：

```yaml
- id: include:tool-fs        # ✗ 永远匹配不到，只留一行 warn
- id: tool-fs                # ✓ 正确（base 是顶层 insert，id 就是裸的）
```

同类语义已被测试钉死：`packages/boot/app-boot/tests/config-dump.spec.ts:142`，断言 `patch: entry "child" not found`。

> **对本次设计的直接含义**：我们自己写的 `cordis.patch.yml` 里，**id 必须是裸的**，且必须与实际插入行的 id 完全一致。验收时要主动检查 `not found` 警告（见 §8 阶段 2）。

### 1.4 插件如何注册运行能力

DSH 里**所有能力都是 `ctx.<service>`**。真实注册 API 与 disposer 返回值：

| 能力 | 注册 API | 实现位置 | 返回 |
|---|---|---|---|
| Cordis 服务 | `class X extends Service { constructor(ctx){ super(ctx,'name') } }` | `vendor/cordis/src/service.ts:57` → `reflect.ts:278`（内部就是 `ctx.effect`） | 服务句柄 |
| 工具 | `ctx.tools.register(defineTool({...}))` | `packages/core/tools/src/index.ts:1027-1052` | `() => void` |
| 提示词段落 | `ctx.systemPrompt.section({ name, order, text })` | `packages/core/system-prompt/src/index.ts:448-457` | `() => void` |
| 事件监听 | `ctx.on('session/event', handler)` | `vendor/cordis/src/events.ts:254-260` | `() => void` |
| 投影单元 | `ctx.sessionProjections.register(unit)` | `packages/session/session-projection/src/index.ts:209-222` | `() => void` |

**真实代码片段（服务注册）** —— `packages/core/session/src/index.ts:866-871`：

```ts
export class SessionStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sessions')      // ← 这一句就把 ctx.sessions 注册成了服务
```

### 1.5 插件如何取得会话 / Agent / 模型 / 持久化接口

**全部通过 `ctx.<service>` + `inject` 声明**（【已由源码确认】）：

| 需要的东西 | 服务键 | 定义位置 |
|---|---|---|
| 会话（live） | `ctx.sessions` | `core/session/src/index.ts:866` |
| 会话（查询，含冷读） | `ctx.sessionQuery` | `session-query/session-query/src/index.ts:97,105` |
| 会话持久化 | `ctx.sessionPersistence` | `session/session-persistence/src/index.ts:111,135,137` |
| Agent | `ctx.agents` | `core/agent/src/index.ts:249` |
| 模型调用 | `ctx.llm` | `llm/llm/src/index.ts:53-55,330` |
| 工具注册 | `ctx.tools` | `core/tools/src/index.ts:130-131` |
| 提示词 | `ctx.systemPrompt` | `core/system-prompt/src/index.ts:14-15` |
| 存储 | `ctx.storage` | `storage/storage/src/index.ts:47` |

**取 Agent 与会话的真实写法**（`packages/tool/tool-todo/src/index.ts:205-210`）：

```ts
exec.agent.session.append('todo/write', { todos })
```

### 1.6 资源释放：唯一正确机制是 `ctx.effect`

**先纠正一个常见误解**：**没有 `ctx.on('dispose')`**。全仓库 grep 零命中，`Events` 接口（`vendor/cordis/src/events.ts:329-352`）也没有该事件。

真实机制**四种，全部收敛到 Fiber effect**：

| 写法 | 位置 | 用途 |
|---|---|---|
| `ctx.effect(() => cleanup)` | `vendor/cordis/src/fiber.ts:415-561` | 通用；支持 generator 形式 |
| `ctx.on(...)` | `vendor/cordis/src/events.ts:254` | 返回 disposer，自动收集 |
| `Service` 构造器 | `vendor/cordis/src/service.ts:57` | 服务随 fiber 销毁 |
| `register()` 返回 disposer | 各注册表 | 同上 |

**最佳范例（异步资源 + 启动不阻塞）** —— `packages/spill/spill-local/src/index.ts:95-101`：

```ts
ctx.effect(function* () {
  const ready = open()        // 启动不 await
  yield () => ready.then(close)  // 但把 promise 交给 disposer 去 await
})
```

**卸载时的顺序语义**：`vendor/cordis/src/fiber.ts:265-296` → `_unload():675-696`
- **单个 effect 内部：逆序执行**
- **多个 effect 之间：并发执行**

**进程级宽限**：`apps/cli/src/process-shutdown.ts:4` 上限 **5 秒**。

> **对本设计的硬性要求**：`DatabaseSync` 句柄、`fs.watch`、`setInterval`、子进程 **都必须包进 `ctx.effect`**。裸写会泄漏。

### 1.7 如何向内独立 Profile 安装本地开发插件

**Profile 位置**：`$DSH_HOME/profiles/<name>/`
`$DSH_HOME` 解析优先级：显式参数 > 环境变量 > `~/.dsh`（`packages/util/home-paths/src/index.ts:87-91`）

**Profile 目录结构**（`app-boot/src/profile.ts:144-190`）：

```
$DSH_HOME/profiles/<name>/
├── package.json          # { dsh: { profile: { bundles: [...], patchReload: 'live'|'startup' } },
│                         #   dependencies: {...} }
├── cordis.patch.yml      # 用户自己的 patch 层（模板 = "[]"）
├── pnpm-workspace.yaml   # nodeLinker: hoisted, autoInstallPeers: false
└── node_modules/         # pnpm 安装的插件依赖
```

**安装命令**（`apps/cli/src/plugin.ts:120 runPlugin`）：

```bash
dsh plugin --profile <name> add ./my-plugin      # 本地路径
dsh plugin --profile <name> add ../my-plugin     # 相对路径会被锚定到【调用目录】
dsh plugin --profile <name> add link:../pkg      # pnpm link 语义（共享源码）
dsh plugin --profile <name> add file:../pkg      # pnpm file 语义（拷贝）
```

**两个关键机制**
1. **相对路径锚定**：`plugin.ts:104-112 anchorPathSpec` 把 `.`/`../x` 重写为**绝对路径**，因为 pnpm 的 cwd 是 profile 目录 —— 不锚定的话 `add .` 会把 profile 自己 link 进去。
2. **安装后自动并入 bundles**：`plugin.ts:59-91 reconcilePlugins` 按**已安装状态**判断 —— 凡解析出的包声明了 `dsh.bundle.patch`（`plugin.ts:44`），就追加进 `dsh.profile.bundles`。所以**装包即挂载**，不需要手改 profile/package.json。

**`--patch` 叠加（不装包也能试）**：`apps/cli/src/args.ts:138`，可重复（`:61 collect`），`profile-boot.ts:164` 变成 overlay 层。
⚠️ 但**仍需包本身可被 resolve**，`--patch` 只免去改 profile 清单。

### 1.8 如何确认插件真的加载了（而非只在配置里）

**这是本次调查最重要的运维结论。三层证据强度递增：**

| 层 | 手段 | 能证明什么 | **不能**证明什么 |
|---|---|---|---|
| **L1 静态** | `dsh --profile <name> --dump-config`（`apps/cli/src/dump-config.ts:30`） | 配置树里有这一行 | 不 boot、不求值 `!!js`（`app-boot/src/index.ts:386`）、不准备 module fallback → **代码可能根本加载不了** |
| **L2 装载审计** | boot 时的 `assertEntriesActivated`（`app-boot/src/index.ts:722`） | 模块解析成功 + 服务注入满足 + `apply` 未抛错 | 不证明业务逻辑正确 |
| **L3 运行时投影** | `ctx.loader.entries()` + `fiber.state`；生产实现 `packages/host/plugin-inventory/src/index.ts:65 list()`（映射表 `:26-43`）；Web GUI = **Settings → Plugins → All** 页签（`ui-settings-plugin-inventory/src/client/index.ts:36-57`） | 此刻**活着**、状态是 `active` | — |

**L2 的强度细节**（`app-boot/src/index.ts:722-755`）：
- entry 的 `fiber === undefined` → `plugin(s) failed to load`（`:688-694`）
- fiber `FAILED` → `await fiber.await()` 重抛**原始 stack**（`:732-737`）
- fiber `PENDING` → 打印 `pending (waiting for service: X)`（`:741-743`）
- 任一条成立 → **进程非零退出**

> 所以在 DSH 里「配置里有但加载不了」是**硬失败**，不会静默。这比大多数插件框架强。

**⚠️ 一个反直觉的否证：日志不能当探针。**
`ctx.logger` 默认只进内存 buffer（`vendor/cordis/src/logger.ts:213-221`），所有 shipped patch 都没有 console exporter（全仓 `*.yml` grep 仅测试 fixture 有）。所以 **「控制台没打印」不能说明没加载**。

**「装了」≠「挂了」的真实样本**（【基于源码的推断·高置信】）：
本机 `~/.dsh/profiles/web/package.json` 装了 7 个 memory/teach 包（`dsh-memory`、`dsh-memory-policy`、`dsh-memory-tencentdb`、`dsh-tool-memory`、`dsh-teach-activity`、`dsh-teach-resume`、`dsh-teach-tools`），但它们**全部没有 `dsh.bundle`**、**不在 `bundles` 列表**、**patch 里零引用** → 按装载链推断从未被挂载。

---

## 2. Session 到 Memory Ledger 的读写流程

### 2.1 会话证据到底存在哪

**两层结构**：

| 层 | 内容 | 位置 |
|---|---|---|
| **内存 `Session`** | 事件溯源对象，`log` 是 `SessionEvent[]` | `packages/core/session/src/index.ts:422` |
| **磁盘** | `SessionHeader`（元数据）+ JSONL（事件体，默认 zstd） | `session-persistence-jsonl` |

**存储格式**：`SessionHeader`（`core/session/src/types.ts:91-128`）字段为
`version` / `id` / `createdAt` / `cwd?` / `parentSession?` / `isSeeded` / `origin?` / `delegationDepth?` / `agentPreset?`

> **🚩 没有 userId，没有 owner。** 这是 L3/L0 owner 隔离必须先解决的前提。

**事件表**（`core/session/src/types.ts:266-382`，12 种核心事件）：

| 事件 | 载荷要点 | 对我们的用途 |
|---|---|---|
| `turn/start` | `{ turn }` | 窗口起点 |
| `turn/end` | `{ turn, reason: TurnEndReason }` | **窗口终点（推荐提取点）** |
| `step/start` / `step/end` | `{ turn, step }` | 一次模型调用+工具执行 |
| `user/message` | `UserMessage`（**无 turn 号**） | **证据主体** |
| `assistant/message` | `{ turn, step, message, stream, usage?, interrupted? }` | 助理回复 |
| `assistant/attempt` | `{ turn, step, stream }` | 失败/重试的尝试 |
| `tool/call` | `{ turn, step, callId, name, arguments }` | 工具调用 |
| `tool/result` | `{ turn, step, message, error?, meta? }` | 工具结果 |
| `request/header` / `request/context` | 请求头/路由 | 与记忆无关 |
| `session/end-seed` | `{ inherited? }` | **fork/恢复边界**，识别继承历史 |

### 2.2 可提取窗口：为什么必须是 `turn/end`

**🚩 首要事实：没有「会话结束」信号。**（【已由源码确认】）

- 全仓 grep `session/(end|closed|close|ended|idle|touched|updated)` **零命中**
- `session/disposed` 的语义是「离开 store」（`core/session/src/index.ts:51-60` 注释），不是「对话完成」
- `agent/status: 'idle'` 在**每个 turn 结束**都出现（`agent-loop/src/agent.ts:230`），不是对话结束
- 「对话静止 N 分钟」没有权威数据源（`docs/.agents/notes/proposed/architecture/2026-07-29-durable-last-activity-index.md` 仍是 proposed，且明说冷会话无法回答「用户上次何时在此输入」）

**推荐窗口：`turn/end`，且只取 `reason.kind === 'completed'`**

```ts
// 窗口边界
startSeq = turn/start 事件的 seq
endSeq   = turn/end   事件的 seq
```

理由（【已由源码确认】）：
- `turn/end` 在 `agent-loop/src/agent.ts:330` 的 **`finally`** 里追加 → **必然产生**，无论 complete/abort/error/max-tokens
- `turn/end.data.reason` 携带 `TurnEndReason`（`types.ts:198-219`），可过滤
- 窗口内的事件已全部 append，且 `user/message` 一定在 `turn/start` 之后

**补充信号（可选，次优）**：
- `agent/turn-stopping`（`core/agent/src/runtime-types.ts:387`，`@mode serial`，**被 await**），在 `turn/end` **之前**（`agent.ts:307`）→ 适合做收尾工作
- `agent/status: 'idle'` — 只能作启发式，不能作「对话结束」判据

### 2.3 写入链路（目标设计）

```
┌─ DSH 进程 ────────────────────────────────────────────────────────┐
│                                                                    │
│  Agent loop ──append──▶ Session.log                                │
│                              │ post-commit, fire-and-forget        │
│                              ▼                                      │
│                    ctx.on('session/event')                          │
│                              │                                      │
│                     event.type === 'turn/end' ?                     │
│                     reason.kind === 'completed' ?                   │
│                              │ yes                                  │
│                              ▼                                      │
│              ┌─── MemoryExtractor（新插件内）────┐                    │
│              │ 1. ctx.sessionQuery.readSession(id) │ ← 回放校验过的全量日志
│              │    或 ctx.sessions.get(id)          │ ← live 快路径
│              │ 2. 切窗口 [turnStartSeq, turnEndSeq] │
│              │ 3. 过滤 source.kind                 │
│              │ 4. ctx.llm.stream() 生成候选        │
│              │ 5. 校验 source_refs / owner / 证据  │
│              └───────────────┬────────────────────┘                │
│                              ▼                                      │
│              ┌─── 审批闸（可配置）──────────────┐                     │
│              │ auto   → 直接写                 │                     │
│              │ manual → 落 pending 待用户确认   │                     │
│              └───────────────┬────────────────┘                     │
└──────────────────────────────┼──────────────────────────────────────┘
                               ▼
                  ┌─── GitLedgerAdapter（复用现有）───┐
                  │ ledger.apply(proposal)            │
                  │  ├─ RepoLock.acquire()  跨进程锁   │
                  │  ├─ 写工作树 + git commit          │
                  │  ├─ receipt（幂等）                │
                  │  └─ outbox（投影队列）             │
                  └───────────┬───────────────────────┘
                              ▼
                  ┌─── ProjectionIndex（可重建）───┐
                  │ replay() → SQLite FTS5          │
                  └────────────────────────────────┘
```

### 2.4 读取链路（目标设计）

```
新会话 turn/start 或 agent/session-start
        │
        ▼
  识别 owner（必须来自配置，见 §2.6）
        │
        ▼
  ProjectionIndex 检索（FTS5 trigram，中文可用【已实测】）
        │  相关 L1 原子记忆
        ▼
  L2 项目状态 / L3 长期画像（同 owner 过滤）
        │
        ▼
  token 预算裁剪（复用 DSH 的 token-meter 思路，自行估算）
        │
        ▼
  ctx.systemPrompt.section({ name:'memory', order, text })   ← 提示词位置
  或   agent.inject(createUserMessage({ source: { kind:'plugin', plugin:'<本包名>', form:'recall' } }))
        │
        ▼
  ⚠ 关键：注入必须带 source.kind='plugin'，否则下个 turn 会被自己当成新证据
```

**为什么用 `form: 'recall'`？**（【已由源码确认】）
`packages/llm/llm/src/message.ts:61-62` 对 `'recall'` 的定义正是：
> "Material lifted out of another session's log, possibly reduced on the way in."

这在语义上完全对应「记忆注入」，并且让 GUI 与下游消费者能正确呈现。

### 2.5 区分四类内容（这是 L0 证据质量的根基）

**唯一权威字段是 `Message.source`**（`packages/llm/llm/src/message.ts:98-107`）：

```ts
export interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: { kind: 'model'; provider: string; model: string; replayState?: unknown }
  tool: { kind: 'tool'; callId: ToolCallId }
}
```

**事件类型 × role × source 组合表**（【已由源码确认】）：

| 事件 | role | source.kind | 可否作证据 |
|---|---|---|---|
| `user/message`（人类/注入 都走这里） | user | `'user'` 或见下表扩展 kind | ⚠ 需进一步判别 |
| `assistant/message` | assistant | 必为 `'model'`（校验 `session/src/index.ts:340`） | ✅ 可作「助手曾这样说」的证据 |
| `tool/result` | **user** | 必为 `'tool'` + `callId`（校验 `:346`） | ✅ 可作事实证据（注意 spill） |
| 插件注入内容 | user | `'plugin'` | ❌ **绝不可作证据** |

> **🚩 `role` 不能用来区分人类与工具结果** —— 两者都是 `'user'`。**必须读 `source.kind`。**

**`source.kind` 的真实取值全集**（【已由源码确认】，`MessageSourceMap` 是 merge-extensible，除 4 个核心 kind 外还有 declaration-merge 扩展）：

| 类别 | kind 值 | 作证据？ |
|---|---|---|
| 核心 | `'user'`（含义模糊，见 §2.6） | ⚠ 分档 |
| 核心 | `'model'` | ✅ |
| 核心 | `'tool'` | ✅（注意 spill） |
| 核心 | `'plugin'`（带 `plugin` 名 + 可选 `form`） | ❌ |
| 扩展 | `'goal'` | ❌ |
| 扩展 | `'compact'` | ❌ |
| 扩展 | `'webhook'` | ❌ |
| 扩展 | `'session-reference'` | ❌ |
| 扩展 | `'agent-instructions'` | ❌ |
| 扩展 | `'skill-catalog'` | ❌ |
| 扩展 | `'team-message'` | ❌ |
| 扩展 | `'agent-message'` | ❌ |

> **设计含义**：判别式必须写成**白名单**（只接受明确可信的），不能写成黑名单（排除已知不可信的）。因为 `MessageSourceMap` 是 merge-extensible，**任何插件都可能新增 kind**。

### 2.5.1 L0 证据排除清单（五类必须剔除）

（【已由源码确认】）只取「原始全量日志 + 白名单 kind」还不够，以下五类必须显式剔除：

| # | 要剔除的 | 判别方式 | 为什么 |
|---|---|---|---|
| 1 | **非 `'user'` 来源的一切** | `source.kind !== 'user'` 或白名单外 | 见上表 |
| 2 | **被 spill 的大工具结果** | `tool/result` 内容为预览 + locator（`spill-policy/src/index.ts:185-204`，在 append **之前**改写） | 原文不在日志里，30 天后彻底消失（`spill-local/src/index.ts:68`） |
| 3 | **崩溃时合成的 closer** | `repair.ts:29` 合成，内存态不落盘；`error.code` ∈ {`TOOL_OUTCOME_UNKNOWN`, `TOOL_NOT_STARTED`} | 这些是**推断**出来的，不是真实发生的事实 |
| 4 | **fork 继承前缀** | `seq < session.inheritedEventCount`（`session/src/index.ts:443`）；用 `ownEvents()` / `isOwnSeq()` | 否则**父会话内容会被重复提取**到子会话记忆里 |
| 5 | **`session/end-seed` 之前的事件** | `types.ts:381` 边界 | 同上，属于继承历史 |

### 2.6 🚩 最危险的陷阱：`kind:'user'` 不是「人类亲手输入」

（【已由源码确认】）多条**非人类**路径使用 `{ kind: 'user' }`：

| 路径 | 位置 |
|---|---|
| headless 一次性任务文本 | `packages/bundle/headless/src/index.ts:199` |
| `/goal` 附件消息 | `packages/goal/command-goal/src/index.ts:120` |
| `/plan` 模式 steer | `packages/plan/plan-mode/src/index.ts:258` |
| ACP 会话 | `packages/acp/acp/src/session.ts:296` |

**唯一强判别**：`source` 里带 `rpcId`（Web UI 来源，`packages/api/session-controller/src/commands.ts:315`）：

```ts
const source: MessageSource = {
  kind: 'user',
  rpcId: request.requestId,       // ← 客户端的 prompt 身份
  ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
}
```

```ts
// 推荐判别式【基于源码的推断】
const isHumanPrompt = (m: UserMessage) =>
  m.source.kind === 'user' && 'rpcId' in m.source && typeof m.source.rpcId === 'string'
```

**⚠ 但这只覆盖 Web UI。CLI 交互式输入是否带 `rpcId` —【尚待实验验证】**（实验 E1，见 §8）。
若 CLI 不带，则「CLI 人类输入」与「CLI headless 任务文本」在 source 上完全同形 → 必须降级为启发式，并**在记忆里标注低置信度**。

> **设计含义**：不要把「用户说的」当作公理。分层处理：
> - 有 `rpcId` → 高置信人类输入
> - `kind:'user'` 无 `rpcId` → 中置信（可用但标注）
> - `kind:'plugin'` → 排除

### 2.7 owner 与 userId：必须由部署配置

**🚩 会话日志里没有任何用户身份。**（【已由源码确认】）

三处 header 均无 userId/owner：
- `SessionHeader` — `core/session/src/types.ts:91-128`
- `SessionFormatHeader` — `session-format/src/types.ts:16-26`
- `SessionWireHeader` — `session-controller/src/types.ts:392-403`

**隔离只有 `$DSH_HOME` 级**（`home-paths/src/index.ts:87`）；Web 端认证是**主机级 cookie**（`browser-auth.ts:106`），不是用户身份。

**结论**：owner 必须由插件配置显式声明。

**⚠ 为什么不能用 `AnonymousUserId`？**（【已由源码确认】）
`packages/identity/anonymous-user-id/src/index.ts:68` 确实存在 `AnonymousUserId`，但它：
1. **不进会话日志** —— 只用于 telemetry 的 `user.id`（`session-telemetry-otel/src/index.ts:211`）和 DeepSeek 请求头（`llm-deepseek/src/adapter.ts:536`）
2. **不是 Cordis service** —— 是纯函数，没有 `ctx.anonymousUserId`

所以唯一近似的「归属」是 workspace 的 `sessionIds`（`workspace/src/spec.ts:25`），但那是 **workspace 归属**，不是 user 归属。

**可选来源（按可靠性排序）**：
1. **显式配置**（插件 config 的 `ownerId` 字段）— 最可靠，**推荐**
2. `$DSH_HOME` 路径哈希 — 能区分「不同 DSH 环境」，不能区分「同一环境里的不同人」
3. workspace path — 能区分项目，不能区分人
4. ❌ 会话 header — **不存在该字段**
5. ❌ `AnonymousUserId` — 不进日志、非 service

> **当前架构唯一成立的假设是「一个 `$DSH_HOME` = 一个 owner」**（`home-paths/src/index.ts:87`）。如果你的使用场景确实是单机单人，这就是正确的假设；如果需要多用户，必须自己在插件层做隔离，DSH 不提供。

> **🚩 现有代码的坑**：`provider-git-ledger/src/index.js:57` 用 `ownerId ?? 'local-user'` 兜底，而 `descriptor.js:37` 声明 owner 字段 `required: true` —— **自相矛盾**。多用户共用 dataDir 时会静默共享 owner 身份、互相可读写。DSH 插件里**必须去掉这个兜底**，改成缺失即报错。

### 2.8 事件同步性（决定提取能否阻塞会话）

| 事件 | 模式（源码 `@mode` 注释） | handler 抛错会怎样 | 提取任务的正确做法 |
|---|---|---|---|
| `session/event` | `emit` — **post-commit，fire-and-forget** | 被 catch + `logger.warn`，**append 不受影响** | ✅ **可以**在这里做异步提取（天然不阻塞） |
| `session/flush` | `parallel` — **await allSettled** | 抛第一个 rejection | 不要在 flush 里做重活 |
| `session/created` | `emit` — 同步 | **同步 throw 是否决创建并回滚** | 谨慎 |

**`session/event` 的实现证据**（`core/session/src/index.ts:378-396`）：

```ts
function invokeContainedSessionObservers(...): void {
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error) => {
        ctx.logger.warn(`session "${id}": ${name} listener rejected: ${String(error)}`)
      })
    } catch (error) {
      ctx.logger.warn(`session "${id}": ${name} listener threw: ${String(error)}`)
    }
  }
}
```

**推论（【已由源码确认】）**：
- 写日志**不等待**任何 listener
- listener 很慢 → **完全不影响** `append()` 返回
- ✅ 适合挂提取任务
- ⚠ 但**代价**：listener 与后续事件**并发交错**，没有顺序保证、没有背压。所以提取必须自己维护游标（见 §2.9）

### 2.9 重启恢复：如何识别未完成的提取任务

**🚩 现实：DSH 没有「未完成任务」的持久标记。**（【已由源码确认】）

但有两个可直接复制的先例：

**先例 1：把游标写进会话日志本身**（`session-log-deepseek`）
- 用 watermark 记录已上传到哪个 seq
- 保守重发
- ⚠ 留有 TODO 承认重复窗口（`session-log-deepseek/src/index.ts:165`）→ **exactly-once 无现成保证**

**先例 2：projection cache 的 `(ver, seq, val)` checkpoint**（`session-projection/src/index.ts`）
- 每个投影单元带 `stateVersion`
- `checkpoint()` 产出 `{ ver, seq, val }`
- `restore()` 校验版本，不符则拒绝
- **`turn/end` 是强制刷盘点**（`session-projection-cache/src/index.ts:306-308`）

**推荐设计（【基于源码的推断】）**：**把提取游标写进 Git Ledger 自己**

```
在记忆仓库里维护 extraction-state/
  <sessionId>.json
    { session_id, owner, last_extracted_turn: N,
      last_extracted_seq: S, state_version: 1,
      in_progress: { turn: M, started_at, attempts } }
```

**为什么放 Git，而不是另外两个更自然的选择：**

| 候选位置 | 为什么不选 |
|---|---|
| **会话日志**（`session-log-deepseek` 的做法：append 一个 `delivery-accepted` 事件） | **这是硬阻塞**：插件自定义事件类型不在 `KNOWN_SESSION_EVENT_TYPES`（`core/session/src/known-event-types.ts:22`，build 静态集）里。写入时**必须**带 `ignorable: true`；若忘记或写错，**卸载插件后整个会话日志永久不可读** —— `storage-contract.ts:75` 对未知且非 ignorable 的类型**拒绝读取整条日志**。<br>这一条否决了「游标写会话日志」方案的全部收益，风险远大于收益。 |
| **sqlite 投影** | 投影是可丢弃、可重建的（`projection.js:130-155 rebuild()`）。把权威状态放进可丢弃层，等于违反 I3 不变量的精神。 |
| **`ctx.storageDomain`** | 技术上可行（`storage-domain/src/index.ts:103 open(spec)`，root = `$DSH_HOME/storages`，`base/cordis.patch.yml:145-156` 已挂载）。但它是**第二套持久化**，与「Git 唯一权威」冲突；而且 domain 名有硬约束 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`storage/src/backend.ts:10`，**不能有连字符**）。作为「Git 不可用时的降级」可以，作主方案不行。 |
| ✅ **Git（推荐）** | 与 Ledger「Git 唯一权威」不变量一致；天然有历史可审计；与 L1 记录同一个事务域；`git reset` 可回滚。 |

**恢复流程**：
1. 启动时扫描 `extraction-state/*.json`，找 `in_progress` 非空的
2. 校验对应 session 是否还存在（`ctx.sessionQuery.listSessions()`）
3. 从 `last_extracted_turn + 1` 重新提取（**语义是 at-least-once**，靠 `idempotency_key` 去重）
4. 若 `attempts > N` → 放弃并标记 `needs_review`，**绝不静默丢数据**

**⚠ 必须接受 at-least-once，而不是 exactly-once**（【已由源码确认】）：DSH 自己的 `session-log-deepseek` 明确选择「watermark + 保守重发」，并在 `index.ts:165` 留 TODO 承认重复窗口。**exactly-once 在本架构里没有现成基础**，不要设计一个假装能做到的协议。

**⚠ 另外两条禁止**
- **绝不要插件写 `session/end-seed`**（`types.ts:370-372` 明说只有 constructor 可写）。写了会把之前所有 live 事件**误判为 seed 历史**，导致提取全部跳过。
- **绝不要往会话日志写自定义事件类型**，除非已确认带 `ignorable: true`。

### 2.10 失败时绝不写入未证实记忆

**三层 fail-closed 设计**（前两层复用现有代码）：

| 层 | 机制 | 证据 |
|---|---|---|
| **文件级锁 + 提交后返回** | `git commit` 抛错 → `restorePaths` → 抛 `GitError`，**从不误报成功** | `ledger.js:387-396` |
| **证据强制** | 无 `source_refs` 的写入在 adapter 层直接被拒为 `candidate` | `adapter.js:131-139` |
| **投影可重建** | 投影只索引 `commitExists()` 为真的提交 | `projection.js:101-111` |

**新增第 4 层（本插件必须自建）**：

| 失败场景 | 处理 |
|---|---|
| `ctx.llm.stream()` 失败（`LlmFailure` / `LlmError`） | 不产生候选，记 `extraction-state.attempts++`，下一轮重试 |
| 会话读取失败（`SessionPersistenceNotFoundError` 等结构化错误） | 同上，且**不写入任何占位记录** |
| 证据不足（窗口内无人类输入） | 记 `skipped: no-evidence`，**不写 pending 记录污染队列** |
| 候选校验失败（source_refs 指向不存在的事件） | **硬拒绝**，记 `rejected` 并在 Git 留一条审计（如果已提交过） |

**关键原则**：**「没写」必须能被区分于「写了但看不见」。**

---

## 3. 四层记忆架构

### 3.1 架构图

```
┌──────────────────────────────────────────────────────────────────────┐
│                         DSH 宿主（不改动）                            │
│  ctx.sessions  ctx.sessionQuery  ctx.sessionPersistence  ctx.llm      │
│  ctx.tools     ctx.systemPrompt  ctx.agents              ctx.loader   │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ Cordis 插件接口
┌───────────────────────────▼──────────────────────────────────────────┐
│              dsh-memory（新包：DSH 原生插件入口）                     │
│                                                                       │
│  src/index.js      Cordis 插件：apply(ctx, config)                    │
│  src/service.js    ctx.effect 生命周期 + 服务注册                     │
│  src/config.js     schemastery Config（ownerId 必填、autoApprove 等）  │
│                                                                       │
│  ┌─ L0 证据层 ─────────────────────────────────────────────┐          │
│  │ 证据索引：只存 source_refs（sessionId + seq + turn），    │          │
│  │ 不复制原始会话全文。                                     │          │
│  │ ⚠ 不落 Git 正文，只落引用；正文由 sessionPersistence 提供  │          │
│  │ 责任：可追溯、可校验、可定位                             │          │
│  └────────────────────────┬─────────────────────────────────┘          │
│  ┌─ L1 原子记忆层 ────────▼─────────────────────────────────┐          │
│  │ 一条记忆 = 内容 + owner + category + status + confidence  │          │
│  │        + source_refs[] + supersedes/retracts             │          │
│  │ 责任：可检索的最小事实单元                                │          │
│  └────────────────────────┬─────────────────────────────────┘          │
│  ┌─ L2 项目状态层 ────────▼─────────────────────────────────┐          │
│  │ 由 L1 聚合派生：进展 / 决策 / 未完成事项 / 阻塞问题        │          │
│  │ 责任：回答「这个项目现在什么状态」                         │          │
│  └────────────────────────┬─────────────────────────────────┘          │
│  ┌─ L3 长期画像层 ────────▼─────────────────────────────────┐          │
│  │ 由 L1 长期累积：稳定背景 / 偏好 / 长期目标                 │          │
│  │ 责任：回答「这个人/这个项目一贯怎样」                      │          │
│  └────────────────────────┬─────────────────────────────────┘          │
└───────────────────────────┼──────────────────────────────────────────┘
                            │ 复用现有（零改动）
┌───────────────────────────▼──────────────────────────────────────────┐
│            provider-git-ledger 核心（1370 行，原样保留）               │
│                                                                       │
│  ledger.js      提交事务、幂等 receipt、outbox                        │
│  lock.js        跨进程 mkdir 原子锁                                   │
│  projection.js  SQLite FTS5 投影（可重建）                            │
│  git.js         git 子进程封装                                        │
│  schema.js      记录/proposal 校验与词汇映射                          │
│  descriptor.js  能力真相表（本插件复用作能力声明）                    │
│                                                                       │
│          Git（唯一权威）  ──outbox──▶  SQLite（可丢弃投影）           │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 每层的责任边界与「为什么这样切」

| 层 | 存什么 | **不**存什么 | 为什么这样切 |
|---|---|---|---|
| **L0 证据** | `{ sessionId, turn, startSeq, endSeq, messageIds[] }` | ❌ 不存会话正文 | 会话正文已在 `sessionPersistence` 里，复制一份会产生**双份真相**。一旦两边不一致，无法判断谁对。L0 只做「指针 + 校验信息」。 |
| **L1 原子** | 内容 + owner + category + status + confidence + source_refs | ❌ 不存整段对话 | 原子化才可**单独纠正/撤回**。整段对话无法做 RETRACT。 |
| **L2 项目状态** | 由 L1 聚合的派生视图 | ❌ 不作为独立真相 | 若 L2 独立存储，纠正 L1 后 L2 会**陈旧且无法察觉**。必须可从 L1 重算。 |
| **L3 长期画像** | 由 L1 长期累积的高置信结论 | ❌ 不存一次性事实 | 画像需要**跨会话稳定性**。单次事实属于 L1。 |

**关键设计原则：只有 L1 是权威，L0 是指针，L2/L3 是可重算的派生。**

### 3.3 层与现有模块的映射

| 层 | 由谁实现 | 状态 |
|---|---|---|
| L0 | 新 `src/evidence.js`（~80 行）+ 复用 `schema.js` 的校验 | 新建（薄） |
| L1 | 复用 `ledger.apply()` + `projection.js`；新 `src/records.js` 定义 L1 记录结构 | 复用为主 |
| L2 | 新 `src/rollup-l2.js`，**从 L1 重算**，产出物也写回 Git 但标 `derived: true` | 新建 |
| L3 | 新 `src/rollup-l3.js`，同 L2 但需跨会话聚合 + 更高阈值 | 新建 |
| 提取 | 新 `src/extractor.js`（调用 `ctx.llm`） | 新建 |
| 检索 | 复用 `projection.js` FTS5 + 新 `src/retriever.js`（token 预算裁剪） | 复用 + 薄新建 |

---

## 4. 关键接口与类型对照表

### 4.1 DSH 侧（全部已由源码确认）

| 用途 | 接口 / 符号 | 位置 | 签名要点 |
|---|---|---|---|
| 插件入口 | Cordis object plugin | `vendor/cordis/src/registry.ts:130-132` | `apply(ctx, config)` **只两个参数** |
| 插件入口（类） | `extends Service` | `vendor/cordis/src/service.ts:57` | `super(ctx, 'serviceName')` |
| 资源释放 | `ctx.effect(fn)` | `vendor/cordis/src/fiber.ts:415-561` | 返回 disposer，支持 generator |
| 事件监听 | `ctx.on(name, cb)` | `vendor/cordis/src/events.ts:254` | 返回 disposer |
| 会话（live） | `ctx.sessions` | `core/session/src/index.ts:866` | `get(id)` `:1144` / `list()` `:1152` / `flush(s)` `:1111` |
| 会话（查询） | `ctx.sessionQuery` | `session-query/session-query/src/index.ts:97,105` | `readSession(id)` `:183` / `readSurface(id)` `:308` / `listSessions()` `:173` |
| 会话（持久化） | `ctx.sessionPersistence` | `session-persistence/src/index.ts:135,137` | `open(id,'read')` `:162` / `stat` `:191` / `list` `:198` |
| 句柄读取 | `SessionHandle.read()` | `session-persistence/src/handle.ts:83` | `(offset?, length?, opts?) => { eventState, events }` |
| 模型调用 | `ctx.llm` | `llm/llm/src/index.ts:53-55,330` | `stream(options)` `:1093` / `prepareCall` `:904` |
| 工具注册 | `ctx.tools.register()` | `core/tools/src/index.ts:1027` | 返回 disposer |
| 提示词 | `ctx.systemPrompt.section()` | `core/system-prompt/src/index.ts:448` | 返回 disposer |
| 会话事件 | `'session/event'` | `core/session/src/index.ts:72` | `(session, event) => void`，fire-and-forget |
| 会话事件 | `'session/flush'` | `core/session/src/index.ts:81` | `(session) => Promise<void> \| void`，await |
| 会话事件 | `'session/created'` | `core/session/src/index.ts:50` | 同步 throw 可否决 |
| 会话事件 | `'session/disposed'` | `core/session/src/index.ts:60` | ⚠ 此时 flush 已不可用 |
| Agent 事件 | `'agent/turn-stopping'` | `core/agent/src/runtime-types.ts:387` | serial，被 await |
| Agent 事件 | `'agent/status'` | `core/agent/src/runtime-types.ts:277` | fire-and-forget |
| 注入消息 | `agent.inject()` | `core/agent/src/runtime-types.ts:241` | 实现在 `agent-loop/src/agent.ts:141` |
| 消息来源 | `MessageSourceMap` | `llm/llm/src/message.ts:102-107` | 4 种 kind |
| 上下文形式 | `ContextForm` | `llm/llm/src/message.ts:50-62` | 含 `'recall'` |
| 会话事件表 | `SessionEventMap` | `core/session/src/types.ts:266-382` | 12 种 |
| 窗口终点 | `'turn/end'` | `core/session/src/types.ts:282` | `{ turn, reason }` |
| 会话 header | `SessionHeader` | `core/session/src/types.ts:91-128` | ⚠ **无 userId** |
| 日志白名单 | `KNOWN_SESSION_EVENT_TYPES` | `core/session/src/known-event-types.ts:22` | ⚠ build 静态集 |

### 4.2 Ledger 侧（全部已由源码确认）

| 符号 | 位置 | 说明 |
|---|---|---|
| `MemoryLedger.open()` | `ledger.js:94-116` | 打开/初始化仓库 |
| `MemoryLedger.apply(proposal, {signal})` | `ledger.js:191-403` | **唯一写入入口**，含锁+提交+receipt+outbox |
| `MemoryLedger.pendingOutbox()` | `ledger.js:407` | 投影队列 |
| `MemoryLedger.ackOutbox(id)` | `ledger.js` | 确认已索引 |
| `RepoLock.acquire()` | `lock.js:110-118` | 跨进程锁 |
| `RepoLock.heartbeat()` | `lock.js:180-195` | 慢提交保活 |
| `ProjectionIndex` | `projection.js:23-155` | SQLite FTS5 |
| `ProjectionIndex.replay()` | `projection.js:97-115` | 消费 outbox |
| `ProjectionIndex.rebuild()` | `projection.js:130-155` | ⚠ **生产路径从未调用** |
| `ProjectionIndex.close()` | `projection.js:76-78` | 唯一的资源释放 |
| `GitLedgerAdapter` | `adapter.js:1-218` | Mnemon 形状包装 |
| `GitLedgerAdapter.dispose()` | `adapter.js:176-179` | → `ProjectionIndex.close()` |
| `descriptor` | `descriptor.js:1-42` | 能力真相表 |
| `evidenceHooks` | `index.js:29-30` | 证据钩子注册表 |

---

## 5. 现有代码：可复用与需改造清单

### 5.1 文件级判定

> 依据：[C-ledger-reuse.md](_investigation/C-ledger-reuse.md) §1、§5，Lead 已抽查核实。

| 判定 | 文件 | 行数 | 理由 |
|---|---|---|---|
| 🟢 **原样保留** | `src/ledger.js` | 518 | 只 import node 内置 + 本包 |
| 🟢 **原样保留** | `src/projection.js` | 241 | 只 import `node:sqlite` |
| 🟢 **原样保留** | `src/lock.js` | 209 | 只 import node 内置 |
| 🟢 **原样保留** | `src/git.js` | 171 | 只 import node 内置 |
| 🟢 **原样保留** | `src/schema.js` | 189 | 只 import `node:crypto` |
| 🟡 **原样保留 + 复用** | `src/descriptor.js` | 42 | 零 import；复用为能力真相表 |
| 🟡 **原样保留（双轨）** | `src/adapter.js` | 218 | 零外部框架 import，但接口形状是 Mnemon 的。留作回退路径 |
| 🔴 **不改造、DSH 不引用** | `src/index.js` | 72 | 唯一真 SDK import。保持原样，新插件不 import 它 |
| ⬜ **新建** | `src/dsh-plugin.js` | ~150 | Cordis 插件入口 |
| ⬜ **新建** | `cordis.patch.yml` | ~20 | Bundle patch |
| 🔴 **需修改** | `package.json` | 27 | 加 `dsh.bundle` / `main` / exports / 修 test 脚本 |
| ⚪ **抛弃重写** | — | **0** | 无需重写任何文件 |

**核心数字**：**1370 / 1660 行 = 82.5% 一个字符不动。**

### 5.2 复用边界的关键洞察

> **除 `src/index.js` 这 72 行外，全包对 Mnemon 的依赖只在「接口形状」层，不在「代码引用」层。**

- `src/` 下 8 个文件对 `@deepseek-ai/cordis` **零 import**（Cordis 只在 SDK 内部被用）
- `adapter.js` 甚至不 import 任何 SDK 符号 —— 是**纯鸭子类型实现**
- 这意味着 5 个核心文件可以**物理复制到任何 Node ≥22.5 项目零改动运行**

### 5.3 现有 `package.json` 为什么不能被当作 Bundle 加载

对照 DSH Bundle 约定（`app-boot/src/profile.ts:789-798`），**缺三样**：

| 缺失 | 后果 | 依据 |
|---|---|---|
| 无 `dsh.bundle.patch` | `profile.ts:793-795` **直接 throw**；`plugin.ts:44` 判为非 bundle | 硬阻塞 |
| 无 `cordis.patch.yml` 文件 | 无 patch 可加载 | 硬阻塞 |
| 无 `main` 字段 | 非致命（loader 走 `exports["."]`） | 软 |
| `private: true` | 不影响本地安装 | 无 |

### 5.4 生命周期绑定方案

现有真实资源**只有一个**：`DatabaseSync` 句柄（`projection.js:29`，WAL 模式还有 `-wal` / `-shm`）。

**现有代码确实会 close**，唯一路径：
```
adapter.dispose()  (adapter.js:176-179)
  → ProjectionIndex.close()  (projection.js:76-78)
    → db.close()
```

**映射到 Cordis 只需一行**：

```js
ctx.effect(() => () => adapter.dispose())
```

**⚠ 不要给 `MemoryLedger` / `RepoLock` / `GitRepo` 加 `dispose`** —— 它们**都没有持久的句柄**：
- git 每次现 spawn 子进程
- lock 只有 `release()`
- ledger 无 `close()`

**惰性打开是优势**：`adapter.js:51-62` 的 `space()` 惰性打开 → 没用到的适配器**零资源**。所以注册 disposer 即可，无需等首次使用。

### 5.5 七条不变量与去 SDK 后的影响

> 依据：[C-ledger-reuse.md](_investigation/C-ledger-reuse.md) §3（表格），Lead 抽查 §5。

| # | 不变量 | 守护机制 | 去 SDK 后 |
|---|---|---|---|
| I1 | **Git 唯一权威** | 读取全走 `git show <commit>:<path>`，**从不读工作树**（`ledger.js:118-133,140-177`；`git.js:121-133`） | 🟢 不破 |
| I2 | **写只在真 commit 后成功** | commit 抛错 → `restorePaths` → 抛 `GitError`；receipt/outbox 在 commit **之后**（`ledger.js:382-402`） | 🟢 不破 |
| I3 | **SQLite 可重建** | 只索引 `commitExists()` 为真的提交（`projection.js:101`）；ack 在 index 之后（`:111`）；UPSERT 幂等；rebuild 从 HEAD tree 重放（`:130-155`） | 🟢 不破（有运行期缺口，见 §9 风险） |
| I4 | **跨进程锁** | `mkdir` 原子（`lock.js:135`）；owner.json 缺失**绝不当空闲**（`:59-73,89-108`）；rename 让位唯一回收（`:148-162`）；commit 前 heartbeat（`ledger.js:385`） | 🟢 不破 |
| I5 | **owner 隔离** | 双重校验 manifest + proposal（`ledger.js:112-114` 开仓、`206-208` 写入；`schema.js:94`） | 🟢 不破，**但默认值有坑**（§2.7） |
| I6 | **失败不误报成功** | 三层守卫（`ledger.js:387-396`；`adapter.js:131-139,152-155`；`git.js:56-61`） | 🟡 **边缘破损**：翻译层重写需重新保证 |
| I7 | **证据强制** | 三层闸（`schema.js:116-121,155`；`adapter.js:131-139`；`ledger.js:244,363`），且记录真实验证结果不伪造 | 🟢 不破 |

### 5.6 测试现状：数字对，命令错

**静态计数 = 31，与背景一致**：
- `test/adapter.test.js`：3（`:32`、`:43`、`:80`）
- `test/ledger.test.js`：12（T1–T10 + owner）
- `test/hardening.test.js`：16（H1–H5）
- `helpers.js` / `writer-child.mjs`：0

**🔴 但 `"test": "node --test test/"`（`package.json:17`）必然失败。**

【已由源码确认 + 本机实测】Node 22/24 把位置参数当模块路径/glob，不再当目录递归根 → `MODULE_NOT_FOUND`，exit 1。
可用形态：`node --test "test/*.test.js"`。

> **所以「31 个测试全部通过」不可能来自 `npm test`。** 真实运行结果与所用命令**【尚待实验验证】**（本轮禁跑）。

**SDK 依赖程度：仅 1/31**
`grep 'cordis|dsh-mnemon|@deepseek-ai' test/` → 3 处，全在 `adapter.test.js`：`:45` 字符串、`:88` 字符串、**`:81` 是唯一真 import**。

| 测试文件 | 用例 | 去 SDK 后 |
|---|---|---|
| `ledger.test.js` | 12 | ✅ 100% 原样可跑 |
| `hardening.test.js` | 16 | ✅ 100% 原样可跑（含 8 个真跨进程用例） |
| `adapter.test.js:32,:43` | 2 | ✅ 原样可跑 |
| `adapter.test.js:80` | 1 | ❌ 需重写为 dsh-plugin harness |

> **30/31 = 96.8% 删掉 SDK 后原样可跑。**「证明去掉 Mnemon SDK 后 Ledger 仍正确」几乎不需要新测试。

---

## 6. 三条关键调用链（附真实路径、符号、行号）

### 6.1 调用链 A：从 CLI 启动到 Bundle patch 真正装载

```
① apps/cli/src/bin.ts                        → 解析 argv
② apps/cli/src/args.ts:118 parseDshArgs      → mode='profile'
③ apps/cli/src/profile-boot.ts:210 runProfile
④ apps/cli/src/profile-boot.ts:119 prepareProfile
     └─ 写入 cordis.yml = "[]"（:81-85）
⑤ packages/boot/app-boot/src/profile.ts:820 loadProfile
⑥ packages/boot/app-boot/src/profile.ts:789 bundles.map
     ├─ :790 resolveBundleDir(packageName, installAnchor, profileDir)
     ├─ :792 bundleManifest.dsh?.bundle?.patch        ★ Bundle 声明解析
     └─ :797 loadOverlayPatches(patchPath)
⑦ packages/boot/app-boot/src/index.ts:295 loadOptionalPatches
     └─ :350 parsePatchList → yaml.load(schema: entryListSchema)
     └─ :326 anchorInsertedPluginNames（相对路径 → file://）
⑧ apps/cli/src/profile-boot.ts:264 boot(...)
⑨ packages/boot/app-boot/src/index.ts:787 boot
     ├─ :801 ctx.plugin(Loader)
     └─ :804 mountRootInclude → :553 ctx.loader.create({id:'include', name:'cordis:include'})
⑩ vendor/include/src/index.ts:58 applyEntryPatches(data, patches, warn)
     ├─ :66-75 buildMap(entry.id)                     ★ patch 索引键 = 裸 id
     ├─ :80-103 insert 分支
     ├─ :110-114 id 未命中 → warn + continue           ★ include:xxx 在此静默失效
     └─ :121-124 覆盖是整块替换
⑪ vendor/include/src/index.ts:317 root.update()
     └─ vendor/cordis-plugin-group/src/index.ts:71 Promise.allSettled(config.map(create))
⑫ packages/boot/app-boot/src/index.ts:812 loader.await()
⑬ packages/boot/app-boot/src/index.ts:722 assertEntriesActivated
     ├─ :688 assertEntriesLoaded（fiber undefined → throw）
     ├─ :732 FAILED → await fiber.await() 重抛原始 stack
     └─ :741 PENDING → 打印缺失的注入服务名
```

**这条链证明**：`dsh.bundle.patch` → `loadOverlayPatches` → `applyEntryPatches` → `loader.create` → `assertEntriesActivated` 是**一条完整的、有硬性失败检查的装载链**。

### 6.2 调用链 B：一次 turn 结束 → 提取 → 写入 Git

```
① packages/core/agent-loop/src/agent.ts:330  session.append('turn/end', { turn, reason })
② packages/core/session/src/index.ts:678    Session.append()
     ├─ :713-714  collectSessionCallbacks(emitCtx, [carrier,'session/event',...])
     ├─ :721      this.log.push(event)
     └─ :719      invokeContainedSessionObservers(...)   ← post-commit, fire-and-forget
③ packages/core/session/src/index.ts:378    invokeContainedSessionObservers
     ├─ :303 callback(...args)
     └─ :304-306 void Promise.resolve(returned).catch(err => logger.warn(...))
④ ── 进入我们的插件 ──
   ctx.on('session/event', async (session, event) => {
     if (event.type !== 'turn/end') return          // ① 只认 turn/end
     if (event.data.reason.kind !== 'completed') return // ② 只认成功结束
     const snapshot = await ctx.sessionQuery.readSession(session.id)  // ③ 全量+回放校验
     const window = sliceByTurn(snapshot.events, event.data.turn)
     const evidence = window.filter(isHumanEvidence)  // ④ source.kind 判别
     if (evidence.length === 0) return                 // ⑤ 证据不足 → 不写
     const candidates = await extract(ctx.llm, evidence) // ⑥ 模型提取
     const proposal = validate(candidates, evidence)   // ⑦ source_refs 校验
     await ledger.apply(proposal)                      // ⑧ 复用现有写入
   })
⑤ packages/session-query/session-query/src/index.ts:183 readSession
     ├─ :184  this._corpus.load(sessionId)   （live 优先，corpus.ts:91）
     ├─ :185-190 Session.create(...)          ← 回放校验，坏日志会抛错
     └─ :191-195 返回 { session, events }
⑥ packages/provider-git-ledger/src/ledger.js:191 MemoryLedger.apply(proposal, {signal})
     ├─ :218  await this.lock.acquire()                ← 跨进程锁
     ├─ :227  幂等重检
     ├─ :375-380 写记录 + 变更说明
     ├─ :386  await this.git.commitPaths(touched, msg) ← 真正提交
     ├─ :387-396 失败 → restorePaths + 抛 GitError     ← 不误报
     ├─ :400  写 receipt（幂等）    ⚠ 见 §9 风险 R2
     └─ :401  写 outbox（投影队列）
⑦ packages/provider-git-ledger/src/projection.js:97 replay()
     ├─ :100  ledger.pendingOutbox()
     ├─ :101  git.commitExists(entry.commit)  ← 只索引真实提交
     └─ :111  ledger.ackOutbox(...)
```

### 6.3 调用链 C：记忆注入 → 避免自我污染

```
① 新 turn 开始：packages/core/agent-loop/src/agent.ts:266 session.append('turn/start')
② 我们的插件在 'session/created' 或 turn/start 后检索
③ 构造注入消息，必须带 source：
   agent.inject(createUserMessage({
     content: [{ type: 'text', text: memoryBlock }],
     source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
   }))                                              ★ 关键
   （createUserMessage 在 llm/llm/src/message.ts:194；inject 在 agent-loop/src/agent.ts:141）
④ 该消息进入 inbox → 被 claim → append 为 'user/message'
   （core/agent-loop/src/inbox.ts:111 claim；agent.ts:294 append）
⑤ 下一个 turn 提取时，判别式把它排除：
   function isOwnEvidence(m) {
     return m.source.kind === 'plugin' && m.source.plugin === 'dsh-memory'
   }
   → 我们的 source_refs 校验会拒绝任何指向 kind==='plugin' 事件的引用
⑥ 真实先例（DSH 自己的做法）：
   packages/core/agent-loop/src/runtime-context.ts:12,15
     const SOURCE = '@deepseek-ai/dsh-system-prompt'
     function isOwned(message) {
       return message.source.kind === 'plugin' && message.source.plugin === SOURCE
     }
   packages/session/session-title/src/index.ts:132
     event.data.source.kind !== 'user'  ← 排除所有注入
   packages/guard/repeat-tool-reminder/src/index.ts:57
     const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'repeat-tool-reminder' }
```

**这条链证明**：DSH 已经为「插件识别自己的内容」提供了**第一方模式**，我们只需遵守约定，不需要发明机制。

**⚠ 但有一个必须承认的缺口**：如果别的插件也用 `kind:'user'` 注入（如 `/goal`、headless），我们的判别式会**误收**。缓解手段：
- 只信 `rpcId` 存在时的高置信路径
- 对无 `rpcId` 的 user 消息**降置信度**并标注
- 在记忆记录里保存 `evidence_confidence`

---

## 7. 推荐的原生插件目录结构

```
F:\deepseek-memory\
├── packages/
│   ├── provider-git-ledger/          ← 现有，几乎不动
│   │   ├── src/
│   │   │   ├── ledger.js             🟢 不动
│   │   │   ├── projection.js         🟢 不动
│   │   │   ├── lock.js               🟢 不动
│   │   │   ├── git.js                🟢 不动
│   │   │   ├── schema.js             🟢 不动
│   │   │   ├── descriptor.js         🟢 不动（被新插件复用）
│   │   │   ├── adapter.js            🟢 不动（留作回退）
│   │   │   └── index.js              🟢 不动（DSH 不引用）
│   │   ├── test/                     🟢 不动（31 条）
│   │   └── package.json              🔴 改（见下）
│   │
│   └── dsh-memory/                   ⬜ 新建：DSH 原生插件包
│       ├── package.json              name: dsh-memory
│       │                              + dsh.bundle.patch: './cordis.patch.yml'
│       │                              + main / exports
│       ├── cordis.patch.yml          ⬜ Bundle patch（id 必须裸写！）
│       ├── src/
│       │   ├── index.js              ⬜ Cordis 插件：apply(ctx, config)
│       │   ├── config.js             ⬜ schemastery Config
│       │   │                            ownerId: 必填（无兜底）
│       │   │                            dataDir / autoApprove / tokenBudget
│       │   ├── service.js            ⬜ extends Service，注册 ctx.effect 生命周期
│       │   ├── extractor.js          ⬜ turn 窗口提取（调 ctx.llm）
│       │   ├── evidence.js           ⬜ L0 证据引用与校验
│       │   ├── records.js            ⬜ L1 记录结构
│       │   ├── retriever.js          ⬜ 检索 + token 预算裁剪
│       │   ├── injector.js           ⬜ 注入（source.kind='plugin', form='recall'）
│       │   ├── cursor.js             ⬜ extraction-state 游标（Git 内）
│       │   ├── rollup-l2.js          ⬜ L2 从 L1 重算
│       │   ├── rollup-l3.js          ⬜ L3 从 L1 跨会话重算
│       │   └── ledger-bridge.js      ⬜ 用 descriptor 真相表驱动旧核心
│       └── test/
│           ├── load.spec.js          ⬜ 1 条：能否被 Cordis 装载
│           ├── extract.spec.js       ⬜ 提取窗口与 source 过滤
│           ├── evidence.spec.js      ⬜ source_refs 校验
│           ├── lifecycle.spec.js     ⬜ dispose 后 sqlite 真关
│           └── e2e-propose.spec.js   ⬜ 端到端：假会话 → 真 Git 提交
├── docs/
│   ├── _investigation/               ← 本轮调查笔记（草稿）
│   └── dsh-native-memory-plugin-investigation.md   ← 本报告
└── ...
```

### 7.1 `cordis.patch.yml` 的正确内容（约 20 行）

```yaml
# dsh-memory bundle patch
# 覆盖在 dsh-base 之上。id 必须是裸 id（不要写 include:xxx）。
- insert:
    - id: dsh-memory
      name: 'dsh-memory'                 # 包名；本地开发也可用 ./dist/index.js
      inject: [sessions, sessionQuery, llm, tools, systemPrompt]
      config:
        ownerId: !!js process.env.DSH_MEMORY_OWNER   # 必填，缺失即抛错
        autoApprove: false                            # 默认人工确认
        dataDir: !!js dshHomePath('memory-ledger')
        tokenBudget: 2000
        recallLimit: 8
```

**⚠ 三点注意**
1. `inject` 里列出的是**必需服务**。若某个服务不存在，该行会 `PENDING` 并让 boot **失败**（`app-boot/src/index.ts:741-743`）。这是 fail-loud，符合预期，但首阶段要**只声明真正必需的服务**。
2. `!!js` 表达式在行内是延迟求值到该行自己的 fiber context（`vendor/include/src/index.ts:178-181` 注释）。
3. 若 `ownerId` 环境变量缺失，`!!js` 会得到 `undefined` → 由我们的 Config 校验抛错 → **boot 失败**。这是**有意的**（见 §9 R3）。

### 7.2 `packages/provider-git-ledger/package.json` 需要的 6 处改动

```jsonc
{
  "name": "dsh-mnemon-provider-git-ledger",
  "main": "./src/adapter.js",              // ① 新增（非致命，但清晰）
  "exports": {
    ".": "./src/adapter.js",               // ② 从 src/index.js 改为 adapter.js
    "./ledger": "./src/ledger.js",
    "./cordis.patch.yml": "./cordis.patch.yml",  // ③ 新增
    "./package.json": "./package.json"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },  // ④ 新增
  "scripts": {
    "test": "node --test \"test/*.test.js\""  // ⑤ 修复（原命令必然失败）
  }
  // ⑥ 考虑 private: false（若要从 registry 安装）
}
```

> **注意**：如果你希望记忆插件是**独立包**（推荐），则 `provider-git-ledger` 只需 ⑤ 一处修复，其余改动都发生在新的 `packages/dsh-memory/package.json` 里。这样旧包保持其 Mnemon 兼容身份不变，回退路径完整。

---

## 8. 分阶段实施计划

> **总原则**：每个阶段只交付**一个可独立验收的能力**，失败可回滚。

### 阶段 0：建立基线（不改任何源码）

| 项 | 内容 |
|---|---|
| **做什么** | ① 用正确命令跑现有测试，记录真实基线<br>② 只读导出当前 profile 状态 |
| **命令** | `cd packages/provider-git-ledger; node --test "test/*.test.js"`<br>`dsh --profile web --dump-config > /tmp/before.yml` |
| **复用** | 现有 31 条测试 |
| **验证成功** | 测试全绿（或明确记录哪条失败）；`before.yml` 已保存 |
| **失败回滚** | 无需回滚（只读） |
| **风险** | 若测试失败，说明「31/31 通过」不成立，**必须先修好再加新功能** |

> **这一步必须先做**：如果基线是坏的，后面所有「回归通过」都无意义。

### 阶段 1：新建插件骨架，能加载、能释放（不含任何记忆逻辑）

| 项 | 内容 |
|---|---|
| **修改文件** | 新建 `packages/dsh-memory/{package.json, cordis.patch.yml, src/index.js, src/config.js, src/service.js}`<br>新建 `packages/dsh-memory/test/load.spec.js` |
| **复用模块** | 无（纯骨架） |
| **新增模块** | `index.js`（apply 只做 3 件事：校验 config、注册服务、注册 effect）<br>`config.js`（schemastery，`ownerId` 必填） |
| **依赖的已验证接口** | Cordis object plugin `apply(ctx, config)` 两参数（`registry.ts:130-132`）<br>`ctx.effect`（`fiber.ts:415-561`）<br>`extends Service` + `super(ctx, name)`（`service.ts:57`）<br>`dsh.bundle.patch` 解析（`profile.ts:792`） |
| **验证成功** | ① `dsh plugin --profile memtest add ./packages/dsh-memory`<br>② `dsh --profile memtest --dump-config \| grep dsh-memory` → **行存在**<br>③ `dsh --profile memtest --dump-config 2>&1 \| grep 'not found'` → **必须无输出**（证明 patch id 写对了）<br>④ 实际 boot 一次，Web GUI **Settings → Plugins → All** 看到 `dsh-memory` 状态 `active`<br>⑤ 退出时无泄漏警告 |
| **失败回滚** | `dsh plugin --profile memtest remove dsh-memory`（或删 profile 目录）。**不触碰任何现有代码** |
| **验收要点** | 必须同时通过 L2（boot 不失败）和 L3（inventory 显示 active）—— **只过 L1 不算通过** |

### 阶段 2：最小会话证据读取（只读，不写任何记忆）

| 项 | 内容 |
|---|---|
| **修改文件** | `src/evidence.js`（新增）、`src/index.js`（注册 `session/event` 监听） |
| **复用模块** | 无 |
| **新增模块** | 监听 `turn/end`，读会话事件，按 turn 切窗口，按 `source.kind` 分类，**只打结构化日志/写临时文件**，不写 Git |
| **依赖的已验证接口** | `ctx.on('session/event')`（`session/src/index.ts:72`，fire-and-forget）<br>`ctx.sessionQuery.readSession(id)`（`session-query/src/index.ts:183`，含回放校验）<br>`'turn/end'` + `TurnEndReason`（`types.ts:282,198-219`）<br>`MessageSourceMap`（`message.ts:102-107`） |
| **验证成功** | 跑一个真实对话，观察：<br>① 每个 `turn/end` 都触发了<br>② 窗口内事件数与实际一致<br>③ **分类正确**：真实用户消息 / 插件注入 / 工具结果 各自归位<br>④ 压缩过的会话仍能拿到原始 append-origin 事件 |
| **失败回滚** | 移除监听即可，无持久化副作用 |
| **关键验收** | **必须验证 `rpcId` 判别在 CLI 下是否可用（实验 E1）**。若不可用，此阶段就要定下降级策略 |

### 阶段 3：L0→L1 提取与正式写入（第一个真正写数据的阶段）

| 项 | 内容 |
|---|---|
| **修改文件** | `src/extractor.js`、`src/records.js`、`src/ledger-bridge.js`（新增）；`src/config.js` 加 `autoApprove` |
| **复用模块** | `ledger.js` / `lock.js` / `projection.js` / `git.js` / `schema.js` / `descriptor.js` **全部原样** |
| **新增模块** | 提取器（调 `ctx.llm.stream`）、L1 记录结构、`ledger-bridge.js`（把 L1 记录翻译成 `ledger.apply` 的 proposal） |
| **依赖的已验证接口** | `ctx.llm.stream(options)`（`llm/src/index.ts:1093`）<br>`MemoryLedger.apply(proposal, {signal})`（`ledger.js:191-403`）<br>`RepoLock.acquire/heartbeat`（`lock.js:110,180`）<br>`source_refs` 校验（`schema.js:116-121`） |
| **验证成功** | ① 端到端：真实会话 → 一条 L1 记忆 → `git log` 有提交，commit message 含 reason<br>② `git show` 能看到记录文件与变更说明<br>③ sqlite 投影里能 FTS 检索到<br>④ **证据不足时零写入**（构造一个纯插件注入的 turn，验证不产生任何提交）<br>⑤ **owner 必填**：不配 `ownerId` 时 boot 失败，而非静默用默认值 |
| **失败回滚** | Git 天然回滚：`git reset --hard <上一提交>`。但要注意**投影需 `rebuild()`** —— 而现有 `rebuild()` **生产路径从未调用**，此阶段必须补上调用点 |
| **关键风险** | 见 §9 R2（receipt 窗口）。**必须在 bridge 层把它包进 try 并转化为可重试状态** |

### 阶段 4：下一次会话的真实检索与注入

| 项 | 内容 |
|---|---|
| **修改文件** | `src/retriever.js`、`src/injector.js`（新增） |
| **复用模块** | `projection.js` 的 FTS5 查询 |
| **新增模块** | 检索器（owner 过滤 + token 预算）、注入器（`systemPrompt.section` 或 `agent.inject`） |
| **依赖的已验证接口** | `ctx.systemPrompt.section()`（`system-prompt/src/index.ts:448`）<br>`agent.inject()`（`agent/src/runtime-types.ts:241`）<br>`ContextForm = 'recall'`（`message.ts:62`）<br>FTS5 trigram 中文可用**【已实测】** |
| **验证成功** | ① 新会话能检索到上一会话写入的记忆<br>② 注入内容**带 `source.kind='plugin'`**<br>③ **反向验证**：连续两个 turn，第二个 turn 的提取**不包含**第一个 turn 注入的记忆<br>④ token 预算生效（超长时被裁剪而非截断 JSON） |
| **失败回滚** | 关闭注入开关（config 项），检索代码可留 |
| **关键验收** | ③ 是**防自我污染的核心验收**。必须有专门测试 |

### 阶段 5：用户纠正与撤回（UPDATE / RETRACT / SUPERSEDE）

| 项 | 内容 |
|---|---|
| **修改文件** | `src/correct.js`（新增）；`src/index.js` 注册纠正工具 |
| **复用模块** | `schema.js` 的 `UPDATE` / `RETRACT` 支持；`ledger.js` 的变更记录与 `renderChangeNote` |
| **新增模块** | 纠正意图解析（自然语言 → 目标记忆定位）、变更提案生成 |
| **依赖的已验证接口** | `ctx.tools.register()`（`tools/src/index.ts:1027`）<br>`ledger.apply` 的 `change_type` |
| **验证成功** | ① 用户说「不对，是 X」→ 定位到旧记忆 → UPDATE 成功，Git 有 before/after<br>② RETRACT 后**普通检索不召回**，但 `git log` 仍可查审计<br>③ SUPERSEDE：新记忆替代旧记忆，两条都在，检索只召回新的<br>④ 定位歧义时**问用户**而不是猜 |
| **失败回滚** | 每种变更都是独立 commit，可单独 revert |
| **数据边界** | **⚠ 必须明确告知用户：RETRACT/SUPERSEDE 只影响检索，原始 Git 历史仍保留。FORGET 才是真删，且不保证会话日志被删**（见 §9 R6） |

### 阶段 6：引入 L2 项目状态与 L3 长期画像

| 项 | 内容 |
|---|---|
| **修改文件** | `src/rollup-l2.js`、`src/rollup-l3.js`（新增） |
| **复用模块** | 全部现有 |
| **新增模块** | 从 L1 重算的聚合器（**不新建独立真相**） |
| **验证成功** | ① 删掉 L2/L3 产物后能**从 L1 完整重算**且结果一致（幂等性）<br>② L1 被 RETRACT 后，L2 重算能正确剔除<br>③ L3 需跨 ≥N 个会话的高置信证据才成立 |
| **失败回滚** | 删 L2/L3 产物即可，L1 不受影响 |
| **关键设计** | **L2/L3 必须标 `derived: true`**，检索时优先 L1；派生层不可作为纠正目标 |

### 阶段 7：回归测试、故障注入与数据清除验收

| 项 | 内容 |
|---|---|
| **修改文件** | `packages/dsh-memory/test/*`（新增若干）；`docs/` 运维文档 |
| **测试矩阵** | ① **回归**：30 条原样 + 新插件测试<br>② **故障注入**：git 不可用 / 磁盘满 / sqlite 损坏 / 锁竞争超时 / 模型超时 / 会话读取失败<br>③ **并发**：两进程同时写（复用 `hardening.test.js` 的跨进程手法）<br>④ **恢复**：写入中途 kill -9，重启后游标正确、无重复记忆<br>⑤ **数据清除**：FORGET 后 Git 无该记录，**并明确记录残留仅在会话日志** |
| **验证成功** | 故障注入全部表现为「明确失败 + 无脏数据」，而不是「静默成功」或「数据在但看不见」 |
| **回滚** | 测试全在临时目录 + 临时 `DSH_HOME`，不碰真实数据 |

---

## 9. 风险清单

| # | 风险 | 类型 | 严重度 | 证据 | 缓解 |
|---|---|---|---|---|---|
| **R1** | **`include:` 前缀 patch id 静默失效** | 兼容性 | 🔴 高 | `vendor/include/src/index.ts:66-75` 用裸 id 建索引；`:110-114` 未命中只 warn | id **一律裸写**；CI 里 `dump-config 2>&1 \| grep 'not found'` 必须为空 |
| **R2** | **receipt 写失败 → 数据在 Git 但永不索引** | 数据正确性 | 🔴 高 | `ledger.js:400-401` 在 commit（:386）**之后**、**不在任何 try 内**。异常冒泡 → adapter 报 failed，但 outbox 没写成 → `replay()` 永不索引，而 `rebuild()` **生产路径从未调用** | 在 `ledger-bridge.js` 包 try，转为 `needs-reindex` 状态；**启动时补调 `rebuild()`** |
| **R3** | **owner 默认值 `'local-user'` 导致跨用户越权** | 权限隔离 | 🔴 高 | `index.js:57` `ownerId ?? 'local-user'` vs `descriptor.js:37` `required: true` **自相矛盾** | 新插件 Config 里 `ownerId` **必填无兜底**，缺失即 boot 失败 |
| **R4** | **`source.kind:'user'` 误判为人类输入** | 证据来源 | 🔴 高 | headless `bundle/headless/src/index.ts:199`、`/goal` `command-goal/src/index.ts:120`、ACP `acp/src/session.ts:296` 均用它 | 三档置信度：有 `rpcId` 高 / 无 `rpcId` 中 / `plugin` 排除。**记忆里存 `evidence_confidence`** |
| **R5** | **没有会话结束信号 → 可能只提取到半段对话** | 任务恢复 | 🟠 中 | B §3.1、§12 第 1 条；`agent/status:idle` 每个 turn 都出现（`agent.ts:230`） | 以 turn 为原子窗口；如要「对话级」提取则用时间阈值启发式并**明确标注为猜测** |
| **R6** | **FORGET 无法保证删除会话日志** | 数据删除 | 🟠 中 | 会话日志在 `$DSH_HOME/sessions/`（`session-persistence-jsonl`），Git 在 `dataDir`。**两套独立存储** | ① FORGET 只承诺删记忆仓库范围内数据<br>② 文档明确写清边界<br>③ 或提供「同时清理会话日志」的显式选项（需另写，且要处理 zstd 解压重写） |
| **R7** | **spill 导致工具结果原文不在日志里** | 证据来源 | 🟠 中 | spill 在 append **之前**发生（`spill-policy/src/index.ts:185-204`）；默认 50000 bytes 上限（`base/cordis.patch.yml:386`）；**30 天清理**（`spill-local/src/index.ts:68`） | 不能把大工具输出当长期证据；只存摘要 + `locator`；记忆里标注 `truncated: true` |
| **R8** | **压缩遮蔽历史（但原始 append-origin 事件仍在）** | 证据来源 | 🟡 低-中 | 压缩用 `surfaceOp: {op:'replace'}`（`types.ts:422-424`）；`isAppendSurfaceEvent`（`surface.ts:58`）注释明说 append-origin 是 transcript 的可靠来源 | **读原始 log 而非 surface**；用 `isAppendSurfaceEvent` 过滤 |
| **R9** | **自定义事件类型会让会话日志永久不可读** | 兼容性 | 🔴 高 | `KNOWN_SESSION_EVENT_TYPES` 是 **build 静态集**（`known-event-types.ts:22`）；未知类型未标 `ignorable: true` → `storage-contract.ts:75` **拒绝读取整条日志** | **绝不往会话日志写自定义事件**。游标写进 Git（§2.9）。若确需写入，`ignorable: true` 是唯一安全解 |
| **R9b** | **插件写 `session/end-seed` 会污染继承边界** | 数据正确性 | 🔴 高 | `types.ts:370-372` 明确「只有 constructor 可写」，并警告会让之前所有 live 事件被误判为 seed 历史 | 明确禁止。代码 review 时作为红线 |
| **R10** | **`session/disposed` 之后无法 flush** | 任务恢复 | 🟠 中 | `liveEntryFor`（`session/src/index.ts:1130-1137`）在 store 移除后抛错；`store.delete`（`:1045`）在 `emitDisposed`（`:1047`）**之前** | **不要**依赖「最后 flush 再提取」。必须每 turn 增量提取 |
| **R10b** | **fork 继承前缀被重复提取** | 数据正确性 | 🟠 中 | `inheritedEventCount`（`session/src/index.ts:443`）+ `session/end-seed`（`types.ts:381`） | 只看 `ownEvents()` / `isOwnSeq()`；`seq < inheritedEventCount` 一律剔除 |
| **R10c** | **崩溃合成的 closer 被当成真实事件** | 证据来源 | 🟡 中 | `repair.ts:29` `interruptedTurnClosers`，内存合成不落盘，`error.code` ∈ {`TOOL_OUTCOME_UNKNOWN`, `TOOL_NOT_STARTED`} | 按 `error.code` 显式剔除 |
| **R11** | **`session/event` 无顺序保证、无背压** | 并发 | 🟠 中 | fire-and-forget（`session/src/index.ts:378-396`），慢 handler 与后续事件并发交错 | 自建单会话串行队列（按 sessionId 排队），提取走队列 |
| **R11b** | **模型失败被转成「终止 chunk」而非抛错** | 数据正确性 | 🟠 中 | `adapterFailureChunk`（`llm/src/index.ts:1110`）把失败变成 `finish` chunk；不清查会误判为「模型没说话」 | 硬检查 `assembler.finish.kind`；空输出/失败/max-tokens → **不写入且不推进游标** |
| **R11c** | **`preparedCall.stream()` 只能调一次** | 实现复杂度 | 🟡 中 | 第二次抛 `INVALID_PREPARED_CALL`（`llm/src/index.ts:931-933`） | 重试必须重新 `prepareCall`，不能复用 |
| **R12** | **跨进程锁只覆盖 `apply()`，`open()` 无锁** | 并发 | 🟡 中 | `ledger.js:94-116` 首次初始化会写 manifest + commit，但锁只管 `:218` 之后 | 首次开仓也在锁内（或用 `mkdir` 幂等 + 容忍竞争） |
| **R13** | **Cordis 版本偏斜**（本包 devDep `4.0.5` vs DSH `vendor/cordis@4.0.2`） | 兼容性 | 🟡 中 | C §七 | 新插件**不 import cordis 本体**（只用 `ctx`），从根上避免 |
| **R14** | **`ctx.sessions.list()` 只列 live 会话** | 数据完整性 | 🟡 中 | `session/src/index.ts:1152` | 冷会话必须走 `ctx.sessionQuery.listSessions()` |
| **R15** | **模型一次性 API 不存在，只有 `stream()`** | 实现复杂度 | 🟡 中 | `llm/src/index.ts:1093` 是唯一抽象方法 | 自拼 `BlockAssembler` 收集 stream |
| **R16** | **`turn/end` 的 `reason` 有多种**，只有 `completed` 该提取 | 证据来源 | 🟡 中 | `TurnEndReasonMap`（`types.ts:198-219`） | 显式白名单，其余记录但不提取 |
| **R17** | **`user/message` 无 turn 号** | 实现复杂度 | 🟡 中 | `types.ts:294` 是 `UserMessage` 本身，无 turn/step | 用 `turn/start.seq < msg.seq < turn/end.seq` 折叠 |
| **R18** | **日志不能当探针** | 运维 | 🟡 中 | `logger.ts:213-221` 只进内存 buffer，无 console exporter | 用 L2/L3 验证，不看控制台 |

---

## 10. 最终结论

### 10.1 当前 DSH 源码是否具备实现该系统的必要能力

**具备。但有三个必须接受的结构性约束。**

#### 已有充分源码证据的部分

| 能力 | 状态 | 关键证据 |
|---|---|---|
| 插件发现/加载/初始化 | ✅ 完整 | `profile.ts:789-798` → `index.ts:787-834` → `include/index.ts:58` → `assertEntriesActivated:722` |
| Bundle 声明与 patch 关联 | ✅ 完整 | `dsh.bundle.patch` 解析 `profile.ts:792`；patch 语法 `sdk-minimal/cordis.patch.yml` |
| 注册服务/工具/提示词/事件 | ✅ 完整 | `service.ts:57`、`tools/src/index.ts:1027`、`system-prompt/src/index.ts:448`、`events.ts:254` |
| 取得会话/Agent/模型/持久化 | ✅ 完整 | 全部是 `ctx.<service>`，见 §4.1 |
| 资源释放 | ✅ 完整（机制特殊） | **只有 `ctx.effect`**，无 `ctx.on('dispose')`（`fiber.ts:415-561`） |
| 安装本地插件到独立 Profile | ✅ 完整 | `dsh plugin --profile x add ./path`（`plugin.ts:120`）+ 自动并入 bundles（`:59-91`） |
| 运行时确认插件已加载 | ✅ 完整（三层） | L2 `assertEntriesActivated`；L3 `pluginInventory.list()` |
| 读取已完成会话完整历史 | ✅ 完整 | `ctx.sessionQuery.readSession(id)`（`session-query/src/index.ts:183`，含回放校验）；`ctx.sessionPersistence.open(id,'read')`（`session-persistence/src/index.ts:162`） |
| 区分 user/assistant/tool/plugin | ✅ 完整 | `MessageSourceMap`（`message.ts:102-107`） |
| 避免自我污染 | ✅ 有第一方模式 | `runtime-context.ts:12,15` `isOwned()`；`ContextForm='recall'` |
| 模型调用 | ✅ 完整（仅流式） | `ctx.llm.stream()`（`llm/src/index.ts:1093`） |
| 复用 Git Ledger | ✅ 82.5% 零改动 | 见 §5 |
| 现有测试覆盖 | ✅ 31 条，30 条去 SDK 可跑 | 见 §5.6 |

#### 已有充分证据的**缺失**（不是遗漏，是架构选择）

| 缺失 | 影响 | 应对 |
|---|---|---|
| **无「会话结束」信号** | 无法一次性提取整段对话 | 以 turn 为原子窗口；对话级用时间阈值启发式 |
| **会话日志无 userId/owner** | 无法从会话推断记忆归属 | owner 必须显式配置 |
| **无 `ctx.on('dispose')`** | 裸资源会泄漏 | 一切包进 `ctx.effect` |
| **日志不可作探针** | 无法靠打印判断加载 | 用 pluginInventory |
| **会话日志事件表是 build 静态集** | 不能塞自定义事件 | 游标写进 Git |

#### 仍需通过后续实验验证的部分

| # | 待验事项 | 实验设计 | 阻塞哪个阶段 |
|---|---|---|---|
| **E1** | CLI 交互式输入是否带 `rpcId` | 隔离 `DSH_HOME=<tmp>`，CLI 交互输入一条 prompt，退出后只读解析 `v2.jsonl.zstd`，检查 `user/message.data.source` | 阶段 2 的证据判别策略 |
| **E2** | `session/flush` 后 Windows 上是否真 durable（fsync） | 隔离 home，短会话，flush 后立刻读文件比对 seq | 阶段 3 的窗口完整性假设 |
| **E3** | `agent/status:idle` → 下次 `turn/start` 的时间分布 | 真实使用中采样 | 若要「对话级」提取 |
| **E4** | 新插件能否真正 boot 成功（L2+L3） | 阶段 1 | 阶段 1 |
| **E5** | 现有 31 条测试真实运行结果 | 阶段 0，`node --test "test/*.test.js"` | 阶段 0 |
| **E6** | 装进 profile 后是否真的只有一份 cordis | `node -e "console.log(require.resolve('@deepseek-ai/cordis'))"` 在 profile 目录 | 阶段 1 |

### 10.2 推荐与取舍

**推荐方案：独立包 + 复用核心**

```
packages/provider-git-ledger/   ← 只修 test 脚本，其余不动（保留 Mnemon 兼容身份）
packages/dsh-memory/            ← 全新 DSH 原生插件，import 前者核心
```

**对比过的三个方案**

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **A. 改造现有包为 Bundle** | 一个包，结构简单 | 需在 `package.json` 同时承载 Mnemon 与 DSH 两套身份；`index.js` 的 Mnemon 依赖仍在；回退路径变窄 | ❌ 不推荐 |
| **B. 独立包 + 复用核心**（推荐） | 旧包身份不变可随时回退；新包可自由演进；`provider-git-ledger` 只需修 1 处 test 脚本 | 两个包需协调版本 | ✅ **推荐** |
| **C. 重写 Ledger** | 彻底干净 | 丢掉 31 条测试的已验证行为；违反「Git 唯一权威/可重建/并发锁」的实现细节需重新踩坑 | ❌ 明确排除 |

**取舍说明**

1. **为什么保留 Mnemon 兼容身份？** 因为 `provider-git-ledger` 的 31 条测试是**已验证的行为资产**。让它同时能被 Mnemon 和 DSH 用，等于多一条回退路径，成本只是 `package.json` 里多一个 `dsh` 字段。
2. **为什么新插件不 import `src/index.js`？** 它 import 了 `dsh-mnemon-source-memory-spaces/provider-sdk`，会把 Mnemon 依赖拖进来。新插件应只 import `./ledger`（已在 `exports` 里暴露为子路径）。
3. **为什么 owner 必须显式配置而不做智能推断？** 因为数据正确性优先级最高。任何「猜」的 owner 都可能导致跨用户串数据。宁可启动失败。

### 10.3 一句话回答你的原始问题

> **可以做到。** 你不需要 Mnemon 作为记忆框架 —— DSH 的 Cordis 插件机制 + `sessionQuery`/`sessionPersistence` 的会话读取 + `ctx.llm` 的模型调用 + 你已有的 Git Ledger 核心，已经构成完整闭环所需的全部部件。
>
> **但你必须放弃三个幻想**：(1) 「会话结束」信号不存在，只能用 turn 窗口；(2) `kind:'user'` 不等于人类输入，证据必须分置信度；(3) 会话里没有 userId，owner 必须自己配。
>
> **最大的两个工程风险不是架构，而是两处细节**：patch 的 `include:` 前缀会静默失效（§9 R1），以及 receipt 写失败会让数据「在 Git 里但检索不到」（§9 R2）。这两条在阶段 1 和阶段 3 就要解决。

---

## 附录：调查方法论与合规声明

### A. 本轮只读合规

- ✅ 未修改、创建、删除任何现有项目源码（`git status` 仅 `?? docs/`）
- ✅ 未安装/卸载/升级任何依赖
- ✅ 未修改任何 DSH Profile 或 `DSH_HOME` 数据
- ✅ 未启动 `dsh` 本体或任何会写会话/插件数据的程序
- ✅ 未修改 `package.json` / 锁文件 / Provider 代码
- ✅ 未创建 git 提交、未推送
- ✅ 未使用假想 API；所有接口均回到 `69646b1` 源码
- ✅ 唯一写入：`docs/_investigation/` 4 份调查笔记（明确标记为草稿）

### B. 证据交叉验证方式

三路独立调查（A/B/C）由不同执行者完成，Lead 对以下关键结论做了**亲自复核**：

| 结论 | 复核文件:行 | 结果 |
|---|---|---|
| `applyEntryPatches` 用裸 id 建索引 | `vendor/include/src/index.ts:66-75` | ✅ 一致 |
| base 的 tool 行 id 是裸 `tool-fs` | `packages/bundle/base/cordis.patch.yml:260` | ✅ 一致 |
| receipt 在 try 之外 | `ledger.js:387-401` | ✅ 一致 |
| Cordis apply 是两参数 | `vendor/cordis/src/registry.ts:130-132` | ✅ 一致 |
| `SessionHeader` 无 userId | `core/session/src/types.ts:91-128` | ✅ 一致 |
| `sessionQuery.readSession` 含回放校验 | `session-query/src/index.ts:183-196` | ✅ 一致 |
| `MessageSourceMap` 四种 kind | `llm/llm/src/message.ts:102-107` | ✅ 一致 |
| `ContextForm` 含 `'recall'` | `llm/llm/src/message.ts:62` | ✅ 一致 |
| `session/disposed` 在 store.delete 之后 | `core/session/src/index.ts:1045,1047` | ✅ 一致 |
| `rebuild()` 无生产调用点 | `projection.js:130` + 全 grep | ✅ 一致 |

### C. 本次调查的边界

**未做的事（需后续实验）**：
- 未运行任何一次 `dsh` 启动（因此所有 L2/L3 验证结论来自源码分析，非实测）
- 未运行现有 31 条测试（E5）
- 未实测插件能否 boot（E4）
- 未验证 `rpcId` 在 CLI 下是否存在（E1）
- Mnemon 源码不在仓库内，其挂载实现未读

**建议的下一步（等你确认后执行）**：
1. 阶段 0：用正确命令跑测试，确认基线
2. 实验 E1：在隔离 `DSH_HOME` 下确认 CLI 的 `rpcId` 情况
3. 阶段 1：搭骨架，验证加载与释放

---

*报告完成。本轮仅调查与设计，未修改任何代码。等待审阅。*
