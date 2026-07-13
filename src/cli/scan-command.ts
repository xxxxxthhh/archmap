/**
 * `archmap scan [--changed] [--json]`
 *
 * Rebuilds the snapshot, nodes, and derived index. `--changed` exits early when nothing has
 * changed since the last snapshot. Full scans are byte-deterministic, so re-scanning an
 * unchanged tree produces no tracked diff.
 */

import { runScan } from '../scan/scanner.js';
import { resolveProjectRoot } from '../store.js';
import { StoreError } from '../store-errors.js';
import { parseOptions, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runScanCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json', '--changed']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;
  if (opts.positionals.length > 0) {
    return usageError(json, 'scan takes no positional arguments');
  }

  let result;
  try {
    const root = resolveProjectRoot(ctx.cwd);
    if (!root) {
      return usageError(json, 'not an archmap project; run `archmap init` first');
    }
    result = runScan(root, { changed: opts.flags.has('--changed') });
  } catch (err) {
    if (err instanceof StoreError) return usageError(json, err.message);
    throw err;
  }

  if (result.validationErrors) {
    if (json) {
      const report = {
        schema_version: 1 as const,
        command: 'scan' as const,
        wrote: false,
        changed: result.changed,
        errors: result.validationErrors,
      };
      return { exitCode: 1, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
    }
    const body = result.validationErrors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    return {
      exitCode: 1,
      stdout: '',
      stderr: `scan aborted: generated model failed contract validation\n${body}\n`,
    };
  }

  if (json) {
    const report = {
      schema_version: 1 as const,
      command: 'scan' as const,
      wrote: result.wrote,
      changed: result.changed,
      base_commit: result.snapshot.base_commit,
      dirty: result.snapshot.dirty,
      files: result.snapshot.files.length,
      nodes: result.nodeCount,
      excluded: result.snapshot.excluded_counts,
    };
    return { exitCode: 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
  }

  if (!result.changed) {
    return { exitCode: 0, stdout: 'no changes since last scan\n', stderr: '' };
  }
  const commit = result.snapshot.base_commit ?? '(no commit)';
  const dirty = result.snapshot.dirty ? ' (dirty tree)' : '';
  return {
    exitCode: 0,
    stdout: `scanned ${result.snapshot.files.length} file(s) into ${result.nodeCount} node(s) at ${commit}${dirty}\n`,
    stderr: '',
  };
}
