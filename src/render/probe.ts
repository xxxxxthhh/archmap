/**
 * Readability probe for the zero-dependency tracer-bullet renderer.
 *
 * The Issue #28 contract requires a *documented readability probe*: the hand-rolled
 * deterministic layout is only trusted up to a bounded graph size. Beyond it, a static grid
 * stops being legible and the honest response is to stop and request a graph-library dependency
 * decision rather than emit an unreadable diagram. The probe encodes that bound; it is a gate,
 * not a renderer, so all three formats share the same limit.
 */

import type { DisplayGraph } from './project.js';

/** Maximum visible nodes the deterministic layout is trusted to render legibly. */
export const MAX_READABLE_NODES = 60;

/** Maximum visible edges the deterministic layout is trusted to render legibly. */
export const MAX_READABLE_EDGES = 120;

export type ReadabilityProbe =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Check whether `graph` fits within the tracer-bullet layout's readability bounds. A failure is
 * a hard stop: the caller must not emit an export, and should request a graph-library
 * dependency decision (the layout was deliberately built without one).
 */
export function readabilityProbe(graph: DisplayGraph): ReadabilityProbe {
  if (graph.stats.visible_nodes > MAX_READABLE_NODES) {
    return {
      ok: false,
      reason:
        `view renders ${graph.stats.visible_nodes} nodes, exceeding the deterministic ` +
        `layout's readable limit of ${MAX_READABLE_NODES}; narrow the view (node_kinds or ` +
        `collapse_below) or request a graph-library dependency decision`,
    };
  }
  if (graph.stats.visible_edges > MAX_READABLE_EDGES) {
    return {
      ok: false,
      reason:
        `view renders ${graph.stats.visible_edges} edges, exceeding the deterministic ` +
        `layout's readable limit of ${MAX_READABLE_EDGES}; narrow the view (edge_types) or ` +
        `request a graph-library dependency decision`,
    };
  }
  return { ok: true };
}
