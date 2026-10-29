# B — DSH 会话证据读取与生命周期事件（只读源码调查）

调查对象：`F:\xufeng\deepseek\deepseek-harness-master`，git HEAD `69646b1`，根包 `0.1.3-alpha.2`。
方法：以 `packages/**/src/*.ts` 为主证据，抽样交叉验证 `packages/core/session/lib/index.js` 编译产物；不使用 `.d.ts` 作结论。
本轮严格只读：未修改 DSH 源码、未安装依赖、未运行 `dsh`、未写任何 DSH 数据。

证据强度标记：
- **【源码确认】** 在源码里找到执行/派发/赋值点，且运行时路径可追。
- **【源码推断】** 类型或结构存在，但运行时是否填充/派发取决于部署组合或外部条件，源码不能单独证明。
- **【尚待实验验证】** 必须跑起来才能定论；本报告给出所需实验。

---

## 0. 一句话结论

DSH 的会话证据是**一条 append-only 事件日志**（`SessionEvent[]`），落盘为每会话一个 JSONL（默认 zstd）代际文件。
**没有「会话结束」生命周期事件**：`session/disposed` 只在会话离开内存 store 时触发（进程退出、agent dispose、发布回滚），不代表「这轮对话聊完了」。
可靠可用的一次性信号只有 **turn 级**（`turn/end` 日志事件 + `agent/status: 'idle'` 运行时事件）。
**消息归属可用但不够强**：`message.source.kind === 'user'` 是「人类渠道」而非「人类亲自输入」的证明；唯一更强的标记是 Web RPC 注入的 `source.rpcId`。
**模型调用走 `ctx.llm`**（`LlmRuntime.stream`），不是别的 service。

---

## 1. Q1 会话对象与持久化记录在哪定义（类型 + 存储格式）

### 1.1 会话对象：`Session`（内存，事件溯源）

`packages/core/session/src/index.ts:422` `export class Session`，核心私有字段只有一份日志：

```ts
// packages/core/session/src/index.ts:423
private log: SessionEvent[] = []
// packages/core/session/src/index.ts:440
readonly header: SessionHeader
// packages/core/session/src/index.ts:473
readonly firstLiveSeq: SessionLogOffset
```

追加语义（**唯一的写入口**）：`packages/core/session/src/index.ts:678`

```ts
append<T extends SessionEventType>(
  type: T,
  data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []
): SessionEvent<T>
```

读取入口：
- `eventAt(seq)` `index.ts:597`
- `snapshotEvents(fromSeq?, toSeqExclusive?)` `index.ts:609`（返回深冻结快照）
- `ownEvents()` `index.ts:624`（fork 继承前缀之后）
- `deriveMessages(): Message[]` `index.ts:799`（**派生**的模型消息历史，见 Q5）

### 1.2 事件封装与事件表（真正的事件词汇表）

事件封装 `packages/core/session/src/types.ts:453`：

```ts
export type SessionEvent<T extends SessionEventType = SessionEventType> = {
  [K in SessionEventType]: {
    type: K
    /** Monotonic sequence number within the session. */
    seq: SessionSeq
    /** Unix epoch milliseconds. */
    time: number
    data: SessionEventMap[K]
    ignorable?: true
  } & (K extends SurfaceEventType ? {
    sourceEventSeqs?: SessionSeq[]
    surfaceOp?: SurfaceOp
  } : object)
}[T]
```

事件表（core 部分）`types.ts:266` `interface SessionEventMap`，成员：`turn/start`(273)、`turn/end`(282)、`step/start`(284)、`step/end`(286)、`user/message`(294)、`assistant/message`(305)、`assistant/attempt`(319)、`tool/call`(325)、`tool/result`(337)、`request/header`(348)、`request/context`(358)、`session/end-seed`(381)。

**本 build 认识的真实事件名全表**（自动生成，53 个）在
`packages/core/session/src/known-event-types.ts:22` `KNOWN_SESSION_EVENT_TYPES`，
文档侧对偶物是生成产物 `docs/persistence-catalog.md`（1096 行，53 个 `#### ` 事件条目，含 surface/log-only 徽标）。
这**不是**「全部可能事件」：`SessionEventMap` 可被插件 declaration-merge 扩展，外部插件事件天然不在表内 —— 落盘读取时若遇到未知类型且无 `ignorable: true`，读取会**拒绝整个日志**（见 Q10）。

### 1.3 存储格式：`SessionHeader`（元数据）+ JSONL（事件体）

```ts
// packages/core/session/src/types.ts:91
export interface SessionHeader {
  readonly version: typeof SESSION_FORMAT_VERSION   // = 2  (types.ts:86)
  readonly id: SessionId
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: SessionId
  readonly isSeeded: boolean
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}
```

逻辑格式层定义 `packages/session/session-format/src/types.ts:16` `SessionFormatHeader` / `:29` `SessionFormatEvent` / `:37` `SessionFormatArtifact`。

物理落盘（唯一发布的 backend）`packages/session/session-persistence-jsonl`：
- 目录布局 `src/format.ts:252` `projectDir(root, cwd)` → `<root>/<projectKey(cwd)>/<sessionId>/`；
  `src/format.ts:265` `sessionDir`，`src/format.ts:296` `logPath`。
- 文件名代际 `src/format.ts:56` `generationLogFilename(version, compression)`，后缀 `src/format.ts:40` `logSuffix` → `.jsonl.zstd` 或 `.jsonl`。
- 每行一条事件：`src/format.ts:320` `eventLine(event)` = `JSON.stringify(sessionFormatCatalog.encodeCurrentEvent(...))`。
- 根目录由 bundle 配置：`packages/bundle/base/cordis.patch.yml:110-113` `- id: session-persistence-jsonl` / `root: !!js dshHomePath('sessions')` → `$DSH_HOME/sessions`（`$DSH_HOME` 解析见 `packages/util/home-paths/src/index.ts:87`）。

**【源码确认】** 注释 `session-persistence-jsonl/src/index.ts:165` 已明确「不再支持旧 DB backend」；`docs/subsystems/persistence.md` 的 *The backend* 段只列 `dsh-session-persistence-jsonl` 一个 provider。

---

## 2. Q2 插件能否读取已完成/进行中的会话？通过哪个 service/API

可以，两条真实路径。

### 2.1 首选：`ctx.sessionQuery`（`SessionQueryEngine`，live 优先）

定义 `packages/session-query/session-query/src/index.ts:97` `abstract class SessionQueryEngine extends Service`，
`static inject = ['sessions']`（`:98`），构造 `super(ctx, 'sessionQuery')`（`:105`）。

真实方法签名（全在 `index.ts`）：

| 方法 | 行 | 签名（真实源码） |
|---|---|---|
| `observeSession` | 139 | `(sessionId: SessionId, options?: SessionObservationOptions): Promise<SessionObservation>` |
| `readSession` | 183 | `async (sessionId: SessionId): Promise<SessionLogSnapshot>` |
| `listSessions` | 173 | `(signal?: AbortSignal): Promise<SessionRecord[]>` |
| `readSurface` | 308 | `async (sessionId: SessionId): Promise<SessionSurfaceSnapshot>` |
| `listEvents` | 267 | `async (sessionId: SessionId): Promise<SessionEventRecord[]>` |
| `filterEvents` | 278 | `async (sessionId, filters): Promise<SessionEventSearchDocument[]>` |
| `traceSession` / `traceEvent` | 325 / 338 | 血缘与事件链 |
| `searchSessions` / `searchEvents` | 152 / 163 | `abstract`，由 backend 实现 |

`readSession` 会**构造一个 Session 做重放校验**再返回（`index.ts:185-195`），所以它拿到的是「完整原始事件日志」：

```ts
// packages/session-query/session-query/src/index.ts:183
async readSession(sessionId: SessionId): Promise<SessionLogSnapshot> {
  const loaded = await this._corpus.load(sessionId)
  Session.create(sessionId, loaded.events, loaded.header, loaded.inheritedEventCount)
  return {
    session: structuredClone(loaded.header),
    inheritedEventCount: loaded.inheritedEventCount,
    events: loaded.events.map(snapshotSessionEvent),
  }
}
```

`SessionLogSnapshot` 形状 `packages/session-query/session-query/src/types.ts:49`：`{ session: SessionHeader; inheritedEventCount: SessionLogOffset; events: SessionEvent[] }`。

live 优先解析在 `packages/session-query/session-query/src/corpus.ts:91` `load()`：
先 `ctx.sessions.get(id)`（live），命中则 `snapshotLive`（`corpus.ts:297`）；未命中才走 persistence（`corpus.ts:99-119`）。冷读会补 `interruptedTurnClosers`（`corpus.ts:104` → `cold-read.ts:55`）。

### 2.2 直连：`ctx.sessionPersistence`（`SessionPersistence` 抽象 seam）

定义 `packages/session/session-persistence/src/index.ts:135`，`super(ctx, 'sessionPersistence')`（`:137`）：
- `abstract create(header, options?): Promise<SessionHandle>` `:147`
- `abstract open(id, access: 'read'|'write', options?): Promise<SessionHandle>` `:162`
- `abstract flush(): Promise<void>` `:175`
- `abstract stat(id, options?)` `:191` / `abstract list(options?)` `:198`

真正逐事件读取在 handle 上：

```ts
// packages/session/session-persistence/src/handle.ts:83
read(offset?: number, length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult>
// handle.ts:97
append(events: readonly SessionEvent[], options?): Promise<void>
// handle.ts:109
flush(options?): Promise<void>
// handle.ts:116
close(): Promise<void>
```

`SessionHandleReadResult`（`handle.ts:23`）= `{ eventState: SessionSeedEventState; events: readonly SessionEvent[] }`。

【源码确认】`open(id, 'read')` **不取写锁**，可在另一进程持写的情况下读（`index.ts:151-161` 注释 + `jsonl/src/storage.ts:118` 的 read 实现）。
【源码确认】只读 handle 的 `append`/`flush` 会抛 `SessionReadOnlyError`（`jsonl/src/storage.ts:320`、`:206`）。

### 2.3 只读「正在进行的会话」

- 内存态：`ctx.sessions.get(id)` / `ctx.sessions.list()`（`packages/core/session/src/index.ts:1144` / `:1152`）。
- 注意 `ctx.sessions.list()` 只列 **live** 会话；冷会话必须走 `sessionQuery` 或 persistence。
- 【源码确认】live 会话在 `SessionHandle` 上可能还没 flush 到磁盘；`jsonl` 的 live 事件是 200ms 批次写出（`jsonl/src/storage.ts:36` `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200`）。要做「磁盘一致性」读取必须先 `await ctx.sessions.flush(session)`（`index.ts:1111`）。

