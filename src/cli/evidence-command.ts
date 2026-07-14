/**
 * `archmap evidence <node-or-claim> [--json]`
 *
 * Returns the re-verifiable evidence bundle for a node, claim, or relation id — the pointers
 * (path, symbol, blob hash, commit, analyzer) that make every claim/relation navigable to
 * source (PLAN 3.2, M2 exit criteria).
 */

import { evidenceFor } from '../query/queries.js';
import { parseOptions, usageError } from './options.js';
import { loadScannedProject } from './query-support.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runEvidenceCommand(args: string[], ctx: CommandContext): CommandOutput {
  const opts = parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;

  if (opts.positionals.length !== 1) {
    return usageError(json, 'evidence expects exactly one node, claim, or relation id');
  }
  const target = opts.positionals[0]!;

  const loaded = loadScannedProject(ctx, json);
  if (!loaded.ok) return loaded.out;

  const result = evidenceFor(loaded.baseline.nodes, target);

  if (json) {
    const exitCode = result.found ? 0 : 1;
    return {
      exitCode,
      stdout: `${JSON.stringify({ schema_version: 1, command: 'evidence', ...result }, null, 2)}\n`,
      stderr: '',
    };
  }

  if (!result.found) {
    return { exitCode: 1, stdout: '', stderr: `no node, claim, or relation with id "${target}"\n` };
  }
  const lines = [
    `evidence for ${result.matched} ${target} — ${result.evidence.length} entr(y/ies)`,
    ...result.evidence.map(
      (e) => `  ${e.path}${e.symbol ? `#${e.symbol}` : ''}  @${e.commit}  [${e.analyzer}@${e.analyzer_version}]  ${e.blob_hash}`,
    ),
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
