# A — DSH 原生插件 / Bundle / Cordis 加载与生命周期真实调用链

**调查对象**：`F:\xufeng\deepseek\deepseek-harness-master` @ `69646b1`，版本 `0.1.3-alpha.2`
**方式**：纯只读。优先读 `.ts` 源码，交叉验证 `lib/*.js` 与 `vendor/` 下的框架源码。
**证据标记**：
- **【已由源码确认】** = 读到了实际执行路径上的代码
- **【基于源码的推断】** = 由代码结构与契约推断，未直接观察到执行
- **【尚待实验验证】** = 必须运行程序才能确定

> 本轮所有路径均相对 `F:\xufeng\deepseek\deepseek-harness-master`。

---

## 0. TL;DR（给 Lead 的十行结论）

1. DSH 没有"服务端插件注册表"。**插件 = Cordis Loader 的一行 entry**；**Bundle = 一个 npm 包 + 一个 `cordis.patch.yml` 补丁层**；**Profile = 一个目录，声明 bundle 的有序列表 + 自己的补丁层**。
2. 整棵树是**空数组 `[]` 上叠补丁**叠出来的（`apps/cli/src/profile-boot.ts:81-85`）。没有任何"根配置文件"，`cordis.yml` 永远是 `[]`。
3. 补丁算法只有一个实现：`applyEntryPatches`（`vendor/include/src/index.ts:58`）。boot 和 `--dump-config` 共用它，所以 dump 与实际挂载不会漂移。
4. `dsh.bundle` 的解析点是 `packages/boot/app-boot/src/profile.ts:792`（`loadProfileDirectory`）。
5. 插件的能力注册全部是 **Cordis effect**，返回 disposer，随 fiber 卸载自动回滚；**没有 `ctx.on('dispose')` 这个 API**（我 grep 过全仓库，不存在）。
6. 资源释放 = `ctx.effect(() => cleanup)` / `ctx.on(...)` / `Service` 构造器 / 注册表的 `register()` 返回 disposer。卸载顺序是**逆序**，但多个 async disposer **并发**跑。
7. 本地开发插件安装 = `dsh plugin --profile <name> add ./my-plugin`（转发 pnpm，相对路径先锚定到调用目录，见 `apps/cli/src/plugin.ts:104`），profile 会把 `dsh.bundle` 声明者自动并入 `dsh.profile.bundles`。
8. `--patch` CLI 参数**存在**，可重复，见 `apps/cli/src/args.ts:138`。
9. 运行时验证"真的加载了"有三条可靠路径：`--dump-config`（静态，只能证明配置里）、`ctx.loader.entries()` + `fiber.state`（动态，真证明）、`dsh-host-plugin-inventory` 的 `pluginInventory.list()` Remote（Web GUI 的 Plugins 页就是它）。
10. **关键差异**：Mnemon 那套"进程外挂载 + 手写 Provider 描述符"在 DSH 原生机制里完全没有对应物——DSH 要求插件是**进程内 Cordis 插件**，通过 `inject` 声明服务依赖，靠 fiber 状态机管理生命周期。

---

## 1. 从 CLI 入口到 Cordis 插件装载的真实调用链

### 1.1 文字缩进调用链（每跳带 file:line）

```
[进程入口]
package.json:175  "dsh": "node --import tsx/esm apps/cli/src/bin.ts"
  │
  ▼
apps/cli/src/bin.ts:58   if (import.meta.main) await runCli()
apps/cli/src/bin.ts:28   export async function runCli()
  │
  ├─ bin.ts:29   parseDshArgs(process.argv.slice(2), readVersion())
  │             └→ apps/cli/src/args.ts:118  parseDshArgs()  ← commander 只解析 launcher 自己的 flag
  │                  args.ts:137  .option('--profile <name>', ...)
  │                  args.ts:138  .option('--patch <path>', ..., collect)   ← 可重复
  │                  args.ts:139  .option('--dump-config', ...)
  │                  args.ts:140  .option('--dump-default-config', ...)
  │                  args.ts:133  .allowUnknownOption() / .passThroughOptions()
  │                  args.ts:151  resolved = resolveBoot(...)   ← 返回 DshInvocation
  │
  ├─ bin.ts:31   switch (invocation.mode)
  │
  ├─ case 'profile'  (bin.ts:32-41)
  │   ▼
  │   apps/cli/src/profile-boot.ts:210  runProfile(options)
  │     │
  │     ├─ profile-boot.ts:215  installProxyFromEnvironment(environment, ...)   ← 装代理，先于任何插件
  │     │
  │     ├─ profile-boot.ts:220  composeProfile(options.profile, options.patchFiles)
  │     │   │
  │     │   ├─ profile-boot.ts:161  prepareProfile(name)
  │     │   │   ├─ profile.ts:120    loadProfile('dsh', name, INSTALL_ANCHOR, undefined, {userLayer})
  │     │   │   │   ├─ profile.ts:824    resolveProfileDir(name, home)  →  $DSH_HOME/profiles/<name>
  │     │   │   │   ├─ profile.ts:826    PROFILE_TEMPLATES[name]  ← 首次使用自动初始化
  │     │   │   │   ├─ profile.ts:832    initProfile(dir, template.bundles, template.patchReload)
  │     │   │   │   ├─ profile.ts:834    normalizeShippedProfile(...)
  │     │   │   │   └─ profile.ts:835    loadProfileDirectory('dsh', dir, installAnchor, options)
  │     │   │   │        │
  │     │   │   │        ├─ profile.ts:780   readProfileManifest(binName, dir)   ← 读 package.json
  │     │   │   │        ├─ profile.ts:781   bundles = manifest.dsh?.profile?.bundles ?? []
  │     │   │   │        ├─ profile.ts:783   patchReload 校验 'live' | 'startup'
  │     │   │   │        └─ profile.ts:789   bundles.map(packageName => {...})   ★ 每个 bundle 一层
  │     │   │   │             ├─ profile.ts:790   resolveBundleDir(...)   ← 两锚点解析
  │     │   │   │             │     profile.ts:754  for (anchor of [installAnchor, join(profileDir,'package.json')])
  │     │   │   │             │     profile.ts:755    packageDirFromAnchor(anchor, packageName)
  │     │   │   │             │     profile.ts:732      createRequire(anchor).resolve.paths(...)  ← Node 原生查找序
  │     │   │   │             ├─ profile.ts:791   bundleManifest = JSON.parse(readFileSync(join(packageDir,'package.json')))
  │     │   │   │             ├─ profile.ts:792   declared = bundleManifest.dsh?.bundle?.patch   ★★★ Q2 的答案
  │     │   │   │             ├─ profile.ts:793-795  未声明 → throw "declares no dsh.bundle"
  │     │   │   │             ├─ profile.ts:796   patchPath = join(packageDir, declared)
  │     │   │   │             └─ profile.ts:797   patches = loadOverlayPatches(binName, patchPath)
  │     │   │   │                   index.ts:315  loadOverlayPatches()
  │     │   │   │                   index.ts:322    parsePatchList(binName, file, content, 'overlay')
  │     │   │   │                     index.ts:355    yaml.load(content, { schema: userPatchesSchema })
  │     │   │   │                     index.ts:359    非数组 → throw
  │     │   │   │                     index.ts:367    anchorInsertedPluginNames(parsed, file)
  │     │   │   │                       index.ts:329-330  './x' 或 '../x' → file:// URL（相对补丁文件）
  │     │   │   │
  │     │   │   └─ profile-boot.ts:121  writeFileSync(join(profile.dir, 'cordis.yml'), PROFILE_ROOT_CONFIG)
  │     │   │                             ↑ 每次都重写为 "[]\n"（PROFILE_ROOT_CONFIG 定义在 profile-boot.ts:81）
  │     │   │
  │     │   ├─ profile-boot.ts:162  healProfilesModuleFallback({installAnchor, profile})
  │     │   │     profile.ts:552    → 维护 $DSH_HOME/profiles/node_modules 的安装依赖闭包
  │     │   │                          + profile 私有 .dsh-module-fallback 链接
  │     │   │
  │     │   ├─ profile-boot.ts:163  homePatches = loadOptionalPatches('dsh', homePatchPath()) ?? []
  │     │   │     homePatchPath() = profile-boot.ts:71  join(resolveDshHome(), 'cordis.patch.yml')
  │     │   │
  │     │   ├─ profile-boot.ts:164  overlays = patchFiles.flatMap(f => loadOverlayPatches('dsh', resolve(f)))
  │     │   │
  │     │   ├─ profile-boot.ts:165  bundlePatches = profile.layers.flatMap(layer => layer.patches)
  │     │   │
  │     │   ├─ profile-boot.ts:167  composeEntries([bundlePatches, profile.patches, homePatches, overlays])
  │     │   │     profile.ts:849  applyEntryPatches([], structuredClone(layers.flat()), warn)
  │     │   │       └→ 用于算出"有没有 session-telemetry-otel 这一行"
  │     │   │
  │     │   └─ profile-boot.ts:171-172  resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, hasRow)
  │     │
  │     ├─ profile-boot.ts:223  createProcessShutdown(async () => { await app.current?.fiber.dispose(); await disposeProxy() })
  │     ├─ profile-boot.ts:237-238  process.on('SIGTERM' → interrupt(0)) / process.on('SIGINT' → interrupt(130))
  │     ├─ profile-boot.ts:239  installFailLoud('dsh', process, async () => { await app.current?.fiber.dispose() })
  │     │
  │     └─ profile-boot.ts:264  ctx = await boot('dsh', rootConfig, structuredClone(allPatches(composed)), prepare)
  │         │     ↑ allPatches = profile-boot.ts:137  [bundlePatches, profile.patches, homePatches, overlays]
  │         ▼
  │         packages/boot/app-boot/src/index.ts:787  export async function boot(...)
  │           │
  │           ├─ index.ts:794   const ctx = new Context()          ← Cordis 根上下文
  │           ├─ index.ts:799   ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  │           │                   ↑ baseUrl 锚在 profile 目录，此行决定相对路径 name 的解析基准
  │           ├─ index.ts:800   ctx.provide('dshHomePath', dshHomePath)   ← 供 !!js 表达式用
  │           ├─ index.ts:801   await ctx.plugin(Loader)           ← 装载 Loader 服务
  │           │     vendor/cordis/src/registry.ts:316  RegistryService.plugin(plugin, config, getOuterStack)
  │           │       registry.ts:330  new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack)
  │           │       vendor/cordis/src/fiber.ts:265  this.dispose = parent.fiber.effect(() => {...})
  │           │       vendor/loader/src/index.ts:77   constructor(ctx, config) { super(ctx); ... ctx.reflect.provide('loader', this, ...) }
  │           │
  │           ├─ index.ts:802   await prepare?.(ctx)              ← profile-boot 传进来的 host setup
  │           │     profile-boot.ts:265-275:
  │           │       hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
  │           │       provideCmdline(hostCtx, { args, exit, ready })
  │           │         packages/boot/cmdline/src/index.ts:86  ctx.provide('cmdlineArgs', { get: () => snapshot })
  │           │         packages/boot/cmdline/src/index.ts:87  ctx.provide('appExit', host.exit)
  │           │         packages/boot/cmdline/src/index.ts:88  ctx.provide('appReady', host.ready)
  │           │
  │           ├─ index.ts:804   await mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl)
  │           │   │
  │           │   ├─ index.ts:522  ctx.loader.builtins.include = Include        ← 把 Include 注册为 cordis: 内建
  │           │   ├─ index.ts:540  ctx.loader.builtins.group   = Group
  │           │   ├─ index.ts:544-547  includeConfig = { path: file://rootConfig, ...(patches.length ? { patches } : {}) }
  │           │   ├─ index.ts:548-552  rootInclude = { id: 'include', name: 'cordis:include', config: includeConfig }
  │           │   ├─ index.ts:553  const includeId = await ctx.loader.create(rootInclude)      ★ 真正创建根 entry
  │           │   │     vendor/loader/src/config/tree.ts:97   async create(options, parent, position)
  │           │   │       tree.ts:99   await group.create(options)
  │           │   │         vendor/loader/src/config/group.ts:20  async create(options)
  │           │   │           group.ts:30  await entry.update(options, true, true)   (create=true)
  │           │   │             vendor/loader/src/config/entry.ts:142  async update(options, create, force)
  │           │   │               entry.ts:172  await this.init()
  │           │   │                 entry.ts:261  await this._init()
  │           │   │                   entry.ts:280  plugin = this.loader.unwrapExports(await this.parent.tree.import(name, stack))
  │           │   │                     vendor/loader/src/config/tree.ts:146  if (name.startsWith('cordis:')) return this.ctx.loader.builtins[name.slice(7)]
  │           │   │                   entry.ts:285  await this._start(plugin)
  │           │   │                     entry.ts:296  fiber = this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
  │           │   │                     entry.ts:297  await fiber.await()
  │           │   │   ├─ index.ts:554-556  loader.resolve(includeId) → entry
  │           │   │   └─ index.ts:557  bootstrapIncludes.set(ctx, entry)   ← 供 HMR 复用同一 entry
  │           │   │
  │           │   ├─ index.ts:812  await ctx.get('loader')?.await()          ← 等整棵树 settle
  │           │   │     vendor/loader/src/config/tree.ts:46  async await()
  │           │   │
  │           │   └─ index.ts:814  await assertEntriesActivated(ctx, 'dsh')   ★ 装载后审计
  │           │         index.ts:688  assertEntriesLoaded(ctx, binName)
  │           │             index.ts:689  failed = [...ctx.loader.entries()].filter(e => e.fiber === undefined && !e.disabled)
  │           │             index.ts:692  throw "plugin(s) failed to load: ..."
  │           │         index.ts:726-747  逐 entry 检查 fiber.state
  │           │             state === FIBER_ACTIVE(2) → continue
  │           │             state === FIBER_FAILED(3) → await fiber.await() 取原始 reject
  │           │             state === FIBER_PENDING(0) → missing = fiber.inject 里 ctx.get(service)===undefined 的项
  │           │         index.ts:753  throw "... N entries did not activate\n..."
  │           │
  │           ▼
  │       [Include 插件自己的 apply：真正把补丁叠到空数组上]
  │         vendor/include/src/index.ts:174  export class Include extends EntryTree
  │           index.ts:175  static inject = ['loader']
  │           index.ts:197  this.filename = fileURLToPath(new URL(this.config.path, this.ctx.baseUrl))
  │           index.ts:204  this.ctx.baseUrl = new URL('.', pathToFileURL(this.filename)).href   ← 再次锚定
  │           index.ts:273  async* [Service.init]()
  │           index.ts:276    candidate = (await this.read(true))!        ← 读 profile 的 cordis.yml（内容是 []）
  │           index.ts:287    yield () => this.stop()                     ← 注册 disposer
  │           index.ts:288    await this.apply(candidate)
  │             index.ts:312    return this.enqueue(() => this._apply(candidate))
  │               index.ts:316    const data = this.applyPatches(candidate.data, this.config.patches)
  │                 index.ts:268    return applyEntryPatches(data, patches, warn)     ★★★ 唯一的补丁算法
  │               index.ts:317    await this.root.update(data)            ← 把叠好的行交给 Loader 挂载
  │                 vendor/loader/src/config/group.ts:59  async update(config)
  │                   group.ts:71   const outcomes = await Promise.allSettled(config.map(o => this.create(o)))  ← 并发挂载
  │                   group.ts:81-83  移除 oldMap 里已消失的 id（await this.remove(id, true)）
  │                   group.ts:84   this.data = config
  │                   group.ts:85-105  失败时回滚：删新增 + 重建旧行，抛 AggregateError
  │
  ├─ case 'plugin'  (bin.ts:42-45)
  │   apps/cli/src/plugin.ts:120  runPlugin(profile, args)
  │     plugin.ts:121  resolveProfileDir(profile)
  │     plugin.ts:122-130  未初始化则 initProfile(...)
  │     plugin.ts:131  before = readProfileManifest('dsh', dir)
  │     plugin.ts:134  spawnSync('pnpm', args.map(a => anchorPathSpec(a, process.cwd())), { cwd: dir, stdio:'inherit', shell: win32 })
  │     plugin.ts:149  reconcilePlugins(before, dir)   ← 成功后按"已安装状态"重算 dsh.profile.bundles
  │
  └─ case 'dump-config'  (bin.ts:47-51)
      apps/cli/src/dump-config.ts:30  runDumpConfig(profile, defaultOnly, patches)
        dump-config.ts:31  prepareProfile(profile, !defaultOnly)
        dump-config.ts:32-49  构造 layers 数组（bundle / profile / home / --patch 各自带 label）
        dump-config.ts:51  process.stdout.write(renderConfigDump('dsh', join(dir,'cordis.yml'), layers))
          packages/boot/app-boot/src/index.ts:409  renderConfigDump(...)
            index.ts:441-449  snapshot(count, warnings) → applyEntryPatches(base, flattened, warn)
            index.ts:471  groupedDump(composed, provenance)     ← 每组前打 "# == <来源>"
```

