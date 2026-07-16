# archmap 实施计划

状态：M0–M7 已完成；进入 post-v1 真实仓库试点准备

日期：`2026-07-17`

当前阶段：先冻结真实仓库试点的安全边界与评测协议，再执行一个隔离的本地试点。

## 1. 产品定义

`archmap` 是一个面向编码 Agent 和开发者的本地优先代码库地图。它将源码、配置、
文档和 Git 历史转化为可查询、可验证、可增量维护的架构知识模型。

它要解决的不是“如何快速生成一张漂亮的架构图”，而是以下问题：

1. 一个架构结论由哪些源码事实支撑？
2. 当前代码变化影响哪些组件、流程、规则和文档？
3. 哪些架构信息仍然可信，哪些已经过期？
4. Agent 完成当前任务最少需要读取哪些上下文？
5. 人工确认的架构决策是否被新代码违反？

可视化是核心体验之一，但它是知识模型的动态投影，不是独立事实来源。

## 2. 第一版完成标准

首个可用版本应当能够在一个本地 Git 仓库中完成下面的闭环：

```text
初始化项目
  -> 扫描确定性事实
  -> 构建本地索引
  -> 查看架构与证据
  -> 修改代码
  -> 识别受影响和过期节点
  -> 为 Agent 提供最小上下文
  -> 校验并应用架构更新
  -> 在 CI 中检查架构状态
```

首版必须满足：

- 相同输入和相同分析器版本产生相同事实结果；
- 所有 `fact` 都带可重新验证的证据；
- AI 推理与确定性事实在数据层和 UI 中明确区分；
- 人工决策默认不可被 AI 覆盖；
- 代码变化后可以立即标记受影响节点，无需自动调用模型；
- 不支持或无法确定的关系必须显示为 `partial` 或 `unknown`；
- Viewer、CLI 和 MCP 读取同一个模型；
- 整个核心工作流离线可用，不依赖云服务。

## 3. 设计原则

### 3.1 Facts、Interpretations、Decisions 分层

| 层 | 来源 | 更新方式 | AI 权限 |
| --- | --- | --- | --- |
| Facts | 静态分析、配置解析、Git | 扫描器重建 | 只读 |
| Interpretations | AI 或人工推理 | 证据支持的 proposal | 可提议更新 |
| Decisions | 人工确认的约束和 ADR | 人工修改或批准 | 不可自动覆盖 |

### 3.2 Evidence first

每条事实、推理和关系都应能回答：

- 来源文件是什么；
- 对应 symbol 是什么；
- 基于哪个 commit 和 blob；
- 使用哪个分析器版本；
- 当前证据是否仍然有效。

行号只用于展示，不作为长期身份。长期身份优先使用 repository、blob、path、symbol
和内容 hash。

### 3.3 模型是事实来源，图是投影

AI 不直接写 Mermaid。系统保存结构化节点和关系，再生成：

- 交互式架构图；
- 请求和数据流；
- 变更影响图；
- Mermaid、SVG 和 Markdown 导出；
- PR/CI 报告。

### 3.4 Local first

- 仓库知识随 Git 版本管理；
- 派生缓存可随时删除和重建；
- 首版没有账户、组织、云同步或托管服务；
- 远程能力以后作为明确启用的独立模块评估。

### 3.5 Graceful degradation

每个适配器公开能力和置信等级。未支持某种语言或框架时，通用 Git、文件、文档和
变更能力仍然可用；系统不得把 AI 猜测伪装成静态分析结果。

## 4. 目标用户与关键场景

### 4.1 编码 Agent

- 修改代码前请求任务相关的最小上下文；
- 查询一个文件属于哪些架构节点；
- 预测修改的上下游影响；
- 获取约束、风险和已知决策；
- 修改后提交结构化架构更新提案。

### 4.2 开发者和 Reviewer

- 浏览可展开的架构地图；
- 点击节点或关系查看源码证据；
- 比较两个 commit 的架构变化；
- 查看 PR 引入的新依赖、外部集成和规则违反；
- 判断文档是否已经落后于代码。

### 4.3 多仓库工作区

- 每个 repo 独立维护自己的 `.archmap/`；
- workspace 层只聚合可重建索引；
- 支持跨 repo 的 `uses-skill-from`、`publishes-to`、`consumes` 等显式关系；
- 不建立必须在线的中央事实数据库。

## 5. 系统架构

