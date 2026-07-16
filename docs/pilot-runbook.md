# Post-v1 真实仓库试点运行手册

本手册用于验证已交付的 ArchMap CLI 在一个固定、本地 Git 仓库上的真实工作能力。它
不是性能基准、支持矩阵承诺，也不授权新增分析器、上传数据、修改源仓库或将目标源码
带回 ArchMap 仓库。

## 1. 冻结输入与结论边界

首个试点固定为：

| 输入 | 固定值 / 要求 |
| --- | --- |
| ArchMap 工具基线 | `main@52aea572af9a35a756496a80cd1562a6b9c6e82e` |
| 目标 | AtypicalLifeClub |
| 目标提交 | `241bcd10fbbee2c9f6220e5af33d874021fbe9d6` |
| 工作方式 | 本机 `/private/tmp` 下的一次性、non-recursive local clone |
| 可观察输入 | Markdown、配置/JSON 数据、Python 校验、静态 JS 的现有静态证据 |
| 不评测项 | Hugo/Go-template 运行语义、媒体/二进制、部署/CI 行为、未初始化 theme submodule |

试点只能说明这个固定输入上的观察结果。任何 `partial`/`unknown` 或未支持 capability
都必须保持原样，不能被人工解释成确定性关系。

## 2. 安全与数据保留硬约束

1. **不在 source worktree 运行 `init` 或 `scan`。** 两个命令会写入 `.archmap/`。
2. 只从 source 的干净、固定提交创建临时 clone；不要使用普通目录复制，也不要初始化
   submodule。普通复制不能保留可核验的 Git checkout 与 gitlink 形状，会改变要测的仓库
   边界。
3. 默认 secret 排除基于文件名模式；它不是完整的内容级 DLP。运行前必须人工确认目标允许
   在本机临时副本中处理；必要时先在副本的 `project.yaml` 增加项目专属排除项。
4. 所有原始 JSON、`.archmap/` 文件、完整路径清单和命令输出只留在临时证据目录；不得
   添加到 ArchMap Git、GitHub issue、PR 或聊天摘要。
5. 最终只提交按 [pilot-scorecard](./pilot-scorecard.md) 脱敏后的计数、抽样结论、局限和
   决策。

## 3. 预检与隔离 staging

以下变量必须指向本机绝对路径；`SOURCE` 是现有工作树，`PILOT_ROOT` 和
`EVIDENCE_DIR` 是本次唯一可写目录。

```sh
ARCHMAP_ROOT=/absolute/path/to/archmap
SOURCE=/absolute/path/to/AtypicalLifeClub
TARGET_SHA=241bcd10fbbee2c9f6220e5af33d874021fbe9d6
PILOT_ROOT="$(mktemp -d /private/tmp/archmap-pilot-atypical.XXXXXX)"
EVIDENCE_DIR="$(mktemp -d /private/tmp/archmap-pilot-evidence.XXXXXX)"

test -z "$(git -C "$SOURCE" status --porcelain)"
test "$(git -C "$SOURCE" rev-parse HEAD)" = "$TARGET_SHA"

# Do not pass --recurse-submodules. --no-local avoids a hard-linked source copy.
git clone --no-local --no-checkout "$SOURCE" "$PILOT_ROOT"
git -C "$PILOT_ROOT" checkout --detach "$TARGET_SHA"
git -C "$PILOT_ROOT" submodule status > "$EVIDENCE_DIR/submodules.txt"
test "$(git -C "$PILOT_ROOT" rev-parse HEAD)" = "$TARGET_SHA"
```

clone 创建后 source 的 `git status --porcelain` 仍必须为空。否则停止并丢弃临时 clone；
不得通过修复 source worktree 来继续试点。

## 4. Read-only discovery before model writes

