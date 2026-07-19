/**
 * Deterministic display-graph projection.
 *
 * `projectModel` turns the validated tracked node set into a `DisplayGraph`: a small, ordered,
 * side-effect-free structure the Mermaid/Markdown/SVG renderers consume. It is the single place
 * the view's filters and `collapse_below` granularity are applied, so every format renders the
 * *same* graph.
 *
 * Invariants it preserves (Issue #28 contract):
 *   - stable node ids and relation ids pass through unchanged;
 *   - relation certainty (`known` | `partial` | `unknown`) is preserved and never promoted —
 *     renderers style non-`known` edges so they can never read as deterministic;
 *   - claim `fact` vs `inference`, claim status (incl. `stale`), and provenance actor pass
 *     through so no inference is presented as a fact;
 *   - only safe pointers/hashes travel with evidence (path, symbol, blob hash) — never bulk
 *     repository content.
 *
 * Determinism: nodes and edges are sorted by id, claims/evidence keep authored order, and no
 * wall-clock or environment data is read. Two runs over equal input produce an equal graph.
 */

import type {
  Actor,
  ClaimStatus,
  ClaimType,
  Node,
  NodeKind,
  RelationCertainty,
  RelationType,
} from '../model/types.js';
import { effectiveFilters, type StructuralKind, type ViewDefinition } from '../views/types.js';
import { neutralizeText } from './sanitize.js';

/** Structural containment depth. Deeper = finer granularity; used by `collapse_below`. */
const STRUCTURAL_DEPTH: Record<StructuralKind, number> = { system: 0, component: 1, module: 2 };

/** Kinds outside the structural hierarchy (dependency/data boundaries) are never collapsed. */
function structuralDepth(kind: NodeKind): number | undefined {
  return kind in STRUCTURAL_DEPTH ? STRUCTURAL_DEPTH[kind as StructuralKind] : undefined;
}

/** A safe evidence pointer: locates and verifies source, but carries no repository content. */
export interface DisplayEvidence {
  path: string;
  symbol?: string;
  blob_hash: string;
}

/** A projected claim: enough to distinguish fact/inference/stale/provenance, no more. */
export interface DisplayClaim {
  id: string;
  type: ClaimType;
  status: ClaimStatus;
  actor: Actor;
  text: string;
  evidence: DisplayEvidence[];
}

/** A projected node. `title` is the display label; `id` is the stable identity. */
export interface DisplayNode {
  id: string;
  slug: string;
  kind: NodeKind;
  title: string;
  claims: DisplayClaim[];
}

/** A projected directed edge. `certainty` is preserved so renderers never promote it. */
export interface DisplayEdge {
  id: string;
  source: string;
  target: string;
  type: RelationType;
  certainty: RelationCertainty;
  actor?: Actor;
}

/** Counts describing what the projection kept vs hid — surfaced in every export. */
export interface DisplayStats {
  total_nodes: number;
  visible_nodes: number;
  collapsed_nodes: number;
  total_edges: number;
  visible_edges: number;
}

/** The ordered, deterministic graph every renderer consumes. */
export interface DisplayGraph {
  view: {
    id: string;
    include: { node_kinds: NodeKind[]; edge_types: RelationType[]; path_prefixes?: string[] };
    collapse_below?: StructuralKind;
    layout: 'left-to-right' | 'top-to-bottom';
  };
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  stats: DisplayStats;
}

function projectEvidence(evidence: { path: string; symbol?: string; blob_hash: string }[]): DisplayEvidence[] {
  // Evidence pointers are free-text in the model too, so neutralize them like every other field
  // that reaches an export — a malicious path or hash must not smuggle markup into Markdown.
  return evidence.map((ev) => ({
    path: neutralizeText(ev.path),
    ...(ev.symbol ? { symbol: neutralizeText(ev.symbol) } : {}),
    blob_hash: neutralizeText(ev.blob_hash),
  }));
}

function projectNode(node: Node): DisplayNode {
  // `title` and claim `text` are untrusted free text; neutralize them at the projection so no
  // export format — nor the --json envelope built from this graph — can emit active markup or
  // bulk content. Stable ids, kind, type, status, and provenance actor pass through unchanged.
  return {
    id: node.id,
    slug: node.slug,
    kind: node.kind,
    title: neutralizeText(node.title),
    claims: node.claims.map((claim) => ({
      id: claim.id,
      type: claim.type,
      status: claim.status,
      actor: claim.provenance.actor,
      text: neutralizeText(claim.text),
      evidence: projectEvidence(claim.evidence),
    })),
  };
}

/**
 * Project the validated `nodes` through `view`. A node is visible when its kind is allowed by
 * `include.node_kinds`, at least one tracked scope file starts with an optional path prefix, and
 * it is not collapsed by `collapse_below`; an edge is visible when its type is allowed and both
 * endpoints are visible.
 */
export function projectModel(nodes: Node[], view: ViewDefinition): DisplayGraph {
  const filters = effectiveFilters(view);
  const collapseDepth = filters.collapseBelow ? STRUCTURAL_DEPTH[filters.collapseBelow] : undefined;

  const kindAllowed = (node: Node): boolean => filters.nodeKinds.has(node.kind);
  const pathPrefixes = filters.pathPrefixes;
  const pathAllowed = (node: Node): boolean =>
    pathPrefixes === undefined ||
    (node.scope?.files ?? []).some((path) => pathPrefixes.some((prefix) => path.startsWith(prefix)));
  const collapsed = (node: Node): boolean => {
    if (collapseDepth === undefined) return false;
    const depth = structuralDepth(node.kind);
    // Only structural nodes deeper than the threshold collapse; boundary kinds always stay.
    return depth !== undefined && depth > collapseDepth;
  };

  const eligibleNodes = nodes.filter((node) => kindAllowed(node) && pathAllowed(node));
  const visibleNodes = eligibleNodes.filter((node) => !collapsed(node));
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const collapsedCount = eligibleNodes.length - visibleNodes.length;

  let totalEdges = 0;
  const edges: DisplayEdge[] = [];
  for (const node of nodes) {
    for (const relation of node.relations) {
      totalEdges += 1;
      if (!filters.edgeTypes.has(relation.type)) continue;
      if (!visibleIds.has(node.id) || !visibleIds.has(relation.target)) continue;
      edges.push({
        id: relation.id,
        source: node.id,
        target: relation.target,
        type: relation.type,
        certainty: relation.certainty,
        ...(relation.provenance ? { actor: relation.provenance.actor } : {}),
      });
    }
  }

  const displayNodes = visibleNodes.map(projectNode).sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));

  return {
    view: {
      id: view.id,
      include: {
        node_kinds: [...filters.nodeKinds],
        edge_types: [...filters.edgeTypes],
        ...(pathPrefixes !== undefined ? { path_prefixes: [...pathPrefixes] } : {}),
      },
      ...(filters.collapseBelow ? { collapse_below: filters.collapseBelow } : {}),
      layout: filters.layout,
    },
    nodes: displayNodes,
    edges,
    stats: {
      total_nodes: nodes.length,
      visible_nodes: displayNodes.length,
      collapsed_nodes: collapsedCount,
      total_edges: totalEdges,
      visible_edges: edges.length,
    },
  };
}
