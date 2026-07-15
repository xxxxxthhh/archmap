/** `archmap search <query> [--json]` — deterministic exact/substring architecture search. */

import { toCanonicalJson } from '../model/canonical.js';
import { searchArchitecture } from '../query/search.js';
import { parseOptions, usageError } from './options.js';
import { loadScannedProject } from './query-support.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runSearchCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;
  if (opts.positionals.length !== 1 || opts.positionals[0]!.trim().length === 0) {
    return usageError(json, 'search expects exactly one non-empty query');
  }

  const loaded = loadScannedProject(ctx, json);
  if (!loaded.ok) return loaded.out;
  const result = searchArchitecture(loaded.baseline.nodes, opts.positionals[0]!);

  if (json) {
    return {
      exitCode: result.found ? 0 : 1,
      stdout: toCanonicalJson({ schema_version: 1, command: 'search', ...result }),
      stderr: '',
    };
  }
  if (!result.found) {
    return { exitCode: 1, stdout: '', stderr: `no architecture nodes match "${result.query}"\n` };
  }
  const lines = [
    `${result.matches.length} architecture node(s) match "${result.query}"`,
    ...result.matches.map(
      (match) =>
        `  [${match.node.kind}] ${match.node.title} (${match.match}: ${match.matched_fields.join(', ')})`,
    ),
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
