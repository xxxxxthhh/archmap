/** `archmap work-items [--json]` — one deterministic read-only item per status-stale node. */

import { toCanonicalJson } from '../model/canonical.js';
import { workItemsReport } from '../query/reports.js';
import { computeStatus } from '../scan/status.js';
import { parseOptions, usageError } from './options.js';
import { loadScannedProject } from './query-support.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runWorkItemsCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;
  if (opts.positionals.length > 0) return usageError(json, 'work-items takes no positional arguments');

  const loaded = loadScannedProject(ctx, json);
  if (!loaded.ok) return loaded.out;
  const result = workItemsReport(loaded.baseline.nodes, computeStatus(loaded.root));

  if (json) {
    return {
      exitCode: 0,
      stdout: toCanonicalJson({ schema_version: 1, command: 'work-items', ...result }),
      stderr: '',
    };
  }

  if (result.items.length === 0) {
    return { exitCode: 0, stdout: 'no stale work items\n', stderr: '' };
  }
  const lines = [
    `${result.items.length} stale work item(s)`,
    ...result.items.map(
      (item) =>
        `  [${item.node.kind}] ${item.node.title} — ${item.reasons.map((reason) => reason.kind).join(', ')}`,
    ),
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
