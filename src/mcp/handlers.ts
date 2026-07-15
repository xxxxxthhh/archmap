/**
 * MCP tool handlers: transport adaptation only.
 *
 * Every handler reloads the validated tracked baseline and then calls the exact same exported
 * query or proposal functions the CLI commands call, returning their payload unchanged. There
 * is no MCP copy of any query, authorization, or transaction semantic — a payload difference
 * between a tool and its CLI command is a defect, not a variant. The proposal tools are thin
 * adapters: `propose_update` only stamps the baseline fingerprint, `validate_proposal` reuses
 * the CLI's validator, and `apply_proposal` reuses the CLI's transaction with no approval
 * channel, so a human-decision conflict can only ever return `requires-approval`.
 */

import { isAbsolute } from 'node:path';
import { contextFor, DEFAULT_CONTEXT_BUDGET, evidenceFor, nodeFor } from '../query/queries.js';
import { loadTrackedProject, toRepoPaths } from '../query/project.js';
import { impactReport, projectSummaryReport, staleNodesReport, workItemsReport } from '../query/reports.js';
import { searchArchitecture } from '../query/search.js';
import {
  applyProposal,
  computeModelHash,
  PROPOSAL_SCHEMA_VERSION,
  validateProposal,
} from '../proposal/index.js';
import { computeStatus } from '../scan/status.js';
import { findTool, ToolInputError, validateToolArguments } from './tools.js';

export interface QueryContext {
  cwd: string;
}

/**
 * A tool answer: either the domain payload the matching CLI JSON command would print, or the
 * fail-closed reason it could not be produced (unscanned, incomplete, or invalid model).
 */
export type ToolResult = { ok: true; payload: unknown } | { ok: false; error: string };

/**
 * Repository-relative paths, resolved exactly as the CLI resolves its path arguments. A path
 * that leaves the repository is rejected rather than answered with an empty result: the server
 * is a process boundary and must not accept a query it cannot ground in the tracked model.
 */
function repoPaths(root: string, cwd: string, paths: string[]): string[] {
  const normalized = toRepoPaths(root, cwd, paths);
  normalized.forEach((path, i) => {
    if (path === '..' || path.startsWith('../') || isAbsolute(path)) {
      throw new ToolInputError(`path escapes the repository root: ${paths[i]}`);
    }
  });
  return normalized;
}

/**
 * Run one tool call. Throws `ToolInputError` for an unknown tool or rejected arguments; returns
 * a fail-closed result for an unusable repository; never partially succeeds.
 */
export function callTool(name: string, args: unknown, ctx: QueryContext): ToolResult {
  const tool = findTool(name);
  const params = validateToolArguments(tool, args);

  // Reloaded per request: a scan completed by another process since the last call is visible to
  // the next one, and no answer can come from a process-stale model.
  const loaded = loadTrackedProject(ctx.cwd);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { root, baseline } = loaded;

  switch (tool.name) {
    case 'project_summary':
      return { ok: true, payload: projectSummaryReport(computeStatus(root), ctx.cwd) };
    case 'context_for_files': {
      const paths = repoPaths(root, ctx.cwd, params.paths as string[]);
      const budget = (params.budget as number | undefined) ?? DEFAULT_CONTEXT_BUDGET;
      return { ok: true, payload: contextFor(baseline.nodes, paths, budget) };
    }
    case 'impact_analysis':
      return { ok: true, payload: impactReport(baseline.nodes, repoPaths(root, ctx.cwd, params.paths as string[])) };
    case 'search_architecture': {
      const query = params.query as string;
      if (query.trim().length === 0) {
        throw new ToolInputError(`invalid arguments for tool "${tool.name}": /query must not be blank`);
      }
      return { ok: true, payload: searchArchitecture(baseline.nodes, query) };
    }
    case 'get_node':
      return { ok: true, payload: nodeFor(baseline.nodes, params.id as string) };
    case 'get_evidence':
      return { ok: true, payload: evidenceFor(baseline.nodes, params.id as string) };
    case 'list_stale_nodes':
      return { ok: true, payload: staleNodesReport(computeStatus(root)) };
    case 'get_update_work_items':
      return { ok: true, payload: workItemsReport(baseline.nodes, computeStatus(root)) };
    case 'propose_update':
      // Fingerprint only: stamp the live baseline identity onto the operations. Authorization,
      // conflict detection, and the transaction all happen later in validate_proposal /
      // apply_proposal via the one shared library, never here.
      return {
        ok: true,
        payload: {
          proposal_schema_version: PROPOSAL_SCHEMA_VERSION,
          base_commit: baseline.snapshot.base_commit,
          model_hash: computeModelHash(baseline),
          operations: params.operations,
        },
      };
    case 'validate_proposal':
      return { ok: true, payload: validateProposal(params.proposal, baseline) };
    case 'apply_proposal':
      // No approval argument exists on this tool, so applyProposal runs with the empty approval
      // set: a conflicting proposal returns `requires-approval` with stable ids and writes
      // nothing. Approval is possible only through the CLI.
      return { ok: true, payload: applyProposal(root, params.proposal) };
    default:
      throw new ToolInputError(`unknown tool "${tool.name}"`);
  }
}
