/**
 * The single validated entry point both `scan` and `status` use to read the persisted model.
 *
 * It reads the snapshot, validates every node against the full M0 contract (using the
 * snapshot's declared capabilities), and enforces the M1 snapshot↔node consistency
 * invariants. Any invalid persisted model raises `StoreFormatError`, so both consumers fail
 * closed on a bad baseline — `scan` must never "repair" an illegal tracked model by
 * overwriting it, and `status` must never report on one.
 */

import type { Node } from '../model/types.js';
import { listNodeFiles, readSnapshot, readValidatedNodes } from '../store.js';
import { StoreFormatError } from '../store-errors.js';
import { assertModelConsistency } from './consistency.js';
import type { Snapshot } from './types.js';

export interface TrackedBaseline {
  snapshot: Snapshot;
  nodes: Node[];
}

/**
 * Read + fully validate the tracked model as one unit (snapshot + nodes), or return null only
 * for a genuinely unscanned project. Missing `snapshot.yaml` is legal *only* when there are no
 * tracked node files; a missing snapshot alongside existing nodes is an incomplete model and
 * fails closed, so a lost snapshot never lets a scan silently rebuild over (and delete)
 * human-enriched nodes.
 */
export function readTrackedBaseline(root: string): TrackedBaseline | null {
  const snapshot = readSnapshot(root);
  if (!snapshot) {
    if (listNodeFiles(root).length > 0) {
      throw new StoreFormatError(
        'tracked node files exist without a snapshot.yaml; the model is incomplete. ' +
          'Restore snapshot.yaml or remove .archmap/nodes/ before scanning.',
      );
    }
    return null;
  }
  const nodes = readValidatedNodes(root, snapshot.capabilities);
  assertModelConsistency(snapshot.files, nodes);
  return { snapshot, nodes };
}