### 1.2 关键结论（Q1）

- **【已由源码确认】** DSH 的"发现"完全是 **Node 模块解析**，没有扫描、没有注册表文件。`resolveBundleDir`（`packages/boot/app-boot/src/profile.ts:751`）用 `createRequire(anchor).resolve.paths(packageName)`（`profile.ts:732`）走 Node 原生 node_modules 查找序，锚点顺序是「dsh 安装目录 → profile 目录」（`profile.ts:754`）。
- **【已由源码确认】** 初始化/装载是 Cordis `Loader` 的 `EntryTree.update()` → `EntryGroup.update()`，**并发** `Promise.allSettled(config.map(o => this.create(o)))`（`vendor/loader/src/config/group.ts:71`）。失败整批回滚（`group.ts:85-105`）。
- **【已由源码确认】** `row.顺序`**不承载装载语义**。`packages/bundle/base/cordis.patch.yml:12-13` 的注释明说 "Row order carries no load semantics (activation is service-availability driven)"。真正决定加载顺序的是 `inject` 服务依赖（Cordis fiber PENDING → ACTIVE 状态机，`vendor/cordis/src/fiber.ts:611-639`）。
- **【已由源码确认】** 装载完成有**强制审计**：`assertEntriesActivated`（`index.ts:722`）会把任何 fiber 不存在 / FAILED / 仍 PENDING 的 entry 抛成 boot 失败。这意味着**「配置文件里有」和「运行时真加载了」在 DSH 里是硬性二分**——配置里有但加载不了，进程直接非零退出。

---

## 2. `dsh.bundle` 的声明与解析位置（Q2）

### 2.1 语法与类型

**声明形式**【已由源码确认】：

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

类型定义在 `packages/util/package-manifest/src/types.ts`：

```ts
// packages/util/package-manifest/src/types.ts:8
export interface DshManifest {
  bundle?: DshBundleManifest        // :10
  profile?: DshProfileManifest      // :12
  client?: DshClientManifest        // :14
  configTrees?: DshConfigTreeDeclaration[]   // :16
  sessionFormatMigration?: DshSessionFormatMigrationManifest  // :18
  moduleFallback?: DshModuleFallbackManifest  // :23  (@internal, launcher-generated)
}

// packages/util/package-manifest/src/types.ts:27
export interface DshBundleManifest {
  patch: string   // :29  "Patch file path relative to the declaring package root."
}
```

> ⚠️ `packages/util/package-manifest/src/index.ts` **只有 `export type`，没有运行时导出**（文件头注释："Public package manifest types, with no runtime exports"）。所以 `DshBundleManifest` 是一个**纯类型**，`dsh.bundle` 的解析是各处**手写 JSON.parse + 字段探测**，没有统一 validator。

### 2.2 解析点（三处，各自职责不同）

| 位置 | 符号 | 作用 |
|---|---|---|
| `packages/boot/app-boot/src/profile.ts:792` | `loadProfileDirectory` 内 `const declared = bundleManifest.dsh?.bundle?.patch` | **权威解析点**：把 bundle 名解析成 patch 文件路径并 parse 成 `PatchOptions[]` |
| `apps/cli/src/plugin.ts:44` | `exportsPatch` 内 `return manifest.dsh?.bundle?.patch !== undefined` | `dsh plugin` 的安装后 reconciler 判断"这个依赖是不是 bundle" |
| `scripts/verify-cordis-config.ts:260` | `const patch = manifest.dsh?.bundle?.patch` | 仓库 CI 静态校验（非运行时） |

**权威代码片段**【已由源码确认】：

```ts
// packages/boot/app-boot/src/profile.ts:789-798
const layers = bundles.map((packageName): ProfileLayer => {
  const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
  const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as ProfileManifest
  const declared = bundleManifest.dsh?.bundle?.patch
  if (declared === undefined) {
    throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`)
  }
  const patchPath = join(packageDir, declared)
  return { packageName, packageDir, patchPath, patches: loadOverlayPatches(binName, patchPath) }
})
```

注意 **`join(packageDir, declared)`**：`patch` 路径相对**包根目录**，不是相对 package.json，也不是相对 profile。

### 2.3 对应的 profile manifest

```ts
// packages/util/package-manifest/src/types.ts:33
export interface DshProfileManifest {
  bundles?: string[]                  // :35  有序的 bundle 包名列表（必须是"已安装的包名"）
  patchReload?: ProfilePatchReload    // :37  'live' | 'startup'；自定义 profile 省略则默认 'live'
}
```

**初始化的真实产物**（`profile.ts:170-190` `initProfile`）：
- `package.json`（`profile.ts:178-184`）：
  ```json
  { "name": "dsh-profile-<name>", "private": true, "dependencies": {},
    "dsh": { "profile": { "bundles": [...], "patchReload": "live" } } }
  ```
- `cordis.patch.yml`（`profile.ts:187`）：写入 `PROFILE_PATCH_TEMPLATE`（`profile.ts:144-148`，内容是一个带注释的 `[]`）
- `pnpm-workspace.yaml`（`profile.ts:189`）：
  ```yaml
  packages:
    - .
  nodeLinker: hoisted
  autoInstallPeers: false
  ```

### 2.4 缺 `dsh.bundle` 的后果【已由源码确认】

两个不同语义，别混淆：

- **profile 的 `dsh.profile.bundles` 里列了一个没有 `dsh.bundle` 的包** → **硬失败**（`profile.ts:793-795` throw）。原因：列出即声明"这是一个层"，而它没有层 → 配置错误。
- **profile 的 `dependencies` 里有但不在 `bundles` 里** → 只是普通依赖，`dsh plugin` 打一行 warning（`apps/cli/src/plugin.ts:71-74`）。

---

## 3. `cordis.patch.yml` 的真实语法（Q3）

### 3.1 完整贴出一个真实 bundle patch

最小真实样例 —— `packages/bundle/acp-app/cordis.patch.yml`（全文 21 行）：

```yaml
# The automation-only ACP application over dsh-base. Stdout belongs to ACP.

- id: system-prompt
  config:
    personaSuffix: Your working directory is {{cwd}}.
    personaPrefix: >-
      You are a coding agent powered by the {{model}} model.

- id: session-title-llm
  disabled: true

