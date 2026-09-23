# Flagship demo

The flagship demo runs the real ArchMap CLI through one maintenance loop on a small, invented
TypeScript service, and can record the results for the static homepage in `site/`.

## Run it

From a source checkout:

```bash
npm ci
npm run build
npm run demo
```

`npm run demo` runs `node scripts/flagship-demo.mjs`, which uses the built CLI at
`dist/cli/bin.js`. Options:

| Option | Effect |
| --- | --- |
| *(none)* | Print each command and a one-line result, then delete the temporary copy. |
| `--keep` | Keep the temporary copy and print its path so you can run more commands in it. Delete it yourself afterwards. |
| `--write-site` | Also rewrite `site/demo-data.js` from this run. |

Pass options through npm with `--`, for example `npm run demo -- --keep`.

## What it does

1. Creates a new directory with `mkdtemp` under the operating system's temp directory
   (`archmap-demo-XXXXXX/lending-desk`) and copies `examples/lending-desk` into it.
2. Initializes a fresh Git repository there and commits the sample with a fixed demo identity
   and date, so commit SHAs are identical on every machine.
3. Runs, in that copy:
   - `archmap init`
   - `archmap scan`
   - `archmap status` (clean)
   - `archmap context src/loans/policy.ts`
   - `archmap impact src/loans/policy.ts`
   - `archmap evidence <id>` for `src/loans/service.ts` (known imports) and `src/http/routes.ts`
     (heuristic routes, recorded as `partial`)
4. Edits `src/loans/policy.ts` (`LOAN_DAYS` 14 → 21) and runs `archmap status` again. It exits
   with code 1 and lists the file and the stale nodes. `archmap impact --base HEAD` derives the
   same changed-file set from Git.
5. Commits the edit, runs `archmap scan` again, and confirms `archmap status` is clean at the new
   commit.

Every command runs with `--json`; the script fails if any command does not print JSON.

## Safety boundary

- The script takes **no path argument**. Its only input is the checked-in
  `examples/lending-desk`, which it copies and never writes to.
- All Git and ArchMap commands run inside the new copy. The script initializes a repository
  rooted exactly at the copy and stops if Git reports a different top level, so nothing can be
  staged into an enclosing repository.
- Child processes get no inherited `GIT_*` variables and no user or system Git configuration
  (`GIT_CONFIG_GLOBAL` points at the null device, `GIT_CONFIG_NOSYSTEM=1`), so hooks, signing,
  or a caller's `GIT_DIR` cannot redirect or change anything.
- Cleanup removes only a directory that this process created. The script records each directory
  it creates and refuses to delete any other path, including another `archmap-demo-*` directory.
- The script makes no network requests.

## The sample

`examples/lending-desk` is a synthetic tool-library service written for this demo. It is small
enough to read in a few minutes and chosen to show both what ArchMap resolves and where it stops:

- `src/loans/policy.ts` is imported by the service, which the HTTP routes, the reminder job, and
  the CLI entry point depend on, so `impact` has a real reverse-dependency chain to report.
- `src/http/routes.ts` registers routes on a router, and `src/notify/reminders.ts` calls
  `fetch`. Both are detected heuristically and recorded as `partial` relations.
- `src/plugins/load.ts` imports modules by a computed name. ArchMap parses syntax only, so no
  edge is recorded for those modules. This is an intentional example of a static-graph limit.
- `package.json`, `tsconfig.json`, `README.md`, and `docs/architecture.md` are picked up by the
  data and Markdown analyzers.

It has no dependencies and is not meant to be run.

## Homepage data

`site/demo-data.js` is generated, not written by hand:

```bash
npm run demo -- --write-site
```

The record contains the sample sources, every command with its exit code and parsed JSON
output, and the tracked node files from the first scan and the rescan. Before writing, the
script replaces the temporary copy's absolute path with `<disposable-copy>`, the home directory
with `~`, and the random project id that `init` generates with `proj_<random-at-init>`. With
fixed commit identity and dates, the output is byte-identical across runs on the same ArchMap
version.

Reproducibility depends on the sample's exact bytes, because the commit SHAs and blob hashes are
computed from them. `.gitattributes` pins `examples/lending-desk/**` and `site/demo-data.js` to
LF line endings, so a checkout with `core.autocrlf=true` still gets byte-identical files. This
was checked with an `autocrlf=true` clone on macOS; the demo has not been run on Windows. Editing
the sample, changing the demo identity or dates, or a different ArchMap version all change the
output.

`test/flagship-demo.test.ts` runs the same walkthrough and fails if the checked-in
`site/demo-data.js` differs from what the current code produces. When an ArchMap change alters
scan output, regenerate the file with the command above and review the diff.

## Viewing the homepage

`site/` is a static page with no build step and no external requests. Open `site/index.html`
directly in a browser, or serve the directory from any static file server. It presents the
recorded run; it does not scan anything.

## Limits shown by the demo

- The recording is from one synthetic sample. It demonstrates the workflow; it is not a
  benchmark or a support claim for any framework.
- Impact is a static reverse-dependency walk over recorded relations. Code reached through
  computed imports, dependency injection, or runtime configuration is not included.
- `partial` relations are heuristic and should be confirmed in source.
- `context` token counts are estimates (about four characters per token).
