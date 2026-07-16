# M5 Viewer exit audit

This is the candidate evidence map for PLAN M5 and issue #33.  It closes the
Viewer scope only: an architecture map, evidence inspection, impact and diff,
the four factual filters, and deterministic exports.  It does **not** add a
writer, cloud/hosting surface, a new analyzer, rules/CI behaviour, workspace
aggregation, or any M6 work.

## Candidate status and decision boundary

This document is deliberately a checklist, not a record that M5 has already
passed.  A criterion becomes accepted only when Codex records a fixed M5
integration-candidate SHA, the exact commands below have passed for that SHA,
and the final milestone gate and review have been completed.  In particular,
`npm run check`, the complete browser suite, package/diff/schema/NUL checks,
and the compiled-CLI smoke named below are **final-candidate / full-milestone
gate work**; listing them here does not claim a result for an unfixed working
tree.

The normal Viewer is local and read-only.  It binds a loopback address, serves
only bundled same-origin assets, accepts only `GET`, and projects repository
values as inert text.  The V6 diff route is an extension of that same boundary:
it uses V2's architecture-diff partition and applies the existing Viewer
`neutralizeText` projection to free-form node titles, scope file/symbol values,
and claim text before browser JSON is emitted.  It does not construct a second
interpretation of membership, ids, types, certainty, provenance, or status;
optional scope fields retain their presence, and under-limit file/symbol values
retain their one-for-one order and cardinality.

## M5 delivery evidence map

| PLAN M5 delivery | Executable evidence | What the evidence establishes |
| --- | --- | --- |
| **Architecture map** | `test/render-projection.test.ts` (`projectModel`); `test/serve-server.test.ts` “serves the display-graph projection …”; `e2e/viewer.e2e.ts` “opens the map and expands a collapsed group” | The display projection retains stable ids, certainty, claim type/status/provenance and safe evidence pointers; the loopback API reports the expected graph; a real browser loads the map and navigates a collapsed group. |
| **Evidence inspector** | `test/serve-evidence-api.test.ts`; `e2e/evidence-inspector.e2e.ts` “selects nodes and exact relation evidence with durable deep links and inert excerpts” | Node and relation targets return their own CLI-equivalent evidence, bounded safe excerpts, and their actual partial/unknown gaps.  Browser node/edge selection and reloadable evidence links remain reachable. |
| **Impact** | `test/serve-impact-api.test.ts` “matches the CLI impact JSON semantics …”; `e2e/filters-impact.e2e.ts` “shows CLI-equivalent impact highlights …” | The Viewer highlights the same impact result as `archmap impact`; it does not invent an impact interpretation or overwrite existing graph labels. |
| **Diff mode** | `test/m5-exit.test.ts` “serves the V2 bucket report …” and “neutralizes hostile diff display text …”; `e2e/diff-mode.e2e.ts` “renders the exact prepared node and relation buckets …” | A two-commit fixture (`fixtures/viewer-diff-repo/base` → `head`) asserts added, removed, and changed node and relation buckets from V2's engine, plus active and stale claim states. The Viewer preserves bucket membership/ids/types/certainty/status while neutralizing free-form title, scope file/symbol, and claim-text values; the browser renders the prepared buckets through loopback. |
| **Stale, confidence, source/provenance, and relation filters** | `test/serve-impact-api.test.ts` “exposes only factual filter facets …”; `e2e/filters-impact.e2e.ts` “filters nodes and relations without relabelling their provenance or certainty” | Filter choices use the existing status/claim/relation facts.  The browser test keeps human/analyzer provenance and partial/unknown certainty intact, distinguishes status staleness from stale claims, and verifies a readable empty state. |
| **SVG, Mermaid, and Markdown exports** | `test/render-export.test.ts` canonical-golden and byte-identical cases, format-distinction cases, content-safety cases, and compiled-source CLI cases | All three formats come from the same deterministic projection; their goldens retain certainty, claim/state/actor distinctions and are byte-stable.  The compiled CLI output and invalid inputs are also covered. |

### Diff identity, truth, and mutation boundaries

The V6 fixture creates two deterministic commits from its `base/.archmap` and
`head/.archmap` states. `test/m5-exit.test.ts` compares the endpoint's V2
membership/buckets, ids, relation certainty, and claim type/status with
`architectureDiff(root, base, head)`; only the existing Viewer safety projection
changes free-form title, scope file/symbol, and claim-text values. Thus V6 cannot
silently reclassify a V2 result or let raw active free-form diff text reach
browser JSON. The same test
calls the endpoint with two references resolving to the same commit and
requires `identical: true` plus empty node and relation buckets.  The browser
counterpart requires the explicit readable message **“No architectural
changes”**, rather than treating a zero-result response as a failure or an
ambiguous blank panel.