- insert:
    - id: acp-app-startup
      name: '@deepseek-ai/dsh-acp-app'

    - id: acp
      name: '@deepseek-ai/dsh-acp'
      inject: [acpAppStartup]
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
```

### 3.2 字段解释（逐条对照源码）

`PatchOptions` 类型在 `vendor/include/src/index.ts:145-156`：

```ts
// vendor/include/src/index.ts:145
export interface PatchOptions {
  id?: string
  insert?: EntryOptions[]
  name?: string
  config?: any
  group?: boolean | null
  disabled?: boolean | null
  inject?: any
  intercept?: any
  isolate?: any
  [key: string]: any     // ← 注意：任意键都会被当作"要覆盖的 entry 字段"
}
```

`EntryOptions` 在 `vendor/loader/src/config/entry.ts:9-22`：

```ts
export interface EntryOptions {
  id: string        // :11  "Stable id inside the containing entry tree."
  name: string      // :13  "Module specifier imported by the entry tree."
  config?: any      // :15  "Config passed to the plugin."
  group?: boolean | null      // :17  "Marks this entry as a nested group."
  disabled?: boolean | null   // :19  "Prevents this entry and descendants from running."
  inject?: Inject | null      // :21  "Required services or service intercept config for this entry."
}
```

| 字段 | 语义 | 实现位置 |
|---|---|---|
| `id` | 目标行 id。**非 insert patch 必须有** | `include/index.ts:105-108` 缺 id → warn + skip |
| `insert: [...]` | 追加新行。**有 `id` 时是"插入到该 group 行"**，无 `id` 时追加到顶层 | `include/index.ts:80-103` |
| `name` | 仅作**断言**：与目标行 `name` 不符时 warn + skip（不重命名） | `include/index.ts:116-119` |
| `config` | **整块替换**，不是深合并 | `include/index.ts:121-124`（`target[key] = value`） |
| `disabled` | 布尔或 `!!js` 表达式 | `include/index.ts:121-124` 写入 options；`entry.ts:104-108` 求值 |
| `group` / `inject` / `intercept` / `isolate` | 属"其余键"，一律 `target[key] = value` | `include/index.ts:121-124` |

`applyEntryPatches` 的完整语义（**唯一实现**，`vendor/include/src/index.ts:58-128`）：

```ts
// vendor/include/src/index.ts:58
export function applyEntryPatches(data, patches, warn): EntryOptions[] {
  data = structuredClone(data)                     // :63  永不改输入
  if (!patches?.length) return data                // :64
  const entryMap = new Map<string, EntryOptions>() // :66  id 索引
  const buildMap = (entries) => {                  // :67  递归含 group.config
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry)  // :69
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config)  // :70-72
    }
  }
  buildMap(data)
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch   // :78
    if (insert) { ... }                                // :80-103
    if (!id) { warn('patch: id is required for non-insert patches'); continue }  // :105-108
    const target = entryMap.get(id)                     // :110
    if (!target) { warn('patch: entry %C not found', id); continue }             // :111-114
    if (name && name !== target.name) { warn(...); continue }                    // :116-119
    for (const [key, value] of Object.entries(overrides)) target[key] = value    // :121-124  ★ 整键替换
  }
  return data
}
```

**关键行为【已由源码确认】**：
1. **未匹配的 patch 只 warn，不失败**（`include/index.ts:112`）。设计原因见 `packages/boot/app-boot/src/index.ts:341-343`："a single patch whose target row is absent stays a per-entry Loader warning, so one overlay shared across surfaces does not have to match every tree"。
2. 但**解析失败**（非数组成员、YAML 语法错）是**硬失败**（`index.ts:359-366`）。
3. `insert` 加入的行**会被立即索引**（`include/index.ts:101` `buildMap(insert)`），所以同一层后面的 patch 能改刚插入的行——这是 bundle 层能自我配置的基础。
4. **`config` 整块替换**导致一个硬性写作纪律：覆盖一行必须**重述该行所有键**。`packages/bundle/web-app/cordis.patch.yml:5-6` 与 `docs/user/develop/basic/publish.md:123-126` 都明确写了这条。

### 3.3 `!!js` 表达式

```ts
// vendor/include/src/index.ts:9-15
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (data) => data['__jsExpr'],
})
// :23  export const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)
```

求值发生在 `vendor/loader/src/config/utils.ts:5-9`：

```ts
export const evaluate = new Function('ctx', 'expr', `
  with (ctx) {
    return eval(expr)
  }
`) as ((ctx: object, expr: string) => any)
```

即**真的在插件自己的 ctx 上 `eval`**。而 `interpolate`（`utils.ts:12`）递归遍历结构。

**求值时机与时机的精确语义**【已由源码确认】：
- `config` 字段：`vendor/loader/src/index.ts:92-101` 的 `internal/config` waterfall 里 `interpolate(this.ctx, config)`，只在**声明的 inject 全部激活后**（`fiber.ts:641-644`）。
- `disabled` 字段：`entry.ts:104-108` 每次 mount 决策都求值，用的是 **loader context**（不是插件 context）。
- **其它 entry 元数据字段（`id`/`name`/`group`/`inject`/`intercept`/`isolate`）不求值**，见 `vendor/loader/src/index.ts:98-99` 的 tree-carrier 判断 + `scripts/verify-cordis-config.ts:39` 的 `metadataFields`。

### 3.4 如何指向本地开发中的包

**三种路径，语义不同**：

| 指向方式 | 写在 patch 的 `name` 里 | 解析依据 | 适用 |
|---|---|---|---|
| **npm 包名**（推荐，bundle 的方式） | `name: dsh-hello-plugin` | Node 包解析：先 dsh 安装目录，再 profile 目录 → `$DSH_HOME/profiles/node_modules` | 已 `dsh plugin add` 安装过的包 |
| **相对路径** | `name: './src/my-plugin.ts'` | `anchorInsertedPluginNames`（`app-boot/src/index.ts:326-336`）在**解析时**转成 `file://` 绝对 URL，基准是**补丁文件所在目录**（`index.ts:327` `const base = dirname(resolve(file))`） | `--patch` 本地覆盖、profile 的 `cordis.patch.yml` |
| **绝对路径** | `name: 'F:/.../my-plugin.ts'` | 同上，`isAbsolute` 分支（`index.ts:329`） | 少见 |
| **`cordis:` 内建** | `name: 'cordis:group'` / `'cordis:include'` | `vendor/loader/src/config/tree.ts:146` `this.ctx.loader.builtins[name.slice(7)]` | group 行 |

**关键点【已由源码确认】**：
- 相对路径**只在 patch 解析时**被转成 file URL（`app-boot/src/index.ts:329-331`），基准是**补丁文件目录**，不是 cwd，不是 profile 目录。
- 一个 bundle 的 patch 里可以写相对路径（相对 bundle 包目录），但**跨平台/打包后不可靠**。真实的第一方 bundle 一律用**包名**（见 `packages/bundle/base/cordis.patch.yml` 全文）——因为 `name: '@deepseek-ai/dsh-llm'` 这类要交给 Node 的裸包解析。
- 本地开发的 binder 包应通过 `dsh plugin --profile x add ./my-plugin` 安装（会 `link:`/`file:` 进 profile 的 node_modules），然后 patch 里写**包名**。真实案例：`C:\Users\yanghuisong\.dsh\profiles\web\package.json` 里 `"@deepseek-ai/dsh-teach-activity": "link:F://.../teach-activity"`。
- **`dsh plugin` 会把相对路径锚定到调用目录**（`apps/cli/src/plugin.ts:104-112` `anchorPathSpec`），因为 pnpm 的 cwd 是 profile 目录，不锚定会让 `add .` 自链接 profile。

---

## 4. 插件注册服务 / 工具 / 事件 / 提示词的真实 API（Q4）

### 4.1 注册一个 Cordis Service（`ctx.<name>`）

```ts
// packages/core/session/src/index.ts:866-871
export class SessionStore extends Service {
  private store = new Map<SessionId, SessionEntry>()
  private counter = 0

  constructor(ctx: Context) {
    super(ctx, 'sessions')       // ★ service 名就是 ctx.sessions
```

基类实现（`vendor/cordis/src/service.ts:42-59`）：

```ts
// vendor/cordis/src/service.ts:42
constructor(protected ctx: Context, name: string) {
  name ??= this.constructor['provide'] as string
  let self = this
  const tracker: Tracker = { associate: name, property: 'ctx' }
  if (self[symbols.invoke]) {
    self = createCallable(name, joinPrototype(Object.getPrototypeOf(self), Function.prototype), tracker)
  }
  self.ctx = ctx
  self.name = name
  defineProperty(self, symbols.tracker, tracker)
  self.ctx.reflect.provide(name, self, this[symbols.check])    // :57  ★ 自动成为 effect
  return self
}
```

> **【已由源码确认】** `super(ctx, name)` 内部走 `ctx.reflect.provide`，而 `provide` 本身是 `this.ctx.fiber.effect(...)`（`vendor/cordis/src/reflect.ts:278`）。所以**服务注册天然是可回滚 effect**，插件 fiber 卸载时自动退注册。

声明 `ctx.<name>` 类型靠 declaration merging（`docs/user/develop/framework/service.md:72-76`）：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    metrics: MetricsService
  }
}
```

### 4.2 注册模型可见工具

真实片段（`packages/todo/tool-todo/src/index.ts:146-148`，整个 `ctx.tools.register(defineTool({...}))` 是 146-222 行）：

```ts
// packages/todo/tool-todo/src/index.ts:146
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: describe(allowParallel),
    parameters: { todos: { type: 'array', required: true, ... } },
    output: { schema: {...}, render: (_args, value) => [{ type: 'text', text: ... }] },
    execute(args, exec) {
      const todos = toTodoList(args.todos, allowParallel)
      if (!exec.agent) throw new Error('todo_write requires an owning agent session')  // :205-208
      exec.agent.session.append('todo/write', { todos })                              // :210
      ...
    },
```

`ToolRuntime.register`（`packages/core/tools/src/index.ts:1027-1052`）：

```ts
// packages/core/tools/src/index.ts:1027
register(definition: ToolDefinition): () => void {
  const name = definition.name
  ...  // 校验 output 形状 / JSON Schema / timeoutMs / 保留名 run_code
  return this.layers.effect(                                  // :1047  ★ effect 包装
    this.ctx,
    layer => layer.tools.insert(name, definition),
    { label: 'tools.register()' },
  )
}
```

`ToolRuntime` 的服务名与依赖：`packages/core/tools/src/index.ts:780-786`

```ts
export class ToolRuntime extends Service {
  static inject = ['systemPrompt']                      // :781
  static Config: z<Config> = z.object({                 // :783
    mode: z.union(['native', 'ptc', 'both'] as const).default('native'),
    maxParallelSubCalls: z.natural().min(1).default(10),
  })
```

### 4.3 注册系统提示词

真实片段（`packages/extensions/tool-cordis/src/index.ts:35-39`）：

```ts
// packages/extensions/tool-cordis/src/index.ts:34
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:cordis',
    order: ctx.systemPrompt.getSectionOrder('TOOL_CORDIS'),
    text: CORDIS_SYSTEM_PROMPT,
  })
```

`SystemPrompt.section`（`packages/core/system-prompt/src/index.ts:448-457`）：

```ts
// packages/core/system-prompt/src/index.ts:448
section(section: PromptSection): () => void {
  if (!Number.isFinite(section.order)) {
    throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
  }
  return this.layers.effect(                                 // :452  ★ effect
    this.ctx,
    layer => layer.sections.insert(section.name, section),
    { label: 'systemPrompt.section()' },
  )
}
```

`SystemPrompt` 服务：`packages/core/system-prompt/src/index.ts:399` `export class SystemPrompt extends Service`，`super(ctx, 'systemPrompt')`（:416）。
另有 `context()`（:483，动态上下文）、`tools()`（:515，tool schema 提供者）、`variable()`（:531，提示词变量）。

### 4.4 注册事件监听

```ts
// packages/session/session-projection/src/index.ts:207-223（构造函数内）
constructor(ctx: Context) {
  super(ctx, 'sessionProjections')
  ctx.on('session/created', (session: Session) => {
    if (session.seq !== 0) return
    for (const registration of this.registrations.values()) { ... }
  })
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    this.drive(session, event)
  })
}
```

`ctx.on` 的实现（`vendor/cordis/src/events.ts:288-302`）：

```ts
// vendor/cordis/src/events.ts:288
on(name, listener, options?) {
  if (typeof options !== 'object') options = { prepend: options }
  this.ctx.fiber.assertActive()                            // :294  ★ 已卸载则抛 INACTIVE_EFFECT
  listener = this.ctx.reflect.bind(listener)
  const result = this.bail(this.ctx, 'internal/listener', name, listener, options)
  if (result) return result
  const hooks = this._hooks[name] ||= []
  const label = `ctx.on(${typeof name === 'string' ? JSON.stringify(name) : name.toString()})`
  return this.register(label, hooks, listener, options)    // :301  → register 里是 effect
}
```

`register` 确认是 effect（`events.ts:254-260`）：

```ts
register(label, hooks, callback, options): () => void {
  const method = options.prepend ? 'unshift' : 'push'
  return this.ctx.fiber.effect(() => {
    hooks[method]({ ctx: this.ctx, callback, ...options })
    return () => this.unregister(hooks, callback)
  }, label)
}
```

五种派发模式（`events.ts:32` `DispatchMode = 'emit'|'parallel'|'serial'|'bail'|'waterfall'`，实现 :194/:183/:204/:217/:234）。**模式是事件契约的一部分**，`docs/cordis-primer.md:19-27` 有表格。

### 4.5 插件对外的完整"骨架"

```ts
// 函数式插件：packages/todo/tool-todo/src/index.ts:22-23, 41-43, 128
export const name = 'tool-todo'
export const inject = ['tools', 'sessionProjections']
export const Config: z<Config> = z.object({ allowParallelInProgress: z.boolean().required() })
export function apply(ctx: Context, config: Config): void { ... }

