# 阶段 1：正式记忆写入门禁

范围：Git 账本的写入安全边界。不处理 localStorage 双权威、workspace 隔离、向量检索。

| 文件 | 角色 |
|---|---|
| [phase1-write-gate-design.md](phase1-write-gate-design.md) | Rev.1 评审稿 |
| [phase1-write-gate-design-rev2.md](phase1-write-gate-design-rev2.md) … [rev8](phase1-write-gate-design-rev8.md) | 中间修订，保留不改 |
| [phase1-write-gate-design-rev9.md](phase1-write-gate-design-rev9.md) | **当前设计** |
| [phase1-m1-write-path-plan.md](phase1-m1-write-path-plan.md) | 按 Rev.9 做的最小写入链路计划 |

依据：[阶段 0 只读审计](../../status/phase0-readonly-audit.md)。
