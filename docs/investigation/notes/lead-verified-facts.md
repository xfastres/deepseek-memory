# Lead 独立核实事实清单（DSH 原生记忆插件调查）

> 调查对象：`F:\xufeng\deepseek\deepseek-harness-master`，git HEAD `69646b1`，根包 `@deepseek-ai/dsh-root@0.1.3-alpha.2`，pnpm 11.7.0，Node `^22.19.0 || >=24`。
> 本文件只记录 **Lead 亲自读源码确认** 的事实，用于交叉校验三名调查员的结论。

## 一、插件/Bundle 加载真实调用链（已由源码确认）

```
apps/cli/src/bin.ts
  └─ profile-boot.ts:210  runProfile(options)
       ├─ profile-boot.ts:119  prepareProfile(name)          // 首次自动 initProfile
       ├─ app-boot/src/profile.ts:820  loadProfile(...)
       │    ├─ profile.ts:824  resolveProfileDir → $DSH_HOME/profiles/<name>
       │    ├─ profile.ts:832  initProfile(...)              // 模板落盘（仅首次）
       │    └─ profile.ts:835  loadProfileDirectory(...)
       │         ├─ profile.ts:780  readProfileManifest      // 读 profile/package.json
       │         ├─ profile.ts:781  manifest.dsh.profile.bundles
       │         └─ profile.ts:789  bundles.map(...)          // 每个 bundle:
       │              ├─ profile.ts:790  resolveBundleDir     // 先安装锚点，后 profile
       │              ├─ profile.ts:792  bundleManifest.dsh.bundle.patch   ★ 关键字段
       │              ├─ profile.ts:796  patchPath = join(packageDir, declared)
       │              └─ profile.ts:797  loadOverlayPatches(binName, patchPath)
       ├─ profile-boot.ts:162  healProfilesModuleFallback    // 维护 node_modules 回退
       ├─ profile-boot.ts:163  loadOptionalPatches($DSH_HOME/cordis.patch.yml)
       ├─ profile-boot.ts:164  loadOverlayPatches(--patch 文件)
       ├─ profile-boot.ts:167  composeEntries([...4 层...])  // 只用于派生标志/探针
       └─ profile-boot.ts:264  boot(NAME, rootConfig, patches, prepare)
            └─ app-boot/src/index.ts:787  boot(...)
                 ├─ index.ts:794  new Context()
                 ├─ index.ts:801  ctx.plugin(Loader)          // Cordis Loader 服务
                 ├─ index.ts:802  prepare?.(ctx)              // 宿主准备（provide 环境快照）
                 ├─ index.ts:804  mountRootInclude(...)       // index.ts:516
                 │    └─ index.ts:553  ctx.loader.create({ id:'include', name:'cordis:include', config:{ path, patches } })
                 ├─ index.ts:812  ctx.get('loader').await()   // 等整棵树 settle
                 └─ index.ts:814  assertEntriesActivated      // 未激活即抛错（fail-loud）
```

**结论**：一个"原生插件"本质是一个 **Cordis 插件包**；一个"Bundle"是 **声明了 `dsh.bundle.patch` 的 npm 包**，其 patch 文件用 `insert:` 把插件行插进空根配置。

## 二、patch 文件真实语法（已由源码确认）

证据：`packages/bundle/sdk-minimal/cordis.patch.yml`（完整 168 行）；`packages/bundle/base/cordis.patch.yml`（487 行）。

顶层是 **YAML 数组**，元素是 loader patch 条目：
- `- insert: [ { id, name, config?, inject?, disabled? }, ... ]` — 往树里插入行
- `- id: <rowId>; config: {...}` — 按 id 覆盖已存在行（整体替换 config，不合并）
- `- id: <rowId>; disabled: true|!!js ...` — 禁用行
- `!!js <expression>` — 在行内可写 JS 表达式（如 `!!js process.platform === 'win32'`、`!!js dshHomePath('sessions')`）

**解析实现**：`app-boot/src/index.ts:350 parsePatchList` → `yaml.load(content, { schema: userPatchesSchema })`，其中 `userPatchesSchema = entryListSchema`（来自 `@deepseek-ai/cordis-plugin-include`，index.ts:225）。非数组即抛错（index.ts:359）。
**本地路径支持**：`index.ts:326 anchorInsertedPluginNames` — insert 行里 `name` 若是绝对路径或 `./`/`../` 开头，会被转成 `file://` URL（index.ts:330）。这是**本地开发插件**的关键机制。

## 三、本地插件安装机制（已由源码确认）

1. **`dsh plugin --profile <name> add <spec>`** — `apps/cli/src/plugin.ts:120 runPlugin`，本质是**在 profile 目录里转发 pnpm**（plugin.ts:134 `spawnSync('pnpm', ...)`）。
2. 安装后 `plugin.ts:59 reconcilePlugins` 按**已安装状态**回写 `dsh.profile.bundles`：凡解析出的包声明了 `dsh.bundle.patch`（plugin.ts:44），就追加进 bundles 列表。
3. 相对路径会被锚定到调用目录（plugin.ts:104 `anchorPathSpec`），所以 `add .` 或 `add ../my-plugin` 不会误指 profile 自身。
4. Profile 目录结构：`$DSH_HOME/profiles/<name>/`，含 `package.json`（`dsh.profile.bundles` + `patchReload`）、`cordis.patch.yml`（用户层）、`pnpm-workspace.yaml`（`nodeLinker: hoisted`、`autoInstallPeers: false`）。证据：`profile.ts:144-190`。
5. **`--patch <file>` 叠加**：`apps/cli/src/args.ts:138` 声明 `--patch` 可重复；`profile-boot.ts:164` 把它变成 overlay 层。**这是不装包也能试插件的最轻路径**（但要插件已能被 resolve）。

