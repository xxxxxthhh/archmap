/**
 * `archmap context <path...> [--budget <tokens>] [--json]`
 *
 * Selects the minimal relevant, evidence-backed context for the given files, capped at a
 * token budget, and explains why each node was chosen (PLAN 8.1, M2 exit criteria).
 */

import { contextFor, DEFAULT_CONTEXT_BUDGET } from '../query/queries.js';
import { parseOptions, takeOptionValue, usageError } from './options.js';
import { loadScannedProject, toRepoPaths } from './query-support.js';
import type { CommandContext, CommandOutput } from './types.js';

export function runContextCommand(args: string[], ctx: CommandContext): CommandOutput {
  const budgetOpt = takeOptionValue(args, '--budget');
  if (budgetOpt.error) return usageError(args.includes('--json'), budgetOpt.error);

  const opts = parseOptions(budgetOpt.rest, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;

  if (opts.positionals.length === 0) {
    return usageError(json, 'context requires at least one file path');
  }

  let budget = DEFAULT_CONTEXT_BUDGET;
  if (budgetOpt.value !== undefined) {
    budget = Number(budgetOpt.value);
    if (!Number.isInteger(budget) || budget <= 0) {
      return usageError(json, 'budget must be a positive integer');
    }
  }

  const loaded = loadScannedProject(ctx, json);
  if (!loaded.ok) return loaded.out;

  const paths = toRepoPaths(loaded.root, ctx.cwd, opts.positionals);
  const result = contextFor(loaded.baseline.nodes, paths, budget);

  if (json) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ schema_version: 1, command: 'context', ...result }, null, 2)}\n`,
      stderr: '',
    };
  }

  const lines = [
    `context for ${paths.join(', ')} — ${result.used_tokens}/${result.budget} tokens, ` +
      `${result.included.length} node(s) included, ${result.omitted.length} omitted`,
    ...result.included.map(
      (s) =>
        `  [${s.node.kind}] ${s.node.title}  (${s.reason}; ~${s.tokens} tok, ` +
        `${s.node.claims.length} claim(s), ${s.node.relations.length} relation(s))`,
    ),
    ...result.omitted.map((s) => `  omitted [${s.kind}] ${s.title}  (${s.reason}; ~${s.tokens} tok, over budget)`),
  ];
  return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
}