---

## 3. Q3 是否存在可靠的「会话结束 / 消息完成 / 会话刷新 / 销毁」生命周期事件

### 3.1 结论表

| 需求 | 是否存在 | 确切名字 | 强度 |
|---|---|---|---|
| **会话结束（一次性，聊完）** | **不存在** | — | **没有**。没有 `session/end`、`session/closed`、`session/idle` 之类事件（全仓 grep `'session/(start\|closed\|close\|ended\|end\|idle\|touched\|updated)'` 零命中） |
| 会话销毁 | 存在 | `session/disposed` | 【源码确认】仅在 store 移除时（进程退出 / agent dispose / 创建回滚），**不是**「对话完成」 |
| 会话创建 | 存在 | `session/created` | 【源码确认】`index.ts:50` |
| 每条事件提交 | 存在 | `session/event` | 【源码确认】post-commit fire-and-forget |
| 持久化屏障 | 存在 | `session/flush` | 【源码确认】parallel 且被 await |
| **turn 结束（真正可用的一次性窗口信号）** | **存在** | 日志事件 `turn/end`；运行时 `agent/status`(`idle`)；运行时 `agent/turn-stopping` | 【源码确认】 |
| 消息完成 | 存在（模型侧） | `assistant/message` / `assistant/attempt` | 【源码确认】 |
| 用户消息完成 | 同 `user/message` 日志事件 | — | 只有「已入日志」这一事实 |

### 3.2 会话生命周期事件的确切签名（`packages/core/session/src/index.ts`）

```ts
// index.ts:50
'session/created'(this: Scoped<Session>, session: Session): void
// index.ts:60
'session/disposed'(this: Scoped<Session>, session: Session): void
// index.ts:72
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
// index.ts:81
'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void
```

派发点（**全部在 SessionStore 里自己实现，未走裸 `ctx.emit`**）：
- created：`index.ts:1069` `collectSessionCallbacks(this.ctx, [entry.carrier, 'session/created', session])` + `:1076` 逐个调用
- disposed：`index.ts:1091` 收集 + `:1092` `invokeContainedSessionObservers(...)`
- event：`index.ts:714` 收集 + `:719` `invokeContainedSessionObservers(...)`
- flush：`index.ts:1114` 收集 + `:1115-1124` `await Promise.allSettled(...)`

交叉验证（编译产物）：`packages/core/session/lib/index.js:1123` 与 `:1429` 与 `:1452` 分别对应 `session/event`、`session/disposed`、`session/flush` 的派发，与 TS 源一致。

### 3.3 Agent 侧事件（`packages/core/agent/src/runtime-types.ts:246` `interface Events`）

```ts
// runtime-types.ts:258
'agent/created'(this: Scoped<Agent>, payload: { agent: Agent }): void
// runtime-types.ts:267
'agent/disposed'(this: Scoped<Agent>, payload: { agent: Agent }): void
// runtime-types.ts:277
'agent/status'(this: Scoped<Agent>, payload: { agent: Agent; status: AgentStatus }): void
// runtime-types.ts:285
'agent/inbox/inserted'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }): void
// runtime-types.ts:296
'agent/inbox/claimed'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage; turn: number }): void
// runtime-types.ts:304
'agent/inbox/discarded'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage }): void
// runtime-types.ts:316
'agent/session-start'(this: Scoped<Agent>, payload: { agent: Agent; source: SessionStartSource }): void
// runtime-types.ts:330
'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
// runtime-types.ts:343
'agent/request'(... ): Promise<LlmCallConfig>
// runtime-types.ts:359
'agent/request-error'(... ): Promise<RequestErrorAction>
// runtime-types.ts:369
'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent; frame: AssistantStreamFrame }): void
// runtime-types.ts:387
'agent/turn-stopping'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; signal: AbortSignal }): Promise<void> | void
// runtime-types.ts:399
'agent/error'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; error: unknown }): void
```

`SessionStartSource`（`runtime-types.ts:125`）：`'startup' | 'resume' | 'clear' | 'compact'`。
**但**：全仓只有两处真正 emit —— `packages/core/agent-loop/src/index.ts:710` `publish('startup')` 与 `:912` `'resume'`。
`'clear'` 与 `'compact'` **没有任何生产者**（grep `source: 'clear'` / `source: 'compact'` 零命中）。
**所以 `SessionStartSource` 在运行时实际只有两个取值**【源码确认】。

`AgentStatus`（`runtime-types.ts:109`）= `'idle' | 'running'`；派发在 `packages/core/agent-loop/src/agent.ts:120`：

```ts
// agent.ts:115
private setPhase(next: Phase): void {
  const previousStatus = this.status
  this.phase = next
  const status = this.status
  if (status !== previousStatus) {
    this.dispatch.emit('agent/status', { status })   // ← 唯一派发点
  }
}
```

### 3.4 结论：可提取窗口怎么界定

**推荐做法（turn 级窗口）**：
1. 订阅 `session/event`，观察 `turn/end`（`packages/core/session/src/types.ts:282`，payload `{ turn: number; reason: TurnEndReason }`）。
   turn/end 由 `packages/core/agent-loop/src/agent.ts:330` 在 `finally` 里 **必然** append —— 无论 complete/abort/error/max-tokens。
2. 用 `TurnEndReasonMap`（`types.ts:198-219`）过滤：只提取 `kind === 'completed'`；`aborted`/`blocked`/`error`/`max-tokens`/`interrupted` 单独处理或不提取。
3. 窗口边界：`turn/start.seq`（含）到 `turn/end.seq`（含）。turn 编号在 `turn/start.data.turn` / `turn/end.data.turn`。
4. 想要「整段对话都结束」：**没有该信号**。只能自建启发式（如 N 分钟无 `turn/end`，或 `agent/status: 'idle'` 持续 T 秒）。必须自己实现并向用户明确这是猜测。

**最佳观测面**：`agent/turn-stopping`（`runtime-types.ts:387`，`@mode serial`，被 await，在 `agent.ts:307` 派发）。它在 `turn/end` 之前，且可以 await，适合做「收尾」。但它是 `agent` 域，插件需在 agent 作用域内注册，或监听 `session/event` 的 `turn/end`。

---

## 4. Q4 同步性：handler 返回值是否被 await？抛错/很慢会怎样

### 4.1 `session/event` —— **fire-and-forget，绝不 await，异常被吞**

