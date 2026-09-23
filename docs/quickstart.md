# Quickstart

ArchMap is not published to npm. Run it from a source checkout.

## Requirements

- Node.js 20 or newer
- Git
- Optional: Python 3, for the Python analyzer. Without it, `archmap capabilities` reports the
  Python adapter as unsupported, and Python files are still listed in the snapshot but not
  analyzed.

## Build from a clean clone

```bash
git clone https://github.com/xxxxxthhh/archmap.git
cd archmap
npm ci
npm run build
```

`npm run build` compiles the CLI to `dist/`. The entry point is `dist/cli/bin.js`; the examples
below call it as `node /path/to/archmap/dist/cli/bin.js`. If you prefer a short command, add an
alias yourself, for example `alias archmap="node /path/to/archmap/dist/cli/bin.js"`.

## Try the bundled example

```bash
npm run demo
```

This runs the maintenance loop on the synthetic `examples/lending-desk` sample in a new temporary
directory and deletes that directory at the end. See [flagship-demo.md](./flagship-demo.md) for
what it does and what it never touches.

## Map your own repository

ArchMap works on the **Git repository that contains your current directory**. `init` finds the
repository's top level with `git rev-parse --show-toplevel` and creates `.archmap/` there; every
other command locates that `.archmap/` from the current directory. So change into the repository
you want to map, and call the ArchMap build by its absolute path:

```bash
cd /path/to/your-repo
node /path/to/archmap/dist/cli/bin.js init        # creates .archmap/project.yaml
node /path/to/archmap/dist/cli/bin.js scan        # writes .archmap/snapshot.yaml and .archmap/nodes/
node /path/to/archmap/dist/cli/bin.js status      # clean, or which files and nodes are stale
```

Running these commands from inside the ArchMap checkout would map ArchMap itself, not your
repository.

`init` and `scan` write only under `.archmap/` in the target repository. `.archmap/cache/` is
disposable; the rest is plain YAML meant to be reviewed and, if you want, committed. If you are
evaluating ArchMap on a repository you do not want to modify, clone it to a temporary location
first and run ArchMap in the clone.

Before scanning, look at `scan.exclude_dirs` and `scan.secret_globs` in `.archmap/project.yaml`.
The default secret exclusions match file names such as `.env` and `*.pem`; they do not inspect
file contents.

### Ask questions

Paths are repository-relative, or relative to your current directory.

```bash
node /path/to/archmap/dist/cli/bin.js impact src/api/handler.ts   # modules that depend on the file
node /path/to/archmap/dist/cli/bin.js impact --base main          # same, for files changed since main
node /path/to/archmap/dist/cli/bin.js context src/api/handler.ts  # small evidence-backed context
node /path/to/archmap/dist/cli/bin.js evidence <node-or-relation-id>
node /path/to/archmap/dist/cli/bin.js search handler
```

Add `--json` for machine-readable output. `context` sizes its budget with an estimate of about
four characters per token, not a model tokenizer.

`archmap mcp` serves the same queries over stdio for MCP clients; configure your client to run
`node /path/to/archmap/dist/cli/bin.js mcp` with the target repository as its working directory.

## Open the viewer

```bash
cd /path/to/your-repo
node /path/to/archmap/dist/cli/bin.js serve       # http://127.0.0.1:4830/, loopback only
```

The viewer's layout is deliberately simple and is trusted only up to **60 visible nodes and 120
visible edges**. A larger graph is refused with an explicit message rather than drawn
illegibly. A mid-sized repository easily exceeds that, so narrow the graph with a named view.

### Narrow the graph with a named view

Create `.archmap/views/<id>.yaml` in the target repository. The id must be lowercase letters,
digits, and single hyphens, and must match the file name. For example,
`.archmap/views/cli.yaml`:

```yaml
schema_version: 1
id: cli
include:
  path_prefixes:
    - src/cli/
```

A node stays visible when one of its tracked `scope.files` paths starts with one of the
prefixes, byte for byte. Nodes without file scope are hidden, and an edge is shown only when both
ends are visible. End a directory prefix with `/` so `src/cli/` does not also match
`src/client.ts`. You can also add `node_kinds` (for example `[module]`), `edge_types`, or
`collapse_below`; see [schema/view.schema.json](../schema/view.schema.json).

Then either type `cli` into the **View** field in the viewer and choose **Apply**, or open
`http://127.0.0.1:4830/?view=cli` directly. **Default** returns to the whole graph. If the narrowed
view still has more than 60 nodes, use a longer prefix or split it into several views.

The same view works for exports:

```bash
node /path/to/archmap/dist/cli/bin.js export --format svg --view cli > cli.svg
```

## Keep the map current

After you change code, `status` lists modified files and stale nodes and exits with code 1;
`scan` refreshes the snapshot. In CI, `archmap check` evaluates freshness and any local
architecture rules. Scanning an unchanged tree produces no diff.

## Limits

- The graph is static and syntactic: TypeScript/JavaScript is parsed without type resolution,
  and nothing is traced at runtime. Imports built from computed strings are not recorded.
- Routes, HTTP calls, and CLI commands are heuristic and marked `partial`, as are imports that
  cannot be resolved inside the repository.
- Evidence records the scanned commit only for a clean tree. When the tree has uncommitted
  changes or no commits yet, evidence `commit` is the literal `working-tree`, and the blob hash
  is what identifies the content.
- One real-repository pilot has been completed. That does not mean every framework or repository
  layout is supported; check `archmap capabilities` and look for `partial` relations.