```text
Source / Config / Docs / Git
            |
            v
    Deterministic adapters
            |
            v
        Fact graph ---------> Change and invalidation engine
            |                              |
            |                              v
            |                       Stale work items
            |                              |
            v                              v
      Evidence bundles ------------> Agent synthesis
                                           |
                                           v
                                    Structured proposal
                                           |
                                           v
                              Schema / evidence / policy validation
                                           |
                                           v
                                  Versioned knowledge model
                                           |
                       +-------------------+-------------------+
                       |                   |                   |
                      CLI                 MCP              Viewer / CI
```

### 5.1 核心模块

1. **Repository discovery**：识别 Git、workspace、manifest、语言和适配器。
2. **Adapter runtime**：运行通用、语言、框架和领域适配器。
3. **Fact graph**：保存节点、关系、证据、能力和不确定性。
4. **Invalidation engine**：从 Git diff 和 evidence hash 计算失效传播。
5. **Knowledge model**：保存 AI interpretations、human decisions 和 views。
6. **Proposal engine**：验证并原子应用 Agent 更新。
7. **Query engine**：为 CLI、MCP、Viewer 和 CI 提供统一查询。
8. **Renderer**：从查询结果生成交互图和静态导出。

## 6. 数据与存储

### 6.1 仓库跟踪内容

```text
.archmap/
├── project.yaml
├── snapshot.yaml
├── nodes/
│   └── <stable-id>.yaml
├── views/
│   └── <view-id>.yaml
├── decisions/
│   └── <decision-id>.md
├── rules/
│   └── <rule-set>.yaml
└── migrations/
```

### 6.2 本地派生内容

```text
.archmap/cache/
├── graph.db
├── adapters.json
└── evidence-index/
```

缓存不提交 Git。删除缓存后必须能从仓库内容和源码重新构建。

### 6.3 节点最小模型

节点必须具有稳定内部 ID，显示 slug 可以重命名：

```yaml
schema_version: 1
id: node_01JAUTH
slug: auth-service
kind: component
title: Auth Service
scope:
  files:
    - src/auth/**
  symbols:
    - AuthService
claims: []
relations: []
```

### 6.4 Claim 与 Evidence

```yaml
claims:
  - id: claim_01
    type: inference
    text: This component is the primary authentication boundary.
    status: active
    confidence: 0.88
    provenance:
      actor: agent
      model: optional-model-id
      created_at: 2026-07-13T00:00:00Z
    evidence:
      - repository: local
        commit: 38ccdb6
        path: src/auth/service.ts
        symbol: verifySession
        blob_hash: sha256:example
        extract_hash: sha256:example
```

`fact` 的 confidence 代表解析完备性，不表示主观概率。`inference` 的 confidence 才表示
推理置信度。

## 7. 适配器架构

所有适配器遵循统一能力接口：

```ts
interface ArchmapAdapter {
  id: string;
  detect(context: RepoContext): CapabilityReport;
  discover(context: RepoContext): Promise<Artifact[]>;
  extractFacts(artifacts: Artifact[]): Promise<FactBatch>;
  resolveRelations(facts: FactBatch): Promise<RelationBatch>;
  validateEvidence(evidence: Evidence): Promise<ValidationResult>;
}
```

### 7.1 首批适配器

1. **Universal**：Git、目录、manifest、文件类型、文档链接、配置和变更。
2. **TypeScript/JavaScript**：symbol、import/export、入口、CLI、route、外部请求。
3. **Python**：module、symbol、import、CLI、route、数据读写和测试映射。
4. **Markdown/YAML/JSON**：文档、配置、ledger、引用和结构化资产。

### 7.2 后续领域适配器

- Hugo/static site；
- 数据血缘和 CSV/report pipeline；
- media pipeline；
- Codex skills/plugins；
- CI/CD 和 infrastructure；
- 其他语言。

## 8. 公共接口

### 8.1 CLI

首版目标接口：

```bash
archmap init
archmap scan [--changed]
archmap status [--json]
archmap capabilities [--json]
archmap context <path...> [--budget <tokens>] [--json]
archmap impact <path...> [--base <ref>] [--json]
archmap search <query> [--json]
archmap evidence <node-or-claim> [--json]
archmap diff <base> [head]
archmap check [--strict] [--json]
archmap serve [--port <port>]
```

所有机器可消费命令必须有稳定的 JSON 输出和显式 schema version。核心库不通过
`process.exit()` 表达领域错误；CLI 层负责将结构化错误映射为退出码。

