# M6-01 architecture checks

`archmap check` is the first M6 vertical slice. It is read-only: it reuses the validated tracked
model and current freshness calculation, reads local rule decisions, and produces a deterministic
report. It does not scan, write a cache, modify source files, or invoke a network/process boundary.

```bash
archmap check
archmap check --json
archmap check --strict --json
```

The normal output is Markdown for CI summaries or PR bodies; `--json` is the stable v1 machine
report. Exit `0` means there is no blocking violation, exit `1` means a blocking violation, and
exit `2` means the tracked model or rule input could not be safely read/validated. Invalid inputs
produce no partial report.

## Initial rule contract

Optional rules live in `.archmap/rules/*.yaml`. A v1 rule is a path-scoped prohibition:

```yaml
schema_version: 1
id: ui-must-not-access-db
severity: error # warning | error
from:
  path: src/ui/**
disallow:
  edge_type: imports
  target:
    path: src/db/**
```

Both source and target match when at least one of their scoped repository-relative files matches
the declared glob. `*` matches inside one path segment; `**` is a complete segment that spans zero
or more segments. Rule documents reject unknown fields, unsupported relation types, duplicate IDs,
path traversal, and malformed YAML.

A known relation gets the rule's declared severity. A `partial` or `unknown` relation is always
reported as a warning so incomplete analyzer output is never promoted into a deterministic blocking
fact. `--strict` promotes every warning to blocking for repositories that want a conservative CI
gate. A stale tracked model is always a blocking `stale-model` violation.

The report shows rule IDs, node IDs, relation IDs/types/certainty, and matched paths. Markdown
formats all model-derived strings as inert code spans; JSON keeps the same information in a
versioned record.

## Deliberate boundary

This slice only provides `disallow` dependency rules. Required-hop rules, new external-integration
checks, workspace aggregation, PR artifact upload, trial repositories, and M6 quality/performance
reports remain separate M6 work items.
