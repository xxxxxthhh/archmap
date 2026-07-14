/** Read-only stale-node work items composed from existing status, context, and evidence seams. */

import type { Node } from '../model/types.js';
import type { StatusResult } from '../scan/status.js';
import { containingNodeId } from '../scan/nodes.js';
import {
  contextFor,
  DEFAULT_CONTEXT_BUDGET,
  evidenceFor,
  type ContextOmission,
  type ContextSelection,
} from './queries.js';

export type WorkItemReason =
  | { kind: 'added'; path: string }
  | { kind: 'modified'; path: string }
  | { kind: 'deleted'; path: string }
  | { kind: 'renamed'; from: string; to: string }
  | { kind: 'model-drift'; drift: string };

export interface WorkItemEvidenceBundle {
  budget: number;
  used_tokens: number;
  requested_paths: string[];
  included: ContextSelection[];
  omitted: ContextOmission[];
  evidence_targets: Array<{
    target: string;
    found: boolean;
    matched?: 'node' | 'claim' | 'relation';
    evidence_count: number;
  }>;
  omitted_count: number;
  omitted_reason?: 'budget-exceeded';
}

export interface WorkItem {
  node: Node;
  reasons: WorkItemReason[];
  evidence_bundle: WorkItemEvidenceBundle;
}

export interface WorkItemsResult {
  items: WorkItem[];
}

export const DEFAULT_WORK_ITEM_EVIDENCE_BUDGET = DEFAULT_CONTEXT_BUDGET;

function reasonsFor(node: Node, status: StatusResult): WorkItemReason[] {
  const diff = status.diff;
  if (!diff) return [];
  const scoped = new Set(node.scope?.files ?? []);
  const root = node.kind === 'system';
  const reasons: WorkItemReason[] = [];

  for (const path of diff.added) {
    if (root || node.id === containingNodeId(path)) reasons.push({ kind: 'added', path });
  }
  for (const path of diff.modified) {
    if (root || scoped.has(path)) reasons.push({ kind: 'modified', path });
  }
  for (const path of diff.deleted) {
    if (root || scoped.has(path)) reasons.push({ kind: 'deleted', path });
  }
  for (const rename of diff.renamed) {
    if (root || scoped.has(rename.from) || node.id === containingNodeId(rename.to)) {
      reasons.push({ kind: 'renamed', from: rename.from, to: rename.to });
    }
  }
  for (const drift of status.drift) reasons.push({ kind: 'model-drift', drift });
  return reasons;
}

function reasonPaths(reasons: WorkItemReason[], node: Node): string[] {
  const paths = new Set<string>();
  for (const reason of reasons) {
    if (reason.kind === 'renamed') {
      paths.add(reason.from);
      paths.add(reason.to);
    } else if (reason.kind !== 'model-drift') {
      paths.add(reason.path);
    }
  }
  if (paths.size === 0) {
    for (const path of node.scope?.files ?? []) paths.add(path);
  }
  return [...paths].sort();
}

/**
 * Build exactly one item for each status-reported stale node. The full tracked node is the
 * current claim/relation summary; contextual nodes and their re-verifiable evidence remain
 * hard-capped by the existing context budget and explicitly account for omissions.
 */
export function workItemsFor(
  nodes: Node[],
  status: StatusResult,
  budget = DEFAULT_WORK_ITEM_EVIDENCE_BUDGET,
): WorkItemsResult {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const items = status.stale_nodes.map((id): WorkItem => {
    const node = byId.get(id);
    if (!node) throw new Error(`status referenced unknown stale node ${id}`);
    const reasons = reasonsFor(node, status);
    if (reasons.length === 0) throw new Error(`status stale node ${id} has no attributable reason`);

    const context = contextFor(nodes, reasonPaths(reasons, node), budget);
    const omittedCount = context.omitted.length;
    const evidenceTargets = context.included.map((selection) => {
      const result = evidenceFor(nodes, selection.node.id);
      return {
        target: result.target,
        found: result.found,
        ...(result.matched ? { matched: result.matched } : {}),
        evidence_count: result.evidence.length,
      };
    });
    return {
      node,
      reasons,
      evidence_bundle: {
        ...context,
        evidence_targets: evidenceTargets,
        omitted_count: omittedCount,
        ...(omittedCount > 0 ? { omitted_reason: 'budget-exceeded' as const } : {}),
      },
    };
  });
  return { items };
}
