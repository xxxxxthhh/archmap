# M4 exit audit

This audit closes PLAN M4: the evidence bundle, the stale-work and MCP query tools, the
propose/validate/preview/apply proposal transaction, the facts/interpretations/decisions
authorization boundary, and the model-independent agent workflow. It adds no schema
vocabulary, Viewer behavior, rules, HTTP transport, or approval mechanism.

The MCP proposal tools are thin transport adapters over the same exported library the CLI
uses: there is one schema, one fingerprint, one authorization, one conflict rule, one
projection, and one transaction implementation. A behavior difference between the MCP surface
and its CLI command is therefore a defect, not a variant.

## The "agent" is a scripted consumer

No model is invoked anywhere in M4. The agent workflow is a deterministic scripted consumer of
the public MCP and CLI seams: it reads stale work and evidence through the read-only query
tools, has `propose_update` stamp the current validated baseline fingerprint onto an operations
payload, validates through both surfaces, previews the canonical diff through the CLI, and
applies through the MCP transaction. `test/m4-exit.test.ts` runs this full loop end to end on a
fresh mixed fixture — stale detection → `propose_update` → `validate_proposal` (and `proposal
validate`) → `proposal preview` → `apply_proposal` → evidence resolution → commit and rescan →
enrichment survival → a stable repeat read with no unexpected tracked diff.

## Exit criteria evidence map

| PLAN M4 exit criterion | Public seams | Automated evidence |
| --- | --- | --- |
| **Agent 无法通过 proposal 修改 deterministic fact** (an agent cannot modify a deterministic fact through a proposal) | `validate_proposal`, `apply_proposal`, `proposal validate`, `proposal apply`, and the direct `applyProposal` library entry | `test/m4-exit.test.ts` "deterministic facts are immutable" rejects a fact claim, an agent-authored `known` relation, removal of an analyzer/known relation, and a structural node edit at both validate and apply, through MCP and CLI, with a byte-identical inventory. `test/proposal-apply.test.ts` "rechecks fact, known relation, and structural prohibitions for direct callers" covers direct-library misuse. `test/proposal.test.ts` keeps the authorization unit matrix. |
| **人工 decision 冲突需要显式批准** (a human decision conflict requires explicit approval) | `validate_proposal`, `apply_proposal`, `proposal apply --approve` | `test/m4-exit.test.ts` "human decision conflicts require explicit CLI approval": a status change over a human claim returns a stable conflict id; MCP `apply_proposal` returns `requires-approval` and writes nothing, its tool schema rejects any `approve`/`approvals` field, and only `proposal apply --approve <id>` with the exact conflict set applies. `test/proposal-apply.test.ts` "exact approval set" keeps the missing/extra/duplicate/stale approval matrix. |
| **中途失败不会留下部分写入** (a mid-transaction failure leaves no partial write) | `apply_proposal` → shared `publishNodes` transaction | `test/m4-exit.test.ts` "no partial write" injects an exception at each transaction boundary (`before-first-write`, `after-first-write`, `after-node-remove`, `before-node-write`, `after-node-write`) driven through the MCP apply seam and asserts a byte-identical repository and a still-readable baseline after every fault. `test/proposal-apply.test.ts` "shared tracked transaction fault matrix" keeps the store-level rollback, double-fault, path-escape, permission, wrong-type, and symlink cases. |
| **MCP 与 CLI 对同一查询返回语义等价结果** (MCP and CLI return semantically equivalent results for the same query) | `validate_proposal` vs `proposal validate --json`; the #15 query tools vs their CLI commands | `test/m4-exit.test.ts` "MCP/CLI equivalence" asserts canonical domain-payload equality for positive, invalid, forbidden, requires-approval, stale, and not-found proposals, plus `list_stale_nodes`/`get_update_work_items` parity on a dirty tree. `test/mcp-server.test.ts` keeps the compiled-server parity for the full read-only tool surface. |

## Authorization and transaction invariants proven

`test/m4-exit.test.ts` and the focused proposal tests additionally establish:

- `propose_update` only stamps identity: it attaches the live `base_commit` and `model_hash`
  and canonically normalizes the operations. It authorizes nothing and carries no approval, so
  the same operations payload normalizes to a byte-identical proposal and two runs across a
  deterministic rescan reproduce the proposal, verdict, and query artifacts byte for byte.
- A stale-base proposal is refused through the MCP apply seam with zero tracked writes.
- Extra or hidden approval-like fields on `propose_update` and `apply_proposal` are
  schema-rejected at the tool boundary, so there is no approval channel to smuggle a decision
  through.
- A pre-apply sweep of the query tools writes nothing, and a successful `apply_proposal` changes
  only tracked node paths (the derived cache is disposable and separately rebuildable).
- A malformed or oversized proposal fails closed with a structured verdict and leaves the
  handler fully usable.

## Approval and transport boundaries

- **The CLI is the explicit operator approval boundary.** A human-decision conflict can be
  applied only through `proposal apply --approve <id>` supplying the exact current conflict set.
  This is an operator-intent boundary, not a cryptographic identity claim: the audit proves that
  approval is explicit, exact, and exclusive to the CLI, not that the operator is authenticated.
- **MCP is stdio- and local-only, and cannot approve.** The server speaks JSON-RPC over stdio
  with no listener, port, network, or auth surface (`test/mcp-server.test.ts` proves no socket is
  opened). `apply_proposal` has no approval argument in its schema, so a decision conflict over
  MCP can only ever return a `requires-approval` verdict with stable ids and no write.
- **Rollback is exception-safe, not crash-safe.** The shared `publishNodes` transaction restores
  the prior bytes when a write step raises, and the fault matrix proves this at each boundary. It
  is deliberately not a journaling or crash-recovery mechanism: a process kill or power loss
  mid-write is out of scope, and the guarantee is that a handled exception never leaves a partial
  tracked write.

## Verification

Run the focused milestone checks first, then the full gate and package audit:

```sh
npx vitest run test/m4-exit.test.ts test/mcp-server.test.ts test/proposal-apply.test.ts test/proposal.test.ts test/cli-proposal.test.ts
npm run check
npm pack --dry-run
git diff --check
```

A repository-wide NUL-byte sweep is also required before delivery, because ordinary text
linters do not prove that a generated or fixture file is non-binary.
