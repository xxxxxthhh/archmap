# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. If that option is not available, open a public issue that asks the
maintainers for a private reporting channel, without including any details of the problem.

A useful report includes the affected version or commit, the command or API involved, steps to
reproduce, and what an attacker could achieve. This is a volunteer project; there is no
guaranteed response time, and reports are handled as maintainer time allows.

## Supported versions

ArchMap has not had a numbered release. Fixes are made on `main` only.

## Scope

ArchMap is designed to run locally against repositories you choose to scan. Areas where a
report is especially relevant:

- The loopback viewer (`archmap serve`): binding beyond `127.0.0.1`, cross-origin access, or
  script injection from repository content.
- Path handling: reading or writing outside the target repository or its `.archmap/` directory.
- The MCP server and proposal workflow: changes to the tracked model that bypass validation.
- Secret handling: files matching the configured secret patterns being read or recorded.

The default secret exclusions match file names only; they are not content-level scanning. Review
`.archmap/project.yaml` before scanning sensitive repositories.