```ts
// packages/core/session/src/index.ts:378
function invokeContainedSessionObservers(
  ctx: Context,
  name: 'session/event' | 'session/disposed',
  id: SessionId,
  args: unknown[],
  callbacks: SessionCallback[],
): void {
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`session "${id}": ${name} listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`session "${id}": ${name} listener threw: ${String(error)}`)
    }
  }
}
```

调用点在 `append()` 内部 `index.ts:719`，且 `entry.appending` 标记包裹（`:709` / `:724`）：

```ts
// index.ts:713
if (entry !== undefined) {
  callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...callbackArgs])
}
this.log.push(event as SessionEvent)
this.eventsSnapshot = undefined
if (callbacks !== undefined && entry !== undefined) {
  invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
}
```

推论（**【源码确认】**）：
- 写日志**不等待**任何 listener。
- listener 抛 sync error → 被 catch + `logger.warn`，`append()` 正常返回，提交不受影响。
- listener 返回 rejected promise → `void ... .catch(...)`，只有一条 warn。
- listener 很慢 → **完全不影响** `append()` 的返回时间（同步返回，async 部分在微任务里继续）。
- **`append()` 的 `event` 对象已经在 `log` 里**，listener 读到的是最终提交值。

### 4.2 `session/flush` —— **await allSettled，第一个失败被抛出**

```ts
// packages/core/session/src/index.ts:1111
async flush(session: Session): Promise<boolean> {
  const { carrier } = this.liveEntryFor(session)
  const callbackArgs: unknown[] = [session]
  const callbacks = collectSessionCallbacks(this.ctx, [carrier, 'session/flush', session])
  const results = await Promise.allSettled(callbacks.map((callback) => {
    try {
      return callback(...callbackArgs)
    } catch (error: unknown) {
      return Promise.reject(error)
    }
  }))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure !== undefined) throw failure.reason
  return callbacks.length > 0
}
```

- **所有** listener 都会跑完（allSettled），然后抛**第一个** rejection reason。
- 返回 `boolean` = 是否至少有一个 listener 参与。
- 注意：`flush()` 只对 **live** 会话可用；非 live 抛 `session "<id>" is not live in this store`（`index.ts:1130-1137` `liveEntryFor`）。

### 4.3 `session/created` —— **同步 throw 会否决创建并回滚**；async reject 只记日志

```ts
// packages/core/session/src/index.ts:1068
try {
  const callbacks = collectSessionCallbacks(this.ctx, [entry.carrier, 'session/created', session])
  for (const callback of callbacks) {
    const returned: unknown = callback(...callbackArgs)
    void Promise.resolve(returned).catch((error: unknown) => {
      this.ctx.logger.warn(`session "${entry.id}": session/created listener rejected: ${String(error)}`)
    })
  }
} finally { ... }
```

`create()` 用 `ctx.effect` 把 `enter` 的 disposer 先 yield 出去，所以同步 throw 会让 attach 回滚（`index.ts:910-913` 注释）。

### 4.4 Agent 侧：`agentEvents` 是**包装过的**，与裸 Cordis 行为不同

```ts
// packages/core/agent/src/dispatch.ts:120
emit(name, payload) {
  const args: unknown[] = [carrier, name, fused(payload)]
  const callbacks = ctx.events.dispatch('emit', args)
  for (const callback of callbacks) {
    try {
      const returned: unknown = callback(...args)
      void Promise.resolve(returned).catch((error: unknown) => {
        ctx.logger.warn(`agent event "${name}" listener rejected: ${String(error)}`)
      })
    } catch (error: unknown) {
      ctx.logger.warn(`agent event "${name}" listener threw: ${String(error)}`)
    }
  }
},
// dispatch.ts:138
async serial(name, payload) {
  const serial = ctx.serial as (thisArg: Scoped<Agent>, name: string, ...args: unknown[]) => Promise<never>
  return await serial(carrier, name, fused(payload))
},
// dispatch.ts:143
waterfall(name, payload, ...rest) {
  const waterfall = ctx.waterfall as (thisArg: Scoped<Agent>, name: string, ...args: unknown[]) => never
  return waterfall(carrier, name, fused(payload), ...rest)
}
```

### 4.5 裸 Cordis 语义（对照，`vendor/cordis/src/events.ts`）

```ts
// vendor/cordis/src/events.ts:183  parallel — 等全部 settle，有失败抛 AggregateError
async parallel(...args: any[]) {
  const results = await Promise.allSettled(this.dispatch('emit', args).map(async cb => cb(...args)))
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (errors.length) throw new AggregateError(errors.map(error => error.reason))
}
// :194  emit — 不 await，且 Array.map 会让一个同步 throw 饿死后续 listener
emit(...args: any[]) {
  this.dispatch('emit', args).map(cb => cb(...args))
}
// :204  serial — 按序 await，遇到 bail 值停
// :217  bail  — 同步按序，遇到 bail 值停
// :234  waterfall — 组合 next 链；不调 next() 即否决
```

【源码确认】`isBailed`（`events.ts:13`）：返回 `null`/`false`/`undefined` 之外的值即「bail」。

**【重要】** 会话域与 agent 域**都刻意绕开了裸 `emit`**（因为它会因一个同步 throw 饿死后续 listener）。所以：**任何插件都能观察到事件，但没有任何插件能阻塞或否决 `session/event` 的派发。**

### 4.6 慢 handler 的实际后果

- `session/event` 慢 → 无影响（不 await）。
- `session/flush` 慢 → **直接拖慢**每一个 durable 边界：`session-checkpoint-policy` 在每次模型请求前 `await ctx.sessions.flush(session)`（`packages/session/session-checkpoint-policy/src/index.ts:79-82`），在每次顶层工具派发前也 flush（`:70-75`）。
- `agent/pre-step`、`agent/turn-stopping` 慢 → **插入主执行路径**（前者 `await` 在 `agent.ts:245`，后者 `await` 在 `agent.ts:307`）。

**给记忆插件的建议**：不要在 `session/event` 里做重活（虽然不阻塞，但会与后续事件乱序并发）；需要顺序与背压就用 `session/flush`，但要意识到那会拖慢模型请求。

---

## 5. Q5 会话完成后能否读取完整历史？边界（压缩/裁剪/spill）

### 5.1 能拿到两种视图，语义完全不同

| 视图 | API | 内容 |
|---|---|---|
| **原始事件日志**（真相） | `session.snapshotEvents()` / `sessionQuery.readSession()` / `handle.read()` | **全量**，包含被压缩/裁剪/替换掉的旧节点 |
| **当前 surface**（模型看到的） | `session.deriveMessages()` / `sessionQuery.readSurface()` | 压缩替换后的版本，被 shadow 的节点不在其中 |

`sessionQuery.readSurface` 明确返回 `SurfaceEvent[]`（`types.ts:37-46`），只含 `surface.nodes`。
`readSession` 返回 `SessionEvent[]`（`types.ts:49-56`），全量。

【源码确认】这点很关键：**原始证据没有被销毁**，压缩只是追加一个 `surfaceOp: {op:'replace'}` 的替换节点 + `sourceEventSeqs` 引用被替换者。

### 5.2 压缩（compaction）

Service seam：`packages/compaction/compaction/src/index.ts:96` `abstract class CompactionEngine extends Service`（`super(ctx,'compaction')` `:98`）。
真实方法：
- `abstract compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>` `:113`
- `abstract compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>` `:139`
- `abstract compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>` `:164`

`CompactionTrigger` `:25` = `'pressure' | 'context-overflow'`。

**什么时候发生**（`packages/compaction/compaction-basic/src/index.ts:104` `class BasicCompactionEngine`，`static inject = ['llm','tokenMeter','sessions']` `:105`，`auto` 默认 true，`config.ts:95` `auto: config.auto ?? true`）：
1. 每个 `agent/pre-step` 前按压力判断（`compaction-basic/src/index.ts:148-166`）。
2. `agent/request-error` 里遇到 `CONTEXT_WINDOW_EXCEEDED_CODE` 时强制压缩并 `{ kind: 'retry' }`（`index.ts:180-224`）。
3. 手动 `/compact`（`compaction/command-compact`，被 bundle 挂载，`cordis.patch.yml:325`）。
4. 阈值：`Math.floor(contextWindow * policy.thresholdRatio)`（`config.ts:144`）。

**落盘证据**（`packages/compaction/compaction/src/types.ts:17-90`，`declare module '@deepseek-ai/dsh-session/types'`）：
- `compaction/start` `{ compactionId; sourceCommandId?; turn: number | null }` `:24`
- `compaction/summary` `{ compactionId; summary: ContentBlock[]; shadowedRange; shadowedSeqs: SessionSeq[]; shadowedTokenCount; provider; model; maxTokens?; usage?; rawOutput: ContentBlock[]; llmStreamCall: true }` `:34-67`
- `compaction/end` `{ compactionId; turn: number | null; error?: string }` `:72`

替换动作在 `compaction-basic/src/region.ts:472`：

```ts
session.append('user/message', checkpointMessage, {
  surfaceOp: { op: 'replace', start, end },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
})
```

替换消息的 source 标记（`packages/compaction/compaction/src/checkpoint.ts:19`）：

```ts
const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'plugin', plugin: 'compact' } as const)
// checkpoint.ts:49
export function isCompactCheckpointSource(source: MessageSource): boolean {
  return source.kind === 'plugin' && source.plugin === COMPACT_CHECKPOINT_MARKER.plugin
}
```

**所以：**
- ✅ 原始消息仍在日志里（`shadowedSeqs` 精确列出被替换的 seq）。
- ✅ 摘要节点可被 `isCompactCheckpointSource` 精确识别并排除。
- ⚠️ 但 `deriveMessages()` / `readSurface()` **看不到**原消息。要 L0 级原文必须用 `snapshotEvents()` / `readSession()`。

### 5.3 工具结果裁剪（prune，model-free）

`packages/compaction/compaction-tool-result-pruner/src/index.ts:136` `pruneSession(session: Session): PruneResult`。
同样用 replace：

```ts
// index.ts:162
session.append('compaction/prune', {
  shadowedRange: { start: seq, end: seq },
  shadowedSeqs: [seq],
  shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
})
// index.ts:167
const replacement = session.append('tool/result', { ...event.data, message }, {
  surfaceOp: { op: 'replace', start: seq, end: seq },
  sourceEventSeqs: [seq],
})
```

配置（bundle 默认）`cordis.patch.yml:394-399`：`thresholdChars: 8192, headChars: 4096, tailChars: 1024`。
触发：`compaction-basic` 在 `compactIfNeeded` 里先 prune 再摘要（`compaction-basic/src/index.ts:286` / `:310`）。

同样：**原文仍在日志**。

### 5.4 Spill（落盘到外部文件，**这条会丢原文**）

`packages/spill/spill-policy/src/index.ts:185` 注册 `tools/post-execute`：

```ts
// spill-policy/src/index.ts:191
if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')
  || exec.parent !== undefined || exec.name === 'read') return decision
const content = decision.content ?? result.content
const text = flattenPlainText(content)
if (text === undefined) return decision
const totalBytes = Buffer.byteLength(text, 'utf8')
if (totalBytes <= maxInlineBytes) return decision
const replacedText = await spillReplacement(text, totalBytes, ownerSessionId(exec), exec.name, exec.callId, 'result')
```

**关键顺序**：spill 发生在 `tools/post-execute`，即**在 `tool/result` 事件被 append 之前**（append 在 `packages/core/agent-loop/src/tool-calls.ts:282`）。所以：

> ⚠️ **【源码确认】超过 `maxInlineBytes` 的纯文本工具结果，日志里只有「预览 + locator」，原文不在会话日志里。**

bundle 默认 `maxInlineBytes: 50000`（`cordis.patch.yml:383-386`），backend `spill-local`（`:380`）。
原文落在 `LocalSpillStore`（`packages/spill/spill-local/src/index.ts:149` `saveText`），根目录默认是 OS temp 下的私有 0700 目录（`src/index.ts:88` `privateRoot()`），**并且有 30 天清理**（`src/index.ts:68` `cleanupPeriodDays: 30`）。

`SpillSource`（`packages/spill/spill/src/types.ts:46-60`）记录 `{ kind:'tool', toolName, callId, label }`，所以能从日志里的 locator 反查到文件，**但文件可能已被清理**。

`tool/code-dispatch` 事件另有一条同样的 cap（`spill-policy/src/index.ts:212-226`）。

### 5.5 其它会改写「读到的历史」的因素

1. **`assistant/message` 内嵌 stream**：每条 assistant 消息带 `stream: AssistantStreamRecord[]`（`types.ts:310`）。完整但体积大。
2. **崩溃修复合成事件**：`interruptedTurnClosers`（`packages/core/session/src/repair.ts:29`）会合成 `tool/result` / `step/end` / `turn/end`（`reason: {kind:'interrupted'}`，`repair.ts:133`）。这些是**内存合成**，不会写回磁盘（`cold-read.ts:16` 注释 + `:55`）。**读到它们时必须知道这不是真实发生过的工具结果**；`tool/result.error.code` 会是 `TOOL_OUTCOME_UNKNOWN`（`repair.ts:120`）或 `TOOL_NOT_STARTED`（`:121`）。
3. **fork 继承前缀**：`inheritedEventCount`（`packages/core/session/src/index.ts:443`）区分父会话继承 vs 本会话自有；`session/end-seed`（`types.ts:381`）是它的持久投影。**提取记忆时必须只看 `ownEvents()` / `isOwnSeq()`，否则会把父会话内容重复提取。**
4. **`request/header` 里带完整 system prompt + tools**（`types.ts:229` `EpochHeader`）—— 数据量大，且是「发给模型的东西」而非对话内容。

### 5.6 可信度判定（给 L0 用）

| 数据类别 | 在原始日志中完整？ | 备注 |
|---|---|---|
| 人类 `user/message` 文本 | ✅ 完整 | 无裁剪路径 |
| `assistant/message` 文本/推理/工具调用 | ✅ 完整（含 stream） | |
| `tool/result` 小结果（≤50KB 纯文本） | ✅ 完整 | |
| `tool/result` 大结果 | ❌ **只有预览 + locator** | 外置文件可能 30 天后被清 |
| 被压缩/裁剪的旧节点 | ✅ 原文保留（被 shadow） | 需读原始事件，不能读 surface |
| 崩溃合成的 closer | ⚠️ 合成，未落盘 | 需按 `error.code` / `reason.kind` 过滤 |

---

## 6. Q6 如何区分 user / assistant / tool / 插件注入（role + source + metadata）

### 6.1 唯一权威字段：`Message.source`

```ts
// packages/llm/llm/src/message.ts:102
export interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource
  tool: ToolMessageSource
}
// message.ts:128
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]
// message.ts:131
export interface Message {
  readonly id: MessageId
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}
```

具体子类型：
```ts
// message.ts:24
export interface ModelMessageSource extends AssistantProvenance { kind: 'model' }
// message.ts:29
export interface ToolMessageSource { kind: 'tool'; callId: ToolCallId }
// message.ts:143
export interface UserMessage extends Message { readonly role: 'user' }
// message.ts:148
export interface AssistantMessage extends Message { readonly role: 'assistant'; readonly source: ModelMessageSource }
// message.ts:154
export interface ToolResultMessage extends Message {
  readonly role: 'user'                      // ← 注意：tool 结果 role 是 'user'
  readonly content: [ToolResultBlock]
  readonly source: ToolMessageSource
}
```

### 6.2 事件类型 → role → source 组合表【源码确认】

| 事件 | `message.role` | `message.source.kind` | 说明 |
|---|---|---|---|
| `user/message` | `'user'` | 多种（见下） | 人类提示 / 注入上下文 / goal 续轮 |
| `assistant/message` | `'assistant'` | 必为 `'model'` | 校验在 `session/src/index.ts:340` |
| `tool/result` | `'user'` | 必为 `'tool'` + `callId` | 校验在 `index.ts:346-350` |

运行时强制（`packages/core/session/src/index.ts:310` `assertMessageEventShape`）：
```ts
// index.ts:325
const expectedRole = type === 'assistant/message' ? 'assistant' : 'user'
// index.ts:339
if (type === 'assistant/message') {
  if (sourceRecord['kind'] !== 'model' || !hasProviderModel(sourceRecord)) { throw ... }
}
// index.ts:346
if (sourceRecord['kind'] !== 'tool' || typeof sourceRecord['callId'] !== 'string' || sourceRecord['callId'] === '') { throw ... }
```

⚠️ **`role` 不能用来区分「人类」和「工具结果」**——两者都是 `'user'`。必须用 `source.kind`。

### 6.3 `plugin` 源的 `form` 轴（语义分类）

```ts
// packages/llm/llm/src/message.ts:50
export type ContextForm =
  | 'instructions'   // 工作区文件里的指令
  | 'catalog'        // 可用项目清单（会随变化重发）
  | 'snapshot'       // 当前状态快照，后发覆盖前发
  | 'notice'         // 一次性事件通知
  | 'relay'          // 另一个 agent 发来的消息
  | 'recall'         // 从别的会话日志里捞出来的材料
