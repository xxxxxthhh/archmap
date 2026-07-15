/**
 * SVG renderer.
 *
 * A zero-dependency, fully deterministic static layout — no graph library (Issue #28 forbids
 * one). Nodes are placed on a fixed grid: one lane per node kind (system → component → module →
 * store → external), ordered within a lane by id, with integer coordinates so two runs are
 * byte-identical. `known` edges are solid; `partial`/`unknown` edges are dashed/dotted and faded
 * so they can never read as deterministic. Nodes with stale claims get a dashed border. The SVG
 * embeds only titles, kinds, and claim counts — no repository content.
 *
 * If a projection is too large for this static grid to stay legible, the caller's readability
 * probe (see `probe.ts`) stops the export before it reaches this renderer.
 */

import type { DisplayEdge, DisplayGraph, DisplayNode } from './project.js';
import { claimSummary, hasStale } from './summary.js';
import type { NodeKind } from '../model/types.js';

const LANE_ORDER: NodeKind[] = ['system', 'component', 'module', 'store', 'external'];

const BOX_W = 190;
const BOX_H = 56;
const LANE_GAP = 90; // gap between lanes (added to box size along the lane axis)
const CROSS_GAP = 28; // gap between nodes within a lane
const MARGIN = 32;

const KIND_FILL: Record<NodeKind, string> = {
  system: '#e8eef7',
  component: '#e6f0ea',
  module: '#f2eee6',
  store: '#efe8f2',
  external: '#f5e8e8',
};

interface Placed {
  node: DisplayNode;
  cx: number;
  cy: number;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build lane/row indices, then convert to pixel centers honoring the layout orientation. */
function place(graph: DisplayGraph): { placed: Map<string, Placed>; width: number; height: number } {
  const laneOf = new Map<NodeKind, number>(LANE_ORDER.map((k, i) => [k, i]));
  // Group visible nodes by lane, preserving the id-sorted order the projection produced.
  const lanes = new Map<number, DisplayNode[]>();
  for (const node of graph.nodes) {
    const lane = laneOf.get(node.kind) ?? LANE_ORDER.length;
    (lanes.get(lane) ?? lanes.set(lane, []).get(lane)!).push(node);
  }

  const horizontal = graph.view.layout !== 'top-to-bottom';
  const laneSpan = (horizontal ? BOX_W : BOX_H) + LANE_GAP;
  const crossSpan = (horizontal ? BOX_H : BOX_W) + CROSS_GAP;

  const placed = new Map<string, Placed>();
  let maxCross = 0;
  const usedLanes = [...lanes.keys()].sort((a, b) => a - b);
  usedLanes.forEach((lane, laneIdx) => {
    const members = lanes.get(lane)!;
    members.forEach((node, row) => {
      const laneCenter = MARGIN + laneIdx * laneSpan + (horizontal ? BOX_W : BOX_H) / 2;
      const crossCenter = MARGIN + row * crossSpan + (horizontal ? BOX_H : BOX_W) / 2;
      const cx = horizontal ? laneCenter : crossCenter;
      const cy = horizontal ? crossCenter : laneCenter;
      placed.set(node.id, { node, cx, cy });
    });
    maxCross = Math.max(maxCross, members.length);
  });

  const laneCount = usedLanes.length;
  const laneExtent = MARGIN * 2 + Math.max(0, laneCount) * laneSpan - LANE_GAP;
  const crossExtent = MARGIN * 2 + Math.max(0, maxCross) * crossSpan - CROSS_GAP;
  const width = horizontal ? laneExtent : crossExtent;
  const height = horizontal ? crossExtent : laneExtent;
  return { placed, width: Math.max(width, MARGIN * 2 + BOX_W), height: Math.max(height, MARGIN * 2 + BOX_H) };
}

function edgeStyle(edge: DisplayEdge): string {
  if (edge.certainty === 'known') return 'stroke="#555" stroke-width="1.5"';
  if (edge.certainty === 'partial') {
    return 'stroke="#999" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.7"';
  }
  return 'stroke="#999" stroke-width="1.5" stroke-dasharray="2 5" opacity="0.5"';
}

function renderEdge(edge: DisplayEdge, placed: Map<string, Placed>): string | null {
  const a = placed.get(edge.source);
  const b = placed.get(edge.target);
  if (!a || !b) return null;
  const marker = edge.certainty === 'known' ? '' : edge.certainty === 'partial' ? ' ~' : ' ?';
  const mx = Math.round((a.cx + b.cx) / 2);
  const my = Math.round((a.cy + b.cy) / 2);
  return (
    `  <line x1="${a.cx}" y1="${a.cy}" x2="${b.cx}" y2="${b.cy}" ${edgeStyle(edge)} />\n` +
    `  <text x="${mx}" y="${my - 3}" font-size="10" fill="#666" text-anchor="middle">` +
    `${escapeXml(edge.type)}${marker}</text>`
  );
}

function renderNode(p: Placed): string {
  const { node, cx, cy } = p;
  const x = cx - BOX_W / 2;
  const y = cy - BOX_H / 2;
  const s = claimSummary(node);
  const counts = s.stale > 0
    ? `${node.kind} · fact ${s.facts} · inf ${s.inferences} · stale ${s.stale}`
    : `${node.kind} · fact ${s.facts} · inf ${s.inferences}`;
  const stroke = hasStale(node)
    ? 'stroke="#b45309" stroke-width="2" stroke-dasharray="5 3"'
    : 'stroke="#888" stroke-width="1"';
  return (
    `  <g>\n` +
    `    <rect x="${x}" y="${y}" width="${BOX_W}" height="${BOX_H}" rx="6" ` +
    `fill="${KIND_FILL[node.kind]}" ${stroke} />\n` +
    `    <text x="${cx}" y="${y + 22}" font-size="13" font-weight="600" fill="#222" ` +
    `text-anchor="middle">${escapeXml(node.title)}</text>\n` +
    `    <text x="${cx}" y="${y + 40}" font-size="10" fill="#555" ` +
    `text-anchor="middle">${escapeXml(counts)}</text>\n` +
    `  </g>`
  );
}

export function renderSvg(graph: DisplayGraph): string {
  const { placed, width, height } = place(graph);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" font-family="sans-serif">`);
  parts.push(`  <!-- archmap view: ${escapeXml(graph.view.id)}; ` +
    `nodes ${graph.stats.visible_nodes}/${graph.stats.total_nodes}, ` +
    `edges ${graph.stats.visible_edges}/${graph.stats.total_edges} -->`);
  parts.push(`  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />`);

  // Edges first, so boxes drawn afterward sit on top of any crossing line.
  for (const edge of graph.edges) {
    const rendered = renderEdge(edge, placed);
    if (rendered) parts.push(rendered);
  }
  for (const node of graph.nodes) {
    const p = placed.get(node.id);
    if (p) parts.push(renderNode(p));
  }
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}
