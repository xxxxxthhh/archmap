/**
 * `archmap status [--json]`
 *
 * Read-only. Reports whether the working tree matches the last snapshot, what changed, and
 * which nodes are stale. Exit code 1 signals a dirty tree so CI can gate on it.
 */

import { computeStatus } from '../scan/status.js';
import { resolveProjectRoot } from '../store.js';
import { StoreError } from '../store-errors.js';
import { parseOptions, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runStatusCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;
  if (opts.positionals.length > 0) {
    return usageError(json, 'status takes no positional arguments');
  }

  let status;
  try {
    const root = resolveProjectRoot(ctx.cwd);
    if (!root) {
      return usageError(json, 'not an archmap project; run `archmap init` first');
    }
    status = computeStatus(root);
  } catch (err) {
    if (err instanceof StoreError) return usageError(json, err.message);
    throw err;
  }

  if (json) {
    const report = { schema_version: 1 as const, command: 'status' as const, ...status };
    const exitCode = !status.scanned || !status.clean ? 1 : 0;
    return { exitCode, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
  }

  if (!status.scanned) {
    return { exitCode: 1, stdout: 'no snapshot yet; run `archmap scan`\n', stderr: '' };
  }
  if (status.clean) {
    return {
      exitCode: 0,
      stdout: `clean: ${status.file_count} file(s), ${status.node_count} node(s) up to date\n`,
      stderr: '',
    };
  }

  const d = status.diff!;
  const lines = [
    `dirty: ${d.added.length} added, ${d.modified.length} modified, ${d.deleted.length} deleted, ${d.renamed.length} renamed`,
    ...d.added.map((p) => `  + ${p}`),
    ...d.modified.map((p) => `  ~ ${p}`),
    ...d.deleted.map((p) => `  - ${p}`),
    ...d.renamed.map((r) => `  → ${r.from} -> ${r.to}`),
  ];
  if (status.stale_nodes.length > 0) {
    lines.push(`stale nodes: ${status.stale_nodes.join(', ')}`);
  }
  if (status.drift.length > 0) {
    lines.push(`model drift: ${status.drift.join(', ')} (run \`archmap scan\`)`);
  }
  return { exitCode: 1, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