### 8.2 MCP

目标工具：

```text
project_summary
context_for_files
impact_analysis
search_architecture
get_node
get_evidence
list_stale_nodes
get_update_work_items
propose_update
validate_proposal
apply_proposal
```

MCP 是 Agent 的一等接口，Skill 只负责编排工作流，不复制领域逻辑。

### 8.3 Proposal 事务

Agent 更新采用：

```text
build proposal -> validate -> preview diff -> atomic apply
```

禁止通过一连串独立写命令留下半完成状态。人工 decision 发生冲突时，proposal 必须
停在待批准状态。

## 9. 可视化计划

第一版 Viewer 包含：

1. 可展开的总体架构图；
2. 节点和关系的证据侧栏；
3. 工作区变更影响高亮；
4. commit-to-commit 架构 diff；
5. stale、partial、inference 和 violation 状态；
6. 按关系类型、证据来源和置信度过滤。

视图保存查询和布局偏好，不保存 AI 编写的 Mermaid：

```yaml
id: overall-architecture
include:
  node_kinds: [system, component, external, store]
  edge_types: [calls, reads, writes, publishes]
collapse_below: component
layout: left-to-right
```

Viewer 的安全基线：

- 只监听 loopback；
- 静态资源本地打包并固定版本；
- 不执行仓库中的 HTML 或脚本；
- CSP 和内容清洗默认启用；
- 不开放任意跨域读取；
- Viewer 只读，写入通过经过验证的 proposal API。

## 10. 架构规则

规则作为人工 decision 的可执行表达：

```yaml
id: ui-must-not-access-db
severity: error
from:
  path: src/ui/**
disallow:
  edge_type: imports
  target:
    path: src/db/**
```

`archmap check` 第一版检查：

- schema 与引用完整性；
- evidence 是否仍然有效；
- stale 状态；
- 禁止依赖；
- 必经节点；
- 新增外部集成；
- unsupported/partial 能力是否被错误提升为确定事实。

## 11. 技术方向

当前默认方向，M0 spike 后锁定：

- Core、CLI、MCP：TypeScript；
- 包管理：npm；
- TS/JS 分析：TypeScript Compiler API；
- 多语言语法层：Tree-sitter 或语言原生 worker，由 spike 比较；
- Git 跟踪格式：YAML、Markdown、JSON Schema；
- 派生查询：SQLite；
- Viewer：浏览器端交互图，具体图库在视觉 tracer bullet 中选择；
- 测试：单元、fixture、golden、CLI 集成和浏览器测试分层。

SQLite 驱动、Python 分析进程边界和 Viewer 图形库仍是可逆决策，不在计划阶段过早锁死。

## 12. 实施里程碑

每个里程碑都是可独立验证的纵向切片。进入下一阶段前必须满足 exit criteria。

### M0：工程与 Schema 契约

交付：

- TypeScript package、CLI 和测试框架；
- schema versioning 与 migration seam；
- Node、Relation、Claim、Evidence、Capability 的 schema；
- 最小 fixture repo 和 golden manifest；
- `archmap validate <manifest>`；
- test、typecheck、lint、build CI。

Exit criteria：

- 合法 fixture 可以 round-trip 而不丢字段；
- 非法引用和无证据 fact 被拒绝；
- 相同 fixture 产生字节稳定的规范化输出；
- 新 clone 可以通过一条标准命令完成全部验证。

### M1：Universal Scanner 闭环

交付：

- `init`、`scan`、`status`、`capabilities`；
- Git、文件、manifest、文档和配置发现；
- 本地派生图索引；
- snapshot、blob hash 和基础 stale 检测；
- 通用 repository structure 输出。

Exit criteria：

- 任意 Git repo 均可运行，不支持的能力明确报告；
- 连续两次无变化扫描不产生 tracked diff；
- 修改、重命名和删除文件后 stale 状态正确；
- vendor、build、secret 和大文件规则有安全默认值。

### M2：TypeScript/JavaScript 纵向切片

交付：

- module、symbol、import/export、entry point；
- CLI command、常见 route 和外部 HTTP 调用；
- `context`、`impact` 和 `evidence`；
- TS/JS fixture 与真实仓库只读试验。

Exit criteria：

- fixture 的模块和 import 关系达到预定义 golden 结果；
- 每条关系均可导航到证据；
- 单文件修改只失效相关节点和父级视图；
- Agent context 有预算上限并能解释选取原因。

### M3：Python 与文档/数据切片

