/**
 * Read-only queries over the validated tracked model, backing the `context`, `impact`, and
 * `evidence` commands. Pure functions of a node set — no I/O — so they are deterministic and
 * easy to test. Every relation and claim they surface carries its evidence (PLAN 3.2, M2).
 */

import { toCanonicalYaml } from '../model/canonical.js';
import type { Evidence, Node } from '../model/types.js';

interface Graph {
  byId: Map<string, Node>;
  /** node id -> outgoing relation targets and types. */
  outgoing: Map<string, Array<{ id: string; type: Node['relations'][number]['type'] }>>;
  /** node id -> source nodes and relation types that target it. */
  incoming: Map<string, Array<{ id: string; type: Node['relations'][number]['type'] }>>;
}

function buildGraph(nodes: Node[]): Graph {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, Array<{ id: string; type: Node['relations'][number]['type'] }>>();
  const incoming = new Map<string, Array<{ id: string; type: Node['relations'][number]['type'] }>>();
  for (const node of nodes) {
    outgoing.set(node.id, node.relations.map((relation) => ({ id: relation.target, type: relation.type })));
    for (const rel of node.relations) {
      const bucket = incoming.get(rel.target);
      const edge = { id: node.id, type: rel.type };
      if (bucket) bucket.push(edge);
      else incoming.set(rel.target, [edge]);
    }
  }
  return { byId, outgoing, incoming };
}

/** Estimate an agent-context token cost for a node (canonical YAML length / 4). */
function estimateTokens(node: Node): number {
  return Math.max(1, Math.ceil(toCanonicalYaml(node).length / 4));
}

/** Node ids whose scope directly includes any of `paths`. */
function nodesScoping(nodes: Node[], paths: string[]): Node[] {
  const wanted = new Set(paths);
  return nodes.filter((n) => (n.scope?.files ?? []).some((f) => wanted.has(f)));
}

// --- context ----------------------------------------------------------------------------

/** An included context entry: the actual evidence-backed node the agent should read. */
export interface ContextSelection {
  reason: string;
  tokens: number;
  node: Node;
}

/** An excluded entry: identity + why it was dropped (kept lightweight — not part of payload). */
export interface ContextOmission {
  id: string;
  kind: string;
  title: string;
  reason: string;
  tokens: number;
}

export interface ContextResult {
  budget: number;
  used_tokens: number;
  requested_paths: string[];
  included: ContextSelection[];
  omitted: ContextOmission[];
}

export const DEFAULT_CONTEXT_BUDGET = 2000;

/**
 * The minimal relevant context for `paths`, ranked and **hard-capped** at `budget` tokens:
 * the file's own per-file node, its referenced dependencies and reverse references, its
 * containing structural (parent) views, and the repository root. `included` carries the full node payload (scope, claims,
 * relations, evidence) — the actual context an agent reads — and its token cost is measured
 * on exactly that payload, so `used_tokens <= budget` always holds. Nodes that do not fit,
 * including the target itself when it alone exceeds the budget, are reported as `omitted`.
 */
