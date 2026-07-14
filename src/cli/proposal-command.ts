/** `archmap proposal validate|preview|apply <file> [--approve <id>]... [--json]`. */

import { resolve } from 'node:path';
import { toCanonicalJson } from '../model/canonical.js';
import {
  loadProposalFile,
  applyProposal,
  previewProposal,
  ProposalLoadError,
  validateProposal,
  validateProposalStructure,
  type ProposalError,
  type ProposalEvaluation,
} from '../proposal/index.js';
import { readTrackedBaseline } from '../scan/baseline.js';
import { resolveProjectRoot } from '../store.js';
import { StoreError } from '../store-errors.js';
import { parseOptions, usageError } from './options.js';
import type { CommandContext, CommandOutput } from './types.js';

export type ProposalCommandMode = 'validate' | 'preview' | 'apply';

interface ProposalCommandReport {
  schema_version: 1;
  command: `proposal ${ProposalCommandMode}`;
  path: string;
  verdict: string;
  errors: ProposalEvaluation['errors'];
  conflicts: ProposalEvaluation['conflicts'];
  diff?: ProposalEvaluation['diff'];
  changed_paths?: string[];
  cache_refreshed?: boolean;
  warnings?: Array<{ code: string; message: string }>;
}

export function runProposalCommand(
  mode: ProposalCommandMode,
  args: string[],
  ctx: CommandContext,
): CommandOutput {
  const applyOptions = mode === 'apply' ? parseApplyOptions(args) : undefined;
  const opts = applyOptions ?? parseOptions(args, ['--json']);
  if (opts.error) return usageError(opts.json, opts.error);
  const { json } = opts;
  if (opts.positionals.length !== 1) {
    return usageError(json, `proposal ${mode} expects exactly one proposal path`);
  }
  const path = opts.positionals[0]!;

  let root: string | null;
  try {
    root = resolveProjectRoot(ctx.cwd);
  } catch (error) {
    if (error instanceof StoreError) return usageError(json, error.message);
    throw error;
  }
  if (!root) return usageError(json, 'not an archmap project; run `archmap init` first');

  let input: unknown;
  try {
    input = loadProposalFile(resolve(ctx.cwd, path), root);
  } catch (error) {
    if (error instanceof ProposalLoadError) {
      return domainOutput(mode, path, invalidLoad(error.message), json);
    }
    throw error;
  }

  if (mode === 'apply') {
    try {
      return domainOutput(mode, path, applyProposal(root, input, { approvals: applyOptions!.approvals }), json);
    } catch (error) {
      if (error instanceof StoreError) return usageError(json, error.message);
      throw error;
    }
  }

  // Schema verdicts precede all baseline reads, matching the read-only validation contract.
  const structure = validateProposalStructure(input);
  if (!structure.valid) {
    return domainOutput(mode, path, { verdict: 'invalid', errors: structure.errors, conflicts: [] }, json);
  }

  let baseline;
  try {
    baseline = readTrackedBaseline(root);
  } catch (error) {
    if (error instanceof StoreError) return usageError(json, error.message);
    throw error;
  }
  if (!baseline) return usageError(json, 'not scanned yet; run `archmap scan` first');

  const evaluation = mode === 'preview'
    ? previewProposal(structure.proposal, baseline)
    : validateProposal(structure.proposal, baseline);
  return domainOutput(mode, path, evaluation, json);
}

export function runProposalDispatch(args: string[], ctx: CommandContext): CommandOutput {
  const [mode, ...rest] = args;
  if (mode !== 'validate' && mode !== 'preview' && mode !== 'apply') {
    return usageError(args.includes('--json'), 'proposal expects `validate`, `preview`, or `apply`');
  }
  return runProposalCommand(mode, rest, ctx);
}

function invalidLoad(message: string): ProposalEvaluation {
  const error: ProposalError = { path: '/', code: 'proposal-load', message };
  return { verdict: 'invalid', errors: [error], conflicts: [] };
}

function domainOutput(
  mode: ProposalCommandMode,
  path: string,
  evaluation: ProposalEvaluation | ReturnType<typeof applyProposal>,
  json: boolean,
): CommandOutput {
  const report: ProposalCommandReport = {
    schema_version: 1,
    command: `proposal ${mode}`,
    path,
    ...evaluation,
  };
  if (json) {
    return {
      exitCode: evaluation.verdict === 'valid' || evaluation.verdict === 'applied' ? 0 : 1,
      stdout: toCanonicalJson(report),
      stderr: '',
    };
  }
  if (evaluation.verdict === 'valid' || evaluation.verdict === 'applied') {
    return { exitCode: 0, stdout: `${evaluation.verdict}: ${path}\n`, stderr: '' };
  }
  const details = evaluation.errors.map((error) => `  ${error.path}: ${error.message}`);
  const conflicts = evaluation.conflicts.map((conflict) => `  ${conflict.id}: ${conflict.kind}`);
  return {
    exitCode: 1,
    stdout: '',
    stderr: `${evaluation.verdict}: ${path}\n${[...details, ...conflicts].join('\n')}\n`,
  };
}

interface ParsedApplyOptions extends ReturnType<typeof parseOptions> {
  approvals: string[];
}

function parseApplyOptions(args: string[]): ParsedApplyOptions {
  const approvals: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--approve') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        const parsed = parseOptions(rest, ['--json']);
        return {
          ...parsed,
          json: parsed.json || args.includes('--json'),
          approvals,
          error: '--approve requires a value',
        };
      }
      approvals.push(value);
      i += 1;
    } else if (arg.startsWith('--approve=')) {
      const value = arg.slice('--approve='.length);
      if (value.length === 0) {
        const parsed = parseOptions(rest, ['--json']);
        return {
          ...parsed,
          json: parsed.json || args.includes('--json'),
          approvals,
          error: '--approve requires a value',
        };
      }
      approvals.push(value);
    } else {
      rest.push(arg);
    }
  }
  return { ...parseOptions(rest, ['--json']), approvals };
}
