# archmap

`archmap` is a local-first, evidence-backed repository map for coding agents and humans.

The project turns source code, configuration, documentation, and Git history into a
queryable architecture model. Static analyzers produce deterministic facts; AI may add
interpretations only through evidence-backed proposals; human decisions remain protected.
Interactive diagrams, impact views, MCP tools, CLI output, and CI reports are projections
of the same model rather than independent sources of truth.

## Status

Early implementation. The M0 slice (schema contract + `archmap validate`) is in place; no
repository scanning, MCP, or Viewer yet.

The working plan is in [PLAN.md](./PLAN.md).

## Development

```bash
npm install
npm run check      # typecheck + lint + test + build (single verification command)
```

Validate a manifest file (YAML or JSON) against the v1 schema:

```bash
npx tsx src/cli/bin.ts validate fixtures/valid/manifest.yaml
npx tsx src/cli/bin.ts validate <manifest> --json
```

The authoritative structural contract is [schema/manifest.schema.json](./schema/manifest.schema.json);
`src/model/types.ts` mirrors it for typed consumers. Example manifests live under `fixtures/`.

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
