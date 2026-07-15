/**
 * `archmap mcp` — run the stdio MCP server: the query tools plus the guarded proposal
 * transaction (`apply_proposal` carries no approval channel).
 *
 * The one long-running command: on success stdout belongs to the JSON-RPC channel until the
 * client disconnects, so it returns a `CommandOutput` only when the invocation itself is a
 * usage error (which is reported on stderr, before the transport starts).
 */

import { serveMcpStdio } from '../mcp/server.js';
import { parseOptions, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

export async function runMcpCommand(
  args: string[],
  ctx: CommandContext,
): Promise<CommandOutput | null> {
  const opts = parseOptions(args, []);
  if (opts.error) return usageError(false, opts.error);
  if (opts.positionals.length > 0) return usageError(false, 'mcp takes no positional arguments');

  await serveMcpStdio(ctx);
  return null;
}
