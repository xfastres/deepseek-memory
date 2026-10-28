# 阶段 3 注入设计（草案）

> 依据 [dsh-memory-roadmap-v2.md](dsh-memory-roadmap-v2.md) §8 阶段 3。状态：设计中，检索部分已实现并有测试。

---

## 1. 已核实：注入时能拿到这轮用户说了什么

`agent/pre-step` 是 waterfall 事件，签名（来自 Host 事件契约）：

```ts
'agent/pre-step'(
  this: Scoped<Agent>,
  payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>
): Promise<PreStepDecision>

type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

这解决了路线图 3.1 的核心问题：**注入点能读到本轮用户消息**（`payload.messages`）、轮次号（`payload.turn`）和会话身份（`payload.agent.id`）。

## 2. 为什么不用「改写 messages」来注入

`enter` 允许替换进入这一步的消息列表，技术上可以直接往里塞一条“记忆”消息。不这样做，原因是：

1. 那会**伪造对话内容**——日志里会出现用户没说过的话，破坏“L0 是唯一事实源”的前提；
2. 复盘时无法区分“用户说的”和“插件塞的”；
3. 与用户已确认的原则冲突：“AI 回复与工具结果可以支撑事实，但不能单独推断偏好”——同理，插件也不该创造用户发言。

## 3. 采用的组合：pre-step 观察 + 上下文注入

```
agent/pre-step（只观察，不改 messages）
    └─ 记下 { agentId → 本轮用户消息, turn, 时间 }      （内存，按 agent 覆盖）

systemPrompt.context({ name: 'memory', order })
    └─ 组装提示词时读取上面记下的用户消息
        └─ selectMemories(...) → formatInjection(...) → 一个独立的上下文块
    └─ 同时把「本轮注入了哪些记忆、为什么」写入注入记录（运行时库）
```

这样：

- 会话日志里**没有**被伪造的消息；
- 注入内容出现在提示词的独立上下文块里，标题写明“以下是用户已确认的长期记忆，仅作背景参考”；
- 每次注入都有记录，界面能回答“这一轮用了哪些记忆、为什么”。

**待验证**：`systemPrompt.context` 的回调只收到 `scope` 和 `signal`，所以要用第 3 步的内存传递。这个传递的正确性（多会话并发时不会串号）必须在阶段 3.4 用一个实验确认，不能假设。

## 4. 检索已经实现（可解释）

`packages/dsh-memory/host/retrieval.js`，12 项测试通过。

打分是**加权和，并且保留每一项**：

```
总分 = 文本相关度 × 0.6 + 新近度 × 0.15 + 重要度 × 0.15 + 置信度 × 0.1
置顶记忆直接满分并跳过预算限制
```

- 文本相关度：拉丁词 + 中文二元组（中文没有空格，二元组是能召回短语的最小单位）；
- 新近度：30 天半衰，`1 / (1 + 天数/30)`；
- 每个被排除的记忆都带一个原因（`not-active` / `expired` / `private` / `other-scope` / `no-lexical-match` / `over-limit` / `over-budget`），不是静默丢弃；
- 选中项生成一句人能读懂的理由，例如“命中 3 个词（合并、记忆、原文），置信度 0.95，重要度 4，近期更新”。

**默认不使用向量检索**：打分必须能解释，且 trigram/二元组已能处理中文。等评估集显示“同义不同词”召回不足时再引入（路线图决策 D4）。

## 5. 注入预算

- 默认最多 8 条、约 1200 字；
- 超出按分数截断，被截断的条目也记录原因；
- 置顶记忆不受预算限制（用户显式要求的东西优先）；
- `private` 默认永不注入，除非用户在某次会话里显式打开。

## 6. 关闭与纠正

| 层级 | 手段 |
|---|---|
| 全局 | 设置里关掉注入 |
| 会话 | 针对某个会话关闭 |
| 单条 | 撤回 / 标记“不要自动注入” / 置顶改为取消 |
| 事后 | 在轮次详情里对某条被注入的记忆标记“不相关 / 错误”，错误立即进入纠正流程并停止注入 |

## 7. 待验证清单

| 编号 | 问题 | 验证方式 |
|---|---|---|
| P1 | pre-step 的 `payload.messages` 是否每步都包含本轮完整用户消息 | 打点记录，跑几轮真实对话比对 |
| P2 | 多会话并发时，按 agentId 传递“本轮用户消息”会不会串号 | 两个会话各发一条不同消息，检查注入内容 |
| P3 | `systemPrompt.context` 的 `order` 取值与既有上下文块的相对位置 | 查 `getContextOrder` 的可用名字 |
| P4 | 注入记录写在哪里、界面怎么读 | 阶段 3.5 |
