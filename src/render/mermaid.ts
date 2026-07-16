/**
 * Mermaid renderer.
 *
 * Emits a `graph` flowchart from a `DisplayGraph`. Node ids are archmap's own stable ids (they
 * are already valid Mermaid identifiers), so the diagram is a stable, side-effect-free function
 * of the projection. `known` edges use a solid arrow; `partial`/`unknown` edges use a dotted
 * arrow with a distinct suffix, so a non-deterministic relation can never read as a solid,
 * deterministic one. Node labels carry fact/inference/stale counts so the certainty of a node's
 * knowledge is visible without embedding claim bodies (or any repository content).
 */

import type { DisplayEdge, DisplayGraph, DisplayNode } from './project.js';
import { claimSummary, hasStale } from './summary.js';

/** Mermaid label text lives inside `["..."]`; strip the few characters that would break it. */
function label(text: string): string {
  return text.replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function nodeLabel(node: DisplayNode): string {
  const s = claimSummary(node);
  const counts = s.stale > 0
    ? `${node.kind} · fact ${s.facts} · inf ${s.inferences} · stale ${s.stale}`
    : `${node.kind} · fact ${s.facts} · inf ${s.inferences}`;
  return `${label(node.title)}<br/>${counts}`;
}

/** `known` → solid arrow; `partial` (~) and `unknown` (?) → dotted, never solid. */
function edgeLine(edge: DisplayEdge): string {
  if (edge.certainty === 'known') return `  ${edge.source} -->|${edge.type}| ${edge.target}`;
  const marker = edge.certainty === 'partial' ? '~' : '?';
  return `  ${edge.source} -.->|${edge.type} ${marker}| ${edge.target}`;
}

export function renderMermaid(graph: DisplayGraph): string {
  const direction = graph.view.layout === 'top-to-bottom' ? 'TD' : 'LR';
  const lines: string[] = [];
  lines.push(`%% archmap view: ${graph.view.id}`);
  lines.push(
    `%% nodes ${graph.stats.visible_nodes}/${graph.stats.total_nodes} ` +
      `(collapsed ${graph.stats.collapsed_nodes}), ` +
      `edges ${graph.stats.visible_edges}/${graph.stats.total_edges}`,
  );
  lines.push(`graph ${direction}`);

  for (const node of graph.nodes) {
    lines.push(`  ${node.id}["${nodeLabel(node)}"]`);
  }
  for (const edge of graph.edges) {
    lines.push(edgeLine(edge));
  }

  const staleIds = graph.nodes.filter(hasStale).map((n) => n.id);
  if (staleIds.length > 0) {
    lines.push('  classDef stale stroke-dasharray:5 5;');
    lines.push(`  class ${staleIds.join(',')} stale;`);
  }

  return `${lines.join('\n')}\n`;
}
