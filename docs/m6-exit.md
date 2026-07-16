# M6 rules, CI, and cross-repository pilot exit audit

This is the candidate evidence map for PLAN M6 and issue #50. It closes the M6 scope only:
rules/CI reports, the disposable workspace aggregate, and controlled multi-shape pilots. It
does not claim a new analyzer, a real external-repository study, a media parser, a CI workflow,
or a merge to `main`.

## Candidate status and decision boundary

This audit is a checklist, not a claim that M6 is accepted already. Acceptance requires a
fixed M6 integration candidate, the exact final commands below, clean exact-head CI, and the
independent fixed-SHA review. The final review range is the stable M5 base through the resulting
M6 integration head; an internal issue PR is not a substitute for that milestone review.

## M6 delivery evidence map

| PLAN M6 delivery | Executable evidence | What it establishes |
| --- | --- | --- |
| `check` and architecture rules | `docs/m6-check.md`; `test/cli-check.test.ts` | Read-only Markdown/JSON reports, strict/warning/blocking behavior, stale-model blocking, rule schema and store-boundary safety. |
| PR/CI Markdown and JSON reports | `docs/m6-ci-pilots.md`; `test/m6-exit.test.ts` “warning, strict, blocking, and malformed-input CI outcomes” | A CI job can preserve the exact existing output contract and distinguish advisory, blocking, and fail-closed input errors without changing a workflow. |
| Workspace aggregate index | `docs/m6-workspace.md`; `test/cli-workspace.test.ts` | Owner-only deterministic aggregate, member baseline read boundary, unsafe-path rejection, member byte preservation, and cache-delete rebuild. |
| Web/content pilot | `test/fixtures/m6-pilots/web-content`; `test/m6-exit.test.ts` | TypeScript imports, Markdown link, and YAML metadata are scanned in a fresh local Git repo. |
| Python/data pilot | `test/fixtures/m6-pilots/python-data`; `test/m6-exit.test.ts` | Python import, Markdown-to-data link, data asset, and runtime capability report are checked in a fresh local Git repo. |
| Markdown-first pilot | `test/fixtures/m6-pilots/markdown-first`; `test/m6-exit.test.ts` | Markdown document/decision/ledger conventions and exact intra-repo links are checked in a fresh local Git repo. |
| Media-pipeline metadata pilot | `test/fixtures/m6-pilots/media-pipeline`; `test/m6-exit.test.ts` | Source/config/Markdown metadata is deterministic while a NUL-bearing media-like file is excluded and no imaginary `media` capability is advertised. |
| Performance, accuracy, and human-revision report | This document plus `test/m6-exit.test.ts` | Accuracy and zero-manual-edit observations are controlled-fixture measurements. No elapsed-time target is invented before the PLAN M1 baseline. |

## PLAN §13.3 initial quality gates

| Gate | M6 evidence and measurement boundary |
| --- | --- |
| Deterministic-fact evidence coverage `100%` | `assertDeterministicEvidence` requires every fixture `fact` and every known relation to have analyzer evidence from a capability reported as `supported`; stored models also pass `validateManifest`. |
| Unchanged repeated-scan tracked diff `0` | Each of the four isolated pilots snapshots all `.archmap` bytes, rescans unchanged source, and requires byte equality. |
| Fixture expected-relation precision `>= 95%` | The M6 matrix declares nine known source/type/target tuples. The test requires the selected known-relation set to equal those nine tuples (nine true positives, zero selected false positives: `100%`). This is an exact controlled-fixture gate, not a corpus-wide production precision estimate. |
| Stale critical-path misses `0` | The M6 test changes an indexed Web/content source file and requires the resulting `stale-model` violation to be blocking. It is a bounded stale-path regression, not a claim about every possible source change. |
| Unsupported capability incorrectly deterministic `0` | The media fixture adds a NUL-bearing `assets/clip.mp4`, then requires it to be absent from snapshot/nodes and requires no `media` capability. Deterministic surrounding metadata remains separately evidenced. |
| Viewer content safety `100%` | This remains owned by M5's complete Viewer test group documented in `docs/m5-exit.md`; the final `npm run check` reruns that inherited suite. M6 does not weaken or relabel that boundary. |

## Measurement notes

The four pilots intentionally use fresh temporary Git repositories copied from versioned
fixtures. That makes their input, expected relation matrix, and observed model reproducible.
The zero human-revision observation means no fixture model receives a human/agent claim or
relation during this test; it is not a usability study or a forecast of review effort.

PLAN §13.3 postpones numerical performance targets until an M1 baseline exists. M6 therefore
records a bounded executable workload (four small repositories and one focused test) but does
not invent an elapsed-time SLO. The final candidate evidence records the observed command result
alongside its fixed SHA; it is not used as an ungrounded product-performance claim.

## Final-candidate / milestone gate

At the fixed final M6 integration candidate, Codex records at least:

```sh
npm test -- test/m6-exit.test.ts
npm run check
git diff --check
```

The final milestone handoff also records the stable-base-to-candidate diff, exact CI run and
head/tree correspondence, workspace cache regression, and one fixed-SHA independent review.
If that review is accepted, the delivery PR to `main` is opened at the identical reviewed head;
this document does not authorize its merge.
