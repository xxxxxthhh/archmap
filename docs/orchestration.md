# Artifact-backed delivery

ArcMap uses an artifact-backed workflow for long-running delivery. GitHub issues, fixed pull
request SHAs and diffs, CI, and current independent verification carry state between roles.
Chat is a control surface, not a durable handoff protocol.

The current runtime-checkpoint format is demonstrated by
[the ArcMap M3-M6 delivery tracker](https://github.com/xxxxxthhh/archmap/issues/9). That issue
is an example location, not a place to copy permanent state from. Each active delivery program
must name its own checkpoint.

## Sources of authority

Use these sources in descending order:

1. repository instructions and `PLAN.md`;
2. the runtime checkpoint and the sole ready feature issue;
3. the fixed PR base/head SHAs and complete diff;
4. CI, focused probe logs, and current Codex verification;
5. a structured fixed-SHA reviewer verdict.

Do not reconstruct authority from a model transcript or assistant-authored summary. Dynamic
state—current SHA, issue, branch, PR, CI run, model session, verification counts, and next
action—belongs in the checkpoint or PR evidence. Keep it out of this document, `AGENTS.md`,
skills, and automation prompts.

## Roles and ownership

| Role | Owns | Must not own |
| --- | --- | --- |
| Orchestrator/integrator | Scope, dispatch, checkpoint truth, independent evidence, commit, PR, merge, stable-line verification, and cleanup | Trusting another model's completion claim without evidence |
| Implementer | Bounded edits and focused regressions | Commit, push, PR, merge, branch changes, or checkpoint mutation |
| Planner/reviewer | Read-only planning or fixed-SHA spec and standards judgment | Editing or delivering the reviewed branch |
| CI | Clean-environment execution | Product judgment or root-cause diagnosis |

Model names are replaceable. The role boundary is not.

## One-ready-issue rule

- `main` is the stable line. A milestone integration branch starts from a verified `main`.
- Exactly one feature issue is ready at a time.
- Each issue uses one short-lived branch and one PR into the milestone integration branch.
- The issue freezes its base, allowed seams, non-goals, risk tier, required probes, and
  delivery boundary before implementation starts.
- After acceptance, merge with the expected head SHA, verify the integration result, close
  the issue, and remove only the branch that was just merged.
- When all milestone issues are accepted, run one bounded milestone review and one Codex
  milestone gate, then deliver the exact integration head to `main` without repeating an
  identical product audit.

## Risk tiers and model routing

Choose the least expensive role/model tier expected to close the bounded work in one pass.
Escalate for judgment or contract risk, not because a premium model is available.

| Tier | Typical work | Required flow |
| --- | --- | --- |
| A | Documentation, metadata, deterministic formatting, or a justified local test timeout | Codex implements and verifies directly; CI confirms. Escalate if production behavior or assertions change. |
| B | A bounded vertical feature or existing public-seam behavior | Implementer edits; Codex verifies and delivers; one cost-efficient fixed-SHA review and one substantive follow-up are budgeted. An Opus-class medium review is appropriate when it is the practical independent option. |
| C | Schema, provenance, deterministic truth, permissions, secrets, transactions, or no-partial-write guarantees | One bounded planning pass; implementer edit; Codex evidence gate; Opus-class high fixed-SHA review; milestone review. Transaction and rollback probes are mandatory when relevant. |

Use a Fable/frontier-class high-effort pass only for new milestone architecture, long-horizon
dependency planning, invariant redesign after a second sibling defect, evidence-backed
arbitration, or the final release audit. Do not use it for routine implementation, CI diagnosis,
mechanical fixes, or identical-head delivery PRs.

## Evidence gates

### Implement

The implementer receives one self-contained issue, permitted and forbidden scope, exact
focused verification, and a prohibition on Git/GitHub delivery actions. It stops at an
uncommitted review boundary.

### Verify

Codex inspects the entire diff and repository state, reproduces the issue through public
seams, and owns the freshest full gate. Add compiled-bin, packaging, browser, transaction,
or fixture probes in proportion to risk. Treat implementation reports as leads, not proof.

### Review

An independent reviewer receives only the issue contract, fixed base/head SHAs, relevant
diff, changed-file summary, existing Codex/CI evidence, and a few targeted probes. It returns
separate spec and standards judgments and at most two or three blocking findings. A blocker
must include the fixed SHA, tight file/line range, exact reproducer, observed result, expected
contract, and severity.

### Repair

Codex reproduces every finding before dispatching a repair. Reject speculative, stylistic,
future-stage, or out-of-scope findings. For a valid finding, identify the violated invariant,
cover its input classes and required positive behavior with a compact matrix, then repair the
shared seam. A second sibling defect ends example-by-example patching and triggers a
conservative allowlist, invariant redesign, or explicit orchestrator decision.

### Deliver

Codex alone stages and commits intended files, pushes the short branch, opens or updates the
PR, records fixed-SHA evidence, interprets CI, merges with the expected SHA, verifies the
result, and cleans only merged branches. CI is clean-environment confirmation, not a
substitute for local diagnosis.

## Runtime checkpoint

Keep a machine-readable state block near the top of one GitHub tracking issue. At minimum it
records status, milestone, stable and integration branches, accepted base, current issue and
issue branch, PR, fixed head, review/CI state, `next_action`, updater, and timestamp.

Checkpoint status controls authority:

- `active`: execute only `next_action`;
- `paused`: make no repository, GitHub, model, or automation mutations;
- `waiting_usage`: record the reset time and schedule one wake after reset instead of polling;
- `blocked`: record an unrecoverable external or authority blocker with evidence;
- `completed`: stable delivery and final gates are complete.

Append compact transitions with the issue/PR, fixed SHA, verification and CI evidence,
reviewer verdict, and next action. On resume, re-read the checkpoint, fetch remote state,
verify local branch/head/status and any active model context, and reconcile discrepancies
without overwriting unexpected work.

Recurring automation prompts should contain only the workflow skill, repository, checkpoint,
and instructions for `active`, `paused`, and `waiting_usage`. History and test logs belong in
the checkpoint or PR evidence.
