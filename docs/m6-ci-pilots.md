# M6 CI reports and fixture pilots

M6 does not add a CI workflow, remote uploader, or report writer. It makes the existing
read-only `archmap check` contract practical for a PR/CI job and records four self-contained
fixture pilots in `test/fixtures/m6-pilots/`. The fixtures are controlled acceptance evidence,
not claims that Archmap has scanned external production repositories.

## `check` report contract

`archmap check` writes deterministic Markdown suitable for a CI summary or PR body. Its
`--json` form is the stable machine report. Both forms describe the same result and have the
same exit status.

| Exit | Meaning in normal mode | CI treatment |
| --- | --- | --- |
| `0` | No violation, or only advisory warnings | Continue; retain both report forms. |
| `1` | A blocking rule violation or stale tracked model | Fail the quality gate. |
| `2` | Unsafe/malformed project model or rule input | Fail closed as CI/configuration input failure; no partial report is trustworthy. |

`--strict` promotes every warning to the same blocking exit `1`. It does not turn a
`partial` or `unknown` relation into a deterministic error: it only makes the already-visible
advisory result blocking for a conservative repository policy.

The following POSIX-shell pattern intentionally runs the read-only command twice: once for the
human summary and once for the machine file. It rejects output/status disagreement instead of
silently publishing mismatched evidence.

```sh
summary_path="${GITHUB_STEP_SUMMARY:-archmap-check.md}"

set +e
archmap check > "$summary_path"
markdown_status=$?
archmap check --json > archmap-check.json
json_status=$?
set -e

if [ "$markdown_status" -ne "$json_status" ]; then
  printf '%s\n' 'archmap check output/status disagreement' >&2
  exit 2
fi

case "$markdown_status" in
  0) ;;
  1) exit 1 ;;
  2) exit 2 ;;
  *) printf '%s\n' "unexpected archmap check exit: $markdown_status" >&2; exit 2 ;;
esac
```

For a strict gate, add `--strict` to both invocations. A CI system may retain
`archmap-check.json` using its own artifact mechanism; this document deliberately does not
choose or configure one. A PR can embed the Markdown summary and link its machine artifact
without reinterpreting violations.

## Workspace cache evidence

`archmap workspace index <member...> --json` writes only the owner project's disposable cache.
The M6-02 regression verifies a cache delete/rebuild produces byte-identical JSON and never
mutates member repositories. A caller may independently demonstrate that property with:

```sh
archmap workspace index services/api sites/docs --json > workspace-index.first.json
rm -f .archmap/cache/workspace-index.json
archmap workspace index services/api sites/docs --json > workspace-index.rebuilt.json
cmp workspace-index.first.json workspace-index.rebuilt.json
```

The command reads persisted member baselines only; it does not claim current-member freshness,
scan members, or infer cross-project relations.

## Controlled pilot matrix

| Pilot | Deterministic coverage exercised | Explicit boundary |
| --- | --- | --- |
| Web/content | TypeScript imports, Markdown links, YAML metadata | No framework/runtime route inference is asserted. |
| Python/data | Python import, Markdown-to-YAML link, YAML asset | The normal test environment asserts the shipped Python worker is supported; the separate unsupported-runtime degradation contract remains in `test/cli-python.test.ts`. |
| Markdown-first | document headings, links, decision and ledger conventions | Markdown structure is not a business-process truth claim. |
| Media pipeline metadata | TypeScript plan import, Markdown-to-YAML metadata link | A NUL-bearing `clip.mp4` is excluded. There is no media capability, decoding, runtime pipeline, or binary semantic fact. |

`test/m6-exit.test.ts` copies each fixture into an independent temporary Git repository, runs
`init` and `scan`, checks `capabilities --json`, validates the stored model, rescans unchanged
bytes, and compares a declared exact known-relation matrix. No fixture carries a human or agent
claim/relation, so the controlled revision count is zero by construction; it is not a statement
about the editing work required in a real repository.