// 类式插件（Service）：packages/spill/spill-local/src/index.ts:65-69
export class LocalSpillStore extends SpillStore {
  static Config: z<Config> = z.object({
    root: z.string(),
    cleanupPeriodDays: z.number().step(1).min(0).default(30),
  })
```

`Config` 用 `@deepseek-ai/schemastery`（`z.object(...)`），Cordis 在激活前用它校验并填默认值：`vendor/cordis/src/fiber.ts:50-62` `resolveConfig(runtime, config)`，失败抛 `ValidationError`（`fiber.ts:19-36`）。

---

## 5. 插件如何取得会话 / Agent / 模型 / 持久化（Q5）

### 5.1 注入机制本身

```ts
// packages/core/tools/src/index.ts:781
static inject = ['systemPrompt']

// packages/todo/tool-todo/src/index.ts:23
export const inject = ['tools', 'sessionProjections']

// packages/extensions/tool-cordis/src/index.ts:26
export const inject = ['tools', 'systemPrompt', 'dynamicCordisRunner', 'cordisInspect']
```

`inject` 的归一化（`vendor/cordis/src/registry.ts:71-88` `Inject.resolve`）与 fiber 依赖门控（`vendor/cordis/src/fiber.ts:597-639`）：
- `_checkImpl(name)` 把可用实现放进 `fiber.store`
- `_refresh()` 计算 epoch：**任何一个 inject 服务缺失 → epoch = INACTIVE → fiber 停在 PENDING，`apply` 根本不跑**
- 服务重新出现 → epoch 变 → `_reload()`

**这是「服务可用性驱动装载」的真实实现**，也是 Q1 里"行顺序无装载语义"的根据。

### 5.2 各能力的真实服务名与获取方式

| 能力 | 服务键 | 提供者 | 真实调用样例 |
|---|---|---|---|
| 工具注册 | `ctx.tools` | `packages/core/tools/src/index.ts:780` `ToolRuntime` | `ctx.tools.register(defineTool({...}))` |
| 提示词 | `ctx.systemPrompt` | `packages/core/system-prompt/src/index.ts:399` | `ctx.systemPrompt.section({...})` |
| 会话存储 | `ctx.sessions` | `packages/core/session/src/index.ts:866` `SessionStore` | `ctx.sessions.get(id)`（:1144）/ `ctx.sessions.list()`（:1152） |
| Agent 注册表 | `ctx.agents` | `packages/core/agent/src/index.ts:249` `AgentRegistry` | `ctx.agents.get(sessionId)`、`ctx.agents.currentInitiator()`（:303） |
| LLM | `ctx.llm` | `packages/llm/llm/src/index.ts:330` `LlmRuntime` | `ctx.llm.registerAdapter(providers, adapter)`（:384） |
| 会话投影 | `ctx.sessionProjections` | `packages/session/session-projection/src/index.ts:199` | `ctx.sessionProjections.register({key, stateSchema, init, apply, wire, stateVersion})` |
| KV 存储 | `ctx.storage` | `packages/storage/storage/src/index.ts:47` | — |
| Cordis loader 树 | `ctx.loader` | `vendor/loader/src/index.ts:65` `Loader`，`ctx.reflect.provide('loader', ...)`（:90） | `ctx.loader.entries()` / `.create()` / `.resolve(id)` |
| HMR | `ctx.hmr` | `vendor/hmr/src/index.ts:86` `Hmr`，`static inject = ['loader','timer']`（:87） | `ctx.hmr.registerConfig(filename, refresh)`（:134） |
| 命令行 | `ctx.cmdlineArgs` | `packages/boot/cmdline/src/index.ts:86` | `parseCmdline(ctx, program)`（:165） |
| 退出/就绪 | `ctx.appExit` / `ctx.appReady` | 同上 :87-88 | `exitOnStdinEnd(ctx, label)`（:123） |
| 启动环境快照 | `ctx.launchEnvironment` | `packages/util/launch-environment/src/index.ts:106` `DSH_LAUNCH_ENVIRONMENT_KEY` | `launchEnvironmentOf(ctx)`（:114） |
| DSH 家目录 | `ctx.dshHomePath` | `packages/boot/app-boot/src/index.ts:800` | `!!js dshHomePath('sessions')`（base patch :113） |

### 5.3 访问 Agent 与会话的真实代码

```ts
// packages/todo/tool-todo/src/index.ts:203-210
execute(args, exec) {
  const todos = toTodoList(args.todos, allowParallel)
  if (!exec.agent) {
    throw new Error('todo_write requires an owning agent session')   // 非 agent 调用方无归属会话 → 显式拒绝
  }
  exec.agent.session.append('todo/write', { todos })                 // ★ 通过 ToolExecution.agent 拿会话并追加事件
```

`ToolExecution` 形状见 `packages/core/tools/src/index.ts:372`。`Session.append` 在 `packages/core/session/src/index.ts:678-707`。

`ctx.agent` 是 DX accessor（不是服务）：

```ts
// packages/core/agent/src/index.ts:282
ctx.accessor('agent', { get: () => undefined })
```

每个 `Agent.ctx` 用它自己的 own property 遮蔽这个 accessor。

### 5.4 依赖是可选的怎么办

用 `ctx.get(name)` 而非注入（不阻塞装载）：

```ts
// packages/core/tools/src/index.ts:1010
const runtime = this.ctx.get('codeRuntime')
if (!runtime) {
  throw new Error(`dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation ...`)
}
```

对应 `docs/bundle/web-app/cordis.patch.yml` 的注释（:465-467 段）解释了"host 行 inject 一个服务"是判断 host-plane 归属的准则。

---

## 6. 资源释放机制的真实实现（Q6）

### 6.1 先否掉一个流传的说法

**`ctx.on('dispose')` 在 DSH 里不存在。** 我 grep 过：
- `grep "ctx\.on\('dispose'"` → 0 命中
- `grep "'dispose'"` 在 `vendor/` → 只有 `updateError('dispose', ...)` 这个**错误消息标签**（`vendor/loader/src/config/entry.ts:24`），不是事件。

Cordis 的 `Events` 接口里也没有 `dispose` 事件（`vendor/cordis/src/events.ts:329-352`，只有 `internal/plugin`、`internal/status`、`internal/config`、`internal/service`、`internal/update`、`internal/get`、`internal/set`、`internal/listener`、`internal/dispatch`）。

### 6.2 真实机制：四种，全部收敛到 Fiber effect

**(a) `ctx.effect(() => cleanup)` —— 最基础**

```ts
// packages/spill/spill-local/src/index.ts:95-101
ctx.effect(function* (this: LocalSpillStore) {
  if (this.config.cleanupPeriodDays > 0) {
    const warn: WarnFn = (message) => { this.ctx.logger.warn(message) }
    this.cleanup = this.runCleanup(warn)
  }
  yield async () => { await this.cleanup }
}.bind(this), 'spill-local cleanup sweep')
```

注意用了**生成器**：`yield <disposer>` 可多次 yield，每次注册一个 disposer（`vendor/cordis/src/fiber.ts:83-93` 的 `Effect` 类型 + `fiber.ts:375-395` 的迭代处理）。

**(b) `ctx.on(...)` —— 监听器，内部就是 effect**

见 §4.4 的 `events.ts:254-260`。

**(c) Service 构造器 —— `provide` 是 effect**

见 §4.1 的 `service.ts:57` → `reflect.ts:278`。

**(d) 注册表 `register()` 返回 disposer —— 让调用方决定 nuclear 还是自动**

```ts
// packages/llm/llm/src/index.ts:391-403
const dispose = this.ctx.effect(function* (this: LlmRuntime) {
  if (providers.length === 0) throw new LlmError('an adapter must register at least one provider', 'INVALID_ADAPTER')
  this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned))
  yield () => {
    released = true
    for (const provider of owned) this.adapters.delete(provider)
    owned.clear()
    this.emitAdaptersUpdated()
  }
}.bind(this), 'llm.registerAdapter()')
// ctx.effect's disposer returns Promise<void>; our disposer API is synchronous fire-and-forget
const handle = (() => void dispose()) as AdapterRegistrationHandle
```

### 6.3 effect 的完整契约（`vendor/cordis/src/fiber.ts:415-561`）

```ts
// vendor/cordis/src/fiber.ts:418
effect(execute: () => Effect, label = 'anonymous'): any {
  this.assertActive()                                   // :419  已 dispose → CordisError('INACTIVE_EFFECT')
  if (this.state === FiberState.UNLOADING) {
    throw new CordisError('INACTIVE_EFFECT')            // :421
  }
  ...
  const dispose = () => {
    if (disposing) return disposalTask
    disposing = true
    for (const disposable of disposables.splice(0).reverse()) {    // :431  ★ 逆序
      if (task) task = task.then(() => runDisposable(disposable))  // 串行接续
      else { const result = runDisposable(disposable); ... }
    }
    return disposalTask = task
  }
```

**关键语义【已由源码确认】**：
- `execute` **立即执行**，它的返回值/迭代值被收集成 disposer。
- 有**两种触发**：调用返回的 wrapper，或 fiber 卸载。**谁先到算谁**（`fiber.ts:403-408` 注释）。
- 重复调用 disposer 是 no-op（`fiber.ts:427-428`）。
- 单个 `ctx.effect` **内部**逆序串行；但 `_unload` 里多个 effect 是**并发**（`fiber.ts:676` `await Promise.all(this._disposables.clear().map(...))`）。

### 6.4 卸载的完整路径

```
ctx.fiber.dispose()  (fiber.ts:196, 由 fiber.ts:265 的 effect 闭包实现)
  └─ fiber.ts:267-296:
      ├─ this.uid = null                                       (:268)
      ├─ emitPluginDisposed(this.context, this)                 (:269)  → 'internal/plugin' 事件
      ├─ if (this.ctx.registry.has(runtime.callback)) {         (:270)
      │    remove()                                             (:271)  从 runtime.fibers 摘除
      │    if (!runtime.fibers.length) registry.delete(callback) (:273)
      │  }
      ├─ this._setEpoch(INACTIVE)                               (:276)  驱动 → _unload()
      └─ while (this.inertia) await this.inertia                 (:293-295)  等全部 cleanup 完成
```

`_unload()`（`fiber.ts:675-696`）**并发**跑所有 disposer，每个失败只 `ctx.logger.error` 不中断其它（`fiber.ts:677-686`）。

Loader 侧卸载一个 entry：`entry.ts:130-139` `_dispose(fiber)`，然后 `group.ts:48-57` `remove(id)`：
```ts
// vendor/loader/src/config/group.ts:48
async remove(id: string, isDispose = false) {
  const entry = this.tree.store[id]
  if (!entry) return
  await entry._dispose()
  if (!isDispose) this.unlink(entry.options)
  delete this.tree.store[id]
  this.context.emit('loader/partial-dispose', entry, entry.options, false)   // :56
}
```

### 6.5 三级释放的实证：进程级

```
SIGTERM/SIGINT
  └─ apps/cli/src/profile-boot.ts:237-238  interrupt(code) → signalShutdown.abort() + shutdown.interrupt(code)
      └─ apps/cli/src/process-shutdown.ts:22  createProcessShutdown(dispose, forceExit, complete, timeoutMs)
          ├─ process-shutdown.ts:54  timeout = setTimeout(() => forceExitOnce(code), timeoutMs)   ← 5000ms 上限
          └─ process-shutdown.ts:55  pending = Promise.resolve().then(dispose).then(...)
              └─ profile-boot.ts:223-226  async () => { await app.current?.fiber.dispose(); await disposeProxy() }
                  └─ → 上面 6.4 的整条链
```

超时常量：`apps/cli/src/process-shutdown.ts:4` `PROCESS_SHUTDOWN_TIMEOUT_MS = 5_000`。
第二次信号**立即强杀**（`process-shutdown.ts:69-76`）。

### 6.6 真实"正确做法"范例

`packages/spill/spill-local/src/index.ts:90-101` 的注释把契约讲得最清楚：

> "The generator body runs at activation but does NOT await the sweep — it launches it and yields an async disposer that awaits the SAME promise, so service availability is never delayed yet a fiber unload reaches quiescence (no sweep I/O outlives the fiber)."

即：**启动耗时工作不要 await（别阻塞激活），但必须把它的 promise 交给一个 disposer 去 await（保证卸载时静默）**。

排序注意事项（`docs/cordis-tutorial/02-lifecycle-and-effects.md:94`）：
> "disposers start in reverse registration order, but multiple **async** disposers run concurrently. If teardown steps must run in sequence, keep them in one disposer and await them there."

---

## 7. 向独立 Profile 安装本地开发插件（Q7）

### 7.1 目录结构与 `DSH_HOME`

```ts
// packages/util/home-paths/src/index.ts:12
export const DSH_HOME_DIR_NAME = '.dsh'
// :18
export const DSH_HOME_ENV = 'DSH_HOME'

// :87-91
export function resolveDshHome(configured?, env = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}
```

优先级：**显式参数 > `$DSH_HOME` > `~/.dsh`**（`home-paths/src/index.ts:80-86` 文档注释）。

**本机实测**（`DSH_HOME=C:\Users\yanghuisong\.dsh`）【已由源码确认 · 实机只读观察】：

```
C:\Users\yanghuisong\.dsh\
├── profiles\
│   ├── node_modules\                  ← 安装依赖闭包（healed 符号链接/ESM proxy），41 个条目
│   ├── web\                           ← 真实存在的自定义 profile
│   │   ├── package.json               ← dsh.profile.bundles = [dsh-base, dsh-web-app]
│   │   ├── cordis.patch.yml           ← 用户补丁层（含 llm-pi-ai 大段 config + 4 个 MCP insert）
│   │   ├── cordis.yml                 ← 永远是 "[]\n"
│   │   ├── pnpm-lock.yaml
│   │   ├── pnpm-workspace.yaml
│   │   ├── node_modules\              ← pnpm 管理的 out-of-tree 包
│   │   └── .dsh-module-fallback\      ← profile 私有 fallback 目录
│   └── desktop\
│       ├── package.json               ← 9 个 bundle（含 3 个 npm 三方 + 1 个 link: 本地包）
│       ├── cordis.patch.yml           ← 1739 行，含 mnemon 那一大段
│       ├── cordis.yml
│       ├── .dsh-market\
│       └── .plugin-manager\logs\
├── sessions\  storages\  attachments\  .agent-presets\  task-board\ ...
├── .credentials.yaml   .env   settings.yaml.*   .anonymous-user-id
└── (没有 cordis.patch.yml —— home 层未创建)
```

profile 目录布局（`packages/boot/app-boot/src/profile.ts:5-8` 模块头注释）：
> "A profile is a directory under `$DSH_HOME/profiles/<name>` holding a `package.json` ... and a `cordis.patch.yml` (the user's own patch layer, applied after every bundle layer)."

### 7.2 补丁层的**精确**叠加顺序

要素来源：`apps/cli/src/profile-boot.ts:137-144` `allPatches()` + `:256-261` `composeLive()` + `packages/boot/app-boot/src/profile.ts:846-853` `composeEntries`。

```
1. 空根                             ← profile-boot.ts:81  PROFILE_ROOT_CONFIG = "[]\n"
2. 每个 bundle 的 cordis.patch.yml  ← 按 dsh.profile.bundles 列表顺序
3. profile 自己的 cordis.patch.yml  ← profile.layers 之上
4. $DSH_HOME/cordis.patch.yml       ← home 层，优先级高于 profile 层
5. 每个 --patch <path> overlay      ← 按 argv 顺序
6. DSH_TELEMETRY_DISABLED 派生的 patch（仅当一个受影响的 row 存在）
```

代码（`apps/cli/src/profile-boot.ts:137-144`）：

```ts
function allPatches(composed: ComposedProfile): PatchOptions[] {
  return [
    ...composed.bundlePatches,        // 2
    ...composed.profile.patches,      // 3
    ...composed.homePatches,          // 4
    ...composed.overlays,             // 5 + 6
  ]
}
```

**"later layers win per row"** 由 `applyEntryPatches` 的单遍顺序扫描实现（`include/index.ts:77` `for (const patch of patches)`，后写的 `target[key] = value` 覆盖前面的）。

### 7.3 `--patch` CLI 参数**存在**

```ts
// apps/cli/src/args.ts:137-140
.option('--profile <name>', 'the profile under $DSH_HOME/profiles to boot')
.option('--patch <path>', 'extra patch-list overlay applied after the profile layer (repeatable)', collect)
.option('--dump-config', 'print the composed profile tree and exit')
.option('--dump-default-config', 'print the profile tree without its user layer or --patch overlays and exit')
```

```ts
// apps/cli/src/args.ts:61
const collect = (value: string, previous: string[] = []): string[] => [...previous, value]
```

注意 `args.ts:58-60` 的注释：
> "Repeatable single-value collector: `--patch a.yml --patch b.yml`. Never variadic — a variadic `--patch` would swallow the inner arguments."

`--patch` 只作用于**当次调用**，不落盘（`docs/user/develop/practice/dynamic-cordis.md:12` 的 `pnpm dsh web --patch apps/cli/config/examples/cordis/cordis.yml` 就是这种一次性用法的真实例）。

### 7.4 `dsh plugin` 的真实实现（安装本地插件）

```ts
// apps/cli/src/plugin.ts:120
export function runPlugin(profile: string, args: readonly string[]): number {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[profile]
    initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES, template?.patchReload)   // :124-128
    process.stderr.write(`dsh: initialized profile ${profile} at ${dir}\n`)
  }
  const before = readProfileManifest(NAME, dir)
  const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), {   // :134
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  ...
  if (exitCode === 0) reconcilePlugins(before, dir)   // :148-149
```

`anchorPathSpec`（`plugin.ts:104-112`）—— 相对路径锚定到**调用目录**：

```ts
function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  const prefix = match.groups.prefix ?? ''
  return `${prefix}${resolve(cwd, match.groups.path)}`
}
```

`reconcilePlugins`（`plugin.ts:59-91`）—— 按**已安装状态**重算 `dsh.profile.bundles`：

```ts
function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const after = readProfileManifest(NAME, profileDir)
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const dependencies = Object.keys(after.dependencies ?? {})
  const plugins = after.dsh?.profile?.bundles ?? []
  let changed = false
  for (const packageName of dependencies) {
    const isBundle = exportsPatch(packageName, profileDir)      // :66 → dsh.bundle.patch !== undefined
    if (isBundle && !plugins.includes(packageName)) {
      plugins.push(packageName)                                  // :68  新 bundle 追加到末尾
      changed = true
    } else if (!isBundle && !beforeDeps.has(packageName)) {
      process.stderr.write(`dsh: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`)   // :71-74
    }
  }
  ...
}
```

### 7.5 三种"安装本地开发插件"的真实路径

**路径 A：作为 bundle 安装（推荐，可被他人复用）**

```sh
# 在插件 checkout 里，必须有 package.json 声明 dsh.bundle + cordis.patch.yml
dsh plugin --profile demo add ./hello-plugin
# → pnpm link/file 进 $DSH_HOME/profiles/demo/node_modules
# → reconcilePlugins 自动把 dsh-hello-plugin 追加进 dsh.profile.bundles
dsh --profile demo --dump-config     # 验证层出现
dsh --profile demo
```

真实案例（实机只读观察）：`C:\Users\yanghuisong\.dsh\profiles\desktop\package.json` 里
```json
"dependencies": { "@local/tutor-runtime": "link:F:/xufeng/deepseek-learn-system/tutor-runtime", ... },
"dsh": { "profile": { "bundles": [..., "@local/tutor-runtime", "dsh-pet"] } }
```
而被 link 的 `F:\xufeng\deepseek-learn-system\tutor-runtime\package.json` 声明了
```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```
其 `cordis.patch.yml` 是：
```yaml
- insert:
    - id: tutor-runtime
      name: '@local/tutor-runtime'
