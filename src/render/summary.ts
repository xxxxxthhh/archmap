/**
 * Shared claim-summary helper for the renderers.
 *
 * Every format must let a reader tell a deterministic `fact` from an evidence-backed
 * `inference` and see when a node carries `stale` knowledge, without dumping claim bodies into a
 * graph. The renderers share this count so the distinction is drawn the same way everywhere.
 */

import type { DisplayNode } from './project.js';

export interface ClaimSummary {
  facts: number;
  inferences: number;
  stale: number;
}

/** Count a node's active fact/inference claims and how many claims are stale. */
export function claimSummary(node: DisplayNode): ClaimSummary {
  let facts = 0;
  let inferences = 0;
  let stale = 0;
  for (const claim of node.claims) {
    if (claim.type === 'fact') facts += 1;
    else inferences += 1;
    if (claim.status === 'stale') stale += 1;
  }
  return { facts, inferences, stale };
}

/** True when any claim on the node is stale — drives the "stale" visual marker in each format. */
export function hasStale(node: DisplayNode): boolean {
  return node.claims.some((claim) => claim.status === 'stale');
}
