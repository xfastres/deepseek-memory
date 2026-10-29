# L2/L3 就绪度核查（只读结论，未接线）

> 目的：在 `D11`（L2/L3 后置）不变的前提下，核实已有纯函数模块能否承接阶段 4/5，
> 并把「接线前必须先解决什么」写成清单。本轮**没有**把 L2/L3 接入注入、没有自动生成、没有新增存储。
> 证据来自 `packages/dsh-memory/host/scenarios.js`、`host/persona.js`、`provider-git-ledger/src/schema.js`、
> `host/memory-types.js` 及其测试 `test/scenarios.test.mjs`、`test/persona.test.mjs`。

## 1. 现状

| 模块 | 设计要求（roadmap） | 当前实现 | 证据 | 判定 |
|---|---|---|---|---|
| L2 场景记忆 | 从正式 L1 组织出项目/会话结构；不得由模型凭空生成事实 | `clusterMemories()` 纯函数：按 `source_refs.session_id` + 7 天窗口、或共享 `entities` 聚类；`summary` 恒为 `null`；`summarisable()` 只允许成员全部 active 的摘要 | `host/scenarios.js`；`test/scenarios.test.mjs` 8 项 | 部分实现（纯函数 + 测试，**未接入**任何路由/UI/注入） |
| L3 长期画像 | 仅从有效 L1/L2 推导；每条结论可回溯；不得伪装用户原话；支撑变化触发复核；自动生成后置 | `buildPersona()` 纯函数：按 type+entity 聚类，输出用户原话（可截断）+ `sources` + `count`；`personaVersion/personaFresh` 以账本 head 判新旧 | `host/persona.js`；`test/persona.test.mjs` 8 项 | 部分实现（纯函数 + 测试，**未接入**；无 review_pending 联动） |

## 2. 本轮修掉的两个真实缺陷

1. **persona 读错词汇表**：`PERSONA_TYPES` 原本包含 `instruction`，但账本 `MEMORY_TYPES` 中没有这个类型
   （`provider-git-ledger/src/schema.js` 只有 `fact/preference/constraint/decision/goal/event/open_loop/hypothesis`），
   规则类型 `instruction` 在写入边界由 `memory-types.js` 的 `TYPE_ALIASES` 映射为 `constraint`。
   后果：L3 会静默丢掉用户说过的每一条指令。已改为 `preference/constraint/decision`，并加测试锁住
   「`instruction` 不可能是账本行」。
2. **scenario id 依赖截断前缀**：`stableId` 用 `key.slice(0,40)` 做可读部分、成员数量做后缀，
   两个共享 40 字符前缀的 session id 会得到同一个 id。已改为「可读前缀 + 完整 key 与成员集合的 sha256 前 10 位」，
   并加测试锁住「长前缀不同 session 仍是两个场景」。

## 3. 接线前置条件（按依赖顺序，未开始）

1. **L1 稳定**：L2/L3 只允许读 `status === 'active'` 的账本记忆——模块已如此过滤，但前提是 L1 的
   retract/update 行为已被真实使用验证（目前仅自动化测试覆盖）。
2. **异议联动（必须先做）**：`scenarios.js`/`persona.js` 的输入目前是「账本记忆数组」，
   不知道运行时异议。若直接接线，用户刚否定的记忆仍会成为场景成员或画像支撑，
   与 `§6.4`「异议未解决的记忆不得当作已确认结论」冲突。接线前需在调用处传入
   `suppressedIds/reviewPendingIds` 并让两模块接受过滤参数（改签名属接口变更，需先确认）。
3. **L2 的 scope 语义**：`clusterMemories` 以 `memory.scope ?? 'global'` 分区，但当前 L1 写入路径
   是否稳定产出 `scope` 仍未在真实数据中验证（`/add` 有 `scope` 字段，面板未暴露）。
4. **L3 的复核触发**：roadmap 要求「支撑记忆被撤回/修改/否定时画像进入 review_pending」。
   目前 `personaVersion` 只按账本 head 判陈旧，没有逐条 sources 的失效检测，也没有运行时
   `review_pending` 记录。这需要一个新的运行时字段（数据格式变更）→ 属于需先确认的决策。
5. **存储位置决策**：L2/L3 是「每次从账本派生」还是「写入独立文件/账本」？
   当前两个模块设计为纯派生（无存储），若保持派生则无需迁移，但 UI 每次需重算；
   若落盘则涉及新的数据格式与迁移 → 需确认后再动。
6. **注入禁令**：`persona.js` 文件头已写明「画像永不进入 Prompt」，接线时必须保持；
   L2 同理不得变成第二条注入管线。
7. **UI**：面板尚无 L2/L3 视图；实现时只读展示 + 证据链接，不新增写入口。

## 4. 未决问题（不擅自决定）

- 画像是否应包含 `goal`（长期目标）？roadmap 例子是「稳定的沟通偏好或工作方式」，
  未排除 goal；本轮只修了 `instruction→constraint` 这一明确错误。
- L2 摘要：`summarisable()` 只判断「成员是否都 active」，但摘要由谁写、是否必须带引文核对，
  roadmap 提到「通过引文检查」——目前没有任何摘要写入路径，需在阶段 4 设计时决定。
- `scenarios.js` 的 `minSessionMembers=3` / `minEntityMembers=2` 是经验值，无真实数据支撑。

## 5. 结论

L2/L3 **均未到可接线状态**：模块本身有测试、且本轮修掉两个真实缺陷，但异议联动、
复核状态与存储位置三项都属于「数据格式/接口变更」或「架构决策」，按既定规则应先确认。
在确认之前，阶段 4/5 不启动；继续推进 L0/L1/审查与纠错闭环中不需要新数据格式的缺口。
