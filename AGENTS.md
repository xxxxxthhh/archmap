# Repository delivery instructions

For long-running, multi-model, or issue-to-PR delivery in this repository, use
`$artifact-backed-delivery` and follow [docs/orchestration.md](docs/orchestration.md).

## Start with the smallest authoritative state

1. Read the compact program checkpoint first.
2. If it is `paused`, do not mutate repository, GitHub, models, or automation. If it is
   `waiting_usage`, schedule one reset wake and stop.
3. When active, resolve the selected lane checkpoint. Only at a mutation boundary read the
   relevant `PLAN.md` section, ready issue, fixed Git state, and required skill references.
4. While an implementation, CI run, or review is active, use its fast path; do not rerun
   planning, broad scans, or full gates.

Treat repository instructions, program/lane checkpoints, ready issues, fixed PR SHAs/diffs,
CI, and current Codex evidence as authoritative. Chat summaries are pointers only.

## Delivery boundaries

- `main` is stable. Use at most two active implementation lanes, one ready issue per lane,
  one isolated worktree and short branch per issue, and one PR per issue.
- Codex is the sole dispatcher, checkpoint owner, independent verifier, committer, merger,
  stable-line verifier, and cleanup owner. Checkpoint and delivery mutations are serialized.
- Select models at dispatch time by role and current availability. Do not hard-code or search
  for an unavailable model. Implementers stop uncommitted; reviewers remain read-only.
- Freeze each issue's base, worktree, allowed seams, `write_set`, `lease_set`, dependency
  versions, verification ownership, risk tier, non-goals, and delivery boundary before edits.
- Implementers run focused development checks. Codex runs one authoritative final issue gate;
  repairs rerun the regression matrix first. CI supplies clean-environment confirmation.
- Tier B review is trigger-based, not automatic. Tier C and explicit risk triggers require a
  fixed-SHA review. A second sibling defect requires invariant closure or redesign.
- If PR CI tested the exact merge result, post-merge verification is SHA/status plus targeted
  smoke, not another full gate. Run one full milestone gate and avoid identical-head re-audits.
- Execute only the lane checkpoint's `next_action`. Use `action_id`, active contexts, PR head,
  and CI run as idempotency keys so repeated heartbeats cannot duplicate work.
- Keep dynamic SHAs, issues, PRs, CI runs, model sessions, leases, and test counts in compact
  checkpoints, transition comments, and PR evidence—not in repository instructions.

The program checkpoint convention is demonstrated by
[the ArcMap delivery tracker](https://github.com/xxxxxthhh/archmap/issues/9).
