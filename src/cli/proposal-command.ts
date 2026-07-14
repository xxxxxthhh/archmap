/** Read-only `archmap proposal validate|preview <file> [--json]`. */

import { resolve } from 'node:path';
import { toCanonicalJson } from '../model/canonical.js';
import {
  loadProposalFile,
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

export type ProposalCommandMode = 'validate' | 'preview';

interface ProposalCommandReport extends ProposalEvaluation {
  schema_version: 1;
  command: `proposal ${ProposalCommandMode}`;
  path: string;
}

export function runProposalCommand(
  mode: ProposalCommandMode,
  args: string[],
  ctx: CommandContext,
): CommandOutput {
  const opts = parseOptions(args, ['--json']);
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

  // Schema verdicts precede all baseline reads, matching the proposal validation contract.
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
  if (mode !== 'validate' && mode !== 'preview') {
    return usageError(args.includes('--json'), 'proposal expects `validate` or `preview`');
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
  evaluation: ProposalEvaluation,
  json: boolean,
): CommandOutput {
  const report: ProposalCommandReport = {
    schema_version: 1,
    command: `proposal ${mode}`,
    path,
    ...evaluation,
  };
  if (json) {
    return { exitCode: evaluation.verdict === 'valid' ? 0 : 1, stdout: toCanonicalJson(report), stderr: '' };
  }
  if (evaluation.verdict === 'valid') {
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
