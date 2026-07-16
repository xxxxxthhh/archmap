/** `archmap check [--strict] [--json]` — read-only architecture and freshness checks. */

import { evaluateCheck } from '../check/evaluate.js';
import { formatCheckMarkdown } from '../check/format.js';
import { loadRules } from '../check/rules.js';
import { toCanonicalJson } from '../model/canonical.js';
import { computeStatus } from '../scan/status.js';
import { StoreError } from '../store-errors.js';
import { parseOptions, usageError } from './options.js';
import { loadScannedProject } from './query-support.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runCheckCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json', '--strict']);
  if (opts.error) return usageError(opts.json, opts.error);
  if (opts.positionals.length > 0) return usageError(opts.json, 'check takes no positional arguments');

  const loaded = loadScannedProject(ctx, opts.json);
  if (!loaded.ok) return loaded.out;

  try {
    const report = evaluateCheck(
      loaded.baseline.nodes,
      computeStatus(loaded.root),
      loadRules(loaded.root),
      opts.flags.has('--strict'),
    );
    return {
      exitCode: report.summary.blocking > 0 ? 1 : 0,
      stdout: opts.json ? toCanonicalJson(report) : formatCheckMarkdown(report),
      stderr: '',
    };
  } catch (error) {
    if (error instanceof StoreError) return usageError(opts.json, error.message);
    throw error;
  }
}