```
这是**"本地开发 bundle"的完整最小真实范例**。【已由源码确认 · 实机只读观察】

**路径 B：只装成普通依赖，在自己的 profile `cordis.patch.yml` 里手写 insert 行**

适用于不想维护 `dsh.bundle` 的场景（例如当前已有的 memory/teach 包）：

实机观察 `C:\Users\yanghuisong\.dsh\profiles\web\package.json`：
```json
"dependencies": {
  "@deepseek-ai/dsh-memory": "file:F://.../memory/memory",
  "@deepseek-ai/dsh-memory-policy": "file:F://.../memory/memory-policy",
  "@deepseek-ai/dsh-memory-tencentdb": "file:F://.../memory/memory-tencentdb",
  "@deepseek-ai/dsh-tool-memory": "file:F://.../memory/tool-memory",
  "@deepseek-ai/dsh-teach-activity": "link:F://.../teach/teach-activity",
  ...
},
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "patchReload": "live" } }
```

**⚠️ 重大发现**：这 7 个包**全部没有 `dsh.bundle`**（我逐个读了它们的 `package.json`，`dsh` 字段为空），也**没有出现在 `dsh.profile.bundles` 里**，且 `profiles\web\cordis.patch.yml` 里**没有任何一行引用它们**（grep `dsh-memory|dsh-tool-memory|dsh-teach` → 0 命中）。

> **【基于源码推断】** 按 §1 的装载链，这 7 个包**从来没有被挂载过**。它们只是被 pnpm 装进了 `node_modules`（并且 `nodeLinker: hoisted` 让它们可被解析），但没有任何 patch 层 insert 它们 → Loader 里没有对应 entry → `ctx.loader.entries()` 里不存在 → Cordis 从未 `apply` 过它们。
>
> 这正是 Q8 要区分的那个陷阱的**真实活样本**：**"目录里有、package.json 里有"≠"运行时加载了"**。
>
> 验证方法：在 Web GUI 的 Settings → Plugins 页看 `pluginInventory.list()` 的输出（§8），或用 `--dump-config` 看合成的行里有没有它们的 id。

**路径 C：一次性 `--patch` 覆盖（不落盘）**

```sh
dsh web --patch ./my-overlay.yml
```
其中 `my-overlay.yml` 可以写相对路径 name（会被锚定到该 overlay 文件目录）：

```yaml
# F:\xufeng\deepseek\deepseek-harness-master\apps\cli\tests\profiles\headless\tests\fixtures\startup-activation-error\activation-error.patch.yml
- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
- insert:
    - id: activation-error
      name: ./activation-error.mjs        # ← 相对 patch 文件所在目录
```
【已由源码确认，这是仓库里的真实测试 fixture】

### 7.6 `patchReload` 语义

```ts
// packages/util/package-manifest/src/types.ts:41
export type ProfilePatchReload = 'live' | 'startup'
```

- `live` → 启动后 `watchUserPatches` 监听 profile 与 home 两个 patch 文件，改动**事务性重放**（`apps/cli/src/profile-boot.ts:283-313`）。
- `startup` → 只加载一次，不装 watcher。
- 省略 → 自定义 profile 默认 `live`（`profile.ts:142` `DEFAULT_PROFILE_PATCH_RELOAD: ProfilePatchReload = 'live'`）；内置模板各有显式值（`profile.ts:110-131`：web=live，其余=startup）。

**重要边界**：`live` 只重放**用户层**，bundle 层在下方保持不变（`profile-boot.ts:256-261` `composeLive`）。**bundle 集合的变更（`dsh plugin add/remove`）必须重启进程**（`apps/cli/reference/README.md:58`："a running Profile keeps the Bundle set from its current start. Restart that Profile after adding, removing, or updating a Bundle."）

**HMR 依赖**：`live` 需要 `hmr` 服务；`dsh-base` 默认把 `hmr` 行禁用（`packages/bundle/base/cordis.patch.yml:21-25` `disabled: true`），于是 launcher 自己造一个 watch-only 实例（`profile-boot.ts:294-299`）：

```ts
if (ctx.get('hmr') === undefined) {
  if (ctx.get('timer') === undefined) {
    await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
  }
  await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
}
```

注意 `root: []` —— **只监听配置，不监听源码模块**。

### 7.7 内置 profile 模板

```ts
// packages/boot/app-boot/src/profile.ts:110-131
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  acp:           { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],  patchReload: 'startup' },
  web:           { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' },
  headless:      { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],patchReload: 'startup' },
  sdk:           { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'], patchReload: 'startup' },
  'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'],                       patchReload: 'startup' },
}
// :139
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']
```

`desktop` profile 被 CLI 显式拒绝（`apps/cli/src/args.ts:63-67` `rejectElectronProfile`，`args.ts:65` "profile \"desktop\" is managed exclusively by the Electron application"），由 `apps/desktop-host/src/index.ts:154` 的 `loadProfileDirectory` 单独装载。

---

## 8. 如何**运行时**验证插件真的加载了（Q8）—— 本轮最重要的一节

### 8.1 先划清三个层次的证据强度

| 层次 | 手段 | 能证明什么 | 不能证明什么 |
|---|---|---|---|
| **L1 静态合成** | `dsh --profile x --dump-config` | 配置里**有**这一行、叠层顺序正确 | 模块能否解析、`apply` 有没有跑、服务有没有起来 |
| **L2 装载审计** | boot 时的 `assertEntriesActivated` | entry 存在 **且** fiber 到 ACTIVE | 插件内部注册是否生效（只保证 `apply` 返回了） |
| **L3 运行时投影** | `ctx.loader.entries()` / `pluginInventory.list()` / 插件自己注册的服务 | **活的** fiber 状态 + 服务可见性 | 业务语义正确性 |

### 8.2 L1：`--dump-config`（**只能证明"配置文件里有"**）

```sh
dsh --profile demo --dump-config          # bundle 层 + profile 层 + home 层 + --patch
dsh --profile demo --dump-default-config  # 只有 bundle 层
```

实现：`apps/cli/src/dump-config.ts:30-52` → `renderConfigDump`（`packages/boot/app-boot/src/index.ts:409-472`）。

**输出格式关键**：每组行前面有 `# == <来源>` 注释，且列出**哪些层 patch 过它**（`index.ts:492-494`）：

