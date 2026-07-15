/**
 * Deterministic text rendering of an architecture diff. Pure and order-stable (the report's
 * lists are already sorted by id), so the same diff always prints byte-identical output.
 */

import type { ArchDiffReport, ClaimSummary, NodeSummary, RelationSummary } from './types.js';

const short = (sha: string): string => sha.slice(0, 12);

const nodeLine = (mark: string, n: NodeSummary): string => `  ${mark} [${n.kind}] ${n.slug} — ${n.title}`;
const relationLine = (mark: string, r: RelationSummary): string =>
  `  ${mark} ${r.id}: ${r.node} -${r.type}-> ${r.target} (${r.certainty})`;
const claimLine = (mark: string, c: ClaimSummary): string =>
  `  ${mark} [${c.type}] ${c.id} on ${c.node} (${c.status})`;

/** Render `report` as a stable multi-line summary ending in a single newline. */
export function formatDiff(report: ArchDiffReport): string {
  const header = `diff ${short(report.base)}..${short(report.head)}`;
  const { nodes, relations, claims } = report;
  const total =
    nodes.added.length + nodes.removed.length + nodes.changed.length +
    relations.added.length + relations.removed.length + relations.changed.length +
    claims.added.length + claims.removed.length + claims.changed.length + claims.stale.length;
  if (total === 0) return `${header} — no architecture changes\n`;

  const lines: string[] = [header, ''];

  lines.push(`nodes: ${nodes.added.length} added, ${nodes.removed.length} removed, ${nodes.changed.length} changed`);
  for (const n of nodes.added) lines.push(nodeLine('+', n));
  for (const n of nodes.removed) lines.push(nodeLine('-', n));
  for (const c of nodes.changed) lines.push(nodeLine('~', c.after));

  lines.push(
    `relations: ${relations.added.length} added, ${relations.removed.length} removed, ${relations.changed.length} changed`,
  );
  for (const r of relations.added) lines.push(relationLine('+', r));
  for (const r of relations.removed) lines.push(relationLine('-', r));
  for (const c of relations.changed) lines.push(relationLine('~', c.after));

  lines.push(
    `claims: ${claims.added.length} added, ${claims.removed.length} removed, ` +
      `${claims.changed.length} changed, ${claims.stale.length} stale`,
  );
  for (const c of claims.added) lines.push(claimLine('+', c));
  for (const c of claims.removed) lines.push(claimLine('-', c));
  for (const c of claims.changed) lines.push(claimLine('~', c.after));
  for (const c of claims.stale) lines.push(claimLine('stale', c));

  return `${lines.join('\n')}\n`;
}
