# M7: 规则完整性与确定性输出加固

状态：已规划，等待显式启动
规划基线：main@fdf7874c0df85609d7400428f7534bd0a7d1bc22
目标：关闭 M6 fixed-SHA review 中确认但不阻塞交付的输入完整性与可复现性债务，同时
保持首版的 local-first、read-only 和 evidence-first 边界。

## 决策

M7 不是新的领域适配器里程碑。它只加固已经交付的 M6 rules、check report 和 workspace
report 契约，拆成两个串行的纵向切片：

1. M7-01：规则目录输入完整性；
2. M7-02：确定性输出原语与 glob 回归护栏。

将 Hugo/static site、CSV/report lineage、media pipeline、Codex skills/plugins、CI/CD 或其他
语言适配器保留给后续独立里程碑。这样不会把一个真实的 fail-closed 修复混入新的产品能力。

## M7-01：规则目录输入完整性

### 用户可见契约

- `.archmap/rules` 缺失时仍表示零条规则。
- 规则文档只允许小写 `.yaml` 和 `.yml` 扩展名；两者使用同一份 v1 schema、路径 glob 和
  duplicate-id 规则。
- 一旦规则目录存在，任意非规则目录项都使 `archmap check` 失败关闭：未知扩展名、目录、
  symlink、非普通文件、大小写错误扩展名和隐藏占位文件都不能被静默忽略。
- 所有规则条目都经现有的逐段 `lstat` 与 `O_NOFOLLOW` 边界读取。错误返回 exit `2`，stdout
  为空，不写 cache、report 或 tracked artifact。
- 错误消息的 source 一律是实际目录项名称；跨 `.yaml` / `.yml` 的重复 rule id 仍被拒绝。

### 允许的实现面

- `src/store.ts`：严格枚举和边界安全读取；
- `src/check/rules.ts`：统一 rule-source 错误与 deterministic rule 顺序；
- `test/cli-check.test.ts`；
- `docs/m6-check.md` 与 M7 文档。

### 非目标

- 不增加 required-hop、allow、外部集成或运行时规则；
- 不修改 `check` 的 warning / strict / stale exit 语义；
- 不修改 CI workflow、workspace 语义、依赖或扫描器。

### 最小验证矩阵

- `.yml` 规则被加载并与 `.yaml` 等价；
- 未知扩展名、目录和所有 symlink 形态均 exit `2`、stdout 为空、仓库字节不变；
- 跨扩展名 duplicate id 被拒绝；
- malformed accepted-extension document 仍由现有 schema 路径失败关闭；
- 真实 CLI binary 与 command seam 都覆盖关键路径。

### 风险与评审

Tier C：该切片改变策略发现的 fail-closed 边界。实现者停在未提交 review 边界；Codex
在 final head 运行目标矩阵和一次 issue gate。最终 M7 范围必须进行 fixed-SHA 独立审阅。

## M7-02：确定性输出原语与 glob 回归护栏

### 用户可见契约

- M6 的公开 `check` JSON/Markdown 排序与 workspace 聚合顺序采用显式、locale-independent
  的 UTF-16 code-unit 比较，和 canonical JSON 的键排序模型一致。
- M7 只迁移 M6 对外可观察的 rule、violation 和 workspace member 顺序；不会借此做全仓
  `localeCompare` 机械替换。
- check 与 workspace Markdown 共用一个纯函数：先 JSON quote 动态值，再选比内容中最长
  backtick run 多一位的 delimiter。换行、控制字符、反引号和标签文本必须保持 inert。
- `*` 只匹配一个 path segment 内的字符；`**` 仅作为完整 segment，匹配零个或多个 segment。
  这些语义拥有直接单元测试，而不只依赖 CLI 集成测试。

### 允许的实现面

- 新的无副作用 markdown-formatting / stable-comparison helper；
- `src/check/format.ts`、`src/check/rules.ts`、`src/check/evaluate.ts`；
- `src/cli/workspace-command.ts`、`src/workspace/index.ts`；
- 直接单测及现有 check/workspace 公共 CLI 测试；
- 与输出契约相关的文档。

### 非目标

- 不改变 tracked model 的历史排序策略或重写全部现有 `localeCompare` 调用；
- 不删除已导出的 `paths` 字段，除非单独确认外部 API 兼容性；
- 不把 check 的双 baseline read 优化混入此切片。该问题涉及并发 tracked-byte 一致性，
  需要先有独立的性能与事务设计。

### 最小验证矩阵

- 非 ASCII、大小写、NUL 分隔 key 的 comparator 顺序有直接断言；
- rule / violation / workspace member 输出在不同输入排列下字节稳定；
- 两种 Markdown 输出都复用相同的恶意 backtick / tag / control-character fixture；
- glob 覆盖多 `*` 回溯、尾部 `*`、`**` 零段与多段、以及拒绝的 glob grammar；
- 既有 workspace cache-delete rebuild、member byte-preservation 与 M6 exit tests 不回归。

### 风险与评审

Tier B：公开报告的字节顺序与 formatting helper 改动。若 M7-01 修复后没有新的安全或契约
finding，则它复用 M7 的最终 fixed-SHA review，而不是单独再审。

## 执行顺序与冻结方式

1. 创建一个 M7 integration branch，仅在 tracker 激活后创建；
2. M7-01 从稳定基线进入独立工作树；其 write / lease set 仅为 rules/store/check tests/docs；
3. M7-01 精确 head CI 通过后才整合到 M7 integration branch；
4. M7-02 以整合后的 head 为固定 base，在独立工作树完成；
5. M7-02 CI 通过后形成唯一的 final M7 review range；
6. Codex 运行一次 milestone gate，Claude 对 stable-base 到 final-head 做 fixed-SHA review；
7. 只有 review verdict 与用户明确交付授权都具备时，才 expected-head 合并到 main。

每个 issue 的 base、branch、worktree、write set、lease set、验证责任、非目标和 action id
在 GitHub lane checkpoint 中冻结；实现者一律在未提交 review 边界停止。

## M7 exit criteria

- M7-01 与 M7-02 的聚焦矩阵、typecheck、lint、build、`git diff --check` 成功；
- final M7 candidate 的完整测试、精确 CI 与 fixed-SHA review 成功；
- 规则目录的未知输入不会再静默降低 policy coverage；
- M6 public report ordering 与 Markdown inline-code 安全行为有直接回归护栏；
- stable main 的 merge tree 与 reviewed final head 一致，随后仅运行目标 smoke。

## 明确延后项

- 新规则家族、adapter、远程上传、CI workflow 写入；
- broad repository-wide locale migration；
- check 的 baseline 读取次数 / 并发一致性重构；
- 删除或重命名可能被外部调用的 store exports；
- 对真实外部仓库或性能 SLO 做未经设计的声明。