```ts
const label = record.patchedBy.length === 0
  ? record.origin
  : `${record.origin}, patched by ${record.patchedBy.join(', ')}`
```

真实期望（`apps/cli/tests/built-bin.e2e.ts:953`）：
```ts
expect(stdout).toContain('# == @deepseek-ai/dsh-base')
```

**局限（非常重要）**【已由源码确认】：
- 不 boot，**不运行任何 app command-line provider**（`dump-config.ts` 无 `cmdlineArgs` 参与）→ 无法显示 flag 决定的值。
- **不求值 `!!js`**（`index.ts:386` 注释 "`!!js` expressions print verbatim, unevaluated"）。
- `--dump-default-config` 不准备模块 fallback（`apps/cli/reference/README.md:42`："does not prepare the runtime module fallback under `$DSH_HOME/profiles/node_modules`"）→ **在 dump 里看到某行不代表它能被 import 到**。
- 带 app 参数会直接报错（`args.ts:101-103`）。

> **结论：`--dump-config` 是"我写对了配置"的证据，不是"插件跑起来了"的证据。**

### 8.3 L2：boot 时的强制审计（**证明"import + apply 成功"**）

```ts
// packages/boot/app-boot/src/index.ts:688
export function assertEntriesLoaded(ctx: Context, binName: string): void {
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    const names = failed.map(entry => entry.options.name).join(', ')
    throw new Error(`${binName}: plugin(s) failed to load: ${names}; Cordis startup failed ...`)
  }
}
```

```ts
// packages/boot/app-boot/src/index.ts:722
export async function assertEntriesActivated(ctx: Context, binName: string): Promise<void> {
  assertEntriesLoaded(ctx, binName)
  const failures: string[] = []
  const rejectionReasons: unknown[] = []
  for (const entry of ctx.loader.entries()) {
    const fiber = entry.fiber
    if (fiber === undefined || entry.disabled) continue
    const state = fiber.state
    if (state === FIBER_ACTIVE) continue
    if (state === FIBER_FAILED) {
      try { await fiber.await() } catch (error) {
        rejectionReasons.push(error)
        failures.push(`${entry.options.name}: ${formatActivationError(error)}`)   // :736  带原始 stack
      }
      continue
    }
    if (state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter(service => fiber.ctx.get(service) === undefined)
      const subject = missing.length === 1 ? 'service' : 'services'
      failures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(', ') || 'unknown'})`)  // :743
    } else {
      failures.push(`${entry.options.name}: fiber state ${String(state)}`)
    }
  }
  if (failures.length > 0) {
    if (rejectionReasons.length > 0) await observeLoaderRejectionCheckpoint(rejectionReasons)
    throw new Error(`${binName}: ${String(failures.length)} ${noun} did not activate\n${failures.join('\n')}`)   // :753
  }
}
```

**这给出了两种运行时失败的可读诊断**，实测期望格式（`apps/cli/tests/profiles/headless/tests/expected/startup-activation-error/stderr.expected.txt`）：

```
headless-test-driver: plugin tree failed to load: failed to apply loader entry include (cordis:include):
  failed to apply loader entry activation-error (./activation-error.mjs): startup activation snapshot failure
Error: startup activation snapshot failure
    at activation-error-fixture
```

`pending (waiting for service: X)` 是**最容易踩的坑**：插件写了 `inject = ['foo']`，`foo` 没被任何行提供 → 进程直接启动失败并告诉你缺哪个服务。

**另外还有 fail-loud 兜底**（`index.ts:639-679` `installFailLoud`）：`unhandledRejection` → 打 `dsh: fatal load failure: <stack>` 并 `exit(1)`，带 2s 的 terminal release 窗口（`index.ts:608` `FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000`）。在 `profile-boot.ts:239` 安装。

### 8.4 L3：运行时投影（**真正能证明"活的"**）

**(a) `ctx.loader.entries()` + `fiber.state` —— 插件自己就能查**

```ts
// packages/plugins.../plugin-inventory/src/index.ts:65-89（这就是生产实现）
@Remote('list')
async list(): Promise<PluginInventorySnapshot> {
  const entries: PluginInventoryEntry[] = []
  for (const entry of this.ctx.loader.entries()) {
    if (entry.options.group) continue
    entries.push({
      entryId: pluginEntryId(entry.id),
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
    })
  }
  ...
}
```

`FiberState` 映射（`packages/host/plugin-inventory/src/index.ts:26-43`）：
```ts
const FIBER_STATE = {
  PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3, DISPOSED: 4, UNLOADING: 5,
}
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending', [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',   [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,     [FIBER_STATE.UNLOADING]: 'unloading',
}
```

> 注意 `FiberState` 是 **const enum**（`vendor/cordis/src/fiber.ts:147-154`），没有运行时对象可 import，所以三个包各自手抄了一份镜像值并注释说明（`app-boot/src/index.ts:697-703`、`plugin-inventory/src/index.ts:25`、`client/web/src/loader-status.ts:9-14`）。

**(b) `pluginInventory.list()` Remote —— Web GUI 的 Plugins 页就是这个**

- 服务：`packages/host/plugin-inventory/src/index.ts:46` `export class PluginInventoryGateway extends TypertRemoteService`，`static inject = ['loader']`（:47），`super(ctx, 'pluginInventory')`（:50）
- 挂载行：`packages/bundle/web-app/cordis.patch.yml:100-102`
  ```yaml
      # Read-only projection of current Loader entries for trusted client RPCs.
      - id: plugin-inventory
        name: '@deepseek-ai/dsh-host-plugin-inventory'
  ```
- 浏览器消费：`packages/client/ui-settings-plugin-inventory/src/client/index.ts:36-42`
  ```ts
  const list: PluginInventorySettingsTabInjected['list'] = async () => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }
  ```
- 挂载行：`packages/bundle/web-app/cordis.patch.yml:341-342` `ui-settings-plugins`

**返回形状**（`packages/host/plugin-inventory/src/types.ts:16-23`）：
```ts
export interface PluginInventoryEntry {
  readonly entryId: PluginEntryId
  readonly moduleName: string                 // 精确 module specifier
  readonly enabled: boolean                   // 含祖先 group disabled 传播
  readonly fiberPhase: PluginFiberPhase       // 'pending'|'loading'|'active'|'failed'|'unloading'|null
}
```

> **这是区分"配置里有"与"真的加载了"的官方探针。** `fiberPhase === 'active'` 就是"真的跑起来了"，`null` + `enabled: true` 就是"配置了但没 fiber"（=加载失败，虽然 boot 审计本该已经拦下），`enabled: false` 是"被 patch 禁了"。
>
> **在 Web GUI 里点 Settings → Plugins 的 "All" 页签即可**（`ui-settings-plugin-inventory/src/client/index.ts:50-57` 注册 `settings.plugins.tab` 的 `id: 'all'` 槽）。

**(c) Cordis 服务可见性 —— 更强，能证明"服务真的提供了"**

```ts
// packages/extensions/tool-cordis/src/inspect.ts:36-41
function liveImpls(ctx: Context): { name: string; fiber: Fiber }[] {
  const store = ctx.reflect.store
  return Object.getOwnPropertySymbols(store)
    .map(key => store[key])
    .filter((impl): impl is NonNullable<typeof impl> => impl !== undefined)
}
```

```ts
// packages/extensions/tool-cordis/src/inspect.ts:104-109
export function providedServices(ctx: Context, fiber: Fiber): string[] {
  return liveImpls(ctx)
    .filter(impl => withinFiber(impl.fiber, fiber))
    .map(impl => impl.name)
    .sort()
}
```

```ts
// packages/extensions/tool-cordis/src/inspect.ts:119-120
export function missingServices(ctx: Context, fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
}
```

这三条是 `cordis_inspect_self` / `cordis_inspect_list` 的底座（`packages/extensions/tool-cordis/src/index.ts:44-61`、`:99-150`）。要开这些工具需要 mount `@deepseek-ai/dsh-tool-cordis` + `@deepseek-ai/dsh-cordis-host-runner`（`apps/cli/config/examples/cordis/cordis.yml:15-19` 就是官方示例 overlay）。

**(d) `dsh_plugin_packages` —— 模型请求里带的活跃插件包清单**

`packages/llm/plugin-package-inventory-deepseek/src/index.ts`：
- 服务名 `plugin-package-inventory-deepseek`（:26），`inject = ['agents','deepseekLlmApiExtensions','loader']`（:28）
- `activeEntries(tree)`（:132-143）过滤条件：
  ```ts
  .filter(entry => !entry.options.group
    && !entry.disabled
    && entry.fiber?.state === FiberState.ACTIVE)
  ```
- 这个清单会**发给 DeepSeek 官方 API**（`inject` 里的 `deepseekLlmApiExtensions`）。base 行：`packages/bundle/base/cordis.patch.yml:70-71`。

> 所以如果你在 Web GUI 里发一条消息，DeepSeek 请求里带的 `dsh_plugin_packages` 字段就是一份**运行时确认过的**活跃插件清单。

### 8.5 日志（有边界）

- 插件加载日志：`vendor/loader/src/index.ts:172-175` `showLog(entry, type)`，`type` ∈ `'apply'`（`entry.ts:295`）、`'unload'`（`index.ts:149`）、`'reload'`（`index.ts:113`）。
- **默认不打印**：`vendor/loader/src/index.ts:173` `if (entry.options.group || !entry.parent.tree.enableLogs) return`，而 `enableLogs` 从 `Include.Config.enableLogs` 来（`vendor/include/src/index.ts:169`、`:196`）。
- **`enableLogs` 在 DSH 的所有 shipped patch 里都没有开启**（grep `enableLogs` 于所有 `*.yml` → 0 命中）。
- 所以 `apply`/`unload` 日志**默认静默**。要开需要自己在 `--patch` overlay 里给 `include` 行加 `config.enableLogs: true`——但这行是 launcher 内部创建的（`app-boot/src/index.ts:548-552`，id 固定为 `'include'`），可以按 id 打补丁。

**【基于源码的推断】** 更实用的日志路径是插件自己在 `apply` 里 `ctx.logger('my-plugin').info('loaded')`：
- `ctx.logger` 是 callable service（`vendor/cordis/src/logger.ts:194-224`，`[symbols.invoke]` 在 :251）
- 默认有一个内置 exporter 只往**环形缓冲区**写（`logger.ts:213-221`，`bufferSize = 1000`），**不打印到 stdout**
- 要打到控制台需要 mount `@deepseek-ai/cordis-plugin-logger-console`（`vendor/logger-console/src/shared.ts:28-58`，构造函数里 `ctx.logger.exporter(this)` 在 :57）

**【尚待实验验证】** 我需要确认 DSH 生产组合里到底有没有任何一个 console logger exporter。我 grep 了：
- 所有 `*.yml` 里的 `logger` → 只在 `packages/session/session-telemetry-otel/tests/fixtures/telemetry.patch.yml:26-32`（**测试 fixture**）出现
- `packages/` 里 `ctx.logger.exporter` → 只在 `packages/experimental/webworker-runtime/src/worker-host.ts:322` 出现
- `apps/` 里 `logger|exporter` → 只有两处注释

**结论【基于源码的推断】**：DSH 的 base/web/headless/acp/sdk 组合**没有任何 stdout 日志 exporter**，`ctx.logger.*` 调用默认静默（或进 Web GUI 的日志面板，需另查 client 侧消费，超出本轮范围）。**因此"看控制台有没有插件打印"在 DSH 里是无效的加载验证手段** —— 这跟很多插件系统非常不同。

### 8.6 推荐的验证流程（可操作）

```sh
# 1. 静态：确认层出现、顺序正确
dsh --profile demo --dump-config | grep -n "my-plugin"

