# archmap

`archmap` is a local-first, evidence-backed repository map for coding agents and humans.

The project turns source code, configuration, documentation, and Git history into a
queryable architecture model. Static analyzers produce deterministic facts; AI may add
interpretations only through evidence-backed proposals; human decisions remain protected.
Interactive diagrams, impact views, MCP tools, CLI output, and CI reports are projections
of the same model rather than independent sources of truth.

## Quickstart

ArchMap is not published to npm; run it from a source checkout (Node.js 20+ and Git):

```bash
git clone https://github.com/xxxxxthhh/archmap.git
cd archmap
npm ci
npm run build
npm run demo       # init -> scan -> impact/evidence -> edit -> stale -> rescan on a synthetic sample
```

`npm run demo` works on a temporary copy of [examples/lending-desk](./examples/lending-desk) and
deletes it afterwards. To map your own repository, run the built CLI from inside that repository:

```bash
cd /path/to/your-repo
node /path/to/archmap/dist/cli/bin.js init
node /path/to/archmap/dist/cli/bin.js scan
```

See [docs/quickstart.md](./docs/quickstart.md) for queries, the viewer and its 60-node limit,
and named views, and [docs/flagship-demo.md](./docs/flagship-demo.md) for the demo. A static
homepage that presents a recorded run of the demo is in [site/](./site/index.html).

## Status

M0–M7 are delivered: schema and universal scanning, TypeScript/Python/Markdown/data adapters,
proposal/MCP workflows, the interactive Viewer, rules/CI/workspace fixture evidence, and M7
rule-integrity/deterministic-output hardening. One bounded, real-repository pilot has now been
completed with a sanitized scorecard; it is not a claim that every framework or repository shape
is supported.

The working plan is in [PLAN.md](./PLAN.md).
For the pilot safety boundary, command sequence, and evidence template, see
[docs/pilot-runbook.md](./docs/pilot-runbook.md) and
[docs/pilot-scorecard.md](./docs/pilot-scorecard.md). The first result is in
[docs/pilots/atypical-life-club-2026-07-17.md](./docs/pilots/atypical-life-club-2026-07-17.md).

## Development

```bash
npm ci
npm run check      # typecheck + lint + test + build (single verification command)
```

From inside the checkout, the source entry point scans the current repository:

```bash
npx tsx src/cli/bin.ts init                 # create .archmap/
npx tsx src/cli/bin.ts scan                 # build snapshot, nodes, derived index
npx tsx src/cli/bin.ts status --json        # changed files + stale nodes
npx tsx src/cli/bin.ts capabilities --json  # adapters and environment
npx tsx src/cli/bin.ts validate <manifest>  # validate a manifest (YAML or JSON)
```

`.archmap/` holds repository-owned, reviewable YAML (`project.yaml`, `snapshot.yaml`,
`nodes/`); `.archmap/cache/` is disposable and rebuildable. The authoritative structural
contract is [schema/manifest.schema.json](./schema/manifest.schema.json), mirrored by
`src/model/types.ts` for typed consumers. Example manifests live under `fixtures/`.

Tracked named views live at `.archmap/views/<id>.yaml`. A view can narrow the graph to nodes
whose tracked `scope.files` paths start byte-for-byte with one of its `include.path_prefixes`:

```yaml
schema_version: 1
id: api
include:
  path_prefixes:
    - src/api/
```

Nodes without a tracked scope, and nodes whose paths do not match, are omitted; edges remain
only when both endpoints are visible. Use a trailing `/` when the prefix is intended to select a
directory rather than similarly named paths. Export a tracked view with:

```bash
npx tsx src/cli/bin.ts export --format svg --view api
```

## Initial product boundary

- Local-first and repository-owned data
- Git-aware incremental scanning and stale detection
- Universal repository scanning plus language/domain adapters
- Structured evidence for every generated claim and relationship
- CLI and MCP as primary interfaces
- Interactive architecture, evidence, diff, and impact views
- No cloud service in the first release

## Working conventions

- Code, schemas, identifiers, and public interfaces use English.
- Planning and collaboration documents may use Chinese while the project is private.
- `main` is the stable line; implementation work uses one short-lived feature branch per
  independently reviewable unit.
- Generated caches are disposable. Repository-tracked manifests are reviewable and
  migratable.

## License

[MIT](./LICENSE). Contributions: [CONTRIBUTING.md](./CONTRIBUTING.md). Security reports:
[SECURITY.md](./SECURITY.md).
