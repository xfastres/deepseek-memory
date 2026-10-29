# 文档目录

按用途分四类。文件名保持原样，方便对照 git 历史。

| 目录 | 读什么 |
|---|---|
| [investigation/](investigation/) | DSH 宿主怎么加载插件、会话证据从哪来、账本哪些部分可复用 |
| [design/](design/) | 目标架构与阶段设计（不等于已经实现） |
| [status/](status/) | 实现到哪了、审计发现了什么 |
| [ops/](ops/) | 怎么在本机验收、示例夹具 |

先读 [仓库 README](../README.md)，再按问题选下面的入口。

## investigation — 调查

| 文件 | 说明 |
|---|---|
| [dsh-native-memory-plugin-investigation.md](investigation/dsh-native-memory-plugin-investigation.md) | DSH 原生记忆插件技术调查（结论先行） |
| [notes/](investigation/notes/) | 调查草稿：Bundle 加载、会话证据、账本复用、Lead 核实清单 |

## design — 设计

| 文件 | 说明 |
|---|---|
| [dsh-memory-roadmap-v2.md](design/dsh-memory-roadmap-v2.md) | v2.1 产品方案与路线图 |
| [dsh-memory-host-api.md](design/dsh-memory-host-api.md) | Host HTTP 契约（部分字段可能落后于代码） |
| [dsh-memory-phase3-design.md](design/dsh-memory-phase3-design.md) | 阶段 3 设计 |
| [dsh-memory-phase4-design.md](design/dsh-memory-phase4-design.md) | L2/L3：场景与人设是视图，不是第二套事实 |
| [dsh-memory-l2-l3-readiness.md](design/dsh-memory-l2-l3-readiness.md) | L2/L3 纯函数就绪度（未接线） |
| [write-gate/](design/write-gate/) | 阶段 1 写入门禁：Rev.1–Rev.9 与 M1 计划 |

当前写入门禁以 [Rev.9](design/write-gate/phase1-write-gate-design-rev9.md) 和 [M1 计划](design/write-gate/phase1-m1-write-path-plan.md) 为准；更早修订稿保留作演进记录。

## status — 状态与审计

| 文件 | 说明 |
|---|---|
| [dsh-memory-v2-progress.md](status/dsh-memory-v2-progress.md) | 按迭代记录的已验证进度 |
| [dsh-memory-v2-status.md](status/dsh-memory-v2-status.md) | 交接用状态页（测试计数可能过期，以实际 `node --test` 为准） |
| [phase0-readonly-audit.md](status/phase0-readonly-audit.md) | 2026-10-29 只读审计（414 项测试基线） |
| [dsh-memory-plugin-report.md](status/dsh-memory-plugin-report.md) | 2026-10-28 插件快照，**已过时**（仍写 Host 为空） |

## ops — 运维与验收

| 文件 | 说明 |
|---|---|
| [dsh-memory-phase4-acceptance.md](ops/dsh-memory-phase4-acceptance.md) | 隔离宿主验收步骤 |
| [dsh-memory-injection.example.json](ops/dsh-memory-injection.example.json) | 注入夹具示例 |