`capabilities` is safe before initialization and records the actual adapter environment. The
optional lower-level no-write discovery probe in [m3-exit.md](./m3-exit.md#manual-read-only-trial-on-another-repository)
may be run against `SOURCE` first; it must not call `init`, `scan`, or store writers.

For the full CLI pilot, define a command wrapper that always executes in the temporary clone:

```sh
archmap() {
  (cd "$PILOT_ROOT" && node "$ARCHMAP_ROOT/dist/cli/bin.js" "$@")
}

archmap capabilities --json > "$EVIDENCE_DIR/capabilities.json"
```

Record supported and unsupported adapters exactly as reported. Do not make a capability promise
from file extensions or from the target's README.

## 5. Initialized-model baseline in the temporary clone

Only after the previous steps pass may the temporary clone receive a model:

```sh
archmap init --json > "$EVIDENCE_DIR/init.json"
sed -n '1,220p' "$PILOT_ROOT/.archmap/project.yaml"
# Review and, only if required, edit this disposable config to add target-specific exclusions.

archmap scan --json > "$EVIDENCE_DIR/scan-first.json"
archmap status --json > "$EVIDENCE_DIR/status-clean.json"
archmap check --json > "$EVIDENCE_DIR/check-clean.json"

cp -R "$PILOT_ROOT/.archmap" "$EVIDENCE_DIR/archmap-first"
archmap scan --json > "$EVIDENCE_DIR/scan-repeat.json"
diff -r "$EVIDENCE_DIR/archmap-first" "$PILOT_ROOT/.archmap"
```

The clean `status` and `check` commands must exit `0`; the repeated-scan diff must be empty.
The scorecard records file/node/exclusion counts and elapsed time as observations, not an SLO.

## 6. Stale, context, impact, and human review

只在检查 baseline 后选择一个已跟踪、非 secret、非生成的 **Markdown 文档**。将
`MUTATION_PATH` 设为该相对路径，再只在临时 clone 中附加可逆的 HTML 注释标记；不要把
该标记写入 Python、JSON 或 JS。标记存在时 `status --json` 与 `check --json` 都必须 exit
`1`；恢复文件后再要求 ArchMap status 为 clean。

```sh
MUTATION_PATH=path/chosen-after-baseline-review
cp "$PILOT_ROOT/$MUTATION_PATH" "$EVIDENCE_DIR/mutation-before"
printf '\n<!-- archmap pilot stale probe -->\n' >> "$PILOT_ROOT/$MUTATION_PATH"

set +e
archmap status --json > "$EVIDENCE_DIR/status-stale.json"
status_exit=$?
archmap check --json > "$EVIDENCE_DIR/check-stale.json"
check_exit=$?
set -e
test "$status_exit" -eq 1
test "$check_exit" -eq 1

mv "$EVIDENCE_DIR/mutation-before" "$PILOT_ROOT/$MUTATION_PATH"
archmap status --json > "$EVIDENCE_DIR/status-restored.json"

archmap context "$MUTATION_PATH" --json > "$EVIDENCE_DIR/context.json"
archmap impact "$MUTATION_PATH" --json > "$EVIDENCE_DIR/impact.json"
```

Use the scorecard to review two real questions and 10–15 deliberately selected relations across
the reported capabilities. Inspect `node`/`evidence` only within the temporary directory. Viewer
testing is optional: the documented default-view readability budget is not a pass criterion for a
large repository.

## 7. Closeout

在产出脱敏 scorecard 前，重新确认 source 的 `git status --porcelain` 为空，并确认临时
clone 没有已跟踪文件的改动：

```sh
test -z "$(git -C "$SOURCE" status --porcelain)"
git -C "$PILOT_ROOT" diff --exit-code "$TARGET_SHA"
git -C "$PILOT_ROOT" diff --cached --exit-code "$TARGET_SHA"
```

临时 clone 中的 `.archmap/` 是预期的 disposable 生成物，不能把它误报为 source 变更。
临时证据只保留到人工审计完成，随后只删除两个明确创建的
`/private/tmp/archmap-pilot-*` 目录；不得在这个前缀之外使用通配删除。最终 issue/PR
只包含 scorecard，不包含目标 clone 或其 `.archmap` 内容。