交付：

- Python module、symbol、import、CLI、route、测试映射；
- Markdown 链接、结构、decision 和 ledger 资产；
- YAML/JSON 配置与数据输入输出关系；
- Python、数据和 Markdown-first fixture。

Exit criteria：

- Python 和文档仓库均可生成有意义的非代码节点；
- 数据来源、转换和报告关系带证据；
- 解析不确定的动态关系不会被标成确定事实。

### M4：Agent Proposal 与 MCP

交付：

- Evidence bundle 和 stale work item；
- MCP 查询工具；
- propose、validate、preview、apply 事务；
- facts、interpretations、decisions 的权限隔离；
- 模型无关的 Agent 工作流。

Exit criteria：

- Agent 无法通过 proposal 修改 deterministic fact；
- 人工 decision 冲突需要显式批准；
- 中途失败不会留下部分写入；
- MCP 与 CLI 对同一查询返回语义等价结果。

### M5：交互式 Viewer

交付：

- 架构地图；
- evidence inspector；
- impact 和 diff 模式；
- stale、confidence、source 和 relation filters；
- SVG、Mermaid 和 Markdown 导出。

Exit criteria：

- 典型视图在合理节点数量下保持可读；
- 点击节点或边可到达源码证据；
- 浏览器测试覆盖导航、过滤、diff 和内容安全；
- Viewer 不需要网络连接且只监听 loopback。

### M6：Rules、CI 与跨仓库试点

交付：

- `check` 和架构规则；
- PR/CI Markdown 与 JSON 报告；
- workspace 聚合索引；
- 在 Web/content、Python/data、Markdown-first、media pipeline 四类 repo 上试点；
- 性能、准确性和人工修订量报告。

Exit criteria：

- 每类试点仓库都有明确 capability report；
- CI 可以区分 warning 和 blocking violation；
- workspace 缓存删除后可完全重建；
- 试点评测达到第 13 节的初始质量门槛。

M6 的交付证据是四个受控 fixture，而非真实外部仓库研究；这避免了在未冻结安全边界、
样本方法和能力声明时夸大结论。真实仓库验证作为 M7 合并后的 post-v1 阶段单独执行。

### M7：规则完整性与确定性输出加固

M7 是首版交付后的窄加固里程碑，不增加新的分析器、规则家族或领域适配器。它将 M6
review 留下的真实输入完整性风险和跨运行时排序风险收敛为明确、可执行的契约。

交付：

- 规则目录的严格发现契约：小写 `.yaml` 与 `.yml` 为唯一允许的规则文档；其他目录项
  失败关闭，不能静默跳过策略；
- `check` 与 workspace Markdown 输出共用安全的 inline-code formatter；
- M6 对外可观察排序使用 locale-independent 的比较器，并为 glob 语义建立直接单测；
- 一份将风险、非目标、切片顺序和最终验证绑定到 GitHub issue 的执行计划。

Exit criteria：

- 非法或未知的规则目录项返回 exit `2`、不产生 partial stdout、且不写入仓库；
- `.yml` 规则与 `.yaml` 规则具有相同的严格 schema / symlink / duplicate-id 边界；
- M6 `check` 与 workspace 的公开 JSON/Markdown 顺序不依赖 ICU locale；
- M7 仅以已验证的 final head 进入一次 fixed-SHA review，再合并到 stable `main`。

详细执行计划见 docs/m7-plan.md。

### Post-v1：真实仓库试点（验证阶段）

这不是 M8 功能里程碑。它以已合并的 stable `main` 为工具基线，在一个固定提交的本地
仓库副本中检验现有 CLI 的能力边界和实际任务价值，不新增分析器、规则家族、云服务或
CI workflow。

首个候选是 AtypicalLifeClub：它包含 Markdown、配置/JSON 数据、Python 校验和静态 JS，
同时将 Hugo/Go-template 语义、媒体/二进制、部署行为和未初始化 theme submodule 明确
列为不评测项。试点只能在 `/private/tmp` 中的 non-recursive disposable clone 运行；源
工作树、Git 元数据、远端分支和原始模型输出一律不改写、不提交。

Exit criteria：

- pilot 前锁定 ArchMap 与目标仓库提交、扫描配置、样本选择和停止条件；
- source worktree 全程不运行 writer，且前后 Git 状态均保持 clean；
- 临时副本的初始化、扫描、无变化重扫、status/check stale 路径均有可复核证据；
- capabilities 如实列出支持与不支持项，人工抽样不把未支持语义计为 deterministic；
- 两个真实上下文/影响问题有人工效用判断，结论与局限只以脱敏 scorecard 返回本仓库。