`test/m5-exit.test.ts` also sends missing, duplicated, unsafe, and NUL-bearing
references and a `POST`; it requires safe rejection, `Allow: GET` for the
method attempt, and a byte-identical fixture Git status.  `test/serve-router.test.ts`
keeps the shared GET-only boundary, while `test/serve-server.test.ts` checks a
broader request sweep leaves `.archmap` bytes unchanged.  Those tests establish
read-only behaviour; this audit makes no claim that the Viewer is a general
write API.

## M5 exit criteria evidence map

| PLAN M5 exit criterion | Criterion-to-evidence mapping |
| --- | --- |
| **A typical view remains readable at a reasonable node count** | `src/render/probe.ts` defines the deterministic-layout budget: at most **60 visible nodes** and **120 visible edges**. `test/render-projection.test.ts` proves the default `fixtures/viewer-repo` projection is **7 nodes / 7 edges**, passes the probe, and fails closed at 61 nodes with a dependency-decision request. These are the documented fixture and view limits; no elapsed-time or performance claim is made. |
| **Clicking a node or edge reaches source evidence** | `e2e/evidence-inspector.e2e.ts` opens `node_api`, follows `rel_api_reads_db`, verifies the inspector target and durable URL, and reloads it. `test/serve-evidence-api.test.ts` verifies exact node/edge evidence identities and refuses malformed, ambiguous, missing, and path-escaping requests without fabricating a fallback. |
| **Browser coverage includes navigation, filters, diff, and content safety** | Navigation is in `e2e/viewer.e2e.ts`; filters/impact are in `e2e/filters-impact.e2e.ts`; V6 diff and its identity empty state are in `e2e/diff-mode.e2e.ts`; evidence navigation is in `e2e/evidence-inspector.e2e.ts`.  The final candidate must run this complete group, not only a unit-test substitute. |
| **Viewer works without network and listens only on loopback** | `test/serve-server.test.ts` proves `127.0.0.1` binding, rejects wildcard hosts, and verifies served assets contain no remote origin. `e2e/filters-impact.e2e.ts` and `e2e/diff-mode.e2e.ts` record browser request origins and require only the Viewer origin.  `src/serve/content-safety.ts` applies `connect-src 'self'` and the router supplies the same headers to API, asset, and error responses. |

## PLAN §13.3 Viewer content-safety gate

PLAN §13.3 requires **100% of Viewer content-safety regressions to pass**.  The
fixed candidate gate therefore includes all of the following suites, not a
sampled manual check:

- `test/serve-server.test.ts` verifies CSP on responses, no remote origin in
  bundled assets, path/asset traversal denial, inert hostile graph JSON, and a
  read-only on-disk request sweep.
- `test/serve-router.test.ts` verifies the headers apply to successes and
  errors, every non-GET request is refused before a handler runs, and feature
  mounts cannot shadow one another.
- `test/serve-evidence-api.test.ts`, `test/serve-impact-api.test.ts`, and
  `test/m5-exit.test.ts` keep
  excerpts and impacted labels inert, fail closed on unsafe inputs, and retain
  the shared GET-only boundary. The V6 regression specifically requires the
  diff JSON to omit raw hostile node-title, scope file/symbol, and claim-text markup while keeping
  the V2 bucket, certainty, and status facts intact.
- `test/render-export.test.ts` neutralizes hostile values across SVG, Mermaid,
  Markdown, and JSON without erasing their contract fields.
- Browser regressions in `e2e/viewer.e2e.ts`, `e2e/evidence-inspector.e2e.ts`,
  and `e2e/diff-mode.e2e.ts` use real Chromium to prove hostile map, evidence,
  and diff values remain text: no injected global, dialog, active markup, or
  remote-origin request succeeds.

The broader §13.3 deterministic-fact, unchanged-scan, fixture-relation,
staleness, and unsupported-capability thresholds remain owned by the existing
M0–M4 fixtures and their tests (not by a new Viewer-side claim).  The final
`npm run check` re-runs that inherited suite.  This document does not convert a
unit assertion into an unmeasured aggregate quality percentage.

## Final-candidate / full-milestone gate

At a fixed M5 integration-candidate SHA, Codex must record the exact command
outputs and repository state for at least:

```sh
npx vitest run \
  test/m5-exit.test.ts \
  test/render-projection.test.ts \
  test/render-export.test.ts \
  test/serve-server.test.ts \
  test/serve-router.test.ts \
  test/serve-evidence-api.test.ts \
  test/serve-impact-api.test.ts
npm run test:e2e -- \
  e2e/viewer.e2e.ts \
  e2e/evidence-inspector.e2e.ts \
  e2e/filters-impact.e2e.ts \
  e2e/diff-mode.e2e.ts
npm run check
npm pack --dry-run
git diff --check
```

The same final gate additionally owns the compiled-CLI/loopback smoke, schema
validation, NUL-byte sweep, fixed-SHA diff inspection, clean-status check, and
the one M5 milestone review across the stable base to the final M5 candidate.
Those checks are intentionally named as future acceptance evidence here rather
than reported as already completed.
