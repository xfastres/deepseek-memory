# 一条消息的完整流转：从你发出去，到记忆被注入、被写进账本

> 基于 `packages/dsh-memory` 真实代码核对，不是推测。
> 相关文件都在 `deepseek-memory/packages/dsh-memory/` 下。

---

## 全景图

```
你发一条消息
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ DSH 核心：进入 agent 的一步                                  │
│   触发 agent/pre-step 瀑布钩子                               │
│   payload = { agent, messages, turn, step, signal }          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ index.js  onPreStep()   ← 插件挂在这个钩子上                 │
│                                                             │
│  ① injection.observe()      记下你这句话的原文               │
│  ② extractCandidates()      从你的话里挑「像记忆」的句子     │
│  ③ proposeForReview()       候选写进 runtime.json（异步）    │
│  ④ handleCorrection()       如果你在纠正某条记忆 → 提异议    │
│  ⑤ injection.ensureFresh()  刷新账本快照（TTL 30 秒）        │
│  ⑥ refreshConstraints()     重新解析常驻约束                 │
│  ⑦ flushInjections()        注入记录落盘                     │
│  ⑧ ensureContext()          注册 prompt 上下文（若有记忆）   │
│  ⑨ next()                   放行，继续组装 prompt            │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ DSH：systemPrompt.assemble()  组装完整 prompt                │
│                                                             │
│   调用插件的 provider：                                      │
│     buildText(scope)                                        │
│       → lookup(scope)        找回这一轮你说了什么            │
│       → selectMemories()     打分、排序、按预算截断          │
│       → formatInjection()    拼成一段文字                    │
│       → 返回 "以下是用户已确认的长期记忆…"                   │
│                                                             │
│   这段文字进入 PromptAssembly.contexts[]                     │
│   和 sections / tools / variables 一起打包                   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
        完整 prompt  →  发给大模型  →  大模型生成回复
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 回复回到会话日志（assistant message）                        │
│   注：插件**不会**把 AI 的回复当成记忆证据                   │
└─────────────────────────────────────────────────────────────┘
    │
    ├─────────────── 你在面板里接受某条候选 ───────────────┐
    │                                                      │
    ▼                                                      ▼
┌──────────────────────────────────┐   ┌──────────────────────────────┐
│ 下一轮 pre-step 时快照刷新        │   │ POST /api/dsh-memory/review  │
│ 这条记忆才可能被注入              │   │   → ledger-service.add()     │
│ （本轮 prompt 已经组装完了）      │   │   → MemoryLedger.apply()     │
└──────────────────────────────────┘   │   → records/M-xxx.json       │
                                       │   → changes/MC-xxx.json      │
                                       │   → git commit               │
                                       └──────────────────────────────┘
```

---

## 实时画面对上这张图

`node scripts/memory-flow-live.mjs` 默认不把每条事件往下刷。一轮收成三块，和上面的序号是对齐的：

| 画面上 | 对应 | 为什么在这个位置 |
|---|---|---|
| 进去 | ① 抄下的原文，加上 enter 里的会话 / 轮次 | `pre-step` 只观察，不改消息 |
| 做了什么 | ② 抽出几条、⑤ 快照、⑥ 约束、⑧ 接口是否注册 | 快照在步边界读。提示词组装是同步的，不能在那里等 Git |
| 出来 | 组装时 provider 返回的注入原文；③ 的候选和策略 | 注入只读快照，不写账本。候选默认只进 runtime 队列 |

④ 纠正和 ⑦ 注入记录落盘没有单独的 trace 事件，所以画面上不会多这两行。候选入队是异步的，常常比「本步结束」更晚才补上，事件里也不带轮次号。

`GET /trace` 是这个脚本自己每秒来拉新事件；面板打开时还会 GET `/state`、`/candidates` 等。Host 对每个路由都记一条 `http`，默认把这些只读轮询藏掉。要看原始 HTTP，加 `--raw-http`。

## 第 0 步：消息进来之前，账本里已经有什么

**文件**：`~/.dsh/dsh-memory/ledger/`

```
ledger/
├── records/M-20261029-0adfc79b.json    ← 正式记忆，一条一个文件
├── changes/MC-20261029142536-148cd95c.json  ← 变更记录
├── changes/MC-20261029142536-148cd95c.md    ← 人类可读的变更说明
└── manifest.json                        ← 索引
```