## 四、运行时确认插件是否真加载（已由源码确认）

- `dsh --profile <name> --dump-config`：`apps/cli/src/dump-config.ts:30 runDumpConfig` → `renderConfigDump`（app-boot index.ts:409）。它**只组合 patch 不 boot**，所以能证明"行在树里"，**不能证明代码成功加载**。
- **真正的加载证明**：`app-boot/src/index.ts:722 assertEntriesActivated` — 对每个 entry 检查 `entry.fiber`；`FIBER_FAILED` 会 `await fiber.await()` 取出原始异常；`FIBER_PENDING` 会列出缺失的注入服务名（index.ts:741）。boot 失败会以 `plugin tree failed to load` 抛出（index.ts:832）。
- 所以：**boot 成功 = 行存在 + 模块解析成功 + 服务注入满足 + onStart 未抛错**。这是比 dump-config 强得多的证据。

## 五、资源释放机制（已由源码确认）

- **`ctx.effect(disposer)`** 是标准机制。真实用例：
  - `packages/core/session/src/index.ts:910` `this.ctx.effect(function* (this: SessionStore) {...})`
  - `packages/core/agent/src/index.ts:288/367/445`
  - `packages/core/tools/src/index.ts:943` `ctx.effect(function* (this: ToolRuntime) {...})`
  - `packages/core/agent-loop/src/index.ts:419-420` `ctx.effect(() => () => this.ownership.dispose(), 'agentLoop.transactions()')`
- **`ctx.on(...)` 返回 disposer**，由 Cordis 在该 fiber 销毁时自动收集。
- **`ctx.fiber.dispose()`** 是整棵树/单 fiber 的销毁入口（`profile-boot.ts:224` 关停时调用；app-boot index.ts:820 boot 失败时调用）。

## 六、会话证据读取（已由源码确认）

**事件契约**：`packages/core/session/src/index.ts:50-81`
| 事件 | 模式（源码注释 `@mode`） | 语义 |
|---|---|---|
| `session/created` | `emit`（同步） | 会话进入 store 时广播；同步抛错可否决并回滚 |
| `session/disposed` | `emit`（同步） | 会话离开 store；监听器失败被记录并隔离 |
| `session/event` | `emit`（**post-commit，fire-and-forget**） | 每次 append 后回调；**监听器失败不会让 append 失败** |
| `session/flush` | `parallel`（**await 全体**） | 唯一持久化屏障 |

**证据可读性**：`ctx.sessionPersistence`（`packages/session/session-persistence/src/index.ts:109-199`）
- `create(header, opts)` / `open(id, 'read'|'write', opts)` / `stat(id)` / `list()` / `flush()`
- `open(id, 'read')` **不取所有权，另一进程持写锁时也能读**（index.ts:152-153、handle.ts:10-13）。
- `SessionHandle.read(offset?, length?, opts?)` → `{ eventState, events }`（handle.ts:83），**从 seq 0 读全量**。
- `SessionHandle.close()` 幂等、支持 `await using`（handle.ts:59 `extends AsyncDisposable`）。

**消息归属标记**：`packages/llm/llm/src/message.ts:98-107`
```ts
export interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource      // { kind:'model', provider, model, replayState? }
  tool: ToolMessageSource        // { kind:'tool', callId }
}
```
且 `message.ts:50-62` 定义 `ContextForm = 'instructions'|'catalog'|'snapshot'|'notice'|'relay'|'recall'`，其中 **`'recall'` 的注释是 "Material lifted out of another session's log, possibly reduced on the way in."** —— 这正是"记忆注入"应有的归属，也天然让"区分注入 vs 真实输入"成立。

**事件类型**：`packages/core/session/src/types.ts:266-382`
`turn/start` / `turn/end` / `step/start` / `step/end` / `user/message` / `assistant/message` / `assistant/attempt` / `tool/call` / `tool/result` / `request/header` / `request/context` / `session/end-seed`。
- `user/message` 的注释（types.ts:287-293）明确："a direct human prompt, a synthetic `agent.inject()` context, or an entered goal continuation round. All three project their `content` verbatim; **`source` tells them apart**."
- `turn/end` 带 `reason: TurnEndReason`（types.ts:282），其注释（types.ts:275-281）说明**turn 边界不 await flush**。

**模型调用**：`ctx.llm`（`packages/llm/llm/src/index.ts:54-55`），`LlmRuntime`（index.ts:330）。
- `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`（index.ts:1093 实现、index.ts:278 抽象声明）
- `prepareCall(config, signal)`（index.ts:904）、`resolveCallConfig`（index.ts:846）

**工具注册**：`ctx.tools.register(definition): () => void`（`packages/core/tools/src/index.ts:1027`，返回 disposer；内部 index.ts:1050 走 `ctx.effect`）。
**提示词注入**：`ctx.systemPrompt.section(section): () => void`（`packages/core/system-prompt/src/index.ts:448`，返回 disposer；内部 index.ts:455 走 effect）。

## 七、待验证事项（必须运行程序才能确认）

1. 本机 `$DSH_HOME/profiles/` 下现有 profile 的实际内容与版本。
2. 一个最小插件能否通过 `dsh plugin add` + boot 成功（需真实安装 + 启动，有副作用）。
3. `session/event` 在真实会话中的触发频率与顺序（需运行会话）。
4. `ctx.sessionPersistence` 在同一进程内对**已完成**会话 `open(id,'read')` 是否成功（需真实会话数据）。
5. 现有 Git Ledger 31 个测试的真实通过情况（需 `node --test`）。
