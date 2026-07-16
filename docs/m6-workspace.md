# M6 workspace aggregate index

`archmap workspace index <member...>` builds a disposable summary of already-scanned child
projects. It is intended for a repository that owns a set of independently initialized
Archmap projects, not for cross-repository inference.

```sh
archmap workspace index services/api sites/docs --json
```

The current project is the workspace owner. It must have a valid scanned baseline, and every
member argument must be a unique, repository-relative descendant directory with its own valid
scanned baseline. Absolute paths, `.`/`..` segments, missing directories, and symlinked path
components fail closed with exit `2`.

On success the command writes `.archmap/cache/workspace-index.json` in the owner and prints the
same versioned JSON with `--json`, or a Markdown summary by default. The cache contains only:

- the normalized member path;
- member project id and name;
- a SHA-256 identity of the persisted snapshot and nodes;
- the persisted snapshot's `dirty` flag and node count; and
- deterministic aggregate member/node totals.

The command reads member baseline files only. It does not scan member source trees, calculate
their current worktree freshness, infer cross-project relations, or write any member artifact.
`snapshot.dirty` therefore means the state recorded when that member was last scanned.

`workspace-index.json` is disposable cache data. Deleting it and rerunning the exact command
recreates byte-identical output from unchanged baselines. Invalid input is rejected before the
owner cache is changed.
