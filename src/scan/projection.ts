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

import { analyzeModules } from '../analyze/model.js';
import { analyzePythonModules } from '../analyze/python-model.js';
import { analyzeMarkdownDocuments } from '../analyze/markdown.js';
import { TYPESCRIPT_CAPABILITY, UNIVERSAL_CAPABILITY } from '../capabilities.js';
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

/** A claim the scanner owns and rebuilds each scan (a deterministic analyzer fact). */
const isAnalyzerClaim = (claim: Node['claims'][number]): boolean => claim.provenance.actor === 'analyzer';

/**
 * A relation the scanner owns, decided by explicit, schema-backed provenance: only a relation
 * authored by the analyzer (`provenance.actor === 'analyzer'`) is rebuilt/replaced each scan.
 * A manual/agent relation (any other actor) — and a legacy M1 relation with no provenance at
 * all — is preserved. This is a contract field, not an id-naming convention, so a manual
 * relation cannot be misclassified by how it happens to be named.
 */
const isAnalyzerRelation = (rel: Node['relations'][number]): boolean => rel.provenance?.actor === 'analyzer';

const hasManualEnrichment = (node: Node): boolean =>
  node.claims.some((c) => !isAnalyzerClaim(c)) || node.relations.some((r) => !isAnalyzerRelation(r));

/**
 * Carry non-scanner-owned enrichment onto the freshly computed node by stable id. The scanner
 * owns node structure, analyzer (`fact`) claims, and analyzer relations; it rebuilds those
 * each scan. Human/agent claims (any non-`analyzer` actor) and manually authored relations
 * (attributed to a non-scanner analyzer) are interpretation — preserved so rescanning never
 * silently deletes them.
 */
export function mergeEnrichment(structural: Node[], tracked: Node[]): Node[] {
  const priorById = new Map(tracked.map((n) => [n.id, n]));
  return structural.map((node) => {
    const prior = priorById.get(node.id);
    if (!prior) return node;
    const enrichmentClaims = prior.claims.filter((c) => !isAnalyzerClaim(c));
    const manualRelations = prior.relations.filter((r) => !isAnalyzerRelation(r));
    if (enrichmentClaims.length === 0 && manualRelations.length === 0) return node;
    return {
      ...node,
      claims: [...node.claims, ...enrichmentClaims],
      relations: [...node.relations, ...manualRelations],
    };
  });
}

/**
 * Fail closed if scanning would drop human/agent enrichment: a tracked node carrying manual
 * claims or relations whose stable id is absent from the prospective set (e.g. a removed or
 * renamed directory/file). The scanner must not auto-migrate or silently delete human
 * interpretations — the user reconciles those node files manually first.
 */
export function assertNoEnrichmentLoss(tracked: Node[], prospective: Node[]): void {
  const kept = new Set(prospective.map((n) => n.id));
  const dropped = tracked.filter((n) => !kept.has(n.id) && hasManualEnrichment(n));
  if (dropped.length > 0) {
    throw new StoreFormatError(
      `refusing to scan: it would drop human-authored claims/relations on node(s) ` +
        `${dropped.map((n) => n.id).join(', ')} whose structure no longer exists ` +
        `(e.g. a removed or renamed directory/file). Reconcile or remove those node files manually first.`,
    );
  }
}

/**
 * The model a scan of `discovery` would produce: universal structural nodes plus language
 * adapter (module/external) nodes, with human enrichment preserved on stable ids.
 */
export function prospectiveModel(
  discovery: Discovery,
  projectName: string,
  tracked: Node[],
): ProspectiveModel {
  const structural = buildNodes(discovery.files, projectName);
  const analyzed = analyzeModules(discovery);
  const python = analyzePythonModules(discovery);
  const markdown = analyzeMarkdownDocuments(discovery, [...structural, ...analyzed, ...python.nodes]);
  return {
    snapshot: buildSnapshot(discovery, [
      UNIVERSAL_CAPABILITY,
      TYPESCRIPT_CAPABILITY,
      python.capability,
      markdown.capability,
    ]),
    nodes: mergeEnrichment([...structural, ...analyzed, ...python.nodes, ...markdown.nodes], tracked),
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
