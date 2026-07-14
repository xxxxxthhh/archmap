/**
 * `archmap node <id> [--json]`
 *
 * Returns the tracked node document for an id — the same payload the MCP `get_node` tool
 * answers with. A miss is a domain answer (exit 1), not a usage error.
 */

import { nodeFor } from '../query/queries.js';
import { parseOptions, usageError } from './options.js';
import { loadScannedProject } from './query-support.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runNodeCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;

  if (opts.positionals.length !== 1) {
    return usageError(json, 'node expects exactly one node id');
  }
  const target = opts.positionals[0]!;

  const loaded = loadScannedProject(ctx, json);
  if (!loaded.ok) return loaded.out;

  const result = nodeFor(loaded.baseline.nodes, target);

  if (json) {
    return {
      exitCode: result.found ? 0 : 1,
      stdout: `${JSON.stringify({ schema_version: 1, command: 'node', ...result }, null, 2)}\n`,
      stderr: '',
    };
  }

  if (!result.found) {
    return { exitCode: 1, stdout: '', stderr: `no node with id "${target}"\n` };
  }
  const node = result.node!;
  const lines = [
    `[${node.kind}] ${node.title} (${node.id})`,
    `  ${node.claims.length} claim(s), ${node.relations.length} relation(s), ` +
      `${(node.scope?.files ?? []).length} file(s) in scope`,
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
