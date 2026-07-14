/**
 * `archmap impact <path...> [--base <ref>] [--json]`
 *
 * Reports the nodes affected by changing the given files: the scoping nodes, the transitive
 * closure of nodes that import/reference/read/write them, and the repository parent view. `--base <ref>` derives
 * the changed-file set from `git diff --name-only <ref>` instead of explicit paths.
 */

import { spawnSync } from 'node:child_process';
import { impactFor } from '../query/queries.js';
import { parseOptions, takeOptionValue, usageError } from './options.js';
import { loadScannedProject, toRepoPaths } from './query-support.js';
import type { CommandContext, CommandOutput } from './types.js';

function changedSince(root: string, base: string): string[] | null {
  const res = spawnSync('git', ['diff', '--name-only', '--no-renames', base], {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status !== 0) return null;
  return res.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

export function runImpactCommand(args: string[], ctx: CommandContext): CommandOutput {
  const baseOpt = takeOptionValue(args, '--base');
  if (baseOpt.error) return usageError(args.includes('--json'), baseOpt.error);

  const opts = parseOptions(baseOpt.rest, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;

  const loaded = loadScannedProject(ctx, json);
  if (!loaded.ok) return loaded.out;

  let paths: string[];
  if (baseOpt.value !== undefined) {
    if (opts.positionals.length > 0) {
      return usageError(json, 'impact takes either paths or --base, not both');
    }
    const changed = changedSince(loaded.root, baseOpt.value);
    if (changed === null) return usageError(json, `cannot compute git diff against "${baseOpt.value}"`);
    paths = changed;
  } else {
    if (opts.positionals.length === 0) {
      return usageError(json, 'impact requires at least one file path (or --base <ref>)');
    }
    paths = toRepoPaths(loaded.root, ctx.cwd, opts.positionals);
  }

  const result = impactFor(loaded.baseline.nodes, paths);

  if (json) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ schema_version: 1, command: 'impact', requested_paths: paths, ...result }, null, 2)}\n`,
      stderr: '',
    };
  }

  const lines = [
    `impact of ${paths.join(', ')} — ${result.impacted.length} node(s) affected`,
    ...result.impacted.map((e) => `  [${e.kind}] ${e.title}  (${e.reason})`),
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