# 2. 真装载：boot 一次，任何 entry 没到 ACTIVE 都会非零退出并打印原因
dsh --profile demo --help        # 或直接 boot
#   期待：没有 "plugin(s) failed to load" / "did not activate" / "pending (waiting for service: ...)"

# 3. 运行时投影（需要 Web profile 且挂了 plugin-inventory 行）
dsh web
#    → GUI: Settings → Plugins → "All" 页签 → 找 moduleName 与 fiberPhase
#    → 期待 fiberPhase === 'active'

# 4. 最强证据：让插件自己暴露可观察副作用
#    例如注册一个服务 + 一个工具，然后在会话里用这个工具
```

**【基于源码的推断】** 对自动化验证，最可靠的是写一个测 harness 直接断言 L3：

```ts
// 伪代码，根据 packages/host/plugin-inventory/tests/inventory.spec.ts 的模式
const ctx = await boot('test', rootConfig, patches)
const snapshot = await ctx.get('pluginInventory').list()
expect(snapshot.entries.find(e => e.moduleName === 'my-plugin')?.fiberPhase).toBe('active')
```

真实例子见 `packages/host/plugin-inventory/tests/inventory.spec.ts:46-91`（用 `ctx.loader.create(...)` 造 entry，断言 `fiberPhase`）。以及 `packages/test-support/loader-smoke/` 提供的子进程隔离 smoke 模式（`runLoaderSmoke`，见 `packages/test-support/loader-smoke/tests/loader-smoke.spec.ts:16-44`）。

---

## 9. 与「沿用 Mnemon Source 挂载方式」的关键差异

> 说明：我无法读到 Mnemon 的源码（不在本仓库）。以下对比基于**DSH 侧的确凿源码**，以及任务背景里"Mnemon Source 挂载方式"的隐含特征（外部 Provider 描述符 + 进程外挂载）。凡涉及 Mnemon 侧的判断都标为【基于源码的推断】。

| 维度 | DSH 原生机制（已确认） | 「Mnemon Source 挂载」式做法的隐含假设 | 后果 |
|---|---|---|---|
| **插件身份** | Cordis plugin：`{ name, inject?, Config?, apply(ctx, config) }` 或 `extends Service`（`vendor/cordis/src/registry.ts:92-133`） | 一个 provider 描述符 + 一个适配器对象 | **不兼容**。DSH 没有"provider 描述符"这一层。必须真写一个 Cordis 插件。 |
| **生命周期** | Fiber 状态机 `PENDING→LOADING→ACTIVE→FAILED/UNLOADING→DISPOSED`（`vendor/cordis/src/fiber.ts:147-154`），由**服务可用性**驱动 | 手动 start/stop | DSH 里**你无法"手动启停"一个插件**（除 `fiber.dispose()`），装载/卸载由 `inject` 服务变化自动触发。禁用某行只能改 patch 的 `disabled` 或 `loader` 操作。 |
| **依赖声明** | `inject = ['tools', 'agents', ...]`，缺失就**停在 PENDING 且 boot 失败**（`app-boot/src/index.ts:743`） | 运行时 `try/catch` 或可选查找 | **装配错误会 fail-loud 打不出来**。DSH 的设计哲学是"缺依赖就启动失败"，不是降级。 |
| **资源释放** | `ctx.effect(() => cleanup)` / `ctx.on()` / Service 构造器 / `register()` 返回 disposer；**没有 `ctx.on('dispose')`** | 显式 `dispose()` / `close()` 钩子 | 必须把所有外部资源包进 `ctx.effect`。裸 `setInterval`/`fs.watch`/socket **不会被自动清理**。 |
| **配置** | schemastery `Config` schema，Loader 激活前校验并填默认（`fiber.ts:50-62`） | 自读配置文件 | 必须导出 `Config` schema，且**所有可调值必须是字段**（`docs/user/develop/basic/config.md:78-92` 明确"anything that two deployments may want to set differently to be a configuration field"）。 |
| **注册面** | 通过**已有的 hub service**：`ctx.tools.register` / `ctx.systemPrompt.section` / `ctx.on` / `ctx.sessionProjections.register` / `ctx.llm.registerAdapter` | 自建注册表 | 不要自建注册表。DSH 的 markdown 反复强调 "Prefer events for interception and policy; prefer service methods for direct capability calls"（`docs/cordis-primer.md:43`）。 |
| **持久化** | `ctx.storage`（KV hub）/ `ctx.sessionProjections`（事件折叠）/ 直接 `session.append(type, data)`（`tool-todo/src/index.ts:210`） | 自建 store | DSH **不给插件一个"通用 DB"**；要么走 storage domain，要么写 session 事件。 |
| **发现机制** | **Node 模块解析**（两锚点：dsh 安装目录 → profile 目录），无扫描、无注册表文件 | 读一个 sources 目录做扫描 | DSH 里"装在 node_modules 里"**不等于**"被挂载"。必须有一行 patch insert 它（见 §7.5 路径 B 的真实反例）。 |
| **可复现性** | 整棵树可 `--dump-config` 静态重建；`!!js` 保持原文不求值 | 运行期状态为主 | DSH 的 composition 是**纯数据可审计**的。这对"插件是否生效"很有帮助（但只到 L1）。 |
| **安装** | `dsh plugin --profile x add <spec>` → pnpm + 自动并入 `dsh.profile.bundles`（`apps/cli/src/plugin.ts:149`） | 拷贝目录 / 手改配置 | 手改 `dsh.profile.bundles` 也可以，但漏写或漏装都是**硬失败**（`profile.ts:793`）。 |
| **UI 半** | `dsh.client` manifest + `exports['./client']`，由 `@deepseek-ai/dsh-client-modules` 扫描合成 `window.__DSH_BOOT__`（`packages/client/modules/src/index.ts:2-4`、`:241`、`:293`） | 无 | 若 Mnemon 需要 Web GUI 界面，**必须**声明 `dsh.client`，且两个半必须成对（`scripts/verify-cordis-config.ts:104-117` 专门校验这个不匹配）。 |

### 9.1 三条最容易踩的差异（给 Lead 的重点）

1. **"装了"≠"挂了"**。DSH 只有一行 patch insert 才算挂载。`node_modules` 里有包、`package.json` 里有依赖，Loader 里可以完全没有它。实机已经存在这种状况（§7.5 路径 B 的 7 个 memory/teach 包）。
2. **缺依赖是启动失败，不是降级**。`inject` 里写了一个没人提供的服务 → 整个进程 boot 失败，错误消息是 `pending (waiting for service: X)`。
3. **没有 `ctx.on('dispose')`**。要释放外部资源，唯一正确做法是 `ctx.effect(() => { acquire(); return () => release() })`。裸资源会泄漏。

---

## 10. 阻塞点 / 无法确认的地方

| # | 项目 | 状态 | 说明 |
|---|---|---|---|
| 0 | **`include:<child-id>` 前缀在 patch 里无效** | **基于源码的推断（高置信）+ 尚待实验验证** | 见下方 §10.1 详细分析。**这条直接影响"沿用 Mnemon 挂载方式"的可行性判断**，因为它是 patch 语法层面最常见的误解，且会导致 profile 声称的"工具面收窄"实际不生效。 |
| 1 | Mnemon 的实际挂载实现 | **无法确认** | Mnemon 源码不在 `deepseek-harness-master` 里。`dsh-mnemon` 这个包名在 `profiles\web` 和 `profiles\desktop` 的 `node_modules` 里**都找不到**，且两个 profile 的 `dependencies` 里也没有它。但 `profiles\desktop\cordis.patch.yml:1210` 有 `- id: mnemon / name: dsh-mnemon` 的 insert 行。 |
| 2 | `dsh-mnemon` 是否曾成功加载 | **尚待实验验证** | 按 §1 的链，`name: dsh-mnemon` 会在 Loader `_init` 阶段走 `tree.import('dsh-mnemon')`（`entry.ts:280`），解析不到就 `updateError('import', ...)` → boot 失败。**如果 desktop profile 当前能正常启动，那么 `dsh-mnemon` 必然是可解析的**（可能通过 `$DSH_HOME/profiles/node_modules` 或某个 fallback，也可能该 patch 段是残留）。这需要实际 boot 或 dump 才能定论。 |
| 3 | `cordis.patch.yml` 的 `include:<child-id>` 形式 | **基于源码的推断 —— 极可能是无效写法** | `F:\xufeng\deepseek-learn-system\tutor-runtime\tutor-profile.patch.yml` 用了 `- id: include:tool-fs` / `include:tool-pwsh` / `include:tool-bash`。分析：<br>① `EntryTree.sep = ':'`（`vendor/loader/src/config/tree.ts:8`）与 `Entry.id` getter（`entry.ts:75-81`）确实会把根 Include 的子行拼成 `'include:' + options.id`——**但那只在 Loader 的 `Entry` 实例上**，供 `ctx.loader.resolve('include:tool-fs')` 用（`tree.ts:76-87`）。<br>② 补丁匹配用的是 `applyEntryPatches` 的**扁平 `entryMap`**，键是**纯数据对象**的 `options.id`（`vendor/include/src/index.ts:67-75` `buildMap`），`options.id` 永远是 `'tool-fs'`，从不带前缀。<br>③ 所以 `- id: include:tool-fs` 走的是 `include/index.ts:111-114` 的 `warn('patch: entry %C not found')` + `continue` —— **静默不生效，只打一行 warn**。<br>④ 同类语义已被测试钉死：`packages/boot/app-boot/tests/config-dump.spec.ts:118-150` 明确断言"单个 `applyEntryPatches` 调用里，纯 group `config` 替换引入的子行对后续 layer **不可见**"（`expect(warnings).toEqual([...'patch: entry "child" not found'])`）。<br>**结论：`tutor-profile.patch.yml` 那三行很可能从未生效。** 要让它们生效必须写 `- id: tool-fs`（不带 `include:` 前缀）。需实验确认（跑一次 `--dump-config` 看 stderr 的 warn）。 |
| 4 | `ctx.logger` 的实际输出目的地 | **尚待实验验证** | 确认了默认 exporter 只进内存 buffer（`vendor/cordis/src/logger.ts:213-221`）；确认了 shipped patch 里没有 console logger 行。但 **Web GUI 是否消费了 `ctx.logger` 的 buffer**（经 Typert Remote 或 SSE）我没查到消费端。若消费了，"看 GUI 日志"就是可用探针。 |
| 5 | 真实 `--dump-config` 输出 | **尚待实验验证** | 本轮禁止运行 `dsh`（会写 profile 文件），所以我没有 dump 过真实 profile 的输出。上述输出格式结论全部来自 `renderConfigDump` 源码（`app-boot/src/index.ts:409-503`）与测试断言（`built-bin.e2e.ts:953`）。 |
| 6 | `dsh-mnemon` 的 `memoryView.entries` 里 `include:mnemon-strategy-*` 的语义 | **无法确认** | 这是 `dsh-mnemon` 插件自己的 Config schema 里的**数据字段**（不是 patch 语法），因为它在 `config:` 下面。所以这是 Mnemon 自定义的、指向其内部 strategy 条目的引用。必须读 Mnemon 源码才能判断。 |
| 7 | `--allow-linked-profile` 的完整语义 | **基于源码的推断** | `apps/desktop-host/src/index.ts:382` 解析该 flag，`desktopPatches(projectDir, allowLinkedPackages)`（:152）在第 156 行 `if (!allowLinkedPackages && !isProjectPath(...)) throw`。即：默认禁止 profile bundle 解析到 project 目录**之外**（防 `link:` 逃逸到任意路径）；开发时用 `--allow-linked-profile` 放行。这与 `@local/tutor-runtime` 的 `link:F:/xufeng/...` 正好对应。 |
| 8 | `profiles\web` 里 7 个 memory/teach 包的挂载状态 | **基于源码的推断（高置信）** | 见 §7.5 路径 B：无 `dsh.bundle`、不在 `bundles` 列表、patch 里无引用 → 按装载链它们**没有被挂载**。需 `--dump-config` 或 `pluginInventory.list()` 实证。 |

### 10.1 `include:<child-id>` —— 一个高危的 patch 语法误解

**观察到的真实写法**（`F:\xufeng\deepseek-learn-system\tutor-runtime\tutor-profile.patch.yml`）：

```yaml
- id: include:tool-fs
  config:
    read: true
    readImage: false
    write: false
    edit: false