一条记忆长这样（真实数据）：

```json
{
  "memory_id": "M-20261029-0adfc79b",
  "content": "用户给这个助手起的名字是 Moss。对用户说话时以 Moss 自称。",
  "type": "preference",
  "scope": "global",
  "status": "active",
  "confidence": 0.95,
  "importance": 3,
  "source_refs": [{
    "session_id": "session-f3a9b263-...",
    "event_seq": 9,
    "event_type": "user/message",
    "quote_sha256": "3eab5eb6..."
  }]
}
```

`source_refs` 是这条记忆的「证据」——它必须能指回某次会话里你亲口说的那句话。`quote_sha256` 是那句话的哈希，用来事后核对「证据有没有被改过」。

---

## 第 1 步：`agent/pre-step` 钩子被触发

**DSH 侧契约**（用 inspect 查到的真实签名）：

```
事件：agent/pre-step        模式：waterfall
签名：'(this: Scoped<Agent>, payload: {
         agent: Agent; messages: UserMessage[]; turn: number;
         step: number; signal: AbortSignal
       }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>'
返回：{ kind: 'reject' } 或 { kind: 'enter', messages: UserMessage[] }
```

这是一个**瀑布钩子**：每个监听器都可以拦下来、改消息，或者调 `next()` 放行。

**文件**：`index.js`，`apply()` 末尾（第 764–797 行）

```js
const onPreStep = function onPreStep(payload, next) {
  currentTurn = { sessionId: payload.agent.id, turn: payload.turn };
  const observed = injection.observe(ctx, payload);      // ①
  proposed = extractCandidates(observed.text);            // ②
  proposeForReview(payload, proposed);                    // ③
  handleCorrection(payload, observed.text);               // ④
  return Promise.resolve(injection.ensureFresh())         // ⑤
    .then(() => { refreshConstraints(); flushInjections(); ensureContext(); })
    .then(() => next());                                  // ⑨
};
ctx.on('agent/pre-step', onPreStep);
```

注意：这里每一步都是独立的 `attempt()` 包着，**任何一步失败都不会打断你的对话**。这是插件的硬规矩。

---

## 第 2 步：① 记下你这句话

**文件**：`host/injection.js`，`observe()`（第 159 行）

```js
function observe(scope, payload) {
  const text = stepQuery(payload.messages);   // 把这一轮的 user 消息拼起来
  const agentId = payload.agent.id;
  latest = { turn, agentId, text, at: now() };
  byScope.set(scope, latest);   // 按 scope 对象索引
  byAgent.set(agentId, latest); // 按会话 id 索引
  return latest;
}
```

**文件**：`host/injection.js`，`stepQuery()`（第 41 行）

```js
export function stepQuery(messages) {
  const parts = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;   // ← 只要 user，不要 assistant
    parts.push(messageText(message).trim());
  }
  return parts.join('\n').slice(0, 4000);    // ← 截断到 4000 字
}
```

关键点：**只看 `role === 'user'`**。AI 自己说的话永远不会被当成记忆来源。

为什么要存两份（`byScope` 和 `byAgent`）？因为 prompt 组装时拿到的 `scope` 对象，不保证和钩子拿到的那个是同一个。所以留两条路：scope 能对上就用 scope，对不上就用会话 id。

---

## 第 3 步：② 从你的话里挑「像记忆」的句子

**文件**：`host/extraction.js`

先用 `sentences()` 按句号/问号/换行切句，再用 `refusal()` 剔除：

```js
export function refusal(sentence) {
  if (sentence.trim() === '') return 'empty';
  if (QUESTION.test(sentence)) return 'question';       // 问句不要
  if (HYPOTHETICAL.test(sentence)) return 'hypothetical'; // 假设句不要
  return undefined;
}
```

然后用 6 条规则匹配（`RULES`，第 22–61 行）：

