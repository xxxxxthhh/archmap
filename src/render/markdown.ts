/**
 * Markdown renderer.
 *
 * Emits a structured, human-readable report from a `DisplayGraph`. Each node lists its claims
 * tagged `fact`/`inference` with status and authoring actor, and each relation shows its
 * certainty spelled out — so an inference is never presented as a fact and a `partial`/`unknown`
 * relation is never presented as `known`. Evidence appears only as safe pointers (path, symbol,
 * blob hash), never as copied source.
 */

import type { DisplayEvidence, DisplayGraph, DisplayNode } from './project.js';
import { claimSummary } from './summary.js';

function evidencePointer(ev: DisplayEvidence): string {
  const loc = ev.symbol ? `${ev.path}#${ev.symbol}` : ev.path;
  return `${loc} (${ev.blob_hash})`;
}

function nodeSection(node: DisplayNode, titleById: Map<string, string>, graph: DisplayGraph): string[] {
  const s = claimSummary(node);
  const lines: string[] = [];
  lines.push(`### ${node.title} \`${node.id}\``);
  lines.push('');
  lines.push(`- kind: ${node.kind}`);
  lines.push(`- claims: ${s.facts} fact, ${s.inferences} inference${s.stale > 0 ? `, ${s.stale} stale` : ''}`);

  if (node.claims.length > 0) {
    lines.push('- knowledge:');
    for (const claim of node.claims) {
      const flags = claim.status === 'active' ? claim.type : `${claim.type}, ${claim.status}`;
      lines.push(`  - [${flags}] (${claim.actor}) ${claim.text}`);
      for (const ev of claim.evidence) {
        lines.push(`    - evidence: ${evidencePointer(ev)}`);
      }
    }
  }

  const outgoing = graph.edges.filter((e) => e.source === node.id);
  if (outgoing.length > 0) {
    lines.push('- relations:');
    for (const edge of outgoing) {
      const target = titleById.get(edge.target) ?? edge.target;
      lines.push(`  - ${edge.type} → ${target} \`${edge.target}\` (certainty: ${edge.certainty})`);
    }
  }
  lines.push('');
  return lines;
}

export function renderMarkdown(graph: DisplayGraph): string {
  const titleById = new Map(graph.nodes.map((n) => [n.id, n.title]));
  const lines: string[] = [];

  lines.push(`# Architecture view: ${graph.view.id}`);
  lines.push('');
  lines.push(
    `Nodes ${graph.stats.visible_nodes}/${graph.stats.total_nodes} ` +
      `(collapsed ${graph.stats.collapsed_nodes}), ` +
      `edges ${graph.stats.visible_edges}/${graph.stats.total_edges}.`,
  );
  lines.push('');
  lines.push(`- layout: ${graph.view.layout}`);
  if (graph.view.collapse_below) lines.push(`- collapse_below: ${graph.view.collapse_below}`);
  lines.push(`- node kinds: ${graph.view.include.node_kinds.join(', ')}`);
  lines.push(`- edge types: ${graph.view.include.edge_types.join(', ')}`);
  lines.push('');

  lines.push('## Nodes');
  lines.push('');
  if (graph.nodes.length === 0) {
    lines.push('_No nodes match this view._');
    lines.push('');
  } else {
    for (const node of graph.nodes) {
      lines.push(...nodeSection(node, titleById, graph));
    }
  }

  lines.push('## Legend');
  lines.push('');
  lines.push('- `fact`: deterministic, analyzer-produced; `inference`: evidence-backed interpretation.');
  lines.push('- relation certainty `known` is deterministic; `partial`/`unknown` are not and must not be relied on as facts.');

  // `join('\n')` + the trailing `\n` already yields exactly one terminal newline; a final empty
  // line here would produce a second (a "blank line at EOF"), so the block ends without one.
  return `${lines.join('\n')}\n`;
}
