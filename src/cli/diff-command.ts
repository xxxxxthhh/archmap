/**
 * `archmap diff <base> [head] [--json]`
 *
 * Deterministic, read-only commit-to-commit architecture diff of the tracked `.archmap` model:
 * nodes, relations, and claims added / removed / changed (plus claims that went stale). Refs
 * are resolved with explicit argv and read from the git object store, so the command never
 * touches the caller's working tree. `head` defaults to `HEAD`; `diff X X` is the empty result.
 */

import { architectureDiff } from '../diff/diff.js';
import { formatDiff } from '../diff/format.js';
import { resolveProjectRoot } from '../store.js';
import { StoreError } from '../store-errors.js';
import { isGitRepo } from '../scan/git.js';
import { parseOptions, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runDiffCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;

  if (opts.positionals.length < 1 || opts.positionals.length > 2) {
    return usageError(json, 'diff requires a base ref and an optional head ref: diff <base> [head]');
  }
  const [base, head = 'HEAD'] = opts.positionals;

  const root = resolveProjectRoot(ctx.cwd);
  if (!root) return usageError(json, 'not an archmap project; run `archmap init` first');
  if (!isGitRepo(root)) return usageError(json, 'not a git repository; `archmap diff` needs committed history');

  let report;
  try {
    report = architectureDiff(root, base!, head);
  } catch (err) {
    // Unknown/invalid refs and incompatible tracked states fail closed as structured exit-2
    // errors; anything else is an unexpected fault and stays fatal.
    if (err instanceof StoreError) return usageError(json, err.message);
    throw err;
  }

  if (json) {
    return { exitCode: 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
  }
  return { exitCode: 0, stdout: formatDiff(report), stderr: '' };
}
