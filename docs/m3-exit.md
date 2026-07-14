# M3 exit audit

This audit closes only PLAN M3: the Python, Markdown, and YAML/JSON deterministic adapter
slice. It does not add schema vocabulary, proposal/MCP behavior, Viewer behavior, or rules.

## Evidence map

| PLAN M3 contract | Automated evidence |
| --- | --- |
| Python module, symbol, import, entry point, CLI, route, and pytest mapping | `test/analyze-python.test.ts` keeps the parser-level golden; `test/m3-exit.test.ts` exercises `pipeline/`, `tests/test_transform.py`, the Click command, and FastAPI routes through compiled `init + scan`. |
| Markdown links, headings, decisions, and ledgers | `test/analyze-markdown.test.ts` keeps the parser-level golden; the mixed fixture links code/data from `docs/README.md`, classifies `docs/decisions/ADR-0001.md`, and classifies `docs/ledger/2026.md`. |
| YAML/JSON sources, configuration, outputs, and Python transform evidence | `test/analyze-data.test.ts` covers bounded structure and literal-path rules; the mixed fixture connects `config/pipeline.json`, `data/source.yaml`, `pipeline/transform.py`, `data/output.json`, and `docs/report.md`. |
| Meaningful Python and non-code nodes | The mixed-fixture golden validates the complete compiled-CLI manifest; the read-only self-scan asserts Python, Markdown, YAML, and JSON per-file nodes without relying on exact repository file counts. |
| Data source, transform, and report relations carry evidence | The cross-adapter test resolves every emitted claim/relation through compiled `archmap evidence` and checks every target, provenance record, and capability version. |
| Dynamic or heuristic relations stay uncertain | Python reads/writes, Click/FastAPI publications, and unresolved dynamic paths are asserted as `partial`; only parser-resolved imports and existing Markdown targets are `known`. |

## Milestone invariants

The compiled mixed-repository tests additionally prove:

- the complete schema-v1 manifest validates with unique ids and no dangling targets;
- clean evidence cites the real fixture commit, while dirty Python/Markdown/YAML/JSON scans
  cite `working-tree` and change only the relevant per-file semantic slice when commit identity
  is ignored;
- context includes the target, cross-adapter neighbors, parent directory, repository root,
  and budget reasons; impact walks incoming relations;
- repeated external identities produce one stable external node;
- a full unchanged rescan is byte-identical, `scan --changed` is a no-op, and `status` is clean;
- human and agent enrichment survive rescans, while deletion of an enriched source fails
  closed without changing any tracked model bytes;
- the repository self-scan uses `discover` plus the projection pipeline twice, validates the
  result, compares byte-identical output, and proves Git status and `.archmap` are untouched.

The repository-wide safety matrix remains owned by the pre-M3 regressions: secrets,
vendor/build directories, symlinks, wrong path types, oversized/binary files, unknown CLI
options, context budgets, impact semantics, evidence lookup, deterministic imports, and
transactional scan failure are all included by `npm run check`.

## Verification

Run the focused milestone checks first, followed by the complete gate and package audit:

```sh
npx vitest run test/m3-exit.test.ts
npm run check
npm pack --dry-run
git diff --check
```

A repository-wide NUL-byte sweep is also required before delivery because ordinary text
linters do not prove that a generated or fixture file is non-binary.

## Manual read-only trial on another repository

Build ArchMap, set `TARGET` to another local repository, and run the following from this
checkout. The script only discovers and projects in memory: it never calls `init`, `scan`, or
any store writer, and therefore never creates `TARGET/.archmap`.

```sh
npm run build
TARGET=/absolute/path/to/another/repository node --input-type=module <<'NODE'
import {
  analyzeDataAssets,
  analyzeMarkdownDocuments,
  analyzeModules,
  analyzePythonModules,
  buildNodes,
  buildSnapshot,
  discover,
  TYPESCRIPT_CAPABILITY,
  toCanonicalJson,
  UNIVERSAL_CAPABILITY,
  validateManifest,
} from './dist/index.js';

const root = process.env.TARGET;
if (!root) throw new Error('set TARGET to a repository path');
const scan = {
  max_file_bytes: 5_000_000,
  exclude_dirs: [
    '.git', '.archmap', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
    'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', 'target',
    '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.gradle',
    '.terraform', '.idea', '.vscode',
  ],
  secret_globs: [
    '.env', '.env.*', '*.pem', '*.key', '*.pfx', '*.p12', '*.keystore', '*.jks',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.pypirc', 'credentials',
  ],
};

const discovery = discover(root, scan);
const structural = buildNodes(discovery.files, 'read-only-trial');
const typescript = analyzeModules(discovery);
const data = analyzeDataAssets(discovery, scan);
const python = analyzePythonModules(discovery, undefined, data.nodes);
const markdown = analyzeMarkdownDocuments(discovery, [
  ...structural, ...typescript, ...data.nodes, ...python.nodes,
]);
const nodes = [...structural, ...typescript, ...data.nodes, ...python.nodes, ...markdown.nodes];
const snapshot = buildSnapshot(discovery, [
  UNIVERSAL_CAPABILITY,
  TYPESCRIPT_CAPABILITY,
  python.capability,
  markdown.capability,
  data.capability,
]);
const validation = validateManifest({ schema_version: 1, capabilities: snapshot.capabilities, nodes });
console.log(toCanonicalJson({ validation, file_count: snapshot.files.length, node_count: nodes.length }));
if (!validation.valid) process.exitCode = 1;
NODE
```

Verify separately that `git -C "$TARGET" status --porcelain` is unchanged and that no
`$TARGET/.archmap` directory appeared.