| 规则 | 类型 | 置信度 | 匹配样例 |
|---|---|---|---|
| `instruction` | instruction | 0.85 | 记住、记一下、别忘了、以后记住 |
| `instruction-en` | instruction | 0.85 | remember, from now on, keep in mind |
| `decision` | decision | 0.75 | 决定、就按这个、采用、敲定 |
| `decision-en` | decision | 0.75 | we decided, let's use, going with |
| `preference` | preference | 0.70 | 我更喜欢、一律、以后都、请用、不要用 |
| `preference-en` | preference | 0.70 | I prefer, always use, please use |

置信度还会微调：句子里有「一定/永远/务必/必须」→ **+0.05**；有「也许/可能/大概」→ **−0.15**。最后夹在 `[0.3, 0.95]` 之间，一轮最多 3 条。

你之前那句「你的名字是Moss」，就是被 `preference` 规则里的「以后都/请用」类意图命中的——实际那次是 LLM 提案，规则提取只认显式说法。

---

## 第 4 步：③ 候选写进队列（不是账本）

**文件**：`index.js`，`proposeForReview()`（第 529 行）

顺序很讲究，每一步都可能直接返回：

```js
1. 去重：和账本里已有的 active 记忆比对（忽略空白和大小写）
2. app.evidence.resolve({ sessionId, turn })   ← 解析证据
      → 解析不到？直接 return，什么都不写
3. 读 settings，enabled !== true 就 return
4. app.service.state() 读账本
5. app.runtime.addCandidate({ text, type, sessionId, turn,
                              confidence, reason, origin:'rule',
                              sourceRef: ref,
                              entities: matchKnownEntities(...) })
6. decideAutoMemory() 决定：自动接受 / 冲突 / 待审
```

**证据怎么解析**：`host/session-evidence.js`

```js
export function turnUserMessageSeq(records, turn) {
  const starts = records.filter(r => r.type === 'turn/start');
  const startSeq = starts[turn - 1].seq;
  const endSeq   = starts[turn].seq;
  // 找这一轮里第一条 user/message 的 seq
  const message = records.find(r =>
    r.type === 'user/message' && r.seq > startSeq && r.seq < endSeq);
  return message?.seq;   // 找不到就是 undefined → 调用方不许写
}
```

这就是「不编造 `event_seq`」的实现：**解析失败就不写**，宁可漏也不编。

候选落在 `~/.dsh/dsh-memory/runtime/runtime.json` 的 `candidates[]` 里，**不是** Git 账本。因为候选是操作状态，会频繁变，不该污染记忆历史。

---

## 第 5 步：④ 如果你在纠正某条记忆

**文件**：`host/correction-detect.js`，被 `index.js` 的 `handleCorrection()` 调用

你说「这个记错了」「不对，应该是…」这类话时：

1. `isCorrectionCandidate(text)` 先快速判断——大多数轮次不是纠正，**直接跳过，连账本都不打开**
2. 明确指向某条记忆 → 写一条 `objection` 到 `runtime.json`
3. **立刻**从检索里屏蔽它（`injection.refresh()` 强制重建快照）

异议不是账本写入，所以猜错了不会污染历史——但会暂时藏掉一条好记忆，所以**指向不明确时宁可不做**。

---

## 第 6 步：⑤ 刷新账本快照

**文件**：`host/injection.js`，`ensureFresh()`（第 310 行）

```js
async ensureFresh(ttlMs = 30000) {
  const at = snapshot.at === null ? NaN : Date.parse(snapshot.at);
  if (now() - at < ttlMs) return false;   // 30 秒内不重复读盘
  await refresh();
}
```

`refresh()` 做的事：

1. `service.state()` 读 Git 账本 → 全部记忆
2. `service.suppressed()` 读被异议的记忆 id
3. 过滤掉被异议的
4. 存成内存快照 `{ at, head, memories, suppressed }`

注意 `refresh()` 的失败策略是 **fail-closed**：读不到异议列表时，保留上一次已过滤的快照，或者干脆注入空——绝不「读失败就当没异议」，那样会把用户已经否掉的记忆又放回来。

---

## 第 7 步：⑥⑦⑧ 约束、落盘、注册

- **`refreshConstraints()`** → `host/constraints.js` 读 `~/.dsh/dsh-memory/memory-settings.json`，解析出常驻约束（现在你机器上没这个文件，所以 `fallback: missing-file`，约束池 0/240）
- **`flushInjections()`** → 把队列里的注入记录写进 `runtime.json`。**provider 本身绝不碰磁盘**——prompt 组装是同步的、在关键路径上，不能等 I/O
- **`ensureContext()`** → 关键的一步，见下