export function contextFor(nodes: Node[], paths: string[], budget: number): ContextResult {
  const graph = buildGraph(nodes);
  const scoping = nodesScoping(nodes, paths);
  const pathSet = new Set(paths);

  const ordered: Array<{ id: string; reason: string }> = [];
  const seen = new Set<string>();
  const add = (id: string, reason: string): void => {
    if (!seen.has(id) && graph.byId.has(id)) {
      seen.add(id);
      ordered.push({ id, reason });
    }
  };

  // Tier 0: the requested file's own per-file node(s) — ranked first, but still budget-bound.
  const primary = scoping.filter((node) => {
    const files = node.scope?.files ?? [];
    return files.length === 1 && pathSet.has(files[0]!) && (pathSet.has(node.title) || node.kind === 'store');
  });
  for (const n of primary) add(n.id, 'target: the requested file');
  // Tier 1: what the target references, then who references the target.
  for (const n of primary) {
    for (const edge of graph.outgoing.get(n.id) ?? []) {
      add(edge.id, edge.type === 'depends-on' ? 'referenced by the requested file' : 'imported by the requested file');
    }
  }
  for (const n of primary) {
    for (const edge of graph.incoming.get(n.id) ?? []) {
      add(edge.id, edge.type === 'depends-on' ? 'references the requested file' : 'imports the requested file');
    }
  }
  // Tier 2: parent structural views (containing directory, then repository root).
  for (const n of scoping) if (!pathSet.has(n.title)) add(n.id, 'parent view: contains the requested file');
  const root = nodes.find((n) => n.kind === 'system');
  if (root) add(root.id, 'parent view: repository root');

  let used = 0;
  const included: ContextSelection[] = [];
  const omitted: ContextOmission[] = [];
  for (const { id, reason } of ordered) {
    const node = graph.byId.get(id)!;
    const tokens = estimateTokens(node);
    if (used + tokens <= budget) {
      used += tokens;
      included.push({ reason, tokens, node });
    } else {
      omitted.push({ id, kind: node.kind, title: node.title, reason, tokens });
    }
  }
  return { budget, used_tokens: used, requested_paths: paths, included, omitted };
}

// --- impact -----------------------------------------------------------------------------

export interface ImpactEntry {
  id: string;
  kind: string;
  title: string;
  reason: string;
}

export interface ImpactResult {
  seeds: string[];
  impacted: ImpactEntry[];
}

/**
 * Nodes affected by changing `paths`: the scoping nodes, the transitive closure of nodes
 * that import/reference them (upstream impact), and the repository root as the top-level view.
 */
export function impactFor(nodes: Node[], paths: string[]): ImpactResult {
  const graph = buildGraph(nodes);
  const seeds = nodesScoping(nodes, paths);
  const reasonById = new Map<string, string>();
  const seedIds = seeds.map((n) => n.id);
  for (const n of seeds) reasonById.set(n.id, 'directly scopes a changed file');

  // BFS over reverse-import edges: who (transitively) imports the impacted nodes.
  const queue = [...seedIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of graph.incoming.get(id) ?? []) {
      if (!reasonById.has(edge.id)) {
        reasonById.set(
          edge.id,
          edge.type === 'depends-on' ? 'transitively references a changed file' : 'transitively imports a changed file',
        );
        queue.push(edge.id);
      }
    }
  }

  const root = nodes.find((n) => n.kind === 'system');
  if (root && !reasonById.has(root.id)) reasonById.set(root.id, 'parent view: repository root');

  const impacted: ImpactEntry[] = [...reasonById.entries()]
    .map(([id, reason]) => {
      const node = graph.byId.get(id)!;
      return { id, kind: node.kind, title: node.title, reason };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return { seeds: seedIds.sort(), impacted };
}

// --- evidence ---------------------------------------------------------------------------

export interface EvidenceResult {
  target: string;
  found: boolean;
  /** How the target was matched: node | claim | relation. */
  matched?: 'node' | 'claim' | 'relation';
  evidence: Evidence[];
}

/** Gather the evidence bundle for a node id, claim id, or relation id. */
export function evidenceFor(nodes: Node[], target: string): EvidenceResult {
  const node = nodes.find((n) => n.id === target);
  if (node) {
    const evidence = [
      ...node.claims.flatMap((c) => c.evidence),
      ...node.relations.flatMap((r) => r.evidence ?? []),
    ];
    return { target, found: true, matched: 'node', evidence };
  }
  for (const n of nodes) {
    const claim = n.claims.find((c) => c.id === target);
    if (claim) return { target, found: true, matched: 'claim', evidence: claim.evidence };
    const relation = n.relations.find((r) => r.id === target);
    if (relation) return { target, found: true, matched: 'relation', evidence: relation.evidence ?? [] };
  }
  return { target, found: false, evidence: [] };
}
