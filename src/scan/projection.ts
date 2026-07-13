/**
 * The scanner-owned model projection shared by `scan` and `status`, so both use exactly one
 * notion of "what a scan of the current inputs produces" and cannot diverge.
 *
 * Ownership boundary (PLAN 3.1): the scanner owns node *structure* (id/slug/kind/title/scope)
 * and the snapshot. It does NOT own `claims`/`relations` — those are human/agent enrichment.
 * `mergeEnrichment` carries that enrichment forward onto the freshly computed structure by
 * stable node id, so no scan ever drops a human interpretation. All comparisons are canonical
 * (formatting-insensitive), so a whitespace-only difference never splits `status` clean from
 * `scan --changed` changed.
 */

import { toCanonicalYaml } from '../model/canonical.js';
import type { Node } from '../model/types.js';
import { StoreFormatError } from '../store-errors.js';
import { buildNodes } from './nodes.js';
import { buildSnapshot } from './snapshot.js';
import type { Discovery, Snapshot } from './types.js';

export interface ProspectiveModel {
  snapshot: Snapshot;
  nodes: Node[];
}

/**
 * Carry non-scanner-owned enrichment (claims/relations) from the tracked node of the same
 * stable id onto the freshly computed structural node, so rebuilding structure never deletes
 * human interpretations.
 */
export function mergeEnrichment(structural: Node[], tracked: Node[]): Node[] {
  const priorById = new Map(tracked.map((n) => [n.id, n]));
  return structural.map((node) => {
    const prior = priorById.get(node.id);
    if (prior && (prior.claims.length > 0 || prior.relations.length > 0)) {
      return { ...node, claims: prior.claims, relations: prior.relations };
    }
    return node;
  });
}

/**
 * Fail closed if scanning would drop human/agent enrichment: a tracked node that carries
 * claims/relations but whose structural id is absent from the prospective set (e.g. its
 * directory was removed or renamed). The scanner must not auto-migrate or silently delete
 * human interpretations — the user reconciles these node files manually first.
 */
export function assertNoEnrichmentLoss(tracked: Node[], prospective: Node[]): void {
  const kept = new Set(prospective.map((n) => n.id));
  const dropped = tracked.filter(
    (n) => !kept.has(n.id) && (n.claims.length > 0 || n.relations.length > 0),
  );
  if (dropped.length > 0) {
    throw new StoreFormatError(
      `refusing to scan: it would drop human-authored claims/relations on node(s) ` +
        `${dropped.map((n) => n.id).join(', ')} whose structure no longer exists ` +
        `(e.g. a removed or renamed directory). Reconcile or remove those node files manually first.`,
    );
  }
}

/** The model a scan of `discovery` would produce, preserving enrichment on stable ids. */
export function prospectiveModel(
  discovery: Discovery,
  projectName: string,
  tracked: Node[],
): ProspectiveModel {
  return {
    snapshot: buildSnapshot(discovery),
    nodes: mergeEnrichment(buildNodes(discovery.files, projectName), tracked),
  };
}

/**
 * Non-file drift reasons between a prospective model and the tracked model. Files are
 * reported separately as a diff; this covers snapshot metadata and node content (structure
 * plus preserved enrichment), compared canonically.
 */
export function modelDrift(
  prospective: ProspectiveModel,
  trackedSnapshot: Snapshot,
  trackedNodes: Node[],
): string[] {
  const reasons: string[] = [];
  const s = prospective.snapshot;
  if (
    s.base_commit !== trackedSnapshot.base_commit ||
    s.dirty !== trackedSnapshot.dirty ||
    toCanonicalYaml(s.capabilities) !== toCanonicalYaml(trackedSnapshot.capabilities) ||
    toCanonicalYaml(s.excluded_counts) !== toCanonicalYaml(trackedSnapshot.excluded_counts)
  ) {
    reasons.push('snapshot-metadata');
  }
  if (nodesDiffer(prospective.nodes, trackedNodes)) reasons.push('node-structure');
  return reasons;
}

function nodesDiffer(prospective: Node[], tracked: Node[]): boolean {
  if (prospective.length !== tracked.length) return true;
  const byId = new Map(tracked.map((n) => [n.id, toCanonicalYaml(n)]));
  for (const node of prospective) {
    if (byId.get(node.id) !== toCanonicalYaml(node)) return true;
  }
  return false;
}
