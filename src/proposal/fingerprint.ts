import { toCanonicalJson } from '../model/canonical.js';
import { hashContent } from '../scan/hash.js';
import type { TrackedBaseline } from '../scan/baseline.js';

/** SHA-256 of the full canonical validated baseline, with nodes ordered by stable id. */
export function computeModelHash(baseline: TrackedBaseline): string {
  const canonical = {
    snapshot: baseline.snapshot,
    nodes: [...baseline.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return hashContent(Buffer.from(toCanonicalJson(canonical)));
}