**`ensureContext()`（index.js 第 702 行）——这是「为什么不注入」的分水岭**：

```js
const eligible = injection.snapshot.memories.some(m => m.status === 'active');
if (!eligible) {
  contextState.skipped = 'no-active-memory';
  return;                      // ← 账本空？provider 根本不注册
}
contextOff = systemPrompt.context({ name: 'dsh-memory', order: 100, text: provider });
```

**账本里没有 active 记忆时，插件完全不进 prompt 组装流程。** 这是刻意的：prompt 组装每一步都要跑，没东西可注入就别占位。

---

## 第 8 步：prompt 组装时，provider 被调用

**DSH 侧契约**：

```
服务：systemPrompt
方法：context(context: PromptContext): () => void
PromptContext = { name, order, text: string | ((ctx) => string) }
PromptAssembly = { sections[], contexts[], tools[], variables{} }
```

**文件**：`index.js` 第 713 行的 `provider`：

```js
const provider = (context) => {
  const text = injection.buildText(context && context.scope).text;
  contextState.calls += 1;
  return text;      // 空字符串 = 不贡献任何内容
};
```

**文件**：`host/injection.js`，`buildText()`（第 229 行）——整条链最核心的函数：

```
buildText(scope)
 ├─ lookup(scope)           找回这一轮你说了什么
 ├─ chooseForContext()      调 selectMemories 打分选记忆
 ├─ formatInjection()       拼成最终文字
 └─ injectionLog.note()     记一条注入记录（只存摘要，不存正文）
```

`lookup(scope)` 有四种结果，都会记进 `path`：

| path | 含义 |
|---|---|
| `scope` | 组装时的 scope 对象正好是钩子记下的那个 → 最准 |
| `agent` | scope 里带了会话 id，能对上 |
| `latest` | 只见过一个会话，用最近那条 |
| `ambiguous` | 见过多个会话但都对不上 → **故意丢弃查询**，注入通用块 |

`ambiguous` 时的取舍很清醒：注入别的会话的查询「看起来对，其实是错的」，比什么都不注入更糟。

---

## 第 9 步：打分与选择

**文件**：`host/retrieval.js`，`selectMemories()`（第 179 行）

两个池子：

| 池 | 预算 | 内容 |
|---|---|---|
| 约束池 | 240 字 | 常驻约束，走「精简摘要」不是全文，超长直接拒（裁剪会改变语义） |
| 动态池 | 800 字 | 普通记忆，按分排序，单条最多 400 字 |

**资格过滤** `eligibility()`（第 134 行）——先过这关才谈打分：

```
status 必须 active
scope 匹配
有效期（valid_to）没过
内容质量（太短 / 重复如「哈哈哈哈」都拒）
私密标记
```

**打分** `scoreMemory()`：

```
总分 = 权重 × (pinned, lexical, confidence, importance, recency, tags)
lexical = 命中词数 / 查询词总数        ← 中文按 bigram 切
recency = 1 / (1 + 天数/30)            ← 30 天衰减一半
```

排序：`pinned` 优先 → 总分高优先 → id 字典序（保证确定性）。

**你机器上的真实结果**：

```
约束池 0/240   动态池 34/800
选中 1 条：M-20261029-0adfc79b  34 字
理由：置信度 0.95，重要度 3，近期更新
排除 0 条
```

---

## 第 10 步：拼成最终文字

**文件**：`host/retrieval.js`，`formatInjection()`（第 343 行）

```js
export function formatInjection(chosen, { header = '以下是用户已确认的长期记忆，仅作背景参考：' } = {}) {
  const lines = [header];
  chosen.forEach((entry, i) => {
    const scope = entry.memory.scope !== 'global' ? `（范围：${scope}）` : '';
    lines.push(`${i + 1}. ${entry.text}${scope}`);
  });
  return lines.join('\n');
}
```

产出：

```
以下是用户已确认的长期记忆，仅作背景参考：
1. 用户给这个助手起的名字是 Moss。对用户说话时以 Moss 自称。
```

