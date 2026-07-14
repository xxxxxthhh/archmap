# Repository delivery instructions

For long-running, multi-model, or issue-to-PR delivery in this repository, use
`$artifact-backed-delivery` and follow [docs/orchestration.md](docs/orchestration.md).

Before changing anything, read this file, `PLAN.md`, the runtime checkpoint, the sole ready
feature issue, and the current Git state. Treat those artifacts, fixed PR SHAs and diffs, CI,
and current Codex verification as authoritative. Chat summaries are pointers only.

## Boundaries

- Keep `main` stable. Use one short-lived branch and one PR for the one ready issue.
- The orchestrator owns checkpoint truth, independent verification, commit, push, PR, merge,
  post-merge checks, and branch cleanup.
- An implementer edits only the bounded issue and stops uncommitted. A reviewer is read-only.
- Reproduce review findings before repair. A second sibling defect in one seam requires an
  invariant-level regression matrix or redesign, not another isolated example patch.
- Execute only the checkpoint's `next_action`. `paused` authorizes no mutations;
  `waiting_usage` schedules one wake after reset rather than polling.
- Keep dynamic SHAs, issue/PR numbers, CI runs, model sessions, and test counts in the runtime
  checkpoint and PR evidence, never in repository instructions.

The current checkpoint convention is demonstrated by
[the ArcMap delivery tracker](https://github.com/xxxxxthhh/archmap/issues/9).
