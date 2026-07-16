# Post-v1 真实仓库试点 scorecard 模板

本模板记录一个固定真实仓库试点的可复核、脱敏结论。填写时不粘贴目标源码、完整路径清单、
原始 CLI JSON、`.archmap/` 内容、secret、账号、客户资料或未公开业务文本。

## 1. 身份与可复现输入

| 字段 | 值 |
| --- | --- |
| ArchMap commit / CLI build | |
| 目标别名 | |
| 目标 commit | |
| 试点日期与执行者 | |
| staging 方式 | local non-recursive disposable clone |
| source worktree 前后状态 | clean / unchanged |
| target-specific exclusions | 无 / 已列出（仅描述类别） |

## 2. 安全与保留审计

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| source worktree 未运行 writer | pass / fail | |
| 目标 `.archmap/` 仅存在于临时副本 | pass / fail | |
| 未初始化 submodule | pass / fail | |
| 原始模型、JSON、路径清单未进入 ArchMap Git/GitHub | pass / fail | |
| 临时副本与证据目录已清理 | pass / fail | |

## 3. 扫描与 capability 观察

| 项目 | 观察值 | 解释边界 |
| --- | --- | --- |
| Git / Python 环境 | | 记录 capabilities 输出的结论，不根据猜测补全 |
| 支持的 adapter | | |
| 明确未支持的 adapter | | 不将其语义记为 deterministic |
| 文件数 / 节点数 / 排除计数 | | 仅计数，不复制路径列表 |
| 首次扫描耗时 | | 观察值，不是性能 SLO |
| 无变化重扫 | pass / fail | `.archmap` byte-diff 是否为空 |
| clean `status` / `check` | pass / fail | 两者预期 exit `0` |
| stale probe | pass / fail | 修改临时副本时两者预期 exit `1`，恢复后 clean |

## 4. 关系抽样（10–15 条）

抽样覆盖每个实际报告为 supported 的能力，并至少包含一个预期 `partial` 或未支持边界。
它不是总体 precision/recall 声明。

| # | 关系类别 | 预期 certainty / 边界 | 人工判定 | 结果 | 备注（脱敏） |
| --- | --- | --- | --- | --- | --- |
| 1 | | | known / partial / unknown | true / false / inconclusive | |
| 2 | | | | | |
| 3 | | | | | |
| … | | | | | |

汇总：真阳性 `__`；假阳性 `__`；无法判定 `__`；未测的语义 `__`。

## 5. 两个真实任务的效用

| 任务 | 使用的命令/投影 | 人工判断 | 证据与局限（脱敏） |
| --- | --- | --- | --- |
| 找到某个维护任务的最小上下文 | `context` / `search` / `evidence` | useful / partial / not useful | |
| 判断某个受控文件变更的影响 | `impact` / `status` / `check` | useful / partial / not useful | |

## 6. 明确局限与下一步决策

- 未支持或未评测：
- 发现的确定性误报 / 漏报（如有）：
- 是否需要单独的 adapter、性能或安全 issue：
- 结论：`ready for another bounded pilot` / `needs targeted repair` / `stop and redesign`。

只有这个脱敏 scorecard 与必要的高层命令结果摘要可以提交。目标仓库源码、模型文件、完整
路径、原始输出和临时目录不得作为交付物保存。