详细流程和 scorecard 分别见 `docs/pilot-runbook.md` 与 `docs/pilot-scorecard.md`。

## 13. 验证与评测

### 13.1 正确性

- 节点和文件归属 precision/recall；
- import、route、storage、external call 关系准确率；
- stale 传播漏报和误报；
- 多次扫描稳定性；
- rename 后身份保持率；
- AI interpretation 的证据覆盖率。

### 13.2 Agent 效率

- 完成相同任务时减少的初始探索文件数；
- context token 数；
- 找到正确入口和约束的时间；
- 因过期或错误架构导致的返工率。

### 13.3 初始质量门槛

- deterministic facts 的 evidence coverage：`100%`；
- 无变化重复扫描的 tracked diff：`0`；
- fixture 预期关系 precision：`>= 95%`；
- stale 关键路径漏报：`0`；
- 未支持能力被错误标为 deterministic：`0`；
- Viewer 内容安全回归：`100%` 通过。

性能目标在 M1 获得基线后设定，计划阶段不凭空指定不可信数字。

## 14. 安全与隐私

- 默认排除 `.git`、依赖、build、cache、binary 和超大文件；
- 采用 allowlist/denylist 与 secret pattern 双层过滤；
- evidence 默认保存指针和 hash，不复制大段源码；
- 日志和 JSON 输出不得包含 secret 内容；
- 插件/适配器声明读取范围和 capability；
- 外部进程和语言 worker 使用明确 argv，不拼接 shell 命令；
- 任何未来远程上传必须单独 threat model 和显式 opt-in。

## 15. 非目标

首版不做：

- 云账户、团队空间或托管服务；
- 自动提交、push 或修改业务源码；
- 完整运行时调用图；
- 所有语言和框架；
- 由 AI 直接维护 Mermaid；
- 3D 图、复杂动画和通用图形编辑器；
- 自动覆盖人工 decision；
- 未经用户请求自动调用付费模型；
- 把架构地图包装成未经验证的“代码真相”。

## 16. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 动态语言调用难以静态解析 | partial/unknown 状态，运行时适配器后置 |
| Schema 早期变化频繁 | version 字段、migration seam、golden fixtures |
| 图变大后不可读 | query-based views、分层聚合、过滤和语义缩放 |
| AI 输出不稳定 | evidence bundle、proposal schema、原子验证 |
| 文件重命名破坏身份 | 稳定 ID、Git rename、symbol/content hash 辅助匹配 |
| 扫描大型 repo 太慢 | 增量索引、adapter cache、按 capability 调度 |
| 领域适配器无限膨胀 | 小而稳定的 adapter interface，领域逻辑留在插件 |
| 架构资料泄露 | local-first、secret filtering、首版无云服务 |

## 17. 已锁定与待验证决策

### 已锁定

- 项目工作名：`archmap`；
- 独立仓库维护；
- TypeScript 核心；
- local-first；
- facts / interpretations / decisions 三层模型；
- evidence mandatory；
- CLI + MCP 为主要接口；
- Viewer 为模型投影；
- 首版不做云；
- `main` 为稳定线，一项功能一个短期分支。

### M0 spike 后锁定

- SQLite 具体驱动；
- Python 使用 Tree-sitter、语言原生 worker 或混合模式；
- Viewer 图形库；
- stable ID 的生成与 rename reconciliation 细节；
- tracked manifests 的 canonical formatting 策略。

## 18. 下一步：post-v1 真实仓库试点

下一步不是继续扩展分析器，而是先验证已交付版本在一个真实、固定的本地仓库中是否
能够提供可信且有用的架构证据：

1. 合并 pilot-readiness 文档切片，冻结工具提交、目标提交、临时目录和数据保留边界；
2. 从目标仓库创建 non-recursive disposable clone，源工作树保持只读；
3. 记录 capability、初始化/扫描、无变化重扫和 stale 检测证据；
4. 用两个具体任务和 10–15 条关系的人工抽样评估上下文与影响结果；
5. 仅提交脱敏 scorecard，随后依据真实 finding 决定是否需要独立的新能力里程碑。

这个阶段不通过试点结果倒推“所有仓库已支持”，也不把未评测的 Hugo、媒体、部署或
运行时行为包装为确定性事实。
