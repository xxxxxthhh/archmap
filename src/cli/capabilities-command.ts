/**
 * `archmap capabilities [--json]`
 *
 * Reports the adapter registry and this repository's environment. Unsupported adapters are
 * listed explicitly so gaps are visible rather than silent (PLAN 3.5, M1 exit criteria).
 */

import { getAdapterRegistry } from '../capabilities.js';
import { isGitRepo } from '../scan/git.js';
import { parseOptions, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runCapabilitiesCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;
  if (opts.positionals.length > 0) {
    return usageError(json, 'capabilities takes no positional arguments');
  }

  const environment = { git: isGitRepo(ctx.cwd) };
  const adapters = getAdapterRegistry();

  if (json) {
    const report = {
      schema_version: 1 as const,
      command: 'capabilities' as const,
      environment,
      adapters,
    };
    return { exitCode: 0, stdout: `${JSON.stringify(report, null, 2)}\n`, stderr: '' };
  }

  const lines = [
    `environment: git ${environment.git ? 'available' : 'unavailable'}`,
    'adapters:',
    ...adapters.map(
      (c) => `  ${c.id}@${c.version}  ${c.status}${c.provides ? `  (${c.provides.join(', ')})` : ''}`,
    ),
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
