/**
 * The composed read-only query payloads. A payload that both the CLI and the MCP server answer
 * with is built exactly once, here: the CLI adds only its `schema_version`/`command` envelope
 * and the MCP server adds none, so the two surfaces cannot drift apart without changing this
 * file. Single-query payloads (`context`, `search`, `node`, `evidence`) need no composition and
 * are taken straight from their exported query functions by both surfaces.
 */

import { getAdapterRegistry } from '../capabilities.js';
import type { Capability, Node } from '../model/types.js';
import { isGitRepo } from '../scan/git.js';
import type { StatusResult } from '../scan/status.js';
import { impactFor, type ImpactResult } from './queries.js';
import { workItemsFor, type WorkItemsResult } from './work-items.js';

export interface CapabilitiesReport {
  environment: { git: boolean };
  adapters: readonly Capability[];
}

/** `status` and `capabilities` answer disjoint questions, so their union is lossless. */
export type ProjectSummaryReport = StatusResult & CapabilitiesReport;

export type ImpactReport = { requested_paths: string[] } & ImpactResult;

export interface StaleNodesReport {
  stale_nodes: string[];
}

export type WorkItemsReport = {
  base_commit: string | null;
  snapshot_dirty: boolean;
  clean: boolean;
} & WorkItemsResult;

export function capabilitiesReport(cwd: string): CapabilitiesReport {
  return { environment: { git: isGitRepo(cwd) }, adapters: getAdapterRegistry() };
}

export function projectSummaryReport(status: StatusResult, cwd: string): ProjectSummaryReport {
  return { ...status, ...capabilitiesReport(cwd) };
}

export function impactReport(nodes: Node[], paths: string[]): ImpactReport {
  return { requested_paths: paths, ...impactFor(nodes, paths) };
}

/** The stale-node projection of status — the same ids `status` reports, nothing else. */
export function staleNodesReport(status: StatusResult): StaleNodesReport {
  return { stale_nodes: status.stale_nodes };
}

export function workItemsReport(nodes: Node[], status: StatusResult): WorkItemsReport {
  return {
    base_commit: status.base_commit,
    snapshot_dirty: status.dirty,
    clean: status.clean,
    ...workItemsFor(nodes, status),
  };
}