- id: include:tool-pwsh
  disabled: true

- id: include:tool-bash
  disabled: true
```

**为什么它很可能无效**【基于源码的推断】：

1. **`include:` 前缀只存在于 Loader 的 `Entry` 对象上，不存在于补丁数据里。**
   `Entry.id` getter（`vendor/loader/src/config/entry.ts:75-81`）：
   ```ts
   get id() {
     let id = this.options.id
     if (this.parent.tree.ctx.fiber.entry) {
       id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id
     }
     return id
   }
   ```
   这是给 `ctx.loader.resolve('include:tool-fs')`（`vendor/loader/src/config/tree.ts:76-87`）用的**运行时寻址**。

2. **补丁匹配用的是纯数据的 `options.id`，不带前缀。**
   索引构建（`vendor/include/src/index.ts:66-75`）：
   ```ts
   const entryMap = new Map<string, EntryOptions>()
   const buildMap = (entries: EntryOptions[]) => {
     for (const entry of entries) {
       if (entry.id) entryMap.set(entry.id, entry)      // ← 纯数据，永远是 'tool-fs'
       if (entry.group && Array.isArray(entry.config)) buildMap(entry.config)
     }
   }
   ```
   查表（`vendor/include/src/index.ts:110-114`）：
   ```ts
   const target = entryMap.get(id)
   if (!target) {
     warn('patch: entry %C not found', id)              // ← 'include:tool-fs' 必然落这里
     continue
   }
   ```

3. **同类语义已被仓库测试钉死。** `packages/boot/app-boot/tests/config-dump.spec.ts:118-150` 断言"一个 layer 用纯 group `config` 替换引入的子行，对后续 layer 的 patch **不可见**"：
   ```ts
   expect(warnings).toEqual([`${NAME}: [b.yml] patch: entry "child" not found`])
   ```
   测试注释（:119-124）："boot() flattens every layer into ONE applyEntryPatches call, whose id index sees inserted rows but NOT children introduced by a plain group `config` replacement."

4. **行为是"静默 + 一行 warn"，不是报错。** `include/index.ts:111-114` 之后 `continue`。所以**你会以为禁用了，其实没有**。

**正确写法**：直接写裸 id（`- id: tool-fs`）。因为 base bundle 是**在顶层 insert 所有行**的（`packages/bundle/base/cordis.patch.yml:15` 只有一个顶层 `- insert:`），所以 `tool-fs` 在顶层，id 就是 `tool-fs`（`base/cordis.patch.yml:260-261`）。

**影响（重要）**：如果 Mnemon/Teach 这一脉的 profile patch 沿用了 `include:xxx` 写法，那**它们所有"禁用工具 / 收窄工具面"的配置实际上都没生效**。这直接推翻 `tutor-profile.patch.yml` 头部注释所声称的：
> "The intended tool surface is tutor_session, tutor_role, tutor_checkpoint, tutor_gates, and read. write, edit, and pwsh are removed."

**【尚待实验验证】** 一条命令即可证实：
```sh
dsh --profile <tutor-profile> --dump-config 2>&1 | grep 'not found'
```

**与 Mnemon 那一处区分**：`C:\Users\yanghuisong\.dsh\profiles\desktop\cordis.patch.yml:1220-1227` 的 `include:mnemon-strategy-light-context:` 出现在 `config:` 下面，是 `dsh-mnemon` 插件**自己的配置数据字段**（键名恰好长得像 id），与 patch id 寻址无关。两处只是形似，性质完全不同——这也是这套机制容易混淆的地方。

---

## 附录 A：核心文件索引（本轮实际读过的关键文件）

| 文件 | 关键符号 / 行 |
|---|---|
| `package.json` | `:175` `"dsh": "node --import tsx/esm apps/cli/src/bin.ts"` |
| `apps/cli/src/bin.ts` | `:28` `runCli`, `:31` switch, `:58` `import.meta.main` |
| `apps/cli/src/args.ts` | `:118` `parseDshArgs`, `:137-140` flags, `:63` `rejectElectronProfile` |
| `apps/cli/src/profile-boot.ts` | `:210` `runProfile`, `:157` `composeProfile`, `:119` `prepareProfile`, `:137` `allPatches`, `:81` `PROFILE_ROOT_CONFIG`, `:71` `homePatchPath`, `:264` `boot(...)`, `:283-313` live watcher |
| `apps/cli/src/plugin.ts` | `:120` `runPlugin`, `:59` `reconcilePlugins`, `:36` `exportsPatch`, `:104` `anchorPathSpec` |
| `apps/cli/src/dump-config.ts` | `:30` `runDumpConfig` |
| `apps/cli/src/process-shutdown.ts` | `:4` `PROCESS_SHUTDOWN_TIMEOUT_MS`, `:22` `createProcessShutdown` |
| `packages/boot/app-boot/src/profile.ts` | `:42` `PROFILES_DIR`, `:45` `PROFILE_PATCH_FILENAME`, `:110` `PROFILE_TEMPLATES`, `:139` `DEFAULT_PROFILE_BUNDLES`, `:170` `initProfile`, `:751` `resolveBundleDir`, `:774` `loadProfileDirectory`, `:792` **`dsh.bundle.patch` 解析点**, `:820` `loadProfile`, `:846` `composeEntries` |
| `packages/boot/app-boot/src/index.ts` | `:295` `loadOptionalPatches`, `:315` `loadOverlayPatches`, `:326` `anchorInsertedPluginNames`, `:350` `parsePatchList`, `:409` `renderConfigDump`, `:516` `mountRootInclude`, `:639` `installFailLoud`, `:688` `assertEntriesLoaded`, `:722` `assertEntriesActivated`, `:787` `boot` |
| `vendor/include/src/index.ts` | `:23` `entryListSchema`, `:58` **`applyEntryPatches`**, `:145` `PatchOptions`, `:174` `class Include`, `:273` `[Service.init]` |
| `vendor/loader/src/index.ts` | `:65` `class Loader`, `:90` `reflect.provide('loader', ...)`, `:92-101` `internal/config` waterfall |
| `vendor/loader/src/config/entry.ts` | `:9` `EntryOptions`, `:142` `update`, `:259` `init`, `:277` `_init`, `:291` `_start` |
| `vendor/loader/src/config/group.ts` | `:20` `create`, `:48` `remove`, `:59` `update`（:71 并发挂载）, `:116` `class Group` |
| `vendor/loader/src/config/tree.ts` | `:8` `sep=':'`, `:27` `entries()`, `:46` `await()`, `:76` `resolve(id)`, `:97` `create`, `:145` `import` |
| `vendor/loader/src/config/utils.ts` | `:5` `evaluate`（`new Function`）, `:12` `interpolate` |
| `vendor/cordis/src/registry.ts` | `:71` `Inject.resolve`, `:92` `Plugin`, `:195` `RegistryService`, `:316` `plugin()` |
| `vendor/cordis/src/fiber.ts` | `:147-154` `FiberState`, `:265` dispose effect, `:415` `effect`, `:597` `_checkImpl`, `:611` `_refresh`, `:646` `_reload`, `:675` `_unload` |
| `vendor/cordis/src/reflect.ts` | `:233` `get`, `:277` `provide`（:278 effect）, `:345` `accessor`, `:364` `mixin` |
| `vendor/cordis/src/events.ts` | `:32` `DispatchMode`, `:254` `register`, `:288` `on` |
| `vendor/cordis/src/service.ts` | `:42` 构造函数（:57 `reflect.provide`） |
| `vendor/cordis/src/logger.ts` | `:194` `LoggerService`, `:213-221` 默认 buffer exporter, `:232` `exporter()`, `:251` `[symbols.invoke]` |
| `vendor/hmr/src/index.ts` | `:86` `class Hmr`, `:134` `registerConfig` |
| `packages/util/package-manifest/src/types.ts` | `:8` `DshManifest`, `:27` `DshBundleManifest`, `:33` `DshProfileManifest`, `:41` `ProfilePatchReload` |
| `packages/util/home-paths/src/index.ts` | `:12` `.dsh`, `:18` `DSH_HOME`, `:87` `resolveDshHome`, `:98` `dshHomePath` |
| `packages/core/tools/src/index.ts` | `:780` `ToolRuntime`, `:1027` `register`, `:1061` `restrict`, `:372` `ToolExecution` |
| `packages/core/system-prompt/src/index.ts` | `:399` `SystemPrompt`, `:448` `section`, `:483` `context`, `:515` `tools`, `:531` `variable` |
| `packages/core/session/src/index.ts` | `:422` `Session`, `:678` `append`, `:866` `SessionStore`, `:904` `create`, `:1144` `get`, `:1152` `list` |
| `packages/core/agent/src/index.ts` | `:249` `AgentRegistry`, `:282` `accessor('agent')`, `:303` `currentInitiator` |
| `packages/llm/llm/src/index.ts` | `:330` `LlmRuntime`, `:384` `registerAdapter` |
| `packages/session/session-projection/src/index.ts` | `:199` `SessionProjectionRegistry`, `:233` `register` |
| `packages/spill/spill-local/src/index.ts` | `:65` `LocalSpillStore`, `:95-101` **effect 范例** |
| `packages/host/plugin-inventory/src/index.ts` | `:26-43` `FIBER_STATE`/`FIBER_PHASE`, `:46` gateway, `:65` `list()` |
| `packages/host/plugin-inventory/src/types.ts` | `:7` `PluginFiberPhase`, `:16` `PluginInventoryEntry` |
| `packages/client/ui-settings-plugin-inventory/src/client/index.ts` | `:32-57` `apply`（Settings → Plugins → All） |
| `packages/client/web/src/loader-status.ts` | `:15-35` FiberState 镜像 |
| `packages/extensions/tool-cordis/src/index.ts` | `:25-26` name/inject, `:34` `apply`, `:44` `cordis_inspect_list` |
| `packages/extensions/tool-cordis/src/inspect.ts` | `:36` `liveImpls`, `:104` `providedServices`, `:119` `missingServices` |
| `packages/extensions/cordis-host-runner/src/index.ts` | `:124` `DynamicCordisRunnerService`, `:1237` `requireGroup`（`rootCtx.plugin`） |
| `packages/llm/plugin-package-inventory-deepseek/src/index.ts` | `:26-28` name/inject, `:132` `activeEntries`（`fiber.state === ACTIVE` 过滤） |
| `packages/bundle/base/cordis.patch.yml` | 487 行；`:12-13` 行顺序无语义；`:15` 唯一顶层 insert；`:184-197` telemetry；`:460-461` tools；`:465-467` system-prompt |
| `packages/bundle/web-app/cordis.patch.yml` | 487 行；`:5-6` config 整块替换；`:101-102` plugin-inventory；`:128` web-app/startup；`:135-140` webserver（`!!js ctx.webStartup.*`） |
| `packages/bundle/acp-app/cordis.patch.yml` | 21 行，**最小完整真实 patch 范例** |
| `docs/cordis-primer.md` | 全文；`:19-27` dispatch 模式表；`:37-45` Practical Rules |
| `docs/cordis-tutorial/02-lifecycle-and-effects.md` | 全文；`:94` disposer 顺序注意 |
| `docs/user/develop/basic/publish.md` | 全文；`:103-126` 安装与加载顺序；`:112-121` 四层顺序 |
| `docs/user/develop/framework/index.md` | 全文；`:40-63` 自动清理清单 |
| `apps/cli/reference/README.md` | 全文；`:9` profile boot；`:46` plugin management；`:58` bundle 集合需重启 |
| `.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md` | 全文；`:13` 决策；`:17` 两锚点解析；`:24-26` 否决的方案 |

## 附录 B：本轮**未**采取的操作（合规声明）

- 未修改 `deepseek-harness-master` 下任何文件。
- 未运行 `dsh` / `pnpm dsh` / 任何会写 profile 或 DSH_HOME 的命令。
- 未安装依赖。
- 未创建 git 提交。
- 仅在 `F:\deepseek-memory\docs\_investigation\A-bundle-loading.md` 写入本文件。
- 对本机 `C:\Users\yanghuisong\.dsh` 只做了**只读列举与读取**（`Get-ChildItem` / `Get-Content` / `Select-String`），未写入。
