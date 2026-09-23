# Contributing

Thanks for your interest in ArchMap. Issues and pull requests are welcome.

## Set up

```bash
npm ci
npm run check        # typecheck, lint, unit/integration tests, build
npm run test:e2e     # browser tests for the viewer (needs `npx playwright install chromium` once)
```

Node.js 20 or newer and Git are required. Python 3 is needed for the Python analyzer tests.

`npm test` runs Vitest with `--maxWorkers=2`. Many tests start real Git and CLI subprocesses, and
running them on every core at once can push individual tests past Vitest's default 5-second
timeout. Two workers keep the suite reliable without raising timeouts or skipping tests.

## Before opening a pull request

- Keep each pull request to one reviewable change, on a short-lived branch from `main`.
- Run `npm run check`. If you touched `viewer/`, also run `npm run test:e2e`.
- Add or update tests for behaviour you change. Prefer tests that exercise the real CLI or the
  public model over tests that restate the implementation.
- If your change alters scan output, regenerate the homepage demo data with
  `npm run demo -- --write-site` and include the diff (see
  [docs/flagship-demo.md](docs/flagship-demo.md)).
- Do not add dependencies without discussing it in an issue first.

## Ground rules for the model

These are the project's core contracts; changes that loosen them need an issue and a clear
rationale first.

- Scanner output is deterministic: scanning an unchanged tree must produce no diff.
- Every generated claim and relation carries evidence. Heuristic findings are `partial`, never
  presented as known.
- AI-generated content enters the model only through validated proposals; it never overwrites
  scanner facts or human decisions directly.
- The schemas in `schema/` are the authoritative contract; `src/model/types.ts` mirrors them.
- Local-first: no network access, telemetry, or upload paths in the CLI or viewer.

## Conventions

- Code, schemas, identifiers, and public interfaces use English.
- Match the surrounding style; ESLint and TypeScript strict mode are enforced in CI.

## Reporting security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
