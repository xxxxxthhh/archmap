# AtypicalLifeClub：post-v1 真实仓库试点（脱敏 scorecard）

状态：已完成
试点日期：`2026-07-17`
结论：`ready for another bounded pilot`

本记录只保留可复核的聚合结论。它不包含目标源码、路径、标题、模型文档、原始 CLI
JSON、证据哈希、临时目录或任何原始试点工件。

## 1. 固定输入与安全边界

| 字段 | 值 |
| --- | --- |
| ArchMap 工具基线 | `fb781b69ec3bccd2a6d49b826aed0797c3866fc3` |
| 目标别名 | AtypicalLifeClub |
| 目标提交 | `241bcd10fbbee2c9f6220e5af33d874021fbe9d6` |
| staging | local non-recursive disposable clone；未初始化 submodule |
| 评测输入 | Markdown、配置/JSON、Python、静态 JS 的静态证据 |
| 不评测项 | Hugo/Go-template 运行语义、媒体/二进制、部署/CI 行为、未初始化 submodule |

- source worktree 在 clone 前后均为 clean，且未运行 writer；
- `.archmap/` 只在 disposable clone 中生成；
- 原始模型、路径清单和 CLI 输出只保留在临时证据目录，人工审计后已删除；
- 固定样本的 Gitlink 作为非普通文件未进入扫描文件计数，符合试点的 submodule 边界。

## 2. capability 与扫描观察

`capabilities` 报告 universal、TypeScript、Python、Markdown 和 data adapter 为 supported。
这表示当前工具环境可产生相应静态证据，不是对目标中未评测运行时语义的支持承诺。

| 观察项 | 结果 |
| --- | --- |
| 首次扫描 | 233 个普通文件、382 个节点、438 条关系；real time `3.31s` |
| 排除 | 0（secret、过大、binary、symlink、目录） |
| 关系类型 | `calls` 3、`imports` 163、`depends-on` 272 |
| certainty | `known` 141、`partial` 297 |
| clean `status` / `check` | 两者 exit `0`，无 violation |
| 无变化重扫 | `.archmap/` byte-diff 为空 |
| stale probe | 临时 Markdown 修改时两者 exit `1`；恢复后 status clean |

约 68% 的关系保持为 `partial`。这是正确的保守边界：试点没有把外部调用、外部引用或
无法完整解析的依赖升级成确定性事实。

## 3. 关系抽样（12 条）

抽样按实际输出的三种关系类型和 certainty 边界选择，不是总体 precision/recall 声明。

| 抽样面 | 数量 | 人工结构核验 |
| --- | ---: | --- |
| `calls` / `partial` | 3 | 3/3 的 source marker 与证据哈希匹配 |
| `imports`（2 known、1 partial） | 3 | 3/3 的 source marker 与证据哈希匹配 |
| `depends-on` / `partial` | 6 | 6/6 的 source marker 与证据哈希匹配 |
| 合计 | 12 | 12/12 通过；0 个结构性反例 |

抽样覆盖静态 JS 外部调用、Python import/数据依赖和 Markdown 外部引用。该核验只说明
所选关系的证据绑定与源标记一致；未把 12 条样本外推为全仓精确率。

## 4. 两个真实任务的效用

| 任务 | 结果 | 人工判断 |
| --- | --- | --- |
| 为一个可复用的报告处理模块寻找最小维护上下文 | `context` 在 2,000 token budget 中返回 4 个节点、1,017 used tokens、0 omitted，并包含预期 importer 与层级上下文 | useful |
| 判断该模块受控变更的影响 | `impact` 返回 2 个 seed、4 个 impacted 节点，包含预期 importer 与一个传递 import 关系 | useful |

这两个判断针对固定样本中的具体维护路径。它们证明当前投影在小范围静态任务上可用，不等同于
对跨运行时、部署或大规模图可读性的承诺。

## 5. 局限与下一步

- 这是一个固定提交、单一样本的本地试点，不是性能 SLO，也不是多仓库支持矩阵；
- 未测的 Hugo/Go-template、媒体、二进制、部署、CI 和 submodule 语义仍然不支持或未声明；
- `partial` 关系占多数，使用者必须继续把 certainty 当作决策边界；
- 本轮未发现需要立即修复的确定性产品 defect。

下一步应选择一个语言、框架或结构不同的 bounded pilot；若出现可复现的具体 finding，
应先以独立 issue 冻结契约，而不是把修复混入试点评估。