// message.ts:81
export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | { readonly form: 'snapshot'; readonly sections: readonly ContextSnapshotSection[] }
  | { readonly form: 'notice'; readonly summary: string }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }
```

`ContextForm` 的注释（`message.ts:36-48`）明确：「`MessageSource.kind` 回答**谁产出的**；`form` 回答**这是什么种类的东西**，两轴刻意独立」。

### 6.4 全部真实 source.kind 值（含 declaration merge）

| `kind` | 定义位置 | 语义 | 是「人类输入」？ |
|---|---|---|---|
| `'user'` | `llm/src/message.ts:103` | 用户渠道 | **通常**，但不保证（见 6.5） |
| `'plugin'` | `llm/src/message.ts:104` | 插件注入，带 `plugin` 名 + `form` | ❌ |
| `'model'` | `llm/src/message.ts:105` | 模型产出 | ❌ |
| `'tool'` | `llm/src/message.ts:106` | 工具结果 | ❌ |
| `'user-rpc'`（kind 仍是 `'user'`） | `packages/api/session-controller/src/types.ts:371` | Web 浏览器 prompt，带 `rpcId` 和可选 `clientTimeZone` | ✅ **最强** |
| `'goal'` | `packages/goal/goal/src/domain.ts:47-53` `{kind:'goal', goalId, revision, round}` | goal 续轮注入 | ❌ |
| `'webhook'` | `packages/webhook/webhook/src/types.ts:72` | 外部 webhook | ❌ |
| `'session-reference'` | `packages/context/session-reference/src/types.ts:35` | 跨会话引用 | ❌ |
| `'agent-instructions'` | `packages/context/agent-instructions/src/state.ts:49` | AGENTS.md 等 | ❌ |
| `'skill-catalog'` | `packages/skill/tool-skill/src/index.ts:44` | 技能目录 | ❌ |
| `'skill-invocation'` | `packages/skill/skill/src/index.ts:157` | 用户显式调用技能 | ⚠️ 用户触发但内容是技能正文 |
| `'team-message'` | `packages/experimental/agent-team/src/types.ts:124` | 团队成员消息 | ❌ |
| `'agent-message'` / `'subagent-settled'` | `packages/subagent/subagent/src/continuation-messages.ts:41` | 相邻 agent / 子代理结算 | ❌ |

### 6.5 ⚠️ `source.kind === 'user'` **不是**「人类亲自输入」的证明

**这是本报告最重要的警告。** 多处非人类路径用 `{ kind: 'user' }`：

- `/goal` 附件消息：`packages/goal/command-goal/src/index.ts:120` `source: { kind: 'user' }`
- `/plan` 模式 steer：`packages/plan/plan-mode/src/index.ts:258`
- headless 一次性任务：`packages/bundle/headless/src/index.ts:199`
- ACP 会话：`packages/acp/acp/src/session.ts:296`
- 测试夹具大量使用

唯一的**强判别**：`source` 里带 `rpcId`（原型是 `'user-rpc'`）。生产者只有一处：

```ts
// packages/api/session-controller/src/commands.ts:315
const source: MessageSource = {
  kind: 'user',
  rpcId: request.requestId,
  ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
}
```

`SessionRequestId` 定义 `packages/api/session-controller/src/types.ts:366`：「Client-minted prompt identity used to reconcile optimistic and durable messages」。

**【源码确认】** 判别式应该是：
```ts
const isHumanPrompt = (m: UserMessage) =>
  m.source.kind === 'user' && 'rpcId' in m.source && typeof m.source.rpcId === 'string'
```
但这只覆盖 Web UI 来源。**CLI 交互式输入是否会带 `rpcId`？【尚待实验验证】** 需要实验：在 CLI 交互模式下输入 prompt，导出会话日志，检查 `user/message.data.source` 是否含 `rpcId`。
若 CLI 不带，则「CLI 人类输入」与「CLI headless 任务文本」在 source 上**完全同形**，无法区分 —— 这是一个真实缺口。

### 6.6 id / turn / agent 归属标记

| 标记 | 存在？ | 证据 |
|---|---|---|
| **message id** | ✅ 每条消息都有 | `message.ts:133` `readonly id: MessageId`；`createMessage` 用 `randomUUID()` 生成（`message.ts:180-187`）；持久化校验强制非空（`session/src/index.ts:320-322`） |
| **event seq** | ✅ | `types.ts:457` |
| **event time**（epoch ms） | ✅ | `types.ts:459` |
| **turn 号** | ⚠️ **部分事件有** | `assistant/message`/`assistant/attempt`/`tool/call`/`tool/result` 都有 `{turn, step}`；**`user/message` 没有**（`types.ts:294` → `data` 就是 `UserMessage` 本身） |
| **agent id** | ✅ 但等于 session id | `packages/core/agent/src/index.ts:470`：`if (id !== agent.session.id) throw new Error(...)` —— 统一化设计（见 `.agents/notes/implemented/simplification/2026-06-20-unify-agent-and-session-id.md`） |
| **session id** | ✅ | `SessionHeader.id`；`Session.id` getter（`session/src/index.ts:446`） |
| **plugin id** | ✅ 仅 `kind:'plugin'` | `source.plugin: string` |
| **tool call id** | ✅ 仅 `kind:'tool'` | `source.callId` |

**`user/message` 缺 turn 号的处理办法**：折叠 `turn/start`(seq_a) … `turn/end`(seq_b) 区间，`a < user/message.seq < b` 即属该 turn。这是唯一可靠方式，因为在 `agent.ts:266/294/330` 里 `turn/start` 一定先于 `user/message`，`turn/end` 一定在 finally 里追加。

---

## 7. Q7 如何避免把插件自己注入的记忆内容再当新证据（source/kind 标记）

**有可用标记，但需要插件自己遵守约定。**

### 7.1 机制：`source.kind === 'plugin'` + `source.plugin === '<你的包名>'`

真实先例（源码里已有的自识别模式）：

```ts
// packages/core/agent-loop/src/runtime-context.ts:12
const SOURCE = '@deepseek-ai/dsh-system-prompt'
// :15
function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}
```

同一个模式还出现在：
- `packages/guard/repeat-tool-reminder/src/index.ts:57` `const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'repeat-tool-reminder' }`
- `packages/hooks/hooks-claude-code/src/index.ts:86`、`packages/hooks/hooks-codex/src/index.ts:71`
- `packages/compaction/compaction/src/checkpoint.ts:19` + `:49` `isCompactCheckpointSource`
- `packages/session/session-title/src/index.ts:132` `sessionTitleUserMessageOf` 用 `event.data.source.kind !== 'user'` **排除**所有注入

### 7.2 注入 API（`Agent` 接口）

```ts
// packages/core/agent/src/runtime-types.ts:215
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
// :222
followup(message: UserMessage): void
// :231
steer(message: UserMessage): void
// :241
inject(message: UserMessage): void
```

`inject` 的实现（`packages/core/agent-loop/src/agent.ts:141`）：
```ts
inject(input: UserMessage): void {
  this.send(input, 'next-step', false)   // 不唤醒 driver
}
```

`inject` 的语义（`runtime-types.ts:234-241` 注释）：「Queue model-facing context for the next pre-step **without waking the driver**」—— 所以注入不会自己产生 turn。

### 7.3 结论与建议

✅ **可行方案**：
```ts
// 注入时
agent.inject(createUserMessage({
  content: [{ type: 'text', text: rendered }],
  source: { kind: 'plugin', plugin: '@your-scope/memory', form: 'recall' /* 或 'snapshot' */ },
}))

