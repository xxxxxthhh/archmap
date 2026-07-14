# Artifact-backed delivery v3

ArcMap uses a state-aware artifact-backed workflow. GitHub issue contracts, compact
checkpoints, fixed pull-request SHAs and diffs, CI, and current independent verification carry
state between roles. Chat is a control surface, not a durable handoff protocol.

The program checkpoint is demonstrated by
[the ArcMap delivery tracker](https://github.com/xxxxxthhh/archmap/issues/9). Each active
implementation lane has its own compact checkpoint issue.

## Sources of authority

Use these sources in descending order:

1. repository instructions and the relevant `PLAN.md` section;
2. the program checkpoint, selected lane checkpoint, and ready issue;
3. fixed base/head SHAs and the complete PR diff;
4. current Codex evidence and CI;
5. a structured reviewer verdict when the risk policy requires one.

Dynamic state belongs in checkpoint bodies, structured transition comments, and PR evidence.
Do not reconstruct authority from a model transcript or copy delivery history into automation
prompts, skills, or repository instructions.

## Roles, not model brands

| Role | Owns | Must not own |
| --- | --- | --- |
| Orchestrator/integrator | Program/lane state, dispatch, independent evidence, commit, PR, merge, stable verification, cleanup | Trusting another model's completion claim |
| Implementer | Bounded edits and focused regressions | Commit, push, PR, merge, branch/checkpoint mutation |
| Planner/reviewer | Read-only planning or fixed-SHA spec/standards judgment | Editing or delivering reviewed work |
| CI | Clean-environment execution | Product judgment or root-cause diagnosis |

Choose the model when dispatching the role. A feature issue may state required capabilities and
a preferred/fallback tier, but it must not make an unavailable historical model mandatory. In
the current Claude catalog, Opus 4.8 is the normal implementation and deep-review option;
Fable 5 is reserved for milestone architecture, arbitration, and release review.

## Program and lane checkpoints

The program tracker contains only global status, stable branch/head, active lane references,
global action/lease ownership, and the latest transition link. A lane checkpoint contains its
worktree, integration and issue branches, fixed base/head, issue, write/lease sets, model role
and active context, PR/CI/review state, `action_id`, and `next_action`.

Checkpoint bodies are current snapshots, not journals. Record transitions as compact issue
comments and link only the latest comment from the body. This keeps every heartbeat cheap and
prevents stale narrative from competing with the state block.

Status controls authority:

- `active`: execute only the selected lane's `next_action`;
- `paused`: perform no repository, GitHub, model, or automation mutation;
- `waiting_usage`: record reset time, schedule one reset wake, and stop polling;
- `blocked`: record an unrecoverable external/authority blocker;
- `completed`: final stable delivery and gates are closed.

## State-aware heartbeat fast paths

One automation dispatcher serves the program. It reads the compact program state first, then
uses exactly one path:

| State | Allowed heartbeat work |
| --- | --- |
| Program or lane `paused` | Return without mutation |
| `waiting_usage` | Maintain one reset wake only |
| Active implementation context | Check context state plus branch HEAD/status; do not reload contracts or run gates |
| Active CI run | Query only that run and exact PR head |
| Active reviewer context | Check only reviewer state and fixed head |
| No external action active | Perform mutation preflight, load the ready contract, claim a new `action_id`, and execute `next_action` |

Five-minute monitoring can remain responsive because unchanged waits take the fast path.
`action_id`, context ID, PR number/head, and CI run ID are idempotency keys: a repeated or
overlapping heartbeat must observe the existing action instead of creating another one.

## Parallel lanes and leases

- Use at most two active implementation lanes for the program.
- Keep one ready issue per lane and one implementer per worktree.
- Give each lane a separate worktree, integration branch, issue branch, model context, and lane
  checkpoint. Never place two implementers in one checkout.
- Freeze machine-readable `write_set`, `lease_set`, and exclusive test resources before
  dispatch. Reject a second implementation lane when any set overlaps.
- Serialize checkpoint mutation, authoritative full gates, commits, pushes, PR merges, stable
  reconciliation, and cleanup through Codex.
- Read-only planning/spikes may run off-worktree beside an implementation lane, but cannot
  authorize repository work or consume a write lease.
- Early future-milestone work cannot reach `main` before the current milestone. Reconcile the
  exact new stable head and pass a cross-lane gate before delivery.

## Freeze the issue before implementation

The issue contract must name:

- fixed integration base and intended short branch/worktree;
- allowed seams, `write_set`, `lease_set`, and non-goals;
- risk tier and public/transaction/security invariants;
- exact dependency versions or an explicit Codex-owned `prepare_issue` step that freezes them;
- implementation role plus current preferred/fallback model tier;
- implementer checks, Codex final gate, CI evidence, and review triggers;
- merge/delivery boundary.

Do not delegate an unresolved dependency version, product decision, or shared-file conflict to
the implementer.

## Verification profiles

### Implementer profile

The implementer runs only the focused regressions needed to develop the change, touched-scope
typecheck/lint, and a local build when useful. It stops at an uncommitted review boundary and
reports files and commands. It does not own the full repository, package, or release gate.

### Repair profile

Codex first reproduces a finding. The implementer repairs the violated invariant and reruns the
compact negative/positive matrix. Do not run the full gate after every intermediate repair.

### Final issue profile

On one final candidate head, Codex inspects the complete diff and repository state, exercises
the public seam, runs focused checks, then one authoritative full gate plus only the compiled,
package, schema, content-safety, or transaction probes justified by risk. This is the local
evidence used for the PR.

### CI and post-merge profile

CI confirms the clean merge result. When exact-head CI is green and the merge uses the expected
SHA, post-merge work is limited to branch/head equality, clean status, and an integration-specific
smoke. Repeat a full gate only when the merge result differs, base reconciliation was non-trivial,
or a documented risk trigger requires it.

### Milestone and stable profiles

Run one full milestone gate on the final integration candidate. If the final issue reviewer is
given the stable-base-to-candidate range and the accepted tree remains identical after merge,
that verdict may also satisfy milestone review. An identical-head delivery PR receives only
base/history, accidental-diff, CI, and mergeability review. After stable merge, verify exact
remote/local state and critical smoke rather than repeating the product audit.

## Risk and review policy

| Tier | Default review |
| --- | --- |
| A | No independent model; Codex plus proportionate checks and CI |
| B | Trigger-based only after the final Codex gate and CI |
| C | One fixed-SHA spec/standards review; one substantive follow-up maximum |

Tier B review triggers include unresolved contract ambiguity, a public behavior mismatch,
cross-module ownership uncertainty, a substantive repair, conflicting evidence, or an explicit
issue requirement. A new dependency or process boundary alone is handled by the frozen issue
and Codex gate unless it introduces Tier C risk.

A blocking finding must identify fixed SHA, file/line, exact reproducer, observed behavior,
expected contract, and severity. Reject speculative, stylistic, future-stage, or out-of-scope
findings. A second sibling in one seam ends example patching and requires a regression matrix,
conservative allowlist, or redesign decision.

## Prompt and context budget

An implementation prompt points to the repository, branch, issue, role, stop boundary, and Git
prohibitions. Do not repeat the issue body. A reviewer prompt supplies the issue/PR, fixed SHAs,
changed-file summary, Codex/CI evidence, and finding contract. Start fresh review contexts; reuse
the original implementation context only for a bounded repair.

## Milestone delivery

Merge accepted issue PRs into the integration branch with expected heads. After the final
candidate passes the one milestone gate/review, open the exact-head delivery PR immediately.
Do not repeat an identical audit. Merge, verify stable state, close lane/program checkpoints as
appropriate, clean only merged branches/worktrees, and start the next lane from verified stable.