59 字。这段文字被放进 `PromptAssembly.contexts[]`，和其他 sections/tools 一起发给模型。

**为什么措辞这么小心**：明确写「仅作背景参考」，因为记忆是用户说过的话，不是对 AI 的指令。否则一条记忆就能变成 prompt 注入攻击。

---

## 第 11 步：发给大模型，模型回复

这一步在 DSH 核心里，插件不参与。插件只负责往 `contexts[]` 里塞那段字。

回复回来后会进会话日志（`assistant` 消息）。**插件不会读它**——`stepQuery()` 只取 `role === 'user'`。

这就是设计文档里那条「不是聊天总结器，不把 AI 回复当成用户偏好的唯一证据」。

---

## 第 12 步：你把候选加进记忆，会发生什么

你在面板点「接受」时：

```
面板
  → POST /api/dsh-memory/review     （带 x-dsh-memory-token）
  → host/http-app.js  路由 /review
  → 校验：回环 socket + 回环 Host + 非跨站 + token 正确
  → host/ledger-service.js  service.add() / applyChange()
  → provider-git-ledger/src/ledger.js  MemoryLedger.apply()
       ├─ 取 RepoLock（跨进程文件锁）
       ├─ 校验 source_refs（有证据才写）
       ├─ 写 records/M-xxx.json
       ├─ 写 changes/MC-xxx.json + .md
       └─ git commit（一条变更一次提交）
  → 回到 index.js：refresh() 重建快照
```

**写入闸门**（`http-app.js` 的 `authorizeWrite()`）：

1. 回环 socket（`127.0.0.1` / `::1`）
2. 回环 Host 头
3. 不能是跨站（`sec-fetch-site !== 'cross-site'`）
4. **必须带 `x-dsh-memory-token`**，token 由 `GET /state` 发给同源页面

第 4 条是防「你随便逛个网页，那个网页就能替你改记忆」——跨站读不到 `/state` 响应体，自定义头又会触发预检，Host 不放行。

**证据闸门**（`ensureEvidenceAvailable()`）：

没有 `sessionQuery` 时返回 `503 evidence-unavailable`，**不静默跳过证据校验**。

**并发闸门**：`/update`、`/retract`、merge 必须带 `expectedBaseChangeId`，否则 `400 missing-base`。这是防「你看到的是旧版本，别人已经改过了」。

---

## 为什么你接受后，本轮还是看不到

时间线（真实发生过的）：

```
14:25:17  我提了 memory_propose 提案
14:25:36  你在面板接受 → 写 Git 账本
14:25:36  这一轮 pre-step 早就过了，prompt 已组装完
          ↓
          ↑ 所以这一轮模型看不到这条记忆
14:26:45  下一轮 pre-step → ensureFresh 读到新快照 → ensureContext 注册 provider
          ↓
          这一轮开始才注入
```

`ensureContext()` 只在 pre-step 里调，而 pre-step 在 prompt 组装之前。所以**账本变化总是「下一轮生效」**。

---

## 三条硬规矩（整个设计的骨架）

| 规矩 | 实现位置 |
|---|---|
| **证据优先**：active 记忆必须带 `source_refs`，解析不到就不写 | `session-evidence.js` + `ledger.js` |
| **单一 Writer**：只有 `MemoryLedger.apply()` 写正式记忆，Client 不碰 Git | `ledger-service.js` |
| **失败不影响对话**：每条注册独立 try，提取/写入 fire-and-forget | `index.js` 的 `attempt()` |

还有两条：

- **AI 不批准自己**：`memory_propose` 只进 `runtime.proposals`，`status: open`，必须你在面板接受
- **异议优先**：你一标记有误，该记忆**立刻**退出检索和注入，不等 Git 撤回

---

## 当前状态（你这台机器）

| 项 | 值 |
|---|---|
| 账本记忆 | 1 条（`M-20261029-0adfc79b`，preference，active） |
| 注入次数 | 7 次，全部 `returned` |
| 每轮注入 | 59 字（34 字正文 + 25 字头） |
| 预算占用 | 34/800 = 4.25% |
| 约束池 | 0/240（`memory-settings.json` 不存在） |
| 候选队列 | 0 |
| 提案 | 1 条，已接受 |