// 提取时排除
const isOurInjection = (m: UserMessage) =>
  m.source.kind === 'plugin' && m.source.plugin === '@your-scope/memory'
```

⚠️ **陷阱**：
1. `plugin` 字段是**自由字符串**，没有命名空间强制校验（`session/src/index.ts:329-334` 只校验 `kind` 是非空 string）。所以「谁的 plugin 名」纯靠约定，插件之间可能撞名。
2. **必须同时排除 `kind:'plugin'` 的其它插件注入**，否则会把 `AGENTS.md` 内容、技能目录、goal 轮次、压缩摘要全部当人类证据。至少要有一个白名单：只有 `kind==='user'` 且（可选）有 `rpcId` 的才算证据。
3. `form: 'recall'` 是 `ContextForm`（`message.ts:62`）里为「从别的会话捞出来的材料」预留的语义值，语义上最贴合记忆注入。
4. 压缩摘要的 source 是 `{ kind:'plugin', plugin:'compact' }` —— 用 `isCompactCheckpointSource`（`compaction/src/checkpoint.ts:49`）识别，不要当成用户说的。
5. `snapshot` form 的**后发覆盖前发**语义（`message.ts:56`）意味着旧注入仍在日志里；如果只按「最新快照」语义理解历史会错。`RuntimeContextProjection`（`runtime-context.ts:25`）示范了正确的「只认最新 retained」逻辑。

---

## 8. Q8 会话记录是否含可信 userId？还是需部署环境显式配置 owner

### 8.1 结论：**会话日志里没有 userId，也没有 owner 字段**

`SessionHeader`（`packages/core/session/src/types.ts:91-128`）全部字段：`version, id, createdAt, cwd, parentSession, isSeeded, origin, delegationDepth, agentPreset`。
**没有任何 user / owner / tenant 字段。**

`SessionFormatHeader`（`packages/session/session-format/src/types.ts:16-26`）同样没有，且它是 durable 格式的权威定义。
`SessionWireHeader`（`packages/api/session-controller/src/types.ts:392-403`）也没有。

### 8.2 存在一个「匿名用户 id」，但它不是会话归属

```ts
// packages/identity/anonymous-user-id/src/index.ts:25
export type AnonymousUserId = Branded<'AnonymousUserId'>
// :29
export const ANONYMOUS_USER_ID_FILE_NAME = '.anonymous-user-id'
// :68
export function getOrCreateAnonymousUserId(options: AnonymousUserIdOptions = {}): AnonymousUserId
```

文档注释（`index.ts:2-16`）明确其性质：
> 「Per-harness-home anonymous user id shared by **telemetry and feedback**. The id is a random UUID persisted as a bare line in `.anonymous-user-id` inside the harness home ... It is scoped to the harness home, **not the machine**: every process sharing one `$DSH_HOME` reports the same id」

用途仅两处：
1. telemetry Resource 的 `user.id`：`packages/session/session-telemetry-otel/src/index.ts:211` `'user.id': getOrCreateAnonymousUserId()`
2. DeepSeek 模型请求头：`packages/llm/llm-deepseek/src/adapter.ts:536` `'x-deepseek-harness-user-id': String(userId)`

**它不写进会话日志**，因此**不能**用作会话的 owner 标记。【源码确认】grep `userId` 全仓只有 16 处命中，全部在 telemetry / llm adapter / 测试里，session 包里零命中。

### 8.3 Web 端有「认证」，但那是**主机级**的，不是用户身份

`packages/client/connection/src/browser-auth.ts`：
- cookie 名由 authority 哈希得出（`:106` `cookieName(authority)`）
- payload 携带 `authority`（`:29`），验证时比对（`:296` `payload.authority !== authority`）
- 整个机制是「本机浏览器是否被允许访问本机 Host」，`docs` 侧记录在 `.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md`：launch token → cookie，「There is **no logout operation**」。

→ 这是**单用户本机模型**的认证，不是多用户身份。同一 `$DSH_HOME` 下所有会话属于同一个「操作者」。

### 8.4 唯一接近「归属」的东西：workspace 的 session 归属

```ts
// packages/workspace/workspace/src/spec.ts:22
export const workspaceRecord = z.object({
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(z.string().transform(value => brandString<SessionId>(value))),
  createdAt: z.string(),
  updatedAt: z.string(),
})
```
这是「哪个 workspace 拥有哪些 session」，**不是**「哪个 user 拥有」。

### 8.5 对记忆系统的结论

**【源码确认】** 没有可信 userId。必须：
- **方案 A（推荐）**：把 owner 当作**部署配置**（profile 级），不要从会话推导。理由：`$DSH_HOME` 本身就是唯一隔离单元（`packages/util/home-paths/src/index.ts:87`），一个 home = 一个 owner 是当前架构唯一成立的假设。
- **方案 B**：从 `ctx.get('anonymousUserId')` 取 —— **但这个 service 根本不存在**（`getOrCreateAnonymousUserId` 是纯函数，没有注册成 Cordis service，grep `'anonymousUserId'` 作为 service 名零命中）。所以只能直接 import 调用，且它只在 telemetry 链路上有意义。
- **方案 C**：自建 owner 配置项（bundle config / settings），并由用户显式填写。若要跨机器/跨 home 共享记忆，这是唯一可行路径。

**明确写出不可用**：会话日志无法回答「这是谁说的」。多用户共享一个 DSH 实例时，会话之间无法在数据层区分归属。

---

## 9. Q9 插件重启后如何识别上次未完成的提取任务并安全恢复

### 9.1 有真实先例：**把游标写进会话日志本身**

`packages/session/session-log-deepseek/src/index.ts` 是一个完整的「durable outbox cursor」范例：

```ts
// session-log-deepseek/src/types.ts:59
'session-log-deepseek/delivery-accepted': { ... }
// index.ts:95
export function acceptedThrough(session: Session): SessionSeqCursor {
  const previous = acceptanceFolds.get(session)
  let throughSeq = previous?.throughSeq ?? -1
  const length = session.seq
  const start = previous?.scannedEvents ?? SessionLogOffset(0)
  for (let index = start; index < length; index++) {
    const event = session.eventAt(SessionSeq(index))
    ...
    if (event.type !== 'session-log-deepseek/delivery-accepted') continue
    ...
    if (acceptedSeq > throughSeq) throughSeq = acceptedSeq
  }
  acceptanceFolds.set(session, { scannedEvents: length, throughSeq })
  return throughSeq
}
```

提交点（`index.ts:159-167`）：
```ts
accept: () => {
  session.append('session-log-deepseek/delivery-accepted', {
    sessionId: session.id,
    sessionFormatVersion: session.header.version,
    throughSeq,
  })
  // TODO: Add an immediate lightweight checkpoint if duplicate replay after a 2xx crash window becomes unacceptable.
},
```

设计要点（`index.ts:2-5` 模块注释）：「Accepted sequence watermarks live in **the canonical log**, so restart recovery can conservatively resend uncertain tails **without maintaining another store**.」

### 9.2 第二个先例：projection cache 的 `(ver, seq, val)` checkpoint

`packages/session/session-projection-cache/src/spec.ts:26`：
```ts
export const checkpointRow = z.object({
  ver: z.number().int().nonnegative(),
  seq: z.number().int().gte(-1).transform((value): SessionSeqCursor => value === -1 ? -1 : SessionSeq(value)),
  val: z.json(),
})
```
域定义 `:98`：`name: 'session_projcache'`, `version: 7`, `layout: 'per-record'`, `invalidRecords: 'backup-and-skip'`。
写侧节流 + 强制点（`index.ts:305-339`）：`turn/end` 是强制刷盘点，`session/created` 是首点，`session/disposed` 是末点。

恢复正确性由 `packages/session/session-projection/src/index.ts:495` `restore(...)` 保证：`ver` 不匹配 / `row.seq` 越界 → 丢弃并从头 refold（`:514-519` 抛错要求 re-read from seq 0）。

### 9.3 第三个先例：`session/end-seed` 边界

`packages/core/session/src/types.ts:381` `'session/end-seed': { inherited?: true }`。
文档（`types.ts:363-380`）：「This log-only event is the durable projection of `Session.firstLiveSeq`... An owner of a standalone open/close bracket (`compaction/start` … `compaction/end`) reads it because seed history and live work are otherwise byte-identical」。
→ 这是现成的「上次生命周期结束为止」的持久边界。

### 9.4 对记忆插件的建议（可复制的模式）

你的插件应当自建一条 log-only 事件，例如：
```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'memory/extracted': {
      throughSeq: SessionSeq          // 已提取到哪个 seq
      extractorVersion: number        // 提取器版本，升级后可选择性重跑
      window: { turnStart: number; turnEnd: number }
      writtenIds: string[]            // 已写入的记忆条目标识（幂等）
    }
  }
}
```
要点：
1. **写进入参 log**（`session.append('memory/extracted', {...})`），不要另建存储 —— 与 `session-log-deepseek` 同构。
2. 注意 `KNOWN_SESSION_EVENT_TYPES`（`packages/core/session/src/known-event-types.ts:22`）是**生成产物**，插件事件**不在其中**。落盘后下次读取时会走 `validateStoredEvents`（`packages/session/session-persistence/src/storage-contract.ts:75`）：
   ```ts
   if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
     throw unsupported(`session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`, location)
   }
   ```
   ⚠️ **如果你 append 的事件类型是本 build 不认识的，且没标 `ignorable: true`，那么「卸载插件后」整个会话将无法被读取。** 但如果插件一直挂着（同一进程里 `SessionEventMap` 已 merge），本进程内读没问题。
   **结论：插件事件要么带 `ignorable: true`，要么接受「卸载插件 = 该会话不可读」的代价。** 【源码确认】
3. **不要用 `session/end-seed`**（`types.ts:370-372` 明确说「`Session`'s constructor is the only legitimate writer... a plugin appending one would silently classify every live bracket before it as seed history」）。
4. 若要**跨会话**的 outbox（全局提取队列），走 `ctx.storageDomain`：`packages/storage/storage-domain/src/index.ts:103` `async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>`，配合 `defineDomain`/`domainTable`（`spec.ts:107`/`:91`）。已有两个真实用例：`session_projcache`（`session-projection-cache/src/spec.ts:98`）和 `workspace`（`workspace/src/spec.ts:68`）。bundle 已挂 `storage`/`storage-json`/`storage-domain`（`cordis.patch.yml:145-156`，root `$DSH_HOME/storages`）。
   注意 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`packages/storage/storage/src/backend.ts:10`），所以 domain 名不能有连字符。

### 9.5 一个真实的坑：没有「未完成任务」的持久标记

现有代码里**没有**任何 generic 的「上次提取没做完」标记基础设施。`session-log-deepseek` 的 `delivery-accepted` 是**每会话、只增**的水位；它的 TODO（`index.ts:165`）也承认 2xx 崩溃窗口内会重复投递。
→ 你的恢复逻辑必须自己做到**幂等**（`writtenIds` 或内容哈希去重），而不是假设「+1 次侧效恰好一次」。

---

## 10. Q10 模型调用/会话读取失败/证据不足时如何保证不写入未证实记忆

### 10.1 模型调用：走 `ctx.llm`，接口签名（Q-F 详答）

**Service**：`packages/llm/llm/src/index.ts:330`

```ts
export class LlmRuntime extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'llm') }   // :338-340
```

Context 注入声明 `index.ts:54-56`：`interface Context { llm: LlmRuntime }`。

**核心方法**（真实签名）：

```ts
// index.ts:904
async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall>
// index.ts:1093
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
// index.ts:846
async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
// index.ts:726
async resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
```

`PreparedLlmCall`（`index.ts:162-181`）：
```ts
export interface PreparedLlmCall {
  readonly config: LlmCallConfig
  readonly retryPolicy: ResolvedRetryPolicy
  readonly context?: LlmModelContext
  readonly inputModalities?: readonly ModelModality[]
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

`GenerateOptions`（`packages/llm/llm/src/types.ts:407-443`）真实字段：
```ts
export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'
}
```

**没有 `generate()` / `complete()` / `chat()` 方法** —— 只有 `stream()`。要一次性结果必须自己拼 `BlockAssembler`（`packages/llm/llm/src/assembler.ts:38`），这正是官方做法：
- compaction 摘要：`packages/compaction/compaction-basic/src/summarizer.ts:145-181`
- 会话标题：`packages/session/session-title-llm/src/index.ts:273-296`

**D-A 结论：插件调用模型走 `ctx.llm.stream(options)`，用 `BlockAssembler` 聚合。** 不要用 `ctx.llm` 之外的任何东西；没有更高层封装 service 暴露给插件。

可选：`ctx.llm.prepareCall(config, signal)` 先拿 `retryPolicy` / `contextWindow` / `inputModalities`（`index.ts:904`），再用返回的 `preparedCall.stream(request)`（`index.ts:930`，**只能调一次**，第二次抛 `INVALID_PREPARED_CALL`，`index.ts:931-933`）。

### 10.2 失败语义：`LlmFailure` + `LlmError`，失败被转成终止 chunk

```ts
// packages/llm/llm/src/types.ts:40
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: ProviderRequestId
}
```

**关键机制**：adapter 层失败**不会抛**，而是变成一个终止 `finish` chunk：
```ts
// packages/llm/llm/src/index.ts:1110
function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason: signal?.aborted || failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}
```
`FinishReasonMap`（`types.ts:130-136`）：`'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'`，后两个都带 `failure: LlmFailure`。

→ **你的记忆提取循环必须检查 `assembler.finish.kind`**，否则「模型报错」会被当成「模型什么都没说」。官方模板：
```ts
// packages/session/session-title-llm/src/index.ts:203
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': { const error = new Error(finish.failure.message) as Error & { code?: string }; error.code = finish.failure.code; return error }
    case 'max-tokens': return new Error('session-title-llm: title output reached maxOutputTokens')
    case 'tool-calls': return new Error('session-title-llm: title model unexpectedly requested a tool')
    default: return new Error(`... unsupported finish reason ...`)
  }
}
```
完成后的硬校验（`index.ts:289-290`）：`if (title.length === 0) throw new Error('session-title-llm: title model produced no text')`。

### 10.3 会话读取失败：结构化错误类型

| 错误类 | 位置 | 语义 |
|---|---|---|
| `SessionPersistenceNotFoundError` | `session-persistence/src/errors.ts:13` | 无该持久化会话 |
| `SessionAlreadyExistsError` | `:22` | create 撞 id |
| `SessionAlreadyOwnedError` | `:31` | write 竞争 |
| `SessionReadOnlyError` | `:40` | 读 handle 上做写 |
| `SessionHandleClosedError` | `:68` | 已 close 的 handle |
| `SessionPersistenceCorruptionError` | `:93` | 读到了但校验失败 |
| **`SessionFormatUnsupportedError`** | `:111` | 日志完好但本 build 读不懂（版本更高 / 未知事件类型）。**带 `location?: SessionLocation`**，可指到原始文件 |
| `SessionQueryError`（带 `code`） | `packages/session-query/session-query/src/config.ts:29-46` | 真实 code 全集：`SESSION_QUERY_ABORTED` / `_CORRUPT_SESSION` / `_EVENT_NOT_FOUND` / `_INDEX_FAILED` / `_INVALID_CONFIG` / `_INVALID_CURSOR` / `_INVALID_FILTER` / `_INVALID_LIMIT` / `_INVALID_QUERY` / `_INVALID_LINEAGE` / `_INVALID_SURFACE` / `_INVALID_WINDOW` / `_PERSISTENCE_FAILED` / `_SEARCH_DISABLED` / `_SESSION_NOT_FOUND` / `_STALE_CURSOR` / `_SOURCE_CONFLICT` |

⚠️ **`SESSION_QUERY_SEARCH_DISABLED` 是默认发生的**：bundle 默认
```yaml
# packages/bundle/base/cordis.patch.yml:129
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: ':memory:'
    openAt: never
```
`openAt: never`（`session-query-sqlite/src/index.ts:89` `export type OpenAt = 'startup' | 'first-search' | 'never'`，`:342` 抛 `SESSION_QUERY_SEARCH_DISABLED`）。
→ **FTS 全文搜索默认不可用**；但精确读取（`readSession`/`observeSession`/`listEvents`/`readSurface`）**仍然可用**，因为它们在基类 `SessionQueryEngine` 里，不依赖 SQLite。这是个容易踩的坑。

### 10.4 失败即拒绝写入：现成的「fail-closed」范式

源码里有多处「宁可拒绝也不误读」的范例，应该照抄：

1. **未知事件类型 → 拒绝整个重建**（不是跳过）
   ```ts
   // packages/session/session-persistence/src/storage-contract.ts:75
   if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) { throw unsupported(...) }
   ```
   理由（`known-event-types.ts:12-20` 注释）：「silently skipping a required event would reconstruct a wrong session」。

2. **`append` 前置校验**：非 JSON 序列化直接抛（`session/src/index.ts:688-691`）：
   ```ts
   const dataSnapshot = snapshotJsonValue(data)
   if (dataSnapshot === undefined) throw new Error(`session event "${type}" carries non-JSON-serializable data`)
   ```

3. **压缩摘要必须更小，否则整笔失败**（不是落一个坏摘要）：
   ```ts
   // packages/compaction/compaction-basic/src/region.ts:384
   if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) {
     throw new Error(`summary is not smaller than the shadowed content (... >= ...)`)
   }
   ```
   失败也会写一个带 `error` 的 `compaction/end`（`region.ts:225`），保持日志可诊断。

4. **摘要无文本 → 抛**（`packages/compaction/compaction-basic/src/summarizer.ts:170`）：
   ```ts
   if (!summary.some(block => block.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
   ```

5. **spill 失败绝不把成功工具调用变失败**（反面范例：能不写就不写）
   ```ts
   // packages/spill/spill-policy/src/index.ts:150-156
   try { ref = await spillStore.saveText(save) }
   catch (error: unknown) {
     ctx.logger.warn(`spill-policy: saveText failed for ${toolName}: ${String(error)}; keeping the inline content`)
     return undefined
   }
   ```
   理由（`index.ts:33-35`）：「A spill failure must NEVER turn a successful tool call into an `isError` or hide the inline result.」

6. **title 生成失败只 warn，不影响主流程**（`session-title/src/index.ts:517-520`）。

### 10.5 建议的失败语义（给记忆插件）

| 情形 | 建议行为 | 依据的现成语义 |
|---|---|---|
| LLM `finish.kind === 'error'/'aborted'` | 不写入；记录失败原因；游标**不前进** | `finishError` 模板（`session-title-llm/src/index.ts:203`） |
| LLM `finish.kind === 'max-tokens'` | 不写入（输出被截断） | `compaction-basic/src/summarizer.ts:206-209` |
| 输出校验失败（空/结构不符） | 不写入 | `session-title-llm/src/index.ts:289-290` |
| 会话读取抛 `SessionFormatUnsupportedError` | 不写入；**保留 locator** 让用户自己看原文 | `errors.ts:111` 带 `location` |
| 事件类型未知 | 不写入（不要猜） | `storage-contract.ts:75` 的哲学 |
| 证据不足（<N 条 user/message，或全是 plugin 源） | 不写入，且**不推进游标** | — |
| 写入存储失败 | 不推进游标；**重试幂等** | `session-log-deepseek` 的 watermark 哲学 |

**最重要的不变量**：**游标只在「成功持久化记忆」之后前进**。`session-log-deepseek` 的注释点出了反面：它的 `accept()` 是「2xx 之后」调用（`index.ts:159`），并留下 TODO 承认崩溃窗口会重复投递（`:165`）—— 也就是说，**这个先例选择了「at-least-once + 上游幂等」，而不是 exactly-once**。你要么同样选择 at-least-once 并做强去重，要么接受「游标前进但记忆没落盘」的漏提取。

---

## 11. Session → 证据可读性 生命周期表

时间轴上每一刻，能读到什么、能挂什么钩子：

| 阶段 | 触发/信号（真实代码点） | 会话可读性 | 数据完整性 | 可用钩子 | 能否安全提取 |
|---|---|---|---|---|---|
| **0. 会话创建（prepared，未 announced）** | `SessionStore.prepare` `session/src/index.ts:936` | 内存对象存在，**不在 store**：`ctx.sessions.get()` 返回 `undefined`；`sessionQuery` 也看不到 | header 已有，`log` 可能已有 constructor seed + `session/end-seed` | 无（`session/created` 还没发） | ❌ 不可见 |
| **1. `enter()` 装入 store** | `index.ts:1002` | `ctx.sessions.get(id)` ✅ | 同上 | 无 | ✅ 但可能未 announce |
| **2. `announce()` → `session/created`** | `index.ts:1057`，派发 `:1069` | ✅ live | ✅ | `session/created`（同步 throw 可否决创建） | ✅ |
| **3. `agent/session-start`** | `agent-loop/src/index.ts:674`，`emitAgentEvent(...)` | ✅ | ✅ | `agent/session-start`（`source` 只有 `'startup'`/`'resume'`） | ✅ |
| **4. constructor seed 写入磁盘** | `appendUnstoredSuffix` `agent-loop/src/index.ts:748`；`publish` 前调用 | ✅ | ✅ 已落盘（`handle.append`） | — | ✅ |
| **5. turn 开始** | `agent.ts:266` `session.append('turn/start', {turn})` | ✅ | — | `session/event`(type=`turn/start`)、`turnBoundary` projection（`agent-loop/src/index.ts:56`） | — |
| **6. 用户消息入 inbox** | `agent.followup/steer/inject` `agent.ts:124-143` → `inbox.splice` | ✅ 但**尚未进 session log** | ⚠️ 只在 `inbox` projection 里（`agent-loop/src/inbox.ts:65`），未 append | `agent/inbox/inserted` `inbox.ts:243` | ❌ 未落盘，不可当证据 |
| **7. pre-step 认领** | `inbox.claim` `inbox.ts:111` + `agent/pre-step` waterfall `agent.ts:245` | ✅ | 仍只在内存 | `agent/inbox/claimed` `inbox.ts:114`、`agent/pre-step`（可 reject/改写） | ❌ 仍可能被拒 |
| **8. **持久化屏障**** | `session-checkpoint-policy` `session-checkpoint-policy/src/index.ts:79-82` `await ctx.sessions.flush(...)` | ✅ | ✅ **此刻之前的事件已 durable** | `session/flush`（await，parallel） | ✅ 安全落盘点 |
| **9. `step/start` → `user/message` 落盘** | `agent.ts:290` + `:294` | ✅ | ✅ 用户消息**现在才进日志** | `session/event`(type=`user/message`) | ✅ 第一个可提取点 |
| **10. 模型流式** | `ctx.llm.stream` `llm/src/index.ts:1093`；帧经 `agent/assistant-stream` `agent.ts:369` | ✅ | 仅内存帧 | `agent/assistant-stream`（fire-and-forget，**进程本地，不落盘**，见 `runtime-types.ts:361-363`） | ❌ 不可当证据 |
| **11. `assistant/message` 落盘** | `agent.ts:457-466`（正常）、`:388-402`（中断） | ✅ | ✅ 含完整 `stream` | `session/event` | ✅ |
| **12. 工具调用** | `tool/call` `tool-calls.ts:264` → 派发 → `tool/result` `tool-calls.ts:282` | ✅ | ⚠️ 大结果可能已被 spill 成预览（Q5.4） | `tools/execute` / `tools/post-execute` / `tools/result` | ⚠️ 需检查是否被 spill |
| **13. `step/end`** | `agent.ts:303`（在 `finally` 里，必发） | ✅ | ✅ | `session/event` | ✅ |
| **14. `agent/turn-stopping`** | `agent.ts:307` `await this.dispatch.serial(...)` | ✅ | ✅ | **可 await 的收尾钩子** | ✅ 最佳「turn 收尾」点 |
| **15. `turn/end` 落盘** | `agent.ts:330`（在 `finally` 里，必发） | ✅ | ✅ | `session/event`(type=`turn/end`，带 `reason`) | ✅ **推荐的一次性提取窗口边界** |
| **16. projection cache 刷盘** | `session-projection-cache/src/index.ts:306-308`（`turn/end` 是强制刷盘点） | — | ✅ 派生缓存 durable | — | 可读但**非权威** |
| **17. `agent/status: 'idle'`** | `agent.ts:120`（`kick()` finally `:230`） | ✅ | ✅ 之前的 turn 已结束 | `agent/status`（fire-and-forget） | ✅ 次优窗口信号 |
| **18. 会话 idle 后再次唤醒** | `wakeDriver` `agent.ts:183` | ✅ | ✅ | `agent/status: 'running'` | — |
| **19. `agent/disposed`** | `agent/src/index.ts:555`（`announce`）→ `:523`（`emitDisposed`） | ✅ **尚未移除** | ✅ | `agent/disposed` | ✅ 倒数第二个安全点 |
| **20. `session/disposed`** | `session/src/index.ts:1091-1092`（`detachEntered` `:1047`） | ⚠️ **已在 store 移除之后**；`ctx.sessions.get()` 返回 `undefined`。但 `event.session` 参数**就是那个对象**，仍可 `snapshotEvents()` | ✅ 内存日志还在 | `session/disposed`（**必须是最后机会**） | ✅ 最后机会，但**无法再 flush** （`liveEntryFor` 会拒，`index.ts:1130`） |
| **21. 进程退出** | `apps/cli/src/process-shutdown.ts:22`（5s 宽限） | ❌ 已销毁 | — | — | ❌ **进程外无法挂钩** |

### 关键推论

1. **可提取的最早时刻** = `user/message` 落盘（阶段 9）。但一个 turn 未结束时提取会得到半截对话 → 不要这样。
2. **推荐提取时刻** = 阶段 15（`turn/end`）+ 可选阶段 17（`agent/status: idle`）作为「对话静止」的启发式确认。
3. **最后的补救时刻** = 阶段 20（`session/disposed`）。⚠️ 此刻 `ctx.sessions.flush()` 会抛（因为已不在 store），所以**这一刻才能提取 = 必须已有独立存储**，不能依赖「先落盘会话再提取」。
4. **进程被 SIGKILL / 崩溃** → 阶段 20 不执行 → **只有到最后一个 `session/flush` 为止的事件 durable**。`session-checkpoint-policy` 的屏障（阶段 8）保证每次模型请求前一定 durable，所以「已产生模型回复的 turn」一定是 durable 的。

---

## 12. 明确不可用 / 不完整的能力清单

这一节比好消息更重要。

| # | 能力 | 状态 | 证据 |
|---|---|---|---|
| 1 | **「会话结束」一次性信号** | ❌ **不存在** | 全仓无 `session/end`/`session/closed`/`session/idle`；`session/disposed` 语义是「离开 store」不是「对话完成」（`session/src/index.ts:51-60` 注释） |
| 2 | **「对话静止 N 分钟」信号** | ❌ 不存在，只能自建定时器 | 无 last-activity 索引；`.agents/notes/proposed/architecture/2026-07-29-durable-last-activity-index.md` 仍是 **proposed** 状态，且明说「A cold session has no authoritative stored answer to 'when did the user last prompt here'」 |
| 3 | **会话日志里的 userId / owner** | ❌ **完全不存在** | `SessionHeader`（`session/src/types.ts:91-128`）、`SessionFormatHeader`（`session-format/src/types.ts:16-26`）、`SessionWireHeader`（`session-controller/src/types.ts:392-403`）均无此字段 |
| 4 | **多用户/租户隔离** | ❌ 只有 `$DSH_HOME` 级隔离 | `home-paths/src/index.ts:87`；browser auth 是主机级 cookie（`browser-auth.ts:106`） |
| 5 | **`user/message` 上的 turn 号** | ❌ 缺失 | `types.ts:294` `'user/message': UserMessage`（无 turn/step）；对比 `assistant/message` `:305-313` 有 |
| 6 | **`source.kind:'user'` 作为「人类输入」证明** | ❌ 不可靠 | headless 任务文本（`bundle/headless/src/index.ts:199`）、`/goal` 附件（`command-goal/src/index.ts:120`）、ACP（`acp/src/session.ts:296`）都用它 |
| 7 | **`SessionStartSource` 的 `'clear'`/`'compact'`** | ❌ 类型存在但**零生产者** | 只有 `'startup'`(`agent-loop/src/index.ts:710`) 与 `'resume'`(`:912`) 被 emit |
| 8 | **FTS 全文搜索** | ⚠️ 默认**关闭** | `cordis.patch.yml:129-133` `openAt: never` → `SESSION_QUERY_SEARCH_DISABLED`（`session-query-sqlite/src/index.ts:342`） |
| 9 | **大工具结果原文在日志里** | ❌ 只剩预览+locator | spill 在 append **之前**发生（`spill-policy/src/index.ts:185-204` + `tool-calls.ts:282`）；默认 50000 bytes 上限（`cordis.patch.yml:386`） |
| 10 | **spill 文件长期保留** | ❌ 30 天清理 | `spill-local/src/index.ts:68` `cleanupPeriodDays: 30` |
| 11 | **插件自定义事件跨 build 兼容** | ⚠️ 危险 | `KNOWN_SESSION_EVENT_TYPES` 是 build 静态集（`known-event-types.ts:22`）；未知类型未标 `ignorable` → 整个日志拒读（`storage-contract.ts:75`） |
| 12 | **崩溃时未 flush 的事件** | ⚠️ 丢失 | live 事件 200ms 批次写（`jsonl/src/storage.ts:36`）；只有 `session/flush` 后 durable（`handle.ts:99-109`） |
| 13 | **`session/flush` 在 `session/disposed` 之后** | ❌ 不可用 | `liveEntryFor` 在 store 已移除时抛错（`session/src/index.ts:1130-1137`） |
| 14 | **「exactly-once」的提取语义基础** | ❌ 无现成保证 | `session-log-deepseek` 明确选择 watermark + 保守重发，并留 TODO 承认重复窗口（`index.ts:165`） |
| 15 | **`generate()` / `complete()` 一次性模型 API** | ❌ 不存在 | `LlmRuntime` 只有 `stream()`（`llm/src/index.ts:1093`）；一次性必须自拼 `BlockAssembler` |
| 16 | **子代理/团队会话的归属自动归到父会话** | ⚠️ 需自建 | 有 `header.parentSession` / `header.origin:'subagent'` / `delegationDepth`（`session/src/types.ts:104-120`），但 `API` 侧会**拒绝**对子代理会话走通用路由（`session-controller/src/agent.ts:80-103` `hasApiSessionSubagentOwner`） |
| 17 | **`session/event` 上的顺序与背压** | ⚠️ 弱 | fire-and-forget（`session/src/index.ts:378-396`），慢 handler 会与后续事件并发交错 |

---

## 13. 阻塞点 / 尚待实验验证

### 需要实验才能定论（3 项）

**E1 — CLI 交互式用户输入是否带 `rpcId`？**
【尚待实验验证】
- 要验证：`{ kind:'user' }` 是否足以区分 CLI 人类输入 vs CLI headless 任务文本。
- 实验：用 `dsh` CLI 交互模式（非 headless）输入一条 prompt，正常退出；然后只读检查 `$DSH_HOME/sessions/<project>/<sessionId>/v2.jsonl.zstd` 里 `type:"user/message"` 那行的 `data.source` 是否含 `rpcId`。
- 若不含 → **CLI 场景下无可靠的人类输入标记**，必须降级为「`kind:'user'` 且内容不匹配已知注入模板」的启发式，并在记忆里标注低置信度。
- 注意：本实验会**写入会话数据**，必须在隔离的 `DSH_HOME` 下做（`DSH_HOME=<tmp>`）。不可在用户真实 home 跑。

**E2 — `session/flush` 之后，磁盘上的 JSONL 是否一定包含该 turn 全部事件？**
【基于源码的推断，接近确认】
- 源码链：`session/flush`(`session/src/index.ts:1111`) → `jsonl` 的 `session/flush` listener(`jsonl/src/storage.ts:540-547`) → `writer.drainLive()` + `writer.flush()` → `persistBatch`（`storage.ts:338`）。逻辑上看是完整的。
- 但需要实验确认「`flush()` resolve 时 fsync 已完成」：`jsonl/src/index.ts` 里有 `syncDirPosix`（`:1231`）和 `persistBatch` 的 fsync 路径。**跨平台（尤其 Windows）的 durability 承诺**需要实验。
- 实验：隔离 home，跑一个短会话，`await ctx.sessions.flush(session)` 后立刻 `Get-Content` 该文件（解 zstd），比对 `session.seq` 与文件行数 - 1（header 占一行）。
- 若 Windows 上不成立 → 记忆提取必须容忍「尾部缺事件」，用 `turn/end` 是否存在来判断窗口完整性。

**E3 — `agent/status: idle` 与「用户还会继续说话」之间的时间分布**
【尚待实验验证】
- 这是纯产品问题：`idle` 在**每个 turn 结束**都会出现（`agent.ts:230`），所以它不是「对话结束」。要判断「这个会话不会再继续」，只能靠时间阈值。
- 实验：在真实使用中记录 `agent/status:idle` 与后续 `turn/start` 的时间间隔分布，选出阈值。
- 这是**记忆系统的核心策略参数**，源码无法给出答案。

### 实现层面的阻塞

**B1 — 「没有会话结束信号」是架构事实，不是遗漏。**
本报告确认 DSH 的设计里，「会话」是「进程内 live 对象」而非「一段有始有终的对话」。因此：
- 无法订阅「对话结束」；
- 只能以 **turn 为原子窗口** 做增量提取，并自建「会话静止」启发式；
- 或者**在 `session/disposed` 时刻做最终补提取** —— 但那时 `ctx.sessions.flush()` 已不可用（B1 的关键风险）。

**B2 — `session/disposed` 之后无法 flush。**
`liveEntryFor`（`session/src/index.ts:1130`）在 store 移除后抛错。而 `session/disposed` 正是在 `detachEntered`（`:1039-1048`）里、`this.store.delete(entry.id)`（`:1045`）**之后**派发（`:1047`）。
→ **在 `session/disposed` handler 里调用 `ctx.sessions.flush(session)` 一定抛错。**
→ 如果记忆插件依赖「最后 flush 再读」，这条路走不通。必须已经在每次 turn 结束时增量提取。

**B3 — 插件事件类型与 build 静态事件表冲突。**
见 9.4 第 2 点。要么标 `ignorable: true`，要么接受卸载插件后会话不可读。

**B4 — owner 隔离需要外部配置。**
见 §8.5。这需要 Lead 决策：记忆的 owner 来自哪里（$DSH_HOME 路径哈希？用户配置？workspace path？）。

---

## 14. 附：本报告引用的核心文件索引（相对 DSH 源码根）

| 主题 | 文件 | 关键符号:行 |
|---|---|---|
| 事件封装 / 事件表 | `packages/core/session/src/types.ts` | `SessionEvent`:453, `SessionEventMap`:266, `SessionHeader`:91, `TurnEndReasonMap`:198 |
| 会话实现 | `packages/core/session/src/index.ts` | `Session`:422, `append`:678, `deriveMessages`:799, `SessionStore`:866, `flush`:1111 |
| 事件词表（生成） | `packages/core/session/src/known-event-types.ts` | `KNOWN_SESSION_EVENT_TYPES`:22 |
| 事件目录（生成文档） | `docs/persistence-catalog.md` | 53 个事件条目 |
| surface 派生 | `packages/core/session/src/surface.ts` | `deriveEventMessage`:90, `isAppendSurfaceEvent`:58, `isReplacementSurfaceEvent`:71 |
| 崩溃修复 | `packages/core/session/src/repair.ts` | `interruptedTurnClosers`:29 |
| 消息类型 | `packages/llm/llm/src/message.ts` | `Message`:131, `MessageSourceMap`:102, `ContextForm`:50, `UserMessage`:143, `createUserMessage`:194 |
| Agent 事件 | `packages/core/agent/src/runtime-types.ts` | `Events`:246, `AgentStatus`:109, `SessionStartSource`:125 |
| Agent 服务 | `packages/core/agent/src/index.ts` | `AgentRegistry`:249, id===sessionId 校验:470 |
| Agent 派发 | `packages/core/agent/src/dispatch.ts` | `agentEvents`:107, `emitAgentEvent`:158 |
| Agent 驱动 | `packages/core/agent-loop/src/agent.ts` | `setPhase/agent/status`:115-122, `preStep`:236, `turn`:257, `turn/end`:330, `turn-stopping`:307 |
| turn 边界投影 | `packages/core/agent-loop/src/index.ts` | `turnBoundaryProjectionDefinition`:56 |
| 工具结果落盘 | `packages/core/agent-loop/src/tool-calls.ts` | `appendToolResult`:269 |
| 持久化 seam | `packages/session/session-persistence/src/index.ts` | `SessionPersistence`:135, `open`:162 |
| handle | `packages/session/session-persistence/src/handle.ts` | `read`:83, `flush`:109 |
| 持久化错误 | `packages/session/session-persistence/src/errors.ts` | `SessionFormatUnsupportedError`:111 |
| 未知事件拒读 | `packages/session/session-persistence/src/storage-contract.ts` | `validateStoredEvents`:69, 拒读判断:75 |
| JSONL 格式 | `packages/session/session-persistence-jsonl/src/format.ts` | `projectDir`:252, `logPath`:296, `eventLine`:320 |
| JSONL 读写 | `packages/session/session-persistence-jsonl/src/storage.ts` | `LIVE_WRITE_BATCH_MAX_DELAY_MS`:36, `JsonlSessionHandle`:85, 事件挂载:534-554 |
| 查询服务 | `packages/session-query/session-query/src/index.ts` | `SessionQueryEngine`:97, `readSession`:183, `readSurface`:308, `listEvents`:267 |
| 冷读 | `packages/session-query/session-query/src/cold-read.ts` | `readColdSessionLog`:31 |
| 查询快照类型 | `packages/session-query/session-query/src/types.ts` | `SessionLogSnapshot`:49, `SessionSurfaceSnapshot`:37 |
| 模型服务 | `packages/llm/llm/src/index.ts` | `LlmRuntime`:330, `prepareCall`:904, `stream`:1093, `adapterFailureChunk`:1110 |
| 模型请求类型 | `packages/llm/llm/src/types.ts` | `GenerateOptions`:407, `FinishReasonMap`:130 |
| 流组装 | `packages/llm/llm/src/assembler.ts` | `BlockAssembler`:38 |
| 压缩 seam | `packages/compaction/compaction/src/index.ts` | `CompactionEngine`:96 |
| 压缩事件 | `packages/compaction/compaction/src/types.ts` | `compaction/start`:24, `compaction/summary`:34, `compaction/end`:72 |
| 压缩替换 | `packages/compaction/compaction-basic/src/region.ts` | replace append:472, 摘要必须更小:384 |
| 压缩标记 | `packages/compaction/compaction/src/checkpoint.ts` | `COMPACT_CHECKPOINT_MARKER`:19, `isCompactCheckpointSource`:49 |
| 裁剪 | `packages/compaction/compaction-tool-result-pruner/src/index.ts` | `pruneSession`:136, `compaction/prune`:162 |
| spill seam | `packages/spill/spill/src/index.ts` | `SpillStore`:45, `saveText`:55 |
| spill 策略 | `packages/spill/spill-policy/src/index.ts` | `tools/post-execute`:185, `tools/ptc-dispatch-log`:212 |
| spill 本地 | `packages/spill/spill-local/src/index.ts` | `LocalSpillStore`:65, `cleanupPeriodDays`:68 |
| 持久化屏障 | `packages/session/session-checkpoint-policy/src/index.ts` | `apply`:63, pre-step flush:79-82 |
| 投影注册表 | `packages/session/session-projection/src/index.ts` | `SessionProjectionRegistry`:199, `checkpoint`:396, `restore`:495 |
| 投影缓存 | `packages/session/session-projection-cache/src/spec.ts` | `checkpointRow`:26, `projectionCacheDomainSpec`:98 |
| durable 游标先例 | `packages/session/session-log-deepseek/src/index.ts` | `acceptedThrough`:95, 提交:159-167 |
| 匿名用户 id | `packages/identity/anonymous-user-id/src/index.ts` | `getOrCreateAnonymousUserId`:68 |
| 存储域 | `packages/storage/storage-domain/src/index.ts` | `DomainFacility.open`:103 |
| 存储域 spec | `packages/storage/storage-domain/src/spec.ts` | `defineDomain`:107, `domainTable`:91 |
| DSH home | `packages/util/home-paths/src/index.ts` | `resolveDshHome`:87 |
| 进程退出 | `apps/cli/src/process-shutdown.ts` | `createProcessShutdown`:22, `PROCESS_SHUTDOWN_TIMEOUT_MS`:4 |
| bundle 组合 | `packages/bundle/base/cordis.patch.yml` | persistence:110, query:129, spill:380, checkpoint:389, pruner:394 |
| Cordis 派发语义 | `vendor/cordis/src/events.ts` | `isBailed`:13, `apply`:165, `parallel`:183, `emit`:194, `serial`:204, `bail`:217, `waterfall`:234 |
| scope 载体 | `packages/core/scope/src/index.ts` | `scopeTarget`:170 |
| 作用域事件清单（生成） | `packages/core/scope/src/scoped-events.generated.ts` | 29 个 scoped 事件 |
