# archmap

`archmap` is a local-first, evidence-backed repository map for coding agents and humans.

The project turns source code, configuration, documentation, and Git history into a
queryable architecture model. Static analyzers produce deterministic facts; AI may add
interpretations only through evidence-backed proposals; human decisions remain protected.
Interactive diagrams, impact views, MCP tools, CLI output, and CI reports are projections
of the same model rather than independent sources of truth.

## Status

M0–M6 are delivered: schema and universal scanning, TypeScript/Python/Markdown/data adapters,
proposal/MCP workflows, the interactive Viewer, and rules/CI/workspace/pilot evidence. M7 is
planned as a narrow rule-integrity and deterministic-output hardening milestone; implementation
has not started.

The working plan is in [PLAN.md](./PLAN.md).

## Development

```bash
npm install
npm run check      # typecheck + lint + test + build (single verification command)
```

Scan a repository and inspect its architecture model:

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
