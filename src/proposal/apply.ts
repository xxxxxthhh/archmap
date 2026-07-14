import type { Node } from '../model/types.js';
import { readTrackedBaseline } from '../scan/baseline.js';
import {
  buildIndex,
  publishNodes,
  writeIndex,
} from '../store.js';
import { StoreError, StoreFormatError, StorePreconditionError } from '../store-errors.js';
import { computeModelHash } from './fingerprint.js';
import { prepareProposalApply } from './evaluate.js';
import { validateProposalStructure } from './schema.js';
import type { ProposalApplyResult, ProposalApplyWarning, ProposalError } from './types.js';

export interface ApplyProposalOptions {
  approvals?: readonly string[];
}

/**
 * Revalidate and atomically publish a proposal against the live tracked baseline. The
 * proposal is accepted as unknown input on purpose: direct library callers cannot bypass
 * schema, fingerprint, authorization, conflict, projection, or manifest validation.
 */
export function applyProposal(
  root: string,
  input: unknown,
  options: ApplyProposalOptions = {},
): ProposalApplyResult {
  // Schema must win before any live store read, including for direct library callers.
  const structure = validateProposalStructure(input);
  if (!structure.valid) return refusal('invalid', structure.errors);

  const approvals = options.approvals ?? [];
  if (!Array.isArray(approvals) || approvals.some((approval) => typeof approval !== 'string')) {
    return refusal('invalid', [{
      path: '/approvals',
      code: 'approval-set',
      message: 'approvals must be an array of conflict IDs',
    }]);
  }

  const baseline = readTrackedBaseline(root);
  if (!baseline) throw new StoreFormatError('not scanned yet; run `archmap scan` first');

  const prepared = prepareProposalApply(structure.proposal, baseline, approvals);
  if (prepared.evaluation.verdict !== 'valid' || prepared.projected === undefined) {
    return {
      ...prepared.evaluation,
      changed_paths: [],
      cache_refreshed: false,
      warnings: [],
    };
  }

  const changedPaths = prepared.evaluation.diff?.map((entry) => entry.path) ?? [];
  if (changedPaths.length === 0) {
    return refusal('invalid', [{
      path: '/operations',
      code: 'invalid-projection',
      message: 'proposal produces no tracked node changes',
    }]);
  }

  try {
    publishNodes(root, prepared.projected, computeModelHash(baseline));
  } catch (error) {
    if (error instanceof StorePreconditionError) {
      return refusal('invalid', [{
        path: '/model_hash',
        code: 'stale-base',
        message: 'tracked baseline changed after validation and before publication',
      }]);
    }
    throw error;
  }
  const warnings = refreshCache(root, prepared.projected);
  return {
    verdict: 'applied',
    errors: [],
    conflicts: [],
    changed_paths: changedPaths,
    cache_refreshed: warnings.length === 0,
    warnings,
  };
}

function refreshCache(root: string, nodes: Node[]): ProposalApplyWarning[] {
  try {
    writeIndex(root, buildIndex(nodes));
    return [];
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    return [{
      code: 'cache-refresh',
      message: 'derived cache refresh failed after tracked node publish; the cache remains disposable and rebuildable',
    }];
  }
}

function refusal(
  verdict: 'invalid' | 'forbidden' | 'requires-approval',
  errors: ProposalError[],
): ProposalApplyResult {
  return {
    verdict,
    errors,
    conflicts: [],
    changed_paths: [],
    cache_refreshed: false,
    warnings: [],
  };
}
